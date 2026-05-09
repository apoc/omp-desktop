mod agent;

use agent::AgentBridge;
use tauri::{Manager, State};

/// Write a JSON command to a specific session's omp stdin.
#[tauri::command]
fn send_command(session_id: String, json: String, bridge: State<'_, AgentBridge>) -> Result<(), String> {
    bridge.send(&session_id, &json)
}

/// Start an omp process for a new tab session.
/// cwd: absolute path to the project folder (empty string = omp's default).
#[tauri::command]
fn start_session(
    session_id: String,
    cwd: String,
    bridge: State<'_, AgentBridge>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let cwd_opt = if cwd.is_empty() { None } else { Some(cwd) };
    bridge.start_session(session_id, cwd_opt, app)
}

/// Kill the omp process for a tab session.
#[tauri::command]
fn stop_session(session_id: String, bridge: State<'_, AgentBridge>) {
    bridge.stop_session(&session_id);
}

/// Native folder picker — returns the chosen path or null.
#[tauri::command]
fn open_project(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app
        .dialog()
        .file()
        .set_title("Open Project Folder")
        .blocking_pick_folder()
        .map(|p| p.to_string());
    Ok(path)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AgentBridge::new())
        .invoke_handler(tauri::generate_handler![
            send_command,
            start_session,
            stop_session,
            open_project,
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            if let Some(win) = app.get_webview_window("main") {
                win.open_devtools();
            }
            // Start the default session (no cwd = omp's working directory).
            // The frontend activates this session on load via OMP_BRIDGE.activateSession("default").
            let bridge = app.state::<AgentBridge>();
            if let Err(e) = bridge.start_session("default".into(), None, app.handle().clone()) {
                eprintln!("[omp-desktop] failed to start default session: {e}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
