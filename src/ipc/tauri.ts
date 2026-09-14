/**
 * tauri.ts — Renderer-side bridge to the Tauri 2 backend.
 *
 * Direct replacement for `electron/preload.ts`. The old API was a single
 * `window.electronAPI` namespace hung off the renderer via contextBridge.
 * In Tauri we don't need a preload at all — the backend commands are
 * called directly via `invoke()` from `@tauri-apps/api/core`. Plugin
 * commands (file dialogs, etc.) come from `@tauri-apps/plugin-dialog`,
 * etc.
 *
 * To keep the rest of the renderer code unchanged, this module exports a
 * `bonafide` object with the same shape as the old `electronAPI`. The
 * `App.tsx`/EditorPane/etc. files now import the typed `bonafide` object
 * from here and call its methods instead of digging into
 * `window.electronAPI`.
 *
 * Detection: `window.isTauri` is set by Tauri's webview. If absent
 * (running the renderer standalone in `vite dev` without the desktop
 * shell), all methods become no-ops or fall back to in-memory stubs.
 * That lets the existing preview/Storybook workflow keep working.
 */

import { invoke, isTauri as tauriIsTauri } from "@tauri-apps/api/core"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { open as openExternal } from "@tauri-apps/plugin-shell"

// ── Tauri presence check ───────────────────────────────────────────────────

/**
 * True when the renderer is hosted inside a Tauri webview. False when
 * running standalone (`vite dev`/Figma preview/Storybook).
 *
 * Components can use this to skip desktop-only behavior (custom title
 * bar, native menus) without crashing.
 *
 * Uses `@tauri-apps/api/core`'s own `tauriIsTauri()` detection, which checks
 * for `window.isTauri` — a boolean injected by Tauri's webview at page
 * load time. This is the correct and documented approach.
 */
export { tauriIsTauri as isTauri }

// ── Types — keep camelCase to match the old preload's shape ────────────────

export type AppInfo = {
  version: string
  name: string
  platform: NodeJS.Platform
  arch: string
  // Tauri-specific fields; older Electron fields are dropped.
  tauri: string
  webview: string
  isPackaged: boolean
  theme: "dark" | "light"
}

/** Represents any JSON value (matches serde_json::Value on the Rust side). */
export type JSONValue = string | number | boolean | null | JSONValue[] | {
  [key: string]: JSONValue
}

export type FileType = "python" | "markdown" | "json" | "typescript" | "tsx" | "css" | "yaml" | "toml" | "shell" | "text"

export type FsNode = {
  id: string
  name: string
  kind: "folder" | "file"
  parentId: string | null
  expanded?: boolean
  fileType: FileType
}

export type DirListing = {
  rootPath: string
  rootName: string
  files: FsNode[]
}

export type OpResult = { ok: boolean path?: string }

/**
 * A file-system change event emitted by the Rust watcher. The shape
 * is a tagged union; the renderer's event listener switches on `type`.
 */
export type FsEvent = { type: "created" path: string is_dir: boolean } | {
  type: "modified"
  path: string
} | { type: "removed" path: string }

// ── IPC functions ──────────────────────────────────────────────────────────

async function pickFolder(): Promise<string | null> {
  if (!tauriIsTauri()) {
    console.warn("[bonafide] pickFolder called outside Tauri — returning null")
    return null
  }
  try {
    const result = await openDialog({
      directory: true,
      multiple: false,
      title: "Open folder",
    })
    if (Array.isArray(result)) return result[0] ?? null
    return result ?? null
  } catch (err) {
    // Common causes: capability mismatch (window label not "main"), plugin not
    // registered, or CSP blocking the IPC. Log for devtools, return null so
    // the caller (openFolder in App.tsx) can show its own error toast.
    console.error("[bonafide] pickFolder failed:", err)
    return null
  }
}

async function pickFile(): Promise<string | null> {
  if (!tauriIsTauri()) {
    console.warn("[bonafide] pickFile called outside Tauri — returning null")
    return null
  }
  try {
    const result = await openDialog({
      directory: false,
      multiple: false,
      title: "Open file",
    })
    if (Array.isArray(result)) return result[0] ?? null
    return result ?? null
  } catch (err) {
    console.error("[bonafide] pickFile failed:", err)
    return null
  }
}

async function readDirectory(dirPath: string): Promise<DirListing> {
  return invoke<DirListing>("read_directory", { path: dirPath })
}

async function readFile(filePath: string): Promise<{ content: string }> {
  return invoke<{ content: string }>("read_file", { path: filePath })
}

async function writeFile(filePath: string, content: string): Promise<OpResult> {
  return invoke<OpResult>("write_file", { path: filePath, content })
}

async function createFile(parentDir: string, name: string): Promise<OpResult> {
  return invoke<OpResult>("create_file", { parentDir, name })
}

async function createFolder(
  parentDir: string,
  name: string,
): Promise<OpResult> {
  return invoke<OpResult>("create_folder", { parentDir, name })
}

async function rename(src: string, newName: string): Promise<OpResult> {
  return invoke<OpResult>("rename_path", { src, newName })
}

async function deletePath(target: string): Promise<OpResult> {
  return invoke<OpResult>("delete_path", { target })
}

async function minimize(): Promise<void> {
  if (!tauriIsTauri()) return
  await getCurrentWindow().minimize()
}

async function toggleMaximize(): Promise<void> {
  if (!tauriIsTauri()) return
  const w = getCurrentWindow()
  if (await w.isMaximized()) await w.unmaximize()
  else await w.maximize()
}

async function isMaximized(): Promise<boolean> {
  if (!tauriIsTauri()) return false
  return getCurrentWindow().isMaximized()
}

async function close(): Promise<void> {
  if (!tauriIsTauri()) return
  await getCurrentWindow().close()
}

/**
 * Subscribe to window maximize/unmaximize events. The Tauri webview
 * emits `tauri://resize` and we derive the bool from comparing the
 * window's current maximized state.
 */
function onMaximizeChanged(cb: (maximized: boolean) => void): () => void {
  if (!tauriIsTauri()) return () => {}
  const w = getCurrentWindow()
  let lastState: boolean | null = null
  const handler = async () => {
    const m = await w.isMaximized()
    if (m !== lastState) {
      lastState = m
      cb(m)
    }
  }
  const unlistenResize = w.onResized(handler)
  // Initial sync — fires once if the window starts maximized.
  void handler()
  return async () => {
    await unlistenResize.then((f) => f())
  }
}

async function getInfo(): Promise<AppInfo> {
  if (!tauriIsTauri()) {
    // Intentionally stubbed for browser preview mode — Tauri provides real values at runtime
    return {
      version: "1.0.0",
      name: "Bonafide",
      platform: "win32",
      arch: "x64",
      tauri: "browser-preview",
      webview: navigator.userAgent,
      isPackaged: false,
      theme: "dark",
    }
  }
  // `tauriIsTauri()` checks for `window.isTauri` — the official flag set by
  // Tauri's webview at load time. When false we know this is the browser
  // preview; when true we know it's the real desktop shell.
  const tauriVersion = tauriIsTauri() ? "2.x" : "browser-preview"
  return {
    version: "1.0.0", // populated at build time by tauri.conf.json
    name: "Bonafide",
    platform: (navigator.platform.toLowerCase().includes("mac")
      ? "darwin"
      : navigator.platform.toLowerCase().includes("linux")
        ? "linux"
        : "win32") as NodeJS.Platform,
    arch: "x64",
    tauri: tauriVersion,
    webview: navigator.userAgent,
    isPackaged: !import.meta.env.DEV,
    theme: matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
  }
}

async function shellOpenExternal(url: string): Promise<boolean> {
  if (!tauriIsTauri()) {
    try {
      window.open(url, "_blank", "noopener")
      return true
    } catch {
      return false
    }
  }
  await openExternal(url)
  return true
}

// ── File watcher (real-time file tree updates) ────────────────────────────

/** Start watching a workspace directory for file-system changes. */
async function startWatcher(path: string): Promise<void> {
  if (!tauriIsTauri()) return
  return invoke<void>("start_watcher", { path })
}

/** Stop watching the current workspace. */
async function stopWatcher(): Promise<void> {
  if (!tauriIsTauri()) return
  return invoke<void>("stop_watcher")
}

/**
 * Subscribe to file-system events for the current workspace. Returns
 * an unsubscribe function. The renderer uses this to update the file
 * tree in real-time when files are created, modified, renamed, or
 * deleted on disk.
 *
 * Events arrive in batches (debounced to ~150ms by the Rust watcher)
 * and each batch is a typed union of `created`, `modified`, or
 * `removed` events.
 */
function onFsEvent(cb: (events: FsEvent[]) => void): () => void {
  if (!tauriIsTauri()) return () => {}
  let unlisten: (() => void) | null = null
  void import("@tauri-apps/api/event").then(({ listen }) => {
    void listen<FsEvent[]>("fs:watcher", (e) => cb(e.payload)).then((fn) => {
      unlisten = fn
    })
  })
  return () => {
    unlisten?.()
  }
}

// ── LSP bridge + ruff CLI ──────────────────────────────────────────────────

/** Get the WebSocket URL of the LSP bridge hosted by the Tauri backend. */
async function getLspBridgeUrl(): Promise<string | null> {
  if (!tauriIsTauri()) {
    return null
  }
  return invoke<string>("get_lsp_bridge_url")
}

/** Get the list of running LSP servers (serverId + rootUri). */
async function getLspServers(): Promise<{ id: string status: string }[]> {
  if (!tauriIsTauri()) return []
  return invoke<{ id: string status: string }[]>("get_lsp_servers")
}

/** Stop a running LSP server by id. */
async function stopLspServer(serverId: string): Promise<void> {
  if (!tauriIsTauri()) return
  await invoke("stop_lsp_server", { serverId })
}

/**
 * Run `ruff check` on a file via the Tauri backend.
 * Returns the raw JSON output (empty array when no issues).
 */
async function ruffCheck(filePath: string): Promise<string> {
  if (!tauriIsTauri()) return "[]"
  return invoke<string>("ruff_check", { filePath })
}

/** Get the WebSocket URL for the PTY bridge (xterm.js terminal sessions). */
async function getPtyWsUrl(): Promise<string | null> {
  if (!tauriIsTauri()) return null
  return invoke<string>("get_pty_ws_url")
}

/** One available terminal shell profile (cmd, powershell, pwsh, git-bash…). */
export type TerminalProfile = {
  id: string
  label: string
  program: string
  args: string[]
  available: boolean
}

/**
 * List the shell profiles detected on this machine. The renderer uses
 * this to populate the "+ Launch Profile" dropdown in the Terminal panel.
 */
async function listTerminalProfiles(): Promise<TerminalProfile[]> {
  if (!tauriIsTauri()) {
    return []
  }
  return invoke<TerminalProfile[]>("list_terminal_profiles")
}

// ── Phase 0: Recent workspaces + tracker / service probes ──────────────────
//
// These power the Preferences → Account panel. The renderer calls
// `listRecentWorkspaces` on mount, then `getRecentWorkspace` to
// populate the active-workspace card. `getTrackerStatus` /
// `listServices` / `getUserProfile` fill the four cards in the
// Connected Trackers / Connected Services / Profile rows. All
// commands fall back to `[]` / `null` outside Tauri so the
// preferences panel can still render its empty state in browser
// preview mode.

/** Read the recent-workspaces list (Preferences → Account → Recent). */
async function listRecentWorkspaces(): Promise<RecentWorkspace[]> {
  if (!tauriIsTauri()) return []
  return invoke<RecentWorkspace[]>("list_recent_workspaces")
}

/** Look up one recent workspace by path; `null` if never seen. */
async function getRecentWorkspace(
  path: string,
): Promise<RecentWorkspace | null> {
  if (!tauriIsTauri()) return null
  return invoke<RecentWorkspace | null>("get_recent_workspace", { path })
}

/** Insert or refresh a recent-workspace entry (called when the user
 *  opens a folder). If `path` already exists, its `lastOpened` is
 *  bumped and `runCount` is incremented; otherwise a new entry is
 *  prepended. */
async function addRecentWorkspace(path: string): Promise<void> {
  if (!tauriIsTauri()) return
  await invoke<void>("add_recent_workspace", { path })
}

/** Probe every known tracker (`wandb`, `mlflow`, `comet`, `neptune`)
 *  and return a status row per kind. Always returns all four rows,
 *  even disconnected, so the UI can render the full list. */
async function getTrackerStatus(): Promise<TrackerStatusRow[]> {
  if (!tauriIsTauri()) return []
  return invoke<TrackerStatusRow[]>("get_tracker_status")
}

/** Read the persisted config for a tracker kind (`baseUrl`,
 *  `project`). Returns `null` if no config has been saved for the
 *  kind. */
async function getTrackerConfig(kind: TrackerKindFull): Promise<TrackerConfig | null> {
  if (!tauriIsTauri()) return null
  return invoke<TrackerConfig | null>("get_tracker_config", { kind })
}

/** Probe every known service (`github`, `huggingface`, `slack`). */
async function listServices(): Promise<ServiceStatus[]> {
  if (!tauriIsTauri()) return []
  return invoke<ServiceStatus[]>("list_services")
}

/** Return the user's profile for the top Account card. Phase 0.0
 *  always returns `null`; the renderer falls back to dashed/empty
 *  placeholders in that case. */
async function getUserProfile(): Promise<UserProfile | null> {
  if (!tauriIsTauri()) return null
  return invoke<UserProfile | null>("get_user_profile")
}

// ── Git / source-control ──────────────────────────────────────────────────
//
// All commands are thin wrappers over the Rust git_service module. Each
// takes a `workspace: string` path so the commands run against the
// user's currently-open folder regardless of the process CWD. When not
// running in Tauri (browser preview), every command falls back to a
// graceful "not available" error rather than throwing — that lets the
// React panel render an offline message instead of crashing.

export type GitStatusEntry = {
  path: string
  /** M = modified, A = added, D = deleted, R = renamed, C = copied,
   *  T = type-change, U = untracked, I = ignored. */
  status: string
  staged: boolean
  /** Original path when status === "R"; empty otherwise. */
  originalPath: string
}

export type GitStatus = {
  branch: string
  upstream: string
  ahead: number
  /** -1 when no upstream is configured. */
  behind: number
  staged: GitStatusEntry[]
  unstaged: GitStatusEntry[]
  untracked: GitStatusEntry[]
}

export type GitBranch = {
  name: string
  shortHash: string
  subject: string
  isoDate: string
  isCurrent: boolean
  isRemote: boolean
  upstream: string
  ahead: number
  behind: number
}

export type GitCommit = {
  hash: string
  shortHash: string
  subject: string
  author: string
  isoDate: string
  isHead: boolean
}

export type GitDiffFile = {
  path: string
  oldText: string
  newText: string
}

export type GitDiffResult = {
  /** Raw unified diff text (empty when there are no changes). */
  diff: string
  /** Per-file old/new text pairs ready for MergeViewEditor. */
  files: GitDiffFile[]
}

export type GitOpResult = {
  ok: boolean
  stdout: string
  stderr: string
  message: string
}

async function gitStatus(workspace: string): Promise<GitStatus> {
  if (!tauriIsTauri()) return emptyGitStatus()
  return invoke<GitStatus>("git_status", { workspace })
}

async function gitListBranches(workspace: string): Promise<GitBranch[]> {
  if (!tauriIsTauri()) return []
  return invoke<GitBranch[]>("git_list_branches", { workspace })
}

async function gitLog(workspace: string, maxCount = 50): Promise<GitCommit[]> {
  if (!tauriIsTauri()) return []
  return invoke<GitCommit[]>("git_log", { workspace, maxCount })
}

async function gitDiff(
  workspace: string,
  path?: string,
): Promise<GitDiffResult> {
  if (!tauriIsTauri()) return { diff: "", files: [] }
  return invoke<GitDiffResult>("git_diff", { workspace, path })
}

async function gitAdd(
  workspace: string,
  paths: string[],
): Promise<GitOpResult> {
  if (!tauriIsTauri())
    return { ok: false, stdout: "", stderr: "not in Tauri", message: "" }
  return invoke<GitOpResult>("git_add", { workspace, paths })
}

async function gitUnstage(
  workspace: string,
  paths: string[],
): Promise<GitOpResult> {
  if (!tauriIsTauri())
    return { ok: false, stdout: "", stderr: "not in Tauri", message: "" }
  return invoke<GitOpResult>("git_unstage", { workspace, paths })
}

async function gitDiscard(
  workspace: string,
  paths: string[],
): Promise<GitOpResult> {
  if (!tauriIsTauri())
    return { ok: false, stdout: "", stderr: "not in Tauri", message: "" }
  return invoke<GitOpResult>("git_discard", { workspace, paths })
}

async function gitCommit(
  workspace: string,
  message: string,
): Promise<GitOpResult> {
  if (!tauriIsTauri())
    return { ok: false, stdout: "", stderr: "not in Tauri", message: "" }
  return invoke<GitOpResult>("git_commit", { workspace, message })
}

async function gitCheckout(
  workspace: string,
  branch: string,
  create = false,
): Promise<GitOpResult> {
  if (!tauriIsTauri())
    return { ok: false, stdout: "", stderr: "not in Tauri", message: "" }
  return invoke<GitOpResult>("git_checkout", { workspace, branch, create })
}

async function gitPull(workspace: string): Promise<GitOpResult> {
  if (!tauriIsTauri())
    return { ok: false, stdout: "", stderr: "not in Tauri", message: "" }
  return invoke<GitOpResult>("git_pull", { workspace })
}

async function gitPush(workspace: string): Promise<GitOpResult> {
  if (!tauriIsTauri())
    return { ok: false, stdout: "", stderr: "not in Tauri", message: "" }
  return invoke<GitOpResult>("git_push", { workspace })
}

async function gitFetch(workspace: string): Promise<GitOpResult> {
  if (!tauriIsTauri())
    return { ok: false, stdout: "", stderr: "not in Tauri", message: "" }
  return invoke<GitOpResult>("git_fetch", { workspace })
}

async function gitInit(workspace: string): Promise<GitOpResult> {
  if (!tauriIsTauri())
    return { ok: false, stdout: "", stderr: "not in Tauri", message: "" }
  return invoke<GitOpResult>("git_init", { workspace })
}

function emptyGitStatus(): GitStatus {
  return {
    branch: "",
    upstream: "",
    ahead: 0,
    behind: -1,
    staged: [],
    unstaged: [],
    untracked: [],
  }
}

// ── Phase 0: Tracker / Workspace / Code Graph types ────────────────────────

/** Tracker kinds the renderer can connect. */
export type TrackerKind = "wandb" | "mlflow"

/** All tracker kinds the preferences panel renders, including the
 *  read-only `comet` / `neptune` probes that don't yet have full
 *  connect flows. */
export type TrackerKindFull = TrackerKind | "comet" | "neptune"

/** All service kinds the preferences panel renders. */
export type ServiceKind = "github" | "huggingface" | "slack"

/** Per-tracker status row from `getTrackerStatus`. `account` is the
 *  best-effort identifier we found for the user (email, org, etc.)
 *  and `meta` is a free-form human-readable string surfaced under
 *  the tracker row (e.g. "Synced 12s ago · 27 runs" or "No URL
 *  configured"). The renderer is free to show "—" when `meta` is
 *  `null` rather than empty-string. */
export type TrackerStatusRow = {
  kind: TrackerKindFull
  account: string | null
  connected: boolean
  meta: string | null
}

/** Per-tracker configuration from `getTrackerConfig`. The renderer
 *  uses this to pre-populate the connection forms with the
 *  last-used URL / project without round-tripping through
 *  `getSettings()`. */
export type TrackerConfig = {
  baseUrl: string | null
  project: string | null
}

/** Connected-service status row from `listServices`. Mirrors
 *  `TrackerStatusRow` but with the service kinds. */
export type ServiceStatus = {
  kind: ServiceKind
  account: string | null
  connected: boolean
  meta: string | null
}

/** User profile for the top card in Account. Phase 0.0 always
 *  returns `null` from `getUserProfile` (no Bonafide account
 *  backend yet), so the renderer falls back to dashed/empty
 *  placeholders. */
export type UserProfile = {
  name: string
  email: string
  joined: string
}

/** Result of `testTrackerConnection`. */
export type TrackerStatus = {
  connected: boolean
  latencyMs?: number
  errorKind?: string
}

/** JSON payload the renderer sends for an MLflow `connect_tracker`
 *  invocation. For W&B, the `api_key` argument is the plain API key
 *  string; for MLflow, we parse it as this struct. */
export type MlflowConnectPayload = {
  baseUrl: string
  token?: string
  project: string
}

/** W&B tracker error variants returned by the Rust backend. */
export type TrackerErrorKind = "no_python" | "auth_failed" | "not_found" | "rate_limited" | "shim_crashed" | "unknown"

/** Structured error from the tracker subsystem. */
export type TrackerError = {
  kind: TrackerErrorKind
  message: string
  hint?: string
}

/** One entry in the Preferences → Account → Recent Workspaces list. */
export type RecentWorkspace = {
  /** Absolute filesystem path of the workspace root. */
  path: string
  /** ISO-8601 timestamp of the last time the user opened this path. */
  lastOpened: string
  /** How many times the user has opened this workspace. */
  runCount: number
}

/** Full workspace descriptor returned by `open_workspace`. */
export type Workspace = {
  root: string
  hash: string
  dbPath: string
  hasTracker: boolean
}

/** Lightweight workspace summary returned by `list_workspaces`. */
export type WorkspaceSummary = {
  root: string
  hash: string
  lastOpened: number
}

/** Run summary returned by `list_runs`. */
export type RunSummary = {
  id: string
  name: string
  state: string
  createdAt: number
  summaryMetrics: JSONValue
}

/** A page of runs with optional next-cursor. */
export type RunPage = {
  runs: RunSummary[]
  nextCursor?: string
}

/** Full run detail returned by `get_run`. */
export type RunDetail = {
  id: string
  name: string
  state: string
  createdAt: number
  finishedAt?: number
  config: JSONValue
  summaryMetrics: JSONValue
  tags: string[]
  notes: string
}

/** A single (step, value) point in a metric time series. */
export type Point = {
  step: number
  value: number
  ts: number
}

/** Run configuration returned by `get_run_config`. */
export type RunConfig = {
  runId: string
  config: JSONValue
}

/** Reference to a logged W&B artifact. */
export type ArtifactRef = {
  name: string
  digest: string
  sizeBytes: number
  createdAt: number
}

/** Summary of a completed code-graph indexing pass. */
export type IndexSummary = {
  nodesIndexed: number
  edgesIndexed: number
  filesScanned: number
  durationMs: number
}

/** A single entry returned from a code-graph search. */
export type CodeGraphHit = {
  id: string
  kind: string
  file: string
  name: string
  spanStart: number
  spanEnd: number
}

/** A single node returned from a run-graph query. The renderer uses
 *  these to draw cross-run relationships (framework × dataset × GPU).
 *  Mirrors the `RunGraphNode` shape on the Rust side. */
export type RunGraphNode = {
  id: string
  framework: string
  gpu: string
  datasetRef: string
  createdAt: number
}

// ── Phase 0: IPC function implementations ────────────────────────────────

/** Open a workspace directory, creating its local DB on first access. */
async function openWorkspace(path: string): Promise<Workspace> {
  if (!tauriIsTauri()) {
    return { root: path, hash: "preview", dbPath: "", hasTracker: false }
  }
  return invoke<Workspace>("open_workspace", { path })
}

/** List all workspaces currently tracked in app state. */
async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  if (!tauriIsTauri()) return []
  return invoke<WorkspaceSummary[]>("list_workspaces")
}

/** Connect a tracker for the given workspace root.
 *
 *  For `"wandb"` the second argument is the plain W&B API key string.
 *  For `"mlflow"` it should be `JSON.stringify(...)` of an
 *  {@link MlflowConnectPayload} (`{baseUrl, token?, project}`).
 *
 *  The optional 4th `project` argument is the tracker project / MLflow
 *  experiment name; pass `undefined` for W&B (the project's own entity
 *  determines the destination) and the project name for MLflow.
 *
 *  Returns the workspace hash on success.
 */
async function connectTracker(
  kind: TrackerKind,
  apiKey: string,
  workspaceRoot: string,
  project?: string,
): Promise<string> {
  if (!tauriIsTauri()) return "preview"
  return invoke<string>("connect_tracker", {
    kind,
    apiKey,
    workspaceRoot,
    project,
  })
}

/** Disconnect the tracker for the given workspace root. */
async function disconnectTracker(
  kind: TrackerKind,
  workspaceRoot: string,
): Promise<void> {
  if (!tauriIsTauri()) return
  return invoke<void>("disconnect_tracker", { kind, workspaceRoot })
}

/** Test connectivity to the tracker service without storing credentials. */
async function testTrackerConnection(
  kind: TrackerKind,
  workspaceRoot: string,
): Promise<TrackerStatus> {
  if (!tauriIsTauri()) return { connected: false }
  return invoke<TrackerStatus>("test_tracker_connection", {
    kind,
    workspaceRoot,
  })
}

/** List runs for a project on the given tracker. */
async function listRuns(
  kind: TrackerKind,
  workspaceRoot: string,
  project: string,
  limit: number,
  cursor?: string,
): Promise<RunPage> {
  if (!tauriIsTauri()) return { runs: [] }
  return invoke<RunPage>("list_runs", {
    kind,
    workspaceRoot,
    project,
    limit,
    cursor,
  })
}

/** Get full detail for a single run. */
async function getRun(
  kind: TrackerKind,
  workspaceRoot: string,
  runId: string,
): Promise<RunDetail> {
  if (!tauriIsTauri()) {
    throw new Error("getRun not available outside Tauri")
  }
  return invoke<RunDetail>("get_run", { kind, workspaceRoot, runId })
}

/** Get the time-series values for one metric of a run. */
async function getMetricSeries(
  kind: TrackerKind,
  workspaceRoot: string,
  runId: string,
  key: string,
): Promise<Point[]> {
  if (!tauriIsTauri()) return []
  return invoke<Point[]>("get_metric_series", {
    kind,
    workspaceRoot,
    runId,
    key,
  })
}

/** Get the config dict for a single run. */
async function getRunConfig(
  kind: TrackerKind,
  workspaceRoot: string,
  runId: string,
): Promise<RunConfig> {
  if (!tauriIsTauri()) {
    throw new Error("getRunConfig not available outside Tauri")
  }
  return invoke<RunConfig>("get_run_config", { kind, workspaceRoot, runId })
}

/** List artifacts logged to a run. */
async function listArtifacts(
  kind: TrackerKind,
  workspaceRoot: string,
  runId: string,
): Promise<ArtifactRef[]> {
  if (!tauriIsTauri()) return []
  return invoke<ArtifactRef[]>("list_artifacts", { kind, workspaceRoot, runId })
}

/** Index all Python files under a workspace root into the code graph. */
async function indexCodeGraph(workspaceRoot: string): Promise<IndexSummary> {
  if (!tauriIsTauri()) {
    return { nodesIndexed: 0, edgesIndexed: 0, filesScanned: 0, durationMs: 0 }
  }
  return invoke<IndexSummary>("index_code_graph", { workspaceRoot })
}

/** Search the code graph for functions/classes matching the query. */
async function queryCodeGraph(
  query: string,
  workspaceRoot: string,
): Promise<CodeGraphHit[]> {
  if (!tauriIsTauri()) return []
  return invoke<CodeGraphHit[]>("query_code_graph", { query, workspaceRoot })
}

/** Query the run-graph for nodes matching an optional `framework` and
 *  `dataset` filter. Both filters are ANDed; passing neither returns
 *  every node, newest-first. */
async function queryRunGraph(
  workspaceRoot: string,
  framework?: string,
  dataset?: string,
): Promise<RunGraphNode[]> {
  if (!tauriIsTauri()) return []
  return invoke<RunGraphNode[]>("query_run_graph", {
    workspaceRoot,
    framework,
    dataset,
  })
}

// ── Phase 0+: Agent thread IPC ──────────────────────────────────────────────
//
// `ThreadRow` is the persisted shape returned by `list_threads`. It is
// a strict subset of the renderer's `Thread` type (no trace/messages/
// hypothesis/patch — those live in the append-only event log).

export type ThreadRole = "debugger" | "scaffolder" | "planner" | "researcher" | "critic"

export type ThreadState = "idle" | "investigating" | "hypothesis_formed" | "patch_proposed" | "smoke_verifying" | "awaiting_approval" | "full_run_verifying" | "resolved" | "rejected" | "stopped"

export type ThreadBand = "active" | "awaiting_review" | "closed"

export type ThreadRow = {
  id: string
  workspaceHash: string
  role: ThreadRole
  title: string
  summary: string
  state: ThreadState
  detail: string
  band: ThreadBand
  system: boolean
  /** Unix millis — renderer formats "12s ago" relative labels from this. */
  updatedAt: number
}

async function listThreads(workspaceRoot: string): Promise<ThreadRow[]> {
  if (!tauriIsTauri()) return []
  return invoke<ThreadRow[]>("list_threads", { workspaceRoot })
}

async function upsertThread(row: ThreadRow): Promise<void> {
  if (!tauriIsTauri()) return
  await invoke<void>("upsert_thread", { row })
}

// ── WS2-T5: Agent loop IPC ──────────────────────────────────────────────────
//
// The renderer's `AgentContent.tsx` calls these to drive the engine:
// - `agentSendMessage` — append a user message, run the loop until
//   termination (final answer, approval request, budget, max iterations).
// - `agentStopThread` — transition a thread to `Stopped` (terminal).
// - `agentApproveAction` / `agentRejectAction` — resume or end an
//   `AwaitingApproval` thread.

export type AgentRole = "debugger" | "scaffolder" | "planner" | "researcher" | "critic"

/** Outcome of an `AgentEngine::run` call. */
export type AgentEngineResult =
  | { type: "completed"; content: string }
  | { type: "awaiting_approval"; toolCallId: string; reason: string }
  | { type: "budget_exceeded" }
  | { type: "max_iterations" }
  | { type: "llm_error"; message: string }

/** Per-workspace dollar + GPU-hour ceiling + current spend. */
export interface AgentBudget {
  maxDollars: number
  maxGpuHours: number
  spentDollars: number
  spentGpuHours: number
}

/**
 * One structured tool-call record returned by the engine. The
 * renderer turns each entry into an inline `ToolArtifact` card in
 * the assistant message so the user sees what the agent actually
 * did — not just the final prose.
 *
 * Mirrors the renderer's `Artifact` type in `src/chats/ChatStore.ts`.
 */
export type AgentToolArtifactKind = "terminal" | "file" | "tool"

export type AgentToolArtifactStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"

export interface AgentToolArtifact {
  /** Stable id; matches the engine-side `tool_call_id`. */
  id: string
  kind: AgentToolArtifactKind
  /** Original tool name, e.g. "run_shell", "write_file". */
  name: string
  /** Short human-readable label shown on the card header. */
  displayName: string
  /** Sub-label / target (file path, command, etc.). */
  target?: string
  /** Raw JSON arguments the LLM passed. */
  args?: string
  /** Output text for terminal tools (stdout/stderr joined). */
  output?: string
  /** Result summary for file tools (file path + bytes). */
  resultSummary?: string
  status: AgentToolArtifactStatus
  /** Milliseconds since epoch. */
  ts: number
}

/**
 * Endpoint payload forwarded from the renderer to the Rust agent engine.
 *
 * Matches the Rust `EndpointPayload` struct in `src-tauri/src/agent/llm.rs`
 * (camelCase serde rename). The renderer serialises the selected
 * `ModelEndpoint` from `modelsStore.tsx` into this shape so the Rust
 * side can build a real `OpenAiCompatibleClient` without needing to read
 * `settings.json`.
 */
export type EndpointPayload = {
  id: string
  label: string
  /** OpenAI-compatible base URL, e.g. "https://api.openai.com/v1". */
  baseUrl: string
  /** Bearer token. `null` for local endpoints (LM Studio, vLLM). */
  apiKey: string | null
  /** Default model ID, e.g. "claude-3-5-sonnet-20241022". */
  defaultModel: string
}

/** Input for `agentSendMessage`. */
export interface AgentSendMessageInput {
  threadId: string
  userMessage: string
  role?: AgentRole
  runId?: string
  modelId?: string
  /**
   * The configured endpoint the renderer selected in Preferences → Models.
   * Absent (`undefined`) when the user has no custom endpoint configured —
   * the Rust engine will use a noop client and surface a "not configured"
   * error rather than silently failing.
   */
  endpoint?: EndpointPayload
}

/** Output for `agentSendMessage`. */
export interface AgentSendMessageOutput {
  threadId: string
  result: AgentEngineResult
  newState: ThreadState
  escalation: EscalationLevel
  budget: AgentBudget
  /**
   * Structured tool-call records produced during the engine run.
   * Each entry maps to one `ToolArtifact` card rendered inline in
   * the assistant message. Empty when the engine did not invoke
   * any tools.
   */
  toolArtifacts?: AgentToolArtifact[]
}

/** Input for `agentStopThread`. */
export interface AgentStopThreadInput {
  threadId: string
}

/** Output for `agentStopThread`. */
export interface AgentStopThreadOutput {
  threadId: string
  stopped: boolean
}

/** Input for `agentApproveAction` / `agentRejectAction`. */
export interface AgentApprovalInput {
  threadId: string
  toolCallId: string
  /** "approve" | "revise" | "reject" */
  decision: "approve" | "revise" | "reject"
  /**
   * Optional endpoint payload, mirroring `AgentSendMessageInput.endpoint`.
   *
   * CRITICAL FIX (PROD): the previous contract only forwarded the
   * endpoint on `agentSendMessage`. When the user clicked APPROVE on
   * a tool, the resume engine.run was built with `None` for the
   * endpoint and silently fell back to `NoopLlmClientForIpc`,
   * surfacing a misleading "Agent endpoint not configured" error
   * even though the endpoint was perfectly fine moments earlier.
   * Forwarding it here restores the original LLM client on resume.
   */
  endpoint?: EndpointPayload | null
}

/**
 * Output for the approval / rejection commands.
 *
 * CRITICAL FIX (PROD): extended with `result` and `toolArtifacts` so
 * the renderer can update the assistant message body + artifacts after
 * the user's decision. Without these fields, `onApproveArtifact` was
 * fire-and-forget on the previous `(threadId, accepted, newState)`
 * payload, leaving the chat showing the stale
 * "🔐 Approval Required / Tool call: ..." markdown even after the
 * engine successfully resumed.
 */
export interface AgentApprovalOutput {
  threadId: string
  accepted: boolean
  newState: ThreadState
  /**
   * Engine result from the resume after the user's decision.
   * `null` for `"reject"` because the engine does not re-run after
   * rejection. For `"approve"` and `"revise"`, this is whatever
   * `engine.run` produced on the next iteration: `Completed`,
   * `AwaitingApproval` (a second tool needs approval), `BudgetExceeded`,
   * `MaxIterations`, or `LlmError`.
   */
  result: AgentEngineResult | null
  /**
   * Structured tool-call records produced during the resume. The
   * renderer turns each entry into an inline `ToolArtifact` card.
   * Empty for `"reject"`.
   */
  toolArtifacts: AgentToolArtifact[]
}

/**
 * Submit a user message and run the engine loop. Returns the engine's
 * `result`, the thread's new state, the budget's escalation level, and
 * the post-run `Budget` snapshot.
 */
async function agentSendMessage(
  workspaceRoot: string,
  input: AgentSendMessageInput,
): Promise<AgentSendMessageOutput> {
  if (!tauriIsTauri()) {
    return {
      threadId: input.threadId,
      result: {
        type: "completed",
        content:
          "Agent loop is offline — open Preferences → Models to configure an LLM endpoint.",
      },
      newState: "idle",
      escalation: "normal",
      budget: {
        maxDollars: 0,
        maxGpuHours: 0,
        spentDollars: 0,
        spentGpuHours: 0,
      },
      toolArtifacts: [],
    }
  }
  return invoke<AgentSendMessageOutput>("agent_send_message", {
    workspaceRoot,
    input,
  })
}

/** Stop the engine loop for a thread. Idempotent for terminal threads. */
async function agentStopThread(
  workspaceRoot: string,
  input: AgentStopThreadInput,
): Promise<AgentStopThreadOutput> {
  if (!tauriIsTauri()) {
    return { threadId: input.threadId, stopped: false }
  }
  return invoke<AgentStopThreadOutput>("agent_stop_thread", {
    workspaceRoot,
    input,
  })
}

/**
 * Approve (or revise / reject) a pending tool call. The decision drives
 * how the engine resumes the paused thread:
 * - `approve` → resume execution
 * - `revise` → ask the LLM for a new proposal
 * - `reject` → transition the thread to `Rejected`
 */
async function agentApproveAction(
  workspaceRoot: string,
  input: AgentApprovalInput,
): Promise<AgentApprovalOutput> {
  if (!tauriIsTauri()) {
    return { threadId: input.threadId, accepted: false, newState: "rejected" }
  }
  return invoke<AgentApprovalOutput>("agent_approve_action", {
    workspaceRoot,
    input,
  })
}

/** Reject a pending tool call (shortcut for `agentApproveAction` with `decision: "reject"`). */
async function agentRejectAction(
  workspaceRoot: string,
  input: AgentApprovalInput,
): Promise<AgentApprovalOutput> {
  if (!tauriIsTauri()) {
    return { threadId: input.threadId, accepted: false, newState: "rejected" }
  }
  return invoke<AgentApprovalOutput>("agent_reject_action", {
    workspaceRoot,
    input,
  })
}

// ── Phase 2: Experiment IPC ──────────────────────────────────────────────────

export type {
  Experiment,
  ExperimentRun,
  GoalCondition,
  GoalDirection,
  ExperimentStatus,
  RunStatus,
} from "../data/experiments"

async function createExperiment(
  workspaceRoot: string,
  row: import("../data/experiments").Experiment,
): Promise<void> {
  if (!tauriIsTauri()) return
  await invoke<void>("create_experiment", { workspaceRoot, row })
}

async function listExperiments(
  workspaceRoot: string,
): Promise<import("../data/experiments").Experiment[]> {
  if (!tauriIsTauri()) return []
  return invoke<import("../data/experiments").Experiment[]>(
    "list_experiments",
    { workspaceRoot },
  )
}

async function getExperiment(
  workspaceRoot: string,
  id: string,
): Promise<import("../data/experiments").Experiment | null> {
  if (!tauriIsTauri()) return null
  return invoke<import("../data/experiments").Experiment | null>(
    "get_experiment",
    { workspaceRoot, id },
  )
}

async function updateExperiment(
  workspaceRoot: string,
  row: import("../data/experiments").Experiment,
): Promise<void> {
  if (!tauriIsTauri()) return
  await invoke<void>("update_experiment", { workspaceRoot, row })
}

async function deleteExperiment(
  workspaceRoot: string,
  id: string,
): Promise<void> {
  if (!tauriIsTauri()) return
  await invoke<void>("delete_experiment", { workspaceRoot, id })
}

async function createExperimentRun(
  workspaceRoot: string,
  row: import("../data/experiments").ExperimentRun,
): Promise<void> {
  if (!tauriIsTauri()) return
  await invoke<void>("create_experiment_run", { workspaceRoot, row })
}

async function listExperimentRuns(
  workspaceRoot: string,
  experimentId: string,
): Promise<import("../data/experiments").ExperimentRun[]> {
  if (!tauriIsTauri()) return []
  return invoke<import("../data/experiments").ExperimentRun[]>(
    "list_experiment_runs",
    { workspaceRoot, experimentId },
  )
}

async function updateExperimentRun(
  workspaceRoot: string,
  id: string,
  status: string,
  metricsSummary: string,
): Promise<void> {
  if (!tauriIsTauri()) return
  await invoke<void>("update_experiment_run", {
    workspaceRoot,
    id,
    status,
    metricsSummary,
  })
}

/**
 * Launch an experiment run (alias for `createExperimentRun` — the Rust
 * side keeps `create_experiment_run` for backwards-compat with WS2-T4
 * but the spec calls this `launch_experiment_run` per §6.3).
 *
 * The Renderer can use either name; both forward to the same Tauri
 * command.
 */
async function launchExperimentRun(
  workspaceRoot: string,
  row: import("../data/experiments").ExperimentRun,
): Promise<void> {
  if (!tauriIsTauri()) return
  await invoke<void>("create_experiment_run", { workspaceRoot, row })
}

/**
 * Stop a running experiment run by id. Persists the row's status as
 * `stopped` and records a final timestamp. Idempotent — calling on
 * an already-stopped run is a no-op.
 */
async function stopExperimentRun(
  workspaceRoot: string,
  id: string,
): Promise<void> {
  if (!tauriIsTauri()) return
  await invoke<void>("stop_experiment_run", { workspaceRoot, id })
}

// ── Agent types (inlined from data/) ──────────────────────────────────────────
//
// These were previously in data/budget.ts, data/planner.ts, data/scaffolder.ts,
// data/memory.ts. The files were deleted in WS0-T1 because their Rust counterparts
// were removed (backend mock-wipe). The types stay here so the IPC bridge and
// BonafideAPI type keep compiling.

/** Escalation level for the budget governor. */
export type EscalationLevel = "normal" | "caution" | "critical" | "exhausted"

/** Budget status returned by `get_budget_status`. */
export interface BudgetStatus {
  workspaceHash: string
  budgetDollars: number
  budgetGpuHours: number
  spentDollars: number
  spentGpuHours: number
  escalation: EscalationLevel
  spendRatio: number
  requiresApproval: boolean
  currency?: string
}

/** Tool permission check result. */
export interface ToolPermission {
  allowed: boolean
  escalation: EscalationLevel
  requiresApproval: boolean
  message?: string
}

/** Input for experiment proposal. */
export interface ProposeExperimentInput {
  title: string
  hypothesis: string
  goalMetric: string
  goalDirection: "minimize" | "maximize"
  goalTarget: number
  goalCondition: "lt" | "gt" | "eq"
  budgetDollars: number
  budgetGpuHours: number
}

/** Output from experiment proposal. */
export interface ProposeExperimentOutput {
  experimentId: string
  title: string
  escalation: string
  withinBudget: boolean
  estimatedCost?: number
  warnings?: string[]
}

/** Template type for scaffold scripts. */
export type TemplateKind = "train_basic" | "sweep_lr" | "eval"

/** Input for scaffold_script. */
export interface ScaffoldInput {
  template: TemplateKind
  outputPath: string
  overrides?: Record<string, string>
}

/** Output from scaffold_script. */
export interface ScaffoldOutput {
  filePath: string
  template: string
  smokeTestTriggered: boolean
}

/** Result from run_smoke_test. */
export interface SmokeTestResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  summary: string
  testsRun?: number
  durationMs?: number
}

/** Confidence level for project memory entries. */
export type MemoryConfidence = "low" | "medium" | "high"

/** A stored insight from past experiments. */
export interface ProjectInsight {
  id: string
  workspaceHash: string
  finding: string
  evidence: string
  confidence: MemoryConfidence
  createdAt: number
}

/** A ruled-out hypothesis stored as a dead end. */
export interface ProjectDeadEnd {
  id: string
  workspaceHash: string
  hypothesis: string
  evidence: string
  triedRuns?: string[]
  createdAt: number
}

/** A single paper from arXiv. */
export interface ArxivPaper {
  id: string
  title: string
  authors: string[]
  abstract: string
  published: string
  categories: string[]
  pdfUrl: string
}

/** Result from arXiv search. */
export interface ArxivSearchResult {
  query: string
  results: ArxivPaper[]
  totalResults: number
}

/** Result of a critic code review. */
export interface CriticReview {
  score: number
  issues: string[]
  recommendations: string[]
  verdict: "pass" | "fail" | "skip"
  summary: string
  durationMs?: number
}

/** A detected anomaly in a run metric. */
export interface AnomalyEntry {
  metric: string
  kind: "spike" | "drop" | "plateau" | "drift"
  description: string
  severity: "low" | "medium" | "high"
  step: number
  value: number
}

/** Result from anomaly detection. */
export interface AnomalyReport {
  runId: string
  anomalies: AnomalyEntry[]
  summary: string
}

// ── Budget display constants (used by BudgetMeter.tsx) ──────────────────────

/** Color token for the budget meter bar, keyed by escalation level. */
export const BUDGET_COLORS: Record<EscalationLevel, string> = {
  normal: "bg-primary",
  caution: "bg-tertiary",
  critical: "bg-tertiary",
  exhausted: "bg-error",
}

/** Label shown next to the budget meter. */
export const BUDGET_LABELS: Record<EscalationLevel, string> = {
  normal: "Budget normal",
  caution: "Budget caution",
  critical: "Budget critical",
  exhausted: "Budget exhausted",
}

/** Text color for status messages. */
export const BUDGET_TEXT: Record<EscalationLevel, string> = {
  normal: "text-on-surface-variant",
  caution: "text-tertiary",
  critical: "text-tertiary",
  exhausted: "text-error",
}

async function getBudgetStatus(
  workspaceRoot: string,
): Promise<BudgetStatus> {
  if (!tauriIsTauri()) {
    return {
      workspaceHash: "preview",
      budgetDollars: 0,
      budgetGpuHours: 0,
      spentDollars: 0,
      spentGpuHours: 0,
      escalation: "normal",
      spendRatio: 0,
      requiresApproval: false,
      currency: "USD",
    }
  }
  return invoke<BudgetStatus>("get_budget_status", {
    workspaceRoot,
  })
}

async function updateBudget(
  workspaceRoot: string,
  budgetDollars: number,
  budgetGpuHours: number,
): Promise<BudgetStatus> {
  if (!tauriIsTauri()) {
    throw new Error("Budget updates require the Tauri backend")
  }
  return invoke<BudgetStatus>("update_budget", {
    workspaceRoot,
    budgetDollars,
    budgetGpuHours,
  })
}

async function recordToolCall(
  workspaceRoot: string,
  toolName: string,
): Promise<string> {
  if (!tauriIsTauri()) return "normal"
  return invoke<string>("record_tool_call", { workspaceRoot, toolName })
}

async function checkToolPermission(
  workspaceRoot: string,
  toolName: string,
): Promise<ToolPermission> {
  if (!tauriIsTauri()) {
    return { allowed: true, escalation: "normal", requiresApproval: false }
  }
  return invoke<ToolPermission>(
    "check_tool_permission",
    {
      workspaceRoot,
      toolName,
    },
  )
}

// ── Phase 2: Planner IPC ────────────────────────────────────────────────────

async function proposeExperiment(
  workspaceRoot: string,
  input: ProposeExperimentInput,
): Promise<ProposeExperimentOutput> {
  if (!tauriIsTauri()) {
    return {
      experimentId: `exp_preview_${Date.now()}`,
      title: input.title,
      withinBudget: false,
      escalation: "escalate",
      estimatedCost: 0,
      warnings: ["Budget requires Tauri backend"],
    }
  }
  return invoke<ProposeExperimentOutput>(
    "propose_experiment",
    {
      workspaceRoot,
      input,
    },
  )
}

/** List existing experiments so the planner can detect duplicates. */
async function listExperimentsForPlanner(
  workspaceRoot: string,
): Promise<import("../data/experiments").Experiment[]> {
  if (!tauriIsTauri()) return []
  return invoke<import("../data/experiments").Experiment[]>(
    "list_experiments_for_planner",
    { workspaceRoot },
  )
}

// ── Phase 2: Scaffolder IPC ─────────────────────────────────────────────────

async function scaffoldScript(
  workspaceRoot: string,
  input: ScaffoldInput,
): Promise<ScaffoldOutput> {
  if (!tauriIsTauri()) {
    return {
      filePath: `${workspaceRoot}/${input.outputPath}`,
      template: input.template,
      smokeTestTriggered: false,
    }
  }
  return invoke<ScaffoldOutput>(
    "scaffold_script",
    {
      workspaceRoot,
      input,
    },
  )
}

async function runSmokeTest(
  workspaceRoot: string,
  scriptPath: string,
  maxSteps?: number,
): Promise<SmokeTestResult> {
  if (!tauriIsTauri()) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: "(preview mode — smoke test requires Tauri backend)",
      timedOut: false,
      summary: "Skipped in browser preview",
      testsRun: 0,
      durationMs: 0,
    }
  }
  return invoke<SmokeTestResult>(
    "run_smoke_test",
    {
      workspaceRoot,
      scriptPath,
      maxSteps,
    },
  )
}

// ── Phase 3: Project Memory, Researcher, Critic, Monitoring ─────────────────

async function queryProjectMemory(
  workspaceRoot: string,
  kind?: "insight" | "dead_end",
): Promise<{
  insights: ProjectInsight[]
  deadEnds: ProjectDeadEnd[]
}> {
  if (!tauriIsTauri()) {
    return { insights: [], deadEnds: [] }
  }
  return invoke<{
    insights: ProjectInsight[]
    deadEnds: ProjectDeadEnd[]
  }>("query_project_memory", { workspaceRoot, kind })
}

async function writeProjectInsight(
  workspaceRoot: string,
  insight: Omit<ProjectInsight, "id" | "createdAt">,
): Promise<string> {
  if (!tauriIsTauri()) return "preview-id"
  return invoke<string>("write_project_insight", { workspaceRoot, insight })
}

async function writeProjectDeadEnd(
  workspaceRoot: string,
  deadEnd: Omit<ProjectDeadEnd, "id" | "createdAt">,
): Promise<string> {
  if (!tauriIsTauri()) return "preview-id"
  return invoke<string>("write_project_dead_end", { workspaceRoot, deadEnd })
}

/**
 * Unified project-memory write. Routes the call to `write_project_insight`
 * or `write_project_dead_end` based on `kind`. The renderer normally
 * uses the focused `writeProjectInsight` / `writeProjectDeadEnd`
 * helpers, but this entry point is convenient when the calling code
 * doesn't know the kind at compile time (e.g. a generic memory dumper).
 */
async function writeProjectMemory(
  workspaceRoot: string,
  kind: "insight" | "dead_end",
  content: string,
  confidence: MemoryConfidence,
  evidence: string,
): Promise<string> {
  if (kind === "dead_end") {
    return writeProjectDeadEnd(workspaceRoot, {
      workspaceHash: workspaceRoot,
      hypothesis: content,
      evidence,
    })
  }
  return writeProjectInsight(workspaceRoot, {
    workspaceHash: workspaceRoot,
    finding: content,
    evidence,
    confidence,
  })
}

async function searchArxiv(
  query: string,
  maxResults?: number,
): Promise<ArxivSearchResult> {
  if (!tauriIsTauri()) {
    return { query, results: [], totalResults: 0 }
  }
  return invoke<ArxivSearchResult>("search_arxiv", {
    query,
    maxResults,
  })
}

async function getArxivPaper(
  arxivId: string,
): Promise<ArxivPaper> {
  if (!tauriIsTauri()) {
    throw new Error("ArXiv not available in browser preview")
  }
  return invoke<ArxivPaper>("get_arxiv_paper", {
    arxivId,
  })
}

async function reviewCode(
  workspaceRoot: string,
  filePath: string,
  patch?: string,
): Promise<CriticReview> {
  if (!tauriIsTauri()) {
    return {
      score: 0,
      issues: [],
      recommendations: [],
      verdict: "skip",
      summary: "(preview mode — code review requires Tauri backend)",
      durationMs: 0,
    }
  }
  return invoke<CriticReview>("review_code", {
    workspaceRoot,
    filePath,
    patch,
  })
}

async function detectAnomalies(
  workspaceRoot: string,
  runId: string,
): Promise<AnomalyReport> {
  if (!tauriIsTauri()) {
    return { runId, anomalies: [], summary: "(browser preview)" }
  }
  return invoke<AnomalyReport>("detect_anomalies", {
    workspaceRoot,
    runId,
  })
}

// ── Phase 0.0: Settings store ──────────────────────────────────────────────
//
// Replaces hardcoded values in PreferencesWindow, SettingsSection, and
// BudgetMeter. Reads/writes ~/.bonafide/settings.json on the Rust side
// through `commands::settings::*`. The browser-preview fallbacks all
// return DEFAULT_SETTINGS so the UI renders with sane defaults instead
// of crashing.

import { DEFAULT_SETTINGS, type Settings as SettingsShape } from "../data/settings"

export type { Settings, ModelEndpoint } from "../data/settings"

async function getSettings(): Promise<SettingsShape> {
  if (!tauriIsTauri()) {
    return { ...DEFAULT_SETTINGS }
  }
  return invoke<SettingsShape>("get_settings")
}

/** Read a single setting key. Returns `null` if the key is absent. */
async function getSetting(key: string): Promise<unknown> {
  if (!tauriIsTauri()) return null
  return invoke<unknown>("get_setting", { key })
}

/**
 * Update a single setting key. The value is any JSON-serializable
 * primitive or object; the Rust side merges it into the typed
 * `Settings` struct via key-name dispatch.
 */
async function setSetting(key: string, value: unknown): Promise<void> {
  if (!tauriIsTauri()) return
  await invoke("set_setting", { key, value })
}

/** Persist the full settings object to ~/.bonafide/settings.json. */
async function setSettings(settings: SettingsShape): Promise<void> {
  if (!tauriIsTauri()) return
  await invoke("set_settings", { settings })
}

// ── Phase 0.0: Python interpreter detection ────────────────────────────────
//
// Replaces hardcoded Python values in SettingsSection. Walks the
// workspace `.venv`, then probes `$PATH`, then falls back to defaults.

/** A discovered Python package installed in the environment. */
export interface PackageInfo {
  name: string
  version: string
}

/** Full description of a discovered Python environment. */
export interface PythonEnvironment {
  interpreter: string | null
  version: string | null
  virtualEnv: string | null
  packages: PackageInfo[]
}

/**
 * Detect the best available Python interpreter for `workspaceRoot`.
 * Search order: `workspaceRoot/.venv` → `$PATH` (`python3`, `python`).
 * Returns an empty `PythonEnvironment` when no interpreter is found.
 */
async function detectPython(
  workspaceRoot?: string,
): Promise<PythonEnvironment> {
  if (!tauriIsTauri()) {
    return { interpreter: null, version: null, virtualEnv: null, packages: [] }
  }
  return invoke<PythonEnvironment>("detect_python", { workspaceRoot })
}

/** List all installed packages for a given interpreter path. */
async function listPythonPackages(interpreter: string): Promise<PackageInfo[]> {
  if (!tauriIsTauri()) return []
  return invoke<PackageInfo[]>("list_python_packages", { interpreter })
}

// ── Phase 0.0: GPU detection ───────────────────────────────────────────────
//
// Replaces the hardcoded GPU segment in BudgetMeter. Cross-platform:
// tries `nvidia-smi` first, then `rocm-smi` on Linux.

export interface GpuInfo {
  name: string
  /** 0–100 percent utilization. */
  utilizationPct: number
  /** Memory currently used, in megabytes. */
  memoryUsedMb: number
  /** Total GPU memory, in megabytes. */
  memoryTotalMb: number
}

export interface GpuVisibility {
  visible: boolean
  count: number
}

/** Detect all available GPUs on this machine. */
async function detectGpus(): Promise<GpuInfo[]> {
  if (!tauriIsTauri()) return []
  return invoke<GpuInfo[]>("detect_gpus")
}

/** Get GPU visibility state (called synchronously by BudgetMeter). */
async function getGpuVisibility(): Promise<GpuVisibility> {
  if (!tauriIsTauri()) return { visible: false, count: 0 }
  return invoke<GpuVisibility>("get_gpu_visibility")
}

// ── Phase 0.0: App info + cache ─────────────────────────────────────────────
//
// Replaces hardcoded cache size, version, paths in Settings. Returns
// `CARGO_PKG_VERSION`, git short hash, `dirs::cache_dir()`, etc.

/** Aggregate app metadata returned by `get_app_info`. */
export interface AppInfoBackend {
  /** Package version from Cargo.toml. */
  version: string
  /** Git short-hash from `git rev-parse --short HEAD`. */
  build: string
  /** `std::env::consts::OS`. */
  platform: string
  /** `std::env::consts::ARCH`. */
  arch: string
  /** Platform-specific cache directory. */
  cacheDir: string
  /** Path to the local SQLite DB. */
  dbPath: string
  /** IPC port (default 7654 for the local Tauri-side bridge). */
  ipcPort: number
  /** Path to the Python shim Unix-domain socket. */
  shimSocket: string
}

/** Return all app metadata for the renderer. */
async function getAppInfo(): Promise<AppInfoBackend> {
  if (!tauriIsTauri()) {
    return {
      version: "1.0.0",
      build: "preview",
      platform: typeof navigator !== "undefined" && navigator.platform
        ? (navigator.platform.toLowerCase().includes("mac")
            ? "darwin"
            : navigator.platform.toLowerCase().includes("linux")
              ? "linux"
              : "windows")
        : "windows",
      arch: "x86_64",
      cacheDir: "",
      dbPath: "",
      ipcPort: 7654,
      shimSocket: "",
    }
  }
  return invoke<AppInfoBackend>("get_app_info")
}

/** Recursively sum the size of all files in the cache directory. */
async function getCacheSize(): Promise<number> {
  if (!tauriIsTauri()) return 0
  return invoke<number>("get_cache_size")
}

/** Delete all files in the cache directory. Returns bytes cleared. */
async function clearCache(): Promise<number> {
  if (!tauriIsTauri()) return 0
  return invoke<number>("clear_cache")
}

/** Open a path in the platform's file manager (Explorer / Finder / xdg-open). */
async function openInFolder(path: string): Promise<void> {
  if (!tauriIsTauri()) return
  await invoke("open_in_folder", { path })
}

// ── Public API — same shape as the old electronAPI ────────────────────────

export const bonafide = {
  window: {
    minimize,
    toggleMaximize,
    isMaximized,
    close,
    onMaximizeChanged,
  },
  shell: {
    openExternal: shellOpenExternal,
  },
  app: {
    getInfo,
  },
  fs: {
    pickFolder,
    pickFile,
    readDirectory,
    readFile,
    writeFile,
    createFile,
    createFolder,
    rename,
    delete: deletePath,
  },
  watcher: {
    start: startWatcher,
    stop: stopWatcher,
    onEvent: onFsEvent,
  },
  lsp: {
    getBridgeUrl: getLspBridgeUrl,
    getServers: getLspServers,
    stopServer: stopLspServer,
  },
  linters: {
    ruffCheck,
  },
  pty: {
    getWsUrl: getPtyWsUrl,
    listProfiles: listTerminalProfiles,
  },
  git: {
    status: gitStatus,
    listBranches: gitListBranches,
    log: gitLog,
    diff: gitDiff,
    add: gitAdd,
    unstage: gitUnstage,
    discard: gitDiscard,
    commit: gitCommit,
    checkout: gitCheckout,
    pull: gitPull,
    push: gitPush,
    fetch: gitFetch,
    init: gitInit,
  },
  workspace: {
    open: openWorkspace,
    list: listWorkspaces,
    listRecent: listRecentWorkspaces,
    getRecent: getRecentWorkspace,
    addRecent: addRecentWorkspace,
  },
  account: {
    getTrackerStatus,
    getTrackerConfig,
    listServices,
    getUserProfile,
  },
  tracker: {
    connect: connectTracker,
    disconnect: disconnectTracker,
    test: testTrackerConnection,
    listRuns: listRuns,
    getRun: getRun,
    getMetricSeries: getMetricSeries,
    getRunConfig: getRunConfig,
    listArtifacts,
  },
  graph: {
    index: indexCodeGraph,
    query: queryCodeGraph,
    queryRunGraph,
  },
  appInfo: {
    get: getAppInfo,
    getCacheSize,
    clearCache,
    openInFolder,
  },
  settings: {
    getAll: getSettings,
    get: getSetting,
    set: setSetting,
    setAll: setSettings,
  },
  python: {
    detect: detectPython,
    listPackages: listPythonPackages,
  },
  gpu: {
    detect: detectGpus,
    getVisibility: getGpuVisibility,
  },
  agent: {
    listThreads,
    upsertThread,
    sendMessage: agentSendMessage,
    stopThread: agentStopThread,
    approveAction: agentApproveAction,
    rejectAction: agentRejectAction,
    createExperiment,
    listExperiments,
    getExperiment,
    updateExperiment,
    deleteExperiment,
    createExperimentRun,
    listExperimentRuns,
    updateExperimentRun,
    getBudgetStatus,
    updateBudget,
    recordToolCall,
    checkToolPermission,
    proposeExperiment,
    listExperimentsForPlanner,
    scaffoldScript,
    runSmokeTest,
    queryProjectMemory,
    writeProjectInsight,
    writeProjectDeadEnd,
    writeProjectMemory,
    launchExperimentRun,
    stopExperimentRun,
    searchArxiv,
    getArxivPaper,
    reviewCode,
    detectAnomalies,
  },
}

export type BonafideAPI = {
  window: {
    minimize: () => Promise<void>
    toggleMaximize: () => Promise<void>
    isMaximized: () => Promise<boolean>
    close: () => Promise<void>
    onMaximizeChanged: (cb: (maximized: boolean) => void) => () => void
  }
  shell: { openExternal: (url: string) => Promise<boolean> }
  app: { getInfo: () => Promise<AppInfo> }
  fs: {
    pickFolder: () => Promise<string | null>
    pickFile: () => Promise<string | null>
    readDirectory: (path: string) => Promise<DirListing>
    readFile: (path: string) => Promise<{ content: string }>
    writeFile: (path: string, content: string) => Promise<OpResult>
    createFile: (parentDir: string, name: string) => Promise<OpResult>
    createFolder: (parentDir: string, name: string) => Promise<OpResult>
    rename: (src: string, newName: string) => Promise<OpResult>
    delete: (target: string) => Promise<OpResult>
  }
  watcher: {
    start: (path: string) => Promise<void>
    stop: () => Promise<void>
    onEvent: (cb: (events: FsEvent[]) => void) => () => void
  }
  lsp: {
    getBridgeUrl: () => Promise<string | null>
    getServers: () => Promise<{ id: string status: string }[]>
    stopServer: (serverId: string) => Promise<void>
  }
  linters: { ruffCheck: (filePath: string) => Promise<string> }
  pty: {
    getWsUrl: () => Promise<string | null>
    listProfiles: () => Promise<TerminalProfile[]>
  }
  git: {
    status: (workspace: string) => Promise<GitStatus>
    listBranches: (workspace: string) => Promise<GitBranch[]>
    log: (workspace: string, maxCount?: number) => Promise<GitCommit[]>
    diff: (workspace: string, path?: string) => Promise<GitDiffResult>
    add: (workspace: string, paths: string[]) => Promise<GitOpResult>
    unstage: (workspace: string, paths: string[]) => Promise<GitOpResult>
    discard: (workspace: string, paths: string[]) => Promise<GitOpResult>
    commit: (workspace: string, message: string) => Promise<GitOpResult>
    checkout: (
      workspace: string,
      branch: string,
      create?: boolean,
    ) => Promise<GitOpResult>
    pull: (workspace: string) => Promise<GitOpResult>
    push: (workspace: string) => Promise<GitOpResult>
    fetch: (workspace: string) => Promise<GitOpResult>
    init: (workspace: string) => Promise<GitOpResult>
  }
  workspace: {
    open: (path: string) => Promise<Workspace>
    list: () => Promise<WorkspaceSummary[]>
    listRecent: () => Promise<RecentWorkspace[]>
    getRecent: (path: string) => Promise<RecentWorkspace | null>
    addRecent: (path: string) => Promise<void>
  }
  account: {
    getTrackerStatus: () => Promise<TrackerStatusRow[]>
    getTrackerConfig: (kind: TrackerKindFull) => Promise<TrackerConfig | null>
    listServices: () => Promise<ServiceStatus[]>
    getUserProfile: () => Promise<UserProfile | null>
  }
  tracker: {
    connect: (
      kind: TrackerKind,
      apiKey: string,
      workspaceRoot: string,
      project?: string,
    ) => Promise<string>
    disconnect: (kind: TrackerKind, workspaceRoot: string) => Promise<void>
    test: (kind: TrackerKind, workspaceRoot: string) => Promise<TrackerStatus>
    listRuns: (
      kind: TrackerKind,
      workspaceRoot: string,
      project: string,
      limit: number,
      cursor?: string,
    ) => Promise<RunPage>
    getRun: (
      kind: TrackerKind,
      workspaceRoot: string,
      runId: string,
    ) => Promise<RunDetail>
    getMetricSeries: (
      kind: TrackerKind,
      workspaceRoot: string,
      runId: string,
      key: string,
    ) => Promise<Point[]>
    getRunConfig: (
      kind: TrackerKind,
      workspaceRoot: string,
      runId: string,
    ) => Promise<RunConfig>
    listArtifacts: (
      kind: TrackerKind,
      workspaceRoot: string,
      runId: string,
    ) => Promise<ArtifactRef[]>
  }
  graph: {
    index: (workspaceRoot: string) => Promise<IndexSummary>
    query: (query: string, workspaceRoot: string) => Promise<CodeGraphHit[]>
    queryRunGraph: (
      workspaceRoot: string,
      framework?: string,
      dataset?: string,
    ) => Promise<RunGraphNode[]>
  }
  agent: {
    listThreads: (workspaceRoot: string) => Promise<ThreadRow[]>
    upsertThread: (row: ThreadRow) => Promise<void>
    sendMessage: (
      workspaceRoot: string,
      input: AgentSendMessageInput,
    ) => Promise<AgentSendMessageOutput>
    stopThread: (
      workspaceRoot: string,
      input: AgentStopThreadInput,
    ) => Promise<AgentStopThreadOutput>
    approveAction: (
      workspaceRoot: string,
      input: AgentApprovalInput,
    ) => Promise<AgentApprovalOutput>
    rejectAction: (
      workspaceRoot: string,
      input: AgentApprovalInput,
    ) => Promise<AgentApprovalOutput>
    createExperiment: (
      workspaceRoot: string,
      row: import("../data/experiments").Experiment,
    ) => Promise<void>
    listExperiments: (
      workspaceRoot: string,
    ) => Promise<import("../data/experiments").Experiment[]>
    getExperiment: (
      workspaceRoot: string,
      id: string,
    ) => Promise<import("../data/experiments").Experiment | null>
    updateExperiment: (
      workspaceRoot: string,
      row: import("../data/experiments").Experiment,
    ) => Promise<void>
    deleteExperiment: (workspaceRoot: string, id: string) => Promise<void>
    createExperimentRun: (
      workspaceRoot: string,
      row: import("../data/experiments").ExperimentRun,
    ) => Promise<void>
    listExperimentRuns: (
      workspaceRoot: string,
      experimentId: string,
    ) => Promise<import("../data/experiments").ExperimentRun[]>
    updateExperimentRun: (
      workspaceRoot: string,
      id: string,
      status: string,
      metricsSummary: string,
    ) => Promise<void>
    getBudgetStatus: (
      workspaceRoot: string,
    ) => Promise<BudgetStatus>
    updateBudget: (
      workspaceRoot: string,
      budgetDollars: number,
      budgetGpuHours: number,
    ) => Promise<BudgetStatus>
    recordToolCall: (workspaceRoot: string, toolName: string) => Promise<string>
    checkToolPermission: (
      workspaceRoot: string,
      toolName: string,
    ) => Promise<ToolPermission>
    proposeExperiment: (
      workspaceRoot: string,
      input: ProposeExperimentInput,
    ) => Promise<ProposeExperimentOutput>
    listExperimentsForPlanner: (
      workspaceRoot: string,
    ) => Promise<import("../data/experiments").Experiment[]>
    scaffoldScript: (
      workspaceRoot: string,
      input: ScaffoldInput,
    ) => Promise<ScaffoldOutput>
    runSmokeTest: (
      workspaceRoot: string,
      scriptPath: string,
      maxSteps?: number,
    ) => Promise<SmokeTestResult>
    queryProjectMemory: (
      workspaceRoot: string,
      kind?: "insight" | "dead_end",
    ) => Promise<{
      insights: ProjectInsight[]
      deadEnds: ProjectDeadEnd[]
    }>
    writeProjectInsight: (
      workspaceRoot: string,
      insight: Omit<
        ProjectInsight,
        "id" | "createdAt"
      >,
    ) => Promise<string>
    writeProjectDeadEnd: (
      workspaceRoot: string,
      deadEnd: Omit<ProjectDeadEnd, "id" | "createdAt">,
    ) => Promise<string>
    writeProjectMemory: (
      workspaceRoot: string,
      kind: "insight" | "dead_end",
      content: string,
      confidence: MemoryConfidence,
      evidence: string,
    ) => Promise<string>
    launchExperimentRun: (
      workspaceRoot: string,
      row: import("../data/experiments").ExperimentRun,
    ) => Promise<void>
    stopExperimentRun: (
      workspaceRoot: string,
      id: string,
    ) => Promise<void>
    searchArxiv: (
      query: string,
      maxResults?: number,
    ) => Promise<ArxivSearchResult>
    getArxivPaper: (
      arxivId: string,
    ) => Promise<ArxivPaper>
    reviewCode: (
      workspaceRoot: string,
      filePath: string,
      patch?: string,
    ) => Promise<CriticReview>
    detectAnomalies: (
      workspaceRoot: string,
      runId: string,
    ) => Promise<AnomalyReport>
  }
  appInfo: {
    get: () => Promise<import("./tauri").AppInfoBackend>
    getCacheSize: () => Promise<number>
    clearCache: () => Promise<number>
    openInFolder: (path: string) => Promise<void>
  }
  settings: {
    getAll: () => Promise<SettingsShape>
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    setAll: (settings: SettingsShape) => Promise<void>
  }
  python: {
    detect: (workspaceRoot?: string) => Promise<PythonEnvironment>
    listPackages: (interpreter: string) => Promise<PackageInfo[]>
  }
  gpu: {
    detect: () => Promise<GpuInfo[]>
    getVisibility: () => Promise<GpuVisibility>
  }
}
