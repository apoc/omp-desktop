//! The session host end to end, against the `fake-omp` binary.

use omp_desktop_core::approval::{RuleBook, RuleScope};
use omp_desktopd::session::{omp_args, Launch, Session, SessionEvent};
use std::path::PathBuf;
use std::sync::{mpsc, Arc};
use std::time::Duration;

fn launch(tag: &str) -> (Launch, PathBuf) {
    let root = std::env::temp_dir().join(format!("ompy-sess-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let log = root.join("sent.log");
    let l = Launch {
        program: PathBuf::from(env!("CARGO_BIN_EXE_fake-omp")),
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
    let s = Session::spawn(&l, Arc::new(RuleBook::in_memory()), tx).unwrap();
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
    let (l, _log) = launch("rule");
    let rules = Arc::new(RuleBook::in_memory());
    rules
        .grant("ompy", Some(&l.home), "bash", RuleScope::Session)
        .unwrap();
    let (tx, rx) = mpsc::channel();
    let s = Session::spawn(&l, rules, tx).unwrap();
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
}

#[test]
fn crash_reports_exit() {
    let (l, _) = launch("crash");
    let (tx, rx) = mpsc::channel();
    let s = Session::spawn(&l, Arc::new(RuleBook::in_memory()), tx).unwrap();
    s.send(r#"{"type":"crash"}"#).unwrap();
    assert!(matches!(
        next(&rx, |e| matches!(e, SessionEvent::Exited { .. })),
        SessionEvent::Exited { .. }
    ));
}
