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

use crate::budget::Budget;
use crate::inbox::Inbox;
use crate::paths::{ensure_private_dir, Paths};
use crate::scheduler::{Now, Scheduled, Scheduler};
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
        let (mut budget, budget_ok) = load_budget(&paths.budget, &now);
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
        if !budget_ok {
            notices.push("Budget file was unreadable; today's counter starts at zero".into());
        }
        if inbox.expire_all_bound() > 0 {
            notices.push(NOTICE_STARTUP_EXPIRED.into());
        }
        let had_notices = !notices.is_empty();
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
        let scheduler = Scheduler::new(&settings, wakes, &now);
        let core = Self {
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
                budget: budget_ok,
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
        if had_notices {
            core.persist_inbox();
        }
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
    fn broadcast_status(&self) {
        for conn in self.conns.values() {
            if conn.client == ClientKind::App {
                let _ = conn.out.send(ServerMsg::Status {
                    status: self.status_info(),
                });
            }
        }
    }

    /// Report the inbox to every app connection.
    fn broadcast_inbox(&self) {
        for conn in self.conns.values() {
            if conn.client == ClientKind::App {
                let _ = conn.out.send(ServerMsg::Inbox {
                    items: self.inbox.items().to_vec(),
                });
            }
        }
    }

    /// Broadcast the inbox after a change and tell the app about the new count.
    fn inbox_changed(&self) {
        self.persist_inbox();
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
        self.inbox_changed();
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
            let msg = match self.scheduler.next_deadline() {
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

/// A `prompt` frame that queues behind whatever omp is doing.
fn prompt_frame(message: &str) -> String {
    json!({
        "type": "prompt",
        "message": message,
        "streamingBehavior": "followUp",
    })
    .to_string()
}
