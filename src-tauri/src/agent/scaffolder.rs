//! Scaffolder mode — code generation from templates + smoke testing.
//!
//! The scaffolder reads the workspace context, selects an appropriate
//! Python template, writes it to the workspace, and runs a smoke test
//! via `run_smoke_test` (a wrapper around `run_shell` with a step limit).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Available scaffold templates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TemplateKind {
    TrainBasic,
    SweepLr,
    Eval,
}

impl TemplateKind {
    pub fn from_str(s: &str) -> Self {
        match s {
            "train_basic" => TemplateKind::TrainBasic,
            "sweep_lr" => TemplateKind::SweepLr,
            "eval" => TemplateKind::Eval,
            _ => TemplateKind::TrainBasic,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            TemplateKind::TrainBasic => "train_basic",
            TemplateKind::SweepLr => "sweep_lr",
            TemplateKind::Eval => "eval",
        }
    }

    /// Human-readable description for the LLM to pick the right template.
    pub fn description(&self) -> &'static str {
        match self {
            TemplateKind::TrainBasic => {
                "Basic PyTorch training loop — single run, configurable lr/batch_size/max_steps"
            }
            TemplateKind::SweepLr => {
                "Learning rate sweep — grid search over lr and batch_size"
            }
            TemplateKind::Eval => {
                "Evaluation script — load a checkpoint and report accuracy"
            }
        }
    }
}

/// Embedded template file content.
/// Templates are read from `src-tauri/templates/` at compile time.
fn get_template_content(kind: TemplateKind) -> &'static str {
    match kind {
        TemplateKind::TrainBasic => {
            include_str!("../../templates/train_basic.py")
        }
        TemplateKind::SweepLr => {
            include_str!("../../templates/sweep_lr.py")
        }
        TemplateKind::Eval => {
            include_str!("../../templates/eval.py")
        }
    }
}

/// Input for scaffolding a new script.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldInput {
    /// Which template to use ("train_basic" | "sweep_lr" | "eval").
    pub template: String,
    /// Relative path within the workspace to write the file.
    pub output_path: String,
    /// Optional overrides for template variables (e.g. model class name).
    #[serde(default)]
    pub overrides: HashMap<String, String>,
}

/// Result of a scaffold operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldOutput {
    /// Absolute path to the generated file.
    pub file_path: String,
    /// The template that was used.
    pub template: String,
    /// Whether a smoke test was triggered.
    pub smoke_test_triggered: bool,
}

/// Result of a smoke test run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmokeTestResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    /// Human-readable summary for the UI.
    pub summary: String,
}

impl SmokeTestResult {
    pub fn from_outcome(exit_code: i32, stdout: String, stderr: String, timed_out: bool) -> Self {
        let summary = if timed_out {
            "⏱ Timed out after 60s".to_string()
        } else if exit_code == 0 {
            "✅ Smoke test passed".to_string()
        } else {
            format!("❌ Smoke test failed (exit {exit_code})")
        };
        Self { exit_code, stdout, stderr, timed_out, summary }
    }
}

/// Write a template to the workspace and return the path.
/// The caller is responsible for running the smoke test.
pub fn scaffold_script(
    workspace_root: &Path,
    input: &ScaffoldInput,
) -> Result<ScaffoldOutput, String> {
    let template_kind = TemplateKind::from_str(&input.template);
    let mut content = get_template_content(template_kind).to_string();

    // Apply overrides — simple ${KEY} substitution.
    for (key, value) in &input.overrides {
        let placeholder = format!("${{{}}}", key);
        content = content.replace(&placeholder, value);
    }

    let target: PathBuf = workspace_root.join(&input.output_path);

    // Create parent dirs if needed.
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {e}"))?;
    }

    fs::write(&target, &content)
        .map_err(|e| format!("Failed to write file: {e}"))?;

    Ok(ScaffoldOutput {
        file_path: target.to_string_lossy().to_string(),
        template: template_kind.as_str().to_string(),
        smoke_test_triggered: false, // smoke test is run separately via Tauri command
    })
}

/// Compute a stable smoke test run ID.
pub fn compute_smoke_run_id(workspace_hash: &str, script_path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(workspace_hash.as_bytes());
    hasher.update(script_path.as_bytes());
    let digest = hasher.finalize();
    format!("smoke_{}", &hex::encode(&digest[..8])[..12])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_template_kind_from_str() {
        assert_eq!(TemplateKind::from_str("train_basic"), TemplateKind::TrainBasic);
        assert_eq!(TemplateKind::from_str("sweep_lr"), TemplateKind::SweepLr);
        assert_eq!(TemplateKind::from_str("eval"), TemplateKind::Eval);
        assert_eq!(TemplateKind::from_str("unknown"), TemplateKind::TrainBasic); // default
    }

    #[test]
    fn test_template_kind_as_str_roundtrip() {
        for kind in [TemplateKind::TrainBasic, TemplateKind::SweepLr, TemplateKind::Eval] {
            assert_eq!(TemplateKind::from_str(kind.as_str()), kind);
        }
    }
}
