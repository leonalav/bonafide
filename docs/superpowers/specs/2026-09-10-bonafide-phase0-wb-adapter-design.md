# Bonafide Agent System — Phase 0 + W&B Adapter

**Spec version:** 1.0
**Date:** 2026-09-10
**Scope:** Phase 0 (Rust agent scaffold + SQLite storage + tree-sitter code graph + per-workspace shim lifecycle) + W&B tracker adapter (Python shim, stdio JSON-RPC). All other phases are out of scope.
**User decision:** W&B-first; MLflow deferred to Phase 1.
**Execution model:** Subagent-driven (Opus 5), strict audit loop per phase.

---

## 1. Module Layout

```
src-tauri/src/
├── agent/                      NEW
│   ├── mod.rs                  pub use + module wiring; re-exports from children
│   ├── orchestrator.rs         ThreadState, Thread, Budget, event-log append helpers
│   ├── tools.rs                ToolRegistry trait + dispatch shell (no-op for Phase 0)
│   └── memory.rs               insights / dead_ends table wrappers
├── graph/                      NEW
│   ├── mod.rs                  module wiring
│   ├── code_graph.rs           tree-sitter native parse → code_nodes / code_edges
│   ├── run_graph.rs            stub (populated by tracker sync, not built in Phase 0)
│   └── storage.rs              rusqlite connection per workspace, migration system
├── tracker/                    NEW
│   ├── mod.rs                  TrackerProvider trait + enum dispatch; connect_tracker / disconnect_tracker / test_connection commands
│   ├── credentials.rs          keyring wrapper (entry: "bonafide:tracker:wb:<workspace-hash>")
│   ├── error.rs                 TrackerError enum: NoPython | AuthFailed | NotFound | RateLimited | ShimCrashed | Unknown
│   └── wandb.rs                W&B provider, talks to shim via stdio JSON-RPC
├── shim/                       NEW
│   ├── mod.rs                  ShimManager: spawn / supervise / healthcheck / respawn
│   └── protocol.rs             JSON-RPC types over stdio (newline-delimited messages)
└── lib.rs                      add agent/, graph/, tracker/ to module tree; register new commands

scripts/
└── wandb_shim.py               NEW — Python side of the shim; hosts wandb SDK client

src/                            (React renderer)
├── ipc/tauri.ts                add typed wrappers for new commands
├── data/runs.ts                replace RUNS mock with useRuns() hook calling list_runs IPC
├── components/preferences/
│   └── AccountSection.tsx      connect W&B card wired to connect_tracker IPC
└── components/agent/
    └── Composer.tsx            replace INVESTIGATION mock with open_investigation stub
```

---

## 2. SQLite Schema (Per-Workspace, Embedded)

Storage location: `~/.bonafide/<workspace-hash>/bonafide.db`
Workspace hash: `sha256(workspace_root_path)[0..16]` encoded as hex string.

Migration system: `schema_migrations(version INTEGER, applied_at INTEGER)` table tracks applied version. On open, run pending migrations in ascending version order. If `PRAGMA integrity_check` fails, rename corrupt file to `.corrupt-<unix-ts>` and create fresh DB.

```sql
CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
);

CREATE TABLE code_nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    file TEXT NOT NULL,
    name TEXT NOT NULL,
    span_start INTEGER NOT NULL,
    span_end INTEGER NOT NULL
);

CREATE TABLE code_edges (
    src TEXT NOT NULL,
    dst TEXT NOT NULL,
    kind TEXT NOT NULL
);

CREATE INDEX code_edges_src ON code_edges(src);
CREATE INDEX code_edges_dst ON code_edges(dst);

CREATE TABLE run_nodes (
    id TEXT PRIMARY KEY,
    framework TEXT NOT NULL,
    gpu TEXT NOT NULL,
    config_json TEXT NOT NULL,
    dataset_ref TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE run_edges (
    src TEXT NOT NULL,
    dst TEXT NOT NULL,
    kind TEXT NOT NULL
);

CREATE TABLE artifact_sections (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    section_label TEXT NOT NULL,
    claim_summary TEXT NOT NULL,
    equation_refs TEXT NOT NULL
);

CREATE TABLE insights (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    statement TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE dead_ends (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    attempted_fix TEXT NOT NULL,
    outcome TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE tracker_credentials (
    kind TEXT PRIMARY KEY,
    workspace_hash TEXT NOT NULL,
    last_verified INTEGER NOT NULL
);
```

---

## 3. Rust Type Definitions

### 3.1 Agent Types (agent/orchestrator.rs)

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadState {
    Idle,
    Investigating,
    HypothesisFormed,
    PatchProposed,
    SmokeVerifying,
    AwaitingApproval,
    FullRunVerifying,
    Resolved,
    Rejected,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    Debugger,
    Scaffolder,
    Planner,
    Researcher,
    Critic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Budget {
    pub max_gpu_hours: f32,
    pub max_dollars: f32,
    pub spent_gpu_hours: f32,
    pub spent_dollars: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Thread {
    pub id: String,
    pub run_id: Option<String>,
    pub role: AgentRole,
    pub state: ThreadState,
    pub model_id: String,
    pub messages: Vec<Message>,
    pub trace: Vec<TraceStep>,
    pub hypothesis: Option<Hypothesis>,
    pub proposed_patch: Option<Patch>,
    pub budget: Budget,
    pub event_log_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub role: String,
    pub content: String,
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceStep {
    pub step: u32,
    pub content: String,
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hypothesis {
    pub verdict: String,
    pub statement: String,
    pub evidence: Vec<EvidenceRef>,
    pub confidence: f32,
    pub ruled_out: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceRef {
    pub tool_call_id: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Patch {
    pub file: String,
    pub diff: String,
    pub created_at: i64,
}
```

### 3.2 Tracker Types (tracker/mod.rs)

```rust
#[async_trait]
pub trait TrackerProvider: Send + Sync {
    async fn list_runs(
        &self,
        project: &str,
        limit: u32,
        cursor: Option<String>,
    ) -> Result<RunPage, TrackerError>;

    async fn get_run(&self, run_id: &str) -> Result<RunDetail, TrackerError>;

    async fn get_metric_series(
        &self,
        run_id: &str,
        key: &str,
    ) -> Result<Vec<Point>, TrackerError>;

    async fn get_run_config(&self, run_id: &str) -> Result<RunConfig, TrackerError>;

    async fn list_artifacts(&self, run_id: &str) -> Result<Vec<ArtifactRef>, TrackerError>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunPage {
    pub runs: Vec<RunSummary>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunSummary {
    pub id: String,
    pub name: String,
    pub state: String,
    pub created_at: i64,
    pub summary_metrics: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunDetail {
    pub id: String,
    pub name: String,
    pub state: String,
    pub created_at: i64,
    pub finished_at: Option<i64>,
    pub config: serde_json::Value,
    pub summary_metrics: serde_json::Value,
    pub tags: Vec<String>,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Point {
    pub step: i64,
    pub value: f64,
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunConfig {
    pub run_id: String,
    pub config: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactRef {
    pub name: String,
    pub digest: String,
    pub size_bytes: i64,
    pub created_at: i64,
}
```

### 3.3 Shim Protocol Types (shim/protocol.rs)

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum ShimRequest {
    #[serde(rename = "list_runs")]
    ListRuns { project: String, limit: u32, cursor: Option<String> },
    #[serde(rename = "get_run")]
    GetRun { run_id: String },
    #[serde(rename = "get_metric_series")]
    GetMetricSeries { run_id: String, key: String },
    #[serde(rename = "get_run_config")]
    GetRunConfig { run_id: String },
    #[serde(rename = "list_artifacts")]
    ListArtifacts { run_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ShimResponse {
    #[serde(rename = "result")]
    Result { id: u64, result: serde_json::Value },
    #[serde(rename = "error")]
    Error { id: u64, error: ShimErrorDetail },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShimErrorDetail {
    pub code: i32,
    pub message: String,
}
```

---

## 4. Python Shim (scripts/wandb_shim.py)

**Entry point:** `python scripts/wandb_shim.py [--api-key KEY] [--project PROJECT]`

**Transport:** stdin/stdout, one JSON-RPC request per line (newline-delimited). Rust side writes requests to stdin, reads responses from stdout. Process stderr is forwarded as events to renderer via Tauri emit.

**Shim responsibilities:**
1. Validate API key on startup via `wandb.Api().entity_settings()`.
2. On first use, check `wandb` package availability. If absent, run `pip install wandb` in a managed venv at `~/.bonafide/shim-venv/`. Emit progress events to stderr (picked up by Rust as `shim://install_progress`).
3. Translate JSON-RPC requests to `wandb` SDK calls.
4. Stream errors to stderr as JSON: `{"event": "error", "kind": "...", "message": "..."}`.

**Shim venv path:** `~/.bonafide/shim-venv/`
**Shim binary discovery:** Rust calls `which python` (via existing `which` crate) to find Python. Falls back to `python3`. Result persisted in `~/.bonafide/settings.json`.

**Respawn policy:** ShimManager attempts 3 restarts with exponential backoff (1s, 2s, 4s). After 3 failures, emit `shim://crashed` event and mark tracker as disconnected.

---

## 5. IPC Surface (Tauri Commands)

All commands live in `src-tauri/src/lib.rs` and are registered in `invoke_handler!`.

### 5.1 Workspace Commands

```rust
#[tauri::command]
async fn open_workspace(path: String) -> Result<Workspace, String>;

#[tauri::command]
async fn list_workspaces() -> Result<Vec<WorkspaceSummary>, String>;

#[derive(Serialize, Deserialize)]
pub struct Workspace {
    pub root: String,
    pub hash: String,
    pub db_path: String,
    pub has_tracker: bool,
}

#[derive(Serialize, Deserialize)]
pub struct WorkspaceSummary {
    pub root: String,
    pub hash: String,
    pub last_opened: i64,
}
```

### 5.2 Tracker Commands

```rust
#[tauri::command]
async fn connect_tracker(kind: String, api_key: String) -> Result<(), TrackerError>;

#[tauri::command]
async fn disconnect_tracker(kind: String) -> Result<(), String>;

#[tauri::command]
async fn test_tracker_connection(kind: String) -> Result<TrackerStatus, TrackerError>;

#[derive(Serialize, Deserialize)]
pub struct TrackerStatus {
    pub connected: bool,
    pub latency_ms: Option<u64>,
    pub error_kind: Option<String>,
}

#[tauri::command]
async fn list_runs(
    project: String,
    limit: u32,
    cursor: Option<String>,
) -> Result<RunPage, TrackerError>;

#[tauri::command]
async fn get_run(run_id: String) -> Result<RunDetail, TrackerError>;

#[tauri::command]
async fn get_metric_series(run_id: String, key: String) -> Result<Vec<Point>, TrackerError>;

#[tauri::command]
async fn get_run_config(run_id: String) -> Result<RunConfig, TrackerError>;

#[tauri::command]
async fn list_artifacts(run_id: String) -> Result<Vec<ArtifactRef>, TrackerError>;
```

### 5.3 Code Graph Commands

```rust
#[tauri::command]
async fn index_code_graph(workspace_root: String) -> Result<IndexSummary, String>;

#[derive(Serialize, Deserialize)]
pub struct IndexSummary {
    pub nodes_indexed: u32,
    pub edges_indexed: u32,
    pub files_scanned: u32,
    pub duration_ms: u64,
}

#[tauri::command]
async fn query_code_graph(query: GraphQuery) -> Result<Vec<CodeGraphHit>, String>;
```

### 5.4 Events (Tauri Emit)

```
tracker://connection_changed   → { kind: String, connected: bool, error: Option<String> }
shim://install_progress       → { stage: String, percent: u8, message: String }
shim://crashed                → { kind: String, will_respawn: bool, attempt: u8 }
graph://index_progress        → { files_indexed: u32, total_files: u32 }
```

---

## 6. Event-Sourcing Event Log

Each Thread writes an append-only event log at `{workspace_db_path}/events/{thread_id}.jsonl`.

Event record shape:
```json
{"ts": 1234567890, "type": "state_changed", "from": "idle", "to": "investigating"}
{"ts": 1234567891, "type": "trace_step", "step": 1, "content": "..."}
{"ts": 1234567892, "type": "tool_result", "tool": "read_metrics", "run_id": "...", "ok": true}
```

On app restart, `orchestrator.rs` replays each thread's `.jsonl` to reconstruct state before accepting new commands.

---

## 7. Renderer Wiring

### 7.1 src/ipc/tauri.ts

Add typed wrappers for all new commands mirroring the existing `invoke<T>(cmd, args)` pattern:
```typescript
export async function connectTracker(kind: string, apiKey: string): Promise<void>
export async function listRuns(project: string, limit?: number, cursor?: string): Promise<RunPage>
export async function getRun(runId: string): Promise<RunDetail>
export async function getMetricSeries(runId: string, key: string): Promise<Point[]>
export async function getRunConfig(runId: string): Promise<RunConfig>
export async function listArtifacts(runId: string): Promise<ArtifactRef[]>
export async function openWorkspace(path: string): Promise<Workspace>
export async function listWorkspaces(): Promise<WorkspaceSummary[]>
export async function indexCodeGraph(workspaceRoot: string): Promise<IndexSummary>
```

### 7.2 src/data/runs.ts

Replace the static `RUNS` mock array with a `useRuns()` hook that:
1. Calls `listWorkspaces()` on mount to detect active workspace.
2. Calls `listRuns(project, 50, null)` on workspace open.
3. Listens for `tracker://connection_changed` events and re-fetches on `connected: true`.
4. Returns `{ runs, loading, error, refetch }`.

### 7.3 src/components/preferences/AccountSection.tsx

Add a W&B connect card next to the MLflow card. Wire the submit button to:
1. Call `connectTracker("wandb", apiKey)`.
2. Show inline spinner during connection.
3. On success: close modal + show toast "W&B connected".
4. On error: display typed error message (e.g., "Auth failed — check your API key").

### 7.4 src/components/agent/Composer.tsx

Replace the hardcoded `INVESTIGATION` mock in the thread list with:
1. Call `openWorkspace(workspaceRoot)` if not already open.
2. On "Debug" mode selected, call a new IPC `open_investigation(runId, "debugger")` — returns a stub `Thread` with `state: Idle`.
3. Render the empty thread list from real data; each thread item is clickable and routes to the thread detail view.
4. **Note:** The orchestrator loop itself is not implemented in Phase 0. Sending a message via Composer dispatches it and shows a loading indicator, but the backend returns a stub. The wiring is real, the intelligence is stubbed.

---

## 8. Error Taxonomy

| Error kind | User message | Renderer behavior |
|---|---|---|
| `no_python` | "Python 3.10+ not found. Set path in Settings → Python." | Show error state in tracker card |
| `auth_failed` | "Invalid W&B API key. Check your credentials." | Show error in connect form |
| `not_found` | "Run not found." | Return empty in list; error toast on detail |
| `rate_limited` | "W&B rate limit hit. Retrying in 30s." | Auto-retry with backoff (handled in Rust) |
| `shim_crashed` | "W&B connection lost. Attempting to reconnect…" | Show reconnecting badge; auto-retry 3x |
| `no_workspace` | "No workspace open. Open a folder first." | Show onboarding prompt |

---

## 9. Dependencies Added to src-tauri/Cargo.toml

```toml
[dependencies]
# Existing (keep):
tauri = { version = "2", features = ["devtools"] }
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
tauri-plugin-shell = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
log = "0.4"
env_logger = "0.11"
walkdir = "2"
tokio = { version = "1", features = ["full"] }
tokio-tungstenite = "0.26"
futures-util = "0.3"
portable-pty = "0.8"
which = "6"
once_cell = "1"
notify = "8"
notify-debouncer-mini = "0.5"

# NEW:
rusqlite = { version = "0.32", features = ["bundled"] }
tree-sitter = "0.24"
tree-sitter-python = "0.24"
tree-sitter-typescript = "0.24"
tree-sitter-yaml = "0.6"
tree-sitter-markdown = "0.4"
keyring = "3"
async-trait = "0.1"
uuid = { version = "1", features = ["v4"] }
sha2 = "0.10"
hex = "0.4"
thiserror = "2"

[dev-dependencies]
tempfile = "3"
```

---

## 10. What This Phase Does NOT Include

- MLflow adapter (Phase 1 second half).
- Full agent loop — only types + stub state machine.
- `apply_patch`, `smoke_verify`, `eval_contract.lock` (Phase 3).
- Cost governor wiring — `Budget` struct exists but unused.
- Artifact semantic indexing via LLM (Phase 6).
- Critic role (Phase 7).
- Git post-commit hook installer + incremental code-graph updates — initial scan only.
- BYOK for LLM model keys.
- Model routing / prompt caching.

---

## 11. Acceptance Criteria

1. `cargo check` passes with zero warnings on all new Rust modules.
2. `pnpm exec tsc --noEmit` passes on all modified TypeScript files.
3. `pnpm build` produces a clean build with no errors.
4. Opening a workspace creates `~/.bonafide/<hash>/bonafide.db` with all schema tables.
5. `connect_tracker("wandb", "valid-key")` with a real W&B key succeeds and the shim is spawned.
6. `list_runs` returns real W&B runs from the configured project, replacing the mock data in the sidebar.
7. The W&B connect form in Preferences shows typed error messages for auth failures and no-Python cases.
8. Switching workspaces correctly closes the old shim and opens a fresh one (per-workspace lifecycle).
9. The code graph indexer produces entries in `code_nodes` for a Python workspace.
10. App restart replays event logs correctly (event-sourcing reconstruction works).

---

## 12. File Inventory

| File | Action |
|---|---|
| `src-tauri/src/agent/mod.rs` | Create |
| `src-tauri/src/agent/orchestrator.rs` | Create |
| `src-tauri/src/agent/tools.rs` | Create |
| `src-tauri/src/agent/memory.rs` | Create |
| `src-tauri/src/graph/mod.rs` | Create |
| `src-tauri/src/graph/code_graph.rs` | Create |
| `src-tauri/src/graph/run_graph.rs` | Create (stub) |
| `src-tauri/src/graph/storage.rs` | Create |
| `src-tauri/src/tracker/mod.rs` | Create |
| `src-tauri/src/tracker/credentials.rs` | Create |
| `src-tauri/src/tracker/error.rs` | Create |
| `src-tauri/src/tracker/wandb.rs` | Create |
| `src-tauri/src/shim/mod.rs` | Create |
| `src-tauri/src/shim/protocol.rs` | Create |
| `src-tauri/src/lib.rs` | Modify — add module declarations + command registrations |
| `src-tauri/Cargo.toml` | Modify — add dependencies |
| `scripts/wandb_shim.py` | Create |
| `src/ipc/tauri.ts` | Modify — add typed wrappers |
| `src/data/runs.ts` | Modify — replace mock with useRuns hook |
| `src/components/preferences/AccountSection.tsx` | Modify — wire W&B connect card |
| `src/components/agent/Composer.tsx` | Modify — replace INVESTIGATION mock with real stub |
| `src/components/agent/ProposalView.tsx` | Modify — accept real Hypothesis type |
