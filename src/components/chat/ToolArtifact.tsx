/**
 * chat/ToolArtifact.tsx — Inline tool-call artifact cards.
 *
 * Per `agent-reasoning-designs.html` lines 2150-2300 (`tool.*`
 * sticker) and `agent-sticker-sheet.html`, tool invocations appear
 * as visible cards in the conversation alongside the assistant's
 * reply, not as buried trace text. The card lifecycle matches the
 * tool's engine lifecycle:
 *
 *   pending   → header rendered, body shows a "Waiting…" pulse.
 *   running   → header adds a shimmer, body shows the command / args.
 *   completed → header gets a green check, body shows the output.
 *   failed    → header gets an error tone, body shows the error.
 *
 * `kind` drives the body layout:
 *   - terminal → stdout/stderr monospace with a faint scanline bg
 *   - file     → file path header + optional diff body
 *   - tool     → generic two-line layout (name + args/output)
 *
 * The component is purely presentational — the parent (ChatThread)
 * decides which messages have which artifacts; nothing about the
 * card state is read from a context. The card is *meant* to update
 * live as the tool runs because the parent re-renders the message
 * with a new artifact list as the engine progresses.
 */

import { useMemo, useState } from "react"
import { Icon } from "../ui/Icon"
import type { Artifact, ArtifactKind, ArtifactStatus } from "../../chats/ChatStore"

// ── Kind-specific renderers ──────────────────────────────────────────────────

/**
 * Map a tool name to the canonical `ArtifactKind` so the body can
 * pick the right layout. Anything we don't recognise falls through
 * to the generic `tool` layout — the card still surfaces the
 * call, just without shell/file-specific chrome.
 */
function kindForToolName(name: string): ArtifactKind {
  if (
    name === "run_shell" ||
    name === "run_python" ||
    name === "run_smoke_test" ||
    name === "pip_install"
  ) {
    return "terminal"
  }
  if (
    name === "write_file" ||
    name === "create_file" ||
    name === "apply_patch" ||
    name === "rename_path" ||
    name === "delete_path"
  ) {
    return "file"
  }
  return "tool"
}

// ── Component ────────────────────────────────────────────────────────────────

export function ToolArtifact({ artifact }: { artifact: Artifact }) {
  const [open, setOpen] = useState(false)
  const { kind, status, displayName, target, args, output, resultSummary } =
    artifact
  const showBody = open || status === "running" || status === "pending"

  return (
    <div
      role="group"
      aria-label={`Tool ${displayName}${status === "failed" ? " (failed)" : ""}`}
      className={`relative w-full max-w-full min-w-0 overflow-hidden rounded-lg border bg-surface-container-low ${statusBorder(status)}`}
    >
      {/* Accent bar — mirrors the ReasoningArtifact's left bar so the
          two card types look related without being identical. Color
        follows status (primary when in flight, tertiary on success,
        error on failure). */}
      <div
        className={`pointer-events-none absolute inset-y-0 left-0 w-[3px] ${statusAccent(status)}`}
        aria-hidden="true"
      />

      {/* Header — always visible, click toggles expand */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-on-surface-variant">
          <Icon name={kindIcon(kind)} size={13} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <div className="flex items-center gap-1.5 truncate font-sans text-[12px] font-medium text-on-surface">
            <span className="truncate">{displayName}</span>
            {target ? (
              <span className="truncate font-mono text-[11px] text-outline">
                · {target}
              </span>
            ) : null}
            <StatusPill status={status} />
          </div>
          <div className="font-sans text-[10px] uppercase tracking-wide text-outline">
            {kind === "terminal"
              ? "Shell output"
              : kind === "file"
                ? "File change"
                : "Tool call"}
          </div>
        </div>
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center text-outline transition-transform ${
            open ? "rotate-180" : ""
          }`}
          aria-hidden="true"
        >
          <Icon name="chevron-down" size={12} />
        </span>
      </button>

      {/* Body — collapse by default so a long shell dump doesn't
          dominate the chat, expand when the user clicks. For
          running/pending tools we auto-open so the live output is
          immediately visible. */}
      {showBody ? (
        <ArtifactBody
          kind={kind}
          status={status}
          args={args}
          output={output}
          resultSummary={resultSummary}
          target={target}
          name={artifact.name}
        />
      ) : null}
    </div>
  )
}

/**
 * Render the body of an `apply_patch` artifact. The args JSON
 * looks like `{"path": "src/foo.py", "patch": "@@ -1 +1 @@\n-old\n+new"}`
 * — we extract the patch text and render it as a parsed diff
 * (added/removed/context lines) using the same line-level styling
 * as `agent-sticker-sheet.html` lines 1656-1700 (`.patch-viewer`).
 *
 * If args don't parse as JSON (e.g. mid-stream before the engine
 * flushed the body), we fall back to a generic `file` body so the
 * card still surfaces something useful. The fallback is a one-line
 * `<pre>` that puts the raw patch text in monospace — same as the
 * pre-existing file layout, kept here so a single component owns
 * every apply_patch rendering path.
 */
function PatchBody({ args, target }: { args?: string; target?: string }) {
  const parsed = useMemo(() => parseApplyPatchArgs(args), [args])
  const hunks = useMemo(
    () => (parsed.patch ? parseUnifiedDiff(parsed.patch) : []),
    [parsed.patch],
  )
  const stats = useMemo(
    () => ({
      added: hunks.reduce((n, h) => n + h.added.length, 0),
      removed: hunks.reduce((n, h) => n + h.removed.length, 0),
    }),
    [hunks],
  )

  if (!parsed.patch || hunks.length === 0) {
    return (
      <div className="border-t border-outline-variant/50 bg-surface-container-lowest px-3 py-2 font-mono text-[11px] leading-[16px] text-on-surface-variant">
        {target ? (
          <div className="mb-1 truncate text-primary/80">{target}</div>
        ) : null}
        {parsed.patch ? (
          <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap break-words">
            {parsed.patch}
          </pre>
        ) : (
          <span className="text-outline">No patch content.</span>
        )}
      </div>
    )
  }

  return (
    <div className="border-t border-outline-variant/50 bg-surface-container-lowest">
      {/* Header — file path + added / removed line counts. The
          `+N / -N` suffix matches the example rendered in the
          user's reference (e.g. "approvals.rs +1"). */}
      <div className="flex items-center justify-between gap-2 border-b border-outline-variant/40 bg-surface-container-low px-3 py-1 font-mono text-[10px] text-on-surface-variant">
        <span className="truncate text-primary/80">{target ?? parsed.path ?? "patch"}</span>
        <span className="shrink-0 font-sans text-[10px] uppercase tracking-[0.04em]">
          <span className="text-primary">+{stats.added}</span>
          <span className="px-0.5 text-outline">/</span>
          <span className="text-error">-{stats.removed}</span>
        </span>
      </div>
      {/* Diff body — one row per source line, prefixed with `+` /
          `-` / space. Backgrounds per `agent-sticker-sheet.html`
          `.patch-line.added` / `.patch-line.removed` so the
          visual encoding survives light custom theming. */}
      <div className="max-h-[280px] overflow-auto px-0 py-1 font-mono text-[11px] leading-[18px]">
        {hunks.map((h, hi) => (
          <div key={hi} className="flex flex-col">
            {h.header ? (
              <div className="flex bg-surface-container/60 px-3 py-0.5 text-outline">
                <span className="w-4 shrink-0 text-center text-outline">
                  ⋮
                </span>
                <span className="truncate">{h.header}</span>
              </div>
            ) : null}
            {h.context.map((line, li) => (
              <PatchLine key={`c-${hi}-${li}`} kind="context" text={line} />
            ))}
            {h.removed.map((line, li) => (
              <PatchLine key={`r-${hi}-${li}`} kind="removed" text={line} />
            ))}
            {h.added.map((line, li) => (
              <PatchLine key={`a-${hi}-${li}`} kind="added" text={line} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

/** One line in the parsed diff — coloured by kind. */
function PatchLine({
  kind,
  text,
}: {
  kind: "added" | "removed" | "context"
  text: string
}) {
  const sign = kind === "added" ? "+" : kind === "removed" ? "-" : " "
  const bg =
    kind === "added"
      ? "bg-primary/10 text-primary"
      : kind === "removed"
        ? "bg-error/10 text-error"
        : "text-on-surface-variant"
  return (
    <div className={`flex whitespace-pre ${bg}`}>
      <span className="w-4 shrink-0 select-none text-center">{sign}</span>
      <span className="min-w-0 break-words">{text}</span>
    </div>
  )
}

/** Best-effort parse of the engine-supplied apply_patch args JSON. */
function parseApplyPatchArgs(args: string | undefined): {
  path?: string
  patch?: string
} {
  if (!args) return {}
  try {
    const v = JSON.parse(args)
    if (v && typeof v === "object") {
      return {
        path: typeof v.path === "string" ? v.path : undefined,
        patch: typeof v.patch === "string" ? v.patch : undefined,
      }
    }
  } catch {
    // Engine may surface the patch as raw text in some failure
    // paths (e.g. JSON truncated mid-stream). Treat the raw args
    // as the patch content so the card still renders.
    return { patch: args }
  }
  return {}
}

/** One hunk in a unified diff. Lines are stripped of their
 *  leading `+` / `-` / ` ` prefix before being stored. */
type DiffHunk = {
  header: string
  context: string[]
  added: string[]
  removed: string[]
}

/**
 * Parse a unified diff into renderable hunks. We tolerate the
 * `--- a/foo` / `+++ b/foo` header lines (and skip them) and split
 * at each `@@` hunk header. Inside a hunk, lines starting with `+`
 * are added, `-` are removed, and everything else is context
 * (including lines that just happen to begin with `+`/`-` in the
 * original file — those would need a leading space per the spec,
 * which we don't enforce here; the engine emits well-formed diffs).
 */
function parseUnifiedDiff(patch: string): DiffHunk[] {
  const lines = patch.split(/\r?\n/)
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null

  for (const line of lines) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      // File header — skip; the card already shows the path on its
      // own header row. Some diffs emit `Only in …:` or `Binary
      // files … differ` — we ignore those silently rather than
      // polluting the rendered body.
      continue
    }
    if (line.startsWith("@@")) {
      if (current) hunks.push(current)
      const headerEnd = line.indexOf(" @@", 2)
      current = {
        header:
          headerEnd === -1
            ? line
            : line.slice(0, headerEnd + 3),
        context: [],
        added: [],
        removed: [],
      }
      continue
    }
    if (!current) {
      // Diff text without a leading `@@` hunk header — collect as
      // a single context-only hunk so the body never silently drops
      // the user's patch.
      current = {
        header: "",
        context: [],
        added: [],
        removed: [],
      }
    }
    if (line.startsWith("+")) {
      current.added.push(line.slice(1))
    } else if (line.startsWith("-")) {
      current.removed.push(line.slice(1))
    } else if (line.startsWith(" ")) {
      current.context.push(line.slice(1))
    } else if (line === "") {
      // Blank line — preserve as a context row so empty lines in
      // the diff don't visually disappear.
      current.context.push("")
    } else {
      // Line without any prefix (e.g. malformed diff). Treat as
      // context to be safe.
      current.context.push(line)
    }
  }
  if (current) hunks.push(current)
  return hunks
}

/**
 * Render the artifact body. Each layout family has its own styling
 * — terminal output gets a monospace + scanline block, file
 * artifacts get a header + diff body, generic tool calls get a
 * two-line "args / output" layout.
 */
function ArtifactBody({
  kind,
  status,
  args,
  output,
  resultSummary,
  target,
  name,
}: {
  kind: ArtifactKind
  status: ArtifactStatus
  args?: string
  output?: string
  resultSummary?: string
  target?: string
  /** Original tool name — lets the file body special-case
   *  `apply_patch` to render the unified diff with line-level
   *  highlighting instead of dumping raw args. */
  name?: string
}) {
  if (kind === "file" && name === "apply_patch") {
    return <PatchBody args={args} target={target} />
  }
  if (kind === "terminal") {
    return (
      <div className="border-t border-outline-variant/50 bg-surface-container-lowest px-3 py-2 font-mono text-[11px] leading-[16px] text-on-surface-variant">
        {args ? (
          <div className="mb-1 break-words text-primary/80">$ {args}</div>
        ) : null}
        {output ? (
          <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap break-words">
            {output}
          </pre>
        ) : status === "running" || status === "pending" ? (
          <WaitingDots label="Running…" />
        ) : status === "failed" ? (
          <span className="text-error">Tool failed.</span>
        ) : (
          <span className="text-outline">(no output)</span>
        )}
      </div>
    )
  }
  if (kind === "file") {
    return (
      <div className="border-t border-outline-variant/50 bg-surface-container-lowest px-3 py-2 font-mono text-[11px] leading-[16px] text-on-surface-variant">
        {target ? (
          <div className="mb-1 truncate text-primary/80">{target}</div>
        ) : null}
        {args ? (
          <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap break-words">
            {args}
          </pre>
        ) : resultSummary ? (
          <div className="break-words">{resultSummary}</div>
        ) : status === "running" || status === "pending" ? (
          <WaitingDots label="Working…" />
        ) : status === "failed" ? (
          <span className="text-error">File operation failed.</span>
        ) : (
          <span className="text-outline">(no output)</span>
        )}
      </div>
    )
  }
  // Generic tool body — args on top, output below. Falls back to
  // status text when neither is present.
  return (
    <div className="border-t border-outline-variant/50 bg-surface-container-lowest px-3 py-2 font-mono text-[11px] leading-[16px] text-on-surface-variant">
      {args ? (
        <div className="mb-1 break-words">
          <span className="text-outline">args: </span>
          <span className="text-on-surface-variant">{args}</span>
        </div>
      ) : null}
      {output ? (
        <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap break-words">
          {output}
        </pre>
      ) : resultSummary ? (
        <div className="break-words">{resultSummary}</div>
      ) : status === "running" || status === "pending" ? (
        <WaitingDots label="Running…" />
      ) : status === "failed" ? (
        <span className="text-error">Tool failed.</span>
      ) : (
        <span className="text-outline">(no output)</span>
      )}
    </div>
  )
}

/**
 * Small pulsing-dots indicator — used while the tool is running or
 * pending so the user has a clear signal the card is live.
 */
function WaitingDots({ label }: { label: string }) {
  return (
    <div
      className="flex items-center gap-1 font-sans text-[11px] text-outline"
      aria-label={label}
    >
      <span>{label}</span>
      <span className="inline-flex items-center gap-0.5" aria-hidden="true">
        <span className="h-1 w-1 animate-pulse rounded-full bg-primary [animation-delay:0ms]" />
        <span className="h-1 w-1 animate-pulse rounded-full bg-primary [animation-delay:200ms]" />
        <span className="h-1 w-1 animate-pulse rounded-full bg-primary [animation-delay:400ms]" />
      </span>
    </div>
  )
}

// ── Styling helpers ──────────────────────────────────────────────────────────

function statusBorder(status: ArtifactStatus): string {
  switch (status) {
    case "failed":
      return "border-error/40"
    case "completed":
      return "border-tertiary/30"
    case "running":
      return "border-primary/40"
    case "pending":
    default:
      return "border-outline-variant"
  }
}

function statusAccent(status: ArtifactStatus): string {
  switch (status) {
    case "failed":
      return "bg-error"
    case "completed":
      return "bg-tertiary"
    case "running":
      return "bg-primary animate-pulse"
    case "pending":
    default:
      return "bg-outline"
  }
}

function kindIcon(kind: ArtifactKind): string {
  switch (kind) {
    case "terminal":
      return "terminal"
    case "file":
      return "file"
    case "tool":
    default:
      return "settings"
  }
}

function StatusPill({ status }: { status: ArtifactStatus }) {
  // Compact status indicator next to the title. The icon doubles
  // as the visual cue; the text label is screen-reader-only.
  switch (status) {
    case "running":
      return (
        <span
          className="inline-flex h-4 w-4 items-center justify-center text-primary"
          aria-label="Running"
        >
          <Icon name="refresh" size={11} />
        </span>
      )
    case "pending":
      return (
        <span
          className="inline-flex h-4 w-4 items-center justify-center text-outline"
          aria-label="Pending"
        >
          <Icon name="circle" size={11} />
        </span>
      )
    case "completed":
      return (
        <span
          className="inline-flex h-4 w-4 items-center justify-center text-tertiary"
          aria-label="Completed"
        >
          <Icon name="check" size={11} strokeWidth={2.5} />
        </span>
      )
    case "failed":
      return (
        <span
          className="inline-flex h-4 w-4 items-center justify-center text-error"
          aria-label="Failed"
        >
          <Icon name="circle-x" size={11} />
        </span>
      )
  }
}

// Re-export the kind helper so AgentContent.tsx (or any other caller
// that wants to pre-classify artifacts before storage) can share the
// canonical mapping without duplicating it.
export { kindForToolName }