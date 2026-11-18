//! Platform probes shared with the persona service: whether a path names an
//! executable file, and whether a pid is still alive.

use std::path::Path;

/// An absolute path to an executable file: what a program setting must be,
/// and what a PATH search takes.
///
/// Unix: one this user may execute, as `execvp` checks it, so an execute bit
/// only for others doesn't count. Windows: any file.
#[must_use]
pub fn is_executable_file(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        if !(path.is_absolute() && path.is_file()) {
            return false;
        }
        let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
            return false; // an interior NUL names no file
        };
        // SAFETY: `path` is a NUL-terminated string that outlives the call,
        // and `access` only reads it.
        unsafe { libc::access(path.as_ptr(), libc::X_OK) == 0 }
    }
    #[cfg(not(unix))]
    {
        path.is_absolute() && path.is_file()
    }
}

/// Whether the process identified by `pid` is still alive. Any inconclusive
/// outcome counts as "alive", so a lock or directory is never taken over on
/// a guess.
///
/// - **Unix:** signal 0 via `kill(2)` performs no action beyond an
///   existence/permission check; `ESRCH` means the process is gone, `EPERM`
///   means it exists but belongs to someone else (alive). Reaped zombies are
///   gone; unreaped ones still count as alive.
/// - **Windows:** `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` then
///   `GetExitCodeProcess`: alive while the exit code is `STILL_ACTIVE`. A
///   process that cannot be opened is gone only on `ERROR_INVALID_PARAMETER`
///   (no such pid); access denied (it exists, e.g. elevated) and any other
///   failure count as alive. A process that really exited with code 259
///   reads as alive, which errs on the safe side.
#[cfg(unix)]
#[must_use]
pub fn pid_is_alive(pid: u32) -> bool {
    // SAFETY: signal 0 sends no actual signal; it only validates that the
    // pid exists and is signalable by us. No memory is touched beyond what
    // `libc::kill`'s FFI signature requires.
    if unsafe { libc::kill(pid.cast_signed(), 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(windows)]
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, STILL_ACTIVE,
};

#[cfg(windows)]
#[must_use]
pub fn pid_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: plain-integer arguments; the returned handle is owned here and
    // closed below.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        // SAFETY: reads this thread's last-error value, no arguments.
        // Only "no such pid" means gone; anything else is inconclusive.
        return unsafe { GetLastError() } != ERROR_INVALID_PARAMETER;
    }
    let mut code = 0u32;
    // SAFETY: `process` is the valid handle opened above; `code` is a live
    // `u32` the call writes into.
    let queried = unsafe { GetExitCodeProcess(process, std::ptr::addr_of_mut!(code)) };
    // SAFETY: `process` was opened above and is closed exactly once.
    unsafe { CloseHandle(process) };
    queried == 0 || code == STILL_ACTIVE.cast_unsigned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_absolute_paths_to_executable_files_qualify() {
        let exe = std::env::current_exe().unwrap();
        assert!(is_executable_file(&exe));
        assert!(!is_executable_file(exe.parent().unwrap()), "a folder");
        assert!(!is_executable_file(Path::new("sh")), "relative");
        assert!(!is_executable_file(&exe.with_extension("missing")));
    }

    /// An execute bit for the group or others only: `execvp` would refuse
    /// it, so a PATH search must pass over it for the next folder. Not
    /// checkable as root, who may execute any file with an execute bit.
    #[cfg(unix)]
    #[test]
    fn an_execute_bit_for_others_only_does_not_qualify() {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::test_support::TempDir::new("program-setting", "others-exec");
        let probe = dir.path().join("unreadable");
        std::fs::write(&probe, "").unwrap();
        std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::File::open(&probe).is_ok() {
            return; // root: permission bits don't bind
        }
        let file = crate::test_support::executable(&dir.path().join("prog"), "");
        assert!(is_executable_file(&file));
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o611)).unwrap();
        assert!(!is_executable_file(&file));
    }
}

#[cfg(windows)]
#[cfg(test)]
mod windows_tests {
    use super::pid_is_alive;
    use std::process::Command;

    /// Our own pid opens and reports `STILL_ACTIVE`; a child that exited and
    /// was reaped (handle closed) is gone — `OpenProcess` reports no such pid.
    #[test]
    fn own_pid_is_alive_and_a_reaped_child_is_gone() {
        assert!(pid_is_alive(std::process::id()));

        let mut child = Command::new("cmd")
            .args(["/C", "exit"])
            .spawn()
            .expect("spawn cmd");
        let pid = child.id();
        child.wait().expect("wait for cmd");
        // Dropping the `Child` closes our handle, so the process object can
        // go away entirely.
        drop(child);
        assert!(
            !pid_is_alive(pid),
            "exited child {pid} still reads as alive"
        );
    }
}
