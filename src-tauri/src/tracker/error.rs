//! Error types for the tracker module.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Variants of errors that can occur during tracker operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrackerErrorKind {
    /// No Python interpreter could be found.
    NoPython,
    /// Authentication with the tracker service failed.
    AuthFailed,
    /// A requested resource (e.g. run) was not found.
    NotFound,
    /// The tracker service is rate-limiting requests.
    RateLimited,
    /// The shim process crashed unexpectedly.
    ShimCrashed,
    /// An unexpected error occurred.
    Unknown,
}

/// A structured error from the tracker subsystem.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerError {
    pub kind: TrackerErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl fmt::Display for TrackerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{:?}] {}", self.kind, self.message)
    }
}

impl std::error::Error for TrackerError {}

impl TrackerError {
    /// Constructs a [`NoPython`](TrackerErrorKind::NoPython) error.
    pub fn no_python(hint: &str) -> Self {
        Self {
            kind: TrackerErrorKind::NoPython,
            message: "No Python interpreter found".to_string(),
            hint: Some(hint.to_string()),
        }
    }

    /// Constructs an [`AuthFailed`](TrackerErrorKind::AuthFailed) error.
    pub fn auth_failed(msg: &str) -> Self {
        Self {
            kind: TrackerErrorKind::AuthFailed,
            message: msg.to_string(),
            hint: None,
        }
    }

    /// Constructs a [`NotFound`](TrackerErrorKind::NotFound) error for a missing run.
    pub fn not_found(run_id: &str) -> Self {
        Self {
            kind: TrackerErrorKind::NotFound,
            message: format!("Run not found: {run_id}"),
            hint: None,
        }
    }

    /// Constructs a [`RateLimited`](TrackerErrorKind::RateLimited) error.
    pub fn rate_limited(retry_after: u64) -> Self {
        Self {
            kind: TrackerErrorKind::RateLimited,
            message: format!("Rate limited; retry after {} seconds", retry_after),
            hint: None,
        }
    }

    /// Constructs a [`ShimCrashed`](TrackerErrorKind::ShimCrashed) error.
    pub fn shim_crashed(msg: &str) -> Self {
        Self {
            kind: TrackerErrorKind::ShimCrashed,
            message: format!("Shim process crashed: {msg}"),
            hint: None,
        }
    }
}
