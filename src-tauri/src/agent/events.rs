//! Agent event sink — Tauri-runtime impl.
//!
//! This module re-exports the pure `AgentEventSink` trait, `AgentEvent`
//! payload, `ArtifactStatus`, and `NoopAgentEventSink` from
//! `bonafide_core::agent::events`, then adds the Tauri-backed
//! `TauriAgentEventSink` impl that the production engine wires in
//! via `WorkspaceAgentState::build_engine` in `ipc.rs`.
//!
//! The split is what makes `cargo test -p bonafide-core` work
//! without ever linking tauri (and therefore without needing
//! `vcruntime140_1.dll` next to the test binary). The trait lives
//! in `bonafide_core`; only the impl is Tauri-coupled.

pub use bonafide_core::agent::events::*;

// Bring the `ToolCall` / `ToolResult` types into scope so the impl
// block below can name them in its method signatures (the trait's
// signatures already reference these names; the impls must match).
use crate::agent::llm::ToolCall;
use crate::agent::tools::ToolResult;

// ── Tauri-backed impl ─────────────────────────────────────────────────────────
//
// Gated behind `#[cfg(not(test))]` because the Tauri AppHandle links
// native DLLs that the `cargo test` harness can't resolve on Windows
// (STATUS_ENTRYPOINT_NOT_FOUND). Tests use `NoopAgentEventSink` and
// the `RecordingSink` defined in the `tests` module below; the
// production binary compiled by `cargo build --release` is unaffected.
#[cfg(not(test))]
mod tauri_impl {
    use super::*;
    use tauri::Emitter;

    /// Tauri-backed event sink. Holds an `AppHandle` clone (cheap — the
    /// handle is internally `Arc`'d) and publishes events via
    /// `app_handle.emit(&topic, payload)`.
    ///
    /// The topic is `event_topic(thread_id)` so subscribers must scope
    /// their listener to a specific thread id. We don't publish on a
    /// wildcard topic because the renderer should only see events for
    /// the thread it's currently displaying — a different tab or the
    /// run-investigation surface shouldn't accidentally consume events
    /// for a chat thread it doesn't own.
    #[derive(Debug, Clone)]
    pub struct TauriAgentEventSink {
        app_handle: tauri::AppHandle,
    }

    impl TauriAgentEventSink {
        pub fn new(app_handle: tauri::AppHandle) -> Self {
            Self { app_handle }
        }

        pub(super) fn emit(&self, thread_id: &str, event: &AgentEvent) {
            // `emit` is fire-and-forget — we don't propagate the error
            // because a dropped event is recoverable (the final
            // `agent_send_message` payload still carries the
            // accumulated artifacts, so the renderer catches up on the
            // .then() handler even if a streaming event was lost).
            let topic = event_topic(thread_id);
            if let Err(e) = self.app_handle.emit(&topic, event) {
                log::warn!(
                    "[agent_events] failed to publish event on {topic}: {e}"
                );
            }
        }
    }

    impl AgentEventSink for TauriAgentEventSink {
        fn on_iteration_started(&self, thread_id: &str, iteration: u32) {
            self.emit(
                thread_id,
                &AgentEvent::IterationStarted {
                    thread_id: thread_id.to_string(),
                    iteration,
                },
            );
        }

        fn on_assistant_message(&self, thread_id: &str, content: &str) {
            if content.is_empty() {
                return;
            }
            self.emit(
                thread_id,
                &AgentEvent::AssistantMessage {
                    thread_id: thread_id.to_string(),
                    content: content.to_string(),
                },
            );
        }

        fn on_tool_call_started(
            &self,
            thread_id: &str,
            tool_call: &ToolCall,
            display_name: &str,
            target: Option<String>,
        ) {
            self.emit(
                thread_id,
                &AgentEvent::ToolCallStarted {
                    thread_id: thread_id.to_string(),
                    tool_call_id: tool_call.id.clone(),
                    tool_name: tool_call.function.name.clone(),
                    display_name: display_name.to_string(),
                    target,
                    args: tool_call.function.arguments.clone(),
                },
            );
        }

        fn on_tool_call_completed(
            &self,
            thread_id: &str,
            tool_call: &ToolCall,
            result: &ToolResult,
            output: Option<String>,
            result_summary: Option<String>,
        ) {
            let status = ArtifactStatus::from(result);
            self.emit(
                thread_id,
                &AgentEvent::ToolCallCompleted {
                    thread_id: thread_id.to_string(),
                    tool_call_id: tool_call.id.clone(),
                    status,
                    output,
                    result_summary,
                },
            );
        }

        fn on_tool_call_deduped(
            &self,
            thread_id: &str,
            tool_call: &ToolCall,
            reason: &str,
        ) {
            self.emit(
                thread_id,
                &AgentEvent::ToolCallDeduped {
                    thread_id: thread_id.to_string(),
                    tool_call_id: tool_call.id.clone(),
                    tool_name: tool_call.function.name.clone(),
                    reason: reason.to_string(),
                },
            );
        }

        fn on_state_transition(
            &self,
            thread_id: &str,
            from: &str,
            to: &str,
            reason: &str,
        ) {
            self.emit(
                thread_id,
                &AgentEvent::StateTransition {
                    thread_id: thread_id.to_string(),
                    from: from.to_string(),
                    to: to.to_string(),
                    reason: reason.to_string(),
                },
            );
        }
    }
}

#[cfg(not(test))]
pub use tauri_impl::TauriAgentEventSink;

// Stub used by tests when the Tauri impl is gated out — never
// instantiated, but keeps the symbol available for `use` statements
// in callers that don't need Tauri runtime. Implements the trait
// with no-op bodies so `ipc.rs` can `Arc::new(TauriAgentEventSink::new(...))`
// inside the `#[cfg(test)]` lib build without a trait-not-satisfied
// error.
#[cfg(test)]
#[derive(Debug, Clone)]
pub struct TauriAgentEventSink;

#[cfg(test)]
impl TauriAgentEventSink {
    pub fn new(_app_handle: tauri::AppHandle) -> Self {
        Self
    }
}

#[cfg(test)]
impl AgentEventSink for TauriAgentEventSink {
    fn on_iteration_started(&self, _thread_id: &str, _iteration: u32) {}
    fn on_assistant_message(&self, _thread_id: &str, _content: &str) {}
    fn on_tool_call_started(
        &self,
        _thread_id: &str,
        _tool_call: &ToolCall,
        _display_name: &str,
        _target: Option<String>,
    ) {
    }
    fn on_tool_call_completed(
        &self,
        _thread_id: &str,
        _tool_call: &ToolCall,
        _result: &ToolResult,
        _output: Option<String>,
        _result_summary: Option<String>,
    ) {
    }
    fn on_tool_call_deduped(
        &self,
        _thread_id: &str,
        _tool_call: &ToolCall,
        _reason: &str,
    ) {
    }
    fn on_state_transition(
        &self,
        _thread_id: &str,
        _from: &str,
        _to: &str,
        _reason: &str,
    ) {
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// `noop_sink_is_available_after_re_export`: confirms the
    /// `pub use bonafide_core::agent::events::*` line at the top
    /// of this module surfaces `NoopAgentEventSink` to callers
    /// using the `crate::agent::events::NoopAgentEventSink` path.
    /// Without the re-export this would be a private-in-crate
    /// error after the split.
    #[test]
    fn noop_sink_is_available_after_re_export() {
        let sink = NoopAgentEventSink;
        sink.on_iteration_started("t", 1);
    }

    /// `agent_event_topic_is_thread_scoped_via_re_export`: the
    /// `event_topic` fn lives in `bonafide_core`; this test
    /// confirms it's accessible via `crate::agent::events::`
    /// after the re-export.
    #[test]
    fn agent_event_topic_is_thread_scoped_via_re_export() {
        assert_eq!(event_topic("abc"), "agent://thread/abc/event");
    }
}
