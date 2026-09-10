// Integration tests for the tracker module.
//
// We don't have a real MLflow server (or W&B credentials) wired into
// the test environment, so the tests focus on:
//   1. Snake_case MLflow response JSON deserializes into the internal
//      structs without loss, and maps onto the canonical `RunSummary`
//      / `RunDetail` / `RunConfig` types the renderer expects. This
//      catches drift between the wire shape and the TypeScript types
//      without needing a live server.
//   2. `MlflowProvider::new` constructs an HTTP client with the right
//      base URL / token / project / workspace hash plumbing.
//   3. `TrackerErrorKind` serializes to the snake_case strings the
//      renderer matches against.
//
// Network-level error mapping (401/404/429 → TrackerErrorKind) is
// exercised by the in-file `mod tests` block in `tracker/mlflow.rs`;
// here we only verify the parser/mapper correctness end-to-end.

use bonafide_lib::tracker_for_tests::{
    run_to_detail, run_to_summary, MlflowProvider, MlflowRun, TrackerErrorKind,
};

/// Helper — parse a real MLflow response body and map it.
fn parse_and_summarize(json: &str) -> bonafide_lib::tracker_for_tests::RunSummary {
    let run: MlflowRun = serde_json::from_str(json).expect("parse MLflow run");
    run_to_summary(run)
}

fn parse_and_detail(json: &str) -> bonafide_lib::tracker_for_tests::RunDetail {
    let run: MlflowRun = serde_json::from_str(json).expect("parse MLflow run");
    run_to_detail(run)
}

#[test]
fn parses_minimal_run_summary() {
    // Bare-minimum payload with only required fields populated. Anything
    // missing must default cleanly so the renderer never sees `null`
    // fields for scalar columns.
    let json = r#"{
        "info": {
            "run_id": "abc123",
            "run_name": "trial-7",
            "status": "FINISHED",
            "experiment_id": "0",
            "start_time": 1700000000000,
            "end_time": 1700000100000
        },
        "data": {
            "metrics": [],
            "params": [],
            "tags": []
        }
    }"#;

    let summary = parse_and_summarize(json);
    assert_eq!(summary.id, "abc123");
    assert_eq!(summary.name, "trial-7");
    assert_eq!(summary.state, "FINISHED");
    assert_eq!(summary.created_at, 1_700_000_000_000);
}

#[test]
fn falls_back_to_run_id_when_name_is_empty() {
    // MLflow returns an empty string for runs that haven't been renamed
    // — the renderer expects a non-empty `name`, so we substitute the
    // run_id when the server gives us nothing.
    let json = r#"{
        "info": {
            "run_id": "lonely-run",
            "run_name": "",
            "status": "RUNNING",
            "experiment_id": "0",
            "start_time": 42,
            "end_time": null
        },
        "data": {"metrics": [], "params": [], "tags": []}
    }"#;

    let summary = parse_and_summarize(json);
    assert_eq!(summary.name, "lonely-run");
}

#[test]
fn summary_metrics_use_last_write_per_key() {
    // MLflow emits one row per (key, step). Multiple rows for the same
    // key must collapse to a single value; convention is "last write
    // wins" so the most recent step (typically the highest step) shows
    // in the summary view.
    let json = r#"{
        "info": {
            "run_id": "abc",
            "run_name": "trial",
            "status": "FINISHED",
            "experiment_id": "0",
            "start_time": 1,
            "end_time": null
        },
        "data": {
            "metrics": [
                {"key": "loss", "value": 0.9, "step": 0, "timestamp": null},
                {"key": "loss", "value": 0.1, "step": 1, "timestamp": null},
                {"key": "acc",  "value": 0.7, "step": 0, "timestamp": null}
            ],
            "params": [],
            "tags": []
        }
    }"#;

    let summary = parse_and_summarize(json);
    assert_eq!(summary.summary_metrics["loss"], serde_json::json!(0.1));
    assert_eq!(summary.summary_metrics["acc"], serde_json::json!(0.7));
}

#[test]
fn detail_maps_params_as_string_map_and_tags_as_kv_strings() {
    let json = r#"{
        "info": {
            "run_id": "r1",
            "run_name": "r1",
            "status": "FINISHED",
            "experiment_id": "0",
            "start_time": 42,
            "end_time": 100
        },
        "data": {
            "metrics": [
                {"key": "loss", "value": 0.5, "step": 0, "timestamp": null}
            ],
            "params": [
                {"key": "lr",         "value": "0.01"},
                {"key": "batch_size", "value": "32"}
            ],
            "tags": [
                {"key": "team", "value": "ml"}
            ]
        }
    }"#;

    let detail = parse_and_detail(json);
    assert_eq!(detail.id, "r1");
    assert_eq!(detail.created_at, 42);
    assert_eq!(detail.finished_at, Some(100));
    // MLflow params are always strings; the renderer expects them as
    // a flat JSON object so the params table can render them inline.
    assert_eq!(detail.config["lr"], serde_json::json!("0.01"));
    assert_eq!(detail.config["batch_size"], serde_json::json!("32"));
    // Tags collapse to "k=v" strings, matching the renderer's
    // `tags: string[]` type.
    assert_eq!(detail.tags, vec!["team=ml".to_string()]);
    assert_eq!(detail.summary_metrics["loss"], serde_json::json!(0.5));
}

#[test]
fn detail_with_no_data_still_serializes() {
    // A run created but never logged to must not blow up — every
    // optional field defaults to its empty value.
    let json = r#"{
        "info": {
            "run_id": "bare",
            "run_name": "",
            "status": "RUNNING",
            "experiment_id": "0"
        },
        "data": {"metrics": [], "params": [], "tags": []}
    }"#;

    let detail = parse_and_detail(json);
    assert_eq!(detail.id, "bare");
    assert_eq!(detail.name, "bare");
    assert_eq!(detail.finished_at, None);
    assert_eq!(detail.created_at, 0);
    assert!(detail.config.as_object().unwrap().is_empty());
    assert!(detail.summary_metrics.as_object().unwrap().is_empty());
    assert!(detail.tags.is_empty());
}

#[test]
fn mlflow_provider_new_stores_credentials() {
    // Verify the provider constructs without making any network calls.
    // We can't easily test the keyring roundtrip here because the OS
    // keyring backend varies (Windows Credential Manager, macOS
    // Keychain, Secret Service); the crate's in-file unit tests cover
    // that path. Here we only verify the surface the renderer talks to.
    let provider = MlflowProvider::new(
        "ws-hash".into(),
        "http://localhost:5000".into(),
        Some("token-xyz".into()),
        "Default".into(),
    );
    assert!(provider.is_ok(), "MlflowProvider::new should not error");
    let provider = provider.unwrap();
    assert_eq!(provider.workspace_hash(), "ws-hash");
    assert_eq!(provider.base_url(), "http://localhost:5000");
    assert_eq!(provider.project(), "Default");
}

#[test]
fn mlflow_provider_new_works_without_token() {
    // Public MLflow servers (and local dev servers) typically don't
    // require auth — the provider must accept `None` for the token.
    let provider = MlflowProvider::new(
        "ws-hash".into(),
        "http://localhost:5000".into(),
        None,
        "Default".into(),
    );
    assert!(provider.is_ok());
}

#[test]
fn tracker_error_kind_serializes_to_snake_case_strings() {
    // The renderer reads `errorKind` as a string. We verify each
    // variant serializes to the expected snake_case form so the
    // TypeScript `TrackerErrorKind` union stays in sync.
    let cases = [
        (TrackerErrorKind::NoPython, "no_python"),
        (TrackerErrorKind::AuthFailed, "auth_failed"),
        (TrackerErrorKind::NotFound, "not_found"),
        (TrackerErrorKind::RateLimited, "rate_limited"),
        (TrackerErrorKind::ShimCrashed, "shim_crashed"),
        (TrackerErrorKind::Unknown, "unknown"),
    ];

    for (kind, expected) in cases {
        let serialized = serde_json::to_string(&kind).expect("serialize kind");
        // The enum serializes as a bare string under
        // `rename_all = "snake_case"`.
        assert_eq!(
            serialized,
            format!("\"{expected}\""),
            "for variant {expected}"
        );
    }
}

/// Reverse-order regression: the previous "iterate-and-overwrite"
/// implementation collapsed metrics by array position, so an MLflow
/// response that returned metric rows in descending step order would
/// surface the *first* row (i.e. the highest step) only by accident.
/// The fix tracks the highest (step, timestamp) per key, so the value
/// at step=2 wins even though it appears first in the JSON array.
#[test]
fn summary_picks_highest_step_when_metrics_are_reverse_ordered() {
    let mlflow_run_json = r#"{
        "info": {
            "run_id": "abc",
            "run_name": "trial",
            "status": "FINISHED",
            "experiment_id": "0",
            "start_time": 1700000000000,
            "end_time": null
        },
        "data": {
            "metrics": [
                {"key": "loss", "value": 0.05, "step": 2, "timestamp": 1700000003000},
                {"key": "loss", "value": 0.5,  "step": 0, "timestamp": 1700000001000}
            ],
            "params": [],
            "tags": []
        }
    }"#;

    let mlflow_run: MlflowRun = serde_json::from_str(mlflow_run_json).expect("parse MLflow run");
    let summary = run_to_summary(mlflow_run);
    // Highest step (2) wins, even though it appears first in the array.
    assert_eq!(summary.summary_metrics["loss"], serde_json::json!(0.05));
}

/// Same reverse-order regression for `run_to_detail`. The detail view
/// shows the same `summary_metrics` map that the summary view does, so
/// the fix has to apply to both code paths — otherwise the list page
/// and the detail page would disagree about the run's final loss.
#[test]
fn detail_picks_highest_step_when_metrics_are_reverse_ordered() {
    let mlflow_run_json = r#"{
        "info": {
            "run_id": "abc",
            "run_name": "trial",
            "status": "FINISHED",
            "experiment_id": "0",
            "start_time": 1700000000000,
            "end_time": null
        },
        "data": {
            "metrics": [
                {"key": "loss", "value": 0.05, "step": 2, "timestamp": 1700000003000},
                {"key": "loss", "value": 0.5,  "step": 0, "timestamp": 1700000001000}
            ],
            "params": [],
            "tags": []
        }
    }"#;

    let mlflow_run: MlflowRun = serde_json::from_str(mlflow_run_json).expect("parse MLflow run");
    let detail = run_to_detail(mlflow_run);
    assert_eq!(detail.summary_metrics["loss"], serde_json::json!(0.05));
}
