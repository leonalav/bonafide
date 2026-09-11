/**
 * chat/InlineTitleEditor.tsx — Click-to-edit thread title.
 *
 * Renders the title as a `<span>` until the user clicks it, at which
 * point it switches to an `<input>` and autofocuses. Commits on
 * Enter or blur; reverts to the original value on Escape.
 *
 * Phase 1 deliberately does no client-side length validation — the
 * store rejects empty titles (`renameThread` requires non-empty
 * trimmed input) and we disable Save when the trimmed value equals
 * the original. The "Save" affordance is implicit (blur = save),
 * matching VS Code Copilot and Cursor pattern.
 */

import { useEffect, useRef, useState } from "react"
import { Icon } from "../ui/Icon"

export function InlineTitleEditor({
  value,
  onCommit,
  placeholder = "Untitled",
  showEditIcon = true,
  className = "",
}: {
  value: string
  onCommit: (next: string) => void
  placeholder?: string
  showEditIcon?: boolean
  className?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Keep the draft in sync if the upstream value changes while not
  // editing (e.g. another tab renamed this thread).
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  // Autofocus + select-all on edit start.
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  function commit() {
    const trimmed = draft.trim()
    // REVIEW(opus) F-30 [final polish]: don't fire onCommit when the
    // trimmed value is empty — the store rejects empty titles anyway,
    // but we'd otherwise write a no-op that triggers subscribers and
    // a localStorage write. Revert to the previous value instead.
    if (!trimmed) {
      cancel()
      return
    }
    if (trimmed !== value) onCommit(trimmed)
    else setDraft(value) // revert on no-op
    setEditing(false)
  }

  function cancel() {
    setDraft(value)
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commit()
          } else if (e.key === "Escape") {
            e.preventDefault()
            cancel()
          }
        }}
        placeholder={placeholder}
        className={`min-w-0 flex-1 rounded border border-primary bg-surface px-1.5 py-0.5 font-body text-[14px] font-medium text-on-surface outline-none ring-2 ring-primary/25 ${className}`}
        aria-label="Thread title"
      />
    )
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className={`group flex min-w-0 max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-left font-body text-[14px] font-medium text-on-surface hover:bg-surface-container ${className}`}
      title="Click to rename"
    >
      <span className={`truncate ${value ? "" : "italic text-outline"}`}>
        {value || placeholder}
      </span>
      {showEditIcon ? (
        <span
          className="shrink-0 text-outline opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden="true"
        >
          <Icon name="edit-2" size={11} />
        </span>
      ) : null}
    </button>
  )
}
