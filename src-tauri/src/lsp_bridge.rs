//! lsp_bridge.rs — LSP server process manager + WebSocket bridge.
//!
//! Architecture:
//!   Browser ──WebSocket──► Rust WS server ──► LSP process stdin/stdout
//!                         ◄──────────────────────
//!
//! The Rust side only relays raw bytes. All LSP protocol intelligence lives in
//! the browser via @marimo-team/codemirror-languageserver (WebSocketTransport).
//!
//! Two LSP servers are supported:
//!   /lsp/pyright  →  pyright-langserver --stdio
//!   /lsp/ruff     →  ruff server --stdio
//!
//! Each server is spawned once per workspace root. The key in the process map is
//! "serverId:rootUri".

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, mpsc, RwLock};
use tokio_tungstenite::tungstenite::Message;

/// One LSP server process + its relay channels.
pub(crate) struct LspProcess {
    /// The running child process.
    pub(crate) child: Child,
    /// Sends LSP stdout bytes to all connected WebSocket clients.
    pub(crate) from_lsp_tx: broadcast::Sender<Vec<u8>>,
    /// Receives LSP stdin bytes from WebSocket clients.
    /// Stored as a tokio mpsc Sender (cloneable), so multiple WebSocket
    /// clients can send to the same process (though we only accept one at a
    /// time per process — see relay logic).
    pub(crate) to_lsp_tx: mpsc::Sender<Vec<u8>>,
}

/// Process map key: "serverId:rootUri"
pub(crate) type ProcessKey = String;

/// Shared LSP process map. Stored in Tauri app state via `app.manage()`.
pub(crate) type ProcessMap = Arc<RwLock<HashMap<ProcessKey, LspProcess>>>;
// ── LSP process spawning ────────────────────────────────────────────────────

async fn spawn_lsp_process(
    server_id: &str,
    root_uri: Option<&str>,
    port: u16,
) -> Result<LspProcess, String> {
    let (from_lsp_tx, _) = broadcast::channel::<Vec<u8>>(128);
    let (to_lsp_tx, mut to_lsp_rx) = mpsc::channel::<Vec<u8>>(128);

    let from_lsp_tx_clone = from_lsp_tx.clone();
    let server_id_owned = server_id.to_owned();

    // Resolve workspace root from rootUri (file:// URI → filesystem path).
    let root_path: Option<PathBuf> = root_uri
        .and_then(|uri| uri.strip_prefix("file://"))
        .map(PathBuf::from);

    let mut cmd = match server_id {
        "pyright" => {
            // pyright-langserver communicates over stdio.
            // Install:  pip install pyright
            let mut c = Command::new("pyright-langserver");
            c.arg("--stdio");
            if let Some(ref root) = root_path {
                c.args(["--rootPath", &root.to_string_lossy()]);
            }
            c
        }
        "ruff" => {
            // ruff-lsp communicates over stdio.
            // Install:  pip install ruff-lsp
            let mut c = Command::new("ruff");
            c.args(["server", "--stdio"]);
            c
        }
        other => return Err(format!("Unknown LSP server: {other}")),
    };

    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            format!(
                "Failed to spawn {server_id} server: {e}. \
                 Is it installed? (pyright: `pip install pyright`, ruff: `pip install ruff-lsp`)"
            )
        })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("{server_id}: cannot take stdout"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| format!("{server_id}: cannot take stdin"))?;

    // ── LSP stdout → broadcast channel → WebSocket clients ──────────────────
    tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut stdout = stdout;
        let mut buf = vec![0u8; 16384];
        loop {
            match stdout.read(&mut buf).await {
                Ok(0) => {
                    log::info!(
                        "[lsp:{port}] {id} stdout EOF — process exited",
                        id = server_id_owned
                    );
                    break;
                }
                Ok(n) => {
                    let bytes = buf[..n].to_vec();
                    let _ = from_lsp_tx_clone.send(bytes);
                }
                Err(e) => {
                    log::error!(
                        "[lsp:{port}] {id} stdout error: {e}",
                        id = server_id_owned,
                        e = e
                    );
                    break;
                }
            }
        }
        // Broadcast EOF signal so connected clients know the server died.
        let _ = from_lsp_tx_clone.send(Vec::new());
    });

    // ── WebSocket clients → LSP stdin ──────────────────────────────────────
    let id_owned = server_id.to_owned();
    tokio::spawn(async move {
        while let Some(bytes) = to_lsp_rx.recv().await {
            if bytes.is_empty() {
                break; // EOF marker
            }
            if stdin.write_all(&bytes).await.is_err() {
                log::error!("[lsp:{port}] {id} stdin write error", id = id_owned);
                break;
            }
            if stdin.flush().await.is_err() {
                log::error!("[lsp:{port}] {id} stdin flush error", id = id_owned);
                break;
            }
        }
        log::info!("[lsp:{port}] {id} stdin writer done", id = id_owned);
    });

    Ok(LspProcess {
        child,
        from_lsp_tx,
        to_lsp_tx,
    })
}

// ── WebSocket ↔ LSP relay ─────────────────────────────────────────────────

/// Relay messages between one WebSocket client and one LSP process.
/// The URL path determines which LSP server: `/lsp/pyright` or `/lsp/ruff`.
async fn relay_ws_to_lsp(
    stream: TcpStream,
    processes: ProcessMap,
    port: u16,
) {
    // Accept the WebSocket connection. We allow any path — the actual LSP
    // server routing is decided by the JSON content of the first message
    // (rootUri determines the workspace; the rootUri scheme determines the
    // server kind). The `/lsp/` path prefix is just a convention so other
    // WebSocket endpoints (if any) can coexist.
    use tokio_tungstenite::accept_async;
    let ws_stream = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            log::error!("[lsp:{port}] WS handshake failed: {e}");
            return;
        }
    };

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    // Read the first message — the LSP initialize request — to get rootUri.
    // This tells us which server instance to use (keyed by rootUri).
    let first_raw = match ws_receiver.next().await {
        Some(Ok(Message::Text(t))) => t.as_bytes().to_vec(),
        Some(Ok(Message::Binary(b))) => b.to_vec(),
        // Handle ping/pong/close/frame gracefully.
        Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Close(_) | Message::Frame(_))) => {
            return;
        }
        Some(Err(e)) => {
            log::error!("[lsp:{port}] WS read error: {e}");
            return;
        }
        None => return,
    };

    let first_str = String::from_utf8_lossy(&first_raw);
    let root_uri = extract_root_uri(&first_str);
    let server_id = if root_uri
        .as_deref()
        .map(|u| u.contains("ruff"))
        .unwrap_or(false)
    {
        "ruff"
    } else {
        "pyright"
    };

    let process_key = format!(
        "{}:{}",
        server_id,
        root_uri.as_deref().unwrap_or("default")
    );

    // Ensure the LSP process is running.
    let from_lsp_rx = {
        let mut processes = processes.write().await;
        if let Some(proc) = processes.get_mut(&process_key) {
            // Send the initialize request to the existing process.
            let _ = proc.to_lsp_tx.try_send(first_raw);
            proc.from_lsp_tx.subscribe()
        } else {
            // Spawn the process.
            match spawn_lsp_process(server_id, root_uri.as_deref(), port).await {
                Ok(lsp_proc) => {
                    // Feed the initialize request.
                    let _ = lsp_proc.to_lsp_tx.try_send(first_raw);
                    let rx = lsp_proc.from_lsp_tx.subscribe();
                    processes.insert(process_key.clone(), lsp_proc);
                    rx
                }
                Err(e) => {
                    log::error!("[lsp:{port}] Failed to spawn {server_id}: {e}");
                    let err_resp = serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": null,
                        "error": {
                            "code": -32002,
                            "message": e
                        }
                    });
                    let _ = ws_sender.send(Message::Text(err_resp.to_string().into())).await;
                    return;
                }
            }
        }
    };

    let processes_clone = processes.clone();
    let pk_clone = process_key.clone();

    // ── Task 1: LSP stdout → WebSocket ────────────────────────────────────
    let from_lsp_task = tokio::spawn(async move {
        let mut rx = from_lsp_rx;
        while let Ok(bytes) = rx.recv().await {
            if bytes.is_empty() {
                log::info!("[lsp:{port}] LSP stdout EOF");
                break;
            }
            if ws_sender.send(Message::Binary(bytes.into())).await.is_err() {
                break; // client disconnected
            }
        }
    });

    // ── Task 2: WebSocket → LSP stdin ──────────────────────────────────────
    let to_lsp_task = tokio::spawn(async move {
        while let Some(msg) = ws_receiver.next().await {
            match msg {
                Ok(Message::Text(t)) => {
                    let bytes = t.as_bytes().to_vec();
                    let processes = processes_clone.clone();
                    let mut p = processes.write().await;
                    if let Some(proc) = p.get_mut(&pk_clone) {
                        let _ = proc.to_lsp_tx.try_send(bytes);
                    }
                }
                Ok(Message::Binary(b)) => {
                    let processes = processes_clone.clone();
                    let mut p = processes.write().await;
                    if let Some(proc) = p.get_mut(&pk_clone) {
                        let _ = proc.to_lsp_tx.try_send(b.to_vec());
                    }
                }
                // Ping/pong are protocol-level — respond automatically, don't forward.
                Ok(Message::Ping(_)) => {
                    // tokio_tungstenite auto-responds to pings when used with split().
                }
                Ok(Message::Pong(_)) | Ok(Message::Close(_)) | Ok(Message::Frame(_)) | Err(_) => {
                    break;
                } // ignore other frames
            }
        }
        log::info!("[lsp:{port}] WebSocket sender task done");
    });

    // Wait for either task to finish.
    tokio::select! {
        _ = from_lsp_task => {},
        _ = to_lsp_task => {},
    }

    log::info!("[lsp:{port}] Relay for {process_key} closed");
}

// ── Utility ─────────────────────────────────────────────────────────────────

fn extract_root_uri(msg: &str) -> Option<String> {
    if let Some(start) = msg.find(r#""rootUri""#) {
        if let Some(colon) = msg[start..].find(':') {
            let after_colon = &msg[start + colon + 1..];
            let trimmed = after_colon.trim_start();
            if trimmed.starts_with('"') {
                let rest = &trimmed[1..];
                if let Some(end) = rest.find('"') {
                    return Some(rest[..end].to_owned());
                }
            }
        }
    }
    None
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Start the LSP WebSocket bridge server.
/// Returns the WebSocket URL that browser clients should connect to.
pub async fn start_bridge(port: u16, processes: ProcessMap) -> String {
    let addr = format!("127.0.0.1:{port}");
    let listener = TcpListener::bind(&addr)
        .await
        .expect("lsp_bridge: failed to bind port");
    let url = format!("ws://{addr}");

    log::info!("[lsp:{port}] LSP bridge listening at {url}");

    let processes_clone = processes.clone();

    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, peer)) => {
                    log::info!("[lsp:{port}] Connection from {peer}");
                    let p = processes_clone.clone();
                    tokio::spawn(relay_ws_to_lsp(stream, p, port));
                }
                Err(e) => {
                    log::error!("[lsp:{port}] Accept error: {e}");
                }
            }
        }
    });

    url
}
