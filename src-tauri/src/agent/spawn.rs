use crate::approval_mode::ApprovalMode;
use crate::child_path::{child_path_dirs, locate_program, TrustedProgram};
use std::ffi::{OsStr, OsString};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// Windows: prevent a console window from flashing when we spawn omp.exe
/// (or a widget plugin) from a GUI-subsystem parent. omp speaks JSON-RPC
/// over stdio, so it's almost certainly a console-subsystem binary; without
/// this flag Windows would attach a fresh console (visible flash) on every
/// spawn.
///
/// [`crate::supervisor::ProcessSupervisor::prepare`] sets it for every
/// supervised child.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The omp binary every run uses, and the PATH it runs with.
///
/// Located once per run as an absolute path and spawned by that path, never
/// by a bare name: a session starts in the project folder, and a bare `omp`
/// would be looked up through any empty or relative PATH entry *there*, so
/// a project could ship its own `omp`. The PATH is the same absolute
/// folders the lookup searched ([`child_path_dirs`], i.e. the
/// [`crate::child_path::trusted_child_path`]), and what omp inherits, so a
/// `#!/usr/bin/env` interpreter (an npm-installed omp) isn't resolved inside
/// the project either.
struct Omp {
    binary: PathBuf,
    path: OsString,
}

impl Omp {
    fn locate() -> Result<Self, String> {
        let TrustedProgram { binary, path } = locate_program(&child_path_dirs(), "omp")?;
        Ok(Self { binary, path })
    }

    /// A `Command` for this binary with every cross-cutting concern a run of
    /// omp needs applied uniformly: the trusted PATH, the profile-env-var
    /// strip ([`sanitize_child_env`] — without it an inherited
    /// `OMP_PROFILE`/`PI_PROFILE` silently redirects the child to one named
    /// profile's tree instead of whatever this call intends), an explicit
    /// closed-stdin default, and (Windows) `CREATE_NO_WINDOW` so a
    /// GUI-subsystem parent spawning a console-subsystem binary doesn't
    /// flash a console window.
    ///
    /// The `.stdin(Stdio::null())` default only matters for a
    /// `spawn`-based caller: `spawn_gate::spawn`/`status` default to
    /// *inheriting* the parent's stdin, where a child that tries to read
    /// from it could block — concretely reachable under `tauri dev`, where
    /// the parent's stdin is the terminal. [`omp_output`]'s
    /// `spawn_gate::output` nulls it anyway; [`spawn_omp`] overrides it with
    /// a pipe.
    fn command(&self) -> Command {
        let mut cmd = Command::new(&self.binary);
        cmd.stdin(Stdio::null());
        cmd.env("PATH", &self.path);
        sanitize_child_env(&mut cmd);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }

    /// Run `omp <args>` to completion, returning its captured output
    /// regardless of exit status — each caller decides how to interpret a
    /// non-zero exit.
    fn output<S: AsRef<OsStr>>(&self, args: &[S]) -> Result<std::process::Output, String> {
        crate::spawn_gate::output(self.command().args(args))
            .map_err(|e| format!("failed to run {}: {e}", self.binary.display()))
    }
}

/// Run `omp <args>` to completion (see [`Omp::output`]). Used by
/// `omp_cli::run` (`omp stats`, `omp config`).
pub fn omp_output<S: AsRef<OsStr>>(args: &[S]) -> Result<std::process::Output, String> {
    Omp::locate()?.output(args)
}

/// Construct a native omp command in a selected repository with the trusted
/// binary, PATH and profile environment. The caller supervises its execution.
pub fn omp_command_in<S: AsRef<OsStr>>(cwd: &Path, args: &[S]) -> Result<Command, String> {
    let omp = Omp::locate()?;
    let mut command = omp.command();
    command.current_dir(cwd).args(args);
    // Native worktree operations must use the inspected repository and index,
    // not a Git environment inherited from the shell that launched the app.
    for name in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE",
    ] {
        command.env_remove(name);
    }
    Ok(command)
}

// ── omp version floor ───────────────────────────────────────────────────────

/// First stable release with the draft-only dictation RPC (upstream #17158).
const MIN_OMP_VERSION: [u32; 3] = [18, 13, 2];

/// The binary whose `omp --version` check passed. Only a pass is
/// remembered, and only for that path: after a refusal the next tab start
/// asks again, so an `omp update` takes effect without restarting the app,
/// and a PATH change that finds another omp is checked anew. A binary
/// replaced in place by an older one after a pass goes unnoticed until the
/// next launch.
static VERSION_OK: Mutex<Option<PathBuf>> = Mutex::new(None);

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
            "omp {} is older than OMP Desktop supports ({} or newer). Run `omp update` to upgrade.",
            fmt_version(found),
            fmt_version(MIN_OMP_VERSION)
        )),
        None => {
            let printed: String = output.trim().chars().take(200).collect();
            Some(format!(
                "could not read the omp version (`omp --version` printed {printed:?}). OMP Desktop requires omp version {} or newer; install or update omp and retry.",
                fmt_version(MIN_OMP_VERSION)
            ))
        }
    }
}

/// Refuse to spawn an omp older than [`MIN_OMP_VERSION`]: it would start,
/// and then the RPC commands the frontend sends would fail one by one. Runs
/// `--version` on the very binary the session spawns. When it can't be run
/// at all the check stands aside and the spawn fails with the real reason.
fn check_omp_version(omp: &Omp) -> Result<(), String> {
    if VERSION_OK
        .lock()
        .is_ok_and(|ok| ok.as_deref() == Some(omp.binary.as_path()))
    {
        return Ok(());
    }
    let output = match omp.output(&["--version"]) {
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
    if let Ok(mut ok) = VERSION_OK.lock() {
        *ok = Some(omp.binary.clone()); // the cache owns its copy; `omp` is borrowed
    }
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
/// `--mode rpc-ui` and `--approval-mode=<mode>` are always passed; both
/// predate [`MIN_OMP_VERSION`]. `mode` comes from
/// `approval_mode::ApprovalModeStore::resolve` (`write` unless the user
/// chose otherwise); omp's own default is `yolo`, which a desktop must
/// never inherit silently.
///
/// `profile` is already resolved (see `profiles::ProfileStore::resolve`)
/// and turned into its flag via [`profile_flag`].
///
/// `config` is the per-session settings overlay (the browser panel's `cdpUrl`,
/// see `crate::browser`), passed as one `--config=<path>` token and appended
/// last, after `--approval-mode`.
fn omp_args(
    profile: Option<&str>,
    resume: Option<&str>,
    cwd: Option<&str>,
    mode: ApprovalMode,
    config: Option<&Path>,
) -> Vec<String> {
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
    args.push(mode.flag().to_string());
    if let Some(path) = config {
        args.push(format!("--config={}", path.display()));
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

/// Spawn omp for a live session in `rpc-ui` mode (see `omp_args`), by the
/// absolute path [`Omp::locate`] found and [`check_omp_version`] confirmed
/// meets [`MIN_OMP_VERSION`].
/// If `resume` is specified, `--resume=<path_or_id>` is passed to resume an
/// existing session (a single token, not two separate argv entries — see
/// `omp_args` for why). Returns the child alongside a
/// [`crate::supervisor::ProcessSupervisor`] already attached to it, so the
/// whole process tree (subagents, tool-call children) can be torn down as
/// a unit — plain `Child::kill` only signals the direct `omp` process.
pub(super) fn spawn_omp(
    cwd: Option<&str>,
    resume: Option<&str>,
    profile: Option<&str>,
    mode: ApprovalMode,
    config: Option<&Path>,
    context_epoch: &str,
) -> Result<(Child, crate::supervisor::ProcessSupervisor), String> {
    let omp = Omp::locate()?;
    // Refused here rather than left to fail later: an omp too old for the
    // RPC surface the frontend uses would start and then break feature by
    // feature. The message is cached in `last_errors`, where `session_status`
    // and `switchSessionProfile`'s failure note both surface it.
    check_omp_version(&omp)?;
    // Resolve once so `current_dir` and `--cwd=` (see `resolve_cwd`) can
    // never disagree or compound a relative value into a nested path.
    let resolved_cwd = cwd.filter(|dir| !dir.is_empty()).map(resolve_cwd);
    let args = omp_args(profile, resume, resolved_cwd.as_deref(), mode, config);
    // `Omp::command` defaults stdin to closed; a live RPC session needs it
    // piped. No `cmd /C` wrapper on Windows: killing cmd.exe would orphan
    // omp without a Job Object.
    let mut cmd = omp.command();
    // Load only the embedded observer. Keep the browser-only config last.
    super::context_extension::apply(&mut cmd)?;
    cmd.env("OMP_DESKTOP_CONTEXT_EPOCH", context_epoch);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = resolved_cwd.as_deref() {
        cmd.current_dir(dir);
    }
    // Unix: must run before spawn() (installs the child as its own
    // process-group leader). Windows: only `CREATE_NO_WINDOW` again.
    crate::supervisor::ProcessSupervisor::prepare(&mut cmd);
    let child = crate::spawn_gate::spawn(&mut cmd)
        .map_err(|e| format!("failed to spawn {}: {e}", omp.binary.display()))?;
    let supervisor = crate::supervisor::ProcessSupervisor::attach(&child);
    Ok((child, supervisor))
}

// ── tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::{
        fmt_version, omp_args, parse_version_line, resolve_cwd, sanitize_child_env,
        version_refusal, ApprovalMode, Command, MIN_OMP_VERSION,
    };
    use std::path::Path;

    /// The desktop's default mode; the `omp_args` tests below are about
    /// the other flags.
    const WRITE: ApprovalMode = ApprovalMode::Write;

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
            omp_args(None, None, None, WRITE, None),
            vec!["--mode", "rpc-ui", "--approval-mode=write"]
        );
    }

    #[test]
    fn omp_args_with_empty_resume_is_omitted() {
        assert_eq!(
            omp_args(None, Some(""), None, WRITE, None),
            vec!["--mode", "rpc-ui", "--approval-mode=write"]
        );
    }

    #[test]
    fn omp_args_with_resume_uses_single_token() {
        // Single `--resume=<value>` token, not two separate argv entries —
        // see `omp_args` doc comment for why this matters.
        assert_eq!(
            omp_args(None, Some("/tmp/sess.jsonl"), None, WRITE, None),
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
            omp_args(None, Some("--auto-approve"), None, WRITE, None),
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
            omp_args(None, None, Some("/home/dev/project"), WRITE, None),
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
            omp_args(None, None, Some(""), WRITE, None),
            vec!["--mode", "rpc-ui", "--approval-mode=write"]
        );
    }

    #[test]
    fn omp_args_combines_all_flags_in_order() {
        // The full flag sequence - the ordering a future insertion is most
        // likely to disturb.
        assert_eq!(
            omp_args(Some("work"), Some("abc123"), Some("/proj"), WRITE, None),
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
            omp_args(Some(""), None, None, WRITE, None),
            vec!["--mode", "rpc-ui", "--approval-mode=write"]
        );
    }

    #[test]
    fn omp_args_passes_each_mode_as_one_trailing_flag() {
        for (mode, flag) in [
            (ApprovalMode::AlwaysAsk, "--approval-mode=always-ask"),
            (ApprovalMode::Write, "--approval-mode=write"),
            (ApprovalMode::Yolo, "--approval-mode=yolo"),
        ] {
            assert_eq!(
                omp_args(None, None, Some("/proj"), mode, None),
                vec!["--mode", "rpc-ui", "--cwd=/proj", flag]
            );
        }
    }

    #[test]
    fn omp_args_appends_config_last() {
        assert_eq!(
            omp_args(None, None, None, WRITE, Some(Path::new("/tmp/o.yml"))),
            vec![
                "--mode",
                "rpc-ui",
                "--approval-mode=write",
                "--config=/tmp/o.yml"
            ]
        );
        // Also after every other flag: the position a later insertion would disturb.
        assert_eq!(
            omp_args(
                Some("work"),
                Some("abc"),
                Some("/proj"),
                ApprovalMode::Yolo,
                Some(Path::new("/tmp/o.yml"))
            ),
            vec![
                "--mode",
                "rpc-ui",
                "--profile=work",
                "--resume=abc",
                "--cwd=/proj",
                "--approval-mode=yolo",
                "--config=/tmp/o.yml",
            ]
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
