//! Per-session `.git/HEAD` file watcher.
//!
//! [`GitWatcherState`] is Tauri managed state that owns one
//! [`notify::RecommendedWatcher`] per live session. Dropping the watcher
//! (via [`GitWatcherState::stop`] or when the state is dropped) cancels
//! the OS-level watch automatically.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

use notify::{RecursiveMode, Watcher as _};
use tauri::{AppHandle, Emitter as _};

/// Holds one file watcher per session.  Thread-safe; suitable as Tauri
/// managed state.
pub struct GitWatcherState {
    watchers: Mutex<HashMap<String, notify::RecommendedWatcher>>,
}

impl GitWatcherState {
    pub fn new() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
        }
    }

    /// Begin watching `head_path` (`.git/HEAD`) for `session_id`.
    ///
    /// On every change to the HEAD file (see [`is_head_change`]), re-reads the
    /// current branch via [`crate::git::probe`] and emits
    /// `"git://branch/{session_id}"` on `app`.  Errors starting the watcher
    /// are propagated; the caller treats them as non-fatal so the branch
    /// chip simply won't update live.
    pub fn start(
        &self,
        session_id: &str,
        repo_path: &Path,
        head_path: PathBuf,
        app: AppHandle,
    ) -> Result<(), String> {
        let repo_owned = repo_path.to_owned();
        let sid = session_id.to_owned();

        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(event) = res else { return };
            if !is_head_change(&event) {
                return;
            }
            let (branch, _) = crate::git::probe(&repo_owned);
            if let Some(b) = branch {
                let _ = app.emit(&format!("git://branch/{sid}"), b);
            }
        })
        .map_err(|e| e.to_string())?;

        // Watch the *parent directory* non-recursively rather than the HEAD
        // file itself.  On Linux, inotify attaches to the inode; git writes
        // HEAD atomically via rename(HEAD.lock → HEAD), which replaces the
        // inode and orphans a file-level watch after the first branch switch.
        // Watching the parent avoids this and is also how notify's Windows
        // and macOS backends already behave internally.  [`is_head_change`]
        // in the callback above ensures only HEAD changes trigger a re-read.
        let git_dir = head_path
            .parent()
            .ok_or_else(|| "HEAD path has no parent".to_owned())?;
        watcher
            .watch(git_dir, RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())?;

        self.watchers.lock().map_or_else(
            |_| Err("git watcher state poisoned".to_owned()),
            |mut map| {
                map.insert(session_id.to_owned(), watcher);
                Ok(())
            },
        )
    }

    /// Stop watching for `session_id`.  No-op if no watcher is registered.
    pub fn stop(&self, session_id: &str) {
        if let Ok(mut map) = self.watchers.lock() {
            map.remove(session_id);
        }
    }
}

impl Default for GitWatcherState {
    fn default() -> Self {
        Self::new()
    }
}

/// Whether `event` is a change to a file named `HEAD`.
///
/// Name filter: notify watches the parent dir on Windows
/// (`ReadDirectoryChangesW`), and `start` watches the parent everywhere, so
/// events for sibling files (`index`, `HEAD.lock`, …) arrive too.
///
/// Access filter: since notify 7 inotify also reports `IN_OPEN` as
/// `Access(Open)`. [`crate::git::probe`] opens HEAD itself, so reacting to
/// opens would re-trigger the probe from its own read, forever. A branch
/// switch (`rename(HEAD.lock → HEAD)`) arrives as `Modify(Name)` and a
/// direct write as `Modify(Data)`, so no real change is lost.
fn is_head_change(event: &notify::Event) -> bool {
    !event.kind.is_access()
        && event
            .paths
            .iter()
            .any(|p| p.file_name().is_some_and(|n| n == "HEAD"))
}

#[cfg(test)]
mod tests {
    use super::is_head_change;
    use notify::event::{AccessKind, AccessMode, EventKind, ModifyKind, RenameMode};
    use notify::Event;

    #[test]
    fn opening_head_is_not_a_change() {
        // The probe's own read of HEAD must not look like a branch switch,
        // or every probe schedules the next one.
        let open = Event::new(EventKind::Access(AccessKind::Open(AccessMode::Any)))
            .add_path("/repo/.git/HEAD".into());
        assert!(!is_head_change(&open));
    }

    #[test]
    fn renaming_onto_head_is_a_change() {
        let switch = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To)))
            .add_path("/repo/.git/HEAD".into());
        assert!(is_head_change(&switch));
    }

    #[test]
    fn sibling_files_are_ignored() {
        let lock = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From)))
            .add_path("/repo/.git/HEAD.lock".into());
        assert!(!is_head_change(&lock));
    }
}
