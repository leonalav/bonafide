/**
 * chat/WaitingArtifact.tsx — The "Sent + waiting for model" card.
 *
 * Per `agent-reasoning-designs.html` lines 3010-3040 ("Compact
 * Waiting Pill") — a single horizontal row, ~28px tall, that
 * shows the spinner + status text + Esc hint inline. Replaces the
 * older halo+shimmer card (lines 2922-2990 in the same file)
 * which dominated the thread visually for what is essentially a
 * passive "request is in flight" state.
 *
 * Why we don't use `loadingicon.gif`:
 *   - The GIF is a raster asset that doesn't scale with the
 *     surrounding text size and adds a chunky pixel-art look
 *     that fights the design system's "Soft-Technical" tone.
 *   - A pure CSS spinner uses one of the existing
 *     `Icon` paths (`refresh`) and inherits `currentColor`, so
 *     it adapts to any surrounding tint without a new asset.
 *   - The `animate-sync-spin` keyframes already ship in the
 *     design system (see `agent-sticker-sheet.html`'s
 *     `.animate-sync-spin`), so no new motion is introduced.
 *
 * The card carries no chrome (no border, no shadow, no halo,
 * no shimmer strip) — just a subtle primary-tinted background
 * with the spinner + label inline. The Esc hint sits on the
 * right edge of the same row so the user can read everything
 * in a single glance.
 */

import { Icon } from "../ui/Icon"

export function WaitingArtifact({
  agentLabel,
  onCancel,
}: {
  agentLabel: string
  onCancel?: () => void
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-w-0 max-w-full animate-fade-in items-center gap-2 rounded border border-primary/20 bg-primary/5 px-2.5 py-1.5"
    >
      {/* CSS spinner — `refresh` Icon path with `animate-sync-spin`
          (defined in the design system's keyframes). `text-primary`
          keeps it consistent with the rest of the active-state
          affordances. */}
      <span
        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-primary animate-sync-spin"
        aria-hidden="true"
      >
        <Icon name="refresh" size={14} />
      </span>

      {/* Status text — single-line, ellipsises when the agent label
          is unusually long so the row never wraps onto a second
          line and pushes the Esc hint off-screen. */}
      <span className="min-w-0 flex-1 truncate font-sans text-[12px] text-on-surface">
        Sending to{" "}
        <strong className="font-medium text-secondary">{agentLabel}</strong>
      </span>

      {/* Esc hint — same row, right-aligned. When the parent wires
          `onCancel` we render a button so clicking cancels the
          request; otherwise we show a static `<kbd>` so the hint
          is still discoverable but inert. */}
      {onCancel ? (
        <button
          onClick={onCancel}
          aria-label="Cancel request"
          className="flex items-center gap-1 rounded border border-outline-variant/60 bg-surface-container-low px-1 font-mono text-[9px] text-outline hover:text-on-surface"
        >
          Esc
        </button>
      ) : (
        <kbd className="rounded border border-outline-variant bg-surface-container-high px-1 font-mono text-[9px] text-outline">
          Esc
        </kbd>
      )}
    </div>
  )
}
