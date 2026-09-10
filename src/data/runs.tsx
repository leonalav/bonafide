/**
 * runs.ts — Run-tracker data source.
 *
 * Re-exports the design artifacts from `data/artifacts.ts` so existing
 * imports keep type-checking. The live tracker (W&B / MLflow) is
 * stubbed in `src-tauri/src/lib.rs` (PHASE0-TODO markers) — until the
 * shim is fully wired in Phase 1, the live `useRuns` hook will return
 * an empty page and the `RunsProvider` falls back to the rich mock
 * `Run[]` so panels still render.
 *
 * Two layers:
 *   1. `useRuns(projectName, workspaceRoot)` — raw `RunSummary[]` from
 *      the Tauri backend. The hook is now actually exercised by the
 *      `RunsProvider`, so the wiring is no longer orphan.
 *   2. `RunsProvider` + `useRunsData()` — provides a stable `Run[]`
 *      (renderer's rich type) to all panels. Falls back to mock when
 *      no workspace is open or when the live fetch yields no rows.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { bonafide } from "../ipc/tauri";
import type { RunSummary, RunPage } from "../ipc/tauri";

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

import { RUNS as MOCK_RUNS, type Run } from "./artifacts";

// ── useRuns hook ────────────────────────────────────────────────────────────

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
 * @param projectName   — W&B project name, e.g. "bonafide-train".
 * @param workspaceRoot — Absolute path of the open workspace. When
 *                       `null` the hook skips the network call and
 *                       returns an empty list immediately so the
 *                       browser preview doesn't show a loading
 *                       spinner forever.
 */
export function useRuns(
  projectName: string,
  workspaceRoot: string | null,
): UseRunsResult {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(workspaceRoot != null);
  const [error, setError] = useState<string | null>(null);

  const fetchRuns = useCallback(async () => {
    if (!workspaceRoot) {
      setRuns([]);
      setLoading(false);
      setError(null);
      return;
    }
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
  }, [projectName, workspaceRoot]);

  useEffect(() => {
    void fetchRuns();
  }, [fetchRuns]);

  return { runs, loading, error, refetch: fetchRuns };
}

// ── RunsProvider ────────────────────────────────────────────────────────────
//
// Bridges the backend `RunSummary[]` to the renderer's rich `Run[]`
// shape. Today, the backend returns no rows (PHASE0-TODO stubs); the
// provider therefore surfaces the design mock so every consumer keeps
// rendering. Once the shim is wired in Phase 1, replace the body of
// `summariesToRuns` (or just return rows when live) and the rest of
// the UI picks it up automatically.

type RunsContextValue = {
  /** Rich runs shape used by `ChartTab`, `ExperimentsTab`, `RunTimeline`,
   *  `App.tsx` (Inspector picker), and `Inspector` itself. */
  runs: Run[];
  /** Lightweight summaries straight from the backend, useful for
   *  surfaces that only need id+name+state (sidebar count, etc.). */
  summaries: RunSummary[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
};

const RunsContext = createContext<RunsContextValue | null>(null);

export type RunsProviderProps = {
  /** W&B project name; default is `"bonafide-train"`. */
  projectName?: string;
  /** Workspace root from `useWorkspaceRoot()`. Pass `null` when no
   *  workspace is open. */
  workspaceRoot: string | null;
  children: ReactNode;
};

/**
 * Mount once at the App root. Calls `useRuns` so the live IPC is
 * exercised; consumers read the rich `Run[]` via `useRunsData()`.
 */
export function RunsProvider({
  projectName = "bonafide-train",
  workspaceRoot,
  children,
}: RunsProviderProps) {
  const live = useRuns(projectName, workspaceRoot);

  const value = useMemo<RunsContextValue>(() => {
    // Live mode: backend returned at least one row → use them.
    // The current PHASE0-TODO stub returns []; until Phase 1 the
    // fallback path keeps every panel rendering.
    const summaries = live.runs;
    const runs: Run[] = summaries.length
      ? summaries.map((s) => ({
          // Minimal adapter. The current consumers reach into
          // `runs[i].metrics[0].series`, `runs[i].config`, etc. so
          // until the backend ships full RunDetail, we leave a single
          // "empty" run that callers can fall through to MOCK_RUNS
          // for. For now we just forward the mock.
          id: s.id,
          name: s.name,
          state: "finished" as const,
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
          config: {},
        }))
      : MOCK_RUNS;

    return {
      runs,
      summaries,
      loading: live.loading,
      error: live.error,
      refetch: live.refetch,
    };
  }, [live.runs, live.loading, live.error, live.refetch]);

  return <RunsContext.Provider value={value}>{children}</RunsContext.Provider>;
}

/** Read the rich `Run[]` from the nearest `RunsProvider`. */
export function useRunsData(): Run[] {
  const ctx = useContext(RunsContext);
  return ctx?.runs ?? MOCK_RUNS;
}

/** Read lightweight tracker state for surfaces that just want to know
 *  whether the live fetch is in flight / errored. */
export function useRunsStatus(): { loading: boolean; error: string | null; count: number } {
  const ctx = useContext(RunsContext);
  return {
    loading: ctx?.loading ?? false,
    error: ctx?.error ?? null,
    count: ctx?.summaries.length ?? 0,
  };
}
