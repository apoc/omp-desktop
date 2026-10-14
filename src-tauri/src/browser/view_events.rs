//! The view's threads: the connection's event handler (reader thread), the
//! frame emitter and the input sender; the worker is in `view_worker`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::thread;

use serde_json::{json, Value};

use super::annotate;
use super::cdp::{EventHandler, DISCONNECTED};
use super::emit::Frame;
use super::lock;
use super::view_core::Core;
use super::view_worker::run_worker;

/// What the worker thread is told.
pub(super) enum Event {
    Cdp {
        session: Option<String>,
        method: String,
        params: Value,
    },
    /// The agent worked in a page: take it from [`FollowSlot`]. At most one
    /// of these is queued at a time.
    Follow,
    /// Answered once everything queued before it has been handled.
    Barrier(Sender<()>),
    /// A frame had the wrong size: restart the screencast.
    Restart,
    Stop,
}

/// A gesture queued for the page that was shown when it was made: it is
/// dropped, not redirected, when another page is shown by the time it is
/// sent.
pub(super) struct InputItem {
    pub session: String,
    pub generation: u64,
    pub method: &'static str,
    pub params: Value,
}

/// Events the worker acts on; the handler drops all others.
const FORWARDED: [&str; 8] = [
    "Target.targetCreated",
    "Target.targetInfoChanged",
    "Target.targetDestroyed",
    "Page.frameNavigated",
    "Page.frameStartedLoading",
    "Page.frameStoppedLoading",
    "Page.loadEventFired",
    "Page.navigatedWithinDocument",
];

#[derive(Default)]
struct Slot {
    frame: Option<(u64, Frame)>,
    closed: bool,
}

/// The latest screencast frame waiting for the emitter: a slower emitter
/// skips frames instead of queueing them.
#[derive(Default)]
pub(super) struct FrameSlot {
    slot: Mutex<Slot>,
    ready: Condvar,
}

impl FrameSlot {
    fn put(&self, generation: u64, frame: Frame) {
        lock(&self.slot).frame = Some((generation, frame));
        self.ready.notify_one();
    }

    pub fn clear(&self) {
        lock(&self.slot).frame = None;
    }

    pub fn close(&self) {
        lock(&self.slot).closed = true;
        self.ready.notify_all();
    }

    /// The newest frame with the activation it was captured for, waiting
    /// for one; `None` once closed.
    fn next(&self) -> Option<(u64, Frame)> {
        let mut slot = lock(&self.slot);
        loop {
            if slot.closed {
                return None;
            }
            if let Some(frame) = slot.frame.take() {
                return Some(frame);
            }
            slot = self
                .ready
                .wait(slot)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }
}

/// The page the agent worked in last, waiting for the worker. Reports
/// overwrite each other: a client streaming intents costs one slot and one
/// queued wake-up, and the worker switches once, to the newest page, not
/// through every stale one.
#[derive(Default)]
pub(super) struct FollowSlot {
    target: Mutex<Option<String>>,
    /// An `Event::Follow` is queued and the worker has not taken the slot
    /// since.
    woken: AtomicBool,
}

impl FollowSlot {
    /// Record `target` as the newest; `true` when the worker must be woken
    /// (no wake-up is queued yet).
    pub fn put(&self, target: &str) -> bool {
        *lock(&self.target) = Some(target.to_owned());
        !self.woken.swap(true, Ordering::SeqCst)
    }

    /// The newest page, if any. Clears the wake-up mark first: a report that
    /// lands after the clear queues a new wake-up, one before it is read
    /// here.
    pub fn take(&self) -> Option<String> {
        self.woken.store(false, Ordering::SeqCst);
        lock(&self.target).take()
    }
}

/// The handler for the connection's reader thread. Frames are acknowledged
/// and handed to the emitter right here; the rest goes to the worker.
pub(super) fn handler(core: Weak<Core>, worker: Sender<Event>) -> EventHandler {
    Box::new(move |session, method, params| {
        let Some(core) = core.upgrade() else {
            return;
        };
        if method == "Page.screencastFrame" {
            if on_frame(&core, session, params) {
                let _ = worker.send(Event::Restart);
            }
        } else if annotate::EVENTS.contains(&method) {
            core.on_overlay_event(session, method, params);
        } else if method == DISCONNECTED || FORWARDED.contains(&method) {
            let _ = worker.send(Event::Cdp {
                session: session.map(str::to_owned),
                method: method.to_owned(),
                params: params.clone(), // the handler only borrows it
            });
        }
    })
}

/// Acknowledge and queue a frame of the shown page. `true` when the frame
/// is of the wrong size and the screencast should restart.
fn on_frame(core: &Core, session: Option<&str>, params: &Value) -> bool {
    let Some(session) = session else {
        return false;
    };
    // Acknowledge before anything else, or Chromium stops sending.
    if let (Some(client), Some(id)) = (
        core.client.get(),
        params.get("sessionId").and_then(Value::as_i64),
    ) {
        client.notify(
            Some(session),
            "Page.screencastFrameAck",
            json!({ "sessionId": id }),
        );
    }
    let Some(data) = params.get("data").and_then(Value::as_str) else {
        return false;
    };
    let mut inner = lock(&core.inner);
    let Some(generation) = inner
        .active
        .as_ref()
        .filter(|a| a.session == session)
        .map(|a| a.generation)
    else {
        return false; // a page we no longer show
    };
    // The metadata's device size is the CSS size of what the image shows.
    let metadata = &params["metadata"];
    let css = |key: &str, fallback: u32| {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let css = metadata[key]
            .as_f64()
            .map_or(fallback, |v| v.round() as u32); // a screen size in DIP
        css
    };
    let css_w = css("deviceWidth", inner.size.w);
    let css_h = css("deviceHeight", inner.size.h);
    // The event is borrowed; the base64 stays as Chromium sent it.
    let frame = Frame::new(data.to_owned(), css_w, css_h);
    let proportioned = frame.has_css_proportions();
    let restart = inner.frame_needs_restart(css_w, css_h, proportioned);
    drop(inner);
    // An image that is not what its metadata says would map clicks wrong.
    if proportioned {
        core.frames.put(generation, frame);
    }
    restart
}

/// Start the worker, frame emitter and input sender threads.
pub(super) fn spawn(
    core: &Arc<Core>,
    events: Receiver<Event>,
    input: Receiver<InputItem>,
) -> Result<(), String> {
    let spawn = |name: &str, run: Box<dyn FnOnce() + Send>| {
        thread::Builder::new()
            .name(name.into())
            .spawn(run)
            .map(drop)
            .map_err(|e| format!("{name} thread: {e}"))
    };
    let worker = Arc::clone(core);
    spawn(
        "browser-events",
        Box::new(move || run_worker(&worker, &events)),
    )?;
    let emitter = Arc::clone(core);
    spawn(
        "browser-frames",
        Box::new(move || {
            while let Some((generation, frame)) = emitter.frames.next() {
                emitter.emit_frame(generation, &frame);
            }
        }),
    )?;
    let sender = Arc::clone(core);
    spawn(
        "browser-input",
        Box::new(move || run_input(&sender, &input)),
    )
}

fn run_input(core: &Core, queue: &Receiver<InputItem>) {
    let mut failing = false;
    for item in queue {
        if core.is_closed() {
            break;
        }
        #[cfg(test)]
        drop(lock(&core.input_gate)); // a test holds it to keep the queue from draining
        match core.send_input(item) {
            Ok(()) => failing = false,
            Err(e) if !failing => {
                failing = true; // one line per streak, not per mouse move
                eprintln!("[omp-desktop] browser input: {e}");
            }
            Err(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(n: u32) -> Frame {
        Frame::new(format!("frame{n}"), n, n)
    }

    #[test]
    fn follow_reports_overwrite_each_other_and_wake_once() {
        let slot = FollowSlot::default();
        assert!(slot.put("a"), "the first report wakes the worker");
        for n in 0..1000 {
            assert!(!slot.put(&format!("t{n}")), "a wake-up is already queued");
        }
        assert_eq!(slot.take().as_deref(), Some("t999"), "only the newest");
        assert_eq!(slot.take(), None);
        assert!(slot.put("b"), "after the worker took it, wake again");
    }

    #[test]
    fn a_slow_emitter_gets_only_the_latest_frame() {
        let slot = FrameSlot::default();
        for n in 1..=3 {
            slot.put(1, frame(n));
        }
        assert_eq!(slot.next(), Some((1, frame(3))), "1 and 2 were skipped");
        slot.put(1, frame(4));
        slot.clear();
        slot.put(2, frame(5));
        assert_eq!(
            slot.next(),
            Some((2, frame(5))),
            "a cleared frame is gone, the activation stays with its frame"
        );
    }

    #[test]
    fn closing_wakes_a_waiting_emitter() {
        let slot = Arc::new(FrameSlot::default());
        let waiting = Arc::clone(&slot);
        let emitter = thread::spawn(move || waiting.next());
        thread::sleep(std::time::Duration::from_millis(50));
        slot.close();
        assert_eq!(emitter.join().unwrap(), None);
        slot.put(1, frame(1));
        assert_eq!(slot.next(), None, "closed stays closed");
    }
}
