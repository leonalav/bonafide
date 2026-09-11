/**
 * runs.ts — Run-tracker data source.
 *
 * Re-exports the design artifacts from `data/artifacts.ts` so existing
 * imports keep type-checking. The live tracker (W&B / MLflow) is
 * stubbed in `src-tauri/src/lib.rs` (PHASE0-TODO markers) — until the
 * shim is fully wired in Phase 1, the live `useRuns` hook returns an
 * empty page and `RunsProvider` / `useRunsData()` therefore expose an
 * empty `Run[]`. Consumers are expected to render an empty state when
 * the array is empty.
 *
 * Two layers:
 *   1. `useRuns(projectName, workspaceRoot)` — raw `RunSummary[]` from
 *      the Tauri backend.
 *   2. `RunsProvider` + `useRunsData()` — provides a stable `Run[]`
 *      (renderer's rich type) to all panels. Returns `[]` until real
 *      runs come back from the tracker.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { bonafide } from "../ipc/tauri"
import type { RunSummary, RunPage, TrackerKind } from "../ipc/tauri"

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
  STATE_META,
  EXPERIMENT_STATUS_META,
  ARTIFACT_KIND_META,
  series as generateSeries,
} from "./artifacts"

import type { Run, RunState } from "./artifacts"

// ── useRuns hook ────────────────────────────────────────────────────────────

export type UseRunsResult = {
  runs: RunSummary[]
  loading: boolean
  error: string | null
  refetch: () => void
}

/**
 * Fetch runs for a project from the Tauri backend.
 *
 * Falls back to an empty list on error (does not throw) so the caller
 * can render an empty/error state without crashing.
 *
 * @param projectName   — Project name (W&B project or MLflow experiment).
 * @param workspaceRoot — Absolute path of the open workspace. When
 *                       `null` the hook skips the network call and
 *                       returns an empty list immediately so the
 *                       browser preview doesn't show a loading
 *                       spinner forever.
 * @param trackerKind   — Which tracker backend to query. When `null`
 *                       we default to W&B so the renderer keeps
 *                       rendering while the user picks a tracker in
 *                       the preferences panel.
 */
export function useRuns(
  projectName: string,
  workspaceRoot: string | null,
  trackerKind: TrackerKind | null,
): UseRunsResult {
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [loading, setLoading] = useState(workspaceRoot != null)
  const [error, setError] = useState<string | null>(null)

  const fetchRuns = useCallback(async () => {
    if (!workspaceRoot) {
      setRuns([])
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const page: RunPage = await bonafide.tracker.listRuns(
        trackerKind || "wandb",
        workspaceRoot,
        projectName,
        50,
        undefined,
      )
      setRuns(page.runs)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setRuns([])
    } finally {
      setLoading(false)
    }
  }, [projectName, workspaceRoot, trackerKind])

  useEffect(() => {
    void fetchRuns()
  }, [fetchRuns])

  return { runs, loading, error, refetch: fetchRuns }
}

// ── RunsProvider ────────────────────────────────────────────────────────────
//
// Bridges the backend `RunSummary[]` to the renderer's rich `Run[]`
// shape. While the backend returns no rows (PHASE0-TODO stubs), this
// provider surfaces an empty `Run[]`; consumers must render an empty
// state instead of relying on the design mock. The mock `RUNS` array
// is exported from `data/artifacts.ts` for type re-export purposes only
// and is no longer the source of truth.

type RunsContextValue = {
  /** Rich runs shape used by `ChartTab`, `ExperimentsTab`, `RunTimeline`,
   *  `App.tsx` (Inspector picker), and `Inspector` itself. */
  runs: Run[]
  /** Lightweight summaries straight from the backend, useful for
   *  surfaces that only need id+name+state (sidebar count, etc.). */
  summaries: RunSummary[]
  loading: boolean
  error: string | null
  refetch: () => void
  /** True when a workspace is open but no tracker has been connected
   *  for it yet. Surfaces a "no tracker" state in panels without
   *  pretending the backend has zero runs. */
  noTrackerConnected: boolean
}

const RunsContext = createContext<RunsContextValue | null>(null)

export type RunsProviderProps = {
  /** Project name (W&B project or MLflow experiment). Default `"bonafide-train"`. */
  projectName?: string
  /** Workspace root from `useWorkspaceRoot()`. Pass `null` when no
   *  workspace is open. */
  workspaceRoot: string | null
  /** Which tracker backend to query. Pass `null` when no tracker is
   *  connected for the active workspace — `useRuns` will then default
   *  to "wandb" for the IPC call (so the renderer keeps responding)
   *  while `useRunsStatus` reports `noTrackerConnected: true` so the
   *  UI can show a "connect a tracker" hint instead of an empty
   *  runs table. */
  trackerKind?: TrackerKind | null
  children: ReactNode
}

/**
 * Mount once at the App root. Calls `useRuns` so the live IPC is
 * exercised; consumers read the rich `Run[]` via `useRunsData()`.
 */
export function RunsProvider({
  projectName = "bonafide-train",
  workspaceRoot,
  trackerKind = null,
  children,
}: RunsProviderProps) {
  const live = useRuns(projectName, workspaceRoot, trackerKind)

  // A workspace is open but the user hasn't connected any tracker
  // for it yet — surface that distinctly from "tracker returned 0
  // runs" so panels can render the right empty state.
  const noTrackerConnected = workspaceRoot != null && trackerKind == null

  const value = useMemo<RunsContextValue>(() => {
    const summaries = live.runs
    // P0-T9: when the backend returns zero rows, surface an empty
    // `Run[]` — never fall back to the design mock. Consumers render
    // an honest empty state.
    const runs: Run[] = summaries.length
      ? summaries.map((s) => ({
          id: s.id,
          name: s.name,
          state: normalizeRunState(s.state),
          createdLabel: "—",
          duration: "—",
          shortHash: s.id.slice(0, 7),
          commit: s.id.slice(0, 7),
          branch: "",
          group: "Today" as const,
          step: 0,
          totalSteps: 0,
          metrics: [],
          env: { python: "", framework: "", gpu: "" },
          // Surface the run's summaryMetrics as the config dict so
          // panels that read `run.config[key]` see real values when
          // the backend ships them. Anything that isn't a primitive
          // (arrays / nested objects) is dropped since the Run type
          // constrains `config` to `Record<string, string | number>`.
          config: Object.fromEntries(
            Object.entries(s.summaryMetrics ?? {})
              .filter(
                ([_, v]) =>
                  v == null ||
                  typeof v === "string" ||
                  typeof v === "number" ||
                  typeof v === "boolean",
              )
              .map(([k, v]) => [k, v as string | number]),
          ),
        }))
      : []

    return {
      runs,
      summaries,
      loading: live.loading,
      error: live.error,
      refetch: live.refetch,
      noTrackerConnected,
    }
  }, [live.runs, live.loading, live.error, live.refetch, noTrackerConnected])

  return <RunsContext.Provider value={value}>{children}</RunsContext.Provider>
}

/** Read the rich `Run[]` from the nearest `RunsProvider`. Returns `[]`
 *  when no provider is mounted or the tracker has not surfaced any
 *  runs yet. Consumers should render an empty state for the empty case
 *  rather than relying on a fallback mock. */
export function useRunsData(): Run[] {
  const ctx = useContext(RunsContext)
  return ctx?.runs ?? []
}

/** Normalize the backend `RunSummary.state` string to the renderer's
 *  `RunState` union. The backend may return `"RUNNING"`, `"FAILED"`,
 *  `"QUEUED"`, etc. — anything we don't recognize falls back to
 *  `"finished"` so the row still renders instead of crashing the
 *  adapter. */
function normalizeRunState(raw: string): RunState {
  const s = (raw || "").toLowerCase()
  if (
    s === "running" ||
    s === "finished" ||
    s === "failed" ||
    s === "crashed" ||
    s === "queued"
  ) {
    return s as RunState
  }
  return "finished"
}

/** Read lightweight tracker state for surfaces that just want to know
 *  whether the live fetch is in flight / errored / has no tracker. */
export function useRunsStatus(): {
  loading: boolean
  error: string | null
  count: number
  noTrackerConnected: boolean
} {
  const ctx = useContext(RunsContext)
  return {
    loading: ctx?.loading ?? false,
    error: ctx?.error ?? null,
    count: ctx?.summaries.length ?? 0,
    noTrackerConnected: ctx?.noTrackerConnected ?? false,
  }
}
