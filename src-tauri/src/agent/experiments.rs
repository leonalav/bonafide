//! Experiment persistence layer (Phase 2: hypothesis-driven records).
//!
//! An *Experiment* is a renderable unit of work the user commits to:
//! one row per `title + hypothesis + goal metric + budgets` tuple, with
//! many linked tracking runs in `experiment_runs`. This is the storage
//! half of that picture -- the orchestrator keeps the rich in-memory
//! Experiment type, but the renderer only ever reads the serialized
//! shape modeled here.
//!
//! All write paths upsert by `id` so a `proposed -> active -> completed`
//! transition is just an `update_experiment` that re-saves the same row
//! with a new `status` + bumped `updated_at`. Reads return rows sorted
//! newest-first so the Experiments tab surfaces actively-running items
//! ahead of older closed ones.
//!
//! ## Workspace scoping
//! Every command that takes a `workspace_hash` parameter enforces that
//! the experiment or run belongs to that workspace. This prevents a
//! renderer with workspace A open from reading, writing, or deleting
//! data that lives in workspace B.

use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};

/// Persisted shape of an Experiment row.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentRow {
    pub id: String,
    pub workspace_hash: String,
    pub title: String,
    pub hypothesis: String,
    pub goal_metric: String,
    pub goal_direction: String,
    pub goal_target: f64,
    pub goal_condition: String,
    pub status: String,
    pub budget_dollars: f64,
    pub budget_gpu_hours: f64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Persisted shape of an ExperimentRun attachment row.
/// `config_overrides` and `metrics_summary` are serialised JSON strings.
/// Callers MUST `JSON.parse` these strings before using as objects.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentRunRow {
    pub id: String,
    pub experiment_id: String,
    pub run_id: String,
    /// Serialised JSON string. Callers: `JSON.parse(row.config_overrides)`.
    pub config_overrides: String,
    /// Serialised JSON string. Callers: `JSON.parse(row.metrics_summary)`.
    pub metrics_summary: String,
    pub status: String,
    pub created_at: i64,
}

/// Insert (or replace) an experiment row.
/// NOTE: callers MUST ensure `row.workspace_hash` is set to the canonical
/// workspace hash before calling. The Tauri command layer enforces this.
pub fn create_experiment(conn: &Connection, row: &ExperimentRow) -> Result<()> {
    conn.execute(
        r"
        INSERT INTO experiments (
            id, workspace_hash, title, hypothesis, goal_metric, goal_direction,
            goal_target, goal_condition, status, budget_dollars, budget_gpu_hours,
            created_at, updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        ON CONFLICT(id) DO UPDATE SET
            workspace_hash   = excluded.workspace_hash,
            title            = excluded.title,
            hypothesis       = excluded.hypothesis,
            goal_metric      = excluded.goal_metric,
            goal_direction   = excluded.goal_direction,
            goal_target      = excluded.goal_target,
            goal_condition   = excluded.goal_condition,
            status           = excluded.status,
            budget_dollars   = excluded.budget_dollars,
            budget_gpu_hours = excluded.budget_gpu_hours,
            updated_at       = excluded.updated_at
        ",
        params![
            row.id, row.workspace_hash, row.title, row.hypothesis,
            row.goal_metric, row.goal_direction, row.goal_target,
            row.goal_condition, row.status, row.budget_dollars,
            row.budget_gpu_hours, row.created_at, row.updated_at,
        ],
    )?;
    Ok(())
}

/// Fetch one experiment by id, scoped to workspace_hash.
/// Returns `Ok(None)` when no row matches.
pub fn get_experiment(
    conn: &Connection,
    id: &str,
    workspace_hash: &str,
) -> Result<Option<ExperimentRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, workspace_hash, title, hypothesis, goal_metric, goal_direction,
                goal_target, goal_condition, status, budget_dollars, budget_gpu_hours,
                created_at, updated_at
           FROM experiments
          WHERE id = ?1 AND workspace_hash = ?2",
    )?;
    let mut rows = stmt.query(params![id, workspace_hash])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row_to_experiment(row)?))
    } else {
        Ok(None)
    }
}

/// Fetch every experiment for workspace_hash, sorted newest-first.
pub fn list_experiments(
    conn: &Connection,
    workspace_hash: &str,
) -> Result<Vec<ExperimentRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, workspace_hash, title, hypothesis, goal_metric, goal_direction,
                goal_target, goal_condition, status, budget_dollars, budget_gpu_hours,
                created_at, updated_at
           FROM experiments
          WHERE workspace_hash = ?1
          ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map(params![workspace_hash], |row| row_to_experiment(row))?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

/// Update an existing experiment row (upsert by id).
/// NOTE: callers MUST ensure `row.workspace_hash` is set to the canonical hash.
pub fn update_experiment(conn: &Connection, row: &ExperimentRow) -> Result<()> {
    create_experiment(conn, row)
}

/// Delete an experiment row by id, scoped to workspace_hash.
/// `experiment_runs` are cascade-deleted via FK in `storage.rs`.
/// Returns `Ok(())` always (idempotent).
pub fn delete_experiment(
    conn: &Connection,
    id: &str,
    workspace_hash: &str,
) -> Result<()> {
    conn.execute(
        "DELETE FROM experiments WHERE id = ?1 AND workspace_hash = ?2",
        params![id, workspace_hash],
    )?;
    Ok(())
}

/// Upsert a run-attachment row. `workspace_hash` prevents cross-workspace
/// attachment: we check the experiment belongs to the caller's workspace
/// before inserting, since the FK only checks `experiment_id` existence.
pub fn attach_run(
    conn: &Connection,
    row: &ExperimentRunRow,
    workspace_hash: &str,
) -> Result<()> {
    let owner_ok: bool = conn
        .query_row(
            "SELECT 1 FROM experiments WHERE id = ?1 AND workspace_hash = ?2",
            params![row.experiment_id, workspace_hash],
            |_r| Ok(true),
        )
        .optional()?
        .is_some();

    if !owner_ok {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }

    conn.execute(
        r"
        INSERT INTO experiment_runs (
            id, experiment_id, run_id, config_overrides, metrics_summary, status, created_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(id) DO UPDATE SET
            experiment_id    = excluded.experiment_id,
            run_id           = excluded.run_id,
            config_overrides = excluded.config_overrides,
            metrics_summary  = excluded.metrics_summary,
            status           = excluded.status
        ",
        params![
            row.id, row.experiment_id, row.run_id,
            row.config_overrides, row.metrics_summary,
            row.status, row.created_at,
        ],
    )?;
    Ok(())
}

/// Fetch every run attachment for `experiment_id`, scoped to workspace_hash
/// via JOIN. Sorted oldest-first for timeline order.
pub fn list_experiment_runs(
    conn: &Connection,
    experiment_id: &str,
    workspace_hash: &str,
) -> Result<Vec<ExperimentRunRow>> {
    let mut stmt = conn.prepare(
        "SELECT er.id, er.experiment_id, er.run_id, er.config_overrides,
                er.metrics_summary, er.status, er.created_at
           FROM experiment_runs er
           JOIN experiments e ON e.id = er.experiment_id
          WHERE er.experiment_id = ?1 AND e.workspace_hash = ?2
          ORDER BY er.created_at ASC",
    )?;
    let rows = stmt.query_map(params![experiment_id, workspace_hash], |row| {
        Ok(ExperimentRunRow {
            id: row.get(0)?,
            experiment_id: row.get(1)?,
            run_id: row.get(2)?,
            config_overrides: row.get(3)?,
            metrics_summary: row.get(4)?,
            status: row.get(5)?,
            created_at: row.get(6)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

fn row_to_experiment(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExperimentRow> {
    Ok(ExperimentRow {
        id: row.get(0)?,
        workspace_hash: row.get(1)?,
        title: row.get(2)?,
        hypothesis: row.get(3)?,
        goal_metric: row.get(4)?,
        goal_direction: row.get(5)?,
        goal_target: row.get(6)?,
        goal_condition: row.get(7)?,
        status: row.get(8)?,
        budget_dollars: row.get(9)?,
        budget_gpu_hours: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

