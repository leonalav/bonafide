//! Agent engine — BudgetGovernor integration and mode routing.
//!
//! Phase 2 stubs: the tool-call budget check is live; mode routing and
//! the full ReAct loop are wired in Steps 3–4.

use crate::agent::budget::{self, BudgetRegistry};
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
/// Used by the frontend before every compute-intensive tool invocation.
pub async fn check_tool_permission(
    registry: &BudgetRegistry,
    workspace_root: &Path,
    tool_name: &str,
) -> ToolPermission {
    use crate::agent::budget::EscalationLevel;
    let hash = crate::agent::compute_workspace_hash(workspace_root);
    let guard = registry.read().await;
    match guard.get(&hash) {
        Some(budget) => {
            let escalation = budget.escalation();
            let can = budget.can_proceed(tool_name);
            ToolPermission {
                allowed: can.is_ok(),
                escalation: format!("{:?}", escalation).to_lowercase(),
                requires_approval: matches!(
                    escalation,
                    EscalationLevel::Critical | EscalationLevel::Exhausted
                ),
                message: if can.is_err() {
                    Some(format!(
                        "Budget {} — {} tools require approval.",
                        escalation.label(),
                        tool_name
                    ))
                } else {
                    None
                },
            }
        }
        None => ToolPermission {
            allowed: true,
            escalation: "normal".to_string(),
            requires_approval: false,
            message: None,
        },
    }
}
