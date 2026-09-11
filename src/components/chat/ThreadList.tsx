/**
 * chat/ThreadList.tsx — Popover listing all chat threads.
 *
 * Groups threads by recency (Today / Yesterday / Earlier this week /
 * Older). Each row shows the title + a 1-line preview of the last
 * message + relative timestamp. Hover reveals a trash icon that
 * deletes the thread with a 3-second confirm window.
 *
 * Accessibility: the popover has `role="dialog"`, the scroll
 * container has `role="listbox"`, and each row has
 * `role="option"` with `aria-selected`.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { Icon } from "../ui/Icon"
import type { ChatThread } from "../../chats/ChatStore"
import { useChatsStore } from "../../chats/ChatStoreProvider"
import { Popover } from "./Popover"

// ── Time grouping helpers ────────────────────────────────────────────────────

type Group = { label: string threads: ChatThread[] }

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function groupThreads(threads: ChatThread[]): Group[] {
  const now = Date.now()
  const todayStart = startOfDay(now)
  const yesterdayStart = todayStart - 86_400_000
  const weekStart = todayStart - 7 * 86_400_000

  const buckets: { label: string min: number items: ChatThread[] }[] = [
    { label: "Today", min: todayStart, items: [] },
    { label: "Yesterday", min: yesterdayStart, items: [] },
    { label: "Earlier this week", min: weekStart, items: [] },
    { label: "Older", min: 0, items: [] },
  ]

  const sorted = [...threads].sort((a, b) => b.updatedAt - a.updatedAt)
  for (const t of sorted) {
    const ts = t.updatedAt
    const bucket =
      ts >= todayStart
        ? buckets[0]!
        : ts >= yesterdayStart
          ? buckets[1]!
          : ts >= weekStart
            ? buckets[2]!
            : buckets[3]!
    bucket.items.push(t)
  }

  return buckets
    .filter((b) => b.items.length > 0)
    .map((b) => ({ label: b.label, threads: b.items }))
}

function previewFor(thread: ChatThread): string {
  for (let i = thread.messages.length - 1; i >= 0; i -= 1) {
    const m = thread.messages[i]!
    const text = m.content.trim().split(/\r?\n/)[0] ?? ""
    if (text) {
      return text.length > 80 ? `${text.slice(0, 80)}…` : text
    }
  }
  return "Empty thread"
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return "just now"
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  if (days < 7) return `${days}d ago`
  return new Date(ts).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  })
}

// ── ThreadList ───────────────────────────────────────────────────────────────

export function ThreadList({
  anchor,
  onClose,
}: {
  anchor: DOMRect | null
  onClose: () => void
}) {
  const { threads, activeThread, setActiveThread, deleteThread } =
    useChatsStore()
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const confirmTimerRef = useRef<number | null>(null)

  // REVIEW(opus) F-16 [final medium]: cancel any pending confirmation
  // timeout when the popover closes / unmounts so we don't fire
  // setConfirmDelete against a dead component.
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current !== null) {
        window.clearTimeout(confirmTimerRef.current)
        confirmTimerRef.current = null
      }
    }
  }, [])

  const groups = useMemo(() => groupThreads(threads), [threads])

  return (
    <Popover anchor={anchor} width={360} height={420} onClose={onClose}>
      {/*
        REVIEW(opus) FINDING 3 [medium]: onMouseDown fires before onClick
        in the React event model. Without stopPropagation here, the
        backdrop's onClick would fire on every click inside the list,
        immediately closing the popover. This is the same pattern used
        in Composer.tsx's ModeRow / ModelRow.
      */}
      <div
        className="flex max-h-[400px] flex-col"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Chat threads"
      >
        <div className="flex items-center justify-between px-2 pb-2 pt-1">
          <span className="label-caps text-on-surface-variant">
            Threads ({threads.length})
          </span>
        </div>

        <div
          role="listbox"
          aria-label="Thread list"
          className="flex max-h-[360px] flex-col gap-2 overflow-y-auto pr-1"
        >
          {groups.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
              <p className="font-body text-[12px] text-outline">
                No threads yet. Start a conversation.
              </p>
            </div>
          ) : (
            groups.map((g) => (
              <section
                key={g.label}
                role="group"
                aria-label={g.label}
                className="flex flex-col gap-1"
              >
                <div className="flex items-center gap-2 px-2 pt-1">
                  <span className="label-caps text-outline">{g.label}</span>
                  <span className="font-sans text-[10px] text-outline">
                    ({g.threads.length})
                  </span>
                  <span className="h-px flex-1 bg-outline-variant/40" />
                </div>

                {g.threads.map((t) => {
                  const isActive = activeThread?.id === t.id
                  const isConfirming = confirmDelete === t.id
                  return (
                    <div
                      key={t.id}
                      role="option"
                      aria-selected={isActive}
                      className={`group relative flex items-start gap-2 rounded px-2 py-1.5 ${
                        isActive
                          ? "bg-surface-container-high"
                          : "hover:bg-surface-container-high"
                      }`}
                    >
                      {isActive ? (
                        <span className="absolute inset-y-0 left-0 w-[3px] rounded-full bg-primary" />
                      ) : null}

                      <button
                        ref={isActive ? triggerRef : null}
                        onClick={() => {
                          setActiveThread(t.id)
                          onClose()
                        }}
                        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
                      >
                        <span
                          className={`truncate font-body text-[13px] ${
                            isActive
                              ? "font-medium text-on-surface"
                              : "text-on-surface"
                          }`}
                        >
                          {t.title}
                        </span>
                        <span className="truncate font-sans text-[11px] text-outline">
                          {previewFor(t)}
                        </span>
                      </button>

                      <span className="shrink-0 self-center font-sans text-[10px] text-outline">
                        {relativeTime(t.updatedAt)}
                      </span>

                      {/* Delete button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          if (isConfirming) {
                            deleteThread(t.id)
                            setConfirmDelete(null)
                            if (confirmTimerRef.current !== null) {
                              window.clearTimeout(confirmTimerRef.current)
                              confirmTimerRef.current = null
                            }
                          } else {
                            setConfirmDelete(t.id)
                            // REVIEW(opus) FINDING 12 [low]: the for-loop
                            // uses `let` (block-scoped), so `t.id` is correct
                            // per iteration. Do not refactor to .forEach/.map
                            // without wrapping in an IIFE.
                            const capturedId = t.id
                            // Clear any prior timer before starting a new one.
                            if (confirmTimerRef.current !== null)
                              window.clearTimeout(confirmTimerRef.current)
                            confirmTimerRef.current = window.setTimeout(() => {
                              setConfirmDelete((c) =>
                                c === capturedId ? null : c,
                              )
                              confirmTimerRef.current = null
                            }, 3000)
                          }
                        }}
                        title={
                          isConfirming ? "Click again to confirm" : "Delete"
                        }
                        aria-label={isConfirming ? "Confirm delete" : "Delete"}
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors ${
                          isConfirming
                            ? "bg-error/15 text-error"
                            : "text-outline opacity-0 hover:bg-error/10 hover:text-error group-hover:opacity-100"
                        }`}
                      >
                        <Icon
                          name={isConfirming ? "check" : "trash-2"}
                          size={12}
                        />
                      </button>
                    </div>
                  )
                })}
              </section>
            ))
          )}
        </div>
      </div>
    </Popover>
  )
}
