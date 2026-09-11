/**
 * chat/ReasoningArtifact.tsx — "Thought Bubble" port.
 *
 * The model's reasoning text rendered as a collapsible card with
 * a gradient primary→tertiary accent bar on the left edge. Direct
 * port of `agent-reasoning-designs.html` lines 2029-2079.
 *
 * Layout:
 *   ┌──────────────────────────────────────────┐
 *   │║  🪄  Analyzing LR Spike          ~8s     │  ← header
 *   │║       Reasoning                         │
 *   │║  ──────────────────────────────────── │
 *   │║  The val_loss plateau at step 3800...   │  ← body (collapsible)
 *   │║  ──────────────────────────────────── │
 *   │║  Confidence: ▓▓▓░░  High                │  ← footer
 *   └──────────────────────────────────────────┘
 *
 * Where ║ is the 3px gradient accent bar (primary → tertiary).
 *
 * In Phase 1 the body is always collapsed to 3 lines so the bubble
 * doesn't dominate the chat. The user clicks the chevron to
 * expand. A "Thinking…" indicator dot-row appears during streaming
 * but Phase 1 only ships buffered replies, so it's effectively
 * never visible — left in for Phase 3's streaming rollout.
 */

import { useState } from "react"
import { Icon } from "../ui/Icon"

const COLLAPSED_LINE_COUNT = 3

export function ReasoningArtifact({
  reasoning,
  streaming = false,
  /**
   * When true, the header shows the animated 3-dot "thinking"
   * indicator. Phase 1 only ships buffered replies, so it stays
   * `false` everywhere. Phase 3's streaming rollout flips this on
   * for the duration of the live reasoning chunk.
   */
}: {
  reasoning: string
  streaming?: boolean
}) {
  const [open, setOpen] = useState(false)

  const lines = reasoning.split(/\r?\n/)
  const previewLines = lines.slice(0, COLLAPSED_LINE_COUNT).join("\n")
  const overflowCount = Math.max(0, lines.length - COLLAPSED_LINE_COUNT)

  // Auto-title: first non-empty line, clamped to ~60 chars.
  // REVIEW(opus) FINDING 2 [high]: the original regex /\s+\S*$/
  // matched a trailing non-whitespace run, which stripped the last
  // word from code-like identifiers ("train.py:42" → "train.py:").
  // We now strip only trailing whitespace.
  const autoTitle =
    lines
      .map((l) => l.trim())
      .find((l) => l.length > 0)
      ?.slice(0, 60)
      .replace(/\s+$/, " ") ?? "Reasoning"

  // Heuristic: very long reasoning = "High" confidence placeholder.
  // Phase 2 will source this from `message.confidence` once the model
  // surface standardises on it.
  const confidence: "Low" | "Medium" | "High" =
    reasoning.length > 1500 ? "High" : reasoning.length > 400 ? "Medium" : "Low"

  return (
    <div
      // `min-w-0` + `max-w-full` clamps this card to the parent's
      // width. Without `min-w-0`, a very long reasoning line refuses
      // to wrap and pushes the card — and the chat column with it —
      // past the viewport. `overflow-hidden` on the rounded card
      // catches any content that still escapes.
      className="relative w-full max-w-full min-w-0 overflow-hidden rounded-lg border border-outline-variant bg-surface-container-low"
      // REVIEW: HTML artifact uses a 3px gradient accent bar via
      // ::before. We replicate with a separate absolute div so it
      // composes cleanly with rounded corners.
    >
      <div
        className="pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b from-primary to-tertiary"
        aria-hidden="true"
      />

      {/* Header — always visible, click toggles expand */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-primary">
          <Icon name="brain" size={14} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <div
            className="flex items-center gap-1.5 truncate font-sans text-[13px] font-medium text-on-surface"
            // REVIEW(opus) FINDING 7: screen readers benefit from a
            // label when the dots are visible so they don't try to
            // announce the in-progress indicator.
            aria-label={streaming ? "AI reasoning in progress" : undefined}
          >
            {autoTitle}
            {streaming ? (
              <span
                className="inline-flex items-center gap-0.5"
                aria-hidden="true"
              >
                <span className="h-[3px] w-[3px] animate-pulse rounded-full bg-primary [animation-delay:0ms]" />
                <span className="h-[3px] w-[3px] animate-pulse rounded-full bg-primary [animation-delay:200ms]" />
                <span className="h-[3px] w-[3px] animate-pulse rounded-full bg-primary [animation-delay:400ms]" />
              </span>
            ) : null}
          </div>
          <div className="font-sans text-[10px] uppercase tracking-wide text-outline">
            Reasoning
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

      {/* Body — preview when collapsed, full when expanded */}
      <div className="border-t border-outline-variant/50 px-3 py-2 font-body text-[12px] leading-[18px] text-on-surface-variant">
        <pre className="whitespace-pre-wrap break-words font-body">
          {open ? reasoning : previewLines}
        </pre>
        {!open && overflowCount > 0 ? (
          <button
            onClick={() => setOpen(true)}
            className="mt-1 font-sans text-[11px] text-primary hover:underline"
          >
            Show {overflowCount} more line{overflowCount === 1 ? "" : "s"}
          </button>
        ) : null}
      </div>

      {/* Footer — confidence bar */}
      <div className="flex items-center justify-between border-t border-outline-variant/50 bg-surface-container/60 px-3 py-1.5 font-sans text-[11px] text-outline">
        <div className="flex items-center gap-1.5">
          <span>Confidence</span>
          <div className="flex gap-0.5">
            <span
              className={`h-1.5 w-3 rounded-sm ${confidenceTone(confidence, 0)}`}
            />
            <span
              className={`h-1.5 w-3 rounded-sm ${confidenceTone(confidence, 1)}`}
            />
            <span
              className={`h-1.5 w-3 rounded-sm ${confidenceTone(confidence, 2)}`}
            />
            <span
              className={`h-1.5 w-3 rounded-sm ${confidenceTone(confidence, 3)}`}
            />
          </div>
          <span className="text-primary">{confidence}</span>
        </div>
      </div>
    </div>
  )
}

/** Map (confidence, segmentIndex) to a background colour. */
function confidenceTone(
  confidence: "Low" | "Medium" | "High",
  segment: number,
): string {
  // REVIEW(opus) FINDING 1 [critical]: prior implementation filled all
  // four segments at "High" leaving no empty segment for visual
  // contrast. The artifact HTML (line 2899) shows 3 filled / 1 empty
  // at every confidence level. Mapping per spec:
  //   High   → 3 filled (primary)
  //   Medium → 2 filled (tertiary)
  //   Low    → 1 filled (outline)
  // Segments at index >= filled always render empty.
  const filled = confidence === "High" ? 3 : confidence === "Medium" ? 2 : 1
  if (segment < filled) {
    return confidence === "High"
      ? "bg-primary"
      : confidence === "Medium"
        ? "bg-tertiary"
        : "bg-outline"
  }
  return "bg-outline/30"
}
