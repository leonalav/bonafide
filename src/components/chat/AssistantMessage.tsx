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
 * Body rendering: the assistant's reply is rendered through
 * `MarkdownContent`, which parses block-level Markdown (headings,
 * tables, separators, lists, code blocks) into the matching UI
 * elements. The previous typewriter-style character reveal
 * (`TypewriterText`) only tokenised backtick spans and `**bold**`,
 * which left every other Markdown construct — including the
 * `###` / `|...|` / `---` / `- item` patterns that the model
 * emits most often — visible as raw text.
 *
 * Reasoning and errors are never typewritten (they're either
 * pre-rendered reasoning dumps or failures the user needs to read
 * immediately).
 */

import { Icon } from "../ui/Icon"
import type { ChatMessage } from "../../chats/ChatStore"
import { MarkdownContent } from "./MarkdownContent"
import { ReasoningSection } from "./ReasoningArtifact"
import { ToolArtifact } from "./ToolArtifact"
import { ApprovalArtifact } from "./ApprovalArtifact"

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
      {/* Inline reasoning — appears immediately on request receipt
          (even before the engine returns) so the user gets feedback
          the moment Send lands. Replaced the full "ReasoningArtifact"
          card with a lightweight collapsible section so thinking
          text flows naturally in the chat without dominating it. */}
      {message.reasoning || message.streaming ? (
        <ReasoningSection
          reasoning={message.reasoning ?? ""}
          streaming={!!message.streaming}
        />
      ) : null}
      {/* Inline tool artifacts — each card lives below the
          reasoning / body and reflects the tool's lifecycle
          (pending → running → completed / failed). Approval
          artifacts render via a separate component so they can
          host Approve / Reject affordances without inheriting
          ToolArtifact's expand/collapse chrome. */}
      {hasArtifacts ? (
        <div
          className="flex flex-col gap-1.5"
          aria-label="Tool calls"
        >
          {message.artifacts!.map((a) =>
            a.kind === "approval" ? (
              <ApprovalArtifact
                key={a.id}
                artifact={a}
                onApprove={
                  message.onApproveArtifact
                    // CRITICAL FIX (PROD): forward `a.name`
                    // (the engine-supplied `toolCallId`) rather
                    // than `a.id` (the React key, which is
                    // sometimes a synthetic fallback like
                    // `awaiting-approval-{msgId}` when the LLM
                    // didn't populate the tool_call id). The
                    // backend uses this id to locate the
                    // pending tool_call in `llm_history` —
                    // passing a synthetic id results in
                    // "tool_call not found" and the tool
                    // never executes, which is exactly why
                    // clicking APPROVE on a patch felt like
                    // "nothing happens" in the bug screenshot.
                    ? () => message.onApproveArtifact?.(a.name ?? a.id)
                    : undefined
                }
                onReject={
                  message.onRejectArtifact
                    ? () => message.onRejectArtifact?.(a.name ?? a.id)
                    : undefined
                }
              />
            ) : (
              <ToolArtifact key={a.id} artifact={a} />
            ),
          )}
        </div>
      ) : null}
      {message.error ? (
        <ErrorBubble error={message.error} />
      ) : (
        // Markdown/GFM body. The previous typewriter-only renderer
        // dumped the model reply as raw text, which left headings,
        // tables, separators, lists, and code blocks showing as
        // literal `###` / `|...|` / `---` / `- ` / ```` ``` ````.
        // MarkdownContent parses those into their corresponding UI
        // blocks so replies look the way the model intended.
        <MarkdownContent text={message.content} />
      )}
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
