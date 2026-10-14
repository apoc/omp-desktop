//! Placeholder port the agent connects to: a loopback proxy in front of the
//! lazily launched Chromium. `/json*` responses are rewritten so the CDP
//! WebSocket URLs point back at the proxy; everything else (the WebSocket
//! upgrade and its frames) is spliced byte for byte, with a read-only
//! [`Tap`] looking along (see `tap.rs`).

use std::collections::HashMap;
use std::fmt::Write as _;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use super::tap::{Direction, Feed, Tap};

/// Returns the live Chromium port, launching or relaunching it as needed.
pub type Ensure = Arc<dyn Fn() -> Result<u16, String> + Send + Sync>;

/// Told the id of a page the agent worked in. Runs on a tap observer thread:
/// it must be quick and must not block.
pub type AgentTarget = Arc<dyn Fn(&str) + Send + Sync>;

const MAX_HEAD: usize = 16 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(5);
const WAKE_TIMEOUT: Duration = Duration::from_secs(1);

struct Shared {
    ensure: Ensure,
    on_target: AgentTarget,
    port: u16,
    /// Total time a client gets to deliver its request head.
    head_timeout: Duration,
    stopped: AtomicBool,
    next_id: AtomicU64,
    /// `#[cfg(test)]`: how long the taps of this proxy's connections delay
    /// every client-side queueing; the ordering test sets it on its own
    /// proxy alone.
    #[cfg(test)]
    client_push_delay_ms: AtomicU64,
    /// Sockets of connections in flight, keyed by connection id; an entry
    /// lives exactly as long as its connection thread.
    live: Mutex<HashMap<u64, Vec<TcpStream>>>,
}

impl Shared {
    fn live(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Vec<TcpStream>>> {
        self.live.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Registers `stream` under `id` so `shutdown` can cut it. A stream that
    /// arrives after shutdown is cut on the spot and `false` returned.
    fn track(&self, id: u64, stream: &TcpStream) -> bool {
        let Ok(handle) = stream.try_clone() else {
            return false;
        };
        let mut live = self.live();
        if self.stopped.load(Ordering::SeqCst) {
            let _ = stream.shutdown(Shutdown::Both);
            return false;
        }
        live.entry(id).or_default().push(handle);
        true
    }

    fn untrack(&self, id: u64) {
        self.live().remove(&id);
    }
}

pub struct Proxy {
    shared: Arc<Shared>,
}

impl Proxy {
    /// Binds `127.0.0.1:0` and starts accepting. `on_target` is told the page
    /// the agent worked in.
    pub fn bind(ensure: Ensure, on_target: AgentTarget) -> io::Result<Self> {
        Self::bind_with(ensure, on_target, HEAD_TIMEOUT)
    }

    fn bind_with(
        ensure: Ensure,
        on_target: AgentTarget,
        head_timeout: Duration,
    ) -> io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let shared = Arc::new(Shared {
            ensure,
            on_target,
            port: listener.local_addr()?.port(),
            head_timeout,
            stopped: AtomicBool::new(false),
            next_id: AtomicU64::new(0),
            #[cfg(test)]
            client_push_delay_ms: AtomicU64::new(0),
            live: Mutex::new(HashMap::new()),
        });
        let accept_shared = Arc::clone(&shared);
        thread::Builder::new()
            .name("browser-proxy-accept".into())
            .spawn(move || accept_loop(&listener, &accept_shared))?;
        Ok(Self { shared })
    }

    pub fn port(&self) -> u16 {
        self.shared.port
    }

    /// `#[cfg(test)]`: slows the client-side queueing of this proxy's taps:
    /// the ordering test uses it so no parallel test sees the delay.
    #[cfg(test)]
    pub(super) fn set_client_push_delay_ms(&self, millis: u64) {
        self.shared
            .client_push_delay_ms
            .store(millis, Ordering::Relaxed);
    }

    /// Stops accepting and cuts every live client and upstream socket.
    pub fn shutdown(&self) {
        if self.shared.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        // Wake the blocked `accept`; it sees `stopped` and drops the listener.
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, self.shared.port));
        let _ = TcpStream::connect_timeout(&addr, WAKE_TIMEOUT);
        for stream in self.shared.live().drain().flat_map(|(_, v)| v) {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Replaces `127.0.0.1:{from}` and `localhost:{from}` with `127.0.0.1:{to}`.
pub fn rewrite_json(body: &str, from: u16, to: u16) -> String {
    let target = format!("127.0.0.1:{to}");
    body.replace(&format!("127.0.0.1:{from}"), &target)
        .replace(&format!("localhost:{from}"), &target)
}

fn accept_loop(listener: &TcpListener, shared: &Arc<Shared>) {
    for stream in listener.incoming() {
        if shared.stopped.load(Ordering::SeqCst) {
            return;
        }
        match stream {
            Ok(client) => {
                let shared = Arc::clone(shared);
                // A failed spawn drops `client`, which closes the connection.
                let _ = thread::Builder::new()
                    .name("browser-proxy-conn".into())
                    .spawn(move || handle(&shared, client));
            }
            // Transient accept failure (e.g. fd exhaustion): back off.
            Err(_) => thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn handle(shared: &Shared, client: TcpStream) {
    let id = shared.next_id.fetch_add(1, Ordering::Relaxed);
    if shared.track(id, &client) {
        let _ = serve(shared, id, client);
    }
    shared.untrack(id);
}

fn serve(shared: &Shared, id: u64, mut client: TcpStream) -> io::Result<()> {
    let deadline = Instant::now() + shared.head_timeout;
    let Some((buf, head_len)) = read_head(&mut client, deadline)? else {
        return Ok(());
    };
    let target = buf[..head_len]
        .split(|&b| b == b'\n')
        .next()
        .and_then(|line| line.split(u8::is_ascii_whitespace).nth(1));
    let Some(target) = target.filter(|t| t.starts_with(b"/") || *t == b"*") else {
        return respond(&mut client, "403 Forbidden", "origin-form target required");
    };
    // Check the client's authority before lazy launch or rewriting Host:
    // otherwise discovery would bypass Chromium's DNS-rebinding protection.
    let json_head = if target.starts_with(b"/json") {
        match std::str::from_utf8(&buf[..head_len - 4]) {
            Ok(head) if valid_discovery_head(head) => Some(head),
            _ => return respond(&mut client, "403 Forbidden", "loopback Host required"),
        }
    } else {
        None
    };
    let port = match (shared.ensure)() {
        Ok(port) => port,
        Err(e) => return respond(&mut client, "503 Service Unavailable", &e),
    };
    let upstream = match TcpStream::connect((Ipv4Addr::LOCALHOST, port)) {
        Ok(upstream) => upstream,
        Err(e) => return respond(&mut client, "502 Bad Gateway", &e.to_string()),
    };
    if !shared.track(id, &upstream) {
        return Ok(());
    }
    if let Some(head) = json_head.filter(|_| buf.starts_with(b"GET ")) {
        return relay_json(&mut client, upstream, head, (port, shared.port))
            .or_else(|e| respond(&mut client, "502 Bad Gateway", &e.to_string()));
    }
    client.set_read_timeout(None)?;
    let tap = Tap::new(&buf[..head_len], Arc::clone(&shared.on_target));
    let feed = Feed::spawn(tap);
    #[cfg(test)]
    feed.set_client_push_delay_ms(shared.client_push_delay_ms.load(Ordering::Relaxed));
    splice(client, upstream, &buf, head_len, feed)
}

/// Exactly one well-formed loopback Host; reject folded or ambiguous headers.
fn valid_discovery_head(head: &str) -> bool {
    let mut host = None;
    for line in head.split("\r\n").skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
            || value.bytes().any(|b| b.is_ascii_control() && b != b'\t')
        {
            return false;
        }
        if name.eq_ignore_ascii_case("host") {
            if host.is_some() {
                return false;
            }
            host = Some(value.trim_matches([' ', '\t']));
        }
    }
    host.is_some_and(loopback_authority)
}

/// Whitelist the literal hosts Chromium accepts, with an optional numeric port.
fn loopback_authority(authority: &str) -> bool {
    let (host, suffix) = authority.strip_prefix("[::1]").map_or_else(
        || {
            authority
                .find(':')
                .map_or((authority, ""), |colon| authority.split_at(colon))
        },
        |suffix| ("[::1]", suffix),
    );
    (host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "[::1]")
        && (suffix.is_empty()
            || suffix.strip_prefix(':').is_some_and(|port| {
                !port.is_empty()
                    && port.bytes().all(|b| b.is_ascii_digit())
                    && port.parse::<u16>().is_ok()
            }))
}

/// Reads up to the blank line ending the request head. Returns the bytes read
/// so far (the head plus anything the client sent after it) and the head's
/// length including the terminator; `None` on EOF or a head over the cap.
/// The whole head must arrive by `deadline`, however slowly it trickles in.
fn read_head(stream: &mut TcpStream, deadline: Instant) -> io::Result<Option<(Vec<u8>, usize)>> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::ErrorKind::TimedOut.into());
        }
        stream.set_read_timeout(Some(remaining))?;
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Ok(None);
        }
        // The terminator may straddle the previous chunk.
        let from = buf.len().saturating_sub(3);
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf[from..].windows(4).position(|w| w == b"\r\n\r\n") {
            let head_len = from + pos + 4;
            return Ok((head_len <= MAX_HEAD).then_some((buf, head_len)));
        }
        if buf.len() > MAX_HEAD {
            return Ok(None);
        }
    }
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) -> io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

/// `head` is the validated discovery request without its terminator; `ports`
/// are Chromium's and the proxy's own. Only now may Host point at Chromium.
fn relay_json(
    client: &mut TcpStream,
    mut upstream: TcpStream,
    head: &str,
    ports: (u16, u16),
) -> io::Result<()> {
    let (chromium, own) = ports;
    upstream.set_read_timeout(Some(UPSTREAM_TIMEOUT))?;
    let mut request = String::with_capacity(head.len() + 24);
    for line in head.split("\r\n").filter(|l| !has_header(l, "host")) {
        request.push_str(line);
        request.push_str("\r\n");
    }
    let _ = write!(request, "Host: 127.0.0.1:{chromium}\r\n\r\n");
    upstream.write_all(request.as_bytes())?;

    // Chromium ignores `Connection: close`: read by `Content-Length`, not EOF.
    let mut reader = BufReader::new(upstream);
    let mut lines = Vec::new();
    let mut length = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if has_header(line, "content-length") {
            length = line
                .split_once(':')
                .and_then(|(_, v)| v.trim().parse().ok());
        } else if !has_header(line, "connection") {
            lines.push(line.to_owned());
        }
    }
    let length: usize = length.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "upstream sent no Content-Length",
        )
    })?;
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    let body =
        String::from_utf8(body).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let body = rewrite_json(&body, chromium, own);

    let mut response = lines.join("\r\n");
    let _ = write!(
        response,
        "\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    client.write_all(response.as_bytes())?;
    Ok(())
}

fn has_header(line: &str, name: &str) -> bool {
    line.split_once(':')
        .is_some_and(|(n, _)| n.trim().eq_ignore_ascii_case(name))
}

/// Forwards `pending` (the head, `head_len` bytes, and anything pipelined
/// behind it) upstream, then copies both directions until either side closes.
/// Every chunk is queued for the tap's observer *before* it is forwarded, so
/// the observer meets commands and replies in causal order.
fn splice(
    client: TcpStream,
    mut upstream: TcpStream,
    pending: &[u8],
    head_len: usize,
    feed: Feed,
) -> io::Result<()> {
    feed.push(Direction::Client, &pending[head_len..]);
    upstream.write_all(pending)?;
    let (down_from, down_to) = (upstream.try_clone()?, client.try_clone()?);
    // Both pipe threads own a sender and share the same observer-disable flag.
    let down_feed = feed.clone();
    let down = thread::Builder::new()
        .name("browser-proxy-down".into())
        .spawn(move || pipe(down_from, down_to, &down_feed, Direction::Server))?;
    pipe(client, upstream, &feed, Direction::Client);
    let _ = down.join();
    Ok(())
}

/// Copies `from` into `to`, queueing each chunk for the tap (as `direction`)
/// first. A clean EOF only half-closes: `to` gets a FIN while the opposite
/// direction keeps flowing until its own EOF. A copy error cuts both
/// sockets.
fn pipe(mut from: TcpStream, mut to: TcpStream, feed: &Feed, direction: Direction) {
    let mut chunk = [0u8; 16 * 1024];
    let copied = loop {
        match from.read(&mut chunk) {
            Ok(0) => break Ok(()),
            Ok(n) => {
                feed.push(direction, &chunk[..n]);
                if let Err(e) = to.write_all(&chunk[..n]) {
                    break Err(e);
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => break Err(e),
        }
    };
    if copied.is_ok() {
        let _ = to.shutdown(Shutdown::Write);
    } else {
        let _ = from.shutdown(Shutdown::Both);
        let _ = to.shutdown(Shutdown::Both);
    }
}

#[cfg(test)]
#[path = "proxy_tests.rs"]
mod tests;
