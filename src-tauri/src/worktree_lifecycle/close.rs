//! Explicit close consent is separate from rollback, reload and shutdown.
use super::{bind_file, bind_saved_file, changed, for_tab, now_ms, with_store};
use crate::conversation_workspace::WorkspaceManager;
use tauri::{AppHandle, Manager};

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseAction {
    Keep,
    SnapshotRemove,
}

pub fn close_tab(
    app: &AppHandle,
    session_id: &str,
    action: Option<CloseAction>,
    session_file: Option<&str>,
) -> Result<(), String> {
    let Some(action) = action else {
        // Failed starts and webview cleanup retain files, without granting a
        // thirty-day deletion lease on behalf of the user.
        crate::end_tabs(app, &[session_id]);
        return Ok(());
    };
    let manager = app.state::<WorkspaceManager>();
    manager.cancel_pending(&[session_id]);
    let mut registry = manager.lock();
    let view = for_tab(app, &registry, session_id)?.ok_or_else(|| {
        "this conversation does not own a managed disposable worktree".to_string()
    })?;
    if matches!(action, CloseAction::SnapshotRemove) && view.state != "evicted" {
        if view.pinned {
            return Err("unpin this worktree before removing it".to_string());
        }
        if registry.owners_for_path(&view.path)? > 1 {
            return Err(
                "another open conversation or shell is still using this worktree".to_string(),
            );
        }
    }
    if let Some(file) = session_file.filter(|_| view.state != "evicted") {
        bind_file(app, &registry, session_id, file)?;
    }
    // Move the registration through teardown so a failed capture can restore
    // ownership without copying the conversation's paths and metadata.
    let (retained_id, retained) = registry
        .take_registration(session_id)
        .ok_or_else(|| "conversation tab is no longer registered".to_string())?;
    crate::end_tabs_locked(app, &[session_id], &mut registry);
    let result = (|| {
        if view.state == "evicted" {
            // A prior interrupted cleanup already committed its recovery.
            // Closing the stopped tab must not recapture partial artifacts.
            return Ok(view);
        }
        if let Some(file) = session_file {
            bind_saved_file(app, &view, &retained.profile, file)?;
        }
        with_store(app, |store| match action {
            CloseAction::Keep => store.keep(&view.id, now_ms()),
            CloseAction::SnapshotRemove => {
                if registry.owners_for_path(&view.path)? != 0 {
                    return Err("worktree ownership changed during close".to_string());
                }
                store.remove(&view.id, now_ms())
            }
        })
    })()
    .map(|_| ())
    .map_err(|error| {
        registry.retain_registration(retained_id, retained);
        format!(
            "Close could not finish; local work was retained. The agent and terminal were stopped. {error}"
        )
    });
    drop(registry);
    changed(app);
    result
}
