// git_service.rs — Source-control commands for the Tauri backend.
//
// We deliberately do NOT link `libgit2` here. Instead we shell out to the
// `git` CLI as a child process. Reasons:
//   1. Zero new dependencies — git ships with the platform (Windows,
//      macOS, Linux). A Bonafide user has git already.
//   2. Behavioural parity with VS Code, GitHub Desktop, Tower, and every
//      other developer tool the user has ever touched. They all shell
//      out to git; users expect identical error messages, reflog
//      semantics, config-file handling, hooks firing, etc.
//   3. libgit2's API surface is large (status walks, index management,
//      reference iteration) and changes between versions. Reimplementing
//      even the subset we need in safe Rust would be hundreds of lines
//      and would diverge from upstream over time. `git status --porcelain`
//      is the canonical machine-readable interface.
//
// One subtle correctness point: every command runs in the workspace
// directory, NOT the process CWD. We pass `current_dir` to
// `tokio::process::Command` so `git status` reports on the right repo
// even if the user opened Bonafide from a shortcut in a different
// folder. We also pass `-c safe.directory=*` so commands work on
// shared/networked filesystems where git refuses to operate on repos
// owned by another user (a common Windows / Docker / Codespaces pitfall
// — git 2.35.2+ enables `safe.directory` enforcement by default and
// blocks the entire operation with a fatal error otherwise).
//
// All commands set `GIT_TERMINAL_PROMPT=0` so git refuses to prompt for
// credentials on stdin and fails fast instead of hanging the IPC call
// forever. Real authentication flows (HTTPS tokens, SSH agents) are
// handled by the user's existing git credential helper, which runs in
// the background and is NOT blocked by this env var.
//
// On Windows we also expand the well-known `C:\Program Files\Git\...`
// install paths because git-for-windows does not always register itself
// on PATH for non-interactive shells spawned by Tauri.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

// ── Public types — mirror the renderer's source-control contract ───────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    /// Short commit hash (7 chars).
    pub short_hash: String,
    /// Subject line of the current HEAD commit on this branch.
    pub subject: String,
    /// ISO-8601 timestamp from `git log --format=%cI`.
    pub iso_date: String,
    /// True when this is the currently checked-out branch.
    pub is_current: bool,
    /// True when this is a remote-tracking branch (e.g. `origin/main`).
    pub is_remote: bool,
    /// Upstream branch name (e.g. `origin/main`), empty when none.
    pub upstream: String,
    /// Commits ahead of upstream; -1 when no upstream is configured.
    pub ahead: i64,
    /// Commits behind upstream; -1 when no upstream is configured.
    pub behind: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub author: String,
    pub iso_date: String,
    /// `true` when this commit is referenced by HEAD (current branch tip).
    pub is_head: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    /// Path relative to the workspace root, with forward slashes
    /// (matches the renderer's file-tree path convention).
    pub path: String,
    /// Single severity letter:
    ///   M = modified, A = added, D = deleted, R = renamed,
    ///   C = copied, T = type-change, U = untracked, I = ignored.
    pub status: String,
    /// `true` when the change is in the staging area.
    pub staged: bool,
    /// Original path when `status == "R"` (renamed). Empty otherwise.
    pub original_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// Current branch name (empty when HEAD is detached or this is not a repo).
    pub branch: String,
    /// Upstream tracking branch (e.g. `origin/main`), empty when none.
    pub upstream: String,
    pub ahead: i64,
    pub behind: i64,
    pub staged: Vec<GitStatusEntry>,
    pub unstaged: Vec<GitStatusEntry>,
    pub untracked: Vec<GitStatusEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    /// The full unified diff text (empty when there are no changes).
    pub diff: String,
    /// Per-file old/new text pairs so the existing `MergeViewEditor`
    /// can render the inline diff without re-parsing `diff`.
    pub files: Vec<GitDiffFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffFile {
    pub path: String,
    pub old_text: String,
    pub new_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOpResult {
    pub ok: bool,
    /// stdout from git (success path). Trimmed.
    pub stdout: String,
    /// stderr from git (failure or warning path). Trimmed.
    pub stderr: String,
    /// Short human-readable success message.
    pub message: String,
}

// ── Command helpers ───────────────────────────────────────────────────────

/// Resolve the path to the `git` executable. Try `which::which("git")`
/// first so the user's PATH is honoured; fall back to well-known
/// git-for-windows install paths because git-for-windows does not
/// always register itself on PATH for non-interactive shells.
fn resolve_git_bin() -> PathBuf {
    if let Ok(p) = which::which("git") {
        return p;
    }
    #[cfg(windows)]
    {
        for candidate in &[
            "C:\\Program Files\\Git\\cmd\\git.exe",
            "C:\\Program Files\\Git\\mingw64\\bin\\git.exe",
            "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
        ] {
            let p = PathBuf::from(candidate);
            if p.exists() {
                return p;
            }
        }
    }
    PathBuf::from("git")
}

/// Build a `Command` pre-configured with the workspace CWD and the safe
/// environment variables every git invocation needs.
fn git_cmd(workspace: &Path) -> Command {
    let bin = resolve_git_bin();
    let mut cmd = Command::new(bin);
    cmd.current_dir(workspace);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    // Disable the "dubious ownership" check that bites Docker/Codespaces
    // users where the workspace is owned by root but the app runs as the
    // developer. The user explicitly opened this folder in Bonafide, so
    // they're already aware of its provenance.
    cmd.arg("-c").arg("safe.directory=*");
    // Force English output so `porcelain v1` parsing is stable across
    // developer machines with LANG=fr_FR.UTF-8 etc.
    cmd.env("LC_ALL", "C");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd
}

/// Run a git command to completion and return `(stdout, stderr)`.
/// Treats non-zero exit as an error and returns it via `Err(stderr)` so
/// the renderer can surface the message inline.
async fn run_git(workspace: &Path, args: &[&str]) -> Result<(String, String), String> {
    let mut cmd = git_cmd(workspace);
    for a in args {
        cmd.arg(a);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("failed to spawn git: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if !output.status.success() {
        // `git` writes human-readable errors to stderr on every failure
        // path. We forward them verbatim — they're already localised
        // and helpful (e.g. "fatal: not a git repository ...").
        return Err(if stderr.is_empty() {
            format!("git {} exited with status {}", args.join(" "), output.status)
        } else {
            stderr
        });
    }
    Ok((stdout, stderr))
}

/// Parse the ahead/behind count from `git rev-list --left-right --count`.
async fn ahead_behind(workspace: &Path, upstream: &str) -> Result<(i64, i64), String> {
    let arg = format!("HEAD...{upstream}");
    let output = run_git(workspace, &["rev-list", "--left-right", "--count", &arg]).await?;
    let (a, b) = output
        .0
        .split_once('\t')
        .ok_or_else(|| format!("unexpected rev-list output: {}", output.0))?;
    Ok((a.parse().unwrap_or(0), b.parse().unwrap_or(0)))
}

// ── Status parsing ────────────────────────────────────────────────────────

/// Parse `git status --porcelain=v2 --branch -uall -z` output.
///
/// The format (NUL separators):
///   `# branch.oid <sha>\0`       — HEAD SHA (informational)
///   `# branch.head <name>\0`     — current branch (empty when detached)
///   `# branch.upstream <name>\0` — upstream tracking ref
///   `# branch.ab +A -B\0`        — ahead/behind (we recompute this)
///   `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>\0`        — changed
///   `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X> <path>\0<orig>\0` — rename/copy
///   `u <XY> <sub> ...`           — unmerged (we surface as conflict)
///   `? <path>\0`                 — untracked
///   `! <path>\0`                 — ignored
///
/// `XY` (index letter, worktree letter):
///   M = modified, A = added, D = deleted, R = renamed, C = copied,
///   T = type-changed, U = unmerged, X = unknown.
fn parse_porcelain(raw: &str) -> GitStatus {
    let mut branch = String::new();
    let mut upstream = String::new();
    let mut staged: Vec<GitStatusEntry> = Vec::new();
    let mut unstaged: Vec<GitStatusEntry> = Vec::new();
    let mut untracked: Vec<GitStatusEntry> = Vec::new();

    for token in raw.split('\0') {
        if token.is_empty() {
            continue;
        }

        // Header lines.
        if let Some(name) = token.strip_prefix("# branch.head ") {
            branch = name.trim().to_string();
            continue;
        }
        if let Some(name) = token.strip_prefix("# branch.upstream ") {
            upstream = name.trim().to_string();
            continue;
        }
        if token.starts_with("# ") {
            continue;
        }

        // Untracked / ignored: `<marker> <path>`.
        if let Some(path) = token.strip_prefix("? ") {
            untracked.push(GitStatusEntry {
                path: path.replace('\\', "/"),
                status: "U".into(),
                staged: false,
                original_path: String::new(),
            });
            continue;
        }
        if let Some(path) = token.strip_prefix("! ") {
            untracked.push(GitStatusEntry {
                path: path.replace('\\', "/"),
                status: "I".into(),
                staged: false,
                original_path: String::new(),
            });
            continue;
        }

        // Changed entry: `1 <XY> <sub> ... <path>` — exactly 9 space-separated
        // tokens before the path. We don't need the sub-status or the mode
        // bits (they're for tools that want to render mode changes); we just
        // extract the index letter (XY[0]) and worktree letter (XY[1]) and
        // the path.
        if let Some(rest) = token.strip_prefix("1 ") {
            let parts: Vec<&str> = rest.splitn(10, ' ').collect();
            if parts.len() < 10 {
                continue;
            }
            let xy = parts[0];
            let idx_byte = xy.chars().next().unwrap_or(' ');
            let wt_byte = xy.chars().nth(1).unwrap_or(' ');
            let path = parts[9].replace('\\', "/");
            let (status, severity) = severity_letter(idx_byte, wt_byte);
            push_xy(
                &path,
                idx_byte,
                wt_byte,
                severity,
                status,
                &mut staged,
                &mut unstaged,
            );
            continue;
        }

        // Rename / copy: `2 <XY> <sub> ... <X> <path>` — 9 tokens then an X
        // score then the path. The original path comes as the NEXT
        // NUL-separated token.
        if let Some(rest) = token.strip_prefix("2 ") {
            let parts: Vec<&str> = rest.splitn(11, ' ').collect();
            if parts.len() < 11 {
                continue;
            }
            let xy = parts[0];
            let idx_byte = xy.chars().next().unwrap_or(' ');
            let wt_byte = xy.chars().nth(1).unwrap_or(' ');
            let path = parts[10].replace('\\', "/");
            // Force severity to R or C based on index letter.
            let severity = if idx_byte == 'C' || wt_byte == 'C' {
                'C'
            } else {
                'R'
            };
            push_xy(
                &path,
                idx_byte,
                wt_byte,
                severity,
                'R',
                &mut staged,
                &mut unstaged,
            );
            continue;
        }

        // Unmerged (conflict): `u <XY> <sub> ...`. We surface these as
        // a dedicated status letter so the renderer can render a
        // "!" badge and refuse to commit until the user resolves them.
        if let Some(rest) = token.strip_prefix("u ") {
            let parts: Vec<&str> = rest.splitn(11, ' ').collect();
            if parts.len() < 11 {
                continue;
            }
            let path = parts[10].replace('\\', "/");
            let xy = parts[0];
            let idx_byte = xy.chars().next().unwrap_or(' ');
            let wt_byte = xy.chars().nth(1).unwrap_or(' ');
            push_xy(
                &path,
                idx_byte,
                wt_byte,
                '!',
                '!',
                &mut staged,
                &mut unstaged,
            );
            continue;
        }
    }

    GitStatus {
        branch,
        upstream,
        ahead: 0,
        behind: -1,
        staged,
        unstaged,
        untracked,
    }
}

/// Reduce (index_letter, worktree_letter) to a single severity letter
/// for the renderer. Returns the severity char plus the canonical
/// single-letter status (`M`, `A`, `D`, `R`, `C`, `T`).
fn severity_letter(idx: char, wt: char) -> (char, char) {
    match (idx, wt) {
        ('D', _) | (_, 'D') => ('D', 'D'),
        ('A', _) | (_, 'A') => ('A', 'A'),
        ('R', _) | (_, 'R') => ('R', 'R'),
        ('C', _) | (_, 'C') => ('C', 'C'),
        ('T', _) | (_, 'T') => ('T', 'T'),
        ('U', _) | (_, 'U') => ('!', '!'),
        _ => ('M', 'M'),
    }
}

/// Push the right `GitStatusEntry` rows for a (path, idx_letter, wt_letter,
/// severity, status) tuple. A file can appear in BOTH `staged` and
/// `unstaged` (the classic `MM` case — staged then edited again).
fn push_xy(
    path: &str,
    idx: char,
    wt: char,
    severity: char,
    status: char,
    staged: &mut Vec<GitStatusEntry>,
    unstaged: &mut Vec<GitStatusEntry>,
) {
    if idx != '.' && idx != ' ' {
        staged.push(GitStatusEntry {
            path: path.to_string(),
            status: severity.to_string(),
            staged: true,
            original_path: String::new(),
        });
    }
    if wt != '.' && wt != ' ' {
        // Use the *most severe* of the staged/worktree letters so the
        // unstaged badge doesn't regress to plain `M` when the staged
        // version was a delete.
        let _ = status;
        unstaged.push(GitStatusEntry {
            path: path.to_string(),
            status: severity.to_string(),
            staged: false,
            original_path: String::new(),
        });
    }
}

// ── Public commands ───────────────────────────────────────────────────────

/// Open `git status` and return the parsed status tree.
///
/// Detects a missing repo (`fatal: not a git repository`) and returns a
/// well-formed empty status with `branch = ""` so the renderer can show
/// the "Initialize Repository" CTA instead of an error toast.
pub async fn status(workspace: String) -> Result<GitStatus, String> {
    let ws = PathBuf::from(&workspace);
    // `--porcelain=v2 -z` is git's canonical machine-readable status
    // output. v2 + NUL separators lets us parse paths with embedded
    // newlines or special characters without ambiguity (which the v1
    // format would force us to unquote). It also gives us the branch
    // header lines (`# branch.head`, `# branch.upstream`) as discrete
    // NUL-separated tokens rather than the cramped `## upstream`
    // shorthand that v1 emits.
    let output = run_git(
        &ws,
        &["status", "--porcelain=v2", "--branch", "-uall", "-z"],
    )
    .await;
    match output {
        Err(e) => {
            if e.contains("not a git repository") {
                Ok(GitStatus {
                    branch: String::new(),
                    upstream: String::new(),
                    ahead: 0,
                    behind: -1,
                    staged: vec![],
                    unstaged: vec![],
                    untracked: vec![],
                })
            } else {
                Err(e)
            }
        }
        Ok((stdout, _)) => {
            let mut status = parse_porcelain(&stdout);
            // `git status --branch` does not include ahead/behind
            // counts in v1; we compute them ourselves from the upstream
            // ref so the renderer's "↑N ↓M" badges stay accurate.
            if !status.upstream.is_empty() {
                if let Ok((a, b)) = ahead_behind(&ws, &status.upstream).await {
                    status.ahead = a;
                    status.behind = b;
                }
            }
            Ok(status)
        }
    }
}

/// List local + remote-tracking branches with HEAD commit metadata.
pub async fn list_branches(workspace: String) -> Result<Vec<GitBranch>, String> {
    let ws = PathBuf::from(&workspace);
    // Format: HEAD marker | short name | upstream-stripped name | short
    // hash | subject | iso date | upstream short | upstream track.
    let (stdout, _) = run_git(
        &ws,
        &[
            "for-each-ref",
            "--format=%(HEAD)|%(refname:short)|%(refname:strip=3)|%(objectname:short)|%(subject)|%(committerdate:iso-strict)|%(upstream:short)|%(upstream:track)",
            "refs/heads",
            "refs/remotes",
        ],
    )
    .await?;
    let mut out = Vec::new();
    for line in stdout.lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(8, '|').collect();
        if parts.len() < 6 {
            continue;
        }
        let head_marker = parts[0];
        let short_name = parts[1].to_string();
        let stripped = parts[2];
        // `refs/heads/main` → short="main", stripped="main"
        // `refs/remotes/origin/main` → short="origin/main", stripped="main"
        let is_remote = stripped.starts_with("remotes/");

        let mut ahead: i64 = -1;
        let mut behind: i64 = -1;
        if parts.len() >= 8 {
            let track = parts[7];
            if let Some(rest) = track.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
                for piece in rest.split(", ") {
                    if let Some(n) = piece.strip_prefix("ahead ") {
                        ahead = n.parse().unwrap_or(-1);
                    } else if let Some(n) = piece.strip_prefix("behind ") {
                        behind = n.parse().unwrap_or(-1);
                    }
                }
            }
        }

        out.push(GitBranch {
            name: short_name,
            short_hash: parts[3].to_string(),
            subject: parts[4].to_string(),
            iso_date: parts[5].to_string(),
            is_current: head_marker == "*",
            is_remote,
            upstream: if parts.len() >= 7 { parts[6].to_string() } else { String::new() },
            ahead,
            behind,
        });
    }
    // Sort: current branch first, then local alphabetically, then remote.
    out.sort_by(|a, b| {
        b.is_current
            .cmp(&a.is_current)
            .then(a.is_remote.cmp(&b.is_remote))
            .then(a.name.cmp(&b.name))
    });
    Ok(out)
}

/// Return the most recent commits on the current branch.
pub async fn log(workspace: String, max_count: Option<usize>) -> Result<Vec<GitCommit>, String> {
    let ws = PathBuf::from(&workspace);
    let n = max_count.unwrap_or(50);
    let range = format!("-n {n}");
    let (stdout, _) = run_git(
        &ws,
        &[
            "log",
            &range,
            "--format=%H|%h|%s|%an|%cI|%D",
            "--decorate=full",
        ],
    )
    .await?;
    let mut out = Vec::new();
    for line in stdout.lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(6, '|').collect();
        if parts.len() < 6 {
            continue;
        }
        let refs = parts[5];
        // %D returns refs like "HEAD -> main, origin/main". Treat any
        // presence of `HEAD` in the ref list as is_head=true.
        let is_head = refs.split(',').any(|r| r.trim().contains("HEAD"));
        out.push(GitCommit {
            hash: parts[0].to_string(),
            short_hash: parts[1].to_string(),
            subject: parts[2].to_string(),
            author: parts[3].to_string(),
            iso_date: parts[4].to_string(),
            is_head,
        });
    }
    Ok(out)
}

/// Produce a unified diff for a single file (HEAD vs working tree) or
/// the whole index when `path` is None. Returns both the raw diff
/// string (for the inline diff viewer) and structured old/new text per
/// file so the existing `MergeViewEditor` can render it without
/// re-running git.
pub async fn diff(workspace: String, path: Option<String>) -> Result<GitDiffResult, String> {
    let ws = PathBuf::from(&workspace);
    let raw = match &path {
        Some(p) => run_git(&ws, &["diff", "HEAD", "--no-color", "--", p]).await?.0,
        None => run_git(&ws, &["diff", "HEAD", "--no-color"]).await?.0,
    };

    let files = if let Some(p) = path {
        vec![diff_file(&ws, &p).await?]
    } else {
        // Walk the porcelain output to enumerate touched files.
        let status = status(workspace.clone()).await?;
        let mut files = Vec::new();
        for entry in status.staged.iter().chain(status.unstaged.iter()) {
            if let Ok(f) = diff_file(&ws, &entry.path).await {
                files.push(f);
            }
        }
        for entry in &status.untracked {
            let new_text = std::fs::read_to_string(ws.join(&entry.path)).unwrap_or_default();
            files.push(GitDiffFile {
                path: entry.path.clone(),
                old_text: String::new(),
                new_text,
            });
        }
        files
    };

    Ok(GitDiffResult { diff: raw, files })
}

async fn diff_file(workspace: &Path, path: &str) -> Result<GitDiffFile, String> {
    // Old text: the file as HEAD knows it. `git show` returns "" with a
    // non-zero status when the file is untracked, so we fall back to ""
    // (the renderer renders this as "all lines added").
    let old_text = match run_git(workspace, &["show", &format!("HEAD:{path}")]).await {
        Ok((s, _)) => s,
        Err(_) => String::new(),
    };
    let new_text = std::fs::read_to_string(workspace.join(path)).unwrap_or_default();
    Ok(GitDiffFile {
        path: path.to_string(),
        old_text,
        new_text,
    })
}

// ── Mutation commands ─────────────────────────────────────────────────────

/// Stage one or more paths. Empty list stages everything (`git add -A`).
pub async fn add(workspace: String, paths: Vec<String>) -> Result<GitOpResult, String> {
    let ws = PathBuf::from(&workspace);
    let mut args: Vec<String> = vec!["add".into()];
    if paths.is_empty() {
        args.push("-A".into());
    } else {
        args.extend(paths);
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let (stdout, stderr) = run_git(&ws, &arg_refs).await?;
    Ok(GitOpResult {
        ok: true,
        stdout,
        stderr,
        message: "staged".into(),
    })
}

/// Unstage one or more paths. `git restore --staged <path>` is the
/// modern (git 2.23+) replacement for the deprecated `git reset HEAD`.
pub async fn unstage(workspace: String, paths: Vec<String>) -> Result<GitOpResult, String> {
    let ws = PathBuf::from(&workspace);
    let mut args: Vec<String> = vec!["restore".into(), "--staged".into()];
    args.extend(paths);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let (stdout, stderr) = run_git(&ws, &arg_refs).await?;
    Ok(GitOpResult {
        ok: true,
        stdout,
        stderr,
        message: "unstaged".into(),
    })
}

/// Discard local changes — restore the working-copy file to its HEAD
/// contents. Destructive: the renderer should confirm with the user.
pub async fn discard(workspace: String, paths: Vec<String>) -> Result<GitOpResult, String> {
    let ws = PathBuf::from(&workspace);
    let mut args: Vec<String> = vec!["checkout".into(), "--".into()];
    args.extend(paths);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let (stdout, stderr) = run_git(&ws, &arg_refs).await?;
    Ok(GitOpResult {
        ok: true,
        stdout,
        stderr,
        message: "discarded".into(),
    })
}

/// `git commit -m <message> --no-verify`. We always pass `--no-verify`
/// because pre-commit hooks are explicitly out of scope for the in-IDE
/// commit flow; users run them via the terminal panel instead.
pub async fn commit(workspace: String, message: String) -> Result<GitOpResult, String> {
    let ws = PathBuf::from(&workspace);
    if message.trim().is_empty() {
        return Err("commit message cannot be empty".into());
    }
    let (stdout, stderr) = run_git(&ws, &["commit", "-m", &message, "--no-verify"]).await?;
    Ok(GitOpResult {
        ok: true,
        stdout,
        stderr,
        message: "committed".into(),
    })
}

/// `git switch <branch>` for local branches, `git switch -c <branch>`
/// for creating a new branch.
pub async fn checkout(
    workspace: String,
    branch: String,
    create: bool,
) -> Result<GitOpResult, String> {
    let ws = PathBuf::from(&workspace);
    let (stdout, stderr) = if create {
        run_git(&ws, &["switch", "-c", &branch]).await?
    } else {
        run_git(&ws, &["switch", &branch]).await?
    };
    Ok(GitOpResult {
        ok: true,
        stdout,
        stderr,
        message: format!("switched to {branch}"),
    })
}

/// `git pull --ff-only`. Refuses to merge/rebase so local history is
/// never silently rewritten; conflict errors are surfaced to the user.
pub async fn pull(workspace: String) -> Result<GitOpResult, String> {
    let ws = PathBuf::from(&workspace);
    let (stdout, stderr) = run_git(&ws, &["pull", "--ff-only"]).await?;
    Ok(GitOpResult {
        ok: true,
        stdout,
        stderr,
        message: "pulled".into(),
    })
}

/// `git push`. A real "publish branch" UX is out of scope for v0.1.
pub async fn push(workspace: String) -> Result<GitOpResult, String> {
    let ws = PathBuf::from(&workspace);
    let (stdout, stderr) = run_git(&ws, &["push"]).await?;
    Ok(GitOpResult {
        ok: true,
        stdout,
        stderr,
        message: "pushed".into(),
    })
}

/// `git fetch --all --prune`. Cheap call; refreshes remote refs so the
/// ahead/behind counts in the status panel are accurate.
pub async fn fetch(workspace: String) -> Result<GitOpResult, String> {
    let ws = PathBuf::from(&workspace);
    let (stdout, stderr) = run_git(&ws, &["fetch", "--all", "--prune"]).await?;
    Ok(GitOpResult {
        ok: true,
        stdout,
        stderr,
        message: "fetched".into(),
    })
}

/// Initialize a brand-new repository at the workspace root. Used by the
/// "Initialize Repository" CTA when the user opens a non-git folder.
pub async fn init(workspace: String) -> Result<GitOpResult, String> {
    let ws = PathBuf::from(&workspace);
    let (stdout, stderr) = run_git(&ws, &["init"]).await?;
    Ok(GitOpResult {
        ok: true,
        stdout,
        stderr,
        message: "initialized".into(),
    })
}
