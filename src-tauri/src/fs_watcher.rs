// fs_watcher.rs — Real-time file-system watcher.
//
// Uses the `notify` crate to watch the workspace directory for changes.
// When files are created, modified, renamed, or deleted, we emit Tauri
// events that the React frontend subscribes to and uses to update the
// file tree in real-time without re-scanning the whole directory.
//
// The watcher is started in `lib.rs` when a workspace is opened and
// stopped when the workspace changes or the app closes.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use notify::event::{Event, EventKind, ModifyKind};
use serde::Serialize;
use tauri::Emitter;
use tokio::sync::Mutex as AsyncMutex;
use walkdir::WalkDir;

// ── Skip patterns ──────────────────────────────────────────────────────────
// Keep in sync with lib.rs SKIP_DIRS.

const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", ".next", "dist", "dist-electron", "__pycache__",
    ".venv", "venv", ".mypy_cache", ".pytest_cache", ".idea", ".vscode",
    "target", "build",
];

const SKIP_EXTENSIONS: &[&str] = &[
    // OS noise
    ".DS_Store", "Thumbs.db", "desktop.ini",
    // Compiled artifacts
    ".pyc", ".pyo",
];

fn is_skipped(path: &Path, root: &Path) -> bool {
    let rel = match path.strip_prefix(root) {
        Ok(r) => r,
        Err(_) => return false,
    };
    for comp in rel.components() {
        if let std::path::Component::Normal(s) = comp {
            let name = s.to_string_lossy();
            if name.starts_with('.') { return true; }
            if SKIP_DIRS.contains(&name.as_ref()) { return true; }
        }
    }
    if let Some(ext) = path.extension() {
        let ext_s = ext.to_string_lossy().to_lowercase();
        if ext_s == "pyc" || ext_s == "pyo" { return true; }
    }
    let name = path.file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    SKIP_EXTENSIONS.iter().any(|s| name == **s)
}

// ── Event shape emitted to renderer ───────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FsEvent {
    /// A file or folder was created.
    Created { path: String, is_dir: bool },
    /// A file or folder was modified.
    Modified { path: String },
    /// A file or folder was removed.
    Removed { path: String },
}

fn event_to_fs_events(event: &Event) -> Vec<FsEvent> {
    let kind = &event.kind;
    let paths: Vec<_> = event.paths.iter().collect();

    match kind {
        EventKind::Create(_) => paths
            .iter()
            .map(|p| FsEvent::Created {
                path: p.to_string_lossy().replace('\\', "/"),
                is_dir: p.is_dir(),
            })
            .collect(),

        EventKind::Modify(change) => match change {
            // Name rename — treat as remove + create
            ModifyKind::Name(_) if paths.len() >= 2 => {
                vec![
                    FsEvent::Removed {
                        path: paths[0].to_string_lossy().replace('\\', "/"),
                    },
                    FsEvent::Created {
                        path: paths[1].to_string_lossy().replace('\\', "/"),
                        is_dir: paths[1].is_dir(),
                    },
                ]
            }
            // Content or metadata change
            _ => paths
                .iter()
                .map(|p| FsEvent::Modified {
                    path: p.to_string_lossy().replace('\\', "/"),
                })
                .collect(),
        },

        EventKind::Remove(_) => paths
            .iter()
            .map(|p| FsEvent::Removed {
                path: p.to_string_lossy().replace('\\', "/"),
            })
            .collect(),

        _ => vec![],
    }
}

// ── Watcher state ──────────────────────────────────────────────────────────

/// Shared watcher state. `watcher` is None when no workspace is open.
pub struct FsWatcherState {
    pub watcher: Option<RecommendedWatcher>,
    pub watched_path: Option<String>,
}

impl Default for FsWatcherState {
    fn default() -> Self {
        Self { watcher: None, watched_path: None }
    }
}

impl FsWatcherState {
    /// Stop watching the current workspace and start watching `root`.
    /// The watcher runs in a background thread and emits Tauri events
    /// via the `app` handle for each file-system change.
    pub fn watch(&mut self, root: PathBuf, app_handle: tauri::AppHandle) {
        // Stop previous watcher
        self.watcher = None;
        self.watched_path = None;

        let root_str = root.to_string_lossy().replace('\\', "/");
        let root_for_closure = root.clone();

        // Clone handle for the background thread
        let handle_clone = app_handle.clone();

        // Create watcher with a debounce channel to batch rapid events
        // (e.g. git checkout touching 50 files) into one render cycle.
        let (tx, rx) = std::sync::mpsc::channel();

        let watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                // Send to debounce thread
                let _ = tx.send(res);
            },
            Config::default()
                .with_poll_interval(Duration::from_millis(250)),
        )
        .expect("Failed to create file watcher");

        // Spawn debounce thread: batches events arriving within 150ms into
        // one Tauri event emission per batch.
        thread::spawn(move || {
            let root = root_for_closure;
            let handle = handle_clone;
            let mut pending: Vec<FsEvent> = Vec::new();
            let mut deadline = None;

            loop {
                // Wait up to 150ms for more events before emitting
                match rx.recv_timeout(Duration::from_millis(150)) {
                    Ok(Ok(event)) => {
                        let events: Vec<FsEvent> = event_to_fs_events(&event);
                        // Filter out noise
                        if !events.is_empty()
                            && !events.iter().all(|e| {
                                let p = match e {
                                    FsEvent::Created { path, .. } => Path::new(path),
                                    FsEvent::Modified { path } => Path::new(path),
                                    FsEvent::Removed { path } => Path::new(path),
                                };
                                is_skipped(p, &root)
                            })
                        {
                            pending.extend(events);
                            deadline = Some(());
                        }
                    }
                    Ok(Err(e)) => {
                        log::warn!("[fs:watcher] notify error: {e}");
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        // Flush any pending events
                        if !pending.is_empty() {
                            let batch: Vec<FsEvent> = std::mem::take(&mut pending);
                            let _ = handle.emit("fs:watcher", &batch);
                            deadline = None;
                        }
                        // Check if watcher is still alive (rx dropped = watcher dropped)
                        if rx.try_recv().is_err() && pending.is_empty() {
                            break;
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        // Watcher dropped — exit thread
                        break;
                    }
                }
            }
            log::info!("[fs:watcher] watcher thread exited");
        });

        // Store the watcher
        self.watcher = Some(watcher);
        self.watched_path = Some(root_str.clone());

        // Begin watching — need `as_mut` since `Watcher::watch` requires
        // `&mut self`, not just `&self`.
        let watcher_mut = self.watcher.as_mut().expect("watcher just set");
        if let Err(e) = watcher_mut.watch(&root, RecursiveMode::Recursive) {
            log::error!("[fs:watcher] Failed to watch {root_str}: {e}");
            self.watcher = None;
            self.watched_path = None;
            return;
        }

        log::info!("[fs:watcher] Now watching: {root_str}");
    }

    /// Stop watching. Called when the workspace is closed or changed.
    pub fn unwatch(&mut self) {
        if let Some(ref p) = self.watched_path {
            log::info!("[fs:watcher] Stopped watching: {p}");
        }
        self.watcher = None;
        self.watched_path = None;
    }
}

/// Thread-safe shared state for the file watcher.
/// Wrapped in Arc<AsyncMutex> so the Tauri commands (start_watcher / stop_watcher)
/// can mutate it. Commands run synchronously on the main thread so a std Mutex
/// would also work, but AsyncMutex keeps it consistent with the rest of the app.
pub type WatcherState = Arc<AsyncMutex<FsWatcherState>>;

/// Build the full list of paths currently in the workspace.
/// Used by the renderer to reconcile with existing tree nodes on workspace open.
pub fn scan_workspace(root: &Path) -> Vec<String> {
    let mut paths = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_str().unwrap_or("");
            if name.starts_with('.') { return false; }
            if e.file_type().is_dir() {
                let rel = e.path().strip_prefix(root)
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                let top = rel.split('/').next().unwrap_or("");
                if SKIP_DIRS.contains(&top) { return false; }
            }
            true
        })
        .flatten()
    {
        let path = entry.path().strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        if !path.is_empty() {
            paths.push(path);
        }
    }
    paths
}
