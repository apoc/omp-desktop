//! Local socket server: one thread accepts, one reader thread and one
//! writer thread per admitted connection. Parsed messages go to the core;
//! the core answers through the connection's [`Outbound`] queue.
//!
//! Admission happens in the accept loop, before any thread exists: at most
//! [`MAX_CONNECTIONS`] connections hold a slot, handshake included, so a
//! client that connects and stays silent cannot multiply threads. The slot is
//! released when both the reader and the writer are gone.
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
use std::time::{Duration, Instant};

const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// Serialized bytes one connection may queue before the core drops it.
///
/// A client that stops reading while omp streams must not grow the service's
/// memory; 32 MiB is far more than a healthy client ever lags behind.
pub const MAX_OUTBOUND_BYTES: usize = 32 * 1024 * 1024;

/// Handshaken clients allowed at once. A further connection is answered with
/// an error and closed instead of starting another thread pair.
pub const MAX_CONNECTIONS: usize = 16;

/// Serialized bytes the whole server may have queued in the core's inbound
/// channel.
///
/// Readers reserve lines before handing them to the core. The reservation
/// travels with the message and releases on drop after handling, including
/// when an unhandled message is dropped. A line that would exceed the bound
/// is not queued: its client is disconnected instead.
pub const MAX_INBOUND_BYTES: usize = 32 * 1024 * 1024;

/// Bytes currently reserved in the core's inbound channel, shared by every
/// connection of one server.
#[derive(Debug, Clone)]
pub struct InboundBudget {
    queued: Arc<AtomicUsize>,
    limit: usize,
}

impl InboundBudget {
    /// A budget of `limit` serialized bytes shared by all connections.
    #[must_use]
    pub fn new(limit: usize) -> Self {
        Self {
            queued: Arc::new(AtomicUsize::new(0)),
            limit,
        }
    }

    /// Reserves `size` bytes, or returns `None` when the reservation would
    /// exceed the budget. Dropping the guard releases the reservation.
    #[must_use]
    pub fn reserve(&self, size: usize) -> Option<InboundReservation> {
        self.queued
            .try_update(Ordering::AcqRel, Ordering::Acquire, |queued| {
                (queued.saturating_add(size) <= self.limit).then_some(queued + size)
            })
            .ok()?;
        Some(InboundReservation {
            budget: self.clone(),
            bytes: size,
        })
    }

    /// Bytes currently reserved.
    #[must_use]
    pub fn queued_bytes(&self) -> usize {
        self.queued.load(Ordering::Acquire)
    }
}

/// One inbound line's byte reservation. The core drops it after handling.
#[derive(Debug)]
pub struct InboundReservation {
    budget: InboundBudget,
    bytes: usize,
}

impl Drop for InboundReservation {
    fn drop(&mut self) {
        self.budget.queued.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

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
        let fd = stream.as_fd().as_raw_fd();
        // SAFETY: shutdown only reads the descriptor; the stream owns it.
        //
        // A peer that half-closed its write side leaves macOS refusing
        // `SHUT_RDWR` with `ENOTCONN`, and that failed call does not wake a
        // writer blocked in `write`. `SHUT_WR` still closes our side there,
        // which is all that is left to close, and the blocked write returns.
        unsafe {
            if libc::shutdown(fd, libc::SHUT_RDWR) != 0 {
                libc::shutdown(fd, libc::SHUT_WR);
            }
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
    /// Serialized line size reserved in the server-wide inbound budget.
    pub bytes: usize,
    /// Releases the server-wide reservation when dropped after handling.
    pub reservation: InboundReservation,
}

#[derive(Debug)]
pub enum StartError {
    AlreadyRunning,
    Io(String),
}

pub struct Server {
    _accept: std::thread::JoinHandle<()>,
    active: Arc<AtomicUsize>,
}

impl Server {
    /// Admission slots in use, including connections that have not finished
    /// their handshake. Exposed for tests and diagnostics.
    #[must_use]
    pub fn active_connections(&self) -> usize {
        self.active.load(Ordering::Acquire)
    }
}

/// Bounds one server run: the handshake deadline and the three resource
/// limits.
#[derive(Debug, Clone, Copy)]
struct Limits {
    /// Handshake deadline. Windows named-pipe streams do not support receive
    /// timeouts, so the field is unused there.
    #[cfg_attr(windows, allow(dead_code))]
    hello_timeout: Duration,
    outbound_bytes: usize,
    inbound_bytes: usize,
    max_connections: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            hello_timeout: HELLO_TIMEOUT,
            outbound_bytes: MAX_OUTBOUND_BYTES,
            inbound_bytes: MAX_INBOUND_BYTES,
            max_connections: MAX_CONNECTIONS,
        }
    }
}

/// Holds one of [`Limits::max_connections`] slots from the accept loop to the
/// end of a connection.
///
/// The accept loop, the reader and the writer each hold a clone, so the slot
/// is freed only after every thread of the connection is gone. A refused
/// client never takes a slot and never gets a thread.
struct Admission(Arc<AdmissionSlot>);

impl Clone for Admission {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

struct AdmissionSlot(Arc<AtomicUsize>);

impl Drop for AdmissionSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

impl Admission {
    /// Takes a slot, or `None` when the connection limit is reached.
    fn acquire(active: &Arc<AtomicUsize>, max: usize) -> Option<Self> {
        let previous = active.fetch_add(1, Ordering::AcqRel);
        if previous >= max {
            active.fetch_sub(1, Ordering::AcqRel);
            return None;
        }
        Some(Self(Arc::new(AdmissionSlot(Arc::clone(active)))))
    }
}

static NEXT_CONN: AtomicU64 = AtomicU64::new(1);

/// Errors after the handshake go through the writer thread, so replies keep
/// their line order. Returns `false` when the outbound queue refused the
/// error; the caller closes the connection rather than keep reading.
fn send_err(out: &Outbound, error: &str) -> bool {
    out.send(&ServerMsg::Reply {
        req: 0,
        ok: false,
        data: None,
        error: Some(error.into()),
    })
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
        // A successful probe is only "already running" when the answering
        // server is ours. On Windows the pipe name is per user SID, but any
        // account may create that name first; the probe therefore verifies the
        // server process's user instead of trusting the name.
        #[cfg(windows)]
        if let Ok(probe) = Stream::connect(name.clone()) {
            return Err(match crate::pipe_security::probe_is_ours(&probe) {
                Ok(true) => StartError::AlreadyRunning,
                Ok(false) => {
                    StartError::Io("another account owns the persona pipe name".to_owned())
                }
                Err(e) => StartError::Io(format!("cannot verify the persona pipe owner: {e}")),
            });
        }
        #[cfg(not(windows))]
        if Stream::connect(name.clone()).is_ok() {
            return Err(StartError::AlreadyRunning);
        }
        #[cfg(unix)]
        let _ = std::fs::remove_file(&paths.socket);
        // On Windows the listener is created with `FILE_FLAG_FIRST_PIPE_INSTANCE`
        // (interprocess sets it for the first instance), so a second process
        // cannot bind the name even if its probe raced past ours.
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
        let accept_active = Arc::clone(&active);
        let inbound_budget = InboundBudget::new(limits.inbound_bytes);
        let accept = std::thread::Builder::new()
            .name("ompy-accept".into())
            .spawn(move || {
                for conn in listener.incoming() {
                    match conn {
                        Ok(conn) => {
                            // The slot is taken before any thread exists, so a
                            // silent client costs neither a thread nor a slot
                            // beyond the cap.
                            let Some(admission) =
                                Admission::acquire(&accept_active, limits.max_connections)
                            else {
                                refuse(&conn);
                                continue;
                            };
                            let to_core = to_core.clone();
                            let budget = inbound_budget.clone();
                            let _ = std::thread::Builder::new()
                                .name("ompy-conn".into())
                                .spawn(move || serve(conn, to_core, limits, admission, budget));
                        }
                        Err(_) => std::thread::sleep(Duration::from_millis(100)),
                    }
                }
            })
            .map_err(|e| StartError::Io(e.to_string()))?;
        Ok(Self {
            _accept: accept,
            active,
        })
    }
}

const fn refusal_has_reply(windows: bool) -> bool {
    !windows
}

/// Closes a connection that found no admission slot, with an error reply on
/// Unix only.
///
/// Runs on the accept thread, so a client that does not read cannot hold a
/// handler thread; the Unix write timeout bounds the reply. Windows must not
/// write: interprocess 2.4.8 sends a dirty pipe to its `FlushFileBuffers`
/// linger pool on drop (`named_pipe/stream.rs:28-36,74-84`). Instead,
/// `shutdown` calls `DisconnectNamedPipe`, the same immediate disconnect used
/// by interprocess itself (`named_pipe/listener.rs:185-188`). With no write,
/// the subsequent drop is clean and bypasses the linger pool.
fn refuse(conn: &Stream) {
    #[cfg(windows)]
    shutdown(conn);
    if refusal_has_reply(cfg!(windows)) {
        #[cfg(unix)]
        let _ = conn.set_send_timeout(Some(Duration::from_millis(250)));
        let mut writer: &Stream = conn;
        let _ = write_msg(
            &mut writer,
            &ServerMsg::Reply {
                req: 0,
                ok: false,
                data: None,
                error: Some("too many connections".into()),
            },
        );
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

/// Reads with one absolute handshake deadline.
///
/// The receive timeout is recomputed from the deadline before every read, so
/// a client that trickles bytes cannot extend the budget; previously each
/// arriving byte restarted the full timeout.
struct TimedRead {
    inner: Shared,
    /// `None` once the handshake is over. Unused on Windows, where named-pipe
    /// streams do not support receive timeouts.
    #[cfg_attr(windows, allow(dead_code))]
    deadline: Option<Instant>,
}

impl Read for TimedRead {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        #[cfg(unix)]
        if let Some(deadline) = self.deadline {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "hello deadline elapsed",
                ));
            };
            // A zero timeout means "no timeout" on some platforms.
            let remaining = remaining.max(Duration::from_millis(1));
            self.inner.0.set_recv_timeout(Some(remaining))?;
        }
        self.inner.read(buf)
    }
}

/// Completes the `hello` handshake before any writer thread exists.
///
/// Returns the client kind, or `None` when the connection is refused or
/// closed (missing or malformed hello, wrong protocol, write failure).
fn handshake(reader: &mut BufReader<TimedRead>, writer: &mut Shared) -> Option<ClientKind> {
    let mut buf = Vec::new();
    match read_line_capped(reader, &mut buf) {
        Ok(LineRead::Line) => match serde_json::from_slice::<Envelope<ClientMsg>>(&buf) {
            Ok(Envelope {
                req,
                body: ClientMsg::Hello { protocol, client },
            }) => {
                if protocol != PROTOCOL {
                    reply_err(writer, req, "protocol 1 required");
                    return None;
                }
                if write_msg(writer, &ServerMsg::Hello { protocol: PROTOCOL }).is_err() {
                    return None;
                }
                Some(client)
            }
            Ok(Envelope { req, .. }) => {
                reply_err(writer, req, "hello first");
                None
            }
            Err(e) => {
                reply_err(writer, None, &e.to_string());
                None
            }
        },
        Ok(LineRead::TooLong) => {
            reply_err(writer, None, "line too long");
            None
        }
        _ => None,
    }
}

#[allow(clippy::needless_pass_by_value)] // Moved into the connection thread; a reference cannot cross that boundary.
fn serve(
    conn: Stream,
    to_core: Sender<CoreMsg>,
    limits: Limits,
    admission: Admission,
    budget: InboundBudget,
) {
    let id = NEXT_CONN.fetch_add(1, Ordering::Relaxed);
    // Windows named-pipe streams do not support receive timeouts.
    let conn = Arc::new(conn);
    let mut reader = BufReader::new(TimedRead {
        inner: Shared(Arc::clone(&conn)),
        #[cfg(unix)]
        deadline: Some(Instant::now() + limits.hello_timeout),
        #[cfg(not(unix))]
        deadline: None,
    });
    let mut writer = Shared(Arc::clone(&conn));
    let mut buf = Vec::new();
    let Some(client) = handshake(&mut reader, &mut writer) else {
        return;
    };
    // Handshake done: no deadline and no receive timeout for the session.
    reader.get_mut().deadline = None;
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
    // Both sides hold a clone: the count drops only when the last one goes,
    // so the slot outlives whichever of reader and writer finishes first.
    #[allow(clippy::redundant_clone)]
    // `admission` here is the reader's hold; the clone is the writer's.
    let writer_admission = admission.clone();
    let _ = std::thread::Builder::new()
        .name("ompy-write".into())
        .spawn(move || {
            let _admission = writer_admission;
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
                    let bytes = buf.len();
                    // Reserve before queueing: one client or several successive
                    // clients cannot grow the idle core's backlog past the
                    // server-wide bound.
                    let Some(reservation) = budget.reserve(bytes) else {
                        let _ = send_err(&out, "inbound queue full");
                        break;
                    };
                    if to_core
                        .send(CoreMsg::Inbound(Inbound {
                            conn: id,
                            req,
                            client,
                            msg: body,
                            bytes,
                            reservation,
                        }))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(e) => {
                    // A refused error reply means the client is not reading;
                    // stop parsing its input instead of queueing forever.
                    if !send_err(&out, &e.to_string()) {
                        break;
                    }
                }
            },
            Ok(LineRead::TooLong) => {
                if !send_err(&out, "line too long") {
                    break;
                }
            }
            _ => break,
        }
    }
    // The reader is done: shut the socket down so a writer blocked on a
    // stalled client returns, and the client sees the close. The slot is
    // released only after that writer thread also ends (its clone drops).
    shutdown(&conn);
    let _ = to_core.send(CoreMsg::Disconnected(id));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::Paths;
    use interprocess::local_socket::Stream;
    #[cfg(unix)]
    use interprocess::TryClone;
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
    fn windows_admission_refusal_disconnects_without_reply() {
        assert!(refusal_has_reply(false));
        assert!(!refusal_has_reply(true));
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

    /// Polls `check` until it holds or `limit` elapses.
    #[cfg(unix)]
    fn wait_until(limit: Duration, mut check: impl FnMut() -> bool) -> bool {
        let start = Instant::now();
        while start.elapsed() < limit {
            if check() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        check()
    }

    #[cfg(unix)]
    #[test]
    fn silent_connections_take_slots_before_any_thread_starts() {
        let p = temp_paths("admission");
        let (tx, _rx) = mpsc::channel();
        let limits = Limits {
            max_connections: 2,
            hello_timeout: Duration::from_millis(300),
            ..Limits::default()
        };
        let server = Server::start_with_limits(&p, tx, limits).unwrap();
        let mut clients: Vec<BufReader<Stream>> = (0..6)
            .map(|_| {
                let s = Stream::connect(crate::paths::socket_name(&p).unwrap()).unwrap();
                s.set_recv_timeout(Some(Duration::from_secs(3))).unwrap();
                BufReader::new(s)
            })
            .collect();

        // Silent connections take the slot and the thread while they wait for
        // `hello`, so the cap already applies before the handshake.
        assert!(
            wait_until(Duration::from_secs(3), || server.active_connections() == 2),
            "silent connections must be admitted before the handshake"
        );

        let mut refused = 0;
        for client in &mut clients {
            let mut buf = Vec::new();
            match read_line_capped(client, &mut buf).unwrap() {
                LineRead::Line => {
                    let reply: serde_json::Value = serde_json::from_slice(&buf).unwrap();
                    assert_eq!(
                        (reply["ok"].as_bool(), reply["error"].as_str()),
                        (Some(false), Some("too many connections"))
                    );
                    refused += 1;
                    assert!(matches!(
                        read_line_capped(client, &mut buf).unwrap(),
                        LineRead::Eof
                    ));
                }
                LineRead::Eof => {}
                LineRead::TooLong => panic!("unexpected oversized line"),
            }
        }
        assert_eq!(refused, 4, "every connection beyond the cap is refused");
        drop(clients);
        assert!(wait_until(Duration::from_secs(5), || {
            server.active_connections() == 0
        }));
    }

    #[cfg(unix)]
    #[test]
    fn hello_deadline_is_absolute_across_reads() {
        let p = temp_paths("slow-hello");
        let (tx, _rx) = mpsc::channel();
        let _s = Server::start_with_hello_timeout(&p, tx, Duration::from_millis(200)).unwrap();
        let s = Stream::connect(crate::paths::socket_name(&p).unwrap()).unwrap();
        s.set_recv_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut client = BufReader::new(s);
        let mut trickle = client.get_ref().try_clone().unwrap();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let trickle_stop = std::sync::Arc::clone(&stop);
        let writer = std::thread::spawn(move || {
            while !trickle_stop.load(Ordering::Acquire) {
                // Never a newline: the handshake deadline must expire even
                // though bytes keep arriving.
                if trickle.write_all(b"{").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let mut buf = Vec::new();
        assert!(
            matches!(read_line_capped(&mut client, &mut buf), Ok(LineRead::Eof)),
            "the handshake deadline restarted on every arriving byte"
        );
        stop.store(true, Ordering::Release);
        writer.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn half_closed_client_releases_its_slot_after_the_writer_returns() {
        use std::os::fd::{AsFd, AsRawFd};

        let p = temp_paths("half-close");
        let (tx, rx) = mpsc::channel();
        let limits = Limits {
            max_connections: 2,
            ..Limits::default()
        };
        let server = Server::start_with_limits(&p, tx, limits).unwrap();
        let mut clients = Vec::new();
        let mut outs = Vec::new();
        for _ in 0..2 {
            clients.push(handshake(&p));
            outs.push(connected(&rx));
        }
        // Queue messages until the outbound budget is used up. The writer
        // cannot push all of it through a socket nobody reads, so it is
        // blocked in `write` when the client half-closes.
        let body = serde_json::Value::String("x".repeat(1024 * 1024));
        for out in &outs {
            for req in 0..4096u64 {
                if !out.send(&ServerMsg::Reply {
                    req,
                    ok: true,
                    data: Some(body.clone()),
                    error: None,
                }) {
                    break;
                }
            }
        }
        assert!(wait_until(Duration::from_secs(5), || {
            server.active_connections() == 2
        }));

        // Half-close the write side and keep the read side open: the server
        // reader sees EOF while its writer is still blocked on the full pipe.
        let mut held = Vec::new();
        for client in clients {
            let stream = client.into_inner();
            let Stream::UdSocket(socket) = &stream;
            // SAFETY: shutdown only reads the descriptor, which the stream
            // still owns.
            unsafe {
                libc::shutdown(socket.as_fd().as_raw_fd(), libc::SHUT_WR);
            }
            held.push(stream);
        }
        assert_eq!(held.len(), 2);
        assert!(
            wait_until(Duration::from_secs(10), || {
                server.active_connections() == 0
            }),
            "the writer of a half-closed client must stop and release its slot"
        );
        // With the slots back, a new client completes its handshake.
        let _fresh = handshake(&p);
    }

    #[cfg(unix)]
    #[test]
    fn malformed_line_flood_is_dropped_when_the_reply_queue_refuses() {
        let p = temp_paths("parse-flood");
        let (tx, _rx) = mpsc::channel();
        let limits = Limits {
            outbound_bytes: 0,
            ..Limits::default()
        };
        let _s = Server::start_with_limits(&p, tx, limits).unwrap();
        let mut client = handshake(&p);
        client
            .get_ref()
            .set_recv_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        // Every parse error would queue a reply; the zero-byte budget refuses
        // the first one, so the reader must close instead of reading forever.
        let _ = client
            .get_mut()
            .write_all(b"{\"type\":\n{not json}\n{\"type\":\n");
        let mut buf = Vec::new();
        assert!(
            matches!(read_line_capped(&mut client, &mut buf), Ok(LineRead::Eof)),
            "a client whose error replies are refused must be disconnected"
        );
    }

    #[cfg(unix)]
    #[test]
    fn client_that_outruns_the_core_is_disconnected() {
        let p = temp_paths("inbound");
        let (tx, rx) = mpsc::channel();
        let limits = Limits {
            inbound_bytes: 64 * 1024,
            ..Limits::default()
        };
        let server = Server::start_with_limits(&p, tx, limits).unwrap();
        let mut client = handshake(&p);
        // The core never reads the channel in this test.
        let _ = connected(&rx);
        client
            .get_ref()
            .set_recv_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let body = "x".repeat(4 * 1024);
        for req in 0..64u64 {
            let line = format!(
                "{{\"req\":{req},\"type\":\"rpc\",\"frame\":{{\"type\":\"tool_call\",\"pad\":\"{body}\"}}}}\n"
            );
            if client.get_mut().write_all(line.as_bytes()).is_err() {
                break;
            }
        }
        let mut buf = Vec::new();
        loop {
            match read_line_capped(&mut client, &mut buf) {
                Ok(LineRead::Line) => {
                    let reply: serde_json::Value = serde_json::from_slice(&buf).unwrap();
                    assert_eq!(
                        (reply["type"].as_str(), reply["error"].as_str()),
                        (Some("reply"), Some("inbound queue full"))
                    );
                }
                Ok(LineRead::Eof) => break,
                Ok(LineRead::TooLong) => panic!("unexpected oversized line"),
                Err(e) => panic!("the overflowing client was not disconnected: {e}"),
            }
        }
        assert!(wait_until(Duration::from_secs(5), || {
            server.active_connections() == 0
        }));
    }

    #[cfg(unix)]
    #[test]
    fn inbound_budget_is_shared_across_successive_connections() {
        let p = temp_paths("global-inbound");
        let (tx, rx) = mpsc::channel();
        let limits = Limits {
            inbound_bytes: 64 * 1024,
            max_connections: 1,
            ..Limits::default()
        };
        let server = Server::start_with_limits(&p, tx, limits).unwrap();
        let mut pending = Vec::new();
        for _ in 0..3 {
            let mut client = handshake(&p);
            while !matches!(
                rx.recv_timeout(Duration::from_secs(5)).unwrap(),
                crate::core::CoreMsg::Connected { .. }
            ) {}
            client
                .get_ref()
                .set_recv_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let body = "x".repeat(4 * 1024);
            for req in 0..64u64 {
                let line = format!(
                    "{{\"req\":{req},\"type\":\"rpc\",\"frame\":{{\"type\":\"tool_call\",\"pad\":\"{body}\"}}}}\n"
                );
                if client.get_mut().write_all(line.as_bytes()).is_err() {
                    break;
                }
            }
            let mut buf = Vec::new();
            loop {
                match read_line_capped(&mut client, &mut buf) {
                    Ok(LineRead::Line) => {
                        let reply: serde_json::Value = serde_json::from_slice(&buf).unwrap();
                        assert_eq!(reply["error"], "inbound queue full");
                    }
                    Ok(LineRead::Eof) => break,
                    Ok(LineRead::TooLong) => panic!("unexpected oversized line"),
                    Err(e) => panic!("the overflowing client was not disconnected: {e}"),
                }
            }
            assert!(wait_until(Duration::from_secs(5), || {
                server.active_connections() == 0
            }));
            while let Ok(msg) = rx.try_recv() {
                if let crate::core::CoreMsg::Inbound(inbound) = msg {
                    pending.push(inbound);
                }
            }
        }

        // The core stayed idle while three clients reconnected. Their queued
        // reservations must share one server-wide bound, not one per client.
        assert!(
            !pending.is_empty(),
            "the flood did not reach the core channel"
        );
        let queued: usize = pending.iter().map(|inbound| inbound.bytes).sum();
        assert!(
            queued <= limits.inbound_bytes,
            "three successive clients queued {queued} bytes with a {}-byte global bound",
            limits.inbound_bytes
        );
    }
}
