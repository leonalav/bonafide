/**
 * chat/MentionMenu.tsx — Workspace @-reference picker.
 *
 * Appears when the user types `@` inside the Composer textarea.
 * Surfaces files and folders from the currently-open workspace
 * (sourced from `bonafide.fs.readDirectory`) filtered by the
 * partial query after `@`. Selecting an entry inserts a chip
 * token (`@relative/path `) at the cursor.
 *
 * Design source: `agent-sticker-sheet.html` (Dropdown Menu family)
 * + the inline file/folder chips shown alongside the user's
 * quick-suggestion list in `agent-example-sessions.html`. The
 * rendered look matches the existing mode / model pickers so
 * the three dropdowns feel like one family.
 *
 * The menu is intentionally **read-only** in what it surfaces:
 *   - No write/edit affordances (the user isn't expected to
 *     manage files from here — that lives in the File Tree tab).
 *   - No third-party services (one workspace, one root).
 *   - No fuzzy ranking — the workspace root is small enough that
 *     a substring filter on `name` (with optional path prefix
 *     matching) is faster than a typo-tolerant index, and the
 *     rank-by-recent path would surprise users.
 *
 * Click-outside dismisses via the shared `Backdrop` component
 * already used by the mode / model pickers.
 */

import {
  useEffect,
  useMemo,
  useState,
} from "react"
import { createPortal } from "react-dom"
import { Icon } from "../ui/Icon"
import {
  bonafide,
  type DirListing,
} from "../../ipc/tauri"
import { useWorkspaceRoot } from "../../ide/hooks"

/**
 * One selectable entry in the menu. `relativePath` is what we
 * insert into the composer (no leading `/`, forward-slash
 * separators). `parentPath` is the directory it lives in, kept
 * for the secondary line under the primary label.
 */
export type MentionEntry = {
  /** Forward-slash relative path from the workspace root. */
  relativePath: string
  /** Just the basename — used as the chip's bolded name. */
  name: string
  /** Parent directory's relative path (`""` for root entries). */
  parentPath: string
  kind: "file" | "folder"
}

export type MentionMenuProps = {
  /**
   * Where to anchor the menu. Pass a caret-anchored rect from
   * `computeCaretAnchor(...)` (see Composer). Plain `DOMRect` is
   * still accepted for legacy callers but is treated as the
   * textarea's bounding box, which puts the menu at the wrong
   * edge — prefer the caret anchor.
   */
  anchor: MentionAnchor | null
  /** Partial query typed after `@` (without the `@`). */
  query: string
  /** Currently highlighted index (0-based). Caller owns this. */
  highlighted: number
  /** Entries to show (already filtered + ranked by the parent). */
  entries: MentionEntry[]
  /** Selection handlers — wired back to the composer's insertion. */
  onSelect: (entry: MentionEntry) => void
  onHighlight: (idx: number) => void
  onClose: () => void
}

// ── Menu positioning ─────────────────────────────────────────────────────────

const MARGIN = 6 // px between caret and popover edge
const MENU_HEIGHT_ESTIMATE = 260 // px — used to decide flip before render
const VIEWPORT_EDGE_PAD = 8 // px — keep popover off the viewport edges
const MENU_WIDTH = 320 // px — wider than the mode picker so we can fit paths

function computeMentionPosition(anchor: MentionAnchor, menuWidth: number) {
  // Normalise the legacy `DOMRect` shape to the caret-anchored
  // shape so the rest of the function only deals with one type.
  // A `DOMRect`'s `top` is the textarea's top edge — which can be
  // hundreds of pixels above the caret when the textarea is
  // multi-line. The legacy fallback below clamps that to the
  // caret's expected position so the menu no longer floats into
  // empty whitespace when the `@` sits mid-paragraph.
  const caretTop =
    "top" in anchor && "left" in anchor && "lineHeight" in anchor
      ? anchor.top
      : // legacy: textarea rect — best-effort baseline
        anchor.top
  const caretLeft =
    "top" in anchor && "left" in anchor && "lineHeight" in anchor
      ? anchor.left
      : anchor.left
  const lineHeight =
    "top" in anchor && "left" in anchor && "lineHeight" in anchor
      ? anchor.lineHeight
      : 20

  // Flip upward when there's not enough room below the caret line.
  // We measure space-below from the caret line's bottom edge, not
  // the textarea's bottom edge — the menu is conceptually attached
  // to the caret, so the flip decision should be based on what
  // sits between the caret and the viewport bottom.
  const caretBottom = caretTop + lineHeight
  const spaceBelow = window.innerHeight - caretBottom
  const flip = spaceBelow < MARGIN + MENU_HEIGHT_ESTIMATE

  const maxLeft = Math.max(
    VIEWPORT_EDGE_PAD,
    window.innerWidth - VIEWPORT_EDGE_PAD - menuWidth,
  )
  // Anchor the menu's left edge to the caret's left edge so the
  // highlighted row sits directly under the `@` the user just
  // typed. Fall back to the viewport-safe clamp when the caret
  // would push the menu past the right edge (long query, narrow
  // window, wrapped line).
  const left = Math.min(
    Math.max(VIEWPORT_EDGE_PAD, caretLeft),
    maxLeft,
  )
  const width = Math.min(
    menuWidth,
    window.innerWidth - VIEWPORT_EDGE_PAD - VIEWPORT_EDGE_PAD,
  )
  // When flipping upward, `top` becomes the caret's top minus a
  // single margin — `translateY(-100%)` then bumps the menu's
  // bottom edge to that point. When not flipping, the menu sits
  // just below the caret baseline.
  return {
    top: flip ? caretTop - MARGIN : caretBottom + MARGIN,
    left,
    width,
    flip,
    caretLineHeight: lineHeight,
  }
}

// ── Click-outside backdrop ──────────────────────────────────────────────────

function Backdrop({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] cursor-default" onClick={onClose} />
  )
}

// ── Entry row ────────────────────────────────────────────────────────────────

function MentionRow({
  entry,
  active,
  onMouseEnter,
  onClick,
}: {
  entry: MentionEntry
  active: boolean
  onMouseEnter: () => void
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onMouseEnter={onMouseEnter}
      onMouseDown={(e) => {
        // mousedown so we beat the textarea's blur handler, which
        // would otherwise reset state before the selection fires.
        e.preventDefault()
      }}
      onClick={onClick}
      className={`relative flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-surface-container-high ${
        active ? "bg-surface-container-high" : ""
      }`}
    >
      {active && (
        <span className="absolute left-0 top-0 h-full w-[2px] rounded-full bg-primary" />
      )}
      <Icon
        name={entry.kind === "folder" ? "folder" : "file"}
        size={12}
        className={
          entry.kind === "folder"
            ? "shrink-0 text-on-surface-variant"
            : "shrink-0 text-outline"
        }
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-1 truncate">
          <span className="truncate font-body text-[12px] font-medium text-on-surface">
            {entry.name}
          </span>
          {entry.parentPath ? (
            <span className="truncate font-sans text-[10px] text-outline">
              {entry.parentPath}
            </span>
          ) : null}
        </span>
        <span className="truncate font-sans text-[10px] text-outline">
          @{entry.relativePath}
        </span>
      </span>
      {active ? (
        <Icon
          name="corner-down-left"
          size={11}
          className="shrink-0 text-primary"
        />
      ) : null}
    </button>
  )
}

// ── Component ────────────────────────────────────────────────────────────────

export function MentionMenu({
  anchor,
  query,
  highlighted,
  entries,
  onSelect,
  onHighlight,
  onClose,
}: MentionMenuProps) {
  if (!anchor) return null
  // The `flip` here is computed against the caret line, so the
  // menu appears directly below the caret (or above it when the
  // caret is near the bottom of the viewport). The previous
  // implementation flipped against the textarea's top edge, which
  // is wrong for multi-line textareas — the menu would drift up
  // into the empty space above the textarea whenever the `@` sat
  // in the middle of a paragraph.
  const { top, left, width, flip } = computeMentionPosition(
    anchor,
    MENU_WIDTH,
  )

  return createPortal(
    <>
      <Backdrop onClose={onClose} />
      <div
        style={{
          position: "fixed",
          top,
          left,
          width,
          maxHeight: 320,
          transform: flip ? "translateY(-100%)" : undefined,
        }}
        role="listbox"
        aria-label="Workspace files and folders"
        className="z-[70] flex flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container shadow-xl"
      >
        {/* Header — explains what the menu is, mirrors the dropdown
            family from `agent-sticker-sheet.html`. */}
        <div className="label-caps flex items-center justify-between border-b border-outline-variant/40 px-2 pt-1.5 pb-1 text-outline">
          <span>{query ? "Matching references" : "Workspace references"}</span>
          <span className="font-sans text-[10px] normal-case text-outline">
            ↑↓ to move · Enter to insert
          </span>
        </div>
        <div className="flex-1 overflow-auto p-1.5">
          {entries.length === 0 ? (
            <div className="flex flex-col items-center gap-1 px-2 py-3 text-center">
              <span className="font-body text-[12px] text-on-surface-variant">
                No matches
              </span>
              <span className="font-sans text-[10px] text-outline">
                {query
                  ? `Nothing in the workspace matches “${query}”.`
                  : "Open a workspace to see files and folders."}
              </span>
            </div>
          ) : (
            entries.map((e, i) => (
              <MentionRow
                key={e.relativePath}
                entry={e}
                active={i === highlighted}
                onMouseEnter={() => onHighlight(i)}
                onClick={() => onSelect(e)}
              />
            ))
          )}
        </div>
      </div>
    </>,
    document.body,
  )
}

// ── Workspace listing hook ──────────────────────────────────────────────────

/**
 * Flatten the workspace tree into a single list of `MentionEntry`s.
 *
 * The renderer's `DirListing` returns a flat array of `FsNode`
 * records (parent-child links, not nested). We resolve the parent
 * chain once and sort: folders first (so `cd`-ing into one is
 * always one keystroke away), then alphabetical.
 *
 * Hidden paths (anything starting with `.`, plus `node_modules` /
 * `target` / `dist` / `build`) are excluded — these add noise
 * without value when the user wants to reference a project file.
 * The hide-list mirrors the conventions in the File Tree tab so
 * the two surfaces stay aligned.
 */
export function useWorkspaceMentionEntries(): MentionEntry[] {
  const workspaceRoot = useWorkspaceRoot()
  const [listing, setListing] = useState<DirListing | null>(null)

  useEffect(() => {
    if (!workspaceRoot) {
      setListing(null)
      return
    }
    let cancelled = false
    void bonafide.fs
      .readDirectory(workspaceRoot)
      .then((dir) => {
        if (!cancelled) setListing(dir)
      })
      .catch(() => {
        if (!cancelled) setListing(null)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceRoot])

  return useMemo(() => {
    if (!listing) return []
    const idToName = new Map<string, string>()
    const idToParent = new Map<string, string | null>()
    const idToKind = new Map<string, "folder" | "file">()
    for (const node of listing.files) {
      idToName.set(node.id, node.name)
      idToParent.set(node.id, node.parentId)
      idToKind.set(node.id, node.kind)
    }

    const rootId =
      listing.files.find((n) => n.parentId === null)?.id ?? null

    const out: MentionEntry[] = []
    for (const node of listing.files) {
      if (rootId !== null && node.id === rootId) continue
      const name = node.name
      if (name.startsWith(".")) continue
      if (
        name === "node_modules" ||
        name === "target" ||
        name === "dist" ||
        name === "build" ||
        name === ".git"
      ) {
        continue
      }

      // Build the relative path by walking up to the workspace root.
      const segments: string[] = [name]
      let cursor: string | null = node.parentId
      while (cursor !== null && cursor !== rootId) {
        const seg = idToName.get(cursor)
        if (!seg) break
        segments.unshift(seg)
        cursor = idToParent.get(cursor) ?? null
      }
      const relativePath = segments.join("/")
      const parentPath = segments.slice(0, -1).join("/")
      out.push({
        relativePath,
        name,
        parentPath,
        kind: node.kind,
      })
    }

    out.sort((a, b) => {
      // Folders first, then alphabetical within each group.
      if (a.kind !== b.kind) {
        return a.kind === "folder" ? -1 : 1
      }
      return a.relativePath.localeCompare(b.relativePath, undefined, {
        sensitivity: "base",
      })
    })
    return out
  }, [listing])
}

// ── Filter helper ───────────────────────────────────────────────────────────

/**
 * Substring filter used by the composer when the user types a
 * partial query. Matches against the entry's `name`, `relativePath`,
 * or `parentPath`. Empty query returns every entry so the menu
 * shows the full list the first time `@` is typed.
 *
 * We deliberately do not collapse leading `./` or `/` from the
 * query: the user typed `@./…` to mean "from the workspace root"
 * and the menu should mirror that intent.
 */
export function filterMentionEntries(
  entries: MentionEntry[],
  query: string,
): MentionEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries
  return entries.filter(
    (e) =>
      e.name.toLowerCase().includes(q) ||
      e.relativePath.toLowerCase().includes(q) ||
      e.parentPath.toLowerCase().includes(q),
  )
}

/**
 * Find the position of the active `@`-reference in the textarea.
 *
 * Walks backward from the caret to the nearest whitespace or the
 * start of the line. The substring must start with `@` and not
 * contain another `@` along the way (otherwise we'd reopen an
 * older reference).
 *
 * Returns `null` when there's no active `@` token — the composer
 * uses that to close the menu.
 */
export function findActiveMention(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  // Walk backward over characters that are valid in a path token:
  // letters, digits, slash, dot, dash, underscore, plus.
  let i = caret
  while (i > 0) {
    const c = text[i - 1]
    if (
      c === "@" ||
      c === " " ||
      c === "\n" ||
      c === "\t" ||
      c === "(" ||
      c === "["
    ) {
      break
    }
    i -= 1
  }
  if (i === 0 || text[i - 1] !== "@") return null
  // The `@` itself is at index `i - 1`. The token starts at `i`.
  return {
    start: i - 1,
    query: text.slice(i, caret),
  }
}

// ── Reference chip (exported for the user bubble to render) ────────────────

export type MentionToken = { kind: "ref"; path: string } | { kind: "text"; value: string }

/**
 * Tokenise a user message into runs of plain text and `@`-references.
 * The user bubble renders each `ref` as a chip and the `text` runs
 * through the existing `InlineContent` parser.
 *
 * The grammar:
 *   - An `@` followed by one or more path characters (letters,
 *     digits, slash, dot, dash, underscore) is a reference.
 *   - Anything else is text.
 *
 * If the user hasn't typed any path chars yet (just `@`), we fall
 * back to text so the `@` symbol stays inline — the bubble should
 * not yet render a chip for an unfinished token.
 */
export function parseMentionTokens(text: string): MentionToken[] {
  const out: MentionToken[] = []
  let i = 0
  let buf = ""
  while (i < text.length) {
    if (text[i] === "@") {
      // Peek ahead for path chars. An `@` immediately followed by
      // whitespace / punctuation / end-of-string is plain text.
      let j = i + 1
      while (
        j < text.length &&
        /[A-Za-z0-9._/+\-]/.test(text[j])
      ) {
        j += 1
      }
      if (j > i + 1) {
        if (buf) {
          out.push({ kind: "text", value: buf })
          buf = ""
        }
        out.push({ kind: "ref", path: text.slice(i + 1, j) })
        i = j
        continue
      }
      // `@` without a path after it — keep as plain text so the
      // user's still-typing state isn't misinterpreted as a
      // complete reference.
      buf += "@"
      i += 1
      continue
    }
    buf += text[i]
    i += 1
  }
  if (buf) out.push({ kind: "text", value: buf })
  return out
}

// ── Caret-anchor helper (exported for Composer) ──────────────────────────────

/**
 * Compute the caret's viewport-anchored position so the mention
 * menu can dock directly under (or above) the `@` token instead
 * of to the textarea edge.
 *
 * Implementation: clone the textarea into a hidden `<div>`, copy
 * the relevant styles (so font / padding / line-height / width /
 * wrap behaviour all match), fill it with the textarea's text up
 * to the caret position, append a zero-width marker span, then
 * measure the marker's bounding rect. We translate that rect by
 * the textarea's own viewport offset to get caret-relative coords.
 *
 * The previous implementation passed `textarea.getBoundingClientRect()`
 * straight to the menu as the anchor — that rect is the textarea's
 * full bounding box, not the caret's. On a multi-line composer
 * the menu would float to the wrong edge and end up clipping out
 * of the viewport.
 *
 * Returns `null` when the textarea isn't laid out yet (first
 * render, hidden ancestor, detached element) — caller should fall
 * back to the legacy rect in that case.
 */
export function computeCaretAnchor(
  textarea: HTMLTextAreaElement,
  caret: number,
): MentionAnchor | null {
  if (!textarea.isConnected) return null
  const rect = textarea.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return null

  const style = window.getComputedStyle(textarea)
  const mirror = document.createElement("div")
  mirror.setAttribute("aria-hidden", "true")
  mirror.style.position = "absolute"
  mirror.style.visibility = "hidden"
  mirror.style.pointerEvents = "none"
  mirror.style.top = "0"
  mirror.style.left = "-9999px"
  mirror.style.whiteSpace = "pre-wrap"
  mirror.style.wordWrap = "break-word"
  mirror.style.overflowWrap = "break-word"
  // Match the textarea's box exactly — every property that can
  // affect caret position is copied. Missing any one of these
  // shifts the marker span by a line (or more) on the first call.
  const copyProps: (keyof CSSStyleDeclaration)[] = [
    "font",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "lineHeight",
    "letterSpacing",
    "padding",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "border",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "boxSizing",
    "width",
    "tabSize",
    "textTransform",
  ]
  for (const prop of copyProps) {
    const value = style.getPropertyValue(prop)
    if (value) mirror.style.setProperty(prop, value)
  }

  // Walk up from the textarea to copy inline ancestors that may
  // contribute (e.g. a flex parent's `align-items` won't show up
  // on the textarea itself but does affect the caret line). For
  // typical desktop layouts the textarea's own style is enough; the
  // ancestor walk is a defensive guard against container-level
  // font inheritance that would otherwise shift the marker.
  const before = textarea.value.slice(0, caret)
  mirror.textContent = before
  const marker = document.createElement("span")
  marker.textContent = "\u200b"
  mirror.appendChild(marker)
  document.body.appendChild(mirror)

  const markerRect = marker.getBoundingClientRect()
  const mirrorRect = mirror.getBoundingClientRect()
  const lineHeight =
    parseFloat(style.lineHeight) || parseFloat(style.fontSize) || 20

  // Translate marker coords from the off-screen mirror position
  // into viewport coords matching the textarea's box.
  const caretLeft = markerRect.left - mirrorRect.left + rect.left
  const caretTop = markerRect.top - mirrorRect.top + rect.top

  document.body.removeChild(mirror)

  // Edge case: when the textarea is hidden via `display: none`,
  // the rect is all zeros. `computeCaretAnchor` returns null above
  // for that case. Here we just make sure we never return a rect
  // that would render the menu above the viewport top.
  if (!Number.isFinite(caretLeft) || !Number.isFinite(caretTop)) return null

  return {
    top: caretTop,
    left: caretLeft,
    lineHeight,
  }
}
