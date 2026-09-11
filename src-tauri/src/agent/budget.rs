//! Budget Governor — cost model, escalation levels, and per-workspace budget enforcement.
//!
//! The BudgetGovernor lives in Tauri app state. It tracks dollars and GPU hours
//! spent vs. a configurable budget. Escalation levels gate which tool calls are
//! permitted based on remaining budget.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

// ── Cost model ────────────────────────────────────────────────────────────────

/// Estimated cost and GPU cost of a single tool invocation.
/// These are conservative per-call estimates for budget accounting.
/// User-configurable values will replace these in a future iteration.
#[derive(Debug, Clone, Copy)]
pub struct ToolCost {
    /// Dollar cost of one invocation (API tokens + compute).
    pub dollars: f64,
    /// GPU-hours consumed by one invocation.
    pub gpu_hours: f64,
}

impl ToolCost {
    pub const ZERO: ToolCost = ToolCost { dollars: 0.0, gpu_hours: 0.0 };
}

/// Hardcoded per-tool cost estimates.
/// Tools that are pure reads cost nothing; compute-intensive tools have a price.
pub fn tool_cost(tool_name: &str) -> ToolCost {
    match tool_name {
        // Read-only — no cost
        "read_file" | "list_runs" | "get_run" | "read_directory" | "git_status"
        | "git_log" | "git_diff" | "git_list_branches" | "query_code_graph"
        | "query_run_graph" | "index_code_graph" => ToolCost::ZERO,

        // Lightweight compute
        "run_shell" | "ruff_check" | "get_metric_series" | "get_run_config"
        | "list_artifacts" | "git_add" | "git_unstage" | "git_discard"
        | "git_fetch" => ToolCost { dollars: 0.01, gpu_hours: 0.0 },

        // Smoke test — GPU overhead for a short run
        "run_smoke_test" => ToolCost { dollars: 0.10, gpu_hours: 0.02 },

        // Full experiment run — most expensive
        "launch_experiment_run" => ToolCost { dollars: 2.00, gpu_hours: 1.0 },

        // Writes (moderate)
        "write_file" | "create_file" | "create_folder" | "rename_path"
        | "delete_path" | "git_commit" | "git_checkout" | "git_pull"
        | "git_push" | "git_init" => ToolCost { dollars: 0.05, gpu_hours: 0.0 },

        // Unknown tool — conservative estimate
        _ => ToolCost { dollars: 0.10, gpu_hours: 0.01 },
    }
}

// ── Escalation levels ─────────────────────────────────────────────────────────

/// How aggressively the governor gates tool calls based on budget consumption.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EscalationLevel {
    /// Budget < 50% spent. Normal operation — no restrictions.
    Normal,
    /// Budget 50–80% spent. Agent mentions budget constraints in replies.
    Caution,
    /// Budget 80–100% spent. Every compute tool requires explicit approval.
    Critical,
    /// Budget exhausted (>100%). Only read-only tools are permitted.
    Exhausted,
}

impl EscalationLevel {
    /// Compute the escalation level from the dollar spend ratio.
    /// GPU-hours ratio is checked separately via `can_proceed`.
    pub fn from_spend_ratio(spend_ratio: f64) -> Self {
        if spend_ratio < 0.50 {
            EscalationLevel::Normal
        } else if spend_ratio < 0.80 {
            EscalationLevel::Caution
        } else if spend_ratio < 1.00 {
            EscalationLevel::Critical
        } else {
            EscalationLevel::Exhausted
        }
    }

    /// Human-readable label for UI display.
    pub fn label(&self) -> &'static str {
        match self {
            EscalationLevel::Normal => "Normal",
            EscalationLevel::Caution => "Caution",
            EscalationLevel::Critical => "Critical",
            EscalationLevel::Exhausted => "Exhausted",
        }
    }
}

// ── Budget state ─────────────────────────────────────────────────────────────

/// Per-workspace budget snapshot returned to the renderer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    /// Workspace hash this status belongs to.
    pub workspace_hash: String,
    /// Maximum dollars allocated for this workspace session.
    pub budget_dollars: f64,
    /// Maximum GPU hours allocated for this workspace session.
    pub budget_gpu_hours: f64,
    /// Dollars consumed so far.
    pub spent_dollars: f64,
    /// GPU hours consumed so far.
    pub spent_gpu_hours: f64,
    /// Current escalation level.
    pub escalation: String,
    /// Fraction of budget consumed (0.0–1.0+). Used for the progress bar.
    pub spend_ratio: f64,
    /// Whether the next compute tool call will require user approval.
    pub requires_approval: bool,
}

impl BudgetStatus {
    pub fn new(workspace_hash: String, budget_dollars: f64, budget_gpu_hours: f64) -> Self {
        Self {
            workspace_hash,
            budget_dollars,
            budget_gpu_hours,
            spent_dollars: 0.0,
            spent_gpu_hours: 0.0,
            escalation: "normal".to_string(),
            spend_ratio: 0.0,
            requires_approval: false,
        }
    }
}

/// Mutable per-workspace budget state held in Tauri app state.
#[derive(Debug, Clone)]
pub struct WorkspaceBudget {
    pub workspace_hash: String,
    pub budget_dollars: f64,
    pub budget_gpu_hours: f64,
    pub spent_dollars: f64,
    pub spent_gpu_hours: f64,
}

impl Default for WorkspaceBudget {
    fn default() -> Self {
        Self {
            workspace_hash: String::new(),
            budget_dollars: 10.0,
            budget_gpu_hours: 4.0,
            spent_dollars: 0.0,
            spent_gpu_hours: 0.0,
        }
    }
}

impl WorkspaceBudget {
    pub fn escalation(&self) -> EscalationLevel {
        let ratio = if self.budget_dollars > 0.0 {
            self.spent_dollars / self.budget_dollars
        } else {
            0.0
        };
        EscalationLevel::from_spend_ratio(ratio)
    }

    pub fn status(&self) -> BudgetStatus {
        let ratio = if self.budget_dollars > 0.0 {
            self.spent_dollars / self.budget_dollars
        } else {
            0.0
        };
        let escalation = self.escalation();
        let requires_approval = matches!(
            escalation,
            EscalationLevel::Critical | EscalationLevel::Exhausted
        );
        BudgetStatus {
            workspace_hash: self.workspace_hash.clone(),
            budget_dollars: self.budget_dollars,
            budget_gpu_hours: self.budget_gpu_hours,
            spent_dollars: self.spent_dollars,
            spent_gpu_hours: self.spent_gpu_hours,
            escalation: format!("{:?}", escalation).to_lowercase(),
            spend_ratio: ratio,
            requires_approval,
        }
    }

    /// Record the cost of one tool call. Returns the updated escalation level.
    pub fn record_tool(&mut self, tool_name: &str) -> EscalationLevel {
        let cost = tool_cost(tool_name);
        self.spent_dollars = (self.spent_dollars + cost.dollars).min(self.budget_dollars * 2.0);
        self.spent_gpu_hours = (self.spent_gpu_hours + cost.gpu_hours)
            .min(self.budget_gpu_hours * 2.0);
        self.escalation()
    }

    /// Check whether a tool call is permitted under the current escalation level.
    /// Returns `Ok(escalation)` if permitted, `Err(escalation)` if blocked.
    /// Both dollar and GPU-hour budgets are enforced.
    pub fn can_proceed(&self, tool_name: &str) -> Result<EscalationLevel, EscalationLevel> {
        let escalation = self.escalation();
        let cost = tool_cost(tool_name);

        // Read-only tools are always permitted.
        if cost.dollars == 0.0 && cost.gpu_hours == 0.0 {
            return Ok(escalation);
        }

        // GPU-hours budget: block if exhausted or critical on the GPU axis.
        if cost.gpu_hours > 0.0 && self.budget_gpu_hours > 0.0 {
            let gpu_ratio = self.spent_gpu_hours / self.budget_gpu_hours;
            if gpu_ratio >= 1.0 {
                return Err(EscalationLevel::Exhausted);
            }
            if gpu_ratio >= 0.8 {
                return Err(EscalationLevel::Critical);
            }
        }

        match escalation {
            EscalationLevel::Normal | EscalationLevel::Caution => Ok(escalation),
            EscalationLevel::Critical | EscalationLevel::Exhausted => Err(escalation),
        }
    }
}

// ── Global budget registry ───────────────────────────────────────────────────

/// Global registry of per-workspace budgets.
/// Keyed by workspace hash; created lazily on first access.
pub type BudgetRegistry = Arc<RwLock<HashMap<String, WorkspaceBudget>>>;

/// Get or create a WorkspaceBudget for a workspace hash.
#[allow(dead_code)]
pub async fn get_or_create_budget<'a>(
    registry: &'a BudgetRegistry,
    workspace_hash: &str,
) -> tokio::sync::RwLockWriteGuard<'a, HashMap<String, WorkspaceBudget>> {
    let mut guard = registry.write().await;
    if !guard.contains_key(workspace_hash) {
        guard.insert(workspace_hash.to_string(), WorkspaceBudget {
            workspace_hash: workspace_hash.to_string(),
            ..Default::default()
        });
    }
    guard
}

/// Get the budget status for a workspace, lazily creating a default budget if needed.
pub async fn get_budget_status(
    registry: &BudgetRegistry,
    workspace_hash: &str,
) -> BudgetStatus {
    let mut guard = registry.write().await;
    guard.entry(workspace_hash.to_string())
        .or_insert_with(|| WorkspaceBudget {
            workspace_hash: workspace_hash.to_string(),
            ..Default::default()
        })
        .status()
}

/// Update budget limits for a workspace.
pub async fn update_budget(
    registry: &BudgetRegistry,
    workspace_hash: &str,
    budget_dollars: f64,
    budget_gpu_hours: f64,
) -> BudgetStatus {
    let mut guard = registry.write().await;
    let budget = guard.entry(workspace_hash.to_string())
        .or_insert_with(|| WorkspaceBudget {
            workspace_hash: workspace_hash.to_string(),
            ..Default::default()
        });
    budget.budget_dollars = budget_dollars;
    budget.budget_gpu_hours = budget_gpu_hours;
    budget.status()
}

/// Record a tool call cost and return the new escalation level.
/// Lazily creates a default budget on first call.
pub async fn record_tool_call(
    registry: &BudgetRegistry,
    workspace_hash: &str,
    tool_name: &str,
) -> Option<EscalationLevel> {
    let mut guard = registry.write().await;
    let budget = guard.entry(workspace_hash.to_string())
        .or_insert_with(|| WorkspaceBudget {
            workspace_hash: workspace_hash.to_string(),
            ..Default::default()
        });
    Some(budget.record_tool(tool_name))
}

/// Check if a tool call is permitted.
pub async fn can_proceed(
    registry: &BudgetRegistry,
    workspace_hash: &str,
    tool_name: &str,
) -> bool {
    let guard = registry.read().await;
    guard.get(workspace_hash)
        .map(|b| b.can_proceed(tool_name).is_ok())
        .unwrap_or(true) // no budget record = no restrictions
}
