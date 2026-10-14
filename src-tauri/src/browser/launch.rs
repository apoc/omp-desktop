//! Starting and stopping the headless Chromium the browser panel drives.

use std::ffi::OsString;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use crate::agent::supervisor::ProcessSupervisor;
use crate::child_path::apply_child_path;

/// How long a fresh Chromium gets to publish its debugging port.
pub const LAUNCH_TIMEOUT: Duration = Duration::from_secs(10);

const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// A headless Chromium owned by the app, with its own throwaway profile.
/// Killed as a whole process tree on [`stop`](Self::stop) or when dropped.
pub struct Chromium {
    child: Mutex<Option<Child>>,
    supervisor: ProcessSupervisor,
    port: u16,
    profile: PathBuf,
    pid_file: PathBuf,
}

impl Chromium {
    /// Launch `binary` headless on a free debugging port, using `profile` as
    /// its user-data dir, and wait up to [`LAUNCH_TIMEOUT`] for the port.
    pub fn start(binary: &Path, profile: &Path, width: u32, height: u32) -> Result<Self, String> {
        // A stale port file from an earlier run would be read as this launch's.
        let _ = std::fs::remove_file(profile.join(PORT_FILE));

        let mut user_data_dir = OsString::from("--user-data-dir=");
        user_data_dir.push(profile);
        let mut cmd = Command::new(binary);
        cmd.arg("--headless=new")
            .arg("--remote-debugging-port=0")
            .arg(user_data_dir)
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--disable-background-networking")
            .arg(format!("--window-size={width},{height}"))
            // Throwaway profile: never touch the OS keychain / keyring
            // (macOS would prompt for "Chromium Safe Storage" on every launch).
            .arg("--use-mock-keychain")
            .arg("--password-store=basic")
            .arg("about:blank")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        apply_child_path(&mut cmd);
        ProcessSupervisor::prepare(&mut cmd);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("chromium did not start: {}: {e}", binary.display()))?;
        let supervisor = ProcessSupervisor::attach(&child);
        let mut pid_path = profile.as_os_str().to_os_string();
        pid_path.push(".pid");
        let pid_file = PathBuf::from(pid_path);
        let recorded = write_pid(&pid_file, child.id());
        let owns_pid_file = recorded.is_ok();

        match recorded
            .map_err(|e| format!("pid file: {e}"))
            .and_then(|()| wait_for_port(&mut child, profile))
        {
            Ok(port) => Ok(Self {
                child: Mutex::new(Some(child)),
                supervisor,
                port,
                profile: profile.to_path_buf(),
                pid_file,
            }),
            Err(reason) => {
                supervisor.kill_tree();
                let _ = child.kill();
                let _ = child.wait();
                if owns_pid_file {
                    let _ = std::fs::remove_file(&pid_file);
                }
                let _ = std::fs::remove_dir_all(profile);
                Err(format!("chromium did not start: {reason}"))
            }
        }
    }

    /// The remote-debugging port Chromium listens on (`127.0.0.1`).
    pub const fn port(&self) -> u16 {
        self.port
    }

    /// Whether the Chromium process is still running.
    pub fn is_alive(&self) -> bool {
        self.child_guard()
            .as_mut()
            .is_some_and(|child| matches!(child.try_wait(), Ok(None)))
    }

    /// Kill the process tree, reap it and remove the profile. Safe to call
    /// again, also concurrently: the lock is held until the profile is gone,
    /// so only the first caller does the work and later callers return once
    /// it is finished.
    pub fn stop(&self) {
        let mut guard = self.child_guard();
        if let Some(mut child) = guard.take() {
            self.supervisor.kill_tree();
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&self.pid_file);
            let _ = std::fs::remove_dir_all(&self.profile);
        }
    }

    fn child_guard(&self) -> MutexGuard<'_, Option<Child>> {
        self.child.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Drop for Chromium {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Record ownership exclusively; never follow or overwrite a planted file.
fn write_pid(path: &Path, pid: u32) -> io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path)?;
    let written = writeln!(file, "{pid}");
    if written.is_err() {
        drop(file);
        let _ = std::fs::remove_file(path);
    }
    written
}

/// File Chromium writes into the user-data dir once the debugging port is up.
const PORT_FILE: &str = "DevToolsActivePort";

/// The debugging port from `<profile>/DevToolsActivePort`: its first line,
/// which only counts once the line is complete.
pub fn read_active_port(profile: &Path) -> Option<u16> {
    let content = std::fs::read_to_string(profile.join(PORT_FILE)).ok()?;
    let (first, _) = content.split_once('\n')?;
    first.trim().parse().ok().filter(|&port| port != 0)
}

/// Poll for the port file until it appears, `child` exits or the timeout hits.
fn wait_for_port(child: &mut Child, profile: &Path) -> Result<u16, String> {
    let deadline = Instant::now() + LAUNCH_TIMEOUT;
    loop {
        if let Some(port) = read_active_port(profile) {
            return Ok(port);
        }
        match child.try_wait() {
            Ok(Some(status)) => return Err(format!("exited early ({status})")),
            Ok(None) => {}
            Err(e) => return Err(format!("cannot poll process: {e}")),
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "no debugging port after {}s",
                LAUNCH_TIMEOUT.as_secs()
            ));
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

#[cfg(test)]
mod tests {
    use super::super::locate::find_chromium;
    use super::super::lock;
    use super::super::tests::CHROMIUM;
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpStream;

    fn tempdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omp-browser-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn home_dir() -> PathBuf {
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap()
    }

    /// Minimal HTTP/1.1 GET against `127.0.0.1:port`; returns the body.
    /// Chromium keeps the connection open despite `Connection: close`, so the
    /// body is read by its `Content-Length`, not to EOF.
    fn http_get(port: u16, path: &str) -> Option<String> {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
        stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
        let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        stream.write_all(req.as_bytes()).ok()?;
        let mut reader = BufReader::new(stream);
        let mut length = 0;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).ok()?;
            let line = line.trim();
            if line.is_empty() {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                if name.eq_ignore_ascii_case("content-length") {
                    length = value.trim().parse().ok()?;
                }
            }
        }
        let mut body = vec![0; length];
        reader.read_exact(&mut body).ok()?;
        String::from_utf8(body).ok()
    }

    #[test]
    fn active_port_is_read_from_the_first_line() {
        let dir = tempdir("port");
        std::fs::write(
            dir.join("DevToolsActivePort"),
            "51234\n/devtools/browser/abc\n",
        )
        .unwrap();
        assert_eq!(read_active_port(&dir), Some(51234));
        std::fs::write(dir.join("DevToolsActivePort"), "x\n").unwrap();
        assert_eq!(read_active_port(&dir), None);
    }

    #[cfg(unix)]
    #[test]
    fn pid_file_is_exclusive_and_never_follows_a_symlink() {
        let dir = tempdir("pid-exclusive");
        let path = dir.join("profile.pid");
        write_pid(&path, 1234).unwrap();
        assert!(write_pid(&path, 5678).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "1234\n");
        std::fs::remove_file(&path).unwrap();
        let victim = dir.join("victim");
        std::fs::write(&victim, "untouched").unwrap();
        std::os::unix::fs::symlink(&victim, &path).unwrap();
        assert!(write_pid(&path, 5678).is_err());
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "untouched");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Real Chromium; skipped (passes with a note) when none is found.
    #[test]
    fn start_and_stop_real_chromium() {
        let _chromium = lock(&CHROMIUM);
        let Some(bin) = find_chromium(None, &home_dir()) else {
            eprintln!("skip: no chromium");
            return;
        };
        let profile = tempdir("profile");
        let c = Chromium::start(&bin, &profile, 800, 600).expect("start");
        assert!(c.port() > 0);
        let body = http_get(c.port(), "/json/version").expect("version");
        assert!(body.contains("webSocketDebuggerUrl"), "{body}");
        c.stop();
        assert!(!c.is_alive());
        assert!(!profile.exists(), "profile removed");
        c.stop(); // idempotent
    }

    /// Whether any process still has `profile` on its command line.
    #[cfg(unix)]
    fn profile_in_use(profile: &Path) -> bool {
        std::process::Command::new("pgrep")
            .arg("-f")
            .arg(profile)
            .stdout(Stdio::null())
            .status()
            .expect("pgrep")
            .success()
    }

    /// Two simultaneous `stop`s: whichever returns first must find the
    /// browser process reaped (signal 0 still succeeds on a zombie) and the
    /// profile gone, not just have killed it.
    #[cfg(unix)]
    #[test]
    fn concurrent_stops_leave_no_profile_and_no_process() {
        let _chromium = lock(&CHROMIUM);
        let Some(bin) = find_chromium(None, &home_dir()) else {
            eprintln!("skip: no chromium");
            return;
        };
        // The race window is narrow: repeat to make a regression reliably red.
        for round in 0..5 {
            let profile = tempdir(&format!("profile-concurrent-{round}"));
            let c = Chromium::start(&bin, &profile, 800, 600).expect("start");
            let pid = libc::pid_t::try_from(c.child_guard().as_ref().expect("child").id()).unwrap();
            std::thread::scope(|s| {
                for _ in 0..2 {
                    s.spawn(|| {
                        c.stop();
                        // SAFETY: plain-integer FFI call; signal 0 only probes.
                        let exists = unsafe { libc::kill(pid, 0) == 0 };
                        assert!(!exists, "process not reaped when stop returns");
                        assert!(!profile.exists(), "profile removed when stop returns");
                    });
                }
            });
            assert!(!c.is_alive());
            assert!(!profile.exists(), "profile removed");
            // Helper processes can take a moment to vanish after the kill.
            let deadline = Instant::now() + Duration::from_secs(5);
            while profile_in_use(&profile) && Instant::now() < deadline {
                std::thread::sleep(POLL_INTERVAL);
            }
            assert!(
                !profile_in_use(&profile),
                "a process still uses the profile"
            );
        }
    }

    /// A binary that exits at once: `start` fails and cleans up after itself.
    #[cfg(unix)]
    #[test]
    fn failed_start_removes_the_profile_and_leaves_no_process() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir("fail-start");
        let bin = dir.join("fake-chromium");
        std::fs::write(&bin, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let profile = dir.join("profile");
        std::fs::create_dir_all(&profile).unwrap();
        let err = Chromium::start(&bin, &profile, 800, 600)
            .err()
            .expect("start fails");
        assert!(err.contains("exited early"), "{err}");
        assert!(!profile.exists(), "profile removed");
        assert!(!profile.with_extension("pid").exists(), "PID file removed");
        assert!(!profile_in_use(&profile), "no process remains");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
