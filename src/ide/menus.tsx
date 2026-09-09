/**
 * menus.tsx — Menu definitions for the three context menu surfaces.
 *
 * Each function returns MenuItem[] (from components/ContextMenu).
 * Items dispatch to the store; the menu's onClose then closes the menu.
 */

import { countDescendants, type FileNode } from "./fileTree"

import type { IdeAction, IdeStore, Tab } from "./store"

import type { MenuItem } from "../components/ContextMenu"

// ── Helpers ────────────────────────────────────────────────────────────────

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)

    return true
  } catch {
    return false
  }
}

function fullPath(node: FileNode): string {
  return node.id // id is already the path
}

// ── Tree menu ─────────────────────────────────────────────────────────────

export function getTreeMenu(
  store: IdeStore,

  node: FileNode,
): MenuItem[] {
  const dispatch = (a: IdeAction) => store.dispatch(a)

  const isFolder = node.kind === "folder"

  const descendantCount = isFolder
    ? countDescendants(store.getState().fileTree, node.id)
    : 0

  return [
    {
      kind: "action",

      label: "New File…",

      icon: "file-plus",

      onSelect: () => {
        const parentId = isFolder ? node.id : null

        window.dispatchEvent(
          new CustomEvent("ide:new-file", { detail: { parentId } }),
        )
      },
    },

    {
      kind: "action",

      label: "New Folder…",

      icon: "folder-plus",

      onSelect: () => {
        const parentId = isFolder ? node.id : null

        window.dispatchEvent(
          new CustomEvent("ide:new-folder", { detail: { parentId } }),
        )
      },
    },

    { kind: "separator" },

    {
      kind: "action",

      label: "Open",

      icon: "eye",

      disabled: isFolder,

      onSelect: () => {
        dispatch({ type: "OPEN_FILE", fileId: node.id })
      },
    },

    {
      kind: "action",

      label: "Open to the Side",

      icon: "panel-right",

      onSelect: () => {
        dispatch({
          type: "PUSH_TOAST",

          toast: {
            message: "Split editor — coming soon",
            tone: "info",
            ttlMs: 2400,
          },
        })
      },
    },

    { kind: "separator" },

    {
      kind: "action",

      label: "Rename…",

      icon: "edit-2",

      onSelect: () => {
        // Focus the node in the store so the Sidebar can enter rename mode.

        dispatch({ type: "FOCUS_NODE", nodeId: node.id })

        window.dispatchEvent(
          new CustomEvent("ide:tree-rename", { detail: { nodeId: node.id } }),
        )
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
        })
      },
    },

    { kind: "separator" },

    {
      kind: "action",

      label: "Copy Path",

      icon: "copy",

      onSelect: async () => {
        const ok = await copyToClipboard(fullPath(node))

        dispatch({
          type: "PUSH_TOAST",

          toast: {
            message: ok ? "Path copied to clipboard" : "Copy failed",

            tone: ok ? "success" : "error",

            ttlMs: 2400,
          },
        })
      },
    },

    {
      kind: "action",

      label: "Copy Relative Path",

      icon: "clipboard",

      onSelect: async () => {
        const ok = await copyToClipboard(node.name)

        dispatch({
          type: "PUSH_TOAST",

          toast: {
            message: ok ? "Name copied" : "Copy failed",

            tone: ok ? "success" : "error",

            ttlMs: 2400,
          },
        })
      },
    },
  ]
}

// ── Tab menu ──────────────────────────────────────────────────────────────

export function getTabMenu(
  store: IdeStore,

  tab: Tab,
): MenuItem[] {
  const dispatch = (a: IdeAction) => store.dispatch(a)

  const state = store.getState()

  const isOnlyTab = state.tabs.length === 1

  const isLeftmost = state.tabs[0]?.id === tab.id

  const isRightmost = state.tabs[state.tabs.length - 1]?.id === tab.id

  const isUntitled = tab.fileId.startsWith("__untitled/")

  const isPinned = !!tab.pinned

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

      // Batch operations always force-close (no per-tab dirty prompt).

      // The reducer bypasses the closeDirty modal entirely; this matches

      // the `force: true` semantics of CLOSE_TAB. The user has already

      // chosen "Save" or "Don't Save" on the active tab if they needed

      // to before invoking Close Others.

      onSelect: () => dispatch({ type: "CLOSE_OTHERS", keepTabId: tab.id }),
    },

    {
      kind: "action",

      label: "Close to the Right",

      icon: "chevrons-right",

      disabled: isRightmost,

      onSelect: () => dispatch({ type: "CLOSE_TABS_TO_RIGHT", tabId: tab.id }),
    },

    {
      kind: "action",

      label: "Close All",

      icon: "chevrons-right",

      disabled: isOnlyTab,

      // See note above on Close Others: batch ops always force-close.

      onSelect: () => dispatch({ type: "CLOSE_ALL" }),
    },

    { kind: "separator" },

    {
      kind: "action",

      label: isPinned ? "Unpin" : "Pin",

      icon: "pin",

      onSelect: () => dispatch({ type: "TOGGLE_PIN", tabId: tab.id }),
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
        )
      },
    },

    {
      kind: "action",

      label: "Copy Path",

      icon: "copy",

      onSelect: async () => {
        const ok = await copyToClipboard(tab.fileId)

        dispatch({
          type: "PUSH_TOAST",

          toast: {
            message: ok ? "Path copied" : "Copy failed",

            tone: ok ? "success" : "error",

            ttlMs: 2400,
          },
        })
      },
    },

    { kind: "separator" },

    {
      kind: "action",

      label: "Move Tab Left",

      icon: "arrow-left",

      shortcut: "Ctrl+Shift+PageUp",

      disabled: isLeftmost,

      onSelect: () =>
        dispatch({ type: "MOVE_TAB", tabId: tab.id, direction: "left" }),
    },

    {
      kind: "action",

      label: "Move Tab Right",

      icon: "arrow-right",

      shortcut: "Ctrl+Shift+PageDown",

      disabled: isRightmost,

      onSelect: () =>
        dispatch({ type: "MOVE_TAB", tabId: tab.id, direction: "right" }),
    },
  ]
}

// ── Editor menu ───────────────────────────────────────────────────────────

export function getEditorMenu(
  store: IdeStore,

  tab: Tab | null,
): MenuItem[] {
  const dispatch = (a: IdeAction) => store.dispatch(a)

  const dirty = tab?.dirty ?? false

  function editorAction(kind: string) {
    return () => {
      window.dispatchEvent(
        new CustomEvent("ide:editor-action", { detail: { kind } }),
      )
    }
  }

  function notImplemented(label: string) {
    return () => {
      dispatch({
        type: "PUSH_TOAST",

        toast: {
          message: `${label} — not yet implemented`,
          tone: "info",
          ttlMs: 2400,
        },
      })
    }
  }

  async function copySelection() {
    const ok = await copyToClipboard(window.getSelection()?.toString() ?? "")

    if (!ok) {
      dispatch({
        type: "PUSH_TOAST",
        toast: { message: "Copy failed", tone: "error", ttlMs: 2400 },
      })
    }
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

      onSelect: () => {
        void copySelection()
      },
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

      onSelect: editorAction("select-all"),
    },

    {
      kind: "action",

      label: "Find…",

      icon: "search",

      shortcut: "Ctrl+F",

      onSelect: editorAction("find"),
    },

    {
      kind: "action",

      label: "Replace…",

      icon: "replace",

      shortcut: "Ctrl+H",

      onSelect: editorAction("replace"),
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

      onSelect: editorAction("goto-line"),
    },

    {
      kind: "action",

      label: "Command Palette…",

      icon: "terminal",

      shortcut: "Ctrl+Shift+P",

      onSelect: () => dispatch({ type: "OPEN_PALETTE" }),
    },

    { kind: "separator" },

    {
      kind: "action",

      label: "Save",

      icon: "download",

      shortcut: "Ctrl+S",

      disabled: !dirty,

      onSelect: () => {
        if (!tab) return

        dispatch({ type: "MARK_DIRTY", tabId: tab.id, dirty: false })

        dispatch({
          type: "PUSH_TOAST",

          toast: {
            message: `Saved "${tab.name}"`,
            tone: "success",
            ttlMs: 2400,
          },
        })
      },
    },

    { kind: "separator" },

    {
      kind: "action",

      label: "Run Ruff Check",

      icon: "shield-check",

      disabled: !tab || !tab.fileId.endsWith(".py"),

      onSelect: () => {
        if (!tab) return

        window.dispatchEvent(
          new CustomEvent("ide:editor-ruff", {
            detail: { tabId: tab.id, fileId: tab.fileId },
          }),
        )
      },
    },

    {
      kind: "action",

      label: "Open Merge Review…",

      icon: "git-merge",

      disabled: !tab || !tab.fileId.endsWith(".py"),

      onSelect: () => {
        if (!tab) return

        window.dispatchEvent(
          new CustomEvent("ide:editor-merge", {
            detail: { tabId: tab.id, fileId: tab.fileId },
          }),
        )
      },
    },
  ]
}
