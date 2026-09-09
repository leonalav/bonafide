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

import { invoke, isTauri as tauriIsTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openExternal } from "@tauri-apps/plugin-shell";

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
export { tauriIsTauri as isTauri };

// ── Types — keep camelCase to match the old preload's shape ────────────────

export type AppInfo = {
  version: string;
  name: string;
  platform: NodeJS.Platform;
  arch: string;
  // Tauri-specific fields; older Electron fields are dropped.
  tauri: string;
  webview: string;
  isPackaged: boolean;
  theme: "dark" | "light";
};

export type FileType =
  | "python" | "markdown" | "json" | "typescript" | "tsx"
  | "css" | "yaml" | "toml" | "shell" | "text";

export type FsNode = {
  id: string;
  name: string;
  kind: "folder" | "file";
  parentId: string | null;
  expanded?: boolean;
  fileType: FileType;
};

export type DirListing = {
  rootPath: string;
  rootName: string;
  files: FsNode[];
};

export type OpResult = { ok: boolean; path?: string };

/**
 * A file-system change event emitted by the Rust watcher. The shape
 * is a tagged union; the renderer's event listener switches on `type`.
 */
export type FsEvent =
  | { type: "created"; path: string; is_dir: boolean }
  | { type: "modified"; path: string }
  | { type: "removed"; path: string };

// ── IPC functions ──────────────────────────────────────────────────────────

async function pickFolder(): Promise<string | null> {
  if (!tauriIsTauri()) {
    console.warn("[bonafide] pickFolder called outside Tauri — returning null");
    return null;
  }
  try {
    const result = await openDialog({
      directory: true,
      multiple: false,
      title: "Open folder",
    });
    if (Array.isArray(result)) return result[0] ?? null;
    return result ?? null;
  } catch (err) {
    // Common causes: capability mismatch (window label not "main"), plugin not
    // registered, or CSP blocking the IPC. Log for devtools, return null so
    // the caller (openFolder in App.tsx) can show its own error toast.
    console.error("[bonafide] pickFolder failed:", err);
    return null;
  }
}

async function pickFile(): Promise<string | null> {
  if (!tauriIsTauri()) {
    console.warn("[bonafide] pickFile called outside Tauri — returning null");
    return null;
  }
  try {
    const result = await openDialog({
      directory: false,
      multiple: false,
      title: "Open file",
    });
    if (Array.isArray(result)) return result[0] ?? null;
    return result ?? null;
  } catch (err) {
    console.error("[bonafide] pickFile failed:", err);
    return null;
  }
}

async function readDirectory(dirPath: string): Promise<DirListing> {
  return invoke<DirListing>("read_directory", { path: dirPath });
}

async function readFile(filePath: string): Promise<{ content: string }> {
  return invoke<{ content: string }>("read_file", { path: filePath });
}

async function writeFile(filePath: string, content: string): Promise<OpResult> {
  return invoke<OpResult>("write_file", { path: filePath, content });
}

async function createFile(parentDir: string, name: string): Promise<OpResult> {
  return invoke<OpResult>("create_file", { parentDir, name });
}

async function createFolder(parentDir: string, name: string): Promise<OpResult> {
  return invoke<OpResult>("create_folder", { parentDir, name });
}

async function rename(src: string, newName: string): Promise<OpResult> {
  return invoke<OpResult>("rename_path", { src, newName });
}

async function deletePath(target: string): Promise<OpResult> {
  return invoke<OpResult>("delete_path", { target });
}

async function minimize(): Promise<void> {
  if (!tauriIsTauri()) return;
  await getCurrentWindow().minimize();
}

async function toggleMaximize(): Promise<void> {
  if (!tauriIsTauri()) return;
  const w = getCurrentWindow();
  if (await w.isMaximized()) await w.unmaximize();
  else await w.maximize();
}

async function isMaximized(): Promise<boolean> {
  if (!tauriIsTauri()) return false;
  return getCurrentWindow().isMaximized();
}

async function close(): Promise<void> {
  if (!tauriIsTauri()) return;
  await getCurrentWindow().close();
}

/**
 * Subscribe to window maximize/unmaximize events. The Tauri webview
 * emits `tauri://resize` and we derive the bool from comparing the
 * window's current maximized state.
 */
function onMaximizeChanged(cb: (maximized: boolean) => void): () => void {
  if (!tauriIsTauri()) return () => {};
  const w = getCurrentWindow();
  let lastState: boolean | null = null;
  const handler = async () => {
    const m = await w.isMaximized();
    if (m !== lastState) {
      lastState = m;
      cb(m);
    }
  };
  const unlistenResize = w.onResized(handler);
  // Initial sync — fires once if the window starts maximized.
  void handler();
  return async () => {
    await unlistenResize.then((f) => f());
  };
}

async function getInfo(): Promise<AppInfo> {
  if (!tauriIsTauri()) {
    return {
      version: "1.0.0",
      name: "Bonafide",
      platform: "win32",
      arch: "x64",
      tauri: "browser-preview",
      webview: navigator.userAgent,
      isPackaged: false,
      theme: "dark",
    };
  }
  // `tauriIsTauri()` checks for `window.isTauri` — the official flag set by
  // Tauri's webview at load time. When false we know this is the browser
  // preview; when true we know it's the real desktop shell.
  const tauriVersion = tauriIsTauri() ? "2.x" : "browser-preview";
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
    theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  };
}

async function shellOpenExternal(url: string): Promise<boolean> {
  if (!tauriIsTauri()) {
    try { window.open(url, "_blank", "noopener"); return true; }
    catch { return false; }
  }
  await openExternal(url);
  return true;
}

// ── File watcher (real-time file tree updates) ────────────────────────────

/** Start watching a workspace directory for file-system changes. */
async function startWatcher(path: string): Promise<void> {
  if (!tauriIsTauri()) return;
  return invoke<void>("start_watcher", { path });
}

/** Stop watching the current workspace. */
async function stopWatcher(): Promise<void> {
  if (!tauriIsTauri()) return;
  return invoke<void>("stop_watcher");
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
  if (!tauriIsTauri()) return () => {};
  let unlisten: (() => void) | null = null;
  void import("@tauri-apps/api/event").then(({ listen }) => {
    void listen<FsEvent[]>("fs:watcher", (e) => cb(e.payload)).then((fn) => {
      unlisten = fn;
    });
  });
  return () => {
    unlisten?.();
  };
}

// ── LSP bridge + ruff CLI ──────────────────────────────────────────────────

/** Get the WebSocket URL of the LSP bridge hosted by the Tauri backend. */
async function getLspBridgeUrl(): Promise<string> {
  if (!tauriIsTauri()) {
    // Fall back to a localhost URL when running standalone in the browser.
    return "ws://127.0.0.1:9877";
  }
  return invoke<string>("get_lsp_bridge_url");
}

/** Get the list of running LSP servers (serverId + rootUri). */
async function getLspServers(): Promise<{ id: string; status: string }[]> {
  if (!tauriIsTauri()) return [];
  return invoke<{ id: string; status: string }[]>("get_lsp_servers");
}

/** Stop a running LSP server by id. */
async function stopLspServer(serverId: string): Promise<void> {
  if (!tauriIsTauri()) return;
  await invoke("stop_lsp_server", { serverId });
}

/**
 * Run `ruff check` on a file via the Tauri backend.
 * Returns the raw JSON output (empty array when no issues).
 */
async function ruffCheck(filePath: string): Promise<string> {
  if (!tauriIsTauri()) return "[]";
  return invoke<string>("ruff_check", { filePath });
}

/** Get the WebSocket URL for the PTY bridge (xterm.js terminal sessions). */
async function getPtyWsUrl(): Promise<string> {
  if (!tauriIsTauri()) return "ws://127.0.0.1:9878";
  return invoke<string>("get_pty_ws_url");
}

/** One available terminal shell profile (cmd, powershell, pwsh, git-bash…). */
export type TerminalProfile = {
  id: string;
  label: string;
  program: string;
  args: string[];
  available: boolean;
};

/**
 * List the shell profiles detected on this machine. The renderer uses
 * this to populate the "+ Launch Profile" dropdown in the Terminal panel.
 */
async function listTerminalProfiles(): Promise<TerminalProfile[]> {
  if (!tauriIsTauri()) {
    // Browser preview fallback: return a single demo profile so the UI
    // still renders. The "Connect" button won't actually spawn a shell,
    // but the dropdown won't be empty.
    return [
      {
        id: "demo",
        label: "Demo (browser preview)",
        program: "",
        args: [],
        available: true,
      },
    ];
  }
  return invoke<TerminalProfile[]>("list_terminal_profiles");
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
  path: string;
  /** M = modified, A = added, D = deleted, R = renamed, C = copied,
   *  T = type-change, U = untracked, I = ignored. */
  status: string;
  staged: boolean;
  /** Original path when status === "R"; empty otherwise. */
  originalPath: string;
};

export type GitStatus = {
  branch: string;
  upstream: string;
  ahead: number;
  /** -1 when no upstream is configured. */
  behind: number;
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: GitStatusEntry[];
};

export type GitBranch = {
  name: string;
  shortHash: string;
  subject: string;
  isoDate: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream: string;
  ahead: number;
  behind: number;
};

export type GitCommit = {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  isoDate: string;
  isHead: boolean;
};

export type GitDiffFile = {
  path: string;
  oldText: string;
  newText: string;
};

export type GitDiffResult = {
  /** Raw unified diff text (empty when there are no changes). */
  diff: string;
  /** Per-file old/new text pairs ready for MergeViewEditor. */
  files: GitDiffFile[];
};

export type GitOpResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  message: string;
};

async function gitStatus(workspace: string): Promise<GitStatus> {
  if (!tauriIsTauri()) return emptyGitStatus();
  return invoke<GitStatus>("git_status", { workspace });
}

async function gitListBranches(workspace: string): Promise<GitBranch[]> {
  if (!tauriIsTauri()) return [];
  return invoke<GitBranch[]>("git_list_branches", { workspace });
}

async function gitLog(workspace: string, maxCount = 50): Promise<GitCommit[]> {
  if (!tauriIsTauri()) return [];
  return invoke<GitCommit[]>("git_log", { workspace, maxCount });
}

async function gitDiff(workspace: string, path?: string): Promise<GitDiffResult> {
  if (!tauriIsTauri()) return { diff: "", files: [] };
  return invoke<GitDiffResult>("git_diff", { workspace, path });
}

async function gitAdd(workspace: string, paths: string[]): Promise<GitOpResult> {
  if (!tauriIsTauri()) return { ok: false, stdout: "", stderr: "not in Tauri", message: "" };
  return invoke<GitOpResult>("git_add", { workspace, paths });
}

async function gitUnstage(workspace: string, paths: string[]): Promise<GitOpResult> {
  if (!tauriIsTauri()) return { ok: false, stdout: "", stderr: "not in Tauri", message: "" };
  return invoke<GitOpResult>("git_unstage", { workspace, paths });
}

async function gitDiscard(workspace: string, paths: string[]): Promise<GitOpResult> {
  if (!tauriIsTauri()) return { ok: false, stdout: "", stderr: "not in Tauri", message: "" };
  return invoke<GitOpResult>("git_discard", { workspace, paths });
}

async function gitCommit(workspace: string, message: string): Promise<GitOpResult> {
  if (!tauriIsTauri()) return { ok: false, stdout: "", stderr: "not in Tauri", message: "" };
  return invoke<GitOpResult>("git_commit", { workspace, message });
}

async function gitCheckout(workspace: string, branch: string, create = false): Promise<GitOpResult> {
  if (!tauriIsTauri()) return { ok: false, stdout: "", stderr: "not in Tauri", message: "" };
  return invoke<GitOpResult>("git_checkout", { workspace, branch, create });
}

async function gitPull(workspace: string): Promise<GitOpResult> {
  if (!tauriIsTauri()) return { ok: false, stdout: "", stderr: "not in Tauri", message: "" };
  return invoke<GitOpResult>("git_pull", { workspace });
}

async function gitPush(workspace: string): Promise<GitOpResult> {
  if (!tauriIsTauri()) return { ok: false, stdout: "", stderr: "not in Tauri", message: "" };
  return invoke<GitOpResult>("git_push", { workspace });
}

async function gitFetch(workspace: string): Promise<GitOpResult> {
  if (!tauriIsTauri()) return { ok: false, stdout: "", stderr: "not in Tauri", message: "" };
  return invoke<GitOpResult>("git_fetch", { workspace });
}

async function gitInit(workspace: string): Promise<GitOpResult> {
  if (!tauriIsTauri()) return { ok: false, stdout: "", stderr: "not in Tauri", message: "" };
  return invoke<GitOpResult>("git_init", { workspace });
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
  };
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
};

export type BonafideAPI = {
  window: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    close: () => Promise<void>;
    onMaximizeChanged: (cb: (maximized: boolean) => void) => () => void;
  };
  shell: { openExternal: (url: string) => Promise<boolean> };
  app: { getInfo: () => Promise<AppInfo> };
  fs: {
    pickFolder: () => Promise<string | null>;
    pickFile: () => Promise<string | null>;
    readDirectory: (path: string) => Promise<DirListing>;
    readFile: (path: string) => Promise<{ content: string }>;
    writeFile: (path: string, content: string) => Promise<OpResult>;
    createFile: (parentDir: string, name: string) => Promise<OpResult>;
    createFolder: (parentDir: string, name: string) => Promise<OpResult>;
    rename: (src: string, newName: string) => Promise<OpResult>;
    delete: (target: string) => Promise<OpResult>;
  };
  watcher: {
    start: (path: string) => Promise<void>;
    stop: () => Promise<void>;
    onEvent: (cb: (events: FsEvent[]) => void) => () => void;
  };
  lsp: {
    getBridgeUrl: () => Promise<string>;
    getServers: () => Promise<{ id: string; status: string }[]>;
    stopServer: (serverId: string) => Promise<void>;
  };
  linters: { ruffCheck: (filePath: string) => Promise<string> };
  pty: { getWsUrl: () => Promise<string>; listProfiles: () => Promise<TerminalProfile[]> };
  git: {
    status: (workspace: string) => Promise<GitStatus>;
    listBranches: (workspace: string) => Promise<GitBranch[]>;
    log: (workspace: string, maxCount?: number) => Promise<GitCommit[]>;
    diff: (workspace: string, path?: string) => Promise<GitDiffResult>;
    add: (workspace: string, paths: string[]) => Promise<GitOpResult>;
    unstage: (workspace: string, paths: string[]) => Promise<GitOpResult>;
    discard: (workspace: string, paths: string[]) => Promise<GitOpResult>;
    commit: (workspace: string, message: string) => Promise<GitOpResult>;
    checkout: (workspace: string, branch: string, create?: boolean) => Promise<GitOpResult>;
    pull: (workspace: string) => Promise<GitOpResult>;
    push: (workspace: string) => Promise<GitOpResult>;
    fetch: (workspace: string) => Promise<GitOpResult>;
    init: (workspace: string) => Promise<GitOpResult>;
  };
};
