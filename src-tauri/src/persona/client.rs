use interprocess::local_socket::{prelude::*, Stream};
use interprocess::TryClone;
use omp_desktop_core::persona_paths::{socket_name, Paths};
use omp_desktop_core::persona_protocol::{
    read_line_capped, write_msg, ClientKind, ClientMsg, Envelope, InboxItem, LineRead, ServerMsg,
    StatusInfo, PROTOCOL,
};
use serde_json::Value;
use std::collections::HashMap;
use std::io::BufReader;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

const INITIAL_BACKOFF: Duration = Duration::from_millis(500);
const MAX_BACKOFF: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) trait Emitter: Send + Sync + 'static {
    fn status(&self, status: Option<&StatusInfo>);
    fn inbox(&self, items: &[InboxItem]);
    fn line(&self, seq: u64, text: &str);
    fn error(&self, kind: &str, message: &str);
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
        #[derive(serde::Serialize, Clone)]
        struct LineEvent<'a> {
            seq: u64,
            text: &'a str,
        }
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
}

#[derive(Default)]
struct Snapshot {
    status: Option<StatusInfo>,
    inbox: Vec<InboxItem>,
}

pub(super) struct Client {
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
            pending: HashMap::new(),
            retry_at: Some(Instant::now()),
            backoff: INITIAL_BACKOFF,
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
        Self { tx, snapshot }
    }

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

    pub(super) fn request(&self, body: ClientMsg) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(WorkerMsg::Request { body, response: tx })
            .map_err(|_| "persona client stopped".to_owned())?;
        match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(error)) => Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => Err("persona request timed out".into()),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err("persona client stopped".into()),
        }
    }

    pub(super) fn reconnect(&self) -> Result<(), String> {
        self.tx
            .send(WorkerMsg::Reconnect)
            .map_err(|_| "persona client stopped".to_owned())
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.tx.send(WorkerMsg::Shutdown);
    }
}

enum WorkerMsg {
    Request {
        body: ClientMsg,
        response: Sender<Result<Value, String>>,
    },
    Reconnect,
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
}

struct Worker {
    paths: Option<Paths>,
    emitter: Arc<dyn Emitter>,
    rx: Receiver<WorkerMsg>,
    tx: Sender<WorkerMsg>,
    snapshot: Arc<Mutex<Snapshot>>,
    connection: Option<Connection>,
    next_connection: u64,
    next_req: u64,
    pending: HashMap<u64, (Sender<Result<Value, String>>, Instant)>,
    retry_at: Option<Instant>,
    backoff: Duration,
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
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            };
            match received {
                WorkerMsg::Shutdown => {
                    self.fail_pending("persona client stopped");
                    return;
                }
                WorkerMsg::Reconnect => {
                    self.stopped = false;
                    self.backoff = INITIAL_BACKOFF;
                    self.disconnect(None);
                    self.retry_at = Some(Instant::now());
                }
                WorkerMsg::Request { body, response } => self.request(body, response),
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
        let req = self.next_req;
        self.next_req += 1;
        let mut writer = &connection.writer;
        if let Err(error) = write_msg(
            &mut writer,
            &Envelope {
                req: Some(req),
                body,
            },
        ) {
            let _ = response.send(Err(format!("cannot write to persona service: {error}")));
            self.disconnect(Some(("io", error.to_string())));
            return;
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
                self.snapshot
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .status = Some(status.clone()); // event and cached snapshot each own a copy
                self.emitter.status(Some(&status));
            }
            ServerMsg::Inbox { items } => {
                self.snapshot
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .inbox
                    .clone_from(&items); // event and cached snapshot each own a copy
                self.emitter.inbox(&items);
            }
            ServerMsg::Rpc { seq, frame } => self.emitter.line(seq, frame.get()),
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
        self.connection.take();
        self.fail_pending("persona service disconnected");
        {
            let mut snapshot = self.snapshot.lock().unwrap_or_else(PoisonError::into_inner);
            snapshot.status = None;
            snapshot.inbox.clear();
        }
        self.emitter.status(None);
        self.emitter.inbox(&[]);
        if let Some((kind, message)) = error {
            self.emitter.error(kind, &message);
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
    let stream = Stream::connect(socket_name(paths)?)?;
    #[cfg(windows)]
    match omp_desktop_core::persona_pipe_security::probe_is_ours(&stream) {
        Ok(true) => {}
        Ok(false) => {
            return Err(ConnectError::Terminal {
                kind: "owner",
                message: "another account owns the persona pipe".into(),
            });
        }
        Err(error) => {
            return Err(ConnectError::Terminal {
                kind: "owner",
                message: format!("cannot verify the persona pipe owner: {error}"),
            });
        }
    }
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
    std::thread::Builder::new()
        .name("persona-reader".into())
        .spawn(move || read_server(id, reader, reader_tx))?;
    Ok(Connection { id, writer })
}

fn read_server(id: u64, mut reader: BufReader<Stream>, tx: Sender<WorkerMsg>) {
    let mut buf = Vec::new();
    let reason = loop {
        match read_line_capped(&mut reader, &mut buf) {
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

#[cfg(test)]
mod tests {
    use super::{next_backoff, Client, Emitter};
    use crate::test_support::{eventually, TempDir};
    use interprocess::local_socket::{prelude::*, ListenerNonblockingMode, ListenerOptions};
    use interprocess::TryClone;
    use omp_desktop_core::persona_paths::{ensure_private_dir, socket_name, Paths};
    use omp_desktop_core::persona_protocol::{
        read_line_capped, write_msg, ClientMsg, Envelope, LineRead, PersonaSettings, ServerMsg,
        StatusInfo,
    };
    use serde_json::Value;
    use std::io::BufReader;
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

    fn read_client<R: std::io::Read>(stream: R) -> Envelope<ClientMsg> {
        let mut reader = BufReader::new(stream);
        let mut buf = Vec::new();
        assert_eq!(
            read_line_capped(&mut reader, &mut buf).unwrap(),
            LineRead::Line
        );
        serde_json::from_slice(&buf).unwrap()
    }

    #[test]
    fn client_connects_and_emits_status() {
        let temp = TempDir::new("persona-client", "connect");
        let paths = Paths::under(temp.path());
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
        let paths = Paths::under(temp.path());
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
        client
            .request(ClientMsg::Rpc {
                frame: serde_json::json!({"type":"prompt","message":"hi"}),
            })
            .unwrap();
        drop(client);
        server.join().unwrap();
    }

    #[test]
    fn protocol_mismatch_stops_retry() {
        let temp = TempDir::new("persona-client", "protocol");
        let paths = Paths::under(temp.path());
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
        assert!(
            !server.join().unwrap(),
            "client retried after protocol mismatch"
        );
        drop(client);
    }
}
