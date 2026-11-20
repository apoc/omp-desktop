use super::*;
use crate::remote::devices::unix_seconds;
use crate::remote::emit::Action;
use crate::remote::settings::CertSetting;
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::mpsc;

#[derive(Default)]
struct FakeEmit {
    statuses: Mutex<Vec<Status>>,
}

impl RemoteEmit for FakeEmit {
    fn watch(&self, _tab_ids: &[String]) {}
    fn connections(&self, _device_ids: &[String]) {}
    fn action(&self, _action: &Action) {}
    fn status(&self, status: &Status) {
        self.statuses.lock().unwrap().push(status.clone());
    }
}

type Ifaces = Arc<Mutex<Vec<Iface>>>;

fn iface(name: &str, ip: &str) -> Iface {
    Iface {
        name: name.to_owned(),
        ip: ip.parse().unwrap(),
    }
}

fn manager(name: &str, ifaces: &Ifaces) -> (RemoteManager, Arc<FakeEmit>, PathBuf) {
    let dir = crate::test_support::tempdir("remote-manager", name);
    let (manager, emit) = manager_in(&dir, ifaces);
    (manager, emit, dir)
}

fn manager_in(dir: &Path, ifaces: &Ifaces) -> (RemoteManager, Arc<FakeEmit>) {
    let emit = Arc::new(FakeEmit::default());
    let list = Arc::clone(ifaces);
    let manager = RemoteManager::with_source(
        dir.to_path_buf(),
        Arc::clone(&emit) as Arc<dyn RemoteEmit>,
        Arc::new(move || Ok(list.lock().unwrap().clone())),
        Duration::from_millis(20),
    );
    (manager, emit)
}

fn loopback() -> Ifaces {
    Arc::new(Mutex::new(vec![iface("en0", "127.0.0.1")]))
}

fn enabled(port: u16) -> RemoteSettings {
    RemoteSettings {
        enabled: true,
        interface: Some("en0".to_owned()),
        port,
        ..RemoteSettings::default()
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// Apply an enabled config on a port that was free a moment ago. Another
/// test thread can grab the port between `free_port` and the bind (Windows
/// hands out just-closed ephemeral ports quickly), so retry on a fresh one.
fn start_on_a_free_port(manager: &RemoteManager) -> u16 {
    let mut last = None;
    for _ in 0..5 {
        let port = free_port();
        let status = manager.apply(enabled(port)).unwrap();
        if status.listening {
            return port;
        }
        last = status.error;
    }
    panic!("no free port could be bound: {last:?}");
}

fn wait_until(what: &str, condition: impl FnMut() -> bool) {
    assert!(
        crate::test_support::wait_until(Duration::from_secs(5), condition),
        "timed out waiting for {what}"
    );
}

fn reachable(ip: &str, port: u16) -> bool {
    let address = SocketAddr::new(ip.parse().unwrap(), port);
    TcpStream::connect_timeout(&address, Duration::from_millis(500)).is_ok()
}

/// An address of this machine other than 127.0.0.1 that can be bound.
fn other_local_ip() -> Option<String> {
    let real = net::interfaces()
        .unwrap_or_default()
        .into_iter()
        .map(|iface| iface.ip);
    real.chain(std::iter::once(Ipv4Addr::new(127, 0, 0, 2)))
        .find(|ip| TcpListener::bind((*ip, 0)).is_ok())
        .map(|ip| ip.to_string())
}

#[test]
fn rebinds_on_ip_change_and_never_binds_another_interface() {
    let other = "127.0.0.9";
    let ifaces: Ifaces = Arc::new(Mutex::new(vec![
        iface("en0", "127.0.0.1"),
        iface("en1", other),
    ]));
    let (manager, _emit, _dir) = manager("rebind", &ifaces);
    let port = free_port();
    let status = manager.apply(enabled(port)).unwrap();
    assert!(status.listening, "{:?}", status.error);
    assert_eq!(status.ip.as_deref(), Some("127.0.0.1"));
    assert!(reachable("127.0.0.1", port));
    assert!(!reachable(other, port));

    // en0 loses its address: the server stops, the error names the interface,
    // and the other interface is not a replacement.
    *ifaces.lock().unwrap() = vec![iface("en1", other)];
    wait_until("the server to stop", || manager.status().error.is_some());
    let status = manager.status();
    assert!(
        status.error.as_deref().unwrap().contains("en0"),
        "{status:?}"
    );
    assert!(status.enabled && status.url.is_none());
    assert!(!reachable("127.0.0.1", port));
    assert!(!reachable(other, port));

    // en0 comes back with another address (if this machine has one to bind).
    if let Some(next) = other_local_ip() {
        *ifaces.lock().unwrap() = vec![iface("en0", &next), iface("en1", other)];
        wait_until("the rebind", || {
            manager.status().ip.as_deref() == Some(&next)
        });
        assert!(manager.status().error.is_none());
        assert!(reachable(&next, port));
        assert!(!reachable(other, port));
    }
    manager.stop();
    assert!(!manager.status().listening);
}

#[test]
fn saved_push_settings_are_configured_before_start_saved() {
    let dir = crate::test_support::tempdir("remote-manager", "push-at-construction");
    RemoteSettings {
        push: super::super::settings::PushSettings {
            enabled: true,
            contact: String::new(),
            ..super::super::settings::PushSettings::default()
        },
        ..RemoteSettings::default()
    }
    .save(&dir.join(SETTINGS_FILE))
    .unwrap();

    let (manager, _emit) = manager_in(&dir, &loopback());
    assert_eq!(
        manager.status().push_error.as_deref(),
        Some(super::super::push_contact::CONTACT_ERROR),
        "construction must configure push before the remote-start thread runs"
    );
}

#[test]
fn settings_survive_a_restart_in_a_private_file() {
    let (first, _emit, dir) = manager("persist", &loopback());
    let settings = RemoteSettings {
        enabled: false,
        interface: Some("en0".to_owned()),
        port: 7999,
        host_name: Some("omp.test".to_owned()),
        cert: CertSetting::Files {
            cert: "/c.pem".to_owned(),
            key: "/k.pem".to_owned(),
        },
        ..RemoteSettings::default()
    };
    first.apply(settings.clone()).unwrap();
    let file = dir.join(SETTINGS_FILE);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let (second, _emit) = manager_in(&dir, &loopback());
    assert_eq!(second.settings(), settings);
    assert!(std::fs::read_to_string(file)
        .unwrap()
        .contains("\"hostName\""));
}

#[test]
fn status_reflects_connections() {
    let (manager, emit, _dir) = manager("connections", &loopback());
    let hub = manager.hub();
    hub.set_ready(true);
    let (device, _token) = manager.core.devices.add("phone").unwrap();
    assert!(!manager.status().devices[0].connected);
    let (tx, _rx) = std::sync::mpsc::sync_channel(8);
    let conn = hub.register(&device, tx, None, hub.generation()).unwrap();
    let last = |emit: &FakeEmit| emit.statuses.lock().unwrap().last().cloned().unwrap();
    let status = last(&emit);
    assert_eq!(status.devices.len(), 1);
    assert!(status.devices[0].connected && !status.devices[0].push_subscribed);
    assert_eq!(status.devices[0].name, "phone");
    assert!(manager.status().devices[0].connected);
    hub.unregister(conn);
    assert!(!last(&emit).devices[0].connected);
}

#[test]
fn pair_start_uses_the_host_name_and_the_scheme() {
    let (manager, _emit, _dir) = manager("pair", &loopback());
    assert!(manager.pair_start().is_err(), "not listening yet");
    let port = free_port();
    let settings = RemoteSettings {
        host_name: Some("omp.test".to_owned()),
        ..enabled(port)
    };
    let status = manager.apply(settings).unwrap();
    assert!(status.listening, "{:?}", status.error);
    assert_eq!(status.url, Some(format!("https://omp.test:{port}")));
    assert_eq!(status.ip.as_deref(), Some("127.0.0.1"));
    assert!(status.fingerprint.is_some());
    assert!(serde_json::to_value(&status)
        .unwrap()
        .get("plainHttp")
        .is_none());
    let pair = manager.pair_start().unwrap();
    assert!(pair
        .url
        .starts_with(&format!("https://omp.test:{port}/#pair=")));
    assert!(pair.svg.contains("<svg"));
    assert!(pair.expires_at > unix_seconds());

    // Without a host name the phone is sent to the interface address, still over TLS.
    manager.apply(enabled(port)).unwrap();
    let pair = manager.pair_start().unwrap();
    assert!(pair
        .url
        .starts_with(&format!("https://127.0.0.1:{port}/#pair=")));
}

#[test]
fn a_port_in_use_is_a_status_error() {
    let blocker = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = blocker.local_addr().unwrap().port();
    let (manager, emit, _dir) = manager("port", &loopback());
    let status = manager.apply(enabled(port)).unwrap();
    assert!(!status.listening);
    assert_eq!(status.error, Some(format!("port {port} is in use")));
    assert!(emit
        .statuses
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .error
        .is_some());
}

#[test]
fn disabling_stops_the_server_and_a_missing_interface_is_an_error() {
    let (manager, _emit, _dir) = manager("disable", &loopback());
    let port = free_port();
    assert!(manager.apply(enabled(port)).unwrap().listening);
    let off = RemoteSettings {
        enabled: false,
        ..enabled(port)
    };
    let status = manager.apply(off).unwrap();
    assert!(!status.listening && status.error.is_none());
    assert!(!reachable("127.0.0.1", port));
    let missing = RemoteSettings {
        interface: Some("nope0".to_owned()),
        ..enabled(port)
    };
    let status = manager.apply(missing).unwrap();
    assert_eq!(
        status.error.as_deref(),
        Some("interface nope0 has no IPv4 address")
    );
}

type TlsClient = rustls::StreamOwned<rustls::ClientConnection, TcpStream>;

/// A TLS client of the server in `dir` (trusting its generated certificate).
fn tls_client(dir: &Path, port: u16) -> TlsClient {
    let tcp = TcpStream::connect(("127.0.0.1", port)).unwrap();
    tcp.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let config = crate::test_support::tls_client_config(&dir.join("remote").join("cert.pem"));
    let name = rustls::pki_types::ServerName::try_from("127.0.0.1").unwrap();
    rustls::StreamOwned::new(rustls::ClientConnection::new(config, name).unwrap(), tcp)
}

/// A WebSocket client that has upgraded but not authenticated.
fn upgraded(dir: &Path, port: u16) -> tungstenite::WebSocket<TlsClient> {
    use std::io::{Read, Write};
    let mut tcp = tls_client(dir, port);
    let host = format!("127.0.0.1:{port}");
    let request = format!(
        "GET /ws HTTP/1.1\r\nHost: {host}\r\nOrigin: https://{host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
    );
    tcp.write_all(request.as_bytes()).unwrap();
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let mut byte = [0_u8];
        assert_eq!(tcp.read(&mut byte).unwrap(), 1, "closed during handshake");
        head.push(byte[0]);
    }
    assert!(head.starts_with(b"HTTP/1.1 101"));
    tungstenite::WebSocket::from_raw_socket(tcp, tungstenite::protocol::Role::Client, None)
}

fn auth(socket: &mut tungstenite::WebSocket<TlsClient>, token: &str) {
    let frame = format!(r#"{{"t":"auth","token":"{token}"}}"#);
    socket.send(tungstenite::Message::text(frame)).unwrap();
}

#[test]
fn an_upgrade_in_flight_across_disable_is_refused() {
    let (manager, _emit, dir) = manager("stale-upgrade", &loopback());
    let hub = manager.hub();
    hub.set_ready(true);
    let port = free_port();
    assert!(manager.apply(enabled(port)).unwrap().listening);
    let (_device, token) = manager.core.devices.add("phone").unwrap();

    // Control: authenticating on the running server is admitted.
    let mut control = upgraded(&dir, port);
    auth(&mut control, &token);
    let hello = control.read().unwrap();
    assert!(hello.to_text().unwrap().contains("hello"), "{hello:?}");

    let mut late = upgraded(&dir, port);
    manager
        .apply(RemoteSettings {
            enabled: false,
            ..enabled(port)
        })
        .unwrap();
    auth(&mut late, &token);
    match late.read() {
        Ok(tungstenite::Message::Close(Some(frame))) => assert_eq!(u16::from(frame.code), 4503),
        other => panic!("expected close 4503, got {other:?}"),
    }
    assert_eq!(hub.connected_devices(), Vec::<String>::new());
}

#[test]
fn stopping_also_refuses_an_upgrade_in_flight() {
    let (manager, _emit, dir) = manager("stale-stop", &loopback());
    let hub = manager.hub();
    hub.set_ready(true);
    let port = free_port();
    assert!(manager.apply(enabled(port)).unwrap().listening);
    let (_device, token) = manager.core.devices.add("phone").unwrap();
    let mut late = upgraded(&dir, port);
    manager.stop();
    auth(&mut late, &token);
    match late.read() {
        Ok(tungstenite::Message::Close(Some(frame))) => assert_eq!(u16::from(frame.code), 4503),
        other => panic!("expected close 4503, got {other:?}"),
    }
    assert_eq!(hub.connected_devices(), Vec::<String>::new());
}

#[test]
fn status_carries_the_saved_settings() {
    let (manager, emit, _dir) = manager("status-settings", &loopback());
    let mut settings = enabled(free_port());
    settings.host_name = Some("omp.test".to_owned());
    settings.push.questions = !settings.push.questions;
    let status = manager.apply(settings.clone()).unwrap();
    assert_eq!(status.settings, settings.normalized());
    assert_eq!(manager.status().settings, status.settings);
    let emitted = emit.statuses.lock().unwrap().last().cloned().unwrap();
    assert_eq!(emitted.settings, status.settings);
    let json = serde_json::to_value(&status).unwrap();
    assert_eq!(json["settings"]["hostName"], "omp.test");
    assert!(json["settings"].get("allowHttp").is_none());
}

#[test]
fn a_push_only_change_keeps_the_server_and_its_sockets() {
    let (manager, _emit, _dir) = manager("push-only", &loopback());
    let hub = manager.hub();
    hub.set_ready(true);
    let port = start_on_a_free_port(&manager);
    let (device, _token) = manager.core.devices.add("phone").unwrap();
    let (tx, rx) = std::sync::mpsc::sync_channel(8);
    hub.register(&device, tx, None, hub.generation()).unwrap();

    let mut push_only = enabled(port);
    push_only.push.questions = !push_only.push.questions;
    let status = manager.apply(push_only.clone()).unwrap();
    assert!(status.listening && reachable("127.0.0.1", port));
    assert_eq!(status.settings.push, push_only.push);
    assert_eq!(hub.connected_devices(), vec![device.id]);
    while let Ok(out) = rx.try_recv() {
        assert!(!matches!(out, crate::remote::hub::Out::Close(_)));
    }

    // Control: a change of the server itself closes the sockets.
    manager
        .apply(RemoteSettings {
            host_name: Some("omp.test".to_owned()),
            ..push_only
        })
        .unwrap();
    assert_eq!(hub.connected_devices(), Vec::<String>::new());
}

#[test]
fn a_successful_pairing_emits_a_status_with_the_device() {
    use std::io::{Read, Write};
    let (manager, emit, dir) = manager("pair-status", &loopback());
    let port = free_port();
    assert!(manager.apply(enabled(port)).unwrap().listening);
    let url = manager.pair_start().unwrap().url;
    let code = url.split("#pair=").nth(1).unwrap();
    let body = format!(r#"{{"code":"{code}","name":"Phone"}}"#);
    let request = format!(
        "POST /pair HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let mut tcp = tls_client(&dir, port);
    tcp.write_all(request.as_bytes()).unwrap();
    let mut reply = Vec::new();
    let mut chunk = [0_u8; 1024];
    // The server may end without close_notify once it has answered.
    while let Ok(read @ 1..) = tcp.read(&mut chunk) {
        reply.extend_from_slice(&chunk[..read]);
    }
    let reply = String::from_utf8_lossy(&reply);
    assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
    wait_until("the paired device in a status", || {
        emit.statuses
            .lock()
            .unwrap()
            .last()
            .is_some_and(|status| status.devices.len() == 1)
    });
}

#[test]
fn a_phone_gets_the_push_key_after_hello_only_while_push_is_on() {
    let (manager, _emit, dir) = manager("push-key", &loopback());
    let hub = manager.hub();
    hub.set_ready(true);
    let port = free_port();
    let mut settings = enabled(port);
    settings.push.enabled = true;
    settings.push.contact = "dev@omp-desktop.app".to_owned();
    assert!(manager
        .apply(settings.clone())
        .unwrap()
        .push_error
        .is_none());
    assert!(dir.join("remote/vapid.pk8").exists());
    let (_device, token) = manager.core.devices.add("phone").unwrap();

    let mut on = upgraded(&dir, port);
    auth(&mut on, &token);
    assert!(on.read().unwrap().to_text().unwrap().contains("hello"));
    let key: serde_json::Value =
        serde_json::from_str(on.read().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(key["t"], "push-key");
    assert!(key["key"].as_str().is_some_and(|key| key.len() == 87));
    assert!(on.read().unwrap().to_text().unwrap().contains("\"tabs\""));

    settings.push.enabled = false;
    manager.apply(settings).unwrap();
    let withdrawn: serde_json::Value =
        serde_json::from_str(on.read().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(withdrawn["t"], "push-key");
    assert!(withdrawn["key"].is_null());

    let mut off = upgraded(&dir, port);
    auth(&mut off, &token);
    assert!(off.read().unwrap().to_text().unwrap().contains("hello"));
    assert!(
        off.read().unwrap().to_text().unwrap().contains("\"tabs\""),
        "no key while off"
    );
}

struct TrackerNotify(mpsc::Sender<()>);

impl TrackerSink for TrackerNotify {
    fn changed(&self, _sid: &str, _transition: Option<super::super::tracker::Transition>) {
        self.0.send(()).unwrap();
    }
}

fn assert_tracker_stopped(sink: &FanOut) {
    let (tx, rx) = mpsc::channel();
    sink.set_push(Some(Arc::new(TrackerNotify(tx))));
    sink.changed("a", Some(super::super::tracker::Transition::QuestionOpened));
    assert!(
        rx.recv_timeout(Duration::from_millis(300)).is_err(),
        "manager left the tracker worker running"
    );
}

#[test]
fn stopping_the_manager_stops_its_tracker_worker() {
    let (manager, _emit, _dir) = manager("stop-tracker", &loopback());
    let sink = manager.tracker_sink().unwrap();
    manager.stop();
    assert_tracker_stopped(&sink);
}

#[test]
fn dropping_the_manager_stops_its_tracker_worker() {
    let (manager, _emit, _dir) = manager("drop-tracker", &loopback());
    let sink = manager.tracker_sink().unwrap();
    drop(manager);
    assert_tracker_stopped(&sink);
}
