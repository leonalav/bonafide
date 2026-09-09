/**
 * store.ts - IdeStore: the single source of truth for all IDE state.
 *
 * Architecture:
 *   IdeStore class (plain, no React) -> useSyncExternalStore -> React components
 *
 * The class exposes getState() / dispatch() / subscribe() so React 19's
 * concurrent rendering cannot cause tearing when tabs, context menu, and
 * tree state all mutate in the same render pass.
 */

import {
  createContext,
  type ReactNode,
  useContext,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  type FileNode,
  createFile,
  createFolder,
  renameNode,
  deleteNode,
  findNode,
  toggleCollapse,
  collapseAll,
  expandAll,
  moveFocus,
  nameExists,
  countDescendants,
  applyFsEvents,
  removedFileIds,
  type LangId,
} from "./fileTree";

// Tab type
export type Tab = {
  id: string;
  fileId: string;
  name: string;
  dirty: boolean;
  pinned?: boolean;
};

// Toast type
export type Toast = {
  id: string;
  message: string;
  tone: "info" | "success" | "error";
  ttlMs: number;
};

// Context menu type
export type ContextMenuState =
  | { surface: "tree"; targetId: string; x: number; y: number }
  | { surface: "tab"; targetId: string; x: number; y: number }
  | { surface: "editor"; targetId: string | null; x: number; y: number }
  | null;

// Modal type
export type ModalState =
  | {
      kind: "delete";
      fileId: string;
      name: string;
      isFolder: boolean;
      descendantCount: number;
    }
  | { kind: "closeDirty"; tabId: string; fileId: string; name: string }
  | null;

// ── Panel types ───────────────────────────────────────────────────────────

/** A diagnostic from the Problems tab. */
export type DiagnosticEntry = {
  id: string;
  fileId: string | null;
  /** Human-readable file path (relative to workspace root). */
  fileLabel: string;
  line: number;
  col: number;
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  source: "pyright" | "ruff" | "mlflow" | string;
};

export type PanelTab = "problems" | "output" | "terminal" | "debug" | "ports";

/** A single xterm.js PTY session inside the Terminal panel. */
export type TerminalSession = {
  /** Stable id for React keys and store mutations. */
  id: string;
  /** Profile id (e.g. "powershell", "cmd"). Used to label the tab. */
  profileId: string;
  /** Human-readable label (e.g. "PowerShell", "Command Prompt"). */
  profileLabel: string;
  /** Absolute path the shell should start in. May be null when no
   * workspace is open — the shell falls back to the inherited cwd. */
  cwd: string | null;
  /** "spawning" → handshake with backend; "ready" → shell prompt visible;
   * "exited" → child process ended; "error" → failed to connect. */
  status: "spawning" | "ready" | "exited" | "error";
};

export type IdeState = {
  /** Absolute path of the open workspace root, or null if none is open. */
  workspaceRoot: string | null;
  /** Display name of the workspace root (basename). */
  workspaceName: string | null;
  fileTree: FileNode[];
  tabs: Tab[];
  activeTabId: string | null;
  focusedNodeId: string | null;
  collapsed: Record<string, boolean>;
  contextMenu: ContextMenuState;
  modal: ModalState;
  toasts: Toast[];
  closedTabsStack: Tab[];
  untitledCounter: number;
  treeEmpty: boolean;
  /**
   * Active merge review sessions. Keyed by review id. A review holds the
   * original + proposed content for a file the AI agent wants to patch.
   * Reviews render in the EditorPane when the corresponding merge tab is
   * active.
   */
  mergeReviews: MergeReview[];
  /** Panel (bottom dock) state. */
  panel: {
    open: boolean;
    tab: PanelTab;
    height: number; // px
    /** Aggregated diagnostics for the Problems tab. */
    diagnostics: DiagnosticEntry[];
    /** Output log entries. */
    outputLogs: string[];
    /** Active terminal sessions inside the Terminal panel tab. */
    terminalSessions: TerminalSession[];
    /** Currently focused terminal session (drives which xterm is shown). */
    activeTerminalId: string | null;
  };
};

export type MergeReview = {
  /** Unique id for this review session. */
  id: string;
  /** Absolute path of the file being patched. */
  absPath: string;
  /** The current on-disk + in-editor content (left pane of the diff). */
  originalText: string;
  /** The AI agent's proposed content (right pane of the diff). */
  proposedText: string;
  /** When the review was created. */
  createdAt: number;
  /** Source label (e.g. "agent patch", "lint autofix"). */
  source: string;
};

// IdeAction
export type IdeAction =
  | { type: "ADD_FILE"; parentId: string | null; name: string }
  | { type: "ADD_FOLDER"; parentId: string | null; name: string }
  | { type: "RENAME"; nodeId: string; name: string }
  | { type: "DELETE"; nodeId: string }
  | { type: "TOGGLE_COLLAPSE"; nodeId: string }
  | { type: "COLLAPSE_ALL" }
  | { type: "EXPAND_ALL" }
  | { type: "OPEN_FILE"; fileId: string }
  | { type: "OPEN_UNTITLED" }
  | { type: "OPEN_VIRTUAL_TAB"; virtualId: "chart" | "experiments"; name: string }
  | { type: "CLOSE_TAB"; tabId: string; force?: boolean }
  | { type: "REOPEN_CLOSED_TAB" }
  | { type: "ACTIVATE_TAB"; tabId: string }
  | { type: "CLOSE_OTHERS"; keepTabId: string }
  | { type: "CLOSE_ALL" }
  | { type: "SET_CONTENT"; fileId: string; content: string }
  | { type: "MARK_DIRTY"; tabId: string; dirty: boolean }
  | { type: "FOCUS_NODE"; nodeId: string }
  | { type: "MOVE_FOCUS"; delta: -1 | 1 }
  | { type: "OPEN_CONTEXT_MENU"; payload: ContextMenuState }
  | { type: "CLOSE_CONTEXT_MENU" }
  | { type: "OPEN_MODAL"; payload: ModalState }
  | { type: "CLOSE_MODAL" }
  | { type: "PUSH_TOAST"; toast: Omit<Toast, "id"> }
  | { type: "DISMISS_TOAST"; id: string }
  | { type: "OPEN_WORKSPACE"; rootPath: string; rootName: string; tree: FileNode[] }
  | { type: "CLOSE_WORKSPACE" }
  // Real-time file watcher: applies a batch of file-system events
  // (created, modified, removed) reported by the Rust watcher.
  | { type: "APPLY_FS_EVENTS"; events: import("../ipc/tauri").FsEvent[] }
  | { type: "MOVE_TAB"; tabId: string; direction: "left" | "right" }
  | { type: "TOGGLE_PIN"; tabId: string }
  | { type: "CLOSE_TABS_TO_RIGHT"; tabId: string }
  // Merge review lifecycle
  | {
      type: "OPEN_MERGE_REVIEW";
      absPath: string;
      originalText: string;
      proposedText: string;
      source?: string;
    }
  | { type: "CLOSE_MERGE_REVIEW"; reviewId: string }
  | { type: "RESOLVE_MERGE_REVIEW"; reviewId: string; mergedText: string }
  // Panel
  | { type: "TOGGLE_PANEL" }
  | { type: "SET_PANEL_TAB"; tab: PanelTab }
  | { type: "SET_PANEL_HEIGHT"; height: number }
  | { type: "SET_DIAGNOSTICS"; diagnostics: DiagnosticEntry[] }
  | { type: "APPEND_OUTPUT"; line: string }
  | { type: "CLEAR_OUTPUT" }
  // Terminal sessions
  | { type: "ADD_TERMINAL_SESSION"; session: TerminalSession }
  | { type: "REMOVE_TERMINAL_SESSION"; id: string }
  | { type: "ACTIVATE_TERMINAL_SESSION"; id: string }
  | { type: "SET_TERMINAL_STATUS"; id: string; status: TerminalSession["status"] };

// Toast helper
let toastCounter = 0;
function makeToast(partial: Omit<Toast, "id">): Toast {
  return { ...partial, id: `toast_${++toastCounter}_${Date.now()}` };
}

export function makeInitialState(): IdeState {
  return {
    workspaceRoot: null,
    workspaceName: null,
    fileTree: [],
    tabs: [],
    activeTabId: null,
    focusedNodeId: null,
    collapsed: {},
    contextMenu: null,
    modal: null,
    toasts: [],
    closedTabsStack: [],
    untitledCounter: 0,
    treeEmpty: true,
    mergeReviews: [],
    panel: {
      open: false,
      tab: "problems",
      height: 240,
      diagnostics: [],
      outputLogs: [],
      terminalSessions: [],
      activeTerminalId: null,
    },
  };
}

// ── Optional performance instrumentation ──────────────────────────────────
// Set `localStorage.__BONAFIDE_PERF__ = "1"` in devtools to enable
// per-dispatch timing logs sent to a local debug server on
// `localhost:7750`. When unset (the default) the store hooks skip
// the timing entirely — the previous version fired an unconditional
// fetch on every reducer call, every selector snapshot, and every
// App render. On a file-switch that fires dozens of fetches per
// second, each of which times out because nothing is listening —
// turning what should be a sub-second interaction into a multi-second
// one in dev mode.
function isPerfEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage?.getItem("__BONAFIDE_PERF__") === "1";
  } catch {
    return false;
  }
}
const PERF_ENABLED = isPerfEnabled();
function perfLog(location: string, message: string, data: Record<string, unknown>): void {
  if (!PERF_ENABLED) return;
  fetch("http://127.0.0.1:7750/ingest/8d618420-3b75-4343-9d6c-c42e01f4bae7", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "5197ca" },
    body: JSON.stringify({
      sessionId: "5197ca",
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      location,
      message,
      data,
      runId: "run1",
      hypothesisId: "C",
    }),
  }).catch(() => {});
}

export function reduce(state: IdeState, action: IdeAction): IdeState {
  if (!PERF_ENABLED) return _reduce(state, action);
  const t0 = performance.now();
  const result = _reduce(state, action);
  const ms = performance.now() - t0;
  perfLog("IdeStore", "reduce", { actionType: action.type, ms });
  return result;
}

// Internal reduce implementation
function _reduce(state: IdeState, action: IdeAction): IdeState {
  switch (action.type) {
    case "ADD_FILE": {
      const { parentId, name } = action;
      if (!name.trim()) return state;
      if (nameExists(state.fileTree, parentId, name)) {
        return {
          ...state,
          toasts: [
            ...state.toasts,
            makeToast({ message: `"${name}" already exists`, tone: "error", ttlMs: 2400 }),
          ],
        };
      }
      const { tree, file } = createFile(state.fileTree, parentId, name);
      const newTab: Tab = {
        id: `tab_${Date.now()}`,
        fileId: file.id,
        name: file.name,
        dirty: false,
      };
      return {
        ...state,
        fileTree: tree,
        tabs: [...state.tabs, newTab],
        activeTabId: newTab.id,
        contextMenu: null,
      };
    }

    case "ADD_FOLDER": {
      const { parentId, name } = action;
      if (!name.trim()) return state;
      if (nameExists(state.fileTree, parentId, name)) {
        return {
          ...state,
          toasts: [
            ...state.toasts,
            makeToast({ message: `"${name}" already exists`, tone: "error", ttlMs: 2400 }),
          ],
        };
      }
      const { tree } = createFolder(state.fileTree, parentId, name);
      return { ...state, fileTree: tree, contextMenu: null };
    }

    case "RENAME": {
      const { nodeId, name } = action;
      const result = renameNode(state.fileTree, nodeId, name);
      if (!result.ok) {
        const tone = result.reason === "exists" ? "error" : "info";
        return {
          ...state,
          toasts: [
            ...state.toasts,
            makeToast({
              message: result.reason === "exists" ? "Name already taken" : "Invalid name",
              tone,
              ttlMs: 2400,
            }),
          ],
        };
      }
      const renamedNode = result.node;
      const tabs = state.tabs.map((t) =>
        t.fileId === nodeId ? { ...t, name: renamedNode.name, fileId: renamedNode.id } : t,
      );
      const activeTab = tabs.find((t) => t.id === state.activeTabId);
      return {
        ...state,
        fileTree: result.tree,
        tabs,
        activeTabId: activeTab ? activeTab.id : state.activeTabId,
        contextMenu: null,
      };
    }

    case "DELETE": {
      const { nodeId } = action;
      const { tree, removed } = deleteNode(state.fileTree, nodeId);
      const deletedIds = new Set(removed.filter((n) => n.kind === "file").map((n) => n.id));
      const tabs = state.tabs.filter((t) => !deletedIds.has(t.fileId));
      let { activeTabId } = state;
      if (activeTabId && !tabs.find((t) => t.id === activeTabId)) {
        activeTabId = tabs.length > 0 ? tabs[tabs.length - 1].id : null;
      }
      return {
        ...state,
        fileTree: tree,
        tabs,
        activeTabId,
        modal: null,
        contextMenu: null,
        treeEmpty: tree.length === 0,
      };
    }

    case "TOGGLE_COLLAPSE": {
      const { nodeId } = action;
      // `walkVisible` now only reads `collapsed` (not `node.expanded`), so
      // we only need to update the map here. The `node.expanded` field is
      // kept in sync via toggleCollapse for future-proofing, but it's no
      // longer the source of truth for tree visibility.
      const currentlyCollapsed = !!state.collapsed[nodeId];
      return {
        ...state,
        fileTree: toggleCollapse(state.fileTree, nodeId),
        collapsed: {
          ...state.collapsed,
          [nodeId]: !currentlyCollapsed,
        },
      };
    }

    case "COLLAPSE_ALL": {
      return {
        ...state,
        fileTree: collapseAll(state.fileTree),
        collapsed: {},
      };
    }

    case "EXPAND_ALL": {
      return {
        ...state,
        fileTree: expandAll(state.fileTree),
        collapsed: {},
      };
    }

    case "OPEN_FILE": {
      const { fileId } = action;
      const existingTab = state.tabs.find((t) => t.fileId === fileId);
      if (existingTab) {
        return { ...state, activeTabId: existingTab.id, contextMenu: null };
      }
      const file = findNode(state.fileTree, (n) => n.id === fileId);
      if (!file || file.kind !== "file") return { ...state, contextMenu: null };
      const newTab: Tab = {
        id: `tab_${Date.now()}`,
        fileId: file.id,
        name: file.name,
        dirty: false,
      };
      return {
        ...state,
        tabs: [...state.tabs, newTab],
        activeTabId: newTab.id,
        contextMenu: null,
      };
    }

    case "OPEN_UNTITLED": {
      const counter = state.untitledCounter + 1;
      const name = `untitled-${counter}`;
      const virtualParentId = "__untitled";
      let fileTree = state.fileTree;
      const virtualParent = fileTree.find((n) => n.id === virtualParentId);
      if (!virtualParent) {
        fileTree = [
          ...fileTree,
          {
            id: virtualParentId,
            name: "__untitled/",
            kind: "folder",
            parentId: null,
            expanded: true,
            fileType: "text",
          },
        ];
      }
      const fileId = `${virtualParentId}/${name}.py`;
      const newFile: FileNode = {
        id: fileId,
        name: `${name}.py`,
        kind: "file",
        parentId: virtualParentId,
        fileType: "python",
        content: "",
      };
      const newTab: Tab = {
        id: `tab_${Date.now()}`,
        fileId,
        name: `${name}.py`,
        dirty: false,
      };
      return {
        ...state,
        fileTree: [...fileTree, newFile],
        tabs: [...state.tabs, newTab],
        activeTabId: newTab.id,
        untitledCounter: counter,
        contextMenu: null,
      };
    }

    case "OPEN_VIRTUAL_TAB": {
      const { virtualId, name } = action;
      const fileId = `__virtual__/${virtualId}`;
      const existingTab = state.tabs.find((t) => t.fileId === fileId);
      if (existingTab) {
        return { ...state, activeTabId: existingTab.id, contextMenu: null };
      }
      const newTab: Tab = {
        id: `tab_${Date.now()}`,
        fileId,
        name,
        dirty: false,
      };
      return {
        ...state,
        tabs: [...state.tabs, newTab],
        activeTabId: newTab.id,
        contextMenu: null,
      };
    }

    case "CLOSE_TAB": {
      const { tabId, force } = action;
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return state;
      if (tab.dirty && !force) {
        return {
          ...state,
          modal: {
            kind: "closeDirty",
            tabId: tab.id,
            fileId: tab.fileId,
            name: tab.name,
          },
        };
      }
      const closedStack =
        tab.dirty && force
          ? state.closedTabsStack.slice(0, 19)
          : [tab, ...state.closedTabsStack].slice(0, 20);
      const tabs = state.tabs.filter((t) => t.id !== tabId);
      let { activeTabId } = state;
      if (activeTabId === tabId) {
        const idx = state.tabs.findIndex((t) => t.id === tabId);
        const next = tabs[idx] ?? tabs[idx - 1] ?? null;
        activeTabId = next ? next.id : null;
      }
      return {
        ...state,
        tabs,
        activeTabId,
        closedTabsStack: closedStack,
        contextMenu: null,
        modal: null,
      };
    }

    case "REOPEN_CLOSED_TAB": {
      if (state.closedTabsStack.length === 0) return state;
      const [tab, ...rest] = state.closedTabsStack;
      return {
        ...state,
        tabs: [...state.tabs, tab],
        activeTabId: tab.id,
        closedTabsStack: rest,
      };
    }

    case "CLOSE_OTHERS": {
      const { keepTabId } = action;
      const toClose = state.tabs.filter((t) => t.id !== keepTabId);
      const closedStack = [...toClose, ...state.closedTabsStack].slice(0, 20);
      return {
        ...state,
        tabs: state.tabs.filter((t) => t.id === keepTabId),
        activeTabId: keepTabId,
        closedTabsStack: closedStack,
        contextMenu: null,
        modal: null,
      };
    }

    case "CLOSE_ALL": {
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
      if (activeTab) {
        return {
          ...state,
          tabs: [activeTab],
          activeTabId: activeTab.id,
          contextMenu: null,
          modal: null,
        };
      }
      return { ...state, tabs: [], activeTabId: null };
    }

    case "ACTIVATE_TAB": {
      return { ...state, activeTabId: action.tabId, contextMenu: null };
    }

    case "MOVE_TAB": {
      const { tabId, direction } = action;
      const idx = state.tabs.findIndex((t) => t.id === tabId);
      if (idx < 0) return state;
      const tabs = [...state.tabs];
      const newIdx = direction === "right" ? idx + 1 : idx - 1;
      if (newIdx < 0 || newIdx >= tabs.length) return state;
      [tabs[idx], tabs[newIdx]] = [tabs[newIdx], tabs[idx]];
      return { ...state, tabs };
    }

    case "TOGGLE_PIN": {
      const { tabId } = action;
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === tabId ? { ...t, pinned: !t.pinned } : t,
        ),
      };
    }

    case "CLOSE_TABS_TO_RIGHT": {
      const { tabId } = action;
      const idx = state.tabs.findIndex((t) => t.id === tabId);
      if (idx < 0) return state;
      const toClose = state.tabs.slice(idx + 1);
      const closedStack = [...toClose, ...state.closedTabsStack].slice(0, 20);
      return {
        ...state,
        tabs: state.tabs.slice(0, idx + 1),
        closedTabsStack: closedStack,
        contextMenu: null,
        modal: null,
      };
    }

    case "SET_CONTENT": {
      const { fileId, content } = action;
      // SET_CONTENT must leave `dirty` untouched. Editors (e.g. the seed-
      // from-disk path when opening a file, the save handler in
      // EditorPane) push content into the store for reasons unrelated to
      // user edits; only the editor's on-change handler should ever flip
      // a tab dirty, via MARK_DIRTY.
      return {
        ...state,
        fileTree: state.fileTree.map((n) =>
          n.id === fileId ? { ...n, content } : n,
        ),
      };
    }

    case "MARK_DIRTY": {
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.tabId ? { ...t, dirty: action.dirty } : t,
        ),
      };
    }

    case "FOCUS_NODE": {
      return { ...state, focusedNodeId: action.nodeId };
    }

    case "MOVE_FOCUS": {
      const next = moveFocus(
        state.fileTree,
        state.focusedNodeId,
        action.delta,
        state.collapsed,
      );
      return next ? { ...state, focusedNodeId: next } : state;
    }

    case "OPEN_CONTEXT_MENU": {
      return { ...state, contextMenu: action.payload };
    }

    case "CLOSE_CONTEXT_MENU": {
      return { ...state, contextMenu: null };
    }

    case "OPEN_MODAL": {
      return { ...state, modal: action.payload };
    }

    case "CLOSE_MODAL": {
      return { ...state, modal: null };
    }

    case "PUSH_TOAST": {
      return {
        ...state,
        toasts: [...state.toasts, makeToast(action.toast)],
      };
    }

    case "DISMISS_TOAST": {
      return {
        ...state,
        toasts: state.toasts.filter((t) => t.id !== action.id),
      };
    }

    case "OPEN_WORKSPACE": {
      return {
        ...state,
        workspaceRoot: action.rootPath,
        workspaceName: action.rootName,
        fileTree: action.tree,
        tabs: [],
        activeTabId: null,
        collapsed: {},
        focusedNodeId: null,
        contextMenu: null,
        modal: null,
        closedTabsStack: [],
        treeEmpty: action.tree.length === 0,
      };
    }

    // Real-time file watcher: applies a debounced batch of events from
    // the Rust notify watcher. Idempotent — applying the same event twice
    // is safe (e.g. on platforms where FSEvents double-fires). The
    // watcher also auto-creates parent folders, so a `created` for a
    // deeply-nested file that arrived before its parent's `created` will
    // still insert correctly.
    case "APPLY_FS_EVENTS": {
      const events = action.events;
      const newTree = applyFsEvents(state.fileTree, events);

      // If nothing changed, skip the rest of the work (avoids needless
      // re-renders when the watcher emits no-op events).
      if (newTree === state.fileTree) return state;

      // Close any open tabs whose file was deleted on disk. The watcher
      // already removed them from the tree, so the tab content would
      // be orphaned otherwise.
      const removedIds = removedFileIds(events);
      let tabs = state.tabs;
      let activeTabId = state.activeTabId;
      if (removedIds.size > 0) {
        tabs = tabs.filter((t) => !removedIds.has(t.fileId));
        if (activeTabId && !tabs.find((t) => t.id === activeTabId)) {
          activeTabId = tabs.length > 0 ? tabs[tabs.length - 1].id : null;
        }
      }

      // If a deleted file was the user's focused node, drop focus.
      let focusedNodeId = state.focusedNodeId;
      if (focusedNodeId && removedIds.has(focusedNodeId)) {
        focusedNodeId = null;
      }

      return {
        ...state,
        fileTree: newTree,
        tabs,
        activeTabId,
        focusedNodeId,
        treeEmpty: newTree.length === 0,
      };
    }

    case "CLOSE_WORKSPACE": {
      return {
        ...state,
        workspaceRoot: null,
        workspaceName: null,
        fileTree: [],
        tabs: [],
        activeTabId: null,
        collapsed: {},
        focusedNodeId: null,
        contextMenu: null,
        modal: null,
        closedTabsStack: [],
        treeEmpty: true,
        mergeReviews: [],
      };
    }

    case "OPEN_MERGE_REVIEW": {
      // Open a virtual merge-review tab. The EditorPane listens for these
      // tabs and renders the merge editor instead of the standard CM6 view.
      const { absPath, originalText, proposedText, source = "agent patch" } = action;
      const reviewId = `merge_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const fileId = `__merge__/${absPath}`;
      const tabName = `${absPath.split("/").pop() ?? absPath} (review)`;
      const existingTab = state.tabs.find((t) => t.fileId === fileId);
      if (existingTab) {
        // Update the review in place and reactivate.
        const updatedReviews = state.mergeReviews.map((r) =>
          r.absPath === absPath ? { ...r, originalText, proposedText, source } : r,
        );
        return {
          ...state,
          mergeReviews: updatedReviews,
          activeTabId: existingTab.id,
          contextMenu: null,
        };
      }
      const newTab: Tab = {
        id: `tab_${Date.now()}`,
        fileId,
        name: tabName,
        dirty: false,
      };
      return {
        ...state,
        tabs: [...state.tabs, newTab],
        activeTabId: newTab.id,
        mergeReviews: [
          ...state.mergeReviews,
          {
            id: reviewId,
            absPath,
            originalText,
            proposedText,
            createdAt: Date.now(),
            source,
          },
        ],
        contextMenu: null,
      };
    }

    case "CLOSE_MERGE_REVIEW": {
      const { reviewId } = action;
      const review = state.mergeReviews.find((r) => r.id === reviewId);
      if (!review) return state;
      // Find the matching tab and close it.
      const tabToClose = state.tabs.find(
        (t) => t.fileId === `__merge__/${review.absPath}`,
      );
      const tabs = tabToClose
        ? state.tabs.filter((t) => t.id !== tabToClose.id)
        : state.tabs;
      let { activeTabId } = state;
      if (tabToClose && activeTabId === tabToClose.id) {
        const idx = state.tabs.findIndex((t) => t.id === tabToClose.id);
        const next = tabs[idx] ?? tabs[idx - 1] ?? null;
        activeTabId = next ? next.id : null;
      }
      return {
        ...state,
        tabs,
        activeTabId,
        mergeReviews: state.mergeReviews.filter((r) => r.id !== reviewId),
      };
    }

    case "RESOLVE_MERGE_REVIEW": {
      const { reviewId, mergedText } = action;
      const review = state.mergeReviews.find((r) => r.id === reviewId);
      if (!review) return state;
      // Apply the merged content to the underlying file (if it exists in the tree).
      const fileTree = state.fileTree.map((n) =>
        n.id === review.absPath ? { ...n, content: mergedText } : n,
      );
      // Close the review tab.
      const tabToClose = state.tabs.find(
        (t) => t.fileId === `__merge__/${review.absPath}`,
      );
      const tabs = tabToClose
        ? state.tabs.filter((t) => t.id !== tabToClose.id)
        : state.tabs;
      let { activeTabId } = state;
      if (tabToClose && activeTabId === tabToClose.id) {
        const idx = state.tabs.findIndex((t) => t.id === tabToClose.id);
        const next = tabs[idx] ?? tabs[idx - 1] ?? null;
        activeTabId = next ? next.id : null;
      }
      // Mark the underlying file as clean if it had a tab open.
      const underlyingTabId = state.tabs.find(
        (t) => t.fileId === review.absPath,
      )?.id;
      const updatedTabs = underlyingTabId
        ? tabs.map((t) =>
            t.id === underlyingTabId ? { ...t, dirty: false } : t,
          )
        : tabs;
      return {
        ...state,
        fileTree,
        tabs: updatedTabs,
        activeTabId,
        mergeReviews: state.mergeReviews.filter((r) => r.id !== reviewId),
        toasts: [
          ...state.toasts,
          makeToast({
            message: `Merged changes into ${review.absPath.split("/").pop() ?? review.absPath}`,
            tone: "success",
            ttlMs: 2400,
          }),
        ],
      };
    }

    case "TOGGLE_PANEL": {
      return {
        ...state,
        panel: { ...state.panel, open: !state.panel.open },
      };
    }

    case "SET_PANEL_TAB": {
      const open = state.panel.tab !== action.tab ? true : state.panel.open;
      return {
        ...state,
        panel: { ...state.panel, tab: action.tab, open },
      };
    }

    case "SET_PANEL_HEIGHT": {
      return {
        ...state,
        panel: { ...state.panel, height: Math.max(100, Math.min(600, action.height)) },
      };
    }

    case "SET_DIAGNOSTICS": {
      return {
        ...state,
        panel: { ...state.panel, diagnostics: action.diagnostics },
      };
    }

    case "APPEND_OUTPUT": {
      const logs = [...state.panel.outputLogs, action.line];
      // Keep last 10,000 lines to prevent memory bloat.
      return {
        ...state,
        panel: { ...state.panel, outputLogs: logs.slice(-10000) },
      };
    }

    case "CLEAR_OUTPUT": {
      return {
        ...state,
        panel: { ...state.panel, outputLogs: [] },
      };
    }

    case "ADD_TERMINAL_SESSION": {
      const { session } = action;
      return {
        ...state,
        panel: {
          ...state.panel,
          terminalSessions: [...state.panel.terminalSessions, session],
          activeTerminalId: session.id,
          // Always open the panel + jump to the terminal tab when a new
          // session is added, so the user actually sees it. VS Code does
          // the same.
          open: true,
          tab: "terminal",
        },
      };
    }

    case "REMOVE_TERMINAL_SESSION": {
      const { id } = action;
      const remaining = state.panel.terminalSessions.filter((s) => s.id !== id);
      let { activeTerminalId } = state.panel;
      if (activeTerminalId === id) {
        const idx = state.panel.terminalSessions.findIndex((s) => s.id === id);
        activeTerminalId = remaining[idx]?.id ?? remaining[idx - 1]?.id ?? null;
      }
      return {
        ...state,
        panel: {
          ...state.panel,
          terminalSessions: remaining,
          activeTerminalId,
        },
      };
    }

    case "ACTIVATE_TERMINAL_SESSION": {
      return {
        ...state,
        panel: { ...state.panel, activeTerminalId: action.id },
      };
    }

    case "SET_TERMINAL_STATUS": {
      return {
        ...state,
        panel: {
          ...state.panel,
          terminalSessions: state.panel.terminalSessions.map((s) =>
            s.id === action.id ? { ...s, status: action.status } : s,
          ),
        },
      };
    }

    default:
      return state;
  }
}

// React Fast Refresh refuses to HMR modules that export both a React
// component (IdeStoreProvider) and a non-component (the IdeStore class).
// On any edit to store.tsx during dev, Fast Refresh falls back to a
// full reload — which throws the page away, leaving the Provider
// remounted with a brand-new store. The class itself doesn't need to
// hot-replace: state lives outside React. Marking it with
// `// @refresh skip` keeps Fast Refresh happy while still allowing
// the React parts (Provider, hooks) to HMR cleanly.
/* @refresh skip */
export class IdeStore {
  state: IdeState;
  private listeners = new Set<() => void>();

  constructor() {
    this.state = makeInitialState();
  }

  getState(): IdeState {
    return this.state;
  }

  dispatch(action: IdeAction): void {
    if (!PERF_ENABLED) {
      this.state = reduce(this.state, action);
      this.listeners.forEach((fn) => fn());
      return;
    }
    const t0 = performance.now();
    this.state = reduce(this.state, action);
    const reduceMs = performance.now() - t0;
    const listenerCount = this.listeners.size;
    perfLog("IdeStore", "dispatch:reducer_done", { actionType: action.type, reduceMs, listenerCount });
    const t1 = performance.now();
    this.listeners.forEach((fn) => fn());
    perfLog("IdeStore", "dispatch:notify_done", {
      actionType: action.type,
      totalMs: performance.now() - t0,
      reduceMs,
      notifyMs: performance.now() - t1,
      listenerCount,
    });
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const IdeStoreContext = createContext<IdeStore | null>(null);

export function IdeStoreProvider({ children }: { children: ReactNode }) {
  // Use lazy initialization: the arrow function runs once on first access,
  // before useSyncExternalStore calls subscribe() in the render phase.
  const storeRef = useRef<IdeStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = new IdeStore();
  }
  const store = storeRef.current;

  // useSyncExternalStore forces a re-render whenever state changes.
  // The subscribe callback must never be undefined.
  useSyncExternalStore(
    (fn) => store.subscribe(fn),
    () => store.getState(),
    () => store.getState(),
  );

  return (
    <IdeStoreContext.Provider value={store}>
      {children}
    </IdeStoreContext.Provider>
  );
}

export type { LangId, FileNode };
