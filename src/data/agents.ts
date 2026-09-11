// Mock data for the Track A agent surface (Inspector Agent tab + Workflow inbox).

import type {
  ThreadRole,
  ThreadState as _ThreadState,
  ThreadBand as _ThreadBand,
} from "../ipc/tauri"

/** Display role enum for the Inspector Agent tab. Mirrors the IPC
 *  `ThreadRole` (lowercase snake_case from the Rust orchestrator) but
 *  keeps `AgentRole` as the friendly alias for code that prefers the
 *  historical capitalisation. */
export type AgentRole = ThreadRole

export const ROLE_META: Record<AgentRole, { icon: string glyph: string }> = {
  debugger: { icon: "search", glyph: "🔍" },
  scaffolder: { icon: "box", glyph: "🏗" },
  planner: { icon: "line-chart", glyph: "🗺" },
  researcher: { icon: "package", glyph: "📎" },
  critic: { icon: "alert-triangle", glyph: "⚖" },
}

export type TraceStep = {
  tool: string
  args: string
  result?: string
  time: string
}

export type Evidence = { text: string jump?: string }

export type Confidence = "Low" | "Medium" | "High"

export type Hypothesis = {
  verdict: string
  statement: string
  evidence: Evidence[]
  confidence: Confidence
  ruledOut?: string
}

export type PatchLine = { sign: " " | "+" | "-" text: string }

export type Verification = {
  status: "success" | "failed" | "running" | "none"
  lines: string[]
  upgrade?: string
}

export type Investigation = {
  runHash: string
  goal: string
  trace: TraceStep[]
  hypothesis: Hypothesis
  patch: { file: string summary: string lines: PatchLine[] }
  verification: Verification
}

// Tracks persisted by the orchestrator and rehydrated from SQLite.
// The renderer never instantiates these directly; they come back from
// the `list_threads` Tauri command in `data/threads.ts`.
export interface ThreadBase {
  id: string
  role: AgentRole
  title: string
  summary: string
  state: ThreadState
  detail: string
  /** Unix millis — `useThreads` formats relative labels from this. */
  updatedAt: number
  band: ThreadBand
  system?: boolean
}

// Re-exported from `ipc/tauri.ts` so the renderer's `Thread` type and
// the orchestrator's persisted row share one source of truth.
export type ThreadState = _ThreadState
export type ThreadBand = _ThreadBand

// Friendly labels for the Workflow inbox. Mirrors the renderer-side
// `THREAD_STATE_META` from earlier mock data; aligned to the Rust
// orchestrator's `ThreadState` enum (snake_case).
export const THREAD_STATE_META: Record<ThreadState, {
  label: string
  token: "tertiary" | "primary" | "error" | "outline"
  pulse?: boolean
}> = {
  idle: { label: "Idle", token: "outline" },
  investigating: { label: "Investigating", token: "tertiary", pulse: true },
  hypothesis_formed: { label: "Hypothesis formed", token: "primary" },
  patch_proposed: { label: "Patch proposed", token: "primary" },
  smoke_verifying: { label: "Verifying smoke", token: "tertiary", pulse: true },
  awaiting_approval: {
    label: "Awaiting approval",
    token: "primary",
    pulse: true,
  },
  full_run_verifying: {
    label: "Verifying full run",
    token: "tertiary",
    pulse: true,
  },
  resolved: { label: "Done", token: "outline" },
  rejected: { label: "Rejected", token: "outline" },
  stopped: { label: "Stopped", token: "outline" },
}

export type Thread = {
  id: string
  role: AgentRole
  title: string
  summary: string
  state: ThreadState
  detail: string
  /** Pre-formatted relative label (e.g. "12s ago"). Rendered as-is. */
  time: string
  /** Unix millis — `useThreads` derives `time` from this when rehydrating
   *  live rows; the mock stores both so the values stay in sync. */
  updatedAt: number
  band: ThreadBand
  system?: boolean
}

export const THREADS: Thread[] = [
  {
    id: "t1",
    role: "debugger",
    title: "Run a3f9c12 diverged?",
    summary: "val_loss plateau + LR spike — proposal ready",
    state: "awaiting_approval",
    detail: "1 hypothesis · 1 patch",
    time: "12s ago",
    updatedAt: Date.now() - 12_000,
    band: "active",
  },
  {
    id: "t2",
    role: "scaffolder",
    title: "Scaffold vision-finetune/",
    summary: "PyTorch + W&B scaffold + smoke test passing",
    state: "smoke_verifying",
    detail: "running 200 steps",
    time: "4m ago",
    updatedAt: Date.now() - 4 * 60_000,
    band: "active",
  },
  {
    id: "t3",
    role: "debugger",
    title: "Compare nova-7b vs orion-3b",
    summary: "Differential diagnosis across 2 runs — reading metrics",
    state: "investigating",
    detail: "3 tool calls",
    time: "6m ago",
    updatedAt: Date.now() - 6 * 60_000,
    band: "active",
  },
  {
    id: "t4",
    role: "debugger",
    title: "Loss spike last night",
    summary: "Suggested: re-enable grad clip — already tried (#47)",
    state: "awaiting_approval",
    detail: "rejected by project memory",
    time: "2h ago",
    updatedAt: Date.now() - 2 * 60 * 60_000,
    band: "awaiting_review",
    system: true,
  },
  {
    id: "t5",
    role: "debugger",
    title: "orion-3b failed at epoch 2",
    summary: "CUDA OOM — batch size / sequence length",
    state: "resolved",
    detail: "applied · gradient checkpointing",
    time: "yesterday",
    updatedAt: Date.now() - 24 * 60 * 60_000,
    band: "closed",
  },
  {
    id: "t6",
    role: "scaffolder",
    title: "Scaffold recommender/",
    summary: "JAX template + Hydra config",
    state: "resolved",
    detail: "applied",
    time: "2 days ago",
    updatedAt: Date.now() - 2 * 24 * 60 * 60_000,
    band: "closed",
  },
]

export const CLOSED_COUNT = 12

export type ConversationMessage = {
  author: "SYSTEM" | "AGENT" | "USER"
  body: string
  card?: boolean
}

export const CONVERSATION: ConversationMessage[] = [
  { author: "SYSTEM", body: "Thread opened from Run Inspector · 12s ago" },
  {
    author: "AGENT",
    body: "Reasoning trace + Hypothesis + Patch + Verification",
    card: true,
  },
  {
    author: "USER",
    body: "Looks right but try eta_min=1e-6, our other runs use that",
  },
  {
    author: "AGENT",
    body: "Hypothesis revision + new patch + new verification",
    card: true,
  },
  {
    author: "SYSTEM",
    body: "⚠ Note: project memory rules out eta_min=1e-4 from run 47.",
  },
  { author: "USER", body: "Apply." },
]

export type Template = {
  role: AgentRole
  title: string
  desc: string
  soon?: boolean
  emptyOnly?: boolean
  isDefault?: boolean
}

export const TEMPLATES: Template[] = [
  {
    role: "debugger",
    title: "Diagnose run divergence",
    desc: "Bind to a run, trace metrics vs the best prior run.",
    isDefault: true,
  },
  {
    role: "debugger",
    title: "Compare K runs",
    desc: "Multi-run differential diagnosis.",
  },
  {
    role: "scaffolder",
    title: "Start a new project from spec",
    desc: "Generate project structure and boilerplate code.",
  },
  {
    role: "planner",
    title: "Sequence experiments",
    desc: "Plan experiments across N runs with goals and budgets.",
  },
  {
    role: "researcher",
    title: "Cross-reference artifacts",
    desc: "Cross-reference artifacts / papers.",
    soon: true,
  },
]
