use super::push::new_push_targets;
use crate::agent::reader::{sanitize_line, LineEvent};
use interprocess::local_socket::Stream;
use interprocess::TryClone;
use omp_desktop_core::persona_paths::Paths;
use omp_desktop_core::persona_pipe_security::{connect_verified, PipeConnectError};
use omp_desktop_core::persona_protocol::{
    encode_msg, read_line_capped, read_line_capped_with, write_msg, ClientKind, ClientMsg,
    Envelope, InboxItem, ItemKind, ItemState, LineRead, ServerMsg, StatusInfo, MAX_LINE_BYTES,
    PROTOCOL,
};
use omp_desktop_core::persona_quiet;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::BufReader;
use std::io::Write;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const INITIAL_BACKOFF: Duration = Duration::from_millis(500);
const MAX_BACKOFF: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Bytes [`ServerMsg::Rpc`] adds around the relayed frame: the fixed JSON
/// syntax plus a maximal `u64` sequence number (20 decimal digits).
const RELAY_ENVELOPE_OVERHEAD: usize = br#"{"type":"rpc","seq":,"frame":}"#.len() + 20;
/// The service enforces [`MAX_LINE_BYTES`] on the state or frame a client
/// sends and on relayed frames. A relay envelope may legitimately exceed
/// that by its own syntax, so the app accepts the bounded maximum.
const MAX_SERVER_LINE_BYTES: usize = MAX_LINE_BYTES + RELAY_ENVELOPE_OVERHEAD;

pub(super) trait Emitter: Send + Sync + 'static {
    fn status(&self, status: Option<&StatusInfo>);
    fn inbox(&self, items: &[InboxItem]);
    fn line(&self, seq: u64, text: &str);
    fn error(&self, kind: &str, message: &str);

    /// The warning `kind` described no longer applies. The cleared snapshot
    /// alone only reaches a UI that reloads; this event drops it live.
    fn error_cleared(&self, kind: &str);

    /// One push-worthy Ompy inbox item. The default is a no-op so a test
    /// emitter only records what it cares about.
    fn persona_push(&self, title: &str, urgent: bool) {
        let _ = (title, urgent);
    }

    /// The Ompy tab's phone-chip state: a relayed turn is running and open
    /// approvals or decisions wait in the inbox.
    fn activity(&self, busy: bool, has_ask: bool);
}

struct TauriEmitter(tauri::AppHandle);

impl Emitter for TauriEmitter {
    fn status(&self, status: Option<&StatusInfo>) {
        let _ = tauri::Emitter::emit(&self.0, "persona://status", status);
    }

    fn inbox(&self, items: &[InboxItem]) {
        let _ = tauri::Emitter::emit(&self.0, "persona://inbox", items);
    }

    fn line(&self, seq: u64, text: &str) {
        let _ = tauri::Emitter::emit(&self.0, "persona://line/ompy", LineEvent { seq, text });
    }

    fn error(&self, kind: &str, message: &str) {
        #[derive(serde::Serialize, Clone)]
        struct ErrorEvent<'a> {
            kind: &'a str,
            message: &'a str,
        }
        let _ = tauri::Emitter::emit(&self.0, "persona://error", ErrorEvent { kind, message });
    }

    fn error_cleared(&self, kind: &str) {
        #[derive(serde::Serialize, Clone)]
        struct ClearedEvent<'a> {
            kind: &'a str,
        }
        let _ = tauri::Emitter::emit(&self.0, "persona://error/cleared", ClearedEvent { kind });
    }

    fn persona_push(&self, title: &str, urgent: bool) {
        crate::remote::bridge::notify_persona(&self.0, title, urgent);
    }

    fn activity(&self, busy: bool, has_ask: bool) {
        crate::remote::bridge::sync_persona_activity(&self.0, busy, has_ask);
    }
}

#[derive(Clone, serde::Serialize)]
pub struct PersonaError {
    kind: String,
    message: String,
}

/// Both error channels the app reports: the connection's last terminal error
/// (cleared by a successful status) and an app-side failure such as the
/// startup sidecar refresh (cleared only when a later refresh succeeds).
#[derive(Clone, Default, serde::Serialize)]
pub struct PersonaErrors {
    connection: Option<PersonaError>,
    refresh: Option<PersonaError>,
}

#[derive(Default)]
struct Snapshot {
    status: Option<StatusInfo>,
    inbox: Vec<InboxItem>,
    error: Option<PersonaError>,
    /// Not a connection error: the service may be perfectly reachable while
    /// the app failed to update its installed copy. Kept apart so the next
    /// status — or a retry storm — cannot hide it.
    refresh_error: Option<PersonaError>,
}

/// The app's managed persona client: one background worker thread and a
/// reconnecting connection. Commands never call it on the IPC thread — they
/// take a [`ClientHandle`] and run the blocking call through
/// [`crate::off_ipc`].
pub(super) struct Client {
    handle: ClientHandle,
}

/// Owned handle to the client's worker, cheap to clone and safe to move into
/// a blocking task (`off_ipc`). Dropping a handle leaves the worker running;
/// only dropping the managed [`Client`] shuts it down.
#[derive(Clone)]
pub(super) struct ClientHandle {
    tx: Sender<WorkerMsg>,
    snapshot: Arc<Mutex<Snapshot>>,
}

impl Client {
    pub(super) fn for_app(app: tauri::AppHandle) -> Self {
        Self::start_inner(Paths::resolve().ok(), Arc::new(TauriEmitter(app)))
    }

    #[cfg(test)]
    fn start(paths: Paths, emitter: Arc<dyn Emitter>) -> Self {
        Self::start_inner(Some(paths), emitter)
    }

    fn start_inner(paths: Option<Paths>, emitter: Arc<dyn Emitter>) -> Self {
        let (tx, rx) = mpsc::channel();
        let snapshot = Arc::new(Mutex::new(Snapshot::default()));
        let worker = Worker {
            paths,
            emitter,
            rx,
            tx: tx.clone(),
            snapshot: Arc::clone(&snapshot),
            connection: None,
            next_connection: 1,
            next_req: 1,
            detach_requested: None,
            relay_muted: false,
            pending: HashMap::new(),
            retry_at: Some(Instant::now()),
            backoff: INITIAL_BACKOFF,
            seen_inbox: HashSet::new(),
            persona_activity: (false, false),
            outage_reported: false,
            expect_off: false,
            stopped: false,
        };
        if let Err(error) = std::thread::Builder::new()
            .name("persona-client".into())
            .spawn(move || worker.run())
        {
            let _ = tx.send(WorkerMsg::Closed {
                connection: 0,
                reason: format!("cannot start persona client: {error}"),
            });
        }
        Self {
            handle: ClientHandle { tx, snapshot },
        }
    }

    /// A handle for a command's blocking work (`off_ipc`).
    pub(super) fn handle(&self) -> ClientHandle {
        self.handle.clone()
    }

    pub(super) fn status(&self) -> Option<StatusInfo> {
        self.handle.status()
    }

    pub(super) fn inbox(&self) -> Vec<InboxItem> {
        self.handle.inbox()
    }

    pub(super) fn errors(&self) -> PersonaErrors {
        self.handle.errors()
    }
}

impl ClientHandle {
    pub(super) fn status(&self) -> Option<StatusInfo> {
        // IPC returns an owned snapshot; the worker retains its current copy.
        self.snapshot
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .status
            .clone()
    }

    pub(super) fn inbox(&self) -> Vec<InboxItem> {
        // IPC returns an owned snapshot; the worker retains its current copy.
        self.snapshot
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .inbox
            .clone()
    }

    pub(super) fn errors(&self) -> PersonaErrors {
        // IPC returns an owned snapshot; the worker retains its current copy.
        let snapshot = self.snapshot.lock().unwrap_or_else(PoisonError::into_inner);
        PersonaErrors {
            connection: snapshot.error.clone(), // event and cached snapshot each own a copy
            refresh: snapshot.refresh_error.clone(),
        }
    }

    pub(super) fn request(&self, body: ClientMsg) -> Result<(), String> {
        self.request_value(body).map(|_| ())
    }

    /// Like [`Self::request`], but hands back the reply's `data` (JSON
    /// `null` when the service answered without any). `list_schedule` is
    /// the one request whose answer the UI needs.
    pub(super) fn request_value(&self, body: ClientMsg) -> Result<Value, String> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(WorkerMsg::Request { body, response: tx })
            .map_err(|_| "persona client stopped".to_owned())?;
        match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => Err("persona request timed out".into()),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err("persona client stopped".into()),
        }
    }

    pub(super) fn reconnect(&self) -> Result<(), String> {
        self.reconnect_with(false)
    }

    /// Reconnect after a deliberate Disable: the service's absence is the
    /// expected state, so its connect failures stay silent until something
    /// answers or Enable reconnects again.
    pub(super) fn reconnect_expecting_off(&self) -> Result<(), String> {
        self.reconnect_with(true)
    }

    fn reconnect_with(&self, expect_off: bool) -> Result<(), String> {
        self.tx
            .send(WorkerMsg::Reconnect { expect_off })
            .map_err(|_| "persona client stopped".to_owned())
    }

    /// Cache and emit an app-side refresh failure (`persona://error` kind
    /// `refresh`) in its own snapshot field, apart from the connection's.
    pub(super) fn report_refresh_error(&self, message: &str) {
        let _ = self.tx.send(WorkerMsg::RefreshFailed {
            message: message.to_owned(),
        });
    }

    /// Drop a stored refresh failure: a later refresh succeeded, so the
    /// warning no longer describes the installed copy.
    pub(super) fn clear_refresh_error(&self) {
        let _ = self.tx.send(WorkerMsg::RefreshSucceeded);
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.handle.tx.send(WorkerMsg::Shutdown);
    }
}

enum WorkerMsg {
    Request {
        body: ClientMsg,
        response: Sender<Result<Value, String>>,
    },
    Reconnect {
        expect_off: bool,
    },
    RefreshFailed {
        message: String,
    },
    RefreshSucceeded,
    Shutdown,
    Server {
        connection: u64,
        msg: ServerMsg,
    },
    Closed {
        connection: u64,
        reason: String,
    },
}

struct Connection {
    id: u64,
    writer: Stream,
    /// The connection's `read_server` thread; disconnected before the
    /// reader's handle is dropped so it can be reaped.
    reader: JoinHandle<()>,
}

// Four independent flags, each toggled by its own message or connection event
// (relay mute window, outage error dedupe, deliberate stop, shutdown latch).
#[allow(clippy::struct_excessive_bools)]
struct Worker {
    paths: Option<Paths>,
    emitter: Arc<dyn Emitter>,
    rx: Receiver<WorkerMsg>,
    tx: Sender<WorkerMsg>,
    snapshot: Arc<Mutex<Snapshot>>,
    connection: Option<Connection>,
    next_connection: u64,
    next_req: u64,
    /// The outstanding [`ClientMsg::Detach`] request id. The relay's busy
    /// state is only cleared when the service acknowledges this request: a
    /// frame relayed just before the reply must not leave the chip busy for
    /// a stream that ends there.
    detach_requested: Option<u64>,
    /// Set from a detach request until the next attach. Frames relayed after
    /// the detach was sent are stale — the service may still be draining
    /// frames queued before it processed the detach — so they are dropped
    /// instead of rebuilding the busy state the detach is about to clear.
    relay_muted: bool,
    pending: HashMap<u64, (Sender<Result<Value, String>>, Instant)>,
    retry_at: Option<Instant>,
    backoff: Duration,
    /// Inbox ids this app run has already considered for a push; survives a
    /// reconnect (the service replays its whole inbox) and diverges from the
    /// snapshot's contents, which are cleared when the service goes away.
    seen_inbox: HashSet<String>,
    /// The Ompy tab's phone-chip state `(busy, has_ask)`, derived from the
    /// relayed turn frames and the inbox snapshot the app already receives.
    persona_activity: (bool, bool),
    /// Whether the current outage's `io` error already reached the frontend.
    /// One outage is one error: the retry storm that follows stays silent
    /// until a connection is live again (the outage is over).
    outage_reported: bool,
    /// The user just disabled Ompy on purpose: the service's absence (and
    /// the `io` error every connection attempt gets) is expected, so nothing
    /// is reported until something answers or Enable is pressed.
    expect_off: bool,
    stopped: bool,
}

impl Worker {
    fn run(mut self) {
        loop {
            self.connect_if_due();
            let received = match self.wait() {
                Ok(msg) => msg,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    self.expire_requests();
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    // Every sender is gone: shut the connection down (the
                    // reader thread would otherwise keep the socket open
                    // forever) and stop.
                    self.disconnect(None);
                    return;
                }
            };
            match received {
                WorkerMsg::Shutdown => {
                    self.fail_pending("persona client stopped");
                    self.disconnect(None);
                    return;
                }
                WorkerMsg::Reconnect { expect_off } => {
                    self.stopped = false;
                    self.outage_reported = false;
                    self.expect_off = expect_off;
                    self.backoff = INITIAL_BACKOFF;
                    self.disconnect(None);
                    self.retry_at = Some(Instant::now());
                }
                WorkerMsg::Request { body, response } => self.request(body, response),
                WorkerMsg::RefreshFailed { message } => {
                    let error = PersonaError {
                        kind: "refresh".to_owned(),
                        message: message.clone(), // event and cached snapshot each own a copy
                    };
                    self.snapshot
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .refresh_error = Some(error);
                    self.emitter.error("refresh", &message);
                }
                WorkerMsg::RefreshSucceeded => {
                    self.snapshot
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .refresh_error = None;
                    // A mounted UI holds the warning in its own state, so the
                    // cleared snapshot alone would leave it until a reload.
                    // Idempotent: a start whose refresh never warned clears
                    // nothing.
                    self.emitter.error_cleared("refresh");
                }
                WorkerMsg::Server { connection, msg } => self.server_msg(connection, msg),
                WorkerMsg::Closed { connection, reason } => {
                    if self.connection_id() == Some(connection) {
                        self.disconnect(Some(("io", reason)));
                    }
                }
            }
            self.expire_requests();
        }
    }

    fn wait(&self) -> Result<WorkerMsg, mpsc::RecvTimeoutError> {
        let now = Instant::now();
        let deadline = self
            .pending
            .values()
            .map(|(_, deadline)| *deadline)
            .chain(self.retry_at)
            .min();
        match deadline.and_then(|deadline| deadline.checked_duration_since(now)) {
            Some(timeout) => self.rx.recv_timeout(timeout),
            None if deadline.is_some() => self.rx.recv_timeout(Duration::ZERO),
            None => self
                .rx
                .recv()
                .map_err(|_| mpsc::RecvTimeoutError::Disconnected),
        }
    }

    fn connect_if_due(&mut self) {
        if self.stopped || self.connection.is_some() {
            return;
        }
        let Some(retry_at) = self.retry_at else {
            return;
        };
        if Instant::now() < retry_at {
            return;
        }
        self.retry_at = None;
        let paths = match &self.paths {
            Some(paths) => paths,
            None => match Paths::resolve() {
                Ok(paths) => self.paths.insert(paths),
                Err(error) => {
                    self.connection_failed(ConnectError::Io(error));
                    return;
                }
            },
        };
        let id = self.next_connection;
        self.next_connection += 1;
        match connect(paths, id, &self.tx) {
            Ok(connection) => {
                self.connection = Some(connection);
                // A live connection ends the outage and any expected
                // absence; the next `io` failure is a new one and is
                // reported again.
                self.outage_reported = false;
                self.expect_off = false;
            }
            Err(error) => self.connection_failed(error),
        }
    }

    fn connection_failed(&mut self, error: ConnectError) {
        match error {
            ConnectError::Io(message) => self.disconnect(Some(("io", message))),
            ConnectError::Terminal { kind, message } => {
                self.stopped = true;
                self.disconnect(Some((kind, message)));
                self.retry_at = None;
            }
        }
    }

    fn request(&mut self, body: ClientMsg, response: Sender<Result<Value, String>>) {
        let Some(connection) = &self.connection else {
            let _ = response.send(Err("persona service not connected".into()));
            return;
        };
        let detaches = matches!(&body, ClientMsg::Detach);
        let attaches = matches!(&body, ClientMsg::Attach { .. });
        let req = self.next_req;
        self.next_req += 1;
        let line = match encode_msg(&Envelope {
            req: Some(req),
            body,
        }) {
            Ok(line) => line,
            Err(error) => {
                let _ = response.send(Err(format!("cannot encode persona request: {error}")));
                return;
            }
        };
        // A frame past the protocol's line cap can never be accepted — the
        // service's reader drops the line — so the request would sit until
        // the 10 s timeout. Refuse it now with the limit instead.
        // `encode_msg` appends exactly the newline the cap excludes.
        let content_len = line.len() - 1;
        if content_len > MAX_LINE_BYTES {
            let _ = response.send(Err(format!(
                "persona frame is {content_len} bytes; the service accepts at most \
                 {MAX_LINE_BYTES}"
            )));
            return;
        }
        let mut writer = &connection.writer;
        if let Err(error) = writer.write_all(&line).and_then(|()| writer.flush()) {
            let _ = response.send(Err(format!("cannot write to persona service: {error}")));
            self.disconnect(Some(("io", error.to_string())));
            return;
        }
        if detaches {
            // Frames can still be in flight until the service processes this
            // request and replies. They are stale for a stream that is
            // stopping, so drop them — including an `agent_start` that would
            // otherwise set `busy` again after the detach. The chip's state
            // is cleared on the ordered acknowledgement in `server_msg`.
            self.detach_requested = Some(req);
            self.relay_muted = true;
        }
        if attaches {
            // A new attach asks for the relay again; frames from before the
            // detach were already dropped and the service replays this
            // connection's cursor, so accept relayed frames from here on.
            self.relay_muted = false;
        }
        self.pending
            .insert(req, (response, Instant::now() + REQUEST_TIMEOUT));
    }

    fn server_msg(&mut self, connection: u64, msg: ServerMsg) {
        if self.connection_id() != Some(connection) {
            return;
        }
        if !matches!(msg, ServerMsg::Hello { .. }) {
            self.backoff = INITIAL_BACKOFF;
        }
        match msg {
            ServerMsg::Reply {
                req,
                ok,
                data,
                error,
            } => {
                // The detach's own reply is the ordered point where the
                // service has stopped relaying: clear the chip's turn state
                // here, not when the request was sent, so a frame relayed
                // while the detach was in flight cannot leave it busy. A
                // failed detach means the relay is still attached, so resume
                // accepting its frames instead.
                if self.detach_requested == Some(req) {
                    self.detach_requested = None;
                    if ok {
                        self.set_activity(Some(false), None);
                    } else {
                        self.relay_muted = false;
                    }
                }
                if let Some((response, _)) = self.pending.remove(&req) {
                    let result = if ok {
                        Ok(data.unwrap_or(Value::Null))
                    } else {
                        Err(error.unwrap_or_else(|| "persona request failed".into()))
                    };
                    let _ = response.send(result);
                }
            }
            ServerMsg::Status { status } => {
                let generation_changed = {
                    let mut snapshot = self.snapshot.lock().unwrap_or_else(PoisonError::into_inner);
                    let changed = snapshot
                        .status
                        .as_ref()
                        .is_some_and(|old| old.generation != status.generation);
                    snapshot.status = Some(status.clone()); // event and cached snapshot each own a copy
                    snapshot.error = None;
                    changed
                };
                if generation_changed {
                    // A new omp session generation retires the process whose
                    // frames set `busy`; its `agent_end` (if any) will never
                    // arrive and the status carries no turn flag, so the
                    // relayed turn state cannot carry over.
                    self.set_activity(Some(false), None);
                }
                self.emitter.status(Some(&status));
            }
            ServerMsg::Inbox { items } => {
                let quiet = {
                    let mut snapshot = self.snapshot.lock().unwrap_or_else(PoisonError::into_inner);
                    let quiet = snapshot
                        .status
                        .as_ref()
                        .is_some_and(|status| persona_quiet::is_quiet_now(&status.settings));
                    snapshot.inbox.clone_from(&items); // event and cached snapshot each own a copy
                    quiet
                };
                self.set_activity(None, Some(has_open_ask(&items)));
                self.emitter.inbox(&items);
                self.push_new_items(&items, quiet);
            }
            ServerMsg::Rpc { seq, frame } => {
                // Frames received after a detach was requested belong to a
                // stream that is stopping; the service may still be
                // draining what it queued before it processed the detach.
                // Dropping them keeps a stale `agent_start` from rebuilding
                // the busy state the acknowledgement clears.
                if self.relay_muted {
                    return;
                }
                // A relayed omp frame is an omp frame: the same redaction the
                // agent's stdout reader runs before the webview sees it.
                let (text, parsed) = sanitize_line(frame.get().as_bytes());
                if let Some(busy) = parsed
                    .as_ref()
                    .and_then(crate::remote::tracker::persona_turn_busy)
                {
                    self.set_activity(Some(busy), None);
                }
                self.emitter.line(seq, &text);
            }
            ServerMsg::Hello { protocol } if protocol != PROTOCOL => {
                self.stopped = true;
                self.disconnect(Some((
                    "protocol",
                    format!("service protocol {protocol}, expected {PROTOCOL}"),
                )));
                self.retry_at = None;
            }
            ServerMsg::Hello { .. } => {}
        }
    }

    /// Push the newly opened approvals and decisions of one inbox snapshot.
    /// The seen set gives each id at most one push per app run; only ids
    /// still in the inbox are kept, so it stays bounded by the inbox cap
    /// (a pruned item never returns under the same id).
    fn push_new_items(&mut self, items: &[InboxItem], quiet: bool) {
        let targets = new_push_targets(&self.seen_inbox, items, quiet);
        self.seen_inbox = items.iter().map(|item| item.id.clone()).collect();
        for item in targets {
            self.emitter.persona_push(&item.title, item.urgent);
        }
    }

    /// Update the chip state and tell the remote hub only when it changes.
    /// `None` leaves that half as it was.
    fn set_activity(&mut self, busy: Option<bool>, has_ask: Option<bool>) {
        let (old_busy, old_has_ask) = self.persona_activity;
        let next = (busy.unwrap_or(old_busy), has_ask.unwrap_or(old_has_ask));
        if next != self.persona_activity {
            self.persona_activity = next;
            self.emitter.activity(next.0, next.1);
        }
    }

    fn expire_requests(&mut self) {
        let now = Instant::now();
        let expired: Vec<u64> = self
            .pending
            .iter()
            .filter(|(_, (_, deadline))| *deadline <= now)
            .map(|(req, _)| *req)
            .collect();
        for req in expired {
            if let Some((response, _)) = self.pending.remove(&req) {
                let _ = response.send(Err("persona request timed out".into()));
            }
        }
    }

    fn fail_pending(&mut self, reason: &str) {
        for (_, (response, _)) in self.pending.drain() {
            let _ = response.send(Err(reason.to_owned()));
        }
    }

    fn connection_id(&self) -> Option<u64> {
        self.connection.as_ref().map(|connection| connection.id)
    }

    fn disconnect(&mut self, error: Option<(&str, String)>) {
        if let Some(connection) = self.connection.take() {
            // Shut the socket down before dropping the writer: the reader
            // thread holds its own handle, so closing ours alone would leave
            // the socket open, the reader blocked, and the service holding
            // one of its connection slots until the app exits.
            shutdown_stream(&connection.writer);
            reap(connection.reader, &connection.writer);
            drop(connection.writer);
        }
        self.fail_pending("persona service disconnected");
        // A fresh connection starts without a detach in flight and does not
        // relay until the app attaches; neither flag can outlive the socket.
        self.detach_requested = None;
        self.relay_muted = false;
        {
            let mut snapshot = self.snapshot.lock().unwrap_or_else(PoisonError::into_inner);
            snapshot.status = None;
            snapshot.inbox.clear();
            if let Some((kind, message)) = &error {
                if *kind != "io" {
                    snapshot.error = Some(PersonaError {
                        kind: (*kind).to_owned(),
                        message: message.clone(), // event and cached snapshot each own a copy
                    });
                }
            }
        }
        self.emitter.status(None);
        self.emitter.inbox(&[]);
        self.set_activity(Some(false), Some(false));
        if let Some((kind, message)) = error {
            // One outage, one `io` error: the retries that follow a down
            // service stay silent until a connection is live again. A service
            // the user just disabled is not an outage at all, so its absence
            // is retried (the retry below still runs) without a report.
            let expected = kind == "io" && self.expect_off;
            if !expected && (kind != "io" || !self.outage_reported) {
                self.emitter.error(kind, &message);
                if kind == "io" {
                    self.outage_reported = true;
                }
            }
        }
        if !self.stopped {
            self.retry_at = Some(Instant::now() + self.backoff);
            self.backoff = next_backoff(self.backoff);
        }
    }
}

enum ConnectError {
    Io(String),
    Terminal { kind: &'static str, message: String },
}

impl From<std::io::Error> for ConnectError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

fn connect(paths: &Paths, id: u64, tx: &Sender<WorkerMsg>) -> Result<Connection, ConnectError> {
    // The shared helper verifies the Windows server's user before this
    // function writes the hello: an unverified pipe never sees a request.
    let stream = connect_verified(paths).map_err(|error| match error {
        PipeConnectError::Unavailable(error) => ConnectError::Io(error.to_string()),
        other => ConnectError::Terminal {
            kind: "owner",
            message: other.to_string(),
        },
    })?;
    let mut writer = stream.try_clone()?;
    let mut reader = BufReader::new(stream);
    write_msg(
        &mut writer,
        &Envelope {
            req: Some(0),
            body: ClientMsg::Hello {
                protocol: PROTOCOL,
                client: ClientKind::App,
            },
        },
    )?;
    let mut buf = Vec::new();
    match read_line_capped(&mut reader, &mut buf)? {
        LineRead::Line => {}
        LineRead::TooLong => return Err(ConnectError::Io("persona hello too long".into())),
        LineRead::Eof => return Err(ConnectError::Io("persona service closed hello".into())),
    }
    match serde_json::from_slice::<ServerMsg>(&buf) {
        Ok(ServerMsg::Hello { protocol }) if protocol == PROTOCOL => {}
        Ok(ServerMsg::Hello { protocol }) => {
            return Err(ConnectError::Terminal {
                kind: "protocol",
                message: format!("service protocol {protocol}, expected {PROTOCOL}"),
            });
        }
        Ok(ServerMsg::Reply {
            req: 0,
            ok: false,
            error: Some(error),
            ..
        }) if error == "too many connections" => {
            return Err(ConnectError::Io(error));
        }
        Ok(ServerMsg::Reply {
            req: 0,
            ok: false,
            error,
            ..
        }) => {
            return Err(ConnectError::Terminal {
                kind: "protocol",
                message: error.unwrap_or_else(|| "persona protocol mismatch".into()),
            });
        }
        Ok(_) => return Err(ConnectError::Io("expected persona hello".into())),
        Err(error) => return Err(ConnectError::Io(format!("invalid persona hello: {error}"))),
    }
    let reader_tx = tx.clone();
    let reader = std::thread::Builder::new()
        .name("persona-reader".into())
        .spawn(move || read_server(id, reader, reader_tx))?;
    Ok(Connection { id, writer, reader })
}

/// Shut this end of a connected socket down so a reader thread blocked in
/// `read` returns. Dropping a handle alone never wakes it: `read_server`
/// holds its own clone of the same socket.
///
/// The service's own teardown (`omp-desktopd`'s `server::shutdown`) is not
/// reusable here — its Windows half is `DisconnectNamedPipe`, which only the
/// server end of a pipe may call.
fn shutdown_stream(stream: &Stream) {
    #[cfg(unix)]
    {
        use std::os::fd::{AsFd, AsRawFd};
        let Stream::UdSocket(stream) = stream;
        // SAFETY: shutdown only reads the descriptor; the stream owns it.
        // The socket may already be half-closed by the peer (`ENOTCONN`);
        // the read is at EOF then anyway.
        unsafe {
            libc::shutdown(stream.as_fd().as_raw_fd(), libc::SHUT_RDWR);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::{AsHandle, AsRawHandle};
        use windows_sys::Win32::System::IO::CancelIoEx;
        let Stream::NamedPipe(stream) = stream;
        // SAFETY: the handle belongs to this process and this stream;
        // cancelling its pending I/O is what wakes the reader's blocking
        // `ReadFile` (a named pipe has no shutdown call).
        unsafe {
            CancelIoEx(stream.as_handle().as_raw_handle(), std::ptr::null());
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = stream;
    }
}

/// Reap a disconnected connection's reader thread before dropping `writer`.
fn reap(reader: JoinHandle<()>, writer: &Stream) {
    // The shutdown above makes the reader's `read` return on unix, so the
    // join is bounded by the socket implementation.
    #[cfg(unix)]
    {
        let _ = writer;
        let _ = reader.join();
    }
    // A named pipe has no shutdown call. Keep the writer alive and repeat
    // CancelIoEx until the reader finishes; a failed cancellation is bounded
    // to 500 ms and detaches the reader rather than hanging the worker.
    #[cfg(windows)]
    {
        use std::os::windows::io::{AsHandle, AsRawHandle};
        use windows_sys::Win32::System::IO::CancelIoEx;
        let Stream::NamedPipe(stream) = writer;
        for _ in 0..50 {
            if reader.is_finished() {
                break;
            }
            // SAFETY: the handle belongs to this process and this stream;
            // cancelling its pending I/O wakes the reader's `ReadFile`.
            unsafe {
                CancelIoEx(stream.as_handle().as_raw_handle(), std::ptr::null());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if reader.is_finished() {
            let _ = reader.join();
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = writer;
        drop(reader);
    }
}

fn read_server(id: u64, mut reader: BufReader<Stream>, tx: Sender<WorkerMsg>) {
    let mut buf = Vec::new();
    let reason = loop {
        match read_line_capped_with(&mut reader, &mut buf, MAX_SERVER_LINE_BYTES) {
            Ok(LineRead::Line) => match serde_json::from_slice::<ServerMsg>(&buf) {
                Ok(msg) => {
                    if tx
                        .send(WorkerMsg::Server {
                            connection: id,
                            msg,
                        })
                        .is_err()
                    {
                        return;
                    }
                }
                Err(error) => break format!("invalid persona message: {error}"),
            },
            Ok(LineRead::TooLong) => break "persona message too long".into(),
            Ok(LineRead::Eof) => break "persona service disconnected".into(),
            Err(error) => break error.to_string(),
        }
    };
    let _ = tx.send(WorkerMsg::Closed {
        connection: id,
        reason,
    });
}

fn next_backoff(prev: Duration) -> Duration {
    prev.checked_mul(2).unwrap_or(MAX_BACKOFF).min(MAX_BACKOFF)
}

/// Open approvals and decisions are what the phone chip's question mark
/// stands for; results and notices stay informational.
fn has_open_ask(items: &[InboxItem]) -> bool {
    items.iter().any(|item| {
        item.state == ItemState::Open
            && matches!(item.kind, ItemKind::Approval | ItemKind::Decision)
    })
}

#[cfg(test)]
mod tests {
    use super::{next_backoff, Client, Emitter};
    use crate::test_support::{eventually, TempDir};
    use interprocess::local_socket::{
        prelude::*, ListenerNonblockingMode, ListenerOptions, Stream,
    };
    use interprocess::TryClone;
    use omp_desktop_core::persona_paths::{ensure_private_dir, socket_name, Paths};
    use omp_desktop_core::persona_protocol::{
        read_line_capped, write_msg, ClientMsg, Envelope, LineRead, PersonaSettings, ServerMsg,
        StatusInfo, MAX_LINE_BYTES,
    };
    use serde_json::Value;
    use std::io::BufReader;
    #[cfg(unix)]
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<(String, Value)>>);

    impl Emitter for Recorder {
        fn status(&self, status: Option<&StatusInfo>) {
            self.0
                .lock()
                .unwrap()
                .push(("status".into(), serde_json::to_value(status).unwrap()));
        }

        fn inbox(&self, items: &[omp_desktop_core::persona_protocol::InboxItem]) {
            self.0
                .lock()
                .unwrap()
                .push(("inbox".into(), serde_json::to_value(items).unwrap()));
        }

        fn line(&self, seq: u64, text: &str) {
            self.0
                .lock()
                .unwrap()
                .push(("line".into(), serde_json::json!({"seq": seq, "text": text})));
        }

        fn error(&self, kind: &str, message: &str) {
            self.0.lock().unwrap().push((
                "error".into(),
                serde_json::json!({"kind": kind, "message": message}),
            ));
        }

        fn error_cleared(&self, kind: &str) {
            self.0
                .lock()
                .unwrap()
                .push(("cleared".into(), serde_json::json!({"kind": kind})));
        }

        fn persona_push(&self, title: &str, urgent: bool) {
            self.0.lock().unwrap().push((
                "push".into(),
                serde_json::json!({"title": title, "urgent": urgent}),
            ));
        }

        fn activity(&self, busy: bool, has_ask: bool) {
            self.0.lock().unwrap().push((
                "activity".into(),
                serde_json::json!({"busy": busy, "hasAsk": has_ask}),
            ));
        }
    }

    fn status() -> StatusInfo {
        StatusInfo {
            generation: 7,
            state: "running".into(),
            error: None,
            next_wake_ms: None,
            tokens_today: 12,
            daily_token_limit: 100,
            open_items: 0,
            settings: PersonaSettings::default(),
        }
    }

    /// A status whose quiet window is empty, so a test never depends on the
    /// wall clock.
    fn daytime_status() -> StatusInfo {
        let mut quiet_free = status();
        quiet_free.settings.quiet_start = "00:00".into();
        quiet_free.settings.quiet_end = "00:00".into();
        quiet_free.settings.quiet_weekends = false;
        quiet_free
    }

    fn open_item(id: &str) -> omp_desktop_core::persona_protocol::InboxItem {
        use omp_desktop_core::persona_protocol::{InboxItem, ItemKind, ItemState};
        InboxItem {
            id: id.into(),
            kind: ItemKind::Approval,
            created_at: 0,
            title: format!("title {id}"),
            body: None,
            options: Vec::new(),
            urgent: false,
            state: ItemState::Open,
            answer: None,
            rpc_request_id: None,
            request_method: None,
            ask_questions: None,
            secret: false,
        }
    }

    #[test]
    fn only_open_approvals_and_decisions_are_asks() {
        use super::has_open_ask;
        use omp_desktop_core::persona_protocol::{ItemKind, ItemState};

        assert!(has_open_ask(&[open_item("approval")]));
        let mut decision = open_item("decision");
        decision.kind = ItemKind::Decision;
        assert!(has_open_ask(&[decision]));

        let mut result = open_item("result");
        result.kind = ItemKind::Result;
        let mut notice = open_item("notice");
        notice.kind = ItemKind::Notice;
        assert!(!has_open_ask(&[result, notice]), "results are not asks");

        let mut answered = open_item("answered");
        answered.state = ItemState::Answered;
        let mut dismissed = open_item("dismissed");
        dismissed.kind = ItemKind::Decision;
        dismissed.state = ItemState::Dismissed;
        assert!(
            !has_open_ask(&[answered, dismissed]),
            "settled items are not asks"
        );
    }

    fn read_client<R: std::io::Read>(stream: R) -> Envelope<ClientMsg> {
        let mut reader = BufReader::new(stream);
        let mut buf = Vec::new();
        assert_eq!(
            read_line_capped(&mut reader, &mut buf).unwrap(),
            LineRead::Line
        );
        serde_json::from_slice(&buf).unwrap()
    }

    /// Paths under a per-test root, with a unique Windows pipe name: the
    /// production pipe is user-wide, and a test's accept thread may outlive
    /// it (as in `omp-desktopd`'s own suites).
    fn test_paths(temp: &TempDir, tag: &str) -> Paths {
        let paths = Paths::under(temp.path());
        #[cfg(windows)]
        let paths = Paths {
            test_pipe_name: Some(format!("ompy-app-test-{tag}-{}", std::process::id())),
            ..paths
        };
        #[cfg(not(windows))]
        let _ = tag;
        paths
    }

    /// The relayed turn frame the detach tests key their ordering on.
    const AGENT_START: &str = r#"{"type":"agent_start"}"#;

    fn raw_frame(json: &str) -> Box<serde_json::value::RawValue> {
        serde_json::value::RawValue::from_string(json.to_owned()).unwrap()
    }

    /// Position of the `n`-th recorded event called `name`.
    fn nth_event(events: &[(String, Value)], name: &str, n: usize) -> Option<usize> {
        events
            .iter()
            .enumerate()
            .filter(|(_, (event, _))| event == name)
            .map(|(index, _)| index)
            .nth(n)
    }

    /// A client against a fake service that has already greeted it: status,
    /// empty inbox and one relayed `agent_start`, reported as `busy`. `script`
    /// speaks for the service from there; the returned `TempDir` must stay
    /// alive for the test's duration.
    fn relay_client(
        name: &str,
        script: impl FnOnce(&mut Stream) + Send + 'static,
    ) -> (TempDir, Arc<Recorder>, Client, std::thread::JoinHandle<()>) {
        let temp = TempDir::new("pc", name);
        let paths = test_paths(&temp, name);
        ensure_private_dir(&paths.persona).unwrap();
        let listener = ListenerOptions::new()
            .name(socket_name(&paths).unwrap())
            .create_sync()
            .unwrap();
        let server = std::thread::spawn(move || {
            let mut stream = listener.accept().unwrap();
            let _hello = read_client(stream.try_clone().unwrap());
            write_msg(&mut stream, &ServerMsg::Hello { protocol: 1 }).unwrap();
            write_msg(
                &mut stream,
                &ServerMsg::Status {
                    status: daytime_status(),
                },
            )
            .unwrap();
            write_msg(&mut stream, &ServerMsg::Inbox { items: vec![] }).unwrap();
            write_msg(
                &mut stream,
                &ServerMsg::Rpc {
                    seq: 1,
                    frame: raw_frame(AGENT_START),
                },
            )
            .unwrap();
            script(&mut stream);
        });
        let events = Arc::new(Recorder::default());
        let client = Client::start(paths, events.clone());
        let busy = eventually(Duration::from_secs(3), || {
            events
                .0
                .lock()
                .unwrap()
                .iter()
                .any(|(name, payload)| name == "activity" && payload["busy"] == true)
                .then_some(())
        });
        assert!(busy.is_some(), "the relayed turn never reported busy");
        (temp, events, client, server)
    }

    #[test]
    fn client_connects_and_emits_status() {
        let temp = TempDir::new("persona-client", "connect");
        let paths = test_paths(&temp, "connect");
        ensure_private_dir(&paths.persona).unwrap();
        let listener = ListenerOptions::new()
            .name(socket_name(&paths).unwrap())
            .create_sync()
            .unwrap();
        let server = std::thread::spawn(move || {
            let mut stream = listener.accept().unwrap();
            let hello = read_client(stream.try_clone().unwrap());
            assert!(matches!(hello.body, ClientMsg::Hello { .. }));
            write_msg(&mut stream, &ServerMsg::Hello { protocol: 1 }).unwrap();
            write_msg(&mut stream, &ServerMsg::Status { status: status() }).unwrap();
            write_msg(&mut stream, &ServerMsg::Inbox { items: vec![] }).unwrap();
            std::thread::sleep(Duration::from_millis(200));
        });
        let events = Arc::new(Recorder::default());
        let client = Client::start(paths, events.clone());
        let emitted = eventually(Duration::from_secs(2), || {
            let events = events.0.lock().unwrap();
            events
                .iter()
                .find(|(name, payload)| {
                    name == "status" && payload["generation"] == 7 && payload["state"] == "running"
                })
                .cloned()
        });
        assert_eq!(emitted.unwrap().0, "status");
        assert_eq!(client.status().unwrap().generation, 7);
        drop(client);
        server.join().unwrap();
    }

    #[test]
    fn client_reports_ompy_busy_and_open_asks() {
        let temp = TempDir::new("pc", "act");
        let paths = test_paths(&temp, "act");
        ensure_private_dir(&paths.persona).unwrap();
        let listener = ListenerOptions::new()
            .name(socket_name(&paths).unwrap())
            .create_sync()
            .unwrap();
        let server = std::thread::spawn(move || {
            let mut stream = listener.accept().unwrap();
            let _hello = read_client(stream.try_clone().unwrap());
            write_msg(&mut stream, &ServerMsg::Hello { protocol: 1 }).unwrap();
            let frame = |value: Value| serde_json::value::RawValue::from_string(value.to_string());
            write_msg(
                &mut stream,
                &ServerMsg::Rpc {
                    seq: 1,
                    frame: frame(serde_json::json!({"type":"agent_start"})).unwrap(),
                },
            )
            .unwrap();
            let mut result = open_item("result");
            result.kind = omp_desktop_core::persona_protocol::ItemKind::Result;
            write_msg(
                &mut stream,
                &ServerMsg::Inbox {
                    items: vec![open_item("approval"), result],
                },
            )
            .unwrap();
            // A continuation is still the same busy turn.
            write_msg(
                &mut stream,
                &ServerMsg::Rpc {
                    seq: 2,
                    frame: frame(
                        serde_json::json!({"type":"agent_end","yielded":false,"isTerminal":false}),
                    )
                    .unwrap(),
                },
            )
            .unwrap();
            write_msg(
                &mut stream,
                &ServerMsg::Rpc {
                    seq: 3,
                    frame: frame(serde_json::json!({"type":"agent_end","isTerminal":true}))
                        .unwrap(),
                },
            )
            .unwrap();
            write_msg(&mut stream, &ServerMsg::Inbox { items: vec![] }).unwrap();
            std::thread::sleep(Duration::from_millis(300));
        });
        let events = Arc::new(Recorder::default());
        let client = Client::start(paths, events.clone());
        let done = eventually(Duration::from_secs(3), || {
            events
                .0
                .lock()
                .unwrap()
                .iter()
                .any(|(name, payload)| {
                    name == "activity" && payload["busy"] == false && payload["hasAsk"] == false
                })
                .then_some(())
        });
        assert!(done.is_some(), "the settled activity never arrived");
        let activity: Vec<Value> = events
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, _)| name == "activity")
            .map(|(_, payload)| payload.clone())
            .collect();
        assert_eq!(
            activity,
            [
                serde_json::json!({"busy": true, "hasAsk": false}),
                serde_json::json!({"busy": true, "hasAsk": true}),
                serde_json::json!({"busy": false, "hasAsk": true}),
                serde_json::json!({"busy": false, "hasAsk": false}),
            ],
            "busy and hasAsk do not follow the relayed turn and inbox"
        );
        drop(client);
        server.join().unwrap();
    }

    /// The service's `status` carries no turn flag, so a new omp session
    /// generation (restart/crash after a relayed `agent_start` whose end
    /// frame never came) must clear the chip's `busy` instead of leaving it
    /// claimed for a process that no longer exists.
    #[test]
    fn client_resets_busy_on_a_new_session_generation() {
        let temp = TempDir::new("pc", "gen");
        let paths = test_paths(&temp, "gen");
        ensure_private_dir(&paths.persona).unwrap();
        let listener = ListenerOptions::new()
            .name(socket_name(&paths).unwrap())
            .create_sync()
            .unwrap();
        let server = std::thread::spawn(move || {
            let mut stream = listener.accept().unwrap();
            let _hello = read_client(stream.try_clone().unwrap());
            write_msg(&mut stream, &ServerMsg::Hello { protocol: 1 }).unwrap();
            write_msg(
                &mut stream,
                &ServerMsg::Status {
                    status: daytime_status(),
                },
            )
            .unwrap();
            write_msg(&mut stream, &ServerMsg::Inbox { items: vec![] }).unwrap();
            let frame = |value: Value| serde_json::value::RawValue::from_string(value.to_string());
            write_msg(
                &mut stream,
                &ServerMsg::Rpc {
                    seq: 1,
                    frame: frame(serde_json::json!({"type":"agent_start"})).unwrap(),
                },
            )
            .unwrap();
            std::thread::sleep(Duration::from_millis(100));
            let mut next = daytime_status();
            next.generation = 8;
            write_msg(&mut stream, &ServerMsg::Status { status: next }).unwrap();
            std::thread::sleep(Duration::from_millis(300));
        });
        let events = Arc::new(Recorder::default());
        let client = Client::start(paths, events.clone());
        let observed = eventually(Duration::from_secs(3), || {
            let events = events.0.lock().unwrap();
            let busy = events
                .iter()
                .position(|(name, payload)| name == "activity" && payload["busy"] == true)?;
            let reset = events
                .iter()
                .position(|(name, payload)| name == "activity" && payload["busy"] == false)?;
            let status = events
                .iter()
                .position(|(name, payload)| name == "status" && payload["generation"] == 8)?;
            drop(events);
            // The reset must precede the new generation's status: a later
            // reset would only be the disconnect at the end of the test.
            (busy < reset && reset < status).then_some(())
        });
        assert!(
            observed.is_some(),
            "busy survived the new session generation: {:?}",
            events.0.lock().unwrap()
        );
        drop(client);
        server.join().unwrap();
    }

    /// `busy` is only known while the relay is attached: a detach request
    /// stops the frame stream, so the chip must drop the stale turn state.
    #[test]
    fn client_resets_busy_when_the_relay_is_detached() {
        let temp = TempDir::new("pc", "det");
        let paths = test_paths(&temp, "det");
        ensure_private_dir(&paths.persona).unwrap();
        let listener = ListenerOptions::new()
            .name(socket_name(&paths).unwrap())
            .create_sync()
            .unwrap();
        let server = std::thread::spawn(move || {
            let mut stream = listener.accept().unwrap();
            let _hello = read_client(stream.try_clone().unwrap());
            write_msg(&mut stream, &ServerMsg::Hello { protocol: 1 }).unwrap();
            write_msg(
                &mut stream,
                &ServerMsg::Status {
                    status: daytime_status(),
                },
            )
            .unwrap();
            write_msg(&mut stream, &ServerMsg::Inbox { items: vec![] }).unwrap();
            let frame = |value: Value| serde_json::value::RawValue::from_string(value.to_string());
            write_msg(
                &mut stream,
                &ServerMsg::Rpc {
                    seq: 1,
                    frame: frame(serde_json::json!({"type":"agent_start"})).unwrap(),
                },
            )
            .unwrap();
            let request = read_client(stream.try_clone().unwrap());
            assert!(
                matches!(&request.body, ClientMsg::Detach),
                "expected the detach request"
            );
            write_msg(
                &mut stream,
                &ServerMsg::Reply {
                    req: request.req.expect("detach carries a req"),
                    ok: true,
                    data: None,
                    error: None,
                },
            )
            .unwrap();
            // Same generation: the reset must come from the detach itself,
            // not from a generation change or the disconnect below.
            write_msg(
                &mut stream,
                &ServerMsg::Status {
                    status: daytime_status(),
                },
            )
            .unwrap();
            std::thread::sleep(Duration::from_millis(300));
        });
        let events = Arc::new(Recorder::default());
        let client = Client::start(paths, events.clone());
        let busy = eventually(Duration::from_secs(3), || {
            events
                .0
                .lock()
                .unwrap()
                .iter()
                .any(|(name, payload)| name == "activity" && payload["busy"] == true)
                .then_some(())
        });
        assert!(busy.is_some(), "the relayed turn never reported busy");
        client
            .handle()
            .request(ClientMsg::Detach)
            .expect("the detach is answered");
        let observed = eventually(Duration::from_secs(3), || {
            let events = events.0.lock().unwrap();
            let reset = events
                .iter()
                .position(|(name, payload)| name == "activity" && payload["busy"] == false)?;
            let statuses: Vec<usize> = events
                .iter()
                .enumerate()
                .filter(|(_, (name, _))| name == "status")
                .map(|(index, _)| index)
                .collect();
            let marker = *statuses.get(1)?;
            drop(events);
            (reset < marker).then_some(())
        });
        assert!(
            observed.is_some(),
            "busy survived the detach: {:?}",
            events.0.lock().unwrap()
        );
        drop(client);
        server.join().unwrap();
    }

    /// Clear `busy` on the detach reply, not when the request is written: the
    /// service has not stopped relaying yet at send time, so a frame can be
    /// followed by more frames until its ordered acknowledgement. The marker
    /// status is emitted before the reply; a reset before that marker would
    /// be the old send-time clear.
    #[test]
    fn client_keeps_busy_until_the_detach_reply_arrives() {
        let (_temp, events, client, server) = relay_client("det-ack", |stream| {
            let request = read_client(stream.try_clone().unwrap());
            assert!(
                matches!(&request.body, ClientMsg::Detach),
                "expected the detach request"
            );
            // The detach is in flight: still busy, no reset yet.
            write_msg(
                stream,
                &ServerMsg::Status {
                    status: daytime_status(),
                },
            )
            .unwrap();
            std::thread::sleep(Duration::from_millis(100));
            write_msg(
                stream,
                &ServerMsg::Reply {
                    req: request.req.expect("detach carries a req"),
                    ok: true,
                    data: None,
                    error: None,
                },
            )
            .unwrap();
            std::thread::sleep(Duration::from_millis(300));
        });
        client
            .handle()
            .request(ClientMsg::Detach)
            .expect("the detach is answered");
        let ordered = eventually(Duration::from_secs(3), || {
            let events = events.0.lock().unwrap();
            let reset = events
                .iter()
                .position(|(name, payload)| name == "activity" && payload["busy"] == false)?;
            let marker = nth_event(&events, "status", 1)?;
            drop(events);
            (reset > marker).then_some(())
        });
        assert!(
            ordered.is_some(),
            "busy was cleared before the detach reply: {:?}",
            events.0.lock().unwrap()
        );
        drop(client);
        server.join().unwrap();
    }

    /// Frames relayed after the detach was requested — one queued before the
    /// service processed the detach, one straggling after its reply — belong
    /// to a stream that is stopping. Dropping them keeps the stale
    /// `agent_start` from re-setting `busy` and from reaching the webview.
    #[test]
    fn client_drops_relay_frames_after_the_detach_request() {
        let (_temp, events, client, server) = relay_client("det-stale", |stream| {
            let request = read_client(stream.try_clone().unwrap());
            assert!(
                matches!(&request.body, ClientMsg::Detach),
                "expected the detach request"
            );
            // Relay frames the service had already queued when the detach
            // arrived, before its acknowledgement.
            write_msg(
                stream,
                &ServerMsg::Rpc {
                    seq: 2,
                    frame: raw_frame(AGENT_START),
                },
            )
            .unwrap();
            write_msg(
                stream,
                &ServerMsg::Reply {
                    req: request.req.expect("detach carries a req"),
                    ok: true,
                    data: None,
                    error: None,
                },
            )
            .unwrap();
            // A straggler after the reply must not revive the relay either.
            write_msg(
                stream,
                &ServerMsg::Rpc {
                    seq: 3,
                    frame: raw_frame(AGENT_START),
                },
            )
            .unwrap();
            // Marker for "the reply was processed".
            write_msg(
                stream,
                &ServerMsg::Status {
                    status: daytime_status(),
                },
            )
            .unwrap();
            std::thread::sleep(Duration::from_millis(300));
        });
        client
            .handle()
            .request(ClientMsg::Detach)
            .expect("the detach is answered");
        let settled = eventually(Duration::from_secs(3), || {
            let events = events.0.lock().unwrap();
            let reset = events
                .iter()
                .position(|(name, payload)| name == "activity" && payload["busy"] == false)?;
            let marker = nth_event(&events, "status", 1)?;
            drop(events);
            (reset < marker).then_some(())
        });
        assert!(
            settled.is_some(),
            "the detach reply never settled the chip: {:?}",
            events.0.lock().unwrap()
        );
        let (lines, activity) = {
            let events = events.0.lock().unwrap();
            let lines: Vec<Value> = events
                .iter()
                .filter(|(name, _)| name == "line")
                .map(|(_, payload)| payload.clone())
                .collect();
            let activity: Vec<bool> = events
                .iter()
                .filter(|(name, _)| name == "activity")
                .map(|(_, payload)| payload["busy"].as_bool().unwrap())
                .collect();
            drop(events);
            (lines, activity)
        };
        assert_eq!(
            lines
                .iter()
                .map(|payload| payload["seq"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            [1],
            "frames relayed after the detach request reached the webview"
        );
        assert_eq!(
            activity,
            [true, false],
            "a stale frame re-set busy after the detach"
        );
        drop(client);
        server.join().unwrap();
    }

    /// A later attach re-opens the relay: the mute installed by a detach must
    /// not swallow the next session's frames.
    #[test]
    fn client_resumes_relay_frames_after_attach() {
        let (_temp, events, client, server) = relay_client("det-reattach", |stream| {
            let detach = read_client(stream.try_clone().unwrap());
            assert!(
                matches!(&detach.body, ClientMsg::Detach),
                "expected the detach request"
            );
            write_msg(
                stream,
                &ServerMsg::Reply {
                    req: detach.req.expect("detach carries a req"),
                    ok: true,
                    data: None,
                    error: None,
                },
            )
            .unwrap();
            let attach = read_client(stream.try_clone().unwrap());
            assert!(
                matches!(&attach.body, ClientMsg::Attach { .. }),
                "expected the attach request"
            );
            write_msg(
                stream,
                &ServerMsg::Reply {
                    req: attach.req.expect("attach carries a req"),
                    ok: true,
                    data: None,
                    error: None,
                },
            )
            .unwrap();
            write_msg(
                stream,
                &ServerMsg::Rpc {
                    seq: 2,
                    frame: raw_frame(AGENT_START),
                },
            )
            .unwrap();
            std::thread::sleep(Duration::from_millis(300));
        });
        client
            .handle()
            .request(ClientMsg::Detach)
            .expect("the detach is answered");
        client
            .handle()
            .request(ClientMsg::Attach { after_seq: 0 })
            .expect("the attach is answered");
        let resumed = eventually(Duration::from_secs(3), || {
            let events = events.0.lock().unwrap();
            events
                .iter()
                .any(|(name, payload)| name == "line" && payload["seq"].as_u64() == Some(2))
                .then_some(())
        });
        assert!(
            resumed.is_some(),
            "the relay stayed muted after attach: {:?}",
            events.0.lock().unwrap()
        );
        drop(client);
        server.join().unwrap();
    }

    #[test]
    fn client_replaces_unparseable_relay_frames() {
        const UNPARSED: &str = r#"{"type":"message","value":1e400}"#;
        let (_temp, events, client, server) = relay_client("det-unparsed", |stream| {
            write_msg(
                stream,
                &ServerMsg::Rpc {
                    seq: 2,
                    frame: raw_frame(UNPARSED),
                },
            )
            .unwrap();
            std::thread::sleep(Duration::from_millis(300));
        });
        let observed = eventually(Duration::from_secs(3), || {
            let events = events.0.lock().unwrap();
            events
                .iter()
                .find(|(name, payload)| name == "line" && payload["seq"] == 2)
                .map(|(_, payload)| payload["text"].as_str().unwrap().to_owned())
        });
        assert_eq!(
            observed.as_deref(),
            Some(
                format!(
                    r#"{{"type":"desktop_unparsed_line","bytes":{}}}"#,
                    UNPARSED.len()
                )
                .as_str()
            )
        );
        drop(client);
        server.join().unwrap();
    }

    #[test]
    fn client_pushes_each_new_open_item_once_per_run() {
        let temp = TempDir::new("persona-client", "push");
        let paths = test_paths(&temp, "push");
        ensure_private_dir(&paths.persona).unwrap();
        let listener = ListenerOptions::new()
            .name(socket_name(&paths).unwrap())
            .create_sync()
            .unwrap();
        let server = std::thread::spawn(move || {
            // First connection: one open item, then the service goes away.
            let mut first = listener.accept().unwrap();
            let _hello = read_client(first.try_clone().unwrap());
            write_msg(&mut first, &ServerMsg::Hello { protocol: 1 }).unwrap();
            write_msg(
                &mut first,
                &ServerMsg::Status {
                    status: daytime_status(),
                },
            )
            .unwrap();
            write_msg(
                &mut first,
                &ServerMsg::Inbox {
                    items: vec![open_item("a")],
                },
            )
            .unwrap();
            std::thread::sleep(Duration::from_millis(100));
            drop(first);

            // Reconnect: the service replays "a" plus a second open item.
            let mut second = listener.accept().unwrap();
            let _hello = read_client(second.try_clone().unwrap());
            write_msg(&mut second, &ServerMsg::Hello { protocol: 1 }).unwrap();
            write_msg(
                &mut second,
                &ServerMsg::Status {
                    status: daytime_status(),
                },
            )
            .unwrap();
            write_msg(
                &mut second,
                &ServerMsg::Inbox {
                    items: vec![open_item("a"), open_item("b")],
                },
            )
            .unwrap();
            std::thread::sleep(Duration::from_millis(300));
        });
        let events = Arc::new(Recorder::default());
        let recorder: Arc<Recorder> = Arc::clone(&events);
        let emitter: Arc<dyn Emitter> = recorder;
        let client = Client::start(paths, emitter);
        let inboxes = eventually(Duration::from_secs(5), || {
            let events = events.0.lock().unwrap();
            (events.iter().filter(|(name, _)| name == "inbox").count() == 2).then_some(())
        });
        assert!(inboxes.is_some(), "both inbox snapshots arrived");
        let both_pushed = eventually(Duration::from_secs(5), || {
            let events = events.0.lock().unwrap();
            (events.iter().filter(|(name, _)| name == "push").count() >= 2).then_some(())
        });
        assert!(both_pushed.is_some(), "both new items were pushed");
        std::thread::sleep(Duration::from_millis(200));
        let push_payloads: Vec<Value> = events
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, _)| name == "push")
            .map(|(_, payload)| payload.clone())
            .collect();
        assert_eq!(
            push_payloads,
            [
                serde_json::json!({"title": "title a", "urgent": false}),
                serde_json::json!({"title": "title b", "urgent": false}),
            ],
            "the replayed open item is not pushed twice"
        );
        drop(client);
        server.join().unwrap();
    }

    #[test]
    fn client_backoff_caps_at_5s() {
        assert_eq!(
            next_backoff(Duration::from_millis(500)),
            Duration::from_secs(1)
        );
        assert_eq!(next_backoff(Duration::from_secs(4)), Duration::from_secs(5));
        assert_eq!(next_backoff(Duration::from_secs(5)), Duration::from_secs(5));
    }

    #[test]
    fn client_routes_request_reply_by_req_id() {
        let temp = TempDir::new("persona-client", "request");
        let paths = test_paths(&temp, "request");
        ensure_private_dir(&paths.persona).unwrap();
        let listener = ListenerOptions::new()
            .name(socket_name(&paths).unwrap())
            .create_sync()
            .unwrap();
        let server = std::thread::spawn(move || {
            let mut stream = listener.accept().unwrap();
            let hello = read_client(stream.try_clone().unwrap());
            assert!(matches!(hello.body, ClientMsg::Hello { .. }));
            write_msg(&mut stream, &ServerMsg::Hello { protocol: 1 }).unwrap();
            write_msg(&mut stream, &ServerMsg::Status { status: status() }).unwrap();

            let request = read_client(stream.try_clone().unwrap());
            assert_eq!(request.req, Some(1));
            assert!(matches!(request.body, ClientMsg::Rpc { .. }));
            write_msg(
                &mut stream,
                &ServerMsg::Reply {
                    req: 1,
                    ok: true,
                    data: Some(serde_json::json!({"accepted": true})),
                    error: None,
                },
            )
            .unwrap();
            std::thread::sleep(Duration::from_millis(200));
        });
        let events = Arc::new(Recorder::default());
        let client = Client::start(paths, events);
        assert!(eventually(Duration::from_secs(2), || { client.status().map(|_| ()) }).is_some());
        // Through the handle a command hands to `off_ipc`: same worker, and
        // dropping the handle must not shut the client down.
        let handle = client.handle();
        handle
            .request(ClientMsg::Rpc {
                frame: serde_json::json!({"type":"prompt","message":"hi"}),
            })
            .unwrap();
        drop(handle);
        assert_eq!(client.status().unwrap().generation, 7);
        drop(client);
        server.join().unwrap();
    }

    #[test]
    fn protocol_mismatch_stops_retry() {
        let temp = TempDir::new("persona-client", "protocol");
        let paths = test_paths(&temp, "protocol");
        ensure_private_dir(&paths.persona).unwrap();
        let listener = ListenerOptions::new()
            .name(socket_name(&paths).unwrap())
            .nonblocking(ListenerNonblockingMode::Accept)
            .create_sync()
            .unwrap();
        let server = std::thread::spawn(move || {
            let mut stream = loop {
                match listener.accept() {
                    Ok(conn) => break conn,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(e) => panic!("accept failed: {e}"),
                }
            };
            let _hello = read_client(stream.try_clone().unwrap());
            write_msg(
                &mut stream,
                &ServerMsg::Reply {
                    req: 0,
                    ok: false,
                    data: None,
                    error: Some("protocol 1 required".into()),
                },
            )
            .unwrap();
            drop(stream);
            let deadline = std::time::Instant::now() + Duration::from_millis(700);
            while std::time::Instant::now() < deadline {
                if listener.accept().is_ok() {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            false
        });
        let events = Arc::new(Recorder::default());
        let client = Client::start(paths, events.clone());
        let protocol_error = eventually(Duration::from_secs(2), || {
            events
                .0
                .lock()
                .unwrap()
                .iter()
                .any(|(name, payload)| name == "error" && payload["kind"] == "protocol")
                .then_some(())
        });
        assert!(protocol_error.is_some());
        assert_eq!(client.errors().connection.unwrap().kind, "protocol");
        assert!(
            !server.join().unwrap(),
            "client retried after protocol mismatch"
        );
        drop(client);
    }

    #[test]
    fn admission_refusal_backs_off_and_reconnects() {
        let temp = TempDir::new("persona-client", "admission");
        let paths = test_paths(&temp, "admission");
        ensure_private_dir(&paths.persona).unwrap();
        let listener = ListenerOptions::new()
            .name(socket_name(&paths).unwrap())
            .nonblocking(ListenerNonblockingMode::Accept)
            .create_sync()
            .unwrap();
        let server = std::thread::spawn(move || {
            let mut first = loop {
                match listener.accept() {
                    Ok(conn) => break conn,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(e) => panic!("accept failed: {e}"),
                }
            };
            first.set_nonblocking(false).unwrap();
            let _hello = read_client(first.try_clone().unwrap());
            write_msg(
                &mut first,
                &ServerMsg::Reply {
                    req: 0,
                    ok: false,
                    data: None,
                    error: Some("too many connections".into()),
                },
            )
            .unwrap();
            drop(first);

            let deadline = std::time::Instant::now() + Duration::from_secs(4);
            let mut second = loop {
                match listener.accept() {
                    Ok(conn) => break conn,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        if std::time::Instant::now() >= deadline {
                            return false;
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(e) => panic!("accept failed: {e}"),
                }
            };
            second.set_nonblocking(false).unwrap();
            let _hello = read_client(second.try_clone().unwrap());
            write_msg(&mut second, &ServerMsg::Hello { protocol: 1 }).unwrap();
            write_msg(&mut second, &ServerMsg::Status { status: status() }).unwrap();
            std::thread::sleep(Duration::from_millis(100));
            true
        });
        let events = Arc::new(Recorder::default());
        let client = Client::start(paths, events);
        let reconnected = eventually(Duration::from_secs(3), || client.status().map(|_| ()));
        assert!(server.join().unwrap(), "no connection followed admission");
        assert!(reconnected.is_some(), "admission refusal stopped retries");
        assert!(client.errors().connection.is_none());
        drop(client);
    }

    #[test]
    fn successful_status_clears_the_cached_terminal_error() {
        let temp = TempDir::new("persona-client", "snap");
        let paths = test_paths(&temp, "snap");
        ensure_private_dir(&paths.persona).unwrap();
        let listener = ListenerOptions::new()
            .name(socket_name(&paths).unwrap())
            .create_sync()
            .unwrap();
        let server = std::thread::spawn(move || {
            let mut first = listener.accept().unwrap();
            let _hello = read_client(first.try_clone().unwrap());
            write_msg(&mut first, &ServerMsg::Hello { protocol: 2 }).unwrap();
            drop(first);

            let mut second = listener.accept().unwrap();
            let _hello = read_client(second.try_clone().unwrap());
            write_msg(&mut second, &ServerMsg::Hello { protocol: 1 }).unwrap();
            write_msg(&mut second, &ServerMsg::Status { status: status() }).unwrap();
            std::thread::sleep(Duration::from_millis(200));
        });
        let events = Arc::new(Recorder::default());
        let client = Client::start(paths, events);
        assert!(eventually(Duration::from_secs(2), || {
            client.errors().connection.map(|error| error.kind)
        })
        .is_some());
        client.handle().reconnect().unwrap();
        assert!(eventually(Duration::from_secs(2), || { client.status().map(|_| ()) }).is_some());
        assert!(client.errors().connection.is_none());
        drop(client);
        server.join().unwrap();
    }

    #[test]
    fn a_refresh_failure_survives_a_status_and_an_io_outage() {
        let temp = TempDir::new("persona-client", "keep");
        let paths = test_paths(&temp, "keep");
        ensure_private_dir(&paths.persona).unwrap();
        let listener = ListenerOptions::new()
            .name(socket_name(&paths).unwrap())
            .create_sync()
            .unwrap();
        let server = std::thread::spawn(move || {
            // First connection: a status, then the service goes away.
            let mut first = listener.accept().unwrap();
            let _hello = read_client(first.try_clone().unwrap());
            write_msg(&mut first, &ServerMsg::Hello { protocol: 1 }).unwrap();
            write_msg(&mut first, &ServerMsg::Status { status: status() }).unwrap();
            std::thread::sleep(Duration::from_millis(300));
            drop(first);
            // Second connection: the reconnect's status must not clear the
            // refresh warning either.
            let mut second = listener.accept().unwrap();
            let _hello = read_client(second.try_clone().unwrap());
            write_msg(&mut second, &ServerMsg::Hello { protocol: 1 }).unwrap();
            write_msg(&mut second, &ServerMsg::Status { status: status() }).unwrap();
            std::thread::sleep(Duration::from_millis(300));
        });
        let events = Arc::new(Recorder::default());
        let client = Client::start(paths, events.clone());
        assert!(
            eventually(Duration::from_secs(2), || client.status().map(|_| ())).is_some(),
            "the first status never arrived"
        );
        client
            .handle()
            .report_refresh_error("cannot replace the service");
        assert!(
            eventually(Duration::from_secs(2), || client
                .errors()
                .refresh
                .map(|error| error.kind))
            .is_some(),
            "the refresh failure was not cached"
        );
        assert!(
            events
                .0
                .lock()
                .unwrap()
                .iter()
                .any(|(name, payload)| name == "error" && payload["kind"] == "refresh"),
            "the refresh failure was not emitted"
        );
        // The service going away is one io outage; its `persona://error`
        // event does not touch the refresh warning, and neither does the
        // snapshot reset the disconnect performs.
        assert!(
            eventually(Duration::from_secs(5), || client
                .status()
                .is_none()
                .then_some(()))
            .is_some(),
            "the service outage was not noticed"
        );
        assert!(
            events
                .0
                .lock()
                .unwrap()
                .iter()
                .any(|(name, payload)| name == "error" && payload["kind"] == "io"),
            "the io outage was not emitted"
        );
        assert_eq!(
            client.errors().refresh.unwrap().message,
            "cannot replace the service",
            "the io outage cleared the refresh warning"
        );
        // The reconnect's status clears the connection error only.
        assert!(
            eventually(Duration::from_secs(5), || {
                let errors = client.errors();
                (errors.connection.is_none() && client.status().is_some()).then_some(())
            })
            .is_some(),
            "the reconnect did not report a status"
        );
        assert_eq!(
            client.errors().refresh.unwrap().message,
            "cannot replace the service",
            "a status cleared the refresh warning"
        );
        drop(client);
        server.join().unwrap();
    }

    #[test]
    fn a_successful_refresh_clears_the_cached_warning_and_emits_it() {
        let temp = TempDir::new("persona-client", "refresh-cleared");
        let paths = test_paths(&temp, "refresh-cleared");
        ensure_private_dir(&paths.persona).unwrap();
        let events = Arc::new(Recorder::default());
        let client = Client::start(paths, events.clone());
        client
            .handle()
            .report_refresh_error("cannot replace the service");
        assert!(
            eventually(Duration::from_secs(2), || client.errors().refresh).is_some(),
            "the refresh failure was not cached"
        );
        client.handle().clear_refresh_error();
        assert!(
            eventually(Duration::from_secs(2), || client
                .errors()
                .refresh
                .is_none()
                .then_some(()))
            .is_some(),
            "a successful refresh left the warning cached"
        );
        // The snapshot alone only reaches a UI that reloads; the cleared
        // event is what drops a warning the mounted strip already shows.
        assert!(
            events
                .0
                .lock()
                .unwrap()
                .iter()
                .any(|(name, payload)| name == "cleared" && payload["kind"] == "refresh"),
            "the cleared refresh warning was not emitted"
        );
    }

    #[test]
    fn client_redacts_credentials_in_relayed_frames() {
        let temp = TempDir::new("persona-client", "redact");
        let paths = test_paths(&temp, "redact");
        ensure_private_dir(&paths.persona).unwrap();
        let listener = ListenerOptions::new()
            .name(socket_name(&paths).unwrap())
            .create_sync()
            .unwrap();
        let server = std::thread::spawn(move || {
            let mut stream = listener.accept().unwrap();
            let _hello = read_client(stream.try_clone().unwrap());
            write_msg(&mut stream, &ServerMsg::Hello { protocol: 1 }).unwrap();
            let frame = serde_json::value::RawValue::from_string(
                r#"{"type":"tool","authorization":"Bearer sekret","apiKey":"sk-live-1","safe":"ok"}"#
                    .into(),
            )
            .unwrap();
            write_msg(&mut stream, &ServerMsg::Rpc { seq: 9, frame }).unwrap();
            std::thread::sleep(Duration::from_millis(200));
        });
        let events = Arc::new(Recorder::default());
        let client = Client::start(paths, events.clone());
        let line = eventually(Duration::from_secs(2), || {
            events
                .0
                .lock()
                .unwrap()
                .iter()
                .find(|(name, _)| name == "line")
                .cloned()
        })
        .expect("no persona://line event");
        let text = line.1["text"].as_str().unwrap();
        assert_eq!(line.1["seq"], 9);
        assert!(
            !text.contains("sekret"),
            "authorization value reached the webview: {text}"
        );
        assert!(
            !text.contains("sk-live-1"),
            "apiKey value reached the webview: {text}"
        );
        assert!(
            text.contains(crate::redaction::REDACTED_PLACEHOLDER),
            "no redaction placeholder in {text}"
        );
        assert!(
            text.contains(r#""safe":"ok""#),
            "a harmless field was changed: {text}"
        );
        drop(client);
        server.join().unwrap();
    }

    #[test]
    fn io_error_is_emitted_once_per_outage() {
        let temp = TempDir::new("persona-client", "outage");
        let paths = test_paths(&temp, "outage");
        ensure_private_dir(&paths.persona).unwrap();
        let events = Arc::new(Recorder::default());
        // No listener: every connect attempt fails against a down service.
        let client = Client::start(paths, events.clone());
        let io_errors = || {
            events
                .0
                .lock()
                .unwrap()
                .iter()
                .filter(|(name, payload)| name == "error" && payload["kind"] == "io")
                .count()
        };
        assert!(
            eventually(Duration::from_secs(2), || {
                events
                    .0
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(name, payload)| name == "error" && payload["kind"] == "io")
                    .then_some(())
            })
            .is_some(),
            "the first failure did not report an io error"
        );
        // Retries land at 500 ms and 1500 ms; both must stay silent.
        std::thread::sleep(Duration::from_millis(1800));
        assert_eq!(io_errors(), 1, "one outage reported more than one io error");
        client.handle().reconnect().unwrap();
        assert!(
            eventually(Duration::from_secs(2), || (io_errors() == 2).then_some(())).is_some(),
            "reconnect did not reset the outage error guard"
        );
        drop(client);
    }

    #[test]
    fn a_disabled_service_reports_no_io_error() {
        let temp = TempDir::new("persona-client", "off");
        let paths = test_paths(&temp, "off");
        ensure_private_dir(&paths.persona).unwrap();
        let events = Arc::new(Recorder::default());
        // No listener: every connect attempt fails against a down service.
        let client = Client::start(paths, events.clone());
        let io_errors = || {
            events
                .0
                .lock()
                .unwrap()
                .iter()
                .filter(|(name, payload)| name == "error" && payload["kind"] == "io")
                .count()
        };
        assert!(
            eventually(Duration::from_secs(2), || (io_errors() > 0).then_some(())).is_some(),
            "the first outage was not reported"
        );
        let reported = io_errors();
        // Deliberate Disable: the absence is the expected state.
        client.handle().reconnect_expecting_off().unwrap();
        std::thread::sleep(Duration::from_millis(1800));
        assert_eq!(
            io_errors(),
            reported,
            "a deliberately disabled service was reported as an outage"
        );
        // Enable reconnects normally: a real outage is reported again.
        client.handle().reconnect().unwrap();
        assert!(
            eventually(Duration::from_secs(2), || (io_errors() > reported)
                .then_some(()))
            .is_some(),
            "enabling did not report the next outage"
        );
        drop(client);
    }

    #[cfg(unix)]
    #[test]
    fn reconnect_closes_the_old_connection() {
        let temp = TempDir::new("persona-client", "reconnect");
        let paths = test_paths(&temp, "reconnect");
        ensure_private_dir(&paths.persona).unwrap();
        let listener = ListenerOptions::new()
            .name(socket_name(&paths).unwrap())
            .create_sync()
            .unwrap();
        let (closed_tx, closed_rx) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let mut first = listener.accept().unwrap();
            let _hello = read_client(first.try_clone().unwrap());
            write_msg(&mut first, &ServerMsg::Hello { protocol: 1 }).unwrap();
            write_msg(&mut first, &ServerMsg::Status { status: status() }).unwrap();
            // A reconnect must close this socket (EOF), not leave it open and
            // the service holding its connection slot.
            let mut reader = BufReader::new(first);
            let mut buf = Vec::new();
            let closed = matches!(
                read_line_capped(&mut reader, &mut buf).unwrap(),
                LineRead::Eof
            );
            let _ = closed_tx.send(closed);
            // Keep the reconnected client connected until the test ends.
            let mut second = listener.accept().unwrap();
            let _hello = read_client(second.try_clone().unwrap());
            write_msg(&mut second, &ServerMsg::Hello { protocol: 1 }).unwrap();
            std::thread::sleep(Duration::from_millis(200));
        });
        let events = Arc::new(Recorder::default());
        let client = Client::start(paths, events);
        assert!(eventually(Duration::from_secs(2), || { client.status().map(|_| ()) }).is_some());
        client.handle().reconnect().unwrap();
        assert!(
            closed_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            "the old connection stayed open after a reconnect"
        );
        drop(client);
        server.join().unwrap();
    }

    #[test]
    fn relay_frame_at_the_payload_limit_is_delivered() {
        let temp = TempDir::new("pc", "rl");
        let paths = test_paths(&temp, "rl");
        ensure_private_dir(&paths.persona).unwrap();
        let listener = ListenerOptions::new()
            .name(socket_name(&paths).unwrap())
            .create_sync()
            .unwrap();
        let server = std::thread::spawn(move || {
            let mut stream = listener.accept().unwrap();
            let _hello = read_client(stream.try_clone().unwrap());
            write_msg(&mut stream, &ServerMsg::Hello { protocol: 1 }).unwrap();
            let prefix = r#"{"type":"message","data":""#;
            let suffix = r#""}"#;
            let text = format!(
                "{prefix}{}{suffix}",
                "x".repeat(MAX_LINE_BYTES - prefix.len() - suffix.len())
            );
            assert_eq!(text.len(), MAX_LINE_BYTES);
            let frame = serde_json::value::RawValue::from_string(text).unwrap();
            write_msg(
                &mut stream,
                &ServerMsg::Rpc {
                    seq: u64::MAX,
                    frame,
                },
            )
            .unwrap();
            std::thread::sleep(Duration::from_millis(200));
        });
        let events = Arc::new(Recorder::default());
        let client = Client::start(paths, events.clone());
        let delivered = eventually(Duration::from_secs(5), || {
            events
                .0
                .lock()
                .unwrap()
                .iter()
                .any(|(name, payload)| name == "line" && payload["seq"] == u64::MAX)
                .then_some(())
        });
        assert!(
            delivered.is_some(),
            "a payload at the protocol limit disconnected the reader"
        );
        let events = events.0.lock().unwrap();
        let line = events
            .iter()
            .find(|(name, _)| name == "line")
            .expect("relay line missing");
        assert_eq!(line.1["text"].as_str().unwrap().len(), MAX_LINE_BYTES);
        drop(events);
        drop(client);
        server.join().unwrap();
    }

    #[test]
    fn oversized_frame_fails_before_the_request_timeout() {
        let temp = TempDir::new("persona-client", "oversize");
        let paths = test_paths(&temp, "oversize");
        ensure_private_dir(&paths.persona).unwrap();
        let listener = ListenerOptions::new()
            .name(socket_name(&paths).unwrap())
            .create_sync()
            .unwrap();
        let server = std::thread::spawn(move || {
            let mut stream = listener.accept().unwrap();
            let _hello = read_client(stream.try_clone().unwrap());
            write_msg(&mut stream, &ServerMsg::Hello { protocol: 1 }).unwrap();
            write_msg(&mut stream, &ServerMsg::Status { status: status() }).unwrap();
            std::thread::sleep(Duration::from_millis(300));
        });
        let events = Arc::new(Recorder::default());
        let client = Client::start(paths, events);
        assert!(eventually(Duration::from_secs(2), || { client.status().map(|_| ()) }).is_some());
        let started = std::time::Instant::now();
        let error = client
            .handle()
            .request(ClientMsg::Rpc {
                frame: Value::String("x".repeat(MAX_LINE_BYTES)),
            })
            .unwrap_err();
        assert!(
            error.contains("the service accepts at most"),
            "unexpected error for an oversized frame: {error}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "an oversized frame waited for the request timeout: {:?}",
            started.elapsed()
        );
        drop(client);
        server.join().unwrap();
    }
}
