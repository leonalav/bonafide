// Shim stdio protocol — JSON-RPC types for W&B adapter communication.
// All JSON-RPC requests are written to the shim subprocess's stdin and
// responses are read from its stdout.

use serde::{Deserialize, Serialize};

/// Inbound request from the Tauri app to the shim Python process.
/// Serialized as `{"method": "ListRuns", "params": {...}}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum ShimRequest {
    #[serde(rename = "ListRuns")]
    ListRuns {
        #[serde(default)]
        filters: Option<serde_json::Value>,
    },

    #[serde(rename = "GetRun")]
    GetRun {
        #[serde(default)]
        filters: Option<serde_json::Value>,
    },

    #[serde(rename = "GetMetricSeries")]
    GetMetricSeries {
        #[serde(default)]
        filters: Option<serde_json::Value>,
    },

    #[serde(rename = "GetRunConfig")]
    GetRunConfig {
        #[serde(default)]
        filters: Option<serde_json::Value>,
    },

    #[serde(rename = "ListArtifacts")]
    ListArtifacts {
        #[serde(default)]
        filters: Option<serde_json::Value>,
    },
}

/// Outbound response from the shim Python process to the Tauri app.
/// Serialized as `{"type": "Result", "id": ..., "result": ...}` or
/// `{"type": "Error", "id": ..., "error": {...}}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ShimResponse {
    #[serde(rename = "Result")]
    Result {
        id: u64,
        #[serde(default)]
        result: Option<serde_json::Value>,
    },

    #[serde(rename = "Error")]
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
#[serde(rename_all = "camelCase")]
pub struct ShimEvent {
    /// Name of the event, e.g. "trigger".
    pub event: String,

    /// Event kind, e.g. "run", "summary", "stdout".
    pub kind: String,

    /// Human-readable message associated with the event.
    pub message: String,

    /// Optional stage label (e.g. "downloading", "indexing").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,

    /// Optional progress percentage 0–100.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
}
