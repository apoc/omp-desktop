//! The core driver loop end to end, against the `fake-omp` binary: wake-ups
//! reach omp, approvals land in the inbox, crashes expire them, and settings
//! and schedules are persisted.

use chrono::NaiveDate;
use omp_desktop_core::persona_paths::{ensure_private_dir, Paths};
use omp_desktop_core::persona_protocol::{
    ClientKind, ClientMsg, InboxItem, ItemKind, ItemState, NotifyKind, PersonaSettings, ServerMsg,
};
use omp_desktopd::budget::Usage;
use omp_desktopd::core::{Core, CoreMsg};
use omp_desktopd::scheduler::Now;
use omp_desktopd::server::{
    Inbound, InboundBudget, Outbound, MAX_INBOUND_BYTES, MAX_OUTBOUND_BYTES,
};
use omp_desktopd::session::{Launch, SessionEvent};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

struct Harness {
    tx: mpsc::Sender<CoreMsg>,
    out: mpsc::Receiver<Vec<u8>>,
    clock: Arc<AtomicI64>,
    paths: Paths,
    log: PathBuf,
    instructions: PathBuf,
}

const fn t0_ms() -> i64 {
    // Monday 2026-11-16 09:00 local == UTC.
    NaiveDate::from_ymd_opt(2026, 11, 16)
        .unwrap()
        .and_hms_opt(9, 0, 0)
        .unwrap()
        .and_utc()
        .timestamp_millis()
}

/// How many quarantine names the store tries before it reports the file as
/// protected: `.bad-<ms>` plus the `-N` collision suffixes (`ASIDE_ATTEMPTS`
/// in `core::store`). A raise there makes these setups block too few names and
/// the three protection tests fail loudly instead of passing falsely.
const QUARANTINE_NAMES: u32 = 100;

/// Squat every name the store may quarantine `path` under, so both the
/// non-clobbering move and the copy find no free name and fail.
///
/// Directories are used because `create_new`/`hard_link` refuse an existing
/// destination on every platform, while the persona directory itself stays
/// writable for the rest of the harness.
fn block_quarantine_names(path: &Path) {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .expect("state file has a unicode file name");
    for collision in 0..QUARANTINE_NAMES {
        let suffix = if collision == 0 {
            String::new()
        } else {
            format!("-{collision}")
        };
        let candidate = path.with_file_name(format!("{name}.bad-{}{suffix}", t0_ms()));
        std::fs::create_dir(&candidate).unwrap();
    }
}

fn start(tag: &str, client: ClientKind) -> Harness {
    start_with(
        tag,
        client,
        PathBuf::from(env!("CARGO_BIN_EXE_fake-omp")),
        |_| {},
    )
}

fn start_with(
    tag: &str,
    client: ClientKind,
    program: PathBuf,
    setup: impl FnOnce(&Paths),
) -> Harness {
    let root = std::env::temp_dir().join(format!("ompy-core-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let paths = Paths::under(&root);
    ensure_private_dir(&paths.persona).unwrap();
    let log = root.join("sent.log");
    let instructions = root.join("i.md");
    // The service creates the instructions file from the embedded default
    // before it spawns omp; the harness mirrors that so a wake does not report
    // a missing file.
    std::fs::write(&instructions, "").unwrap();
    let launch = Launch {
        program: omp_desktopd::session::ProgramSource::Fixed(program),
        home: root.clone(),
        sessions: paths.sessions.clone(),
        extension: root.join("e.mjs"),
        instructions: instructions.clone(),
        socket_env: "x".into(),
        env: vec![("FAKE_OMP_LOG".into(), log.display().to_string())],
    };
    let t0 = t0_ms();
    setup(&paths);
    let clock = Arc::new(AtomicI64::new(t0));
    let c2 = Arc::clone(&clock);
    let core = Core::new(
        paths.clone(),
        launch,
        Box::new(move || {
            let ms = c2.load(Ordering::SeqCst);
            Now {
                utc_ms: ms,
                local: chrono::DateTime::from_timestamp_millis(ms)
                    .unwrap()
                    .naive_utc(),
            }
        }),
    );
    let (tx, rx) = mpsc::channel();
    let tx2 = tx.clone();
    std::thread::spawn(move || core.run(rx, tx2));
    let (out_tx, out) = mpsc::channel();
    tx.send(CoreMsg::Connected {
        conn: 1,
        out: Outbound::new(out_tx, MAX_OUTBOUND_BYTES),
        client,
    })
    .unwrap();
    Harness {
        tx,
        out,
        clock,
        paths,
        log,
        instructions,
    }
}

fn send(h: &Harness, req: u64, msg: ClientMsg) {
    h.tx.send(CoreMsg::Inbound(Inbound {
        conn: 1,
        req: Some(req),
        client: ClientKind::App,
        msg,
        bytes: 0,
        reservation: InboundBudget::new(MAX_INBOUND_BYTES).reserve(0).unwrap(),
    }))
    .unwrap();
}

fn parse_msg(line: &[u8]) -> ServerMsg {
    let value: serde_json::Value = serde_json::from_slice(line).unwrap();
    if value["type"] == "rpc" {
        return ServerMsg::Rpc {
            seq: value["seq"].as_u64().unwrap(),
            frame: serde_json::value::RawValue::from_string(value["frame"].to_string()).unwrap(),
        };
    }
    serde_json::from_value(value).unwrap()
}

fn reply(h: &Harness, req: u64) -> ServerMsg {
    loop {
        let line = h.out.recv_timeout(Duration::from_secs(5)).unwrap();
        match parse_msg(&line) {
            m @ ServerMsg::Reply { req: r, .. } if r == req => return m,
            _ => {}
        }
    }
}

fn current_generation(h: &Harness) -> u64 {
    send(h, 99_999, ClientMsg::Status);
    match reply(h, 99_999) {
        ServerMsg::Reply {
            data: Some(data), ..
        } => data["generation"].as_u64().unwrap(),
        _ => panic!("status reply missing"),
    }
}

/// The next message the test connection receives.
fn next_msg(h: &Harness) -> ServerMsg {
    let line = h.out.recv_timeout(Duration::from_secs(10)).unwrap();
    parse_msg(&line)
}

#[test]
fn handled_message_releases_its_inbound_budget() {
    let h = start("inbound-budget", ClientKind::App);
    let budget = InboundBudget::new(MAX_INBOUND_BYTES);
    let reservation = budget.reserve(4096).unwrap();
    assert_eq!(budget.queued_bytes(), 4096);
    h.tx.send(CoreMsg::Inbound(Inbound {
        conn: 1,
        req: Some(7),
        client: ClientKind::App,
        msg: ClientMsg::Status,
        bytes: 4096,
        reservation,
    }))
    .unwrap();
    assert!(matches!(reply(&h, 7), ServerMsg::Reply { ok: true, .. }));
    assert_eq!(budget.queued_bytes(), 0);
    let _ = h.tx.send(CoreMsg::Shutdown);
}

#[test]
fn missing_omp_is_retried_and_starts_when_it_appears() {
    let dir = std::env::temp_dir().join(format!("ompy-missing-omp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    // A fixed path that does not exist yet: the spawn fails and the retry loop
    // keeps the service up.
    let target = dir.join("fake-omp");
    let h = start_with("missing-omp", ClientKind::App, target.clone(), |_| {});

    let mut seen_error = false;
    let mut notices = 0;
    while !seen_error || notices == 0 {
        match next_msg(&h) {
            ServerMsg::Status { status } if status.state == "error" => seen_error = true,
            ServerMsg::Inbox { items } => {
                notices = items
                    .iter()
                    .filter(|item| item.title.contains("did not start"))
                    .count();
            }
            _ => {}
        }
    }
    assert_eq!(notices, 1, "a spawn outage must leave one notice");
    // Let at least one more spawn attempt fail; the second failure must not add
    // another notice.
    std::thread::sleep(Duration::from_millis(1_200));
    std::fs::copy(env!("CARGO_BIN_EXE_fake-omp"), &target).unwrap();
    loop {
        match next_msg(&h) {
            ServerMsg::Status { status } if status.state == "running" => break,
            ServerMsg::Inbox { items } => {
                notices = items
                    .iter()
                    .filter(|item| item.title.contains("did not start"))
                    .count();
            }
            _ => {}
        }
    }
    assert_eq!(notices, 1, "a spawn outage must leave one notice");
    let _ = h.tx.send(CoreMsg::Shutdown);
    let _ = std::fs::remove_dir_all(&dir);
}

fn wait_log(h: &Harness, needle: &str) {
    for _ in 0..100 {
        if std::fs::read_to_string(&h.log)
            .unwrap_or_default()
            .contains(needle)
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!(
        "fake omp never got {needle:?}; it saw: {:?}",
        std::fs::read_to_string(&h.log).unwrap_or_default()
    );
}

fn inbox_items(h: &Harness) -> Vec<InboxItem> {
    let text = std::fs::read_to_string(&h.paths.inbox).unwrap_or_default();
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    serde_json::from_value(value["items"].clone()).unwrap_or_default()
}

fn wait_until(h: &Harness, done: impl Fn(&[InboxItem]) -> bool) -> Vec<InboxItem> {
    for _ in 0..100 {
        let items = inbox_items(h);
        if done(&items) {
            return items;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("condition not reached");
}

#[test]
fn wake_now_sends_prompt_and_approval_lands_in_inbox() {
    let h = start("wake", ClientKind::App);
    std::fs::write(&h.instructions, "instructions-marker-alpha").unwrap();
    send(&h, 1, ClientMsg::WakeNow);
    wait_log(&h, "[ompy wake] trigger: manual");
    assert!(matches!(reply(&h, 1), ServerMsg::Reply { ok: true, .. }));
    assert!(
        !std::fs::read_to_string(&h.log)
            .unwrap_or_default()
            .contains("instructions-marker-alpha"),
        "instructions are the system prompt, never part of the wake message"
    );
    let first_approval = wait_until(&h, |items| {
        items
            .iter()
            .any(|i| i.kind == ItemKind::Approval && i.state == ItemState::Open)
    })
    .into_iter()
    .find(|i| i.kind == ItemKind::Approval)
    .unwrap()
    .id;
    answer(&h, 3, &first_approval, "Deny");
    assert!(matches!(reply(&h, 3), ServerMsg::Reply { ok: true, .. }));
    wait_log(&h, r#""value":"Deny""#);
}

#[test]
fn stdin_failure_restarts_the_live_session() {
    let h = start("stdin-restart", ClientKind::App);
    let first_generation = current_generation(&h);
    h.tx.send(CoreMsg::Session {
        gen: first_generation,
        ev: SessionEvent::StdinFailed {
            reason: "test stdin timeout".into(),
        },
    })
    .unwrap();

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(Instant::now() < deadline, "session did not restart");
        send(&h, 91, ClientMsg::Status);
        match reply(&h, 91) {
            ServerMsg::Reply {
                data: Some(data), ..
            } if data["generation"].as_u64().unwrap() > first_generation => break,
            _ => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    let _ = h.tx.send(CoreMsg::Shutdown);
}

#[test]
fn crash_expires_bound_items() {
    let h = start("crash", ClientKind::App);
    send(&h, 1, ClientMsg::WakeNow);
    wait_until(&h, |items| {
        items
            .iter()
            .any(|i| i.state == ItemState::Open && i.rpc_request_id.is_some())
    });
    send(
        &h,
        2,
        ClientMsg::Rpc {
            frame: serde_json::json!({"type": "crash"}),
        },
    );
    wait_until(&h, |items| {
        items.iter().any(|i| i.state == ItemState::Expired)
            && items.iter().any(|i| i.kind == ItemKind::Notice)
    });
}

#[test]
fn answering_approval_writes_response_and_unblocks() {
    let h = start("answer", ClientKind::App);
    send(&h, 1, ClientMsg::WakeNow);
    let id = wait_until(&h, |items| {
        items
            .iter()
            .any(|i| i.kind == ItemKind::Approval && i.state == ItemState::Open)
    })
    .into_iter()
    .find(|i| i.kind == ItemKind::Approval)
    .unwrap()
    .id;
    send(
        &h,
        2,
        ClientMsg::InboxResolve {
            id,
            answer: Some("Approve".into()),
        },
    );
    wait_log(&h, r#""value":"Approve""#);
}

#[test]
fn offline_answers_fail_and_leave_the_item_open() {
    let missing = std::env::temp_dir().join(format!("ompy-offline-answer-{}", std::process::id()));
    let h = start_with("offline-answer", ClientKind::App, missing, |_| {});
    // A decision has no omp request behind it: answering it sends a prompt,
    // which has nowhere to go while the session is down.
    send(
        &h,
        1,
        ClientMsg::Notify {
            kind: NotifyKind::Decision,
            title: "Wait for Ompy?".into(),
            body: None,
            options: Some(vec!["Yes".into(), "No".into()]),
            urgent: false,
        },
    );
    let id = match reply(&h, 1) {
        ServerMsg::Reply {
            data: Some(data), ..
        } => data["id"].as_str().unwrap().to_owned(),
        other => panic!("{other:?}"),
    };

    answer(&h, 2, &id, "Yes");
    assert!(matches!(reply(&h, 2), ServerMsg::Reply { ok: false, .. }));
    assert!(inbox_items(&h)
        .iter()
        .any(|item| item.id == id && item.state == ItemState::Open));

    send(
        &h,
        3,
        ClientMsg::Rpc {
            frame: serde_json::json!({
                "type": "extension_ui_response",
                "id": "offline1",
                "value": "Yes",
            }),
        },
    );
    assert!(matches!(reply(&h, 3), ServerMsg::Reply { ok: false, .. }));
    assert!(inbox_items(&h)
        .iter()
        .any(|item| item.id == id && item.state == ItemState::Open));
    let _ = h.tx.send(CoreMsg::Shutdown);
}

fn open_request(h: &Harness, prompt: &str, rpc_id: &str) -> InboxItem {
    send(
        h,
        1,
        ClientMsg::Rpc {
            frame: serde_json::json!({"type": "prompt", "message": prompt}),
        },
    );
    wait_until(h, |items| {
        items.iter().any(|item| {
            item.rpc_request_id.as_deref() == Some(rpc_id) && item.state == ItemState::Open
        })
    })
    .into_iter()
    .find(|item| item.rpc_request_id.as_deref() == Some(rpc_id))
    .unwrap()
}

fn answer(h: &Harness, req: u64, id: &str, answer: &str) {
    send(
        h,
        req,
        ClientMsg::InboxResolve {
            id: id.into(),
            answer: Some(answer.into()),
        },
    );
}

/// How many wake prompts the fake omp has received so far.
fn wake_count(h: &Harness) -> usize {
    std::fs::read_to_string(&h.log)
        .unwrap_or_default()
        .matches("[ompy wake] trigger:")
        .count()
}

/// Ask for a wake until omp has received `want` wake prompts. A wake asked
/// while the previous turn is still open is held by the scheduler, so the
/// request is simply repeated.
fn wake_until(h: &Harness, want: usize) {
    for req in 700..760 {
        if wake_count(h) >= want {
            return;
        }
        send(h, req, ClientMsg::WakeNow);
        let _ = reply(h, req);
        for _ in 0..40 {
            if wake_count(h) >= want {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    panic!(
        "omp received {} wakes, wanted {want}; inbox: {:?}",
        wake_count(h),
        inbox_items(h)
    );
}

/// Deny the approval the wake's prompt produced so the next wake is not held.
///
/// The fake logs the prompt before the service has turned the resulting
/// `extension_ui_request` into an inbox item, so the item is awaited first: a
/// snapshot taken too early would miss it, and a request nobody answered holds
/// every later wake.
fn deny_wake_approval(h: &Harness) {
    let items = wait_until(h, |items| {
        items
            .iter()
            .any(|item| item.kind == ItemKind::Approval && item.state == ItemState::Open)
    });
    for (req, item) in (800..).zip(
        items
            .into_iter()
            .filter(|item| item.kind == ItemKind::Approval && item.state == ItemState::Open),
    ) {
        answer(h, req, &item.id, "Deny");
        let _ = reply(h, req);
    }
    let items = inbox_items(h);
    assert!(
        items
            .iter()
            .all(|item| !(item.state == ItemState::Open && item.rpc_request_id.is_some())),
        "the wake's approval must be answered before the next wake: {items:?}"
    );
}

#[test]
fn attach_has_no_duplicate_frames() {
    let h = start("attach-duplicates", ClientKind::App);
    send(&h, 1, ClientMsg::WakeNow);
    wait_log(&h, "[ompy wake] trigger: manual");
    for req in 10..30 {
        send(
            &h,
            req,
            ClientMsg::Rpc {
                frame: serde_json::json!({"type": "prompt", "message": "stream"}),
            },
        );
    }
    send(&h, 2, ClientMsg::Attach { after_seq: 0 });

    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    let mut seqs = Vec::new();
    while let Ok(line) = h
        .out
        .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
    {
        if let ServerMsg::Rpc { seq, .. } = parse_msg(&line) {
            seqs.push(seq);
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
    }
    assert!(seqs.len() > 1, "test must observe streamed frames");
    assert!(
        seqs.windows(2).all(|pair| pair[0] < pair[1]),
        "rpc sequence numbers must be strictly increasing: {seqs:?}"
    );
}

#[test]
fn attach_after_restart_replays_new_generation() {
    let h = start("attach-restart", ClientKind::App);
    send(&h, 1, ClientMsg::Status);
    let first_generation = match reply(&h, 1) {
        ServerMsg::Reply {
            data: Some(data), ..
        } => data["generation"].as_u64().unwrap(),
        _ => panic!("status reply missing"),
    };
    send(&h, 2, ClientMsg::Attach { after_seq: 0 });
    // The ready frame is replayed before the attach reply when omp already
    // wrote it, and relayed live after the reply when it did not. Collect it
    // in both orders instead of letting the reply wait discard it.
    let mut first_seqs = Vec::new();
    let mut attached = false;
    while !attached || first_seqs.is_empty() {
        match next_msg(&h) {
            ServerMsg::Rpc { seq, .. } => first_seqs.push(seq),
            ServerMsg::Reply { req: 2, ok, .. } => {
                assert!(ok, "attach was refused");
                attached = true;
            }
            _ => {}
        }
    }
    let last_seq = *first_seqs.last().unwrap();
    send(
        &h,
        3,
        ClientMsg::Rpc {
            frame: serde_json::json!({"type": "crash"}),
        },
    );
    // The connection stays attached across the restart, so the new
    // generation's first frame may be relayed live before the new
    // generation shows up in a Status frame. Keep every such sequence
    // number instead of dropping it.
    let mut new_seqs = Vec::new();
    loop {
        match next_msg(&h) {
            ServerMsg::Rpc { seq, .. } => new_seqs.push(seq),
            ServerMsg::Status { status } if status.generation > first_generation => break,
            _ => {}
        }
    }
    assert!(
        new_seqs.iter().all(|seq| *seq > last_seq),
        "new generation reused sequences {new_seqs:?}, last before restart was {last_seq}"
    );
    send(
        &h,
        4,
        ClientMsg::Attach {
            after_seq: last_seq,
        },
    );
    // The frame may arrive live before the attach reply, be replayed by the
    // attach, or arrive live after it; collect it in all three cases.
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut replied = false;
    while !replied || new_seqs.is_empty() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let line = h
            .out
            .recv_timeout(remaining)
            .expect("new generation produced no frame after restart");
        match parse_msg(&line) {
            ServerMsg::Rpc { seq, .. } => new_seqs.push(seq),
            ServerMsg::Reply { req: 4, ok, .. } => {
                assert!(ok, "attach after restart was refused");
                replied = true;
            }
            _ => {}
        }
    }
    assert!(
        new_seqs.iter().all(|seq| *seq > last_seq),
        "new generation reused sequences {new_seqs:?}, last before restart was {last_seq}"
    );
}

#[test]
fn attach_skips_queued_live_frames_at_or_before_after_seq() {
    let h = start("attach-watermark", ClientKind::App);
    send(&h, 1, ClientMsg::WakeNow);
    wait_log(&h, "[ompy wake] trigger: manual");
    for req in 10..30 {
        send(
            &h,
            req,
            ClientMsg::Rpc {
                frame: serde_json::json!({"type": "prompt", "message": "stream"}),
            },
        );
    }
    send(&h, 2, ClientMsg::Attach { after_seq: 1_000 });

    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    let mut seqs = Vec::new();
    while let Ok(line) = h
        .out
        .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
    {
        if let ServerMsg::Rpc { seq, .. } = parse_msg(&line) {
            seqs.push(seq);
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
    }
    assert!(
        seqs.is_empty(),
        "attach relayed frames the client asked to skip: {seqs:?}"
    );
}

fn assert_no_secret_inbox(msg: &ServerMsg) {
    if let ServerMsg::Inbox { items } = msg {
        assert!(
            items
                .iter()
                .all(|item| item.answer.as_deref() != Some("hunter2")),
            "secret answer leaked in an inbox broadcast"
        );
    }
}

fn reply_asserting_no_secret(h: &Harness, req: u64) -> ServerMsg {
    loop {
        match next_msg(h) {
            m @ ServerMsg::Reply { req: r, .. } if r == req => return m,
            m => assert_no_secret_inbox(&m),
        }
    }
}

fn assert_no_later_secret_broadcast(h: &Harness) {
    while let Ok(line) = h.out.recv_timeout(Duration::from_millis(250)) {
        assert_no_secret_inbox(&parse_msg(&line));
    }
}

#[test]
fn secret_input_answer_not_persisted() {
    let h = start("secret-input", ClientKind::App);
    let item = open_request(&h, "secret", "s1");
    assert!(item.secret);
    answer(&h, 2, &item.id, "hunter2");
    assert!(matches!(
        reply_asserting_no_secret(&h, 2),
        ServerMsg::Reply { ok: true, .. }
    ));
    assert_no_later_secret_broadcast(&h);
    wait_log(&h, r#""value":"hunter2""#);
    assert!(std::fs::read_to_string(&h.log)
        .unwrap()
        .lines()
        .any(|line| line.contains(r#""id":"s1""#) && line.contains(r#""value":"hunter2""#)));
    assert!(!std::fs::read_to_string(&h.paths.inbox)
        .unwrap()
        .contains("hunter2"));
}

#[test]
fn app_secret_response_is_not_persisted_or_broadcast() {
    let h = start("app-secret-input", ClientKind::App);
    let item = open_request(&h, "secret", "s1");
    assert!(item.secret);
    send(
        &h,
        2,
        ClientMsg::Rpc {
            frame: serde_json::json!({
                "type": "extension_ui_response",
                "id": "s1",
                "value": "hunter2",
            }),
        },
    );
    assert!(matches!(
        reply_asserting_no_secret(&h, 2),
        ServerMsg::Reply { ok: true, .. }
    ));
    assert_no_later_secret_broadcast(&h);
    let stored: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&h.paths.inbox).unwrap()).unwrap();
    assert!(stored["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|stored_item| stored_item["rpcRequestId"] == "s1")
        .is_some_and(|stored_item| stored_item["state"] != "open"));
    assert!(!std::fs::read_to_string(&h.paths.inbox)
        .unwrap()
        .contains("hunter2"));
}

#[test]
fn ask_option_answer_uses_selected_options_and_renders_question() {
    let h = start("ask-option", ClientKind::App);
    let item = open_request(&h, "ask", "ask1");
    assert!(item
        .body
        .as_deref()
        .unwrap_or_default()
        .contains("Deploy now?"));
    answer(&h, 2, &item.id, "Yes");
    assert!(matches!(reply(&h, 2), ServerMsg::Reply { ok: true, .. }));
    wait_log(&h, r#""answers":[{"id":"q1","selectedOptions":["Yes"]}]"#);
}

#[test]
fn ask_free_text_answer_uses_custom_input() {
    let h = start("ask-custom", ClientKind::App);
    let item = open_request(&h, "ask", "ask1");
    answer(&h, 2, &item.id, "Not until tomorrow");
    assert!(matches!(reply(&h, 2), ServerMsg::Reply { ok: true, .. }));
    wait_log(&h, r#""customInput":"Not until tomorrow""#);
}

#[test]
fn confirm_answer_uses_confirmed_boolean() {
    let h = start("confirm", ClientKind::App);
    let item = open_request(&h, "confirm", "confirm1");
    answer(&h, 2, &item.id, "Confirm");
    assert!(matches!(reply(&h, 2), ServerMsg::Reply { ok: true, .. }));
    wait_log(&h, r#""id":"confirm1""#);
    wait_log(&h, r#""confirmed":true"#);
}

#[test]
fn confirm_labels_on_select_still_use_string_value() {
    let h = start("select-confirm", ClientKind::App);
    let item = open_request(&h, "select", "sel1");
    answer(&h, 2, &item.id, "Confirm");
    assert!(matches!(reply(&h, 2), ServerMsg::Reply { ok: true, .. }));
    wait_log(&h, r#""id":"sel1""#);
    wait_log(&h, r#""value":"Confirm""#);
}

#[test]
fn multi_question_ask_accepts_ordered_json_answers() {
    let h = start("multi-ask", ClientKind::App);
    let item = open_request(&h, "multi-ask", "multi1");
    answer(&h, 2, &item.id, r#"["Yes","Something else"]"#);
    assert!(matches!(reply(&h, 2), ServerMsg::Reply { ok: true, .. }));
    wait_log(&h, r#""answers":[{"id":"q1","selectedOptions":["Yes"]}"#);
    wait_log(&h, r#""id":"q2""#);
    wait_log(&h, r#""customInput":"Something else""#);
}

#[test]
fn invalid_multi_question_answer_leaves_item_open() {
    let h = start("multi-ask-invalid", ClientKind::App);
    let item = open_request(&h, "multi-ask", "multi1");
    let id = item.id;
    answer(&h, 2, &id, "Yes");
    assert!(matches!(reply(&h, 2), ServerMsg::Reply { ok: false, .. }));
    assert!(inbox_items(&h)
        .iter()
        .any(|item| item.id == id && item.state == ItemState::Open));
    assert!(!std::fs::read_to_string(&h.log)
        .unwrap_or_default()
        .contains(r#""id":"multi1","answers""#));
}

#[test]
fn schedule_wake_validates_and_persists() {
    let h = start("sched", ClientKind::Extension);
    h.tx.send(CoreMsg::Inbound(Inbound {
        conn: 1,
        req: Some(5),
        client: ClientKind::Extension,
        msg: ClientMsg::ScheduleWake {
            at_ms: None,
            in_ms: Some(-5),
            note: "x".into(),
        },
        bytes: 0,
        reservation: InboundBudget::new(MAX_INBOUND_BYTES).reserve(0).unwrap(),
    }))
    .unwrap();
    assert!(matches!(reply(&h, 5), ServerMsg::Reply { ok: false, .. }));
    h.tx.send(CoreMsg::Inbound(Inbound {
        conn: 1,
        req: Some(6),
        client: ClientKind::Extension,
        msg: ClientMsg::ScheduleWake {
            at_ms: None,
            in_ms: Some(3_600_000),
            note: "later".into(),
        },
        bytes: 0,
        reservation: InboundBudget::new(MAX_INBOUND_BYTES).reserve(0).unwrap(),
    }))
    .unwrap();
    assert!(matches!(reply(&h, 6), ServerMsg::Reply { ok: true, .. }));
    assert!(std::fs::read_to_string(&h.paths.schedule)
        .unwrap()
        .contains("later"));
}

#[test]
fn invalid_settings_are_refused() {
    let h = start("settings", ClientKind::App);
    let settings = PersonaSettings {
        daily_token_limit: 5,
        ..PersonaSettings::default()
    };
    send(&h, 7, ClientMsg::SetSettings { settings });
    assert!(matches!(reply(&h, 7), ServerMsg::Reply { ok: false, .. }));
}

#[test]
fn budget_exhaustion_stops_interval_wakes() {
    let h = start("budget", ClientKind::App);
    let settings = PersonaSettings {
        daily_token_limit: 100_000,
        ..PersonaSettings::default()
    };
    send(&h, 1, ClientMsg::SetSettings { settings });
    assert!(matches!(reply(&h, 1), ServerMsg::Reply { ok: true, .. }));
    // fake omp reports 160 tokens per prompt; forcing exhaustion through
    // repeated wakes is slow, so feed usage directly as the session would:
    h.tx.send(CoreMsg::Session {
        gen: current_generation(&h),
        ev: SessionEvent::Usage(Usage {
            input: 100_000,
            output: 0,
            cache_write: 0,
        }),
    })
    .unwrap();
    send(&h, 2, ClientMsg::Status);
    match reply(&h, 2) {
        ServerMsg::Reply {
            data: Some(data), ..
        } => assert_eq!(data["state"], "budget_exhausted"),
        other => panic!("{other:?}"),
    }
    h.clock.fetch_add(31 * 60_000, Ordering::SeqCst);
    h.tx.send(CoreMsg::Tick).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert!(!std::fs::read_to_string(&h.log)
        .unwrap_or_default()
        .contains("trigger: interval"));
}

/// Wait until the session is gone: a frame sent to a dead session is refused.
fn wait_down(h: &Harness) {
    for req in 10_000..10_400 {
        send(
            h,
            req,
            ClientMsg::Rpc {
                frame: serde_json::json!({"type": "noop"}),
            },
        );
        if let ServerMsg::Reply { ok: false, .. } = reply(h, req) {
            return;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    panic!("session never went down");
}

fn open_approval_id(h: &Harness) -> String {
    wait_until(h, |items| {
        items
            .iter()
            .any(|i| i.kind == ItemKind::Approval && i.state == ItemState::Open)
    })
    .into_iter()
    .find(|i| i.kind == ItemKind::Approval)
    .unwrap()
    .id
}

#[test]
fn spawn_failure_is_noticed_once() {
    let h = start_with(
        "spawn-fail",
        ClientKind::App,
        PathBuf::from("/nonexistent/omp-for-test"),
        |_| {},
    );
    send(&h, 1, ClientMsg::Status);
    assert!(matches!(reply(&h, 1), ServerMsg::Reply { ok: true, .. }));
    for req in 2..=4 {
        h.tx.send(CoreMsg::Restart).unwrap();
        send(&h, req, ClientMsg::Status);
        assert!(matches!(reply(&h, req), ServerMsg::Reply { ok: true, .. }));
    }
    let items = inbox_items(&h);
    let notices = items
        .iter()
        .filter(|i| i.title.starts_with("Ompy's omp process did not start"))
        .count();
    assert_eq!(notices, 1, "one outage adds exactly one notice");
}

#[test]
fn exhausted_budget_resets_at_local_midnight_on_tick() {
    let h = start("budget-midnight", ClientKind::App);
    let settings = PersonaSettings {
        daily_token_limit: 100_000,
        ..PersonaSettings::default()
    };
    send(&h, 1, ClientMsg::SetSettings { settings });
    assert!(matches!(reply(&h, 1), ServerMsg::Reply { ok: true, .. }));
    h.tx.send(CoreMsg::Session {
        gen: current_generation(&h),
        ev: SessionEvent::Usage(Usage {
            input: 100_000,
            output: 0,
            cache_write: 0,
        }),
    })
    .unwrap();
    send(&h, 2, ClientMsg::Status);
    match reply(&h, 2) {
        ServerMsg::Reply {
            data: Some(data), ..
        } => assert_eq!(data["state"], "budget_exhausted"),
        other => panic!("{other:?}"),
    }
    // 2026-11-17 00:00:10 local, just past midnight.
    let midnight = NaiveDate::from_ymd_opt(2026, 11, 17)
        .unwrap()
        .and_hms_opt(0, 0, 10)
        .unwrap()
        .and_utc()
        .timestamp_millis();
    h.clock.store(midnight, Ordering::SeqCst);
    h.tx.send(CoreMsg::Tick).unwrap();
    send(&h, 3, ClientMsg::Status);
    match reply(&h, 3) {
        ServerMsg::Reply {
            data: Some(data), ..
        } => assert_eq!(data["state"], "running"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn exhausted_budget_on_start_holds_interval() {
    let h = start_with(
        "budget-startup",
        ClientKind::App,
        PathBuf::from(env!("CARGO_BIN_EXE_fake-omp")),
        |paths| {
            std::fs::write(
                &paths.budget,
                br#"{"limit":2000000,"day":"2026-11-16","used":2000000}"#,
            )
            .unwrap();
        },
    );
    send(&h, 1, ClientMsg::Status);
    match reply(&h, 1) {
        ServerMsg::Reply {
            data: Some(data), ..
        } => assert_eq!(data["state"], "budget_exhausted"),
        other => panic!("{other:?}"),
    }
    h.clock.fetch_add(31 * 60_000, Ordering::SeqCst);
    h.tx.send(CoreMsg::Tick).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert!(!std::fs::read_to_string(&h.log)
        .unwrap_or_default()
        .contains("trigger: interval"));
}

#[test]
fn lowering_limit_below_use_holds_interval() {
    let h = start("budget-lower", ClientKind::App);
    h.tx.send(CoreMsg::Session {
        gen: current_generation(&h),
        ev: SessionEvent::Usage(Usage {
            input: 150_000,
            output: 0,
            cache_write: 0,
        }),
    })
    .unwrap();
    let settings = PersonaSettings {
        daily_token_limit: 100_000,
        ..PersonaSettings::default()
    };
    send(&h, 1, ClientMsg::SetSettings { settings });
    assert!(matches!(reply(&h, 1), ServerMsg::Reply { ok: true, .. }));
    send(&h, 2, ClientMsg::Status);
    match reply(&h, 2) {
        ServerMsg::Reply {
            data: Some(data), ..
        } => assert_eq!(data["state"], "budget_exhausted"),
        other => panic!("{other:?}"),
    }
    h.clock.fetch_add(31 * 60_000, Ordering::SeqCst);
    h.tx.send(CoreMsg::Tick).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert!(!std::fs::read_to_string(&h.log)
        .unwrap_or_default()
        .contains("trigger: interval"));
}

#[test]
fn dismissing_bound_item_cancels_request() {
    let h = start("dismiss", ClientKind::App);
    send(&h, 1, ClientMsg::WakeNow);
    let id = open_approval_id(&h);
    send(&h, 2, ClientMsg::InboxResolve { id, answer: None });
    wait_log(&h, r#""cancelled":true"#);
    assert!(std::fs::read_to_string(&h.log)
        .unwrap_or_default()
        .lines()
        .any(|line| line.contains(r#""id":"ap1""#) && line.contains(r#""cancelled":true"#)));
    wait_until(&h, |items| {
        items
            .iter()
            .any(|i| i.kind == ItemKind::Approval && i.state == ItemState::Dismissed)
    });
}

#[test]
fn app_cancelled_response_dismisses_item() {
    let h = start("app-cancel", ClientKind::App);
    send(&h, 1, ClientMsg::WakeNow);
    open_approval_id(&h);
    send(
        &h,
        2,
        ClientMsg::Rpc {
            frame: serde_json::json!({
                "type": "extension_ui_response",
                "id": "ap1",
                "cancelled": true,
            }),
        },
    );
    wait_until(&h, |items| {
        items
            .iter()
            .any(|i| i.rpc_request_id.as_deref() == Some("ap1") && i.state == ItemState::Dismissed)
    });
}

#[test]
fn corrupt_budget_is_moved_aside_and_replaced() {
    let h = start_with(
        "budget-corrupt",
        ClientKind::App,
        PathBuf::from(env!("CARGO_BIN_EXE_fake-omp")),
        |paths| std::fs::write(&paths.budget, b"{not json").unwrap(),
    );
    let bad = h
        .paths
        .budget
        .with_file_name(format!("budget.json.bad-{}", t0_ms()));
    assert!(bad.exists(), "the corrupt file is moved aside");
    let items = inbox_items(&h);
    assert!(items
        .iter()
        .any(|i| i.title.contains("Budget file was unreadable")));
    h.tx.send(CoreMsg::Session {
        gen: current_generation(&h),
        ev: SessionEvent::Usage(Usage {
            input: 7,
            output: 0,
            cache_write: 0,
        }),
    })
    .unwrap();
    send(&h, 1, ClientMsg::Status);
    assert!(matches!(reply(&h, 1), ServerMsg::Reply { ok: true, .. }));
    let budget = std::fs::read_to_string(&h.paths.budget).unwrap();
    assert!(
        budget.contains("\"used\": 2000007"),
        "the daily limit counts as spent before this usage: {budget}"
    );
}

#[test]
fn inbox_retention_caps_settled_items() {
    let t0 = t0_ms();
    let h = start_with(
        "retention",
        ClientKind::App,
        PathBuf::from(env!("CARGO_BIN_EXE_fake-omp")),
        |paths| {
            let mut items = vec![serde_json::json!({
                "id": "open",
                "kind": "decision",
                "createdAt": t0,
                "title": "keep me",
                "body": null,
                "options": [],
                "urgent": false,
                "state": "open",
                "answer": null,
                "rpcRequestId": null
            })];
            for i in 0..250 {
                items.push(serde_json::json!({
                    "id": format!("old-{i}"),
                    "kind": "result",
                    "createdAt": t0 - i * 1_000,
                    "title": format!("result {i}"),
                    "body": null,
                    "options": [],
                    "urgent": false,
                    "state": "dismissed",
                    "answer": null,
                    "rpcRequestId": null
                }));
            }
            let file = serde_json::json!({"version": 1, "counter": 300, "items": items});
            std::fs::write(&paths.inbox, serde_json::to_vec(&file).unwrap()).unwrap();
        },
    );
    send(
        &h,
        1,
        ClientMsg::Notify {
            kind: NotifyKind::Result,
            title: "fresh".into(),
            body: None,
            options: None,
            urgent: false,
        },
    );
    assert!(matches!(reply(&h, 1), ServerMsg::Reply { ok: true, .. }));
    let items = inbox_items(&h);
    assert!(items.len() <= 200, "settled history is capped");
    assert!(items.iter().any(|i| i.id == "open"), "open items survive");
}

#[test]
fn scheduled_wake_survives_inbox_resolve_while_down() {
    let root = std::env::temp_dir().join(format!("ompy-core-resolve-down-{}", std::process::id()));
    let late_omp = root.join("late-omp");
    let h = start_with("resolve-down", ClientKind::App, late_omp.clone(), |_| {});
    send(
        &h,
        1,
        ClientMsg::ScheduleWake {
            at_ms: Some(t0_ms() + 60_000),
            in_ms: None,
            note: "resolve-down-wake".into(),
        },
    );
    assert!(matches!(reply(&h, 1), ServerMsg::Reply { ok: true, .. }));
    send(
        &h,
        2,
        ClientMsg::Notify {
            kind: NotifyKind::Result,
            title: "resolve while down".into(),
            body: None,
            options: None,
            urgent: false,
        },
    );
    let id = match reply(&h, 2) {
        ServerMsg::Reply {
            data: Some(data), ..
        } => data["id"].as_str().unwrap().to_owned(),
        other => panic!("{other:?}"),
    };
    send(&h, 3, ClientMsg::InboxResolve { id, answer: None });
    assert!(matches!(reply(&h, 3), ServerMsg::Reply { ok: true, .. }));

    h.clock.store(t0_ms() + 61_000, Ordering::SeqCst);
    h.tx.send(CoreMsg::Tick).unwrap();
    std::fs::copy(env!("CARGO_BIN_EXE_fake-omp"), late_omp).unwrap();
    h.tx.send(CoreMsg::Restart).unwrap();
    wait_log(&h, "schedule note: <data>resolve-down-wake</data>");
}

#[test]
fn stale_exhausted_budget_rolls_on_start() {
    let h = start_with(
        "budget-stale-day",
        ClientKind::App,
        PathBuf::from(env!("CARGO_BIN_EXE_fake-omp")),
        |paths| {
            std::fs::write(
                &paths.budget,
                br#"{"limit":2000000,"day":"2026-11-15","used":2000000}"#,
            )
            .unwrap();
        },
    );
    send(&h, 1, ClientMsg::Status);
    match reply(&h, 1) {
        ServerMsg::Reply {
            data: Some(data), ..
        } => {
            assert_eq!(data["state"], "running");
            assert_eq!(data["tokensToday"], 0);
        }
        other => panic!("{other:?}"),
    }
    let budget: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&h.paths.budget).unwrap()).unwrap();
    assert_eq!(budget["day"], "2026-11-16");
    assert_eq!(budget["used"], 0);

    h.clock.fetch_add(31 * 60_000, Ordering::SeqCst);
    h.tx.send(CoreMsg::Tick).unwrap();
    wait_log(&h, "[ompy wake] trigger: interval");
    send(&h, 2, ClientMsg::Status);
    match reply(&h, 2) {
        ServerMsg::Reply {
            data: Some(data), ..
        } => assert_eq!(data["state"], "running"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn scheduled_wake_due_while_down_survives_restart() {
    let h = start("wake-down", ClientKind::App);
    send(
        &h,
        1,
        ClientMsg::ScheduleWake {
            at_ms: Some(t0_ms() + 60_000),
            in_ms: None,
            note: "down-wake".into(),
        },
    );
    assert!(matches!(reply(&h, 1), ServerMsg::Reply { ok: true, .. }));
    send(
        &h,
        2,
        ClientMsg::Rpc {
            frame: serde_json::json!({"type": "crash"}),
        },
    );
    wait_down(&h);
    h.clock.store(t0_ms() + 61_000, Ordering::SeqCst);
    h.tx.send(CoreMsg::Tick).unwrap();
    wait_log(&h, "schedule note: <data>down-wake</data>");
}

#[test]
fn a_request_queued_behind_stdin_failure_does_not_block_wakes() {
    let h = start("retired-request", ClientKind::App);
    send(&h, 1, ClientMsg::WakeNow);
    wait_log(&h, "[ompy wake] trigger: manual");
    let gen = current_generation(&h);

    // `StdinFailed` retires the session; a request from that same generation
    // can still be queued behind it.
    h.tx.send(CoreMsg::Session {
        gen,
        ev: SessionEvent::StdinFailed {
            reason: "test stdin timeout".into(),
        },
    })
    .unwrap();
    h.tx.send(CoreMsg::Session {
        gen,
        ev: SessionEvent::UiRequest {
            id: "orphan1".into(),
            kind: ItemKind::Decision,
            title: "Orphan?".into(),
            body: None,
            options: vec!["Yes".into()],
            method: "select".into(),
            ask_questions: None,
            secret: false,
        },
    })
    .unwrap();
    h.tx.send(CoreMsg::Session {
        gen,
        ev: SessionEvent::TurnStarted,
    })
    .unwrap();

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(Instant::now() < deadline, "session did not restart");
        if current_generation(&h) > gen {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let items = inbox_items(&h);
    assert!(
        !items
            .iter()
            .any(|item| item.rpc_request_id.as_deref() == Some("orphan1")),
        "a request from the retired process must not reach the inbox"
    );
    assert!(
        items
            .iter()
            .all(|item| !(item.state == ItemState::Open && item.rpc_request_id.is_some())),
        "no open request may keep the scheduler blocked after the restart: {items:?}"
    );
    // Nothing blocks the restarted session, so a wake still reaches omp.
    std::fs::write(&h.log, "").unwrap();
    wake_until(&h, 1);
}

#[test]
fn a_reused_secret_request_id_cannot_settle_an_older_item() {
    let h = start("secret-reuse", ClientKind::App);
    let older = open_request(&h, "generic", "ap1");
    assert!(!older.secret);

    // omp reuses the id of the still-open approval for a secret input request.
    send(
        &h,
        1,
        ClientMsg::Rpc {
            frame: serde_json::json!({"type": "prompt", "message": "secret-same-id"}),
        },
    );
    let items = wait_until(&h, |items| {
        items
            .iter()
            .any(|item| item.id == older.id && item.state == ItemState::Expired)
            && items
                .iter()
                .filter(|item| {
                    item.rpc_request_id.as_deref() == Some("ap1") && item.state == ItemState::Open
                })
                .count()
                == 1
    });
    let newer = items
        .iter()
        .find(|item| item.rpc_request_id.as_deref() == Some("ap1") && item.state == ItemState::Open)
        .unwrap()
        .clone();
    assert!(newer.secret, "the secret request must be the open one");
    assert!(
        items
            .iter()
            .any(|item| item.kind == ItemKind::Notice
                && item.title.contains("older request expired")),
        "the user is told that the older request was replaced"
    );

    // The app relays an answer that carries only the request id, as it does
    // for a live request. The id now names two instances, so the answer could
    // come from the superseded password field and must not be forwarded.
    send(
        &h,
        2,
        ClientMsg::Rpc {
            frame: serde_json::json!({
                "type": "extension_ui_response",
                "id": "ap1",
                "value": "hunter2",
            }),
        },
    );
    assert!(matches!(
        reply_asserting_no_secret(&h, 2),
        ServerMsg::Reply { ok: false, .. }
    ));
    assert_no_later_secret_broadcast(&h);
    assert!(
        !std::fs::read_to_string(&h.log)
            .unwrap_or_default()
            .contains("hunter2"),
        "an answer for a reused id must not reach omp"
    );
    let items = inbox_items(&h);
    assert!(
        items
            .iter()
            .any(|item| item.id == newer.id && item.state == ItemState::Open),
        "the refused answer settles nothing"
    );
    assert!(items.iter().all(|item| item.answer.is_none()));
    assert!(items
        .iter()
        .any(|item| item.kind == ItemKind::Notice && item.title.contains("reused request")));

    // The item's own id still answers exactly the instance it belongs to.
    answer(&h, 3, &newer.id, "hunter2");
    assert!(matches!(
        reply_asserting_no_secret(&h, 3),
        ServerMsg::Reply { ok: true, .. }
    ));
    assert_no_later_secret_broadcast(&h);
    wait_log(&h, r#""value":"hunter2""#);
    assert!(std::fs::read_to_string(&h.log)
        .unwrap()
        .lines()
        .any(|line| line.contains(r#""id":"ap1""#) && line.contains(r#""value":"hunter2""#)));
    let items = inbox_items(&h);
    assert!(
        items
            .iter()
            .any(|item| item.id == newer.id && item.state == ItemState::Answered),
        "the secret item is the one that settled"
    );
    assert!(
        items.iter().all(|item| item.answer.is_none()),
        "the plaintext answer must never be stored"
    );
    assert!(!std::fs::read_to_string(&h.paths.inbox)
        .unwrap()
        .contains("hunter2"));
    let _ = h.tx.send(CoreMsg::Shutdown);
}

#[test]
fn a_non_file_instructions_path_surfaces_a_notice_and_keeps_the_wake() {
    let h = start("instructions-dir", ClientKind::App);
    std::fs::remove_file(&h.instructions).unwrap();
    // A directory at the instructions path must never be read as a file.
    std::fs::create_dir(&h.instructions).unwrap();
    let before = current_generation(&h);

    send(&h, 1, ClientMsg::WakeNow);
    assert!(matches!(reply(&h, 1), ServerMsg::Reply { ok: true, .. }));
    wait_log(&h, "[ompy wake] trigger: manual");
    wait_until(&h, |items| {
        items
            .iter()
            .any(|item| item.title.contains("not a regular file"))
    });
    assert_eq!(
        current_generation(&h),
        before,
        "a broken instructions file cannot become a system prompt, so it must not force a restart"
    );

    // The next delivered wake reports the same problem once, not per wake.
    deny_wake_approval(&h);
    wake_until(&h, 2);
    let notices = inbox_items(&h)
        .into_iter()
        .filter(|item| item.title.contains("not a regular file"))
        .count();
    assert_eq!(notices, 1, "one notice per distinct error");
    let _ = h.tx.send(CoreMsg::Shutdown);
}

#[test]
fn edited_instructions_restart_the_session_before_the_wake() {
    let h = start("instructions-restart", ClientKind::App);
    std::fs::write(&h.instructions, "instructions-marker-alpha").unwrap();
    // The first wake may itself restart the session: the edit can land after
    // the spawn read. Either way the session runs with "alpha" afterwards.
    wake_until(&h, 1);
    deny_wake_approval(&h);
    let settled = current_generation(&h);

    std::fs::write(&h.instructions, "instructions-marker-beta").unwrap();
    wake_until(&h, 2);
    assert!(
        current_generation(&h) > settled,
        "an edited instructions file must replace the session before the wake"
    );
    let log = std::fs::read_to_string(&h.log).unwrap_or_default();
    assert!(
        !log.contains("instructions-marker-alpha") && !log.contains("instructions-marker-beta"),
        "instructions are never inlined in a wake prompt"
    );
    let _ = h.tx.send(CoreMsg::Shutdown);
}

#[test]
fn an_instruction_restart_uses_the_snapshot_read_at_detection() {
    let h = start("instructions-restart-race", ClientKind::App);
    std::fs::write(&h.instructions, "instructions-marker-alpha").unwrap();
    wake_until(&h, 1);
    deny_wake_approval(&h);

    std::fs::write(&h.instructions, "instructions-marker-beta").unwrap();
    let snapshot = h.paths.persona.join("instructions.snapshot.md");
    let watched = snapshot.clone();
    let source = h.instructions.clone();
    let (edited_tx, edited_rx) = mpsc::channel();
    std::thread::spawn(move || {
        for _ in 0..10_000 {
            if std::fs::read_to_string(&watched)
                .is_ok_and(|text| text == "instructions-marker-beta")
            {
                std::fs::write(&source, "instructions-marker-gamma").unwrap();
                edited_tx.send(()).unwrap();
                return;
            }
            std::thread::yield_now();
        }
        panic!("the detection snapshot was never installed");
    });
    send(&h, 2, ClientMsg::WakeNow);
    edited_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("the source edit lands between detection and spawn");
    assert!(matches!(reply(&h, 2), ServerMsg::Reply { ok: true, .. }));
    wait_log(&h, "[ompy wake] trigger: manual");
    assert_eq!(
        std::fs::read_to_string(snapshot).unwrap(),
        "instructions-marker-beta",
        "a later source edit belongs to the next wake, not this restart"
    );
    deny_wake_approval(&h);
    let _ = h.tx.send(CoreMsg::Shutdown);
}

#[test]
fn protected_state_files_are_not_replaced_by_a_settings_change() {
    let h = start_with(
        "protected-settings",
        ClientKind::App,
        PathBuf::from(env!("CARGO_BIN_EXE_fake-omp")),
        |paths| {
            std::fs::write(&paths.settings, b"{not json").unwrap();
            std::fs::write(&paths.budget, b"{not json").unwrap();
            // Directories squatting on every quarantine name make the moves
            // fail while the directory holding the files stays writable.
            block_quarantine_names(&paths.settings);
            block_quarantine_names(&paths.budget);
        },
    );
    let items = inbox_items(&h);
    for what in ["Settings file was unreadable", "Budget file"] {
        assert!(
            items
                .iter()
                .any(|item| item.title.contains(what) && item.title.contains("could not")),
            "{what} must be reported as protected: {items:?}"
        );
    }

    let settings = PersonaSettings {
        interval_min: 45,
        ..PersonaSettings::default()
    };
    send(&h, 1, ClientMsg::SetSettings { settings });
    assert!(
        matches!(reply(&h, 1), ServerMsg::Reply { ok: false, .. }),
        "a change that cannot be saved is refused"
    );
    assert_eq!(
        std::fs::read(&h.paths.settings).unwrap(),
        b"{not json",
        "the only copy of the settings file must survive"
    );
    assert_eq!(
        std::fs::read(&h.paths.budget).unwrap(),
        b"{not json",
        "the only copy of the budget file must survive"
    );
    send(&h, 2, ClientMsg::Status);
    match reply(&h, 2) {
        ServerMsg::Reply {
            data: Some(data), ..
        } => assert_eq!(
            data["settings"]["intervalMin"],
            serde_json::json!(PersonaSettings::default().interval_min),
            "the refused change is not applied in memory either"
        ),
        other => panic!("{other:?}"),
    }
    let _ = h.tx.send(CoreMsg::Shutdown);
}

#[test]
fn a_protected_budget_is_not_replaced_by_a_saved_settings_change() {
    let h = start_with(
        "protected-budget",
        ClientKind::App,
        PathBuf::from(env!("CARGO_BIN_EXE_fake-omp")),
        |paths| {
            std::fs::write(&paths.budget, b"{not json").unwrap();
            block_quarantine_names(&paths.budget);
        },
    );
    let settings = PersonaSettings {
        interval_min: 45,
        ..PersonaSettings::default()
    };
    send(&h, 1, ClientMsg::SetSettings { settings });
    assert!(
        matches!(reply(&h, 1), ServerMsg::Reply { ok: true, .. }),
        "the settings file itself is writable"
    );
    assert_eq!(
        std::fs::read(&h.paths.budget).unwrap(),
        b"{not json",
        "a settings change must not overwrite a protected budget file"
    );
    let _ = h.tx.send(CoreMsg::Shutdown);
}

#[test]
fn a_protected_schedule_is_not_replaced_by_a_new_wake() {
    let h = start_with(
        "protected-schedule",
        ClientKind::Extension,
        PathBuf::from(env!("CARGO_BIN_EXE_fake-omp")),
        |paths| {
            std::fs::write(&paths.schedule, b"{not json").unwrap();
            block_quarantine_names(&paths.schedule);
        },
    );
    let items = inbox_items(&h);
    assert!(items
        .iter()
        .any(|item| item.title.contains("Schedule file was unreadable")
            && item.title.contains("could not")));

    send(
        &h,
        1,
        ClientMsg::ScheduleWake {
            at_ms: Some(t0_ms() + 60_000),
            in_ms: None,
            note: "protected".into(),
        },
    );
    assert!(
        matches!(reply(&h, 1), ServerMsg::Reply { ok: false, .. }),
        "a wake that cannot be persisted is refused"
    );
    assert_eq!(
        std::fs::read(&h.paths.schedule).unwrap(),
        b"{not json",
        "the only copy of the schedule file must survive"
    );
    send(&h, 2, ClientMsg::ListSchedule);
    match reply(&h, 2) {
        ServerMsg::Reply {
            data: Some(data), ..
        } => assert_eq!(
            data["scheduled"].as_array().unwrap().len(),
            0,
            "the refused wake is not queued in memory either"
        ),
        other => panic!("{other:?}"),
    }
    let _ = h.tx.send(CoreMsg::Shutdown);
}

#[test]
fn a_reset_schedule_file_is_reported_to_the_user() {
    let h = start_with(
        "schedule-reset",
        ClientKind::App,
        PathBuf::from(env!("CARGO_BIN_EXE_fake-omp")),
        |paths| std::fs::write(&paths.schedule, b"{not json").unwrap(),
    );
    // The quarantine succeeds, so writes are allowed again; the reset itself
    // must still reach the user.
    let bad = h
        .paths
        .schedule
        .with_file_name(format!("schedule.json.bad-{}", t0_ms()));
    assert!(bad.exists(), "the corrupt file is moved aside");
    let items = inbox_items(&h);
    assert!(
        items.iter().any(|item| item.kind == ItemKind::Notice
            && item.title.contains("Schedule file was unreadable")),
        "a reset schedule must not disappear silently: {items:?}"
    );
    let _ = h.tx.send(CoreMsg::Shutdown);
}

#[cfg(unix)]
#[test]
fn a_scheduled_wake_is_kept_when_the_session_cannot_take_it() {
    let h = start("wake-undelivered", ClientKind::App);
    // This turn closes the fake's stdin, so the next write fails fast.
    send(
        &h,
        1,
        ClientMsg::Rpc {
            frame: serde_json::json!({"type": "prompt", "message": "close-stdin"}),
        },
    );
    wait_log(&h, "close-stdin");
    send(
        &h,
        2,
        ClientMsg::ScheduleWake {
            at_ms: Some(t0_ms() + 60_000),
            in_ms: None,
            note: "keep-me".into(),
        },
    );
    assert!(matches!(reply(&h, 2), ServerMsg::Reply { ok: true, .. }));

    h.clock.store(t0_ms() + 61_000, Ordering::SeqCst);
    h.tx.send(CoreMsg::Tick).unwrap();
    // The wake is only removed from the schedule file once omp took it; a
    // failed delivery must leave it queued for the next session.
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        std::fs::read_to_string(&h.paths.schedule)
            .unwrap_or_default()
            .contains("keep-me"),
        "a wake whose prompt was not delivered must stay pending"
    );
    wait_down(&h);
    wait_log(&h, "schedule note: <data>keep-me</data>");
    let _ = h.tx.send(CoreMsg::Shutdown);
}

#[test]
fn omp_gets_a_bounded_snapshot_instead_of_the_user_file() {
    let h = start("instructions-snapshot", ClientKind::App);
    let cap = 64 * 1024;
    let mut long = "a".repeat(70 * 1024);
    long.push_str("tail-after-the-cap");
    std::fs::write(&h.instructions, &long).unwrap();

    wake_until(&h, 1);
    deny_wake_approval(&h);

    let snapshot = h.paths.persona.join("instructions.snapshot.md");
    let saved = std::fs::read_to_string(&snapshot).expect("the snapshot exists");
    let marker = "\n\n[ompy] instructions truncated at 64 KiB";
    assert_eq!(
        saved.len(),
        cap + marker.len(),
        "omp's prompt is the bounded snapshot"
    );
    assert!(
        !saved.contains("tail-after-the-cap"),
        "content past the cap is never omp's system prompt"
    );

    let spawn_log = std::fs::read_to_string(&h.log).unwrap_or_default();
    assert!(
        spawn_log.contains(&snapshot.display().to_string()),
        "omp is spawned with the snapshot path: {spawn_log}"
    );
    assert!(
        !spawn_log.contains(&h.instructions.display().to_string()),
        "omp must never be pointed at the user's unbounded file: {spawn_log}"
    );

    // A change past the cap is not a change omp could see, so it neither
    // restarts the session nor alters the prompt the detection compares.
    let generation = current_generation(&h);
    let mut edited = "a".repeat(70 * 1024);
    edited.push_str("another-tail-after-the-cap");
    std::fs::write(&h.instructions, edited).unwrap();
    wake_until(&h, 2);
    assert_eq!(
        current_generation(&h),
        generation,
        "bytes after the cap cannot be observed by omp, so they must not restart it"
    );
    assert_eq!(std::fs::read_to_string(&snapshot).unwrap(), saved);
    let _ = h.tx.send(CoreMsg::Shutdown);
}

#[test]
fn an_instruction_restart_keeps_the_busy_reservation() {
    let h = start("restart-busy", ClientKind::App);
    std::fs::write(&h.instructions, "instructions-marker-alpha").unwrap();
    wake_until(&h, 1);
    deny_wake_approval(&h);

    // Two wakes are due at the same instant. The first one restarts the
    // session because the instructions were edited, and its approval is held
    // back by the fake omp; the second must still wait for that approval.
    for (req, note) in [(1, "slow-request"), (2, "second-wake")] {
        send(
            &h,
            req,
            ClientMsg::ScheduleWake {
                at_ms: Some(t0_ms() + 60_000),
                in_ms: None,
                note: note.into(),
            },
        );
        assert!(
            matches!(reply(&h, req), ServerMsg::Reply { ok: true, .. }),
            "the wake must be scheduled"
        );
    }

    std::fs::write(&h.instructions, "instructions-marker-beta").unwrap();
    h.clock.store(t0_ms() + 61_000, Ordering::SeqCst);
    h.tx.send(CoreMsg::Tick).unwrap();
    wait_log(&h, "schedule note: <data>slow-request</data>");

    // A second tick while the restarted session has a turn open but has not
    // asked its approval yet. The fake holds the request back for a second, so
    // a cleared reservation would deliver this wake into that window.
    std::thread::sleep(Duration::from_millis(200));
    h.tx.send(CoreMsg::Tick).unwrap();

    // The approval only shows up after the fake's delay; once it does, the
    // fake has also read (and logged) anything queued on its stdin.
    wait_until(&h, |items| {
        items
            .iter()
            .any(|item| item.kind == ItemKind::Approval && item.state == ItemState::Open)
    });
    std::thread::sleep(Duration::from_millis(200));
    let log = std::fs::read_to_string(&h.log).unwrap_or_default();
    assert!(
        !log.contains("second-wake"),
        "a second due wake must wait for the first approval: {log}"
    );
    deny_wake_approval(&h);
    for _ in 0..100 {
        if std::fs::read_to_string(&h.log)
            .unwrap_or_default()
            .contains("second-wake")
        {
            break;
        }
        h.tx.send(CoreMsg::Tick).unwrap();
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        std::fs::read_to_string(&h.log)
            .unwrap_or_default()
            .contains("second-wake"),
        "the queued wake must run after the approval, not vanish"
    );
    let _ = h.tx.send(CoreMsg::Shutdown);
}
