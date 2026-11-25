//! Which Ompy inbox items deserve a phone push. Pure so the rules can be
//! tested without a service, a socket or a push worker.

use omp_desktop_core::persona_protocol::{InboxItem, ItemKind, ItemState};
use std::collections::HashSet;

/// The items of one `inbox` snapshot that are new to this app run and worth
/// a push: still open, an approval or decision, not in `prev_seen`, and —
/// during quiet hours — urgent.
pub(super) fn new_push_targets<'a>(
    prev_seen: &HashSet<String>,
    items: &'a [InboxItem],
    quiet: bool,
) -> Vec<&'a InboxItem> {
    items
        .iter()
        .filter(|item| {
            item.state == ItemState::Open
                && matches!(item.kind, ItemKind::Approval | ItemKind::Decision)
                && !prev_seen.contains(&item.id)
                && (!quiet || item.urgent)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::new_push_targets;
    use omp_desktop_core::persona_protocol::{InboxItem, ItemKind, ItemState};
    use std::collections::HashSet;

    fn item(id: &str, kind: ItemKind, state: ItemState, urgent: bool) -> InboxItem {
        InboxItem {
            id: id.into(),
            kind,
            created_at: 0,
            title: format!("title of {id}"),
            body: None,
            options: Vec::new(),
            urgent,
            state,
            answer: None,
            rpc_request_id: None,
            request_method: None,
            ask_questions: None,
            secret: false,
        }
    }

    fn ids(items: Vec<&InboxItem>) -> Vec<String> {
        items.into_iter().map(|item| item.id.clone()).collect()
    }

    fn none() -> HashSet<String> {
        HashSet::new()
    }

    #[test]
    fn open_approvals_and_decisions_are_targets() {
        let items = [
            item("a", ItemKind::Approval, ItemState::Open, false),
            item("d", ItemKind::Decision, ItemState::Open, false),
            item("r", ItemKind::Result, ItemState::Open, false),
            item("n", ItemKind::Notice, ItemState::Open, false),
        ];
        assert_eq!(ids(new_push_targets(&none(), &items, false)), ["a", "d"]);
    }

    #[test]
    fn settled_items_are_not_targets() {
        let items = [
            item("open", ItemKind::Approval, ItemState::Open, false),
            item("answered", ItemKind::Approval, ItemState::Answered, false),
            item("dismissed", ItemKind::Decision, ItemState::Dismissed, false),
            item("expired", ItemKind::Decision, ItemState::Expired, false),
        ];
        assert_eq!(ids(new_push_targets(&none(), &items, false)), ["open"]);
    }

    #[test]
    fn seen_ids_are_not_pushed_again() {
        let items = [
            item("old", ItemKind::Approval, ItemState::Open, false),
            item("new", ItemKind::Decision, ItemState::Open, false),
        ];
        let seen: HashSet<String> = std::iter::once("old".to_owned()).collect();
        assert_eq!(ids(new_push_targets(&seen, &items, false)), ["new"]);
    }

    #[test]
    fn quiet_hours_keep_only_urgent_items() {
        let items = [
            item("plain", ItemKind::Decision, ItemState::Open, false),
            item("loud", ItemKind::Approval, ItemState::Open, true),
        ];
        assert_eq!(ids(new_push_targets(&none(), &items, true)), ["loud"]);
        assert_eq!(
            ids(new_push_targets(&none(), &items, false)),
            ["plain", "loud"]
        );
    }
}
