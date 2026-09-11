import { useState } from "react"
import { Icon } from "../ui/Icon"
import { Button } from "../ui/primitives"
import { bonafide, type EscalationLevel } from "../../ipc/tauri"

/**
 * ApprovalDialog — Triggered when thread state is AwaitingApproval.
 * 
 * Shows: tool name, tool call args, agent reasoning, risk level (from safety matrix).
 * 
 * Buttons:
 * - Approve (green) → calls agentApproveAction(threadId, actionId)
 * - Reject (red) → calls agentRejectAction(threadId, actionId, reason) with reason textarea
 * - Request Revision (yellow) → appends instruction to thread and resumes
 * 
 * Props:
 * - workspaceRoot: string
 * - threadId: string
 * - toolCallId: string
 * - toolName: string
 * - toolArgs: Record<string, unknown>
 * - reasoning: string (agent's explanation for why it wants to call this tool)
 * - escalation: EscalationLevel ("normal" | "caution" | "critical" | "exhausted")
 * - onClose: () => void
 * - onApproved?: () => void
 * - onRejected?: () => void
 * - onRevisionRequested?: () => void
 */

const ESCALATION_STYLES: Record<
  EscalationLevel,
  { bg: string; text: string; border: string; icon: string }
> = {
  normal: {
    bg: "bg-primary/10",
    text: "text-primary",
    border: "border-primary/30",
    icon: "info",
  },
  caution: {
    bg: "bg-tertiary/10",
    text: "text-tertiary",
    border: "border-tertiary/30",
    icon: "alert-triangle",
  },
  critical: {
    bg: "bg-error/10",
    text: "text-error",
    border: "border-error/30",
    icon: "alert-octagon",
  },
  exhausted: {
    bg: "bg-error/20",
    text: "text-error",
    border: "border-error",
    icon: "x-circle",
  },
}

export function ApprovalDialog({
  workspaceRoot,
  threadId,
  toolCallId,
  toolName,
  toolArgs,
  reasoning,
  escalation,
  onClose,
  onApproved,
  onRejected,
  onRevisionRequested,
}: {
  workspaceRoot: string
  threadId: string
  toolCallId: string
  toolName: string
  toolArgs: Record<string, unknown>
  reasoning: string
  escalation: EscalationLevel
  onClose: () => void
  onApproved?: () => void
  onRejected?: () => void
  onRevisionRequested?: () => void
}) {
  const [showRejectReason, setShowRejectReason] = useState(false)
  const [rejectReason, setRejectReason] = useState("")
  const [showRevisionInput, setShowRevisionInput] = useState(false)
  const [revisionInstruction, setRevisionInstruction] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const styles = ESCALATION_STYLES[escalation]

  const handleApprove = async () => {
    setSubmitting(true)
    try {
      await bonafide.agent.approveAction(workspaceRoot, {
        threadId,
        toolCallId,
        decision: "approve",
      })
      onApproved?.()
      onClose()
    } catch (err) {
      console.error("[ApprovalDialog] approveAction failed:", err)
      setSubmitting(false)
    }
  }

  const handleReject = async () => {
    if (!rejectReason.trim()) {
      return
    }
    setSubmitting(true)
    try {
      await bonafide.agent.rejectAction(workspaceRoot, {
        threadId,
        toolCallId,
        decision: "reject",
      })
      onRejected?.()
      onClose()
    } catch (err) {
      console.error("[ApprovalDialog] rejectAction failed:", err)
      setSubmitting(false)
    }
  }

  const handleRequestRevision = async () => {
    if (!revisionInstruction.trim()) {
      return
    }
    setSubmitting(true)
    try {
      // Request revision by using the "revise" decision
      await bonafide.agent.approveAction(workspaceRoot, {
        threadId,
        toolCallId,
        decision: "revise",
      })
      onRevisionRequested?.()
      onClose()
    } catch (err) {
      console.error("[ApprovalDialog] requestRevision failed:", err)
      setSubmitting(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && !submitting) {
      onClose()
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-surface/80 backdrop-blur-sm"
        onClick={onClose}
        onKeyDown={handleKeyDown}
      />

      {/* Dialog */}
      <div
        className="fixed left-1/2 top-1/2 z-50 flex w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-outline-variant bg-surface-container shadow-2xl"
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-outline-variant px-4 py-3">
          <div className="flex items-center gap-2">
            <Icon name="shield-alert" size={18} className="text-tertiary" />
            <h2 className="headline-md text-on-surface">Approval Required</h2>
          </div>
          <button
            onClick={onClose}
            disabled={submitting}
            className="rounded p-1 text-outline hover:bg-surface-container-high hover:text-on-surface disabled:opacity-50"
            aria-label="Close"
          >
            <Icon name="x" size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto p-4">
          {/* Risk badge */}
          <div
            className={`flex items-center gap-2 rounded border ${styles.border} ${styles.bg} px-3 py-2`}
          >
            <Icon name={styles.icon} size={14} className={styles.text} />
            <span className={`label-caps ${styles.text}`}>
              Risk: {escalation.toUpperCase()}
            </span>
          </div>

          {/* Tool info */}
          <div>
            <span className="label-caps text-on-surface-variant">Tool Call</span>
            <div className="mt-1 rounded border border-outline-variant bg-surface px-3 py-2">
              <p className="font-code text-[13px] text-primary">{toolName}</p>
            </div>
          </div>

          {/* Tool args */}
          <div>
            <span className="label-caps text-on-surface-variant">Arguments</span>
            <div className="mt-1 max-h-32 overflow-y-auto rounded border border-outline-variant bg-surface px-3 py-2">
              <pre className="font-code text-[12px] leading-[18px] text-on-surface-variant">
                {JSON.stringify(toolArgs, null, 2)}
              </pre>
            </div>
          </div>

          {/* Agent reasoning */}
          <div>
            <span className="label-caps text-on-surface-variant">
              Agent Reasoning
            </span>
            <div className="mt-1 rounded border border-outline-variant bg-surface-container-low px-3 py-2">
              <p className="font-body text-[13px] leading-[19px] text-on-surface">
                {reasoning}
              </p>
            </div>
          </div>

          {/* Reject reason input (shown when Reject is clicked) */}
          {showRejectReason && (
            <div>
              <span className="label-caps text-on-surface-variant">
                Rejection Reason
              </span>
              <textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Explain why this action should be rejected..."
                rows={3}
                className="mt-1 w-full resize-none rounded border border-outline-variant bg-surface px-3 py-2 font-body text-[13px] leading-[19px] text-on-surface placeholder:text-outline focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/25"
                autoFocus
              />
            </div>
          )}

          {/* Revision instruction input (shown when Request Revision is clicked) */}
          {showRevisionInput && (
            <div>
              <span className="label-caps text-on-surface-variant">
                Revision Instructions
              </span>
              <textarea
                value={revisionInstruction}
                onChange={(e) => setRevisionInstruction(e.target.value)}
                placeholder="Tell the agent what to change..."
                rows={3}
                className="mt-1 w-full resize-none rounded border border-outline-variant bg-surface px-3 py-2 font-body text-[13px] leading-[19px] text-on-surface placeholder:text-outline focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/25"
                autoFocus
              />
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-end gap-2 border-t border-outline-variant px-4 py-3">
          {showRejectReason ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowRejectReason(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleReject}
                disabled={!rejectReason.trim() || submitting}
                className="!bg-error !text-on-error hover:!bg-error/90"
              >
                {submitting ? "Rejecting..." : "Confirm Reject"}
              </Button>
            </>
          ) : showRevisionInput ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowRevisionInput(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleRequestRevision}
                disabled={!revisionInstruction.trim() || submitting}
                className="!bg-tertiary !text-on-tertiary hover:!bg-tertiary/90"
              >
                {submitting ? "Requesting..." : "Send Revision"}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowRejectReason(true)}
                disabled={submitting}
                className="!text-error hover:bg-error/10"
              >
                Reject
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowRevisionInput(true)}
                disabled={submitting}
                className="!text-tertiary hover:bg-tertiary/10"
              >
                Request Revision
              </Button>
              <Button
                size="sm"
                onClick={handleApprove}
                disabled={submitting}
                className="!bg-primary !text-on-primary hover:!bg-primary/90"
              >
                {submitting ? "Approving..." : "Approve"}
              </Button>
            </>
          )}
        </div>
      </div>
    </>
  )
}
