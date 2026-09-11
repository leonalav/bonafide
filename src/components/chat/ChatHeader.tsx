/**
 * chat/ChatHeader.tsx — Compact header at the top of the chat surface.
 *
 * Renders:
 *   - Row 1: editable thread title (left) + Thread dropdown + New pill (right)
 *   - Row 2: mode · endpoint/model · relative-time · Stop (only when sending)
 *
 * The dropdown trigger recomputes its anchor rect on resize/scroll so
 * it stays pinned to the button. Backdrop + Escape both close.
 */

import { useEffect, useRef, useState } from "react"
import { Icon } from "../ui/Icon"
import type { ChatThread } from "../../chats/ChatStore"
import { useChatsStore } from "../../chats/ChatStoreProvider"
import { useModelsStore } from "../../modelsStore"
import { InlineTitleEditor } from "./InlineTitleEditor"
import { NewChatButton } from "./NewChatButton"
import { ThreadList } from "./ThreadList"

// REVIEW(opus) FINDING 6 [medium]: prior `Record<ChatThread["mode"], string>`
// only covered "debug" + "scaffold". Threads in deferred modes rendered
// blank. The widened `ChatThread.mode` union now includes all five
// modes; we map every one.
const MODE_LABEL: Record<string, string> = {
  debug: "Debug",
  scaffold: "Scaffold",
  plan: "Plan",
  research: "Research",
  multitask: "Multitask",
}

function modelLabel(
  thread: ChatThread,
  selectedEndpoint: ReturnType<typeof useModelsStore>["selectedEndpoint"],
): string {
  if (selectedEndpoint && thread.endpointId === selectedEndpoint.id) {
    return selectedEndpoint.label
  }
  // REVIEW(opus) FINDING 1 [high]: if the stored mode string is
  // unexpected (corrupt localStorage or future extension), fall back
  // to the raw mode string rather than rendering blank.
  return thread.model
}

export function ChatHeader({
  thread,
  onCancel,
}: {
  thread: ChatThread
  onCancel?: () => void
}) {
  const { renameThread } = useChatsStore()
  const { selectedEndpoint } = useModelsStore()

  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)

  // Refresh anchor on resize / scroll while the menu is open so it
  // stays glued to the trigger. REVIEW(opus) FINDING 4 [medium]: we
  // compute the anchor unconditionally in the effect (not gated on
  // `menuOpen`) so a React 18 state batch cannot cause the popover
  // to briefly render at a stale position when opening.
  useEffect(() => {
    if (!triggerRef.current) return
    setAnchor(triggerRef.current.getBoundingClientRect())
    function refresh() {
      if (!triggerRef.current) return
      setAnchor(triggerRef.current.getBoundingClientRect())
    }
    window.addEventListener("resize", refresh)
    window.addEventListener("scroll", refresh, true)
    return () => {
      window.removeEventListener("resize", refresh)
      window.removeEventListener("scroll", refresh, true)
    }
  }, [menuOpen])

  const isSending = thread.status === "sending"

  return (
    <header className="shrink-0 border-b border-outline-variant bg-surface-container-low px-3 py-2">
      <div className="flex items-center gap-2">
        <InlineTitleEditor
          value={thread.title}
          onCommit={(t) => renameThread(thread.id, t)}
          placeholder="New chat"
          className="font-body text-[14px] font-medium"
        />
        <div className="flex items-center gap-1">
          <button
            ref={triggerRef}
            onClick={() => {
              // REVIEW(opus) FINDING 10 [low]: only compute and store the
              // anchor when opening. If `menuOpen` is already true, the
              // popover will unmount immediately and storing a fresh anchor
              // would cause a brief render at the old position before
              // unmount — so we skip it.
              if (!menuOpen) {
                setAnchor(triggerRef.current?.getBoundingClientRect() ?? null)
              }
              setMenuOpen((v) => !v)
            }}
            className="flex h-7 items-center gap-1 rounded border border-outline-variant px-2 font-sans text-[12px] text-on-surface-variant hover:border-outline hover:bg-surface-container hover:text-on-surface"
            title="Switch thread"
            aria-expanded={menuOpen}
          >
            <Icon name="layers" size={12} />
            Thread
            <Icon name="chevron-down" size={11} className="text-outline" />
          </button>
          <NewChatButton />
        </div>
      </div>

      <div className="mt-1.5 flex items-center gap-2 font-sans text-[11px] text-outline">
        <span>{MODE_LABEL[thread.mode]}</span>
        <span>·</span>
        <span className="min-w-0 truncate text-on-surface-variant">
          {modelLabel(thread, selectedEndpoint)}
        </span>
        <span>·</span>
        <span>
          {new Date(thread.updatedAt).toLocaleString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })}
        </span>

        <div className="flex-1" />

        {isSending ? (
          <button
            onClick={onCancel}
            className="flex items-center gap-1 rounded px-1.5 font-sans text-[11px] text-outline hover:text-error"
            title="Stop the in-flight request"
          >
            <Icon name="stop-circle" size={12} />
            Stop
          </button>
        ) : null}
      </div>

      {menuOpen ? (
        <ThreadList anchor={anchor} onClose={() => setMenuOpen(false)} />
      ) : null}
    </header>
  )
}
