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

/// What loading a state file found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Load {
    /// Read fine, or did not exist yet.
    Ok,
    /// Unreadable, but moved aside: defaults are in use and may be written.
    Reset,
    /// Unreadable and not moved aside: writing would replace the only copy.
    Protected,
}

impl Load {
    /// The write permission this load result grants.
    pub(super) const fn access(self) -> WriteAccess {
        match self {
            Self::Protected => WriteAccess::Protected,
            Self::Ok | Self::Reset => WriteAccess::Allowed,
        }
    }

    /// Whether the user must hear that the file's content was reset.
    pub(super) const fn reset(self) -> bool {
        !matches!(self, Self::Ok)
    }
}

/// Whether one state file may be written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum WriteAccess {
    /// The file may be written; no stored bytes can be lost.
    Allowed,
    /// An unreadable file could not be moved aside, so a write would replace
    /// the only copy. Lifts only when a later quarantine succeeds.
    Protected,
}

/// Which state files may be written.
#[derive(Debug, Clone, Copy)]
pub(super) struct Writes {
    pub(super) settings: WriteAccess,
    pub(super) schedule: WriteAccess,
    pub(super) budget: WriteAccess,
}

impl Core {
    /// Prune expired settled items, then persist the inbox.
    pub(super) fn persist_inbox(&mut self, now_ms: i64) {
        self.inbox.prune(now_ms);
        if let Err(error) = self.inbox.save() {
            eprintln!("[omp-desktopd] could not save the inbox: {error}");
        }
    }

    /// Persist the settings; `false` when a protected file refused the write.
    pub(super) fn persist_settings(&mut self, now_ms: i64) -> bool {
        write_state(
            &mut self.writes.settings,
            &self.paths.settings,
            &self.settings,
            "settings",
            now_ms,
        )
    }

    /// Persist the schedule; `false` when a protected file refused the write.
    pub(super) fn persist_schedule(&mut self, now_ms: i64) -> bool {
        write_state(
            &mut self.writes.schedule,
            &self.paths.schedule,
            self.scheduler.scheduled(),
            "schedule",
            now_ms,
        )
    }

    /// Persist today's budget; `false` when a protected file refused the write.
    pub(super) fn persist_budget(&mut self, now_ms: i64) -> bool {
        write_state(
            &mut self.writes.budget,
            &self.paths.budget,
            &self.budget,
            "budget",
            now_ms,
        )
    }
}

/// Read a state file. A missing file uses defaults. An unreadable file is
/// moved aside before defaults may be written; if that fails, writes stay off.
pub(super) fn read_json<T: DeserializeOwned + Default>(
    path: &Path,
    what: &str,
    now_ms: i64,
) -> (T, Load) {
    let unreadable = |error: &std::io::Error| {
        eprintln!("[omp-desktopd] {what} file unreadable: {error}");
        if move_aside(path, now_ms) {
            (T::default(), Load::Reset)
        } else {
            eprintln!("[omp-desktopd] could not move unreadable {what} file aside");
            (T::default(), Load::Protected)
        }
    };
    match std::fs::read(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => (T::default(), Load::Ok),
        Err(error) => unreadable(&error),
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(value) => (value, Load::Ok),
            Err(error) => unreadable(&std::io::Error::new(ErrorKind::InvalidData, error)),
        },
    }
}

/// Write `value` to `path`, unless `access` is [`WriteAccess::Protected`].
///
/// A protected file is quarantined again first, so protection lifts as soon as
/// the unreadable original can be moved aside instead of being replaced.
/// Returns whether the value reached the disk.
fn write_state<T: Serialize + ?Sized>(
    access: &mut WriteAccess,
    path: &Path,
    value: &T,
    what: &str,
    now_ms: i64,
) -> bool {
    if *access == WriteAccess::Protected {
        if !move_aside(path, now_ms) {
            eprintln!("[omp-desktopd] not saving {what}: the unreadable file is still in place");
            return false;
        }
        eprintln!("[omp-desktopd] unreadable {what} file moved aside; writing is enabled again");
        *access = WriteAccess::Allowed;
    }
    write_json(path, value, what)
}

/// Write `value` as pretty JSON to `path` through the shared atomic writer.
/// A failed write is logged; the service keeps running on its in-memory state.
fn write_json<T: Serialize + ?Sized>(path: &Path, value: &T, what: &str) -> bool {
    let written = serde_json::to_vec_pretty(value)
        .map_err(std::io::Error::other)
        .and_then(|bytes| write_atomic(path, &bytes));
    if let Err(error) = written {
        eprintln!("[omp-desktopd] could not save {what}: {error}");
        return false;
    }
    true
}

/// Load today's budget. A missing file starts a fresh counter that is written
/// normally. A corrupt or unreadable file's bytes are copied to
/// `<file_name>.bad-<now_ms>` and replaced by a counter whose whole daily
/// allowance is spent; when even the copy fails that conservative counter
/// stays memory-only so the unreadable file is never overwritten.
///
/// The middle return value is the user notice for a reset file, the last one
/// says whether the conservative counter may be persisted.
pub(super) fn load_budget(path: &Path, now: &Now, limit: u64) -> (Budget, Option<String>, Load) {
    let today = now.local.date();
    let bytes = match std::fs::read(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return (Budget::new(0, today), None, Load::Ok);
        }
        Err(error) => {
            eprintln!("[omp-desktopd] budget file unreadable: {error}");
            return reset_budget(path, today, limit, now.utc_ms);
        }
        Ok(bytes) => bytes,
    };
    match serde_json::from_slice::<Budget>(&bytes) {
        Ok(budget) => (budget, None, Load::Ok),
        Err(error) => {
            eprintln!("[omp-desktopd] budget file corrupt: {error}");
            reset_budget(path, today, limit, now.utc_ms)
        }
    }
}

/// Start a conservative counter for `today`: without trustworthy usage, the
/// whole daily limit counts as spent.
///
/// The unreadable bytes are preserved first and the exhausted counter is
/// written before the corrupt file is gone: a crash between those steps leaves
/// the corrupt file in place for the next start to quarantine again, never a
/// missing budget that would grant a fresh allowance.
fn reset_budget(
    path: &Path,
    today: NaiveDate,
    limit: u64,
    now_ms: i64,
) -> (Budget, Option<String>, Load) {
    let mut budget = Budget::new(limit, today);
    budget.used = budget.limit;
    if !copy_aside(path, now_ms) {
        return (
            budget,
            Some(
                "Budget file could not be read or moved aside; today's token limit is treated as spent and the counter will not be saved"
                    .into(),
            ),
            Load::Protected,
        );
    }
    let notice = if write_json(path, &budget, "budget") {
        "Budget file was unreadable; the file was kept and today's token limit is treated as spent"
    } else {
        "Budget file was unreadable; today's token limit is treated as spent, but the counter could not be saved yet"
    };
    (budget, Some(notice.into()), Load::Reset)
}

/// Copy `path` to `<file_name>.bad-<now_ms>`.
///
/// Unlike [`move_aside`], the original stays in place, so a file whose bytes
/// must be preserved can be replaced afterwards without a window in which
/// neither copy exists.
fn copy_aside(path: &Path, now_ms: i64) -> bool {
    let Some(target) = aside_path(path, now_ms) else {
        return false;
    };
    std::fs::copy(path, target).is_ok()
}

/// Rename `path` to `<file_name>.bad-<now_ms>`.
fn move_aside(path: &Path, now_ms: i64) -> bool {
    let Some(target) = aside_path(path, now_ms) else {
        return false;
    };
    std::fs::rename(path, target).is_ok()
}

/// `<file_name>.bad-<now_ms>` next to `path`.
fn aside_path(path: &Path, now_ms: i64) -> Option<std::path::PathBuf> {
    let file_name = path.file_name()?;
    let mut bad_name = file_name.to_os_string();
    bad_name.push(format!(".bad-{now_ms}"));
    Some(path.with_file_name(bad_name))
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

        let (_settings, load) = read_json::<PersonaSettings>(&path, "settings", 1_234);
        assert_eq!(load, Load::Reset);
        assert!(load.reset());
        assert_eq!(load.access(), WriteAccess::Allowed);
        assert!(!path.exists());
        let aside = temp.path().join("settings.json.bad-1234");
        assert_eq!(std::fs::read(&aside).unwrap(), b"not json");

        let mut access = load.access();
        assert!(write_state(
            &mut access,
            &path,
            &PersonaSettings::default(),
            "settings",
            1_234
        ));
        assert!(serde_json::from_slice::<PersonaSettings>(&std::fs::read(&path).unwrap()).is_ok());
        assert_eq!(std::fs::read(&aside).unwrap(), b"not json");
    }

    #[test]
    fn unreadable_schedule_is_moved_aside_before_defaults_are_written() {
        let temp = TempDir::new("desktopd-store", "schedule");
        let path = temp.path().join("schedule.json");
        std::fs::write(&path, b"not json").unwrap();

        let (_schedule, load) =
            read_json::<Vec<crate::scheduler::Scheduled>>(&path, "schedule", 1_234);
        assert_eq!(load, Load::Reset);
        let aside = temp.path().join("schedule.json.bad-1234");
        assert_eq!(std::fs::read(&aside).unwrap(), b"not json");

        let mut access = load.access();
        assert!(write_state(
            &mut access,
            &path,
            &Vec::<crate::scheduler::Scheduled>::new(),
            "schedule",
            1_234
        ));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "[]");
        assert_eq!(std::fs::read(&aside).unwrap(), b"not json");
    }

    #[test]
    fn a_file_that_cannot_be_moved_aside_is_never_replaced() {
        let temp = TempDir::new("desktopd-store", "protected");
        let path = temp.path().join("settings.json");
        std::fs::write(&path, b"not json").unwrap();
        // A directory squatting on the quarantine name makes the rename fail
        // while the directory holding the file stays writable, so only the
        // write protection keeps the original bytes alive.
        let aside = temp.path().join("settings.json.bad-1234");
        std::fs::create_dir(&aside).unwrap();

        let (_settings, load) = read_json::<PersonaSettings>(&path, "settings", 1_234);
        assert_eq!(load, Load::Protected);
        assert!(load.reset(), "the user is told about the reset");
        let mut access = load.access();
        assert_eq!(access, WriteAccess::Protected);
        assert!(!write_state(
            &mut access,
            &path,
            &PersonaSettings::default(),
            "settings",
            1_234
        ));
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"not json",
            "the only copy of the file must survive"
        );

        // As soon as the quarantine succeeds, writes are allowed again.
        std::fs::remove_dir(&aside).unwrap();
        assert!(write_state(
            &mut access,
            &path,
            &PersonaSettings::default(),
            "settings",
            1_234
        ));
        assert_eq!(access, WriteAccess::Allowed);
        assert!(serde_json::from_slice::<PersonaSettings>(&std::fs::read(&path).unwrap()).is_ok());
        assert_eq!(std::fs::read(&aside).unwrap(), b"not json");
    }

    #[test]
    fn corrupt_budget_spends_the_day_instead_of_resetting_the_counter() {
        let temp = TempDir::new("desktopd-store", "budget");
        let path = temp.path().join("budget.json");
        std::fs::write(&path, b"not json").unwrap();

        let (budget, notice, load) = load_budget(&path, &now(), 500_000);
        assert_eq!(budget.state(), BudgetState::Exhausted);
        assert_eq!(budget.used, 500_000);
        assert_eq!(load, Load::Reset);
        assert!(notice.unwrap().contains("limit"));
        assert_eq!(
            std::fs::read(temp.path().join("budget.json.bad-1234")).unwrap(),
            b"not json",
            "the unreadable bytes are preserved"
        );
        let written: Budget = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            written.used, 500_000,
            "the exhausted counter is durable before the corrupt file could be gone"
        );
    }

    #[test]
    fn corrupt_budget_is_protected_when_it_cannot_be_copied_aside() {
        let temp = TempDir::new("desktopd-store", "budget-protected");
        let path = temp.path().join("budget.json");
        std::fs::write(&path, b"not json").unwrap();
        // The copy target is a directory, so the bytes cannot be preserved.
        std::fs::create_dir(temp.path().join("budget.json.bad-1234")).unwrap();

        let (budget, notice, load) = load_budget(&path, &now(), 500_000);
        assert_eq!(budget.state(), BudgetState::Exhausted);
        assert_eq!(load, Load::Protected);
        assert!(notice.unwrap().contains("will not be saved"));
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"not json",
            "an unpreserved budget file is never replaced"
        );
    }
}
