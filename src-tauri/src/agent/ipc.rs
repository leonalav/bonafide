//! Agent IPC commands — bridge between the renderer's agent surfaces
//! (`AgentContent`, `Composer`, `WorkflowPanel`) and the backend engine
//! + tool registry.
//!
//! ## Per Appendix B
//!
//! The renderer talks to the agent system via these commands:
//!
//! - `agent_send_message`: submit a user message and run the engine loop
//! - `agent_stop_thread`: stop the engine loop for a thread
//! - `agent_approve_action`: approve a pending tool call (resumes loop)
//! - `agent_reject_action`: reject a pending tool call (transitions to
//!   `Rejected` or back to `Investigating` per the user's choice)
//!
//! ## Engine construction
//!
//! Each IPC handler constructs a fresh `AgentEngine` per call. The
//! expensive parts (`LlmClient`, `ToolRegistry`, `ApprovalGate`) are
//! cached in app state when available, but the engine itself is cheap
//! to build and we want to avoid stale state across long-running
//! sessions.
//!
//! ## Thread persistence
//!
//! Every command that mutates a thread persists it to the SQLite row
//! via `agent::threads::upsert_thread` and appends to the JSONL event
//! log. On renderer restart, `replay_thread` rehydrates the state from
//! the JSONL log so the loop can resume mid-flight.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::agent::approval::ApprovalGate;
use crate::agent::budget::{BudgetGovernor, DefaultBudgetGovernor, EscalationLevel, NoopBudgetGovernor};
use crate::agent::engine::{AgentEngine, EngineResult, ToolArtifact};
use crate::agent::llm::{ChatMessage, EndpointPayload, Role};
use crate::agent::orchestrator::{
    AgentRole, Budget, Message, Thread, ThreadState,
};
use crate::agent::threads::{
    append_thread_event, get_thread, list_threads, upsert_thread, ThreadEvent, ThreadRow,
};
use crate::agent::tools::ToolRegistry;

// ── App state ─────────────────────────────────────────────────────────────────

/// Per-workspace shared state. Holds the tool registry, budget
/// governor, and approval gate so we don't rebuild them per IPC call.
pub struct AgentState {
    /// Workspace-root → cached (registry, approval_gate, budget_governor).
    pub workspaces: std::sync::RwLock<HashMap<String, WorkspaceAgentState>>,
}

#[derive(Clone)]
pub struct WorkspaceAgentState {
    pub workspace_root: PathBuf,
    pub tool_registry: Arc<ToolRegistry>,
    pub approval_gate: ApprovalGate,
    pub budget_governor: Arc<dyn BudgetGovernor>,
}

impl AgentState {
    pub fn new() -> Self {
        Self {
            workspaces: std::sync::RwLock::new(HashMap::new()),
        }
    }

    /// Get-or-create the per-workspace agent state.
    pub fn get_or_create(&self, workspace_root: PathBuf) -> WorkspaceAgentState {
        let key = workspace_root.to_string_lossy().to_string();

        // Fast path: already cached.
        if let Ok(guard) = self.workspaces.read() {
            if let Some(state) = guard.get(&key) {
                return state.clone();
            }
        }

        // Slow path: build it.
        let approval_gate = ApprovalGate::default();
        let tool_registry = Arc::new(ToolRegistry::new(
            approval_gate.clone(),
            workspace_root.clone(),
        ));
        let budget_governor: Arc<dyn BudgetGovernor> =
            Arc::new(DefaultBudgetGovernor::new(tool_registry.clone()));

        let state = WorkspaceAgentState {
            workspace_root: workspace_root.clone(),
            tool_registry,
            approval_gate,
            budget_governor,
        };

        if let Ok(mut guard) = self.workspaces.write() {
            guard.insert(key, state.clone());
        }
        state
    }
}

impl Default for AgentState {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkspaceAgentState {
    /// Build an `AgentEngine` for this workspace.
    ///
    /// When `endpoint` is `Some(payload)`, constructs a real
    /// `OpenAiCompatibleClient` from the payload and uses it.
    /// When `endpoint` is `None`, falls back to `NoopLlmClientForIpc`
    /// which returns a "no endpoint configured" message — the engine
    /// will surface this as `EngineResult::LlmError` rather than
    /// silently returning a fake success.
    pub fn build_engine(
        &self,
        endpoint: Option<&EndpointPayload>,
    ) -> AgentEngine {
        let llm_client: Arc<dyn crate::agent::llm::LlmClient> = match endpoint {
            Some(payload) => {
                match crate::agent::llm::OpenAiCompatibleClient::from_endpoint(
                    payload.clone(),
                ) {
                    Ok(client) => Arc::new(client),
                    Err(e) => {
                        log::warn!(
                            "[agent_ipc] failed to build LLM client from endpoint '{}': {e}; \
                             falling back to noop",
                            payload.id
                        );
                        Arc::new(NoopLlmClientForIpc {
                            fallback_msg: Some(format!(
                                "Failed to initialise endpoint '{}': {e}",
                                payload.label
                            )),
                        })
                    }
                }
            }
            None => Arc::new(NoopLlmClientForIpc::default()),
        };

        AgentEngine::new(
            llm_client,
            self.tool_registry.clone(),
            self.approval_gate.clone(),
            self.budget_governor.clone(),
        )
    }
}

// ── Noop LLM client (for IPC handler construction) ───────────────────────────

/// Minimal LLM client used by IPC handlers when no endpoint is
/// configured, or when the endpoint failed to initialise.
///
/// Returns a no-tool-call response so the loop terminates cleanly
/// with a `Completed` result. The message is configurable so callers
/// can pass a descriptive error string (e.g. "Failed to init endpoint
/// 'My Endpoint': NoEndpoint") rather than the generic "not configured"
/// text — that distinction helps the renderer show a more precise error.
#[derive(Debug, Clone)]
struct NoopLlmClientForIpc {
    /// When `Some`, the client was constructed with an endpoint that
    /// failed to initialise — use this as the error message so the user
    /// knows which endpoint failed.
    fallback_msg: Option<String>,
}

impl Default for NoopLlmClientForIpc {
    fn default() -> Self {
        Self { fallback_msg: None }
    }
}

#[async_trait::async_trait]
impl crate::agent::llm::LlmClient for NoopLlmClientForIpc {
    async fn complete(
        &self,
        _req: crate::agent::llm::ChatRequest,
    ) -> Result<crate::agent::llm::ChatResponse, crate::agent::llm::LlmError> {
        let content = self
            .fallback_msg
            .clone()
            .unwrap_or_else(|| "Agent endpoint not configured. Open Preferences → Models to set up an LLM endpoint.".to_string());
        Ok(crate::agent::llm::ChatResponse {
            content,
            tool_calls: Vec::new(),
            usage: None,
        })
    }
}

// ── Public IPC payload types ────────────────────────────────────────────────

/// Input for `agent_send_message`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageInput {
    pub thread_id: String,
    pub user_message: String,
    pub role: Option<AgentRole>,
    pub run_id: Option<String>,
    pub model_id: Option<String>,
    /// The fully-configured endpoint the renderer selected.
    /// `None` when the user has not configured any endpoint
    /// (the engine will return `EngineResult::LlmError`).
    #[serde(default)]
    pub endpoint: Option<EndpointPayload>,
}

/// Output for `agent_send_message`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageOutput {
    pub thread_id: String,
    pub result: EngineResult,
    pub new_state: ThreadState,
    pub escalation: EscalationLevel,
    pub budget: Budget,
    /// Structured tool-call records produced during the engine run.
    /// Each entry maps to a `ToolArtifact` card rendered inline in
    /// the renderer's chat. Empty when the engine did not invoke any
    /// tools.
    #[serde(default)]
    pub tool_artifacts: Vec<ToolArtifact>,
}

/// Input for `agent_stop_thread`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopThreadInput {
    pub thread_id: String,
}

/// Output for `agent_stop_thread`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopThreadOutput {
    pub thread_id: String,
    pub stopped: bool,
}

/// Input for `agent_approve_action` / `agent_reject_action`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveActionInput {
    pub thread_id: String,
    pub tool_call_id: String,
    /// "approve" | "revise" | "reject"
    pub decision: String,
    /// The fully-configured endpoint the renderer selected.
    /// `None` when the user has not configured any endpoint (the
    /// engine will return `EngineResult::LlmError` with the standard
    /// "not configured" message).
    ///
    /// CRITICAL FIX (PROD): the renderer previously only forwarded
    /// the endpoint on `agent_send_message`. When the user clicked
    /// APPROVE on a tool, the resume engine.run was built with
    /// `build_engine(None)` and silently fell back to the
    /// `NoopLlmClientForIpc` — surfacing a misleading "Agent
    /// endpoint not configured" error even though the endpoint was
    /// perfectly fine moments earlier. Forwarding it here restores
    /// the original LLM client on resume.
    #[serde(default)]
    pub endpoint: Option<EndpointPayload>,
}

/// Output for `agent_approve_action` / `agent_reject_action`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalDecisionOutput {
    pub thread_id: String,
    pub accepted: bool,
    pub new_state: ThreadState,
    /// Engine result from the resume after the user's decision.
    /// `None` for `"reject"` because the engine does not re-run after
    /// rejection (the thread is moved to `Rejected` and that's the end
    /// of the loop). For `"approve"` and `"revise"`, this is whatever
    /// `engine.run` produced on the next iteration: `Completed`,
    /// `AwaitingApproval` (a second tool needs approval), `BudgetExceeded`,
    /// or `LlmError`.
    ///
    /// CRITICAL FIX (PROD): without this field the renderer couldn't
    /// see what the engine did after the approval. `onApproveArtifact`
    /// in the chat surface was fire-and-forget on the original
    /// `(threadId, accepted, newState)` payload, so the body text
    /// stayed as the stale "🔐 Approval Required / Tool call: ..."
    /// markdown even after the engine had successfully resumed and
    /// produced a final answer. Surfacing the result here lets the
    /// renderer patch the chat the same way `agent_send_message`
    /// already does.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<EngineResult>,
    /// Structured tool-call records produced during the resume.
    /// Empty for `"reject"`. The renderer turns each entry into an
    /// inline `ToolArtifact` card under the assistant message.
    #[serde(default)]
    pub tool_artifacts: Vec<ToolArtifact>,
}

// ── IPC commands ─────────────────────────────────────────────────────────────

/// Submit a user message and run the engine loop.
///
/// The renderer calls this from `AgentContent.tsx` on user submit. The
/// engine runs one or more iterations until termination (final answer,
/// approval request, budget exceeded, or max iterations), then we
/// persist the updated thread and return the result.
#[tauri::command]
pub async fn agent_send_message(
    input: SendMessageInput,
    workspace_root: String,
    state: State<'_, Arc<AgentState>>,
) -> Result<SendMessageOutput, String> {
    let workspace_root_buf = PathBuf::from(&workspace_root);
    let ws_state = state.get_or_create(workspace_root_buf.clone());

    // 1. Load or create the thread.
    let mut thread = match load_or_init_thread(
        &input,
        &workspace_root,
        &workspace_root_buf,
        ws_state.tool_registry.clone(),
    ) {
        Ok(t) => t,
        Err(e) => return Err(format!("Failed to load thread: {e}")),
    };

    // CRITICAL FIX (PROD): the renderer's endpoint picker computes
    // `effectiveModel = selectedEndpoint?.defaultModel ?? builtinId`
    // and forwards it via `SendMessageInput.model_id`. The previous
    // code dropped that field on the floor and left the thread's
    // `model_id` at its hardcoded default ("claude-sonnet-4"),
    // which is why selecting a configured endpoint had no effect.
    // Apply the override here so the LLM call uses the user's pick.
    if let Some(model_id) = input.model_id.as_ref() {
        if !model_id.trim().is_empty() {
            thread.model_id = model_id.clone();
        }
    }

    // 2. Append the user message.
    //
    // CRITICAL FIX (PROD): also persist the message to the JSONL
    // event log so `engine.run()`'s `replay_thread` call
    // rehydrates it on the next iteration. Without this, the
    // in-memory push is silently overwritten by replay — the LLM
    // sees no user message, ignores the prompt, and emits
    // arbitrary tool calls or generic responses.
    let user_msg = Message {
        id: uuid::Uuid::new_v4().to_string(),
        role: "user".to_string(),
        content: input.user_message.clone(),
        tool_call_id: None,
        tool_calls: None,
        ts: chrono_millis(),
    };
    let _ = append_thread_event(
        &thread.event_log_path,
        &ThreadEvent::from_message(&user_msg),
    );
    thread.messages.push(user_msg);

    // 3. Build the engine and run.
    // Pass the endpoint so the engine uses a real OpenAiCompatibleClient
    // when configured. When `input.endpoint` is None the engine falls back
    // to `NoopLlmClientForIpc` which surfaces a clear "not configured"
    // error — NOT a silent fake success.
    let engine = ws_state.build_engine(input.endpoint.as_ref());
    let result = engine.run(&mut thread).await;

    // 4. Sanitise any LLM errors before sending to the renderer.
    // Never include the API key in error messages — even if the key is
    // already in the payload, an auth failure should surface as a
    // generic "check your key" message.
    let result = sanitise_llm_error(result);

    // 5. Capture the structured tool-artifact trail from the engine
    // so the renderer can render each invocation as an inline card.
    // We move the artifacts out of the thread to avoid cloning.
    let tool_artifacts = std::mem::take(&mut thread.tool_artifacts);

    // 5. Persist.
    if let Err(e) = persist_thread(&thread, &workspace_root) {
        log::warn!("[agent_ipc] failed to persist thread after run: {e}");
    }

    // 6. Build the response.
    Ok(SendMessageOutput {
        thread_id: thread.id.clone(),
        new_state: thread.state,
        escalation: ws_state.budget_governor.escalation_level(&thread.budget),
        budget: thread.budget.clone(),
        result,
        tool_artifacts,
    })
}

/// Stop the engine loop for a thread. Transitions the thread to
/// `Stopped` and persists the change. A no-op when the thread is
/// already in a terminal state (`Resolved`, `Rejected`, `Stopped`).
#[tauri::command]
pub async fn agent_stop_thread(
    input: StopThreadInput,
    workspace_root: String,
) -> Result<StopThreadOutput, String> {
    let root = PathBuf::from(&workspace_root);

    let conn = open_workspace_db(&root)?;

    let mut row = match get_thread(&conn, &input.thread_id) {
        Ok(Some(row)) => row,
        Ok(None) => return Err(format!("Thread not found: {}", input.thread_id)),
        Err(e) => return Err(format!("Failed to load thread: {e}")),
    };

    let already_terminal = matches!(
        row.state.as_str(),
        "resolved" | "rejected" | "stopped"
    );

    if !already_terminal {
        row.state = "stopped".to_string();
        if let Err(e) = upsert_thread(&conn, &row) {
            return Err(format!("Failed to persist stop: {e}"));
        }
    }

    Ok(StopThreadOutput {
        thread_id: input.thread_id,
        stopped: !already_terminal,
    })
}

/// Approve a pending tool call. The engine was paused in
/// `AwaitingApproval` state; resuming it depends on the decision:
/// - `"approve"`: resume execution, run the tool
/// - `"revise"`: send a "please revise" message back to the LLM
/// - `"reject"`: transition the thread to `Rejected`
#[tauri::command]
pub async fn agent_approve_action(
    input: ApproveActionInput,
    workspace_root: String,
    state: State<'_, Arc<AgentState>>,
) -> Result<ApprovalDecisionOutput, String> {
    let workspace_root_buf = PathBuf::from(&workspace_root);
    let ws_state = state.get_or_create(workspace_root_buf.clone());

    let root = PathBuf::from(&workspace_root);

    let conn = open_workspace_db(&root)?;
    let row = match get_thread(&conn, &input.thread_id) {
        Ok(Some(r)) => r,
        Ok(None) => return Err(format!("Thread not found: {}", input.thread_id)),
        Err(e) => return Err(format!("Failed to load thread: {e}")),
    };

    let mut thread = match row_to_thread(&row, &workspace_root_buf, ws_state.tool_registry.clone()) {
        Ok(t) => t,
        Err(e) => return Err(format!("Failed to rehydrate thread: {e}")),
    };

    let (accepted, new_state, result, tool_artifacts) = match input.decision.as_str() {
        "approve" => {
            // Smart resume: the engine paused with a pending
            // tool_call (stored on the thread by the approval
            // gate). Resume by (1) executing that pending call
            // directly via the tool registry, (2) recording the
            // result back on the thread, (3) clearing the
            // pending slot, and (4) only THEN asking the
            // engine to continue. This avoids the classic
            // "approve → engine re-prompts LLM → LLM re-issues
            // the same tool_call → another approval request"
            // infinite loop that would otherwise happen
            // because the LLM-facing history has no record of
            // the approval decision.
            //
            // If no pending call is on the thread (renderer
            // restart, or the LLM already produced text after
            // approval was given), fall back to the old
            // "just resume" path so the model can react to
            // the human's decision with *some* output.
            if let Some(pending) = thread.pending_tool_call.take() {
                // Pop the synthetic "paused" tool message if
                // it's still the most recent entry.
                if let Some(last) = thread.messages.last() {
                    if last.role == "tool"
                        && last.tool_call_id.as_deref() == Some(pending.id.as_str())
                    {
                        thread.messages.pop();
                    }
                }

                // Execute directly via the registry.
                let result = ws_state.tool_registry.execute(&pending).await;

                // Record the real result back on the thread
                // so the LLM can see it on the next iteration.
                //
                // CRITICAL FIX (PROD): the engine's `run()` calls
                // `replay_thread()` on every invocation, which
                // **overwrites** `thread.messages` from the JSONL
                // event log. Before this fix, the just-pushed tool
                // message was discarded on the next `engine.run`,
                // so the LLM never saw the `apply_patch` result,
                // re-issued the same tool_call, and the loop
                // re-prompted the user with another approval card.
                // The fix is two-fold: (1) push the Message into
                // `thread.messages` (already done), AND (2) append
                // the same Message to the JSONL event log so
                // `replay_thread` rehydrates it. Without (2), the
                // in-memory push is silently dropped.
                let tool_msg = Message {
                    id: uuid::Uuid::new_v4().to_string(),
                    role: "tool".to_string(),
                    content: serde_json::to_string(&result)
                        .unwrap_or_else(|_| format!("{:?}", result)),
                    tool_call_id: Some(pending.id.clone()),
                    tool_calls: None,
                    ts: chrono_millis(),
                };
                let _ = append_thread_event(
                    &thread.event_log_path,
                    &ThreadEvent::from_message(&tool_msg),
                );
                thread.messages.push(tool_msg);

                // CRITICAL FIX: emit a `StateTransition` to
                // `Investigating` so the JSONL event log records
                // that this approval was processed. Without this,
                // `replay_thread` on the next reload would still
                // see the thread in `AwaitingApproval` AND would
                // re-set `thread.pending_tool_call` from the
                // previously-persisted `PendingApproval` event —
                // re-executing the same tool_call on the *next*
                // user click. The state-transition event tells
                // replay "the pending approval is resolved; clear
                // it", which the `StateTransition` arm in
                // `replay_thread` does by setting
                // `pending_tool_call = None` whenever the new
                // state is not `AwaitingApproval`.
                let _ = append_thread_event(
                    &thread.event_log_path,
                    &ThreadEvent::state_transition(
                        ThreadState::AwaitingApproval,
                        ThreadState::Investigating,
                        chrono_millis(),
                    ),
                );
            } else {
                log::info!(
                    "[agent_ipc] approve: thread {} had no \
                     pending tool_call stored (renderer \
                     restart on a pre-WS2-T7 log?); resuming \
                     engine without direct execute",
                    thread.id,
                );
            }

            thread.state = ThreadState::Investigating;
            let engine = ws_state.build_engine(input.endpoint.as_ref());
            let result = engine.run(&mut thread).await;
            let result = sanitise_llm_error(result);
            // Hand the engine's tool-artifact trail back to the renderer
            // so it can refresh the inline cards in the assistant message.
            // This is the same shape `agent_send_message` returns, so the
            // renderer can reuse the same update path.
            let tool_artifacts = std::mem::take(&mut thread.tool_artifacts);
            (true, thread.state, Some(result), tool_artifacts)
        }
        "revise" => {
            // Inject a system message asking the LLM to revise its proposal.
            //
            // CRITICAL: also persist to the JSONL event log so the
            // engine's `replay_thread` on the next `engine.run`
            // rehydrates the message. Without this, the in-memory
            // push is silently overwritten by replay and the LLM
            // never sees the revision request.
            let revise_msg = Message {
                id: uuid::Uuid::new_v4().to_string(),
                role: "system".to_string(),
                content: "The user requested a revision. Please propose an alternative approach.".to_string(),
                tool_call_id: None,
                tool_calls: None,
                ts: chrono_millis(),
            };
            let _ = append_thread_event(
                &thread.event_log_path,
                &ThreadEvent::from_message(&revise_msg),
            );
            thread.messages.push(revise_msg);
            thread.state = ThreadState::Investigating;
            let engine = ws_state.build_engine(input.endpoint.as_ref());
            let result = engine.run(&mut thread).await;
            let result = sanitise_llm_error(result);
            let tool_artifacts = std::mem::take(&mut thread.tool_artifacts);
            (true, thread.state, Some(result), tool_artifacts)
        }
        "reject" => {
            // Refuse the tool call: mark the thread `Rejected` and signal
            // the renderer to clear the body / mark the approval artifact
            // failed. We intentionally do NOT re-run the engine here —
            // there's no work to resume after a refusal.
            //
            // `result = None` tells the renderer "no engine output to
            // surface" so it can short-circuit the body update path.
            thread.state = ThreadState::Rejected;
            (false, ThreadState::Rejected, None, Vec::new())
        }
        other => return Err(format!("Unknown decision: {other}")),
    };

    // Persist.
    if let Err(e) = persist_thread(&thread, &workspace_root) {
        log::warn!("[agent_ipc] failed to persist thread after approval: {e}");
    }

    Ok(ApprovalDecisionOutput {
        thread_id: input.thread_id,
        accepted,
        new_state,
        result,
        tool_artifacts,
    })
}

/// Reject a pending tool call. Convenience alias for
/// `agent_approve_action` with `decision = "reject"` — the renderer
/// exposes both names so the API is symmetric.
#[tauri::command]
pub async fn agent_reject_action(
    input: ApproveActionInput,
    workspace_root: String,
    state: State<'_, Arc<AgentState>>,
) -> Result<ApprovalDecisionOutput, String> {
    let mut input = input;
    input.decision = "reject".to_string();
    agent_approve_action(input, workspace_root, state).await
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Compute the workspace hash for SQLite lookup.
fn compute_hash(root: &std::path::Path) -> String {
    crate::agent::compute_workspace_hash(root)
}

/// Open the workspace database. Errors are stringified for the renderer.
fn open_workspace_db(root: &std::path::Path) -> Result<rusqlite::Connection, String> {
    let root_owned = root.to_path_buf();
    let handle = std::thread::spawn(move || -> Result<_, String> {
        let (conn, _hash) = crate::graph::storage::open_workspace_db(&root_owned)
            .map_err(|e| format!("Failed to open workspace DB: {e}"))?;
        Ok(conn)
    });
    handle.join().map_err(|e| format!("thread join error: {e:?}"))?
}

/// Load the thread from SQLite or create a fresh one.
fn load_or_init_thread(
    input: &SendMessageInput,
    workspace_root: &str,
    _workspace_root_buf: &std::path::Path,
    tool_registry: Arc<ToolRegistry>,
) -> Result<Thread, String> {
    let root = PathBuf::from(workspace_root);

    let conn = open_workspace_db(&root)?;

    if let Ok(Some(row)) = get_thread(&conn, &input.thread_id) {
        return row_to_thread(&row, &root, tool_registry);
    }

    // Initialize a fresh thread.
    let role = input.role.unwrap_or(AgentRole::Debugger);
    let hash = compute_hash(&root);
    let event_log_path = bonafide_dir()
        .join(&hash)
        .join(format!("threads/{}.jsonl", input.thread_id));
    let mut thread = Thread::new(
        input.thread_id.clone(),
        role,
        input.run_id.clone(),
        event_log_path,
    );
    // Ground the system prompt in the actual workspace root so
    // the LLM doesn't fabricate placeholder paths like
    // `/home/user` when calling filesystem tools.
    thread.set_workspace_root(root);
    Ok(thread)
}

/// Convert a `ThreadRow` (DB shape) into an in-memory `Thread` (engine shape).
fn row_to_thread(row: &ThreadRow, root: &std::path::Path, _tool_registry: Arc<ToolRegistry>) -> Result<Thread, String> {
    let role = crate::agent::orchestrator::agent_role_from_str(&row.role)
        .ok_or_else(|| format!("Unknown role: {}", row.role))?;
    let state = parse_thread_state(&row.state);

    let event_log_path = bonafide_dir()
        .join(&row.workspace_hash)
        .join(format!("threads/{}.jsonl", row.id));

    // Replay the JSONL event log to restore messages + trace.
    let mut thread = Thread::new(row.id.clone(), role, None, event_log_path);
    // The DB row already pins the workspace via `workspace_hash`,
    // but we keep the absolute path on the in-memory thread too
    // so the system prompt can show it verbatim. Falls back to
    // an empty path when the caller didn't supply a real root —
    // that signals "unknown workspace" in the prompt and the
    // LLM is told to ask rather than guess.
    thread.set_workspace_root(root.to_path_buf());
    thread.state = state;
    thread.budget.spent_dollars = row.budget_spent_dollars;
    thread.budget.spent_gpu_hours = row.budget_spent_gpu_hours;

    // Restore the persisted `model_id` so the rehydrated thread
    // carries the user's selection across renderer restarts. The
    // IPC `agent_send_message` override still wins when the
    // renderer re-sends `modelId`, so this is purely a fallback
    // for the case where the renderer omits the field (e.g. a
    // future surface that forgets, or the `agent_approve_action`
    // resume path which currently also re-forwards `modelId`).
    //
    // Pre-v3 rows have `model_id: None` — the field is nullable
    // and the migration is additive, so existing rows rehydrate
    // unchanged. The first send after the migration writes the
    // column and subsequent rehydrates pick it up.
    if let Some(persisted) = row.model_id.as_ref() {
        let trimmed = persisted.trim();
        if !trimmed.is_empty() {
            thread.model_id = persisted.clone();
        }
    }

    if let Ok(replayed) = crate::agent::threads::replay_thread(
        &thread.event_log_path,
        row.id.clone(),
        role,
        None,
    ) {
        thread.messages = replayed.messages;
        thread.trace = replayed.trace;
        // replay_thread may have set a more recent state — prefer
        // whatever the event log says, falling back to the DB row.
        thread.state = replayed.state;
        // CRITICAL FIX (PROD): also copy `pending_tool_call`
        // from the replayed thread. `replay_thread` correctly
        // rehydrates this field from the `PendingApproval`
        // event in the JSONL log (the in-memory field is NOT
        // stored in the SQLite row because a renderer restart
        // is recovered via the event log). Without this copy,
        // the IPC `agent_approve_action` handler couldn't
        // execute the pending call after a renderer restart —
        // it fell into the "had no pending tool_call stored"
        // branch, called `engine.run` without first executing
        // the tool, and the engine looped back to
        // `AwaitingApproval` forever ("click APPROVE → nothing
        // happens → click again → another approval card"). This
        // is the exact bug the user hit 8 times in a row.
        thread.pending_tool_call = replayed.pending_tool_call;
    }

    Ok(thread)
}

/// Parse a snake-case state string back to the enum (local helper).
fn parse_thread_state(s: &str) -> ThreadState {
    match s {
        "idle" => ThreadState::Idle,
        "investigating" => ThreadState::Investigating,
        "hypothesis_formed" => ThreadState::HypothesisFormed,
        "patch_proposed" => ThreadState::PatchProposed,
        "smoke_verifying" => ThreadState::SmokeVerifying,
        "awaiting_approval" => ThreadState::AwaitingApproval,
        "full_run_verifying" => ThreadState::FullRunVerifying,
        "resolved" => ThreadState::Resolved,
        "rejected" => ThreadState::Rejected,
        "stopped" => ThreadState::Stopped,
        _ => ThreadState::Idle,
    }
}

/// Convert a snake-case `ThreadState` string back to the enum.
fn thread_state_from_str(s: &str) -> ThreadState {
    parse_thread_state(s)
}

/// Persist the in-memory thread to SQLite.
fn persist_thread(thread: &Thread, workspace_root: &str) -> Result<(), String> {
    use crate::agent::threads::ThreadRow;

    let root = PathBuf::from(workspace_root);
    let hash = compute_hash(&root);

    let conn = open_workspace_db(&root)?;

    let hypothesis = thread
        .hypothesis
        .as_ref()
        .and_then(|h| serde_json::to_string(h).ok());
    let patch_diff = thread.proposed_patch.as_ref().map(|p| p.diff.clone());

    let row = ThreadRow {
        id: thread.id.clone(),
        workspace_hash: hash,
        role: format!("{:?}", thread.role).to_lowercase(),
        title: format!("Thread {}", &thread.id[..8.min(thread.id.len())]),
        summary: String::new(),
        state: thread_state_to_str_v2(thread.state).to_string(),
        detail: String::new(),
        band: "active".to_string(),
        system: false,
        updated_at: chrono_millis(),
        experiment_id: None,
        budget_spent_dollars: thread.budget.spent_dollars,
        budget_spent_gpu_hours: thread.budget.spent_gpu_hours,
        hypothesis,
        patch_diff,
        smoke_result: None,
        // Persist the model the user picked so rehydrating after a
        // renderer restart does not silently fall back to the
        // hardcoded `Thread::new` seed (`"claude-sonnet-4"`). Empty
        // strings are stored as `None` so a future caller that
        // accidentally sets `model_id = ""` cannot reintroduce the
        // seed value on the next rehydrate.
        model_id: {
            let trimmed = thread.model_id.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(thread.model_id.clone())
            }
        },
    };

    upsert_thread(&conn, &row).map_err(|e| format!("upsert_thread: {e}"))
}

/// Convert a `ThreadState` enum to its snake-case wire string.
fn thread_state_to_str_v2(state: ThreadState) -> &'static str {
    crate::agent::threads::thread_state_to_string(state)
}

/// Bonafide config directory (same logic as `graph::storage::bonafide_dir`).
fn bonafide_dir() -> PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".bonafide"))
        .unwrap_or_else(|| PathBuf::from(".bonafide"))
}

/// Sanitise an `EngineResult::LlmError` before sending it to the renderer.
///
/// HTTP 401 / 403 responses include the raw body which may contain
/// the API key or other sensitive data. This function replaces those
/// messages with a generic "check your key" string so the renderer
/// never leaks credentials to the UI.
fn sanitise_llm_error(result: EngineResult) -> EngineResult {
    match result {
        EngineResult::LlmError { ref message } => {
            // Check for HTTP auth errors (401/403) which may include the key
            // in the response body. Also catch the case where the message
            // itself mentions common key substrings (defence in depth).
            let is_auth_error = message.contains("401")
                || message.contains("403")
                || message.contains("Unauthorized")
                || message.contains("Forbidden")
                || message.contains("api_key")
                || message.contains("api-key")
                || message.contains("Authorization")
                || message.contains("Bearer");

            if is_auth_error {
                EngineResult::LlmError {
                    message: "Authentication failed — check your endpoint API key.".to_string(),
                }
            } else {
                result
            }
        }
        _ => result,
    }
}

fn chrono_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_state_round_trip() {
        for state in [
            ThreadState::Idle,
            ThreadState::Investigating,
            ThreadState::HypothesisFormed,
            ThreadState::PatchProposed,
            ThreadState::SmokeVerifying,
            ThreadState::AwaitingApproval,
            ThreadState::FullRunVerifying,
            ThreadState::Resolved,
            ThreadState::Rejected,
            ThreadState::Stopped,
        ] {
            let s = thread_state_to_str_v2(state);
            let parsed = thread_state_from_str(s);
            assert_eq!(parsed, state);
        }
    }

    #[test]
    fn agent_state_default_is_empty() {
        let s = AgentState::default();
        assert!(s.workspaces.read().unwrap().is_empty());
    }

    #[test]
    fn noop_llm_client_returns_empty_response() {
        use crate::agent::llm::LlmClient;
        let result = tokio::runtime::Runtime::new().unwrap().block_on(async {
            NoopLlmClientForIpc::default()
                .complete(crate::agent::llm::ChatRequest {
                    endpoint_url: String::new(),
                    model: "test".to_string(),
                    messages: Vec::new(),
                    tools: None,
                    temperature: None,
                    stream: false,
                })
                .await
        });
        assert!(result.is_ok());
        let resp = result.unwrap();
        assert!(resp.tool_calls.is_empty());
        assert!(
            resp.content.contains("not configured"),
            "default noop message should mention 'not configured'"
        );
    }

    #[test]
    fn noop_llm_client_custom_fallback_message() {
        use crate::agent::llm::LlmClient;
        let noop = NoopLlmClientForIpc {
            fallback_msg: Some("Custom endpoint init error".to_string()),
        };
        let result = tokio::runtime::Runtime::new().unwrap().block_on(async {
            noop.complete(crate::agent::llm::ChatRequest {
                endpoint_url: String::new(),
                model: "test".to_string(),
                messages: Vec::new(),
                tools: None,
                temperature: None,
                stream: false,
            })
            .await
        });
        let resp = result.unwrap();
        assert_eq!(resp.content, "Custom endpoint init error");
    }

    #[test]
    fn sanitise_llm_error_preserves_generic_errors() {
        let result = EngineResult::LlmError {
            message: "Connection timed out after 30s".to_string(),
        };
        let sanitised = sanitise_llm_error(result.clone());
        match sanitised {
            EngineResult::LlmError { message } => {
                assert_eq!(message, "Connection timed out after 30s");
            }
            _ => panic!("expected LlmError variant"),
        }
    }

    #[test]
    fn sanitise_llm_error_hides_api_key_in_401() {
        let result = EngineResult::LlmError {
            message: r#"HTTP 401: {"error": "Invalid API key sk-abc123xyz"}"#.to_string(),
        };
        let sanitised = sanitise_llm_error(result);
        match sanitised {
            EngineResult::LlmError { message } => {
                assert!(message.contains("check your endpoint API key"));
                assert!(!message.contains("sk-abc123xyz"));
                assert!(!message.contains("Invalid API key"));
            }
            _ => panic!("expected LlmError variant"),
        }
    }

    #[test]
    fn sanitise_llm_error_hides_bearer_in_403() {
        let result = EngineResult::LlmError {
            message: "HTTP 403: Bearer token rejected".to_string(),
        };
        let sanitised = sanitise_llm_error(result);
        match sanitised {
            EngineResult::LlmError { message } => {
                assert!(message.contains("check your endpoint API key"));
                assert!(!message.contains("Bearer"));
            }
            _ => panic!("expected LlmError variant"),
        }
    }

    #[test]
    fn sanitise_llm_error_non_error_variants_pass_through() {
        let result = EngineResult::Completed {
            content: "final answer".to_string(),
        };
        let sanitised = sanitise_llm_error(result.clone());
        assert!(matches!(sanitised, EngineResult::Completed { .. }));
    }
}
