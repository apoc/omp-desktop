//! Typed IPC commands. Paths and active ownership are native-derived.
use super::{changed, for_tab, now_ms, view_locked, with_store};
use crate::conversation_workspace::WorkspaceManager;
use crate::worktree_storage::{Policy, StorageView, Store, WorkspaceView};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn worktree_storage_view(
    measure: Option<bool>,
    app: AppHandle,
) -> Result<StorageView, String> {
    crate::off_ipc(move || {
        if measure == Some(true) {
            let targets = with_store(&app, Store::measurement_targets)?;
            // Directory walks may be large. Never block close/start ownership while measuring.
            let measurements = targets
                .into_iter()
                .map(|(id, root, generation)| {
                    let result = crate::worktree_storage::measure_bytes(&root);
                    (id, root, generation, result)
                })
                .collect();
            with_store(&app, |store| store.apply_measurements(measurements))?;
        }
        let manager = app.state::<WorkspaceManager>();
        let registry = manager.lock();
        view_locked(&app, &registry)
    })
    .await?
}

#[tauri::command]
pub async fn worktree_storage_set_policy(
    policy: Policy,
    app: AppHandle,
) -> Result<StorageView, String> {
    crate::off_ipc(move || {
        let manager = app.state::<WorkspaceManager>();
        let registry = manager.lock();
        with_store(&app, |store| store.set_policy(policy))?;
        changed(&app);
        view_locked(&app, &registry)
    })
    .await?
}

#[tauri::command]
pub async fn worktree_storage_set_pin(
    id: String,
    pinned: bool,
    app: AppHandle,
) -> Result<StorageView, String> {
    crate::off_ipc(move || {
        let manager = app.state::<WorkspaceManager>();
        let registry = manager.lock();
        with_store(&app, |store| store.set_pin(&id, pinned))?;
        changed(&app);
        view_locked(&app, &registry)
    })
    .await?
}

#[tauri::command]
pub async fn worktree_storage_sweep(app: AppHandle) -> Result<StorageView, String> {
    crate::off_ipc(move || super::sweep(&app)).await?
}

#[tauri::command]
pub async fn worktree_storage_restore(id: String, app: AppHandle) -> Result<WorkspaceView, String> {
    crate::off_ipc(move || {
        let manager = app.state::<WorkspaceManager>();
        let registry = manager.lock();
        let view = with_store(&app, |store| store.workspace(&id))?;
        if view.state != "evicted" && registry.owners_for_path(&view.path)? > 0 {
            return Err("an open conversation or shell is still using this workspace".to_string());
        }
        let restored = with_store(&app, |store| {
            store.touch(&id, now_ms())?;
            store.restore(&id)
        })?;
        drop(registry);
        changed(&app);
        Ok(restored)
    })
    .await?
}

#[tauri::command]
pub async fn worktree_storage_close_info(
    session_id: String,
    app: AppHandle,
) -> Result<Option<WorkspaceView>, String> {
    crate::off_ipc(move || {
        let manager = app.state::<WorkspaceManager>();
        let registry = manager.lock();
        for_tab(&app, &registry, &session_id)
    })
    .await?
}

#[tauri::command]
pub async fn worktree_storage_bind_conversation(
    session_id: String,
    session_file: String,
    app: AppHandle,
) -> Result<(), String> {
    crate::off_ipc(move || {
        let manager = app.state::<WorkspaceManager>();
        let registry = manager.lock();
        super::bind_file(&app, &registry, &session_id, &session_file)
    })
    .await?
}

#[tauri::command]
pub async fn worktree_storage_touch(session_id: String, app: AppHandle) -> Result<(), String> {
    crate::off_ipc(move || {
        let manager = app.state::<WorkspaceManager>();
        let registry = manager.lock();
        if let Some(view) = for_tab(&app, &registry, &session_id)? {
            with_store(&app, |store| store.touch(&view.id, now_ms()))?;
        }
        Ok(())
    })
    .await?
}
