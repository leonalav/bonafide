import { useState, useRef, useCallback } from "react";
import { Icon } from "../ui/Icon";

type DebugEntry = {
  id: string;
  ts: Date;
  kind: "input" | "output" | "error" | "system";
  text: string;
};

export function PanelDebugConsoleTab() {
  const [entries, setEntries] = useState<DebugEntry[]>([]);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useState(() => {
    // Auto-scroll when entries change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    if (entries.length > 0) scrollToBottom();
  });

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const cmd = input.trim();
      if (!cmd) return;

      const id = `dce_${Date.now()}`;
      setEntries((prev) => [
        ...prev,
        { id: `${id}_in`, ts: new Date(), kind: "input", text: cmd },
      ]);
      setInput("");

      // TODO: Wire up DAP (Debug Adapter Protocol) client.
      // For now, echo a stub response.
      setTimeout(() => {
        setEntries((prev) => [
          ...prev,
          {
            id: `${id}_out`,
            ts: new Date(),
            kind: "system",
            text: `[debugpy not connected] Start a debug session to use the Debug Console.`,
          },
        ]);
      }, 200);
    },
    [input, scrollToBottom],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Entry list */}
      <div className="min-h-0 flex-1 overflow-y-auto font-mono text-[12px]">
        {entries.length === 0 ? (
          <div className="flex h-full items-center justify-center font-sans text-[13px] text-outline">
            <div className="text-center">
              <Icon name="bug" size={24} className="mx-auto mb-2" />
              <p>Debug Console</p>
              <p className="mt-1 text-[12px]">
                Start a debug session to evaluate expressions and inspect variables.
              </p>
            </div>
          </div>
        ) : (
          entries.map((e) => (
            <div
              key={e.id}
              className={`flex gap-2 px-3 py-0.5 ${
                e.kind === "input"
                  ? "text-green-400"
                  : e.kind === "error"
                    ? "text-red-400"
                    : e.kind === "system"
                      ? "text-outline"
                      : "text-on-surface-variant"
              }`}
            >
              <span className="shrink-0 text-outline-variant">
                {e.ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
              {e.kind === "input" ? (
                <span>&gt; {e.text}</span>
              ) : (
                <span className="whitespace-pre-wrap">{e.text}</span>
              )}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <form
        onSubmit={handleSubmit}
        className="flex shrink-0 items-center gap-2 border-t border-outline-variant/40 bg-surface-container-low px-3 py-2"
      >
        <span className="shrink-0 font-mono text-[12px] text-green-400">&gt;</span>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Evaluate expression…"
          className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-on-surface outline-none placeholder:text-outline"
        />
        <button
          type="submit"
          className="flex h-6 w-6 items-center justify-center rounded text-on-surface-variant hover:bg-surface-container-high"
          aria-label="Send"
        >
          <Icon name="send" size={13} />
        </button>
      </form>
    </div>
  );
}
