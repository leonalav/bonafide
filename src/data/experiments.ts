/**
 * experiments.ts ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â TypeScript types for the Phase 2 experiment storage
 * layer. Mirrors the Rust `ExperimentRow` / `ExperimentRunRow` structs
 * in `src-tauri/src/agent/experiments.rs` so the renderer's typed
 * shape and the orchestrator's persisted row share one source of
 * truth.
 *
 * These types are referenced by the Experiments tab UI and the IPC
 * wrappers in `src/ipc/tauri.ts`. Any new field added on the Rust side
 * must be mirrored here; otherwise the renderer will silently drop it
 * on the `invoke` round-trip.
 */

/** Lifecycle status of an experiment. Mirrors the renderer-side
 *  filter chips on the Experiments tab. */
export type ExperimentStatus =
  | "proposed"
  | "active"
  | "completed"
  | "failed"
  | "paused";

/** Comparison operator used to decide whether a run's metric value
 *  satisfies the experiment's goal. Combined with `goalDirection` this
 *  fully describes "improve X toward Y" without needing a parser. */
export type GoalCondition = "lt" | "gt" | "eq";

/** Persisted shape of an Experiment row. Returned by
 *  `list_experiments` / `get_experiment` and accepted by
 *  `create_experiment` / `update_experiment`. All fields live on the
 *  wire shape because the Experiments tab reads them straight back
 *  from SQLite when rendering the detail view. */
export type ExperimentRow = {
  id: string;
  workspaceHash: string;
  title: string;
  hypothesis: string;
  goalMetric: string;
  goalDirection: "minimize" | "maximize";
  goalTarget: number;
  goalCondition: GoalCondition;
  status: ExperimentStatus;
  budgetDollars: number;
  budgetGpuHours: number;
  /** Unix millis ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the renderer formats "12s ago" relative labels from
   *  this so a single `SELECT ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ ORDER BY updated_at DESC` powers both
   *  the inbox ordering and the "last edited" pill. */
  createdAt: number;
  updatedAt: number;
};

/** Status of a linked tracking run attached to an experiment. The
 *  lifecycle mirrors the tracker's run state ("queued" ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ "running" ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢
 *  "completed" / "failed") so the Experiments tab can render a status
 *  pill without round-tripping to the tracker. */
export type ExperimentRunStatus = "queued" | "running" | "completed" | "failed";
/// Persisted shape of an ExperimentRun attachment row.
/// `config_overrides` and `metrics_summary` are serialised JSON strings
/// stored as TEXT in SQLite. Callers MUST pass these as already-stringified
/// JSON (e.g. `JSON.stringify({...})`). The `listExperimentRuns` return
/// value also contains strings — callers must `JSON.parse` before using as objects.
export type ExperimentRunRow = {
  id: string;
  experimentId: string;
  runId: string;
  configOverrides: string;
  metricsSummary: string;
  status: ExperimentRunStatus;
  /** Unix millis ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â older links come first in the timeline so the
   *  renderer can render a chronological "Runs" column on the
   *  experiment card. */
  createdAt: number;
};