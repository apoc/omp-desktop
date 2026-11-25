//! The session host end to end, against the `fake-omp` binary.

use omp_desktop_core::approval::{RuleBook, RuleScope};
use omp_desktopd::session::{omp_args, Launch, Session, SessionEvent};
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{mpsc, Arc};
use std::time::Duration;

fn launch(tag: &str) -> (Launch, PathBuf) {
    let root = std::env::temp_dir().join(format!("ompy-sess-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let log = root.join("sent.log");
    let l = Launch {
        program: omp_desktopd::session::ProgramSource::Fixed(PathBuf::from(env!(
            "CARGO_BIN_EXE_fake-omp"
        ))),
        home: root.clone(),
        sessions: root.join("s"),
        extension: root.join("ext.mjs"),
        instructions: root.join("i.md"),
        socket_env: "unused".into(),
        env: vec![("FAKE_OMP_LOG".into(), log.display().to_string())],
    };
    (l, log)
}

fn next(rx: &mpsc::Receiver<SessionEvent>, want: fn(&SessionEvent) -> bool) -> SessionEvent {
    loop {
        let ev = rx.recv_timeout(Duration::from_secs(5)).expect("event");
        if want(&ev) {
            return ev;
        }
    }
}

#[test]
fn args_match_spec() {
    let (l, _) = launch("args");
    let a = omp_args(&l);
    assert_eq!(&a[..3], &["--mode", "rpc-ui", "--approval-mode=always-ask"]);
    assert!(a.iter().any(|x| x == "--continue"));
    assert!(a.iter().any(|x| x.starts_with("--append-system-prompt=")));
}

#[test]
fn prompt_yields_usage_and_approval_request() {
    let (l, _log) = launch("flow");
    let (tx, rx) = mpsc::channel();
    let s = Session::spawn(
        &l,
        Arc::new(RuleBook::in_memory()),
        Arc::new(AtomicU64::new(0)),
        tx,
    )
    .unwrap();
    s.send(r#"{"type":"prompt","message":"wake"}"#).unwrap();
    assert!(matches!(
        next(&rx, |e| matches!(e, SessionEvent::TurnStarted)),
        SessionEvent::TurnStarted
    ));
    match next(&rx, |e| matches!(e, SessionEvent::Usage(_))) {
        SessionEvent::Usage(u) => assert_eq!(u.input + u.output + u.cache_write, 160),
        _ => unreachable!(),
    }
    match next(&rx, |e| matches!(e, SessionEvent::UiRequest { .. })) {
        SessionEvent::UiRequest {
            id,
            title,
            body,
            options,
            ..
        } => {
            assert_eq!(
                (id.as_str(), title.as_str(), body.as_deref()),
                ("ap1", "Allow tool: bash", Some("Command: ls"))
            );
            assert_eq!(options, vec!["Approve", "Deny"]);
        }
        _ => unreachable!(),
    }
    assert!(s.replay_after(0).len() >= 4);
}

#[test]
fn granted_rule_auto_approves_without_inbox_item() {
    let (l, log) = launch("rule");
    let rules = Arc::new(RuleBook::in_memory());
    rules
        .grant("ompy", Some(&l.home), "bash", RuleScope::Session)
        .unwrap();
    let (tx, rx) = mpsc::channel();
    let s = Session::spawn(&l, rules, Arc::new(AtomicU64::new(0)), tx).unwrap();
    s.send(r#"{"type":"prompt","message":"wake"}"#).unwrap();
    assert!(matches!(
        next(&rx, |e| matches!(
            e,
            SessionEvent::AutoApproved { .. } | SessionEvent::UiRequest { .. }
        )),
        SessionEvent::AutoApproved { .. }
    ));
    assert!(matches!(
        next(&rx, |e| matches!(e, SessionEvent::TurnEnded)),
        SessionEvent::TurnEnded
    ));
    // The answer was written before the fake reported `agent_end`, so the log
    // line is already there; poll briefly instead of trusting the ordering.
    let answer = r#"{"type":"extension_ui_response","id":"ap1","value":"Approve"}"#;
    let mut logged = String::new();
    for _ in 0..50 {
        logged = std::fs::read_to_string(&log).unwrap_or_default();
        if logged.lines().any(|line| line == answer) {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        logged.lines().any(|line| line == answer),
        "fake omp log: {logged:?}"
    );
}

#[test]
fn too_long_line_does_not_end_the_session() {
    let (l, _log) = launch("longline");
    let (tx, rx) = mpsc::channel();
    let s = Session::spawn(
        &l,
        Arc::new(RuleBook::in_memory()),
        Arc::new(AtomicU64::new(0)),
        tx,
    )
    .unwrap();
    s.send(r#"{"type":"longline"}"#).unwrap();
    // The fake emits a >16 MiB line whose cut falls inside a multi-byte
    // character, then `agent_start`, and stays alive.
    assert!(matches!(
        next(&rx, |e| matches!(e, SessionEvent::TurnStarted)),
        SessionEvent::TurnStarted
    ));
    // `Frame` trails its classified event, so drain until the stream goes
    // quiet and fail only on an exit.
    loop {
        match rx.recv_timeout(Duration::from_millis(300)) {
            Err(mpsc::RecvTimeoutError::Timeout) => break,
            Err(mpsc::RecvTimeoutError::Disconnected) => panic!("session ended"),
            Ok(SessionEvent::Exited { reason }) => {
                panic!("a too-long line ended the session: {reason}")
            }
            Ok(_) => {}
        }
    }
}

#[test]
fn stuck_omp_write_times_out_and_kill_does_not_join_the_writer() {
    let (mut l, _log) = launch("stuck");
    l.env.push(("FAKE_OMP_STALL".into(), "1".into()));
    let (tx, _rx) = mpsc::channel();
    let mut s = Session::spawn(
        &l,
        Arc::new(RuleBook::in_memory()),
        Arc::new(AtomicU64::new(0)),
        tx,
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(100));

    let huge = "x".repeat(2 * 1024 * 1024);
    assert_eq!(
        s.send(&huge).unwrap_err().kind(),
        std::io::ErrorKind::TimedOut
    );
    let killed = std::time::Instant::now();
    s.kill();
    assert!(
        killed.elapsed() < Duration::from_secs(2),
        "kill waited for the stuck writer"
    );
}

#[test]
fn crash_reports_exit() {
    let (l, _) = launch("crash");
    let (tx, rx) = mpsc::channel();
    let s = Session::spawn(
        &l,
        Arc::new(RuleBook::in_memory()),
        Arc::new(AtomicU64::new(0)),
        tx,
    )
    .unwrap();
    s.send(r#"{"type":"crash"}"#).unwrap();
    assert!(matches!(
        next(&rx, |e| matches!(e, SessionEvent::Exited { .. })),
        SessionEvent::Exited { .. }
    ));
}

#[cfg(unix)]
#[test]
fn a_failed_auto_approval_write_stops_the_frame() {
    let (l, _log) = launch("autoapprove-failed");
    let rules = Arc::new(RuleBook::in_memory());
    rules
        .grant("ompy", Some(&l.home), "bash", RuleScope::Session)
        .unwrap();
    let (tx, rx) = mpsc::channel();
    let s = Session::spawn(&l, rules, Arc::new(AtomicU64::new(0)), tx).unwrap();
    // The fake closes the read end of its stdin before it asks for the
    // approval, so the rule's answer cannot be written.
    s.send(r#"{"type":"prompt","message":"autoapprove"}"#)
        .unwrap();

    let mut failed = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(SessionEvent::UiRequest { id, .. }) => {
                panic!("request {id} arrived although its answer could not be written")
            }
            Ok(SessionEvent::StdinFailed { .. }) => {
                failed = true;
                break;
            }
            Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    assert!(failed, "the failed write must be reported");
    // Whatever is queued behind the failure belongs to the retired session and
    // must not become an inbox request.
    while let Ok(ev) = rx.recv_timeout(Duration::from_millis(300)) {
        assert!(
            !matches!(ev, SessionEvent::UiRequest { .. }),
            "request after StdinFailed: {ev:?}"
        );
    }
}
