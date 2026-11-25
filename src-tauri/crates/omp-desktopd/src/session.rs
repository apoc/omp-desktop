//! Hosts the Ompy `omp` process: spawns it, reads its RPC stdout, answers
//! approvals a persona rule covers, and reports what the core needs.
//!
//! The reader thread is the only place a frame is interpreted, and the
//! auto-approval response is written before any event for that frame is
//! emitted. Whether an approval is answered by a rule therefore never depends
//! on how the core happens to interleave its own inbox handling.

use crate::budget::Usage;
use omp_desktop_core::approval::{approval_request_id, approval_tool_name, RuleBook};
use omp_desktop_core::child_path::{child_path_dirs, locate_program};
use omp_desktop_core::persona_protocol::{
    read_line_capped_with, AskQuestionRef, ItemKind, LineRead, MAX_LINE_BYTES,
};
use serde_json::Value;
use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{RecvTimeoutError, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Frames kept for a client that reconnects and asks to replay.
pub const REPLAY_MAX: usize = 5000;

/// Total bytes of frames kept for a client that reconnects and asks to replay.
pub const REPLAY_MAX_BYTES: usize = 8 * 1024 * 1024;

/// The session id the persona's rules are granted and looked up under.
pub const RULE_SESSION: &str = "ompy";

/// Where the session's `omp` executable comes from.
#[derive(Debug, Clone)]
pub enum ProgramSource {
    /// Resolve `name` on the child PATH before every spawn, so an `omp`
    /// installed while the service runs is found by the next restart.
    Locate(String),
    /// A fixed executable (tests and embedders).
    Fixed(PathBuf),
}

impl ProgramSource {
    /// The executable to spawn for the next session.
    ///
    /// # Errors
    ///
    /// Returns the lookup error when a [`ProgramSource::Locate`] name is not
    /// on the PATH; the core treats it like any other spawn failure.
    fn resolve(&self) -> io::Result<PathBuf> {
        match self {
            Self::Locate(name) => locate_program(&child_path_dirs(), name)
                .map(|program| program.binary)
                .map_err(|error| io::Error::new(io::ErrorKind::NotFound, error)),
            Self::Fixed(path) => Ok(path.clone()),
        }
    }
}

/// What to spawn and where it runs.
#[derive(Debug, Clone)]
pub struct Launch {
    /// The `omp` executable, or the name to resolve before each spawn.
    pub program: ProgramSource,
    /// The persona's home directory; also the child's working directory.
    pub home: PathBuf,
    /// Where omp keeps its session transcripts.
    pub sessions: PathBuf,
    /// The extension that gives omp the persona's tools.
    pub extension: PathBuf,
    /// The appended system prompt file.
    pub instructions: PathBuf,
    /// Socket path for omp to reach the service, as `OMPY_SOCKET`.
    pub socket_env: String,
    /// Extra environment for the child (tests pass their log path here).
    pub env: Vec<(String, String)>,
}

/// Something the session did that the core must see.
#[derive(Debug)]
pub enum SessionEvent {
    /// One stdout line, stored under `seq` in the replay ring.
    Frame {
        /// Monotonic frame number, starting at 1.
        seq: u64,
        /// The frame as received, without its line ending.
        raw: Arc<str>,
    },
    /// Tokens an assistant message billed.
    Usage(Usage),
    /// An agent turn began.
    TurnStarted,
    /// An agent turn handed control back.
    TurnEnded,
    /// omp asks the human something; the core turns this into a pending item.
    UiRequest {
        /// omp's request id, used to answer it.
        id: String,
        /// Approval or plain decision.
        kind: ItemKind,
        /// First line of omp's title.
        title: String,
        /// The remaining title lines, or omp's `message`.
        body: Option<String>,
        /// Answers the human may pick from.
        options: Vec<String>,
        /// omp's method, needed to construct the matching response shape.
        method: String,
        /// Original questions for an `ask` request.
        ask_questions: Option<Vec<AskQuestionRef>>,
        /// Whether an `input` request's answer is secret.
        secret: bool,
    },
    /// omp withdrew a request before it was answered.
    UiCancel {
        /// The request id that no longer needs an answer.
        id: String,
    },
    /// A persona rule covered an approval, so it was answered here.
    AutoApproved {
        /// The approved tool name.
        tool: String,
    },
    /// Writing to omp's stdin failed or timed out.
    StdinFailed {
        /// Why the session is unhealthy.
        reason: String,
    },
    /// omp's stdout ended, so the process is gone.
    Exited {
        /// Why the session stopped.
        reason: String,
    },
}

/// The command line for the persona's omp process.
#[must_use]
pub fn omp_args(l: &Launch) -> Vec<String> {
    vec![
        "--mode".into(),
        "rpc-ui".into(),
        "--approval-mode=always-ask".into(),
        format!("--cwd={}", l.home.display()),
        format!("--session-dir={}", l.sessions.display()),
        "--continue".into(),
        "-e".into(),
        l.extension.display().to_string(),
        format!("--append-system-prompt={}", l.instructions.display()),
    ]
}

/// Frame counter plus replay ring, shared by the reader thread and [`Session`].
type Replay = Arc<Mutex<ReplayRing>>;

/// Ring of the most recent frames, bounded by **both** an entry count and a
/// total byte budget.
///
/// Frames are whole omp lines up to [`MAX_LINE_BYTES`] each, so a count-only
/// bound would let one session pin `REPLAY_MAX × 16 MiB` indefinitely. The
/// byte budget evicts oldest-first until both bounds hold; the newest frame is
/// kept even when it alone exceeds the budget, because dropping the line just
/// stored would report a `seq` that could never be replayed.
struct ReplayRing {
    capacity: usize,
    max_bytes: usize,
    bytes: usize,
    entries: VecDeque<(u64, Arc<str>)>,
}

impl ReplayRing {
    fn new(capacity: usize, max_bytes: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            max_bytes: max_bytes.max(1),
            bytes: 0,
            entries: VecDeque::new(),
        }
    }

    /// Stores `frame` under its core-owned `seq`.
    fn push(&mut self, seq: u64, frame: Arc<str>) {
        self.bytes += frame.len();
        self.entries.push_back((seq, frame));
        while self.entries.len() > self.capacity
            || (self.bytes > self.max_bytes && self.entries.len() > 1)
        {
            if let Some((_, evicted)) = self.entries.pop_front() {
                self.bytes -= evicted.len();
            }
        }
    }

    /// The frames stored after `seq`, oldest first.
    fn after(&self, seq: u64) -> Vec<(u64, Arc<str>)> {
        let start = self.entries.partition_point(|(stored, _)| *stored <= seq);
        self.entries.iter().skip(start).cloned().collect()
    }
}

/// A running omp process.
struct WriteRequest {
    line: String,
    done: SyncSender<io::Result<()>>,
}

/// omp stdin owned by a writer thread. Callers wait only for the bounded queue
/// and the write-acknowledgement timeout, never for the writer thread itself.
#[derive(Clone)]
struct StdinWriter {
    tx: SyncSender<WriteRequest>,
    timeout: Duration,
    events: Sender<SessionEvent>,
}

impl StdinWriter {
    fn new<W: Write + Send + 'static>(
        mut writer: W,
        capacity: usize,
        timeout: Duration,
        events: Sender<SessionEvent>,
    ) -> io::Result<Self> {
        let (tx, rx) = std::sync::mpsc::sync_channel::<WriteRequest>(capacity);
        std::thread::Builder::new()
            .name("ompy-stdin".into())
            .spawn(move || {
                while let Ok(request) = rx.recv() {
                    let result = writeln!(writer, "{}", request.line).and_then(|()| writer.flush());
                    let failed = result.is_err();
                    let _ = request.done.send(result);
                    if failed {
                        break;
                    }
                }
            })?;
        Ok(Self {
            tx,
            timeout,
            events,
        })
    }

    fn send(&self, frame_json: &str) -> io::Result<()> {
        let line = frame_json.replace(['\r', '\n'], "");
        let (done, ack) = std::sync::mpsc::sync_channel(0);
        if let Err(error) = self.tx.try_send(WriteRequest { line, done }) {
            let error = match error {
                TrySendError::Full(_) => {
                    io::Error::new(io::ErrorKind::WouldBlock, "omp stdin queue is full")
                }
                TrySendError::Disconnected(_) => {
                    io::Error::new(io::ErrorKind::BrokenPipe, "omp stdin writer stopped")
                }
            };
            self.failed(&error);
            return Err(error);
        }
        let result = match ack.recv_timeout(self.timeout) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "omp stdin write timed out",
            )),
            Err(RecvTimeoutError::Disconnected) => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "omp stdin writer stopped",
            )),
        };
        if let Err(error) = &result {
            self.failed(error);
        }
        result
    }

    fn failed(&self, error: &io::Error) {
        let _ = self.events.send(SessionEvent::StdinFailed {
            reason: format!("omp stdin failed: {error}"),
        });
    }
}

/// A running omp process.
pub struct Session {
    child: Child,
    stdin: StdinWriter,
    replay: Replay,
}

/// Whether an `agent_end` hands control back: `yielded`, else `isTerminal`,
/// else yes. Mirrors `src-tauri/src/remote/tracker.rs`.
fn yields(frame: &Value) -> bool {
    let flag = |key: &str| frame.get(key).and_then(Value::as_bool);
    flag("yielded")
        .or_else(|| flag("isTerminal"))
        .unwrap_or(true)
}

/// The event a frame carries beyond [`SessionEvent::Frame`], if any.
fn classify(frame: &Value) -> Option<SessionEvent> {
    match frame.get("type")?.as_str()? {
        "agent_start" => Some(SessionEvent::TurnStarted),
        "agent_end" => yields(frame).then_some(SessionEvent::TurnEnded),
        "extension_ui_request" => {
            let text = |key: &str| frame.get(key).and_then(Value::as_str).map(str::to_owned);
            let method = text("method")?;
            if method == "cancel" {
                return Some(SessionEvent::UiCancel {
                    id: text("targetId")?,
                });
            }
            if !matches!(
                method.as_str(),
                "select" | "confirm" | "input" | "editor" | "ask"
            ) {
                return None;
            }
            let id = text("id")?;
            let (title, body, options, ask_questions) = if method == "ask" {
                let raw_questions = frame.get("questions")?.as_array()?;
                if raw_questions.is_empty() {
                    return None;
                }
                let mut questions = Vec::with_capacity(raw_questions.len());
                let mut first_question = None;
                let mut body = String::new();
                for raw in raw_questions {
                    let question_id = raw.get("id")?.as_str()?;
                    let question = raw.get("question")?.as_str()?;
                    let raw_options = raw.get("options")?.as_array()?;
                    let mut options = Vec::with_capacity(raw_options.len());
                    for option in raw_options {
                        options.push(option.get("label")?.as_str()?.to_owned());
                    }
                    if first_question.is_none() {
                        first_question = Some(question.to_owned());
                    } else {
                        body.push('\n');
                    }
                    body.push_str(question);
                    for label in &options {
                        body.push_str("\n- ");
                        body.push_str(label);
                    }
                    questions.push(AskQuestionRef {
                        id: question_id.to_owned(),
                        multi: raw.get("multi").and_then(Value::as_bool).unwrap_or(false),
                        options,
                    });
                }
                let options = if questions.len() == 1 && !questions[0].multi {
                    // The UI needs its own labels; the originals stay in the
                    // question reference for the structured omp response.
                    questions[0].options.clone()
                } else {
                    Vec::new()
                };
                let title = if questions.len() == 1 {
                    first_question.unwrap_or_else(|| "Ompy has a question".into())
                } else {
                    format!("Ompy has {} questions", questions.len())
                };
                (title, Some(body), options, Some(questions))
            } else {
                let raw_title = text("title").unwrap_or_else(|| "Ompy has a question".into());
                let (title, body) = match raw_title.split_once('\n') {
                    Some((head, rest)) => (head.to_owned(), Some(rest.to_owned())),
                    None => (raw_title, text("message")),
                };
                let options: Vec<String> = match method.as_str() {
                    "select" => frame
                        .get("options")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect(),
                    "confirm" => vec!["Confirm".into(), "Deny".into()],
                    _ => Vec::new(),
                };
                (title, body, options, None)
            };
            let kind = if approval_tool_name(frame).is_some() {
                ItemKind::Approval
            } else {
                ItemKind::Decision
            };
            Some(SessionEvent::UiRequest {
                id,
                kind,
                title,
                body,
                options,
                secret: method == "input" && frame["secret"].as_bool() == Some(true),
                method,
                ask_questions,
            })
        }
        _ => None,
    }
}

/// The `extension_ui_response` written when a rule covers an approval.
///
/// A struct (not a `json!` map) so the serialised byte order is stable and
/// logs and tests see the same line.
#[derive(serde::Serialize)]
struct UiAnswer<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    id: &'a str,
    value: &'static str,
}

/// Reads frames until the stream ends, handing each parsed one to `handle`.
///
/// A line longer than `cap` bytes is drained to its newline and skipped, and
/// only end of stream or an I/O error ends the loop: omp may print one huge
/// line and keep living, so a too-long line must never look like an exit.
fn pump<R: BufRead>(
    reader: &mut R,
    cap: usize,
    mut handle: impl FnMut(&Value, Arc<str>),
) -> io::Result<()> {
    let mut buf = Vec::new();
    loop {
        match read_line_capped_with(reader, &mut buf, cap)? {
            LineRead::Eof => return Ok(()),
            LineRead::TooLong => continue,
            LineRead::Line => {}
        }
        let Ok(frame) = serde_json::from_slice::<Value>(&buf) else {
            continue;
        };
        let Ok(text) = std::str::from_utf8(&buf) else {
            continue;
        };
        let raw: Arc<str> = Arc::from(text.trim_end_matches('\r'));
        handle(&frame, raw);
    }
}

impl Session {
    /// Spawns omp and starts the thread that reads its stdout.
    ///
    /// # Errors
    ///
    /// Returns the spawn or thread-start error when omp cannot be started or
    /// the reader thread cannot be created.
    ///
    /// # Panics
    ///
    /// Panics when the child was spawned without the piped stdin/stdout this
    /// function itself requests.
    // `clippy::disallowed_methods`: the service spawns no Chromium, so the
    // app's `spawn_gate` — which only exists for Chromium's CDP pipe ends — is
    // not available here (spec: Shared code).
    #[allow(clippy::disallowed_methods)]
    pub fn spawn(
        l: &Launch,
        rules: Arc<RuleBook>,
        next_seq: Arc<AtomicU64>,
        events: Sender<SessionEvent>,
    ) -> io::Result<Self> {
        let program = l.program.resolve()?;
        let mut cmd = Command::new(program);
        cmd.args(omp_args(l))
            .current_dir(&l.home)
            .env("OMPY_SOCKET", &l.socket_env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        for (key, value) in &l.env {
            cmd.env(key, value);
        }
        omp_desktop_core::child_path::apply_trusted_child_path(&mut cmd);
        // omp is a console-subsystem binary; the service may itself be started
        // by the logon task with no console of its own, and a child without
        // this flag would flash a window on the user's desktop.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn()?;
        let stdin = match StdinWriter::new(
            child.stdin.take().expect("piped stdin"),
            32,
            Duration::from_secs(5),
            events.clone(),
        ) {
            Ok(stdin) => stdin,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let stdout = child.stdout.take().expect("piped stdout");
        let replay: Replay = Arc::new(Mutex::new(ReplayRing::new(REPLAY_MAX, REPLAY_MAX_BYTES)));
        let (read_stdin, read_replay, home) = (stdin.clone(), Arc::clone(&replay), l.home.clone());
        let reader = std::thread::Builder::new()
            .name("ompy-stdout".into())
            .spawn(move || {
                let mut reader = BufReader::with_capacity(64 * 1024, stdout);
                let reason = match pump(&mut reader, MAX_LINE_BYTES, |frame, raw| {
                    if let Some(tool) = approval_tool_name(frame) {
                        if rules.is_granted(RULE_SESSION, Some(&home), tool) {
                            if let Some(id) = approval_request_id(frame) {
                                let Ok(answer) = serde_json::to_string(&UiAnswer {
                                    kind: "extension_ui_response",
                                    id,
                                    value: "Approve",
                                }) else {
                                    return;
                                };
                                let written = read_stdin.send(&answer).is_ok();
                                if written {
                                    let _ = events.send(SessionEvent::AutoApproved {
                                        tool: tool.to_owned(),
                                    });
                                    return;
                                }
                                // The failed write already emitted
                                // `StdinFailed`, which retires this session in
                                // the core. Continuing would emit a request
                                // from a process that is about to be killed,
                                // and no live session could ever answer it.
                                return;
                            }
                        }
                    }
                    let seq = next_seq.fetch_add(1, Ordering::Relaxed) + 1;
                    read_replay.lock().unwrap().push(seq, Arc::clone(&raw));
                    if let Some(usage) = Usage::from_message_end(frame) {
                        let _ = events.send(SessionEvent::Usage(usage));
                    }
                    if let Some(event) = classify(frame) {
                        let _ = events.send(event);
                    }
                    let _ = events.send(SessionEvent::Frame { seq, raw });
                }) {
                    Ok(()) => "omp exited".to_owned(),
                    Err(e) => format!("omp stdout failed: {e}"),
                };
                let _ = events.send(SessionEvent::Exited { reason });
            });
        if let Err(e) = reader {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
        Ok(Self {
            child,
            stdin,
            replay,
        })
    }

    /// Writes one frame to omp's stdin through the bounded writer queue.
    /// Line endings in `frame_json` are stripped, so one call is one line.
    /// Success means the writer flushed the complete line to the live process.
    ///
    /// # Errors
    ///
    /// Returns an error when the queue is full, the writer failed, or the write
    /// did not finish before the health timeout.
    pub fn send(&self, frame_json: &str) -> io::Result<()> {
        self.stdin.send(frame_json)
    }

    /// The frames stored after `seq`, oldest first.
    ///
    /// # Panics
    ///
    /// Panics when the replay lock is poisoned.
    #[must_use]
    pub fn replay_after(&self, seq: u64) -> Vec<(u64, Arc<str>)> {
        self.replay.lock().unwrap().after(seq)
    }

    /// Kills omp and reaps it.
    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn frame_types(input: &[u8], cap: usize) -> Vec<String> {
        let mut reader = Cursor::new(input);
        let mut seen = Vec::new();
        pump(&mut reader, cap, |frame, _| {
            seen.push(frame["type"].as_str().unwrap_or_default().to_owned());
        })
        .unwrap();
        seen
    }

    #[test]
    fn too_long_line_cut_inside_a_multibyte_char_does_not_end_the_reader() {
        // `{"type":"ready"}` first, then a line whose cap boundary (21) falls
        // between the two bytes of `é`, then a frame that must still arrive.
        let mut input = b"{\"type\":\"ready\"}\n".to_vec();
        input.extend_from_slice(&[b'x'; 20]);
        input.extend_from_slice("é".as_bytes());
        input.extend_from_slice(b"yy\n{\"type\":\"pong\"}\n");
        assert_eq!(
            &input[37..39],
            "é".as_bytes(),
            "cap boundary inside the char"
        );
        assert_eq!(
            frame_types(&input, 21),
            ["ready".to_owned(), "pong".to_owned()]
        );
    }

    #[test]
    fn replay_ring_evicts_oldest_to_hold_the_byte_budget() {
        let mut ring = ReplayRing::new(10, 10);
        ring.push(1, Arc::from("aaaa"));
        ring.push(2, Arc::from("bbbb"));
        assert_eq!(ring.bytes, 8);
        ring.push(3, Arc::from("cccc"));
        assert_eq!(ring.bytes, 8, "oldest frame evicted to fit the budget");
        assert_eq!(
            ring.after(0)
                .into_iter()
                .map(|(seq, _)| seq)
                .collect::<Vec<_>>(),
            [2, 3]
        );
        assert_eq!(
            ring.after(2)
                .into_iter()
                .map(|(seq, _)| seq)
                .collect::<Vec<_>>(),
            [3]
        );
        // The newest frame stays even when it alone exceeds the budget.
        ring.push(4, Arc::from("zzzzzzzzzzzz"));
        assert_eq!(ring.bytes, 12);
        assert_eq!(ring.after(0).len(), 1);
    }

    #[test]
    fn replay_ring_also_holds_the_entry_count() {
        let mut ring = ReplayRing::new(2, 1 << 20);
        for seq in 1..=3 {
            ring.push(seq, Arc::from("frame"));
        }
        assert_eq!(
            ring.after(0)
                .into_iter()
                .map(|(seq, _)| seq)
                .collect::<Vec<_>>(),
            [2, 3]
        );
    }

    struct StuckWriter;

    impl Write for StuckWriter {
        fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
            std::thread::park();
            unreachable!()
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn stuck_stdin_times_out_and_a_full_queue_refuses_more_writes() {
        let (events, _rx) = std::sync::mpsc::channel();
        let writer = StdinWriter::new(StuckWriter, 1, Duration::from_millis(20), events).unwrap();
        let started = std::time::Instant::now();

        assert_eq!(
            writer.send("first").unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        assert_eq!(
            writer.send("second").unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        assert_eq!(
            writer.send("third").unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        assert!(started.elapsed() < Duration::from_millis(500));
        drop(writer);
        assert!(started.elapsed() < Duration::from_millis(500));
    }
}
