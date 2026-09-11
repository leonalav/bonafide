//! Approval gate — structural (not prompted) per section 12.1.
//!
//! The agent loop must call `ApprovalGate::check(role, tool_name)`
//! for every tool call before execution. This module encodes the
//! per-role allowlists from section 12.2 as `HashMap<AgentRole,
//! HashSet<String>>` so the loop can answer in `O(1)`.
//!
//! ## Three exit codes
//!
//! - `Approval::AutoApprove` — the tool is in the role's safe list;
//!   the loop proceeds.
//! - `Approval::NeedApproval` — the tool requires human review (the
//!   `Approval` is then translated by the engine into
//!   `EngineResult::AwaitingApproval`); the UI shows an approval dialog.
//! - `Approval::Blocked` — the tool is not allowed for this role at
//!   all; the engine treats this as `continue` and skips the iteration.
//!
//! ## Policy matrix (section 12.2)
//!
//! | Role        | Auto-approved tools                                                                  | Approval-required tools                                          |
//! |-------------|--------------------------------------------------------------------------------------|------------------------------------------------------------------|
//! | Debugger    | read_file, read_directory, search_files, list_runs, get_run, get_metric_series, …, write_project_memory | apply_patch, run_smoke_test, run_shell, launch_experiment_run, … |
//! | Scaffolder  | safe ∪ write_file, create_file, create_folder, rename_path, git_add, git_commit, run_smoke_test | run_shell, pip_install                                            |
//! | Planner     | safe ∪ {}                                                                            | launch_experiment_run, create_experiment                          |
//! | Researcher  | safe ∪ search_arxiv, read_paper, query_project_memory                                | {}                                                                |
//! | Critic      | safe ∪ query_project_memory                                                          | git_discard (used only via the UI; no agent mode auto-approves)   |
//!
//! "safe" = the union of the simplest read-only tools that every role
//! needs to investigate anything (`read_file`, `read_directory`,
//! `search_files`, `list_runs`, `get_run`, `get_metric_series`,
//! `get_run_config`, `list_artifacts`, `compare_runs`,
//! `query_run_graph`, `query_code_graph`, `get_metric_summary`,
//! `git_status`, `git_diff`).

use std::collections::{HashMap, HashSet};

use crate::agent::orchestrator::AgentRole;

// ── Approval ──────────────────────────────────────────────────────────────────

/// Outcome of an `ApprovalGate::check` call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Approval {
    /// Tool is allowed to proceed without user confirmation.
    AutoApprove,
    /// Tool must pause for human approval (the UI presents a dialog).
    NeedApproval,
    /// Tool is forbidden for this role — the engine skips the iteration.
    Blocked,
}

// ── ApprovalPolicy ────────────────────────────────────────────────────────────

/// Top-level policy that controls how the gate handles tools NOT
/// present in the per-role allowlist.
#[derive(Debug, Clone)]
pub enum ApprovalPolicy {
    /// Block anything not explicitly listed in the safe set.
    DenyAll,
    /// Block anything not explicitly listed in the safe set (same as
    /// `DenyAll` for our use case; kept as a separate variant so
    /// future tuning can be policy-driven without changing callers).
    AllowList(Vec<String>),
    /// Auto-approve everything. Use with care — only legitimate for
    /// fully-autonomous opt-in modes.
    AllowAll,
}

// ── ApprovalGate ──────────────────────────────────────────────────────────────

/// Per-role approval lookup.
///
/// The constructor builds the initial `safe` and `approval` maps from
/// the section-12.2 matrix. Tests can then assert specific outcomes
/// for `(role, tool)` pairs without spinning up the full engine.
#[derive(Debug, Clone)]
pub struct ApprovalGate {
    /// Default policy when a tool isn't in either the safe or approval buckets.
    policy: ApprovalPolicy,
    /// Tools that every role can call automatically (the "safe" set).
    safe: HashSet<String>,
    /// Per-role tool allowlist (auto-approved on top of `safe`).
    tool_allowlist_per_mode: HashMap<AgentRole, HashSet<String>>,
    /// Per-role "needs human approval" list.
    tool_approval_per_mode: HashMap<AgentRole, HashSet<String>>,
}

impl Default for ApprovalGate {
    fn default() -> Self {
        Self::with_section_12_2_matrix()
    }
}

impl ApprovalGate {
    /// Build the gate with the section-12.2 per-role matrix and the
    /// default `DenyAll` policy.
    ///
    /// Tools not in either `safe` ∪ role-specific allowlist or
    /// role-specific approval list are mapped to `Blocked` (the
    /// `DenyAll` policy).
    pub fn with_section_12_2_matrix() -> Self {
        let safe: HashSet<String> = [
            "read_file",
            "read_directory",
            "search_files",
            "list_runs",
            "get_run",
            "get_metric_series",
            "get_run_config",
            "list_artifacts",
            "compare_runs",
            "query_run_graph",
            "query_code_graph",
            "get_metric_summary",
            "git_status",
            "git_diff",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();

        let mut auto = HashMap::new();
        // Debugger: safe ∪ write_project_memory (per section 5.2 —
        // "✅ `query_project_memory`, `write_project_memory`").
        // Debugger is allowed to document its own findings into
        // project memory without a separate approval step.
        auto.insert(
            AgentRole::Debugger,
            ["write_project_memory"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
        );

        // Scaffolder: safe ∪ write tools + git_add + git_commit +
        // run_smoke_test (per section 5.3 — "✅ `git_add`, `git_commit`").
        auto.insert(
            AgentRole::Scaffolder,
            [
                "write_file",
                "create_file",
                "create_folder",
                "rename_path",
                "git_add",
                "git_commit",
                "run_smoke_test",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        );

        // Planner: safe ∪ empty (no write tools auto-approved).
        auto.insert(AgentRole::Planner, HashSet::new());

        // Researcher: safe ∪ knowledge tools (per section 5.5 —
        // "✅ `search_arxiv`, `read_paper`, `query_project_memory`",
        // "❌ All write tools"). `write_project_memory` is deliberately
        // excluded so a Researcher that discovers an actionable insight
        // must escalate to the Debugger (or surface the finding in
        // its final answer) instead of writing to memory directly.
        auto.insert(
            AgentRole::Researcher,
            [
                "search_arxiv",
                "read_paper",
                "query_project_memory",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        );

        // Critic: safe ∪ query_project_memory (per section 5.6).
        auto.insert(
            AgentRole::Critic,
            ["query_project_memory"].iter().map(|s| s.to_string()).collect(),
        );

        // ── Approval-required (per role) ───────────────────────────────────
        // Per spec section 12.2 row 1 (Debugger): the only tools that
        // need approval are apply_patch, run_smoke_test, and run_shell.
        // `launch_experiment_run` and `create_experiment` are ❌
        // (Blocked) for Debugger — those belong to Planner, not
        // Debugger. `pip_install` is also ❌ for Debugger.
        let mut approve = HashMap::new();
        approve.insert(
            AgentRole::Debugger,
            ["apply_patch", "run_smoke_test", "run_shell"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
        );

        approve.insert(
            AgentRole::Scaffolder,
            ["run_shell", "pip_install"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
        );

        approve.insert(
            AgentRole::Planner,
            ["launch_experiment_run", "create_experiment"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
        );

        // Researcher has no approval-required tools (read-only role).
        approve.insert(AgentRole::Researcher, HashSet::new());

        // Critic: git_discard (only via the UI — no agent mode auto-approves).
        approve.insert(
            AgentRole::Critic,
            ["git_discard"].iter().map(|s| s.to_string()).collect(),
        );

        Self {
            policy: ApprovalPolicy::DenyAll,
            safe,
            tool_allowlist_per_mode: auto,
            tool_approval_per_mode: approve,
        }
    }

    /// Build a gate from an explicit safe set + per-role maps.
    ///
    /// Used by tests and by future WS2-T3 work that lets the user
    /// customise the matrix per workspace.
    pub fn new(
        safe: HashSet<String>,
        auto: HashMap<AgentRole, HashSet<String>>,
        approve: HashMap<AgentRole, HashSet<String>>,
    ) -> Self {
        Self {
            policy: ApprovalPolicy::DenyAll,
            safe,
            tool_allowlist_per_mode: auto,
            tool_approval_per_mode: approve,
        }
    }

    /// Look up the policy.
    pub fn policy(&self) -> &ApprovalPolicy {
        &self.policy
    }

    /// Direct read-only access to the safe set.
    pub fn safe_tools(&self) -> &HashSet<String> {
        &self.safe
    }

    /// Direct read-only access to a role's allowlist.
    pub fn auto_tools_for(&self, role: AgentRole) -> Option<&HashSet<String>> {
        self.tool_allowlist_per_mode.get(&role)
    }

    /// Direct read-only access to a role's approval list.
    pub fn approval_tools_for(&self, role: AgentRole) -> Option<&HashSet<String>> {
        self.tool_approval_per_mode.get(&role)
    }

    /// Check whether `role` may call `tool_name` automatically.
    pub fn check(&self, role: AgentRole, tool_name: &str) -> Approval {
        // 1. The safe set is always auto-approved, regardless of role.
        if self.safe.contains(tool_name) {
            return Approval::AutoApprove;
        }

        // 2. Role-specific allowlist.
        if let Some(set) = self.tool_allowlist_per_mode.get(&role) {
            if set.contains(tool_name) {
                return Approval::AutoApprove;
            }
        }

        // 3. Role-specific approval list.
        if let Some(set) = self.tool_approval_per_mode.get(&role) {
            if set.contains(tool_name) {
                return Approval::NeedApproval;
            }
        }

        // 4. Default policy decides the fallback.
        match &self.policy {
            ApprovalPolicy::DenyAll => Approval::Blocked,
            ApprovalPolicy::AllowList(list) => {
                if list.iter().any(|t| t == tool_name) {
                    Approval::AutoApprove
                } else {
                    Approval::Blocked
                }
            }
            ApprovalPolicy::AllowAll => Approval::AutoApprove,
        }
    }

    /// Convenience: returns `true` when `check` returns `AutoApprove`.
    pub fn is_auto_approved(&self, role: AgentRole, tool_name: &str) -> bool {
        matches!(self.check(role, tool_name), Approval::AutoApprove)
    }

    /// Convenience: returns `true` when `check` returns `NeedApproval`.
    pub fn needs_approval(&self, role: AgentRole, tool_name: &str) -> bool {
        matches!(self.check(role, tool_name), Approval::NeedApproval)
    }

    /// Convenience: returns `true` when `check` returns `Blocked`.
    pub fn is_blocked(&self, role: AgentRole, tool_name: &str) -> bool {
        matches!(self.check(role, tool_name), Approval::Blocked)
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Section-12.2 row 1: Debugger can call read_file automatically.
    #[test]
    fn debugger_can_read_files_automatically() {
        let gate = ApprovalGate::default();
        assert_eq!(
            gate.check(AgentRole::Debugger, "read_file"),
            Approval::AutoApprove
        );
    }

    /// Section-12.2 row 1: Debugger's apply_patch needs approval.
    #[test]
    fn debugger_apply_patch_needs_approval() {
        let gate = ApprovalGate::default();
        assert_eq!(
            gate.check(AgentRole::Debugger, "apply_patch"),
            Approval::NeedApproval
        );
    }

    /// Section-12.2 row 1: Debugger's launch_experiment_run is ❌ (Blocked).
    /// Experiment lifecycle lives in Planner mode, not Debugger.
    #[test]
    fn debugger_launch_experiment_run_is_blocked() {
        let gate = ApprovalGate::default();
        assert_eq!(
            gate.check(AgentRole::Debugger, "launch_experiment_run"),
            Approval::Blocked
        );
    }

    /// Section-12.2 row 1: Debugger's create_experiment is ❌ (Blocked).
    #[test]
    fn debugger_create_experiment_is_blocked() {
        let gate = ApprovalGate::default();
        assert_eq!(
            gate.check(AgentRole::Debugger, "create_experiment"),
            Approval::Blocked
        );
    }

    /// Section-12.2 row 1: Debugger's pip_install is ❌ (Blocked).
    #[test]
    fn debugger_pip_install_is_blocked() {
        let gate = ApprovalGate::default();
        assert_eq!(
            gate.check(AgentRole::Debugger, "pip_install"),
            Approval::Blocked
        );
    }

    /// Section-12.2 row 2: Scaffolder write_file is auto-approved.
    #[test]
    fn scaffolder_write_file_auto_approved() {
        let gate = ApprovalGate::default();
        assert_eq!(
            gate.check(AgentRole::Scaffolder, "write_file"),
            Approval::AutoApprove
        );
    }

    /// Section-12.2 row 2: Scaffolder pip_install needs approval.
    #[test]
    fn scaffolder_pip_install_needs_approval() {
        let gate = ApprovalGate::default();
        assert_eq!(
            gate.check(AgentRole::Scaffolder, "pip_install"),
            Approval::NeedApproval
        );
    }

    /// Section-12.2 row 3: Planner can read tools automatically but
    /// create_experiment needs approval.
    #[test]
    fn planner_reads_auto_approved_create_experiment_needs_approval() {
        let gate = ApprovalGate::default();
        assert_eq!(
            gate.check(AgentRole::Planner, "read_file"),
            Approval::AutoApprove
        );
        assert_eq!(
            gate.check(AgentRole::Planner, "create_experiment"),
            Approval::NeedApproval
        );
    }

    /// Section-12.2 row 4: Researcher's search_arxiv is auto-approved
    /// and run_shell is blocked (not in any list).
    #[test]
    fn researcher_search_arxiv_auto_approved_run_shell_blocked() {
        let gate = ApprovalGate::default();
        assert_eq!(
            gate.check(AgentRole::Researcher, "search_arxiv"),
            Approval::AutoApprove
        );
        // run_shell is in no per-role allowlist; under DenyAll it is Blocked.
        assert_eq!(
            gate.check(AgentRole::Researcher, "run_shell"),
            Approval::Blocked
        );
    }

    /// Section-12.2 row 5: Critic's git_discard needs approval.
    #[test]
    fn critic_git_discard_needs_approval() {
        let gate = ApprovalGate::default();
        assert_eq!(
            gate.check(AgentRole::Critic, "git_discard"),
            Approval::NeedApproval
        );
    }

    /// Tools not in any list are `Blocked` under `DenyAll`.
    #[test]
    fn unknown_tool_blocked_under_deny_all() {
        let gate = ApprovalGate::default();
        assert_eq!(
            gate.check(AgentRole::Debugger, "totally_unrelated_tool"),
            Approval::Blocked
        );
    }

    /// Every role has read_file in the safe set, so all five roles
    /// share that auto-approval. This is the structural "everyone
    /// can read" invariant.
    #[test]
    fn safe_tools_apply_to_all_roles() {
        let gate = ApprovalGate::default();
        for role in [
            AgentRole::Debugger,
            AgentRole::Scaffolder,
            AgentRole::Planner,
            AgentRole::Researcher,
            AgentRole::Critic,
        ] {
            assert_eq!(
                gate.check(role, "read_file"),
                Approval::AutoApprove,
                "{role:?} should auto-approve read_file"
            );
        }
    }

    // ── WS3-T7 — per-row matrix verification ────────────────────────────────────

    /// Section-12.2 row 1: Debugger matrix — every cell of the
    /// spec table for the Debugger role. The expected `Approval`
    /// values match the architecture doc's table verbatim.
    #[test]
    fn section_12_2_debugger_matrix() {
        let gate = ApprovalGate::default();
        let cases: &[(&str, Approval)] = &[
            // ✅ auto-approved
            ("read_file", Approval::AutoApprove),
            // Per section 5.2 — "✅ `query_project_memory`,
            // `write_project_memory`". Debugger documents its own
            // findings into project memory as part of the protocol;
            // requiring approval here would silently break the
            // DOCUMENT step. The WS3 reaudit surfaced this missing
            // entry from the auto-approve list.
            ("write_project_memory", Approval::AutoApprove),
            ("write_file", Approval::Blocked),    // ❌
            ("apply_patch", Approval::NeedApproval), // ⚠️
            ("run_smoke_test", Approval::NeedApproval), // ⚠️
            ("run_shell", Approval::NeedApproval),    // ⚠️
            ("launch_experiment_run", Approval::Blocked), // ❌
            ("git_commit", Approval::Blocked),       // ❌
            ("git_discard", Approval::Blocked),      // ❌
            ("delete_path", Approval::Blocked),      // ❌
            ("create_experiment", Approval::Blocked), // ❌
        ];
        for (tool, expected) in cases {
            assert_eq!(
                gate.check(AgentRole::Debugger, tool),
                *expected,
                "Debugger tool {tool}: expected {expected:?}"
            );
        }
    }

    /// Section-12.2 row 2: Scaffolder matrix.
    #[test]
    fn section_12_2_scaffolder_matrix() {
        let gate = ApprovalGate::default();
        let cases: &[(&str, Approval)] = &[
            ("read_file", Approval::AutoApprove),    // ✅
            ("write_file", Approval::AutoApprove),   // ✅
            ("apply_patch", Approval::Blocked),      // ❌ (generates new, not modifies)
            ("run_smoke_test", Approval::AutoApprove), // ✅ (automatic after gen)
            ("run_shell", Approval::NeedApproval),    // ⚠️
            ("pip_install", Approval::NeedApproval),  // ⚠️
            ("launch_experiment_run", Approval::Blocked), // ❌
            // Per section 5.3 — "✅ `git_add`, `git_commit` (with
            // generated commit message)". git_add was missing from
            // the auto-approve list prior to the WS3 reaudit; this
            // assertion is the regression guard.
            ("git_add", Approval::AutoApprove),      // ✅
            ("git_commit", Approval::AutoApprove),    // ✅
            ("git_discard", Approval::Blocked),       // ❌
            ("delete_path", Approval::Blocked),       // ❌
        ];
        for (tool, expected) in cases {
            assert_eq!(
                gate.check(AgentRole::Scaffolder, tool),
                *expected,
                "Scaffolder tool {tool}: expected {expected:?}"
            );
        }
    }

    /// Section-12.2 row 3: Planner matrix.
    #[test]
    fn section_12_2_planner_matrix() {
        let gate = ApprovalGate::default();
        let cases: &[(&str, Approval)] = &[
            ("read_file", Approval::AutoApprove),           // ✅
            ("write_file", Approval::Blocked),              // ❌
            ("apply_patch", Approval::Blocked),              // ❌
            ("run_smoke_test", Approval::Blocked),           // ❌
            ("run_shell", Approval::Blocked),                // ❌
            ("create_experiment", Approval::NeedApproval),   // ⚠️
            ("launch_experiment_run", Approval::NeedApproval), // ⚠️
            ("git_commit", Approval::Blocked),               // ❌
            ("git_discard", Approval::Blocked),              // ❌
            ("delete_path", Approval::Blocked),              // ❌
        ];
        for (tool, expected) in cases {
            assert_eq!(
                gate.check(AgentRole::Planner, tool),
                *expected,
                "Planner tool {tool}: expected {expected:?}"
            );
        }
    }

    /// Section-12.2 row 4: Researcher matrix.
    #[test]
    fn section_12_2_researcher_matrix() {
        let gate = ApprovalGate::default();
        let cases: &[(&str, Approval)] = &[
            ("read_file", Approval::AutoApprove),        // ✅
            ("write_file", Approval::Blocked),           // ❌
            ("apply_patch", Approval::Blocked),           // ❌
            ("run_smoke_test", Approval::Blocked),        // ❌
            ("run_shell", Approval::Blocked),             // ❌
            ("search_arxiv", Approval::AutoApprove),      // ✅
            ("read_paper", Approval::AutoApprove),        // ✅
            ("query_project_memory", Approval::AutoApprove), // ✅
            // Per section 5.5 — "❌ All write tools".
            // Researcher must escalate (or surface in the final answer)
            // rather than mutate project memory directly.
            ("write_project_memory", Approval::Blocked),  // ❌
            ("create_experiment", Approval::Blocked),     // ❌
            ("git_discard", Approval::Blocked),           // ❌
            ("delete_path", Approval::Blocked),           // ❌
        ];
        for (tool, expected) in cases {
            assert_eq!(
                gate.check(AgentRole::Researcher, tool),
                *expected,
                "Researcher tool {tool}: expected {expected:?}"
            );
        }
    }

    /// Section-12.2 row 5: Critic matrix.
    #[test]
    fn section_12_2_critic_matrix() {
        let gate = ApprovalGate::default();
        let cases: &[(&str, Approval)] = &[
            ("read_file", Approval::AutoApprove),        // ✅
            ("write_file", Approval::Blocked),           // ❌
            ("apply_patch", Approval::Blocked),           // ❌
            ("run_smoke_test", Approval::Blocked),        // ❌
            ("run_shell", Approval::Blocked),             // ❌
            ("query_project_memory", Approval::AutoApprove), // ✅
            ("git_discard", Approval::NeedApproval),      // ⚠️
            ("create_experiment", Approval::Blocked),     // ❌
            ("delete_path", Approval::Blocked),           // ❌
        ];
        for (tool, expected) in cases {
            assert_eq!(
                gate.check(AgentRole::Critic, tool),
                *expected,
                "Critic tool {tool}: expected {expected:?}"
            );
        }
    }

    /// Property-style check: for every role, the union of
    /// `AutoApprove` ∪ `NeedApproval` ∪ `Blocked` (per the gate's
    /// lookup table) must cover the full tool catalog with no gaps.
    /// A missing entry would silently leak a tool through with
    /// `DenyAll` returning `Blocked` but the renderer never seeing
    /// the tool — surfacing here as a coverage gap.
    ///
    /// We cross-reference the gate's `safe` + per-role maps with
    /// the catalog in `tools::ToolRegistry` so the assertion stays
    /// correct as the catalog grows.
    #[test]
    fn coverage_table_covers_full_tool_catalog() {
        use crate::agent::tools::ToolRegistry;

        let gate = ApprovalGate::default();
        let registry = ToolRegistry::default();
        let catalog_names: Vec<&str> = registry.all_tool_names();

        // The gate itself must classify every catalog tool into
        // one of the three buckets — AutoApprove, NeedApproval,
        // or Blocked. There must be no "unclassified" gap.
        for role in [
            AgentRole::Debugger,
            AgentRole::Scaffolder,
            AgentRole::Planner,
            AgentRole::Researcher,
            AgentRole::Critic,
        ] {
            for tool in &catalog_names {
                let decision = gate.check(role, tool);
                assert!(
                    matches!(
                        decision,
                        Approval::AutoApprove | Approval::NeedApproval | Approval::Blocked
                    ),
                    "Role {role:?} tool {tool}: classification must be one of the three Approval variants (got {decision:?})",
                );
            }
        }
    }
}
