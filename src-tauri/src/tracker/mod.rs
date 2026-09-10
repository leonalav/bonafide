//! Tracker module — shim process management, credential storage, and
//! communication with the bonafide-run backend.

use serde::{Deserialize, Serialize};

pub mod credentials;
pub mod error;
pub mod mlflow;
pub mod wandb;

pub use credentials::{delete_credential, get_credential, keyring_entry, keyring_service, set_credential};
pub use error::{TrackerError, TrackerErrorKind};
pub use mlflow::{
    connect_mlflow, disconnect_mlflow, get_mlflow_provider, is_mlflow_connected,
    load_mlflow_from_keyring, MlflowProvider,
};
pub use wandb::{
    connect_tracker, disconnect_tracker, get_wandb_provider, is_tracker_connected,
    test_tracker_connection, ArtifactRef, Point, RunConfig, RunDetail, RunPage, RunSummary,
    WandbProvider,
};

/// Strongly-typed discriminator for the supported tracker providers.
///
/// Use this in place of raw `&str` or `String` comparisons when
/// dispatching commands to the right provider implementation. The
/// `FromStr` impl converts the wire string (`"wandb"` / `"mlflow"`)
/// into the enum and returns a structured `TrackerError` on an
/// unsupported value, so Tauri commands can fail fast at the boundary
/// instead of falling through to a hand-rolled `match kind.as_str()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackerKind {
    Wandb,
    Mlflow,
}

impl TrackerKind {
    /// Wire string used by the renderer and the registry.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Wandb => "wandb",
            Self::Mlflow => "mlflow",
        }
    }
}

impl std::fmt::Display for TrackerKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for TrackerKind {
    type Err = TrackerError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "wandb" => Ok(Self::Wandb),
            "mlflow" => Ok(Self::Mlflow),
            other => Err(TrackerError {
                kind: TrackerErrorKind::Unknown,
                message: format!("Unsupported tracker kind: {other}"),
                hint: Some("Supported trackers: wandb, mlflow".to_string()),
            }),
        }
    }
}

/// Result of probing a tracker connection — `connected` is the headline
/// field, with `latency_ms` populated when the probe succeeded and
/// `error_kind` populated when it failed. Serialized camelCase so the
/// renderer can drop it into its `TrackerStatus` store as-is.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerStatus {
    pub connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
}

impl TrackerStatus {
    /// Build a successful status with the observed round-trip time.
    pub fn ok(latency_ms: u64) -> Self {
        Self {
            connected: true,
            latency_ms: Some(latency_ms),
            error_kind: None,
        }
    }

    /// Build a failed status carrying the serialized error kind.
    pub fn failed(kind: TrackerErrorKind, latency_ms: Option<u64>) -> Self {
        Self {
            connected: false,
            latency_ms,
            error_kind: Some(kind_to_string(kind)),
        }
    }
}

/// Render a `TrackerErrorKind` as the snake_case string the renderer
/// expects (matches the `#[serde(rename_all = "snake_case")]` policy on
/// the enum itself, so any new variant stays in sync).
pub fn kind_to_string(kind: TrackerErrorKind) -> String {
    serde_json::to_value(kind)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| "unknown".to_string())
}
