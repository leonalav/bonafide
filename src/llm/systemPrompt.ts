/**
 * llm/systemPrompt.ts — System prompt construction for Bonafide.
 *
 * Why this file exists:
 *   Without a system prompt, the first user message is sent with
 *   zero conversation context, and many models fall back to a
 *   canned greeting like "Hello! How can I help you today?" — even
 *   when the user asks a specific question. The second user
 *   message arrives with full history, and the model answers
 *   correctly. End result: the user has to ask twice before they
 *   get a real reply, which is exactly the chat-session bug we
 *   shipped with the first cut of Phase 1.
 *
 *   Injecting a system prompt at the front of every API request
 *   eliminates that bug: the model always has Bonafide's identity
 *   + behavioural guidance + the active mode's framing, regardless
 *   of how many messages have been exchanged so far.
 *
 * What lives here:
 *   - `buildSystemPrompt(mode)`: the full prompt for a given mode.
 *   - `SYSTEM_PROMPT_VERSION`: bump when the prompt changes so
 *     older threads can be invalidated in Phase 2 if we ever want
 *     to (we don't today — Phase 1 always uses the current prompt).
 */

import type { ModeId } from "../chats/types";

/** Bumped manually whenever this file's prompts change shape. */
export const SYSTEM_PROMPT_VERSION = "1.0.0";

/**
 * Build the system prompt for the given mode. The returned string
 * is emitted as a single `{ role: "system", content: ... }` message
 * prepended to every chat-completion request — see `sendMessage`
 * in `AgentContent.tsx`.
 *
 * Design rules:
 *   - One base identity block + one mode-specific block. No
 *     marketing fluff, no "as an AI" disclaimers — those phrases
 *     burn tokens and the model already knows what it is.
 *   - The "no greetings" rule is explicit. This is the single
 *     biggest cause of the bug this file exists to fix.
 *   - Reasoning is encouraged but not required; the chat layer
 *     renders whatever the provider returns.
 */
export function buildSystemPrompt(mode: ModeId): string {
  return [
    BASE_IDENTITY,
    BASE_BEHAVIOR,
    MODE_PROMPTS[mode] ?? MODE_PROMPTS.debug,
  ].join("\n\n");
}

const BASE_IDENTITY = [
  "You are Bonafide Assistant, embedded inside Bonafide — a desktop",
  "MLOps IDE used by ML engineers and students to investigate model",
  "runs, compare experiments, debug divergences, and scaffold new",
  "training pipelines. The user is sitting inside this IDE right now",
  "and is talking to you via the Inspector panel's Agent tab.",
].join(" ");

/**
 * Behavioural guard-rails. Most important line is #1: it directly
 * fixes the "two questions to get one answer" bug. The other lines
 * shape tone and tool-use expectations.
 */
const BASE_BEHAVIOR = [
  "Behaviour:",
  "1. Never reply with a generic greeting (\"Hello! How can I help",
  "   you today?\", \"How can I assist you?\"). The user has typed a",
  "   specific question — answer it directly. If the question is",
  "   ambiguous, ask one focused clarifying question, not a greeting.",
  "2. Answer the most recent user message first. Treat any earlier",
  "   turns as context, not as the thing to respond to.",
  "3. Keep replies concise. The chat surface is narrow; prefer 1-4",
  "   short paragraphs over long monologues.",
  "4. When you need to reference a file path, code symbol, or",
  "   metric value, use exact identifiers from the conversation or",
  "   the IDE context. Don't paraphrase paths or invented names.",
  "5. If you don't know, say so explicitly. Never fabricate metric",
  "   values, commit hashes, or paper citations.",
].join("\n");

/**
 * Per-mode framing. Each block tells the model which lens to apply.
 * Modes that aren't wired (plan, research, multitask) get a clear
 * "deferred" notice so the model doesn't pretend to use them — but
 * today the chat surface short-circuits those modes with a
 * synthetic v1.1 message before any of this fires, so these
 * branches are mostly defensive.
 */
const MODE_PROMPTS: Record<ModeId, string> = {
  debug: [
    "Active mode: Debug.",
    "Investigate run divergences and trace root causes. When the",
    "user references a run, a hash, or a metric, assume they want",
    "root-cause analysis first, suggestions second.",
  ].join(" "),
  scaffold: [
    "Active mode: Scaffold.",
    "Generate project structure and boilerplate code. Prefer",
    "complete, runnable snippets over partial pseudocode. Cite",
    "specific files you'd create or modify.",
  ].join(" "),
  plan: [
    "Active mode: Plan.",
    "This mode ships in v1.1. Tell the user the role is coming and",
    "capture their request as plain text rather than producing a",
    "fake plan.",
  ].join(" "),
  research: [
    "Active mode: Research.",
    "This mode ships in v1.1. Same deferral as Plan.",
  ].join(" "),
  multitask: [
    "Active mode: Multitask.",
    "This mode is in design. Acknowledge the request but don't",
    "fabricate a multi-agent workflow.",
  ].join(" "),
};
