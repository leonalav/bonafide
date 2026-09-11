/**
 * agent/tools.ts — Frontend tool definitions for Bonafide agent.
 *
 * Mirrors the Rust tool catalog in `src-tauri/src/agent/tools.rs`.
 * Every tool definition here must match the Rust side exactly — field
 * names, types, and safety levels are part of the wire contract with the
 * LLM model.
 *
 * These definitions are consumed by:
 * - `src/llm/client.ts` → injected as `ChatRequest.tools`
 * - `src/llm/systemPrompt.ts` → Layer 4 tool list
 * - The UI → render tool call traces, approval dialogs
 *
 * ## Safety levels (section 4.1)
 *
 * - `read`: No side effects. Agent can call freely.
 * - `write_local`: Modifies files in workspace. Logged, reversible.
 * - `write_remote`: Modifies remote state (tracker, git). Logged, harder to reverse.
 * - `compute`: Triggers GPU/CPU compute. Budget-gated, requires approval.
 * - `dangerous`: Irreversible destructive actions. Always requires approval.
 */

import type { ToolDefinition as LlmToolDefinition } from "../llm/types"

// ── Safety level ─────────────────────────────────────────────────────────────

export type SafetyLevel = "read" | "write_local" | "write_remote" | "compute" | "dangerous"

// ── Agent tool definition ────────────────────────────────────────────────────

/**
 * A tool definition with Bonafide-specific metadata.
 * The `type` + `function` fields match the OpenAI `function` call schema
 * and are passed directly to the LLM as `ChatRequest.tools`.
 */
export interface AgentToolDefinition {
  type: "function"
  function: {
    name: string
    description: string
    parameters: {
      type: "object"
      properties: Record<string, {
        type: string
        description?: string
        default?: unknown
        enum?: string[]
      }>
      required?: string[]
    }
  }
  /** Safety classification — drives the approval gate (section 12.1). */
  safety: SafetyLevel
  /** Estimated cost in dollars. 0 for read-only. */
  estimatedCost: number
  /** Whether this tool requires the workspace to be open. */
  requiresWorkspace: boolean
  /** Max calls per minute. */
  rateLimit: number
  /** Human-readable name for UI display. */
  displayName: string
  /** Category for grouping in tool documentation. */
  category: "filesystem" | "tracker" | "code" | "git" | "execution" | "experiment" | "knowledge" | "ui"
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Strip agent metadata and return a plain LLM ToolDefinition. */
export function toLlmToolDefinition(def: AgentToolDefinition): LlmToolDefinition {
  return {
    type: "function",
    function: {
      name: def.function.name,
      description: def.function.description,
      parameters: def.function.parameters,
    },
  }
}

// ── All 37 tools (sections 4.2–4.9) ────────────────────────────────────────

// ── 4.2 File System Tools ──────────────────────────────────────────────────

export const READ_FILE: AgentToolDefinition = {
  type: "function",
  function: {
    name: "read_file",
    description:
      "Read the contents of a file in the workspace. Returns the full text or a specified line range.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative path from workspace root, e.g. 'src/train.py'",
        },
        start_line: {
          type: "number",
          description:
            "Optional: start line (1-indexed). If omitted, reads from the beginning.",
        },
        end_line: {
          type: "number",
          description:
            "Optional: end line (1-indexed, inclusive). If omitted, reads to end of file.",
        },
      },
      required: ["path"],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 60,
  displayName: "Read File",
  category: "filesystem",
}

export const READ_DIRECTORY: AgentToolDefinition = {
  type: "function",
  function: {
    name: "read_directory",
    description: "List directory contents with file types. Returns a tree of folders and files.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path of the directory to list.",
        },
      },
      required: ["path"],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 30,
  displayName: "Read Directory",
  category: "filesystem",
}

export const SEARCH_FILES: AgentToolDefinition = {
  type: "function",
  function: {
    name: "search_files",
    description:
      "Search for files matching a glob pattern or content regex across the workspace.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Glob pattern (e.g. '**/*.py') or regex (e.g. 'def train') to match.",
        },
        path: {
          type: "string",
          description:
            "Optional: root path to search within. Defaults to workspace root.",
        },
      },
      required: ["pattern"],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 30,
  displayName: "Search Files",
  category: "filesystem",
}

export const WRITE_FILE: AgentToolDefinition = {
  type: "function",
  function: {
    name: "write_file",
    description: "Write file contents (create or overwrite). Use with caution — prefer apply_patch for modifications.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path from workspace root.",
        },
        content: {
          type: "string",
          description: "Full file contents to write.",
        },
      },
      required: ["path", "content"],
    },
  },
  safety: "write_local",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 20,
  displayName: "Write File",
  category: "filesystem",
}

export const CREATE_FILE: AgentToolDefinition = {
  type: "function",
  function: {
    name: "create_file",
    description: "Create an empty file in the specified parent directory.",
    parameters: {
      type: "object",
      properties: {
        parent_dir: {
          type: "string",
          description: "Absolute path of the parent directory.",
        },
        name: {
          type: "string",
          description: "Name of the file to create.",
        },
      },
      required: ["parent_dir", "name"],
    },
  },
  safety: "write_local",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 20,
  displayName: "Create File",
  category: "filesystem",
}

export const CREATE_FOLDER: AgentToolDefinition = {
  type: "function",
  function: {
    name: "create_folder",
    description: "Create a directory.",
    parameters: {
      type: "object",
      properties: {
        parent_dir: {
          type: "string",
          description: "Absolute path of the parent directory.",
        },
        name: {
          type: "string",
          description: "Name of the directory to create.",
        },
      },
      required: ["parent_dir", "name"],
    },
  },
  safety: "write_local",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 20,
  displayName: "Create Folder",
  category: "filesystem",
}

export const RENAME_PATH: AgentToolDefinition = {
  type: "function",
  function: {
    name: "rename_path",
    description: "Rename a file or folder.",
    parameters: {
      type: "object",
      properties: {
        src: {
          type: "string",
          description: "Current absolute path.",
        },
        new_name: {
          type: "string",
          description: "New name (not full path — just the name).",
        },
      },
      required: ["src", "new_name"],
    },
  },
  safety: "write_local",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 20,
  displayName: "Rename Path",
  category: "filesystem",
}

export const DELETE_PATH: AgentToolDefinition = {
  type: "function",
  function: {
    name: "delete_path",
    description: "Delete a file or folder. IRREVERSIBLE — always requires approval.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Absolute path to delete.",
        },
      },
      required: ["target"],
    },
  },
  safety: "dangerous",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 5,
  displayName: "Delete Path",
  category: "filesystem",
}

export const APPLY_PATCH: AgentToolDefinition = {
  type: "function",
  function: {
    name: "apply_patch",
    description:
      "Apply a unified diff to a file. Creates a .bak backup before writing. Use for modifying existing code.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path from workspace root.",
        },
        patch: {
          type: "string",
          description: "Unified diff string (---/+++ format).",
        },
      },
      required: ["path", "patch"],
    },
  },
  safety: "write_local",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 20,
  displayName: "Apply Patch",
  category: "filesystem",
}

// ── 4.3 Tracker Tools ───────────────────────────────────────────────────────

export const LIST_RUNS: AgentToolDefinition = {
  type: "function",
  function: {
    name: "list_runs",
    description: "List runs for the current tracker project. Paginated.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "Tracker kind: 'wandb' or 'mlflow'.",
          enum: ["wandb", "mlflow"],
        },
        project: {
          type: "string",
          description: "Project name (for W&B) or experiment name (for MLflow).",
        },
        limit: {
          type: "number",
          description: "Max number of runs to return (default 50).",
          default: 50,
        },
        cursor: {
          type: "string",
          description: "Pagination cursor from the previous response.",
        },
      },
      required: ["kind", "project"],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: false,
  rateLimit: 30,
  displayName: "List Runs",
  category: "tracker",
}

export const GET_RUN: AgentToolDefinition = {
  type: "function",
  function: {
    name: "get_run",
    description: "Full detail for a single run: config, summary metrics, tags.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "Tracker kind: 'wandb' or 'mlflow'.",
          enum: ["wandb", "mlflow"],
        },
        run_id: {
          type: "string",
          description: "Run ID.",
        },
      },
      required: ["kind", "run_id"],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: false,
  rateLimit: 60,
  displayName: "Get Run",
  category: "tracker",
}

export const GET_METRIC_SERIES: AgentToolDefinition = {
  type: "function",
  function: {
    name: "get_metric_series",
    description: "Time-series values for one metric across training steps.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "Tracker kind: 'wandb' or 'mlflow'.",
          enum: ["wandb", "mlflow"],
        },
        run_id: {
          type: "string",
          description: "Run ID.",
        },
        key: {
          type: "string",
          description: "Metric key, e.g. 'val_loss' or 'train/accuracy'.",
        },
      },
      required: ["kind", "run_id", "key"],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: false,
  rateLimit: 60,
  displayName: "Get Metric Series",
  category: "tracker",
}

export const GET_RUN_CONFIG: AgentToolDefinition = {
  type: "function",
  function: {
    name: "get_run_config",
    description: "Full config dict for a run.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "Tracker kind: 'wandb' or 'mlflow'.",
          enum: ["wandb", "mlflow"],
        },
        run_id: {
          type: "string",
          description: "Run ID.",
        },
      },
      required: ["kind", "run_id"],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: false,
  rateLimit: 60,
  displayName: "Get Run Config",
  category: "tracker",
}

export const LIST_ARTIFACTS: AgentToolDefinition = {
  type: "function",
  function: {
    name: "list_artifacts",
    description: "List logged artifacts (model weights, datasets) for a run.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "Tracker kind: 'wandb' or 'mlflow'.",
          enum: ["wandb", "mlflow"],
        },
        run_id: {
          type: "string",
          description: "Run ID.",
        },
      },
      required: ["kind", "run_id"],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: false,
  rateLimit: 30,
  displayName: "List Artifacts",
  category: "tracker",
}

export const COMPARE_RUNS: AgentToolDefinition = {
  type: "function",
  function: {
    name: "compare_runs",
    description: "Side-by-side diff of two runs' configs and summary metrics.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "Tracker kind: 'wandb' or 'mlflow'.",
          enum: ["wandb", "mlflow"],
        },
        run_ids: {
          type: "string",
          description: "Comma-separated list of two run IDs to compare.",
        },
      },
      required: ["kind", "run_ids"],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: false,
  rateLimit: 30,
  displayName: "Compare Runs",
  category: "tracker",
}

export const QUERY_RUN_GRAPH: AgentToolDefinition = {
  type: "function",
  function: {
    name: "query_run_graph",
    description: "Cross-run relationships (framework × dataset × GPU).",
    parameters: {
      type: "object",
      properties: {
        framework: {
          type: "string",
          description: "Optional: filter by framework, e.g. 'pytorch'.",
        },
        dataset: {
          type: "string",
          description: "Optional: filter by dataset, e.g. 'cifar10'.",
        },
      },
      required: [],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: false,
  rateLimit: 30,
  displayName: "Query Run Graph",
  category: "tracker",
}

// ── 4.4 Code Intelligence Tools ──────────────────────────────────────────────

export const QUERY_CODE_GRAPH: AgentToolDefinition = {
  type: "function",
  function: {
    name: "query_code_graph",
    description: "Find functions and classes by name in the indexed Python codebase.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Symbol name to search, e.g. 'train_step' or 'ResNet'.",
        },
      },
      required: ["query"],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 60,
  displayName: "Query Code Graph",
  category: "code",
}

export const INDEX_CODE_GRAPH: AgentToolDefinition = {
  type: "function",
  function: {
    name: "index_code_graph",
    description: "Re-index Python files after code changes. Use after writing or modifying files.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 5,
  displayName: "Index Code Graph",
  category: "code",
}

export const RUFF_CHECK: AgentToolDefinition = {
  type: "function",
  function: {
    name: "ruff_check",
    description: "Run ruff linter on a file. Returns JSON diagnostics.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Absolute path to the Python file.",
        },
      },
      required: ["file_path"],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 30,
  displayName: "Ruff Check",
  category: "code",
}

export const LSP_HOVER: AgentToolDefinition = {
  type: "function",
  function: {
    name: "lsp_hover",
    description: "Get type information for a symbol via the LSP.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Absolute path of the file.",
        },
        line: {
          type: "number",
          description: "1-indexed line number.",
        },
        column: {
          type: "number",
          description: "0-indexed column number.",
        },
      },
      required: ["file_path", "line", "column"],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 60,
  displayName: "LSP Hover",
  category: "code",
}

export const LSP_DEFINITION: AgentToolDefinition = {
  type: "function",
  function: {
    name: "lsp_definition",
    description: "Navigate to the definition of a symbol via LSP.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Absolute path of the file.",
        },
        line: {
          type: "number",
          description: "1-indexed line number.",
        },
        column: {
          type: "number",
          description: "0-indexed column number.",
        },
      },
      required: ["file_path", "line", "column"],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 60,
  displayName: "LSP Definition",
  category: "code",
}

// ── 4.5 Git Tools ────────────────────────────────────────────────────────────

export const GIT_DIFF: AgentToolDefinition = {
  type: "function",
  function: {
    name: "git_diff",
    description: "Show the diff for a file or the entire workspace.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Optional: relative path within the workspace. If omitted, shows all changes.",
        },
      },
      required: [],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 30,
  displayName: "Git Diff",
  category: "git",
}

export const GIT_LOG: AgentToolDefinition = {
  type: "function",
  function: {
    name: "git_log",
    description: "Show recent commits.",
    parameters: {
      type: "object",
      properties: {
        max_count: {
          type: "number",
          description: "Max number of commits to return (default 20).",
          default: 20,
        },
      },
      required: [],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 30,
  displayName: "Git Log",
  category: "git",
}

export const GIT_STATUS: AgentToolDefinition = {
  type: "function",
  function: {
    name: "git_status",
    description: "Current branch, staged and unstaged changes.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 30,
  displayName: "Git Status",
  category: "git",
}

export const GIT_CHECKOUT: AgentToolDefinition = {
  type: "function",
  function: {
    name: "git_checkout",
    description: "Switch or create a branch.",
    parameters: {
      type: "object",
      properties: {
        branch: {
          type: "string",
          description: "Branch name.",
        },
        create: {
          type: "boolean",
          description: "Create the branch if it doesn't exist (default false).",
          default: false,
        },
      },
      required: ["branch"],
    },
  },
  safety: "write_remote",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 10,
  displayName: "Git Checkout",
  category: "git",
}

export const GIT_ADD: AgentToolDefinition = {
  type: "function",
  function: {
    name: "git_add",
    description: "Stage files for commit.",
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "string",
          description: "Comma-separated list of relative paths to stage.",
        },
      },
      required: ["paths"],
    },
  },
  safety: "write_local",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 20,
  displayName: "Git Add",
  category: "git",
}

export const GIT_COMMIT: AgentToolDefinition = {
  type: "function",
  function: {
    name: "git_commit",
    description: "Commit staged changes with a message.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Commit message.",
        },
      },
      required: ["message"],
    },
  },
  safety: "write_remote",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 10,
  displayName: "Git Commit",
  category: "git",
}

export const GIT_DISCARD: AgentToolDefinition = {
  type: "function",
  function: {
    name: "git_discard",
    description: "Discard uncommitted changes. IRREVERSIBLE — always requires approval.",
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "string",
          description: "Comma-separated list of relative paths to discard.",
        },
      },
      required: ["paths"],
    },
  },
  safety: "dangerous",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 5,
  displayName: "Git Discard",
  category: "git",
}

// ── 4.6 Execution Tools ──────────────────────────────────────────────────────

export const RUN_SHELL: AgentToolDefinition = {
  type: "function",
  function: {
    name: "run_shell",
    description:
      "Execute a shell command in the workspace directory. Budget-gated. Timeout: 300s.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute.",
        },
        timeout_secs: {
          type: "number",
          description: "Timeout in seconds (default 300).",
          default: 300,
        },
      },
      required: ["command"],
    },
  },
  safety: "compute",
  estimatedCost: 0.01,
  requiresWorkspace: true,
  rateLimit: 10,
  displayName: "Run Shell",
  category: "execution",
}

export const RUN_PYTHON: AgentToolDefinition = {
  type: "function",
  function: {
    name: "run_python",
    description:
      "Execute a Python snippet in the workspace virtual environment.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Python code to execute.",
        },
        timeout_secs: {
          type: "number",
          description: "Timeout in seconds (default 60).",
          default: 60,
        },
      },
      required: ["code"],
    },
  },
  safety: "compute",
  estimatedCost: 0.01,
  requiresWorkspace: true,
  rateLimit: 10,
  displayName: "Run Python",
  category: "execution",
}

export const RUN_SMOKE_TEST: AgentToolDefinition = {
  type: "function",
  function: {
    name: "run_smoke_test",
    description:
      "Run train.py for a limited number of steps (< 60s budget) to verify code correctness.",
    parameters: {
      type: "object",
      properties: {
        script_path: {
          type: "string",
          description: "Relative path to the training script.",
        },
        max_steps: {
          type: "number",
          description: "Max training steps (default 200).",
          default: 200,
        },
      },
      required: ["script_path"],
    },
  },
  safety: "compute",
  estimatedCost: 0.10,
  requiresWorkspace: true,
  rateLimit: 5,
  displayName: "Run Smoke Test",
  category: "execution",
}

export const PIP_INSTALL: AgentToolDefinition = {
  type: "function",
  function: {
    name: "pip_install",
    description: "Install a Python package in the workspace virtual environment.",
    parameters: {
      type: "object",
      properties: {
        package: {
          type: "string",
          description: "Package spec, e.g. 'torch' or 'numpy==1.24.0'.",
        },
      },
      required: ["package"],
    },
  },
  safety: "compute",
  estimatedCost: 0.05,
  requiresWorkspace: true,
  rateLimit: 5,
  displayName: "Pip Install",
  category: "execution",
}

// ── 4.7 Experiment Tools ─────────────────────────────────────────────────────

export const CREATE_EXPERIMENT: AgentToolDefinition = {
  type: "function",
  function: {
    name: "create_experiment",
    description: "Create an experiment definition (not yet started).",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Human-readable title.",
        },
        hypothesis: {
          type: "string",
          description: "The hypothesis this experiment tests.",
        },
        goal_metric: {
          type: "string",
          description: "Metric to optimize, e.g. 'val_loss'.",
        },
        goal_direction: {
          type: "string",
          description: "'minimize' or 'maximize'.",
          enum: ["minimize", "maximize"],
        },
        goal_target: {
          type: "number",
          description: "Target value for the goal metric.",
        },
      },
      required: ["title", "hypothesis"],
    },
  },
  safety: "write_local",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 20,
  displayName: "Create Experiment",
  category: "experiment",
}

export const UPDATE_EXPERIMENT: AgentToolDefinition = {
  type: "function",
  function: {
    name: "update_experiment",
    description: "Modify an experiment's hypothesis, goal, or status.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Experiment ID.",
        },
        updates: {
          type: "string",
          description: "JSON object of fields to update.",
        },
      },
      required: ["id", "updates"],
    },
  },
  safety: "write_local",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 20,
  displayName: "Update Experiment",
  category: "experiment",
}

export const LAUNCH_EXPERIMENT_RUN: AgentToolDefinition = {
  type: "function",
  function: {
    name: "launch_experiment_run",
    description: "Start a training run with a specific experiment config. Budget-gated.",
    parameters: {
      type: "object",
      properties: {
        experiment_id: {
          type: "string",
          description: "Experiment ID.",
        },
        config_overrides: {
          type: "string",
          description: "JSON object of config values to override for this run.",
        },
      },
      required: ["experiment_id"],
    },
  },
  safety: "compute",
  estimatedCost: 1.0,
  requiresWorkspace: true,
  rateLimit: 5,
  displayName: "Launch Experiment Run",
  category: "experiment",
}

export const STOP_EXPERIMENT_RUN: AgentToolDefinition = {
  type: "function",
  function: {
    name: "stop_experiment_run",
    description: "Stop a running training process.",
    parameters: {
      type: "object",
      properties: {
        run_id: {
          type: "string",
          description: "Run ID to stop.",
        },
      },
      required: ["run_id"],
    },
  },
  safety: "write_remote",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 5,
  displayName: "Stop Experiment Run",
  category: "experiment",
}

export const LIST_EXPERIMENTS: AgentToolDefinition = {
  type: "function",
  function: {
    name: "list_experiments",
    description: "List all experiments for the current workspace.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 30,
  displayName: "List Experiments",
  category: "experiment",
}

export const GET_EXPERIMENT: AgentToolDefinition = {
  type: "function",
  function: {
    name: "get_experiment",
    description: "Full experiment detail with linked runs.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Experiment ID.",
        },
      },
      required: ["id"],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 30,
  displayName: "Get Experiment",
  category: "experiment",
}

// ── 4.8 Knowledge Tools ──────────────────────────────────────────────────────

export const SEARCH_ARXIV: AgentToolDefinition = {
  type: "function",
  function: {
    name: "search_arxiv",
    description: "Search arXiv for papers by keyword or phrase.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query, e.g. 'transformer training stability'.",
        },
        max_results: {
          type: "number",
          description: "Max papers to return (default 5).",
          default: 5,
        },
      },
      required: ["query"],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: false,
  rateLimit: 10,
  displayName: "Search ArXiv",
  category: "knowledge",
}

export const READ_PAPER: AgentToolDefinition = {
  type: "function",
  function: {
    name: "read_paper",
    description: "Fetch and summarize a paper from arXiv by ID.",
    parameters: {
      type: "object",
      properties: {
        paper_id: {
          type: "string",
          description: "arXiv paper ID, e.g. '2301.00001'.",
        },
      },
      required: ["paper_id"],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: false,
  rateLimit: 5,
  displayName: "Read Paper",
  category: "knowledge",
}

export const QUERY_PROJECT_MEMORY: AgentToolDefinition = {
  type: "function",
  function: {
    name: "query_project_memory",
    description: "Read project memory: known insights and dead ends.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "'insights', 'dead_ends', or 'all'.",
          enum: ["insights", "dead_ends", "all"],
          default: "all",
        },
        limit: {
          type: "number",
          description: "Max entries to return (default 20).",
          default: 20,
        },
      },
      required: [],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 30,
  displayName: "Query Project Memory",
  category: "knowledge",
}

export const WRITE_PROJECT_MEMORY: AgentToolDefinition = {
  type: "function",
  function: {
    name: "write_project_memory",
    description: "Write an insight or dead end to project memory.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "'insight' or 'dead_end'.",
          enum: ["insight", "dead_end"],
        },
        label: {
          type: "string",
          description: "Short label or finding summary.",
        },
        evidence: {
          type: "string",
          description: "Supporting evidence or description.",
        },
        marker: {
          type: "string",
          description: "Optional: confidence ('High'/'Medium'/'Low') for insights.",
        },
      },
      required: ["kind", "label", "evidence"],
    },
  },
  safety: "write_local",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 20,
  displayName: "Write Project Memory",
  category: "knowledge",
}

// ── 4.9 UI Tools ─────────────────────────────────────────────────────────────

export const OPEN_FILE_IN_EDITOR: AgentToolDefinition = {
  type: "function",
  function: {
    name: "open_file_in_editor",
    description: "Open a file in the editor pane.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path from workspace root.",
        },
      },
      required: ["path"],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: true,
  rateLimit: 60,
  displayName: "Open File in Editor",
  category: "ui",
}

export const SHOW_METRIC_PLOT: AgentToolDefinition = {
  type: "function",
  function: {
    name: "show_metric_plot",
    description: "Display a metric chart in the Inspector Metrics tab.",
    parameters: {
      type: "object",
      properties: {
        run_id: {
          type: "string",
          description: "Run ID to display.",
        },
        metric_keys: {
          type: "string",
          description: "Comma-separated list of metric keys to plot.",
        },
      },
      required: ["run_id", "metric_keys"],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: false,
  rateLimit: 20,
  displayName: "Show Metric Plot",
  category: "ui",
}

export const SHOW_NOTIFICATION: AgentToolDefinition = {
  type: "function",
  function: {
    name: "show_notification",
    description: "Display a toast notification to the user.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Notification message text.",
        },
        level: {
          type: "string",
          description: "'info', 'success', 'warning', or 'error'.",
          enum: ["info", "success", "warning", "error"],
          default: "info",
        },
      },
      required: ["message"],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: false,
  rateLimit: 20,
  displayName: "Show Notification",
  category: "ui",
}

// `request_approval` (spec section 4.9): a UI tool the LLM can call to
// pause the loop and surface a question to the human. The engine
// recognises this tool name and transitions the thread to
// `AwaitingApproval` (section 6.3) so the renderer can prompt the
// user, then resume via `agent_approve_action` IPC. Without it the
// agent can only ever pause via the structural gate — never to ask
// a clarifying question.
export const REQUEST_APPROVAL: AgentToolDefinition = {
  type: "function",
  function: {
    name: "request_approval",
    description:
      "Pause the agent loop and request human input. The thread transitions to AwaitingApproval and the renderer shows a prompt. Resume via the agent_approve_action IPC after the user responds.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "What the agent needs the human to clarify or approve.",
        },
        context: {
          type: "string",
          description:
            "Optional: short summary of the surrounding investigation context.",
        },
      },
      required: ["question"],
    },
  },
  safety: "read",
  estimatedCost: 0,
  requiresWorkspace: false,
  rateLimit: 20,
  displayName: "Request Approval",
  category: "ui",
}

// ── Registry ─────────────────────────────────────────────────────────────────

/** All tool definitions, keyed by name. */
export const ALL_TOOLS: Record<string, AgentToolDefinition> = {
  // Filesystem
  read_file: READ_FILE,
  read_directory: READ_DIRECTORY,
  search_files: SEARCH_FILES,
  write_file: WRITE_FILE,
  create_file: CREATE_FILE,
  create_folder: CREATE_FOLDER,
  rename_path: RENAME_PATH,
  delete_path: DELETE_PATH,
  apply_patch: APPLY_PATCH,
  // Tracker
  list_runs: LIST_RUNS,
  get_run: GET_RUN,
  get_metric_series: GET_METRIC_SERIES,
  get_run_config: GET_RUN_CONFIG,
  list_artifacts: LIST_ARTIFACTS,
  compare_runs: COMPARE_RUNS,
  query_run_graph: QUERY_RUN_GRAPH,
  // Code
  query_code_graph: QUERY_CODE_GRAPH,
  index_code_graph: INDEX_CODE_GRAPH,
  ruff_check: RUFF_CHECK,
  lsp_hover: LSP_HOVER,
  lsp_definition: LSP_DEFINITION,
  // Git
  git_diff: GIT_DIFF,
  git_log: GIT_LOG,
  git_status: GIT_STATUS,
  git_checkout: GIT_CHECKOUT,
  git_add: GIT_ADD,
  git_commit: GIT_COMMIT,
  git_discard: GIT_DISCARD,
  // Execution
  run_shell: RUN_SHELL,
  run_python: RUN_PYTHON,
  run_smoke_test: RUN_SMOKE_TEST,
  pip_install: PIP_INSTALL,
  // Experiment
  create_experiment: CREATE_EXPERIMENT,
  update_experiment: UPDATE_EXPERIMENT,
  launch_experiment_run: LAUNCH_EXPERIMENT_RUN,
  stop_experiment_run: STOP_EXPERIMENT_RUN,
  list_experiments: LIST_EXPERIMENTS,
  get_experiment: GET_EXPERIMENT,
  // Knowledge
  search_arxiv: SEARCH_ARXIV,
  read_paper: READ_PAPER,
  query_project_memory: QUERY_PROJECT_MEMORY,
  write_project_memory: WRITE_PROJECT_MEMORY,
  // UI
  open_file_in_editor: OPEN_FILE_IN_EDITOR,
  show_metric_plot: SHOW_METRIC_PLOT,
  show_notification: SHOW_NOTIFICATION,
  request_approval: REQUEST_APPROVAL,
}

/** All tools as an array (for bulk injection into ChatRequest.tools). */
export const ALL_TOOL_DEFINITIONS: AgentToolDefinition[] = Object.values(ALL_TOOLS)

/** All tools as LLM ToolDefinition array (without agent metadata). */
export const ALL_LLM_TOOL_DEFINITIONS = ALL_TOOL_DEFINITIONS.map(toLlmToolDefinition)

/** Lookup by tool name. */
export function getTool(name: string): AgentToolDefinition | undefined {
  return ALL_TOOLS[name]
}

/** Filter tools by category. */
export function getToolsByCategory(
  category: AgentToolDefinition["category"],
): AgentToolDefinition[] {
  return ALL_TOOL_DEFINITIONS.filter((t) => t.category === category)
}

/** Filter tools by safety level. */
export function getToolsBySafety(safety: SafetyLevel): AgentToolDefinition[] {
  return ALL_TOOL_DEFINITIONS.filter((t) => t.safety === safety)
}
