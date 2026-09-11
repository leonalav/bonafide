//! Critic Mode — quality gate for ML code and experiments.
//!
//! This module implements Phase 3's Critic Mode (Section 5.6 of the spec).
//! It reviews proposals for correctness, safety, and ML best practices.
//!
//! ## Scoring Rubric (per spec lines 800-840)
//!
//! - 90-100: "Ship it."
//! - 70-89: "Good with minor concerns: [list]."
//! - 50-69: "Risky. Needs changes: [list]."
//! - Below 50: "Reject. Issues: [list]."
//!
//! ## Review Checklist
//!
//! 1. HYPOTHESIS ALIGNMENT: Does the change address the stated hypothesis?
//! 2. REPRODUCIBILITY: Seeds, config, no hardcoded values
//! 3. DATA INTEGRITY: Train/test split, no leakage
//! 4. METRIC CORRECTNESS: Loss function, evaluation set
//! 5. RESOURCE AWARENESS: Compute impact
//!
//! ## Anti-patterns (never score above 70)
//!
//! - Reproducibility is compromised
//! - Data leakage is possible
//! - The change has no clear hypothesis

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// A request to critique a patch or code change.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CritiqueRequest {
    /// The hypothesis being tested (if available)
    pub hypothesis: Option<String>,
    /// Unified diff of the proposed change
    pub patch_diff: Option<String>,
    /// Config diff showing what changed
    pub config_diff: Option<String>,
    /// The full patch content (alternative to diff)
    pub patch_content: Option<String>,
}

/// The result of a critique.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CritiqueResult {
    /// Overall score 0-100
    pub score: u32,
    /// Verdict category
    pub verdict: CritiqueVerdict,
    /// Specific issues found (empty if score >= 70)
    pub issues: Vec<String>,
    /// Checks that passed
    pub checks_passed: Vec<String>,
    /// Detailed breakdown of each check
    pub check_results: Vec<CheckResult>,
}

impl CritiqueResult {
    /// Create a result from a score.
    pub fn from_score(score: u32, issues: Vec<String>, checks_passed: Vec<String>, check_results: Vec<CheckResult>) -> Self {
        let verdict = match score {
            90..=100 => CritiqueVerdict::Ship,
            70..=89 => CritiqueVerdict::MinorConcerns,
            50..=69 => CritiqueVerdict::NeedsChanges,
            _ => CritiqueVerdict::Reject,
        };
        Self {
            score,
            verdict,
            issues,
            checks_passed,
            check_results,
        }
    }

    /// Create a passing result (ship it).
    pub fn ship_it() -> Self {
        Self::from_score(95, vec![], vec![
            "hypothesis_alignment".to_string(),
            "reproducibility".to_string(),
            "data_integrity".to_string(),
            "metric_correctness".to_string(),
            "resource_awareness".to_string(),
        ], vec![
            CheckResult::pass("hypothesis_alignment", "Change aligns with stated hypothesis"),
            CheckResult::pass("reproducibility", "Reproducibility requirements met"),
            CheckResult::pass("data_integrity", "No data leakage detected"),
            CheckResult::pass("metric_correctness", "Metrics computed correctly"),
            CheckResult::pass("resource_awareness", "Resource impact acceptable"),
        ])
    }

    /// Create a result for a request with no content to review.
    pub fn no_content() -> Self {
        Self::from_score(
            0,
            vec!["No patch or content provided to review".to_string()],
            vec![],
            vec![CheckResult::fail("no_content", "No content provided for review")],
        )
    }
}

/// Verdict category for the critique.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CritiqueVerdict {
    Ship,
    MinorConcerns,
    NeedsChanges,
    Reject,
}

impl std::fmt::Display for CritiqueVerdict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CritiqueVerdict::Ship => write!(f, "Ship it."),
            CritiqueVerdict::MinorConcerns => write!(f, "Good with minor concerns."),
            CritiqueVerdict::NeedsChanges => write!(f, "Risky. Needs changes."),
            CritiqueVerdict::Reject => write!(f, "Reject."),
        }
    }
}

/// Result of a single check.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub check_name: String,
    pub passed: bool,
    pub score_contribution: i32,
    pub message: String,
}

impl CheckResult {
    pub fn pass(name: &str, message: &str) -> Self {
        Self {
            check_name: name.to_string(),
            passed: true,
            score_contribution: 20, // Each check contributes up to 20 points
            message: message.to_string(),
        }
    }

    pub fn fail(name: &str, message: &str) -> Self {
        Self {
            check_name: name.to_string(),
            passed: false,
            score_contribution: 0,
            message: message.to_string(),
        }
    }

    pub fn partial(name: &str, message: &str, contribution: i32) -> Self {
        Self {
            check_name: name.to_string(),
            passed: contribution >= 10,
            score_contribution: contribution,
            message: message.to_string(),
        }
    }
}

// ── Check implementations ───────────────────────────────────────────────────────

/// Check 1: HYPOTHESIS ALIGNMENT
/// Does the change address the stated hypothesis?
fn check_hypothesis_alignment(request: &CritiqueRequest) -> CheckResult {
    let patch = request.patch_diff.as_deref().or(request.patch_content.as_deref());

    // If no hypothesis or no patch, we can't fully check
    if request.hypothesis.is_none() {
        return CheckResult::partial(
            "hypothesis_alignment",
            "No hypothesis provided; cannot verify alignment",
            10,
        );
    }

    let hypothesis = request.hypothesis.as_ref().unwrap().to_lowercase();
    let patch = patch.unwrap_or("").to_lowercase();

    // Keywords that indicate alignment with common ML hypotheses
    let lr_keywords = ["learning_rate", "lr", "learning rate", "optimizer"];
    let batch_keywords = ["batch_size", "batch size", "batchsize"];
    let model_keywords = ["model", "architecture", "layer", "head"];
    let data_keywords = ["data", "dataset", "augmentation", "preprocessing"];

    // Determine what the hypothesis is about
    let is_lr_hypothesis = lr_keywords.iter().any(|k| hypothesis.contains(k));
    let is_batch_hypothesis = batch_keywords.iter().any(|k| hypothesis.contains(k));
    let is_model_hypothesis = model_keywords.iter().any(|k| hypothesis.contains(k));
    let is_data_hypothesis = data_keywords.iter().any(|k| hypothesis.contains(k));

    // Check if patch touches relevant areas
    let patch_touches_lr = lr_keywords.iter().any(|k| patch.contains(k));
    let patch_touches_batch = batch_keywords.iter().any(|k| patch.contains(k));
    let patch_touches_model = model_keywords.iter().any(|k| patch.contains(k));
    let patch_touches_data = data_keywords.iter().any(|k| patch.contains(k));

    let alignment = if is_lr_hypothesis && patch_touches_lr { true }
        else if is_batch_hypothesis && patch_touches_batch { true }
        else if is_model_hypothesis && patch_touches_model { true }
        else if is_data_hypothesis && patch_touches_data { true }
        else if !is_lr_hypothesis && !is_batch_hypothesis && !is_model_hypothesis && !is_data_hypothesis {
            // Hypothesis about something else, can't verify
            true
        } else {
            // Mismatch
            false
        };

    if alignment {
        CheckResult::pass("hypothesis_alignment", "Change addresses the stated hypothesis")
    } else {
        CheckResult::partial(
            "hypothesis_alignment",
            "Change may not address the stated hypothesis",
            5,
        )
    }
}

/// Check 2: REPRODUCIBILITY
/// Seeds, config, no hardcoded values
fn check_reproducibility(request: &CritiqueRequest) -> CheckResult {
    let patch = request.patch_diff.as_deref().or(request.patch_content.as_deref());
    let patch = patch.unwrap_or("");

    let mut issues = Vec::new();
    let mut score = 20;

    // Check for hardcoded paths
    let hardcoded_paths = [
        "/home/", "/Users/", "C:\\", "/mnt/", "/data/",
    ];
    for path in &hardcoded_paths {
        if patch.contains(path) && !patch.contains("Path(") && !patch.contains("pathlib") {
            issues.push(format!("Hardcoded absolute path detected: {}", path));
            score -= 5;
        }
    }

    // Check for hardcoded magic numbers (but allow common constants)
    let magic_numbers = regex::Regex::new(r"(?<![\w])(?<!\.)(\d{4,})(?!\.\d)").ok();
    if let Some(re) = magic_numbers {
        let matches: Vec<_> = re.find_iter(patch).collect();
        if matches.len() > 5 {
            issues.push(format!("Many numeric literals detected ({}), consider using named constants", matches.len()));
            score -= 3;
        }
    }

    // Check for seed handling
    let has_seed = patch.contains("seed")
        || patch.contains("torch.manual_seed")
        || patch.contains("np.random.seed")
        || patch.contains("random.seed")
        || patch.contains("set_seed");
    if !has_seed {
        issues.push("No random seed setting detected".to_string());
        score -= 5;
    }

    // Check for config usage (good practice)
    let uses_config = patch.contains("config")
        || patch.contains("args.")
        || patch.contains("Cfg")
        || patch.contains("Config");

    if uses_config {
        issues.push("Uses configuration system (good for reproducibility)".to_string());
        score += 2; // Small bonus
    }

    score = score.clamp(0, 20);

    if issues.is_empty() {
        CheckResult::pass("reproducibility", "Reproducibility requirements met")
    } else {
        CheckResult::partial("reproducibility", &issues.join("; "), score)
    }
}

/// Check 3: DATA INTEGRITY
/// Train/test split, no leakage
fn check_data_integrity(request: &CritiqueRequest) -> CheckResult {
    let patch = request.patch_diff.as_deref().or(request.patch_content.as_deref());
    let patch = patch.unwrap_or("").to_lowercase();

    let mut issues = Vec::new();
    let mut score = 20;

    // Check for common data leakage patterns
    let leakage_patterns = [
        ("train_test_split", "Standard train/test split"),
        ("val_split", "Validation split"),
        ("test_set", "Test set"),
        ("test_data", "Test data"),
    ];

    let has_split = leakage_patterns.iter().any(|(pattern, _)| patch.contains(pattern));

    // Check for problematic patterns
    if patch.contains("test") && patch.contains("fit") && !patch.contains("validation") {
        issues.push("Potential data leakage: model fitted on test data".to_string());
        score -= 10;
    }

    if patch.contains("train") && patch.contains("test") && patch.contains("transform") {
        // Check if both use same transform (common mistake)
        issues.push("Verify transforms are applied separately to train and test sets".to_string());
        score -= 3;
    }

    if patch.contains("evaluation") && patch.contains("train") {
        issues.push("Verify evaluation is on held-out data, not training data".to_string());
        score -= 5;
    }

    if !has_split {
        issues.push("No train/test split detected".to_string());
        score -= 5;
    }

    score = score.clamp(0, 20);

    if issues.is_empty() {
        CheckResult::pass("data_integrity", "No data leakage detected")
    } else {
        CheckResult::partial("data_integrity", &issues.join("; "), score)
    }
}

/// Check 4: METRIC CORRECTNESS
/// Loss function, evaluation set
fn check_metric_correctness(request: &CritiqueRequest) -> CheckResult {
    let patch = request.patch_diff.as_deref().or(request.patch_content.as_deref());
    let patch = patch.unwrap_or("").to_lowercase();

    let mut issues = Vec::new();
    let mut score = 20;

    // Check for loss function
    let loss_functions = [
        "cross_entropy", "mse", "mae", "bce", "binary_crossentropy",
        "nll_loss", "cosine_loss", "contrastive_loss", "loss",
    ];
    let has_loss = loss_functions.iter().any(|l| patch.contains(l));

    if !has_loss {
        issues.push("No explicit loss function detected");
        score -= 5;
    }

    // Check for metric logging
    let metric_patterns = ["accuracy", "f1", "precision", "recall", "auc", "map", "loss"];
    let has_metrics = metric_patterns.iter().any(|m| patch.contains(m));

    if !has_metrics {
        issues.push("No metric logging detected");
        score -= 5;
    }

    // Check for evaluation on correct set
    let eval_on_train = patch.contains("train") && patch.contains("evaluate")
        && !patch.contains("validation") && !patch.contains("val");

    if eval_on_train {
        issues.push("Evaluation appears to be on training set");
        score -= 10;
    }

    // Check for loss computation on correct set
    let loss_on_train = patch.contains("train_loss") || patch.contains("training_loss");
    if loss_on_train && !patch.contains("val_loss") {
        issues.push("Loss computed on training set only; consider validation loss");
        score -= 3;
    }

    score = score.clamp(0, 20);

    if issues.is_empty() {
        CheckResult::pass("metric_correctness", "Metrics computed correctly")
    } else {
        CheckResult::partial("metric_correctness", &issues.join("; "), score)
    }
}

/// Check 5: RESOURCE AWARENESS
/// Compute impact
fn check_resource_awareness(request: &CritiqueRequest) -> CheckResult {
    let patch = request.patch_diff.as_deref().or(request.patch_content.as_deref());
    let config = request.config_diff.as_deref().unwrap_or("");
    let combined = format!("{}\n{}", patch.unwrap_or(""), config);

    let mut issues = Vec::new();
    let mut score = 20;

    // Check for GPU/TPU placement
    let has_device = combined.contains("cuda")
        || combined.contains("gpu")
        || combined.contains("tpu")
        || combined.contains("device")
        || combined.contains(".to(");

    if !has_device {
        issues.push("No explicit device placement detected");
        score -= 3;
    }

    // Check for batch size configuration
    let has_batch = combined.contains("batch")
        || combined.contains("batch_size");

    if !has_batch {
        issues.push("No batch size configuration detected");
        score -= 2;
    }

    // Check for gradient checkpointing or memory optimization
    let has_optimization = combined.contains("gradient_checkpoint")
        || combined.contains("mixed_precision")
        || combined.contains("fp16")
        || combined.contains("autocast")
        || combined.contains("compile");

    if !has_optimization && (combined.contains("transformer") || combined.contains("bert") || combined.contains("gpt")) {
        issues.push("Large model detected without memory optimization; consider gradient checkpointing or mixed precision");
        score -= 3;
    }

    // Check for checkpoint saving
    let has_checkpoint = combined.contains("save")
        && (combined.contains("checkpoint") || combined.contains("model.state")
            || combined.contains("torch.save") || combined.contains("model.save"));

    if !has_checkpoint {
        issues.push("No checkpoint saving detected");
        score -= 2;
    }

    // Check for early stopping
    let has_early_stopping = combined.contains("early_stop")
        || combined.contains("patience")
        || combined.contains("EarlyStopping");

    if !has_early_stopping {
        issues.push("No early stopping detected; consider adding for efficiency");
        score -= 2;
    }

    score = score.clamp(0, 20);

    if issues.is_empty() {
        CheckResult::pass("resource_awareness", "Resource impact acceptable")
    } else {
        CheckResult::partial("resource_awareness", &issues.join("; "), score)
    }
}

// ── Main critique function ─────────────────────────────────────────────────────

/// Perform a full critique of a patch or code change.
pub fn critique(request: &CritiqueRequest) -> CritiqueResult {
    // Check if there's anything to critique
    let has_content = request.patch_diff.is_some()
        || request.patch_content.is_some()
        || request.config_diff.is_some();

    if !has_content {
        return CritiqueResult::no_content();
    }

    // Run all checks
    let checks = vec![
        check_hypothesis_alignment(request),
        check_reproducibility(request),
        check_data_integrity(request),
        check_metric_correctness(request),
        check_resource_awareness(request),
    ];

    // Calculate total score
    let base_score: i32 = checks.iter().map(|c| c.score_contribution).sum();
    let score = base_score.clamp(0, 100) as u32;

    // Separate passed and failed checks
    let mut checks_passed = Vec::new();
    let mut issues = Vec::new();

    for check in &checks {
        if check.passed {
            checks_passed.push(check.check_name.clone());
        } else if check.score_contribution < 15 {
            // Only report as issues if they significantly reduce the score
            issues.push(format!("{}: {}", check.check_name, check.message));
        }
    }

    // Determine which anti-pattern caps should fire (per spec: "Never
    // score above 70 if: reproducibility compromised / data leakage
    // possible / no clear hypothesis").
    //
    // We consult the per-check `passed` flag — NOT just the `issues`
    // vector — because a check can be partially failing (e.g. one
    // hardcoded path) without dropping below the 15-point issue
    // threshold. Using `issues` alone would silently bypass the cap
    // when a check is at score 15–19.
    let reproducibility_compromised = checks
        .iter()
        .find(|c| c.check_name == "reproducibility")
        .map(|c| !c.passed || c.score_contribution < 20)
        .unwrap_or(false);

    let data_leakage_risk = checks
        .iter()
        .find(|c| c.check_name == "data_integrity")
        .map(|c| !c.passed || c.score_contribution < 20)
        .unwrap_or(false);

    let no_clear_hypothesis = request.hypothesis.is_none()
        && (request.patch_diff.is_some() || request.patch_content.is_some());

    // Apply anti-pattern rules (never score above 70 when any of the
    // three conditions hold). Sub-categories within data-leakage and
    // reproducibility get tighter caps as before.
    let final_score = if data_leakage_risk {
        // Data leakage is the most severe; hard cap at 50.
        score.min(50)
    } else if no_clear_hypothesis {
        // No hypothesis + has content → cap at 60 (spec: never above 70).
        score.min(60)
    } else if reproducibility_compromised {
        // Reproducibility issues → cap at 55 (spec: never above 70).
        score.min(55)
    } else {
        score
    };

    CritiqueResult::from_score(final_score, issues, checks_passed, checks)
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_score_thresholds() {
        // Ship it (90-100)
        let result = CritiqueResult::ship_it();
        assert_eq!(result.verdict, CritiqueVerdict::Ship);
        assert!(result.score >= 90);

        // No content (0)
        let result = CritiqueResult::no_content();
        assert_eq!(result.verdict, CritiqueVerdict::Reject);
        assert_eq!(result.score, 0);
    }

    #[test]
    fn test_reject_low_score() {
        let request = CritiqueRequest {
            hypothesis: Some("learning_rate".to_string()),
            patch_diff: Some("+ random change".to_string()),
            config_diff: None,
            patch_content: None,
        };
        let result = critique(&request);
        assert!(result.score < 50 || result.issues.len() > 0);
    }

    #[test]
    fn test_accept_high_score() {
        let good_patch = r#"
import torch
torch.manual_seed(42)
config.learning_rate = 1e-4
train_loader, val_loader = train_test_split(dataset)
model.fit(train_loader, val_loader)
loss_fn = torch.nn.CrossEntropyLoss()
        "#;

        let request = CritiqueRequest {
            hypothesis: Some("learning_rate = 1e-4 improves val_loss".to_string()),
            patch_diff: Some(good_patch.to_string()),
            config_diff: None,
            patch_content: None,
        };
        let result = critique(&request);
        assert!(result.score >= 50, "Score was {}: {:?}", result.score, result);
    }

    #[test]
    fn test_hypothesis_alignment_check() {
        let request = CritiqueRequest {
            hypothesis: Some("learning rate affects convergence".to_string()),
            patch_diff: Some("learning_rate = 1e-4".to_string()),
            config_diff: None,
            patch_content: None,
        };
        let result = critique(&request);
        let alignment_check = result.check_results.iter().find(|c| c.check_name == "hypothesis_alignment");
        assert!(alignment_check.is_some());
        assert!(alignment_check.unwrap().passed);
    }

    #[test]
    fn test_reproducibility_check() {
        // Good patch with seed
        let request = CritiqueRequest {
            hypothesis: None,
            patch_diff: Some(r#"
import torch
torch.manual_seed(42)
model = ResNet()
train(config)
            "#.to_string()),
            config_diff: None,
            patch_content: None,
        };
        let result = critique(&request);
        let repro_check = result.check_results.iter().find(|c| c.check_name == "reproducibility");
        assert!(repro_check.is_some());
        // Should pass or be close to passing
        assert!(repro_check.unwrap().score_contribution >= 15);
    }

    #[test]
    fn test_data_integrity_check() {
        let request = CritiqueRequest {
            hypothesis: None,
            patch_diff: Some(r#"
train_loader, val_loader = train_test_split(data)
model.fit(train_loader, val_loader)
            "#.to_string()),
            config_diff: None,
            patch_content: None,
        };
        let result = critique(&request);
        let integrity_check = result.check_results.iter().find(|c| c.check_name == "data_integrity");
        assert!(integrity_check.is_some());
        assert!(integrity_check.unwrap().passed);
    }

    #[test]
    fn test_metric_correctness_check() {
        let request = CritiqueRequest {
            hypothesis: None,
            patch_diff: Some(r#"
loss_fn = nn.CrossEntropyLoss()
accuracy = evaluate(model, val_data)
            "#.to_string()),
            config_diff: None,
            patch_content: None,
        };
        let result = critique(&request);
        let metric_check = result.check_results.iter().find(|c| c.check_name == "metric_correctness");
        assert!(metric_check.is_some());
        assert!(metric_check.unwrap().passed);
    }

    #[test]
    fn test_no_content() {
        let request = CritiqueRequest {
            hypothesis: None,
            patch_diff: None,
            config_diff: None,
            patch_content: None,
        };
        let result = critique(&request);
        assert_eq!(result.score, 0);
        assert!(!result.issues.is_empty());
    }

    #[test]
    fn test_check_result_creation() {
        let pass = CheckResult::pass("test", "Test passed");
        assert!(pass.passed);
        assert_eq!(pass.score_contribution, 20);

        let fail = CheckResult::fail("test", "Test failed");
        assert!(!fail.passed);
        assert_eq!(fail.score_contribution, 0);

        let partial = CheckResult::partial("test", "Partial pass", 10);
        assert!(partial.passed);
        assert_eq!(partial.score_contribution, 10);
    }

    #[test]
    fn test_critique_verdict_display() {
        assert_eq!(CritiqueVerdict::Ship.to_string(), "Ship it.");
        assert_eq!(CritiqueVerdict::MinorConcerns.to_string(), "Good with minor concerns.");
        assert_eq!(CritiqueVerdict::NeedsChanges.to_string(), "Risky. Needs changes.");
        assert_eq!(CritiqueVerdict::Reject.to_string(), "Reject.");
    }
}
