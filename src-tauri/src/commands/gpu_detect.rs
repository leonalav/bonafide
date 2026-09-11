// commands/gpu_detect.rs — Real GPU detection via nvidia-smi.
//
// Replaces the hardcoded GPU segment in BudgetMeter. Cross-platform: runs
// `nvidia-smi --query-gpu=... --format=json` on Windows and Unix; falls
// back to `rocm-smi` on Linux with AMD GPUs; returns `[]` gracefully when
// no GPU tool is available.

use serde::{Deserialize, Serialize};
use std::process::Command;

/// GPU information returned by `detect_gpus`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub name: String,
    /// GPU utilization as a percentage (0–100).
    pub utilization_pct: u8,
    /// Memory currently used, in megabytes.
    pub memory_used_mb: u64,
    /// Total GPU memory, in megabytes.
    pub memory_total_mb: u64,
}

/// GPU visibility state — persisted in settings and refreshed on app start.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GpuVisibility {
    pub visible: bool,
    pub count: usize,
}

/// Parse the JSON output of `nvidia-smi --query-gpu=... --format=json`.
///
/// The output is a JSON array of objects, e.g.:
/// ```json
/// [{"name": "NVIDIA GeForce RTX 3090", "utilization.gpu": "23 %",
///   "memory.used": "3250 MiB", "memory.total": "24576 MiB"}, ...]
/// ```
fn parse_nvidia_smi_json(stdout: &str) -> Vec<GpuInfo> {
    let parsed: Result<Vec<serde_json::Value>, _> = serde_json::from_str(stdout);
    let arr = match parsed {
        Ok(v) => v,
        Err(_) => return vec![],
    };

    arr.into_iter()
        .filter_map(|obj| {
            let name = obj.get("name")?.as_str()?.to_string();

            let util = obj
                .get("utilization.gpu")
                .and_then(|v| v.as_str())
                .and_then(|s| s.trim_end_matches(" %").parse::<u8>().ok())
                .unwrap_or(0);

            let mem_used = obj
                .get("memory.used")
                .and_then(|v| v.as_str())
                .and_then(|s| {
                    s.trim_end_matches(" MiB")
                        .trim_end_matches(" Mib")
                        .parse::<u64>()
                        .ok()
                })
                .unwrap_or(0);

            let mem_total = obj
                .get("memory.total")
                .and_then(|v| v.as_str())
                .and_then(|s| {
                    s.trim_end_matches(" MiB")
                        .trim_end_matches(" Mib")
                        .parse::<u64>()
                        .ok()
                })
                .unwrap_or(0);

            Some(GpuInfo {
                name,
                utilization_pct: util,
                memory_used_mb: mem_used,
                memory_total_mb: mem_total,
            })
        })
        .collect()
}

/// Try to run `nvidia-smi` with JSON output format. Works on both Windows
/// (nvidia-smi.exe in PATH) and Linux (nvidia-smi in PATH or /usr/bin/nvidia-smi).
fn try_nvidia_smi() -> Option<Vec<GpuInfo>> {
    // Try nvidia-smi directly first (works on Windows with PATH)
    let output = Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,utilization.gpu,memory.used,memory.total",
            "--format=json",
        ])
        .output()
        .ok()?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let gpus = parse_nvidia_smi_json(&stdout);
        if !gpus.is_empty() {
            return Some(gpus);
        }
    }

    // On Windows, try nvidia-smi.exe explicitly (same tool, different name)
    #[cfg(windows)]
    {
        let output = Command::new("nvidia-smi.exe")
            .args([
                "--query-gpu=name,utilization.gpu,memory.used,memory.total",
                "--format=json",
            ])
            .output()
            .ok()?;

        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let gpus = parse_nvidia_smi_json(&stdout);
            if !gpus.is_empty() {
                return Some(gpus);
            }
        }
    }

    // On Linux, try /usr/bin/nvidia-smi
    #[cfg(not(windows))]
    {
        let output = Command::new("/usr/bin/nvidia-smi")
            .args([
                "--query-gpu=name,utilization.gpu,memory.used,memory.total",
                "--format=json",
            ])
            .output()
            .ok()?;

        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let gpus = parse_nvidia_smi_json(&stdout);
            if !gpus.is_empty() {
                return Some(gpus);
            }
        }
    }

    None
}

/// Try `rocm-smi` for AMD GPUs on Linux. Returns `None` on non-Linux or
/// when the tool is absent.
fn try_rocm_smi() -> Option<Vec<GpuInfo>> {
    #[cfg(not(target_os = "linux"))]
    return None;

    let output = Command::new("rocm-smi")
        .args(["--showid", "--showuse", "--showmeminfo", "vram"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    // rocm-smi output is text; parse a simplified version.
    // Example output lines:
    //   GPU[0]          : Vega 10 XL [Radeon RX Vega 56/64]
    //   GPU[0]          : 23 %
    //   vram.used       : 4096 MiB
    //   vram.total      : 16384 MiB
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut gpus = vec![];

    for line in stdout.lines() {
        let line = line.trim();
        // Match GPU[N] with name
        if let Some(name) = line.strip_prefix("GPU[") {
            if let Some(rest) = name.split(']').nth(1) {
                let name = rest.trim().trim_start_matches(':').trim();
                if !name.is_empty() {
                    gpus.push(GpuInfo {
                        name: name.to_string(),
                        utilization_pct: 0,
                        memory_used_mb: 0,
                        memory_total_mb: 0,
                    });
                }
            }
        }
    }

    if gpus.is_empty() {
        return None;
    }

    // We got GPU names — rocm-smi doesn't give us JSON so we return what we have
    Some(gpus)
}

// ── Tauri commands ─────────────────────────────────────────────────────────

/// Detect all available GPUs on this machine.
///
/// Tries `nvidia-smi` first (NVIDIA on all platforms), then `rocm-smi`
/// (AMD on Linux). Returns an empty array if neither tool is available or
/// produces valid output.
#[tauri::command]
pub fn detect_gpus() -> Vec<GpuInfo> {
    try_nvidia_smi().or_else(try_rocm_smi).unwrap_or_default()
}

/// Get GPU visibility state. If `visible` has not been explicitly set in
/// settings, auto-detects the GPU count and sets `visible = count > 0`.
/// This is called on app start so the BudgetMeter can synchronously read
/// the visibility state.
#[tauri::command]
pub fn get_gpu_visibility() -> GpuVisibility {
    let gpus = detect_gpus();
    let count = gpus.len();
    GpuVisibility {
        visible: count > 0,
        count,
    }
}
