use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::Value;

use super::host::{token_scope, valid_id, Shared, MAX_SNAPSHOT};
use super::media::Artifact;

const PREFIX: &str = "OMP_DESKTOP_EVIDENCE:";

pub(super) fn observe(shared: &Shared, tab: &str, epoch: &str, frame: &Value) {
    if shared.stopping.load(Ordering::Acquire) {
        return;
    }
    let Some(view) = decode_view(frame, epoch) else {
        return;
    };
    if view.get("version").and_then(Value::as_u64) != Some(1)
        || view.get("epoch").and_then(Value::as_str) != Some(epoch)
    {
        return;
    }
    let Some(sequence) = view
        .get("sequence")
        .and_then(Value::as_u64)
        .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
    else {
        return;
    };
    let Some(session_id) = view
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|s| valid_id(s, 256))
    else {
        return;
    };
    let Some(branch) = view
        .get("branchToken")
        .and_then(Value::as_str)
        .filter(|s| valid_id(s, 256))
    else {
        return;
    };
    let file = match view.get("file") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if valid_id(s, 4096) => Some(s.as_str()),
        _ => return,
    };
    let Ok(mut runs) = shared.runs.lock() else {
        return;
    };
    let Some(run) = runs
        .entries
        .get_mut(tab)
        .filter(|r| r.epoch == epoch && r.live.load(Ordering::Acquire))
    else {
        return;
    };
    if run
        .snapshot
        .as_ref()
        .and_then(|v| v.get("sequence"))
        .and_then(Value::as_u64)
        .is_some_and(|previous| sequence <= previous)
    {
        return;
    }
    if run.session_id.as_deref() != Some(session_id)
        || run.file.as_deref() != file
        || run.branch_token.as_deref() != Some(branch)
    {
        run.live.store(false, Ordering::Release);
        run.live = Arc::new(AtomicBool::new(true));
        shared.media.revoke(&token_scope(tab, epoch));
        run.pending.clear();
    } else if run
        .snapshot
        .as_ref()
        .is_some_and(|previous| removed_artifact(previous, &view))
    {
        shared.media.revoke(&token_scope(tab, epoch));
    }
    run.session_id = Some(session_id.to_owned());
    run.file = file.map(str::to_owned);
    run.branch_token = Some(branch.to_owned());
    // Once recorded, imports no longer occupy the pending-picker allowance.
    for artifact in artifacts(&view) {
        if let Some(id) = artifact.get("id").and_then(Value::as_str) {
            run.pending.remove(id);
        }
    }
    run.snapshot = Some(view);
}

/// Parse and authenticate the private envelope before touching the run registry.
fn decode_view(frame: &Value, epoch: &str) -> Option<Value> {
    if frame.get("type").and_then(Value::as_str) != Some("extension_ui_request")
        || frame.get("method").and_then(Value::as_str) != Some("notify")
    {
        return None;
    }
    let message = frame.get("message")?.as_str()?.strip_prefix(PREFIX)?;
    if message.len() > MAX_SNAPSHOT {
        return None;
    }
    let mut payload: Value = serde_json::from_str(message).ok()?;
    if payload.get("version").and_then(Value::as_u64) != Some(1)
        || payload.get("epoch").and_then(Value::as_str) != Some(epoch)
        || payload.get("command").and_then(Value::as_str)
            != Some(format!("omp-desktop-evidence-{epoch}").as_str())
    {
        return None;
    }
    let view = payload.get_mut("view")?.take();
    view.is_object().then_some(view)
}

fn artifacts(view: &Value) -> impl Iterator<Item = &Value> {
    ["records", "receipts"]
        .into_iter()
        .filter_map(|key| view.get(key).and_then(Value::as_array))
        .flatten()
        .filter_map(|record| record.get("artifact"))
        .filter(|artifact| artifact.is_object())
}

fn removed_artifact(previous: &Value, next: &Value) -> bool {
    let current: std::collections::HashMap<&str, &Value> = artifacts(next)
        .filter_map(|artifact| {
            artifact
                .get("id")
                .and_then(Value::as_str)
                .map(|id| (id, artifact))
        })
        .collect();
    artifacts(previous).any(|old| {
        old.get("id")
            .and_then(Value::as_str)
            .and_then(|id| current.get(id))
            .is_none_or(|new| *new != old)
    })
}

pub(super) fn authorized(
    shared: &Shared,
    tab: &str,
    id: &str,
) -> Result<(Artifact, String, Arc<AtomicBool>), String> {
    if shared.stopping.load(Ordering::Acquire) {
        return Err("Evidence host is shutting down".into());
    }
    if !valid_id(id, 256) {
        return Err("Invalid artifact id".into());
    }
    let runs = shared
        .runs
        .lock()
        .map_err(|_| "Evidence registry unavailable".to_string())?;
    let run = runs.entries.get(tab).ok_or("Evidence run unavailable")?;
    run.session_id
        .as_deref()
        .ok_or("Evidence conversation unavailable")?;
    let view = run
        .snapshot
        .as_ref()
        .ok_or("Evidence snapshot unavailable")?;
    let candidate = ["records", "receipts"]
        .into_iter()
        .filter_map(|key| view.get(key).and_then(Value::as_array))
        .flatten()
        .filter_map(|record| record.get("artifact"))
        .find(|artifact| artifact.get("id").and_then(Value::as_str) == Some(id))
        .ok_or("Artifact is not part of this conversation's evidence")?;
    let artifact = serde_json::from_value(candidate.clone())
        .map_err(|_| "Invalid evidence artifact metadata".to_string())?;
    let scope = token_scope(tab, &run.epoch);
    let live = Arc::clone(&run.live);
    drop(runs);
    Ok((artifact, scope, live))
}
