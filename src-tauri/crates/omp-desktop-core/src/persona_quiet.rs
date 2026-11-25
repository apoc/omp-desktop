//! The persona's quiet hours, shared by the service's scheduler and the
//! desktop app's push decision: the same `HH:MM` strings, the same weekend
//! rule and the same half-open window must answer both.

use chrono::{Datelike, Local, NaiveDateTime, NaiveTime, Weekday};

use crate::persona_protocol::PersonaSettings;

/// Quiet start/end used when the stored strings do not parse. The settings
/// validator refuses such input; this is only the safety net the scheduler
/// has always applied.
pub const DEFAULT_QUIET_START: NaiveTime =
    NaiveTime::from_hms_opt(20, 0, 0).expect("20:00 is a valid time");
pub const DEFAULT_QUIET_END: NaiveTime =
    NaiveTime::from_hms_opt(7, 0, 0).expect("07:00 is a valid time");

/// A local `HH:MM` string, or `fallback` when it does not parse.
#[must_use]
pub fn parse_hhmm(text: &str, fallback: NaiveTime) -> NaiveTime {
    NaiveTime::parse_from_str(text, "%H:%M").unwrap_or(fallback)
}

/// Whether `local` falls into `start..end` (wrapping past midnight) or into
/// a quiet weekend.
#[must_use]
pub fn contains(
    start: NaiveTime,
    end: NaiveTime,
    quiet_weekends: bool,
    local: &NaiveDateTime,
) -> bool {
    if quiet_weekends && matches!(local.weekday(), Weekday::Sat | Weekday::Sun) {
        return true;
    }
    let time = local.time();
    if start <= end {
        time >= start && time < end
    } else {
        time >= start || time < end
    }
}

/// [`contains`] with the window parsed from `settings`.
#[must_use]
pub fn is_quiet(settings: &PersonaSettings, local: &NaiveDateTime) -> bool {
    contains(
        parse_hhmm(&settings.quiet_start, DEFAULT_QUIET_START),
        parse_hhmm(&settings.quiet_end, DEFAULT_QUIET_END),
        settings.quiet_weekends,
        local,
    )
}

/// [`is_quiet`] at the machine's local wall-clock time.
#[must_use]
pub fn is_quiet_now(settings: &PersonaSettings) -> bool {
    is_quiet(settings, &Local::now().naive_local())
}

#[cfg(test)]
mod tests {
    use super::{contains, is_quiet, parse_hhmm, DEFAULT_QUIET_END, DEFAULT_QUIET_START};
    use crate::persona_protocol::PersonaSettings;
    use chrono::{NaiveDate, NaiveDateTime, NaiveTime};

    fn at(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(year, month, day)
            .expect("valid date")
            .and_hms_opt(hour, minute, 0)
            .expect("valid time")
    }

    fn settings(start: &str, end: &str, weekends: bool) -> PersonaSettings {
        PersonaSettings {
            quiet_start: start.into(),
            quiet_end: end.into(),
            quiet_weekends: weekends,
            ..PersonaSettings::default()
        }
    }

    #[test]
    fn hhmm_parses_and_falls_back() {
        assert_eq!(
            parse_hhmm("7:05", NaiveTime::MIN),
            NaiveTime::from_hms_opt(7, 5, 0).expect("valid")
        );
        assert_eq!(parse_hhmm("25:00", NaiveTime::MIN), NaiveTime::MIN);
        assert_eq!(
            parse_hhmm("nonsense", DEFAULT_QUIET_START),
            DEFAULT_QUIET_START
        );
    }

    #[test]
    fn a_window_past_midnight_wraps() {
        let start = NaiveTime::from_hms_opt(20, 0, 0).expect("valid");
        let end = NaiveTime::from_hms_opt(7, 0, 0).expect("valid");
        // Monday 2026-11-16.
        assert!(contains(start, end, false, &at(2026, 11, 16, 20, 0)));
        assert!(contains(start, end, false, &at(2026, 11, 16, 23, 59)));
        assert!(contains(start, end, false, &at(2026, 11, 17, 6, 59)));
        assert!(!contains(start, end, false, &at(2026, 11, 17, 7, 0)));
        assert!(!contains(start, end, false, &at(2026, 11, 16, 12, 0)));
    }

    #[test]
    fn a_daytime_window_is_half_open() {
        let start = NaiveTime::from_hms_opt(9, 0, 0).expect("valid");
        let end = NaiveTime::from_hms_opt(17, 0, 0).expect("valid");
        assert!(!contains(start, end, false, &at(2026, 11, 16, 8, 59)));
        assert!(contains(start, end, false, &at(2026, 11, 16, 9, 0)));
        assert!(!contains(start, end, false, &at(2026, 11, 16, 17, 0)));
    }

    #[test]
    fn weekends_are_quiet_when_asked_for() {
        // Saturday 2026-11-21, Sunday the 22nd.
        let quiet = settings("20:00", "07:00", true);
        assert!(is_quiet(&quiet, &at(2026, 11, 21, 12, 0)));
        assert!(is_quiet(&quiet, &at(2026, 11, 22, 12, 0)));
        let weekdays_only = settings("20:00", "07:00", false);
        assert!(!is_quiet(&weekdays_only, &at(2026, 11, 21, 12, 0)));
        assert!(!is_quiet(&weekdays_only, &at(2026, 11, 23, 12, 0)));
    }

    #[test]
    fn an_empty_window_is_never_quiet() {
        let never = settings("00:00", "00:00", false);
        assert!(!is_quiet(&never, &at(2026, 11, 16, 0, 0)));
        assert!(!is_quiet(&never, &at(2026, 11, 16, 12, 0)));
    }

    #[test]
    fn invalid_strings_use_the_default_window() {
        let broken = settings("", "", false);
        assert_eq!(
            DEFAULT_QUIET_START,
            NaiveTime::from_hms_opt(20, 0, 0).expect("valid")
        );
        assert_eq!(
            DEFAULT_QUIET_END,
            NaiveTime::from_hms_opt(7, 0, 0).expect("valid")
        );
        assert!(is_quiet(&broken, &at(2026, 11, 16, 21, 0)));
        assert!(!is_quiet(&broken, &at(2026, 11, 16, 12, 0)));
    }
}
