//! Immutable IPC snapshots and the cross-thread wake/reset state.

use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::thread::Thread;

use serde::{Deserialize, Serialize};

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub(super) revision: u64,
    pub(super) default_enabled: bool,
    pub(super) active: bool,
    pub(super) error: Option<Arc<str>>,
    pub(super) sessions: Arc<Vec<Session>>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Session {
    pub(super) id: Arc<str>,
    pub(super) override_enabled: Option<bool>,
    pub(super) enabled: bool,
    pub(super) working: bool,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct Settings {
    pub(super) default_enabled: bool,
}

#[derive(Default)]
pub(super) struct Tab {
    pub(super) override_enabled: Option<bool>,
    pub(super) working: bool,
}

#[derive(Default)]
pub(super) struct Shared {
    snapshot: Mutex<Arc<Snapshot>>,
    pub(super) epoch: AtomicU64,
    pub(super) dirty: AtomicBool,
    pub(super) thread: OnceLock<Thread>,
}

impl Shared {
    pub(super) fn current(&self) -> Arc<Snapshot> {
        let current = self.snapshot.lock().unwrap_or_else(PoisonError::into_inner);
        Arc::clone(&current)
    }

    /// Swap once; the stored and emitted views share the same immutable data.
    pub(super) fn update(&self, mut next: Snapshot) -> Option<Arc<Snapshot>> {
        let mut current = self.snapshot.lock().unwrap_or_else(PoisonError::into_inner);
        next.revision = current.revision;
        if **current == next {
            return None;
        }
        next.revision = current.revision.saturating_add(1);
        let next = Arc::new(next);
        *current = Arc::clone(&next);
        drop(current);
        Some(next)
    }

    pub(super) fn wake(&self) {
        if let Some(thread) = self.thread.get() {
            thread.unpark();
        }
    }

    pub(super) fn worker_failed(&self, error: &str) -> Option<Arc<Snapshot>> {
        let current = self.current();
        let error = current.error.as_ref().map_or_else(
            || error.to_owned(),
            |existing| format!("{error}; {existing}"),
        );
        self.update(Snapshot {
            revision: current.revision,
            default_enabled: current.default_enabled,
            active: current.active,
            error: Some(error.into()),
            // Error publication shares the unchanged tab projection.
            sessions: Arc::clone(&current.sessions),
        })
    }
}
