//! Run graph — sync tracked ML runs into a queryable SQLite store.
//!
//! Phase 1 introduces a small "run graph" that mirrors tracked runs from
//! a tracker provider (W&B or MLflow) into the workspace DB.  The graph
//! is built from two tables (already in `storage::run_migrations`):
//!
//!   - `run_nodes (id, framework, gpu, config_json, dataset_ref, created_at)`
//!   - `run_edges (src, dst, kind)`
//!
//! Edges are inferred from the run config:
//!
//!   - `same_arch_diff_data` — same `framework`, different `dataset_ref`
//!   - `reran_with_diff_lr`   — same `dataset_ref`, configs equal except
//!                              for `learning_rate`/`lr`/`initial_lr`
//!   - `derived_from`         — same `git_commit` field, run B started
//!                              after run A
//!
//! Edge inference is O(n^2) within each group (framework, dataset_ref,
//! git_commit) but groups are typically small in practice; full O(n log n)
//! indexing is a Phase 2 concern.

use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

use crate::tracker::error::{TrackerError, TrackerErrorKind};
use crate::tracker::wandb::{RunDetail, RunSummary};
use crate::tracker::MlflowProvider;
use crate::tracker::WandbProvider;

/// One row of the run graph — a tracked ML run mirrored into SQLite.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunGraphNode {
    pub id: String,
    pub framework: String,
    pub gpu: String,
    pub dataset_ref: String,
    pub created_at: i64,
}

/// A labelled edge between two run nodes.
#[derive(Debug, Clone)]
pub enum RunEdgeKind {
    /// Same architecture, different dataset.
    SameArchDiffData,
    /// Same dataset, only the learning-rate field differs.
    ReranWithDiffLr,
    /// B started after A and shares the same git commit.
    DerivedFrom,
}

impl RunEdgeKind {
    /// String label persisted into `run_edges.kind`.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SameArchDiffData => "same_arch_diff_data",
            Self::ReranWithDiffLr => "reran_with_diff_lr",
            Self::DerivedFrom => "derived_from",
        }
    }
}

/// Result of a sync pass.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    pub nodes_added: usize,
    pub edges_added: usize,
}

// ── Config extraction ────────────────────────────────────────────────────

/// Config keys we look at, in priority order, when extracting a string
/// field. The first match wins. We accept multiple aliases because W&B
/// projects tend to use different names (e.g. `model_type` vs
/// `architecture`).
const FRAMEWORK_KEYS: &[&str] = &["framework", "model_type", "architecture"];
const GPU_KEYS: &[&str] = &["gpu", "device", "accelerator"];
const DATASET_KEYS: &[&str] = &["dataset", "data_path", "train_data"];
const COMMIT_KEYS: &[&str] = &["git_commit", "git_sha", "commit"];
const LR_KEYS: &[&str] = &["learning_rate", "lr", "initial_lr"];

/// Pull a string value out of a JSON config map under one of the given
/// keys. Accepts string, number, and boolean JSON values; everything
/// else falls back to `serde_json::Value::to_string()`.
fn extract_str<'a>(config: &'a Value, keys: &[&str]) -> Option<String> {
    if let Value::Object(map) = config {
        for key in keys {
            if let Some(v) = map.get(*key) {
                return Some(value_to_string(v));
            }
        }
    }
    None
}

fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => String::new(),
        // Arrays/objects stringify into JSON; we don't expect them in
        // these positions, but if they appear we keep the JSON so the
        // caller can still see something useful.
        _ => v.to_string(),
    }
}

/// Returns true when `a` and `b` are deeply equal except for the
/// `learning_rate`/`lr`/`initial_lr` keys (at any nesting level). This
/// is the predicate used to detect "I reran the same job with a
/// different learning rate."
fn configs_equal_modulo_lr(a: &Value, b: &Value) -> bool {
    strip_lr(a) == strip_lr(b)
}

fn strip_lr(v: &Value) -> Value {
    match v {
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, val) in map {
                if LR_KEYS.contains(&k.as_str()) {
                    continue;
                }
                out.insert(k.clone(), strip_lr(val));
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(strip_lr).collect()),
        other => other.clone(),
    }
}

// ── Sync ──────────────────────────────────────────────────────────────────

/// Sync the run graph for the given workspace from a connected
/// `WandbProvider`.
///
/// Calls `provider.list_runs(project, 100, None)` and then `get_run`
/// for every summary. Each run is upserted into `run_nodes`, then
/// edges are inferred and upserted into `run_edges`.
///
/// Takes a *borrowed* `Connection` so the caller can share one
/// connection across the config read and the sync (avoiding the cost
/// of opening the workspace DB twice per sync). Internally we clone
/// the handle before crossing into `block_in_place` so the non-`Sync`
/// `Connection` never escapes a single closure.
pub async fn sync_from_wandb(
    workspace_hash: &str,
    project: &str,
    conn: &Connection,
    provider: &WandbProvider,
) -> Result<SyncSummary, TrackerError> {
    log::info!(
        "[run_graph] starting W&B sync for workspace={} project={}",
        workspace_hash,
        project
    );

    // Phase 1 — async: fetch the full run details from the tracker.
    let details: Vec<RunDetail> = fetch_run_details_wandb(project, provider).await?;

    // Phase 2 — sync: upsert nodes + infer/upsert edges.
    // `block_in_place` runs the closure on the current thread without
    // blocking the executor; the borrowed `Connection` moves into it
    // cleanly (`block_in_place` has no `Send` bound on its closure).
    let summary: Result<SyncSummary, TrackerError> = tokio::task::block_in_place(move || {
        let nodes_added = details.len();
        upsert_runs(conn, &details)?;
        let edges_added = infer_and_upsert_edges(conn, &details)?;
        Ok(SyncSummary {
            nodes_added,
            edges_added,
        })
    });

    let summary = summary?;

    log::info!(
        "[run_graph] W&B sync complete: {} nodes, {} edges",
        summary.nodes_added,
        summary.edges_added
    );

    Ok(summary)
}

/// Sync the run graph for the given workspace from a connected
/// `MlflowProvider`. Mirrors `sync_from_wandb`; both providers expose
/// the same `list_runs`/`get_run` shape so the post-list flow is
/// identical.
///
/// Takes a *borrowed* `Connection`; see `sync_from_wandb` for the
/// rationale.
pub async fn sync_from_mlflow(
    workspace_hash: &str,
    project: &str,
    conn: &Connection,
    provider: &MlflowProvider,
) -> Result<SyncSummary, TrackerError> {
    log::info!(
        "[run_graph] starting MLflow sync for workspace={} project={}",
        workspace_hash,
        project
    );

    // Phase 1 — async: fetch the full run details from the tracker.
    let details: Vec<RunDetail> = fetch_run_details_mlflow(project, provider).await?;

    let summary: Result<SyncSummary, TrackerError> = tokio::task::block_in_place(move || {
        let nodes_added = details.len();
        upsert_runs(conn, &details)?;
        let edges_added = infer_and_upsert_edges(conn, &details)?;
        Ok(SyncSummary {
            nodes_added,
            edges_added,
        })
    });

    let summary = summary?;

    log::info!(
        "[run_graph] MLflow sync complete: {} nodes, {} edges",
        summary.nodes_added,
        summary.edges_added
    );

    Ok(summary)
}

/// Phase 1 of the W&B sync: list + get_run for every summary.
/// Pure network I/O, no SQLite involved.
///
/// Paginates through `provider.list_runs` using the returned cursor
/// until either the cursor is exhausted or the safety bound (1000
/// runs total) is reached.
async fn fetch_run_details_wandb(
    project: &str,
    provider: &WandbProvider,
) -> Result<Vec<RunDetail>, TrackerError> {
    let mut details: Vec<RunDetail> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = provider.list_runs(project, 100, cursor.as_deref()).await?;
        for summary in &page.runs {
            match provider.get_run(&summary.id).await {
                Ok(d) => details.push(d),
                Err(e) => log::warn!(
                    "[run_graph] get_run({}) failed during W&B sync: {}",
                    summary.id,
                    e
                ),
            }
        }
        match page.next_cursor {
            Some(c) if !c.is_empty() => cursor = Some(c),
            _ => break,
        }
        if details.len() >= 1000 {
            break;
        }
    }
    Ok(details)
}

/// Phase 1 of the MLflow sync: list + get_run for every summary.
///
/// Paginates through `provider.list_runs` using the returned cursor
/// until either the cursor is exhausted or the safety bound (1000
/// runs total) is reached.
async fn fetch_run_details_mlflow(
    project: &str,
    provider: &MlflowProvider,
) -> Result<Vec<RunDetail>, TrackerError> {
    let mut details: Vec<RunDetail> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = provider.list_runs(project, 100, cursor.as_deref()).await?;
        for summary in &page.runs {
            match provider.get_run(&summary.id).await {
                Ok(d) => details.push(d),
                Err(e) => log::warn!(
                    "[run_graph] get_run({}) failed during MLflow sync: {}",
                    summary.id,
                    e
                ),
            }
        }
        match page.next_cursor {
            Some(c) if !c.is_empty() => cursor = Some(c),
            _ => break,
        }
        if details.len() >= 1000 {
            break;
        }
    }
    Ok(details)
}

/// Upsert each run detail into `run_nodes`. The `config_json` column
/// stores the full config blob so we can rebuild edge inferences on
/// later syncs without re-hitting the tracker.
fn upsert_runs(conn: &Connection, runs: &[RunDetail]) -> Result<(), TrackerError> {
    for run in runs {
        let framework = extract_str(&run.config, FRAMEWORK_KEYS)
            .unwrap_or_else(|| "unknown".to_string());
        let gpu = extract_str(&run.config, GPU_KEYS).unwrap_or_else(|| "unknown".to_string());
        let dataset_ref =
            extract_str(&run.config, DATASET_KEYS).unwrap_or_else(|| "unknown".to_string());

        // The config is always JSON-serializable (it's already a Value),
        // but a malformed config could still panic. Fall back to "{}"
        // rather than aborting the whole sync.
        let config_json =
            serde_json::to_string(&run.config).unwrap_or_else(|_| "{}".to_string());

        conn.execute(
            "INSERT OR REPLACE INTO run_nodes \
             (id, framework, gpu, config_json, dataset_ref, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                &run.id,
                &framework,
                &gpu,
                &config_json,
                &dataset_ref,
                run.created_at
            ],
        )
        .map_err(|e| TrackerError {
            kind: TrackerErrorKind::Unknown,
            message: format!("Failed to upsert run_nodes row: {e}"),
            hint: None,
        })?;
    }
    Ok(())
}

/// Infer edges from the run configs and upsert into `run_edges`.
/// Returns the number of newly-inserted edges.
fn infer_and_upsert_edges(conn: &Connection, runs: &[RunDetail]) -> Result<usize, TrackerError> {
    let edges = infer_edges(runs);
    let mut inserted = 0usize;
    for (src, dst, kind) in &edges {
        let n = conn
            .execute(
                "INSERT OR IGNORE INTO run_edges (src, dst, kind) VALUES (?1, ?2, ?3)",
                params![src, dst, kind.as_str()],
            )
            .map_err(|e| TrackerError {
                kind: TrackerErrorKind::Unknown,
                message: format!("Failed to upsert run_edges row: {e}"),
                hint: None,
            })?;
        inserted += n;
    }
    Ok(inserted)
}

/// Pure edge inference over an in-memory list of run details.
///
/// Three rules, each grouped to keep the pairwise scan bounded:
///
/// 1. **same_arch_diff_data** — group by `framework`, link every pair
///    whose `dataset_ref` differs (bidirectional so the graph can be
///    traversed both ways).
/// 2. **reran_with_diff_lr** — group by `dataset_ref`, link every pair
///    whose configs match modulo the lr keys.
/// 3. **derived_from** — group by `git_commit`, link runs in
///    `created_at` order (newest → oldest).
fn infer_edges(runs: &[RunDetail]) -> Vec<(String, String, RunEdgeKind)> {
    let mut out: Vec<(String, String, RunEdgeKind)> = Vec::new();

    // ── 1. same_arch_diff_data ────────────────────────────────────────
    let mut by_framework: HashMap<String, Vec<&RunDetail>> = HashMap::new();
    for run in runs {
        let fw = extract_str(&run.config, FRAMEWORK_KEYS)
            .unwrap_or_else(|| "unknown".to_string());
        by_framework.entry(fw).or_default().push(run);
    }
    for (_, group) in by_framework {
        for i in 0..group.len() {
            let ds_i = extract_str(&group[i].config, DATASET_KEYS)
                .unwrap_or_else(|| "unknown".to_string());
            for j in (i + 1)..group.len() {
                let ds_j = extract_str(&group[j].config, DATASET_KEYS)
                    .unwrap_or_else(|| "unknown".to_string());
                if ds_i != ds_j {
                    out.push((
                        group[i].id.clone(),
                        group[j].id.clone(),
                        RunEdgeKind::SameArchDiffData,
                    ));
                    out.push((
                        group[j].id.clone(),
                        group[i].id.clone(),
                        RunEdgeKind::SameArchDiffData,
                    ));
                }
            }
        }
    }

    // ── 2. reran_with_diff_lr ─────────────────────────────────────────
    let mut by_dataset: HashMap<String, Vec<&RunDetail>> = HashMap::new();
    for run in runs {
        let ds = extract_str(&run.config, DATASET_KEYS)
            .unwrap_or_else(|| "unknown".to_string());
        by_dataset.entry(ds).or_default().push(run);
    }
    for (_, group) in by_dataset {
        for i in 0..group.len() {
            for j in (i + 1)..group.len() {
                if configs_equal_modulo_lr(&group[i].config, &group[j].config) {
                    out.push((
                        group[i].id.clone(),
                        group[j].id.clone(),
                        RunEdgeKind::ReranWithDiffLr,
                    ));
                    out.push((
                        group[j].id.clone(),
                        group[i].id.clone(),
                        RunEdgeKind::ReranWithDiffLr,
                    ));
                }
            }
        }
    }

    // ── 3. derived_from ───────────────────────────────────────────────
    let mut by_commit: HashMap<String, Vec<&RunDetail>> = HashMap::new();
    for run in runs {
        if let Some(commit) = extract_str(&run.config, COMMIT_KEYS) {
            if !commit.is_empty() {
                by_commit.entry(commit).or_default().push(run);
            }
        }
    }
    for (_, mut group) in by_commit {
        if group.len() < 2 {
            continue;
        }
        // Stable ordering: tie-break by id so the chain is deterministic.
        group.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        for w in group.windows(2) {
            out.push((
                w[0].id.clone(),
                w[1].id.clone(),
                RunEdgeKind::DerivedFrom,
            ));
        }
    }

    out
}

// ── Query ─────────────────────────────────────────────────────────────────

/// Query the run graph for nodes matching an optional `framework` and
/// `dataset` filter. Both filters are ANDed; passing `None` for both
/// returns every node.
///
/// Rows are returned newest-first by `created_at`.
pub fn query_run_graph(
    conn: &Connection,
    framework: Option<&str>,
    dataset: Option<&str>,
) -> rusqlite::Result<Vec<RunGraphNode>> {
    // Build the SQL incrementally so we don't depend on dynamic
    // parameter binding tricks. The `1=1` anchor lets us append
    // uniform `AND col = ?N` clauses without special-casing the first.
    let mut sql = String::from(
        "SELECT id, framework, gpu, dataset_ref, created_at \
         FROM run_nodes \
         WHERE 1=1",
    );
    let mut args: Vec<String> = Vec::new();

    if let Some(fw) = framework {
        args.push(fw.to_string());
        sql.push_str(&format!(" AND framework = ?{}", args.len()));
    }
    if let Some(ds) = dataset {
        args.push(ds.to_string());
        sql.push_str(&format!(" AND dataset_ref = ?{}", args.len()));
    }
    sql.push_str(" ORDER BY created_at DESC");

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args.iter()), |row| {
        Ok(RunGraphNode {
            id: row.get(0)?,
            framework: row.get(1)?,
            gpu: row.get(2)?,
            dataset_ref: row.get(3)?,
            created_at: row.get(4)?,
        })
    })?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn detail(id: &str, ts: i64, config: Value) -> RunDetail {
        RunDetail {
            id: id.to_string(),
            name: id.to_string(),
            state: "finished".to_string(),
            created_at: ts,
            finished_at: None,
            config,
            summary_metrics: json!({}),
            tags: vec![],
            notes: String::new(),
        }
    }

    fn summary(id: &str, ts: i64) -> RunSummary {
        RunSummary {
            id: id.to_string(),
            name: id.to_string(),
            state: "finished".to_string(),
            created_at: ts,
            summary_metrics: json!({}),
        }
    }

    #[test]
    fn extract_str_finds_first_match() {
        let cfg = json!({ "model_type": "vit", "architecture": "resnet" });
        assert_eq!(extract_str(&cfg, FRAMEWORK_KEYS), Some("vit".to_string()));
    }

    #[test]
    fn extract_str_returns_none_when_missing() {
        let cfg = json!({ "foo": "bar" });
        assert_eq!(extract_str(&cfg, FRAMEWORK_KEYS), None);
    }

    #[test]
    fn configs_equal_modulo_lr_ignores_lr_keys() {
        let a = json!({ "framework": "vit", "lr": 0.01, "bs": 32 });
        let b = json!({ "framework": "vit", "lr": 0.001, "bs": 32 });
        assert!(configs_equal_modulo_lr(&a, &b));
    }

    #[test]
    fn configs_equal_modulo_lr_detects_other_diffs() {
        let a = json!({ "framework": "vit", "lr": 0.01, "bs": 32 });
        let b = json!({ "framework": "vit", "lr": 0.001, "bs": 64 });
        assert!(!configs_equal_modulo_lr(&a, &b));
    }

    #[test]
    fn infer_edges_detects_same_arch_diff_data() {
        let r1 = detail("a", 1, json!({ "framework": "vit", "dataset": "cifar" }));
        let r2 = detail("b", 2, json!({ "framework": "vit", "dataset": "imagenet" }));
        let edges = infer_edges(&[r1, r2]);
        let kinds: Vec<_> = edges
            .iter()
            .map(|(_, _, k)| match k {
                RunEdgeKind::SameArchDiffData => "s",
                RunEdgeKind::ReranWithDiffLr => "r",
                RunEdgeKind::DerivedFrom => "d",
            })
            .collect();
        assert!(kinds.iter().filter(|k| **k == "s").count() == 2);
    }

    #[test]
    fn infer_edges_detects_reran_with_diff_lr() {
        let r1 = detail("a", 1, json!({ "framework": "vit", "dataset": "cifar", "lr": 0.01 }));
        let r2 = detail("b", 2, json!({ "framework": "vit", "dataset": "cifar", "lr": 0.001 }));
        let edges = infer_edges(&[r1, r2]);
        let kinds: Vec<_> = edges
            .iter()
            .map(|(_, _, k)| match k {
                RunEdgeKind::SameArchDiffData => "s",
                RunEdgeKind::ReranWithDiffLr => "r",
                RunEdgeKind::DerivedFrom => "d",
            })
            .collect();
        assert!(kinds.iter().filter(|k| **k == "r").count() == 2);
    }

    #[test]
    fn infer_edges_detects_derived_from_chain() {
        let r1 = detail("a", 1, json!({ "framework": "vit", "git_commit": "abc123" }));
        let r2 = detail("b", 2, json!({ "framework": "vit", "git_commit": "abc123" }));
        let r3 = detail("c", 3, json!({ "framework": "vit", "git_commit": "abc123" }));
        let edges = infer_edges(&[r1, r2, r3]);
        let d_count = edges
            .iter()
            .filter(|(_, _, k)| matches!(k, RunEdgeKind::DerivedFrom))
            .count();
        assert_eq!(d_count, 2, "expected chain of 2 derived_from edges");
    }

    #[test]
    fn summary_constructor_smoke() {
        // Touch the `summary` helper so the test file compiles even
        // when the other tests are deselected.
        let _ = summary("x", 0);
    }
}
