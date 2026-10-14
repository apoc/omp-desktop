use std::net::TcpListener;
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::Message;

use super::cdp::{CdpClient, DISCONNECTED};

/// A one-connection CDP stand-in: `echo` answers with its params, `event`
/// sends an event first, `fail` answers with an error, `drop` closes the
/// socket without answering.
fn fake_server() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut ws = tungstenite::accept(stream).unwrap();
        while let Ok(Message::Text(text)) = ws.read() {
            let request: Value = serde_json::from_str(text.as_str()).unwrap();
            let id = request["id"].clone();
            let reply = match request["method"].as_str().unwrap() {
                "event" => {
                    let event =
                        json!({ "method": "Fake.event", "sessionId": "s1", "params": { "n": 1 } });
                    ws.send(Message::text(event.to_string())).unwrap();
                    json!({ "id": id, "result": {} })
                }
                "fail" => json!({ "id": id, "error": { "code": -32000, "message": "nope" } }),
                "drop" => return,
                _ => json!({ "id": id, "result": request["params"] }),
            };
            ws.send(Message::text(reply.to_string())).unwrap();
        }
    });
    format!("ws://127.0.0.1:{port}/devtools/browser/x")
}

type Seen = (Option<String>, String, Value);

fn connect(url: &str) -> (CdpClient, Receiver<Seen>) {
    let (tx, rx) = mpsc::channel();
    let client = CdpClient::connect(
        url,
        Box::new(move |session, method, params| {
            let _ = tx.send((
                session.map(str::to_owned),
                method.to_owned(),
                params.clone(),
            ));
        }),
    )
    .unwrap();
    (client, rx)
}

#[test]
fn calls_get_their_own_responses_and_events_reach_the_handler() {
    let (client, events) = connect(&fake_server());
    assert_eq!(
        client.call(None, "echo", json!({ "a": 1 })).unwrap(),
        json!({ "a": 1 })
    );
    client.call(Some("s1"), "event", json!({})).unwrap();
    let (session, method, params) = events.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(session.as_deref(), Some("s1"));
    assert_eq!(method, "Fake.event");
    assert_eq!(params["n"], 1);
    client.close();
}

#[test]
fn concurrent_calls_are_matched_by_id() {
    let (client, _events) = connect(&fake_server());
    thread::scope(|s| {
        let calls: Vec<_> = (0..8)
            .map(|i| {
                let client = &client;
                s.spawn(move || client.call(None, "echo", json!({ "i": i })).unwrap())
            })
            .collect();
        for (i, call) in calls.into_iter().enumerate() {
            assert_eq!(call.join().unwrap(), json!({ "i": i }));
        }
    });
}

#[test]
fn an_error_response_is_the_calls_error() {
    let (client, _events) = connect(&fake_server());
    assert_eq!(client.call(None, "fail", json!({})), Err("nope".to_owned()));
}

#[test]
fn a_lost_connection_fails_the_pending_call_and_is_reported_once() {
    let (client, events) = connect(&fake_server());
    let started = Instant::now();
    assert!(client.call(None, "drop", json!({})).is_err());
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "not the 10 s timeout"
    );
    let (_, method, _) = events.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(method, DISCONNECTED);
    assert!(client.call(None, "echo", json!({})).is_err());
    assert!(events.recv_timeout(Duration::from_millis(300)).is_err());
}

#[test]
fn close_ends_the_reader_promptly_without_a_disconnect_event() {
    let (client, events) = connect(&fake_server());
    client.call(None, "echo", json!({})).unwrap();
    let started = Instant::now();
    client.close();
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(client.call(None, "echo", json!({})).is_err());
    assert!(events.recv_timeout(Duration::from_millis(300)).is_err());
    client.close(); // idempotent
}

#[test]
fn only_loopback_ws_urls_are_accepted() {
    let handler = || Box::new(|_: Option<&str>, _: &str, _: &Value| {});
    assert!(CdpClient::connect("http://127.0.0.1:1/x", handler()).is_err());
    assert!(CdpClient::connect("ws://192.0.2.1:9222/x", handler()).is_err());
}
