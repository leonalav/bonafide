/**
 * researcher.ts — TypeScript types for the Researcher Mode.
 *
 * Mirrors the Rust `ArxivPaper`, `ArxivSearchResult`, `ArxivError`
 * types from `src-tauri/src/agent/researcher.rs`.
 */

export interface ArxivPaper {
  id: string
  title: string
  authors: string[]
  abstract: string
  publishedAt: number
  updatedAt: number
  pdfUrl: string
  categories: string[]
}

export interface ArxivSearchResult {
  papers: ArxivPaper[]
  totalResults: number
  startIndex: number
  itemsPerPage: number
}

export type ArxivError = { kind: "network_error" message: string } | {
  kind: "parse_error"
  message: string
} | { kind: "not_found" id: string } | { kind: "rate_limited" } | {
  kind: "invalid_id"
  id: string
}

/** Parse an arXiv ID from various formats (client-side validation). */
export function parseArxivId(input: string): string | null {
  const trimmed = input.trim()

  // Check for numeric ID with optional version
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(trimmed)) {
    return trimmed.split("v")[0]
  }

  // Check for URL formats
  const urlMatch = trimmed.match(
    /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?/,
  )
  if (urlMatch) {
    return urlMatch[1]
  }

  return null
}

/** Format paper for display in the agent response. */
export function formatPaperForDisplay(paper: ArxivPaper): string {
  const authors = paper.authors.slice(0, 3).join(", ")
  const extra =
    paper.authors.length > 3 ? ` +${paper.authors.length - 3} more` : ""
  const date = new Date(paper.publishedAt * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
  })

  return [
    `**${paper.title}**`,
    "",
    `Authors: ${authors}${extra}`,
    `Published: ${date}`,
    `Categories: ${paper.categories.slice(0, 3).join(", ")}`,
    `arXiv: ${paper.id}`,
    "",
    paper.abstract.slice(0, 300) + (paper.abstract.length > 300 ? "..." : ""),
    "",
    `[PDF](${paper.pdfUrl}) | [arXiv](https://arxiv.org/abs/${paper.id})`,
  ].join("\n")
}
