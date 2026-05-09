mod agent;

use agent::AgentBridge;
use tauri::{Manager, State};

#[tauri::command]
fn send_command(json: String, bridge: State<'_, AgentBridge>) -> Result<(), String> {
    bridge.send(&json)
}

#[tauri::command]
fn stop_agent(bridge: State<'_, AgentBridge>) {
    bridge.stop();
}

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
        .invoke_handler(tauri::generate_handler![send_command, stop_agent, open_project])
        .setup(|app| {
            #[cfg(debug_assertions)]
            if let Some(win) = app.get_webview_window("main") {
                win.open_devtools();
            }
            let bridge = app.state::<AgentBridge>();
            if let Err(e) = bridge.start(app.handle().clone()) {
                eprintln!("[omp-desktop] agent start error: {e}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
