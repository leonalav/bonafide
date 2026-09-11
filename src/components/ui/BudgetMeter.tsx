/**
 * BudgetMeter — budget progress bar for the Inspector sidebar.
 *
 * Shows dollars + GPU hours spent vs. budget, colored by escalation level.
 * Renders only when a workspace is open (workspaceRoot is non-null).
 */

import { useEffect, useState } from "react"
import { bonafide } from "../../ipc/tauri"
import type { BudgetStatus, EscalationLevel } from "../../data/budget"
import { BUDGET_COLORS, BUDGET_LABELS, BUDGET_TEXT } from "../../data/budget"
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

  // Fetch budget on mount and whenever the workspace changes.
  useEffect(() => {
    if (!workspaceRoot) {
      setBudget(null)
      return
    }

    let cancelled = false
    setLoading(true)

    bonafide.agent
      .getBudgetStatus(workspaceRoot)
      .then((status) => {
        if (!cancelled) setBudget(status)
      })
      .catch((err) => {
        console.warn("[BudgetMeter] getBudgetStatus failed:", err)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [workspaceRoot])

  if (!workspaceRoot || loading) return null
  if (!budget) return null

  const escalation = budget.escalation as EscalationLevel
  const pct = Math.min(100, Math.round(budget.spendRatio * 100))
  const dollarsPct =
    budget.budgetDollars > 0
      ? Math.round((budget.spentDollars / budget.budgetDollars) * 100)
      : 0

  return (
    <div className="flex flex-col gap-1 px-3 py-2 border-b border-outline-variant">
      {/* Label row */}
      <div className="flex items-center justify-between">
        <span className="label-caps text-[10px] text-on-surface-variant">
          {label(escalation)}
        </span>
        <span className="font-sans text-[10px] tabular-nums text-on-surface-variant">
          ${budget.spentDollars.toFixed(2)} / ${budget.budgetDollars.toFixed(0)}
          {" · "}
          {budget.spentGpuHours.toFixed(1)}h /{" "}
          {budget.budgetGpuHours.toFixed(0)}h GPU
        </span>
      </div>

      {/* Progress bar */}
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container"
        role="progressbar"
        aria-label="Budget spent"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor(escalation)}`}
          style={{ width: barWidth(budget.spendRatio) }}
        />
      </div>

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
