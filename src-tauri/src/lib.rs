// Tauri's `#[command]` macro requires arguments by value (owned `String`,
// `State<'_, _>`, `AppHandle`) for deserialization from the frontend
// invoke payload. Suppress the related pedantic lints at module scope so
// command signatures stay idiomatic for the Tauri API.
#![allow(clippy::needless_pass_by_value)]

mod agent;
mod approval;
mod browser;
mod child_path;
mod conversation_tree;
mod external_open;
mod files;
mod git;
mod git_watcher;
mod goal_config;
mod json_store;
mod keybindings;
mod model_usage;
mod navigation_guard;
mod omp_cli;
mod open_tabs;
mod profiles;
mod recent_projects;
mod redaction;
mod saved_sessions;
mod stats;
mod terminal;
mod text;
mod updater;
mod widgets;
mod workspace;

use agent::AgentBridge;
use approval::RuleBook;
use external_open::OpenProjectState;
use git_watcher::GitWatcherState;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State, Url};

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
    /// The user's Chromium choice for the browser panel (`browserPath` tweak);
    /// `None` or empty = find one automatically (`browser::locate`).
    browser_path: Option<String>,
}

/// Register the tab with the terminal, start an omp process for it, then
/// tell the widget host (which computes the project's git context on its own
/// thread). The terminal comes first so a failed omp spawn still leaves the
/// tab a working shell; registering an existing tab (a profile switch) keeps
/// its shell.
#[tauri::command]
fn start_session(
    args: StartSessionArgs,
    bridge: State<'_, AgentBridge>,
    rule_book: State<'_, Arc<RuleBook>>,
    store: State<'_, Arc<profiles::ProfileStore>>,
    widget_host: State<'_, Arc<widgets::WidgetHost>>,
    terminal: State<'_, Arc<terminal::TerminalManager>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let profile = store.resolve(args.profile.as_deref())?;
    if let Some(r) = args.resume.as_deref() {
        saved_sessions::validate_resume(&app, r, profile)?;
    }
    let cwd_opt = if args.cwd.is_empty() {
        None
    } else {
        Some(args.cwd.as_str())
    };
    terminal.register_tab(&args.session_id, cwd_opt.map(Path::new));
    // The tab's browser (idempotent: a profile respawn reuses it). Without
    // one the session starts without `--config` and omp falls back to its
    // own browser.
    let browser_pref = args
        .browser_path
        .as_deref()
        .filter(|p| !p.is_empty())
        .map(Path::new);
    let overlay = app
        .state::<browser::BrowserManager>()
        .allocate(&args.session_id, browser_pref)
        .map_err(|e| {
            eprintln!(
                "[omp-desktop] browser unavailable for {}: {e}",
                args.session_id
            );
        })
        .ok();
    let launch = agent::spawn::LaunchOptions {
        cwd: cwd_opt,
        resume: args.resume.as_deref(),
        profile,
        config: overlay.as_deref(),
    };
    // The bridge takes the id by value; the widget hook below still needs it.
    let session_id = args.session_id.clone();
    bridge.start_session(args.session_id, &launch, app, Arc::clone(rule_book.inner()))?;
    widget_host.session_started(&session_id, cwd_opt.map(Path::new));
    Ok(())
}

/// Run a blocking operation against a shared `Arc<S>` off the main command
/// thread — the `Arc::clone` + `spawn_blocking` + join-error tail every
/// state-mutating command shares (`ProfileStore` and the keybindings
/// `OverlayStore` alike): each one is a locked, fsync'd read-modify-write of
/// its own JSON file (same rationale as `approval_rules_grant`).
async fn with_blocking<S: Send + Sync + 'static, T: Send + 'static>(
    shared: &Arc<S>,
    f: impl FnOnce(&S) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let shared = Arc::clone(shared);
    tauri::async_runtime::spawn_blocking(move || f(&shared))
        .await
        .map_err(|e| format!("join error: {e}"))?
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
    tauri::async_runtime::spawn_blocking(move || profiles::clear_bootstrap(&home, &id))
        .await
        .map_err(|e| format!("join error: {e}"))
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
    tauri::async_runtime::spawn_blocking(move || {
        saved_sessions::scan_saved_sessions(&app, cwd.as_deref(), profile.as_deref())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
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
    tauri::async_runtime::spawn_blocking(move || {
        conversation_tree::load(&app, &session_file, profile.as_deref())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Kill the omp process for a tab session. Also drops its session-scoped
/// approval-rule grants (see `approval::RuleBook::clear_session`) and its
/// widget runs.
///
/// Deliberately does NOT touch the tab's terminal or browser: a profile switch
/// respawns omp while its shell and Chromium stay. Both end only through
/// [`close_tab`] / [`close_all_tabs`] and [`kill_child_processes`].
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

/// End a tab for good: its omp process (with its session grants), browser,
/// widget runs, git watcher and terminal shell. The one place a tab ends.
fn end_tab(app: &AppHandle, session_id: &str) {
    end_tab_but_terminal(app, session_id);
    app.state::<Arc<terminal::TerminalManager>>()
        .close_tab(session_id);
}

/// [`end_tab`] without the terminal, for [`close_all_tabs`], which ends
/// every terminal at once.
fn end_tab_but_terminal(app: &AppHandle, session_id: &str) {
    let rule_book = app.state::<Arc<RuleBook>>();
    app.state::<AgentBridge>()
        .stop_session(session_id, &rule_book);
    app.state::<browser::BrowserManager>().release(session_id);
    app.state::<Arc<widgets::WidgetHost>>()
        .session_closed(session_id);
    app.state::<GitWatcherState>().stop(session_id);
}

/// Close a tab (the frontend's `closeSession`) — see [`end_tab`]. `async` +
/// `spawn_blocking`: reaping omp and killing the shell's processes block.
#[tauri::command]
async fn close_tab(session_id: String, app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || end_tab(&app, &session_id))
        .await
        .map_err(|e| format!("join error: {e}"))
}

/// End every tab the backend knows. Called by the webview at boot, before
/// it restores its tabs: tab ids are never reused across a reload, so
/// whatever is registered then belongs to a previous document and would
/// otherwise run on unseen. The terminal's registry is the tab set:
/// [`start_session`] registers the tab before it spawns omp, and only
/// [`end_tab`] (or an app exit) unregisters it. Only the tabs registered at
/// the start end: one started meanwhile keeps its terminal. Their shells
/// share one hang-up grace (`TerminalManager::close_tabs`) instead of one
/// per tab.
#[tauri::command]
async fn close_all_tabs(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let terminal = app.state::<Arc<terminal::TerminalManager>>();
        let ids = terminal.tab_ids();
        for id in &ids {
            end_tab_but_terminal(&app, id);
        }
        terminal.close_tabs(&ids);
    })
    .await
    .map_err(|e| format!("join error: {e}"))
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
/// Tweaks panel cannot change under a pick, no second dialog); rfd's GTK3
/// backend ignores the parent, so on Linux the window stays usable.
#[tauri::command]
async fn terminal_pick_shell(
    window: tauri::WebviewWindow,
    terminal: State<'_, Arc<terminal::TerminalManager>>,
) -> Result<Option<terminal::TerminalSettings>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    let dialog = window
        .dialog()
        .file()
        .set_title("Choose a Shell")
        .set_parent(&window);
    #[cfg(windows)]
    let dialog = dialog.add_filter("Programs", &["exe"]);
    dialog.pick_file(move |result| {
        let _ = tx.send(result);
    });
    with_blocking(&terminal, move |t| {
        let Some(picked) = rx.recv().map_err(|e| format!("channel error: {e}"))? else {
            return Ok(None);
        };
        let path = picked
            .into_path()
            .map_err(|e| format!("invalid picked path: {e}"))?;
        let path = path
            .to_str()
            .ok_or_else(|| format!("{} is not a UTF-8 path", path.display()))?;
        t.set_shell(path).map(Some)
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
    let rule_book = Arc::clone(rule_book.inner());
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
    let rule_book = Arc::clone(rule_book.inner());
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
    let rule_book = Arc::clone(rule_book.inner());
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
    app.dialog()
        .file()
        .set_title("Open Project Folder")
        .pick_folder(move |result| {
            let _ = tx.send(result);
        });
    tauri::async_runtime::spawn_blocking(move || {
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
    .await
    .map_err(|e| format!("join error: {e}"))?
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
    tauri::async_runtime::spawn_blocking(move || stats::fetch(profile.as_deref()))
        .await
        .map_err(|e| format!("join error: {e}"))?
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
    tauri::async_runtime::spawn_blocking(move || goal_config::get(profile.as_deref()))
        .await
        .map_err(|e| format!("join error: {e}"))?
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
    tauri::async_runtime::spawn_blocking(move || goal_config::set(profile.as_deref(), enabled))
        .await
        .map_err(|e| format!("join error: {e}"))?
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
    tauri::async_runtime::spawn_blocking(move || model_usage::recent_for(&app, profile.as_deref()))
        .await
        .map_err(|e| format!("join error: {e}"))
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

/// App-level state that needs a resolved path, and the cold-start "Open
/// with" argv — `run()`'s `setup` hook. No omp process starts here: the app
/// opens with no tab until the user (or an OS folder open) picks a project.
fn setup(app: &tauri::App) {
    #[cfg(debug_assertions)]
    if let Some(win) = app.get_webview_window("main") {
        win.open_devtools();
    }
    let resolved_config_dir = app.path().app_config_dir().ok();
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
    app.manage(Arc::new(terminal::TerminalManager::new(
        resolved_config_dir
            .as_deref()
            .map(|dir| dir.join("terminal.json")),
    )));
    // Falls back to the temp dir if the config dir can't be resolved
    // (e.g. a locked-down test environment) rather than failing
    // startup — approval grants and profiles just won't survive a
    // restart there.
    let config_dir = resolved_config_dir.unwrap_or_else(std::env::temp_dir);
    // Per-tab headless Chromium + the overlay omp reads its `cdpUrl` from.
    // It lives under the per-user app cache dir (user-owned, unlike a shared
    // temp dir); without one the manager is unavailable and sessions start
    // without a managed browser. An unresolvable home only loses the
    // Chrome-for-Testing candidates, not the installed browsers.
    let browser_home = app
        .path()
        .home_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let browser = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("no app cache dir: {e}"))
        .and_then(|dir| browser::BrowserManager::new(dir.join("browser"), browser_home))
        .unwrap_or_else(|reason| {
            eprintln!("[omp-desktop] managed browser disabled: {reason}");
            browser::BrowserManager::unavailable(reason)
        });
    app.manage(browser);
    // Approval-rule store: project-scoped grants persist under
    // <app_config_dir>/approval-rules/<project-hash>.json.
    app.manage(Arc::new(RuleBook::new(config_dir.join("approval-rules"))));
    // Profile list: <app_config_dir>/profiles.json.
    app.manage(Arc::new(profiles::ProfileStore::load(
        config_dir.join("profiles.json"),
    )));
    // Keybinding overlay: <app_config_dir>/keybindings.json.
    app.manage(Arc::new(keybindings::overlay::OverlayStore::new(
        config_dir.join("keybindings.json"),
    )));
    // Widget scheduler thread; it loads the config and approvals itself.
    app.manage(Arc::new(widgets::WidgetHost::for_app(
        app.handle().clone(), // the host emits `widgets://` events for the app's lifetime
        widget_config,
        widget_approvals,
    )));
    // Recently opened projects: <app_config_dir>/recent-projects.json.
    app.manage(Arc::new(recent_projects::RecentProjectsStore::new(
        config_dir.join("recent-projects.json"),
    )));
    // Open-tab layout for the next launch: <app_config_dir>/open-tabs.json.
    app.manage(Arc::new(open_tabs::OpenTabsStore::new(
        config_dir.join("open-tabs.json"),
    )));

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

/// Run the Tauri application. Panics if the runtime fails to initialise.
///
/// # Panics
///
/// Panics if `tauri::Builder::build` returns an error (e.g. the webview
/// runtime cannot be initialised). This is a fatal startup condition;
/// there is no meaningful recovery from inside `main`.
pub fn run() {
    let builder = tauri::Builder::default();
    // Windows and Linux deliver a folder "Open with" by launching the
    // executable with the path in argv, so without this a second open would
    // start a whole second app — a second window, a second set of
    // omp children — instead of adding a tab to the running one. The
    // forwarded argv goes through the same queue as a cold start's.
    //
    // macOS needs none of it: LaunchServices reuses the running instance
    // and delivers `RunEvent::Opened` to it (see the `app.run` callback).
    //
    // Registered first, as the plugin requires. Shadowed rather than
    // reassigned through a `mut` binding, which would be an `unused_mut`
    // warning (and so a lint-gate error) on macOS.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
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
    }));
    let app = builder
        .plugin(navigation_guard::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AgentBridge::new())
        .manage(GitWatcherState::new())
        .manage(OpenProjectState::new())
        .manage(updater::UpdaterState::default())
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
            browser::commands::browser_annotate,
            browser::commands::browser_capture,
            browser::commands::browser_scroll_to,
            session_status,
            replay_events,
            extension_ui_state,
            open_project,
            take_pending_open_projects,
            start_git_watch,
            stop_git_watch,
            open_url_external,
            list_saved_sessions,
            conversation_tree,
            approval_rules_list,
            approval_rules_grant,
            approval_rules_revoke,
            workspace_status,
            workspace_diff,
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
    if matches!(event, tauri::RunEvent::Exit) {
        kill_child_processes(app);
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

#[cfg(test)]
mod tests {
    use super::StartSessionArgs;

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
            "browserPath": "/opt/chromium/chrome",
        });
        let args: StartSessionArgs = serde_json::from_value(payload).expect("deserialize");
        assert_eq!(args.session_id, "session-1");
        assert_eq!(args.cwd, "/home/dev/project");
        assert_eq!(args.resume, None);
        assert_eq!(args.profile.as_deref(), Some("work"));
        assert_eq!(args.browser_path.as_deref(), Some("/opt/chromium/chrome"));
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
            "browserPath": null,
        });
        assert!(
            serde_json::from_value::<StartSessionArgs>(payload).is_err(),
            "a renamed profile field must be a loud deserialize error, not a silent None"
        );
    }
}
