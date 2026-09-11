/**
 * chat/types.ts — Shared chat-layer types that cross module boundaries.
 *
 * `ModeId` is the canonical identifier for the five agent roles.
 * The renderer-friendly label (e.g. "Debug") is derived from the
 * same identifier by `MODE_META` — there is exactly one source of
 * truth for "which modes exist" and "what each mode is called".
 *
 * The identifier (`debugger`, `scaffolder`, `planner`, `researcher`,
 * `critic`) is wire-compatible with the Rust `AgentRole` enum
 * (`src-tauri/src/agent/orchestrator.rs`) which `#[serde]`
 * serialises as snake_case. Keep them aligned.
 */

export type ModeId = "debugger" | "scaffolder" | "planner" | "researcher" | "critic"

export const MODE_META: {
  id: ModeId
  icon: string
  label: string
  desc: string
}[] = [
  {
    id: "debugger",
    icon: "search",
    label: "Debug",
    desc: "Investigate run divergences, crashes, and regressions",
  },
  {
    id: "scaffolder",
    icon: "box",
    label: "Scaffold",
    desc: "Generate complete, runnable project structures for ML training",
  },
  {
    id: "planner",
    icon: "line-chart",
    label: "Plan",
    desc: "Draft hypothesis-driven experiment sequences and timelines",
  },
  {
    id: "researcher",
    icon: "package",
    label: "Research",
    desc: "Cross-reference arXiv papers and gather evidence for decisions",
  },
  {
    id: "critic",
    icon: "shield",
    label: "Critic",
    desc: "Review proposals for correctness, safety, and ML best practices",
  },
]

/**
 * Backwards-compatibility export: a few older callers (Composer,
 * ChatStore) used the shorthand `debug | scaffold | plan | research`
 * labels. We re-map those to the new canonical ids. Anything not
 * recognised falls back to `debugger` so the legacy callers still
 * compile and behave sanely.
 */
export function toCanonicalModeId(value: string | null | undefined): ModeId {
  switch (value) {
    case "debugger":
    case "debug":
      return "debugger"
    case "scaffolder":
    case "scaffold":
      return "scaffolder"
    case "planner":
    case "plan":
      return "planner"
    case "researcher":
    case "research":
      return "researcher"
    case "critic":
      return "critic"
    default:
      return "debugger"
  }
}

/** Resolve the icon + label + desc by id. Defaults to the Debugger row. */
export function getModeMeta(id: ModeId | string) {
  const canonical = toCanonicalModeId(id)
  return (
    MODE_META.find((m) => m.id === canonical) ?? {
      id: canonical,
      icon: "search",
      label: "Agent",
      desc: "General agent mode",
    }
  )
}
