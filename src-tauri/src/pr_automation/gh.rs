//! Bounded, supervised `gh api graphql` execution. No project-provided
//! executable or API endpoint is ever used.
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use crate::child_path::{child_path_dirs, locate_program, TrustedProgram};
use crate::supervisor::ProcessSupervisor;

const OUTPUT_LIMIT: usize = 2 * 1024 * 1024;
const ERROR_LIMIT: usize = 16 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);

pub(super) struct Gh(TrustedProgram);

impl Gh {
    pub(super) fn locate() -> Result<Self, String> {
        locate_program(&child_path_dirs(), "gh").map(Self)
    }

    pub(super) fn query(
        &self,
        query: &str,
        variables: &[(&str, &str)],
    ) -> Result<serde_json::Value, String> {
        let mut cmd = Command::new(&self.0.binary);
        cmd.env("PATH", &self.0.path)
            .env_remove("GH_REPO")
            .env_remove("GH_DEBUG")
            .args([
                "api",
                "graphql",
                "--hostname",
                "github.com",
                "--method",
                "POST",
                "-f",
            ])
            .arg(format!("query={query}"));
        for (key, value) in variables {
            // -f treats values literally, unlike -F's @file interpretation.
            cmd.arg("-f").arg(format!("{key}={value}"));
        }
        parse_response(&run(&mut cmd, TIMEOUT)?)
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

fn drain(
    pipe: impl Read + Send + 'static,
    limit: usize,
    overflow: Arc<AtomicBool>,
) -> Result<mpsc::Receiver<std::io::Result<Vec<u8>>>, String> {
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("pr-gh-drain".into())
        .spawn(move || {
            let mut pipe = pipe;
            let mut result = Vec::new();
            let mut chunk = [0; 8192];
            let read = loop {
                match pipe.read(&mut chunk) {
                    Ok(0) => break Ok(result),
                    Ok(n) if result.len() + n > limit => {
                        overflow.store(true, Ordering::Relaxed);
                        break Ok(result);
                    }
                    Ok(n) => result.extend_from_slice(&chunk[..n]),
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(e) => break Err(e),
                }
            };
            let _ = tx.send(read);
        })
        .map_err(|e| format!("could not start GitHub output reader: {e}"))?;
    Ok(rx)
}

fn terminate(supervisor: &ProcessSupervisor, child: &mut std::process::Child) {
    supervisor.kill_tree();
    let _ = child.kill();
    let _ = child.wait();
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
    let out = drain(stdout, OUTPUT_LIMIT, Arc::clone(&overflow))
        .inspect_err(|_| terminate(&supervisor, &mut child))?;
    let err = drain(stderr, ERROR_LIMIT, Arc::clone(&overflow))
        .inspect_err(|_| terminate(&supervisor, &mut child))?;
    let status = loop {
        if overflow.load(Ordering::Relaxed) {
            terminate(&supervisor, &mut child);
            return Err("gh output exceeded its size limit".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                terminate(&supervisor, &mut child);
                return Err("gh request timed out".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(e) => {
                terminate(&supervisor, &mut child);
                return Err(format!("could not wait for gh: {e}"));
            }
        }
    };
    supervisor.kill_tree(); // Do not let descendants keep the pipes open.
    let receive = |rx: mpsc::Receiver<std::io::Result<Vec<u8>>>| {
        rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| "gh output timed out".to_string())?
            .map_err(|e| format!("could not read gh output: {e}"))
    };
    let stdout = receive(out)?;
    let stderr = receive(err)?;
    if overflow.load(Ordering::Relaxed) {
        return Err("gh output exceeded its size limit".into());
    }
    if !status.success() {
        let text = String::from_utf8_lossy(&stderr);
        let redacted = crate::widgets::redact::redact_secrets(text.trim());
        let preview = crate::text::prefix_within(&redacted, 1024);
        return Err(if preview.is_empty() {
            format!("gh failed ({status})")
        } else {
            format!("gh failed ({status}): {preview}")
        });
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

    #[cfg(unix)]
    #[test]
    fn captures_success_and_reports_failure() {
        let mut ok = Command::new("/bin/sh");
        ok.args(["-c", "printf hello"]);
        assert_eq!(run(&mut ok, Duration::from_secs(2)).unwrap(), b"hello");
        let mut fail = Command::new("/bin/sh");
        fail.args(["-c", "echo denied >&2; exit 2"]);
        assert!(run(&mut fail, Duration::from_secs(2))
            .unwrap_err()
            .contains("denied"));
    }

    #[cfg(unix)]
    #[test]
    fn times_out_and_caps_output() {
        let mut slow = Command::new("/bin/sh");
        slow.args(["-c", "sleep 5"]);
        assert!(run(&mut slow, Duration::from_millis(100))
            .unwrap_err()
            .contains("timed out"));
        let mut flood = Command::new("/bin/sh");
        flood.args(["-c", "yes x"]);
        assert!(run(&mut flood, Duration::from_secs(5))
            .unwrap_err()
            .contains("size limit"));
    }
}
