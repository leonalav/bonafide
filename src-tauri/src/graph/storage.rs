use rusqlite::{params, Connection, Result};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Returns the local data directory for bonafide config/state.
/// Falls back to current dir if the OS API is unavailable.
pub fn bonafide_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("bonafide")
}

/// Returns the events directory for a given workspace hash.
pub fn events_dir(workspace_hash: &str) -> PathBuf {
    bonafide_dir().join(workspace_hash).join("events")
}

/// Returns the first 8 hex characters of the SHA-256 of the
/// canonical path string of `root`.  Used as a stable,
/// collision-resistant workspace identifier for directory naming.
pub fn workspace_hash(root: &Path) -> String {
    let normalized = root.canonicalize()
        .unwrap_or_else(|_| root.to_path_buf())
        .to_string_lossy()
        .to_string();
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    let digest = hasher.finalize();
    hex::encode(&digest[..8]) // first 8 bytes = 16 hex chars (spec: sha256[0..16])
}

/// Returns the current Unix timestamp in seconds since the epoch.
pub fn current_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .try_into()
        .unwrap_or(0)
}

/// Runs all schema migrations on `conn`.  The `schema_migrations`
/// table tracks which migrations have been applied so each DDL block
/// runs exactly once regardless of how many times `open_workspace_db`
/// is called.
pub fn run_migrations(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS code_nodes (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            file TEXT NOT NULL,
            name TEXT NOT NULL,
            span_start INTEGER NOT NULL,
            span_end INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS code_edges (
            src TEXT NOT NULL,
            dst TEXT NOT NULL,
            kind TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS code_edges_src ON code_edges(src);
        CREATE INDEX IF NOT EXISTS code_edges_dst ON code_edges(dst);

        CREATE TABLE IF NOT EXISTS run_nodes (
            id TEXT PRIMARY KEY,
            framework TEXT NOT NULL,
            gpu TEXT NOT NULL,
            config_json TEXT NOT NULL,
            dataset_ref TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS run_edges (
            src TEXT NOT NULL,
            dst TEXT NOT NULL,
            kind TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS artifact_sections (
            id TEXT PRIMARY KEY,
            artifact_id TEXT NOT NULL,
            section_label TEXT NOT NULL,
            claim_summary TEXT NOT NULL,
            equation_refs TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS insights (
            id TEXT PRIMARY KEY,
            workspace_hash TEXT NOT NULL,
            finding TEXT NOT NULL,
            evidence TEXT NOT NULL,
            confidence TEXT NOT NULL,
            source_thread TEXT,
            source_runs TEXT,
            created_at INTEGER NOT NULL,
            expires_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS dead_ends (
            id TEXT PRIMARY KEY,
            workspace_hash TEXT NOT NULL,
            hypothesis TEXT NOT NULL,
            evidence TEXT NOT NULL,
            tried_runs TEXT,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tracker_credentials (
            kind TEXT PRIMARY KEY,
            workspace_hash TEXT NOT NULL,
            last_verified INTEGER NOT NULL
        );

        -- Tracker connection state per workspace. Replaces the W&B-only
        -- `tracker_credentials` table above: the new shape supports both
        -- `wandb` and `mlflow`, carries the actual connection config
        -- (base_url, project name, etc.) in `config_json`, and is keyed
        -- by `workspace_hash` so a workspace can hold one active tracker
        -- connection regardless of provider. The legacy
        -- `tracker_credentials` table is retained for backwards
        -- compatibility with existing migrations but should not be used
        -- for new writes.
        CREATE TABLE IF NOT EXISTS tracker_connection (
            workspace_hash TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            config_json TEXT NOT NULL,
            last_verified INTEGER NOT NULL
        );

        -- Agent thread records (Phase 0+: lifecycle persistence).
        -- One row per Thread; messages/trace/events live in the
        -- append-only event log at $EVENTS_DIR/<thread_id>.jsonl, not
        -- here. We only persist the metadata needed to render the
        -- Workflow inbox and resume a session after restart.
        CREATE TABLE IF NOT EXISTS threads (
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

        CREATE INDEX IF NOT EXISTS threads_workspace ON threads(workspace_hash);
        CREATE INDEX IF NOT EXISTS threads_updated_at ON threads(updated_at DESC);

        -- Phase 2: experiment tracking
        CREATE TABLE IF NOT EXISTS experiments (
            id               TEXT PRIMARY KEY,
            title            TEXT NOT NULL,
            hypothesis       TEXT NOT NULL,
            goal_metric      TEXT NOT NULL,
            goal_direction   TEXT NOT NULL,
            goal_target      REAL NOT NULL,
            goal_condition   TEXT NOT NULL,
            status           TEXT NOT NULL DEFAULT 'proposed',
            budget_dollars   REAL NOT NULL DEFAULT 10.0,
            budget_gpu_hours REAL NOT NULL DEFAULT 4.0,
            created_at       INTEGER NOT NULL,
            updated_at       INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS experiments_status ON experiments(status);
        CREATE INDEX IF NOT EXISTS experiments_updated_at ON experiments(updated_at DESC);

        CREATE TABLE IF NOT EXISTS experiment_runs (
            id               TEXT PRIMARY KEY,
            experiment_id    TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
            run_id           TEXT NOT NULL,
            config_overrides TEXT NOT NULL DEFAULT '{}',
            status           TEXT NOT NULL DEFAULT 'queued',
            metrics_summary  TEXT NOT NULL DEFAULT '{}',
            created_at       INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS experiment_runs_experiment_id ON experiment_runs(experiment_id);
        "#
    )
}

/// Upsert a tracker connection record.
///
/// `workspace_hash` is the open-workspace identifier; `kind` is one
/// of `"wandb"` or `"mlflow"`; `config_json` is a provider-specific
/// JSON blob (typically `{"base_url": "...", "project": "..."}`
/// for MLflow, or `{"entity": "...", "project": "..."}` for W&B).
pub fn upsert_tracker_connection(
    conn: &Connection,
    workspace_hash: &str,
    kind: &str,
    config_json: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO tracker_connection (workspace_hash, kind, config_json, last_verified)
         VALUES (?1, ?2, ?3, ?4)",
        params![workspace_hash, kind, config_json, current_timestamp()],
    )?;
    Ok(())
}

/// Read the tracker connection record for a workspace.
///
/// Returns `Ok(Some((kind, config_json)))` if a record exists, or
/// `Ok(None)` if the workspace has no tracker connection on file.
/// The caller is responsible for parsing `config_json` itself — the
/// shape varies by `kind`.
pub fn get_tracker_connection(
    conn: &Connection,
    workspace_hash: &str,
) -> rusqlite::Result<Option<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT kind, config_json FROM tracker_connection WHERE workspace_hash = ?1",
    )?;
    let mut rows = stmt.query(params![workspace_hash])?;
    if let Some(row) = rows.next()? {
        Ok(Some((row.get(0)?, row.get(1)?)))
    } else {
        Ok(None)
    }
}

/// Delete the tracker connection record for a workspace. Returns the
/// number of rows removed (0 if there was nothing to remove).
pub fn delete_tracker_connection(
    conn: &Connection,
    workspace_hash: &str,
) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM tracker_connection WHERE workspace_hash = ?1",
        params![workspace_hash],
    )
}

/// Opens (or creates) the SQLite database for `root` and returns the
/// `Connection` alongside the workspace hash.
///
/// If the file is missing, `run_migrations` is called to bootstrap
/// the schema.  If the file is corrupted, the bad file is renamed
/// aside and a fresh DB is created.
pub fn open_workspace_db(root: &Path) -> Result<(Connection, String), String> {
    let hash = workspace_hash(root);
    let dir = bonafide_dir().join(&hash);
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {e}"))?;
    let db_path = dir.join("store.db");

    // Try to open existing file. If it's missing we get a fresh DB.
    match Connection::open(&db_path) {
        Ok(conn) => {
            run_migrations(&conn).map_err(|e| format!("migration failed: {e}"))?;
            Ok((conn, hash))
        }
        Err(_) => {
            // Corruption: rename the bad file aside.
            if db_path.exists() {
                let stamp = current_timestamp();
                let backup = dir.join(format!("store.db.corrupt.{stamp}"));
                fs::rename(&db_path, &backup)
                    .map_err(|e| format!("rename failed: {e}"))?;
            }
            let conn = Connection::open(&db_path)
                .map_err(|e| format!("open failed: {e}"))?;
            run_migrations(&conn).map_err(|e| format!("migration failed: {e}"))?;
            Ok((conn, hash))
        }
    }
}
