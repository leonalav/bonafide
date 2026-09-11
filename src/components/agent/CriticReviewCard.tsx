/**
 * CriticReviewCard — displays a Critic mode code review verdict inline.
 *
 * Shows score, issues, recommendations, and verdict (Pass/Fail/NeedsWork).
 * Used by ProposalView before presenting a patch for user approval.
 */

import { Icon } from "../ui/Icon"
import type { CriticReview } from "../../ipc/tauri"

const VERDICT_CONFIG: Record<
  "pass" | "fail" | "skip",
  { label: string; icon: string; color: string; bg: string }
> = {
  pass: {
    label: "Pass",
    icon: "check-circle",
    color: "text-primary",
    bg: "bg-primary/10 border-primary/30",
  },
  fail: {
    label: "Fail",
    icon: "x-circle",
    color: "text-error",
    bg: "bg-error/10 border-error/30",
  },
  skip: {
    label: "Skipped",
    icon: "minus-circle",
    color: "text-outline",
    bg: "bg-surface-container border-outline-variant",
  },
}

export function CriticReviewCard({ review }: { review: CriticReview }) {
  const config = VERDICT_CONFIG[review.verdict]

  return (
    <div
      className={`flex flex-col gap-3 rounded border p-3 ${config.bg}`}
    >
      {/* Verdict header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon name={config.icon} size={16} className={config.color} />
          <span className={`font-medium ${config.color}`}>
            Code Review: {config.label}
          </span>
        </div>
        <div className="flex items-center gap-1 font-sans text-[11px] text-outline">
          <span>Score: {review.score}/100</span>
          {review.durationMs && (
            <>
              <span className="text-outline-variant">·</span>
              <span>{review.durationMs}ms</span>
            </>
          )}
        </div>
      </div>

      {/* Summary */}
      <p className="font-sans text-[13px] text-on-surface-variant">
        {review.summary}
      </p>

      {/* Issues */}
      {review.issues.length > 0 && (
        <div>
          <div className="label-caps mb-1 text-error">
            Issues ({review.issues.length})
          </div>
          <ul className="flex flex-col gap-1">
            {review.issues.map((issue, i) => (
              <li
                key={i}
                className="flex items-start gap-1.5 font-sans text-[12px] text-on-surface-variant"
              >
                <span className="mt-0.5 text-error">•</span>
                <span className="flex-1">{issue}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Recommendations */}
      {review.recommendations.length > 0 && (
        <div>
          <div className="label-caps mb-1 text-primary">
            Recommendations ({review.recommendations.length})
          </div>
          <ul className="flex flex-col gap-1">
            {review.recommendations.map((rec, i) => (
              <li
                key={i}
                className="flex items-start gap-1.5 font-sans text-[12px] text-on-surface-variant"
              >
                <span className="mt-0.5 text-primary">•</span>
                <span className="flex-1">{rec}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
