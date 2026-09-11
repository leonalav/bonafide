/**
 * planner.ts — TypeScript types mirroring the Rust planner types.
 */

import type { GoalCondition, GoalDirection } from "./experiments"

export interface ProposeExperimentInput {
  title: string
  hypothesis: string
  goalMetric: string
  goalDirection: GoalDirection
  goalTarget: number
  goalCondition: GoalCondition
  budgetDollars: number
  budgetGpuHours: number
}

export interface ProposeExperimentOutput {
  experimentId: string
  title: string
  escalation: string
  withinBudget: boolean
}
