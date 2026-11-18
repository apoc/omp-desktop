//! The omp session lifecycle: spawning, session events, budget rolling,
//! ticks, wake-ups and restarts.

use super::{Core, CoreMsg};
use crate::budget::{BudgetEvent, Usage};
use crate::scheduler::{Event, Now, WakeReason};
use crate::session::{Session, SessionEvent};
use crate::wake;
use omp_desktop_core::persona_protocol::{ItemKind, ItemState, ServerMsg};
use serde_json::value::RawValue;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

/// First restart delay after omp stops; doubles up to [`RESTART_MAX`].
pub(super) const RESTART_MIN: Duration = Duration::from_secs(1);
/// Longest restart delay.
const RESTART_MAX: Duration = Duration::from_secs(300);
/// Uptime after which a restart counts as a fresh start and resets the backoff.
const RESTART_RESET: Duration = Duration::from_secs(60);

const NOTICE_EXPIRED: &str = "Ompy stopped unexpectedly; open approvals expired";
const NOTICE_WARNED: &str = "80 % of today's token limit used";
const NOTICE_EXHAUSTED: &str = "Daily token limit reached; Ompy pauses until midnight";

impl Core {
    /// Spawn omp for the next generation and forward its events to this loop.
    pub(super) fn start_session(&mut self, now: &Now) {
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
                self.last_spawn = std::time::Instant::now();
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
    pub(super) fn on_tick(&mut self, now: &Now) {
        if let Some(reason) = self.scheduler.handle(Event::Tick, now) {
            if matches!(reason, WakeReason::Scheduled { .. }) {
                self.persist_schedule();
            }
            self.wake(&reason, now);
        }
    }

    /// Send one wake-up prompt and publish the resulting busy state.
    pub(super) fn wake(&mut self, reason: &WakeReason, now: &Now) {
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

    pub(super) fn on_session(&mut self, gen: u64, ev: SessionEvent, now: &Now) {
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
    pub(super) fn roll_budget(&mut self, now: &Now) {
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
}
