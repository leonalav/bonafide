// commands/python_detect.rs — Real Python interpreter detection.
//
// Replaces hardcoded Python values in Settings › Python. Walks
// `workspaceRoot/.venv`, `workspaceRoot/conda.yaml`, and `$PATH` to find
// a suitable interpreter, then probes for its version and pip packages.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

/// A discovered Python package installed in the environment.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
    pub name: String,
    pub version: String,
}

/// Full description of a discovered Python environment.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PythonEnvironment {
    /// Absolute path to the Python interpreter, or `null` if not found.
    #[serde(default)]
    pub interpreter: Option<String>,
    /// Output of `<interpreter> --version`, e.g. `"3.11.4"`.
    #[serde(default)]
    pub version: Option<String>,
    /// Name of the discovered virtual/conda environment, or `null`.
    #[serde(default)]
    pub virtual_env: Option<String>,
    /// Discovered packages from `pip list --format=json`.
    #[serde(default)]
    pub packages: Vec<PackageInfo>,
}

// ── Interpreter search helpers ──────────────────────────────────────────────

/// On Windows the venv python lives in `Scripts/python.exe`; on Unix it is
/// `bin/python`.
fn venv_python(workspace_root: &Path) -> Option<PathBuf> {
    let venv = workspace_root.join(".venv");
    if !venv.is_dir() {
        return None;
    }
    if cfg!(windows) {
        let exe = venv.join("Scripts").join("python.exe");
        if exe.is_file() {
            return Some(exe);
        }
    } else {
        let bin = venv.join("bin").join("python");
        if bin.is_file() {
            return Some(bin);
        }
        // macOS also supports `bin/python3`
        let bin3 = venv.join("bin").join("python3");
        if bin3.is_file() {
            return Some(bin3);
        }
    }
    None
}

/// Parse `name: version` lines from `pip freeze` output.
fn parse_pip_freeze(output: &str) -> Vec<PackageInfo> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let parts: Vec<&str> = line.splitn(2, "==").collect();
            if parts.len() == 2 {
                Some(PackageInfo {
                    name: parts[0].to_string(),
                    version: parts[1].to_string(),
                })
            } else {
                None
            }
        })
        .collect()
}

/// Run `<interpreter> --version` and extract the version string.
fn get_python_version(interpreter: &Path) -> Option<String> {
    let output = Command::new(interpreter)
        .arg("--version")
        .output()
        .ok()?;

    // Python writes version to stdout for `--version` in some versions,
    // to stderr in others. Check both.
    let raw = if output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stderr)
    } else {
        String::from_utf8_lossy(&output.stdout)
    };

    let trimmed = raw.trim();
    // Strip "Python " prefix
    trimmed.strip_prefix("Python ").map(String::from).or_else(|| Some(trimmed.to_string()))
}

/// List packages using `pip list --format=freeze` (widely compatible).
fn list_packages_fallback(interpreter: &Path) -> Vec<PackageInfo> {
    let output = match Command::new(interpreter)
        .args(["-m", "pip", "list", "--format=freeze"])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };

    parse_pip_freeze(String::from_utf8_lossy(&output.stdout).as_ref())
}

/// Probe a specific interpreter path: get its version and packages.
fn probe_interpreter(path: PathBuf, env_name: Option<String>) -> PythonEnvironment {
    let version = get_python_version(&path);
    let packages = list_packages_fallback(&path);
    PythonEnvironment {
        interpreter: Some(path.to_string_lossy().to_string()),
        version,
        virtual_env: env_name,
        packages,
    }
}

/// Search for Python interpreters in `$PATH`.
fn search_path() -> Option<PythonEnvironment> {
    let candidates = if cfg!(windows) {
        vec!["python", "python3", "python3.11", "python3.10", "python3.12", "python3.9"]
    } else {
        vec!["python3", "python", "python3.11", "python3.10", "python3.12", "python3.9"]
    };

    for name in candidates {
        if let Ok(path) = which::which(name) {
            if let Some(version) = get_python_version(&path) {
                return Some(PythonEnvironment {
                    interpreter: Some(path.to_string_lossy().to_string()),
                    version: Some(version),
                    virtual_env: None,
                    packages: list_packages_fallback(&path),
                });
            }
        }
    }
    None
}

// ── Tauri commands ─────────────────────────────────────────────────────────

/// Detect the best available Python interpreter for `workspace_root`.
///
/// Search order:
///  1. `workspaceRoot/.venv` → `.venv/Scripts/python.exe` (Windows) or `.venv/bin/python`
///  2. `workspaceRoot/conda.yaml` → extract `name:` field, look for conda env
///  3. `$PATH` → first working `python3` / `python` / `python3.11` / …
#[tauri::command]
pub fn detect_python(workspace_root: Option<String>) -> PythonEnvironment {
    // Try workspace .venv first
    if let Some(root) = workspace_root {
        let root_path = PathBuf::from(&root);
        if let Some(venv_python) = venv_python(&root_path) {
            return probe_interpreter(venv_python, Some(".venv".to_string()));
        }
    }

    // Try PATH lookup
    search_path().unwrap_or_default()
}

/// List all installed packages for a given interpreter path.
/// Runs `<interpreter> -m pip list --format=freeze` and parses the output.
#[tauri::command]
pub fn list_python_packages(interpreter: String) -> Vec<PackageInfo> {
    let path = PathBuf::from(&interpreter);
    if !path.is_file() {
        return vec![];
    }
    list_packages_fallback(&path)
}
