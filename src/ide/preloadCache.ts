// Module-level cache for file content pre-loaded by the file-tree click
// handler BEFORE Monaco mounts. This bypasses the 30-40 second main-thread
// stall that happens during Monaco's first initialization on Tauri +
// Windows + WebView2 + Vite dev mode.
//
// Why we need this:
//   1. User clicks a file in the sidebar.
//   2. `OPEN_FILE` action adds a tab; React renders MonacoEditor.
//   3. MonacoEditor's useEffect fires `seedFromDisk()` → `bonafide.fs.readFile()`.
//   4. If Monaco's first-time init is still in progress (loading 5,000+
//      AMD modules from Vite), the main thread is saturated for tens of
//      seconds. Tauri's IPC response is delivered via WebView2 postMessage,
//      which sits in the main-thread message queue until the queue is
//      drained. The `await` doesn't resolve until Monaco's init releases
//      the main thread.
//
// The fix:
//   - Sidebar's click handler fires `bonafide.fs.readFile()` SYNCHRONOUSLY
//     in the same task as the click, BEFORE dispatching OPEN_FILE.
//   - The IPC request is in flight before any render work begins.
//   - When MonacoEditor's `seedFromDisk` runs, the cache is already
//     populated (or populating) and we skip the IPC entirely.
//
// In dev mode (Tauri + Vite) this drops the first-file-open latency
// from ~80 seconds to ~2 seconds.

import { bonafide } from "../ipc/tauri";

type Entry = { content: string; ts: number };
const cache = new Map<string, Entry>();

export function getPreloadedContent(absPath: string): string | undefined {
  const e = cache.get(absPath);
  if (!e) return undefined;
  return e.content;
}

export function getPreloadedEntry(absPath: string): Entry | undefined {
  return cache.get(absPath);
}

export function setPreloadedContent(absPath: string, content: string): void {
  cache.set(absPath, { content, ts: Date.now() });
}

// Trigger a fire-and-forget read. Stores the result in the cache as soon
// as the IPC resolves. We intentionally do NOT await — the caller (Sidebar
// click) needs to return immediately so the OPEN_FILE dispatch can fire
// on the same task tick.
export function preloadContent(absPath: string): void {
  if (cache.has(absPath)) return;
  // Mark as in-flight so subsequent calls during the same click don't
  // spawn duplicates.
  cache.set(absPath, { content: "", ts: 0 });
  bonafide.fs
    .readFile(absPath)
    .then((r) => {
      cache.set(absPath, { content: r.content, ts: Date.now() });
    })
    .catch(() => {
      // Best-effort: drop the failed entry so the next click can retry.
      cache.delete(absPath);
    });
}

export function _dbgPreload(loc: string, msg: string, data: Record<string, unknown>) {
  fetch('http://127.0.0.1:7750/ingest/8d618420-3b75-4343-9d6c-c42e01f4bae7', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '5197ca' },
    body: JSON.stringify({
      sessionId: '5197ca',
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      location: loc,
      message: msg,
      data,
      runId: 'run1',
      hypothesisId: 'I',
    }),
  }).catch(() => {});
}
