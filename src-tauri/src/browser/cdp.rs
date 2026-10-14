//! A small Chrome `DevTools` Protocol client over one WebSocket.
//!
//! One reader thread per connection owns reading and dispatches both
//! responses (to the waiting [`CdpClient::call`]) and events (to the handler
//! given to [`CdpClient::connect`]). Writers take the socket mutex one at a
//! time. The reader waits for data with `peek` on a second handle, without
//! the mutex, so a writer never queues behind a blocked read; only the
//! non-blocking drain of what arrived runs under it.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::{json, Value};
use tungstenite::error::Error as WsError;
use tungstenite::{Message, WebSocket};

/// How long [`CdpClient::call`] waits for the response.
const CALL_TIMEOUT: Duration = Duration::from_secs(10);
/// How often the idle reader looks at the shutdown flag.
const POLL: Duration = Duration::from_millis(100);
/// Connect, handshake and write deadline.
const IO_TIMEOUT: Duration = Duration::from_secs(10);

/// Delivered to the event handler (without a session) once when the
/// connection ends without [`CdpClient::close`] having been called.
pub const DISCONNECTED: &str = "CDP.disconnected";

/// Handler of events: session id, method, params. Runs on the reader
/// thread, so it must be quick and must not [`call`](CdpClient::call) (the
/// response could only be read by the thread that is waiting for it);
/// [`notify`](CdpClient::notify) is fine.
pub type EventHandler = Box<dyn Fn(Option<&str>, &str, &Value) + Send>;

type Waiters = Mutex<HashMap<u64, Sender<Result<Value, String>>>>;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

struct Shared {
    ws: Mutex<WebSocket<TcpStream>>,
    waiters: Waiters,
    next_id: AtomicU64,
    closed: AtomicBool,
}

pub struct CdpClient {
    shared: Arc<Shared>,
    /// For `shutdown`, which wakes a reader blocked in `peek`.
    stream: TcpStream,
    reader: Mutex<Option<JoinHandle<()>>>,
}

impl CdpClient {
    /// Connect to a `ws://` `DevTools` URL on this machine.
    pub fn connect(ws_url: &str, on_event: EventHandler) -> Result<Self, String> {
        let authority = ws_url
            .strip_prefix("ws://")
            .map(|rest| rest.split('/').next().unwrap_or(rest))
            .ok_or("only ws:// DevTools URLs are supported")?;
        let addr = authority
            .to_socket_addrs()
            .map_err(|e| format!("cdp address {authority}: {e}"))?
            .find(|a| a.ip().is_loopback())
            .ok_or_else(|| format!("cdp address {authority} is not on this machine"))?;
        let stream = TcpStream::connect_timeout(&addr, IO_TIMEOUT)
            .map_err(|e| format!("cdp connect: {e}"))?;
        let setup = |e: std::io::Error| format!("cdp socket: {e}");
        stream.set_nodelay(true).map_err(setup)?;
        stream.set_read_timeout(Some(IO_TIMEOUT)).map_err(setup)?;
        stream.set_write_timeout(Some(IO_TIMEOUT)).map_err(setup)?;
        let peek = stream.try_clone().map_err(setup)?;
        let control = stream.try_clone().map_err(setup)?;
        let (ws, _) =
            tungstenite::client(ws_url, stream).map_err(|e| format!("cdp handshake: {e}"))?;
        peek.set_read_timeout(Some(POLL)).map_err(setup)?;
        let shared = Arc::new(Shared {
            ws: Mutex::new(ws),
            waiters: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
        });
        let reader_shared = Arc::clone(&shared);
        let reader = thread::Builder::new()
            .name("cdp-reader".into())
            .spawn(move || read_loop(&reader_shared, &peek, &on_event))
            .map_err(|e| format!("cdp reader thread: {e}"))?;
        Ok(Self {
            shared,
            stream: control,
            reader: Mutex::new(Some(reader)),
        })
    }

    /// Send a command and wait up to 10 s for its response.
    pub fn call(
        &self,
        session: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        lock(&self.shared.waiters).insert(id, tx);
        // The reader sets `closed` before it fails the waiters, so either it
        // sees this entry or we see the flag.
        if self.shared.closed.load(Ordering::SeqCst) {
            lock(&self.shared.waiters).remove(&id);
            return Err("cdp connection closed".into());
        }
        if let Err(e) = self.send(id, session, method, params) {
            lock(&self.shared.waiters).remove(&id);
            return Err(e);
        }
        match rx.recv_timeout(CALL_TIMEOUT) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => {
                lock(&self.shared.waiters).remove(&id);
                Err(format!("cdp {method}: timed out"))
            }
            Err(RecvTimeoutError::Disconnected) => Err("cdp connection closed".into()),
        }
    }

    /// Send a command without waiting for the response (it is discarded).
    /// For the event handler, which must not block on the reader.
    pub fn notify(&self, session: Option<&str>, method: &str, params: Value) {
        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        let _ = self.send(id, session, method, params);
    }

    fn send(
        &self,
        id: u64,
        session: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<(), String> {
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = Value::from(session);
        }
        let text = message.to_string();
        lock(&self.shared.ws)
            .send(Message::text(text))
            .map_err(|e| format!("cdp send: {e}"))
    }

    /// End the connection and the reader thread. Idempotent.
    pub fn close(&self) {
        self.shared.closed.store(true, Ordering::SeqCst);
        let _ = self.stream.shutdown(Shutdown::Both);
        let reader = lock(&self.reader).take();
        if let Some(reader) = reader {
            // The last handle to the client can drop on the reader thread
            // itself (through the event handler); it cannot join itself.
            if reader.thread().id() != thread::current().id() {
                let _ = reader.join();
            }
        }
    }
}

impl Drop for CdpClient {
    fn drop(&mut self) {
        self.close();
    }
}

fn read_loop(shared: &Shared, peek: &TcpStream, on_event: &EventHandler) {
    let mut probe = [0u8; 1];
    while !shared.closed.load(Ordering::SeqCst) {
        match peek.peek(&mut probe) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e)
                if matches!(
                    e.kind(),
                    ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                ) =>
            {
                continue
            }
            Err(_) => break,
        }
        let (messages, alive) = drain(shared);
        for text in &messages {
            dispatch(shared, on_event, text);
        }
        if !alive {
            break;
        }
    }
    let lost = !shared.closed.swap(true, Ordering::SeqCst);
    // Dropping the senders wakes every waiting `call`.
    lock(&shared.waiters).clear();
    if lost {
        on_event(None, DISCONNECTED, &Value::Null);
    }
}

/// Read everything that is available without blocking (the socket mutex is
/// held, so the socket is switched to non-blocking only meanwhile). Returns
/// the texts and whether the connection is still usable.
fn drain(shared: &Shared) -> (Vec<String>, bool) {
    let mut ws = lock(&shared.ws);
    let mut messages = Vec::new();
    if ws.get_ref().set_nonblocking(true).is_err() {
        return (messages, false);
    }
    let alive = loop {
        match ws.read() {
            Ok(Message::Text(text)) => messages.push(text.as_str().to_owned()),
            Ok(_) => {}
            Err(WsError::Io(e)) if e.kind() == ErrorKind::WouldBlock => break true,
            Err(_) => break false,
        }
    };
    let blocking = ws.get_ref().set_nonblocking(false).is_ok();
    drop(ws);
    (messages, alive && blocking)
}

fn dispatch(shared: &Shared, on_event: &EventHandler, text: &str) {
    let Ok(mut message) = serde_json::from_str::<Value>(text) else {
        return;
    };
    if let Some(id) = message.get("id").and_then(Value::as_u64) {
        let waiter = lock(&shared.waiters).remove(&id);
        if let Some(waiter) = waiter {
            let error = message.get("error").map(|e| {
                e.get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("cdp error")
                    .to_owned()
            });
            let result = error.map_or_else(|| Ok(message["result"].take()), Err);
            let _ = waiter.send(result);
        }
    } else if let Some(method) = message.get("method").and_then(Value::as_str) {
        let session = message.get("sessionId").and_then(Value::as_str);
        let params = message.get("params").unwrap_or(&Value::Null);
        on_event(session, method, params);
    }
}

/// The browser-level `DevTools` WebSocket URL of the Chromium on `port`
/// (`/json/version`).
pub fn browser_ws_url(port: u16) -> Result<String, String> {
    let err = |e: std::io::Error| format!("chromium /json/version: {e}");
    let mut stream = TcpStream::connect(("127.0.0.1", port)).map_err(err)?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).map_err(err)?;
    stream.set_write_timeout(Some(IO_TIMEOUT)).map_err(err)?;
    write!(
        stream,
        "GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .map_err(err)?;
    let mut reader = BufReader::new(stream);
    let mut length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).map_err(err)? == 0 {
            return Err("chromium /json/version: truncated response".into());
        }
        let line = line.trim();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    // Chromium ignores `Connection: close`: read by length, not to EOF.
    let mut body = vec![0; length.min(1 << 16)];
    reader.read_exact(&mut body).map_err(err)?;
    serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v["webSocketDebuggerUrl"].as_str().map(str::to_owned))
        .ok_or_else(|| "chromium /json/version has no webSocketDebuggerUrl".into())
}
