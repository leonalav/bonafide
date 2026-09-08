**Debugger + Scaffolder** in v1, Planner + Researcher previewed as empty templates in the inbox.

That concludes the design-decisions phase. We've resolved everything needed to write the spec. Let me now lay out the design in sections and get your approval before I commit it to a doc.

---

## Design — Section 1: Position & Architecture

### Position
**The debugging/diagnosis agent for ML engineers, harnessed to live telemetry.** Not a code completion agent. Not "AI IDE" generalist. The harnessed ML metrics + run history + git-lineage cross-reference *is* the product's defensible surface; the agent is the reasoning layer that uses them.

### Two-track surface model

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│   Track A: AGENT (heavy, evidence-driven, multi-step)                    │
│   ────────────────────────────────────────────────                       │
│   Home: Inspector tab + standalone inbox panel                           │
│   UX:   Evidence cards, gated writes, async threads                      │
│   Roles: Debugger + Scaffolder (v1)                                      │
│                                                                          │
│   Track B: INLINE EDIT (lightweight, single-turn, selection-scoped)      │
│   ────────────────────────────────────────────────────                   │
│   Home: Floating action bar on editor text selection                     │
│   UX:   Quick Edit / Add to Chat dialogs                                 │
│   Role: Code-patch-only, no agent context                                │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

Tracks A and B are **deliberately separate**. Track B is the cheap, immediate, single-line code-patch surface. Track A is the reasoned, evidenced, multi-step surface. Picking between them at the time of action — based on whether the user wants a quick syntax fix or a diagnostic workup — is the user's choice at the moment, and the design honors that.

### Reasoning harness (the most important architectural decision)

The Debugger does not run on a generic chat loop. It runs on a **structured harness** with five phases, and the harness is the thing Bonafide ships, not the model prompt:

1. **Scope**: Bind to a run + workspace + a goal stated by the user (auto-derived from button click, "Investigate" prefills; user can edit).
2. **Observe**: Free read-only tools — `read_run_metrics`, `diff_runs`, `read_config`, `read_code`, `search_runs`, `read_project_memory`.
3. **Hypothesize**: Mandatory output of a structured hypothesis card after at least two read-tool calls, before any write tool.
4. **Propose**: Patches, smoke runs, full reruns are typed **Proposal Card** artifacts. Card contains: change summary, evidence cited, projected impact (best-effort estimate with confidence), verification plan.
5. **Verify**: For proposals classified as "expensive" (training change, smoke run, full rerun), the harness executes a verification step before the user even sees the card. Failure on verification demotes the card to "verified failure," surfaces the failure trajectory, and the user sees *that*, not the unverified proposal.

Writes are **mutually exclusive**: a proposal card cannot both write code *and* launch a smoke run *and* trigger a full rerun. One card = one action class. If multiple are needed, the agent emits a sequence of cards and reasons about the order.

### Roles

**Debugger** — runs every Track A investigation thread. Specializes in: run diagnosis, metric divergence, hyperparameter regression, training instability, data-shape puzzles, code-vs-metric correlation queries.

**Scaffolder** — separate thread template in the inbox: "Start a new project from scratch." Specializes in: folder skeleton, training loop templates (PyTorch/JAX/HF), config system (Hydra/OmegaConf), tracker wiring (W&B), smoke-test scaffolding. Its proposals are mostly **scaffolding edits** (low-stakes, fast, no full-rerun verification needed) and **scaffolder-specific smoke runs** (≤60s verification of "does this run at all on synthetic data").

**Planner + Researcher** — designed roles, deferred. Inbox shows them as empty template rows: "Plan experiments across N runs (coming soon)" and "Cross-reference artifacts / papers (coming soon)." Empty templates are scoped UI, not stubs — they keep the 4-role-aligned taxonomy visible without engineering them.

### Project memory

Per-workspace SQLite table `agent_memory` keyed on `(project_id, key)`:
- Auto-derived from proposal outcomes (`proposal_44 outcome=rejected reason="LR lowering already tried, run 47"`).
- User-curated rules are also allowed ("always use grad clip 1.0 in this repo").
- Hardcoded cross-project heuristics (`never auto-trigger full reruns under 5min run duration`, `prefer local smoke over remote verification when both available`) shipped as a versioned static bundle.
- Purged on workspace deletion.

---

## Section 2: Inspector-integrated Debugger (sync loop)

### Entry points

1. **Run Inspector tab `Agent`** (the third tab alongside `Metrics` and `Config`).
2. **`Investigate this run` button** at the bottom of any run's Inspector header. Opens the Agent tab pre-bound.
3. **CLI palette entry** — `Cmd+L` opens Agent tab scoped to the current selection (file or runs).

### Inspector Agent tab layout

```
┌──────────────────────────────────────────────────────────────┐
│  AGENT — investigating run a3f9c12                          │
│  ────────────────────────────────────────────                │
│                                                              │
│  Goal (auto-detected, editable)                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Why did run a3f9c12 diverge at step 4000 while...   │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Reasoning trace                                             │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ ▼ read_run_metrics(a3f9c12)              [12s ago]    │    │
│  │   lr_spike=true, val_loss plateau from step 3800    │    │
│  │ ▶ read_config(a3f9c12)                   [11s ago]   │    │
│  │ ▶ diff_runs(a3f9c12, b4c8f30)            [9s ago]    │    │
│  │ ▶ read_code("train.py:L102-L160")        [7s ago]    │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Hypothesis                                                 │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  ⚑ Likely: warmup schedule overlap with cosine       │    │
│  │    decay caused LR spike at the wrong step.          │    │
│  │                                                      │    │
│  │  Evidence cited:                                     │    │
│  │  • a3f9c12:5000_lr=0.0042 (▶ jump to line)           │    │
│  │  • a3f9c12 vs b4c8f30: warmup config delta           │    │
│  │  • train.py:L102  cosine.AnnealingWarmRestarts        │    │
│  │                                                      │    │
│  │  Confidence: Medium                                   │    │
│  │  Ruled out: data issue (data hash matches prior)     │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Proposed patch                                       ⏵     │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  + scheduler = CosineAnnealingLR(                     │    │
│  │  +     T_max=epochs, eta_min=1e-5)                   │    │
│  │  - scheduler = CosineAnnealingWarmRestarts(...)      │    │
│  │  1 file · 2 lines · train.py:L102                     │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Verification report                                         │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  ✓ Smoke run completed (200 steps, 3m 12s)           │    │
│  │  val_loss trajectory: 0.51 → 0.42                     │    │
│  │  No LR spike at any step.                             │    │
│  │  Confidence upgraded: Medium → High                   │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  [Reject]  [Request revision]  [Approve & apply]            │
└──────────────────────────────────────────────────────────────┘
```

Three structural regions, each with its own collapse/expand behavior:
- **Goal** — always visible, always editable.
- **Reasoning trace** — collapsed by default at 4 tool calls deep, expandable inline.
- **Hypothesis → Patch → Verification** — the proposal card. Always visible together when present.

### Behavior

- **Pre-bound context**: Run ID, workspace ID, current selected file (if any), last 5 prior runs are passed as initial context.
- **Goal auto-fill**: When launched from `Investigate this run`, the goal is templated: "Why did <run.name> diverge / underperform compared to <best_prior_run>?" User can edit.
- **Multi-step**: The agent keeps going past one shot if its first hypothesis has low confidence or the verification fails. State machine: `hypothesizing → proposing → verifying → [success | revise | give_up]`. Up to 3 revise cycles before it surfaces a "stuck, need human direction" card.
- **Edit existing thread**: User can send follow-up messages in the same Inspector Agent tab. New messages trigger a fresh observation round, but the original hypothesis card stays pinned at the top.

---

## Section 3: Comms Inbox Panel (async Track A)

### Trigger and dock position

New **10th utility dock icon**, between Settings and Account. Label: `Workflow` (icon: a back-and-forth, two arrows). Opens a right-side panel that slides in over the Run Inspector slot, **640px wide, full app height**. Closing returns to the previously-open panel state.

### Panel anatomy (640px wide)

```
┌───────────────────────────────────────────────────────────────┐
│ WORKFLOW                                          ⌘K to focus│
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  [ Inbox ] [ Templates ]               + New thread   ⏵ ⋮    │
│                                                               │
│  ── ACTIVE ──  (3)                                            │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ 🔍 Run a3f9c12 diverged?       Debugger · 12s ago       │  │
│  │ val_loss plateau + LR spike — proposal ready            │  │
│  │ ● Awaiting approval        1 hypothesis · 1 patch       │  │
│  └─────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ 🏗 Scaffold vision-finetune/  Scaffolder · 4m ago        │  │
│  │ PyTorch + W&B scaffold + smoke test passing             │  │
│  │ ● Verifying smoke      running 200 steps                │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  ── AWAITING APPROVAL ──  (1)                                 │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ 🔍 Loss spike last night     Debugger · 2h ago          │  │
│  │ Suggested: re-enable grad clip — already tried (#47)    │  │
│  │ ● Awaiting approval        rejected by project memory   │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  ── CLOSED ──  (12)                                           │
│  ▾ Show 12 closed threads                                     │
└───────────────────────────────────────────────────────────────┘
```

### Thread states

- **Queued** — user submitted, not yet picked up by an agent slot.
- **Investigating** — currently reading runs / code / configs.
- **Hypothesis formed** — visible hypothesis, no patch yet.
- **Awaiting approval** — proposal card up, user has not responded.
- **Verifying** — smoke run in progress.
- **Done** — applied or rejected, click to view full record.
- **Stuck** — hit 3 revise cycles, surfaced to human.

### Thread detail view

Click a thread → slides in a sub-panel pushing the inbox list left by 60% (still visible). Detail view mirrors the Inspector Agent tab structurally (Goal → Trace → Hypothesis → Patch → Verification), with **one extra region at the bottom: the conversation log**. This is where the multi-turn, multi-user-thread, async character lives. The Inspector Agent tab is a synchronous chat; the Workflow thread is an explicit threading model with discrete messages from the agent, the user, and the system (e.g. "smoke run completed").

```
[ Thread: Run a3f9c12 diverged? ]              ← pinned top

┌─ SYSTEM ──────────────────────────────────────────────────────┐
│ Thread opened from Run Inspector · 12s ago                    │
├─ AGENT ───────────────────────────────────────────────────────┤
│ [Reasoning trace + Hypothesis card + Patch + Verification]    │
├─ USER ────────────────────────────────────────────────────────┤
│ "Looks right but try eta_min=1e-6, our other runs use that"  │
├─ AGENT ───────────────────────────────────────────────────────┤
│ [Hypothesis revision card + new patch + new verification]    │
├─ SYSTEM ─────────────────────────────────────────────────────┤
│ ⚠ Note: project memory rules out eta_min=1e-4 from run 47.    │
├─ USER ────────────────────────────────────────────────────────┤
│ "Apply." [Approve & apply]                                    │
└───────────────────────────────────────────────────────────────┘
```

### Selective auto-trigger

In Settings → Notifications → "Workflow," the user toggles:

- **`Run fails`** — auto-create a thread in `Investigating` state with goal="Why did <run.name> fail?" Default: ON.
- **`Run diverges from prior best`** — defined as: best metric regressed >N% vs rolling baseline over the last K runs. Default: ON, with a configurable threshold slider.
- **`Project inactive 3+ days with queued runs`** — surface a "your runs are queued" reminder thread. Default: OFF until expanded.

Auto-created threads land in `AWAITING REVIEW` band of the inbox with `● System` badge. User clicks → reviews the goal, edits if needed, hits Continue.

### Role template entries in the inbox

The Templates tab has:
- **Debugger — Diagnose run divergence** (default)
- **Debugger — Compare K runs** (multi-run differential diagnosis)
- **Scaffolder — Start a new project from spec** (only available in empty workspaces)
- **Planner — Sequence experiments (coming soon)**
- **Researcher — Cross-reference artifacts (coming soon)**

Clicking a `coming soon` template opens an empty thread scaffolded with the role's name and the planned phase list, then shows a locked explanation card:
> This role ships in v1.x. The template is here so you can see what the harness will look like.

---

## Section 4: Inline Code Edits (Track B, lightweight)

Not part of the agent. Triggered exclusively by editor text selection.

### Floating action bar

When the user selects ≥1 character, a 240×36 floating bar appears 8px above the selection, anchored to the right edge of the selection:

```
┌─────────────────────────────────┐
│  Add to Chat       Quick Edit  │
└─────────────────────────────────┘
```

**Add to Chat** — opens the Agent tab in the Inspector or a new Workflow thread (user chooses via a small popover), with the selected code as a quoted excerpt and a default goal prefilled (`Help me understand / improve this code`).

**Quick Edit** — opens the Quick Edit dialog. This is its own thing — a small 480×320 modal centered 60% down the editor. NOT a chat. NOT multi-step.

### Quick Edit dialog

```
┌──────────────────────────────────────────────────────────┐
│  ⚡ Quick Edit                                      ✕    │
│  ─────────────────────────────────────────────          │
│                                                          │
│  Selected: 8 lines in train.py:L102-L110                 │
│  ┌────────────────────────────────────────────────────┐  │
│  │ scheduler = CosineAnnealingWarmRestarts(           │  │
│  │   T_0=10, T_mult=2, eta_min=1e-5                   │  │
│  │ )                                                  │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  Instruction                                             │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Replace this scheduler with a plain CosineAnneal  │  │
│  │ eta_min=1e-6                                       │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  Preview (live, diff vs selection)                        │
│  ┌────────────────────────────────────────────────────┐  │
│  │ - scheduler = CosineAnnealingWarmRestarts(...)    │  │
│  │ + scheduler = CosineAnnealingLR(                  │  │
│  │ +     T_max=epochs, eta_min=1e-6)                 │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  Model: [Default (Sonnet 5.1)            ▼]              │
│                                                          │
│  [Cancel]                       [Apply to selection]      │
└──────────────────────────────────────────────────────────┘
```

**Apply** writes the change to the buffer via Monaco's edit API; the change is on screen, undoable via Ctrl+Z, no agent involvement.

**Important constraint:** Quick Edit has NO access to run history, configs, metrics, or the project memory. It is pure code editing. The differentiation principle holds — Quick Edit does cheap code-patch-only work, the agent does reasoned diagnosis work, they don't bleed into each other. Track B is dumb on purpose.

---

## Section 5: Roles — Debugger and Scaffolder in depth

### Debugger

**Reads:** runs, configs, code, project memory, prior proposals.
**Writes:** code patches (verified by smoke run), config edits (verified by smoke run if they touch training), full-rerun instructions (queued, user kicks off).
**Verification policy:** every code patch or training-touching config edit gets a smoke run before user sees the card. Read-only investigations skip verification.
**Hypothesis repertoire (hardcoded heuristics, for v1):**
- Loss spike → check LR schedule, grad clip, data hash
- Plateau → compare to last similar run, suggest LR reduction with magnitude calibrated to project memory
- NaN → check logit scale, batch size, mixed precision
- Memory blow-up → batch size, sequence length, gradient checkpointing
- Eval diverges from train → overfitting signals, data leak
- Tracker drift → divergent runs across runs → recommend comparing with explicit diff run

### Scaffolder

**Reads:** user-provided spec (free text: "I want to fine-tune a vision model on a custom dataset"), workspace emptiness, available Python interpreter + GPU.
**Writes:** scaffold files (low-stakes, no smoke run), config templates, scaffolded smoke tests (verified via ≤60s smoke run on synthetic data).
**Verification policy:** every smoke-test scaffold is auto-run on synthetic data generated by the agent. The "does it run at all on the user's machine" gate. No actual model training is launched.
**Hypothesis repertoire (hardcoded heuristics):**
- Project goal parsing → decide between PyTorch / HF / JAX templates
- Dataset mention → infer format, suggest structure
- GPU mention → map to template's default batch size
- Tracker preference → wire to W&B / MLflow automatically

### Planner + Researcher — designed but deferred

Each gets a section in the spec detailing the intended UX, the harness phases it would use, and which proposal card schema would apply. Implementation is not in v1. The empty-template row in the inbox is the user-visible marker.

---

## Section 6: Cross-cutting concerns

### Trust surfaces

- **Every proposal card cites evidence.** Clickable to source — metrics jump to Run Inspector, code jumps to Monaco line, config jumps to the source file.
- **Smoke runs are auditable.** Their log output is attached to the proposal card. Any user with `view` permission can replay it.
- **Project memory is editable.** Users can view, edit, and delete entries in Settings → Privacy → Agent memory.
- **The agent can be told to stop.** Every thread has a `Stop investigation` button. Stops cleanly — no orphan runs, no dangling proposals.
- **Writes that fail verification never reach the user.** The user sees the verified-or-failed outcome, not the raw proposal.

### Performance budgets

- Tool call round-trip on read-only paths: <100ms p95.
- Hypothesis card generation: <2s p95.
- Smoke run budget: 200 steps / 5 minutes / 1GB GPU peak, whichever trips first.
- Inbox panel renders 200 threads without scroll jank (virtualized).
- Inspector Agent tab does not block editor frame rate below 60fps.

### Failure modes

- **Tracker unreachable:** agent can still read local cache. Cards mark evidence as "cached."
- **Workspace is not a git repo:** provenance tracing disabled; proposal cards mark code-evidence as "best-effort."
- **Python interpreter missing:** Scaffolder disabled; Debugger still works on run history alone.
- **Project memory corrupted:** table rebuilt on startup from proposal outcomes; user-only notes are preserved if intact.

### What we explicitly do NOT build

- Multi-user chat. Threads are per-user-per-workspace.
- Voice / audio input.
- Agent-to-agent hand-off (Debugger does not call Scaffolder or vice versa).
- Proactive codebase-wide refactoring.
- Auto-PR creation (GitHub integration is deferred).

---

That's the full agent surface design, working through every decision we made in brainstorming. 


