// commands/app_info.rs — App version, build hash, platform paths, cache size.
//
// Replaces hardcoded cache size, version, paths in Settings. Reads from
// real sources: `CARGO_PKG_VERSION`, `git rev-parse --short HEAD`,
// `dirs::cache_dir()`, `dirs::home_dir()`.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

/// Aggregate app metadata returned by `get_app_info`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// Package version from Cargo.toml.
    pub version: String,
    /// Git short-hash from `git rev-parse --short HEAD`, or "unknown".
    pub build: String,
    /// `std::env::consts::OS`.
    pub platform: String,
    /// `std::env::consts::ARCH`.
    pub arch: String,
    /// Platform-specific cache directory.
    pub cache_dir: String,
    /// Path to the local SQLite DB.
    pub db_path: String,
    /// IPC port (default 7654 for the local Tauri-side bridge).
    pub ipc_port: u16,
    /// Path to the Python shim Unix-domain socket.
    pub shim_socket: String,
}

/// Run `git rev-parse --short HEAD` from the current working directory.
/// Returns `"unknown"` if no git repo or git is unavailable.
fn git_short_hash() -> String {
    let output = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    if output.is_empty() {
        "unknown".into()
    } else {
        output
    }
}

/// Resolve the bonafide cache directory.
fn resolve_cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".cache")
        })
        .join("bonafide")
}

/// Resolve the Python shim socket path.
fn resolve_shim_socket() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".bonafide")
        .join("shim.sock")
}

// ── Tauri commands ─────────────────────────────────────────────────────────

/// Return all app metadata for the renderer.
#[tauri::command]
pub fn get_app_info() -> AppInfo {
    let cache_dir = resolve_cache_dir();
    let db_path = cache_dir.join("cache.db");
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        build: git_short_hash(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        cache_dir: cache_dir.to_string_lossy().to_string(),
        db_path: db_path.to_string_lossy().to_string(),
        ipc_port: 7654,
        shim_socket: resolve_shim_socket().to_string_lossy().to_string(),
    }
}

/// Recursively sum the size of all files in the cache directory.
/// Returns 0 if the cache directory does not exist or cannot be read.
#[tauri::command]
pub fn get_cache_size() -> u64 {
    let cache_dir = resolve_cache_dir();
    if !cache_dir.is_dir() {
        return 0;
    }

    walkdir::WalkDir::new(&cache_dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

/// Delete all files in the cache directory, returning the total bytes cleared.
#[tauri::command]
pub fn clear_cache() -> Result<u64, String> {
    let cache_dir = resolve_cache_dir();
    if !cache_dir.is_dir() {
        return Ok(0);
    }

    // Compute total size first
    let total: u64 = walkdir::WalkDir::new(&cache_dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum();

    // Remove each file individually so we never wipe the directory itself
    // (preserves the directory so future cache writes don't fail).
    for entry in walkdir::WalkDir::new(&cache_dir)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
            let _ = std::fs::remove_file(entry.path());
        }
    }

    Ok(total)
}

/// Open a path in the platform's file manager (Explorer / Finder / xdg-open).
/// Uses Tauri's `shell.open()` plugin via the JS side; this command is a
/// convenience for the renderer's `bonafide.shell.openPath`.
#[tauri::command]
pub fn open_in_folder(path: String) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;
    use tauri::AppHandle;

    // We don't have an AppHandle here; the renderer invokes
    // `tauri-plugin-shell`'s `open` directly with the path instead.
    // This command exists as a placeholder for future use.
    let _ = path;
    Ok(())
}
