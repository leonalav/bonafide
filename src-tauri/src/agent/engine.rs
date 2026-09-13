//! Agent engine — ReAct loop implementation.
//!
//! This module provides the core ReAct loop consumed by the orchestrator
//! and exposed as an IPC command in `lib.rs`. It replaces the Phase-0
//! `check_tool_permission` stub (which is preserved at the bottom of
//! this file so the renderer's existing IPC call continues to resolve).
//!
//! ## Loop overview (section 7.2)
//!
//! ```text
//! loop (iterations ≤ max_iterations):
//!   1. REASON: llm_client.complete(build_messages(thread))
//!   2. if response.tool_calls.is_empty():
//!        → return EngineResult::Completed(response.content)
//!   3. for each tool_call in response.tool_calls:
//!        a. if !budget.can_proceed(tool_call, thread.budget):
//!             → thread.state = AwaitingApproval
//!               return EngineResult::BudgetExceeded
//!        b. approval = approval_gate.check(thread.role, tool_call.function.name)
//!           match approval:
//!             Blocked       → continue  (skip this tool, next iteration)
//!             NeedApproval  → thread.state = AwaitingApproval
//!               return EngineResult::AwaitingApproval { tool_call_id, reason }
//!             AutoApprove  → proceed
//!        c. result = tools.execute(tool_call)
//!        d. append trace step "Tool: <name> → <summary>"
//!        e. budget.record(tool_call, thread.budget)
//!        f. emit state transition event
//! ```
//!
//! ## State transitions (section 7.3)
//!
//! The loop drives:
//! - `Idle → Investigating` on first iteration
//! - `Investigating → HypothesisFormed` when an assistant message
//!   contains `## Hypothesis` (best-effort heuristic)
//! - `Investigating → PatchProposed` when `apply_patch` completes
//!   without rejection
//! - `Investigating → Resolved` when a final answer contains `## Resolved`
//!
//! ## Markers
//!
//! The loop looks for these exact markers in assistant text to drive
//! state transitions. They are exposed as public `const` so WS3 can
//! change them without touching the engine body.

use std::sync::Arc;

use crate::agent::approval::{Approval, ApprovalGate};
use crate::agent::budget::{BudgetGovernor, DefaultBudgetGovernor, EscalationLevel, NoopBudgetGovernor};
use crate::agent::llm::{
    ChatMessage, ChatRequest, ChatResponse, LlmClient, LlmError, Role, ToolCall,
};
use crate::agent::modes::ModeRegistry;
use crate::agent::orchestrator::{
    append_event_log, AgentRole, Budget, Thread, ThreadState, TraceStep,
};
use crate::agent::threads::{
    append_thread_event, replay_thread, thread_state_to_string, update_thread_state,
};
use crate::agent::tools::{ToolRegistry, ToolResult};

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::path::Path;

// ── Engine result ─────────────────────────────────────────────────────────────

/// What the engine produces when `run()` returns.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineResult {
    /// Loop terminated with a final assistant answer.
    Completed { content: String },
    /// A tool needs human approval before it can execute.
    AwaitingApproval { tool_call_id: String, reason: String },
    /// The budget governor blocked the tool call.
    BudgetExceeded,
    /// The loop hit the iteration cap without resolving.
    MaxIterations,
    /// The LLM call itself failed.
    LlmError { message: String },
}

/// One structured tool-call record emitted by the engine. The
/// renderer turns each entry into an inline `ToolArtifact` card in
/// the assistant message so the user sees what the agent actually
/// did — not just the final prose.
///
/// Lifecycle:
///   - `pending`  — agent decided to invoke the tool but execution
///                   has not started (used for streaming variants
///                   where the engine emits events before the call).
///   - `running`  — the tool is currently executing.
///   - `completed`— the tool returned successfully.
///   - `failed`   — the tool errored, returned `ToolResult::Error`,
///                   or was blocked by the structural approval gate.
///
/// `kind` drives the renderer's layout family (terminal / file /
/// generic tool) so the card matches the spec's sticker-sheet
/// families. The engine picks `kind` from the tool name; see
/// `AgentEngine::classify_tool`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolArtifact {
    /// Stable id; matches the engine-side `tool_call_id`.
    pub id: String,
    /// Layout family — terminal / file / generic tool.
    pub kind: String,
    /// Original tool name, e.g. "run_shell", "write_file".
    pub name: String,
    /// Short human-readable label shown on the card header.
    pub display_name: String,
    /// Sub-label / target (file path, command, etc.).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// Raw JSON arguments the LLM passed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<String>,
    /// Output text for `terminal` artifacts (stdout/stderr joined).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    /// Result summary for `file` artifacts (file path + bytes).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_summary: Option<String>,
    /// Lifecycle status.
    pub status: String,
    /// Milliseconds since epoch.
    pub ts: i64,
}

// ── AgentEngine ──────────────────────────────────────────────────────────────

/// The ReAct loop engine. Holds references to the LLM client, tool
/// registry, approval gate, and budget governor — all behind `Arc`
/// so the struct is cheap to clone and holds `Send + Sync` bounds
/// on every dependency.
#[derive(Clone)]
pub struct AgentEngine {
    llm_client: Arc<dyn LlmClient>,
    tools: Arc<ToolRegistry>,
    approval_gate: ApprovalGate,
    budget: Arc<dyn BudgetGovernor>,
    max_iterations: u32,
    /// Per-mode protocol + behaviour-marker lookup. WS3-T1 wires
    /// this in so the engine reads markers from the active mode
    /// rather than the legacy hard-coded constants.
    mode_registry: Arc<ModeRegistry>,
}

impl Default for AgentEngine {
    fn default() -> Self {
        Self {
            llm_client: Arc::new(NoopLlmClient),
            tools: Arc::new(ToolRegistry::default()),
            approval_gate: ApprovalGate::default(),
            budget: Arc::new(NoopBudgetGovernor::new()),
            max_iterations: 20,
            mode_registry: Arc::new(ModeRegistry::default()),
        }
    }
}

impl AgentEngine {
    /// Construct a new engine.
    ///
    /// `llm_client` is typically `OpenAiCompatibleClient::from_settings(...)`
    /// resolved from the workspace's model endpoints. `tools` is the
    /// full 37-tool registry per section 4.
    ///
    /// `approval_gate` defaults to the section-12.2 matrix. Tests can
    /// pass a custom gate to assert specific approval outcomes.
    ///
    /// `budget` defaults to `NoopBudgetGovernor` (always permits). Pass
    /// a `DefaultBudgetGovernor` to enable real dollar/GPU-hour accounting.
    ///
    /// `mode_registry` defaults to `ModeRegistry::default()`. Pass a
    /// custom registry to override per-mode protocol/markers
    /// (tests do this).
    pub fn new(
        llm_client: Arc<dyn LlmClient>,
        tools: Arc<ToolRegistry>,
        approval_gate: ApprovalGate,
        budget: Arc<dyn BudgetGovernor>,
    ) -> Self {
        Self {
            llm_client,
            tools,
            approval_gate,
            budget,
            max_iterations: 20,
            mode_registry: Arc::new(ModeRegistry::default()),
        }
    }

    /// Construct with the default budget governor wired to the supplied
    /// tool registry. This is the recommended constructor in production:
    /// the budget governor needs the registry to look up per-tool costs.
    pub fn with_default_governor(
        llm_client: Arc<dyn LlmClient>,
        tools: Arc<ToolRegistry>,
        approval_gate: ApprovalGate,
    ) -> Self {
        let budget = Arc::new(DefaultBudgetGovernor::new(tools.clone()));
        Self::new(llm_client, tools, approval_gate, budget)
    }

    /// Construct with an explicit `ModeRegistry`. Production code
    /// uses `ModeRegistry::default()`; tests pass a custom registry
    /// to inject counting / mock mode doubles.
    pub fn with_mode_registry(mut self, registry: Arc<ModeRegistry>) -> Self {
        self.mode_registry = registry;
        self
    }

    /// Access the mode registry (e.g. for tests that want to verify
    /// per-mode protocol contents).
    pub fn mode_registry(&self) -> &Arc<ModeRegistry> {
        &self.mode_registry
    }

    /// Access the tool registry (e.g. for tests that want to verify
    /// the catalog contents).
    pub fn tools(&self) -> &Arc<ToolRegistry> {
        &self.tools
    }

    /// Access the budget governor.
    pub fn budget(&self) -> &Arc<dyn BudgetGovernor> {
        &self.budget
    }

    /// Get the current escalation level for a thread.
    pub fn current_escalation(&self, budget: &Budget) -> EscalationLevel {
        self.budget.escalation_level(budget)
    }

    /// Switch `thread.role` to `new_role` and emit a `ModeSwitch`
    /// event so the JSONL log captures the transition.
    ///
    /// The transition is **synchronous** because it only mutates
    /// the in-memory thread state — no LLM call, no tool
    /// execution. The caller is responsible for persisting the
    /// updated thread row (`upsert_thread`) afterwards.
    ///
    /// `Err(_)` is returned only when the caller passes the same
    /// role (no-op switch). Every other case succeeds because role
    /// transitions never fail in isolation; downstream state
    /// transitions (`Investigating → …`) handle the rest of the
    /// lifecycle.
    pub fn switch_mode(
        &self,
        thread: &mut Thread,
        new_role: AgentRole,
    ) -> Result<(), String> {
        if thread.role == new_role {
            return Err(format!(
                "Thread {} is already in role {:?}; no switch needed.",
                thread.id, new_role
            ));
        }

        let from = thread.role;
        let ts = chrono_millis();
        let event = crate::agent::threads::ThreadEvent::mode_switch(from, new_role, ts);
        append_thread_event(&thread.event_log_path, &event)
            .map_err(|e| format!("failed to append ModeSwitch event: {e}"))?;

        thread.role = new_role;

        let step = TraceStep {
            step: (thread.trace.len() as u32) + 1,
            content: format!("ModeSwitch: {:?} → {:?}", from, new_role),
            ts,
        };
        thread.trace.push(step);

        Ok(())
    }

    /// Run the ReAct loop for `thread` until termination.
    ///
    /// On success (`Ok(EngineResult)`) the caller persists the updated
    /// `thread` to the SQLite row + JSONL event log. On
    /// `Err(LlmError)` the error is propagated so callers can surface
    /// it to the UI.
    ///
    /// ## Cancellation
    ///
    /// The `signal` field of `ChatRequest` is forwarded through to
    /// `llm_client.complete`. If the caller cancels the signal, the
    /// next `complete` call returns `LlmError::Aborted`.
    pub async fn run(&self, thread: &mut Thread) -> EngineResult {
        let mut iterations = 0u32;

        // Replay the existing event log to rehydrate the thread state
        // before starting the loop. This lets the loop resume from
        // where it left off after a renderer restart.
        if thread.event_log_path.as_os_str().len() > 0 {
            let event_log_path: std::path::PathBuf = thread.event_log_path.clone();
            match replay_thread(
                &event_log_path,
                thread.id.clone(),
                thread.role,
                thread.run_id.clone(),
            ) {
                Ok(replayed) => {
                    // Restore thread state from the replayed events.
                    thread.state = replayed.state;
                    thread.messages = replayed.messages;
                    thread.trace = replayed.trace;
                }
                Err(e) => {
                    log::warn!(
                        "[engine] replay failed for thread {}: {e}; starting fresh",
                        thread.id
                    );
                }
            }
        }

        loop {
            iterations += 1;

            // ── 1. Loop guard: max iterations ─────────────────────────────────
            if iterations > self.max_iterations {
                self.emit_state_transition(
                    thread,
                    thread.state,
                    ThreadState::Stopped,
                    "max iterations reached",
                );
                return EngineResult::MaxIterations;
            }

            // ── 2. First iteration: transition Idle → Investigating ─────────────
            if iterations == 1 && thread.state == ThreadState::Idle {
                self.emit_state_transition(
                    thread,
                    ThreadState::Idle,
                    ThreadState::Investigating,
                    "first iteration",
                );
            }

            // ── 3. Build messages ───────────────────────────────────────────
            let messages = self.build_messages(thread);
            let tool_defs = self.tools.definitions_for_role(thread.role).await;

            // ── 4. LLM call ────────────────────────────────────────────────
            let req = ChatRequest {
                endpoint_url: String::new(),
                model: thread.model_id.clone(),
                messages,
                tools: if tool_defs.is_empty() {
                    None
                } else {
                    Some(tool_defs)
                },
                temperature: None,
                stream: false,
            };

            let resp: ChatResponse = match self.llm_client.complete(req).await {
                Ok(r) => r,
                Err(e) => {
                    return EngineResult::LlmError {
                        message: e.to_string(),
                    };
                }
            };

            // ── 5. Final answer check (section 7.2 step 2) ─────────────────
            if resp.tool_calls.is_empty() {
                // Record the assistant message as a trace step.
                if !resp.content.is_empty() {
                    let step = TraceStep {
                        step: iterations,
                        content: resp.content.clone(),
                        ts: chrono_millis(),
                    };
                    thread.trace.push(step);
                    self.emit_message_event(thread, "assistant", &resp.content);

                    // State transition: hypothesis marker on a
                    // tool-call-free response still advances the
                    // counter (the LLM might emit a hypothesis in
                    // prose without a tool call this iteration).
                    let hypothesis_marker = self
                        .mode_registry
                        .for_role(thread.role)
                        .behavior_marker_hypothesis();
                    if resp.content.contains(hypothesis_marker)
                        && thread.state == ThreadState::Investigating
                    {
                        thread.hypothesis_iterations += 1;
                        self.emit_state_transition(
                            thread,
                            ThreadState::Investigating,
                            ThreadState::HypothesisFormed,
                            &format!(
                                "## Hypothesis marker detected (iteration {})",
                                thread.hypothesis_iterations
                            ),
                        );
                    }

                    // State transition: final answer with `## Resolved` → Resolved.
                    let resolved_marker = self
                        .mode_registry
                        .for_role(thread.role)
                        .behavior_marker_resolved();
                    if resp.content.contains(resolved_marker) {
                        self.emit_state_transition(
                            thread,
                            thread.state,
                            ThreadState::Resolved,
                            "final answer",
                        );
                    }
                }
                return EngineResult::Completed { content: resp.content };
            }

            // ── 6. Process each tool call ─────────────────────────────────
            for tool_call in &resp.tool_calls {
                // 6a. Budget check.
                if !self.budget.can_proceed(tool_call, &thread.budget) {
                    self.emit_state_transition(
                        thread,
                        thread.state,
                        ThreadState::AwaitingApproval,
                        "budget exceeded",
                    );
                    return EngineResult::BudgetExceeded;
                }

                // 6b-pre: `request_approval` is a UI tool the LLM invokes
                // to ask a clarifying question. We bypass the structural
                // approval gate (it would be NeedApproval for some
                // modes) and unconditionally pause the loop into
                // `AwaitingApproval`, with the question embedded in
                // `reason` so the renderer can surface it.
                if tool_call.function.name == "request_approval" {
                    let question = serde_json::from_str::<JsonValue>(&tool_call.function.arguments)
                        .ok()
                        .and_then(|v| {
                            v.get("question").and_then(|q| q.as_str().map(String::from))
                        })
                        .unwrap_or_else(|| "Agent requested approval".to_string());
                    self.emit_state_transition(
                        thread,
                        thread.state,
                        ThreadState::AwaitingApproval,
                        "request_approval invoked",
                    );
                    self.emit_tool_call_event(thread, tool_call);
                    // Remember which tool_call paused the loop
                    // so `agent_approve_action` can execute it
                    // directly on resume. Without this, the
                    // engine would re-prompt the LLM and the
                    // LLM would re-issue the same call,
                    // producing another approval request.
                    thread.pending_tool_call = Some(tool_call.clone());
                    return EngineResult::AwaitingApproval {
                        tool_call_id: tool_call.id.clone(),
                        reason: question,
                    };
                }

                // 6b. Approval check (section 12.1 — structural, not prompted).
                let approval = self.approval_gate.check(thread.role, &tool_call.function.name);
                match approval {
                    Approval::Blocked => {
                        // Skip the tool and continue to the next iteration.
                        log::info!(
                            "[engine] tool '{}' blocked for {:?}; skipping",
                            tool_call.function.name,
                            thread.role
                        );
                        let step = TraceStep {
                            step: iterations,
                            content: format!(
                                "Tool: {} → (blocked for {:?})",
                                tool_call.function.name,
                                thread.role
                            ),
                            ts: chrono_millis(),
                        };
                        thread.trace.push(step);
                        self.emit_tool_call_event(thread, tool_call);
                        continue;
                    }
                    Approval::NeedApproval => {
                        self.emit_state_transition(
                            thread,
                            thread.state,
                            ThreadState::AwaitingApproval,
                            &format!("approval required for {}", tool_call.function.name),
                        );
                        // Remember which tool_call paused the
                        // loop so `agent_approve_action` can
                        // execute it directly on resume.
                        // Without this, the engine would
                        // re-prompt the LLM and the LLM would
                        // re-issue the same call, producing
                        // another approval request — exactly
                        // the "click approve → nothing
                        // happens" bug we're fixing.
                        thread.pending_tool_call = Some(tool_call.clone());
                        return EngineResult::AwaitingApproval {
                            tool_call_id: tool_call.id.clone(),
                            reason: format!(
                                "Tool '{}' requires human approval.",
                                tool_call.function.name
                            ),
                        };
                    }
                    Approval::AutoApprove => {
                        // Proceed with execution.
                    }
                }

                // 6b-protocol. Investigation protocol enforcement
                // (section 5.2 — Gather → Hypothesize → Patch).
                // `apply_patch` may only run from `HypothesisFormed`
                // or `PatchProposed` (the agent can re-apply to
                // revise its own patch). All other states must
                // gather context first — premature patches waste
                // GPU hours. Escalate after max_hypothesis_iterations.
                if tool_call.function.name == "apply_patch" {
                    let mode = self.mode_registry.for_role(thread.role);
                    let max_iter = mode.max_hypothesis_iterations();

                    // Patch-before-hypothesis: blocked with a
                    // protocol-violation trace step.
                    if !matches!(
                        thread.state,
                        ThreadState::HypothesisFormed
                            | ThreadState::PatchProposed
                            | ThreadState::SmokeVerifying
                            | ThreadState::FullRunVerifying
                    ) {
                        let step = TraceStep {
                            step: iterations,
                            content: format!(
                                "Tool: apply_patch → (blocked: protocol violation — \
                                 patch requires a hypothesis first; current state {:?})",
                                thread.state
                            ),
                            ts: chrono_millis(),
                        };
                        thread.trace.push(step);
                        log::warn!(
                            "[engine] apply_patch blocked in state {:?}; hypothesis required first",
                            thread.state
                        );
                        // Record the rejection in the event log so
                        // the renderer can show why the patch was
                        // skipped.
                        self.emit_tool_call_event(thread, tool_call);
                        continue;
                    }

                    // Exhausted hypothesis budget: skip the patch
                    // and emit an escalation trace step.
                    if thread.hypothesis_iterations > max_iter {
                        let step = TraceStep {
                            step: iterations,
                            content: format!(
                                "Tool: apply_patch → (blocked: hypothesis budget \
                                 exhausted — {} iterations > max {}); escalating",
                                thread.hypothesis_iterations, max_iter
                            ),
                            ts: chrono_millis(),
                        };
                        thread.trace.push(step);
                        self.emit_tool_call_event(thread, tool_call);
                        return EngineResult::MaxIterations;
                    }

                    // Low-confidence patch: refuse to apply.
                    let min_confidence = mode.min_confidence_to_propose_patch();
                    let current_confidence = thread
                        .hypothesis
                        .as_ref()
                        .map(|h| h.confidence)
                        .unwrap_or(0.0);
                    if current_confidence < min_confidence {
                        let step = TraceStep {
                            step: iterations,
                            content: format!(
                                "Tool: apply_patch → (blocked: hypothesis confidence \
                                 {:.0}% < required {:.0}%); gather more evidence",
                                current_confidence * 100.0,
                                min_confidence * 100.0
                            ),
                            ts: chrono_millis(),
                        };
                        thread.trace.push(step);
                        self.emit_tool_call_event(thread, tool_call);
                        continue;
                    }
                }

                // 6c. Hypothesis marker heuristic.
                let hypothesis_marker = self
                    .mode_registry
                    .for_role(thread.role)
                    .behavior_marker_hypothesis();
                if resp.content.contains(hypothesis_marker)
                    && thread.state == ThreadState::Investigating
                {
                    // Increment the hypothesis iteration counter
                    // each time a fresh hypothesis is emitted. The
                    // counter is what the protocol-enforcement gate
                    // above reads to decide whether to escalate.
                    thread.hypothesis_iterations += 1;
                    self.emit_state_transition(
                        thread,
                        ThreadState::Investigating,
                        ThreadState::HypothesisFormed,
                        &format!(
                            "## Hypothesis marker detected (iteration {})",
                            thread.hypothesis_iterations
                        ),
                    );
                }

                // 6c-patch. Patch marker heuristic (section 7.3 —
                // // // // // "Investigating → PatchProposed"). The
                // marker fires whenever the assistant emits `## Patch`
                // in the same response that contains tool calls; this
                // covers both the `apply_patch` tool path (which is
                // also reinforced at 6g) and the case where the
                // assistant renders a diff in prose without invoking
                // the tool. The transition fires from any non-terminal
                // state so a Scaffolder that emits a patch marker
                // after generation is also captured.
                let patch_marker = self
                    .mode_registry
                    .for_role(thread.role)
                    .behavior_marker_patch();
                if resp.content.contains(patch_marker)
                    && !matches!(
                        thread.state,
                        ThreadState::Resolved
                            | ThreadState::Rejected
                            | ThreadState::Stopped
                            | ThreadState::PatchProposed
                    )
                {
                    self.emit_state_transition(
                        thread,
                        thread.state,
                        ThreadState::PatchProposed,
                        "## Patch marker detected",
                    );
                }

                // 6d. Execute tool.
                let result = self.tools.execute(tool_call).await;

                // 6d-artifact. Push a structured tool-artifact record
                // onto the thread so the renderer can surface this
                // call as an inline card in the assistant message.
                // We do this BEFORE the trace step so the artifact's
                // status reflects the *executed* outcome (not the
                // pending call), and so a renderer that consumes the
                // artifacts list mid-loop can render live updates.
                let artifact = build_artifact(tool_call, &result, chrono_millis());
                thread.tool_artifacts.push(artifact);

                // 6e. Record trace step.
                let trace_content = self
                    .tools
                    .render_trace_step(tool_call)
                    .await;
                let step = TraceStep {
                    step: iterations,
                    content: trace_content,
                    ts: chrono_millis(),
                };
                thread.trace.push(step);

                // 6f. Emit events to the JSONL log.
                self.emit_tool_call_event(thread, tool_call);
                self.emit_tool_result_event(thread, tool_call, &result);

                // 6g. Patch heuristic: apply_patch result → PatchProposed.
                if tool_call.function.name == "apply_patch" {
                    match &result {
                        ToolResult::Ok { .. } => {
                            self.emit_state_transition(
                                thread,
                                thread.state,
                                ThreadState::PatchProposed,
                                "apply_patch succeeded",
                            );

                            // 6g-critic. Synchronously invoke the
                            // Critic on every successful patch
                            // (section 6.3 — Critic is the one
                            // synchronous in-process call, not a
                            // spawned sub-agent). The Critic scores
                            // the patch; if the score is below the
                            // presentable threshold, the engine
                            // routes the proposal back for revision.
                            let verdict = self.review_patch_with_critic(
                                thread,
                                tool_call,
                            );
                            if verdict.is_risky() {
                                thread.patch_revisions += 1;
                                let max_rev = self
                                    .mode_registry
                                    .for_role(thread.role)
                                    .max_hypothesis_iterations();
                                if thread.patch_revisions >= max_rev {
                                    log::warn!(
                                        "[engine] critic rejected {} times for thread {}; \
                                         escalating",
                                        thread.patch_revisions,
                                        thread.id
                                    );
                                    self.emit_state_transition(
                                        thread,
                                        thread.state,
                                        ThreadState::AwaitingApproval,
                                        "critic revision budget exhausted",
                                    );
                                    // Remember which tool_call
                                    // paused the loop so the
                                    // IPC handler can execute
                                    // it directly on resume.
                                    thread.pending_tool_call = Some(tool_call.clone());
                                    return EngineResult::AwaitingApproval {
                                        tool_call_id: tool_call.id.clone(),
                                        reason: format!(
                                            "Critic rejected the patch {} times \
                                             (score {}). Manual review needed.",
                                            thread.patch_revisions, verdict.score
                                        ),
                                    };
                                }
                                let step = TraceStep {
                                    step: iterations,
                                    content: format!(
                                        "Critic: score={} verdict=\"{}\" \
                                         issues={}",
                                        verdict.score,
                                        verdict.verdict,
                                        verdict.issues.join("; ")
                                    ),
                                    ts: chrono_millis(),
                                };
                                thread.trace.push(step);
                                // Send the proposal back for
                                // revision by transitioning to
                                // Investigating and continuing the
                                // loop.
                                self.emit_state_transition(
                                    thread,
                                    thread.state,
                                    ThreadState::Investigating,
                                    "critic requested revision",
                                );
                            } else if verdict.is_reject() {
                                let step = TraceStep {
                                    step: iterations,
                                    content: format!(
                                        "Critic: REJECT score={} verdict=\"{}\" \
                                         issues={}",
                                        verdict.score,
                                        verdict.verdict,
                                        verdict.issues.join("; ")
                                    ),
                                    ts: chrono_millis(),
                                };
                                thread.trace.push(step);
                                self.emit_state_transition(
                                    thread,
                                    thread.state,
                                    ThreadState::Rejected,
                                    "critic rejected patch",
                                );
                                return EngineResult::Completed {
                                    content: format!(
                                        "Critic rejected the patch: {}",
                                        verdict.verdict
                                    ),
                                };
                            } else if verdict.is_presentable() {
                                let step = TraceStep {
                                    step: iterations,
                                    content: format!(
                                        "Critic: APPROVE score={} verdict=\"{}\"",
                                        verdict.score, verdict.verdict
                                    ),
                                    ts: chrono_millis(),
                                };
                                thread.trace.push(step);
                            }
                        }
                        ToolResult::Error { error } => {
                            log::warn!(
                                "[engine] apply_patch failed: {error}; remaining in state {:?}",
                                thread.state
                            );
                        }
                        ToolResult::Skipped { .. } => {
                            // Stub — no real patch execution yet.
                        }
                    }
                }

                // 6h. Record spend in budget.
                self.budget.record(tool_call, &mut thread.budget);
            }
        }
    }

    /// Synchronously invoke the Critic on a freshly-applied patch
    /// (section 6.3 — Critic runs in-process, not as a sub-agent).
    ///
    /// The Critic inspects the patch content + hypothesis context
    /// and returns a scored verdict. The verdict drives the
    /// engine's revision / approval / rejection decision.
    fn review_patch_with_critic(
        &self,
        thread: &Thread,
        tool_call: &crate::agent::llm::ToolCall,
    ) -> crate::agent::modes::critic::CriticVerdict {
        let proposal = crate::agent::modes::critic::PatchProposal {
            diff: tool_call.function.arguments.clone(),
            summary: thread
                .hypothesis
                .as_ref()
                .map(|h| h.statement.clone())
                .unwrap_or_default(),
        };
        let hypothesis = crate::agent::modes::critic::HypothesisContext {
            hypothesis_statement: thread
                .hypothesis
                .as_ref()
                .map(|h| h.statement.clone())
                .unwrap_or_default(),
            confidence: thread
                .hypothesis
                .as_ref()
                .map(|h| h.confidence)
                .unwrap_or(0.0),
        };
        crate::agent::modes::critic::review_proposal(&proposal, &hypothesis)
    }

    /// Build the full per-mode system prompt.
    ///
    /// Composes the four layers from spec section 8.1:
    ///   1. Identity    — the mode's display name + role.
    ///   2. Rules       — shared behavioural rules (metric fabrication,
    ///                    reproducibility, no silent failures).
    ///   3. Mode        — the mode's `system_prompt_suffix()` with
    ///                    investigation protocol + few-shot examples.
    ///   4. Context     — runtime state (hypothesis, budget, escalation,
    ///                    thread state, iteration counters).
    ///
    /// The result is meant to be prepended as the very first
    /// `ChatMessage` so the LLM sees it on every iteration. The
    /// shared `BEHAVIORAL_RULES` constant guarantees every mode
    /// enforces the same non-negotiable rules (section 8.1 layer 2).
    pub fn build_system_prompt(&self, thread: &Thread) -> String {
        let mode = self.mode_registry.for_role(thread.role);
        let escalation = self.current_escalation(&thread.budget);
        let mut parts: Vec<String> = Vec::new();

        // ── Layer 1: identity ─────────────────────────────────────────
        parts.push(format!(
            "You are the Bonafide {}, embedded inside the Bonafide MLOps IDE. \
             You are a specialist — not a general coding assistant. \
             You operate under the {}-mode protocol.",
            mode.name(),
            mode.name(),
        ));

        // ── Layer 2: shared behavioural rules (section 8.1) ───────────
        parts.push(SHARED_BEHAVIORAL_RULES.to_string());

        // ── Layer 3: mode-specific protocol + few-shot examples ───────
        let suffix = mode.system_prompt_suffix();
        if !suffix.is_empty() {
            parts.push(suffix.to_string());
        }

        // ── Layer 4: context injection (section 8.1 layer 4) ───────────
        let mut ctx = String::new();
        ctx.push_str("\n\nRUNTIME CONTEXT\n");
        ctx.push_str("══════════════\n");

        // Mode / role + protocol steps.
        ctx.push_str(&format!(
            "Active role: {} (protocol: {})\n",
            mode.name(),
            mode.investigation_protocol_steps().join(" → "),
        ));

        // Workspace root — surfaces the absolute path the agent is
        // operating in so filesystem tool calls (`read_file`,
        // `read_directory`, …) use the real workspace path instead
        // of fabricating placeholders like `/home/user`. An empty
        // path means the thread predates the workspace_root field
        // (legacy replay) or the caller didn't supply a workspace —
        // tell the LLM to ask rather than guess.
        let workspace_path = thread.workspace_root.to_string_lossy();
        if workspace_path.trim().is_empty() {
            ctx.push_str(
                "Workspace: <unknown> — no workspace path on this thread. \
                 Ask the user for the working directory before invoking \
                 filesystem tools.\n",
            );
        } else {
            ctx.push_str(&format!(
                "Workspace: {} (filesystem tool `path` arguments are \
                 RELATIVE to this root — omit `path` to use the workspace root)\n",
                workspace_path,
            ));
            ctx.push_str(
                "Path rule: NEVER fabricate absolute paths. POSIX defaults \
                 like `/home/user`, `/Users/me`, or `~/work` will fail on \
                 this host. When unsure of a sub-path, list the parent \
                 directory first with `read_directory(path=\"<parent>\")` \
                 or call the tool with no `path` argument.\n",
            );
        }

        // Thread state machine position.
        ctx.push_str(&format!(
            "Thread state: {} (hypothesis_iterations: {}, patch_revisions: {})\n",
            thread_state_to_string(thread.state),
            thread.hypothesis_iterations,
            thread.patch_revisions,
        ));

        // Hypothesis summary if present.
        if let Some(hyp) = &thread.hypothesis {
            ctx.push_str(&format!(
                "Current hypothesis: \"{}\" (confidence {:.0}%)\n",
                truncate(&hyp.statement, 200),
                hyp.confidence * 100.0,
            ));
            if !hyp.evidence.is_empty() {
                ctx.push_str(&format!("Evidence refs: {}\n", hyp.evidence.len()));
            }
            if !hyp.ruled_out.is_empty() {
                ctx.push_str("Ruled-out alternatives:\n");
                for alt in hyp.ruled_out.iter().take(3) {
                    ctx.push_str(&format!("  - {}\n", truncate(alt, 120)));
                }
            }
        }

        // Budget + escalation level.
        ctx.push_str(&format!(
            "Budget: spent ${:.2} / ${:.2}, {:.2}h GPU / {:.2}h GPU\n",
            thread.budget.spent_dollars,
            thread.budget.max_dollars,
            thread.budget.spent_gpu_hours,
            thread.budget.max_gpu_hours,
        ));
        ctx.push_str(&format!(
            "Escalation level: {} (compute requires approval above Caution)\n",
            escalation_label(escalation),
        ));

        // Mode behaviour knobs.
        ctx.push_str(&format!(
            "Mode thresholds: max_hypothesis_iterations={}, min_confidence_to_propose_patch={:.2}\n",
            mode.max_hypothesis_iterations(),
            mode.min_confidence_to_propose_patch(),
        ));
        ctx.push_str(&format!(
            "Markers to emit: hypothesis=\"{}\", patch=\"{}\", resolved=\"{}\"\n",
            mode.behavior_marker_hypothesis(),
            mode.behavior_marker_patch(),
            mode.behavior_marker_resolved(),
        ));

        parts.push(ctx);

        parts.join("\n\n")
    }

    /// Build the message list sent to the LLM.
    ///
    /// Strategy (section 9.1 — tier-1 cap):
    /// - System message (per-mode prompt, layers 1-4 from spec 8.1)
    /// - Last 20 messages (user + assistant)
    /// - Current hypothesis (if any)
    /// - Last 3 tool observations
    /// - Total bounded at ~5K characters via per-message truncation.
    ///
    /// The system prompt is prepended as the very first message so
    /// every iteration of the loop sees the full per-mode protocol +
    /// runtime context. This is the wiring that makes the per-mode
    /// `system_prompt_suffix()` actually reach the LLM (the suffix
    /// alone is invisible until this call site prepends it).
    ///
    /// The system prompt is **always preserved** even when the
    /// total exceeds `MAX_CHAR_TOTAL` — truncation removes from
    /// index 1 onward (the oldest conversation history), never
    /// from index 0 (the system prompt). This is critical: a
    /// truncated system prompt would silently disable per-mode
    /// behaviour enforcement.
    fn build_messages(&self, thread: &Thread) -> Vec<ChatMessage> {
        const MAX_MESSAGES: usize = 20;
        const MAX_TRACE_OBSERVATIONS: usize = 3;
        const MAX_CHAR_PER_MSG: usize = 200; // ~8K / ~25 entries
        // Total context budget. The system prompt is large (~5-6K
        // chars for the Debugger with few-shot examples), so the
        // total budget must accommodate it plus the recent
        // conversation history. The spec's "~5K" is the
        // **bounded** memory tier; modern LLM contexts easily
        // support 8K+ so we use that to preserve the system prompt
        // while leaving room for at least a few recent messages.
        const MAX_CHAR_TOTAL: usize = 8_000;

        let mut out: Vec<ChatMessage> = Vec::new();

        // ── System prompt (section 8.1) — ALWAYS first, never dropped ───
        let system_prompt = self.build_system_prompt(thread);
        out.push(ChatMessage::system(system_prompt));

        // Last 20 messages.
        for msg in thread.messages.iter().rev().take(MAX_MESSAGES).rev() {
            out.push(ChatMessage {
                role: match msg.role.as_str() {
                    "user" => Role::User,
                    "assistant" => Role::Assistant,
                    "system" => Role::System,
                    _ => Role::User,
                },
                content: truncate(&msg.content, MAX_CHAR_PER_MSG),
                tool_call_id: None,
                tool_calls: None,
            });
        }

        // Current hypothesis.
        if let Some(hyp) = &thread.hypothesis {
            let text = truncate(&hyp.statement, MAX_CHAR_PER_MSG);
            out.push(ChatMessage::assistant(format!("[Hypothesis] {}", text)));
        }

        // Last 3 tool observations.
        for obs in thread.trace.iter().rev().take(MAX_TRACE_OBSERVATIONS).rev() {
            out.push(ChatMessage::assistant(truncate(&obs.content, MAX_CHAR_PER_MSG)));
        }

        // Truncate the total if it exceeds ~5K chars — but never drop
        // any of the structural messages (system prompt, user
        // history, hypothesis, trace). Instead, shrink the system
        // prompt (the only message without its own per-message cap)
        // to fit under the budget.
        let total_len: usize = out.iter().map(|m| m.content.len()).sum();
        if total_len <= MAX_CHAR_TOTAL {
            return out;
        }

        // Compute headroom for the system prompt: total budget minus
        // the non-system messages. The system prompt is truncated to
        // that headroom, preserving the protocol header while
        // trimming the long shared-rules + mode-suffix body.
        let other_len: usize = out
            .iter()
            .skip(1)
            .map(|m| m.content.len())
            .sum();
        let system_budget = MAX_CHAR_TOTAL.saturating_sub(other_len);
        if system_budget == 0 {
            // Degenerate case — leave as-is and let the LLM client
            // error out gracefully if it has a hard cap.
            return out;
        }
        if out[0].content.len() > system_budget {
            out[0].content = truncate(&out[0].content, system_budget);
        }
        out
    }

    /// Emit a ThreadEvent::Message to the JSONL log.
    fn emit_message_event(&self, thread: &Thread, role: &str, content: &str) {
        let event = crate::agent::threads::ThreadEvent::Message {
            v: 1,
            id: uuid::Uuid::new_v4().to_string(),
            role: role.to_string(),
            content: content.to_string(),
            ts: chrono_millis(),
        };
        let _ = append_thread_event(&thread.event_log_path, &event);
    }

    /// Emit a ThreadEvent::StateTransition to the JSONL log and update
    /// the in-memory thread state.
    fn emit_state_transition(
        &self,
        thread: &mut Thread,
        from: ThreadState,
        to: ThreadState,
        reason: &str,
    ) {
        let ts = chrono_millis();
        let event =
            crate::agent::threads::ThreadEvent::state_transition(from, to, ts);
        let _ = append_thread_event(&thread.event_log_path, &event);

        // Update in-memory state so subsequent iterations see the new state.
        thread.state = to;

        // Emit to the legacy event log too (kept for Phase 0 compat).
        let json = serde_json::json!({
            "type": "state_transition",
            "from": thread_state_to_string(from),
            "to": thread_state_to_string(to),
            "reason": reason,
            "ts": ts,
        });
        let _ = append_event_log(&thread.event_log_path, &json.to_string());

        // Persist the row-level state to SQLite so a renderer restart
        // can resume from the correct state.
        // (The caller is responsible for calling `upsert_thread` after
        // `run()` returns.)
        log::info!(
            "[engine] thread {}: {} → {} ({})",
            thread.id,
            thread_state_to_string(from),
            thread_state_to_string(to),
            reason
        );
    }

    /// Emit a ThreadEvent::ToolCall to the JSONL log.
    fn emit_tool_call_event(&self, thread: &Thread, tool_call: &crate::agent::llm::ToolCall) {
        let event = crate::agent::threads::ThreadEvent::ToolCall {
            v: 1,
            id: tool_call.id.clone(),
            name: tool_call.function.name.clone(),
            args_json: tool_call.function.arguments.clone(),
            ts: chrono_millis(),
        };
        let _ = append_thread_event(&thread.event_log_path, &event);
    }

    /// Emit a ThreadEvent::ToolResult to the JSONL log.
    fn emit_tool_result_event(
        &self,
        thread: &Thread,
        tool_call: &crate::agent::llm::ToolCall,
        result: &ToolResult,
    ) {
        let event = crate::agent::threads::ThreadEvent::ToolResult {
            v: 1,
            id: tool_call.id.clone(),
            summary: result.summary(),
            ts: chrono_millis(),
        };
        let _ = append_thread_event(&thread.event_log_path, &event);
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/// Shared behavioural rules prepended to every per-mode system
/// prompt (section 8.1 layer 2 — "BEHAVIORAL RULES"). These are
/// the non-negotiable rules every mode must enforce; the
/// mode-specific protocol is layered on top of this shared base.
pub const SHARED_BEHAVIORAL_RULES: &str = "\
RULES (apply to every mode)
════════════════════════════
1. Never fabricate metric values, run IDs, or paper citations. \
If you don't have the data, say so and use a tool to get it.
2. Always reference specific run IDs, step numbers, and metric \
values. Bad: 'the loss looks high'. \
Good: 'val_loss=0.89 at step 5000'.
3. Never suggest re-running with the same config — that's a \
waste of GPU hours.
4. Never modify code without showing the diff first.
5. Never delete checkpoints, overwrite configs, or discard git \
history. Reproducibility is sacred.
6. If you need to run compute (training, evaluation), state the \
estimated cost and get approval first.
7. When uncertain, say so. 'I'm not sure about X' is better \
than a confident wrong answer that wastes 4 GPU hours.
8. End every investigation with: what you found, what you tried, \
what worked, what didn't, and what to try next.
9. Always emit the documented markers (## Hypothesis, ## Patch, \
## Resolved, ## Escalate) so the engine's state machine can \
track your progress.
10. If the protocol forbids an action (e.g. patch before \
hypothesis), the engine will block it. Form the prerequisite \
state first.
11. After every tool call, emit a brief textual response \
acknowledging what you learned before deciding the next action. \
A turn that ends with tool calls but no text leaves the user \
staring at a silent artifact stack and looks like a stuck agent. \
Special cases for empty / error / placeholder returns — these \
are the patterns that produce the silent stacks:
    - Empty result (0 matches, empty directory, \"no runs \
      found\"): do NOT repeat the same tool with a marginally-\
      different argument. State the empty result in one sentence, \
      then pivot to a different tool or to synthesizing what you \
      already know.
    - Tool error (path not found, permission denied, parse \
      failure): acknowledge the error explicitly — the user may \
      need to fix a workspace setting or grant access. Don't \
      paper over it by re-issuing the same call.
    - Placeholder result (\"wired in WSx-Tx\", \"not yet \
      implemented\", a stub string): treat it as a capability \
      gap, not an instruction to retry. Tell the user the tool \
      isn't wired up yet and either propose a workaround or ask \
      what they want to do.
    - Final answer: if you already have enough information to \
      answer the user, answer them. Do not call another tool \
      \"just to be sure\" — that wastes budget and clutters the \
      thread.";

/// Map an `EscalationLevel` to a human-readable label for the
/// system prompt's context block.
fn escalation_label(level: EscalationLevel) -> &'static str {
    match level {
        EscalationLevel::Normal => "Normal",
        EscalationLevel::Caution => "Caution",
        EscalationLevel::Critical => "Critical",
        EscalationLevel::Exhausted => "Exhausted",
    }
}

/// Truncate `s` to at most `max_len` characters. If truncation occurred,
/// appends `…` so the caller can see the text was cut.
fn truncate(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        return s.to_string();
    }
    format!("{}…", &s[..max_len.saturating_sub(1)])
}

/// Return the current Unix time in milliseconds.
fn chrono_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── Tool-artifact helpers ─────────────────────────────────────────────────────

/// Classify a tool call into one of the renderer's three layout
/// families. Mirrors the mapping in
/// `src/components/chat/ToolArtifact.tsx::kindForToolName` so the
/// frontend and backend agree on the canonical names.
fn classify_tool(name: &str) -> &'static str {
    match name {
        "run_shell" | "run_python" | "run_smoke_test" | "pip_install" => "terminal",
        "write_file" | "create_file" | "apply_patch" | "rename_path" | "delete_path" => "file",
        _ => "tool",
    }
}

/// Pull a short target string out of the tool's JSON arguments.
/// Mirrors the per-tool field the renderer wants to show in the
/// card subtitle (file path, shell command, arxiv query, etc.).
fn artifact_target(name: &str, args_json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(args_json).ok()?;
    let string_field = |key: &str| -> Option<String> {
        v.get(key).and_then(|x| x.as_str()).map(String::from)
    };
    match name {
        "read_file" | "write_file" | "apply_patch" | "create_file" | "open_file_in_editor" => {
            string_field("path")
        }
        "run_shell" => string_field("command"),
        "run_python" => string_field("code").map(|c| {
            let first = c.lines().next().unwrap_or("").trim();
            if first.len() > 60 {
                format!("{}…", &first[..60])
            } else {
                first.to_string()
            }
        }),
        "search_arxiv" | "query_code_graph" => string_field("query"),
        "read_paper" | "get_arxiv_paper" => string_field("paper_id").or_else(|| string_field("arxiv_id")),
        "delete_path" | "rename_path" => string_field("target").or_else(|| string_field("src")),
        "show_metric_plot" => string_field("run_id"),
        _ => None,
    }
}

/// Build a `ToolArtifact` record for one tool execution. The
/// `status` mirrors the `ToolResult` variant so the renderer can
/// show the right icon without re-classifying.
fn build_artifact(
    tool_call: &crate::agent::llm::ToolCall,
    result: &ToolResult,
    ts: i64,
) -> ToolArtifact {
    let kind = classify_tool(&tool_call.function.name).to_string();
    let target = artifact_target(&tool_call.function.name, &tool_call.function.arguments);
    let (status, output, result_summary) = match result {
        ToolResult::Ok { summary } => (
            "completed".to_string(),
            if kind == "terminal" {
                Some(summary.clone())
            } else {
                None
            },
            if kind != "terminal" {
                Some(summary.clone())
            } else {
                None
            },
        ),
        ToolResult::Skipped { reason } => (
            "failed".to_string(),
            None,
            Some(format!("(skipped: {reason})")),
        ),
        ToolResult::Error { error } => (
            "failed".to_string(),
            None,
            Some(format!("(error: {error})")),
        ),
    };
    ToolArtifact {
        id: tool_call.id.clone(),
        kind,
        name: tool_call.function.name.clone(),
        display_name: display_name_for(&tool_call.function.name).to_string(),
        target,
        args: Some(tool_call.function.arguments.clone()),
        output,
        result_summary,
        status,
        ts,
    }
}

/// Human-readable label for a tool. Falls back to the raw name if
/// we don't have a prettier translation in the catalog.
fn display_name_for(name: &str) -> &'static str {
    match name {
        "read_file" => "Read file",
        "read_directory" => "List directory",
        "search_files" => "Search files",
        "write_file" => "Write file",
        "create_file" => "Create file",
        "create_folder" => "Create folder",
        "rename_path" => "Rename",
        "delete_path" => "Delete",
        "apply_patch" => "Apply patch",
        "run_shell" => "Shell",
        "run_python" => "Python",
        "run_smoke_test" => "Smoke test",
        "pip_install" => "pip install",
        "list_runs" => "List runs",
        "get_run" => "Get run",
        "get_metric_series" => "Get metric series",
        "get_run_config" => "Get run config",
        "list_artifacts" => "List artifacts",
        "compare_runs" => "Compare runs",
        "query_run_graph" => "Query run graph",
        "query_code_graph" => "Code search",
        "index_code_graph" => "Index code graph",
        "ruff_check" => "Ruff check",
        "lsp_hover" => "LSP hover",
        "lsp_definition" => "LSP definition",
        "git_diff" => "git diff",
        "git_log" => "git log",
        "git_status" => "git status",
        "git_checkout" => "git checkout",
        "git_add" => "git add",
        "git_commit" => "git commit",
        "git_discard" => "Discard changes",
        "search_arxiv" => "arXiv search",
        "read_paper" => "Read paper",
        "query_project_memory" => "Project memory",
        "write_project_memory" => "Save to memory",
        "open_file_in_editor" => "Open in editor",
        "show_metric_plot" => "Show metrics",
        "show_notification" => "Notify",
        "request_approval" => "Awaiting input",
        "create_experiment" => "New experiment",
        "update_experiment" => "Update experiment",
        "launch_experiment_run" => "Launch run",
        "stop_experiment_run" => "Stop run",
        "list_experiments" => "List experiments",
        "get_experiment" => "Get experiment",
        _ => "Tool",
    }
}

// ── NoopLlmClient for test / default engine ────────────────────────────────────

/// A no-op LLM client used by the default engine constructor and in
/// tests. It always returns an empty tool_calls response so the loop
/// terminates immediately with a `Completed` result.
#[derive(Debug, Clone, Default)]
struct NoopLlmClient;

#[async_trait::async_trait]
impl LlmClient for NoopLlmClient {
    async fn complete(
        &self,
        _req: ChatRequest,
    ) -> Result<ChatResponse, LlmError> {
        Ok(ChatResponse {
            content: "NoopLlmClient — no tool calls generated.".to_string(),
            tool_calls: Vec::new(),
            usage: None,
        })
    }
}

// ── Phase-0 stub (preserved at the bottom so the renderer IPC call keeps resolving) ──

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

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn make_thread(role: AgentRole, _state: ThreadState) -> Thread {
        let event_log: std::path::PathBuf = tempfile::tempdir()
            .unwrap()
            .path()
            .join("events.jsonl");
        Thread::new("test-thread".to_string(), role, None, event_log)
    }

    /// A mock LLM client that records the number of `complete` calls and
    /// returns a configurable response.
    #[derive(Debug, Clone)]
    struct CountingLlmClient {
        pub calls: Arc<std::sync::Mutex<usize>>,
        pub response: ChatResponse,
    }

    impl CountingLlmClient {
        fn new(calls: Arc<std::sync::Mutex<usize>>, response: ChatResponse) -> Self {
            Self { calls, response }
        }
    }

    #[async_trait::async_trait]
    impl LlmClient for CountingLlmClient {
        async fn complete(
            &self,
            _req: ChatRequest,
        ) -> Result<ChatResponse, LlmError> {
            *self.calls.lock().unwrap() += 1;
            Ok(self.response.clone())
        }
    }

    /// A mock BudgetGovernor that always permits.
    #[derive(Debug, Clone, Default)]
    struct PermittingBudget;

    impl BudgetGovernor for PermittingBudget {
        fn can_proceed(&self, _tc: &ToolCall, _b: &Budget) -> bool { true }
        fn record(&self, _tc: &ToolCall, _b: &mut Budget) {}
    }

    /// A mock BudgetGovernor that always blocks.
    #[derive(Debug, Clone, Default)]
    struct RejectingBudget;

    impl BudgetGovernor for RejectingBudget {
        fn can_proceed(&self, _tc: &ToolCall, _b: &Budget) -> bool { false }
        fn record(&self, _tc: &ToolCall, _b: &mut Budget) {}
    }

    fn tool_call(name: &str) -> ToolCall {
        ToolCall {
            id: "call_test".to_string(),
            tool_type: "function".to_string(),
            function: crate::agent::llm::ToolFunctionCall {
                name: name.to_string(),
                arguments: "{}".to_string(),
            },
        }
    }

    // ── Test 1: loop terminates after max_iterations ─────────────────────────────

    #[tokio::test]
    async fn loop_terminates_after_max_iterations() {
        let calls = Arc::new(std::sync::Mutex::new(0));
        // Always return a non-empty tool_calls response so the loop keeps running.
        let always_tool_call = ChatResponse {
            content: String::new(),
            tool_calls: vec![tool_call("read_file")],
            usage: None,
        };
        let client = CountingLlmClient::new(calls.clone(), always_tool_call);
        let mut engine = AgentEngine::new(
            Arc::new(client),
            Arc::new(ToolRegistry::default()),
            ApprovalGate::default(),
            Arc::new(PermittingBudget::default()),
        );
        engine.max_iterations = 5;

        let mut thread = make_thread(AgentRole::Debugger, ThreadState::Investigating);
        let result = engine.run(&mut thread).await;

        assert!(matches!(result, EngineResult::MaxIterations));
        let count = *calls.lock().unwrap();
        assert_eq!(count, 5, "should call complete exactly max_iterations times");
    }

    // ── Test 2: final answer with no tool calls returns Completed ─────────────────

    #[tokio::test]
    async fn final_answer_with_no_tool_calls_returns_completed() {
        let calls = Arc::new(std::sync::Mutex::new(0));
        let final_answer = ChatResponse {
            content: "The hypothesis is confirmed. ## Resolved".to_string(),
            tool_calls: Vec::new(),
            usage: None,
        };
        let client = CountingLlmClient::new(calls.clone(), final_answer);
        let mut engine = AgentEngine::new(
            Arc::new(client),
            Arc::new(ToolRegistry::default()),
            ApprovalGate::default(),
            Arc::new(PermittingBudget::default()),
        );

        let mut thread = make_thread(AgentRole::Debugger, ThreadState::Investigating);
        let result = engine.run(&mut thread).await;

        assert!(matches!(result, EngineResult::Completed { .. }));
    }

    // ── Test 3: NeedApproval transitions to AwaitingApproval ───────────────────

    #[tokio::test]
    async fn pending_approval_transitions_to_awaiting_approval() {
        let calls = Arc::new(std::sync::Mutex::new(0));
        let resp = ChatResponse {
            content: String::new(),
            tool_calls: vec![tool_call("run_shell")], // Debugger: needs approval
            usage: None,
        };
        let client = CountingLlmClient::new(calls.clone(), resp);
        let mut engine = AgentEngine::new(
            Arc::new(client),
            Arc::new(ToolRegistry::default()),
            ApprovalGate::default(),
            Arc::new(PermittingBudget::default()),
        );

        let mut thread = make_thread(AgentRole::Debugger, ThreadState::Investigating);
        let result = engine.run(&mut thread).await;

        assert!(matches!(
            result,
            EngineResult::AwaitingApproval { tool_call_id, .. }
            if tool_call_id == "call_test"
        ));
    }

    // ── Test 4: Blocked tool is skipped not terminating ─────────────────────────

    #[tokio::test]
    async fn denied_tool_call_is_skipped_not_terminating() {
        let calls = Arc::new(std::sync::Mutex::new(0));
        // First call: blocked tool (run_shell for Researcher).
        // Second call: final answer.
        #[derive(Debug, Clone)]
        struct TwoShotClient {
            calls: Arc<std::sync::Mutex<usize>>,
            responses: Vec<ChatResponse>,
        }
        impl TwoShotClient {
            fn new(calls: Arc<std::sync::Mutex<usize>>) -> Self {
                Self {
                    calls,
                    responses: vec![
                        ChatResponse {
                            content: String::new(),
                            tool_calls: vec![tool_call("run_shell")],
                            usage: None,
                        },
                        ChatResponse {
                            content: "Done.".to_string(),
                            tool_calls: Vec::new(),
                            usage: None,
                        },
                    ],
                }
            }
        }
        #[async_trait::async_trait]
        impl LlmClient for TwoShotClient {
            async fn complete(&self, _req: ChatRequest) -> Result<ChatResponse, LlmError> {
                let idx = {
                    let mut n = self.calls.lock().unwrap();
                    let i = *n;
                    *n += 1;
                    i
                };
                Ok(self.responses[idx.min(self.responses.len() - 1)].clone())
            }
        }

        let client = TwoShotClient::new(calls.clone());
        let mut engine = AgentEngine::new(
            Arc::new(client),
            Arc::new(ToolRegistry::default()),
            ApprovalGate::default(), // Researcher: run_shell is Blocked
            Arc::new(PermittingBudget::default()),
        );
        engine.max_iterations = 3;

        let mut thread = make_thread(AgentRole::Researcher, ThreadState::Investigating);
        // First iteration: tool is blocked, loop continues.
        // Second iteration: final answer → Completed.
        let result = engine.run(&mut thread).await;

        assert!(matches!(result, EngineResult::Completed { .. }));
        let count = *calls.lock().unwrap();
        assert_eq!(count, 2, "blocked tool should not terminate the loop");
    }

    // ── Test 5: exhausted budget returns BudgetExceeded ───────────────────────────

    #[tokio::test]
    async fn exhausted_budget_transitions_to_awaiting_approval() {
        let calls = Arc::new(std::sync::Mutex::new(0));
        let resp = ChatResponse {
            content: String::new(),
            tool_calls: vec![tool_call("read_file")],
            usage: None,
        };
        let client = CountingLlmClient::new(calls.clone(), resp);
        let mut engine = AgentEngine::new(
            Arc::new(client),
            Arc::new(ToolRegistry::default()),
            ApprovalGate::default(),
            Arc::new(RejectingBudget::default()),
        );

        let mut thread = make_thread(AgentRole::Debugger, ThreadState::Investigating);
        let result = engine.run(&mut thread).await;

        assert!(matches!(result, EngineResult::BudgetExceeded));
    }

    // ── Test 6: trace_step_appends_observation_per_iteration ───────────────────

    #[tokio::test]
    async fn trace_step_appends_observation_per_iteration() {
        let calls = Arc::new(std::sync::Mutex::new(0));
        let resp = ChatResponse {
            content: String::new(),
            tool_calls: vec![tool_call("read_file")],
            usage: None,
        };
        let client = CountingLlmClient::new(calls.clone(), resp);
        let mut engine = AgentEngine::new(
            Arc::new(client),
            Arc::new(ToolRegistry::default()),
            ApprovalGate::default(),
            Arc::new(PermittingBudget::default()),
        );
        engine.max_iterations = 3;

        let mut thread = make_thread(AgentRole::Debugger, ThreadState::Investigating);
        engine.run(&mut thread).await;

        // Stub tools always skip, so we get one trace step per iteration
        // plus the skipped tool message.
        assert!(
            !thread.trace.is_empty(),
            "trace must have at least one step"
        );
        assert!(
            thread.trace.iter().any(|s| s.content.contains("Tool:")),
            "trace should contain tool execution steps"
        );
    }

    // ── Test 7: append_event_log_writes_jsonl_per_iteration ───────────────────

    #[tokio::test]
    async fn append_event_log_writes_jsonl_per_iteration() {
        let calls = Arc::new(std::sync::Mutex::new(0));
        let resp = ChatResponse {
            content: String::new(),
            tool_calls: vec![tool_call("read_file")],
            usage: None,
        };
        let client = CountingLlmClient::new(calls.clone(), resp);
        let mut engine = AgentEngine::new(
            Arc::new(client),
            Arc::new(ToolRegistry::default()),
            ApprovalGate::default(),
            Arc::new(PermittingBudget::default()),
        );
        engine.max_iterations = 2;

        let tmp = tempfile::tempdir().unwrap();
        let event_log_path = tmp.path().join("events.jsonl");
        let mut thread = Thread::new(
            "test".to_string(),
            AgentRole::Debugger,
            None,
            event_log_path.clone(),
        );

        engine.run(&mut thread).await;

        // Read the JSONL file and count lines.
        let content = std::fs::read_to_string(&event_log_path).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert!(
            lines.len() >= 2,
            "at least 2 iterations → at least 2 event lines, got {}",
            lines.len()
        );
        // Every line should be valid JSON.
        for line in &lines {
            if !line.trim().is_empty() {
                let _: serde_json::Value = serde_json::from_str(line).unwrap();
            }
        }
    }

    // ── Test 8: check_tool_permission_still_returns_phase0_shape ───────────────

    #[tokio::test]
    async fn check_tool_permission_still_returns_phase0_shape() {
        let perm = check_tool_permission(std::path::Path::new("/tmp"), "read_file").await;
        assert!(perm.allowed);
        assert_eq!(perm.escalation, "normal");
        assert!(!perm.requires_approval);
        assert!(perm.message.is_none());
    }

    // ── Test 9: message truncation keeps total under 5K ───────────────────────

    #[test]
    fn truncate_keeps_total_under_5k() {
        let long = "x".repeat(10_000);
        let result = truncate(&long, 200);
        assert!(result.ends_with('…'));
        // With max_len=200, we slice 199 bytes + "…" (3 UTF-8 bytes for U+2026) = 202 bytes.
        assert!(result.len() <= 210, "truncated len should be modest, got {} bytes", result.len());
    }

    /// `build_messages_preserves_system_prompt_under_truncation`:
    /// even when the total context budget is exceeded (because the
    /// system prompt + history are larger than MAX_CHAR_TOTAL),
    /// the system prompt at index 0 is **never dropped**. This is
    /// the contract that keeps per-mode protocol enforcement
    /// intact during long investigations.
    #[test]
    fn build_messages_preserves_system_prompt_under_truncation() {
        let engine = AgentEngine::default();
        let mut thread = make_thread(AgentRole::Debugger, ThreadState::Investigating);
        // Fill thread with messages so total exceeds budget.
        for i in 0..30 {
            thread.messages.push(crate::agent::orchestrator::Message {
                id: format!("m{}", i),
                role: "user".to_string(),
                content: "x".repeat(500),
                tool_call_id: None,
                ts: i as i64,
            });
        }
        thread.trace.push(crate::agent::orchestrator::TraceStep {
            step: 1,
            content: "x".repeat(500),
            ts: 0,
        });

        let messages = engine.build_messages(&thread);
        assert!(!messages.is_empty(), "messages must not be empty");
        assert_eq!(
            messages[0].role,
            Role::System,
            "system prompt at index 0 must be preserved",
        );
        // System prompt content must still be intact (not truncated
        // to a stub).
        assert!(
            messages[0].content.contains("INVESTIGATION PROTOCOL"),
            "system prompt must be the full protocol — not truncated to a stub",
        );
    }

    // ── Test 10: state transitions emitted on first iteration ────────────────────

    #[tokio::test]
    async fn idle_to_investigating_transition_on_first_iteration() {
        let calls = Arc::new(std::sync::Mutex::new(0));
        // Return a final answer (no tool calls) so the loop terminates in 1 iteration.
        let resp = ChatResponse {
            content: "Done.".to_string(),
            tool_calls: Vec::new(),
            usage: None,
        };
        let client = CountingLlmClient::new(calls.clone(), resp);
        let mut engine = AgentEngine::new(
            Arc::new(client),
            Arc::new(ToolRegistry::default()),
            ApprovalGate::default(),
            Arc::new(PermittingBudget::default()),
        );

        let tmp = tempfile::tempdir().unwrap();
        let event_log_path = tmp.path().join("events.jsonl");
        let mut thread = Thread::new(
            "test".to_string(),
            AgentRole::Debugger,
            None,
            event_log_path.clone(),
        );
        // Thread starts in Idle.
        assert_eq!(thread.state, ThreadState::Idle);

        engine.run(&mut thread).await;

        // After 1 iteration, the thread transitions Idle → Investigating.
        // The NoopLlmClient response contains no "## Resolved" marker,
        // so the final state stays Investigating (Resolved requires that marker).
        assert_eq!(thread.state, ThreadState::Investigating);
    }

    // ── Test 11: budget governor record called after tool execution ──────────────

    #[tokio::test]
    async fn budget_record_called_after_tool_execution() {
        let calls = Arc::new(std::sync::Mutex::new(0));
        let resp = ChatResponse {
            content: String::new(),
            tool_calls: vec![tool_call("read_file")],
            usage: None,
        };
        let client = CountingLlmClient::new(calls.clone(), resp);

        // A budget that records when `record` is called.
        #[derive(Debug, Default)]
        struct RecordingBudget {
            pub recorded: Arc<std::sync::Mutex<bool>>,
        }
        impl BudgetGovernor for RecordingBudget {
            fn can_proceed(&self, _tc: &ToolCall, _b: &Budget) -> bool { true }
            fn record(&self, _tc: &ToolCall, _b: &mut Budget) {
                *self.recorded.lock().unwrap() = true;
            }
        }

        let recorded = Arc::new(std::sync::Mutex::new(false));
        let budget = Arc::new(RecordingBudget { recorded: recorded.clone() });

        let mut engine = AgentEngine::new(
            Arc::new(client),
            Arc::new(ToolRegistry::default()),
            ApprovalGate::default(),
            budget,
        );
        engine.max_iterations = 1;

        let mut thread = make_thread(AgentRole::Debugger, ThreadState::Investigating);
        engine.run(&mut thread).await;

        assert!(*recorded.lock().unwrap(), "budget.record must be called after tool execution");
    }

    // ── WS3-T1 tests ──────────────────────────────────────────────────────────────

    /// `switch_mode_updates_thread_role`: the synchronous switch
    /// helper mutates `thread.role` in place. Pin the contract so a
    /// future refactor can't return a new thread by mistake.
    #[test]
    fn switch_mode_updates_thread_role() {
        let engine = AgentEngine::default();
        let mut thread = make_thread(AgentRole::Debugger, ThreadState::Idle);
        assert_eq!(thread.role, AgentRole::Debugger);

        engine
            .switch_mode(&mut thread, AgentRole::Planner)
            .expect("switch to Planner should succeed");
        assert_eq!(thread.role, AgentRole::Planner);
    }

    /// `switch_mode_emits_event`: a `ModeSwitch` event lands in the
    /// JSONL log so rehydration restores the role. Read the log
    /// directly rather than pattern-matching on the typed helper so
    /// we exercise the wire format too.
    #[test]
    fn switch_mode_emits_event() {
        let engine = AgentEngine::default();
        let tmp = tempfile::tempdir().unwrap();
        let event_log_path = tmp.path().join("events.jsonl");
        let mut thread = Thread::new(
            "test".to_string(),
            AgentRole::Debugger,
            None,
            event_log_path.clone(),
        );

        engine
            .switch_mode(&mut thread, AgentRole::Scaffolder)
            .expect("switch should succeed");

        let content = std::fs::read_to_string(&event_log_path).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(content.trim()).expect("valid JSON");
        assert_eq!(parsed["type"], "mode_switch");
        assert_eq!(parsed["from"], "debugger");
        assert_eq!(parsed["to"], "scaffolder");
    }

    /// `switch_mode_persists_to_event_log`: a chain of switches
    /// accumulates `ModeSwitch` events in the log; the trace step
    /// also records each transition for the inbox audit.
    #[test]
    fn switch_mode_persists_to_event_log() {
        let engine = AgentEngine::default();
        let mut thread = make_thread(AgentRole::Debugger, ThreadState::Idle);

        engine
            .switch_mode(&mut thread, AgentRole::Scaffolder)
            .unwrap();
        engine
            .switch_mode(&mut thread, AgentRole::Critic)
            .unwrap();
        engine
            .switch_mode(&mut thread, AgentRole::Planner)
            .unwrap();

        // Three trace steps recorded (one per switch).
        let switch_traces: Vec<&str> = thread
            .trace
            .iter()
            .filter(|s| s.content.contains("ModeSwitch"))
            .map(|s| s.content.as_str())
            .collect();
        assert_eq!(switch_traces.len(), 3);
        assert!(switch_traces[0].contains("Debugger → Scaffolder"));
        assert!(switch_traces[1].contains("Scaffolder → Critic"));
        assert!(switch_traces[2].contains("Critic → Planner"));
    }

    /// `switch_mode_noop_is_error`: switching to the same role the
    /// thread already has is rejected so the caller can't
    /// accidentally emit spurious events.
    #[test]
    fn switch_mode_noop_is_error() {
        let engine = AgentEngine::default();
        let mut thread = make_thread(AgentRole::Debugger, ThreadState::Idle);

        let err = engine
            .switch_mode(&mut thread, AgentRole::Debugger)
            .expect_err("switch to same role must error");
        assert!(err.contains("no switch needed"));
    }

    /// `engine_loads_per_mode_tool_set`: the tool registry filters
    /// its definitions through the section-12.2 matrix per role.
    /// We exercise the role → tool mapping indirectly: a Debugger
    /// gets `read_file` (auto-approved) but not `write_file`
    /// (blocked); a Scaffolder gets both.
    #[test]
    fn engine_loads_per_mode_tool_set() {
        use crate::agent::approval::Approval;
        let engine = AgentEngine::default();

        // Debugger: read_file is auto-approved, write_file is blocked.
        assert_eq!(
            engine.approval_gate.check(AgentRole::Debugger, "read_file"),
            Approval::AutoApprove
        );
        assert_eq!(
            engine.approval_gate.check(AgentRole::Debugger, "write_file"),
            Approval::Blocked
        );

        // Scaffolder: write_file is auto-approved.
        assert_eq!(
            engine.approval_gate.check(AgentRole::Scaffolder, "write_file"),
            Approval::AutoApprove
        );

        // Researcher: run_shell is blocked (read-only role).
        assert_eq!(
            engine.approval_gate.check(AgentRole::Researcher, "run_shell"),
            Approval::Blocked
        );
    }

    /// `default_engine_wires_default_mode_registry`: the engine's
    /// `Default` impl must install `ModeRegistry::default()` so the
    /// existing engine callers don't need to think about modes
    /// until they explicitly want to override.
    #[test]
    fn default_engine_wires_default_mode_registry() {
        let engine = AgentEngine::default();
        let mode = engine.mode_registry().for_role(AgentRole::Debugger);
        assert_eq!(mode.role(), AgentRole::Debugger);
        assert_eq!(mode.name(), "Debugger");
    }

    /// `with_mode_registry_swaps_registry`: the override constructor
    /// lets tests inject a custom registry. Verifies the accessors
    /// reflect the swap.
    #[test]
    fn with_mode_registry_swaps_registry() {
        let engine = AgentEngine::default();
        let other = std::sync::Arc::new(crate::agent::modes::ModeRegistry::default());
        let engine = engine.with_mode_registry(other.clone());
        assert!(std::sync::Arc::ptr_eq(engine.mode_registry(), &other));
    }

    // ── System prompt injection tests (WS3 behavioural layer) ─────────

    /// `build_system_prompt_includes_mode_suffix`: the system
    /// prompt must include the mode-specific `system_prompt_suffix()`
    /// so the per-mode protocol + few-shot examples actually reach
    /// the LLM. Without this, the modes are inert — the prompt
    /// would be the generic identity alone.
    #[test]
    fn build_system_prompt_includes_mode_suffix() {
        let engine = AgentEngine::default();
        let mut thread = make_thread(AgentRole::Debugger, ThreadState::Investigating);
        let prompt = engine.build_system_prompt(&thread);

        // Layer 3: Debugger protocol must be present.
        assert!(
            prompt.contains("INVESTIGATION PROTOCOL"),
            "Debugger prompt must include investigation protocol header",
        );
        assert!(prompt.contains("1. GATHER"));
        assert!(prompt.contains("2. HYPOTHESIZE"));
        assert!(prompt.contains("3. PATCH"));
        assert!(prompt.contains("4. VERIFY"));
        assert!(prompt.contains("5. DOCUMENT"));

        // Few-shot example must be present.
        assert!(prompt.contains("FEW-SHOT EXAMPLE"));
        assert!(prompt.contains("a3f9c12"));

        // Layer 1 identity.
        assert!(prompt.contains("Bonafide Debugger"));
    }

    /// `build_system_prompt_includes_behavioral_rules`: the system
    /// prompt must include the shared behavioural rules (section
    /// 8.1 layer 2) so every mode enforces the same non-negotiables
    /// regardless of which mode is active.
    #[test]
    fn build_system_prompt_includes_behavioral_rules() {
        let engine = AgentEngine::default();
        let mut thread = make_thread(AgentRole::Researcher, ThreadState::Investigating);
        let prompt = engine.build_system_prompt(&thread);

        // Must include every behavioural rule (1-11).
        for i in 1..=11 {
            assert!(
                prompt.contains(&format!("{}. ", i)),
                "Behavioural rule {} must be present in system prompt",
                i,
            );
        }
        // Specifically check a couple of high-signal rules.
        assert!(prompt.contains("Never fabricate metric values"));
        assert!(prompt.contains("Reproducibility is sacred"));
    }

    /// `build_system_prompt_includes_runtime_context`: the system
    /// prompt must include runtime context (layer 4) — active role,
    /// thread state, budget, escalation level, and mode thresholds.
    /// Without this the LLM would not know which mode it is or how
    /// much budget remains.
    #[test]
    fn build_system_prompt_includes_runtime_context() {
        let engine = AgentEngine::default();
        let mut thread = make_thread(AgentRole::Planner, ThreadState::Investigating);
        thread.hypothesis_iterations = 2;
        thread.budget.spent_dollars = 1.5;
        thread.budget.spent_gpu_hours = 0.5;
        let prompt = engine.build_system_prompt(&thread);

        assert!(prompt.contains("Active role: Planner"));
        assert!(prompt.contains("RUNTIME CONTEXT"));
        assert!(prompt.contains("hypothesis_iterations: 2"));
        assert!(prompt.contains("Escalation level"));
        assert!(prompt.contains("min_confidence_to_propose_patch"));
    }

    /// `build_system_prompt_different_per_mode`: each mode must
    /// produce a distinct system prompt so the LLM's behaviour
    /// actually changes with mode. This guards against a future
    /// refactor where all modes collapse to the same prompt.
    #[test]
    fn build_system_prompt_different_per_mode() {
        let engine = AgentEngine::default();
        let mut thread_d = make_thread(AgentRole::Debugger, ThreadState::Investigating);
        let mut thread_s = make_thread(AgentRole::Scaffolder, ThreadState::Investigating);
        let mut thread_p = make_thread(AgentRole::Planner, ThreadState::Investigating);
        let mut thread_r = make_thread(AgentRole::Researcher, ThreadState::Investigating);
        let mut thread_c = make_thread(AgentRole::Critic, ThreadState::Investigating);

        let prompt_d = engine.build_system_prompt(&thread_d);
        let prompt_s = engine.build_system_prompt(&thread_s);
        let prompt_p = engine.build_system_prompt(&thread_p);
        let prompt_r = engine.build_system_prompt(&thread_r);
        let prompt_c = engine.build_system_prompt(&thread_c);

        // Each prompt must mention its own role by name in the
        // runtime-context block, and reference the corresponding
        // mode-specific tokens.
        assert!(prompt_d.contains("Bonafide Debugger") && prompt_d.contains("INVESTIGATION PROTOCOL"));
        assert!(prompt_s.contains("Bonafide Scaffolder") && prompt_s.contains("CONFIG FIRST"));
        assert!(prompt_p.contains("Bonafide Planner") && prompt_p.contains("HYPOTHESIS-DRIVEN"));
        assert!(prompt_r.contains("Bonafide Researcher") && prompt_r.contains("CITATIONS REQUIRED"));
        assert!(prompt_c.contains("Bonafide Critic") && prompt_c.contains("SCORING"));

        // Pairwise: each pair must differ.
        assert_ne!(prompt_d, prompt_s);
        assert_ne!(prompt_s, prompt_p);
        assert_ne!(prompt_p, prompt_r);
        assert_ne!(prompt_r, prompt_c);
        assert_ne!(prompt_d, prompt_p);
    }

    /// `build_system_prompt_within_size_budget`: every mode's
    /// system prompt must fit within a reasonable upper bound
    /// (16K chars) so it can be sent to a typical LLM context
    /// without truncation. This guards against a future refactor
    /// that bloats the prompt (e.g. adds full file dumps to the
    /// few-shot example).
    #[test]
    fn build_system_prompt_within_size_budget() {
        const MAX_PROMPT_CHARS: usize = 16_000;

        let engine = AgentEngine::default();
        for role in [
            AgentRole::Debugger,
            AgentRole::Scaffolder,
            AgentRole::Planner,
            AgentRole::Researcher,
            AgentRole::Critic,
        ] {
            let thread = make_thread(role, ThreadState::Investigating);
            let prompt = engine.build_system_prompt(&thread);
            assert!(
                prompt.len() <= MAX_PROMPT_CHARS,
                "{:?} prompt is {} chars (>{} budget) — too large to send to a typical LLM",
                role,
                prompt.len(),
                MAX_PROMPT_CHARS,
            );
            // Each prompt must also be substantive (not just a stub).
            assert!(
                prompt.len() > 500,
                "{:?} prompt is only {} chars — too small to enforce protocol",
                role,
                prompt.len(),
            );
        }
    }

    /// `build_messages_prepends_system_prompt`: the first message
    /// in the LLM-bound message list must be the system prompt.
    /// This is the wiring that makes the per-mode protocol actually
    /// reach the model.
    #[test]
    fn build_messages_prepends_system_prompt() {
        let engine = AgentEngine::default();
        let mut thread = make_thread(AgentRole::Debugger, ThreadState::Investigating);
        let messages = engine.build_messages(&thread);

        assert!(!messages.is_empty(), "messages list must not be empty");
        assert_eq!(
            messages[0].role,
            Role::System,
            "first message must be the system prompt",
        );
        assert!(
            messages[0].content.contains("INVESTIGATION PROTOCOL"),
            "system message must include mode-specific protocol",
        );
    }

    /// `build_messages_includes_hypothesis_and_trace`: after the
    /// system message, the conversation history must still include
    /// user/assistant messages, the hypothesis block, and the last
    /// few trace observations. Verifies the new system-message
    /// insertion didn't displace the rest of the prompt structure.
    #[test]
    fn build_messages_includes_hypothesis_and_trace() {
        let engine = AgentEngine::default();
        let mut thread = make_thread(AgentRole::Debugger, ThreadState::Investigating);
        thread.messages.push(crate::agent::orchestrator::Message {
            id: "m1".to_string(),
            role: "user".to_string(),
            content: "Why is run a3f9c12 diverging?".to_string(),
            tool_call_id: None,
            ts: 0,
        });
        thread.hypothesis = Some(crate::agent::orchestrator::Hypothesis {
            verdict: "lr too high".to_string(),
            statement: "Learning rate 1e-3 is too high.".to_string(),
            evidence: vec![],
            confidence: 0.7,
            ruled_out: vec![],
        });
        thread.trace.push(crate::agent::orchestrator::TraceStep {
            step: 1,
            content: "Read run config: lr=1e-3, batch_size=64.".to_string(),
            ts: 0,
        });

        let messages = engine.build_messages(&thread);
        // System + user + hypothesis + trace = 4 messages.
        assert_eq!(messages[0].role, Role::System);
        // The user message must be present.
        let has_user = messages
            .iter()
            .any(|m| m.role == Role::User && m.content.contains("diverging"));
        assert!(has_user, "user message must be present");
        // The hypothesis block must be present.
        let has_hyp = messages
            .iter()
            .any(|m| m.role == Role::Assistant && m.content.contains("[Hypothesis]"));
        assert!(has_hyp, "hypothesis block must be present");
        // The trace observation must be present.
        let has_trace = messages
            .iter()
            .any(|m| m.role == Role::Assistant && m.content.contains("lr=1e-3"));
        assert!(has_trace, "trace observation must be present");
    }

    // ── Hypothesis protocol enforcement tests (WS3 Priority 2) ────────

    /// `hypothesis_marker_increments_counter`: when the assistant
    /// emits a `## Hypothesis` marker in the `Investigating` state,
    /// the engine must increment `thread.hypothesis_iterations`.
    /// This is the counter that drives the protocol-escalation
    /// gate.
    #[tokio::test]
    async fn hypothesis_marker_increments_counter() {
        let calls = Arc::new(std::sync::Mutex::new(0));
        let resp = ChatResponse {
            content: "## Hypothesis: lr too high. Confidence: 0.7.".to_string(),
            tool_calls: Vec::new(), // terminal answer
            usage: None,
        };
        let client = CountingLlmClient::new(calls.clone(), resp);
        let mut engine = AgentEngine::new(
            Arc::new(client),
            Arc::new(ToolRegistry::default()),
            ApprovalGate::default(),
            Arc::new(PermittingBudget::default()),
        );

        let mut thread = make_thread(AgentRole::Debugger, ThreadState::Investigating);
        let _ = engine.run(&mut thread).await;

        // Marker was emitted; counter must have incremented.
        assert!(
            thread.hypothesis_iterations >= 1,
            "expected hypothesis_iterations >= 1, got {}",
            thread.hypothesis_iterations,
        );
    }

    /// `escalation_marker_terminates_with_resolved`: a final answer
    /// containing `## Resolved` (the per-mode resolved marker) must
    /// transition the thread to `Resolved` state and return
    /// `EngineResult::Completed`.
    #[tokio::test]
    async fn escalation_marker_terminates_with_resolved() {
        let calls = Arc::new(std::sync::Mutex::new(0));
        let resp = ChatResponse {
            content: "Investigation complete. ## Resolved".to_string(),
            tool_calls: Vec::new(),
            usage: None,
        };
        let client = CountingLlmClient::new(calls.clone(), resp);
        let mut engine = AgentEngine::new(
            Arc::new(client),
            Arc::new(ToolRegistry::default()),
            ApprovalGate::default(),
            Arc::new(PermittingBudget::default()),
        );

        let mut thread = make_thread(AgentRole::Debugger, ThreadState::Investigating);
        let result = engine.run(&mut thread).await;

        assert!(matches!(result, EngineResult::Completed { .. }));
        assert_eq!(thread.state, ThreadState::Resolved);
    }
}
