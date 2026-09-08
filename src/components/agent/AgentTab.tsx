import { useState } from "react";
import { Icon } from "../ui/Icon";
import { StatusDot } from "../ui/primitives";
import { ProposalView } from "./ProposalView";
import { Composer, QuickSuggestions } from "./Composer";
import { INVESTIGATION } from "../../data/agents";
import type { Run } from "../../data/runs";

export function AgentTab({ run, onOpenWorkflow }: { run: Run; onOpenWorkflow?: () => void }) {
  const data = { ...INVESTIGATION, runHash: run.commit };
  const [seed, setSeed] = useState(0);

  const suggestions = [
    "Compare vs b4c8f30",
    "Show metric trajectory",
    "Try smaller LR (×0.5)",
    "Explain in plain terms",
    "Open in Workflow as a thread",
  ];

  function pick(s: string) {
    if (s.startsWith("Open in Workflow")) return onOpenWorkflow?.();
    // Chip text fills the composer and submits — remount to reflect the new turn.
    setSeed((n) => n + 1);
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusDot token="tertiary" pulse />
          <span className="font-sans text-[13px] text-on-surface">
            Investigating <span className="text-primary">{run.commit}</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={onOpenWorkflow} className="flex items-center gap-1 font-sans text-[12px] text-outline hover:text-on-surface" title="Open in Workflow">
            <Icon name="arrow-right-left" size={13} /> Workflow
          </button>
          <button className="flex items-center gap-1 font-sans text-[12px] text-outline hover:text-error" title="Stop investigation">
            <Icon name="stop-circle" size={13} /> Stop
          </button>
        </div>
      </div>

      <ProposalView data={data} />

      <div className="flex flex-col gap-3 border-t border-outline-variant pt-4">
        <QuickSuggestions items={suggestions} onPick={pick} />
        <Composer key={seed} onSubmit={() => setSeed((n) => n + 1)} />
      </div>
    </div>
  );
}
