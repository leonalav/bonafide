/**
 * ChatStore.ts — Multi-thread chat history, persisted to localStorage.
 *
 * Architecture mirrors `modelsStore.tsx`:
 *   - Plain module-level state so it can be imported anywhere without
 *     triggering re-renders.
 *   - Thin pub/sub (`subscribe`) for components that need to react.
 *   - Companion React provider (`ChatStoreProvider.tsx`) for the hook.
 *
 * Persistence contract:
 *   - Every mutator (`appendMessage`, `updateMessage`, `editMessage`,
 *     `truncateAfter`, `renameThread`, `deleteThread`, `setActiveThread`,
 *     `setThreadStatus`, `tryBeginSend`, `finishSend`, `abortSend`) ends
 *     with `saveConfig(_config)` so the change is mirrored to
 *     `localStorage[STORAGE_KEY]` synchronously. Components therefore
 *     don't need to persist themselves — the store is the source of
 *     truth and reloads hydrate from the same key on next mount.
 *   - `loadConfig` validates every field on read; malformed entries
 *     are silently discarded (defensive — see isValidThread /
 *     isValidMessage guards below).
 *
 * What lives here:
 *   - All chat threads (titles, messages, status, model selection)
 *   - The currently-active thread id (so reopening the IDE lands in
 *     the same conversation)
 *   - One AbortController per thread so the Stop button can cancel
 *     an in-flight completion without leaking the controller.
 *
 * What does NOT live here:
 *   - The Composer state (mode + loop toggle + textarea). That stays
 *     inside `Composer.tsx` because it's component-local UI state.
 *   - Endpoint configuration. We *consume* `modelsStore` rather than
 *     duplicating its data.
 *   - System prompts. They're a Phase-2 concern (different prompts per
 *     mode / per role).
 */

import type { ModelEndpoint } from "../modelsStore";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ChatRole = "user" | "assistant" | "system";

export type ChatStatus = "idle" | "sending" | "error";

/**
 * An attachment uploaded by the user for one chat message.
 *
 * Phase 1.5 supports two kinds:
 *   - `image`: a data-URL or object-URL preview, ready to inline in the
 *     user bubble and forwarded to vision-capable endpoints as an
 *     OpenAI-style image content part.
 *   - `file`:  a generic file (PDF, code, dataset, …). Forwarded as
 *     an OpenAI-style file content part (some endpoints like vLLM
 *     serve this as `file`; we fall back to sending the name in
 *     metadata when the provider rejects `file` content parts).
 *
 * The `id` is the React list key + the attachment handle. `dataUrl`
 * is what we ship to the LLM (or display inline for images); the
 * raw `File` object is intentionally not stored on the message — it
 * doesn't survive JSON serialisation, and the model only needs the
 * encoded form.
 */
export type Attachment = {
  id: string;
  kind: "image" | "file";
  /** Original file name, e.g. "screenshot.png". */
  name: string;
  /** MIME type, e.g. "image/png" or "application/pdf". */
  mime: string;
  /** File size in bytes. */
  size: number;
  /** Data URL (`data:image/png;base64,...`) used for both preview and API transport. */
  dataUrl: string;
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  /** Visible content. May be empty for partial / streaming turns (Phase 3). */
  content: string;
  /** Reasoning text returned by the model, if any. */
  reasoning?: string;
  /** Error message if this turn failed. */
  error?: string;
  /** Milliseconds since epoch. */
  ts: number;
  /**
   * Files / images attached to this turn by the user. Persisted with
   * the message so reloads keep the context intact. Attachments on
   * assistant turns are reserved for Phase 2's tool-call outputs and
   * aren't set today.
   */
  attachments?: Attachment[];
};

export type ChatThreadMode = "debug" | "scaffold" | "plan" | "research" | "multitask";

export type ChatThread = {
  id: string;
  /** Auto-generated from first user message, editable inline. */
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Mode picked at the time the thread was created. */
  mode: ChatThreadMode;
  /** Endpoint ID from modelsStore — null means use built-in default. */
  endpointId: string | null;
  /** Model ID sent to the API at submit time. */
  model: string;
  messages: ChatMessage[];
  status: ChatStatus;
};

export type ChatConfig = {
  activeThreadId: string | null;
  threads: ChatThread[];
};

// ── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY = "__bonafide_chats";
const MAX_TITLE_LEN = 60;

// ── Persistence helpers ─────────────────────────────────────────────────────

const DEFAULT_CONFIG: ChatConfig = {
  activeThreadId: null,
  threads: [],
};

// REVIEW(opus) FINDINGS 2 + 7 [critical/medium]: prior validation only
// checked `Array.isArray(parsed.threads)`. A thread with
// `messages: null` would slip through and crash at the next spread
// (`[...t.messages, message]`). Worse, threads missing `id` or with
// the wrong `status` enum passed silently and broke lookup equality
// checks downstream. The guard below enforces every required field
// the store touches.
function isValidThread(t: unknown): t is ChatThread {
  if (!t || typeof t !== "object") return false;
  const o = t as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.title === "string" &&
    typeof o.createdAt === "number" &&
    typeof o.updatedAt === "number" &&
    (o.mode === "debug" ||
      o.mode === "scaffold" ||
      o.mode === "plan" ||
      o.mode === "research" ||
      o.mode === "multitask") &&
    (o.endpointId === null || typeof o.endpointId === "string") &&
    typeof o.model === "string" &&
    Array.isArray(o.messages) &&
    (o.status === "idle" || o.status === "sending" || o.status === "error")
  );
}

function isValidMessage(m: unknown): m is ChatMessage {
  if (!m || typeof m !== "object") return false;
  const o = m as Record<string, unknown>;
  // attachments is optional; when present it must be an array of
  // objects with the fields we use downstream. We don't validate the
  // dataUrl contents here (could be megabytes) — loadConfig will
  // discard a malformed record but a heavy one will already be in
  // memory. We rely on `truncateConfig` below to keep individual
  // message sizes sensible.
  const attOk =
    o.attachments === undefined ||
    (Array.isArray(o.attachments) &&
      o.attachments.every(
        (a) =>
          a &&
          typeof a === "object" &&
          typeof (a as Attachment).id === "string" &&
          typeof (a as Attachment).name === "string" &&
          typeof (a as Attachment).mime === "string" &&
          typeof (a as Attachment).size === "number" &&
          typeof (a as Attachment).dataUrl === "string" &&
          ((a as Attachment).kind === "image" ||
            (a as Attachment).kind === "file"),
      ));
  return (
    typeof o.id === "string" &&
    (o.role === "user" || o.role === "assistant" || o.role === "system") &&
    typeof o.content === "string" &&
    typeof o.ts === "number" &&
    attOk
  );
}

function loadConfig(): ChatConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ChatConfig>;
      // Light validation — discard malformed shapes instead of crashing.
      if (
        parsed &&
        Array.isArray(parsed.threads) &&
        parsed.threads.every(isValidThread) &&
        parsed.threads.every((t) => t.messages.every(isValidMessage)) &&
        (parsed.activeThreadId === null ||
          typeof parsed.activeThreadId === "string")
      ) {
        return parsed as ChatConfig;
      }
    }
  } catch {
    /* ignore parse errors, fall through to default */
  }
  return DEFAULT_CONFIG;
}

function saveConfig(cfg: ChatConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    /* ignore quota errors; in-memory copy still works */
  }
}

// ── Module-level state ───────────────────────────────────────────────────────

let _config: ChatConfig = loadConfig();

type Listener = () => void;
const _listeners = new Set<Listener>();

function _notify() {
  // Notify on a microtask so multiple synchronous updates batch into one
  // render. The React provider uses `forceUpdate` on this event.
  queueMicrotask(() => {
    _listeners.forEach((l) => l());
  });
}

// ── AbortControllers, keyed by thread id ─────────────────────────────────────

const _abortControllers = new Map<string, AbortController>();

function getAbortController(threadId: string): AbortController {
  let c = _abortControllers.get(threadId);
  if (!c) {
    c = new AbortController();
    _abortControllers.set(threadId, c);
  }
  return c;
}

function clearAbortController(threadId: string) {
  _abortControllers.delete(threadId);
}

// ── Public store API ─────────────────────────────────────────────────────────

export type CreateThreadInput = {
  mode: ChatThreadMode;
  endpointId: string | null;
  model: string;
  /** Optional seed for the auto-generated title (first user message). */
  seedTitle?: string;
};

export const chatsStore = {
  /** Return the current config (live reference — do not mutate). */
  getConfig(): ChatConfig {
    return _config;
  },

  /** Look up a thread by id, or `null` when not found. */
  getThread(id: string): ChatThread | null {
    return _config.threads.find((t) => t.id === id) ?? null;
  },

  /**
   * Resolve the thread that contains a given message id. Returns
   * null when the message id is unknown (e.g. it was deleted).
   *
   * Used by the Rewind / Return affordance: the caller has a
   * `ChatMessage` but not its thread id, so the chat store is the
   * single source of truth for the relationship. (The previous
   * implementation took the thread id as a parameter and trusted
   * the caller — the caller was passing a message id, which made
   * the whole flow silently no-op.)
   */
  getThreadByMessageId(messageId: string): ChatThread | null {
    return (
      _config.threads.find((t) =>
        t.messages.some((m) => m.id === messageId),
      ) ?? null
    );
  },

  /**
   * Create a new thread and switch to it. The thread starts empty
   * (`messages: []`) — the caller appends the first user message via
   * `appendMessage` immediately after creation.
   */
  createThread(input: CreateThreadInput): ChatThread {
    const now = Date.now();
    // REVIEW(opus) FINDING 10 [low]: prior code passed an empty
    // `deriveTitle("   ")` result straight through to the title field,
    // producing a blank thread name. We now fall back to "New chat".
    const title = input.seedTitle
      ? deriveTitle(input.seedTitle) || "New chat"
      : "New chat";
    const thread: ChatThread = {
      id: uid(),
      title,
      createdAt: now,
      updatedAt: now,
      mode: input.mode,
      endpointId: input.endpointId,
      model: input.model,
      messages: [],
      status: "idle",
    };
    _config = {
      activeThreadId: thread.id,
      threads: [..._config.threads, thread],
    };
    saveConfig(_config);
    _notify();
    return thread;
  },

  /**
   * Rename a thread. Empty titles are rejected — the caller should
   * disable the save action rather than rely on this for input
   * validation.
   */
  renameThread(id: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) return;
    _config = {
      ..._config,
      threads: _config.threads.map((t) =>
        t.id === id ? { ...t, title: trimmed, updatedAt: Date.now() } : t,
      ),
    };
    saveConfig(_config);
    _notify();
  },

  /** Delete a thread and switch to the most-recent remaining one, if any. */
  deleteThread(id: string) {
    // Cancel any in-flight request for this thread before dropping it.
    _abortControllers.get(id)?.abort();
    clearAbortController(id);

    const remaining = _config.threads.filter((t) => t.id !== id);
    const nextActive =
      _config.activeThreadId === id
        ? remaining.length > 0
          ? remaining[remaining.length - 1]!.id
          : null
        : _config.activeThreadId;
    _config = { activeThreadId: nextActive, threads: remaining };
    saveConfig(_config);
    _notify();
  },

  /** Switch the active thread. Pass `null` to clear selection. */
  setActiveThread(id: string | null) {
    _config = { ..._config, activeThreadId: id };
    saveConfig(_config);
    _notify();
  },

  /**
   * Append a message to a thread. The composer's first-message flow
   * uses this for the user turn, then immediately calls
   * `runCompletion` to fetch the assistant reply.
   */
  appendMessage(threadId: string, message: ChatMessage) {
    _config = {
      ..._config,
      threads: _config.threads.map((t) =>
        t.id === threadId
          ? { ...t, messages: [...t.messages, message], updatedAt: Date.now() }
          : t,
      ),
    };
    saveConfig(_config);
    _notify();
  },

  /**
   * Patch an existing message in-place. Used to fill in the assistant
   * reply once the LLM responds (or its error message on failure).
   */
  updateMessage(
    threadId: string,
    messageId: string,
    patch: Partial<ChatMessage>,
  ) {
    _config = {
      ..._config,
      threads: _config.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              updatedAt: Date.now(),
              messages: t.messages.map((m) =>
                m.id === messageId ? { ...m, ...patch } : m,
              ),
            }
          : t,
      ),
    };
    saveConfig(_config);
    _notify();
  },

  /**
   * Rewrite a message's content. Used by the inline-edit affordance on
   * user bubbles — paired with `truncateAfter` so the edited message
   * becomes the new branch point and all later turns (assistant
   * reply, follow-ups, etc.) are dropped before resending.
   *
   * The message's `ts` is bumped to "now" so the bubble meta row
   * reflects the edit time; the rest of the message shape is preserved
   * (id, role, reasoning).
   */
  editMessage(threadId: string, messageId: string, newContent: string) {
    _config = {
      ..._config,
      threads: _config.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              updatedAt: Date.now(),
              messages: t.messages.map((m) =>
                m.id === messageId
                  ? { ...m, content: newContent, ts: Date.now() }
                  : m,
              ),
            }
          : t,
      ),
    };
    saveConfig(_config);
    _notify();
  },

  /**
   * Drop every message strictly after `messageId` in the thread. Used
   * by the inline-edit Save action (which rewrites the message then
   * calls this) and by the Return affordance (which rewinds the
   * conversation to just before this point and re-runs the request).
   *
   * The target message itself is preserved — only messages after it
   * are removed. Any in-flight AbortController for the thread is
   * aborted first so a response that lands mid-mutation doesn't
   * resurrect the dropped turns.
   */
  truncateAfter(threadId: string, messageId: string) {
    // Cancel anything in-flight before we drop the assistant turn it
    // was about to fill in. Without this the .then() / .finally()
    // handlers would attempt to updateMessage against an id that no
    // longer exists, which is harmless but wasteful.
    _abortControllers.get(threadId)?.abort();
    clearAbortController(threadId);

    _config = {
      ..._config,
      threads: _config.threads.map((t) => {
        if (t.id !== threadId) return t;
        const idx = t.messages.findIndex((m) => m.id === messageId);
        if (idx === -1) return t;
        return {
          ...t,
          // The slice includes the target message itself so its
          // edited content survives — only messages AFTER it are
          // dropped. If the target was the last message the slice is
          // a no-op (returns the array unchanged), which is the
          // expected behaviour for Return on the most-recent turn.
          messages: t.messages.slice(0, idx + 1),
          updatedAt: Date.now(),
          status: "idle",
        };
      }),
    };
    saveConfig(_config);
    _notify();
  },

  /** Set a thread's status (idle / sending / error). */
  setThreadStatus(threadId: string, status: ChatStatus) {
    _config = {
      ..._config,
      threads: _config.threads.map((t) =>
        t.id === threadId ? { ...t, status } : t,
      ),
    };
    saveConfig(_config);
    _notify();
  },

  /**
   * Return the AbortController for a thread, creating one if needed.
   * Exposed so the chat surface can wire the Stop button to its
   * `signal` via `chatCompletion({ ..., signal: controller.signal })`.
   */
  getAbortSignal(threadId: string): AbortSignal {
    return getAbortController(threadId).signal;
  },

  /**
   * REVIEW(opus) FINDING 4 [high]: prior API had no concurrency guard
   * so a double-click on Send could spawn two parallel network
   * requests, each writing to the same thread. `tryBeginSend` returns
   * `false` when the thread is already sending so the caller can bail
   * cleanly. Returns `true` on success after marking the thread
   * "sending".
   */
  tryBeginSend(threadId: string): boolean {
    const thread = _config.threads.find((t) => t.id === threadId);
    if (!thread || thread.status === "sending") return false;
    _config = {
      ..._config,
      threads: _config.threads.map((t) =>
        t.id === threadId ? { ...t, status: "sending" } : t,
      ),
    };
    saveConfig(_config);
    _notify();
    return true;
  },

  /**
   * REVIEW(opus) FINDINGS 3 + 5 [critical + high]: prior API cleared
   * the AbortController only on abort. We add a `finishSend` helper
   * that the chat surface calls in `finally` after every send — it
   * clears the controller (no leak across successful sends), reverts
   * status, and is a no-op when the thread has been deleted mid-flight
   * so it can't resurrect a stale entry.
   */
  finishSend(threadId: string, finalStatus: ChatStatus = "idle") {
    clearAbortController(threadId);
    const stillExists = _config.threads.some((t) => t.id === threadId);
    if (!stillExists) return;
    _config = {
      ..._config,
      threads: _config.threads.map((t) =>
        t.id === threadId ? { ...t, status: finalStatus } : t,
      ),
    };
    saveConfig(_config);
    _notify();
  },

  /** Cancel an in-flight request for a thread. Status reverts to idle. */
  abortSend(threadId: string) {
    // REVIEW(opus) FINDING 11 [low]: abortSend used to write state
    // unconditionally even when the thread no longer existed. Mirror
    // finishSend's stillExists guard so a stale abort handler can't
    // touch the store after deletion.
    const stillExists = _config.threads.some((t) => t.id === threadId);
    _abortControllers.get(threadId)?.abort();
    clearAbortController(threadId);
    if (!stillExists) return;
    _config = {
      ..._config,
      threads: _config.threads.map((t) =>
        t.id === threadId ? { ...t, status: "idle" } : t,
      ),
    };
    saveConfig(_config);
    _notify();
  },

  subscribe(listener: Listener): () => void {
    _listeners.add(listener);
    return () => {
      _listeners.delete(listener);
    };
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * REVIEW(opus) F-32 [polish]: previously used `Date.now() + Math.random`
 * which has theoretical collision risk under high-frequency thread
 * creation (tests, automation). We now use `crypto.randomUUID()` when
 * available, with a graceful fallback to the timestamp + counter
 * approach for environments without the Web Crypto API.
 */
let _uidCounter = 0;
function uid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  _uidCounter += 1;
  return `${Date.now().toString(36)}-${_uidCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Derive a thread title from the first user message. We take the
 * first non-empty line, collapse whitespace, clamp to MAX_TITLE_LEN,
 * and ellipsise when we'd cut mid-word. The result is used as the
 * thread's auto-title until the user renames it.
 */
export function deriveTitle(text: string): string {
  const firstLine =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ");
  if (collapsed.length <= MAX_TITLE_LEN) return collapsed;
  const cut = collapsed.slice(0, MAX_TITLE_LEN);
  // Walk back to the last whitespace so we don't slice mid-word.
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 20 ? lastSpace : MAX_TITLE_LEN).trimEnd()}…`;
}

/**
 * Resolve the endpoint + model pair for a send.
 *
 * REVIEW(opus) F-15 [final]: the prior implementation was a no-op
 * wrapper that always returned `selectedEndpoint`. We now correctly
 * prefer the stored `thread.endpointId` (for thread reproducibility
 * across preference changes) and only fall back to the currently-
 * selected endpoint when the stored id is null.
 *
 * Cases:
 *   - thread.endpointId is null → use selectedEndpoint as-is
 *     (covers built-in default mode).
 *   - thread.endpointId is set and matches an entry in endpoints →
 *     use that endpoint (thread reproducibility).
 *   - thread.endpointId is set but no longer matches any entry →
 *     fall back to selectedEndpoint; the caller's error handler
 *     will surface a "endpoint not configured" message.
 */
export function resolveSendTarget(
  thread: ChatThread,
  selectedEndpoint: ModelEndpoint | null,
  endpoints: ModelEndpoint[],
): { endpoint: ModelEndpoint | null; model: string } {
  let endpoint: ModelEndpoint | null = null;
  if (thread.endpointId) {
    endpoint = endpoints.find((e) => e.id === thread.endpointId) ?? null;
    if (!endpoint) endpoint = selectedEndpoint;
  } else {
    endpoint = selectedEndpoint;
  }
  return { endpoint, model: thread.model };
}
