/**
 * FindReplaceWidget.tsx — Bonafide's find/replace widget for CodeMirror.
 *
 * A two-row overlay that pins to the top-right of the editor surface,
 * mirroring the VS Code find widget structure:
 *
 *   Row 1 (find):    [Aa] [ab] [.*] [find input] [1 of 5] [▲] [▼] [x]
 *   Row 2 (replace): [replace input] [Replace] [Replace All]
 *
 * The widget owns:
 *   - The visible/hidden state (driven by `ide:open-find` window events).
 *   - The search query (string + caseSensitive + wholeWord + regexp flags).
 *   - The replace text.
 *
 * The widget delegates to CodeMirror's `@codemirror/search` for the actual
 * search algorithm: we dispatch `setSearchQuery` to push query state into
 * the editor, then call `findNext` / `findPrevious` / `replaceNext` /
 * `replaceAll` commands directly via `EditorView.dispatch(...)`.
 *
 * Match counting is local: we iterate `SearchCursor` over the document to
 * produce `{ from, to }` ranges, then resolve the cursor position to a
 * 1-based match index on every cursor change. We keep the count under
 * `MATCHES_LIMIT` to mirror VS Code's behaviour (renders `1 of 99+` once
 * the limit is exceeded).
 *
 * Styling follows `DESIGN.md`:
 *   - Glassmorphism panel: surface-container-lowest at 80% opacity,
 *     20px backdrop blur, 1px outline at 20% opacity.
 *   - Soft-technical 4px corner radius.
 *   - Official Blue (#aac7ff) primary tint for the active match indicator
 *     and focus ring.
 *   - Manrope for the match-count chip and toggle buttons, Inter for the
 *     input copy.
 *   - 4px baseline rhythm; 8px gutter between rows.
 *
 * Component is mounted inside the editor wrapper (not globally) so its
 * positioning context is the editor surface itself — pinning to
 * `top: 8px; right: 18px` matches VS Code's offset and reads as "inside
 * the editor", not "floating over the tab strip".
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"

import {
  EditorView,
  Decoration,
  ViewPlugin,
  type DecorationSet,
} from "@codemirror/view"

import { StateField, StateEffect } from "@codemirror/state"

import {
  SearchQuery,
  setSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
} from "@codemirror/search"

import { Icon } from "./ui/Icon"

// ── Match-decoration plugin ──────────────────────────────────────────────

//

// CodeMirror's built-in search extension already decorates matches via

// the `search` config — but it only activates after `openSearchPanel`

// has been called at least once. Since we replace that panel with our

// own React widget, we install a separate decoration extension that

// mirrors the built-in visuals: an underline + tinted background for

// every match, plus a stronger (bordered) tint for the current match.

//

// The match ranges are pushed into the editor as a StateEffect; a

// StateField stores the latest set, and a separate ViewPlugin turns

// that into a `DecorationSet`. Splitting the data path this way lets

// the React widget stay declarative — every effect (typing in the find

// input, toggling options) just dispatches a single effect with the new

// ranges.

const setSearchMatches = StateEffect.define<{
  ranges: { from: number to: number }[]

  active: number
} | null>()

interface SearchMatchState {
  ranges: { from: number to: number }[]

  active: number
}

const searchMatchField = StateField.define<SearchMatchState>({
  create() {
    return { ranges: [], active: -1 }
  },

  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSearchMatches)) {
        return e.value ?? { ranges: [], active: -1 }
      }
    }

    // Doc changes or cursor moves: re-resolve the active match index so

    // the highlight follows the caret. The widget re-pushes the full

    // ranges array when the query string changes, so we only need to

    // update `active` here.

    if (tr.docChanged || tr.selection) {
      if (value.ranges.length === 0) return value

      const pos = tr.state.selection.main.head

      let nextActive = value.active

      for (let i = 0; i < value.ranges.length; i++) {
        const r = value.ranges[i]

        if (pos <= r.to) {
          nextActive = i

          break
        }

        if (i === value.ranges.length - 1) {
          nextActive = -1
        }
      }

      return { ...value, active: nextActive }
    }

    return value
  },
})

function buildMatchDecorations(state: SearchMatchState): DecorationSet {
  if (state.ranges.length === 0) return Decoration.none

  const decos: { from: number to: number deco: Decoration }[] = []

  for (let i = 0; i < state.ranges.length; i++) {
    const r = state.ranges[i]

    if (r.from === r.to) continue

    const isActive = i === state.active

    decos.push({
      from: r.from,

      to: r.to,

      deco: Decoration.mark({
        class: isActive ? "cm-find-active" : "cm-find-match",

        attributes: isActive ? { "data-active": "true" } : {},
      }),
    })
  }

  return Decoration.set(
    decos.map((d) => d.deco.range(d.from, d.to)),

    true,
  )
}

const searchMatchDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      const state = view.state.field(searchMatchField, false) ?? {
        ranges: [],

        active: -1,
      }

      this.decorations = buildMatchDecorations(state)
    }

    update(update: import("@codemirror/view").ViewUpdate) {
      const cur = update.state.field(searchMatchField, false) ?? {
        ranges: [],

        active: -1,
      }

      const prev = update.startState.field(searchMatchField, false) ?? {
        ranges: [],

        active: -1,
      }

      if (update.docChanged || update.selectionSet || prev !== cur) {
        this.decorations = buildMatchDecorations(cur)
      }
    }
  },

  {
    decorations: (v) => v.decorations,
  },
)

// The full extension set: state field + view plugin. Imported by the

// editor and merged with the rest of its extensions.

export const findReplaceExtensions = [
  searchMatchField,

  searchMatchDecorations,
]

// ── Helpers ──────────────────────────────────────────────────────────────

// VS Code displays `99+` once the match count exceeds the cap. We use

// the same limit (999) to keep the UI legible for very long files.

const MATCHES_LIMIT = 999

function computeMatches(
  view: EditorView,

  query: SearchQuery,
): { from: number to: number }[] {
  if (!query.valid) return []

  // The cursor iterator exposes `value` and `done` properties on the

  // *iterator instance* (not on the `IteratorResult` returned by

  // `next()`). We must call `next()` at least once before reading

  // `cursor.value` — the docs are explicit about this. Loop by calling

  // `next()` and inspecting the iterator's own `value` after each step.

  const cursor = query.getCursor(view.state) as {
    next: () => unknown

    value: { from: number to: number }

    done: boolean
  }

  cursor.next()

  const ranges: { from: number to: number }[] = []

  let count = 0

  while (!cursor.done && count < MATCHES_LIMIT) {
    if (cursor.value.from === cursor.value.to) {
      // Empty match — still need to advance the iterator by calling

      // `next()` to avoid an infinite loop.

      cursor.next()

      continue
    }

    ranges.push({ from: cursor.value.from, to: cursor.value.to })

    cursor.next()

    count++
  }

  return ranges
}

function activeMatchIndex(
  ranges: { from: number to: number }[],

  pos: number,
): number {
  if (ranges.length === 0) return -1

  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i]

    if (pos <= r.to) return i
  }

  return -1
}

// ── Subcomponents ────────────────────────────────────────────────────────

function RoundIconButton({
  label,

  onClick,

  disabled,

  active,

  children,
}: {
  label: string

  onClick: () => void

  disabled?: boolean

  active?: boolean

  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.preventDefault()

        if (!disabled) onClick()
      }}
      onMouseDown={(e) => e.preventDefault()}
      className={`flex h-6 w-6 items-center justify-center rounded text-outline transition-colors hover:bg-surface-container-high hover:text-on-surface ${
        disabled ? "cursor-default opacity-30" : "cursor-pointer"
      } ${active ? "bg-primary/20 text-primary" : ""}`}
    >
      {children}
    </button>
  )
}

function ToggleButton({
  label,

  onClick,

  active,

  icon,
}: {
  label: string

  onClick: () => void

  active: boolean

  icon: "case-sensitive" | "whole-word" | "regex"
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.preventDefault()

        onClick()
      }}
      onMouseDown={(e) => e.preventDefault()}
      className={`flex h-6 w-7 items-center justify-center rounded border transition-colors ${
        active
          ? "border-primary/60 bg-primary/15 text-primary"
          : "border-transparent text-outline hover:border-outline/40 hover:text-on-surface"
      }`}
    >
      <Icon name={icon} size={13} strokeWidth={active ? 2 : 1.5} />
    </button>
  )
}

// ── Main component ───────────────────────────────────────────────────────

export function FindReplaceWidget({
  view,

  /** CodeMirror editor view — required so the widget can drive
   *  search, replace, and decoration dispatch directly. */
}: {
  view: EditorView | null
}) {
  // ── Local UI state ──────────────────────────────────────────────────────

  const [visible, setVisible] = useState(false)

  const [replaceVisible, setReplaceVisible] = useState(false)

  const [query, setQuery] = useState("")

  const [replaceText, setReplaceText] = useState("")

  const [caseSensitive, setCaseSensitive] = useState(false)

  const [wholeWord, setWholeWord] = useState(false)

  const [isRegex, setIsRegex] = useState(false)

  const [matchRanges, setMatchRanges] = useState<{ from: number to: number }[]>(
    [],
  )

  const [activeIndex, setActiveIndex] = useState(-1)

  const [regexError, setRegexError] = useState<string | null>(null)

  // ── Refs ───────────────────────────────────────────────────────────────

  const findInputRef = useRef<HTMLInputElement | null>(null)

  const replaceInputRef = useRef<HTMLInputElement | null>(null)

  // Track the last query we pushed to CodeMirror so we don't re-push on

  // every keystroke when nothing changed (CodeMirror recomputes its own

  // cursor on each push, which can be expensive for large files).

  const lastPushedQueryRef = useRef<string>("")

  // ── Subscribe to open/close events ──────────────────────────────────────

  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (e as CustomEvent).detail as {
        mode?: "find" | "replace"
        query?: string
      } | undefined

      if (detail?.mode === "replace") {
        setReplaceVisible(true)
      }

      // Seed from the current selection when no explicit query was

      // passed and we don't already have text in the input. Note: in

      // CodeMirror 6, `view.state.selection.main` is an `EditorSelection`

      // object (with `from` / `to` numeric fields), NOT a string. Calling

      // `String(...)` on it produced "[object Object]" in the input —

      // the canonical way to read the selected text is to slice the

      // editor's document between the main selection's `from` and `to`

      // positions. We additionally coerce the result through `String(...)`

      // as a belt-and-suspenders guard against any future API change

      // that returns a non-string here.

      let selectionText = ""

      if (view) {
        try {
          const main = view.state.selection.main

          if (main && typeof main.from === "number" && main.from !== main.to) {
            selectionText = String(view.state.sliceDoc(main.from, main.to))
          }
        } catch {
          selectionText = ""
        }
      }

      const detailQuery = typeof detail?.query === "string" ? detail.query : ""

      const seed = String(detailQuery || selectionText || "")

      if (seed) {
        setQuery((q) => (q ? q : seed))
      }

      setVisible(true)
    }

    function onClose() {
      setVisible(false)
    }

    window.addEventListener("ide:open-find", onOpen)

    window.addEventListener("ide:close-find", onClose)

    return () => {
      window.removeEventListener("ide:open-find", onOpen)

      window.removeEventListener("ide:close-find", onClose)
    }
  }, [view])

  // ── Build & dispatch a SearchQuery whenever the inputs change ───────────

  const currentQuery = useMemo(() => {
    if (!query) return null

    return new SearchQuery({
      search: query,

      caseSensitive,

      wholeWord,

      regexp: isRegex,
    })
  }, [query, caseSensitive, wholeWord, isRegex])

  useEffect(() => {
    if (!view) return

    if (!visible) return

    // Validate regex queries up-front so we can show the error inline.

    if (isRegex && query.length > 0) {
      try {
        new RegExp(query, caseSensitive ? "g" : "gi")

        setRegexError(null)
      } catch (e) {
        setRegexError((e as Error).message)

        setMatchRanges([])

        setActiveIndex(-1)

        view.dispatch({ effects: setSearchMatches.of(null) })

        return
      }
    } else {
      setRegexError(null)
    }

    if (!currentQuery || !currentQuery.valid) {
      setMatchRanges([])

      setActiveIndex(-1)

      view.dispatch({ effects: setSearchMatches.of(null) })

      return
    }

    const ranges = computeMatches(view, currentQuery)

    setMatchRanges(ranges)

    const idx = activeMatchIndex(ranges, view.state.selection.main.head)

    setActiveIndex(idx)

    // Push the query into the editor so findNext/replaceNext work.

    const signature = `${query}|${caseSensitive ? 1 : 0}|${wholeWord ? 1 : 0}|${
      isRegex ? 1 : 0
    }`

    if (lastPushedQueryRef.current !== signature) {
      lastPushedQueryRef.current = signature

      view.dispatch({ effects: setSearchQuery.of(currentQuery) })
    }

    view.dispatch({
      effects: setSearchMatches.of({ ranges, active: idx }),
    })
  }, [view, visible, currentQuery, isRegex, caseSensitive, query])

  // ── Focus the find input when we open ──────────────────────────────────

  useLayoutEffect(() => {
    if (visible && findInputRef.current) {
      findInputRef.current.focus()

      findInputRef.current.select()
    }
  }, [visible])

  // ── Handlers ───────────────────────────────────────────────────────────

  const close = useCallback(() => {
    if (view) {
      view.dispatch({ effects: setSearchMatches.of(null) })

      view.focus()
    }

    setVisible(false)

    setReplaceVisible(false)
  }, [view])

  const syncActiveHighlight = useCallback(() => {
    if (!view) return

    const pos = view.state.selection.main.head

    setActiveIndex((cur) => {
      const next = activeMatchIndex(matchRanges, pos)

      if (next === cur) return cur

      view.dispatch({
        effects: setSearchMatches.of({ ranges: matchRanges, active: next }),
      })

      return next
    })
  }, [view, matchRanges])

  const goNext = useCallback(() => {
    if (!view || !currentQuery || !currentQuery.valid) return

    view.dispatch({ effects: setSearchQuery.of(currentQuery) })

    findNext(view)

    // After the command runs the cursor has moved; sync the highlight.

    requestAnimationFrame(syncActiveHighlight)
  }, [view, currentQuery, syncActiveHighlight])

  const goPrev = useCallback(() => {
    if (!view || !currentQuery || !currentQuery.valid) return

    view.dispatch({ effects: setSearchQuery.of(currentQuery) })

    findPrevious(view)

    requestAnimationFrame(syncActiveHighlight)
  }, [view, currentQuery, syncActiveHighlight])

  const doReplace = useCallback(() => {
    if (!view || !currentQuery || !currentQuery.valid) return

    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: query,

          caseSensitive,

          wholeWord,

          regexp: isRegex,

          replace: replaceText,
        }),
      ),
    })

    replaceNext(view)

    // Recount matches after the replacement (the document changed).

    setTimeout(() => {
      if (!view || !currentQuery.valid) return

      const ranges = computeMatches(view, currentQuery)

      setMatchRanges(ranges)

      const pos = view.state.selection.main.head

      const idx = activeMatchIndex(ranges, pos)

      setActiveIndex(idx)

      view.dispatch({
        effects: setSearchMatches.of({ ranges, active: idx }),
      })
    }, 0)
  }, [
    view,
    currentQuery,
    query,
    caseSensitive,
    wholeWord,
    isRegex,
    replaceText,
  ])

  const doReplaceAll = useCallback(() => {
    if (!view || !currentQuery || !currentQuery.valid) return

    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: query,

          caseSensitive,

          wholeWord,

          regexp: isRegex,

          replace: replaceText,
        }),
      ),
    })

    replaceAll(view)

    setTimeout(() => {
      if (!view || !currentQuery.valid) return

      const ranges = computeMatches(view, currentQuery)

      setMatchRanges(ranges)

      const idx = ranges.length > 0 ? 0 : -1

      setActiveIndex(idx)

      view.dispatch({
        effects: setSearchMatches.of({ ranges, active: idx }),
      })
    }, 0)
  }, [
    view,
    currentQuery,
    query,
    caseSensitive,
    wholeWord,
    isRegex,
    replaceText,
  ])

  // ── Keyboard handlers ──────────────────────────────────────────────────

  const onFindKey = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault()

        if (e.shiftKey) goPrev()
        else goNext()
      } else if (e.key === "Escape") {
        e.preventDefault()

        close()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "h") {
        e.preventDefault()

        setReplaceVisible(true)

        replaceInputRef.current?.focus()
      }
    },

    [goNext, goPrev, close],
  )

  const onReplaceKey = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault()

        doReplace()
      } else if (e.key === "Escape") {
        e.preventDefault()

        close()
      }
    },

    [doReplace, close],
  )

  // ── Global Escape closes the widget even when focus is in the editor ────

  useEffect(() => {
    if (!visible) return

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault()

        close()
      }
    }

    window.addEventListener("keydown", onKey, true)

    return () => window.removeEventListener("keydown", onKey, true)
  }, [visible, close])

  if (!visible) return null

  // ── Derived UI state ───────────────────────────────────────────────────

  const totalCount = matchRanges.length

  const showCount = query.length > 0 && !regexError

  const limitHit = totalCount >= MATCHES_LIMIT

  const countLabel = !showCount
    ? ""
    : totalCount === 0
      ? "No results"
      : `${activeIndex >= 0 ? activeIndex + 1 : "?"} of ${
          limitHit ? `${MATCHES_LIMIT}+` : totalCount
        }`

  const noResults = showCount && totalCount === 0

  // Two-row layout where each row uses a 3-cell flex structure:

  //   [chevron | input | controls]

  //   - Chevron cell is fixed width (20px) and identical on both rows,

  //     so the toggle lines up vertically.

  //   - Input cell is `flex: 1` with `min-width: 0` so it fills the

  //     available width and the two inputs (Find vs Replace) are

  //     guaranteed to occupy the same horizontal band on both rows.

  //   - Controls cell is `flex-none` so the row-specific controls

  //     (toggles + count + nav on the find row; replace buttons on

  //     the replace row) take only the space they need. The two rows

  //     have different control sets, so we don't force-align their

  //     right edges — only the input column needs to match.

  const rowClass = "flex items-center gap-1 px-2 py-1.5"

  const chevronCellClass = "flex h-6 w-5 shrink-0 items-center justify-center"

  const inputCellClass = "flex h-7 min-w-0 flex-1 items-center"

  return (
    <div
      role="dialog"
      aria-label="Find and Replace"
      onMouseDown={(e) => e.stopPropagation()}
      className="pointer-events-none absolute right-4 top-2 z-20 w-[440px] select-none"
    >
      <div className="pointer-events-auto rounded border border-outline/20 bg-surface-container-lowest/80 shadow-2xl backdrop-blur-xl">
        {/* ── Find row ─────────────────────────────────────────── */}
        <div className={rowClass}>
          {/* Chevron cell — same width on both rows so they line up */}
          <div className={chevronCellClass}>
            <button
              type="button"
              aria-label={replaceVisible ? "Hide Replace" : "Show Replace"}
              title={replaceVisible ? "Hide Replace" : "Toggle Replace"}
              onClick={(e) => {
                e.preventDefault()

                setReplaceVisible((v) => !v)
              }}
              onMouseDown={(e) => e.preventDefault()}
              className={`flex h-6 w-5 items-center justify-center rounded text-outline transition-all duration-150 hover:bg-surface-container-high hover:text-on-surface ${
                replaceVisible ? "rotate-90" : ""
              }`}
            >
              <Icon name="chevron-right" size={12} strokeWidth={2} />
            </button>
          </div>

          {/* Find input cell — `flex-1` + `min-w-0` so the input
              width matches the replace input exactly on the row below */}
          <div
            className={`${inputCellClass} rounded border bg-surface-container-low/40 px-2 transition-colors ${
              noResults
                ? "border-error/60"
                : "border-outline/30 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30"
            }`}
          >
            <input
              ref={findInputRef}
              type="text"
              value={query}
              spellCheck={false}
              autoComplete="off"
              placeholder="Find"
              aria-label="Find"
              data-main-field="true"
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setQuery(String(e.target.value))
              }
              onKeyDown={onFindKey}
              className="h-full w-full border-0 bg-transparent font-sans text-[13px] text-on-surface placeholder:text-outline focus:outline-none"
              style={{ fontFamily: "var(--font-sans)" }}
            />
          </div>

          {/* Controls cell — row-specific, no width constraint */}
          <div className="flex shrink-0 items-center gap-1">
            <ToggleButton
              label="Match Case (Alt+C)"
              icon="case-sensitive"
              active={caseSensitive}
              onClick={() => setCaseSensitive((v) => !v)}
            />
            <ToggleButton
              label="Match Whole Word (Alt+W)"
              icon="whole-word"
              active={wholeWord}
              onClick={() => setWholeWord((v) => !v)}
            />
            <ToggleButton
              label="Use Regular Expression (Alt+R)"
              icon="regex"
              active={isRegex}
              onClick={() => setIsRegex((v) => !v)}
            />

            {/* Match count */}
            <span
              aria-live="polite"
              className={`flex h-6 min-w-[68px] items-center justify-center px-1.5 font-sans text-[11px] tabular-nums ${
                noResults
                  ? "text-error"
                  : totalCount > 0
                    ? "text-on-surface-variant"
                    : "text-outline"
              }`}
              style={{ fontFamily: "var(--font-sans)" }}
            >
              {countLabel || "\u00A0"}
            </span>

            {/* Prev / Next */}
            <RoundIconButton
              label="Previous Match (Shift+Enter)"
              onClick={goPrev}
              disabled={!showCount || totalCount === 0}
            >
              <Icon name="arrow-up" size={13} />
            </RoundIconButton>
            <RoundIconButton
              label="Next Match (Enter)"
              onClick={goNext}
              disabled={!showCount || totalCount === 0}
            >
              <Icon name="arrow-down" size={13} />
            </RoundIconButton>

            {/* Close */}
            <RoundIconButton label="Close (Escape)" onClick={close}>
              <Icon name="x" size={13} />
            </RoundIconButton>
          </div>
        </div>

        {/* ── Regex error / empty hint ──────────────────────────── */}
        {regexError && (
          <div className="border-t border-outline-variant/30 px-3 py-1.5 font-mono text-[11px] text-error">
            {regexError}
          </div>
        )}

        {/* ── Replace row ──────────────────────────────────────── */}
        {/* Same 3-cell flex structure as the find row so the input
            cell aligns exactly under the find input cell. The chevron
            cell is intentionally empty (no toggle on the replace
            row), and the controls cell hosts the Replace/All buttons. */}
        {replaceVisible && (
          <div className={`${rowClass} border-t border-outline-variant/30`}>
            {/* Chevron cell — empty placeholder so columns line up */}
            <div className={chevronCellClass} aria-hidden="true" />

            {/* Replace input cell — guaranteed same width as find input */}
            <div
              className={`${inputCellClass} rounded border border-outline/30 bg-surface-container-low/40 px-2 transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30`}
            >
              <input
                ref={replaceInputRef}
                type="text"
                value={replaceText}
                spellCheck={false}
                autoComplete="off"
                placeholder="Replace"
                aria-label="Replace"
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setReplaceText(String(e.target.value))
                }
                onKeyDown={onReplaceKey}
                className="h-full w-full border-0 bg-transparent font-sans text-[13px] text-on-surface placeholder:text-outline focus:outline-none"
                style={{ fontFamily: "var(--font-sans)" }}
              />
            </div>

            {/* Controls cell — Replace / Replace All */}
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                tabIndex={!showCount || totalCount === 0 ? -1 : 0}
                aria-label="Replace"
                title="Replace (Enter)"
                onClick={(e) => {
                  e.preventDefault()

                  doReplace()
                }}
                onMouseDown={(e) => e.preventDefault()}
                disabled={!showCount || totalCount === 0}
                className={`flex h-6 items-center gap-1 rounded px-2 font-sans text-[12px] transition-colors ${
                  !showCount || totalCount === 0
                    ? "cursor-default text-outline/40"
                    : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
                }`}
              >
                <Icon name="replace" size={12} />
                Replace
              </button>
              <button
                type="button"
                tabIndex={!showCount || totalCount === 0 ? -1 : 0}
                aria-label="Replace All"
                title="Replace All (Ctrl+Alt+Enter)"
                onClick={(e) => {
                  e.preventDefault()

                  doReplaceAll()
                }}
                onMouseDown={(e) => e.preventDefault()}
                disabled={!showCount || totalCount === 0}
                className={`flex h-6 items-center gap-1 rounded px-2 font-sans text-[12px] transition-colors ${
                  !showCount || totalCount === 0
                    ? "cursor-default text-outline/40"
                    : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
                }`}
              >
                <Icon name="replace-all" size={12} />
                All
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default FindReplaceWidget
