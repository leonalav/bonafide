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
  type LangId,
} from "./fileTree";

// Tab type
export type Tab = {
  id: string;
  fileId: string;
  name: string;
  dirty: boolean;
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

// IdeState
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
  | { type: "MOVE_TAB"; tabId: string; direction: "left" | "right" };

// Toast helper
let toastCounter = 0;
function makeToast(partial: Omit<Toast, "id">): Toast {
  return { ...partial, id: `toast_${++toastCounter}_${Date.now()}` };
}

function makeInitialState(): IdeState {
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
  };
}

// ── Debug instrumentation: measure reduce timing ──────────────────────────
let _storeLog: ((msg: string, d: Record<string, unknown>) => void) | null = null;
if (typeof window !== 'undefined') {
  _storeLog = (msg, d) => fetch('http://127.0.0.1:7750/ingest/8d618420-3b75-4343-9d6c-c42e01f4bae7', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '5197ca' },
    body: JSON.stringify({ sessionId: '5197ca', id: `log_${Date.now()}`, timestamp: Date.now(), location: 'IdeStore', message: msg, data: d, runId: 'run1', hypothesisId: 'C' }),
  }).catch(() => {});
}

export function reduce(state: IdeState, action: IdeAction): IdeState {
  const t0 = performance.now();
  const result = _reduce(state, action);
  const ms = performance.now() - t0;
  _storeLog?.('reduce', { actionType: action.type, ms });
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
        dirty: true,
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

    case "SET_CONTENT": {
      const { fileId, content } = action;
      return {
        ...state,
        fileTree: state.fileTree.map((n) =>
          n.id === fileId ? { ...n, content } : n,
        ),
        tabs: state.tabs.map((t) =>
          t.fileId === fileId ? { ...t, dirty: true } : t,
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
    const t0 = performance.now();
    this.state = reduce(this.state, action);
    const reduceMs = performance.now() - t0;
    const listenerCount = this.listeners.size;
    _storeLog?.('dispatch:reducer_done', { actionType: action.type, reduceMs, listenerCount });
    const t1 = performance.now();
    this.listeners.forEach((fn) => fn());
    _storeLog?.('dispatch:notify_done', { actionType: action.type, totalMs: performance.now() - t0, reduceMs, notifyMs: performance.now() - t1, listenerCount });
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
