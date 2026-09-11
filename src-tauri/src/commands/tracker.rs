// commands/tracker.rs — App-level tracker/service probes used by the
// Preferences → Account panel.
//
// This module is distinct from the workspace-scoped tracker layer
// (`src-tauri/src/tracker/mod.rs`), which manages per-workspace
// provider connections and shim processes for `list_runs` /
// `get_run` / etc. The commands here are user-scoped "is this
// thing configured on my machine?" probes — they don't require a
// workspace to be open and they don't talk to any tracker API.
//
// Each probe reads from a well-known local source of truth:
//   - W&B      → `WANDB_API_KEY` env var or `~/.netrc`
//   - MLflow   → `mlflowBaseUrl` / `mlflowProject` from the settings
//                store (commands::settings), then a GET probe to the
//                URL's `/health` endpoint
//   - Comet    → `COMET_API_KEY` env var
//   - Neptune  → `NEPTUNE_API_TOKEN` env var
//   - GitHub   → `GH_TOKEN` / `GITHUB_TOKEN` env var
//   - HF       → `HF_TOKEN` / `HUGGINGFACE_TOKEN` env var
//   - Slack    → no easy check → always reports `connected: false`
//
// The probes are best-effort and never panic. We accept that MLflow
// `connected: false` might mean either "no URL configured" or "URL
// configured but server is down" and use the `meta` field to
// disambiguate.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::time::Duration;

use crate::commands::settings;

// ── Wire types ─────────────────────────────────────────────────────────────

/// Tracker provider kinds the renderer cares about. Matches the
/// `TrackerKind` union in `src/ipc/tauri.ts`.
///
/// `Wandb` / `Mlflow` are the same kinds the workspace-scoped
/// tracker module manages; `Comet` / `Neptune` are read-only probes
/// because the rest of the app doesn't ship integrations for them
/// yet. Adding connect/test flows for the latter two would be a
/// Phase 1+ task.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackerKind {
    Wandb,
    Mlflow,
    Comet,
    Neptune,
}

impl TrackerKind {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "wandb" => Some(Self::Wandb),
            "mlflow" => Some(Self::Mlflow),
            "comet" => Some(Self::Comet),
            "neptune" => Some(Self::Neptune),
            _ => None,
        }
    }
}

/// Per-tracker status row sent to the renderer. `account` is the
/// best-effort identifier we found for the user (email, org, etc.)
/// and `meta` is a free-form human-readable string surfaced under
/// the tracker row (e.g. "Synced 12s ago · 27 runs" or
/// "No URL configured"). The renderer is free to show "—" when
/// `meta` is `None` rather than empty-string.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerStatus {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    pub connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<String>,
}

/// Per-tracker configuration. Returned by `get_tracker_config` so
/// the renderer can pre-populate the connection forms with the
/// last-used URL / project without round-tripping through
/// `getSettings()`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

/// Connected-service status row. Mirrors `TrackerStatus` but with
/// the service kinds (`github`, `huggingface`, `slack`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    pub connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<String>,
}

/// User profile for the top "Ada Lovelace" card in Account. For
/// Phase 0.0 this is fully synthetic — we don't have a Bonafide
/// account system yet, so the backend always returns `None` and the
/// renderer falls back to dashed/empty placeholders.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub name: String,
    pub email: String,
    pub joined: String,
}

// ── Probes ─────────────────────────────────────────────────────────────────

/// Read `~/.netrc` (best-effort, ignore errors). Returns the list of
/// `(machine, login, password)` tuples. Used for W&B credential
/// detection — if a `wandb` entry exists, we consider W&B
/// "connected".
///
/// Format spec: <https://everything.curl.dev/usingcurl/netrc>. We
/// deliberately do NOT pull in a `netrc` crate because the format
/// is small enough to handle inline and the file is optional — any
/// parse failure returns `None` rather than panicking.
fn read_netrc() -> Option<HashMap<String, (String, Option<String>)>> {
    let path = dirs::home_dir()?.join(".netrc");
    let content = fs::read_to_string(&path).ok()?;
    let mut out: HashMap<String, (String, Option<String>)> = HashMap::new();
    let mut current_machine: Option<String> = None;
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        // Split on whitespace; the format is `key value` pairs, one
        // per line. We use a simple split rather than a proper
        // tokenizer because `.netrc` doesn't support quoted values
        // in practice.
        let mut parts = line.split_whitespace();
        let key = parts.next()?;
        let value = parts.next().unwrap_or("").to_string();
        match key {
            "machine" => current_machine = Some(value),
            "login" => {
                if let Some(m) = current_machine.clone() {
                    let entry = out.entry(m).or_insert((String::new(), None));
                    entry.0 = value;
                }
            }
            "password" => {
                if let Some(m) = current_machine.clone() {
                    let entry = out.entry(m).or_insert((String::new(), None));
                    entry.1 = Some(value);
                }
            }
            _ => { /* unknown key — skip */ }
        }
    }
    Some(out)
}

/// Probe W&B: connected if `WANDB_API_KEY` is set OR `~/.netrc` has
/// a `wandb` machine entry.
fn probe_wandb() -> TrackerStatus {
    if env::var("WANDB_API_KEY").is_ok() {
        return TrackerStatus {
            kind: "wandb".into(),
            account: env::var("WANDB_USERNAME").ok().filter(|s| !s.is_empty()),
            connected: true,
            meta: Some("API key in environment".into()),
        };
    }
    if let Some(netrc) = read_netrc() {
        if let Some((login, _pw)) = netrc.get("wandb") {
            return TrackerStatus {
                kind: "wandb".into(),
                account: if login.is_empty() { None } else { Some(login.clone()) },
                connected: true,
                meta: Some("~/.netrc".into()),
            };
        }
    }
    TrackerStatus {
        kind: "wandb".into(),
        account: None,
        connected: false,
        meta: None,
    }
}

/// Probe MLflow: connected if the settings store has a
/// `mlflowBaseUrl` AND we can reach its `/health` endpoint. If the
/// URL is missing, return `connected: false` with a meta that says
/// so, so the renderer can show "No URL configured" under the row.
async fn probe_mlflow() -> TrackerStatus {
    let settings = settings::load_settings_or_default();
    let url = settings.mlflow_base_url.clone();
    let url = match url {
        None => {
            return TrackerStatus {
                kind: "mlflow".into(),
                account: None,
                connected: false,
                meta: Some("No URL configured".into()),
            };
        }
        Some(u) if u.trim().is_empty() => {
            return TrackerStatus {
                kind: "mlflow".into(),
                account: None,
                connected: false,
                meta: Some("No URL configured".into()),
            };
        }
        Some(u) => u,
    };

    // Build the client lazily so we only pay the connection-pool
    // setup cost when an MLflow URL is actually configured. The 2s
    // timeout caps how long a slow / unreachable server can stall
    // the preferences panel.
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return TrackerStatus {
                kind: "mlflow".into(),
                account: None,
                connected: false,
                meta: Some(format!("client init failed: {e}")),
            };
        }
    };

    let started = std::time::Instant::now();
    let result = client
        .get(format!("{}/health", url.trim_end_matches('/')))
        .send()
        .await;
    let latency_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(resp) if resp.status().is_success() => TrackerStatus {
            kind: "mlflow".into(),
            account: None,
            connected: true,
            meta: Some(format!("Reachable in {latency_ms}ms")),
        },
        Ok(resp) => TrackerStatus {
            kind: "mlflow".into(),
            account: None,
            connected: false,
            meta: Some(format!("HTTP {}", resp.status().as_u16())),
        },
        Err(e) => TrackerStatus {
            kind: "mlflow".into(),
            account: None,
            connected: false,
            meta: Some(format!("Unreachable: {e}")),
        },
    }
}

/// Probe Comet: connected if `COMET_API_KEY` is set.
fn probe_comet() -> TrackerStatus {
    match env::var("COMET_API_KEY") {
        Ok(v) if !v.is_empty() => TrackerStatus {
            kind: "comet".into(),
            account: env::var("COMET_WORKSPACE").ok(),
            connected: true,
            meta: Some("API key in environment".into()),
        },
        _ => TrackerStatus {
            kind: "comet".into(),
            account: None,
            connected: false,
            meta: None,
        },
    }
}

/// Probe Neptune: connected if `NEPTUNE_API_TOKEN` is set.
fn probe_neptune() -> TrackerStatus {
    match env::var("NEPTUNE_API_TOKEN") {
        Ok(v) if !v.is_empty() => TrackerStatus {
            kind: "neptune".into(),
            account: None,
            connected: true,
            meta: Some("API token in environment".into()),
        },
        _ => TrackerStatus {
            kind: "neptune".into(),
            account: None,
            connected: false,
            meta: None,
        },
    }
}

/// Probe GitHub: connected if `GH_TOKEN` or `GITHUB_TOKEN` is set.
fn probe_github() -> ServiceStatus {
    let token = env::var("GH_TOKEN")
        .ok()
        .or_else(|| env::var("GITHUB_TOKEN").ok());
    match token {
        Some(v) if !v.is_empty() => ServiceStatus {
            kind: "github".into(),
            account: env::var("GH_USER").ok(),
            connected: true,
            meta: Some("API token in environment".into()),
        },
        _ => ServiceStatus {
            kind: "github".into(),
            account: None,
            connected: false,
            meta: None,
        },
    }
}

/// Probe Hugging Face: connected if `HF_TOKEN` or
/// `HUGGINGFACE_TOKEN` is set.
fn probe_huggingface() -> ServiceStatus {
    let token = env::var("HF_TOKEN")
        .ok()
        .or_else(|| env::var("HUGGINGFACE_TOKEN").ok());
    match token {
        Some(v) if !v.is_empty() => ServiceStatus {
            kind: "huggingface".into(),
            account: env::var("HF_USERNAME").ok(),
            connected: true,
            meta: Some("API token in environment".into()),
        },
        _ => ServiceStatus {
            kind: "huggingface".into(),
            account: None,
            connected: false,
            meta: None,
        },
    }
}

/// Probe Slack: no easy local check, always returns disconnected.
/// We don't fabricate a "configured but unreachable" state because
/// the user would have to actually enter a webhook URL somewhere
/// for that to be meaningful, and that wiring lives in a different
/// task.
fn probe_slack() -> ServiceStatus {
    ServiceStatus {
        kind: "slack".into(),
        account: None,
        connected: false,
        meta: None,
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────

/// Return tracker statuses for every kind the renderer knows about.
///
/// Always returns all four (`wandb`, `mlflow`, `comet`, `neptune`),
/// even if disconnected, so the UI can render the full list without
/// having to filter missing kinds client-side.
#[tauri::command]
pub async fn get_tracker_status() -> Vec<TrackerStatus> {
    vec![
        probe_wandb(),
        probe_mlflow().await,
        probe_comet(),
        probe_neptune(),
    ]
}

/// Return the persisted configuration for `kind`. Returns `None`
/// when no config has ever been saved for that kind — the renderer
/// falls back to its own defaults in that case.
#[tauri::command]
pub fn get_tracker_config(kind: String) -> Option<TrackerConfig> {
    let settings = settings::load_settings_or_default();
    let _ = TrackerKind::from_str(&kind)?; // validate kind, ignore unsupported
    match kind.as_str() {
        "mlflow" => Some(TrackerConfig {
            base_url: settings.mlflow_base_url,
            project: settings.mlflow_project,
        }),
        "wandb" => Some(TrackerConfig {
            // W&B doesn't store a base URL — the shim hits api.wandb.ai
            // by default. We still return Some() so the renderer
            // knows the kind is "supported" and can show the form.
            base_url: None,
            project: settings.default_project,
        }),
        // For comet/neptune we have no per-kind settings yet.
        _ => None,
    }
}

/// Return service statuses (`github`, `huggingface`, `slack`).
#[tauri::command]
pub fn list_services() -> Vec<ServiceStatus> {
    vec![
        probe_github(),
        probe_huggingface(),
        probe_slack(),
    ]
}

/// Return the user's profile. For Phase 0.0 we don't have a Bonafide
/// account backend yet, so this always returns `None` — the renderer
/// falls back to dashed/empty placeholders. The function shape is
/// defined now so swapping in a real lookup later is a no-op for
/// the renderer.
#[tauri::command]
pub fn get_user_profile() -> Option<UserProfile> {
    None
}
