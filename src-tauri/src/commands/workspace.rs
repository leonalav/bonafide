// commands/workspace.rs — Recent workspace tracking for the Preferences →
// Account section's "Recent" list. Persists a JSON record at
// `~/.bonafide/recent_workspaces.json` so the same list survives restarts.
//
// We use a plain JSON file (no DB) because the surface is tiny:
// at most a few dozen entries, written rarely. Using SQLite here
// would add an extra lock target without giving us anything in
// return — JSON round-trips in <100µs for a handful of entries.
//
// Note: this is distinct from `src-tauri/src/workspace::*` (the
// workspace opener + storage map) and from the storage layer in
// `graph::storage`. The `recent_workspaces.json` is a UI-only cache:
// the source of truth for what counts as "open" still lives in the
// app's per-workspace `StorageState` map.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// One row in `~/.bonafide/recent_workspaces.json`.
///
/// The renderer reads these via `list_recent_workspaces` and shows
/// them in the Preferences → Account → Workspace card. The
/// `lastOpened` field is an ISO-8601 string (rather than unix millis)
/// so the file is human-inspectable from a shell without a JSON
/// re-format step. The renderer's `formatRelativeTime()` parses it
/// back into a JS `Date`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentWorkspace {
    pub path: String,
    pub last_opened: String,
    pub run_count: u32,
}

/// Path to the recent-workspaces JSON file: `~/.bonafide/recent_workspaces.json`.
fn recent_workspaces_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".bonafide")
        .join("recent_workspaces.json")
}

/// Ensure the `.bonafide/` directory exists before writing.
fn ensure_bonafide_dir() -> std::io::Result<()> {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".bonafide");
    fs::create_dir_all(dir)
}

/// Load the recent-workspaces list from disk. Returns an empty Vec
/// when the file doesn't exist (first run) or when parsing fails
/// (corrupt file — we surface the corruption via the empty default
/// rather than panicking, since the file is a UI cache and can be
/// rebuilt by the user just opening folders again).
fn load_recent() -> Vec<RecentWorkspace> {
    let path = recent_workspaces_path();
    match fs::read_to_string(&path) {
        Ok(contents) => {
            serde_json::from_str(&contents).unwrap_or_default()
        }
        Err(_) => Vec::new(),
    }
}

/// Persist the recent-workspaces list to disk atomically.
///
/// We write to `recent_workspaces.json.tmp` first then rename — a
/// partial write (e.g. process kill mid-write) on the rename target
/// would otherwise leave a truncated/corrupt JSON file. The rename
/// is atomic on POSIX and Windows NTFS, so a reader either sees the
/// old file or the new one, never a half-written file.
fn save_recent(items: &[RecentWorkspace]) -> Result<(), String> {
    ensure_bonafide_dir().map_err(|e| format!("Failed to create .bonafide/: {e}"))?;
    let path = recent_workspaces_path();
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(items)
        .map_err(|e| format!("Failed to serialize recent workspaces: {e}"))?;
    fs::write(&tmp, json).map_err(|e| format!("Failed to write recent workspaces: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("Failed to rename recent workspaces: {e}"))?;
    Ok(())
}

// ── Tauri commands ────────────────────────────────────────────────────────

/// List all recent workspaces, newest-first. Returns `[]` on first run.
#[tauri::command]
pub fn list_recent_workspaces() -> Vec<RecentWorkspace> {
    load_recent()
}

/// Look up a single recent workspace by its path.
///
/// Returns `None` when the path is not in the recent list. The
/// renderer calls this to populate the "active workspace" card
/// header (path + relative "last opened" label) when it knows which
/// workspace is currently open.
#[tauri::command]
pub fn get_recent_workspace(path: String) -> Option<RecentWorkspace> {
    load_recent().into_iter().find(|w| w.path == path)
}

/// Insert or update a recent workspace entry. If `path` already
/// exists, its `lastOpened` is refreshed to "now" and `runCount` is
/// incremented; otherwise a new entry is prepended. After the
/// mutation the list is persisted.
///
/// We expose this as a Tauri command rather than calling it from
/// `open_workspace` directly because the renderer drives the
/// "active workspace" lifecycle (it knows when a folder is opened
/// from the picker, from a "Recent" click, or from a CLI arg) and
/// we want the recent list to stay in sync with whichever path the
/// user actually committed to.
#[tauri::command]
pub fn add_recent_workspace(path: String) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut items = load_recent();

    if let Some(existing) = items.iter_mut().find(|w| w.path == path) {
        existing.last_opened = now;
        existing.run_count = existing.run_count.saturating_add(1);
    } else {
        items.insert(
            0,
            RecentWorkspace {
                path,
                last_opened: now,
                run_count: 1,
            },
        );
    }

    save_recent(&items)
}
