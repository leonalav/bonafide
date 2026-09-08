import { useState } from "react";
import { Icon } from "./ui/Icon";
import { StatusDot } from "./ui/primitives";
import { Sparkline } from "./ui/Sparkline";
import { Select } from "./ui/Select";
import { RUNS, STATE_META, type Run } from "../data/runs";

type SortKey = "created" | "val_loss" | "acc" | "duration";

function metricTone(m: Run["metrics"][number]) {
  const better = m.lowerIsBetter ? m.delta <= 0 : m.delta >= 0;
  return better ? "positive" : "negative";
}

export function RunTimeline({
  collapsed,
  onToggle,
  selectedRun,
  onSelectRun,
  runningCount,
}: {
  collapsed: boolean;
  onToggle: () => void;
  selectedRun: string;
  onSelectRun: (id: string) => void;
  runningCount: number;
}) {
  const [sort, setSort] = useState<SortKey>("created");
  const [filter, setFilter] = useState("val_loss");

  if (collapsed) {
    return (
      <div className="flex h-9 shrink-0 items-center justify-between border-t border-outline-variant bg-surface-container-low px-4">
        <div className="flex items-center gap-2">
          <span className="label-caps text-on-surface-variant">Experiments</span>
          <span className="font-sans text-[12px] text-outline">
            27 runs · {runningCount} running · last sync 12s ago
          </span>
        </div>
        <button onClick={onToggle} className="flex items-center gap-1 font-sans text-[12px] text-outline hover:text-on-surface">
          <Icon name="chevron-up" size={13} /> Expand
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-[220px] shrink-0 flex-col border-t border-outline-variant bg-surface-container-low">
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-outline-variant px-4">
        <span className="label-caps text-on-surface-variant">Experiments</span>
        <div className="flex items-center gap-2">
          <Select
            leadingIcon="filter"
            prefix="Filter:"
            value={filter}
            onChange={setFilter}
            align="right"
            options={[
              { value: "val_loss", label: "val_loss" },
              { value: "loss", label: "loss" },
              { value: "acc", label: "acc" },
              { value: "all", label: "all metrics" },
            ]}
          />
          <Select
            prefix="Sort:"
            value={sort}
            onChange={(v) => setSort(v as SortKey)}
            align="right"
            options={[
              { value: "created", label: "created" },
              { value: "val_loss", label: "val_loss" },
              { value: "acc", label: "acc" },
              { value: "duration", label: "duration" },
            ]}
          />
          <button onClick={onToggle} className="flex h-6 items-center gap-1 rounded px-2 font-sans text-[12px] text-outline hover:bg-surface-container hover:text-on-surface">
            <Icon name="minimize" size={12} /> Hide
          </button>
          <Icon name="more-horizontal" size={16} className="text-outline hover:text-on-surface" />
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-surface-container-low">
            <tr className="border-b border-outline-variant">
              {["Run", "State", "val_loss", "acc", "duration", "commit", ""].map((h, i) => (
                <th
                  key={i}
                  onClick={() => h && setSort((s) => (h === "val_loss" || h === "acc" || h === "duration" ? (h as SortKey) : s === "created" ? "created" : s))}
                  className="label-caps px-3 py-2 text-left font-normal text-outline"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {RUNS.map((run) => {
              const meta = STATE_META[run.state];
              const vl = run.metrics.find((m) => m.key === "val_loss")!;
              const acc = run.metrics.find((m) => m.key === "acc")!;
              const sel = selectedRun === run.id;
              return (
                <tr
                  key={run.id}
                  onClick={() => onSelectRun(run.id)}
                  className={`relative h-7 cursor-pointer border-b border-outline-variant/50 transition-colors duration-[120ms] ${
                    sel ? "bg-surface-container-high" : "hover:bg-surface-container"
                  }`}
                >
                  <td className="relative px-3">
                    {sel && <span className="absolute left-0 top-0 h-full w-0.5 bg-primary" />}
                    <span className="flex items-center gap-2">
                      <StatusDot token={meta.token} pulse={meta.pulse} />
                      <span className="font-body text-[13px] text-on-surface">{run.shortHash}</span>
                    </span>
                  </td>
                  <td className="px-3">
                    <span className="flex items-center gap-1.5 font-body text-[13px] text-on-surface-variant">
                      <StatusDot token={meta.token} pulse={meta.pulse} size={6} />
                      {meta.label.toLowerCase()}
                      {meta.warn && <span className="text-error">⚠</span>}
                    </span>
                  </td>
                  <td className="px-3">
                    <Sparkline data={vl.series} width={60} height={18} tone={metricTone(vl)} />
                  </td>
                  <td className="px-3">
                    <Sparkline data={acc.series} width={60} height={18} tone={metricTone(acc)} />
                  </td>
                  <td className="px-3 font-sans text-[13px] tabular-nums text-on-surface-variant">{run.duration}</td>
                  <td className="px-3 font-sans text-[13px] text-outline">{run.commit}</td>
                  <td className="px-3">
                    <span className="flex items-center gap-2 text-outline">
                      <Icon name="x" size={13} className="hover:text-on-surface" />
                      <Icon name="more-vertical" size={13} className="hover:text-on-surface" />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
