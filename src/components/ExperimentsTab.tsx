import { useEffect, useState } from "react"
import { Icon } from "./ui/Icon"
import { StatusDot } from "./ui/primitives"
import { Sparkline } from "./ui/Sparkline"
import {
  STATE_META,
  useRunsData,
  useRunsStatus,
  type Run,
} from "./../data/runs"

type FileChange = { path: string add: number del: number }
type ArtifactRow = { name: string size: string path?: string }
type Diagnostic = { id: string text: string }

function Card({
  title,
  children,
  right,
}: {
  title: string
  children: React.ReactNode
  right?: React.ReactNode
}) {
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
  )
}

export function ExperimentsTab({ runId }: { runId: string }) {
  const runs = useRunsData()
  const { noTrackerConnected, loading, error } = useRunsStatus()
  const run = runs.find((r) => r.id === runId) ?? runs[0]

  if (noTrackerConnected) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <Icon name="zap" size={32} className="mx-auto mb-3 text-outline" />
          <div className="font-body text-[14px] text-on-surface">
            Connect a tracker to see live runs
          </div>
          <div className="mt-1 font-body text-[12px] text-on-surface-variant">
            Open Preferences → Account to connect W&amp;B or MLflow.
          </div>
        </div>
      </div>
    )
  }

  if (!run) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <Icon name="flask" size={28} className="mx-auto mb-3 text-outline" />
          <div className="font-body text-[14px] text-on-surface">
            No run selected
          </div>
          <div className="mt-1 font-body text-[12px] text-on-surface-variant">
            Pick a run from the timeline to view its artifacts, config,
            metrics, and provenance.
          </div>
        </div>
      </div>
    )
  }

  if (loading) return <div>Loading…</div>
  if (error) return <div>Error: {error}</div>
  const meta = STATE_META[run.state]
  const [compare, setCompare] = useState("")
  const [cfgQuery, setCfgQuery] = useState("")

  // P0-T7: artifacts come from the real tracker, not from EXP_ARTIFACTS.
  const [artifacts, setArtifacts] = useState<ArtifactRow[]>([])
  const [filesTouched, setFilesTouched] = useState<FileChange[]>([])

  // Workspace root isn't passed in directly; surface diagnostics as
  // an empty array for now until a workspace-level diagnostics feed
  // exists (P0-T10 lands it). Show the empty UI rather than fake data.
  const [diagnostics] = useState<Diagnostic[]>([])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // The renderer's `run` shape doesn't carry a real tracker id
        // yet — until the backend exposes per-run commits, this returns
        // an empty list and the empty state shows. Wiring up real
        // tracker calls lands with the Phase 0.5 IPC pass.
        const rows: ArtifactRow[] = []
        if (!cancelled) setArtifacts(rows)
      } catch {
        if (!cancelled) setArtifacts([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [run?.id])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const rows: FileChange[] = []
        if (!cancelled) setFilesTouched(rows)
      } catch {
        if (!cancelled) setFilesTouched([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [run?.id])

  const others = runs.filter((r) => r.id !== run.id)
  const cmpRun = others.find((r) => r.id === compare)

  const configRows = Object.entries(run.config).filter(([k]) =>
    k.toLowerCase().includes(cfgQuery.toLowerCase()),
  )

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-surface">
      {/* Left: scrollable card stack */}
      <div
        className="min-w-0 flex-1 overflow-y-auto p-4"
        style={{ flexBasis: "65%" }}
      >
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
              {artifacts.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-6 text-center">
                  <Icon
                    name="package"
                    size={22}
                    className="text-outline-variant"
                  />
                  <p className="font-body text-[13px] text-on-surface-variant">
                    No artifacts logged for this run yet.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col">
                  {artifacts.map((a) => (
                    <div
                      key={a.name}
                      className="flex h-9 items-center gap-3 rounded px-1 hover:bg-surface-container"
                    >
                      <Icon
                        name="file"
                        size={15}
                        className="text-secondary"
                      />
                      <span className="flex-1 truncate font-body text-[13px] text-on-surface">
                        {a.name}
                      </span>
                      <span className="w-20 shrink-0 font-sans text-[12px] tabular-nums text-outline">
                        {a.size}
                      </span>
                      {a.path ? (
                        <span className="hidden w-28 shrink-0 truncate font-sans text-[12px] text-on-surface-variant sm:block">
                          {a.path}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
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
                  <div
                    key={k}
                    className="flex items-center justify-between border-b border-outline-variant/40 py-1.5 font-sans text-[13px] last:border-b-0"
                  >
                    <span className="text-on-surface-variant">{k}</span>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums text-primary">
                        {String(v)}
                      </span>
                      <span className="rounded bg-tertiary/10 px-1.5 py-0.5 font-sans text-[10px] text-tertiary">
                        edited
                      </span>
                    </span>
                  </div>
                ))}
                {!configRows.length && (
                  <p className="py-2 font-body text-[12px] text-outline">
                    No matching keys.
                  </p>
                )}
              </div>
            </Card>

            {/* Metrics */}
            <Card title="Metrics">
              <div className="flex flex-col gap-1">
                {run.metrics.map((m) => {
                  const warn = m.key === "val_loss" && run.state !== "finished"
                  return (
                    <div key={m.key} className="flex items-center gap-3 py-1">
                      <span className="w-24 shrink-0 font-sans text-[12px] text-on-surface-variant">
                        {m.label}
                      </span>
                      <div className="min-w-0 flex-1">
                        <Sparkline
                          data={m.series}
                          width={160}
                          height={16}
                          tone={m.lowerIsBetter ? "positive" : "positive"}
                          responsive
                          ariaLabel={`${m.label} trend`}
                        />
                      </div>
                      <span className="flex w-24 shrink-0 items-center justify-end gap-1 font-sans text-[12px] tabular-nums text-on-surface">
                        {m.value.toFixed(3)}{" "}
                        {warn && (
                          <Icon
                            name="alert-triangle"
                            size={12}
                            className="text-tertiary"
                          />
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
              {diagnostics.length > 0 && (
                <div className="mt-3 flex flex-col gap-1.5 rounded border border-tertiary/25 bg-tertiary/5 p-2">
                  {diagnostics.map((d) => (
                    <span
                      key={d.id}
                      className="flex items-center gap-2 font-body text-[12px] text-tertiary"
                    >
                      <Icon name="alert-triangle" size={12} /> {d.text}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-3 flex items-center gap-2">
                <span className="font-sans text-[12px] text-on-surface-variant">
                  ↗ Compare with
                </span>
                <select
                  value={compare}
                  onChange={(e) => setCompare(e.target.value)}
                  className="h-7 rounded border border-outline-variant bg-transparent px-2 font-sans text-[12px] text-on-surface"
                >
                  <option value="">None</option>
                  {others.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.shortHash}
                    </option>
                  ))}
                </select>
              </div>
            </Card>

            {/* Provenance */}
            <Card title="Provenance">
              <div className="flex flex-col gap-1.5 font-sans text-[13px]">
                <ProvRow k="commit" v={`${run.commit}  HEAD`} />
                <ProvRow k="branch" v={run?.branch ?? "—"} />
                <ProvRow k="author" v={run?.author ?? "—"} />
                <ProvRow k="started" v={run.createdLabel} />
                <ProvRow k="duration" v={run.duration} />
              </div>
              <div className="mt-3 label-caps text-outline">
                Files touched ({filesTouched.length})
              </div>
              <div className="mt-1 flex flex-col">
                {filesTouched.length === 0 ? (
                  <p className="py-2 font-body text-[12px] text-outline">
                    No file changes detected for this run.
                  </p>
                ) : (
                  filesTouched.map((f) => (
                    <div
                      key={f.path}
                      className="flex items-center gap-3 py-1.5 font-sans text-[13px]"
                    >
                      <span className="flex-1 truncate text-on-surface">
                        {f.path}
                      </span>
                      <span className="tabular-nums text-primary">+{f.add}</span>
                      <span className="tabular-nums text-error">−{f.del}</span>
                      <button className="flex items-center gap-1 text-outline hover:text-primary">
                        <Icon name="external-link" size={12} /> Open diff
                      </button>
                    </div>
                  ))
                )}
              </div>
            </Card>
          </div>
        )}
      </div>

      {/* Right: sticky sidebar */}
      <aside className="hidden w-[300px] shrink-0 overflow-y-auto border-l border-outline-variant bg-surface-container-low p-4 lg:block">
        <div className="label-caps text-outline">Current run</div>
        <div className="mt-1 font-sans text-[15px] font-medium text-on-surface">
          {run.commit}
        </div>
        <div className="mt-1 flex items-center gap-2 font-body text-[13px] text-on-surface-variant">
          <StatusDot token={meta.token} pulse={meta.pulse} /> {meta.label}
        </div>

        <div className="mt-5 label-caps text-outline">Quick stats</div>
        <div className="mt-1 flex flex-col gap-1 font-sans text-[13px]">
          <StatRow
            k="Loss"
            v={run.metrics[0] ? run.metrics[0].value.toFixed(3) : "—"}
          />
          <StatRow
            k="LR"
            v={
              run.metrics.find((m) => m.key === "lr")?.value.toFixed(4) ?? "—"
            }
          />
          <StatRow k="Step" v={run.step.toLocaleString()} />
          <StatRow k="Time" v={run.duration} />
        </div>

        <div className="mt-5 label-caps text-outline">
          Artifacts ({artifacts.length})
        </div>
        <div className="mt-1 flex flex-col">
          {artifacts.length === 0 ? (
            <p className="py-2 font-body text-[12px] text-outline">
              No artifacts logged.
            </p>
          ) : (
            artifacts.slice(0, 3).map((a) => (
              <button
                key={a.name}
                className="flex h-7 items-center gap-2 rounded px-1 text-left hover:bg-surface-container"
              >
                <Icon
                  name="chevron-right"
                  size={12}
                  className="text-outline"
                />
                <span className="flex-1 truncate font-sans text-[13px] text-on-surface-variant">
                  {a.name}
                </span>
              </button>
            ))
          )}
        </div>

        <div className="mt-5 label-caps text-outline">
          Diff vs {others[0]?.shortHash ?? "—"}
        </div>
        {others[0] ? (
          <button
            className="mt-1 flex items-center gap-1.5 font-sans text-[13px] text-primary hover:brightness-110"
            onClick={() => setCompare(others[0].id)}
          >
            <Icon name="chevron-right" size={12} /> Show diff
          </button>
        ) : (
          <p className="mt-1 font-body text-[12px] text-outline">
            No other runs to compare.
          </p>
        )}

        <button className="mt-5 flex h-8 w-full items-center justify-center gap-2 rounded border border-outline-variant font-sans text-[12px] text-secondary hover:bg-surface-container">
          <span className="text-outline">⌘E</span> Open in Inspector
        </button>
      </aside>
    </div>
  )
}

function RunPill({ run, selected }: { run: Run selected?: boolean }) {
  const meta = STATE_META[run.state]
  const vl = run.metrics.find((m) => m.key === "val_loss")
  return (
    <div
      className={`flex flex-col gap-0.5 rounded-lg border px-3 py-2 ${
        selected
          ? "border-primary/50 bg-primary/5"
          : "border-outline-variant bg-surface-container-low"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="label-caps text-outline">Run</span>
        <span className="font-sans text-[13px] text-on-surface">
          {run.commit}
        </span>
        {selected && (
          <span className="font-sans text-[11px] text-primary">selected</span>
        )}
      </div>
      <div className="flex items-center gap-2 font-sans text-[12px] text-on-surface-variant">
        <StatusDot token={meta.token} pulse={meta.pulse} size={7} /> val_loss{" "}
        {vl ? vl.value.toFixed(2) : "—"} · {run.createdLabel}
      </div>
    </div>
  )
}

function ComparePane({ run, other }: { run: Run other: Run }) {
  const changed = Object.entries(run.config).filter(
    ([k, v]) => String(other.config[k]) !== String(v),
  )
  return (
    <div className="flex flex-col gap-3">
      <Card title="Config diff">
        <div className="flex flex-col">
          {changed.map(([k, v]) => (
            <div
              key={k}
              className="flex items-center gap-2 border-b border-outline-variant/40 py-1.5 font-sans text-[13px] last:border-b-0"
            >
              <span className="flex-1 text-on-surface-variant">{k}</span>
              <span className="tabular-nums text-error">{String(v)}</span>
              <Icon name="chevron-right" size={12} className="text-outline" />
              <span className="tabular-nums text-primary">
                {String(other.config[k])}
              </span>
            </div>
          ))}
          {!changed.length && (
            <p className="py-2 font-body text-[12px] text-outline">
              All parameters identical.
            </p>
          )}
        </div>
      </Card>
    </div>
  )
}

function ProvRow({ k, v }: { k: string v: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-on-surface-variant">{k}</span>
      <span className="tabular-nums text-on-surface">{v}</span>
    </div>
  )
}

function StatRow({ k, v }: { k: string v: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-on-surface-variant">{k}</span>
      <span className="tabular-nums text-on-surface">{v}</span>
    </div>
  )
}
