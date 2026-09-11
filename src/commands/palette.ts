/**
 * palette.ts — Command palette command registry.
 *
 * Each command has a `run` function that dispatches the appropriate store
 * action or fires a window event. Commands are grouped by category for
 * display in the palette.
 */

import { bonafide } from "../ipc/tauri.ts"

import type { IdeAction, IdeStore, IdeState } from "../ide/store.tsx"

import type { FileNode } from "../ide/fileTree.ts"

import type { IconName } from "../components/ui/Icon.tsx"

export type PaletteCommand = {
  id: string

  label: string

  group: "General" | "File" | "View" | "Run"

  shortcut?: string

  icon?: IconName

  /** Return false to hide the command (e.g. no active tab for Save). */

  when?: (ideState: IdeState) => boolean

  run: () => void | Promise<void>
}

/** Toast helper type matching the store's Toast shape. */

type ToastArgs = {
  message: string
  tone: "info" | "success" | "error"
  ttlMs: number
}

function pushToast(dispatch: (a: IdeAction) => void, args: ToastArgs): void {
  dispatch({ type: "PUSH_TOAST", toast: args })
}

/** Build the palette command list, closing over the given store. */

export function buildPaletteCommands(store: IdeStore): PaletteCommand[] {
  const dispatch = (a: IdeAction) => store.dispatch(a)

  const state = store.getState()

  const activeTab = state.activeTabId
    ? (state.tabs.find((t) => t.id === state.activeTabId) ?? null)
    : null

  // Helper to open a workspace from a folder path.

  async function openWorkspace(folderPath: string): Promise<void> {
    try {
      // Tell Rust to (a) open the SQLite store for this workspace and

      // (b) seed/lookup the per-workspace hash so keyring + tracker

      // commands can resolve credentials. Without this call, code-graph

      // indexing and tracker lookups silently no-op because they

      // require an open storage handle.

      await bonafide.workspace.open(folderPath).catch((err) => {
        // Open the workspace DB best-effort; even if Tauri rejects

        // (e.g. browser preview), we still want the renderer's file

        // tree to populate.

        console.warn("[bonafide] open_workspace failed:", err)
      })

      const listing = await bonafide.fs.readDirectory(folderPath)

      const tree: FileNode[] = listing.files.map((f) => ({
        id: f.id,

        name: f.name,

        kind: f.kind as "folder" | "file",

        parentId: f.parentId,

        expanded: f.kind === "folder" && (f.expanded ?? false),

        fileType: f.fileType as FileNode["fileType"],
      }))

      dispatch({
        type: "OPEN_WORKSPACE",

        rootPath: listing.rootPath,

        rootName: listing.rootName,

        tree,
      })

      pushToast(dispatch, {
        message: `Opened ${listing.rootName}`,

        tone: "success",

        ttlMs: 2400,
      })
    } catch {
      pushToast(dispatch, {
        message: "Failed to open folder",
        tone: "error",
        ttlMs: 2400,
      })
    }
  }

  return [
    // ── General ─────────────────────────────────────────────────────────────

    {
      id: "open-folder",

      label: "Open Folder",

      group: "General",

      icon: "folder-open",

      shortcut: "Ctrl+O",

      run: async () => {
        const folderPath = await bonafide.fs.pickFolder()

        if (folderPath) await openWorkspace(folderPath)
      },
    },

    {
      id: "open-file",

      label: "Open File",

      group: "General",

      icon: "file",

      shortcut: "Ctrl+O",

      run: async () => {
        const filePath = await bonafide.fs.pickFile()

        if (!filePath) return

        // Fire a custom event the EditorPane / App listens for to open the file.

        window.dispatchEvent(
          new CustomEvent("ide:open-file", { detail: { path: filePath } }),
        )
      },
    },

    {
      id: "show-settings",

      label: "Show Settings",

      group: "General",

      icon: "settings",

      run: () => {
        pushToast(dispatch, {
          message: "Settings — coming soon",

          tone: "info",

          ttlMs: 2400,
        })
      },
    },

    // ── File ────────────────────────────────────────────────────────────────

    {
      id: "save",

      label: "Save",

      group: "File",

      icon: "download",

      shortcut: "Ctrl+S",

      when: () => !!activeTab?.dirty,

      run: () => {
        if (!activeTab) return

        dispatch({ type: "MARK_DIRTY", tabId: activeTab.id, dirty: false })

        pushToast(dispatch, {
          message: `Saved "${activeTab.name}"`,

          tone: "success",

          ttlMs: 2400,
        })
      },
    },

    {
      id: "new-file",

      label: "New File",

      group: "File",

      icon: "file-plus",

      shortcut: "Ctrl+N",

      run: () => {
        dispatch({ type: "OPEN_UNTITLED" })
      },
    },

    {
      id: "new-folder",

      label: "New Folder",

      group: "File",

      icon: "folder-plus",

      run: () => {
        window.dispatchEvent(
          new CustomEvent("ide:new-folder", { detail: { parentId: null } }),
        )
      },
    },

    {
      id: "close-tab",

      label: "Close Tab",

      group: "File",

      icon: "x",

      shortcut: "Ctrl+W",

      when: () => !!activeTab,

      run: () => {
        if (!activeTab) return

        dispatch({ type: "CLOSE_TAB", tabId: activeTab.id })
      },
    },

    {
      id: "reopen-closed-tab",

      label: "Reopen Closed Tab",

      group: "File",

      icon: "undo",

      shortcut: "Ctrl+Shift+T",

      when: () => state.closedTabsStack.length > 0,

      run: () => {
        dispatch({ type: "REOPEN_CLOSED_TAB" })
      },
    },

    // ── View ────────────────────────────────────────────────────────────────

    {
      id: "toggle-sidebar",

      label: "Toggle Sidebar",

      group: "View",

      icon: "panel-right",

      shortcut: "Ctrl+B",

      run: () => {
        window.dispatchEvent(new CustomEvent("ide:toggle-sidebar"))
      },
    },

    {
      id: "toggle-panel",

      label: "Toggle Panel",

      group: "View",

      icon: "layers",

      shortcut: "Ctrl+J",

      run: () => {
        dispatch({ type: "TOGGLE_PANEL" })
      },
    },

    // ── Run ─────────────────────────────────────────────────────────────────

    {
      id: "run-ruff-check",

      label: "Run Ruff Check",

      group: "Run",

      icon: "shield-check",

      when: () => !!activeTab && !!activeTab.fileId.endsWith(".py"),

      run: () => {
        if (!activeTab) return

        window.dispatchEvent(
          new CustomEvent("ide:editor-ruff", {
            detail: { tabId: activeTab.id, fileId: activeTab.fileId },
          }),
        )
      },
    },

    {
      id: "open-merge-review",

      label: "Open Merge Review",

      group: "Run",

      icon: "git-merge",

      when: () => !!activeTab && !!activeTab.fileId.endsWith(".py"),

      run: () => {
        if (!activeTab) return

        window.dispatchEvent(
          new CustomEvent("ide:editor-merge", {
            detail: { tabId: activeTab.id, fileId: activeTab.fileId },
          }),
        )
      },
    },
  ]
}
