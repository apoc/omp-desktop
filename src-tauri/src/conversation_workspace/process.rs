//! Deadline- and cancellation-bounded native checkout subprocesses.
use crate::supervisor::ProcessSupervisor;
use std::collections::VecDeque;
use std::io::Read;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::time::{Duration, Instant};

const OUTPUT_KEEP: usize = 4096;
const POLL: Duration = Duration::from_millis(25);
const DRAIN_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug)]
pub struct Output {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

fn drain(
    mut pipe: impl Read + Send + 'static,
) -> Result<Receiver<std::io::Result<Vec<u8>>>, String> {
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("workspace-output".to_string())
        .spawn(move || {
            let mut tail = VecDeque::with_capacity(OUTPUT_KEEP);
            let mut chunk = [0u8; 4096];
            let result = loop {
                match pipe.read(&mut chunk) {
                    Ok(0) => break Ok(Vec::from(tail)),
                    Ok(n) => {
                        let excess = (tail.len() + n).saturating_sub(OUTPUT_KEEP);
                        tail.drain(..excess);
                        tail.extend(&chunk[..n]);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(e) => break Err(e),
                }
            };
            let _ = tx.send(result);
        })
        .map_err(|e| format!("cannot start checkout output reader: {e}"))?;
    Ok(rx)
}

fn terminate(supervisor: &ProcessSupervisor, child: &mut Child) {
    supervisor.kill_tree();
    let _ = child.kill(); // fallback if Windows could not attach the Job Object
    let _ = child.wait();
}

fn take_output(
    rx: &Receiver<std::io::Result<Vec<u8>>>,
    slot: &mut Option<Vec<u8>>,
) -> Result<(), String> {
    if slot.is_some() {
        return Ok(());
    }
    match rx.try_recv() {
        Ok(Ok(bytes)) => *slot = Some(bytes),
        Ok(Err(e)) => return Err(format!("cannot read checkout output: {e}")),
        Err(TryRecvError::Disconnected) => {
            return Err("checkout output reader stopped unexpectedly".to_string())
        }
        Err(TryRecvError::Empty) => {}
    }
    Ok(())
}

/// Supervise and reap the child tree; never wait indefinitely for a hook or
/// a descendant holding an output pipe. Captured diagnostics are tail-bounded.
pub fn run(
    command: &mut Command,
    cancelled: impl Fn() -> bool,
    timeout: Duration,
) -> Result<Output, String> {
    if cancelled() {
        return Err("checkout was cancelled by tab cleanup or shutdown".to_string());
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    ProcessSupervisor::prepare(command);
    let mut child = crate::spawn_gate::spawn(command)
        .map_err(|e| format!("cannot start checkout command: {e}"))?;
    let supervisor = ProcessSupervisor::attach(&child);
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        terminate(&supervisor, &mut child);
        return Err("checkout output pipes are unavailable".to_string());
    };
    let stdout_rx = drain(stdout).inspect_err(|_| terminate(&supervisor, &mut child))?;
    let stderr_rx = drain(stderr).inspect_err(|_| terminate(&supervisor, &mut child))?;
    let deadline = Instant::now() + timeout;
    let status = loop {
        if cancelled() {
            terminate(&supervisor, &mut child);
            return Err("checkout was cancelled by tab cleanup or shutdown".to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                terminate(&supervisor, &mut child);
                return Err("checkout timed out; its process tree was terminated".to_string());
            }
            Ok(None) => std::thread::sleep(POLL),
            Err(e) => {
                terminate(&supervisor, &mut child);
                return Err(format!("cannot wait for checkout command: {e}"));
            }
        }
    };
    // A hook can leave a grandchild holding a pipe even after its parent exits.
    supervisor.kill_tree();
    let drain_deadline = deadline.min(Instant::now() + DRAIN_GRACE);
    let (mut stdout, mut stderr) = (None, None);
    loop {
        take_output(&stdout_rx, &mut stdout)?;
        take_output(&stderr_rx, &mut stderr)?;
        if let (Some(stdout), Some(stderr)) = (&mut stdout, &mut stderr) {
            return Ok(Output {
                status,
                stdout: std::mem::take(stdout),
                stderr: std::mem::take(stderr),
            });
        }
        if cancelled() {
            return Err("checkout was cancelled by tab cleanup or shutdown".to_string());
        }
        if Instant::now() >= drain_deadline {
            return Err("checkout output remained open after the process exited".to_string());
        }
        std::thread::sleep(POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::{run, OUTPUT_KEEP};
    use crate::conversation_workspace::WorkspaceManager;
    use crate::test_support;
    use std::time::{Duration, Instant};

    fn long_running() -> std::process::Command {
        test_support::shell(if cfg!(windows) {
            "ping -n 15 127.0.0.1 >nul"
        } else {
            "sleep 15"
        })
    }

    #[test]
    fn timeout_terminates_and_reaps_the_checkout() {
        let started = Instant::now();
        let error = run(&mut long_running(), || false, Duration::from_millis(100)).unwrap_err();
        assert!(error.contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn shutdown_cancels_the_inflight_checkout() {
        let manager = WorkspaceManager::default();
        let ticket = manager.ticket("checkout").unwrap();
        let started = Instant::now();
        let error = std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                run(
                    &mut long_running(),
                    || manager.check_ticket(&ticket).is_err(),
                    Duration::from_secs(30),
                )
            });
            std::thread::sleep(Duration::from_millis(100));
            manager.shutdown();
            worker.join().unwrap().unwrap_err()
        });
        assert!(error.contains("cancelled"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn diagnostics_are_bounded_and_keep_the_end() {
        let script = if cfg!(windows) {
            "for /L %i in (1,1,2000) do @echo abcdefghij & echo END"
        } else {
            "i=0; while [ $i -lt 2000 ]; do printf abcdefghij; i=$((i+1)); done; printf END"
        };
        let output = run(
            &mut test_support::shell(script),
            || false,
            Duration::from_secs(10),
        )
        .unwrap();
        assert!(output.status.success());
        assert!(output.stdout.len() <= OUTPUT_KEEP);
        assert!(String::from_utf8_lossy(&output.stdout).contains("END"));
    }

    #[cfg(unix)]
    #[test]
    fn exited_parent_cannot_leave_descendant_pipe_holding_checkout_open() {
        let started = Instant::now();
        let output = run(
            &mut test_support::shell("sleep 15 & exit 1"),
            || false,
            Duration::from_secs(10),
        )
        .unwrap();
        assert!(!output.status.success());
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
