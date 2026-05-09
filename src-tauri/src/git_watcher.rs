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
    /// On every filesystem event that names the HEAD file, re-reads the
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
            // notify watches the parent dir on Windows (ReadDirectoryChangesW),
            // so filter to events whose changed path is named "HEAD".
            let hits_head = event
                .paths
                .iter()
                .any(|p| p.file_name().is_some_and(|n| n == "HEAD"));
            if !hits_head {
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
        // and macOS backends already behave internally.  The filename filter
        // in the callback above ensures only HEAD events trigger a re-read.
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
