//! Budget governor trait + no-op default.
//!
//! WS1 ships the engine with a `BudgetGovernor` trait and a
//! `NoopBudgetGovernor` that always permits. The real governor —
//! dollar + GPU-hour tracking with escalation thresholds — lands in
//! WS2-T4.
//!
//! This stub exists so the engine's `can_proceed` check compiles and
//! tests can swap in a `RejectingBudgetGovernor` double to verify
//! the "exhausted budget → `EngineResult::BudgetExceeded`" path.

use crate::agent::llm::ToolCall;
use crate::agent::orchestrator::Budget;

/// Trait for budget governance. Implemented by `NoopBudgetGovernor`
/// (always permits) and future real governors (WS2-T4).
pub trait BudgetGovernor: Send + Sync {
    /// Decide whether `tool_call` may proceed given the current
    /// thread `budget`. `false` ⇒ the engine emits
    /// `EngineResult::BudgetExceeded` and the loop pauses.
    fn can_proceed(&self, tool_call: &ToolCall, budget: &Budget) -> bool;

    /// Record the cost of a successful `tool_call` into `budget`.
    /// Called by the engine after each tool execution so the next
    /// `can_proceed` check sees the accumulated spend.
    fn record(&self, tool_call: &ToolCall, budget: &mut Budget);
}

/// No-op governor: always permits and records nothing. Used until
/// WS2-T4 lands the real dollar / GPU-hour accounting.
#[derive(Debug, Clone, Default)]
pub struct NoopBudgetGovernor;

impl NoopBudgetGovernor {
    pub fn new() -> Self {
        Self
    }
}

impl BudgetGovernor for NoopBudgetGovernor {
    fn can_proceed(&self, _tool_call: &ToolCall, _budget: &Budget) -> bool {
        // Phase 0 stub: the real governor tracks spent vs limits.
        true
    }

    fn record(&self, _tool_call: &ToolCall, _budget: &mut Budget) {
        // Phase 0: nothing to record.
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::llm::ToolFunctionCall;

    fn sample_tool_call(name: &str) -> ToolCall {
        ToolCall {
            id: "call_1".to_string(),
            tool_type: "function".to_string(),
            function: ToolFunctionCall {
                name: name.to_string(),
                arguments: "{}".to_string(),
            },
        }
    }

    /// `noop_governor_always_permits`: the default governor lets every
    /// tool call through regardless of budget state.
    #[test]
    fn noop_governor_always_permits() {
        let gov = NoopBudgetGovernor::default();
        let budget = Budget::default();
        assert!(gov.can_proceed(&sample_tool_call("read_file"), &budget));
        assert!(gov.can_proceed(&sample_tool_call("run_shell"), &budget));
    }

    /// `noop_governor_record_is_noop`: `record` mutates nothing so
    /// the budget stays at default after multiple calls.
    #[test]
    fn noop_governor_record_is_noop() {
        let gov = NoopBudgetGovernor::default();
        let mut budget = Budget::default();
        gov.record(&sample_tool_call("read_file"), &mut budget);
        gov.record(&sample_tool_call("run_shell"), &mut budget);
        assert_eq!(budget.spent_dollars, 0.0);
        assert_eq!(budget.spent_gpu_hours, 0.0);
    }

    /// `budget_send_sync`: the trait requires `Send + Sync` so the
    /// engine can hold an `Arc<dyn BudgetGovernor>`. Compile-time
    /// check via a function pointer.
    #[test]
    fn budget_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<NoopBudgetGovernor>();
        assert_send_sync::<Box<dyn BudgetGovernor>>();
    }
}
