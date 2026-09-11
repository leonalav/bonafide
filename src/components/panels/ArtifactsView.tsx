import { useEffect, useState } from "react"
import { Icon } from "../ui/Icon"
import { PanelHeader, PanelSearch } from "./shared"
import { Select } from "../ui/Select"
import { ARTIFACT_KIND_META, type WorkspaceArtifact } from "../../data/runs"

type WorkspaceArtifacts = {
  totalCount: number
  totalSize: string
  fromRuns: WorkspaceArtifact[]
  local: WorkspaceArtifact[]
}

function ArtifactRow({ a }: { a: WorkspaceArtifact }) {
  const meta = ARTIFACT_KIND_META[a.kind]
  return (
    <div className="group flex h-8 items-center gap-2 px-2 hover:bg-surface-container">
      <Icon name={meta.icon} size={15} className={meta.className} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-sans text-[13px] text-on-surface">
          {a.name}
        </span>
      </span>
      {a.run && (
        <span className="hidden shrink-0 font-sans text-[11px] text-on-surface-variant xl:inline">
          {a.run}
        </span>
      )}
      <span className="w-16 shrink-0 text-right font-sans text-[11px] tabular-nums text-outline">
        {a.size}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-outline opacity-0 transition-opacity group-hover:opacity-100">
        <button aria-label={a.action} className="hover:text-primary">
          <Icon
            name={a.action === "download" ? "download" : "external-link"}
            size={13}
          />
        </button>
        <button aria-label="more" className="hover:text-on-surface">
          <Icon name="more-horizontal" size={13} />
        </button>
      </span>
    </div>
  )
}

function Group({
  label,
  items,
}: {
  label: string
  items: WorkspaceArtifact[]
}) {
  return (
    <div>
      <div className="flex items-center gap-1 px-2 py-1 font-sans text-[12px] text-outline">
        <Icon name="chevron-down" size={12} /> {label} ({items.length})
      </div>
      {items.map((a, i) => (
        <ArtifactRow key={`${a.name}-${a.run}-${i}`} a={a} />
      ))}
    </div>
  )
}

const TYPE_OPTIONS = [
  { value: "all", label: "all" },
  { value: "model", label: "models" },
  { value: "dataset", label: "datasets" },
  { value: "plot", label: "plots" },
  { value: "config", label: "configs" },
  { value: "tensor", label: "tensors" },
]

export function ArtifactsView() {
  // P0-T8: artifacts are loaded from IPC; until the backend lands, the
  // call returns `null` and the panel renders an honest empty state.
  const [artifacts, setArtifacts] = useState<WorkspaceArtifacts | null>(null)

  // `projectName` is the current tracker project (W&B project /
  // MLflow experiment). Since the renderer doesn't yet read the
  // user's tracked project from settings, fall back to the default;
  // the backend uses this as a hint for `listArtifacts`.
  const projectName = "bonafide-train"

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const rows: WorkspaceArtifacts = {
          totalCount: 0,
          totalSize: "0 B",
          fromRuns: [],
          local: [],
        }
        if (!cancelled) setArtifacts(rows)
      } catch {
        if (!cancelled) setArtifacts(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectName])

  const [type, setType] = useState("all")
  const [run, setRun] = useState("all")
  const [sort, setSort] = useState("size")

  const fromRuns = artifacts?.fromRuns ?? []
  const local = artifacts?.local ?? []

  const runOptions = [
    { value: "all", label: "all" },
    ...Array.from(
      new Set(fromRuns.map((a) => a.run).filter(Boolean) as string[]),
    ).map((r) => ({ value: r, label: r })),
  ]

  const match = (a: WorkspaceArtifact) =>
    (type === "all" || a.kind === type) && (run === "all" || a.run === run)
  const filteredFromRuns = fromRuns.filter(match)
  const filteredLocal = local.filter(match)

  const activeFilters = [
    type !== "all" && {
      key: "type",
      label: `Type: ${type}`,
      clear: () => setType("all"),
    },
    run !== "all" && {
      key: "run",
      label: `Run: ${run}`,
      clear: () => setRun("all"),
    },
  ].filter(Boolean) as { key: string; label: string; clear: () => void }[]

  const totalCount = artifacts?.totalCount ?? 0
  const totalSize = artifacts?.totalSize ?? "0 B"

  return (
    <>
      <PanelHeader
        title="Artifacts"
        right={
          <span className="font-sans text-[11px] normal-case text-outline">
            {totalCount} items · {totalSize}
          </span>
        }
      />
      <div className="flex flex-col gap-2 border-b border-outline-variant p-2">
        <PanelSearch placeholder="Search by name, run, type..." />
        <div className="flex flex-wrap items-center gap-1.5">
          <Select
            prefix="Type:"
            value={type}
            onChange={setType}
            options={TYPE_OPTIONS}
          />
          <Select
            prefix="Run:"
            value={run}
            onChange={setRun}
            options={runOptions}
          />
          <Select
            value={sort}
            onChange={setSort}
            options={[
              { value: "size", label: "Size" },
              { value: "date", label: "Date" },
              { value: "name", label: "Name" },
            ]}
          />
          <button className="flex h-6 items-center gap-1 rounded border border-outline-variant px-2 font-sans text-[12px] text-on-surface-variant hover:text-on-surface">
            <Icon name="square" size={11} /> Grid
          </button>
        </div>
        {activeFilters.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {activeFilters.map((f) => (
              <span
                key={f.key}
                className="flex items-center gap-1 rounded bg-surface-container px-1.5 py-0.5 font-sans text-[11px] text-on-surface-variant"
              >
                {f.label}
                <button
                  onClick={f.clear}
                  className="hover:text-error"
                  aria-label={`clear ${f.key} filter`}
                >
                  <Icon name="x" size={10} />
                </button>
              </span>
            ))}
            <button
              onClick={() => {
                setType("all")
                setRun("all")
              }}
              className="font-sans text-[11px] text-outline hover:text-on-surface"
            >
              Clear all
            </button>
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {totalCount === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-10 text-center">
            <Icon
              name="package"
              size={28}
              className="text-outline-variant"
            />
            <p className="font-body text-[13px] text-on-surface-variant">
              No artifacts yet. Run a training script and log files with W&amp;B
              or MLflow to see them here.
            </p>
          </div>
        ) : (
          <>
            {filteredFromRuns.length > 0 && (
              <Group label="From runs" items={filteredFromRuns} />
            )}
            {filteredLocal.length > 0 && (
              <Group label="Local" items={filteredLocal} />
            )}
            {filteredFromRuns.length === 0 && filteredLocal.length === 0 && (
              <div className="p-6 text-center font-body text-[13px] text-on-surface-variant">
                No artifacts match these filters.
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
