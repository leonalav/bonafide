/**
 * chat/ReasoningArtifact.tsx — Inline reasoning section.
 *
 * A lightweight collapsible section showing the model's reasoning text.
 * No header/body/footer chrome — just a subtle label and the text.
 * Collapses to the first 3 lines; user clicks to expand.
 * During streaming, shows animated dots as a placeholder before
 * any reasoning text has arrived.
 */

import { useState } from "react"

const COLLAPSED_LINE_COUNT = 3

export function ReasoningSection({
  reasoning,
  streaming = false,
}: {
  reasoning: string
  streaming?: boolean
}) {
  const [open, setOpen] = useState(false)

  if (!reasoning && !streaming) return null

  const lines = reasoning ? reasoning.split(/\r?\n/) : []
  const previewLines = lines.slice(0, COLLAPSED_LINE_COUNT).join("\n")
  const overflowCount = Math.max(0, lines.length - COLLAPSED_LINE_COUNT)

  return (
    <div className="flex flex-col gap-1">
      {/* Collapsible label row */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="group flex items-center gap-1.5 text-left"
      >
        <span className="font-sans text-[10px] uppercase tracking-[0.05em] text-outline transition-colors group-hover:text-on-surface-variant">
          Reasoning
        </span>
        {streaming ? (
          <span className="flex items-center gap-0.5" aria-hidden="true">
            <span className="h-[4px] w-[4px] animate-pulse rounded-full bg-primary [animation-delay:0ms]" />
            <span className="h-[4px] w-[4px] animate-pulse rounded-full bg-primary [animation-delay:200ms]" />
            <span className="h-[4px] w-[4px] animate-pulse rounded-full bg-primary [animation-delay:400ms]" />
          </span>
        ) : (
          <span className="font-sans text-[10px] text-outline transition-transform duration-150 group-hover:text-on-surface-variant">
            {open ? "▲" : "▼"}
          </span>
        )}
      </button>

      {/* Reasoning text */}
      {(open || lines.length === 0) ? (
        <pre className="whitespace-pre-wrap break-words font-body text-[12px] leading-[18px] text-on-surface-variant">
          {streaming && lines.length === 0
            ? "Thinking…"
            : reasoning}
        </pre>
      ) : (
        <>
          <pre className="whitespace-pre-wrap break-words font-body text-[12px] leading-[18px] text-on-surface-variant">
            {previewLines}
          </pre>
          {overflowCount > 0 ? (
            <button
              onClick={() => setOpen(true)}
              className="self-start font-sans text-[11px] text-primary hover:underline"
            >
              Show {overflowCount} more line{overflowCount === 1 ? "" : "s"}
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}
