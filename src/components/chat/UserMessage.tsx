/**
 * chat/UserMessage.tsx — User turn block.
 *
 * Per `agent-example-sessions.html` lines 670-700 (`msg.user`):
 *   - Right-aligned text (no bubble wrap)
 *   - Border with primary tint + faint primary background
 *   - Author header ("ML Engineer") + timestamp
 *   - Inline backtick `code` renders as a styled span
 *   - Bottom-right action affordances (Copy + Revert) appear on
 *     hover. The Revert icon matches the spec's curved undo arrow.
 *
 * Also exports the shared `formatTime` and `InlineContent` helpers
 * used by the sibling message components. We keep them here rather
 * than a third `internal.ts` file because the three bubble
 * components share exactly the same handful of formatting concerns
 * and adding an import for two lines of formatting code is noise.
 */

import { useState } from "react"
import { Icon } from "../ui/Icon"
import type { ChatMessage } from "../../chats/ChatStore"

export function formatTime(ts: number): string {
  // REVIEW(opus) FINDING 10 [medium]: `hour12: false` alone isn't
  // honoured on every platform. We add `hourCycle: 'h23'` which is
  // the canonical 24-hour specifier across modern browsers and
  // node runtimes.
  const d = new Date(ts)
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  })
}

/**
 * Render plain text with very lightweight inline markup:
 *   - Backtick-wrapped text becomes a styled `<code>` span
 *   - `**bold**` becomes a `<strong>` span
 *   - `*italic*` becomes an `<em>` span
 *   - Long unbroken strings wrap via `break-words`
 *   - Newlines are preserved as separate paragraphs
 *
 * Phase 1 deliberately avoids pulling in a full Markdown parser.
 * Code spans, bold, and italic are the inline affordances users
 * actually need for chat-style exchanges. Backticks take precedence
 * over `*` so JSON inside `code` (e.g. `"name": "*foo*"`) renders
 * verbatim without accidentally italicising.
 */
export function InlineContent({ text }: { text: string }) {
  const lines = text.split(/(\n)/)
  return (
    <>
      {lines.map((line, i) => {
        if (line === "\n") return <br key={i} />
        const nodes = parseInline(line)
        return (
          <span key={i} className="break-words">
            {nodes.map((n, j) => renderToken(n, `${i}-${j}`))}
          </span>
        )
      })}
    </>
  )
}

/**
 * One token in the lightweight inline parser. `text` is rendered
 * as plain runs; `code`, `bold`, and `italic` get their wrappers.
 */
type InlineToken =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "bold"; value: string }
  | { kind: "italic"; value: string }

/**
 * Tokenise one line (no newlines) into inline tokens. Order of
 * precedence:
 *
 *   1. Backtick span (`` `…` ``) — wins over `*` so JSON keys
 *      inside `code` don't get italicised.
 *   2. `**…**` — bold (two-char opener is checked before single `*`).
 *   3. `*…*` — italic.
 *   4. Plain run up to the next special character.
 *
 * If an opener has no matching closer (e.g. a stray `` ` `` or `*`)
 * we emit the opener as plain text and keep parsing — this avoids
 * silently dropping characters when the user mistypes a closing
 * delimiter.
 */
function parseInline(line: string): InlineToken[] {
  const tokens: InlineToken[] = []
  let i = 0
  while (i < line.length) {
    // ── 1. Code span ────────────────────────────────────────────────
    if (line[i] === "`") {
      const close = line.indexOf("`", i + 1)
      if (close !== -1 && close > i + 1) {
        tokens.push({ kind: "code", value: line.slice(i + 1, close) })
        i = close + 1
        continue
      }
      // No closer → emit the backtick as text and keep scanning.
      tokens.push({ kind: "text", value: "`" })
      i += 1
      continue
    }
    // ── 2. Bold (`**…**`) — checked BEFORE italic so `**` wins ─────
    if (line[i] === "*" && line[i + 1] === "*") {
      const close = line.indexOf("**", i + 2)
      if (close !== -1 && close > i + 2) {
        tokens.push({ kind: "bold", value: line.slice(i + 2, close) })
        i = close + 2
        continue
      }
      // No closer — treat the two asterisks as literal text so the
      // rest of the line still parses for italic / plain runs.
      tokens.push({ kind: "text", value: "**" })
      i += 2
      continue
    }
    // ── 3. Italic (`*…*`) ──────────────────────────────────────────
    if (line[i] === "*") {
      const close = line.indexOf("*", i + 1)
      if (close !== -1 && close > i + 1) {
        tokens.push({ kind: "italic", value: line.slice(i + 1, close) })
        i = close + 1
        continue
      }
      tokens.push({ kind: "text", value: "*" })
      i += 1
      continue
    }
    // ── 4. Plain run up to the next special character ──────────────
    const special = findSpecialIndex(line, i + 1)
    tokens.push({ kind: "text", value: line.slice(i, special) })
    i = special
  }
  return tokens
}

/**
 * Locate the next `` ` `` or `*` starting at `from`. Returns
 * `line.length` when no special character remains, so the caller
 * can take the rest of the line as a plain run.
 */
function findSpecialIndex(line: string, from: number): number {
  for (let i = from; i < line.length; i++) {
    const c = line[i]
    if (c === "`" || c === "*") return i
  }
  return line.length
}

/**
 * Render one inline token. Nested markup is intentionally NOT
 * supported — `**bold *with italic* inside**` will parse as
 * `**bold ` + `*with italic*` + ` inside**`, leaving the trailing
 * ` inside**` as plain text. Keeping the parser single-pass makes
 * the failure modes obvious instead of silently mangling content.
 */
function renderToken(token: InlineToken, key: string) {
  switch (token.kind) {
    case "code":
      return (
        <code
          key={key}
          className="rounded-sm bg-surface-container-high px-1 py-0.5 font-mono text-[12px] text-on-surface"
        >
          {token.value}
        </code>
      )
    case "bold":
      return (
        <strong key={key} className="font-sans font-semibold text-on-surface">
          {token.value}
        </strong>
      )
    case "italic":
      return (
        <em
          key={key}
          className="font-body italic text-on-surface"
        >
          {token.value}
        </em>
      )
    case "text":
      return <span key={key}>{token.value}</span>
  }
}

export function UserMessage({
  message,
  onReturn,
  onEdit,
  onCommit,
  onCopy,
  /**
   * Called when the user clicks the undo/Revert affordance. The
   * parent rewinds the thread state to *just before* this message
   * was sent AND loads the rewound content into the composer
   * textarea — so the user can re-edit and re-send. The message
   * itself is not deleted; its place in history becomes the
   * branch point.
   */
  /**
   * Called when the user clicks the pen icon. The parent uses this as
   * a "user is about to inline-edit" signal — currently informational
   * only, but kept so future affordances (e.g. a "comparing edits"
   * toast) can hook in.
   */
  /**
   * Called when the user presses Save in the inline-edit textarea.
   * The parent truncates everything after this message, writes the
   * new content into the bubble via the chat store, and kicks off a
   * fresh completion request. This component does NOT persist the
   * edit itself — the source of truth is the chat store.
   */
  /**
   * Called when the user clicks the copy affordance. The parent
   * typically just calls `navigator.clipboard.writeText(content)`.
   */
}: {
  message: ChatMessage
  onReturn?: () => void
  onEdit?: () => void
  onCommit?: (newContent: string) => void
  onCopy?: () => void
}) {
  // The action row hosts Copy / Revert / Edit. Copy and Revert gate
  // on their respective callback being provided; the pen icon
  // always renders (the edit state machine is self-contained — see
  // the comment above the pen button for the reasoning). So the
  // row renders when ANY affordance is wired, or when `onCommit` is
  // wired (which the inline-edit Save button needs to actually
  // persist the edit).
  const hasActions = Boolean(onReturn || onCopy || onCommit || onEdit)
  // Local state for inline edit. When the user clicks the pen, the
  // bubble switches to a textarea prefilled with the original text.
  // Enter saves, Esc cancels, clicking outside also saves.
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)

  function startEdit() {
    setDraft(message.content)
    setEditing(true)
    onEdit?.()
  }

  function commit() {
    // No-op when the user hasn't changed the text or the field is
    // empty — a no-op click shouldn't fire the parent's truncation +
    // resend machinery.
    if (!editing) return
    const trimmed = draft.trim()
    setEditing(false)
    if (!trimmed || trimmed === message.content) {
      // Restore the original draft so the next pen-click re-opens
      // with the same content.
      setDraft(message.content)
      return
    }
    // Hand the new content to the parent. The parent truncates the
    // thread after this message and resubmits.
    onCommit?.(trimmed)
  }

  function cancel() {
    setDraft(message.content)
    setEditing(false)
  }
  const dirty =
    editing && draft.trim() !== message.content && draft.trim().length > 0

  return (
    // Per `agent-example-sessions.html` lines 670-700: user turns
    // are right-aligned bordered blocks (no separate "bubble" shape —
    // the border itself is the visual container). Padding-bottom
    // reserves room for the bottom-right Copy + Revert affordances.
    <div className="group/message relative flex min-w-0 max-w-full animate-fade-in flex-col items-end gap-1.5">
      <div
        className="relative flex min-w-0 max-w-full flex-col items-end gap-1 rounded border border-primary/25 bg-primary/5 px-3 pb-7 pt-2"
        style={{ borderRadius: "var(--radius)" }}
      >
        <header className="flex w-full items-center justify-end gap-2 font-sans text-[10px] font-semibold uppercase tracking-[0.06em] text-primary">
          <span className="font-mono text-[10px] tabular-nums text-outline">
            {formatTime(message.ts)}
          </span>
          <span>You</span>
        </header>

        {/* The body. In edit mode we swap the static content for a
            controlled textarea so the user can revise the message
            in place — the composer at the bottom of the thread is
            left untouched, as requested. */}
        {editing ? (
          <div className="flex w-full flex-col gap-1">
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault()
                  cancel()
                }
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault()
                  commit()
                }
              }}
              rows={Math.max(1, Math.min(8, draft.split(/\n/).length || 1))}
              className="w-full resize-none bg-transparent font-body text-[13px] leading-[20px] text-on-surface focus:outline-none"
            />
            <div className="flex items-center justify-between gap-2 border-t border-outline-variant/60 pt-1 font-sans text-[10px] text-outline">
              <span>Esc to cancel · ⌘+Enter to save</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onMouseDown={(e) => {
                    // Use mousedown so we beat the textarea's onBlur
                    // (which would otherwise commit first).
                    e.preventDefault()
                    cancel()
                  }}
                  className="rounded px-1.5 py-0.5 hover:bg-surface-container-high"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    commit()
                  }}
                  className="rounded bg-primary px-1.5 py-0.5 text-on-primary hover:brightness-110 disabled:opacity-40"
                  disabled={!dirty}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="w-full whitespace-pre-wrap break-words text-right font-body text-[13px] leading-[20px] text-on-surface">
            <InlineContent text={message.content} />
          </div>
        )}

        {/* Attachments — shown above the bottom-right actions so the
            previews don't overlap. Right-aligned to match the user-
            turn aesthetic; each chip is its own little block with a
            thumbnail for images and an icon for generic files. */}
        {message.attachments && message.attachments.length > 0 ? (
          <div className="mt-1 flex w-full flex-wrap items-end justify-end gap-1.5">
            {message.attachments.map((a) => (
              <AttachmentChip key={a.id} attachment={a} />
            ))}
          </div>
        ) : null}

        {/* Bottom-right action affordances — Copy + Revert + Edit.
            Per the spec, they appear on hover (`opacity-0` until the
            group is hovered) at the bottom-right corner. They use
            `pointer-events-auto` because the parent group has
            `pointer-events-none` only on the absolutely-positioned
            row (the row itself); the buttons re-enable pointer
            events on themselves. */}
        {hasActions && !editing ? (
          <div className="pointer-events-auto absolute bottom-1 right-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/message:opacity-100">
            {onCopy ? (
              <button
                type="button"
                onClick={onCopy}
                title="Copy message"
                aria-label="Copy message"
                className="flex h-6 w-6 items-center justify-center rounded text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
              >
                <Icon name="copy" size={12} />
              </button>
            ) : null}
            {onReturn ? (
              <button
                type="button"
                onClick={onReturn}
                title="Revert this turn — drop everything after this message"
                aria-label="Revert this turn"
                className="flex h-6 w-6 items-center justify-center rounded text-on-surface-variant hover:bg-surface-container-high hover:text-tertiary"
              >
                <Icon name="undo" size={13} />
              </button>
            ) : null}
            {/*
              The pen icon always renders (regardless of whether the
              parent passed `onEdit` for the informational hook) — the
              internal edit state machine is fully self-contained:
              `startEdit` flips `editing` true, `commit` flushes the
              new content via `onCommit` (which truncates + resends),
              and `cancel` discards. Hiding the icon whenever the
              parent didn't wire the informational hook would mean
              the inline-edit affordance silently disappears, which
              is the bug we're fixing here.
             */}
            <button
              type="button"
              onClick={startEdit}
              title="Edit this message inline"
              aria-label="Edit message"
              className="flex h-6 w-6 items-center justify-center rounded text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
            >
              <Icon name="edit-2" size={12} />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * One attachment chip rendered next to / below a user message.
 *
 * Images preview as a small thumbnail (object-cover so tall / wide
 * images don't blow out the layout). Generic files render as a
 * compact pill with an icon + filename. Both styles cap to a
 * reasonable max dimension so a 5MB screenshot can't push the
 * row wider than the chat surface.
 */
function AttachmentChip({
  attachment,
}: {
  attachment: import("../../chats/ChatStore").Attachment
}) {
  const isImage = attachment.kind === "image"
  const sizeLabel = formatBytes(attachment.size)
  if (isImage) {
    return (
      <a
        href={attachment.dataUrl}
        target="_blank"
        rel="noreferrer"
        className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded border border-outline-variant/60 bg-surface-container-lowest hover:border-primary"
        title={`${attachment.name} · ${sizeLabel}`}
      >
        <img
          src={attachment.dataUrl}
          alt={attachment.name}
          className="h-full w-full object-cover"
        />
      </a>
    )
  }
  return (
    <div
      className="flex max-w-[180px] items-center gap-1.5 rounded border border-outline-variant/60 bg-surface-container-low px-2 py-1"
      title={`${attachment.name} · ${sizeLabel}`}
    >
      <Icon
        name="file"
        size={12}
        className="shrink-0 text-on-surface-variant"
      />
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-body text-[11px] text-on-surface">
          {attachment.name}
        </span>
        <span className="font-sans text-[10px] text-outline">{sizeLabel}</span>
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
