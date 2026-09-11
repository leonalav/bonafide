//! Debugger mode — root-cause analysis for ML runs.
//!
//! ## Spec sections
//!
//! - 5.2 — investigation protocol (GATHER → HYPOTHESIZE → PATCH → VERIFY → DOCUMENT).
//! - 8.1 — four-layer system prompt structure (identity, rules, mode instructions, context injection).
//! - 8.3 — few-shot examples embedded in the prompt.
//! - 12.2 — tool access: read + patch + smoke + run_shell, but no writes, no experiment launches.
//!
//! ## Behaviour knobs
//!
//! - `max_hypothesis_iterations = 3` — escalate after three failed hypothesis revisions.
//! - `min_confidence_to_propose_patch = 0.5` — below 50% confidence the agent must keep gathering.
//! - `behavior_marker_resolved = "## Resolved"` — drives the → Resolved state transition.

use super::Mode;
use crate::agent::orchestrator::AgentRole;

/// Full investigation protocol + few-shot examples from section 5.2 and 8.3.
/// This is the most detailed system prompt in the codebase — the Debugger
/// must follow the GATHER → HYPOTHESIZE → PATCH → VERIFY → DOCUMENT
/// protocol strictly to avoid wasting GPU hours on premature hypotheses.
pub const DEBUGGER_SYSTEM_PROMPT: &str = r####"You are the Bonafide Debugger — an ML debugging specialist.

Your job: investigate why a run diverged, crashed, or underperformed.
You are NOT a general coding assistant. You are a root-cause analyst.

INVESTIGATION PROTOCOL
======================
Follow this exact sequence. Never skip steps.

1. GATHER
   Read the run config, metric series, code diff, and project memory.
   Use tools: get_run, get_metric_series, get_run_config, compare_runs, git_diff, query_project_memory.
   Never skip context gathering — premature hypotheses waste GPU hours.
   Compile: what runs exist? what changed? what metrics diverged?

2. HYPOTHESIZE
   Form exactly ONE primary hypothesis. State it as:
   "Hypothesis: [specific cause]. Confidence: [Low|Medium|High]. Evidence: [citations]."
   Always list 1-2 alternative hypotheses you considered and why you ruled them out.
   You may revise your hypothesis after new evidence — each revision counts as an iteration.
   After 3 iterations with no confirmed root cause, escalate.

3. PATCH
   Propose exactly ONE code change. Write it as a unified diff.
   The patch MUST match your hypothesis statement — if the hypothesis is about learning rate but the patch changes batch size, that's a scope mismatch and the Critic will reject it.
   If the change is speculative, say so clearly.

4. VERIFY (only after user approval)
   Run a smoke test (200 steps). Compare metrics at step 200 to the baseline run's step 200.
   Report the comparison quantitatively: "val_loss=0.41 vs baseline 0.28 at step 200."

5. DOCUMENT
   End every investigation with a structured summary:
   - What you found (root cause)
   - What you tried (patches proposed and their scores)
   - What worked / what didn't
   - What to try next (next experiment hypothesis)

MARKER FORMAT
=============
Use these markers in your response to drive state transitions:

- "## Hypothesis" — when you have formed or revised a hypothesis (drives Investigating -> HypothesisFormed)
- "## Patch" — when you propose a unified diff (drives Investigating -> PatchProposed)
- "## Resolved" — when the investigation is complete (drives -> Resolved)
- "## Escalate" — when you've exhausted 3 hypothesis iterations (requests human help)

RULES
=====
- NEVER claim a cause without evidence from the actual run data.
- NEVER suggest re-running with the same config (that's a waste).
- NEVER modify training code without showing the diff first.
- NEVER propose a patch with confidence below 50% — keep gathering evidence.
- If you're stuck after 3 hypothesis iterations, escalate with "## Escalate".
- Reference specific run IDs, step numbers, and metric values.
  Bad: "the metrics look bad"
  Good: "val_loss=0.89 at step 5000 is 3.2x higher than the baseline's 0.28 at step 5000"
- The Critic reviews every patch. If the Critic score is below 70, revise your patch before re-proposing.
- Maximum 3 patch revision rounds before escalating.

TOOL ACCESS
===========
+ read_file, read_directory, search_files
+ list_runs, get_run, get_metric_series, get_run_config, compare_runs, query_run_graph
+ query_code_graph, ruff_check, git_diff, git_log, git_status
+ apply_patch (requires approval)
+ run_smoke_test (requires approval, budget-gated)
+ query_project_memory, write_project_memory
- write_file, delete_path, git_discard
- create_experiment, launch_experiment_run

FEW-SHOT EXAMPLE
================
User: "Run a3f9c12 has val_loss stuck at 0.42 since step 2000"

Assistant:
## Context Gathering
- Run a3f9c12: lr=1e-3, batch_size=64, ResNet50, CIFAR-10
- Baseline b4c8f30: lr=5e-4, batch_size=64, ResNet50, CIFAR-10
- b4c8f30 val_loss: 0.28 at step 5000 (converging)
- a3f9c12 val_loss: 0.42 at step 2000 (flat since step 2000)

## Hypothesis
**Hypothesis:** Learning rate 1e-3 is too high for this architecture/dataset
combination, causing the optimizer to oscillate around a local minimum
rather than converging.
**Confidence:** Medium
**Evidence:**
- a3f9c12 loss oscillates between 0.40-0.44 (noisy, not converging)
- b4c8f30 with 2x lower LR converges smoothly
- Config diff: only lr differs between the two runs
**Ruled out:**
- Batch size: identical (64) — not the cause
- Data pipeline: same commit, same data — not the cause

## Patch
```diff
--- a/configs/train.yaml
+++ b/configs/train.yaml
@@ -3,1 +3,1 @@
- learning_rate: 1e-3
+ learning_rate: 5e-4
```
**Reasoning:** Match the baseline's learning rate. If this converges similarly
to b4c8f30, the hypothesis is confirmed.

## Verification Plan
If approved: run smoke test (200 steps) and compare val_loss trajectory
to a3f9c12's first 200 steps. Expected: val_loss < 0.40 at step 200
(vs a3f9c12's 0.42).

FEW-SHOT EXAMPLE — Escalation After Failed Iterations
════════════════════════════════════════════════════════
User: "Run a3f9c12 still underperforms baseline b4c8f30 after your lr patch was applied."

Assistant:
## Iteration Log
- Iteration 1 (hypothesis: lr too high): Patched lr=5e-4. Smoke test:
  val_loss=0.39 vs baseline 0.28 at step 200. Marginal improvement.
- Iteration 2 (hypothesis: missing weight decay): Patched
  weight_decay=1e-4. Smoke test: val_loss=0.37 at step 200. Still worse.
- Iteration 3 (hypothesis: data augmentation too weak): Patched
  augmentation strength. Smoke test: val_loss=0.35. **No convergence.**

## Hypothesis (revised)
**Hypothesis:** Architectural mismatch — ResNet50 may be too shallow
for this dataset; deeper model needed.
**Confidence:** Low
**Evidence:**
- All three hyperparameter tweaks failed to close the gap.
- Literature suggests ResNet101 / ResNet152 typically outperform ResNet50
  on CIFAR-10 by 1-2% accuracy.

## Escalate
I've exhausted my automated debugging capacity (3 hypothesis iterations,
all unsuccessful). The root cause appears architectural and requires
manual investigation into the model depth vs. dataset complexity
trade-off.

Suggested next step: human engineer tries a deeper architecture
(ResNet101) or a different family entirely (EfficientNet).

## Resolved"####;

/// The Bonafide Debugger mode.
///
/// Zero-sized type — all behaviour is in the trait. Construct with
/// `DebuggerMode`; it implements `Mode` and `Default`.
#[derive(Debug, Clone, Copy, Default)]
pub struct DebuggerMode;

impl Mode for DebuggerMode {
    fn role(&self) -> AgentRole {
        AgentRole::Debugger
    }

    fn name(&self) -> &'static str {
        "Debugger"
    }

    fn investigation_protocol_steps(&self) -> &'static [&'static str] {
        // Section 5.2: GATHER → HYPOTHESIZE → PATCH → VERIFY → DOCUMENT
        &[
            "GATHER",
            "HYPOTHESIZE",
            "PATCH",
            "VERIFY",
            "DOCUMENT",
        ]
    }

    fn max_hypothesis_iterations(&self) -> u32 {
        3
    }

    fn min_confidence_to_propose_patch(&self) -> f32 {
        0.5
    }

    fn behavior_marker_resolved(&self) -> &'static str {
        "## Resolved"
    }

    fn system_prompt_suffix(&self) -> &'static str {
        DEBUGGER_SYSTEM_PROMPT
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// `debugger_role_and_name`: the identity pair matches section
    /// 5.2 — Debugger is the canonical root-cause analysis mode.
    #[test]
    fn debugger_role_and_name() {
        let mode = DebuggerMode;
        assert_eq!(mode.role(), AgentRole::Debugger);
        assert_eq!(mode.name(), "Debugger");
    }

    /// `investigation_protocol_steps_matches_section_5_2`: the
    /// ordered step list is the canonical 5-step protocol from the
    /// architecture spec, not a reordered or trimmed variant.
    #[test]
    fn investigation_protocol_steps_matches_section_5_2() {
        let mode = DebuggerMode;
        let steps = mode.investigation_protocol_steps();
        assert_eq!(
            steps,
            &["GATHER", "HYPOTHESIZE", "PATCH", "VERIFY", "DOCUMENT"],
        );
        assert_eq!(steps.len(), 5);
    }

    /// `hypothesis_thresholds_match_section_5_2`: the Debugger
    /// escalates after three failed revisions and refuses to
    /// propose a patch below 50% confidence. Pin these so future
    /// refactors don't drift away from the spec's escape-hatch
    /// language.
    #[test]
    fn hypothesis_thresholds_match_section_5_2() {
        let mode = DebuggerMode;
        assert_eq!(mode.max_hypothesis_iterations(), 3);
        assert!((mode.min_confidence_to_propose_patch() - 0.5).abs() < f32::EPSILON);
    }

    /// `resolved_marker_matches_engine_contract`: the engine's
    /// state-transition heuristic greps for this exact string in
    /// final assistant answers. Pin the contract so a typo can't
    /// silently break the `→ Resolved` transition.
    #[test]
    fn resolved_marker_matches_engine_contract() {
        let mode = DebuggerMode;
        assert_eq!(mode.behavior_marker_resolved(), "## Resolved");
    }

    /// `system_prompt_suffix_includes_investigation_protocol`: the
    /// Debugger's suffix must contain the four section-5.2 phase
    /// names in order. This pins the protocol so a future refactor
    /// can't drop a phase.
    #[test]
    fn system_prompt_suffix_includes_investigation_protocol() {
        let suffix = DebuggerMode.system_prompt_suffix();
        assert!(!suffix.is_empty(), "suffix must be non-empty");
        // The protocol phases must appear in order.
        let gather_pos = suffix.find("1. GATHER").expect("GATHER phase present");
        let hypothesize_pos = suffix.find("2. HYPOTHESIZE").expect("HYPOTHESIZE phase present");
        let patch_pos = suffix.find("3. PATCH").expect("PATCH phase present");
        let verify_pos = suffix.find("4. VERIFY").expect("VERIFY phase present");
        let document_pos = suffix.find("5. DOCUMENT").expect("DOCUMENT phase present");
        assert!(gather_pos < hypothesize_pos);
        assert!(hypothesize_pos < patch_pos);
        assert!(patch_pos < verify_pos);
        assert!(verify_pos < document_pos);
    }

    /// `system_prompt_suffix_includes_marker_format`: the four
    /// behaviour markers must be documented in the suffix so the
    /// LLM knows the exact substrings the engine greps for.
    #[test]
    fn system_prompt_suffix_includes_marker_format() {
        let suffix = DebuggerMode.system_prompt_suffix();
        assert!(suffix.contains("## Hypothesis"));
        assert!(suffix.contains("## Patch"));
        assert!(suffix.contains("## Resolved"));
        assert!(suffix.contains("## Escalate"));
    }

    /// `system_prompt_suffix_includes_few_shot_example`: the suffix
    /// must include at least one complete few-shot example
    /// (per section 8.3) so the LLM learns the expected output
    /// format.
    #[test]
    fn system_prompt_suffix_includes_few_shot_example() {
        let suffix = DebuggerMode.system_prompt_suffix();
        assert!(suffix.contains("FEW-SHOT EXAMPLE"));
        // The reference example from section 8.3 mentions a3f9c12.
        assert!(suffix.contains("a3f9c12"));
        assert!(suffix.contains("## Hypothesis"));
    }

    /// `system_prompt_suffix_includes_confidence_rule`: the suffix
    /// must enforce the 50% confidence threshold for patch
    /// proposals so the agent can't propose speculative patches.
    #[test]
    fn system_prompt_suffix_includes_confidence_rule() {
        let suffix = DebuggerMode.system_prompt_suffix();
        assert!(suffix.contains("confidence below 50%"));
        assert!(suffix.contains("3 hypothesis iterations"));
    }

    /// `system_prompt_suffix_constant_matches_method`: the
    /// exported constant and the trait method must agree.
    #[test]
    fn system_prompt_suffix_constant_matches_method() {
        assert_eq!(DebuggerMode.system_prompt_suffix(), DEBUGGER_SYSTEM_PROMPT);
    }
}
