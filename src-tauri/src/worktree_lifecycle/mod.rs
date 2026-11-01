//! App lifecycle adapter for durable, disposable conversation workspaces.
//! Lock order is workspace lifecycle, then storage. No webview-supplied path
//! can authorize removal: close and housekeeping resolve native registrations.
mod close;
pub use close::{close_tab, CloseAction};
pub mod commands;
mod retention;

use crate::conversation_workspace::{Prepared, Registry, WorkspaceBinding};
use crate::worktree_storage::{StorageView, Store, WorkspaceView};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

pub type SharedStore = Arc<Mutex<Store>>;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| {
            u64::try_from(time.as_millis()).unwrap_or(u64::MAX)
        })
}

pub fn with_store<T>(
    app: &AppHandle,
    operation: impl FnOnce(&mut Store) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<SharedStore>();
    let mut store = state
        .lock()
        .map_err(|_| "workspace recovery storage lock failed".to_string())?;
    operation(&mut store)
}

fn managed_candidate(app: &AppHandle, cwd: &str) -> bool {
    if cwd.is_empty() {
        return false;
    }
    let Ok(data) = app.path().app_data_dir() else {
        return false;
    };
    let Ok(root) = crate::workspace::weakly_canonicalize(&data.join("conversation-worktrees"))
    else {
        return false;
    };
    crate::workspace::weakly_canonicalize(Path::new(cwd))
        .is_ok_and(|folder| folder != root && folder.starts_with(root))
}

/// Register only a native-verified managed linked checkout. A registration
/// does not start a deletion lease; only an explicit Keep decision does.
pub fn register(
    app: &AppHandle,
    prepared: &Prepared,
    profile: &str,
    session_file: Option<&str>,
) -> Result<Option<WorkspaceView>, String> {
    if !managed_candidate(app, &prepared.path) {
        return Ok(None);
    }
    if session_file.is_some_and(|file| managed_candidate(app, file)) {
        return Err("conversation history must live outside disposable worktrees".to_string());
    }
    let file = session_file
        .filter(|file| Path::new(file).is_absolute())
        .map(Path::new);
    if let Some(view) = with_store(app, |store| store.find_path(Path::new(&prepared.path)))? {
        if let Some(file) = file {
            with_store(app, |store| {
                store.bind_session(&view.id, profile, file, Path::new(&prepared.path))
            })?;
        }
        return Ok(Some(view));
    }
    let register = |source: &str| {
        with_store(app, |store| {
            store.register(
                profile,
                Path::new(&prepared.path),
                Path::new(source),
                file,
                now_ms(),
            )
        })
    };
    if let Some(binding) = prepared
        .workspace
        .as_ref()
        .filter(|binding| binding.worktree)
    {
        register(&binding.project_path)
    } else {
        // Legacy tabs predate the durable catalog. Recover origin from native
        // linked-worktree metadata, never a frontend cleanup path.
        let info = crate::conversation_workspace::inspect(&prepared.path)?;
        register(&info.project_path)
    }
}

pub fn for_tab(
    app: &AppHandle,
    registry: &Registry,
    id: &str,
) -> Result<Option<WorkspaceView>, String> {
    let prepared = registry
        .get(id)
        .ok_or_else(|| "conversation tab is no longer registered".to_string())?;
    if let Some(id) = prepared.storage_id.as_deref() {
        return with_store(app, |store| {
            let mut view = store.workspace(id)?;
            // The owned response describes this tab, not the record's first conversation.
            view.path.clone_from(&prepared.path);
            if let Some(binding) = &prepared.workspace {
                view.project_path.clone_from(&binding.project_path);
            }
            Ok(Some(view))
        });
    }
    register(app, prepared, &prepared.profile, None)
}

/// Resolve durable conversation identity before cwd validation or spawning.
/// Startup/respawn can restore a checkout but must not renew inactivity.
pub fn prepare_resume(
    app: &AppHandle,
    profile: &str,
    session_file: Option<&str>,
    cwd: &str,
    user_initiated: bool,
) -> Result<Option<WorkspaceView>, String> {
    let managed = managed_candidate(app, cwd);
    if !managed && session_file.is_none() {
        return Ok(None);
    }
    let view = with_store(app, |store| {
        if let Some(file) = session_file.filter(|file| !file.is_empty()) {
            if let Some(view) = store.find_session(profile, Path::new(file))? {
                return Ok(Some(view));
            }
        }
        if managed_candidate(app, cwd) {
            store.find_path(Path::new(cwd))
        } else {
            Ok(None)
        }
    });
    let view = match view {
        Ok(view) => view,
        Err(error) if !managed && (cwd.is_empty() || Path::new(cwd).is_dir()) => {
            // Recovery storage cannot make an intact, non-disposable project
            // conversation depend on the health of the cleanup catalog.
            eprintln!("[omp-desktop] recovery lookup unavailable for an intact project: {error}");
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let Some(mut view) = view else {
        return Ok(None);
    };
    if view.state == "evicted" || !Path::new(&view.path).is_dir() {
        view = with_store(app, |store| store.restore(&view.id))?;
        if let Some(file) = session_file.filter(|file| !file.is_empty()) {
            // Restore returns the representative cwd; aliases retain each chat's subdirectory.
            view = with_store(app, |store| store.find_session(profile, Path::new(file)))?
                .ok_or_else(|| {
                    "restored conversation workspace identity is unavailable".to_string()
                })?;
        }
    }
    if user_initiated {
        with_store(app, |store| store.touch(&view.id, now_ms()))?;
    }
    Ok(Some(view))
}

pub fn binding(view: WorkspaceView) -> WorkspaceBinding {
    WorkspaceBinding {
        project_path: view.project_path,
        base_ref: view.branch.map(|branch| format!("refs/heads/{branch}")),
        base_commit: view.commit,
        worktree: true,
    }
}

pub fn bind_file(
    app: &AppHandle,
    registry: &Registry,
    session_id: &str,
    session_file: &str,
) -> Result<(), String> {
    let prepared = registry
        .get(session_id)
        .ok_or_else(|| "conversation tab is no longer registered".to_string())?;
    if let Some(view) = for_tab(app, registry, session_id)? {
        bind_saved_file(app, &view, &prepared.profile, session_file)?;
    }
    Ok(())
}

/// omp allocates a session filename before the first message writes it.
/// An unwritten empty conversation cannot yet be a durable foreign key.
pub fn bind_saved_file(
    app: &AppHandle,
    view: &WorkspaceView,
    profile: &str,
    session_file: &str,
) -> Result<(), String> {
    if !Path::new(session_file).is_absolute() {
        return Err("conversation identity must be an absolute saved session file".to_string());
    }
    if managed_candidate(app, session_file) {
        return Err("conversation history must live outside disposable worktrees".to_string());
    }
    match std::fs::metadata(session_file) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("conversation history is unavailable: {error}")),
        Ok(metadata) if !metadata.is_file() => {
            return Err("conversation identity is not a regular file".to_string())
        }
        Ok(_) => {}
    }
    let native_profile = (!crate::profiles::is_default(profile)).then_some(profile);
    crate::saved_sessions::validate_resume(app, session_file, native_profile)?;
    with_store(app, |store| {
        store.bind_session(
            &view.id,
            profile,
            Path::new(session_file),
            Path::new(&view.path),
        )
    })
}

pub fn view_locked(app: &AppHandle, registry: &Registry) -> Result<StorageView, String> {
    let mut view = with_store(app, |store| store.view())?;
    for workspace in &mut view.workspaces {
        workspace.active = workspace.state != "evicted"
            && registry
                .owners_for_path(&workspace.path)
                .map_or(true, |owners| owners > 0);
    }
    Ok(view)
}

pub fn load_tabs(app: &AppHandle) -> crate::open_tabs::Restore {
    let tabs = app.state::<Arc<crate::open_tabs::OpenTabsStore>>();
    tabs.load(|tab| {
        let Some(file) = tab.session_file.as_deref() else {
            return false;
        };
        let profile = tab
            .profile
            .as_deref()
            .filter(|profile| !crate::profiles::is_default(profile))
            .unwrap_or(crate::profiles::DEFAULT_PROFILE_ID);
        match with_store(app, |store| store.find_session(profile, Path::new(file))) {
            Ok(Some(view)) => view.snapshot_at_ms.is_some(),
            Ok(None) => false,
            Err(error) => {
                eprintln!("[omp-desktop] saved workspace recovery unavailable: {error}");
                false
            }
        }
    })
}

pub fn changed(app: &AppHandle) {
    if let Err(error) = app.emit("worktree-storage://changed", ()) {
        eprintln!("[omp-desktop] workspace storage notification failed: {error}");
    }
}

/// Due-only cleanup. Budget pressure never shortens a Keep lease, and every
/// removal rechecks all owners under the same guard as native starts.
pub fn sweep(app: &AppHandle) -> Result<StorageView, String> {
    let now = now_ms();
    let due = with_store(app, |store| store.due(now))?;
    for id in due {
        let manager = app.state::<crate::conversation_workspace::WorkspaceManager>();
        let ticket = manager.ticket("workspace-retention")?;
        let registry = manager.lock();
        manager.check_ticket(&ticket)?;
        let view = with_store(app, |store| store.workspace(&id))?;
        if view.pinned || view.state == "evicted" {
            continue;
        }
        match registry.owners_for_path(&view.path) {
            Ok(0) => {}
            Ok(_) => continue,
            Err(error) => {
                eprintln!("[omp-desktop] workspace retention blocked id={id}: ownership unavailable: {error}");
                continue;
            }
        }
        // Rechecking the lease under the guard closes the reopen/sweep race.
        if !with_store(app, |store| store.is_due(&id, now))? {
            continue;
        }
        let removal = with_store(app, |store| store.remove(&id, now));
        drop(registry);
        if let Err(error) = removal {
            // Store persists the failure for the Settings inventory as well.
            eprintln!("[omp-desktop] workspace retention kept checkout id={id}: {error}");
        }
    }
    changed(app);
    let manager = app.state::<crate::conversation_workspace::WorkspaceManager>();
    let registry = manager.lock();
    view_locked(app, &registry)
}

pub fn install(app: &tauri::App) {
    let data = app
        .path()
        .app_data_dir()
        .ok()
        .filter(|path| path.is_absolute());
    app.manage(Arc::new(Mutex::new(Store::load(data))));
    app.manage(retention::Retention::start(app.handle().clone()));
}

pub fn stop(app: &AppHandle) {
    if let Some(retention) = app.try_state::<retention::Retention>() {
        retention.stop();
    }
}
