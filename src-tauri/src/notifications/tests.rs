use super::*;
use crate::remote::tracker::Tracker;
use serde_json::json;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

fn configuration(finished: bool, questions: bool) -> Configuration {
    Configuration {
        finished,
        questions,
        viewed_session: Some("active".into()),
        tabs: vec![
            Tab {
                id: "active".into(),
                title: "Visible conversation".into(),
            },
            Tab {
                id: "background".into(),
                title: "Fix parser".into(),
            },
        ],
    }
}

fn finished() -> Transition {
    Transition::TurnFinished {
        ran: Duration::from_secs(1),
    }
}

#[test]
fn each_notification_kind_requires_its_own_opt_in() {
    for (finish_on, questions_on) in [(false, false), (true, false), (false, true), (true, true)] {
        let config = configuration(finish_on, questions_on);
        assert_eq!(
            config
                .notice("background", finished(), Some(&(false, 0)), false)
                .is_some(),
            finish_on
        );
        assert_eq!(
            config
                .notice(
                    "background",
                    Transition::QuestionOpened,
                    Some(&(true, 1)),
                    false
                )
                .is_some(),
            questions_on
        );
    }
}

#[test]
fn focused_visible_conversation_is_quiet_but_other_tabs_and_unfocused_app_notify() {
    let config = configuration(true, true);
    for transition in [finished(), Transition::QuestionOpened] {
        let live = if transition == finished() {
            (false, 0)
        } else {
            (true, 1)
        };
        assert_eq!(config.notice("active", transition, Some(&live), true), None);
        assert!(config
            .notice("active", transition, Some(&live), false)
            .is_some());
        assert!(config
            .notice("background", transition, Some(&live), true)
            .is_some());
    }
    let mut settings_visible = config;
    settings_visible.viewed_session = None;
    assert!(settings_visible
        .notice("active", finished(), Some(&(false, 0)), true)
        .is_some());
}

#[test]
fn answered_cancelled_restarted_and_closed_conversations_do_not_deliver_stale_alerts() {
    let config = configuration(true, true);
    assert_eq!(
        config.notice(
            "background",
            Transition::QuestionOpened,
            Some(&(true, 0)),
            false
        ),
        None
    );
    assert_eq!(
        config.notice("background", finished(), Some(&(true, 0)), false),
        None
    );
    assert_eq!(
        config.notice("background", finished(), Some(&(false, 1)), false),
        None
    );
    assert_eq!(config.notice("background", finished(), None, false), None);
    assert_eq!(
        config.notice("closed", finished(), Some(&(false, 0)), false),
        None
    );
    assert_eq!(
        config.notice("background", finished(), Some(&(false, 0)), false),
        Some(("Fix parser", "Conversation finished."))
    );
}

#[test]
fn live_tracker_not_replayed_ui_state_drives_questions_and_terminal_completion() {
    let (notifications, receiver) = Notifications::channel(None);
    notifications.configure(configuration(true, true)).unwrap();
    let tracker = Tracker::default();
    // The test assertions and tracker share the same dispatcher instance.
    tracker.set_sink(Arc::clone(&notifications) as Arc<dyn TrackerSink>);
    let now = Instant::now();
    let alive = AtomicBool::new(true);
    tracker.on_frame("background", Some("agent_start"), None, now, &alive);
    let question = json!({"method":"ask","id":"q1"});
    tracker.on_frame(
        "background",
        Some("extension_ui_request"),
        Some(&question),
        now,
        &alive,
    );
    tracker.on_frame(
        "background",
        Some("extension_ui_request"),
        Some(&question),
        now,
        &alive,
    );
    let pending = receiver.try_recv().unwrap();
    assert_eq!(
        notifications.message(&pending, tracker.snapshot().get("background"), false),
        Some(("OMP · Fix parser".into(), "Your input is needed."))
    );
    assert!(
        receiver.try_recv().is_err(),
        "duplicate request must not notify twice"
    );
    tracker.on_answered("background", "q1", &alive);
    assert_eq!(
        notifications.message(&pending, tracker.snapshot().get("background"), false),
        None
    );
    let continuation = json!({"yielded":false});
    tracker.on_frame(
        "background",
        Some("agent_end"),
        Some(&continuation),
        now,
        &alive,
    );
    assert!(
        receiver.try_recv().is_err(),
        "a scheduling pause is not completion"
    );
    tracker.on_frame("background", Some("agent_end"), None, now, &alive);
    tracker.on_frame("background", Some("agent_end"), None, now, &alive);
    let pending = receiver.try_recv().unwrap();
    assert_eq!(
        notifications.message(&pending, tracker.snapshot().get("background"), false),
        Some(("OMP · Fix parser".into(), "Conversation finished."))
    );
    assert!(
        receiver.try_recv().is_err(),
        "duplicate end must not notify twice"
    );
    tracker.on_exit("background");
    assert_eq!(
        notifications.message(&pending, tracker.snapshot().get("background"), false),
        None
    );
}

#[test]
fn disabling_and_reenabling_does_not_replay_already_queued_alerts() {
    let (notifications, receiver) = Notifications::channel(None);
    notifications.configure(configuration(true, true)).unwrap();
    notifications.changed("background", Some(finished()));
    let old = receiver.try_recv().unwrap();
    notifications
        .configure(configuration(false, false))
        .unwrap();
    notifications.configure(configuration(true, true)).unwrap();
    assert_eq!(notifications.message(&old, Some(&(false, 0)), false), None);
    notifications.changed("background", Some(finished()));
    assert!(notifications
        .message(&receiver.try_recv().unwrap(), Some(&(false, 0)), false)
        .is_some());
    notifications.stop();
    notifications.changed("background", Some(finished()));
    assert!(receiver.try_recv().is_err());
}

#[test]
fn bounded_delivery_and_configuration_contention_never_block_the_tracker() {
    let (notifications, receiver) = Notifications::channel(None);
    notifications.configure(configuration(true, true)).unwrap();
    let held = notifications.control.lock().unwrap();
    // A held config lock must drop the optional alert instead of waiting.
    notifications.changed("background", Some(finished()));
    drop(held);
    assert!(receiver.try_recv().is_err());
    for _ in 0..1000 {
        notifications.changed("background", Some(finished()));
    }
    assert!(receiver.try_recv().is_ok());
    notifications.stop();
}

#[test]
fn malformed_identity_cannot_replace_valid_preferences_and_titles_are_utf8_bounded() {
    let (notifications, receiver) = Notifications::channel(None);
    notifications.configure(configuration(true, true)).unwrap();
    let mut invalid = configuration(false, false);
    invalid.tabs[0].id = "x".repeat(257);
    assert!(notifications.configure(invalid).is_err());
    notifications.changed("background", Some(finished()));
    assert_eq!(
        notifications.message(&receiver.try_recv().unwrap(), Some(&(false, 0)), false),
        Some(("OMP · Fix parser".into(), "Conversation finished."))
    );
    let mut long = configuration(true, true);
    long.tabs[1].title = "界".repeat(200);
    notifications.configure(long).unwrap();
    notifications.changed("background", Some(finished()));
    let (title, _) = notifications
        .message(&receiver.try_recv().unwrap(), Some(&(false, 0)), false)
        .unwrap();
    assert_eq!(title, format!("OMP · {}", "界".repeat(85)));
}
