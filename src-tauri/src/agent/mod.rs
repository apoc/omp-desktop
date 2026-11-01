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
//! - [`ext_ui`]     — latest omp extension status lines / widgets (#52).
//! - [`inflight`]   — the assistant message being streamed, rebuilt from
//!   `messageUpdates: "delta"` frames.
//! - [`approvals`]  — open tool-approval prompts a grant is bound to.
//!
//! A stopped session's descendants (subagents, tool calls) die with it
//! through `crate::supervisor` (Job Object / process group).

mod approvals;
mod branch_policy;
pub mod ext_ui;
pub mod inflight;
mod inner;
pub mod journal;
mod reader;
pub mod spawn;

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::AppHandle;

use approvals::PendingApprovals;
use ext_ui::ExtUiState;
use inflight::{InFlight, Snapshot};
use inner::BridgeInner;
use journal::{EventJournal, Replay};
use reader::{spawn_stderr_reader, spawn_stdout_reader};
use spawn::spawn_omp;

/// Ring capacity for each session's event journal: headroom for the gap
/// between a tab losing its live listener and regaining it (background tab
/// switch). Counted in lines, and a streamed reply is one line per delta
/// (`DELTA_EVENT_FILTER`), a few hundred bytes each: 4096 of them hold a long
/// reply and its tool calls well inside the byte budget below.
const EVENT_JOURNAL_CAPACITY: usize = 4096;

/// Total byte budget for one session's event journal. Bounds the ring by
/// size as well as entry count: a single RPC line may be up to
/// `reader::MAX_LINE_BYTES` (16 MiB), so the line count alone (4096 × 16 MiB)
/// would permit tens of gigabytes of resident memory per open tab. 8 MiB comfortably holds a
/// normal background-tab gap while capping the pathological case.
const EVENT_JOURNAL_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Written to every omp process's stdin right after the spawn, before the
/// frontend sends anything: `message_update` frames then carry only their
/// increment instead of the whole message so far (rebuilt by the frontend's
/// `app/stream-delta.js` and by [`inflight`]). Sent here rather than by the
/// frontend so no process streams whole snapshots, a background tab the
/// phone prompts before it was ever shown included. omp 18.13.2 (the version
/// floor) is the first whose delta frames can be rebuilt.
const DELTA_EVENT_FILTER: &str =
    r#"{"type":"set_event_filter","events":null,"messageUpdates":"delta"}"#;

/// `type` values the frontend may legitimately send over `send_command`.
/// Anything else is rejected before it reaches omp's stdin — hardens the
/// boundary against a renderer bug (or injected script — the dev CSP keeps
/// `'unsafe-inline'` for Babel) forwarding an unintended or malformed
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
    // Retry row's Stop while omp waits between automatic retries: ends the
    // run on the last failure without `abort`'s other effects.
    "abort_retry",
    // Native realtime voice session controlled by the active desktop tab.
    "live_start",
    "live_stop",
    "live_mute",
    // Draft-only native microphone capture and transcription.
    "dictation_start",
    "dictation_stop",
    "follow_up",
    "steer",
    // Queue strip above the composer: edit omp's pending steer/follow-up
    // queue, which `queue_update` and `get_state.queuedMessages` report.
    "remove_queued_message",
    "promote_queued_message",
    "set_model",
    "cycle_model",
    "cycle_thinking_level",
    // Thinking-level menu on the composer pill: the current model's levels,
    // and the one picked.
    "get_available_thinking_levels",
    "set_thinking_level",
    "compact",
    "new_session",
    "export_html",
    "get_login_providers",
    "login",
    // omp's ask dialog: every question of one ask tool call in a single
    // `extension_ui_request` (method "ask"), answered with `answers[]`.
    "set_ask_dialog",
    // Subagent manager (src/app/subagents.js): subscription level, the
    // live-agent snapshot, per-agent transcript tailing, and the
    // inspector's message box and stop button for a running agent.
    "set_subagent_subscription",
    "get_subagents",
    "get_subagent_messages",
    "steer_subagent",
    "cancel_subagent",
    // Conversation tree (src/app/conversation-tree.js): "Branch here" starts
    // a new file from a user prompt, "Fork after the reply" from a turn's last
    // assistant entry. `fork` first shipped in omp 18.4.11 (below the version floor).
    "branch",
    "fork",
    // Goal mode: omp's `goal` command (get/create/resume/pause/drop).
    "goal",
    // Settings → Agent (#37): omp's session-scoped automatic compaction and
    // retry switches: sent to a new process when turned off, and to every
    // open tab on change.
    "set_auto_compaction",
    "set_auto_retry",
];

/// What one omp process is started with (`start_session` → `spawn_omp`).
#[derive(Clone, Copy)]
pub struct Launch<'a> {
    /// Project folder (`None` = omp's default).
    pub cwd: Option<&'a str>,
    /// Session file or id to resume, already validated by the caller.
    pub resume: Option<&'a str>,
    /// Resolved profile (`None` = the built-in one).
    pub profile: Option<&'a str>,
    /// `--approval-mode`, from `approval_mode::ApprovalModeStore::resolve`.
    pub mode: crate::approval_mode::ApprovalMode,
    /// Settings overlay passed as `--config=<path>` (the tab's browser
    /// `cdpUrl`, see `crate::browser`); `None` = no overlay.
    pub config: Option<&'a std::path::Path>,
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
    /// `launch.profile` selects the omp profile this session's process runs
    /// under (`None`/`"default"` = omp's own `~/.omp/agent` tree, no flag).
    /// It is per-session by design: each tab owns one omp process, so two
    /// tabs can run under different profiles (and approval modes) at the
    /// same time.
    pub fn start_session(
        &self,
        session_id: String,
        launch: Launch<'_>,
        app: AppHandle,
        rule_book: Arc<crate::approval::RuleBook>,
    ) -> Result<(), String> {
        let Launch {
            cwd,
            resume,
            profile,
            mode,
            config,
        } = launch;
        let (mut child, supervisor) = match spawn_omp(cwd, resume, profile, mode, config) {
            Ok(c) => c,
            Err(e) => {
                // Cached *and* returned: the caller gets the reason now, the
                // cache serves the frontend's later `session_status` query.
                self.cache_error(&session_id, e.clone());
                return Err(e);
            }
        };
        let mut stdin = child.stdin.take().expect("stdin piped");
        // A failed write means omp is already gone; the stdout reader reports
        // its exit like any other.
        let _ = writeln!(stdin, "{DELTA_EVENT_FILTER}");
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");
        let stdin_arc = Arc::new(Mutex::new(stdin));
        let stdin_for_reader = Arc::clone(&stdin_arc);
        let journal = Arc::new(Mutex::new(EventJournal::new(
            EVENT_JOURNAL_CAPACITY,
            EVENT_JOURNAL_MAX_BYTES,
        )));
        let ext_ui = Arc::new(Mutex::new(ExtUiState::default()));
        let inflight = Arc::new(Mutex::new(InFlight::default()));
        let project_root = cwd.filter(|c| !c.is_empty()).map(std::path::PathBuf::from);
        // A second copy of the folder: the reader checks rules against its
        // own on every prompt, this one travels with a grant.
        let approvals = Arc::new(Mutex::new(PendingApprovals::new(project_root.clone())));
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
                    ext_ui: Arc::clone(&ext_ui),
                    inflight: Arc::clone(&inflight),
                    approvals: Arc::clone(&approvals),
                    // Kept alive (pun intended) on the map entry; the reader
                    // thread below gets its own clone via `alive` moved into
                    // `StdoutReaderConfig`.
                    alive: Arc::clone(&alive),
                },
            );
            if let Some(inner) = &prev {
                inner.alive.store(false, Ordering::Release);
                crate::remote::tracker::tracker().on_exit(&session_id);
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
            ext_ui,
            inflight,
            approvals,
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
                crate::remote::tracker::tracker().on_exit(session_id);
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
    /// An `extension_ui_response` that reached omp settles its approval
    /// prompt: answered, it can no longer be granted ([`approvals`]).
    pub fn send(&self, session_id: &str, line: &str) -> Result<(), String> {
        // Strip any trailing CR/LF the caller appended. The omp RPC parser
        // is line-framed — a stray blank line corrupts the stream and a
        // newline embedded inside `line` would split one logical message
        // across two frames. We only handle the trailing case here; the
        // frontend is responsible for not embedding raw newlines in JSON
        // (which is invalid JSON anyway).
        let trimmed = line.trim_end_matches(['\r', '\n']);
        let command = validate_command_type(trimmed)?;
        let answered = approvals::answered_id(&command);

        let Some((stdin_arc, open, alive)) = self.with_entry(session_id, |inner| {
            (
                inner.stdin.as_ref().map(Arc::clone),
                answered.map(|_| Arc::clone(&inner.approvals)),
                answered.map(|_| Arc::clone(&inner.alive)),
            )
        })?
        else {
            return Err(self
                .last_error(session_id)
                .unwrap_or_else(|| format!("session '{session_id}' not found")));
        };
        let stdin_arc = stdin_arc.ok_or_else(|| "agent not running".to_string())?;
        write_command(&stdin_arc, trimmed, answered.zip(open.as_deref()))?;
        if let (Some(id), Some(alive)) = (answered, alive) {
            crate::remote::tracker::tracker().on_answered(session_id, id, &alive);
        }
        Ok(())
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
        let journal_arc = self
            .with_entry(session_id, |inner| Arc::clone(&inner.journal))?
            .ok_or_else(|| format!("session '{session_id}' not found"))?;
        let replay = journal_arc
            .lock()
            .map_err(|_| "journal lock poisoned".to_string())?
            .since(after_seq);
        Ok(replay)
    }

    /// The latest extension status lines and widgets of a session (see
    /// [`ext_ui`]). Empty for an unknown or ended session: the state lives on
    /// the map entry, which a process exit removes.
    pub fn extension_ui_state(&self, session_id: &str) -> ExtUiState {
        let Ok(Some(ext_ui)) = self.with_entry(session_id, |inner| Arc::clone(&inner.ext_ui))
        else {
            return ExtUiState::default();
        };
        // Copied out so the reader thread's lock is held only for the copy;
        // the command serialises the copy after the lock is released.
        ext_ui.lock().map_or_default(|s| s.clone())
    }

    /// The assistant message a session is streaming, as far as it got (see
    /// [`inflight`]); `None` between messages and for an unknown or ended
    /// session.
    pub fn streaming_message(&self, session_id: &str) -> Option<Snapshot> {
        let Ok(Some(inflight)) = self.with_entry(session_id, |inner| Arc::clone(&inner.inflight))
        else {
            return None;
        };
        // Copied out under the reader's lock, serialised after it is released.
        inflight.lock().ok().and_then(|s| s.snapshot())
    }

    /// `pick` applied to `session_id`'s map entry, holding the `sessions`
    /// lock only while `pick` runs: callers take an `Arc` handle out and lock
    /// or write through it after the map lock is released, so a slow pipe or
    /// a busy reader never blocks management calls (`approve_and_grant`
    /// instead makes a session grant in `pick`: a set insert that must not
    /// outlive the entry). `Ok(None)` for an unknown session.
    fn with_entry<T>(
        &self,
        session_id: &str,
        pick: impl FnOnce(&BridgeInner) -> T,
    ) -> Result<Option<T>, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "lock poisoned".to_string())?;
        Ok(sessions.get(session_id).map(pick))
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
    /// app exit and an update's relaunch (`AppHandle::request_restart`),
    /// both via `crate::kill_child_processes` — where a Unix child in its
    /// own process group would otherwise outlive us. Only
    /// ever called on the way out. Idempotent: the map is drained, so a
    /// later call (or `Drop`) finds nothing to do.
    pub fn shutdown_all(&self) {
        let children: Vec<std::process::Child> = {
            let Ok(mut sessions) = self.sessions.lock() else {
                return;
            };
            sessions
                .drain()
                .filter_map(|(_, mut inner)| {
                    // Mirrors `reap_and_clear_grants`: clear liveness first,
                    // so a reader thread that outlives this (it holds its
                    // own `Arc<AtomicBool>`) and later wakes on EOF finds no
                    // map entry *and* an already-false `alive`, instead of
                    // emitting into an `AppHandle` being torn down. Then the
                    // supervisor, whose Drop kills the whole tree.
                    inner.alive.store(false, Ordering::Release);
                    inner.stdin = None;
                    drop(inner.supervisor.take());
                    let mut child = inner.child.take()?;
                    let _ = child.kill();
                    Some(child)
                })
                .collect()
        };
        // Every tree is signalled before any wait, so the teardowns overlap
        // instead of adding up, and reader threads parked on the lock are
        // released first.
        for mut child in children {
            let _ = child.wait();
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
    // Both callers already cleared `alive` and the tracker under `sessions`
    // so a replacement session's state cannot be wiped after the lock drops.
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
/// against [`ALLOWED_COMMAND_TYPES`]; the parsed command on success.
/// Extracted as a pure function so the validation logic is unit-testable
/// without a running child process.
fn validate_command_type(trimmed: &str) -> Result<serde_json::Value, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(trimmed).map_err(|_| "command is not valid JSON".to_string())?;
    let cmd_type = parsed
        .get("type")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "command missing string 'type' field".to_string())?;
    if !ALLOWED_COMMAND_TYPES.contains(&cmd_type) {
        return Err(format!("command type '{cmd_type}' is not allowed"));
    }
    Ok(parsed)
}

/// Write one command line to omp's `stdin`, then — only once it was written
/// — settle the approval prompt it answers (`answered`: request id and the
/// process's open prompts). Generic over the writer, like
/// `reader::try_auto_approve`, so a test can pass a `Mutex<Vec<u8>>`.
fn write_command<W: Write>(
    stdin: &Mutex<W>,
    line: &str,
    answered: Option<(&str, &Mutex<PendingApprovals>)>,
) -> Result<(), String> {
    let mut w = stdin
        .lock()
        .map_err(|_| "stdin lock poisoned".to_string())?;
    writeln!(*w, "{line}").map_err(|e| e.to_string())?;
    // ChildStdin is unbuffered, but flush() costs nothing and keeps the
    // contract explicit.
    w.flush().map_err(|e| e.to_string())?;
    drop(w);
    if let Some((id, open)) = answered {
        approvals::settle(open, id);
    }
    Ok(())
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
    /// Steer / follow-up frames come from `OMP_SLASH.queuedFrame`
    /// (`src/app/slash-commands.js`), whose literal frames are checked too.
    #[test]
    fn every_command_live_js_sends_is_allowed() {
        // Argument prefixes of the call sites that carry no literal type:
        // the helper definitions and the forwarders inside them.
        const NON_LITERAL: &[&str] = &["cmd){", "cmd,timeout", "queuedFrame("];
        let flat = |source: &str| -> String { source.split_whitespace().collect() };
        let allowed = |ty: &str| {
            assert!(
                ALLOWED_COMMAND_TYPES.contains(&ty),
                "the webview sends '{ty}' but ALLOWED_COMMAND_TYPES rejects it"
            );
        };
        let live = flat(include_str!("../../../src/live.js"));
        let mut checked = 0;
        for callee in ["_send(", "_sendWithResponse(", "_sendToAll("] {
            for (idx, _) in live.match_indices(callee) {
                let args = &live[idx + callee.len()..];
                if let Some(rest) = args.strip_prefix("{type:\"") {
                    allowed(&rest[..rest.find('"').expect("closing quote on command type")]);
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
        let slash = flat(include_str!("../../../src/app/slash-commands.js"));
        let start = slash
            .find("functionqueuedFrame(")
            .expect("queuedFrame in slash-commands.js");
        // The function body: up to the next top-level function or export.
        let rest = &slash[start + 1..];
        let end = ["function", "window.OMP_SLASH"]
            .iter()
            .filter_map(|next| rest.find(next))
            .min()
            .map_or(slash.len(), |e| start + 1 + e);
        let body = &slash[start..end];
        let frames: Vec<&str> = body
            .match_indices("{type:\"")
            .map(|(idx, m)| {
                let rest = &body[idx + m.len()..];
                &rest[..rest.find('"').expect("closing quote on frame type")]
            })
            .collect();
        assert_eq!(
            frames,
            ["prompt", "steer", "follow_up"],
            "queuedFrame's frames"
        );
        frames.into_iter().for_each(allowed);
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

    fn open_prompt(id: &str) -> Mutex<PendingApprovals> {
        let open = Mutex::new(PendingApprovals::new(None));
        approvals::observe(
            &open,
            Some("extension_ui_request"),
            &approval_prompt(id, "bash"),
        );
        open
    }

    #[test]
    fn a_written_answer_settles_its_prompt() {
        let stdin: Mutex<Vec<u8>> = Mutex::new(Vec::new());
        let open = open_prompt("req-1");
        let line = r#"{"type":"extension_ui_response","id":"req-1","value":"Deny"}"#;
        write_command(&stdin, line, Some(("req-1", &open))).unwrap();
        assert_eq!(
            stdin.lock().unwrap().as_slice(),
            format!("{line}\n").as_bytes()
        );
        assert_eq!(open.lock().unwrap().tool("req-1"), None);
    }

    /// What `send` passes: a command that carries the prompt's id but is not
    /// an `extension_ui_response` answers nothing.
    #[test]
    fn a_command_that_answers_nothing_leaves_the_prompt_open() {
        let stdin: Mutex<Vec<u8>> = Mutex::new(Vec::new());
        let open = open_prompt("req-1");
        let line = r#"{"type":"get_state","id":"req-1"}"#;
        let command = validate_command_type(line).unwrap();
        let answered = approvals::answered_id(&command).map(|id| (id, &open));
        write_command(&stdin, line, answered).unwrap();
        assert_eq!(open.lock().unwrap().tool("req-1"), Some("bash"));
    }

    #[test]
    fn an_answer_omp_never_received_leaves_the_prompt_open() {
        let open = open_prompt("req-1");
        let line = r#"{"type":"extension_ui_response","id":"req-1","value":"Approve"}"#;
        assert!(write_command(&Mutex::new(Broken), line, Some(("req-1", &open))).is_err());
        assert_eq!(open.lock().unwrap().tool("req-1"), Some("bash"));
    }

    /// A stdin whose every write fails, as a pipe omp closed does.
    pub(super) struct Broken;

    impl Write for Broken {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// omp's tool-approval prompt `id` for `tool`, as the reader sees it.
    pub(super) fn approval_prompt(id: &str, tool: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "extension_ui_request", "id": id, "method": "select",
            "title": format!("Allow tool: {tool}\nCommand: ls"), "options": ["Approve", "Deny"],
        })
    }

    /// A map entry with no process behind it (generation 1, empty journal and
    /// extension state); a test overrides the fields it exercises.
    pub(super) fn idle_inner(alive: Arc<AtomicBool>) -> BridgeInner {
        BridgeInner {
            gen: 1,
            stdin: None,
            child: None,
            supervisor: None,
            journal: Arc::new(Mutex::new(EventJournal::new(
                EVENT_JOURNAL_CAPACITY,
                EVENT_JOURNAL_MAX_BYTES,
            ))),
            ext_ui: Arc::default(),
            inflight: Arc::default(),
            approvals: Arc::new(Mutex::new(PendingApprovals::new(None))),
            alive,
        }
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
                child: Some(child),
                // Kept so the flag is observable after the entry is drained.
                ..idle_inner(Arc::clone(&alive))
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
    fn extension_ui_state_follows_the_session_entry() {
        let bridge = AgentBridge::new();
        let mut state = ExtUiState::default();
        state.apply(&serde_json::json!({
            "type": "extension_ui_request", "id": "1", "method": "setStatus",
            "statusKey": "plan-mode", "statusText": "⏸ plan",
        }));
        bridge.sessions.lock().unwrap().insert(
            "sess-x".into(),
            BridgeInner {
                ext_ui: Arc::new(Mutex::new(state)),
                ..idle_inner(Arc::new(AtomicBool::new(true)))
            },
        );
        assert_eq!(
            bridge.extension_ui_state("sess-x").statuses[0].text,
            "⏸ plan"
        );
        assert_eq!(bridge.extension_ui_state("other"), ExtUiState::default());
        // An ended or stopped session's entry is gone, and its state with it.
        bridge.sessions.lock().unwrap().remove("sess-x");
        assert_eq!(bridge.extension_ui_state("sess-x"), ExtUiState::default());
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
        let prev = idle_inner(Arc::new(AtomicBool::new(true)));
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
        // Kept so the flag is observable after `prev` moves into
        // `reap_and_clear_grants` below.
        let prev = idle_inner(Arc::clone(&alive));

        reap_and_clear_grants("sess-x", prev, &rule_book);

        assert!(
            !alive.load(Ordering::Acquire),
            "superseding/reaping a session must clear its liveness flag so its \
             (possibly still-running) reader thread stops emitting for this id"
        );
    }

    #[cfg(unix)]
    #[test]
    fn send_updates_tracker_only_after_a_successful_pipe_write() {
        use crate::remote::tracker::tracker;
        use std::process::{Command, Stdio};
        use std::time::Instant;

        let bridge = AgentBridge::new();
        let sid = "tracker-send-success";
        tracker().on_frame(
            sid,
            Some("extension_ui_request"),
            Some(&approval_prompt("q", "bash")),
            Instant::now(),
            &AtomicBool::new(true),
        );
        let mut command = Command::new("cat");
        command.stdin(Stdio::piped()).stdout(Stdio::null());
        let mut child = crate::spawn_gate::spawn(&mut command).unwrap();
        let stdin = child.stdin.take().unwrap();
        bridge.sessions.lock().unwrap().insert(
            sid.into(),
            BridgeInner {
                stdin: Some(Arc::new(Mutex::new(stdin))),
                child: Some(child),
                ..idle_inner(Arc::new(AtomicBool::new(true)))
            },
        );
        bridge
            .send(
                sid,
                r#"{"type":"extension_ui_response","id":"q","value":"Deny"}"#,
            )
            .unwrap();
        assert_eq!(tracker().snapshot()[sid], (false, 0));
        tracker().on_exit(sid);
    }

    #[cfg(unix)]
    #[test]
    fn send_keeps_tracker_question_when_pipe_write_fails() {
        use crate::remote::tracker::tracker;
        use std::process::{Command, Stdio};
        use std::time::Instant;

        let bridge = AgentBridge::new();
        let sid = "tracker-send-failure";
        tracker().on_frame(
            sid,
            Some("extension_ui_request"),
            Some(&approval_prompt("q", "bash")),
            Instant::now(),
            &AtomicBool::new(true),
        );
        let mut command = Command::new("true");
        command.stdin(Stdio::piped());
        // The exclusive gate keeps every other thread from forking while the
        // pipe's read end exists: a child forked in that window would inherit
        // it (CLOEXEC acts only at exec) and keep the pipe open, so the write
        // below would land in the buffer instead of failing with EPIPE.
        // `spawn_gate::spawn` would take the gate shared and wait on itself.
        let (stdin, status) = {
            let _gate = crate::spawn_gate::exclusive();
            let mut child = command.spawn().unwrap();
            let stdin = child.stdin.take().unwrap();
            (stdin, child.wait().unwrap())
        };
        assert!(status.success());
        bridge.sessions.lock().unwrap().insert(
            sid.into(),
            BridgeInner {
                stdin: Some(Arc::new(Mutex::new(stdin))),
                ..idle_inner(Arc::new(AtomicBool::new(true)))
            },
        );
        assert!(bridge
            .send(
                sid,
                r#"{"type":"extension_ui_response","id":"q","value":"Deny"}"#
            )
            .is_err());
        assert_eq!(tracker().snapshot()[sid], (false, 1));
        tracker().on_exit(sid);
    }

    #[test]
    fn stopping_a_session_forgets_tracker_without_waiting_for_muted_reader() {
        let bridge = AgentBridge::new();
        let sid = "tracker-stop-session";
        let tracker = crate::remote::tracker::tracker();
        tracker.on_frame(
            sid,
            Some("agent_start"),
            None,
            std::time::Instant::now(),
            &AtomicBool::new(true),
        );
        bridge
            .sessions
            .lock()
            .unwrap()
            .insert(sid.into(), idle_inner(Arc::new(AtomicBool::new(true))));
        let dir = crate::test_support::TempDir::new("tracker", "stop-session");
        let rules = crate::approval::RuleBook::new(dir.path().to_path_buf());
        bridge.stop_session(sid, &rules);
        assert!(!tracker.snapshot().contains_key(sid));
    }
}
