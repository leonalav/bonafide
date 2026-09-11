import { useState, useRef, useCallback } from "react"
import { Icon } from "../ui/Icon"

type DebugEntry = {
  id: string
  ts: Date
  kind: "input" | "output" | "error" | "system"
  text: string
}

export function PanelDebugConsoleTab() {
  const [entries, setEntries] = useState<DebugEntry[]>([])
  const [input, setInput] = useState("")
  const bottomRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [])

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const cmd = input.trim()
      if (!cmd) return

      const id = `dce_${Date.now()}`
      setEntries((prev) => [
        ...prev,
        { id: `${id}_in`, ts: new Date(), kind: "input", text: cmd },
      ])
      setInput("")
      // P0-T10: the 200ms `[debugpy not connected]` echo is gone.
      // Real output will land here once the DAP (Debug Adapter Protocol)
      // client is wired up.
      void scrollToBottom()
    },
    [input, scrollToBottom],
  )

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Entry list */}
      <div className="min-h-0 flex-1 overflow-y-auto font-mono text-[12px]">
        {entries.length === 0 ? (
          <div className="flex h-full items-center justify-center font-sans text-[13px] text-outline">
            <div className="text-center">
              <Icon name="bug" size={24} className="mx-auto mb-2" />
              <p className="text-xs text-[var(--text-muted)]">
                Start a debug session to use the Debug Console.
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
                {e.ts.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
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
        <span className="shrink-0 font-mono text-[12px] text-green-400">
          &gt;
        </span>
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
  )
}
