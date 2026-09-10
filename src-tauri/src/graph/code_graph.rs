//! Tree-sitter–based Python code graph indexer.
//!
//! Phase 0 extracts `function_definition` and `class_definition` nodes
//! from every `.py` file under a workspace root and persists them in the
//! `code_nodes` table.  Edge extraction (calls, imports, inheritance) is
//! marked PHASE0-TODO.

use rusqlite::Connection;
use serde::Serialize;
use std::path::Path;
use std::time::Instant;
use tree_sitter::{Node, Parser};
use uuid::Uuid;
use walkdir::WalkDir;

/// Summary of a completed code-graph indexing pass.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSummary {
    /// Number of nodes (functions + classes) inserted into `code_nodes`.
    pub nodes_indexed: u32,
    /// PHASE0-TODO — always 0 for now.
    pub edges_indexed: u32,
    /// Number of `.py` files that were parsed.
    pub files_scanned: u32,
    /// Wall-clock time spent indexing, in milliseconds.
    pub duration_ms: u64,
}

/// A single entry returned from a code-graph search.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeGraphHit {
    pub id: String,
    pub kind: String,
    pub file: String,
    pub name: String,
    pub span_start: u32,
    pub span_end: u32,
}

/// Recursively index every `.py` file under `root`, extracting
/// `function_definition` and `class_definition` nodes and inserting
/// them into `code_nodes`.
///
/// # Errors
/// Returns a `String` if the parser cannot be initialized, a source file
/// cannot be read, or the database write fails.
pub fn index_code_graph(conn: &Connection, root: &Path) -> Result<IndexSummary, String> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_python::LANGUAGE.into())
        .map_err(|e| e.to_string())?;

    let start = Instant::now();
    let mut nodes_indexed: u32 = 0;
    let mut files_scanned: u32 = 0;

    // PHASE0-TODO: edges are not collected yet.
    // When edge extraction is added, accumulate them here and write to code_edges.

    for entry in WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.')
                && name != "node_modules"
                && name != "venv"
                && name != "__pycache__"
                && name != "target"
        })
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("py") {
            continue;
        }

        let source = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let tree = match parser.parse(&source, None) {
            Some(t) => t,
            None => continue,
        };

        walk_tree(&source, tree.root_node(), path, conn, &mut nodes_indexed);
        files_scanned += 1;
    }

    let duration_ms = start.elapsed().as_millis() as u64;

    Ok(IndexSummary {
        nodes_indexed,
        edges_indexed: 0, // PHASE0-TODO
        files_scanned,
        duration_ms,
    })
}

/// Recursively walk a tree-sitter tree, extracting function and class
/// definitions and inserting them into `code_nodes`.
fn walk_tree(source: &str, node: Node, path: &Path, conn: &Connection, counter: &mut u32) {
    let kind = node.kind();

    if kind == "function_definition" || kind == "class_definition" {
        let name_node = node.child_by_field_name("name");
        let name = name_node
            .and_then(|n| n.utf8_text(source.as_bytes()).ok())
            .unwrap_or_default();

        let span_start = name_node.map(|n| n.start_byte()).unwrap_or(0);
        let span_end = name_node.map(|n| n.end_byte()).unwrap_or(0);

        let id = Uuid::new_v4().to_string();
        let file = path.to_string_lossy().to_string();

        conn.execute(
            "INSERT OR REPLACE INTO code_nodes (id, kind, file, name, span_start, span_end) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            (&id, kind, &file, &name, span_start, span_end),
        )
        .ok();

        *counter += 1;
    }

    // Continue recursively into children.
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk_tree(source, child, path, conn, counter);
    }
}

/// Search the code graph for nodes whose name or file path contains `query`
/// (case-insensitive substring match via SQL LIKE).
///
/// Returns the matching `CodeGraphHit` rows sorted by name.
pub fn query_code_graph(query: &str, conn: &Connection) -> Result<Vec<CodeGraphHit>, String> {
    let pattern = format!("%{query}%");
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, file, name, span_start, span_end \
             FROM code_nodes \
             WHERE name LIKE ?1 OR file LIKE ?1 \
             ORDER BY name",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([&pattern], |row| {
            Ok(CodeGraphHit {
                id: row.get(0)?,
                kind: row.get(1)?,
                file: row.get(2)?,
                name: row.get(3)?,
                span_start: row.get(4)?,
                span_end: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut hits = Vec::new();
    for row in rows {
        if let Ok(hit) = row {
            hits.push(hit);
        }
    }

    Ok(hits)
}
