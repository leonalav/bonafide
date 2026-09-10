//! Thread persistence layer.
//!
//! The orchestrator's `Thread` struct is the rich in-memory type used
//! during an active session. The renderer only needs a small subset
//! for the Workflow inbox (id, role, title, summary, state, band,
//! updated_at), so we model the persisted row separately instead of
//! mirroring every field.
//!
//! All write paths go through `upsert_thread` so a thread created on
//! one renderer call and then updated by a later event ends up with
//! exactly one row. Reads return rows sorted by `updated_at` so the
//! inbox naturally surfaces active items first.

use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};

/// Persisted shape of a Thread row.
///
/// Mirrors the renderer's `ThreadBase` type in `src/data/agents.ts`.
/// Renamed for snake_case so the same struct serializes cleanly to
/// both rusqlite and JSON without `rename_all` overrides.
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
}

/// Upsert a thread row. `workspace_hash` is the open-workspace
/// identifier (first 8 bytes of SHA-256 of the canonical path) — the
/// renderer passes it through so we can scope queries per workspace.
pub fn upsert_thread(conn: &Connection, row: &ThreadRow) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO threads (id, workspace_hash, role, title, summary, state, detail, band, system, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(id) DO UPDATE SET
            workspace_hash = excluded.workspace_hash,
            role           = excluded.role,
            title          = excluded.title,
            summary        = excluded.summary,
            state          = excluded.state,
            detail         = excluded.detail,
            band           = excluded.band,
            system         = excluded.system,
            updated_at     = excluded.updated_at
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
        ],
    )?;
    Ok(())
}

/// Fetch every thread for `workspace_hash`, sorted newest-first.
pub fn list_threads(conn: &Connection, workspace_hash: &str) -> Result<Vec<ThreadRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, workspace_hash, role, title, summary, state, detail, band, system, updated_at
           FROM threads
          WHERE workspace_hash = ?1
          ORDER BY updated_at DESC",
    )?;

    let rows = stmt.query_map(params![workspace_hash], |row| {
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
        })
    })?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
