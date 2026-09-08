import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Icon } from "./ui/Icon";
import type { DockId } from "./UtilityDock";
import { ExperimentsView } from "./panels/ExperimentsView";
import { SourceControlView } from "./panels/SourceControlView";
import { ArtifactsView } from "./panels/ArtifactsView";
import {
  useActiveTab,
  useCollapsed,
  useContextMenuState,
  useDispatch,
  useFileTree,
  useFocusedNodeId,
  useIdeStore,
} from "../ide/hooks";
import type { FileNode } from "../ide/fileTree";
import { walkVisible, nameExists, extToLangId } from "../ide/fileTree";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { getTreeMenu } from "../ide/menus";
import { preloadContent, _dbgPreload } from "../ide/preloadCache";

// ── Helpers ────────────────────────────────────────────────────────────────

function fileIconForNode(node: FileNode): string {
  if (node.kind === "folder") return "folder";
  const lang = node.fileType ?? extToLangId(node.name);
  if (lang === "python") return "python";
  if (lang === "markdown") return "file-code";
  if (lang === "json" || lang === "yaml" || lang === "toml") return "file-code";
  if (lang === "typescript" || lang === "tsx") return "file-code";
  if (lang === "css") return "file-code";
  if (lang === "shell") return "terminal";
  return "file";
}

function nodeIconColor(node: FileNode): string {
  if (node.kind === "folder") return "text-secondary";
  const lang = node.fileType ?? extToLangId(node.name);
  if (lang === "python") return "text-tertiary";
  if (lang === "json" || lang === "typescript" || lang === "tsx") return "text-primary";
  return "text-outline";
}

// ── Generic header ────────────────────────────────────────────────────────

function Header({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-b border-outline-variant px-3">
      <span className="label-caps text-on-surface-variant">{title}</span>
      <div className="flex items-center gap-2 text-outline">{right}</div>
    </div>
  );
}

// ── Explorer view ──────────────────────────────────────────────────────────

type InlineMode =
  | { kind: "new-file"; parentId: string | null }
  | { kind: "new-folder"; parentId: string | null }
  | { kind: "rename"; nodeId: string }
  | null;

function ExplorerView({ activeTabId, workspaceRoot, onOpenFolder }: {
  activeTabId: string | null;
  workspaceRoot: string | null;
  onOpenFolder: () => void;
}) {
  const tree = useFileTree();
  const collapsed = useCollapsed();
  const focusedNodeId = useFocusedNodeId();
  const dispatch = useDispatch();
  const store = useIdeStore();
  const ctxMenu = useContextMenuState();

  const [inlineMode, setInlineMode] = useState<InlineMode>(null);
  const [inlineValue, setInlineValue] = useState("");
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [spin, setSpin] = useState(false);
  const [allCollapsed, setAllCollapsed] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const treeContainerRef = useRef<HTMLDivElement | null>(null);

  // Track "all collapsed" state for icon swap
  useEffect(() => {
    const visible = [...walkVisible(tree, collapsed)];
    const folders = visible.filter((v) => v.node.kind === "folder");
    if (folders.length === 0) {
      setAllCollapsed(false);
      return;
    }
    const expandedCount = folders.filter(
      (v) => v.node.expanded && !collapsed[v.node.id],
    ).length;
    setAllCollapsed(expandedCount === 0);
  }, [tree, collapsed]);

  // Auto-focus inline input when it appears
  useEffect(() => {
    if (inlineMode && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [inlineMode]);

  // Watch for tree-level "rename" request via FOCUS_NODE (a Sidebar-internal marker)
  // For now, we rely on F2 / context menu to trigger rename mode externally.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      // F2 → rename focused node
      if (e.key === "F2" && focusedNodeId) {
        e.preventDefault();
        const node = tree.find((n) => n.id === focusedNodeId);
        if (node) {
          setInlineMode({ kind: "rename", nodeId: node.id });
          setInlineValue(node.name);
          setInlineError(null);
        }
      }
      // Delete → open delete modal for focused node
      if (e.key === "Delete" && focusedNodeId) {
        e.preventDefault();
        const node = tree.find((n) => n.id === focusedNodeId);
        if (node) {
          dispatch({
            type: "OPEN_MODAL",
            payload: {
              kind: "delete",
              fileId: node.id,
              name: node.name,
              isFolder: node.kind === "folder",
              descendantCount:
                node.kind === "folder"
                  ? tree.filter((n) => {
                      let cur = n;
                      while (cur.parentId !== null) {
                        if (cur.parentId === node.id) return true;
                        const p = tree.find((p) => p.id === cur.parentId);
                        if (!p) return false;
                        cur = p;
                      }
                      return false;
                    }).length
                  : 0,
            },
          });
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusedNodeId, tree, dispatch]);

  function startNewFile(parentId: string | null) {
    setInlineMode({ kind: "new-file", parentId });
    setInlineValue("");
    setInlineError(null);
  }

  function startNewFolder(parentId: string | null) {
    setInlineMode({ kind: "new-folder", parentId });
    setInlineValue("");
    setInlineError(null);
  }

  function startRename(nodeId: string, currentName: string) {
    setInlineMode({ kind: "rename", nodeId });
    setInlineValue(currentName);
    setInlineError(null);
  }

  function commitInline() {
    if (!inlineMode) return;
    const name = inlineValue.trim();
    if (!name) {
      setInlineMode(null);
      return;
    }

    if (inlineMode.kind === "new-file") {
      if (nameExists(tree, inlineMode.parentId, name)) {
        setInlineError("File exists");
        setTimeout(() => setInlineError(null), 600);
        return;
      }
      dispatch({ type: "ADD_FILE", parentId: inlineMode.parentId, name });
      setInlineMode(null);
    } else if (inlineMode.kind === "new-folder") {
      if (nameExists(tree, inlineMode.parentId, name)) {
        setInlineError("Folder exists");
        setTimeout(() => setInlineError(null), 600);
        return;
      }
      dispatch({ type: "ADD_FOLDER", parentId: inlineMode.parentId, name });
      setInlineMode(null);
    } else if (inlineMode.kind === "rename") {
      const result = dispatch({ type: "RENAME", nodeId: inlineMode.nodeId, name });
      // Re-check via state
      const node = store.getState().fileTree.find((n) =>
        n.id.startsWith(inlineMode.nodeId.replace(/[^/]+$/, name)),
      );
      // For simplicity, just close — error handled in reducer with a toast
      setInlineMode(null);
    }
  }

  function cancelInline() {
    setInlineMode(null);
    setInlineValue("");
    setInlineError(null);
  }

  function onInlineKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitInline();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelInline();
    }
  }

  function refresh() {
    setSpin(true);
    window.setTimeout(() => setSpin(false), 700);
    // Reload the current workspace by re-reading the directory.
    if (workspaceRoot) {
      onOpenFolder();
    }
  }

  function toggleAll() {
    if (allCollapsed) {
      dispatch({ type: "EXPAND_ALL" });
    } else {
      dispatch({ type: "COLLAPSE_ALL" });
    }
  }

  function onTreeClick(e: React.MouseEvent, node: FileNode) {
    e.stopPropagation();
    dispatch({ type: "FOCUS_NODE", nodeId: node.id });
    if (node.kind === "folder") {
      dispatch({ type: "TOGGLE_COLLAPSE", nodeId: node.id });
    } else {
      // ── Pre-warm the file content BEFORE Monaco mounts ─────────────
      // Monaco's first init in dev mode holds the main thread for 30+
      // seconds, blocking any IPC response in flight. By firing the
      // disk read here (in the click task, before OPEN_FILE dispatches),
      // the IPC response is already buffered in Tauri by the time
      // MonacoEditor mounts, so the editor reads from cache and
      // renders instantly.
      if (workspaceRoot) {
        const absPath = `${workspaceRoot}/${node.id}`;
        _dbgPreload("Sidebar.onTreeClick", "preload_dispatch", { absPath, fileId: node.id });
        preloadContent(absPath);
      }
      dispatch({ type: "OPEN_FILE", fileId: node.id });
    }
  }

  function onTreeContextMenu(e: React.MouseEvent, node: FileNode) {
    e.preventDefault();
    e.stopPropagation();
    dispatch({ type: "FOCUS_NODE", nodeId: node.id });
    dispatch({
      type: "OPEN_CONTEXT_MENU",
      payload: { surface: "tree", targetId: node.id, x: e.clientX, y: e.clientY },
    });
  }

  function onTreeKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      dispatch({ type: "MOVE_FOCUS", delta: 1 });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      dispatch({ type: "MOVE_FOCUS", delta: -1 });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!focusedNodeId) return;
      const node = tree.find((n) => n.id === focusedNodeId);
      if (!node) return;
      if (node.kind === "folder") {
        dispatch({ type: "TOGGLE_COLLAPSE", nodeId: node.id });
      } else {
        dispatch({ type: "OPEN_FILE", fileId: node.id });
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (!focusedNodeId) return;
      const node = tree.find((n) => n.id === focusedNodeId);
      if (node?.kind === "folder" && (node.expanded ?? true) && !collapsed[node.id]) {
        dispatch({ type: "TOGGLE_COLLAPSE", nodeId: node.id });
      }
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (!focusedNodeId) return;
      const node = tree.find((n) => n.id === focusedNodeId);
      if (!node) return;
      if (node.kind === "folder" && (!(node.expanded ?? true) || collapsed[node.id])) {
        dispatch({ type: "TOGGLE_COLLAPSE", nodeId: node.id });
      }
    }
  }

  const visible = [...walkVisible(tree, collapsed)];

  return (
    <>
      <Header
        title="Explorer"
        right={
          <>
            <button
              onClick={() => startNewFile(null)}
              title="New File"
              aria-label="New File"
              className="flex h-6 w-6 items-center justify-center rounded text-outline transition-colors hover:bg-surface-container hover:text-on-surface"
            >
              <Icon name="file-plus" size={14} />
            </button>
            <button
              onClick={() => startNewFolder(null)}
              title="New Folder"
              aria-label="New Folder"
              className="flex h-6 w-6 items-center justify-center rounded text-outline transition-colors hover:bg-surface-container hover:text-on-surface"
            >
              <Icon name="folder-plus" size={14} />
            </button>
            <span className={spin ? "animate-sync-spin" : ""}>
              <button
                onClick={refresh}
                title="Refresh"
                aria-label="Refresh"
                className="flex h-6 w-6 items-center justify-center rounded text-outline transition-colors hover:bg-surface-container hover:text-on-surface"
              >
                <Icon name="refresh" size={14} />
              </button>
            </span>
            <button
              onClick={toggleAll}
              title={allCollapsed ? "Expand All" : "Collapse All"}
              aria-label={allCollapsed ? "Expand All" : "Collapse All"}
              className="flex h-6 w-6 items-center justify-center rounded text-outline transition-colors hover:bg-surface-container hover:text-on-surface"
            >
              <Icon name={allCollapsed ? "chevrons-right" : "collapse"} size={14} />
            </button>
          </>
        }
      />
      <div
        ref={treeContainerRef}
        tabIndex={0}
        onKeyDown={onTreeKeyDown}
        className="flex-1 overflow-y-auto py-1 font-sans text-[13px] outline-none"
      >
        {/* Inline input row — rendered at root */}
        {inlineMode &&
          (inlineMode.kind === "new-file" || inlineMode.kind === "new-folder") &&
          inlineMode.parentId === null && (
            <InlineInputRow
              inputRef={inputRef}
              value={inlineValue}
              onChange={setInlineValue}
              onKeyDown={onInlineKeyDown}
              onBlur={commitInline}
              icon={inlineMode.kind === "new-folder" ? "folder-plus" : "file-plus"}
              error={inlineError}
              depth={0}
            />
          )}

        {visible.map(({ node, depth }) => {
          const isFolder = node.kind === "folder";
          const open = isFolder && (node.expanded ?? true) && !collapsed[node.id];
          const isFocused = focusedNodeId === node.id;
          const isActive = !isFolder && activeTabId !== null && tree.find(
            (n) => n.id === node.id && store.getState().tabs.find((t) => t.id === activeTabId)?.fileId === n.id,
          ) !== undefined;

          // Render inline rename input if this is the renaming node
          if (inlineMode?.kind === "rename" && inlineMode.nodeId === node.id) {
            return (
              <InlineInputRow
                key={node.id}
                inputRef={inputRef}
                value={inlineValue}
                onChange={setInlineValue}
                onKeyDown={onInlineKeyDown}
                onBlur={commitInline}
                icon="edit-2"
                error={inlineError}
                depth={depth}
              />
            );
          }

          // Render inline "new file/folder" input if this is the parent and it's at root
          if (
            (inlineMode?.kind === "new-file" || inlineMode?.kind === "new-folder") &&
            (inlineMode as { parentId?: string | null })?.parentId === node.id
          ) {
            return (
              <div key={node.id}>
                {/* Existing node row */}
                <TreeRow
                  node={node}
                  depth={depth}
                  open={open}
                  isFocused={isFocused}
                  isActive={!!isActive}
                  onClick={onTreeClick}
                  onContextMenu={onTreeContextMenu}
                />
                <InlineInputRow
                  inputRef={inputRef}
                  value={inlineValue}
                  onChange={setInlineValue}
                  onKeyDown={onInlineKeyDown}
                  onBlur={commitInline}
                  icon={
                    inlineMode.kind === "new-folder" ? "folder-plus" : "file-plus"
                  }
                  error={inlineError}
                  depth={depth + 1}
                />
              </div>
            );
          }

          return (
            <TreeRow
              key={node.id}
              node={node}
              depth={depth}
              open={open}
              isFocused={isFocused}
              isActive={!!isActive}
              onClick={onTreeClick}
              onContextMenu={onTreeContextMenu}
            />
          );
        })}

        {tree.length === 0 && (
          <div className="px-3 py-4 font-body text-[13px] text-on-surface-variant">
            This folder is empty. Open a folder to browse your project.
          </div>
        )}
      </div>

      {/* Tree context menu */}
      {ctxMenu?.surface === "tree" && (() => {
        const node = tree.find((n) => n.id === ctxMenu.targetId);
        if (!node) return null;
        const items: MenuItem[] = getTreeMenu(store, node);
        return (
          <ContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            items={items}
            onClose={() => dispatch({ type: "CLOSE_CONTEXT_MENU" })}
          />
        );
      })()}
    </>
  );
}

// ── Tree row ───────────────────────────────────────────────────────────────

function TreeRow({
  node,
  depth,
  open,
  isFocused,
  isActive,
  onClick,
  onContextMenu,
}: {
  node: FileNode;
  depth: number;
  open: boolean;
  isFocused: boolean;
  isActive: boolean;
  onClick: (e: React.MouseEvent, n: FileNode) => void;
  onContextMenu: (e: React.MouseEvent, n: FileNode) => void;
}) {
  const isFolder = node.kind === "folder";
  return (
    <button
      onClick={(e) => onClick(e, node)}
      onContextMenu={(e) => onContextMenu(e, node)}
      className={`relative flex h-6 w-full items-center gap-2 pr-2 text-left transition-colors duration-[120ms] ${
        isActive
          ? "bg-surface-container-high text-on-surface"
          : isFocused
          ? "bg-surface-container text-on-surface"
          : "text-on-surface-variant hover:bg-surface-container"
      }`}
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      {isActive && <span className="absolute left-0 top-0 h-full w-0.5 bg-primary" />}
      {isFolder ? (
        <Icon
          name={open ? "chevron-down" : "chevron-right"}
          size={12}
          className="text-outline"
        />
      ) : (
        <span className="w-3" />
      )}
      <Icon
        name={fileIconForNode(node)}
        size={14}
        className={nodeIconColor(node)}
      />
      <span className="flex-1 truncate font-body text-[13px]">{node.name}</span>
    </button>
  );
}

// ── Inline input row (for new file/folder and rename) ──────────────────────

function InlineInputRow({
  inputRef,
  value,
  onChange,
  onKeyDown,
  onBlur,
  icon,
  error,
  depth,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  onBlur: () => void;
  icon: string;
  error: string | null;
  depth: number;
}) {
  const style: CSSProperties = { paddingLeft: 8 + depth * 12 };
  return (
    <div
      className="relative flex h-6 w-full items-center gap-2 pr-2"
      style={style}
    >
      <span className="w-3" />
      <Icon
        name={icon}
        size={14}
        className={error ? "text-error" : "text-on-surface-variant"}
      />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        placeholder="name"
        className={`flex-1 rounded-sm border bg-surface-container-low px-1.5 py-0.5 font-body text-[13px] text-on-surface placeholder:text-outline focus:outline-none ${
          error
            ? "border-error ring-1 ring-error/30"
            : "border-outline-variant focus:border-primary focus:ring-1 focus:ring-primary/30"
        }`}
      />
      {error && (
        <span className="absolute right-2 top-7 rounded bg-error/10 px-1.5 py-0.5 font-sans text-[11px] text-error">
          {error}
        </span>
      )}
    </div>
  );
}

// ── Runs view ──────────────────────────────────────────────────────────────
// Shows an empty state when no real run tracker backend is wired in.

function RunsView({ onOpenFolder }: { onOpenFolder: () => void }) {
  return (
    <>
      <Header title="Runs" />
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <Icon name="flask-conical" size={28} className="text-outline-variant" />
        <div>
          <p className="font-sans text-[13px] font-medium text-on-surface">No runs yet</p>
          <p className="mt-1 font-body text-[12px] text-on-surface-variant">
            Run tracking will appear here once you connect a backend (W&amp;B, MLflow, etc.).
          </p>
        </div>
        <button
          onClick={onOpenFolder}
          className="rounded border border-outline-variant bg-surface-container px-3 py-1.5 font-sans text-[12px] text-on-surface hover:bg-surface-container-high"
        >
          Open folder to browse code
        </button>
      </div>
    </>
  );
}

// ── Sidebar root ──────────────────────────────────────────────────────────

const TITLES: Partial<Record<DockId, string>> = {
  experiments: "Experiments",
  artifacts: "Artifacts",
  git: "Source Control",
  search: "Search",
  extensions: "Extensions",
  account: "Account",
  settings: "Settings",
};

export function Sidebar({
  view,
  workspaceRoot,
  workspaceName,
  onOpenFolder,
  width = 240,
}: {
  view: DockId;
  workspaceRoot: string | null;
  workspaceName: string | null;
  onOpenFolder: () => void;
  width?: number;
}) {
  const activeTab = useActiveTab();

  return (
    <aside
      style={{ width }}
      className="flex shrink-0 flex-col border-r border-outline-variant bg-surface-container-low"
    >
      {view === "runs" ? (
        <RunsView onOpenFolder={onOpenFolder} />
      ) : view === "explorer" ? (
        <ExplorerView
          activeTabId={activeTab?.id ?? null}
          workspaceRoot={workspaceRoot}
          onOpenFolder={onOpenFolder}
        />
      ) : view === "experiments" ? (
        <ExperimentsView />
      ) : view === "artifacts" ? (
        <ArtifactsView />
      ) : view === "git" ? (
        <SourceControlView />
      ) : (
        <>
          <Header title={TITLES[view] ?? "Panel"} />
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <Icon name="puzzle" size={28} className="text-outline-variant" />
            <p className="font-body text-[13px] text-on-surface-variant">
              {TITLES[view]} is coming soon in the v0.2 update.
            </p>
          </div>
        </>
      )}
    </aside>
  );
}
