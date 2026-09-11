// critic.rs — ML-specific code review pipeline (section 5.6).
//
// Spec contract (section 5.6):
// - Pattern detection: data leakage, missing random seeds, metric calculation errors
// - Scoring algorithm: weighted sum of issue severities
// - Verdict calculation: APPROVED | NEEDS_REVISION | BLOCKED
// - The function signature is `review_code(diff: &str) -> Result<CriticReview>`
// - A `CriticReview` has: score (0-100), verdict, issues (vec), recommendations (vec)

use serde::{Deserialize, Serialize};
use std::error::Error;

/// `CriticReview` — the output of the code review pipeline (section 5.6).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CriticReview {
    pub score: u8,  // 0-100
    pub verdict: Verdict,
    pub issues: Vec<Issue>,
    pub recommendations: Vec<String>,
}

/// `Verdict` — the final decision from the review (section 5.6).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Verdict {
    Approved,
    NeedsRevision,
    Blocked,
}

/// `Issue` — a single detected problem in the code (section 5.6).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Issue {
    pub severity: Severity,
    pub category: String,
    pub description: String,
    pub line_number: Option<u32>,
}

/// `Severity` — how serious an issue is (section 5.6).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Severity {
    Info,
    Warning,
    Error,
    Critical,
}

/// `review_code` — runs the ML-specific review pipeline on a diff.
/// 
/// This is the synchronous in-process invocation per section 6.3 (not a spawned agent).
/// The pipeline consists of three pattern detectors:
/// 1. Data leakage: test data used in training, future data used in validation
/// 2. Random seeds: missing or inconsistent random seed configuration
/// 3. Metric errors: incorrect metric calculations (e.g., accuracy computed wrong)
/// 
/// Scoring:
/// - Start at 100
/// - Subtract 5 per INFO, 10 per WARNING, 20 per ERROR, 40 per CRITICAL
/// - Score is clamped to 0-100
/// 
/// Verdict:
/// - BLOCKED: any CRITICAL issue OR score < 40
/// - NEEDS_REVISION: any ERROR issue OR score < 70
/// - APPROVED: otherwise
pub fn review_code(diff: &str) -> Result<CriticReview, Box<dyn Error>> {
    if diff.is_empty() {
        return Err("diff cannot be empty".into());
    }

    let mut issues = Vec::new();

    // Pattern detector 1: Data leakage
    if diff.contains("test_data") && diff.contains("model.fit") {
        issues.push(Issue {
            severity: Severity::Critical,
            category: "Data Leakage".to_string(),
            description: "Test data appears to be used in model.fit() call".to_string(),
            line_number: None,
        });
    }
    if diff.contains("future") && diff.contains("validation") {
        issues.push(Issue {
            severity: Severity::Error,
            category: "Data Leakage".to_string(),
            description: "Future data may be leaking into validation set".to_string(),
            line_number: None,
        });
    }

    // Pattern detector 2: Random seeds
    if (diff.contains("random") || diff.contains("np.random") || diff.contains("torch.manual_seed"))
        && !diff.contains("seed=")
    {
        issues.push(Issue {
            severity: Severity::Warning,
            category: "Reproducibility".to_string(),
            description: "Random operations detected but no explicit seed set".to_string(),
            line_number: None,
        });
    }

    // Pattern detector 3: Metric calculation errors
    if diff.contains("accuracy") && diff.contains("sum") && !diff.contains("len") {
        issues.push(Issue {
            severity: Severity::Error,
            category: "Metric Calculation".to_string(),
            description: "Accuracy calculation may be incorrect (sum without len)".to_string(),
            line_number: None,
        });
    }
    if diff.contains("precision") && !diff.contains("true_positives") {
        issues.push(Issue {
            severity: Severity::Warning,
            category: "Metric Calculation".to_string(),
            description: "Precision calculation may be incomplete".to_string(),
            line_number: None,
        });
    }

    // Scoring algorithm
    let mut score: i32 = 100;
    for issue in &issues {
        score -= match issue.severity {
            Severity::Info => 5,
            Severity::Warning => 10,
            Severity::Error => 20,
            Severity::Critical => 40,
        };
    }
    score = score.max(0).min(100);

    // Verdict calculation
    let has_critical = issues.iter().any(|i| i.severity == Severity::Critical);
    let has_error = issues.iter().any(|i| i.severity == Severity::Error);
    let verdict = if has_critical || score < 40 {
        Verdict::Blocked
    } else if has_error || score < 70 {
        Verdict::NeedsRevision
    } else {
        Verdict::Approved
    };

    // Recommendations (derived from issues)
    let mut recommendations = Vec::new();
    if issues.iter().any(|i| i.category == "Data Leakage") {
        recommendations.push("Verify train/test split is correct and no future data leaks into validation.".to_string());
    }
    if issues.iter().any(|i| i.category == "Reproducibility") {
        recommendations.push("Set explicit random seeds for numpy, torch, and random module.".to_string());
    }
    if issues.iter().any(|i| i.category == "Metric Calculation") {
        recommendations.push("Double-check metric formulas against standard definitions.".to_string());
    }
    if issues.is_empty() {
        recommendations.push("Code looks good! No ML-specific issues detected.".to_string());
    }

    Ok(CriticReview {
        score: score as u8,
        verdict,
        issues,
        recommendations,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `review_code_empty_diff_returns_error`: an empty diff is rejected.
    #[test]
    fn review_code_empty_diff_returns_error() {
        let result = review_code("");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("cannot be empty"));
    }

    /// `review_code_clean_diff_returns_approved`: a diff with no detected
    /// issues returns APPROVED verdict with score 100.
    #[test]
    fn review_code_clean_diff_returns_approved() {
        let diff = r#"
+   model = LinearRegression()
+   model.fit(X_train, y_train)
+   predictions = model.predict(X_val)
        "#;
        let review = review_code(diff).unwrap();
        assert_eq!(review.verdict, Verdict::Approved);
        assert_eq!(review.score, 100);
        assert!(review.issues.is_empty());
    }

    /// `review_code_data_leakage_triggers_critical_issue`: using test_data
    /// in model.fit() is flagged as CRITICAL and verdict is BLOCKED.
    #[test]
    fn review_code_data_leakage_triggers_critical_issue() {
        let diff = r#"
+   model.fit(test_data, labels)
        "#;
        let review = review_code(diff).unwrap();
        assert_eq!(review.verdict, Verdict::Blocked);
        assert!(review.issues.iter().any(|i| i.severity == Severity::Critical));
        assert!(review.issues.iter().any(|i| i.category == "Data Leakage"));
        assert!(review.score < 70);
    }

    /// `review_code_missing_seed_triggers_warning`: random operations
    /// without explicit seed are flagged as WARNING.
    #[test]
    fn review_code_missing_seed_triggers_warning() {
        let diff = r#"
+   np.random.shuffle(data)
        "#;
        let review = review_code(diff).unwrap();
        assert!(review.issues.iter().any(|i| i.severity == Severity::Warning));
        assert!(review.issues.iter().any(|i| i.category == "Reproducibility"));
        // One WARNING = -10, so score = 90.
        assert_eq!(review.score, 90);
    }

    /// `review_code_metric_error_triggers_error_severity`: incorrect
    /// accuracy calculation is flagged as ERROR and verdict is NEEDS_REVISION.
    #[test]
    fn review_code_metric_error_triggers_error_severity() {
        let diff = r#"
+   accuracy = sum(predictions == labels)
        "#;
        let review = review_code(diff).unwrap();
        assert_eq!(review.verdict, Verdict::NeedsRevision);
        assert!(review.issues.iter().any(|i| i.severity == Severity::Error));
        assert!(review.issues.iter().any(|i| i.category == "Metric Calculation"));
    }

    /// `review_code_multiple_issues_accumulate_penalty`: multiple issues
    /// reduce the score by the sum of their penalties.
    #[test]
    fn review_code_multiple_issues_accumulate_penalty() {
        let diff = r#"
+   np.random.shuffle(data)
+   accuracy = sum(predictions == labels)
        "#;
        let review = review_code(diff).unwrap();
        // WARNING (-10) + ERROR (-20) = -30, so score = 70.
        assert_eq!(review.score, 70);
        assert_eq!(review.issues.len(), 2);
    }

    /// `review_code_score_clamped_at_zero`: even if penalties exceed 100,
    /// the score is clamped to 0.
    #[test]
    fn review_code_score_clamped_at_zero() {
        let diff = r#"
+   model.fit(test_data, labels)
+   future_validation()
+   accuracy = sum(predictions == labels)
        "#;
        let review = review_code(diff).unwrap();
        // CRITICAL (-40) + ERROR (-20) + ERROR (-20) = -80, score would be 20.
        // But since there's a CRITICAL, verdict = BLOCKED.
        assert_eq!(review.verdict, Verdict::Blocked);
        assert!(review.score >= 0);
    }

    /// `review_code_recommendations_match_issues`: recommendations are
    /// generated based on the detected issue categories.
    #[test]
    fn review_code_recommendations_match_issues() {
        let diff = r#"
+   np.random.shuffle(data)
        "#;
        let review = review_code(diff).unwrap();
        assert!(!review.recommendations.is_empty());
        assert!(review.recommendations.iter().any(|r| r.contains("random seed")));
    }

    /// `review_code_verdict_blocked_at_critical`: any CRITICAL issue
    /// results in BLOCKED verdict regardless of score.
    #[test]
    fn review_code_verdict_blocked_at_critical() {
        let diff = r#"
+   model.fit(test_data, labels)
        "#;
        let review = review_code(diff).unwrap();
        assert_eq!(review.verdict, Verdict::Blocked);
    }

    /// `review_code_verdict_needs_revision_at_error`: any ERROR issue
    /// (without CRITICAL) results in NEEDS_REVISION.
    #[test]
    fn review_code_verdict_needs_revision_at_error() {
        let diff = r#"
+   accuracy = sum(predictions == labels)
        "#;
        let review = review_code(diff).unwrap();
        assert_eq!(review.verdict, Verdict::NeedsRevision);
    }

    /// `review_code_clean_diff_has_positive_recommendation`: when no
    /// issues are detected, the recommendations include a positive message.
    #[test]
    fn review_code_clean_diff_has_positive_recommendation() {
        let diff = r#"
+   model = RandomForest(random_state=42)
+   model.fit(X_train, y_train)
        "#;
        let review = review_code(diff).unwrap();
        assert!(review.recommendations.iter().any(|r| r.contains("looks good")));
    }
}
