import { Component, useCallback, useEffect, useState, type ReactNode } from "react"
import { TitleBar } from "./components/TitleBar"
import { UtilityDock, type DockId } from "./components/UtilityDock"
import { Sidebar } from "./components/Sidebar"
import { EditorPane } from "./components/EditorPane"
import { Inspector } from "./components/Inspector"
import { StatusBar } from "./components/StatusBar"
import { PreferencesWindow, type PrefSection } from "./components/preferences/PreferencesWindow"
import { WorkflowPanel } from "./components/agent/WorkflowPanel"
import { Icon } from "./components/ui/Icon"
import { ResizeHandle } from "./components/ui/ResizeHandle"
import { Modal } from "./components/Modal"
import { ToastHost } from "./components/ToastHost"
import { bonafide } from "./ipc/tauri"
import {
  IdeStoreProvider,
} from "./ide/store.tsx"
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

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null };
  static getDerivedStateFromError(e: Error) { return { error: e }; }
  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen w-screen items-center justify-center bg-[#0c0e13] p-8">
          <pre className="max-w-2xl rounded border border-red-800 bg-red-950 p-4 font-mono text-[12px] text-red-300">
            {this.state.error.name}: {this.state.error.message}
            {this.state.error.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <IdeStoreProvider>
        <AppInner />
      </IdeStoreProvider>
    </ErrorBoundary>
  );
}

// #region DEBUG: AppInner render tracking
let _appLog: ((msg: string, d: Record<string, unknown>) => void) | null = null;
if (typeof window !== 'undefined') {
  _appLog = (msg, d) => fetch('http://127.0.0.1:7750/ingest/8d618420-3b75-4343-9d6c-c42e01f4bae7', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '5197ca' },
    body: JSON.stringify({ sessionId: '5197ca', id: `log_${Date.now()}`, timestamp: Date.now(), location: 'App', message: msg, data: d, runId: 'run1', hypothesisId: 'G' }),
  }).catch(() => {});
}
// #endregion

function AppInner() {
  const _renderStart = performance.now();
  const dispatch = useDispatch();
  const store = useIdeStore();
  const [dock, setDock] = useState<DockId>("explorer");
  const [selectedRun, setSelectedRun] = useState<string>("r1");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [prefs, setPrefs] = useState<PrefSection | null>(null);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  // Resizable panel widths. Persisted in component state for now; if you
  // want to remember them across launches, lift into the store + electron-store.
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [inspectorWidth, setInspectorWidth] = useState(320);

  // Use reactive selectors — these re-render the component whenever the
  // store's workspaceRoot / workspaceName changes (e.g. after openFolder).
  // The previous implementation captured these from store.getState() once at
  // mount, which meant the empty-state overlay never dismissed.
  const _t1 = performance.now();
  const workspaceRoot = useWorkspaceRoot();
  const _t2 = performance.now();
  const workspaceName = useWorkspaceName();
  const _t3 = performance.now();
  const activeTab = useActiveTab();
  const _t4 = performance.now();
  const activeFile = useActiveFile();
  const _t5 = performance.now();
  const modal = useModalState();
  const pushToast = useToast();
  const activeTabId = activeTab?.id ?? null;

  // Log selector cost. Only logs when a single selector takes >5ms.
  const _selCost = _t5 - _renderStart;
  if (_selCost > 5) {
    _appLog?.('AppInner:selector_cost', {
      totalMs: _selCost.toFixed(2),
      workspaceRootMs: (_t2 - _t1).toFixed(2),
      workspaceNameMs: (_t3 - _t2).toFixed(2),
      activeTabMs: (_t4 - _t3).toFixed(2),
      activeFileMs: (_t5 - _t4).toFixed(2),
      activeTabId: activeTabId ?? 'null',
      activeFileContentLen: activeFile?.content?.length ?? 0,
    });
  }

  const openFolder = useCallback(async () => {
    try {
      const folderPath = await bonafide.fs.pickFolder();
      if (!folderPath) return;

      const listing = await bonafide.fs.readDirectory(folderPath);

      // Convert from the FsNode shape (from Rust main process) to FileNode
      // shape (store's internal format).
      const tree: FileNode[] = listing.files.map((f) => ({
        id: f.id,
        name: f.name,
        kind: f.kind as "folder" | "file",
        parentId: f.parentId,
        expanded: f.kind === "folder" && (f.expanded ?? false),
        fileType: f.fileType as FileNode["fileType"],
      }));

      dispatch({ type: "OPEN_WORKSPACE", rootPath: listing.rootPath, rootName: listing.rootName, tree });
      pushToast(`Opened ${listing.rootName}`, "success");
    } catch (err) {
      console.error("[App] openFolder failed", err);
      pushToast("Failed to open folder", "error");
    }
  }, [dispatch, pushToast]);

  function openRun(id: string) {
    setSelectedRun(id);
    setInspectorOpen(true);
  }

  function closeTab(id: string) {
    dispatch({ type: "CLOSE_TAB", tabId: id });
  }

  function activateTab(id: string) {
    dispatch({ type: "ACTIVATE_TAB", tabId: id });
  }

  // ── Modal handlers ────────────────────────────────────────────────────

  function confirmDelete() {
    if (modal?.kind === "delete") {
      dispatch({ type: "DELETE", nodeId: modal.fileId });
    }
  }

  function cancelDelete() {
    dispatch({ type: "CLOSE_MODAL" });
  }

  function closeDirtyCancel() {
    dispatch({ type: "CLOSE_MODAL" });
  }

  function closeDirtyDontSave() {
    if (modal?.kind === "closeDirty") {
      dispatch({ type: "CLOSE_TAB", tabId: modal.tabId, force: true });
    }
  }

  function closeDirtySave() {
    if (modal?.kind === "closeDirty") {
      dispatch({ type: "MARK_DIRTY", tabId: modal.tabId, dirty: false });
      pushToast(`Saved "${modal.name}"`, "success");
      dispatch({ type: "CLOSE_TAB", tabId: modal.tabId, force: true });
    }
  }

  // #region DEBUG: track AppInner renders + measure sub-phases
  const _renderSyncDone = performance.now();
  _appLog?.('AppInner:render_sync_done', {
    ms: _renderSyncDone - _renderStart,
    activeTabId: activeTabId ?? 'null',
  });
  useEffect(() => {
    _appLog?.('AppInner:rendered', { ms: performance.now() - _renderStart, activeTabId: activeTabId ?? 'null' });
  });
  // #endregion

  // ── Keyboard shortcuts ────────────────────────────────────────────────

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const cmd = e.metaKey || e.ctrlKey;

      // Ctrl+O — Open folder
      if (cmd && !e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        openFolder();
        return;
      }

      // Ctrl+S — Save active file
      if (cmd && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (activeTab?.dirty) {
          dispatch({ type: "MARK_DIRTY", tabId: activeTab.id, dirty: false });
          pushToast(`Saved "${activeTab.name}"`, "success");
        }
        return;
      }

      // Ctrl+W — Close active tab
      if (cmd && !e.shiftKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (activeTab) closeTab(activeTab.id);
        return;
      }

      // Ctrl+Shift+T — Reopen closed tab
      if (cmd && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        dispatch({ type: "REOPEN_CLOSED_TAB" });
        return;
      }

      // Ctrl+N — New file
      if (cmd && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        dispatch({ type: "OPEN_UNTITLED" });
        return;
      }

      // Escape — close modal
      if (e.key === "Escape" && modal) {
        dispatch({ type: "CLOSE_MODAL" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTab, dispatch, modal, pushToast, openFolder]);

  // ── Workspace empty state ────────────────────────────────────────────
  // Rendered behind the main UI when no folder is open.
  // The Sidebar and editor stay mounted so keyboard shortcuts keep working.
  const showEmptyState = !workspaceRoot;

  function onDockSelect(id: DockId) {
    if (id === "account") setPrefs("account");
    else if (id === "settings") setPrefs("settings");
    else if (id === "workflow") setWorkflowOpen((v) => !v);
    else setDock(id);
  }

  return (
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
              <p className="font-sans text-[18px] font-medium text-on-surface">No folder open</p>
              <p className="mt-1 font-body text-[13px] text-on-surface-variant">
                Bonafide needs a project folder to browse files and run experiments.
                Open a folder to get started.
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

        {/* Center column: editor */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <EditorPane
              activeTabId={activeTabId ?? ""}
              onActivate={activateTab}
              onClose={closeTab}
              onSelectRun={openRun}
            />
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
                <Inspector width={inspectorWidth} onClose={() => setInspectorOpen(false)} />
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

      {prefs && <PreferencesWindow initialSection={prefs} onClose={() => setPrefs(null)} />}
      {workflowOpen && <WorkflowPanel onClose={() => setWorkflowOpen(false)} />}
    </div>
  );
}
