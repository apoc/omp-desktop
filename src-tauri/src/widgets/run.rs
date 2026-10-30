//! Run one widget plugin: the argv the worker checked (the validated config
//! with each hashed script replaced by its verified copy), context via env +
//! stdin JSON, stdout capped and required to be JSON, wall-clock timeout,
//! process tree killed on timeout, cap, or as soon as the plugin exits.
//! Synchronous and blocking — the widget host calls it on a worker thread.
//!
//! The pipes are drained on threads and the exit wait polls against the
//! deadline (`child_run.rs`). The stdout reader stops and raises a shared flag
//! past [`STDOUT_CAP_BYTES`]; the wait sees it and kills the tree. When the
//! plugin itself exits, the tree is killed at once: a background child still
//! holding stdout (`git fetch & echo '{…}'`) would otherwise hold the result
//! until the deadline. Bytes already in a pipe survive the writer's death. A
//! descendant that escaped the tree (`setsid`) can only delay the result until
//! the deadline, never past it.
//!
//! The context goes to stdin from a detached thread; the payload is bounded
//! (see `context.rs`) and the write fails as soon as the tree is killed.
//! stderr keeps a rolling tail of [`STDERR_KEEP_BYTES`]. Every thread is
//! created with `thread::Builder`; if the OS refuses one, the child is killed
//! and reaped and the run fails instead of panicking.

use std::ffi::OsStr;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::child_run::{recv_until, spawn_drain, terminate, wait_for_exit, WaitError};
use crate::supervisor::ProcessSupervisor;
use crate::widgets::config::PluginEntry;
use crate::widgets::context::PluginContext;
use crate::widgets::schedule::Outcome;

pub const STDOUT_CAP_BYTES: usize = 256 * 1024;
/// How much stderr is kept for error messages; the rest is drained and dropped.
const STDERR_KEEP_BYTES: usize = 64 * 1024;
/// How much of a failing run's stderr (or stdout) the error keeps.
const ERR_TAIL_CHARS: usize = 300;
/// How much of a non-JSON stdout the error shows.
const NOT_JSON_PREVIEW_CHARS: usize = 120;

/// Run `entry` as `argv` (its command, or the snapshot of it the approval
/// check hashed) with `ctx`. `on_spawn` receives the run's supervisor right
/// after spawn so another thread can `kill_tree()` it; the run itself still
/// reaps the child and returns. The result is `Ok` only for a stdout that
/// parses as JSON. All error text is redacted.
pub fn run_plugin<A: AsRef<OsStr>>(
    entry: &PluginEntry,
    argv: &[A],
    ctx: &PluginContext,
    on_spawn: impl FnOnce(&Arc<ProcessSupervisor>),
) -> Outcome {
    let start = Instant::now();
    let result = run_inner(entry, argv, ctx, on_spawn).and_then(require_json);
    let duration_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
    Outcome {
        result,
        duration_ms,
    }
}

fn run_inner<A: AsRef<OsStr>>(
    entry: &PluginEntry,
    argv: &[A],
    ctx: &PluginContext,
    on_spawn: impl FnOnce(&Arc<ProcessSupervisor>),
) -> Result<String, String> {
    let deadline = Instant::now() + Duration::from_millis(entry.timeout_ms);
    let mut child = spawn(entry, argv, ctx)?;
    let supervisor = Arc::new(ProcessSupervisor::attach(&child));
    on_spawn(&supervisor);

    let (Some(out_pipe), Some(err_pipe)) = (child.stdout.take(), child.stderr.take()) else {
        terminate(&supervisor, &mut child);
        return Err("stdout or stderr pipe missing".to_string());
    };
    let overflow = Arc::new(AtomicBool::new(false));
    let stdout_rx = spawn_drain(
        out_pipe,
        STDOUT_CAP_BYTES,
        Some(Arc::clone(&overflow)), // the reader thread raises the flag, this thread polls it
    )
    .inspect_err(|_| terminate(&supervisor, &mut child))?;
    let stderr_rx = spawn_drain(err_pipe, STDERR_KEEP_BYTES, None)
        .inspect_err(|_| terminate(&supervisor, &mut child))?;
    feed_stdin(&mut child, ctx).inspect_err(|_| terminate(&supervisor, &mut child))?;

    let status =
        wait_for_exit(&mut child, &supervisor, &overflow, deadline).map_err(|e| match e {
            WaitError::Overflow => cap_error(),
            WaitError::TimedOut => timeout_error(entry.timeout_ms),
            WaitError::Failed(e) => e,
        })?;
    // The plugin is done; whatever it left behind dies now rather than when
    // the supervisor drops, so a background holder of a pipe cannot stall
    // the readers until the deadline.
    supervisor.kill_tree();
    let out = recv_until(&stdout_rx, deadline)
        .ok_or_else(|| timeout_error(entry.timeout_ms))?
        .map_err(|e| format!("could not read stdout: {e}"))?;
    if overflow.load(Ordering::Relaxed) {
        return Err(cap_error());
    }
    if !status.success() {
        let stderr = recv_until(&stderr_rx, deadline)
            .and_then(Result::ok)
            .unwrap_or_default();
        let tail_src = if stderr.is_empty() { &out } else { &stderr };
        // `ExitStatus`'s own Display already says "exit status: N"; a killed
        // run has no code and keeps the signal text.
        let how = status
            .code()
            .map_or_else(|| status.to_string(), |code| format!("exit {code}"));
        return Err(format!("{how}: {}", tail(tail_src)));
    }
    String::from_utf8(out).map_err(|_| "stdout is not UTF-8".to_string())
}

fn spawn<A: AsRef<OsStr>>(
    entry: &PluginEntry,
    argv: &[A],
    ctx: &PluginContext,
) -> Result<Child, String> {
    // `name`: the configured program, which the user knows, not the copy's
    // path; `argv` is the command with copies swapped in, as long as it.
    let (Some(name), Some((argv0, rest))) = (entry.command.first(), argv.split_first()) else {
        return Err("command is empty".to_string());
    };
    // Never a shared temp dir: an interpreter that puts its cwd on the module
    // path would load whatever another local user planted there.
    let cwd = if ctx.project.is_empty() {
        crate::widgets::config::home_dir()
            .map(PathBuf::from)
            .ok_or_else(|| {
                "no working directory: tab has no project and no home directory is set".to_string()
            })?
    } else {
        PathBuf::from(&ctx.project)
    };
    let mut cmd = Command::new(argv0);
    cmd.args(rest)
        .current_dir(cwd)
        .env("OMP_WIDGET_VERSION", "1")
        .env("OMP_WIDGET_PROJECT", &ctx.project)
        .env("OMP_WIDGET_BRANCH", &ctx.branch)
        .env("OMP_WIDGET_REMOTE", &ctx.remote)
        .env("OMP_WIDGET_SESSION", &ctx.session)
        .env("OMP_WIDGET_TRIGGER", &ctx.trigger)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // A bare program name is looked up on PATH; an empty or relative entry
    // would resolve it inside the untrusted project directory.
    crate::child_path::apply_trusted_child_path(&mut cmd);
    // Also hides the console window on Windows.
    ProcessSupervisor::prepare(&mut cmd);
    // The OS error names the cause; `NotFound` also means a missing shebang
    // interpreter or a vanished cwd, not only a missing program.
    spawn_retrying_busy(&mut cmd).map_err(|e| format!("could not start {name}: {e}"))
}

/// [`spawn_gate::spawn`](crate::spawn_gate::spawn), retried briefly on
/// Linux's "text file busy": a script copy the worker just wrote can still be
/// open for writing in a child another thread forked meanwhile, until that
/// child's `exec` (rust-lang/rust#114554).
fn spawn_retrying_busy(cmd: &mut Command) -> std::io::Result<Child> {
    #[cfg(target_os = "linux")]
    for _ in 0..4 {
        match crate::spawn_gate::spawn(cmd) {
            Err(e) if e.raw_os_error() == Some(libc::ETXTBSY) => {
                std::thread::sleep(Duration::from_millis(25));
            }
            spawned => return spawned,
        }
    }
    crate::spawn_gate::spawn(cmd)
}

/// Context on stdin from a detached thread, which closes the pipe when done so
/// `cat`-style plugins terminate. Never joined: if the plugin never reads, the
/// write blocks only until the tree is killed, then fails and returns.
fn feed_stdin(child: &mut Child, ctx: &PluginContext) -> Result<(), String> {
    #[derive(serde::Serialize)]
    struct Payload<'a> {
        version: u8,
        #[serde(flatten)]
        ctx: &'a PluginContext,
    }
    let Some(mut stdin) = child.stdin.take() else {
        return Ok(());
    };
    let payload = serde_json::to_vec(&Payload { version: 1, ctx })
        .map_err(|e| format!("could not encode context: {e}"))?;
    std::thread::Builder::new()
        .name("widget-stdin".to_string())
        .spawn(move || {
            let _ = stdin.write_all(&payload); // a plugin that closed stdin early gives EPIPE; that's fine
        }) // `stdin` drops at the end of the closure, closing the pipe
        .map(drop) // detached on purpose; the handle is not needed
        .map_err(|e| format!("could not start stdin thread: {e}"))
}

fn cap_error() -> String {
    format!("stdout exceeds {} KiB", STDOUT_CAP_BYTES / 1024)
}

fn timeout_error(timeout_ms: u64) -> String {
    format!("timed out after {timeout_ms} ms")
}

/// `stdout` if it is one JSON document; otherwise an error with a redacted
/// preview of its start, so the UI never builds its own unredacted one.
fn require_json(stdout: String) -> Result<String, String> {
    if serde_json::from_str::<serde::de::IgnoredAny>(&stdout).is_ok() {
        return Ok(stdout);
    }
    let text = crate::widgets::redact::redact_secrets(stdout.trim());
    let preview: String = text.chars().take(NOT_JSON_PREVIEW_CHARS).collect();
    Err(if preview.is_empty() {
        "stdout is not JSON: it is empty".to_string()
    } else {
        format!("stdout is not JSON: {preview}")
    })
}

/// Last [`ERR_TAIL_CHARS`] of a failing run's output, redacted before it is
/// cut so a secret's key is still in view when it is masked.
fn tail(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    let s = crate::widgets::redact::redact_secrets(s.trim());
    let count = s.chars().count();
    if count <= ERR_TAIL_CHARS {
        s.into_owned()
    } else {
        s.chars().skip(count - ERR_TAIL_CHARS).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::widgets::config::test_entry;

    fn entry(cmd: &[&str], timeout_ms: u64) -> PluginEntry {
        PluginEntry {
            timeout_ms,
            ..test_entry(cmd)
        }
    }

    fn ctx() -> PluginContext {
        PluginContext {
            project: std::env::temp_dir().to_string_lossy().into_owned(),
            branch: String::new(),
            remote: String::new(),
            session: "s1".into(),
            trigger: "manual".into(),
        }
    }

    /// Run `entry` as its configured command.
    fn run_entry(
        entry: &PluginEntry,
        ctx: &PluginContext,
        on_spawn: impl FnOnce(&Arc<ProcessSupervisor>),
    ) -> Outcome {
        run_plugin(entry, &entry.command, ctx, on_spawn)
    }

    fn run(cmd: &[&str], timeout_ms: u64) -> Outcome {
        run_entry(&entry(cmd, timeout_ms), &ctx(), |_| {})
    }

    fn assert_timed_out(r: &Outcome, timeout_ms: u64) {
        let want = format!("timed out after {timeout_ms} ms");
        assert!(
            r.result.as_ref().err().is_some_and(|e| e.contains(&want)),
            "{r:?}"
        );
        assert!(r.result.is_err(), "{r:?}");
    }

    #[cfg(unix)]
    #[test]
    fn happy_path_returns_stdout_and_env() {
        let r = run(
            &[
                "sh",
                "-c",
                "echo \"{\\\"trigger\\\":\\\"$OMP_WIDGET_TRIGGER\\\"}\"",
            ],
            5_000,
        );
        assert!(r.result.is_ok(), "{r:?}");
        assert_eq!(
            r.result.as_deref().ok().map(str::trim),
            Some(r#"{"trigger":"manual"}"#)
        );
    }

    #[cfg(unix)]
    #[test]
    fn stdin_carries_context_json() {
        let r = run(&["sh", "-c", "cat"], 5_000);
        let v: serde_json::Value =
            serde_json::from_str(r.result.as_deref().ok().unwrap_or("")).expect("json on stdin");
        assert_eq!(v["session"], "s1");
        assert_eq!(v["trigger"], "manual");
        assert_eq!(v["version"], 1);
    }

    #[cfg(unix)]
    #[test]
    fn on_spawn_supervisor_kills_the_run_from_another_thread() {
        let start = Instant::now();
        let r = run_entry(&entry(&["sh", "-c", "sleep 30"], 20_000), &ctx(), |sup| {
            let sup = Arc::clone(sup); // the killer thread outlives this callback
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(200));
                sup.kill_tree();
            });
        });
        assert!(start.elapsed() < Duration::from_secs(5), "{r:?}");
        assert!(r.result.err().is_some_and(|e| e.starts_with("signal: 9")));
    }

    #[cfg(unix)]
    #[test]
    fn background_child_holding_stdout_does_not_stall_success() {
        let start = Instant::now();
        let r = run(&["sh", "-c", "sleep 30 & echo \"{}\""], 5_000);
        assert!(start.elapsed() < Duration::from_secs(4), "{r:?}");
        assert_eq!(r.result.as_deref().ok(), Some("{}\n"), "{r:?}");
        assert!(r.result.is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn non_json_stdout_is_a_redacted_error() {
        let r = run(&["sh", "-c", "echo 'hello token=SYNTHLEAK'"], 5_000);
        assert!(r.result.is_err());
        let e = r.result.expect_err("error");
        assert!(
            e.starts_with("stdout is not JSON: hello token=[REDACTED]"),
            "{e}"
        );
        assert!(!e.contains("SYNTHLEAK"), "{e}");

        let empty = run(&["true"], 5_000);
        assert_eq!(
            empty.result.as_ref().err().map(String::as_str),
            Some("stdout is not JSON: it is empty")
        );
    }

    #[test]
    fn non_json_preview_is_bounded() {
        let e = require_json("x".repeat(10_000)).expect_err("not json");
        assert_eq!(
            e.len(),
            "stdout is not JSON: ".len() + NOT_JSON_PREVIEW_CHARS
        );
        assert_eq!(require_json("[1]".into()), Ok("[1]".into()));
    }

    #[cfg(unix)]
    #[test]
    fn failure_tail_redacts_credentials() {
        let r = run(
            &[
                "sh",
                "-c",
                "echo 'Authorization: Bearer SYNTHETIC123' >&2; exit 2",
            ],
            5_000,
        );
        let e = r.result.expect_err("error");
        assert!(e.contains("Bearer [REDACTED]"), "{e}");
        assert!(!e.contains("SYNTHETIC123"), "{e}");
    }

    #[cfg(unix)]
    #[test]
    fn nonzero_exit_is_error_even_with_json() {
        let r = run(
            &["sh", "-c", "echo '{\"version\":1}'; echo boom >&2; exit 3"],
            5_000,
        );
        assert!(r.result.is_err());
        let e = r.result.expect_err("error");
        assert_eq!(e, "exit 3: boom");
    }

    #[cfg(unix)]
    #[test]
    fn timeout_kills_and_errors() {
        let start = Instant::now();
        let r = run(&["sh", "-c", "sleep 30"], 1_000);
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "must not wait for sleep"
        );
        assert_timed_out(&r, 1_000);
    }

    #[cfg(unix)]
    #[test]
    fn stdout_cap_kills_and_errors() {
        let r = run(
            &["sh", "-c", "yes 0123456789abcdef | head -c 1048576"],
            5_000,
        );
        assert!(
            r.result
                .as_ref()
                .err()
                .is_some_and(|e| e.contains("exceeds")),
            "{r:?}"
        );
        assert!(r.result.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn max_size_context_does_not_block_a_plugin_that_ignores_stdin() {
        let max = crate::widgets::context::CONTEXT_FIELD_MAX_BYTES;
        let mut full = ctx();
        full.session = "x".repeat(max);
        full.remote = "x".repeat(max);
        full.branch = "x".repeat(max);
        let start = Instant::now();
        let r = run_entry(&entry(&["sh", "-c", "sleep 30"], 1_000), &full, |_| {});
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "must not block on stdin"
        );
        assert_timed_out(&r, 1_000);
    }

    #[cfg(unix)]
    #[test]
    fn timeout_kills_grandchild() {
        let pidfile = std::env::temp_dir().join(format!("omp-widget-gc-{}", std::process::id()));
        let script = format!("sleep 30 & echo $! > '{}'; wait", pidfile.display());
        let r = run(&["sh", "-c", &script], 1_000);
        assert_timed_out(&r, 1_000);
        let pid: libc::pid_t = std::fs::read_to_string(&pidfile)
            .expect("plugin wrote the sleep pid")
            .trim()
            .parse()
            .expect("pid");
        let _ = std::fs::remove_file(&pidfile);
        // `kill(pid, 0)` probes existence without signalling; a killed
        // grandchild is reaped by init a moment later, so poll briefly.
        let deadline = Instant::now() + Duration::from_secs(3);
        let alive = loop {
            // SAFETY: plain-integer FFI call; signal 0 only probes existence.
            let alive = unsafe { libc::kill(pid, 0) == 0 };
            if !alive || Instant::now() >= deadline {
                break alive;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(!alive, "sleep grandchild {pid} survived the timeout");
    }

    #[cfg(unix)]
    #[test]
    fn stderr_keeps_the_tail_not_the_head() {
        let r = run(
            &[
                "sh",
                "-c",
                "yes log | head -c 200000 >&2; echo FINAL-MARKER >&2; exit 2",
            ],
            5_000,
        );
        assert!(
            r.result
                .as_ref()
                .err()
                .is_some_and(|e| e.contains("FINAL-MARKER")),
            "{r:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn no_project_runs_in_home() {
        let Some(home) = crate::widgets::config::home_dir() else {
            return;
        };
        let mut c = ctx();
        c.project = String::new();
        let r = run_entry(
            &entry(&["sh", "-c", "printf '\"%s\"' \"$PWD\""], 5_000),
            &c,
            |_| {},
        );
        let cwd: String =
            serde_json::from_str(r.result.as_deref().ok().unwrap_or("")).expect("json");
        assert_eq!(
            std::fs::canonicalize(cwd).ok(),
            std::fs::canonicalize(home).ok(),
            "{r:?}"
        );
    }

    #[test]
    fn missing_executable_reports_spawn_error() {
        let r = run(&["omp-widget-does-not-exist-9f3a"], 5_000);
        assert!(
            r.result
                .as_ref()
                .err()
                .is_some_and(|e| e.starts_with("could not start omp-widget-does-not-exist-9f3a: ")),
            "{r:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_happy_path_returns_stdout() {
        // `[1,2]` needs no quoting: an argument with `"` is escaped for the
        // MSVC runtime, which `cmd`'s `echo` would print literally.
        let r = run(&["cmd", "/C", "echo", "[1,2]"], 10_000);
        assert!(r.result.is_ok(), "{r:?}");
        assert_eq!(r.result.as_deref().ok().map(str::trim), Some("[1,2]"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_timeout_kills_and_errors() {
        let start = Instant::now();
        let r = run(&["cmd", "/C", "ping", "-n", "30", "127.0.0.1"], 1_000);
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "must not wait for ping"
        );
        assert_timed_out(&r, 1_000);
    }
}
