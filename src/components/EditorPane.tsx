import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "./ui/Icon";
import { ChartTab } from "./ChartTab";
import { ExperimentsTab } from "./ExperimentsTab";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { MergeViewEditor } from "../ide/MergeViewEditor";
import {
  useActiveFile,
  useActiveMergeReview,
  useContextMenuState,
  useDispatch,
  useIdeStore,
  useTabs,
  useToast,
  useWorkspaceRoot,
} from "../ide/hooks";
import { ContextMenu } from "./ContextMenu";
import { getTabMenu, getEditorMenu } from "../ide/menus";
import { bonafide } from "../ipc/tauri";
import type { Tab, DiagnosticEntry } from "../ide/store.tsx";

// ── Tab strip ─────────────────────────────────────────────────────────────

function TabStrip({
  activeId,
  onActivate,
  onClose,
  onAdd,
  onContextMenu,
}: {
  activeId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
  onContextMenu: (e: React.MouseEvent, tabId: string) => void;
}) {
  const tabs = useTabs();
  const store = useIdeStore();
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renamingTabId && renameRef.current) {
      renameRef.current.focus();
      renameRef.current.select();
    }
  }, [renamingTabId]);

  function startRename(tab: Tab) {
    setRenamingTabId(tab.id);
    setRenameValue(tab.name);
  }

  function commitRename(tab: Tab) {
    const newName = renameValue.trim();
    if (newName && newName !== tab.name) {
      store.dispatch({ type: "RENAME", nodeId: tab.fileId, name: newName });
    }
    setRenamingTabId(null);
  }

  function onRenameKey(e: ReactKeyboardEvent<HTMLInputElement>, tab: Tab) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename(tab);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setRenamingTabId(null);
    }
  }

  // Listen for "rename tab" events dispatched from the tab context menu
  useEffect(() => {
    function onRenameRequest(e: Event) {
      const tabId = (e as CustomEvent).detail as string;
      const tab = tabs.find((t) => t.id === tabId);
      if (tab) startRename(tab);
    }
    window.addEventListener("ide:rename-tab", onRenameRequest as EventListener);
    return () => window.removeEventListener("ide:rename-tab", onRenameRequest as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-outline-variant bg-surface-container-lowest">
      {tabs.map((t) => {
        const isActive = t.id === activeId;
        const isRenaming = renamingTabId === t.id;
        const isChartTab = t.fileId === "__virtual__/chart";
        const isExperimentsTab = t.fileId === "__virtual__/experiments";

        let icon = "python";
        let iconClass = "text-tertiary";
        if (isChartTab) {
          icon = "line-chart";
          iconClass = "text-primary";
        } else if (isExperimentsTab) {
          icon = "flask-conical";
          iconClass = "text-secondary";
        }

        return (
          <div
            key={t.id}
            onClick={() => onActivate(t.id)}
            onContextMenu={(e) => onContextMenu(e, t.id)}
            className={`group relative flex cursor-pointer items-center gap-2 border-r border-outline-variant px-3 font-sans text-[13px] transition-colors duration-[120ms] ${
              isActive
                ? "bg-surface-container text-on-surface"
                : "bg-surface-container-low text-on-surface-variant hover:bg-surface-container-high"
            }`}
          >
            {isActive && <span className="absolute left-0 top-0 h-0.5 w-full bg-primary" />}
            <Icon name={icon} size={14} className={iconClass} />
            {isRenaming ? (
              <input
                ref={renameRef}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => onRenameKey(e, t)}
                onBlur={() => commitRename(t)}
                className="w-32 rounded-sm border border-primary bg-surface px-1 font-sans text-[13px] text-on-surface focus:outline-none"
              />
            ) : (
              <span className={t.dirty ? "font-medium" : ""}>{t.name}</span>
            )}
            {t.dirty && !isRenaming && (
              <span
                className="h-2 w-2 rounded-full bg-tertiary"
                title="Unsaved changes"
              />
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
              className="text-outline opacity-0 transition-opacity hover:text-on-surface group-hover:opacity-60"
              aria-label={`Close ${t.name}`}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        );
      })}
      <button
        onClick={onAdd}
        className="flex w-9 items-center justify-center text-outline hover:bg-surface-container hover:text-on-surface"
        aria-label="New untitled file"
        title="New Untitled File (Ctrl+N)"
      >
        <Icon name="plus" size={14} />
      </button>
      <div className="flex-1" />
      <div className="flex items-center gap-0.5 pr-2">
        <button
          className="flex h-7 w-7 items-center justify-center rounded text-outline hover:bg-surface-container hover:text-on-surface"
          title="Open Preview to the Side"
          aria-label="Open Preview to the Side"
        >
          <Icon name="preview-side" size={15} />
        </button>
        <button
          className="flex h-7 w-7 items-center justify-center rounded text-outline hover:bg-surface-container hover:text-on-surface"
          title="Split Editor Right"
          aria-label="Split Editor Right"
        >
          <Icon name="split-square" size={15} />
        </button>
      </div>
    </div>
  );
}

// ── Editor pane ───────────────────────────────────────────────────────────

export function EditorPane({
  activeTabId,
  onActivate,
  onClose,
  onSelectRun: _onSelectRun,
  chartTarget,
  experimentsRun,
}: {
  activeTabId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** Kept for prop compatibility. Decorations were removed with mock runs. */
  onSelectRun?: (id: string) => void;
  chartTarget?: { runId: string; metricKey: string };
  experimentsRun?: string;
}) {
  const store = useIdeStore();
  const dispatch = useDispatch();
  const pushToast = useToast();
  const tabs = useTabs();
  const activeFile = useActiveFile();
  const activeMergeReview = useActiveMergeReview();
  const ctxMenu = useContextMenuState();

  function onTabContextMenu(e: React.MouseEvent, tabId: string) {
    e.preventDefault();
    e.stopPropagation();
    dispatch({
      type: "OPEN_CONTEXT_MENU",
      payload: { surface: "tab", targetId: tabId, x: e.clientX, y: e.clientY },
    });
  }

  // Listen for editor context menu events dispatched from the editor wrapper.
  // The Monaco container is wrapped in a div with onContextMenu so we keep
  // Bonafide's surface="editor" menu (Find, Format, etc.) and suppress
  // Monaco's built-in DOM context menu.
  useEffect(() => {
    function onEditorCtx(e: Event) {
      const detail = (e as CustomEvent).detail as { x: number; y: number };
      dispatch({
        type: "OPEN_CONTEXT_MENU",
        payload: {
          surface: "editor",
          targetId: activeTabId,
          x: detail.x,
          y: detail.y,
        },
      });
    }
    window.addEventListener("ide:editor-ctx", onEditorCtx);
    return () => window.removeEventListener("ide:editor-ctx", onEditorCtx);
  }, [dispatch, activeTabId]);

  // Listen for "open merge review" events from the editor context menu.
  // The merge review shows the original vs proposed text in a side-by-side
  // diff with accept/reject controls. Currently we open it with the current
  // file's content as both sides — the AI agent code will pass the proposed
  // text as a second argument when it triggers the review.
  useEffect(() => {
    function onEditorMerge(e: Event) {
      const detail = (e as CustomEvent).detail as {
        tabId: string;
        fileId: string;
        proposedText?: string;
      };
      const state = store.getState();
      const file = state.fileTree.find((n) => n.id === detail.fileId);
      if (!file) return;
      const rootPath = state.workspaceRoot;
      if (!rootPath) return;
      const absPath = `${rootPath}/${file.id}`;
      const proposed = detail.proposedText ?? file.content ?? "";
      dispatch({
        type: "OPEN_MERGE_REVIEW",
        absPath,
        originalText: file.content ?? "",
        proposedText: proposed,
        source: "manual review",
      });
    }
    window.addEventListener("ide:editor-merge", onEditorMerge);
    return () => window.removeEventListener("ide:editor-merge", onEditorMerge);
  }, [dispatch, store]);

  // Listen for "run ruff" events. We invoke ruff-check via Tauri IPC and
  // push the resulting diagnostics into the editor's domain-diagnostics
  // StateField via the editor component. (The LSP path is the long-term
  // primary surface, but ruff-check is the explicit one-shot entry.)
  useEffect(() => {
    function onEditorRuff(e: Event) {
      const detail = (e as CustomEvent).detail as { tabId: string; fileId: string };
      const state = store.getState();
      const file = state.fileTree.find((n) => n.id === detail.fileId);
      if (!file) return;
      const rootPath = state.workspaceRoot;
      if (!rootPath) return;
      void (async () => {
        try {
          const { ruffCheckAsDomain } = await import("../ide/ruff-linter");
          const diags = await ruffCheckAsDomain(
            `${rootPath}/${file.id}`,
            file.content ?? "",
          );

          // Aggregate ruff diagnostics into the panel's Problems tab so
          // the user sees them aggregated across files (this ruff call is
          // for one file; later we'll loop across all open files and union).
          const existing = store.getState().panel.diagnostics.filter(
            (d) => !(d.fileId === file.id && d.source === "ruff"),
          );
          const newEntries: DiagnosticEntry[] = diags.map((d, idx) => ({
            id: `ruff_${file.id}_${idx}_${Date.now()}`,
            fileId: file.id,
            fileLabel: file.id,
            line: d.message.match(/(\d+):(\d+)/)?.[1]
              ? Number(d.message.match(/(\d+):(\d+)/)![1])
              : 0,
            col: d.message.match(/(\d+):(\d+)/)?.[2]
              ? Number(d.message.match(/(\d+):(\d+)/)![2])
              : 0,
            severity: d.severity === "info" ? "info" : d.severity === "warning" ? "warning" : "error",
            code: d.source ?? "ruff",
            message: d.message,
            source: "ruff",
          }));
          dispatch({ type: "SET_DIAGNOSTICS", diagnostics: [...existing, ...newEntries] });
          dispatch({ type: "SET_PANEL_TAB", tab: "problems" });
          if (diags.length > 0) {
            dispatch({ type: "TOGGLE_PANEL" });
          }

          pushToast(
            diags.length === 0
              ? "No ruff issues found"
              : `Ruff found ${diags.length} issue${diags.length === 1 ? "" : "s"}`,
            diags.length === 0 ? "success" : "info",
          );
        } catch (err) {
          console.error("[ruff] check failed", err);
          pushToast("Ruff check failed", "error");
        }
      })();
    }
    window.addEventListener("ide:editor-ruff", onEditorRuff);
    return () => window.removeEventListener("ide:editor-ruff", onEditorRuff);
  }, [dispatch, pushToast, store]);

  // ── Save handler ───────────────────────────────────────────────────────
  // Called by CodeMirrorEditor when the user hits Ctrl+S. The
  // CodeMirrorEditor already keeps the store content in sync via
  // onChange — this handler is responsible for: (1) flipping dirty →
  // false on the tab, and (2) writing the file to disk when an absPath
  // is available.
  const onEditorSave = useCallback(
    async (fileId: string, absPath: string | null, currentValue: string) => {
      // Flush the latest content to the store BEFORE writing to disk so
      // the store is always in sync with what's on disk. This matters for
      // file-reopen: if the user saves and immediately closes the tab,
      // the debounced handleChange might not have fired yet.
      dispatch({ type: "SET_CONTENT", fileId, content: currentValue });
      const state = store.getState();
      const tab = state.tabs.find((t) => t.fileId === fileId);
      if (tab) {
        dispatch({ type: "MARK_DIRTY", tabId: tab.id, dirty: false });
      }
      if (!absPath) {
        pushToast(`Saved "${tab?.name ?? "file"}"`, "success");
        return;
      }
      try {
        await bonafide.fs.writeFile(absPath, currentValue);
        pushToast(`Saved "${tab?.name ?? "file"}"`, "success");
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[EditorPane] failed to write file", absPath, err);
        pushToast("Failed to save file", "error");
      }
    },
    [dispatch, pushToast, store],
  );

  // Global Ctrl+S safety net: if focus is somewhere outside Monaco (e.g.
  // a rename input, or the gutter area), Ctrl+S still saves the active
  // file. Monaco handles its own Ctrl+S while focused; this listener
  // only fires when no editor is focused.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s")) {
        return;
      }
      const target = e.target as HTMLElement | null;
      // If focus is inside a Monaco textarea, Monaco already handled it
      // and called preventDefault. Don't double-fire.
      if (target && target.tagName === "TEXTAREA" && target.classList.contains("inputarea")) {
        return;
      }
      const state = store.getState();
      const tab = state.activeTabId
        ? state.tabs.find((t) => t.id === state.activeTabId)
        : null;
      if (!tab || !tab.dirty) return;
      e.preventDefault();
      const file = state.fileTree.find((n) => n.id === tab.fileId);
      if (!file) return;
      const absPath = state.workspaceRoot
        ? `${state.workspaceRoot}/${file.id}`
        : null;
      void onEditorSave(file.id, absPath, file.content ?? "");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEditorSave, store]);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Use the reactive selector so absPath updates the moment the workspace
  // is opened. The previous code read store.getState().workspaceRoot once
  // at mount — so absPath was always null even after openFolder succeeded.
  const workspaceRoot = useWorkspaceRoot();
  const activeAbsPath =
    activeFile && workspaceRoot ? `${workspaceRoot}/${activeFile.id}` : null;

  // Monaco now owns the contextmenu event via a capture-phase listener
  // (set in handleMount) so Bonafide's menu opens without needing a
  // wrapper handler. The event it dispatches is consumed by the
  // EditorPane's "ide:editor-ctx" listener registered in the useEffect
  // above.

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <TabStrip
        activeId={activeTabId}
        onActivate={onActivate}
        onClose={onClose}
        onAdd={() => dispatch({ type: "OPEN_UNTITLED" })}
        onContextMenu={onTabContextMenu}
      />

      {activeTab?.fileId === "__virtual__/chart" && chartTarget ? (
        <ChartTab runId={chartTarget.runId} metricKey={chartTarget.metricKey} />
      ) : activeTab?.fileId === "__virtual__/experiments" && experimentsRun ? (
        <ExperimentsTab runId={experimentsRun} />
      ) : activeMergeReview ? (
        // Merge review: user is reviewing an AI agent's patch before it lands.
        // The merge editor handles its own save/close lifecycle through
        // RESOLVE_MERGE_REVIEW (accept all) / CLOSE_MERGE_REVIEW (reject).
        <MergeViewEditor
          originalText={activeMergeReview.originalText}
          proposedText={activeMergeReview.proposedText}
          onAccept={(mergedText) => {
            dispatch({
              type: "RESOLVE_MERGE_REVIEW",
              reviewId: activeMergeReview.id,
              mergedText,
            });
            void bonafide.fs
              .writeFile(activeMergeReview.absPath, mergedText)
              .then(() => {
                pushToast(
                  `Wrote ${activeMergeReview.absPath.split("/").pop() ?? activeMergeReview.absPath} to disk`,
                  "success",
                );
              })
              .catch((err) => {
                console.error("[merge] writeFile failed", err);
                pushToast("Failed to write merged file", "error");
              });
          }}
          onReject={() => {
            dispatch({ type: "CLOSE_MERGE_REVIEW", reviewId: activeMergeReview.id });
            pushToast("Rejected changes", "info");
          }}
        />
      ) : activeFile ? (
        // The wrapper paints `bg-surface` (#111318) for a hard
        // guarantee against *any* uncovered pixel.
        //
        // Why it's back: the previous removal of `bg-surface` from
        // this wrapper (intended to remove the "shadow zone"
        // produced by `.cm-activeLine`'s solid background) left the
        // wrapper transparent. With nothing behind it but the parent
        // column (`bg-surface-container-lowest` = #0c0e13, darker than
        // the editor), any layout pass that exposes a strip of
        // wrapper before CodeMirror mounts its own dark background
        // shows up as a *darker* strip than the editor — which the
        // user's eye reads as a "lighter zone" because the editor's
        // own paint is the upper bound of the editor's brightness.
        // That was the source of the left-30% lighter block.
        //
        // By giving the wrapper the *exact same* surface color the
        // editor paints (#111318), any exposed pixel during a layout
        // pass is visually identical to the editor paint itself.
        // There is no longer any shade boundary between the editor
        // root and its wrapper — they read as one continuous dark
        // rectangle.
        //
        // The `.cm-activeLine` highlight was changed to
        // `backgroundColor: transparent` + an inset box-shadow left
        // bar in the same pass, so the active-line visual is now a
        // thin primary-color stripe on the cursor line, not a
        // background band — meaning it no longer combines with the
        // wrapper paint to produce a perceptible zone.
        <div className="relative flex min-h-0 flex-1 overflow-hidden bg-surface">
          <CodeMirrorEditor
            fileId={activeFile.id}
            fileType={activeFile.fileType}
            content={activeFile.content ?? ""}
            absPath={activeAbsPath}
            onSave={(currentValue) =>
              void onEditorSave(activeFile.id, activeAbsPath, currentValue)
            }
          />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center bg-surface font-body text-[13px] text-on-surface-variant">
          <div className="text-center">
            <Icon name="file" size={28} className="mx-auto mb-2 text-outline-variant" />
            <p>No file open</p>
            <p className="mt-1 text-[12px] text-outline">
              Click a file in the Explorer or press Ctrl+N to create one.
            </p>
          </div>
        </div>
      )}

      {/* Tab context menu */}
      {ctxMenu?.surface === "tab" &&
        (() => {
          const tab = tabs.find((t) => t.id === ctxMenu.targetId);
          if (!tab) return null;
          return (
            <ContextMenu
              x={ctxMenu.x}
              y={ctxMenu.y}
              items={getTabMenu(store, tab)}
              onClose={() => dispatch({ type: "CLOSE_CONTEXT_MENU" })}
            />
          );
        })()}

      {/* Editor context menu */}
      {ctxMenu?.surface === "editor" && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={getEditorMenu(store, activeTab ?? null)}
          onClose={() => dispatch({ type: "CLOSE_CONTEXT_MENU" })}
        />
      )}
    </div>
  );
}
