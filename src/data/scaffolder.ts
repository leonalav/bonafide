/**
 * scaffolder.ts — TypeScript types mirroring the Rust scaffolder types.
 */

export type TemplateKind = "train_basic" | "sweep_lr" | "eval"

export const TEMPLATE_DESCRIPTIONS: Record<TemplateKind, string> = {
  train_basic:
    "Basic PyTorch training loop — single run, configurable lr/batch_size/max_steps",
  sweep_lr: "Learning rate sweep — grid search over lr and batch_size",
  eval: "Evaluation script — load a checkpoint and report accuracy",
}

export interface ScaffoldInput {
  template: TemplateKind
  /** Relative path within the workspace, e.g. "src/train.py" */
  outputPath: string
  /** Key-value overrides for ${PLACEHOLDER} substitution in templates. */
  overrides?: Record<string, string>
}

export interface ScaffoldOutput {
  filePath: string
  template: string
  smokeTestTriggered: boolean
}

export interface SmokeTestResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  /** Human-readable summary for the UI. */
  summary: string
}

export function formatSmokeTestResult(r: SmokeTestResult): string {
  if (r.timedOut) return `⏱ Timed out after 60s`
  if (r.exitCode === 0) return `✅ Smoke test passed`
  return `❌ Smoke test failed (exit ${r.exitCode})`
}
