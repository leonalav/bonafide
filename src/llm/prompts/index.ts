/**
 * prompts/index.ts — Barrel export for per-mode prompt files.
 *
 * The split into per-mode files is for maintainability, not runtime
 * performance — the bundler tree-shakes unused modes so this layer
 * costs zero bytes when only one mode is referenced.
 *
 * The `MODE_INSTRUCTIONS` record is the canonical mapping consumed by
 * `systemPrompt.ts`. Tests assert every mode has a non-empty
 * instruction string.
 */

import { debuggerInstructions } from "./debugger"
import { scaffolderInstructions } from "./scaffolder"
import { plannerInstructions } from "./planner"
import { researcherInstructions } from "./researcher"
import { criticInstructions } from "./critic"

import type { AgentRole } from "../types"

export const MODE_INSTRUCTIONS: Record<AgentRole, string> = {
  debugger: debuggerInstructions,
  scaffolder: scaffolderInstructions,
  planner: plannerInstructions,
  researcher: researcherInstructions,
  critic: criticInstructions,
}

export {
  debuggerInstructions,
  scaffolderInstructions,
  plannerInstructions,
  researcherInstructions,
  criticInstructions,
}
