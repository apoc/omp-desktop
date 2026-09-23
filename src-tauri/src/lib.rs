// Tauri's `#[command]` macro requires arguments by value (owned `String`,
// `State<'_, _>`, `AppHandle`) for deserialization from the frontend
// invoke payload. Suppress the related pedantic lints at module scope so
// command signatures stay idiomatic for the Tauri API.
#![allow(clippy::needless_pass_by_value)]

mod agent;
mod approval;
mod external_open;
mod files;
mod git;
mod git_watcher;
mod json_store;
mod keybindings;
mod navigation_guard;
mod profiles;
mod saved_sessions;
mod stats;
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
}

/// Start an omp process for a new tab session.
#[tauri::command]
fn start_session(
    args: StartSessionArgs,
    bridge: State<'_, AgentBridge>,
    rule_book: State<'_, Arc<RuleBook>>,
    store: State<'_, Arc<profiles::ProfileStore>>,
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
    bridge.start_session(
        args.session_id,
        cwd_opt,
        args.resume.as_deref(),
        profile,
        app,
        Arc::clone(rule_book.inner()),
    )
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
    let Some(id) = store.resolve(Some(&id))?.map(ToString::to_string) else {
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
    // start a whole second app — a second launch session, a second set of
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
        .manage(AgentBridge::new())
        .manage(GitWatcherState::new())
        .manage(OpenProjectState::new())
        .invoke_handler(tauri::generate_handler![
            send_command,
            start_session,
            stop_session,
            session_status,
            replay_events,
            open_project,
            take_pending_open_projects,
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
            usage_stats,
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
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            if let Some(win) = app.get_webview_window("main") {
                win.open_devtools();
            }
            // Falls back to the temp dir if the config dir can't be resolved
            // (e.g. a locked-down test environment) rather than failing
            // startup — approval grants and profiles just won't survive a
            // restart there.
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            // Approval-rule store: project-scoped grants persist under
            // <app_config_dir>/approval-rules/<project-hash>.json.
            app.manage(Arc::new(RuleBook::new(config_dir.join("approval-rules"))));
            // Profile list: <app_config_dir>/profiles.json.
            let store = Arc::new(profiles::ProfileStore::load(
                config_dir.join("profiles.json"),
            ));
            // The user's chosen startup profile. `startup_id` is always a
            // listed id, and `resolve` maps the built-in one to `None` (no
            // `--profile` flag), so a deleted default degrades to omp's own
            // tree instead of failing the launch spawn.
            let startup = store
                .resolve(Some(&store.startup_id()))
                .ok()
                .flatten()
                .map(str::to_owned);
            // Moved, not `Arc::clone`d: `store` is not read after this point,
            // so a second handle would be dropped with the setup closure.
            app.manage(store);
            // Keybinding overlay: <app_config_dir>/keybindings.json.
            app.manage(Arc::new(keybindings::overlay::OverlayStore::new(
                config_dir.join("keybindings.json"),
            )));

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
                // The startup profile chosen in the selector; `None` is the
                // built-in profile (omp's own ~/.omp/agent). Tabs the user
                // opens later inherit the active tab's profile.
                startup.as_deref(),
                // `app.handle()` returns a borrow and `start_session` needs an
                // owned handle; `AppHandle` is not an `Arc`, so `Arc::clone`
                // does not apply here.
                app.handle().clone(),
                Arc::clone(rule_book.inner()),
            );
            if let Err(e) = default_session {
                eprintln!("[omp-desktop] failed to start default session: {e}");
            }

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
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        // macOS' "Open with" for a folder (see `Info.plist`) arrives as a
        // run-loop event, on launch *and* while already running — the one
        // delivery path that is neither argv nor a plugin. `RunEvent::Opened`
        // does not exist on the other targets, hence the discard below.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &event {
            external_open::ingest_urls(app, urls);
        }
        #[cfg(not(target_os = "macos"))]
        {
            _ = (app, event);
        }
    });
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
