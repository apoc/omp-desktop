//! Proxy tests: admission before the lazy launch, the connection caps,
//! discovery answered from the broker, agent WebSocket connections pumped
//! through it, shutdown, and what the tap reports along the way. Also the
//! report recorder the other proxy modules' tests share.

use std::io::{self, Cursor, Read, Write};
use std::net::{Ipv4Addr, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::error::Error as WsError;
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::Role;
use tungstenite::{Message, WebSocket};

use super::http::MAX_HEAD;
use super::{AgentTarget, Ensure, Proxy, MAX_CONNECTIONS, MAX_UNVETTED};
use crate::browser::broker::fake::fake_browser;
use crate::browser::broker::Broker;
use crate::browser::lock;
use crate::browser::tests::{
    cdp_error, cdp_result, http_get, http_request, http_roundtrip, split_response, PEER_CHECK,
};
use crate::test_support::eventually;

/// The targets a tap reported.
#[derive(Clone, Default)]
pub(super) struct Reported(Arc<Mutex<Vec<String>>>);

impl Reported {
    pub(super) fn callback(&self) -> AgentTarget {
        let seen = Arc::clone(&self.0);
        Arc::new(move |target| lock(&seen).push(target.to_owned()))
    }

    pub(super) fn all(&self) -> Vec<String> {
        lock(&self.0).clone()
    }
}

/// A proxy that nobody listens to the agent's pages of.
fn nobody() -> AgentTarget {
    Arc::new(|_| {})
}

/// An `Ensure` that counts its calls and refuses to launch.
fn refusing_ensure() -> (Ensure, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&calls);
    let ensure: Ensure = Arc::new(move || {
        counted.fetch_add(1, Ordering::SeqCst);
        Err("must not launch".into())
    });
    (ensure, calls)
}

/// The fake Chromium's answers: discovery, page creation and attaching,
/// `Echo` (its params back), a crash on `Crash`.
fn chromium(request: &Value) -> Option<Vec<Value>> {
    let result = match request["method"].as_str().unwrap_or_default() {
        "Target.getTargets" => json!({ "targetInfos": [
            { "targetId": "B0", "type": "browser", "title": "", "url": "" },
            { "targetId": "TAB0", "type": "tab", "title": "One", "url": "about:blank" },
            { "targetId": "P1", "type": "page", "title": "One", "url": "about:blank",
              "attached": false },
        ] }),
        "Target.createTarget" => json!({ "targetId": "T9" }),
        "Target.attachToTarget" => json!({ "sessionId": "S1" }),
        "Target.activateTarget" | "Target.closeTarget" if request["params"]["targetId"] == "P1" => {
            json!({})
        }
        "Target.activateTarget" | "Target.closeTarget" => {
            return Some(vec![cdp_error(request, "No target with given id found")])
        }
        "Crash" => return None,
        _ => json!({ "echo": request["params"] }),
    };
    Some(vec![cdp_result(request, result)])
}

/// A proxy in front of `broker`.
fn serving(broker: Arc<Broker>, on_target: AgentTarget) -> Proxy {
    Proxy::bind(Arc::new(move || Ok(Arc::clone(&broker))), on_target).unwrap()
}

/// A proxy in front of a fresh [`chromium`].
fn proxy() -> Proxy {
    serving(fake_browser(chromium), nobody())
}

/// The head of a bare WebSocket upgrade to `path` (no key, no version).
fn upgrade(path: &str) -> String {
    format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n\r\n")
}

/// [`http_roundtrip`], which must reach the proxy.
fn raw_roundtrip(port: u16, request: &[u8]) -> Vec<u8> {
    http_roundtrip(port, request).unwrap()
}

/// [`http_request`], which must reach the proxy.
fn request(port: u16, method: &str, path: &str) -> (String, String) {
    http_request(port, method, path).unwrap()
}

/// The ids of the connections waiting for their head, oldest first.
fn unvetted_ids(proxy: &Proxy) -> Vec<u64> {
    lock(&proxy.shared.unvetted)
        .iter()
        .map(|(id, _)| *id)
        .collect()
}

/// A connection that sends nothing, once it waits for its head (its peer
/// check passed).
fn idle_socket(proxy: &Proxy) -> TcpStream {
    let newest = unvetted_ids(proxy).last().copied();
    let socket = TcpStream::connect((Ipv4Addr::LOCALHOST, proxy.port())).unwrap();
    let waiting = eventually(PEER_CHECK, || {
        (unvetted_ids(proxy).last().copied() != newest).then_some(())
    });
    assert!(waiting.is_some(), "the idle socket waits for its head");
    socket
}

/// Whether the proxy closed `stream` (an EOF or a reset) before its read
/// timeout ran out; a timeout means the socket is still open. Bytes that
/// arrive instead are the error.
fn closed_unanswered(stream: &mut TcpStream) -> Result<bool, String> {
    let mut buf = [0u8; 256];
    match stream.read(&mut buf) {
        Ok(0) => Ok(true),
        Ok(n) => Err(String::from_utf8_lossy(&buf[..n]).into_owned()),
        Err(e) => Ok(!timed_out(&e)),
    }
}

fn timed_out(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
    )
}

/// An agent's WebSocket to `path` through `proxy`.
fn agent_socket(proxy: &Proxy, path: &str) -> WebSocket<TcpStream> {
    let stream = TcpStream::connect((Ipv4Addr::LOCALHOST, proxy.port())).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let url = format!("ws://127.0.0.1:{}{path}", proxy.port());
    let (ws, response) = tungstenite::client(url, stream).unwrap();
    assert_eq!(response.status(), 101);
    ws
}

fn send(ws: &mut WebSocket<TcpStream>, message: &Value) {
    ws.send(Message::text(message.to_string())).unwrap();
}

/// The next text message.
fn next_text(ws: &mut WebSocket<TcpStream>) -> Value {
    loop {
        if let Message::Text(text) = ws.read().unwrap() {
            return serde_json::from_str(&text).unwrap();
        }
    }
}

/// Whether `ws` ends (closed or reset by the proxy) within its read timeout
/// without another text message.
fn ends_without_text(ws: &mut WebSocket<TcpStream>) -> bool {
    loop {
        match ws.read() {
            Ok(Message::Text(text)) => panic!("unexpected message: {text}"),
            Ok(_) => {}
            Err(WsError::Io(e)) => return !timed_out(&e),
            Err(_) => return true,
        }
    }
}

/// Refused requests get a 403 and never launch Chromium.
fn assert_forbidden(request: &[u8]) {
    let (ensure, calls) = refusing_ensure();
    let proxy = Proxy::bind(ensure, nobody()).unwrap();
    let response = raw_roundtrip(proxy.port(), request);
    assert!(
        response.starts_with(b"HTTP/1.1 403 Forbidden\r\n"),
        "{}: {response:?}",
        String::from_utf8_lossy(request)
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0, "no lazy launch");
}

#[test]
fn version_points_at_the_proxy_and_the_broker() {
    let broker = fake_browser(chromium);
    let proxy = serving(Arc::clone(&broker), nobody());
    let body = http_get(proxy.port(), "/json/version").unwrap();
    let version: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        version,
        json!({
            "Browser": "FakeChrome/1.0",
            "Protocol-Version": "1.3",
            "User-Agent": "FakeChrome",
            "V8-Version": "0.0",
            "WebKit-Version": "@0",
            "webSocketDebuggerUrl": format!(
                "ws://127.0.0.1:{}/devtools/browser/{}", proxy.port(), broker.id()
            ),
        })
    );
}

#[test]
fn the_target_list_has_the_pages_with_proxy_urls() {
    let proxy = proxy();
    let expected = json!([{
        "description": "",
        "devtoolsFrontendUrl": "",
        "id": "P1",
        "title": "One",
        "type": "page",
        "url": "about:blank",
        "webSocketDebuggerUrl": format!("ws://127.0.0.1:{}/devtools/page/P1", proxy.port()),
    }]);
    for path in ["/json", "/json/list", "/json/list?t=1"] {
        let body = http_get(proxy.port(), path).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap(),
            expected,
            "{path}"
        );
    }
}

#[test]
fn a_new_page_takes_a_put_and_its_url() {
    let created = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&created);
    let broker = fake_browser(move |request| {
        if request["method"] == "Target.createTarget" {
            lock(&seen).push(request["params"]["url"].as_str().map(str::to_owned));
        }
        chromium(request)
    });
    let proxy = serving(broker, nobody());
    let (status, body) = request(proxy.port(), "PUT", "/json/new?https://e.example/a%20b");
    assert_eq!(status, "HTTP/1.1 200 OK");
    let entry: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(entry["id"], "T9");
    assert_eq!(entry["type"], "page");
    assert_eq!(entry["url"], "https://e.example/a b");
    assert_eq!(
        entry["webSocketDebuggerUrl"],
        format!("ws://127.0.0.1:{}/devtools/page/T9", proxy.port())
    );
    let (status, _) = request(proxy.port(), "PUT", "/json/new");
    assert_eq!(status, "HTTP/1.1 200 OK");
    assert_eq!(
        *lock(&created),
        [
            Some("https://e.example/a b".to_owned()),
            Some("about:blank".to_owned())
        ]
    );
}

#[test]
fn activate_and_close_answer_like_chrome() {
    let proxy = proxy();
    assert_eq!(
        request(proxy.port(), "GET", "/json/activate/P1"),
        ("HTTP/1.1 200 OK".to_owned(), "Target activated".to_owned())
    );
    assert_eq!(
        request(proxy.port(), "GET", "/json/close/P1"),
        ("HTTP/1.1 200 OK".to_owned(), "Target is closing".to_owned())
    );
    for path in ["/json/activate/nope", "/json/close/nope"] {
        assert_eq!(
            request(proxy.port(), "GET", path),
            (
                "HTTP/1.1 404 Not Found".to_owned(),
                "No such target id: nope".to_owned()
            ),
            "{path}"
        );
    }
}

#[test]
fn unknown_endpoints_and_bad_upgrades_never_launch() {
    let (ensure, calls) = refusing_ensure();
    let proxy = Proxy::bind(ensure, nobody()).unwrap();
    for (method, path, status) in [
        (
            "GET",
            "/json/new?about:blank",
            "HTTP/1.1 405 Method Not Allowed",
        ),
        ("GET", "/json/protocol", "HTTP/1.1 404 Not Found"),
        ("GET", "/json/activate/", "HTTP/1.1 404 Not Found"),
    ] {
        assert_eq!(request(proxy.port(), method, path).0, status, "{path}");
    }
    let key = "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n";
    let version = "Sec-WebSocket-Version: 13\r\n";
    for (path, headers, status) in [
        ("/x", format!("{key}{version}"), "HTTP/1.1 404 Not Found"),
        (
            "/devtools/page/",
            format!("{key}{version}"),
            "HTTP/1.1 404 Not Found",
        ),
        (
            "/devtools/browser/x",
            String::new(),
            "HTTP/1.1 400 Bad Request",
        ),
        (
            "/devtools/browser/x",
            key.to_owned(),
            "HTTP/1.1 400 Bad Request",
        ),
        (
            "/devtools/browser/x",
            version.to_owned(),
            "HTTP/1.1 400 Bad Request",
        ),
        (
            "/devtools/browser/x",
            format!("{key}Sec-WebSocket-Version: 8\r\n"),
            "HTTP/1.1 400 Bad Request",
        ),
    ] {
        let head = format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n{headers}\r\n"
        );
        let (got, _) = split_response(&raw_roundtrip(proxy.port(), head.as_bytes()));
        assert_eq!(got, status, "{path} {headers}");
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0, "no lazy launch");
}

/// The proxy asks `ensure` on every admitted connection, concurrently: a
/// slow launch holds no other connection back (launching once is
/// `Slot::ensure`'s job).
#[test]
fn concurrent_discoveries_through_one_slow_ensure_all_succeed() {
    let broker = fake_browser(chromium);
    let calls = Arc::new(AtomicUsize::new(0));
    let c = Arc::clone(&calls);
    let ensure: Ensure = Arc::new(move || {
        c.fetch_add(1, Ordering::SeqCst);
        thread::sleep(Duration::from_millis(200));
        Ok(Arc::clone(&broker))
    });
    let proxy = Proxy::bind(ensure, nobody()).unwrap();
    let handles: Vec<_> = (0..5)
        .map(|_| {
            let p = proxy.port();
            thread::spawn(move || http_get(p, "/json/version"))
        })
        .collect();
    for h in handles {
        let body = h.join().unwrap().unwrap();
        assert!(body.contains("webSocketDebuggerUrl"), "{body}");
    }
    assert_eq!(calls.load(Ordering::SeqCst), 5);
}

#[test]
fn a_foreign_host_never_launches_on_any_path() {
    for target in ["/json/version", "/x", "/devtools/browser/x"] {
        let request = format!(
            "GET {target} HTTP/1.1\r\nHost: attacker.example:9222\r\nUpgrade: websocket\r\n\r\n"
        );
        assert_forbidden(request.as_bytes());
    }
    assert_forbidden(b"PUT /json/new?about:blank HTTP/1.1\r\nHost: attacker.example\r\n\r\n");
}

#[test]
fn a_request_from_a_web_page_never_launches() {
    for header in [
        "Origin: http://127.0.0.1",
        "origin: null",
        "Sec-Fetch-Site: cross-site",
        "Sec-Fetch-Dest: image",
        "sec-fetch-user: ?1",
    ] {
        for target in ["/json/version", "/devtools/browser/x"] {
            let request = format!(
                "GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n{header}\r\n\r\n"
            );
            assert_forbidden(request.as_bytes());
        }
    }
}

#[test]
fn node_fetch_metadata_alone_is_admitted() {
    // Node's `fetch` sends `Sec-Fetch-Mode: cors` and nothing else of the
    // fetch metadata; puppeteer's discovery may run there.
    let proxy = proxy();
    let response = raw_roundtrip(
        proxy.port(),
        b"GET /json/version HTTP/1.1\r\nHost: 127.0.0.1\r\nsec-fetch-mode: cors\r\n\r\n",
    );
    assert!(response.starts_with(b"HTTP/1.1 200 OK\r\n"), "{response:?}");
}

#[test]
fn only_discovery_may_skip_the_websocket_upgrade() {
    for request in [
        "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        "GET /devtools/browser/x HTTP/1.1\r\nHost: localhost\r\n\r\n",
        "GET /x HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: h2c\r\n\r\n",
        "GET /x HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: upgrade\r\n\r\n",
    ] {
        assert_forbidden(request.as_bytes());
    }
}

#[test]
fn discovery_rejects_duplicate_host_before_ensure() {
    assert_forbidden(b"GET /json/version HTTP/1.1\r\nHost: localhost\r\nhOsT: 127.0.0.1\r\n\r\n");
}

#[test]
fn missing_or_malformed_host_is_rejected_before_ensure() {
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
        for target in ["/json/version", "/devtools/browser/x"] {
            let request = format!("GET {target} HTTP/1.1\r\nUpgrade: websocket\r\n{host}\r\n");
            assert_forbidden(request.as_bytes());
        }
    }
}

#[test]
fn absolute_form_target_is_rejected_before_ensure() {
    assert_forbidden(b"GET http://localhost/json/version HTTP/1.1\r\nHost: localhost\r\n\r\n");
}

#[test]
fn discovery_accepts_loopback_authorities_with_any_port() {
    let proxy = proxy();
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
            "ws://127.0.0.1:{}/devtools/browser/",
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
    let (ensure, calls) = refusing_ensure();
    // A head timeout far beyond the test: only the size cap can close it.
    let proxy = Proxy::bind_with(ensure, nobody(), Duration::from_secs(60)).unwrap();
    let mut request = b"GET /json HTTP/1.1\r\nHost: localhost\r\nX: ".to_vec();
    request.resize(MAX_HEAD + 100, b'a');
    let mut s = TcpStream::connect((Ipv4Addr::LOCALHOST, proxy.port())).unwrap();
    s.set_read_timeout(Some(PEER_CHECK)).unwrap();
    s.write_all(&request).unwrap();
    assert_eq!(closed_unanswered(&mut s), Ok(true));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn admitted_connections_over_the_cap_are_refused_until_one_closes() {
    let proxy = proxy();
    // Live WebSockets: each holds a slot until it closes.
    let mut sockets: Vec<_> = (0..MAX_CONNECTIONS)
        .map(|_| agent_socket(&proxy, "/devtools/browser/x"))
        .collect();
    let full = eventually(Duration::from_secs(3), || {
        (proxy.shared.connections.load(Ordering::SeqCst) == MAX_CONNECTIONS).then_some(())
    });
    assert!(full.is_some(), "every WebSocket holds a slot");
    let refused = raw_roundtrip(
        proxy.port(),
        b"GET /json/version HTTP/1.1\r\nHost: localhost\r\n\r\n",
    );
    assert!(
        refused.starts_with(b"HTTP/1.1 503 Service Unavailable\r\n"),
        "{}",
        String::from_utf8_lossy(&refused)
    );
    drop(sockets.pop());
    let served = eventually(Duration::from_secs(3), || {
        http_get(proxy.port(), "/json/version")
            .ok()
            .filter(|body| body.contains("webSocketDebuggerUrl"))
    });
    assert!(served.is_some(), "a freed slot serves again");
    drop(sockets);
}

#[test]
fn idle_sockets_never_starve_the_agent() {
    let proxy = proxy();
    // Twice as many sockets that never send a head as may wait for one,
    // more than the connection cap too; each connects once the one before
    // waits, so they wait in connection order.
    let mut idle: Vec<TcpStream> = (0..2 * MAX_UNVETTED.max(MAX_CONNECTIONS))
        .map(|_| idle_socket(&proxy))
        .collect();
    let body = http_get(proxy.port(), "/json/version").unwrap();
    assert!(
        body.contains("webSocketDebuggerUrl"),
        "served at once: {body}"
    );
    // The longest waiting were cut to make room; the newest still wait.
    let cut = idle.len() - MAX_UNVETTED + 1; // the agent's took one more
    for (i, s) in idle[..cut].iter_mut().enumerate() {
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        assert_eq!(closed_unanswered(s), Ok(true), "idle socket {i}");
    }
    let newest = idle.last_mut().unwrap();
    newest
        .set_read_timeout(Some(Duration::from_millis(200)))
        .unwrap();
    assert_eq!(closed_unanswered(newest), Ok(false));
}

/// Another OS user's connection gets nothing and is closed before its head
/// is read; it never launches Chromium, and never waits among (or cuts)
/// the connections of our user that wait for their head.
#[test]
fn a_foreign_peer_is_closed_unanswered_and_displaces_no_one() {
    let (ensure, calls) = refusing_ensure();
    // A head timeout far beyond the test: only a cut ends an idle socket.
    let proxy = Proxy::bind_with(ensure, nobody(), Duration::from_secs(60)).unwrap();
    let mut ours: Vec<TcpStream> = (0..MAX_UNVETTED).map(|_| idle_socket(&proxy)).collect();
    let waiting = unvetted_ids(&proxy);
    proxy.shared.force_foreign.store(true, Ordering::SeqCst);
    for i in 0..=MAX_UNVETTED {
        let mut foreign = TcpStream::connect((Ipv4Addr::LOCALHOST, proxy.port())).unwrap();
        foreign.set_read_timeout(Some(PEER_CHECK)).unwrap();
        // The proxy may have closed it already.
        let _ = foreign.write_all(b"GET /json/version HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        assert_eq!(closed_unanswered(&mut foreign), Ok(true), "foreign {i}");
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0, "no lazy launch");
    assert_eq!(unvetted_ids(&proxy), waiting, "the same connections wait");
    for (i, s) in ours.iter_mut().enumerate() {
        s.set_read_timeout(Some(Duration::from_millis(200)))
            .unwrap();
        assert_eq!(closed_unanswered(s), Ok(false), "our socket {i}");
    }
}

/// A client in another process of our OS user: the peer check goes through
/// the other process's token (and creation time), not our own pid.
#[cfg(windows)]
#[test]
fn a_client_in_another_process_of_ours_is_served() {
    let Some(root) = std::env::var_os("SystemRoot") else {
        eprintln!("skipped: %SystemRoot% is not set");
        return;
    };
    let curl = std::path::Path::new(&root).join(r"System32\curl.exe");
    if !curl.is_file() {
        eprintln!("skipped: no {}", curl.display());
        return;
    }
    let proxy = proxy();
    let output = std::process::Command::new(&curl)
        .args([
            "-s",
            "--max-time",
            "20",
            "-w",
            "\n%{http_code}",
            &format!("http://127.0.0.1:{}/json/version", proxy.port()),
        ])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "curl failed: {output:?}");
    let (body, status) = stdout.rsplit_once('\n').unwrap_or_default();
    assert_eq!(status, "200", "{stdout}");
    let version: Value = serde_json::from_str(body).unwrap();
    assert!(version["webSocketDebuggerUrl"].is_string(), "{body}");
}

#[test]
fn finished_connections_are_untracked() {
    let proxy = proxy();
    for _ in 0..3 {
        http_get(proxy.port(), "/json/version").unwrap();
    }
    let _ = raw_roundtrip(proxy.port(), upgrade("/x").as_bytes());
    let _ = raw_roundtrip(proxy.port(), b"GET /x HTTP/1.1\r\n\r\n");
    let mut ws = agent_socket(&proxy, "/devtools/browser/x");
    send(&mut ws, &json!({ "id": 1, "method": "Echo", "params": {} }));
    next_text(&mut ws);
    ws.close(None).unwrap();
    drop(ws);
    let drained = eventually(Duration::from_secs(3), || {
        let idle = proxy.shared.live().is_empty()
            && lock(&proxy.shared.unvetted).is_empty()
            && proxy.shared.connections.load(Ordering::SeqCst) == 0;
        idle.then_some(())
    });
    assert!(
        drained.is_some(),
        "closed connections must leave the live map and free their slots"
    );
}

#[test]
fn trickled_head_is_cut_at_the_absolute_deadline() {
    let (ensure, _) = refusing_ensure();
    let proxy = Proxy::bind_with(ensure, nobody(), Duration::from_millis(300)).unwrap();
    let mut s = TcpStream::connect((Ipv4Addr::LOCALHOST, proxy.port())).unwrap();
    let mut writer = s.try_clone().unwrap();
    // One byte every 100 ms for 10 s: each read arrives well inside a
    // per-read timeout of 300 ms, yet the head never completes.
    let trickle = thread::spawn(move || {
        for _ in 0..100 {
            if writer.write_all(b"a").is_err() {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
    });
    // The deadline runs from when the head is awaited, after the peer
    // check, however long that took.
    let awaited = eventually(PEER_CHECK, || {
        (!unvetted_ids(&proxy).is_empty()).then(Instant::now)
    });
    let awaited = awaited.expect("the head is awaited");
    s.set_read_timeout(Some(PEER_CHECK)).unwrap();
    let closed = closed_unanswered(&mut s);
    assert!(
        closed == Ok(true),
        "proxy must close the connection, not time out the client"
    );
    assert!(
        awaited.elapsed() < Duration::from_secs(2),
        "closed late: {:?}",
        awaited.elapsed()
    );
    trickle.join().unwrap();
}

#[test]
fn shutdown_cuts_live_websockets() {
    let proxy = proxy();
    let mut ws = agent_socket(&proxy, "/devtools/browser/x");
    let tracked = eventually(Duration::from_secs(3), || {
        (proxy.shared.live().len() == 1).then_some(())
    });
    assert!(tracked.is_some(), "the agent's socket is tracked");
    proxy.shutdown();
    ws.get_mut()
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    // A timeout here would mean the WebSocket outlived the shutdown.
    assert!(ends_without_text(&mut ws), "socket cut");
    let mut buf = [0u8; 64];
    // The accept loop is gone: a new connection is refused or closed at once.
    match TcpStream::connect(("127.0.0.1", proxy.port())) {
        Err(_) => {}
        Ok(mut late) => {
            // macOS fails `setsockopt` with EINVAL once the peer has reset
            // the connection, which is exactly the "closed at once" case.
            match late.set_read_timeout(Some(Duration::from_secs(2))) {
                Ok(()) => {}
                Err(error) => {
                    #[cfg(target_os = "macos")]
                    if error.raw_os_error() == Some(libc::EINVAL) {
                        return;
                    }
                    panic!("unexpected read-timeout error: {error}");
                }
            }
            let _ = late.write_all(b"GET /json/version HTTP/1.1\r\nHost: localhost\r\n\r\n");
            assert!(
                matches!(late.read(&mut buf), Ok(0) | Err(_)),
                "no service after shutdown"
            );
        }
    }
}

#[test]
fn a_websocket_round_trips_through_the_broker() {
    let proxy = proxy();
    let mut ws = agent_socket(&proxy, "/devtools/browser/x");
    send(
        &mut ws,
        &json!({ "id": 7, "method": "Echo", "params": { "n": 1 } }),
    );
    assert_eq!(
        next_text(&mut ws),
        json!({ "id": 7, "result": { "echo": { "n": 1 } } })
    );
    // What the broker refuses is answered on the socket, as Chromium would.
    ws.send(Message::text("not json")).unwrap();
    assert!(next_text(&mut ws)["error"].is_object());
}

#[test]
fn a_utf8_binary_message_passes_as_text_and_any_other_closes_with_1003() {
    let proxy = proxy();
    let mut ws = agent_socket(&proxy, "/devtools/browser/x");
    ws.send(Message::binary(
        br#"{"id":3,"method":"Echo","params":{"n":3}}"#.to_vec(),
    ))
    .unwrap();
    assert_eq!(
        next_text(&mut ws),
        json!({ "id": 3, "result": { "echo": { "n": 3 } } })
    );
    ws.send(Message::binary(vec![0xFF, 0xFE])).unwrap();
    let close = loop {
        match ws.read() {
            Ok(Message::Close(frame)) => break frame,
            Ok(Message::Text(text)) => panic!("unexpected message: {text}"),
            Ok(_) => {}
            Err(e) => panic!("no close frame: {e}"),
        }
    };
    assert_eq!(close.map(|frame| frame.code), Some(CloseCode::Unsupported));
}

#[test]
fn frames_sent_with_the_upgrade_head_are_not_lost() {
    let proxy = proxy();
    // A client frame, encoded by a client WebSocket writing to memory.
    let mut encoder = WebSocket::from_raw_socket(Cursor::new(Vec::new()), Role::Client, None);
    encoder
        .send(Message::text(
            r#"{"id":1,"method":"Echo","params":{"n":2}}"#,
        ))
        .unwrap();
    let frame = std::mem::take(encoder.get_mut().get_mut());
    let head = "GET /devtools/browser/x HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n\
                Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\
                Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n";
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, proxy.port())).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
        .write_all(&[head.as_bytes(), frame.as_slice()].concat())
        .unwrap();
    // The response head, byte by byte so no frame is read past it.
    let mut response = Vec::new();
    let mut byte = [0u8; 1];
    while !response.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).unwrap();
        response.push(byte[0]);
    }
    let response = String::from_utf8(response).unwrap();
    assert!(
        response.starts_with("HTTP/1.1 101 Switching Protocols\r\n"),
        "{response}"
    );
    assert!(
        response.contains("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n"),
        "{response}"
    );
    let mut ws = WebSocket::from_raw_socket(stream, Role::Client, None);
    assert_eq!(next_text(&mut ws)["result"]["echo"]["n"], 2);
}

#[test]
fn two_agents_are_isolated() {
    let proxy = proxy();
    let mut a = agent_socket(&proxy, "/devtools/browser/x");
    let mut b = agent_socket(&proxy, "/devtools/browser/x");
    send(
        &mut a,
        &json!({ "id": 1, "method": "Echo", "params": { "who": "a" } }),
    );
    send(
        &mut b,
        &json!({ "id": 1, "method": "Echo", "params": { "who": "b" } }),
    );
    assert_eq!(next_text(&mut a)["result"]["echo"]["who"], "a");
    assert_eq!(next_text(&mut b)["result"]["echo"]["who"], "b");
    a.get_mut()
        .set_read_timeout(Some(Duration::from_millis(300)))
        .unwrap();
    match a.read() {
        Err(WsError::Io(e)) if timed_out(&e) => {}
        other => panic!("a got more: {other:?}"),
    }
}

#[test]
fn a_page_socket_works_in_its_page() {
    let reported = Reported::default();
    let proxy = serving(fake_browser(chromium), reported.callback());
    // The page is the path's, without the query.
    let mut ws = agent_socket(&proxy, "/devtools/page/P1?x=1");
    send(
        &mut ws,
        &json!({ "id": 1, "method": "Page.bringToFront", "params": {} }),
    );
    assert_eq!(next_text(&mut ws)["id"], 1);
    let _ = eventually(Duration::from_secs(3), || {
        (!reported.all().is_empty()).then_some(())
    });
    assert_eq!(reported.all(), ["P1"]);
}

#[test]
fn a_browser_crash_closes_the_socket() {
    let proxy = proxy();
    let mut ws = agent_socket(&proxy, "/devtools/browser/x");
    send(
        &mut ws,
        &json!({ "id": 1, "method": "Crash", "params": {} }),
    );
    assert!(ends_without_text(&mut ws), "the socket closes");
    // The broker is gone: discovery says so instead of hanging.
    let (status, _) = request(proxy.port(), "GET", "/json/version");
    assert_eq!(status, "HTTP/1.1 503 Service Unavailable");
}

const CREATE_TARGET: &str =
    r#"{"id":1,"method":"Target.createTarget","params":{"url":"about:blank"}}"#;

/// An agent that asks for a new page through a proxy whose Chromium sends
/// `before` ahead of the reply; returns what the tap reported once the
/// reply arrived and the messages the agent got before it.
fn agent_creates_a_page(before: Vec<Value>) -> (Vec<String>, Vec<Value>) {
    let mut before = Some(before);
    let broker = fake_browser(move |request| {
        let mut answers = if request["method"] == "Target.createTarget" {
            before.take().unwrap_or_default()
        } else {
            Vec::new()
        };
        answers.extend(chromium(request)?);
        Some(answers)
    });
    let reported = Reported::default();
    let proxy = serving(broker, reported.callback());
    let mut ws = agent_socket(&proxy, "/devtools/browser/x");
    ws.send(Message::text(CREATE_TARGET)).unwrap();
    let mut got = Vec::new();
    let reply = loop {
        let message = next_text(&mut ws);
        if message["id"] == 1 {
            break message;
        }
        got.push(message);
    };
    assert_eq!(reply["result"]["targetId"], "T9");
    // The tap is fed before the forward, but observes on its own thread.
    let _ = eventually(Duration::from_secs(1), || {
        (!reported.all().is_empty()).then_some(())
    });
    thread::sleep(Duration::from_millis(100)); // nothing more arrives
    (reported.all(), got)
}

#[test]
fn the_tap_sees_a_page_the_agent_creates() {
    let (reported, got) = agent_creates_a_page(Vec::new());
    assert_eq!(reported, ["T9"]);
    assert!(got.is_empty(), "{got:?}");
}

#[test]
fn a_large_message_does_not_switch_follow_off() {
    // Two screencast frames far bigger than the observer's queue.
    let frame =
        || json!({ "method": "Page.screencastFrame", "params": { "data": "A".repeat(6 << 20) } });
    let (reported, got) = agent_creates_a_page(vec![frame(), frame()]);
    assert_eq!(reported, ["T9"]);
    assert_eq!(got.len(), 2, "the frames were forwarded");
    assert!(got
        .iter()
        .all(|m| m["params"]["data"].as_str().map(str::len) == Some(6 << 20)));
}

const ATTACH: &str =
    r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"T1","flatten":true}}"#;
const NAVIGATE: &str =
    r#"{"id":2,"method":"Page.navigate","params":{"url":"about:blank"},"sessionId":"S1"}"#;

/// An agent that attaches to `T1` through a Chromium that answers the
/// instant the attach is in, and the moment the reply is in, works in the
/// new session. The tap must have the session by then: the reply was
/// observed after the attach, the navigate after the reply.
/// `client_push_delay_ms` slows the client-side feed of this connection
/// (0: none). Returns what the tap reported.
fn attach_then_navigate_at_once(client_push_delay_ms: u64) -> Vec<String> {
    let reported = Reported::default();
    let proxy = serving(fake_browser(chromium), reported.callback());
    proxy.set_client_push_delay_ms(client_push_delay_ms);
    let mut ws = agent_socket(&proxy, "/devtools/browser/x");
    ws.send(Message::text(ATTACH)).unwrap();
    assert_eq!(next_text(&mut ws)["result"]["sessionId"], "S1");
    ws.send(Message::text(NAVIGATE)).unwrap();
    assert_eq!(next_text(&mut ws)["sessionId"], "S1");
    let _ = eventually(Duration::from_secs(3), || {
        (!reported.all().is_empty()).then_some(())
    });
    reported.all()
}

#[test]
fn a_reply_is_observed_after_its_command_even_when_the_client_push_is_slow() {
    // Were the command queued after it was forwarded, the 150 ms delay of
    // this connection's push would let the reply (and the dependent
    // navigate) overtake it.
    assert_eq!(attach_then_navigate_at_once(150), ["T1"]);
}

#[test]
fn an_instant_reply_never_overtakes_its_command() {
    for round in 0..40 {
        assert_eq!(attach_then_navigate_at_once(0), ["T1"], "round {round}");
    }
}
