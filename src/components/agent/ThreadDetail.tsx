import { Icon } from "../ui/Icon"
import { Composer } from "./Composer"
import { ROLE_META, THREAD_STATE_META, type Thread } from "../../data/agents"
import { WorkflowInbox } from "./WorkflowInbox"

export function ThreadDetail({
  thread,
  onBack,
  threads,
}: {
  thread: Thread
  onBack: () => void
  threads: Thread[]
}) {
  const role = ROLE_META[thread.role]
  const stateMeta = THREAD_STATE_META[thread.state]

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Thread header */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-outline-variant px-4">
        <button
          onClick={onBack}
          className="text-outline hover:text-on-surface"
          aria-label="Back to inbox"
        >
          <Icon name="chevron-left" size={16} />
        </button>
        <span className="text-[15px] leading-none">{role.glyph}</span>
        <span className="flex-1 truncate font-body text-[14px] font-medium text-on-surface">
          {thread.title}
        </span>
        <button
          className="flex items-center gap-1 font-sans text-[12px] text-outline hover:text-error"
          title="Stop investigation"
        >
          <Icon name="stop-circle" size={13} /> Stop
        </button>
      </div>

      {/* Inbox context strip + thread detail */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Inbox sidebar */}
        <div className="w-2/5 shrink-0 overflow-y-auto border-r border-outline-variant bg-surface-container-low">
          <div className="p-3">
            <WorkflowInbox threads={threads} onOpen={() => {}} />
          </div>
        </div>

        {/* Thread detail */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Thread summary card */}
          <div className="border-b border-outline-variant p-4">
            <div className="flex items-center gap-2">
              <StatusDot
                token={stateMeta.token}
                pulse={stateMeta.pulse}
                size={7}
              />
              <span className="label-caps text-on-surface-variant">
                {stateMeta.label}
              </span>
            </div>
            <p className="mt-2 font-body text-[13px] text-on-surface">
              {thread.summary}
            </p>
            <div className="mt-1.5 flex items-center gap-3 font-sans text-[12px] text-outline">
              <span>{thread.detail}</span>
              <span>·</span>
              <span>{thread.time}</span>
            </div>
          </div>

          {/* Composer — workspaceRoot is injected by the parent WorkflowPanel */}
          <div className="mt-auto border-t border-outline-variant p-4">
            <Composer workspaceRoot={null} mode={thread.role} />
          </div>
        </div>
      </div>
    </div>
  )
}

// Inline minimal status dot — avoids importing from ui/primitives for one token
function StatusDot({
  token,
  pulse,
  size,
}: {
  token: "primary" | "tertiary" | "error" | "outline"
  pulse?: boolean
  size: number
}) {
  const color =
    token === "primary"
      ? "bg-primary"
      : token === "tertiary"
        ? "bg-tertiary"
        : token === "error"
          ? "bg-error"
          : "bg-outline"
  return (
    <span
      className={`inline-block rounded-full ${color} ${pulse ? "animate-pulse" : ""}`}
      style={{ width: size, height: size }}
    />
  )
}
