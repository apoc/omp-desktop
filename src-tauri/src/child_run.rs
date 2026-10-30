//! Bounded child-process runs, shared by widget plugins (`widgets/run.rs`)
//! and the PR lookup's `gh` calls (`pr_automation/gh.rs`): pipe drain
//! threads, the deadline-bounded exit wait, and tree termination.
//!
//! A blocking `read` cannot observe the deadline while the child is idle, so
//! the pipes are drained on dedicated threads whose results come back over
//! channels, and the caller polls `try_wait` against the deadline every
//! [`POLL`].

use std::collections::VecDeque;
use std::io::Read;
use std::process::{Child, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::supervisor::ProcessSupervisor;

const POLL: Duration = Duration::from_millis(25);

/// Why [`wait_for_exit`] gave up on the child (its tree is already killed).
#[derive(Debug, PartialEq, Eq)]
pub enum WaitError {
    /// The stdout reader passed its cap.
    Overflow,
    TimedOut,
    Failed(String),
}

/// Drain `pipe` on a thread. With `overflow`, at most `keep` bytes are kept
/// from the start; exceeding that raises the flag and stops reading (the
/// caller kills the child). Without it the last `keep` bytes are kept and the
/// rest is read and discarded so the writer never blocks on a full pipe.
pub fn spawn_drain(
    mut pipe: impl Read + Send + 'static,
    keep: usize,
    overflow: Option<Arc<AtomicBool>>,
) -> Result<Receiver<std::io::Result<Vec<u8>>>, String> {
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("child-drain".to_string())
        .spawn(move || {
            let mut buf: VecDeque<u8> = VecDeque::new();
            let mut chunk = [0u8; 8192];
            let result = loop {
                match pipe.read(&mut chunk) {
                    Ok(0) => break Ok(Vec::from(buf)),
                    Ok(n) => {
                        if let Some(flag) = &overflow {
                            if buf.len() + n > keep {
                                flag.store(true, Ordering::Relaxed);
                                break Ok(Vec::from(buf));
                            }
                            buf.extend(&chunk[..n]);
                        } else {
                            buf.extend(&chunk[..n]);
                            let excess = buf.len().saturating_sub(keep);
                            buf.drain(..excess);
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(e) => break Err(e),
                }
            };
            let _ = tx.send(result); // the receiver is gone after a timeout; nobody wants the bytes then
        })
        .map_err(|e| format!("could not start reader thread: {e}"))?;
    Ok(rx)
}

/// Poll until the child exits. Kills the process tree and errors on deadline
/// or when the stdout reader raises `overflow`.
pub fn wait_for_exit(
    child: &mut Child,
    supervisor: &ProcessSupervisor,
    overflow: &AtomicBool,
    deadline: Instant,
) -> Result<ExitStatus, WaitError> {
    loop {
        if overflow.load(Ordering::Relaxed) {
            terminate(supervisor, child);
            return Err(WaitError::Overflow);
        }
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() >= deadline => {
                terminate(supervisor, child);
                return Err(WaitError::TimedOut);
            }
            Ok(None) => std::thread::sleep(POLL),
            Err(e) => {
                terminate(supervisor, child);
                return Err(WaitError::Failed(format!("wait failed: {e}")));
            }
        }
    }
}

/// Result of a drain thread, or `None` if it has not finished by `deadline`.
pub fn recv_until(
    rx: &Receiver<std::io::Result<Vec<u8>>>,
    deadline: Instant,
) -> Option<std::io::Result<Vec<u8>>> {
    rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .ok()
}

/// Kill the child's process tree, then reap the direct child. The direct
/// `kill` is the fallback for a Windows run whose Job Object could not be
/// attached (`kill_tree` is then a no-op); on a dead process it is harmless.
pub fn terminate(supervisor: &ProcessSupervisor, child: &mut Child) {
    supervisor.kill_tree();
    let _ = child.kill();
    let _ = child.wait(); // reap; nothing useful to do on failure
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capped_drain_keeps_the_head_and_raises_the_flag() {
        let flag = Arc::new(AtomicBool::new(false));
        let rx = spawn_drain(
            std::io::Cursor::new(vec![b'a'; 100]),
            10,
            Some(Arc::clone(&flag)),
        )
        .expect("thread");
        let got = rx.recv().expect("result").expect("read");
        assert!(flag.load(Ordering::Relaxed));
        assert!(got.len() <= 10, "{}", got.len());
    }

    #[test]
    fn capped_drain_accepts_exactly_the_cap() {
        let flag = Arc::new(AtomicBool::new(false));
        let rx = spawn_drain(
            std::io::Cursor::new(vec![b'a'; 10]),
            10,
            Some(Arc::clone(&flag)),
        )
        .expect("thread");
        assert_eq!(rx.recv().expect("result").expect("read").len(), 10);
        assert!(!flag.load(Ordering::Relaxed));
    }

    #[test]
    fn rolling_drain_keeps_the_tail() {
        let mut input = vec![b'a'; 20_000];
        input.extend_from_slice(b"END");
        let rx = spawn_drain(std::io::Cursor::new(input), 5, None).expect("thread");
        assert_eq!(rx.recv().expect("result").expect("read"), b"aaEND");
    }
}
