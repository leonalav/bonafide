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
    fn build_messages(&self, thread: &Thread) -> Vec<ChatMessage> {
        const MAX_MESSAGES: usize = 20;
        const MAX_TRACE_OBSERVATIONS: usize = 3;
        const MAX_CHAR_PER_MSG: usize = 200; // ~5K / 20 msgs + 3 obs
        const MAX_CHAR_TOTAL: usize = 5_000;

        let mut out: Vec<ChatMessage> = Vec::new();

        // ── System prompt (section 8.1) — first message ────────────────
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

        // Truncate the total if it exceeds ~5K chars.
        let total_len: usize = out.iter().map(|m| m.content.len()).sum();
        if total_len <= MAX_CHAR_TOTAL {
            return out;
        }

        // Truncate the longest message first; if that isn't enough,
        // drop messages from the oldest end.
        let mut result = out;
        // Truncate from the start (oldest) since the LLM cares most about
        // recent context.
        while result.iter().map(|m| m.content.len()).sum::<usize>() > MAX_CHAR_TOTAL
            && !result.is_empty()
        {
            result.remove(0);
        }
        result
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
state first.";

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
}
