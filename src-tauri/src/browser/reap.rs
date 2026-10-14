//! Reap browsers left behind when a desktop instance missed graceful exit.

#[cfg(unix)]
use std::path::Path;

#[cfg(unix)]
use crate::agent::supervisor::pid_is_alive;

/// Return false if a verified browser could still recreate its profile.
#[cfg(unix)]
pub(super) fn before_pruning(instance: &Path) -> bool {
    let profiles = instance.join("profiles");
    match std::fs::symlink_metadata(&profiles) {
        Ok(meta) if meta.is_dir() => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return true,
        _ => return false,
    }
    let Ok(entries) = std::fs::read_dir(&profiles) else {
        return false;
    };
    let mut stopped = true;
    for entry in entries {
        let Ok(entry) = entry else {
            stopped = false;
            continue;
        };
        let path = entry.path();
        if path.extension().is_some_and(|extension| extension == "pid")
            && entry.file_type().is_ok_and(|kind| kind.is_file())
        {
            stopped &= reap_browser(&path);
        }
    }
    stopped
}

#[cfg(not(unix))]
pub(super) const fn before_pruning(_instance: &std::path::Path) -> bool {
    // Windows PID liveness conservatively prevents stale-instance pruning.
    true
}

#[cfg(unix)]
fn reap_browser(pid_file: &Path) -> bool {
    use std::time::{Duration, Instant};
    let Some(pid) = std::fs::read_to_string(pid_file)
        .ok()
        .and_then(|text| text.trim().parse::<u32>().ok())
        .filter(|pid| *pid > 0)
    else {
        return true;
    };
    let Ok(group) = libc::pid_t::try_from(pid) else {
        return true;
    };
    // SAFETY: getpgid takes a positive PID and does not modify the process.
    if !pid_is_alive(pid) || !is_group_leader(group, unsafe { libc::getpgid(group) }) {
        return true;
    }
    let profile = pid_file.with_extension("");
    if !uses_profile(pid, &profile) {
        return true;
    }
    // SAFETY: only a live group leader with the matching profile flag is targeted;
    // the negative, nonzero PID signals its own process group, not ours.
    if unsafe { libc::kill(-group, libc::SIGKILL) } != 0 {
        return !pid_is_alive(pid);
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while pid_is_alive(pid) {
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    true
}

#[cfg(unix)]
const fn is_group_leader(pid: libc::pid_t, group: libc::pid_t) -> bool {
    pid > 0 && pid == group
}

// Chromium rewrites Linux argv into a space-joined process title; macOS ps
// also renders argv as text. Both NUL and ASCII whitespace delimit flags.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn has_flag(cmdline: &[u8], flag: &[u8]) -> bool {
    let is_boundary = |byte: &u8| *byte == 0 || byte.is_ascii_whitespace();
    !flag.is_empty()
        && cmdline
            .windows(flag.len())
            .enumerate()
            .any(|(offset, bytes)| {
                bytes == flag
                    && (offset == 0 || is_boundary(&cmdline[offset - 1]))
                    && cmdline.get(offset + flag.len()).is_none_or(is_boundary)
            })
}

#[cfg(target_os = "linux")]
fn uses_profile(pid: u32, profile: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let mut flag = b"--user-data-dir=".to_vec();
    flag.extend_from_slice(profile.as_os_str().as_bytes());
    std::fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|command| has_flag(&command, &flag))
}

#[cfg(target_os = "macos")]
fn uses_profile(pid: u32, profile: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(output) = std::process::Command::new("/bin/ps")
        .args(["-o", "command=", "-p"])
        .arg(pid.to_string())
        .output()
    else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let mut flag = b"--user-data-dir=".to_vec();
    flag.extend_from_slice(profile.as_os_str().as_bytes());
    has_flag(&output.stdout, &flag)
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
const fn uses_profile(_pid: u32, _profile: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::has_flag;

    #[test]
    fn profile_flag_requires_nul_or_ascii_whitespace_boundaries() {
        let flag = b"--user-data-dir=/cache/profiles/s1-0";
        let cases: &[(&str, &[u8], bool)] = &[
            (
                "nul-separated",
                b"chromium\0--user-data-dir=/cache/profiles/s1-0\0--headless=new\0",
                true,
            ),
            (
                "rewritten linux title",
                b"chromium --user-data-dir=/cache/profiles/s1-0 --headless=new\0\0",
                true,
            ),
            ("offset zero", b"--user-data-dir=/cache/profiles/s1-0", true),
            (
                "trailing newline",
                b"chromium --user-data-dir=/cache/profiles/s1-0\n",
                true,
            ),
            (
                "numeric prefix collision",
                b"chromium\0--user-data-dir=/cache/profiles/s1-01\0",
                false,
            ),
            (
                "hyphen prefix collision",
                b"chromium --user-data-dir=/cache/profiles/s1-0-other",
                false,
            ),
            (
                "space boundary suffix",
                b"chromium --user-data-dir=/cache/profiles/s1-0 x",
                true,
            ),
            (
                "embedded flag",
                b"chromium x--user-data-dir=/cache/profiles/s1-0",
                false,
            ),
            (
                "tab and CR/LF boundaries",
                b"\t--user-data-dir=/cache/profiles/s1-0\r\n",
                true,
            ),
            (
                "non-ascii whitespace",
                b"\xc2\xa0--user-data-dir=/cache/profiles/s1-0\xc2\xa0",
                false,
            ),
            (
                "later bounded occurrence",
                b"x--user-data-dir=/cache/profiles/s1-0 --user-data-dir=/cache/profiles/s1-0",
                true,
            ),
            ("no match", b"chromium --headless=new", false),
            ("empty command", b"", false),
        ];
        for &(name, cmdline, expected) in cases {
            assert_eq!(has_flag(cmdline, flag), expected, "{name}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn only_positive_pids_leading_their_own_group_are_eligible() {
        for (pid, group, expected) in [
            (42, 42, true),
            (42, 41, false),
            (42, -1, false),
            (0, 0, false),
            (-1, -1, false),
        ] {
            assert_eq!(
                super::is_group_leader(pid, group),
                expected,
                "pid={pid}, group={group}"
            );
        }
    }
}
