//! Ompy's inbox: approvals, decisions, results and notices, persisted as
//! `inbox.json` with an atomic write after every change.

use omp_desktop_core::json_store::write_atomic;
use omp_desktop_core::persona_protocol::{InboxItem, ItemKind, ItemState};
use serde::{Deserialize, Serialize};
use std::io;
use std::path::PathBuf;

/// How long a settled item stays in the inbox: 14 days.
const KEEP_MS: i64 = 14 * 24 * 60 * 60 * 1000;
/// Most items kept in total, open ones always included.
const KEEP_MAX: usize = 200;
/// Format version written by [`Inbox::save`].
const FILE_VERSION: u32 = 1;
/// Notice returned by [`Inbox::load`] when it had to reset a broken file.
const RESET_NOTICE: &str = "Inbox file was unreadable and was reset";

/// On-disk shape of `inbox.json`.
#[derive(Serialize, Deserialize)]
struct File {
    /// Format version, for a future reader to branch on.
    #[allow(dead_code)] // Written only; no reader branches on the version yet.
    version: u32,
    /// Last id counter, so ids stay unique across restarts.
    counter: u64,
    /// Items in insertion (and therefore creation) order.
    items: Vec<InboxItem>,
}

/// The persona's inbox, either in memory or backed by `inbox.json`.
pub struct Inbox {
    /// Items in insertion (and therefore creation) order.
    items: Vec<InboxItem>,
    /// Monotonic suffix for ids, persisted with the items.
    counter: u64,
    /// Where to save; `None` for [`Inbox::in_memory`].
    path: Option<PathBuf>,
}

impl Inbox {
    /// An inbox that never touches the disk.
    #[must_use]
    pub const fn in_memory() -> Self {
        Self {
            items: Vec::new(),
            counter: 0,
            path: None,
        }
    }

    /// Load `path`, or start empty when it does not exist.
    ///
    /// A file that cannot be parsed is renamed to `inbox.json.bad-<now_ms>`
    /// and replaced by an empty inbox; the second return value carries the
    /// notice for the user in that case.
    #[must_use]
    pub fn load(path: PathBuf, now_ms: i64) -> (Self, Option<String>) {
        let Ok(bytes) = std::fs::read(&path) else {
            return (Self::at(path), None);
        };
        let Ok(file) = serde_json::from_slice::<File>(&bytes) else {
            let bad = path.with_file_name(format!("inbox.json.bad-{now_ms}"));
            let _ = std::fs::rename(&path, &bad);
            return (Self::at(path), Some(RESET_NOTICE.into()));
        };
        (
            Self {
                items: file.items,
                counter: file.counter,
                path: Some(path),
            },
            None,
        )
    }

    /// An empty inbox that saves to `path`.
    const fn at(path: PathBuf) -> Self {
        Self {
            items: Vec::new(),
            counter: 0,
            path: Some(path),
        }
    }

    /// Add an open item and return its id.
    #[allow(clippy::too_many_arguments)] // One parameter per `InboxItem` field.
    pub fn add(
        &mut self,
        kind: ItemKind,
        title: String,
        body: Option<String>,
        options: Vec<String>,
        urgent: bool,
        rpc_request_id: Option<String>,
        now_ms: i64,
    ) -> String {
        self.counter += 1;
        let id = format!("i-{now_ms}-{}", self.counter);
        self.items.push(InboxItem {
            id: id.clone(),
            kind,
            created_at: now_ms,
            title,
            body,
            options,
            urgent,
            state: ItemState::Open,
            answer: None,
            rpc_request_id,
        });
        id
    }

    /// Mark `item` answered or dismissed, depending on `answer`, and return
    /// the copy as it now stands.
    fn settle(item: &mut InboxItem, answer: Option<String>) -> InboxItem {
        item.state = if answer.is_some() {
            ItemState::Answered
        } else {
            ItemState::Dismissed
        };
        item.answer = answer;
        item.clone()
    }

    /// Answer or dismiss the open item `id`; `None` when no such item is
    /// open (settled items are not resolved twice).
    pub fn resolve(&mut self, id: &str, answer: Option<String>) -> Option<InboxItem> {
        let item = self
            .items
            .iter_mut()
            .find(|item| item.id == id && item.state == ItemState::Open)?;
        Some(Self::settle(item, answer))
    }

    /// Answer or dismiss the open item bound to `rpc_id`.
    pub fn resolve_by_rpc(&mut self, rpc_id: &str, answer: Option<String>) -> Option<InboxItem> {
        let item = self.items.iter_mut().find(|item| {
            item.rpc_request_id.as_deref() == Some(rpc_id) && item.state == ItemState::Open
        })?;
        Some(Self::settle(item, answer))
    }

    /// Expire the open item bound to `rpc_id` (its request ended without an
    /// answer); returns whether one was found.
    #[must_use]
    pub fn expire_by_rpc(&mut self, rpc_id: &str) -> bool {
        let Some(item) = self.items.iter_mut().find(|item| {
            item.rpc_request_id.as_deref() == Some(rpc_id) && item.state == ItemState::Open
        }) else {
            return false;
        };
        item.state = ItemState::Expired;
        true
    }

    /// Expire every open item bound to an omp request, e.g. when the session
    /// restarts. Returns how many were expired.
    pub fn expire_all_bound(&mut self) -> usize {
        let mut expired = 0;
        for item in &mut self.items {
            if item.state == ItemState::Open && item.rpc_request_id.is_some() {
                item.state = ItemState::Expired;
                expired += 1;
            }
        }
        expired
    }

    /// Drop settled items older than 14 days, then trim the oldest settled
    /// items until at most [`KEEP_MAX`] remain. Open items are never removed.
    pub fn prune(&mut self, now_ms: i64) {
        self.items
            .retain(|item| item.state == ItemState::Open || now_ms - item.created_at <= KEEP_MS);
        let mut excess = self.items.len().saturating_sub(KEEP_MAX);
        self.items.retain(|item| {
            if excess > 0 && item.state != ItemState::Open {
                excess -= 1;
                false
            } else {
                true
            }
        });
    }

    /// How many items still wait for an answer.
    #[must_use]
    pub fn open_count(&self) -> usize {
        self.items
            .iter()
            .filter(|item| item.state == ItemState::Open)
            .count()
    }

    /// Whether any open item belongs to an omp request; the scheduler holds
    /// turns while that is the case.
    #[must_use]
    pub fn has_open_bound(&self) -> bool {
        self.items
            .iter()
            .any(|item| item.state == ItemState::Open && item.rpc_request_id.is_some())
    }

    /// The items, oldest first.
    #[must_use]
    pub fn items(&self) -> &[InboxItem] {
        &self.items
    }

    /// Persist the inbox; a no-op for [`Inbox::in_memory`].
    ///
    /// # Errors
    /// The JSON serialisation or [`write_atomic`] failure.
    pub fn save(&self) -> io::Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let file = File {
            version: FILE_VERSION,
            counter: self.counter,
            items: self.items.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&file).map_err(io::Error::other)?;
        write_atomic(path, &bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use omp_desktop_core::test_support::tempdir;

    const DAY: i64 = 24 * 60 * 60 * 1000;

    #[test]
    fn approval_bound_to_rpc_resolves_and_expires() {
        let mut ib = Inbox::in_memory();
        let id = ib.add(
            ItemKind::Approval,
            "Allow tool: bash".into(),
            None,
            vec!["Approve".into(), "Deny".into()],
            false,
            Some("r1".into()),
            0,
        );
        assert!(ib.has_open_bound());
        assert_eq!(
            ib.resolve_by_rpc("r1", Some("Approve".into())).unwrap().id,
            id
        );
        assert!(!ib.has_open_bound());
        assert!(ib.resolve(&id, None).is_none(), "already answered");
        ib.add(
            ItemKind::Approval,
            "x".into(),
            None,
            vec![],
            false,
            Some("r2".into()),
            0,
        );
        assert_eq!(ib.expire_all_bound(), 1);
        assert_eq!(ib.items().last().unwrap().state, ItemState::Expired);
    }

    #[test]
    fn prune_keeps_open_and_caps_history() {
        let mut ib = Inbox::in_memory();
        let open = ib.add(
            ItemKind::Decision,
            "keep".into(),
            None,
            vec![],
            false,
            None,
            0,
        );
        for i in 0..250 {
            let id = ib.add(
                ItemKind::Result,
                format!("r{i}"),
                None,
                vec![],
                false,
                None,
                i,
            );
            ib.resolve(&id, None);
        }
        ib.prune(15 * DAY);
        assert!(ib.items().iter().any(|i| i.id == open));
        assert_eq!(ib.items().len(), 1, "results older than 14 days are gone");
        for i in 0..250 {
            let id = ib.add(
                ItemKind::Result,
                format!("n{i}"),
                None,
                vec![],
                false,
                None,
                15 * DAY + i,
            );
            ib.resolve(&id, None);
        }
        ib.prune(15 * DAY + 300);
        assert_eq!(ib.items().len(), 200);
        assert!(ib.items().iter().any(|i| i.id == open));
    }

    #[test]
    fn corrupt_file_is_moved_aside() {
        let dir = tempdir("omp-desktopd", "inbox-corrupt");
        let path = dir.join("inbox.json");
        std::fs::write(&path, b"{not json").unwrap();
        let (ib, notice) = Inbox::load(path, 42);
        assert!(notice.is_some());
        assert_eq!(ib.items().len(), 0);
        assert!(dir.join("inbox.json.bad-42").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = tempdir("omp-desktopd", "inbox-round-trip");
        let path = dir.join("inbox.json");
        let (mut ib, _) = Inbox::load(path.clone(), 0);
        ib.add(
            ItemKind::Notice,
            "hello".into(),
            None,
            vec![],
            false,
            None,
            1,
        );
        ib.save().unwrap();
        let (again, notice) = Inbox::load(path, 2);
        assert!(notice.is_none());
        assert_eq!(again.items()[0].title, "hello");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
