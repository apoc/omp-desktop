//! The core driver loop end to end, against the `fake-omp` binary: wake-ups
//! reach omp, approvals land in the inbox, crashes expire them, and settings
//! and schedules are persisted.

use chrono::NaiveDate;
use omp_desktop_core::persona_protocol::{
    ClientKind, ClientMsg, InboxItem, ItemKind, ItemState, PersonaSettings, ServerMsg,
};
use omp_desktopd::budget::Usage;
use omp_desktopd::core::{Core, CoreMsg, FIRST_GENERATION};
use omp_desktopd::paths::{ensure_private_dir, Paths};
use omp_desktopd::scheduler::Now;
use omp_desktopd::server::Inbound;
use omp_desktopd::session::{Launch, SessionEvent};
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

struct Harness {
    tx: mpsc::Sender<CoreMsg>,
    out: mpsc::Receiver<ServerMsg>,
    clock: Arc<AtomicI64>,
    paths: Paths,
    log: PathBuf,
}

fn start(tag: &str, client: ClientKind) -> Harness {
    let root = std::env::temp_dir().join(format!("ompy-core-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let paths = Paths::under(&root);
    ensure_private_dir(&paths.persona).unwrap();
    let log = root.join("sent.log");
    let launch = Launch {
        program: PathBuf::from(env!("CARGO_BIN_EXE_fake-omp")),
        home: root.clone(),
        sessions: paths.sessions.clone(),
        extension: root.join("e.mjs"),
        instructions: root.join("i.md"),
        socket_env: "x".into(),
        env: vec![("FAKE_OMP_LOG".into(), log.display().to_string())],
    };
    // Monday 2026-11-16 09:00 local == UTC.
    let t0 = NaiveDate::from_ymd_opt(2026, 11, 16)
        .unwrap()
        .and_hms_opt(9, 0, 0)
        .unwrap()
        .and_utc()
        .timestamp_millis();
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
        out: out_tx,
        client,
    })
    .unwrap();
    Harness {
        tx,
        out,
        clock,
        paths,
        log,
    }
}

fn send(h: &Harness, req: u64, msg: ClientMsg) {
    h.tx.send(CoreMsg::Inbound(Inbound {
        conn: 1,
        req: Some(req),
        client: ClientKind::App,
        msg,
    }))
    .unwrap();
}

fn reply(h: &Harness, req: u64) -> ServerMsg {
    loop {
        match h.out.recv_timeout(Duration::from_secs(5)).unwrap() {
            m @ ServerMsg::Reply { req: r, .. } if r == req => return m,
            _ => {}
        }
    }
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
    panic!("fake omp never got {needle}");
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
    send(&h, 1, ClientMsg::WakeNow);
    wait_log(&h, "[ompy wake] trigger: manual");
    for _ in 0..100 {
        let items = inbox_items(&h);
        if items
            .iter()
            .any(|i| i.kind == ItemKind::Approval && i.state == ItemState::Open)
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("no approval item");
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
        gen: FIRST_GENERATION,
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
