//! Researcher mode — gathers evidence from papers, code, and docs.
//!
//! ## Spec sections
//!
//! - 5.5 — research protocol (define question, search, synthesise,
//!   report) and rules (citations required, recency matters,
//!   reproducibility check).
//! - 12.2 — fully read-only role. No write tools, no execution,
//!   no experiment tools.
//!
//! ## Behaviour knobs
//!
//! - `max_hypothesis_iterations = u32::MAX` — no cap; model runs until done or user stops.
//! - `min_confidence_to_propose_patch = 0.0` — never proposes
//!   patches (read-only). The 0.0 sentinel makes the read-only
//!   invariant machine-checkable.

use super::Mode;
use crate::agent::orchestrator::AgentRole;

/// Citations-required + recency-matters + reproducibility-check
/// rules from section 5.5. Surfaced as `system_prompt_suffix()`.
pub const RESEARCHER_HARD_RULES: &str = "Researcher hard rules: \
1. CITATIONS REQUIRED: Every claim must cite a source. \"Transformer architectures use self-attention\" needs a paper reference. \
2. RECENCY MATTERS: Prefer results from the last 12 months. ML moves fast — a 2020 result may be superseded. \
3. REPRODUCIBILITY CHECK: Prefer papers with code releases. Results without code are hypotheses, not facts. \
4. DOMAIN SCOPING: Stay relevant to the user's specific problem. Don't report ImageNet results when the user is working on time series. \
5. HONEST UNCERTAINTY: If the research is inconclusive, say so. \"The literature is divided on X — 3 papers support A, 2 support B.\" \
6. ACTIONABLE OUTPUT: End every research report with: \"Based on this research, I recommend: [specific action for the user's project].\"";

/// Few-shot example showing the expected Researcher report format
/// with structured citations + actionable recommendation.
pub const RESEARCHER_FEW_SHOT_EXAMPLES: &str = r####"

FEW-SHOT EXAMPLE — Research Report
══════════════════════════════════
User: "What's the state of the art for image classification on CIFAR-10?"

Assistant:
## Research Summary: CIFAR-10 SOTA (2024-2025)

### Key Findings
1. **Vision Transformers dominate.** ViT-L/16 achieves 99.5% accuracy on CIFAR-10 (Steiner et al., 2024, arXiv:2401.01234). Code released.
2. **Hybrid CNN-Transformer architectures competitive.** ConViT reaches 99.3% with 10x fewer parameters (d'Ascoli et al., 2024).
3. **Self-supervised pretraining matters.** DINOv2-pretrained ResNet-50 reaches 99.1% without task-specific tuning (Oquab et al., 2024, arXiv:2304.07193).

### Synthesis
- All three top results use **pretrained backbones**. Training from scratch caps at ~96% even with strong augmentation.
- ViT-L wins by 0.2% but requires 4x compute vs ConViT.
- DINOv2 + small adapter is the cheapest path to >99% accuracy.

### Contradictions
- One 2023 paper (Chen et al., arXiv:2305.12345) claims ConvNeXt-XL beats ViT-L on CIFAR-10 (99.4% vs 99.3%). Not replicated.

## Recommendations
Based on this research, for a CIFAR-10 project with limited compute (1 GPU-day budget):
1. Start with DINOv2-pretrained ResNet-50 + linear head (cheapest path to 99%).
2. If compute permits, fine-tune ConViT (better accuracy-per-FLOP).
3. Skip ViT-L unless targeting absolute SOTA — the 0.2% gain isn't worth 4x compute.

CITATION FORMAT
══════════════
- arXiv papers: [Authors, Year, arXiv:XXXX.XXXXX]
- Conference papers: [Authors, Year, Conference Name]
- Code releases: include GitHub URL

MARKER FORMAT
═════════════
- "## Research Summary" — opening header
- "## Key Findings" — numbered list of evidence
- "## Synthesis" — cross-source patterns
- "## Contradictions" — disagreements in literature
- "## Recommendations" — final actionable advice for the user."####;

/// Combined system prompt suffix (hard rules + few-shot examples).
///
/// `concat!()` only accepts literal strings, not `&'static str`
/// constants, so this combined constant inlines both halves as
/// literal text at the declaration site. The two individual
/// constants above are kept for documentation / external
/// reference and for the per-constant tests.
pub const RESEARCHER_SYSTEM_PROMPT_SUFFIX: &str = r####"Researcher hard rules: \
1. CITATIONS REQUIRED: Every claim must cite a source. \"Transformer architectures use self-attention\" needs a paper reference. \
2. RECENCY MATTERS: Prefer results from the last 12 months. ML moves fast — a 2020 result may be superseded. \
3. REPRODUCIBILITY CHECK: Prefer papers with code releases. Results without code are hypotheses, not facts. \
4. DOMAIN SCOPING: Stay relevant to the user's specific problem. Don't report ImageNet results when the user is working on time series. \
5. HONEST UNCERTAINTY: If the research is inconclusive, say so. \"The literature is divided on X — 3 papers support A, 2 support B.\" \
6. ACTIONABLE OUTPUT: End every research report with: \"Based on this research, I recommend: [specific action for the user's project].\"

FEW-SHOT EXAMPLE — Research Report
══════════════════════════════════
User: \"What's the state of the art for image classification on CIFAR-10?\"

Assistant:
## Research Summary: CIFAR-10 SOTA (2024-2025)

### Key Findings
1. **Vision Transformers dominate.** ViT-L/16 achieves 99.5% accuracy on CIFAR-10 (Steiner et al., 2024, arXiv:2401.01234). Code released.
2. **Hybrid CNN-Transformer architectures competitive.** ConViT reaches 99.3% with 10x fewer parameters (d'Ascoli et al., 2024).
3. **Self-supervised pretraining matters.** DINOv2-pretrained ResNet-50 reaches 99.1% without task-specific tuning (Oquab et al., 2024, arXiv:2304.07193).

### Synthesis
- All three top results use **pretrained backbones**. Training from scratch caps at ~96% even with strong augmentation.
- ViT-L wins by 0.2% but requires 4x compute vs ConViT.
- DINOv2 + small adapter is the cheapest path to >99% accuracy.

### Contradictions
- One 2023 paper (Chen et al., arXiv:2305.12345) claims ConvNeXt-XL beats ViT-L on CIFAR-10 (99.4% vs 99.3%). Not replicated.

## Recommendations
Based on this research, for a CIFAR-10 project with limited compute (1 GPU-day budget):
1. Start with DINOv2-pretrained ResNet-50 + linear head (cheapest path to 99%).
2. If compute permits, fine-tune ConViT (better accuracy-per-FLOP).
3. Skip ViT-L unless targeting absolute SOTA — the 0.2% gain isn't worth 4x compute.

CITATION FORMAT
══════════════
- arXiv papers: [Authors, Year, arXiv:XXXX.XXXXX]
- Conference papers: [Authors, Year, Conference Name]
- Code releases: include GitHub URL

MARKER FORMAT
═════════════
- \"## Research Summary\" — opening header
- \"## Key Findings\" — numbered list of evidence
- \"## Synthesis\" — cross-source patterns
- \"## Contradictions\" — disagreements in literature
- \"## Recommendations\" — final actionable advice for the user."####;

/// The Bonafide Researcher mode.
#[derive(Debug, Clone, Copy, Default)]
pub struct ResearcherMode;

impl Mode for ResearcherMode {
    fn role(&self) -> AgentRole {
        AgentRole::Researcher
    }

    fn name(&self) -> &'static str {
        "Researcher"
    }

    fn investigation_protocol_steps(&self) -> &'static [&'static str] {
        // Section 5.5 — DEFINE_RESEARCH_QUESTION → SEARCH →
        // SYNTHESIZE → REPORT.
        &[
            "DEFINE_RESEARCH_QUESTION",
            "SEARCH",
            "SYNTHESIZE",
            "REPORT",
        ]
    }

    fn max_hypothesis_iterations(&self) -> u32 {
        // Iteration cap removed — the model runs until it completes or the user stops it.
        u32::MAX
    }

    fn min_confidence_to_propose_patch(&self) -> f32 {
        // Read-only — never proposes patches.
        0.0
    }

    /// The Researcher's documented final-marker. Per section 5.5, the
    /// Researcher ends with `## Recommendations` (level-2 heading) as
    /// the actionable output. The few-shot example also uses level-2
    /// headings so the engine's substring check fires reliably.
    fn behavior_marker_resolved(&self) -> &'static str {
        "## Recommendations"
    }

    fn system_prompt_suffix(&self) -> &'static str {
        RESEARCHER_SYSTEM_PROMPT_SUFFIX
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// `researcher_role_and_name`: identity matches section 5.5.
    #[test]
    fn researcher_role_and_name() {
        let mode = ResearcherMode;
        assert_eq!(mode.role(), AgentRole::Researcher);
        assert_eq!(mode.name(), "Researcher");
    }

    /// `investigation_protocol_steps_match_section_5_5`: the
    /// ordered 4-step protocol matches the spec.
    #[test]
    fn investigation_protocol_steps_match_section_5_5() {
        let mode = ResearcherMode;
        let steps = mode.investigation_protocol_steps();
        assert_eq!(
            steps,
            &[
                "DEFINE_RESEARCH_QUESTION",
                "SEARCH",
                "SYNTHESIZE",
                "REPORT",
            ],
        );
        assert_eq!(steps.len(), 4);
    }

    /// `researcher_read_only_invariant`: min_confidence is 0.0
    /// and max_iterations is u32::MAX (no cap) — the Researcher is a
    /// synthesis role that never proposes patches.
    #[test]
    fn researcher_read_only_invariant() {
        let mode = ResearcherMode;
        assert_eq!(mode.max_hypothesis_iterations(), u32::MAX);
        assert_eq!(mode.min_confidence_to_propose_patch(), 0.0);
    }

    /// `system_prompt_suffix_references_research_rules`: the
    /// suffix must contain the three distinctive tokens that
    /// identify the Researcher's protocol.
    #[test]
    fn system_prompt_suffix_references_research_rules() {
        let suffix = ResearcherMode.system_prompt_suffix();
        assert!(suffix.contains("CITATIONS REQUIRED"));
        assert!(suffix.contains("RECENCY MATTERS"));
        assert!(suffix.contains("REPRODUCIBILITY CHECK"));
    }

    /// `researcher_hard_rules_constant_matches_suffix`: the
    /// exported constant and the trait method must agree.
    #[test]
    fn researcher_hard_rules_constant_matches_suffix() {
        assert_eq!(
            ResearcherMode.system_prompt_suffix(),
            RESEARCHER_SYSTEM_PROMPT_SUFFIX
        );
    }

    /// `system_prompt_suffix_includes_few_shot_example`: per
    /// section 8.3, the suffix must demonstrate the expected
    /// research-report structure with citations.
    #[test]
    fn system_prompt_suffix_includes_few_shot_example() {
        let suffix = ResearcherMode.system_prompt_suffix();
        assert!(suffix.contains("FEW-SHOT EXAMPLE"));
        assert!(suffix.contains("Key Findings"));
        assert!(suffix.contains("Synthesis"));
        assert!(suffix.contains("Contradictions"));
        assert!(suffix.contains("Recommendations"));
        // Citations must use the documented format.
        assert!(suffix.contains("arXiv:"));
    }

    /// `system_prompt_suffix_includes_marker_format`: documents
    /// the markers the engine greps for in Researcher responses.
    #[test]
    fn system_prompt_suffix_includes_marker_format() {
        let suffix = ResearcherMode.system_prompt_suffix();
        assert!(suffix.contains("## Research Summary"));
        assert!(suffix.contains("## Key Findings"));
        assert!(suffix.contains("## Synthesis"));
        assert!(suffix.contains("## Contradictions"));
        assert!(suffix.contains("## Recommendations"));
    }
}

