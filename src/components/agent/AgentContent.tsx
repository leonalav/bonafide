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

import { useWorkspaceRoot } from "../../ide/hooks"

import { bonafide, type AgentEngineResult } from "../../ipc/tauri"

import type { Run } from "../../data/runs"

import type { Investigation } from "../../data/agents"

import { useChatsStore } from "../../chats/ChatStoreProvider"

import {
  chatsStore,
  type Attachment,
  type ChatMessage,
} from "../../chats/ChatStore"

import { useModelsStore, type ModelFamily } from "../../modelsStore"

import { ChatHeader } from "../chat/ChatHeader"

import { ChatThread, type ChatThreadHandle } from "../chat/ChatThread"

import { toCanonicalModeId, type ModeId } from "../../chats/types"

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Render an AgentEngineResult into user-facing markdown text.
 * 
 * The engine returns a discriminated union representing the terminal
 * state of a run loop: completed (final answer), awaiting approval,
 * budget exceeded, max iterations hit, or LLM error.
 */
function renderEngineResult(result: AgentEngineResult): string {
  switch (result.type) {
    case "completed":
      return result.content
    case "awaiting_approval":
      return `🔐 **Approval Required**\n\nTool call: \`${result.toolCallId}\`\n\nReason: ${result.reason}`
    case "budget_exceeded":
      return `💰 **Budget Exceeded**\n\nThe workspace budget has been exhausted. No further agent actions can be taken until the budget is increased.`
    case "max_iterations":
      return `⏱️ **Max Iterations Reached**\n\nThe agent loop hit the iteration limit without resolving. Consider breaking the task into smaller steps.`
    case "llm_error":
      return `⚠️ **LLM Error**\n\n${result.message}`
    default:
      return "Unknown engine result type."
  }
}

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
        mode="debugger"
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
  const workspaceRoot = useWorkspaceRoot()
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

  const [mode, setMode] = useState<ModeId>("debugger")

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

    sendMessage(refreshed, { effectiveModel })
  }

  /**
   * Submit a user message to the agent engine.
   *
   * The engine runs the ReAct loop with the role-specific tool
   * allowlist, system prompt, and approval gate. Tool calls
   * (file edits, run_shell, search_arxiv, …) happen server-side;
   * the renderer only sees the final engine outcome.
   *
   * The chat store mirrors the engine result as a single assistant
   * bubble so the user-visible history still grows normally —
   * permission to inspect per-tool-call traces lives on the run
   * surface (where the Inspector's ProposalView can render them).
   */
  function sendMessage(
    thread: NonNullable<typeof activeThread>,
    /** Selected endpoint + built-in resolved to a concrete model id to
     *  forward to the Rust engine. Falls back to the thread's stored
     *  model so existing threads continue to use their pinned model
     *  even when the user switches the picker in between. */
    options?: { effectiveModel?: string },
  ) {
    // The caller passes the thread directly so the closure value of
    // `activeThread` doesn't go stale for the first message —
    // `createThread` updates the store synchronously inside the
    // same submit handler.
    if (!tryBeginSend(thread.id)) return
    const threadId = thread.id

    if (!workspaceRoot) {
      // No workspace → can't run the engine. Surface a clear error
      // rather than silently failing the LLM call.
      const assistantMsgId = `${Date.now().toString(36)}-nw`
      appendMessage(threadId, {
        id: assistantMsgId,
        role: "assistant",
        content:
          "Open a workspace before sending agent messages — the agent engine needs a working directory to execute tools and resolve files.",
        ts: Date.now(),
      })
      finishSend(threadId)
      return
    }

    // The chat store appends the user message before calling us, so
    // the most-recent message is the just-submitted turn.
    const lastMsg = thread.messages[thread.messages.length - 1]
    const userMessage = lastMsg?.content ?? ""
    if (!userMessage) {
      finishSend(threadId)
      return
    }

    // The thread's stored `mode` IS the canonical `AgentRole`
    // (snake_case) — they share the same `MODE_META` enum. Cast
    // explicitly because TS infers them as separate named types.
    const role = thread.mode as AgentRole

    // Resolve the model string: prefer the caller's effective model
    // (which already prefers the selected endpoint's defaultModel
    // over the built-in picker), then fall back to the thread's
    // stored model for backwards compatibility with threads that
    // were persisted with an explicit model id.
    const modelId = options?.effectiveModel ?? thread.model

    const assistantMsgId = `${Date.now().toString(36)}-r`

    // Append a placeholder so the user sees their turn followed by
    // a waiting card; the engine result patches the content /
    // error once it returns.
    appendMessage(threadId, {
      id: assistantMsgId,
      role: "assistant",
      content: "",
      ts: Date.now(),
    })

    bonafide.agent
      .sendMessage(workspaceRoot, {
        threadId,
        userMessage,
        role,
        // CRITICAL FIX (PROD): the configured endpoint + built-in
        // selection were previously computed but never forwarded to
        // the engine, so every request hit the Rust-side hardcoded
        // default model. Wiring it through here restores the
        // "endpoint picker → that endpoint" contract.
        modelId,
        // Forward the full endpoint payload so the Rust side can build
        // a real OpenAiCompatibleClient instead of always returning
        // the noop stub. The serialisable form (baseUrl, apiKey,
        // defaultModel, id, label) mirrors the ModelEndpoint shape
        // in modelsStore.tsx — no extra schema mapping needed.
        endpoint: selectedEndpoint
          ? {
              id: selectedEndpoint.id,
              label: selectedEndpoint.label,
              baseUrl: selectedEndpoint.baseUrl,
              apiKey: selectedEndpoint.apiKey || null,
              defaultModel: selectedEndpoint.defaultModel,
            }
          : undefined,
      })
      .then((output) => {
        const text = renderEngineResult(output.result)
        const error =
          output.result.type === "llm_error"
            ? output.result.message
            : undefined
        // Attach inline tool-call artifacts from the engine trace
        // so each invocation shows up as a Terminal / File / Tool
        // card under the assistant message. We map the IPC shape
        // to the renderer's `Artifact` shape; they're isomorphic
        // today but kept separate so the renderer doesn't have to
        // import from the IPC module.
        const artifacts = (output.toolArtifacts ?? []).map((a) => ({
          id: a.id,
          kind: a.kind,
          name: a.name,
          displayName: a.displayName,
          ...(a.target ? { target: a.target } : {}),
          ...(a.args ? { args: a.args } : {}),
          ...(a.output ? { output: a.output } : {}),
          ...(a.resultSummary ? { resultSummary: a.resultSummary } : {}),
          status: a.status,
          ts: a.ts,
        }))
        updateMessage(threadId, assistantMsgId, {
          content: text,
          ...(error ? { error } : {}),
          ...(artifacts.length > 0 ? { artifacts } : {}),
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
        // finishSend reverts status to idle and clears the per-thread
        // AbortController. Safe to call after error paths too.
        finishSend(threadId)
      })
  }

  function handleSubmit(text: string, attachments: Attachment[] = []) {
    // REVIEW(opus) FINDING 1 [critical]: pass the thread to sendMessage
    // directly so the closure value of `activeThread` doesn't go stale
    // for the first message (which is created in the same call).
    //
    // CRITICAL FIX (PROD): the previous code passed the *local* thread
    // reference returned by `createThread` straight through to
    // `sendMessage`. But `createThread` returns a thread snapshot with
    // `messages: []` — the subsequent `appendMessage` call mutates the
    // store but does NOT mutate that local reference. So when
    // `sendMessage` read `thread.messages[length-1]` to extract the
    // user message, it got `undefined`, hit the early `finishSend`
    // return, and the first user message was silently dropped (the
    // user saw their message in the bubble and nothing else).
    //
    // The fix: after each `appendMessage`, re-read the thread from the
    // store via `chatsStore.getThread` and pass THAT reference to
    // `sendMessage`. We do this for both the new-thread branch (where
    // it matters most) and the existing-thread branch (defensive — the
    // local `activeThread` closure may also be stale across re-renders).
    if (!activeThread) {
      const created = createThread({
        mode,

        endpointId: selectedEndpoint?.id ?? null,

        model: effectiveModel,

        seedTitle: text,
      })

      appendMessage(created.id, {
        id: `${Date.now().toString(36)}-u`,

        role: "user",

        content: text,

        ts: Date.now(),

        ...(attachments.length > 0 ? { attachments } : {}),
      })

      // Re-read the thread so `sendMessage` sees the just-appended
      // user message in `thread.messages`.
      const refreshed = chatsStore.getThread(created.id) ?? created
      sendMessage(refreshed, { effectiveModel })
    } else {
      appendMessage(activeThread.id, {
        id: `${Date.now().toString(36)}-u`,

        role: "user",

        content: text,

        ts: Date.now(),

        ...(attachments.length > 0 ? { attachments } : {}),
      })

      // Same defence for the existing-thread branch — the
      // `activeThread` closure reference may not reflect the freshly
      // appended message until the React re-render lands.
      const refreshed = chatsStore.getThread(activeThread.id) ?? activeThread
      sendMessage(refreshed, { effectiveModel })
    }
  }

  function handleCancel() {
    if (activeThread) abortSend(activeThread.id)
  }

  // Agent label shown in the Waiting card. Maps mode → human label.

  const AGENT_LABEL: Record<ModeId, string> = {
    debugger: "Debugger agent",
    scaffolder: "Scaffolder agent",
    planner: "Planner agent",
    researcher: "Researcher agent",
    critic: "Critic agent",
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
            setMode(m)
          }}
          // REVIEW(opus) F-4 [final]: when Composer reports a built-in

          // model change in controlled mode, update the parent's

          // state so the next send uses the new model.

          onBuiltinChange={(id) => setBuiltinId(id)}
          workspaceRoot={workspaceRoot}
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

/** Tool-call trace entry derived from a single engine iteration. The
 *  shape mirrors the Rust `TraceStep` used in `ProposalView` so the
 *  ProposalView component renders the trace without further mapping. */
type TraceEntry = {
  tool: string
  args: string
  result?: string
  time: string
}

/** Live thread state surfaced from the engine loop. */
type LiveThreadState =
  | "idle"
  | "investigating"
  | "hypothesis_formed"
  | "patch_proposed"
  | "smoke_verifying"
  | "awaiting_approval"
  | "full_run_verifying"
  | "resolved"
  | "rejected"
  | "stopped"

function RunSurface({
  run,

  onOpenWorkflow,
}: {
  run: Run

  onOpenWorkflow?: () => void
}) {
  const workspaceRoot = useWorkspaceRoot()

  // Mirror ChatSurface's hook so we can forward the picked endpoint
  // to the engine. Without this, the run-investigation surface
  // always falls through to the Rust noop stub even when the user
  // has a configured endpoint selected.
  const { selectedEndpoint } = useModelsStore()

  // Generate (or reuse) a thread id for this run. The Rust side stores
  // the row in SQLite keyed by `threadId` so subsequent submits reuse
  // the same conversation.
  const [threadId] = useState(
    () => `run-${run.commit}-${Date.now().toString(36)}`,
  )

  const [sending, setSending] = useState(false)

  const [engineState, setEngineState] =
    useState<LiveThreadState>("idle")

  const [lastError, setLastError] = useState<string | null>(null)

  const [toolTrace, setToolTrace] = useState<TraceEntry[]>([])

  /** Hypothesis evolution per spec §8.3 — each engine response may
   *  refine the verdict / statement / confidence, so we keep an
   *  ordered log of revisions the ProposalView can show. */
  const [hypothesisLog, setHypothesisLog] = useState<
    Array<{
      verdict: string
      statement: string
      confidence: "Low" | "Medium" | "High"
      at: number
    }>
  >([])

  /** Approval request surfaced when the engine result type is
   *  `awaiting_approval`. The ProposalView consumes this to render
   *  the Approve / Reject affordances. */
  const [pendingApproval, setPendingApproval] = useState<{
    toolCallId: string
    reason: string
  } | null>(null)

  /** Final assistant message from the latest run (rendered as the
   *  hypothesis statement when the engine produces a `completed`
   *  result). */
  const [lastResult, setLastResult] = useState<string>("")

  const [seed, setSeed] = useState(0)

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

  // Live investigation data derived from the engine output. Empty
  // arrays / unknown confidence fall through to the ProposalView
  // empty-state styling.
  const latestHypothesis = hypothesisLog[hypothesisLog.length - 1]

  const investigation: Investigation = {
    runHash: run.commit,

    goal: `Why did run ${run.commit} diverge?`,

    trace: toolTrace,

    hypothesis: {
      verdict: latestHypothesis?.verdict ?? "Pending",

      statement:
        latestHypothesis?.statement ??
        (engineState === "idle"
          ? "Start a conversation to begin the investigation."
          : `Engine state: ${engineState}`),

      evidence: [],

      confidence: latestHypothesis?.confidence ?? "Low",
    },

    patch: {
      file: "",

      summary: "",

      lines: [],
    },

    verification: {
      status:
        engineState === "smoke_verifying" ||
        engineState === "full_run_verifying"
          ? "running"
          : engineState === "resolved"
            ? "success"
            : engineState === "rejected" || engineState === "stopped"
              ? "failed"
              : "none",

      lines: lastResult ? [lastResult] : [],
    },
  }

  async function handleSubmit(text: string) {
    if (!workspaceRoot) {
      setLastError(
        "Open a workspace before starting an investigation.",
      )
      return
    }

    setSending(true)

    setLastError(null)

    setPendingApproval(null)

    setEngineState("investigating")

    // Append a synthetic trace entry so the user sees the user turn
    // even if the engine doesn't emit one.
    setToolTrace((prev) => [
      ...prev,

      { tool: "user_message", args: text, time: "now" },
    ])

    try {
      const output = await bonafide.agent.sendMessage(workspaceRoot, {
        threadId,

        userMessage: text,

        role: "debugger",

        runId: run.commit,

        // Forward the configured endpoint so the Rust engine builds
        // a real OpenAiCompatibleClient instead of the noop stub.
        // Same shape as ChatSurface uses at line ~479; Option<EndpointPayload>
        // on the Rust side falls back to the noop when undefined.
        endpoint: selectedEndpoint
          ? {
              id: selectedEndpoint.id,
              label: selectedEndpoint.label,
              baseUrl: selectedEndpoint.baseUrl,
              apiKey: selectedEndpoint.apiKey || null,
              defaultModel: selectedEndpoint.defaultModel,
            }
          : undefined,
      })

      setEngineState(output.newState)

      // Record the hypothesis evolution per spec §8.3 — even if the
      // engine didn't provide a structured hypothesis, we treat the
      // final content as one so the user sees the trajectory.
      setHypothesisLog((prev) => [
        ...prev,

        {
          verdict:
            output.newState === "resolved"
              ? "Confirmed"
              : output.newState === "awaiting_approval"
                ? "Likely"
                : "Pending",

          statement: describeResult(output.result),

          confidence:
            output.newState === "resolved"
              ? "High"
              : output.newState === "awaiting_approval"
                ? "Medium"
                : "Low",

          at: Date.now(),
        },
      ])

      // Render the engine's tool trace (one row per iteration). We
      // don't have per-iteration tool calls in the result type yet
      // so we show a single synthesised row; future revisions can
      // extend `AgentEngineResult` to carry the full trace.
      setToolTrace((prev) => [
        ...prev,

        {
          tool: toolFromResult(output.result),

          args: text,

          result: describeResult(output.result),

          time: "now",
        },
      ])

      setLastResult(describeResult(output.result))

      // Surface the approval request to ProposalView.
      if (output.result.type === "awaiting_approval") {
        setPendingApproval({
          toolCallId: output.result.toolCallId,

          reason: output.result.reason,
        })
      } else {
        setPendingApproval(null)
      }

      if (output.result.type === "llm_error") {
        setLastError(output.result.message)
      }
    } catch (err) {
      setLastError(
        err instanceof Error ? err.message : String(err),
      )
    } finally {
      setSending(false)
    }
  }

  function handleCancel() {
    if (!workspaceRoot || !threadId) return

    void bonafide.agent
      .stopThread(workspaceRoot, { threadId })

      .then(() => setEngineState("stopped"))

      .catch((err: unknown) => {
        setLastError(
          err instanceof Error ? err.message : String(err),
        )
      })

    setSending(false)
  }

  function handleApprove() {
    if (!workspaceRoot || !pendingApproval) return

    void bonafide.agent
      .approveAction(workspaceRoot, {
        threadId,

        toolCallId: pendingApproval.toolCallId,

        decision: "approve",
      })

      .then(() => {
        setPendingApproval(null)

        setEngineState("investigating")
      })

      .catch((err: unknown) => {
        setLastError(
          err instanceof Error ? err.message : String(err),
        )
      })
  }

  function handleReject() {
    if (!workspaceRoot || !pendingApproval) return

    void bonafide.agent
      .rejectAction(workspaceRoot, {
        threadId,

        toolCallId: pendingApproval.toolCallId,

        decision: "reject",
      })

      .then(() => {
        setPendingApproval(null)

        setEngineState("rejected")
      })

      .catch((err: unknown) => {
        setLastError(
          err instanceof Error ? err.message : String(err),
        )
      })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 py-4">
      {/* Status bar */}
      <div className="shrink-0 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusDot token="tertiary" pulse={sending} />
          <span className="font-sans text-[13px] text-on-surface">
            {sending
              ? "Investigating"
              : engineState === "idle"
                ? "Ready"
                : engineState}{" "}
            <span className="text-primary">{run.commit}</span>
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
            onClick={handleCancel}
            className="flex items-center gap-1 font-sans text-[12px] text-outline hover:text-error"
            title="Stop investigation"
          >
            <Icon name="stop-circle" size={13} /> Stop
          </button>
        </div>
      </div>

      {lastError ? (
        <div
          role="alert"
          className="rounded border border-error/40 bg-error/5 px-3 py-2 font-sans text-[12px] text-error"
        >
          {lastError}
        </div>
      ) : null}

      <ProposalView data={investigation} />

      {/* Hypothesis evolution trail (spec §8.3) — newest first */}
      {hypothesisLog.length > 1 ? (
        <section className="flex flex-col gap-2 border-t border-outline-variant pt-4">
          <span className="label-caps text-on-surface-variant">
            Hypothesis evolution
          </span>
          <ol className="flex flex-col gap-1">
            {hypothesisLog
              .slice()
              .reverse()
              .map((h, i) => (
                <li
                  key={`${h.at}-${i}`}
                  className="flex items-baseline gap-2 rounded border border-outline-variant/50 bg-surface-container-low px-2 py-1"
                >
                  <span className="label-caps text-outline">
                    rev {hypothesisLog.length - i}
                  </span>
                  <span className="font-body text-[12px] text-on-surface">
                    {h.statement}
                  </span>
                  <span className="ml-auto font-sans text-[10px] text-outline">
                    {h.confidence}
                  </span>
                </li>
              ))}
          </ol>
        </section>
      ) : null}

      {/* Approval card — surfaced when the engine result type is
          `awaiting_approval`. ProposalView doesn't know how to render
          this — it's our job to overlay the buttons here so the user
          can drive the engine forward. */}
      {pendingApproval ? (
        <section className="flex flex-col gap-2 rounded-lg border border-tertiary/40 bg-tertiary/[0.06] p-3">
          <span className="label-caps text-tertiary">
            Awaiting approval
          </span>
          <p className="font-body text-[12px] leading-[18px] text-on-surface-variant">
            {pendingApproval.reason}
          </p>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleReject}
              className="h-7 rounded border border-outline-variant bg-transparent px-3 font-sans text-[11px] font-semibold uppercase tracking-[0.04em] text-on-surface-variant hover:border-outline hover:bg-surface-container"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={handleApprove}
              className="h-7 rounded border border-primary bg-primary px-3 font-sans text-[11px] font-semibold uppercase tracking-[0.04em] text-on-primary hover:brightness-110"
            >
              Approve
            </button>
          </div>
        </section>
      ) : null}

      <div className="flex shrink-0 flex-col gap-3 border-t border-outline-variant pt-4">
        <QuickSuggestions items={suggestions} onPick={pick} />
        <Composer
          key={seed}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
          sending={sending}
          mode="debugger"
          builtinId="fable"
          onModeChange={() => {}}
        />
      </div>
    </div>
  )
}

/**
 * Convert an `AgentEngineResult` into a one-line human description
 * suitable for the trace / hypothesis log. The shape varies per
 * variant so we centralise the switch here.
 */
function describeResult(result: AgentEngineResult): string {
  switch (result.type) {
    case "completed":
      return result.content

    case "awaiting_approval":
      return `Awaiting approval: ${result.reason}`

    case "budget_exceeded":
      return "Budget exceeded — investigate before continuing."

    case "max_iterations":
      return "Reached the iteration cap before finishing."

    case "llm_error":
      return `Engine error: ${result.message}`
  }
}

/**
 * Choose a tool name for the trace row based on the engine result
 * variant. Future revisions can plumb the actual tool-call name from
 * the backend; for now this gives the trace a recognisable label.
 */
function toolFromResult(result: AgentEngineResult): string {
  switch (result.type) {
    case "completed":
      return "agent_response"

    case "awaiting_approval":
      return "approval_request"

    case "budget_exceeded":
      return "budget_check"

    case "max_iterations":
      return "iter_cap"

    case "llm_error":
      return "engine_error"
  }
}

// ── AgentContent (public export) ─────────────────────────────────────────────

export function AgentContent({ run, onOpenWorkflow }: AgentContentProps) {
  if (run) return <RunSurface run={run} onOpenWorkflow={onOpenWorkflow} />

  return <ChatSurface onOpenWorkflow={onOpenWorkflow} />
}
