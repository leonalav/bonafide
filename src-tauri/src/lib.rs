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

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;
use walkdir::WalkDir;

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

// ── App lifecycle ────────────────────────────────────────────────────────

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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Bonafide");
}
