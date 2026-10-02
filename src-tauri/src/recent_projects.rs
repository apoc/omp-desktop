//! Recently opened project folders, per omp profile (issue #27).
//!
//! Backs the project sidebar's `recent` section. The list is disposable
//! convenience data, so unlike `ProfileStore` there is no cache and no
//! snapshot ring: a missing or unreadable file reads as empty, and the next
//! write replaces it.
//!
//! On-disk shape (`<app config dir>/recent-projects.json`), newest first:
//!
//! ```json
//! { "entries": [ { "path": "/abs/canonical", "profile": "default", "openedAt": 1790000000000 } ] }
//! ```
//!
//! One list for every profile, keyed per entry, so a profile's recents never
//! leak into another profile's sidebar and a profile deleted from the menu
//! leaves only inert entries behind.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::json_store;

/// Entries kept per profile; older ones are dropped on the next touch.
pub const MAX_PER_PROFILE: usize = 20;

#[derive(Default, Serialize, Deserialize)]
struct RecentFile {
    #[serde(default)]
    entries: Vec<Entry>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    path: String,
    profile: String,
    opened_at: u64,
}

/// One row of a profile's recent list, as sent to the frontend.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    /// Unix epoch milliseconds of the last open.
    pub opened_at: u64,
}

/// Manages `<app config dir>/recent-projects.json`.
pub struct RecentProjectsStore {
    path: PathBuf,
    /// `path.with_extension("lock")`, computed once (same as `OverlayStore`).
    lock: PathBuf,
}

impl RecentProjectsStore {
    /// Create a store pointing at `path`. The file need not exist yet.
    pub fn new(path: PathBuf) -> Self {
        let lock = path.with_extension("lock");
        Self { path, lock }
    }

    /// `profile`'s recent folders, newest first, minus folders that no
    /// longer exist.
    ///
    /// Unlocked: `write_atomic` never exposes a half-written file, and a
    /// read racing a write only sees the previous list.
    pub fn list(&self, profile: &str) -> Vec<RecentProject> {
        entries_for(self.read(), profile)
    }

    /// Record `path` (already canonical) as opened now under `profile` and
    /// return that profile's updated list.
    pub fn touch(
        &self,
        profile: &str,
        path: String,
        now_ms: u64,
    ) -> Result<Vec<RecentProject>, String> {
        self.mutate(profile, |file| upsert(file, profile, path, now_ms))
    }

    /// Drop `path` from `profile`'s list and return the updated list.
    ///
    /// Exact match, no canonicalisation: `path` came from [`Self::list`],
    /// and the folder may already be gone from disk.
    pub fn remove(&self, profile: &str, path: &str) -> Result<Vec<RecentProject>, String> {
        self.mutate(profile, |file| {
            file.entries
                .retain(|e| !(e.profile == profile && e.path == path));
        })
    }

    /// Missing or unreadable ⇒ empty (see [`json_store::read_or_default`]).
    fn read(&self) -> RecentFile {
        json_store::read_or_default(&self.path)
    }

    /// Locked read-modify-write; returns `profile`'s list after `f`.
    /// `with_lock_str` creates the parent directory before locking.
    fn mutate(
        &self,
        profile: &str,
        f: impl FnOnce(&mut RecentFile),
    ) -> Result<Vec<RecentProject>, String> {
        json_store::with_lock_str(&self.lock, || {
            let mut file = self.read();
            f(&mut file);
            let bytes = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
            json_store::write_atomic(&self.path, &bytes)
                .map_err(|e| format!("write {}: {e}", self.path.display()))?;
            Ok(entries_for(file, profile))
        })
    }
}

/// Current time in Unix epoch milliseconds; `0` for a clock before 1970.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Move `(profile, path)` to the front with a fresh timestamp, then trim
/// `profile` to [`MAX_PER_PROFILE`] entries. Other profiles are untouched.
fn upsert(file: &mut RecentFile, profile: &str, path: String, now_ms: u64) {
    file.entries
        .retain(|e| !(e.profile == profile && e.path == path));
    file.entries.insert(
        0,
        Entry {
            path,
            profile: profile.to_owned(),
            opened_at: now_ms,
        },
    );
    let mut kept = 0usize;
    file.entries.retain(|e| {
        if e.profile != profile {
            return true;
        }
        kept += 1;
        kept <= MAX_PER_PROFILE
    });
}

/// `profile`'s entries in file order, skipping folders that no longer exist.
/// Stale entries are hidden, not deleted: a folder on an unmounted drive
/// comes back once the drive does.
fn entries_for(file: RecentFile, profile: &str) -> Vec<RecentProject> {
    file.entries
        .into_iter()
        .filter(|e| e.profile == profile && Path::new(&e.path).is_dir())
        .map(|e| RecentProject {
            path: e.path,
            opened_at: e.opened_at,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Scratch directory removed on drop, including after a failed assertion.
    struct ScratchGuard(PathBuf);

    impl Drop for ScratchGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    impl ScratchGuard {
        /// A fresh existing folder `name` inside the scratch dir, as the
        /// `String` a canonical recent entry would carry.
        fn folder(&self, name: &str) -> String {
            let dir = self.0.join(name);
            fs::create_dir_all(&dir).expect("create project dir");
            dir.into_os_string().into_string().expect("utf-8 temp path")
        }
    }

    fn scratch_store() -> (RecentProjectsStore, ScratchGuard) {
        let n = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "omp-desktop-recents-test-{}-{n}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        let store = RecentProjectsStore::new(dir.join("recent-projects.json"));
        (store, ScratchGuard(dir))
    }

    fn paths(list: &[RecentProject]) -> Vec<&str> {
        list.iter().map(|r| r.path.as_str()).collect()
    }

    /// [`RecentProjectsStore::touch`] for a path the test still reads
    /// afterwards: the owned copy `touch` stores is made here once, not as
    /// a `.clone()` at every callsite.
    fn touch_at(
        store: &RecentProjectsStore,
        profile: &str,
        path: &str,
        now_ms: u64,
    ) -> Vec<RecentProject> {
        store
            .touch(profile, path.to_owned(), now_ms)
            .expect("touch")
    }

    #[test]
    fn upsert_moves_existing_path_to_front_and_refreshes_time() {
        let mut file = RecentFile::default();
        upsert(&mut file, "default", "/a".into(), 1);
        upsert(&mut file, "default", "/b".into(), 2);
        upsert(&mut file, "default", "/a".into(), 3);

        let got: Vec<(&str, u64)> = file
            .entries
            .iter()
            .map(|e| (e.path.as_str(), e.opened_at))
            .collect();
        assert_eq!(got, vec![("/a", 3), ("/b", 2)]);
    }

    #[test]
    fn cap_trims_only_the_touched_profile() {
        let mut file = RecentFile::default();
        upsert(&mut file, "work", "/w".into(), 0);
        for i in 0..=MAX_PER_PROFILE {
            upsert(&mut file, "default", format!("/p{i}"), 1 + i as u64);
        }

        let defaults: Vec<&str> = file
            .entries
            .iter()
            .filter(|e| e.profile == "default")
            .map(|e| e.path.as_str())
            .collect();
        assert_eq!(defaults.len(), MAX_PER_PROFILE);
        // Newest kept, oldest (`/p0`) evicted.
        assert_eq!(defaults[0], format!("/p{MAX_PER_PROFILE}"));
        assert!(!defaults.contains(&"/p0"));
        assert!(file
            .entries
            .iter()
            .any(|e| e.profile == "work" && e.path == "/w"));
    }

    #[test]
    fn remove_only_drops_the_matching_profile_and_path() {
        let (store, scratch) = scratch_store();
        let a = scratch.folder("a");
        let b = scratch.folder("b");
        touch_at(&store, "default", &a, 1);
        touch_at(&store, "default", &b, 2);
        touch_at(&store, "work", &a, 3);

        let left = store.remove("default", &a).expect("remove");
        assert_eq!(paths(&left), vec![b.as_str()]);
        assert_eq!(paths(&store.list("work")), vec![a.as_str()]);
    }

    #[test]
    fn touch_then_list_round_trips_through_the_file() {
        let (store, scratch) = scratch_store();
        let a = scratch.folder("a");
        let b = scratch.folder("b");
        touch_at(&store, "default", &a, 10);
        let returned = touch_at(&store, "default", &b, 20);
        assert_eq!(paths(&returned), vec![b.as_str(), a.as_str()]);

        let reopened = RecentProjectsStore::new(scratch.0.join("recent-projects.json"));
        let listed = reopened.list("default");
        assert_eq!(paths(&listed), vec![b.as_str(), a.as_str()]);
        assert_eq!(listed[0].opened_at, 20);
        assert!(reopened.list("work").is_empty());
    }

    #[test]
    fn corrupt_file_lists_empty_and_touch_rewrites_it() {
        let (store, scratch) = scratch_store();
        let a = scratch.folder("a");
        fs::write(&store.path, b"{ not json").expect("write corrupt file");

        assert!(store.list("default").is_empty());
        touch_at(&store, "default", &a, 1);

        let bytes = fs::read(&store.path).expect("read rewritten file");
        let file: RecentFile = serde_json::from_slice(&bytes).expect("valid json");
        assert_eq!(file.entries.len(), 1);
        assert_eq!(paths(&store.list("default")), vec![a.as_str()]);
    }

    #[test]
    fn list_hides_a_deleted_folder_but_keeps_its_entry() {
        let (store, scratch) = scratch_store();
        let a = scratch.folder("a");
        let b = scratch.folder("b");
        touch_at(&store, "default", &a, 1);
        touch_at(&store, "default", &b, 2);
        fs::remove_dir(&b).expect("delete b");

        assert_eq!(paths(&store.list("default")), vec![a.as_str()]);
        assert_eq!(store.read().entries.len(), 2);
    }
}
