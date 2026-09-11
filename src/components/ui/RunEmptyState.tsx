import { useEffect, useState } from "react"
import { Button } from "./primitives"

/**
 * Rendered by the Inspector when no run is selected. Encourages the
 * user to pick a run from the timeline.
 */
export function RunEmptyState({
  onSelectRun,
}: {
  onSelectRun?: () => void
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center p-8">
      <div className="text-4xl mb-3 opacity-30">🔬</div>
      <h3 className="text-sm font-medium mb-1">No run selected</h3>
      <p className="text-xs text-[var(--text-muted)] max-w-xs">
        Select a run from the timeline to inspect its config, metrics, and
        artifacts.
      </p>
      {onSelectRun ? (
        <Button variant="secondary" className="mt-4" onClick={onSelectRun}>
          Browse runs
        </Button>
      ) : null}
    </div>
  )
}

/** Quiet empty state for the diff tab when there is no diff to show. */
export function DiffEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
      <div className="text-2xl opacity-30">🪄</div>
      <p className="font-body text-[13px] text-on-surface-variant">
        No diff available.
      </p>
    </div>
  )
}
