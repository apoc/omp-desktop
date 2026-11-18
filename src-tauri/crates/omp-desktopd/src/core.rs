//! The core driver loop.
//!
//! One thread owns the scheduler, the daily token budget, the inbox and the
//! Ompy `omp` session. The socket server feeds it [`CoreMsg::Inbound`]
//! messages and the session's reader thread feeds it [`CoreMsg::Session`]
//! events; the loop turns those into wake-up prompts, inbox items and status
//! broadcasts.

use crate::budget::{Budget, BudgetEvent, BudgetState, Usage};
use crate::inbox::Inbox;
use crate::paths::{ensure_private_dir, Paths};
use crate::scheduler::{Event, Now, ScheduleError, Scheduled, Scheduler, WakeReason};
use crate::server::{ConnId, Inbound, Outbound};
use crate::session::{Launch, Session, SessionEvent};
use crate::wake;
use chrono::{NaiveDate, NaiveTime};
use omp_desktop_core::approval::RuleBook;
use omp_desktop_core::json_store::write_atomic;
use omp_desktop_core::persona_protocol::{
    ClientKind, ClientMsg, ItemKind, ItemState, NotifyKind, PersonaSettings, ServerMsg, StatusInfo,
};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::value::RawValue;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::Path;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Generation number of the first session a core spawns. Every session event
/// carries the generation of the session that produced it.
pub const FIRST_GENERATION: u64 = 1;

/// First restart delay after omp stops; doubles up to [`RESTART_MAX`].
const RESTART_MIN: Duration = Duration::from_secs(1);
/// Longest restart delay.
const RESTART_MAX: Duration = Duration::from_secs(300);
/// Uptime after which a restart counts as a fresh start and resets the backoff.
const RESTART_RESET: Duration = Duration::from_secs(60);

const NOTICE_EXPIRED: &str = "Ompy stopped unexpectedly; open approvals expired";
const NOTICE_STARTUP_EXPIRED: &str = "Open approvals from the previous run expired";
const NOTICE_WARNED: &str = "80 % of today's token limit used";
const NOTICE_EXHAUSTED: &str = "Daily token limit reached; Ompy pauses until midnight";

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

/// Which state files may be written. A file that could not be read at startup
/// stays untouched until the next successful write of its owning message, so a
/// corrupt file is never silently replaced by defaults.
#[derive(Debug, Clone, Copy)]
struct Writes {
    settings: bool,
    schedule: bool,
    budget: bool,
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
                } else if self.budget.state() == BudgetState::Exhausted {
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

    fn persist_inbox(&self) {
        if let Err(error) = self.inbox.save() {
            eprintln!("[omp-desktopd] could not save the inbox: {error}");
        }
    }

    fn persist_settings(&self) {
        if self.writes.settings {
            write_json(&self.paths.settings, &self.settings, "settings");
        }
    }

    fn persist_schedule(&self) {
        if self.writes.schedule {
            write_json(
                &self.paths.schedule,
                &self.scheduler.scheduled(),
                "schedule",
            );
        }
    }

    fn persist_budget(&self) {
        if self.writes.budget {
            write_json(&self.paths.budget, &self.budget, "budget");
        }
    }

    fn reply_ok(&self, conn: ConnId, req: Option<u64>, data: Option<Value>) {
        let Some(req) = req else {
            return;
        };
        if let Some(client) = self.conns.get(&conn) {
            let _ = client.out.send(ServerMsg::Reply {
                req,
                ok: true,
                data,
                error: None,
            });
        }
    }

    fn reply_err(&self, conn: ConnId, req: Option<u64>, error: &str) {
        let Some(req) = req else {
            return;
        };
        if let Some(client) = self.conns.get(&conn) {
            let _ = client.out.send(ServerMsg::Reply {
                req,
                ok: false,
                data: None,
                error: Some(error.into()),
            });
        }
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

    /// Spawn omp for the next generation and forward its events to this loop.
    fn start_session(&mut self, now: &Now) {
        let Some(tx) = self.tx.clone() else {
            return;
        };
        self.gen += 1;
        let gen = self.gen;
        let (events_tx, events_rx) = mpsc::channel();
        let _ = std::thread::Builder::new()
            .name("ompy-events".into())
            .spawn(move || {
                for ev in events_rx {
                    if tx.send(CoreMsg::Session { gen, ev }).is_err() {
                        break;
                    }
                }
            });
        match Session::spawn(&self.launch, Arc::clone(&self.rules), events_tx) {
            Ok(session) => {
                self.session = Some(session);
                self.last_spawn = Instant::now();
                self.spawn_error = None;
                self.started = true;
                self.broadcast_status();
            }
            Err(error) => {
                let message = format!("Ompy's omp process did not start: {error}");
                eprintln!("[omp-desktopd] {message}");
                self.session = None;
                self.spawn_error = Some(message.clone());
                self.started = true;
                self.inbox.add(
                    ItemKind::Notice,
                    message,
                    None,
                    Vec::new(),
                    true,
                    None,
                    now.utc_ms,
                );
                self.inbox_changed();
                let delay = self.restart_delay();
                self.schedule_restart(delay);
            }
        }
    }

    /// Reset and grow the restart backoff: 1 s doubling to 5 min, reset after
    /// a session stayed up for [`RESTART_RESET`].
    fn restart_delay(&mut self) -> Duration {
        if self.last_spawn.elapsed() >= RESTART_RESET {
            self.backoff = RESTART_MIN;
        }
        let delay = self.backoff;
        self.backoff = (delay * 2).min(RESTART_MAX);
        delay
    }

    /// Wake the loop after `delay` so it spawns omp again.
    fn schedule_restart(&self, delay: Duration) {
        let Some(tx) = self.tx.clone() else {
            return;
        };
        let _ = std::thread::Builder::new()
            .name("ompy-restart".into())
            .spawn(move || {
                std::thread::sleep(delay);
                let _ = tx.send(CoreMsg::Restart);
            });
    }

    /// The scheduler's periodic timer: fire the wake-up that came due.
    fn on_tick(&mut self, now: &Now) {
        if let Some(reason) = self.scheduler.handle(Event::Tick, now) {
            if matches!(reason, WakeReason::Scheduled { .. }) {
                self.persist_schedule();
            }
            self.wake(&reason, now);
        }
    }

    /// Send one wake-up prompt and publish the resulting busy state.
    fn wake(&mut self, reason: &WakeReason, now: &Now) {
        let decisions: Vec<String> = self
            .inbox
            .items()
            .iter()
            .filter(|item| item.kind == ItemKind::Decision && item.state == ItemState::Open)
            .map(|item| item.title.clone())
            .collect();
        let tokens_left = self.budget.limit.saturating_sub(self.budget.used);
        let message = wake::prompt(reason, now.local, tokens_left, &decisions);
        if !self.send_prompt(&message) {
            self.scheduler.handle(Event::Busy(false), now);
        }
        self.broadcast_status();
    }

    fn on_session(&mut self, gen: u64, ev: SessionEvent, now: &Now) {
        if gen != self.gen {
            return;
        }
        match ev {
            SessionEvent::Frame { seq, raw } => self.relay_frame(seq, &raw),
            SessionEvent::Usage(usage) => self.on_usage(&usage, now),
            SessionEvent::TurnStarted => {
                self.scheduler.handle(Event::Busy(true), now);
                self.broadcast_status();
            }
            SessionEvent::TurnEnded => {
                self.scheduler.handle(Event::Busy(false), now);
                self.broadcast_status();
            }
            SessionEvent::UiRequest {
                id,
                kind,
                title,
                body,
                options,
            } => {
                self.inbox
                    .add(kind, title, body, options, false, Some(id), now.utc_ms);
                self.scheduler.handle(Event::Blocked(true), now);
                self.inbox_changed();
            }
            SessionEvent::UiCancel { id } => {
                if self.inbox.expire_by_rpc(&id) {
                    self.inbox_changed();
                }
                let blocked = self.inbox.has_open_bound();
                self.scheduler.handle(Event::Blocked(blocked), now);
            }
            SessionEvent::AutoApproved { .. } => {}
            SessionEvent::Exited { reason } => self.on_exited(&reason, now),
        }
    }

    /// Forward one live frame to every attached connection.
    fn relay_frame(&self, seq: u64, raw: &str) {
        for conn in self.conns.values().filter(|conn| conn.attached) {
            if let Ok(frame) = RawValue::from_string(raw.to_owned()) {
                let _ = conn.out.send(ServerMsg::Rpc { seq, frame });
            }
        }
    }

    fn on_usage(&mut self, usage: &Usage, now: &Now) {
        let event = self.budget.add(usage, now.local.date());
        self.persist_budget();
        match event {
            Some(BudgetEvent::Warned) => self.notice(NOTICE_WARNED, now),
            Some(BudgetEvent::Exhausted) => {
                self.scheduler.handle(Event::BudgetExhausted(true), now);
                self.notice(NOTICE_EXHAUSTED, now);
            }
            Some(BudgetEvent::Reset) => {
                self.scheduler.handle(Event::BudgetExhausted(false), now);
                self.broadcast_status();
            }
            None => self.broadcast_status(),
        }
    }

    /// omp's stdout ended: expire its open requests and restart with backoff.
    fn on_exited(&mut self, reason: &str, now: &Now) {
        eprintln!("[omp-desktopd] omp stopped: {reason}");
        self.session = None;
        if self.inbox.expire_all_bound() > 0 {
            self.inbox.add(
                ItemKind::Notice,
                NOTICE_EXPIRED.into(),
                None,
                Vec::new(),
                false,
                None,
                now.utc_ms,
            );
        }
        self.scheduler.handle(Event::Blocked(false), now);
        self.scheduler.handle(Event::Busy(false), now);
        self.inbox_changed();
        let delay = self.restart_delay();
        self.schedule_restart(delay);
    }

    /// Roll the budget onto today's local day before handling a message.
    fn roll_budget(&mut self, now: &Now) {
        let today = now.local.date();
        if today == self.budget.day {
            return;
        }
        if self.budget.roll(today) == Some(BudgetEvent::Reset) {
            self.scheduler.handle(Event::BudgetExhausted(false), now);
        }
        self.persist_budget();
        self.broadcast_status();
    }

    fn on_inbound(&mut self, inbound: Inbound, now: &Now) {
        let Inbound { conn, req, msg, .. } = inbound;
        match msg {
            ClientMsg::Status => {
                let data = serde_json::to_value(self.status_info()).unwrap_or(Value::Null);
                self.reply_ok(conn, req, Some(data));
            }
            ClientMsg::Attach { after_seq } => {
                self.attach(conn, after_seq);
                self.reply_ok(conn, req, None);
            }
            ClientMsg::Detach => {
                if let Some(client) = self.conns.get_mut(&conn) {
                    client.attached = false;
                }
                self.reply_ok(conn, req, None);
            }
            ClientMsg::Rpc { frame } => self.on_rpc(conn, req, &frame, now),
            ClientMsg::Pause => {
                self.paused = true;
                self.scheduler.handle(Event::Paused(true), now);
                self.broadcast_status();
                self.reply_ok(conn, req, None);
            }
            ClientMsg::Resume => {
                self.paused = false;
                self.scheduler.handle(Event::Paused(false), now);
                self.broadcast_status();
                self.reply_ok(conn, req, None);
            }
            ClientMsg::WakeNow => {
                if let Some(reason) = self.scheduler.handle(Event::WakeNow, now) {
                    self.wake(&reason, now);
                }
                self.broadcast_status();
                self.reply_ok(conn, req, None);
            }
            ClientMsg::SetSettings { settings } => self.on_settings(conn, req, settings, now),
            ClientMsg::InboxResolve { id, answer } => {
                self.on_resolve(conn, req, &id, answer.as_deref(), now);
            }
            ClientMsg::ScheduleWake { at_ms, in_ms, note } => {
                self.on_schedule(conn, req, at_ms, in_ms, note, now);
            }
            ClientMsg::ListSchedule => {
                let data = json!({
                    "scheduled": self.scheduler.scheduled(),
                    "nextIntervalMs": self.scheduler.next_interval_ms(),
                });
                self.reply_ok(conn, req, Some(data));
            }
            ClientMsg::CancelWake { id } => self.on_cancel(conn, req, &id),
            ClientMsg::Notify {
                kind,
                title,
                body,
                options,
                urgent,
            } => self.on_notify(conn, req, kind, title, body, options, urgent, now),
            ClientMsg::Hello { .. } => self.reply_err(conn, req, "hello was already handled"),
        }
    }

    fn on_rpc(&mut self, conn: ConnId, req: Option<u64>, frame: &Value, now: &Now) {
        if frame.get("type").and_then(Value::as_str) == Some("extension_ui_response") {
            if let Some(id) = frame.get("id").and_then(Value::as_str) {
                if self
                    .inbox
                    .resolve_by_rpc(id, Some(ui_answer(frame)))
                    .is_some()
                {
                    let blocked = self.inbox.has_open_bound();
                    self.scheduler.handle(Event::Blocked(blocked), now);
                    self.inbox_changed();
                }
            }
        }
        if self.send_frame(&frame.to_string()) {
            self.reply_ok(conn, req, None);
        } else {
            self.reply_err(conn, req, "Ompy is not running");
        }
    }

    fn on_settings(
        &mut self,
        conn: ConnId,
        req: Option<u64>,
        settings: PersonaSettings,
        now: &Now,
    ) {
        if let Err(error) = validate(&settings) {
            self.reply_err(conn, req, error);
            return;
        }
        self.settings = settings;
        self.writes.settings = true;
        self.writes.budget = true;
        self.persist_settings();
        self.scheduler
            .handle(Event::Settings(self.settings.clone()), now);
        if self.budget.set_limit(self.settings.daily_token_limit) == Some(BudgetEvent::Reset) {
            self.scheduler.handle(Event::BudgetExhausted(false), now);
        }
        self.persist_budget();
        self.broadcast_status();
        self.reply_ok(conn, req, None);
    }

    fn on_resolve(
        &mut self,
        conn: ConnId,
        req: Option<u64>,
        id: &str,
        answer: Option<&str>,
        now: &Now,
    ) {
        let Some(item) = self.inbox.resolve(id, answer.map(str::to_owned)) else {
            self.reply_err(conn, req, "no open inbox item with that id");
            return;
        };
        let mut told_omp = false;
        if let (Some(rpc), Some(answer)) = (item.rpc_request_id.as_deref(), answer) {
            self.respond(rpc, &item.options, answer);
            told_omp = true;
        } else if item.rpc_request_id.is_none() && item.kind == ItemKind::Decision {
            if let Some(answer) = answer {
                let message = format!("[ompy decision] {}: {answer}", item.title);
                self.send_prompt(&message);
                told_omp = true;
            }
        }
        if told_omp {
            let blocked = self.inbox.has_open_bound();
            self.scheduler.handle(Event::Blocked(blocked), now);
        }
        self.inbox_changed();
        self.reply_ok(conn, req, Some(json!({ "id": item.id })));
    }

    /// Answer omp's request `rpc` with `answer`; confirm prompts get a
    /// boolean.
    fn respond(&self, rpc: &str, options: &[String], answer: &str) {
        let confirm = options.len() == 2 && options[0] == "Confirm" && options[1] == "Deny";
        let frame = if confirm {
            json!({
                "type": "extension_ui_response",
                "id": rpc,
                "confirmed": answer == "Confirm",
            })
        } else {
            json!({
                "type": "extension_ui_response",
                "id": rpc,
                "value": answer,
            })
        };
        self.send_frame(&frame.to_string());
    }

    fn on_schedule(
        &mut self,
        conn: ConnId,
        req: Option<u64>,
        at_ms: Option<i64>,
        in_ms: Option<i64>,
        note: String,
        now: &Now,
    ) {
        let at = match (at_ms, in_ms) {
            (Some(at), None) => at,
            (None, Some(in_ms)) if in_ms > 0 => now.utc_ms.saturating_add(in_ms),
            (None, Some(_)) => {
                self.reply_err(conn, req, "inMs must be positive");
                return;
            }
            (None, None) => {
                self.reply_err(conn, req, "one of atMs or inMs is required");
                return;
            }
            (Some(_), Some(_)) => {
                self.reply_err(conn, req, "atMs and inMs are mutually exclusive");
                return;
            }
        };
        match self.scheduler.add(at, note, now) {
            Ok(id) => {
                self.writes.schedule = true;
                self.persist_schedule();
                self.broadcast_status();
                self.reply_ok(conn, req, Some(json!({ "id": id })));
            }
            Err(error) => self.reply_err(conn, req, schedule_error(error)),
        }
    }

    fn on_cancel(&mut self, conn: ConnId, req: Option<u64>, id: &str) {
        if self.scheduler.cancel(id) {
            self.writes.schedule = true;
            self.persist_schedule();
            self.broadcast_status();
            self.reply_ok(conn, req, None);
        } else {
            self.reply_err(conn, req, "no scheduled wake with that id");
        }
    }

    #[allow(clippy::too_many_arguments)] // One parameter per `ClientMsg::Notify` field plus `now`.
    fn on_notify(
        &mut self,
        conn: ConnId,
        req: Option<u64>,
        kind: NotifyKind,
        title: String,
        body: Option<String>,
        options: Option<Vec<String>>,
        urgent: bool,
        now: &Now,
    ) {
        let kind = match kind {
            NotifyKind::Result => ItemKind::Result,
            NotifyKind::Decision => ItemKind::Decision,
        };
        let id = self.inbox.add(
            kind,
            title,
            body,
            options.unwrap_or_default(),
            urgent,
            None,
            now.utc_ms,
        );
        self.inbox_changed();
        self.reply_ok(conn, req, Some(json!({ "id": id })));
    }

    /// Replay the frames stored after `after_seq` and then keep the connection
    /// on the live stream.
    fn attach(&mut self, conn: ConnId, after_seq: u64) {
        if let Some(client) = self.conns.get_mut(&conn) {
            client.attached = true;
        }
        let Some(session) = &self.session else {
            return;
        };
        for (seq, raw) in session.replay_after(after_seq) {
            if let Ok(frame) = RawValue::from_string(raw.to_string()) {
                if let Some(client) = self.conns.get(&conn) {
                    let _ = client.out.send(ServerMsg::Rpc { seq, frame });
                }
            }
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

/// The answer an `extension_ui_response` frame carries.
fn ui_answer(frame: &Value) -> String {
    if let Some(value) = frame.get("value").and_then(Value::as_str) {
        return value.to_owned();
    }
    match frame.get("confirmed").and_then(Value::as_bool) {
        Some(true) => "confirmed".to_owned(),
        Some(false) => "denied".to_owned(),
        None => "answered".to_owned(),
    }
}

/// The user-facing reason a schedule request was refused.
const fn schedule_error(error: ScheduleError) -> &'static str {
    match error {
        ScheduleError::TooMany => "at most 50 wakes may be queued",
        ScheduleError::InPast => "the wake time must be in the future",
        ScheduleError::TooFar => "the wake time must be within 30 days",
        ScheduleError::EmptyNote => "note must not be empty",
    }
}

/// Reject settings the app must not make.
fn validate(settings: &PersonaSettings) -> Result<(), &'static str> {
    if !(5..=1440).contains(&settings.interval_min) {
        return Err("intervalMin must be between 5 and 1440");
    }
    if NaiveTime::parse_from_str(&settings.quiet_start, "%H:%M").is_err() {
        return Err("quietStart must be HH:MM");
    }
    if NaiveTime::parse_from_str(&settings.quiet_end, "%H:%M").is_err() {
        return Err("quietEnd must be HH:MM");
    }
    if settings.daily_token_limit < crate::budget::MIN_LIMIT {
        return Err("dailyTokenLimit must be at least 100000");
    }
    Ok(())
}

/// Read a state file: `NotFound` is the default, a corrupt file is the default
/// plus `false` so the caller keeps it untouched.
fn read_json<T: DeserializeOwned + Default>(path: &Path, what: &str) -> (T, bool) {
    match std::fs::read(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => (T::default(), true),
        Err(error) => {
            eprintln!("[omp-desktopd] {what} file unreadable: {error}");
            (T::default(), false)
        }
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(value) => (value, true),
            Err(error) => {
                eprintln!("[omp-desktopd] {what} file corrupt: {error}");
                (T::default(), false)
            }
        },
    }
}

/// Write `value` as pretty JSON to `path` through the shared atomic writer.
/// A failed write is logged; the service keeps running on its in-memory state.
fn write_json<T: Serialize>(path: &Path, value: &T, what: &str) {
    let written = serde_json::to_vec_pretty(value)
        .map_err(std::io::Error::other)
        .and_then(|bytes| write_atomic(path, &bytes));
    if let Err(error) = written {
        eprintln!("[omp-desktopd] could not save {what}: {error}");
    }
}

/// Load today's budget. `Budget` has no `Default` because its counter belongs
/// to a day, so a missing or corrupt file starts a fresh counter for today.
fn load_budget(path: &Path, now: &Now) -> (Budget, bool) {
    let today: NaiveDate = now.local.date();
    match std::fs::read(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => (Budget::new(0, today), true),
        Err(error) => {
            eprintln!("[omp-desktopd] budget file unreadable: {error}");
            (Budget::new(0, today), false)
        }
        Ok(bytes) => match serde_json::from_slice::<Budget>(&bytes) {
            Ok(budget) => (budget, true),
            Err(error) => {
                eprintln!("[omp-desktopd] budget file corrupt: {error}");
                (Budget::new(0, today), false)
            }
        },
    }
}
