//! Read-only observer over the proxy's spliced WebSocket bytes: the panel's
//! only source of "the agent worked in page X".
//!
//! One [`Tap`] per proxy connection. It decodes the frames of both
//! directions ([`Messages`]) and, from the CDP messages in them, keeps a
//! `sessionId`-to-`targetId` map and reports the intent commands of a fixed
//! list. Whatever the tap cannot follow - a refused upgrade, a negotiated
//! extension, broken framing - switches it off for that connection, never
//! the splice.
//!
//! The tap lives on one observer thread per connection ([`Feed::spawn`]).
//! Both pipe threads hand it their chunks through a bounded queue,
//! [`Feed::push`], and do so *before* forwarding a chunk. A chunk is thus
//! queued before it can cause any reply, so the observer sees every command
//! before its reply and every reply before the command that depends on it.
//! Parsing and the follow callback never run on a splice thread, and the
//! splice never waits for the tap: a full queue disables the tap for the
//! connection instead, on the splice's side and the observer's.

use std::collections::{BTreeMap, HashMap};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::Arc;
use std::thread;

use serde_json::Value;

use super::proxy::AgentTarget;
use super::ws_frames::{Lost, Messages};

/// Largest command the tap reads (a client message over it is skipped).
const MAX_COMMAND: usize = 1 << 20;
/// Largest reply or event the tap reads. Everything it needs is small; a
/// screenshot's reply is not.
const MAX_REPLY: usize = 64 << 10;
/// Longest response head of the upgrade.
const MAX_HEAD: usize = 16 << 10;
/// Requests awaiting their reply, and live sessions, kept at most.
const MAX_PENDING: usize = 1024;
const MAX_SESSIONS: usize = 4096;
/// Chunks queued for the observer of one connection. A chunk is at most one
/// splice read (16 KiB), so a connection holds at most 4 MiB here. A real
/// agent's traffic is orders of magnitude below it; hitting it means the
/// observer is stuck, and the tap is switched off for the connection.
const QUEUE_CHUNKS: usize = 256;

/// Which way a chunk went.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Direction {
    /// Sent by the client (the agent).
    Client,
    /// Sent by the server (Chromium).
    Server,
}

/// A command whose reply names something the tap needs.
enum Request {
    /// `Target.createTarget`: the reply names the new page.
    Create,
    /// `Target.attachToTarget`: the reply names the session of this target.
    Attach(String),
}

/// The requests in flight. A reply, whether result or error, retires its
/// request; past `MAX_PENDING` outstanding ones the one with the lowest id
/// (the oldest: clients count up) is dropped. Completed requests cost
/// nothing, so a slow request outlives any number of fast ones.
#[derive(Default)]
struct Pending(BTreeMap<u64, Request>);

impl Pending {
    fn insert(&mut self, id: u64, request: Request) {
        self.0.insert(id, request);
        if self.0.len() > MAX_PENDING {
            self.0.pop_first();
        }
    }

    fn retire(&mut self, id: u64) -> Option<Request> {
        self.0.remove(&id)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.0.len()
    }
}

enum Phase {
    /// The server's response head so far.
    Upgrade(Vec<u8>),
    Frames,
    Off,
}

pub(super) struct Tap {
    on_target: AgentTarget,
    /// The page of a page-level connection (`/devtools/page/<targetId>`),
    /// the target of its commands that name no session.
    page: Option<String>,
    phase: Phase,
    /// Why the tap was switched off, once it was; kept apart from `phase`
    /// so that the reason is recorded however the switch-off came about.
    disabled: Option<&'static str>,
    commands: Messages,
    replies: Messages,
    /// Session to its page; `None` for a session on something else (a frame
    /// or worker).
    sessions: HashMap<String, Option<String>>,
    pending: Pending,
}

impl Tap {
    /// For the connection opened by `request_head`; `on_target` is told the
    /// page the agent worked in.
    pub(super) fn new(request_head: &[u8], on_target: AgentTarget) -> Self {
        let page = request_path(request_head)
            .and_then(|path| path.strip_prefix("/devtools/page/"))
            .map(|id| id.split(['?', '#']).next().unwrap_or(id))
            .filter(|id| !id.is_empty())
            .map(str::to_owned);
        Self {
            on_target,
            page,
            phase: Phase::Upgrade(Vec::new()),
            disabled: None,
            commands: Messages::new(true, MAX_COMMAND),
            replies: Messages::new(false, MAX_REPLY),
            sessions: HashMap::new(),
            pending: Pending::default(),
        }
    }

    /// Why the tap is off, if it is.
    #[cfg(test)]
    pub(super) const fn disabled_reason(&self) -> Option<&'static str> {
        self.disabled
    }

    /// Requests still awaiting their reply.
    #[cfg(test)]
    pub(super) fn outstanding(&self) -> usize {
        self.pending.len()
    }

    /// Bytes the client sent (after the request head).
    pub(super) fn feed_client(&mut self, bytes: &[u8]) {
        if matches!(self.phase, Phase::Off) {
            return;
        }
        let mut out = Vec::new();
        match self.commands.feed(bytes, &mut out) {
            Ok(()) => out.iter().for_each(|msg| self.on_command(msg)),
            Err(Lost) => self.off("client frames cannot be followed"),
        }
    }

    /// Bytes the server sent: the upgrade response, then frames.
    pub(super) fn feed_server(&mut self, bytes: &[u8]) {
        match &mut self.phase {
            Phase::Off => {}
            Phase::Frames => self.feed_frames(bytes),
            Phase::Upgrade(head) => {
                head.extend_from_slice(bytes);
                let Some(end) = head.windows(4).position(|w| w == b"\r\n\r\n") else {
                    if head.len() > MAX_HEAD {
                        self.off("no upgrade response");
                    }
                    return;
                };
                let verdict = check_upgrade(&head[..end]);
                // The frames that rode in with the head.
                let frames = head.split_off(end + 4);
                match verdict {
                    Ok(()) => {
                        self.phase = Phase::Frames;
                        self.feed_frames(&frames);
                    }
                    Err(why) => self.off(why),
                }
            }
        }
    }

    fn feed(&mut self, direction: Direction, bytes: &[u8]) {
        match direction {
            Direction::Client => self.feed_client(bytes),
            Direction::Server => self.feed_server(bytes),
        }
    }

    fn feed_frames(&mut self, bytes: &[u8]) {
        let mut out = Vec::new();
        match self.replies.feed(bytes, &mut out) {
            Ok(()) => out.iter().for_each(|msg| self.on_reply_or_event(msg)),
            Err(Lost) => self.off("server frames cannot be followed"),
        }
    }

    /// Stop tapping this connection and say why, once. The reason is
    /// recorded here, independent of the phase the tap was in.
    fn off(&mut self, why: &'static str) {
        if self.disabled.is_none() {
            self.disabled = Some(why);
            eprintln!("[omp-desktop] browser tap off for this connection: {why}");
        }
        self.phase = Phase::Off;
    }

    fn on_command(&mut self, message: &[u8]) {
        let Ok(command) = serde_json::from_slice::<Value>(message) else {
            return;
        };
        let Some(method) = command["method"].as_str() else {
            return;
        };
        let params = &command["params"];
        match (method, command["id"].as_u64()) {
            ("Target.createTarget", Some(id)) => self.pending.insert(id, Request::Create),
            ("Target.attachToTarget", Some(id)) => {
                if let Some(target) = params["targetId"].as_str() {
                    self.pending.insert(id, Request::Attach(target.to_owned()));
                }
            }
            _ => {}
        }
        let target = match method {
            "Target.activateTarget" => params["targetId"].as_str(),
            "Page.navigate"
            | "Page.reload"
            | "Page.navigateToHistoryEntry"
            | "Page.bringToFront"
            | "Page.captureScreenshot" => self.target_of(&command),
            _ if method.starts_with("Input.") => self.target_of(&command),
            _ => None,
        };
        if let Some(target) = target {
            (self.on_target)(target);
        }
    }

    /// The page a command is for: its session's, or the page-level
    /// connection's own.
    fn target_of(&self, command: &Value) -> Option<&str> {
        command["sessionId"].as_str().map_or_else(
            || self.page.as_deref(),
            |session| self.sessions.get(session).and_then(Option::as_deref),
        )
    }

    fn on_reply_or_event(&mut self, message: &[u8]) {
        let Ok(message) = serde_json::from_slice::<Value>(message) else {
            return;
        };
        let params = &message["params"];
        match message["method"].as_str() {
            Some("Target.attachedToTarget") => {
                if let Some(session) = params["sessionId"].as_str() {
                    let info = &params["targetInfo"];
                    let page = info["targetId"]
                        .as_str()
                        .filter(|_| info["type"] == "page")
                        .map(str::to_owned);
                    self.sessions.insert(session.to_owned(), page);
                }
            }
            Some("Target.detachedFromTarget") => {
                if let Some(session) = params["sessionId"].as_str() {
                    self.sessions.remove(session);
                }
            }
            Some(_) => {}
            None => self.on_reply(&message),
        }
        if self.sessions.len() > MAX_SESSIONS {
            self.off("too many sessions");
        }
    }

    /// A reply: `Target.createTarget` names the new page (agent intent),
    /// `Target.attachToTarget` the session of its page (no intent: puppeteer
    /// stays attached to every page). Result or error, the reply retires
    /// its request.
    fn on_reply(&mut self, reply: &Value) {
        let Some(request) = reply["id"].as_u64().and_then(|id| self.pending.retire(id)) else {
            return;
        };
        let Some(result) = reply.get("result") else {
            return; // an error reply: nothing was created or attached
        };
        match request {
            Request::Create => {
                if let Some(target) = result["targetId"].as_str() {
                    (self.on_target)(target);
                }
            }
            Request::Attach(target) => {
                if let Some(session) = result["sessionId"].as_str() {
                    // The attach event may have named it first (and said what
                    // it is).
                    self.sessions
                        .entry(session.to_owned())
                        .or_insert(Some(target));
                }
            }
        }
    }
}

/// The splice's end of a connection's observer: a bounded queue of chunks,
/// cloned for each pipe thread.
#[derive(Clone)]
pub(super) struct Feed {
    queue: SyncSender<(Direction, Vec<u8>)>,
    /// Set when either the splice cannot queue a chunk or the observer stops
    /// tapping; both pipe threads then avoid copying any further chunks.
    disabled: Arc<AtomicBool>,
    /// How long a test delays every client-side push of this connection;
    /// the ordering test's proxy sets it, so no parallel test sees it.
    #[cfg(test)]
    client_push_delay_ms: Arc<std::sync::atomic::AtomicU64>,
}

impl Feed {
    /// Start the observer thread that owns `tap`. It ends when every clone
    /// of the feed is gone. If the thread cannot start the feed is born
    /// disabled: the splice goes on untapped.
    pub(super) fn spawn(tap: Tap) -> Self {
        let (queue, chunks) = mpsc::sync_channel(QUEUE_CHUNKS);
        let disabled = Arc::new(AtomicBool::new(false));
        let observer_disabled = Arc::clone(&disabled);
        let started = thread::Builder::new()
            .name("browser-proxy-tap".into())
            .spawn(move || observe(tap, &chunks, &observer_disabled));
        if let Err(e) = &started {
            eprintln!("[omp-desktop] browser tap off for this connection: observer thread: {e}");
            disabled.store(true, Ordering::Relaxed);
        }
        Self {
            queue,
            disabled,
            #[cfg(test)]
            client_push_delay_ms: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }

    /// Queue a copy of `bytes` for the observer. Never blocks: the splice
    /// calls this before it forwards the chunk. When the queue is full (or
    /// the observer is gone) the tap is disabled for the rest of the
    /// connection, once and with a log line.
    pub(super) fn push(&self, direction: Direction, bytes: &[u8]) {
        if bytes.is_empty() || self.disabled.load(Ordering::Relaxed) {
            return;
        }
        #[cfg(test)]
        if direction == Direction::Client {
            thread::sleep(std::time::Duration::from_millis(
                self.client_push_delay_ms.load(Ordering::Relaxed),
            ));
        }
        let why = match self.queue.try_send((direction, bytes.to_vec())) {
            Ok(()) => return,
            Err(TrySendError::Full(_)) => "observer queue full",
            Err(TrySendError::Disconnected(_)) => "observer stopped",
        };
        if !self.disabled.swap(true, Ordering::Relaxed) {
            eprintln!("[omp-desktop] browser tap off for this connection: {why}");
        }
    }

    /// Whether either the splice or observer disabled the tap.
    #[cfg(test)]
    pub(super) fn is_disabled(&self) -> bool {
        self.disabled.load(Ordering::Relaxed)
    }

    /// `#[cfg(test)]`: the delay of every client-side push of this
    /// connection; the ordering test's proxy alone sets it.
    #[cfg(test)]
    pub(super) fn set_client_push_delay_ms(&self, millis: u64) {
        self.client_push_delay_ms.store(millis, Ordering::Relaxed);
    }
}

/// The observer thread: feeds the chunks to the tap in queue order. A panic
/// in it (or in the callback) switches the tap off without affecting forwarding.
/// Once either side sets `disabled`, observation and splice-side copies stop.
fn observe(mut tap: Tap, chunks: &Receiver<(Direction, Vec<u8>)>, disabled: &AtomicBool) {
    for (direction, bytes) in chunks {
        if disabled.load(Ordering::Relaxed) {
            break;
        }
        let fed = catch_unwind(AssertUnwindSafe(|| tap.feed(direction, &bytes)));
        if fed.is_err() {
            tap.off("internal error");
        }
        if tap.disabled.is_some() {
            disabled.store(true, Ordering::Relaxed);
            break;
        }
    }
}

/// The request target of a request head's first line.
fn request_path(head: &[u8]) -> Option<&str> {
    let line = head.split(|&b| b == b'\n').next()?;
    std::str::from_utf8(line).ok()?.split_whitespace().nth(1)
}

/// `Ok` for the `101` response head of a WebSocket upgrade without a
/// negotiated extension (compressed frames cannot be read).
fn check_upgrade(head: &[u8]) -> Result<(), &'static str> {
    let head = std::str::from_utf8(head).map_err(|_| "upgrade response is not text")?;
    let mut lines = head.split("\r\n");
    if lines.next().and_then(|s| s.split_whitespace().nth(1)) != Some("101") {
        return Err("upgrade refused");
    }
    let extended = lines.any(|line| {
        line.split_once(':')
            .is_some_and(|(name, _)| name.trim().eq_ignore_ascii_case("sec-websocket-extensions"))
    });
    if extended {
        return Err("Sec-WebSocket-Extensions negotiated (compressed frames)");
    }
    Ok(())
}
