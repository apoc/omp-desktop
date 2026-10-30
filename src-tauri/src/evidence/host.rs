use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::ChildStdin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;

use ring::rand::{SecureRandom, SystemRandom};
use serde::Serialize;
use serde_json::{json, Value};

use super::media::{Artifact, AssetSource, InboxHandle, MediaStore};
use super::presets::{ConfigStore, ResolvedPolicy};
use super::worker::{self, Job};

pub(super) const MAX_SNAPSHOT: usize = 768 * 1024;
const MAX_RUNS: usize = 256;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    version: u8,
    policy: ResolvedPolicy,
    inbox: Option<String>,
    environment: Value,
}

pub(super) struct Run {
    pub epoch: String,
    pub cwd: Option<String>,
    pub project: Option<String>,
    pub inbox: Option<PathBuf>,
    pub inbox_handle: Option<Arc<InboxHandle>>,
    pub snapshot: Option<Value>,
    pub session_id: Option<String>,
    pub file: Option<String>,
    pub branch_token: Option<String>,
    pub pending: HashMap<String, Artifact>,
    pub live: Arc<AtomicBool>,
}

#[derive(Default)]
pub(super) struct Runs {
    pub entries: HashMap<String, Run>,
    pub cleanup: Vec<PathBuf>,
}

pub(super) struct Shared {
    pub runs: Mutex<Runs>,
    pub media: MediaStore,
    pub presets: Arc<ConfigStore>,
    pub stopping: AtomicBool,
}

pub struct EvidenceHost {
    pub presets: Arc<ConfigStore>,
    pub(super) shared: Arc<Shared>,
    data_root: Option<PathBuf>,
    tx: mpsc::SyncSender<Job>,
    rejected: mpsc::SyncSender<Job>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

pub(super) fn token_scope(tab: &str, epoch: &str) -> String {
    crate::json_store::hex_sha256(format!("{tab}\0{epoch}").as_bytes())
}

pub(super) fn random_hex() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "secure random generator unavailable".to_string())?;
    Ok(crate::json_store::hex_lower(&bytes))
}

pub(super) fn source_project(path: Option<&str>) -> Result<Option<String>, String> {
    path.filter(|s| !s.is_empty()).map_or(Ok(None), |path| {
        crate::conversation_workspace::inspect(path).map(|info| Some(info.project_path))
    })
}

impl EvidenceHost {
    pub fn new(config_path: Option<PathBuf>, data_root: Option<PathBuf>) -> Self {
        let data_root = data_root.filter(|path| path.is_absolute());
        let presets = Arc::new(ConfigStore::load(config_path));
        let shared = Arc::new(Shared {
            runs: Mutex::new(Runs::default()),
            media: MediaStore::new(
                data_root
                    .as_ref()
                    .map(|p| p.join("evidence").join("assets")),
            ),
            presets: Arc::clone(&presets),
            stopping: AtomicBool::new(false),
        });
        let (tx, rx) = mpsc::sync_channel(32);
        let (rejected, rejection_rx) = mpsc::sync_channel(32);
        let worker_shared = Arc::clone(&shared);
        let worker = std::thread::Builder::new()
            .name("evidence-host".into())
            .spawn(move || worker::run(&worker_shared, rx, rejection_rx))
            .ok();
        Self {
            presets,
            shared,
            data_root,
            tx,
            rejected,
            worker: Mutex::new(worker),
        }
    }

    pub fn register_run(
        &self,
        tab_id: &str,
        epoch: &str,
        cwd: Option<&str>,
        source: Option<&str>,
    ) -> Result<Bootstrap, String> {
        if self.shared.stopping.load(Ordering::Acquire) {
            return Err("Evidence host is shutting down".into());
        }
        if self
            .worker
            .lock()
            .map_err(|_| "Evidence worker unavailable".to_string())?
            .as_ref()
            .is_none_or(JoinHandle::is_finished)
        {
            return Err("Evidence worker unavailable".into());
        }
        if !valid_id(tab_id, 256) || !valid_id(epoch, 128) {
            return Err("Invalid evidence run identity".into());
        }
        let project = source_project(source.or(cwd))?;
        let policy = self.presets.resolve(project.as_deref());
        let (inbox, inbox_handle, unavailable) = self.create_inbox();
        let inbox_string = inbox
            .as_ref()
            .and_then(|path| path.to_str())
            .map(str::to_owned);
        let mut runs = self
            .shared
            .runs
            .lock()
            .map_err(|_| "Evidence registry unavailable".to_string())?;
        if self.shared.stopping.load(Ordering::Acquire) {
            drop(runs);
            drop(inbox_handle);
            if let Some(path) = inbox {
                let _ = crate::private_fs::remove_dir_retrying(&path);
            }
            return Err("Evidence host is shutting down".into());
        }
        if runs.entries.len() >= MAX_RUNS && !runs.entries.contains_key(tab_id) {
            if let Some(path) = inbox {
                runs.cleanup.push(path);
            }
            return Err("Evidence run limit reached".into());
        }
        if let Some(old) = runs.entries.remove(tab_id) {
            old.live.store(false, Ordering::Release);
            self.shared.media.revoke(&token_scope(tab_id, &old.epoch));
            if let Some(path) = old.inbox {
                runs.cleanup.push(path);
            }
        }
        runs.entries.insert(
            tab_id.to_owned(),
            Run {
                epoch: epoch.to_owned(),
                cwd: cwd.filter(|s| !s.is_empty()).map(str::to_owned),
                project,
                inbox,
                inbox_handle,
                snapshot: None,
                session_id: None,
                file: None,
                branch_token: None,
                pending: HashMap::new(),
                live: Arc::new(AtomicBool::new(true)),
            },
        );
        drop(runs);
        Ok(Bootstrap {
            version: 1,
            policy,
            inbox: inbox_string,
            environment: json!({"artifactAvailable": unavailable.is_none(), "artifactUnavailableReason": unavailable}),
        })
    }

    fn create_inbox(&self) -> (Option<PathBuf>, Option<Arc<InboxHandle>>, Option<String>) {
        let Some(root) = self.data_root.as_ref().filter(|p| p.is_absolute()) else {
            return (
                None,
                None,
                Some("Private evidence storage is unavailable".into()),
            );
        };
        let result = (|| {
            let parent = root.join("evidence").join("inbox");
            crate::private_fs::private_dirs(true)
                .create(&parent)
                .map_err(|e| format!("Cannot create evidence inbox: {e}"))?;
            let path = parent.join(random_hex()?);
            crate::private_fs::private_dirs(false)
                .create(&path)
                .map_err(|e| format!("Cannot create evidence inbox: {e}"))?;
            if path.to_str().is_none() {
                let _ = std::fs::remove_dir(&path);
                return Err("Evidence inbox path is not UTF-8".to_string());
            }
            let handle = match InboxHandle::open(&path) {
                Ok(handle) => handle,
                Err(error) => {
                    let _ = std::fs::remove_dir(&path);
                    return Err(error);
                }
            };
            Ok((path, Arc::new(handle)))
        })();
        match result {
            Ok((path, handle)) => (Some(path), Some(handle), None),
            Err(error) => (None, None, Some(error)),
        }
    }

    pub fn forget_run(&self, tab_id: &str, epoch: Option<&str>) {
        let Ok(mut runs) = self.shared.runs.lock() else {
            return;
        };
        if runs
            .entries
            .get(tab_id)
            .is_none_or(|run| epoch.is_some_and(|epoch| run.epoch != epoch))
        {
            return;
        }
        if let Some(run) = runs.entries.remove(tab_id) {
            run.live.store(false, Ordering::Release);
            self.shared.media.revoke(&token_scope(tab_id, &run.epoch));
            if let Some(path) = run.inbox {
                runs.cleanup.push(path);
            }
        }
    }

    pub fn intercept_native(
        &self,
        tab_id: &str,
        frame: &Value,
        stdin: &Arc<Mutex<ChildStdin>>,
        alive: &Arc<AtomicBool>,
    ) -> bool {
        let Some(payload) = worker::private_payload(frame) else {
            return false;
        };
        let Some(id) = frame
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| valid_id(s, 256))
        else {
            return true;
        };
        let run = self.shared.runs.lock().ok().and_then(|runs| {
            runs.entries
                .get(tab_id)
                // The worker needs the process epoch after the registry lock is released.
                .map(|r| (r.epoch.clone(), Arc::clone(&r.live)))
        });
        let Some((epoch, live)) = run else {
            return true;
        };
        let request = worker::parse(payload);
        let job = Job {
            tab: tab_id.to_owned(),
            epoch,
            live,
            id: id.to_owned(),
            stdin: Arc::clone(stdin),
            alive: Arc::clone(alive),
            request,
        };
        worker::enqueue(&self.tx, &self.rejected, job, |job| {
            job.request = Err("Evidence host queue is full".into());
        });
        true
    }

    pub fn observe_snapshot(&self, tab_id: &str, epoch: &str, frame: &Value) {
        super::snapshots::observe(&self.shared, tab_id, epoch, frame);
    }

    pub fn snapshot(&self, tab_id: &str) -> Option<Value> {
        // The reply outlives the short registry lock.
        self.shared
            .runs
            .lock()
            .ok()?
            .entries
            .get(tab_id)?
            .snapshot
            .clone()
    }

    pub fn media_response(
        &self,
        request: &tauri::http::Request<Vec<u8>>,
    ) -> tauri::http::Response<Vec<u8>> {
        self.shared.media.response(request)
    }

    pub(super) fn asset_source(&self, tab_id: &str, id: &str) -> Result<AssetSource, String> {
        let (artifact, scope, live) = super::snapshots::authorized(&self.shared, tab_id, id)?;
        let result = self.shared.media.source(&artifact, &scope)?;
        let current = super::snapshots::authorized(&self.shared, tab_id, id);
        if !matches!(current, Ok((current_artifact, current_scope, current_live)) if current_artifact == artifact && current_scope == scope && Arc::ptr_eq(&live, &current_live) && live.load(Ordering::Acquire))
        {
            self.shared.media.revoke(&scope);
            return Err("Evidence authorization changed".into());
        }
        Ok(result)
    }

    pub(super) fn asset_text(&self, tab_id: &str, id: &str) -> Result<Value, String> {
        let (artifact, _, live) = super::snapshots::authorized(&self.shared, tab_id, id)?;
        let result = self.shared.media.text(&artifact)?;
        let current = super::snapshots::authorized(&self.shared, tab_id, id);
        if !matches!(current, Ok((current_artifact, _, current_live)) if current_artifact == artifact && Arc::ptr_eq(&live, &current_live) && live.load(Ordering::Acquire))
        {
            return Err("Evidence authorization changed".into());
        }
        Ok(result)
    }

    pub(super) fn pick_identity(
        &self,
        tab_id: &str,
    ) -> Result<(String, String, Arc<AtomicBool>), String> {
        if self.shared.stopping.load(Ordering::Acquire) {
            return Err("Evidence host is shutting down".into());
        }
        let runs = self
            .shared
            .runs
            .lock()
            .map_err(|_| "Evidence registry unavailable".to_string())?;
        let run = runs.entries.get(tab_id).ok_or("Evidence run unavailable")?;
        if run.pending.len() >= 128 {
            return Err("Too many unrecorded evidence imports".into());
        }
        // The native picker outlives the registry lock and needs this identity pinned.
        let identity = (
            run.session_id
                .as_deref()
                .ok_or("Evidence conversation unavailable")?
                .to_owned(),
            run.epoch.clone(),
            Arc::clone(&run.live),
        );
        drop(runs);
        Ok(identity)
    }

    pub(super) fn pick_artifact(
        &self,
        tab_id: &str,
        path: &Path,
        identity: (String, String, Arc<AtomicBool>),
    ) -> Result<Artifact, String> {
        let (owner, epoch, live) = identity;
        if self.shared.stopping.load(Ordering::Acquire) || !live.load(Ordering::Acquire) {
            return Err("Evidence conversation changed during import".into());
        }
        let artifact = self.shared.media.import(path, &owner, None)?;
        let mut runs = self
            .shared
            .runs
            .lock()
            .map_err(|_| "Evidence registry unavailable".to_string())?;
        let run = runs
            .entries
            .get_mut(tab_id)
            .filter(|run| {
                run.epoch == epoch
                    && run.session_id.as_deref() == Some(owner.as_str())
                    && live.load(Ordering::Acquire)
                    && !self.shared.stopping.load(Ordering::Acquire)
            })
            .ok_or("Evidence conversation changed during import")?;
        if run.pending.len() >= 128 {
            return Err("Too many unrecorded evidence imports".into());
        }
        // The ledger receives the artifact while the registry keeps a pending authorization.
        run.pending.insert(artifact.id.clone(), artifact.clone());
        drop(runs);
        Ok(artifact)
    }

    /// Stop accepting work without waiting for a worker that may be writing
    /// to a child pipe. The bridge closes those pipes before `shutdown` joins.
    pub fn begin_shutdown(&self) {
        self.shared.stopping.store(true, Ordering::Release);
    }

    pub fn shutdown(&self) {
        self.begin_shutdown();
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }
}

impl Drop for EvidenceHost {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub(super) fn valid_id(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control)
}
