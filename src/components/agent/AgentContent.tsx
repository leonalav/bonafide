/**
 * AgentContent.tsx — Entry point for the Inspector Agent tab.
 *
 * Routes between three sub-views:
 *
 *   WelcomePanel  — the initial empty state. Quick suggestions fill the
 *                   composer and submit; "Scaffold" opens the Workflow.
 *
 *   ChatSurface   — the new chat surface. First message creates a thread
 *                   and dismisses the welcome. Thread persists to localStorage.
 *
 *   RunSurface    — the existing run-investigation surface (ProposalView +
 *                   ProposalView + Workflow). Unchanged from the original
 *                   `AgentContent`; only the file location moved here so
 *                   the new routing logic stays in one component.
 *
 * `run` prop comes from Inspector.tsx — the Inspector tab is the only
 * place that provides it. When `run` is null (no run selected), we
 * render the chat surface.
 */

import { useEffect, useRef, useState } from "react"

import { Icon } from "../ui/Icon"

import { StatusDot } from "../ui/primitives"

import { ProposalView } from "./ProposalView"

import { Composer, QuickSuggestions } from "./Composer"

import type { Run } from "../../data/runs"

import type { Investigation } from "../../data/agents"

import { useChatsStore } from "../../chats/ChatStoreProvider"

import {
  chatsStore,
  resolveSendTarget,
  type Attachment,
  type ChatMessage,
} from "../../chats/ChatStore"

import { useModelsStore, type ModelFamily } from "../../modelsStore"

import { buildApiChatMessage, chatCompletion } from "../../llm/client"

import { buildSystemPrompt } from "../../llm/systemPrompt"

import type { ApiChatMessage } from "../../llm/types"

import { ChatHeader } from "../chat/ChatHeader"

import { ChatThread, type ChatThreadHandle } from "../chat/ChatThread"

import type { ModeId } from "../../chats/types"

// ── Types ────────────────────────────────────────────────────────────────────

interface AgentContentProps {
  /** When provided, renders the run-investigation surface. */

  run?: Run | null

  onOpenWorkflow?: () => void
}

// ── WelcomePanel ────────────────────────────────────────────────────────────────

const WELCOME_SUGGESTIONS = [
  "Debug a run divergence",

  "Compare two runs",

  "Scaffold a new project",

  "Sequence experiment plan",

  "Cross-reference papers",
]

function WelcomePanel({
  onStartChat,

  onOpenWorkflow,
}: {
  onStartChat: (text: string, attachments: Attachment[]) => void

  onOpenWorkflow?: () => void
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 max-w-full flex-col gap-5 overflow-hidden">
      {/* Welcome header */}
      <div className="shrink-0 flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <StatusDot token="tertiary" />
          <span className="font-sans text-[13px] font-medium text-on-surface">
            Agent
          </span>
        </div>
        <p className="font-body text-[12px] leading-[18px] text-on-surface-variant">
          Chat with an AI agent about your runs, code, and experiments. Pick a
          run in the sidebar to start an investigation, or use the composer
          below.
        </p>
      </div>

      <QuickSuggestions
        items={WELCOME_SUGGESTIONS}
        onPick={(t) => {
          if (t === "Scaffold a new project") onOpenWorkflow?.()
          else onStartChat(t, [])
        }}
      />

      <div className="flex-1" />

      <Composer
        onSubmit={onStartChat}
        onCancel={undefined}
        mode="debug"
        builtinId="fable"
        onModeChange={() => {}}
        onBuiltinChange={() => {}}
      />
    </div>
  )
}

// ── ChatSurface ────────────────────────────────────────────────────────────────

/**
 * The live chat surface. Manages the send/abort flow and wires Composer
 * to the chat store. Does NOT render the welcome panel — that's the
 * parent's job.
 */

function ChatSurface({ onOpenWorkflow }: { onOpenWorkflow?: () => void }) {
  const {
    activeThread,

    createThread,

    appendMessage,

    updateMessage,

    editMessage,

    truncateAfter,

    abortSend,

    tryBeginSend,

    finishSend,

    getAbortSignal,
  } = useChatsStore()

  const { selectedEndpoint, config } = useModelsStore()

  // Current mode and built-in model selection. Lifted here so we can

  // pass them to createThread at submit time. Composer calls onModeChange

  // whenever the user changes the picker.

  const [mode, setMode] = useState<ModeId>("debug")

  // Use the broader ModelFamily type because the parent's controlled

  // built-in callback passes the full union, not just our three names.

  const [builtinId, setBuiltinId] = useState<ModelFamily>("fable")

  /**
   * Seed for the Composer textarea when the user clicks the
   * Return / Rewind affordance on a prior user message.
   *
   * We store the rewound content alongside a monotonic key so the
   * Composer effect fires even when the user rewinds to the same
   * message twice in a row (React would otherwise bail out of the
   * `useEffect` because the `seedText` value is unchanged).
   */

  const [rewindSeed, setRewindSeed] = useState<{
    text: string

    key: number
  } | null>(null)

  /**
   * Confirmation dialog state. Per `agent-example-sessions.html`
   * lines 770-840, clicking the Revert affordance on a user bubble
   * opens a warning dialog (NOT an immediate action) listing what
   * would be dropped. We store the anchor message id here so we
   * can re-resolve the thread at confirm time and don't depend on
   * the user keeping the bubble visible.
   */

  const [pendingReturnMessageId, setPendingReturnMessageId] =
    useState<string | null>(null)

  // Imperative ref to the ChatThread so other surfaces can request a

  // scroll-to-message (currently a no-op outside the ChatThread's own

  // Return handlers, but kept for future cross-component navigation).

  const threadRef = useRef<ChatThreadHandle | null>(null)

  // Resolve the effective model string: prefer the custom endpoint's

  // defaultModel; fall back to the built-in selection.

  const effectiveModel = selectedEndpoint
    ? selectedEndpoint.defaultModel
    : builtinId

  /**
   * Rewind the thread to a given message and re-run the completion.
   *
   * Used by both the user-bubble Return affordance ("regenerate from
   * this point") and the inline-edit Save affordance (which calls
   * `truncateAfter` first, then this).
   *
   * Steps:
   *   1. Abort any in-flight request so a late .then() can't write
   *      into a truncated thread.
   * The Rewind handler (per spec from the user):
   *   1. Abort any in-flight request so a late .then() can't write
   *      into a truncated thread.
   *   2. Truncate everything after the target message via the store
   *      (persists to localStorage automatically).
   *   3. Load the surviving user message's content into the
   *      composer textarea so the user can re-edit + resend
   *      manually. We DO NOT auto-resend — the spec is explicit
   *      that the rewound content goes "straight to the text box
   *      of the chat box", not into the request pipeline.
   *
   * The Edit-Save flow (`handleCommitMessage`) uses the same
   * mechanics but additionally writes the new content into the
   * bubble before truncating, then auto-resends because the user
   * explicitly asked to save an edit.
   */

  function rewindToComposer(message: ChatMessage) {
    // Resolve the thread id from the anchor message itself rather

    // than trusting the caller (which used to pass `m.id` as the

    // thread id and silently bail on the next guard — the root

    // cause of the Return button never working).

    const thread = chatsStore.getThreadByMessageId(message.id)

    if (!thread) return

    const threadId = thread.id

    // Cancel any in-flight request for this thread BEFORE

    // truncating so the late .then() can't append a partial

    // assistant message into the now-shortened thread.

    abortSend(threadId)

    // Drop everything after this message. `truncateAfter` slices

    // to `messages[0..idx+1]`, so the target message survives —

    // exactly what we want, since the user's text becomes the

    // pre-fill for the composer.

    truncateAfter(threadId, message.id)

    // Read the freshly-truncated thread from the store (the React

    // re-render from `truncateAfter` runs on the next microtask,

    // so `activeThread` here would still reflect the

    // pre-truncation state).

    const refreshed = chatsStore.getThread(threadId)

    if (!refreshed) return

    const anchor = refreshed.messages.find((m) => m.id === message.id)

    if (!anchor) return

    // Bump resetKey alongside seedText so the composer effect fires

    // even when the user rewinds to the same message twice in a row.

    setRewindSeed({ text: anchor.content, key: Date.now() })

    // Close any confirmation dialog the user might have open.

    setPendingReturnMessageId(null)
  }

  /** Open the Revert confirmation dialog for the given user message. */

  function handleReturnMessage(message: ChatMessage) {
    if (message.role !== "user") return

    setPendingReturnMessageId(message.id)
  }

  /** Confirm the rewind: truncate + seed composer. */

  function confirmReturnMessage() {
    const id = pendingReturnMessageId

    if (!id) return

    const message = activeThread?.messages.find((m) => m.id === id)

    if (!message) return

    rewindToComposer(message)
  }

  /** Dismiss the dialog without action. */

  function cancelReturnMessage() {
    setPendingReturnMessageId(null)
  }

  /**
   * Inline-edit Save handler:
   *   1. Persist the new content into the bubble via `editMessage`.
   *   2. Truncate everything after it (kills the assistant reply +
   *      any follow-ups).
   *   3. Re-run completion from the edited message.
   */

  function handleCommitMessage(message: ChatMessage, newContent: string) {
    if (message.role !== "user") return

    if (!activeThread) return

    abortSend(activeThread.id)

    editMessage(activeThread.id, message.id, newContent)

    truncateAfter(activeThread.id, message.id)

    const refreshed = chatsStore.getThread(activeThread.id)

    if (!refreshed) return

    sendMessage(refreshed)
  }

  function sendMessage(thread: NonNullable<typeof activeThread>) {
    // REVIEW(opus) FINDING 1 [critical]: prior code closed over

    // `activeThread` from the render where the user clicked Send.

    // That value was stale for the *first* message because

    // `createThread` updates `_config.activeThreadId` inside the

    // store and the React re-render only fires on the next microtask.

    // We now require the caller to pass the thread directly so the

    // send path always operates on a fresh reference.

    if (!tryBeginSend(thread.id)) return

    const threadId = thread.id

    // REVIEW(opus) F-15 [final]: pass the live endpoints list so

    // resolveSendTarget can honour the thread's stored endpointId

    // (thread reproducibility across preference changes).

    const { endpoint, model } = resolveSendTarget(
      thread,

      selectedEndpoint,

      config.endpoints,
    )

    // Deferred mode short-circuit: append a synthetic assistant message

    // that explains the role isn't wired yet, then revert status. No

    // network call. Matches the Composer tooltip copy (line 95-97 in

    // the original Composer.tsx).

    if (thread.mode === "plan" || thread.mode === "research") {
      appendMessage(threadId, {
        id: `${Date.now().toString(36)}-d`,

        role: "assistant",

        content:
          "This role is in design. Your message is saved to the thread.",

        ts: Date.now(),
      })

      // REVIEW(opus) FINDING 12 [polish]: inline finishSend — no

      // .finally() runs in this branch.

      finishSend(threadId)

      return
    }

    // Build the API-bound messages: a system prompt (always prepended)

    // followed by the user+assistant history. System messages in the

    // UI are intentionally NOT forwarded — the system prompt is the

    // single source of truth for assistant identity + behaviour so

    // the model can't get conflicting guidance from per-turn system

    // notes a future feature might insert.

    //

    // Without the system prompt, the first user message is sent with

    // zero context and the model often falls back to a canned

    // greeting ("Hello! How can I help you today?"), which forces the

    // user to ask twice to get a real answer. See `llm/systemPrompt.ts`

    // for the full rationale + content.

    const systemMessage: ApiChatMessage = {
      role: "system",

      content: buildSystemPrompt(thread.mode),
    }

    const historyMessages = thread.messages

      .filter((m) => m.role === "user" || m.role === "assistant")

      .map((m) => buildApiChatMessage(m))

    const apiMessages: ApiChatMessage[] = [systemMessage, ...historyMessages]

    const assistantMsgId = `${Date.now().toString(36)}-r`

    // Append the assistant placeholder immediately so the user sees

    // their turn followed by a Waiting card; the placeholder is patched

    // with content / error once the response arrives.

    appendMessage(threadId, {
      id: assistantMsgId,

      role: "assistant",

      content: "",

      ts: Date.now(),
    })

    chatCompletion({
      // REVIEW(opus) FINDING 3 [high]: when no custom endpoint is

      // selected, `resolveSendTarget` returns endpoint: null. The

      // chat client throws in that case — Phase 1 ships with this

      // limitation: the user must configure an endpoint in

      // Preferences → Models before the first send succeeds. The

      // synthetic v1.1 message above is shown for deferred modes

      // which short-circuit before this branch.

      endpoint,

      model,

      messages: apiMessages,

      signal: getAbortSignal(threadId),
    })

      .then((res) => {
        updateMessage(threadId, assistantMsgId, {
          content: res.content,

          reasoning: res.reasoning,
        })
      })

      .catch((err: unknown) => {
        const message =
          err instanceof DOMException && err.name === "AbortError"
            ? "Request cancelled."
            : err instanceof Error
              ? err.message
              : String(err)

        updateMessage(threadId, assistantMsgId, { error: message })
      })

      .finally(() => {
        // REVIEW(opus) PHASE-1.4: finishSend handles:

        //   - AbortController cleanup (no leak across successful sends)

        //   - Status revert to idle

        //   - No-op when thread was deleted mid-flight (FINDING 3)

        finishSend(threadId)
      })
  }

  function handleSubmit(text: string, attachments: Attachment[] = []) {
    // REVIEW(opus) FINDING 1 [critical]: pass the thread to sendMessage

    // directly so the closure value of `activeThread` doesn't go stale

    // for the first message (which is created in the same call).

    if (!activeThread) {
      const thread = createThread({
        mode,

        endpointId: selectedEndpoint?.id ?? null,

        model: effectiveModel,

        seedTitle: text,
      })

      appendMessage(thread.id, {
        id: `${Date.now().toString(36)}-u`,

        role: "user",

        content: text,

        ts: Date.now(),

        ...(attachments.length > 0 ? { attachments } : {}),
      })

      sendMessage(thread)
    } else {
      appendMessage(activeThread.id, {
        id: `${Date.now().toString(36)}-u`,

        role: "user",

        content: text,

        ts: Date.now(),

        ...(attachments.length > 0 ? { attachments } : {}),
      })

      sendMessage(activeThread)
    }
  }

  function handleCancel() {
    if (activeThread) abortSend(activeThread.id)
  }

  // Agent label shown in the Waiting card. Maps mode → human label.

  const AGENT_LABEL: Record<ModeId, string> = {
    debug: "Debugger agent",

    scaffold: "Scaffolder agent",

    plan: "Planner agent",

    research: "Researcher agent",

    multitask: "Multitask agent",
  }

  const agentLabel = AGENT_LABEL[activeThread?.mode ?? mode] ?? "Agent"

  if (!activeThread) {
    return (
      <WelcomePanel
        onStartChat={handleSubmit}
        onOpenWorkflow={onOpenWorkflow}
      />
    )
  }

  return (
    <div className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-hidden">
      <ChatHeader thread={activeThread} onCancel={handleCancel} />
      <ChatThread
        ref={threadRef}
        messages={activeThread.messages}
        sending={activeThread.status === "sending"}
        agentLabel={agentLabel}
        onCancel={handleCancel}
        onReturn={handleReturnMessage}
        onCommitMessage={handleCommitMessage}
      />
      <div className="shrink-0 px-3 pb-3">
        <Composer
          onSubmit={handleSubmit}
          onCancel={handleCancel}
          sending={activeThread.status === "sending"}
          // Seed the textarea with the rewound message content when

          // the user clicks Return. `resetKey` bumps on every rewind

          // so the composer's useEffect fires reliably.

          seedText={rewindSeed?.text}
          resetKey={rewindSeed?.key}
          mode={mode}
          builtinId={builtinId}
          onModeChange={(m) => {
            if (m === "debug" || m === "scaffold") setMode(m)
          }}
          // REVIEW(opus) F-4 [final]: when Composer reports a built-in

          // model change in controlled mode, update the parent's

          // state so the next send uses the new model.

          onBuiltinChange={(id) => setBuiltinId(id)}
        />
      </div>

      {/* ── Revert confirmation dialog ─────────────────────────────────────
          Per `agent-example-sessions.html` lines 770-840, the Revert
          affordance on a user bubble opens a warning dialog instead
          of acting immediately. The dialog lists what would be
          dropped and asks the user to confirm. We render it as a
          centered modal at the top of the chat surface so it draws
          the eye without blocking the rest of the layout. */}
      {pendingReturnMessageId ? (
        <ReturnDialog
          messages={activeThread.messages}
          messageId={pendingReturnMessageId}
          onConfirm={confirmReturnMessage}
          onCancel={cancelReturnMessage}
        />
      ) : null}
    </div>
  )
}

/**
 * Centered confirmation dialog for the Revert / Return affordance.
 *
 * Modelled on `agent-example-sessions.html` lines 770-840: a tertiary-
 * tinted warning card with a list of "what would be dropped" and a
 * pair of Cancel / Revert buttons. We don't track actual file edits
 * yet (Phase 2's tool work), so the list is a single row that names
 * the conversation state change ("the assistant's reply after this
 * message will be removed"). Once tool-call outputs are recorded,
 * we'll plug the real file list in here.
 */

function ReturnDialog({
  messages,

  messageId,

  onConfirm,

  onCancel,
}: {
  messages: ChatMessage[]

  messageId: string

  onConfirm: () => void

  onCancel: () => void
}) {
  // Close on Escape. We don't trap focus into the dialog yet —

  // Phase 2 will add proper focus management when we have more

  // modals to share a single focus-trap helper.

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault()

        onCancel()
      }
    }

    window.addEventListener("keydown", onKey)

    return () => window.removeEventListener("keydown", onKey)
  }, [onCancel])

  // Snapshot what would be dropped. We compute this on every render

  // because the messages reference is live — if a streaming reply

  // arrives while the dialog is open, the "would drop" list updates.

  const anchorIdx = messages.findIndex((m) => m.id === messageId)

  const dropped = anchorIdx === -1 ? [] : messages.slice(anchorIdx + 1)

  return (
    // Backdrop. `pointer-events-auto` because the chat surface

    // above is `pointer-events-auto` too — the backdrop absorbs

    // clicks so the user can't click a bubble behind it.

    <div
      role="dialog"
      aria-modal="true"
      aria-label="Revert this turn?"
      className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-surface-container-lowest/70 px-4 backdrop-blur-[2px]"
      onClick={(e) => {
        // Click outside the card dismisses (matches the spec's

        // behavior — there's no explicit dismiss target in the HTML

        // but a backdrop click is the standard modal pattern).

        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="flex w-full max-w-[420px] flex-col gap-2 rounded border border-tertiary/40 bg-tertiary/[0.06] px-3 py-3 animate-fade-in">
        <div className="flex items-center gap-2">
          <span className="label-caps text-tertiary">Revert this turn?</span>
        </div>

        <p className="font-body text-[12px] leading-[18px] text-on-surface-variant">
          Reverting restores the conversation to its state{" "}
          <strong className="font-sans font-semibold text-on-surface">
            before this message
          </strong>
          . The message text will be returned to the composer so you can edit
          and re-send.
        </p>

        <div className="flex flex-col gap-1 rounded border border-outline-variant bg-surface-container-lowest px-2 py-2">
          {dropped.length === 0 ? (
            <span className="font-mono text-[11px] text-outline">
              Nothing after this message would be dropped.
            </span>
          ) : (
            dropped.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-2 font-mono text-[11px] text-on-surface-variant"
              >
                <span className="text-outline">›</span>
                <span className="truncate">
                  {m.role === "assistant"
                    ? "assistant reply"
                    : m.role === "system"
                      ? "system message"
                      : "user follow-up"}
                </span>
                <span className="ml-auto font-sans text-[10px] uppercase tracking-[0.04em] text-tertiary">
                  will be removed
                </span>
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="h-7 rounded border border-outline-variant bg-transparent px-3 font-sans text-[11px] font-semibold uppercase tracking-[0.04em] text-on-surface-variant hover:border-outline hover:bg-surface-container"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="h-7 rounded border border-tertiary bg-tertiary px-3 font-sans text-[11px] font-semibold uppercase tracking-[0.04em] text-on-tertiary hover:brightness-110"
          >
            Revert
          </button>
        </div>
      </div>
    </div>
  )
}

// ── RunSurface ────────────────────────────────────────────────────────────────

/** Thread shape per Phase 0 spec. */

type DebugThread = {
  id: string

  state: "idle"

  role: "debugger"

  runId: string

  messages: unknown[]
}

function RunSurface({
  run,

  onOpenWorkflow,
}: {
  run: Run

  onOpenWorkflow?: () => void
}) {
  // Phase 0: threads are seeded from the selected run. The orchestrator

  // loop is stubbed — submitting the composer shows a loading indicator

  // but does not make any LLM call.

  const [threads] = useState<DebugThread[]>(
    run
      ? [
          {
            id: `thread-${Date.now().toString(36)}`,

            state: "idle",

            role: "debugger",

            runId: run.commit,

            messages: [],
          },
        ]
      : [],
  )

  const [sending, setSending] = useState(false)

  // Derive the investigation data from the thread list so ProposalView

  // keeps the same visual layout — just sourced from state instead of

  // a hardcoded constant.

  const investigation: Investigation = {
    runHash: threads[0]?.runId ?? run.commit,

    goal: `Why did run ${threads[0]?.runId ?? run.commit} diverge?`,

    trace: [],

    hypothesis: {
      verdict: "Pending",

      statement: "Start a conversation to begin the investigation.",

      evidence: [],

      confidence: "Low",
    },

    patch: {
      file: "",

      summary: "",

      lines: [],
    },

    verification: {
      status: "none",

      lines: [],
    },
  }

  const [seed, setSeed] = useState(0)

  // Timer for the Phase 0 loading-stub. Replaced with real agent
  // work in WS5-T3 (Phase 1).
  const sendTimerRef = useRef<number | null>(null)
  useEffect(() => {
    return () => {
      if (sendTimerRef.current !== null) {
        window.clearTimeout(sendTimerRef.current)
      }
    }
  }, [])

  const suggestions = [
    "Compare vs b4c8f30",

    "Show metric trajectory",

    "Try smaller LR (\u00d70.5)",

    "Explain in plain terms",

    "Open in Workflow as a thread",
  ]

  function pick(s: string) {
    if (s.startsWith("Open in Workflow")) return onOpenWorkflow?.()

    setSeed((n) => n + 1)
  }

  function handleSubmit() {
    // Phase 0 stub: show the loading indicator briefly then drop back
    // to idle. The orchestrator loop is wired in WS5-T3 (Phase 1) —
    // for now the user gets visual feedback that the submit fired
    // but no actual agent work happens.
    setSending(true)

    // Clear any prior timer before arming a new one so repeated
    // submits don't stack up timers.
    if (sendTimerRef.current !== null) {
      window.clearTimeout(sendTimerRef.current)
    }
    sendTimerRef.current = window.setTimeout(() => {
      setSending(false)
      sendTimerRef.current = null
    }, 1200)
  }

  function handleCancel() {
    setSending(false)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 py-4">
      {/* Status bar */}
      <div className="shrink-0 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusDot token="tertiary" pulse />
          <span className="font-sans text-[13px] text-on-surface">
            Investigating <span className="text-primary">{run.commit}</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onOpenWorkflow}
            className="flex items-center gap-1 font-sans text-[12px] text-outline hover:text-on-surface"
            title="Open in Workflow"
          >
            <Icon name="arrow-right-left" size={13} /> Workflow
          </button>
          <button
            className="flex items-center gap-1 font-sans text-[12px] text-outline hover:text-error"
            title="Stop investigation"
          >
            <Icon name="stop-circle" size={13} /> Stop
          </button>
        </div>
      </div>

      <ProposalView data={investigation} />

      <div className="flex shrink-0 flex-col gap-3 border-t border-outline-variant pt-4">
        <QuickSuggestions items={suggestions} onPick={pick} />
        <Composer
          key={seed}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
          sending={sending}
          mode="debug"
          builtinId="fable"
          onModeChange={() => {}}
        />
      </div>
    </div>
  )
}

// ── AgentContent (public export) ─────────────────────────────────────────────

export function AgentContent({ run, onOpenWorkflow }: AgentContentProps) {
  if (run) return <RunSurface run={run} onOpenWorkflow={onOpenWorkflow} />

  return <ChatSurface onOpenWorkflow={onOpenWorkflow} />
}
