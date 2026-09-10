import {
  Component,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react"

import { TitleBar } from "./components/TitleBar"

import { UtilityDock, type DockId } from "./components/UtilityDock"

import { Sidebar } from "./components/Sidebar"

import { EditorPane } from "./components/EditorPane"

import { Inspector } from "./components/Inspector"

import { StatusBar } from "./components/StatusBar"

import {
  PreferencesWindow,
  type PrefSection,
} from "./components/preferences/PreferencesWindow"

import { WorkflowPanel } from "./components/agent/WorkflowPanel"

import { Panel } from "./components/Panel"

import { Icon } from "./components/ui/Icon"

import { ResizeHandle } from "./components/ui/ResizeHandle"

import { Modal } from "./components/Modal"

import { ToastHost } from "./components/ToastHost"

import { bonafide } from "./ipc/tauri"

import type { TerminalProfile } from "./ipc/tauri"
import {
  RunsProvider,
  useRunsData,
  type Run,
} from "./data/runs"

import { IdeStoreProvider } from "./ide/store.tsx"

import {
  useDispatch,
  useIdeStore,
  useModalState,
  useActiveTab,
  useActiveFile,
  useToast,
  useWorkspaceRoot,
  useWorkspaceName,
} from "./ide/hooks"

import type { FileNode } from "./ide/fileTree"

import CommandPalette from "./components/CommandPalette"

class ErrorBoundary extends Component<{ children: ReactNode }, {
  error: Error | null
}> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(e: Error) {
    return { error: e }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen w-screen items-center justify-center bg-[#0c0e13] p-8">
          <pre className="max-w-2xl rounded border border-red-800 bg-red-950 p-4 font-mono text-[12px] text-red-300">
            {this.state.error.name}: {this.state.error.message}
            {this.state.error.stack}
          </pre>
        </div>
      )
    }

    return this.props.children
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <IdeStoreProvider>
        <AppInner />
      </IdeStoreProvider>
    </ErrorBoundary>
  )
}

// Performance instrumentation. Enable by setting

// `localStorage.__BONAFIDE_PERF__ = "1"` in devtools. The previous

// version fired an unconditional fetch to localhost:7750 on every

// App render — turning what should be a sub-second render into a

// multi-second one because each fetch times out against an

// unreachable server.

function isPerfEnabled(): boolean {
  if (typeof window === "undefined") return false

  try {
    return window.localStorage?.getItem("__BONAFIDE_PERF__") === "1"
  } catch {
    return false
  }
}

const PERF_ENABLED = isPerfEnabled()

function appLog(message: string, data: Record<string, unknown>): void {
  if (!PERF_ENABLED) return

  fetch("http://127.0.0.1:7750/ingest/8d618420-3b75-4343-9d6c-c42e01f4bae7", {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "5197ca",
    },

    body: JSON.stringify({
      sessionId: "5197ca",

      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,

      timestamp: Date.now(),

      location: "App",

      message,

      data,

      runId: "run1",

      hypothesisId: "G",
    }),
  }).catch(() => {})
}

function AppInner() {
  const _renderStart = performance.now()

  const dispatch = useDispatch()

  const store = useIdeStore()

  const [dock, setDock] = useState<DockId>("explorer")

  const [selectedRun, setSelectedRun] = useState<string>("r1")

  const [inspectorOpen, setInspectorOpen] = useState(false)

  const [prefs, setPrefs] = useState<PrefSection | null>(null)

  const [workflowOpen, setWorkflowOpen] = useState(false)

  // Resizable panel widths. Persisted in component state for now; if you

  // want to remember them across launches, lift into the store + electron-store.

  const [sidebarWidth, setSidebarWidth] = useState(240)

  const [inspectorWidth, setInspectorWidth] = useState(320)

  // The run currently selected in the Inspector (may differ from the sidebar selection).
  const [inspectorRun, setInspectorRun] = useState<Run | null>(null)

  // Use reactive selectors — these re-render the component whenever the

  // store's workspaceRoot / workspaceName changes (e.g. after openFolder).

  // The previous implementation captured these from store.getState() once at

  // mount, which meant the empty-state overlay never dismissed.

  const _t1 = performance.now()

  const workspaceRoot = useWorkspaceRoot()

  const _t2 = performance.now()

  const workspaceName = useWorkspaceName()

  const _t3 = performance.now()

  const activeTab = useActiveTab()

  const _t4 = performance.now()

  const activeFile = useActiveFile()

  const _t5 = performance.now()

  const modal = useModalState()

  const pushToast = useToast()

  const activeTabId = activeTab?.id ?? null

  // Live runs surface — falls back to the design mock when no
  // workspace is open or when the backend returns zero rows.
  const runs = useRunsData();

  // Log selector cost. Only logs when a single selector takes >5ms.

  const _selCost = _t5 - _renderStart

  if (_selCost > 5) {
    appLog("AppInner:selector_cost", {
      totalMs: _selCost.toFixed(2),

      workspaceRootMs: (_t2 - _t1).toFixed(2),

      workspaceNameMs: (_t3 - _t2).toFixed(2),

      activeTabMs: (_t4 - _t3).toFixed(2),

      activeFileMs: (_t5 - _t4).toFixed(2),

      activeTabId: activeTabId ?? "null",

      activeFileContentLen: activeFile?.content?.length ?? 0,
    })
  }

  const openFolder = useCallback(async () => {
    try {
      const folderPath = await bonafide.fs.pickFolder()

      if (!folderPath) return

      // Open the workspace on the Rust side first so SQLite storage +
      // keyring scope + tracker resolution are wired before the
      // renderer starts emitting `bonafide.tracker.*` / `bonafide.graph.*`
      // calls. Without this, those calls fail with
      // "Workspace not open. Call open_workspace first.".
      try {
        await bonafide.workspace.open(folderPath)
      } catch (err) {
        // Best-effort; the renderer's file tree should still hydrate
        // even when the Rust side rejects (e.g. browser preview).
        console.warn("[App] open_workspace failed:", err)
      }

      const listing = await bonafide.fs.readDirectory(folderPath)

      // Convert from the FsNode shape (from Rust main process) to FileNode
      // shape (store's internal format).
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

      pushToast(`Opened ${listing.rootName}`, "success")
    } catch (err) {
      console.error("[App] openFolder failed", err)

      pushToast("Failed to open folder", "error")
    }
  }, [dispatch, pushToast])

  // ── Real-time file watcher ─────────────────────────────────────────────

  // Start the Rust watcher when a workspace is opened, stop it when closed.

  // We also subscribe to `fs:watcher` events and dispatch them to the store

  // as `APPLY_FS_EVENTS` actions so the file tree updates in real-time.

  useEffect(() => {
    if (!workspaceRoot) return

    // Subscribe to file-system change events and pipe them into the store.

    // The Rust watcher batches rapid bursts (e.g. `git checkout` touching

    // 50 files) into a single emission, so we receive one array per

    // batch rather than 50 individual events.

    const unsubscribe = bonafide.watcher.onEvent((events) => {
      dispatch({ type: "APPLY_FS_EVENTS", events })
    })

    // Start the Rust-side watcher for this workspace root.

    void bonafide.watcher.start(workspaceRoot)

    // Stop the watcher when the component unmounts or workspace changes.

    return () => {
      unsubscribe()

      void bonafide.watcher.stop()
    }
  }, [workspaceRoot, dispatch])

  function openRun(id: string) {
    const found = runs.find((r) => r.id === id) ?? null
    setInspectorRun(found)
    setSelectedRun(id)

    setInspectorOpen(true)
  }

  function closeTab(id: string) {
    dispatch({ type: "CLOSE_TAB", tabId: id })
  }

  function activateTab(id: string) {
    dispatch({ type: "ACTIVATE_TAB", tabId: id })
  }

  // ── Modal handlers ────────────────────────────────────────────────────

  function confirmDelete() {
    if (modal?.kind === "delete") {
      dispatch({ type: "DELETE", nodeId: modal.fileId })
    }
  }

  function cancelDelete() {
    dispatch({ type: "CLOSE_MODAL" })
  }

  function closeDirtyCancel() {
    dispatch({ type: "CLOSE_MODAL" })
  }

  function closeDirtyDontSave() {
    if (modal?.kind === "closeDirty") {
      dispatch({ type: "CLOSE_TAB", tabId: modal.tabId, force: true })
    }
  }

  function closeDirtySave() {
    if (modal?.kind === "closeDirty") {
      dispatch({ type: "MARK_DIRTY", tabId: modal.tabId, dirty: false })

      pushToast(`Saved "${modal.name}"`, "success")

      dispatch({ type: "CLOSE_TAB", tabId: modal.tabId, force: true })
    }
  }

  // #region DEBUG: track AppInner renders + measure sub-phases

  const _renderSyncDone = performance.now()

  appLog("AppInner:render_sync_done", {
    ms: _renderSyncDone - _renderStart,

    activeTabId: activeTabId ?? "null",
  })

  useEffect(() => {
    appLog("AppInner:rendered", {
      ms: performance.now() - _renderStart,
      activeTabId: activeTabId ?? "null",
    })
  })

  // #endregion

  // ── Keyboard shortcuts ────────────────────────────────────────────────

  const launchDefaultTerminal = useCallback(async () => {
    try {
      const profiles = await bonafide.pty.listProfiles()

      const pick =
        profiles.find((p: TerminalProfile) => p.available) ??
        profiles[0] ??
        null

      if (!pick) {
        pushToast("No terminal profiles available", "error")

        return
      }

      const id = `term_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

      dispatch({
        type: "ADD_TERMINAL_SESSION",

        session: {
          id,

          profileId: pick.id,

          profileLabel: pick.label,

          // Land the new terminal in the open workspace folder. When

          // no folder is open the backend falls back to the inherited

          // cwd rather than rejecting the request.

          cwd: workspaceRoot,

          status: "spawning",
        },
      })
    } catch (err) {
      console.error("[App] launchDefaultTerminal failed", err)

      pushToast("Failed to launch terminal", "error")
    }
  }, [dispatch, pushToast, workspaceRoot])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const cmd = e.metaKey || e.ctrlKey

      // Ctrl+O — Open folder

      if (cmd && !e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault()

        openFolder()

        return
      }

      // Ctrl+S — Save active file

      if (cmd && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault()

        if (activeTab?.dirty) {
          dispatch({ type: "MARK_DIRTY", tabId: activeTab.id, dirty: false })

          pushToast(`Saved "${activeTab.name}"`, "success")
        }

        return
      }

      // Ctrl+W — Close active tab

      if (cmd && !e.shiftKey && e.key.toLowerCase() === "w") {
        e.preventDefault()

        if (activeTab) closeTab(activeTab.id)

        return
      }

      // Ctrl+Shift+T — Reopen closed tab

      if (cmd && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault()

        dispatch({ type: "REOPEN_CLOSED_TAB" })

        return
      }

      // Ctrl+N — New file

      if (cmd && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault()

        dispatch({ type: "OPEN_UNTITLED" })

        return
      }

      // Ctrl+J — Toggle bottom panel

      if (cmd && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j") {
        e.preventDefault()

        dispatch({ type: "TOGGLE_PANEL" })

        return
      }

      // Ctrl+B — Toggle sidebar

      if (cmd && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault()

        window.dispatchEvent(new CustomEvent("ide:toggle-sidebar"))

        return
      }

      // Ctrl+Shift+` — New terminal with the default profile

      // Mirrors VS Code's default keyboard shortcut (Ctrl+Shift+`).

      // We don't try to be smart about which profile — we launch the

      // first available one. The "+" dropdown in the Terminal panel

      // lets the user pick a specific shell.

      if (cmd && e.shiftKey && e.key === "`") {
        e.preventDefault()

        void launchDefaultTerminal()

        return
      }

      // Escape — close modal

      if (e.key === "Escape" && modal) {
        dispatch({ type: "CLOSE_MODAL" })
      }

      // Ctrl+Shift+P — Command palette

      if (cmd && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault()

        dispatch({ type: "OPEN_PALETTE" })

        return
      }

      // Ctrl+F — Find (opens the Bonafide find/replace widget in find mode)

      if (cmd && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault()

        window.dispatchEvent(
          new CustomEvent("ide:open-find", { detail: { mode: "find" } }),
        )

        return
      }

      // Ctrl+H — Replace (opens the Bonafide find/replace widget with the

      // replace row expanded)

      if (cmd && !e.shiftKey && e.key.toLowerCase() === "h") {
        e.preventDefault()

        window.dispatchEvent(
          new CustomEvent("ide:open-find", { detail: { mode: "replace" } }),
        )

        return
      }

      // Ctrl+Shift+G — refresh source-control state. The panel itself
      // listens for this via a custom event so it can stay decoupled
      // from App.tsx's keyboard router.

      if (cmd && e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent("ide:git-refresh"))
        return
      }
    }

    window.addEventListener("keydown", onKey)

    return () => window.removeEventListener("keydown", onKey)
  }, [activeTab, dispatch, modal, pushToast, openFolder, launchDefaultTerminal])

  // ── Custom event listeners ──────────────────────────────────────────────

  // These handle events fired by the command palette and other components.

  // ide:open-file — open an arbitrary file by absolute path.

  // Adds it to the file tree (or activates existing tab) and loads its content.

  useEffect(() => {
    async function onOpenFile(e: Event) {
      const path = (e as CustomEvent<{ path: string }>).detail?.path

      if (!path) return

      const state = store.getState()

      // If the file is already in the tree, just open its tab.

      const existing = state.fileTree.find((n) => n.id === path)

      if (existing && existing.kind === "file") {
        dispatch({ type: "OPEN_FILE", fileId: existing.id })

        return
      }

      // Not in tree — read the file content and add it as a new node.

      try {
        const { content } = await bonafide.fs.readFile(path)

        const name = path.split(/[/\\]/).pop() ?? path

        const parentId = state.workspaceRoot ?? null

        // ADD_FILE creates the node and opens a tab for it.

        dispatch({ type: "ADD_FILE", parentId, name })

        // Now set the content we just read.

        const newState = store.getState()

        const newNode = newState.fileTree.find(
          (n) => n.name === name && n.parentId === parentId,
        )

        if (newNode) {
          dispatch({ type: "SET_CONTENT", fileId: newNode.id, content })
        }
      } catch {
        pushToast("Failed to open file", "error")
      }
    }

    // ide:toggle-sidebar — dispatches to the UtilityDock's visible signal.

    function onToggleSidebar() {
      window.dispatchEvent(new CustomEvent("bonafide:toggle-sidebar"))
    }

    window.addEventListener("ide:open-file", onOpenFile)

    window.addEventListener("ide:toggle-sidebar", onToggleSidebar)

    window.addEventListener(
      "bonafide:open-prefs",
      ((e: CustomEvent<string>) => {
        const section = e.detail
        if (section === "models" || section === "settings" || section === "account") {
          setPrefs(section as PrefSection)
        }
      }) as EventListener,
    )

    return () => {
      window.removeEventListener("ide:open-file", onOpenFile)
      window.removeEventListener("ide:toggle-sidebar", onToggleSidebar)
    }
  }, [dispatch, store, pushToast])

  // Rendered behind the main UI when no folder is open.

  // The Sidebar and editor stay mounted so keyboard shortcuts keep working.

  const showEmptyState = !workspaceRoot

  function onDockSelect(id: DockId) {
    if (id === "account") setPrefs("account")
    else if (id === "settings") setPrefs("settings")
    else if (id === "models") setPrefs("models")
    else if (id === "workflow") setWorkflowOpen((v) => !v)
    else setDock(id)
  }

  return (
    <RunsProvider workspaceRoot={workspaceRoot ?? null}>
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-surface-container-lowest text-on-surface">
      <TitleBar />

      {/* Workspace empty state — full-screen overlay */}
      {showEmptyState && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center">
          <div className="pointer-events-auto flex max-w-sm flex-col items-center gap-6 rounded-2xl border border-outline-variant bg-surface-container/80 p-10 text-center backdrop-blur-xl">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-container">
              <Icon name="folder-open" size={32} className="text-secondary" />
            </div>
            <div>
              <p className="font-sans text-[18px] font-medium text-on-surface">
                No folder open
              </p>
              <p className="mt-1 font-body text-[13px] text-on-surface-variant">
                Bonafide needs a project folder to browse files and run
                experiments. Open a folder to get started.
              </p>
            </div>
            <button
              onClick={openFolder}
              className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 font-sans text-[14px] font-medium text-on-primary transition-opacity hover:brightness-110"
            >
              <Icon name="folder-open" size={16} />
              Open Folder
            </button>
            <div className="flex items-center gap-4 font-sans text-[12px] text-outline">
              <span>⌘O to open</span>
              <span>·</span>
              <span>Ctrl+O on Windows</span>
            </div>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <UtilityDock
          active={prefs ? "settings" : workflowOpen ? "workflow" : dock}
          onSelect={onDockSelect}
          signedIn={false}
        />
        <Sidebar
          view={dock}
          workspaceRoot={workspaceRoot}
          workspaceName={workspaceName}
          onOpenFolder={openFolder}
          width={sidebarWidth}
        />
        <ResizeHandle
          width={sidebarWidth}
          onResize={setSidebarWidth}
          minWidth={180}
          maxWidth={520}
          side="right"
          ariaLabel="Resize sidebar"
        />

        {/* Right region: editor + panel | inspector.
            The Panel sits in the same column as the editor so its
            horizontal bounds never extend under the Inspector tab. */}
        <div className="flex min-w-0 flex-1">
          {/* Editor column: editor pane on top, bottom panel below */}
          <div className="flex min-w-0 min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 min-w-0 flex-1">
              <EditorPane
                activeTabId={activeTabId ?? ""}
                onActivate={activateTab}
                onClose={closeTab}
                onSelectRun={openRun}
              />
            </div>
            {/* Bottom panel (Problems, Output, Terminal, Debug Console, Ports).
                Sibling of the editor pane so it only spans the editor's width. */}
            <Panel />
          </div>

          {inspectorOpen ? (
            <>
              <ResizeHandle
                width={inspectorWidth}
                onResize={setInspectorWidth}
                minWidth={240}
                maxWidth={560}
                side="left"
                ariaLabel="Resize inspector"
              />
              <Inspector
                width={inspectorWidth}
                onClose={() => setInspectorOpen(false)}
                onOpenWorkflow={() => setWorkflowOpen(true)}
                run={inspectorRun}
              />
            </>
          ) : (
            <button
              onClick={() => setInspectorOpen(true)}
              className="flex w-1 shrink-0 items-center justify-center bg-outline-variant/40 hover:bg-primary"
              aria-label="Open inspector"
              title="Open Run Inspector"
            />
          )}
        </div>
      </div>

      <StatusBar workspaceName={workspaceName} />

      {/* Modal (delete / close-dirty) */}
      <Modal
        modal={modal}
        onConfirmDelete={confirmDelete}
        onCancelDelete={cancelDelete}
        onCloseDirtyCancel={closeDirtyCancel}
        onCloseDirtyDontSave={closeDirtyDontSave}
        onCloseDirtySave={closeDirtySave}
        onClose={() => dispatch({ type: "CLOSE_MODAL" })}
      />

      {/* Toast host */}
      <ToastHost />

      {prefs && (
        <PreferencesWindow
          initialSection={prefs}
          onClose={() => setPrefs(null)}
        />
      )}
      {workflowOpen && <WorkflowPanel onClose={() => setWorkflowOpen(false)} />}

      {/* Command palette (Ctrl+Shift+P) */}
      <CommandPalette />
    </div>
    </RunsProvider>
  )
}
