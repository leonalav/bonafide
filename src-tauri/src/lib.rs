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

use serde::Serialize;
use tauri::{Manager, State};
use tokio::sync::RwLock;
use walkdir::WalkDir;

mod lsp_bridge;
mod pty_bridge;
mod fs_watcher;
mod git_service;
mod graph;
mod agent;
mod shim;

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

// Re-exports the git_service module for the integration test in
// `tests/git_smoke.rs`. This is the canonical pattern for exposing
// internal modules to tests without making them part of the public
// lib.rs API surface (which would require every function to be
// `pub` at the top level).
#[doc(hidden)]
pub mod git_service_for_tests {
    pub use crate::git_service::*;
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
