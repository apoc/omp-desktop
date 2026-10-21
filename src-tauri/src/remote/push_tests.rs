use super::*;
use crate::remote::devices::PushSubscription;
use crate::remote::push_contact::CONTACT_ERROR;
use crate::remote::push_crypto::{decrypt_for_test, encrypt};
use crate::test_support::eventually;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;

fn tempdir(name: &str) -> PathBuf {
    crate::test_support::tempdir("remote-push", name)
}

fn b64url_decode(text: &str) -> Vec<u8> {
    URL_SAFE_NO_PAD.decode(text).unwrap()
}

#[test]
fn encrypt_round_trips_with_the_receivers_key() {
    let rng = ring::rand::SystemRandom::new();
    let ua =
        ring::agreement::EphemeralPrivateKey::generate(&ring::agreement::ECDH_P256, &rng).unwrap();
    let ua_pub = ua.compute_public_key().unwrap().as_ref().to_vec();
    let auth = [7u8; 16];
    let text = "{\"title\":\"OMP \u{b7} t\",\"body\":\"Question waiting\"}".as_bytes();
    let body = encrypt(&ua_pub, &auth, text).unwrap();
    let plain = decrypt_for_test(ua, &ua_pub, &auth, &body).unwrap();
    assert_eq!(plain, text);
    assert_eq!(&body[16..20], &4096u32.to_be_bytes());
    assert_eq!(body[20], 65);
    assert!(
        encrypt(&ua_pub, &auth, &vec![0; 4096]).is_err(),
        "too large"
    );
}

#[test]
fn vapid_jwt_verifies_with_the_public_key_and_carries_the_claims() {
    let dir = tempdir("vapid");
    let v = Vapid::load_or_create(&dir).unwrap();
    let jwt = v
        .jwt(
            "https://web.push.apple.com",
            "mailto:dev@omp-desktop.app",
            1_800_000_000,
        )
        .unwrap();
    let parts: Vec<_> = jwt.split('.').collect();
    assert_eq!(
        b64url_decode(parts[0]),
        br#"{"typ":"JWT","alg":"ES256"}"#.to_vec()
    );
    let claims: serde_json::Value = serde_json::from_slice(&b64url_decode(parts[1])).unwrap();
    assert_eq!(claims["aud"], "https://web.push.apple.com");
    assert_eq!(claims["sub"], "mailto:dev@omp-desktop.app");
    assert_eq!(claims["exp"], 1_800_000_000u64 + 43_200);
    let key = ring::signature::UnparsedPublicKey::new(
        &ring::signature::ECDSA_P256_SHA256_FIXED,
        b64url_decode(&v.public_b64),
    );
    key.verify(
        format!("{}.{}", parts[0], parts[1]).as_bytes(),
        &b64url_decode(parts[2]),
    )
    .unwrap();
    assert_eq!(
        Vapid::load_or_create(&dir).unwrap().public_b64,
        v.public_b64,
        "persisted"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.join("remote/vapid.pk8"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

/// A one-thread HTTP server: answers with the next status of `statuses`
/// (201 once they run out) and reports each request's head and body size.
fn fake_push_service(statuses: Vec<u16>) -> (String, mpsc::Receiver<(String, usize)>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (seen, requests) = mpsc::channel();
    std::thread::spawn(move || {
        let mut statuses = statuses.into_iter();
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut raw = Vec::new();
            let mut chunk = [0_u8; 4096];
            let (head, mut body) = loop {
                let n = stream.read(&mut chunk).unwrap();
                raw.extend_from_slice(&chunk[..n]);
                if let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    break (
                        String::from_utf8_lossy(&raw[..end]).into_owned(),
                        raw.len() - end - 4,
                    );
                }
                assert!(n > 0, "closed before the head ended");
            };
            let length: usize = head
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(str::to_owned)
                })
                .map_or(0, |value| value.trim().parse().unwrap());
            while body < length {
                body += stream.read(&mut chunk).unwrap();
            }
            let status = statuses.next().unwrap_or(201);
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            );
            let _ = seen.send((head, body));
        }
    });
    (base, requests)
}

fn setup(
    dir: &std::path::Path,
    contact: &str,
    endpoint: &str,
) -> (Pusher, Arc<DeviceStore>, Option<String>) {
    setup_with(dir, contact, endpoint, |_| true)
}

fn setup_with(
    dir: &std::path::Path,
    contact: &str,
    endpoint: &str,
    endpoint_ok: fn(&str) -> bool,
) -> (Pusher, Arc<DeviceStore>, Option<String>) {
    setup_full(dir, contact, endpoint, endpoint_ok, false, || None)
}

/// `only_when_locked` on or off, with `lock_probe` answering for the screen.
fn setup_locking(
    dir: &std::path::Path,
    endpoint: &str,
    only_when_locked: bool,
    lock_probe: fn() -> Option<bool>,
) -> (Pusher, Arc<DeviceStore>) {
    let (pusher, devices, _) = setup_full(
        dir,
        "dev@omp-desktop.app",
        endpoint,
        |_| true,
        only_when_locked,
        lock_probe,
    );
    (pusher, devices)
}

fn setup_full(
    dir: &std::path::Path,
    contact: &str,
    endpoint: &str,
    endpoint_ok: fn(&str) -> bool,
    only_when_locked: bool,
    lock_probe: fn() -> Option<bool>,
) -> (Pusher, Arc<DeviceStore>, Option<String>) {
    let devices = Arc::new(DeviceStore::load(dir.join("devices.json")));
    let (device, _) = devices.add("phone").unwrap();
    let rng = ring::rand::SystemRandom::new();
    let ua =
        ring::agreement::EphemeralPrivateKey::generate(&ring::agreement::ECDH_P256, &rng).unwrap();
    devices
        .set_push(
            &device.id,
            vec![PushSubscription {
                endpoint: endpoint.to_owned(),
                p256dh: URL_SAFE_NO_PAD.encode(ua.compute_public_key().unwrap().as_ref()),
                auth: URL_SAFE_NO_PAD.encode([9_u8; 16]),
            }],
        )
        .unwrap();
    let pusher = Pusher::with_probes(
        dir.to_owned(),
        Arc::clone(&devices),
        Arc::new(|sid| Some(format!("title of {sid}"))),
        Arc::new(|| {}),
        endpoint_ok,
        lock_probe,
    );
    let key = pusher.configure(&PushSettings {
        enabled: true,
        questions: true,
        finished: true,
        contact: contact.to_owned(),
        only_when_locked,
    });
    (pusher, devices, key)
}
fn wait_for(what: &str, mut condition: impl FnMut() -> bool) {
    eventually(Duration::from_secs(5), || condition().then_some(())).expect(what);
}

#[test]
fn throttle_gone_subscription_and_placeholder_contact() {
    let timeout = Duration::from_secs(5);
    let (base, requests) = fake_push_service(vec![201, 410]);
    let dir = tempdir("pusher");
    let (pusher, devices, key) = setup(&dir, "dev@omp-desktop.app", &format!("{base}/sub"));
    assert!(key.is_some());

    pusher.changed("a", Some(Transition::QuestionOpened));
    pusher.changed("a", Some(Transition::QuestionOpened)); // throttled
    pusher.changed(
        "a",
        Some(Transition::TurnFinished {
            ran: Duration::from_secs(5),
        }),
    ); // too short
    let (head, body) = requests.recv_timeout(timeout).unwrap();
    assert!(head.starts_with("POST /sub "), "{head}");
    let lower = head.to_ascii_lowercase();
    assert!(lower.contains("authorization: vapid t="), "{head}");
    assert!(lower.contains("content-encoding: aes128gcm"), "{head}");
    assert!(lower.contains("ttl: 3600"), "{head}");
    assert!(lower.contains("urgency: high"), "{head}");
    assert!(body > 86, "encrypted record follows the header");
    assert!(
        requests.recv_timeout(Duration::from_millis(400)).is_err(),
        "the second notify for tab a made no request"
    );
    assert_eq!(
        devices.list()[0].push.len(),
        1,
        "201 keeps the subscription"
    );
    pusher.changed("b", Some(Transition::QuestionOpened)); // answered 410
    requests.recv_timeout(timeout).unwrap();
    wait_for("the 410 to remove the subscription", || {
        devices.list()[0].push.is_empty()
    });

    // A placeholder contact never reaches the network.
    let (base, requests) = fake_push_service(vec![]);
    let dir = tempdir("pusher-contact");
    let (pusher, _devices, _) = setup(&dir, "mailto:x@example.invalid", &format!("{base}/sub"));
    pusher.changed("a", Some(Transition::QuestionOpened));
    wait_for("the contact error", || pusher.last_error().is_some());
    assert_eq!(
        pusher.last_error().unwrap(),
        "push contact must be a real mailto: or https: address"
    );
    assert!(requests.recv_timeout(Duration::from_millis(300)).is_err());
}

#[test]
fn triggers_follow_the_settings_and_test_reaches_every_subscription() {
    let (base, requests) = fake_push_service(vec![]);
    let dir = tempdir("pusher-settings");
    let (pusher, _devices, _) = setup(&dir, "dev@omp-desktop.app", &format!("{base}/sub"));
    pusher.configure(&PushSettings {
        enabled: true,
        questions: false,
        finished: true,
        contact: "dev@omp-desktop.app".to_owned(),
        only_when_locked: false,
    });
    pusher.changed("a", Some(Transition::QuestionOpened));
    pusher.changed("a", None);
    assert!(requests.recv_timeout(Duration::from_millis(300)).is_err());
    pusher.changed(
        "a",
        Some(Transition::TurnFinished {
            ran: Duration::from_secs(30),
        }),
    );
    let (head, _) = requests.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(
        head.to_ascii_lowercase().contains("urgency: normal"),
        "{head}"
    );
    pusher.test().unwrap();
    requests.recv_timeout(Duration::from_secs(5)).unwrap();
    pusher.configure(&PushSettings::default());
    assert!(pusher.test().is_err(), "off");
}

#[test]
fn contacts_are_checked_and_bare_emails_become_mailto() {
    assert_eq!(
        contact_uri("me@omp-desktop.app").unwrap(),
        "mailto:me@omp-desktop.app"
    );
    assert!(contact_uri("https://omp-desktop.app/about").is_ok());
    for bad in [
        "",
        "mailto:x@example.invalid",
        "x@example.com",
        "x@localhost",
        "@omp-desktop.app",
        "http://omp-desktop.app",
        "tel:123",
        "alice@@company.com",
        "mailto:al ice@company.com",
        "mailto:alice@company..com",
        "mailto:alice@-company.com",
        "mailto:alice@company.com,bob@company.com",
    ] {
        assert_eq!(contact_uri(bad).unwrap_err(), CONTACT_ERROR, "{bad}");
    }
}

#[test]
fn a_stored_endpoint_is_rechecked_before_every_send() {
    let (base, requests) = fake_push_service(vec![]);
    let dir = tempdir("pusher-endpoint");
    let (pusher, devices, _) = setup_with(
        &dir,
        "dev@omp-desktop.app",
        &format!("{base}/sub"),
        crate::remote::push_subs::endpoint_ok,
    );
    pusher.changed("a", Some(Transition::QuestionOpened));
    wait_for("the disallowed endpoint to be dropped", || {
        devices.list()[0].push.is_empty()
    });
    assert!(requests.recv_timeout(Duration::from_millis(300)).is_err());
}

static REVOKE_ON_SECOND: std::sync::Mutex<Option<(Arc<DeviceStore>, String)>> =
    std::sync::Mutex::new(None);

/// Accepts every endpoint; checking the second one revokes its device, as a
/// user would while the batch runs.
fn revoking_endpoint_check(endpoint: &str) -> bool {
    if endpoint.ends_with("/second") {
        let target = REVOKE_ON_SECOND.lock().unwrap().take();
        if let Some((devices, id)) = target {
            assert!(devices.revoke(&id));
        }
    }
    true
}

#[test]
fn a_device_revoked_mid_batch_gets_no_further_push() {
    let (base, requests) = fake_push_service(vec![]);
    let dir = tempdir("pusher-revoked-mid-batch");
    let (pusher, devices, _) = setup_with(
        &dir,
        "dev@omp-desktop.app",
        &format!("{base}/first"),
        revoking_endpoint_check,
    );
    let device = devices.list().remove(0);
    let mut subs = device.push.clone();
    subs.push(PushSubscription {
        endpoint: format!("{base}/second"),
        ..subs[0].clone()
    });
    devices.set_push(&device.id, subs).unwrap();
    *REVOKE_ON_SECOND.lock().unwrap() = Some((Arc::clone(&devices), device.id));
    pusher.changed("a", Some(Transition::QuestionOpened));
    let (head, _) = requests.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(head.starts_with("POST /first "), "{head}");
    wait_for("the device to be revoked", || devices.list().is_empty());
    assert!(
        requests.recv_timeout(Duration::from_millis(500)).is_err(),
        "the revoked device's second subscription was still sent to"
    );
}

static UNSUBSCRIBE_ON_SECOND: Mutex<Option<(Arc<DeviceStore>, String)>> = Mutex::new(None);

fn unsubscribing_endpoint_check(endpoint: &str) -> bool {
    if endpoint.ends_with("/second") {
        let target = UNSUBSCRIBE_ON_SECOND.lock().unwrap().take();
        if let Some((devices, id)) = target {
            devices.set_push(&id, Vec::new()).unwrap();
        }
    }
    true
}

#[test]
fn a_device_unsubscribed_mid_batch_gets_no_further_push() {
    let (base, requests) = fake_push_service(vec![]);
    let dir = tempdir("pusher-unsubscribed-mid-batch");
    let (pusher, devices, _) = setup_with(
        &dir,
        "dev@omp-desktop.app",
        &format!("{base}/first"),
        unsubscribing_endpoint_check,
    );
    let device = devices.list().remove(0);
    let mut subs = device.push;
    subs.push(PushSubscription {
        endpoint: format!("{base}/second"),
        ..subs[0].clone() // Same encryption keys, distinct endpoint.
    });
    devices.set_push(&device.id, subs).unwrap();
    *UNSUBSCRIBE_ON_SECOND.lock().unwrap() = Some((Arc::clone(&devices), device.id));
    pusher.changed("a", Some(Transition::QuestionOpened));
    let (head, _) = requests.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(head.starts_with("POST /first "), "{head}");
    wait_for("the device to unsubscribe", || {
        devices.list()[0].push.is_empty()
    });
    assert!(
        requests.recv_timeout(Duration::from_millis(500)).is_err(),
        "the unsubscribed device's second subscription was still sent to"
    );
}

#[test]
fn a_bad_contact_shows_in_the_status_right_after_configure() {
    let dir = tempdir("pusher-bad-contact");
    let (pusher, _devices, key) = setup(&dir, "mailto:x@example.invalid", "https://unused.test/");
    assert!(key.is_some());
    assert_eq!(pusher.last_error().unwrap(), CONTACT_ERROR);
}

static SCREEN_LOCKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn question(pusher: &Pusher, tab: &str) {
    pusher.changed(tab, Some(Transition::QuestionOpened));
}

#[test]
fn only_when_locked_sends_while_the_screen_is_locked() {
    let (base, requests) = fake_push_service(vec![]);
    let dir = tempdir("pusher-locked");
    let (pusher, _devices) = setup_locking(&dir, &format!("{base}/sub"), true, || Some(true));
    question(&pusher, "a");
    requests.recv_timeout(Duration::from_secs(5)).unwrap();
}

#[test]
fn only_when_locked_drops_while_unlocked_and_keeps_the_throttle_free() {
    let (base, requests) = fake_push_service(vec![]);
    let dir = tempdir("pusher-unlocked");
    SCREEN_LOCKED.store(false, std::sync::atomic::Ordering::SeqCst);
    let (pusher, _devices) = setup_locking(&dir, &format!("{base}/sub"), true, || {
        Some(SCREEN_LOCKED.load(std::sync::atomic::Ordering::SeqCst))
    });
    question(&pusher, "a");
    wait_for("the worker to drop the unlocked push", || {
        locked(&pusher.shared.last_sent).is_empty()
    });
    assert!(
        requests.recv_timeout(Duration::from_millis(300)).is_err(),
        "nothing is sent while unlocked"
    );
    assert!(pusher.last_error().is_none(), "a dropped push is no error");

    SCREEN_LOCKED.store(true, std::sync::atomic::Ordering::SeqCst);
    question(&pusher, "a"); // well inside 30 s of the dropped one
    requests.recv_timeout(Duration::from_secs(5)).unwrap();
}

#[test]
fn only_when_locked_does_not_hold_back_the_test_push() {
    let (base, requests) = fake_push_service(vec![]);
    let dir = tempdir("pusher-locked-test");
    let (pusher, _devices) = setup_locking(&dir, &format!("{base}/sub"), true, || Some(false));
    pusher.test().unwrap();
    requests.recv_timeout(Duration::from_secs(5)).unwrap();
}

#[test]
fn pushes_go_out_while_unlocked_when_the_setting_is_off() {
    let (base, requests) = fake_push_service(vec![]);
    let dir = tempdir("pusher-lock-off");
    let (pusher, _devices) = setup_locking(&dir, &format!("{base}/sub"), false, || Some(false));
    question(&pusher, "a");
    requests.recv_timeout(Duration::from_secs(5)).unwrap();
}

#[test]
fn an_unknown_lock_state_still_sends() {
    let (base, requests) = fake_push_service(vec![]);
    let dir = tempdir("pusher-lock-unknown");
    let (pusher, _devices) = setup_locking(&dir, &format!("{base}/sub"), true, || None);
    question(&pusher, "a");
    requests.recv_timeout(Duration::from_secs(5)).unwrap();
}
