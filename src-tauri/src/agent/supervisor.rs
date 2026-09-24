//! Process-tree supervision.
//!
//! `Child::kill` only signals the direct child process. omp forks subagents
//! and shells out to tools (bash, etc.); killing just the top-level `omp`
//! process leaves those descendants running, reparented to init/orphaned —
//! a stopped or crashed session can leak an unbounded number of live
//! processes. Two platform primitives close that gap:
//!
//! - **Unix**: the child is made the leader of its own process group
//!   (`process_group(0)`, stable since Rust 1.64) *before* spawn, and
//!   `SIGKILL` is sent to the whole group (`kill(-pgid, SIGKILL)`) on
//!   teardown — every descendant that hasn't changed its own group dies
//!   with it.
//! - **Windows**: the child is assigned to a Job Object configured with
//!   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` *after* spawn. Closing the last
//!   handle to that job (whether via an explicit call or `Drop`) kills
//!   every process ever assigned to it, including grandchildren spawned
//!   after assignment.
//!
//! Usage: call [`ProcessSupervisor::prepare`] on the `Command` before
//! `.spawn()`, then [`ProcessSupervisor::attach`] on the resulting `Child`
//! after `.spawn()`. Dropping the returned supervisor — or calling
//! [`ProcessSupervisor::kill_tree`] explicitly — kills the whole tree.
//! Both steps store only a pid or a raw job handle in an atomic, so
//! `ProcessSupervisor` is `Send` with no unsafe impl required.

#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::process::{Child, Command};
#[cfg(unix)]
use std::sync::atomic::AtomicI32;
#[cfg(windows)]
use std::sync::atomic::AtomicPtr;
use std::sync::atomic::Ordering;

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_BASIC_LIMIT_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

/// Guarantees the process tree rooted at a spawned child is killed as a
/// whole, either explicitly via [`kill_tree`](Self::kill_tree) or
/// implicitly on `Drop`.
///
/// Holds a Win32 job handle on Windows, or a process-group id on Unix —
/// each in an atomic that is `Send + Sync` on its own, so no
/// `unsafe impl Send` is needed.
#[cfg(windows)]
pub(super) struct ProcessSupervisor {
    /// Job object handle, or null once closed (including if creation or
    /// setup failed, in which case there was never anything to close).
    job: AtomicPtr<core::ffi::c_void>,
}

#[cfg(unix)]
pub(super) struct ProcessSupervisor {
    /// Process-group id — equal to the child's own pid, since `prepare`
    /// makes it the group leader — or `0` once the tree has been killed.
    pgid: AtomicI32,
}

impl ProcessSupervisor {
    /// Configure `cmd` *before* `.spawn()` is called.
    ///
    /// Unix needs this pre-spawn hook to install the child as the leader
    /// of a brand new process group, so descendants that never call
    /// `setpgid` themselves stay in it. Windows attaches supervision
    /// post-spawn instead (a job object needs a live process handle), so
    /// this is a no-op there.
    #[cfg(unix)]
    pub(super) fn prepare(cmd: &mut Command) {
        cmd.process_group(0);
    }

    /// Windows counterpart of the Unix `prepare` — no pre-spawn setup is
    /// needed, since job-object assignment happens after `.spawn()`.
    #[cfg(windows)]
    pub(super) fn prepare(_cmd: &mut Command) {}

    /// Attach supervision to a just-spawned child. Must be called *after*
    /// `.spawn()`.
    #[cfg(unix)]
    pub(super) fn attach(child: &Child) -> Self {
        // `prepare` already called `process_group(0)`, so the child's own
        // pid doubles as the process-group id. `try_from` avoids an `as`
        // truncation lint; a pid that somehow doesn't fit `i32` becomes the
        // `0` sentinel, which just means "nothing to supervise" rather than
        // a panic.
        let pgid = i32::try_from(child.id()).unwrap_or(0);
        Self {
            pgid: AtomicI32::new(pgid),
        }
    }

    /// Attach supervision to a just-spawned child by creating a Job Object,
    /// configuring it to kill everything assigned to it once its last
    /// handle closes, and assigning the child to it.
    #[cfg(windows)]
    pub(super) fn attach(child: &Child) -> Self {
        // SAFETY: null security attributes and a null (anonymous) name is
        // the documented way to create an unnamed job object usable only
        // through the returned handle, which this call exclusively owns
        // from here on (closed below on any setup failure, otherwise by
        // `kill_tree`/`Drop`).
        let job: HANDLE = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            // Job object creation failed (e.g. handle-table exhaustion).
            // Fall back to no supervision rather than panicking — omp
            // itself still runs, it just won't get tree-kill semantics.
            return Self::unsupervised();
        }

        // Every other field defaulted (all-zero) means "no other limits".
        let info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION {
                LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                ..Default::default()
            },
            ..Default::default()
        };
        // SAFETY: `job` is the handle just created above; `info` is a
        // correctly sized `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` (defaulted,
        // with its one relevant field set), matching what
        // `SetInformationJobObject` expects for `JobObjectExtendedLimitInformation`.
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(info).cast(),
                u32::try_from(std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
                    .unwrap_or_default(),
            )
        };
        if configured == 0 {
            // SAFETY: `job` was created by this function and has not been
            // assigned to anything or closed yet — sole owner.
            unsafe { CloseHandle(job) };
            return Self::unsupervised();
        }

        // SAFETY: `job` is a valid, configured job handle; the process
        // handle is the live handle of the `Child` passed in, which
        // outlives this call.
        let assigned = unsafe { AssignProcessToJobObject(job, child.as_raw_handle()) };
        if assigned == 0 {
            // SAFETY: same reasoning as the `configured == 0` branch above.
            unsafe { CloseHandle(job) };
            return Self::unsupervised();
        }

        Self {
            job: AtomicPtr::new(job),
        }
    }

    /// A supervisor with nothing to close — the fallback when job-object
    /// setup fails.
    #[cfg(windows)]
    const fn unsupervised() -> Self {
        Self {
            job: AtomicPtr::new(std::ptr::null_mut()),
        }
    }

    /// Kill the whole supervised process tree right now.
    ///
    /// Idempotent: the atomic swap to the empty sentinel (`0` pgid on Unix,
    /// a null job handle on Windows) means only the first caller (be
    /// it an explicit `kill_tree()` or the subsequent `Drop`) actually
    /// closes/signals anything — a second call is a documented no-op
    /// rather than a double-close (Windows) or a harmless-but-wasteful
    /// re-signal (Unix).
    #[cfg(unix)]
    pub(super) fn kill_tree(&self) {
        let pgid = self.pgid.swap(0, Ordering::AcqRel);
        if pgid != 0 {
            // SAFETY: plain-integer FFI call, no pointers involved.
            // Signalling `-pgid` targets every process in the group
            // `prepare`/`attach` set up, not just the leader. A failure
            // (`ESRCH` because everything already exited) isn't
            // actionable here and is deliberately not surfaced.
            unsafe {
                libc::kill(-pgid, libc::SIGKILL);
            }
        }
    }

    /// Kill the whole supervised process tree right now (Windows: close
    /// the job handle, which triggers `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`).
    /// See the Unix doc comment above for the idempotency guarantee.
    #[cfg(windows)]
    pub(super) fn kill_tree(&self) {
        let job = self.job.swap(std::ptr::null_mut(), Ordering::AcqRel);
        if !job.is_null() {
            // SAFETY: `job` was produced by a successful `attach` and has
            // not been closed before — the swap above guarantees exactly
            // one caller ever observes the non-null value. Closing the
            // last handle to a job object carrying
            // `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` terminates every
            // process ever assigned to it.
            unsafe {
                CloseHandle(job);
            }
        }
    }
}

impl Drop for ProcessSupervisor {
    fn drop(&mut self) {
        self.kill_tree();
    }
}

#[cfg(unix)]
#[cfg(test)]
mod tests {
    use super::ProcessSupervisor;
    use std::process::Command;
    use std::time::{Duration, Instant};

    /// Poll `condition` every 20ms up to `timeout`, returning `true` as
    /// soon as it holds. Avoids "sleep and hope" flakiness in the tests
    /// below, which race against process teardown.
    fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if condition() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// True while process `pid` still exists and is signal-reachable from
    /// this process. Uses `kill(pid, 0)` — the POSIX null-signal existence
    /// probe: it performs the usual permission checks and returns `0` if
    /// the process exists, without actually delivering a signal to it.
    /// Portable across every Unix target this crate supports; a
    /// `/proc/<pid>` existence check only works on Linux and always
    /// returns `false` on macOS, which silently broke this test there.
    /// Reaped zombies still respond to signal 0, but for this test the
    /// distinction doesn't matter: we only care that the descendant was
    /// actually torn down, not lingering as a runnable process.
    fn process_alive(pid: u32) -> bool {
        let pid = libc::pid_t::try_from(pid).unwrap_or(0);
        // SAFETY: plain-integer FFI call. Signal `0` never actually
        // signals the target; it only probes existence/permission.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// Spawn `sh -c 'sleep 30 & sleep 30 & wait'`, returning the shell's
    /// `Child` plus the two grandchild `sleep` pids (read back via
    /// `pgrep -P <shell_pid>` once they've had a moment to start).
    fn spawn_with_grandchildren(prepare: bool) -> (std::process::Child, Vec<u32>) {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg("sleep 30 & sleep 30 & wait");
        if prepare {
            ProcessSupervisor::prepare(&mut cmd);
        }
        let child = cmd.spawn().expect("spawn sh");

        // Give the grandchildren a moment to actually start before we look
        // for them.
        let shell_pid = child.id();
        let mut grandchildren = Vec::new();
        wait_until(Duration::from_secs(2), || {
            let out = Command::new("pgrep")
                .arg("-P")
                .arg(shell_pid.to_string())
                .output();
            if let Ok(out) = out {
                let text = String::from_utf8_lossy(&out.stdout);
                grandchildren = text
                    .lines()
                    .filter_map(|line| line.trim().parse::<u32>().ok())
                    .collect();
            }
            grandchildren.len() >= 2
        });

        (child, grandchildren)
    }

    /// The fix under test: `prepare` + `attach` + `kill_tree` takes down
    /// the shell *and* both `sleep` grandchildren.
    #[test]
    fn kill_tree_kills_grandchildren() {
        let (mut child, grandchildren) = spawn_with_grandchildren(true);
        assert_eq!(grandchildren.len(), 2, "expected two sleep grandchildren");
        assert!(grandchildren.iter().all(|&pid| process_alive(pid)));

        let supervisor = ProcessSupervisor::attach(&child);
        supervisor.kill_tree();

        let all_gone = wait_until(Duration::from_secs(2), || {
            grandchildren.iter().all(|&pid| !process_alive(pid))
        });
        assert!(
            all_gone,
            "grandchildren survived kill_tree: {grandchildren:?}"
        );

        // The shell itself is also dead; reap it so the test doesn't leak
        // a zombie into the test process's own child list.
        let _ = child.kill();
        let _ = child.wait();
    }

    /// Demonstrates the bug being fixed: killing only the direct child via
    /// the bare `std::process::Child::kill` API (no supervisor involved at
    /// all — no `prepare`, no process group) leaves the `sleep`
    /// grandchildren running as orphans. This intentionally reproduces the
    /// pre-fix behaviour; it is not flaky test pollution, it is the
    /// baseline `kill_tree_kills_grandchildren` is contrasted against.
    #[test]
    fn bare_child_kill_leaves_grandchildren_alive() {
        let (mut child, grandchildren) = spawn_with_grandchildren(false);
        assert_eq!(grandchildren.len(), 2, "expected two sleep grandchildren");

        // No supervisor: kill only the direct child, exactly like the old
        // (buggy) `stop_session` behaviour.
        child.kill().expect("kill direct child");
        let _ = child.wait();

        // Give the OS a moment to actually reap the shell, then confirm
        // the orphaned grandchildren are still alive — proving the bug.
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            grandchildren.iter().all(|&pid| process_alive(pid)),
            "grandchildren unexpectedly died without tree supervision: {grandchildren:?}"
        );

        // Clean up: kill the orphans directly by pid so this test doesn't
        // leak `sleep 30` processes into the rest of the suite run.
        for pid in grandchildren {
            // `kill(0, …)` would hit this test's own process group, so an
            // unconvertible pid must fail the test, never fall back to 0.
            let pid = libc::pid_t::try_from(pid).expect("pid from pgrep fits pid_t");
            // SAFETY: plain-integer FFI call, no pointers involved. `pid`
            // is one of this test's own grandchildren (read via `pgrep -P`).
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
    }

    /// `kill_tree` is idempotent: calling it twice (explicitly, then via
    /// `Drop`) must not panic or misbehave, even though the underlying
    /// resource is only ever signalled/closed once.
    #[test]
    fn kill_tree_is_idempotent() {
        let (mut child, grandchildren) = spawn_with_grandchildren(true);
        let supervisor = ProcessSupervisor::attach(&child);

        supervisor.kill_tree();
        supervisor.kill_tree(); // second call must be a harmless no-op

        let all_gone = wait_until(Duration::from_secs(2), || {
            grandchildren.iter().all(|&pid| !process_alive(pid))
        });
        assert!(all_gone);

        drop(supervisor); // third "kill" via Drop — also must be a no-op

        let _ = child.kill();
        let _ = child.wait();
    }
}
