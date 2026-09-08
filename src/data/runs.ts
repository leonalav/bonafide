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
} from "./artifacts"
