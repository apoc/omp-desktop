#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::LazyLock;

/// Windows: prevent a console window from flashing when we spawn omp.exe
/// from a GUI-subsystem parent. omp speaks JSON-RPC over stdio, so it's
/// almost certainly a console-subsystem binary; without this flag Windows
/// would attach a fresh console (visible flash) on every spawn.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Candidate binary names tried in order. Explicit `.exe` first on Windows
/// because some systems have unusual PATHEXT handling.
const CANDIDATES: &[&str] = if cfg!(windows) {
    &["omp.exe", "omp"]
} else {
    &["omp"]
};

/// Build a `Command` for candidate binary `name` with every cross-cutting
/// concern any bare invocation of omp needs applied uniformly: the
/// GUI-launcher PATH augmentation ([`apply_omp_path`]), the
/// profile-env-var strip ([`sanitize_child_env`] — without it an
/// inherited `OMP_PROFILE`/`PI_PROFILE` silently redirects the child to
/// one named profile's tree instead of whatever this call intends), an
/// explicit closed-stdin default, and (Windows) [`CREATE_NO_WINDOW`] so a
/// GUI-subsystem parent spawning a console-subsystem binary doesn't flash
/// a console window.
///
/// The `.stdin(Stdio::null())` default only matters for a `.spawn()`-based
/// caller: `Command::spawn()`/`.status()` default to *inheriting* the
/// parent's stdin, where a child that tries to read from it could block —
/// concretely reachable under `tauri dev`, where the parent's stdin is
/// the terminal, though a Finder/launchd/`.desktop`-launched release
/// build's stdin is typically already closed or `/dev/null`.
/// [`spawn_candidate_output`]'s `.output()` call needs no such default —
/// per `Command::output()`'s own documented behavior, it doesn't inherit
/// stdin *by default* (i.e. with no `.stdin()` set at all), closing the
/// stream immediately if the child attempts to read it. Set uniformly
/// here anyway, both because [`spawn_omp`] uses `.spawn()` and overrides
/// it to `Stdio::piped()` for the RPC session's own use (this default
/// just gets replaced, not fought), and so no future `.spawn()`-based
/// caller can forget it.
///
/// Shared by [`spawn_omp`] and [`spawn_candidate_output`] (the latter,
/// in turn, by [`fetch_help_text`] and `stats::fetch` — the last is
/// outside this module, which is why `spawn_candidate_output` is `pub`)
/// so none of them can duplicate — or silently drift from — this list.
fn omp_command(name: &str) -> Command {
    let mut cmd = Command::new(name);
    cmd.stdin(Stdio::null());
    apply_omp_path(&mut cmd);
    sanitize_child_env(&mut cmd);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Run `omp <args>` to completion via the first candidate binary name that
/// can actually be spawned, returning its captured output regardless of
/// exit status — each caller decides how to interpret a non-zero exit;
/// this only decides *which binary* answered. Moves on to the next
/// [`CANDIDATES`] entry only for an error kind that actually means the
/// binary couldn't be launched (`NotFound`, `PermissionDenied`) — not on
/// every error `.output()` can return: its own docs also report a
/// post-spawn pipe-read or `wait()` failure the same way, and retrying
/// *that* against the next candidate name would re-run a binary that did
/// already execute (on Windows, re-syncing `omp stats`' warehouse a
/// second time). A found binary's non-zero *exit status* is a separate,
/// successful `Ok(Output)` from `.output()`'s own perspective and is
/// always returned as-is, never retried.
///
/// Shared by [`fetch_help_text`] and `stats::fetch` (the latter outside
/// this module, hence `pub`) — both used to run their own copy of this
/// exact loop.
pub fn spawn_candidate_output<S: AsRef<std::ffi::OsStr>>(
    args: &[S],
) -> Result<std::process::Output, String> {
    let mut last_err = None;
    for name in CANDIDATES {
        let mut cmd = omp_command(name);
        cmd.args(args);
        match cmd.output() {
            Ok(output) => return Ok(output),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
                ) =>
            {
                last_err = Some(format!("failed to run {name}: {e}"));
            }
            Err(e) => return Err(format!("failed to run {name}: {e}")),
        }
    }
    Err(last_err.unwrap_or_else(|| "no omp candidates configured".to_string()))
}

// ── PATH resolution ────────────────────────────────────────────────────────

/// Directories where `omp` is commonly installed but which GUI launchers
/// (Finder, Dock, `.desktop` files) omit from the minimal PATH they hand a
/// bundled app. A Finder-launched `.app` gets only `/usr/bin:/bin:/usr/sbin:/sbin`,
/// whereas `tauri dev` inherits the terminal's full PATH — which is why omp
/// resolves in dev but not in a shipped bundle. Appended (not prepended) so a
/// user's own PATH entry still wins when present.
#[cfg(not(windows))]
const EXTRA_PATH_DIRS: &[&str] = &[
    "/opt/homebrew/bin", // Apple-silicon Homebrew
    "/opt/homebrew/sbin",
    "/usr/local/bin", // Intel Homebrew / manual installs
    "/usr/local/sbin",
];

/// Build a PATH that augments `current` with the common install dirs so a
/// GUI-launched bundle can still find omp. Entries are de-duplicated with
/// order preserved; inherited entries come first. Pure over its inputs so it
/// can be unit-tested without touching the process environment.
#[cfg(not(windows))]
fn augmented_path(current: Option<&str>, home: Option<&str>) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut add = |dir: &str| {
        if !dir.is_empty() && !out.iter().any(|e| e == dir) {
            out.push(dir.to_string());
        }
    };
    if let Some(cur) = current {
        for dir in cur.split(':') {
            add(dir);
        }
    }
    for dir in EXTRA_PATH_DIRS {
        add(dir);
    }
    if let Some(h) = home.filter(|h| !h.is_empty()) {
        add(&format!("{h}/.local/bin"));
        add(&format!("{h}/.cargo/bin"));
    }
    out.join(":")
}

/// Override the child command's PATH so bare-name omp resolution succeeds even
/// when the parent process was handed a stripped-down GUI PATH. On Unix,
/// `Command` searches the PATH configured on the command itself, so this makes
/// the extra dirs effective for program lookup. No-op on Windows, where the
/// GUI-PATH problem does not apply the same way and omp resolution is unchanged.
#[cfg(not(windows))]
fn apply_omp_path(cmd: &mut Command) {
    let current = std::env::var("PATH").ok();
    let home = std::env::var("HOME").ok();
    cmd.env("PATH", augmented_path(current.as_deref(), home.as_deref()));
}

#[cfg(windows)]
fn apply_omp_path(_cmd: &mut Command) {}

// ── omp --help probe ────────────────────────────────────────────────────────

/// `omp --help` output, fetched once per process lifetime and shared by
/// every predicate probe below — old omp binaries missing a feature simply
/// won't mention it, so each predicate is just a substring check.
static HELP_TEXT: LazyLock<String> = LazyLock::new(fetch_help_text);
static RPC_UI_SUPPORTED: LazyLock<bool> = LazyLock::new(|| help_text_supports_rpc_ui(&HELP_TEXT));
static APPROVAL_MODE_SUPPORTED: LazyLock<bool> =
    LazyLock::new(|| help_text_supports_approval_mode(&HELP_TEXT));
static PROFILE_SUPPORTED: LazyLock<bool> = LazyLock::new(|| help_text_supports_profile(&HELP_TEXT));

/// Return the RPC mode string to use when spawning omp: `rpc-ui` when the
/// installed binary advertises it, `rpc` otherwise.
pub(super) fn rpc_mode() -> &'static str {
    if *RPC_UI_SUPPORTED {
        "rpc-ui"
    } else {
        "rpc"
    }
}

/// `true` when the installed omp binary's `--help` advertises
/// `--approval-mode`. Gates whether `spawn_omp` passes `--approval-mode=write`
/// — an old binary without the flag would otherwise fail to start.
pub(super) fn approval_mode_supported() -> bool {
    *APPROVAL_MODE_SUPPORTED
}

/// Return true if the given help text advertises `rpc-ui` mode support.
/// Extracted as a pure function so it can be unit-tested without spawning omp.
fn help_text_supports_rpc_ui(text: &str) -> bool {
    text.contains("rpc-ui")
}

/// Return true if the given help text advertises the `--approval-mode` flag.
/// Extracted as a pure function so it can be unit-tested without spawning omp.
fn help_text_supports_approval_mode(text: &str) -> bool {
    text.contains("--approval-mode")
}

/// Return true if the given help text advertises the `--profile` flag.
/// Matches on a flag-name boundary: `--profile` immediately followed by
/// anything other than an ASCII alphanumeric or `-` character (`=`, a
/// space, a tab, `<`, a newline, or end-of-string all count), rather than
/// three enumerated literal suffixes (`--profile=`, `--profile `,
/// `--profile<`). The enumerated form has a false-negative hole a boundary
/// match closes: a help layout that separates the flag from its
/// placeholder with a tab, or puts the flag alone at end-of-line (clap's
/// next-line-help style), matches none of the three literals.
///
/// A false negative is the expensive failure here, not the false positive
/// the enumerated form was guarding against: it drives `PROFILE_SUPPORTED`
/// false and [`profile_refusal`] hard-refuses every named-profile tab on
/// an omp build that supports profiles perfectly — total feature outage
/// with no user workaround, since `HELP_TEXT` is a process-lifetime
/// `LazyLock` computed once. A false positive is comparatively cheap: omp
/// itself rejects the unrecognised argv, the same blank-tab outcome the
/// refusal exists to improve on, not silent data misplacement. The
/// boundary check still rejects `--profiler=` and `--profile-dir` (`r`/`-`
/// immediately follow `--profile`); `--no-profile` never contains the
/// literal `--profile` substring in the first place. Extracted as a pure
/// function so it can be unit-tested without spawning omp.
fn help_text_supports_profile(text: &str) -> bool {
    text.match_indices("--profile").any(|(i, m)| {
        !matches!(
            text[i + m.len()..].chars().next(),
            Some(c) if c.is_ascii_alphanumeric() || c == '-'
        )
    })
}

/// The spawn-refusal message for an omp build that cannot honour
/// `--profile`, or `None` when the spawn may proceed. Pure over its
/// inputs so the three-way decision — no profile requested / probe never
/// ran / genuinely old omp — is testable without depending on the
/// process-global `HELP_TEXT`/`PROFILE_SUPPORTED` `LazyLock`s, whose
/// values are whatever `omp` happens to be on the test machine's PATH.
/// See the call site in [`spawn_omp`] for the full rationale (why the
/// flag is never silently dropped, and why an empty probe must not
/// refuse).
fn profile_refusal(profile: Option<&str>, help_text: &str, supported: bool) -> Option<String> {
    (profile.is_some_and(|p| !p.is_empty()) && !help_text.is_empty() && !supported).then(|| {
        "this omp build does not support --profile; profiles require a newer omp".to_string()
    })
}

/// Run `omp --help` and collect stdout+stderr.
///
/// `--help` exits immediately without model initialisation or stdin reads,
/// so there are no pipe-buffering races and no dependency on API keys being
/// present in the environment. Old omp binaries that don't know about a
/// given feature simply won't mention it in their help output.
fn fetch_help_text() -> String {
    // The probe must see the same environment the real spawn does. An
    // inherited `OMP_PROFILE` or `PI_PROFILE` that omp rejects (its ids
    // are lowercase, so a plain `export OMP_PROFILE=Work` qualifies)
    // makes `--help` print only a validation error - flipping *every*
    // feature probe false and, with the refusal below, breaking
    // named-profile tabs that would in fact have spawned fine, since
    // `spawn_omp` strips both aliases (see `sanitize_child_env`, applied
    // by `omp_command`/`spawn_candidate_output` along with everything
    // else this needs).
    let Ok(output) = spawn_candidate_output(&["--help"]) else {
        // omp not found on PATH — spawn_omp will surface the real error.
        eprintln!(
            "[omp-desktop] help probe: omp not found, all feature probes default to unsupported"
        );
        return String::new();
    };

    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    eprintln!(
        "[omp-desktop] help probe: rpc-ui={} approval-mode={} profile={}",
        help_text_supports_rpc_ui(&text),
        help_text_supports_approval_mode(&text),
        help_text_supports_profile(&text)
    );
    text
}

/// Build the argv suffix (after the binary name) for spawning omp.
///
/// `--resume` is passed as a single `--resume=<value>` token rather than
/// two separate argv entries (`--resume`, `<value>`). omp's `--resume`
/// flag takes an *optional* value (bare `--resume` opens a picker), so a
/// flag-shaped value passed as a second token (e.g. `--auto-approve`) is
/// re-tokenised by omp's own argument parser as an unrelated flag instead
/// of the resume target. The single-token form can never be re-split.
///
/// `cwd` is passed explicitly as `--cwd=<value>` *in addition to* the
/// child process's OS-level working directory (set separately via
/// `Command::current_dir` in `spawn_omp`) — both consumers are always
/// given the *same already-resolved absolute path* (see `resolve_cwd`),
/// never a raw relative one, so the two applications can never compound
/// into a nonexistent nested directory. deliberately
/// NOT doing the equivalent for `--session-dir`: omp already resolves its
/// session storage location from `PI_CODING_AGENT_DIR`
/// (`saved_sessions::sessions_root_dir` reads the same variable to locate
/// the history panel's source of truth) — hardcoding `--session-dir` here
/// would be a second, divergent way to say the same thing and risks
/// silently pointing session storage somewhere the read side doesn't
/// expect.
///
/// `approval_mode` is passed as `--approval-mode=<value>` when the
/// installed omp binary supports the flag (see `approval_mode_supported`);
/// omp's own default approval tier auto-approves exec-tier tools, which a
/// desktop product should never inherit silently.
///
/// `profile` is already resolved (see `profiles::ProfileStore::resolve`)
/// and turned into its flag via [`profile_flag`].
///
/// Unlike `approval_mode`, `--profile` is *not* gated on the help probe, and
/// deliberately so: the probe exists to keep an older omp startable when the
/// desktop merely prefers a flag, whereas here the flag is the entire point.
/// Dropping it on an omp too old to know `--profile` would silently run the
/// tab against the shared `~/.omp/agent` tree - writing a named profile's
/// conversation into the default profile's history - which is strictly worse
/// than the tab failing loudly.
///
/// Build the `--profile=<id>` flag from a resolved profile id, or `None`
/// for the built-in profile — `Some(id)` becomes `--profile=<id>`; a
/// blank id (defence-in-depth: `ProfileStore::resolve` already maps
/// blank/`"default"` to `None`) is treated the same as `None` rather than
/// producing a bare `--profile=`. Shared by [`omp_args`] and
/// `stats::fetch`'s own argv builder (the latter outside this module,
/// hence `pub`) so the flag's spelling and empty-id guard live in
/// exactly one place.
pub fn profile_flag(profile: Option<&str>) -> Option<String> {
    profile
        .filter(|p| !p.is_empty())
        .map(|p| format!("--profile={p}"))
}

/// Extracted as a pure function so this is unit-testable without spawning
/// a process.
fn omp_args(
    mode: &str,
    profile: Option<&str>,
    resume: Option<&str>,
    cwd: Option<&str>,
    approval_mode: Option<&str>,
) -> Vec<String> {
    let mut args = vec!["--mode".to_string(), mode.to_string()];
    if let Some(flag) = profile_flag(profile) {
        args.push(flag);
    }
    if let Some(r) = resume {
        if !r.is_empty() {
            args.push(format!("--resume={r}"));
        }
    }
    if let Some(c) = cwd {
        if !c.is_empty() {
            args.push(format!("--cwd={c}"));
        }
    }
    if let Some(a) = approval_mode {
        if !a.is_empty() {
            args.push(format!("--approval-mode={a}"));
        }
    }
    args
}

// ── session spawn ─────────────────────────────────────────────────────────────

/// Resolve `dir` to an absolute path so it can be handed to *both*
/// `Command::current_dir` and `--cwd=` without the two applying it
/// twice. `current_dir` runs an OS-level chdir before the child even
/// starts; omp then interprets `--cwd=<value>` relative to whatever
/// directory it actually finds itself launched in. If `dir` is
/// relative, that means the OS chdir consumes it once and omp's own
/// `--cwd` handling consumes it a second time against the
/// already-changed directory, producing a nonexistent nested path (e.g.
/// `proj` becomes `proj/proj`). Resolving it once up front makes both
/// consumers agree on the same absolute target regardless of whether
/// the caller passed a relative or absolute `dir`. Falls back to the
/// raw string if resolution fails, so a spawn attempt is never turned
/// into a hard failure by this step alone.
fn resolve_cwd(dir: &str) -> String {
    std::path::absolute(dir)
        .ok()
        .and_then(|p| p.into_os_string().into_string().ok())
        .unwrap_or_else(|| dir.to_string())
}

/// Strip omp env vars that would override this spawn's explicit argv.
///
/// omp resolves an env-supplied profile through two variables, in this
/// precedence order: `resolveProfileEnv(OMP_PROFILE, PI_PROFILE)` uses
/// `OMP_PROFILE` whenever it's set (even to an invalid value) and falls
/// back to `PI_PROFILE` — a legacy compatibility alias — only when
/// `OMP_PROFILE` is entirely unset. `omp --help` documents `OMP_PROFILE`
/// as an alias for `--profile`; `PI_PROFILE` is undocumented there but
/// just as capable of overriding this spawn's chosen profile, so both
/// must be removed. Stripping only `OMP_PROFILE` would actively unmask
/// an inherited `PI_PROFILE` that was previously shadowed by it — a user
/// with both exported would get a *different* (and wrong) profile after
/// sanitisation than before it.
///
/// Inheriting either would silently override the desktop's per-tab
/// choice: a built-in-profile tab spawns with no flag, so with
/// `OMP_PROFILE=work` (or `PI_PROFILE=work`) exported the child would
/// write into `~/.omp/profiles/work/agent` while `sessions_root_dir(app,
/// None)` reads `~/.omp/agent/sessions` - history and resume would point
/// at a tree the child never touches. argv is the single source of
/// truth, so both aliases are always removed.
///
/// `PI_CODING_AGENT_DIR` is deliberately *not* removed: omp honours it
/// only for the built-in profile, and `saved_sessions::sessions_root_for`
/// mirrors that same precedence, so the two agree. `PI_CONFIG_DIR` and
/// `PI_CODING_AGENT_SESSION_DIR` also relocate the child's data root, but
/// stripping them here would be wrong — they're pre-existing read-side
/// mismatches owned by `saved_sessions::mod` (and, for the bootstrap
/// seed path, `profiles.rs`), not this sanitiser's job.
fn sanitize_child_env(cmd: &mut Command) {
    cmd.env_remove("OMP_PROFILE");
    cmd.env_remove("PI_PROFILE");
}

/// Spawn omp for a live session using the best available RPC mode.
/// If `resume` is specified, `--resume=<path_or_id>` is passed to resume an
/// existing session (a single token, not two separate argv entries — see
/// `omp_args` for why). Returns the child alongside a
/// [`super::supervisor::ProcessSupervisor`] already attached to it, so the
/// whole process tree (subagents, tool-call children) can be torn down as
/// a unit — plain `Child::kill` only signals the direct `omp` process.
pub(super) fn spawn_omp(
    cwd: Option<&str>,
    resume: Option<&str>,
    profile: Option<&str>,
) -> Result<(Child, super::supervisor::ProcessSupervisor), String> {
    // On Windows, `Command::new` resolves bare "omp" against PATH and
    // PATHEXT (.exe etc.) via CreateProcess. We try the explicit ".exe"
    // name first because some systems have weird PATHEXT handling, then
    // fall back to bare "omp". We do NOT use `cmd /C` as a fallback —
    // it leaves the omp process orphaned when the parent cmd.exe is
    // killed, since Windows does not propagate process termination to
    // descendants without a Job Object.
    let mode = rpc_mode();
    let approval_mode = approval_mode_supported().then_some("write");
    // `--profile` is never *dropped* when unsupported (that would write a
    // named profile's conversation into the shared `~/.omp/agent` tree), but
    // failing at spawn is not enough on its own: an old omp exits before
    // writing a stdout line, so `reader.rs` takes the EOF path and emits
    // `agent://exit/{id}` with an empty payload - which the event contract
    // defines as a *clean* exit, leaving the tab idle and blank with the real
    // reason only on stderr. Refusing here instead caches the message in
    // `last_errors`, where `session_status` and `switchSessionProfile`'s
    // failure note both surface it.
    //
    // Gated on a non-empty probe so "probe never ran" stays distinguishable
    // from "omp is too old": `fetch_help_text` returns `""` when no candidate
    // binary could be executed at all, and `HELP_TEXT` is a process-lifetime
    // `LazyLock`, so without this a missing omp would misreport a PATH problem
    // as an upgrade requirement - and one transient fork failure at launch
    // would brick every named profile for the whole run. Any omp that exists
    // prints help, so a genuinely old binary still hits the refusal.
    if let Some(e) = profile_refusal(profile, &HELP_TEXT, *PROFILE_SUPPORTED) {
        return Err(e);
    }
    // Resolve once so `current_dir` and `--cwd=` (see `resolve_cwd`) can
    // never disagree or compound a relative value into a nested path.
    let resolved_cwd = cwd.filter(|dir| !dir.is_empty()).map(resolve_cwd);
    let args = omp_args(
        mode,
        profile,
        resume,
        resolved_cwd.as_deref(),
        approval_mode,
    );
    let mut last_err = String::from("no candidates tried");
    for name in CANDIDATES {
        // `omp_command` defaults stdin to closed (right for a one-shot
        // probe/report); a live RPC session needs a piped stdin instead,
        // so this overrides it — `Command::stdin` just replaces the prior
        // setting, it does not require `omp_command` to leave it unset.
        let mut cmd = omp_command(name);
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(dir) = resolved_cwd.as_deref() {
            cmd.current_dir(dir);
        }
        // Unix: must run before spawn() (installs the child as its own
        // process-group leader). No-op on Windows.
        super::supervisor::ProcessSupervisor::prepare(&mut cmd);
        match cmd.spawn() {
            Ok(child) => {
                let supervisor = super::supervisor::ProcessSupervisor::attach(&child);
                return Ok((child, supervisor));
            }
            Err(e) => {
                let msg = format!("{name}: {e}");
                eprintln!("[omp-desktop] spawn attempt failed: {msg}");
                last_err = msg;
            }
        }
    }
    Err(format!(
        "failed to spawn omp ({last_err}). Make sure omp is installed and on PATH."
    ))
}

// ── tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::{
        help_text_supports_profile, help_text_supports_rpc_ui, omp_args, profile_refusal,
        resolve_cwd, sanitize_child_env, Command,
    };

    #[test]
    fn detects_rpc_ui_in_mode_line() {
        let help = "  --mode=<value>   Output mode: text (default), json, rpc, or rpc-ui";
        assert!(help_text_supports_rpc_ui(help));
    }

    #[test]
    fn detects_rpc_ui_in_options_list() {
        let help = r#"options: ["text", "json", "rpc", "acp", "rpc-ui"]"#;
        assert!(help_text_supports_rpc_ui(help));
    }

    #[test]
    fn rejects_old_help_without_rpc_ui() {
        let help = "  --mode=<value>   Output mode: text (default), json, or rpc";
        assert!(!help_text_supports_rpc_ui(help));
    }

    #[test]
    fn rejects_empty_string() {
        assert!(!help_text_supports_rpc_ui(""));
    }

    #[test]
    fn rejects_partial_match_rpc() {
        // "rpc" alone must not satisfy the check
        assert!(!help_text_supports_rpc_ui("--mode rpc"));
    }

    #[test]
    fn accepts_rpc_ui_anywhere_in_text() {
        // Position in the string should not matter
        assert!(help_text_supports_rpc_ui("rpc-ui mode enables ask tool"));
        assert!(help_text_supports_rpc_ui(
            "supported modes: rpc-ui, rpc, text"
        ));
    }

    #[cfg(not(windows))]
    #[test]
    fn augmented_path_appends_homebrew_when_missing() {
        // The Finder/Dock minimal PATH lacks Homebrew — the reported bug.
        let out = super::augmented_path(Some("/usr/bin:/bin:/usr/sbin:/sbin"), None);
        let dirs: Vec<&str> = out.split(':').collect();
        assert!(
            dirs.contains(&"/usr/bin"),
            "inherited entries preserved: {out}"
        );
        assert!(
            dirs.contains(&"/opt/homebrew/bin"),
            "homebrew appended: {out}"
        );
        // Inherited entries must come before the appended ones.
        assert!(
            dirs.iter().position(|d| *d == "/usr/bin")
                < dirs.iter().position(|d| *d == "/opt/homebrew/bin"),
            "inherited PATH must precede extra dirs: {out}"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn augmented_path_dedupes_existing_extra_dir() {
        // A user who already has /opt/homebrew/bin must not get it twice.
        let out = super::augmented_path(Some("/opt/homebrew/bin:/usr/bin"), None);
        let count = out.split(':').filter(|d| *d == "/opt/homebrew/bin").count();
        assert_eq!(count, 1, "no duplicate homebrew entry: {out}");
    }

    #[cfg(not(windows))]
    #[test]
    fn augmented_path_includes_home_relative_dirs() {
        let out = super::augmented_path(Some("/usr/bin"), Some("/home/dev"));
        let dirs: Vec<&str> = out.split(':').collect();
        assert!(dirs.contains(&"/home/dev/.local/bin"), "{out}");
        assert!(dirs.contains(&"/home/dev/.cargo/bin"), "{out}");
    }

    #[cfg(not(windows))]
    #[test]
    fn augmented_path_handles_absent_inherited_path() {
        // No PATH in the environment at all — still yields the extra dirs.
        let out = super::augmented_path(None, None);
        assert!(out.split(':').any(|d| d == "/opt/homebrew/bin"), "{out}");
        assert!(out.contains('/'), "{out}");
    }

    #[test]
    fn omp_args_without_resume() {
        assert_eq!(
            omp_args("rpc", None, None, None, None),
            vec!["--mode", "rpc"]
        );
    }

    #[test]
    fn omp_args_with_empty_resume_is_omitted() {
        assert_eq!(
            omp_args("rpc", None, Some(""), None, None),
            vec!["--mode", "rpc"]
        );
    }

    #[test]
    fn omp_args_with_resume_uses_single_token() {
        // Single `--resume=<value>` token, not two separate argv entries —
        // see `omp_args` doc comment for why this matters.
        assert_eq!(
            omp_args("rpc-ui", None, Some("/tmp/sess.jsonl"), None, None),
            vec!["--mode", "rpc-ui", "--resume=/tmp/sess.jsonl"]
        );
    }

    #[test]
    fn omp_args_with_flag_shaped_resume_stays_single_token() {
        // Even a flag-shaped resume value can't be re-tokenised as a
        // separate argument because it's embedded in one `--resume=` token.
        assert_eq!(
            omp_args("rpc", None, Some("--auto-approve"), None, None),
            vec!["--mode", "rpc", "--resume=--auto-approve"]
        );
    }

    #[test]
    fn omp_args_with_cwd_appends_explicit_flag() {
        assert_eq!(
            omp_args("rpc", None, None, Some("/home/dev/project"), None),
            vec!["--mode", "rpc", "--cwd=/home/dev/project"]
        );
    }

    #[test]
    fn omp_args_with_empty_cwd_is_omitted() {
        assert_eq!(
            omp_args("rpc", None, None, Some(""), None),
            vec!["--mode", "rpc"]
        );
    }

    #[test]
    fn omp_args_with_approval_mode_appends_flag() {
        assert_eq!(
            omp_args("rpc", None, None, None, Some("write")),
            vec!["--mode", "rpc", "--approval-mode=write"]
        );
    }

    #[test]
    fn omp_args_combines_all_flags_in_order() {
        // The full four-flag sequence - the ordering a future insertion is
        // most likely to disturb.
        assert_eq!(
            omp_args(
                "rpc-ui",
                Some("work"),
                Some("abc123"),
                Some("/proj"),
                Some("write")
            ),
            vec![
                "--mode",
                "rpc-ui",
                "--profile=work",
                "--resume=abc123",
                "--cwd=/proj",
                "--approval-mode=write",
            ]
        );
    }

    #[test]
    fn omp_args_skips_an_empty_profile() {
        // `ProfileStore::resolve` maps blank/"default" to `None`, so this is
        // defence-in-depth: a bare `--profile=` would send omp to
        // `~/.omp/profiles//agent` or make it error out.
        assert_eq!(
            omp_args("rpc", Some(""), None, None, None),
            vec!["--mode", "rpc"]
        );
    }

    #[test]
    fn resolve_cwd_leaves_absolute_path_unchanged() {
        let abs = if cfg!(windows) {
            r"C:\tmp\project"
        } else {
            "/tmp/project"
        };
        assert_eq!(resolve_cwd(abs), abs);
    }

    #[test]
    fn resolve_cwd_resolves_relative_path_against_current_dir() {
        let base = std::env::current_dir().expect("current dir");
        let resolved = resolve_cwd("some-relative-project");
        assert_eq!(
            std::path::Path::new(&resolved),
            base.join("some-relative-project")
        );
    }

    /// Regression test for the double-application bug: `spawn_omp` used to
    /// hand the *raw* (possibly relative) `cwd` to both `Command::current_dir`
    /// (an OS-level chdir applied before the child starts) and `--cwd=`
    /// (interpreted by omp relative to whatever directory it's actually
    /// launched in). For a relative value that applies it twice, nesting
    /// `proj` into `proj/proj`. `resolve_cwd` must absolutise the value once
    /// so both consumers agree on the same path and a second application is
    /// a no-op (`Path::join` with an absolute argument replaces the base
    /// entirely, it never nests).
    #[test]
    fn resolved_cwd_is_idempotent_under_double_application() {
        let base = std::env::current_dir().expect("current dir");
        let dir = "child-project";

        // Sanity check on the bug itself: applying the raw relative value
        // twice (once as an OS chdir, once as omp's own relative --cwd)
        // nests it one level deeper than intended.
        let buggy_double_apply = base.join(dir).join(dir);
        assert_eq!(buggy_double_apply, base.join(dir).join(dir));
        assert_ne!(buggy_double_apply, base.join(dir));

        // The fix: resolve once, and the same absolute value survives a
        // second application unchanged.
        let resolved = resolve_cwd(dir);
        let resolved_path = std::path::Path::new(&resolved);
        assert_eq!(resolved_path, base.join(dir));
        assert_eq!(
            resolved_path.join(&resolved),
            resolved_path,
            "an already-absolute cwd must be idempotent under a second application"
        );
    }

    #[test]
    fn sanitize_child_env_removes_both_profile_env_aliases() {
        let mut cmd = Command::new("omp");
        cmd.env("OMP_PROFILE", "work");
        cmd.env("PI_PROFILE", "legacy");
        sanitize_child_env(&mut cmd);
        // `get_envs` yields `(key, None)` for a removal, which is what makes
        // the child fall back to argv instead of an inherited alias. Both
        // vars must go: omp's own resolveProfileEnv falls back to
        // PI_PROFILE whenever OMP_PROFILE is unset, so clearing only the
        // first would unmask the second instead of neutralising it.
        for key in ["OMP_PROFILE", "PI_PROFILE"] {
            let removed = cmd
                .get_envs()
                .any(|(k, v)| k == std::ffi::OsStr::new(key) && v.is_none());
            assert!(removed, "{key} must be removed from the child env");
        }
    }

    #[test]
    fn sanitize_child_env_keeps_pi_coding_agent_dir() {
        let mut cmd = Command::new("omp");
        sanitize_child_env(&mut cmd);
        // omp honours it only for the built-in profile, and
        // `saved_sessions::sessions_root_for` mirrors that precedence - so
        // unlike OMP_PROFILE the two sides already agree.
        let cleared = cmd
            .get_envs()
            .any(|(k, _)| k == std::ffi::OsStr::new("PI_CODING_AGENT_DIR"));
        assert!(!cleared, "PI_CODING_AGENT_DIR must be left inherited");
    }

    #[test]
    fn detects_profile_flag_in_help_text() {
        assert!(help_text_supports_profile(
            "  --profile=<value>  Named profile for isolated agent state"
        ));
        assert!(!help_text_supports_profile("  --resume=<value>  Resume"));
        assert!(!help_text_supports_profile(""));
    }

    #[test]
    fn rejects_profiler_flag_as_a_false_positive() {
        // `--profiler` is a prefix-superstring of `--profile`; a bare
        // `contains("--profile")` would wrongly treat this as support.
        assert!(!help_text_supports_profile(
            "  --profiler=<value>  Enable performance profiling"
        ));
    }

    #[test]
    fn rejects_no_profile_flag_as_a_false_positive() {
        assert!(!help_text_supports_profile(
            "  --no-profile  Disable profile loading"
        ));
    }

    #[test]
    fn rejects_profile_dir_flag_as_a_false_positive() {
        assert!(!help_text_supports_profile(
            "  --profile-dir=<value>  Override the profile storage directory"
        ));
    }

    #[test]
    fn detects_profile_flag_at_a_layout_boundary() {
        // clap-style help sometimes separates the flag from its
        // description with a tab rather than `=`/a space, or (next-line
        // help style) puts the flag alone on its own line before a
        // trailing newline — none of the old three enumerated literal
        // suffixes matched either layout.
        assert!(help_text_supports_profile("  --profile\tNamed profile"));
        assert!(help_text_supports_profile(
            "  --profile\n      Named profile for isolated agent state"
        ));
    }

    #[test]
    fn detects_profile_flag_at_true_end_of_string() {
        assert!(help_text_supports_profile("  --profile"));
    }

    #[test]
    fn profile_refusal_allows_spawn_without_a_requested_profile() {
        // No `--profile` requested (built-in profile) must never refuse,
        // even against help text from an omp that predates the flag.
        assert_eq!(
            profile_refusal(None, "  --resume=<value>  Resume a session", false),
            None
        );
    }

    #[test]
    fn profile_refusal_allows_spawn_when_the_probe_never_ran() {
        // Empty help text means `fetch_help_text` couldn't execute any
        // candidate binary at all (e.g. a transient PATH/fork failure),
        // not that the installed omp is too old to know `--profile`.
        assert_eq!(profile_refusal(Some("work"), "", false), None);
    }

    #[test]
    fn profile_refusal_blocks_spawn_on_a_genuinely_old_omp() {
        let help = "  --resume=<value>  Resume a previous session";
        assert_eq!(
            profile_refusal(Some("work"), help, false),
            Some(
                "this omp build does not support --profile; profiles require a newer omp"
                    .to_string()
            )
        );
    }

    #[test]
    fn profile_refusal_allows_spawn_when_help_advertises_the_flag() {
        let help = "  --profile=<value>  Named profile for isolated agent state";
        assert_eq!(profile_refusal(Some("work"), help, true), None);
    }

    #[test]
    fn profile_refusal_allows_spawn_for_an_empty_profile_id() {
        // `omp_args` already treats `Some("")` as "no flag" (defence-in-
        // depth for a value `ProfileStore::resolve` should never produce)
        // — `profile_refusal` must agree, not block a spawn that will emit
        // no `--profile` argv at all.
        let help = "  --resume=<value>  Resume a previous session";
        assert_eq!(profile_refusal(Some(""), help, false), None);
    }
}
