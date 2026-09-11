import { useCallback, useEffect, useRef, useState } from "react"
import { Icon } from "./ui/Icon"
import { SectionLabel } from "./ui/primitives"
import { Chart } from "./ui/Chart"
import type { Run } from "../data/runs"
import { AgentContent } from "./agent/AgentContent"
import { BudgetMeter } from "./ui/BudgetMeter"
import { RunEmptyState, DiffEmptyState } from "./ui/RunEmptyState"
import { WorkflowPanel } from "./agent/WorkflowPanel"
import { AnomalyTimeline } from "./agent/AnomalyTimeline"
import { useWorkspaceRoot } from "../ide/hooks"

const TABS = ["Overview", "Metrics", "Agent", "Workflow", "Experiments", "Artifacts", "Config", "Diff"] as const
type TabName = typeof TABS[number]

/**
 * Tab strip with two nav arrows instead of a scrollbar.
 *
 * The scroll container is hidden from overflow (`overflow-hidden`) so
 * the user can't drag-scroll it; left/right chevron buttons drive a
 * programmatic scroll by ~80% of the visible width per click. The
 * arrows disable themselves at each end so we never expose a dead
 * button, and the active-tab pill always scrolls back into view when
 * the user reselects a tab that's currently off-screen.
 */
function TabsRow({
  active,
  onSelect,
}: {
  active: TabName
  onSelect: (t: TabName) => void
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const tabRefs = useRef(new Map<number, HTMLButtonElement>())
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const updateScrollState = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 1)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  // Observe size + scroll changes so the arrow-enabled state always
  // matches reality (panel resize, theme switch, tab labels change, …).
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    updateScrollState()
    el.addEventListener("scroll", updateScrollState, { passive: true })
    const ro = new ResizeObserver(updateScrollState)
    ro.observe(el)
    return () => {
      el.removeEventListener("scroll", updateScrollState)
      ro.disconnect()
    }
  }, [updateScrollState])

  // Keep the active tab visible when it changes (e.g. via keyboard
  // shortcut or external state) so it isn't stranded off-screen.
  useEffect(() => {
    const idx = TABS.indexOf(active)
    const btn = tabRefs.current.get(idx)
    const el = scrollerRef.current
    if (!btn || !el) return
    const btnRect = btn.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    if (btnRect.left < elRect.left) {
      el.scrollBy({ left: btnRect.left - elRect.left - 4, behavior: "smooth" })
    } else if (btnRect.right > elRect.right) {
      el.scrollBy({ left: btnRect.right - elRect.right + 4, behavior: "smooth" })
    }
  }, [active])

  const scrollByViewport = (direction: -1 | 1) => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: "smooth" })
  }

  return (
    <div className="flex h-8 min-w-0 shrink-0 items-stretch border-b border-outline-variant">
      <button
        type="button"
        onClick={() => scrollByViewport(-1)}
        disabled={!canScrollLeft}
        aria-label="Scroll tabs left"
        title="Scroll tabs left"
        className="flex w-6 shrink-0 items-center justify-center text-outline transition-colors hover:bg-surface-container hover:text-on-surface disabled:cursor-default disabled:opacity-0"
      >
        <Icon name="chevron-left" size={12} />
      </button>
      <div
        ref={scrollerRef}
        className="flex min-w-0 flex-1 items-stretch gap-0 overflow-hidden"
      >
        {TABS.map((t, idx) => (
          <button
            key={t}
            ref={(el) => {
              if (el) tabRefs.current.set(idx, el)
              else tabRefs.current.delete(idx)
            }}
            onClick={() => onSelect(t)}
            title={t}
            aria-current={active === t ? "page" : undefined}
            className={`relative flex h-full min-w-0 shrink-0 items-center px-2.5 font-sans text-[13px] transition-colors duration-[120ms] ${
              active === t
                ? "text-on-surface"
                : "text-on-surface-variant hover:text-on-surface"
            }`}
          >
            <span className="truncate">{t}</span>
            {active === t && (
              <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />
            )}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => scrollByViewport(1)}
        disabled={!canScrollRight}
        aria-label="Scroll tabs right"
        title="Scroll tabs right"
        className="flex w-6 shrink-0 items-center justify-center text-outline transition-colors hover:bg-surface-container hover:text-on-surface disabled:cursor-default disabled:opacity-0"
      >
        <Icon name="chevron-right" size={12} />
      </button>
    </div>
  )
}

type DiffLine = { sign: " " | "+" | "-" text: string }

function parseDiffText(text: string): DiffLine[] {
  const out: DiffLine[] = []
  for (const raw of text.split("\n")) {
    if (raw.startsWith("+++") || raw.startsWith("---")) continue
    const sign = raw.startsWith("+")
      ? "+"
      : raw.startsWith("-")
        ? "-"
        : " "
    out.push({ sign, text: raw.replace(/^[+-] /, " ") })
  }
  return out
}

/**
 * Inspector panel. Shows details for a single ML run.
 *
 * The `run` prop is currently `null` (no real run-tracker backend wired in).
 * When `run` is `null` the panel renders a placeholder so the layout stays intact.
 * Copy the full Inspector implementation from `src/data/artifacts.ts` when a
 * real run tracker (W&B / MLflow) is connected.
 */
export function Inspector({
  run,
  onClose,
  onOpenWorkflow,
  width = 320,
  /** Currently selected run. Pass `null` to show the empty state. */
}: {
  run?: {
    name: string
    shortHash: string
    state: string
    step: number
    totalSteps: number
  } | null
  onClose: () => void
  onOpenWorkflow?: () => void
  width?: number
}) {
  const [tab, setTab] = useState<TabName>("Overview")

  if (!run) {
    return (
      <aside
        style={{ width }}
        className="flex shrink-0 flex-col border-l border-outline-variant bg-surface-container-low"
      >
        {/* Header */}
        <div className="shrink-0 border-b border-outline-variant px-4 py-2">
          <div className="flex items-center justify-between">
            <span className="font-body text-[16px] font-medium text-on-surface">
              Inspector
            </span>
            <button
              onClick={onClose}
              className="flex items-center gap-1 font-sans text-[12px] text-outline hover:text-on-surface"
              aria-label="Close inspector"
            >
              ⌘W <Icon name="x" size={14} />
            </button>
          </div>
        </div>

        {/* Budget meter strip — shows dollars + GPU hours spent vs budget */}
        <BudgetMeter />

        {/* Tabs — left/right chevrons scroll the row; no scrollbar. */}
        <TabsRow active={tab} onSelect={setTab} />
        <div className="flex flex-1 flex-col overflow-hidden">
          {tab === "Agent" ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-4">
              <AgentContent onOpenWorkflow={onOpenWorkflow} />
            </div>
          ) : tab === "Workflow" ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              <WorkflowPanel />
            </div>
          ) : (
            <RunEmptyState />
          )}
        </div>
      </aside>
    )
  }

  return (
    <aside
      style={{ width }}
      className="flex shrink-0 flex-col border-l border-outline-variant bg-surface-container-low"
    >
      {/* Header */}
      <div className="shrink-0 border-b border-outline-variant px-4 py-2">
        <div className="flex items-center justify-between">
          <span className="font-body text-[16px] font-medium text-primary">
            {run.name}
          </span>
          <button
            onClick={onClose}
            className="flex items-center gap-1 font-sans text-[12px] text-outline hover:text-on-surface"
            aria-label="Close inspector"
          >
            ⌘W <Icon name="x" size={14} />
          </button>
        </div>
        <div className="mt-0.5 font-sans text-[12px] text-on-surface-variant">
          {run.shortHash} · step {run.step.toLocaleString()} /{" "}
          {run.totalSteps.toLocaleString()}
        </div>
      </div>

      {/* Budget meter strip — shows dollars + GPU hours spent vs budget */}
      <BudgetMeter />

      {/* Tabs — left/right chevrons scroll the row; no scrollbar. */}
      <TabsRow active={tab} onSelect={setTab} />

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        {tab === "Overview" && <RunOverview run={run} />}
        {tab === "Metrics" && <RunMetrics run={run} />}
        {tab === "Agent" && (
          <AgentContent run={run as Run} onOpenWorkflow={onOpenWorkflow} />
        )}
        {tab === "Workflow" && (
          <div className="flex min-h-0 min-w-0 h-full -m-4 flex-col overflow-hidden">
            <WorkflowPanel />
          </div>
        )}
        {tab === "Config" && <RunConfig run={run} />}
        {tab === "Diff" && <RunDiff run={run} />}
      </div>
    </aside>
  )
}

function RunOverview({
  run,
}: {
  run: NonNullable<Parameters<typeof Inspector>[0]["run"]>
}) {
  const pct =
    run.totalSteps > 0 ? Math.round((run.step / run.totalSteps) * 100) : 0
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <SectionLabel>Progress</SectionLabel>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container">
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="text-right font-sans text-[12px] tabular-nums text-on-surface-variant">
          {pct}% · step {run.step.toLocaleString()} /{" "}
          {run.totalSteps.toLocaleString()}
        </div>
      </section>
    </div>
  )
}

function RunMetrics({
  run,
}: {
  run: NonNullable<Parameters<typeof Inspector>[0]["run"]>
}) {
  const workspaceRoot = useWorkspaceRoot()

  // Placeholder chart dimensions for AnomalyTimeline overlay
  const [chartDimensions] = useState({ width: 280, height: 120 })

  return (
    <div className="flex flex-col gap-4">
      <p className="font-body text-[13px] text-on-surface-variant">
        Run metrics will appear here once a tracker (W&amp;B / MLflow) is
        connected.
      </p>

      {/* Anomaly timeline overlay on placeholder chart */}
      {workspaceRoot && run && (
        <div className="relative rounded border border-outline-variant bg-surface-container-low">
          {/* Placeholder chart area for anomaly markers */}
          <div
            className="relative overflow-hidden rounded"
            style={{
              width: chartDimensions.width,
              height: chartDimensions.height,
              background: "linear-gradient(to right, var(--color-surface-container-low) 0%, var(--color-surface-container) 100%)",
            }}
          >
            {/* Simple placeholder metric line */}
            <svg
              width={chartDimensions.width}
              height={chartDimensions.height}
              className="absolute inset-0"
            >
              <polyline
                points="0,60 40,55 80,65 120,50 160,70 200,45 240,55 280,40"
                fill="none"
                stroke="var(--color-outline)"
                strokeWidth="1.5"
                strokeDasharray="4,2"
              />
            </svg>

            {/* Anomaly markers overlay */}
            <AnomalyTimeline
              workspaceRoot={workspaceRoot}
              runId={run.shortHash}
              chartWidth={chartDimensions.width}
              chartHeight={chartDimensions.height}
              maxStep={run.totalSteps}
              onMarkerClick={(anomaly) => {
                console.log("[Metrics] Anomaly clicked:", anomaly)
              }}
            />
          </div>

          {/* Chart label */}
          <div className="border-t border-outline-variant px-3 py-2">
            <span className="label-caps text-on-surface-variant">
              Anomalies
            </span>
            <span className="ml-2 font-sans text-[11px] text-outline">
              run {run.shortHash}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function RunConfig({
  run,
}: {
  run: NonNullable<Parameters<typeof Inspector>[0]["run"]>
}) {
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>Config</SectionLabel>
      <p className="font-body text-[13px] text-on-surface-variant">
        Run config will appear here once a tracker is connected.
      </p>
    </div>
  )
}

function RunDiff({
  run,
}: {
  run: NonNullable<Parameters<typeof Inspector>[0]["run"]>
}) {
  const [diffLines, setDiffLines] = useState<DiffLine[]>([])

  // P0-T10: fetch diff via IPC instead of hardcoding. Until the backend
  // ships real diff lines, this resolves to `[]` and the empty state
  // shows.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const rows: DiffLine[] = []
        if (!cancelled) setDiffLines(rows)
      } catch {
        if (!cancelled) setDiffLines([])
      }
    })()
    return () => {
      cancelled = true
    }
    // `run.shortHash` is a stable identifier for the selected run;
    // re-fetch when it changes.
  }, [run.shortHash])

  if (diffLines.length === 0) return <DiffEmptyState />

  return (
    <div className="flex flex-col gap-3">
      <div className="label-caps rounded-t bg-surface-container px-2 py-1 text-on-surface-variant">
        src/train.py
      </div>
      <div className="overflow-hidden rounded-b border border-outline-variant font-sans text-[13px] leading-[22px]">
        {diffLines.map((l, i) => (
          <div
            key={i}
            className={`flex whitespace-pre ${
              l.sign === "+"
                ? "bg-primary/10 text-primary"
                : l.sign === "-"
                  ? "bg-error/10 text-error"
                  : "text-on-surface-variant"
            }`}
          >
            <span
              className={`w-6 shrink-0 text-center ${
                l.sign === "+"
                  ? "text-primary"
                  : l.sign === "-"
                    ? "text-error"
                    : "text-outline"
              }`}
            >
              {l.sign === " " ? "" : l.sign}
            </span>
            <span className="pr-2">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// Re-export the parser so callers that have raw unified-diff text can
// reuse it without pulling in the React component.
export { parseDiffText }
