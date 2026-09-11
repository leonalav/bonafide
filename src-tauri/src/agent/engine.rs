//! Agent engine — tool-permission gate and mode routing.
//!
//! Phase 0 reset (WS0-T1): the BudgetRegistry integration was removed.
//! The stub returns `allowed: true` so the renderer can keep calling
//! `check_tool_permission` while the real governor is rebuilt in
//! WS2-T4.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Result of checking whether a tool call is permitted.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPermission {
    pub allowed: bool,
    pub escalation: String,
    pub requires_approval: bool,
    pub message: Option<String>,
}

/// Check whether a tool call is permitted under the current budget.
///
/// Phase 0 stub: always allow. Real BudgetRegistry wiring returns in
/// WS2-T4 — until then this is a no-op gate that preserves the IPC
/// contract for the renderer.
#[allow(dead_code)]
pub async fn check_tool_permission(
    _workspace_root: &Path,
    _tool_name: &str,
) -> ToolPermission {
    ToolPermission {
        allowed: true,
        escalation: "normal".into(),
        requires_approval: false,
        message: None,
    }
}