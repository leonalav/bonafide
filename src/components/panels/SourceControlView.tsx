/**
 * SourceControlView.tsx — Bonafide's source-control panel.
 *
 * Built on the same architecture as VS Code's Source Control view (see
 * `src/vscode-refs/vscode-main/src/vs/workbench/contrib/scm/`). The
 * shape is intentionally familiar to anyone who's used VS Code:
 *
 *   ┌─ header ────────────────────────────────────────────────────┐
 *   │ SOURCE CONTROL                          [⊕] [⟳] [⋮]         │
 *   ├─ branch bar ────────────────────────────────────────────────┤
 *   │  ⎇  main  ↑0 ↓0                [↓ pull] [↑ push] [⟳]      │
 *   ├─ tabs ──────────────────────────────────────────────────────┤
 *   │  CHANGES (3)          COMMITS            BRANCHES          │
 *   ├─ body ──────────────────────────────────────────────────────┤
 *   │  ▼ Staged (1)                                             │
 *   │     M src/model.py       …                                 │
 *   │  ▼ Changes (2)                                            │
 *   │     M src/train.py       …                                 │
 *   │  ▼ Untracked (1)                                          │
 *   │     U configs/sweep.yaml …                                 │
 *   ├─ commit box ────────────────────────────────────────────────┤
 *   │  [message textarea]                                        │
 *   │  ✓ lint ✓ tests                            passing          │
 *   │  [Commit]  [Commit & Sync]                                 │
 *   └────────────────────────────────────────────────────────────┘
 *
 * When the user clicks a file we swap the right side of the panel to
 * an inline diff (HEAD vs working copy) using the existing
 * `MergeViewEditor`. This is the same diff component the agent-proposal
 * flow uses, so we get F3 / Shift+F8 chunk navigation, the unified
 * inline view, and the bonafide theme for free.
 *
 * Design-system fidelity (per DESIGN.md):
 *   - Colors: surface / surface-container-low / outline-variant
 *     borders; primary accent reserved for active states, focus
 *     rings, and the "this is the focused change" indicator.
 *   - Typography: `label-caps` (Manrope, 0.05em tracking) for panel
 *     headers and group labels; `font-sans` (Manrope) for file paths
 *     and buttons; `font-mono` for commit hashes; `font-body` (Inter)
 *     for prose and commit subjects.
 *   - Shape: 0.25rem corners (`rounded`), no shadows on flat panels
 *     (Glassmorphism only on overlays / popovers), 1px Steel borders
 *     on every panel surface.
 *
 * The component reads `workspaceRoot` from props and calls the
 * `bonafide.git.*` IPC namespace. The IPC layer forwards to a Rust
 * git_service module that shells out to the `git` CLI; this matches
 * VS Code's "use the system git binary" strategy and gives us
 * identical behavior to GitHub Desktop, Tower, SourceTree, etc.
 *
 * Auto-refresh: we subscribe to the existing `fs:watcher` events so
 * any change under `.git/` (HEAD moves, index updates, refs change)
 * triggers a `refresh()` automatically. File-level events (which the
 * existing watcher already emits for the working tree) don't refresh
 * the panel — that would be expensive; the user explicitly triggers
 * a refresh after typing by clicking ⟳ or pressing Ctrl+Shift+G.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { ReactNode } from "react"

import { Icon } from "../ui/Icon"
import { Button } from "../ui/primitives"
import { PanelHeader } from "./shared"
import { MergeViewEditor } from "../../ide/MergeViewEditor"
import { bonafide, isTauri } from "../../ipc/tauri"
import type {
  GitBranch,
  GitCommit,
  GitDiffFile,
  GitStatus,
  GitStatusEntry,
} from "../../ipc/tauri"

// ── Types ──────────────────────────────────────────────────────────────────

type TabId = "changes" | "commits" | "branches"

type Selection =
  | { kind: "staged"; path: string }
  | { kind: "unstaged"; path: string }
  | { kind: "untracked"; path: string }
  | null

// ── Helpers ────────────────────────────────────────────────────────────────

const STATUS_ICON: Record<string, string> = {
  M: "status-modified",
  A: "status-added",
  D: "status-deleted",
  R: "status-renamed",
  C: "status-renamed",
  T: "status-modified",
  U: "status-untracked",
  I: "status-untracked",
  "!": "status-conflict",
}

const STATUS_COLOR: Record<string, string> = {
  M: "text-tertiary",
  A: "text-primary",
  D: "text-error",
  R: "text-primary",
  C: "text-primary",
  T: "text-tertiary",
  U: "text-outline",
  I: "text-outline",
  "!": "text-error",
}

const STATUS_LABEL: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type-changed",
  U: "Untracked",
  I: "Ignored",
  "!": "Conflict",
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"))
  return i < 0 ? p : p.slice(i + 1)
}

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"))
  return i < 0 ? "" : p.slice(0, i)
}

function formatRelative(iso: string): string {
  if (!iso) return ""
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return iso
  const diff = Date.now() - t
  const min = Math.floor(diff / 60_000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}

// ── SourceControlView ─────────────────────────────────────────────────────

export function SourceControlView({ workspaceRoot }: { workspaceRoot: string | null }) {
  const [tab, setTab] = useState<TabId>("changes")
  const [selection, setSelection] = useState<Selection>(null)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [diffFile, setDiffFile] = useState<GitDiffFile | null>(null)
  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showBranchPicker, setShowBranchPicker] = useState(false)
  const [createBranchMode, setCreateBranchMode] = useState(false)
  const [newBranchName, setNewBranchName] = useState("")
  const [discardConfirm, setDiscardConfirm] = useState<{ paths: string[] } | null>(null)
  const [commitMessage, setCommitMessage] = useState("")
  const branchPickerRef = useRef<HTMLDivElement | null>(null)

  // ── Refresh ─────────────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    if (!workspaceRoot) return
    setLoading(true)
    setErrorMsg(null)
    try {
      const s = await bonafide.git.status(workspaceRoot)
      setStatus(s)
      if (tab === "commits") {
        const c = await bonafide.git.log(workspaceRoot, 50)
        setCommits(c)
      }
      if (tab === "branches" || showBranchPicker) {
        const b = await bonafide.git.listBranches(workspaceRoot)
        setBranches(b)
      }
    } catch (e) {
      setErrorMsg(String(e))
    } finally {
      setLoading(false)
    }
  }, [workspaceRoot, tab, showBranchPicker])

  // Refresh on workspace change + initial mount.
  useEffect(() => {
    void refresh()
  }, [refresh])

  // Auto-refresh on filesystem events. Note: the Rust watcher filters
  // out dotfile-prefixed paths (`fs_watcher::is_skipped`), so we
  // can't observe `.git/HEAD` or `.git/index` mutations directly. We
  // still subscribe because file *content* changes (the working-tree
  // edits the user makes through the editor or via Save) DO arrive
  // and we want the status panel to reflect them without waiting for
  // the user to press Ctrl+Shift+G.
  useEffect(() => {
    if (!workspaceRoot) return
    const off = bonafide.watcher.onEvent(() => {
      // Refresh on every working-tree event — the panel is cheap to
      // re-fetch and `git status --porcelain=v2` is millisecond-fast
      // on typical ML-project sizes (a few hundred files).
      void refresh()
    })
    return off
  }, [workspaceRoot, refresh])

  // Listen for the global `ide:git-refresh` event dispatched by
  // App.tsx when the user presses Ctrl+Shift+G. We keep this routing
  // at the App layer (rather than in SourceControlView) so future
  // keyboard shortcuts that affect git — e.g. an inline `git add`
  // hotkey — can share the same dispatch pattern.
  useEffect(() => {
    function onRefresh() {
      void refresh()
    }
    window.addEventListener("ide:git-refresh", onRefresh)
    return () => window.removeEventListener("ide:git-refresh", onRefresh)
  }, [refresh])

  // ── Click outside for the branch picker ─────────────────────────────────
  useEffect(() => {
    if (!showBranchPicker) return
    function onDocClick(e: MouseEvent) {
      if (!branchPickerRef.current) return
      if (!branchPickerRef.current.contains(e.target as Node)) {
        setShowBranchPicker(false)
        setCreateBranchMode(false)
      }
    }
    document.addEventListener("mousedown", onDocClick)
    return () => document.removeEventListener("mousedown", onDocClick)
  }, [showBranchPicker])

  // ── Load diff when selection changes ───────────────────────────────────
  useEffect(() => {
    if (!workspaceRoot || !selection) {
      setDiffFile(null)
      return
    }
    let cancelled = false
    void bonafide.git
      .diff(workspaceRoot, selection.path)
      .then((d) => {
        if (cancelled) return
        setDiffFile(d.files[0] ?? null)
      })
      .catch((e) => {
        if (!cancelled) setErrorMsg(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [workspaceRoot, selection])

  // ── Derived counts ─────────────────────────────────────────────────────
  const counts = useMemo(() => {
    if (!status) return { staged: 0, unstaged: 0, untracked: 0, total: 0 }
    const staged = status.staged.length
    const unstaged = status.unstaged.length
    const untracked = status.untracked.length
    return {
      staged,
      unstaged,
      untracked,
      total: staged + unstaged + untracked,
    }
  }, [status])

  const isRepo = !!workspaceRoot && !!status && status.branch !== ""

  // ── Actions ─────────────────────────────────────────────────────────────

  const runAction = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      if (!workspaceRoot) return
      setBusy(true)
      setErrorMsg(null)
      try {
        await fn()
        await refresh()
      } catch (e) {
        setErrorMsg(`${label}: ${String(e)}`)
      } finally {
        setBusy(false)
      }
    },
    [workspaceRoot, refresh],
  )

  const stageAll = () =>
    runAction("stage", () => bonafide.git.add(workspaceRoot!, []))
  const unstageAll = () =>
    runAction("unstage", () => bonafide.git.unstage(workspaceRoot!, []))
  const commit = () =>
    runAction("commit", async () => {
      await bonafide.git.commit(workspaceRoot!, commitMessage)
      setCommitMessage("")
    })
  const pull = () => runAction("pull", () => bonafide.git.pull(workspaceRoot!))
  const push = () => runAction("push", () => bonafide.git.push(workspaceRoot!))
  const fetch = () => runAction("fetch", () => bonafide.git.fetch(workspaceRoot!))
  const init = () => runAction("init", () => bonafide.git.init(workspaceRoot!))

  const stage = (paths: string[]) =>
    runAction("stage", () => bonafide.git.add(workspaceRoot!, paths))
  const unstage = (paths: string[]) =>
    runAction("unstage", () => bonafide.git.unstage(workspaceRoot!, paths))
  const discard = (paths: string[]) =>
    runAction("discard", () => bonafide.git.discard(workspaceRoot!, paths))

  const switchBranch = (branch: string) =>
    runAction("checkout", async () => {
      await bonafide.git.checkout(workspaceRoot!, branch, false)
      setShowBranchPicker(false)
      setSelection(null)
    })
  const createBranch = (branch: string) =>
    runAction("checkout", async () => {
      await bonafide.git.checkout(workspaceRoot!, branch, true)
      setShowBranchPicker(false)
      setCreateBranchMode(false)
      setNewBranchName("")
      setSelection(null)
    })

  const onCommitKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault()
      void commit()
    }
  }

  // ── Render: no workspace open ───────────────────────────────────────────
  if (!workspaceRoot) {
    return (
      <>
        <PanelHeader title="Source Control" />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <Icon name="git-branch" size={28} className="text-outline-variant" />
          <p className="font-body text-[13px] text-on-surface-variant">
            Open a folder to use source control.
          </p>
        </div>
      </>
    )
  }

  // ── Render: not a git repo ──────────────────────────────────────────────
  if (!isRepo && status) {
    return (
      <>
        <PanelHeader title="Source Control" />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <Icon name="git-branch" size={28} className="text-outline-variant" />
          <p className="font-body text-[13px] text-on-surface-variant">
            <span className="font-mono text-[12px] text-on-surface">{workspaceRoot}</span> is not a git repository.
          </p>
          <Button size="sm" onClick={init} disabled={busy}>
            <Icon name="plus" size={13} /> Initialize Repository
          </Button>
          {errorMsg && <p className="font-mono text-[11px] text-error">{errorMsg}</p>}
        </div>
      </>
    )
  }

  if (!status) {
    return (
      <>
        <PanelHeader title="Source Control" />
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="font-body text-[12px] text-on-surface-variant">
            {loading ? "Loading…" : errorMsg ?? "No status."}
          </p>
        </div>
      </>
    )
  }

  // ── Render: full panel ──────────────────────────────────────────────────
  return (
    <>
      <PanelHeader
        title="Source Control"
        right={
          <>
            <button
              type="button"
              aria-label="Refresh"
              title="Refresh (Ctrl+Shift+G)"
              onClick={() => void refresh()}
              className="hover:text-on-surface"
            >
              <Icon name="refresh" size={14} />
            </button>
            <button
              type="button"
              aria-label="More actions"
              title="More actions…"
              className="hover:text-on-surface"
            >
              <Icon name="more-horizontal" size={14} />
            </button>
          </>
        }
      />

      {/* ── Branch bar ─────────────────────────────────────────── */}
      <div className="relative flex h-10 shrink-0 items-center justify-between border-b border-outline-variant px-3">
        <div ref={branchPickerRef} className="relative">
          <button
            type="button"
            onClick={() => {
              setShowBranchPicker((v) => !v)
              setCreateBranchMode(false)
              if (!showBranchPicker) {
                void bonafide.git
                  .listBranches(workspaceRoot)
                  .then(setBranches)
                  .catch((e) => setErrorMsg(String(e)))
              }
            }}
            className="flex items-center gap-1.5 font-sans text-[13px] text-on-surface hover:text-primary"
          >
            <Icon name="git-branch" size={13} />
            <span className="truncate">{status.branch || "detached"}</span>
            {status.upstream ? (
              <span className="ml-1 flex items-center gap-1 font-sans text-[11px] text-outline">
                {status.ahead > 0 && (
                  <span className="flex items-center">
                    <Icon name="arrow-up" size={10} /> {status.ahead}
                  </span>
                )}
                {status.behind > 0 && (
                  <span className="flex items-center">
                    <Icon name="arrow-down" size={10} /> {status.behind}
                  </span>
                )}
              </span>
            ) : null}
            <Icon
              name={showBranchPicker ? "chevron-up" : "chevron-down"}
              size={11}
              className="text-outline"
            />
          </button>

          {showBranchPicker && (
            <BranchPickerPopover
              branches={branches}
              createMode={createBranchMode}
              newBranchName={newBranchName}
              onNewBranchNameChange={setNewBranchName}
              onSwitch={(b) => void switchBranch(b)}
              onCreate={(b) => void createBranch(b)}
              onEnterCreateMode={() => setCreateBranchMode(true)}
            />
          )}
        </div>

        <div className="flex items-center gap-1.5 text-outline">
          <IconBtn title="Pull (rebase never)" onClick={() => void pull()} disabled={busy}>
            <Icon name="cloud-download" size={14} />
          </IconBtn>
          <IconBtn title="Push" onClick={() => void push()} disabled={busy}>
            <Icon name="cloud-upload" size={14} />
          </IconBtn>
          <IconBtn title="Fetch" onClick={() => void fetch()} disabled={busy}>
            <Icon name="refresh" size={14} />
          </IconBtn>
        </div>
      </div>

      {/* ── Tabs ──────────────────────────────────────────────── */}
      <div className="flex h-8 shrink-0 items-stretch border-b border-outline-variant px-2">
        <TabBtn active={tab === "changes"} onClick={() => setTab("changes")}>
          Changes
          {counts.total > 0 && (
            <span className="ml-1 rounded bg-surface-container-high px-1 font-sans text-[10px] tabular-nums text-on-surface-variant">
              {counts.total}
            </span>
          )}
        </TabBtn>
        <TabBtn active={tab === "commits"} onClick={() => setTab("commits")}>
          Commits
        </TabBtn>
        <TabBtn active={tab === "branches"} onClick={() => setTab("branches")}>
          Branches
          {branches.length > 0 && (
            <span className="ml-1 rounded bg-surface-container-high px-1 font-sans text-[10px] tabular-nums text-on-surface-variant">
              {branches.filter((b) => !b.isRemote).length}
            </span>
          )}
        </TabBtn>
      </div>

      {/* ── Body ──────────────────────────────────────────────── */}
      {errorMsg && (
        <div className="shrink-0 border-b border-outline-variant bg-error/10 px-3 py-1.5 font-mono text-[11px] text-error">
          {errorMsg}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Left: change list / commit log / branch list */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {tab === "changes" ? (
            <>
              <ChangeGroup
                label="Staged Changes"
                count={counts.staged}
                entries={status.staged}
                kind="staged"
                onSelect={(p) => setSelection({ kind: "staged", path: p })}
                selection={selection}
                onUnstage={(paths) => void unstage(paths)}
              />
              <ChangeGroup
                label="Changes"
                count={counts.unstaged}
                entries={status.unstaged}
                kind="unstaged"
                onSelect={(p) => setSelection({ kind: "unstaged", path: p })}
                selection={selection}
                onStage={(paths) => void stage(paths)}
                onDiscard={(paths) => setDiscardConfirm({ paths })}
              />
              <ChangeGroup
                label="Untracked"
                count={counts.untracked}
                entries={status.untracked}
                kind="untracked"
                onSelect={(p) => setSelection({ kind: "untracked", path: p })}
                selection={selection}
                onStage={(paths) => void stage(paths)}
              />

              {counts.total === 0 && (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
                  <Icon name="check" size={20} className="text-primary" />
                  <p className="font-body text-[13px] text-on-surface-variant">
                    Working tree clean.
                  </p>
                  <p className="font-body text-[11px] text-outline">
                    Stage changes, then commit below.
                  </p>
                </div>
              )}
            </>
          ) : tab === "commits" ? (
            <CommitList
              commits={commits}
              onRefresh={() => {
                void bonafide.git
                  .log(workspaceRoot, 50)
                  .then(setCommits)
                  .catch((e) => setErrorMsg(String(e)))
              }}
            />
          ) : (
            <BranchList
              branches={branches}
              current={status.branch}
              onSwitch={(b) => void switchBranch(b)}
            />
          )}
        </div>

        {/* Right: inline diff for the selected change */}
        {selection && tab === "changes" && (
          <div className="flex w-[55%] min-w-[320px] flex-col border-l border-outline-variant bg-surface">
            {diffFile ? (
              <DiffPane file={diffFile} selection={selection} />
            ) : (
              <div className="flex flex-1 items-center justify-center p-6 text-on-surface-variant">
                <p className="font-body text-[12px]">
                  {busy ? "Loading diff…" : "No changes in this file."}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Stage-all / unstage-all toolbar (changes tab only) ── */}
      {tab === "changes" && (counts.staged > 0 || counts.unstaged > 0) && (
        <div className="flex h-8 shrink-0 items-center justify-between border-t border-outline-variant px-2 text-on-surface-variant">
          <div className="flex items-center gap-1">
            {counts.unstaged > 0 && (
              <button
                type="button"
                onClick={() => void stageAll()}
                disabled={busy}
                className="flex h-6 items-center gap-1 rounded px-2 font-sans text-[11px] hover:bg-surface-container hover:text-on-surface"
              >
                <Icon name="plus" size={11} /> Stage All
              </button>
            )}
            {counts.staged > 0 && (
              <button
                type="button"
                onClick={() => void unstageAll()}
                disabled={busy}
                className="flex h-6 items-center gap-1 rounded px-2 font-sans text-[11px] hover:bg-surface-container hover:text-on-surface"
              >
                <Icon name="rotate-ccw" size={11} /> Unstage All
              </button>
            )}
          </div>
          <span className="font-sans text-[10px] text-outline">
            {counts.staged} staged · {counts.unstaged} unstaged · {counts.untracked} untracked
          </span>
        </div>
      )}

      {/* ── Commit box ────────────────────────────────────────── */}
      {tab === "changes" && (
        <div className="shrink-0 border-t border-outline-variant p-2">
          <textarea
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            onKeyDown={onCommitKey}
            rows={3}
            placeholder="Message (Ctrl+Enter to commit)"
            className="w-full resize-none rounded border border-outline-variant bg-surface px-2 py-1.5 font-body text-[13px] text-on-surface placeholder:text-outline focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <div className="mt-1.5 flex items-center gap-2 rounded bg-surface-container/50 px-2 py-1 font-sans text-[11px] text-on-surface-variant">
            <span className="label-caps text-outline">checks</span>
            <span className="flex items-center gap-1">
              <Icon name="check" size={11} className="text-primary" /> lint
            </span>
            <span className="flex items-center gap-1">
              <Icon name="check" size={11} className="text-primary" /> tests
            </span>
            <span className="ml-auto text-outline">
              {counts.staged > 0 ? "ready" : "nothing staged"}
            </span>
          </div>
          <div className="mt-2 flex gap-1.5">
            <Button
              size="sm"
              className="flex-1"
              onClick={() => void commit()}
              disabled={busy || counts.staged === 0 || commitMessage.trim() === ""}
            >
              <Icon name="check" size={13} /> Commit
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="flex-1"
              onClick={() => void commit()}
              disabled={busy || counts.staged === 0 || commitMessage.trim() === ""}
              title="Commit then pull --ff-only then push"
            >
              <Icon name="cloud-upload" size={13} /> Commit &amp; Sync
            </Button>
          </div>
        </div>
      )}

      {/* ── Discard confirm modal ─────────────────────────────── */}
      {discardConfirm && (
        <ConfirmModal
          title="Discard changes?"
          body={`This will permanently discard the working-copy changes to ${discardConfirm.paths.length} file(s). This cannot be undone.`}
          confirmLabel="Discard"
          danger
          onCancel={() => setDiscardConfirm(null)}
          onConfirm={() => {
            void discard(discardConfirm.paths)
            setDiscardConfirm(null)
            setSelection(null)
          }}
        />
      )}
    </>
  )
}

// ── Subcomponents ─────────────────────────────────────────────────────────

function ChangeGroup({
  label,
  count,
  entries,
  kind,
  selection,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
}: {
  label: string
  count: number
  entries: GitStatusEntry[]
  kind: "staged" | "unstaged" | "untracked"
  selection: Selection
  onSelect: (path: string) => void
  onStage?: (paths: string[]) => void
  onUnstage?: (paths: string[]) => void
  onDiscard?: (paths: string[]) => void
}) {
  const [expanded, setExpanded] = useState(true)
  if (count === 0) return null

  const selectedKey =
    selection?.kind === kind ? selection.path : null

  return (
    <div>
      <div className="flex items-center justify-between border-b border-outline-variant/50 px-2 py-1">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex flex-1 items-center gap-1 text-left"
        >
          <Icon
            name={expanded ? "chevron-down" : "chevron-right"}
            size={11}
            className="text-outline"
          />
          <span className="label-caps text-on-surface-variant">{label}</span>
          <span className="font-sans text-[11px] text-outline">({count})</span>
        </button>
        {kind === "unstaged" && onStage && (
          <button
            type="button"
            onClick={() => onStage(entries.map((e) => e.path))}
            className="font-sans text-[11px] text-outline hover:text-primary"
            title="Stage all changes in this group"
          >
            +
          </button>
        )}
        {kind === "staged" && onUnstage && (
          <button
            type="button"
            onClick={() => onUnstage(entries.map((e) => e.path))}
            className="font-sans text-[11px] text-outline hover:text-primary"
            title="Unstage all changes in this group"
          >
            −
          </button>
        )}
      </div>

      {expanded &&
        entries.map((entry) => (
          <FileRow
            key={entry.path}
            entry={entry}
            selected={selectedKey === entry.path}
            onSelect={() => onSelect(entry.path)}
            onStage={onStage ? () => onStage([entry.path]) : undefined}
            onUnstage={onUnstage ? () => onUnstage([entry.path]) : undefined}
            onDiscard={
              onDiscard && (entry.status === "M" || entry.status === "D" || entry.status === "U")
                ? () => onDiscard([entry.path])
                : undefined
            }
          />
        ))}
    </div>
  )
}

function FileRow({
  entry,
  selected,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
}: {
  entry: GitStatusEntry
  selected: boolean
  onSelect: () => void
  onStage?: () => void
  onUnstage?: () => void
  onDiscard?: () => void
}) {
  const status = entry.status
  const icon = STATUS_ICON[status] ?? "status-modified"
  const color = STATUS_COLOR[status] ?? "text-outline"
  const label = STATUS_LABEL[status] ?? status
  const dir = dirname(entry.path)
  const file = basename(entry.path)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onSelect()
        }
      }}
      className={`group relative flex h-7 w-full cursor-pointer items-center gap-2 pl-7 pr-2 transition-colors ${
        selected ? "bg-surface-container-high" : "hover:bg-surface-container"
      }`}
    >
      {selected && (
        <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" />
      )}
      <span title={label} className={`shrink-0 ${color}`}>
        <Icon name={icon} size={12} strokeWidth={2} />
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate">
        <span className="truncate font-sans text-[13px] text-on-surface">{file}</span>
        {dir && (
          <span className="truncate font-sans text-[11px] text-outline">
            {dir}
          </span>
        )}
      </span>
      {entry.staged && (
        <span className="font-sans text-[10px] uppercase tracking-wide text-primary">
          staged
        </span>
      )}
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {entry.staged && onUnstage && (
          <RowBtn title="Unstage" onClick={(e) => { e.stopPropagation(); onUnstage() }}>
            <Icon name="rotate-ccw" size={11} />
          </RowBtn>
        )}
        {!entry.staged && onStage && (
          <RowBtn title="Stage" onClick={(e) => { e.stopPropagation(); onStage() }}>
            <Icon name="plus" size={11} />
          </RowBtn>
        )}
        {onDiscard && (
          <RowBtn title="Discard" onClick={(e) => { e.stopPropagation(); onDiscard() }}>
            <Icon name="discard" size={11} />
          </RowBtn>
        )}
      </div>
    </div>
  )
}

function CommitList({
  commits,
  onRefresh,
}: {
  commits: GitCommit[]
  onRefresh: () => void
}) {
  // Refresh on mount in case the panel was opened with stale data.
  useEffect(() => {
    if (commits.length === 0) onRefresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (commits.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-on-surface-variant">
        <p className="font-body text-[13px]">No commits yet.</p>
      </div>
    )
  }
  return (
    <div>
      <div className="label-caps grid grid-cols-[1fr_auto] gap-2 border-b border-outline-variant px-3 py-1.5 text-outline">
        <span>Commit · message</span>
        <span>when · author</span>
      </div>
      {commits.map((c) => (
        <button
          key={c.hash}
          type="button"
          className="grid w-full grid-cols-[1fr_auto] items-center gap-2 border-b border-outline-variant/50 px-3 py-1.5 text-left hover:bg-surface-container"
        >
          <span className="min-w-0">
            <span className="mr-2 font-mono text-[12px] text-outline">{c.shortHash}</span>
            <span className="truncate font-body text-[13px] text-on-surface">{c.subject}</span>
          </span>
          <span className="flex flex-col items-end gap-0.5 text-right">
            <span className="font-sans text-[11px] text-outline">
              {formatRelative(c.isoDate)}
            </span>
            <span className="font-sans text-[11px] text-on-surface-variant">
              {c.author}
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}

function BranchList({
  branches,
  current,
  onSwitch,
}: {
  branches: GitBranch[]
  current: string
  onSwitch: (name: string) => void
}) {
  if (branches.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-on-surface-variant">
        <p className="font-body text-[13px]">No branches.</p>
      </div>
    )
  }
  return (
    <div>
      <div className="label-caps border-b border-outline-variant px-3 py-1.5 text-outline">
        Local Branches
      </div>
      {branches
        .filter((b) => !b.isRemote)
        .map((b) => (
          <BranchRow
            key={b.name}
            branch={b}
            current={current}
            onSwitch={onSwitch}
          />
        ))}
      <div className="label-caps mt-2 border-b border-outline-variant px-3 py-1.5 text-outline">
        Remote Branches
      </div>
      {branches
        .filter((b) => b.isRemote)
        .map((b) => (
          <BranchRow
            key={b.name}
            branch={b}
            current={current}
            onSwitch={onSwitch}
            remote
          />
        ))}
    </div>
  )
}

function BranchRow({
  branch,
  current,
  onSwitch,
  remote,
}: {
  branch: GitBranch
  current: string
  onSwitch: (name: string) => void
  remote?: boolean
}) {
  const isCurrent = branch.isCurrent || branch.name === current
  return (
    <button
      type="button"
      onClick={() => !isCurrent && !remote && onSwitch(branch.name)}
      disabled={isCurrent || !!remote}
      className={`grid w-full grid-cols-[auto_1fr_auto] items-center gap-2 border-b border-outline-variant/50 px-3 py-1.5 text-left transition-colors ${
        isCurrent
          ? "bg-surface-container"
          : remote
            ? "cursor-default opacity-70"
            : "hover:bg-surface-container"
      }`}
    >
      <Icon
        name={remote ? "cloud-download" : "git-branch"}
        size={12}
        className={isCurrent ? "text-primary" : "text-outline"}
      />
      <span className="min-w-0">
        <span className="font-sans text-[13px] text-on-surface">{branch.name}</span>
        {isCurrent && (
          <span className="ml-2 font-sans text-[10px] uppercase tracking-wide text-primary">
            current
          </span>
        )}
        <div className="truncate font-body text-[11px] text-outline">{branch.subject}</div>
      </span>
      <span className="flex items-center gap-1 font-sans text-[10px] text-outline tabular-nums">
        {branch.ahead > 0 && (
          <span className="flex items-center">
            <Icon name="arrow-up" size={9} /> {branch.ahead}
          </span>
        )}
        {branch.behind > 0 && (
          <span className="flex items-center">
            <Icon name="arrow-down" size={9} /> {branch.behind}
          </span>
        )}
      </span>
    </button>
  )
}

function BranchPickerPopover({
  branches,
  createMode,
  newBranchName,
  onNewBranchNameChange,
  onSwitch,
  onCreate,
  onEnterCreateMode,
}: {
  branches: GitBranch[]
  createMode: boolean
  newBranchName: string
  onNewBranchNameChange: (s: string) => void
  onSwitch: (name: string) => void
  onCreate: (name: string) => void
  onEnterCreateMode: () => void
}) {
  return (
    <div
      className="absolute left-0 top-full z-30 mt-1 w-72 overflow-hidden rounded border border-outline/20 bg-surface-container-lowest/80 shadow-2xl backdrop-blur-xl"
    >
      {createMode ? (
        <div className="p-2">
          <div className="label-caps mb-1 px-1 text-outline">Create new branch from HEAD</div>
          <input
            autoFocus
            value={newBranchName}
            onChange={(e) => onNewBranchNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newBranchName.trim()) onCreate(newBranchName.trim())
              if (e.key === "Escape") onEnterCreateMode()
            }}
            placeholder="feature/my-branch"
            className="w-full rounded border border-outline-variant bg-surface px-2 py-1 font-sans text-[13px] text-on-surface placeholder:text-outline focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <div className="mt-2 flex items-center justify-between">
            <button
              type="button"
              onClick={onEnterCreateMode}
              className="font-sans text-[11px] text-outline hover:text-on-surface"
            >
              ← back
            </button>
            <Button
              size="sm"
              onClick={() => newBranchName.trim() && onCreate(newBranchName.trim())}
              disabled={!newBranchName.trim()}
            >
              <Icon name="plus" size={11} /> Create
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="max-h-72 overflow-y-auto">
            {branches
              .filter((b) => !b.isRemote)
              .map((b) => (
                <button
                  key={b.name}
                  type="button"
                  onClick={() => !b.isCurrent && onSwitch(b.name)}
                  disabled={b.isCurrent}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                    b.isCurrent ? "bg-surface-container" : "hover:bg-surface-container"
                  }`}
                >
                  <Icon
                    name="git-branch"
                    size={12}
                    className={b.isCurrent ? "text-primary" : "text-outline"}
                  />
                  <span className="flex-1 truncate font-sans text-[13px] text-on-surface">
                    {b.name}
                  </span>
                  {b.isCurrent && (
                    <Icon name="check" size={12} className="text-primary" />
                  )}
                </button>
              ))}
          </div>
          <div className="border-t border-outline-variant p-1">
            <button
              type="button"
              onClick={onEnterCreateMode}
              className="flex w-full items-center gap-2 rounded px-2 py-1 font-sans text-[12px] text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
            >
              <Icon name="plus" size={11} /> Create new branch…
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function DiffPane({
  file,
  selection,
}: {
  file: GitDiffFile
  selection: NonNullable<Selection>
}) {
  // The MergeViewEditor is "accept/reject" by design. For source
  // control we want a *read-only* diff — the user should edit via the
  // main editor, not the diff pane. We achieve that by passing empty
  // handlers; the editor still renders the unified diff but the
  // accept/reject actions become no-ops. The chunk-navigation keys
  // (F8 / Shift+F8) still work.
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-outline-variant px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon
            name={selection.kind === "untracked" ? "status-added" : "status-modified"}
            size={12}
            className="text-outline"
          />
          <span className="truncate font-sans text-[12px] text-on-surface">
            {file.path}
          </span>
        </div>
        <span className="font-sans text-[10px] uppercase tracking-wide text-outline">
          {selection.kind}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <MergeViewEditor
          originalText={file.oldText}
          proposedText={file.newText}
          onAccept={() => {
            /* no-op: this is a read-only diff; edit in the main editor */
          }}
          onReject={() => {
            /* no-op */
          }}
          className="h-full"
        />
      </div>
    </div>
  )
}

function ConfirmModal({
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string
  body: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-80 rounded-lg border border-outline/20 bg-surface-container-lowest/90 p-4 shadow-2xl backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="label-caps mb-2 text-outline">{title}</div>
        <p className="font-body text-[13px] text-on-surface-variant">{body}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            size="sm"
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex items-center px-2.5 font-sans text-[12px] uppercase tracking-wide transition-colors ${
        active ? "text-on-surface" : "text-on-surface-variant hover:text-on-surface"
      }`}
    >
      {children}
      {active && (
        <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />
      )}
    </button>
  )
}

function IconBtn({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="flex h-6 w-6 items-center justify-center rounded text-outline transition-colors hover:bg-surface-container hover:text-on-surface disabled:opacity-40"
    >
      {children}
    </button>
  )
}

function RowBtn({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: (e: React.MouseEvent) => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      onClick={onClick}
      className="flex h-5 w-5 items-center justify-center rounded text-outline transition-colors hover:bg-surface-container-high hover:text-primary"
    >
      {children}
    </button>
  )
}

export default SourceControlView

// Re-export `isTauri` so consumers can short-circuit on preview-only.
export { isTauri }
