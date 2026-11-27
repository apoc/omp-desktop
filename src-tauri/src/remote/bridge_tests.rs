use super::*;
use crate::remote::devices::DeviceStore;
use crate::remote::emit::{Action, Status};
use crate::remote::tracker::AttentionSnapshot;
use std::sync::atomic::AtomicBool;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

struct NoEmit;

impl RemoteEmit for NoEmit {
    fn watch(&self, _tab_ids: &[String]) {}
    fn connections(&self, _device_ids: &[String]) {}
    fn action(&self, _action: &Action) {}
    fn status(&self, _status: &Status) {}
}

/// Keeps every tracker snapshot the fan-out hands to the webview edge.
#[derive(Default)]
struct RecordingEmit(Mutex<Vec<AttentionSnapshot>>);

impl RecordingEmit {
    fn snapshots(&self) -> Vec<AttentionSnapshot> {
        self.0.lock().unwrap().clone()
    }
}

impl RemoteEmit for RecordingEmit {
    fn watch(&self, _tab_ids: &[String]) {}
    fn connections(&self, _device_ids: &[String]) {}
    fn action(&self, _action: &Action) {}
    fn status(&self, _status: &Status) {}
    fn tracker(&self, snapshot: &AttentionSnapshot) {
        self.0.lock().unwrap().push(snapshot.clone());
    }
}

type Recorded = (String, Option<Transition>);

struct Recorder(mpsc::SyncSender<Recorded>);

impl TrackerSink for Recorder {
    fn changed(&self, sid: &str, transition: Option<Transition>) {
        let _ = self.0.send((sid.to_owned(), transition));
    }
}

fn fan_out(name: &str) -> (FanOut, Arc<Hub>, mpsc::Receiver<Recorded>) {
    let dir = crate::test_support::tempdir("remote-bridge", name);
    let devices = Arc::new(DeviceStore::load(dir.join("devices.json")));
    let hub = Arc::new(Hub::new(devices, Arc::new(NoEmit)));
    let fan_out = FanOut::new(Arc::clone(&hub), Arc::new(NoEmit)).unwrap();
    let (tx, rx) = mpsc::sync_channel(16);
    fan_out.set_push(Some(Arc::new(Recorder(tx))));
    (fan_out, hub, rx)
}

fn finished(secs: u64) -> Transition {
    Transition::TurnFinished {
        ran: Duration::from_secs(secs),
    }
}

#[test]
fn the_sink_returns_while_the_hub_is_locked_and_the_worker_catches_up() {
    let (fan_out, hub, seen) = fan_out("sink-locked");
    let (done_tx, done_rx) = mpsc::channel();
    let fan_out = Arc::new(fan_out);
    hub.while_locked(|| {
        let sink = Arc::clone(&fan_out);
        std::thread::spawn(move || {
            sink.changed("a", Some(Transition::QuestionOpened));
            sink.changed("a", Some(finished(30)));
            done_tx.send(()).unwrap();
        });
        done_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("the sink waited for the hub lock");
    });
    // Newest transition of the session wins; a stale one may have been taken
    // by the worker before it blocked on the hub.
    let mut last = None;
    while let Ok(item) = seen.recv_timeout(Duration::from_secs(2)) {
        last = Some(item);
        if last.as_ref().is_some_and(|(_, t)| *t == Some(finished(30))) {
            break;
        }
    }
    assert_eq!(last, Some(("a".to_owned(), Some(finished(30)))));
    fan_out.stop();
}

#[test]
fn a_stopped_fan_out_forwards_nothing_more() {
    let (fan_out, _hub, seen) = fan_out("stopped");
    fan_out.stop();
    fan_out.changed("a", Some(Transition::QuestionOpened));
    assert!(seen.recv_timeout(Duration::from_millis(300)).is_err());
}

#[test]
fn the_webview_edge_receives_the_tracker_snapshot_after_an_open() {
    let dir = crate::test_support::tempdir("remote-bridge", "attention");
    let devices = Arc::new(DeviceStore::load(dir.join("devices.json")));
    let hub = Arc::new(Hub::new(devices, Arc::new(NoEmit)));
    let emit = Arc::new(RecordingEmit::default());
    let fan_out = FanOut::new(Arc::clone(&hub), Arc::clone(&emit) as Arc<dyn RemoteEmit>).unwrap();
    let sid = "bridge-attention-open";
    tracker().on_frame(
        sid,
        Some("extension_ui_request"),
        Some(&serde_json::json!({"id":"q","method":"select"})),
        Instant::now(),
        &AtomicBool::new(true),
    );
    fan_out.changed(sid, Some(Transition::QuestionOpened));
    let seen = crate::test_support::eventually(Duration::from_secs(2), || {
        emit.snapshots().into_iter().rev().find(|snapshot| {
            snapshot
                .sessions
                .get(sid)
                .is_some_and(|entry| entry.asks == 1)
        })
    })
    .expect("the tracker snapshot reached the webview edge");
    let entry = seen.sessions[sid];
    assert_eq!(
        (entry.busy, entry.asks, entry.background),
        (false, 1, false)
    );
    assert!(
        entry.asks_opened > 0,
        "the new ask carries its sequence stamp"
    );
    assert!(seen.revision > 0, "the edge event is ordered by revision");
    tracker().on_exit(sid);
    fan_out.stop();
}
