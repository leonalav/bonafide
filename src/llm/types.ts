/**
 * types.ts — OpenAI-compatible Chat Completions request/response shapes.
 *
 * We intentionally do NOT pull in `openai` or any vendor SDK. Bonafide
 * talks to many OpenAI-compatible endpoints (LM Studio, vLLM, Groq,
 * Fireworks AI, OpenAI, …) and the schemas vary slightly across
 * providers. The shapes below are the *intersection* of those — only
 * the fields we actually read — so we don't have to type-assert at
 * every call site.
 *
 * Phase 1 only needs buffered (non-streaming) chat completions. The
 * types are wide enough that Phase 2 can extend `ChatRequest` with
 * `tools: ToolDefinition[]` without breaking the public surface.
 */

// ── Chat role + content ──────────────────────────────────────────────────────

/**
 * The three roles recognised by every OpenAI-compatible endpoint.
 *
 * Note: this is the API-side role, not the UI-side role. The chat store
 * uses the same names so that converting a `ChatMessage` to an
 * API-bound message is a straight `role: m.role` copy.
 */
export type ChatRole = "user" | "assistant" | "system";

// ── Request ──────────────────────────────────────────────────────────────────

/**
 * A piece of content inside a single chat-completion message.
 *
 * The OpenAI spec supports either a plain string (`content: "..."`) for
 * text-only turns, OR an array of parts for multimodal turns
 * (`content: [{type:"text",text:"..."}, {type:"image_url",...}, ...]).
 *
 * Bonafide's user turns may include image / file attachments, so we
 * accept both shapes here. Phase 1 sends a plain string for any
 * message without attachments and an array for messages with
 * attachments.
 */
export type ApiContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string; detail?: "auto" | "low" | "high" };
    }
  | {
      /**
       * Generic file part. Some OpenAI-compatible endpoints (vLLM,
       * OpenRouter, Anthropic-via-proxy) accept this; vanilla
       * OpenAI rejects it. `client.ts` falls back gracefully when
       * the provider returns 400 on `file` parts.
       */
      type: "file";
      file: { filename: string; file_data: string };
    };

/**
 * One message in the conversation history sent to the model.
 *
 * `content` is the union of `string | ApiContentPart[]` — most turns
 * are plain strings; turns with attachments are arrays.
 *
 * Provider extensions like `name`, `tool_call_id`, etc. are not
 * modelled here yet — they land with Phase 2's tool-calling work.
 */
export type ApiChatMessage = {
  role: ChatRole;
  content: string | ApiContentPart[];
};

export type ChatRequest = {
  /**
   * Resolved endpoint. `null` means "use Bonafide's built-in default".
   * The built-in default is not wired in Phase 1 — passing `null`
   * from the UI causes `chatCompletion` to throw a clear
   * `Error("No chat endpoint configured…")` so the user gets a
   * visible error instead of a silent no-op.
   */
  endpoint: import("../modelsStore").ModelEndpoint | null;
  /** Model ID sent as the `model` field, e.g. "claude-3-5-sonnet-20241022". */
  model: string;
  /** Conversation history to send. Only `user` and `assistant` turns are forwarded. */
  messages: ApiChatMessage[];
  /** AbortSignal for cancel support (Stop button). */
  signal?: AbortSignal;
  /** Optional override for the request temperature. Defaults to 0.2 for stability. */
  temperature?: number;
};

// ── Response ─────────────────────────────────────────────────────────────────

/**
 * One chunk of reasoning returned by a reasoning model (DeepSeek-R1
 * convention). We keep this loose — the field name is
 * `reasoning_content` in DeepSeek's API and `reasoning` in OpenAI's
 * o-series. Both shapes are accepted in `client.ts`.
 */
export type ApiChoiceMessage = {
  role?: "assistant";
  /** The visible reply text. May be empty for tool-calling responses (Phase 2). */
  content: string | null;
  /** Reasoning chain. Provider-dependent naming; see `client.ts`. */
  reasoning_content?: string | null;
  reasoning?: string | null;
};

export type ApiChoice = {
  index: number;
  message: ApiChoiceMessage;
  finish_reason?: string;
};

export type ApiUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type ApiChatResponse = {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices: ApiChoice[];
  usage?: ApiUsage;
};

// ── Normalised output ────────────────────────────────────────────────────────

/**
 * What `chatCompletion()` returns. The UI never sees raw API shapes.
 *
 * `reasoning` is `undefined` when the model doesn't expose its chain
 * of thought — the chat layer then skips the ReasoningArtifact.
 */
export type ChatResponse = {
  /** Visible assistant reply. Empty string is allowed (degenerate cases). */
  content: string;
  /** Reasoning text, if the model returned it in any supported shape. */
  reasoning?: string;
  /** Tokens used, when the provider reports them. UI may display this later. */
  usage?: ApiUsage;
};

// ── Phase-2 stubs (not implemented in Phase 1) ───────────────────────────────
//
// Documented here so the contract for future work is visible. Any new
// feature that needs tool calls should extend these rather than
// introducing a parallel request shape.

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};
