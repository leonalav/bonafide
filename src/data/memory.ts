/**
 * memory.ts — TypeScript types for Project Memory.
 *
 * Mirrors the Rust `Insight`, `DeadEnd`, `MemoryEntry`, `WriteMemoryInput`
 * types from `src-tauri/src/agent/memory.rs`.
 *
 * Per Phase 3 spec (Section 9): Project Memory stores insights and dead-ends
 * that survive across sessions. Max 50 of each with FIFO eviction.
 */

export type MemoryKind = "insight" | "dead_end"

export type MemoryConfidence = "low" | "medium" | "high"

/** A confirmed finding from an experiment or investigation. */
export interface InsightEntry {
  id: string
  workspaceHash: string
  finding: string
  evidence: string
  confidence: MemoryConfidence
  sourceThread?: string
  sourceRuns?: string[]
  createdAt: number
  expiresAt?: number
}

/** A hypothesis that was tested and failed. */
export interface DeadEndEntry {
  id: string
  workspaceHash: string
  hypothesis: string
  evidence: string
  triedRuns?: string[]
  createdAt: number
}

/** Unified memory entry returned by query_project_memory. */
export type MemoryEntry = { kind: "insight" } & InsightEntry | {
  kind: "dead_end"
} & DeadEndEntry

/** Input for writing a new memory entry. */
export interface WriteMemoryInput {
  kind: MemoryKind
  finding?: string
  evidence?: string
  confidence?: MemoryConfidence
  hypothesis?: string
  sourceThread?: string
  sourceRuns?: string[]
  triedRuns?: string[]
}

/** Helper to build a new Insight with sensible defaults. */
export function makeInsight(params: {
  id: string
  workspaceHash: string
  finding: string
  evidence: string
  confidence?: MemoryConfidence
  sourceThread?: string
  sourceRuns?: string[]
}): InsightEntry {
  return {
    finding: "",
    evidence: "",
    confidence: "medium",
    createdAt: Date.now(),
    ...params,
  }
}

/** Helper to build a new DeadEnd with sensible defaults. */
export function makeDeadEnd(params: {
  id: string
  workspaceHash: string
  hypothesis: string
  evidence: string
  triedRuns?: string[]
}): DeadEndEntry {
  return {
    evidence: "",
    createdAt: Date.now(),
    ...params,
  }
}

// ── Critic / Code Review types ──────────────────────────────────────────────

/** Result of a critic code review. */
export interface CriticReview {
  score: number
  issues: string[]
  recommendations: string[]
  verdict: "pass" | "fail" | "skip"
  summary: string
  durationMs?: number
}

// ── Anomaly detection types ────────────────────────────────────────────────

/** A detected anomaly in a run metric. */
export interface AnomalyEntry {
  metric: string
  kind: "spike" | "drop" | "plateau" | "drift"
  description: string
  severity: "low" | "medium" | "high"
  step: number
  value: number
}

/** Result of anomaly detection on a run. */
export interface AnomalyReport {
  runId: string
  anomalies: AnomalyEntry[]
  summary: string
}

// ── Project memory query result types ─────────────────────────────────────

/** A project insight from memory. */
export interface ProjectInsight {
  id: string
  workspaceHash: string
  finding: string
  evidence: string
  confidence: MemoryConfidence
  createdAt: number
}

/** A project dead-end from memory. */
export interface ProjectDeadEnd {
  id: string
  workspaceHash: string
  hypothesis: string
  evidence: string
  triedRuns?: string[]
  createdAt: number
}

// ── ArXiv types ────────────────────────────────────────────────────────────

/** A single paper from an ArXiv search. */
export interface ArxivPaper {
  id: string
  title: string
  authors: string[]
  abstract: string
  published: string
  categories: string[]
  pdfUrl: string
}

/** Result of an ArXiv search. */
export interface ArxivSearchResult {
  query: string
  results: ArxivPaper[]
  totalResults: number
}
