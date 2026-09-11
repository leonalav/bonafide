/**
 * ruff-linter.ts — Ruff integration for Bonafide.
 *
 * Two ways ruff is exposed to the editor:
 *
 *  1. **LSP server** (preferred): ruff-lsp runs as a child process via the
 *     Rust LSP bridge. This gives real-time diagnostics as the user types.
 *     Configured by mounting the LSP plugin with `languageId: "python"`
 *     and the ruff client (see `lsp-client.ts`).
 *
 *  2. **CLI runner** (fallback / "Format Document"): invoke `ruff check`
 *     directly via Tauri IPC and surface the JSON diagnostics. Used for
 *     one-shot runs and `ruff format --check`.
 *
 * This module handles the second path — running ruff on a file and
 * returning its diagnostics. The first path is automatic when the
 * `languageServer` extension is mounted with the ruff LSP client.
 */

import { invoke, isTauri } from "@tauri-apps/api/core"
import type { DomainDiagnostic } from "./diagnostics"

/** Subset of ruff's JSON diagnostic format (the fields we use). */
export type RuffDiagnostic = {
  code?: string | null
  message: string
  location: {
    row: number // 1-based
    column: number // 0-based
  }
  end_location?: {
    row: number
    column: number
  } | null
  fix?: unknown
  severity?: string
}

/** Run `ruff check` on a file via the Tauri backend. */
export async function ruffCheck(absPath: string): Promise<RuffDiagnostic[]> {
  if (!isTauri()) return []
  try {
    const json = await invoke<string>("ruff_check", { filePath: absPath })
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed as RuffDiagnostic[]
  } catch (err) {
    console.error("[ruff] check failed:", err)
    return []
  }
}

/**
 * Convert ruff's 1-based row / 0-based column to 1-based line / col.
 * Used to populate DomainDiagnostic.line / DomainDiagnostic.col so that
 * the Problems panel can display the correct line number.
 */
export function ruffLocationToLineCol(
  loc: { row: number column: number } | undefined | null,
): { line: number col: number } {
  if (!loc) return { line: 0, col: 0 }
  return { line: loc.row, col: loc.column + 1 }
}

/**
 * Convert ruff's 1-based row / 0-based column line/column to CodeMirror
 * document offsets. We use the document's line indexing and assume the
 * file content matches what was passed to ruff.
 */
export function ruffToCodeMirror(
  docs: RuffDiagnostic[],
  content: string,
): DomainDiagnostic[] {
  const lineStarts = computeLineStarts(content)
  const result: DomainDiagnostic[] = []
  for (const d of docs) {
    const startLine = Math.max(
      0,
      Math.min(d.location.row - 1, lineStarts.length - 1),
    )
    const endLine = d.end_location
      ? Math.max(0, Math.min(d.end_location.row - 1, lineStarts.length - 1))
      : startLine
    const fromOffset = (lineStarts[startLine] ?? 0) + (d.location.column ?? 0)
    let toOffset: number
    if (d.end_location) {
      if (endLine === startLine) {
        toOffset =
          fromOffset + ((d.end_location.column ?? 0) - (d.location.column ?? 0))
      } else {
        toOffset = lineStarts[endLine] + (d.end_location.column ?? 0)
      }
    } else {
      // Default: highlight the whole rest of the line (ruff's `end_location`
      // is optional and many rules don't set it).
      const lineEnd = content.indexOf("\n", fromOffset)
      toOffset = lineEnd === -1 ? content.length : lineEnd
    }

    const { line, col } = ruffLocationToLineCol(d.location)

    result.push({
      from: fromOffset,
      to: toOffset,
      line,
      col,
      severity: "error",
      message: d.code ? `${d.code}: ${d.message}` : d.message,
      source: "ruff",
    })
  }
  return result
}

/** O(N) scan: build an array of line-start offsets. */
function computeLineStarts(content: string): number[] {
  const starts: number[] = [0]
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") starts.push(i + 1)
  }
  return starts
}

/**
 * High-level helper: run ruff on a file and return ready-to-use domain
 * diagnostics. The caller passes the *current* editor content so we
 * compute offsets accurately. If the file has been edited since ruff
 * ran, the diagnostics will be slightly off — that's fine, the LSP path
 * takes over for live edits anyway.
 */
export async function ruffCheckAsDomain(
  absPath: string,
  content: string,
): Promise<DomainDiagnostic[]> {
  const raw = await ruffCheck(absPath)
  return ruffToCodeMirror(raw, content)
}
