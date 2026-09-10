//! MLflow tracker provider.
//!
//! Connects directly to an MLflow tracking server over HTTP. Unlike W&B,
//! this provider does **not** use a Python shim — MLflow exposes a plain
//! REST API, so we talk to it with `reqwest` directly. The provider is
//! identified by a `workspace_hash` (sha256 hex of the workspace root
//! path) and stores its server URL, bearer token, and project name in the
//! OS keyring under `tracker:mlflow:{workspace_hash}` as a JSON blob.

use std::collections::HashMap;
use std::time::Duration;

use lazy_static::lazy_static;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, RwLock};

use crate::tracker::credentials::{delete_credential, get_credential, set_credential};
use crate::tracker::error::{TrackerError, TrackerErrorKind};

// Reuse the canonical renderer-facing types from the W&B module. The
// renderer is the source of truth for these shapes; MLflow-specific
// responses are mapped onto them before being returned.
pub use crate::tracker::wandb::{ArtifactRef, Point, RunConfig, RunDetail, RunPage, RunSummary};

// ── Internal request/response shapes ──────────────────────────────────────
//
// MLflow's REST API uses snake_case JSON. We define internal structs with
// `#[serde(rename_all = "snake_case")]` for parsing, then map onto the
// camelCase renderer types from `wandb.rs`. The structs are exposed via
// the `tracker_for_tests` module in lib.rs so integration tests can
// roundtrip real MLflow responses through them. They're `pub` (rather
// than fully hidden) so the doc-hidden `pub mod tracker_for_tests` in
// lib.rs can re-export them; the doc-hidden attribute keeps them out
// of the renderer-facing API surface.

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SearchRunsRequest<'a> {
    experiment_ids: Vec<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_results: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    page_token: Option<&'a str>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SearchRunsResponse {
    runs: Vec<MlflowRun>,
    #[serde(default)]
    next_page_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct GetRunRequest<'a> {
    run_id: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct GetRunResponse {
    run: MlflowRun,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct GetHistoryRequest<'a> {
    run_id: &'a str,
    #[serde(rename = "metric_key")]
    key: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct MetricHistoryEntry {
    #[serde(default)]
    step: i64,
    value: f64,
    #[serde(default)]
    timestamp: Option<i64>,
    #[serde(default)]
    key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ListArtifactsRequest<'a> {
    run_id: &'a str,
    #[serde(default)]
    path: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ListArtifactsResponse {
    #[serde(default)]
    files: Vec<MlflowArtifactFile>,
    #[serde(default)]
    root_uri: Option<String>,
}

/// Response from `experiments/get-by-name`. The server returns the
/// full experiment metadata nested under `experiment`; we only need
/// the ID so we keep the struct minimal.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct GetExperimentByNameResponse {
    experiment: ExperimentRef,
}

/// Subset of MLflow's `Experiment` shape that we actually consume —
/// kept narrow on purpose so a server-side field rename doesn't break
/// the rest of the parser.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ExperimentRef {
    experiment_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct MlflowArtifactFile {
    path: String,
    #[serde(default)]
    file_size: Option<i64>,
    #[serde(default)]
    is_dir: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct MlflowRun {
    info: MlflowRunInfo,
    #[serde(default)]
    data: MlflowRunData,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct MlflowRunInfo {
    run_id: String,
    #[serde(default)]
    run_name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    experiment_id: String,
    #[serde(default)]
    start_time: Option<i64>,
    #[serde(default)]
    end_time: Option<i64>,
    #[serde(default)]
    artifact_uri: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub struct MlflowRunData {
    #[serde(default)]
    metrics: Vec<MlflowMetric>,
    #[serde(default)]
    params: Vec<MlflowParam>,
    #[serde(default)]
    tags: Vec<MlflowTag>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct MlflowMetric {
    key: String,
    value: f64,
    #[serde(default)]
    step: Option<i64>,
    #[serde(default)]
    timestamp: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct MlflowParam {
    key: String,
    value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct MlflowTag {
    key: String,
    value: String,
}

/// Payload we serialize into the keyring entry. Bundled into one blob so
/// `disconnect` and re-`connect` flows only touch a single keyring slot.
#[derive(Debug, Serialize, Deserialize)]
struct StoredCredentials {
    base_url: String,
    #[serde(default)]
    token: Option<String>,
    project: String,
}

// ── MlflowProvider ─────────────────────────────────────────────────────────

/// A connected MLflow provider scoped to one workspace.
///
/// Holds a long-lived `reqwest::Client` for connection pooling. The
/// server URL, optional bearer token, and project name are persisted to
/// the OS keyring under `tracker:mlflow:{workspace_hash}` as a JSON blob.
pub struct MlflowProvider {
    /// Stable identifier for this workspace.
    workspace_hash: String,

    /// Base URL of the MLflow tracking server, e.g. `http://localhost:5000`.
    base_url: String,

    /// Optional bearer token. When `Some`, sent as `Authorization: Bearer …`.
    token: Option<String>,

    /// Experiment/project name to scope `list_runs` to.
    project: String,

    /// Shared HTTP client. Cheap to construct; we reuse for connection pooling.
    client: reqwest::Client,

    /// Cache of experiment name → experiment ID. Populated lazily by
    /// `resolve_experiment_id` so we don't re-resolve the configured
    /// project on every `list_runs` call. Holding a `tokio::sync::Mutex`
    /// (rather than `std::sync::Mutex`) because the cache lookup spans
    /// an `.await` while the resolver hits the server.
    experiment_id_cache: Mutex<HashMap<String, String>>,
}

impl MlflowProvider {
    /// Construct a new `MlflowProvider` for the given workspace.
    ///
    /// Does **not** validate the server — call `connect()` to do that
    /// and persist credentials to the keyring.
    ///
    /// `workspace_hash` must be the sha256 hex digest of the workspace
    /// root path. It is used as the keyring entry name.
    pub fn new(
        workspace_hash: String,
        base_url: String,
        token: Option<String>,
        project: String,
    ) -> Result<Self, TrackerError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| TrackerError {
                kind: TrackerErrorKind::Unknown,
                message: format!("Failed to build HTTP client: {e}"),
                hint: None,
            })?;

        Ok(Self {
            workspace_hash,
            base_url,
            token,
            project,
            client,
            experiment_id_cache: Mutex::new(HashMap::new()),
        })
    }

    /// Validate connectivity to the MLflow tracking server and persist
    /// credentials to the OS keyring.
    ///
    /// The validation is a lightweight GET against the server root. On
    /// 2xx/3xx responses we treat the server as reachable and write the
    /// (base_url, token, project) blob to the keyring. On 401/403/404/429
    /// or transport errors we map onto `TrackerErrorKind` and return.
    pub async fn connect(&self) -> Result<(), TrackerError> {
        // Persist credentials first — even if the validation GET fails
        // partway, the keyring will hold the user's intent.
        let stored = StoredCredentials {
            base_url: self.base_url.clone(),
            token: self.token.clone(),
            project: self.project.clone(),
        };
        let serialized = serde_json::to_string(&stored).map_err(|e| TrackerError {
            kind: TrackerErrorKind::Unknown,
            message: format!("Failed to serialize MLflow credentials: {e}"),
            hint: None,
        })?;

        // Probe the server FIRST. If the probe fails, do NOT store the credentials.
        //
        // We call `experiments/get-by-name` with the configured project so a
        // bad project name surfaces as a 404 (vs. the empty-list
        // `experiments/search` probe which silently returns every
        // experiment on the server). A real liveness check should also
        // verify the user's project actually exists.
        let url = format!("{}/api/2.0/mlflow/experiments/get-by-name", self.base_url);
        let response = self
            .client
            .post(&url)
            .headers(auth_headers(self.token.as_deref())?)
            .json(&serde_json::json!({"experiment_name": &self.project}))
            .send()
            .await
            .map_err(|e| TrackerError {
                kind: TrackerErrorKind::Unknown,
                message: format!("MLflow server unreachable: {e}"),
                hint: Some(format!(
                    "Check that the MLflow tracking server is running at {}",
                    self.base_url
                )),
            })?;

        let status = response.status();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(TrackerError::auth_failed(&format!(
                "MLflow server rejected credentials ({status})"
            )));
        }
        if status == StatusCode::NOT_FOUND {
            return Err(TrackerError {
                kind: TrackerErrorKind::NotFound,
                message: format!("MLflow experiment '{}' not found", self.project),
                hint: Some(format!(
                    "Create the experiment in the MLflow UI, or change the project name in Bonafide settings."
                )),
            });
        }
        if status == StatusCode::TOO_MANY_REQUESTS {
            return Err(TrackerError::rate_limited(60));
        }
        if !status.is_success() {
            return Err(TrackerError {
                kind: TrackerErrorKind::Unknown,
                message: format!("MLflow server returned {status}"),
                hint: None,
            });
        }

        // Probe succeeded — persist the credentials.
        set_credential("mlflow", &self.workspace_hash, &serialized).map_err(|e| TrackerError {
            kind: TrackerErrorKind::AuthFailed,
            message: format!("Failed to store MLflow credentials in keyring: {e}"),
            hint: None,
        })?;

        Ok(())
    }

    /// Disconnect from MLflow: remove the stored credentials from the
    /// keyring. The provider struct itself remains usable (it still
    /// holds a working HTTP client) but the renderer's `connect_tracker`
    /// registry is expected to drop it.
    pub async fn disconnect(&self) -> Result<(), TrackerError> {
        delete_credential("mlflow", &self.workspace_hash).map_err(|e| TrackerError {
            kind: TrackerErrorKind::Unknown,
            message: format!("Failed to remove MLflow credentials from keyring: {e}"),
            hint: None,
        })
    }

    /// List runs in the given experiment (project), paged by `cursor`.
    ///
    /// Calls MLflow's `POST /api/2.0/mlflow/runs/search` with a JSON
    /// body. The renderer's `project` is a friendly experiment *name*;
    /// the server's search endpoint filters by *experiment_id*, so we
    /// resolve the name once via `experiments/get-by-name` (cached for
    /// subsequent calls) and pass the ID in `experiment_ids`.
    /// Returns a `RunPage` (the canonical renderer type).
    pub async fn list_runs(
        &self,
        project: &str,
        limit: u32,
        cursor: Option<&str>,
    ) -> Result<RunPage, TrackerError> {
        let experiment_id = self.resolve_experiment_id(project).await?;
        let url = format!("{}/api/2.0/mlflow/runs/search", self.base_url);
        let body = SearchRunsRequest {
            experiment_ids: vec![&experiment_id],
            max_results: Some(limit),
            page_token: cursor,
        };

        let response = self
            .client
            .post(&url)
            .headers(auth_headers(self.token.as_deref())?)
            .json(&body)
            .send()
            .await
            .map_err(|e| TrackerError {
                kind: TrackerErrorKind::Unknown,
                message: format!("MLflow runs/search transport error: {e}"),
                hint: None,
            })?;

        let status = response.status();
        let parsed: SearchRunsResponse = map_status_and_parse(response, status, "search-runs").await?;

        let runs = parsed.runs.into_iter().map(run_to_summary).collect();
        Ok(RunPage {
            runs,
            next_cursor: parsed.next_page_token,
        })
    }

    /// Fetch full detail for one run. Calls `POST /api/2.0/mlflow/runs/get`.
    pub async fn get_run(&self, run_id: &str) -> Result<RunDetail, TrackerError> {
        let url = format!("{}/api/2.0/mlflow/runs/get", self.base_url);
        let body = GetRunRequest { run_id };

        let response = self
            .client
            .post(&url)
            .headers(auth_headers(self.token.as_deref())?)
            .json(&body)
            .send()
            .await
            .map_err(|e| TrackerError {
                kind: TrackerErrorKind::Unknown,
                message: format!("MLflow runs/get transport error: {e}"),
                hint: None,
            })?;

        let status = response.status();
        let parsed: GetRunResponse = map_status_and_parse(response, status, "runs/get").await?;

        Ok(run_to_detail(parsed.run))
    }

    /// Fetch the time series for a single metric key on a run. Calls
    /// `GET /api/2.0/mlflow/metrics/get-history` with query params.
    pub async fn get_metric_series(
        &self,
        run_id: &str,
        key: &str,
    ) -> Result<Vec<Point>, TrackerError> {
        let url = format!("{}/api/2.0/mlflow/metrics/get-history", self.base_url);
        let body = GetHistoryRequest { run_id, key };

        let response = self
            .client
            .get(&url)
            .headers(auth_headers(self.token.as_deref())?)
            .query(&body)
            .send()
            .await
            .map_err(|e| TrackerError {
                kind: TrackerErrorKind::Unknown,
                message: format!("MLflow metrics/get-history transport error: {e}"),
                hint: None,
            })?;

        let status = response.status();
        let entries: Vec<MetricHistoryEntry> =
            map_status_and_parse(response, status, "metrics/get-history").await?;

        Ok(entries
            .into_iter()
            .map(|e| Point {
                step: e.step,
                value: e.value,
                ts: e.timestamp.unwrap_or(0),
            })
            .collect())
    }

    /// Fetch the run config (parameters) for a run.
    ///
    /// Internally reuses `get_run` and extracts `data.params` so we
    /// don't pay an extra round-trip when both detail and config are
    /// requested by the renderer.
    pub async fn get_run_config(&self, run_id: &str) -> Result<RunConfig, TrackerError> {
        let url = format!("{}/api/2.0/mlflow/runs/get", self.base_url);
        let body = GetRunRequest { run_id };

        let response = self
            .client
            .post(&url)
            .headers(auth_headers(self.token.as_deref())?)
            .json(&body)
            .send()
            .await
            .map_err(|e| TrackerError {
                kind: TrackerErrorKind::Unknown,
                message: format!("MLflow runs/get transport error: {e}"),
                hint: None,
            })?;

        let status = response.status();
        let parsed: GetRunResponse = map_status_and_parse(response, status, "runs/get").await?;

        let params = parsed.run.data.params;
        let mut config_map = serde_json::Map::new();
        for p in params {
            config_map.insert(p.key, serde_json::Value::String(p.value));
        }

        Ok(RunConfig {
            run_id: run_id.to_string(),
            config: serde_json::Value::Object(config_map),
        })
    }

    /// List artifacts for a run. Calls
    /// `GET /api/2.0/mlflow/artifacts/list` with `run_id` and `path` as
    /// query parameters; `path = ""` fetches the run root.
    pub async fn list_artifacts(
        &self,
        run_id: &str,
    ) -> Result<Vec<ArtifactRef>, TrackerError> {
        let url = format!("{}/api/2.0/mlflow/artifacts/list", self.base_url);
        let body = ListArtifactsRequest { run_id, path: "" };

        let response = self
            .client
            .get(&url)
            .headers(auth_headers(self.token.as_deref())?)
            .query(&body)
            .send()
            .await
            .map_err(|e| TrackerError {
                kind: TrackerErrorKind::Unknown,
                message: format!("MLflow artifacts/list transport error: {e}"),
                hint: None,
            })?;

        let status = response.status();
        let parsed: ListArtifactsResponse =
            map_status_and_parse(response, status, "artifacts/list").await?;

        // The MLflow list response doesn't include created_at or digest
        // (those live on artifact metadata, not the listing), so we
        // synthesize placeholders that the renderer can use. The `digest`
        // field is filled with the prefixed path so it's still useful as
        // a stable identifier; `created_at` is left at 0 to indicate
        // "unknown".
        let now = chrono_millis_now();
        let refs = parsed
            .files
            .into_iter()
            .filter(|f| !f.is_dir.unwrap_or(false))
            .map(|f| ArtifactRef {
                name: f.path.clone(),
                digest: format!("mlflow:{}", f.path),
                size_bytes: f.file_size.unwrap_or(0),
                created_at: now,
            })
            .collect();

        Ok(refs)
    }

    /// Return the workspace hash for this provider.
    pub fn workspace_hash(&self) -> &str {
        &self.workspace_hash
    }

    /// Return the base URL (for diagnostics / status reporting).
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Return the configured project / experiment name.
    pub fn project(&self) -> &str {
        &self.project
    }

    /// Cheap connectivity probe: `HEAD /` against the MLflow server.
    ///
    /// Used by the renderer's "Test connection" action and by the
    /// `test_tracker_connection` Tauri command. We don't issue the
    /// `experiments/search` request used during `connect()` because the
    /// HEAD path is cheaper and surfaces the same network/auth signal.
    /// A 2xx, 3xx, or 401/403 response all count as "reachable"; 5xx
    /// and transport errors propagate as `TrackerError`.
    pub async fn ping(&self) -> Result<std::time::Duration, TrackerError> {
        let start = std::time::Instant::now();
        // Probe the configured project via experiments/get-by-name —
        // verifies the server is up AND that the configured experiment
        // exists, which is a stronger liveness signal than the previous
        // empty-list search probe (which returned every experiment on
        // the server and so couldn't distinguish "alive" from "wrong
        // server").
        let url = format!("{}/api/2.0/mlflow/experiments/get-by-name", self.base_url);
        let response = self.client
            .post(&url)
            .headers(auth_headers(self.token.as_deref())?)
            .json(&serde_json::json!({"experiment_name": &self.project}))
            .send()
            .await
            .map_err(|e| TrackerError {
                kind: TrackerErrorKind::Unknown,
                message: format!("MLflow server unreachable: {e}"),
                hint: Some(format!("Check that MLflow tracking is running at {}", self.base_url)),
            })?;
        let status = response.status();
        if !status.is_success() {
            return Err(TrackerError {
                kind: TrackerErrorKind::Unknown,
                message: format!("MLflow server returned {status}"),
                hint: None,
            });
        }
        Ok(start.elapsed())
    }

    /// Resolve a friendly experiment name to its MLflow `experiment_id`.
    ///
    /// MLflow's `/api/2.0/mlflow/runs/search` endpoint filters by
    /// `experiment_ids` (numeric/string ID), not by name. The
    /// "names" filter is a client-side convenience that doesn't exist
    /// on the server. This helper performs the missing translation via
    /// `experiments/get-by-name` and caches the result so we don't
    /// pay an extra round-trip on every `list_runs` call.
    ///
    /// Body sent: `{"experiment_name": "<name>"}`.
    /// Response shape: `{"experiment": {"experiment_id": "0", "name": "...", ...}}`.
    async fn resolve_experiment_id(&self, name: &str) -> Result<String, TrackerError> {
        // Fast path: already resolved this experiment in this provider's
        // lifetime. Cache hits avoid an HTTP round-trip on every page
        // fetch.
        {
            let cache = self.experiment_id_cache.lock().await;
            if let Some(id) = cache.get(name) {
                return Ok(id.clone());
            }
        }

        let url = format!("{}/api/2.0/mlflow/experiments/get-by-name", self.base_url);
        let response = self
            .client
            .post(&url)
            .headers(auth_headers(self.token.as_deref())?)
            .json(&serde_json::json!({"experiment_name": name}))
            .send()
            .await
            .map_err(|e| TrackerError {
                kind: TrackerErrorKind::Unknown,
                message: format!("MLflow experiments/get-by-name transport error: {e}"),
                hint: None,
            })?;

        let status = response.status();
        // 404 means the experiment simply doesn't exist on this server
        // — surface it as a NotFound so the renderer can prompt the
        // user to fix the configured project name.
        if status == StatusCode::NOT_FOUND {
            return Err(TrackerError {
                kind: TrackerErrorKind::NotFound,
                message: format!("MLflow experiment '{name}' not found"),
                hint: Some(
                    "Check the project name in Bonafide's MLflow connection settings.".to_string(),
                ),
            });
        }

        let parsed: GetExperimentByNameResponse = map_status_and_parse(
            response,
            status,
            "experiments/get-by-name",
        )
        .await?;

        let id = parsed.experiment.experiment_id;
        if id.is_empty() {
            return Err(TrackerError {
                kind: TrackerErrorKind::Unknown,
                message: format!("MLflow returned empty experiment_id for '{name}'"),
                hint: None,
            });
        }

        // Populate the cache before returning so the next call is a
        // pure hashmap lookup.
        {
            let mut cache = self.experiment_id_cache.lock().await;
            cache.insert(name.to_string(), id.clone());
        }

        Ok(id)
    }
}

// ── Internal helpers ──────────────────────────────────────────────────────

/// Build the request header set, including an `Authorization: Bearer …`
/// header when a token is present.
fn auth_headers(token: Option<&str>) -> Result<HeaderMap, TrackerError> {
    let mut headers = HeaderMap::new();
    headers.insert(
        "Content-Type",
        HeaderValue::from_static("application/json"),
    );
    if let Some(t) = token {
        let header_value = format!("Bearer {t}");
        let parsed = HeaderValue::from_str(&header_value).map_err(|e| TrackerError {
            kind: TrackerErrorKind::AuthFailed,
            message: format!("Invalid bearer token: {e}"),
            hint: None,
        })?;
        headers.insert(AUTHORIZATION, parsed);
    }
    Ok(headers)
}

/// Map an HTTP status onto `TrackerErrorKind`, then parse the JSON body.
///
/// On non-2xx responses we read the body for a useful message, then
/// return the appropriate typed error. On 2xx, we deserialize `T` from
/// the body text.
async fn map_status_and_parse<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
    status: StatusCode,
    endpoint: &str,
) -> Result<T, TrackerError> {
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err(TrackerError::auth_failed(&format!(
            "MLflow {endpoint} returned {status}"
        )));
    }
    if status == StatusCode::NOT_FOUND {
        return Err(TrackerError {
            kind: TrackerErrorKind::NotFound,
            message: format!("MLflow {endpoint} returned 404"),
            hint: None,
        });
    }
    if status == StatusCode::TOO_MANY_REQUESTS {
        return Err(TrackerError::rate_limited(60));
    }
    if !status.is_success() {
        // Try to surface the upstream body as the error message — it's
        // almost always more useful than the bare status code.
        let body = response.text().await.unwrap_or_default();
        let snippet = if body.len() > 256 {
            format!("{}…", &body[..256])
        } else {
            body
        };
        return Err(TrackerError {
            kind: TrackerErrorKind::Unknown,
            message: format!("MLflow {endpoint} returned {status}: {snippet}"),
            hint: None,
        });
    }

    response.json::<T>().await.map_err(|e| TrackerError {
        kind: TrackerErrorKind::Unknown,
        message: format!("Failed to parse MLflow {endpoint} response: {e}"),
        hint: None,
    })
}

/// Map an MLflow `Run` onto the canonical `RunSummary`.
///
/// `pub` so the `tracker_for_tests` re-export in lib.rs can reach it
/// for the integration tests in `tests/tracker_roundtrip.rs`.
pub fn run_to_summary(r: MlflowRun) -> RunSummary {
    let MlflowRun { info, data } = r;
    // The renderer expects `summaryMetrics` as a JSON object — collect
    // the metric value with the highest (step, timestamp) per key.
    // MLflow may return metric rows in arbitrary order (the API doesn't
    // guarantee step ordering), so we track the best write per key
    // rather than relying on iteration order. Higher step wins; ties
    // are broken by higher timestamp so the most recent write at the
    // same step also wins.
    let mut best: std::collections::HashMap<String, (i64, i64, f64)> =
        std::collections::HashMap::new();
    for m in data.metrics {
        let step = m.step.unwrap_or(0);
        let ts = m.timestamp.unwrap_or(0);
        let entry = best.entry(m.key).or_insert((i64::MIN, i64::MIN, m.value));
        if (step, ts) > (entry.0, entry.1) {
            *entry = (step, ts, m.value);
        }
    }
    let mut summary = serde_json::Map::new();
    for (k, (_, _, v)) in best {
        summary.insert(k, serde_json::json!(v));
    }

    let name = if info.run_name.is_empty() {
        info.run_id.clone()
    } else {
        info.run_name
    };

    RunSummary {
        id: info.run_id,
        name,
        state: info.status,
        created_at: info.start_time.unwrap_or(0),
        summary_metrics: serde_json::Value::Object(summary),
    }
}

/// Map an MLflow `Run` onto the canonical `RunDetail`.
///
/// `pub` so integration tests can exercise the full
/// summary/detail/params/tags mapping path.
pub fn run_to_detail(r: MlflowRun) -> RunDetail {
    let MlflowRun { info, data } = r;
    let MlflowRunData { metrics, params, tags } = data;

    // Mirror `run_to_summary`: track the metric value with the highest
    // (step, timestamp) per key. MLflow may return metric rows in any
    // order, so a simple "last write wins" loop would surface whatever
    // happened to be last in the array — not necessarily the final
    // training step. See `run_to_summary` for the same rationale.
    let mut best: std::collections::HashMap<String, (i64, i64, f64)> =
        std::collections::HashMap::new();
    for m in metrics {
        let step = m.step.unwrap_or(0);
        let ts = m.timestamp.unwrap_or(0);
        let entry = best.entry(m.key).or_insert((i64::MIN, i64::MIN, m.value));
        if (step, ts) > (entry.0, entry.1) {
            *entry = (step, ts, m.value);
        }
    }
    let mut summary = serde_json::Map::new();
    for (k, (_, _, v)) in best {
        summary.insert(k, serde_json::json!(v));
    }
    let mut config = serde_json::Map::new();
    for p in params {
        config.insert(p.key, serde_json::Value::String(p.value));
    }
    let tags: Vec<String> = tags
        .into_iter()
        .map(|t| format!("{}={}", t.key, t.value))
        .collect();

    let name = if info.run_name.is_empty() {
        info.run_id.clone()
    } else {
        info.run_name
    };

    RunDetail {
        id: info.run_id,
        name,
        state: info.status,
        created_at: info.start_time.unwrap_or(0),
        finished_at: info.end_time,
        config: serde_json::Value::Object(config),
        summary_metrics: serde_json::Value::Object(summary),
        tags,
        notes: String::new(),
    }
}

/// Cheap "now in milliseconds since epoch" without dragging in chrono.
/// Uses `std::time::SystemTime`; returns 0 on platforms where the clock
/// is before the unix epoch (which we don't support anyway).
fn chrono_millis_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── Global registry ───────────────────────────────────────────────────────

lazy_static! {
    /// Global registry of connected MLflow providers, keyed by workspace hash.
    static ref MLFLOW_REGISTRY: RwLock<std::collections::HashMap<String, std::sync::Arc<MlflowProvider>>> =
        RwLock::new(std::collections::HashMap::new());
}

/// Connect an MLflow tracker for the given workspace.
///
/// If a provider already exists for this workspace (e.g. reconnecting
/// after a server restart), we shut the old one down by removing it
/// from the registry, then build and connect a fresh one with the new
/// parameters.
///
/// Returns the workspace hash of the connected provider.
pub async fn connect_mlflow(
    workspace_root: &std::path::Path,
    base_url: String,
    token: Option<String>,
    project: String,
) -> Result<String, TrackerError> {
    let workspace_hash = hash_workspace(workspace_root);

    // Build + probe the NEW provider OUTSIDE the registry lock.
    //
    // Holding a write lock across a network round-trip would block every
    // other MLflow operation in the app for the duration of the probe,
    // and would also make a probe failure tear down the OLD provider
    // (since the previous version of this function `remove()`d the old
    // entry before probing). By doing build+probe first and only taking
    // the lock for the brief registry swap, a failed probe leaves the
    // existing provider registered — the user's connection is preserved
    // across a flaky reconnect attempt.
    let new_provider = MlflowProvider::new(
        workspace_hash.clone(),
        base_url,
        token,
        project,
    )?;
    new_provider.connect().await?;

    // Probe succeeded — atomically swap the registry entry. We use a
    // brief write lock so concurrent readers either see the old
    // provider or the new one, never nothing.
    let mut registry = MLFLOW_REGISTRY.write().await;
    registry.insert(
        workspace_hash.clone(),
        std::sync::Arc::new(new_provider),
    );

    Ok(workspace_hash)
}

/// Disconnect the MLflow tracker for the given workspace.
pub async fn disconnect_mlflow(workspace_root: &std::path::Path) -> Result<(), TrackerError> {
    let workspace_hash = hash_workspace(workspace_root);

    let provider = {
        let mut registry = MLFLOW_REGISTRY.write().await;
        registry.remove(&workspace_hash)
    };

    match provider {
        Some(p) => p.disconnect().await,
        None => Err(TrackerError {
            kind: TrackerErrorKind::NotFound,
            message: "No MLflow tracker connected for workspace".to_string(),
            hint: None,
        }),
    }
}

/// Look up a registered MLflow provider by workspace hash.
pub async fn get_mlflow_provider(
    workspace_hash: &str,
) -> Option<std::sync::Arc<MlflowProvider>> {
    MLFLOW_REGISTRY.read().await.get(workspace_hash).cloned()
}

/// Returns true if an MLflow provider is connected for the given workspace hash.
pub async fn is_mlflow_connected(workspace_hash: &str) -> bool {
    MLFLOW_REGISTRY.read().await.contains_key(workspace_hash)
}

/// Reconstruct an `MlflowProvider` from keyring-stored credentials and
/// register it in the global MLFLOW_REGISTRY.
///
/// Used on app startup (via `open_workspace`) to rehydrate providers
/// after a restart, or by command handlers that want to dispatch to
/// MLflow without re-prompting the user. Returns `Ok(None)` if no
/// credentials are stored.
///
/// Side effects: on success, the new provider is inserted into
/// `MLFLOW_REGISTRY` under `workspace_hash`. If a provider is already
/// registered for this hash, the existing entry wins — rehydration
/// only fills a gap, never overwrites a live in-memory connection.
pub async fn load_mlflow_from_keyring(
    workspace_hash: &str,
) -> Result<Option<std::sync::Arc<MlflowProvider>>, TrackerError> {
    let raw = match get_credential("mlflow", workspace_hash).map_err(|e| TrackerError {
        kind: TrackerErrorKind::Unknown,
        message: format!("Failed to read MLflow credentials: {e}"),
        hint: None,
    })? {
        Some(v) => v,
        None => return Ok(None),
    };

    let stored: StoredCredentials = serde_json::from_str(&raw).map_err(|e| TrackerError {
        kind: TrackerErrorKind::Unknown,
        message: format!("Failed to parse stored MLflow credentials: {e}"),
        hint: None,
    })?;

    let provider = MlflowProvider::new(
        workspace_hash.to_string(),
        stored.base_url,
        stored.token,
        stored.project,
    )?;
    let provider = std::sync::Arc::new(provider);

    // Register under a brief write lock. If the registry already has an
    // entry (e.g. another task rehydrated first), leave it alone — the
    // existing in-memory provider has live state that would be lost on
    // an unconditional overwrite.
    {
        let mut registry = MLFLOW_REGISTRY.write().await;
        registry
            .entry(workspace_hash.to_string())
            .or_insert_with(|| provider.clone());
    }

    Ok(Some(provider))
}

/// Compute the workspace hash used as the keyring key and registry key.
///
/// Same scheme as `tracker::wandb::hash_workspace` and
/// `graph::storage::workspace_hash`: sha256 hex of the canonicalized
/// workspace root path, **truncated to the first 8 bytes (16 hex
/// chars)**. Truncating keeps the value match what the renderer stores
/// on `Workspace.hash` after `open_workspace`, so the registry lookups
/// in `is_tracker_connected` actually find the provider.
fn hash_workspace(root: &std::path::Path) -> String {
    let normalized = root
        .canonicalize()
        .unwrap_or_else(|_| root.to_path_buf())
        .to_string_lossy()
        .to_string();
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    let digest = hasher.finalize();
    hex::encode(&digest[..8])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_auth_headers_without_token() {
        let h = auth_headers(None).expect("headers");
        assert!(h.get("Content-Type").is_some());
        assert!(h.get(AUTHORIZATION).is_none());
    }

    #[test]
    fn test_auth_headers_with_token() {
        let h = auth_headers(Some("abc123")).expect("headers");
        assert_eq!(h.get(AUTHORIZATION).unwrap(), "Bearer abc123");
    }

    #[test]
    fn test_run_to_summary_uses_last_metric() {
        let r = MlflowRun {
            info: MlflowRunInfo {
                run_id: "abc".into(),
                run_name: "trial".into(),
                status: "FINISHED".into(),
                experiment_id: "0".into(),
                start_time: Some(1_700_000_000_000),
                end_time: Some(1_700_000_100_000),
                artifact_uri: None,
            },
            data: MlflowRunData {
                metrics: vec![
                    MlflowMetric { key: "loss".into(), value: 0.9, step: Some(0), timestamp: None },
                    MlflowMetric { key: "loss".into(), value: 0.1, step: Some(1), timestamp: None },
                ],
                params: vec![],
                tags: vec![],
            },
        };
        let summary = run_to_summary(r);
        assert_eq!(summary.id, "abc");
        assert_eq!(summary.name, "trial");
        assert_eq!(summary.state, "FINISHED");
        // Last write wins for the "loss" key.
        assert_eq!(summary.summary_metrics["loss"], serde_json::json!(0.1));
    }

    #[test]
    fn test_run_to_detail_collapses_params_and_tags() {
        let r = MlflowRun {
            info: MlflowRunInfo {
                run_id: "r1".into(),
                run_name: "".into(), // empty → falls back to id
                status: "RUNNING".into(),
                experiment_id: "0".into(),
                start_time: Some(42),
                end_time: None,
                artifact_uri: None,
            },
            data: MlflowRunData {
                metrics: vec![],
                params: vec![
                    MlflowParam { key: "lr".into(), value: "0.01".into() },
                ],
                tags: vec![
                    MlflowTag { key: "team".into(), value: "ml".into() },
                ],
            },
        };
        let detail = run_to_detail(r);
        assert_eq!(detail.id, "r1");
        assert_eq!(detail.name, "r1"); // falls back to id
        assert_eq!(detail.finished_at, None);
        assert_eq!(detail.config["lr"], serde_json::json!("0.01"));
        assert_eq!(detail.tags, vec!["team=ml".to_string()]);
    }
}
