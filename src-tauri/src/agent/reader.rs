use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, ErrorKind};
use std::path::PathBuf;
use std::process::{ChildStderr, ChildStdin, ChildStdout};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

use crate::approval::{self, RuleBook};
use crate::redaction::{is_credential_key, REDACTED_PLACEHOLDER};

use super::approvals::{self, PendingApprovals};
use super::ext_ui::{self, ExtUiState};
use super::frames::{self, ChunkAssembler, FrameError, Logical};
use super::inflight::{self, InFlight};
use super::inner::BridgeInner;
use super::journal::EventJournal;

/// Hard cap on a single RPC line. Defends the reader thread from runaway
/// agent output that could otherwise allocate unbounded memory.
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

/// The stdout reader thread's stack. Parsing, redacting, re-serializing and
/// dropping a frame each recurse once per nesting level, and the reader takes
/// frames up to [`frames::MAX_FRAME_DEPTH`] deep (D94-7). Measured for a
/// frame at that depth through the whole pipeline
/// (`a_frame_at_the_depth_ceiling_runs_on_the_reader_stack`): about 330 KiB
/// in a release build, 2.1 MiB in a debug build (nested objects; arrays
/// 1.75 MiB). The debug figure is already past Rust's 2 MiB default, so the
/// size is explicit, with about twice the worst measured case as margin.
/// Only [`reader_thread`]s get it. The one consumer that hands a deep value
/// to another thread is [`inflight`]: `streaming_message` serializes the
/// in-flight message on Tauri's blocking pool, whose stack is sized for that
/// separately ([`inflight::snapshot_json`]).
const READER_STACK_BYTES: usize = 4 * 1024 * 1024;

/// A thread with the stdout reader's stack ([`READER_STACK_BYTES`]): the
/// reader itself and the test that runs the ceiling frame on it.
fn reader_thread() -> thread::Builder {
    thread::Builder::new().stack_size(READER_STACK_BYTES)
}

/// One logical frame forwarded to the frontend (a line, a reassembled chunk
/// run of up to 64 MiB, or a diagnostic; see `frames.rs`), stamped with its
/// journal `seq`. Kept in sync with `replay_events`'s `ReplayEvent` — both
/// sides of the wire (live `agent://line/{id}` events and a replay
/// response) use the same `{seq, text}` shape so the frontend can dispatch
/// either through one path.
#[derive(serde::Serialize, Clone)]
struct LineEvent<'a> {
    seq: u64,
    text: &'a str,
}

/// Recursively replace the value of any object key matching [`REDACTED_KEYS`]
/// with [`REDACTED_PLACEHOLDER`]. A key matches when its normalized form
/// *ends with* one of [`REDACTED_KEYS`] — not just when it equals one —
/// so compound spellings like `x-api-key`/`OPENAI_API_KEY` (normalizing to
/// `xapikey`/`openaiapikey`, both ending in `apikey`) are caught, without a
/// bare substring/`contains` match that would also catch unrelated fields
/// such as `input_tokens`/`output_tokens` if a `token` entry were ever
/// added. Redacted subtrees are not descended into — once a key is
/// sensitive, nothing under it is worth preserving.
///
/// Returns `true` when at least one value was actually redacted, so the
/// caller can skip re-serializing an untouched frame — the overwhelmingly
/// common case.
///
/// [`REDACTED_KEYS`]: crate::redaction::REDACTED_KEYS
fn sanitize_frame(value: &mut serde_json::Value) -> bool {
    let mut redacted = false;
    match value {
        serde_json::Value::Object(map) => {
            for (key, val) in map.iter_mut() {
                if is_credential_key(key) {
                    *val = serde_json::Value::String(REDACTED_PLACEHOLDER.to_string());
                    redacted = true;
                } else {
                    redacted |= sanitize_frame(val);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                redacted |= sanitize_frame(item);
            }
        }
        _ => {}
    }
    redacted
}

/// The redacted text and value of one logical frame (see `frames.rs`). A
/// frame with nothing to redact keeps its exact text when it has one (the
/// overwhelmingly common case: one copy into the shared text, no second
/// serializer pass); a redacted or repaired frame is re-serialized from the
/// value. A diagnostic is its fixed text with no value: nothing of the line
/// it replaces survives, so it can carry no credential and no prompt.
fn sanitize_logical(logical: Logical<'_>) -> (Arc<str>, Option<serde_json::Value>) {
    match logical {
        Logical::Frame {
            mut value,
            verbatim,
        } => {
            let redacted = sanitize_frame(&mut value);
            // serde accepted the bytes, so they are UTF-8.
            let text = match verbatim.as_deref().map(std::str::from_utf8) {
                Some(Ok(text)) if !redacted => Arc::from(text),
                _ => Arc::from(value.to_string()),
            };
            (text, Some(value))
        }
        Logical::Error(error) => (Arc::from(error.text()), None),
    }
}

/// Strip trailing `\r`/`\n` bytes (any combination/order) off the end of
/// `buf` in place. Extracted as a pure function so the exact framing
/// behavior the stdout reader loop depends on is fixture-testable without
/// spawning a process — see `line_framing_fixture_matches_expected_...`
/// below, driven by `tests/fixtures/line-framing-cases.json`.
fn strip_trailing_crlf(buf: &mut Vec<u8>) {
    while matches!(buf.last(), Some(b'\n' | b'\r')) {
        buf.pop();
    }
}

/// If `frame` is a tool-approval prompt matching a currently-granted rule,
/// answer it directly on `stdin` (never forwarded to the frontend) and
/// return a synthetic `desktop_auto_approval` frame in its place so the
/// human still sees *what* was approved: the tool and the prompt's detail
/// lines (`details`, `null` when the title has none). Returns `None` for
/// every frame that isn't an approval prompt, or is one the rule book
/// doesn't cover — those fall through to the human exactly as before.
///
/// Generic over the stdin writer (`W: Write`) rather than hard-coded to
/// `ChildStdin` so unit tests can pass a `Mutex<Vec<u8>>` and assert on the
/// bytes written, instead of spawning a real child process (`cat` isn't
/// available on Windows) purely to obtain a writable handle. The real call
/// site passes `&Arc<Mutex<ChildStdin>>`, which still derefs to
/// `&Mutex<ChildStdin>` — `W = ChildStdin` there, unchanged behavior.
fn try_auto_approve<W: std::io::Write>(
    frame: &serde_json::Value,
    rule_book: &RuleBook,
    sid: &str,
    project_root: Option<&std::path::Path>,
    stdin: &Mutex<W>,
) -> Option<String> {
    let tool = approval::approval_tool_name(frame)?;
    if !rule_book.is_granted(sid, project_root, tool) {
        return None;
    }
    let id = approval::approval_request_id(frame)?;
    let response = approvals::approve_answer(id);
    if let Ok(mut w) = stdin.lock() {
        let _ = writeln!(*w, "{response}");
        let _ = w.flush();
    }
    Some(
        serde_json::json!({
            "type": "desktop_auto_approval",
            "tool": tool,
            "details": approval::approval_details(frame),
        })
        .to_string(),
    )
}

/// The reader's approval step for one parsed frame: a rule-covered prompt is
/// answered by [`try_auto_approve`] and its notice returned; any other frame
/// goes to the frontend as is and is shown to `approvals` first — a prompt
/// the human will see is one a grant may name, and omp's `cancel` settles
/// one. A prompt answered here is never recorded, so it cannot be granted.
fn auto_approve_or_track<W: std::io::Write>(
    frame: &serde_json::Value,
    frame_type: Option<&str>,
    rule_book: &RuleBook,
    sid: &str,
    project_root: Option<&std::path::Path>,
    stdin: &Mutex<W>,
    approvals: &Mutex<PendingApprovals>,
) -> Option<String> {
    let notice = try_auto_approve(frame, rule_book, sid, project_root, stdin);
    if notice.is_none() {
        approvals::observe(approvals, frame_type, frame);
    }
    notice
}

/// Everything the stdout reader does with omp's output, minus the pipe and
/// the webview: physical lines in, each logical frame through every step
/// once. `emit` sends one journaled frame to the frontend (`seq`, text,
/// frame type); it runs only while the incarnation is alive.
struct Pipeline<'a, W, E> {
    sid: &'a str,
    journal: &'a Mutex<EventJournal>,
    ext_ui: &'a Mutex<ExtUiState>,
    inflight: &'a Mutex<InFlight>,
    approvals: &'a Mutex<PendingApprovals>,
    stdin: &'a Mutex<W>,
    rule_book: &'a RuleBook,
    project_root: Option<&'a std::path::Path>,
    alive: &'a AtomicBool,
    emit: E,
    assembler: ChunkAssembler,
    /// omp announces itself with a `ready` frame, so "not one frame all run"
    /// means it died during startup — the only case where stderr explains
    /// more than the empty clean-exit payload. Only a parsed frame counts:
    /// not a blank line, not a terminal escape sequence flushed with no
    /// newline, and not a diagnostic standing in for a line that was no
    /// frame; counting those would silently disable the stderr fallback.
    saw_frame: bool,
}

impl<W: std::io::Write, E: FnMut(u64, &str, Option<&str>)> Pipeline<'_, W, E> {
    /// One physical line, CR/LF stripped and non-empty.
    fn line(&mut self, line: &[u8]) {
        // Taken out so the callback can borrow `self` mutably; put back after.
        let mut assembler = std::mem::take(&mut self.assembler);
        frames::logical_frames(&mut assembler, line, |logical| self.frame(logical));
        self.assembler = assembler;
    }

    /// A line dropped for exceeding [`MAX_LINE_BYTES`]: not a chunk (omp's
    /// chunk lines stay under 1 MiB), so it ends an open run.
    fn dropped_line(&mut self) {
        if self.assembler.interrupt() {
            self.frame(Logical::Error(FrameError::ChunkInterrupted));
        }
    }

    /// End of output: a run still open never completes.
    fn end(&mut self) {
        self.dropped_line();
    }

    /// The per-frame steps, in order.
    fn frame(&mut self, logical: Logical<'_>) {
        let (sanitized, parsed) = sanitize_logical(logical);
        self.saw_frame |= parsed.is_some();
        let frame_type = parsed
            .as_ref()
            .and_then(|frame| frame.get("type"))
            .and_then(serde_json::Value::as_str);
        // A rule-covered approval prompt is answered directly on stdin and
        // replaced with a synthetic notice — the human never sees the
        // original ask, but does see that it was auto-approved.
        let notice = parsed.as_ref().and_then(|frame| {
            auto_approve_or_track(
                frame,
                frame_type,
                self.rule_book,
                self.sid,
                self.project_root,
                self.stdin,
                self.approvals,
            )
        });
        let auto_approved = notice.is_some();
        // One allocation for the line, shared with the journal by refcount
        // rather than copied into it.
        let shared: Arc<str> = notice.map_or(sanitized, Arc::from);
        // Record in the tracker before exposing the frame in the journal: a
        // background tab activated in between cannot replay and answer a
        // question before the tracker knows it.
        record_tracker_frame(
            self.sid,
            frame_type,
            parsed.as_ref(),
            auto_approved,
            self.alive,
        );
        let seq = self
            .journal
            .lock()
            .map_or(0, |mut j| j.push(Arc::clone(&shared)));
        // After the push, stamped with its seq: a snapshot taken in between
        // names an older seq, so the frontend still applies this frame from
        // the replay.
        ext_ui::record(self.ext_ui, seq, frame_type, parsed.as_ref());
        if should_emit(self.alive) {
            // Also reruns rail widgets with a `turn_end` trigger on
            // `agent_end`, reusing the parse above.
            (self.emit)(seq, &shared, frame_type);
        }
        // Last use of the parse: the in-flight copy takes its blocks. After
        // the journal push like `ext_ui`, so a snapshot never names a seq
        // the journal lacks.
        inflight::record(self.inflight, seq, parsed);
    }
}

/// Grouped arguments for [`spawn_stdout_reader`] — bundled into one struct
/// rather than twelve positional parameters.
pub(super) struct StdoutReaderConfig {
    pub(super) sessions: Arc<Mutex<HashMap<String, BridgeInner>>>,
    pub(super) sid: String,
    pub(super) gen: u64,
    pub(super) journal: Arc<Mutex<EventJournal>>,
    /// This session's extension status lines and widgets, kept up to date
    /// for a tab that comes back with a `dropped` replay.
    pub(super) ext_ui: Arc<Mutex<ExtUiState>>,
    /// This session's in-flight assistant message, kept whole for a tab
    /// that comes back with a `dropped` replay.
    pub(super) inflight: Arc<Mutex<InFlight>>,
    /// This process's open approval prompts, for a grant to bind to.
    pub(super) approvals: Arc<Mutex<PendingApprovals>>,
    pub(super) stdin: Arc<Mutex<ChildStdin>>,
    pub(super) rule_book: Arc<RuleBook>,
    pub(super) project_root: Option<PathBuf>,
    pub(super) app: AppHandle,
    pub(super) stdout: ChildStdout,
    /// This incarnation's liveness flag — see [`BridgeInner::alive`].
    /// Checked via [`should_emit`] immediately before every emit so a
    /// superseded/reaped incarnation's reader goes mute without ever
    /// taking `sessions`.
    pub(super) alive: Arc<AtomicBool>,
    /// Shared with this session's stderr reader. Read only when the child
    /// exits without ever having produced a stdout frame, to turn a
    /// silent-looking clean exit into the reason omp actually printed.
    pub(super) stderr_tail: Arc<Mutex<StderrTail>>,
    /// The bridge's `last_errors` map. A startup death is recorded here as
    /// well as emitted, because the `agent://exit` event only reaches the
    /// tab that happens to be listening: a background tab's failure is
    /// otherwise invisible until `session_status` is asked, which is
    /// exactly what a later tab switch does.
    pub(super) last_errors: Arc<Mutex<HashMap<String, String>>>,
}

/// Whether an event from this incarnation should still reach the
/// frontend. `false` once [`BridgeInner::alive`] has been cleared —
/// superseded by a fresher `start_session`, reaped by `stop_session`, or
/// retired by this incarnation's own reader thread as it gives up its map
/// entry on ordinary child exit (see the end of [`spawn_stdout_reader`]).
/// A plain atomic load, never the `sessions` mutex: this gates the
/// per-stdout-line hot path, which must not contend with a global lock.
fn should_emit(alive: &AtomicBool) -> bool {
    alive.load(Ordering::Acquire)
}

/// Mirror frames from live processes only; auto-approved requests never open
/// a human dialog. No webview listener is needed for a background tab.
fn record_tracker_frame(
    sid: &str,
    frame_type: Option<&str>,
    frame: Option<&serde_json::Value>,
    auto_approved: bool,
    alive: &AtomicBool,
) {
    if !auto_approved {
        crate::remote::tracker::tracker().on_frame(
            sid,
            frame_type,
            frame,
            std::time::Instant::now(),
            alive,
        );
    }
}

fn retire_reader_session(
    sessions: &Mutex<HashMap<String, BridgeInner>>,
    sid: &str,
    gen: u64,
    alive: &AtomicBool,
) -> bool {
    let mut announce = false;
    if let Ok(mut s) = sessions.lock() {
        match s.get(sid).map(|inner| inner.gen) {
            Some(g) if g == gen => {
                // Still ours — we're the last stop for this id. Clear
                // `alive` and the tracker state before giving up the
                // entry so a concurrent replacement cannot have its own
                // tracker state wiped after the lock is released.
                s.remove(sid);
                alive.store(false, Ordering::Release);
                announce = true;
            }
            // A fresher incarnation already owns the id — stay mute,
            // its own reader speaks for it now.
            Some(_) => {}
            // Entry already gone: a racing `stop_session` or a
            // superseding `start_session` removed it and cleared
            // `alive` and the tracker inside that same critical section
            // before releasing the `sessions` lock (see `agent/mod.rs`).
            None => announce = should_emit(alive),
        }
        if announce {
            crate::remote::tracker::tracker().on_exit(sid);
        }
    }
    announce
}

pub(super) fn spawn_stdout_reader(config: StdoutReaderConfig) {
    let StdoutReaderConfig {
        sessions,
        sid,
        gen,
        journal,
        ext_ui,
        inflight,
        approvals,
        stdin,
        rule_book,
        project_root,
        app,
        stdout,
        alive,
        stderr_tail,
        last_errors,
    } = config;
    // `thread::spawn` with the reader's stack size; like `thread::spawn`, a
    // thread the OS refuses is a panic.
    let spawned = reader_thread().spawn(move || {
        let mut reader = BufReader::new(stdout);
        let line_event = format!("agent://line/{sid}");
        let exit_event = format!("agent://exit/{sid}");
        let mut buf: Vec<u8> = Vec::with_capacity(8192);
        let mut exit_reason = String::new();
        let mut pipeline = Pipeline {
            sid: &sid,
            journal: &journal,
            ext_ui: &ext_ui,
            inflight: &inflight,
            approvals: &approvals,
            stdin: &stdin,
            rule_book: &rule_book,
            project_root: project_root.as_deref(),
            alive: &alive,
            emit: |seq, text: &str, frame_type: Option<&str>| {
                let _ = app.emit(&line_event, LineEvent { seq, text });
                // Rail widgets with a `turn_end` trigger rerun after the
                // turn's last frame.
                if frame_type == Some("agent_end") {
                    crate::widgets::notify_turn_end(&app, &sid);
                }
            },
            assembler: ChunkAssembler::default(),
            saw_frame: false,
        };

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
                    pipeline.dropped_line();
                }
                Ok((_, false)) => {
                    strip_trailing_crlf(&mut buf);
                    if !buf.is_empty() {
                        pipeline.line(&buf);
                    }
                }
                Err(e) => {
                    exit_reason = format!("stdout read error: {e}");
                    break;
                }
            }
        }
        pipeline.end();
        let saw_frame = pipeline.saw_frame;
        drop(pipeline);

        // A child that died during startup (no frame, non-error EOF) would
        // otherwise report the empty payload the contract defines as a clean
        // exit, leaving a blank tab with no explanation anywhere in the UI.
        // omp's own reason is on stderr: `--mode rpc-ui` refuses to start
        // when the profile has no usable model, which is exactly what a
        // freshly created (credential-less) profile looks like.
        if exit_reason.is_empty() && !saw_frame {
            if let Some(reason) = stderr_tail.lock().ok().and_then(|t| t.to_reason()) {
                exit_reason = reason;
            }
        }
        // Process exited. Decide whether to announce inside the same
        // critical section that gives up our map entry — deciding it
        // separately (as before) left a window where a self-removed entry
        // stayed `alive` forever: nothing else ever clears the flag for an
        // incarnation that retires on its own, since `reap_and_clear_grants`
        // only runs when *something else* supersedes or reaps this entry.
        let announce = retire_reader_session(&sessions, &sid, gen, &alive);
        // Empty payload = clean exit; non-empty = error reason. See the
        // AgentBridge doc-comment for the full event contract.
        if announce {
            if !exit_reason.is_empty() {
                // Recorded before the emit so a `session_status` query that
                // races the event still finds it. Only for the incarnation
                // that still owned the id: a superseded reader must not
                // stamp its reason onto its replacement. `exit_reason`
                // is cloned (not moved) because the emit below still needs
                // the original — `sid` has no such later use, so it moves.
                if let Ok(mut e) = last_errors.lock() {
                    e.insert(sid, exit_reason.clone());
                }
            }
            let _ = app.emit(&exit_event, exit_reason);
        }
    });
    spawned.expect("failed to spawn thread");
}

/// Bounded ring of the child's most recent stderr lines.
///
/// omp writes startup diagnostics to stderr and, in `--mode rpc-ui`, exits
/// non-zero *before* emitting a single stdout frame when the profile it was
/// pointed at has no usable model (a freshly created profile with no
/// credentials is the common case). Without this the stdout reader hits EOF
/// with nothing to report, emits the empty payload the event contract
/// defines as a *clean* exit, and the tab sits blank with the real reason
/// visible only on the desktop's own stderr — see
/// [`StdoutReaderConfig::stderr_tail`].
pub(super) struct StderrTail {
    lines: VecDeque<String>,
    bytes: usize,
}

/// Keep the tail small: it exists to explain a startup failure, not to
/// mirror the child's log. A refusal banner is a handful of lines.
const STDERR_TAIL_LINES: usize = 24;
const STDERR_TAIL_BYTES: usize = 4096;

impl StderrTail {
    pub(super) fn new() -> Self {
        Self {
            lines: VecDeque::with_capacity(STDERR_TAIL_LINES),
            bytes: 0,
        }
    }

    fn push(&mut self, mut line: String) {
        // A line larger than the whole tail budget would otherwise evict
        // every other retained line *and* itself in the loop below,
        // leaving `to_reason` with nothing at all to report — the exact
        // blank-tab failure this type exists to prevent. Keep a prefix
        // instead. Cut on a char boundary: omp's banners are not pure ASCII.
        if line.len() > STDERR_TAIL_BYTES {
            let cut = crate::text::prefix_within(&line, STDERR_TAIL_BYTES).len();
            line.truncate(cut);
        }
        self.bytes += line.len();
        self.lines.push_back(line);
        while self.lines.len() > STDERR_TAIL_LINES || self.bytes > STDERR_TAIL_BYTES {
            // `pop_front` on a non-empty deque; the loop condition can only
            // hold while at least one line is present.
            if let Some(dropped) = self.lines.pop_front() {
                self.bytes -= dropped.len();
            } else {
                break;
            }
        }
    }

    /// The retained lines as one blank-line-collapsed message, or `None`
    /// when the child said nothing. omp's banners are double-spaced for a
    /// terminal; collapsing keeps the UI note compact.
    fn to_reason(&self) -> Option<String> {
        crate::text::join_nonblank(self.lines.iter().map(String::as_str), " ")
    }
}

pub(super) fn spawn_stderr_reader(sid: String, stderr: ChildStderr, tail: Arc<Mutex<StderrTail>>) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            eprintln!("[omp/{sid}] {line}");
            if let Ok(mut t) = tail.lock() {
                t.push(line);
            }
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
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if avail.is_empty() {
            return Ok((total, truncated));
        }
        let room = max.saturating_sub(out.len());
        let used = if let Some(i) = avail.iter().position(|&b| b == delim) {
            // Found the delimiter — frame the line and return.
            let take = (i + 1).min(room);
            if take < i + 1 {
                truncated = true;
            }
            out.extend_from_slice(&avail[..take]);
            let used = i + 1;
            r.consume(used);
            total += used;
            return Ok((total, truncated));
        } else {
            // No delimiter in the available chunk — keep reading.
            let take = avail.len().min(room);
            if take < avail.len() {
                truncated = true;
            }
            if take > 0 {
                out.extend_from_slice(&avail[..take]);
            }
            avail.len()
        };
        r.consume(used);
        total += used;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::tests::approval_prompt;
    use serde_json::json;

    /// One physical line, outside any chunk run, as the reader turns it into
    /// text: `frames::logical_frames` then [`sanitize_logical`].
    fn sanitize_line(raw: &[u8]) -> (String, Option<serde_json::Value>) {
        let mut out = Vec::new();
        frames::logical_frames(&mut ChunkAssembler::default(), raw, |logical| {
            out.push(sanitize_logical(logical));
        });
        assert_eq!(out.len(), 1, "a line outside a run is one logical frame");
        let (text, value) = out.pop().unwrap();
        (text.to_string(), value)
    }

    #[test]
    fn sanitize_redacts_nested_credential_keys() {
        let raw = json!({
            "type": "response",
            "data": {
                "model": {
                    "name": "gpt-5",
                    "headers": { "Authorization": "Bearer sk-secret", "Content-Type": "application/json" }
                }
            }
        })
        .to_string();
        let (out, parsed) = sanitize_line(raw.as_bytes());
        assert!(!out.contains("sk-secret"));
        assert!(out.contains(REDACTED_PLACEHOLDER));
        let parsed = parsed.expect("valid JSON parses");
        assert_eq!(
            parsed["data"]["model"]["headers"],
            json!(REDACTED_PLACEHOLDER)
        );
        // Non-sensitive sibling fields survive untouched.
        assert_eq!(parsed["data"]["model"]["name"], "gpt-5");
    }

    #[test]
    fn sanitize_matches_key_regardless_of_separator_style() {
        for key in ["api_key", "api-key", "apiKey", "API_KEY"] {
            let raw = json!({ key: "should-not-survive" }).to_string();
            let (out, _) = sanitize_line(raw.as_bytes());
            assert!(
                !out.contains("should-not-survive"),
                "key {key} leaked a secret"
            );
        }
    }

    #[test]
    fn sanitize_redacts_compound_provider_credential_key_names() {
        // Suffix-matching the normalized key against REDACTED_KEYS
        // catches these compound spellings where the old exact-equality
        // check let all of them through unredacted.
        for key in [
            "x-api-key",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "client_secret",
        ] {
            let raw = json!({ key: "should-not-survive" }).to_string();
            let (out, _) = sanitize_line(raw.as_bytes());
            assert!(
                !out.contains("should-not-survive"),
                "key {key} leaked a secret"
            );
        }
    }

    /// `sanitize_frame`'s return value gates the re-serialize fast path, so
    /// a frame with nothing to redact must report `false` — and one with a
    /// secret nested deep inside must still report `true`.
    #[test]
    fn sanitize_frame_reports_whether_it_redacted_anything() {
        let mut clean = json!({ "type": "turn_start", "usage": { "input_tokens": 3 } });
        assert!(!sanitize_frame(&mut clean));

        let mut nested = json!({ "a": [ { "b": { "api_key": "sekrit" } } ] });
        assert!(sanitize_frame(&mut nested));
        assert_eq!(nested["a"][0]["b"]["api_key"], REDACTED_PLACEHOLDER);
    }

    /// A frame with nothing to redact must come back byte-identical to the
    /// input, not re-serialized — that is what makes skipping the second
    /// serializer pass safe.
    #[test]
    fn sanitize_line_preserves_untouched_frame_verbatim() {
        // Key order and spacing here are deliberately *not* what serde_json
        // would re-emit, proving the fast path returns the original bytes.
        let raw = br#"{"z":1,  "a":  [1,2,3],"nested":{"k":"v"}}"#;
        let (out, parsed) = sanitize_line(raw);
        assert_eq!(out.as_bytes(), raw);
        assert!(parsed.is_some());
    }

    #[test]
    fn sanitize_leaves_usage_token_counts_unredacted() {
        // A broad `contains`/suffix rule on "token" would also catch these
        // legitimate usage-stats fields — this guards against ever
        // "simplifying" the suffix match back to that.
        let raw = json!({ "usage": { "input_tokens": 42, "output_tokens": 7 } }).to_string();
        let (out, parsed) = sanitize_line(raw.as_bytes());
        assert!(!out.contains(REDACTED_PLACEHOLDER));
        let parsed = parsed.expect("valid JSON parses");
        assert_eq!(parsed["usage"]["input_tokens"], 42);
        assert_eq!(parsed["usage"]["output_tokens"], 7);
    }

    #[test]
    fn sanitize_redacts_inside_arrays() {
        let raw = json!({ "items": [{ "password": "hunter2" }] }).to_string();
        let (out, _) = sanitize_line(raw.as_bytes());
        assert!(!out.contains("hunter2"));
    }

    #[test]
    fn sanitize_leaves_non_sensitive_frame_untouched() {
        let raw = json!({ "type": "turn_start", "toolName": "bash" }).to_string();
        let (out, parsed) = sanitize_line(raw.as_bytes());
        let reparsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(reparsed["type"], "turn_start");
        assert_eq!(reparsed["toolName"], "bash");
        assert_eq!(parsed.unwrap()["toolName"], "bash");
    }

    #[test]
    fn sanitize_replaces_invalid_json_with_the_diagnostic_only() {
        let (out, parsed) = sanitize_line(br#"{"apiKey":"sk-raw" not json"#);
        assert_eq!(
            out,
            r#"{"type":"desktop_frame_error","reason":"unparsable"}"#
        );
        assert!(parsed.is_none());
    }

    /// A line serde rejects only for a lone surrogate escape is repaired,
    /// then redacted like any frame.
    #[test]
    fn sanitize_redacts_a_repaired_line() {
        let (out, parsed) = sanitize_line(br#"{"t":"\ud800","apiKey":"sk-raw"}"#);
        assert!(!out.contains("sk-raw"), "{out}");
        let parsed = parsed.expect("repaired line parses");
        assert_eq!(parsed["t"], "\u{FFFD}");
        assert_eq!(parsed["apiKey"], REDACTED_PLACEHOLDER);
    }

    /// Drives the CR/LF-strip → sanitize pipeline (exactly as the stdout
    /// reader loop does) through `tests/fixtures/line-framing-cases.json`
    /// — one shared source of line-framing edge cases instead of re-arguing
    /// each one inline. Every case asserts at least one of: exact stripped
    /// text, JSON-parseability, substring presence/absence (redaction), or
    /// emptiness after stripping.
    #[test]
    fn line_framing_fixture_matches_expected_pipeline_behavior() {
        let fixture = include_str!("../../tests/fixtures/line-framing-cases.json");
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(fixture).expect("fixture must be valid JSON");
        assert!(!cases.is_empty(), "fixture must not be empty");

        for case in &cases {
            let name = case["name"].as_str().expect("case needs a 'name'");
            let raw = case["raw"]
                .as_str()
                .unwrap_or_else(|| panic!("case '{name}' missing 'raw'"));
            let mut buf = raw.as_bytes().to_vec();
            strip_trailing_crlf(&mut buf);

            if case
                .get("expect_empty_after_strip")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
            {
                assert!(
                    buf.is_empty(),
                    "case '{name}': expected empty after CR/LF strip"
                );
                continue;
            }

            let (text, parsed) = sanitize_line(&buf);
            if let Some(expected) = case.get("expect_text").and_then(serde_json::Value::as_str) {
                assert_eq!(text, expected, "case '{name}'");
            }
            if let Some(expect_json) = case.get("expect_json").and_then(serde_json::Value::as_bool)
            {
                assert_eq!(parsed.is_some(), expect_json, "case '{name}'");
            }
            if let Some(needle) = case
                .get("expect_contains")
                .and_then(serde_json::Value::as_str)
            {
                assert!(
                    text.contains(needle),
                    "case '{name}': expected text to contain {needle:?}"
                );
            }
            if let Some(needle) = case
                .get("expect_not_contains")
                .and_then(serde_json::Value::as_str)
            {
                assert!(
                    !text.contains(needle),
                    "case '{name}': text must not contain {needle:?}"
                );
            }
        }
    }

    #[test]
    fn try_auto_approve_answers_stdin_and_returns_synthetic_notice() {
        let dir = std::env::temp_dir().join(format!(
            "omp-desktop-reader-approval-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let rule_book = RuleBook::new(dir);
        rule_book
            .grant("sess-1", None, "bash", approval::RuleScope::Session)
            .unwrap();

        // A plain `Mutex<Vec<u8>>` stands in for the real `ChildStdin` now
        // that `try_auto_approve` is generic over `W: Write` — no child
        // process needed (a spawned `cat` doesn't exist on Windows), and
        // the bytes actually written are directly inspectable below.
        let stdin: Mutex<Vec<u8>> = Mutex::new(Vec::new());

        // The real emitted shape: `Allow tool: <name>` plus the tool's own
        // `formatApprovalDetails()` lines (see approval.rs' module doc). A
        // single-line title here would keep passing even if the first-line
        // parse regressed, so this fixture is the end-to-end guard for it.
        let frame = json!({
            "type": "extension_ui_request", "id": "req-9", "method": "select",
            "title": "Allow tool: bash\nCommand: ls -la\nCwd: /tmp",
            "options": ["Approve", "Deny"]
        });
        let notice = try_auto_approve(&frame, &rule_book, "sess-1", None, &stdin);
        assert!(notice.is_some());
        let notice: serde_json::Value = serde_json::from_str(&notice.unwrap()).unwrap();
        assert_eq!(notice["type"], "desktop_auto_approval");
        assert_eq!(notice["tool"], "bash");
        // What the rule approved reaches the human, not just the tool name.
        assert_eq!(notice["details"], "Command: ls -la\nCwd: /tmp");

        // The wire shape written to stdin must stay compatible with what
        // `src/live.js`'s `answerAsk` sends: a single `extension_ui_response`
        // line carrying the original request `id` and the chosen `value`.
        let line = std::str::from_utf8(&stdin.lock().unwrap())
            .unwrap()
            .to_owned();
        assert_eq!(line.matches('\n').count(), 1, "exactly one line written");
        let sent: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(
            sent,
            json!({ "type": "extension_ui_response", "id": "req-9", "value": "Approve" })
        );
    }

    #[test]
    fn try_auto_approve_falls_through_without_a_matching_rule() {
        let dir = std::env::temp_dir().join(format!(
            "omp-desktop-reader-approval-test-nogrant-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let rule_book = RuleBook::new(dir);
        let stdin: Mutex<Vec<u8>> = Mutex::new(Vec::new());

        let frame = json!({
            "type": "extension_ui_request", "id": "req-9", "method": "select",
            "title": "Allow tool: bash", "options": ["Approve", "Deny"]
        });
        assert!(try_auto_approve(&frame, &rule_book, "sess-1", None, &stdin).is_none());
        assert!(
            stdin.lock().unwrap().is_empty(),
            "no rule granted — nothing should be written to stdin"
        );
    }

    #[test]
    fn only_a_prompt_the_human_will_answer_is_recorded_for_a_grant() {
        let dir = crate::test_support::TempDir::new("reader", "approval-track");
        let rule_book = RuleBook::new(dir.path().to_path_buf());
        rule_book
            .grant("sess-1", None, "edit", approval::RuleScope::Session)
            .unwrap();
        let stdin: Mutex<Vec<u8>> = Mutex::new(Vec::new());
        let open = Mutex::new(PendingApprovals::new(None));
        let step = |frame: &serde_json::Value| {
            auto_approve_or_track(
                frame,
                Some("extension_ui_request"),
                &rule_book,
                "sess-1",
                None,
                &stdin,
                &open,
            )
        };

        assert!(
            step(&approval_prompt("req-1", "edit")).is_some(),
            "rule-covered"
        );
        assert!(
            step(&approval_prompt("req-2", "bash")).is_none(),
            "forwarded"
        );
        let open = open.lock().unwrap();
        assert_eq!(
            open.tool("req-1"),
            None,
            "answered by the rule, not grantable"
        );
        assert_eq!(open.tool("req-2"), Some("bash"));
    }

    #[test]
    fn read_until_capped_frames_a_normal_line() {
        let data = b"hello\nworld\n".to_vec();
        let mut r = std::io::Cursor::new(data);
        let mut out = Vec::new();
        let (n, truncated) = read_until_capped(&mut r, b'\n', &mut out, 1024).unwrap();
        assert_eq!(n, 6);
        assert!(!truncated);
        assert_eq!(out, b"hello\n");
    }

    #[test]
    fn read_until_capped_reports_truncation_past_the_cap() {
        let data = b"0123456789\n".to_vec();
        let mut r = std::io::Cursor::new(data);
        let mut out = Vec::new();
        let (n, truncated) = read_until_capped(&mut r, b'\n', &mut out, 4).unwrap();
        assert!(truncated);
        assert_eq!(out.len(), 4);
        assert_eq!(n, 11); // still consumed the whole line off the pipe
    }

    #[test]
    fn read_until_capped_eof_returns_zero() {
        let data: Vec<u8> = Vec::new();
        let mut r = std::io::Cursor::new(data);
        let mut out = Vec::new();
        let (n, truncated) = read_until_capped(&mut r, b'\n', &mut out, 1024).unwrap();
        assert_eq!(n, 0);
        assert!(!truncated);
    }

    #[test]
    fn stderr_tail_is_empty_when_the_child_said_nothing() {
        // Drives the branch that decides between "clean exit" and a reason:
        // no stderr must stay `None` so the empty-payload contract holds.
        assert_eq!(StderrTail::new().to_reason(), None);
    }

    #[test]
    fn stderr_tail_collapses_blank_lines_into_one_reason() {
        // omp double-spaces its refusal banner for a terminal; the UI note
        // is one line, and a reason of "a\n\n\nb" would render as a gap.
        let mut tail = StderrTail::new();
        for line in ["No models available.", "", "  Set an API key: ", ""] {
            tail.push(line.to_string());
        }
        assert_eq!(
            tail.to_reason(),
            Some("No models available. Set an API key:".to_string())
        );
    }

    #[test]
    fn stderr_tail_keeps_the_newest_lines_within_its_line_bound() {
        // A chatty child must not let the tail grow without bound, and the
        // *newest* lines are the ones that explain an exit.
        let mut tail = StderrTail::new();
        for n in 0..(STDERR_TAIL_LINES + 10) {
            tail.push(format!("line{n}"));
        }
        let reason = tail.to_reason().expect("lines were pushed");
        assert!(
            reason.starts_with("line10 "),
            "oldest lines must be evicted first, got: {reason}"
        );
        assert!(reason.ends_with(&format!("line{}", STDERR_TAIL_LINES + 9)));
        // No assertion on the private `tail.lines.len()` field here: the
        // `starts_with("line10 ")`/`ends_with("line33")` pair above already
        // uniquely pins "exactly the newest STDERR_TAIL_LINES entries
        // survived" (any other eviction count would shift both boundary
        // values) — a `lines.len()` check would only restate that fact
        // via a field no consumer of `StderrTail` ever reads.
    }

    #[test]
    fn stderr_tail_evicts_to_stay_within_its_byte_bound() {
        // One pathological line must not pin kilobytes per session: the byte
        // bound evicts even when the line count is well under its own cap.
        let mut tail = StderrTail::new();
        tail.push("x".repeat(STDERR_TAIL_BYTES - 1));
        tail.push("the real reason".to_string());
        assert_eq!(
            tail.to_reason(),
            Some("the real reason".to_string()),
            "the oversized line must have been dropped"
        );
        assert!(tail.bytes <= STDERR_TAIL_BYTES);
    }

    #[test]
    fn stderr_tail_truncates_an_oversized_line_instead_of_wiping_the_tail() {
        // Before the fix, a single line longer than STDERR_TAIL_BYTES made
        // the eviction condition true until the deque was *empty* —
        // evicting the line itself along with everything else, so
        // `to_reason()` returned `None`: the exact blank-tab failure this
        // type exists to prevent.
        let mut tail = StderrTail::new();
        tail.push("z".repeat(STDERR_TAIL_BYTES + 500));
        let reason = tail
            .to_reason()
            .expect("an oversized line must still produce a reason");
        // The retained bytes are the line's own content, not a placeholder:
        // a truncated reason still has to explain the exit.
        assert!(reason.starts_with("zzz"));
        assert!(reason.len() <= STDERR_TAIL_BYTES);
        assert!(tail.bytes <= STDERR_TAIL_BYTES);
    }

    #[test]
    fn stderr_tail_truncation_cuts_on_a_char_boundary() {
        // omp's banners are not pure ASCII; truncating mid-character would
        // panic (`String::truncate`'s documented panic condition). Build a
        // line whose STDERR_TAIL_BYTES-th byte lands inside a multi-byte
        // character and confirm `push` neither panics nor keeps a partial
        // character.
        let mut line = "a".repeat(STDERR_TAIL_BYTES - 1);
        line.push('€'); // 3-byte UTF-8 char straddling the cut point
        line.push_str("-dropped-tail");
        let mut tail = StderrTail::new();
        tail.push(line);
        let reason = tail
            .to_reason()
            .expect("truncated line still yields a reason");
        // Exact value: proves the cut landed one byte before the 3-byte
        // `€`, dropping the whole character (not a partial encoding of
        // it) along with everything after.
        assert_eq!(reason, "a".repeat(STDERR_TAIL_BYTES - 1));
    }

    #[test]
    fn stderr_tail_oversized_line_evicts_older_lines_but_not_itself() {
        // The truncated line's length fills the whole byte budget, so
        // older retained lines are evicted to make room for it — the same
        // "newest wins" priority `stderr_tail_evicts_to_stay_within_its_byte_bound`
        // already pins. What must not happen (the bug) is the truncated
        // line evicting itself too, leaving nothing.
        let mut tail = StderrTail::new();
        tail.push("first, superseded by the newer report".to_string());
        tail.push("z".repeat(STDERR_TAIL_BYTES + 10));
        let reason = tail.to_reason().expect("the oversized line must survive");
        assert!(!reason.contains("superseded"));
        assert!(reason.starts_with('z'));
    }

    #[test]
    fn tracker_hook_records_background_frames_but_not_auto_approvals_or_retired_readers() {
        let sid = "tracker-reader-background";
        let tracker = crate::remote::tracker::tracker();
        let alive = AtomicBool::new(true);
        record_tracker_frame(sid, Some("agent_start"), None, false, &alive);
        record_tracker_frame(
            sid,
            Some("extension_ui_request"),
            Some(&approval_prompt("q1", "bash")),
            false,
            &alive,
        );
        record_tracker_frame(
            sid,
            Some("extension_ui_request"),
            Some(&approval_prompt("automatic", "edit")),
            true,
            &alive,
        );
        let snapshot = tracker.snapshot();
        assert_eq!(
            (snapshot.sessions[sid].busy, snapshot.sessions[sid].asks),
            (true, 1)
        );
        alive.store(false, Ordering::Release);
        record_tracker_frame(sid, Some("agent_end"), None, false, &alive);
        let snapshot = tracker.snapshot();
        assert_eq!(
            (snapshot.sessions[sid].busy, snapshot.sessions[sid].asks),
            (true, 1),
            "retired reader must not finish a replacement turn"
        );
        tracker.on_exit(sid);
    }

    /// What the reader is fed, in order.
    #[derive(Clone, Copy)]
    enum Step<'a> {
        Line(&'a [u8]),
        /// A line over [`MAX_LINE_BYTES`].
        Dropped,
    }

    /// The reader pipeline with no omp and no webview: emits are collected,
    /// stdin is a buffer.
    struct Harness {
        journal: Mutex<EventJournal>,
        ext_ui: Mutex<ExtUiState>,
        inflight: Mutex<InFlight>,
        approvals: Mutex<PendingApprovals>,
        stdin: Mutex<Vec<u8>>,
        rule_book: RuleBook,
        alive: AtomicBool,
        _dir: crate::test_support::TempDir,
    }

    /// `(seq, text, frame type)` of each emit.
    type Emitted = Vec<(u64, String, Option<String>)>;

    impl Harness {
        fn new(name: &str) -> Self {
            let dir = crate::test_support::TempDir::new("reader", name);
            Self {
                journal: Mutex::new(EventJournal::new(64, 64 * 1024 * 1024)),
                ext_ui: Mutex::default(),
                inflight: Mutex::default(),
                approvals: Mutex::new(PendingApprovals::new(None)),
                stdin: Mutex::new(Vec::new()),
                rule_book: RuleBook::new(dir.path().to_path_buf()),
                alive: AtomicBool::new(true),
                _dir: dir,
            }
        }

        /// Feed `steps` then the end of output; the emits and `saw_frame`.
        fn run(&self, sid: &str, steps: &[Step<'_>]) -> (Emitted, bool) {
            let mut emitted = Vec::new();
            let mut pipeline = Pipeline {
                sid,
                journal: &self.journal,
                ext_ui: &self.ext_ui,
                inflight: &self.inflight,
                approvals: &self.approvals,
                stdin: &self.stdin,
                rule_book: &self.rule_book,
                project_root: None,
                alive: &self.alive,
                emit: |seq, text: &str, frame_type: Option<&str>| {
                    emitted.push((seq, text.to_owned(), frame_type.map(str::to_owned)));
                },
                assembler: ChunkAssembler::default(),
                saw_frame: false,
            };
            for step in steps {
                match step {
                    Step::Line(line) => pipeline.line(line),
                    Step::Dropped => pipeline.dropped_line(),
                }
            }
            pipeline.end();
            let saw_frame = pipeline.saw_frame;
            drop(pipeline);
            (emitted, saw_frame)
        }

        fn journaled(&self) -> Vec<(u64, String)> {
            let replay = self.journal.lock().unwrap().since(0);
            replay
                .events
                .into_iter()
                .map(|e| (e.seq, e.text.to_string()))
                .collect()
        }
    }

    fn lines(chunks: &[String]) -> Vec<Step<'_>> {
        chunks.iter().map(|l| Step::Line(l.as_bytes())).collect()
    }

    const UNPARSABLE: &str = r#"{"type":"desktop_frame_error","reason":"unparsable"}"#;
    const INTERRUPTED: &str = r#"{"type":"desktop_frame_error","reason":"chunk_interrupted"}"#;

    /// #94: a frame omp chunks reaches the journal and the webview once,
    /// redacted — never as `rpc_chunk` envelopes whose base64 hides the key.
    #[test]
    fn a_chunked_frame_is_journaled_and_emitted_once_redacted() {
        let secret = "sk-live-SECRET-0123456789";
        let frame = frames::tests::big_frame(json!({
            "type": "response", "command": "get_state",
            "data": { "provider": { "apiKey": secret } },
        }));
        let chunks = frames::tests::chunk_lines(&frame, "run-1");
        assert!(chunks.len() > 1);
        let harness = Harness::new("chunk-redact");
        let (emitted, saw_frame) = harness.run("chunk-redact", &lines(&chunks));

        let journaled = harness.journaled();
        assert_eq!(journaled.len(), 1, "one logical frame, one seq");
        let (seq, text) = &journaled[0];
        assert!(!text.contains(secret));
        assert!(text.contains(REDACTED_PLACEHOLDER));
        let value: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(value["type"], "response");
        assert_eq!(
            emitted,
            vec![(*seq, text.clone(), Some("response".to_owned()))]
        );
        assert!(saw_frame);
        // Nothing of an envelope or its base64 survives anywhere.
        for chunk in &chunks {
            let data = serde_json::from_str::<serde_json::Value>(chunk).unwrap()["data"]
                .as_str()
                .unwrap()[..64]
                .to_owned();
            assert!(!text.contains(&data));
        }
        assert!(!text.contains("rpc_chunk"));
    }

    /// Rust consumers see the reassembled frame: the tracker opens the
    /// question, `approvals` records the prompt for a grant.
    #[test]
    fn a_chunked_select_prompt_reaches_the_tracker_and_approvals() {
        let sid = "reader-chunked-prompt";
        let frame = frames::tests::big_frame(approval_prompt("req-big", "bash"));
        let harness = Harness::new("chunk-prompt");
        let (emitted, _) = harness.run(sid, &lines(&frames::tests::chunk_lines(&frame, "p")));
        let tracked = crate::remote::tracker::tracker()
            .snapshot()
            .sessions
            .get(sid)
            .map(|s| (s.busy, s.asks));
        crate::remote::tracker::tracker().on_exit(sid);
        assert_eq!(tracked, Some((false, 1)));
        assert_eq!(
            harness.approvals.lock().unwrap().tool("req-big"),
            Some("bash")
        );
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].2.as_deref(), Some("extension_ui_request"));
    }

    /// A chunked prompt a rule covers is answered and replaced, as a line is.
    #[test]
    fn a_chunked_prompt_a_rule_covers_is_auto_approved() {
        let frame = frames::tests::big_frame(approval_prompt("req-auto", "bash"));
        let harness = Harness::new("chunk-auto");
        harness
            .rule_book
            .grant("chunk-auto", None, "bash", approval::RuleScope::Session)
            .unwrap();
        let (emitted, _) = harness.run(
            "chunk-auto",
            &lines(&frames::tests::chunk_lines(&frame, "a")),
        );
        let written = String::from_utf8(harness.stdin.lock().unwrap().clone()).unwrap();
        assert!(written.contains("req-auto"), "{written}");
        assert_eq!(emitted.len(), 1);
        assert!(emitted[0].1.contains("desktop_auto_approval"));
        assert_eq!(harness.approvals.lock().unwrap().tool("req-auto"), None);
    }

    /// An unparsable line becomes the fixed diagnostic and nothing else; it
    /// is no frame for the startup-death check.
    #[test]
    fn an_unparsable_line_is_only_the_diagnostic_and_no_frame() {
        let harness = Harness::new("unparsable");
        let (emitted, saw_frame) =
            harness.run("unparsable", &[Step::Line(b"{\"apiKey\":\"sk-raw\"")]);
        assert_eq!(harness.journaled(), vec![(1, UNPARSABLE.to_owned())]);
        // No frame type: a diagnostic reaches no consumer but the webview.
        assert_eq!(emitted, vec![(1, UNPARSABLE.to_owned(), None)]);
        assert!(!saw_frame);

        let harness = Harness::new("parsable");
        let (_, saw_frame) = harness.run("parsable", &[Step::Line(br#"{"type":"ready"}"#)]);
        assert!(saw_frame, "a parsed frame still counts");
    }

    /// A run cut short reports one diagnostic; the interrupting line is still
    /// processed. A dropped line or the end of output interrupts too; with no
    /// run open, neither reports anything.
    #[test]
    fn an_interrupted_run_reports_once_and_the_interrupting_line_still_counts() {
        let frame = frames::tests::big_frame(json!({ "type": "response" }));
        let chunks = frames::tests::chunk_lines(&frame, "cut");
        let texts = |steps: &[Step<'_>]| {
            let harness = Harness::new("interrupt");
            harness.run("interrupt", steps);
            harness
                .journaled()
                .into_iter()
                .map(|(_, t)| t)
                .collect::<Vec<_>>()
        };
        let end = br#"{"type":"agent_end"}"#;
        let open = [
            Step::Line(chunks[0].as_bytes()),
            Step::Line(chunks[1].as_bytes()),
        ];
        let cut = |next: Step<'static>| texts(&[open[0], open[1], next]);

        assert_eq!(
            cut(Step::Line(end)),
            vec![INTERRUPTED, std::str::from_utf8(end).unwrap()]
        );
        assert_eq!(cut(Step::Dropped), vec![INTERRUPTED]);
        assert_eq!(texts(&open), vec![INTERRUPTED], "end of output");
        assert_eq!(texts(&[Step::Dropped]), Vec::<String>::new());
        assert_eq!(texts(&[]), Vec::<String>::new());
    }

    /// A retired incarnation still journals but emits nothing.
    #[test]
    fn a_retired_reader_journals_but_does_not_emit() {
        let harness = Harness::new("retired");
        harness.alive.store(false, Ordering::Release);
        let (emitted, _) = harness.run("retired", &[Step::Line(br#"{"type":"ready"}"#)]);
        assert_eq!(emitted, Emitted::new());
        assert_eq!(harness.journaled().len(), 1);
    }

    /// A frame nested `depth` levels deep, by `[` or by `{"a":`, with a
    /// credential key in the deepest object.
    fn deep_frame(depth: usize, objects: bool) -> String {
        // The outer object and the innermost one are two of the levels.
        let inner = depth - 2;
        let (open, close) = if objects {
            (r#"{"a":"#, "}")
        } else {
            ("[", "]")
        };
        format!(
            r#"{{"type":"deep","v":{}{{"apiKey":"sk-deep-secret"}}{}}}"#,
            open.repeat(inner),
            close.repeat(inner)
        )
    }

    /// `frame` through the whole pipeline on a thread of the reader's stack
    /// size: the journaled texts and `saw_frame`.
    fn on_reader_stack(frame: String) -> (Vec<String>, bool) {
        reader_thread()
            .spawn(move || {
                let harness = Harness::new("deep");
                let (_, saw_frame) = harness.run("deep", &[Step::Line(frame.as_bytes())]);
                let texts = harness.journaled().into_iter().map(|(_, t)| t).collect();
                (texts, saw_frame)
            })
            .unwrap()
            .join()
            .unwrap()
    }

    /// D94-7: the worst case the reader takes, `MAX_FRAME_DEPTH` levels by
    /// arrays and by objects, goes through the whole pipeline (parse,
    /// redaction, re-serialization, every consumer, the `Value` drop) on a
    /// thread of the reader's stack size, its deepest credential redacted.
    /// One level more is the diagnostic.
    #[test]
    fn a_frame_at_the_depth_ceiling_runs_on_the_reader_stack() {
        for objects in [false, true] {
            let (texts, saw_frame) = on_reader_stack(deep_frame(frames::MAX_FRAME_DEPTH, objects));
            assert!(saw_frame, "objects: {objects}");
            assert_eq!(texts.len(), 1);
            let text = &texts[0];
            assert!(text.starts_with(r#"{"type":"deep""#), "objects: {objects}");
            assert!(!text.contains("sk-deep-secret"), "objects: {objects}");
            assert!(
                text.contains(&format!(r#"{{"apiKey":"{REDACTED_PLACEHOLDER}"}}"#)),
                "objects: {objects}"
            );

            let too_deep = deep_frame(frames::MAX_FRAME_DEPTH + 1, objects);
            assert_eq!(
                on_reader_stack(too_deep),
                (vec![UNPARSABLE.to_owned()], false),
                "objects: {objects}"
            );
        }
    }

    /// D94-7: a `JSON.parse`-valid frame nested past serde's default limit
    /// (a model's tool-call arguments, echoed in `message_end`) is a frame,
    /// not the `unparsable` diagnostic.
    #[test]
    fn a_deep_message_end_is_still_a_frame() {
        let depth = 200;
        let line = format!(
            r#"{{"type":"message_end","message":{{"role":"assistant","content":[{{"type":"toolCall","arguments":{{"x":{}1{}}}}}]}}}}"#,
            "[".repeat(depth),
            "]".repeat(depth)
        );
        let (text, parsed) = sanitize_line(line.as_bytes());
        assert!(parsed.is_some(), "dropped as: {text}");
        assert_eq!(text, line);
    }

    /// R2-M1/R3-m1: the deepest tool call the reader takes (`toolcall_end` at
    /// `MAX_FRAME_DEPTH`, by arrays and by objects) lands in the in-flight
    /// state on the reader's stack. `AgentBridge::streaming_message`, called
    /// from a 1 MiB thread (the `WebView2` main thread's stack, where the
    /// `streaming_message` command's future is polled), serializes it on
    /// `off_ipc`'s worker instead, so the call completes.
    #[test]
    fn a_ceiling_deep_tool_call_snapshot_serializes_off_ipc() {
        for objects in [false, true] {
            // Frame, assistantMessageEvent and toolCall are three levels.
            let levels = frames::MAX_FRAME_DEPTH - 3;
            let args = if objects {
                format!("{}1{}", r#"{"a":"#.repeat(levels), "}".repeat(levels))
            } else {
                format!("{}1{}", "[".repeat(levels), "]".repeat(levels))
            };
            let start = r#"{"type":"message_start","messageId":"m","message":{"role":"assistant","content":[]}}"#;
            let update = format!(
                r#"{{"type":"message_update","messageId":"m","assistantMessageEvent":{{"type":"toolcall_end","contentIndex":0,"toolCall":{{"type":"toolCall","id":"t","name":"x","arguments":{args}}}}}}}"#
            );
            let inflight = reader_thread()
                .spawn(move || {
                    let mut harness = Harness::new("deep-inflight");
                    harness.run(
                        "deep-inflight",
                        &[Step::Line(start.as_bytes()), Step::Line(update.as_bytes())],
                    );
                    Arc::new(std::mem::take(&mut harness.inflight))
                })
                .unwrap()
                .join()
                .unwrap();

            let bridge = crate::agent::AgentBridge::new();
            bridge.sessions.lock().unwrap().insert(
                "deep".into(),
                BridgeInner {
                    inflight: Arc::clone(&inflight),
                    ..crate::agent::tests::idle_inner(Arc::new(AtomicBool::new(true)))
                },
            );
            let text = thread::scope(|scope| {
                thread::Builder::new()
                    .stack_size(1024 * 1024)
                    .spawn_scoped(scope, || {
                        tauri::async_runtime::block_on(bridge.streaming_message("deep"))
                    })
                    .unwrap()
                    .join()
                    .unwrap()
            })
            .unwrap();
            assert_eq!(
                text,
                format!(
                    r#"{{"messageId":"m","seq":2,"message":{{"content":[{{"arguments":{args},"id":"t","name":"x","type":"toolCall"}}],"role":"assistant"}}}}"#
                ),
                "objects: {objects}"
            );
            // The deep `Value` is freed where it was built.
            reader_thread()
                .spawn(move || {
                    drop(bridge);
                    drop(inflight);
                })
                .unwrap()
                .join()
                .unwrap();
        }
    }
}
