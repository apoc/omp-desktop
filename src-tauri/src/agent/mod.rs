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
pub mod journal;
mod reader;
pub mod spawn;
mod supervisor;

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::AppHandle;

use inner::BridgeInner;
use journal::{EventJournal, Replay};
use reader::{spawn_stderr_reader, spawn_stdout_reader};
use spawn::spawn_omp;

/// Ring capacity for each session's event journal. 256 lines is generous
/// headroom for the gap between a tab losing its live listener and
/// regaining it (background tab switch) without holding unbounded memory
/// for a long-idle session.
const EVENT_JOURNAL_CAPACITY: usize = 256;

/// Total byte budget for one session's event journal. Bounds the ring by
/// size as well as entry count: a single RPC line may be up to
/// `reader::MAX_LINE_BYTES` (16 MiB), so 256 entries alone would permit
/// gigabytes of resident memory per open tab. 8 MiB comfortably holds a
/// normal background-tab gap while capping the pathological case.
const EVENT_JOURNAL_MAX_BYTES: usize = 8 * 1024 * 1024;

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
    "get_available_commands",
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
    // Subagent manager (src/app/subagents.js): subscription level, the
    // live-agent snapshot, and per-agent transcript tailing.
    "set_subagent_subscription",
    "get_subagents",
    "get_subagent_messages",
];

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
    /// Cached spawn / startup errors keyed by `session_id`. Two writers:
    /// `cache_error` on a `start_session` spawn failure (command thread),
    /// and the stdout reader thread on a startup death it explained via
    /// `StderrTail` (see `reader.rs`'s `spawn_stdout_reader`). Two
    /// clearing sites: `start_session` on its next successful spawn for
    /// this id, and `stop_session` unconditionally. `send` checks this
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
    ///
    /// `profile` selects the omp profile this session's process runs under
    /// (`None`/`"default"` = omp's own `~/.omp/agent` tree, no flag). It is
    /// per-session by design: each tab owns one omp process, so two tabs can
    /// run under different profiles at the same time.
    pub fn start_session(
        &self,
        session_id: String,
        cwd: Option<&str>,
        resume: Option<&str>,
        profile: Option<&str>,
        app: AppHandle,
        rule_book: Arc<crate::approval::RuleBook>,
    ) -> Result<(), String> {
        let (mut child, supervisor) = match spawn_omp(cwd, resume, profile) {
            Ok(c) => c,
            Err(e) => {
                // Cached *and* returned: the caller gets the reason now, the
                // cache serves the frontend's later `session_status` query.
                self.cache_error(&session_id, e.clone());
                return Err(e);
            }
        };
        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");
        let stdin_arc = Arc::new(Mutex::new(stdin));
        let stdin_for_reader = Arc::clone(&stdin_arc);
        let journal = Arc::new(Mutex::new(EventJournal::new(
            EVENT_JOURNAL_CAPACITY,
            EVENT_JOURNAL_MAX_BYTES,
        )));
        let project_root = cwd.filter(|c| !c.is_empty()).map(std::path::PathBuf::from);
        let gen = self.next_gen.fetch_add(1, Ordering::SeqCst);
        // Liveness flag for this incarnation. Cloned into the map entry
        // (so `reap_and_clear_grants`/supersession can clear it) and into
        // the reader config (so the reader's per-line hot path can check
        // it without taking the `sessions` mutex).
        let alive = Arc::new(AtomicBool::new(true));

        // Atomic install: drop any previous BridgeInner under the lock,
        // install the new one in the same critical section, and clear the
        // previous incarnation's `alive` flag before releasing the lock —
        // the stdout reader for that incarnation may be parked on this
        // same mutex and must observe `alive == false` the instant it can
        // see its map entry gone (see reader.rs's post-EOF `None` arm).
        let prev = {
            let mut s = self
                .sessions
                .lock()
                .map_err(|_| "lock poisoned".to_string())?;
            let prev = s.insert(
                // Owned by the map; `session_id` is still needed by the readers
                // and `reap_and_clear_grants` below.
                session_id.clone(),
                BridgeInner {
                    gen,
                    stdin: Some(stdin_arc),
                    child: Some(child),
                    supervisor: Some(supervisor),
                    journal: Arc::clone(&journal),
                    // Kept alive (pun intended) on the map entry; the reader
                    // thread below gets its own clone via `alive` moved into
                    // `StdoutReaderConfig`.
                    alive: Arc::clone(&alive),
                },
            );
            if let Some(inner) = &prev {
                inner.alive.store(false, Ordering::Release);
            }
            // Explicit, and not one line earlier: the store above *must*
            // happen while the lock is held, so a reader parked on this mutex
            // cannot wake to find its map entry gone while `alive` is still
            // true. Spelling the drop out marks this as the earliest correct
            // release point rather than an oversight.
            drop(s);
            prev
        };
        if let Some(prev) = prev {
            reap_and_clear_grants(&session_id, prev, &rule_book);
        }

        // Successful spawn — clear any cached error from a previous
        // failed attempt for this id.
        self.clear_error(&session_id);

        // Shared by both readers: stderr collects the reason, stdout decides
        // (at EOF) whether the child ever got far enough for that reason to
        // be the better explanation than a clean exit.
        let stderr_tail = Arc::new(Mutex::new(reader::StderrTail::new()));
        spawn_stdout_reader(reader::StdoutReaderConfig {
            sessions: Arc::clone(&self.sessions),
            // Last clone: `spawn_stderr_reader` takes the original by value.
            sid: session_id.clone(),
            gen,
            journal,
            stdin: stdin_for_reader,
            rule_book,
            project_root,
            app,
            stdout,
            alive,
            stderr_tail: Arc::clone(&stderr_tail),
            last_errors: Arc::clone(&self.last_errors),
        });
        spawn_stderr_reader(session_id, stderr, stderr_tail);
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
            let removed = s.remove(session_id);
            // Clear liveness before releasing the lock: a reader thread
            // parked on this same mutex must see `alive == false` the
            // instant it observes the entry gone, not after — see
            // reader.rs's post-EOF `None` arm.
            if let Some(inner) = &removed {
                inner.alive.store(false, Ordering::Release);
            }
            removed
        };
        if let Some(inner) = removed {
            reap_and_clear_grants(session_id, inner, rule_book);
        } else {
            // No live session to reap, but stale grants for this id must
            // still go — `reap_and_clear_grants` would have done it.
            rule_book.clear_session(session_id);
        }
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
                inner.stdin.as_ref().map(Arc::clone)
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
    pub fn replay_events(&self, session_id: &str, after_seq: u64) -> Result<Replay, String> {
        let journal_arc = {
            let s = self
                .sessions
                .lock()
                .map_err(|_| "lock poisoned".to_string())?;
            let inner = s
                .get(session_id)
                .ok_or_else(|| format!("session '{session_id}' not found"))?;
            let journal = Arc::clone(&inner.journal);
            drop(s);
            journal
        };
        let replay = journal_arc
            .lock()
            .map_err(|_| "journal lock poisoned".to_string())?
            .since(after_seq);
        Ok(replay)
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

    /// Kill and reap every session's process tree, synchronously. For the
    /// paths where the process is about to end *without* running `Drop` —
    /// an update's relaunch (`AppHandle::request_restart` / the Windows
    /// installer hand-off both end in `std::process::exit`), where a Unix
    /// child in its own process group would otherwise outlive us. Blocks
    /// briefly per child; only ever called on the way out. Idempotent: the
    /// map is drained, so a later call (or `Drop`) finds nothing to do.
    pub fn shutdown_all(&self) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        for (_, mut inner) in sessions.drain() {
            // Mirrors `reap_and_clear_grants`: clear liveness before
            // anything else, so a reader thread that outlives this
            // drain loop (it holds its own `Arc<AtomicBool>`) and later
            // wakes on EOF finds no map entry *and* an already-false
            // `alive`, instead of emitting into an `AppHandle` whose
            // webview is being torn down.
            inner.alive.store(false, Ordering::Release);
            inner.stdin = None;
            if let Some(mut c) = inner.child.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
            // `inner.supervisor` is left untouched here (unlike
            // start_session/stop_session, which move it off-thread) —
            // this whole path only runs on the way out, where blocking
            // briefly is acceptable; `inner` (and its supervisor) drops
            // automatically at the end of this loop body, which kills
            // the rest of the process tree via `ProcessSupervisor::Drop`.
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
        self.shutdown_all();
    }
}

/// Reap `prev`'s process tree off-thread (so the Tauri command thread is
/// never blocked by a stuck process) and drop its session-scoped
/// approval grants. A session id being replaced means a brand-new
/// process is taking over; whatever the previous occupant's user was
/// granted (e.g. "always allow bash for this session") must not
/// silently carry over and auto-approve prompts the new process never
/// actually got consent for. Used for both halves of a session's life:
/// [`AgentBridge::stop_session`] tearing one down, and `start_session`
/// displacing a previous occupant of the same id. Extracted as its own
/// function so this is unit-testable without spawning a real child
/// process or a Tauri `AppHandle`.
///
/// Also clears `prev.alive`, though both callers now already clear it
/// themselves while still holding the `sessions` lock that gave up
/// `prev` (see `start_session`'s insert and `stop_session`'s remove) —
/// a reader thread parked on that same mutex must see `alive == false`
/// the instant it can observe its map entry gone, which requires the
/// clear to happen in that critical section, not here. The store here is
/// now a redundant, idempotent safety net (and what the unit test below
/// pins), not the only clearing site.
fn reap_and_clear_grants(
    session_id: &str,
    mut prev: BridgeInner,
    rule_book: &crate::approval::RuleBook,
) {
    prev.alive.store(false, Ordering::Release);
    rule_book.clear_session(session_id);
    prev.stdin = None;
    let prev_supervisor = prev.supervisor.take();
    if let Some(mut c) = prev.child.take() {
        // The supervisor moves in too: its Drop kills the whole tree
        // (subagents, tool-call children) before the direct
        // child.kill()/wait() below reaps the now-dead process's zombie
        // entry.
        thread::spawn(move || {
            drop(prev_supervisor);
            let _ = c.kill();
            let _ = c.wait();
        });
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

    /// Every command `src/live.js` sends must survive `validate_command_type`
    /// — the allowlist silently drifted twice (`get_available_commands`, the
    /// subagent commands), and a rejected command only logs in the webview.
    ///
    /// Scans whitespace-free source so a reformat (multi-line object
    /// literals) cannot hide a call site, and fails on any `_send(` /
    /// `_sendWithResponse(` it cannot read — a new call site must either
    /// lead with a literal `type` or be added to the known non-literal list.
    #[test]
    fn every_command_live_js_sends_is_allowed() {
        // Argument prefixes of the call sites that carry no literal type:
        // the two helper definitions and `_sendWithResponse`'s forwarder.
        const NON_LITERAL: &[&str] = &["cmd){", "cmd,timeout", "{...cmd,id})"];
        let flat: String = include_str!("../../../src/live.js")
            .split_whitespace()
            .collect();
        let mut checked = 0;
        for callee in ["_send(", "_sendWithResponse("] {
            for (idx, _) in flat.match_indices(callee) {
                let args = &flat[idx + callee.len()..];
                if let Some(rest) = args.strip_prefix("{type:\"") {
                    let ty = &rest[..rest.find('"').expect("closing quote on command type")];
                    assert!(
                        ALLOWED_COMMAND_TYPES.contains(&ty),
                        "live.js sends '{ty}' but ALLOWED_COMMAND_TYPES rejects it"
                    );
                    checked += 1;
                } else {
                    let snippet: String = args.chars().take(40).collect();
                    assert!(
                        NON_LITERAL.iter().any(|known| args.starts_with(known)),
                        "cannot read the command type at {callee}{snippet}"
                    );
                }
            }
        }
        assert!(checked >= 20, "found only {checked} literal call sites");
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

    /// The updater's relaunch ends in `std::process::exit`, so `Drop` never
    /// runs — `shutdown_all` is the only thing standing between a session's
    /// omp child and an orphan. Proves it kills *and* reaps (a zombie would
    /// still have a `/proc` entry), empties the map, and clears liveness.
    #[cfg(target_os = "linux")]
    #[test]
    fn shutdown_all_kills_and_reaps_every_session() {
        let bridge = AgentBridge::new();
        let child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let proc_dir = std::path::PathBuf::from(format!("/proc/{}", child.id()));
        let alive = Arc::new(AtomicBool::new(true));
        bridge.sessions.lock().unwrap().insert(
            "sess-x".into(),
            BridgeInner {
                gen: 1,
                stdin: None,
                child: Some(child),
                supervisor: None,
                journal: Arc::new(Mutex::new(EventJournal::new(
                    EVENT_JOURNAL_CAPACITY,
                    EVENT_JOURNAL_MAX_BYTES,
                ))),
                // Kept so the flag is observable after the entry is drained.
                alive: Arc::clone(&alive),
            },
        );
        assert!(proc_dir.exists(), "precondition: child is running");

        bridge.shutdown_all();

        assert!(bridge.sessions.lock().unwrap().is_empty());
        assert!(!alive.load(Ordering::Acquire));
        assert!(
            !proc_dir.exists(),
            "shutdown_all must kill and reap the child, not leave it running or a zombie"
        );
    }

    #[test]
    fn replay_events_unknown_session_errors() {
        let bridge = AgentBridge::new();
        let err = bridge.replay_events("nope", 0).unwrap_err();
        assert!(err.contains("not found"));
    }

    #[test]
    fn replacing_a_session_clears_its_rule_book_session_grants() {
        let dir = std::env::temp_dir().join(format!(
            "omp-desktop-agent-mod-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let rule_book = crate::approval::RuleBook::new(dir);
        rule_book
            .grant("sess-x", None, "bash", crate::approval::RuleScope::Session)
            .unwrap();
        assert!(rule_book.is_granted("sess-x", None, "bash"));

        // Same shape `start_session` inserts on a fresh spawn — a session
        // with id "sess-x" being replaced without an intervening
        // `stop_session`.
        let prev = BridgeInner {
            gen: 1,
            stdin: None,
            child: None,
            supervisor: None,
            journal: Arc::new(Mutex::new(EventJournal::new(
                EVENT_JOURNAL_CAPACITY,
                EVENT_JOURNAL_MAX_BYTES,
            ))),
            alive: Arc::new(AtomicBool::new(true)),
        };
        reap_and_clear_grants("sess-x", prev, &rule_book);

        assert!(
            !rule_book.is_granted("sess-x", None, "bash"),
            "replacing a session must drop its previous occupant's session-scoped grants"
        );
    }

    #[test]
    fn reap_and_clear_grants_clears_the_alive_flag() {
        let dir = std::env::temp_dir().join(format!(
            "omp-desktop-agent-mod-test-alive-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let rule_book = crate::approval::RuleBook::new(dir);
        let alive = Arc::new(AtomicBool::new(true));
        let prev = BridgeInner {
            gen: 1,
            stdin: None,
            child: None,
            supervisor: None,
            journal: Arc::new(Mutex::new(EventJournal::new(
                EVENT_JOURNAL_CAPACITY,
                EVENT_JOURNAL_MAX_BYTES,
            ))),
            // Kept so the flag is observable after `prev` moves into
            // `reap_and_clear_grants` below.
            alive: Arc::clone(&alive),
        };

        reap_and_clear_grants("sess-x", prev, &rule_book);

        assert!(
            !alive.load(Ordering::Acquire),
            "superseding/reaping a session must clear its liveness flag so its \
             (possibly still-running) reader thread stops emitting for this id"
        );
    }
}
