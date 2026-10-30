//! One worker owns all native requests, tab policy and persistent settings.
//! Tracker callbacks merely mark a coalesced refresh and unpark that worker.

mod platform;
mod state;
mod worker;

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc, Mutex, PoisonError};
use std::thread::JoinHandle;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::remote::tracker::{self, TrackerSink, Transition};
use platform::Inhibitor;
#[cfg(test)]
use state::Session;
use state::Shared;
use worker::{Reply, Request, Worker};

pub use state::Snapshot;

const EVENT: &str = "keep-awake://changed";

pub struct KeepAwake {
    shared: Arc<Shared>,
    sender: mpsc::Sender<Request>,
    worker: Mutex<Option<JoinHandle<()>>>,
    remote: Option<Arc<dyn TrackerSink>>,
}

impl KeepAwake {
    fn new<S, F, I, P>(
        path: Option<PathBuf>,
        source: S,
        factory: F,
        publish: P,
        remote: Option<Arc<dyn TrackerSink>>,
    ) -> Arc<Self>
    where
        S: Fn() -> Arc<tracker::Snapshot> + Send + 'static,
        F: Fn() -> Result<I, String> + Send + 'static,
        I: Inhibitor + 'static,
        P: Fn(Arc<Snapshot>) + Send + 'static,
    {
        let shared = Arc::new(Shared::default());
        let (sender, receiver) = mpsc::channel();
        let worker_shared = Arc::clone(&shared);
        let worker = std::thread::Builder::new()
            .name("keep-awake".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let mut worker =
                        Worker::new(Arc::clone(&worker_shared), path, source, factory, &publish);
                    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        worker.run(receiver);
                    }));
                    if outcome.is_err() {
                        worker.fail();
                    }
                }));
                if result.is_err() {
                    if let Some(snapshot) =
                        worker_shared.worker_failed("keep-awake worker stopped unexpectedly")
                    {
                        publish(snapshot);
                    }
                }
            });
        let worker = match worker {
            Ok(worker) => {
                // The manager retains its own lightweight handle for coalesced wakeups.
                let _ = shared.thread.set(worker.thread().clone());
                Some(worker)
            }
            Err(error) => {
                let _ = shared.worker_failed(&format!("keep-awake worker unavailable: {error}"));
                None
            }
        };
        Arc::new(Self {
            shared,
            sender,
            worker: Mutex::new(worker),
            remote,
        })
    }

    fn request(&self, make: impl FnOnce(Reply) -> Request) -> Result<Arc<Snapshot>, String> {
        let (reply, result) = mpsc::sync_channel(1);
        self.sender
            .send(make(reply))
            .map_err(|_| "keep-awake worker unavailable".to_string())?;
        self.shared.wake();
        result
            .recv()
            .map_err(|_| "keep-awake worker unavailable".to_string())?
    }

    pub fn epoch(&self) -> u64 {
        self.shared.epoch.load(Ordering::Acquire)
    }

    pub fn register(&self, id: &str, epoch: u64) -> Result<(), String> {
        // The worker outlives this borrowed session id.
        self.request(|reply| Request::Register {
            id: id.to_owned(),
            epoch,
            reply,
        })
        .map(|_| ())
    }

    pub fn close(&self, id: &str) {
        // The queued request owns its id until the worker has processed it.
        let _ = self.request(|reply| Request::Close {
            id: id.to_owned(),
            reply,
        });
    }

    fn reset(&self) {
        self.shared.epoch.fetch_add(1, Ordering::AcqRel);
        self.shared.wake();
    }

    fn stop(&self) {
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(worker) = worker {
            let _ = self.sender.send(Request::Shutdown);
            self.shared.wake();
            if worker.join().is_err() {
                let _ = self
                    .shared
                    .worker_failed("keep-awake worker stopped unexpectedly");
            }
        }
    }
}

impl TrackerSink for KeepAwake {
    fn changed(&self, sid: &str, transition: Option<Transition>) {
        if let Some(remote) = &self.remote {
            remote.changed(sid, transition);
        }
        self.shared.dirty.store(true, Ordering::Release);
        self.shared.wake();
    }
}

pub fn install(
    app: &tauri::App,
    path: Option<PathBuf>,
    remote: Option<Arc<dyn TrackerSink>>,
) -> Arc<dyn TrackerSink> {
    let handle = app.handle().clone(); // The worker emits snapshots until shutdown.
    let manager = KeepAwake::new(
        path,
        || tracker::tracker().snapshot(),
        platform::acquire,
        move |snapshot| {
            let _ = handle.emit(EVENT, snapshot);
        },
        remote,
    );
    app.manage(Arc::clone(&manager));
    manager
}

pub fn reset(app: &AppHandle) {
    if let Some(manager) = app.try_state::<Arc<KeepAwake>>() {
        manager.reset();
    }
}

pub fn stop(app: &AppHandle) {
    if let Some(manager) = app.try_state::<Arc<KeepAwake>>() {
        manager.stop();
    }
}

#[tauri::command]
pub async fn keep_awake_snapshot(
    manager: State<'_, Arc<KeepAwake>>,
) -> Result<Arc<Snapshot>, String> {
    let manager = Arc::clone(manager.inner());
    crate::off_ipc(move || {
        manager
            .request(Request::Snapshot)
            .or_else(|_| Ok(manager.shared.current()))
    })
    .await?
}

#[tauri::command]
pub async fn keep_awake_set_default(
    enabled: bool,
    manager: State<'_, Arc<KeepAwake>>,
) -> Result<Arc<Snapshot>, String> {
    let manager = Arc::clone(manager.inner());
    crate::off_ipc(move || manager.request(|reply| Request::Default { enabled, reply })).await?
}

#[tauri::command]
pub async fn keep_awake_set_session(
    session_id: String,
    enabled: Option<bool>,
    manager: State<'_, Arc<KeepAwake>>,
) -> Result<Arc<Snapshot>, String> {
    let manager = Arc::clone(manager.inner());
    crate::off_ipc(move || {
        manager.request(|reply| Request::Session {
            id: session_id,
            enabled,
            reply,
        })
    })
    .await?
}

#[cfg(test)]
mod tests;
