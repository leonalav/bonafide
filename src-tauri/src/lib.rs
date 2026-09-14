// Bonafide — Tauri 2 backend.
//
// Direct port of electron/main.ts. Each previously-Electron IPC handler
// is now a `#[tauri::command]` and the directory walker logic is kept
// intact. The renderer talks to these via `@tauri-apps/api/core#invoke`,
// so the only change on the renderer side is replacing `window.electronAPI`
// with the tauri invoke wrapper (handled in src/ipc/tauri.ts).
//
// Plugins (dialog, fs, shell) are registered in the `tauri::Builder`
// below so commands we *don't* need to reimplement in Rust (e.g. dialog
// folder picking) come straight from the official plugin.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::RwLock;
use walkdir::WalkDir;

mod lsp_bridge;
mod pty_bridge;
mod fs_watcher;
mod git_service;
mod graph;
mod agent;
mod shim;
mod tracker;
mod commands;

use graph::Storage;

// ── Types shared with the renderer ────────────────────────────────────────
// These mirror the FsNode / DirListing / ElectronAPI types from the
// preload so the renderer can drop them straight into its FileTree
// store.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsNode {
    id: String,
    name: String,
    kind: String, // "folder" | "file"
    parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expanded: Option<bool>,
    file_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirListing {
    root_path: String,
    root_name: String,
    files: Vec<FsNode>,
}

#[derive(Debug, Clone, Serialize)]
struct FileContent {
    content: String,
}

#[derive(Debug, Clone, Serialize)]
struct OpResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

// ── Phase 0 types ──────────────────────────────────────────────────────────

/// Per-workspace workspace descriptor returned by `open_workspace`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub root: String,
    pub hash: String,
    pub db_path: String,
    pub has_tracker: bool,
}

/// Lightweight workspace summary returned by `list_workspaces`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub root: String,
    pub hash: String,
    pub last_opened: i64,
}

/// Per-workspace storage state — keyed by workspace hash.
type StorageState = Arc<RwLock<HashMap<String, Storage>>>;

// Phase 2: per-workspace budget registry removed in WS0-T1.
// The real BudgetRegistry is rebuilt in WS2-T4; until then this
// alias is a no-op so the `manage()` builder below still type-checks.
type BudgetState = ();

// ── Directory walking ─────────────────────────────────────────────────────
// Same logic as the Electron main process: skip noisy dirs (node_modules,
// .git, caches, build output), classify files by extension, build path
// ids relative to the root manually so nested folders get the right
// prefix (`layers/gdn2.py`, never `gdn2.py`).

const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", ".next", "dist", "dist-electron", "__pycache__",
    ".venv", "venv", ".mypy_cache", ".pytest_cache", ".idea", ".vscode",
    "target", "build",
];

fn ext_to_file_type(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if lower.ends_with(".py") { "python" }
    else if lower.ends_with(".md") || lower == "readme" || lower == "license" { "markdown" }
    else if lower.ends_with(".json") || lower.ends_with(".jsonc") { "json" }
    else if lower.ends_with(".ts") { "typescript" }
    else if lower.ends_with(".tsx") { "tsx" }
    else if lower.ends_with(".css") || lower.ends_with(".scss") { "css" }
    else if lower.ends_with(".yml") || lower.ends_with(".yaml") { "yaml" }
    else if lower.ends_with(".toml") { "toml" }
    else if lower.ends_with(".sh") || lower.ends_with(".bash") { "shell" }
    else { "text" }
}

fn walk_dir(root: &Path) -> Vec<FsNode> {
    let mut out: Vec<FsNode> = Vec::new();
    // `filter_entry` decides which entries to descend into. Returning
    // `false` here skips the entry *and all of its descendants*, which
    // is the only way to avoid walking into e.g. `node_modules` (which
    // can contain 10k+ files on a typical ML project). The previous
    // implementation only checked the skip-list inside the loop body,
    // so files nested inside `node_modules/foo/` were still being
    // emitted — causing massive tree bloat and slow first-paint.
    let walker = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.path() == root {
                return true; // keep the root itself
            }
            // Skip hidden entries (anything starting with `.`).
            let name = e.file_name().to_str().unwrap_or("");
            if name.starts_with('.') {
                return false;
            }
            // Skip noisy top-level dirs (only relevant for direct
            // children of root; deeper descendants inherit the skip
            // because we return false here for the dir itself).
            if e.file_type().is_dir() {
                let rel = e.path().strip_prefix(root)
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                let top = rel.split('/').next().unwrap_or("");
                if SKIP_DIRS.iter().any(|s| *s == top) {
                    return false;
                }
            }
            true
        });

    for entry in walker.flatten() {
        if entry.path() == root { continue; }
        let name = entry.file_name().to_string_lossy().to_string();
        let rel = entry
            .path()
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        if rel.is_empty() { continue; }

        let rel_parent = {
            let p = Path::new(&rel);
            p.parent().and_then(|p| p.to_str()).map(|s| {
                if s.is_empty() || s == "." { String::new() } else { s.replace('\\', "/") }
            })
        };
        let parent_id = rel_parent.filter(|s| !s.is_empty());

        if entry.file_type().is_dir() {
            out.push(FsNode {
                id: rel.clone(),
                name,
                kind: "folder".into(),
                parent_id,
                expanded: None,
                file_type: "text".into(),
            });
        } else if entry.file_type().is_file() {
            out.push(FsNode {
                id: rel.clone(),
                name,
                kind: "file".into(),
                parent_id,
                expanded: None,
                file_type: ext_to_file_type(&rel).into(),
            });
        }
    }
    out
}

// ── Tauri commands ────────────────────────────────────────────────────────

#[tauri::command]
async fn read_directory(path: String) -> Result<DirListing, String> {
    let p = PathBuf::from(&path);
    let meta = fs::metadata(&p).map_err(|e| format!("stat failed: {e}"))?;
    if !meta.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }
    let files = walk_dir(&p);
    let root_name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    Ok(DirListing { root_path: path, root_name, files })
}

#[tauri::command]
async fn read_file(path: String) -> Result<FileContent, String> {
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("read failed: {e}"))?;
    Ok(FileContent { content })
}

#[tauri::command]
async fn write_file(path: String, content: String) -> Result<OpResult, String> {
    fs::write(&path, content).map_err(|e| format!("write failed: {e}"))?;
    Ok(OpResult { ok: true, path: Some(path) })
}

#[tauri::command]
async fn create_file(parent_dir: String, name: String) -> Result<OpResult, String> {
    let target = PathBuf::from(&parent_dir).join(&name);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    fs::write(&target, "").map_err(|e| format!("write failed: {e}"))?;
    Ok(OpResult { ok: true, path: Some(target.to_string_lossy().to_string()) })
}

#[tauri::command]
async fn create_folder(parent_dir: String, name: String) -> Result<OpResult, String> {
    let target = PathBuf::from(&parent_dir).join(&name);
    fs::create_dir(&target).map_err(|e| format!("mkdir failed: {e}"))?;
    Ok(OpResult { ok: true, path: Some(target.to_string_lossy().to_string()) })
}

#[tauri::command]
async fn rename_path(src: String, new_name: String) -> Result<OpResult, String> {
    let src_p = PathBuf::from(&src);
    let parent = src_p.parent().ok_or("no parent directory")?;
    let target = parent.join(&new_name);
    fs::rename(&src_p, &target).map_err(|e| format!("rename failed: {e}"))?;
    Ok(OpResult { ok: true, path: Some(target.to_string_lossy().to_string()) })
}

#[tauri::command]
async fn delete_path(target: String) -> Result<OpResult, String> {
    let p = PathBuf::from(&target);
    let meta = fs::metadata(&p).map_err(|e| format!("stat failed: {e}"))?;
    if meta.is_dir() {
        fs::remove_dir_all(&p).map_err(|e| format!("rmdir failed: {e}"))?;
    } else {
        fs::remove_file(&p).map_err(|e| format!("unlink failed: {e}"))?;
    }
    Ok(OpResult { ok: true, path: None })
}

// ── File watcher ──────────────────────────────────────────────────────────

/// Start watching a workspace directory for file-system changes.
/// Called from the renderer when a workspace is opened (after `read_directory`).
/// If a watcher is already running, it is stopped and replaced.
#[tauri::command]
async fn start_watcher(
    path: String,
    state: State<'_, fs_watcher::WatcherState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut guard = state.lock().await;
    guard.watch(PathBuf::from(&path), app);
    Ok(())
}

/// Stop watching the current workspace. Called from the renderer when
/// the workspace is closed or changed.
#[tauri::command]
async fn stop_watcher(state: State<'_, fs_watcher::WatcherState>) -> Result<(), String> {
    state.lock().await.unwatch();
    Ok(())
}

// ── App lifecycle ────────────────────────────────────────────────────────

#[tauri::command]
fn get_lsp_bridge_url() -> String {
    // The WebSocket bridge URL is fixed. The browser connects to this to reach
    // the LSP servers (pyright-langserver, ruff-langserver) running as child
    // processes in the Rust backend.
    "ws://127.0.0.1:9877".to_string()
}

#[tauri::command]
fn get_lsp_servers(state: State<'_, lsp_bridge::ProcessMap>) -> Vec<serde_json::Value> {
    // Note: this is called synchronously from the renderer, but the ProcessMap
    // uses a tokio RwLock. Since we are on the Tauri main thread (not an async
    // runtime), we can only do a blocking read. Use `try_read()` which either
    // gets the lock immediately or returns None (not an error for our purposes).
    match state.try_read() {
        Ok(p) => p
            .keys()
            .map(|k| serde_json::json!({ "id": k, "status": "running" }))
            .collect(),
        Err(_) => vec![],
    }
}

#[tauri::command]
fn stop_lsp_server(
    server_id: String,
    state: State<'_, lsp_bridge::ProcessMap>,
) -> Result<(), String> {
    let mut p = state.try_write()
        .map_err(|_| "LSP state is busy — try again shortly")?;

    if let Some(mut proc) = p.remove(&server_id) {
        let _ = proc.to_lsp_tx.try_send(Vec::new()); // signal EOF to stdin writer
        proc.child.start_kill().map_err(|e| e.to_string())?;
        log::info!("[lsp] Stopped server: {server_id}");
        Ok(())
    } else {
        Err(format!("Server not found: {server_id}"))
    }
}

/// Run `ruff check` on a file and return its JSON diagnostics.
#[tauri::command]
async fn ruff_check(file_path: String) -> Result<String, String> {
    use tokio::process::Command;

    let output = Command::new("ruff")
        .args(["check", "--output-format=json", &file_path])
        .output()
        .await
        .map_err(|e| {
            format!(
                "Failed to run ruff: {e}. \
                 Install: `pip install ruff`  (or `ruff --version` to verify)"
            )
        })?;

    let stdout_len = output.stdout.len();
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !stderr.is_empty() && stdout_len == 0 {
        log::warn!("[ruff] stderr: {stderr}");
    }

    String::from_utf8(output.stdout)
        .map_err(|e| format!("ruff stdout not UTF-8: {e}"))
}

/// Return the WebSocket URL for the PTY bridge (xterm.js terminal sessions).
/// The PTY bridge listens on port 9878 on localhost; the frontend connects to
/// it from the browser.  When not running in Tauri (e.g. browser dev preview),
/// this falls back to a local URL via the tauri.ts IPC wrapper.
#[tauri::command]
fn get_pty_ws_url() -> String {
    "ws://127.0.0.1:9878".to_string()
}

/// Return the list of detected terminal profiles (cmd, powershell, etc.)
/// for the renderer to populate the "+ Launch Profile" dropdown.
#[tauri::command]
fn list_terminal_profiles(state: State<'_, pty_bridge::ProfileRegistry>) -> Vec<pty_bridge::TerminalProfile> {
    state.as_ref().clone()
}

// ── Git / source-control commands ─────────────────────────────────────────
//
// Each command is a thin wrapper over `git_service::...`. The renderer
// is the only caller (via `invoke` from src/ipc/tauri.ts). All commands
// take a `workspace: String` path so they run against the user's
// currently-open folder regardless of the process CWD.

#[tauri::command]
async fn git_status(workspace: String) -> Result<git_service::GitStatus, String> {
    git_service::status(workspace).await
}

#[tauri::command]
async fn git_list_branches(workspace: String) -> Result<Vec<git_service::GitBranch>, String> {
    git_service::list_branches(workspace).await
}

#[tauri::command]
async fn git_log(workspace: String, max_count: Option<usize>) -> Result<Vec<git_service::GitCommit>, String> {
    git_service::log(workspace, max_count).await
}

#[tauri::command]
async fn git_diff(workspace: String, path: Option<String>) -> Result<git_service::GitDiffResult, String> {
    git_service::diff(workspace, path).await
}

#[tauri::command]
async fn git_add(workspace: String, paths: Vec<String>) -> Result<git_service::GitOpResult, String> {
    git_service::add(workspace, paths).await
}

#[tauri::command]
async fn git_unstage(workspace: String, paths: Vec<String>) -> Result<git_service::GitOpResult, String> {
    git_service::unstage(workspace, paths).await
}

#[tauri::command]
async fn git_discard(workspace: String, paths: Vec<String>) -> Result<git_service::GitOpResult, String> {
    git_service::discard(workspace, paths).await
}

#[tauri::command]
async fn git_commit(workspace: String, message: String) -> Result<git_service::GitOpResult, String> {
    git_service::commit(workspace, message).await
}

#[tauri::command]
async fn git_checkout(workspace: String, branch: String, create: bool) -> Result<git_service::GitOpResult, String> {
    git_service::checkout(workspace, branch, create).await
}

#[tauri::command]
async fn git_pull(workspace: String) -> Result<git_service::GitOpResult, String> {
    git_service::pull(workspace).await
}

#[tauri::command]
async fn git_push(workspace: String) -> Result<git_service::GitOpResult, String> {
    git_service::push(workspace).await
}

#[tauri::command]
async fn git_fetch(workspace: String) -> Result<git_service::GitOpResult, String> {
    git_service::fetch(workspace).await
}

#[tauri::command]
async fn git_init(workspace: String) -> Result<git_service::GitOpResult, String> {
    git_service::init(workspace).await
}

// ── Phase 0: Workspace commands ─────────────────────────────────────────────

/// Wrapper around the shared `agent::compute_workspace_hash` for callers
/// inside lib.rs. Keeps the local name short and avoids importing the
/// agent module into this file's namespace.
fn compute_workspace_hash(root: &Path) -> String {
    agent::compute_workspace_hash(root)
}

#[tauri::command]
async fn open_workspace(
    path: String,
    storage_state: State<'_, StorageState>,
    app: AppHandle,
) -> Result<Workspace, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }

    let (_conn, hash) = graph::storage::open_workspace_db(&root)
        .map_err(|e| format!("Failed to open workspace DB: {e}"))?;

    // WS1-T2: Ensure the v2 thread schema is in place. Idempotent — runs
    // every workspace open but adds zero columns on a fully-migrated
    // database. The function lives in `agent::migrations` and is a
    // additive-only `ALTER TABLE` block. We run it after the base
    // migrations in `open_workspace_db` but before any storage
    // operation so the v2 columns are available to subsequent
    // `upsert_thread` / `list_threads` calls. Errors bubble up so a
    // corrupted database surfaces as a clear failure instead of being
    // masked by a later `INSERT` error.
    //
    // WS3-T3 (model persistence): also run the v3 migration that
    // adds the `model_id TEXT` column. Without this, `row_to_thread`
    // always rehydrates with the hardcoded `"claude-sonnet-4"` seed
    // from `Thread::new` and the renderer has to re-send `modelId`
    // on every submit. The v3 column makes the persisted value the
    // authoritative fallback when the renderer omits the field.
    let root_for_migration = PathBuf::from(&path);
    let _ = tokio::task::block_in_place(move || -> Result<(), String> {
        let (conn, _hash) = graph::storage::open_workspace_db(&root_for_migration)
            .map_err(|e| format!("Failed to open workspace DB for v2 migration: {e}"))?;
        agent::migrations::ensure_v2_columns(&conn)
            .map_err(|e| format!("Failed to apply v2 thread migration: {e}"))?;
        agent::migrations::ensure_model_id_column(&conn)
            .map_err(|e| format!("Failed to apply v3 model_id migration: {e}"))?;
        Ok(())
    })?;

    let db_path = graph::storage::bonafide_dir()
        .join(&hash)
        .join("store.db")
        .to_string_lossy()
        .to_string();

    let storage = Storage::new(root);

    // Store in app state
    {
        let mut map = storage_state.write().await;
        map.insert(hash.clone(), storage);
    }

    // Emit event so renderer knows workspace is open
    let _ = app.emit("workspace://opened", serde_json::json!({ "hash": &hash }));

    // Check if tracker is connected for this workspace.
    // `mut` because we re-evaluate below after MLflow rehydration from
    // the keyring — a freshly-rehydrated provider should count as a
    // connected tracker for both the background sync spawn and the
    // `Workspace.hasTracker` payload returned to the renderer.
    let mut has_tracker = tracker::wandb::is_tracker_connected(&hash).await
        || tracker::mlflow::is_mlflow_connected(&hash).await;

    // Auto-rehydrate any MLflow provider that has stored credentials in
    // the keyring but isn't currently in the in-memory registry. This
    // covers the post-restart reconnect path: the user opened Bonafide
    // and connected to MLflow, quit, relaunched, and now opens the same
    // workspace. Without this hook the keyring entry sits unused and the
    // user has to go through `connect_tracker` again. `load_mlflow_from_keyring`
    // is a no-op when no entry exists, and only registers a provider
    // when rehydration succeeds — a stale entry with a dead server
    // just logs a warning and the user keeps the original error path.
    // The provider is inserted into `MLFLOW_REGISTRY` inside the
    // function itself, so we just drop the returned handle here.
    if !tracker::mlflow::is_mlflow_connected(&hash).await {
        match tracker::mlflow::load_mlflow_from_keyring(&hash).await {
            Ok(Some(_provider)) => {
                log::info!(
                    "[tracker] rehydrated MLflow provider for workspace {hash}"
                );
            }
            Ok(None) => { /* no keyring entry — nothing to do */ }
            Err(e) => {
                log::warn!("[tracker] failed to rehydrate MLflow provider: {e}");
            }
        }
    }

    // Recompute `has_tracker` after the rehydration step above. The
    // initial check on line ~494 runs before rehydration, so a
    // workspace that was previously connected to MLflow but lost its
    // in-memory provider on restart would have captured `false` here.
    // Without this re-evaluation, both the background sync spawn and
    // the `Workspace.hasTracker` returned to the renderer would
    // incorrectly report "no tracker" for a workspace whose
    // credentials were just successfully restored from the keyring.
    has_tracker = tracker::wandb::is_tracker_connected(&hash).await
        || tracker::mlflow::is_mlflow_connected(&hash).await;

    // If a tracker is connected, kick off a background run-graph sync.
    // We never block `open_workspace` on the network — the renderer
    // subscribes to `run_graph://synced` for incremental updates.
    if has_tracker {
        let root_for_sync = PathBuf::from(&path);
        let hash_for_sync = hash.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = run_background_sync(&root_for_sync, &hash_for_sync).await {
                log::warn!("[run_graph] background sync failed: {e}");
            }
        });
    }

    Ok(Workspace {
        root: path,
        hash,
        db_path,
        has_tracker,
    })
}

#[tauri::command]
async fn list_workspaces(
    storage_state: State<'_, StorageState>,
) -> Result<Vec<WorkspaceSummary>, String> {
    let map = storage_state.read().await;
    let summaries: Vec<WorkspaceSummary> = map.iter()
        .map(|(hash, storage)| {
            WorkspaceSummary {
                root: storage.root_path()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default(),
                hash: hash.clone(),
                last_opened: storage.last_opened_ts(),
            }
        })
        .collect();
    Ok(summaries)
}

// ── Phase 0: Tracker commands ────────────────────────────────────────────────
//
// These commands are the public IPC surface for tracker providers. The
// `kind` parameter (currently `"wandb"` or `"mlflow"`) selects the
// implementation; the workspace-root / workspace-hash pair is used to
// look up the right provider in the per-kind registry. All command
// bodies live in this file, dispatching to the matching free function
// in `tracker::{wandb,mlflow}`.

/// Validate the renderer-supplied tracker `kind` string up front so
/// each command doesn't have to repeat the unknown-kind error arm.
///
/// Returns the input slice unchanged when it's a supported kind so
/// callers can match on it directly without an extra clone.
fn dispatch_kind(kind: &str) -> Result<&str, tracker::TrackerError> {
    match kind {
        "wandb" | "mlflow" => Ok(kind),
        other => Err(tracker::TrackerError {
            kind: tracker::TrackerErrorKind::Unknown,
            message: format!("Unsupported tracker kind: {other}"),
            hint: Some("Supported trackers: wandb, mlflow".to_string()),
        }),
    }
}

/// JSON payload the renderer sends for an MLflow `connect_tracker`
/// invocation. The renderer's `api_key` field is overloaded: for
/// W&B it's the plain API key string, for MLflow we parse it as this
/// struct. Using camelCase matches the renderer-side TypeScript types.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MlflowConnectPayload {
    base_url: String,
    #[serde(default)]
    token: Option<String>,
    project: String,
}

#[tauri::command]
async fn connect_tracker(
    kind: String,
    api_key: String,
    workspace_root: String,
    project: Option<String>,  // NEW: optional project for W&B
) -> Result<String, tracker::TrackerError> {
    let validated = dispatch_kind(&kind)?;
    let root = PathBuf::from(&workspace_root);

    // Resolve `hash` and `project_for_sync` per provider. The connect
    // call returns the workspace hash; the project name is extracted
    // from the per-provider input (MLflow's JSON payload, or the new
    // `project` argument for W&B).
    let (hash, project_for_sync) = match validated {
        "wandb" => {
            let h = tracker::wandb::connect_tracker(&root, &api_key).await?;
            let p = project.clone().unwrap_or_default();
            (h, p)
        }
        "mlflow" => {
            // For MLflow, `api_key` is actually a JSON string of the form
            // `{"baseUrl": "...", "token": "...", "project": "..."}`.
            let payload: MlflowConnectPayload =
                serde_json::from_str(&api_key).map_err(|e| tracker::TrackerError {
                    kind: tracker::TrackerErrorKind::AuthFailed,
                    message: format!(
                        "Invalid MLflow connect payload (expected JSON with baseUrl, project): {e}"
                    ),
                    hint: Some(
                        "For MLflow, connect_tracker expects a JSON object — for W&B, a plain key."
                            .to_string(),
                    ),
                })?;
            let h = tracker::mlflow::connect_mlflow(
                &root,
                payload.base_url,
                payload.token,
                payload.project.clone(),
            )
            .await?;
            (h, payload.project)
        }
        // dispatch_kind validated the kind above, so this arm is unreachable.
        _ => unreachable!("dispatch_kind validated the kind"),
    };

    // Persist the connection (kind + project) so `run_background_sync`
    // can scope its W&B / MLflow query to the right project. A
    // serialization failure or DB error here is logged but does not
    // fail the connect — the in-memory provider is already live.
    let config_json = serde_json::to_string(&serde_json::json!({
        "project": project_for_sync,
    }))
    .map_err(|e| tracker::TrackerError {
        kind: tracker::TrackerErrorKind::Unknown,
        message: format!("config serialize failed: {e}"),
        hint: None,
    })?;

    let root_for_persist = PathBuf::from(&workspace_root);
    let hash_for_persist = hash.clone();
    let kind_for_persist = kind.clone();
    let result_persist = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let (conn, _) = graph::storage::open_workspace_db(&root_for_persist)
            .map_err(|e| format!("Failed to open workspace DB: {e}"))?;
        graph::storage::upsert_tracker_connection(
            &conn,
            &hash_for_persist,
            &kind_for_persist,
            &config_json,
        )
        .map_err(|e| format!("Failed to upsert tracker connection: {e}"))
    })
    .await;

    // The outer Result is from the JoinHandle (spawn failure / panic),
    // the inner Result is from the closure (persistence error). Both
    // layers must be inspected — the previous `if let Err(e)` pattern
    // only matched the JoinError and silently dropped inner failures,
    // so a real persistence error would never reach the log.
    // `kind_for_persist` / `hash_for_persist` are moved into the
    // closure above, so the outer scope only sees the still-owned
    // `kind` / `hash` here.
    match result_persist {
        Ok(Ok(())) => {
            log::info!("[tracker] persistence ok for {kind} hash={hash}");
        }
        Ok(Err(e)) => log::error!("[tracker] persistence failed: {e}"),
        Err(join_err) => log::error!("[tracker] persistence task panicked: {join_err}"),
    }

    // Kick off a background run-graph sync so the graph is populated
    // as soon as the user connects. Errors are logged but not
    // propagated — a sync failure must never prevent a successful
    // connect from being reported to the renderer.
    let root_for_sync = PathBuf::from(&workspace_root);
    let hash_for_sync = hash.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_background_sync(&root_for_sync, &hash_for_sync).await {
            log::warn!("[run_graph] post-connect sync failed: {e}");
        }
    });

    Ok(hash)
}

#[tauri::command]
async fn disconnect_tracker(
    kind: String,
    workspace_root: String,
) -> Result<(), tracker::TrackerError> {
    let validated = dispatch_kind(&kind)?;
    let root = PathBuf::from(&workspace_root);
    match validated {
        "wandb" => tracker::wandb::disconnect_tracker(&root).await,
        "mlflow" => tracker::mlflow::disconnect_mlflow(&root).await,
        _ => unreachable!("dispatch_kind validated the kind"),
    }
}

#[tauri::command]
async fn test_tracker_connection(
    kind: String,
    workspace_root: String,
) -> Result<tracker::TrackerStatus, tracker::TrackerError> {
    let validated = dispatch_kind(&kind)?;
    let root = PathBuf::from(&workspace_root);
    let hash = compute_workspace_hash(&root);
    match validated {
        "wandb" => tracker::wandb::test_tracker_connection(&hash).await,
        "mlflow" => {
            let provider = tracker::mlflow::get_mlflow_provider(&hash).await.ok_or_else(|| {
                tracker::TrackerError {
                    kind: tracker::TrackerErrorKind::NotFound,
                    message: "No MLflow tracker connected for this workspace".into(),
                    hint: Some("Call connect_tracker with kind=\"mlflow\" first.".into()),
                }
            })?;
            let start = std::time::Instant::now();
            provider.ping().await?;
            let latency_ms = start.elapsed().as_millis() as u64;
            Ok(tracker::TrackerStatus::ok(latency_ms))
        }
        _ => unreachable!("dispatch_kind validated the kind"),
    }
}

// ── Run-level tracker commands (per-kind dispatch) ─────────────────────────
//
// Each command takes `kind` so the renderer can pick which provider
// dispatches the request. Both providers share the canonical renderer
// types (`RunPage`, `RunDetail`, `RunConfig`, `Point`, `ArtifactRef`),
// so the wire shape is identical between wandb and mlflow.
//
// We compute the workspace hash up front; the registry helpers
// (`get_wandb_provider`, `get_mlflow_provider`) look up by hash.

#[tauri::command]
async fn list_runs(
    kind: String,
    workspace_root: String,
    project: String,
    limit: u32,
    cursor: Option<String>,
) -> Result<tracker::wandb::RunPage, tracker::TrackerError> {
    let validated = dispatch_kind(&kind)?;
    let root = PathBuf::from(&workspace_root);
    let hash = compute_workspace_hash(&root);
    match validated {
        "wandb" => {
            let provider = tracker::wandb::get_wandb_provider(&hash).await.ok_or_else(|| {
                tracker::TrackerError {
                    kind: tracker::TrackerErrorKind::NotFound,
                    message: "No W&B tracker connected for this workspace".into(),
                    hint: Some("Call connect_tracker with kind=\"wandb\" first.".into()),
                }
            })?;
            provider.list_runs(&project, limit, cursor.as_deref()).await
        }
        "mlflow" => {
            let provider = tracker::mlflow::get_mlflow_provider(&hash).await.ok_or_else(|| {
                tracker::TrackerError {
                    kind: tracker::TrackerErrorKind::NotFound,
                    message: "No MLflow tracker connected for this workspace".into(),
                    hint: Some("Call connect_tracker with kind=\"mlflow\" first.".into()),
                }
            })?;
            provider.list_runs(&project, limit, cursor.as_deref()).await
        }
        _ => unreachable!("dispatch_kind validated the kind"),
    }
}

#[tauri::command]
async fn get_run(
    kind: String,
    workspace_root: String,
    run_id: String,
) -> Result<tracker::wandb::RunDetail, tracker::TrackerError> {
    let validated = dispatch_kind(&kind)?;
    let root = PathBuf::from(&workspace_root);
    let hash = compute_workspace_hash(&root);
    match validated {
        "wandb" => {
            let provider = tracker::wandb::get_wandb_provider(&hash).await.ok_or_else(|| {
                tracker::TrackerError {
                    kind: tracker::TrackerErrorKind::NotFound,
                    message: "No W&B tracker connected for this workspace".into(),
                    hint: None,
                }
            })?;
            provider.get_run(&run_id).await
        }
        "mlflow" => {
            let provider =
                tracker::mlflow::get_mlflow_provider(&hash).await.ok_or_else(|| {
                    tracker::TrackerError {
                        kind: tracker::TrackerErrorKind::NotFound,
                        message: "No MLflow tracker connected for this workspace".into(),
                        hint: None,
                    }
                })?;
            provider.get_run(&run_id).await
        }
        _ => unreachable!("dispatch_kind validated the kind"),
    }
}

#[tauri::command]
async fn get_metric_series(
    kind: String,
    workspace_root: String,
    run_id: String,
    key: String,
) -> Result<Vec<tracker::wandb::Point>, tracker::TrackerError> {
    let validated = dispatch_kind(&kind)?;
    let root = PathBuf::from(&workspace_root);
    let hash = compute_workspace_hash(&root);
    match validated {
        "wandb" => {
            let provider = tracker::wandb::get_wandb_provider(&hash).await.ok_or_else(|| {
                tracker::TrackerError {
                    kind: tracker::TrackerErrorKind::NotFound,
                    message: "No W&B tracker connected for this workspace".into(),
                    hint: None,
                }
            })?;
            provider.get_metric_series(&run_id, &key).await
        }
        "mlflow" => {
            let provider =
                tracker::mlflow::get_mlflow_provider(&hash).await.ok_or_else(|| {
                    tracker::TrackerError {
                        kind: tracker::TrackerErrorKind::NotFound,
                        message: "No MLflow tracker connected for this workspace".into(),
                        hint: None,
                    }
                })?;
            provider.get_metric_series(&run_id, &key).await
        }
        _ => unreachable!("dispatch_kind validated the kind"),
    }
}

#[tauri::command]
async fn get_run_config(
    kind: String,
    workspace_root: String,
    run_id: String,
) -> Result<tracker::wandb::RunConfig, tracker::TrackerError> {
    let validated = dispatch_kind(&kind)?;
    let root = PathBuf::from(&workspace_root);
    let hash = compute_workspace_hash(&root);
    match validated {
        "wandb" => {
            let provider = tracker::wandb::get_wandb_provider(&hash).await.ok_or_else(|| {
                tracker::TrackerError {
                    kind: tracker::TrackerErrorKind::NotFound,
                    message: "No W&B tracker connected for this workspace".into(),
                    hint: None,
                }
            })?;
            provider.get_run_config(&run_id).await
        }
        "mlflow" => {
            let provider =
                tracker::mlflow::get_mlflow_provider(&hash).await.ok_or_else(|| {
                    tracker::TrackerError {
                        kind: tracker::TrackerErrorKind::NotFound,
                        message: "No MLflow tracker connected for this workspace".into(),
                        hint: None,
                    }
                })?;
            provider.get_run_config(&run_id).await
        }
        _ => unreachable!("dispatch_kind validated the kind"),
    }
}

#[tauri::command]
async fn list_artifacts(
    kind: String,
    workspace_root: String,
    run_id: String,
) -> Result<Vec<tracker::wandb::ArtifactRef>, tracker::TrackerError> {
    let validated = dispatch_kind(&kind)?;
    let root = PathBuf::from(&workspace_root);
    let hash = compute_workspace_hash(&root);
    match validated {
        "wandb" => {
            let provider = tracker::wandb::get_wandb_provider(&hash).await.ok_or_else(|| {
                tracker::TrackerError {
                    kind: tracker::TrackerErrorKind::NotFound,
                    message: "No W&B tracker connected for this workspace".into(),
                    hint: None,
                }
            })?;
            provider.list_artifacts(&run_id).await
        }
        "mlflow" => {
            let provider =
                tracker::mlflow::get_mlflow_provider(&hash).await.ok_or_else(|| {
                    tracker::TrackerError {
                        kind: tracker::TrackerErrorKind::NotFound,
                        message: "No MLflow tracker connected for this workspace".into(),
                        hint: None,
                    }
                })?;
            provider.list_artifacts(&run_id).await
        }
        _ => unreachable!("dispatch_kind validated the kind"),
    }
}

// ── Phase 0+: Agent thread commands ─────────────────────────────────────────
//
// Reads/writes the `threads` table attached to the currently-open
// workspace DB. Renderer-side consumers (`useThreads`, `WorkflowPanel`)
// fall back to mock data when no workspace is open, so these commands
// only need to succeed inside an active Tauri session with an
// `open_workspace` call ahead of them.

#[tauri::command]
async fn list_threads(
    workspace_root: String,
    storage_state: State<'_, StorageState>,
) -> Result<Vec<agent::threads::ThreadRow>, String> {
    let hash = compute_workspace_hash(PathBuf::from(&workspace_root).as_path());
    let map = storage_state.read().await;
    let _storage = map.get(&hash)
        .ok_or_else(|| "Workspace not open. Call open_workspace first.".to_string())?;

    let root = PathBuf::from(&workspace_root);
    let (conn, _hash) = graph::storage::open_workspace_db(&root)
        .map_err(|e| format!("Failed to open workspace DB: {e}"))?;
    // WS1-T2: backward-compatible — pass `None` so the existing
    // inbox semantics (every thread for this workspace) are preserved.
    agent::threads::list_threads(&conn, &hash, None)
        .map_err(|e| format!("Failed to list threads: {e}"))
}

#[tauri::command]
async fn upsert_thread(
    row: agent::threads::ThreadRow,
    storage_state: State<'_, StorageState>,
) -> Result<(), String> {
    let root_path = {
        let map = storage_state.read().await;
        let storage = map.get(&row.workspace_hash)
            .ok_or_else(|| "Workspace not open. Call open_workspace first.".to_string())?;
        storage.root_path()
            .map(|p| p.to_path_buf())
            .ok_or_else(|| "Workspace root path missing".to_string())?
    };

    let (conn, _hash) = graph::storage::open_workspace_db(&root_path)
        .map_err(|e| format!("Failed to open workspace DB: {e}"))?;
    agent::threads::upsert_thread(&conn, &row)
        .map_err(|e| format!("Failed to upsert thread: {e}"))
}

// ── Phase 2: Experiment commands ────────────────────────────────────────────────
//
// Stripped in WS0-T1. Commands are kept as no-op stubs that return a
// structured "not yet implemented" error so the renderer's IPC client
// keeps resolving `bonafide.experiment.*`. Real implementations land
// in WS2-T4.

#[tauri::command]
#[allow(dead_code)]
async fn create_experiment(
    _row: serde_json::Value,
    _workspace_root: String,
) -> Result<(), String> {
    Err("Not yet implemented — wired in WS2-T4.".into())
}

#[tauri::command]
#[allow(dead_code)]
async fn list_experiments(
    _workspace_root: String,
) -> Result<Vec<serde_json::Value>, String> {
    Err("Not yet implemented — wired in WS2-T4.".into())
}

#[tauri::command]
#[allow(dead_code)]
async fn get_experiment(
    _workspace_root: String,
    _id: String,
) -> Result<Option<serde_json::Value>, String> {
    Err("Not yet implemented — wired in WS2-T4.".into())
}

#[tauri::command]
#[allow(dead_code)]
async fn update_experiment(
    _row: serde_json::Value,
    _workspace_root: String,
) -> Result<(), String> {
    Err("Not yet implemented — wired in WS2-T4.".into())
}

#[tauri::command]
#[allow(dead_code)]
async fn delete_experiment(
    _workspace_root: String,
    _id: String,
) -> Result<(), String> {
    Err("Not yet implemented — wired in WS2-T4.".into())
}

#[tauri::command]
#[allow(dead_code)]
async fn create_experiment_run(
    _row: serde_json::Value,
    _workspace_root: String,
) -> Result<(), String> {
    Err("Not yet implemented — wired in WS2-T4.".into())
}

#[tauri::command]
#[allow(dead_code)]
async fn list_experiment_runs(
    _workspace_root: String,
    _experiment_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    Err("Not yet implemented — wired in WS2-T4.".into())
}

#[tauri::command]
#[allow(dead_code)]
async fn update_experiment_run(
    _workspace_root: String,
    _id: String,
    _status: String,
    _metrics_summary: String,
) -> Result<(), String> {
    Err("Not yet implemented — wired in WS2-T4.".into())
}

// ── Phase 2: Budget commands ─────────────────────────────────────────────────
//
// Stripped in WS0-T1. Commands are kept as no-op stubs so the renderer's
// IPC client keeps resolving `bonafide.budget.*`. Real implementations
// land in WS2-T4.

/// `BudgetStatus` — the IPC response for `get_budget_status`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BudgetStatus {
    workspace_hash: String,
    budget_dollars: f64,
    budget_gpu_hours: f64,
    spent_dollars: f64,
    spent_gpu_hours: f64,
    escalation: String,
    spend_ratio: f64,
    requires_approval: bool,
    currency: String,
}

#[tauri::command]
async fn get_budget_status(
    workspace_root: String,
) -> Result<BudgetStatus, String> {
    log::warn!("[budget] get_budget_status: not yet implemented — wired in WS2-T4");
    let hash = compute_workspace_hash(PathBuf::from(&workspace_root).as_path());
    Ok(BudgetStatus {
        workspace_hash: hash,
        budget_dollars: 0.0,
        budget_gpu_hours: 0.0,
        spent_dollars: 0.0,
        spent_gpu_hours: 0.0,
        escalation: "normal".to_string(),
        spend_ratio: 0.0,
        requires_approval: false,
        currency: "USD".to_string(),
    })
}

#[tauri::command]
#[allow(dead_code)]
async fn update_budget(
    _workspace_root: String,
    _budget_dollars: f64,
    _budget_gpu_hours: f64,
    _budget_state: State<'_, BudgetState>,
) -> Result<serde_json::Value, String> {
    Err("Not yet implemented — wired in WS2-T4.".into())
}

#[tauri::command]
#[allow(dead_code)]
async fn record_tool_call(
    _workspace_root: String,
    _tool_name: String,
    _budget_state: State<'_, BudgetState>,
) -> Result<String, String> {
    Err("Not yet implemented — wired in WS2-T4.".into())
}

#[tauri::command]
#[allow(dead_code)]
async fn check_tool_permission(
    workspace_root: String,
    tool_name: String,
) -> Result<agent::engine::ToolPermission, String> {
    Ok(agent::engine::check_tool_permission(
        PathBuf::from(&workspace_root).as_path(),
        &tool_name,
    )
    .await)
}

// ── Phase 2: Planner commands ───────────────────────────────────────────────
//
// Stripped in WS0-T1. Commands are kept as no-op stubs so the renderer's
// IPC client keeps resolving `bonafide.agent.propose_experiment` (and
// `list_experiments_for_planner`). Real implementations land in WS4-T1.

#[tauri::command]
#[allow(dead_code)]
async fn propose_experiment(
    _workspace_root: String,
    _input: serde_json::Value,
    _budget_state: State<'_, BudgetState>,
) -> Result<serde_json::Value, String> {
    Err("Not yet implemented — wired in WS4-T1.".into())
}

/// List existing experiments so the planner can detect duplicates
/// before proposing a new one. Stub for WS0-T1.
#[tauri::command]
#[allow(dead_code)]
async fn list_experiments_for_planner(
    _workspace_root: String,
) -> Result<Vec<serde_json::Value>, String> {
    Err("Not yet implemented — wired in WS4-T1.".into())
}

// ── Phase 2: Scaffolder commands ────────────────────────────────────────────
//
// Stripped in WS0-T1. Commands are kept as no-op stubs so the renderer's
// IPC client keeps resolving `bonafide.agent.scaffold_script` and
// `bonafide.agent.run_smoke_test`. Real implementations land in WS4-T1.

#[tauri::command]
#[allow(dead_code)]
async fn scaffold_script(
    _workspace_root: String,
    _input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    Err("Not yet implemented — wired in WS4-T1.".into())
}

/// Run a Python script with a hard step limit for smoke testing.
/// Stub for WS0-T1 — the real implementation (process spawn + 60s
/// timeout) is reintroduced in WS4-T1.
#[tauri::command]
#[allow(dead_code)]
async fn run_smoke_test(
    _workspace_root: String,
    _script_path: String,
    _max_steps: Option<u32>,
) -> Result<serde_json::Value, String> {
    Err("Not yet implemented — wired in WS4-T1.".into())
}

// ── Phase 3: Project Memory, Researcher, Critic, Monitoring ──────────────────
//
// These commands bridge the Phase 3 renderer surfaces to the agent sub-modules.
// Stubs return sensible defaults; real implementations land in WS4-T2..T5.

// ── Critic: ML-specific code review ───────────────────────────────────────────

/// `CriticReview` wire type with camelCase fields expected by the frontend.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CriticReviewOutput {
    score: u8,
    issues: Vec<String>,
    recommendations: Vec<String>,
    verdict: String,
    summary: String,
    duration_ms: u64,
}

/// Run ML-specific code review on a diff. Wraps `critic::review_code`.
#[tauri::command]
async fn review_code(
    _workspace_root: String,
    _file_path: String,
    patch: String,
) -> Result<CriticReviewOutput, String> {
    let start = std::time::Instant::now();
    let review = agent::critic::review_code(&patch)
        .map_err(|e| format!("review_code failed: {e}"))?;

    let verdict = match review.verdict {
        agent::critic::Verdict::Approved => "pass",
        agent::critic::Verdict::NeedsRevision => "fail",
        agent::critic::Verdict::Blocked => "fail",
    };

    Ok(CriticReviewOutput {
        score: review.score,
        issues: review.issues.into_iter().map(|i| i.description).collect(),
        recommendations: review.recommendations,
        verdict: verdict.to_string(),
        summary: format!("score={}", review.score),
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

// ── Monitoring: Anomaly detection ────────────────────────────────────────────

/// `AnomalyEntry` wire type for the frontend.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AnomalyEntryOutput {
    metric: String,
    kind: String,
    description: String,
    severity: String,
    step: u64,
    value: f64,
}

/// `AnomalyReport` wire type for the frontend.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AnomalyReportOutput {
    run_id: String,
    anomalies: Vec<AnomalyEntryOutput>,
    summary: String,
}

/// Detect anomalies in a run's metric stream. Fetches metrics from the
/// tracker provider and passes them to `monitoring::detect_anomalies`.
#[tauri::command]
async fn detect_anomalies(
    workspace_root: String,
    run_id: String,
) -> Result<AnomalyReportOutput, String> {
    let hash = compute_workspace_hash(PathBuf::from(&workspace_root).as_path());
    let run_id_for_async = run_id.clone();

    let anomalies = tokio::task::block_in_place(move || -> Vec<agent::monitoring::Anomaly> {
        let rt = tokio::runtime::Handle::current();
        rt.block_on(agent::monitoring::detect_anomalies_for_run(&hash, &run_id_for_async))
    });

    let entries: Vec<AnomalyEntryOutput> = anomalies
        .iter()
        .map(|a| {
            let (kind, severity) = match a.anomaly_type {
                agent::monitoring::AnomalyType::Nan => ("spike", "high"),
                agent::monitoring::AnomalyType::LossSpike => ("spike", "medium"),
                agent::monitoring::AnomalyType::Divergence => ("drift", "high"),
                agent::monitoring::AnomalyType::Plateau => ("plateau", "low"),
            };
            AnomalyEntryOutput {
                metric: a.metric_name.clone(),
                kind: kind.to_string(),
                description: a.threshold_violated.clone(),
                severity: severity.to_string(),
                step: a.step,
                value: a.metric_value,
            }
        })
        .collect();

    let summary = if entries.is_empty() {
        "No anomalies detected".to_string()
    } else {
        format!("{} anomaly(ies) detected", entries.len())
    };

    Ok(AnomalyReportOutput {
        run_id,
        anomalies: entries,
        summary,
    })
}

// ── Proposal approval stubs ──────────────────────────────────────────────────

/// Stub for `approve_action`. The real implementation is wired in WS4-T1.
#[tauri::command]
async fn approve_action(
    thread_id: String,
    _patch_file: String,
    approved: bool,
    _rejection_reason: Option<String>,
) -> Result<serde_json::Value, String> {
    log::warn!("[ipc] approve_action({thread_id}, approved={approved}): stub — wired in WS4-T1");
    Ok(serde_json::json!({ "applied": approved }))
}

/// Stub for `reject_action`. The real implementation is wired in WS4-T1.
#[tauri::command]
async fn reject_action(
    thread_id: String,
    _reason: String,
) -> Result<serde_json::Value, String> {
    log::warn!("[ipc] reject_action({thread_id}): stub — wired in WS4-T1");
    Ok(serde_json::json!({ "done": true }))
}

// ── Project memory ───────────────────────────────────────────────────────────

/// `ProjectInsight` wire type for the frontend.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectInsightInput {
    workspace_hash: String,
    finding: String,
    evidence: String,
    confidence: String,
}

/// Query project memory entries by kind ("insight" | "dead_end").
#[tauri::command]
async fn query_project_memory(
    workspace_root: String,
    kind: String,
) -> Result<serde_json::Value, String> {
    let root = PathBuf::from(&workspace_root);
    let workspace_hash = compute_workspace_hash(root.as_path());
    let (conn, _hash) = graph::storage::open_workspace_db(&root)
        .map_err(|e| format!("Failed to open workspace DB: {e}"))?;

    // Initialise tables if they don't exist (idempotent).
    let _ = agent::memory::init_memory_tables(&conn);

    let memory_type = match kind.as_str() {
        "dead_end" => agent::memory::MemoryType::DeadEnd,
        _ => agent::memory::MemoryType::Insight,
    };

    let entries = agent::memory::query_project_memory(&conn, memory_type)
        .map_err(|e| format!("query_project_memory failed: {e}"))?;

    let formatted: Vec<serde_json::Value> = entries
        .iter()
        .map(|e| {
            serde_json::json!({
                "id": e.id.to_string(),
                "workspaceHash": workspace_hash,
                "finding": e.finding,
                "evidence": e.evidence,
                "confidence": if e.confidence >= 80 { "high" } else if e.confidence >= 50 { "medium" } else { "low" },
                "createdAt": e.expires_at * 1000,
            })
        })
        .collect();

    if memory_type == agent::memory::MemoryType::Insight {
        Ok(serde_json::json!({
            "insights": formatted,
            "deadEnds": Vec::<serde_json::Value>::new(),
        }))
    } else {
        Ok(serde_json::json!({
            "insights": Vec::<serde_json::Value>::new(),
            "deadEnds": formatted,
        }))
    }
}

/// Write a new project insight. Wraps `memory::write_project_memory`.
#[tauri::command]
async fn write_project_insight(
    workspace_root: String,
    insight: ProjectInsightInput,
) -> Result<serde_json::Value, String> {
    let root = PathBuf::from(&workspace_root);
    let (conn, _hash) = graph::storage::open_workspace_db(&root)
        .map_err(|e| format!("Failed to open workspace DB: {e}"))?;

    let _ = agent::memory::init_memory_tables(&conn);

    let confidence = match insight.confidence.as_str() {
        "high" => 90u8,
        "medium" => 60u8,
        _ => 30u8,
    };

    let expires_at = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 30 * 24 * 3600) as i64; // 30-day TTL

    let id = agent::memory::write_project_memory(
        &conn,
        agent::memory::MemoryType::Insight,
        &insight.finding,
        confidence,
        &insight.finding,
        &insight.evidence,
        expires_at,
    )
    .map_err(|e| format!("write_project_memory failed: {e}"))?;

    Ok(serde_json::json!({ "id": id.to_string() }))
}

// ── Phase 0: Code graph commands ────────────────────────────────────────────

#[tauri::command]
async fn index_code_graph(
    workspace_root: String,
    storage_state: State<'_, StorageState>,
) -> Result<graph::code_graph::IndexSummary, String> {
    let hash = compute_workspace_hash(PathBuf::from(&workspace_root).as_path());
    let map = storage_state.read().await;
    let _storage = map.get(&hash)
        .ok_or_else(|| "Workspace not open. Call open_workspace first.".to_string())?;

    let root = PathBuf::from(&workspace_root);
    let (conn, _hash) = graph::storage::open_workspace_db(&root)
        .map_err(|e| format!("Failed to open workspace DB: {e}"))?;
    graph::code_graph::index_code_graph(&conn, &root)
}

#[tauri::command]
async fn query_code_graph(
    query: String,
    workspace_root: String,
    storage_state: State<'_, StorageState>,
) -> Result<Vec<graph::code_graph::CodeGraphHit>, String> {
    let hash = compute_workspace_hash(PathBuf::from(&workspace_root).as_path());
    let map = storage_state.read().await;
    let _storage = map.get(&hash)
        .ok_or_else(|| "Workspace not open. Call open_workspace first.".to_string())?;

    let root = PathBuf::from(&workspace_root);
    let (conn, _hash) = graph::storage::open_workspace_db(&root)
        .map_err(|e| format!("Failed to open workspace DB: {e}"))?;
    graph::code_graph::query_code_graph(&query, &conn)
}

// ── Phase 1: Run graph commands ────────────────────────────────────────────

/// Query the run-graph for nodes matching an optional `framework` and
/// `dataset` filter. Both filters are ANDed; passing `None` for both
/// returns every node, newest-first.
///
/// Requires the workspace to be open (`open_workspace` was called for
/// `workspace_root` this session) so the `StorageState` map has an
/// entry; without it the command returns a descriptive error.
#[tauri::command]
async fn query_run_graph(
    workspace_root: String,
    framework: Option<String>,
    dataset: Option<String>,
    storage_state: State<'_, StorageState>,
) -> Result<Vec<graph::run_graph::RunGraphNode>, String> {
    let hash = compute_workspace_hash(PathBuf::from(&workspace_root).as_path());
    let map = storage_state.read().await;
    let _storage = map.get(&hash)
        .ok_or_else(|| "Workspace not open. Call open_workspace first.".to_string())?;

    let root = PathBuf::from(&workspace_root);
    let (conn, _hash) = graph::storage::open_workspace_db(&root)
        .map_err(|e| format!("Failed to open workspace DB: {e}"))?;
    graph::run_graph::query_run_graph(
        &conn,
        framework.as_deref(),
        dataset.as_deref(),
    )
    .map_err(|e| format!("Failed to query run graph: {e}"))
}

/// Run a background sync of the run graph for `workspace_hash` against
/// whichever tracker provider is currently registered for it. Dispatches
/// to W&B and/or MLflow based on registry membership; returns `Err` if
/// no tracker is registered or if the sync itself fails.
///
/// The workspace DB is opened **once** and that connection is shared
/// across the config read and the sync functions — both
/// `sync_from_wandb` and `sync_from_mlflow` accept a borrowed
/// `Connection` now. All SQLite work runs inside `block_in_place` so
/// the non-`Send` handle never crosses an `.await` boundary.
async fn run_background_sync(root: &Path, workspace_hash: &str) -> Result<(), String> {
    // Decide which providers to use without holding a DB connection.
    let wandb = tracker::wandb::get_wandb_provider(workspace_hash).await;
    let mlflow = tracker::mlflow::get_mlflow_provider(workspace_hash).await;

    if wandb.is_none() && mlflow.is_none() {
        return Err("No tracker provider is registered for this workspace".to_string());
    }

    // Open the DB once, read the configured project, then run the
    // sync functions — all on the blocking pool so we can hold a
    // `Connection` across both phases.
    let root_owned = root.to_path_buf();
    let hash_owned = workspace_hash.to_string();
    tokio::task::block_in_place(move || -> Result<(), String> {
        let (conn, _hash) = graph::storage::open_workspace_db(&root_owned)
            .map_err(|e| format!("Failed to open workspace DB: {e}"))?;

        // Read the persisted connection record for the project scope.
        // Falls back to an empty string when no project is recorded
        // (e.g. for W&B, which doesn't store a project in
        // `tracker_connection.config_json`).
        let project: String = match graph::storage::get_tracker_connection(&conn, &hash_owned)
            .map_err(|e| format!("Failed to read tracker_connection: {e}"))?
        {
            Some((_kind, config_json)) => {
                serde_json::from_str::<serde_json::Value>(&config_json)
                    .ok()
                    .and_then(|v| {
                        v.get("project")
                            .and_then(|p| p.as_str().map(String::from))
                    })
                    .unwrap_or_default()
            }
            None => String::new(),
        };

        // Drive the async sync functions on this blocking-pool thread.
        // `block_on` from inside `block_in_place` is safe because
        // `Handle::current()` is the multi-thread tokio runtime that
        // spawned this worker; the future's HTTP I/O yields to the
        // reactor and we resume once it completes.
        let runtime = tokio::runtime::Handle::current();

        if let Some(provider) = wandb {
            runtime
                .block_on(graph::run_graph::sync_from_wandb(
                    &hash_owned,
                    &project,
                    &conn,
                    &provider,
                ))
                .map_err(|e| format!("W&B sync failed: {e}"))?;
        }
        if let Some(provider) = mlflow {
            runtime
                .block_on(graph::run_graph::sync_from_mlflow(
                    &hash_owned,
                    &project,
                    &conn,
                    &provider,
                ))
                .map_err(|e| format!("MLflow sync failed: {e}"))?;
        }

        Ok(())
    })
}

// Re-exports the git_service module for the integration test in
// `tests/git_smoke.rs`. This is the canonical pattern for exposing
// internal modules to tests without making them part of the public
// lib.rs API surface (which would require every function to be
// `pub` at the top level).
#[doc(hidden)]
pub mod git_service_for_tests {
    pub use crate::git_service::*;
}

// Re-exports the tracker module's MLflow parse/mapping helpers for the
// integration tests in `tests/tracker_roundtrip.rs`. Without this module
// the snake_case `MlflowRun` / `MlflowRunInfo` / mapping functions are
// unreachable from `tests/…` because they live below the
// `pub mod tracker { ... }` visibility boundary.
#[doc(hidden)]
pub mod tracker_for_tests {
    pub use crate::tracker::error::{TrackerError, TrackerErrorKind};
    pub use crate::tracker::mlflow::{
        run_to_detail, run_to_summary, ExperimentRef, GetExperimentByNameResponse,
        GetHistoryRequest, GetRunRequest, GetRunResponse, ListArtifactsRequest,
        ListArtifactsResponse, MetricHistoryEntry, MlflowArtifactFile, MlflowMetric,
        MlflowParam, MlflowRun, MlflowRunData, MlflowRunInfo, MlflowTag, MlflowProvider,
        SearchRunsRequest, SearchRunsResponse,
    };
    pub use crate::tracker::wandb::{
        ArtifactRef, Point, RunConfig, RunDetail, RunPage, RunSummary,
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .init();

    tauri::Builder::default()
        // Tauri 2 splits each capability into its own plugin crate.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            read_directory,
            read_file,
            write_file,
            create_file,
            create_folder,
            rename_path,
            delete_path,
            start_watcher,
            stop_watcher,
            get_lsp_bridge_url,
            get_lsp_servers,
            stop_lsp_server,
            ruff_check,
            get_pty_ws_url,
            list_terminal_profiles,
            git_status,
            git_list_branches,
            git_log,
            git_diff,
            git_add,
            git_unstage,
            git_discard,
            git_commit,
            git_checkout,
            git_pull,
            git_push,
            git_fetch,
            git_init,
            open_workspace,
            list_workspaces,
            connect_tracker,
            disconnect_tracker,
            test_tracker_connection,
            list_runs,
            get_run,
            get_metric_series,
            get_run_config,
            list_artifacts,
            index_code_graph,
            query_code_graph,
            query_run_graph,
            list_threads,
            upsert_thread,
            create_experiment,
            list_experiments,
            get_experiment,
            update_experiment,
            delete_experiment,
            create_experiment_run,
            list_experiment_runs,
            update_experiment_run,
            get_budget_status,
            update_budget,
            record_tool_call,
            check_tool_permission,
            propose_experiment,
            list_experiments_for_planner,
            scaffold_script,
            run_smoke_test,
            // Phase 3 (WS3-T4..T5): Critic, Monitoring, Memory, Proposal approval
            review_code,
            detect_anomalies,
            approve_action,
            reject_action,
            query_project_memory,
            write_project_insight,
            // Phase 2 (WS2-T5): Agent loop IPC commands
            agent::ipc::agent_send_message,
            agent::ipc::agent_stop_thread,
            agent::ipc::agent_approve_action,
            agent::ipc::agent_reject_action,
            // Phase 0.0: Settings store, Python detect, GPU detect, App info
            commands::settings::get_settings,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::set_settings,
            commands::python_detect::detect_python,
            commands::python_detect::list_python_packages,
            commands::gpu_detect::detect_gpus,
            commands::gpu_detect::get_gpu_visibility,
            commands::app_info::get_app_info,
            commands::app_info::get_cache_size,
            commands::app_info::clear_cache,
            commands::app_info::open_in_folder,
            // Phase 0.0: Recent workspaces (P0-T4)
            commands::workspace::list_recent_workspaces,
            commands::workspace::get_recent_workspace,
            commands::workspace::add_recent_workspace,
            // Phase 0.0: Tracker / Services / User profile probes (P0-T5)
            commands::tracker::get_tracker_status,
            commands::tracker::get_tracker_config,
            commands::tracker::list_services,
            commands::tracker::get_user_profile,
        ])
        .setup(|app| {
            // Tauri 2 has a subtle race: `visible: true` shows the
            // window before the webview has painted, causing a white
            // flash. The Electron build worked around this with a
            // `ready-to-show` event, but on Tauri's webview that
            // event can fire before `setup()` runs, leaving the
            // window invisible. The reliable pattern is to keep the
            // window hidden until the renderer signals readiness via
            // a one-shot `app:ready` invoke, then show it. For now
            // we just log + show it — the brief flash on cold start
            // is fine for an internal IDE.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }

            // ── LSP bridge setup ─────────────────────────────────────────
            // Store the shared LSP process map in Tauri app state so all
            // command handlers (synchronous or async) can access it via
            // `State<ProcessMap>`.
            let processes: lsp_bridge::ProcessMap =
                Arc::new(RwLock::new(HashMap::new()));
            app.manage(processes.clone());

            // ── File watcher setup ────────────────────────────────────────
            // Stores the notify watcher. Commands `start_watcher` and
            // `stop_watcher` mutate it via Arc<AsyncMutex>; the watcher
            // emits Tauri events directly to the renderer.
            let watcher_state: fs_watcher::WatcherState =
                Arc::new(tokio::sync::Mutex::new(fs_watcher::FsWatcherState::default()));
            app.manage(watcher_state);

            // ── Phase 0: Per-workspace storage state ────────────────────
            // Stores the rusqlite Connection + metadata for each open workspace,
            // keyed by workspace hash. Command handlers access it via
            // `State<StorageState>`.
            let storage_state: StorageState =
                Arc::new(RwLock::new(HashMap::new()));
            app.manage(storage_state);

            // ── Phase 2: Per-workspace budget state ────────────────────
            // Stripped in WS0-T1. We still register a `()` placeholder so
            // the `manage()` call type-checks against `BudgetState` in the
            // stubbed commands. The real BudgetRegistry is reintroduced in
            // WS2-T4.
            let budget_state: BudgetState = ();
            app.manage(budget_state);

            // ── WS2-T5: Agent state (per-workspace engine cache) ──────────
            // Holds the cached `ToolRegistry`, `ApprovalGate`, and budget
            // governor for each open workspace so the renderer can hit
            // `agent_send_message` / `agent_stop_thread` / approval commands
            // without rebuilding the registry each call.
            let agent_state: Arc<agent::ipc::AgentState> =
                Arc::new(agent::ipc::AgentState::new());
            app.manage(agent_state);

            // Start the WebSocket LSP bridge on port 9877.
            // This relay server accepts connections from the browser
            // (@marimo-team/codemirror-languageserver WebSocketTransport)
            // and forwards JSON-RPC messages to/from LSP server child processes.
            //
            // We dispatch the spawn through `tauri::async_runtime::spawn`,
            // which runs on Tauri's internal Tokio runtime — `block_on`
            // from the synchronous setup() closure would panic with
            // "there is no reactor running". Tauri's async_runtime is a
            // tokio runtime under the hood, so all our `tokio::*` awaits
            // inside `start_bridge` and the relay tasks work correctly.
            let port: u16 = 9877;
            tauri::async_runtime::spawn(async move {
                let bridge_url = lsp_bridge::start_bridge(port, processes).await;
                log::info!("[lsp] Bridge WebSocket URL: {bridge_url}");
            });

            // ── PTY bridge setup ─────────────────────────────────────────
            // Detect available shell profiles at startup, store them in
            // app state so the renderer's `list_terminal_profiles` command
            // can return them synchronously, and start the WS bridge on
            // port 9878. Each new WS connection runs its own PTY session;
            // the profile is chosen by the renderer's hello handshake.
            let profiles: pty_bridge::ProfileRegistry = pty_bridge::detect_profiles();
            log::info!(
                "[pty] Detected {} terminal profiles: {:?}",
                profiles.len(),
                profiles.iter().map(|p| format!("{}{}", p.id, if p.available { "" } else { " (missing)" })).collect::<Vec<_>>()
            );
            app.manage(profiles.clone());

            let pty_port: u16 = 9878;
            let profiles_for_bridge = profiles.clone();
            tauri::async_runtime::spawn(async move {
                let pty_url = pty_bridge::start_pty_bridge(pty_port, profiles_for_bridge).await;
                log::info!("[pty] Bridge WebSocket URL: {pty_url}");
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Bonafide");
}
