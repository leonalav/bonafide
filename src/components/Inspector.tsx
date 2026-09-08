import { useState } from "react"
import { Icon } from "./ui/Icon"
import { SectionLabel } from "./ui/primitives"
import { Select } from "./ui/Select"
import { Chart } from "./ui/Chart"

const TABS = ["Overview", "Metrics", "Config", "Diff"] as const
type TabName = (typeof TABS)[number]

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
  width = 320,
}: {
  /** Currently selected run. Pass `null` to show the empty state. */
  run?: { name: string; shortHash: string; state: string; step: number; totalSteps: number } | null
  onClose: () => void
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
            <span className="font-body text-[16px] font-medium text-on-surface">Inspector</span>
            <button
              onClick={onClose}
              className="flex items-center gap-1 font-sans text-[12px] text-outline hover:text-on-surface"
              aria-label="Close inspector"
            >
              ⌘W <Icon name="x" size={14} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex h-8 shrink-0 items-stretch border-b border-outline-variant px-2">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`relative px-2.5 font-sans text-[13px] transition-colors duration-[120ms] ${
                tab === t ? "text-on-surface" : "text-on-surface-variant hover:text-on-surface"
              }`}
            >
              {t}
              {tab === t && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />}
            </button>
          ))}
        </div>

        {/* Empty state */}
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-container">
            <Icon name="flask-conical" size={24} className="text-outline-variant" />
          </div>
          <div>
            <p className="font-sans text-[14px] font-medium text-on-surface">No run selected</p>
            <p className="mt-1 font-body text-[12px] text-on-surface-variant">
              Run tracking is not yet connected. Once W&amp;B or MLflow is wired up, run details will appear here.
            </p>
          </div>
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
          <span className="font-body text-[16px] font-medium text-primary">{run.name}</span>
          <button
            onClick={onClose}
            className="flex items-center gap-1 font-sans text-[12px] text-outline hover:text-on-surface"
            aria-label="Close inspector"
          >
            ⌘W <Icon name="x" size={14} />
          </button>
        </div>
        <div className="mt-0.5 font-sans text-[12px] text-on-surface-variant">
          {run.shortHash} · step {run.step.toLocaleString()} / {run.totalSteps.toLocaleString()}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex h-8 shrink-0 items-stretch border-b border-outline-variant px-2">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`relative px-2.5 font-sans text-[13px] transition-colors duration-[120ms] ${
              tab === t ? "text-on-surface" : "text-on-surface-variant hover:text-on-surface"
            }`}
          >
            {t}
            {tab === t && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        {tab === "Overview" && <RunOverview run={run} />}
        {tab === "Metrics" && <RunMetrics run={run} />}
        {tab === "Config" && <RunConfig run={run} />}
        {tab === "Diff" && <RunDiff />}
      </div>
    </aside>
  )
}

function RunOverview({ run }: { run: NonNullable<Parameters<typeof Inspector>[0]["run"]> }) {
  const pct = Math.round((run.step / run.totalSteps) * 100)
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <SectionLabel>Progress</SectionLabel>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container">
          <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
        </div>
        <div className="text-right font-sans text-[12px] tabular-nums text-on-surface-variant">
          {pct}% · step {run.step.toLocaleString()} / {run.totalSteps.toLocaleString()}
        </div>
      </section>
    </div>
  )
}

function RunMetrics({ run }: { run: NonNullable<Parameters<typeof Inspector>[0]["run"]> }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="font-body text-[13px] text-on-surface-variant">
        Run metrics will appear here once a tracker (W&amp;B / MLflow) is connected.
      </p>
    </div>
  )
}

function RunConfig({ run }: { run: NonNullable<Parameters<typeof Inspector>[0]["run"]> }) {
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>Config</SectionLabel>
      <p className="font-body text-[13px] text-on-surface-variant">
        Run config will appear here once a tracker is connected.
      </p>
    </div>
  )
}

const DIFF_LINES: { sign: " " | "+" | "-"; text: string }[] = [
  { sign: "-", text: "lr = 1e-3" },
  { sign: "+", text: "lr = 5e-4" },
  { sign: " ", text: "" },
  { sign: "-", text: "batch_size = 64" },
  { sign: "+", text: "batch_size = 128" },
]

function RunDiff() {
  return (
    <div className="flex flex-col gap-3">
      <div className="label-caps rounded-t bg-surface-container px-2 py-1 text-on-surface-variant">src/train.py</div>
      <div className="overflow-hidden rounded-b border border-outline-variant font-sans text-[13px] leading-[22px]">
        {DIFF_LINES.map((l, i) => (
          <div
            key={i}
            className={`flex whitespace-pre ${
              l.sign === "+" ? "bg-primary/10 text-primary" : l.sign === "-" ? "bg-error/10 text-error" : "text-on-surface-variant"
            }`}
          >
            <span
              className={`w-6 shrink-0 text-center ${
                l.sign === "+" ? "text-primary" : l.sign === "-" ? "text-error" : "text-outline"
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
