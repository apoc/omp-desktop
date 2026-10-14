//! `proxy.rs` unit tests: `/json` rewriting, the splice, shutdown, and what the
//! tap reports through it.

use super::*;
use std::sync::atomic::AtomicUsize;

use crate::browser::tap_tests::Reported;
use crate::browser::ws_frames_tests::{masked_text, text};

/// A proxy that nobody listens to the agent's pages of.
fn nobody() -> AgentTarget {
    Arc::new(|_| {})
}

/// Serves `/json/version` and, for any other request, echoes whatever the
/// client sends after the request head.
fn fake_upstream() -> u16 {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            thread::spawn(move || serve_fake(&stream, port));
        }
    });
    port
}

fn serve_fake(stream: &TcpStream, port: u16) {
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).unwrap();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line.trim().is_empty() {
            break;
        }
    }
    let mut out = stream;
    if request_line.starts_with("GET /json/version") {
        let body =
            format!(r#"{{"webSocketDebuggerUrl":"ws://127.0.0.1:{port}/devtools/browser/x"}}"#);
        write!(
            out,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
    } else {
        let _ = io::copy(&mut reader, &mut out);
    }
}

/// GET through `port`, reading the body by `Content-Length` (the proxy
/// closes, but the fake upstream does not).
fn http_get(port: u16, path: &str) -> io::Result<String> {
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port))?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    )?;
    let mut reader = BufReader::new(stream);
    let mut length = 0;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let line = line.trim();
        if line.is_empty() {
            break;
        }
        if has_header(line, "content-length") {
            length = line.split_once(':').unwrap().1.trim().parse().unwrap();
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    String::from_utf8(body).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Sends `request`, then collects the reply until EOF or a quiet second.
fn raw_roundtrip(port: u16, request: &[u8]) -> Vec<u8> {
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    stream.write_all(request).unwrap();
    let mut got = Vec::new();
    let mut chunk = [0u8; 256];
    while let Ok(n @ 1..) = stream.read(&mut chunk) {
        got.extend_from_slice(&chunk[..n]);
    }
    got
}

#[test]
fn json_bodies_point_at_the_proxy() {
    assert_eq!(
        rewrite_json(
            r#"{"a":"ws://127.0.0.1:9222/x","b":"ws://localhost:9222/y"}"#,
            9222,
            4000
        ),
        r#"{"a":"ws://127.0.0.1:4000/x","b":"ws://127.0.0.1:4000/y"}"#
    );
}

#[test]
fn version_is_rewritten_and_raw_traffic_is_spliced() {
    let up = fake_upstream();
    let proxy = Proxy::bind(Arc::new(move || Ok(up)), nobody()).unwrap();
    let body = http_get(proxy.port(), "/json/version").unwrap();
    assert!(
        body.contains(&format!("127.0.0.1:{}", proxy.port())),
        "{body}"
    );
    // `PING` rides in the same write as the head: it must reach upstream.
    let echoed = raw_roundtrip(
        proxy.port(),
        b"GET /devtools/browser/x HTTP/1.1\r\nUpgrade: websocket\r\n\r\nPING",
    );
    assert!(echoed.ends_with(b"PING"), "{echoed:?}");
}

#[test]
fn concurrent_first_connections_launch_once() {
    let up = fake_upstream();
    let calls = Arc::new(AtomicUsize::new(0));
    let launched = Arc::new(Mutex::new(None::<u16>));
    let c = Arc::clone(&calls);
    let l = Arc::clone(&launched);
    let ensure: Ensure = Arc::new(move || {
        let mut g = l.lock().unwrap();
        if g.is_none() {
            c.fetch_add(1, Ordering::SeqCst);
            thread::sleep(Duration::from_millis(200));
            *g = Some(up);
        }
        Ok(g.unwrap())
    });
    let proxy = Proxy::bind(ensure, nobody()).unwrap();
    let handles: Vec<_> = (0..5)
        .map(|_| {
            let p = proxy.port();
            thread::spawn(move || http_get(p, "/json/version"))
        })
        .collect();
    for h in handles {
        assert!(h.join().unwrap().is_ok());
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

/// Rejected discovery requests must never launch Chromium.
fn assert_discovery_forbidden(request: &[u8]) {
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&calls);
    let proxy = Proxy::bind(
        Arc::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            Err("must not launch".into())
        }),
        nobody(),
    )
    .unwrap();
    let response = raw_roundtrip(proxy.port(), request);
    assert!(
        response.starts_with(b"HTTP/1.1 403 Forbidden\r\n"),
        "{response:?}"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0, "no lazy launch");
}

#[test]
fn discovery_rejects_foreign_host_before_ensure() {
    assert_discovery_forbidden(
        b"GET /json/version HTTP/1.1\r\nHost: attacker.example:9222\r\n\r\n",
    );
}

#[test]
fn discovery_rejects_duplicate_host_before_ensure() {
    assert_discovery_forbidden(
        b"GET /json/version HTTP/1.1\r\nHost: localhost\r\nhOsT: 127.0.0.1\r\n\r\n",
    );
}

#[test]
fn discovery_rejects_missing_or_malformed_host_before_ensure() {
    for host in [
        "",
        "Host: \r\n",
        "Host : localhost\r\n",
        " Host: localhost\r\n",
        "Host localhost\r\n",
        "Host: localhost:\r\n",
        "Host: localhost:65536\r\n",
        "Host: localhost:abc\r\n",
        "Host: localhost,127.0.0.1\r\n",
        "Host: localhost.attacker.example\r\n",
        "Host: user@localhost\r\n",
        "Host: localhost/path\r\n",
        "Host: ::1\r\n",
        "Host: [::1]:abc\r\n",
        "Host: localhost\r\n folded\r\n",
    ] {
        let request = format!("GET /json/version HTTP/1.1\r\n{host}\r\n");
        assert_discovery_forbidden(request.as_bytes());
    }
}

#[test]
fn absolute_form_target_is_rejected_before_ensure() {
    assert_discovery_forbidden(
        b"GET http://localhost/json/version HTTP/1.1\r\nHost: localhost\r\n\r\n",
    );
}

#[test]
fn non_get_discovery_rejects_foreign_host_before_ensure() {
    assert_discovery_forbidden(
        b"PUT /json/new?about:blank HTTP/1.1\r\nHost: attacker.example\r\n\r\n",
    );
}

#[test]
fn websocket_upgrade_head_reaches_upstream_unchanged() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let request =
        b"GET /devtools/browser/x HTTP/1.1\r\nHost: foreign.example:9222\r\nUpgrade: websocket\r\n\r\n";
    let upstream = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut received = vec![0; request.len()];
        stream.read_exact(&mut received).unwrap();
        stream.write_all(b"unchanged").unwrap();
        received
    });
    let proxy = Proxy::bind(Arc::new(move || Ok(port)), nobody()).unwrap();
    assert_eq!(raw_roundtrip(proxy.port(), request), b"unchanged");
    assert_eq!(upstream.join().unwrap(), request);
}

#[test]
fn discovery_accepts_loopback_authorities_with_any_port() {
    let up = fake_upstream();
    let proxy = Proxy::bind(Arc::new(move || Ok(up)), nobody()).unwrap();
    for host in [
        "localhost",
        "LoCaLhOsT:12345",
        "127.0.0.1",
        "127.0.0.1:0",
        "[::1]",
        "[::1]:65535",
    ] {
        let request =
            format!("GET /json/version HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
        let response = raw_roundtrip(proxy.port(), request.as_bytes());
        assert!(
            response.starts_with(b"HTTP/1.1 200 OK\r\n"),
            "{host}: {response:?}"
        );
        assert!(String::from_utf8_lossy(&response).contains(&format!(
            "ws://127.0.0.1:{}/devtools/browser/x",
            proxy.port()
        )));
    }
}

#[test]
fn ensure_error_is_a_503() {
    let proxy = Proxy::bind(Arc::new(|| Err("no chromium".into())), nobody()).unwrap();
    let raw = raw_roundtrip(
        proxy.port(),
        b"GET /json/version HTTP/1.1\r\nHost: localhost\r\n\r\n",
    );
    assert!(String::from_utf8_lossy(&raw).starts_with("HTTP/1.1 503"));
}

#[test]
fn oversized_head_is_closed_unanswered() {
    let proxy = Proxy::bind(Arc::new(|| Err("must not be asked".into())), nobody()).unwrap();
    let mut request = b"GET /json HTTP/1.1\r\nX: ".to_vec();
    request.resize(MAX_HEAD + 100, b'a');
    assert_eq!(raw_roundtrip(proxy.port(), &request), Vec::<u8>::new());
}

#[test]
fn finished_connections_are_untracked() {
    let up = fake_upstream();
    let proxy = Proxy::bind(Arc::new(move || Ok(up)), nobody()).unwrap();
    for _ in 0..3 {
        http_get(proxy.port(), "/json/version").unwrap();
    }
    let _ = raw_roundtrip(proxy.port(), b"GET /x HTTP/1.1\r\n\r\n");
    let deadline = Instant::now() + Duration::from_secs(3);
    while !proxy.shared.live().is_empty() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    assert!(
        proxy.shared.live().is_empty(),
        "closed splices must leave the live map"
    );
}

/// Upstream that reads until the client's EOF, then replies and closes.
fn reply_after_eof_upstream() -> u16 {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            thread::spawn(move || {
                let mut received = Vec::new();
                stream.read_to_end(&mut received).unwrap();
                write!(stream, "REPLY:{}", received.ends_with(b"PING")).unwrap();
            });
        }
    });
    port
}

#[test]
fn client_half_close_keeps_the_reply_path_open() {
    let up = reply_after_eof_upstream();
    let proxy = Proxy::bind(Arc::new(move || Ok(up)), nobody()).unwrap();
    let mut s = TcpStream::connect((Ipv4Addr::LOCALHOST, proxy.port())).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    s.write_all(b"GET /devtools/x HTTP/1.1\r\nUpgrade: websocket\r\n\r\nPING")
        .unwrap();
    s.shutdown(Shutdown::Write).unwrap();
    let mut reply = Vec::new();
    s.read_to_end(&mut reply).unwrap();
    assert_eq!(reply, b"REPLY:true");
    let deadline = Instant::now() + Duration::from_secs(3);
    while !proxy.shared.live().is_empty() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    assert!(
        proxy.shared.live().is_empty(),
        "finished half-closed splice must leave the live map"
    );
}

#[test]
fn trickled_head_is_cut_at_the_absolute_deadline() {
    let proxy = Proxy::bind_with(
        Arc::new(|| Err("must not be asked".into())),
        nobody(),
        Duration::from_millis(300),
    )
    .unwrap();
    let mut s = TcpStream::connect((Ipv4Addr::LOCALHOST, proxy.port())).unwrap();
    let mut writer = s.try_clone().unwrap();
    // One byte every 100 ms: each read arrives well inside a per-read
    // timeout of 300 ms, yet the head never completes.
    let trickle = thread::spawn(move || {
        for _ in 0..40 {
            if writer.write_all(b"a").is_err() {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
    });
    s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let start = Instant::now();
    let mut buf = [0u8; 16];
    let closed = match s.read(&mut buf) {
        Ok(n) => n == 0,
        Err(e) => !matches!(
            e.kind(),
            io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
        ),
    };
    assert!(
        closed,
        "proxy must close the connection, not time out the client"
    );
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "closed late: {:?}",
        start.elapsed()
    );
    trickle.join().unwrap();
}

#[test]
fn shutdown_cuts_live_splices() {
    let up = fake_upstream();
    let proxy = Proxy::bind(Arc::new(move || Ok(up)), nobody()).unwrap();
    let mut s = TcpStream::connect(("127.0.0.1", proxy.port())).unwrap();
    s.write_all(b"GET /devtools/x HTTP/1.1\r\nUpgrade: websocket\r\n\r\n")
        .unwrap();
    thread::sleep(Duration::from_millis(100));
    proxy.shutdown();
    s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let mut buf = [0u8; 64];
    assert!(matches!(s.read(&mut buf), Ok(0) | Err(_)), "socket closed");
    // The accept loop is gone: a new connection is refused or closed at once.
    match TcpStream::connect(("127.0.0.1", proxy.port())) {
        Err(_) => {}
        Ok(mut late) => {
            late.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let _ = late.write_all(b"GET /json/version HTTP/1.1\r\n\r\n");
            assert!(
                matches!(late.read(&mut buf), Ok(0) | Err(_)),
                "no service after shutdown"
            );
        }
    }
}

/// A stand-in for Chromium that accepts a WebSocket upgrade (`101` and
/// `extension_header`), then sends a `Target.createTarget` reply for id 1
/// once the client's first frame is in (and the tap has surely seen it).
fn fake_chromium(extension_header: &'static str) -> u16 {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line.trim().is_empty() {
                        break;
                    }
                }
                write!(
                    stream,
                    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n{extension_header}\r\n"
                )
                .unwrap();
                let mut first_frame = vec![0; masked_text(CREATE_TARGET).len()];
                reader.read_exact(&mut first_frame).unwrap();
                thread::sleep(Duration::from_millis(100));
                stream
                    .write_all(&text(r#"{"id":1,"result":{"targetId":"T9"}}"#))
                    .unwrap();
                let _ = io::copy(&mut reader, &mut io::sink());
            });
        }
    });
    port
}

const CREATE_TARGET: &str =
    r#"{"id":1,"method":"Target.createTarget","params":{"url":"about:blank"}}"#;

/// An agent that asks for a new page through a proxy in front of
/// [`fake_chromium`]; returns what the tap reported once the reply arrived.
/// `split`: the first frame comes in a write of its own, not with the head.
fn agent_creates_a_page(extension_header: &'static str, split: bool) -> (Vec<String>, Vec<u8>) {
    let up = fake_chromium(extension_header);
    let reported = Reported::default();
    let proxy = Proxy::bind(Arc::new(move || Ok(up)), reported.callback()).unwrap();
    let mut s = TcpStream::connect((Ipv4Addr::LOCALHOST, proxy.port())).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let head = b"GET /devtools/browser/x HTTP/1.1\r\nUpgrade: websocket\r\n\r\n";
    let frame = masked_text(CREATE_TARGET);
    if split {
        s.write_all(head).unwrap();
        thread::sleep(Duration::from_millis(50));
        s.write_all(&frame).unwrap();
    } else {
        s.write_all(&[head.as_slice(), &frame].concat()).unwrap();
    }
    let reply = text(r#"{"id":1,"result":{"targetId":"T9"}}"#);
    let mut got = Vec::new();
    let mut chunk = [0u8; 256];
    while !got.ends_with(&reply) {
        let n = s.read(&mut chunk).unwrap();
        assert!(n > 0, "closed before the reply: {got:?}");
        got.extend_from_slice(&chunk[..n]);
    }
    thread::sleep(Duration::from_millis(300)); // the tap is fed after the forward
    (reported.all(), got)
}

#[test]
fn the_tap_sees_a_page_the_agent_creates_and_the_bytes_arrive_unchanged() {
    for split in [false, true] {
        let (reported, got) = agent_creates_a_page("", split);
        assert_eq!(reported, ["T9"], "split: {split}");
        assert!(
            got.starts_with(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n"),
            "{got:?}"
        );
    }
}

#[test]
fn a_negotiated_extension_blinds_the_tap_but_not_the_splice() {
    let (reported, got) =
        agent_creates_a_page("Sec-WebSocket-Extensions: permessage-deflate\r\n", false);
    assert!(reported.is_empty(), "{reported:?}");
    assert!(got.ends_with(&text(r#"{"id":1,"result":{"targetId":"T9"}}"#)));
}

const ATTACH: &str =
    r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"T1","flatten":true}}"#;
const ATTACH_REPLY: &str = r#"{"id":1,"result":{"sessionId":"S1"}}"#;
const NAVIGATE: &str =
    r#"{"id":2,"method":"Page.navigate","params":{"url":"about:blank"},"sessionId":"S1"}"#;

/// A stand-in for Chromium that answers `Target.attachToTarget` with no delay
/// at all, the instant its frame is in.
fn instant_attach_upstream() -> u16 {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line.trim().is_empty() {
                        break;
                    }
                }
                write!(
                    stream,
                    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n"
                )
                .unwrap();
                let mut first_frame = vec![0; masked_text(ATTACH).len()];
                reader.read_exact(&mut first_frame).unwrap();
                stream.write_all(&text(ATTACH_REPLY)).unwrap();
                let _ = io::copy(&mut reader, &mut io::sink());
            });
        }
    });
    port
}

/// An agent that attaches to `T1`, and the moment the reply is in, works in
/// the new session. The tap must have the session by then: the reply was
/// observed after the attach, the navigate after the reply. `split`: the
/// attach frame comes in a write of its own, not with the head.
/// `client_push_delay_ms` slows the client-side queueing of this connection
/// (0: none). Returns what the tap reported.
fn attach_then_navigate_at_once(split: bool, client_push_delay_ms: u64) -> Vec<String> {
    let up = instant_attach_upstream();
    let reported = Reported::default();
    let proxy = Proxy::bind(Arc::new(move || Ok(up)), reported.callback()).unwrap();
    proxy.set_client_push_delay_ms(client_push_delay_ms);
    let mut s = TcpStream::connect((Ipv4Addr::LOCALHOST, proxy.port())).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let head = b"GET /devtools/browser/x HTTP/1.1\r\nUpgrade: websocket\r\n\r\n";
    let attach = masked_text(ATTACH);
    if split {
        s.write_all(head).unwrap();
        thread::sleep(Duration::from_millis(50));
        s.write_all(&attach).unwrap();
    } else {
        s.write_all(&[head.as_slice(), &attach].concat()).unwrap();
    }
    let reply = text(ATTACH_REPLY);
    let mut got = Vec::new();
    let mut chunk = [0u8; 256];
    while !got.ends_with(&reply) {
        let n = s.read(&mut chunk).unwrap();
        assert!(n > 0, "closed before the reply: {got:?}");
        got.extend_from_slice(&chunk[..n]);
    }
    s.write_all(&masked_text(NAVIGATE)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while reported.all().is_empty() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    reported.all()
}

#[test]
fn a_reply_is_observed_after_its_command_even_when_the_client_push_is_slow() {
    // Were the command queued after it was forwarded, the 150 ms delay of
    // this connection's push would let the reply (and the dependent navigate)
    // overtake it.
    for split in [true, false] {
        assert_eq!(
            attach_then_navigate_at_once(split, 150),
            ["T1"],
            "split: {split}"
        );
    }
}

#[test]
fn an_instant_reply_never_overtakes_its_command() {
    for round in 0..40 {
        assert_eq!(
            attach_then_navigate_at_once(round % 2 == 0, 0),
            ["T1"],
            "round {round}"
        );
    }
}
