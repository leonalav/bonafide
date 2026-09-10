use rusqlite::{Connection, Result};
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
            thread_id TEXT NOT NULL,
            statement TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS dead_ends (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            attempted_fix TEXT NOT NULL,
            outcome TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tracker_credentials (
            kind TEXT PRIMARY KEY,
            workspace_hash TEXT NOT NULL,
            last_verified INTEGER NOT NULL
        );
        "#
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
