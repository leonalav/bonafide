import { useState } from "react";
import { Icon } from "../ui/Icon";

type ModeId = "debug" | "scaffold" | "plan" | "research" | "multitask";

const MODES: { id: ModeId; icon: string; label: string; status?: "deferred" | "design" }[] = [
  { id: "debug", icon: "search", label: "Debug" },
  { id: "scaffold", icon: "box", label: "Scaffold" },
  { id: "plan", icon: "line-chart", label: "Plan", status: "deferred" },
  { id: "research", icon: "package", label: "Research", status: "deferred" },
  { id: "multitask", icon: "layers", label: "Multitask", status: "design" },
];

const HINTS: Record<ModeId, string> = {
  debug: "▸ investigating… Type a follow-up.",
  scaffold: "▸ scaffolding… Describe what to build.",
  plan: "▸ planning… (this role ships in v1.1)",
  research: "▸ researching… (this role ships in v1.1)",
  multitask: "▸ multitask… (in design)",
};

type ModelId = "fable" | "sonnet" | "haiku";
const MODELS: { id: ModelId; name: string; ctx: string; cost: string }[] = [
  { id: "fable", name: "Claude Fable 5.1", ctx: "1M Max", cost: "$0.012/turn" },
  { id: "sonnet", name: "Claude Sonnet 5.1", ctx: "200k", cost: "$0.004/turn" },
  { id: "haiku", name: "Claude Haiku 5.1", ctx: "200k", cost: "$0.001/turn" },
];

function Backdrop({ onClose }: { onClose: () => void }) {
  return <div className="fixed inset-0 z-40" onMouseDown={onClose} />;
}

export function Composer({ onSubmit }: { onSubmit?: (text: string) => void }) {
  const [mode, setMode] = useState<ModeId>("debug");
  const [model, setModel] = useState<ModelId>("fable");
  const [loop, setLoop] = useState(true);
  const [text, setText] = useState("");
  const [menu, setMenu] = useState<"mode" | "model" | null>(null);
  const [customOpen, setCustomOpen] = useState(false);

  const activeMode = MODES.find((m) => m.id === mode)!;
  const activeModel = MODELS.find((m) => m.id === model)!;

  function submit() {
    if (!text.trim()) return;
    onSubmit?.(text);
    setText("");
  }

  return (
    <div className="overflow-hidden rounded-xl border border-outline-variant bg-surface-container-low focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25">
      {/* Control row */}
      <div className="flex h-9 items-center gap-2 px-2">
        {/* Mode picker */}
        <div className="relative">
          <button
            onClick={() => setMenu(menu === "mode" ? null : "mode")}
            className="flex h-6 items-center gap-1.5 rounded border border-outline-variant px-2 font-sans text-[12px] text-on-surface hover:bg-surface-container"
          >
            <Icon name={activeMode.icon} size={13} className="text-on-surface-variant" />
            {activeMode.label}
            <Icon name="chevron-down" size={11} className="text-outline" />
          </button>
          {menu === "mode" && (
            <>
              <Backdrop onClose={() => setMenu(null)} />
              <div className="absolute bottom-8 left-0 z-50 w-[280px] rounded-lg border border-outline-variant bg-surface-container p-2 shadow-xl">
                <div className="label-caps px-1.5 py-1 text-outline">Active</div>
                {MODES.filter((m) => !m.status).map((m) => (
                  <ModeRow key={m.id} m={m} active={mode === m.id} onClick={() => { setMode(m.id); setMenu(null); }} />
                ))}
                <div className="label-caps px-1.5 pb-1 pt-2 text-outline">Coming in v1.1</div>
                {MODES.filter((m) => m.status === "deferred").map((m) => (
                  <ModeRow key={m.id} m={m} active={false} onClick={() => { setMode(m.id); setMenu(null); }} />
                ))}
                <div className="my-1 h-px bg-outline-variant/50" />
                {MODES.filter((m) => m.status === "design").map((m) => (
                  <ModeRow key={m.id} m={m} active={false} onClick={() => setMenu(null)} />
                ))}
              </div>
            </>
          )}
        </div>

        {/* Model picker */}
        <div className="relative min-w-0">
          <button
            onClick={() => setMenu(menu === "model" ? null : "model")}
            className="flex h-6 min-w-0 items-center gap-1.5 rounded px-1 font-sans text-[12px] text-on-surface-variant hover:text-on-surface"
          >
            <span className="truncate">{activeModel.name}</span>
            <span className="shrink-0 text-outline">· {activeModel.ctx}</span>
            <Icon name="chevron-down" size={11} className="shrink-0 text-outline" />
          </button>
          {menu === "model" && (
            <>
              <Backdrop onClose={() => { setMenu(null); setCustomOpen(false); }} />
              <div className="absolute bottom-8 left-0 z-50 w-[320px] rounded-lg border border-outline-variant bg-surface-container p-2 shadow-xl">
                <div className="label-caps px-1.5 py-1 text-outline">Current</div>
                {MODELS.map((m) => {
                  const on = model === m.id;
                  return (
                    <button
                      key={m.id}
                      onClick={() => { setModel(m.id); setMenu(null); }}
                      className={`relative flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-container-high ${on ? "bg-surface-container-high" : ""}`}
                    >
                      {on && <span className="absolute left-0 top-0 h-full w-[3px] rounded-full bg-primary" />}
                      <Icon name={on ? "check" : "circle"} size={13} className={on ? "text-primary" : "text-outline"} />
                      <span className="flex-1 font-body text-[13px] text-on-surface">{m.name}</span>
                      <span className="font-sans text-[11px] text-outline">{m.ctx} · {m.cost}</span>
                    </button>
                  );
                })}
                <div className="my-1 h-px bg-outline-variant/50" />
                <button onClick={() => setCustomOpen((v) => !v)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-body text-[13px] text-primary hover:bg-surface-container-high">
                  <Icon name="plus" size={13} /> Add custom model endpoint
                </button>
                {customOpen && (
                  <div className="flex flex-col gap-1.5 px-2 pb-1 pt-1.5">
                    <input placeholder="Base URL (OpenAI-compatible)" className="h-7 rounded border border-outline-variant bg-surface px-2 font-sans text-[12px] text-on-surface placeholder:text-outline focus:border-primary focus:outline-none" />
                    <input placeholder="API key" type="password" className="h-7 rounded border border-outline-variant bg-surface px-2 font-sans text-[12px] text-on-surface placeholder:text-outline focus:border-primary focus:outline-none" />
                  </div>
                )}
                <p className="flex gap-1.5 px-2 pb-1 pt-1.5 font-body text-[11px] text-outline">
                  <span>ⓘ</span> Model selection affects reasoning depth and tool-use fidelity. Default model recommended.
                </p>
              </div>
            </>
          )}
        </div>

        <div className="flex-1" />

        {/* Loop / attach / send */}
        <button
          onClick={() => setLoop((v) => !v)}
          title={loop ? "Auto-continue: on" : "Auto-continue: off"}
          aria-pressed={loop}
          className={`flex h-6 w-6 items-center justify-center rounded hover:bg-surface-container ${loop ? "text-primary" : "text-on-surface-variant"}`}
        >
          <Icon name="refresh" size={14} />
        </button>
        <button title="Attach context" className="flex h-6 w-6 items-center justify-center rounded text-on-surface-variant hover:bg-surface-container hover:text-on-surface">
          <Icon name="paperclip" size={14} />
        </button>
        <button
          onClick={submit}
          disabled={!text.trim()}
          aria-label="Send"
          className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-on-primary transition-opacity disabled:opacity-40"
        >
          <Icon name="send" size={13} />
        </button>
      </div>

      {/* Input row */}
      <div className="border-t border-outline-variant bg-surface-container">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          placeholder={text ? "" : HINTS[mode]}
          className="max-h-[200px] w-full resize-none bg-transparent px-3 py-2 font-body text-[13px] leading-[19px] text-on-surface placeholder:text-outline focus:outline-none"
        />
      </div>
    </div>
  );
}

function ModeRow({ m, active, onClick }: { m: (typeof MODES)[number]; active: boolean; onClick: () => void }) {
  const muted = m.status === "deferred";
  return (
    <button
      onClick={onClick}
      title={muted ? "This role ships in v1.1. The thread is created but won't receive replies yet." : undefined}
      className={`relative flex h-9 w-full items-center gap-2 rounded px-2 text-left hover:bg-surface-container-high ${active ? "bg-surface-container-high" : ""} ${muted ? "opacity-50" : ""}`}
    >
      {active && <span className="absolute left-0 top-0 h-full w-[3px] rounded-full bg-primary" />}
      <span className="flex w-6 justify-center">
        <Icon name={m.icon} size={16} className="text-on-surface-variant" />
      </span>
      <span className="flex-1 font-body text-[13px] font-medium text-on-surface">{m.label}</span>
      {active && <Icon name="check" size={14} className="text-primary" />}
      {m.status === "deferred" && <span className="text-[11px] text-outline">ⓘ</span>}
      {m.status === "design" && (
        <span className="flex items-center gap-1 rounded bg-outline/15 px-1.5 py-0.5 font-sans text-[10px] text-outline">
          <Icon name="lock" size={9} /> in design
        </span>
      )}
    </button>
  );
}

export function QuickSuggestions({ items, onPick }: { items: string[]; onPick: (t: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="label-caps text-on-surface-variant">Quick suggestions</span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="h-7 rounded bg-surface-container-high px-3 font-sans text-[12px] text-on-surface transition-colors hover:bg-surface-container-highest"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
