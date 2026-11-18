//! Local socket server: one thread accepts, one reader thread and one
//! writer thread per connection. Parsed messages go to the core; the core
//! answers through the connection's [`Outbound`] queue.
use crate::core::CoreMsg;
use crate::paths::{ensure_private_dir, socket_name, Paths};
use interprocess::local_socket::{prelude::*, ListenerOptions, Stream};
use omp_desktop_core::persona_protocol::{
    read_line_capped, write_msg, ClientKind, ClientMsg, Envelope, LineRead, ServerMsg, PROTOCOL,
};
use std::io::{self, BufReader, Read, Write};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::time::Duration;

const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// Serialized bytes one connection may queue before the core drops it.
///
/// A client that stops reading while omp streams must not grow the service's
/// memory; 32 MiB is far more than a healthy client ever lags behind.
pub const MAX_OUTBOUND_BYTES: usize = 32 * 1024 * 1024;

/// Handshaken clients allowed at once. A further connection is answered with
/// an error and closed instead of starting another thread pair.
pub const MAX_CONNECTIONS: usize = 16;

pub type ConnId = u64;

/// One connection's outbound queue.
///
/// The underlying channel is unbounded, but the byte budget is checked before
/// every send, so the queue never holds more than the limit. `send` therefore
/// never blocks the core: a full queue is reported to the caller, which drops
/// the connection.
#[derive(Clone)]
pub struct Outbound {
    tx: Sender<Vec<u8>>,
    /// Serialized bytes queued and not yet written.
    queued: Arc<AtomicUsize>,
    /// Serialized bytes this connection may queue.
    limit: usize,
    /// Shuts the socket down when the queue overflows.
    closer: Option<Arc<Stream>>,
}

impl Outbound {
    /// An outbound queue over `tx` with a `limit`-byte budget and no socket to
    /// close (the test harness; the server adds its own closer).
    #[doc(hidden)]
    #[must_use]
    pub fn new(tx: Sender<Vec<u8>>, limit: usize) -> Self {
        Self {
            tx,
            queued: Arc::new(AtomicUsize::new(0)),
            limit,
            closer: None,
        }
    }

    /// Queue one message as a serialized line. Returns `false` when the
    /// message would exceed the queue's byte budget or the writer is gone.
    #[must_use]
    pub fn send(&self, msg: &ServerMsg) -> bool {
        let Ok(mut line) = serde_json::to_vec(msg) else {
            return false;
        };
        line.push(b'\n');
        let size = line.len();
        let reserved = self
            .queued
            .try_update(Ordering::AcqRel, Ordering::Acquire, |queued| {
                (queued.saturating_add(size) <= self.limit).then_some(queued + size)
            });
        if reserved.is_err() {
            return false;
        }
        if self.tx.send(line).is_err() {
            self.queued.fetch_sub(size, Ordering::AcqRel);
            return false;
        }
        true
    }

    /// Shuts the connection down so the blocked reader returns and the client
    /// sees the close.
    pub fn close(&self) {
        if let Some(conn) = &self.closer {
            shutdown(conn);
        }
    }
}

/// Shuts `conn` down. The stream is shared behind an `Arc` between the reader
/// and writer threads, so dropping it cannot close the socket; the platform's
/// shutdown call is what wakes a thread blocked in `read`.
fn shutdown(conn: &Stream) {
    #[cfg(unix)]
    {
        use std::os::fd::{AsFd, AsRawFd};
        let Stream::UdSocket(stream) = conn;
        // SAFETY: shutdown only reads the descriptor; the stream owns it.
        unsafe {
            libc::shutdown(stream.as_fd().as_raw_fd(), libc::SHUT_RDWR);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::{AsHandle, AsRawHandle};
        use windows_sys::Win32::System::Pipes::DisconnectNamedPipe;
        let Stream::NamedPipe(stream) = conn;
        // SAFETY: the handle belongs to this process and this stream; a
        // disconnect is valid on the server end of the named pipe.
        unsafe {
            DisconnectNamedPipe(stream.as_handle().as_raw_handle());
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = conn;
    }
}

#[derive(Debug)]
pub struct Inbound {
    pub conn: ConnId,
    pub req: Option<u64>,
    pub client: ClientKind,
    pub msg: ClientMsg,
}

#[derive(Debug)]
pub enum StartError {
    AlreadyRunning,
    Io(String),
}

pub struct Server {
    _accept: std::thread::JoinHandle<()>,
}

/// Bounds one server run: the handshake deadline and the two resource limits.
#[derive(Debug, Clone, Copy)]
struct Limits {
    /// Handshake deadline. Windows named-pipe streams do not support receive
    /// timeouts, so the field is unused there.
    #[cfg_attr(windows, allow(dead_code))]
    hello_timeout: Duration,
    outbound_bytes: usize,
    max_connections: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            hello_timeout: HELLO_TIMEOUT,
            outbound_bytes: MAX_OUTBOUND_BYTES,
            max_connections: MAX_CONNECTIONS,
        }
    }
}

/// Holds one of [`Limits::max_connections`] slots for the life of a
/// handshaken connection, so a refused client never takes a slot.
struct Admission(Arc<AtomicUsize>);

impl Admission {
    /// Takes a slot, or `None` when the connection limit is reached.
    fn acquire(active: &Arc<AtomicUsize>, max: usize) -> Option<Self> {
        let previous = active.fetch_add(1, Ordering::AcqRel);
        if previous >= max {
            active.fetch_sub(1, Ordering::AcqRel);
            return None;
        }
        Some(Self(Arc::clone(active)))
    }
}

impl Drop for Admission {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

static NEXT_CONN: AtomicU64 = AtomicU64::new(1);

/// Errors after the handshake go through the writer thread, so replies keep
/// their line order.
fn send_err(out: &Outbound, error: &str) {
    let _ = out.send(&ServerMsg::Reply {
        req: 0,
        ok: false,
        data: None,
        error: Some(error.into()),
    });
}

fn reply_err(out: &mut impl Write, req: Option<u64>, error: &str) {
    let _ = write_msg(
        out,
        &ServerMsg::Reply {
            req: req.unwrap_or(0),
            ok: false,
            data: None,
            error: Some(error.into()),
        },
    );
}

impl Server {
    /// Binds the socket and starts accepting clients.
    ///
    /// # Errors
    ///
    /// Returns [`StartError::AlreadyRunning`] when another instance answers
    /// on the socket, and [`StartError::Io`] when the socket cannot be bound
    /// or the accept thread cannot be started.
    pub fn start(paths: &Paths, to_core: Sender<CoreMsg>) -> Result<Self, StartError> {
        Self::start_with_limits(paths, to_core, Limits::default())
    }

    #[cfg(all(test, unix))]
    fn start_with_hello_timeout(
        paths: &Paths,
        to_core: Sender<CoreMsg>,
        hello_timeout: Duration,
    ) -> Result<Self, StartError> {
        Self::start_with_limits(
            paths,
            to_core,
            Limits {
                hello_timeout,
                ..Limits::default()
            },
        )
    }

    fn start_with_limits(
        paths: &Paths,
        to_core: Sender<CoreMsg>,
        limits: Limits,
    ) -> Result<Self, StartError> {
        ensure_private_dir(&paths.persona).map_err(|e| StartError::Io(e.to_string()))?;
        let name = socket_name(paths).map_err(|e| StartError::Io(e.to_string()))?;
        if Stream::connect(name.clone()).is_ok() {
            return Err(StartError::AlreadyRunning);
        }
        #[cfg(unix)]
        let _ = std::fs::remove_file(&paths.socket);
        let options = ListenerOptions::new().name(name);
        #[cfg(windows)]
        let options = {
            use interprocess::os::windows::local_socket::ListenerOptionsExt as _;
            options.security_descriptor(
                crate::pipe_security::listener_security_descriptor()
                    .map_err(|e| StartError::Io(e.to_string()))?,
            )
        };
        let listener = options
            .create_sync()
            .map_err(|e| StartError::Io(e.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&paths.socket, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| StartError::Io(e.to_string()))?;
        }
        let active = Arc::new(AtomicUsize::new(0));
        let accept = std::thread::Builder::new()
            .name("ompy-accept".into())
            .spawn(move || {
                for conn in listener.incoming() {
                    match conn {
                        Ok(conn) => {
                            let to_core = to_core.clone();
                            let active = Arc::clone(&active);
                            let _ = std::thread::Builder::new()
                                .name("ompy-conn".into())
                                .spawn(move || serve(conn, to_core, limits, &active));
                        }
                        Err(_) => std::thread::sleep(Duration::from_millis(100)),
                    }
                }
            })
            .map_err(|e| StartError::Io(e.to_string()))?;
        Ok(Self { _accept: accept })
    }
}

/// `&Stream` implements `Read` and `Write`; `split` is deprecated, so the
/// reader and writer threads share one `Arc<Stream>` through this adapter.
struct Shared(Arc<Stream>);

impl Read for Shared {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut stream: &Stream = &self.0;
        stream.read(buf)
    }
}

impl Write for Shared {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut stream: &Stream = &self.0;
        stream.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        let mut stream: &Stream = &self.0;
        stream.flush()
    }
}

#[allow(clippy::needless_pass_by_value)] // Moved into the connection thread; a reference cannot cross that boundary.
fn serve(conn: Stream, to_core: Sender<CoreMsg>, limits: Limits, active: &Arc<AtomicUsize>) {
    let id = NEXT_CONN.fetch_add(1, Ordering::Relaxed);
    #[cfg(unix)]
    if conn.set_recv_timeout(Some(limits.hello_timeout)).is_err() {
        return;
    }
    // Windows named-pipe streams do not support receive timeouts.
    let conn = Arc::new(conn);
    let mut reader = BufReader::new(Shared(Arc::clone(&conn)));
    let mut writer = Shared(Arc::clone(&conn));
    let mut buf = Vec::new();
    // Handshake before the writer thread exists.
    let (client, _admission) = match read_line_capped(&mut reader, &mut buf) {
        Ok(LineRead::Line) => match serde_json::from_slice::<Envelope<ClientMsg>>(&buf) {
            Ok(Envelope {
                req,
                body: ClientMsg::Hello { protocol, client },
            }) => {
                if protocol != PROTOCOL {
                    reply_err(&mut writer, req, "protocol 1 required");
                    return;
                }
                let Some(admission) = Admission::acquire(active, limits.max_connections) else {
                    reply_err(&mut writer, req, "too many connections");
                    return;
                };
                if write_msg(&mut writer, &ServerMsg::Hello { protocol: PROTOCOL }).is_err() {
                    return;
                }
                (client, admission)
            }
            Ok(Envelope { req, .. }) => {
                reply_err(&mut writer, req, "hello first");
                return;
            }
            Err(e) => {
                reply_err(&mut writer, None, &e.to_string());
                return;
            }
        },
        Ok(LineRead::TooLong) => {
            reply_err(&mut writer, None, "line too long");
            return;
        }
        _ => return,
    };
    #[cfg(unix)]
    if conn.set_recv_timeout(None).is_err() {
        return;
    }
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
    let queued = Arc::new(AtomicUsize::new(0));
    let out = Outbound {
        tx: out_tx,
        queued: Arc::clone(&queued),
        limit: limits.outbound_bytes,
        closer: Some(Arc::clone(&conn)),
    };
    let _ = std::thread::Builder::new()
        .name("ompy-write".into())
        .spawn(move || {
            for line in out_rx {
                let written = writer.write_all(&line).and_then(|()| writer.flush());
                queued.fetch_sub(line.len(), Ordering::AcqRel);
                if written.is_err() {
                    break;
                }
            }
        });
    if to_core
        .send(CoreMsg::Connected {
            conn: id,
            out: out.clone(),
            client,
        })
        .is_err()
    {
        return;
    }
    loop {
        match read_line_capped(&mut reader, &mut buf) {
            Ok(LineRead::Line) => match serde_json::from_slice::<Envelope<ClientMsg>>(&buf) {
                Ok(Envelope { req, body }) => {
                    if to_core
                        .send(CoreMsg::Inbound(Inbound {
                            conn: id,
                            req,
                            client,
                            msg: body,
                        }))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(e) => send_err(&out, &e.to_string()),
            },
            Ok(LineRead::TooLong) => send_err(&out, "line too long"),
            _ => break,
        }
    }
    let _ = to_core.send(CoreMsg::Disconnected(id));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::Paths;
    use interprocess::local_socket::Stream;
    use omp_desktop_core::persona_protocol::{read_line_capped, LineRead, MAX_LINE_BYTES};
    use std::io::{BufReader, Write};
    use std::sync::mpsc;
    use std::time::Duration;

    /// Short temp root: a unix socket path may not exceed the 104 bytes of
    /// `sun_path`, and the per-user `TMPDIR` plus a descriptive test name
    /// does not fit.
    fn temp_paths(tag: &str) -> Paths {
        #[cfg(unix)]
        let root = std::path::Path::new("/tmp").join(format!("ompy6-{tag}-{}", std::process::id()));
        #[cfg(not(unix))]
        let root = omp_desktop_core::test_support::tempdir("omp-desktopd", tag);
        let _ = std::fs::remove_dir_all(&root);
        let paths = Paths::under(&root);
        #[cfg(windows)]
        let paths = Paths {
            test_pipe_name: Some(format!("ompy-test-{tag}-{}", std::process::id())),
            ..paths
        };
        paths
    }

    fn line(r: &mut BufReader<Stream>) -> serde_json::Value {
        let mut buf = Vec::new();
        assert!(matches!(
            read_line_capped(r, &mut buf).unwrap(),
            LineRead::Line
        ));
        serde_json::from_slice(&buf).unwrap()
    }

    #[test]
    fn second_instance_is_refused() {
        let p = temp_paths("single");
        let (tx, _rx) = mpsc::channel();
        let _a = Server::start(&p, tx.clone()).unwrap();
        assert!(matches!(
            Server::start(&p, tx),
            Err(StartError::AlreadyRunning)
        ));
    }

    #[test]
    fn hello_is_required_and_unknown_message_keeps_connection() {
        let p = temp_paths("hello");
        let (tx, rx) = mpsc::channel();
        let _s = Server::start(&p, tx).unwrap();
        let s = Stream::connect(crate::paths::socket_name(&p).unwrap()).unwrap();
        let mut r = BufReader::new(s);
        r.get_mut()
            .write_all(b"{\"req\":1,\"type\":\"hello\",\"protocol\":1,\"client\":\"app\"}\n")
            .unwrap();
        assert_eq!(line(&mut r)["type"], "hello");
        // Core sees `Connected`; `hello` itself does not reach it.
        assert!(matches!(
            rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            crate::core::CoreMsg::Connected { .. }
        ));
        r.get_mut().write_all(b"{\"type\":\"nope\"}\n").unwrap();
        let err = line(&mut r);
        assert_eq!(
            (err["type"].as_str(), err["ok"].as_bool()),
            (Some("reply"), Some(false))
        );
        r.get_mut()
            .write_all(b"{\"req\":2,\"type\":\"status\"}\n")
            .unwrap();
        assert!(matches!(
            rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            crate::core::CoreMsg::Inbound(_)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn silent_client_is_disconnected_after_hello_timeout() {
        let p = temp_paths("silent");
        let (tx, _rx) = mpsc::channel();
        let _s = Server::start_with_hello_timeout(&p, tx, Duration::from_millis(50)).unwrap();
        let s = Stream::connect(crate::paths::socket_name(&p).unwrap()).unwrap();
        s.set_recv_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut r = BufReader::new(s);
        let mut buf = Vec::new();
        assert!(matches!(
            read_line_capped(&mut r, &mut buf).unwrap(),
            LineRead::Eof
        ));
    }

    #[test]
    fn oversized_hello_gets_an_error_before_close() {
        let p = temp_paths("long-hello");
        let (tx, _rx) = mpsc::channel();
        let _s = Server::start(&p, tx).unwrap();
        let s = Stream::connect(crate::paths::socket_name(&p).unwrap()).unwrap();
        let mut r = BufReader::new(s);
        let mut oversized = vec![b'x'; MAX_LINE_BYTES + 1];
        oversized.push(b'\n');
        r.get_mut().write_all(&oversized).unwrap();
        let err = line(&mut r);
        assert_eq!(
            (
                err["type"].as_str(),
                err["ok"].as_bool(),
                err["error"].as_str()
            ),
            (Some("reply"), Some(false), Some("line too long"))
        );
        let mut buf = Vec::new();
        assert!(matches!(
            read_line_capped(&mut r, &mut buf).unwrap(),
            LineRead::Eof
        ));
    }

    #[test]
    fn wrong_protocol_closes() {
        let p = temp_paths("proto");
        let (tx, _rx) = mpsc::channel();
        let _s = Server::start(&p, tx).unwrap();
        let s = Stream::connect(crate::paths::socket_name(&p).unwrap()).unwrap();
        let mut r = BufReader::new(s);
        r.get_mut()
            .write_all(b"{\"req\":1,\"type\":\"hello\",\"protocol\":9,\"client\":\"app\"}\n")
            .unwrap();
        assert_eq!(line(&mut r)["error"], "protocol 1 required");
        let mut buf = Vec::new();
        assert!(matches!(
            read_line_capped(&mut r, &mut buf).unwrap(),
            LineRead::Eof
        ));
    }

    #[cfg(unix)]
    #[test]
    fn socket_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let p = temp_paths("perm");
        let (tx, _rx) = mpsc::channel();
        let _s = Server::start(&p, tx).unwrap();
        assert_eq!(
            std::fs::metadata(&p.socket).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&p.persona).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[cfg(unix)]
    #[test]
    fn stale_socket_file_is_replaced() {
        let p = temp_paths("stale");
        crate::paths::ensure_private_dir(&p.persona).unwrap();
        std::fs::write(&p.socket, b"").unwrap();
        let (tx, _rx) = mpsc::channel();
        assert!(Server::start(&p, tx).is_ok());
    }

    /// Connects and completes the handshake, returning the open stream.
    fn handshake(p: &Paths) -> BufReader<Stream> {
        let s = Stream::connect(crate::paths::socket_name(p).unwrap()).unwrap();
        let mut r = BufReader::new(s);
        r.get_mut()
            .write_all(b"{\"req\":1,\"type\":\"hello\",\"protocol\":1,\"client\":\"app\"}\n")
            .unwrap();
        assert_eq!(line(&mut r)["type"], "hello");
        r
    }

    /// The next connection the core learns about.
    fn connected(rx: &mpsc::Receiver<crate::core::CoreMsg>) -> Outbound {
        match rx.recv_timeout(Duration::from_secs(5)).unwrap() {
            crate::core::CoreMsg::Connected { out, .. } => out,
            _ => panic!("expected a Connected message"),
        }
    }

    #[test]
    fn seventeenth_connection_is_refused() {
        let p = temp_paths("conn-limit");
        let (tx, rx) = mpsc::channel();
        let _s = Server::start(&p, tx).unwrap();
        let mut clients = Vec::new();
        for _ in 0..MAX_CONNECTIONS {
            clients.push(handshake(&p));
            let _ = connected(&rx);
        }
        assert_eq!(clients.len(), MAX_CONNECTIONS);
        let s = Stream::connect(crate::paths::socket_name(&p).unwrap()).unwrap();
        let mut extra = BufReader::new(s);
        extra
            .get_mut()
            .write_all(b"{\"req\":2,\"type\":\"hello\",\"protocol\":1,\"client\":\"app\"}\n")
            .unwrap();
        let reply = line(&mut extra);
        assert_eq!(
            (
                reply["type"].as_str(),
                reply["ok"].as_bool(),
                reply["error"].as_str()
            ),
            (Some("reply"), Some(false), Some("too many connections"))
        );
        let mut buf = Vec::new();
        assert!(matches!(
            read_line_capped(&mut extra, &mut buf).unwrap(),
            LineRead::Eof
        ));
    }

    #[test]
    fn slow_client_is_dropped_while_another_keeps_receiving() {
        let p = temp_paths("slow-client");
        let (tx, rx) = mpsc::channel();
        let limits = Limits {
            outbound_bytes: 64 * 1024,
            ..Limits::default()
        };
        let _s = Server::start_with_limits(&p, tx, limits).unwrap();
        let slow = handshake(&p);
        let slow_out = connected(&rx);
        let mut fast = handshake(&p);
        let fast_out = connected(&rx);

        // Nobody reads `slow`; the writer thread fills the socket buffer and
        // then the queue, until the byte budget refuses the next message.
        let body = "x".repeat(8 * 1024);
        let mut full = false;
        for req in 0..4096u64 {
            let msg = ServerMsg::Reply {
                req,
                ok: true,
                data: Some(serde_json::Value::String(body.clone())),
                error: None,
            };
            if !slow_out.send(&msg) {
                full = true;
                break;
            }
        }
        assert!(full, "the slow client's queue never reached its bound");

        // What the core does on a refused send: close the connection.
        slow_out.close();
        let (done_tx, done) = mpsc::channel();
        std::thread::spawn(move || {
            let mut slow = slow;
            let mut buf = Vec::new();
            while matches!(read_line_capped(&mut slow, &mut buf), Ok(LineRead::Line)) {}
            let _ = done_tx.send(());
        });
        assert!(
            done.recv_timeout(Duration::from_secs(10)).is_ok(),
            "the slow client was not disconnected"
        );

        // The other client is unaffected.
        assert!(fast_out.send(&ServerMsg::Hello { protocol: PROTOCOL }));
        assert_eq!(line(&mut fast)["type"], "hello");
    }
}
