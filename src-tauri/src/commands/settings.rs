// commands/settings.rs — Typed settings store backed by `~/.bonafide/settings.json`.
//
// Persists user preferences across sessions. All Settings fields from the
// spec are included: defaultProject, syncInterval, formatter, formatOnSave,
// all decoration toggles, all notification toggles, quiet hours, analytics
// opt-in, update channel, lastUpdateCheck timestamp, MLflow connection
// config, and the custom model-endpoint registry.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

/// One entry in the custom model-endpoint registry. Keyed by an
/// opaque ID the renderer generates (`Date.now()`-based UID is fine).
///
/// The full endpoint shape (id, label, baseUrl, apiKey, defaultModel,
/// available) round-trips through `setSetting("modelEndpoints", ...)` /
/// `getSetting("modelEndpoints")`. The Rust side just accepts and
/// stores whatever the renderer sends; the schema is entirely owned by
/// the TypeScript side. `available` is set by the last `test`
/// round-trip — `true` if the URL responded, `false` otherwise.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEndpoint {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default)]
    pub available: bool,
}

/// Path to the settings file: `~/.bonafide/settings.json`
fn settings_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".bonafide")
        .join("settings.json")
}

/// Ensure the `.bonafide/` directory exists before writing.
fn ensure_bonafide_dir() -> std::io::Result<()> {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".bonafide");
    fs::create_dir_all(dir)
}

/// Default settings — mirrors the spec's field list.
impl Default for Settings {
    fn default() -> Self {
        Self {
            default_project: None,
            sync_interval: "5s".to_string(),
            formatter: "ruff".to_string(),
            format_on_save: true,
            // Decoration toggles
            show_run_anchor_decorations: true,
            show_live_metric_sparklines: true,
            show_code_provenance_borders: true,
            animate_status_dots: false,
            // Notification toggles
            notify_run_finish_toast: true,
            notify_run_finish_os: true,
            notify_run_finish_email: false,
            notify_run_finish_slack: false,
            notify_run_fail_toast: true,
            notify_run_fail_os: true,
            notify_run_fail_email: true,
            notify_run_fail_slack: true,
            notify_better_run_toast: false,
            notify_better_run_os: false,
            // Quiet hours
            quiet_hours_enabled: true,
            quiet_hours_start: "22:00".to_string(),
            quiet_hours_end: "08:00".to_string(),
            // Tracker options
            detect_venv_on_open: true,
            use_system_python: false,
            use_python_from_path: true,
            delta_chip_metric: "val_loss".to_string(),
            reindex_on_save: true,
            send_git_metadata: true,
            run_precommit_hooks: false,
            // Privacy / updates
            analytics_opt_in: true,
            crash_reports_opt_in: true,
            update_channel: "stable".to_string(),
            auto_download_updates: true,
            install_automatically: false,
            last_update_check: None,
            // MLflow connection (used by commands/tracker.rs probe
            // and by the renderer to pre-populate the connection
            // form). Both fields are `None` on first run; the
            // renderer's MLflow card writes them via `set_setting`.
            mlflow_base_url: None,
            mlflow_project: None,
            // Model endpoints registry (P0-T6). Empty map on first
            // run — the renderer creates entries as the user adds
            // custom endpoints through the Models section.
            model_endpoints: HashMap::new(),
        }
    }
}

/// Full settings shape — must match the TypeScript `Settings` type exactly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub default_project: Option<String>,
    #[serde(default = "default_sync_interval")]
    pub sync_interval: String,
    #[serde(default = "default_formatter")]
    pub formatter: String,
    #[serde(default = "default_true")]
    pub format_on_save: bool,
    // Decoration toggles
    #[serde(default = "default_true")]
    pub show_run_anchor_decorations: bool,
    #[serde(default = "default_true")]
    pub show_live_metric_sparklines: bool,
    #[serde(default = "default_true")]
    pub show_code_provenance_borders: bool,
    #[serde(default)]
    pub animate_status_dots: bool,
    // Notification toggles
    #[serde(default = "default_true")]
    pub notify_run_finish_toast: bool,
    #[serde(default = "default_true")]
    pub notify_run_finish_os: bool,
    #[serde(default)]
    pub notify_run_finish_email: bool,
    #[serde(default)]
    pub notify_run_finish_slack: bool,
    #[serde(default = "default_true")]
    pub notify_run_fail_toast: bool,
    #[serde(default = "default_true")]
    pub notify_run_fail_os: bool,
    #[serde(default = "default_true")]
    pub notify_run_fail_email: bool,
    #[serde(default = "default_true")]
    pub notify_run_fail_slack: bool,
    #[serde(default)]
    pub notify_better_run_toast: bool,
    #[serde(default)]
    pub notify_better_run_os: bool,
    // Quiet hours
    #[serde(default = "default_true")]
    pub quiet_hours_enabled: bool,
    #[serde(default = "default_quiet_start")]
    pub quiet_hours_start: String,
    #[serde(default = "default_quiet_end")]
    pub quiet_hours_end: String,
    // Tracker options
    #[serde(default = "default_true")]
    pub detect_venv_on_open: bool,
    #[serde(default)]
    pub use_system_python: bool,
    #[serde(default = "default_true")]
    pub use_python_from_path: bool,
    #[serde(default = "default_delta_metric")]
    pub delta_chip_metric: String,
    #[serde(default = "default_true")]
    pub reindex_on_save: bool,
    #[serde(default = "default_true")]
    pub send_git_metadata: bool,
    #[serde(default)]
    pub run_precommit_hooks: bool,
    // Privacy / updates
    #[serde(default = "default_true")]
    pub analytics_opt_in: bool,
    #[serde(default = "default_true")]
    pub crash_reports_opt_in: bool,
    #[serde(default = "default_channel")]
    pub update_channel: String,
    #[serde(default = "default_true")]
    pub auto_download_updates: bool,
    #[serde(default)]
    pub install_automatically: bool,
    #[serde(default)]
    pub last_update_check: Option<i64>,
    // MLflow connection (renderer's MLflow card in Preferences →
    // Account). Both fields are `None` on first run.
    #[serde(default)]
    pub mlflow_base_url: Option<String>,
    #[serde(default)]
    pub mlflow_project: Option<String>,
    // Model endpoints registry (P0-T6). Empty on first run.
    // Keyed by an opaque ID the renderer generates. The full map
    // round-trips through `getSetting("modelEndpoints")` /
    // `setSetting("modelEndpoints", ...)` so the renderer never has
    // to manage each endpoint individually.
    #[serde(default)]
    pub model_endpoints: HashMap<String, ModelEndpoint>,
}

fn default_sync_interval() -> String { "5s".into() }
fn default_formatter() -> String { "ruff".into() }
fn default_true() -> bool { true }
fn default_quiet_start() -> String { "22:00".into() }
fn default_quiet_end() -> String { "08:00".into() }
fn default_delta_metric() -> String { "val_loss".into() }
fn default_channel() -> String { "stable".into() }

/// Load settings from `~/.bonafide/settings.json`. Returns defaults if the
/// file does not exist or is unreadable.
pub fn load_settings_or_default() -> Settings {
    let path = settings_path();
    match fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

/// Persist settings to `~/.bonafide/settings.json`.
fn save_settings(settings: &Settings) -> Result<(), String> {
    ensure_bonafide_dir().map_err(|e| format!("Failed to create settings dir: {e}"))?;
    let path = settings_path();
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize settings: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write settings: {e}"))?;
    Ok(())
}

// ── Tauri commands ─────────────────────────────────────────────────────────

/// Read all settings, returning defaults if the file is absent.
#[tauri::command]
pub fn get_settings() -> Settings {
    load_settings_or_default()
}

/// Persist the full settings object.
#[tauri::command]
pub fn set_settings(settings: Settings) -> Result<(), String> {
    save_settings(&settings)
}

/// Update a single setting by JSON key. The value is any JSON primitive or
/// object; it is merged into the existing settings at the top-level key.
#[tauri::command]
pub fn set_setting(key: String, value: serde_json::Value) -> Result<(), String> {
    let mut settings = load_settings_or_default();
    match key.as_str() {
        "defaultProject" => {
            if let Some(v) = value.as_str() {
                settings.default_project = Some(v.to_string());
            } else {
                settings.default_project = None;
            }
        }
        "syncInterval" => {
            if let Some(v) = value.as_str() {
                settings.sync_interval = v.to_string();
            }
        }
        "formatter" => {
            if let Some(v) = value.as_str() {
                settings.formatter = v.to_string();
            }
        }
        "formatOnSave" => {
            if let Some(v) = value.as_bool() {
                settings.format_on_save = v;
            }
        }
        "showRunAnchorDecorations" => {
            if let Some(v) = value.as_bool() { settings.show_run_anchor_decorations = v; }
        }
        "showLiveMetricSparklines" => {
            if let Some(v) = value.as_bool() { settings.show_live_metric_sparklines = v; }
        }
        "showCodeProvenanceBorders" => {
            if let Some(v) = value.as_bool() { settings.show_code_provenance_borders = v; }
        }
        "animateStatusDots" => {
            if let Some(v) = value.as_bool() { settings.animate_status_dots = v; }
        }
        "notifyRunFinishToast" => {
            if let Some(v) = value.as_bool() { settings.notify_run_finish_toast = v; }
        }
        "notifyRunFinishOs" => {
            if let Some(v) = value.as_bool() { settings.notify_run_finish_os = v; }
        }
        "notifyRunFinishEmail" => {
            if let Some(v) = value.as_bool() { settings.notify_run_finish_email = v; }
        }
        "notifyRunFinishSlack" => {
            if let Some(v) = value.as_bool() { settings.notify_run_finish_slack = v; }
        }
        "notifyRunFailToast" => {
            if let Some(v) = value.as_bool() { settings.notify_run_fail_toast = v; }
        }
        "notifyRunFailOs" => {
            if let Some(v) = value.as_bool() { settings.notify_run_fail_os = v; }
        }
        "notifyRunFailEmail" => {
            if let Some(v) = value.as_bool() { settings.notify_run_fail_email = v; }
        }
        "notifyRunFailSlack" => {
            if let Some(v) = value.as_bool() { settings.notify_run_fail_slack = v; }
        }
        "notifyBetterRunToast" => {
            if let Some(v) = value.as_bool() { settings.notify_better_run_toast = v; }
        }
        "notifyBetterRunOs" => {
            if let Some(v) = value.as_bool() { settings.notify_better_run_os = v; }
        }
        "quietHoursEnabled" => {
            if let Some(v) = value.as_bool() { settings.quiet_hours_enabled = v; }
        }
        "quietHoursStart" => {
            if let Some(v) = value.as_str() { settings.quiet_hours_start = v.to_string(); }
        }
        "quietHoursEnd" => {
            if let Some(v) = value.as_str() { settings.quiet_hours_end = v.to_string(); }
        }
        "detectVenvOnOpen" => {
            if let Some(v) = value.as_bool() { settings.detect_venv_on_open = v; }
        }
        "useSystemPython" => {
            if let Some(v) = value.as_bool() { settings.use_system_python = v; }
        }
        "usePythonFromPath" => {
            if let Some(v) = value.as_bool() { settings.use_python_from_path = v; }
        }
        "deltaChipMetric" => {
            if let Some(v) = value.as_str() { settings.delta_chip_metric = v.to_string(); }
        }
        "reindexOnSave" => {
            if let Some(v) = value.as_bool() { settings.reindex_on_save = v; }
        }
        "sendGitMetadata" => {
            if let Some(v) = value.as_bool() { settings.send_git_metadata = v; }
        }
        "runPrecommitHooks" => {
            if let Some(v) = value.as_bool() { settings.run_precommit_hooks = v; }
        }
        "analyticsOptIn" => {
            if let Some(v) = value.as_bool() { settings.analytics_opt_in = v; }
        }
        "crashReportsOptIn" => {
            if let Some(v) = value.as_bool() { settings.crash_reports_opt_in = v; }
        }
        "updateChannel" => {
            if let Some(v) = value.as_str() { settings.update_channel = v.to_string(); }
        }
        "autoDownloadUpdates" => {
            if let Some(v) = value.as_bool() { settings.auto_download_updates = v; }
        }
        "installAutomatically" => {
            if let Some(v) = value.as_bool() { settings.install_automatically = v; }
        }
        "lastUpdateCheck" => {
            if let Some(v) = value.as_i64() {
                settings.last_update_check = Some(v);
            }
        }
        "mlflowBaseUrl" => {
            if let Some(v) = value.as_str() {
                settings.mlflow_base_url = Some(v.to_string());
            } else {
                settings.mlflow_base_url = None;
            }
        }
        "mlflowProject" => {
            if let Some(v) = value.as_str() {
                settings.mlflow_project = Some(v.to_string());
            } else {
                settings.mlflow_project = None;
            }
        }
        "modelEndpoints" => {
            // Replace the entire registry with whatever the renderer
            // sent. The renderer is the single source of truth for
            // endpoint IDs (it generates them locally) and is
            // responsible for diffing add/remove against the
            // previous snapshot before calling this. We just
            // validate the payload shape and overwrite.
            match serde_json::from_value::<HashMap<String, ModelEndpoint>>(value) {
                Ok(map) => settings.model_endpoints = map,
                Err(e) => return Err(format!("Invalid modelEndpoints payload: {e}")),
            }
        }
        other => return Err(format!("Unknown setting key: {other}")),
    }
    save_settings(&settings)
}

/// Read a single setting key, returning `None` if the key is absent.
#[tauri::command]
pub fn get_setting(key: String) -> Option<serde_json::Value> {
    let settings = load_settings_or_default();
    match key.as_str() {
        "defaultProject" => settings.default_project.map(serde_json::Value::String),
        "syncInterval" => Some(serde_json::Value::String(settings.sync_interval)),
        "formatter" => Some(serde_json::Value::String(settings.formatter)),
        "formatOnSave" => Some(serde_json::Value::Bool(settings.format_on_save)),
        "showRunAnchorDecorations" => Some(serde_json::Value::Bool(settings.show_run_anchor_decorations)),
        "showLiveMetricSparklines" => Some(serde_json::Value::Bool(settings.show_live_metric_sparklines)),
        "showCodeProvenanceBorders" => Some(serde_json::Value::Bool(settings.show_code_provenance_borders)),
        "animateStatusDots" => Some(serde_json::Value::Bool(settings.animate_status_dots)),
        "notifyRunFinishToast" => Some(serde_json::Value::Bool(settings.notify_run_finish_toast)),
        "notifyRunFinishOs" => Some(serde_json::Value::Bool(settings.notify_run_finish_os)),
        "notifyRunFinishEmail" => Some(serde_json::Value::Bool(settings.notify_run_finish_email)),
        "notifyRunFinishSlack" => Some(serde_json::Value::Bool(settings.notify_run_finish_slack)),
        "notifyRunFailToast" => Some(serde_json::Value::Bool(settings.notify_run_fail_toast)),
        "notifyRunFailOs" => Some(serde_json::Value::Bool(settings.notify_run_fail_os)),
        "notifyRunFailEmail" => Some(serde_json::Value::Bool(settings.notify_run_fail_email)),
        "notifyRunFailSlack" => Some(serde_json::Value::Bool(settings.notify_run_fail_slack)),
        "notifyBetterRunToast" => Some(serde_json::Value::Bool(settings.notify_better_run_toast)),
        "notifyBetterRunOs" => Some(serde_json::Value::Bool(settings.notify_better_run_os)),
        "quietHoursEnabled" => Some(serde_json::Value::Bool(settings.quiet_hours_enabled)),
        "quietHoursStart" => Some(serde_json::Value::String(settings.quiet_hours_start)),
        "quietHoursEnd" => Some(serde_json::Value::String(settings.quiet_hours_end)),
        "detectVenvOnOpen" => Some(serde_json::Value::Bool(settings.detect_venv_on_open)),
        "useSystemPython" => Some(serde_json::Value::Bool(settings.use_system_python)),
        "usePythonFromPath" => Some(serde_json::Value::Bool(settings.use_python_from_path)),
        "deltaChipMetric" => Some(serde_json::Value::String(settings.delta_chip_metric)),
        "reindexOnSave" => Some(serde_json::Value::Bool(settings.reindex_on_save)),
        "sendGitMetadata" => Some(serde_json::Value::Bool(settings.send_git_metadata)),
        "runPrecommitHooks" => Some(serde_json::Value::Bool(settings.run_precommit_hooks)),
        "analyticsOptIn" => Some(serde_json::Value::Bool(settings.analytics_opt_in)),
        "crashReportsOptIn" => Some(serde_json::Value::Bool(settings.crash_reports_opt_in)),
        "updateChannel" => Some(serde_json::Value::String(settings.update_channel)),
        "autoDownloadUpdates" => Some(serde_json::Value::Bool(settings.auto_download_updates)),
        "installAutomatically" => Some(serde_json::Value::Bool(settings.install_automatically)),
        "lastUpdateCheck" => settings.last_update_check.map(|n| serde_json::Value::Number(n.into())),
        "mlflowBaseUrl" => settings.mlflow_base_url.map(serde_json::Value::String),
        "mlflowProject" => settings.mlflow_project.map(serde_json::Value::String),
        "modelEndpoints" => Some(serde_json::to_value(&settings.model_endpoints).unwrap_or(serde_json::Value::Null)),
        _ => None,
    }
}
