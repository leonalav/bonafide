/**
 * chat/types.ts — Shared chat-layer types that cross module boundaries.
 *
 * `ModeId` is shared between the Composer (which owns the mode picker UI)
 * and the chat surface (which needs to pass it to `createThread`). We
 * define it here so both modules import from the same source of truth
 * rather than each declaring their own copy.
 */

export type ModeId = "debug" | "scaffold" | "plan" | "research" | "multitask"

export const MODES: {
  id: ModeId
  icon: string
  label: string
  desc: string
  status?: "deferred" | "design"
}[] = [
  {
    id: "debug",
    icon: "search",
    label: "Debug",
    desc: "Investigate run divergences and trace root causes",
  },
  {
    id: "scaffold",
    icon: "box",
    label: "Scaffold",
    desc: "Generate project structure and boilerplate code",
  },
  {
    id: "plan",
    icon: "line-chart",
    label: "Plan",
    desc: "Draft experiment timelines and resource estimates",
    status: "deferred",
  },
  {
    id: "research",
    icon: "package",
    label: "Research",
    desc: "Cross-reference papers and gather evidence",
    status: "deferred",
  },
  {
    id: "multitask",
    icon: "layers",
    label: "Multitask",
    desc: "Coordinate multiple agents across a shared goal",
    status: "design",
  },
]
