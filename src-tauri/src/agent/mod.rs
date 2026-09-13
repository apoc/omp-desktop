//! Per-session omp process bridge.
//!
//! Each tab owns one omp child process spawned via `start_session`. Its
//! stdout is forwarded as `agent://line/{session_id}` Tauri events; its
//! exit (clean or otherwise) is announced as `agent://exit/{session_id}`.
//!
//! Submodules:
//! - [`inner`]      — `BridgeInner` per-session record (generation token,
//!   per-stdin mutex, child handle, event journal, process supervisor).
//! - [`spawn`]      — `spawn_omp` candidate-list resolution + Windows
//!   `CREATE_NO_WINDOW` flag.
//! - [`reader`]     — stdout/stderr reader threads, bounded
//!   `read_until_capped`, and credential redaction.
//! - [`journal`]    — bounded per-session event ring + replay.
//! - [`supervisor`] — process-tree kill (Job Object / process group) so a
//!   stopped session can't leak subagent/tool-call descendants.

mod inner;
mod journal;
mod reader;
mod spawn;
mod supervisor;

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::AppHandle;

use inner::BridgeInner;
use journal::EventJournal;
use reader::{spawn_stderr_reader, spawn_stdout_reader};
use spawn::spawn_omp;

/// Ring capacity for each session's event journal. 256 lines is generous
/// headroom for the gap between a tab losing its live listener and
/// regaining it (background tab switch) without holding unbounded memory
/// for a long-idle session.
const EVENT_JOURNAL_CAPACITY: usize = 256;

/// `type` values the frontend may legitimately send over `send_command`.
/// Anything else is rejected before it reaches omp's stdin — hardens the
/// boundary against a renderer bug (or a script running under the CSP's
/// `'unsafe-eval'` allowance) forwarding an unintended or malformed
/// command. Kept in sync with every `_send`/`_sendWithResponse` call site
/// in `src/live.js`.
const ALLOWED_COMMAND_TYPES: &[&str] = &[
    "extension_ui_response",
    "get_session_stats",
    "get_state",
    "get_messages",
    "get_available_models",
    "negotiate_protocol",
    "prompt",
    "abort",
    "follow_up",
    "steer",
    "set_model",
    "cycle_model",
    "cycle_thinking_level",
    "compact",
    "new_session",
    "export_html",
    "get_login_providers",
    "login",
];

/// One replayed event — mirrors `reader::LineEvent`'s `{seq, text}` shape so
/// the frontend can dispatch live and replayed events through one path.
#[derive(serde::Serialize, Debug)]
pub struct ReplayEvent {
    pub seq: u64,
    pub text: String,
}

/// Response for the `replay_events` Tauri command. See
/// [`journal::Replay`] for field semantics.
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplayResponse {
    pub events: Vec<ReplayEvent>,
    pub head_seq: u64,
    pub dropped: bool,
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
    ///
    /// `rule_book` is consulted (and its session-scope entry populated on
    /// `stop_session`/replacement) so a granted tool-approval rule can
    /// auto-answer matching prompts for this session — see
    /// `reader::try_auto_approve`.
    pub fn start_session(
        &self,
        session_id: String,
        cwd: Option<&str>,
        resume: Option<&str>,
        app: AppHandle,
        rule_book: Arc<crate::approval::RuleBook>,
    ) -> Result<(), String> {
        let (mut child, supervisor) = match spawn_omp(cwd, resume) {
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
        let stdin_for_reader = stdin_arc.clone();
        let journal = Arc::new(Mutex::new(EventJournal::new(EVENT_JOURNAL_CAPACITY)));
        let project_root = cwd.filter(|c| !c.is_empty()).map(std::path::PathBuf::from);
        let gen = self.next_gen.fetch_add(1, Ordering::SeqCst);

        // Atomic install: drop any previous BridgeInner under the lock,
        // install the new one in the same critical section.
        let prev = {
            let mut s = self
                .sessions
                .lock()
                .map_err(|_| "lock poisoned".to_string())?;
            s.insert(
                session_id.clone(),
                BridgeInner {
                    gen,
                    stdin: Some(stdin_arc),
                    child: Some(child),
                    supervisor: Some(supervisor),
                    journal: journal.clone(),
                },
            )
        };
        if let Some(mut prev) = prev {
            prev.stdin = None;
            let prev_supervisor = prev.supervisor.take();
            if let Some(mut c) = prev.child.take() {
                // Reap off-thread so the Tauri command thread is never
                // blocked by a stuck process. The supervisor moves in too:
                // its Drop kills the whole tree (subagents, tool-call
                // children) before the direct child.kill()/wait() below
                // reaps the now-dead process's zombie entry.
                thread::spawn(move || {
                    drop(prev_supervisor);
                    let _ = c.kill();
                    let _ = c.wait();
                });
            }
        }

        // Successful spawn — clear any cached error from a previous
        // failed attempt for this id.
        self.clear_error(&session_id);

        spawn_stdout_reader(reader::StdoutReaderConfig {
            sessions: self.sessions.clone(),
            sid: session_id.clone(),
            gen,
            journal,
            stdin: stdin_for_reader,
            rule_book,
            project_root,
            app,
            stdout,
        });
        spawn_stderr_reader(session_id, stderr);
        Ok(())
    }

    /// Kills the session's process tree and drops its session-scoped
    /// approval grants (`rule_book.clear_session`) — those must not
    /// silently apply to whatever process later reuses this session id.
    pub fn stop_session(&self, session_id: &str, rule_book: &crate::approval::RuleBook) {
        let removed = {
            // Best-effort cleanup: silently bail on a poisoned lock
            // rather than panicking. The map is only readable in error
            // paths from this point on anyway.
            let Ok(mut s) = self.sessions.lock() else {
                return;
            };
            s.remove(session_id)
        };
        if let Some(mut inner) = removed {
            inner.stdin = None;
            let supervisor = inner.supervisor.take();
            if let Some(mut c) = inner.child.take() {
                thread::spawn(move || {
                    drop(supervisor);
                    let _ = c.kill();
                    let _ = c.wait();
                });
            }
        }
        rule_book.clear_session(session_id);
        self.clear_error(session_id);
    }

    /// Write a JSON line to the session's stdin. The `type` field is
    /// checked against [`ALLOWED_COMMAND_TYPES`] before anything reaches
    /// the child process — a renderer bug or injected script can only ever
    /// forward commands the frontend legitimately sends today. The map
    /// lock is held only long enough to clone the per-session stdin Arc;
    /// the actual write happens without the map lock so a blocked pipe
    /// never deadlocks concurrent management calls. If the session isn't
    /// running, the cached startup error (if any) takes precedence over a
    /// generic "session not found" so the frontend gets the real reason.
    pub fn send(&self, session_id: &str, line: &str) -> Result<(), String> {
        // Strip any trailing CR/LF the caller appended. The omp RPC parser
        // is line-framed — a stray blank line corrupts the stream and a
        // newline embedded inside `line` would split one logical message
        // across two frames. We only handle the trailing case here; the
        // frontend is responsible for not embedding raw newlines in JSON
        // (which is invalid JSON anyway).
        let trimmed = line.trim_end_matches(['\r', '\n']);
        validate_command_type(trimmed)?;

        let stdin_arc = {
            let s = self
                .sessions
                .lock()
                .map_err(|_| "lock poisoned".to_string())?;
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

        let mut stdin = stdin_arc
            .lock()
            .map_err(|_| "stdin lock poisoned".to_string())?;
        writeln!(*stdin, "{trimmed}").map_err(|e| e.to_string())?;
        // ChildStdin is unbuffered, but flush() costs nothing and keeps
        // the contract explicit.
        stdin.flush().map_err(|e| e.to_string())
    }

    /// Look up the last cached spawn / startup error for a `session_id`.
    /// Returns `None` if the session is currently running cleanly (or
    /// has never been started for this id).
    pub fn last_error(&self, session_id: &str) -> Option<String> {
        let Ok(errs) = self.last_errors.lock() else {
            return None;
        };
        errs.get(session_id).cloned()
    }

    /// Events a session's frontend hasn't seen yet, per its bounded
    /// journal. Used on tab reactivation to recover state (tool cards, ask
    /// bubbles, streaming progress) that arrived while no listener was
    /// attached — `get_messages` alone only recovers persisted text.
    pub fn replay_events(
        &self,
        session_id: &str,
        after_seq: u64,
    ) -> Result<ReplayResponse, String> {
        let journal_arc = {
            let s = self
                .sessions
                .lock()
                .map_err(|_| "lock poisoned".to_string())?;
            let inner = s
                .get(session_id)
                .ok_or_else(|| format!("session '{session_id}' not found"))?;
            let journal = inner.journal.clone();
            drop(s);
            journal
        };
        let replay = journal_arc
            .lock()
            .map_err(|_| "journal lock poisoned".to_string())?
            .since(after_seq);
        Ok(ReplayResponse {
            events: replay
                .events
                .into_iter()
                .map(|e| ReplayEvent {
                    seq: e.seq,
                    text: e.text,
                })
                .collect(),
            head_seq: replay.head_seq,
            dropped: replay.dropped,
        })
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
    fn default() -> Self {
        Self::new()
    }
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
                // `inner.supervisor` is left untouched here (unlike
                // start_session/stop_session, which move it off-thread) —
                // this whole path only runs on app shutdown, where blocking
                // briefly is acceptable; `inner` (and its supervisor) drops
                // automatically at the end of this loop body, which kills
                // the rest of the process tree via `ProcessSupervisor::Drop`.
            }
        }
    }
}

/// Parse `trimmed` as JSON, require a string `type` field, and check it
/// against [`ALLOWED_COMMAND_TYPES`]. Extracted as a pure function so the
/// validation logic is unit-testable without a running child process.
fn validate_command_type(trimmed: &str) -> Result<(), String> {
    let parsed: serde_json::Value =
        serde_json::from_str(trimmed).map_err(|_| "command is not valid JSON".to_string())?;
    let cmd_type = parsed
        .get("type")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "command missing string 'type' field".to_string())?;
    if ALLOWED_COMMAND_TYPES.contains(&cmd_type) {
        Ok(())
    } else {
        Err(format!("command type '{cmd_type}' is not allowed"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_command_type_accepts_every_allowed_type() {
        for ty in ALLOWED_COMMAND_TYPES {
            let line = format!(r#"{{"type":"{ty}"}}"#);
            assert!(
                validate_command_type(&line).is_ok(),
                "{ty} should be allowed"
            );
        }
    }

    #[test]
    fn validate_command_type_rejects_unknown_type() {
        let err =
            validate_command_type(r#"{"type":"switch_session","path":"/etc/passwd"}"#).unwrap_err();
        assert!(err.contains("not allowed"));
    }

    #[test]
    fn validate_command_type_rejects_malformed_json() {
        let err = validate_command_type("not json").unwrap_err();
        assert!(err.contains("not valid JSON"));
    }

    #[test]
    fn validate_command_type_rejects_missing_type_field() {
        let err = validate_command_type(r#"{"message":"hi"}"#).unwrap_err();
        assert!(err.contains("missing string 'type'"));
    }

    #[test]
    fn validate_command_type_rejects_non_string_type() {
        let err = validate_command_type(r#"{"type":42}"#).unwrap_err();
        assert!(err.contains("missing string 'type'"));
    }

    #[test]
    fn replay_events_unknown_session_errors() {
        let bridge = AgentBridge::new();
        let err = bridge.replay_events("nope", 0).unwrap_err();
        assert!(err.contains("not found"));
    }
}
