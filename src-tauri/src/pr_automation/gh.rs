//! Bounded, supervised `gh api` execution (GraphQL, and one REST list). No
//! project-provided executable or API endpoint is ever used.
use std::path::PathBuf;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::child_path::{locate_program, TrustedProgram};
use crate::child_run::{recv_until, spawn_drain, terminate, wait_for_exit, WaitError};
use crate::supervisor::ProcessSupervisor;

const OUTPUT_LIMIT: usize = 2 * 1024 * 1024;
/// How much of gh's stderr is kept (the tail) for the error message.
const ERROR_LIMIT: usize = 16 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);
/// gh's documented exit code for "authentication required".
const AUTH_REQUIRED_EXIT: i32 = 4;
const SIGNED_OUT: &str =
    "GitHub CLI is not signed in. Run \"gh auth login\" in a terminal, then return to the app.";
const SIZE_ERROR: &str = "gh output exceeded its size limit";
const TIMED_OUT: &str = "gh request timed out";

pub(super) struct Gh(TrustedProgram);

impl Gh {
    pub(super) fn locate_in(dirs: &[PathBuf]) -> Result<Self, String> {
        locate_program(dirs, "gh").map(Self)
    }

    /// `gh api <endpoint>` against github.com, whatever the environment
    /// says: `GH_REPO` would redirect `{owner}` placeholders, and
    /// `GH_DEBUG`, `CLICOLOR_FORCE` and `GH_FORCE_TTY` mix logs or ANSI
    /// colour into the JSON even when it goes to a pipe.
    fn api(&self, endpoint: &str, method: &str) -> Command {
        let mut cmd = Command::new(&self.0.binary);
        cmd.env("PATH", &self.0.path)
            .env_remove("GH_REPO")
            .env_remove("GH_DEBUG")
            .env_remove("CLICOLOR_FORCE")
            .env_remove("GH_FORCE_TTY")
            .args([
                "api",
                endpoint,
                "--hostname",
                "github.com",
                "--method",
                method,
            ]);
        cmd
    }

    pub(super) fn query(
        &self,
        query: &str,
        variables: &[(&str, &str)],
    ) -> Result<serde_json::Value, String> {
        let mut cmd = self.api("graphql", "POST");
        cmd.arg("-f").arg(format!("query={query}"));
        for (key, value) in variables {
            // -f treats values literally, unlike -F's @file interpretation.
            cmd.arg("-f").arg(format!("{key}={value}"));
        }
        parse_response(&run(&mut cmd, TIMEOUT)?)
    }

    /// The REST list of open PRs into `repository` (a validated GitHub
    /// `owner/name`) whose head is `head` (`owner:branch`), up to 100. For a
    /// GET, gh URL-encodes the `-f` fields into the query string.
    pub(super) fn open_pulls(
        &self,
        repository: &str,
        head: &str,
    ) -> Result<serde_json::Value, String> {
        let mut cmd = self.api(&format!("repos/{repository}/pulls"), "GET");
        cmd.args(["-f", "state=open", "-f"])
            .arg(format!("head={head}"))
            .args(["-f", "per_page=100"]);
        serde_json::from_slice(&run(&mut cmd, TIMEOUT)?)
            .map_err(|_| "GitHub returned malformed JSON".to_string())
    }
}

fn parse_response(bytes: &[u8]) -> Result<serde_json::Value, String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "GitHub returned malformed JSON".to_string())?;
    if let Some(errors) = value.get("errors") {
        if !errors.is_null() && errors.as_array().is_none_or(|a| !a.is_empty()) {
            return Err(
                "GitHub GraphQL returned errors; check authentication and repository access"
                    .to_string(),
            );
        }
    }
    if !value.get("data").is_some_and(serde_json::Value::is_object) {
        return Err("GitHub GraphQL returned no data".to_string());
    }
    Ok(value)
}

/// The error for a gh run that exited unsuccessfully. A signed-out gh (exit
/// 4, or a revoked token's `HTTP 401`) gets one readable message instead of
/// gh's own hint; anything else keeps a redacted start of gh's stderr.
fn failure(status: ExitStatus, stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    if status.code() == Some(AUTH_REQUIRED_EXIT) || text.contains("HTTP 401") {
        return SIGNED_OUT.to_string();
    }
    let redacted = crate::widgets::redact::redact_secrets(text.trim());
    let preview = crate::text::prefix_within(&redacted, 1024);
    if preview.is_empty() {
        format!("gh failed ({status})")
    } else {
        format!("gh failed ({status}): {preview}")
    }
}

fn run(cmd: &mut Command, timeout: Duration) -> Result<Vec<u8>, String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    ProcessSupervisor::prepare(cmd);
    let deadline = Instant::now() + timeout;
    let mut child =
        crate::spawn_gate::spawn(cmd).map_err(|e| format!("could not start gh: {e}"))?;
    let supervisor = ProcessSupervisor::attach(&child);
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        terminate(&supervisor, &mut child);
        return Err("could not capture gh output".into());
    };
    let overflow = Arc::new(AtomicBool::new(false));
    let out = spawn_drain(stdout, OUTPUT_LIMIT, Some(Arc::clone(&overflow)))
        .inspect_err(|_| terminate(&supervisor, &mut child))?;
    let err = spawn_drain(stderr, ERROR_LIMIT, None)
        .inspect_err(|_| terminate(&supervisor, &mut child))?;
    let status =
        wait_for_exit(&mut child, &supervisor, &overflow, deadline).map_err(|e| match e {
            WaitError::Overflow => SIZE_ERROR.to_string(),
            WaitError::TimedOut => TIMED_OUT.to_string(),
            WaitError::Failed(e) => format!("gh {e}"),
        })?;
    supervisor.kill_tree(); // Do not let descendants keep the pipes open.
    let stdout = recv_until(&out, deadline)
        .ok_or_else(|| TIMED_OUT.to_string())?
        .map_err(|e| format!("could not read gh output: {e}"))?;
    if overflow.load(Ordering::Relaxed) {
        return Err(SIZE_ERROR.into());
    }
    if !status.success() {
        let stderr = recv_until(&err, deadline)
            .and_then(Result::ok)
            .unwrap_or_default();
        return Err(failure(status, &stderr));
    }
    Ok(stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_partial_error_and_malformed_graphql_responses() {
        assert!(
            parse_response(br#"{"data":{"repository":null},"errors":[{"message":"denied"}]}"#)
                .is_err()
        );
        assert!(parse_response(br#"{"errors":"bad"}"#).is_err());
        assert!(parse_response(br#"{"data":null}"#).is_err());
        assert!(parse_response(b"not json").is_err());
        assert!(parse_response(br#"{"data":{"repository":null},"errors":[]}"#).is_ok());
    }

    /// A shell command line: `sh -c` on unix, `cmd /C` on Windows.
    fn shell(script: &str) -> Command {
        #[cfg(unix)]
        {
            let mut cmd = Command::new("/bin/sh");
            cmd.args(["-c", script]);
            cmd
        }
        #[cfg(windows)]
        {
            // One argument per word: `Command` quotes none of them, so `cmd`
            // sees the line as written.
            let mut cmd = Command::new("cmd");
            cmd.arg("/C").args(script.split(' '));
            cmd
        }
    }

    /// A child that writes `stderr` (plain words) and exits with `code`.
    fn failing(stderr: &str, code: i32) -> Command {
        #[cfg(unix)]
        let script = format!("echo {stderr} >&2; exit {code}");
        #[cfg(windows)]
        let script = format!("echo {stderr} 1>&2 & exit {code}");
        shell(&script)
    }

    #[test]
    fn captures_success_and_reports_failure() {
        let out = run(&mut shell("echo hello"), Duration::from_secs(10)).unwrap();
        assert_eq!(String::from_utf8_lossy(&out).trim(), "hello");
        let err = run(&mut failing("denied", 2), Duration::from_secs(10)).unwrap_err();
        assert!(err.contains("denied"), "{err}");
        assert_ne!(err, SIGNED_OUT);
    }

    #[test]
    fn signed_out_gh_gets_one_readable_error() {
        // gh's own exit code for "authentication required"…
        let mut signed_out = failing("To get started with GitHub CLI run gh auth login", 4);
        assert_eq!(
            run(&mut signed_out, Duration::from_secs(10)).unwrap_err(),
            SIGNED_OUT
        );
        // …and a revoked or invalid token, which gh reports as a plain failure.
        let mut revoked = failing("HTTP 401: Bad credentials", 1);
        assert_eq!(
            run(&mut revoked, Duration::from_secs(10)).unwrap_err(),
            SIGNED_OUT
        );
    }

    #[cfg(unix)]
    #[test]
    fn times_out_and_caps_output() {
        let mut slow = shell("sleep 5");
        assert!(run(&mut slow, Duration::from_millis(100))
            .unwrap_err()
            .contains("timed out"));
        let mut flood = shell("yes x");
        assert!(run(&mut flood, Duration::from_secs(5))
            .unwrap_err()
            .contains("size limit"));
    }

    #[cfg(windows)]
    #[test]
    fn times_out_and_caps_output() {
        let start = Instant::now();
        let mut slow = shell("ping -n 30 127.0.0.1");
        assert!(run(&mut slow, Duration::from_millis(500))
            .unwrap_err()
            .contains("timed out"));
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "must not wait for ping"
        );
        let line = "x".repeat(1000);
        let mut flood = shell(&format!("for /L %i in (1,1,100000) do @echo {line}"));
        assert!(run(&mut flood, Duration::from_secs(20))
            .unwrap_err()
            .contains("size limit"));
    }
}
