// Module-level cache for file content pre-loaded by the file-tree click
// handler BEFORE the editor mounts. The cache is editor-agnostic: the
// Sidebar fires `bonafide.fs.readFile()` SYNCHRONOUSLY in the same task
// as the click, BEFORE dispatching OPEN_FILE. The IPC request is in
// flight before any render work begins. When CodeMirrorEditor (or any
// future editor) seeds from disk, the cache is already populated (or
// populating) and the editor skips the IPC call entirely.
//
// History: this cache was originally built to mask a 30-40 second
// main-thread stall during Monaco's first initialization on Tauri +
// Windows + WebView2 + Vite dev mode. With CodeMirror 6 the stall is
// gone, but the cache is still useful: it cuts one round-trip from
// the open-file-to-render path, which keeps first-paint of the file
// content well under a second even on cold starts.

import { bonafide } from "../ipc/tauri"

type Entry = { content: string ts: number }
const cache = new Map<string, Entry>()

export function getPreloadedContent(absPath: string): string | undefined {
  const e = cache.get(absPath)
  if (!e) return undefined
  return e.content
}

export function getPreloadedEntry(absPath: string): Entry | undefined {
  return cache.get(absPath)
}

export function setPreloadedContent(absPath: string, content: string): void {
  cache.set(absPath, { content, ts: Date.now() })
}

// Trigger a fire-and-forget read. Stores the result in the cache as soon
// as the IPC resolves. We intentionally do NOT await — the caller (Sidebar
// click) needs to return immediately so the OPEN_FILE dispatch can fire
// on the same task tick.
export function preloadContent(absPath: string): void {
  if (cache.has(absPath)) return
  // Mark as in-flight so subsequent calls during the same click don't
  // spawn duplicates.
  cache.set(absPath, { content: "", ts: 0 })
  bonafide.fs
    .readFile(absPath)
    .then((r) => {
      cache.set(absPath, { content: r.content, ts: Date.now() })
    })
    .catch(() => {
      // Best-effort: drop the failed entry so the next click can retry.
      cache.delete(absPath)
    })
}

// Kept as a no-op stub for callers that may still reference it. The
// previous implementation fired a fetch to a localhost dev server on
// every click, which was a major contributor to slow file switching
// because each fetch timed out and burned a network round-trip.
export function _dbgPreload(
  _loc: string,
  _msg: string,
  _data: Record<string, unknown>,
): void {
  // intentionally empty
}
