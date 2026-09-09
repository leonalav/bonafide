/**
 * CommandPalette.tsx — VS Code-style command palette (Ctrl+Shift+P).
 *
 * Glassmorphism panel matching DESIGN.md tokens:
 *   - backdrop-blur-xl, border-outline/20, bg-surface-container-lowest/80
 *   - Manrope label-caps for group headers, Inter for body
 *   - Official Blue (#aac7ff) for active row (bg-primary/15)
 *
 * Performance notes:
 *   - Uses usePaletteOpen / usePaletteQuery / usePaletteSelected reactive
 *     hooks so the component only re-renders when the palette IS open and
 *     the specific palette state fields change — NOT on every store dispatch.
 *   - buildPaletteCommands is stable (memoized with store identity) and
 *     reads current state at call time via the store ref, not a closure.
 *   - filteredCommands / grouped are memoized against their actual deps.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { createPortal } from "react-dom"

import { Icon } from "./ui/Icon"

import {
  useIdeStore,
  usePaletteOpen,
  usePaletteQuery,
  usePaletteSelected,
} from "../ide/hooks"

import type { IdeState } from "../ide/store"

import { buildPaletteCommands, type PaletteCommand } from "../commands/palette"

/** Case-insensitive substring filter over a command's searchable fields,
 * also applying the `when` visibility guard. */

function filterCommands(
  commands: PaletteCommand[],

  query: string,

  ideState: IdeState,
): PaletteCommand[] {
  if (!query.trim()) {
    return commands.filter((c) => !c.when || c.when(ideState))
  }

  const q = query.toLowerCase()

  return commands.filter(
    (c) =>
      (!c.when || c.when(ideState)) &&
      (c.label.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        c.group.toLowerCase().includes(q)),
  )
}

/** Group an array of commands by their `group` field. */

type GroupedCommands = { group: string; commands: PaletteCommand[] }[];

function groupCommands(commands: PaletteCommand[]): GroupedCommands {
  const map = new Map<string, PaletteCommand[]>()

  for (const cmd of commands) {
    const list = map.get(cmd.group) ?? []

    list.push(cmd)

    map.set(cmd.group, list)
  }

  return Array.from(map.entries()).map(([group, commands]) => ({
    group,
    commands,
  }))
}

/** Flat list of commands for keyboard nav index calculations. */

function flatCommands(grouped: GroupedCommands): PaletteCommand[] {
  return grouped.flatMap((g) => g.commands)
}

export default function CommandPalette() {
  const store = useIdeStore()

  // Use reactive hooks so this component only re-renders when the palette

  // state changes — NOT on every store dispatch. When the palette is closed,

  // this component is a no-op after the first render.

  const isOpen = usePaletteOpen()

  const storedQuery = usePaletteQuery()

  const storedSelected = usePaletteSelected()

  // Local query mirrors store for immediate typing feedback. Synced to store

  // on change so the dispatch-triggered re-render picks up the new value.

  const [query, setQuery] = useState(storedQuery)

  const [selectedIndex, setSelectedIndex] = useState(storedSelected)

  const inputRef = useRef<HTMLInputElement>(null)

  const listRef = useRef<HTMLDivElement>(null)

  // buildPaletteCommands reads current state at call time via the store ref.

  // Memoize against store identity so it's only called once per palette open.

  const allCommands = useMemo(() => buildPaletteCommands(store), [store])

  // Read current state snapshot for filtering (stable reference to the

  // IdeState slice — not the whole store).

  const paletteState = useMemo(
    () => store.getState().palette,

    // eslint-disable-next-line react-hooks/exhaustive-deps

    [isOpen, storedQuery, storedSelected],
  )

  const ideState = store.getState()

  const filteredCommands = useMemo(
    () => filterCommands(allCommands, query, ideState),

    [allCommands, query, ideState],
  )

  const grouped = useMemo(
    () => groupCommands(filteredCommands),
    [filteredCommands],
  )

  const flat = useMemo(() => flatCommands(grouped), [grouped])

  // Sync selected index to store on change so hooks can observe it.

  useEffect(() => {
    store.dispatch({ type: "SET_PALETTE_SELECTION", selected: selectedIndex })
  }, [selectedIndex, store])

  // Sync query to store.

  useEffect(() => {
    store.dispatch({ type: "SET_PALETTE_QUERY", query })
  }, [query, store])

  // Focus the search input when the palette opens.

  useEffect(() => {
    if (isOpen) {
      setQuery("")

      setSelectedIndex(0)

      // requestAnimationFrame ensures the DOM is painted before we call focus.

      requestAnimationFrame(() => {
        inputRef.current?.focus()
      })
    }
  }, [isOpen])

  // Scroll the selected row into view.

  useEffect(() => {
    const selectedEl = listRef.current?.querySelector<HTMLElement>(
      `[data-cmd-index="${selectedIndex}"]`,
    )

    selectedEl?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex])

  // Keyboard handler on the overlay (not just the input) so arrow keys

  // work even when focus is on the search field.

  const handleOverlayKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const total = flat.length

      if (total === 0) return

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault()

          setSelectedIndex((i) => (i + 1) % total)

          break
        }

        case "ArrowUp": {
          e.preventDefault()

          setSelectedIndex((i) => (i - 1 + total) % total)

          break
        }

        case "Enter": {
          e.preventDefault()

          if (flat[selectedIndex]) {
            closeAndRun(flat[selectedIndex])
          }

          break
        }

        case "Escape": {
          e.preventDefault()

          store.dispatch({ type: "CLOSE_PALETTE" })

          break
        }
      }
    },

    [flat, selectedIndex, store],
  )

  function closeAndRun(cmd: PaletteCommand) {
    store.dispatch({ type: "CLOSE_PALETTE" })

    // run() may be async (e.g. dialog pickers), fire-and-forget is fine.

    void cmd.run()
  }

  // Compute which flat index each group starts at (for highlighting active row).

  const groupStartIndices = useMemo(() => {
    const result: Record<string, number> = {}

    let offset = 0

    for (const g of grouped) {
      result[g.group] = offset

      offset += g.commands.length
    }

    return result
  }, [grouped])

  if (!isOpen) return null

  // Track which flat index each DOM row belongs to via data-cmd-index.

  let flatIndex = 0

  return createPortal(
    /* Overlay — centered, no backdrop blur (user did not request blinding) */

    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command Palette"
      className="fixed inset-0 z-[9995] flex items-center justify-center bg-black/40"
      onKeyDown={handleOverlayKeyDown}
      onClick={(e) => {
        // Close when clicking the backdrop scrim (but not the panel itself).

        if (e.target === e.currentTarget) {
          store.dispatch({ type: "CLOSE_PALETTE" })
        }
      }}
    >
      {/* Panel */}
      <div className="w-[640px] max-h-[70vh] flex flex-col rounded border border-outline/20 bg-surface-container-lowest shadow-2xl overflow-hidden">
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-outline/20 px-4 py-3">
          <Icon name="search" size={16} className="shrink-0 text-outline" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Type a command or search…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)

              setSelectedIndex(0)
            }}
            className="h-10 flex-1 bg-transparent font-body text-[14px] text-on-surface placeholder:text-outline focus-visible:outline-none"
          />
          {query && (
            <button
              onClick={() => {
                setQuery("")
                setSelectedIndex(0)
                inputRef.current?.focus()
              }}
              className="shrink-0 text-outline hover:text-on-surface transition-colors"
              aria-label="Clear search"
            >
              <Icon name="x" size={14} />
            </button>
          )}
        </div>

        {/* Command list */}
        <div
          ref={listRef}
          className="flex-1 overflow-y-auto py-1 overscroll-contain"
          style={{ maxHeight: "calc(70vh - 88px)" }}
        >
          {flat.length === 0 ? (
            <div className="px-4 py-6 text-center font-body text-[13px] text-outline">
              No commands match &ldquo;{query}&rdquo;
            </div>
          ) : (
            grouped.map(({ group, commands }) => (
              <div key={group}>
                {/* Group header */}
                <div
                  className="px-4 py-1 font-sans text-[12px] font-semibold tracking-[0.05em] uppercase text-outline"
                  style={{ fontFamily: "Manrope, sans-serif" }}
                >
                  {group}
                </div>

                {/* Command rows */}
                {commands.map((cmd) => {
                  const myIndex = flatIndex++

                  const isSelected = myIndex === selectedIndex

                  return (
                    <div
                      key={cmd.id}
                      data-cmd-index={myIndex}
                      onClick={() => closeAndRun(cmd)}
                      className={[
                        "h-8 px-4 flex items-center gap-3 rounded-sm cursor-default font-body text-[14px] transition-colors",

                        isSelected
                          ? "bg-primary/15 text-on-surface"
                          : "text-on-surface-variant hover:bg-surface-container/60",
                      ].join(" ")}
                    >
                      {cmd.icon && (
                        <Icon
                          name={cmd.icon}
                          size={14}
                          className={
                            isSelected ? "text-primary" : "text-outline"
                          }
                        />
                      )}
                      <span className="flex-1 truncate">{cmd.label}</span>
                      {cmd.shortcut && (
                        <span className="shrink-0 text-[11px] text-outline font-sans">
                          {cmd.shortcut}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-4 border-t border-outline-variant/40 px-4 py-2 font-sans text-[12px] text-outline">
          <span>
            <kbd className="rounded bg-surface-container px-1.5 py-0.5 font-mono text-[11px]">
              ↑↓
            </kbd>{" "}
            navigate
          </span>
          <span>
            <kbd className="rounded bg-surface-container px-1.5 py-0.5 font-mono text-[11px]">
              ↵
            </kbd>{" "}
            run
          </span>
          <span>
            <kbd className="rounded bg-surface-container px-1.5 py-0.5 font-mono text-[11px]">
              Esc
            </kbd>{" "}
            close
          </span>
        </div>
      </div>
    </div>,

    document.body,
  )
}
