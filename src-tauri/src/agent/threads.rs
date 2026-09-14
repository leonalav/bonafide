//! Thread persistence layer (v2 schema).
//!
//! The orchestrator's `Thread` struct is the rich in-memory type used
//! during an active session. The renderer only needs a small subset
//! for the Workflow inbox (id, role, title, summary, state, band,
//! updated_at) plus the v2 columns added by `migrations::ensure_v2_columns`
//! (experiment_id, budget_spent_*, hypothesis, patch_diff, smoke_result).
//! We model the persisted row separately instead of mirroring every
//! field on the in-memory `Thread`.
//!
//! ## v2 schema additions (section 11.2)
//!
//! ```sql
//! ALTER TABLE threads ADD COLUMN experiment_id TEXT;
//! ALTER TABLE threads ADD COLUMN budget_spent_dollars REAL DEFAULT 0.0 NOT NULL;
//! ALTER TABLE threads ADD COLUMN budget_spent_gpu_hours REAL DEFAULT 0.0 NOT NULL;
//! ALTER TABLE threads ADD COLUMN hypothesis TEXT;       -- JSON-serialised Hypothesis
//! ALTER TABLE threads ADD COLUMN patch_diff TEXT;        -- current proposed patch diff
//! ALTER TABLE threads ADD COLUMN smoke_result TEXT;      -- smoke test outcome
//! ```
//!
//! All write paths go through `upsert_thread` so a thread created on
//! one renderer call and then updated by a later event ends up with
//! exactly one row. Reads return rows sorted by `updated_at` so the
//! inbox naturally surfaces active items first.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::agent::orchestrator::{
    AgentRole, Hypothesis, Message, Patch, Thread, ThreadState, TraceStep,
};

// ── Thread state parsing helpers ──────────────────────────────────────────────

/// Convert a `ThreadState` enum to its snake_case wire string.
///
/// Convert a `ThreadState` enum to its snake_case wire string.
///
/// Mirrors `#[serde(rename_all = "snake_case")]` on the enum so the
/// SQLite row and the in-memory enum agree on the string form.
pub fn thread_state_to_string(state: ThreadState) -> &'static str {
    match state {
        ThreadState::Idle => "idle",
        ThreadState::Investigating => "investigating",
        ThreadState::HypothesisFormed => "hypothesis_formed",
        ThreadState::PatchProposed => "patch_proposed",
        ThreadState::SmokeVerifying => "smoke_verifying",
        ThreadState::AwaitingApproval => "awaiting_approval",
        ThreadState::FullRunVerifying => "full_run_verifying",
        ThreadState::Resolved => "resolved",
        ThreadState::Rejected => "rejected",
        ThreadState::Stopped => "stopped",
    }
}

/// Convert a snake-case state string back to a `ThreadState`.
///
/// Returns `None` when the string doesn't match a known state —
/// happens for forward-incompatible rows written by a newer build.
/// Callers should fall back to `ThreadState::Idle` in that case.
fn thread_state_from_str(s: &str) -> Option<ThreadState> {
    Some(match s {
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
        _ => return None,
    })
}

/// Convert an `AgentRole` enum to its snake_case wire string.
fn agent_role_to_string(role: AgentRole) -> &'static str {
    match role {
        AgentRole::Debugger => "debugger",
        AgentRole::Scaffolder => "scaffolder",
        AgentRole::Planner => "planner",
        AgentRole::Researcher => "researcher",
        AgentRole::Critic => "critic",
    }
}

/// Convert a snake-case role string back to an `AgentRole`.
fn agent_role_from_str(s: &str) -> Option<AgentRole> {
    Some(match s {
        "debugger" => AgentRole::Debugger,
        "scaffolder" => AgentRole::Scaffolder,
        "planner" => AgentRole::Planner,
        "researcher" => AgentRole::Researcher,
        "critic" => AgentRole::Critic,
        _ => return None,
    })
}

// ── ThreadRow ────────────────────────────────────────────────────────────────

/// Persisted shape of a Thread row.
///
/// Mirrors the renderer's `ThreadBase` type in `src/data/agents.ts`.
/// Renamed for camelCase so the same struct serialises cleanly to
/// both rusqlite and JSON without `rename_all` overrides.
///
/// The v2 fields are all `Option`/`f32` with default `0.0` for the
/// numeric columns, so v1 rows (before the migration) deserialize
/// cleanly.
///
/// The v3 `model_id` field stores the model the user selected for
/// the thread (the endpoint's `defaultModel` or the built-in picker
/// fallback). Persisting it makes rehydration authoritative — without
/// it, every rehydrate lands back at the `Thread::new` seed default
/// (`"claude-sonnet-4"`) and the renderer has to re-send `modelId`
/// on every submit. Pre-v3 rows store `NULL` and the engine falls
/// back to the seed until the first send writes the column.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRow {
    pub id: String,
    pub workspace_hash: String,
    pub role: String,
    pub title: String,
    pub summary: String,
    pub state: String,
    pub detail: String,
    pub band: String,
    pub system: bool,
    /// Unix millis (matches renderer's `Date.now()` semantics).
    pub updated_at: i64,

    // ── v2 columns (section 11.2) ─────────────────────────────────────────
    /// Linked experiment id (set when the thread is bound to an experiment).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub experiment_id: Option<String>,
    /// Total dollar spend so far for this thread.
    pub budget_spent_dollars: f32,
    /// Total GPU-hours spent so far for this thread.
    pub budget_spent_gpu_hours: f32,
    /// JSON-serialised `Hypothesis` (current top-of-stack).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hypothesis: Option<String>,
    /// Proposed patch diff (latest).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch_diff: Option<String>,
    /// Smoke test outcome string (verdict + metrics summary).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub smoke_result: Option<String>,

    // ── v3 columns (model persistence) ───────────────────────────────────
    /// Model the user picked for this thread — restored on rehydrate
    /// so the next engine run does not silently fall back to the
    /// hardcoded `Thread::new` seed value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
}

impl ThreadRow {
    /// Build a ThreadRow from its in-memory `Thread` counterpart plus
    /// the workspace hash and the renderer's display fields.
    ///
    /// The `band` field is renderer-managed (it controls the inbox
    /// column grouping) and is not derivable from `Thread`, so it's
    /// passed through.
    ///
    /// `model_id` is copied from the thread's `model_id` so the next
    /// rehydrate restores the user's selection instead of falling
    /// back to the hardcoded seed in `Thread::new`. An empty string
    /// (which can happen if a future caller sets `model_id = ""`
    /// accidentally) is stored as `None` to keep the column nullable
    /// and prevent the seed value from sneaking back in.
    pub fn from_thread(
        thread: &Thread,
        workspace_hash: String,
        title: String,
        summary: String,
        band: String,
    ) -> Self {
        let hypothesis = thread
            .hypothesis
            .as_ref()
            .and_then(|h| serde_json::to_string(h).ok());
        let patch_diff = thread.proposed_patch.as_ref().map(|p| p.diff.clone());
        let model_id = {
            let trimmed = thread.model_id.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(thread.model_id.clone())
            }
        };

        Self {
            id: thread.id.clone(),
            workspace_hash,
            role: agent_role_to_string(thread.role).to_string(),
            title,
            summary,
            state: thread_state_to_string(thread.state).to_string(),
            detail: String::new(),
            band,
            system: false,
            updated_at: chrono_millis(),
            experiment_id: None,
            budget_spent_dollars: thread.budget.spent_dollars,
            budget_spent_gpu_hours: thread.budget.spent_gpu_hours,
            hypothesis,
            patch_diff,
            smoke_result: None,
            model_id,
        }
    }
}

// ── ThreadEvent ──────────────────────────────────────────────────────────────

/// A typed event in the append-only JSONL event log.
///
/// Every line in `thread.event_log_path` is one of these variants,
/// serialised as `{"v": 1, "type": "...", ...}`. The `v` field is
/// for future schema bumps; replays of older logs must remain stable.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ThreadEvent {
    /// A user, assistant, or tool message.
    ///
    /// `tool_call_id` is populated when this is a tool result
    /// message (the LLM-facing `role: "tool"` entry that pairs a
    /// `tool_calls[i]` from the previous assistant message). It
    /// is `None` for user / assistant / system / trace messages.
    ///
    /// The field defaults on read so v2 logs (which predate this
    /// field) still replay cleanly — older tool messages come back
    /// with `tool_call_id: None` and the engine's `build_messages`
    /// falls back to a generic user-role placeholder. New logs
    /// written by `agent_approve_action` and the engine itself
    /// carry the field so the round-trip is lossless.
    Message {
        v: u32,
        id: String,
        role: String,
        content: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_call_id: Option<String>,
        ts: i64,
    },
    /// A state-machine transition.
    StateTransition {
        v: u32,
        from: String,
        to: String,
        ts: i64,
    },
    /// A tool call issued by the assistant.
    ToolCall {
        v: u32,
        id: String,
        name: String,
        args_json: String,
        ts: i64,
    },
    /// A tool call result.
    ToolResult {
        v: u32,
        id: String,
        summary: String,
        ts: i64,
    },
    /// A hypothesis emitted by the assistant.
    Hypothesis {
        v: u32,
        value: String,
        ts: i64,
    },
    /// A patch proposed by the assistant.
    Patch {
        v: u32,
        diff: String,
        ts: i64,
    },
    /// A smoke-test verdict.
    SmokeResult {
        v: u32,
        verdict: String,
        ts: i64,
    },
    /// A mode-switch (section 6.2) — the agent transitions between
    /// Debugger / Scaffolder / Planner / Researcher / Critic without
    /// spawning a sub-agent. The replay path uses this to update
    /// `thread.role` on rehydration so a renderer restart restores
    /// the user's last-selected mode.
    ModeSwitch {
        v: u32,
        from: String,
        to: String,
        ts: i64,
    },
    /// A tool call awaiting human approval. Persisted so the IPC
    /// `approve_action` handler can recover the call after a
    /// renderer restart — without this, the in-memory
    /// `thread.pending_tool_call` field was lost on every reload
    /// and the engine looped back to `AwaitingApproval` forever
    /// (the bug this variant was added to fix).
    ///
    /// Wire version 1 (no bump — additive variant). Older builds
    /// that don't know this variant skip it via the
    /// "unknown variant" recovery in `replay_thread`.
    ///
    /// Cleared on the next `StateTransition` event whose `to`
    /// state is not `AwaitingApproval` — i.e. on every successful
    /// approval, rejection, timeout, or escalation.
    PendingApproval {
        v: u32,
        id: String,
        name: String,
        args_json: String,
        reason: String,
        ts: i64,
    },
}

impl ThreadEvent {
    /// Bumped when the wire shape changes in a backward-incompatible way.
    ///
    /// v1 → v2: added the `ModeSwitch` variant (WS3-T1). Older logs
    /// (v1 only) replay cleanly because the unknown-variant handling
    /// in `replay_thread` swallows unrecognised types without
    /// failing the entire log.
    ///
    /// v2 → v3: added an optional `tool_call_id` field to the
    /// `Message` variant so tool result messages can round-trip
    /// through the JSONL event log. Reads are backward-compatible
    /// via `#[serde(default)]`; v2 logs replay with `tool_call_id:
    /// None` for tool messages, which is harmless because every
    /// prior tool result lives in `ToolResult` summary events too
    /// (used as trace observations). New logs written by
    /// `agent_approve_action` and the engine carry the field.
    const WIRE_VERSION: u32 = 3;

    /// Public accessor for `WIRE_VERSION`. Use this when emitting
    /// legacy JSON (the `append_event_log` path) so the line is
    /// parseable by `replay_thread`. Without this, legacy lines
    /// fail to deserialize with "missing field `v`" because
    /// `WIRE_VERSION` is `const` (private).
    pub fn wire_version() -> u32 {
        Self::WIRE_VERSION
    }

    /// Convert a `Message` into a `ThreadEvent::Message` with the current
    /// wire version.
    pub fn from_message(msg: &Message) -> Self {
        Self::Message {
            v: Self::WIRE_VERSION,
            id: msg.id.clone(),
            role: msg.role.clone(),
            content: msg.content.clone(),
            tool_call_id: msg.tool_call_id.clone(),
            ts: msg.ts,
        }
    }

    /// Convert a `TraceStep` into a `ThreadEvent::Message` (trace steps
    /// ride on the same envelope).
    pub fn from_trace_step(step: &TraceStep) -> Self {
        Self::Message {
            v: Self::WIRE_VERSION,
            id: format!("trace-{}", step.step),
            role: "trace".to_string(),
            content: step.content.clone(),
            tool_call_id: None,
            ts: step.ts,
        }
    }

    /// Convert a `Hypothesis` into a `ThreadEvent::Hypothesis`.
    pub fn from_hypothesis(hyp: &Hypothesis) -> Self {
        let value = serde_json::to_string(hyp).unwrap_or_default();
        Self::Hypothesis {
            v: Self::WIRE_VERSION,
            value,
            ts: chrono_millis(),
        }
    }

    /// Convert a `Patch` into a `ThreadEvent::Patch`.
    pub fn from_patch(patch: &Patch) -> Self {
        Self::Patch {
            v: Self::WIRE_VERSION,
            diff: patch.diff.clone(),
            ts: patch.created_at,
        }
    }

    /// Convert a state transition into a `ThreadEvent::StateTransition`.
    pub fn state_transition(from: ThreadState, to: ThreadState, ts: i64) -> Self {
        Self::StateTransition {
            v: Self::WIRE_VERSION,
            from: thread_state_to_string(from).to_string(),
            to: thread_state_to_string(to).to_string(),
            ts,
        }
    }

    /// Convert a mode switch into a `ThreadEvent::ModeSwitch`.
    ///
    /// `from` / `to` are the snake-case role strings (e.g.
    /// `"debugger"`, `"planner"`). Used by the engine when the
    /// agent transitions between modes inside one logical thread
    /// (section 6.2 — single-agent mode switching, not sub-agent
    /// spawning).
    pub fn mode_switch(from: AgentRole, to: AgentRole, ts: i64) -> Self {
        Self::ModeSwitch {
            v: Self::WIRE_VERSION,
            from: agent_role_to_string(from).to_string(),
            to: agent_role_to_string(to).to_string(),
            ts,
        }
    }

    /// Construct a `PendingApproval` event from a `ToolCall` and a
    /// human-readable reason. Persisted by the engine at every
    /// site that pauses for approval (the `request_approval` tool,
    /// the structural approval gate, and critic-rejection
    /// escalation) so the IPC `approve_action` handler can recover
    /// the call after a renderer restart.
    ///
    /// `replay_thread` populates `thread.pending_tool_call` from
    /// this event and clears it on the next state transition away
    /// from `AwaitingApproval`.
    pub fn pending_approval(
        tool_call: &crate::agent::llm::ToolCall,
        reason: impl Into<String>,
        ts: i64,
    ) -> Self {
        Self::PendingApproval {
            v: 1,
            id: tool_call.id.clone(),
            name: tool_call.function.name.clone(),
            args_json: tool_call.function.arguments.clone(),
            reason: reason.into(),
            ts,
        }
    }
}

// ── ReplayError ──────────────────────────────────────────────────────────────

/// Errors that can arise during event-log replay.
#[derive(Debug, Error)]
pub enum ReplayError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Failed to decode line {line}: {message}")]
    Decoding { line: usize, message: String },

    /// Reserved for future use; unknown event variants are now
    /// silently logged as trace steps and skipped so v1 logs replay
    /// cleanly on a v2 build. Kept for compatibility with callers
    /// that pattern-match on the full error enum.
    #[error("Unknown event type at line {0}")]
    UnknownEventType(usize),
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Upsert a thread row. `workspace_hash` is the open-workspace
/// identifier (first 8 bytes of SHA-256 of the canonical path) — the
/// renderer passes it through so we can scope queries per workspace.
///
/// v2 columns are included in both the INSERT and the ON CONFLICT
/// UPDATE clauses so a partial Phase-0 row gets the new fields set on
/// the next write. v3 adds `model_id` so the user's endpoint
/// selection survives rehydration.
pub fn upsert_thread(conn: &Connection, row: &ThreadRow) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO threads (
            id, workspace_hash, role, title, summary, state, detail, band, system, updated_at,
            experiment_id, budget_spent_dollars, budget_spent_gpu_hours,
            hypothesis, patch_diff, smoke_result,
            model_id
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                ?11, ?12, ?13, ?14, ?15, ?16,
                ?17)
        ON CONFLICT(id) DO UPDATE SET
            workspace_hash         = excluded.workspace_hash,
            role                   = excluded.role,
            title                  = excluded.title,
            summary                = excluded.summary,
            state                  = excluded.state,
            detail                 = excluded.detail,
            band                   = excluded.band,
            system                 = excluded.system,
            updated_at             = excluded.updated_at,
            experiment_id          = excluded.experiment_id,
            budget_spent_dollars   = excluded.budget_spent_dollars,
            budget_spent_gpu_hours = excluded.budget_spent_gpu_hours,
            hypothesis             = excluded.hypothesis,
            patch_diff             = excluded.patch_diff,
            smoke_result           = excluded.smoke_result,
            model_id               = excluded.model_id
        "#,
        params![
            row.id,
            row.workspace_hash,
            row.role,
            row.title,
            row.summary,
            row.state,
            row.detail,
            row.band,
            row.system as i32,
            row.updated_at,
            row.experiment_id,
            row.budget_spent_dollars,
            row.budget_spent_gpu_hours,
            row.hypothesis,
            row.patch_diff,
            row.smoke_result,
            row.model_id,
        ],
    )?;
    Ok(())
}

/// Fetch a single thread by id.
///
/// Returns `Ok(None)` when the thread doesn't exist (vs `Err` for
/// I/O failures). Used by `rehydrate_thread` (composed in WS5-T2).
pub fn get_thread(conn: &Connection, id: &str) -> Result<Option<ThreadRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, workspace_hash, role, title, summary, state, detail, band, system, updated_at,
                experiment_id, budget_spent_dollars, budget_spent_gpu_hours,
                hypothesis, patch_diff, smoke_result,
                model_id
           FROM threads WHERE id = ?1",
    )?;

    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row_to_thread_row(row)?))
    } else {
        Ok(None)
    }
}

/// Fetch every thread for `workspace_hash`, sorted newest-first.
///
/// When `state_filter` is `Some(state)`, only threads in that state
/// are returned. This lets the renderer's Workflow inbox render
/// Active / Awaiting / Closed buckets without three round trips.
pub fn list_threads(
    conn: &Connection,
    workspace_hash: &str,
    state_filter: Option<ThreadState>,
) -> Result<Vec<ThreadRow>> {
    let state_filter_str = state_filter.map(thread_state_to_string);

    let rows = if let Some(state) = state_filter_str {
        let mut stmt = conn.prepare(
            "SELECT id, workspace_hash, role, title, summary, state, detail, band, system, updated_at,
                    experiment_id, budget_spent_dollars, budget_spent_gpu_hours,
                    hypothesis, patch_diff, smoke_result,
                    model_id
               FROM threads
              WHERE workspace_hash = ?1 AND state = ?2
              ORDER BY updated_at DESC",
        )?;
        let mapped = stmt.query_map(params![workspace_hash, state], |row| {
            row_to_thread_row(row)
        })?;
        mapped.collect::<Result<Vec<_>>>()?
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, workspace_hash, role, title, summary, state, detail, band, system, updated_at,
                    experiment_id, budget_spent_dollars, budget_spent_gpu_hours,
                    hypothesis, patch_diff, smoke_result,
                    model_id
               FROM threads
              WHERE workspace_hash = ?1
              ORDER BY updated_at DESC",
        )?;
        let mapped = stmt.query_map(params![workspace_hash], |row| {
            row_to_thread_row(row)
        })?;
        mapped.collect::<Result<Vec<_>>>()?
    };

    Ok(rows)
}

/// Persist a state-machine transition for `id`.
///
/// Updates both the `state` column and `updated_at` so a renderer
/// restart can resume the loop from the correct state. The full
/// event is also logged to the JSONL event log via
/// `append_thread_event`; this method just handles the row update.
pub fn update_thread_state(
    conn: &Connection,
    id: &str,
    new_state: ThreadState,
    ts: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE threads SET state = ?1, updated_at = ?2 WHERE id = ?3",
        params![thread_state_to_string(new_state), ts, id],
    )?;
    Ok(())
}

/// Append a single event to a thread's JSONL event log.
///
/// Creates parent directories as needed (matching the contract from
/// `orchestrator::append_event_log`). O(1) — append-only, no rewinds.
/// Lines are newline-terminated.
pub fn append_thread_event(
    event_log_path: &Path,
    event: &ThreadEvent,
) -> std::io::Result<()> {
    if let Some(parent) = event_log_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string(event)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(event_log_path)?;
    writeln!(file, "{json}")?;
    Ok(())
}

/// Replay a thread's event log into a fresh `Thread`.
///
/// Reads the JSONL line by line. Each line is decoded as a
/// `ThreadEvent` and the side effects are applied:
/// - `Message` events append to `thread.messages`
/// - `StateTransition` events update `thread.state`
/// - `Hypothesis` events update `thread.hypothesis` (JSON-decoded)
/// - `Patch` events update `thread.proposed_patch`
/// - `ToolCall` / `ToolResult` / `SmokeResult` are recorded as
///   trace steps so the audit trail survives rehydration
///
/// Returns `ReplayError::Decoding` for any malformed line; never
/// panics. Missing log files return an empty `Thread`.
pub fn replay_thread(
    event_log_path: &Path,
    thread_id: String,
    role: AgentRole,
    run_id: Option<String>,
) -> Result<Thread, ReplayError> {
    let mut thread = Thread::new(
        thread_id,
        role,
        run_id,
        event_log_path.to_path_buf(),
    );

    let file = match File::open(event_log_path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // No log yet — return empty thread (matches the fresh-thread shape).
            return Ok(thread);
        }
        Err(e) => return Err(ReplayError::Io(e)),
    };

    let reader = BufReader::new(file);
    for (idx, line_result) in reader.lines().enumerate() {
        let line = line_result?;
        let line_no = idx + 1; // 1-indexed for error messages

        // Skip blank lines without raising — log rotation or
        // pre-WS1-T2 trailing-newline artefacts must not break replay.
        if line.trim().is_empty() {
            continue;
        }

        // Parse the raw value first so we can emit a precise
        // `Decoding` error with the line number on failure.
        let value: serde_json::Value = serde_json::from_str(&line).map_err(|e| {
            ReplayError::Decoding {
                line: line_no,
                message: format!("invalid JSON: {e}"),
            }
        })?;

        // Validate the 'type' field exists before parsing as a ThreadEvent.
        let _event_type: &str = value
            .get("type")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ReplayError::Decoding {
                line: line_no,
                message: "missing 'type' field".to_string(),
            })?;

        let event: ThreadEvent = match serde_json::from_value(value) {
            Ok(ev) => ev,
            Err(e) => {
                // Treat unknown-variant errors as recoverable so a
                // forward-compatible replay doesn't break older builds.
                // We discriminate by message text — `serde_json::Error`
                // doesn't expose a public `custom` variant without the
                // trait import, and matching by category (`io` /
                // `syntax` / `data`) doesn't reliably distinguish the
                // "unknown enum variant" case.
                let msg = e.to_string();
                if msg.contains("unknown variant") {
                    // v1 logs (no `ModeSwitch`) replay cleanly on a v2
                    // build because we record a trace step and move on
                    // instead of failing the entire replay.
                    let step = TraceStep {
                        step: (thread.trace.len() as u32) + 1,
                        content: format!("unknown event at line {line_no}: {e}"),
                        ts: chrono_millis(),
                    };
                    thread.trace.push(step);
                    continue;
                }
                return Err(ReplayError::Decoding {
                    line: line_no,
                    message: format!("invalid event: {e}"),
                });
            }
        };

        match event {
            ThreadEvent::Message { id, role, content, tool_call_id, ts, .. } => {
                thread.messages.push(Message {
                    id,
                    role,
                    content,
                    tool_call_id,
                    tool_calls: None,
                    ts,
                });
            }
            ThreadEvent::StateTransition { from, to, ts, .. } => {
                if let Some(new_state) = thread_state_from_str(&to) {
                    let step = TraceStep {
                        step: (thread.trace.len() as u32) + 1,
                        content: format!("state: {from} → {to}"),
                        ts,
                    };
                    thread.trace.push(step);
                    // Any state transition away from `AwaitingApproval`
                    // resolves the pending approval — covers the IPC
                    // `approve_action` path (which transitions to
                    // `Investigating`) as well as timeouts and
                    // escalations. Without this clear, a renderer
                    // restart after a successful approval would
                    // re-set `pending_tool_call` from the previous
                    // `PendingApproval` event and re-execute the same
                    // tool_call.
                    if new_state != ThreadState::AwaitingApproval {
                        thread.pending_tool_call = None;
                    }
                    thread.state = new_state;
                }
                // If `from` references a known state, ignore (we only
                // care about the destination); if `to` is unknown,
                // keep the current state and log a trace step so the
                // user can see the migration in audit.
                let _ = thread_state_from_str(&from);
            }
            ThreadEvent::ToolCall { id, name, args_json, ts, .. } => {
                let step = TraceStep {
                    step: (thread.trace.len() as u32) + 1,
                    content: format!("ToolCall: {id} {name} {args_json}"),
                    ts,
                };
                thread.trace.push(step);
            }
            ThreadEvent::ToolResult { id, summary, ts, .. } => {
                let step = TraceStep {
                    step: (thread.trace.len() as u32) + 1,
                    content: format!("ToolResult: {id} → {summary}"),
                    ts,
                };
                thread.trace.push(step);
            }
            ThreadEvent::Hypothesis { value, ts, .. } => {
                if let Ok(hyp) = serde_json::from_str::<Hypothesis>(&value) {
                    thread.hypothesis = Some(hyp);
                }
                let step = TraceStep {
                    step: (thread.trace.len() as u32) + 1,
                    content: "Hypothesis set".to_string(),
                    ts,
                };
                thread.trace.push(step);
            }
            ThreadEvent::Patch { diff, ts, .. } => {
                thread.proposed_patch = Some(Patch {
                    file: String::new(), // file path lives in the diff header
                    diff,
                    created_at: ts,
                });
            }
            ThreadEvent::SmokeResult { verdict, ts, .. } => {
                let step = TraceStep {
                    step: (thread.trace.len() as u32) + 1,
                    content: format!("SmokeResult: {verdict}"),
                    ts,
                };
                thread.trace.push(step);
            }
            ThreadEvent::ModeSwitch { from, to, ts, .. } => {
                // Update the in-memory role so a renderer restart
                // resumes the loop in the user's last-selected mode.
                // The trace step records the transition for audit
                // and the from/to strings show up in the inbox detail.
                if let Some(new_role) = agent_role_from_str(&to) {
                    thread.role = new_role;
                }
                let step = TraceStep {
                    step: (thread.trace.len() as u32) + 1,
                    content: format!("ModeSwitch: {from} → {to}"),
                    ts,
                };
                thread.trace.push(step);
                let _ = from; // referenced for audit; new_role already used.
            }
            ThreadEvent::PendingApproval { id, name, args_json, reason, ts, .. } => {
                // Rebuild the in-memory `pending_tool_call` so the IPC
                // `approve_action` handler can find it after a
                // renderer restart. Without this rehydration, the
                // engine would loop back to `AwaitingApproval`
                // forever because the in-memory field is not
                // persisted to the SQLite row.
                //
                // The state-transition arm above clears this slot
                // whenever the thread leaves `AwaitingApproval`, so
                // a `PendingApproval` event is only "active" until
                // the next state transition — matching the in-memory
                // semantics of `thread.pending_tool_call`.
                thread.pending_tool_call = Some(crate::agent::llm::ToolCall {
                    id,
                    tool_type: "function".to_string(),
                    function: crate::agent::llm::ToolFunctionCall {
                        name,
                        arguments: args_json,
                    },
                });
                let step = TraceStep {
                    step: (thread.trace.len() as u32) + 1,
                    content: format!("AwaitingApproval: {reason}"),
                    ts,
                };
                thread.trace.push(step);
                let _ = reason; // surfaced via the trace step above.
            }
        }
    }

    Ok(thread)
}

// ── Private helpers ──────────────────────────────────────────────────────────

/// Convert a `row` produced by the threads SELECT into a `ThreadRow`.
///
/// Centralises the column-index mapping so the upsert/list/get paths
/// stay consistent. The index ordering MUST match the SELECT lists
/// in `get_thread` and `list_threads` — adding a new column means
/// bumping both ends in lockstep.
fn row_to_thread_row(row: &rusqlite::Row) -> Result<ThreadRow> {
    Ok(ThreadRow {
        id: row.get(0)?,
        workspace_hash: row.get(1)?,
        role: row.get(2)?,
        title: row.get(3)?,
        summary: row.get(4)?,
        state: row.get(5)?,
        detail: row.get(6)?,
        band: row.get(7)?,
        system: row.get::<_, i32>(8)? != 0,
        updated_at: row.get(9)?,
        experiment_id: row.get(10)?,
        budget_spent_dollars: row.get(11)?,
        budget_spent_gpu_hours: row.get(12)?,
        hypothesis: row.get(13)?,
        patch_diff: row.get(14)?,
        smoke_result: row.get(15)?,
        model_id: row.get(16)?,
    })
}

/// Return the current Unix time in milliseconds.
fn chrono_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use tempfile::tempdir;

    /// Build a fresh in-memory DB with the v2 schema (Phase 0 + v2 columns).
    fn fresh_v2_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE threads (
                id TEXT PRIMARY KEY,
                workspace_hash TEXT NOT NULL,
                role TEXT NOT NULL,
                title TEXT NOT NULL,
                summary TEXT NOT NULL,
                state TEXT NOT NULL,
                detail TEXT NOT NULL DEFAULT '',
                band TEXT NOT NULL,
                system INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL,
                experiment_id TEXT,
                budget_spent_dollars REAL NOT NULL DEFAULT 0.0,
                budget_spent_gpu_hours REAL NOT NULL DEFAULT 0.0,
                hypothesis TEXT,
                patch_diff TEXT,
                smoke_result TEXT,
                model_id TEXT
            );
            "#,
        )
        .unwrap();
        conn
    }

    /// Helper to insert a v2 row with all fields populated.
    fn make_row(id: &str, state: ThreadState) -> ThreadRow {
        ThreadRow {
            id: id.to_string(),
            workspace_hash: "ws".to_string(),
            role: "debugger".to_string(),
            title: format!("Thread {id}"),
            summary: format!("summary {id}"),
            state: thread_state_to_string(state).to_string(),
            detail: "".to_string(),
            band: "active".to_string(),
            system: false,
            updated_at: 1_000_000,
            experiment_id: None,
            budget_spent_dollars: 0.0,
            budget_spent_gpu_hours: 0.0,
            hypothesis: None,
            patch_diff: None,
            smoke_result: None,
            model_id: None,
        }
    }

    /// `update_thread_state_persists_transition`: insert row at Idle,
    /// update to Investigating, re-read; state == "investigating" and
    /// updated_at advanced.
    #[test]
    fn update_thread_state_persists_transition() {
        let conn = fresh_v2_db();
        let row = make_row("t1", ThreadState::Idle);
        upsert_thread(&conn, &row).unwrap();

        update_thread_state(&conn, "t1", ThreadState::Investigating, 2_000_000).unwrap();

        let fetched = get_thread(&conn, "t1").unwrap().unwrap();
        assert_eq!(fetched.state, "investigating");
        assert_eq!(fetched.updated_at, 2_000_000);
    }

    /// `list_threads_state_filter_returns_only_matching`: insert three
    /// rows in distinct states, list with `Some(AwaitingApproval)`;
    /// only one returned.
    #[test]
    fn list_threads_state_filter_returns_only_matching() {
        let conn = fresh_v2_db();
        upsert_thread(&conn, &make_row("a", ThreadState::Idle)).unwrap();
        upsert_thread(&conn, &make_row("b", ThreadState::AwaitingApproval)).unwrap();
        upsert_thread(&conn, &make_row("c", ThreadState::Resolved)).unwrap();

        let filtered = list_threads(&conn, "ws", Some(ThreadState::AwaitingApproval)).unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, "b");
        assert_eq!(filtered[0].state, "awaiting_approval");
    }

    /// `list_threads_no_filter_returns_all`: list with `None` returns
    /// every row in the workspace.
    #[test]
    fn list_threads_no_filter_returns_all() {
        let conn = fresh_v2_db();
        upsert_thread(&conn, &make_row("a", ThreadState::Idle)).unwrap();
        upsert_thread(&conn, &make_row("b", ThreadState::AwaitingApproval)).unwrap();
        upsert_thread(&conn, &make_row("c", ThreadState::Resolved)).unwrap();

        let all = list_threads(&conn, "ws", None).unwrap();
        assert_eq!(all.len(), 3);
    }

    /// `list_threads_state_filter_does_not_match_other_workspaces`:
    /// the state filter is AND-ed with the workspace hash.
    #[test]
    fn list_threads_state_filter_does_not_match_other_workspaces() {
        let conn = fresh_v2_db();
        let mut other_row = make_row("x", ThreadState::AwaitingApproval);
        other_row.workspace_hash = "other-ws".to_string();
        upsert_thread(&conn, &other_row).unwrap();
        upsert_thread(&conn, &make_row("b", ThreadState::AwaitingApproval)).unwrap();

        let filtered = list_threads(&conn, "ws", Some(ThreadState::AwaitingApproval)).unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, "b");
    }

    /// `get_thread_returns_none_for_missing_id`: lookup for a non-existent id.
    #[test]
    fn get_thread_returns_none_for_missing_id() {
        let conn = fresh_v2_db();
        let fetched = get_thread(&conn, "does-not-exist").unwrap();
        assert!(fetched.is_none());
    }

    /// `append_thread_event_creates_parent_dirs`: writing to a
    /// `tempdir()/"nested"/"events.jsonl"` path creates the parent.
    #[test]
    fn append_thread_event_creates_parent_dirs() {
        let tmp = tempdir().unwrap();
        let log_path = tmp.path().join("nested").join("events.jsonl");
        assert!(!log_path.parent().unwrap().exists());

        let event = ThreadEvent::state_transition(
            ThreadState::Idle,
            ThreadState::Investigating,
            1_000_000,
        );
        append_thread_event(&log_path, &event).unwrap();

        assert!(log_path.exists(), "log file should be created");
    }

    /// `replay_thread_reconstructs_state_from_jsonl`: append 5 mixed
    /// events, replay, assert the resulting Thread's state, message
    /// count, trace length.
    #[test]
    fn replay_thread_reconstructs_state_from_jsonl() {
        let tmp = tempdir().unwrap();
        let log_path: PathBuf = tmp.path().join("events.jsonl");

        append_thread_event(
            &log_path,
            &ThreadEvent::Message {
                v: 3,
                id: "m1".to_string(),
                role: "user".to_string(),
                content: "Why did run a3f9c12 diverge?".to_string(),
                tool_call_id: None,
                ts: 1_000,
            },
        )
        .unwrap();
        append_thread_event(
            &log_path,
            &ThreadEvent::state_transition(ThreadState::Idle, ThreadState::Investigating, 1_100),
        )
        .unwrap();
        append_thread_event(
            &log_path,
            &ThreadEvent::Hypothesis {
                v: 2,
                value: r#"{"verdict":"test","statement":"lr too high","evidence":[],"confidence":0.5,"ruled_out":[]}"#.to_string(),
                ts: 1_200,
            },
        )
        .unwrap();
        append_thread_event(
            &log_path,
            &ThreadEvent::state_transition(
                ThreadState::Investigating,
                ThreadState::HypothesisFormed,
                1_300,
            ),
        )
        .unwrap();
        append_thread_event(
            &log_path,
            &ThreadEvent::ToolCall {
                v: 2,
                id: "tc1".to_string(),
                name: "read_file".to_string(),
                args_json: "{}".to_string(),
                ts: 1_400,
            },
        )
        .unwrap();

        let thread = replay_thread(&log_path, "t1".to_string(), AgentRole::Debugger, None).unwrap();

        // One Message event ⇒ thread.messages.len() == 1.
        assert_eq!(thread.messages.len(), 1);
        // 4 trace steps recorded (3 state transitions + 1 tool call).
        // Wait — replay_thread records every event as a trace step
        // except Message (which goes to messages). So we expect 4
        // trace steps: 2 state transitions + 1 hypothesis + 1 tool call.
        assert_eq!(thread.trace.len(), 4);
        // Final state from the last StateTransition.
        assert_eq!(thread.state, ThreadState::HypothesisFormed);
    }

    /// `replay_thread_returns_decoding_error_on_garbage`: append
    /// `"not json\n"`, replay, assert Err(ReplayError::Decoding).
    #[test]
    fn replay_thread_returns_decoding_error_on_garbage() {
        let tmp = tempdir().unwrap();
        let log_path: PathBuf = tmp.path().join("events.jsonl");

        // Write garbage to the log without using the typed helper.
        std::fs::write(&log_path, "not json\n").unwrap();

        let result = replay_thread(&log_path, "t1".to_string(), AgentRole::Debugger, None);
        match result {
            Err(ReplayError::Decoding { line, .. }) => assert_eq!(line, 1),
            other => panic!("expected Decoding error, got {other:?}"),
        }
    }

    /// `replay_thread_handles_missing_file`: replay on a non-existent
    /// log returns an empty thread, not an error.
    #[test]
    fn replay_thread_handles_missing_file() {
        let tmp = tempdir().unwrap();
        let log_path: PathBuf = tmp.path().join("does-not-exist.jsonl");

        let thread = replay_thread(&log_path, "t1".to_string(), AgentRole::Debugger, None).unwrap();
        assert!(thread.messages.is_empty());
        assert!(thread.trace.is_empty());
        assert_eq!(thread.state, ThreadState::Idle);
    }

    /// `replay_thread_round_trips_tool_call_id`: a `Message` event
    /// with `role: "tool"` and a `tool_call_id` must round-trip
    /// through replay with the `tool_call_id` preserved. Without
    /// this, the `agent_approve_action` IPC flow's
    /// "execute the pending tool_call directly + push the result
    /// to thread.messages" path would silently lose the
    /// `tool_call_id` on the next `engine.run`, the LLM would
    /// not see the result as a proper Tool message, and would
    /// re-issue the same tool_call — the exact bug where
    /// "approve apply_patch → nothing happens, another approval
    /// dialog pops up".
    #[test]
    fn replay_thread_round_trips_tool_call_id() {
        let tmp = tempdir().unwrap();
        let log_path: PathBuf = tmp.path().join("events.jsonl");

        append_thread_event(
            &log_path,
            &ThreadEvent::Message {
                v: 3,
                id: "m_user".to_string(),
                role: "user".to_string(),
                content: "patch the file".to_string(),
                tool_call_id: None,
                ts: 1_000,
            },
        )
        .unwrap();
        append_thread_event(
            &log_path,
            &ThreadEvent::Message {
                v: 3,
                id: "m_assistant".to_string(),
                role: "assistant".to_string(),
                content: "## Patch\nI'll apply this diff.".to_string(),
                tool_call_id: None,
                ts: 1_100,
            },
        )
        .unwrap();
        append_thread_event(
            &log_path,
            &ThreadEvent::Message {
                v: 3,
                id: "m_tool".to_string(),
                role: "tool".to_string(),
                content: r#"{"Ok":{"summary":"patch applied (3 changes)"}}"#.to_string(),
                tool_call_id: Some("call_apply_patch_42".to_string()),
                ts: 1_200,
            },
        )
        .unwrap();

        let thread = replay_thread(&log_path, "t1".to_string(), AgentRole::Debugger, None).unwrap();
        assert_eq!(thread.messages.len(), 3);

        // User message — no tool_call_id.
        assert_eq!(thread.messages[0].role, "user");
        assert_eq!(thread.messages[0].tool_call_id, None);

        // Assistant message — no tool_call_id (assistant text only;
        // structured tool_calls live elsewhere in the LLM-facing
        // history, not in thread.messages).
        assert_eq!(thread.messages[1].role, "assistant");
        assert_eq!(thread.messages[1].tool_call_id, None);

        // Tool message — tool_call_id MUST round-trip so the LLM
        // can attribute the result to the correct tool_calls[i].
        assert_eq!(thread.messages[2].role, "tool");
        assert_eq!(
            thread.messages[2].tool_call_id.as_deref(),
            Some("call_apply_patch_42"),
        );
    }

    /// `replay_thread_v2_log_replays_with_default_tool_call_id`:
    /// backward-compat — v2 logs (which predate the
    /// `tool_call_id` field on Message events) must still
    /// deserialize and replay cleanly. The field defaults to
    /// `None`, so old tool messages come back as ordinary
    /// messages with `tool_call_id: None`. The engine's
    /// `build_messages` falls back to a generic user-role
    /// placeholder for those (sub-optimal but not crashing).
    #[test]
    fn replay_thread_v2_log_replays_with_default_tool_call_id() {
        let tmp = tempdir().unwrap();
        let log_path: PathBuf = tmp.path().join("events.jsonl");

        // Hand-craft a v2-shaped Message (no `tool_call_id`).
        let raw = r#"{"type":"message","v":2,"id":"m_old","role":"tool","content":"legacy","ts":42}"#;
        std::fs::write(&log_path, format!("{raw}\n")).unwrap();

        let thread = replay_thread(&log_path, "t1".to_string(), AgentRole::Debugger, None).unwrap();
        assert_eq!(thread.messages.len(), 1);
        assert_eq!(thread.messages[0].role, "tool");
        assert_eq!(thread.messages[0].content, "legacy");
        assert_eq!(
            thread.messages[0].tool_call_id, None,
            "v2 logs must default tool_call_id to None",
        );
    }

    /// `thread_event_message_serialization_omits_null_tool_call_id`:
    /// when a Message has no `tool_call_id`, the wire format
    /// must omit the field (not serialise it as `null`) so v3
    /// logs read identically to v2 logs on the absence side.
    /// This keeps log diffs minimal and avoids tripping the
    /// "did this change?" test in the inbox audit.
    #[test]
    fn thread_event_message_serialization_omits_null_tool_call_id() {
        let msg = ThreadEvent::Message {
            v: 3,
            id: "m1".to_string(),
            role: "user".to_string(),
            content: "hi".to_string(),
            tool_call_id: None,
            ts: 1_000,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(
            !json.contains("tool_call_id"),
            "null tool_call_id must be omitted from wire format, got: {json}",
        );

        let with_id = ThreadEvent::Message {
            v: 3,
            id: "m2".to_string(),
            role: "tool".to_string(),
            content: "ok".to_string(),
            tool_call_id: Some("call_1".to_string()),
            ts: 1_100,
        };
        let json2 = serde_json::to_string(&with_id).unwrap();
        assert!(
            json2.contains(r#""tool_call_id":"call_1""#),
            "non-null tool_call_id must be serialised, got: {json2}",
        );
    }

    /// `append_thread_event_jsonl_format_includes_version`:
    /// Serialised lines must include `{"v": N, "type": "..."}`
    /// per spec so future bumps don't break replay.
    #[test]
    fn append_thread_event_jsonl_format_includes_version() {
        let tmp = tempdir().unwrap();
        let log_path: PathBuf = tmp.path().join("events.jsonl");

        let event = ThreadEvent::state_transition(
            ThreadState::Idle,
            ThreadState::Investigating,
            1_000_000,
        );
        append_thread_event(&log_path, &event).unwrap();

        let content = std::fs::read_to_string(&log_path).unwrap();
        let trimmed = content.trim();
        let parsed: serde_json::Value = serde_json::from_str(trimmed).unwrap();
        assert_eq!(parsed["v"], 3);
        assert_eq!(parsed["type"], "state_transition");
    }

    /// `append_thread_event_jsonl_format_mode_switch`: a `ModeSwitch`
    /// event serialises with `v: 3` (the current wire version) and
    /// the correct role strings.
    #[test]
    fn append_thread_event_jsonl_format_mode_switch() {
        let tmp = tempdir().unwrap();
        let log_path: PathBuf = tmp.path().join("events.jsonl");

        let event = ThreadEvent::mode_switch(AgentRole::Debugger, AgentRole::Planner, 1_700_000);
        append_thread_event(&log_path, &event).unwrap();

        let content = std::fs::read_to_string(&log_path).unwrap();
        let trimmed = content.trim();
        let parsed: serde_json::Value = serde_json::from_str(trimmed).unwrap();
        assert_eq!(parsed["v"], 3);
        assert_eq!(parsed["type"], "mode_switch");
        assert_eq!(parsed["from"], "debugger");
        assert_eq!(parsed["to"], "planner");
        assert_eq!(parsed["ts"], 1_700_000);
    }

    /// `mode_switch_roundtrip_preserves_role`: write a ModeSwitch
    /// event into a fresh log, replay, assert the thread's role
    /// reflects the destination (Planner, not the original
    /// Debugger passed to `Thread::new`).
    #[test]
    fn mode_switch_roundtrip_preserves_role() {
        let tmp = tempdir().unwrap();
        let log_path: PathBuf = tmp.path().join("events.jsonl");

        append_thread_event(
            &log_path,
            &ThreadEvent::mode_switch(AgentRole::Debugger, AgentRole::Planner, 1_000_000),
        )
        .unwrap();

        let thread = replay_thread(
            &log_path,
            "t1".to_string(),
            AgentRole::Debugger, // initial role from constructor
            None,
        )
        .unwrap();

        // After replay, thread.role must reflect the ModeSwitch destination.
        assert_eq!(thread.role, AgentRole::Planner);
        // The trace must record the transition for audit.
        assert!(
            thread
                .trace
                .iter()
                .any(|s| s.content.contains("ModeSwitch: debugger → planner")),
            "trace should contain the mode-switch audit step"
        );
    }

    /// `replay_thread_ignores_unknown_event_type`: write a fabricated
    /// event with a `"type"` value that no longer exists in the
    /// current enum, replay, assert the log loads without error
    /// (rather than aborting the replay) and the unknown line is
    /// recorded as a trace step for audit.
    ///
    /// This guarantees v1 logs (which don't have `ModeSwitch`) replay
    /// cleanly on a v2 build — the same forward-compatibility that
    /// powers the `unknown variant` recovery in `replay_thread`.
    #[test]
    fn replay_thread_ignores_unknown_event_type() {
        let tmp = tempdir().unwrap();
        let log_path: PathBuf = tmp.path().join("events.jsonl");

        // Bypass the typed helper — write a future-only event type.
        let raw = r#"{"type":"some_future_event","v":99,"foo":"baz"}"#;
        std::fs::write(&log_path, format!("{raw}\n")).unwrap();

        let thread = replay_thread(&log_path, "t1".to_string(), AgentRole::Debugger, None).unwrap();
        // No messages (the unknown event isn't a Message variant).
        assert!(thread.messages.is_empty());
        // One trace step was recorded so the user can see the
        // forward-compatible skip in the inbox detail.
        assert_eq!(thread.trace.len(), 1);
        assert!(thread.trace[0].content.contains("unknown event"));
    }

    /// `mode_switch_constructor_emits_correct_role_strings`: the
    /// `mode_switch` helper is the canonical builder for the new
    /// event and must serialise the role names exactly as
    /// `agent_role_from_str` parses them.
    #[test]
    fn mode_switch_constructor_emits_correct_role_strings() {
        let evt = ThreadEvent::mode_switch(AgentRole::Scaffolder, AgentRole::Critic, 42);
        let json = serde_json::to_string(&evt).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["type"], "mode_switch");
        assert_eq!(v["from"], "scaffolder");
        assert_eq!(v["to"], "critic");
    }

    /// `pending_approval_round_trip`: a `PendingApproval` event
    /// must rehydrate `thread.pending_tool_call` on the next
    /// `replay_thread` call so the IPC `approve_action` handler
    /// can recover the call after a renderer restart.
    ///
    /// This is the regression test for the WS2-T7 "click approve
    /// → nothing happens" loop where the in-memory field was
    /// silently lost on every reload.
    #[test]
    fn pending_approval_round_trip() {
        let tmp = tempdir().unwrap();
        let log_path: PathBuf = tmp.path().join("events.jsonl");

        let tc = crate::agent::llm::ToolCall {
            id: "call_apply_patch_42".to_string(),
            tool_type: "function".to_string(),
            function: crate::agent::llm::ToolFunctionCall {
                name: "apply_patch".to_string(),
                arguments: r#"{"path":"foo.rs","patch":"@@ -1 +1 @@\n-old\n+new"}"#.to_string(),
            },
        };
        append_thread_event(
            &log_path,
            &ThreadEvent::state_transition(
                ThreadState::Investigating,
                ThreadState::AwaitingApproval,
                1_000,
            ),
        )
        .unwrap();
        append_thread_event(
            &log_path,
            &ThreadEvent::pending_approval(&tc, "Tool 'apply_patch' requires human approval.", 1_001),
        )
        .unwrap();

        let replayed = replay_thread(
            &log_path,
            "t1".to_string(),
            AgentRole::Debugger,
            None,
        )
        .unwrap();

        // Thread rehydrates into AwaitingApproval and the
        // pending tool_call is fully reconstructed (id, name,
        // arguments all match what we wrote).
        assert_eq!(replayed.state, ThreadState::AwaitingApproval);
        let pending = replayed
            .pending_tool_call
            .as_ref()
            .expect("pending_tool_call must be rehydrated from PendingApproval event");
        assert_eq!(pending.id, "call_apply_patch_42");
        assert_eq!(pending.function.name, "apply_patch");
        assert!(pending.function.arguments.contains("foo.rs"));
        assert!(pending.function.arguments.contains("apply_patch")
            || pending.function.arguments.contains("+new"));
    }

    /// `pending_approval_clears_on_state_transition`: once the
    /// IPC handler resolves an approval it emits a state
    /// transition to `Investigating`. Replay must clear
    /// `thread.pending_tool_call` so the next reload does not
    /// re-execute the same tool_call.
    #[test]
    fn pending_approval_clears_on_state_transition() {
        let tmp = tempdir().unwrap();
        let log_path: PathBuf = tmp.path().join("events.jsonl");

        let tc = crate::agent::llm::ToolCall {
            id: "call_apply_patch_42".to_string(),
            tool_type: "function".to_string(),
            function: crate::agent::llm::ToolFunctionCall {
                name: "apply_patch".to_string(),
                arguments: "{}".to_string(),
            },
        };
        append_thread_event(
            &log_path,
            &ThreadEvent::state_transition(
                ThreadState::Investigating,
                ThreadState::AwaitingApproval,
                1_000,
            ),
        )
        .unwrap();
        append_thread_event(
            &log_path,
            &ThreadEvent::pending_approval(&tc, "approval required", 1_001),
        )
        .unwrap();
        // Simulate the IPC handler resolving the approval: emit
        // a state transition back to Investigating. (In
        // production the handler also pushes a tool-result
        // message; we don't need it for this assertion.)
        append_thread_event(
            &log_path,
            &ThreadEvent::state_transition(
                ThreadState::AwaitingApproval,
                ThreadState::Investigating,
                1_002,
            ),
        )
        .unwrap();

        let replayed = replay_thread(
            &log_path,
            "t1".to_string(),
            AgentRole::Debugger,
            None,
        )
        .unwrap();

        // After the resolution transition, the pending slot is
        // cleared even though the PendingApproval event is still
        // in the log.
        assert_eq!(replayed.state, ThreadState::Investigating);
        assert!(
            replayed.pending_tool_call.is_none(),
            "pending_tool_call must be cleared on state transition out of AwaitingApproval"
        );
    }

    /// `model_id_round_trips_through_upsert_get`: the v3 column
    /// must persist the user's selected model and surface it on
    /// re-read. Before the fix, `ThreadRow` had no `model_id`
    /// field and the column did not exist — every rehydrate landed
    /// back at the hardcoded `"claude-sonnet-4"` seed in
    /// `Thread::new`, so even a renderer that always re-sent
    /// `modelId` would lose the value on renderer restart and the
    /// IPC override was the only thing keeping the model correct.
    /// With the column in place, rehydrate restores the user's
    /// pick and the override becomes a pure belt-and-braces
    /// safety net.
    #[test]
    fn model_id_round_trips_through_upsert_get() {
        let conn = fresh_v2_db();
        let mut row = make_row("t1", ThreadState::Idle);
        row.model_id = Some("gpt-4o".to_string());
        upsert_thread(&conn, &row).unwrap();

        let fetched = get_thread(&conn, "t1").unwrap().unwrap();
        assert_eq!(
            fetched.model_id.as_deref(),
            Some("gpt-4o"),
            "v3 column must persist the user's model selection",
        );
    }

    /// `model_id_round_trips_through_list`: same guarantee as the
    /// upsert/get test but exercised through the list path that
    /// the renderer's Workflow inbox uses.
    #[test]
    fn model_id_round_trips_through_list() {
        let conn = fresh_v2_db();
        let mut row = make_row("t1", ThreadState::Investigating);
        row.model_id = Some("claude-3-5-sonnet-20241022".to_string());
        upsert_thread(&conn, &row).unwrap();

        let all = list_threads(&conn, "ws", None).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(
            all[0].model_id.as_deref(),
            Some("claude-3-5-sonnet-20241022"),
        );
    }

    /// `from_thread_stores_empty_model_id_as_none`: the
    /// `from_thread` builder must coerce an empty `model_id` to
    /// `None` so a future caller that accidentally passes
    /// `model_id = ""` does not write a literal empty string that
    /// would later be checked by `row_to_thread` and silently
    /// ignored (reverting the rehydrated thread to the seed
    /// default in spirit, even if the column itself is non-null).
    #[test]
    fn from_thread_stores_empty_model_id_as_none() {
        let dir = tempdir().unwrap();
        let log_path = dir.path().join("events.jsonl");
        let mut thread = Thread::new(
            "t1".to_string(),
            AgentRole::Debugger,
            None,
            log_path,
        );
        thread.model_id = "   ".to_string(); // whitespace-only

        let row = ThreadRow::from_thread(
            &thread,
            "ws".to_string(),
            "title".to_string(),
            "summary".to_string(),
            "active".to_string(),
        );
        assert!(
            row.model_id.is_none(),
            "whitespace-only model_id must be stored as None, got {:?}",
            row.model_id,
        );
    }
}
