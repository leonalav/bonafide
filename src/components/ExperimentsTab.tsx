import { useState } from "react";
import { Icon } from "./ui/Icon";
import { StatusDot } from "./ui/primitives";
import { Select } from "./ui/Select";
import { Chart, fmtValue } from "./ui/Chart";
import { Sparkline } from "./ui/Sparkline";
import { ARTIFACTS, STATE_META, useRunsData, type Artifact, type Run } from "./../data/runs";

const ART_ICON: Record<Artifact["kind"], string> = { model: "box", dataset: "database", plot: "image", file: "file" };

// A slightly richer artifact set for the Experiments surface.
const EXP_ARTIFACTS: (Artifact & { path: string })[] = [
  { name: "best_model.pt", size: "142 MB", kind: "model", action: "download", path: "model/weights" },
  { name: "train_logs.csv", size: "8 MB", kind: "dataset", action: "open", path: "metrics/logs" },
  { name: "config.yaml", size: "2 KB", kind: "file", action: "open", path: "config" },
  { name: "predictions.json", size: "12 MB", kind: "dataset", action: "open", path: "outputs/preds" },
  { name: "grad_hist.pt", size: "89 MB", kind: "model", action: "download", path: "diagnostics" },
];

const FILES_TOUCHED = [
  { path: "train.py", add: 12, del: 3 },
  { path: "model.py", add: 1, del: 1 },
  { path: "configs/lr.yaml", add: 8, del: 0 },
];

function Card({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-outline-variant bg-surface-container-low">
      <div className="flex items-center justify-between border-b border-outline-variant px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="h-3 w-1 rounded-full bg-primary" />
          <span className="label-caps text-on-surface-variant">{title}</span>
        </div>
        {right}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function ExperimentsTab({ runId }: { runId: string }) {
  const runs = useRunsData();
  const run = runs.find((r) => r.id === runId) ?? runs[0];
  const meta = STATE_META[run.state];
  const [compare, setCompare] = useState("");
  const [chartMode, setChartMode] = useState(false);
  const [cfgQuery, setCfgQuery] = useState("");
  const others = runs.filter((r) => r.id !== run.id);
  const cmpRun = others.find((r) => r.id === compare);

  const configRows = Object.entries(run.config).filter(([k]) => k.toLowerCase().includes(cfgQuery.toLowerCase()));

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-surface">
      {/* Left: scrollable card stack */}
      <div className="min-w-0 flex-1 overflow-y-auto p-4" style={{ flexBasis: "65%" }}>
        {/* Run strip */}
        <div className="mb-3 flex flex-wrap gap-2">
          <RunPill run={run} selected />
          {cmpRun && <RunPill run={cmpRun} />}
        </div>

        {cmpRun ? (
          <ComparePane run={run} other={cmpRun} />
        ) : (
          <div className="flex flex-col gap-3">
            {/* Artifacts */}
            <Card title="Artifacts">
              <div className="flex flex-col">
                {EXP_ARTIFACTS.map((a) => (
                  <div key={a.name} className="flex h-9 items-center gap-3 rounded px-1 hover:bg-surface-container">
                    <Icon name={ART_ICON[a.kind]} size={15} className="text-secondary" />
                    <span className="flex-1 truncate font-body text-[13px] text-on-surface">{a.name}</span>
                    <span className="w-20 shrink-0 font-sans text-[12px] tabular-nums text-outline">{a.size}</span>
                    <span className="hidden w-28 shrink-0 truncate font-sans text-[12px] text-on-surface-variant sm:block">{a.path}</span>
                    <button className="text-outline hover:text-primary" aria-label={a.action}>
                      <Icon name={a.action === "download" ? "download" : "external-link"} size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </Card>

            {/* Config */}
            <Card title="Config">
              <div className="mb-2 flex h-8 items-center gap-2 rounded border border-outline-variant bg-surface px-2 focus-within:border-primary">
                <Icon name="search" size={13} className="text-outline" />
                <input
                  value={cfgQuery}
                  onChange={(e) => setCfgQuery(e.target.value)}
                  placeholder="Search config…"
                  className="w-full bg-transparent font-sans text-[13px] text-on-surface placeholder:text-outline focus:outline-none"
                />
              </div>
              <div className="flex flex-col">
                {configRows.map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between border-b border-outline-variant/40 py-1.5 font-sans text-[13px] last:border-b-0">
                    <span className="text-on-surface-variant">{k}</span>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums text-primary">{String(v)}</span>
                      <span className="rounded bg-tertiary/10 px-1.5 py-0.5 font-sans text-[10px] text-tertiary">edited</span>
                    </span>
                  </div>
                ))}
                {!configRows.length && <p className="py-2 font-body text-[12px] text-outline">No matching keys.</p>}
              </div>
            </Card>

            {/* Metrics */}
            <Card
              title="Metrics"
              right={
                <button onClick={() => setChartMode((v) => !v)} className="font-sans text-[11px] text-outline hover:text-on-surface">
                  {chartMode ? "sparklines" : "curves"}
                </button>
              }
            >
              {chartMode ? (
                <Chart data={run.metrics[1].series} totalSteps={run.totalSteps} tone="positive" height={200} ariaLabel="metric curves" />
              ) : (
                <div className="flex flex-col gap-1">
                  {run.metrics.map((m) => {
                    const warn = m.key === "val_loss" && run.state !== "finished";
                    return (
                      <div key={m.key} className="flex items-center gap-3 py-1">
                        <span className="w-24 shrink-0 font-sans text-[12px] text-on-surface-variant">{m.label}</span>
                        <div className="min-w-0 flex-1">
                          <Sparkline data={m.series} width={160} height={16} tone={m.lowerIsBetter ? "positive" : "positive"} responsive ariaLabel={`${m.label} trend`} />
                        </div>
                        <span className="flex w-24 shrink-0 items-center justify-end gap-1 font-sans text-[12px] tabular-nums text-on-surface">
                          {fmtValue(m.value)} {warn && <Icon name="alert-triangle" size={12} className="text-tertiary" />}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="mt-3 flex flex-col gap-1.5 rounded border border-tertiary/25 bg-tertiary/5 p-2">
                <span className="flex items-center gap-2 font-body text-[12px] text-tertiary">
                  <Icon name="alert-triangle" size={12} /> val/loss diverged at step 4,800
                </span>
                <span className="flex items-center gap-2 font-body text-[12px] text-tertiary">
                  <Icon name="alert-triangle" size={12} /> val/acc dropped 0.04 vs best
                </span>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <span className="font-sans text-[12px] text-on-surface-variant">↗ Compare with</span>
                <Select
                  value={compare}
                  onChange={setCompare}
                  className="w-40"
                  options={[{ value: "", label: "None" }, ...others.map((r) => ({ value: r.id, label: r.shortHash }))]}
                />
              </div>
            </Card>

            {/* Provenance */}
            <Card title="Provenance">
              <div className="flex flex-col gap-1.5 font-sans text-[13px]">
                <ProvRow k="commit" v={`${run.commit}  HEAD`} />
                <ProvRow k="branch" v="feature/lr-sweep" />
                <ProvRow k="author" v="Jane D. <jane@…>" />
                <ProvRow k="started" v={run.createdLabel} />
                <ProvRow k="duration" v={run.duration} />
              </div>
              <div className="mt-3 label-caps text-outline">Files touched ({FILES_TOUCHED.length})</div>
              <div className="mt-1 flex flex-col">
                {FILES_TOUCHED.map((f) => (
                  <div key={f.path} className="flex items-center gap-3 py-1.5 font-sans text-[13px]">
                    <span className="flex-1 truncate text-on-surface">{f.path}</span>
                    <span className="tabular-nums text-primary">+{f.add}</span>
                    <span className="tabular-nums text-error">−{f.del}</span>
                    <button className="flex items-center gap-1 text-outline hover:text-primary">
                      <Icon name="external-link" size={12} /> Open diff
                    </button>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}
      </div>

      {/* Right: sticky sidebar */}
      <aside className="hidden w-[300px] shrink-0 overflow-y-auto border-l border-outline-variant bg-surface-container-low p-4 lg:block">
        <div className="label-caps text-outline">Current run</div>
        <div className="mt-1 font-sans text-[15px] font-medium text-on-surface">{run.commit}</div>
        <div className="mt-1 flex items-center gap-2 font-body text-[13px] text-on-surface-variant">
          <StatusDot token={meta.token} pulse={meta.pulse} /> {meta.label}
        </div>

        <div className="mt-5 label-caps text-outline">Quick stats</div>
        <div className="mt-1 flex flex-col gap-1 font-sans text-[13px]">
          <StatRow k="Loss" v={fmtValue(run.metrics[0].value)} />
          <StatRow k="LR" v={fmtValue(run.metrics.find((m) => m.key === "lr")?.value ?? 0)} />
          <StatRow k="Step" v={run.step.toLocaleString()} />
          <StatRow k="Time" v={run.duration} />
        </div>

        <div className="mt-5 label-caps text-outline">Artifacts ({EXP_ARTIFACTS.length})</div>
        <div className="mt-1 flex flex-col">
          {EXP_ARTIFACTS.slice(0, 3).map((a) => (
            <button key={a.name} className="flex h-7 items-center gap-2 rounded px-1 text-left hover:bg-surface-container">
              <Icon name="chevron-right" size={12} className="text-outline" />
              <span className="flex-1 truncate font-sans text-[13px] text-on-surface-variant">{a.name}</span>
            </button>
          ))}
        </div>

        <div className="mt-5 label-caps text-outline">Diff vs {others[0]?.shortHash}</div>
        <button className="mt-1 flex items-center gap-1.5 font-sans text-[13px] text-primary hover:brightness-110" onClick={() => setCompare(others[0]?.id ?? "")}>
          <Icon name="chevron-right" size={12} /> Show diff
        </button>

        <button className="mt-5 flex h-8 w-full items-center justify-center gap-2 rounded border border-outline-variant font-sans text-[12px] text-secondary hover:bg-surface-container">
          <span className="text-outline">⌘E</span> Open in Inspector
        </button>
      </aside>
    </div>
  );
}

function RunPill({ run, selected }: { run: Run; selected?: boolean }) {
  const meta = STATE_META[run.state];
  const vl = run.metrics.find((m) => m.key === "val_loss")!;
  return (
    <div className={`flex flex-col gap-0.5 rounded-lg border px-3 py-2 ${selected ? "border-primary/50 bg-primary/5" : "border-outline-variant bg-surface-container-low"}`}>
      <div className="flex items-center gap-2">
        <span className="label-caps text-outline">Run</span>
        <span className="font-sans text-[13px] text-on-surface">{run.commit}</span>
        {selected && <span className="font-sans text-[11px] text-primary">selected</span>}
      </div>
      <div className="flex items-center gap-2 font-sans text-[12px] text-on-surface-variant">
        <StatusDot token={meta.token} pulse={meta.pulse} size={7} /> val_loss {vl.value.toFixed(2)} · {run.createdLabel}
      </div>
    </div>
  );
}

function ComparePane({ run, other }: { run: Run; other: Run }) {
  const changed = Object.entries(run.config).filter(([k, v]) => String(other.config[k]) !== String(v));
  return (
    <div className="flex flex-col gap-3">
      <Card title="Config diff">
        <div className="flex flex-col">
          {changed.map(([k, v]) => (
            <div key={k} className="flex items-center gap-2 border-b border-outline-variant/40 py-1.5 font-sans text-[13px] last:border-b-0">
              <span className="flex-1 text-on-surface-variant">{k}</span>
              <span className="tabular-nums text-error">{String(v)}</span>
              <Icon name="chevron-right" size={12} className="text-outline" />
              <span className="tabular-nums text-primary">{String(other.config[k])}</span>
            </div>
          ))}
          {!changed.length && <p className="py-2 font-body text-[12px] text-outline">All parameters identical.</p>}
        </div>
      </Card>
      <Card title={`Metrics overlaid — ${run.commit} vs ${other.commit}`}>
        <Chart data={run.metrics[1].series} totalSteps={run.totalSteps} tone="positive" height={200} ariaLabel="overlaid metrics" />
        <div className="mt-2 flex items-center gap-4 font-sans text-[12px]">
          <span className="flex items-center gap-1.5 text-on-surface-variant"><span className="h-1 w-4 rounded bg-primary" /> {run.commit} {run.metrics[1].value.toFixed(2)}</span>
          <span className="flex items-center gap-1.5 text-on-surface-variant"><span className="h-1 w-4 rounded bg-outline" /> {other.commit} {other.metrics[1].value.toFixed(2)}</span>
        </div>
      </Card>
    </div>
  );
}

function ProvRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-on-surface-variant">{k}</span>
      <span className="tabular-nums text-on-surface">{v}</span>
    </div>
  );
}

function StatRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-on-surface-variant">{k}</span>
      <span className="tabular-nums text-on-surface">{v}</span>
    </div>
  );
}
