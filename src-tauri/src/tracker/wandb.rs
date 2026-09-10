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

use crate::shim::ShimManager;
use crate::tracker::credentials::{delete_credential, set_credential};
use crate::tracker::error::{TrackerError, TrackerErrorKind};

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

// ── W&B data types ────────────────────────────────────────────────────────

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
    /// `tracker:wandb:{workspace_hash}` so it survives app restarts.
    pub fn connect(&self, api_key: &str) -> Result<(), TrackerError> {
        // Store the API key in the keyring
        set_credential("wandb", &self.workspace_hash, api_key)
            .map_err(|e| TrackerError {
                kind: TrackerErrorKind::AuthFailed,
                message: format!("Failed to store API key in keyring: {e}"),
                hint: None,
            })?;

        // Spawn the shim
        self.shim
            .spawn()
            .map_err(|e| TrackerError::shim_crashed(&format!("spawn failed: {e}")))
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
}

// ── Global registry ───────────────────────────────────────────────────────

lazy_static! {
    /// Global registry of connected tracker providers, keyed by workspace hash.
    /// Each entry holds an `Arc` so it can be cloned into command handlers.
    static ref TRACKER_REGISTRY: RwLock<std::collections::HashMap<String, Arc<WandbProvider>>> =
        RwLock::new(std::collections::HashMap::new());
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
    // Compute workspace hash from the root path using sha256 -> hex
    let mut hasher = Sha256::new();
    hasher.update(workspace_root.to_string_lossy().as_bytes());
    let workspace_hash = hex::encode(hasher.finalize());

    // Check if we already have a provider for this workspace
    {
        let registry = TRACKER_REGISTRY.read().await;
        if let Some(provider) = registry.get(&workspace_hash) {
            // Provider already exists — call connect to (re)store key and respawn shim
            provider.connect(api_key)?;
            return Ok(workspace_hash);
        }
    }

    // Create and connect a new provider
    let provider = Arc::new(WandbProvider::new(workspace_hash.clone())?);
    provider.connect(api_key)?;

    // Insert into registry
    let mut registry = TRACKER_REGISTRY.write().await;
    registry.insert(workspace_hash.clone(), provider);

    Ok(workspace_hash)
}

/// Disconnect the W&B tracker for the given workspace.
pub async fn disconnect_tracker(workspace_root: &Path) -> Result<(), TrackerError> {
    // Compute workspace hash from the root path using sha256 -> hex
    let mut hasher = Sha256::new();
    hasher.update(workspace_root.to_string_lossy().as_bytes());
    let workspace_hash = hex::encode(hasher.finalize());

    let provider = {
        let mut registry = TRACKER_REGISTRY.write().await;
        registry.remove(&workspace_hash)
    };

    match provider {
        Some(p) => p.disconnect(),
        None => Err(TrackerError {
            kind: TrackerErrorKind::NotFound,
            message: format!("No tracker connected for workspace"),
            hint: None,
        }),
    }
}

/// Returns true if a tracker provider is connected for the given workspace hash.
pub async fn is_tracker_connected(workspace_hash: &str) -> bool {
    TRACKER_REGISTRY.read().await.contains_key(workspace_hash)
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
}
