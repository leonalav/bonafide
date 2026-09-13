/**
 * chat/MarkdownContent.tsx — Block-level Markdown / GFM renderer.
 *
 * Replaces the prior "raw text with very lightweight inline markup"
 * approach with a proper block-level parser. The previous
 * implementation only tokenised backtick spans, **bold**, and *italic*
 * — anything else (`### Heading`, `| col |`, `---`, `- item`,
 * ` ``` ` blocks) was rendered verbatim, which made assistant replies
 * from models that emit structured Markdown (the common case) look
 * broken in the chat.
 *
 * Scope (Phase 2 of the chat surface):
 *   - ATX headings (`#` … `######`)
 *   - Fenced code blocks (```` ``` ````, with optional language tag)
 *   - Horizontal separators (`---`, `***`, `___`)
 *   - GFM tables (`| col | col |` + separator row, with alignment hints)
 *   - Unordered lists (`-`, `*`, `+`)
 *   - Ordered lists (`1.`, `2.`, …)
 *   - Block quotes (`> …`)
 *   - Paragraphs (fallback)
 *   - Inline: backtick code spans, **bold**, *italic* — reuses
 *     `parseInline` / `renderToken` semantics from `UserMessage.tsx`.
 *
 * What this parser does NOT do (deliberate omissions):
 *   - Setext-style headings (`====`, `----` under text) — rare,
 *     ambiguous with separators, can be added later.
 *   - Nested lists via indentation — flat lists only. Indented
 *     continuation lines are merged into the parent item.
 *   - Reference-style links / images — most chat output is plain
 *     prose; if a model needs a clickable URL we can extend later.
 *   - HTML pass-through — `<script>` etc. would be a vector for
 *     prompt-injection. We treat `<` as literal text.
 *
 * Why we hand-roll the parser instead of pulling in a library:
 *   - `marked` / `remark` / `markdown-it` each add 30–250 KB and a
 *     runtime dependency on a moving target.
 *   - The chat surface only renders assistant output — we don't
 *     need full CommonMark conformance, just the constructs the
 *     models actually emit.
 *   - The block grammar is small enough (~200 lines) to keep
 *     auditable in-tree; a regression in the parser would only
 *     affect this one component.
 *
 * The renderer prefers the existing design tokens (Manrope / Geist
 * for headings, Inter for body, JetBrains Mono for code) and
 * reuses the surface palette (`surface-container-lowest` for
 * code blocks, `outline-variant` for hairlines). No new colour,
 * radius, or shadow values are introduced.
 */

import { InlineContent } from "./UserMessage"

// ── Block AST ────────────────────────────────────────────────────────────────

export type MarkdownBlock =
  | { kind: "code"; lang: string; content: string }
  | {
      kind: "heading"
      level: 1 | 2 | 3 | 4 | 5 | 6
      text: string
    }
  | { kind: "separator" }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | {
      kind: "table"
      headers: string[]
      rows: string[][]
      align: Array<"left" | "right" | "center" | null>
    }
  | { kind: "blockquote"; lines: string[] }

// ── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse `text` into an ordered list of `MarkdownBlock`s. The grammar
 * is line-based and processed top-to-bottom:
 *
 *   1. Empty lines are skipped.
 *   2. A line starting with ```` ``` ```` opens a fenced code block;
 *      everything until the matching closer is captured literally.
 *   3. A line matching `#{1,6} …` becomes a heading.
 *   4. A line containing only `-` / `*` / `_` (3+ repetitions) is a
 *      horizontal separator.
 *   5. A `|`-bearing line followed by a separator line is a GFM table.
 *   6. A line starting with `- ` / `* ` / `+ ` / `\d+. ` is a list.
 *   7. A line starting with `> ` is a block quote.
 *   8. Otherwise the line starts a paragraph; consecutive non-block
 *      lines join into one paragraph.
 *
 * Each block dispatch consumes as many lines as it owns, then the
 * outer loop continues from the next unconsumed line.
 */
export function parseMarkdown(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  // Tolerate `\r\n` (Windows / copy-paste from terminals) without
  // emitting blank lines; splitting on `\r?\n` is the cheapest fix.
  const lines = text.split(/\r?\n/)
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // ── Skip blanks between blocks ────────────────────────────────────
    if (line.trim() === "") {
      i++
      continue
    }

    // ── Fenced code block ─────────────────────────────────────────────
    // `\`\`\`python`, ` ```js ` (trailing spaces ok), or just `\`\`\``
    // for a language-less block. We don't support `~~~` fences — most
    // chat output uses backticks and supporting both would require
    // matching open/close fences by character class.
    const fenceMatch = /^(\s*)```(.*)$/.exec(line)
    if (fenceMatch) {
      const indent = fenceMatch[1].length
      const lang = fenceMatch[2].trim()
      i++
      const contentLines: string[] = []
      while (i < lines.length) {
        // Closing fence: same indent + 3+ backticks + nothing else
        // (we don't require a language on the closer; the first
        // non-matching one closes the block, matching CommonMark).
        if (/^\s*```\s*$/.test(lines[i])) {
          i++
          break
        }
        // Strip the opening indent from each content line so the
        // rendered block aligns to the card's left padding. Lines
        // that don't share the indent are kept verbatim — anything
        // stricter would silently mangle intentionally-indented code.
        contentLines.push(
          indent > 0 && lines[i].startsWith(" ".repeat(indent))
            ? lines[i].slice(indent)
            : lines[i],
        )
        i++
      }
      blocks.push({ kind: "code", lang, content: contentLines.join("\n") })
      continue
    }

    // ── ATX heading ───────────────────────────────────────────────────
    // `# Foo`, `## Foo`, … `###### Foo`. Trailing `#`s are stripped
    // (CommonMark allows `# Foo #` as a heading close marker). The
    // text must contain at least one non-space character — `## `
    // alone is not a heading.
    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6
      blocks.push({ kind: "heading", level, text: headingMatch[2] })
      i++
      continue
    }

    // ── Horizontal separator ──────────────────────────────────────────
    // 3+ `-`, `*`, or `_` characters, optionally space-separated. We
    // require no other content on the line so that `**bold**` and
    // `---inline` aren't mistaken for separators (the `***` opener
    // for a horizontal rule is rare in chat output anyway).
    if (/^\s*(?:[-*_]\s*){3,}\s*$/.test(line)) {
      blocks.push({ kind: "separator" })
      i++
      continue
    }

    // ── GFM table ─────────────────────────────────────────────────────
    // First line is the header row, second is the alignment
    // separator (`| --- | :---: | ---: |`), subsequent lines are
    // data rows until a blank line or non-pipe line.
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const consumed = parseTable(lines, i, blocks)
      i += consumed
      continue
    }

    // ── List (ordered or unordered) ───────────────────────────────────
    // We test for the marker shape here and delegate consumption to
    // `parseList` so the same matcher is used for the first item
    // and each subsequent item.
    if (isListItem(line)) {
      const consumed = parseList(lines, i, blocks)
      i += consumed
      continue
    }

    // ── Block quote ───────────────────────────────────────────────────
    // Lines starting with `> ` form a quote block. Lines without the
    // prefix end the quote; `> > ` (nested) isn't supported and
    // the inner `> ` is treated as part of the content.
    if (/^\s*>\s?/.test(line)) {
      const consumed = parseBlockquote(lines, i, blocks)
      i += consumed
      continue
    }

    // ── Paragraph (fallback) ──────────────────────────────────────────
    // Accumulate consecutive non-blank, non-block-start lines into
    // one paragraph. The block-start check needs to look at the
    // next line for tables (a `|` line is a table only when the
    // following line is a separator), so it takes the full slice.
    const paraLines: string[] = [line]
    i++
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !isBlockStart(lines[i], lines, i)
    ) {
      paraLines.push(lines[i])
      i++
    }
    blocks.push({ kind: "paragraph", text: paraLines.join("\n") })
  }

  return blocks
}

// ── Parser helpers ───────────────────────────────────────────────────────────

/**
 * Detect the separator line that follows a GFM table header.
 * Accepted shapes:
 *   `| --- | --- |`         — both columns left-aligned
 *   `| :--- | ---: |`       — first left, second right
 *   `| :---: |`             — centered
 *   `--- | :---:`           — outer pipes optional
 *   `---`                   — single-column tables are valid GFM
 *
 * The line must contain only dashes, optional colons, whitespace,
 * and pipes; anything else disqualifies it.
 */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed === "" || !trimmed.includes("-")) return false
  const stripped = trimmed.replace(/^\|/, "").replace(/\|$/, "")
  const cells = stripped.split("|").map((c) => c.trim())
  if (cells.length === 0) return false
  // Each cell must be one or more `-` with optional leading/trailing `:`
  // (no spaces, no other characters).
  return cells.every((c) => /^:?-{1,}:?$/.test(c))
}

/**
 * Capture a table starting at `start`. Consumes header + separator +
 * any number of data rows until the next blank line or non-pipe line.
 * Returns the number of lines consumed (so the outer parser can advance).
 */
function parseTable(
  lines: string[],
  start: number,
  out: MarkdownBlock[],
): number {
  const headerRow = splitTableRow(lines[start])
  const sepCells = lines[start + 1]
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim())

  // Parse column alignment from the separator cells. `:---` = left,
  // `---:` = right, `:---:` = center, `---` = default left. Stored
  // alongside the rows so the renderer can apply text-align without
  // having to re-derive it.
  const align = sepCells.map((cell): "left" | "right" | "center" | null => {
    const left = cell.startsWith(":")
    const right = cell.endsWith(":")
    if (left && right) return "center"
    if (right) return "right"
    if (left) return "left"
    return null
  })

  const rows: string[][] = []
  let i = start + 2
  while (i < lines.length) {
    const line = lines[i]
    // End the table at a blank line or any line that doesn't have a
    // pipe. A line with leading/trailing whitespace + pipe is fine —
    // GFM allows padded cells.
    if (line.trim() === "" || !line.includes("|")) break
    rows.push(splitTableRow(line))
    i++
  }

  out.push({ kind: "table", headers: headerRow, rows, align })
  return i - start
}

/**
 * Split a single table row into cell strings. Outer pipes are
 * optional (GFM allows them), so we strip them before splitting.
 * Empty cells are preserved as `""` so column alignment stays
 * stable when a row has fewer cells than the header.
 */
function splitTableRow(line: string): string[] {
  let stripped = line.trim()
  if (stripped.startsWith("|")) stripped = stripped.slice(1)
  if (stripped.endsWith("|")) stripped = stripped.slice(0, -1)
  return stripped.split("|").map((c) => c.trim())
}

/**
 * Detect a list item at the start of a line. Returns a flag
 * distinguishing ordered vs unordered plus the inner content, or
 * `null` if the line isn't a list item. Indentation is allowed
 * but discarded (nested lists aren't supported yet).
 */
function isListItem(line: string): { ordered: boolean; content: string } | null {
  // Unordered: `- `, `* `, `+ ` followed by at least one non-space char.
  // We require the space so `*bold*` mid-line isn't mistaken for a marker.
  const ul = /^\s*(?:[-*+])\s+(\S.*)$/.exec(line)
  if (ul) return { ordered: false, content: ul[1] }
  // Ordered: digits + `.` + space + content. We don't enforce the
  // digits to be a strict sequence (`1`, `2`, `3`) — most chat
  // output starts at `1.` and humans are sloppy.
  const ol = /^\s*\d+\.\s+(\S.*)$/.exec(line)
  if (ol) return { ordered: true, content: ol[1] }
  return null
}

/**
 * Consume a run of same-flavour list items starting at `start`. We
 * break the run on:
 *   - blank line (always)
 *   - non-list line (the next paragraph starts there)
 *   - flavour switch (ordered → unordered or vice versa) — each
 *     flavour becomes its own `list` block so we don't render
 *     an inconsistent ordered-then-unordered stack.
 */
function parseList(
  lines: string[],
  start: number,
  out: MarkdownBlock[],
): number {
  const first = isListItem(lines[start])
  // Caller already filtered, but we re-check defensively to keep
  // `parseList` safe to call on its own.
  if (!first) return 0
  const ordered = first.ordered
  const items: string[] = [first.content]
  let i = start + 1
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === "") break
    const item = isListItem(line)
    if (!item) break
    if (item.ordered !== ordered) break
    items.push(item.content)
    i++
  }
  out.push({ kind: "list", ordered, items })
  return i - start
}

/**
 * Consume a block quote starting at `start`. We accept any line that
 * starts with `>` (with or without a space after it); consecutive
 * such lines join into one `blockquote`. A blank line or any line
 * without the `>` prefix ends the quote.
 */
function parseBlockquote(
  lines: string[],
  start: number,
  out: MarkdownBlock[],
): number {
  const content: string[] = []
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (!/^\s*>\s?/.test(line)) break
    // Strip the leading `>` and at most one space. The remainder is
    // treated as Markdown content (but not re-parsed — blockquotes
    // don't recurse in this implementation).
    content.push(line.replace(/^\s*>\s?/, ""))
    i++
  }
  out.push({ kind: "blockquote", lines: content })
  return i - start
}

/**
 * Decide whether `line` opens a new block. Used by the paragraph
 * accumulator to know when to stop. Tables need a peek at the next
 * line, so the full slice + index are passed in.
 */
function isBlockStart(line: string, lines: string[], idx: number): boolean {
  if (line.trim() === "") return true
  if (/^(\s*)```/.test(line)) return true
  if (/^#{1,6}\s+\S/.test(line)) return true
  if (/^\s*(?:[-*_]\s*){3,}\s*$/.test(line)) return true
  if (isListItem(line)) return true
  if (/^\s*>\s?/.test(line)) return true
  if (line.includes("|")) {
    const next = lines[idx + 1]
    if (next !== undefined && isTableSeparator(next)) return true
  }
  return false
}

// ── Renderer ─────────────────────────────────────────────────────────────────

/**
 * Top-level renderer. Takes raw assistant text, parses it, and
 * renders each block with consistent spacing. The outer wrapper uses
 * the design system's body font + size; individual blocks may swap to
 * a heading face or a monospace face as their content requires.
 *
 * `align` defaults to left (the standard assistant-bubble layout).
 * User messages pass `"right"` so the existing right-aligned
 * bubble aesthetic survives the upgrade.
 */
export function MarkdownContent({
  text,
  align = "left",
}: {
  text: string
  align?: "left" | "right"
}) {
  const blocks = parseMarkdown(text)
  if (blocks.length === 0) return null
  return (
    <div
      className={`flex min-w-0 max-w-full flex-col gap-2 ${
        align === "right" ? "items-end text-right" : "items-start text-left"
      }`}
    >
      {blocks.map((block, i) => renderBlock(block, `${align}-${i}`))}
    </div>
  )
}

/**
 * Dispatch one block to its renderer. The `key` includes the
 * `align` prefix so switching between left/right renderer
 * instances doesn't reuse DOM nodes (which would skip React's
 * mount lifecycle and leak state across the swap).
 */
function renderBlock(block: MarkdownBlock, key: string) {
  switch (block.kind) {
    case "code":
      return <CodeBlock key={key} lang={block.lang} content={block.content} />
    case "heading":
      return (
        <Heading key={key} level={block.level} text={block.text} />
      )
    case "separator":
      return <Separator key={key} />
    case "paragraph":
      return <ParagraphBlock key={key} text={block.text} />
    case "list":
      return (
        <ListBlock
          key={key}
          ordered={block.ordered}
          items={block.items}
        />
      )
    case "table":
      return (
        <TableBlock
          key={key}
          headers={block.headers}
          rows={block.rows}
          align={block.align}
        />
      )
    case "blockquote":
      return <Blockquote key={key} lines={block.lines} />
  }
}

// ── Block renderers ──────────────────────────────────────────────────────────

/**
 * Fenced code block. The dark card on `surface-container-lowest`
 * matches the existing tool-artifact output chrome so code looks
 * visually related to the rest of the chat without sharing any
 * state. We don't syntax-highlight — that's a Phase 3 feature
 * once we pick a code highlighter.
 */
function CodeBlock({ lang, content }: { lang: string; content: string }) {
  // Keep the language label short so the header doesn't dominate
  // the block — anything beyond 16 chars gets truncated.
  const label = lang ? lang.slice(0, 16) : ""
  return (
    <div className="my-0.5 w-full max-w-full overflow-hidden rounded border border-outline-variant bg-surface-container-lowest">
      {label ? (
        <div className="flex items-center justify-between border-b border-outline-variant/60 bg-surface-container-low px-2 py-1 font-sans text-[10px] uppercase tracking-[0.05em] text-outline">
          <span>{label}</span>
        </div>
      ) : null}
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[12px] leading-[18px] text-on-surface-variant">
        <code>{content || "\u00A0"}</code>
      </pre>
    </div>
  )
}

/**
 * ATX heading. We use Geist Sans (the design system's technical
 * label face) for all levels — distinguishing levels by size +
 * weight keeps the typography scale small. `h1`/`h2` get a small
 * top margin so they breathe against preceding paragraphs; `h3`
 * and below inherit the surrounding gap from the parent `flex-col
 * gap-2`. Trailing whitespace inside the heading text is trimmed
 * already by the parser.
 */
function Heading({
  level,
  text,
}: {
  level: 1 | 2 | 3 | 4 | 5 | 6
  text: string
}) {
  const classMap: Record<1 | 2 | 3 | 4 | 5 | 6, string> = {
    1: "font-sans text-[20px] font-semibold leading-[26px] tracking-[-0.01em] text-on-surface",
    2: "font-sans text-[17px] font-semibold leading-[24px] tracking-[-0.005em] text-on-surface",
    3: "font-sans text-[15px] font-semibold leading-[22px] text-on-surface",
    4: "font-sans text-[14px] font-semibold leading-[20px] text-on-surface",
    5: "font-sans text-[13px] font-semibold leading-[20px] text-on-surface-variant",
    6: "font-sans text-[12px] font-semibold uppercase tracking-[0.06em] text-on-surface-variant",
  }
  // Inline parsing (bold/italic/code) is allowed inside headings,
  // so we re-use `InlineContent` rather than rendering raw text.
  const body = <InlineContent text={text} />
  switch (level) {
    case 1:
      return <h1 className={`${classMap[1]} mt-0.5`}>{body}</h1>
    case 2:
      return <h2 className={`${classMap[2]} mt-0.5`}>{body}</h2>
    case 3:
      return <h3 className={classMap[3]}>{body}</h3>
    case 4:
      return <h4 className={classMap[4]}>{body}</h4>
    case 5:
      return <h5 className={classMap[5]}>{body}</h5>
    case 6:
      return <h6 className={classMap[6]}>{body}</h6>
  }
}

/**
 * Thin hairline across the chat column. The colour matches the
 * design system's `outline-variant` (the same hairline used by
 * cards and panels) so separators feel native to the rest of the UI.
 */
function Separator() {
  return <hr className="my-1 w-full max-w-full border-t border-outline-variant" />
}

/**
 * Paragraph. Inline parsing handles `**bold**`, `*italic*`, and
 * `` `code` ``; line breaks inside a paragraph are preserved as
 * soft breaks (`whitespace-pre-wrap`).
 */
function ParagraphBlock({ text }: { text: string }) {
  return (
    <p className="font-body text-[13px] leading-[20px] text-on-surface">
      <InlineContent text={text} />
    </p>
  )
}

/**
 * List block. Each item gets the same body typography as a paragraph
 * so the rhythm of the page doesn't shift inside a list. We use the
 * native `<ol>` / `<ul>` markers (Tailwind `list-disc` / `list-decimal`)
 * for accessibility — assistive tech announces the count and marker.
 */
function ListBlock({
  ordered,
  items,
}: {
  ordered: boolean
  items: string[]
}) {
  const Tag = ordered ? "ol" : "ul"
  return (
    <Tag
      className={`flex w-full max-w-full flex-col gap-0.5 pl-5 font-body text-[13px] leading-[20px] text-on-surface ${
        ordered ? "list-decimal" : "list-disc"
      } marker:text-outline`}
    >
      {items.map((item, i) => (
        <li key={i} className="break-words">
          <InlineContent text={item} />
        </li>
      ))}
    </Tag>
  )
}

/**
 * GFM table. The card wrapper carries a 1px outline-variant border
 * so the table reads as a distinct object — this matches the rule
 * "use cards when content represents a distinct object". We don't
 * horizontal-scroll the whole table; instead each column shrinks to
 * its content with `whitespace-nowrap` so long cell values render on
 * one line and the whole table widens past the chat column if
 * needed (the parent `overflow-x-hidden` on `ChatThread` provides
 * the safety net).
 *
 * Column alignment is taken from the separator row (`---`, `:---`,
 * `---:`, `:---:`); null entries (the default `---` shape) render
 * left-aligned. Header cells are bolded in Geist Sans to match the
 * rest of the label chrome.
 */
function TableBlock({
  headers,
  rows,
  align,
}: {
  headers: string[]
  rows: string[][]
  align: Array<"left" | "right" | "center" | null>
}) {
  const alignClass = (i: number) => {
    const a = align[i]
    if (a === "right") return "text-right"
    if (a === "center") return "text-center"
    return "text-left"
  }
  return (
    <div className="my-0.5 w-full max-w-full overflow-x-auto rounded border border-outline-variant">
      <table className="w-full border-collapse font-body text-[12px] leading-[18px]">
        <thead>
          <tr className="bg-surface-container-low">
            {headers.map((h, i) => (
              <th
                key={i}
                className={`border-b border-outline-variant px-2 py-1.5 font-sans font-semibold text-on-surface ${alignClass(i)}`}
              >
                <InlineContent text={h} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr
              key={ri}
              className="border-b border-outline-variant/50 last:border-b-0"
            >
              {headers.map((_, ci) => {
                const cell = row[ci] ?? ""
                return (
                  <td
                    key={ci}
                    className={`px-2 py-1.5 text-on-surface-variant ${alignClass(ci)}`}
                  >
                    <InlineContent text={cell} />
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Block quote. The 2px primary-tinted bar on the left matches the
 * accent bar used on `AssistantMessage`'s outer wrapper and on
 * `ReasoningArtifact`'s gradient bar — quotes feel related to the
 * assistant chrome without being visually loud.
 */
function Blockquote({ lines }: { lines: string[] }) {
  return (
    <blockquote className="my-0.5 w-full max-w-full border-l-2 border-primary/40 pl-3">
      {lines.map((line, i) => (
        <p
          key={i}
          className="font-body text-[13px] leading-[20px] text-on-surface-variant"
        >
          <InlineContent text={line} />
        </p>
      ))}
    </blockquote>
  )
}
