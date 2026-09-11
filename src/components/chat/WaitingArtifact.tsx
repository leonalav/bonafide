/**
 * chat/WaitingArtifact.tsx — The "Sent + waiting for model" card.
 *
 * Direct port of the "User Message + Waiting State" sticker from
 * `agent-reasoning-designs.html` lines 2922-2990. Three visual layers:
 *
 *   1. Halo frame — 32px rounded square with a primary/10 fill and a
 *      primary/30 ring. Sits the loadingicon.gif in a centered well.
 *   2. Info column — "Waiting…" title with animated dots + a
 *      subtitle naming the destination agent ("Debugger agent").
 *   3. Progress shimmer — 2px tall, absolute-positioned at the
 *      bottom of the card. Sliding gradient gives an indeterminate
 *      progress feel.
 *
 * The Esc-to-cancel meta line is below the card; the cancel button
 * itself lives in the ChatHeader (sub-phase 1.3) because the cancel
 * action is global to the thread.
 */

import { Icon } from "../ui/Icon"

export function WaitingArtifact({
  agentLabel,
  onCancel,
  /** Display name of the agent/mode we're waiting on, e.g. "Debugger agent". */
  /** Called when the user hits Esc or clicks the inline cancel link. */
}: {
  agentLabel: string
  onCancel?: () => void
}) {
  return (
    <div className="flex min-w-0 max-w-full animate-fade-in flex-col items-start gap-1">
      <div className="relative flex w-full max-w-full min-w-0 items-center gap-3 overflow-hidden rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2.5">
        {/* Halo + loadingicon.gif */}
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/30">
          <img
            src="/loadingicon.gif"
            alt=""
            className="h-5 w-5"
            aria-hidden="true"
          />
        </div>

        {/* Info column */}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-1.5 font-sans text-[13px] font-medium text-on-surface">
            Waiting…
            <span
              className="inline-flex items-center gap-0.5"
              aria-hidden="true"
            >
              {/* REVIEW(opus) FINDING 5 [high]: spec uses 4px dots, not 3px */}
              <span className="h-1 w-1 animate-pulse rounded-full bg-primary [animation-delay:0ms]" />
              <span className="h-1 w-1 animate-pulse rounded-full bg-primary [animation-delay:200ms]" />
              <span className="h-1 w-1 animate-pulse rounded-full bg-primary [animation-delay:400ms]" />
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1 font-sans text-[11px] text-outline">
            <span>
              Sending request to{" "}
              <strong className="font-medium text-secondary">
                {agentLabel}
              </strong>
            </span>
            <span>·</span>
            <span className="flex items-center gap-0.5 text-primary">
              <Icon name="check" size={9} strokeWidth={2.5} />
              delivered
            </span>
          </div>
        </div>

        {/* Bottom progress shimmer — absolute, sits at card bottom */}
        {/* REVIEW(opus) FINDING 12 [low]: pointer-events-none on a 2px
            decorative strip is redundant; dropping it. */}
        <div
          className="absolute inset-x-[3px] bottom-0 h-[2px] overflow-hidden bg-surface-container-high"
          aria-hidden="true"
        >
          <div
            className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-primary to-transparent"
            style={{ animation: "waiting-shimmer 1.6s ease-in-out infinite" }}
          />
        </div>
      </div>

      <div className="flex items-center gap-1.5 pl-1 font-sans text-[10px] text-outline">
        <span>Just now</span>
        <span>·</span>
        {onCancel ? (
          <button
            onClick={onCancel}
            className="flex items-center gap-1 rounded border border-outline-variant/60 bg-surface-container-low px-1 font-mono text-[9px] text-outline hover:text-on-surface"
            aria-label="Cancel request"
          >
            Esc
          </button>
        ) : (
          <kbd className="rounded border border-outline-variant bg-surface-container-high px-1 font-mono text-[9px]">
            Esc
          </kbd>
        )}
        <span>to cancel</span>
      </div>
    </div>
  )
}
