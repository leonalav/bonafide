/**
 * critic.ts — TypeScript types for the Critic Mode.
 *
 * Mirrors the Rust `CritiqueRequest`, `CritiqueResult`, `CritiqueVerdict`,
 * `CheckResult` types from `src-tauri/src/agent/critic.rs`.
 */

export type CritiqueVerdict = "ship" | "minor_concerns" | "needs_changes" | "reject"

export interface CheckResult {
  checkName: string
  passed: boolean
  scoreContribution: number
  message: string
}

export interface CritiqueResult {
  score: number
  verdict: CritiqueVerdict
  issues: string[]
  checksPassed: string[]
  checkResults: CheckResult[]
}

export interface CritiqueRequest {
  hypothesis?: string
  patchDiff?: string
  configDiff?: string
  patchContent?: string
}

/** Format a critique result for display in the agent response. */
export function formatCritiqueForDisplay(result: CritiqueResult): string {
  const verdictText = {
    ship: "✅ Ship it.",
    minor_concerns: "⚠️ Good with minor concerns:",
    needs_changes: "⚠️ Risky. Needs changes:",
    reject: "❌ Reject.",
  }[result.verdict]

  const lines: string[] = [
    `## Critique Result: ${result.score}/100`,
    "",
    verdictText,
    "",
  ]

  if (result.checksPassed.length > 0) {
    lines.push("### Checks Passed")
    for (const check of result.checksPassed) {
      lines.push(`- ✅ ${check}`)
    }
    lines.push("")
  }

  if (result.issues.length > 0) {
    lines.push("### Issues Found")
    for (const issue of result.issues) {
      lines.push(`- ⚠️ ${issue}`)
    }
    lines.push("")
  }

  lines.push(`**Overall: ${result.score}/100**`)

  return lines.join("\n")
}

/** Check if a result should block the proposed change. */
export function shouldBlockChange(result: CritiqueResult): boolean {
  // Block if score is below 50 or verdict is reject/needs_changes
  return (
    result.score < 50 ||
    result.verdict === "reject" ||
    result.verdict === "needs_changes"
  )
}

/** Get the human-readable verdict description. */
export function getVerdictDescription(verdict: CritiqueVerdict): string {
  const descriptions = {
    ship: "This change is ready to be applied.",
    minor_concerns:
      "This change is mostly good but has some minor issues to address.",
    needs_changes:
      "This change has significant issues that need to be fixed before applying.",
    reject: "This change should not be applied due to serious problems.",
  }
  return descriptions[verdict]
}
