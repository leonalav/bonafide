// memory.rs — Project memory: insights and dead-ends (section 9).
//
// Spec contract (section 9.2):
// - Two tables: `insights` and `dead_ends`
// - Each row has: id, content, confidence (0-100), finding, evidence, expires_at
// - FIFO eviction: max 50 insights, max 50 dead-ends
// - Expiration filtering: rows with `expires_at < now` are hidden from queries
// - Commands: `query_project_memory`, `write_project_memory`
// - Memory injection into system prompt (section 8.2): tier-1 capped at ~5K chars

use rusqlite::{params, Connection, Result as SqliteResult};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// `MemoryEntry` — a single insight or dead-end (section 9.2).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MemoryEntry {
    pub id: i64,
    pub content: String,
    pub confidence: u8,  // 0-100
    pub finding: String,
    pub evidence: String,
    pub expires_at: i64,  // Unix timestamp
}

/// `MemoryType` — distinguishes insights from dead-ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryType {
    Insight,
    DeadEnd,
}

/// `init_memory_tables` — creates the two memory tables if they don't exist.
pub fn init_memory_tables(conn: &Connection) -> SqliteResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS insights (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            confidence INTEGER NOT NULL CHECK(confidence >= 0 AND confidence <= 100),
            finding TEXT NOT NULL,
            evidence TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        )",
        [],
    )?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS dead_ends (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            confidence INTEGER NOT NULL CHECK(confidence >= 0 AND confidence <= 100),
            finding TEXT NOT NULL,
            evidence TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        )",
        [],
    )?;
    Ok(())
}

/// `query_project_memory` — retrieves all non-expired entries of the given type.
/// Entries with `expires_at < now` are filtered out.
pub fn query_project_memory(
    conn: &Connection,
    memory_type: MemoryType,
) -> SqliteResult<Vec<MemoryEntry>> {
    let table_name = match memory_type {
        MemoryType::Insight => "insights",
        MemoryType::DeadEnd => "dead_ends",
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    let query = format!(
        "SELECT id, content, confidence, finding, evidence, expires_at
         FROM {}
         WHERE expires_at > ?
         ORDER BY created_at DESC",
        table_name
    );

    let mut stmt = conn.prepare(&query)?;
    let rows = stmt.query_map(params![now], |row| {
        Ok(MemoryEntry {
            id: row.get(0)?,
            content: row.get(1)?,
            confidence: row.get(2)?,
            finding: row.get(3)?,
            evidence: row.get(4)?,
            expires_at: row.get(5)?,
        })
    })?;

    rows.collect()
}

/// `write_project_memory` — inserts a new entry and enforces FIFO eviction (max 50).
pub fn write_project_memory(
    conn: &Connection,
    memory_type: MemoryType,
    content: &str,
    confidence: u8,
    finding: &str,
    evidence: &str,
    expires_at: i64,
) -> SqliteResult<i64> {
    let table_name = match memory_type {
        MemoryType::Insight => "insights",
        MemoryType::DeadEnd => "dead_ends",
    };

    // Insert the new entry.
    let query = format!(
        "INSERT INTO {} (content, confidence, finding, evidence, expires_at)
         VALUES (?, ?, ?, ?, ?)",
        table_name
    );
    conn.execute(&query, params![content, confidence, finding, evidence, expires_at])?;
    let new_id = conn.last_insert_rowid();

    // Enforce FIFO eviction: keep only the 50 most recent entries.
    let evict_query = format!(
        "DELETE FROM {}
         WHERE id NOT IN (
             SELECT id FROM {} ORDER BY created_at DESC LIMIT 50
         )",
        table_name, table_name
    );
    conn.execute(&evict_query, [])?;

    Ok(new_id)
}

/// `get_memory_summary` — returns a summary string of all non-expired entries for injection into the system prompt.
/// Capped at ~5K chars per spec section 8.2 (tier-1 memory).
pub fn get_memory_summary(conn: &Connection) -> SqliteResult<String> {
    let insights = query_project_memory(conn, MemoryType::Insight)?;
    let dead_ends = query_project_memory(conn, MemoryType::DeadEnd)?;

    let mut summary = String::new();
    summary.push_str("## Project Memory\n\n");

    if !insights.is_empty() {
        summary.push_str("### Insights\n");
        for entry in &insights {
            summary.push_str(&format!(
                "- **{}** (confidence: {}%)\n  Finding: {}\n  Evidence: {}\n\n",
                entry.content, entry.confidence, entry.finding, entry.evidence
            ));
            if summary.len() > 5000 {
                summary.push_str("_(truncated at 5K chars)_\n");
                break;
            }
        }
    }

    if !dead_ends.is_empty() && summary.len() < 5000 {
        summary.push_str("### Dead Ends\n");
        for entry in &dead_ends {
            summary.push_str(&format!(
                "- **{}** (confidence: {}%)\n  Finding: {}\n  Evidence: {}\n\n",
                entry.content, entry.confidence, entry.finding, entry.evidence
            ));
            if summary.len() > 5000 {
                summary.push_str("_(truncated at 5K chars)_\n");
                break;
            }
        }
    }

    if summary.len() > 5000 {
        summary.truncate(5000);
    }

    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `init_memory_tables_creates_both_tables`: after initialization, both
    /// `insights` and `dead_ends` tables exist and are queryable.
    #[test]
    fn init_memory_tables_creates_both_tables() {
        let conn = Connection::open_in_memory().unwrap();
        init_memory_tables(&conn).unwrap();

        // Verify both tables exist by running a simple query.
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM insights", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0);
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM dead_ends", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    /// `write_project_memory_inserts_and_returns_id`: a new entry is inserted
    /// and the returned ID matches the last_insert_rowid.
    #[test]
    fn write_project_memory_inserts_and_returns_id() {
        let conn = Connection::open_in_memory().unwrap();
        init_memory_tables(&conn).unwrap();

        let id = write_project_memory(
            &conn,
            MemoryType::Insight,
            "Use Adam optimizer",
            85,
            "Adam converges faster than SGD on this dataset",
            "Compared 10 runs: Adam avg loss 0.12, SGD avg loss 0.18",
            9999999999,
        ).unwrap();
        assert!(id > 0);

        let entries = query_project_memory(&conn, MemoryType::Insight).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].content, "Use Adam optimizer");
        assert_eq!(entries[0].confidence, 85);
    }

    /// `query_project_memory_filters_expired_entries`: entries with
    /// `expires_at < now` are not returned.
    #[test]
    fn query_project_memory_filters_expired_entries() {
        let conn = Connection::open_in_memory().unwrap();
        init_memory_tables(&conn).unwrap();

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        // Insert one expired entry and one valid entry.
        write_project_memory(
            &conn,
            MemoryType::DeadEnd,
            "Tried L1 regularization",
            90,
            "Made training unstable",
            "Loss oscillated wildly after epoch 5",
            now - 1000,  // Expired
        ).unwrap();
        write_project_memory(
            &conn,
            MemoryType::DeadEnd,
            "Tried dropout 0.5",
            80,
            "Overfitting persisted",
            "Val loss still 2× train loss",
            now + 10000,  // Valid
        ).unwrap();

        let entries = query_project_memory(&conn, MemoryType::DeadEnd).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].content, "Tried dropout 0.5");
    }

    /// `write_project_memory_enforces_fifo_eviction`: after inserting 51
    /// entries, only the 50 most recent remain.
    #[test]
    fn write_project_memory_enforces_fifo_eviction() {
        let conn = Connection::open_in_memory().unwrap();
        init_memory_tables(&conn).unwrap();

        // Insert 51 insights.
        for i in 0..51 {
            write_project_memory(
                &conn,
                MemoryType::Insight,
                &format!("Insight {}", i),
                50,
                "test",
                "test",
                9999999999,
            ).unwrap();
        }

        let entries = query_project_memory(&conn, MemoryType::Insight).unwrap();
        assert_eq!(entries.len(), 50);
        // The oldest entry (Insight 0) should be gone; the newest is Insight 50.
        assert!(!entries.iter().any(|e| e.content == "Insight 0"));
        assert!(entries.iter().any(|e| e.content == "Insight 50"));
    }

    /// `query_project_memory_empty_returns_empty_vec`: querying an empty
    /// table returns an empty vector (no panics, no errors).
    #[test]
    fn query_project_memory_empty_returns_empty_vec() {
        let conn = Connection::open_in_memory().unwrap();
        init_memory_tables(&conn).unwrap();

        let entries = query_project_memory(&conn, MemoryType::Insight).unwrap();
        assert!(entries.is_empty());
    }

    /// `get_memory_summary_formats_correctly`: the summary string includes
    /// both insights and dead-ends with proper markdown formatting.
    #[test]
    fn get_memory_summary_formats_correctly() {
        let conn = Connection::open_in_memory().unwrap();
        init_memory_tables(&conn).unwrap();

        write_project_memory(
            &conn,
            MemoryType::Insight,
            "Batch size 64 works best",
            95,
            "Fastest convergence",
            "10 runs averaged",
            9999999999,
        ).unwrap();
        write_project_memory(
            &conn,
            MemoryType::DeadEnd,
            "Learning rate 0.1 too high",
            100,
            "Training exploded",
            "NaN loss after 3 epochs",
            9999999999,
        ).unwrap();

        let summary = get_memory_summary(&conn).unwrap();
        assert!(summary.contains("## Project Memory"));
        assert!(summary.contains("### Insights"));
        assert!(summary.contains("Batch size 64 works best"));
        assert!(summary.contains("confidence: 95%"));
        assert!(summary.contains("### Dead Ends"));
        assert!(summary.contains("Learning rate 0.1 too high"));
        assert!(summary.contains("confidence: 100%"));
    }

    /// `get_memory_summary_truncates_at_5k_chars`: if the summary exceeds
    /// 5K chars, it is truncated per section 8.2.
    #[test]
    fn get_memory_summary_truncates_at_5k_chars() {
        let conn = Connection::open_in_memory().unwrap();
        init_memory_tables(&conn).unwrap();

        // Insert many insights with long content to exceed 5K.
        for i in 0..100 {
            write_project_memory(
                &conn,
                MemoryType::Insight,
                &format!("Very long insight content here to fill up space {}", "x".repeat(100)),
                50,
                &format!("Finding {}", i),
                "Evidence",
                9999999999,
            ).unwrap();
        }

        let summary = get_memory_summary(&conn).unwrap();
        assert!(summary.len() <= 5000, "summary length: {}", summary.len());
    }

    /// `memory_types_are_isolated`: insights and dead-ends are stored in
    /// separate tables and don't interfere with each other.
    #[test]
    fn memory_types_are_isolated() {
        let conn = Connection::open_in_memory().unwrap();
        init_memory_tables(&conn).unwrap();

        write_project_memory(
            &conn,
            MemoryType::Insight,
            "Insight A",
            80,
            "test",
            "test",
            9999999999,
        ).unwrap();
        write_project_memory(
            &conn,
            MemoryType::DeadEnd,
            "Dead end B",
            70,
            "test",
            "test",
            9999999999,
        ).unwrap();

        let insights = query_project_memory(&conn, MemoryType::Insight).unwrap();
        let dead_ends = query_project_memory(&conn, MemoryType::DeadEnd).unwrap();

        assert_eq!(insights.len(), 1);
        assert_eq!(insights[0].content, "Insight A");
        assert_eq!(dead_ends.len(), 1);
        assert_eq!(dead_ends[0].content, "Dead end B");
    }
}
