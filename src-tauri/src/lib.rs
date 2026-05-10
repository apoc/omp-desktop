// Tauri's `#[command]` macro requires arguments by value (owned `String`,
// `State<'_, _>`, `AppHandle`) for deserialization from the frontend
// invoke payload. Suppress the related pedantic lints at module scope so
// command signatures stay idiomatic for the Tauri API.
#![allow(clippy::needless_pass_by_value)]

mod agent;
mod git;
mod git_watcher;

use agent::AgentBridge;
use git_watcher::GitWatcherState;
use tauri::{Manager, State};

/// Write a JSON command to a specific session's omp stdin.
#[tauri::command]
fn send_command(
    session_id: String,
    json: String,
    bridge: State<'_, AgentBridge>,
) -> Result<(), String> {
    bridge.send(&session_id, &json)
}

/// Start an omp process for a new tab session.
/// `cwd`: absolute path to the project folder (empty string = omp's default).
#[tauri::command]
fn start_session(
    session_id: String,
    cwd: String,
    bridge: State<'_, AgentBridge>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let cwd_opt = if cwd.is_empty() { None } else { Some(cwd) };
    bridge.start_session(session_id, cwd_opt.as_deref(), app)
}

/// Kill the omp process for a tab session.
#[tauri::command]
fn stop_session(session_id: String, bridge: State<'_, AgentBridge>) {
    bridge.stop_session(&session_id);
}

/// Query a session's last error. Returns `None` if the session is
/// running (or has never been started under this id), `Some(reason)`
/// if its last `start_session` attempt failed.
///
/// This replaces a previous timing-fragile pattern that emitted a
/// delayed `agent://exit/{id}` after a fixed sleep, hoping the
/// frontend listener was attached in time. The frontend can now query
/// this synchronously on activation and surface the real reason.
#[tauri::command]
fn session_status(session_id: String, bridge: State<'_, AgentBridge>) -> Option<String> {
    bridge.last_error(&session_id)
}

/// Native folder picker — returns the chosen path or null.
#[tauri::command]
fn open_project(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    // Use into_path() rather than to_string() so we get a real PathBuf
    // and convert through to_string_lossy(). Avoids platform-specific
    // FilePath::to_string formatting (URL encoding, UNC prefix quirks)
    // that could diverge from what std::fs and the rest of the app
    // expect downstream.
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("Open Project Folder")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| format!("invalid picked path: {e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Start watching `.git/HEAD` for a session's project path.
///
/// Returns the short branch name at call time, or `None` when `path` is
/// not inside a git repo or HEAD is detached.  The watcher fires
/// `"git://branch/{session_id}"` events on every subsequent HEAD change.
/// Watcher errors are silently ignored — the branch chip simply won't
/// update live.
#[tauri::command]
fn start_git_watch(
    session_id: String,
    path: String,
    watcher: State<'_, GitWatcherState>,
    app: tauri::AppHandle,
) -> Option<String> {
    let p = std::path::Path::new(&path);
    let (branch, head) = git::probe(p);
    if let Some(h) = head {
        let _ = watcher.start(&session_id, p, h, app);
    }
    branch
}

/// Stop the HEAD watcher for a session.  No-op when none is active.
#[tauri::command]
fn stop_git_watch(session_id: String, watcher: State<'_, GitWatcherState>) {
    watcher.stop(&session_id);
}

/// Open a URL in the system default browser.
/// Uses the `open` crate (ShellExecute on Windows, xdg-open on Linux, open on macOS).
/// `window.open(url, "_blank")` creates a Tauri webview instead — this is the correct
/// path for OAuth flows and any external URL that must open in the user's real browser.
#[tauri::command]
fn open_url_external(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| e.to_string())
}

/// Run the Tauri application. Panics if the runtime fails to initialise.
///
/// # Panics
///
/// Panics if `tauri::Builder::run` returns an error (e.g. the webview
/// runtime cannot be initialised). This is a fatal startup condition;
/// there is no meaningful recovery from inside `main`.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AgentBridge::new())
        .manage(GitWatcherState::new())
        .invoke_handler(tauri::generate_handler![
            send_command,
            start_session,
            stop_session,
            session_status,
            open_project,
            start_git_watch,
            stop_git_watch,
            open_url_external,
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            if let Some(win) = app.get_webview_window("main") {
                win.open_devtools();
            }
            // Start the default session (no cwd = omp's working directory).
            // The frontend activates this session on load via OMP_BRIDGE.activateSession("default").
            //
            // Failure handling: the bridge caches the spawn error keyed
            // by session_id. The frontend's activateSession queries
            // session_status on attach and surfaces the cached reason
            // if any — no event timing race, no delayed emit thread.
            let bridge = app.state::<AgentBridge>();
            if let Err(e) = bridge.start_session("default".into(), None, app.handle().clone()) {
                eprintln!("[omp-desktop] failed to start default session: {e}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
