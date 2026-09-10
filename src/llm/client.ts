/**
 * client.ts — Thin OpenAI-compatible Chat Completions client.
 *
 * This module is the *only* place in the renderer that talks to an
 * LLM endpoint. By keeping all network surface area here we get:
 *   - one place to add headers / auth / tracing
 *   - one place to swap in a different transport (Tauri command proxy,
 *     streaming reader, etc.) without touching the chat store or UI
 *   - one place to normalise reasoning content across providers
 *
 * Design notes:
 *
 *   - Buffered only. Streaming (SSE) is Phase 3. The request body
 *     always sends `stream: false`. When we add streaming, the
 *     `ChatRequest` type stays the same and `chatCompletion` gains a
 *     `stream: true` variant that yields chunks via an AsyncIterator.
 *
 *   - Provider reasoning normalisation. Different providers use
 *     different field names for their chain-of-thought. We probe in
 *     this order and pick the first non-empty value:
 *       1. `choices[0].message.reasoning_content`  (DeepSeek-R1)
 *       2. `choices[0].message.reasoning`          (OpenAI o-series)
 *       3. top-level `reasoning`                   (some Anthropic proxies)
 *     If none are present, `reasoning` is `undefined` and the chat
 *     layer omits the ReasoningArtifact.
 *
 *   - AbortSignal is respected end-to-end. A caller-supplied signal
 *     aborts the in-flight fetch and surfaces an `AbortError` so the
 *     chat store can revert status to `idle` without appending a
 *     partial assistant message.
 *
 *   - Errors are normalised. Network failures, HTTP non-2xx, malformed
 *     JSON, and aborts all surface as `Error` with a useful message.
 *     The chat store catches these and renders the error message
 *     inline on the failed assistant turn.
 */

import type { ModelEndpoint } from "../modelsStore";
import type {
  ApiChatMessage,
  ApiChatResponse,
  ApiChoice,
  ApiContentPart,
  ChatRequest,
  ChatResponse,
} from "./types";

const DEFAULT_TEMPERATURE = 0.2;

/**
 * Send one chat completion request and return the normalised reply.
 *
 * Throws:
 *   - `Error("No chat endpoint configured…")` when no endpoint is
 *     provided AND the request has no implicit default. Phase 1
 *     always passes a real endpoint from the chat store, so this
 *     branch only fires if a caller forgets to wire one up.
 *   - `DOMException` (AbortError) when the caller's signal aborts.
 *   - `Error("HTTP <status>: <body>")` for non-2xx responses, where
 *     `<body>` is the first 280 chars of the response text — long
 *     enough to surface a useful message, short enough to keep the
 *     chat error turn readable.
 *   - `Error("Network unreachable: <message>")` for fetch failures.
 *   - `Error("Malformed response: …")` when the JSON shape is broken.
 */
export async function chatCompletion(req: ChatRequest): Promise<ChatResponse> {
  if (!req.endpoint) {
    throw new Error(
      "No chat endpoint configured. Add one in Preferences → Models.",
    );
  }

  const url = buildCompletionsUrl(req.endpoint.baseUrl);
  const body = buildRequestBody(req);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(req.endpoint),
      body,
      signal: req.signal,
    });
  } catch (err) {
    // AbortError surfaces here — let the caller distinguish it without
    // wrapping. `DOMException.name === "AbortError"` is the canonical check.
    if (isAbortError(err)) throw err;
    throw new Error(
      `Network unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const snippet = text.length > 280 ? `${text.slice(0, 280)}…` : text;
    // REVIEW(opus) FINDING 8 [medium]: a bare "HTTP 401" gives the user
    // nothing to act on. Each status code gets a one-line hint that
    // points at the most likely remediation in Preferences → Models.
    const hint =
      res.status === 401
        ? " Check your API key in Preferences → Models."
        : res.status === 403
          ? " The API key may lack permissions for this model."
          : res.status === 404
            ? " Verify the base URL and model ID in Preferences → Models."
            : res.status === 429
              ? " Rate limited — try again in a moment."
              : "";
    throw new Error(
      `HTTP ${res.status} ${res.statusText}: ${snippet}${hint}`.trim(),
    );
  }

  let parsed: ApiChatResponse;
  try {
    parsed = (await res.json()) as ApiChatResponse;
  } catch (err) {
    throw new Error(
      `Malformed response: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return normaliseResponse(parsed);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compose the full chat/completions URL. We tolerate trailing slashes
 * on `baseUrl` (some providers add them, some don't) and we always
 * join with exactly one `/` between base and path.
 *
 * OpenAI's spec appends `/chat/completions` to a base like
 * `https://api.openai.com/v1`. LM Studio's is
 * `http://127.0.0.1:1234/v1`. vLLM is `http://host:port/v1`. All three
 * work with this normalisation.
 */
function buildCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return `${trimmed}/chat/completions`;
}

/**
 * Build the request body. We send exactly the fields the OpenAI
 * spec requires (`model`, `messages`, `stream`) plus an optional
 * `temperature`. Future fields (top_p, presence_penalty, tools) are
 * added here when their Phase-N work lands.
 *
 * `req.messages` uses the loose `string | ApiContentPart[]` union
 * per `ApiChatMessage.content`. Most turns are plain strings; turns
 * with attachments are arrays of text + image_url / file parts. We
 * pass them through verbatim — the JSON serialiser does the right
 * thing for either shape.
 */
function buildRequestBody(req: ChatRequest): string {
  const messages: ApiChatMessage[] = req.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const payload = {
    model: req.model,
    messages,
    stream: false,
    temperature: req.temperature ?? DEFAULT_TEMPERATURE,
  };
  return JSON.stringify(payload);
}

/**
 * Convert a `ChatMessage` (UI-side) into an `ApiChatMessage` with
 * attachments flattened into the OpenAI content-array shape.
 *
 * Used by the chat store to build the request body. When a message
 * has no attachments the output is the plain string form so we hit
 * the cheapest code path on the wire.
 */
export function buildApiChatMessage(
  m: { role: import("../chats/ChatStore").ChatRole; content: string; attachments?: import("../chats/ChatStore").Attachment[] },
): ApiChatMessage {
  if (!m.attachments || m.attachments.length === 0) {
    return { role: m.role, content: m.content };
  }
  const parts: ApiContentPart[] = [];
  if (m.content.length > 0) {
    parts.push({ type: "text", text: m.content });
  }
  for (const a of m.attachments) {
    if (a.kind === "image") {
      parts.push({
        type: "image_url",
        image_url: { url: a.dataUrl, detail: "auto" },
      });
    } else {
      parts.push({
        type: "file",
        file: { filename: a.name, file_data: a.dataUrl },
      });
    }
  }
  return { role: m.role, content: parts };
}

function buildHeaders(endpoint: ModelEndpoint): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  // Some local endpoints (LM Studio with `--no-api-key`) reject
  // Authorization headers. Skip the header entirely when the key is
  // empty so we don't break those setups.
  if (endpoint.apiKey && endpoint.apiKey.length > 0) {
    headers.Authorization = `Bearer ${endpoint.apiKey}`;
  }
  return headers;
}

/**
 * Extract the content + reasoning from the first choice. If the
 * response carries zero choices we treat it as malformed — that
 * usually means a proxy stripped the body or the model rejected the
 * conversation for policy reasons and returned only an error payload.
 */
function normaliseResponse(res: ApiChatResponse): ChatResponse {
  const first: ApiChoice | undefined = res.choices?.[0];
  if (!first) {
    // REVIEW(opus) FINDING 9 [low]: a 200 with `choices: []` is often
    // a provider returning a policy rejection or an error payload
    // instead of choices. We surface whichever the provider gave us so
    // the user gets a real reason rather than a generic shape error.
    const errPayload = (res as unknown as {
      error?: { message?: string; code?: string };
    }).error;
    if (errPayload?.message) {
      throw new Error(`Provider rejected request: ${errPayload.message}`);
    }
    throw new Error("Malformed response: no choices returned.");
  }

  const message = first.message ?? {};
  const content = (message.content ?? "").toString();

  // Probe reasoning fields in provider-order. Empty strings and `null`
  // both fall through to the next probe.
  const reasoning =
    nonEmpty(message.reasoning_content) ??
    nonEmpty(message.reasoning) ??
    nonEmpty(
      // top-level `reasoning` field used by some Anthropic-compatible proxies
      (res as unknown as { reasoning?: string | null }).reasoning,
    );

  return {
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(res.usage ? { usage: res.usage } : {}),
  };
}

function nonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    err.name === "AbortError"
  );
}
