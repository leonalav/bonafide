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
 *
 * ## Tool-call dual ownership
 *
 * `ToolDefinition` and `ToolCall` are owned by both this file and
 * `src-tauri/src/agent/llm.rs`. Both sides must agree on field names
 * and JSON shapes exactly. The canonical wire shape lives in Rust's
 * `llm.rs`; this file mirrors it. `TOOL_CALL_PROTOCOL_VERSION`
 * tracks the protocol revision so a mismatch can be detected.
 */

// ── Tool-call protocol version ────────────────────────────────────────────────

/**
 * Current tool-call wire protocol version. Mirrors `TOOL_CALL_PROTOCOL_VERSION`
 * in `src-tauri/src/agent/llm.rs`. Increment when the `ToolDefinition` or
 * `ToolCall` shape changes in a backward-incompatible way.
 */
export const TOOL_CALL_PROTOCOL_VERSION = "openai/v1"

// ── Chat role + content ──────────────────────────────────────────────────────

/**
 * The three roles recognised by every OpenAI-compatible endpoint.
 *
 * Note: this is the API-side role, not the UI-side role. The chat store
 * uses the same names so that converting a `ChatMessage` to an
 * API-bound message is a straight `role: m.role` copy.
 */
export type ChatRole = "user" | "assistant" | "system"

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
export type ApiContentPart = { type: "text" text: string } | {
  type: "image_url"
  image_url: { url: string detail?: "auto" | "low" | "high" }
} | {
  /**
   * Generic file part. Some OpenAI-compatible endpoints (vLLM,
   * OpenRouter, Anthropic-via-proxy) accept this; vanilla
   * OpenAI rejects it. `client.ts` falls back gracefully when
   * the provider returns 400 on `file` parts.
   */
  type: "file"
  file: { filename: string file_data: string }
}

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
  role: ChatRole
  content: string | ApiContentPart[]
}

export type ChatRequest = {
  /**
   * Resolved endpoint. `null` means "use Bonafide's built-in default".
   * The built-in default is not wired in Phase 1 — passing `null`
   * from the UI causes `chatCompletion` to throw a clear
   * `Error("No chat endpoint configured…")` so the user gets a
   * visible error instead of a silent no-op.
   */
  endpoint: import("../modelsStore").ModelEndpoint | null
  /** Model ID sent as the `model` field, e.g. "claude-3-5-sonnet-20241022". */
  model: string
  /** Conversation history to send. Only `user` and `assistant` turns are forwarded. */
  messages: ApiChatMessage[]
  /** AbortSignal for cancel support (Stop button). */
  signal?: AbortSignal
  /** Optional override for the request temperature. Defaults to 0.2 for stability. */
  temperature?: number
  /**
   * Tool definitions offered to the model (Phase 2).
   * Mirrors `llm.rs ChatRequest.tools` — when `undefined`, the key is
   * omitted from the serialised JSON body so providers that don't
   * support the field don't return 400.
   */
  tools?: ToolDefinition[]
}

// ── Response ─────────────────────────────────────────────────────────────────

/**
 * One chunk of reasoning returned by a reasoning model (DeepSeek-R1
 * convention). We keep this loose — the field name is
 * `reasoning_content` in DeepSeek's API and `reasoning` in OpenAI's
 * o-series. Both shapes are accepted in `client.ts`.
 */
export type ApiChoiceMessage = {
  role?: "assistant"
  /** The visible reply text. May be empty for tool-calling responses (Phase 2). */
  content: string | null
  /** Reasoning chain. Provider-dependent naming; see `client.ts`. */
  reasoning_content?: string | null
  reasoning?: string | null
}

export type ApiChoice = {
  index: number
  message: ApiChoiceMessage
  finish_reason?: string
}

export type ApiUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export type ApiChatResponse = {
  id?: string
  object?: string
  created?: number
  model?: string
  choices: ApiChoice[]
  usage?: ApiUsage
}

// ── Normalised output ────────────────────────────────────────────────────────

/**
 * What `chatCompletion()` returns. The UI never sees raw API shapes.
 *
 * `reasoning` is `undefined` when the model doesn't expose its chain
 * of thought — the chat layer then skips the ReasoningArtifact.
 *
 * `tool_calls` is populated from `first.message.tool_calls` when the
 * model requests tool execution. An empty array means the model produced
 * a final text answer.
 */
export type ChatResponse = {
  /** Visible assistant reply. Empty string is allowed (degenerate cases). */
  content: string
  /** Reasoning text, if the model returned it in any supported shape. */
  reasoning?: string
  /**
   * Tool calls requested by the model. Empty = final answer (per
   * `src-tauri/src/agent/llm.rs` section 7.2 step 2).
   */
  tool_calls: ToolCall[]
  /** Tokens used, when the provider reports them. UI may display this later. */
  usage?: ApiUsage
}

// ── Phase-2 stubs (not implemented in Phase 1) ───────────────────────────────
//
// Documented here so the contract for future work is visible. Any new
// feature that needs tool calls should extend these rather than
// introducing a parallel request shape.

export type ToolDefinition = {
  type: "function"
  function: {
    name: string
    description: string
    /**
     * JSON Schema describing the tool's parameters.
     * Mirrors `llm.rs ToolFunction.parameters: serde_json::Value`.
     * Both sides must agree on field names — canonical shape lives in Rust.
     * Type: `Record<string, unknown>` (re-exported from JSON Schema spec).
     */
    parameters: Record<string, unknown>
  }
}

export type ToolCall = {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

// ── Agent role + prompt context (WS1-T4) ─────────────────────────────────────

/**
 * The five canonical agent roles from `docs/agent-architecture.md` section 5.1.
 *
 * Distinct from `chats/types.ModeId` because the agent system prompt needs
 * the spec-named roles, while the chat surface uses the shorthand picker
 * labels (debug, scaffold, plan, …). Mapping happens in
 * `systemPrompt.ts:deriveRoleFromMode`.
 */
export type AgentRole =
  | "debugger"
  | "scaffolder"
  | "planner"
  | "researcher"
  | "critic"

/**
 * The dead-end / insight entries injected into the system prompt
 * (section 9.2 schema).
 */
export interface ProjectMemoryEntry {
  /** Human-readable label of the dead-end or insight. */
  label: string
  /** Supporting evidence / citation. */
  evidence: string
  /** Confidence / date marker (e.g. "High", "2026-08-12"). */
  marker?: string
}

/**
 * Summary of the project's memory state — what's been tried and what's
 * known. Bounded: max 50 insights, max 50 dead-ends (FIFO eviction).
 */
export interface ProjectMemorySummary {
  deadEnds: ProjectMemoryEntry[]
  insights: ProjectMemoryEntry[]
}

/**
 * Context injected into Layer 4 of every agent system prompt
 * (section 8.2). Carries the live state of the workspace so the model
 * never has to ask "which run am I looking at?".
 */
export interface PromptContext {
  workspacePath: string
  trackerKind: "wandb" | "mlflow" | null
  projectName: string | null
  experimentCount: number
  activeExperiments: number
  budgetRemaining: { gpuHours: number; dollars: number }
  projectMemory: ProjectMemorySummary
  selectedRunId: string | null
  selectedRunMetrics: Record<string, number> | null
}

/**
 * Empty / placeholder `PromptContext` for callers that don't have
 * real workspace context yet (Phase-1 chat surface).
 *
 * The plan's `buildSystemPrompt(mode)` delegates to
 * `buildAgentSystemPrompt(role, buildEmptyContext())` so single-shot
 * chat paths still work without wiring up the workspace state.
 */
export function buildEmptyContext(): PromptContext {
  return {
    workspacePath: "(workspace not yet opened)",
    trackerKind: null,
    projectName: null,
    experimentCount: 0,
    activeExperiments: 0,
    budgetRemaining: { gpuHours: 0, dollars: 0 },
    projectMemory: { deadEnds: [], insights: [] },
    selectedRunId: null,
    selectedRunMetrics: null,
  }
}
