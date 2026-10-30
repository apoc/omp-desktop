use super::*;
use crate::remote::tracker::Tracker;
use crate::test_support::{wait_until, TempDir};
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Counts {
    attempts: AtomicUsize,
    acquired: AtomicUsize,
    released: AtomicUsize,
    fail_acquire: AtomicBool,
    fail_release: AtomicBool,
}

struct FakeInhibitor {
    counts: Arc<Counts>,
    held: bool,
}

impl Inhibitor for FakeInhibitor {
    fn release(&mut self) -> Result<(), String> {
        if self.counts.fail_release.load(Ordering::Acquire) {
            return Err("release refused".into());
        }
        if self.held {
            self.held = false;
            self.counts.released.fetch_add(1, Ordering::AcqRel);
        }
        Ok(())
    }
}

impl Drop for FakeInhibitor {
    fn drop(&mut self) {
        if self.held {
            self.counts.released.fetch_add(1, Ordering::AcqRel);
        }
    }
}

struct Fixture {
    manager: Arc<KeepAwake>,
    tracker: Arc<Tracker>,
    counts: Arc<Counts>,
    events: Arc<Mutex<Vec<Arc<Snapshot>>>>,
}

impl Fixture {
    fn new(path: Option<PathBuf>) -> Self {
        let tracker = Arc::new(Tracker::default());
        let counts = Arc::new(Counts::default());
        let events = Arc::new(Mutex::new(Vec::new()));
        let source = Arc::clone(&tracker);
        let counter = Arc::clone(&counts);
        let captured = Arc::clone(&events);
        let manager = KeepAwake::new(
            path,
            move || source.snapshot(),
            move || {
                counter.attempts.fetch_add(1, Ordering::AcqRel);
                if counter.fail_acquire.load(Ordering::Acquire) {
                    return Err("acquisition refused".into());
                }
                counter.acquired.fetch_add(1, Ordering::AcqRel);
                Ok(FakeInhibitor {
                    counts: Arc::clone(&counter),
                    held: true,
                })
            },
            move |snapshot| captured.lock().unwrap().push(snapshot),
            None,
        );
        tracker.set_sink(Arc::clone(&manager) as Arc<dyn TrackerSink>);
        Self {
            manager,
            tracker,
            counts,
            events,
        }
    }

    fn snapshot(&self) -> Arc<Snapshot> {
        self.manager.request(Request::Snapshot).unwrap()
    }
    fn register(&self, id: &str) {
        self.manager.register(id, self.manager.epoch()).unwrap();
    }
    fn default(&self, enabled: bool) -> Arc<Snapshot> {
        self.manager
            .request(|reply| Request::Default { enabled, reply })
            .unwrap()
    }
    fn session(&self, id: &str, enabled: Option<bool>) -> Result<Arc<Snapshot>, String> {
        self.manager.request(|reply| Request::Session {
            id: id.into(),
            enabled,
            reply,
        })
    }
    fn frame(&self, id: &str, kind: &str, value: Option<&serde_json::Value>) {
        self.tracker.on_frame(
            id,
            Some(kind),
            value,
            Instant::now(),
            &AtomicBool::new(true),
        );
    }
    fn tab<'a>(snapshot: &'a Snapshot, id: &str) -> &'a Session {
        snapshot
            .sessions
            .iter()
            .find(|session| session.id.as_ref() == id)
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop();
    }
}

#[test]
fn defaults_overrides_and_multiple_background_tabs_share_one_inhibitor() {
    let f = Fixture::new(None);
    f.register("a");
    f.register("b");
    assert!(!f.snapshot().default_enabled);
    f.frame("a", "agent_start", None);
    assert!(!f.snapshot().active);
    let enabled = f.default(true);
    assert!(enabled.active);
    assert!(Fixture::tab(&enabled, "a").working);
    assert_eq!(f.counts.acquired.load(Ordering::Acquire), 1);
    let explicit = f.session("b", Some(false)).unwrap();
    assert!(!Fixture::tab(&explicit, "b").enabled);
    f.frame("b", "agent_start", None);
    assert!(f.snapshot().active);
    f.frame("a", "agent_end", None);
    assert!(!f.snapshot().active);
    let b = f.session("b", Some(true)).unwrap();
    assert!(b.active);
    assert_eq!(f.counts.acquired.load(Ordering::Acquire), 2);
    let off = f.default(false);
    assert!(off.active, "explicit opt-in survives a default change");
    assert!(!Fixture::tab(&off, "a").enabled);
    assert!(Fixture::tab(&off, "b").enabled);
    let inherited = f.session("b", None).unwrap();
    assert!(!inherited.active);
    assert_eq!(Fixture::tab(&inherited, "b").override_enabled, None);
    assert_eq!(f.counts.released.load(Ordering::Acquire), 2);
    let events = f.events.lock().unwrap();
    assert!(events
        .windows(2)
        .all(|pair| pair[0].revision < pair[1].revision));
    drop(events);
}

#[test]
fn closing_one_of_two_busy_enabled_tabs_keeps_the_shared_request() {
    let f = Fixture::new(None);
    f.register("a");
    f.register("b");
    f.default(true);
    f.frame("a", "agent_start", None);
    assert!(f.snapshot().active);
    f.frame("b", "agent_start", None);
    assert!(f.snapshot().active);
    assert_eq!(f.counts.acquired.load(Ordering::Acquire), 1);
    f.manager.close("a");
    let remaining = f.snapshot();
    assert!(remaining.active);
    assert_eq!(remaining.sessions.len(), 1);
    assert_eq!(f.counts.released.load(Ordering::Acquire), 0);
    f.tracker.on_exit("b");
    assert!(!f.snapshot().active);
    assert_eq!(f.counts.released.load(Ordering::Acquire), 1);
}

#[test]
fn non_yielding_end_and_question_preserve_busy_yield_and_exit_release() {
    let f = Fixture::new(None);
    f.register("a");
    f.default(true);
    f.frame("a", "agent_start", None);
    assert!(f.snapshot().active);
    f.frame(
        "a",
        "extension_ui_request",
        Some(&json!({"id":"q", "method":"confirm"})),
    );
    assert!(f.snapshot().active);
    f.frame("a", "agent_end", Some(&json!({"yielded":false})));
    assert!(f.snapshot().active);
    assert_eq!(f.counts.acquired.load(Ordering::Acquire), 1);
    f.frame("a", "agent_end", Some(&json!({"yielded":true})));
    assert!(!f.snapshot().active);
    f.frame("a", "agent_start", None);
    assert!(f.snapshot().active);
    f.tracker.on_exit("a");
    let ended = f.snapshot();
    assert!(!ended.active);
    assert!(!Fixture::tab(&ended, "a").working);
    assert!(Fixture::tab(&ended, "a").enabled);
}

#[test]
fn close_respawn_reset_and_shutdown_invalidate_ownership() {
    let f = Fixture::new(None);
    f.register("a");
    f.session("a", Some(true)).unwrap();
    f.frame("a", "agent_start", None);
    assert!(f.snapshot().active);
    f.tracker.on_exit("a");
    assert!(!f.snapshot().active);
    f.register("a"); // process restart is not a new tab
    assert_eq!(
        Fixture::tab(&f.snapshot(), "a").override_enabled,
        Some(true)
    );
    f.frame("a", "agent_start", None);
    assert!(f.snapshot().active);
    f.manager.close("a");
    assert!(!f.snapshot().active);
    assert!(f.session("a", Some(true)).is_err());
    f.register("b");
    f.session("b", Some(true)).unwrap();
    f.frame("b", "agent_start", None);
    assert!(f.snapshot().active);
    let old_epoch = f.manager.epoch();
    f.manager.reset();
    assert!(f.manager.register("old-start", old_epoch).is_err());
    assert!(f.snapshot().sessions.is_empty());
    assert!(!f.snapshot().active);
    assert!(f.session("b", None).is_err());
    f.register("c");
    f.session("c", Some(true)).unwrap();
    f.frame("c", "agent_start", None);
    assert!(f.snapshot().active);
    f.manager.stop();
    assert!(!f.manager.shared.current().active);
    assert!(f.manager.shared.current().sessions.is_empty());
}

#[test]
fn persistence_is_strict_and_missing_config_is_memory_only() {
    let dir = TempDir::new("keep-awake", "settings");
    let path = dir.path().join("keep-awake.json");
    {
        let f = Fixture::new(Some(path.clone())); // This path is reused by later runs.
        assert!(!f.snapshot().default_enabled);
        f.default(true);
        f.register("tab");
        f.session("tab", Some(false)).unwrap();
    }
    {
        let f = Fixture::new(Some(path.clone())); // Reopen the same file again below.
        assert!(f.snapshot().default_enabled);
        f.register("tab");
        assert_eq!(Fixture::tab(&f.snapshot(), "tab").override_enabled, None);
    }
    std::fs::write(&path, "broken JSON").unwrap();
    let f = Fixture::new(Some(path.clone())); // Retain the path to verify corrupt bytes are untouched.
    let snapshot = f.snapshot();
    assert!(!snapshot.default_enabled);
    assert!(snapshot.error.as_deref().unwrap().contains("unreadable"));
    assert!(f
        .manager
        .request(|reply| Request::Default {
            enabled: true,
            reply
        })
        .is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "broken JSON");
    let memory = Fixture::new(None);
    assert!(memory.default(true).default_enabled);
    assert!(!Fixture::new(None).snapshot().default_enabled);
}

#[test]
fn acquisition_and_release_failures_are_visible_and_retry_on_real_transitions() {
    let f = Fixture::new(None);
    f.register("a");
    f.default(true);
    f.counts.fail_acquire.store(true, Ordering::Release);
    f.frame("a", "agent_start", None);
    let failed = f.snapshot();
    assert!(!failed.active);
    assert!(failed
        .error
        .as_deref()
        .unwrap()
        .contains("acquisition refused"));
    f.frame(
        "a",
        "extension_ui_request",
        Some(&json!({"id":"q", "method":"input"})),
    );
    let _ = f.snapshot();
    assert_eq!(f.counts.attempts.load(Ordering::Acquire), 1);
    f.counts.fail_acquire.store(false, Ordering::Release);
    f.session("a", Some(false)).unwrap();
    let recovered = f.session("a", Some(true)).unwrap();
    assert!(recovered.active);
    assert!(recovered.error.is_none());
    f.counts.fail_release.store(true, Ordering::Release);
    let failed_release = f.session("a", Some(false)).unwrap();
    assert!(failed_release.active);
    assert!(failed_release
        .error
        .as_deref()
        .unwrap()
        .contains("release refused"));
    f.counts.fail_release.store(false, Ordering::Release);
    let released = f.session("a", None).unwrap();
    assert!(released.active); // inherited default is on
    let released = f.session("a", Some(false)).unwrap();
    assert!(!released.active);
    assert!(released.error.is_none());
}

#[test]
fn worker_panics_are_reported_instead_of_claiming_success() {
    let tracker = Arc::new(Tracker::default());
    let source = Arc::clone(&tracker);
    let manager = KeepAwake::new(
        None,
        move || source.snapshot(),
        || -> Result<FakeInhibitor, String> { panic!("native backend panicked") },
        |_| {},
        None,
    );
    tracker.set_sink(Arc::clone(&manager) as Arc<dyn TrackerSink>);
    manager.register("a", manager.epoch()).unwrap();
    manager
        .request(|reply| Request::Default {
            enabled: true,
            reply,
        })
        .unwrap();
    tracker.on_frame(
        "a",
        Some("agent_start"),
        None,
        Instant::now(),
        &AtomicBool::new(true),
    );
    assert!(wait_until(Duration::from_secs(2), || manager
        .shared
        .current()
        .error
        .is_some()));
    let snapshot = manager.shared.current();
    assert!(!snapshot.active);
    assert!(snapshot
        .error
        .as_deref()
        .unwrap()
        .contains("worker stopped unexpectedly"));
    assert!(manager.request(Request::Snapshot).is_err());
    manager.stop();
}

#[test]
fn worker_failure_releases_an_already_acquired_inhibitor() {
    let tracker = Arc::new(Tracker::default());
    let source = Arc::clone(&tracker);
    let panic_now = Arc::new(AtomicBool::new(false));
    let panic_source = Arc::clone(&panic_now);
    let counts = Arc::new(Counts::default());
    let counter = Arc::clone(&counts);
    let manager = KeepAwake::new(
        None,
        move || {
            assert!(!panic_source.load(Ordering::Acquire), "tracker failed");
            source.snapshot()
        },
        move || {
            Ok(FakeInhibitor {
                counts: Arc::clone(&counter),
                held: true,
            })
        },
        |_| {},
        None,
    );
    tracker.set_sink(Arc::clone(&manager) as Arc<dyn TrackerSink>);
    manager.register("a", manager.epoch()).unwrap();
    manager
        .request(|reply| Request::Default {
            enabled: true,
            reply,
        })
        .unwrap();
    tracker.on_frame(
        "a",
        Some("agent_start"),
        None,
        Instant::now(),
        &AtomicBool::new(true),
    );
    assert!(manager.request(Request::Snapshot).unwrap().active);
    panic_now.store(true, Ordering::Release);
    manager.shared.dirty.store(true, Ordering::Release);
    manager.shared.wake();
    assert!(wait_until(Duration::from_secs(2), || manager
        .shared
        .current()
        .error
        .is_some()));
    assert!(!manager.shared.current().active);
    assert_eq!(counts.released.load(Ordering::Acquire), 1);
    manager.stop();
}

#[test]
fn acquisition_is_never_published_before_the_worker_completes_it() {
    let tracker = Arc::new(Tracker::default());
    let source = Arc::clone(&tracker);
    let (entered_tx, entered_rx) = mpsc::sync_channel(1);
    let (gate_tx, gate_rx) = mpsc::sync_channel(1);
    let gate_rx = Mutex::new(gate_rx);
    let counts = Arc::new(Counts::default());
    let counter = Arc::clone(&counts);
    let manager = KeepAwake::new(
        None,
        move || source.snapshot(),
        move || {
            entered_tx.send(()).unwrap();
            gate_rx.lock().unwrap().recv().unwrap();
            Ok(FakeInhibitor {
                counts: Arc::clone(&counter),
                held: true,
            })
        },
        |_| {},
        None,
    );
    tracker.set_sink(Arc::clone(&manager) as Arc<dyn TrackerSink>);
    manager.register("a", manager.epoch()).unwrap();
    manager
        .request(|reply| Request::Default {
            enabled: true,
            reply,
        })
        .unwrap();
    tracker.on_frame(
        "a",
        Some("agent_start"),
        None,
        Instant::now(),
        &AtomicBool::new(true),
    );
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let pending = manager.shared.current();
    assert!(Fixture::tab(&pending, "a").working);
    assert!(!pending.active);
    gate_tx.send(()).unwrap();
    assert!(wait_until(Duration::from_secs(2), || manager
        .shared
        .current()
        .active));
    manager.stop();
}

#[test]
fn reload_during_pending_acquisition_releases_before_it_can_be_adopted() {
    let tracker = Arc::new(Tracker::default());
    let source = Arc::clone(&tracker);
    let (entered_tx, entered_rx) = mpsc::sync_channel(1);
    let (gate_tx, gate_rx) = mpsc::sync_channel(1);
    let gate_rx = Mutex::new(gate_rx);
    let counts = Arc::new(Counts::default());
    let counter = Arc::clone(&counts);
    let manager = KeepAwake::new(
        None,
        move || source.snapshot(),
        move || {
            entered_tx.send(()).unwrap();
            gate_rx.lock().unwrap().recv().unwrap();
            counter.acquired.fetch_add(1, Ordering::AcqRel);
            Ok(FakeInhibitor {
                counts: Arc::clone(&counter),
                held: true,
            })
        },
        |_| {},
        None,
    );
    tracker.set_sink(Arc::clone(&manager) as Arc<dyn TrackerSink>);
    manager.register("a", manager.epoch()).unwrap();
    manager
        .request(|reply| Request::Default {
            enabled: true,
            reply,
        })
        .unwrap();
    tracker.on_frame(
        "a",
        Some("agent_start"),
        None,
        Instant::now(),
        &AtomicBool::new(true),
    );
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    manager.reset();
    gate_tx.send(()).unwrap();
    let snapshot = manager.request(Request::Snapshot).unwrap();
    assert!(snapshot.sessions.is_empty());
    assert!(!snapshot.active);
    assert_eq!(counts.acquired.load(Ordering::Acquire), 1);
    assert_eq!(counts.released.load(Ordering::Acquire), 1);
    manager.stop();
}

/// Opt-in, non-GUI real platform probe: inspect only this process's reason/PID
/// with `pmset -g assertions` while the test waits, then again after release.
#[cfg(target_os = "macos")]
#[test]
#[ignore = "creates real idle and display assertions for 30 seconds"]
fn macos_real_inhibitor_pmset_probe() {
    let tracker = Arc::new(Tracker::default());
    let source = Arc::clone(&tracker);
    let manager = KeepAwake::new(
        None,
        move || source.snapshot(),
        platform::acquire,
        |_| {},
        None,
    );
    tracker.set_sink(Arc::clone(&manager) as Arc<dyn TrackerSink>);
    manager.register("probe", manager.epoch()).unwrap();
    manager
        .request(|reply| Request::Default {
            enabled: true,
            reply,
        })
        .unwrap();
    tracker.on_frame(
        "probe",
        Some("agent_start"),
        None,
        Instant::now(),
        &AtomicBool::new(true),
    );
    let acquired = manager.request(Request::Snapshot).unwrap();
    assert!(
        acquired.active,
        "real acquisition failed: {:?}",
        acquired.error
    );
    eprintln!(
        "KEEP_AWAKE_SNAPSHOT {}",
        serde_json::to_string(&acquired).unwrap()
    );
    eprintln!(
        "KEEP_AWAKE_ACQUIRED pid={} reason=OMP Desktop agent work",
        std::process::id()
    );
    std::thread::sleep(Duration::from_secs(30));
    tracker.on_frame(
        "probe",
        Some("agent_end"),
        None,
        Instant::now(),
        &AtomicBool::new(true),
    );
    let released = manager.request(Request::Snapshot).unwrap();
    assert!(
        !released.active,
        "real release failed: {:?}",
        released.error
    );
    eprintln!("KEEP_AWAKE_RELEASED pid={}", std::process::id());
    std::thread::sleep(Duration::from_secs(15));
    manager.stop();
}
