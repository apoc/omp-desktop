use super::*;
use serde_json::json;
use std::sync::atomic::AtomicBool;

/// The fields a test usually pins, ignoring the process-wide ask sequence.
fn state(entry: &SessionSnapshot) -> (bool, usize, bool) {
    (entry.busy, entry.asks, entry.background)
}

/// A snapshot entry without background work.
fn shown(busy: bool, asks: usize) -> (bool, usize, bool) {
    (busy, asks, false)
}

#[derive(Clone, Default)]
struct Collect(Arc<Mutex<Vec<Option<Transition>>>>);

impl TrackerSink for Collect {
    fn changed(&self, sid: &str, transition: Option<Transition>) {
        // This fixture expects only s1; retain its literal for the brief's assertions.
        assert_eq!(sid, "s1");
        self.0.lock().unwrap().push(transition);
    }
}

impl Collect {
    fn transitions(&self) -> Vec<(&'static str, Transition)> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter_map(|transition| transition.map(|transition| ("s1", transition)))
            .collect()
    }

    fn notifications(&self) -> usize {
        self.0.lock().unwrap().len()
    }
}

#[test]
fn question_lifecycle_and_turn_finish() {
    let t = Tracker::default();
    // Both handles intentionally share the collecting sink's event storage.
    let sink = Collect::default();
    t.set_sink(Arc::new(sink.clone()));
    let now = Instant::now();
    t.on_frame(
        "s1",
        Some("agent_start"),
        Some(&json!({"type":"agent_start"})),
        now,
        &AtomicBool::new(true),
    );
    t.on_frame(
        "s1",
        Some("extension_ui_request"),
        Some(&json!({"type":"extension_ui_request","id":"q1","method":"select"})),
        now,
        &AtomicBool::new(true),
    );
    t.on_frame(
        "s1",
        Some("extension_ui_request"),
        Some(&json!({"type":"extension_ui_request","id":"w1","method":"setStatus"})),
        now,
        &AtomicBool::new(true),
    );
    assert_eq!(
        state(&t.snapshot().sessions["s1"]),
        shown(true, 1),
        "status frames are not questions"
    );
    t.on_answered("s1", "q1", &AtomicBool::new(true));
    assert_eq!(state(&t.snapshot().sessions["s1"]), shown(true, 0));
    t.on_frame(
        "s1",
        Some("agent_end"),
        Some(&json!({"type":"agent_end"})),
        now + Duration::from_secs(40),
        &AtomicBool::new(true),
    );
    assert_eq!(state(&t.snapshot().sessions["s1"]), shown(false, 0));
    assert!(
        matches!(sink.transitions().as_slice(), [("s1", Transition::QuestionOpened), ("s1", Transition::TurnFinished { ran })] if *ran >= Duration::from_secs(40))
    );
}

#[test]
fn exit_forgets_the_session_and_sessions_are_independent() {
    let t = Tracker::default();
    let now = Instant::now();
    t.on_frame(
        "a",
        Some("agent_start"),
        Some(&json!({"type":"agent_start"})),
        now,
        &AtomicBool::new(true),
    );
    t.on_frame(
        "b",
        Some("extension_ui_request"),
        Some(&json!({"type":"extension_ui_request","id":"q","method":"confirm"})),
        now,
        &AtomicBool::new(true),
    );
    t.on_exit("a");
    let s = t.snapshot();
    assert!(!s.sessions.contains_key("a"));
    assert_eq!(state(&s.sessions["b"]), shown(false, 1));
}

#[test]
fn only_dialogs_with_string_ids_open_and_duplicate_ids_do_not_notify() {
    let t = Tracker::default();
    let sink = Collect::default();
    // Both handles intentionally share the collecting sink's event storage.
    t.set_sink(Arc::new(sink.clone()));
    let now = Instant::now();
    for (index, method) in ["select", "confirm", "input", "editor", "ask"]
        .into_iter()
        .enumerate()
    {
        let frame = json!({"id": format!("q{index}"), "method": method});
        t.on_frame(
            "s1",
            Some("extension_ui_request"),
            Some(&frame),
            now,
            &AtomicBool::new(true),
        );
        t.on_frame(
            "s1",
            Some("extension_ui_request"),
            Some(&frame),
            now,
            &AtomicBool::new(true),
        );
    }
    for frame in [
        json!({"method":"input"}),
        json!({"id":42,"method":"select"}),
        json!({"id":"x","method":"setWidget"}),
    ] {
        t.on_frame(
            "s1",
            Some("extension_ui_request"),
            Some(&frame),
            now,
            &AtomicBool::new(true),
        );
    }
    assert_eq!(state(&t.snapshot().sessions["s1"]), shown(false, 5));
    assert_eq!(sink.transitions().len(), 5);
    t.on_frame("s1", Some("agent_end"), None, now, &AtomicBool::new(true));
    assert_eq!(state(&t.snapshot().sessions["s1"]), shown(false, 0));
}

#[test]
fn unrelated_frames_and_unknown_answers_do_not_create_sessions() {
    let t = Tracker::default();
    let now = Instant::now();
    for kind in [None, Some("message_update"), Some("extension_ui_request")] {
        t.on_frame("missing", kind, None, now, &AtomicBool::new(true));
    }
    for id in ["q", "other"] {
        t.on_answered("missing", id, &AtomicBool::new(true));
    }
    t.on_exit("missing");
    assert!(t.snapshot().sessions.is_empty());
}

#[test]
fn finish_uses_first_start_across_retries_and_does_not_repeat_finished_transition() {
    let t = Tracker::default();
    let sink = Collect::default();
    // Both handles intentionally share the collecting sink's event storage.
    t.set_sink(Arc::new(sink.clone()));
    let now = Instant::now();
    t.on_frame("s1", Some("agent_start"), None, now, &AtomicBool::new(true));
    t.on_frame(
        "s1",
        Some("agent_start"),
        None,
        now + Duration::from_secs(10),
        &AtomicBool::new(true),
    );
    t.on_frame(
        "s1",
        Some("agent_end"),
        None,
        now + Duration::from_secs(40),
        &AtomicBool::new(true),
    );
    t.on_frame(
        "s1",
        Some("agent_end"),
        None,
        now + Duration::from_secs(50),
        &AtomicBool::new(true),
    );
    assert!(
        matches!(sink.transitions().as_slice(), [("s1", Transition::TurnFinished { ran })] if *ran == Duration::from_secs(40))
    );
}

struct ReentrantSink {
    tracker: std::sync::Weak<Tracker>,
    changes: Mutex<Vec<SessionSnapshot>>,
}

impl TrackerSink for ReentrantSink {
    fn changed(&self, sid: &str, _: Option<Transition>) {
        let tracker = self.tracker.upgrade().unwrap();
        assert!(
            tracker.inner.try_lock().is_ok(),
            "state lock held in callback"
        );
        assert!(
            tracker.sink.try_lock().is_ok(),
            "sink lock held in callback"
        );
        self.changes.lock().unwrap().push(
            tracker
                .snapshot()
                .sessions
                .get(sid)
                .copied()
                .unwrap_or_default(),
        );
    }
}

#[test]
fn callbacks_observe_committed_state_outside_both_locks_and_sink_is_replaceable() {
    let t = Arc::new(Tracker::default());
    let first = Arc::new(ReentrantSink {
        tracker: Arc::downgrade(&t),
        changes: Mutex::default(),
    });
    // The tracker and this assertion retain independent handles to the sink.
    t.set_sink(Arc::clone(&first) as Arc<dyn TrackerSink>);
    let now = Instant::now();
    t.on_frame("s1", Some("agent_start"), None, now, &AtomicBool::new(true));
    t.on_frame(
        "s1",
        Some("extension_ui_request"),
        Some(&json!({"id":"q","method":"input"})),
        now,
        &AtomicBool::new(true),
    );
    t.on_answered("s1", "q", &AtomicBool::new(true));
    t.on_answered("s1", "q", &AtomicBool::new(true));
    let changes: Vec<_> = first.changes.lock().unwrap().iter().map(state).collect();
    assert_eq!(changes, [shown(true, 0), shown(true, 1), shown(true, 0)]);
    let second = Arc::new(ReentrantSink {
        tracker: Arc::downgrade(&t),
        changes: Mutex::default(),
    });
    // Keep the replacement sink available for assertions after installing it.
    t.set_sink(Arc::clone(&second) as Arc<dyn TrackerSink>);
    t.on_exit("s1");
    t.on_exit("s1");
    assert_eq!(first.changes.lock().unwrap().len(), 3);
    let changes: Vec<_> = second.changes.lock().unwrap().iter().map(state).collect();
    assert_eq!(changes, [shown(false, 0)]);
}

#[test]
fn omp_cancel_removes_only_target_and_notifies_only_when_removed() {
    let t = Tracker::default();
    let sink = Collect::default();
    // Both handles intentionally share the collecting sink's event storage.
    t.set_sink(Arc::new(sink.clone()));
    let now = Instant::now();
    for id in ["q1", "q2"] {
        t.on_frame(
            "s1",
            Some("extension_ui_request"),
            Some(&json!({"id":id,"method":"input"})),
            now,
            &AtomicBool::new(true),
        );
    }
    let cancel = json!({"id":"q2","method":"cancel","targetId":"q1"});
    t.on_frame(
        "s1",
        Some("extension_ui_request"),
        Some(&cancel),
        now,
        &AtomicBool::new(true),
    );
    assert_eq!(state(&t.snapshot().sessions["s1"]), shown(false, 1));
    assert_eq!(sink.notifications(), 3);
    for frame in [
        cancel,
        json!({"method":"cancel","targetId":42}),
        json!({"method":"cancel","targetId":"x".repeat(MAX_ID_BYTES + 1)}),
        json!({"method":"cancel"}),
    ] {
        t.on_frame(
            "s1",
            Some("extension_ui_request"),
            Some(&frame),
            now,
            &AtomicBool::new(true),
        );
        t.on_frame(
            "missing",
            Some("extension_ui_request"),
            Some(&frame),
            now,
            &AtomicBool::new(true),
        );
    }
    assert_eq!(sink.notifications(), 3);
    assert!(!t.snapshot().sessions.contains_key("missing"));
    t.on_answered("s1", "q2", &AtomicBool::new(true));
    assert_eq!(state(&t.snapshot().sessions["s1"]), shown(false, 0));
    assert_eq!(sink.notifications(), 4);
}

#[test]
fn non_yielding_end_preserves_run_questions_timing_and_emits_nothing() {
    for end in [
        json!({"yielded":false,"isTerminal":true}),
        json!({"isTerminal":false}),
        json!({"yielded":null,"isTerminal":false}),
    ] {
        let t = Tracker::default();
        let sink = Collect::default();
        // Both handles intentionally share the collecting sink's event storage.
        t.set_sink(Arc::new(sink.clone()));
        let now = Instant::now();
        t.on_frame(
            "s1",
            Some("agent_end"),
            Some(&end),
            now,
            &AtomicBool::new(true),
        );
        assert!(t.snapshot().sessions.is_empty());
        assert_eq!(sink.notifications(), 0);
        t.on_frame("s1", Some("agent_start"), None, now, &AtomicBool::new(true));
        t.on_frame(
            "s1",
            Some("extension_ui_request"),
            Some(&json!({"id":"q","method":"input"})),
            now,
            &AtomicBool::new(true),
        );
        t.on_frame(
            "s1",
            Some("agent_end"),
            Some(&end),
            now + Duration::from_secs(10),
            &AtomicBool::new(true),
        );
        assert_eq!(state(&t.snapshot().sessions["s1"]), shown(true, 1));
        assert_eq!(sink.notifications(), 2);
        t.on_frame(
            "s1",
            Some("agent_start"),
            None,
            now + Duration::from_secs(20),
            &AtomicBool::new(true),
        );
        assert_eq!(state(&t.snapshot().sessions["s1"]), shown(true, 1));
        t.on_frame(
            "s1",
            Some("agent_end"),
            Some(&json!({"yielded":true,"isTerminal":false})),
            now + Duration::from_secs(40),
            &AtomicBool::new(true),
        );
        assert_eq!(state(&t.snapshot().sessions["s1"]), shown(false, 0));
        assert!(matches!(
            sink.transitions().as_slice(),
            [("s1", Transition::QuestionOpened), ("s1", Transition::TurnFinished { ran })]
                if *ran == Duration::from_secs(40)
        ));
    }
}

#[test]
fn question_ids_are_bounded_by_bytes_and_open_count_and_space_is_reusable() {
    let t = Tracker::default();
    let sink = Collect::default();
    // Both handles intentionally share the collecting sink's event storage.
    t.set_sink(Arc::new(sink.clone()));
    let now = Instant::now();
    for id in ["x".repeat(257), "é".repeat(129)] {
        t.on_frame(
            "s1",
            Some("extension_ui_request"),
            Some(&json!({"id":id,"method":"input"})),
            now,
            &AtomicBool::new(true),
        );
    }
    assert!(t.snapshot().sessions.is_empty());
    let boundary = "é".repeat(128);
    t.on_frame(
        "s1",
        Some("extension_ui_request"),
        Some(&json!({"id":boundary,"method":"input"})),
        now,
        &AtomicBool::new(true),
    );
    for index in 0..64 {
        t.on_frame(
            "s1",
            Some("extension_ui_request"),
            Some(&json!({"id":format!("q{index}"),"method":"input"})),
            now,
            &AtomicBool::new(true),
        );
    }
    assert_eq!(state(&t.snapshot().sessions["s1"]), shown(false, 64));
    assert_eq!(sink.notifications(), 64);
    t.on_answered("s1", "q63", &AtomicBool::new(true));
    assert_eq!(sink.notifications(), 64, "overflow id was never tracked");
    t.on_answered("s1", &boundary, &AtomicBool::new(true));
    t.on_frame(
        "s1",
        Some("extension_ui_request"),
        Some(&json!({"id":"q63","method":"input"})),
        now,
        &AtomicBool::new(true),
    );
    assert_eq!(state(&t.snapshot().sessions["s1"]), shown(false, 64));
    assert_eq!(sink.notifications(), 66);
}

#[test]
fn a_retired_reader_changes_nothing_and_notifies_nobody() {
    let t = Tracker::default();
    let sink = Collect::default();
    // Both handles intentionally share the collecting sink's event storage.
    t.set_sink(Arc::new(sink.clone()));
    let now = Instant::now();
    let retired = AtomicBool::new(false);
    let question = json!({"id":"q","method":"input"});
    t.on_frame("s1", Some("agent_start"), None, now, &retired);
    t.on_frame(
        "s1",
        Some("extension_ui_request"),
        Some(&question),
        now,
        &retired,
    );
    assert!(t.snapshot().sessions.is_empty());
    let live = AtomicBool::new(true);
    t.on_frame("s1", Some("agent_start"), None, now, &live);
    t.on_frame(
        "s1",
        Some("extension_ui_request"),
        Some(&question),
        now,
        &live,
    );
    t.on_frame("s1", Some("agent_end"), None, now, &retired);
    t.on_answered("s1", "q", &retired);
    assert_eq!(state(&t.snapshot().sessions["s1"]), shown(true, 1));
    assert_eq!(sink.notifications(), 2);
}

#[test]
fn awaiting_end_and_get_state_report_background_work_until_settled() {
    let t = Tracker::default();
    let now = Instant::now();
    let live = AtomicBool::new(true);
    // The captured yielding end (omp 18.6.0) names the awaiting state.
    t.on_frame("bg-end", Some("agent_start"), None, now, &live);
    t.on_frame(
        "bg-end",
        Some("agent_end"),
        Some(&json!({"yielded": true, "awaitingAsyncWork": true})),
        now,
        &live,
    );
    assert_eq!(state(&t.snapshot().sessions["bg-end"]), (false, 0, true));
    t.on_frame("bg-end", Some("session_settled"), None, now, &live);
    assert_eq!(state(&t.snapshot().sessions["bg-end"]), shown(false, 0));
    // The active tab's get_state answer carries the same flag.
    let running = json!({
        "type": "response", "command": "get_state", "success": true,
        "data": {"hasPendingAsyncWork": true},
    });
    t.on_frame("bg-state", Some("response"), Some(&running), now, &live);
    assert_eq!(state(&t.snapshot().sessions["bg-state"]), (false, 0, true));
    // A new run consumed the job; without `awaitingAsyncWork` the last
    // answer stands until the next get_state or `session_settled`.
    t.on_frame("bg-state", Some("agent_start"), None, now, &live);
    assert_eq!(state(&t.snapshot().sessions["bg-state"]), shown(true, 0));
    t.on_frame(
        "bg-state",
        Some("agent_end"),
        Some(&json!({"yielded": true})),
        now,
        &live,
    );
    assert_eq!(state(&t.snapshot().sessions["bg-state"]), shown(false, 0));
}

#[test]
fn a_background_only_change_notifies_once_and_repeats_are_ignored() {
    let t = Tracker::default();
    let sink = Collect::default();
    t.set_sink(Arc::new(sink.clone()));
    let response = json!({"command":"get_state","data":{"hasPendingAsyncWork":true}});
    let live = AtomicBool::new(true);
    t.on_frame(
        "s1",
        Some("response"),
        Some(&response),
        Instant::now(),
        &live,
    );
    assert!(t.snapshot().sessions["s1"].background);
    assert_eq!(sink.notifications(), 1);
    t.on_frame(
        "s1",
        Some("response"),
        Some(&response),
        Instant::now(),
        &live,
    );
    assert_eq!(sink.notifications(), 1, "an unchanged answer is no change");
}

#[test]
fn snapshot_reads_without_locking_sessions_mutex() {
    let t = Tracker::default();
    t.on_frame(
        "s1",
        Some("agent_start"),
        None,
        Instant::now(),
        &AtomicBool::new(true),
    );
    let _held = t.inner.lock().unwrap();
    let snap = t.snapshot();
    assert_eq!(state(&snap.sessions["s1"]), shown(true, 0));
}

#[test]
fn the_revision_rises_once_per_committed_change_and_not_for_repeats() {
    let t = Tracker::default();
    let live = AtomicBool::new(true);
    let now = Instant::now();
    assert_eq!(t.snapshot().revision, 0);
    t.on_frame("s1", Some("agent_start"), None, now, &live);
    assert_eq!(t.snapshot().revision, 1);
    t.on_frame("s1", Some("agent_start"), None, now, &live);
    assert_eq!(t.snapshot().revision, 1, "a repeated start commits nothing");
    let question = json!({"id":"q","method":"input"});
    t.on_frame(
        "s1",
        Some("extension_ui_request"),
        Some(&question),
        now,
        &live,
    );
    assert_eq!(t.snapshot().revision, 2);
    t.on_frame(
        "s1",
        Some("extension_ui_request"),
        Some(&question),
        now,
        &live,
    );
    assert_eq!(t.snapshot().revision, 2, "a duplicate id opens nothing");
    t.on_answered("s1", "q", &live);
    assert_eq!(t.snapshot().revision, 3);
    t.on_exit("s1");
    assert_eq!(t.snapshot().revision, 4);
    t.on_exit("s1");
    assert_eq!(
        t.snapshot().revision,
        4,
        "a second exit for a gone session is no change"
    );
}

#[test]
fn asks_opened_rises_for_a_new_question_while_the_open_count_stays() {
    let t = Tracker::default();
    let live = AtomicBool::new(true);
    let now = Instant::now();
    // Counter-probe: `asks` alone cannot tell this batch from a repeated
    // snapshot — it is 1 before and 1 after.
    t.on_frame(
        "s1",
        Some("extension_ui_request"),
        Some(&json!({"id":"a","method":"input"})),
        now,
        &live,
    );
    let first = t.snapshot().sessions["s1"].asks_opened;
    assert!(first > 0);
    t.on_answered("s1", "a", &live);
    t.on_frame(
        "s1",
        Some("extension_ui_request"),
        Some(&json!({"id":"b","method":"input"})),
        now,
        &live,
    );
    let second = t.snapshot().sessions["s1"];
    assert_eq!(
        second.asks, 1,
        "answer A + open B leaves the open count alone"
    );
    assert!(
        second.asks_opened > first,
        "the new ask still carries a higher sequence stamp"
    );
    t.on_frame(
        "s1",
        Some("extension_ui_request"),
        Some(&json!({"id":"b","method":"input"})),
        now,
        &live,
    );
    assert_eq!(
        t.snapshot().sessions["s1"].asks_opened,
        second.asks_opened,
        "a duplicate open does not stamp again"
    );
}
