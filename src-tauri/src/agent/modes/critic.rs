//! Critic mode — quality gate for ML code and experiments.
//!
//! ## Spec sections
//!
//! - 5.6 — critique protocol (scope, correctness, ML-specific
//!   checks, risk, scoring).
//! - 6.3 — Critic runs **synchronously, in-process** — not as a
//!   spawned sub-agent. The `review_proposal` function in this
//!   module is the synchronous entry point the engine calls after
//!   a Debugger proposes a patch or a Scaffolder generates code.
//!
//! ## Scoring rubric (section 5.6)
//!
//! - 90-100: "Ship it."
//! - 70-89: "Good with minor concerns: [list]."
//! - 50-69: "Risky. Needs changes: [list]."
//! - < 50: "Reject. Issues: [list]."
//!
//! Score < 70 means risky; score < 50 means reject.

use super::Mode;
use crate::agent::orchestrator::AgentRole;

/// Threshold below which a proposal is rejected outright
/// (section 5.6 — "0-50: Reject with specific issues").
pub const CRITIC_REJECT_THRESHOLD: u8 = 50;

/// Threshold below which a proposal is risky and needs revisions
/// before approval (section 5.6 — "51-75: Accept with reservations").
pub const CRITIC_RISKY_THRESHOLD: u8 = 70;

/// Maximum score — section 5.6 caps every dimension at 100.
pub const CRITIC_MAX_SCORE: u8 = 100;

/// Hypothesis context accompanying a Critic review. Carries the
/// originating hypothesis (if any) and the diff under review.
///
/// The Critic does NOT need the full hypothesis struct — only the
/// fields it uses to score the proposal. Keeping the payload
/// minimal makes the synchronous review path cheap to call on
/// every patch attempt.
#[derive(Debug, Clone)]
pub struct HypothesisContext {
    /// Free-form statement of the hypothesis the patch addresses.
    /// Used by the scope-check heuristic ("does the patch match
    /// the hypothesis?").
    pub hypothesis_statement: String,
    /// Confidence level of the originating agent (0.0-1.0). The
    /// Critic down-weights proposals with low confidence even if
    /// the diff itself is technically correct.
    pub confidence: f32,
}

/// The patch under review. Currently a `diff` string; the file
/// path lives in the diff header per the convention established
/// by `Thread.proposed_patch` in `orchestrator.rs`.
#[derive(Debug, Clone)]
pub struct PatchProposal {
    /// The unified diff.
    pub diff: String,
    /// One-line summary of what the patch does. The Critic
    /// matches it against the hypothesis statement to verify
    /// scope alignment.
    pub summary: String,
}

/// Full review protocol + scoring rubric + few-shot examples from
/// section 5.6 and 8.3. Surfaced as `system_prompt_suffix()`.
pub const CRITIC_SYSTEM_PROMPT: &str = r#"You are the Bonafide Critic — a quality gate for ML code and experiments.

Your job: review proposals for correctness, safety, and ML best practices.
You are the last line of defense before a change is applied.

REVIEW PROTOCOL
═══════════════
Execute these checks in order. Each check produces issues and recommendations.

1. SCOPE CHECK
   - Does this change address the stated hypothesis?
   - Is the scope appropriate (not too broad, not too narrow)?
   - Mismatch example: hypothesis is about learning rate but patch changes batch size.

2. CORRECTNESS CHECK
   - Is the code syntactically valid?
   - Are there obvious logic errors?
   - Does it maintain backward compatibility?

3. ML-SPECIFIC CHECKS
   - Does the change maintain reproducibility?
   - Is the metric computation correct?
   - Are train/test splits preserved?
   - Is there data leakage risk?
   - Are random seeds handled correctly?

4. RISK ASSESSMENT
   - What could go wrong if this change is applied?
   - Is there a rollback plan?
   - Does this change affect other experiments?

5. SCORING
   - Score: 0-100
   - 0-50: Reject with specific issues
   - 51-69: Risky — needs changes before approval
   - 70-89: Accept with minor concerns
   - 90-100: Ship it

SCORING RUBRIC
══════════════
- 90-100: "Ship it." — change is sound, minimal risk, addresses hypothesis cleanly
- 70-89: "Good with minor concerns: [list]."
- 50-69: "Risky. Needs changes: [list]."
- Below 50: "Reject. Issues: [list]."

Never score above 70 if:
- Reproducibility is compromised (no seed, hardcoded paths)
- Data leakage is possible (train/test split broken, future info used)
- The change has no clear hypothesis
- The patch is empty or trivial

CHECKLIST
═════════
1. HYPOTHESIS ALIGNMENT: Does the change address the stated hypothesis?
2. REPRODUCIBILITY: Random seeds set and logged? Config captured in run?
   No hardcoded paths or magic numbers?
3. DATA INTEGRITY: Train/test split maintained? No future information used?
   Preprocessing consistent between train and eval?
4. METRIC CORRECTNESS: Averaging over the right dimension? Loss matches task?
   Evaluation on held-out set, not training set?
5. RESOURCE AWARENESS: Compute impact? Memory implications? Budget covered?

VERDICT FORMAT
══════════════
Always return a structured verdict:

{
  "score": <0-100>,
  "verdict": "Ship it." | "Good with minor concerns." | "Risky — needs changes." | "Reject.",
  "issues": ["issue 1", "issue 2", ...],
  "recommendations": ["fix 1", "fix 2", ...]
}

FEW-SHOT EXAMPLE — APPROVE
════════════════════════════
Hypothesis: "Learning rate 1e-3 is too high; reduce to 5e-4."
Patch: <diff halving learning rate in configs/train.yaml>
Confidence: 0.7

Assistant:
{
  "score": 88,
  "verdict": "Good with minor concerns.",
  "issues": ["No smoke-test plan included — recommend running 200-step smoke before full launch."],
  "recommendations": ["Add verification step: run 200-step smoke and compare val_loss trajectory."]
}

FEW-SHOT EXAMPLE — REJECT
══════════════════════════
Hypothesis: "Learning rate 1e-3 is too high; reduce to 5e-4."
Patch: <diff changes batch_size from 64 to 32>
Confidence: 0.2

Assistant:
{
  "score": 35,
  "verdict": "Reject.",
  "issues": [
    "SCOPE MISMATCH: hypothesis is about learning rate, patch changes batch_size.",
    "Low confidence (20%) does not justify a config change with downstream effects on training dynamics.",
    "No reproducibility check: random seed not mentioned."
  ],
  "recommendations": [
    "Revise patch to change learning_rate, not batch_size.",
    "Gather more evidence before proposing a change at this confidence level.",
    "Include seed and git commit hash in the change."
  ]
}

CONSTRAINTS
═══════════
- Critic is advisory — it scores and reports, never acts.
- Maximum 3 patch revision rounds. After that, escalate to human.
- Always cite specific sections of the change that triggered each issue.
- If the patch is empty, return score 0 with issue "Patch diff is empty.""#;

/// The Critic's verdict on a proposal.
///
/// Returned by `review_proposal` after the synchronous scoring
/// loop. The score drives the engine's next-state decision
/// (≥ 70 ⇒ present to user; 50-69 ⇒ revise; < 50 ⇒ reject).
#[derive(Debug, Clone)]
pub struct CriticVerdict {
    /// Composite score, 0-100. See section 5.6 for the rubric.
    pub score: u8,
    /// Short verdict line for the UI ("Ship it." / "Risky." / etc.).
    pub verdict: String,
    /// Ordered list of issues, most-severe first.
    pub issues: Vec<String>,
    /// Ordered list of suggested fixes, most-impactful first.
    pub recommendations: Vec<String>,
}

impl CriticVerdict {
    /// True when the score is below `CRITIC_REJECT_THRESHOLD`
    /// (50). The engine should transition the thread to `Rejected`.
    pub fn is_reject(&self) -> bool {
        self.score < CRITIC_REJECT_THRESHOLD
    }

    /// True when the score is between `CRITIC_REJECT_THRESHOLD`
    /// and `CRITIC_RISKY_THRESHOLD` (50-69). The engine should
    /// route the proposal back for revision.
    pub fn is_risky(&self) -> bool {
        self.score >= CRITIC_REJECT_THRESHOLD && self.score < CRITIC_RISKY_THRESHOLD
    }

    /// True when the score is at or above `CRITIC_RISKY_THRESHOLD`
    /// (70). The engine should present the proposal to the user
    /// for approval.
    pub fn is_presentable(&self) -> bool {
        self.score >= CRITIC_RISKY_THRESHOLD
    }
}

/// The Bonafide Critic mode.
///
/// Zero-sized type — all behaviour is in the trait. The synchronous
/// review path is the free function `review_proposal` defined in
/// this module; the engine does not invoke it via the trait.
#[derive(Debug, Clone, Copy, Default)]
pub struct CriticMode;

impl Mode for CriticMode {
    fn role(&self) -> AgentRole {
        AgentRole::Critic
    }

    fn name(&self) -> &'static str {
        "Critic"
    }

    fn investigation_protocol_steps(&self) -> &'static [&'static str] {
        // Section 5.6 — SCOPE_CHECK → CORRECTNESS_CHECK →
        // ML_SPECIFIC_CHECKS → RISK_ASSESSMENT → SCORING.
        &[
            "SCOPE_CHECK",
            "CORRECTNESS_CHECK",
            "ML_SPECIFIC_CHECKS",
            "RISK_ASSESSMENT",
            "SCORING",
        ]
    }

    fn max_hypothesis_iterations(&self) -> u32 {
        // Max revisions before giving up on a patch (section 5.6
        // implies the Critic can be called up to 3 times before
        // the engine should stop retrying).
        3
    }

    fn min_confidence_to_propose_patch(&self) -> f32 {
        // Critic never proposes patches — only reviews.
        0.0
    }

    fn system_prompt_suffix(&self) -> &'static str {
        CRITIC_SYSTEM_PROMPT
    }
}

// ── Synchronous review path ──────────────────────────────────────────────────

/// Review a proposal synchronously and return a `CriticVerdict`.
///
/// This is the in-process, synchronous entry point the engine
/// invokes after a Debugger proposes a patch or a Scaffolder
/// generates code (section 6.3 — Critic is the one synchronous
/// in-process call, not a spawned sub-agent).
///
/// ## Scoring heuristic (deterministic, no LLM)
///
/// The synchronous path is intentionally simple: it scores the
/// proposal from a few signal inputs (patch content, hypothesis
/// match, confidence) and returns a verdict. A future WS will
/// replace this with an LLM-backed critic that calls the LLM
/// directly; the synchronous signature here is the contract the
/// rest of the engine relies on.
///
/// ## Algorithm
///
/// 1. Start at `CRITIC_MAX_SCORE` (100).
/// 2. Deduct for empty diffs, empty summaries, and missing
///    hypothesis statements.
/// 3. Award bonus / deduct penalty for keyword-level matches
///    ("reproducibility", "seed", "test", "config") that the
///    section-5.6 checklist values.
/// 4. Clamp the result into `[0, CRITIC_MAX_SCORE]`.
/// 5. Map to verdict label and classify as
///    reject / risky / presentable via the `CriticVerdict`
///    helpers.
pub fn review_proposal(
    proposal: &PatchProposal,
    hypothesis: &HypothesisContext,
) -> CriticVerdict {
    let mut score: i32 = CRITIC_MAX_SCORE as i32;
    let mut issues: Vec<String> = Vec::new();
    let mut recommendations: Vec<String> = Vec::new();

    // ── Empty-patch penalty ───────────────────────────────────────────
    if proposal.diff.trim().is_empty() {
        score -= 40;
        issues.push("Patch diff is empty.".to_string());
        recommendations.push("Provide a non-empty unified diff.".to_string());
    }

    // ── Empty-summary penalty ─────────────────────────────────────────
    if proposal.summary.trim().is_empty() {
        score -= 20;
        issues.push("Patch summary is empty.".to_string());
        recommendations.push(
            "Describe what the patch does and why it addresses the hypothesis.".to_string(),
        );
    }

    // ── Empty-hypothesis penalty ──────────────────────────────────────
    if hypothesis.hypothesis_statement.trim().is_empty() {
        score -= 15;
        issues.push("No hypothesis statement was provided.".to_string());
        recommendations.push(
            "Form a hypothesis first — \"Hypothesis: [cause]. Confidence: [level]. Evidence: [citations].\"".to_string(),
        );
    }

    // ── Low-confidence penalty ────────────────────────────────────────
    // Below 30% confidence, even a technically correct patch is too
    // speculative to ship without more evidence.
    if hypothesis.confidence < 0.30 {
        score -= 20;
        issues.push(format!(
            "Hypothesis confidence is low ({:.0}%); the patch is speculative.",
            hypothesis.confidence * 100.0
        ));
        recommendations.push(
            "Gather more evidence before proposing a patch at this confidence level.".to_string(),
        );
    }

    // ── ML-bonus keywords (section 5.6) ────────────────────────────────
    // Each keyword the diff mentions is worth +5, capped so a
    // keyword-stuffed diff can't game the score.
    let diff_lower = proposal.diff.to_lowercase();
    let summary_lower = proposal.summary.to_lowercase();
    let mut bonuses: i32 = 0;
    for keyword in ["seed", "config", "test", "reproducibility", "checkpoint"] {
        if diff_lower.contains(keyword) || summary_lower.contains(keyword) {
            bonuses += 5;
        }
    }
    let bonus_clamped = bonuses.min(20);
    score += bonus_clamped;
    if bonus_clamped > 0 {
        // Surface the bonus in the recommendations so the user sees
        // why the score moved up. Optional — not penalising if missing.
        recommendations.push(format!(
            "Repro/test keywords present ({}pt bonus).",
            bonus_clamped
        ));
    }

    // ── Clamp + classify ──────────────────────────────────────────────
    let score = score.clamp(0, CRITIC_MAX_SCORE as i32) as u8;

    let verdict = if score >= CRITIC_RISKY_THRESHOLD {
        if score >= 90 {
            "Ship it."
        } else {
            "Good with minor concerns."
        }
    } else if score >= CRITIC_REJECT_THRESHOLD {
        "Risky — needs changes."
    } else {
        "Reject."
    }
    .to_string();

    // If the score is risky, surface the issues as the primary
    // recommendations. The recommendations Vec is always populated
    // for presentable scores too so the UI has something to show.
    if score < CRITIC_RISKY_THRESHOLD && recommendations.is_empty() {
        recommendations.push(
            "See issues list — address each before resubmitting.".to_string(),
        );
    }

    CriticVerdict {
        score,
        verdict,
        issues,
        recommendations,
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_proposal() -> PatchProposal {
        PatchProposal {
            diff: "--- a/configs/train.yaml\n+++ b/configs/train.yaml\n@@\n- learning_rate: 1e-3\n+ learning_rate: 5e-4\n".to_string(),
            summary: "Halve the learning rate per the hypothesis.".to_string(),
        }
    }

    fn sample_hypothesis() -> HypothesisContext {
        HypothesisContext {
            hypothesis_statement:
                "Learning rate 1e-3 is too high for this architecture.".to_string(),
            confidence: 0.7,
        }
    }

    /// `critic_role_and_name`: identity matches section 5.6.
    #[test]
    fn critic_role_and_name() {
        let mode = CriticMode;
        assert_eq!(mode.role(), AgentRole::Critic);
        assert_eq!(mode.name(), "Critic");
    }

    /// `investigation_protocol_steps_match_section_5_6`: the
    /// 5-step scoring protocol matches the spec exactly.
    #[test]
    fn investigation_protocol_steps_match_section_5_6() {
        let mode = CriticMode;
        let steps = mode.investigation_protocol_steps();
        assert_eq!(
            steps,
            &[
                "SCOPE_CHECK",
                "CORRECTNESS_CHECK",
                "ML_SPECIFIC_CHECKS",
                "RISK_ASSESSMENT",
                "SCORING",
            ],
        );
        assert_eq!(steps.len(), 5);
    }

    /// `critic_never_proposes_patches`: the invariant is encoded
    /// as `min_confidence_to_propose_patch == 0.0` so a future
    /// refactor can't accidentally let the Critic ship a patch.
    #[test]
    fn critic_never_proposes_patches() {
        let mode = CriticMode;
        assert_eq!(mode.min_confidence_to_propose_patch(), 0.0);
        assert_eq!(mode.max_hypothesis_iterations(), 3);
    }

    /// `review_proposal_presentable_path`: a well-formed patch +
    /// confident hypothesis lands above `CRITIC_RISKY_THRESHOLD`
    /// and `is_presentable()` returns true.
    #[test]
    fn review_proposal_presentable_path() {
        let verdict = review_proposal(&sample_proposal(), &sample_hypothesis());
        assert!(
            verdict.is_presentable(),
            "expected score >= {}, got {}",
            CRITIC_RISKY_THRESHOLD,
            verdict.score
        );
        assert!(verdict.score >= CRITIC_RISKY_THRESHOLD);
        assert!(verdict.score <= CRITIC_MAX_SCORE);
    }

    /// `review_proposal_reject_threshold`: an empty diff + empty
    /// summary + low confidence + no hypothesis lands below
    /// `CRITIC_REJECT_THRESHOLD` so the engine can route the
    /// proposal back as `Rejected`.
    #[test]
    fn review_proposal_reject_threshold() {
        let empty = PatchProposal {
            diff: String::new(),
            summary: String::new(),
        };
        let weak_hyp = HypothesisContext {
            hypothesis_statement: String::new(),
            confidence: 0.05,
        };
        let verdict = review_proposal(&empty, &weak_hyp);
        assert!(
            verdict.is_reject(),
            "expected score < {}, got {}",
            CRITIC_REJECT_THRESHOLD,
            verdict.score
        );
        assert!(verdict.score < CRITIC_REJECT_THRESHOLD);
        assert!(!verdict.issues.is_empty());
    }

    /// `review_proposal_risky_path`: a presentable-but-not-great
    /// proposal lands in the 50-69 band so the engine routes it
    /// for revision.
    #[test]
    fn review_proposal_risky_path() {
        // Patch with a non-empty diff but no summary → -20 penalty.
        // Use a diff without ML-bonus keywords so the bonus doesn't
        // rescue the score back into the presentable band.
        let proposal = PatchProposal {
            diff: "--- a/foo.py\n+++ b/foo.py\n@@\n- x = 1\n+ x = 2\n".to_string(),
            summary: String::new(),
        };
        let mut hyp = sample_hypothesis();
        // Low confidence → -20.
        hyp.confidence = 0.2;
        let verdict = review_proposal(&proposal, &hyp);
        assert!(
            verdict.is_risky(),
            "expected 50 <= score < 70, got {}",
            verdict.score
        );
        assert!(verdict.score >= CRITIC_REJECT_THRESHOLD);
        assert!(verdict.score < CRITIC_RISKY_THRESHOLD);
    }

    /// `verdict_classification_helpers_match_thresholds`: the
    /// `is_reject` / `is_risky` / `is_presentable` helpers must
    /// agree with the threshold constants — a regression in the
    /// constants would otherwise leave the helpers stale.
    #[test]
    fn verdict_classification_helpers_match_thresholds() {
        // Build a verdict at each band and assert the helper
        // matches the threshold logic.
        for (score, expected_reject, expected_risky, expected_presentable) in [
            (0u8, true, false, false),
            (49, true, false, false),
            (50, false, true, false),
            (69, false, true, false),
            (70, false, false, true),
            (90, false, false, true),
            (100, false, false, true),
        ] {
            let v = CriticVerdict {
                score,
                verdict: String::new(),
                issues: Vec::new(),
                recommendations: Vec::new(),
            };
            assert_eq!(v.is_reject(), expected_reject, "score={score} reject");
            assert_eq!(v.is_risky(), expected_risky, "score={score} risky");
            assert_eq!(
                v.is_presentable(),
                expected_presentable,
                "score={score} presentable"
            );
        }
    }

    /// `review_proposal_is_pure_deterministic`: the synchronous
    /// path is the contract the engine depends on — same inputs
    /// must produce the same score. Guards against a future
    /// refactor that accidentally introduces randomness or a
    /// hidden mutable global.
    #[test]
    fn review_proposal_is_pure_deterministic() {
        let a = review_proposal(&sample_proposal(), &sample_hypothesis());
        let b = review_proposal(&sample_proposal(), &sample_hypothesis());
        assert_eq!(a.score, b.score);
        assert_eq!(a.verdict, b.verdict);
        assert_eq!(a.issues, b.issues);
        assert_eq!(a.recommendations, b.recommendations);
    }

    /// `review_proposal_score_within_bounds`: every result must
    /// clamp into `[0, 100]`. The clamping is defence-in-depth —
    /// penalties and bonuses could push the score negative or
    /// above 100 if a future edit forgets to clamp.
    #[test]
    fn review_proposal_score_within_bounds() {
        for confidence in [0.0, 0.05, 0.5, 0.95, 1.0] {
            for (diff, summary) in [
                (String::new(), String::new()),
                ("diff".to_string(), String::new()),
                (String::new(), "summary".to_string()),
                ("seed config test reproducibility checkpoint".to_string(), String::new()),
                ("x".repeat(1000), "summary".to_string()),
            ] {
                let proposal = PatchProposal { diff, summary };
                let hyp = HypothesisContext {
                    hypothesis_statement: if confidence > 0.5 {
                        "h".to_string()
                    } else {
                        String::new()
                    },
                    confidence,
                };
                let verdict = review_proposal(&proposal, &hyp);
                assert!(verdict.score <= CRITIC_MAX_SCORE, "score overflow");
            }
        }
    }

    /// `system_prompt_suffix_includes_review_protocol`: the
    /// Critic's suffix must contain all 5 phases of the review
    /// protocol (section 5.6) in order so the LLM has unambiguous
    /// instructions.
    #[test]
    fn system_prompt_suffix_includes_review_protocol() {
        let suffix = CriticMode.system_prompt_suffix();
        assert!(!suffix.is_empty(), "suffix must be non-empty");
        let scope = suffix.find("1. SCOPE CHECK").expect("scope check present");
        let correctness = suffix.find("2. CORRECTNESS CHECK").expect("correctness check present");
        let ml = suffix.find("3. ML-SPECIFIC CHECKS").expect("ml-specific checks present");
        let risk = suffix.find("4. RISK ASSESSMENT").expect("risk assessment present");
        let scoring = suffix.find("5. SCORING").expect("scoring present");
        assert!(scope < correctness);
        assert!(correctness < ml);
        assert!(ml < risk);
        assert!(risk < scoring);
    }

    /// `system_prompt_suffix_includes_scoring_bands`: the four
    /// score bands from section 5.6 must be present so the LLM
    /// doesn't invent its own thresholds.
    #[test]
    fn system_prompt_suffix_includes_scoring_bands() {
        let suffix = CriticMode.system_prompt_suffix();
        assert!(suffix.contains("90-100"));
        assert!(suffix.contains("70-89"));
        assert!(suffix.contains("50-69"));
        assert!(suffix.contains("Below 50"));
    }

    /// `system_prompt_suffix_includes_few_shot_examples`: the
    /// suffix must include at least one approve and one reject
    /// example (section 8.3) so the LLM learns the expected
    /// verdict format.
    #[test]
    fn system_prompt_suffix_includes_few_shot_examples() {
        let suffix = CriticMode.system_prompt_suffix();
        assert!(suffix.contains("FEW-SHOT EXAMPLE — APPROVE"));
        assert!(suffix.contains("FEW-SHOT EXAMPLE — REJECT"));
        // Both examples must include the score / verdict / issues / recommendations keys.
        assert!(suffix.contains("\"score\""));
        assert!(suffix.contains("\"verdict\""));
        assert!(suffix.contains("\"issues\""));
        assert!(suffix.contains("\"recommendations\""));
    }

    /// `system_prompt_suffix_constant_matches_method`: the
    /// exported constant and the trait method must agree.
    #[test]
    fn system_prompt_suffix_constant_matches_method() {
        assert_eq!(CriticMode.system_prompt_suffix(), CRITIC_SYSTEM_PROMPT);
    }
}
