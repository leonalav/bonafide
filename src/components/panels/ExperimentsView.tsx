import { useState } from "react"
import { Icon } from "../ui/Icon"
import { Button, Chip } from "../ui/primitives"
import { Sparkline } from "../ui/Sparkline"
import { PanelHeader, PanelSearch } from "./shared"
import { Select } from "../ui/Select"
import {
  EXPERIMENTS,
  EXPERIMENT_STATUS_META,
  type Experiment,
} from "../../data/runs"

function ExperimentCard({
  exp,
  expanded,
  onToggle,
}: {
  exp: Experiment
  expanded: boolean
  onToggle: () => void
}) {
  const meta = EXPERIMENT_STATUS_META[exp.status]
  const shown = expanded ? exp.topRuns : exp.topRuns.slice(0, 3)
  const remaining = exp.runCount - shown.length
  return (
    <div className="rounded-lg border border-outline-variant bg-surface-container p-3">
      <div className="flex items-start justify-between gap-2">
        <button
          onClick={onToggle}
          className="text-left font-sans text-[14px] font-medium leading-tight text-on-surface hover:text-primary"
        >
          {exp.name}
        </button>
        <Chip tone={meta.tone}>
          {exp.status === "active" && (
            <span className="h-1.5 w-1.5 rounded-full bg-primary animate-dot-pulse" />
          )}
          {meta.label} · {exp.runCount}
        </Chip>
      </div>

      <div className="my-2 h-px bg-outline-variant/60" />

      <div className="flex items-center justify-between font-body text-[13px]">
        <span className="text-on-surface-variant">
          Goal: <span className="text-on-surface">{exp.goal}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-outline">Best</span>
          <span className="font-sans text-[16px] font-medium tabular-nums text-primary">
            {exp.best.toFixed(2)}
          </span>
          <Chip tone={exp.bestTone}>−{exp.ago}</Chip>
        </span>
      </div>

      <div className="my-2 w-full overflow-hidden">
        <Sparkline
          data={exp.leaderboard}
          width={208}
          height={32}
          tone="positive"
          fill
          responsive
          ariaLabel={`best val_loss over ${exp.runCount} runs`}
        />
      </div>

      <div className="label-caps mb-1 text-outline">Top runs</div>
      <div className="flex flex-col">
        {shown.map((r) => (
          <div
            key={r.shortHash}
            className="flex items-center gap-2 py-0.5 font-sans text-[12px]"
          >
            <Icon name="chevron-right" size={11} className="text-outline" />
            <span className="flex-1 truncate text-primary/90">
              {r.shortHash}
            </span>
            <span className="tabular-nums text-on-surface">
              {r.val.toFixed(2)}
            </span>
            <span className="w-14 text-right text-outline">{r.commit}</span>
          </div>
        ))}
        {remaining > 0 && (
          <button
            onClick={onToggle}
            className="mt-0.5 pl-4 text-left font-sans text-[12px] text-outline hover:text-on-surface"
          >
            {expanded ? "Show less" : `… ${remaining} more`}
          </button>
        )}
      </div>

      <div className="mt-3 flex items-end justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {exp.tags.map((t) => (
            <span
              key={t}
              className="rounded bg-surface-container-high px-1.5 py-0.5 font-sans text-[11px] text-on-surface-variant"
            >
              {t}
            </span>
          ))}
        </div>
        <button className="flex shrink-0 items-center gap-1 font-sans text-[12px] text-primary hover:brightness-110">
          Open <Icon name="external-link" size={12} />
        </button>
      </div>
    </div>
  )
}

export function ExperimentsView() {
  const [open, setOpen] = useState<string | null>(null)
  const [sort, setSort] = useState("best")
  const [group, setGroup] = useState("status")
  return (
    <>
      <PanelHeader
        title="Experiments"
        right={
          <button className="flex items-center gap-1 rounded px-1.5 py-0.5 font-sans text-[12px] text-on-surface-variant hover:text-on-surface">
            <Icon name="plus" size={13} /> New
          </button>
        }
      />
      <div className="flex flex-col gap-2 border-b border-outline-variant p-2">
        <PanelSearch placeholder="Search experiments..." />
        <div className="flex flex-wrap items-center gap-1.5">
          <Select
            prefix="Sort:"
            value={sort}
            onChange={setSort}
            options={[
              { value: "best", label: "best val_loss" },
              { value: "recent", label: "most recent" },
              { value: "runs", label: "run count" },
              { value: "name", label: "name" },
            ]}
          />
          <Select
            prefix="Group:"
            value={group}
            onChange={setGroup}
            options={[
              { value: "status", label: "status" },
              { value: "tag", label: "tag" },
              { value: "none", label: "none" },
            ]}
          />
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
        {EXPERIMENTS.map((exp) => (
          <ExperimentCard
            key={exp.id}
            exp={exp}
            expanded={open === exp.id}
            onToggle={() => setOpen((o) => (o === exp.id ? null : exp.id))}
          />
        ))}
        <Button variant="secondary" size="sm" className="mt-1 w-full">
          <Icon name="plus" size={13} /> New experiment
        </Button>
      </div>
    </>
  )
}
