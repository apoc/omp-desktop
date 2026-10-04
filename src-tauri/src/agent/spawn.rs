use crate::child_path::apply_child_path;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

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
/// launcher-PATH augmentation ([`apply_child_path`]), the
/// profile-env-var strip ([`sanitize_child_env`] — without it an
/// inherited `OMP_PROFILE`/`PI_PROFILE` silently redirects the child to
/// one named profile's tree instead of whatever this call intends), an
/// explicit closed-stdin default, and (Windows) `CREATE_NO_WINDOW` so a
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
/// in turn, by [`check_omp_version`] and `omp_cli::run` — the last is
/// outside this module, which is why `spawn_candidate_output` is `pub`)
/// so none of them can duplicate — or silently drift from — this list.
fn omp_command(name: &str) -> Command {
    let mut cmd = Command::new(name);
    cmd.stdin(Stdio::null());
    apply_child_path(&mut cmd);
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
/// Shared by [`check_omp_version`] and `omp_cli::run` (`omp stats`,
/// `omp config`; outside this module, hence `pub`) — `check_omp_version`
/// and `stats::fetch` used to run their own copy of this exact loop.
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

// ── omp version floor ───────────────────────────────────────────────────────

/// Oldest omp OMP Desktop runs against: the newest release whose RPC
/// commands, events or state fields the app relies on. Raise it in the change
/// that starts using a newer omp feature; nothing else has to follow.
///
/// 18.4.11: the RPC `fork` command (the conversation tree's "Fork after the
/// reply").
const MIN_OMP_VERSION: [u32; 3] = [18, 4, 11];

/// Set once an `omp --version` check passed. Only a pass is remembered: after
/// a refusal the next tab start asks again, so an `omp update` takes effect
/// without restarting the app. A binary replaced by an older one after a pass
/// goes unnoticed until the next launch.
static VERSION_OK: AtomicBool = AtomicBool::new(false);

/// `[major, minor, patch]` from one line of `omp --version` output
/// (`omp/18.5.1`). A leading `v` and a pre-release or build suffix
/// (`18.5.1-dev.3`) are ignored; a line without three numeric components is
/// `None`.
fn parse_version_line(line: &str) -> Option<[u32; 3]> {
    let line = line.trim();
    let version = line.rsplit_once('/').map_or(line, |(_, v)| v);
    let version = version.strip_prefix('v').unwrap_or(version);
    let mut parts = version.splitn(3, '.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let rest = parts.next()?;
    let digits = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    let patch = rest[..digits].parse().ok()?;
    Some([major, minor, patch])
}

fn fmt_version([major, minor, patch]: [u32; 3]) -> String {
    format!("{major}.{minor}.{patch}")
}

/// The spawn-refusal message for `omp --version` output, or `None` when it
/// reports [`MIN_OMP_VERSION`] or newer. The first line that reads as a
/// version decides. Output without one is refused as well, quoting what omp
/// printed: a check that cannot read the version cannot vouch for the RPC
/// surface the app needs. Pure over its input so the decision is testable
/// without depending on the omp on the test machine's PATH.
fn version_refusal(output: &str) -> Option<String> {
    match output.lines().find_map(parse_version_line) {
        Some(found) if found >= MIN_OMP_VERSION => None,
        Some(found) => Some(format!(
            "omp {} is older than OMP Desktop supports ({} or newer). Run `omp update`.",
            fmt_version(found),
            fmt_version(MIN_OMP_VERSION)
        )),
        None => {
            let printed: String = output.trim().chars().take(200).collect();
            Some(format!(
                "could not read the omp version (`omp --version` printed {printed:?}). OMP Desktop needs omp {} or newer.",
                fmt_version(MIN_OMP_VERSION)
            ))
        }
    }
}

/// Refuse to spawn an omp older than [`MIN_OMP_VERSION`]: it would start,
/// and then the RPC commands the frontend sends would fail one by one. Runs
/// `omp --version` through the same candidates and environment as the real
/// spawn. When no candidate can be run at all the check stands aside and the
/// spawn fails with the real reason — a missing omp is a PATH problem, not an
/// upgrade requirement.
fn check_omp_version() -> Result<(), String> {
    if VERSION_OK.load(Ordering::Relaxed) {
        return Ok(());
    }
    let output = match spawn_candidate_output(&["--version"]) {
        Ok(output) => output,
        Err(e) => {
            eprintln!("[omp-desktop] version check skipped: {e}");
            return Ok(());
        }
    };
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    if let Some(refusal) = version_refusal(&text) {
        return Err(refusal);
    }
    VERSION_OK.store(true, Ordering::Relaxed);
    Ok(())
}

/// Build the `--profile=<id>` flag from a resolved profile id, or `None`
/// for the built-in profile — `Some(id)` becomes `--profile=<id>`; a
/// blank id (defence-in-depth: `ProfileStore::resolve` already maps
/// blank/`"default"` to `None`) is treated the same as `None` rather than
/// producing a bare `--profile=`. Shared by [`omp_args`] and the argv
/// builders of `stats::fetch` and `goal_config` (outside this module,
/// hence `pub`) so the flag's spelling and empty-id guard live in exactly
/// one place.
pub fn profile_flag(profile: Option<&str>) -> Option<String> {
    profile
        .filter(|p| !p.is_empty())
        .map(|p| format!("--profile={p}"))
}

/// Build the argv suffix (after the binary name) for spawning omp.
/// Extracted as a pure function so this is unit-testable without
/// spawning a process.
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
/// `--mode rpc-ui` and `--approval-mode=write` are always passed; both
/// predate [`MIN_OMP_VERSION`]. omp's own default approval tier auto-approves
/// exec-tier tools, which a desktop product should never inherit silently.
///
/// `profile` is already resolved (see `profiles::ProfileStore::resolve`)
/// and turned into its flag via [`profile_flag`].
fn omp_args(profile: Option<&str>, resume: Option<&str>, cwd: Option<&str>) -> Vec<String> {
    let mut args = vec!["--mode".to_string(), "rpc-ui".to_string()];
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
    args.push("--approval-mode=write".to_string());
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

/// Spawn omp for a live session in `rpc-ui` mode (see `omp_args`), once
/// [`check_omp_version`] has confirmed the binary meets [`MIN_OMP_VERSION`].
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
    // Refused here rather than left to fail later: an omp too old for the
    // RPC surface the frontend uses would start and then break feature by
    // feature. The message is cached in `last_errors`, where `session_status`
    // and `switchSessionProfile`'s failure note both surface it.
    check_omp_version()?;
    // Resolve once so `current_dir` and `--cwd=` (see `resolve_cwd`) can
    // never disagree or compound a relative value into a nested path.
    let resolved_cwd = cwd.filter(|dir| !dir.is_empty()).map(resolve_cwd);
    let args = omp_args(profile, resume, resolved_cwd.as_deref());
    // On Windows, `Command::new` resolves bare "omp" against PATH and
    // PATHEXT (.exe etc.) via CreateProcess. We try the explicit ".exe"
    // name first because some systems have weird PATHEXT handling, then
    // fall back to bare "omp". We do NOT use `cmd /C` as a fallback —
    // it leaves the omp process orphaned when the parent cmd.exe is
    // killed, since Windows does not propagate process termination to
    // descendants without a Job Object.
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
        fmt_version, omp_args, parse_version_line, resolve_cwd, sanitize_child_env,
        version_refusal, Command, MIN_OMP_VERSION,
    };

    fn version_output(v: [u32; 3]) -> String {
        format!("omp/{}\n", fmt_version(v))
    }

    /// A release just below `v`, so the tests follow `MIN_OMP_VERSION` bumps.
    fn just_below([major, minor, patch]: [u32; 3]) -> [u32; 3] {
        if patch > 0 {
            [major, minor, patch - 1]
        } else if minor > 0 {
            [major, minor - 1, 99]
        } else {
            [major - 1, 99, 99]
        }
    }

    #[test]
    fn parses_omp_version_output() {
        assert_eq!(parse_version_line("omp/18.5.1"), Some([18, 5, 1]));
        assert_eq!(parse_version_line("  omp/18.5.1\r"), Some([18, 5, 1]));
        assert_eq!(parse_version_line("v18.5.1"), Some([18, 5, 1]));
        assert_eq!(parse_version_line("omp/18.5.1-dev.3"), Some([18, 5, 1]));
        assert_eq!(parse_version_line("omp/18.10.0"), Some([18, 10, 0]));
    }

    #[test]
    fn rejects_lines_without_a_full_version() {
        for line in [
            "",
            "omp",
            "omp/18.5",
            "omp/18.x.1",
            "omp/18.5.",
            "error: unknown flag",
        ] {
            assert_eq!(parse_version_line(line), None, "{line:?}");
        }
    }

    #[test]
    fn floor_admits_the_minimum_and_newer() {
        let [major, minor, patch] = MIN_OMP_VERSION;
        // `[major, minor + 1, 0]` has a lower patch than the floor: the
        // comparison must be by release order, not component by component.
        for v in [
            MIN_OMP_VERSION,
            [major, minor, patch + 1],
            [major, minor + 1, 0],
            [major + 1, 0, 0],
        ] {
            assert_eq!(version_refusal(&version_output(v)), None, "{v:?}");
        }
    }

    #[test]
    fn floor_refuses_an_older_omp_naming_both_versions() {
        let older = just_below(MIN_OMP_VERSION);
        let refusal = version_refusal(&version_output(older)).expect("older omp must be refused");
        assert!(refusal.contains(&fmt_version(older)), "{refusal}");
        assert!(refusal.contains(&fmt_version(MIN_OMP_VERSION)), "{refusal}");
    }

    #[test]
    fn floor_refuses_output_without_a_version() {
        assert!(version_refusal("").is_some());
        assert!(version_refusal("error: unknown option '--version'\n").is_some());
    }

    #[test]
    fn floor_reads_the_version_past_leading_noise() {
        // A warning printed ahead of the version line must not turn a
        // supported omp into a refusal.
        let output = format!(
            "warning: config.yml has an unknown key\n{}",
            version_output(MIN_OMP_VERSION)
        );
        assert_eq!(version_refusal(&output), None);
    }

    #[test]
    fn omp_args_without_resume() {
        assert_eq!(
            omp_args(None, None, None),
            vec!["--mode", "rpc-ui", "--approval-mode=write"]
        );
    }

    #[test]
    fn omp_args_with_empty_resume_is_omitted() {
        assert_eq!(
            omp_args(None, Some(""), None),
            vec!["--mode", "rpc-ui", "--approval-mode=write"]
        );
    }

    #[test]
    fn omp_args_with_resume_uses_single_token() {
        // Single `--resume=<value>` token, not two separate argv entries —
        // see `omp_args` doc comment for why this matters.
        assert_eq!(
            omp_args(None, Some("/tmp/sess.jsonl"), None),
            vec![
                "--mode",
                "rpc-ui",
                "--resume=/tmp/sess.jsonl",
                "--approval-mode=write"
            ]
        );
    }

    #[test]
    fn omp_args_with_flag_shaped_resume_stays_single_token() {
        // Even a flag-shaped resume value can't be re-tokenised as a
        // separate argument because it's embedded in one `--resume=` token.
        assert_eq!(
            omp_args(None, Some("--auto-approve"), None),
            vec![
                "--mode",
                "rpc-ui",
                "--resume=--auto-approve",
                "--approval-mode=write"
            ]
        );
    }

    #[test]
    fn omp_args_with_cwd_appends_explicit_flag() {
        assert_eq!(
            omp_args(None, None, Some("/home/dev/project")),
            vec![
                "--mode",
                "rpc-ui",
                "--cwd=/home/dev/project",
                "--approval-mode=write"
            ]
        );
    }

    #[test]
    fn omp_args_with_empty_cwd_is_omitted() {
        assert_eq!(
            omp_args(None, None, Some("")),
            vec!["--mode", "rpc-ui", "--approval-mode=write"]
        );
    }

    #[test]
    fn omp_args_combines_all_flags_in_order() {
        // The full flag sequence - the ordering a future insertion is most
        // likely to disturb.
        assert_eq!(
            omp_args(Some("work"), Some("abc123"), Some("/proj")),
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
            omp_args(Some(""), None, None),
            vec!["--mode", "rpc-ui", "--approval-mode=write"]
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
}
