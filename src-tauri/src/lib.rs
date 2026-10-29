// Tauri's `#[command]` macro requires arguments by value (owned `String`,
// `State<'_, _>`, `AppHandle`) for deserialization from the frontend
// invoke payload. Suppress the related pedantic lints at module scope so
// command signatures stay idiomatic for the Tauri API.
#![allow(clippy::needless_pass_by_value)]
// `clippy.toml` routes every spawn through `spawn_gate`; the suites start
// their helper processes (`git`, `sh`, stand-in browsers) directly.
#![cfg_attr(test, allow(clippy::disallowed_methods))]

mod agent;
mod approval;
mod approval_mode;
mod browser;
mod child_path;
mod config_file;
mod conversation_tree;
mod external_open;
mod files;
mod git;
mod git_browser;
mod git_watcher;
mod goal_config;
mod json_store;
mod keybindings;
mod model_usage;
mod navigation_guard;
mod omp_cli;
mod open_tabs;
mod private_fs;
mod profiles;
mod program_setting;
mod project_file;
mod recent_projects;
mod redaction;
mod remote;
mod saved_sessions;
mod spawn_gate;
mod stats;
mod supervisor;
mod terminal;
#[cfg(test)]
mod test_support;
mod text;
mod updater;
mod widgets;
mod workspace;

use agent::AgentBridge;
use approval::RuleBook;
use approval_mode::{ApprovalModeStore, ApprovalModeView};
use external_open::OpenProjectState;
use git_watcher::GitWatcherState;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, Url};

/// Write a JSON command to a specific session's omp stdin.
#[tauri::command]
fn send_command(
    session_id: String,
    json: String,
    bridge: State<'_, AgentBridge>,
) -> Result<(), String> {
    bridge.send(&session_id, &json)
}

/// Session-start payload from the frontend. A struct rather than four loose
/// command arguments so the IPC surface stays one strongly-typed shape (and
/// the handler keeps a sane argument count as Tauri `State` injections grow).
// `deny_unknown_fields`: `profile` is `Option<String>`, and `None` is not a
// neutral value - it means the built-in profile, i.e. no `--profile` flag and
// the shared `~/.omp/agent` tree. Without this, renaming the key on the JS
// side (to `profileId`, matching `switchSessionProfile`'s parameter) would
// deserialize cleanly and silently write a named profile's conversation into
// the default profile's history. An IPC error is the loud failure that
// `agent::spawn` argues for.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartSessionArgs {
    session_id: String,
    /// Absolute path to the project folder (empty string = omp's default).
    cwd: String,
    /// Optional file path or session id to resume. Validated against the
    /// profile's sessions directory before it reaches omp's argv (see
    /// `saved_sessions::validate_resume`) — the frontend cannot pass an
    /// arbitrary path or a flag-shaped string through.
    resume: Option<String>,
    /// Which omp profile this tab runs under (`None`/`"default"` = omp's own
    /// `~/.omp/agent` tree); resolved by `profiles::ProfileStore::resolve`.
    profile: Option<String>,
}

/// Register the tab with the terminal, start an omp process for it, then
/// tell the widget host (which computes the project's git context on its own
/// thread). The terminal comes first so a failed omp spawn still leaves the
/// tab a working shell; registering an existing tab (a profile switch or an
/// approval-mode restart) keeps its shell. The approval mode is resolved here
/// for the tab's folder, never sent by the frontend; `Ok` is the mode omp was
/// started with (`"always-ask" | "write" | "yolo"`).
#[tauri::command]
fn start_session(
    args: StartSessionArgs,
    bridge: State<'_, AgentBridge>,
    rule_book: State<'_, Arc<RuleBook>>,
    store: State<'_, Arc<profiles::ProfileStore>>,
    widget_host: State<'_, Arc<widgets::WidgetHost>>,
    terminal: State<'_, Arc<terminal::TerminalManager>>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let profile = store.resolve(args.profile.as_deref())?;
    if let Some(r) = args.resume.as_deref() {
        saved_sessions::validate_resume(&app, r, profile)?;
    }
    let cwd_opt = if args.cwd.is_empty() {
        None
    } else {
        Some(args.cwd.as_str())
    };
    // Through `app` rather than an eighth `State` parameter (clippy's
    // `too_many_arguments`); `app` is moved into the bridge below.
    let mode = app
        .state::<Arc<ApprovalModeStore>>()
        .resolve(cwd_opt.map(Path::new));
    terminal.register_tab(&args.session_id, cwd_opt.map(Path::new));
    // The tab's browser (idempotent: a respawn under the same tab id reuses
    // it). Which Chromium it runs is Rust's `browser.json` setting, read at
    // launch time. Only an app run with no managed browsers at all starts omp
    // without `--config`; a tab whose browser can't be set up (a respawn
    // racing the tab's close: "still closing") fails to start, and the
    // frontend's rollback closes it.
    let overlay = app
        .state::<browser::BrowserManager>()
        .allocate_if_available(&args.session_id)
        .map_err(|e| format!("browser: {e}"))?;
    bridge.start_session(
        // Owned by the bridge's map; the widget hook below still needs the id.
        args.session_id.clone(),
        agent::Launch {
            cwd: cwd_opt,
            resume: args.resume.as_deref(),
            profile,
            mode,
            config: overlay.as_deref(),
        },
        app,
        Arc::clone(rule_book.inner()),
    )?;
    widget_host.session_started(&args.session_id, cwd_opt.map(Path::new));
    Ok(mode.as_str().to_string())
}

/// Run blocking `work` (file or process I/O, a long scan) off Tauri's IPC
/// thread, which would otherwise freeze the webview: `spawn_blocking`, with
/// a panic in `work` reported as `"join error: …"`.
async fn off_ipc<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("join error: {e}"))
}

/// [`off_ipc`] against a shared `Arc<S>` — what every state-mutating command
/// shares (`ProfileStore` and the keybindings `OverlayStore` alike): file-backed,
/// each one is a locked, fsync'd read-modify-write of its own JSON file (same
/// rationale as `approval_approve_and_grant`); memory-only, a short mutex hold.
async fn with_blocking<S: Send + Sync + 'static, T: Send + 'static>(
    shared: &Arc<S>,
    f: impl FnOnce(&S) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let shared = Arc::clone(shared);
    off_ipc(move || f(&shared)).await?
}

/// The profile list plus which entry is the startup default, in one payload.
///
/// Returned together so the selector can never render a checkmark against a
/// stale default: two commands could interleave with a `set_startup_profile`
/// from another window and disagree.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileList {
    profiles: Vec<profiles::Profile>,
    /// Always a listed id — the built-in `"default"` when nothing is set.
    startup_id: String,
}

/// Every selectable profile, built-in first (served from the in-memory cache).
#[tauri::command]
fn list_profiles(store: State<'_, Arc<profiles::ProfileStore>>) -> ProfileList {
    let (profiles, startup_id) = store.snapshot();
    ProfileList {
        profiles,
        startup_id,
    }
}

/// Choose the profile new tabs and the next launch start in. Running tabs
/// keep their own — a profile is fixed at spawn.
#[tauri::command]
async fn set_startup_profile(
    id: String,
    store: State<'_, Arc<profiles::ProfileStore>>,
) -> Result<(), String> {
    with_blocking(&store, move |s| s.set_startup(&id)).await
}

/// Create a profile named `name`, deriving its id with [`slugify`] +
/// [`unique_id`]. Returns the created profile.
///
/// Also seeds the profile's placeholder `models.yml` — without it omp's RPC
/// mode exits at startup for a credential-less profile and the new tab could
/// never reach `/login`. See `profiles::seed_bootstrap`.
///
/// Runs `async` + `spawn_blocking` (via `with_blocking`): both the
/// list mutation and the seed write are blocking filesystem I/O, so the
/// seed is folded into the same blocking closure instead of running
/// directly on the async command thread.
#[tauri::command]
async fn create_profile(
    name: String,
    app: AppHandle,
    store: State<'_, Arc<profiles::ProfileStore>>,
) -> Result<profiles::Profile, String> {
    let home = app.path().home_dir().ok();
    with_blocking(&store, move |s| {
        let created = s.create(&name)?;
        // Best-effort: the profile exists and is listed either way, and a
        // failure here only costs the in-app login path (the tab still
        // explains itself via the startup-exit note). Failing the whole
        // create would be worse — the list entry is already committed.
        if let Some(home) = home {
            if let Err(e) = profiles::seed_bootstrap(&home, &created.id) {
                eprintln!(
                    "[omp-desktop] could not seed models.yml for '{}': {e}",
                    created.id
                );
            }
        }
        Ok(created)
    })
    .await
}

/// Drop a profile's placeholder `models.yml` once it has real credentials.
/// Called by the frontend after a successful login; a no-op unless the
/// file's YAML still matches what `create_profile` seeded (comment prose
/// aside — see `profiles::clear_bootstrap`).
///
/// Runs `async` + `spawn_blocking`: reading and possibly removing the seed
/// file is blocking filesystem I/O.
#[tauri::command]
async fn clear_profile_bootstrap(
    id: String,
    app: AppHandle,
    store: State<'_, Arc<profiles::ProfileStore>>,
) -> Result<(), String> {
    // Resolved, so a blank/"default" id can't aim this at the built-in tree
    // (which has no seed) and an unlisted id can't reach the disk at all.
    let Some(id) = store.resolve_owned(Some(id))? else {
        return Ok(());
    };
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    off_ipc(move || profiles::clear_bootstrap(&home, &id)).await
}

/// Rename a profile. Only the display label changes — see
/// `profiles::ProfileStore::rename`.
#[tauri::command]
async fn rename_profile(
    id: String,
    name: String,
    store: State<'_, Arc<profiles::ProfileStore>>,
) -> Result<profiles::Profile, String> {
    with_blocking(&store, move |s| s.rename(&id, &name)).await
}

/// Unlist a profile (files stay on disk — see `profiles::ProfileStore::remove`).
/// Callers must ensure no open tab is still running under `id`; the frontend
/// enforces that, since only it knows the tab set.
#[tauri::command]
async fn delete_profile(
    id: String,
    store: State<'_, Arc<profiles::ProfileStore>>,
) -> Result<(), String> {
    with_blocking(&store, move |s| s.remove(&id)).await
}

/// List saved sessions from disk for `profile` (`~/.omp/agent/sessions`, or
/// `~/.omp/profiles/<id>/agent/sessions` for a named profile).
///
/// Runs `async` + `spawn_blocking`: `scan_saved_sessions` opens and parses
/// every persisted `.jsonl` file, which for large histories can take long
/// enough to freeze the webview if run on Tauri's main command thread.
#[tauri::command]
async fn list_saved_sessions(
    cwd: Option<String>,
    profile: Option<String>,
    store: State<'_, Arc<profiles::ProfileStore>>,
    app: tauri::AppHandle,
) -> Result<Vec<saved_sessions::SavedSession>, String> {
    let profile = store.resolve_owned(profile)?;
    off_ipc(move || saved_sessions::scan_saved_sessions(&app, cwd.as_deref(), profile.as_deref()))
        .await?
}

/// The conversation family of one saved session file (`session_file`, under
/// `profile`'s sessions directory): its entries merged across the files
/// branched/forked from each other, for the tree navigator.
///
/// `spawn_blocking`: a session file can reach tens of MiB.
#[tauri::command]
async fn conversation_tree(
    session_file: String,
    profile: Option<String>,
    store: State<'_, Arc<profiles::ProfileStore>>,
    app: tauri::AppHandle,
) -> Result<conversation_tree::ConversationTree, String> {
    let profile = store.resolve_owned(profile)?;
    off_ipc(move || conversation_tree::load(&app, &session_file, profile.as_deref())).await?
}

/// Kill the omp process for a tab session. Also drops its session-scoped
/// approval-rule grants (see `approval::RuleBook::clear_session`) and its
/// widget runs.
///
/// Deliberately does NOT touch the tab's terminal or browser: a profile switch
/// respawns omp while its shell and Chromium stay. Both end only through
/// [`end_tabs`] and [`kill_child_processes`].
#[tauri::command]
fn stop_session(
    session_id: String,
    bridge: State<'_, AgentBridge>,
    rule_book: State<'_, Arc<RuleBook>>,
    widget_host: State<'_, Arc<widgets::WidgetHost>>,
) {
    bridge.stop_session(&session_id, &rule_book);
    widget_host.session_closed(&session_id);
}

/// End tabs for good: their omp processes (with their session grants),
/// widget runs, git watchers, browsers and terminal shells. The one place a
/// tab ends. The two slow teardowns are independent and run side by side:
/// the browsers (Chromium kill, profile removal) and the shells (one shared
/// hang-up grace, `TerminalManager::close_tabs`).
fn end_tabs<S: AsRef<str> + Sync>(app: &AppHandle, ids: &[S]) {
    let rule_book = app.state::<Arc<RuleBook>>();
    let bridge = app.state::<AgentBridge>();
    let widgets = app.state::<Arc<widgets::WidgetHost>>();
    let watchers = app.state::<GitWatcherState>();
    for id in ids {
        let id = id.as_ref();
        bridge.stop_session(id, &rule_book);
        widgets.session_closed(id);
        watchers.stop(id);
    }
    let browser = app.state::<browser::BrowserManager>();
    std::thread::scope(|scope| {
        scope.spawn(|| browser.release_many(ids));
        app.state::<Arc<terminal::TerminalManager>>()
            .close_tabs(ids);
    });
}

/// Close a tab (the frontend's `closeSession`) — see [`end_tabs`]. `async` +
/// `spawn_blocking`: reaping omp and killing the shell's processes block.
#[tauri::command]
async fn close_tab(session_id: String, app: AppHandle) -> Result<(), String> {
    off_ipc(move || end_tabs(&app, &[session_id])).await
}

/// End every tab the backend knows. Called by the webview at boot, before
/// it restores its tabs: tab ids are never reused across a reload, so
/// whatever is registered then belongs to a previous document and would
/// otherwise run on unseen. The terminal's registry is the tab set:
/// [`start_session`] registers the tab before it spawns omp, and only
/// [`end_tabs`] (or an app exit) unregisters it. Only the tabs registered at
/// the start end: one started meanwhile keeps its terminal and browser.
#[tauri::command]
async fn close_all_tabs(app: AppHandle) -> Result<(), String> {
    off_ipc(move || {
        let ids = app.state::<Arc<terminal::TerminalManager>>().tab_ids();
        end_tabs(&app, &ids);
    })
    .await
}

/// Start the tab's terminal shell, in the tab's folder (else the home
/// folder) with the shell setting — see `terminal`. While one is starting or
/// running, returns its status instead. `async` + `spawn_blocking`: spawning
/// a shell (and killing an exited one's leftovers) blocks.
#[tauri::command]
async fn terminal_open(
    session_id: String,
    cols: u16,
    rows: u16,
    app: AppHandle,
    terminal: State<'_, Arc<terminal::TerminalManager>>,
) -> Result<terminal::TerminalStatus, String> {
    with_blocking(&terminal, move |t| {
        t.open(terminal::TauriEmit(app), &session_id, cols, rows)
    })
    .await
}

/// The tab's shell (`None` while it has none). A map lookup.
#[tauri::command]
fn terminal_status(
    session_id: String,
    terminal: State<'_, Arc<terminal::TerminalManager>>,
) -> Option<terminal::TerminalStatus> {
    terminal.status(&session_id)
}

/// Output the tab's shell still holds after event `after_seq` of `instance`
/// (everything it holds when `instance` is not the current shell). A copy
/// of at most the ring's budget; never blocks.
#[tauri::command]
fn terminal_replay(
    session_id: String,
    instance: u64,
    after_seq: u64,
    terminal: State<'_, Arc<terminal::TerminalManager>>,
) -> Option<terminal::ReplayWire> {
    terminal.replay(&session_id, instance, after_seq)
}

/// The webview rendered `bytes` of `instance`'s output (flow control).
#[tauri::command]
fn terminal_ack(
    session_id: String,
    instance: u64,
    bytes: u64,
    terminal: State<'_, Arc<terminal::TerminalManager>>,
) {
    terminal.ack(&session_id, instance, bytes);
}

/// Type into the tab's terminal: `data` reaches the shell unchanged.
///
/// Deliberately a sync command although it is called often: it only queues
/// the bytes for the terminal's writer thread (never blocks), and sync
/// commands run in invocation order, which keystrokes need — concurrent
/// async tasks (or `spawn_blocking` jobs) could reorder them.
#[tauri::command]
fn terminal_write(
    session_id: String,
    data: String,
    terminal: State<'_, Arc<terminal::TerminalManager>>,
) -> Result<(), String> {
    terminal.write(&session_id, data)
}

/// Resize the tab's terminal to `cols` × `rows` characters. Sync for the
/// ordering reason of `terminal_write` (the last size must win); it is a
/// single non-blocking ioctl.
#[tauri::command]
fn terminal_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    terminal: State<'_, Arc<terminal::TerminalManager>>,
) -> Result<(), String> {
    terminal.resize(&session_id, cols, rows)
}

/// The shell setting and what an empty one runs. `spawn_blocking`: the
/// default may come from the user database (`getpwuid`, possibly a
/// directory service).
#[tauri::command]
async fn terminal_settings(
    terminal: State<'_, Arc<terminal::TerminalManager>>,
) -> Result<terminal::TerminalSettings, String> {
    with_blocking(&terminal, |t| Ok(t.settings())).await
}

/// Store the shell setting (empty = default, else an absolute path to an
/// executable file) in `terminal.json`; the next shell started uses it.
#[tauri::command]
async fn terminal_set_shell(
    shell: String,
    terminal: State<'_, Arc<terminal::TerminalManager>>,
) -> Result<terminal::TerminalSettings, String> {
    with_blocking(&terminal, move |t| t.set_shell(&shell)).await
}

/// "other…" in the shell menu: pick a program with the native file dialog
/// and store it as `terminal_set_shell` would. `None` when the dialog was
/// cancelled. The path comes from the OS dialog, never from the webview.
/// Callback-based `pick_file` for the reason `open_project` gives. Parented
/// to the calling window, which makes it modal on Windows and macOS (the
/// Settings page cannot change under a pick, no second dialog); rfd's GTK3
/// backend ignores the parent, so on Linux the window stays usable.
#[tauri::command]
async fn terminal_pick_shell(
    window: tauri::WebviewWindow,
    terminal: State<'_, Arc<terminal::TerminalManager>>,
) -> Result<Option<terminal::TerminalSettings>, String> {
    let picked = pick_program(&window, "Choose a Shell");
    with_blocking(&terminal, move |t| {
        picked_program(&picked)?.map_or(Ok(None), |path| t.set_shell(&path).map(Some))
    })
    .await
}

/// Open the native "pick a program" dialog over `window` (`.exe` only on
/// Windows); the receiver yields the choice, `None` when cancelled.
fn pick_program(
    window: &tauri::WebviewWindow,
    title: &str,
) -> std::sync::mpsc::Receiver<Option<tauri_plugin_dialog::FilePath>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    let dialog = window.dialog().file().set_title(title).set_parent(window);
    #[cfg(windows)]
    let dialog = dialog.add_filter("Programs", &["exe"]);
    dialog.pick_file(move |result| {
        let _ = tx.send(result);
    });
    rx
}

/// Wait (blocking) for [`pick_program`]'s answer: the picked path as UTF-8,
/// `None` when the dialog was cancelled.
fn picked_program(
    picked: &std::sync::mpsc::Receiver<Option<tauri_plugin_dialog::FilePath>>,
) -> Result<Option<String>, String> {
    let Some(picked) = picked.recv().map_err(|e| format!("channel error: {e}"))? else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| format!("invalid picked path: {e}"))?;
    path.into_os_string()
        .into_string()
        .map(Some)
        .map_err(|p| format!("{} is not a UTF-8 path", p.to_string_lossy()))
}

/// The browser panel's Chromium setting, what automatic discovery finds and
/// whether the stored browser still works. `spawn_blocking`: discovery
/// checks files.
#[tauri::command]
async fn browser_settings(
    settings: State<'_, Arc<browser::SettingsStore>>,
) -> Result<browser::BrowserSettings, String> {
    with_blocking(&settings, |s| Ok(s.settings())).await
}

/// Store the Chromium setting (empty = automatic, else an absolute path to
/// an executable file; surrounding quotes are dropped) in `browser.json`;
/// the next launch uses it.
#[tauri::command]
async fn browser_set_path(
    path: String,
    settings: State<'_, Arc<browser::SettingsStore>>,
) -> Result<browser::BrowserSettings, String> {
    with_blocking(&settings, move |s| s.set_path(&path)).await
}

/// "other…" in the browser menu: pick a program with the native file dialog
/// and store it as `browser_set_path` would; `None` when cancelled. The path
/// comes from the OS dialog, never from the webview.
#[tauri::command]
async fn browser_pick_path(
    window: tauri::WebviewWindow,
    settings: State<'_, Arc<browser::SettingsStore>>,
) -> Result<Option<browser::BrowserSettings>, String> {
    let picked = pick_program(&window, "Choose a Browser");
    with_blocking(&settings, move |s| {
        picked_program(&picked)?.map_or(Ok(None), |path| s.set_path(&path).map(Some))
    })
    .await
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

/// Claim every folder the OS asked this app to open as a project, emptying
/// the queue (see `external_open`).
///
/// Called by the frontend on init and on every `open://project` event. The
/// drain is the whole protocol: because this is the only way out of the
/// queue, an event that races the startup drain costs one empty round-trip
/// instead of needing request ids and acknowledgements.
#[tauri::command]
fn take_pending_open_projects(state: State<'_, OpenProjectState>) -> Vec<String> {
    state.take_pending()
}

/// Events a session's frontend hasn't seen yet, per its bounded event
/// journal. Called on tab reactivation (after re-arming the live listener)
/// to recover state that arrived while no listener was attached — the
/// journal is in-memory only, capped per session at `EVENT_JOURNAL_CAPACITY` lines (4096) and `EVENT_JOURNAL_MAX_BYTES` (8 MiB); a caller
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

/// The latest status lines and widgets omp extensions published in a
/// session (`ctx.ui.setStatus` / `setWidget`, #52). The frontend applies
/// them live for the tab it shows; it asks for this when a reactivated tab's
/// replay came back `dropped`, because those frames may be among the
/// evicted lines. Empty for an unknown or ended session.
#[tauri::command]
fn extension_ui_state(
    session_id: String,
    bridge: State<'_, AgentBridge>,
) -> agent::ext_ui::ExtUiState {
    bridge.extension_ui_state(&session_id)
}

/// The assistant message a session is streaming, as far as it got: omp sends
/// only increments (`agent::inflight`), so a reactivated tab whose replay
/// came back `dropped` seeds its streaming bubble from this. `None` between
/// messages and for an unknown or ended session.
#[tauri::command]
fn streaming_message(
    session_id: String,
    bridge: State<'_, AgentBridge>,
) -> Option<agent::inflight::Snapshot> {
    bridge.streaming_message(&session_id)
}

/// List tool-approval rules currently in effect for a session/project pair.
///
/// Runs `async` + `spawn_blocking` for the same reason as
/// `approval_approve_and_grant` — see its doc comment: `RuleBook::list` performs
/// a `Path::canonicalize()` syscall via `project_key()`, plus on a cold
/// cache a `std::fs::read` and potentially a full snapshot-ring directory
/// scan, while holding a mutex.
#[tauri::command]
async fn approval_rules_list(
    session_id: String,
    project_root: Option<String>,
    rule_book: State<'_, Arc<RuleBook>>,
) -> Result<Vec<approval::Rule>, String> {
    let rule_book = Arc::clone(rule_book.inner());
    off_ipc(move || rule_book.list(&session_id, project_root.as_deref().map(Path::new))).await
}

/// Answer the open approval prompt `request_id` of `session_id` with
/// "Approve" and grant standing approval for its tool, in one call. `scope`
/// is `"session"` or `"project"` (the latter needs a process started in a
/// folder); anything else is a stable error. The tool and the project come
/// from the prompt the session's process forwarded, and the answer goes to
/// that same process (`AgentBridge::approve_and_grant`), never from the
/// webview: a prompt with no open match in that process is refused with
/// nothing answered or saved, and a rule is saved only once the answer was
/// written. A rejection means nothing reached omp (the prompt still waits);
/// `Some(reason)` means the prompt was approved but the rule was not saved.
///
/// Runs `async` + `spawn_blocking`: a project grant's `RuleBook::grant`
/// performs a locked file read-modify-write with up to several blocking
/// retry sleeps, which can stall the webview if run on Tauri's main command
/// thread.
#[tauri::command]
async fn approval_approve_and_grant(
    session_id: String,
    request_id: String,
    scope: String,
    app: AppHandle,
) -> Result<Option<String>, String> {
    let scope = parse_rule_scope(&scope)?;
    off_ipc(move || {
        let rule_book = app.state::<Arc<RuleBook>>();
        app.state::<AgentBridge>()
            .approve_and_grant(&rule_book, &session_id, &request_id, scope)
    })
    .await?
}

/// Revoke a previously granted rule. No-op (not an error) if it wasn't granted.
///
/// Runs `async` + `spawn_blocking` for the same reason as
/// `approval_approve_and_grant` — see its doc comment.
#[tauri::command]
async fn approval_rules_revoke(
    session_id: String,
    project_root: Option<String>,
    tool: String,
    scope: String,
    rule_book: State<'_, Arc<RuleBook>>,
) -> Result<(), String> {
    let rule_book = Arc::clone(rule_book.inner());
    off_ipc(move || {
        let scope = parse_rule_scope(&scope)?;
        rule_book.revoke(
            &session_id,
            project_root.as_deref().map(Path::new),
            &tool,
            scope,
        )
    })
    .await?
}

fn parse_rule_scope(scope: &str) -> Result<approval::RuleScope, String> {
    match scope {
        "session" => Ok(approval::RuleScope::Session),
        "project" => Ok(approval::RuleScope::Project),
        other => Err(format!("unknown approval rule scope '{other}'")),
    }
}

/// The approval-mode default and per-project overrides (a cache read).
#[tauri::command]
fn approval_mode_get(modes: State<'_, Arc<ApprovalModeStore>>) -> ApprovalModeView {
    modes.view()
}

/// Store the approval mode every project without an override starts omp
/// with. The frontend restarts the affected tabs; this only writes the file.
#[tauri::command]
async fn approval_mode_set_default(
    mode: String,
    modes: State<'_, Arc<ApprovalModeStore>>,
) -> Result<ApprovalModeView, String> {
    let mode = mode.parse()?;
    with_blocking(&modes, move |m| m.set_default(mode)).await
}

/// Store (`Some`) or remove (`None`: follow the default) the approval mode
/// for the absolute folder `project_root`.
#[tauri::command]
async fn approval_mode_set_project(
    project_root: String,
    mode: Option<String>,
    modes: State<'_, Arc<ApprovalModeStore>>,
) -> Result<ApprovalModeView, String> {
    let mode = mode.as_deref().map(str::parse).transpose()?;
    with_blocking(&modes, move |m| {
        m.set_project(Path::new(&project_root), mode)
    })
    .await
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
    off_ipc(move || files::list(&cwd, &query, limit)).await?
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
    app.dialog()
        .file()
        .set_title("Open Project Folder")
        .pick_folder(move |result| {
            let _ = tx.send(result);
        });
    off_ipc(move || {
        let Some(picked) = rx.recv().map_err(|e| format!("channel error: {e}"))? else {
            return Ok(None);
        };
        // into_path() rather than to_string(): a real PathBuf avoids
        // platform-specific FilePath::to_string formatting (URL encoding,
        // UNC prefix quirks).
        let path = picked
            .into_path()
            .map_err(|e| format!("invalid picked path: {e}"))?;
        // Canonical, like an OS "Open with" folder: the tab path is compared
        // with the canonical recent-projects entries (`openProject`'s
        // focus-existing lookup), so a folder picked through a symlink must
        // not look like a different project. Off the async thread: it is a
        // filesystem call.
        external_open::canonical_folder(&path).map(Some)
    })
    .await?
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
///
/// Delegates to [`navigation_guard::open_external`], so this command shares
/// the exact same allow-list as the webview's own navigation guard — it
/// cannot be used to launch a local file or any non-web/mail URL, only to
/// hand a `http(s)`/`mailto` URL to the OS (`ShellExecuteExW` on Windows,
/// `xdg-open` on Linux, `open` on macOS). `window.open(url, "_blank")` is a
/// no-op here instead (no `on_new_window` handler is registered, so wry
/// denies it) — this command is the correct path for OAuth flows and any
/// external URL that must open in the user's real browser.
#[tauri::command]
fn open_url_external(url: String) -> Result<(), String> {
    let url = Url::parse(&url).map_err(|e| e.to_string())?;
    navigation_guard::open_external(&url)
}

/// The project tree with status marks and the repo header — see
/// `git_browser::status`.
///
/// Runs `async` + `spawn_blocking`: gix's status hashes changed files and
/// walks the whole work tree for untracked ones, which can take long enough
/// on a large repository to freeze the webview if run on Tauri's main
/// command thread. The same holds for every `git_browser_*` command below
/// (blob diffs, history walks).
#[tauri::command]
async fn git_browser_status(path: String) -> Result<git_browser::StatusView, String> {
    off_ipc(move || git_browser::status(Path::new(&path))).await?
}

/// One work-tree file in full with its change against `HEAD` inline — see
/// `git_browser::file`. `async` + `spawn_blocking`: see `git_browser_status`.
#[tauri::command]
async fn git_browser_file(path: String, rel_path: String) -> Result<git_browser::FileView, String> {
    off_ipc(move || git_browser::file(Path::new(&path), &rel_path)).await?
}

/// The commit graph with refs and lanes — see `git_browser::log`.
/// `async` + `spawn_blocking`: see `git_browser_status`.
#[tauri::command]
async fn git_browser_log(path: String) -> Result<git_browser::LogView, String> {
    off_ipc(move || git_browser::log(Path::new(&path))).await?
}

/// A commit's metadata and touched files — see `git_browser::commit`.
/// `async` + `spawn_blocking`: see `git_browser_status`.
#[tauri::command]
async fn git_browser_commit(path: String, sha: String) -> Result<git_browser::CommitView, String> {
    off_ipc(move || git_browser::commit(Path::new(&path), &sha)).await?
}

/// One file as of a commit with the commit's change inline — see
/// `git_browser::commit_file`. `async` + `spawn_blocking`: see
/// `git_browser_status`.
#[tauri::command]
async fn git_browser_commit_file(
    path: String,
    sha: String,
    rel_path: String,
) -> Result<git_browser::FileView, String> {
    off_ipc(move || git_browser::commit_file(Path::new(&path), &sha, &rel_path)).await?
}

/// A file of the tab's project for the in-app preview — see
/// `project_file::read`. The folder is the one `start_session` registered
/// for the tab, never one sent by the webview. `async` + `spawn_blocking`:
/// reads up to `project_file::MAX_IMAGE_BYTES` from disk.
#[tauri::command]
async fn project_file_read(
    session_id: String,
    path: String,
    terminal: State<'_, Arc<terminal::TerminalManager>>,
) -> Result<project_file::FilePreview, String> {
    let root = terminal
        .folder(&session_id)
        .ok_or_else(|| "this tab has no project folder".to_owned())?;
    off_ipc(move || project_file::read(&root, &path)).await?
}

/// Stage a file's changes — see `workspace::accept`.
///
/// Runs `async` + `spawn_blocking`: `workspace::accept` shells out to
/// `git add`, which can take long enough on a large repository to freeze
/// the webview if run on Tauri's main command thread.
#[tauri::command]
async fn workspace_accept(path: String, rel_path: String) -> Result<(), String> {
    off_ipc(move || workspace::accept(Path::new(&path), &rel_path)).await?
}

/// Discard a file's working-tree changes (deletes it if untracked) — see
/// `workspace::reject`.
///
/// Runs `async` + `spawn_blocking` for the same reason as
/// `workspace_accept` — see its doc comment.
#[tauri::command]
async fn workspace_reject(path: String, rel_path: String) -> Result<(), String> {
    off_ipc(move || workspace::reject(Path::new(&path), &rel_path)).await?
}

/// Widget config, approvals, active view and runs — see
/// `widgets::host::WidgetsSnapshot`. A copy of the host's snapshot; no I/O.
#[tauri::command]
fn widgets_state(host: State<'_, Arc<widgets::WidgetHost>>) -> widgets::WidgetsSnapshot {
    host.state()
}

/// Re-read `widgets.json` and the approvals file (also emitted as
/// `widgets://config`). Blocks on the widget scheduler thread, which reads
/// and fingerprints every script, hence `spawn_blocking`.
#[tauri::command]
async fn widgets_reload(
    host: State<'_, Arc<widgets::WidgetHost>>,
) -> Result<widgets::WidgetsSnapshot, String> {
    with_blocking(&host, |h| Ok(h.reload())).await
}

/// Approve a plugin under the fingerprint its approval card showed; an
/// unknown id or a stale fingerprint is an error. Persists the approval.
#[tauri::command]
async fn widgets_approve(
    plugin_id: String,
    fingerprint: String,
    host: State<'_, Arc<widgets::WidgetHost>>,
) -> Result<widgets::WidgetsSnapshot, String> {
    with_blocking(&host, move |h| h.approve(&plugin_id, &fingerprint)).await
}

/// What the rail shows: active tab, rail and window visibility, hidden
/// cards. Validated by the host (malformed ids dropped, at most 64).
#[tauri::command]
fn widgets_set_view(view: widgets::ViewArgs, host: State<'_, Arc<widgets::WidgetHost>>) {
    host.set_view(view);
}

/// Manual refresh of one card; a malformed id is ignored.
#[tauri::command]
fn widgets_refresh(plugin_id: String, host: State<'_, Arc<widgets::WidgetHost>>) {
    host.refresh(&plugin_id);
}

/// Usage statistics for the "Usage" panel — see `stats::fetch`. Scoped to
/// `profile` (the active tab's profile — resolved the same way as
/// `list_saved_sessions`), *not* every profile at once: `omp stats`
/// itself resolves its session directory and SQLite warehouse against
/// one profile per invocation, the same as every other per-tab omp
/// spawn in this app. Also not all-time — the installed omp CLI's
/// `--json` path has no way to request more than a rolling last-24-hours
/// window (see `stats.rs`'s module doc for how this was confirmed).
///
/// Runs `async` + `spawn_blocking`: `stats::fetch` shells out to
/// `omp stats --json`, which first syncs every on-disk session log for
/// that profile into its SQLite warehouse — on a large history or a
/// first run this can take several seconds, long enough to freeze the
/// webview if run on Tauri's main command thread.
#[tauri::command]
async fn usage_stats(
    profile: Option<String>,
    store: State<'_, Arc<profiles::ProfileStore>>,
) -> Result<stats::DashboardStats, String> {
    let profile = store.resolve_owned(profile)?;
    off_ipc(move || stats::fetch(profile.as_deref())).await?
}

/// Whether omp's goal mode auto-continues over RPC for `profile` — see
/// `goal_config::get`. `profile` is the tab's profile, resolved like
/// `usage_stats`'s (an unlisted id is refused rather than letting omp
/// create a profile directory for it).
///
/// Runs `async` + `spawn_blocking`: it shells out to `omp config get`.
#[tauri::command]
async fn goal_continuation_get(
    profile: Option<String>,
    store: State<'_, Arc<profiles::ProfileStore>>,
) -> Result<bool, String> {
    let profile = store.resolve_owned(profile)?;
    off_ipc(move || goal_config::get(profile.as_deref())).await?
}

/// Turn goal mode's auto-continue over RPC on or off for `profile` — see
/// `goal_config::set`. Returns the effective value re-read after the
/// write. Same profile resolution and `async` + `spawn_blocking` shape as
/// [`goal_continuation_get`].
#[tauri::command]
async fn goal_continuation_set(
    profile: Option<String>,
    enabled: bool,
    store: State<'_, Arc<profiles::ProfileStore>>,
) -> Result<bool, String> {
    let profile = store.resolve_owned(profile)?;
    off_ipc(move || goal_config::set(profile.as_deref(), enabled)).await?
}

/// Shared profile-resolution and home-dir setup for the three keybindings
/// commands. Returns `(home, resolved_profile, env_dir)` ready to pass to
/// `keybindings::payload` / `keybindings::payload_with_overlay`.
fn kb_resolve(
    profile: Option<String>,
    store: &profiles::ProfileStore,
    app: &AppHandle,
) -> Result<(PathBuf, Option<String>, Option<OsString>), String> {
    let profile = store.resolve_owned(profile)?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let env_dir = std::env::var_os("PI_CODING_AGENT_DIR");
    Ok((home, profile, env_dir))
}

/// Shared tail of [`keybindings_set`]/[`keybindings_reset`]: resolve the
/// profile, run `mutate` against the overlay off the main thread, and
/// rebuild the payload from its result without a second overlay read.
async fn kb_mutate(
    profile: Option<String>,
    store: &profiles::ProfileStore,
    overlay: &Arc<keybindings::overlay::OverlayStore>,
    app: &AppHandle,
    mutate: impl FnOnce(&keybindings::overlay::OverlayStore) -> Result<keybindings::Bindings, String>
        + Send
        + 'static,
) -> Result<keybindings::Payload, String> {
    let (home, resolved, env_dir) = kb_resolve(profile, store, app)?;
    with_blocking(overlay, move |overlay| {
        let overlay_bindings = mutate(overlay)?;
        keybindings::payload_with_overlay(
            &home,
            resolved.as_deref(),
            env_dir.as_deref(),
            overlay_bindings,
            overlay.path(),
        )
    })
    .await
}

/// Return the current keybinding payload for `profile`.
///
/// Runs `spawn_blocking` because both the omp config and the overlay are
/// filesystem reads that can block on a slow or network-mounted home dir.
#[tauri::command]
async fn keybindings_list(
    profile: Option<String>,
    store: State<'_, Arc<profiles::ProfileStore>>,
    overlay: State<'_, Arc<keybindings::overlay::OverlayStore>>,
    app: AppHandle,
) -> Result<keybindings::Payload, String> {
    let (home, resolved, env_dir) = kb_resolve(profile, &store, &app)?;
    with_blocking(&overlay, move |overlay| {
        keybindings::payload(&home, resolved.as_deref(), env_dir.as_deref(), overlay)
    })
    .await
}

/// Bind `action` to `keys` in the desktop overlay and return the updated
/// payload.
#[tauri::command]
async fn keybindings_set(
    action: String,
    keys: Vec<String>,
    profile: Option<String>,
    store: State<'_, Arc<profiles::ProfileStore>>,
    overlay: State<'_, Arc<keybindings::overlay::OverlayStore>>,
    app: AppHandle,
) -> Result<keybindings::Payload, String> {
    kb_mutate(profile, &store, &overlay, &app, move |overlay| {
        // Use the map returned by set() directly — avoids a second file read.
        overlay.set(&action, &keys)
    })
    .await
}

/// Remove `action` from the desktop overlay and return the updated payload.
#[tauri::command]
async fn keybindings_reset(
    action: String,
    profile: Option<String>,
    store: State<'_, Arc<profiles::ProfileStore>>,
    overlay: State<'_, Arc<keybindings::overlay::OverlayStore>>,
    app: AppHandle,
) -> Result<keybindings::Payload, String> {
    kb_mutate(profile, &store, &overlay, &app, move |overlay| {
        overlay.remove(&action)
    })
    .await
}

/// `profile` as the key its recent-projects entries are stored under: the
/// built-in profile (`None`/blank/`"default"`) is `"default"`, an unlisted
/// id is an `Err` (same validation as every other profile-scoped command).
fn recents_key(store: &profiles::ProfileStore, profile: Option<String>) -> Result<String, String> {
    Ok(store
        .resolve_owned(profile)?
        .unwrap_or_else(|| profiles::DEFAULT_PROFILE_ID.to_owned()))
}

/// `profile`'s recently opened project folders, newest first (the project
/// sidebar's `recent` section). Folders gone from disk are omitted.
#[tauri::command]
async fn recent_projects_list(
    profile: Option<String>,
    store: State<'_, Arc<profiles::ProfileStore>>,
    recents: State<'_, Arc<recent_projects::RecentProjectsStore>>,
) -> Result<Vec<recent_projects::RecentProject>, String> {
    let key = recents_key(&store, profile)?;
    with_blocking(&recents, move |s| Ok(s.list(&key))).await
}

/// Record `path` as just opened under `profile` and return the updated list.
/// The path is canonicalised first, so a folder that no longer exists (or a
/// file) is refused instead of recorded.
#[tauri::command]
async fn recent_projects_touch(
    path: String,
    profile: Option<String>,
    store: State<'_, Arc<profiles::ProfileStore>>,
    recents: State<'_, Arc<recent_projects::RecentProjectsStore>>,
) -> Result<Vec<recent_projects::RecentProject>, String> {
    let key = recents_key(&store, profile)?;
    with_blocking(&recents, move |s| {
        let canonical = external_open::canonical_folder(Path::new(&path))?;
        s.touch(&key, canonical, recent_projects::now_ms())
    })
    .await
}

/// Drop `path` from `profile`'s recent list and return the updated list.
#[tauri::command]
async fn recent_projects_remove(
    path: String,
    profile: Option<String>,
    store: State<'_, Arc<profiles::ProfileStore>>,
    recents: State<'_, Arc<recent_projects::RecentProjectsStore>>,
) -> Result<Vec<recent_projects::RecentProject>, String> {
    let key = recents_key(&store, profile)?;
    with_blocking(&recents, move |s| s.remove(&key, &path)).await
}

/// The open-tab layout saved by the previous run (issue #17), minus tabs
/// whose folder is gone — see `open_tabs::restorable`.
#[tauri::command]
async fn open_tabs_load(
    tabs: State<'_, Arc<open_tabs::OpenTabsStore>>,
) -> Result<open_tabs::Restore, String> {
    with_blocking(&tabs, |s| Ok(s.load())).await
}

/// Replace the saved open-tab layout.
#[tauri::command]
async fn open_tabs_save(
    layout: open_tabs::Layout,
    tabs: State<'_, Arc<open_tabs::OpenTabsStore>>,
) -> Result<(), String> {
    with_blocking(&tabs, move |s| s.save(&layout)).await
}

/// `profile`'s most recently used model keys (`provider/modelId`), newest
/// first, from omp's own `agent.db` — the model picker's `recent` group.
/// Empty when the database or its table can't be read.
#[tauri::command]
async fn model_usage_list(
    profile: Option<String>,
    store: State<'_, Arc<profiles::ProfileStore>>,
    app: AppHandle,
) -> Result<Vec<String>, String> {
    let profile = store.resolve_owned(profile)?;
    off_ipc(move || model_usage::recent_for(&app, profile.as_deref())).await
}

/// Ask the release feed for a newer version — see `updater::check`.
/// `None` means up to date.
#[tauri::command]
async fn app_update_check(
    app: AppHandle,
    state: State<'_, updater::UpdaterState>,
) -> Result<Option<updater::UpdateInfo>, String> {
    updater::check(&app, &state).await
}

/// Download, install and relaunch into the update found by the last
/// `app_update_check` — see `updater::install`. On Windows success never
/// returns (the installer takes over); elsewhere `Ok` means a relaunch is
/// already requested.
#[tauri::command]
async fn app_update_install(
    app: AppHandle,
    state: State<'_, updater::UpdaterState>,
) -> Result<(), String> {
    updater::install(&app, &state).await
}

/// Kill every child process tree the app owns — omp sessions first, then
/// the tabs' Chromium browsers, running widget plugins and terminal shells —
/// on the calling thread. For the exits where managed state is never dropped
/// (app exit, the updater relaunch); on Unix each tree sits in its own process
/// group or session and would outlive us. Every step is idempotent.
pub(crate) fn kill_child_processes(app: &AppHandle) {
    remote::bridge::stop(app);
    app.state::<AgentBridge>().shutdown_all();
    if let Some(browser) = app.try_state::<browser::BrowserManager>() {
        browser.shutdown_all();
    }
    widgets::kill_all(app);
    // Managed in `setup` (it needs the config dir): absent only if the app
    // exits before that ran, when there is no shell to kill either.
    if let Some(terminal) = app.try_state::<Arc<terminal::TerminalManager>>() {
        terminal.shutdown_all();
    }
}

/// "Ask before closing a busy tab" (#37, Settings → Session): whether a
/// user's request to close the main window (or quit) must first be
/// confirmed in the webview. The webview arms it only while the setting is
/// on and a tab is busy (`live.js` `_syncCloseGuard`), so with nothing to
/// lose the window closes the normal way; armed, [`handle_run_event`]
/// holds the close and emits [`CLOSE_REQUESTED_EVENT`], and the webview
/// disarms the guard before it closes the window itself, so the exit then
/// takes the usual path through [`kill_child_processes`].
#[derive(Default)]
struct CloseGuard(AtomicBool);

/// Payload-free: tells the webview a close was held for its confirmation.
const CLOSE_REQUESTED_EVENT: &str = "window://close-requested";

/// Arm (`true`) or disarm the [`CloseGuard`].
#[tauri::command]
fn set_close_guard(armed: bool, guard: State<'_, CloseGuard>) {
    guard.0.store(armed, Ordering::SeqCst);
}

/// Whether a close of window `label` is held for the webview to confirm:
/// only the main window's, and only while the webview armed the guard.
fn holds_close(label: &str, armed: bool) -> bool {
    armed && label == "main"
}

/// The per-user folder the persistent stores live in, from Tauri's
/// `app_config_dir()`. `None` when it can't be resolved or is relative:
/// every store then keeps its state in memory for the app run. There is no
/// fallback to a shared location such as the OS temp dir, where another
/// local account could plant the files these stores trust (`open-tabs.json`
/// alone picks the folders and profiles omp starts in), and a relative path
/// would resolve against whatever the working directory happens to be.
fn config_dir<E: std::fmt::Display>(resolved: Result<PathBuf, E>) -> Option<PathBuf> {
    match resolved {
        Ok(dir) if dir.is_absolute() => Some(dir),
        Ok(dir) => {
            eprintln!(
                "[omp-desktop] app config dir {} is not absolute; settings are kept in memory only",
                dir.display()
            );
            None
        }
        Err(e) => {
            eprintln!("[omp-desktop] no app config dir ({e}); settings are kept in memory only");
            None
        }
    }
}

/// App-level state that needs a resolved path, and the cold-start "Open
/// with" argv — `run()`'s `setup` hook. No omp process starts here: the app
/// opens with no tab until the user (or an OS folder open) picks a project.
fn setup(app: &tauri::App) {
    #[cfg(debug_assertions)]
    if let Some(win) = app.get_webview_window("main") {
        win.open_devtools();
    }
    // Every store below is memory-only without it (see `config_dir`).
    let resolved_config_dir = config_dir(app.path().app_config_dir());
    let config_file = |name: &str| resolved_config_dir.as_deref().map(|dir| dir.join(name));
    // Rail widget plugins: <app_config_dir>/widgets.json and the approvals in
    // <app_config_dir>/widget-approvals.json. No temp-dir fallback: a
    // `widgets.json` in a shared temp dir could be planted by another user,
    // so without a config dir widgets stay disabled (the snapshot's `fatal`).
    let (widget_config, widget_approvals) = resolved_config_dir
        .as_deref()
        .map(|dir| (dir.join("widgets.json"), dir.join("widget-approvals.json")))
        .unzip();
    // Terminal tabs and the shell setting: <app_config_dir>/terminal.json.
    // No temp-dir fallback either: another account could plant the shell
    // this one runs; without a config dir the setting stays in memory.
    app.manage(Arc::new(terminal::TerminalManager::new(config_file(
        "terminal.json",
    ))));
    // Approval mode: <app_config_dir>/approval-mode.json. No temp-dir
    // fallback: another account could plant a `yolo` there; without a config
    // dir the choice stays in memory.
    app.manage(Arc::new(ApprovalModeStore::load(config_file(
        "approval-mode.json",
    ))));
    // The browser panel's Chromium setting: <app_config_dir>/browser.json.
    // No temp-dir fallback: another account could plant the browser this one
    // runs; without a config dir the setting stays in memory. An
    // unresolvable home only loses the candidates under it (omp's Chrome for
    // Testing cache, macOS `~/Applications`).
    let browser_store = Arc::new(browser::SettingsStore::load(
        config_file("browser.json"),
        app.path().home_dir().ok(),
    ));
    app.manage(Arc::clone(&browser_store));
    // Approval-rule store: project-scoped grants persist under
    // <app_config_dir>/approval-rules/<project-hash>.json. No temp-dir
    // fallback: another account could plant grants there that approve
    // tools without asking; without a config dir they stay in memory.
    app.manage(Arc::new(
        resolved_config_dir
            .as_deref()
            .map_or_else(RuleBook::in_memory, |dir| {
                RuleBook::new(dir.join("approval-rules"))
            }),
    ));
    // Per-tab headless Chromium + the overlay omp reads its `cdpUrl` from.
    // It lives under the per-user app cache dir (user-owned, unlike a shared
    // temp dir); without one the manager is unavailable and sessions start
    // without a managed browser.
    let browser = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("no app cache dir: {e}"))
        .and_then(|dir| browser::BrowserManager::new(&dir.join("browser"), browser_store))
        .unwrap_or_else(|reason| {
            eprintln!("[omp-desktop] managed browser disabled: {reason}");
            browser::BrowserManager::unavailable(reason)
        });
    app.manage(browser);
    // What crashed earlier runs left under the browser root: reaping their
    // browsers can take seconds, so not on the main thread.
    let pruner = app.handle().clone(); // the thread owns its handle
    let pruning = std::thread::Builder::new()
        .name("browser-prune".into())
        .spawn(move || {
            pruner
                .state::<browser::BrowserManager>()
                .prune_stale_instances();
        });
    if let Err(e) = pruning {
        eprintln!("[omp-desktop] browser leftovers not pruned: {e}");
    }
    // Profile list: <app_config_dir>/profiles.json. No temp-dir fallback for
    // it or the stores below: another account could plant the profile tabs
    // start in, a rebind, or the folders the next launch opens.
    app.manage(Arc::new(profiles::ProfileStore::load(config_file(
        "profiles.json",
    ))));
    // Keybinding overlay: <app_config_dir>/keybindings.json.
    app.manage(Arc::new(keybindings::overlay::OverlayStore::new(
        config_file("keybindings.json"),
    )));
    // Widget scheduler thread; it loads the config and approvals itself.
    // Each run executes private copies of the plugin's scripts under
    // <app_cache_dir>/widget-runs (user-owned, unlike a shared temp dir).
    app.manage(Arc::new(widgets::WidgetHost::for_app(
        app.handle().clone(), // the host emits `widgets://` events for the app's lifetime
        widget_config,
        widget_approvals,
        app.path()
            .app_cache_dir()
            .ok()
            .map(|dir| dir.join("widget-runs")),
    )));
    // Recently opened projects: <app_config_dir>/recent-projects.json.
    app.manage(Arc::new(recent_projects::RecentProjectsStore::new(
        config_file("recent-projects.json"),
    )));
    // Open-tab layout for the next launch: <app_config_dir>/open-tabs.json.
    app.manage(Arc::new(open_tabs::OpenTabsStore::new(config_file(
        "open-tabs.json",
    ))));
    // Phone remote access: settings in <app_config_dir>/remote.json, devices
    // in remote-devices.json; started once from the saved settings.
    remote::bridge::install(app, resolved_config_dir.clone()); // `config_file` still borrows it

    // A cold start *is* how Windows and Linux file managers open a
    // folder, so the launch argv is the third delivery path into the
    // queue (alongside the single-instance forward and macOS'
    // `Opened` event). Queued, not opened here: the webview has no
    // listener yet, so `live.js` drains it on init.
    //
    // `args_os`, not `args`: the latter panics on a non-UTF-8
    // argument, and a Linux directory name is an arbitrary byte
    // string that the `.desktop` entry's `%F` passes verbatim. A
    // lossy path fails `canonicalize` and is logged like any other
    // unusable request instead of killing the launch. Only this
    // cold-start path is protected — a forwarded open goes through
    // `tauri-plugin-single-instance`, whose sending process collects
    // `std::env::args()` and so aborts before anything reaches us.
    //
    // A cold start's argv was produced in this process' own cwd, so
    // that is the base for a relative path; an unreadable cwd
    // degrades to the empty path, which means the same thing.
    external_open::ingest_args(
        app.handle(),
        &std::env::current_dir().unwrap_or_default(),
        std::env::args_os().map(|arg| arg.to_string_lossy().into_owned()),
    );
}

/// Windows and Linux deliver a folder "Open with" by launching the
/// executable with the path in argv, so without this a second open would
/// start a whole second app — a second window, a second set of omp
/// children — instead of adding a tab to the running one. The forwarded
/// argv goes through the same queue as a cold start's.
///
/// macOS needs none of it: `LaunchServices` reuses the running instance and
/// delivers `RunEvent::Opened` to it (see [`handle_run_event`]).
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn single_instance_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_single_instance::init(|app, argv, cwd| {
        // `cwd` is why the plugin sends it: the second process' argv may hold
        // a relative path (`omp-desktop .` from another shell), and resolving
        // that here would otherwise pick *this* instance's directory.
        external_open::ingest_args(app, Path::new(&cwd), argv);
        // The file manager is the caller, not the user: an open forwarded
        // into a minimised or buried window would otherwise add its tab
        // out of sight and read as a no-op.
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
    })
}

/// The plugins after the single-instance one, and the app-wide state the
/// commands read. Split out of [`run`], whose command list alone nears
/// the function-length lint.
fn with_plugins_and_state(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .plugin(navigation_guard::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_page_load(|webview, payload| {
            remote::bridge::on_page_load(
                webview,
                matches!(payload.event(), tauri::webview::PageLoadEvent::Started),
            );
        })
        .manage(AgentBridge::new())
        .manage(GitWatcherState::new())
        .manage(OpenProjectState::new())
        .manage(updater::UpdaterState::default())
        .manage(CloseGuard::default())
}

/// Run the Tauri application. Panics if the runtime fails to initialise.
///
/// # Panics
///
/// Panics if `tauri::Builder::build` returns an error (e.g. the webview
/// runtime cannot be initialised). This is a fatal startup condition;
/// there is no meaningful recovery from inside `main`.
// The command list alone is what makes this long; `generate_handler!` takes one list.
#[allow(clippy::too_many_lines)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Registered first, as the plugin requires (see `single_instance_plugin`).
    // Shadowed rather than reassigned through a `mut` binding, which would be
    // an `unused_mut` warning (and so a lint-gate error) on macOS.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(single_instance_plugin());
    let app = with_plugins_and_state(builder)
        .invoke_handler(tauri::generate_handler![
            send_command,
            start_session,
            stop_session,
            terminal_open,
            terminal_status,
            terminal_replay,
            terminal_ack,
            terminal_write,
            terminal_resize,
            terminal_settings,
            terminal_set_shell,
            terminal_pick_shell,
            browser_settings,
            browser_set_path,
            browser_pick_path,
            close_tab,
            close_all_tabs,
            browser::commands::browser_open_panel,
            browser::commands::browser_close_panel,
            browser::commands::browser_resize,
            browser::commands::browser_navigate,
            browser::commands::browser_history,
            browser::commands::browser_tab_new,
            browser::commands::browser_tab_close,
            browser::commands::browser_tab_activate,
            browser::commands::browser_input,
            browser::commands::browser_frame_ack,
            browser::commands::browser_annotate,
            browser::commands::browser_capture,
            browser::commands::browser_scroll_to,
            session_status,
            replay_events,
            extension_ui_state,
            streaming_message,
            open_project,
            take_pending_open_projects,
            start_git_watch,
            stop_git_watch,
            open_url_external,
            list_saved_sessions,
            conversation_tree,
            approval_rules_list,
            approval_approve_and_grant,
            approval_rules_revoke,
            approval_mode_get,
            approval_mode_set_default,
            approval_mode_set_project,
            git_browser_status,
            git_browser_file,
            git_browser_log,
            git_browser_commit,
            git_browser_commit_file,
            project_file_read,
            workspace_accept,
            workspace_reject,
            widgets_state,
            widgets_reload,
            widgets_approve,
            widgets_set_view,
            widgets_refresh,
            usage_stats,
            goal_continuation_get,
            goal_continuation_set,
            list_project_files,
            list_profiles,
            create_profile,
            rename_profile,
            delete_profile,
            set_startup_profile,
            clear_profile_bootstrap,
            keybindings_list,
            keybindings_set,
            keybindings_reset,
            recent_projects_list,
            recent_projects_touch,
            recent_projects_remove,
            open_tabs_load,
            open_tabs_save,
            model_usage_list,
            app_update_check,
            app_update_install,
            set_close_guard,
            remote::commands::remote_status,
            remote::commands::remote_interfaces,
            remote::commands::remote_apply_settings,
            remote::commands::remote_pair_start,
            remote::commands::remote_pair_cancel,
            remote::commands::remote_device_rename,
            remote::commands::remote_device_revoke,
            remote::commands::remote_regenerate_cert,
            remote::commands::remote_publish,
            remote::commands::remote_action_result,
            remote::commands::remote_ready,
            remote::commands::remote_push_test,
            remote::commands::remote_default_contact,
        ])
        .setup(|app| {
            setup(app);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(handle_run_event);
}

/// Handle lifecycle and platform file-open events from the Tauri run loop.
fn handle_run_event(app: &AppHandle, event: tauri::RunEvent) {
    match &event {
        tauri::RunEvent::Exit => kill_child_processes(app),
        // The OS close (title-bar menu, Alt+F4, taskbar) of a window the
        // [`CloseGuard`] holds: the webview confirms, then closes it itself.
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } if holds_close(label, app.state::<CloseGuard>().0.load(Ordering::SeqCst)) => {
            api.prevent_close();
            announce_held_close(app);
        }
        // A quit that is not a window close (macOS Cmd+Q). `code: None` is
        // a user's request; the updater's restart and `exit` carry a code.
        // The last window closing also lands here with `None`, but only
        // after the guard let that close through, i.e. while disarmed.
        tauri::RunEvent::ExitRequested {
            code: None, api, ..
        } if app.state::<CloseGuard>().0.load(Ordering::SeqCst) => {
            api.prevent_exit();
            announce_held_close(app);
        }
        _ => {}
    }
    // macOS' "Open with" for a folder (see `Info.plist`) arrives as a
    // run-loop event, on launch *and* while already running — the one
    // delivery path that is neither argv nor a plugin. `RunEvent::Opened`
    // does not exist on the other targets.
    #[cfg(target_os = "macos")]
    if let tauri::RunEvent::Opened { urls } = &event {
        external_open::ingest_urls(app, urls);
    }
}

/// Ask the webview to confirm a close [`handle_run_event`] held.
fn announce_held_close(app: &AppHandle) {
    if let Err(e) = app.emit(CLOSE_REQUESTED_EVENT, ()) {
        eprintln!("[omp-desktop] failed to forward the window close for confirmation: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::{config_dir, holds_close, StartSessionArgs};
    use std::path::PathBuf;

    #[test]
    fn an_absolute_config_dir_is_used_as_is() {
        let cwd = std::env::current_dir().expect("cwd");
        assert!(cwd.is_absolute());
        let dir = config_dir::<&str>(Ok(cwd.join("omp-desktop-config")));
        assert_eq!(dir, Some(cwd.join("omp-desktop-config")));
    }

    #[test]
    fn an_unresolvable_config_dir_means_memory_only_not_the_temp_dir() {
        assert_eq!(config_dir::<&str>(Err("no home directory")), None);
    }

    #[test]
    fn a_relative_config_dir_is_refused() {
        assert_eq!(
            config_dir::<&str>(Ok(PathBuf::from("omp-desktop-config"))),
            None
        );
    }

    /// The guard holds only the main window's close, and only while armed:
    /// with it disarmed (setting off, or no busy tab) closing never waits.
    #[test]
    fn only_an_armed_guard_holds_the_main_windows_close() {
        assert!(holds_close("main", true));
        assert!(!holds_close("main", false));
        assert!(!holds_close("other", true));
    }

    /// The exact payload `live.js::_spawnSession` sends. Tauri hands the
    /// `args` object straight to serde, so a field-name or casing change on
    /// either side silently breaks session start — this pins the contract.
    #[test]
    fn start_session_payload_deserializes_from_the_frontend_shape() {
        let payload = serde_json::json!({
            "sessionId": "session-1",
            "cwd": "/home/dev/project",
            "resume": null,
            "profile": "work",
        });
        let args: StartSessionArgs = serde_json::from_value(payload).expect("deserialize");
        assert_eq!(args.session_id, "session-1");
        assert_eq!(args.cwd, "/home/dev/project");
        assert_eq!(args.resume, None);
        assert_eq!(args.profile.as_deref(), Some("work"));
    }

    /// The contract `deny_unknown_fields` exists for (see the attribute's
    /// doc comment above `StartSessionArgs`): a renamed/misspelled key must
    /// fail loudly, not deserialize with `profile: None` and silently write
    /// a named profile's conversation into the shared `~/.omp/agent` tree.
    /// The happy-path test above would still pass with the attribute
    /// deleted, so it alone doesn't pin this.
    #[test]
    fn start_session_payload_rejects_an_unknown_field_instead_of_silently_dropping_it() {
        let payload = serde_json::json!({
            "sessionId": "session-1",
            "cwd": "/home/dev/project",
            "resume": null,
            "profileId": "work",
        });
        assert!(
            serde_json::from_value::<StartSessionArgs>(payload).is_err(),
            "a renamed profile field must be a loud deserialize error, not a silent None"
        );
    }
}
