/**
 * chat/ApprovalArtifact.tsx — Inline tool-approval artifact card.
 *
 * Rendered when the engine pauses with `result.type === "awaiting_approval"`.
 * The user must explicitly approve or reject before the loop can resume —
 * per `agent-example-sessions.html` lines 1342-1370 (`.approval-inline`)
 * and `agent-reasoning-designs.html` lines 2570-2680 (`.approval-card`).
 *
 * Visual model follows the sticker-sheet's `approval-inline` family:
 *   - Border tinted primary (matches the "Awaiting" status dot)
 *   - Header: small shield icon + label-caps "Approval requested"
 *   - Body: one-line reason from the engine
 *   - Footer: Approve (primary) / Reject (ghost-error) buttons
 *
 * Status lifecycle (driven by the parent's `artifact.status`):
 *   pending    → buttons live, "Approve" highlighted
 *   completed  → "Approved" terminal pill, buttons hidden
 *   failed     → "Rejected" terminal pill, buttons hidden
 *
 * The component is purely presentational — the parent owns the
 * approve/reject IPC call and updates the artifact's status once
 * the engine acknowledges the decision.
 */

import { Icon } from "../ui/Icon"
import type { Artifact } from "../../chats/ChatStore"

export function ApprovalArtifact({
  artifact,
  onApprove,
  onReject,
}: {
  artifact: Artifact
  /** Called when the user clicks Approve. Parent is expected to
   *  invoke `bonafide.agent.approveAction(...)` and update the
   *  artifact's status to `"completed"` + `decision: "approved"`. */
  onApprove?: () => void
  /** Mirror of `onApprove` for Reject. */
  onReject?: () => void
}) {
  const resolved =
    artifact.status === "completed" || artifact.status === "failed"
  const isApproved = artifact.status === "completed"

  return (
    // Per `agent-example-sessions.html` `.approval-inline`: primary-
    // tinted border, faint primary wash, 0.25rem radius, 12px padding.
    // We keep the 3px left accent bar (matching `ToolArtifact`'s
    // pattern) so the two card families feel related.
    <div
      role="group"
      aria-label={`Tool approval ${isApproved ? "approved" : artifact.status === "failed" ? "rejected" : "pending"}`}
      className={`relative w-full max-w-full min-w-0 overflow-hidden rounded border bg-surface-container-lowest ${
        isApproved
          ? "border-tertiary/30"
          : artifact.status === "failed"
            ? "border-error/30"
            : "border-primary/30"
      }`}
    >
      <div
        className={`pointer-events-none absolute inset-y-0 left-0 w-[3px] ${
          isApproved
            ? "bg-tertiary"
            : artifact.status === "failed"
              ? "bg-error"
              : "bg-primary animate-pulse"
        }`}
        aria-hidden="true"
      />

      {/* Header — shield icon + label-caps title */}
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center ${
            isApproved
              ? "text-tertiary"
              : artifact.status === "failed"
                ? "text-error"
                : "text-primary"
          }`}
        >
          <Icon name="shield-alert" size={13} />
        </span>
        <span
          className={`font-sans text-[10px] font-semibold uppercase tracking-[0.06em] ${
            isApproved
              ? "text-tertiary"
              : artifact.status === "failed"
                ? "text-error"
                : "text-primary"
          }`}
        >
          {resolved
            ? isApproved
              ? "Approved"
              : "Rejected"
            : "Approval requested"}
        </span>
      </div>

      {/* Body — engine-supplied reason. We surface it verbatim
          because the engine formats it ("Tool 'apply_patch'
          requires human approval."). If the engine ever returns a
          bare toolCallId with no reason, fall back to a generic
          explanation so the card still communicates *something*. */}
      <p className="px-3 pb-2.5 pt-1 font-body text-[12px] leading-[18px] text-on-surface-variant">
        {artifact.approvalReason ||
          artifact.resultSummary ||
          "This tool call needs your approval before it can run."}
      </p>

      {/* Footer — Approve / Reject buttons, or terminal pill */}
      {resolved ? (
        <div className="flex items-center justify-end gap-2 border-t border-outline-variant/60 px-3 py-2">
          <span
            className={`inline-flex items-center gap-1 font-sans text-[10px] font-semibold uppercase tracking-[0.06em] ${
              isApproved ? "text-tertiary" : "text-error"
            }`}
          >
            <Icon
              name={isApproved ? "check" : "x"}
              size={11}
              strokeWidth={2.5}
            />
            {isApproved ? "Approved" : "Rejected"}
          </span>
        </div>
      ) : onApprove || onReject ? (
        <div className="flex items-center justify-end gap-2 border-t border-outline-variant/60 px-3 py-2">
          <button
            type="button"
            onClick={onReject}
            disabled={!onReject}
            className="h-7 rounded border border-outline-variant bg-transparent px-3 font-sans text-[11px] font-semibold uppercase tracking-[0.04em] text-on-surface-variant hover:border-error/40 hover:bg-error/5 hover:text-error disabled:opacity-40"
          >
            Reject
          </button>
          <button
            type="button"
            onClick={onApprove}
            disabled={!onApprove}
            className="h-7 rounded border border-primary bg-primary px-3 font-sans text-[11px] font-semibold uppercase tracking-[0.04em] text-on-primary hover:brightness-110 disabled:opacity-40"
          >
            Approve
          </button>
        </div>
      ) : null}
    </div>
  )
}
