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

// ── session spawn ─────────────────────────────────────────────────────────────

/// Spawn omp for a live session using the best available RPC mode.
pub(super) fn spawn_omp(cwd: Option<&str>) -> Result<Child, String> {
    // On Windows, `Command::new` resolves bare "omp" against PATH and
    // PATHEXT (.exe etc.) via CreateProcess. We try the explicit ".exe"
    // name first because some systems have weird PATHEXT handling, then
    // fall back to bare "omp". We do NOT use `cmd /C` as a fallback —
    // it leaves the omp process orphaned when the parent cmd.exe is
    // killed, since Windows does not propagate process termination to
    // descendants without a Job Object.
    let mode = rpc_mode();
    let mut last_err = String::from("no candidates tried");
    for name in CANDIDATES {
        let mut cmd = Command::new(name);
        cmd.args(["--mode", mode])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
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
    use super::help_text_supports_rpc_ui;

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
        assert!(help_text_supports_rpc_ui("supported modes: rpc-ui, rpc, text"));
    }
}
