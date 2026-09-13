/**
 * src/components/chat/__tests__/MarkdownContent.test.tsx
 *
 * Block-level parser tests for the Markdown / GFM renderer used by
 * AssistantMessage and UserMessage. These cover the AST shapes
 * produced by `parseMarkdown` — the renderer is exercised
 * indirectly by the snapshot-free inline-token tests in
 * `UserMessage.test.ts` (future work) and is covered here only for
 * the structural smoke checks.
 *
 * Tests are grouped by block kind so a regression in one grammar
 * path points at a single, named file section.
 */

import { describe, expect, it } from "vitest"

import {
  parseMarkdown,
  type MarkdownBlock,
} from "../MarkdownContent"

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Find the first block of a given kind in a parse result. */
function firstBlock<T extends MarkdownBlock["kind"]>(
  blocks: MarkdownBlock[],
  kind: T,
): Extract<MarkdownBlock, { kind: T }> | undefined {
  return blocks.find((b): b is Extract<MarkdownBlock, { kind: T }> => b.kind === kind)
}

function blockKinds(blocks: MarkdownBlock[]): MarkdownBlock["kind"][] {
  return blocks.map((b) => b.kind)
}

// ── Empty / degenerate input ────────────────────────────────────────────────

describe("parseMarkdown — degenerate input", () => {
  it("returns no blocks for an empty string", () => {
    expect(parseMarkdown("")).toEqual([])
  })

  it("skips leading and trailing blank lines", () => {
    const blocks = parseMarkdown("\n\nhello\n\n")
    expect(blockKinds(blocks)).toEqual(["paragraph"])
    expect((blocks[0] as Extract<MarkdownBlock, { kind: "paragraph" }>).text).toBe(
      "hello",
    )
  })

  it("collapses consecutive blank lines between paragraphs", () => {
    const blocks = parseMarkdown("one\n\n\n\ntwo")
    expect(blockKinds(blocks)).toEqual(["paragraph", "paragraph"])
  })
})

// ── Headings ─────────────────────────────────────────────────────────────────

describe("parseMarkdown — headings", () => {
  it.each([
    [1, "# Foo"],
    [2, "## Foo"],
    [3, "### Foo"],
    [4, "#### Foo"],
    [5, "##### Foo"],
    [6, "###### Foo"],
  ])("recognises ATX heading level %i", (level, input) => {
    const blocks = parseMarkdown(input)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.kind).toBe("heading")
    if (blocks[0]?.kind === "heading") {
      expect(blocks[0].level).toBe(level)
      expect(blocks[0].text).toBe("Foo")
    }
  })

  it("strips trailing # close markers", () => {
    const blocks = parseMarkdown("## Foo ##")
    expect(blocks[0]?.kind).toBe("heading")
    if (blocks[0]?.kind === "heading") {
      expect(blocks[0].text).toBe("Foo")
    }
  })

  it("does not treat a lone `#` or `## ` as a heading", () => {
    // `#` with no text → falls through to paragraph (CommonMark
    // renders it as a paragraph too). The test exists to lock
    // the parser's tolerant behaviour.
    const blocks = parseMarkdown("#\n")
    expect(blocks).toEqual([])
  })

  it("treats `####### Foo` as a paragraph (more than 6 #s)", () => {
    // 7+ #s are not a valid heading per the spec; the parser
    // falls through to paragraph rendering so the literal text
    // remains visible rather than being silently dropped.
    const blocks = parseMarkdown("####### Foo")
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.kind).toBe("paragraph")
    if (blocks[0]?.kind === "paragraph") {
      expect(blocks[0].text).toBe("####### Foo")
    }
  })
})

// ── Code blocks ──────────────────────────────────────────────────────────────

describe("parseMarkdown — fenced code blocks", () => {
  it("captures a fenced block with a language tag", () => {
    const blocks = parseMarkdown("```python\nprint('hi')\n```")
    const code = firstBlock(blocks, "code")
    expect(code).toBeDefined()
    if (code?.kind === "code") {
      expect(code.lang).toBe("python")
      expect(code.content).toBe("print('hi')")
    }
  })

  it("captures a language-less fenced block", () => {
    const blocks = parseMarkdown("```\nraw text\n```")
    const code = firstBlock(blocks, "code")
    expect(code?.kind).toBe("code")
    if (code?.kind === "code") {
      expect(code.lang).toBe("")
      expect(code.content).toBe("raw text")
    }
  })

  it("preserves multi-line content verbatim (no inline parsing)", () => {
    const src = "```js\nconst x = `*not italic*`\nconst y = **not bold**\n```"
    const blocks = parseMarkdown(src)
    const code = firstBlock(blocks, "code")
    if (code?.kind === "code") {
      // Inline tokens must survive verbatim inside code blocks.
      expect(code.content).toContain("`*not italic*`")
      expect(code.content).toContain("**not bold**")
    }
  })

  it("handles a code block that runs to end-of-input without closer", () => {
    const blocks = parseMarkdown("```\nlone block")
    // The closing fence is missing; the block still emits so the
    // user sees the raw code rather than a silent drop.
    expect(blockKinds(blocks)).toEqual(["code"])
  })

  it("emits an empty code block for back-to-back fences", () => {
    const blocks = parseMarkdown("```\n```")
    expect(blockKinds(blocks)).toEqual(["code"])
    const code = firstBlock(blocks, "code")
    if (code?.kind === "code") {
      expect(code.content).toBe("")
    }
  })
})

// ── Horizontal separator ────────────────────────────────────────────────────

describe("parseMarkdown — horizontal separator", () => {
  it.each(["---", "***", "___", "- - -", "* * *"])(
    "recognises `%s` as a separator",
    (line) => {
      const blocks = parseMarkdown(line)
      expect(blockKinds(blocks)).toEqual(["separator"])
    },
  )

  it("does not treat `--` or `**` as a separator (need 3+)", () => {
    // 2 dashes/asterisks are insufficient — must be 3+ to avoid
    // clashing with `**bold**` / `--` mid-line.
    expect(blockKinds(parseMarkdown("--"))).toEqual(["paragraph"])
    expect(blockKinds(parseMarkdown("**"))).toEqual(["paragraph"])
  })
})

// ── Tables ───────────────────────────────────────────────────────────────────

describe("parseMarkdown — GFM tables", () => {
  it("parses a header row + separator + data rows", () => {
    const src = [
      "| name | value |",
      "| --- | --- |",
      "| a | 1 |",
      "| b | 2 |",
    ].join("\n")
    const blocks = parseMarkdown(src)
    const table = firstBlock(blocks, "table")
    expect(table?.kind).toBe("table")
    if (table?.kind === "table") {
      expect(table.headers).toEqual(["name", "value"])
      expect(table.rows).toEqual([
        ["a", "1"],
        ["b", "2"],
      ])
      expect(table.align).toEqual([null, null])
    }
  })

  it("accepts tables without outer pipes", () => {
    const src = ["col1 | col2", "--- | ---", "x | y"].join("\n")
    const blocks = parseMarkdown(src)
    const table = firstBlock(blocks, "table")
    if (table?.kind === "table") {
      expect(table.headers).toEqual(["col1", "col2"])
      expect(table.rows).toEqual([["x", "y"]])
    }
  })

  it("parses column alignment hints from the separator row", () => {
    const src = [
      "| L | C | R |",
      "| :--- | :---: | ---: |",
      "| 1 | 2 | 3 |",
    ].join("\n")
    const blocks = parseMarkdown(src)
    const table = firstBlock(blocks, "table")
    if (table?.kind === "table") {
      expect(table.align).toEqual(["left", "center", "right"])
    }
  })

  it("ends the table at the first blank or non-pipe line", () => {
    const src = [
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "after",
    ].join("\n")
    const blocks = parseMarkdown(src)
    expect(blockKinds(blocks)).toEqual(["table", "paragraph"])
  })
})

// ── Lists ────────────────────────────────────────────────────────────────────

describe("parseMarkdown — lists", () => {
  it.each([
    ["- item", "unordered"],
    ["* item", "unordered"],
    ["+ item", "unordered"],
  ])("parses unordered list marker `%s` (%s)", (line) => {
    const blocks = parseMarkdown(line)
    const list = firstBlock(blocks, "list")
    expect(list?.kind).toBe("list")
    if (list?.kind === "list") {
      expect(list.ordered).toBe(false)
      expect(list.items).toEqual(["item"])
    }
  })

  it("parses ordered list with explicit numbers", () => {
    const blocks = parseMarkdown("1. one\n2. two\n3. three")
    const list = firstBlock(blocks, "list")
    if (list?.kind === "list") {
      expect(list.ordered).toBe(true)
      expect(list.items).toEqual(["one", "two", "three"])
    }
  })

  it("splits ordered and unordered flavours into separate blocks", () => {
    // A flavour switch mid-stream ends the current list and
    // opens a new one. The two are separate `list` blocks.
    const blocks = parseMarkdown("- a\n- b\n1. x\n2. y")
    const lists = blocks.filter((b) => b.kind === "list")
    expect(lists).toHaveLength(2)
    if (lists[0]?.kind === "list" && lists[1]?.kind === "list") {
      expect(lists[0].ordered).toBe(false)
      expect(lists[0].items).toEqual(["a", "b"])
      expect(lists[1].ordered).toBe(true)
      expect(lists[1].items).toEqual(["x", "y"])
    }
  })

  it("does not mistake `*italic*` for a list marker", () => {
    // Single `*` without a trailing space is the italic marker,
    // not a list bullet. Falls through to paragraph.
    const blocks = parseMarkdown("*italic* text")
    expect(blockKinds(blocks)).toEqual(["paragraph"])
  })

  it("does not treat `1.something` (no space) as a list item", () => {
    const blocks = parseMarkdown("1.something")
    expect(blockKinds(blocks)).toEqual(["paragraph"])
  })
})

// ── Block quotes ─────────────────────────────────────────────────────────────

describe("parseMarkdown — blockquotes", () => {
  it("parses consecutive `> ` lines as one blockquote", () => {
    const blocks = parseMarkdown("> line one\n> line two")
    const bq = firstBlock(blocks, "blockquote")
    expect(bq?.kind).toBe("blockquote")
    if (bq?.kind === "blockquote") {
      expect(bq.lines).toEqual(["line one", "line two"])
    }
  })

  it("accepts `>` with no trailing space", () => {
    const blocks = parseMarkdown(">quoted")
    expect(blockKinds(blocks)).toEqual(["blockquote"])
  })
})

// ── Paragraphs & mixed content ───────────────────────────────────────────────

describe("parseMarkdown — paragraphs", () => {
  it("joins consecutive non-block lines into one paragraph", () => {
    const blocks = parseMarkdown("hello\nworld")
    expect(blockKinds(blocks)).toEqual(["paragraph"])
    if (blocks[0]?.kind === "paragraph") {
      expect(blocks[0].text).toBe("hello\nworld")
    }
  })

  it("ends a paragraph at the first block-start line", () => {
    const blocks = parseMarkdown("intro text\n## Heading\nmore intro")
    expect(blockKinds(blocks)).toEqual(["paragraph", "heading", "paragraph"])
  })

  it("renders a realistic assistant reply with mixed blocks", () => {
    const src = [
      "Here's the rundown:",
      "",
      "### Metrics",
      "",
      "- accuracy: 0.92",
      "- loss: 0.31",
      "",
      "| epoch | loss |",
      "| :---: | :---: |",
      "| 1 | 0.7 |",
      "| 2 | 0.5 |",
      "",
      "```python",
      "model.fit(x, y)",
      "```",
      "",
      "---",
      "",
      "> Caveat: numbers are on a smoke split.",
    ].join("\n")
    const blocks = parseMarkdown(src)
    expect(blockKinds(blocks)).toEqual([
      "paragraph",
      "heading",
      "list",
      "table",
      "code",
      "separator",
      "blockquote",
    ])
    const heading = firstBlock(blocks, "heading")
    if (heading?.kind === "heading") {
      expect(heading.text).toBe("Metrics")
    }
    const list = firstBlock(blocks, "list")
    if (list?.kind === "list") {
      expect(list.items).toEqual(["accuracy: 0.92", "loss: 0.31"])
    }
    const table = firstBlock(blocks, "table")
    if (table?.kind === "table") {
      expect(table.align).toEqual(["center", "center"])
    }
    const code = firstBlock(blocks, "code")
    if (code?.kind === "code") {
      expect(code.lang).toBe("python")
      expect(code.content).toBe("model.fit(x, y)")
    }
  })
})

// ── Renderer smoke test ─────────────────────────────────────────────────────

/**
 * Minimal renderer smoke test. The renderer is intentionally simple
 * — one switch over the AST — so we only verify that each block
 * kind produces a non-null React node. The detailed rendering
 * (classes, attributes) is left to visual review + the existing
 * design-token review checklist in `DESIGN.md`.
 *
 * `react-dom/server` is already in the dep tree (it ships transitively
 * via `@vitejs/plugin-react`), so `renderToStaticMarkup` works in the
 * test runner without an explicit import in `package.json`.
 */
describe("MarkdownContent — renderer", () => {
  it("renders each block kind without crashing", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server")
    const React = await import("react")
    const { MarkdownContent } = await import("../MarkdownContent")
    const src = [
      "# H1",
      "",
      "paragraph with **bold** and `code`",
      "",
      "---",
      "",
      "- a",
      "- b",
      "",
      "1. one",
      "",
      "> quoted",
      "",
      "| h1 | h2 |",
      "| --- | --- |",
      "| v1 | v2 |",
      "",
      "```",
      "code body",
      "```",
    ].join("\n")
    const html = renderToStaticMarkup(
      React.createElement(MarkdownContent, { text: src }),
    )
    // Every supported block kind produced SOMETHING — guards
    // against a renderer that returns `null` for an unhandled
    // case.
    expect(html).toContain("<h1")
    expect(html).toContain("<hr")
    expect(html).toContain("<ul")
    expect(html).toContain("<ol")
    expect(html).toContain("<blockquote")
    expect(html).toContain("<table")
    expect(html).toContain("<pre")
    // Inline: bold + inline code
    expect(html).toContain("<strong>")
    expect(html).toContain("<code")
  })
})
