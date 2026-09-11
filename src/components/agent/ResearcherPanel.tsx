/**
 * ResearcherPanel — arXiv search surface.
 *
 * Powers the "Researcher" mode UI: a debounced search box backed by
 * `bonafide.agent.searchArxiv`, a results list with title / authors /
 * published date / abstract preview, and a detail modal that fetches
 * the full paper via `getArxivPaper` on click.
 *
 * Spec sections:
 *   - §9.3  — Researcher mode UI shows results inline so the user
 *             can validate the LLM's evidence.
 *   - §9.4  — PDF link goes to arxiv.org/abs/<id>; we open in the
 *             system browser via `shell.openExternal`.
 *
 * The input is debounced (~300ms) so a fast typist doesn't fire one
 * IPC call per keystroke. In-flight searches are cancelled when a
 * newer search begins so the list never displays stale results.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"
import { Icon } from "../ui/Icon"
import { Button } from "../ui/primitives"
import { bonafide } from "../../ipc/tauri"
import type { ArxivPaper } from "../../ipc/tauri"

// ── Search debounce ──────────────────────────────────────────────────────────

const DEBOUNCE_MS = 300
const MAX_RESULTS = 20

// ── Date formatting ──────────────────────────────────────────────────────────

/** Format the ISO-8601 published string from arXiv as "Mar 12, 2024". */
function formatPublished(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

/** Truncate abstract for the result card preview (full text in the modal). */
function previewAbstract(abstract: string, max = 220): string {
  if (abstract.length <= max) return abstract
  return `${abstract.slice(0, max).trimEnd()}…`
}

// ── Detail modal ─────────────────────────────────────────────────────────────

function PaperDetailModal({
  paper,
  onClose,
}: {
  paper: ArxivPaper | null
  onClose: () => void
}) {
  if (!paper) return null
  const pdfUrl = paper.pdfUrl || `https://arxiv.org/pdf/${paper.id}`
  const absUrl = `https://arxiv.org/abs/${paper.id}`

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-background/70 px-4 py-8"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface-container-low shadow-xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-outline-variant p-4">
          <div className="flex-1">
            <h2 className="font-body text-[16px] font-medium leading-snug text-on-surface">
              {paper.title}
            </h2>
            <p className="mt-1 font-body text-[12px] text-on-surface-variant">
              {paper.authors.join(", ")}
            </p>
            <p className="mt-1 font-sans text-[11px] text-outline">
              arXiv:{paper.id} · {formatPublished(paper.published)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
          >
            <Icon name="x" size={14} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          <h3 className="label-caps mb-1 text-on-surface-variant">Abstract</h3>
          <p className="whitespace-pre-wrap font-body text-[13px] leading-[20px] text-on-surface">
            {paper.abstract}
          </p>
          {paper.categories.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {paper.categories.map((cat) => (
                <span
                  key={cat}
                  className="rounded bg-surface-container px-1.5 py-0.5 font-sans text-[10px] text-on-surface-variant"
                >
                  {cat}
                </span>
              ))}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-outline-variant p-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void bonafide.shell.openExternal(absUrl)}
          >
            <Icon name="external-link" size={11} />
            arXiv page
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void bonafide.shell.openExternal(pdfUrl)}
          >
            <Icon name="download" size={11} />
            PDF
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

// ── Result card ──────────────────────────────────────────────────────────────

function ResultCard({
  paper,
  onOpen,
}: {
  paper: ArxivPaper
  onOpen: () => void
}) {
  const authorPreview =
    paper.authors.length <= 3
      ? paper.authors.join(", ")
      : `${paper.authors.slice(0, 3).join(", ")} +${paper.authors.length - 3} more`
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-1.5 rounded-lg border border-outline-variant bg-surface-container-low p-3 text-left transition-colors hover:border-outline hover:bg-surface-container"
    >
      <h3 className="font-body text-[14px] font-medium leading-snug text-on-surface">
        {paper.title}
      </h3>
      <p className="font-body text-[12px] text-on-surface-variant">
        {authorPreview}
      </p>
      <p className="font-body text-[12px] leading-[18px] text-on-surface-variant">
        {previewAbstract(paper.abstract)}
      </p>
      <div className="mt-1 flex items-center gap-2">
        <span className="font-sans text-[10px] text-outline">
          {formatPublished(paper.published)}
        </span>
        <span className="font-sans text-[10px] text-outline">·</span>
        <span className="font-sans text-[10px] text-outline">
          {paper.categories.slice(0, 3).join(" · ")}
          {paper.categories.length > 3 ? " …" : ""}
        </span>
      </div>
    </button>
  )
}

// ── Main panel ──────────────────────────────────────────────────────────────

export function ResearcherPanel({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [results, setResults] = useState<ArxivPaper[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activePaper, setActivePaper] = useState<ArxivPaper | null>(null)

  // Track the in-flight request so out-of-order responses can't
  // overwrite fresher results (race condition: slow response for
  // query "a" arriving after fast response for query "ab").
  const inFlightRef = useRef(0)

  // Debounce the input — fires `debouncedQuery` ~300ms after the last
  // keystroke. A pending timer is cleared on every change.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedQuery(query.trim())
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [query])

  const fetchResults = useCallback(async (q: string) => {
    if (!q) {
      setResults([])
      setError(null)
      setLoading(false)
      return
    }
    const ticket = ++inFlightRef.current
    setLoading(true)
    setError(null)
    try {
      const out = await bonafide.agent.searchArxiv(q, MAX_RESULTS)
      if (ticket !== inFlightRef.current) return // a newer search won
      setResults(out.results)
    } catch (err) {
      if (ticket !== inFlightRef.current) return
      setError(err instanceof Error ? err.message : String(err))
      setResults([])
    } finally {
      if (ticket === inFlightRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchResults(debouncedQuery)
  }, [debouncedQuery, fetchResults])

  const handleOpen = useCallback(async (paper: ArxivPaper) => {
    // Optimistic: open the modal immediately with the card data so the
    // user sees something without a network round-trip. We then re-fetch
    // the full record to upgrade the abstract + categories.
    setActivePaper(paper)
    try {
      const full = await bonafide.agent.getArxivPaper(paper.id)
      setActivePaper(full)
    } catch (err) {
      // Keep the card data if the detail fetch fails — better than
      // dropping the modal entirely.
      console.warn("[ResearcherPanel] getArxivPaper failed:", err)
    }
  }, [])

  const hint = useMemo(() => {
    if (loading) return "Searching…"
    if (error) return null
    if (!debouncedQuery) return "Search arXiv to find papers."
    if (results.length === 0) return "No results — try different terms."
    return `${results.length} result${results.length === 1 ? "" : "s"}`
  }, [loading, error, debouncedQuery, results.length])

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon name="search" size={16} className="text-primary" />
          <h1 className="font-body text-[16px] font-medium text-on-surface">
            Researcher
          </h1>
        </div>
        {onClose && (
          <Button variant="ghost" size="sm" onClick={onClose} title="Close">
            <Icon name="x" size={12} />
          </Button>
        )}
      </div>

      <p className="font-body text-[12px] text-on-surface-variant">
        Cross-reference papers for your experiments. Click a result to read
        the full abstract and open the PDF.
      </p>

      {/* Search bar */}
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant">
          <Icon name="search" size={14} />
        </span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search arXiv (e.g. 'transformer layer normalization')"
          className="w-full rounded-lg border border-outline-variant bg-surface-container py-2 pl-9 pr-9 font-body text-[13px] text-on-surface placeholder:text-outline focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setQuery("")}
            className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
          >
            <Icon name="x" size={12} />
          </button>
        )}
      </div>

      {/* Status row */}
      <div className="flex items-center justify-between">
        <span className="font-sans text-[11px] text-outline">
          {hint ?? <span className="text-error">{error}</span>}
        </span>
        {loading && (
          <Icon
            name="refresh"
            size={12}
            className="animate-spin text-on-surface-variant"
          />
        )}
      </div>

      {/* Results list */}
      <div className="flex-1 overflow-y-auto">
        {results.length > 0 && (
          <div className="flex flex-col gap-2">
            {results.map((paper) => (
              <ResultCard
                key={paper.id}
                paper={paper}
                onOpen={() => void handleOpen(paper)}
              />
            ))}
          </div>
        )}
      </div>

      <PaperDetailModal
        paper={activePaper}
        onClose={() => setActivePaper(null)}
      />
    </div>
  )
}
