/**
 * hooks.ts — React hooks for the IDE store.
 *
 * All hooks subscribe via useSyncExternalStore for safe concurrent rendering.
 */

import { useCallback, useContext, useRef, useSyncExternalStore } from "react"
import {
  IdeStoreContext,
  type IdeState,
  type IdeAction,
  type Toast,
} from "./store"

// ── Root hook ────────────────────────────────────────────────────────────────

export function useIdeStore() {
  const store = useContext(IdeStoreContext)
  if (!store) {
    throw new Error("useIdeStore must be used inside <IdeStoreProvider>")
  }
  return store
}

// ── Subscribe with equality check (selector pattern) ─────────────────────────

// Optional performance instrumentation. Set
// `localStorage.__BONAFIDE_PERF__ = "1"` in devtools to enable. The
// previous version fired an unconditional fetch on every selector
// snapshot — dozens per second during file switches, each timing
// out against an unreachable dev server.
function isPerfEnabled(): boolean {
  if (typeof window === "undefined") return false
  try {
    return window.localStorage?.getItem("__BONAFIDE_PERF__") === "1"
  } catch {
    return false
  }
}
const PERF_ENABLED = isPerfEnabled()
function perfLog(
  location: string,
  message: string,
  data: Record<string, unknown>,
): void {
  if (!PERF_ENABLED) return
  fetch("http://127.0.0.1:7750/ingest/8d618420-3b75-4343-9d6c-c42e01f4bae7", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "5197ca",
    },
    body: JSON.stringify({
      sessionId: "5197ca",
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      location,
      message,
      data,
      runId: "run1",
      hypothesisId: "D",
    }),
  }).catch(() => {})
}

function useStoreSnapshot<T>(
  store: ReturnType<typeof useIdeStore>,
  selector: (state: IdeState) => T,
  equalityFn: (a: T, b: T) => boolean = Object.is,
): T {
  // prevValueRef MUST live OUTSIDE getSnapshot so it persists across calls.
  // The previous version declared it inside the callback body, so it was
  // reset on every snapshot — the equality check was a no-op and every
  // selector snapshot looked new to useSyncExternalStore, causing every
  // subscriber to re-render on every dispatch.
  const prevValueRef = useRef<T | undefined>(undefined)
  const callCountRef = useRef(0)
  const idRef = useRef<string>(Math.random().toString(36).slice(2, 6))

  const getSnapshot = useCallback(() => {
    callCountRef.current++
    const t0 = PERF_ENABLED ? performance.now() : 0
    const next = selector(store.getState())
    const prev = prevValueRef.current
    const same = prev !== undefined && equalityFn(prev, next)
    if (PERF_ENABLED) {
      const ms = performance.now() - t0
      if (ms > 5 || callCountRef.current <= 3) {
        perfLog("hooks.getSnapshot", "getSnapshot", {
          id: idRef.current,
          same,
          ms: ms.toFixed(2),
          callCount: callCountRef.current,
          prevDefined: prev !== undefined,
        })
      }
    }
    if (prev !== undefined && equalityFn(prev, next)) {
      return prev
    }
    prevValueRef.current = next
    return next
  }, [store, selector, equalityFn])

  // Wrap in an arrow function so `this` is bound to the IdeStore instance,
  // not lost when useSyncExternalStore extracts the method as a bare function.
  const subscribe = useCallback(
    (fn: () => void) => store.subscribe(fn),
    [store],
  )

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// ── File tree ────────────────────────────────────────────────────────────────

export function useFileTree() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => s.fileTree)
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

export function useTabs() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => s.tabs)
}

export function useActiveTab() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => {
    const id = s.activeTabId
    return id ? (s.tabs.find((t) => t.id === id) ?? null) : null
  })
}

// ── Active file ──────────────────────────────────────────────────────────────

export function useActiveFile() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => {
    const activeTab = s.activeTabId
      ? s.tabs.find((t) => t.id === s.activeTabId)
      : null
    if (!activeTab) return null
    return s.fileTree.find((n) => n.id === activeTab.fileId) ?? null
  })
}

// ── Focused node (tree keyboard focus) ───────────────────────────────────────

export function useFocusedNodeId() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => s.focusedNodeId)
}

// ── Collapsed map ────────────────────────────────────────────────────────────

export function useCollapsed() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => s.collapsed)
}

// ── Context menu state ──────────────────────────────────────────────────────

export function useContextMenuState() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => s.contextMenu)
}

// ── Modal state ─────────────────────────────────────────────────────────────

export function useModalState() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => s.modal)
}

// ── Toasts ──────────────────────────────────────────────────────────────────

export function useToasts(): Toast[] {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => s.toasts)
}

// ── Workspace root / name ───────────────────────────────────────────────────

export function useWorkspaceRoot() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => s.workspaceRoot)
}

export function useWorkspaceName() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => s.workspaceName)
}

// ── Closed tabs stack (for Reopen Closed Tab) ───────────────────────────────

export function useClosedTabsStack() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => s.closedTabsStack)
}

// ── Merge reviews ────────────────────────────────────────────────────────────

export function useMergeReviews() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => s.mergeReviews)
}

/** Get the active merge review (the one whose tab is active). */
export function useActiveMergeReview() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => {
    const activeTab = s.activeTabId
      ? s.tabs.find((t) => t.id === s.activeTabId)
      : null
    if (!activeTab || !activeTab.fileId.startsWith("__merge__/")) return null
    const absPath = activeTab.fileId.slice("__merge__/".length)
    return s.mergeReviews.find((r) => r.absPath === absPath) ?? null
  })
}

// ── Panel ────────────────────────────────────────────────────────────────────

export type PanelState = IdeState["panel"]

export function usePanel() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => s.panel)
}

export function usePanelOpen() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => s.panel.open)
}

export function usePanelTab() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => s.panel.tab)
}

export function usePanelHeight() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => s.panel.height)
}

export function useDiagnostics() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => s.panel.diagnostics)
}

export function useOutputLogs() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => s.panel.outputLogs)
}

export function useTerminalSessions() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => s.panel.terminalSessions)
}

export function useActiveTerminal() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => {
    const id = s.panel.activeTerminalId
    if (!id) return null
    return s.panel.terminalSessions.find((t) => t.id === id) ?? null
  })
}

// ── Dispatch helper ─────────────────────────────────────────────────────────

export function useDispatch() {
  const store = useIdeStore()
  return useCallback((action: IdeAction) => store.dispatch(action), [store])
}

// ── Push toast helper ────────────────────────────────────────────────────────

export function useToast() {
  const dispatch = useDispatch()
  return useCallback(
    (message: string, tone: Toast["tone"] = "info", ttlMs = 2400) => {
      dispatch({ type: "PUSH_TOAST", toast: { message, tone, ttlMs } })
    },
    [dispatch],
  )
}

// ── Command palette ─────────────────────────────────────────────────────────

/** True when the command palette is open. */
export function usePaletteOpen() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => s.palette.open)
}

/** Current palette search query. */
export function usePaletteQuery() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => s.palette.query)
}

/** Currently selected command index (into the filtered command list). */
export function usePaletteSelected() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => s.palette.selected)
}

/**
 * Current palette selected command index.
 * Use this with the command registry to resolve the selected command.
 * The component builds the filtered command list from the store state;
 * this hook exposes the selected index so callers can track the selection.
 */
export function usePaletteCommand() {
  const store = useIdeStore()
  return useStoreSnapshot(store, (s) => s.palette.selected)
}
