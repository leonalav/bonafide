//! W&B (Weights & Biases) tracker provider.
//!
//! Connects to W&B via the Python shim subprocess. The shim is spawned
//! lazily on first `connect()` and shut down on `disconnect()`. The
//! provider is identified by a `workspace_hash` which is the sha256 hex
//! of the workspace root path.
//!
//! ## Shim script path
//!
//! The shim script is resolved relative to the compiled binary. During
//! development the binary lives in `src-tauri/target/…`, so the script
//! resolves to the repo root `scripts/wandb_shim.py`. In release builds
//! the binary is typically installed in a platform-specific prefix, so
//! we fall back to looking next to the binary's directory.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use lazy_static::lazy_static;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;

use crate::shim::protocol::ShimRequest;
use crate::shim::ShimManager;
use crate::tracker::credentials::{delete_credential, get_credential, set_credential};
use crate::tracker::error::{TrackerError, TrackerErrorKind};
use crate::tracker::TrackerStatus;

// ── Shim script discovery ─────────────────────────────────────────────────

/// Resolve the path to `scripts/wandb_shim.py`.
///
/// Strategy:
/// 1. If the binary lives in `src-tauri/target/…/debug` or `…/release`, walk
///    up two levels to the repo root and return `$root/scripts/wandb_shim.py`.
/// 2. Otherwise, return `$binary_dir/scripts/wandb_shim.py` (works in-place
///    and in installed layouts).
fn resolve_shim_script() -> PathBuf {
    let exe = std::env::current_exe().ok();
    let shim_from_exe = exe
        .as_ref()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .map(|p| p.join("scripts/wandb_shim.py"));

    if let Some(ref path) = shim_from_exe {
        if path.is_file() {
            return path.clone();
        }
    }

    // Fallback: next to the binary
    exe.and_then(|p| p.parent().map(|p| p.join("scripts/wandb_shim.py")))
        .unwrap_or_else(|| PathBuf::from("scripts/wandb_shim.py"))
}

// ── W&B canonical data types (renderer-facing) ───────────────────────────
//
// These structs are camelCase because they serialize straight to the
// renderer's TypeScript types. The W&B shim returns snake_case, so each
// provider method deserializes into a private snake_case "raw" struct
// (below) and maps row-by-row onto these.

/// A page of runs returned by `list_runs`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPage {
    pub runs: Vec<RunSummary>,
    #[serde(rename = "nextCursor")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// A run summary returned by `list_runs`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub id: String,
    pub name: String,
    pub state: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "summaryMetrics")]
    pub summary_metrics: serde_json::Value,
}

/// Full run detail returned by `get_run`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
    pub id: String,
    pub name: String,
    pub state: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "finishedAt")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
    pub config: serde_json::Value,
    #[serde(rename = "summaryMetrics")]
    pub summary_metrics: serde_json::Value,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub notes: String,
}

/// A single (step, value) point in a metric time series.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub step: i64,
    pub value: f64,
    pub ts: i64,
}

/// Run configuration returned by `get_run_config`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunConfig {
    #[serde(rename = "runId")]
    pub run_id: String,
    pub config: serde_json::Value,
}

/// Reference to a logged W&B artifact.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRef {
    pub name: String,
    pub digest: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: i64,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

// ── W&B shim raw response shapes (snake_case) ─────────────────────────────
//
// The Python shim serializes its results with snake_case JSON. We parse
// each result into a private `Wandb…` struct and then map onto the
// canonical renderer types above. Keeping the raw shape local means the
// shim's response contract can drift without rippling out into the
// public API.

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct WandbRunSummaryRow {
    id: String,
    name: String,
    state: String,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    summary_metrics: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct WandbRunListResponse {
    runs: Vec<WandbRunSummaryRow>,
    #[serde(default)]
    next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct WandbRunDetailResponse {
    id: String,
    name: String,
    state: String,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    finished_at: Option<i64>,
    #[serde(default)]
    config: serde_json::Value,
    #[serde(default)]
    summary_metrics: serde_json::Value,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    notes: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct WandbPointRow {
    #[serde(default)]
    step: i64,
    value: f64,
    #[serde(default)]
    ts: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct WandbRunConfigResponse {
    run_id: String,
    #[serde(default)]
    config: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct WandbArtifactRow {
    name: String,
    digest: String,
    #[serde(default)]
    size_bytes: i64,
    #[serde(default)]
    created_at: i64,
}

// ── shim → TrackerError helper ────────────────────────────────────────────

/// Translate a `ShimError` into a typed `TrackerError`. Currently every
/// shim failure (timeout, crash, write error) is mapped onto
/// `ShimCrashed` because the user-visible "the tracker subprocess is
/// sick" signal is the same regardless of the underlying root cause.
fn shim_error_to_tracker(e: crate::shim::ShimError) -> TrackerError {
    TrackerError::shim_crashed(&e.to_string())
}

/// Translate a serde deserialization failure into a generic
/// `TrackerError::Unknown`. The renderer surfaces these as "couldn't
/// parse the W&B response" — the raw message is included for the dev
/// tools, but the kind stays broad so the UI doesn't show different
/// error states for what is effectively one bug class.
fn decode_error(label: &str, e: serde_json::Error) -> TrackerError {
    TrackerError {
        kind: TrackerErrorKind::Unknown,
        message: format!("Failed to decode W&B {label} response: {e}"),
        hint: None,
    }
}

// ── WandbProvider ─────────────────────────────────────────────────────────

/// A connected W&B provider scoped to one workspace.
///
/// Each instance holds a `ShimManager` for the Python shim subprocess.
/// The provider is identified by a workspace hash (sha256 of the workspace
/// root path). Credentials are stored in the OS keyring under
/// `tracker:wandb:{workspace_hash}`.
pub struct WandbProvider {
    /// Stable identifier for this workspace.
    workspace_hash: String,

    /// Manages the Python shim child process.
    shim: ShimManager,
}

impl WandbProvider {
    /// Construct a new `WandbProvider` for the given workspace.
    ///
    /// Does **not** spawn the shim — call `connect()` to do that.
    ///
    /// `workspace_hash` must be the sha256 hex digest of the workspace root
    /// path. It is used as the keyring entry name to store the API key.
    pub fn new(workspace_hash: String) -> Result<Self, TrackerError> {
        let api_key = crate::tracker::credentials::get_credential("wandb", &workspace_hash)
            .map_err(|e| TrackerError {
                kind: TrackerErrorKind::AuthFailed,
                message: format!("Failed to read API key from keyring: {e}"),
                hint: None,
            })?
            .unwrap_or_default();

        let shim_script = resolve_shim_script();

        let shim = ShimManager::new(shim_script, api_key)
            .map_err(|e| TrackerError {
                kind: TrackerErrorKind::ShimCrashed,
                message: format!("Failed to create shim manager: {e}"),
                hint: Some(
                    "Make sure Python 3 is installed and on your PATH".to_string(),
                ),
            })?;

        Ok(Self {
            workspace_hash,
            shim,
        })
    }

    /// Connect to W&B: spawn the Python shim and persist the API key.
    ///
    /// Stores the API key in the OS keyring under
    /// `tracker:wandb:{workspace_hash}` so it survives app restarts,
    /// and pushes it into the live `ShimManager` so the next `spawn()`
    /// call (initial spawn or key-change respawn) forwards it via the
    /// `WANDB_API_KEY` env var.
    pub fn connect(&self, api_key: &str) -> Result<(), TrackerError> {
        // Read the previously stored key to detect a change.
        let previous = crate::tracker::credentials::get_credential("wandb", &self.workspace_hash)
            .map_err(|e| TrackerError::auth_failed(&format!("keyring read failed: {e}")))?
            .unwrap_or_default();
        let key_changed = !previous.is_empty() && previous != api_key;

        // Store the new key.
        set_credential("wandb", &self.workspace_hash, api_key)
            .map_err(|e| TrackerError::auth_failed(&format!("keyring write failed: {e}")))?;

        // ALWAYS push the freshly-supplied key into the shim manager
        // before any spawn/respawn. Without this the env var would
        // carry the value captured at `WandbProvider::new()` time
        // (which is the pre-existing key, or an empty default on
        // first connect), and auth would silently fail downstream.
        self.shim.set_api_key(api_key.to_string());

        // Spawn the shim if not already running.
        if self.shim.pid().is_none() {
            self.shim.spawn().map_err(|e| TrackerError::shim_crashed(&format!("spawn failed: {e}")))?;
        } else if key_changed {
            // Respawn so the new env var is loaded. Use the
            // user-triggered variant — this must NOT count toward
            // MAX_RESTARTS, since the child isn't crashing; the user
            // is just supplying fresh credentials.
            self.shim.respawn_with_key().map_err(|e| TrackerError::shim_crashed(&format!("respawn failed: {e}")))?;
        }
        Ok(())
    }

    /// Disconnect from W&B: shut down the shim and remove the API key.
    ///
    /// Does **not** remove the workspace entry from the registry — the
    /// provider can be reconnected with a fresh `connect()` call.
    pub fn disconnect(&self) -> Result<(), TrackerError> {
        // Shut down the shim subprocess
        self.shim.shutdown();

        // Remove the API key from the keyring
        delete_credential("wandb", &self.workspace_hash).map_err(|e| TrackerError {
            kind: TrackerErrorKind::Unknown,
            message: format!("Failed to remove API key from keyring: {e}"),
            hint: None,
        })
    }

    /// Return the workspace hash for this provider.
    pub fn workspace_hash(&self) -> &str {
        &self.workspace_hash
    }

    /// Return the shim's OS process id, if the shim is running.
    pub fn shim_pid(&self) -> Option<u32> {
        self.shim.pid()
    }

    /// Probe the live shim with a cheap `list_runs` round-trip.
    ///
    /// Used by the renderer's "Test connection" action — the request
    /// has `limit = 1` so the network/disk cost is minimal, but we
    /// still hit the real pipeline. A successful return means auth,
    /// shim health, and the W&B API are all OK.
    pub async fn test_connection(&self) -> Result<(), TrackerError> {
        self.shim
            .send(ShimRequest::ListRuns {
                project: String::new(),
                limit: 1,
                cursor: None,
            })
            .await
            .map_err(shim_error_to_tracker)?;
        Ok(())
    }

    /// Fetch a page of runs for the given project. Calls
    /// `ShimRequest::ListRuns` with the supplied paging parameters and
    /// maps the snake_case response onto the canonical `RunPage`.
    pub async fn list_runs(
        &self,
        project: &str,
        limit: u32,
        cursor: Option<&str>,
    ) -> Result<RunPage, TrackerError> {
        let result = self
            .shim
            .send(ShimRequest::ListRuns {
                project: project.to_string(),
                limit,
                cursor: cursor.map(String::from),
            })
            .await
            .map_err(shim_error_to_tracker)?;

        let parsed: WandbRunListResponse =
            serde_json::from_value(result).map_err(|e| decode_error("list_runs", e))?;

        let runs = parsed
            .runs
            .into_iter()
            .map(|r| RunSummary {
                id: r.id,
                name: r.name,
                state: r.state,
                created_at: r.created_at,
                summary_metrics: r.summary_metrics,
            })
            .collect();

        Ok(RunPage {
            runs,
            next_cursor: parsed.next_cursor,
        })
    }

    /// Fetch full metadata for one run, including config, summary, tags,
    /// and notes. Calls `ShimRequest::GetRun` and maps the snake_case
    /// payload to the canonical `RunDetail`.
    pub async fn get_run(&self, run_id: &str) -> Result<RunDetail, TrackerError> {
        let result = self
            .shim
            .send(ShimRequest::GetRun {
                run_id: run_id.to_string(),
            })
            .await
            .map_err(shim_error_to_tracker)?;

        let parsed: WandbRunDetailResponse =
            serde_json::from_value(result).map_err(|e| decode_error("get_run", e))?;

        Ok(RunDetail {
            id: parsed.id,
            name: parsed.name,
            state: parsed.state,
            created_at: parsed.created_at,
            finished_at: parsed.finished_at,
            config: parsed.config,
            summary_metrics: parsed.summary_metrics,
            tags: parsed.tags,
            notes: parsed.notes,
        })
    }

    /// Fetch the (step, value) time series for one metric key on a run.
    /// Calls `ShimRequest::GetMetricSeries` and deserializes the array
    /// of snake_case rows straight into the canonical `Point` shape.
    pub async fn get_metric_series(
        &self,
        run_id: &str,
        key: &str,
    ) -> Result<Vec<Point>, TrackerError> {
        let result = self
            .shim
            .send(ShimRequest::GetMetricSeries {
                run_id: run_id.to_string(),
                key: key.to_string(),
            })
            .await
            .map_err(shim_error_to_tracker)?;

        let rows: Vec<WandbPointRow> =
            serde_json::from_value(result).map_err(|e| decode_error("get_metric_series", e))?;

        Ok(rows
            .into_iter()
            .map(|r| Point {
                step: r.step,
                value: r.value,
                ts: r.ts,
            })
            .collect())
    }

    /// Fetch the run config (hyperparameters + metadata fields) for one
    /// run. Calls `ShimRequest::GetRunConfig` and maps the snake_case
    /// payload to the canonical `RunConfig`.
    pub async fn get_run_config(&self, run_id: &str) -> Result<RunConfig, TrackerError> {
        let result = self
            .shim
            .send(ShimRequest::GetRunConfig {
                run_id: run_id.to_string(),
            })
            .await
            .map_err(shim_error_to_tracker)?;

        let parsed: WandbRunConfigResponse =
            serde_json::from_value(result).map_err(|e| decode_error("get_run_config", e))?;

        Ok(RunConfig {
            run_id: parsed.run_id,
            config: parsed.config,
        })
    }

    /// List artifacts logged by a run. Calls `ShimRequest::ListArtifacts`
    /// and maps each snake_case row onto the canonical `ArtifactRef`.
    pub async fn list_artifacts(
        &self,
        run_id: &str,
    ) -> Result<Vec<ArtifactRef>, TrackerError> {
        let result = self
            .shim
            .send(ShimRequest::ListArtifacts {
                run_id: run_id.to_string(),
            })
            .await
            .map_err(shim_error_to_tracker)?;

        let rows: Vec<WandbArtifactRow> =
            serde_json::from_value(result).map_err(|e| decode_error("list_artifacts", e))?;

        Ok(rows
            .into_iter()
            .map(|r| ArtifactRef {
                name: r.name,
                digest: r.digest,
                size_bytes: r.size_bytes,
                created_at: r.created_at,
            })
            .collect())
    }
}

// ── Global registry ───────────────────────────────────────────────────────

lazy_static! {
    /// Global registry of connected tracker providers, keyed by workspace hash.
    /// Each entry holds an `Arc` so it can be cloned into command handlers.
    static ref TRACKER_REGISTRY: RwLock<std::collections::HashMap<String, Arc<WandbProvider>>> =
        RwLock::new(std::collections::HashMap::new());
}

/// Compute the registry / keyring key for a workspace root.
///
/// Same scheme as `mlflow::hash_workspace`, `graph::storage::workspace_hash`,
/// and `lib::compute_workspace_hash`: sha256 hex of the canonicalized
/// workspace root path, **truncated to the first 8 bytes (16 hex chars)**.
/// Truncating keeps the value matching what the renderer stores on
/// `Workspace.hash` after `open_workspace`, so the registry lookups in
/// `is_tracker_connected` actually find the provider.
///
/// Exposed at `pub(crate)` so MLflow can reuse it (and stay in sync
/// across providers for the same workspace).
pub(crate) fn hash_workspace(root: &Path) -> String {
    let normalized = root
        .canonicalize()
        .unwrap_or_else(|_| root.to_path_buf())
        .to_string_lossy()
        .to_string();
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    let digest = hasher.finalize();
    hex::encode(&digest[..8])
}

/// Connect a W&B tracker for the given workspace.
///
/// Looks up or creates a `WandbProvider` in the global registry and calls
/// `connect(api_key)`. If a provider is already connected for this
/// workspace, `connect` is still called — the shim will be respawned with
/// the new key if the keyring entry has changed.
///
/// Returns the workspace hash of the connected provider.
pub async fn connect_tracker(
    workspace_root: &Path,
    api_key: &str,
) -> Result<String, TrackerError> {
    let workspace_hash = hash_workspace(workspace_root);  // 16-char hash after A1 fix

    // Hold a single write lock across the whole check-and-insert path.
    let mut registry = TRACKER_REGISTRY.write().await;
    if let Some(provider) = registry.get(&workspace_hash) {
        provider.connect(api_key)?;
        return Ok(workspace_hash);
    }

    let provider = Arc::new(WandbProvider::new(workspace_hash.clone())?);
    provider.connect(api_key)?;
    registry.insert(workspace_hash.clone(), provider);
    Ok(workspace_hash)
}

/// Disconnect the W&B tracker for the given workspace.
pub async fn disconnect_tracker(workspace_root: &Path) -> Result<(), TrackerError> {
    let workspace_hash = hash_workspace(workspace_root);

    let provider = {
        let mut registry = TRACKER_REGISTRY.write().await;
        registry.remove(&workspace_hash)
    };

    match provider {
        Some(p) => p.disconnect(),
        None => Err(TrackerError {
            kind: TrackerErrorKind::NotFound,
            message: "No W&B tracker connected for this workspace".to_string(),
            hint: None,
        }),
    }
}

/// Returns true if a tracker provider is connected for the given workspace hash.
pub async fn is_tracker_connected(workspace_hash: &str) -> bool {
    TRACKER_REGISTRY.read().await.contains_key(workspace_hash)
}

/// Look up a registered W&B provider by workspace hash. Clones the
/// `Arc`, so the returned handle shares ownership with the registry —
/// callers can call methods on it without holding the registry lock.
///
/// Returns `None` if no provider is registered (e.g. the workspace
/// hasn't been connected yet, or has been disconnected). Used by the
/// background run-graph sync to dispatch against the live provider
/// without re-prompting the user for credentials.
pub async fn get_wandb_provider(workspace_hash: &str) -> Option<Arc<WandbProvider>> {
    TRACKER_REGISTRY
        .read()
        .await
        .get(workspace_hash)
        .cloned()
}

/// Test the live W&B tracker connection by issuing a cheap round-trip
/// against the shim and timing it. Used by the renderer's "Test"
/// action; returned `TrackerStatus` is consumed by
/// `src/components/tracker/ConnectionStatus.tsx`.
pub async fn test_tracker_connection(
    workspace_hash: &str,
) -> Result<TrackerStatus, TrackerError> {
    let provider = get_wandb_provider(workspace_hash)
        .await
        .ok_or_else(|| TrackerError {
            kind: TrackerErrorKind::NotFound,
            message: "No W&B tracker connected for this workspace".to_string(),
            hint: Some(
                "Call connect_tracker with kind=\"wandb\" first.".to_string(),
            ),
        })?;

    let started = std::time::Instant::now();
    provider.test_connection().await?;
    let latency_ms = started.elapsed().as_millis() as u64;

    Ok(TrackerStatus::ok(latency_ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_shim_script() {
        let path = resolve_shim_script();
        // Should return a PathBuf (may not exist in test env)
        let _ = path;
    }

    #[tokio::test]
    async fn test_registry_empty() {
        let registry = TRACKER_REGISTRY.read().await;
        assert!(registry.is_empty());
    }

    #[tokio::test]
    async fn test_get_wandb_provider_missing() {
        // No provider registered for this synthetic key — must return None.
        let provider = get_wandb_provider("does-not-exist").await;
        assert!(provider.is_none());
    }

    #[test]
    fn test_hash_workspace_stable() {
        // Same input → same output, every call.
        let root = Path::new("/tmp/example");
        let h1 = hash_workspace(root);
        let h2 = hash_workspace(root);
        assert_eq!(h1, h2);
        // Truncated to first 8 bytes of sha256 = 16 hex chars, matching
        // `mlflow::hash_workspace`, `graph::storage::workspace_hash`,
        // and `lib::compute_workspace_hash`.
        assert_eq!(h1.len(), 16);
    }
}
