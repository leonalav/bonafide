//! Agent modes — per-role protocol, behaviour markers, and the
//! `ModeRegistry` that wires them into the engine.
//!
//! ## Spec sections
//!
//! - Section 5 — per-role protocol, behaviour markers, and
//!   investigation steps.
//! - Section 6.2 — single-agent mode switching (no sub-agent
//!   spawning). The agent's role changes by emitting a
//!   `ModeSwitch` event and updating `thread.role`; everything else
//!   (context, history, budget) is preserved.
//!
//! ## Trait design
//!
//! `Mode` is the contract every role implements. The defaults are
//! sensible so callers only override what they need (typically
//! `role`, `name`, `investigation_protocol_steps`, and the
//! `min_confidence_to_propose_patch` / `max_hypothesis_iterations`
//! thresholds).
//!
//! The trait is intentionally **not** an `async` trait — every
//! accessor returns a static slice / string / number, so the
//! engine can read it without entering an async context.
//!
//! ## Registry
//!
//! `ModeRegistry::default()` wires all five concrete modes. The
//! engine holds it behind `Arc<ModeRegistry>` so it can be cloned
//! across IPC handlers without rebuilding the lookup table. The
//! `for_role(role)` method gives the engine a single `Arc<dyn Mode>`
//! it can use to read the active role's protocol + markers.

use std::sync::Arc;

use crate::agent::orchestrator::AgentRole;

pub mod critic;
pub mod debugger;
pub mod planner;
pub mod researcher;
pub mod scaffolder;

pub use critic::{CriticVerdict, review_proposal};
pub use debugger::DebuggerMode;
pub use planner::PlannerMode;
pub use researcher::ResearcherMode;
pub use scaffolder::ScaffolderMode;

// ── Mode trait ────────────────────────────────────────────────────────────────

/// Behavioural contract every agent mode implements.
///
/// All accessors are pure (`&self` → static data) so the trait is
/// safe to hold behind `Arc<dyn Mode>` without lifetime or async
/// constraints. Defaults are sensible; concrete modes override
/// only what differs from their role.
///
/// ## Behaviour markers
///
/// The `behavior_marker_*` strings drive the engine's heuristic
/// state-machine transitions (see `engine.rs`). When the assistant
/// emits a message containing `behavior_marker_hypothesis`, the
/// loop transitions `Investigating → HypothesisFormed`. When a
/// final answer contains `behavior_marker_resolved`, the loop
/// transitions to `Resolved`.
///
/// Markers are exact substring matches — keep them stable across
/// the prompt + engine contract.
pub trait Mode: Send + Sync {
    /// The canonical `AgentRole` this mode implements.
    fn role(&self) -> AgentRole;

    /// Display name (PascalCase role title, e.g. `"Debugger"`).
    fn name(&self) -> &'static str;

    /// Ordered list of protocol steps the mode walks through.
    /// Used by the per-mode system-prompt layer to render the
    /// investigation plan. Keep these stable so a renderer-side
    /// step indicator can match them across the wire.
    fn investigation_protocol_steps(&self) -> &'static [&'static str];

    /// Maximum number of hypothesis iterations before the agent
    /// escalates. Set to `u32::MAX` (no cap) — iteration cap removed
    /// per user request.
    fn max_hypothesis_iterations(&self) -> u32 {
        u32::MAX
    }

    /// Minimum confidence level at which the agent may propose a
    /// patch autonomously. Below this threshold, the agent must
    /// keep gathering context or escalate.
    fn min_confidence_to_propose_patch(&self) -> f32 {
        0.5
    }

    /// Optional suffix appended to the per-mode system prompt
    /// (layer 3 in section 8.1). Default is empty so simple modes
    /// don't need to override. The Scaffolder uses this to surface
    /// its hard rules (config-first, no placeholders, etc.).
    fn system_prompt_suffix(&self) -> &'static str {
        ""
    }

    /// Substring the assistant emits when forming a hypothesis.
    /// Drives the `Investigating → HypothesisFormed` transition.
    fn behavior_marker_hypothesis(&self) -> &'static str {
        "## Hypothesis"
    }

    /// Substring the assistant emits when proposing a patch.
    /// Reserved for future use (the engine currently drives
    /// `Investigating → PatchProposed` via the `apply_patch` tool
    /// success heuristic).
    fn behavior_marker_patch(&self) -> &'static str {
        "## Patch"
    }

    /// Substring the assistant emits in its final answer when the
    /// investigation is complete. Drives the `→ Resolved` transition.
    fn behavior_marker_resolved(&self) -> &'static str {
        "## Resolved"
    }
}

// ── ModeRegistry ─────────────────────────────────────────────────────────────

/// Per-mode lookup table.
///
/// Holds one `Arc<dyn Mode>` per role. `for_role` gives the engine
/// a cloneable handle to the active role's protocol. `Arc` keeps
/// the registry cheap to clone across IPC handlers and the engine
/// inner loop.
#[derive(Clone)]
pub struct ModeRegistry {
    debugger: Arc<dyn Mode>,
    scaffolder: Arc<dyn Mode>,
    planner: Arc<dyn Mode>,
    researcher: Arc<dyn Mode>,
    critic: Arc<dyn Mode>,
}

impl std::fmt::Debug for ModeRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ModeRegistry")
            .field("debugger", &self.debugger.name())
            .field("scaffolder", &self.scaffolder.name())
            .field("planner", &self.planner.name())
            .field("researcher", &self.researcher.name())
            .field("critic", &self.critic.name())
            .finish()
    }
}

impl Default for ModeRegistry {
    /// Wire every concrete mode. The default is the production
    /// registry — tests that need a custom mode override `for_role`
    /// indirectly by constructing a `ModeRegistry` themselves.
    fn default() -> Self {
        Self {
            debugger: Arc::new(DebuggerMode),
            scaffolder: Arc::new(ScaffolderMode),
            planner: Arc::new(PlannerMode),
            researcher: Arc::new(ResearcherMode),
            critic: Arc::new(critic::CriticMode),
        }
    }
}

impl ModeRegistry {
    /// Construct a registry with custom mode implementations.
    /// Tests use this to swap in a counting `Mode` double.
    pub fn with_modes(
        debugger: Arc<dyn Mode>,
        scaffolder: Arc<dyn Mode>,
        planner: Arc<dyn Mode>,
        researcher: Arc<dyn Mode>,
        critic: Arc<dyn Mode>,
    ) -> Self {
        Self {
            debugger,
            scaffolder,
            planner,
            researcher,
            critic,
        }
    }

    /// Look up the mode for a given role. Always returns a concrete
    /// implementation — the `with_modes` constructor is the only
    /// way to install a custom one, and it requires all five.
    pub fn for_role(&self, role: AgentRole) -> Arc<dyn Mode> {
        match role {
            AgentRole::Debugger => self.debugger.clone(),
            AgentRole::Scaffolder => self.scaffolder.clone(),
            AgentRole::Planner => self.planner.clone(),
            AgentRole::Researcher => self.researcher.clone(),
            AgentRole::Critic => self.critic.clone(),
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// `default_registry_covers_all_five_roles`: every `AgentRole`
    /// variant must resolve to a concrete mode via `for_role` and
    /// the role / name pair must match the spec's identity strings.
    #[test]
    fn default_registry_covers_all_five_roles() {
        let registry = ModeRegistry::default();

        let debugger = registry.for_role(AgentRole::Debugger);
        assert_eq!(debugger.role(), AgentRole::Debugger);
        assert_eq!(debugger.name(), "Debugger");

        let scaffolder = registry.for_role(AgentRole::Scaffolder);
        assert_eq!(scaffolder.role(), AgentRole::Scaffolder);
        assert_eq!(scaffolder.name(), "Scaffolder");

        let planner = registry.for_role(AgentRole::Planner);
        assert_eq!(planner.role(), AgentRole::Planner);
        assert_eq!(planner.name(), "Planner");

        let researcher = registry.for_role(AgentRole::Researcher);
        assert_eq!(researcher.role(), AgentRole::Researcher);
        assert_eq!(researcher.name(), "Researcher");

        let critic = registry.for_role(AgentRole::Critic);
        assert_eq!(critic.role(), AgentRole::Critic);
        assert_eq!(critic.name(), "Critic");
    }

    /// `for_role_returns_cloneable_arc`: the returned handle must
    /// deref to the same mode when cloned twice. This is the
    /// invariant the engine relies on when handing the active mode
    /// to per-iteration logic.
    #[test]
    fn for_role_returns_cloneable_arc() {
        let registry = ModeRegistry::default();
        let a = registry.for_role(AgentRole::Planner);
        let b = registry.for_role(AgentRole::Planner);
        // Both Arcs deref to the same concrete type with the same
        // protocol steps (identity check via Arc pointer equality).
        assert!(Arc::ptr_eq(&a, &b));
        assert_eq!(
            a.investigation_protocol_steps(),
            b.investigation_protocol_steps()
        );
    }

    /// `default_trait_methods_are_sensible`: the trait defaults
    /// must produce non-empty defaults so modes that override only
    /// their identity still get a working protocol loop. This
    /// guards against a regression where a future refactor turns a
    /// default into an empty slice.
    #[test]
    fn default_trait_methods_are_sensible() {
        // Build a minimal mode that overrides only identity.
        struct MinimalMode;
        impl Mode for MinimalMode {
            fn role(&self) -> AgentRole {
                AgentRole::Debugger
            }
            fn name(&self) -> &'static str {
                "Minimal"
            }
            fn investigation_protocol_steps(&self) -> &'static [&'static str] {
                &["ONLY"]
            }
        }

        let m = MinimalMode;
        assert_eq!(m.max_hypothesis_iterations(), u32::MAX);
        assert!((m.min_confidence_to_propose_patch() - 0.5).abs() < f32::EPSILON);
        assert_eq!(m.behavior_marker_hypothesis(), "## Hypothesis");
        assert_eq!(m.behavior_marker_patch(), "## Patch");
        assert_eq!(m.behavior_marker_resolved(), "## Resolved");
        assert_eq!(m.system_prompt_suffix(), "");
    }

    /// `mode_trait_is_object_safe`: `Arc<dyn Mode>` must compile,
    /// which proves the trait has no `Self`-typed methods.
    #[test]
    fn mode_trait_is_object_safe() {
        fn assert_object_safe(_m: Arc<dyn Mode>) {}
        let registry = ModeRegistry::default();
        assert_object_safe(registry.for_role(AgentRole::Critic));
    }
}
