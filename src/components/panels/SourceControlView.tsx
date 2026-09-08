import { useState } from "react";
import { Icon } from "../ui/Icon";
import { Button, Chip } from "../ui/primitives";
import { PanelHeader } from "./shared";
import { GIT_STATE, type FileChange } from "../../data/runs";

function RunChip({ change }: { change: FileChange }) {
  if (change.runs == null) return <span className="font-sans text-[11px] text-outline">—</span>;
  const label = `${change.runs} run${change.runs === 1 ? "" : "s"}`;
  if (change.best == null) return <span className="font-sans text-[11px] text-outline">{label}</span>;
  return (
    <Chip tone={change.tone}>
      {label} · best {change.best.toFixed(2)}
    </Chip>
  );
}

const STATUS_COLOR: Record<FileChange["status"], string> = {
  M: "text-tertiary",
  U: "text-primary",
  A: "text-primary",
  D: "text-error",
};

function ChangeGroup({ label, files, onSelect, selected }: { label: string; files: FileChange[]; onSelect: (p: string) => void; selected: string }) {
  if (!files.length) return null;
  return (
    <div>
      <div className="flex items-center gap-1 px-2 py-1 font-sans text-[12px] text-outline">
        <Icon name="chevron-down" size={12} /> {label} ({files.length})
      </div>
      {files.map((f) => (
        <button
          key={f.path}
          onClick={() => onSelect(f.path)}
          className={`relative flex h-7 w-full items-center gap-2 pl-4 pr-2 transition-colors ${
            selected === f.path ? "bg-surface-container-high" : "hover:bg-surface-container"
          }`}
        >
          {selected === f.path && <span className="absolute left-0 top-0 h-full w-0.5 bg-primary" />}
          <span className={`font-sans text-[12px] font-semibold ${STATUS_COLOR[f.status]}`}>{f.status}</span>
          <span className="flex-1 truncate text-left font-sans text-[13px] text-on-surface">{f.path}</span>
          <RunChip change={f} />
        </button>
      ))}
    </div>
  );
}

export function SourceControlView() {
  const [tab, setTab] = useState<"changes" | "stashes">("changes");
  const [selected, setSelected] = useState("src/train.py");
  const [showCommits, setShowCommits] = useState(false);
  const g = GIT_STATE;

  return (
    <>
      <PanelHeader
        title="Source Control"
        right={<Icon name="more-horizontal" size={14} className="hover:text-on-surface" />}
      />

      {/* ML overlay #2: branch leaderboard strip */}
      <div className="flex flex-col gap-0.5 border-b border-outline-variant bg-surface-container/40 px-3 py-1.5">
        <div className="flex items-center gap-1.5 font-sans text-[12px] text-on-surface-variant">
          <Icon name="git-branch" size={12} className="text-primary" />
          <span className="text-on-surface">{g.branch}</span>
          <span className="text-outline">best run</span>
          <span className="text-primary/90">{g.bestRun.shortHash}</span>
          <span className="tabular-nums text-on-surface">{g.bestRun.valLoss.toFixed(2)}</span>
        </div>
        <button className="flex items-center gap-1 font-sans text-[11px] text-primary hover:brightness-110">
          + Compare branches <Icon name="external-link" size={11} />
        </button>
      </div>

      {/* branch + sync bar */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-outline-variant px-3">
        <button onClick={() => setShowCommits((v) => !v)} className="flex items-center gap-2 font-sans text-[13px] text-on-surface hover:text-primary">
          <Icon name="git-branch" size={13} /> {g.branch}
          <span className="font-sans text-[12px] text-outline">↑ {g.ahead} ↓ {g.behind}</span>
          <Icon name={showCommits ? "chevron-up" : "chevron-down"} size={12} className="text-outline" />
        </button>
        <div className="flex items-center gap-2 text-outline">
          <Icon name="arrow-down" size={14} className="hover:text-on-surface" />
          <Icon name="arrow-up" size={14} className="hover:text-on-surface" />
          <Icon name="refresh" size={14} className="hover:text-on-surface" />
        </div>
      </div>

      {showCommits ? (
        <div className="flex-1 overflow-y-auto">
          <div className="label-caps grid grid-cols-[1fr_auto] gap-2 border-b border-outline-variant px-3 py-1.5 text-outline">
            <span>Commit · message</span>
            <span>runs · best</span>
          </div>
          {g.commits.map((c) => (
            <button key={c.hash} className="grid w-full grid-cols-[1fr_auto] items-center gap-2 border-b border-outline-variant/50 px-3 py-1.5 text-left hover:bg-surface-container">
              <span className="min-w-0">
                <span className="font-sans text-[12px] text-outline">{c.hash}</span>
                <span className="ml-2 truncate font-body text-[13px] text-on-surface">{c.message}</span>
              </span>
              {c.best == null ? (
                <span className="font-sans text-[11px] text-outline">—</span>
              ) : (
                <Chip tone={c.tone}>{c.runs} · {c.best.toFixed(2)}</Chip>
              )}
            </button>
          ))}
        </div>
      ) : (
        <>
          {/* tab strip */}
          <div className="flex h-8 shrink-0 items-stretch border-b border-outline-variant px-2">
            {(["changes", "stashes"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`relative px-2.5 font-sans text-[12px] uppercase tracking-wide transition-colors ${
                  tab === t ? "text-on-surface" : "text-on-surface-variant hover:text-on-surface"
                }`}
              >
                {t === "changes" ? `Changes (${g.changes.length + g.staged.length + g.untracked.length})` : "Stashes (0)"}
                {tab === t && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto py-1">
            {tab === "changes" ? (
              <>
                <ChangeGroup label="Staged Changes" files={g.staged} selected={selected} onSelect={setSelected} />
                <ChangeGroup label="Changes" files={g.changes} selected={selected} onSelect={setSelected} />
                <ChangeGroup label="Untracked" files={g.untracked} selected={selected} onSelect={setSelected} />
              </>
            ) : (
              <div className="p-6 text-center font-body text-[13px] text-on-surface-variant">No stashes.</div>
            )}
          </div>

          {/* commit box */}
          <div className="shrink-0 border-t border-outline-variant p-2">
            <textarea
              rows={2}
              placeholder="Message (⌘↵ to commit)"
              className="w-full resize-none rounded border border-outline-variant bg-surface px-2 py-1.5 font-body text-[13px] text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
            />
            {/* pre-commit checks */}
            <div className="mt-2 flex items-center gap-3 rounded bg-surface-container/50 px-2 py-1 font-sans text-[11px] text-on-surface-variant">
              <span className="label-caps text-outline">checks</span>
              <span className="flex items-center gap-1">lint <Icon name="check" size={11} className="text-primary" /></span>
              <span className="flex items-center gap-1">tests <Icon name="check" size={11} className="text-primary" /></span>
              <span className="ml-auto text-outline">passing</span>
            </div>
            <div className="mt-2 flex flex-col gap-1.5">
              <Button size="sm" className="w-full">
                <Icon name="arrow-up" size={13} /> Commit &amp; Sync
              </Button>
              <Button variant="secondary" size="sm" className="w-full">Commit</Button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
