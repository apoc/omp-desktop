//! The core driver loop.
//!
//! One thread owns the scheduler, the daily token budget, the inbox and the
//! Ompy `omp` session. The socket server feeds it [`CoreMsg::Inbound`]
//! messages and the session's reader thread feeds it [`CoreMsg::Session`]
//! events; the loop turns those into wake-up prompts, inbox items and status
//! broadcasts.

mod inbound;
mod lifecycle;
mod store;

use crate::budget::{Budget, BudgetState};
use crate::inbox::Inbox;
use crate::paths::{ensure_private_dir, Paths};
use crate::scheduler::{Event, Now, Scheduled, Scheduler};
use crate::server::{ConnId, Inbound, Outbound};
use crate::session::{Launch, Session, SessionEvent};
use omp_desktop_core::approval::RuleBook;
use omp_desktop_core::persona_protocol::{
    ClientKind, ItemKind, PersonaSettings, ServerMsg, StatusInfo,
};
use serde_json::json;
use std::collections::HashMap;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use lifecycle::RESTART_MIN;
use store::{load_budget, read_json, Writes};

/// Generation number of the first session a core spawns. Every session event
/// carries the generation of the session that produced it.
pub const FIRST_GENERATION: u64 = 1;

const NOTICE_STARTUP_EXPIRED: &str = "Open approvals from the previous run expired";

/// One event the server or the session host hands to the core thread.
pub enum CoreMsg {
    /// A client completed the handshake; `out` writes to that connection.
    Connected {
        /// Connection the client reached the core on.
        conn: ConnId,
        /// Sender to that connection's writer thread.
        out: Outbound,
        /// Whether the app UI or an extension connected.
        client: ClientKind,
    },
    /// A parsed client message.
    Inbound(Inbound),
    /// The client closed the connection.
    Disconnected(ConnId),
    /// One event from the session spawned as generation `gen`.
    Session {
        /// Session generation that produced the event.
        gen: u64,
        /// What the session did.
        ev: SessionEvent,
    },
    /// The core's timer fired (also the scheduler's own deadline).
    Tick,
    /// A restart delay elapsed; spawn omp again.
    Restart,
    /// Stop the loop and kill the session.
    Shutdown,
}

/// Where the service stands, as shown in [`StatusInfo::state`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    /// Before the first session spawn attempt.
    Starting,
    /// The session runs and wake-ups are enabled.
    Running,
    /// The user paused wake-ups.
    Paused,
    /// Today's token limit is used up.
    BudgetExhausted,
    /// The last spawn failed; a restart is pending.
    Error(String),
}

impl State {
    /// The wire string written to [`StatusInfo::state`].
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::BudgetExhausted => "budget_exhausted",
            Self::Error(_) => "error",
        }
    }

    /// The reason when this is [`State::Error`].
    #[must_use]
    pub fn error(&self) -> Option<String> {
        match self {
            Self::Error(error) => Some(error.clone()),
            _ => None,
        }
    }
}

/// One connected client.
struct Conn {
    out: Outbound,
    /// Whether the client asked for the live omp frames.
    attached: bool,
    client: ClientKind,
}

/// The persona core. See the module documentation.
pub struct Core {
    paths: Paths,
    launch: Launch,
    rules: Arc<RuleBook>,
    clock: Box<dyn Fn() -> Now + Send>,
    settings: PersonaSettings,
    scheduler: Scheduler,
    budget: Budget,
    inbox: Inbox,
    session: Option<Session>,
    conns: HashMap<ConnId, Conn>,
    writes: Writes,
    paused: bool,
    spawn_error: Option<String>,
    started: bool,
    gen: u64,
    backoff: Duration,
    last_spawn: Instant,
    tx: Option<Sender<CoreMsg>>,
}

impl Core {
    /// Build the core from the state files under `paths`. A missing file means
    /// defaults; a corrupt one is reported in the inbox from now on, but is
    /// not overwritten until the corresponding message changes it.
    #[must_use]
    pub fn new(paths: Paths, launch: Launch, clock: Box<dyn Fn() -> Now + Send>) -> Self {
        let now = clock();
        if let Err(error) = ensure_private_dir(&paths.persona) {
            eprintln!(
                "[omp-desktopd] could not create {}: {error}",
                paths.persona.display()
            );
        }
        let (settings, settings_ok) = read_json::<PersonaSettings>(&paths.settings, "settings");
        let (wakes, wakes_ok) = read_json::<Vec<Scheduled>>(&paths.schedule, "schedule");
        let (mut inbox, inbox_notice) = Inbox::load(paths.inbox.clone(), now.utc_ms);
        let (mut budget, budget_notice, budget_writable) = load_budget(&paths.budget, &now);
        budget.roll(now.local.date());
        budget.set_limit(settings.daily_token_limit);
        let mut notices: Vec<String> = Vec::new();
        if let Some(notice) = inbox_notice {
            notices.push(notice);
        }
        if !settings_ok {
            notices.push("Settings file was unreadable; using defaults".into());
        }
        if !wakes_ok {
            notices.push("Schedule file was unreadable; using an empty schedule".into());
        }
        if let Some(notice) = budget_notice {
            notices.push(notice);
        }
        if inbox.expire_all_bound() > 0 {
            notices.push(NOTICE_STARTUP_EXPIRED.into());
        }
        for title in notices {
            inbox.add(
                ItemKind::Notice,
                title,
                None,
                Vec::new(),
                false,
                None,
                now.utc_ms,
            );
        }
        let mut scheduler = Scheduler::new(&settings, wakes, &now);
        scheduler.handle(
            Event::BudgetExhausted(budget.state() == BudgetState::Exhausted),
            &now,
        );
        let mut core = Self {
            rules: Arc::new(RuleBook::new(paths.rules.clone())),
            clock,
            settings,
            scheduler,
            budget,
            inbox,
            session: None,
            conns: HashMap::new(),
            writes: Writes {
                settings: settings_ok,
                schedule: wakes_ok,
                budget: budget_writable,
            },
            paused: false,
            spawn_error: None,
            started: false,
            gen: 0,
            backoff: RESTART_MIN,
            last_spawn: Instant::now(),
            tx: None,
            launch,
            paths,
        };
        core.persist_inbox(now.utc_ms);
        core.persist_budget();
        core
    }

    /// The wire status of the service right now.
    #[must_use]
    fn status_info(&self) -> StatusInfo {
        let state = self.state();
        StatusInfo {
            state: state.as_str().to_owned(),
            error: state.error(),
            next_wake_ms: self.scheduler.next_deadline(),
            tokens_today: self.budget.used,
            daily_token_limit: self.budget.limit,
            open_items: self.inbox.open_count(),
            settings: self.settings.clone(),
        }
    }

    /// The state derived from the pause flag, the budget and the last spawn.
    #[must_use]
    fn state(&self) -> State {
        self.spawn_error.as_ref().map_or_else(
            || {
                if !self.started {
                    State::Starting
                } else if self.paused {
                    State::Paused
                } else if self.budget.state() == crate::budget::BudgetState::Exhausted {
                    State::BudgetExhausted
                } else {
                    State::Running
                }
            },
            |error| State::Error(error.clone()),
        )
    }

    /// Report the current status to every app connection.
    fn broadcast_status(&mut self) {
        let msg = ServerMsg::Status {
            status: self.status_info(),
        };
        self.send_to_apps(&msg);
    }

    /// Report the inbox to every app connection.
    fn broadcast_inbox(&mut self) {
        let msg = ServerMsg::Inbox {
            items: self.inbox.items().to_vec(),
        };
        self.send_to_apps(&msg);
    }

    /// Queue `msg` for every app client, dropping the ones whose outbound
    /// queue overflowed.
    fn send_to_apps(&mut self, msg: &ServerMsg) {
        let full: Vec<ConnId> = self
            .conns
            .iter()
            .filter(|(_, conn)| conn.client == ClientKind::App && !conn.out.send(msg))
            .map(|(id, _)| *id)
            .collect();
        self.drop_conns(full);
    }

    /// Queue `msg` for one connection, dropping it when its outbound queue is
    /// full.
    fn send_to(&mut self, conn: ConnId, msg: &ServerMsg) {
        if self.conns.get(&conn).is_some_and(|c| !c.out.send(msg)) {
            self.drop_conns([conn]);
        }
    }

    /// Drop the connections in `conns`. The core never blocks on a client:
    /// a queue that reached its byte budget closes the socket instead.
    fn drop_conns(&mut self, conns: impl IntoIterator<Item = ConnId>) {
        for conn in conns {
            if let Some(gone) = self.conns.remove(&conn) {
                eprintln!("[omp-desktopd] dropping connection {conn}: outbound queue full");
                gone.out.close();
            }
        }
    }

    /// Prune the inbox, persist it and tell the app about the change.
    fn inbox_changed(&mut self, now: &Now) {
        self.persist_inbox(now.utc_ms);
        self.broadcast_inbox();
        self.broadcast_status();
    }

    /// Add `title` as an inbox notice and publish the result.
    fn notice(&mut self, title: &str, now: &Now) {
        self.inbox.add(
            ItemKind::Notice,
            title.to_owned(),
            None,
            Vec::new(),
            false,
            None,
            now.utc_ms,
        );
        self.inbox_changed(now);
    }

    /// Whether a down session or an open bound inbox item blocks wake-ups.
    fn blocked(&self) -> bool {
        self.session.is_none() || self.inbox.has_open_bound()
    }

    /// Write one frame to the session. Returns whether it was handed to omp.
    fn send_frame(&self, frame: &str) -> bool {
        let Some(session) = &self.session else {
            return false;
        };
        if let Err(error) = session.send(frame) {
            eprintln!("[omp-desktopd] could not write to omp: {error}");
            return false;
        }
        true
    }

    /// Send `message` as a `prompt` frame that queues behind a running turn.
    fn send_prompt(&self, message: &str) -> bool {
        self.send_frame(&prompt_frame(message))
    }

    /// The deadline the loop sleeps until: the scheduler's next wake or, while
    /// the budget is exhausted and the persona is not paused, the next local
    /// midnight so the day rolls over without waiting for a message.
    fn deadline(&self, now: &Now) -> Option<i64> {
        sleep_deadline(
            self.scheduler.next_deadline(),
            self.paused,
            self.budget.state() == BudgetState::Exhausted,
            now,
        )
    }

    /// The blocking loop: sleeps until the scheduler's next deadline or the
    /// next message, then handles one message.
    // The loop owns the receiver and reads it until it disconnects; taking it
    // by value keeps the planned `run(self, rx, tx)` signature.
    #[allow(clippy::needless_pass_by_value)]
    pub fn run(mut self, rx: Receiver<CoreMsg>, tx: Sender<CoreMsg>) {
        self.tx = Some(tx);
        let now = (self.clock)();
        self.start_session(&now);
        loop {
            let now = (self.clock)();
            let msg = match self.deadline(&now) {
                Some(due) if due <= now.utc_ms => CoreMsg::Tick,
                Some(due) => {
                    let wait = Duration::from_millis(wait_ms(due, now.utc_ms));
                    match rx.recv_timeout(wait) {
                        Ok(msg) => msg,
                        Err(RecvTimeoutError::Timeout) => CoreMsg::Tick,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                None => match rx.recv() {
                    Ok(msg) => msg,
                    Err(_) => return,
                },
            };
            let now = (self.clock)();
            self.roll_budget(&now);
            match msg {
                CoreMsg::Shutdown => {
                    self.shutdown();
                    return;
                }
                CoreMsg::Tick => self.on_tick(&now),
                CoreMsg::Restart => self.start_session(&now),
                CoreMsg::Connected { conn, out, client } => {
                    self.conns.insert(
                        conn,
                        Conn {
                            out,
                            attached: false,
                            client,
                        },
                    );
                    if client == ClientKind::App {
                        self.broadcast_status();
                        self.broadcast_inbox();
                    }
                }
                CoreMsg::Disconnected(conn) => {
                    self.conns.remove(&conn);
                }
                CoreMsg::Inbound(inbound) => self.on_inbound(inbound, &now),
                CoreMsg::Session { gen, ev } => self.on_session(gen, ev, &now),
            }
        }
    }

    fn shutdown(&mut self) {
        if let Some(mut session) = self.session.take() {
            session.kill();
        }
    }
}

/// Milliseconds from `now_ms` until `due_ms`, never negative.
fn wait_ms(due_ms: i64, now_ms: i64) -> u64 {
    u64::try_from(due_ms.saturating_sub(now_ms)).unwrap_or(0)
}

/// The soonest deadline the loop should sleep until. While the budget is
/// exhausted (and the persona is not paused) the next local midnight is
/// always a candidate, so the day rolls over even when the scheduler has no
/// deadline of its own.
fn sleep_deadline(scheduler: Option<i64>, paused: bool, exhausted: bool, now: &Now) -> Option<i64> {
    if paused || !exhausted {
        return scheduler;
    }
    let midnight = next_local_midnight_ms(now);
    Some(scheduler.map_or(midnight, |due| due.min(midnight)))
}

/// Milliseconds since the epoch of the next local midnight after `now`.
const fn next_local_midnight_ms(now: &Now) -> i64 {
    let Some(tomorrow) = now.local.date().succ_opt() else {
        return now.utc_ms;
    };
    let Some(midnight) = tomorrow.and_hms_opt(0, 0, 0) else {
        return now.utc_ms;
    };
    let delta = midnight.signed_duration_since(now.local);
    now.utc_ms.saturating_add(delta.num_milliseconds())
}

/// A `prompt` frame that queues behind whatever omp is doing.
fn prompt_frame(message: &str) -> String {
    json!({
        "type": "prompt",
        "message": message,
        "streamingBehavior": "followUp",
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn now(d: u32, h: u32, m: u32) -> Now {
        let local = NaiveDate::from_ymd_opt(2026, 11, d)
            .unwrap()
            .and_hms_opt(h, m, 0)
            .unwrap();
        Now {
            utc_ms: local.and_utc().timestamp_millis(),
            local,
        }
    }

    #[test]
    fn new_rolls_and_persists_a_stale_exhausted_budget() {
        let root =
            std::env::temp_dir().join(format!("ompy-core-new-budget-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let paths = Paths::under(&root);
        ensure_private_dir(&paths.persona).unwrap();
        std::fs::write(
            &paths.budget,
            br#"{"limit":2000000,"day":"2026-11-15","used":2000000}"#,
        )
        .unwrap();
        let start = now(16, 9, 0);
        let launch = Launch {
            program: "unused".into(),
            home: root.clone(),
            sessions: paths.sessions.clone(),
            extension: root.join("e.mjs"),
            instructions: root.join("i.md"),
            socket_env: "x".into(),
            env: Vec::new(),
        };
        let mut core = Core::new(paths.clone(), launch, Box::new(move || start));

        assert_eq!(core.budget.day, start.local.date());
        assert_eq!(core.budget.used, 0);
        let persisted: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&paths.budget).unwrap()).unwrap();
        assert_eq!(persisted["day"], "2026-11-16");
        assert_eq!(persisted["used"], 0);
        assert_eq!(
            core.scheduler.handle(Event::Tick, &now(16, 9, 31)),
            Some(crate::scheduler::WakeReason::Interval)
        );
    }

    #[test]
    fn full_outbound_queue_drops_the_connection() {
        let root = std::env::temp_dir().join(format!("ompy-core-drop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let paths = Paths::under(&root);
        ensure_private_dir(&paths.persona).unwrap();
        let start = now(16, 9, 0);
        let launch = Launch {
            program: "unused".into(),
            home: root.clone(),
            sessions: paths.sessions.clone(),
            extension: root.join("e.mjs"),
            instructions: root.join("i.md"),
            socket_env: "x".into(),
            env: Vec::new(),
        };
        let mut core = Core::new(paths, launch, Box::new(move || start));
        let (out_tx, _out_rx) = std::sync::mpsc::channel();
        core.conns.insert(
            1,
            Conn {
                // A zero-byte budget refuses the very first message.
                out: Outbound::new(out_tx, 0),
                attached: false,
                client: ClientKind::App,
            },
        );
        core.broadcast_status();
        assert!(
            core.conns.is_empty(),
            "the overflowing connection must be dropped"
        );
    }

    #[test]
    fn exhausted_budget_sleeps_until_local_midnight() {
        let t = now(16, 23, 30);
        let midnight = now(17, 0, 0).utc_ms;
        assert_eq!(next_local_midnight_ms(&t), midnight);
        assert_eq!(sleep_deadline(None, false, true, &t), Some(midnight));
        assert_eq!(
            sleep_deadline(Some(midnight + 1), false, true, &t),
            Some(midnight),
            "midnight wins over a later scheduler deadline"
        );
        assert_eq!(
            sleep_deadline(Some(midnight - 1), false, true, &t),
            Some(midnight - 1),
            "an earlier scheduler deadline wins"
        );
        assert_eq!(
            sleep_deadline(None, true, true, &t),
            None,
            "a paused persona has no midnight timer"
        );
        assert_eq!(
            sleep_deadline(Some(42), false, false, &t),
            Some(42),
            "a budget with tokens left leaves the scheduler alone"
        );
    }
}
