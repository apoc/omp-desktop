//! Daily token budget. Pure; the core persists it as `budget.json`.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Smallest daily limit a user may set, so a typo cannot starve the persona.
pub const MIN_LIMIT: u64 = 100_000;

/// Tokens an assistant turn billed. `cacheRead` is deliberately absent: a
/// cache read is cheap and does not count against the daily limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Usage {
    /// Prompt tokens sent to the model.
    pub input: u64,
    /// Tokens the model generated.
    pub output: u64,
    /// Tokens written to the prompt cache.
    pub cache_write: u64,
}

impl Usage {
    /// Read the usage of an `omp` `message_end` frame, or `None` when the
    /// frame is not an assistant message with usage.
    #[must_use]
    pub fn from_message_end(frame: &Value) -> Option<Self> {
        if frame.get("type")?.as_str()? != "message_end" {
            return None;
        }
        let message = frame.get("message")?;
        if message.get("role")?.as_str()? != "assistant" {
            return None;
        }
        let usage = message.get("usage")?;
        let count = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
        Some(Self {
            input: count("input"),
            output: count("output"),
            cache_write: count("cacheWrite"),
        })
    }

    /// Tokens this usage adds to the budget.
    const fn total(&self) -> u64 {
        self.input
            .saturating_add(self.output)
            .saturating_add(self.cache_write)
    }
}

/// How much of today's budget is used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetState {
    /// Below 80 %: the persona runs normally.
    Ok,
    /// 80 % to 99 %: the user is warned once per day.
    Warn,
    /// The limit is reached; the persona pauses until the day rolls over.
    Exhausted,
}

/// What changed for the core after a budget call, if anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetEvent {
    /// The 80 % threshold was crossed for the first time today.
    Warned,
    /// The limit was reached.
    Exhausted,
    /// A new day started or a raised limit cleared the exhaustion.
    Reset,
}

/// Today's limit, the day it applies to, and the tokens used so far.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    /// Daily token limit; at least [`MIN_LIMIT`].
    pub limit: u64,
    /// Local day the counter belongs to.
    pub day: NaiveDate,
    /// Tokens used on [`Budget::day`].
    pub used: u64,
    /// Whether [`BudgetEvent::Warned`] was already reported for this day.
    #[serde(default)]
    warned: bool,
}

impl Budget {
    /// Start a fresh counter for `today` with `limit` (clamped to
    /// [`MIN_LIMIT`]).
    #[must_use]
    pub fn new(limit: u64, today: NaiveDate) -> Self {
        Self {
            limit: limit.max(MIN_LIMIT),
            day: today,
            used: 0,
            warned: false,
        }
    }

    /// Where the budget stands right now.
    #[must_use]
    pub const fn state(&self) -> BudgetState {
        if self.used >= self.limit {
            BudgetState::Exhausted
        } else if self.used.saturating_mul(10) >= self.limit.saturating_mul(8) {
            BudgetState::Warn
        } else {
            BudgetState::Ok
        }
    }

    /// Roll the counter over when `today` is a new day. Reports
    /// [`BudgetEvent::Reset`] only when the old day was not already `Ok`.
    pub fn roll(&mut self, today: NaiveDate) -> Option<BudgetEvent> {
        if today == self.day {
            return None;
        }
        let was = self.state();
        self.day = today;
        self.used = 0;
        self.warned = false;
        (was != BudgetState::Ok).then_some(BudgetEvent::Reset)
    }

    /// Add one turn's usage for `today` and report the threshold crossed,
    /// if any. A new day rolls the counter over first.
    pub fn add(&mut self, usage: &Usage, today: NaiveDate) -> Option<BudgetEvent> {
        let rolled = self.roll(today);
        let before = self.state();
        self.used = self.used.saturating_add(usage.total());
        match (before, self.state()) {
            (_, BudgetState::Exhausted) if before != BudgetState::Exhausted => {
                Some(BudgetEvent::Exhausted)
            }
            (BudgetState::Ok, BudgetState::Warn) if !self.warned => {
                self.warned = true;
                Some(BudgetEvent::Warned)
            }
            _ => rolled,
        }
    }

    /// Replace the daily limit (clamped to [`MIN_LIMIT`]). Raising it above
    /// today's use clears exhaustion and reports [`BudgetEvent::Reset`].
    pub fn set_limit(&mut self, limit: u64) -> Option<BudgetEvent> {
        let before = self.state();
        self.limit = limit.max(MIN_LIMIT);
        (before == BudgetState::Exhausted && self.state() != BudgetState::Exhausted)
            .then_some(BudgetEvent::Reset)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use serde_json::json;

    fn d(day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 11, day).unwrap()
    }
    fn u(n: u64) -> Usage {
        Usage {
            input: n,
            output: 0,
            cache_write: 0,
        }
    }

    #[test]
    fn usage_counts_input_output_cache_write_not_cache_read() {
        let f = json!({"type":"message_end","message":{"role":"assistant","usage":{"input":10,"output":5,"cacheRead":1000,"cacheWrite":2}}});
        let got = Usage::from_message_end(&f).unwrap();
        assert_eq!(got.input + got.output + got.cache_write, 17);
        assert!(
            Usage::from_message_end(&json!({"type":"message_end","message":{"role":"user"}}))
                .is_none()
        );
        assert!(Usage::from_message_end(&json!({"type":"turn_end"})).is_none());
    }

    #[test]
    fn warns_at_80_and_exhausts_at_100_once_each() {
        let mut b = Budget::new(1_000_000, d(16));
        assert_eq!(b.add(&u(799_999), d(16)), None);
        assert_eq!(b.add(&u(1), d(16)), Some(BudgetEvent::Warned));
        assert_eq!(b.add(&u(1), d(16)), None);
        assert_eq!(b.add(&u(200_000), d(16)), Some(BudgetEvent::Exhausted));
        assert_eq!(b.state(), BudgetState::Exhausted);
    }

    #[test]
    fn usage_after_midnight_counts_to_new_day() {
        let mut b = Budget::new(1_000_000, d(16));
        b.add(&u(1_000_000), d(16));
        assert_eq!(b.add(&u(10), d(17)), Some(BudgetEvent::Reset));
        assert_eq!((b.used, b.day, b.state()), (10, d(17), BudgetState::Ok));
    }

    #[test]
    fn raising_limit_above_use_clears_exhausted_and_minimum_holds() {
        let mut b = Budget::new(200_000, d(16));
        b.add(&u(200_000), d(16));
        assert_eq!(b.set_limit(1_000_000), Some(BudgetEvent::Reset));
        assert_eq!(b.state(), BudgetState::Ok);
        b.set_limit(5);
        assert_eq!(b.limit, MIN_LIMIT);
    }
}
