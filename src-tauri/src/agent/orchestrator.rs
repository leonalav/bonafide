//! Agent orchestrator — core types and event-log helpers.
//!
//! Phase 0 implements only the type scaffold and event-sourcing log
//! infrastructure. The actual agent loop is stubbed.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

// ── Thread state machine ────────────────────────────────────────────────────

/// Where a Thread currently stands in the investigation lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadState {
    Idle,
    Investigating,
    HypothesisFormed,
    PatchProposed,
    SmokeVerifying,
    AwaitingApproval,
    FullRunVerifying,
    Resolved,
    Rejected,
    Stopped,
}

/// Convert an `AgentRole` enum to its snake_case wire string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    Debugger,
    Scaffolder,
    Planner,
    Researcher,
    Critic,
}

/// Convert a snake-case role string back to an `AgentRole`.
pub fn agent_role_from_str(s: &str) -> Option<AgentRole> {
    Some(match s {
        "debugger" => AgentRole::Debugger,
        "scaffolder" => AgentRole::Scaffolder,
        "planner" => AgentRole::Planner,
        "researcher" => AgentRole::Researcher,
        "critic" => AgentRole::Critic,
        _ => return None,
    })
}

// ── Budget tracking ─────────────────────────────────────────────────────────

/// Resource budget for a single Thread.
///
/// Phase 0: the struct exists and is serialised; the governor logic that
/// enforces the limits is wired in Phase 3.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    pub max_gpu_hours: f32,
    pub max_dollars: f32,
    pub spent_gpu_hours: f32,
    pub spent_dollars: f32,
}

impl Default for Budget {
    fn default() -> Self {
        Self {
            max_gpu_hours: 10.0,
            max_dollars: 10.0,
            spent_gpu_hours: 0.0,
            spent_dollars: 0.0,
        }
    }
}

// ── Message / trace types ────────────────────────────────────────────────────

/// A single message in a Thread's conversation history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub role: String,
    pub content: String,
    pub ts: i64,
}

/// A single step in the agent's reasoning trace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceStep {
    pub step: u32,
    pub content: String,
    pub ts: i64,
}

// ── Hypothesis / patch types ─────────────────────────────────────────────────

/// A reference to a piece of evidence gathered during investigation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceRef {
    pub tool_call_id: String,
    pub summary: String,
}

/// The agent's current hypothesis about the root cause of a performance
/// regression or bug under investigation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hypothesis {
    pub verdict: String,
    pub statement: String,
    pub evidence: Vec<EvidenceRef>,
    pub confidence: f32,
    pub ruled_out: Vec<String>,
}

/// A proposed code change produced by the agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Patch {
    pub file: String,
    pub diff: String,
    pub created_at: i64,
}

// ── Thread ───────────────────────────────────────────────────────────────────

/// The central data structure representing one investigation session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Thread {
    pub id: String,
    pub run_id: Option<String>,
    pub role: AgentRole,
    pub state: ThreadState,
    pub model_id: String,
    pub messages: Vec<Message>,
    pub trace: Vec<TraceStep>,
    pub hypothesis: Option<Hypothesis>,
    pub proposed_patch: Option<Patch>,
    pub budget: Budget,
    pub event_log_path: PathBuf,
    /// Number of hypothesis iterations consumed in this thread.
    /// The Debugger increments this each time a `## Hypothesis`
    /// marker is detected while in `Investigating` state. When
    /// it exceeds the active mode's `max_hypothesis_iterations`,
    /// the engine escalates instead of forming another hypothesis.
    ///
    /// Defaults to 0 so a freshly-constructed thread has full
    /// hypothesis budget available.
    ///
    /// Persisted with the thread row so a renderer restart can
    /// resume the iteration count without losing context.
    #[serde(default)]
    pub hypothesis_iterations: u32,
    /// Number of patch revision rounds consumed in this thread.
    /// The Critic integration increments this each time the
    /// Critic returns a score below `CRITIC_RISKY_THRESHOLD` and
    /// the engine sends the proposal back for revision. After
    /// `max_hypothesis_iterations` rounds, the engine escalates.
    ///
    /// Defaults to 0.
    #[serde(default)]
    pub patch_revisions: u32,
    /// Structured tool-call records produced during the engine run.
    /// The engine appends one entry per tool invocation; the IPC
    /// handler moves this Vec out and returns it to the renderer
    /// so each call becomes an inline `ToolArtifact` card.
    ///
    /// Not persisted with the SQLite row (the engine replays trace
    /// steps on resume; this Vec is purely the live turn's
    /// artifacts). Kept on the thread so the engine has a single
    /// owning struct to mutate.
    #[serde(default)]
    pub tool_artifacts: Vec<crate::agent::engine::ToolArtifact>,
}

impl Thread {
    /// Construct a new Thread with the given id, role, run_id, and event log path.
    pub fn new(
        id: String,
        role: AgentRole,
        run_id: Option<String>,
        event_log_path: PathBuf,
    ) -> Self {
        Self {
            id,
            run_id,
            role,
            state: ThreadState::Idle,
            model_id: "claude-sonnet-4".to_string(),
            messages: Vec::new(),
            trace: Vec::new(),
            hypothesis: None,
            proposed_patch: None,
            budget: Budget::default(),
            event_log_path,
            hypothesis_iterations: 0,
            patch_revisions: 0,
            tool_artifacts: Vec::new(),
        }
    }

    /// Reset the iteration counters so a thread can be reused for
    /// a new investigation without dropping the conversation
    /// history. The engine calls this when transitioning to
    /// `Resolved` or `Rejected` so the user can start a fresh
    /// investigation on the same thread without leaking
    /// iteration count.
    pub fn reset_iteration_counters(&mut self) {
        self.hypothesis_iterations = 0;
        self.patch_revisions = 0;
    }
}

// ── Event-sourcing helpers ────────────────────────────────────────────────────

/// Append a JSON event string to the thread's append-only event log.
///
/// The file is created if it does not exist; each call appends exactly one
/// line terminated by `\n`.
pub fn append_event_log(event_log_path: &PathBuf, event: &str) -> std::io::Result<()> {
    // PHASE0: create parent dirs if missing (spec: "creates parent dirs")
    if let Some(parent) = event_log_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(event_log_path)?;
    writeln!(file, "{event}")
}
