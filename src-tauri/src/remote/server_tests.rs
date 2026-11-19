use super::routes::{pair, pair_status};
use super::*;
use crate::remote::emit::{Action, RemoteEmit, Status};
use crate::remote::http::admission::Allowed;
use crate::remote::http::response::CSP;
use crate::remote::http::{read_head, HttpError, REQUEST_DEADLINE};
use crate::remote::hub::{Hub, PublishPayload, TabMeta};
use crate::remote::pairing::PairError;
use crate::remote::tls::{load_or_generate, CertSource};
use rustls::pki_types::ServerName;
use serde_json::Value;
use std::io::{self, Read, Write};
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(candidate, _)| candidate.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

struct TestServer {
    server: Server,
    dir: PathBuf,
    pairing: Arc<Pairing>,
    devices: Arc<DeviceStore>,
    hub: Arc<Hub>,
    emit: Arc<FakeEmit>,
}

/// Records actions for the test to read; answers nothing by itself.
struct FakeEmit {
    actions: Mutex<std::sync::mpsc::Receiver<Action>>,
    sender: Mutex<std::sync::mpsc::Sender<Action>>,
    /// Every `connections` call, oldest first.
    connections: Mutex<Vec<Vec<String>>>,
}

impl FakeEmit {
    fn new() -> Self {
        let (sender, actions) = std::sync::mpsc::channel();
        Self {
            actions: Mutex::new(actions),
            sender: Mutex::new(sender),
            connections: Mutex::new(Vec::new()),
        }
    }

    fn next_action(&self) -> Action {
        self.actions
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .expect("action reaches the webview")
    }

    fn try_action(&self, within: Duration) -> Option<Action> {
        self.actions.lock().unwrap().recv_timeout(within).ok()
    }

    fn connection_log(&self) -> Vec<Vec<String>> {
        self.connections.lock().unwrap().clone()
    }
}

impl RemoteEmit for FakeEmit {
    fn watch(&self, _tab_ids: &[String]) {}

    fn connections(&self, device_ids: &[String]) {
        self.connections.lock().unwrap().push(device_ids.to_vec());
    }

    fn action(&self, action: &Action) {
        let _ = self.sender.lock().unwrap().send(action.clone());
    }

    fn status(&self, _status: &Status) {}
}

#[path = "ws_tests.rs"]
mod ws_tests;

/// Test-only constructor: binds 127.0.0.1 on a free port, no interface lookup.
fn test_server_deadline(name: &str, request_deadline: Duration) -> TestServer {
    let dir = crate::test_support::tempdir("remote-server", name);
    let ip = Ipv4Addr::LOCALHOST;
    let config = load_or_generate(&dir, &CertSource::Generated, ip, None)
        .unwrap()
        .config;
    let pairing = Arc::new(Pairing::default());
    let devices = Arc::new(DeviceStore::load(dir.join("devices.json")));
    let emit = Arc::new(FakeEmit::new());
    let hub = Arc::new(Hub::new(
        Arc::clone(&devices),
        Arc::clone(&emit) as Arc<dyn RemoteEmit>,
    ));
    hub.set_ready(true);
    let server = Server::start(
        Listen {
            ip,
            port: 0,
            host_name: None,
            tls: config,
            request_deadline,
        },
        Shared {
            pairing: Arc::clone(&pairing),
            devices: Arc::clone(&devices),
            is_current: Arc::new(|| true),
            on_paired: Arc::new(|| {}),
        },
        crate::remote::ws::upgrade_fn(Arc::clone(&hub), Arc::clone(&devices), hub.generation()),
    )
    .unwrap();
    TestServer {
        server,
        dir,
        pairing,
        devices,
        hub,
        emit,
    }
}

fn test_server(name: &str) -> TestServer {
    test_server_deadline(name, REQUEST_DEADLINE)
}

impl TestServer {
    fn host(&self) -> String {
        format!("127.0.0.1:{}", self.server.local_addr().port())
    }

    fn client_config(&self) -> Arc<rustls::ClientConfig> {
        crate::test_support::tls_client_config(&self.dir.join("remote").join("cert.pem"))
    }

    fn tcp_with(&self, read_timeout: Duration) -> TcpStream {
        let tcp = TcpStream::connect(self.server.local_addr()).unwrap();
        tcp.set_read_timeout(Some(read_timeout)).unwrap();
        tcp.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
        tcp
    }

    /// Send `raw` and read the whole reply until the server closes; `None`
    /// when the connection or the TLS exchange fails.
    fn try_raw(&self, raw: &[u8]) -> Option<Vec<u8>> {
        let tcp = TcpStream::connect(self.server.local_addr()).ok()?;
        tcp.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
        tcp.set_write_timeout(Some(Duration::from_secs(5))).ok()?;
        let name = ServerName::try_from("127.0.0.1").unwrap();
        let connection = rustls::ClientConnection::new(self.client_config(), name).unwrap();
        let mut stream = rustls::StreamOwned::new(connection, tcp);
        stream.write_all(raw).ok()?;
        let mut bytes = Vec::new();
        read_all(&mut stream, &mut bytes);
        Some(bytes)
    }

    fn raw(&self, raw: &[u8]) -> Reply {
        parse_reply(&self.try_raw(raw).expect("TLS exchange with the server"))
    }

    fn get(&self, path: &str, host: &str) -> Reply {
        self.raw(format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n\r\n").as_bytes())
    }

    fn upgrade(&self, host: &str, origin: Option<&str>) -> Reply {
        let origin = origin.map_or_else(String::new, |value| format!("Origin: {value}\r\n"));
        self.raw(
            format!(
                "GET /ws HTTP/1.1\r\nHost: {host}\r\n{origin}Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
            )
            .as_bytes(),
        )
    }

    fn post_pair(&self, body: &str) -> Reply {
        self.raw(
            format!(
                "POST /pair HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                self.host(),
                body.len()
            )
            .as_bytes(),
        )
    }
}

fn read_all<R: Read>(stream: &mut R, bytes: &mut Vec<u8>) {
    let mut chunk = [0_u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => return,
            Ok(read) => bytes.extend_from_slice(&chunk[..read]),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                ) =>
            {
                panic!("unexpected read timeout in test helper: {error}");
            }
            // Peer closed without close_notify, or reset after replying.
            Err(_) => return,
        }
    }
}

fn parse_reply(bytes: &[u8]) -> Reply {
    let split = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("response head");
    let head = std::str::from_utf8(&bytes[..split]).unwrap();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers: Vec<(String, String)> = lines
        .map(|line| {
            let (name, value) = line.split_once(": ").unwrap();
            (name.to_owned(), value.to_owned())
        })
        .collect();
    let body = bytes[split + 4..].to_vec();
    if let Some((_, len)) = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
    {
        assert_eq!(body.len(), len.parse::<usize>().unwrap());
    }
    Reply {
        status,
        headers,
        body,
    }
}

#[test]
fn foreign_host_or_origin_is_refused() {
    let s = test_server("host-origin");
    assert_eq!(s.get("/", "evil.example:7470").status, 403);
    assert_eq!(s.get("/", "127.0.0.1:1").status, 403);
    assert_eq!(s.get("/", &s.host()).status, 200);
    assert_eq!(
        s.upgrade(&s.host(), Some("https://evil.example")).status,
        403
    );
    assert_eq!(
        s.upgrade(&s.host(), Some(&format!("http://{}", s.host())))
            .status,
        403,
        "an http:// origin is never accepted"
    );
    assert_eq!(s.upgrade(&s.host(), None).status, 403);
    assert_eq!(
        s.upgrade("evil.example", Some("https://evil.example"))
            .status,
        403
    );
    // Same origin passes the checks and the handshake completes (the hub is
    // not ready, so the socket is closed right after).
    s.hub.set_ready(false);
    assert_eq!(
        s.upgrade(&s.host(), Some(&format!("https://{}", s.host())))
            .status,
        101
    );
}

#[test]
fn host_name_is_accepted_with_port_and_default_ports_may_omit_it() {
    let allowed = Allowed {
        ip: Ipv4Addr::new(192, 168, 1, 5),
        port: 7470,
        host_name: Some("omp.home.lan".to_owned()),
    };
    let head = |host: &str| {
        let raw = format!("GET / HTTP/1.1\r\nHost: {host}\r\n\r\n");
        let mut bytes = raw.as_bytes();
        read_head(
            &mut bytes,
            &|_| Ok(()),
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap()
        .0
    };
    assert!(allowed.host_ok(&head("192.168.1.5:7470")));
    assert!(allowed.host_ok(&head("OMP.home.lan:7470")));
    assert!(!allowed.host_ok(&head("omp.home.lan")));
    assert!(!allowed.host_ok(&head("omp.home.lan:7471")));
    assert!(!allowed.host_ok(&head("omp.home.lan:+7470")));
    assert!(!allowed.host_ok(&head("evil.example:7470")));
    let default_port = Allowed {
        port: 443,
        ..allowed
    };
    assert!(default_port.host_ok(&head("omp.home.lan")));
    assert!(default_port.host_ok(&head("omp.home.lan:443")));
}

#[test]
fn static_assets_are_served_with_csp_and_no_store() {
    let s = test_server("assets");
    let cases = [
        ("/", "text/html; charset=utf-8"),
        ("/index.html", "text/html; charset=utf-8"),
        ("/remote.js", "text/javascript; charset=utf-8"),
        ("/client.js", "text/javascript; charset=utf-8"),
        ("/scanner.js", "text/javascript; charset=utf-8"),
        ("/sessions.js", "text/javascript; charset=utf-8"),
        ("/transcript.js", "text/javascript; charset=utf-8"),
        ("/jsQR.js", "text/javascript; charset=utf-8"),
        ("/sw.js", "text/javascript; charset=utf-8"),
        ("/remote.css", "text/css; charset=utf-8"),
        ("/styles.css", "text/css; charset=utf-8"),
        ("/chat.css", "text/css; charset=utf-8"),
        ("/ask.css", "text/css; charset=utf-8"),
        ("/composer.css", "text/css; charset=utf-8"),
        ("/accent.js", "text/javascript; charset=utf-8"),
        ("/ask-dialog.js", "text/javascript; charset=utf-8"),
        ("/scroll-pin.js", "text/javascript; charset=utf-8"),
        ("/manifest.json", "application/manifest+json"),
        ("/marked.min.js", "text/javascript; charset=utf-8"),
        ("/highlight.min.js", "text/javascript; charset=utf-8"),
        ("/marked-setup.js", "text/javascript; charset=utf-8"),
    ];
    for (path, content_type) in cases {
        let reply = s.get(path, &s.host());
        assert_eq!(reply.status, 200, "{path}");
        assert_eq!(reply.header("content-type"), Some(content_type), "{path}");
        assert_eq!(reply.header("cache-control"), Some("no-store"), "{path}");
        assert_eq!(reply.header("content-security-policy"), Some(CSP), "{path}");
        assert!(!reply.body.is_empty(), "{path}");
    }
    let index = s.get("/", &s.host());
    assert_eq!(index.body, include_bytes!("../../../src/remote/index.html"));
    assert_eq!(
        s.get("/marked-setup.js", &s.host()).body,
        include_bytes!("../../../src/app/marked-setup.js")
    );
    assert_eq!(
        s.get("/jsQR.js", &s.host()).body,
        include_bytes!("../../../src/remote/jsQR.js")
    );
    for path in ["/nope", "/ws", "/../Cargo.toml", "/remote.js.map", "/pair"] {
        assert_eq!(s.get(path, &s.host()).status, 404, "{path}");
    }
    let missing = s.get("/nope", &s.host());
    assert_eq!(missing.header("cache-control"), Some("no-store"));
    assert_eq!(missing.header("content-security-policy"), Some(CSP));
    assert_eq!(
        s.raw(format!("DELETE / HTTP/1.1\r\nHost: {}\r\n\r\n", s.host()).as_bytes())
            .status,
        405
    );
}

#[test]
fn pairing_issues_a_token_once_and_rate_limits_bad_attempts() {
    let s = test_server("pairing");
    let code = s.pairing.start(Instant::now()).unwrap();
    let body = serde_json::json!({ "code": code, "name": "  Phone  " }).to_string();
    let reply = s.post_pair(&body);
    assert_eq!(reply.status, 200);
    assert_eq!(reply.header("content-type"), Some("application/json"));
    let json: serde_json::Value = serde_json::from_slice(&reply.body).unwrap();
    let token = json["token"].as_str().unwrap();
    let device = s.devices.authenticate(token).expect("token authenticates");
    assert_eq!(json["deviceId"], device.id);
    assert_eq!(device.name, "Phone");
    // One use only.
    assert_eq!(s.post_pair(&body).status, 403);
    // Malformed input is 400 and does not count as a code guess.
    assert_eq!(s.post_pair("not json").status, 400);
    assert_eq!(s.post_pair(r#"{"code":"x","name":""}"#).status, 400);
    let oversized = serde_json::json!({ "code": "x", "name": "y".repeat(5000) }).to_string();
    assert_eq!(s.post_pair(&oversized).status, 413);
    assert_eq!(
        s.raw(format!("POST /pair HTTP/1.1\r\nHost: {}\r\n\r\n", s.host()).as_bytes())
            .status,
        411
    );
    assert_eq!(
        s.raw(
            format!(
                "POST /pair HTTP/1.1\r\nHost: {}\r\nOrigin: https://evil.example\r\nContent-Length: 2\r\n\r\n{{}}",
                s.host()
            )
            .as_bytes()
        )
        .status,
        403
    );
    // Four more bad codes complete five failures (one above) → sixth is limited.
    let bad = r#"{"code":"wrong","name":"Phone"}"#;
    for _ in 0..4 {
        assert_eq!(s.post_pair(bad).status, 403);
    }
    let limited = s.post_pair(bad);
    assert_eq!(limited.status, 429);
    assert_eq!(limited.header("retry-after"), Some("60"));
    // A valid code from the limited peer is refused too.
    let fresh = s.pairing.start(Instant::now()).unwrap();
    let fresh_body = serde_json::json!({ "code": fresh, "name": "Phone" }).to_string();
    assert_eq!(s.post_pair(&fresh_body).status, 429);
}

#[test]
fn pair_errors_map_to_http_statuses() {
    assert_eq!(pair_status(&PairError::Invalid), 403);
    assert_eq!(pair_status(&PairError::Expired), 410);
    assert_eq!(pair_status(&PairError::RateLimited), 429);
}

#[test]
fn the_wildcard_address_is_refused() {
    let error = bind(Ipv4Addr::UNSPECIFIED, 0).unwrap_err();
    assert!(error.contains("0.0.0.0"), "{error}");
    let dir = crate::test_support::tempdir("remote-server", "wildcard");
    let tls = load_or_generate(&dir, &CertSource::Generated, Ipv4Addr::LOCALHOST, None)
        .unwrap()
        .config;
    let result = Server::start(
        Listen {
            ip: Ipv4Addr::UNSPECIFIED,
            port: 0,
            host_name: None,
            tls,
            request_deadline: REQUEST_DEADLINE,
        },
        Shared {
            pairing: Arc::new(Pairing::default()),
            devices: Arc::new(DeviceStore::load(dir.join("devices.json"))),
            is_current: Arc::new(|| true),
            on_paired: Arc::new(|| {}),
        },
        Arc::new(|_, _| {}),
    );
    assert!(result.is_err());
}

#[test]
fn real_tls_handshake_with_the_generated_certificate() {
    let s = test_server("tls");
    let name = ServerName::try_from("127.0.0.1").unwrap();
    // Trusting the generated leaf: handshake and request succeed.
    assert_eq!(s.get("/", &s.host()).status, 200);
    // Trusting nothing: the handshake must fail.
    let untrusted = Arc::new(
        rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(rustls::RootCertStore::empty())
        .with_no_client_auth(),
    );
    let tcp = TcpStream::connect(s.server.local_addr()).unwrap();
    tcp.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let connection = rustls::ClientConnection::new(untrusted, name).unwrap();
    let mut stream = rustls::StreamOwned::new(connection, tcp);
    let _ = stream.write_all(b"GET / HTTP/1.1\r\n\r\n");
    let mut bytes = Vec::new();
    read_all(&mut stream, &mut bytes);
    assert_eq!(bytes.len(), 0);
    // Plaintext to the TLS port gets no HTTP answer.
    let mut plain = TcpStream::connect(s.server.local_addr()).unwrap();
    plain
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    plain
        .write_all(format!("GET / HTTP/1.1\r\nHost: {}\r\n\r\n", s.host()).as_bytes())
        .unwrap();
    let mut answer = Vec::new();
    read_all(&mut plain, &mut answer);
    assert!(!answer.starts_with(b"HTTP/"));
}

struct Stalled;

impl Read for Stalled {
    fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
        Err(io::ErrorKind::WouldBlock.into())
    }
}

#[test]
fn oversized_and_slow_heads_are_bounded() {
    let s = test_server("bounds");
    let huge = format!(
        "GET / HTTP/1.1\r\nHost: {}\r\nX-Pad: {}\r\n\r\n",
        s.host(),
        "a".repeat(20 * 1024)
    );
    assert_eq!(s.raw(huge.as_bytes()).status, 431);
    assert_eq!(s.raw(b"garbage\r\n\r\n").status, 400);
    let duplicate = format!("GET / HTTP/1.1\r\nHost: {0}\r\nHost: {0}\r\n\r\n", s.host());
    assert_eq!(s.raw(duplicate.as_bytes()).status, 400);

    // A stalled reader times out; so does an already-expired deadline.
    let result = read_head(
        &mut Stalled,
        &|_| Ok(()),
        Instant::now() + Duration::from_secs(1),
    );
    assert_eq!(result.unwrap_err(), HttpError::Timeout);
    let mut bytes: &[u8] = b"GET / HTTP/1.1\r\n\r\n";
    let result = read_head(&mut bytes, &|_| Ok(()), Instant::now());
    assert_eq!(result.unwrap_err(), HttpError::Timeout);
}

#[test]
fn a_dribbling_client_hits_the_absolute_deadline() {
    // Each byte arrives in time, but the sum exceeds the deadline.
    struct Dribble;
    impl Read for Dribble {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            std::thread::sleep(Duration::from_millis(60));
            buf[0] = b'a';
            Ok(1)
        }
    }
    let started = Instant::now();
    let result = read_head(
        &mut Dribble,
        &|_| Ok(()),
        Instant::now() + Duration::from_millis(300),
    );
    assert_eq!(result.unwrap_err(), HttpError::Timeout);
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn a_dribbled_tls_handshake_is_cut_at_the_deadline_without_an_answer() {
    let s = test_server_deadline("tls-dribble", Duration::from_secs(1));
    let name = ServerName::try_from("127.0.0.1").unwrap();
    let mut client = rustls::ClientConnection::new(s.client_config(), name).unwrap();
    let mut hello = Vec::new();
    client.write_tls(&mut hello).unwrap();
    let mut tcp = TcpStream::connect(s.server.local_addr()).unwrap();
    tcp.set_read_timeout(Some(Duration::from_millis(20)))
        .unwrap();
    let started = Instant::now();
    let mut received = Vec::new();
    let mut closed = false;
    for byte in &hello {
        if tcp.write_all(&[*byte]).is_err() {
            closed = true;
            break;
        }
        let mut chunk = [0_u8; 64];
        let wait = Instant::now() + Duration::from_millis(200);
        while Instant::now() < wait {
            match tcp.read(&mut chunk) {
                Ok(0) => closed = true,
                Ok(read) => received.extend_from_slice(&chunk[..read]),
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) => {}
                Err(_) => closed = true,
            }
            if closed {
                break;
            }
        }
        if closed || started.elapsed() > Duration::from_secs(4) {
            break;
        }
    }
    assert!(closed, "server kept a dribbling handshake open");
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    assert!(
        received.is_empty(),
        "no 408 or TLS alert before the handshake ends"
    );
}

#[test]
fn connections_over_the_in_flight_caps_are_closed_at_once() {
    let in_flight = InFlight::new(3, 2);
    let (a, b) = (IpAddr::from([10, 0, 0, 1]), IpAddr::from([10, 0, 0, 2]));
    let first = in_flight.admit(a).unwrap();
    let _second = in_flight.admit(a).unwrap();
    assert!(in_flight.admit(a).is_none(), "per-peer cap");
    let _third = in_flight.admit(b).unwrap();
    assert!(
        in_flight.admit(IpAddr::from([10, 0, 0, 3])).is_none(),
        "total cap"
    );
    drop(first);
    assert!(in_flight.admit(a).is_some(), "a released slot is reusable");

    // End to end: idle sockets pin slots; the next one is closed unanswered.
    let s = test_server("caps");
    let idle: Vec<TcpStream> = (0..MAX_IN_FLIGHT_PER_IP)
        .map(|_| TcpStream::connect(s.server.local_addr()).unwrap())
        .collect();
    // Let the accept loop take them all.
    std::thread::sleep(Duration::from_millis(500));
    let mut over = TcpStream::connect(s.server.local_addr()).unwrap();
    over.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let mut byte = [0_u8; 1];
    let closed = match over.read(&mut byte) {
        Ok(0) => true,
        Err(error) => !crate::remote::ws::is_idle(&error),
        Ok(_) => false,
    };
    assert!(closed, "over-cap socket is closed");
    drop(idle);
    let served = crate::test_support::eventually(Duration::from_secs(5), || {
        let request = format!("GET / HTTP/1.1\r\nHost: {}\r\n\r\n", s.host());
        let bytes = s.try_raw(request.as_bytes())?;
        bytes.starts_with(b"HTTP/1.1 200").then_some(())
    });
    assert!(served.is_some(), "slots free up when clients leave");
}

#[test]
fn a_real_phone_user_agent_prefix_is_accepted_and_cut_to_64_chars() {
    let s = test_server("long-name");
    let agent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
    let prefix: String = agent.chars().take(120).collect();
    assert_eq!(prefix.chars().count(), 120);
    let code = s.pairing.start(Instant::now()).unwrap();
    let body = serde_json::json!({ "code": code, "name": prefix }).to_string();
    assert_eq!(s.post_pair(&body).status, 200);
    let device = s.devices.list().remove(0);
    assert_eq!(device.name, prefix.chars().take(64).collect::<String>());
}

#[test]
fn dropping_the_server_returns_promptly() {
    let s = test_server("drop");
    let started = Instant::now();
    drop(s.server);
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn pair_of_a_replaced_server_is_refused_and_a_pairing_calls_the_hook() {
    let dir = crate::test_support::tempdir("remote-server", "stale-pair");
    let pairing = Arc::new(Pairing::default());
    let devices = Arc::new(DeviceStore::load(dir.join("devices.json")));
    let current = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let paired = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let shared = Shared {
        pairing: Arc::clone(&pairing),
        devices: Arc::clone(&devices),
        is_current: {
            let current = Arc::clone(&current);
            Arc::new(move || current.load(Ordering::SeqCst))
        },
        on_paired: {
            let paired = Arc::clone(&paired);
            Arc::new(move || {
                paired.fetch_add(1, Ordering::SeqCst);
            })
        },
    };
    let peer: IpAddr = "127.0.0.1".parse().unwrap();
    let code = pairing.start(Instant::now()).unwrap();
    let body = format!(r#"{{"code":"{code}","name":"Phone"}}"#);
    current.store(false, Ordering::SeqCst);
    assert_eq!(pair(&shared, body.as_bytes(), peer).status, 503);
    assert!(devices.list().is_empty());
    assert_eq!(paired.load(Ordering::SeqCst), 0);
    // The code was not burnt by the refused request.
    current.store(true, Ordering::SeqCst);
    assert_eq!(pair(&shared, body.as_bytes(), peer).status, 200);
    assert_eq!(devices.list().len(), 1);
    assert_eq!(paired.load(Ordering::SeqCst), 1);
}
