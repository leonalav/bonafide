import { useEffect, useState } from "react"

import { Icon } from "../ui/Icon"

import { Button } from "../ui/primitives"

import { TEMPLATES } from "../../llm/templates"

import { bonafide } from "../../ipc/tauri"

import { useWorkspaceRoot } from "../../ide/hooks"

import { WorkflowInbox } from "./WorkflowInbox"

import { ThreadDetail } from "./ThreadDetail"

import { ROLE_META, type Thread } from "../../data/agents"

import { useThreads } from "../../data/threads"

function Templates() {
  return (
    <div className="flex flex-col gap-2">
      {TEMPLATES.map((tpl, i) => {
        const role = ROLE_META[tpl.role]

        return (
          <div
            key={i}
            className={`flex items-start gap-3 rounded-lg border p-3 ${
              tpl.soon
                ? "border-outline-variant/60 bg-surface-container-low/50"
                : "border-outline-variant bg-surface-container-low hover:border-outline"
            }`}
          >
            <span className="mt-0.5 text-[15px] leading-none">
              {role.glyph}
            </span>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="font-body text-[13px] font-medium text-on-surface">
                  {tpl.role} — {tpl.title}
                </span>
                {tpl.isDefault && (
                  <span className="rounded bg-primary/15 px-1.5 py-0.5 font-sans text-[10px] text-primary">
                    Default
                  </span>
                )}
                {tpl.soon && (
                  <span className="flex items-center gap-1 rounded bg-outline/15 px-1.5 py-0.5 font-sans text-[10px] text-outline">
                    <Icon name="lock" size={9} /> coming soon
                  </span>
                )}
                {tpl.emptyOnly && (
                  <span className="font-sans text-[10px] text-outline">
                    empty workspaces
                  </span>
                )}
              </div>
              <p className="mt-0.5 font-body text-[12px] text-on-surface-variant">
                {tpl.desc}
              </p>
            </div>
            <Button
              variant={tpl.soon ? "ghost" : "secondary"}
              size="sm"
              disabled={tpl.soon}
            >
              {tpl.soon ? "Preview" : "Use"}
            </Button>
          </div>
        )
      })}
    </div>
  )
}

export function WorkflowPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"inbox" | "templates">("inbox")

  const [open, setOpen] = useState<Thread | null>(null)

  // Live source: list_threads Tauri command when a workspace is open,
  // static mock otherwise (so the preview keeps working).
  const workspaceRoot = useWorkspaceRoot()

  const { threads } = useThreads(workspaceRoot)

  // Derive closed-thread count from real IPC. Falls back to 0 when
  // the backend is unavailable (browser preview) so the panel keeps
  // rendering.
  const [closedCount, setClosedCount] = useState(0)
  useEffect(() => {
    bonafide.agent
      .listThreads(workspaceRoot ?? "")
      .then((rows) => {
        setClosedCount(
          rows.filter(
            (t) => t.state === "resolved" || t.state === "stopped",
          ).length,
        )
      })
      .catch(() => setClosedCount(0))
  }, [workspaceRoot])

  return (
    <aside className="flex h-full w-full flex-col bg-surface">
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-outline-variant px-4">
        <div className="flex items-center gap-2">
          <Icon name="arrow-right-left" size={14} className="text-primary" />
          <span className="label-caps text-on-surface-variant">Workflow</span>
        </div>
        <div className="flex items-center gap-3 text-outline">
          <span className="font-sans text-[11px]">⌘K to focus</span>
          <button
            onClick={onClose}
            aria-label="Close workflow panel"
            className="hover:text-on-surface"
          >
            <Icon name="x" size={15} />
          </button>
        </div>
      </div>

      {open ? (
        <ThreadDetail
          thread={open}
          threads={threads}
          closedCount={closedCount}
          onBack={() => setOpen(null)}
        />
      ) : (
        <>
          {/* Tabs + actions */}
          <div className="flex h-11 shrink-0 items-center gap-1 border-b border-outline-variant px-3">
            {(["inbox", "templates"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`relative h-7 rounded px-3 font-sans text-[13px] capitalize transition-colors ${
                  tab === t
                    ? "bg-surface-container-high text-on-surface"
                    : "text-on-surface-variant hover:text-on-surface"
                }`}
              >
                {t}
              </button>
            ))}
            <div className="flex-1" />
            <Button size="sm">
              <Icon name="plus" size={13} /> New thread
            </Button>
            <button
              className="flex h-7 w-7 items-center justify-center rounded text-outline hover:bg-surface-container hover:text-on-surface"
              aria-label="More"
            >
              <Icon name="more-vertical" size={15} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {tab === "inbox" ? (
              <WorkflowInbox
                threads={threads}
                onOpen={setOpen}
                closedCount={closedCount}
              />
            ) : (
              <Templates />
            )}
          </div>
        </>
      )}
    </aside>
  )
}
