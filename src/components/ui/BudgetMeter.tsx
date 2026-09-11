/**
 * BudgetMeter — budget progress bar for the Inspector sidebar.
 *
 * Shows dollars + GPU hours spent vs. budget, colored by escalation level.
 * Renders only when a workspace is open (workspaceRoot is non-null).
 *
 * The GPU segment is hidden when no GPUs are visible — driven by
 * `bonafide.gpu.getVisibility()`. Pure-CPU jobs and CI workspaces
 * don't have a GPU to spend on, and showing a "0.0h / 0h GPU" line
 * is just noise.
 */

import { useEffect, useState } from "react"
import { bonafide } from "../../ipc/tauri"
import type { BudgetStatus, EscalationLevel } from "../../ipc/tauri"
import { BUDGET_COLORS, BUDGET_LABELS, BUDGET_TEXT } from "../../ipc/tauri"
import { useWorkspaceRoot } from "../../ide/hooks"

/** Clamp spend_ratio to [0, 1] for display; values > 1 show the bar full with a warning. */
function barWidth(spendRatio: number): string {
  const pct = Math.min(100, Math.max(0, spendRatio * 100))
  return `${pct}%`
}

function barColor(escalation: EscalationLevel): string {
  return BUDGET_COLORS[escalation]
}

function label(escalation: EscalationLevel): string {
  return BUDGET_LABELS[escalation]
}

export function BudgetMeter() {
  const workspaceRoot = useWorkspaceRoot()
  const [budget, setBudget] = useState<BudgetStatus | null>(null)
  const [loading, setLoading] = useState(false)
  // P0-T11: GPU visibility comes from `bonafide.gpu.getVisibility()`
  // rather than from budget metadata — that's the source of truth for
  // whether the workspace has any GPUs worth showing. When the IPC
  // isn't wired (browser preview) we fall back to `count: 0`, which
  // hides the GPU segment entirely.
  const [gpuVisibility, setGpuVisibility] = useState<{ count: number }>({
    count: 0,
  })

  // Fetch budget on mount and whenever the workspace changes.
  // WS5-T10: Poll every 30s to keep the meter fresh during long-running
  // agent threads. The interval is cleared when the component unmounts
  // or when the workspace changes.
  useEffect(() => {
    if (!workspaceRoot) {
      setBudget(null)
      return
    }

    let cancelled = false

    const fetchBudget = () => {
      bonafide.agent
        .getBudgetStatus(workspaceRoot)
        .then((status) => {
          if (!cancelled) setBudget(status)
        })
        .catch((err) => {
          console.warn("[BudgetMeter] getBudgetStatus failed:", err)
        })
    }

    setLoading(true)
    fetchBudget()
    setLoading(false)

    // Poll every 30 seconds while mounted
    const interval = setInterval(fetchBudget, 30_000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [workspaceRoot])

  // Independent fetch for GPU visibility — runs even when the
  // workspace budget isn't available, because the segment should
  // appear/disappear the moment the GPU detector changes its mind.
  useEffect(() => {
    let cancelled = false
    bonafide.gpu
      .getVisibility()
      .then((v) => {
        if (!cancelled) setGpuVisibility({ count: v?.count ?? 0 })
      })
      .catch(() => {
        if (!cancelled) setGpuVisibility({ count: 0 })
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!workspaceRoot || loading) return null
  if (!budget) return null

  const escalation = budget.escalation as EscalationLevel
  const pct = Math.min(100, Math.round(budget.spendRatio * 100))
  const dollarsPct =
    budget.budgetDollars > 0
      ? Math.round((budget.spentDollars / budget.budgetDollars) * 100)
      : 0

  // P0-T11: GPU segment is hidden when no GPU is visible — either
  // because the user is on a CPU-only machine, has disabled the GPU
  // visibility toggle, or the backend hasn't reported yet.
  // Combines the IPC result with the budget's GPU hours so we never
  // show "0h / 0h GPU".
  const gpuCount =
    gpuVisibility.count > 0 && budget.budgetGpuHours > 0
      ? gpuVisibility.count
      : 0
  const gpuPct =
    gpuCount > 0
      ? Math.round((budget.spentGpuHours / budget.budgetGpuHours) * 100)
      : 0

  return (
    <div className="flex min-w-0 flex-col gap-1 overflow-hidden border-b border-outline-variant px-3 py-2">
      {/* Label row — `min-w-0` lets the right-side dollar/GPU value
          shrink and ellipsize rather than overflow the panel when the
          Inspector is narrow. The label stays fully visible because it
          doesn't truncate. */}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="label-caps shrink-0 text-[10px] text-on-surface-variant">
          {label(escalation)}
        </span>
        <span className="min-w-0 truncate text-right font-sans text-[10px] tabular-nums text-on-surface-variant">
          ${budget.spentDollars.toFixed(2)} / ${budget.budgetDollars.toFixed(0)}
          {gpuCount > 0
            ? ` · ${budget.spentGpuHours.toFixed(1)}h / ${budget.budgetGpuHours.toFixed(0)}h GPU`
            : ""}
        </span>
      </div>

      {/* Dollars progress bar */}
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container"
        role="progressbar"
        aria-label="Dollar budget spent"
        aria-valuenow={dollarsPct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor(escalation)}`}
          style={{ width: barWidth(budget.spendRatio) }}
        />
      </div>

      {/* GPU segment — only when the workspace has GPUs visible
       *  (`gpuVisibility.count > 0`) AND has allocated GPU hours.
       *  In either case the segment hides entirely instead of
       *  showing a meaningless "0.0h / 0h GPU" line. */}
      {gpuCount > 0 && (
        <div className="flex items-center gap-2">
          <div
            className="h-1 flex-1 overflow-hidden rounded-full bg-surface-container"
            role="progressbar"
            aria-label="GPU budget spent"
            aria-valuenow={gpuPct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={`h-full rounded-full transition-all duration-300 ${barColor(escalation)}`}
              style={{ width: `${Math.min(100, gpuPct)}%` }}
            />
          </div>
          <span className="font-sans text-[9px] tabular-nums text-outline">
            GPU
          </span>
        </div>
      )}

      {/* Exhausted warning */}
      {escalation === "exhausted" && (
        <p className={`font-sans text-[10px] ${BUDGET_TEXT.exhausted}`}>
          Budget exhausted — read-only tools only.
        </p>
      )}

      {/* Critical approval notice */}
      {escalation === "critical" && (
        <p className={`font-sans text-[10px] ${BUDGET_TEXT.critical}`}>
          Compute tools require approval at this budget level.
        </p>
      )}

      {/* Caution notice */}
      {escalation === "caution" && (
        <p className={`font-sans text-[10px] ${BUDGET_TEXT.caution}`}>
          Approaching budget limit ({pct}% spent).
        </p>
      )}
    </div>
  )
}
