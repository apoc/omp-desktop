//! App-managed headless Chromium backing the per-tab browser panel.
//!
//! One [`BrowserManager`] entry per tab: a loopback placeholder port (the
//! `cdpUrl` omp is given through a settings overlay file, see
//! [`BrowserManager::allocate`]) in front of a lazily launched Chromium with
//! its own throwaway profile. A tab's browser survives its omp process being
//! respawned (profile switch); only closing the tab ([`BrowserManager::release`])
//! or leaving the app ends it.

mod annotate;
mod cdp;
pub mod commands;
mod emit;
mod launch;
mod locate;
pub mod proxy;
mod reap;
mod tap;
mod view;
mod view_core;
mod view_events;
mod view_input;
mod view_model;
mod view_worker;
mod ws_frames;

#[cfg(test)]
mod annotate_tests;
#[cfg(test)]
mod cdp_tests;
#[cfg(test)]
mod tap_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod view_tests;
#[cfg(test)]
mod ws_frames_tests;

use std::collections::HashMap;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::agent::supervisor::pid_is_alive;
use launch::Chromium;
use locate::find_chromium;
use proxy::Proxy;

/// Initial window of every launched Chromium; the panel resizes it later.
const WINDOW: (u32, u32) = (1280, 800);

/// Longest session id accepted; ids become file names.
const MAX_ID_LEN: usize = 64;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Session ids come over IPC and end up in file names: letters, digits, `-`
/// and `_` only.
fn check_session_id(id: &str) -> Result<(), String> {
    let valid = !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if valid {
        Ok(())
    } else {
        Err(format!("invalid session id {id:?}"))
    }
}

/// The Chromium of one session. [`Slot::ensure`] is the proxy's `Ensure`:
/// its lock serialises launches, so concurrent first connections start one
/// browser, and it is per session, so a slow launch blocks no other tab.
struct Slot {
    session_id: String,
    /// `<instance dir>/profiles`; each launch gets `<session_id>-<n>` in there.
    profiles: PathBuf,
    home: PathBuf,
    /// The user's browser choice, refreshed by every `allocate`.
    pref: Mutex<Option<PathBuf>>,
    launches: AtomicU32,
    closed: AtomicBool,
    chromium: Mutex<Option<Chromium>>,
}

impl Slot {
    /// The live Chromium's port, launching or relaunching it when there is
    /// none or it died.
    fn ensure(&self) -> Result<u16, String> {
        let mut slot = lock(&self.chromium);
        if self.closed.load(Ordering::SeqCst) {
            return Err("browser closed".into());
        }
        if let Some(chromium) = slot.as_ref().filter(|c| c.is_alive()) {
            return Ok(chromium.port());
        }
        if let Some(dead) = slot.take() {
            dead.stop(); // reaps it and removes its profile
        }
        let pref = lock(&self.pref).clone(); // owned: the lock must not span the launch
        let binary = find_chromium(pref.as_deref(), &self.home)
            .ok_or("no Chromium found: set a browser path in the settings or install Chrome")?;
        let n = self.launches.fetch_add(1, Ordering::Relaxed);
        let profile = self.profiles.join(format!("{}-{n}", self.session_id));
        private_dirs(true)
            .create(&self.profiles)
            .map_err(|e| format!("browser profile dir: {e}"))?;
        let chromium = Chromium::start(&binary, &profile, WINDOW.0, WINDOW.1)?;
        let port = chromium.port();
        *slot = Some(chromium);
        drop(slot);
        Ok(port)
    }
}

struct Entry {
    proxy: Proxy,
    slot: Arc<Slot>,
    overlay: PathBuf,
    /// The panel's view while it is open (`commands.rs`); also what the
    /// proxy reports the agent's pages to.
    view: Arc<commands::ViewSlot>,
    /// `true` once the teardown has finished. Held for its whole duration,
    /// so concurrent [`close`](Self::close) callers wait for the first one.
    torn_down: Mutex<bool>,
}

impl Entry {
    /// Cut the agent's connections, kill the browser, delete its profile and
    /// the overlay. Waits for a launch in flight, then stops what it started.
    /// Safe to call again, also concurrently: later callers return once the
    /// first teardown is complete.
    fn close(&self) {
        let mut torn_down = lock(&self.torn_down);
        if *torn_down {
            return;
        }
        self.slot.closed.store(true, Ordering::SeqCst);
        // Cut the panel's connection before the browser it points at goes.
        let view = lock(&self.view).close();
        if let Some(view) = view {
            view.close();
        }
        self.proxy.shutdown();
        let chromium = lock(&self.slot.chromium).take();
        if let Some(chromium) = chromium {
            chromium.stop();
        }
        let _ = std::fs::remove_file(&self.overlay);
        *torn_down = true;
    }
}

/// A directory builder that creates `0700` directories (unix).
fn private_dirs(recursive: bool) -> std::fs::DirBuilder {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(recursive);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder
}

/// Create the overlay file exclusively (`O_EXCL`: never follows a symlink
/// nor reuses a file somebody else put there), private to the user (unix).
fn write_overlay(path: &Path, port: u16) -> io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path)?;
    let written = write!(file, "browser:\n  cdpUrl: \"http://127.0.0.1:{port}\"\n");
    if written.is_err() {
        drop(file);
        let _ = std::fs::remove_file(path);
    }
    written
}

/// Create this process's private directory `<root>/<pid>` and delete the
/// directories of processes that no longer exist (a crashed earlier run's
/// leftovers; best effort). Directories of live processes - another app
/// instance sharing `root` - are never touched. `root` itself must be a real
/// directory, not a symlink.
fn prepare_instance_dir(root: &Path) -> io::Result<PathBuf> {
    match std::fs::symlink_metadata(root) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Err(io::Error::other("not a real directory")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => private_dirs(true).create(root)?,
        Err(e) => return Err(e),
    }
    let own = std::process::id();
    for entry in std::fs::read_dir(root).into_iter().flatten().flatten() {
        let dead = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
            .is_some_and(|pid| pid != own && !pid_is_alive(pid));
        if dead && entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            let path = entry.path();
            if reap::before_pruning(&path) {
                let _ = std::fs::remove_dir_all(path);
            }
        }
    }
    let instance = root.join(own.to_string());
    match private_dirs(false).create(&instance) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            if !std::fs::symlink_metadata(&instance)?.is_dir() {
                return Err(io::Error::other("instance path is not a real directory"));
            }
        }
        Err(e) => return Err(e),
    }
    Ok(instance)
}

#[derive(Default)]
struct State {
    entries: HashMap<String, Arc<Entry>>,
    /// Entries taken out of `entries` whose teardown is not finished yet.
    /// [`BrowserManager::shutdown_all`] waits for these too.
    closing: Vec<Arc<Entry>>,
}

/// Per-session browsers, managed as Tauri state.
pub struct BrowserManager {
    /// `<root>/<pid>`, private to this process (it holds `profiles/` and the
    /// overlays), or why there is none; then [`allocate`](Self::allocate)
    /// always fails.
    instance: Result<PathBuf, String>,
    home: PathBuf,
    state: Mutex<State>,
}

impl BrowserManager {
    /// `root` is a user-private directory (the app cache dir in production),
    /// shared by every running app instance; this one works in `<root>/<pid>`.
    /// Fails when `root` is a symlink or the directory cannot be created.
    pub fn new(root: PathBuf, home: PathBuf) -> Result<Self, String> {
        let instance = prepare_instance_dir(&root)
            .map_err(|e| format!("browser dir {}: {e}", root.display()))?;
        Ok(Self {
            instance: Ok(instance),
            home,
            state: Mutex::new(State::default()),
        })
    }

    /// A manager that has no working directory: every
    /// [`allocate`](Self::allocate) fails with `reason`, so sessions start
    /// without a managed browser.
    pub fn unavailable(reason: String) -> Self {
        Self {
            instance: Err(reason),
            home: PathBuf::new(),
            state: Mutex::new(State::default()),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        lock(&self.state)
    }

    /// Bind the session's placeholder port and write the overlay file omp
    /// takes as `--config=<path>`; returns its path. Idempotent: a session
    /// that already has a browser keeps it (and learns the new `pref`).
    /// Chromium itself starts on the first connection to the placeholder.
    pub fn allocate(&self, session_id: &str, pref: Option<&Path>) -> Result<PathBuf, String> {
        let instance = self.instance.as_ref().map_err(Clone::clone)?;
        check_session_id(session_id)?;
        let mut state = self.state();
        if let Some(entry) = state.entries.get(session_id) {
            *lock(&entry.slot.pref) = pref.map(Path::to_path_buf);
            return Ok(entry.overlay.clone()); // the caller owns the path it gets
        }
        if state
            .closing
            .iter()
            .any(|e| e.slot.session_id == session_id)
        {
            return Err(format!("browser of session {session_id} is still closing"));
        }
        let slot = Arc::new(Slot {
            session_id: session_id.to_owned(),
            profiles: instance.join("profiles"),
            home: self.home.clone(), // the slot outlives any borrow of the manager
            pref: Mutex::new(pref.map(Path::to_path_buf)),
            launches: AtomicU32::new(0),
            closed: AtomicBool::new(false),
            chromium: Mutex::new(None),
        });
        let launcher = Arc::clone(&slot);
        let view = Arc::new(commands::ViewSlot::default());
        let reporter = Arc::clone(&view);
        let proxy = Proxy::bind(
            Arc::new(move || launcher.ensure()),
            Arc::new(move |target| lock(&reporter).agent_worked_in(target)),
        )
        .map_err(|e| format!("browser proxy: {e}"))?;
        let overlay = instance.join(format!("{session_id}.yml"));
        write_overlay(&overlay, proxy.port()).map_err(|e| format!("browser overlay: {e}"))?;
        state.entries.insert(
            session_id.to_owned(),
            Arc::new(Entry {
                proxy,
                slot,
                overlay: overlay.clone(), // the entry keeps it for `close`
                torn_down: Mutex::new(false),
                view,
            }),
        );
        drop(state);
        Ok(overlay)
    }

    /// The placeholder port omp connects to.
    // The tests read it; omp learns the port from the overlay file.
    #[cfg(test)]
    pub fn port(&self, session_id: &str) -> Option<u16> {
        self.state()
            .entries
            .get(session_id)
            .map(|entry| entry.proxy.port())
    }

    /// The live Chromium's own debugging port, launching it when needed (the
    /// panel's CDP client connects here, not through the proxy).
    pub fn chromium_port(&self, session_id: &str) -> Result<u16, String> {
        let slot = self
            .state()
            .entries
            .get(session_id)
            .map(|entry| Arc::clone(&entry.slot))
            .ok_or_else(|| format!("no browser for session {session_id}"))?;
        slot.ensure() // outside the map lock: a launch must not block other tabs
    }

    /// End the session's browser (see [`Entry::close`]). Idempotent; returns
    /// only once the teardown is complete, also when another thread started
    /// it.
    pub fn release(&self, session_id: &str) {
        let entry = {
            let mut state = self.state();
            if let Some(entry) = state.entries.remove(session_id) {
                state.closing.push(Arc::clone(&entry));
                Some(entry)
            } else {
                state
                    .closing
                    .iter()
                    .find(|e| e.slot.session_id == session_id)
                    .cloned()
            }
        };
        if let Some(entry) = entry {
            self.finish_close(&entry);
        }
    }

    /// Release every session, including the ones whose release is still in
    /// flight (a close waiting for a slow launch). For app exit, where
    /// managed state is not dropped.
    pub fn shutdown_all(&self) {
        let all = {
            let mut state = self.state();
            let live: Vec<_> = state.entries.drain().map(|(_, entry)| entry).collect();
            state.closing.extend(live);
            // Keep shared entries alive while teardown runs outside the map
            // lock; concurrent release callers must still find and await them.
            state.closing.clone()
        };
        for entry in &all {
            self.finish_close(entry);
        }
        if let Ok(instance) = &self.instance {
            let _ = std::fs::remove_dir_all(instance);
        }
    }

    /// Tear the entry down (waiting for a concurrent teardown), then forget
    /// it. The map lock is not held meanwhile.
    fn finish_close(&self, entry: &Arc<Entry>) {
        entry.close();
        self.state().closing.retain(|e| !Arc::ptr_eq(e, entry));
    }

    /// Kills the session's Chromium but leaves the entry, as a crash would.
    #[cfg(test)]
    fn kill_chromium_for_test(&self, session_id: &str) {
        let slot = self
            .state()
            .entries
            .get(session_id)
            .map(|e| Arc::clone(&e.slot));
        if let Some(slot) = slot {
            if let Some(chromium) = lock(&slot.chromium).as_ref() {
                chromium.stop();
            }
        }
    }

    /// Profile directory of the session's most recent launch.
    #[cfg(test)]
    fn profile_dir_for_test(&self, session_id: &str) -> Option<PathBuf> {
        let slot = self
            .state()
            .entries
            .get(session_id)
            .map(|e| Arc::clone(&e.slot))?;
        let n = slot.launches.load(Ordering::Relaxed).checked_sub(1)?;
        Some(slot.profiles.join(format!("{session_id}-{n}")))
    }
}

impl Drop for BrowserManager {
    fn drop(&mut self) {
        self.shutdown_all();
    }
}
