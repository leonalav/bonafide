import { useEffect, useState } from "react"
import { Icon } from "../ui/Icon"
import { ProposalView } from "./ProposalView"
import { Composer, QuickSuggestions } from "./Composer"
import { ROLE_META, type ConversationMessage, type Thread } from "../../data/agents"
import { WorkflowInbox } from "./WorkflowInbox"

export function ThreadDetail({
  thread,
  onBack,
  threads,
  closedCount,
}: {
  thread: Thread
  onBack: () => void
  threads: Thread[]
  closedCount: number
}) {
  // Derive investigation data from the live thread state.
  const investigation = {
    runHash: thread.id,
    goal: thread.title,
    trace: [],
    hypothesis: {
      verdict: thread.state === "awaiting_approval" ? "Likely" : "Pending",
      statement: thread.summary,
      evidence: [],
      confidence: "Low" as const,
    },
    patch: { file: "", summary: thread.detail, lines: [] },
    verification: { status: "none" as const, lines: [] },
  }

  const [messages, setMessages] = useState<ConversationMessage[]>([])

  useEffect(() => {
    // Phase 0: thread messages IPC is not yet wired; render an empty
    // log so the panel no longer relies on the hardcoded CONVERSATION
    // mock. The full message IPC ships in WS5-T3 (Phase 1).
    setMessages([])
  }, [thread.id])

  return (
    <div className="flex h-full min-h-0">
      {/* pushed-left inbox context strip */}
      <div className="w-2/5 shrink-0 overflow-hidden border-r border-outline-variant opacity-60">
        <div className="p-3">
          <WorkflowInbox
            threads={threads}
            onOpen={() => {}}
            closedCount={closedCount}
          />
        </div>
      </div>

      {/* detail */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-outline-variant px-4">
          <button
            onClick={onBack}
            className="text-outline hover:text-on-surface"
            aria-label="Back to inbox"
          >
            <Icon name="chevron-left" size={16} />
          </button>
          <span className="text-[14px] leading-none">
            {ROLE_META[thread.role].glyph}
          </span>
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

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <ProposalView data={investigation} />

          {/* Conversation log */}
          <section className="mt-6 flex flex-col gap-2">
            <span className="label-caps text-on-surface-variant">
              Conversation
            </span>
            <div className="flex flex-col gap-2">
              {messages.length === 0 ? (
                <p className="font-body text-[12px] italic text-outline">
                  No messages yet.
                </p>
              ) : (
                messages.map((m, i) => (
                  <div
                    key={i}
                    className={`rounded border px-3 py-2 ${
                      m.author === "USER"
                        ? "border-primary/25 bg-primary/5"
                        : m.author === "SYSTEM"
                          ? "border-outline-variant/60 bg-surface-container-low"
                          : "border-outline-variant bg-surface-container-low"
                    }`}
                  >
                    <div className="mb-0.5 label-caps text-outline">
                      {m.author}
                    </div>
                    <p
                      className={`font-body text-[12px] leading-[17px] ${
                        m.card
                          ? "italic text-on-surface-variant"
                          : "text-on-surface"
                      }`}
                    >
                      {m.card ? `[ ${m.body} ]` : m.body}
                    </p>
                  </div>
                ))
              )}
            </div>
            <div className="mt-1 flex flex-col gap-3">
              <QuickSuggestions
                items={[
                  "Reference run 47 in your response",
                  "Compare with the proposal from 2h ago",
                  "Explain in plain terms",
                ]}
                onPick={() => {}}
              />
              <Composer />
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
