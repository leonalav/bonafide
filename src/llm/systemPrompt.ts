/**
 * llm/systemPrompt.ts — System prompt construction for Bonafide.
 *
 * ## Why this file exists
 *
 * Without a system prompt, the first user message is sent with zero
 * conversation context, and many models fall back to a canned greeting
 * like "Hello! How can I help you today?" — even when the user asks a
 * specific question. The second user message arrives with full history,
 * and the model answers correctly. End result: the user has to ask
 * twice before they get a real reply.
 *
 * Injecting a system prompt at the front of every API request
 * eliminates that bug: the model always has Bonafide's identity +
 * behavioural guidance + the active mode's framing, regardless of how
 * many messages have been exchanged so far.
 *
 * ## What lives here
 *
 * - `buildSystemPrompt(mode)`: backward-compatible single-shot path
 *   used by the chat surface. Delegates to `buildAgentSystemPrompt`.
 * - `buildAgentSystemPrompt(role, context)`: the full 4-layer prompt
 *   per `docs/agent-architecture.md` section 8.2.
 * - `SYSTEM_PROMPT_VERSION`: bump when the prompt changes shape.
 * - `SYSTEM_PROMPT_PROTOCOL_VERSION`: mirrors Rust's tool-call version
 *   so both sides can assert compatibility.
 * - `SYSTEM_PROMPT_PROVENANCE`: tracks which workspace generated this
 *   prompt (used by the `[prompt:X]` invisible comment per Appendix C).
 *
 * ## 4-layer structure (section 8.1)
 *
 * Layer 1: IDENTITY       — role-specific opening sentence
 * Layer 2: BEHAVIORAL     — universal guard-rails shared across modes
 * Layer 3: MODE           — per-role investigation protocol
 * Layer 4: CONTEXT        — workspace state, project memory, budget
 *
 * Every layer is tagged with a `// Layer N: <label>` header in the
 * returned string so future audits can grep for the structural markers.
 */

import { MODE_INSTRUCTIONS } from "./prompts"

import type { ModeId } from "../chats/types"

import type {
  AgentRole,
  PromptContext,
} from "./types"

import { buildEmptyContext } from "./types"

// ── Versioning ────────────────────────────────────────────────────────────────

/** Bumped manually whenever this file's prompts change shape. */
export const SYSTEM_PROMPT_VERSION = "1.2.0"

/**
 * Mirrors `TOOL_CALL_PROTOCOL_VERSION` so the renderer and the
 * Rust engine agree on the wire version they can speak.
 */
export const SYSTEM_PROMPT_PROTOCOL_VERSION = "openai/v1"

/**
 * Provenance marker for the prompt — written into the
 * `[prompt:X]` invisible comment per `docs/agent-architecture.md`
 * Appendix C. Increments when the construction site moves (e.g.
 * `bonafide/ws2` for the post-WS2 prompts).
 */
export const SYSTEM_PROMPT_PROVENANCE = "bonafide/ws1"

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the system prompt for the given chat-surface mode. The
 * returned string is emitted as a single `{ role: "system",
 * content: ... }` message prepended to every chat-completion
 * request — see `sendMessage` in `AgentContent.tsx`.
 *
 * The body is identical to the agent-loop prompt: we delegate to
 * `buildAgentSystemPrompt(deriveRoleFromMode(mode), buildEmptyContext())`
 * so single-shot chat paths and the ReAct loop share one
 * construction site.
 *
 * Backwards-compatibility note: callers (`AgentContent.tsx`,
 * `Composer.tsx`) keep importing `buildSystemPrompt(mode)` so this
 * signature is preserved verbatim.
 */
export function buildSystemPrompt(mode: ModeId): string {
  return buildAgentSystemPrompt(deriveRoleFromMode(mode), buildEmptyContext())
}

/**
 * Build the full 4-layer agent system prompt (section 8.2).
 *
 * The four layers are joined with blank lines and tagged with
 * `// Layer N: <label>` markers so audits can grep for them.
 * The final line carries an invisible `[prompt:VERSION]` comment
 * per Appendix C — it is rendered as part of the user-visible
 * content by some providers, hidden by others; either way it
 * survives round-trips so the renderer can identify which
 * prompt version produced a given thread.
 */
export function buildAgentSystemPrompt(
  role: AgentRole,
  ctx: PromptContext,
): string {
  const layers = [
    `// Layer 1: IDENTITY\n${buildIdentity(role)}`,
    `// Layer 2: BEHAVIORAL RULES\n${BEHAVIORAL_RULES}`,
    `// Layer 3: MODE-SPECIFIC INSTRUCTIONS\n${buildModeInstructions(role)}`,
    `// Layer 4: CONTEXT INJECTION\n${buildContextInjection(ctx)}`,
  ]

  const body = layers.join("\n\n")
  return `${body}\n\n[prompt:${SYSTEM_PROMPT_VERSION}]`
}

// ── Mode-derivation helper ──────────────────────────────────────────────────

/**
 * Map a `ModeId` (chat-surface shorthand) to the canonical
 * `AgentRole` (section-5.1 spec name).
 *
 * `multitask` is not a real agent role — it stays in the picker
 * because the chat surface renders it as a "in design" placeholder,
 * but for system-prompt purposes we map it to the closest active
 * mode (`researcher`) so the prompt still has identity and
 * behavioural guidance. This avoids the chat surface regressing
 * to the empty-state greeting when a user picks the deferred mode.
 */
export function deriveRoleFromMode(mode: ModeId): AgentRole {
  switch (mode) {
    case "debug":
      return "debugger"
    case "scaffold":
      return "scaffolder"
    case "plan":
      return "planner"
    case "research":
      return "researcher"
    case "multitask":
      // Phase 0 fallback — closest existing role.
      return "researcher"
  }
}

// ── Layer 1: Identity ────────────────────────────────────────────────────────

function buildIdentity(role: AgentRole): string {
  const identities: Record<AgentRole, string> = {
    debugger: [
      "You are the Bonafide Debugger, an ML debugging specialist",
      "embedded inside Bonafide MLOps IDE. You investigate run",
      "divergences, crashes, and performance regressions.",
    ].join(" "),
    scaffolder: [
      "You are the Bonafide Scaffolder, an ML project generation",
      "specialist. You create complete, runnable project structures.",
    ].join(" "),
    planner: [
      "You are the Bonafide Planner, an ML experiment strategist.",
      "You design experiment sequences that maximize information",
      "gain per GPU dollar.",
    ].join(" "),
    researcher: [
      "You are the Bonafide Researcher, an ML research specialist.",
      "You gather evidence from papers, code, and documentation.",
    ].join(" "),
    critic: [
      "You are the Bonafide Critic, a quality gate for ML code",
      "and experiments. You review proposals for correctness and",
      "ML best practices.",
    ].join(" "),
  }
  return identities[role]
}

// ── Layer 2: Behavioural rules ───────────────────────────────────────────────

const BEHAVIORAL_RULES = [
  "Behaviour:",
  '1. Never reply with a generic greeting ("Hello! How can I help',
  '   you today?", "How can I assist you?"). The user has typed a',
  "   specific question — answer it directly. If the question is",
  "   ambiguous, ask one focused clarifying question, not a greeting.",
  "2. Answer the most recent user message first. Treat any earlier",
  "   turns as context, not as the thing to respond to.",
  "3. Keep replies concise. The chat surface is narrow; prefer 1-4",
  "   short paragraphs over long monologues.",
  "4. Never fabricate metric values, run IDs, or paper citations.",
  "   If you don't have the data, say so and use a tool to get it.",
  "5. Always reference specific run IDs, step numbers, and metric values.",
  "   Bad: 'the loss looks high'. Good: 'val_loss=0.89 at step 5000'.",
  "6. Never suggest re-running with the same config. That wastes GPU hours.",
  "7. Never modify code without showing the diff first.",
  "8. Never delete checkpoints, overwrite configs, or discard git history.",
  "9. If you need to run compute (training, evaluation), always state the",
  "   estimated cost and get approval first.",
  "10. When uncertain, say so. 'I'm not sure about X' is better than",
  "    a confident wrong answer that wastes 4 GPU hours.",
  "11. End every investigation with: what you found, what you tried,",
  "    what worked, what didn't, and what to try next.",
].join("\n")

// ── Layer 3: Mode-specific instructions ───────────────────────────────────────

function buildModeInstructions(role: AgentRole): string {
  const body = MODE_INSTRUCTIONS[role]
  if (!body || body.length === 0) {
    // Defensive — should be impossible because every role is
    // populated in MODE_INSTRUCTIONS. Surface a clear placeholder
    // so a future mode addition can't silently ship an empty layer.
    return `// TODO: missing instructions for role "${role}" — see src/llm/prompts/.`
  }
  return body
}

// ── Layer 4: Context injection ────────────────────────────────────────────────

/**
 * Render the live workspace state into a deterministic string block.
 *
 * Truncation rules mirror the engine's tier-1 cap (~5K chars): the
 * prompt stays under the model's effective context window even when
 * project memory is full.
 */
function buildContextInjection(ctx: PromptContext): string {
  const parts: string[] = []

  parts.push(`Workspace: ${ctx.workspacePath}`)

  if (ctx.trackerKind) {
    parts.push(
      `Tracker: ${ctx.trackerKind} (${ctx.projectName ?? "unknown project"})`,
    )
  }

  if (ctx.selectedRunId) {
    parts.push(`Selected run: ${ctx.selectedRunId}`)
    if (ctx.selectedRunMetrics) {
      // Round to 4 decimals so the prompt stays stable for cache hits.
      const metrics = Object.fromEntries(
        Object.entries(ctx.selectedRunMetrics).map(([k, v]) => [
          k,
          typeof v === "number" ? Number(v.toFixed(4)) : v,
        ]),
      )
      parts.push(`Run metrics: ${JSON.stringify(metrics)}`)
    }
  }

  parts.push(
    `Experiments: ${ctx.experimentCount} total, ${ctx.activeExperiments} active`,
  )
  parts.push(
    `Budget remaining: ${ctx.budgetRemaining.gpuHours}h GPU, $${ctx.budgetRemaining.dollars}`,
  )

  // Tools list (names + safety level only — full schemas live in
  // ChatRequest.tools per WS1-T3). Empty when no tools are registered.
  // Phase 0: no tools wired, so this stays minimal.
  parts.push(`Tools: (none registered yet — WS2-T1 will populate)`)

  if (ctx.projectMemory.deadEnds.length > 0) {
    parts.push(`\nKnown dead ends (do NOT repeat these):`)
    for (const de of ctx.projectMemory.deadEnds) {
      const marker = de.marker ? ` (${de.marker})` : ""
      parts.push(`  - ${de.label} → ${de.evidence}${marker}`)
    }
  }

  if (ctx.projectMemory.insights.length > 0) {
    parts.push(`\nProject insights:`)
    for (const ins of ctx.projectMemory.insights) {
      const marker = ins.marker ? ` (confidence: ${ins.marker})` : ""
      parts.push(`  - ${ins.label}${marker}`)
    }
  }

  // Truncate to the engine's tier-1 cap (~5K chars). Project memory
  // is the largest variable, so we slice from the end (most recent).
  const MAX_LAYER_LEN = 5_000
  const joined = parts.join("\n")
  if (joined.length <= MAX_LAYER_LEN) return joined
  // Keep the first MAX_LAYER_LEN-3 chars and append "..." so the
  // total length is at most MAX_LAYER_LEN.
  const truncated = joined.slice(0, MAX_LAYER_LEN - 3)
  return `${truncated}...`
}
