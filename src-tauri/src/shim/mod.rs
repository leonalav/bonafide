// ShimManager — spawns and manages the W&B adapter Python shim subprocess,
// communicates with it over stdio JSON-RPC, and handles respawn on crash.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use which::which as which_command;

use crate::shim::protocol::ShimRequest;

pub mod protocol;

/// Maximum number of automatic respawn attempts before giving up.
pub const MAX_RESTARTS: u8 = 3;

/// Timeout for waiting on a JSON-RPC response from the shim.
const REQUEST_TIMEOUT_SECS: u64 = 30;

/// Sentinel key embedded in a `serde_json::Value` returned through the
/// oneshot channel to mark a JSON-RPC error response (as opposed to a
/// successful result payload).
const ERROR_SENTINEL_KEY: &str = "__shim_error__";

/// Errors that can arise during shim lifecycle operations.
#[derive(Debug, thiserror::Error)]
pub enum ShimError {
    #[error("shim subprocess is not running")]
    NotRunning,

    #[error("request failed: {0}")]
    RequestFailed(String),

    #[error("shim subprocess crashed: {0}")]
    Crashed(String),

    #[error("could not find Python interpreter: {0}")]
    NoPython(String),

    #[error("too many restarts (exceeded {MAX_RESTARTS})")]
    TooManyRestarts,
}

/// Manages a single W&B adapter shim subprocess.
///
/// The shim is a Python script that runs as a child process of this app.
/// Communication uses line-delimited JSON-RPC over stdin/stdout. A Tokio
/// task consumes stdout asynchronously, dispatching parsed `ShimEvent`s
/// to the event channel consumer and parsed `ShimResponse`s to the
/// matching pending oneshot sender keyed by JSON-RPC `id`.
pub struct ShimManager {
    /// Path to the Python shim script.
    shim_script: PathBuf,

    /// Absolute path to the Python interpreter.
    python_path: PathBuf,

    /// W&B API key passed to the shim via environment.
    ///
    /// Wrapped in an `Arc<Mutex<_>>` so the key can be updated in place
    /// (e.g. when the user changes their W&B API key via the renderer).
    /// `spawn()` reads the current value every time, so a key change
    /// followed by a respawn hands the new value to the child process.
    api_key: Arc<std::sync::Mutex<String>>,

    /// Active child process, if any.
    child: Mutex<Option<Child>>,

    /// Buffered writer to the child process stdin.
    writer: Mutex<Option<Box<dyn Write + Send>>>,

    /// Monotonically increasing JSON-RPC id counter.
    next_id: Mutex<u64>,

    /// Number of automatic (crash-loop) respawn attempts made.
    ///
    /// Bounded by `MAX_RESTARTS` — `respawn()` returns
    /// `ShimError::TooManyRestarts` once this exceeds the cap. User-
    /// triggered respawns (`respawn_with_key`) bypass this counter so
    /// that key changes cannot accidentally exhaust the crash budget.
    restarts: Mutex<u8>,

    /// Number of user-triggered respawns (API key changes, etc.).
    ///
    /// Unbounded counter — used purely for telemetry and so we can
    /// distinguish "child kept crashing" from "user re-connected with
    /// a different key" when triaging failures.
    key_respawns: Mutex<u64>,

    /// Sends async events (progress, log lines, etc.) from the stdout reader
    /// task to whoever is listening in the Tauri app.
    event_tx: mpsc::UnboundedSender<protocol::ShimEvent>,

    /// Pending JSON-RPC request ids → oneshot sender for the response.
    /// Populated by `send()` and drained by the stdout reader task when
    /// matching `ShimResponse` lines arrive.
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>,
}

impl ShimManager {
    /// Construct a new `ShimManager`.
    ///
    /// `shim_script` is the path to the Python adapter entry point.
    /// `api_key` is the W&B API key forwarded via the `WANDB_API_KEY` env var.
    ///
    /// # Errors
    /// Returns `ShimError::NoPython` if neither `python` nor `python3` can be
    /// found on `PATH`.
    pub fn new(shim_script: PathBuf, api_key: String) -> Result<Self, ShimError> {
        let python_path = Self::find_python()?;
        let (event_tx, _event_rx) = mpsc::unbounded_channel::<protocol::ShimEvent>();
        Ok(Self {
            shim_script,
            python_path,
            api_key: Arc::new(std::sync::Mutex::new(api_key)),
            child: Mutex::new(None),
            writer: Mutex::new(None),
            next_id: Mutex::new(1),
            restarts: Mutex::new(0),
            key_respawns: Mutex::new(0),
            event_tx,
            pending: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Update the W&B API key that will be passed to the shim subprocess
    /// on the next `spawn()` / `respawn()` call. Poison-safe — a poisoned
    /// mutex is recovered via `into_inner()` instead of panicking, since
    /// key updates can race with the reader task during shutdown.
    pub fn set_api_key(&self, key: String) {
        let mut guard = self.api_key.lock().unwrap_or_else(|p| p.into_inner());
        *guard = key;
    }

    /// Return a clone of the current W&B API key. Read on every
    /// `spawn()` so a key change is picked up the next time the child
    /// is launched.
    fn current_api_key(&self) -> String {
        self.api_key
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// Locate the Python interpreter.
    ///
    /// Tries `python` first, then `python3`, using the `which` crate.
    fn find_python() -> Result<PathBuf, ShimError> {
        which_command("python")
            .or_else(|_| which_command("python3"))
            .map(PathBuf::from)
            .map_err(|_| {
                ShimError::NoPython(
                    "neither `python` nor `python3` found on PATH".into(),
                )
            })
    }

    /// Spawn the shim subprocess, connecting stdin/stdout/stderr to pipes.
    ///
    /// The current value of `api_key` is read at spawn time and
    /// forwarded to the child via the `WANDB_API_KEY` env var. Callers
    /// who need to update the key (e.g. when the user changes their
    /// W&B credentials) should invoke `set_api_key` *before* calling
    /// `spawn` / `respawn_with_key`.
    ///
    /// # Errors
    /// Returns `ShimError::RequestFailed` if the process cannot be started.
    pub fn spawn(&self) -> Result<(), ShimError> {
        let mut child = std::process::Command::new(&self.python_path)
            .arg(&self.shim_script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("WANDB_API_KEY", &self.current_api_key())
            .spawn()
            .map_err(|e| ShimError::RequestFailed(format!("failed to spawn shim: {e}")))?;

        let stdin = child.stdin.take().expect("stdin was piped");
        let stdout = child.stdout.take().expect("stdout was piped");

        // Drain stderr in a dedicated thread so the shim's pipe buffer
        // doesn't fill up and block the child once it produces enough
        // output (e.g. during the venv-install progress events). Each
        // line is forwarded to the app log; non-UTF-8 bytes are
        // silently skipped by `lines()`.
        if let Some(stderr) = child.stderr.take() {
            let _ = std::thread::Builder::new()
                .name("shim-stderr-drain".into())
                .spawn(move || {
                    use std::io::BufRead;
                    let reader = std::io::BufReader::new(stderr);
                    for line in reader.lines().filter_map(Result::ok) {
                        log::warn!("[shim stderr] {line}");
                    }
                });
        }

        let writer: Box<dyn Write + Send> = Box::new(stdin);

        *self.child.lock().unwrap() = Some(child);
        *self.writer.lock().unwrap() = Some(writer);

        // Start async stdout reader that parses each line and dispatches:
        //   - "event"-keyed payloads → forwarded to event_tx as a ShimEvent
        //   - "type"-keyed payloads  → looked up in `pending` by `id`, and
        //     the corresponding oneshot sender is handed the ShimResponse
        //     value (result or error).
        let event_tx = self.event_tx.clone();
        let pending = Arc::clone(&self.pending);

        // Build the buffered reader inside the closure so its `.lines()`
        // iterator can take ownership of the reader without competing with
        // `stdout` having already been moved into the closure.
        tauri::async_runtime::spawn(async move {
            let reader = BufReader::new(stdout);
            for line in reader.lines().filter_map(Result::ok) {
                let value: serde_json::Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                if value.get("event").is_some() {
                    if let Ok(event) = serde_json::from_value::<protocol::ShimEvent>(value) {
                        let _ = event_tx.send(event);
                    }
                    continue;
                }

                if value.get("type").is_some() {
                    let id = match value.get("id").and_then(|v| v.as_u64()) {
                        Some(id) => id,
                        None => continue,
                    };

                    let sender = {
                        let mut pending = pending.lock().unwrap();
                        pending.remove(&id)
                    };

                    if let Some(sender) = sender {
                        if let Ok(response) =
                            serde_json::from_value::<protocol::ShimResponse>(value)
                        {
                            let payload = match response {
                                protocol::ShimResponse::Result { result, .. } => {
                                    result.unwrap_or(serde_json::Value::Null)
                                }
                                protocol::ShimResponse::Error { error, .. } => {
                                    serde_json::json!({
                                        ERROR_SENTINEL_KEY: true,
                                        "code": error.code,
                                        "message": error.message,
                                    })
                                }
                            };
                            let _ = sender.send(payload);
                        }
                    }
                }
            }

            // EOF reached — the shim exited cleanly or crashed. Until
            // this point, `pending` oneshot senders were parked on
            // `rx` inside `send()` calls. Without this block those
            // calls would hang until the 30s timeout fires, even
            // though the child is unambiguously dead. Notify every
            // pending sender with a synthetic JSON-RPC error so they
            // unblock immediately and the renderer sees a real
            // diagnostic instead of a timeout.
            //
            // `unwrap_or_else(|p| p.into_inner())` recovers from a
            // poisoned mutex — this task can run after a panic in
            // another `send()` call, and we don't want a poisoned
            // lock here to mask the actual root cause.
            let mut pending_guard =
                pending.lock().unwrap_or_else(|p| p.into_inner());
            let drained: Vec<(u64, oneshot::Sender<serde_json::Value>)> =
                pending_guard.drain().collect();
            drop(pending_guard);
            let drained_count = drained.len();
            for (_, sender) in drained {
                let _ = sender.send(serde_json::json!({
                    ERROR_SENTINEL_KEY: true,
                    "code": -32001,
                    "message": "shim subprocess exited",
                }));
            }
            if drained_count > 0 {
                log::warn!(
                    "[shim] stdout reader EOF — shim exited, notified {drained_count} pending request(s)"
                );
            } else {
                log::warn!("[shim] stdout reader EOF — shim exited");
            }
        });

        log::info!("[shim] spawned shim process (pid={})", self.pid().unwrap_or(0));
        Ok(())
    }

    /// Send a JSON-RPC request to the shim and asynchronously await the
    /// matching response.
    ///
    /// Allocates a fresh JSON-RPC `id`, registers a oneshot receiver in
    /// `pending`, writes the request line to the child's stdin, and then
    /// `await`s the response (with a 30 second timeout).
    ///
    /// # Errors
    /// Returns `ShimError::NotRunning` if the child is not alive, or if
    /// the response channel closes before a value is delivered.
    /// Returns `ShimError::RequestFailed` for serialization / write
    /// errors, timeout expiry, or a JSON-RPC `error` response from the
    /// shim.
    pub async fn send(&self, req: ShimRequest) -> Result<serde_json::Value, ShimError> {
        // Crash recovery: detect a previously-dead child before trying
        // to write to its (closed) stdin. Without this, a crash in the
        // shim leaves us holding a `Some(child)` whose stdin writer
        // has already been broken by the OS; the next write fails
        // with EPIPE and the user waits 30s for the request timeout
        // — and on the *following* request the broken pipe error
        // repeats indefinitely until app restart.
        //
        // `try_wait` is non-blocking: it returns the exit status if
        // the child has exited, or `Ok(None)` if it's still alive.
        // If the child died, drop the stale handle and spawn a fresh
        // one (which also re-opens a working stdin writer).
        {
            let mut child_guard = self.child.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(child) = child_guard.as_mut() {
                match child.try_wait() {
                    Ok(Some(_status)) => {
                        log::warn!("[shim] detected dead child — respawning");
                        *child_guard = None;
                        // Also drop the stale writer so spawn() doesn't
                        // short-circuit thinking we're already initialized.
                        *self.writer.lock().unwrap_or_else(|p| p.into_inner()) = None;
                    }
                    Ok(None) => { /* still running — nothing to do */ }
                    Err(e) => {
                        log::warn!("[shim] try_wait failed: {e}");
                    }
                }
            }
            if child_guard.is_none() {
                drop(child_guard);
                self.spawn()?;
            }
        }

        let (tx, rx) = oneshot::channel::<serde_json::Value>();

        let id = {
            let mut next = self.next_id.lock().unwrap();
            let id = *next;
            *next += 1;
            id
        };

        // Register the response receiver *before* writing the request so
        // the stdout reader can route the response back to us without a
        // race window.
        {
            let mut pending = self.pending.lock().unwrap();
            pending.insert(id, tx);
        }

        {
            let mut writer_guard = self.writer.lock().unwrap();
            let writer = writer_guard
                .as_mut()
                .ok_or(ShimError::NotRunning)?;

            let rpc = match &req {
                ShimRequest::ListRuns { project, limit, cursor } => serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "method": "list_runs",
                    "params": {
                        "project": project,
                        "limit": limit,
                        "cursor": cursor,
                    }
                }),
                ShimRequest::GetRun { run_id } => serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "method": "get_run",
                    "params": { "run_id": run_id }
                }),
                ShimRequest::GetMetricSeries { run_id, key } => serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "method": "get_metric_series",
                    "params": { "run_id": run_id, "key": key }
                }),
                ShimRequest::GetRunConfig { run_id } => serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "method": "get_run_config",
                    "params": { "run_id": run_id }
                }),
                ShimRequest::ListArtifacts { run_id } => serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "method": "list_artifacts",
                    "params": { "run_id": run_id }
                }),
            };

            let line = serde_json::to_string(&rpc)
                .map_err(|e| ShimError::RequestFailed(format!("serialization failed: {e}")))?;

            writeln!(writer, "{line}").map_err(|e| {
                ShimError::RequestFailed(format!("write to shim stdin failed: {e}"))
            })?;

            writer.flush().map_err(|e| {
                ShimError::RequestFailed(format!("flush failed: {e}"))
            })?;
        }

        match tokio::time::timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS), rx).await {
            Ok(Ok(value)) => {
                // ShimResponse::Error was encoded with the ERROR_SENTINEL_KEY
                // marker by the stdout reader — unwrap it back into an error.
                if let Some(obj) = value.as_object() {
                    if obj.get(ERROR_SENTINEL_KEY).and_then(|v| v.as_bool()) == Some(true) {
                        let message = obj
                            .get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown shim error")
                            .to_string();
                        return Err(ShimError::RequestFailed(message));
                    }
                }
                Ok(value)
            }
            Ok(Err(_recv_err)) => Err(ShimError::NotRunning),
            Err(_timeout) => {
                // Remove the pending entry so a late response is dropped on
                // the floor instead of being held forever.
                let mut pending = self.pending.lock().unwrap();
                pending.remove(&id);
                Err(ShimError::RequestFailed("timeout".into()))
            }
        }
    }

    /// Shut down the child process, drop all pending response receivers,
    /// and clear all handles.
    pub fn shutdown(&self) {
        // Drop all pending oneshot senders — their receivers will resolve
        // to `RecvError`, which `send()` translates to `ShimError::NotRunning`.
        // Poison-safe: recover from a poisoned mutex instead of panicking,
        // since this can run during unwind via `Drop`.
        {
            let mut pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
            pending.drain().for_each(|(_, sender)| drop(sender));
        }

        // Signal shutdown by dropping the writer (closes stdin of the child).
        *self.writer.lock().unwrap_or_else(|p| p.into_inner()) = None;

        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }

        log::info!("[shim] shutdown complete");
    }

    /// Attempt to respawn the shim with exponential back-off.
    ///
    /// Counts the restart, shuts down the existing child, waits a back-off
    /// interval, then calls `spawn()` again. Gives up after `MAX_RESTARTS`.
    ///
    /// # Errors
    /// Returns `ShimError::TooManyRestarts` if the restart budget is exhausted.
    /// Propagates any `ShimError` from `spawn()`.
    pub fn respawn(&self) -> Result<(), ShimError> {
        // Increment restart counter.
        let restarts = {
            let mut r = self.restarts.lock().unwrap();
            *r += 1;
            *r
        };

        if restarts > MAX_RESTARTS {
            return Err(ShimError::TooManyRestarts);
        }

        self.shutdown();

        // Exponential back-off: 1s, 2s, 4s, …
        let backoff = Duration::from_secs(1 << (restarts - 1).min(7) as u64);
        log::info!("[shim] respawning in {:.1}s (attempt {restarts}/{MAX_RESTARTS})", backoff.as_secs_f64());
        std::thread::sleep(backoff);

        self.spawn()
    }

    /// Restart the shim subprocess for a user-driven reason (typically:
    /// the W&B API key changed). Unlike `respawn()`, this **does not**
    /// count toward `MAX_RESTARTS` — a user changing their key has
    /// nothing to do with the child crashing, so it must not exhaust
    /// the crash-loop budget.
    ///
    /// Bumps the `key_respawns` counter (uncapped, telemetry-only) so
    /// the failure triage path can tell the two respawn causes apart.
    pub fn respawn_with_key(&self) -> Result<(), ShimError> {
        {
            let mut kr = self.key_respawns.lock().unwrap_or_else(|p| p.into_inner());
            *kr += 1;
            log::info!(
                "[shim] user-triggered respawn (key change) #{}",
                *kr
            );
        }

        self.shutdown();

        // Brief pause so the OS fully releases the previous child's
        // port/PID before the new one tries to bind. The
        // crash-loop `respawn` uses exponential back-off, but a user-
        // key change is intentionally fast — there's no failure to
        // back away from.
        let backoff = Duration::from_millis(200);
        std::thread::sleep(backoff);

        self.spawn()
    }

    /// Return the OS pid of the shim child process, if it is running.
    pub fn pid(&self) -> Option<u32> {
        self.child.lock().ok().and_then(|g| g.as_ref().map(|c| c.id()))
    }

    /// Return the current crash-loop restart count.
    pub fn restart_count(&self) -> u8 {
        self.restarts.lock().map(|g| *g).unwrap_or(0)
    }

    /// Return the number of user-triggered (key-change) respawns since
    /// construction. Unbounded; purely for telemetry / debug.
    pub fn key_respawn_count(&self) -> u64 {
        self.key_respawns
            .lock()
            .map(|g| *g)
            .unwrap_or(0)
    }
}

impl Drop for ShimManager {
    fn drop(&mut self) {
        // Only run shutdown if the child is still alive — avoids redundant
        // work and prevents re-locking during unwinding.
        if self.pid().is_some() {
            self.shutdown();
        }
    }
}