//! Hosts the Ompy `omp` process: spawns it, reads its RPC stdout, answers
//! approvals a persona rule covers, and reports what the core needs.
//!
//! The reader thread is the only place a frame is interpreted, and the
//! auto-approval response is written before any event for that frame is
//! emitted. Whether an approval is answered by a rule therefore never depends
//! on how the core happens to interleave its own inbox handling.

use crate::budget::Usage;
use omp_desktop_core::approval::{approval_request_id, approval_tool_name, RuleBook};
use omp_desktop_core::persona_protocol::ItemKind;
use serde_json::Value;
use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

/// Frames kept for a client that reconnects and asks to replay.
pub const REPLAY_MAX: usize = 5000;

/// Longest stdout line accepted; a longer one is split and its pieces are
/// dropped as unparsable JSON.
const MAX_LINE: usize = 16 * 1024 * 1024;

/// The session id the persona's rules are granted and looked up under.
pub const RULE_SESSION: &str = "ompy";

/// What to spawn and where it runs.
#[derive(Debug, Clone)]
pub struct Launch {
    /// The `omp` executable.
    pub program: PathBuf,
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
        raw: String,
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
type Replay = Arc<Mutex<(u64, VecDeque<(u64, String)>)>>;

/// A running omp process.
pub struct Session {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
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
            })
        }
        _ => None,
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
        events: Sender<SessionEvent>,
    ) -> io::Result<Self> {
        let mut cmd = Command::new(&l.program);
        cmd.args(omp_args(l))
            .current_dir(&l.home)
            .env("OMPY_SOCKET", &l.socket_env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for (key, value) in &l.env {
            cmd.env(key, value);
        }
        omp_desktop_core::child_path::apply_trusted_child_path(&mut cmd);
        let mut child = cmd.spawn()?;
        let stdin = Arc::new(Mutex::new(child.stdin.take().expect("piped stdin")));
        let stdout = child.stdout.take().expect("piped stdout");
        let replay: Replay = Arc::new(Mutex::new((0, VecDeque::new())));
        let (read_stdin, read_replay, home) =
            (Arc::clone(&stdin), Arc::clone(&replay), l.home.clone());
        let reader = std::thread::Builder::new()
            .name("ompy-stdout".into())
            .spawn(move || {
                let mut reader = BufReader::with_capacity(64 * 1024, stdout);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.by_ref().take(MAX_LINE as u64).read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    let raw = line.trim_end_matches(['\r', '\n']).to_owned();
                    let Ok(frame) = serde_json::from_str::<Value>(&raw) else {
                        continue;
                    };
                    if let Some(tool) = approval_tool_name(&frame) {
                        if rules.is_granted(RULE_SESSION, Some(&home), tool) {
                            if let Some(id) = approval_request_id(&frame) {
                                let answer = serde_json::json!({
                                    "type": "extension_ui_response",
                                    "id": id,
                                    "value": "Approve",
                                })
                                .to_string();
                                let written = read_stdin.lock().is_ok_and(|mut w| {
                                    writeln!(w, "{answer}").and_then(|()| w.flush()).is_ok()
                                });
                                if written {
                                    let _ = events.send(SessionEvent::AutoApproved {
                                        tool: tool.to_owned(),
                                    });
                                    continue;
                                }
                            }
                        }
                    }
                    let seq = {
                        let mut ring = read_replay.lock().unwrap();
                        ring.0 += 1;
                        let seq = ring.0;
                        ring.1.push_back((seq, raw.clone()));
                        if ring.1.len() > REPLAY_MAX {
                            ring.1.pop_front();
                        }
                        seq
                    };
                    if let Some(usage) = Usage::from_message_end(&frame) {
                        let _ = events.send(SessionEvent::Usage(usage));
                    }
                    if let Some(event) = classify(&frame) {
                        let _ = events.send(event);
                    }
                    let _ = events.send(SessionEvent::Frame { seq, raw });
                }
                let _ = events.send(SessionEvent::Exited {
                    reason: "omp exited".into(),
                });
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

    /// Writes one frame to omp's stdin. Line endings in `frame_json` are
    /// stripped, so one call is always one line.
    ///
    /// # Errors
    ///
    /// Returns the write error, or a poisoned-lock error when a previous
    /// writer panicked.
    pub fn send(&self, frame_json: &str) -> io::Result<()> {
        let line = frame_json.replace(['\r', '\n'], "");
        let mut writer = self
            .stdin
            .lock()
            .map_err(|_| io::Error::other("stdin poisoned"))?;
        writeln!(writer, "{line}")?;
        writer.flush()
    }

    /// The frames stored after `seq`, oldest first.
    ///
    /// # Panics
    ///
    /// Panics when the replay lock is poisoned.
    #[must_use]
    pub fn replay_after(&self, seq: u64) -> Vec<(u64, String)> {
        self.replay
            .lock()
            .unwrap()
            .1
            .iter()
            .filter(|(stored, _)| *stored > seq)
            .cloned()
            .collect()
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
