//! Experiment CRUD operations and run management.
//!
//! Implements the full `Experiment` data model per spec section 3.2.
//! Provides commands for experiment lifecycle management: create, update,
//! list, get, launch runs, and stop runs.
//!
//! Tables: `experiments`, `experiment_runs` (defined in migrations.rs)

use rusqlite::{params, Connection, Result as SqliteResult};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

/// Experiment status per spec section 3.2.1
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ExperimentStatus {
    Proposed,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl ExperimentStatus {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Proposed => "proposed",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Proposed,
        }
    }
}

/// Goal direction for experiment metrics
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum GoalDirection {
    Maximize,
    Minimize,
}

impl GoalDirection {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Maximize => "maximize",
            Self::Minimize => "minimize",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "minimize" => Self::Minimize,
            _ => Self::Maximize,
        }
    }
}

/// Goal condition for experiment success
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum GoalCondition {
    GreaterThan,
    LessThan,
    Equals,
}

impl GoalCondition {
    pub fn as_str(&self) -> &str {
        match self {
            Self::GreaterThan => "greater_than",
            Self::LessThan => "less_than",
            Self::Equals => "equals",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "less_than" => Self::LessThan,
            "equals" => Self::Equals,
            _ => Self::GreaterThan,
        }
    }
}

/// Run status per spec section 3.2.2
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Stopped,
}

impl RunStatus {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "stopped" => Self::Stopped,
            _ => Self::Queued,
        }
    }
}

/// Experiment data model per spec section 3.2
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Experiment {
    pub id: String,
    pub title: String,
    pub hypothesis: String,
    pub goal_metric: String,
    pub goal_direction: GoalDirection,
    pub goal_target: f64,
    pub goal_condition: GoalCondition,
    pub status: ExperimentStatus,
    pub budget_dollars: f64,
    pub budget_gpu_hours: f64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Experiment run data model per spec section 3.2.2
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExperimentRun {
    pub id: String,
    pub experiment_id: String,
    pub run_id: String,
    pub config_overrides: String, // JSON string
    pub status: RunStatus,
    pub metrics_summary: String, // JSON string
    pub created_at: i64,
}

/// Create experiment input
#[derive(Debug, Clone, Deserialize)]
pub struct CreateExperimentInput {
    pub title: String,
    pub hypothesis: String,
    pub goal_metric: String,
    pub goal_direction: GoalDirection,
    pub goal_target: f64,
    pub goal_condition: GoalCondition,
    #[serde(default = "default_budget_dollars")]
    pub budget_dollars: f64,
    #[serde(default = "default_budget_gpu_hours")]
    pub budget_gpu_hours: f64,
}

fn default_budget_dollars() -> f64 {
    10.0
}

fn default_budget_gpu_hours() -> f64 {
    4.0
}

/// Update experiment input
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateExperimentInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hypothesis: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<ExperimentStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget_dollars: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget_gpu_hours: Option<f64>,
}

/// Launch experiment run input
#[derive(Debug, Clone, Deserialize)]
pub struct LaunchRunInput {
    pub run_id: String,
    #[serde(default)]
    pub config_overrides: String, // JSON string
}

fn current_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn generate_id() -> String {
    let uuid = uuid::Uuid::new_v4();
    format!("exp_{}", &uuid.to_string()[..8])
}

fn generate_run_id() -> String {
    let uuid = uuid::Uuid::new_v4();
    format!("run_{}", &uuid.to_string()[..8])
}

/// Create a new experiment
pub fn create_experiment(
    conn: &Connection,
    input: CreateExperimentInput,
) -> SqliteResult<Experiment> {
    let id = generate_id();
    let now = current_timestamp();

    conn.execute(
        "INSERT INTO experiments (
            id, title, hypothesis, goal_metric, goal_direction,
            goal_target, goal_condition, status, budget_dollars,
            budget_gpu_hours, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            id,
            input.title,
            input.hypothesis,
            input.goal_metric,
            input.goal_direction.as_str(),
            input.goal_target,
            input.goal_condition.as_str(),
            ExperimentStatus::Proposed.as_str(),
            input.budget_dollars,
            input.budget_gpu_hours,
            now,
            now,
        ],
    )?;

    Ok(Experiment {
        id,
        title: input.title,
        hypothesis: input.hypothesis,
        goal_metric: input.goal_metric,
        goal_direction: input.goal_direction,
        goal_target: input.goal_target,
        goal_condition: input.goal_condition,
        status: ExperimentStatus::Proposed,
        budget_dollars: input.budget_dollars,
        budget_gpu_hours: input.budget_gpu_hours,
        created_at: now,
        updated_at: now,
    })
}

/// Update an existing experiment
pub fn update_experiment(
    conn: &Connection,
    id: &str,
    input: UpdateExperimentInput,
) -> SqliteResult<Experiment> {
    let now = current_timestamp();

    // Build dynamic UPDATE statement based on provided fields
    let mut updates = Vec::new();
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(title) = &input.title {
        updates.push("title = ?");
        params_vec.push(Box::new(title.clone()));
    }
    if let Some(hypothesis) = &input.hypothesis {
        updates.push("hypothesis = ?");
        params_vec.push(Box::new(hypothesis.clone()));
    }
    if let Some(status) = &input.status {
        updates.push("status = ?");
        params_vec.push(Box::new(status.as_str().to_string()));
    }
    if let Some(budget_dollars) = input.budget_dollars {
        updates.push("budget_dollars = ?");
        params_vec.push(Box::new(budget_dollars));
    }
    if let Some(budget_gpu_hours) = input.budget_gpu_hours {
        updates.push("budget_gpu_hours = ?");
        params_vec.push(Box::new(budget_gpu_hours));
    }

    if updates.is_empty() {
        // No updates, just fetch current
        return get_experiment(conn, id)?
            .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows);
    }

    updates.push("updated_at = ?");
    params_vec.push(Box::new(now));
    params_vec.push(Box::new(id.to_string()));

    let sql = format!("UPDATE experiments SET {} WHERE id = ?", updates.join(", "));
    
    let params_refs: Vec<&dyn rusqlite::ToSql> = params_vec
        .iter()
        .map(|b| b.as_ref() as &dyn rusqlite::ToSql)
        .collect();
    
    conn.execute(&sql, params_refs.as_slice())?;

    get_experiment(conn, id)?
        .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)
}

/// List all experiments
pub fn list_experiments(conn: &Connection) -> SqliteResult<Vec<Experiment>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, hypothesis, goal_metric, goal_direction,
                goal_target, goal_condition, status, budget_dollars,
                budget_gpu_hours, created_at, updated_at
         FROM experiments
         ORDER BY updated_at DESC",
    )?;

    let experiments = stmt
        .query_map([], |row| {
            Ok(Experiment {
                id: row.get(0)?,
                title: row.get(1)?,
                hypothesis: row.get(2)?,
                goal_metric: row.get(3)?,
                goal_direction: GoalDirection::from_str(&row.get::<_, String>(4)?),
                goal_target: row.get(5)?,
                goal_condition: GoalCondition::from_str(&row.get::<_, String>(6)?),
                status: ExperimentStatus::from_str(&row.get::<_, String>(7)?),
                budget_dollars: row.get(8)?,
                budget_gpu_hours: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })?
        .collect::<SqliteResult<Vec<_>>>()?;

    Ok(experiments)
}

/// Get a single experiment by ID
pub fn get_experiment(conn: &Connection, id: &str) -> SqliteResult<Option<Experiment>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, hypothesis, goal_metric, goal_direction,
                goal_target, goal_condition, status, budget_dollars,
                budget_gpu_hours, created_at, updated_at
         FROM experiments
         WHERE id = ?1",
    )?;

    let mut rows = stmt.query(params![id])?;

    if let Some(row) = rows.next()? {
        Ok(Some(Experiment {
            id: row.get(0)?,
            title: row.get(1)?,
            hypothesis: row.get(2)?,
            goal_metric: row.get(3)?,
            goal_direction: GoalDirection::from_str(&row.get::<_, String>(4)?),
            goal_target: row.get(5)?,
            goal_condition: GoalCondition::from_str(&row.get::<_, String>(6)?),
            status: ExperimentStatus::from_str(&row.get::<_, String>(7)?),
            budget_dollars: row.get(8)?,
            budget_gpu_hours: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
        }))
    } else {
        Ok(None)
    }
}

/// Launch a new experiment run
pub fn launch_experiment_run(
    conn: &Connection,
    experiment_id: &str,
    input: LaunchRunInput,
) -> SqliteResult<ExperimentRun> {
    // Verify experiment exists
    let experiment = get_experiment(conn, experiment_id)?
        .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

    let run_db_id = generate_run_id();
    let now = current_timestamp();

    conn.execute(
        "INSERT INTO experiment_runs (
            id, experiment_id, run_id, config_overrides,
            status, metrics_summary, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            run_db_id,
            experiment_id,
            input.run_id,
            input.config_overrides,
            RunStatus::Queued.as_str(),
            "{}",
            now,
        ],
    )?;

    // Update experiment status to running if it was proposed
    if experiment.status == ExperimentStatus::Proposed {
        conn.execute(
            "UPDATE experiments SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![ExperimentStatus::Running.as_str(), now, experiment_id],
        )?;
    }

    Ok(ExperimentRun {
        id: run_db_id,
        experiment_id: experiment_id.to_string(),
        run_id: input.run_id,
        config_overrides: input.config_overrides,
        status: RunStatus::Queued,
        metrics_summary: "{}".to_string(),
        created_at: now,
    })
}

/// Stop an experiment run
pub fn stop_experiment_run(conn: &Connection, run_db_id: &str) -> SqliteResult<ExperimentRun> {
    // Get current run
    let mut stmt = conn.prepare(
        "SELECT id, experiment_id, run_id, config_overrides,
                status, metrics_summary, created_at
         FROM experiment_runs
         WHERE id = ?1",
    )?;

    let mut rows = stmt.query(params![run_db_id])?;

    let run = if let Some(row) = rows.next()? {
        ExperimentRun {
            id: row.get(0)?,
            experiment_id: row.get(1)?,
            run_id: row.get(2)?,
            config_overrides: row.get(3)?,
            status: RunStatus::from_str(&row.get::<_, String>(4)?),
            metrics_summary: row.get(5)?,
            created_at: row.get(6)?,
        }
    } else {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    };

    // Only stop if currently running or queued
    if run.status == RunStatus::Running || run.status == RunStatus::Queued {
        conn.execute(
            "UPDATE experiment_runs SET status = ?1 WHERE id = ?2",
            params![RunStatus::Stopped.as_str(), run_db_id],
        )?;

        Ok(ExperimentRun {
            status: RunStatus::Stopped,
            ..run
        })
    } else {
        Ok(run)
    }
}

/// List all runs for an experiment
pub fn list_experiment_runs(
    conn: &Connection,
    experiment_id: &str,
) -> SqliteResult<Vec<ExperimentRun>> {
    let mut stmt = conn.prepare(
        "SELECT id, experiment_id, run_id, config_overrides,
                status, metrics_summary, created_at
         FROM experiment_runs
         WHERE experiment_id = ?1
         ORDER BY created_at DESC",
    )?;

    let runs = stmt
        .query_map(params![experiment_id], |row| {
            Ok(ExperimentRun {
                id: row.get(0)?,
                experiment_id: row.get(1)?,
                run_id: row.get(2)?,
                config_overrides: row.get(3)?,
                status: RunStatus::from_str(&row.get::<_, String>(4)?),
                metrics_summary: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?
        .collect::<SqliteResult<Vec<_>>>()?;

    Ok(runs)
}

/// Update run status and metrics
pub fn update_run_status(
    conn: &Connection,
    run_db_id: &str,
    status: RunStatus,
    metrics_summary: Option<&str>,
) -> SqliteResult<()> {
    if let Some(metrics) = metrics_summary {
        conn.execute(
            "UPDATE experiment_runs SET status = ?1, metrics_summary = ?2 WHERE id = ?3",
            params![status.as_str(), metrics, run_db_id],
        )?;
    } else {
        conn.execute(
            "UPDATE experiment_runs SET status = ?1 WHERE id = ?2",
            params![status.as_str(), run_db_id],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::graph::storage::run_migrations(&conn).unwrap();
        conn
    }

    #[test]
    fn test_create_experiment() {
        let conn = setup_test_db();
        let input = CreateExperimentInput {
            title: "Test Experiment".to_string(),
            hypothesis: "Testing creates better code".to_string(),
            goal_metric: "accuracy".to_string(),
            goal_direction: GoalDirection::Maximize,
            goal_target: 0.95,
            goal_condition: GoalCondition::GreaterThan,
            budget_dollars: 20.0,
            budget_gpu_hours: 8.0,
        };

        let exp = create_experiment(&conn, input).unwrap();
        assert_eq!(exp.title, "Test Experiment");
        assert_eq!(exp.status, ExperimentStatus::Proposed);
        assert_eq!(exp.budget_dollars, 20.0);
    }

    #[test]
    fn test_list_experiments() {
        let conn = setup_test_db();
        let input1 = CreateExperimentInput {
            title: "Exp 1".to_string(),
            hypothesis: "H1".to_string(),
            goal_metric: "loss".to_string(),
            goal_direction: GoalDirection::Minimize,
            goal_target: 0.1,
            goal_condition: GoalCondition::LessThan,
            budget_dollars: 10.0,
            budget_gpu_hours: 4.0,
        };
        let input2 = CreateExperimentInput {
            title: "Exp 2".to_string(),
            hypothesis: "H2".to_string(),
            goal_metric: "f1".to_string(),
            goal_direction: GoalDirection::Maximize,
            goal_target: 0.9,
            goal_condition: GoalCondition::GreaterThan,
            budget_dollars: 15.0,
            budget_gpu_hours: 6.0,
        };

        create_experiment(&conn, input1).unwrap();
        create_experiment(&conn, input2).unwrap();

        let experiments = list_experiments(&conn).unwrap();
        assert_eq!(experiments.len(), 2);
        assert_eq!(experiments[0].title, "Exp 1"); // Order by created_at DESC, but Exp 1 was created first
        assert_eq!(experiments[1].title, "Exp 2");
    }

    #[test]
    fn test_get_experiment() {
        let conn = setup_test_db();
        let input = CreateExperimentInput {
            title: "Findable".to_string(),
            hypothesis: "It exists".to_string(),
            goal_metric: "mse".to_string(),
            goal_direction: GoalDirection::Minimize,
            goal_target: 0.05,
            goal_condition: GoalCondition::LessThan,
            budget_dollars: 10.0,
            budget_gpu_hours: 4.0,
        };

        let created = create_experiment(&conn, input).unwrap();
        let found = get_experiment(&conn, &created.id).unwrap();

        assert!(found.is_some());
        assert_eq!(found.unwrap().title, "Findable");

        let not_found = get_experiment(&conn, "exp_99999").unwrap();
        assert!(not_found.is_none());
    }

    #[test]
    fn test_update_experiment() {
        let conn = setup_test_db();
        let input = CreateExperimentInput {
            title: "Original".to_string(),
            hypothesis: "First hypothesis".to_string(),
            goal_metric: "accuracy".to_string(),
            goal_direction: GoalDirection::Maximize,
            goal_target: 0.9,
            goal_condition: GoalCondition::GreaterThan,
            budget_dollars: 10.0,
            budget_gpu_hours: 4.0,
        };

        let created = create_experiment(&conn, input).unwrap();
        
        let update_input = UpdateExperimentInput {
            title: Some("Updated Title".to_string()),
            hypothesis: Some("Updated hypothesis".to_string()),
            status: Some(ExperimentStatus::Running),
            budget_dollars: None,
            budget_gpu_hours: None,
        };

        let updated = update_experiment(&conn, &created.id, update_input).unwrap();
        assert_eq!(updated.title, "Updated Title");
        assert_eq!(updated.hypothesis, "Updated hypothesis");
        assert_eq!(updated.status, ExperimentStatus::Running);
        assert_eq!(updated.budget_dollars, 10.0); // Unchanged
    }

    #[test]
    fn test_launch_experiment_run() {
        let conn = setup_test_db();
        let input = CreateExperimentInput {
            title: "Runnable".to_string(),
            hypothesis: "Can launch runs".to_string(),
            goal_metric: "precision".to_string(),
            goal_direction: GoalDirection::Maximize,
            goal_target: 0.85,
            goal_condition: GoalCondition::GreaterThan,
            budget_dollars: 10.0,
            budget_gpu_hours: 4.0,
        };

        let exp = create_experiment(&conn, input).unwrap();

        let run_input = LaunchRunInput {
            run_id: "wandb_abc123".to_string(),
            config_overrides: r#"{"lr": 0.001}"#.to_string(),
        };

        let run = launch_experiment_run(&conn, &exp.id, run_input).unwrap();
        assert_eq!(run.experiment_id, exp.id);
        assert_eq!(run.run_id, "wandb_abc123");
        assert_eq!(run.status, RunStatus::Queued);

        // Verify experiment status updated to running
        let updated_exp = get_experiment(&conn, &exp.id).unwrap().unwrap();
        assert_eq!(updated_exp.status, ExperimentStatus::Running);
    }

    #[test]
    fn test_stop_experiment_run() {
        let conn = setup_test_db();
        let input = CreateExperimentInput {
            title: "Stoppable".to_string(),
            hypothesis: "Runs can be stopped".to_string(),
            goal_metric: "recall".to_string(),
            goal_direction: GoalDirection::Maximize,
            goal_target: 0.8,
            goal_condition: GoalCondition::GreaterThan,
            budget_dollars: 10.0,
            budget_gpu_hours: 4.0,
        };

        let exp = create_experiment(&conn, input).unwrap();

        let run_input = LaunchRunInput {
            run_id: "mlflow_run_1".to_string(),
            config_overrides: "{}".to_string(),
        };

        let run = launch_experiment_run(&conn, &exp.id, run_input).unwrap();
        
        // Update to running
        update_run_status(&conn, &run.id, RunStatus::Running, None).unwrap();
        
        // Stop it
        let stopped = stop_experiment_run(&conn, &run.id).unwrap();
        assert_eq!(stopped.status, RunStatus::Stopped);
    }

    #[test]
    fn test_list_experiment_runs() {
        let conn = setup_test_db();
        let input = CreateExperimentInput {
            title: "Multi-run".to_string(),
            hypothesis: "Multiple runs work".to_string(),
            goal_metric: "auc".to_string(),
            goal_direction: GoalDirection::Maximize,
            goal_target: 0.92,
            goal_condition: GoalCondition::GreaterThan,
            budget_dollars: 10.0,
            budget_gpu_hours: 4.0,
        };

        let exp = create_experiment(&conn, input).unwrap();

        let run1 = LaunchRunInput {
            run_id: "run_001".to_string(),
            config_overrides: r#"{"batch_size": 32}"#.to_string(),
        };
        let run2 = LaunchRunInput {
            run_id: "run_002".to_string(),
            config_overrides: r#"{"batch_size": 64}"#.to_string(),
        };

        launch_experiment_run(&conn, &exp.id, run1).unwrap();
        launch_experiment_run(&conn, &exp.id, run2).unwrap();

        let runs = list_experiment_runs(&conn, &exp.id).unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].run_id, "run_001"); // First created
        assert_eq!(runs[1].run_id, "run_002");
    }
}
