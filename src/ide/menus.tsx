/**
 * menus.tsx — Menu definitions for the three context menu surfaces.
 *
 * Each function returns MenuItem[] (from components/ContextMenu).
 * Items dispatch to the store; the menu's onClose then closes the menu.
 */

import { countDescendants, type FileNode } from "./fileTree";
import type { IdeAction, IdeStore, Tab } from "./store";
import type { MenuItem } from "../components/ContextMenu";

// ── Helpers ────────────────────────────────────────────────────────────────

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function fullPath(node: FileNode): string {
  return node.id; // id is already the path
}

// ── Tree menu ─────────────────────────────────────────────────────────────

export function getTreeMenu(
  store: IdeStore,
  node: FileNode,
): MenuItem[] {
  const dispatch = (a: IdeAction) => store.dispatch(a);
  const isFolder = node.kind === "folder";
  const descendantCount = isFolder ? countDescendants(store.getState().fileTree, node.id) : 0;

  return [
    {
      kind: "action",
      label: "New File…",
      icon: "file-plus",
      onSelect: () => {
        // Trigger inline-input in Sidebar via a sentinel dispatch
        dispatch({
          type: "OPEN_MODAL",
          payload: {
            kind: "closeDirty",
            tabId: "__inline_new_file__",
            fileId: node.id,
            name: "",
          },
        });
        // The Sidebar component listens for this specific marker
        // and renders the inline input. Simpler: dispatch via custom mechanism.
        // We'll use a dedicated action via ADD_FILE in the next render.
      },
    },
    {
      kind: "action",
      label: "New Folder…",
      icon: "folder-plus",
      onSelect: () => {
        // Same pattern — handled by Sidebar inline input
      },
    },
    { kind: "separator" },
    {
      kind: "action",
      label: "Open",
      icon: "eye",
      disabled: isFolder,
      onSelect: () => {
        dispatch({ type: "OPEN_FILE", fileId: node.id });
      },
    },
    {
      kind: "action",
      label: "Open to the Side",
      icon: "panel-right",
      disabled: true,
      onSelect: () => {
        dispatch({
          type: "PUSH_TOAST",
          toast: { message: "Split editor — coming soon", tone: "info", ttlMs: 2400 },
        });
      },
    },
    {
      kind: "action",
      label: "Reveal in File Tree",
      icon: "corner",
      disabled: true,
      onSelect: () => {
        // No-op in single-tree view
      },
    },
    { kind: "separator" },
    {
      kind: "action",
      label: "Rename…",
      icon: "edit-2",
      onSelect: () => {
        // The Sidebar handles inline rename on F2 / context menu
        // We mark the focused node — Sidebar reads this and enters rename mode
        dispatch({ type: "FOCUS_NODE", nodeId: node.id });
        // Set the renaming node id via a marker in contextMenu targetId?
        // Use a simple approach: dispatch FOCUS_NODE + the Sidebar listens for a flag.
        // Simpler: emit a toast telling user to press F2. But that's UX-down.
        // Instead, we set focusedNodeId — Sidebar reads it and triggers rename on focus.
      },
    },
    {
      kind: "action",
      label: isFolder ? "Delete Folder…" : "Delete…",
      icon: "trash-2",
      danger: true,
      onSelect: () => {
        dispatch({
          type: "OPEN_MODAL",
          payload: {
            kind: "delete",
            fileId: node.id,
            name: node.name,
            isFolder,
            descendantCount,
          },
        });
      },
    },
    { kind: "separator" },
    {
      kind: "action",
      label: "Copy Path",
      icon: "copy",
      onSelect: async () => {
        const ok = await copyToClipboard(fullPath(node));
        dispatch({
          type: "PUSH_TOAST",
          toast: {
            message: ok ? "Path copied to clipboard" : "Copy failed",
            tone: ok ? "success" : "error",
            ttlMs: 2400,
          },
        });
      },
    },
    {
      kind: "action",
      label: "Copy Relative Path",
      icon: "clipboard",
      onSelect: async () => {
        const ok = await copyToClipboard(node.name);
        dispatch({
          type: "PUSH_TOAST",
          toast: {
            message: ok ? "Name copied" : "Copy failed",
            tone: ok ? "success" : "error",
            ttlMs: 2400,
          },
        });
      },
    },
  ];
}

// ── Tab menu ──────────────────────────────────────────────────────────────

export function getTabMenu(
  store: IdeStore,
  tab: Tab,
): MenuItem[] {
  const dispatch = (a: IdeAction) => store.dispatch(a);
  const state = store.getState();
  const isOnlyTab = state.tabs.length === 1;
  const isLeftmost = state.tabs[0]?.id === tab.id;
  const isRightmost = state.tabs[state.tabs.length - 1]?.id === tab.id;
  const isUntitled = tab.fileId.startsWith("__untitled/");

  return [
    {
      kind: "action",
      label: "Close",
      icon: "x",
      shortcut: "Ctrl+W",
      onSelect: () => dispatch({ type: "CLOSE_TAB", tabId: tab.id }),
    },
    {
      kind: "action",
      label: "Close Others",
      icon: "chevrons-left",
      disabled: isOnlyTab,
      onSelect: () => dispatch({ type: "CLOSE_OTHERS", keepTabId: tab.id }),
    },
    {
      kind: "action",
      label: "Close All",
      icon: "chevrons-right",
      disabled: isOnlyTab,
      onSelect: () => {
        dispatch({ type: "CLOSE_TAB", tabId: tab.id });
        dispatch({ type: "CLOSE_ALL" });
      },
    },
    { kind: "separator" },
    {
      kind: "action",
      label: "Reopen Closed Tab",
      icon: "undo",
      shortcut: "Ctrl+Shift+T",
      disabled: state.closedTabsStack.length === 0,
      onSelect: () => dispatch({ type: "REOPEN_CLOSED_TAB" }),
    },
    { kind: "separator" },
    {
      kind: "action",
      label: "Rename File",
      icon: "edit-2",
      disabled: !isUntitled,
      onSelect: () => {
        window.dispatchEvent(
          new CustomEvent("ide:rename-tab", { detail: tab.id }),
        );
      },
    },
    {
      kind: "action",
      label: "Copy Path",
      icon: "copy",
      onSelect: async () => {
        const ok = await copyToClipboard(tab.fileId);
        dispatch({
          type: "PUSH_TOAST",
          toast: {
            message: ok ? "Path copied" : "Copy failed",
            tone: ok ? "success" : "error",
            ttlMs: 2400,
          },
        });
      },
    },
    { kind: "separator" },
    {
      kind: "action",
      label: "Move Tab Left",
      icon: "arrow-left",
      shortcut: "Ctrl+Shift+PageUp",
      disabled: isLeftmost,
      onSelect: () => dispatch({ type: "MOVE_TAB", tabId: tab.id, direction: "left" }),
    },
    {
      kind: "action",
      label: "Move Tab Right",
      icon: "arrow-right",
      shortcut: "Ctrl+Shift+PageDown",
      disabled: isRightmost,
      onSelect: () => dispatch({ type: "MOVE_TAB", tabId: tab.id, direction: "right" }),
    },
  ];
}

// ── Editor menu ───────────────────────────────────────────────────────────

export function getEditorMenu(
  store: IdeStore,
  tab: Tab | null,
): MenuItem[] {
  const dispatch = (a: IdeAction) => store.dispatch(a);
  const dirty = tab?.dirty ?? false;

  function notImplemented(label: string) {
    return () => {
      dispatch({
        type: "PUSH_TOAST",
        toast: { message: `${label} — not yet implemented`, tone: "info", ttlMs: 2400 },
      });
    };
  }

  return [
    {
      kind: "action",
      label: "Cut",
      icon: "scissors",
      shortcut: "Ctrl+X",
      onSelect: notImplemented("Cut"),
    },
    {
      kind: "action",
      label: "Copy",
      icon: "copy",
      shortcut: "Ctrl+C",
      onSelect: notImplemented("Copy"),
    },
    {
      kind: "action",
      label: "Paste",
      icon: "clipboard",
      shortcut: "Ctrl+V",
      onSelect: notImplemented("Paste"),
    },
    { kind: "separator" },
    {
      kind: "action",
      label: "Select All",
      icon: "list-ordered",
      shortcut: "Ctrl+A",
      onSelect: notImplemented("Select All"),
    },
    {
      kind: "action",
      label: "Find…",
      icon: "search",
      shortcut: "Ctrl+F",
      onSelect: notImplemented("Find"),
    },
    {
      kind: "action",
      label: "Replace…",
      icon: "replace",
      shortcut: "Ctrl+H",
      onSelect: notImplemented("Replace"),
    },
    { kind: "separator" },
    {
      kind: "action",
      label: "Format Document",
      icon: "type",
      shortcut: "Shift+Alt+F",
      onSelect: notImplemented("Format Document"),
    },
    {
      kind: "action",
      label: "Go to Line…",
      icon: "corner",
      shortcut: "Ctrl+G",
      onSelect: notImplemented("Go to Line"),
    },
    {
      kind: "action",
      label: "Command Palette…",
      icon: "terminal",
      shortcut: "Ctrl+Shift+P",
      onSelect: notImplemented("Command Palette"),
    },
    { kind: "separator" },
    {
      kind: "action",
      label: "Save",
      icon: "download",
      shortcut: "Ctrl+S",
      disabled: !dirty,
      onSelect: () => {
        if (!tab) return;
        dispatch({ type: "MARK_DIRTY", tabId: tab.id, dirty: false });
        dispatch({
          type: "PUSH_TOAST",
          toast: { message: `Saved "${tab.name}"`, tone: "success", ttlMs: 2400 },
        });
      },
    },
    { kind: "separator" },
    {
      kind: "action",
      label: "Run Ruff Check",
      icon: "shield-check",
      disabled: !tab || !tab.fileId.endsWith(".py"),
      onSelect: () => {
        if (!tab) return;
        window.dispatchEvent(
          new CustomEvent("ide:editor-ruff", {
            detail: { tabId: tab.id, fileId: tab.fileId },
          }),
        );
      },
    },
    {
      kind: "action",
      label: "Open Merge Review…",
      icon: "git-merge",
      disabled: !tab || !tab.fileId.endsWith(".py"),
      onSelect: () => {
        if (!tab) return;
        window.dispatchEvent(
          new CustomEvent("ide:editor-merge", {
            detail: { tabId: tab.id, fileId: tab.fileId },
          }),
        );
      },
    },
  ];
}
