//! Busy / dialog / background-work state for every agent process, including
//! background tabs. The reader reuses its parsed frame; callbacks must only
//! enqueue work.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

const MAX_ID_BYTES: usize = 256;
const MAX_OPEN_QUESTIONS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    QuestionOpened,
    TurnFinished { ran: Duration },
}

/// Called after a committed change, with neither tracker mutex held.
/// Implementations must enqueue rather than perform I/O or blocking work.
pub trait TrackerSink: Send + Sync {
    fn changed(&self, sid: &str, t: Option<Transition>);
}

/// Stamp for a newly opened question. One sequence for the whole process,
/// so a tab respawned under the same id continues upward instead of
/// restarting at 1 — a watcher never mistakes an old count for a new ask.
static ASK_OPEN_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct SessionState {
    busy: bool,
    turn_started: Option<Instant>,
    open: HashSet<String>,
    /// `ASK_OPEN_SEQ` stamp of the last question opened in this session.
    asks_opened: u64,
    /// omp reports background work (an async job) that can still wake the
    /// session after it yielded.
    background: bool,
}

/// One session as the webview and the phones see it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub busy: bool,
    pub asks: usize,
    /// Rising with every question opened here, independent of how many are
    /// still open: answering one while another opens in the same batch
    /// leaves `asks` unchanged but raises this. Carries no prompt content.
    pub asks_opened: u64,
    pub background: bool,
}

pub type Snapshot = HashMap<String, SessionSnapshot>;

/// What the webview receives after every committed change: all sessions plus
/// a monotonic revision. A snapshot older than the last applied one is
/// ignored, so an initial `attention_snapshot` reply racing live events
/// cannot roll the tab dots (or a dock bounce) back.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionSnapshot {
    pub revision: u64,
    pub sessions: Snapshot,
}

#[derive(Default)]
pub struct Tracker {
    inner: Mutex<HashMap<String, SessionState>>,
    snapshot: RwLock<Arc<AttentionSnapshot>>,
    sink: Mutex<Option<Arc<dyn TrackerSink>>>,
}

/// The frames that change tracked state; everything else is ignored.
enum Event<'a> {
    Start,
    End { awaiting: Option<bool> },
    Settled,
    AsyncWork(bool),
    Open(&'a str),
    Cancel(&'a str),
}

impl<'a> Event<'a> {
    fn classify(frame_type: Option<&str>, frame: Option<&'a Value>) -> Option<Self> {
        match frame_type? {
            "agent_start" => Some(Self::Start),
            "agent_end" => Self::yields(frame).then(|| Self::End {
                awaiting: frame
                    .and_then(|end| end.get("awaitingAsyncWork"))
                    .and_then(Value::as_bool),
            }),
            "session_settled" => Some(Self::Settled),
            // The active tab asks for `get_state` on every activation and
            // `agent_end`; its `hasPendingAsyncWork` is the same flag the
            // webview's `asyncPending` uses. Background tabs keep the last
            // value until `session_settled` (or a yielding `agent_end` that
            // names `awaitingAsyncWork`).
            "response" => {
                let frame = frame?;
                if frame.get("command").and_then(Value::as_str) != Some("get_state") {
                    return None;
                }
                frame
                    .get("data")
                    .and_then(|data| data.get("hasPendingAsyncWork"))
                    .and_then(Value::as_bool)
                    .map(Self::AsyncWork)
            }
            "extension_ui_request" => {
                let frame = frame?;
                let text = |key: &str| frame.get(key).and_then(Value::as_str);
                match text("method")? {
                    "cancel" => text("targetId")
                        .filter(|id| id.len() <= MAX_ID_BYTES)
                        .map(Self::Cancel),
                    "select" | "confirm" | "input" | "editor" | "ask" => text("id")
                        .filter(|id| id.len() <= MAX_ID_BYTES)
                        .map(Self::Open),
                    _ => None,
                }
            }
            _ => None,
        }
    }

    /// Whether an `agent_end` hands control back (`yielded`, else `isTerminal`,
    /// else yes); one that continues into another run changes nothing.
    fn yields(end: Option<&Value>) -> bool {
        let flag = |key: &str| end.and_then(|end| end.get(key)).and_then(Value::as_bool);
        flag("yielded")
            .or_else(|| flag("isTerminal"))
            .unwrap_or(true)
    }
}

/// What applying an event did to the state.
enum Outcome {
    /// Nothing changed; nothing to announce.
    Unchanged,
    /// A committed change, announced with this transition (if it has one).
    Changed(Option<Transition>),
}

impl Outcome {
    const fn when(changed: bool, transition: Option<Transition>) -> Self {
        if changed {
            Self::Changed(transition)
        } else {
            Self::Unchanged
        }
    }
}

/// Apply `event` to `sid`'s state.
fn apply(
    sessions: &mut HashMap<String, SessionState>,
    sid: &str,
    event: Event<'_>,
    now: Instant,
) -> Outcome {
    match event {
        Event::Cancel(target) => {
            let removed = sessions
                .get_mut(sid)
                .is_some_and(|state| state.open.remove(target));
            Outcome::when(removed, None)
        }
        Event::Start => {
            if let Some(state) = sessions.get_mut(sid) {
                // A continuation keeps the first start, so the turn's time is whole.
                if state.busy {
                    Outcome::Unchanged
                } else {
                    state.busy = true;
                    state.turn_started = Some(now);
                    // Running outranks background; the job that woke us is gone.
                    state.background = false;
                    Outcome::Changed(None)
                }
            } else {
                sessions.insert(
                    sid.to_owned(),
                    SessionState {
                        busy: true,
                        turn_started: Some(now),
                        ..SessionState::default()
                    },
                );
                Outcome::Changed(None)
            }
        }
        Event::End { awaiting } => {
            if let Some(state) = sessions.get_mut(sid) {
                let started = state.turn_started.take();
                let changed = state.busy
                    || !state.open.is_empty()
                    || awaiting.is_some_and(|v| v != state.background);
                state.busy = false;
                state.open.clear();
                // Without the field the following `get_state` settles it for
                // the active tab; a background tab keeps what it last
                // reported until `session_settled`.
                if let Some(awaiting) = awaiting {
                    state.background = awaiting;
                }
                let finished = started.map(|start| Transition::TurnFinished {
                    ran: now.saturating_duration_since(start),
                });
                Outcome::when(changed || finished.is_some(), finished)
            } else {
                Outcome::Unchanged
            }
        }
        Event::Settled => {
            if let Some(state) = sessions.get_mut(sid) {
                // Settling reports only that no background work can wake the
                // session; the run still owns busy, dialogs and turn timing.
                let changed = state.background;
                state.background = false;
                Outcome::when(changed, None)
            } else {
                Outcome::Unchanged
            }
        }
        Event::AsyncWork(background) => {
            if let Some(state) = sessions.get_mut(sid) {
                let changed = state.background != background;
                state.background = background;
                Outcome::when(changed, None)
            } else {
                sessions.insert(
                    sid.to_owned(),
                    SessionState {
                        background,
                        ..SessionState::default()
                    },
                );
                Outcome::when(true, None)
            }
        }
        Event::Open(id) => {
            let opened = if let Some(state) = sessions.get_mut(sid) {
                if state.open.len() < MAX_OPEN_QUESTIONS && state.open.insert(id.to_owned()) {
                    state.asks_opened = ASK_OPEN_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
                    true
                } else {
                    false
                }
            } else {
                let mut state = SessionState::default();
                state.open.insert(id.to_owned());
                state.asks_opened = ASK_OPEN_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
                sessions.insert(sid.to_owned(), state);
                true
            };
            Outcome::when(opened, Some(Transition::QuestionOpened))
        }
    }
}

impl Tracker {
    fn sessions(&self) -> Option<std::sync::MutexGuard<'_, HashMap<String, SessionState>>> {
        self.inner.lock().ok()
    }

    fn publish_snapshot(&self, changed_sid: (&str, Option<SessionSnapshot>)) {
        let (sid, entry) = changed_sid;
        let mut guard = self
            .snapshot
            .write()
            .unwrap_or_else(PoisonError::into_inner);
        let published = Arc::make_mut(&mut *guard);
        match entry {
            Some(value) => {
                if let Some(slot) = published.sessions.get_mut(sid) {
                    *slot = value;
                } else {
                    published.sessions.insert(sid.to_owned(), value);
                }
            }
            None => {
                published.sessions.remove(sid);
            }
        }
        // One step per committed change, so a coalesced fan-out event and an
        // `attention_snapshot` reply can be ordered against each other.
        published.revision += 1;
        drop(guard);
    }

    pub fn set_sink(&self, sink: Arc<dyn TrackerSink>) {
        let previous = {
            let Ok(mut slot) = self.sink.lock() else {
                return;
            };
            slot.replace(sink)
        };
        // A sink's destructor may own worker teardown; never run it under a lock.
        drop(previous);
    }

    pub fn on_frame(
        &self,
        sid: &str,
        frame_type: Option<&str>,
        frame: Option<&Value>,
        now: Instant,
        alive: &AtomicBool,
    ) {
        // Stream deltas and all non-dialog extension traffic take no lock.
        let Some(event) = Event::classify(frame_type, frame) else {
            return;
        };
        self.mutate_live(sid, alive, |sessions| apply(sessions, sid, event, now));
    }

    pub fn on_answered(&self, sid: &str, id: &str, alive: &AtomicBool) {
        if id.len() > MAX_ID_BYTES {
            return;
        }
        self.mutate_live(sid, alive, |sessions| {
            let removed = sessions
                .get_mut(sid)
                .is_some_and(|state| state.open.remove(id));
            Outcome::when(removed, None)
        });
    }

    fn mutate_live(
        &self,
        sid: &str,
        alive: &AtomicBool,
        change: impl FnOnce(&mut HashMap<String, SessionState>) -> Outcome,
    ) {
        let outcome = {
            let Some(mut sessions) = self.sessions() else {
                return;
            };
            // A reader retired under this id must not touch state a replacement
            // owns; checked under the lock so the retirement cannot slip between.
            if !alive.load(Ordering::Acquire) {
                return;
            }
            let outcome = change(&mut sessions);
            if matches!(outcome, Outcome::Changed(_)) {
                let entry = sessions.get(sid).map(|state| SessionSnapshot {
                    busy: state.busy,
                    asks: state.open.len(),
                    asks_opened: state.asks_opened,
                    background: state.background,
                });
                self.publish_snapshot((sid, entry));
            }
            outcome
        };
        if let Outcome::Changed(transition) = outcome {
            self.notify(sid, transition);
        }
    }

    pub fn on_exit(&self, sid: &str) {
        let removed = {
            let Some(mut sessions) = self.sessions() else {
                return;
            };
            let removed = sessions.remove(sid);
            if removed.is_some() {
                self.publish_snapshot((sid, None));
            }
            removed
        };
        if removed.is_some() {
            self.notify(sid, None);
        }
    }

    pub fn snapshot(&self) -> Arc<AttentionSnapshot> {
        let guard = self.snapshot.read().unwrap_or_else(PoisonError::into_inner);
        Arc::clone(&*guard)
    }

    fn notify(&self, sid: &str, transition: Option<Transition>) {
        let sink = {
            let Ok(slot) = self.sink.lock() else {
                return;
            };
            // Keep this sink alive even if another thread replaces the slot.
            slot.as_ref().map(Arc::clone)
        };
        if let Some(sink) = sink {
            sink.changed(sid, transition);
        }
    }
}

pub fn tracker() -> &'static Tracker {
    static TRACKER: LazyLock<Tracker> = LazyLock::new(Tracker::default);
    &TRACKER
}

#[cfg(test)]
#[path = "tracker_tests.rs"]
mod tests;
