use std::io::Write;
use std::path::{Component, Path};
use std::process::ChildStdin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use super::host::{valid_id, Shared};

const REQUEST_PREFIX: &str = "OMP_DESKTOP_EVIDENCE_REQUEST:";
const MAX_REQUEST: usize = 16 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Envelope {
    version: u8,
    epoch: String,
    session_id: String,
    file: Option<String>,
    op: String,
    args: Value,
}

pub(super) struct Job {
    pub tab: String,
    pub epoch: String,
    pub live: Arc<AtomicBool>,
    pub id: String,
    pub stdin: Arc<Mutex<ChildStdin>>,
    pub alive: Arc<AtomicBool>,
    pub request: Result<Envelope, String>,
}

pub(super) fn private_payload(frame: &Value) -> Option<&str> {
    if frame.get("type").and_then(Value::as_str) != Some("extension_ui_request")
        || frame.get("method").and_then(Value::as_str) != Some("input")
    {
        return None;
    }
    frame.get("title")?.as_str()?.strip_prefix(REQUEST_PREFIX)
}

pub(super) fn parse(payload: &str) -> Result<Envelope, String> {
    if payload.len() > MAX_REQUEST {
        return Err("Evidence request exceeds the size limit".into());
    }
    let envelope: Envelope =
        serde_json::from_str(payload).map_err(|_| "Invalid evidence request".to_string())?;
    if envelope.version != 1
        || !valid_id(&envelope.epoch, 128)
        || !valid_id(&envelope.session_id, 256)
        || envelope.file.as_deref().is_some_and(|s| !valid_id(s, 4096))
        || !valid_id(&envelope.op, 32)
        || !envelope.args.is_object()
    {
        return Err("Invalid evidence request identity or arguments".into());
    }
    Ok(envelope)
}

// Neither path blocks the stdout reader. If both queues fill, the native
// request deadline remains the explicit timeout rather than an invented result.
pub(super) fn enqueue<T>(
    tx: &mpsc::SyncSender<T>,
    rejected: &mpsc::SyncSender<T>,
    job: T,
    mark_full: impl FnOnce(&mut T),
) {
    if let Err(mpsc::TrySendError::Full(mut job)) = tx.try_send(job) {
        mark_full(&mut job);
        let _ = rejected.try_send(job);
    }
}

pub(super) fn run(shared: &Shared, rx: mpsc::Receiver<Job>, rejected: mpsc::Receiver<Job>) {
    loop {
        for _ in 0..32 {
            let Ok(job) = rejected.try_recv() else {
                break;
            };
            answer(shared, job);
        }
        if shared.stopping.load(Ordering::Acquire) {
            for _ in 0..32 {
                let Ok(mut job) = rx.try_recv() else {
                    break;
                };
                job.request = Err("Evidence host is shutting down".into());
                answer(shared, job);
            }
            cleanup(shared, true);
            break;
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(job) => answer(shared, job),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                cleanup(shared, true);
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        cleanup(shared, false);
    }
}

fn cleanup(shared: &Shared, all: bool) {
    let paths = shared.runs.lock().map_or_else(
        |_| Vec::new(),
        |mut runs| {
            if all {
                let removed = std::mem::take(&mut runs.entries);
                for (tab, run) in removed {
                    run.live.store(false, Ordering::Release);
                    shared
                        .media
                        .revoke(&super::host::token_scope(&tab, &run.epoch));
                    if let Some(path) = run.inbox {
                        runs.cleanup.push(path);
                    }
                }
            }
            std::mem::take(&mut runs.cleanup)
        },
    );
    for path in paths {
        let _ = crate::private_fs::remove_dir_retrying(&path);
    }
}

fn answer(shared: &Shared, job: Job) {
    if !job.live.load(Ordering::Acquire) || !job.alive.load(Ordering::Acquire) {
        return;
    }
    let result = if shared.stopping.load(Ordering::Acquire) {
        Err("Evidence host is shutting down".into())
    } else {
        job.request
            .and_then(|request| dispatch(shared, &job.tab, &job.epoch, &job.live, request))
    };
    reply(&job.stdin, &job.live, &job.alive, &job.id, result);
}

pub(super) fn reply<W: Write>(
    stdin: &Mutex<W>,
    live: &AtomicBool,
    alive: &AtomicBool,
    id: &str,
    result: Result<Value, String>,
) {
    if !live.load(Ordering::Acquire) || !alive.load(Ordering::Acquire) {
        return;
    }
    let value = match result {
        Ok(value) => json!({"ok": true, "value": value}),
        Err(error) => json!({"ok": false, "error": error}),
    };
    let response = json!({"type":"extension_ui_response", "id":id, "value":value.to_string()});
    if let Ok(mut stdin) = stdin.lock() {
        if live.load(Ordering::Acquire) && alive.load(Ordering::Acquire) {
            let _ = writeln!(*stdin, "{response}");
            let _ = stdin.flush();
        }
    }
}

pub(super) fn dispatch(
    shared: &Shared,
    tab: &str,
    epoch: &str,
    live: &AtomicBool,
    request: Envelope,
) -> Result<Value, String> {
    let (cwd, project, inbox) = {
        let runs = shared
            .runs
            .lock()
            .map_err(|_| "Evidence registry unavailable".to_string())?;
        let run = runs.entries.get(tab).ok_or("Evidence run unavailable")?;
        if run.epoch != epoch
            || request.epoch != epoch
            || !live.load(Ordering::Acquire)
            || run.session_id.as_deref() != Some(request.session_id.as_str())
            || run.file != request.file
        {
            return Err("Evidence request belongs to a stale conversation".into());
        }
        // The worker needs these paths and the pinned directory handle after releasing the registry lock for I/O.
        let paths = (
            run.cwd.clone(),
            run.project.clone(),
            run.inbox_handle.as_ref().map(Arc::clone),
        );
        drop(runs);
        paths
    };
    match request.op.as_str() {
        "fingerprint" => Ok(super::fingerprint::fingerprint(cwd.as_deref())),
        "ci" => Ok(super::fingerprint::ci(cwd.as_deref())),
        "defaults" => {
            let library = shared.presets.library(project.as_deref());
            Ok(json!({"policy":library.resolved, "revision":library.revision}))
        }
        "import" => {
            let filename = request
                .args
                .get("filename")
                .and_then(Value::as_str)
                .ok_or("Evidence import requires a filename")?;
            if !valid_filename(filename) {
                return Err("Invalid evidence inbox filename".into());
            }
            let name = match request.args.get("name") {
                None | Some(Value::Null) => None,
                Some(Value::String(name)) if valid_id(name, 256) => Some(name.as_str()),
                _ => return Err("Invalid evidence artifact name".into()),
            };
            let inbox = inbox.ok_or("Private evidence inbox unavailable")?;
            let artifact =
                shared
                    .media
                    .import_inbox(&inbox, filename, &request.session_id, name)?;
            serde_json::to_value(artifact)
                .map_err(|e| format!("Cannot serialize evidence artifact: {e}"))
        }
        _ => Err("Unknown evidence host operation".into()),
    }
}

pub(super) fn valid_filename(filename: &str) -> bool {
    if !valid_id(filename, 255) || filename.contains('\\') || filename.contains('/') {
        return false;
    }
    let mut parts = Path::new(filename).components();
    matches!(parts.next(), Some(Component::Normal(_))) && parts.next().is_none()
}
