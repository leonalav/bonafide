/**
 * chat/ChatThread.tsx — Scrollable message list.
 *
 * Pure presentational component: takes the ordered list of messages
 * and a "waiting" flag, dispatches each to the right bubble
 * component (User / Assistant / System), and shows the Waiting
 * artifact inline at the end whenever the thread is sending.
 *
 * Autoscroll behaviour:
 *   - New message appended → snap to bottom
 *   - User has scrolled up (>80px from bottom) → DO NOT autoscroll
 *     (they're reading older context; don't yank them away)
 *   - User scrolls back near the bottom → resume autoscroll on the
 *     next append
 *
 * This is the same heuristic VS Code Copilot uses. It's cheap to
 * compute and respects user intent without needing a "Jump to
 * bottom" button (Phase 3).
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react"
import type { ChatMessage } from "../../chats/ChatStore"
import { UserMessage } from "./UserMessage"
import { AssistantMessage } from "./AssistantMessage"
import { SystemMessage } from "./SystemMessage"
import { WaitingArtifact } from "./WaitingArtifact"

const STICK_TO_BOTTOM_PX = 80

export type ChatThreadHandle = {
  /**
   * Scroll the viewport so the message with this id is anchored at
   * the top of the visible area. Used by the user-message Return
   * affordance to rewind the thread.
   */
  scrollToMessage: (id: string) => void
}

export const ChatThread = forwardRef<ChatThreadHandle, {
  messages: ChatMessage[]
  sending: boolean
  /** Display name for the agent we're waiting on (e.g. "Debugger agent"). */
  agentLabel: string
  /** Called when the user clicks the inline cancel pill on the Waiting card. */
  onCancel?: () => void
  /** Rewind the thread to just before this message and re-run it. */
  onReturn?: (message: ChatMessage) => void
  /**
   * Commit a new value for an inline-edited bubble. The parent is
   * expected to truncate everything after the message and re-run the
   * completion request — the bubble itself does NOT persist.
   */
  onCommitMessage?: (message: ChatMessage, newContent: string) => void
}>(function ChatThread(
  { messages, sending, agentLabel, onCancel, onReturn, onCommitMessage },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)
  const lastMessageCount = useRef(messages.length)
  // Track per-message DOM nodes so the Return action can scroll to a
  // specific id without re-querying the DOM each render.
  const messageNodes = useRef(new Map<string, HTMLDivElement>())

  // Expose the scroll-to-message imperative API to the parent.
  useImperativeHandle(
    ref,
    () => ({
      scrollToMessage: (id: string) => {
        const el = messageNodes.current.get(id)
        const scroller = scrollRef.current
        if (!el || !scroller) return
        // Compute the offset relative to the scroll container, not the
        // viewport, so the message lands at the top of the visible
        // area regardless of header / composer height.
        const top = el.offsetTop
        scroller.scrollTo({ top, behavior: "smooth" })
      },
    }),
    [],
  )

  // Detect whether the user has scrolled away from the bottom. We
  // listen for scrolls and update `stickToBottom`. New messages
  // honour the flag in the autoscroll effect below.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    function onScroll() {
      if (!el) return
      const distanceFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight
      stickToBottom.current = distanceFromBottom < STICK_TO_BOTTOM_PX
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [])

  // Autoscroll when a new message arrives and we're still at the bottom.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (messages.length === lastMessageCount.current) return
    lastMessageCount.current = messages.length
    if (stickToBottom.current) {
      // Scroll instantly to keep the user anchored to the latest message.
      el.scrollTop = el.scrollHeight
    }
  }, [messages.length])

  // When `sending` flips on/off we *always* scroll to bottom — the
  // user explicitly kicked off the request, so re-anchor is expected.
  // REVIEW(opus) FINDING 8 [medium]: capture the user's distance-from-
  // bottom before writing so concurrent content changes (e.g. a
  // system message arriving on the same frame) don't yank the
  // viewport off-target.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const offset = el.scrollHeight - el.scrollTop - el.clientHeight
    el.scrollTop = el.scrollHeight - offset
  }, [sending])

  // Group consecutive same-author messages? Phase 1 keeps each turn
  // as its own bubble. Visual grouping would clash with the right-
  // vs-left alignment and add little value at typical message counts.
  const rendered = useMemo(
    () =>
      messages.map((m) => {
        if (m.role === "user") {
          return (
            <div
              key={m.id}
              ref={(el) => {
                if (el) messageNodes.current.set(m.id, el)
                else messageNodes.current.delete(m.id)
              }}
              // min-w-0 + max-w-full: same contract as the other
              // message wrappers — keeps the row from pushing the
              // thread column past the viewport on long content.
              className="min-w-0 max-w-full scroll-anchor"
            >
              <UserMessage
                message={m}
                onReturn={() => {
                  // The Return affordance is a *true* rewind:
                  //   1. Smooth-scroll so the viewport lands on the
                  //      target message so the user can see what was
                  //      about to be dropped.
                  //   2. Hand off to the parent which truncates
                  //      everything after this message and loads the
                  //      rewound content into the composer textarea
                  //      (per the spec: "rewinded content goes
                  //      straight to the text box of the chat box").
                  //      The user can then tweak + resend manually.
                  // We do (1) first (synchronously, with the message
                  // still in place) so the scroll animation is
                  // anchored to a stable layout; the mutation in (2)
                  // happens before the user can perceive the
                  // animation end.
                  const node = messageNodes.current.get(m.id)
                  const scroller = scrollRef.current
                  if (node && scroller) {
                    scroller.scrollTo({
                      top: node.offsetTop,
                      behavior: "smooth",
                    })
                  }
                  onReturn?.(m)
                }}
                onCommit={
                  onCommitMessage
                    ? (newContent) => onCommitMessage(m, newContent)
                    : undefined
                }
                onCopy={() => {
                  // Copy the visible content (not attachments). The
                  // navigator.clipboard API can fail in non-secure
                  // contexts; we swallow the error rather than
                  // showing a toast for a non-critical affordance.
                  void navigator.clipboard
                    .writeText(m.content)
                    .catch(() => undefined)
                }}
              />
            </div>
          )
        }
        if (m.role === "assistant")
          return (
            <div
              key={m.id}
              ref={(el) => {
                if (el) messageNodes.current.set(m.id, el)
                else messageNodes.current.delete(m.id)
              }}
              // min-w-0 + max-w-full lets this row shrink to fit the
              // column even when the assistant bubble has long content.
              className="min-w-0 max-w-full"
            >
              <AssistantMessage key={m.id} message={m} />
            </div>
          )
        return (
          <div
            key={m.id}
            ref={(el) => {
              if (el) messageNodes.current.set(m.id, el)
              else messageNodes.current.delete(m.id)
            }}
            className="min-w-0 max-w-full"
          >
            <SystemMessage message={m} />
          </div>
        )
      }),
    [messages, onReturn, onCommitMessage],
  )

  return (
    <div
      ref={scrollRef}
      // `min-w-0` lets the column shrink below its intrinsic content
      // width when the chat surface is narrow; without it, a long
      // assistant bubble / reasoning card can push the whole column
      // past the viewport. `overflow-x-hidden` is the safety net for
      // any descendant that still manages to escape its clamp.
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-3 py-4"
    >
      {rendered}
      {sending ? (
        <WaitingArtifact agentLabel={agentLabel} onCancel={onCancel} />
      ) : null}
    </div>
  )
})
