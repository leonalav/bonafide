/**
 * artifacts.ts — Design artifacts preserved from the prototype.
 *
 * This file holds the visual mock data from the original demo: the
 * `bright-mountain-7` running run with its `loss` / `val_loss` / `acc` /
 * `lr` metric cards, the artifacts panel rows, the experiments list,
 * the workspace layout, the Git source-control snapshot, and the
 * tokenized `train.py` lines that the editor used to render with
 * inline run anchors.
 *
 * It is **not** consumed by the renderer anymore. The IDE is now
 * filesystem-backed: `src/ide/store.tsx` reads directories through
 * `window.electronAPI.fs`, and the inspector / charts / experiments
 * panels show an honest empty state until real run data is wired in.
 *
 * When run tracking lands (MLflow / W&B / a local SQLite log), copy
 * the relevant shape from here into a new `data/runs.ts` and have the
 * panels re-import from there. The card layouts in `<Inspector />`
 * already key off the `Run` type defined below — keep that type
 * stable when you bring runs back.
 *
 * ─────────────────────────────────────────────────────────────────────
 * To restore the demo:
 *   1. `mv src/data/artifacts.ts src/data/runs.ts`
 *   2. Re-import `RUNS` in App.tsx, Inspector.tsx, Sidebar.tsx,
 *      RunTimeline.tsx, and the panels/* views.
 *   3. Delete the `EmptyState` branches those files have today.
 * ─────────────────────────────────────────────────────────────────────
 */

export type RunState = "running" | "finished" | "failed" | "crashed" | "queued"

export type Metric = {
  key: string
  label: string
  value: number
  /** Negative = improvement for loss-like metrics; see `lowerIsBetter`. */
  delta: number
  lowerIsBetter: boolean
  series: number[]
}

export type Run = {
  id: string
  name: string
  shortHash: string
  state: RunState
  duration: string
  commit: string
  branch: string
  createdLabel: string
  group: "Today" | "Yesterday"
  step: number
  totalSteps: number
  metrics: Metric[]
  env: { python: string framework: string gpu: string }
  config: Record<string, string | number>
}

// Deterministic series generator so sparklines look organic but stable.
// Pass a different `seed` per metric so they don't overlap.
// Exported so test/dev tooling can regenerate series without duplicating
// the noise formula.
export function series(seed: number, n = 32, trend = -1): number[] {
  const out: number[] = []
  let v = 1
  for (let i = 0; i < n; i++) {
    const noise =
      Math.sin(seed + i * 0.9) * 0.06 + Math.cos(seed * 1.7 + i * 0.3) * 0.04
    v += (trend * 0.9) / n + noise * 0.5
    out.push(Math.max(0.02, v))
  }
  return out
}

export const RUNS: Run[] = [
  {
    id: "r1",
    name: "bright-mountain-7",
    shortHash: "bright-mt-7",
    state: "running",
    duration: "4m12s",
    commit: "a3f9c12",
    branch: "main",
    createdLabel: "2h ago",
    group: "Today",
    step: 8420,
    totalSteps: 20000,
    metrics: [
      {
        key: "loss",
        label: "loss",
        value: 0.42,
        delta: -0.07,
        lowerIsBetter: true,
        series: series(1, 32, -1),
      },
      {
        key: "val_loss",
        label: "val_loss",
        value: 0.31,
        delta: -0.04,
        lowerIsBetter: true,
        series: series(3, 32, -1),
      },
      {
        key: "acc",
        label: "acc",
        value: 0.89,
        delta: 0.02,
        lowerIsBetter: false,
        series: series(2, 32, 1),
      },
      {
        key: "lr",
        label: "lr",
        value: 0.0005,
        delta: 0,
        lowerIsBetter: true,
        series: series(9, 32, -0.4),
      },
    ],
    env: {
      python: "3.11.4",
      framework: "PyTorch 2.2.1",
      gpu: "NVIDIA A100 80GB",
    },
    config: {
      lr: "5e-4",
      batch_size: 128,
      optimizer: "AdamW",
      weight_decay: "1e-5",
      epochs: 50,
    },
  },
  {
    id: "r2",
    name: "quiet-river-12",
    shortHash: "quiet-rv-12",
    state: "finished",
    duration: "6m08s",
    commit: "8b2a4f0",
    branch: "main",
    createdLabel: "3h ago",
    group: "Today",
    step: 20000,
    totalSteps: 20000,
    metrics: [
      {
        key: "loss",
        label: "loss",
        value: 0.51,
        delta: 0.09,
        lowerIsBetter: true,
        series: series(5, 32, -0.8),
      },
      {
        key: "val_loss",
        label: "val_loss",
        value: 0.49,
        delta: 0.18,
        lowerIsBetter: true,
        series: series(7, 32, -0.7),
      },
      {
        key: "acc",
        label: "acc",
        value: 0.84,
        delta: -0.03,
        lowerIsBetter: false,
        series: series(6, 32, 1),
      },
      {
        key: "lr",
        label: "lr",
        value: 0.001,
        delta: 0,
        lowerIsBetter: true,
        series: series(11, 32, -0.4),
      },
    ],
    env: {
      python: "3.11.4",
      framework: "PyTorch 2.2.1",
      gpu: "NVIDIA A100 80GB",
    },
    config: {
      lr: "1e-3",
      batch_size: 64,
      optimizer: "AdamW",
      weight_decay: "1e-4",
      epochs: 50,
    },
  },
  {
    id: "r3",
    name: "swift-falcon-3",
    shortHash: "swift-fl-3",
    state: "finished",
    duration: "5m44s",
    commit: "8b2a4f0",
    branch: "main",
    createdLabel: "5h ago",
    group: "Today",
    step: 20000,
    totalSteps: 20000,
    metrics: [
      {
        key: "loss",
        label: "loss",
        value: 0.47,
        delta: -0.01,
        lowerIsBetter: true,
        series: series(13, 32, -0.9),
      },
      {
        key: "val_loss",
        label: "val_loss",
        value: 0.38,
        delta: 0.01,
        lowerIsBetter: true,
        series: series(15, 32, -0.85),
      },
      {
        key: "acc",
        label: "acc",
        value: 0.86,
        delta: 0.01,
        lowerIsBetter: false,
        series: series(14, 32, 1),
      },
      {
        key: "lr",
        label: "lr",
        value: 0.0007,
        delta: 0,
        lowerIsBetter: true,
        series: series(17, 32, -0.4),
      },
    ],
    env: {
      python: "3.11.4",
      framework: "PyTorch 2.2.1",
      gpu: "NVIDIA A100 80GB",
    },
    config: {
      lr: "7e-4",
      batch_size: 96,
      optimizer: "AdamW",
      weight_decay: "1e-4",
      epochs: 50,
    },
  },
  {
    id: "r4",
    name: "gentle-sun-21",
    shortHash: "gentle-sn-21",
    state: "running",
    duration: "1m03s",
    commit: "a3f9c12",
    branch: "main",
    createdLabel: "6h ago",
    group: "Yesterday",
    step: 2100,
    totalSteps: 20000,
    metrics: [
      {
        key: "loss",
        label: "loss",
        value: 0.78,
        delta: -0.12,
        lowerIsBetter: true,
        series: series(19, 32, -0.5),
      },
      {
        key: "val_loss",
        label: "val_loss",
        value: 0.71,
        delta: -0.09,
        lowerIsBetter: true,
        series: series(21, 32, -0.5),
      },
      {
        key: "acc",
        label: "acc",
        value: 0.72,
        delta: 0.05,
        lowerIsBetter: false,
        series: series(20, 32, 1),
      },
      {
        key: "lr",
        label: "lr",
        value: 0.0009,
        delta: 0,
        lowerIsBetter: true,
        series: series(23, 32, -0.4),
      },
    ],
    env: {
      python: "3.11.4",
      framework: "PyTorch 2.2.1",
      gpu: "NVIDIA A100 80GB",
    },
    config: {
      lr: "9e-4",
      batch_size: 128,
      optimizer: "AdamW",
      weight_decay: "1e-5",
      epochs: 50,
    },
  },
  {
    id: "r5",
    name: "bold-tundra-9",
    shortHash: "bold-tnd-9",
    state: "crashed",
    duration: "0m48s",
    commit: "c1d0e55",
    branch: "exp/lr-sweep",
    createdLabel: "8h ago",
    group: "Yesterday",
    step: 900,
    totalSteps: 20000,
    metrics: [
      {
        key: "loss",
        label: "loss",
        value: 1.42,
        delta: 0.4,
        lowerIsBetter: true,
        series: series(25, 32, -0.2),
      },
      {
        key: "val_loss",
        label: "val_loss",
        value: 1.31,
        delta: 0.5,
        lowerIsBetter: true,
        series: series(27, 32, -0.2),
      },
      {
        key: "acc",
        label: "acc",
        value: 0.41,
        delta: -0.1,
        lowerIsBetter: false,
        series: series(26, 32, 0.5),
      },
      {
        key: "lr",
        label: "lr",
        value: 0.003,
        delta: 0,
        lowerIsBetter: true,
        series: series(29, 32, -0.4),
      },
    ],
    env: {
      python: "3.11.4",
      framework: "PyTorch 2.2.1",
      gpu: "NVIDIA A100 80GB",
    },
    config: {
      lr: "3e-3",
      batch_size: 256,
      optimizer: "AdamW",
      weight_decay: "1e-4",
      epochs: 50,
    },
  },
]

export const STATE_META: Record<RunState, {
  label: string
  token: "tertiary" | "primary" | "error" | "outline"
  pulse: boolean
  warn?: boolean
}> = {
  running: { label: "Running", token: "tertiary", pulse: true },
  finished: { label: "Finished", token: "primary", pulse: false },
  failed: { label: "Failed", token: "error", pulse: false },
  crashed: { label: "Crashed", token: "error", pulse: false, warn: true },
  queued: { label: "Queued", token: "outline", pulse: false },
}

// Inline line decos used by the editor's run-anchor / live-metric markers.
export type Tok = {
  t: string
  c?: "kw" | "str" | "fn" | "var" | "com" | "num" | "op"
}
export type CodeLine = {
  n: number
  toks: Tok[]
  deco?: {
    kind: "run-anchor" | "live-metric" | "metric-anchor"
    runId: string
    metric?: string
  }
  provenance?: boolean
}

// Experiments panel cards.
export type ExperimentStatus = "active" | "won" | "failed" | "archived"
export type Experiment = {
  id: string
  name: string
  status: ExperimentStatus
  runCount: number
  goal: string
  best: number
  bestTone: "positive" | "negative" | "neutral"
  ago: string
  leaderboard: number[]
  topRuns: {
    shortHash: string
    val: number
    commit: string
    branch: string
    duration: string
  }[]
  tags: string[]
}

export const EXPERIMENT_STATUS_META: Record<ExperimentStatus, {
  label: string
  tone: "positive" | "negative" | "neutral"
}> = {
  active: { label: "Active", tone: "neutral" },
  won: { label: "Won", tone: "positive" },
  failed: { label: "Failed", tone: "negative" },
  archived: { label: "Archived", tone: "neutral" },
}

// Source-control types. The runtime data lives in `SourceControlView`
// and is fetched from the Rust `git_service` module — there is no
// static snapshot to keep here.
export type ChangeStatus = "M" | "U" | "A" | "D"
export type FileChange = {
  status: ChangeStatus
  path: string
  runs: number | null
  best: number | null
  tone: "positive" | "negative" | "neutral"
}

// Workspace-wide artifacts (Artifacts panel) — types + UI metadata only.
// Runtime artifact data is now fetched from the tracker IPC bridge.
export type ArtifactKind = "model" | "dataset" | "plot" | "config" | "tensor" | "folder" | "file"
export type WorkspaceArtifact = {
  name: string
  run: string | null
  size: string
  date: string
  kind: ArtifactKind
  action: "download" | "open"
}

export const ARTIFACT_KIND_META: Record<ArtifactKind, {
  icon: string
  className: string
}> = {
  model: { icon: "database", className: "text-primary" },
  dataset: { icon: "database", className: "text-tertiary" },
  plot: { icon: "image", className: "text-secondary" },
  config: { icon: "file-code", className: "text-on-surface-variant" },
  tensor: { icon: "layers", className: "text-primary" },
  folder: { icon: "folder", className: "text-secondary" },
  file: { icon: "file", className: "text-outline" },
}

// `Artifact` was the per-run artifact list shape used by the Inspector.
// The Inspector now reads from `ArtifactRef` via `bonafide.tracker.listArtifacts`,
// so the renderer's typed dependency on `Artifact` no longer exists.
// Re-export `Artifact` as an alias of `WorkspaceArtifact` for any caller
// that still imports it through `data/artifacts.ts`'s barrel.
export type Artifact = WorkspaceArtifact
