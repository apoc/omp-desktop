//! Persistence for the core's state files: settings, schedule, budget and
//! inbox. A file that could not be read stays untouched until the next
//! successful write of its owning message.

use super::Core;
use crate::budget::Budget;
use crate::scheduler::Now;
use omp_desktop_core::json_store::write_atomic;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::io::ErrorKind;
use std::path::Path;

/// Which state files may be written. A file that could not be read at startup
/// stays untouched until the next successful write of its owning message, so a
/// corrupt file is never silently replaced by defaults.
#[derive(Debug, Clone, Copy)]
pub(super) struct Writes {
    pub(super) settings: bool,
    pub(super) schedule: bool,
    pub(super) budget: bool,
}

impl Core {
    pub(super) fn persist_inbox(&self) {
        if let Err(error) = self.inbox.save() {
            eprintln!("[omp-desktopd] could not save the inbox: {error}");
        }
    }

    pub(super) fn persist_settings(&self) {
        if self.writes.settings {
            write_json(&self.paths.settings, &self.settings, "settings");
        }
    }

    pub(super) fn persist_schedule(&self) {
        if self.writes.schedule {
            write_json(
                &self.paths.schedule,
                &self.scheduler.scheduled(),
                "schedule",
            );
        }
    }

    pub(super) fn persist_budget(&self) {
        if self.writes.budget {
            write_json(&self.paths.budget, &self.budget, "budget");
        }
    }
}

/// Read a state file: `NotFound` is the default, a corrupt file is the default
/// plus `false` so the caller keeps it untouched.
pub(super) fn read_json<T: DeserializeOwned + Default>(path: &Path, what: &str) -> (T, bool) {
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
pub(super) fn write_json<T: Serialize>(path: &Path, value: &T, what: &str) {
    let written = serde_json::to_vec_pretty(value)
        .map_err(std::io::Error::other)
        .and_then(|bytes| write_atomic(path, &bytes));
    if let Err(error) = written {
        eprintln!("[omp-desktopd] could not save {what}: {error}");
    }
}

/// Load today's budget. `Budget` has no `Default` because its counter belongs
/// to a day, so a missing or corrupt file starts a fresh counter for today.
pub(super) fn load_budget(path: &Path, now: &Now) -> (Budget, bool) {
    let today = now.local.date();
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
