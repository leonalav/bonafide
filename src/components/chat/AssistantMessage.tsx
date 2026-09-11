/**
 * chat/AssistantMessage.tsx — Agent reply block.
 *
 * Per `agent-example-sessions.html` lines 700-760 (`msg.agent`):
 *   - NO bubble, NO border, NO background
 *   - Left-aligned text only, just an author header above the body
 *   - The accent is a 2px primary-color vertical bar to the left of
 *     the block (replaces the ✦ avatar circle from earlier rounds)
 *
 * Reasoning lives in its own collapsible `ReasoningArtifact` above
 * the body, not in a header chip — matches the spec's
 * `thinking-dropdown` pattern. Failed turns render an inline
 * `ErrorBubble` instead of the normal body so the failure is
 * impossible to miss without taking over the whole thread.
 *
 * Generative text effect: on first render, the body plays a fast
 * character-reveal animation (see `TypewriterText`). The animation
 * is fire-and-forget — when the user scrolls, clicks, or types
 * anywhere, the reveal snaps to the final text. Reasoning and
 * errors are never typewritten (they're either pre-rendered
 * reasoning dumps or failures the user needs to read immediately).
 */

import { useEffect, useRef, useState } from "react"
import { Icon } from "../ui/Icon"
import type { ChatMessage } from "../../chats/ChatStore"
import { InlineContent } from "./UserMessage"
import { ReasoningArtifact } from "./ReasoningArtifact"
import { ToolArtifact } from "./ToolArtifact"

/** Per-frame reveal cadence. Lower = faster; tuned for "fast" feel. */
const TYPEWRITER_BASE_DELAY_MS = 10
const TYPEWRITER_PER_CHAR_DELAY_MS = 4

export function AssistantMessage({ message }: { message: ChatMessage }) {
  const hasArtifacts =
    Array.isArray(message.artifacts) && message.artifacts.length > 0
  return (
    // Per `agent-example-sessions.html` lines 710-730: agent turns
    // are borderless blocks. The 2px primary-tinted bar on the left
    // is the only visual cue distinguishing them from user turns —
    // matches the `msg.agent` rule there.
    <div className="relative flex min-w-0 max-w-full animate-fade-in flex-col gap-1.5 border-l-2 border-primary/40 pl-3">
      <header className="flex items-center gap-2 font-sans text-[10px] font-semibold uppercase tracking-[0.06em] text-on-surface-variant">
        <span>Agent</span>
        <span className="font-mono text-[10px] tabular-nums text-outline">
          {formatMessageTime(message.ts)}
        </span>
      </header>
      {message.reasoning ? (
        <ReasoningArtifact reasoning={message.reasoning} />
      ) : null}
      {/* Inline tool artifacts — each card lives below the
          reasoning / body and reflects the tool's lifecycle
          (pending → running → completed / failed). */}
      {hasArtifacts ? (
        <div
          className="flex flex-col gap-1.5"
          aria-label="Tool calls"
        >
          {message.artifacts!.map((a) => (
            <ToolArtifact key={a.id} artifact={a} />
          ))}
        </div>
      ) : null}
      {message.error ? (
        <ErrorBubble error={message.error} />
      ) : (
        <TypewriterText text={message.content} />
      )}
    </div>
  )
}

/**
 * Fast generative-text reveal.
 *
 * Animates `text` from empty to fully revealed character-by-character
 * over a short window. Uses `requestAnimationFrame` so the cadence
 * is GPU-friendly and cancels cleanly when the component unmounts.
 *
 * The animation is cancellable by any user input:
 *   - any mousedown anywhere snaps to the end
 *   - any keydown anywhere snaps to the end
 *   - any scroll on any ancestor snaps to the end
 * This matches the "fast" requirement — we don't trap the user
 * behind a long animation; they can always read the full text
 * immediately on demand.
 */
function TypewriterText({ text }: { text: string }) {
  const [revealedCount, setRevealedCount] = useState<number>(0)
  const rafRef = useRef<number | null>(null)
  const lastTickRef = useRef<number>(0)

  // Skip animation entirely for empty content and for previously-
  // revealed content (e.g. a re-render after navigation).
  // We also skip when the user has already moved past the message
  // (Phase 3 streaming — not wired yet).

  useEffect(() => {
    if (revealedCount >= text.length) return
    function snap() {
      setRevealedCount(text.length)
    }
    document.addEventListener("mousedown", snap, { once: true })
    document.addEventListener("keydown", snap, { once: true })
    document.addEventListener("scroll", snap, {
      once: true,
      capture: true,
    } as AddEventListenerOptions)
    return () => {
      document.removeEventListener("mousedown", snap)
      document.removeEventListener("keydown", snap)
      document.removeEventListener("scroll", snap, {
        capture: true,
      } as EventListenerOptions)
    }
  }, [text, revealedCount])

  useEffect(() => {
    // Empty text or already revealed: nothing to animate.
    if (text.length === 0 || revealedCount >= text.length) return

    function step(timestamp: number) {
      if (!lastTickRef.current) lastTickRef.current = timestamp
      const delta = timestamp - lastTickRef.current
      // Reveal multiple characters per frame based on elapsed time
      // — keeps the perceived speed constant on high-refresh displays
      // and avoids dropping to 1 char/frame on slow ones.
      if (delta >= TYPEWRITER_BASE_DELAY_MS) {
        const charsThisTick = Math.max(
          1,
          Math.floor(delta / TYPEWRITER_PER_CHAR_DELAY_MS),
        )
        setRevealedCount((c) => Math.min(text.length, c + charsThisTick))
        lastTickRef.current = timestamp
      }
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      lastTickRef.current = 0
    }
  }, [text, revealedCount])

  // When the text changes mid-stream (Phase 3 / future streaming),
  // the new `text` may have grown; reveal from the previous length
  // so we don't replay characters the user already saw. Today the
  // message is delivered whole so this branch fires once on mount.
  const isComplete = revealedCount >= text.length
  const visibleText = isComplete ? text : text.slice(0, revealedCount)

  return (
    <div className="font-body text-[13px] leading-[20px] text-on-surface">
      <InlineContent text={visibleText} />
      {!isComplete ? (
        // A blinking caret during reveal — communicates "still
        // streaming" without blocking the read.
        <span
          aria-hidden="true"
          className="ml-[1px] inline-block h-[14px] w-[5px] -mb-[2px] animate-caret-blink bg-primary align-baseline"
        />
      ) : null}
    </div>
  )
}

function formatMessageTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  })
}

function ErrorBubble({ error }: { error: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-error/30 bg-error/5 px-3 py-2">
      <div className="flex items-center gap-1.5 font-sans text-[11px] font-medium text-error">
        <Icon name="circle-x" size={11} />
        Failed to reach model
      </div>
      <p className="font-body text-[12px] leading-[17px] text-on-surface-variant">
        {error}
      </p>
    </div>
  )
}
