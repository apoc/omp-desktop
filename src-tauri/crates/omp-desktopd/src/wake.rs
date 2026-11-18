//! The hidden header Ompy gets with every wake-up: the trigger, the local
//! time, the tokens left today and the decisions waiting in the inbox.

use crate::scheduler::WakeReason;
use chrono::NaiveDateTime;

/// The `prompt` message body for one wake-up.
#[must_use]
pub fn prompt(
    reason: &WakeReason,
    local: NaiveDateTime,
    tokens_left: u64,
    open_decisions: &[String],
) -> String {
    let trigger = match reason {
        WakeReason::Interval => "interval".to_owned(),
        WakeReason::Scheduled { note, .. } => format!("scheduled: {note}"),
        WakeReason::Manual => "manual".to_owned(),
    };
    let open = if open_decisions.is_empty() {
        "none".to_owned()
    } else {
        open_decisions.join("; ")
    };
    format!(
        "[ompy wake] trigger: {trigger}\nlocal time: {}\ntokens left today: {tokens_left}\nopen decisions: {open}\n\nDo what this trigger calls for (see your instructions).",
        local.format("%Y-%m-%d %H:%M (%a)")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_names_trigger_and_budget() {
        let t = chrono::NaiveDate::from_ymd_opt(2026, 11, 16)
            .unwrap()
            .and_hms_opt(8, 30, 0)
            .unwrap();
        let p = prompt(
            &WakeReason::Scheduled {
                id: "w".into(),
                note: "check invoices".into(),
            },
            t,
            1200,
            &[],
        );
        assert!(p.starts_with(
            "[ompy wake] trigger: scheduled: check invoices\nlocal time: 2026-11-16 08:30 (Mon)\ntokens left today: 1200\nopen decisions: none"
        ));
        assert!(p.ends_with("Do what this trigger calls for (see your instructions)."));
    }

    #[test]
    fn open_decisions_are_joined() {
        let t = chrono::NaiveDate::from_ymd_opt(2026, 11, 16)
            .unwrap()
            .and_hms_opt(8, 30, 0)
            .unwrap();
        let p = prompt(
            &WakeReason::Manual,
            t,
            0,
            &["Archive the invoice?".into(), "Send the draft?".into()],
        );
        assert!(p.contains("open decisions: Archive the invoice?; Send the draft?"));
    }
}
