//! Tool registry STUB — replaced by the real registry in WS2-T1.
//!
//! WS1 ships the engine with a tool-free placeholder so the ReAct
//! loop compiles and the tests don't drag in real tool implementations.
//! WS2-T1 deletes this file and introduces the real `ToolRegistry`
//! that wires every Bonafide tool (section 4 of the spec).
//!
//! ## Why a stub
//!
//! The engine doesn't know which tools to offer for a given role
//! until the registry is filled in. The stub answers `definitions_for_role`
//! with `vec![]` so a model with no tools to call terminates cleanly
//! (section 7.2 step 2: empty `tool_calls` ⇒ final answer).
//!
//! `execute` always returns `ToolResult::skipped("not-yet-wired")` so
//! the loop can call it without panicking — the trace step records
//! the skip rather than failing the iteration.

use std::fmt;

use crate::agent::llm::{ChatMessage, ToolCall, ToolDefinition};
use crate::agent::orchestrator::AgentRole;

// ── ToolResult ───────────────────────────────────────────────────────────────

/// Result of a tool execution. Mirrors the section-7.2 spec shape:
/// `Tool: <name> → <summary>` is the summary string rendered into the
/// trace step when a tool call completes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolResult {
    /// Tool executed successfully; `summary` carries a one-line render.
    Ok { summary: String },
    /// Tool was intentionally skipped (e.g. registry not yet wired).
    Skipped { reason: String },
    /// Tool execution failed; `error` carries the human-readable cause.
    Error { error: String },
}

impl ToolResult {
    /// True when the result is `Ok`.
    pub fn is_ok(&self) -> bool {
        matches!(self, Self::Ok { .. })
    }

    /// One-line summary used by the engine to format trace steps.
    pub fn summary(&self) -> String {
        match self {
            Self::Ok { summary } => summary.clone(),
            Self::Skipped { reason } => format!("(skipped: {reason})"),
            Self::Error { error } => format!("(error: {error})"),
        }
    }

    /// Convenience: a `Skipped` result with a caller-supplied reason.
    pub fn skipped(reason: impl Into<String>) -> Self {
        Self::Skipped { reason: reason.into() }
    }
}

impl fmt::Display for ToolResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.summary())
    }
}

// ── ToolRegistryStub ─────────────────────────────────────────────────────────

/// Stub tool registry for the engine. Holds no real tools; every
/// `execute` returns `ToolResult::skipped("not-yet-wired")` and every
/// `definitions_for_role` returns `vec![]`.
#[derive(Debug, Clone, Default)]
pub struct ToolRegistryStub;

impl ToolRegistryStub {
    /// Construct a fresh stub. Used by `AgentEngine::new` and tests.
    pub fn new() -> Self {
        Self
    }

    /// Return the tool definitions offered to the model for a given
    /// agent role. The stub returns an empty vector — WS2-T1 fills
    /// this in with the section-4 tool catalog.
    pub async fn definitions_for_role(&self, _role: AgentRole) -> Vec<ToolDefinition> {
        Vec::new()
    }

    /// Execute a tool call. The stub always returns `Skipped` so the
    /// engine's loop can run end-to-end before WS2-T1 lands.
    pub async fn execute(&self, tc: &ToolCall) -> ToolResult {
        ToolResult::skipped(format!(
            "tool '{}' is not yet wired (registry stub active)",
            tc.function.name
        ))
    }

    /// Format a trace step acknowledging the tool call (regardless of
    /// whether the underlying execution succeeded). Matches the
    /// section-7.2 step-3 expectation: `Tool: <name> → <summary>`.
    pub async fn render_trace_step(&self, tc: &ToolCall) -> String {
        let result = self.execute(tc).await;
        format!("Tool: {} → {}", tc.function.name, result.summary())
    }

    /// Inject a tool result into the message history as a `ChatMessage::tool`.
    /// This is the inverse of the model's tool call: the engine appends the
    /// result so the next iteration observes it via `build_messages`.
    pub fn tool_result_message(tc: &ToolCall, result: &ToolResult) -> ChatMessage {
        ChatMessage::tool(result.summary(), tc.id.clone())
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_tool_call(name: &str, id: &str) -> ToolCall {
        ToolCall {
            id: id.to_string(),
            tool_type: "function".to_string(),
            function: crate::agent::llm::ToolFunctionCall {
                name: name.to_string(),
                arguments: "{}".to_string(),
            },
        }
    }

    /// `execute_returns_skipped`: every tool call returns a
    /// `ToolResult::Skipped` with a reason message.
    #[tokio::test]
    async fn execute_returns_skipped() {
        let stub = ToolRegistryStub::default();
        let tc = sample_tool_call("read_file", "call_1");
        let result = stub.execute(&tc).await;
        assert_eq!(
            result.summary(),
            "(skipped: tool 'read_file' is not yet wired (registry stub active))"
        );
        assert!(!result.is_ok(), "skipped is not Ok");
    }

    /// `definitions_for_role_returns_empty`: no tool definitions are
    /// offered to the model, so a model without tool calls terminates
    /// cleanly on the first iteration.
    #[tokio::test]
    async fn definitions_for_role_returns_empty() {
        let stub = ToolRegistryStub::default();
        let defs = stub.definitions_for_role(AgentRole::Debugger).await;
        assert!(
            defs.is_empty(),
            "stub registry must return no definitions"
        );
    }

    /// `render_trace_step_emits_summary`: the trace step renderer
    /// emits `Tool: <name> → <summary>` exactly like section 7.2
    /// step 3.
    #[tokio::test]
    async fn render_trace_step_emits_summary() {
        let stub = ToolRegistryStub::default();
        let tc = sample_tool_call("read_file", "call_1");
        let line = stub.render_trace_step(&tc).await;
        assert!(line.starts_with("Tool: read_file → "));
    }

    /// `tool_result_message_wires_call_id`: the `ChatMessage::tool`
    /// constructor carries the call id so the next iteration observes
    /// the result via `build_messages`.
    #[test]
    fn tool_result_message_wires_call_id() {
        let tc = sample_tool_call("read_file", "call_42");
        let result = ToolResult::Ok {
            summary: "file contents".to_string(),
        };
        let msg = ToolRegistryStub::tool_result_message(&tc, &result);
        assert_eq!(msg.role, crate::agent::llm::Role::Tool);
        assert_eq!(msg.tool_call_id.as_deref(), Some("call_42"));
        assert_eq!(msg.content, "file contents");
    }
}
