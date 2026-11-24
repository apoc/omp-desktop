//! Persistence for the core's state files: settings, schedule, budget and
//! inbox. Unreadable files are moved aside before their defaults can be saved.

use super::Core;
use crate::budget::Budget;
use crate::scheduler::Now;
use chrono::NaiveDate;
use omp_desktop_core::json_store::write_atomic;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::io::ErrorKind;
use std::path::Path;

/// Which state files may be written. Unreadable files that could not be moved
/// aside stay write-protected so defaults never replace the original bytes.
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

/// Read a state file. A missing file uses defaults. An unreadable file is
/// moved aside before defaults may be written; if that fails, writes stay off.
pub(super) fn read_json<T: DeserializeOwned + Default>(
    path: &Path,
    what: &str,
    now_ms: i64,
) -> (T, bool) {
    let unreadable = |error: &std::io::Error| {
        eprintln!("[omp-desktopd] {what} file unreadable: {error}");
        let moved = move_aside(path, now_ms);
        if !moved {
            eprintln!("[omp-desktopd] could not move unreadable {what} file aside");
        }
        (T::default(), moved)
    };
    match std::fs::read(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => (T::default(), true),
        Err(error) => unreadable(&error),
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(value) => (value, true),
            Err(error) => unreadable(&std::io::Error::new(ErrorKind::InvalidData, error)),
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
/// `<file_name>.bad-<now_ms>` and replaced by a counter whose whole daily
/// allowance is spent; when even the rename fails that conservative counter
/// stays memory-only so the unreadable file is never overwritten.
///
/// The middle return value is the user notice for a reset file, the last one
/// says whether the conservative counter may be persisted.
pub(super) fn load_budget(path: &Path, now: &Now, limit: u64) -> (Budget, Option<String>, bool) {
    let today = now.local.date();
    let bytes = match std::fs::read(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return (Budget::new(0, today), None, true);
        }
        Err(error) => {
            eprintln!("[omp-desktopd] budget file unreadable: {error}");
            return reset_budget(path, today, limit, now.utc_ms);
        }
        Ok(bytes) => bytes,
    };
    match serde_json::from_slice::<Budget>(&bytes) {
        Ok(budget) => (budget, None, true),
        Err(error) => {
            eprintln!("[omp-desktopd] budget file corrupt: {error}");
            reset_budget(path, today, limit, now.utc_ms)
        }
    }
}

/// Start a conservative counter for `today` after moving the unreadable file
/// aside: without trustworthy usage, the whole daily limit counts as spent.
fn reset_budget(
    path: &Path,
    today: NaiveDate,
    limit: u64,
    now_ms: i64,
) -> (Budget, Option<String>, bool) {
    let mut budget = Budget::new(limit, today);
    budget.used = budget.limit;
    if move_aside(path, now_ms) {
        (
            budget,
            Some(
                "Budget file was unreadable and was moved aside; today's token limit is treated as spent"
                    .into(),
            ),
            true,
        )
    } else {
        (
            budget,
            Some(
                "Budget file could not be read or moved aside; today's token limit is treated as spent and the counter will not be saved"
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::budget::BudgetState;
    use chrono::NaiveDate;
    use omp_desktop_core::persona_protocol::PersonaSettings;
    use omp_desktop_core::test_support::TempDir;

    fn now() -> Now {
        let local = NaiveDate::from_ymd_opt(2026, 11, 24)
            .unwrap()
            .and_hms_opt(9, 0, 0)
            .unwrap();
        Now {
            utc_ms: 1_234,
            local,
        }
    }

    #[test]
    fn unreadable_settings_are_moved_aside_before_defaults_are_written() {
        let temp = TempDir::new("desktopd-store", "settings");
        let path = temp.path().join("settings.json");
        std::fs::write(&path, b"not json").unwrap();

        let (_settings, writable) = read_json::<PersonaSettings>(&path, "settings", 1_234);
        assert!(writable);
        assert!(!path.exists());
        let aside = temp.path().join("settings.json.bad-1234");
        assert_eq!(std::fs::read(&aside).unwrap(), b"not json");

        write_json(&path, &PersonaSettings::default(), "settings");
        assert!(serde_json::from_slice::<PersonaSettings>(&std::fs::read(&path).unwrap()).is_ok());
        assert_eq!(std::fs::read(&aside).unwrap(), b"not json");
    }

    #[test]
    fn unreadable_schedule_is_moved_aside_before_defaults_are_written() {
        let temp = TempDir::new("desktopd-store", "schedule");
        let path = temp.path().join("schedule.json");
        std::fs::write(&path, b"not json").unwrap();

        let (_schedule, writable) =
            read_json::<Vec<crate::scheduler::Scheduled>>(&path, "schedule", 1_234);
        assert!(writable);
        let aside = temp.path().join("schedule.json.bad-1234");
        assert_eq!(std::fs::read(&aside).unwrap(), b"not json");

        write_json(
            &path,
            &Vec::<crate::scheduler::Scheduled>::new(),
            "schedule",
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "[]");
        assert_eq!(std::fs::read(&aside).unwrap(), b"not json");
    }

    #[test]
    fn corrupt_budget_spends_the_day_instead_of_resetting_the_counter() {
        let temp = TempDir::new("desktopd-store", "budget");
        let path = temp.path().join("budget.json");
        std::fs::write(&path, b"not json").unwrap();

        let (budget, notice, writable) = load_budget(&path, &now(), 500_000);
        assert_eq!(budget.state(), BudgetState::Exhausted);
        assert_eq!(budget.used, 500_000);
        assert!(writable);
        assert!(notice.unwrap().contains("limit"));
        assert_eq!(
            std::fs::read(temp.path().join("budget.json.bad-1234")).unwrap(),
            b"not json"
        );
    }
}
