//! The ISO timestamps of session entries → epoch ms, without a datetime
//! crate (this project has none).

use std::borrow::Cow;

use serde_json::value::RawValue;
use serde_json::Number;

/// Epoch ms of an ISO-8601 UTC timestamp exactly as omp writes it
/// (`Date.toISOString()`: `YYYY-MM-DDTHH:MM:SS.sssZ`, a valid date and
/// time); `None` for any other value.
pub fn iso_ms(raw: &RawValue) -> Option<Number> {
    let text: Cow<str> = serde_json::from_str(raw.get()).ok()?;
    let text = text.strip_suffix('Z')?;
    let (date, time) = text.split_once('T')?;
    let (time, millis) = time.split_once('.')?;
    let num = |s: &str, len: usize| -> Option<i64> {
        (s.len() == len && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok())?
    };
    let mut date = date.split('-');
    let (year, month, day) = (
        num(date.next()?, 4)?,
        num(date.next()?, 2)?,
        num(date.next()?, 2)?,
    );
    let mut time = time.split(':');
    let (hour, minute, second) = (
        num(time.next()?, 2)?,
        num(time.next()?, 2)?,
        num(time.next()?, 2)?,
    );
    let millis = num(millis, 3)?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if date.next().is_some()
        || time.next().is_some()
        || !(1..=12).contains(&month)
        || !(1..=days_in_month).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    // Days since the epoch of a proleptic Gregorian date (H. Hinnant's
    // `days_from_civil`).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(Number::from(
        ((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + millis,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(text: &str) -> Option<i64> {
        let raw = serde_json::to_string(text).unwrap();
        iso_ms(&RawValue::from_string(raw).unwrap()).and_then(|n| n.as_i64())
    }

    #[test]
    fn converts_omp_iso_timestamps() {
        // Expected values from `Date.parse` in JS.
        assert_eq!(ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(ms("2026-10-04T10:00:05.123Z"), Some(1_791_108_005_123));
        assert_eq!(ms("2024-02-29T23:59:59.999Z"), Some(1_709_251_199_999));
        assert_eq!(ms("2000-03-01T00:00:00.500Z"), Some(951_868_800_500));
        assert_eq!(ms("1999-12-31T23:59:59.000Z"), Some(946_684_799_000));
    }

    #[test]
    fn refuses_anything_else() {
        for text in [
            "",
            "t",
            "2026-10-04T10:00:05.123",
            "2026-10-04 10:00:05.123Z",
            "2026-13-04T10:00:05.123Z",
            "2026-10-04T24:00:05.123Z",
            "2026-10-04T10:00:05.1x3Z",
            "2026-10-04T10:00:05+02:00",
            // Fraction other than exactly three digits.
            "2026-10-04T10:00:05Z",
            "2026-10-04T10:00:05.5Z",
            "2026-10-04T10:00:05.1234Z",
            "2026-10-04T10:00:05.Z",
            // Leap second, days past the month's end.
            "2026-12-31T23:59:60.000Z",
            "2026-04-31T10:00:00.000Z",
            "2025-02-29T10:00:00.000Z",
            "1900-02-29T10:00:00.000Z",
        ] {
            assert_eq!(ms(text), None, "{text}");
        }
        assert_eq!(iso_ms(&RawValue::from_string("17".into()).unwrap()), None);
    }
}
