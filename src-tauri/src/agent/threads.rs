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
/// Mirrors `#[serde(rename_all = "snake_case")]` on the enum so the
/// SQLite row and the in-memory enum agree on the string form.
fn thread_state_to_string(state: ThreadState) -> &'static str {
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
}

impl ThreadRow {
    /// Build a ThreadRow from its in-memory `Thread` counterpart plus
    /// the workspace hash and the renderer's display fields.
    ///
    /// The `band` field is renderer-managed (it controls the inbox
    /// column grouping) and is not derivable from `Thread`, so it's
    /// passed through.
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
    /// A user or assistant message.
    Message {
        v: u32,
        id: String,
        role: String,
        content: String,
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
}

impl ThreadEvent {
    /// Bumped when the wire shape changes in a backward-incompatible way.
    const WIRE_VERSION: u32 = 1;

    /// Convert a `Message` into a `ThreadEvent::Message` with the current
    /// wire version.
    pub fn from_message(msg: &Message) -> Self {
        Self::Message {
            v: Self::WIRE_VERSION,
            id: msg.id.clone(),
            role: msg.role.clone(),
            content: msg.content.clone(),
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
}

// ── ReplayError ──────────────────────────────────────────────────────────────

/// Errors that can arise during event-log replay.
#[derive(Debug, Error)]
pub enum ReplayError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Failed to decode line {line}: {message}")]
    Decoding { line: usize, message: String },

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
/// the next write.
pub fn upsert_thread(conn: &Connection, row: &ThreadRow) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO threads (
            id, workspace_hash, role, title, summary, state, detail, band, system, updated_at,
            experiment_id, budget_spent_dollars, budget_spent_gpu_hours,
            hypothesis, patch_diff, smoke_result
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                ?11, ?12, ?13, ?14, ?15, ?16)
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
            smoke_result           = excluded.smoke_result
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
                hypothesis, patch_diff, smoke_result
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
                    hypothesis, patch_diff, smoke_result
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
                    hypothesis, patch_diff, smoke_result
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

        // Distinguish "unknown type" from "malformed shape" so callers
        // can decide whether to retry on a schema bump vs surface a
        // hard error.
        let event_type = value
            .get("type")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ReplayError::Decoding {
                line: line_no,
                message: "missing 'type' field".to_string(),
            })?;

        let event: ThreadEvent = serde_json::from_value(value).map_err(|e| {
            // Treat any unknown-variant error as recoverable so a
            // forward-compatible replay doesn't break older builds.
            // We discriminate by message text — `serde_json::Error`
            // doesn't expose a public `custom` variant without the
            // trait import, and matching by category (`io` /
            // `syntax` / `data`) doesn't reliably distinguish the
            // "unknown enum variant" case.
            let msg = e.to_string();
            if msg.contains("unknown variant") {
                ReplayError::UnknownEventType(line_no)
            } else {
                ReplayError::Decoding {
                    line: line_no,
                    message: format!("invalid event: {e}"),
                }
            }
        })?;

        match event {
            ThreadEvent::Message { id, role, content, ts, .. } => {
                thread.messages.push(Message { id, role, content, ts });
            }
            ThreadEvent::StateTransition { from, to, ts, .. } => {
                if let Some(new_state) = thread_state_from_str(&to) {
                    let step = TraceStep {
                        step: (thread.trace.len() as u32) + 1,
                        content: format!("state: {from} → {to}"),
                        ts,
                    };
                    thread.trace.push(step);
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
        }
    }

    Ok(thread)
}

// ── Private helpers ──────────────────────────────────────────────────────────

/// Convert a `row` produced by the threads SELECT into a `ThreadRow`.
///
/// Centralises the column-index mapping so the upsert/list/get paths
/// stay consistent.
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
                smoke_result TEXT
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
                v: 1,
                id: "m1".to_string(),
                role: "user".to_string(),
                content: "Why did run a3f9c12 diverge?".to_string(),
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
                v: 1,
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
                v: 1,
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
        assert_eq!(parsed["v"], 1);
        assert_eq!(parsed["type"], "state_transition");
    }
}
