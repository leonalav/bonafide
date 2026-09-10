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

/// The active role of the agent handling this thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    Debugger,
    Scaffolder,
    Planner,
    Researcher,
    Critic,
}

// ── Budget tracking ─────────────────────────────────────────────────────────

/// Resource budget for a single Thread.
///
/// Phase 0: the struct exists and is serialised; the governor logic that
/// enforces the limits is wired in Phase 3.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
        }
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
