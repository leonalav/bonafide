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
use crate::agent::engine::{AgentEngine, EngineResult};
use crate::agent::llm::{ChatMessage, Role};
use crate::agent::orchestrator::{
    AgentRole, Budget, Message, Thread, ThreadState,
};
use crate::agent::threads::{
    get_thread, list_threads, upsert_thread, ThreadRow,
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
    pub fn build_engine(&self) -> AgentEngine {
        AgentEngine::new(
            // No-op LLM client for now — a real client is wired in
            // WS3-T1+ (mode routing) once the LLM endpoint is configured.
            Arc::new(NoopLlmClientForIpc),
            self.tool_registry.clone(),
            self.approval_gate.clone(),
            self.budget_governor.clone(),
        )
    }
}

// ── Noop LLM client (for IPC handler construction) ───────────────────────────

/// Minimal LLM client used by IPC handlers when no endpoint is
/// configured. Returns a no-tool-call response so the loop terminates
/// cleanly with a `Completed` result.
#[derive(Debug, Clone, Default)]
struct NoopLlmClientForIpc;

#[async_trait::async_trait]
impl crate::agent::llm::LlmClient for NoopLlmClientForIpc {
    async fn complete(
        &self,
        _req: crate::agent::llm::ChatRequest,
    ) -> Result<crate::agent::llm::ChatResponse, crate::agent::llm::LlmError> {
        Ok(crate::agent::llm::ChatResponse {
            content: "Agent endpoint not configured. Open Preferences → Models to set up an LLM endpoint.".to_string(),
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

/// Input for `agent_approve_action`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveActionInput {
    pub thread_id: String,
    pub tool_call_id: String,
    /// "approve" | "revise" | "reject"
    pub decision: String,
}

/// Output for `agent_approve_action` / `agent_reject_action`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalDecisionOutput {
    pub thread_id: String,
    pub accepted: bool,
    pub new_state: ThreadState,
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

    // 2. Append the user message.
    let user_msg = Message {
        id: uuid::Uuid::new_v4().to_string(),
        role: "user".to_string(),
        content: input.user_message.clone(),
        ts: chrono_millis(),
    };
    thread.messages.push(user_msg);

    // 3. Build the engine and run.
    let engine = ws_state.build_engine();
    let result = engine.run(&mut thread).await;

    // 4. Persist.
    if let Err(e) = persist_thread(&thread, &workspace_root) {
        log::warn!("[agent_ipc] failed to persist thread after run: {e}");
    }

    // 5. Build the response.
    Ok(SendMessageOutput {
        thread_id: thread.id.clone(),
        new_state: thread.state,
        escalation: ws_state.budget_governor.escalation_level(&thread.budget),
        budget: thread.budget.clone(),
        result,
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
    };    let (accepted, new_state) = match input.decision.as_str() {
        "approve" => {
            // Resume the loop — the engine will execute the approved tool.
            thread.state = ThreadState::Investigating;
            let engine = ws_state.build_engine();
            let _ = engine.run(&mut thread).await;
            (true, thread.state)
        }
        "revise" => {
            // Inject a system message asking the LLM to revise its proposal.
            thread.messages.push(Message {
                id: uuid::Uuid::new_v4().to_string(),
                role: "system".to_string(),
                content: "The user requested a revision. Please propose an alternative approach.".to_string(),
                ts: chrono_millis(),
            });
            thread.state = ThreadState::Investigating;
            let engine = ws_state.build_engine();
            let _ = engine.run(&mut thread).await;
            (true, thread.state)
        }
        "reject" => {
            thread.state = ThreadState::Rejected;
            (false, ThreadState::Rejected)
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
    Ok(Thread::new(input.thread_id.clone(), role, input.run_id.clone(), event_log_path))
}

/// Convert a `ThreadRow` (DB shape) into an in-memory `Thread` (engine shape).
fn row_to_thread(row: &ThreadRow, _root: &std::path::Path, _tool_registry: Arc<ToolRegistry>) -> Result<Thread, String> {
    let role = crate::agent::orchestrator::agent_role_from_str(&row.role)
        .ok_or_else(|| format!("Unknown role: {}", row.role))?;
    let state = parse_thread_state(&row.state);

    let event_log_path = bonafide_dir()
        .join(&row.workspace_hash)
        .join(format!("threads/{}.jsonl", row.id));

    // Replay the JSONL event log to restore messages + trace.
    let mut thread = Thread::new(row.id.clone(), role, None, event_log_path);
    thread.state = state;
    thread.budget.spent_dollars = row.budget_spent_dollars;
    thread.budget.spent_gpu_hours = row.budget_spent_gpu_hours;

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
            NoopLlmClientForIpc
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
        assert!(!resp.content.is_empty());
    }
}
