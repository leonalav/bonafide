//! Scaffolder mode — generates complete, runnable ML project
//! structures.
//!
//! ## Spec sections
//!
//! - 5.3 — generation rules (config first, tracker integration,
//!   checkpointing, reproducibility, no placeholders).
//! - 12.2 — tool access: write tools + git_commit + run_smoke_test
//!   are auto-approved; shell + pip_install need approval; no
//!   apply_patch (Scaffolder generates new files, never modifies).
//!
//! ## Hard rules
//!
//! The Scaffolder has the highest `min_confidence_to_propose_patch`
//! (0.7) — it must be confident before generating files because
//! every file it creates becomes part of the user's project.

use super::Mode;
use crate::agent::orchestrator::AgentRole;

/// Hard rules the Scaffolder's system prompt suffix references.
///
/// Per section 5.3, the Scaffolder follows seven generation rules.
/// The list is exposed via `system_prompt_suffix()` so the engine
/// and any prompt-construction site can render it directly without
/// duplicating the strings across the codebase.
pub const SCAFFOLDER_HARD_RULES: &str = "Scaffolder hard rules: \
1. CONFIG FIRST: Generate configs/base.yaml before any code. The config defines the contract that code implements. \
2. TYPE HINTS: All Python functions get type hints. ML engineers use IDE navigation — types make it work. \
3. TRACKER INTEGRATION: Every training loop MUST include W&B or MLflow init + logging. Never generate a training loop without experiment tracking. \
4. CHECKPOINTING: Every training loop MUST save checkpoints. Default: every N epochs + best model. \
5. REPRODUCIBILITY: Every script MUST set random seeds (torch, numpy, random) and log the git commit hash. \
6. SMOKE TEST: Generate a test_smoke() function that runs 10 steps with tiny batch size. \
7. NO PLACEHOLDERS: Never generate `# TODO: implement this`. If you don't know the exact implementation, generate the simplest correct version and mark it with `# NOTE: may need adjustment for your use case`.";

/// Few-shot examples demonstrating the expected Scaffolder output
/// format. Per section 8.3, these are embedded in the system prompt
/// so the LLM learns the project layout + file-generation contract.
pub const SCAFFOLDER_FEW_SHOT_EXAMPLES: &str = r####"

FEW-SHOT EXAMPLE — Project Structure
═══════════════════════════════════════
User: "Create a CIFAR-10 ResNet50 training pipeline with W&B tracking"

Assistant:
## Requirements
- Framework: PyTorch
- Tracker: W&B
- Dataset: CIFAR-10 (HuggingFace)
- Model: ResNet50 (ImageNet-pretrained)
- Paradigm: Supervised fine-tuning

## Project Tree
```
cifar10_resnet50/
├── configs/
│   ├── base.yaml
│   └── train.yaml
├── src/
│   ├── model.py
│   ├── data.py
│   ├── train.py
│   └── eval.py
├── tests/
│   ├── test_model.py
│   └── test_data.py
├── requirements.txt
├── README.md
└── .gitignore
```

## Key Design Decisions
- Used HuggingFace `datasets` for CIFAR-10 loading (reproducible, versioned).
- W&B initialised at script start with config dict logged.
- Checkpoint saved every epoch + best val_acc.
- Random seed set via `train.py:42` and git commit hash logged via `wandb.log({"commit": git_hash})`.

## Smoke Test Plan
Run `python src/train.py --max_steps=10 --dry_run`:
- Verify imports (torch, transformers, wandb)
- Verify data loads (one batch of 4 samples)
- Verify forward pass (logits shape [4, 10])
- Verify loss computes (cross_entropy scalar)
- Report: "Smoke test passed in 4.2s."

MARKER FORMAT
═════════════
- "## Project Tree" — when you have generated the directory layout.
- "## Key Design Decisions" — when you explain design choices.
- "## Smoke Test Plan" — before any code generation.
- "## Generated" — when file generation is complete (drives → SmokeVerifying)."####;

/// Combined system prompt suffix (hard rules + few-shot examples).
///
/// `concat!()` only accepts literal strings, not `&'static str`
/// constants, so this combined constant inlines both halves as
/// literal text at the declaration site. The two individual
/// constants above are kept for documentation / external
/// reference and for the per-constant tests.
pub const SCAFFOLDER_SYSTEM_PROMPT_SUFFIX: &str = "Scaffolder hard rules: \
1. CONFIG FIRST: Generate configs/base.yaml before any code. The config defines the contract that code implements. \
2. TYPE HINTS: All Python functions get type hints. ML engineers use IDE navigation — types make it work. \
3. TRACKER INTEGRATION: Every training loop MUST include W&B or MLflow init + logging. Never generate a training loop without experiment tracking. \
4. CHECKPOINTING: Every training loop MUST save checkpoints. Default: every N epochs + best model. \
5. REPRODUCIBILITY: Every script MUST set random seeds (torch, numpy, random) and log the git commit hash. \
6. SMOKE TEST: Generate a test_smoke() function that runs 10 steps with tiny batch size. \
7. NO PLACEHOLDERS: Never generate `# TODO: implement this`. If you don't know the exact implementation, generate the simplest correct version and mark it with `# NOTE: may need adjustment for your use case`.\
\
\
FEW-SHOT EXAMPLE — Project Structure\
═══════════════════════════════════════\
User: \"Create a CIFAR-10 ResNet50 training pipeline with W&B tracking\"\
\
Assistant:\
## Requirements\
- Framework: PyTorch\
- Tracker: W&B\
- Dataset: CIFAR-10 (HuggingFace)\
- Model: ResNet50 (ImageNet-pretrained)\
- Paradigm: Supervised fine-tuning\
\
## Project Tree\
```\
cifar10_resnet50/\
├── configs/\
│   ├── base.yaml\
│   └── train.yaml\
├── src/\
│   ├── model.py\
│   ├── data.py\
│   ├── train.py\
│   └── eval.py\
├── tests/\
│   ├── test_model.py\
│   └── test_data.py\
├── requirements.txt\
├── README.md\
└── .gitignore\
```\
\
## Key Design Decisions\
- Used HuggingFace `datasets` for CIFAR-10 loading (reproducible, versioned).\
- W&B initialised at script start with config dict logged.\
- Checkpoint saved every epoch + best val_acc.\
- Random seed set via `train.py:42` and git commit hash logged via `wandb.log({\"commit\": git_hash})`.\
\
## Smoke Test Plan\
Run `python src/train.py --max_steps=10 --dry_run`:\
- Verify imports (torch, transformers, wandb)\
- Verify data loads (one batch of 4 samples)\
- Verify forward pass (logits shape [4, 10])\
- Verify loss computes (cross_entropy scalar)\
- Report: \"Smoke test passed in 4.2s.\"\
\
MARKER FORMAT\
═════════════\
- \"## Project Tree\" — when you have generated the directory layout.\
- \"## Key Design Decisions\" — when you explain design choices.\
- \"## Smoke Test Plan\" — before any code generation.\
- \"## Generated\" — when file generation is complete (drives → SmokeVerifying).";

/// The Bonafide Scaffolder mode.
#[derive(Debug, Clone, Copy, Default)]
pub struct ScaffolderMode;

impl Mode for ScaffolderMode {
    fn role(&self) -> AgentRole {
        AgentRole::Scaffolder
    }

    fn name(&self) -> &'static str {
        "Scaffolder"
    }

    fn investigation_protocol_steps(&self) -> &'static [&'static str] {
        // Section 5.3 — UNDERSTAND_REQUIREMENTS → GENERATE_STRUCTURE
        // → SMOKE_TEST → DELIVER.
        &[
            "UNDERSTAND_REQUIREMENTS",
            "GENERATE_STRUCTURE",
            "SMOKE_TEST",
            "DELIVER",
        ]
    }

    fn max_hypothesis_iterations(&self) -> u32 {
        3
    }

    fn min_confidence_to_propose_patch(&self) -> f32 {
        // Higher than the Debugger's 0.5 — every file the Scaffolder
        // generates lands in the user's project, so it must be
        // confident before writing.
        0.7
    }

    /// The Scaffolder's documented end-of-generation marker.
    /// Per section 5.3, the Scaffolder emits `## Generated` to signal
    /// completion. This drives the engine's `→ Resolved` transition so
    /// the loop terminates cleanly after scaffolding.
    fn behavior_marker_resolved(&self) -> &'static str {
        "## Generated"
    }

    fn system_prompt_suffix(&self) -> &'static str {
        SCAFFOLDER_SYSTEM_PROMPT_SUFFIX
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// `scaffolder_role_and_name`: identity matches section 5.3.
    #[test]
    fn scaffolder_role_and_name() {
        let mode = ScaffolderMode;
        assert_eq!(mode.role(), AgentRole::Scaffolder);
        assert_eq!(mode.name(), "Scaffolder");
    }

    /// `investigation_protocol_steps_match_section_5_3`: the
    /// ordered 4-step protocol matches the spec exactly.
    #[test]
    fn investigation_protocol_steps_match_section_5_3() {
        let mode = ScaffolderMode;
        let steps = mode.investigation_protocol_steps();
        assert_eq!(
            steps,
            &[
                "UNDERSTAND_REQUIREMENTS",
                "GENERATE_STRUCTURE",
                "SMOKE_TEST",
                "DELIVER",
            ],
        );
        assert_eq!(steps.len(), 4);
    }

    /// `min_confidence_higher_than_debugger`: Scaffolders must be
    /// more confident than Debuggers before proposing changes
    /// because every file becomes part of the user's project.
    /// Pin the value so the higher-confidence invariant holds.
    #[test]
    fn min_confidence_higher_than_debugger() {
        let mode = ScaffolderMode;
        assert!(
            mode.min_confidence_to_propose_patch() > 0.5,
            "Scaffolder must require higher confidence than Debugger's 0.5",
        );
        assert!((mode.min_confidence_to_propose_patch() - 0.7).abs() < f32::EPSILON);
    }

    /// `system_prompt_suffix_references_hard_rules`: the suffix
    /// must contain the canonical hard-rule strings so a
    /// system-prompt construction site can grep for them.
    /// "config first" + "tracker integration" + "no placeholders"
    /// are the three most distinctive tokens.
    #[test]
    fn system_prompt_suffix_references_hard_rules() {
        let suffix = ScaffolderMode.system_prompt_suffix();
        assert!(!suffix.is_empty(), "suffix must be non-empty");
        assert!(suffix.contains("CONFIG FIRST"));
        assert!(suffix.contains("TRACKER INTEGRATION"));
        assert!(suffix.contains("NO PLACEHOLDERS"));
        assert!(suffix.contains("CHECKPOINTING"));
    }

    /// `scaffolder_hard_rules_constant_matches_suffix`: the
    /// exported hard-rules constant must be a substring of the
    /// full suffix — a divergence would mean prompt construction
    /// sites see two different rule sets.
    #[test]
    fn scaffolder_hard_rules_constant_matches_suffix() {
        let suffix = ScaffolderMode.system_prompt_suffix();
        assert!(
            suffix.starts_with(SCAFFOLDER_HARD_RULES),
            "suffix must start with SCAFFOLDER_HARD_RULES",
        );
    }

    /// `system_prompt_suffix_includes_few_shot_example`: per
    /// section 8.3, the suffix must contain a complete few-shot
    /// example demonstrating the expected project-tree output.
    #[test]
    fn system_prompt_suffix_includes_few_shot_example() {
        let suffix = ScaffolderMode.system_prompt_suffix();
        assert!(suffix.contains("FEW-SHOT EXAMPLE"));
        assert!(suffix.contains("Project Tree"));
        assert!(suffix.contains("configs/base.yaml"));
        // "Smoke Test" appears in "## Smoke Test Plan" (the
        // marker) and "Smoke test passed in 4.2s." (the report
        // line). Either match is sufficient evidence that the
        // suffix references the smoke-test section.
        assert!(suffix.contains("Smoke Test"));
    }

    /// `system_prompt_suffix_includes_marker_format`: the suffix
    /// must document the markers the engine greps for so the LLM
    /// emits the exact strings that drive state transitions.
    #[test]
    fn system_prompt_suffix_includes_marker_format() {
        let suffix = ScaffolderMode.system_prompt_suffix();
        assert!(suffix.contains("## Project Tree"));
        assert!(suffix.contains("## Key Design Decisions"));
        assert!(suffix.contains("## Smoke Test Plan"));
        assert!(suffix.contains("## Generated"));
    }
}
