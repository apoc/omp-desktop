//! One-shot `omp <subcommand>` runs outside the RPC bridge (`omp stats`,
//! `omp config`): spawn through `agent::spawn::spawn_candidate_output`,
//! return stdout on success, and turn a non-zero exit into one readable
//! error string.

/// How much of a failing run's stdout is retained in the error message
/// when stderr was empty. A handful of lines of usage/error text is ample;
/// this exists only to bound a pathological case (an old omp printing
/// something unexpectedly large to stdout before failing).
const STDOUT_TAIL_MAX_BYTES: usize = 4 * 1024;

/// Run `omp <args>` and return its stdout, or the failure message.
/// `label` names the subcommand in that message (`"omp stats"`).
///
/// Spawns `omp`, so callers MUST run this off the main thread.
pub fn run(args: &[String], label: &str) -> Result<Vec<u8>, String> {
    let output = crate::agent::spawn::spawn_candidate_output(args)?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(exit_failure_message(
            label,
            output.status,
            &output.stderr,
            &output.stdout,
        ))
    }
}

/// Build the error string for a non-zero exit.
///
/// Confirmed failure modes that reach here (`omp` not being on PATH at
/// all is a separate, earlier error from `spawn_candidate_output`):
/// probing this CLI's own argument parser with an unrecognized subcommand
/// and no flags exits non-zero with *both* streams empty (observed
/// directly: exit 129, no stderr, no stdout); the same probe with an added
/// `--json` flag instead exits 2 with `"unknown flag: --json"` on stderr —
/// that shape is handled by the stderr branch below. A bare
/// `"omp stats failed: "` would leave the UI showing nothing useful, so
/// this falls back to a capped stdout *tail* (the trailing bytes, most
/// likely to hold a final error line if something more verbose ever
/// precedes it — not the head) when stderr is empty, and only if that's
/// also empty names the concrete symptom (exit status, no output) rather
/// than guessing at a cause.
///
/// Takes `status` by `impl Display` (rather than the whole
/// `std::process::Output`) so it can be unit-tested without constructing
/// a platform-specific `ExitStatus` (`std::os::unix::process::ExitStatusExt`
/// and its Windows equivalent have incompatible signatures).
fn exit_failure_message(
    label: &str,
    status: impl std::fmt::Display,
    stderr: &[u8],
    stdout: &[u8],
) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        return format!("{label} failed: {stderr}");
    }
    let tail_start = stdout.len().saturating_sub(STDOUT_TAIL_MAX_BYTES);
    let stdout = String::from_utf8_lossy(&stdout[tail_start..]);
    let stdout = stdout.trim();
    if !stdout.is_empty() {
        return format!("{label} failed ({status}): {stdout}");
    }
    format!("{label} exited with {status} and produced no output")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_failure_with_empty_stderr_and_stdout_names_the_status() {
        // The case actually observed running a real omp build: an
        // unrecognized subcommand exits non-zero with nothing on either
        // stream.
        let msg = exit_failure_message("omp stats", "exit status: 129", &[], &[]);
        assert_eq!(
            msg,
            "omp stats exited with exit status: 129 and produced no output"
        );
    }

    #[test]
    fn exit_failure_with_stderr_surfaces_it_verbatim() {
        let msg = exit_failure_message(
            "omp config",
            "exit status: 1",
            b"  permission denied  \n",
            b"ignored",
        );
        assert_eq!(msg, "omp config failed: permission denied");
    }

    #[test]
    fn exit_failure_falls_back_to_stdout_when_stderr_is_empty() {
        let msg = exit_failure_message(
            "omp stats",
            "exit status: 2",
            b"",
            b"  usage: omp [command]  \n",
        );
        assert_eq!(
            msg,
            "omp stats failed (exit status: 2): usage: omp [command]"
        );
    }

    #[test]
    fn exit_failure_stdout_fallback_keeps_the_tail_not_the_head() {
        // A stdout longer than STDOUT_TAIL_MAX_BYTES must keep the
        // *trailing* bytes, where a final error line is most likely to
        // land after some earlier, less useful output. A distinct marker
        // at the very front (rather than reasoning about how much filler
        // survives a partial trim) makes "not the head" a direct,
        // unambiguous check: if the slicing direction ever regresses to
        // a head-slice, HEAD_MARKER would appear and TRAILING_MARKER
        // would not.
        let filler = "x".repeat(STDOUT_TAIL_MAX_BYTES * 2);
        let stdout = format!("HEAD_MARKER{filler}TRAILING_MARKER");
        let msg = exit_failure_message("omp stats", "exit status: 2", b"", stdout.as_bytes());
        assert!(msg.contains("TRAILING_MARKER"), "message was: {msg}");
        assert!(!msg.contains("HEAD_MARKER"), "message was: {msg}");
        // `assert_eq!`, not a `<=` bound. The bound is expressed in
        // `STDOUT_TAIL_MAX_BYTES` itself, so it can't catch a change to
        // that constant's *value* (slice and bound move together either
        // way) - what it pins is the *slice* actually honouring
        // whatever the constant says: an implementation that kept, say,
        // `STDOUT_TAIL_MAX_BYTES / 2` or `STDOUT_TAIL_MAX_BYTES - 1`
        // bytes instead of the full amount would still drop HEAD_MARKER
        // and keep TRAILING_MARKER (passing both checks above) but fail
        // this one.
        let prefix_len = "omp stats failed (exit status: 2): ".len();
        assert_eq!(
            msg.len(),
            prefix_len + STDOUT_TAIL_MAX_BYTES,
            "message was: {msg}"
        );
    }
}
