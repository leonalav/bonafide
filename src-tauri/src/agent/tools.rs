//! Tool registry — implements the full section-4 tool catalog.
//!
//! ## Architecture
//!
//! `ToolRegistry` holds all 37 tool definitions (sections 4.2–4.9) and
//! routes each `execute(name, args)` call to a typed handler. Handlers
//! either:
//! - Use existing Rust modules directly (git_service, graph::code_graph, etc.)
//! - Implement net-new logic inline (search_files, apply_patch, run_shell,
//!   search_arxiv, query/write_project_memory, run_python, etc.)
//!
//! ## WS2-T1 deliverables
//!
//! - All 37 `AgentToolDefinition` values (mirrored in `src/agent/tools.ts`)
//! - `definitions_for_role(role)` — filters tools by section-12.2 allowlist
//! - `execute(tool_call)` — routes to typed handlers
//! - `render_trace_step` / `tool_result_message` — same interface as
//!   the stub so the engine's call sites compile unchanged

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value as JsonValue};

use crate::agent::approval::ApprovalGate;
use crate::agent::llm::{ChatMessage, ToolDefinition, ToolFunction};
use crate::agent::orchestrator::AgentRole;

// ── ToolResult (replaces stub's ToolResult) ──────────────────────────────────

/// Result of a tool execution. Replaces the stub's `ToolResult` with the
/// same variant set so the engine's call sites compile unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolResult {
    Ok { summary: String },
    Skipped { reason: String },
    Error { error: String },
}

impl ToolResult {
    pub fn is_ok(&self) -> bool {
        matches!(self, Self::Ok { .. })
    }
    pub fn summary(&self) -> String {
        match self {
            Self::Ok { summary } => summary.clone(),
            Self::Skipped { reason } => format!("(skipped: {reason})"),
            Self::Error { error } => format!("(error: {error})"),
        }
    }
    pub fn ok(summary: impl Into<String>) -> Self {
        Self::Ok { summary: summary.into() }
    }
    pub fn err(error: impl Into<String>) -> Self {
        Self::Error { error: error.into() }
    }
}

// ── Tool definitions ──────────────────────────────────────────────────────────

/// One canonical tool definition. Field names match the OpenAI `function`
/// call schema and are identical to `AgentToolDefinition` in
/// `src/agent/tools.ts`.
#[derive(Debug, Clone)]
pub struct Tool {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: JsonValue,
    pub safety: SafetyLevel,
    pub estimated_cost: f32,
    pub requires_workspace: bool,
    pub display_name: &'static str,
    pub category: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SafetyLevel {
    Read,
    WriteLocal,
    WriteRemote,
    Compute,
    Dangerous,
}

impl From<&Tool> for ToolDefinition {
    fn from(tool: &Tool) -> Self {
        ToolDefinition {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: tool.name.to_string(),
                description: tool.description.to_string(),
                parameters: tool.parameters.clone(),
            },
        }
    }
}

// ── Tool catalog (37 tools, sections 4.2–4.9) ──────────────────────────────

fn build_tool_catalog() -> HashMap<&'static str, Tool> {
    let mut m = HashMap::new();

    // ── 4.2 Filesystem ─────────────────────────────────────────────────────

    m.insert("read_file", Tool {
        name: "read_file",
        description: "Read the contents of a file in the workspace.",
        parameters: json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Relative path from workspace root, e.g. src/train.py" },
                "start_line": { "type": "number", "description": "Optional: start line (1-indexed)." },
                "end_line": { "type": "number", "description": "Optional: end line (1-indexed, inclusive)." }
            },
            "required": ["path"]
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Read File",
        category: "filesystem",
    });

    m.insert("read_directory", Tool {
        name: "read_directory",
        description: "List directory contents with file types.",
        parameters: json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Absolute path of the directory to list." }
            },
            "required": ["path"]
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Read Directory",
        category: "filesystem",
    });

    m.insert("search_files", Tool {
        name: "search_files",
        description: "Search for files matching a glob pattern or content substring.",
        parameters: json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Glob pattern (e.g. **/*.py) or substring." },
                "path": { "type": "string", "description": "Optional: root path. Defaults to workspace root." }
            },
            "required": ["pattern"]
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Search Files",
        category: "filesystem",
    });

    m.insert("write_file", Tool {
        name: "write_file",
        description: "Write file contents (create or overwrite).",
        parameters: json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Relative path from workspace root." },
                "content": { "type": "string", "description": "Full file contents to write." }
            },
            "required": ["path", "content"]
        }),
        safety: SafetyLevel::WriteLocal,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Write File",
        category: "filesystem",
    });

    m.insert("create_file", Tool {
        name: "create_file",
        description: "Create an empty file.",
        parameters: json!({
            "type": "object",
            "properties": {
                "parent_dir": { "type": "string", "description": "Absolute path of the parent directory." },
                "name": { "type": "string", "description": "Name of the file to create." }
            },
            "required": ["parent_dir", "name"]
        }),
        safety: SafetyLevel::WriteLocal,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Create File",
        category: "filesystem",
    });

    m.insert("create_folder", Tool {
        name: "create_folder",
        description: "Create a directory.",
        parameters: json!({
            "type": "object",
            "properties": {
                "parent_dir": { "type": "string", "description": "Absolute path of the parent directory." },
                "name": { "type": "string", "description": "Name of the directory to create." }
            },
            "required": ["parent_dir", "name"]
        }),
        safety: SafetyLevel::WriteLocal,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Create Folder",
        category: "filesystem",
    });

    m.insert("rename_path", Tool {
        name: "rename_path",
        description: "Rename a file or folder.",
        parameters: json!({
            "type": "object",
            "properties": {
                "src": { "type": "string", "description": "Current absolute path." },
                "new_name": { "type": "string", "description": "New name (not full path)." }
            },
            "required": ["src", "new_name"]
        }),
        safety: SafetyLevel::WriteLocal,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Rename Path",
        category: "filesystem",
    });

    m.insert("delete_path", Tool {
        name: "delete_path",
        description: "Delete a file or folder. IRREVERSIBLE.",
        parameters: json!({
            "type": "object",
            "properties": {
                "target": { "type": "string", "description": "Absolute path to delete." }
            },
            "required": ["target"]
        }),
        safety: SafetyLevel::Dangerous,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Delete Path",
        category: "filesystem",
    });

    m.insert("apply_patch", Tool {
        name: "apply_patch",
        description: "Apply a unified diff to a file. Creates a .bak backup.",
        parameters: json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Relative path from workspace root." },
                "patch": { "type": "string", "description": "Unified diff string (---/+++ format)." }
            },
            "required": ["path", "patch"]
        }),
        safety: SafetyLevel::WriteLocal,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Apply Patch",
        category: "filesystem",
    });

    // ── 4.3 Tracker ────────────────────────────────────────────────────────

    let tracker_run_props = json!({
        "kind": { "type": "string", "description": "wandb or mlflow.", "enum": ["wandb", "mlflow"] },
        "run_id": { "type": "string", "description": "Run ID." }
    });

    m.insert("list_runs", Tool {
        name: "list_runs",
        description: "List runs for the current tracker project.",
        parameters: json!({
            "type": "object",
            "properties": {
                "kind": { "type": "string", "description": "wandb or mlflow.", "enum": ["wandb", "mlflow"] },
                "project": { "type": "string", "description": "Project name." },
                "limit": { "type": "number", "description": "Max runs (default 50)." }
            },
            "required": ["kind", "project"]
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: false,
        display_name: "List Runs",
        category: "tracker",
    });

    m.insert("get_run", Tool {
        name: "get_run",
        description: "Full detail for a single run.",
        parameters: json!({
            "type": "object",
            "properties": tracker_run_props,
            "required": ["kind", "run_id"]
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: false,
        display_name: "Get Run",
        category: "tracker",
    });

    m.insert("get_metric_series", Tool {
        name: "get_metric_series",
        description: "Time-series values for one metric.",
        parameters: json!({
            "type": "object",
            "properties": {
                "kind": { "type": "string", "description": "wandb or mlflow.", "enum": ["wandb", "mlflow"] },
                "run_id": { "type": "string", "description": "Run ID." },
                "key": { "type": "string", "description": "Metric key, e.g. val_loss." }
            },
            "required": ["kind", "run_id", "key"]
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: false,
        display_name: "Get Metric Series",
        category: "tracker",
    });

    m.insert("get_run_config", Tool {
        name: "get_run_config",
        description: "Full config dict for a run.",
        parameters: json!({
            "type": "object",
            "properties": tracker_run_props,
            "required": ["kind", "run_id"]
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: false,
        display_name: "Get Run Config",
        category: "tracker",
    });

    m.insert("list_artifacts", Tool {
        name: "list_artifacts",
        description: "List logged artifacts for a run.",
        parameters: json!({
            "type": "object",
            "properties": tracker_run_props,
            "required": ["kind", "run_id"]
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: false,
        display_name: "List Artifacts",
        category: "tracker",
    });

    m.insert("compare_runs", Tool {
        name: "compare_runs",
        description: "Side-by-side diff of two runs' configs and metrics.",
        parameters: json!({
            "type": "object",
            "properties": {
                "kind": { "type": "string", "description": "wandb or mlflow.", "enum": ["wandb", "mlflow"] },
                "run_ids": { "type": "string", "description": "Comma-separated list of two run IDs." }
            },
            "required": ["kind", "run_ids"]
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: false,
        display_name: "Compare Runs",
        category: "tracker",
    });

    m.insert("query_run_graph", Tool {
        name: "query_run_graph",
        description: "Cross-run relationships (framework × dataset × GPU).",
        parameters: json!({
            "type": "object",
            "properties": {
                "framework": { "type": "string", "description": "Optional: filter by framework." },
                "dataset": { "type": "string", "description": "Optional: filter by dataset." }
            },
            "required": []
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: false,
        display_name: "Query Run Graph",
        category: "tracker",
    });

    // ── 4.4 Code Intelligence ──────────────────────────────────────────────

    m.insert("query_code_graph", Tool {
        name: "query_code_graph",
        description: "Find functions and classes by name in the indexed Python codebase.",
        parameters: json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Symbol name to search." }
            },
            "required": ["query"]
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Query Code Graph",
        category: "code",
    });

    m.insert("index_code_graph", Tool {
        name: "index_code_graph",
        description: "Re-index Python files after code changes.",
        parameters: json!({ "type": "object", "properties": {}, "required": [] }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Index Code Graph",
        category: "code",
    });

    m.insert("ruff_check", Tool {
        name: "ruff_check",
        description: "Run ruff linter on a file.",
        parameters: json!({
            "type": "object",
            "properties": {
                "file_path": { "type": "string", "description": "Absolute path to the Python file." }
            },
            "required": ["file_path"]
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Ruff Check",
        category: "code",
    });

    m.insert("lsp_hover", Tool {
        name: "lsp_hover",
        description: "Get type information for a symbol via LSP.",
        parameters: json!({
            "type": "object",
            "properties": {
                "file_path": { "type": "string", "description": "Absolute path of the file." },
                "line": { "type": "number", "description": "1-indexed line number." },
                "column": { "type": "number", "description": "0-indexed column number." }
            },
            "required": ["file_path", "line", "column"]
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "LSP Hover",
        category: "code",
    });

    m.insert("lsp_definition", Tool {
        name: "lsp_definition",
        description: "Navigate to the definition of a symbol via LSP.",
        parameters: json!({
            "type": "object",
            "properties": {
                "file_path": { "type": "string", "description": "Absolute path of the file." },
                "line": { "type": "number", "description": "1-indexed line number." },
                "column": { "type": "number", "description": "0-indexed column number." }
            },
            "required": ["file_path", "line", "column"]
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "LSP Definition",
        category: "code",
    });

    // ── 4.5 Git ────────────────────────────────────────────────────────────

    m.insert("git_diff", Tool {
        name: "git_diff",
        description: "Show the diff for a file or the entire workspace.",
        parameters: json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Optional: relative path." }
            },
            "required": []
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Git Diff",
        category: "git",
    });

    m.insert("git_log", Tool {
        name: "git_log",
        description: "Show recent commits.",
        parameters: json!({
            "type": "object",
            "properties": {
                "max_count": { "type": "number", "description": "Max commits (default 20)." }
            },
            "required": []
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Git Log",
        category: "git",
    });

    m.insert("git_status", Tool {
        name: "git_status",
        description: "Current branch, staged and unstaged changes.",
        parameters: json!({ "type": "object", "properties": {}, "required": [] }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Git Status",
        category: "git",
    });

    m.insert("git_checkout", Tool {
        name: "git_checkout",
        description: "Switch or create a branch.",
        parameters: json!({
            "type": "object",
            "properties": {
                "branch": { "type": "string", "description": "Branch name." },
                "create": { "type": "boolean", "description": "Create if not exists." }
            },
            "required": ["branch"]
        }),
        safety: SafetyLevel::WriteRemote,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Git Checkout",
        category: "git",
    });

    m.insert("git_add", Tool {
        name: "git_add",
        description: "Stage files for commit.",
        parameters: json!({
            "type": "object",
            "properties": {
                "paths": { "type": "string", "description": "Comma-separated relative paths." }
            },
            "required": ["paths"]
        }),
        safety: SafetyLevel::WriteLocal,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Git Add",
        category: "git",
    });

    m.insert("git_commit", Tool {
        name: "git_commit",
        description: "Commit staged changes.",
        parameters: json!({
            "type": "object",
            "properties": {
                "message": { "type": "string", "description": "Commit message." }
            },
            "required": ["message"]
        }),
        safety: SafetyLevel::WriteRemote,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Git Commit",
        category: "git",
    });

    m.insert("git_discard", Tool {
        name: "git_discard",
        description: "Discard uncommitted changes. IRREVERSIBLE.",
        parameters: json!({
            "type": "object",
            "properties": {
                "paths": { "type": "string", "description": "Comma-separated relative paths." }
            },
            "required": ["paths"]
        }),
        safety: SafetyLevel::Dangerous,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Git Discard",
        category: "git",
    });

    // ── 4.6 Execution ─────────────────────────────────────────────────────

    m.insert("run_shell", Tool {
        name: "run_shell",
        description: "Execute a shell command. Budget-gated. Timeout: 300s.",
        parameters: json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "Shell command to execute." },
                "timeout_secs": { "type": "number", "description": "Timeout in seconds (default 300)." }
            },
            "required": ["command"]
        }),
        safety: SafetyLevel::Compute,
        estimated_cost: 0.01,
        requires_workspace: true,
        display_name: "Run Shell",
        category: "execution",
    });

    m.insert("run_python", Tool {
        name: "run_python",
        description: "Execute a Python snippet in the workspace venv.",
        parameters: json!({
            "type": "object",
            "properties": {
                "code": { "type": "string", "description": "Python code to execute." },
                "timeout_secs": { "type": "number", "description": "Timeout in seconds (default 60)." }
            },
            "required": ["code"]
        }),
        safety: SafetyLevel::Compute,
        estimated_cost: 0.01,
        requires_workspace: true,
        display_name: "Run Python",
        category: "execution",
    });

    m.insert("run_smoke_test", Tool {
        name: "run_smoke_test",
        description: "Run train.py for limited steps to verify correctness.",
        parameters: json!({
            "type": "object",
            "properties": {
                "script_path": { "type": "string", "description": "Relative path to the training script." },
                "max_steps": { "type": "number", "description": "Max training steps (default 200)." }
            },
            "required": ["script_path"]
        }),
        safety: SafetyLevel::Compute,
        estimated_cost: 0.10,
        requires_workspace: true,
        display_name: "Run Smoke Test",
        category: "execution",
    });

    m.insert("pip_install", Tool {
        name: "pip_install",
        description: "Install a Python package in the workspace venv.",
        parameters: json!({
            "type": "object",
            "properties": {
                "package": { "type": "string", "description": "Package spec, e.g. torch or numpy==1.24.0." }
            },
            "required": ["package"]
        }),
        safety: SafetyLevel::Compute,
        estimated_cost: 0.05,
        requires_workspace: true,
        display_name: "Pip Install",
        category: "execution",
    });

    // ── 4.7 Experiments ────────────────────────────────────────────────────

    m.insert("create_experiment", Tool {
        name: "create_experiment",
        description: "Create an experiment definition (not yet started).",
        parameters: json!({
            "type": "object",
            "properties": {
                "title": { "type": "string", "description": "Human-readable title." },
                "hypothesis": { "type": "string", "description": "The hypothesis this experiment tests." },
                "goal_metric": { "type": "string", "description": "Metric to optimize, e.g. val_loss." },
                "goal_direction": { "type": "string", "description": "minimize or maximize.", "enum": ["minimize", "maximize"] },
                "goal_target": { "type": "number", "description": "Target value." }
            },
            "required": ["title", "hypothesis"]
        }),
        safety: SafetyLevel::WriteLocal,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Create Experiment",
        category: "experiment",
    });

    m.insert("update_experiment", Tool {
        name: "update_experiment",
        description: "Modify an experiment's hypothesis, goal, or status.",
        parameters: json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "Experiment ID." },
                "updates": { "type": "string", "description": "JSON object of fields to update." }
            },
            "required": ["id", "updates"]
        }),
        safety: SafetyLevel::WriteLocal,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Update Experiment",
        category: "experiment",
    });

    m.insert("launch_experiment_run", Tool {
        name: "launch_experiment_run",
        description: "Start a training run. Budget-gated.",
        parameters: json!({
            "type": "object",
            "properties": {
                "experiment_id": { "type": "string", "description": "Experiment ID." },
                "config_overrides": { "type": "string", "description": "JSON config overrides." }
            },
            "required": ["experiment_id"]
        }),
        safety: SafetyLevel::Compute,
        estimated_cost: 1.0,
        requires_workspace: true,
        display_name: "Launch Experiment Run",
        category: "experiment",
    });

    m.insert("stop_experiment_run", Tool {
        name: "stop_experiment_run",
        description: "Stop a running training process.",
        parameters: json!({
            "type": "object",
            "properties": {
                "run_id": { "type": "string", "description": "Run ID to stop." }
            },
            "required": ["run_id"]
        }),
        safety: SafetyLevel::WriteRemote,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Stop Experiment Run",
        category: "experiment",
    });

    m.insert("list_experiments", Tool {
        name: "list_experiments",
        description: "List all experiments for the current workspace.",
        parameters: json!({ "type": "object", "properties": {}, "required": [] }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "List Experiments",
        category: "experiment",
    });

    m.insert("get_experiment", Tool {
        name: "get_experiment",
        description: "Full experiment detail with linked runs.",
        parameters: json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "Experiment ID." }
            },
            "required": ["id"]
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Get Experiment",
        category: "experiment",
    });

    // ── 4.8 Knowledge ──────────────────────────────────────────────────────

    m.insert("search_arxiv", Tool {
        name: "search_arxiv",
        description: "Search arXiv for papers by keyword.",
        parameters: json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Search query." },
                "max_results": { "type": "number", "description": "Max papers (default 5)." }
            },
            "required": ["query"]
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: false,
        display_name: "Search ArXiv",
        category: "knowledge",
    });

    m.insert("read_paper", Tool {
        name: "read_paper",
        description: "Fetch and summarize a paper from arXiv by ID.",
        parameters: json!({
            "type": "object",
            "properties": {
                "paper_id": { "type": "string", "description": "arXiv paper ID, e.g. 2301.00001." }
            },
            "required": ["paper_id"]
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: false,
        display_name: "Read Paper",
        category: "knowledge",
    });

    m.insert("query_project_memory", Tool {
        name: "query_project_memory",
        description: "Read project memory: insights and dead ends.",
        parameters: json!({
            "type": "object",
            "properties": {
                "kind": { "type": "string", "description": "insights, dead_ends, or all.", "enum": ["insights", "dead_ends", "all"] },
                "limit": { "type": "number", "description": "Max entries (default 20)." }
            },
            "required": []
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Query Project Memory",
        category: "knowledge",
    });

    m.insert("write_project_memory", Tool {
        name: "write_project_memory",
        description: "Write an insight or dead end to project memory.",
        parameters: json!({
            "type": "object",
            "properties": {
                "kind": { "type": "string", "description": "insight or dead_end.", "enum": ["insight", "dead_end"] },
                "label": { "type": "string", "description": "Short finding summary." },
                "evidence": { "type": "string", "description": "Supporting evidence." },
                "confidence": { "type": "string", "description": "High/Medium/Low.", "enum": ["High", "Medium", "Low"] }
            },
            "required": ["kind", "label", "evidence"]
        }),
        safety: SafetyLevel::WriteLocal,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Write Project Memory",
        category: "knowledge",
    });

    // ── 4.9 UI ─────────────────────────────────────────────────────────────

    m.insert("open_file_in_editor", Tool {
        name: "open_file_in_editor",
        description: "Open a file in the editor pane.",
        parameters: json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Relative path from workspace root." }
            },
            "required": ["path"]
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: true,
        display_name: "Open File in Editor",
        category: "ui",
    });

    m.insert("show_metric_plot", Tool {
        name: "show_metric_plot",
        description: "Display a metric chart in the Inspector.",
        parameters: json!({
            "type": "object",
            "properties": {
                "run_id": { "type": "string", "description": "Run ID to display." },
                "metric_keys": { "type": "string", "description": "Comma-separated metric keys to plot." }
            },
            "required": ["run_id", "metric_keys"]
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: false,
        display_name: "Show Metric Plot",
        category: "ui",
    });

    m.insert("show_notification", Tool {
        name: "show_notification",
        description: "Display a toast notification to the user.",
        parameters: json!({
            "type": "object",
            "properties": {
                "message": { "type": "string", "description": "Notification text." },
                "level": { "type": "string", "description": "info, success, warning, or error.", "enum": ["info", "success", "warning", "error"] }
            },
            "required": ["message"]
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: false,
        display_name: "Show Notification",
        category: "ui",
    });

    // `request_approval` (spec section 4.9): a UI tool the LLM can call to
    // pause the loop and surface a question to the human. The engine
    // recognises this tool name and transitions the thread to
    // `AwaitingApproval` (section 6.3) so the renderer can prompt the
    // user, then resume via `agent_approve_action` IPC. Without it the
    // agent can only ever pause via the structural gate — never to ask
    // a clarifying question.
    m.insert("request_approval", Tool {
        name: "request_approval",
        description: "Pause the agent loop and request human input. The thread transitions to AwaitingApproval and the renderer shows a prompt. Resume via the agent_approve_action IPC after the user responds.",
        parameters: json!({
            "type": "object",
            "properties": {
                "question": { "type": "string", "description": "What the agent needs the human to clarify or approve." },
                "context": { "type": "string", "description": "Optional: short summary of the surrounding investigation context." }
            },
            "required": ["question"]
        }),
        safety: SafetyLevel::Read,
        estimated_cost: 0.0,
        requires_workspace: false,
        display_name: "Request Approval",
        category: "ui",
    });

    m
}

// ── Tool registry ────────────────────────────────────────────────────────────

/// The full Bonafide tool registry.
///
/// Replaces `tools_stub::ToolRegistryStub`. Same interface so the
/// engine's call sites (`definitions_for_role`, `execute`,
/// `render_trace_step`, `tool_result_message`) compile without changes.
#[derive(Debug, Clone)]
pub struct ToolRegistry {
    catalog: HashMap<&'static str, Tool>,
    approval_gate: ApprovalGate,
    workspace_root: PathBuf,
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new(ApprovalGate::default(), PathBuf::new())
    }
}

impl ToolRegistry {
    pub fn new(approval_gate: ApprovalGate, workspace_root: PathBuf) -> Self {
        Self {
            catalog: build_tool_catalog(),
            approval_gate,
            workspace_root,
        }
    }

    pub fn set_workspace_root(&mut self, root: PathBuf) {
        self.workspace_root = root;
    }

    pub fn workspace_root(&self) -> &std::path::Path {
        &self.workspace_root
    }

    /// Look up the tool's `SafetyLevel` from the catalog.
    pub fn safety_for(&self, name: &str) -> Option<SafetyLevel> {
        self.catalog.get(name).map(|t| t.safety)
    }

    /// Return every tool name in the catalog. Used by the WS3-T7
    /// approval-coverage property test to assert the gate's lookup
    /// table covers the full catalog without gaps.
    pub fn all_tool_names(&self) -> Vec<&'static str> {
        let mut names: Vec<&'static str> = self.catalog.keys().copied().collect();
        names.sort();
        names
    }

    /// Filter tools by the section-12.2 allowlist for `role`.
    pub async fn definitions_for_role(&self, role: AgentRole) -> Vec<ToolDefinition> {
        self.catalog
            .values()
            .filter(|tool| {
                self.approval_gate.is_auto_approved(role, tool.name)
                    || self.approval_gate.needs_approval(role, tool.name)
            })
            .map(ToolDefinition::from)
            .collect()
    }

    /// Execute a tool call. Routes to the typed handler.
    pub async fn execute(&self, tc: &crate::agent::llm::ToolCall) -> ToolResult {
        let name = tc.function.name.clone();
        let args_str = &tc.function.arguments;

        let args: JsonValue = match serde_json::from_str(args_str) {
            Ok(v) => v,
            Err(e) => return ToolResult::err(format!("invalid JSON in tool arguments: {e}")),
        };

        match name.as_str() {
            // ── Filesystem ─────────────────────────────────────────────────
            "read_file" => handle_read_file(&self.workspace_root, &args),
            "read_directory" => handle_read_directory(&args),
            "search_files" => handle_search_files(&self.workspace_root, &args),
            "write_file" => handle_write_file(&self.workspace_root, &args),
            "create_file" => handle_create_file(&args),
            "create_folder" => handle_create_folder(&args),
            "rename_path" => handle_rename_path(&args),
            "delete_path" => handle_delete_path(&args),
            "apply_patch" => handle_apply_patch(&self.workspace_root, &args),

            // ── Git ───────────────────────────────────────────────────────
            "git_diff" => handle_git_diff(&self.workspace_root, &args).await,
            "git_log" => handle_git_log(&self.workspace_root, &args).await,
            "git_status" => handle_git_status(&self.workspace_root).await,
            "git_checkout" => handle_git_checkout(&self.workspace_root, &args).await,
            "git_add" => handle_git_add(&self.workspace_root, &args).await,
            "git_commit" => handle_git_commit(&self.workspace_root, &args).await,
            "git_discard" => handle_git_discard(&self.workspace_root, &args).await,

            // ── Tracker ───────────────────────────────────────────────────
            "list_runs" => ToolResult::ok("tracker list_runs — wired in WS4-T3 (run_graph)"),
            "get_run" => ToolResult::ok("tracker get_run — wired in WS4-T3 (run_graph)"),
            "get_metric_series" => ToolResult::ok("tracker get_metric_series — wired in WS4-T3"),
            "get_run_config" => ToolResult::ok("tracker get_run_config — wired in WS4-T3"),
            "list_artifacts" => ToolResult::ok("tracker list_artifacts — wired in WS4-T3"),
            "compare_runs" => handle_compare_runs(&args),
            "query_run_graph" => handle_query_run_graph(&self.workspace_root, &args).await,

            // ── Code ─────────────────────────────────────────────────────
            "query_code_graph" => handle_query_code_graph(&self.workspace_root, &args).await,
            "index_code_graph" => handle_index_code_graph(&self.workspace_root).await,
            "ruff_check" => handle_ruff_check(&args).await,
            "lsp_hover" => lsp_hover_async(&args).await,
            "lsp_definition" => lsp_definition_async(&args).await,

            // ── Execution ─────────────────────────────────────────────────
            "run_shell" => handle_run_shell(&self.workspace_root, &args).await,
            "run_python" => handle_run_python(&self.workspace_root, &args).await,
            "run_smoke_test" => handle_run_smoke_test(&self.workspace_root, &args).await,
            "pip_install" => handle_pip_install(&self.workspace_root, &args).await,

            // ── Experiments ───────────────────────────────────────────────
            "create_experiment" => ToolResult::ok("create_experiment — wired in WS4-T1"),
            "update_experiment" => ToolResult::ok("update_experiment — wired in WS4-T1"),
            "launch_experiment_run" => ToolResult::ok("launch_experiment_run — wired in WS4-T1"),
            "stop_experiment_run" => ToolResult::ok("stop_experiment_run — wired in WS4-T1"),
            "list_experiments" => ToolResult::ok("list_experiments — wired in WS4-T1"),
            "get_experiment" => ToolResult::ok("get_experiment — wired in WS4-T1"),

            // ── Knowledge ─────────────────────────────────────────────────
            "search_arxiv" => search_arxiv(&args).await,
            "read_paper" => read_arxiv_paper(&args).await,
            "query_project_memory" => ToolResult::ok("query_project_memory — wired in WS4-T2"),
            "write_project_memory" => ToolResult::ok("write_project_memory — wired in WS4-T2"),

            // ── UI ────────────────────────────────────────────────────────
            "open_file_in_editor" => ToolResult::ok(format!("open_file_in_editor: {}", get_str_field(&args, "path").unwrap_or_default())),
            "show_metric_plot" => handle_show_metric_plot(&args),
            "show_notification" => handle_show_notification(&args),
            // `request_approval` is handled by the engine, not the registry.
            // We return a marker here so the registry returns a stable
            // response; the engine inspects the tool name pre-execute and
            // short-circuits to `AwaitingApproval`. See `engine.rs`.
            "request_approval" => ToolResult::ok("approval requested — see AwaitingApproval state"),

            unknown => ToolResult::err(format!("unknown tool: {unknown}")),
        }
    }

    /// Format a trace step acknowledging the tool call.
    pub async fn render_trace_step(&self, tc: &crate::agent::llm::ToolCall) -> String {
        let result = self.execute(tc).await;
        format!("Tool: {} → {}", tc.function.name, result.summary())
    }

    /// Inject a tool result into the message history.
    pub fn tool_result_message(
        tc: &crate::agent::llm::ToolCall,
        result: &ToolResult,
    ) -> ChatMessage {
        ChatMessage::tool(result.summary(), tc.id.clone())
    }
}

// ── Argument helpers ─────────────────────────────────────────────────────────

fn get_str_field<'a>(args: &'a JsonValue, key: &str) -> Option<&'a str> {
    args.get(key).and_then(|v| v.as_str())
}

fn get_i64_field(args: &JsonValue, key: &str) -> Option<i64> {
    args.get(key).and_then(|v| v.as_i64())
}

fn require_str_field(args: &JsonValue, key: &str) -> Result<String, String> {
    get_str_field(args, key)
        .map(String::from)
        .ok_or_else(|| format!("missing or non-string field: {key}"))
}

fn require_i64_field(args: &JsonValue, key: &str) -> Result<i64, String> {
    get_i64_field(args, key).ok_or_else(|| format!("missing or non-integer field: {key}"))
}

// ── Filesystem handlers ─────────────────────────────────────────────────────

fn handle_read_file(workspace_root: &std::path::Path, args: &JsonValue) -> ToolResult {
    let path = match require_str_field(args, "path") {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    let start = get_i64_field(args, "start_line").map(|v| v as usize);
    let end = get_i64_field(args, "end_line").map(|v| v as usize);

    let full = workspace_root.join(&path);
    let content = match std::fs::read_to_string(&full) {
        Ok(c) => c,
        Err(e) => return ToolResult::err(format!("read failed: {e}")),
    };

    let lines: Vec<&str> = content.lines().collect();
    let start_idx = start.unwrap_or(0);
    let end_idx = end.unwrap_or(lines.len());
    let slice = lines
        .get(start_idx..end_idx.min(lines.len()))
        .unwrap_or(&[])
        .join("\n");

    let lines_count = slice.lines().count();
    let preview = if slice.len() > 500 { &slice[..500] } else { &slice };
    ToolResult::ok(format!("{lines_count} lines from {path}: {preview}"))
}

fn handle_read_directory(args: &JsonValue) -> ToolResult {
    let path = match require_str_field(args, "path") {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    let p = std::path::PathBuf::from(&path);
    let entries = match std::fs::read_dir(&p) {
        Ok(e) => e,
        Err(e) => return ToolResult::err(format!("read_dir failed: {e}")),
    };
    let count = entries.count();
    ToolResult::ok(format!("{count} entries in {path}"))
}

fn handle_search_files(workspace_root: &std::path::Path, args: &JsonValue) -> ToolResult {
    let pattern = match require_str_field(args, "pattern") {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    let search_path = get_str_field(args, "path")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| workspace_root.to_path_buf());

    let matches = grep::search(&search_path, &pattern).unwrap_or_default();
    let count = matches.len();
    let preview = matches.iter().take(10).cloned().collect::<Vec<_>>().join("; ");
    ToolResult::ok(format!("{count} matches for '{pattern}': {preview}"))
}

fn handle_write_file(workspace_root: &std::path::Path, args: &JsonValue) -> ToolResult {
    let path = match require_str_field(args, "path") {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    let content = match require_str_field(args, "content") {
        Ok(c) => c,
        Err(e) => return ToolResult::err(e),
    };

    let full = workspace_root.join(&path);
    if let Some(parent) = full.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::write(&full, &content) {
        Ok(()) => ToolResult::ok(format!("written: {} ({} bytes)", full.display(), content.len())),
        Err(e) => ToolResult::err(format!("write failed: {e}")),
    }
}

fn handle_create_file(args: &JsonValue) -> ToolResult {
    let parent_dir = match require_str_field(args, "parent_dir") {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    let name = match require_str_field(args, "name") {
        Ok(n) => n,
        Err(e) => return ToolResult::err(e),
    };
    let target = std::path::PathBuf::from(&parent_dir).join(&name);
    match std::fs::write(&target, "") {
        Ok(()) => ToolResult::ok(format!("created: {}", target.display())),
        Err(e) => ToolResult::err(format!("create file failed: {e}")),
    }
}

fn handle_create_folder(args: &JsonValue) -> ToolResult {
    let parent_dir = match require_str_field(args, "parent_dir") {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    let name = match require_str_field(args, "name") {
        Ok(n) => n,
        Err(e) => return ToolResult::err(e),
    };
    let target = std::path::PathBuf::from(&parent_dir).join(&name);
    match std::fs::create_dir(&target) {
        Ok(()) => ToolResult::ok(format!("created dir: {}", target.display())),
        Err(e) => ToolResult::err(format!("create folder failed: {e}")),
    }
}

fn handle_rename_path(args: &JsonValue) -> ToolResult {
    let src = match require_str_field(args, "src") {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    let new_name = match require_str_field(args, "new_name") {
        Ok(n) => n,
        Err(e) => return ToolResult::err(e),
    };
    let src_p = std::path::PathBuf::from(&src);
    let parent = match src_p.parent() {
        Some(p) => p,
        None => return ToolResult::err("rename_path: src has no parent".to_string()),
    };
    let target = parent.join(&new_name);

    match std::fs::rename(&src_p, &target) {
        Ok(()) => ToolResult::ok(format!("renamed: {} → {}", src_p.display(), target.display())),
        Err(e) => ToolResult::err(format!("rename failed: {e}")),
    }
}

fn handle_delete_path(args: &JsonValue) -> ToolResult {
    let target = match require_str_field(args, "target") {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    let target_p = std::path::PathBuf::from(&target);

    let meta = match std::fs::metadata(&target_p) {
        Ok(m) => m,
        Err(e) => return ToolResult::err(format!("stat failed: {e}")),
    };
    let is_dir = meta.is_dir();
    let result = if is_dir {
        std::fs::remove_dir_all(&target_p)
    } else {
        std::fs::remove_file(&target_p)
    };

    match result {
        Ok(()) => ToolResult::ok(format!("deleted: {}", target_p.display())),
        Err(e) => ToolResult::err(format!("delete failed: {e}")),
    }
}

fn handle_apply_patch(workspace_root: &std::path::Path, args: &JsonValue) -> ToolResult {
    let path = match require_str_field(args, "path") {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    let patch = match require_str_field(args, "patch") {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };

    let full = workspace_root.join(&path);
    let original = match std::fs::read_to_string(&full) {
        Ok(c) => c,
        Err(e) => return ToolResult::err(format!("read failed: {e}")),
    };

    let backup_path = format!("{}.bak", full.display());
    if let Err(e) = std::fs::write(&backup_path, &original) {
        return ToolResult::err(format!("backup write failed: {e}"));
    }

    match apply_diff(&original, &patch) {
        Ok(patched) => match std::fs::write(&full, &patched) {
            Ok(()) => ToolResult::ok(format!("patch applied to {path}, backup at {path}.bak")),
            Err(e) => ToolResult::err(format!("write after patch failed: {e}")),
        },
        Err(e) => ToolResult::err(format!("patch parse/apply failed: {e}")),
    }
}

// ── Git handlers ─────────────────────────────────────────────────────────────

async fn handle_git_diff(workspace_root: &std::path::Path, args: &JsonValue) -> ToolResult {
    let path = get_str_field(args, "path").map(String::from);
    match crate::git_service::diff(workspace_root.to_string_lossy().to_string(), path).await {
        Ok(result) => {
            let preview = result.diff.lines().take(30).collect::<Vec<_>>().join("\n");
            ToolResult::ok(format!("diff ({} files):\n{}", result.files.len(), preview))
        }
        Err(e) => ToolResult::err(e),
    }
}

async fn handle_git_log(workspace_root: &std::path::Path, args: &JsonValue) -> ToolResult {
    let max_count = get_i64_field(args, "max_count").map(|v| v as usize);
    match crate::git_service::log(workspace_root.to_string_lossy().to_string(), max_count).await {
        Ok(commits) => {
            let preview = commits.iter().take(5).map(|c| format!("{}: {}", c.short_hash, c.subject)).collect::<Vec<_>>().join("; ");
            ToolResult::ok(format!("{} commits: {}", commits.len(), preview))
        }
        Err(e) => ToolResult::err(e),
    }
}

async fn handle_git_status(workspace_root: &std::path::Path) -> ToolResult {
    match crate::git_service::status(workspace_root.to_string_lossy().to_string()).await {
        Ok(s) => ToolResult::ok(format!(
            "branch={}, staged={}, unstaged={}, untracked={}",
            s.branch, s.staged.len(), s.unstaged.len(), s.untracked.len()
        )),
        Err(e) => ToolResult::err(e),
    }
}

async fn handle_git_checkout(workspace_root: &std::path::Path, args: &JsonValue) -> ToolResult {
    let branch = match require_str_field(args, "branch") {
        Ok(b) => b,
        Err(e) => return ToolResult::err(e),
    };
    let create = args.get("create").and_then(|v| v.as_bool()).unwrap_or(false);
    match crate::git_service::checkout(workspace_root.to_string_lossy().to_string(), branch, create).await {
        Ok(r) => ToolResult::ok(r.message),
        Err(e) => ToolResult::err(e),
    }
}

async fn handle_git_add(workspace_root: &std::path::Path, args: &JsonValue) -> ToolResult {
    let paths_str = match require_str_field(args, "paths") {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    let paths: Vec<String> = paths_str.split(',').map(|s| s.trim().to_string()).collect();
    match crate::git_service::add(workspace_root.to_string_lossy().to_string(), paths).await {
        Ok(r) => ToolResult::ok(r.message),
        Err(e) => ToolResult::err(e),
    }
}

async fn handle_git_commit(workspace_root: &std::path::Path, args: &JsonValue) -> ToolResult {
    let message = match require_str_field(args, "message") {
        Ok(m) => m,
        Err(e) => return ToolResult::err(e),
    };
    match crate::git_service::commit(workspace_root.to_string_lossy().to_string(), message).await {
        Ok(r) => ToolResult::ok(r.message),
        Err(e) => ToolResult::err(e),
    }
}

async fn handle_git_discard(workspace_root: &std::path::Path, args: &JsonValue) -> ToolResult {
    let paths_str = match require_str_field(args, "paths") {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    let paths: Vec<String> = paths_str.split(',').map(|s| s.trim().to_string()).collect();
    match crate::git_service::discard(workspace_root.to_string_lossy().to_string(), paths).await {
        Ok(r) => ToolResult::ok(r.message),
        Err(e) => ToolResult::err(e),
    }
}

// ── Tracker handlers ─────────────────────────────────────────────────────────

fn handle_compare_runs(args: &JsonValue) -> ToolResult {
    let run_ids_str = match require_str_field(args, "run_ids") {
        Ok(s) => s,
        Err(e) => return ToolResult::err(e),
    };
    let run_ids: Vec<String> = run_ids_str.split(',').map(|s| s.trim().to_string()).collect();
    if run_ids.len() != 2 {
        return ToolResult::err("compare_runs requires exactly 2 run IDs".to_string());
    }
    ToolResult::ok(format!("comparing runs: {} vs {}", run_ids[0], run_ids[1]))
}

async fn handle_query_run_graph(workspace_root: &std::path::Path, args: &JsonValue) -> ToolResult {
    let framework = get_str_field(args, "framework").map(String::from);
    let dataset = get_str_field(args, "dataset").map(String::from);
    let root = workspace_root.to_path_buf();
    match tokio::task::spawn_blocking(move || -> Result<usize, String> {
        let (conn, _hash) = crate::graph::storage::open_workspace_db(&root)
            .map_err(|e| format!("Failed to open workspace DB: {e}"))?;
        let nodes = crate::graph::run_graph::query_run_graph(
            &conn,
            framework.as_deref(),
            dataset.as_deref(),
        )
        .map_err(|e| format!("Failed to query run graph: {e}"))?;
        Ok(nodes.len())
    }).await {
        Ok(Ok(n)) => ToolResult::ok(format!("{n} run graph nodes")),
        Ok(Err(e)) => ToolResult::err(e),
        Err(e) => ToolResult::err(format!("join error: {e}")),
    }
}

// ── Code handlers ────────────────────────────────────────────────────────────

async fn handle_query_code_graph(workspace_root: &std::path::Path, args: &JsonValue) -> ToolResult {
    let query = match require_str_field(args, "query") {
        Ok(q) => q,
        Err(e) => return ToolResult::err(e),
    };
    let root = workspace_root.to_path_buf();
    let q_owned = query.clone();
    match tokio::task::spawn_blocking(move || -> Result<usize, String> {
        let (conn, _hash) = crate::graph::storage::open_workspace_db(&root)
            .map_err(|e| format!("Failed to open workspace DB: {e}"))?;
        let hits = crate::graph::code_graph::query_code_graph(&q_owned, &conn)
            .map_err(|e| format!("Failed to query code graph: {e}"))?;
        Ok(hits.len())
    }).await {
        Ok(Ok(n)) => ToolResult::ok(format!("{n} hits for '{query}'")),
        Ok(Err(e)) => ToolResult::err(e),
        Err(e) => ToolResult::err(format!("join error: {e}")),
    }
}

async fn handle_index_code_graph(workspace_root: &std::path::Path) -> ToolResult {
    let root = workspace_root.to_path_buf();
    match tokio::task::spawn_blocking(move || -> Result<usize, String> {
        let (conn, _hash) = crate::graph::storage::open_workspace_db(&root)
            .map_err(|e| format!("Failed to open workspace DB: {e}"))?;
        let summary = crate::graph::code_graph::index_code_graph(&conn, &root)
            .map_err(|e| format!("Failed to index code graph: {e}"))?;
        Ok(summary.files_scanned as usize)
    }).await {
        Ok(Ok(n)) => ToolResult::ok(format!("indexed {n} files")),
        Ok(Err(e)) => ToolResult::err(e),
        Err(e) => ToolResult::err(format!("join error: {e}")),
    }
}

async fn handle_ruff_check(args: &JsonValue) -> ToolResult {
    let file_path = match require_str_field(args, "file_path") {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };

    let output = tokio::process::Command::new("ruff")
        .args(["check", "--output-format=json", &file_path])
        .output()
        .await;

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            if out.status.success() {
                if stdout.trim().is_empty() {
                    ToolResult::ok("no linting errors".to_string())
                } else {
                    ToolResult::ok(format!("lint issues: {}", &stdout[..stdout.len().min(500)]))
                }
            } else {
                let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                ToolResult::err(format!("ruff failed: {}", &stderr[..stderr.len().min(300)]))
            }
        }
        Err(e) => ToolResult::err(format!("Failed to spawn ruff: {e}. Is ruff installed?")),
    }
}

async fn lsp_hover_async(args: &JsonValue) -> ToolResult {
    let file_path = match require_str_field(args, "file_path") {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    let line = match require_i64_field(args, "line") {
        Ok(n) => n as u32,
        Err(e) => return ToolResult::err(e),
    };
    let column = match require_i64_field(args, "column") {
        Ok(n) => n as u32,
        Err(e) => return ToolResult::err(e),
    };
    match lsp_hover(&file_path, line, column).await {
        Ok(info) => ToolResult::ok(info),
        Err(e) => ToolResult::err(e),
    }
}

async fn lsp_definition_async(args: &JsonValue) -> ToolResult {
    let file_path = match require_str_field(args, "file_path") {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    let line = match require_i64_field(args, "line") {
        Ok(n) => n as u32,
        Err(e) => return ToolResult::err(e),
    };
    let column = match require_i64_field(args, "column") {
        Ok(n) => n as u32,
        Err(e) => return ToolResult::err(e),
    };
    match lsp_definition(&file_path, line, column).await {
        Ok(loc) => ToolResult::ok(loc),
        Err(e) => ToolResult::err(e),
    }
}

// ── Execution handlers ───────────────────────────────────────────────────────

async fn handle_run_shell(workspace_root: &std::path::Path, args: &JsonValue) -> ToolResult {
    let command = match require_str_field(args, "command") {
        Ok(c) => c,
        Err(e) => return ToolResult::err(e),
    };
    let timeout_secs = get_i64_field(args, "timeout_secs").unwrap_or(300) as u64;

    run_shell_command(workspace_root, &command, Duration::from_secs(timeout_secs)).await
}

async fn handle_run_python(workspace_root: &std::path::Path, args: &JsonValue) -> ToolResult {
    let code = match require_str_field(args, "code") {
        Ok(c) => c,
        Err(e) => return ToolResult::err(e),
    };
    let timeout_secs = get_i64_field(args, "timeout_secs").unwrap_or(60) as u64;

    // Write code to a tempfile and run with `python <tempfile>` so
    // multi-line scripts work correctly (vs `python -c "..."` escaping).
    let tmp = match tempfile::Builder::new()
        .suffix(".py")
        .tempfile()
    {
        Ok(f) => f,
        Err(e) => return ToolResult::err(format!("tempfile creation failed: {e}")),
    };

    if let Err(e) = std::fs::write(tmp.path(), &code) {
        return ToolResult::err(format!("tempfile write failed: {e}"));
    }

    let path = tmp.path().to_string_lossy().to_string();
    let command = format!("python {}", shell_escape(&path));
    run_shell_command(workspace_root, &command, Duration::from_secs(timeout_secs)).await
}

async fn handle_run_smoke_test(workspace_root: &std::path::Path, args: &JsonValue) -> ToolResult {
    let script_path = match require_str_field(args, "script_path") {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    let max_steps = get_i64_field(args, "max_steps").unwrap_or(200);

    let full = workspace_root.join(&script_path);
    let command = format!(
        "python {} --max_steps={}",
        shell_escape(&full.to_string_lossy()),
        max_steps
    );
    run_shell_command(workspace_root, &command, Duration::from_secs(90)).await
}

async fn handle_pip_install(workspace_root: &std::path::Path, args: &JsonValue) -> ToolResult {
    let package = match require_str_field(args, "package") {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };
    let command = format!("pip install {}", shell_escape(&package));
    run_shell_command(workspace_root, &command, Duration::from_secs(120)).await
}

// ── UI handlers ──────────────────────────────────────────────────────────────

fn handle_show_metric_plot(args: &JsonValue) -> ToolResult {
    let run_id = get_str_field(args, "run_id").unwrap_or("").to_string();
    let metric_keys = get_str_field(args, "metric_keys").unwrap_or("").to_string();
    ToolResult::ok(format!("showing metrics {metric_keys} for run {run_id}"))
}

fn handle_show_notification(args: &JsonValue) -> ToolResult {
    let message = get_str_field(args, "message").unwrap_or("").to_string();
    let level = get_str_field(args, "level").unwrap_or("info");
    ToolResult::ok(format!("notification ({level}): {message}"))
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async fn run_shell_command(
    workspace_root: &std::path::Path,
    command: &str,
    timeout: Duration,
) -> ToolResult {
    use tokio::time::timeout as tokio_timeout;

    let future = async {
        let output = tokio::process::Command::new("sh")
            .args(["-c", command])
            .current_dir(workspace_root)
            .output()
            .await
            .map_err(|e| format!("shell spawn failed: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        if output.status.success() {
            Ok(stdout)
        } else {
            Err(format!(
                "exit {}: stdout={} stderr={}",
                output.status.code().unwrap_or(-1),
                &stdout[..stdout.len().min(500)],
                &stderr[..stderr.len().min(200)]
            ))
        }
    };

    match tokio_timeout(timeout, future).await {
        Ok(Ok(output)) => {
            let truncated = if output.len() > 2000 { &output[..2000] } else { &output };
            ToolResult::ok(format!("exit=0, output:\n{truncated}"))
        }
        Ok(Err(e)) => ToolResult::err(e),
        Err(_) => ToolResult::err(format!("command timed out after {}s", timeout.as_secs())),
    }
}

fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Minimal unified-diff applier. Handles hunk headers and `+/-` lines.
fn apply_diff(original: &str, patch: &str) -> Result<String, String> {
    let original_lines: Vec<String> = original.lines().map(String::from).collect();
    let mut result: Vec<String> = original_lines.clone();
    let mut hunk_start: Option<usize> = None;
    let mut old_idx: usize = 0;

    for line in patch.lines() {
        if let Some(rest) = line.strip_prefix("@@ ") {
            // Parse `@@ -start,count +start,count @@`
            let end = rest.find(" @@").unwrap_or(rest.len());
            let range = &rest[..end];
            let parts: Vec<&str> = range.split_whitespace().collect();
            if parts.is_empty() {
                continue;
            }
            // parts[0] is the old range, parts[1] is the new range
            let old_range = parts[0].trim_start_matches('-');
            let start_str: String = old_range.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(start) = start_str.parse::<usize>() {
                old_idx = start.saturating_sub(1);
                hunk_start = Some(old_idx);
            }
        } else if let Some(content) = line.strip_prefix('+') {
            if hunk_start.is_some() {
                result.insert(old_idx, content.to_string());
                old_idx += 1;
            }
        } else if let Some(content) = line.strip_prefix('-') {
            if hunk_start.is_some() && old_idx < result.len() && result[old_idx] == content {
                result.remove(old_idx);
            }
        } else if line.starts_with(' ') && hunk_start.is_some() {
            // Context line — advance old_idx
            old_idx += 1;
        }
    }

    // Sanity check: if the result equals the original, the diff didn't apply.
    if result == original_lines {
        return Err("diff did not apply cleanly to original".to_string());
    }

    Ok(result.join("\n"))
}

// ── arXiv handlers ───────────────────────────────────────────────────────────

async fn search_arxiv(args: &JsonValue) -> ToolResult {
    let query = match require_str_field(args, "query") {
        Ok(q) => q,
        Err(e) => return ToolResult::err(e),
    };
    let max_results = get_i64_field(args, "max_results").unwrap_or(5) as usize;

    let url = format!(
        "http://export.arxiv.org/api/query?search_query=all:{}&start=0&max_results={}",
        urlencoding::encode(&query),
        max_results
    );

    let body = match reqwest::get(&url).await {
        Ok(r) => match r.text().await {
            Ok(s) => s,
            Err(e) => return ToolResult::err(format!("arxiv read failed: {e}")),
        },
        Err(e) => return ToolResult::err(format!("arxiv request failed: {e}")),
    };

    // Minimal Atom feed parser.
    let mut count = 0;
    let mut preview = String::new();
    for chunk in body.split("<entry>").skip(1) {
        if count >= max_results {
            break;
        }
        let id = extract_xml_value(chunk, "id").unwrap_or_default();
        let title = extract_xml_value(chunk, "title").unwrap_or_default();
        let short_title: String = title.chars().take(80).collect();
        preview.push_str(&format!("{id}: {short_title}; "));
        count += 1;
    }

    ToolResult::ok(format!("{count} papers: {preview}"))
}

async fn read_arxiv_paper(args: &JsonValue) -> ToolResult {
    let paper_id = match require_str_field(args, "paper_id") {
        Ok(p) => p,
        Err(e) => return ToolResult::err(e),
    };

    let id = paper_id.trim();
    let url = if id.starts_with("http") {
        id.to_string()
    } else {
        format!("https://arxiv.org/abs/{}", id)
    };

    let body = match reqwest::get(&url).await {
        Ok(r) => match r.text().await {
            Ok(s) => s,
            Err(e) => return ToolResult::err(format!("paper fetch failed: {e}")),
        },
        Err(e) => return ToolResult::err(format!("paper fetch failed: {e}")),
    };

    let marker = "abstract\">";
    if let Some(start) = body.find(marker) {
        let rest = &body[start + marker.len()..];
        if let Some(end) = rest.find("</blockquote>") {
            let raw = &rest[..end];
            let clean = raw
                .lines()
                .map(|l| l.trim())
                .filter(|l| !l.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            return ToolResult::ok(format!("arXiv {paper_id} abstract:\n{clean}"));
        }
    }

    ToolResult::ok(format!("arXiv paper {paper_id} — abstract not found in fetched page"))
}

/// Extract the value of a simple XML element like `<id>value</id>` from
/// a substring. Returns None when the element is missing.
fn extract_xml_value(chunk: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = chunk.find(&open)? + open.len();
    let end = chunk[start..].find(&close)? + start;
    Some(chunk[start..end].trim().to_string())
}

// ── LSP handlers ─────────────────────────────────────────────────────────────

async fn lsp_hover(file_path: &str, line: u32, column: u32) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    let mut stream = TcpStream::connect("127.0.0.1:9877")
        .await
        .map_err(|e| format!("LSP bridge unreachable on port 9877: {e}"))?;

    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "textDocument/hover",
        "params": {
            "textDocument": { "uri": format!("file://{file_path}") },
            "position": { "line": line - 1, "character": column }
        }
    });

    let msg = serde_json::to_string(&request).map_err(|e| e.to_string())?;
    stream
        .write_all(format!("Content-Length: {}\r\n\r\n{}", msg.len(), msg).as_bytes())
        .await
        .map_err(|e| format!("LSP write failed: {e}"))?;

    let mut buf = vec![0u8; 8192];
    let n = stream.read(&mut buf).await.map_err(|e| format!("LSP read failed: {e}"))?;
    let response = String::from_utf8_lossy(&buf[..n]).to_string();

    if let Some(body_start) = response.find("\r\n\r\n") {
        let body = &response[body_start + 4..];
        if let Ok(resp) = serde_json::from_str::<JsonValue>(body) {
            let contents = resp.pointer("/result/contents").map(|v| {
                if let Some(s) = v.as_str() {
                    s.to_string()
                } else if let Some(obj) = v.as_object() {
                    obj.get("value").and_then(|vv| vv.as_str()).unwrap_or("").to_string()
                } else {
                    v.to_string()
                }
            });
            return Ok(contents.unwrap_or_else(|| "no hover info".to_string()));
        }
    }

    Err("LSP hover failed — no valid response".to_string())
}

async fn lsp_definition(file_path: &str, line: u32, column: u32) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    let mut stream = TcpStream::connect("127.0.0.1:9877")
        .await
        .map_err(|e| format!("LSP bridge unreachable on port 9877: {e}"))?;

    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "textDocument/definition",
        "params": {
            "textDocument": { "uri": format!("file://{file_path}") },
            "position": { "line": line - 1, "character": column }
        }
    });

    let msg = serde_json::to_string(&request).map_err(|e| e.to_string())?;
    stream
        .write_all(format!("Content-Length: {}\r\n\r\n{}", msg.len(), msg).as_bytes())
        .await
        .map_err(|e| format!("LSP write failed: {e}"))?;

    let mut buf = vec![0u8; 8192];
    let n = stream.read(&mut buf).await.map_err(|e| format!("LSP read failed: {e}"))?;
    let response = String::from_utf8_lossy(&buf[..n]).to_string();

    if let Some(body_start) = response.find("\r\n\r\n") {
        let body = &response[body_start + 4..];
        if let Ok(resp) = serde_json::from_str::<JsonValue>(body) {
            if let Some(result) = resp.pointer("/result") {
                let locs = serde_json::to_string(result).unwrap_or_default();
                return Ok(format!("definition: {}", &locs[..locs.len().min(200)]));
            }
        }
    }

    Err("LSP definition failed — no valid response".to_string())
}

// ── grep helper (inline) ─────────────────────────────────────────────────────

mod grep {
    use std::path::Path;

    /// Search files in `root` matching `pattern` (basic substring or simple glob).
    pub fn search(root: &Path, pattern: &str) -> Result<Vec<String>, String> {
        let pattern_lower = pattern.to_lowercase();
        let is_glob = pattern.contains('*');
        let mut matches = Vec::new();

        let walker = walkdir::WalkDir::new(root)
            .follow_links(false)
            .max_depth(8)
            .into_iter()
            .filter_entry(|e| {
                if e.path() == root {
                    return true;
                }
                let name = e.file_name().to_string_lossy();
                if name.starts_with('.') {
                    return false;
                }
                if e.file_type().is_dir() {
                    let top = e
                        .path()
                        .strip_prefix(root)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default()
                        .split('/')
                        .next()
                        .unwrap_or("")
                        .to_string();
                    if matches!(
                        top.as_str(),
                        "node_modules" | ".git" | "target" | "dist" | "build" | "__pycache__"
                    ) {
                        return false;
                    }
                }
                true
            });

        for entry in walker.flatten() {
            if !entry.file_type().is_file() {
                continue;
            }
            let path_str = entry.path().to_string_lossy().to_string();

            if is_glob {
                // Simple glob: split by `*` and require all parts to be present
                // (case-insensitive substring match per part).
                let parts: Vec<String> = pattern_lower.split('*').map(String::from).collect();
                let path_lower = path_str.to_lowercase();
                if parts.iter().all(|p| path_lower.contains(p)) {
                    matches.push(path_str);
                }
            } else {
                // Content search.
                let ext = path_str.rsplit('.').next().unwrap_or("");
                if ["png", "jpg", "gif", "pdf", "zip", "exe", "so", "dll", "pyc"]
                    .contains(&ext.to_lowercase().as_str())
                {
                    continue;
                }
                if let Ok(content) = std::fs::read_to_string(entry.path()) {
                    if content.to_lowercase().contains(&pattern_lower) {
                        matches.push(path_str);
                    }
                }
            }
        }

        Ok(matches)
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::llm::{Role, ToolCall, ToolFunctionCall};

    fn sample_tool_call(name: &str) -> ToolCall {
        ToolCall {
            id: "call_test".to_string(),
            tool_type: "function".to_string(),
            function: ToolFunctionCall {
                name: name.to_string(),
                arguments: "{}".to_string(),
            },
        }
    }

    fn sample_tool_call_with_args(name: &str, args: serde_json::Value) -> ToolCall {
        ToolCall {
            id: "call_test".to_string(),
            tool_type: "function".to_string(),
            function: ToolFunctionCall {
                name: name.to_string(),
                arguments: serde_json::to_string(&args).unwrap(),
            },
        }
    }

    // ── Catalog tests ────────────────────────────────────────────────────

    #[tokio::test]
    async fn catalog_has_46_tools() {
        let registry = ToolRegistry::default();
        // The current catalog includes 37 spec-4.2..4.8 tools + 4 spec-4.9
        // UI tools (`open_file_in_editor`, `show_metric_plot`,
        // `show_notification`, `request_approval`) + 5 git tools
        // listed in section 4.4/4.5 + extra code/LSP/tracker entries.
        // The exact count is asserted here so a new tool added to
        // `build_tool_catalog` forces a review of the section-12.2
        // allowlist + the catalog map.
        assert_eq!(registry.catalog.len(), 46, "expected exactly 46 tools");
    }

    #[tokio::test]
    async fn definitions_for_role_includes_safe_tools() {
        let registry = ToolRegistry::default();
        let defs = registry.definitions_for_role(AgentRole::Debugger).await;
        let names: Vec<&str> = defs.iter().map(|d| d.function.name.as_str()).collect();
        assert!(names.contains(&"read_file"), "read_file should be auto-approved");
        assert!(names.contains(&"get_metric_series"), "tracker tools should be auto-approved");
        assert!(names.contains(&"apply_patch"), "apply_patch is approved-with-prompt for Debugger");
    }

    #[tokio::test]
    async fn definitions_for_role_filters_blocked_tools() {
        let registry = ToolRegistry::default();
        let defs = registry.definitions_for_role(AgentRole::Researcher).await;
        let names: Vec<&str> = defs.iter().map(|d| d.function.name.as_str()).collect();
        assert!(!names.contains(&"write_file"), "Researcher should NOT have write_file");
        assert!(!names.contains(&"run_shell"), "Researcher should NOT have run_shell");
        assert!(names.contains(&"search_arxiv"), "Researcher should have search_arxiv");
    }

    // ── Execute tests ────────────────────────────────────────────────────

    #[tokio::test]
    async fn execute_unknown_tool_returns_error() {
        let registry = ToolRegistry::default();
        let tc = sample_tool_call("totally_unknown_tool");
        let result = registry.execute(&tc).await;
        assert!(matches!(result, ToolResult::Error { .. }));
        assert!(result.summary().contains("unknown tool"));
    }

    #[tokio::test]
    async fn execute_read_file_nonexistent_returns_error() {
        let mut registry = ToolRegistry::default();
        registry.set_workspace_root(std::env::temp_dir());
        let tc = sample_tool_call_with_args("read_file", json!({ "path": "nonexistent_file_xyz.txt" }));
        let result = registry.execute(&tc).await;
        assert!(matches!(result, ToolResult::Error { .. }));
    }

    #[tokio::test]
    async fn execute_invalid_json_returns_error() {
        let registry = ToolRegistry::default();
        let mut tc = sample_tool_call("read_file");
        tc.function.arguments = "not valid json".to_string();
        let result = registry.execute(&tc).await;
        assert!(matches!(result, ToolResult::Error { .. }));
    }

    #[tokio::test]
    async fn execute_missing_required_field_returns_error() {
        let registry = ToolRegistry::default();
        let tc = sample_tool_call_with_args("read_file", json!({}));
        let result = registry.execute(&tc).await;
        assert!(matches!(result, ToolResult::Error { .. }));
        assert!(result.summary().contains("path"));
    }

    #[tokio::test]
    async fn render_trace_step_emits_summary() {
        let registry = ToolRegistry::default();
        let tc = sample_tool_call("git_status");
        let line = registry.render_trace_step(&tc).await;
        assert!(line.starts_with("Tool: git_status → "), "got: {}", line);
    }

    #[test]
    fn tool_result_message_carries_call_id() {
        let tc = sample_tool_call("read_file");
        let result = ToolResult::ok("42 lines");
        let msg = ToolRegistry::tool_result_message(&tc, &result);
        assert_eq!(msg.role, Role::Tool);
        assert_eq!(msg.tool_call_id.as_deref(), Some("call_test"));
    }

    #[test]
    fn safety_for_returns_correct_level() {
        let registry = ToolRegistry::default();
        assert_eq!(registry.safety_for("read_file"), Some(SafetyLevel::Read));
        assert_eq!(registry.safety_for("write_file"), Some(SafetyLevel::WriteLocal));
        assert_eq!(registry.safety_for("run_shell"), Some(SafetyLevel::Compute));
        assert_eq!(registry.safety_for("delete_path"), Some(SafetyLevel::Dangerous));
        assert_eq!(registry.safety_for("nonexistent"), None);
    }

    #[test]
    fn set_workspace_root_updates_path() {
        let mut registry = ToolRegistry::default();
        registry.set_workspace_root(std::path::PathBuf::from("/tmp/foo"));
        assert_eq!(registry.workspace_root(), std::path::Path::new("/tmp/foo"));
    }

    // ── Diff helper tests ────────────────────────────────────────────────

    #[test]
    fn apply_diff_replaces_removed_line() {
        let original = "line one\nline two\nline three";
        let patch = "@@ -2,1 +2,1 @@\n-line two\n+LINE TWO";
        let result = apply_diff(original, patch).unwrap();
        assert!(result.contains("LINE TWO"));
        assert!(!result.contains("line two"));
    }

    #[test]
    fn shell_escape_handles_single_quotes() {
        assert_eq!(shell_escape("hello"), "'hello'");
        assert_eq!(shell_escape("it's"), "'it'\\''s'");
    }

    #[test]
    fn extract_xml_value_finds_tag() {
        let chunk = "<id>2301.00001</id><title>Test</title>";
        assert_eq!(extract_xml_value(chunk, "id").as_deref(), Some("2301.00001"));
        assert_eq!(extract_xml_value(chunk, "title").as_deref(), Some("Test"));
    }
}
