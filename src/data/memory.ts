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
