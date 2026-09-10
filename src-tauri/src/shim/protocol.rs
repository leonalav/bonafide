// Shim stdio protocol — JSON-RPC types for W&B adapter communication.
// All JSON-RPC requests are written to the shim subprocess's stdin and
// responses are read from its stdout.

use serde::{Deserialize, Serialize};

/// Inbound request from the Tauri app to the shim Python process.
/// Serialized as `{"method": "list_runs", "params": {"project": "...", ...}}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum ShimRequest {
    #[serde(rename = "list_runs")]
    ListRuns {
        project: String,
        limit: u32,
        cursor: Option<String>,
    },
    #[serde(rename = "get_run")]
    GetRun { run_id: String },
    #[serde(rename = "get_metric_series")]
    GetMetricSeries { run_id: String, key: String },
    #[serde(rename = "get_run_config")]
    GetRunConfig { run_id: String },
    #[serde(rename = "list_artifacts")]
    ListArtifacts { run_id: String },
}

/// Outbound response from the shim Python process to the Tauri app.
/// Serialized as `{"type": "result", "id": ..., "result": ...}` or
/// `{"type": "error", "id": ..., "error": {...}}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ShimResponse {
    #[serde(rename = "result")]
    Result {
        id: u64,
        #[serde(default)]
        result: Option<serde_json::Value>,
    },
    #[serde(rename = "error")]
    Error {
        id: u64,
        error: ShimErrorDetail,
    },
}

/// Error detail payload inside a `ShimResponse::Error` variant.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShimErrorDetail {
    pub code: i32,
    pub message: String,
}

/// Asynchronous event emitted by the shim Python process (e.g. progress
/// updates during a long operation). These arrive on a separate event
/// channel and are forwarded to the renderer via Tauri's event system.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShimEvent {
    /// Event name: "info" | "error" | "install_progress"
    pub event: String,
    /// Optional kind discriminator
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Optional human-readable message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Optional stage label (e.g. "installing_wandb_attempt_1")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    /// Optional progress percent (0–100)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u8>,
}
