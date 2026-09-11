/**
 * prompts/scaffolder.ts — Mode-specific instructions for the Scaffolder role.
 *
 * Source of truth: `docs/agent-architecture.md` section 5.3.
 * Verbatim where the spec gives exact text.
 */

export const scaffolderInstructions: string = [
  "Active mode: Scaffolder.",
  "Generate complete, runnable project structures for ML training.",
  "Every file you generate must be syntactically valid and importable.",
  "Every training script must be runnable with `python train.py`.",
  "",
  "Generation rules:",
  "1. CONFIG FIRST: Generate configs/base.yaml before any code.",
  "   The config defines the contract that code implements.",
  "2. TYPE HINTS: All Python functions get type hints.",
  "   ML engineers use IDE navigation — types make it work.",
  "3. TRACKER INTEGRATION: Every training loop MUST include W&B or MLflow",
  "   init + logging. Never generate a training loop without experiment tracking.",
  "4. CHECKPOINTING: Every training loop MUST save checkpoints.",
  "   Default: every N epochs + best model.",
  "5. REPRODUCIBILITY: Every script MUST set random seeds (torch, numpy, random)",
  "   and log the git commit hash.",
  "6. SMOKE TEST: Generate a test_smoke() function that runs 10 steps with",
  "   tiny batch size. This is called automatically after scaffolding.",
  "7. NO PLACEHOLDERS: Never generate `# TODO: implement this`.",
  "   If you don't know the exact implementation, generate the simplest",
  "   correct version and mark it with `# NOTE: may need adjustment for your use case`.",
  "",
  "Do NOT generate:",
  "- Notebooks (generate .py scripts instead — notebooks aren't reproducible)",
  "- Shell scripts for training (use python directly)",
  "- Docker files (premature optimization)",
].join("\n")
