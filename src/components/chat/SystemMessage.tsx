/**
 * chat/SystemMessage.tsx — Centered, low-emphasis metadata note.
 *
 * Used for non-conversational events inside the thread:
 *   - "Thread opened from Run Inspector · 12s ago"
 *   - Future "Restored from history", "Files attached", etc.
 *
 * Visually muted so the eye skips past it but it remains available
 * for context.
 */

import type { ChatMessage } from "../../chats/ChatStore"

export function SystemMessage({ message }: { message: ChatMessage }) {
  return (
    // `min-w-0` + `max-w-full` keeps the pill within the column.
    // `truncate` on the pill itself turns long unbroken strings into
    // an ellipsis so they can never push the column past the viewport.
    <div className="flex min-w-0 max-w-full animate-fade-in justify-center">
      <div className="max-w-full truncate rounded-full border border-outline-variant/60 bg-surface-container-low/60 px-3 py-1 font-sans text-[11px] text-outline">
        {message.content}
      </div>
    </div>
  )
}
