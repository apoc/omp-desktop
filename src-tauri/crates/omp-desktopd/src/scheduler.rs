//! When Ompy wakes up. Pure: no IO, no clock, no threads. The core feeds
//! events with the current time and gets at most one wake-up per call.

use chrono::{NaiveDateTime, NaiveTime};
use omp_desktop_core::persona_protocol::PersonaSettings;
use omp_desktop_core::persona_quiet;
use serde::{Deserialize, Serialize};

/// Most wakes the user may queue at once.
pub const MAX_SCHEDULED: usize = 50;
/// Furthest a wake may be queued ahead: 30 days.
pub const MAX_AHEAD_MS: i64 = 30 * 24 * 60 * 60 * 1000;

const MS_PER_MIN: i64 = 60_000;
const MIN_INTERVAL_MIN: u32 = 5;
const DEFAULT_QUIET_START: NaiveTime = persona_quiet::DEFAULT_QUIET_START;
const DEFAULT_QUIET_END: NaiveTime = persona_quiet::DEFAULT_QUIET_END;

/// The instant the core reports with every event: the UTC deadline clock plus
/// the local wall time that decides quiet hours.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Now {
    /// Milliseconds since the Unix epoch, UTC.
    pub utc_ms: i64,
    /// The same instant in local time.
    pub local: NaiveDateTime,
}

/// A wake the user (or omp) asked for at an absolute time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scheduled {
    /// Identifier handed back by [`Scheduler::add`].
    pub id: String,
    /// When to wake, milliseconds since the Unix epoch.
    pub at_ms: i64,
    /// What to tell the persona about this wake.
    pub note: String,
}

/// Why [`Scheduler::handle`] asked for a persona turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WakeReason {
    /// The regular interval elapsed.
    Interval,
    /// A [`Scheduled`] wake came due.
    Scheduled {
        /// Identifier of the wake that fired.
        id: String,
        /// Its note, passed on to the persona.
        note: String,
    },
    /// The user asked for a turn now.
    Manual,
}

/// What the core tells the scheduler. All time is passed in, never read.
pub enum Event {
    /// Replace interval and quiet hours.
    Settings(PersonaSettings),
    /// A persona turn started (`true`) or finished (`false`).
    Busy(bool),
    /// An approval is open and must be answered first.
    Blocked(bool),
    /// The user paused the persona.
    Paused(bool),
    /// Today's token budget is used up.
    BudgetExhausted(bool),
    /// The core's periodic timer fired.
    Tick,
    /// The user asked for a turn now.
    WakeNow,
}

/// Why [`Scheduler::add`] refused a new wake.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduleError {
    /// [`MAX_SCHEDULED`] wakes are already queued.
    TooMany,
    /// The requested time is not in the future.
    InPast,
    /// The requested time is more than [`MAX_AHEAD_MS`] ahead.
    TooFar,
    /// The note is empty or only whitespace.
    EmptyNote,
}

/// Decides when the persona wakes up. Pure state machine: see [`Event`].
#[allow(clippy::struct_excessive_bools)] // Four independent holds, each toggled by its own Event.
pub struct Scheduler {
    interval_ms: i64,
    quiet_start: NaiveTime,
    quiet_end: NaiveTime,
    quiet_weekends: bool,
    next_interval_ms: i64,
    scheduled: Vec<Scheduled>,
    busy: bool,
    blocked: bool,
    paused: bool,
    exhausted: bool,
    counter: u64,
}

/// The numeric suffix of an id minted by [`Scheduler::add`] (`w-<at>-<n>`),
/// or `None` for anything else.
fn wake_counter(id: &str) -> Option<u64> {
    let rest = id.strip_prefix("w-")?;
    let (at, counter) = rest.rsplit_once('-')?;
    at.parse::<i64>().ok()?;
    counter.parse().ok()
}

impl Scheduler {
    /// Build a scheduler from the current settings and the wakes restored from
    /// disk. `scheduled` is sorted by time here.
    #[must_use]
    pub fn new(settings: &PersonaSettings, mut scheduled: Vec<Scheduled>, now: &Now) -> Self {
        scheduled.sort_by_key(|s| s.at_ms);
        let counter = scheduled
            .iter()
            .filter_map(|s| wake_counter(&s.id))
            .max()
            .unwrap_or(0);
        let mut state = Self {
            interval_ms: 0,
            quiet_start: NaiveTime::MIN,
            quiet_end: NaiveTime::MIN,
            quiet_weekends: false,
            next_interval_ms: 0,
            scheduled,
            busy: false,
            blocked: false,
            paused: false,
            exhausted: false,
            counter,
        };
        state.apply(settings);
        state.next_interval_ms = now.utc_ms + state.interval_ms;
        state
    }

    fn apply(&mut self, settings: &PersonaSettings) {
        self.interval_ms = i64::from(settings.interval_min.max(MIN_INTERVAL_MIN)) * MS_PER_MIN;
        self.quiet_start = persona_quiet::parse_hhmm(&settings.quiet_start, DEFAULT_QUIET_START);
        self.quiet_end = persona_quiet::parse_hhmm(&settings.quiet_end, DEFAULT_QUIET_END);
        self.quiet_weekends = settings.quiet_weekends;
    }

    /// Whether `local` falls into the configured quiet hours.
    #[must_use]
    pub fn is_quiet(&self, local: &NaiveDateTime) -> bool {
        persona_quiet::contains(self.quiet_start, self.quiet_end, self.quiet_weekends, local)
    }

    /// Any hold that stops the scheduler from starting a turn.
    const fn held(&self) -> bool {
        self.busy || self.blocked || self.paused || self.exhausted
    }

    /// Feed one event; get at most one wake-up back.
    pub fn handle(&mut self, ev: Event, now: &Now) -> Option<WakeReason> {
        match ev {
            Event::Settings(settings) => {
                self.apply(&settings);
                self.next_interval_ms = self.next_interval_ms.min(now.utc_ms + self.interval_ms);
                None
            }
            Event::Busy(on) => {
                self.busy = on;
                None
            }
            Event::Blocked(on) => {
                self.blocked = on;
                None
            }
            Event::Paused(on) => {
                self.paused = on;
                None
            }
            Event::BudgetExhausted(on) => {
                self.exhausted = on;
                None
            }
            Event::WakeNow => {
                if self.held() {
                    None
                } else {
                    self.busy = true;
                    Some(WakeReason::Manual)
                }
            }
            Event::Tick => self.tick(now),
        }
    }

    fn tick(&mut self, now: &Now) -> Option<WakeReason> {
        let interval_due = now.utc_ms >= self.next_interval_ms;
        if self.held() {
            if interval_due {
                self.next_interval_ms = now.utc_ms + self.interval_ms;
            }
            return None;
        }
        if let Some(due) = self.take_due(now.utc_ms) {
            self.busy = true;
            return Some(WakeReason::Scheduled {
                id: due.id,
                note: due.note,
            });
        }
        if interval_due {
            self.next_interval_ms = now.utc_ms + self.interval_ms;
            if !self.is_quiet(&now.local) {
                self.busy = true;
                return Some(WakeReason::Interval);
            }
        }
        None
    }

    /// Remove and return the oldest wake that is due at `now_ms`.
    fn take_due(&mut self, now_ms: i64) -> Option<Scheduled> {
        let pos = self.scheduled.iter().position(|s| s.at_ms <= now_ms)?;
        Some(self.scheduled.remove(pos))
    }

    /// Queue a wake at `at_ms` and return its id.
    ///
    /// # Errors
    ///
    /// [`ScheduleError::EmptyNote`] for a blank note, [`ScheduleError::InPast`]
    /// for a time that is not in the future, [`ScheduleError::TooFar`] beyond
    /// [`MAX_AHEAD_MS`], and [`ScheduleError::TooMany`] when [`MAX_SCHEDULED`]
    /// wakes are already queued.
    pub fn add(&mut self, at_ms: i64, note: String, now: &Now) -> Result<String, ScheduleError> {
        if note.trim().is_empty() {
            return Err(ScheduleError::EmptyNote);
        }
        if at_ms <= now.utc_ms {
            return Err(ScheduleError::InPast);
        }
        if at_ms - now.utc_ms > MAX_AHEAD_MS {
            return Err(ScheduleError::TooFar);
        }
        if self.scheduled.len() >= MAX_SCHEDULED {
            return Err(ScheduleError::TooMany);
        }
        self.counter = self.counter.saturating_add(1);
        let id = format!("w-{at_ms}-{}", self.counter);
        let pos = self.scheduled.partition_point(|s| s.at_ms <= at_ms);
        self.scheduled.insert(
            pos,
            Scheduled {
                id: id.clone(),
                at_ms,
                note,
            },
        );
        Ok(id)
    }

    /// Drop the wake with `id`; returns whether it was queued.
    #[must_use]
    pub fn cancel(&mut self, id: &str) -> bool {
        let before = self.scheduled.len();
        self.scheduled.retain(|s| s.id != id);
        before != self.scheduled.len()
    }

    /// The queued wakes, oldest first.
    #[must_use]
    pub const fn scheduled(&self) -> &[Scheduled] {
        self.scheduled.as_slice()
    }

    /// When the interval wake-up is next due, milliseconds since the epoch.
    #[must_use]
    pub const fn next_interval_ms(&self) -> i64 {
        self.next_interval_ms
    }

    /// The soonest deadline the core should sleep until: the earlier of the
    /// interval and the first queued wake.
    ///
    /// `None` while paused or exhausted: the core re-ticks on unpause instead
    /// of waking mid-pause. While busy or blocked the queued wakes wait, so
    /// only the interval counts; returning their already past `at_ms` would
    /// make the core re-tick without sleeping.
    #[must_use]
    pub fn next_deadline(&self) -> Option<i64> {
        if self.paused || self.exhausted {
            return None;
        }
        if self.busy || self.blocked {
            return Some(self.next_interval_ms);
        }
        let first = self
            .scheduled
            .first()
            .map_or(self.next_interval_ms, |s| s.at_ms);
        Some(first.min(self.next_interval_ms))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    const MIN: i64 = 60_000;
    fn at(d: u32, h: u32, m: u32) -> Now {
        // 2026-11-16 is a Monday; local == UTC in these tests.
        let local = NaiveDate::from_ymd_opt(2026, 11, d)
            .unwrap()
            .and_hms_opt(h, m, 0)
            .unwrap();
        Now {
            utc_ms: local.and_utc().timestamp_millis(),
            local,
        }
    }
    fn sched(now: &Now) -> Scheduler {
        Scheduler::new(&PersonaSettings::default(), vec![], now)
    }

    #[test]
    fn first_interval_wakes_after_interval() {
        let t0 = at(16, 9, 0);
        let mut s = sched(&t0);
        assert_eq!(s.handle(Event::Tick, &at(16, 9, 29)), None);
        assert_eq!(
            s.handle(Event::Tick, &at(16, 9, 30)),
            Some(WakeReason::Interval)
        );
    }

    #[test]
    fn interval_skipped_while_busy_is_dropped() {
        let mut s = sched(&at(16, 9, 0));
        s.handle(Event::Busy(true), &at(16, 9, 1));
        assert_eq!(s.handle(Event::Tick, &at(16, 9, 30)), None);
        s.handle(Event::Busy(false), &at(16, 9, 31));
        assert_eq!(
            s.handle(Event::Tick, &at(16, 9, 31)),
            None,
            "dropped, not queued"
        );
        assert_eq!(
            s.handle(Event::Tick, &at(16, 10, 0)),
            Some(WakeReason::Interval)
        );
    }

    #[test]
    fn quiet_hours_and_weekends_suppress_interval_only() {
        let mut s = sched(&at(16, 19, 40));
        assert_eq!(
            s.handle(Event::Tick, &at(16, 20, 10)),
            None,
            "20:10 is quiet"
        );
        let id = s
            .add(at(16, 22, 0).utc_ms, "check".into(), &at(16, 20, 11))
            .unwrap();
        assert_eq!(
            s.handle(Event::Tick, &at(16, 22, 0)),
            Some(WakeReason::Scheduled {
                id,
                note: "check".into()
            })
        );
        let mut w = sched(&at(21, 9, 0)); // Saturday
        assert_eq!(w.handle(Event::Tick, &at(21, 9, 30)), None);
    }

    #[test]
    fn catch_up_after_sleep_runs_once() {
        let mut s = sched(&at(17, 7, 0));
        let a = s
            .add(at(17, 8, 0).utc_ms, "a".into(), &at(17, 7, 1))
            .unwrap();
        let b = s
            .add(at(17, 9, 0).utc_ms, "b".into(), &at(17, 7, 1))
            .unwrap();
        let wake = at(17, 17, 0); // slept 10 hours
        assert_eq!(
            s.handle(Event::Tick, &wake),
            Some(WakeReason::Scheduled {
                id: a,
                note: "a".into()
            })
        );
        s.handle(Event::Busy(false), &wake);
        assert_eq!(
            s.handle(Event::Tick, &wake),
            Some(WakeReason::Scheduled {
                id: b,
                note: "b".into()
            })
        );
        s.handle(Event::Busy(false), &wake);
        assert_eq!(s.handle(Event::Tick, &wake), Some(WakeReason::Interval));
        s.handle(Event::Busy(false), &wake);
        assert_eq!(
            s.handle(Event::Tick, &wake),
            None,
            "only one interval catch-up"
        );
    }

    #[test]
    fn paused_and_exhausted_block_everything_and_have_no_deadline() {
        let mut s = sched(&at(16, 9, 0));
        s.add(at(16, 9, 10).utc_ms, "x".into(), &at(16, 9, 0))
            .unwrap();
        s.handle(Event::Paused(true), &at(16, 9, 1));
        assert_eq!(s.next_deadline(), None);
        assert_eq!(s.handle(Event::Tick, &at(16, 9, 40)), None);
        s.handle(Event::Paused(false), &at(16, 9, 41));
        s.handle(Event::BudgetExhausted(true), &at(16, 9, 41));
        assert_eq!(s.handle(Event::Tick, &at(16, 9, 42)), None);
        s.handle(Event::BudgetExhausted(false), &at(16, 9, 43));
        assert!(matches!(
            s.handle(Event::Tick, &at(16, 9, 43)),
            Some(WakeReason::Scheduled { .. })
        ));
    }

    #[test]
    fn blocked_by_open_approval_waits() {
        let mut s = sched(&at(16, 9, 0));
        s.handle(Event::Blocked(true), &at(16, 9, 1));
        assert_eq!(s.handle(Event::Tick, &at(16, 9, 30)), None);
    }

    #[test]
    fn add_validates() {
        let now = at(16, 9, 0);
        let mut s = sched(&now);
        assert_eq!(
            s.add(now.utc_ms - 1, "x".into(), &now),
            Err(ScheduleError::InPast)
        );
        assert_eq!(
            s.add(now.utc_ms + 31 * 24 * 60 * MIN, "x".into(), &now),
            Err(ScheduleError::TooFar)
        );
        assert_eq!(
            s.add(now.utc_ms + MIN, "  ".into(), &now),
            Err(ScheduleError::EmptyNote)
        );
        for i in 0..50 {
            s.add(now.utc_ms + (i + 1) * MIN, "n".into(), &now).unwrap();
        }
        assert_eq!(
            s.add(now.utc_ms + 99 * MIN, "n".into(), &now),
            Err(ScheduleError::TooMany)
        );
    }

    #[test]
    fn wake_now_ignores_quiet_but_not_busy() {
        let mut s = sched(&at(16, 23, 0));
        assert_eq!(
            s.handle(Event::WakeNow, &at(16, 23, 1)),
            Some(WakeReason::Manual)
        );
        assert_eq!(s.handle(Event::WakeNow, &at(16, 23, 2)), None, "still busy");
    }

    #[test]
    fn dst_jump_does_not_double_wake() {
        // Local clock jumps back one hour; deadlines are UTC, so no extra wake.
        let mut s = sched(&at(16, 9, 0));
        let t = Now {
            utc_ms: at(16, 9, 30).utc_ms,
            local: at(16, 8, 30).local,
        };
        assert_eq!(s.handle(Event::Tick, &t), Some(WakeReason::Interval));
        s.handle(Event::Busy(false), &t);
        let t2 = Now {
            utc_ms: t.utc_ms + 5 * MIN,
            local: at(16, 8, 35).local,
        };
        assert_eq!(s.handle(Event::Tick, &t2), None);
    }

    #[test]
    fn held_deadline_ignores_overdue_scheduled() {
        let wake = at(17, 17, 0); // ten hours after start: both wakes overdue
        let mut s = sched(&at(17, 7, 0));
        s.add(at(17, 9, 0).utc_ms, "a".into(), &at(17, 7, 1))
            .unwrap();
        s.add(at(17, 10, 0).utc_ms, "b".into(), &at(17, 7, 1))
            .unwrap();

        assert!(matches!(
            s.handle(Event::Tick, &wake),
            Some(WakeReason::Scheduled { .. })
        ));
        assert_eq!(
            s.handle(Event::Tick, &wake),
            None,
            "busy tick drops the overdue interval"
        );
        assert_eq!(s.next_deadline(), Some(s.next_interval_ms()));
        assert!(
            s.next_deadline().unwrap() > wake.utc_ms,
            "busy must not return a past deadline"
        );
        s.handle(Event::Busy(false), &wake);
        assert!(
            s.next_deadline().unwrap() <= wake.utc_ms,
            "queued wake is due again"
        );

        let mut blocked = sched(&at(17, 7, 0));
        blocked
            .add(at(17, 9, 0).utc_ms, "a".into(), &at(17, 7, 1))
            .unwrap();
        blocked
            .add(at(17, 10, 0).utc_ms, "b".into(), &at(17, 7, 1))
            .unwrap();
        blocked.handle(Event::Blocked(true), &wake);
        assert_eq!(blocked.handle(Event::Tick, &wake), None);
        assert_eq!(blocked.next_deadline(), Some(blocked.next_interval_ms()));
        assert!(
            blocked.next_deadline().unwrap() > wake.utc_ms,
            "blocked must not return a past deadline"
        );
        blocked.handle(Event::Blocked(false), &wake);
        assert!(blocked.next_deadline().unwrap() <= wake.utc_ms);
    }

    #[test]
    fn restored_max_counter_does_not_panic() {
        let now = at(16, 9, 0);
        let at_ms = now.utc_ms + 10 * MIN;
        let restored = vec![Scheduled {
            id: "w-1-18446744073709551615".into(),
            at_ms,
            note: "restored".into(),
        }];
        let mut s = Scheduler::new(&PersonaSettings::default(), restored, &now);
        let id = s.add(at_ms, "new".into(), &now).unwrap();
        assert_eq!(id, format!("w-{at_ms}-18446744073709551615"));
    }

    #[test]
    fn restored_ids_do_not_collide() {
        let now = at(16, 9, 0);
        let at_ms = now.utc_ms + 10 * MIN;
        let restored = vec![
            Scheduled {
                id: format!("w-{at_ms}-1"),
                at_ms,
                note: "one".into(),
            },
            Scheduled {
                id: format!("w-{at_ms}-4"),
                at_ms,
                note: "four".into(),
            },
            Scheduled {
                id: "not-a-wake".into(),
                at_ms,
                note: "junk".into(),
            },
        ];
        let mut s = Scheduler::new(&PersonaSettings::default(), restored, &now);
        let id = s.add(at_ms, "new".into(), &now).unwrap();
        assert_eq!(id, format!("w-{at_ms}-5"));
        assert!(s.cancel(&id));
        assert_eq!(s.scheduled().len(), 3, "restored wakes survive");
    }
}
