// Tauri's `#[command]` macro requires arguments by value (owned `String`,
// `State<'_, _>`, `AppHandle`) for deserialization from the frontend
// invoke payload. Suppress the related pedantic lints at module scope so
// command signatures stay idiomatic for the Tauri API.
#![allow(clippy::needless_pass_by_value)]

mod agent;
mod approval;
mod files;
mod git;
mod git_watcher;
mod json_store;
mod saved_sessions;
mod workspace;

use agent::AgentBridge;
use approval::RuleBook;
use git_watcher::GitWatcherState;
use std::path::Path;
use std::sync::Arc;
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
/// `resume`: optional file path or session ID to resume an existing session.
/// The value is validated against the sessions directory before being
/// forwarded to omp's argv (see `saved_sessions::validate_resume`) — the
/// frontend cannot pass an arbitrary path or a flag-shaped string through.
#[tauri::command]
fn start_session(
    session_id: String,
    cwd: String,
    resume: Option<String>,
    bridge: State<'_, AgentBridge>,
    rule_book: State<'_, Arc<RuleBook>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if let Some(r) = resume.as_deref() {
        saved_sessions::validate_resume(&app, r)?;
    }
    let cwd_opt = if cwd.is_empty() {
        None
    } else {
        Some(cwd.as_str())
    };
    bridge.start_session(
        session_id,
        cwd_opt,
        resume.as_deref(),
        app,
        rule_book.inner().clone(),
    )
}

/// List saved sessions from disk (~/.omp/agent/sessions).
///
/// Runs `async` + `spawn_blocking`: `scan_saved_sessions` opens and parses
/// every persisted `.jsonl` file, which for large histories can take long
/// enough to freeze the webview if run on Tauri's main command thread.
#[tauri::command]
async fn list_saved_sessions(
    cwd: Option<String>,
    app: tauri::AppHandle,
) -> Result<Vec<saved_sessions::SavedSession>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        saved_sessions::scan_saved_sessions(&app, cwd.as_deref())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Kill the omp process for a tab session. Also drops its session-scoped
/// approval-rule grants (see `approval::RuleBook::clear_session`).
#[tauri::command]
fn stop_session(
    session_id: String,
    bridge: State<'_, AgentBridge>,
    rule_book: State<'_, Arc<RuleBook>>,
) {
    bridge.stop_session(&session_id, &rule_book);
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

/// Events a session's frontend hasn't seen yet, per its bounded event
/// journal. Called on tab reactivation (after re-arming the live listener)
/// to recover state that arrived while no listener was attached — the
/// journal is in-memory only, capped at 256 lines per session; a caller
/// whose `after_seq` predates the ring window gets `dropped: true` and
/// falls back to its existing full-state refetch for that gap.
#[tauri::command]
fn replay_events(
    session_id: String,
    after_seq: u64,
    bridge: State<'_, AgentBridge>,
) -> Result<agent::journal::Replay, String> {
    bridge.replay_events(&session_id, after_seq)
}

/// List tool-approval rules currently in effect for a session/project pair.
///
/// Runs `async` + `spawn_blocking` for the same reason as
/// `approval_rules_grant` — see its doc comment: `RuleBook::list` performs
/// a `Path::canonicalize()` syscall via `project_key()`, plus on a cold
/// cache a `std::fs::read` and potentially a full snapshot-ring directory
/// scan, while holding a mutex.
#[tauri::command]
async fn approval_rules_list(
    session_id: String,
    project_root: Option<String>,
    rule_book: State<'_, Arc<RuleBook>>,
) -> Result<Vec<approval::Rule>, String> {
    let rule_book = rule_book.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        rule_book.list(&session_id, project_root.as_deref().map(Path::new))
    })
    .await
    .map_err(|e| format!("join error: {e}"))
}

/// Grant standing approval for `tool`. `scope` is `"session"` or `"project"`
/// (the latter requires `project_root`); anything else is a stable error.
///
/// Runs `async` + `spawn_blocking`: `RuleBook::grant` performs a locked
/// file read-modify-write with up to several blocking retry sleeps, which
/// can stall the webview if run on Tauri's main command thread.
#[tauri::command]
async fn approval_rules_grant(
    session_id: String,
    project_root: Option<String>,
    tool: String,
    scope: String,
    rule_book: State<'_, Arc<RuleBook>>,
) -> Result<(), String> {
    let rule_book = rule_book.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let scope = parse_rule_scope(&scope)?;
        rule_book.grant(
            &session_id,
            project_root.as_deref().map(Path::new),
            &tool,
            scope,
        )
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Revoke a previously granted rule. No-op (not an error) if it wasn't granted.
///
/// Runs `async` + `spawn_blocking` for the same reason as
/// `approval_rules_grant` — see its doc comment.
#[tauri::command]
async fn approval_rules_revoke(
    session_id: String,
    project_root: Option<String>,
    tool: String,
    scope: String,
    rule_book: State<'_, Arc<RuleBook>>,
) -> Result<(), String> {
    let rule_book = rule_book.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let scope = parse_rule_scope(&scope)?;
        rule_book.revoke(
            &session_id,
            project_root.as_deref().map(Path::new),
            &tool,
            scope,
        )
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

fn parse_rule_scope(scope: &str) -> Result<approval::RuleScope, String> {
    match scope {
        "session" => Ok(approval::RuleScope::Session),
        "project" => Ok(approval::RuleScope::Project),
        other => Err(format!("unknown approval rule scope '{other}'")),
    }
}

/// List project-relative file/directory paths matching `query`, for the
/// composer's `@`-mention autocomplete.
///
/// Runs `async` + `spawn_blocking`: `files::list` walks the filesystem
/// (bounded, but still blocking I/O), which can stall the webview if run
/// on Tauri's main command thread.
#[tauri::command]
async fn list_project_files(
    cwd: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<files::FileHit>, String> {
    tauri::async_runtime::spawn_blocking(move || files::list(&cwd, &query, limit))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

/// Native folder picker — returns the chosen path or null.
///
/// On macOS, `AppKit` requires all `NSOpenPanel` calls to originate from
/// the main thread. `blocking_pick_folder` invokes the dialog directly
/// on the calling command-handler thread — an `AppKit` threading-model
/// violation that causes an indefinite hang (spinning beach ball + high CPU).
///
/// The callback-based `pick_folder` dispatches the dialog to the main
/// thread correctly. We bridge the callback to our async context with
/// an `mpsc` channel + `spawn_blocking` so the async executor is never
/// stalled.
#[tauri::command]
async fn open_project(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    // Use into_path() rather than to_string() so we get a real PathBuf
    // and convert through to_string_lossy(). Avoids platform-specific
    // FilePath::to_string formatting (URL encoding, UNC prefix quirks)
    // that could diverge from what std::fs and the rest of the app
    // expect downstream.
    app.dialog()
        .file()
        .set_title("Open Project Folder")
        .pick_folder(move |result| {
            let _ = tx.send(result);
        });
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| format!("join error: {e}"))?
        .map_err(|e| format!("channel error: {e}"))?;
    let Some(picked) = picked else {
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
/// Uses the `open` crate (`ShellExecute` on Windows, `xdg-open` on Linux, `open` on macOS).
/// `window.open(url, "_blank")` creates a Tauri webview instead — this is the correct
/// path for OAuth flows and any external URL that must open in the user's real browser.
#[tauri::command]
fn open_url_external(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| e.to_string())
}

/// Bounded `git status` for the Changes panel — see `workspace::status`.
///
/// Runs `async` + `spawn_blocking`: `workspace::status` shells out to one
/// or more `git` subprocesses via `Command::output()`, which can take
/// long enough on a large repository to freeze the webview if run on
/// Tauri's main command thread.
#[tauri::command]
async fn workspace_status(path: String) -> Result<workspace::StatusResult, String> {
    tauri::async_runtime::spawn_blocking(move || workspace::status(Path::new(&path)))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

/// Bounded diff of one file against HEAD — see `workspace::diff`.
///
/// Runs `async` + `spawn_blocking` for the same reason as
/// `workspace_status` — see its doc comment.
#[tauri::command]
async fn workspace_diff(path: String, rel_path: String) -> Result<workspace::DiffResult, String> {
    tauri::async_runtime::spawn_blocking(move || workspace::diff(Path::new(&path), &rel_path))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

/// Stage a file's changes — see `workspace::accept`.
///
/// Runs `async` + `spawn_blocking` for the same reason as
/// `workspace_status` — see its doc comment.
#[tauri::command]
async fn workspace_accept(path: String, rel_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || workspace::accept(Path::new(&path), &rel_path))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

/// Discard a file's working-tree changes (deletes it if untracked) — see
/// `workspace::reject`.
///
/// Runs `async` + `spawn_blocking` for the same reason as
/// `workspace_status` — see its doc comment.
#[tauri::command]
async fn workspace_reject(path: String, rel_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || workspace::reject(Path::new(&path), &rel_path))
        .await
        .map_err(|e| format!("join error: {e}"))?
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
            replay_events,
            open_project,
            start_git_watch,
            stop_git_watch,
            open_url_external,
            list_saved_sessions,
            approval_rules_list,
            approval_rules_grant,
            approval_rules_revoke,
            workspace_status,
            workspace_diff,
            workspace_accept,
            workspace_reject,
            list_project_files,
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            if let Some(win) = app.get_webview_window("main") {
                win.open_devtools();
            }
            // Approval-rule store: project-scoped grants persist under
            // <app_config_dir>/approval-rules/<project-hash>.json. Falls
            // back to a temp-dir subfolder if the config dir can't be
            // resolved (e.g. a locked-down test environment) rather than
            // failing startup — grants just won't survive a restart there.
            let rules_root = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::env::temp_dir())
                .join("approval-rules");
            app.manage(Arc::new(RuleBook::new(rules_root)));

            // Start the default session (no cwd = omp's working directory).
            // The frontend activates this session on load via OMP_BRIDGE.activateSession("default").
            //
            // Failure handling: the bridge caches the spawn error keyed
            // by session_id. The frontend's activateSession queries
            // session_status on attach and surfaces the cached reason
            // if any — no event timing race, no delayed emit thread.
            let bridge = app.state::<AgentBridge>();
            let rule_book = app.state::<Arc<RuleBook>>();
            let default_session = bridge.start_session(
                "default".into(),
                None,
                None,
                app.handle().clone(),
                rule_book.inner().clone(),
            );
            if let Err(e) = default_session {
                eprintln!("[omp-desktop] failed to start default session: {e}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
