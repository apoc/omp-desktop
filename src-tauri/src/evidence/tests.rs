use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};

use serde_json::{json, Value};

use super::{worker, EvidenceHost};
use crate::test_support::TempDir;

fn notify(epoch: &str, session: &str, file: Option<&str>, records: Value) -> Value {
    static SEQUENCE: AtomicU64 = AtomicU64::new(1);
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let payload = json!({"version":1,"epoch":epoch,"command":format!("omp-desktop-evidence-{epoch}"),
        "view":{"version":1,"epoch":epoch,"branchToken":format!("{epoch}-g1"),"sessionId":session,"file":file,"sequence":sequence,"records":records,"receipts":[]}});
    json!({"type":"extension_ui_request","method":"notify","message":format!("OMP_DESKTOP_EVIDENCE:{payload}")})
}

fn request(epoch: &str, session: &str, file: Option<&str>, op: &str, args: Value) -> String {
    json!({"version":1,"epoch":epoch,"sessionId":session,"file":file,"op":op,"args":args})
        .to_string()
}

#[test]
fn private_envelopes_are_bounded_and_only_private_input_is_intercepted() {
    let frame = json!({"type":"extension_ui_request","method":"input","id":"q", "title":format!("OMP_DESKTOP_EVIDENCE_REQUEST:{}", request("epoch", "s", None, "fingerprint", json!({})))});
    assert!(worker::parse(worker::private_payload(&frame).unwrap()).is_ok());
    assert!(worker::private_payload(
        &json!({"type":"extension_ui_request","method":"notify","title":frame["title"]})
    )
    .is_none());
    assert!(worker::parse(&request("", "s", None, "ci", json!({}))).is_err());
    assert!(worker::parse(&request("e", "s", None, "ci", json!([]))).is_err());
    assert!(worker::parse(&"x".repeat(16 * 1024 + 1)).is_err());
    for path in ["../file", "/etc/passwd", "a/b", "a\\b", ".", "..", ""] {
        assert!(!worker::valid_filename(path), "{path}");
    }
    assert!(worker::valid_filename("report.txt"));
}

#[test]
fn queue_full_is_answered_as_error_and_dead_runs_cannot_reply() {
    let (tx, rx) = mpsc::sync_channel(1);
    let (reject, rejects) = mpsc::sync_channel(1);
    worker::enqueue(&tx, &reject, Ok::<_, String>(1), |value| {
        *value = Err("full".into());
    });
    worker::enqueue(&tx, &reject, Ok(2), |value| *value = Err("full".into()));
    assert_eq!(rx.recv().unwrap(), Ok(1));
    assert_eq!(rejects.recv().unwrap(), Err("full".to_string()));
    let writer = Mutex::new(Vec::new());
    let live = AtomicBool::new(true);
    let alive = AtomicBool::new(true);
    worker::reply(
        &writer,
        &live,
        &alive,
        "req",
        Err("Evidence host queue is full".into()),
    );
    let bytes = writer.lock().unwrap();
    let wire: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(wire["type"], "extension_ui_response");
    assert_eq!(wire["id"], "req");
    let result: Value = serde_json::from_str(wire["value"].as_str().unwrap()).unwrap();
    assert_eq!(result["ok"], false);
    assert_eq!(result["error"], "Evidence host queue is full");
    let response_len = bytes.len();
    drop(bytes);
    live.store(false, Ordering::Release);
    worker::reply(&writer, &live, &alive, "stale", Ok(json!(1)));
    assert_eq!(writer.lock().unwrap().len(), response_len);
}

#[test]
fn epochs_and_conversations_gate_requests_and_replay() {
    let host = EvidenceHost::new(None, None);
    host.register_run("tab", "epoch-1", None, None).unwrap();
    let first = notify("epoch-1", "session-a", Some("a"), json!([]));
    host.observe_snapshot("tab", "epoch-1", &first);
    assert!(host.snapshot("tab").unwrap()["sequence"].as_u64().unwrap() > 0);
    host.observe_snapshot(
        "tab",
        "epoch-1",
        &notify("epoch-1", "session-b", Some("b"), json!([])),
    );
    host.observe_snapshot("tab", "epoch-1", &first);
    assert_eq!(host.snapshot("tab").unwrap()["sessionId"], "session-b");
    host.observe_snapshot(
        "tab",
        "epoch-1",
        &notify("epoch-1", "session-a", Some("a"), json!([])),
    );
    let live = {
        let runs = host.shared.runs.lock().unwrap();
        std::sync::Arc::clone(&runs.entries["tab"].live)
    };
    let good = worker::parse(&request(
        "epoch-1",
        "session-a",
        Some("a"),
        "defaults",
        json!({}),
    ))
    .unwrap();
    assert_eq!(
        worker::dispatch(&host.shared, "tab", "epoch-1", &live, good).unwrap()["policy"]["source"],
        "builtin"
    );
    let stale = worker::parse(&request(
        "epoch-1",
        "other",
        Some("a"),
        "defaults",
        json!({}),
    ))
    .unwrap();
    assert!(
        worker::dispatch(&host.shared, "tab", "epoch-1", &live, stale)
            .unwrap_err()
            .contains("stale")
    );
    let mut branch = notify("epoch-1", "session-a", Some("a"), json!([]));
    let message = branch["message"]
        .as_str()
        .unwrap()
        .strip_prefix("OMP_DESKTOP_EVIDENCE:")
        .unwrap();
    let mut payload: Value = serde_json::from_str(message).unwrap();
    payload["view"]["branchToken"] = json!("epoch-1-g2");
    branch["message"] = json!(format!("OMP_DESKTOP_EVIDENCE:{payload}"));
    host.observe_snapshot("tab", "epoch-1", &branch);
    assert!(
        !live.load(Ordering::Acquire),
        "branch changes invalidate in-flight work"
    );
    host.register_run("tab", "epoch-2", None, None).unwrap();
    assert!(!live.load(Ordering::Acquire));
    host.observe_snapshot(
        "tab",
        "epoch-1",
        &notify("epoch-1", "session-a", Some("a"), json!([])),
    );
    assert!(host.snapshot("tab").is_none());
    host.observe_snapshot(
        "tab",
        "epoch-2",
        &notify("epoch-2", "session-b", Some("b"), json!([])),
    );
    host.forget_run("tab", Some("epoch-1"));
    assert_eq!(host.snapshot("tab").unwrap()["sessionId"], "session-b");
    host.forget_run("tab", Some("epoch-2"));
    assert!(host.snapshot("tab").is_none());
}

#[test]
fn only_current_branch_artifacts_are_authorized_and_stored_metadata_is_checked() {
    let dir = TempDir::new("evidence-host", "membership");
    let path = dir.path().join("evidence.txt");
    std::fs::write(&path, "independent observation\n").unwrap();
    let host = EvidenceHost::new(None, Some(dir.path().to_path_buf()));
    host.register_run("tab", "epoch", None, None).unwrap();
    host.observe_snapshot(
        "tab",
        "epoch",
        &notify("epoch", "child", Some("session"), json!([])),
    );
    // A branch can retain a genuine artifact from its ancestor session.
    let artifact = host.shared.media.import(&path, "ancestor", None).unwrap();
    assert!(host.asset_source("tab", &artifact.id).is_err());
    host.observe_snapshot(
        "tab",
        "epoch",
        &notify(
            "epoch",
            "child",
            Some("session"),
            json!([{"artifact":&artifact}]),
        ),
    );
    let source = host.asset_source("tab", &artifact.id).unwrap();
    let request = tauri::http::Request::builder()
        .uri(format!("evidence://localhost/{}", source.token))
        .body(Vec::new())
        .unwrap();
    assert_eq!(
        host.media_response(&request).status(),
        tauri::http::StatusCode::OK
    );
    host.observe_snapshot(
        "tab",
        "epoch",
        &notify("epoch", "child", Some("session"), json!([])),
    );
    assert_eq!(
        host.media_response(&request).status(),
        tauri::http::StatusCode::NOT_FOUND
    );
    let mut forged = serde_json::to_value(&artifact).unwrap();
    forged["owner"] = json!("child");
    host.observe_snapshot(
        "tab",
        "epoch",
        &notify(
            "epoch",
            "child",
            Some("session"),
            json!([{"artifact":forged}]),
        ),
    );
    assert!(host.asset_source("tab", &artifact.id).is_err());
}

#[test]
fn import_is_bound_to_the_registered_inbox_and_conversation() {
    let dir = TempDir::new("evidence-host", "inbox");
    let host = EvidenceHost::new(None, Some(dir.path().to_path_buf()));
    let bootstrap =
        serde_json::to_value(host.register_run("tab", "run", None, None).unwrap()).unwrap();
    let inbox = std::path::Path::new(bootstrap["inbox"].as_str().unwrap());
    std::fs::write(inbox.join("proof.txt"), "captured\n").unwrap();
    host.observe_snapshot(
        "tab",
        "run",
        &notify("run", "conversation", None, json!([])),
    );
    let live = {
        let runs = host.shared.runs.lock().unwrap();
        std::sync::Arc::clone(&runs.entries["tab"].live)
    };
    let import = worker::parse(&request(
        "run",
        "conversation",
        None,
        "import",
        json!({"filename":"proof.txt"}),
    ))
    .unwrap();
    let artifact = worker::dispatch(&host.shared, "tab", "run", &live, import).unwrap();
    assert_eq!(artifact["owner"], "conversation");
    assert_eq!(artifact["mime"], "text/plain");
    for filename in ["../proof.txt", "missing.txt"] {
        let import = worker::parse(&request(
            "run",
            "conversation",
            None,
            "import",
            json!({"filename":filename}),
        ))
        .unwrap();
        assert!(worker::dispatch(&host.shared, "tab", "run", &live, import).is_err());
    }
}

#[test]
fn two_phase_shutdown_revokes_runs_and_rejects_new_admissions() {
    let host = EvidenceHost::new(None, None);
    host.register_run("tab", "run", None, None).unwrap();
    host.observe_snapshot(
        "tab",
        "run",
        &notify("run", "conversation", None, json!([])),
    );
    let live = {
        let runs = host.shared.runs.lock().unwrap();
        std::sync::Arc::clone(&runs.entries["tab"].live)
    };
    host.begin_shutdown();
    assert!(host.register_run("other", "new", None, None).is_err());
    host.shutdown();
    assert!(!live.load(Ordering::Acquire));
    assert!(host.snapshot("tab").is_none());
    host.shutdown();
}
