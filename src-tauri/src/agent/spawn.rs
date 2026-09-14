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

/// Run `omp --help` and collect stdout+stderr.
///
/// `--help` exits immediately without model initialisation or stdin reads,
/// so there are no pipe-buffering races and no dependency on API keys being
/// present in the environment. Old omp binaries that don't know about a
/// given feature simply won't mention it in their help output.
fn fetch_help_text() -> String {
    for name in CANDIDATES {
        let mut cmd = Command::new(name);
        cmd.arg("--help")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        apply_omp_path(&mut cmd);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let Ok(output) = cmd.output() else { continue };

        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        eprintln!(
            "[omp-desktop] help probe: rpc-ui={} approval-mode={}",
            help_text_supports_rpc_ui(&text),
            help_text_supports_approval_mode(&text)
        );
        return text;
    }
    // omp not found on PATH — spawn_omp will surface the real error.
    eprintln!("[omp-desktop] help probe: omp not found, all feature probes default to unsupported");
    String::new()
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
/// Extracted as a pure function so this is unit-testable without spawning
/// a process.
fn omp_args(
    mode: &str,
    resume: Option<&str>,
    cwd: Option<&str>,
    approval_mode: Option<&str>,
) -> Vec<String> {
    let mut args = vec!["--mode".to_string(), mode.to_string()];
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
    // Resolve once so `current_dir` and `--cwd=` (see `resolve_cwd`) can
    // never disagree or compound a relative value into a nested path.
    let resolved_cwd = cwd.filter(|dir| !dir.is_empty()).map(resolve_cwd);
    let args = omp_args(mode, resume, resolved_cwd.as_deref(), approval_mode);
    let mut last_err = String::from("no candidates tried");
    for name in CANDIDATES {
        let mut cmd = Command::new(name);
        cmd.args(&args);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        apply_omp_path(&mut cmd);
        // Suppress the transient console window that Windows would
        // otherwise attach to a console-subsystem child of a GUI parent.
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
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
    use super::{help_text_supports_rpc_ui, omp_args, resolve_cwd};

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
        assert_eq!(omp_args("rpc", None, None, None), vec!["--mode", "rpc"]);
    }

    #[test]
    fn omp_args_with_empty_resume_is_omitted() {
        assert_eq!(omp_args("rpc", Some(""), None, None), vec!["--mode", "rpc"]);
    }

    #[test]
    fn omp_args_with_resume_uses_single_token() {
        // Single `--resume=<value>` token, not two separate argv entries —
        // see `omp_args` doc comment for why this matters.
        assert_eq!(
            omp_args("rpc-ui", Some("/tmp/sess.jsonl"), None, None),
            vec!["--mode", "rpc-ui", "--resume=/tmp/sess.jsonl"]
        );
    }

    #[test]
    fn omp_args_with_flag_shaped_resume_stays_single_token() {
        // Even a flag-shaped resume value can't be re-tokenised as a
        // separate argument because it's embedded in one `--resume=` token.
        assert_eq!(
            omp_args("rpc", Some("--auto-approve"), None, None),
            vec!["--mode", "rpc", "--resume=--auto-approve"]
        );
    }

    #[test]
    fn omp_args_with_cwd_appends_explicit_flag() {
        assert_eq!(
            omp_args("rpc", None, Some("/home/dev/project"), None),
            vec!["--mode", "rpc", "--cwd=/home/dev/project"]
        );
    }

    #[test]
    fn omp_args_with_empty_cwd_is_omitted() {
        assert_eq!(omp_args("rpc", None, Some(""), None), vec!["--mode", "rpc"]);
    }

    #[test]
    fn omp_args_with_approval_mode_appends_flag() {
        assert_eq!(
            omp_args("rpc", None, None, Some("write")),
            vec!["--mode", "rpc", "--approval-mode=write"]
        );
    }

    #[test]
    fn omp_args_combines_resume_cwd_and_approval_mode_in_order() {
        assert_eq!(
            omp_args("rpc-ui", Some("abc123"), Some("/proj"), Some("write")),
            vec![
                "--mode",
                "rpc-ui",
                "--resume=abc123",
                "--cwd=/proj",
                "--approval-mode=write",
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
}
