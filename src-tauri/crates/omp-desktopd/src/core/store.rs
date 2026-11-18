//! Persistence for the core's state files: settings, schedule, budget and
//! inbox. A file that could not be read stays untouched until the next
//! successful write of its owning message.

use super::Core;
use crate::budget::Budget;
use crate::scheduler::Now;
use chrono::NaiveDate;
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
    /// Prune expired settled items, then persist the inbox.
    pub(super) fn persist_inbox(&mut self, now_ms: i64) {
        self.inbox.prune(now_ms);
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

/// Load today's budget. A missing file starts a fresh counter that is written
/// normally. A corrupt or unreadable file is renamed to
/// `<file_name>.bad-<now_ms>` and replaced by a fresh counter; when even the
/// rename fails the fresh counter stays memory-only so the unreadable file is
/// never overwritten.
///
/// The middle return value is the user notice for a reset file, the last one
/// says whether the fresh counter may be persisted.
pub(super) fn load_budget(path: &Path, now: &Now) -> (Budget, Option<String>, bool) {
    let today = now.local.date();
    let bytes = match std::fs::read(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return (Budget::new(0, today), None, true);
        }
        Err(error) => {
            eprintln!("[omp-desktopd] budget file unreadable: {error}");
            return reset_budget(path, today, now.utc_ms);
        }
        Ok(bytes) => bytes,
    };
    match serde_json::from_slice::<Budget>(&bytes) {
        Ok(budget) => (budget, None, true),
        Err(error) => {
            eprintln!("[omp-desktopd] budget file corrupt: {error}");
            reset_budget(path, today, now.utc_ms)
        }
    }
}

/// Start a fresh counter for `today` after moving the unreadable file aside.
fn reset_budget(path: &Path, today: NaiveDate, now_ms: i64) -> (Budget, Option<String>, bool) {
    if move_aside(path, now_ms) {
        (
            Budget::new(0, today),
            Some("Budget file was unreadable and was reset; today's counter starts at zero".into()),
            true,
        )
    } else {
        (
            Budget::new(0, today),
            Some(
                "Budget file could not be read or moved aside; today's counter starts at zero and \
                 will not be saved"
                    .into(),
            ),
            false,
        )
    }
}

/// Rename `path` to `<file_name>.bad-<now_ms>`.
fn move_aside(path: &Path, now_ms: i64) -> bool {
    let Some(file_name) = path.file_name() else {
        return false;
    };
    let mut bad_name = file_name.to_os_string();
    bad_name.push(format!(".bad-{now_ms}"));
    std::fs::rename(path, path.with_file_name(bad_name)).is_ok()
}
