/**
 * threads.ts — live Thread source for the Workflow inbox.
 *
 * Replaces the static `THREADS` mock in `data/agents.ts`. The mock
 * still exists as a fallback for browser preview / uninitialised
 * workspace — see `useThreads` below.
 */

import { useEffect, useState, useCallback } from "react"
import { bonafide, type ThreadRow } from "../ipc/tauri"
import { THREADS as MOCK_THREADS, type Thread } from "./agents"

export type { Thread }

export type UseThreadsResult = {
  threads: Thread[]
  loading: boolean
  error: string | null
  refetch: () => void
}

/**
 * Convert a persisted `ThreadRow` into the renderer's `Thread`
 * shape — filling in the `time` field (relative label) from
 * `updatedAt` so the inbox can render "12s ago" without each
 * component re-implementing the formatter.
 *
 * Falls back to the static `THREADS` mock when no workspace is
 * open (so the preview/storybook workflow keeps working and the
 * first frame doesn't flash empty).
 */
export function useThreads(workspaceRoot: string | null): UseThreadsResult {
  const [threads, setThreads] = useState<Thread[]>(
    workspaceRoot ? [] : MOCK_THREADS,
  )
  const [loading, setLoading] = useState(workspaceRoot != null)
  const [error, setError] = useState<string | null>(null)

  const fetchThreads = useCallback(async () => {
    if (!workspaceRoot) {
      setThreads(MOCK_THREADS)
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const rows: ThreadRow[] = await bonafide.agent.listThreads(workspaceRoot)
      setThreads(rows.length ? rows.map(rowToThread) : MOCK_THREADS)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      // Keep the mock as a graceful fallback so the inbox still
      // renders rather than going blank when the backend rejects.
      setThreads(MOCK_THREADS)
    } finally {
      setLoading(false)
    }
  }, [workspaceRoot])

  useEffect(() => {
    void fetchThreads()
  }, [fetchThreads])

  return { threads, loading, error, refetch: fetchThreads }
}

function rowToThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    role: row.role,
    title: row.title,
    summary: row.summary,
    state: row.state,
    detail: row.detail,
    time: relativeTime(row.updatedAt),
    updatedAt: row.updatedAt,
    band: row.band,
    system: row.system || undefined,
  }
}

function relativeTime(updatedAt: number): string {
  const delta = Date.now() - updatedAt
  if (delta < 0) return "just now"
  const sec = Math.floor(delta / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}
