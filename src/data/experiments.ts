/**
 * experiments.ts — TypeScript types mirroring the Rust `ExperimentRow` and
 * `ExperimentRunRow` from `src-tauri/src/agent/experiments.rs`.
 *
 * These types are the wire shape between the Tauri backend and the renderer.
 * All values are plain JSON — no class wrapping needed.
 */

export type GoalCondition = "lt" | "gt" | "eq"

export type GoalDirection = "minimize" | "maximize"

export type ExperimentStatus = "proposed" | "running" | "completed" | "failed" | "abandoned"

export type RunStatus = "queued" | "running" | "success" | "failed"

/** One experiment record. Matches `agent::experiments::ExperimentRow`. */

export interface Experiment {
  id: string

  title: string

  hypothesis: string

  goalMetric: string

  goalDirection: GoalDirection

  goalTarget: number

  goalCondition: GoalCondition

  status: ExperimentStatus

  budgetDollars: number

  budgetGpuHours: number

  createdAt: number // Unix seconds

  updatedAt: number // Unix seconds
}

/** One run within an experiment. Matches `agent::experiments::ExperimentRunRow`. */

export interface ExperimentRun {
  id: string

  experimentId: string

  runId: string

  /** JSON-encoded config overrides applied to this run. */

  configOverrides: string

  status: RunStatus

  /** JSON-encoded metrics summary reported back from the tracker. */

  metricsSummary: string

  createdAt: number // Unix seconds
}

/** Helper to build a new Experiment with sensible defaults. */

export function makeExperiment(
  params: Partial<Experiment> & { id: string title: string hypothesis: string },
): Experiment {
  const now = Math.floor(Date.now() / 1000)

  return {
    goalMetric: "",

    goalDirection: "maximize",

    goalTarget: 0,

    goalCondition: "gt",

    status: "proposed",

    budgetDollars: 10.0,

    budgetGpuHours: 4.0,

    createdAt: now,

    updatedAt: now,

    ...params,
  }
}

/** Helper to build a new ExperimentRun with sensible defaults. */

export function makeExperimentRun(
  params: Partial<ExperimentRun> & {
    id: string
    experimentId: string
    runId: string
  },
): ExperimentRun {
  const now = Math.floor(Date.now() / 1000)

  return {
    configOverrides: "{}",

    status: "queued",

    metricsSummary: "{}",

    createdAt: now,

    ...params,
  }
}
