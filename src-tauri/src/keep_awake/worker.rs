//! Serial policy, persistence and native inhibitor ownership.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc};

use crate::json_store;
use crate::remote::tracker;

use super::platform::Inhibitor;
use super::state::{Session, Settings, Shared, Snapshot, Tab};

pub(super) type Reply = mpsc::SyncSender<Result<Arc<Snapshot>, String>>;

pub(super) enum Request {
    Snapshot(Reply),
    Register {
        id: String,
        epoch: u64,
        reply: Reply,
    },
    Close {
        id: String,
        reply: Reply,
    },
    Default {
        enabled: bool,
        reply: Reply,
    },
    Session {
        id: String,
        enabled: Option<bool>,
        reply: Reply,
    },
    Shutdown,
}

pub(super) struct Worker<'a, S, F, I, P> {
    shared: Arc<Shared>,
    path: Option<PathBuf>,
    source: S,
    factory: F,
    publish_event: &'a P,
    epoch: u64,
    default_enabled: bool,
    tabs: BTreeMap<Arc<str>, Tab>,
    projection: Arc<Vec<Session>>,
    projection_dirty: bool,
    inhibitor: Option<I>,
    storage_error: Option<Arc<str>>,
    platform_error: Option<Arc<str>>,
}

impl<'a, S, F, I, P> Worker<'a, S, F, I, P>
where
    S: Fn() -> Arc<tracker::Snapshot>,
    F: Fn() -> Result<I, String>,
    I: Inhibitor,
    P: Fn(Arc<Snapshot>),
{
    pub(super) fn new(
        shared: Arc<Shared>,
        path: Option<PathBuf>,
        source: S,
        factory: F,
        publish_event: &'a P,
    ) -> Self {
        let (default_enabled, storage_error) =
            match path.as_deref().map(json_store::read_strict::<Settings>) {
                Some(Ok(settings)) => (settings.default_enabled, None),
                Some(Err(error)) => (
                    false,
                    Some(format!("keep-awake settings unreadable: {error}").into()),
                ),
                None => (false, None),
            };
        let epoch = shared.epoch.load(Ordering::Acquire);
        Self {
            shared,
            path,
            source,
            factory,
            publish_event,
            epoch,
            default_enabled,
            tabs: BTreeMap::new(),
            projection: Arc::new(Vec::new()),
            projection_dirty: false,
            inhibitor: None,
            storage_error,
            platform_error: None,
        }
    }

    fn publish(&mut self) {
        if self.projection_dirty {
            let sessions = self
                .tabs
                .iter()
                .map(|(id, tab)| Session {
                    // Snapshots share the immutable tab ID rather than copying its bytes.
                    id: Arc::clone(id),
                    override_enabled: tab.override_enabled,
                    enabled: tab.override_enabled.unwrap_or(self.default_enabled),
                    working: tab.working,
                })
                .collect();
            self.projection = Arc::new(sessions);
            self.projection_dirty = false;
        }
        let error = match (&self.storage_error, &self.platform_error) {
            (Some(storage), Some(platform)) => Some(format!("{storage}; {platform}").into()),
            (Some(error), None) | (None, Some(error)) => Some(Arc::clone(error)),
            (None, None) => None,
        };
        if let Some(snapshot) = self.shared.update(Snapshot {
            revision: 0,
            default_enabled: self.default_enabled,
            active: self.inhibitor.is_some(),
            error,
            sessions: Arc::clone(&self.projection),
        }) {
            (self.publish_event)(snapshot);
        }
    }

    pub(super) fn fail(&mut self) {
        // Keep the worker's RAII handle while attempting cleanup, and preserve
        // active/error if release itself fails.
        self.tabs.clear();
        self.projection_dirty = true;
        self.reconcile();
        if let Some(snapshot) = self
            .shared
            .worker_failed("keep-awake worker stopped unexpectedly")
        {
            (self.publish_event)(snapshot);
        }
    }

    fn sync_epoch(&mut self) {
        let epoch = self.shared.epoch.load(Ordering::Acquire);
        if self.epoch != epoch {
            self.epoch = epoch;
            self.tabs.clear();
            self.projection_dirty = true;
            self.publish();
            self.reconcile();
        }
    }

    fn refresh(&mut self) {
        let snapshot = (self.source)();
        let mut changed = false;
        for (id, tab) in &mut self.tabs {
            let working = snapshot.get(id.as_ref()).is_some_and(|entry| entry.0);
            if tab.working != working {
                tab.working = working;
                changed = true;
            }
        }
        // Never hold the tracker's Arc across event emission or a blocking OS
        // call: its reader would otherwise copy the map on every new frame.
        drop(snapshot);
        if changed {
            self.projection_dirty = true;
            self.publish();
            self.reconcile();
        }
    }

    /// Only policy/activity changes retry; unrelated question events do not.
    fn reconcile(&mut self) {
        let desired = self
            .tabs
            .values()
            .any(|tab| tab.working && tab.override_enabled.unwrap_or(self.default_enabled));
        let attempted = desired && self.inhibitor.is_none();
        match (desired, self.inhibitor.as_mut()) {
            (true, None) => match (self.factory)() {
                Ok(inhibitor) => {
                    self.inhibitor = Some(inhibitor);
                    self.platform_error = None;
                }
                Err(error) => {
                    self.platform_error =
                        Some(format!("keep-awake acquisition failed: {error}").into());
                }
            },
            (false, Some(inhibitor)) => match inhibitor.release() {
                Ok(()) => {
                    self.inhibitor = None;
                    self.platform_error = None;
                }
                Err(error) => {
                    self.platform_error =
                        Some(format!("keep-awake release failed: {error}").into());
                }
            },
            (false, None) => self.platform_error = None,
            (true, Some(_)) => {}
        }
        // Acquisition can block while a turn ends or the page reloads.
        if attempted {
            self.sync_epoch();
            self.refresh();
        }
        self.publish();
    }

    fn set_default(&mut self, enabled: bool) -> Result<(), String> {
        let result = self.path.as_ref().map_or(Ok(enabled), |path| {
            json_store::update_strict(
                path,
                &path.with_extension("lock"),
                |settings: &mut Settings| {
                    let changed = settings.default_enabled != enabled;
                    settings.default_enabled = enabled;
                    changed
                },
                |settings| settings.default_enabled,
            )
        });
        match result {
            Ok(saved) => {
                let changed = self.default_enabled != saved;
                self.default_enabled = saved;
                self.storage_error = None;
                self.projection_dirty |= changed;
                self.publish();
                if changed {
                    self.reconcile();
                }
                Ok(())
            }
            Err(error) => {
                self.storage_error = Some(format!("keep-awake settings: {error}").into());
                self.publish();
                Err(error)
            }
        }
    }

    fn execute(&mut self, request: Request) -> bool {
        self.sync_epoch();
        self.refresh();
        match request {
            Request::Snapshot(reply) => {
                let _ = reply.send(Ok(self.shared.current()));
            }
            Request::Register { id, epoch, reply } => {
                let result = if epoch == self.shared.epoch.load(Ordering::Acquire) {
                    if !self.tabs.contains_key(id.as_str()) {
                        let working = (self.source)().get(&id).is_some_and(|entry| entry.0);
                        self.tabs.insert(
                            Arc::from(id),
                            Tab {
                                override_enabled: None,
                                working,
                            },
                        );
                        self.projection_dirty = true;
                        self.publish();
                        self.reconcile();
                    }
                    Ok(self.shared.current())
                } else {
                    Err("tab belongs to a previous page load".into())
                };
                let _ = reply.send(result);
            }
            Request::Close { id, reply } => {
                if self.tabs.remove(id.as_str()).is_some() {
                    self.projection_dirty = true;
                    self.publish();
                    self.reconcile();
                }
                let _ = reply.send(Ok(self.shared.current()));
            }
            Request::Default { enabled, reply } => {
                let result = self.set_default(enabled).map(|()| self.shared.current());
                let _ = reply.send(result);
            }
            Request::Session { id, enabled, reply } => {
                let result = if let Some(tab) = self.tabs.get_mut(id.as_str()) {
                    let changed = tab.override_enabled != enabled;
                    tab.override_enabled = enabled;
                    if changed {
                        self.projection_dirty = true;
                        self.publish();
                        self.reconcile();
                    }
                    Ok(self.shared.current())
                } else {
                    Err(format!("unknown or closed tab: {id}"))
                };
                let _ = reply.send(result);
            }
            Request::Shutdown => {
                self.tabs.clear();
                self.projection_dirty = true;
                self.publish();
                self.reconcile();
                return false;
            }
        }
        true
    }

    pub(super) fn run(&mut self, receiver: mpsc::Receiver<Request>) {
        self.publish();
        loop {
            self.sync_epoch();
            if self.shared.dirty.swap(false, Ordering::AcqRel) {
                self.refresh();
            }
            while let Ok(request) = receiver.try_recv() {
                if !self.execute(request) {
                    return;
                }
            }
            std::thread::park();
        }
    }
}
