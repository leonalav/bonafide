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

import { useState } from "react"
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
        />
      ) : null}
    </div>
  )
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
}: {
  kind: ArtifactKind
  status: ArtifactStatus
  args?: string
  output?: string
  resultSummary?: string
  target?: string
}) {
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