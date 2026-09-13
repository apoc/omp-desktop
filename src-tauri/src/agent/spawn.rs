#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;

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

// ── rpc-ui probe ─────────────────────────────────────────────────────────────

/// Probe result cache — evaluated once per process lifetime.
static RPC_UI_SUPPORTED: OnceLock<bool> = OnceLock::new();

/// Return the RPC mode string to use when spawning omp.
/// Calls `omp --help` on first use and checks whether `rpc-ui` appears in the
/// output. Result is cached in a `OnceLock` for the process lifetime.
pub(super) fn rpc_mode() -> &'static str {
    if *RPC_UI_SUPPORTED.get_or_init(probe_rpc_ui) {
        "rpc-ui"
    } else {
        "rpc"
    }
}

/// Return true if the given help text advertises `rpc-ui` mode support.
/// Extracted as a pure function so it can be unit-tested without spawning omp.
fn help_text_supports_rpc_ui(text: &str) -> bool {
    text.contains("rpc-ui")
}

/// Run `omp --help`, collect stdout+stderr, and check for `rpc-ui`.
///
/// `--help` exits immediately without model initialisation or stdin reads,
/// so there are no pipe-buffering races and no dependency on API keys being
/// present in the environment. Old omp binaries that don't know about
/// `rpc-ui` simply won't mention it in their help output.
fn probe_rpc_ui() -> bool {
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
        let supported = help_text_supports_rpc_ui(&text);
        eprintln!("[omp-desktop] rpc-ui probe: supported={supported}");
        return supported;
    }
    // omp not found on PATH — spawn_omp will surface the real error.
    eprintln!("[omp-desktop] rpc-ui probe: omp not found, defaulting to rpc");
    false
}

/// Build the argv suffix (after the binary name) for spawning omp.
///
/// `--resume` is passed as a single `--resume=<value>` token rather than
/// two separate argv entries (`--resume`, `<value>`). omp's `--resume`
/// flag takes an *optional* value (bare `--resume` opens a picker), so a
/// flag-shaped value passed as a second token (e.g. `--auto-approve`) is
/// re-tokenised by omp's own argument parser as an unrelated flag instead
/// of the resume target. The single-token form can never be re-split.
/// Extracted as a pure function so this is unit-testable without spawning
/// a process.
fn omp_args(mode: &str, resume: Option<&str>) -> Vec<String> {
    let mut args = vec!["--mode".to_string(), mode.to_string()];
    if let Some(r) = resume {
        if !r.is_empty() {
            args.push(format!("--resume={r}"));
        }
    }
    args
}

// ── session spawn ─────────────────────────────────────────────────────────────

/// Spawn omp for a live session using the best available RPC mode.
/// If `resume` is specified, `--resume=<path_or_id>` is passed to resume an
/// existing session (a single token, not two separate argv entries — see
/// `omp_args` for why).
pub(super) fn spawn_omp(cwd: Option<&str>, resume: Option<&str>) -> Result<Child, String> {
    // On Windows, `Command::new` resolves bare "omp" against PATH and
    // PATHEXT (.exe etc.) via CreateProcess. We try the explicit ".exe"
    // name first because some systems have weird PATHEXT handling, then
    // fall back to bare "omp". We do NOT use `cmd /C` as a fallback —
    // it leaves the omp process orphaned when the parent cmd.exe is
    // killed, since Windows does not propagate process termination to
    // descendants without a Job Object.
    let mode = rpc_mode();
    let args = omp_args(mode, resume);
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
        if let Some(dir) = cwd {
            if !dir.is_empty() {
                cmd.current_dir(dir);
            }
        }
        match cmd.spawn() {
            Ok(child) => return Ok(child),
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
    use super::{help_text_supports_rpc_ui, omp_args};

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
        assert_eq!(omp_args("rpc", None), vec!["--mode", "rpc"]);
    }

    #[test]
    fn omp_args_with_empty_resume_is_omitted() {
        assert_eq!(omp_args("rpc", Some("")), vec!["--mode", "rpc"]);
    }

    #[test]
    fn omp_args_with_resume_uses_single_token() {
        // Single `--resume=<value>` token, not two separate argv entries —
        // see `omp_args` doc comment for why this matters.
        assert_eq!(
            omp_args("rpc-ui", Some("/tmp/sess.jsonl")),
            vec!["--mode", "rpc-ui", "--resume=/tmp/sess.jsonl"]
        );
    }

    #[test]
    fn omp_args_with_flag_shaped_resume_stays_single_token() {
        // Even a flag-shaped resume value can't be re-tokenised as a
        // separate argument because it's embedded in one `--resume=` token.
        assert_eq!(
            omp_args("rpc", Some("--auto-approve")),
            vec!["--mode", "rpc", "--resume=--auto-approve"]
        );
    }
}
