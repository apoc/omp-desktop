use std::collections::HashMap;
use std::io::{BufRead, BufReader, ErrorKind, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

/// Hard cap on a single RPC line. Defends the reader thread from runaway
/// agent output that could otherwise allocate unbounded memory.
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

/// Windows: prevent a console window from flashing when we spawn omp.exe
/// from a GUI-subsystem parent. omp speaks JSON-RPC over stdio, so it's
/// almost certainly a console-subsystem binary; without this flag Windows
/// would attach a fresh console (visible flash) on every spawn.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct BridgeInner {
    /// Generation token bumped every time a session is started for this id.
    /// Reader threads carry their own generation and only mutate the map
    /// when it still matches — a stale thread for a previous incarnation
    /// must never clobber the entry of a freshly started session that
    /// happens to share an id.
    gen: u64,
    /// Stdin wrapped in its own mutex so writes never serialize through
    /// the bridge map lock. A blocked write on a slow consumer can no
    /// longer deadlock concurrent `start_session` / `stop_session` calls.
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    /// Live child handle. Cleared once reaped on a background thread.
    child: Option<Child>,
}

/// Manages one omp process per tab session.
///
/// # Events
/// - `agent://line/{session_id}` — payload: a single JSON-encoded RPC
///   line (string). One event per line that omp wrote to stdout.
/// - `agent://exit/{session_id}` — payload: a string. Empty (`""`) on
///   normal process exit; non-empty contains a human-readable error
///   describing why the session ended (spawn failed, line truncated past
///   the safety cap, etc.). Frontends should treat any non-empty payload
///   as an error reason to surface.
pub struct AgentBridge {
    sessions: Arc<Mutex<HashMap<String, BridgeInner>>>,
    /// Cached spawn / startup errors keyed by `session_id`. Populated on
    /// `start_session` failure, cleared on success. `send` checks this
    /// when no live session is found so the frontend gets the *real*
    /// reason (e.g. "omp not on PATH") instead of a generic "session not
    /// found". Also exposed via the `session_status` Tauri command for
    /// proactive frontend queries.
    last_errors: Arc<Mutex<HashMap<String, String>>>,
    next_gen: AtomicU64,
}

impl AgentBridge {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            last_errors: Arc::new(Mutex::new(HashMap::new())),
            next_gen: AtomicU64::new(1),
        }
    }

    /// Spawn omp for a session. If a session with this id already exists
    /// it is replaced atomically; the previous child is reaped on a
    /// background thread so this never blocks. On spawn failure the
    /// error string is cached so subsequent `send` / `session_status`
    /// calls can surface the real reason.
    pub fn start_session(
        &self,
        session_id: String,
        cwd: Option<&str>,
        app: AppHandle,
    ) -> Result<(), String> {
        let mut child = match spawn_omp(cwd) {
            Ok(c) => c,
            Err(e) => {
                self.cache_error(&session_id, e.clone());
                return Err(e);
            }
        };
        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");
        let stdin_arc = Arc::new(Mutex::new(stdin));
        let gen = self.next_gen.fetch_add(1, Ordering::SeqCst);

        // Atomic install: drop any previous BridgeInner under the lock,
        // install the new one in the same critical section.
        let prev = {
            let mut s = self.sessions.lock().map_err(|_| "lock poisoned".to_string())?;
            s.insert(
                session_id.clone(),
                BridgeInner { gen, stdin: Some(stdin_arc), child: Some(child) },
            )
        };
        if let Some(mut prev) = prev {
            prev.stdin = None;
            if let Some(mut c) = prev.child.take() {
                // Reap off-thread so the Tauri command thread is never
                // blocked by a stuck process.
                thread::spawn(move || { let _ = c.kill(); let _ = c.wait(); });
            }
        }

        // Successful spawn — clear any cached error from a previous
        // failed attempt for this id.
        self.clear_error(&session_id);

        spawn_stdout_reader(self.sessions.clone(), session_id.clone(), gen, app, stdout);
        spawn_stderr_reader(session_id, stderr);
        Ok(())
    }

    pub fn stop_session(&self, session_id: &str) {
        let removed = {
            // Best-effort cleanup: silently bail on a poisoned lock
            // rather than panicking. The map is only readable in error
            // paths from this point on anyway.
            let Ok(mut s) = self.sessions.lock() else { return };
            s.remove(session_id)
        };
        if let Some(mut inner) = removed {
            inner.stdin = None;
            if let Some(mut c) = inner.child.take() {
                thread::spawn(move || { let _ = c.kill(); let _ = c.wait(); });
            }
        }
        self.clear_error(session_id);
    }

    /// Write a JSON line to the session's stdin. The map lock is held only
    /// long enough to clone the per-session stdin Arc; the actual write
    /// happens without the map lock so a blocked pipe never deadlocks
    /// concurrent management calls. If the session isn't running, the
    /// cached startup error (if any) takes precedence over a generic
    /// "session not found" so the frontend gets the real reason.
    pub fn send(&self, session_id: &str, line: &str) -> Result<(), String> {
        let stdin_arc = {
            let s = self.sessions.lock().map_err(|_| "lock poisoned".to_string())?;
            if let Some(inner) = s.get(session_id) {
                inner.stdin.clone()
            } else {
                if let Some(err) = self.last_error(session_id) {
                    return Err(err);
                }
                return Err(format!("session '{session_id}' not found"));
            }
        };
        let stdin_arc = stdin_arc.ok_or_else(|| "agent not running".to_string())?;

        // Strip any trailing CR/LF the caller appended. The omp RPC parser
        // is line-framed — a stray blank line corrupts the stream and a
        // newline embedded inside `line` would split one logical message
        // across two frames. We only handle the trailing case here; the
        // frontend is responsible for not embedding raw newlines in JSON
        // (which is invalid JSON anyway).
        let trimmed = line.trim_end_matches(['\r', '\n']);

        let mut stdin = stdin_arc.lock().map_err(|_| "stdin lock poisoned".to_string())?;
        writeln!(*stdin, "{trimmed}").map_err(|e| e.to_string())?;
        // ChildStdin is unbuffered, but flush() costs nothing and keeps
        // the contract explicit.
        stdin.flush().map_err(|e| e.to_string())
    }

    /// Look up the last cached spawn / startup error for a `session_id`.
    /// Returns `None` if the session is currently running cleanly (or
    /// has never been started for this id).
    pub fn last_error(&self, session_id: &str) -> Option<String> {
        let Ok(errs) = self.last_errors.lock() else { return None };
        errs.get(session_id).cloned()
    }

    fn cache_error(&self, session_id: &str, err: String) {
        if let Ok(mut errs) = self.last_errors.lock() {
            errs.insert(session_id.to_string(), err);
        }
    }

    fn clear_error(&self, session_id: &str) {
        if let Ok(mut errs) = self.last_errors.lock() {
            errs.remove(session_id);
        }
    }
}

impl Default for AgentBridge {
    fn default() -> Self { Self::new() }
}

impl Drop for AgentBridge {
    fn drop(&mut self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, mut inner) in sessions.drain() {
                inner.stdin = None;
                if let Some(mut c) = inner.child.take() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
            }
        }
    }
}

fn spawn_stdout_reader(
    sessions: Arc<Mutex<HashMap<String, BridgeInner>>>,
    sid: String,
    gen: u64,
    app: AppHandle,
    stdout: ChildStdout,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let line_event = format!("agent://line/{sid}");
        let exit_event = format!("agent://exit/{sid}");
        let mut buf: Vec<u8> = Vec::with_capacity(8192);
        let mut exit_reason = String::new();

        loop {
            buf.clear();
            match read_until_capped(&mut reader, b'\n', &mut buf, MAX_LINE_BYTES) {
                Ok((0, _)) => break, // EOF — pipe closed, child exited
                Ok((_, true)) => {
                    // Line was longer than MAX_LINE_BYTES. We drained the
                    // pipe through the next '\n' but `buf` holds only a
                    // truncated prefix — emitting it would feed the
                    // frontend invalid JSON, which JSON.parse drops
                    // silently and surfaces as "the agent skipped a turn".
                    // Drop the line, log clearly, and keep reading.
                    eprintln!(
                        "[omp/{sid}] dropped a stdout line that exceeded {MAX_LINE_BYTES} bytes; \
                         frontend will not see this RPC message"
                    );
                }
                Ok((_, false)) => {
                    // Strip trailing CR/LF.
                    while matches!(buf.last(), Some(b'\n' | b'\r')) {
                        buf.pop();
                    }
                    if buf.is_empty() { continue; }
                    let text = String::from_utf8_lossy(&buf).into_owned();
                    let _ = app.emit(&line_event, text);
                }
                Err(e) => {
                    exit_reason = format!("stdout read error: {e}");
                    break;
                }
            }
        }

        // Process exited. Only remove our own map entry — if start_session
        // already replaced this session with a fresh incarnation (higher
        // generation), leave it alone.
        if let Ok(mut s) = sessions.lock() {
            if let Some(inner) = s.get(&sid) {
                if inner.gen == gen {
                    s.remove(&sid);
                }
            }
        }
        // Empty payload = clean exit; non-empty = error reason. See the
        // AgentBridge doc-comment for the full event contract.
        let _ = app.emit(&exit_event, exit_reason);
    });
}

fn spawn_stderr_reader(sid: String, stderr: ChildStderr) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            eprintln!("[omp/{sid}] {line}");
        }
    });
}

/// `BufRead::read_until` with a hard byte cap. Once the cap is reached
/// further bytes are consumed off the pipe but discarded — readers never
/// allocate unbounded memory on runaway output.
///
/// Returns `(consumed, truncated)`:
/// - `consumed` = total bytes read off the pipe (including the delimiter).
///   Zero means EOF.
/// - `truncated` = `true` if the line was longer than `max` and the data
///   in `out` is a *prefix* of the actual line. Callers should refuse to
///   forward truncated payloads as if they were complete.
fn read_until_capped<R: BufRead>(
    r: &mut R,
    delim: u8,
    out: &mut Vec<u8>,
    max: usize,
) -> std::io::Result<(usize, bool)> {
    let mut total = 0;
    let mut truncated = false;
    loop {
        let avail = match r.fill_buf() {
            Ok(b) => b,
            Err(ref e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if avail.is_empty() { return Ok((total, truncated)); }
        let room = max.saturating_sub(out.len());
        let used = if let Some(i) = avail.iter().position(|&b| b == delim) {
            // Found the delimiter — frame the line and return.
            let take = (i + 1).min(room);
            if take < i + 1 { truncated = true; }
            out.extend_from_slice(&avail[..take]);
            let used = i + 1;
            r.consume(used);
            total += used;
            return Ok((total, truncated));
        } else {
            // No delimiter in the available chunk — keep reading.
            let take = avail.len().min(room);
            if take < avail.len() { truncated = true; }
            if take > 0 { out.extend_from_slice(&avail[..take]); }
            avail.len()
        };
        r.consume(used);
        total += used;
    }
}

fn spawn_omp(cwd: Option<&str>) -> Result<Child, String> {
    // On Windows, `Command::new` resolves bare "omp" against PATH and
    // PATHEXT (.exe etc.) via CreateProcess. We try the explicit ".exe"
    // name first because some systems have weird PATHEXT handling, then
    // fall back to bare "omp". We do NOT use `cmd /C` as a fallback —
    // it leaves the omp process orphaned when the parent cmd.exe is
    // killed, since Windows does not propagate process termination to
    // descendants without a Job Object.
    let candidates: &[&str] = if cfg!(windows) { &["omp.exe", "omp"] } else { &["omp"] };
    let mut last_err = String::from("no candidates tried");
    for name in candidates {
        let mut cmd = Command::new(name);
        cmd.args(["--mode", "rpc"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Suppress the transient console window that Windows would
        // otherwise attach to a console-subsystem child of a GUI parent.
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        if let Some(dir) = cwd {
            if !dir.is_empty() {
                cmd.current_dir(dir);
            }
        }
        match cmd.spawn() {
            Ok(child) => return Ok(child),
            Err(e) => {
                let msg = format!("{name}: {e}");
                eprintln!("[omp-desktop] spawn attempt failed: {msg}");
                last_err = msg;
            }
        }
    }
    Err(format!(
        "failed to spawn omp ({last_err}). Make sure omp is installed and on PATH."
    ))
}
