/**
 * runs.ts — re-exports the design artifacts from data/artifacts.ts.
 *
 * All panels used to import run/tracker mock data from here.
 * `data/runs.ts` was replaced with `data/artifacts.ts` when the
 * workspace refactor removed all mock data.
 *
 * Re-export so existing imports continue to type-check. These are all
 * design artifacts — the real run-tracker types will live here once
 * a backend (W&B / MLflow) is wired in.
 */
export {
  type Run,
  type RunState,
  type Metric,
  type Experiment,
  type ExperimentStatus,
  type WorkspaceArtifact,
  type Artifact,
  type ArtifactKind,
  type FileChange,
  type ChangeStatus,
  type CodeLine,
  type Tok,
  RUNS,
  STATE_META,
  EXPERIMENTS,
  EXPERIMENT_STATUS_META,
  WORKSPACE_ARTIFACTS,
  ARTIFACTS,
  ARTIFACT_KIND_META,
  TRAIN_PY,
  WORKSPACES,
  GIT_STATE,
  series as generateSeries,
} from "./artifacts";

// ── useRuns hook ────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from "react";
import { bonafide } from "../ipc/tauri";
import type { RunSummary, RunPage } from "../ipc/tauri";

export type UseRunsResult = {
  runs: RunSummary[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
};

/**
 * Fetch runs for a W&B project from the Tauri backend.
 *
 * Falls back to an empty list on error (does not throw) so the caller
 * can render an empty/error state without crashing.
 *
 * @param projectName     — W&B project name, e.g. "bonafide-train"
 * @param workspaceRoot   — Absolute path of the open workspace (used as the
 *                         Rust command context; the tracker resolves the
 *                         project name against the workspace's connected
 *                         W&B entity).
 */
export function useRuns(projectName: string, workspaceRoot: string): UseRunsResult {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page: RunPage = await bonafide.tracker.listRuns(projectName, 50, undefined);
      setRuns(page.runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [projectName]);

  useEffect(() => {
    void fetchRuns();
  }, [fetchRuns]);

  return { runs, loading, error, refetch: fetchRuns };
}
