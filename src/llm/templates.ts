/**
 * templates.ts — Agent role templates.
 *
 * Centralised in one file per the Phase 0 architecture plan.
 * Consumed by WorkflowPanel.tsx and data/agents.ts.
 */

import type { AgentRole } from "../data/agents"

export type Template = {
  role: AgentRole
  title: string
  desc: string
  soon?: boolean
  emptyOnly?: boolean
  isDefault?: boolean
}

export const TEMPLATES: Template[] = [
  {
    role: "debugger",
    title: "Diagnose run divergence",
    desc: "Bind to a run, trace metrics vs the best prior run.",
    isDefault: true,
  },
  {
    role: "debugger",
    title: "Compare K runs",
    desc: "Multi-run differential diagnosis.",
  },
  {
    role: "scaffolder",
    title: "Start a new project from spec",
    desc: "Generate project structure and boilerplate code.",
  },
  {
    role: "planner",
    title: "Sequence experiments",
    desc: "Plan experiments across N runs with goals and budgets.",
  },
  {
    role: "researcher",
    title: "Cross-reference artifacts",
    desc: "Cross-reference artifacts / papers.",
    soon: true,
  },
]
