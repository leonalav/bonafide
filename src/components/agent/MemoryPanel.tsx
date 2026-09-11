/**
 * MemoryPanel — UI surface for the project memory subsystem.
 *
 * Lists the FIFO-capped insights (high-signal learnings from past
 * experiments) and dead ends (hypotheses already ruled out) that the
 * engine injects into every mode's system prompt (Layer 4). The panel
 * also lets the user manually write new entries — useful when an
 * insight surfaces outside the agent loop (e.g. reading a paper, a
 * standup discussion).
 *
 * FIFO cap (spec §11.2): 50 insights + 50 dead ends per workspace.
 * Once the cap is hit, new writes evict the oldest entry. The panel
 * surfaces the cap with a usage indicator so users know how close they
 * are to triggering eviction.
 *
 * Data flow:
 *   - On mount: `bonafide.agent.queryProjectMemory(workspaceRoot)`
 *     returns both lists. Empty query means "return all".
 *   - On submit (form): `writeProjectInsight` / `writeProjectDeadEnd`.
 *   - Refresh button + after-submit: re-fetch both lists.
 */

import { useCallback, useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { Icon } from "../ui/Icon"
import { Button } from "../ui/primitives"
import { bonafide } from "../../ipc/tauri"
import type {
  MemoryConfidence,
  ProjectInsight,
  ProjectDeadEnd,
} from "../../ipc/tauri"
import { useWorkspaceRoot } from "../../ide/hooks"

// ── FIFO cap (spec §11.2) ────────────────────────────────────────────────────

const INSIGHT_CAP = 50
const DEAD_END_CAP = 50

// ── Date / relative-time formatting ──────────────────────────────────────────

/**
 * Format an epoch-ms timestamp as "5m ago", "2h ago", "3d ago" —
 * mirrors the rest of the UI so dates feel consistent. Older entries
 * fall back to a short ISO date so the column doesn't become noise.
 */
function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return "just now"
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`
  return new Date(ts).toISOString().slice(0, 10)
}

// ── Confidence pill ──────────────────────────────────────────────────────────

const CONFIDENCE_TONE: Record<MemoryConfidence, string> = {
  high: "bg-primary/15 text-primary",
  medium: "bg-tertiary-container text-on-tertiary-container",
  low: "bg-outline/15 text-outline",
}

function ConfidencePill({ value }: { value: MemoryConfidence }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-wide ${CONFIDENCE_TONE[value]}`}
    >
      {value}
    </span>
  )
}

// ── Cap indicator ────────────────────────────────────────────────────────────

function CapIndicator({ used, cap }: { used: number; cap: number }) {
  const ratio = used / cap
  const tone =
    ratio >= 1
      ? "bg-error"
      : ratio >= 0.8
        ? "bg-tertiary"
        : "bg-primary"
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-1 w-16 overflow-hidden rounded-full bg-surface-container-high">
        <div
          className={`h-full ${tone} transition-[width] duration-300`}
          style={{ width: `${Math.min(100, ratio * 100)}%` }}
        />
      </div>
      <span className="font-sans text-[11px] text-on-surface-variant">
        {used} / {cap}
      </span>
    </div>
  )
}

// ── Form modal ───────────────────────────────────────────────────────────────

type FormKind = "insight" | "dead_end"

interface FormState {
  kind: FormKind
  finding: string
  evidence: string
  confidence: MemoryConfidence
  hypothesis: string
}

const EMPTY_FORM: FormState = {
  kind: "insight",
  finding: "",
  evidence: "",
  confidence: "medium",
  hypothesis: "",
}

function MemoryFormModal({
  open,
  onClose,
  onSubmit,
  initialKind,
}: {
  open: boolean
  onClose: () => void
  onSubmit: (form: FormState) => Promise<void>
  initialKind: FormKind
}) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset form whenever the modal opens (and on kind change).
  useEffect(() => {
    if (open) {
      setForm({ ...EMPTY_FORM, kind: initialKind })
      setError(null)
    }
  }, [open, initialKind])

  if (!open) return null

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (form.kind === "insight" && !form.finding.trim()) {
      setError("Finding is required")
      return
    }
    if (form.kind === "dead_end" && !form.hypothesis.trim()) {
      setError("Hypothesis is required")
      return
    }
    if (!form.evidence.trim()) {
      setError("Evidence is required")
      return
    }
    setSubmitting(true)
    try {
      await onSubmit(form)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-background/70 px-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-outline-variant bg-surface-container-low p-5 shadow-xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-body text-[16px] font-medium text-on-surface">
            New memory entry
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        {/* Kind picker (segmented control) */}
        <div className="mb-4 inline-flex rounded border border-outline-variant bg-surface-container p-0.5">
          {(["insight", "dead_end"] as FormKind[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setForm((f) => ({ ...f, kind: k }))}
              className={`h-7 rounded px-3 font-sans text-[12px] transition-colors ${
                form.kind === k
                  ? "bg-primary text-on-primary"
                  : "text-on-surface-variant hover:text-on-surface"
              }`}
            >
              {k === "insight" ? "Insight" : "Dead end"}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          {form.kind === "insight" ? (
            <Field label="Finding" required>
              <textarea
                value={form.finding}
                onChange={(e) =>
                  setForm((f) => ({ ...f, finding: e.target.value }))
                }
                rows={3}
                placeholder="One-sentence learning (e.g. 'Learning rate above 1e-3 always diverges on this dataset')"
                className="w-full resize-none rounded border border-outline-variant bg-surface-container px-2 py-1.5 font-body text-[13px] text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
              />
            </Field>
          ) : (
            <Field label="Hypothesis" required>
              <textarea
                value={form.hypothesis}
                onChange={(e) =>
                  setForm((f) => ({ ...f, hypothesis: e.target.value }))
                }
                rows={3}
                placeholder="The approach already tried (e.g. 'Switch to SGD with momentum')"
                className="w-full resize-none rounded border border-outline-variant bg-surface-container px-2 py-1.5 font-body text-[13px] text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
              />
            </Field>
          )}

          <Field label="Evidence" required>
            <textarea
              value={form.evidence}
              onChange={(e) =>
                setForm((f) => ({ ...f, evidence: e.target.value }))
              }
              rows={2}
              placeholder="Why we believe this — run ids, metric values, paper citations"
              className="w-full resize-none rounded border border-outline-variant bg-surface-container px-2 py-1.5 font-body text-[13px] text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
            />
          </Field>

          {form.kind === "insight" && (
            <Field label="Confidence">
              <div className="flex gap-1">
                {(["low", "medium", "high"] as MemoryConfidence[]).map(
                  (c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() =>
                        setForm((f) => ({ ...f, confidence: c }))
                      }
                      className={`h-7 rounded border px-3 font-sans text-[11px] capitalize transition-colors ${
                        form.confidence === c
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-outline-variant text-on-surface-variant hover:border-outline"
                      }`}
                    >
                      {c}
                    </button>
                  ),
                )}
              </div>
            </Field>
          )}

          {error && (
            <p className="font-body text-[12px] text-error">{error}</p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-sans text-[11px] uppercase tracking-wide text-on-surface-variant">
        {label} {required && <span className="text-error">*</span>}
      </span>
      {children}
    </label>
  )
}

// ── Table column helpers ─────────────────────────────────────────────────────

const HEADER_CELL =
  "label-caps px-3 py-2 text-left font-sans text-[10px] font-semibold uppercase tracking-wide text-outline"
const BODY_CELL = "px-3 py-2 font-body text-[13px] text-on-surface align-top"

// ── Main panel ──────────────────────────────────────────────────────────────

export function MemoryPanel({ onClose }: { onClose: () => void }) {
  const workspaceRoot = useWorkspaceRoot()
  const [insights, setInsights] = useState<ProjectInsight[]>([])
  const [deadEnds, setDeadEnds] = useState<ProjectDeadEnd[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [modalKind, setModalKind] = useState<FormKind>("insight")

  const refresh = useCallback(async () => {
    if (!workspaceRoot) return
    setLoading(true)
    setError(null)
    try {
      const result = await bonafide.agent.queryProjectMemory(workspaceRoot)
      setInsights(result.insights)
      setDeadEnds(result.deadEnds)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [workspaceRoot])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function handleSubmit(form: FormState) {
    if (!workspaceRoot) return
    if (form.kind === "insight") {
      await bonafide.agent.writeProjectInsight(workspaceRoot, {
        workspaceHash: workspaceRoot,
        finding: form.finding.trim(),
        evidence: form.evidence.trim(),
        confidence: form.confidence,
      })
    } else {
      await bonafide.agent.writeProjectDeadEnd(workspaceRoot, {
        workspaceHash: workspaceRoot,
        hypothesis: form.hypothesis.trim(),
        evidence: form.evidence.trim(),
      })
    }
    await refresh()
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon name="archive" size={16} className="text-primary" />
          <h1 className="font-body text-[16px] font-medium text-on-surface">
            Project memory
          </h1>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading}
            title="Refresh"
          >
            <Icon name="refresh" size={12} />
          </Button>
          {onClose && (
            <Button variant="ghost" size="sm" onClick={onClose} title="Close">
              <Icon name="x" size={12} />
            </Button>
          )}
        </div>
      </div>

      <p className="font-body text-[12px] text-on-surface-variant">
        Insights and dead ends are injected into every mode's system prompt
        (Layer 4). The agent sees them automatically; this panel is for
        reading, auditing, and adding entries by hand.
      </p>

      {/* Cap indicators */}
      <div className="grid grid-cols-2 gap-3">
        <CapCard
          icon="check-circle"
          label="Insights"
          used={insights.length}
          cap={INSIGHT_CAP}
          onAdd={() => {
            setModalKind("insight")
            setModalOpen(true)
          }}
        />
        <CapCard
          icon="circle-x"
          label="Dead ends"
          used={deadEnds.length}
          cap={DEAD_END_CAP}
          onAdd={() => {
            setModalKind("dead_end")
            setModalOpen(true)
          }}
        />
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded border border-error/30 bg-error/10 px-3 py-2 font-body text-[12px] text-error">
          <Icon name="alert-triangle" size={14} />
          {error}
        </div>
      )}

      {/* Insights table */}
      <Section
        title="Insights"
        empty={
          loading
            ? "Loading…"
            : "No insights recorded yet. Add one with the button above — the agent will see it on the next turn."
        }
      >
        {insights.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-outline-variant">
            <table className="w-full border-collapse">
              <thead className="bg-surface-container">
                <tr>
                  <th className={HEADER_CELL}>Confidence</th>
                  <th className={HEADER_CELL}>Finding</th>
                  <th className={HEADER_CELL}>Evidence</th>
                  <th className={HEADER_CELL + " w-20"}>Created</th>
                </tr>
              </thead>
              <tbody>
                {insights.map((row) => (
                  <tr
                    key={row.id}
                    className="border-t border-outline-variant/50 transition-colors hover:bg-surface-container-low"
                  >
                    <td className={BODY_CELL}>
                      <ConfidencePill value={row.confidence} />
                    </td>
                    <td className={BODY_CELL}>
                      <span className="block max-w-[420px] whitespace-pre-wrap break-words">
                        {row.finding}
                      </span>
                    </td>
                    <td className={BODY_CELL}>
                      <span className="block max-w-[420px] whitespace-pre-wrap break-words text-on-surface-variant">
                        {row.evidence}
                      </span>
                    </td>
                    <td className={BODY_CELL + " text-on-surface-variant"}>
                      {formatRelative(row.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Dead ends table */}
      <Section
        title="Dead ends"
        empty={
          loading
            ? "Loading…"
            : "No dead ends recorded yet. The agent will write here when it rules out a hypothesis."
        }
      >
        {deadEnds.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-outline-variant">
            <table className="w-full border-collapse">
              <thead className="bg-surface-container">
                <tr>
                  <th className={HEADER_CELL}>Type</th>
                  <th className={HEADER_CELL}>Hypothesis</th>
                  <th className={HEADER_CELL}>Evidence</th>
                  <th className={HEADER_CELL + " w-20"}>Created</th>
                </tr>
              </thead>
              <tbody>
                {deadEnds.map((row) => (
                  <tr
                    key={row.id}
                    className="border-t border-outline-variant/50 transition-colors hover:bg-surface-container-low"
                  >
                    <td className={BODY_CELL}>
                      <span className="inline-flex items-center gap-1 rounded bg-outline/15 px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-wide text-outline">
                        dead end
                      </span>
                    </td>
                    <td className={BODY_CELL}>
                      <span className="block max-w-[420px] whitespace-pre-wrap break-words">
                        {row.hypothesis}
                      </span>
                    </td>
                    <td className={BODY_CELL}>
                      <span className="block max-w-[420px] whitespace-pre-wrap break-words text-on-surface-variant">
                        {row.evidence}
                      </span>
                    </td>
                    <td className={BODY_CELL + " text-on-surface-variant"}>
                      {formatRelative(row.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <MemoryFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSubmit={handleSubmit}
        initialKind={modalKind}
      />
    </div>
  )
}

function CapCard({
  icon,
  label,
  used,
  cap,
  onAdd,
}: {
  icon: string
  label: string
  used: number
  cap: number
  onAdd: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2">
      <div className="flex items-center gap-2">
        <Icon name={icon} size={14} className="text-on-surface-variant" />
        <div className="flex flex-col">
          <span className="font-body text-[12px] text-on-surface">{label}</span>
          <CapIndicator used={used} cap={cap} />
        </div>
      </div>
      <Button variant="secondary" size="sm" onClick={onAdd}>
        <Icon name="plus" size={11} />
        Add
      </Button>
    </div>
  )
}

function Section({
  title,
  empty,
  children,
}: {
  title: string
  empty: string
  children?: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="label-caps text-on-surface-variant">{title}</h2>
      {children ?? (
        <div className="rounded-lg border border-dashed border-outline-variant/50 bg-surface-container-low px-3 py-4 font-body text-[12px] text-outline">
          {empty}
        </div>
      )}
    </section>
  )
}
