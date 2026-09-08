/**
 * hooks.ts — React hooks for the IDE store.
 *
 * All hooks subscribe via useSyncExternalStore for safe concurrent rendering.
 */

import { useCallback, useContext, useSyncExternalStore } from "react";
import {
  IdeStoreContext,
  type IdeState,
  type IdeAction,
  type Toast,
} from "./store";

// ── Root hook ────────────────────────────────────────────────────────────────

export function useIdeStore() {
  const store = useContext(IdeStoreContext);
  if (!store) {
    throw new Error("useIdeStore must be used inside <IdeStoreProvider>");
  }
  return store;
}

// ── Subscribe with equality check (selector pattern) ─────────────────────────

// #region DEBUG: measure selector performance
let _hookLog: ((msg: string, d: Record<string, unknown>) => void) | null = null;
if (typeof window !== 'undefined') {
  _hookLog = (msg, d) => fetch('http://127.0.0.1:7750/ingest/8d618420-3b75-4343-9d6c-c42e01f4bae7', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '5197ca' },
    body: JSON.stringify({ sessionId: '5197ca', id: `log_${Date.now()}`, timestamp: Date.now(), location: 'hooks.getSnapshot', message: msg, data: d, runId: 'run1', hypothesisId: 'D' }),
  }).catch(() => {});
}
// #endregion

function useStoreSnapshot<T>(
  store: ReturnType<typeof useIdeStore>,
  selector: (state: IdeState) => T,
  equalityFn: (a: T, b: T) => boolean = Object.is,
): T {
  let prevValue: T | undefined;
  let callCount = 0;
  const _id = Math.random().toString(36).slice(2, 6);

  const getSnapshot = useCallback(() => {
    const t0 = performance.now();
    callCount++;
    const next = selector(store.getState());
    const same = prevValue !== undefined && equalityFn(prevValue, next);
    const ms = performance.now() - t0;
    if (ms > 5 || callCount <= 3) {
      _hookLog?.('getSnapshot', { id: _id, same, ms: ms.toFixed(2), callCount, prevDefined: prevValue !== undefined });
    }
    if (prevValue !== undefined && equalityFn(prevValue, next)) {
      return prevValue;
    }
    prevValue = next;
    return next;
  }, [store]);

  // Wrap in an arrow function so `this` is bound to the IdeStore instance,
  // not lost when useSyncExternalStore extracts the method as a bare function.
  const subscribe = useCallback(
    (fn: () => void) => store.subscribe(fn),
    [store],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ── File tree ────────────────────────────────────────────────────────────────

export function useFileTree() {
  const store = useIdeStore();
  return useStoreSnapshot(store, (s) => s.fileTree);
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

export function useTabs() {
  const store = useIdeStore();
  return useStoreSnapshot(store, (s) => s.tabs);
}

export function useActiveTab() {
  const store = useIdeStore();
  return useStoreSnapshot(store, (s) => {
    const id = s.activeTabId;
    return id ? s.tabs.find((t) => t.id === id) ?? null : null;
  });
}

// ── Active file ──────────────────────────────────────────────────────────────

export function useActiveFile() {
  const store = useIdeStore();
  return useStoreSnapshot(store, (s) => {
    const activeTab = s.activeTabId
      ? s.tabs.find((t) => t.id === s.activeTabId)
      : null;
    if (!activeTab) return null;
    return s.fileTree.find((n) => n.id === activeTab.fileId) ?? null;
  });
}

// ── Focused node (tree keyboard focus) ───────────────────────────────────────

export function useFocusedNodeId() {
  const store = useIdeStore();
  return useStoreSnapshot(store, (s) => s.focusedNodeId);
}

// ── Collapsed map ────────────────────────────────────────────────────────────

export function useCollapsed() {
  const store = useIdeStore();
  return useStoreSnapshot(store, (s) => s.collapsed);
}

// ── Context menu state ──────────────────────────────────────────────────────

export function useContextMenuState() {
  const store = useIdeStore();
  return useStoreSnapshot(store, (s) => s.contextMenu);
}

// ── Modal state ─────────────────────────────────────────────────────────────

export function useModalState() {
  const store = useIdeStore();
  return useStoreSnapshot(store, (s) => s.modal);
}

// ── Toasts ──────────────────────────────────────────────────────────────────

export function useToasts(): Toast[] {
  const store = useIdeStore();
  return useStoreSnapshot(store, (s) => s.toasts);
}

// ── Workspace root / name ───────────────────────────────────────────────────

export function useWorkspaceRoot() {
  const store = useIdeStore();
  return useStoreSnapshot(store, (s) => s.workspaceRoot);
}

export function useWorkspaceName() {
  const store = useIdeStore();
  return useStoreSnapshot(store, (s) => s.workspaceName);
}

// ── Closed tabs stack (for Reopen Closed Tab) ───────────────────────────────

export function useClosedTabsStack() {
  const store = useIdeStore();
  return useStoreSnapshot(store, (s) => s.closedTabsStack);
}

// ── Dispatch helper ─────────────────────────────────────────────────────────

export function useDispatch() {
  const store = useIdeStore();
  return useCallback((action: IdeAction) => store.dispatch(action), [store]);
}

// ── Push toast helper ────────────────────────────────────────────────────────

export function useToast() {
  const dispatch = useDispatch();
  return useCallback(
    (message: string, tone: Toast["tone"] = "info", ttlMs = 2400) => {
      dispatch({ type: "PUSH_TOAST", toast: { message, tone, ttlMs } });
    },
    [dispatch],
  );
}
