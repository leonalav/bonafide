import { useState } from "react";
import { Chart, fmtValue } from "./ui/Chart";
import { Chip } from "./ui/primitives";
import { useRunsData } from "../data/runs";

export function ChartTab({ runId, metricKey }: { runId: string; metricKey: string }) {
  const runs = useRunsData();
  const run = runs.find((r) => r.id === runId) ?? runs[0];
  const [active, setActive] = useState(metricKey);
  const m = run.metrics.find((x) => x.key === active) ?? run.metrics[0];
  const tone = m.lowerIsBetter ? "positive" : "positive";
  const better = m.lowerIsBetter ? m.delta < 0 : m.delta > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      {/* Header */}
      <div className="shrink-0 border-b border-outline-variant px-6 py-4">
        <div className="flex items-baseline gap-3">
          <h1 className="font-sans text-[18px] font-medium text-on-surface">{m.label}</h1>
          <span className="font-body text-[13px] text-on-surface-variant">
            {run.name} · <span className="text-primary">{run.commit}</span>
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {run.metrics.map((x) => (
            <button
              key={x.key}
              onClick={() => setActive(x.key)}
              className={`h-7 rounded-full px-3 font-sans text-[12px] transition-colors duration-[120ms] ${
                active === x.key
                  ? "bg-primary text-on-primary"
                  : "border border-outline-variant text-on-surface-variant hover:text-on-surface"
              }`}
            >
              {x.label}
            </button>
          ))}
        </div>
      </div>

      {/* Big chart */}
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-[960px]">
          <div className="rounded-lg border border-outline-variant bg-surface-container-low p-4">
            <Chart data={m.series} totalSteps={run.totalSteps} tone={tone} height={420} yTicks={6} xTicks={8} ariaLabel={`${m.label} for ${run.name}`} />
          </div>

          {/* Summary stats */}
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Current" value={fmtValue(m.value)} />
            <Stat label="Best" value={fmtValue(m.lowerIsBetter ? Math.min(...m.series) : Math.max(...m.series))} />
            <Stat label="Min → Max" value={`${fmtValue(Math.min(...m.series))} – ${fmtValue(Math.max(...m.series))}`} />
            <Stat
              label="Δ vs prior"
              value={
                <Chip tone={m.delta === 0 ? "neutral" : better ? "positive" : "negative"}>
                  {m.delta === 0 ? "—" : `${m.delta < 0 ? "▾" : "▴"} ${Math.abs(m.delta).toFixed(2)}`}
                </Chip>
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-outline-variant bg-surface-container-low p-3">
      <div className="label-caps text-outline">{label}</div>
      <div className="mt-1 font-sans text-[15px] tabular-nums text-on-surface">{value}</div>
    </div>
  );
}
