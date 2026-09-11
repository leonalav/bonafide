//! Planner mode — ReAct loop for experiment sequencing.
//!
//! The Planner reads project memory and existing experiments, then proposes
//! new experiments that are well-scoped and avoid duplicate hypotheses.
//! Integration with the BudgetGovernor gates expensive run proposals.

use crate::agent::budget::{self, BudgetRegistry};
use crate::agent::experiments;
use crate::agent::compute_workspace_hash;
use crate::graph::storage;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

/// Input for proposing a new experiment.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposeExperimentInput {
    pub title: String,
    pub hypothesis: String,
    pub goal_metric: String,
    pub goal_direction: String,
    pub goal_target: f64,
    pub goal_condition: String,
    pub budget_dollars: f64,
    pub budget_gpu_hours: f64,
}

impl ProposeExperimentInput {
    pub fn into_experiment_row(self, id: String) -> experiments::ExperimentRow {
        let now = storage::current_timestamp();
        experiments::ExperimentRow {
            id,
            title: self.title,
            hypothesis: self.hypothesis,
            goal_metric: self.goal_metric,
            goal_direction: self.goal_direction,
            goal_target: self.goal_target,
            goal_condition: self.goal_condition,
            status: "proposed".to_string(),
            budget_dollars: self.budget_dollars,
            budget_gpu_hours: self.budget_gpu_hours,
            created_at: now,
            updated_at: now,
        }
    }
}

/// Result returned after proposing an experiment.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposeExperimentOutput {
    pub experiment_id: String,
    pub title: String,
    pub escalation: String,
    pub within_budget: bool,
}

/// Compute a stable experiment ID from the workspace hash + title.
pub fn compute_experiment_id(workspace_hash: &str, title: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(workspace_hash.as_bytes());
    hasher.update(title.as_bytes());
    let digest = hasher.finalize();
    format!("exp_{}", &hex::encode(&digest[..8])[..16])
}

/// Propose a new experiment, writing it to the workspace DB.
/// Checks the BudgetGovernor before recording any budget allocation.
pub async fn propose_experiment(
    budget_registry: &BudgetRegistry,
    workspace_root: &Path,
    input: ProposeExperimentInput,
) -> Result<ProposeExperimentOutput, String> {
    let workspace_hash = compute_workspace_hash(workspace_root);

    // Check actual workspace budget before committing to an expensive experiment.
    // A budget record is lazily created on first access.
    let within_budget = {
        let guard = budget_registry.read().await;
        match guard.get(&workspace_hash) {
            Some(budget) => input.budget_dollars <= budget.budget_dollars,
            None => true, // no budget set yet — allow the proposal
        }
    };

    let escalation = if within_budget {
        budget::record_tool_call(budget_registry, &workspace_hash, "launch_experiment_run")
            .await
            .map(|e| format!("{:?}", e).to_lowercase())
            .unwrap_or_else(|| "normal".to_string())
    } else {
        "critical".to_string()
    };

    // Write to DB.
    let (conn, _) = storage::open_workspace_db(workspace_root)
        .map_err(|e| format!("Failed to open workspace DB: {e}"))?;

    let id = compute_experiment_id(&workspace_hash, &input.title);
    let row = input.into_experiment_row(id.clone());

    experiments::create_experiment(&conn, &row)
        .map_err(|e| format!("Failed to create experiment: {e}"))?;

    Ok(ProposeExperimentOutput {
        experiment_id: id,
        title: row.title,
        escalation,
        within_budget,
    })
}

/// List all existing experiments for the workspace, used to avoid duplicate hypotheses.
#[allow(dead_code)]
pub async fn list_experiments_for_planner(
    workspace_root: &Path,
) -> Result<Vec<experiments::ExperimentRow>, String> {
    let (conn, _) = storage::open_workspace_db(workspace_root)
        .map_err(|e| format!("Failed to open workspace DB: {e}"))?;
    experiments::list_experiments(&conn)
        .map_err(|e| format!("Failed to list experiments: {e}"))
}

/// Read project insights from the workspace DB.
pub fn read_insights(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT finding FROM insights ORDER BY created_at DESC LIMIT 20")?;
    let rows = stmt.query_map([], |row| row.get(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Read project dead-ends from the workspace DB.
pub fn read_dead_ends(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT hypothesis FROM dead_ends ORDER BY created_at DESC LIMIT 10",
    )?;
    let rows = stmt.query_map([], |row| row.get(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
