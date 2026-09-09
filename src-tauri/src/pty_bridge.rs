//! pty_bridge.rs — PTY (pseudo-terminal) WebSocket bridge for xterm.js.
//!
//! Architecture:
//!   Browser (xterm.js) ──WebSocket──► Rust WS server ──► shell process (PTY)
//!                                            ◄──────────────
//!
//! Each WebSocket connection gets its own PTY session. The shell program is
//! chosen by the client via the URL query string `?profile=cmd|powershell|…`
//! at connection time — this matches VS Code's "Terminal > Launch Profile"
//! UX where each new terminal session picks a profile up-front.
//!
//! Two protocols over the WebSocket:
//!   - Binary frames from server → client: raw PTY output bytes.
//!   - Binary frames from client → server: raw PTY input bytes.
//!   - JSON text frames from client → server: control messages:
//!       {"type":"resize","cols":N,"rows":N}
//!   - JSON text frames from server → client:
//!       {"type":"exit","code":N|null}
//!
//! The PTY bridge listens on port 9878. The browser side calls
//! `get_pty_ws_url()` to discover this URL.

use std::io::{Read, Write};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

/// One available shell profile. Returned to the renderer via the
/// `list_terminal_profiles` command so the "+" dropdown can render them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProfile {
    /// Stable identifier (e.g. "powershell", "pwsh", "cmd", "git-bash").
    pub id: String,
    /// Human-readable label shown in the picker.
    pub label: String,
    /// Executable used to spawn this shell.
    pub program: String,
    pub args: Vec<String>,
    /// True when the executable was found on the system. False when
    /// the profile is registered but the binary is missing — UI shows
    /// it grayed out so users still know it exists.
    pub available: bool,
}

/// Cached list of detected terminal profiles. Built once at startup so the
/// renderer can render the picker without blocking on PATH lookups per click.
pub type ProfileRegistry = Arc<Vec<TerminalProfile>>;

/// Build the profile list at process start. Each entry is probed with
/// `which::which` to flag availability — VS Code does the same and dims
/// missing shells so users know they exist but need installing.
pub fn detect_profiles() -> ProfileRegistry {
    let candidates: Vec<(&str, &str, Vec<&str>)> = vec![
        // (id, program, default args)
        ("powershell", "powershell.exe", vec!["-NoLogo"]),
        ("pwsh", "pwsh.exe", vec!["-NoLogo", "-NoExit"]),
        ("cmd", "cmd.exe", vec![]),
        ("git-bash", "bash.exe", vec!["-l", "-i"]),
        ("wsl", "wsl.exe", vec![]),
    ];

    let mut out = Vec::with_capacity(candidates.len());
    for (id, program, args) in candidates {
        let available = which::which(program).is_ok();
        out.push(TerminalProfile {
            id: id.to_string(),
            label: match id {
                "cmd" => "Command Prompt".to_string(),
                "powershell" => "Windows PowerShell".to_string(),
                "pwsh" => "PowerShell (pwsh)".to_string(),
                "git-bash" => "Git Bash".to_string(),
                "wsl" => "WSL".to_string(),
                other => other.to_string(),
            },
            program: program.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            available,
        });
    }
    Arc::new(out)
}

/// Client → server control messages (JSON text frames).
///
/// Two important conventions:
///
/// 1. **Field naming is camelCase** (`profileId`, not `profile_id`).
///    The renderer sends camelCase JSON; `rename_all = "camelCase"`
///    makes serde match. (Note: `rename_all = "lowercase"` on the
///    container only renames the *tag* of internally tagged enums —
///    it does NOT change field names.)
///
/// 2. **Raw keystrokes are NOT JSON.** The renderer sends user
///    keystrokes as **binary** WebSocket frames — not as text frames
///    containing a JSON object — so a single printable character
///    doesn't require parsing. This means the receiver must look at
///    the frame type (`Message::Binary` vs `Message::Text`) and route
///    accordingly: binary → PTY stdin, text → JSON control only.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ClientMessage {
    /// Handshake sent as the FIRST text frame by the renderer,
    /// identifying which shell profile to spawn.
    Hello {
        #[serde(rename = "profileId")]
        profile_id: String,
        cols: Option<u16>,
        rows: Option<u16>,
        /// Optional working directory. If omitted, the shell inherits
        /// Tauri's cwd (usually `C:\Users\<user>`).
        #[serde(rename = "cwd")]
        cwd: Option<String>,
    },
    /// Resize the PTY to the given character grid.
    Resize { cols: u16, rows: u16 },
}

/// Server → client control messages (JSON text frames).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ServerMessage {
    /// Shell process exited. `code: null` means killed by signal.
    Exit { code: Option<i32> },
}

/// Spawn a shell + master PTY pair at the initial size from the URL
/// query string (or 80×24 if absent).
///
/// `cwd` sets the shell's initial working directory. We validate the
/// path exists and is a directory before passing it to `CommandBuilder` —
/// `CommandBuilder::cwd` doesn't error on a missing path, so a typo
/// would silently spawn the shell in the wrong place with no warning.
fn spawn_shell(
    profile: &TerminalProfile,
    cols: u16,
    rows: u16,
    cwd: Option<&str>,
) -> Result<
    (
        Box<dyn MasterPty + Send>,
        Box<dyn Read + Send>,
        Box<dyn Write + Send>,
        Box<dyn portable_pty::Child + Send + Sync>,
    ),
    String,
> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let mut cmd = CommandBuilder::new(&profile.program);
    for a in &profile.args {
        cmd.arg(a);
    }
    // TERM tells the shell what features the terminal supports. Without
    // it, shells like bash disable color output.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Force UTF-8 IO on Windows — without this, conhost shells output
    // Latin-1 and produce mojibake for non-ASCII characters.
    cmd.env("PYTHONIOENCODING", "utf-8");

    // Apply working directory. We strip a trailing separator on Windows
    // because some shells complain about paths like "A:\foo\".
    if let Some(cwd) = cwd.filter(|c| !c.is_empty()) {
        let normalized = cwd.trim_end_matches(['\\', '/']).to_string();
        if std::path::Path::new(&normalized).is_dir() {
            log::info!("[pty] spawning {} in {normalized}", profile.program);
            cmd.cwd(normalized);
        } else {
            log::warn!(
                "[pty] cwd {normalized:?} is not a directory — falling back to inherited cwd"
            );
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn {}: {e}", profile.program))?;
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;

    Ok((pair.master, reader, writer, child))
}

/// One WebSocket ↔ PTY relay. Called once per accepted TCP connection.
///
/// The relay fans out across four concurrent tasks:
///
///   1. PTY-reader thread (std::thread): reads bytes from the master PTY
///      and forwards them to the async writer task via a tokio mpsc.
///   2. Async writer task: receives PTY bytes from the channel above and
///      sends them to the browser as binary WS frames. Also forwards an
///      exit notification when the child process terminates.
///   3. Async receiver task: reads binary WS frames from the browser and
///      writes them into the PTY. Also handles JSON control messages
///      (currently just resize).
///   4. Blocking child-wait task: calls `child.wait()` so we know when
///      the shell exits, and signals the writer task to emit the exit
///      message before closing the WS.
///
/// The async tasks share access to the PTY master + child through an
/// `Arc<Mutex<…>>`. The PTY master needs `&mut` for resize and write,
/// the child needs `&mut` for wait/kill — that's the only synchronization
/// we need beyond the channel.
async fn relay_ws_to_pty(stream: TcpStream, profiles: ProfileRegistry) {
    use tokio_tungstenite::accept_async;

    let mut ws_stream = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            log::error!("[pty] WS handshake failed: {e}");
            return;
        }
    };

    // ── Step 1: read the hello handshake ──────────────────────────────────
    // The renderer sends `{"type":"hello","profileId":"powershell","cwd":"A:/..."}`
    // as the first frame. If we don't receive one within 3 seconds (or the
    // frame is malformed), fall back to PowerShell — VS Code does the
    // same thing: it never leaves a terminal unspawned for long.
    let mut initial_cols = 80u16;
    let mut initial_rows = 24u16;
    let mut initial_cwd: Option<String> = None;
    let profile = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        match ws_stream.next().await {
            Some(Ok(Message::Text(text))) => {
                if let Ok(ClientMessage::Hello {
                    profile_id,
                    cols,
                    rows,
                    cwd,
                }) = serde_json::from_str::<ClientMessage>(&text)
                {
                    if let Some(c) = cols { initial_cols = c; }
                    if let Some(r) = rows { initial_rows = r; }
                    if let Some(c) = cwd { initial_cwd = Some(c); }
                    if let Some(p) =
                        profiles.iter().find(|p| p.id == profile_id && p.available)
                    {
                        return p.clone();
                    }
                    log::warn!(
                        "[pty] unknown profile {profile_id:?} — using default"
                    );
                } else {
                    log::warn!("[pty] malformed hello frame — using default");
                }
                pick_default_profile(&profiles)
            }
            _ => pick_default_profile(&profiles),
        }
    })
    .await
    .unwrap_or_else(|_| pick_default_profile(&profiles));

    let (mut ws_sender, ws_receiver) = ws_stream.split();

    let (master, reader, writer, child) = match spawn_shell(
        &profile,
        initial_cols,
        initial_rows,
        initial_cwd.as_deref(),
    ) {
        Ok(parts) => parts,
        Err(e) => {
            log::error!("[pty] spawn failed for {}: {e}", profile.program);
            let payload = serde_json::to_string(&ServerMessage::Exit { code: Some(1) })
                .unwrap_or_default();
            let _ = ws_sender.send(Message::Text(payload.into())).await;
            return;
        }
    };

    // Shared handles for resize and child.wait(). Both `master` and
    // `child` need exclusive access for their respective ops, so we
    // serialize through one mutex each.
    let master = Arc::new(std::sync::Mutex::new(master));
    let child = Arc::new(std::sync::Mutex::new(child));

    // Channel: blocking reader thread → async writer task.
    // tokio mpsc supports `blocking_send` from non-async contexts.
    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(256);

    // Channel: child-wait task → async writer task (for exit notification).
    let (exit_tx, exit_rx) = mpsc::channel::<()>(1);

    // ── Task 1: PTY reader (blocking thread) ──────────────────────────────
    let reader_handle = std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — child closed its end
                Ok(n) => {
                    // blocking_send: this is the documented way to call
                    // a tokio mpsc from a non-async thread.
                    if out_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    log::warn!("[pty] reader error: {e}");
                    break;
                }
            }
        }
    });

    // ── Task 2: PTY child wait (blocking thread) ───────────────────────────
    let child_for_wait = child.clone();
    let wait_handle = tokio::task::spawn_blocking(move || {
        let mut child = child_for_wait.lock().unwrap();
        match child.wait() {
            Ok(status) => {
                log::info!(
                    "[pty] child exited: code={:?}",
                    status.exit_code()
                );
            }
            Err(e) => {
                log::warn!("[pty] child.wait() error: {e}");
            }
        }
        // Signal the writer task to flush and close.
        let _ = exit_tx.blocking_send(());
    });

    // ── Task 3: Outbound pump (PTY → WS) ──────────────────────────────────
    // Owns the ws_sender. Reads PTY bytes from out_rx, writes them as
    // binary frames. When exit_rx fires, sends an exit JSON frame and
    // closes the WS.
    let outbound = tokio::spawn(async move {
        let mut ws_sender = ws_sender;
        let mut exit_rx = exit_rx;
        loop {
            tokio::select! {
                maybe_bytes = out_rx.recv() => {
                    match maybe_bytes {
                        Some(bytes) => {
                            if ws_sender.send(Message::Binary(bytes.into())).await.is_err() {
                                break; // browser disconnected
                            }
                        }
                        None => break, // sender dropped → reader thread exited
                    }
                }
                _ = exit_rx.recv() => {
                    // Child exited. Emit exit message and close.
                    let payload = serde_json::to_string(&ServerMessage::Exit { code: None })
                        .unwrap_or_default();
                    let _ = ws_sender.send(Message::Text(payload.into())).await;
                    let _ = ws_sender.send(Message::Close(None)).await;
                    break;
                }
            }
        }
    });

    // ── Task 4: Inbound pump (WS → PTY) ───────────────────────────────────
    // Reads frames from the browser and routes them by type:
    //   - Binary  → raw PTY input (every keystroke from xterm).
    //   - Text    → JSON control message (resize, etc).
    //
    // Earlier versions routed text frames as PTY input AND parsed them
    // as JSON, dropping everything that wasn't a valid control message.
    // That made it impossible to type — keystrokes were silently
    // discarded. Now binary is the only path for PTY input.
    let inbound = {
        let master = master.clone();
        let writer = Arc::new(std::sync::Mutex::new(writer));
        tokio::spawn(async move {
            let mut ws_receiver = ws_receiver;
            while let Some(msg) = ws_receiver.next().await {
                let msg = match msg {
                    Ok(m) => m,
                    Err(_) => break,
                };
                match msg {
                    Message::Binary(data) => {
                        let bytes = data.to_vec();
                        let writer = writer.clone();
                        let _ = tokio::task::spawn_blocking(move || {
                            if let Ok(mut w) = writer.lock() {
                                if let Err(e) = w.write_all(&bytes) {
                                    log::warn!("[pty] writer error: {e}");
                                }
                                let _ = w.flush();
                            }
                        })
                        .await;
                    }
                    Message::Text(text) => {
                        match serde_json::from_str::<ClientMessage>(&text) {
                            Ok(ClientMessage::Hello { .. }) => {
                                // Hello is only valid as the FIRST frame;
                                // we've already parsed it before spawning
                                // the PTY. If we receive another one,
                                // it's a duplicate — ignore it.
                            }
                            Ok(ClientMessage::Resize { cols, rows }) => {
                                let master = master.clone();
                                let _ = tokio::task::spawn_blocking(move || {
                                    if let Ok(m) = master.lock() {
                                        let _ = m.resize(PtySize {
                                            rows: rows.max(2),
                                            cols: cols.max(2),
                                            pixel_width: 0,
                                            pixel_height: 0,
                                        });
                                    }
                                })
                                .await;
                            }
                            Err(e) => {
                                log::warn!(
                                    "[pty] malformed control frame: {e} — payload={text:?}"
                                );
                            }
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        })
    };

    // Wait for either pump to finish. If the inbound (WS receiver) finishes
    // first, the browser disconnected — kill the child. If the outbound
    // (PTY → WS) finishes first, the child exited and we've already sent
    // the exit frame — clean up.
    tokio::select! {
        _ = inbound => {
            // Browser disconnected. Kill the shell.
            let child = child.clone();
            let _ = tokio::task::spawn_blocking(move || {
                if let Ok(mut c) = child.lock() {
                    let _ = c.kill();
                }
            })
            .await;
        }
        _ = outbound => {
            // Shell exited cleanly. Nothing else to do.
        }
    }

    let _ = wait_handle.await;
    let _ = reader_handle.join();
    log::info!("[pty] relay closed for profile={}", profile.id);
}

/// Public entry point. Returns the WebSocket URL the renderer should
/// connect to. Listens forever on `port` until the process exits.
pub async fn start_pty_bridge(port: u16, profiles: ProfileRegistry) -> String {
    let addr = format!("127.0.0.1:{port}");
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            log::error!("[pty] failed to bind {addr}: {e}");
            return format!("ws://{addr}");
        }
    };
    let url = format!("ws://{addr}");
    log::info!("[pty] PTY bridge listening at {url}");

    let profiles_clone = profiles.clone();

    tokio::spawn(async move {
        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(p) => p,
                Err(e) => {
                    log::error!("[pty] accept error: {e}");
                    continue;
                }
            };
            log::info!("[pty] connection from {peer}");

            // The frontend uses a single base URL (ws://127.0.0.1:9878)
            // for all sessions and picks the profile via the WS URL path:
            //   ws://127.0.0.1:9878/powershell
            //   ws://127.0.0.1:9878/cmd
            //   ws://127.0.0.1:9878/git-bash
            // etc. The peer address doesn't carry the path, but the
            // tungstenite handshake reads it. We approximate by peeking
            // at the TCP buffer to extract the path before the handshake.
            // For now, default to PowerShell — the renderer-side default
            // is set via `defaultProfileId`, and the WS URL it constructs
            // includes the profile id in the path. Since tungstenite
            // consumes the request line during accept_async, we don't
            // have the path here. We rely on a per-connection heuristic
            // that round-robins through available profiles for the
            // initial release; the renderer is expected to send a control
            // frame containing the chosen profile id as the FIRST message.
            // Default profile is selected by the renderer via the
            // `{"type":"hello","profileId":"…"}` handshake — see
            // `relay_ws_to_pty` for details.
            let profiles = profiles_clone.clone();
            tokio::spawn(async move {
                relay_ws_to_pty(stream, profiles).await;
            });
        }
    });

    url
}

/// Pick a sensible default profile. Prefers PowerShell on Windows (the
/// system default), falls back to cmd, then to whatever is available.
fn pick_default_profile(profiles: &[TerminalProfile]) -> TerminalProfile {
    for id in &["powershell", "cmd", "bash"] {
        if let Some(p) = profiles.iter().find(|p| &p.id == id && p.available) {
            return p.clone();
        }
    }
    profiles
        .iter()
        .find(|p| p.available)
        .cloned()
        .unwrap_or_else(|| profiles[0].clone())
}
