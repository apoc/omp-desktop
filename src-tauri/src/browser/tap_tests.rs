//! `tap.rs` unit tests: the session map, the intent list, the upgrade
//! response, bounds, and the never-panics guarantee.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use super::lock;
use serde_json::{json, Value};

use super::proxy::AgentTarget;
use super::tap::{Direction, Feed, Tap};
use super::ws_frames_tests::{frame, masked_text, text};

const BROWSER: &[u8] = b"GET /devtools/browser/x HTTP/1.1\r\nHost: h\r\n\r\n";
const UPGRADED: &[u8] = b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n";

/// The targets a tap reported.
#[derive(Clone, Default)]
pub(super) struct Reported(Arc<Mutex<Vec<String>>>);

impl Reported {
    pub fn callback(&self) -> AgentTarget {
        let seen = Arc::clone(&self.0);
        Arc::new(move |target| lock(&seen).push(target.to_owned()))
    }

    pub fn all(&self) -> Vec<String> {
        lock(&self.0).clone()
    }
}

/// A tap on a connection to `request`, its upgrade done.
fn tap_on(request: &[u8]) -> (Tap, Reported) {
    let reported = Reported::default();
    let mut tap = Tap::new(request, reported.callback());
    tap.feed_server(UPGRADED);
    (tap, reported)
}

fn command(tap: &mut Tap, message: &Value) {
    tap.feed_client(&masked_text(&message.to_string()));
}

fn server(tap: &mut Tap, message: &Value) {
    tap.feed_server(&text(&message.to_string()));
}

fn attached(tap: &mut Tap, session: &str, target: &str, kind: &str) {
    server(
        tap,
        &json!({ "method": "Target.attachedToTarget", "params": {
            "sessionId": session, "targetInfo": { "targetId": target, "type": kind } } }),
    );
}

fn in_session(id: u64, method: &str, session: &str) -> Value {
    json!({ "id": id, "method": method, "params": {}, "sessionId": session })
}

#[test]
fn a_command_in_an_attached_session_names_its_page() {
    let (mut tap, seen) = tap_on(BROWSER);
    attached(&mut tap, "s1", "T1", "page");
    command(&mut tap, &in_session(1, "Page.navigate", "s1"));
    assert_eq!(seen.all(), ["T1"]);
}

#[test]
fn an_attach_reply_names_a_session_but_is_no_intent() {
    let (mut tap, seen) = tap_on(BROWSER);
    command(
        &mut tap,
        &json!({ "id": 7, "method": "Target.attachToTarget",
            "params": { "targetId": "T2", "flatten": true } }),
    );
    server(
        &mut tap,
        &json!({ "id": 7, "result": { "sessionId": "s2" } }),
    );
    assert!(seen.all().is_empty(), "attached is not worked in");
    command(&mut tap, &in_session(8, "Page.reload", "s2"));
    assert_eq!(seen.all(), ["T2"]);
    command(&mut tap, &in_session(9, "Page.reload", "unknown"));
    assert_eq!(seen.all(), ["T2"], "a session nobody told us about");
}

#[test]
fn a_detached_session_is_forgotten() {
    let (mut tap, seen) = tap_on(BROWSER);
    attached(&mut tap, "s1", "T1", "page");
    server(
        &mut tap,
        &json!({ "method": "Target.detachedFromTarget", "params": { "sessionId": "s1" } }),
    );
    command(&mut tap, &in_session(1, "Page.navigate", "s1"));
    assert_eq!(seen.all(), Vec::<String>::new());
}

#[test]
fn only_page_sessions_count() {
    let (mut tap, seen) = tap_on(BROWSER);
    attached(&mut tap, "frame", "F1", "iframe");
    command(
        &mut tap,
        &in_session(1, "Input.dispatchMouseEvent", "frame"),
    );
    // The reply to an attach the event already described does not turn it
    // into a page.
    command(
        &mut tap,
        &json!({ "id": 2, "method": "Target.attachToTarget", "params": { "targetId": "F1" } }),
    );
    server(
        &mut tap,
        &json!({ "id": 2, "result": { "sessionId": "frame" } }),
    );
    command(
        &mut tap,
        &in_session(3, "Input.dispatchMouseEvent", "frame"),
    );
    assert_eq!(seen.all(), Vec::<String>::new());
}

#[test]
fn a_created_page_is_reported_from_the_reply() {
    let (mut tap, seen) = tap_on(BROWSER);
    command(
        &mut tap,
        &json!({ "id": 3, "method": "Target.createTarget", "params": { "url": "about:blank" } }),
    );
    assert!(seen.all().is_empty(), "the page has no id yet");
    server(
        &mut tap,
        &json!({ "id": 4, "result": { "targetId": "other" } }),
    );
    server(&mut tap, &json!({ "id": 3, "error": { "message": "no" } }));
    assert!(seen.all().is_empty(), "an unrelated or failed reply");
    command(
        &mut tap,
        &json!({ "id": 5, "method": "Target.createTarget", "params": { "url": "about:blank" } }),
    );
    server(
        &mut tap,
        &json!({ "id": 5, "result": { "targetId": "T5" } }),
    );
    server(
        &mut tap,
        &json!({ "id": 5, "result": { "targetId": "T5" } }),
    );
    assert_eq!(seen.all(), ["T5"], "once; the failed id 3 is retired");
}

#[test]
fn activating_a_target_names_it() {
    let (mut tap, seen) = tap_on(BROWSER);
    command(
        &mut tap,
        &json!({ "id": 1, "method": "Target.activateTarget", "params": { "targetId": "T9" } }),
    );
    assert_eq!(seen.all(), ["T9"]);
}

#[test]
fn only_the_intent_commands_are_reported() {
    let (mut tap, seen) = tap_on(BROWSER);
    attached(&mut tap, "s", "T", "page");
    let intent = [
        "Page.navigate",
        "Page.reload",
        "Page.navigateToHistoryEntry",
        "Page.bringToFront",
        "Page.captureScreenshot",
        "Input.dispatchMouseEvent",
        "Input.dispatchKeyEvent",
        "Input.insertText",
    ];
    let other = [
        "Page.enable",
        "Page.getNavigationHistory",
        "Runtime.evaluate",
        "DOM.getDocument",
        "Target.setAutoAttach",
        "Target.getTargets",
        "Emulation.setDeviceMetricsOverride",
    ];
    for (id, method) in (1..).zip(other) {
        command(&mut tap, &in_session(id, method, "s"));
    }
    assert!(seen.all().is_empty(), "{:?}", seen.all());
    for (id, method) in (100..).zip(intent) {
        command(&mut tap, &in_session(id, method, "s"));
    }
    assert_eq!(seen.all().len(), intent.len());
}

#[test]
fn a_page_level_connection_works_in_its_own_page() {
    let (mut tap, seen) = tap_on(b"GET /devtools/page/B7?x=1 HTTP/1.1\r\n\r\n");
    command(
        &mut tap,
        &json!({ "id": 1, "method": "Page.bringToFront", "params": {} }),
    );
    assert_eq!(seen.all(), ["B7"]);
    let (mut browser, seen) = tap_on(BROWSER);
    command(
        &mut browser,
        &json!({ "id": 1, "method": "Page.bringToFront", "params": {} }),
    );
    assert!(
        seen.all().is_empty(),
        "a browser connection has no page of its own"
    );
}

#[test]
fn fragments_control_frames_and_one_byte_reads_make_no_difference() {
    let (mut tap, seen) = tap_on(BROWSER);
    attached(&mut tap, "s1", "T1", "page");
    let message = in_session(1, "Page.navigate", "s1").to_string();
    let (head, tail) = message.as_bytes().split_at(10);
    let mut wire = frame(0x1, false, true, head);
    wire.extend(frame(0x9, true, true, b"hi"));
    wire.extend(frame(0x0, true, true, tail));
    for byte in wire {
        tap.feed_client(&[byte]);
    }
    assert_eq!(seen.all(), ["T1"]);
}

#[test]
fn oversized_messages_are_skipped_and_the_tap_stays_in_sync() {
    let (mut tap, seen) = tap_on(BROWSER);
    // A screenshot-sized reply, then the events that matter.
    tap.feed_server(&text(&"x".repeat(200_000)));
    attached(&mut tap, "s1", "T1", "page");
    // A command over the cap, then one inside it.
    let big = json!({ "id": 1, "method": "Runtime.evaluate",
        "params": { "expression": "x".repeat(1_500_000) } });
    command(&mut tap, &big);
    command(&mut tap, &in_session(2, "Page.navigate", "s1"));
    assert_eq!(seen.all(), ["T1"]);
}

#[test]
fn pending_requests_are_bounded_oldest_first() {
    let (mut tap, seen) = tap_on(BROWSER);
    for id in 1..=2000 {
        command(
            &mut tap,
            &json!({ "id": id, "method": "Target.createTarget", "params": {} }),
        );
    }
    server(
        &mut tap,
        &json!({ "id": 1, "result": { "targetId": "old" } }),
    );
    server(
        &mut tap,
        &json!({ "id": 2000, "result": { "targetId": "new" } }),
    );
    assert_eq!(seen.all(), ["new"]);
}

fn upgrade_then_event(response: &str) -> Vec<String> {
    let reported = Reported::default();
    let mut tap = Tap::new(BROWSER, reported.callback());
    tap.feed_server(response.as_bytes());
    attached(&mut tap, "s1", "T1", "page");
    command(&mut tap, &in_session(1, "Page.navigate", "s1"));
    reported.all()
}

#[test]
fn the_upgrade_response_is_skipped_and_checked() {
    let ok = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n";
    assert_eq!(upgrade_then_event(ok), ["T1"]);
    for (what, response) in [
        ("a negotiated extension", "HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n"),
        ("any header case", "HTTP/1.1 101 Switching Protocols\r\nsec-websocket-EXTENSIONS: x\r\n\r\n"),
        ("a refused upgrade", "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n"),
    ] {
        assert!(upgrade_then_event(response).is_empty(), "{what}");
    }
}

#[test]
fn an_upgrade_response_may_arrive_in_pieces_with_frames_behind_it() {
    let reported = Reported::default();
    let mut tap = Tap::new(BROWSER, reported.callback());
    let event = json!({ "method": "Target.attachedToTarget", "params": {
        "sessionId": "s1", "targetInfo": { "targetId": "T1", "type": "page" } } });
    let mut wire = UPGRADED.to_vec();
    wire.extend(text(&event.to_string()));
    for chunk in wire.chunks(7) {
        tap.feed_server(chunk);
    }
    command(&mut tap, &in_session(1, "Page.navigate", "s1"));
    assert_eq!(reported.all(), ["T1"]);
}

#[test]
fn a_response_that_never_ends_switches_the_tap_off() {
    let reported = Reported::default();
    let mut tap = Tap::new(BROWSER, reported.callback());
    tap.feed_server(b"HTTP/1.1 101 Switching Protocols\r\n");
    tap.feed_server(&vec![b'a'; 20_000]);
    tap.feed_server(UPGRADED); // too late
    attached(&mut tap, "s1", "T1", "page");
    command(&mut tap, &in_session(1, "Page.navigate", "s1"));
    assert_eq!(reported.all(), Vec::<String>::new());
}

#[test]
fn garbage_switches_the_tap_off_and_never_panics() {
    let (mut tap, seen) = tap_on(BROWSER);
    tap.feed_client(&[0xFF; 32]);
    attached(&mut tap, "s1", "T1", "page");
    command(&mut tap, &in_session(1, "Page.navigate", "s1"));
    assert!(seen.all().is_empty(), "off after the first violation");

    // Pseudo-random bytes, in odd chunks, both directions, with and without
    // a valid upgrade first.
    let mut state = 0x2545_F491_4F6C_DD1D_u64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    for round in 0..300 {
        let reported = Reported::default();
        let mut tap = Tap::new(BROWSER, reported.callback());
        if round % 2 == 0 {
            tap.feed_server(UPGRADED);
        }
        for _ in 0..20 {
            let len = usize::try_from(next() % 40).unwrap();
            let bytes: Vec<u8> = (0..len).map(|_| next().to_le_bytes()[0]).collect();
            if next() % 2 == 0 {
                tap.feed_client(&bytes);
            } else {
                tap.feed_server(&bytes);
            }
        }
    }
}

#[test]
fn a_panicking_callback_switches_the_tap_off_instead_of_the_splice() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&calls);
    let callback: AgentTarget = Arc::new(move |_| {
        counted.fetch_add(1, Ordering::SeqCst);
        panic!("a callback that fails");
    });
    let feed = Feed::spawn(Tap::new(BROWSER, callback));
    feed.push(Direction::Server, UPGRADED);
    let activate = masked_text(
        &json!({ "id": 1, "method": "Target.activateTarget", "params": { "targetId": "T" } })
            .to_string(),
    );
    feed.push(Direction::Client, &activate); // panics on the observer thread, is contained
    feed.push(Direction::Client, &activate); // the tap is off
    let deadline = Instant::now() + Duration::from_secs(3);
    while calls.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    thread::sleep(Duration::from_millis(200));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(
        feed.is_disabled(),
        "observer stops splice-side chunk copies"
    );
}

#[test]
fn refused_or_extended_upgrade_disables_splice_side_chunk_copies() {
    for response in [
        b"HTTP/1.1 403 Forbidden\r\n\r\n".as_slice(),
        b"HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n",
    ] {
        let feed = Feed::spawn(Tap::new(BROWSER, Arc::new(|_| {})));
        feed.push(Direction::Server, response);
        let deadline = Instant::now() + Duration::from_secs(3);
        while !feed.is_disabled() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(feed.is_disabled(), "observer publishes its disabled state");
    }
}

#[test]
fn a_stuck_observer_disables_the_tap_without_blocking_the_splice() {
    let gate = Arc::new(Mutex::new(()));
    let held = lock(&gate);
    let stuck = Arc::clone(&gate);
    let callback: AgentTarget = Arc::new(move |_| drop(lock(&stuck)));
    let feed = Feed::spawn(Tap::new(BROWSER, callback));
    feed.push(Direction::Server, UPGRADED);
    let activate = masked_text(
        &json!({ "id": 1, "method": "Target.activateTarget", "params": { "targetId": "T" } })
            .to_string(),
    );
    let start = Instant::now();
    for _ in 0..1000 {
        feed.push(Direction::Client, &activate); // the observer is stuck in the callback
    }
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "push must not block"
    );
    assert!(feed.is_disabled(), "a full queue disables the tap");
    drop(held);
}

#[test]
fn the_observer_stops_after_the_queue_overflowed() {
    let gate = Arc::new(Mutex::new(()));
    let held = lock(&gate);
    let stuck = Arc::clone(&gate);
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&calls);
    let callback: AgentTarget = Arc::new(move |_| {
        counted.fetch_add(1, Ordering::SeqCst);
        drop(lock(&stuck));
    });
    let feed = Feed::spawn(Tap::new(BROWSER, callback));
    feed.push(Direction::Server, UPGRADED);
    let activate = masked_text(
        &json!({ "id": 1, "method": "Target.activateTarget", "params": { "targetId": "T" } })
            .to_string(),
    );
    feed.push(Direction::Client, &activate); // the observer blocks in the callback
    let deadline = Instant::now() + Duration::from_secs(3);
    while calls.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    // The queue holds 256; the observer is stuck in the first callback, so
    // this overflows it and the splice gives up on queueing.
    for _ in 0..300 {
        feed.push(Direction::Client, &activate);
    }
    assert!(feed.is_disabled(), "a full queue disables the tap");
    drop(held); // the callback may finish; the tap must not report any more
    thread::sleep(Duration::from_millis(200));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "no callback after the overflow point"
    );
}

#[test]
fn a_slow_request_outlives_any_number_of_completed_ones() {
    let (mut tap, seen) = tap_on(BROWSER);
    command(
        &mut tap,
        &json!({ "id": 1, "method": "Target.attachToTarget", "params": { "targetId": "T2" } }),
    );
    for id in 2..=5001 {
        command(
            &mut tap,
            &json!({ "id": id, "method": "Target.createTarget", "params": {} }),
        );
        server(
            &mut tap,
            &json!({ "id": id, "result": { "targetId": "x" } }),
        );
    }
    assert_eq!(tap.outstanding(), 1, "only the slow one is still waiting");
    server(
        &mut tap,
        &json!({ "id": 1, "result": { "sessionId": "s2" } }),
    );
    command(&mut tap, &in_session(5002, "Page.reload", "s2"));
    assert_eq!(
        seen.all().last().map(String::as_str),
        Some("T2"),
        "its reply was still correlated"
    );
    assert_eq!(tap.outstanding(), 0);
}

#[test]
fn an_error_reply_retires_its_request() {
    let (mut tap, seen) = tap_on(BROWSER);
    command(
        &mut tap,
        &json!({ "id": 7, "method": "Target.attachToTarget", "params": { "targetId": "T2" } }),
    );
    assert_eq!(tap.outstanding(), 1);
    server(
        &mut tap,
        &json!({ "id": 7, "error": { "code": -32000, "message": "No target" } }),
    );
    assert_eq!(tap.outstanding(), 0, "an error is a terminal reply");
    server(
        &mut tap,
        &json!({ "id": 7, "result": { "sessionId": "s2" } }),
    );
    command(&mut tap, &in_session(8, "Page.reload", "s2"));
    assert!(seen.all().is_empty(), "the retired id correlates nothing");
}

#[test]
fn the_reason_for_switching_off_is_recorded_whatever_the_cause() {
    let upgrade_reason = |response: &str| {
        let mut tap = Tap::new(BROWSER, Reported::default().callback());
        assert_eq!(tap.disabled_reason(), None);
        tap.feed_server(response.as_bytes());
        tap.disabled_reason()
    };
    assert_eq!(
        upgrade_reason(
            "HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n"
        ),
        Some("Sec-WebSocket-Extensions negotiated (compressed frames)")
    );
    assert_eq!(
        upgrade_reason("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n"),
        Some("upgrade refused")
    );
    assert_eq!(
        upgrade_reason("HTTP/1.1 101 Switching Protocols\r\n\r\n"),
        None
    );

    let (mut tap, _) = tap_on(BROWSER);
    tap.feed_client(&[0xFF; 32]);
    assert_eq!(
        tap.disabled_reason(),
        Some("client frames cannot be followed")
    );
}
