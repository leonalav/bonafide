// ShimManager — spawns and manages the W&B adapter Python shim subprocess,
// communicates with it over stdio JSON-RPC, and handles respawn on crash.

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tokio::sync::mpsc;
use which::which as which_command;

use crate::shim::protocol::ShimRequest;

pub mod protocol;

/// Maximum number of automatic respawn attempts before giving up.
pub const MAX_RESTARTS: u8 = 3;

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
/// task consumes stdout asynchronously and forwards parsed `ShimEvent`s
/// to the event channel consumer.
pub struct ShimManager {
    /// Path to the Python shim script.
    shim_script: PathBuf,

    /// Absolute path to the Python interpreter.
    python_path: PathBuf,

    /// W&B API key passed to the shim via environment.
    api_key: String,

    /// Active child process, if any.
    child: Mutex<Option<Child>>,

    /// Buffered writer to the child process stdin.
    writer: Mutex<Option<Box<dyn Write + Send>>>,

    /// Monotonically increasing JSON-RPC id counter.
    next_id: Mutex<u64>,

    /// Number of respawn attempts made.
    restarts: Mutex<u8>,

    /// Sends async events (progress, log lines, etc.) from the stdout reader
    /// task to whoever is listening in the Tauri app.
    event_tx: mpsc::UnboundedSender<protocol::ShimEvent>,
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
            api_key,
            child: Mutex::new(None),
            writer: Mutex::new(None),
            next_id: Mutex::new(1),
            restarts: Mutex::new(0),
            event_tx,
        })
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
    /// # Errors
    /// Returns `ShimError::RequestFailed` if the process cannot be started.
    pub fn spawn(&self) -> Result<(), ShimError> {
        let mut child = std::process::Command::new(&self.python_path)
            .arg(&self.shim_script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("WANDB_API_KEY", &self.api_key)
            .spawn()
            .map_err(|e| ShimError::RequestFailed(format!("failed to spawn shim: {e}")))?;

        let stdin = child.stdin.take().expect("stdin was piped");
        let stdout = child.stdout.take().expect("stdout was piped");

        // Take stderr as-is so it surfaces in the terminal / logs.
        let _stderr = child.stderr.take();

        let writer: Box<dyn Write + Send> = Box::new(stdin);

        *self.child.lock().unwrap() = Some(child);
        *self.writer.lock().unwrap() = Some(writer);

        // Start async stdout reader that parses and forwards ShimEvents.
        let event_tx = self.event_tx.clone();
        let reader_handle = std::io::BufReader::new(stdout);
        tauri::async_runtime::spawn(async move {
            for line in reader_handle.lines().filter_map(Result::ok) {
                if let Ok(event) = serde_json::from_str::<protocol::ShimEvent>(&line) {
                    let _ = event_tx.send(event);
                }
            }
        });

        log::info!("[shim] spawned shim process (pid={})", self.pid().unwrap_or(0));
        Ok(())
    }

    /// Send a JSON-RPC request to the shim and return the parsed response.
    ///
    /// Writes a line-delimited JSON-RPC object to the shim's stdin.
    ///
    /// # Phase 0
    /// This is a **stub** — it writes the request but does not yet read the
    /// response. The response will be delivered asynchronously via the
    /// `event_tx` channel. Full implementation will use a `HashMap<u64,
    /// tokio::sync::oneshot::Sender>` to correlate request ids with pending
    /// response receivers.
    ///
    /// # Errors
    /// Returns `ShimError::NotRunning` if the child is not alive.
    /// Returns `ShimError::RequestFailed` if the write fails.
    pub fn send(&self, req: ShimRequest) -> Result<serde_json::Value, ShimError> {
        let mut writer_guard = self.writer.lock().unwrap();
        let writer = writer_guard
            .as_mut()
            .ok_or(ShimError::NotRunning)?;

        let id = {
            let mut next = self.next_id.lock().unwrap();
            let id = *next;
            *next += 1;
            id
        };

        let rpc = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": req,
        });

        let line = serde_json::to_string(&rpc)
            .map_err(|e| ShimError::RequestFailed(format!("serialization failed: {e}")))?;

        writeln!(writer, "{line}").map_err(|e| {
            ShimError::RequestFailed(format!("write to shim stdin failed: {e}"))
        })?;

        writer.flush().map_err(|e| {
            ShimError::RequestFailed(format!("flush failed: {e}"))
        })?;

        // PHASE0-TODO: implement async response channel using
        //   HashMap<u64, tokio::sync::oneshot::Sender>
        //   - on spawn(): read stdout lines, parse ShimResponse,
        //     look up the oneshot::Sender by `id`, send the result.
        //   - send() should take a oneshot::Receiver and await it here.
        Ok(serde_json::Value::Null)
    }

    /// Shut down the child process and clear all handles.
    pub fn shutdown(&self) {
        // Signal shutdown by dropping the writer (closes stdin of the child).
        *self.writer.lock().unwrap() = None;

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

    /// Return the OS pid of the shim child process, if it is running.
    pub fn pid(&self) -> Option<u32> {
        self.child.lock().ok().and_then(|g| g.as_ref().map(|c| c.id()))
    }

    /// Return the current restart count.
    pub fn restart_count(&self) -> u8 {
        self.restarts.lock().map(|g| *g).unwrap_or(0)
    }
}

impl Drop for ShimManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}
