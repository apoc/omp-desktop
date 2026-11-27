//! Screencast frames from Chromium to the webview, with flow control: at
//! most one frame is in flight to the webview, and Chromium is acked
//! (`Page.screencastFrameAck`) only once the webview acked the frame it
//! holds or dropped (`browser_frame_ack`), or after `ACK_TIMEOUT`, so a
//! busy webview slows Chromium down instead of queueing frames. The newest
//! frame waits in a one-frame slot; an older one waiting is skipped.

use std::mem;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::super::lock;
use super::core::Core;
use super::emit::Frame;

/// How long a frame in flight waits for the webview's ack; a lost ack costs
/// this much, not the stream.
pub(super) const ACK_TIMEOUT: Duration = Duration::from_secs(1);

/// The `Page.screencastFrameAck` a frame of page session `session` owes
/// Chromium (`id` is the screencast's `sessionId` of the frame).
#[derive(Debug, PartialEq, Eq)]
pub(super) struct ChromiumAck {
    session: String,
    id: i64,
}

struct Waiting {
    generation: u64,
    frame: Frame,
    ack: Option<ChromiumAck>,
}

struct InFlight {
    seq: u64,
    sent: Instant,
    ack: Option<ChromiumAck>,
    acked: bool,
}

#[derive(Default)]
struct Flow {
    waiting: Option<Waiting>,
    in_flight: Option<InFlight>,
    /// Acks of frames that were skipped or released, not sent yet.
    owed: Vec<ChromiumAck>,
    seq: u64,
    closed: bool,
}

/// What the emitter does next: send `acks` to Chromium, then emit `frame`
/// (the activation it was captured for, the frame).
#[derive(Debug, PartialEq)]
pub(super) struct Step {
    pub acks: Vec<ChromiumAck>,
    pub frame: Option<(u64, Frame)>,
}

/// The frame waiting for the emitter and the one in flight to the webview.
pub(super) struct FrameFlow {
    flow: Mutex<Flow>,
    ready: Condvar,
    ack_timeout: Duration,
}

impl Default for FrameFlow {
    fn default() -> Self {
        Self::with_ack_timeout(ACK_TIMEOUT)
    }
}

impl FrameFlow {
    pub fn with_ack_timeout(ack_timeout: Duration) -> Self {
        Self {
            flow: Mutex::default(),
            ready: Condvar::new(),
            ack_timeout,
        }
    }

    /// The newest frame of activation `generation`; one still waiting is
    /// skipped (its ack goes out with the next release).
    pub fn put(&self, generation: u64, frame: Frame, ack: Option<ChromiumAck>) {
        let mut flow = lock(&self.flow);
        let next = Waiting {
            generation,
            frame,
            ack,
        };
        if let Some(skipped) = flow.waiting.replace(next) {
            flow.owed.extend(skipped.ack);
        }
        drop(flow);
        self.ready.notify_one();
    }

    /// Skip the waiting frame (the screencast restarts).
    pub fn clear(&self) {
        let mut flow = lock(&self.flow);
        if let Some(skipped) = flow.waiting.take() {
            flow.owed.extend(skipped.ack);
        }
    }

    /// The webview is done with frame `seq`; other seqs are ignored.
    pub fn ack(&self, seq: u64) {
        let mut flow = lock(&self.flow);
        if let Some(in_flight) = flow.in_flight.as_mut().filter(|f| f.seq == seq) {
            in_flight.acked = true;
            self.ready.notify_one();
        }
    }

    pub fn close(&self) {
        lock(&self.flow).closed = true;
        self.ready.notify_all();
    }

    /// Wait for the next step; `None` once closed. A frame is handed out
    /// only when none is in flight (the webview acked it, or it timed out),
    /// numbered by `seq`.
    pub fn next(&self) -> Option<Step> {
        let mut flow = lock(&self.flow);
        loop {
            if flow.closed {
                return None;
            }
            let wait = flow.in_flight.as_ref().and_then(|f| {
                let left = self.ack_timeout.saturating_sub(f.sent.elapsed());
                (!f.acked && !left.is_zero()).then_some(left)
            });
            if let Some(left) = wait {
                flow = self
                    .ready
                    .wait_timeout(flow, left)
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .0;
                continue;
            }
            if let Some(released) = flow.in_flight.take() {
                flow.owed.extend(released.ack);
            }
            if let Some(Waiting {
                generation,
                mut frame,
                ack,
            }) = flow.waiting.take()
            {
                flow.seq += 1;
                frame.seq = flow.seq;
                flow.in_flight = Some(InFlight {
                    seq: flow.seq,
                    sent: Instant::now(),
                    ack,
                    acked: false,
                });
                let acks = mem::take(&mut flow.owed);
                return Some(Step {
                    acks,
                    frame: Some((generation, frame)),
                });
            }
            if !flow.owed.is_empty() {
                let acks = mem::take(&mut flow.owed);
                return Some(Step { acks, frame: None });
            }
            flow = self
                .ready
                .wait(flow)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }
}

/// The ack a screencast frame event of page session `session` asks for.
pub(super) fn chromium_ack(session: &str, params: &Value) -> Option<ChromiumAck> {
    params
        .get("sessionId")
        .and_then(Value::as_i64)
        .map(|id| ChromiumAck {
            session: session.to_owned(),
            id,
        })
}

impl Core {
    /// Emit frames as the flow hands them out, until the view closes.
    pub(super) fn run_emitter(&self) {
        while let Some(Step { acks, frame }) = self.frames.next() {
            self.ack_chromium(acks);
            if let Some((generation, frame)) = frame {
                if !self.emit_frame(generation, &frame) {
                    self.frames.ack(frame.seq); // never reaches the webview
                }
            }
        }
    }

    /// Send owed frame acks; Chromium sends no more frames than it has
    /// acks outstanding for.
    pub(super) fn ack_chromium(&self, acks: impl IntoIterator<Item = ChromiumAck>) {
        let Some(client) = self.client.get() else {
            return;
        };
        for ack in acks {
            client.notify(
                Some(&ack.session),
                "Page.screencastFrameAck",
                json!({ "sessionId": ack.id }),
            );
        }
    }

    /// Emit a frame captured for activation `generation`; `false` (nothing
    /// emitted) for one of an earlier activation. `emit_order` is held
    /// across the check and the emit, as an activation holds it to emit its
    /// `tabs` event, so no frame of the old page follows the event that
    /// marks the new one active; `inner` is not held while the frame is
    /// serialised and dispatched.
    pub(super) fn emit_frame(&self, generation: u64, frame: &Frame) -> bool {
        let _order = lock(&self.emit_order);
        let current = lock(&self.inner)
            .active
            .as_ref()
            .is_some_and(|a| a.generation == generation);
        if current {
            self.emit.frame(&self.sid, frame);
        }
        current
    }

    /// The webview painted or dropped frame `seq`.
    pub(super) fn frame_ack(&self, seq: u64) {
        self.frames.ack(seq);
    }

    /// Make Chromium send a fresh frame of the shown page: its screencast
    /// only sends on change, so a change it missed (an overlay removed
    /// around a capture) would otherwise stay on screen. Best effort; call
    /// it holding no view lock.
    pub(in crate::browser) fn refresh_frame(&self) {
        let _switching = lock(&self.switch);
        if let Some((session, size)) = self.shown_page() {
            let _ = self.restart_screencast(&session, size);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::thread;

    use super::*;

    fn frame(n: u32) -> Frame {
        Frame::new(format!("frame{n}"), n, n)
    }

    fn ack(id: i64) -> Option<ChromiumAck> {
        chromium_ack("s", &json!({ "sessionId": id }))
    }

    fn numbered(n: u32, seq: u64) -> Frame {
        Frame { seq, ..frame(n) }
    }

    /// `next` on a thread, so a test can see that it waits.
    fn next_on_thread(flow: &Arc<FrameFlow>) -> mpsc::Receiver<Option<Step>> {
        let (tx, rx) = mpsc::channel();
        let flow = Arc::clone(flow);
        thread::spawn(move || tx.send(flow.next()).unwrap());
        rx
    }

    #[test]
    fn no_frame_is_emitted_until_the_webview_acks_and_the_latest_wins() {
        let flow = Arc::new(FrameFlow::with_ack_timeout(Duration::from_secs(30)));
        flow.put(1, frame(1), ack(1));
        let first = flow.next().unwrap();
        assert_eq!(first.frame, Some((1, numbered(1, 1))));
        assert!(
            first.acks.is_empty(),
            "Chromium's ack waits for the webview"
        );
        for n in 2..=4 {
            flow.put(1, frame(n), ack(i64::from(n)));
        }
        let second = next_on_thread(&flow);
        assert!(
            second.recv_timeout(Duration::from_millis(200)).is_err(),
            "frame 1 is still in flight"
        );
        flow.ack(7);
        assert!(
            second.recv_timeout(Duration::from_millis(200)).is_err(),
            "an ack of another frame changes nothing"
        );
        flow.ack(1);
        let step = second
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert_eq!(step.frame, Some((1, numbered(4, 2))), "2 and 3 skipped");
        let acked: Vec<_> = [2, 3, 1].into_iter().filter_map(ack).collect();
        assert_eq!(step.acks, acked, "skipped and painted frames are acked now");
    }

    #[test]
    fn a_lost_ack_times_out() {
        let timeout = Duration::from_millis(300);
        let flow = Arc::new(FrameFlow::with_ack_timeout(timeout));
        flow.put(1, frame(1), ack(1));
        let sent = Instant::now();
        flow.next().unwrap();
        flow.put(1, frame(2), ack(2));
        let step = flow.next().unwrap();
        assert!(sent.elapsed() >= timeout, "{:?}", sent.elapsed());
        assert_eq!(step.frame, Some((1, numbered(2, 2))));
        assert_eq!(step.acks, ack(1).into_iter().collect::<Vec<_>>());
    }

    #[test]
    fn an_ack_with_nothing_waiting_still_releases_chromium() {
        let flow = FrameFlow::with_ack_timeout(Duration::from_secs(30));
        flow.put(3, frame(1), ack(1));
        flow.next().unwrap();
        flow.ack(1);
        assert_eq!(
            flow.next(),
            Some(Step {
                acks: ack(1).into_iter().collect(),
                frame: None
            })
        );
        flow.put(1, frame(2), ack(2));
        flow.clear();
        flow.put(4, frame(3), None);
        let step = flow.next().unwrap();
        assert_eq!(
            step.frame,
            Some((4, numbered(3, 2))),
            "a cleared frame is gone, the activation stays with its frame"
        );
        assert_eq!(step.acks, ack(2).into_iter().collect::<Vec<_>>());
    }

    #[test]
    fn closing_wakes_a_waiting_emitter() {
        let flow = Arc::new(FrameFlow::default());
        let waiting = next_on_thread(&flow);
        assert!(waiting.recv_timeout(Duration::from_millis(50)).is_err());
        flow.close();
        assert_eq!(waiting.recv_timeout(Duration::from_secs(5)).unwrap(), None);
        flow.put(1, frame(1), None);
        assert_eq!(flow.next(), None, "closed stays closed");
    }
}
