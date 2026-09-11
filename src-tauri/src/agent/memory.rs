//! Project Memory — persistent insights and dead-ends for the agent.
//!
//! This module implements Phase 3's Project Memory tier (Section 9 of the spec).
//! Insights and dead-ends survive across sessions and are injected into system
//! prompts to help the agent avoid repeating failed approaches and build on
//! successful ones.
//!
//! ## Schema (per spec lines 1278-1306)
//!
//! ```sql
//! CREATE TABLE IF NOT EXISTS insights (
//!     id TEXT PRIMARY KEY,
//!     workspace_hash TEXT NOT NULL,
//!     finding TEXT NOT NULL,
//!     evidence TEXT NOT NULL,
//!     confidence TEXT NOT NULL,       -- "Low" | "Medium" | "High"
//!     source_thread TEXT,             -- Thread ID that produced this
//!     source_runs TEXT,               -- JSON array of run IDs
//!     created_at INTEGER NOT NULL,
//!     expires_at INTEGER              -- NULL = never expires
//! );
//!
//! CREATE TABLE IF NOT EXISTS dead_ends (
//!     id TEXT PRIMARY KEY,
//!     workspace_hash TEXT NOT NULL,
//!     hypothesis TEXT NOT NULL,
//!     evidence TEXT NOT NULL,
//!     tried_runs TEXT,                -- JSON array of run IDs
//!     created_at INTEGER NOT NULL
//! );
//! ```
//!
//! ## FIFO Eviction (per spec: max 50 insights, max 50 dead-ends)
//!
//! Eviction runs automatically on write when the count exceeds the limit.

use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::graph::storage::{current_timestamp, open_workspace_db};

// ── Domain types ───────────────────────────────────────────────────────────────

/// Confidence level for an insight.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    Low,
    Medium,
    High,
}

impl Confidence {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "low" => Confidence::Low,
            "medium" => Confidence::Medium,
            "high" => Confidence::High,
            _ => Confidence::Medium,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Confidence::Low => "low",
            Confidence::Medium => "medium",
            Confidence::High => "high",
        }
    }
}

/// A persisted insight — a confirmed finding from an experiment or investigation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Insight {
    pub id: String,
    pub workspace_hash: String,
    /// "lr=5e-4 works best for ResNet50 on CIFAR-10"
    pub finding: String,
    /// "run b4c8f30 val_loss=0.28, best of 4 runs"
    pub evidence: String,
    pub confidence: String,
    pub source_thread: Option<String>,
    /// JSON array of run IDs
    pub source_runs: Option<String>,
    pub created_at: i64,
    pub expires_at: Option<i64>,
}

/// A persisted dead-end — a hypothesis that was tested and failed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeadEnd {
    pub id: String,
    pub workspace_hash: String,
    /// "batch_size=256 causes OOM on this GPU"
    pub hypothesis: String,
    /// "OOM at step 100, 3 consecutive failures with different seeds"
    pub evidence: String,
    /// JSON array of run IDs that tried this
    pub tried_runs: Option<String>,
    pub created_at: i64,
}

/// Unified memory entry returned by query_project_memory.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "kind")]
pub enum MemoryEntry {
    Insight(Insight),
    DeadEnd(DeadEnd),
}

/// Input for writing a new memory entry.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteMemoryInput {
    pub kind: String,           // "insight" | "dead_end"
    pub finding: Option<String>,
    pub evidence: Option<String>,
    pub confidence: Option<String>,
    pub hypothesis: Option<String>,
    pub source_thread: Option<String>,
    pub source_runs: Option<Vec<String>>,
    pub tried_runs: Option<Vec<String>>,
}

// ── ID generation ───────────────────────────────────────────────────────────────

/// Compute a stable memory entry ID from workspace hash + content hash.
pub fn compute_memory_id(workspace_hash: &str, content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(workspace_hash.as_bytes());
    hasher.update(content.as_bytes());
    let digest = hasher.finalize();
    format!("mem_{}", &hex::encode(&digest[..8])[..16])
}

// ── Insight CRUD ───────────────────────────────────────────────────────────────

/// Insert a new insight. Returns the generated ID.
pub fn create_insight(conn: &Connection, insight: &Insight) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO insights (
            id, workspace_hash, finding, evidence, confidence,
            source_thread, source_runs, created_at, expires_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        "#,
        params![
            insight.id,
            insight.workspace_hash,
            insight.finding,
            insight.evidence,
            insight.confidence,
            insight.source_thread,
            insight.source_runs,
            insight.created_at,
            insight.expires_at,
        ],
    )?;
    Ok(())
}

/// List insights for a workspace, newest-first.
pub fn list_insights(conn: &Connection, workspace_hash: &str) -> Result<Vec<Insight>> {
    let now = current_timestamp();
    let mut stmt = conn.prepare(
        "SELECT id, workspace_hash, finding, evidence, confidence,
                source_thread, source_runs, created_at, expires_at
           FROM insights
          WHERE workspace_hash = ?1
            AND (expires_at IS NULL OR expires_at > ?2)
          ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(params![workspace_hash, now], |row| {
        Ok(Insight {
            id: row.get(0)?,
            workspace_hash: row.get(1)?,
            finding: row.get(2)?,
            evidence: row.get(3)?,
            confidence: row.get(4)?,
            source_thread: row.get(5)?,
            source_runs: row.get(6)?,
            created_at: row.get(7)?,
            expires_at: row.get(8)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Delete an insight by ID.
pub fn delete_insight(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM insights WHERE id = ?1", params![id])?;
    Ok(())
}

/// Count active insights for a workspace (non-expired).
pub fn count_insights(conn: &Connection, workspace_hash: &str) -> Result<usize> {
    let now = current_timestamp();
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM insights
          WHERE workspace_hash = ?1
            AND (expires_at IS NULL OR expires_at > ?2)",
        params![workspace_hash, now],
        |row| row.get(0),
    )?;
    Ok(count as usize)
}

/// Delete oldest insights to enforce the max 50 limit (FIFO eviction).
/// Called automatically after insert when limit is exceeded.
pub fn evict_old_insights(conn: &Connection, workspace_hash: &str) -> Result<usize> {
    let evicted = conn.execute(
        r#"
        DELETE FROM insights WHERE id IN (
            SELECT id FROM insights
             WHERE workspace_hash = ?1
               AND (expires_at IS NULL OR expires_at > ?2)
            ORDER BY created_at ASC
            LIMIT MAX(0, (
                SELECT COUNT(*) FROM insights
                 WHERE workspace_hash = ?1
                   AND (expires_at IS NULL OR expires_at > ?2)
            ) - 50)
        )
        "#,
        params![workspace_hash, current_timestamp()],
    )?;
    Ok(evicted)
}

// ── Dead-end CRUD ─────────────────────────────────────────────────────────────

/// Insert a new dead-end. Returns the generated ID.
pub fn create_dead_end(conn: &Connection, dead_end: &DeadEnd) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO dead_ends (
            id, workspace_hash, hypothesis, evidence, tried_runs, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        "#,
        params![
            dead_end.id,
            dead_end.workspace_hash,
            dead_end.hypothesis,
            dead_end.evidence,
            dead_end.tried_runs,
            dead_end.created_at,
        ],
    )?;
    Ok(())
}

/// List dead-ends for a workspace, newest-first.
pub fn list_dead_ends(conn: &Connection, workspace_hash: &str) -> Result<Vec<DeadEnd>> {
    let mut stmt = conn.prepare(
        "SELECT id, workspace_hash, hypothesis, evidence, tried_runs, created_at
           FROM dead_ends
          WHERE workspace_hash = ?1
          ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(params![workspace_hash], |row| {
        Ok(DeadEnd {
            id: row.get(0)?,
            workspace_hash: row.get(1)?,
            hypothesis: row.get(2)?,
            evidence: row.get(3)?,
            tried_runs: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Delete a dead-end by ID.
pub fn delete_dead_end(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM dead_ends WHERE id = ?1", params![id])?;
    Ok(())
}

/// Count dead-ends for a workspace.
pub fn count_dead_ends(conn: &Connection, workspace_hash: &str) -> Result<usize> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM dead_ends WHERE workspace_hash = ?1",
        params![workspace_hash],
        |row| row.get(0),
    )?;
    Ok(count as usize)
}

/// Delete oldest dead-ends to enforce the max 50 limit (FIFO eviction).
pub fn evict_old_dead_ends(conn: &Connection, workspace_hash: &str) -> Result<usize> {
    let evicted = conn.execute(
        r#"
        DELETE FROM dead_ends WHERE id IN (
            SELECT id FROM dead_ends
             WHERE workspace_hash = ?1
            ORDER BY created_at ASC
            LIMIT MAX(0, (
                SELECT COUNT(*) FROM dead_ends WHERE workspace_hash = ?1
            ) - 50)
        )
        "#,
        params![workspace_hash],
    )?;
    Ok(evicted)
}

// ── High-level operations ─────────────────────────────────────────────────────

/// Write a memory entry (insight or dead-end) to the workspace DB.
/// Handles ID generation, insert, and FIFO eviction.
pub fn write_memory_entry(
    conn: &Connection,
    workspace_hash: &str,
    input: &WriteMemoryInput,
) -> Result<String, String> {
    let now = current_timestamp();

    match input.kind.as_str() {
        "insight" => {
            let finding = input.finding.as_deref().unwrap_or("");
            let id = compute_memory_id(workspace_hash, finding);
            let insight = Insight {
                id: id.clone(),
                workspace_hash: workspace_hash.to_string(),
                finding: finding.to_string(),
                evidence: input.evidence.clone().unwrap_or_default(),
                confidence: input.confidence.clone().unwrap_or_else(|| "medium".to_string()),
                source_thread: input.source_thread.clone(),
                source_runs: input.source_runs.as_ref().map(|runs| {
                    serde_json::to_string(runs).unwrap_or_default()
                }),
                created_at: now,
                expires_at: None,
            };
            create_insight(conn, &insight).map_err(|e| format!("create_insight: {e}"))?;
            // Evict if over limit
            evict_old_insights(conn, workspace_hash).ok();
            Ok(id)
        }
        "dead_end" => {
            let hypothesis = input.hypothesis.as_deref().unwrap_or("");
            let id = compute_memory_id(workspace_hash, hypothesis);
            let dead_end = DeadEnd {
                id: id.clone(),
                workspace_hash: workspace_hash.to_string(),
                hypothesis: hypothesis.to_string(),
                evidence: input.evidence.clone().unwrap_or_default(),
                tried_runs: input.tried_runs.as_ref().map(|runs| {
                    serde_json::to_string(runs).unwrap_or_default()
                }),
                created_at: now,
            };
            create_dead_end(conn, &dead_end).map_err(|e| format!("create_dead_end: {e}"))?;
            // Evict if over limit
            evict_old_dead_ends(conn, workspace_hash).ok();
            Ok(id)
        }
        _ => Err(format!("Unknown memory kind: {}", input.kind)),
    }
}

/// Query project memory with optional kind filter.
/// Returns all entries matching the filter, newest-first.
pub fn query_memory(
    conn: &Connection,
    workspace_hash: &str,
    kind: Option<&str>,
) -> Result<Vec<MemoryEntry>, String> {
    let mut entries = Vec::new();

    let want_insights = kind.map(|k| k == "insight").unwrap_or(true);
    let want_dead_ends = kind.map(|k| k == "dead_end").unwrap_or(true);

    if want_insights {
        let insights = list_insights(conn, workspace_hash)
            .map_err(|e| format!("list_insights: {e}"))?;
        for insight in insights {
            entries.push(MemoryEntry::Insight(insight));
        }
    }

    if want_dead_ends {
        let dead_ends = list_dead_ends(conn, workspace_hash)
            .map_err(|e| format!("list_dead_ends: {e}"))?;
        for dead_end in dead_ends {
            entries.push(MemoryEntry::DeadEnd(dead_end));
        }
    }

    // Sort by created_at descending (newest first)
    entries.sort_by(|a, b| {
        let a_ts = match a {
            MemoryEntry::Insight(i) => i.created_at,
            MemoryEntry::DeadEnd(d) => d.created_at,
        };
        let b_ts = match b {
            MemoryEntry::Insight(i) => i.created_at,
            MemoryEntry::DeadEnd(d) => d.created_at,
        };
        b_ts.cmp(&a_ts)
    });

    Ok(entries)
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn test_conn() -> (Connection, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let conn = Connection::open(dir.path().join("test.db")).unwrap();
        
        // Create tables matching the spec schema
        conn.execute_batch(
            r#"
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
            "#,
        )
        .unwrap();
        (conn, dir)
    }

    #[test]
    fn test_insight_roundtrip() {
        let (conn, _dir) = test_conn();
        let ws = "test_ws";

        let insight = Insight {
            id: "mem_test1".to_string(),
            workspace_hash: ws.to_string(),
            finding: "lr=5e-4 works best".to_string(),
            evidence: "val_loss=0.28".to_string(),
            confidence: "high".to_string(),
            source_thread: Some("thread1".to_string()),
            source_runs: Some("[\"run1\"]".to_string()),
            created_at: 1000,
            expires_at: None,
        };

        create_insight(&conn, &insight).unwrap();
        let list = list_insights(&conn, ws).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].finding, "lr=5e-4 works best");
        assert_eq!(list[0].confidence, "high");
    }

    #[test]
    fn test_dead_end_roundtrip() {
        let (conn, _dir) = test_conn();
        let ws = "test_ws";

        let dead_end = DeadEnd {
            id: "mem_test2".to_string(),
            workspace_hash: ws.to_string(),
            hypothesis: "batch_size=256 improves".to_string(),
            evidence: "OOM at step 100".to_string(),
            tried_runs: Some("[\"run2\"]".to_string()),
            created_at: 1000,
        };

        create_dead_end(&conn, &dead_end).unwrap();
        let list = list_dead_ends(&conn, ws).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].hypothesis, "batch_size=256 improves");
    }

    #[test]
    fn test_fifo_eviction_insights() {
        let (conn, _dir) = test_conn();
        let ws = "test_ws";

        // Insert 52 insights (over the 50 limit)
        for i in 0..52 {
            let insight = Insight {
                id: format!("mem_evict_{}", i),
                workspace_hash: ws.to_string(),
                finding: format!("finding_{}", i),
                evidence: format!("evidence_{}", i),
                confidence: "medium".to_string(),
                source_thread: None,
                source_runs: None,
                created_at: i as i64,
                expires_at: None,
            };
            create_insight(&conn, &insight).unwrap();
        }

        // Evict should remove 2 oldest
        evict_old_insights(&conn, ws).unwrap();

        let count = count_insights(&conn, ws).unwrap();
        assert_eq!(count, 50);

        // Oldest 2 (0 and 1) should be gone
        let list = list_insights(&conn, ws).unwrap();
        assert!(!list.iter().any(|i| i.finding == "finding_0"));
        assert!(!list.iter().any(|i| i.finding == "finding_1"));
        // Newest should still be there
        assert!(list.iter().any(|i| i.finding == "finding_51"));
    }

    #[test]
    fn test_fifo_eviction_dead_ends() {
        let (conn, _dir) = test_conn();
        let ws = "test_ws";

        // Insert 52 dead-ends (over the 50 limit)
        for i in 0..52 {
            let dead_end = DeadEnd {
                id: format!("mem_de_{}", i),
                workspace_hash: ws.to_string(),
                hypothesis: format!("hypothesis_{}", i),
                evidence: format!("evidence_{}", i),
                tried_runs: None,
                created_at: i as i64,
            };
            create_dead_end(&conn, &dead_end).unwrap();
        }

        evict_old_dead_ends(&conn, ws).unwrap();

        let count = count_dead_ends(&conn, ws).unwrap();
        assert_eq!(count, 50);
    }

    #[test]
    fn test_memory_query_by_kind() {
        let (conn, _dir) = test_conn();
        let ws = "test_ws";

        // Insert one of each
        create_insight(&conn, &Insight {
            id: "ins1".to_string(),
            workspace_hash: ws.to_string(),
            finding: "test insight".to_string(),
            evidence: "test".to_string(),
            confidence: "high".to_string(),
            source_thread: None,
            source_runs: None,
            created_at: 100,
            expires_at: None,
        }).unwrap();

        create_dead_end(&conn, &DeadEnd {
            id: "de1".to_string(),
            workspace_hash: ws.to_string(),
            hypothesis: "test dead end".to_string(),
            evidence: "test".to_string(),
            tried_runs: None,
            created_at: 200,
        }).unwrap();

        // Query both
        let both = query_memory(&conn, ws, None).unwrap();
        assert_eq!(both.len(), 2);

        // Query insights only
        let insights = query_memory(&conn, ws, Some("insight")).unwrap();
        assert_eq!(insights.len(), 1);
        assert!(matches!(insights[0], MemoryEntry::Insight(_)));

        // Query dead_ends only
        let dead_ends = query_memory(&conn, ws, Some("dead_end")).unwrap();
        assert_eq!(dead_ends.len(), 1);
        assert!(matches!(dead_ends[0], MemoryEntry::DeadEnd(_)));
    }

    #[test]
    fn test_expired_insight_filtering() {
        let (conn, _dir) = test_conn();
        let ws = "test_ws";

        // Insert an expired insight (expires_at in the past)
        conn.execute(
            r#"INSERT INTO insights (id, workspace_hash, finding, evidence, confidence, created_at, expires_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
            params!["expired1", ws, "expired", "test", "medium", 100i64, 50i64],
        ).unwrap();

        // Insert a non-expired insight
        conn.execute(
            r#"INSERT INTO insights (id, workspace_hash, finding, evidence, confidence, created_at, expires_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
            params!["active1", ws, "active", "test", "medium", 100i64, (i64::MAX)],
        ).unwrap();

        let list = list_insights(&conn, ws).unwrap();
        // Only non-expired should appear
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "active1");
    }

    #[test]
    fn test_write_memory_entry() {
        let (conn, _dir) = test_conn();
        let ws = "test_ws";

        // Write insight
        let id = write_memory_entry(&conn, ws, &WriteMemoryInput {
            kind: "insight".to_string(),
            finding: Some("lr=1e-4 best".to_string()),
            evidence: Some("val_loss=0.25".to_string()),
            confidence: Some("high".to_string()),
            hypothesis: None,
            source_thread: Some("thread1".to_string()),
            source_runs: Some(vec!["run1".to_string()]),
            tried_runs: None,
        }).unwrap();

        assert!(id.starts_with("mem_"));

        // Write dead-end
        let id2 = write_memory_entry(&conn, ws, &WriteMemoryInput {
            kind: "dead_end".to_string(),
            finding: None,
            evidence: Some("OOM error".to_string()),
            confidence: None,
            hypothesis: Some("batch_size=512".to_string()),
            source_thread: None,
            source_runs: None,
            tried_runs: Some(vec!["run2".to_string()]),
        }).unwrap();

        assert!(id2.starts_with("mem_"));
        assert_ne!(id, id2);

        // Query both
        let entries = query_memory(&conn, ws, None).unwrap();
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn test_confidence_from_str() {
        assert_eq!(Confidence::from_str("low"), Confidence::Low);
        assert_eq!(Confidence::from_str("HIGH"), Confidence::High);
        assert_eq!(Confidence::from_str("Medium"), Confidence::Medium);
        assert_eq!(Confidence::from_str("invalid"), Confidence::Medium); // default
    }

    #[test]
    fn test_compute_memory_id() {
        let id1 = compute_memory_id("ws1", "content");
        let id2 = compute_memory_id("ws1", "content");
        let id3 = compute_memory_id("ws2", "content");

        assert_eq!(id1, id2); // Same input -> same ID
        assert_ne!(id1, id3); // Different workspace -> different ID
        assert!(id1.starts_with("mem_"));
    }
}
