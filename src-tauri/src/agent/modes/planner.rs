//! Planner mode — designs experiment sequences that maximise
//! information gain per GPU dollar.
//!
//! ## Spec sections
//!
//! - 5.4 — planning rules (hypothesis-driven, one variable at a
//!   time, baseline first, parallel opportunities, escape hatches).
//! - 12.2 — read-only tool access plus `create_experiment` and
//!   `launch_experiment_run` (both require approval).
//!
//! ## Behaviour knobs
//!
//! - `max_hypothesis_iterations = 1` — Planners propose; they don't
//!   iterate hypotheses. Once a plan is presented, humans gate
//!   execution.
//! - `min_confidence_to_propose_patch = 0.0` — Planners always
//!   propose (the human is the gate, not the agent).

use super::Mode;
use crate::agent::orchestrator::AgentRole;

/// Hypothesis-driven + one-variable-at-a-time + baseline-first rules
/// from section 5.4. Surfaced as `system_prompt_suffix()`.
pub const PLANNER_HARD_RULES: &str = "Planner hard rules: \
1. HYPOTHESIS-DRIVEN: Every experiment must test a specific hypothesis. \"Let's try a different learning rate\" is not a hypothesis. \
2. ONE VARIABLE AT A TIME: Change only one variable per experiment. If you need to test two changes, design two experiments. \
3. BASELINE FIRST: The first experiment in any sequence must be a baseline (current best config, no changes). Without a baseline, you can't measure improvement. \
4. EARLY TERMINATION: Design experiments with early stopping criteria. Don't waste 8 GPU hours on a run that diverged at hour 1. \
5. COST AWARENESS: Present estimated costs. If the total exceeds the user's budget, propose a cheaper subset. \
6. PARALLEL OPPORTUNITIES: Identify experiments that don't depend on each other and can run simultaneously. \
7. ESCAPE HATCHES: For each experiment, state what to do if it fails: \"If val_loss > 0.5 at step 1000, stop and try X instead.\"";

/// Few-shot example showing the expected Planner output format
/// (numbered experiment plan with costs + parallel markers).
pub const PLANNER_FEW_SHOT_EXAMPLES: &str = r####"

FEW-SHOT EXAMPLE — Experiment Plan
═══════════════════════════════════
User: "Plan my next 5 experiments to reduce val_loss for run a3f9c12 (lr=1e-3 val_loss=0.42)."

Assistant:
## Experiment Plan

### Experiment 1 — BASELINE
- **Hypothesis:** Current config is the best baseline; no change expected.
- **Config:** Same as a3f9c12 (lr=1e-3, batch_size=64, ResNet50, CIFAR-10).
- **Measurable goal:** Reproduce a3f9c12's val_loss=0.42 within 5%.
- **Cost:** 1.5 GPU-hr on A100 ($3.00, 1.5h wall-clock).
- **Dependencies:** None — must run first.
- **Early stop:** Stop if val_loss < 0.40 at step 2000.

### Experiment 2 — Reduce learning rate (independent of 1's outcome)
- **Hypothesis:** lr=5e-4 will reduce val_loss by at least 10% (current curve oscillates).
- **Config:** lr=5e-4, otherwise identical to a3f9c12.
- **Measurable goal:** val_loss < 0.38 at step 5000 (10% improvement).
- **Cost:** 1.5 GPU-hr ($3.00).
- **Dependencies:** None — can run in parallel with Experiment 3.
- **Escape hatch:** If val_loss > 0.45 at step 1000, abort and try Experiment 4 instead.

### Experiment 3 — Add weight decay (independent of 2)
- **Hypothesis:** weight_decay=1e-4 will reduce overfitting and lower val_loss by 5%.
- **Config:** lr=1e-3 (unchanged), weight_decay=1e-4.
- **Cost:** 1.5 GPU-hr ($3.00).
- **Dependencies:** None — parallel to 2.
- **Escape hatch:** If val_loss diverges (NaN) within first 500 steps, abort.

### Experiment 4 — Combine 2 + 3 (gated on 2 + 3 success)
- **Hypothesis:** lr=5e-4 AND weight_decay=1e-4 will produce the lowest val_loss.
- **Cost:** 1.5 GPU-hr ($3.00).
- **Dependencies:** Sequential — needs results from 2 and 3.
- **Escape hatch:** If either 2 or 3 failed, skip this and propose Experiment 5.

### Experiment 5 — Switch optimizer (only if 2-4 fail)
- **Hypothesis:** AdamW reduces val_loss vs SGD on this dataset.
- **Cost:** 1.5 GPU-hr ($3.00).
- **Dependencies:** Sequential — only run if 2-4 don't converge.

## Summary
- **Total cost:** 7.5 GPU-hr ($15.00)
- **Parallel:** Experiments 2 and 3 can run simultaneously (saves ~1.5h wall-clock).
- **Sequential gates:** Experiment 4 depends on 2 and 3; Experiment 5 depends on 2-4.
- **Recommendation:** Run baseline + Experiments 2/3 in parallel. Sequential 4 only if 2 and 3 both succeed.

MARKER FORMAT
═════════════
- "## Experiment Plan" — when presenting a numbered sequence.
- "## Summary" — when listing total cost and parallel/sequential structure.
- "## Recommendation" — final actionable advice."####;

/// Combined system prompt suffix (hard rules + few-shot examples).
///
/// `concat!()` only accepts literal strings, not `&'static str`
/// constants, so this combined constant inlines both halves as
/// literal text at the declaration site. The two individual
/// constants above are kept for documentation / external
/// reference and for the per-constant tests.
pub const PLANNER_SYSTEM_PROMPT_SUFFIX: &str = "Planner hard rules: \
1. HYPOTHESIS-DRIVEN: Every experiment must test a specific hypothesis. \"Let's try a different learning rate\" is not a hypothesis. \
2. ONE VARIABLE AT A TIME: Change only one variable per experiment. If you need to test two changes, design two experiments. \
3. BASELINE FIRST: The first experiment in any sequence must be a baseline (current best config, no changes). Without a baseline, you can't measure improvement. \
4. EARLY TERMINATION: Design experiments with early stopping criteria. Don't waste 8 GPU hours on a run that diverged at hour 1. \
5. COST AWARENESS: Present estimated costs. If the total exceeds the user's budget, propose a cheaper subset. \
6. PARALLEL OPPORTUNITIES: Identify experiments that don't depend on each other and can run simultaneously. \
7. ESCAPE HATCHES: For each experiment, state what to do if it fails: \"If val_loss > 0.5 at step 1000, stop and try X instead.\".\
\
\
FEW-SHOT EXAMPLE — Experiment Plan\
═══════════════════════════════════\
User: \"Plan my next 5 experiments to reduce val_loss for run a3f9c12 (lr=1e-3 val_loss=0.42).\"\
\
Assistant:\
## Experiment Plan\
\
### Experiment 1 — BASELINE\
- **Hypothesis:** Current config is the best baseline; no change expected.\
- **Config:** Same as a3f9c12 (lr=1e-3, batch_size=64, ResNet50, CIFAR-10).\
- **Measurable goal:** Reproduce a3f9c12's val_loss=0.42 within 5%.\
- **Cost:** 1.5 GPU-hr on A100 ($3.00, 1.5h wall-clock).\
- **Dependencies:** None — must run first.\
- **Early stop:** Stop if val_loss < 0.40 at step 2000.\
\
### Experiment 2 — Reduce learning rate (independent of 1's outcome)\
- **Hypothesis:** lr=5e-4 will reduce val_loss by at least 10% (current curve oscillates).\
- **Config:** lr=5e-4, otherwise identical to a3f9c12.\
- **Measurable goal:** val_loss < 0.38 at step 5000 (10% improvement).\
- **Cost:** 1.5 GPU-hr ($3.00).\
- **Dependencies:** None — can run in parallel with Experiment 3.\
- **Escape hatch:** If val_loss > 0.45 at step 1000, abort and try Experiment 4 instead.\
\
### Experiment 3 — Add weight decay (independent of 2)\
- **Hypothesis:** weight_decay=1e-4 will reduce overfitting and lower val_loss by 5%.\
- **Config:** lr=1e-3 (unchanged), weight_decay=1e-4.\
- **Cost:** 1.5 GPU-hr ($3.00).\
- **Dependencies:** None — parallel to 2.\
- **Escape hatch:** If val_loss diverges (NaN) within first 500 steps, abort.\
\
### Experiment 4 — Combine 2 + 3 (gated on 2 + 3 success)\
- **Hypothesis:** lr=5e-4 AND weight_decay=1e-4 will produce the lowest val_loss.\
- **Cost:** 1.5 GPU-hr ($3.00).\
- **Dependencies:** Sequential — needs results from 2 and 3.\
- **Escape hatch:** If either 2 or 3 failed, skip this and propose Experiment 5.\
\
### Experiment 5 — Switch optimizer (only if 2-4 fail)\
- **Hypothesis:** AdamW reduces val_loss vs SGD on this dataset.\
- **Cost:** 1.5 GPU-hr ($3.00).\
- **Dependencies:** Sequential — only run if 2-4 don't converge.\
\
## Summary\
- **Total cost:** 7.5 GPU-hr ($15.00)\
- **Parallel:** Experiments 2 and 3 can run simultaneously (saves ~1.5h wall-clock).\
- **Sequential gates:** Experiment 4 depends on 2 and 3; Experiment 5 depends on 2-4.\
- **Recommendation:** Run baseline + Experiments 2/3 in parallel. Sequential 4 only if 2 and 3 both succeed.\
\
MARKER FORMAT\
═════════════\
- \"## Experiment Plan\" — when presenting a numbered sequence.\
- \"## Summary\" — when listing total cost and parallel/sequential structure.\
- \"## Recommendation\" — final actionable advice.";

/// The Bonafide Planner mode.
#[derive(Debug, Clone, Copy, Default)]
pub struct PlannerMode;

impl Mode for PlannerMode {
    fn role(&self) -> AgentRole {
        AgentRole::Planner
    }

    fn name(&self) -> &'static str {
        "Planner"
    }

    fn investigation_protocol_steps(&self) -> &'static [&'static str] {
        // Section 5.4 — ASSESS_CURRENT_STATE → DESIGN_EXPERIMENT_SEQUENCE
        // → ESTIMATE_COSTS → PROPOSE_TO_USER.
        &[
            "ASSESS_CURRENT_STATE",
            "DESIGN_EXPERIMENT_SEQUENCE",
            "ESTIMATE_COSTS",
            "PROPOSE_TO_USER",
        ]
    }

    fn max_hypothesis_iterations(&self) -> u32 {
        // Planners propose once; humans gate. Iteration belongs to
        // the Debugger, not the Planner.
        1
    }

    fn min_confidence_to_propose_patch(&self) -> f32 {
        // 0.0 — always propose. The human is the gate, not the agent.
        0.0
    }

    /// The Planner's documented final-marker. Per section 5.4, the Planner
    /// emits `## Recommendation` as the final actionable advice.
    /// This drives the engine's `→ Resolved` transition so the loop
    /// terminates cleanly after proposing an experiment plan.
    fn behavior_marker_resolved(&self) -> &'static str {
        "## Recommendation"
    }

    fn system_prompt_suffix(&self) -> &'static str {
        PLANNER_SYSTEM_PROMPT_SUFFIX
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// `planner_role_and_name`: identity matches section 5.4.
    #[test]
    fn planner_role_and_name() {
        let mode = PlannerMode;
        assert_eq!(mode.role(), AgentRole::Planner);
        assert_eq!(mode.name(), "Planner");
    }

    /// `investigation_protocol_steps_match_section_5_4`: the
    /// ordered 4-step protocol matches the spec.
    #[test]
    fn investigation_protocol_steps_match_section_5_4() {
        let mode = PlannerMode;
        let steps = mode.investigation_protocol_steps();
        assert_eq!(
            steps,
            &[
                "ASSESS_CURRENT_STATE",
                "DESIGN_EXPERIMENT_SEQUENCE",
                "ESTIMATE_COSTS",
                "PROPOSE_TO_USER",
            ],
        );
        assert_eq!(steps.len(), 4);
    }

    /// `planner_does_not_iterate_hypotheses`: max_hypothesis_iterations
    /// is 1 — the Planner proposes once and lets the human gate.
    /// Iteration is the Debugger's job, not the Planner's.
    #[test]
    fn planner_does_not_iterate_hypotheses() {
        let mode = PlannerMode;
        assert_eq!(mode.max_hypothesis_iterations(), 1);
    }

    /// `planner_always_proposes`: min_confidence_to_propose_patch
    /// is 0.0 — humans gate Planner proposals, not the agent.
    /// Pin so a regression can't silently re-introduce a confidence
    /// floor on plan proposals.
    #[test]
    fn planner_always_proposes() {
        let mode = PlannerMode;
        assert_eq!(mode.min_confidence_to_propose_patch(), 0.0);
    }

    /// `system_prompt_suffix_references_planning_rules`: the
    /// suffix must contain the three distinctive tokens that
    /// identify the Planner's protocol.
    #[test]
    fn system_prompt_suffix_references_planning_rules() {
        let suffix = PlannerMode.system_prompt_suffix();
        assert!(suffix.contains("HYPOTHESIS-DRIVEN"));
        assert!(suffix.contains("ONE VARIABLE AT A TIME"));
        assert!(suffix.contains("BASELINE FIRST"));
    }

    /// `planner_hard_rules_constant_matches_suffix`: the
    /// exported hard-rules constant must be a substring of the
    /// full suffix — a divergence would mean prompt construction
    /// sites see two different rule sets.
    #[test]
    fn planner_hard_rules_constant_matches_suffix() {
        let suffix = PlannerMode.system_prompt_suffix();
        assert!(
            suffix.starts_with(PLANNER_HARD_RULES),
            "suffix must start with PLANNER_HARD_RULES",
        );
    }

    /// `system_prompt_suffix_includes_few_shot_example`: the
    /// suffix must demonstrate the expected experiment-plan output
    /// with cost + parallel markers (section 8.3).
    #[test]
    fn system_prompt_suffix_includes_few_shot_example() {
        let suffix = PlannerMode.system_prompt_suffix();
        assert!(suffix.contains("FEW-SHOT EXAMPLE"));
        assert!(suffix.contains("Experiment 1 — BASELINE"));
        assert!(suffix.contains("Measurable goal"));
        assert!(suffix.contains("Early stop"));
        assert!(suffix.contains("Escape hatch"));
        assert!(suffix.contains("Total cost"));
    }

    /// `system_prompt_suffix_includes_marker_format`: documents
    /// the markers the engine greps for in Planner responses.
    #[test]
    fn system_prompt_suffix_includes_marker_format() {
        let suffix = PlannerMode.system_prompt_suffix();
        assert!(suffix.contains("## Experiment Plan"));
        assert!(suffix.contains("## Summary"));
        assert!(suffix.contains("## Recommendation"));
    }
}
