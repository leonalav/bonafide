//! Agent thread schema migrations.
//!
//! Phase 0 only persisted the renderer's inbox metadata (`title`,
//! `summary`, `state`, `band`, `updated_at`, …). The v2 schema adds
//! six columns needed by the engine (section 11.2):
//!
//! ```sql
//! ALTER TABLE threads ADD COLUMN experiment_id TEXT;
//! ALTER TABLE threads ADD COLUMN budget_spent_dollars REAL DEFAULT 0;
//! ALTER TABLE threads ADD COLUMN budget_spent_gpu_hours REAL DEFAULT 0;
//! ALTER TABLE threads ADD COLUMN hypothesis TEXT;       -- current hypothesis JSON
//! ALTER TABLE threads ADD COLUMN patch_diff TEXT;        -- current proposed patch
//! ALTER TABLE threads ADD COLUMN smoke_result TEXT;      -- smoke test outcome
//! ```
//!
//! ## Idempotency
//!
//! `ensure_v2_columns` is safe to call on every workspace open. We
//! check `pragma_table_info('threads')` for each column and only run
//! the `ALTER TABLE` when it's missing. This means:
//!
//! - Fresh workspaces get the v2 columns applied once.
//! - Existing workspaces get the columns added on first open after upgrade.
//! - Subsequent opens see all columns present and skip the `ALTER`.
//!
//! ## Migration style
//!
//! We never `DROP COLUMN` or `RENAME` — additive only. Old rows keep
//! their existing data; new columns land as `NULL` (text) or `0.0`
//! (numeric default) on existing rows.

use rusqlite::{Connection, Result};

/// Check whether `column` already exists in `pragma_table_info('threads')`.
///
/// SQLite has no `IF NOT EXISTS` for `ALTER TABLE ... ADD COLUMN`,
/// so we probe the schema before issuing the DDL.
fn column_exists(conn: &Connection, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare("PRAGMA table_info(threads)")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Add a single column to `threads` if it's not already present.
///
/// Returns `true` if the column was added, `false` if it already
/// existed. Errors from `ALTER TABLE` bubble up so a corrupted
/// database surfaces as a clear failure rather than a silent skip.
fn add_column_if_missing(conn: &Connection, column: &str, ddl: &str) -> Result<bool> {
    if column_exists(conn, column)? {
        return Ok(false);
    }
    conn.execute(&format!("ALTER TABLE threads ADD COLUMN {ddl}"), [])?;
    Ok(true)
}

/// Ensure all v2 columns are present on the `threads` table.
///
/// Idempotent. Safe to call on every workspace open. Returns the
/// count of columns added (0 if the schema was already at v2).
pub fn ensure_v2_columns(conn: &Connection) -> Result<usize> {
    let mut added = 0;

    if add_column_if_missing(conn, "experiment_id", "experiment_id TEXT")? {
        added += 1;
    }
    if add_column_if_missing(
        conn,
        "budget_spent_dollars",
        "budget_spent_dollars REAL DEFAULT 0.0 NOT NULL",
    )? {
        added += 1;
    }
    if add_column_if_missing(
        conn,
        "budget_spent_gpu_hours",
        "budget_spent_gpu_hours REAL DEFAULT 0.0 NOT NULL",
    )? {
        added += 1;
    }
    if add_column_if_missing(conn, "hypothesis", "hypothesis TEXT")? {
        added += 1;
    }
    if add_column_if_missing(conn, "patch_diff", "patch_diff TEXT")? {
        added += 1;
    }
    if add_column_if_missing(conn, "smoke_result", "smoke_result TEXT")? {
        added += 1;
    }

    Ok(added)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// Open a fresh in-memory DB with the Phase 0 threads table.
    ///
    /// Mirrors the `CREATE TABLE threads` block in
    /// `graph/storage::run_migrations` so the migration tests exercise
    /// the same starting point a real workspace would have.
    fn fresh_threads_db() -> Connection {
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
                updated_at INTEGER NOT NULL
            );
            "#,
        )
        .unwrap();
        conn
    }

    /// `migration_is_idempotent`: calling `ensure_v2_columns` twice
    /// must not raise any SQLSTATE on the second call.
    #[test]
    fn migration_is_idempotent() {
        let conn = fresh_threads_db();

        // First call: adds all six columns.
        let added_first = ensure_v2_columns(&conn).unwrap();
        assert_eq!(added_first, 6, "first call must add all 6 columns");

        // Second call: zero columns added, no error.
        let added_second = ensure_v2_columns(&conn).unwrap();
        assert_eq!(
            added_second, 0,
            "second call must be a no-op (all columns already present)"
        );
    }

    /// `column_exists_smoke`: the helper returns true for present
    /// columns and false for missing ones.
    #[test]
    fn column_exists_smoke() {
        let conn = fresh_threads_db();

        assert!(column_exists(&conn, "id").unwrap());
        assert!(column_exists(&conn, "updated_at").unwrap());
        assert!(!column_exists(&conn, "experiment_id").unwrap());
        assert!(!column_exists(&conn, "patch_diff").unwrap());
    }

    /// `migration_preserves_existing_rows`: pre-existing rows survive
    /// the migration with their data intact.
    #[test]
    fn migration_preserves_existing_rows() {
        let conn = fresh_threads_db();
        conn.execute(
            "INSERT INTO threads (id, workspace_hash, role, title, summary, state, band, system, updated_at)
             VALUES ('t1', 'ws', 'debugger', 'Old title', 'Old summary', 'idle', 'old', 0, 12345)",
            [],
        ).unwrap();

        ensure_v2_columns(&conn).unwrap();

        // Existing row data must be preserved.
        let (title, summary, band): (String, String, String) = conn
            .query_row(
                "SELECT title, summary, band FROM threads WHERE id = 't1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(title, "Old title");
        assert_eq!(summary, "Old summary");
        assert_eq!(band, "old");

        // New columns must be present with their defaults.
        let budget: f64 = conn
            .query_row(
                "SELECT budget_spent_dollars FROM threads WHERE id = 't1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!((budget - 0.0).abs() < f64::EPSILON);
    }

    /// `migration_adds_all_six_columns`: every v2 column is present
    /// after `ensure_v2_columns` runs.
    #[test]
    fn migration_adds_all_six_columns() {
        let conn = fresh_threads_db();

        ensure_v2_columns(&conn).unwrap();

        for col in &[
            "experiment_id",
            "budget_spent_dollars",
            "budget_spent_gpu_hours",
            "hypothesis",
            "patch_diff",
            "smoke_result",
        ] {
            assert!(
                column_exists(&conn, col).unwrap(),
                "column {col} should be present after migration"
            );
        }
    }
}
