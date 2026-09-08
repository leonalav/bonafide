// Mock data for the Track A agent surface (Inspector Agent tab + Workflow inbox).

export type AgentRole = "Debugger" | "Scaffolder" | "Planner" | "Researcher";

export const ROLE_META: Record<AgentRole, { icon: string; glyph: string }> = {
  Debugger: { icon: "search", glyph: "🔍" },
  Scaffolder: { icon: "box", glyph: "🏗" },
  Planner: { icon: "line-chart", glyph: "🗺" },
  Researcher: { icon: "package", glyph: "📎" },
};

export type TraceStep = {
  tool: string;
  args: string;
  result?: string;
  time: string;
};

export type Evidence = { text: string; jump?: string };

export type Confidence = "Low" | "Medium" | "High";

export type Hypothesis = {
  verdict: string;
  statement: string;
  evidence: Evidence[];
  confidence: Confidence;
  ruledOut?: string;
};

export type PatchLine = { sign: " " | "+" | "-"; text: string };

export type Verification = {
  status: "success" | "failed" | "running" | "none";
  lines: string[];
  upgrade?: string;
};

export type Investigation = {
  runHash: string;
  goal: string;
  trace: TraceStep[];
  hypothesis: Hypothesis;
  patch: { file: string; summary: string; lines: PatchLine[] };
  verification: Verification;
};

// The featured investigation, reused by the Inspector tab and the Workflow detail view.
export const INVESTIGATION: Investigation = {
  runHash: "a3f9c12",
  goal: "Why did run a3f9c12 diverge at step 4000 while nova-7b held its val_loss?",
  trace: [
    {
      tool: "read_run_metrics",
      args: "a3f9c12",
      result: "lr_spike=true, val_loss plateau from step 3800",
      time: "12s ago",
    },
    { tool: "read_config", args: "a3f9c12", time: "11s ago" },
    { tool: "diff_runs", args: "a3f9c12, b4c8f30", time: "9s ago" },
    { tool: "read_code", args: '"train.py:L102-L160"', time: "7s ago" },
  ],
  hypothesis: {
    verdict: "Likely",
    statement: "Warmup schedule overlap with cosine decay caused an LR spike at the wrong step.",
    evidence: [
      { text: "a3f9c12:5000 lr=0.0042", jump: "metric" },
      { text: "a3f9c12 vs b4c8f30 — warmup config delta", jump: "diff" },
      { text: "train.py:L102 cosine.AnnealingWarmRestarts", jump: "code" },
    ],
    confidence: "Medium",
    ruledOut: "data issue (data hash matches prior)",
  },
  patch: {
    file: "train.py:L102",
    summary: "1 file · 2 lines",
    lines: [
      { sign: "+", text: "scheduler = CosineAnnealingLR(" },
      { sign: "+", text: "    T_max=epochs, eta_min=1e-5)" },
      { sign: "-", text: "scheduler = CosineAnnealingWarmRestarts(...)" },
    ],
  },
  verification: {
    status: "success",
    lines: [
      "Smoke run completed (200 steps, 3m 12s)",
      "val_loss trajectory: 0.51 → 0.42",
      "No LR spike at any step.",
    ],
    upgrade: "Medium → High",
  },
};

export type ThreadState =
  | "queued"
  | "investigating"
  | "hypothesis"
  | "awaiting"
  | "verifying"
  | "done"
  | "stuck";

export const THREAD_STATE_META: Record<ThreadState, { label: string; token: "tertiary" | "primary" | "error" | "outline"; pulse?: boolean }> = {
  queued: { label: "Queued", token: "outline" },
  investigating: { label: "Investigating", token: "tertiary", pulse: true },
  hypothesis: { label: "Hypothesis formed", token: "primary" },
  awaiting: { label: "Awaiting approval", token: "primary", pulse: true },
  verifying: { label: "Verifying smoke", token: "tertiary", pulse: true },
  done: { label: "Done", token: "outline" },
  stuck: { label: "Stuck — needs direction", token: "error" },
};

export type ThreadBand = "active" | "awaiting-review" | "closed";

export type Thread = {
  id: string;
  role: AgentRole;
  title: string;
  summary: string;
  state: ThreadState;
  detail: string;
  time: string;
  band: ThreadBand;
  system?: boolean;
};

export const THREADS: Thread[] = [
  {
    id: "t1",
    role: "Debugger",
    title: "Run a3f9c12 diverged?",
    summary: "val_loss plateau + LR spike — proposal ready",
    state: "awaiting",
    detail: "1 hypothesis · 1 patch",
    time: "12s ago",
    band: "active",
  },
  {
    id: "t2",
    role: "Scaffolder",
    title: "Scaffold vision-finetune/",
    summary: "PyTorch + W&B scaffold + smoke test passing",
    state: "verifying",
    detail: "running 200 steps",
    time: "4m ago",
    band: "active",
  },
  {
    id: "t3",
    role: "Debugger",
    title: "Compare nova-7b vs orion-3b",
    summary: "Differential diagnosis across 2 runs — reading metrics",
    state: "investigating",
    detail: "3 tool calls",
    time: "6m ago",
    band: "active",
  },
  {
    id: "t4",
    role: "Debugger",
    title: "Loss spike last night",
    summary: "Suggested: re-enable grad clip — already tried (#47)",
    state: "awaiting",
    detail: "rejected by project memory",
    time: "2h ago",
    band: "awaiting-review",
    system: true,
  },
  {
    id: "t5",
    role: "Debugger",
    title: "orion-3b failed at epoch 2",
    summary: "CUDA OOM — batch size / sequence length",
    state: "done",
    detail: "applied · gradient checkpointing",
    time: "yesterday",
    band: "closed",
  },
  {
    id: "t6",
    role: "Scaffolder",
    title: "Scaffold recommender/",
    summary: "JAX template + Hydra config",
    state: "done",
    detail: "applied",
    time: "2 days ago",
    band: "closed",
  },
];

export const CLOSED_COUNT = 12;

export type ConversationMessage = {
  author: "SYSTEM" | "AGENT" | "USER";
  body: string;
  card?: boolean;
};

export const CONVERSATION: ConversationMessage[] = [
  { author: "SYSTEM", body: "Thread opened from Run Inspector · 12s ago" },
  { author: "AGENT", body: "Reasoning trace + Hypothesis + Patch + Verification", card: true },
  { author: "USER", body: "Looks right but try eta_min=1e-6, our other runs use that" },
  { author: "AGENT", body: "Hypothesis revision + new patch + new verification", card: true },
  { author: "SYSTEM", body: "⚠ Note: project memory rules out eta_min=1e-4 from run 47." },
  { author: "USER", body: "Apply." },
];

export type Template = {
  role: AgentRole;
  title: string;
  desc: string;
  soon?: boolean;
  emptyOnly?: boolean;
  isDefault?: boolean;
};

export const TEMPLATES: Template[] = [
  { role: "Debugger", title: "Diagnose run divergence", desc: "Bind to a run, trace metrics vs the best prior run.", isDefault: true },
  { role: "Debugger", title: "Compare K runs", desc: "Multi-run differential diagnosis." },
  { role: "Scaffolder", title: "Start a new project from spec", desc: "Only available in empty workspaces.", emptyOnly: true },
  { role: "Planner", title: "Sequence experiments", desc: "Plan experiments across N runs.", soon: true },
  { role: "Researcher", title: "Cross-reference artifacts", desc: "Cross-reference artifacts / papers.", soon: true },
];
