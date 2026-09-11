import { useState } from "react"

import { Icon } from "../ui/Icon"

import { Button, StatusDot } from "../ui/primitives"

import { ProposalView } from "./ProposalView"

import { Composer, QuickSuggestions } from "./Composer"

import { useWorkspaceRoot } from "../../ide/hooks"

import {
  CLOSED_COUNT,
  CONVERSATION,
  ROLE_META,
  TEMPLATES,
  THREAD_STATE_META,
  type Thread,
} from "../../data/agents"

import { useThreads } from "../../data/threads"

const BANDS: { key: Thread["band"] label: string }[] = [
  { key: "active", label: "Active" },

  { key: "awaiting_review", label: "Awaiting review" },

  { key: "closed", label: "Closed" },
]

function ThreadCard({ t, onOpen }: { t: Thread onOpen: () => void }) {
  const meta = THREAD_STATE_META[t.state]

  const role = ROLE_META[t.role]

  return (
    <button
      onClick={onOpen}
      className="flex w-full flex-col gap-1.5 rounded-lg border border-outline-variant bg-surface-container-low p-3 text-left transition-colors hover:border-outline hover:bg-surface-container"
    >
      <div className="flex items-center gap-2">
        <span className="text-[15px] leading-none">{role.glyph}</span>
        <span className="flex-1 truncate font-body text-[13px] font-medium text-on-surface">
          {t.title}
        </span>
        <span className="shrink-0 font-sans text-[11px] text-outline">
          {t.role} · {t.time}
        </span>
      </div>
      <p className="font-body text-[12px] leading-[17px] text-on-surface-variant">
        {t.summary}
      </p>
      <div className="flex items-center gap-2">
        <StatusDot token={meta.token} pulse={meta.pulse} size={7} />
        <span className="font-sans text-[12px] text-on-surface-variant">
          {meta.label}
        </span>
        {t.system && (
          <span className="rounded bg-outline/15 px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-wide text-outline">
            System
          </span>
        )}
        <span className="ml-auto font-sans text-[11px] text-outline">
          {t.detail}
        </span>
      </div>
    </button>
  )
}

function Inbox({
  threads,
  onOpen,
}: {
  threads: Thread[]
  onOpen: (t: Thread) => void
}) {
  const [showClosed, setShowClosed] = useState(false)

  return (
    <div className="flex flex-col gap-5">
      {BANDS.map((band) => {
        const rows = threads.filter((t) => t.band === band.key)

        if (band.key === "closed") {
          return (
            <section key={band.key} className="flex flex-col gap-2">
              <SectionBand label="Closed" count={CLOSED_COUNT} />
              {showClosed ? (
                rows.map((t) => (
                  <ThreadCard key={t.id} t={t} onOpen={() => onOpen(t)} />
                ))
              ) : (
                <button
                  onClick={() => setShowClosed(true)}
                  className="flex items-center gap-1.5 px-1 font-sans text-[12px] text-outline hover:text-on-surface"
                >
                  <Icon name="chevron-down" size={13} /> Show {CLOSED_COUNT}{" "}
                  closed threads
                </button>
              )}
            </section>
          )
        }

        if (!rows.length) return null

        return (
          <section key={band.key} className="flex flex-col gap-2">
            <SectionBand label={band.label} count={rows.length} />
            {rows.map((t) => (
              <ThreadCard key={t.id} t={t} onOpen={() => onOpen(t)} />
            ))}
          </section>
        )
      })}
    </div>
  )
}

function SectionBand({ label, count }: { label: string count: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="label-caps text-on-surface-variant">{label}</span>
      <span className="font-sans text-[11px] text-outline">({count})</span>
      <span className="h-px flex-1 bg-outline-variant/50" />
    </div>
  )
}

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

function ThreadDetail({
  thread,
  onBack,
  threads,
}: {
  thread: Thread
  onBack: () => void
  threads: Thread[]
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

  return (
    <div className="flex h-full min-h-0">
      {/* pushed-left inbox context strip */}
      <div className="w-2/5 shrink-0 overflow-hidden border-r border-outline-variant opacity-60">
        <div className="p-3">
          <Inbox threads={threads} onOpen={() => {}} />
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
              {CONVERSATION.map((m, i) => (
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
              ))}
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

export function WorkflowPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"inbox" | "templates">("inbox")

  const [open, setOpen] = useState<Thread | null>(null)

  // Live source: list_threads Tauri command when a workspace is open,

  // static mock otherwise (so the preview keeps working).

  const workspaceRoot = useWorkspaceRoot()

  const { threads } = useThreads(workspaceRoot)

  return (
    <aside className="flex w-[640px] max-w-[70vw] shrink-0 animate-card-in flex-col border-l border-outline-variant bg-surface">
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
              <Inbox threads={threads} onOpen={setOpen} />
            ) : (
              <Templates />
            )}
          </div>
        </>
      )}
    </aside>
  )
}
