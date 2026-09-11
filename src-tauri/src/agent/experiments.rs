//! Experiment storage — SQLite schema + CRUD for the experiment-tracking subsystem.
//!
//! Each experiment represents one hypothesis + goal + budget triple. Runs live
//! in `experiment_runs` (a child of `experiments`). The workspace DB is opened
//! via `graph::storage::open_workspace_db` so migrations run automatically.

use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};

use crate::graph::storage::current_timestamp;

// ── Domain types ───────────────────────────────────────────────────────────────

/// Goal condition operator applied to `goal_metric`.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GoalCondition {
    Lt,  // metric < target
    Gt,  // metric > target
    Eq,  // metric == target
}

impl GoalCondition {
    pub fn from_str(s: &str) -> Self {
        match s {
            "lt" => GoalCondition::Lt,
            "gt" => GoalCondition::Gt,
            "eq" => GoalCondition::Eq,
            _ => GoalCondition::Lt,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            GoalCondition::Lt => "lt",
            GoalCondition::Gt => "gt",
            GoalCondition::Eq => "eq",
        }
    }
}

/// Direction of a goal metric — lower is better or higher is better.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GoalDirection {
    Minimize,
    Maximize,
}

impl GoalDirection {
    pub fn from_str(s: &str) -> Self {
        match s {
            "minimize" => GoalDirection::Minimize,
            "maximize" => GoalDirection::Maximize,
            _ => GoalDirection::Maximize,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            GoalDirection::Minimize => "minimize",
            GoalDirection::Maximize => "maximize",
        }
    }
}

/// Experiment lifecycle state.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExperimentStatus {
    Proposed,
    Running,
    Completed,
    Failed,
    Abandoned,
}

impl ExperimentStatus {
    pub fn from_str(s: &str) -> Self {
        match s {
            "proposed" => ExperimentStatus::Proposed,
            "running" => ExperimentStatus::Running,
            "completed" => ExperimentStatus::Completed,
            "failed" => ExperimentStatus::Failed,
            "abandoned" => ExperimentStatus::Abandoned,
            _ => ExperimentStatus::Proposed,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            ExperimentStatus::Proposed => "proposed",
            ExperimentStatus::Running => "running",
            ExperimentStatus::Completed => "completed",
            ExperimentStatus::Failed => "failed",
            ExperimentStatus::Abandoned => "abandoned",
        }
    }
}

/// Run-level status.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Queued,
    Running,
    Success,
    Failed,
}

impl RunStatus {
    pub fn from_str(s: &str) -> Self {
        match s {
            "queued" => RunStatus::Queued,
            "running" => RunStatus::Running,
            "success" => RunStatus::Success,
            "failed" => RunStatus::Failed,
            _ => RunStatus::Queued,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            RunStatus::Queued => "queued",
            RunStatus::Running => "running",
            RunStatus::Success => "success",
            RunStatus::Failed => "failed",
        }
    }
}

/// Persisted experiment row. Mirrors the TS `Experiment` type.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentRow {
    pub id: String,
    pub title: String,
    pub hypothesis: String,
    pub goal_metric: String,
    pub goal_direction: String,
    pub goal_target: f64,
    pub goal_condition: String,
    pub status: String,
    pub budget_dollars: f64,
    pub budget_gpu_hours: f64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Persisted experiment run row.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentRunRow {
    pub id: String,
    pub experiment_id: String,
    pub run_id: String,
    pub config_overrides: String,
    pub status: String,
    pub metrics_summary: String,
    pub created_at: i64,
}

// ── Migration helpers ─────────────────────────────────────────────────────────

/// Experiments tables are created by `graph::storage::run_migrations`.
/// This module exposes only CRUD — no migration logic here.

// ── Experiment CRUD ────────────────────────────────────────────────────────────

/// Insert a new experiment. Returns the inserted row.
pub fn create_experiment(conn: &Connection, row: &ExperimentRow) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO experiments (
            id, title, hypothesis, goal_metric, goal_direction, goal_target,
            goal_condition, status, budget_dollars, budget_gpu_hours, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        "#,
        params![
            row.id,
            row.title,
            row.hypothesis,
            row.goal_metric,
            row.goal_direction,
            row.goal_target,
            row.goal_condition,
            row.status,
            row.budget_dollars,
            row.budget_gpu_hours,
            row.created_at,
            row.updated_at,
        ],
    )?;
    Ok(())
}

/// List all experiments for a workspace, newest-first.
pub fn list_experiments(conn: &Connection) -> Result<Vec<ExperimentRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, hypothesis, goal_metric, goal_direction, goal_target,
                goal_condition, status, budget_dollars, budget_gpu_hours,
                created_at, updated_at
           FROM experiments
          ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ExperimentRow {
            id: row.get(0)?,
            title: row.get(1)?,
            hypothesis: row.get(2)?,
            goal_metric: row.get(3)?,
            goal_direction: row.get(4)?,
            goal_target: row.get(5)?,
            goal_condition: row.get(6)?,
            status: row.get(7)?,
            budget_dollars: row.get(8)?,
            budget_gpu_hours: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Fetch a single experiment by id.
pub fn get_experiment(conn: &Connection, id: &str) -> Result<Option<ExperimentRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, hypothesis, goal_metric, goal_direction, goal_target,
                goal_condition, status, budget_dollars, budget_gpu_hours,
                created_at, updated_at
           FROM experiments
          WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], |row| {
        Ok(ExperimentRow {
            id: row.get(0)?,
            title: row.get(1)?,
            hypothesis: row.get(2)?,
            goal_metric: row.get(3)?,
            goal_direction: row.get(4)?,
            goal_target: row.get(5)?,
            goal_condition: row.get(6)?,
            status: row.get(7)?,
            budget_dollars: row.get(8)?,
            budget_gpu_hours: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
        })
    })?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

/// Update an experiment. Only updates the fields that are safe to change
/// mid-experiment (title, hypothesis, goal, budget, status).
pub fn update_experiment(conn: &Connection, row: &ExperimentRow) -> Result<()> {
    let updated_at = current_timestamp();
    conn.execute(
        r#"
        UPDATE experiments SET
            title           = excluded.title,
            hypothesis      = excluded.hypothesis,
            goal_metric     = excluded.goal_metric,
            goal_direction  = excluded.goal_direction,
            goal_target     = excluded.goal_target,
            goal_condition  = excluded.goal_condition,
            status          = excluded.status,
            budget_dollars  = excluded.budget_dollars,
            budget_gpu_hours= excluded.budget_gpu_hours,
            updated_at      = ?1
        WHERE id = excluded.id
        "#,
        params![
            updated_at,
            row.title,
            row.hypothesis,
            row.goal_metric,
            row.goal_direction,
            row.goal_target,
            row.goal_condition,
            row.status,
            row.budget_dollars,
            row.budget_gpu_hours,
        ],
    )?;
    Ok(())
}

/// Delete an experiment and all its runs (CASCADE).
pub fn delete_experiment(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM experiments WHERE id = ?1", params![id])?;
    Ok(())
}

// ── Experiment Run CRUD ───────────────────────────────────────────────────────

/// Insert a new experiment run.
pub fn create_experiment_run(conn: &Connection, row: &ExperimentRunRow) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO experiment_runs (
            id, experiment_id, run_id, config_overrides, status, metrics_summary, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
        params![
            row.id,
            row.experiment_id,
            row.run_id,
            row.config_overrides,
            row.status,
            row.metrics_summary,
            row.created_at,
        ],
    )?;
    Ok(())
}

/// List all runs for an experiment, newest-first.
pub fn list_experiment_runs(
    conn: &Connection,
    experiment_id: &str,
) -> Result<Vec<ExperimentRunRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, experiment_id, run_id, config_overrides, status, metrics_summary, created_at
           FROM experiment_runs
          WHERE experiment_id = ?1
          ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(params![experiment_id], |row| {
        Ok(ExperimentRunRow {
            id: row.get(0)?,
            experiment_id: row.get(1)?,
            run_id: row.get(2)?,
            config_overrides: row.get(3)?,
            status: row.get(4)?,
            metrics_summary: row.get(5)?,
            created_at: row.get(6)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Update an experiment run's status and/or metrics_summary.
pub fn update_experiment_run(
    conn: &Connection,
    id: &str,
    status: &str,
    metrics_summary: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE experiment_runs SET status = ?2, metrics_summary = ?3 WHERE id = ?1",
        params![id, status, metrics_summary],
    )?;
    Ok(())
}
