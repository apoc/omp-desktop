//! The edges towards the rest of the app: webview events, the tracker
//! fan-out and the webview-readiness reset on page loads.

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;

use tauri::{AppHandle, Emitter, Manager, Webview};

use super::emit::{Action, RemoteEmit, Status};
use super::hub::Hub;
use super::manager::RemoteManager;
use super::tracker::{TrackerSink, Transition};

/// The webview whose listeners answer phone requests.
const MAIN_WINDOW: &str = "main";

/// Emits what the hub and the manager have to say to the desktop webview.
pub struct TauriRemoteEmit(pub AppHandle);

impl TauriRemoteEmit {
    fn send<S: serde::Serialize + Clone>(&self, event: &str, payload: S) {
        if let Err(error) = self.0.emit(event, payload) {
            eprintln!("[omp-desktop] could not emit {event}: {error}");
        }
    }
}

impl RemoteEmit for TauriRemoteEmit {
    fn watch(&self, tab_ids: &[String]) {
        self.send("remote://watch", tab_ids);
    }

    /// The manager turns connection changes into a `status` call.
    fn connections(&self, _device_ids: &[String]) {}

    fn action(&self, action: &Action) {
        self.send("remote://action", action);
    }

    fn status(&self, status: &Status) {
        self.send("remote://status", status);
    }
}

/// What the tracker reported since the worker last ran: whether the tab list
/// needs a refresh, and the newest push-worthy transition per session.
#[derive(Default)]
struct Queue {
    refresh: bool,
    transitions: HashMap<String, Transition>,
    stop: bool,
}

struct FanOutInner {
    hub: Arc<Hub>,
    push: Mutex<Option<Arc<dyn TrackerSink>>>,
    queue: Mutex<Queue>,
    wake: Condvar,
}

impl FanOutInner {
    fn queue(&self) -> MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Block until there is work (or a stop); `None` once stopped.
    fn next(&self) -> Option<(bool, HashMap<String, Transition>)> {
        let mut queue = self.queue();
        while !queue.stop && !queue.refresh && queue.transitions.is_empty() {
            queue = self
                .wake
                .wait(queue)
                .unwrap_or_else(PoisonError::into_inner);
        }
        if queue.stop {
            return None;
        }
        let refresh = std::mem::take(&mut queue.refresh);
        let transitions = std::mem::take(&mut queue.transitions);
        drop(queue);
        Some((refresh, transitions))
    }

    fn work(&self) {
        while let Some((refresh, transitions)) = self.next() {
            if refresh {
                self.hub.refresh();
            }
            let target = self
                .push
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .as_ref()
                .map(Arc::clone);
            if let Some(target) = target {
                for (sid, transition) in transitions {
                    target.changed(&sid, Some(transition));
                }
            }
        }
    }
}

/// The tracker's single sink. It runs on the agent's stdout reader thread, so
/// it only records the change; a worker thread refreshes the phones' tab list
/// and hands transitions to the push target (which looks up the title).
/// Reports coalesce: one refresh covers any number of changes, and a session
/// keeps only its newest transition.
pub struct FanOut {
    inner: Arc<FanOutInner>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl FanOut {
    pub fn new(hub: Arc<Hub>) -> Result<Self, String> {
        let inner = Arc::new(FanOutInner {
            hub,
            push: Mutex::new(None),
            queue: Mutex::new(Queue::default()),
            wake: Condvar::new(),
        });
        let worker_inner = Arc::clone(&inner);
        let worker = std::thread::Builder::new()
            .name("remote-fan-out".to_owned())
            .spawn(move || worker_inner.work())
            .map_err(|error| format!("start remote fan-out thread: {error}"))?;
        Ok(Self {
            inner,
            worker: Mutex::new(Some(worker)),
        })
    }

    pub fn set_push(&self, target: Option<Arc<dyn TrackerSink>>) {
        *self
            .inner
            .push
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = target;
    }

    /// Stop and join the worker; later reports are ignored.
    pub fn stop(&self) {
        {
            let mut queue = self.inner.queue();
            queue.stop = true;
            queue.refresh = false;
            queue.transitions.clear();
        }
        self.inner.wake.notify_all();
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(worker) = worker {
            let _ = worker.join();
        }
    }
}

impl TrackerSink for FanOut {
    fn changed(&self, sid: &str, transition: Option<Transition>) {
        {
            let mut queue = self.inner.queue();
            if queue.stop {
                return;
            }
            queue.refresh = true;
            if let Some(transition) = transition {
                queue.transitions.insert(sid.to_owned(), transition); // owned by the queue
            }
        }
        self.inner.wake.notify_one();
    }
}

impl Drop for FanOut {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Create the manager and start the saved configuration. Its tracker sink is
/// combined with desktop notifications by the app. Without a config directory,
/// phone access stays unavailable but desktop notifications remain independent.
pub fn install(
    app: &tauri::App,
    config_dir: Option<std::path::PathBuf>,
) -> Option<Arc<dyn TrackerSink>> {
    let Some(dir) = config_dir else {
        eprintln!("[omp-desktop] remote access is unavailable without an app config dir");
        return None;
    };
    let manager = Arc::new(RemoteManager::new(
        dir,
        Arc::new(TauriRemoteEmit(app.handle().clone())), // the handle is a cheap shared clone
    ));
    let sink = manager
        .tracker_sink()
        .map(|sink| sink as Arc<dyn TrackerSink>);
    app.manage(Arc::clone(&manager));
    // Binding and certificate work must not delay the window.
    let started = std::thread::Builder::new()
        .name("remote-start".to_owned())
        .spawn(move || {
            manager.start_saved();
        });
    if let Err(error) = started {
        eprintln!("[omp-desktop] could not start remote access: {error}");
    }
    sink
}

/// The app is exiting: stop the tracker fan-out, close the listener and the
/// phone sockets.
pub fn stop(app: &AppHandle) {
    if let Some(manager) = app.try_state::<Arc<RemoteManager>>() {
        manager.stop();
    }
}

/// A page load or navigation drops the webview's listeners: phones get 4503
/// until the page announces itself again with `remote_ready(true)`.
pub fn on_page_load(webview: &Webview, started: bool) {
    if started && webview.label() == MAIN_WINDOW {
        if let Some(manager) = webview.app_handle().try_state::<Arc<RemoteManager>>() {
            let manager = Arc::clone(&*manager);
            tauri::async_runtime::spawn_blocking(move || manager.hub().set_ready(false));
        }
    }
}

#[cfg(test)]
#[path = "bridge_tests.rs"]
mod tests;
