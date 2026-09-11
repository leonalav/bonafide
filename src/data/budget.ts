/**
 * budget.ts — TypeScript types mirroring the Rust `BudgetStatus` and
 * `ToolPermission` from `src-tauri/src/agent/budget.rs` and `engine.rs`.
 */

export type EscalationLevel = "normal" | "caution" | "critical" | "exhausted"

export interface BudgetStatus {
  workspaceHash: string
  /** Maximum dollars allocated. */
  budgetDollars: number
  /** Maximum GPU hours allocated. */
  budgetGpuHours: number
  /** Dollars consumed so far. */
  spentDollars: number
  /** GPU hours consumed so far. */
  spentGpuHours: number
  /** Current escalation level as lowercase string. */
  escalation: EscalationLevel
  /** Fraction of budget consumed (0.0–1.0+). */
  spendRatio: number
  /** Whether the next compute tool call requires user approval. */
  requiresApproval: boolean
  /** Currency code for dollar values (ISO 4217). */
  currency?: string
}

export interface ToolPermission {
  allowed: boolean
  escalation: EscalationLevel
  requiresApproval: boolean
  /** Human-readable message when the tool is blocked. */
  message?: string
}

/** Color token for the budget meter bar, keyed by escalation level. */
export const BUDGET_COLORS: Record<EscalationLevel, string> = {
  normal: "bg-primary",
  caution: "bg-tertiary",
  critical: "bg-tertiary",
  exhausted: "bg-error",
}

/** Label shown next to the budget meter. */
export const BUDGET_LABELS: Record<EscalationLevel, string> = {
  normal: "Budget normal",
  caution: "Budget caution",
  critical: "Budget critical",
  exhausted: "Budget exhausted",
}

/** Text color for status messages. */
export const BUDGET_TEXT: Record<EscalationLevel, string> = {
  normal: "text-on-surface-variant",
  caution: "text-tertiary",
  critical: "text-tertiary",
  exhausted: "text-error",
}
