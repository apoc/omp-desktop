//! Starting and stopping the headless Chromium the browser panel drives.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::instance::{create_private_file, remove_dir_retrying};
use super::pipe::attach;
use super::stderr::StderrTail;
use crate::browser::broker::Broker;
use crate::browser::lock;
use crate::child_path::apply_child_path;
use crate::supervisor::ProcessSupervisor;

/// How long a fresh Chromium gets to answer on its debugging pipe.
pub const LAUNCH_TIMEOUT: Duration = Duration::from_secs(10);

const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// How long a browser whose pipe failed at start gets to show it exited.
const EXIT_GRACE: Duration = Duration::from_secs(1);

/// Most binaries one launch tries: a broken install falls back to the next
/// browser, but a machine where none starts must not wait on all of them.
const MAX_ATTEMPTS: usize = 3;

/// A headless Chromium owned by the app, with its own throwaway profile.
/// Killed as a whole process tree on [`stop`](Self::stop) or when dropped.
pub struct Chromium {
    child: Mutex<Option<Child>>,
    supervisor: ProcessSupervisor,
    /// The CDP connection over the browser's debugging pipe.
    broker: Arc<Broker>,
    profile: PathBuf,
    pid_file: PathBuf,
}

/// Why one binary did not start, and whether the next one may.
enum Failure {
    /// The binary could not run here (missing, refused, exited early):
    /// another browser may.
    Binary(String),
    /// Not the binary's fault (our pid file, a hung start): stop trying.
    Fatal(String),
}

impl Chromium {
    /// Start the first of `binaries` (at most [`MAX_ATTEMPTS`]) that comes
    /// up, each in a fresh profile from `next_profile`. A binary that cannot
    /// be started, or exits or closes its debugging pipe before answering
    /// on it, makes way for the next; the error lists every attempt with
    /// the end of its stderr.
    pub fn launch(
        binaries: &[PathBuf],
        mut next_profile: impl FnMut() -> PathBuf,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        let mut failures = Vec::new();
        for binary in binaries.iter().take(MAX_ATTEMPTS) {
            match Self::start(binary, &next_profile(), width, height) {
                Ok(chromium) => {
                    if !failures.is_empty() {
                        eprintln!(
                            "[omp-desktop] browser: started {} after: {}",
                            binary.display(),
                            failures.join("; ")
                        );
                    }
                    return Ok(chromium);
                }
                Err(Failure::Binary(reason)) => {
                    failures.push(format!("{}: {reason}", binary.display()));
                }
                Err(Failure::Fatal(reason)) => {
                    failures.push(format!("{}: {reason}", binary.display()));
                    break;
                }
            }
        }
        if failures.is_empty() {
            return Err("chromium did not start: no browser to launch".into());
        }
        Err(format!("chromium did not start: {}", failures.join("; ")))
    }

    /// Launch `binary` headless with a CDP pipe, using `profile` as its
    /// user-data dir, and wait up to [`LAUNCH_TIMEOUT`] for it to answer.
    fn start(binary: &Path, profile: &Path, width: u32, height: u32) -> Result<Self, Failure> {
        let mut cmd = command(binary, profile, width, height);
        let pipes = attach(&mut cmd).map_err(|e| Failure::Fatal(format!("cdp pipe: {e}")))?;
        apply_child_path(&mut cmd);
        ProcessSupervisor::prepare(&mut cmd);
        let (mut child, from_chromium, to_chromium) = pipes
            .spawn(&mut cmd)
            .map_err(|e| Failure::Binary(format!("cannot run: {e}")))?;
        let supervisor = ProcessSupervisor::attach(&child);
        let mut pid_path = profile.as_os_str().to_os_string();
        pid_path.push(".pid");
        let pid_file = PathBuf::from(pid_path);
        let recorded = create_private_file(&pid_file, format!("{}\n", child.id()).as_bytes());
        let owns_pid_file = recorded.is_ok();
        let broker = recorded
            .map_err(|e| Failure::Fatal(format!("pid file: {e}")))
            .and_then(|()| {
                Broker::start(from_chromium, to_chromium)
                    .map_err(|e| Failure::Fatal(format!("cdp pipe reader: {e}")))
            });
        // The end of Chromium's stderr closes the broker: the process tree
        // is gone even if the pipe never reports its end (a process started
        // outside the spawn gate could hold a copy of Chromium's ends; std
        // makes a child's stdio ends inheritable only within its own spawn,
        // under its own lock, so no other std spawn holds stderr). Weak: the
        // drain thread must not keep the connection alive.
        let watched = broker.as_ref().ok().map(Arc::downgrade);
        let stderr = child.stderr.take().map(|stderr| {
            StderrTail::drain(stderr, move || {
                if let Some(broker) = watched.as_ref().and_then(Weak::upgrade) {
                    broker.close();
                }
            })
        });

        let started = broker.and_then(|broker| match wait_for_browser(&mut child, &broker) {
            Ok(()) => Ok(broker),
            Err(failure) => {
                broker.close();
                Err(failure)
            }
        });
        match started {
            Ok(broker) => Ok(Self {
                child: Mutex::new(Some(child)),
                supervisor,
                broker,
                profile: profile.to_path_buf(),
                pid_file,
            }),
            Err(failure) => {
                supervisor.kill_tree();
                let _ = child.kill();
                let _ = child.wait();
                if owns_pid_file {
                    let _ = std::fs::remove_file(&pid_file);
                }
                let _ = remove_dir_retrying(profile);
                let said = stderr.and_then(StderrTail::settle);
                let with_stderr = |reason: String| match &said {
                    Some(said) => format!("{reason}: {said}"),
                    None => reason,
                };
                Err(match failure {
                    Failure::Binary(reason) => Failure::Binary(with_stderr(reason)),
                    Failure::Fatal(reason) => Failure::Fatal(with_stderr(reason)),
                })
            }
        }
    }

    /// The CDP connection to this browser.
    pub const fn broker(&self) -> &Arc<Broker> {
        &self.broker
    }

    /// Whether the Chromium process is still running and its pipe works.
    pub fn is_alive(&self) -> bool {
        self.broker.is_alive()
            && lock(&self.child)
                .as_mut()
                .is_some_and(|child| matches!(child.try_wait(), Ok(None)))
    }

    /// Kill the process tree, reap it and remove the profile (retrying on
    /// Windows while the dying helpers still hold files). Safe to call
    /// again, also concurrently: the lock is held until the profile is gone,
    /// so only the first caller does the work and later callers return once
    /// it is finished.
    pub fn stop(&self) {
        let mut guard = lock(&self.child);
        if let Some(mut child) = guard.take() {
            self.broker.close();
            self.supervisor.kill_tree();
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&self.pid_file);
            let _ = remove_dir_retrying(&self.profile);
        }
    }

    /// The browser process's pid while it runs.
    #[cfg(all(test, unix))]
    fn pid_for_test(&self) -> Option<u32> {
        lock(&self.child).as_ref().map(Child::id)
    }
}

impl Drop for Chromium {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The command starting `binary` with the panel's flags and environment.
fn command(binary: &Path, profile: &Path, width: u32, height: u32) -> Command {
    let mut user_data_dir = OsString::from("--user-data-dir=");
    user_data_dir.push(profile);
    let mut cmd = Command::new(binary);
    cmd.arg("--headless=new")
        // Own the first page instead of racing Chromium's automatic startup page.
        .arg("--no-startup-window")
        // The CDP pipe itself (`pipe.rs`) is added by `attach`: no port.
        .arg(user_data_dir)
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-background-networking")
        // A throwaway browser: no extension, not even one a launcher's
        // flag file or a managed policy adds.
        .arg("--disable-extensions")
        // A page restored from the back/forward cache keeps its isolated
        // world (the annotate overlay's state) without a new context.
        // Chromium honours only the last `--disable-features`: one flag.
        .arg("--disable-features=BackForwardCache")
        .arg(format!("--window-size={width},{height}"))
        // Throwaway profile: never touch the OS keychain / keyring
        // (macOS would prompt for "Chromium Safe Storage" on every launch).
        .arg("--use-mock-keychain")
        .arg("--password-store=basic")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if is_script(binary) {
        // Distro launchers (scripts, the last-resort candidates) add the
        // user's own flags from `$XDG_CONFIG_HOME/*-flags.conf` and these
        // variables; point the one at an empty private folder, drop the
        // others. A real binary reads neither and keeps the user's config
        // folder (fontconfig, dconf proxy settings).
        cmd.env("XDG_CONFIG_HOME", profile.join("xdg-config"))
            .env_remove("CHROME_USER_FLAGS")
            .env_remove("CHROMIUM_FLAGS");
    }
    cmd
}

/// Whether `path` is a `#!` script (a distro launcher), not a binary.
fn is_script(path: &Path) -> bool {
    let mut head = [0u8; 2];
    std::fs::File::open(path)
        .and_then(|mut file| std::io::Read::read_exact(&mut file, &mut head))
        .is_ok_and(|()| head == *b"#!")
}

/// Wait for CDP and create the initial page before exposing the broker.
fn wait_for_browser(child: &mut Child, broker: &Broker) -> Result<(), Failure> {
    let deadline = Instant::now() + LAUNCH_TIMEOUT;
    wait_for_reply(child, broker, "Browser.getVersion", json!({}), deadline)?;
    wait_for_reply(
        child,
        broker,
        "Target.createTarget",
        json!({ "url": "about:blank" }),
        deadline,
    )
}

/// Both startup requests share the same deadline and failure cleanup.
fn wait_for_reply(
    child: &mut Child,
    broker: &Broker,
    method: &str,
    params: Value,
    deadline: Instant,
) -> Result<(), Failure> {
    let reply = broker
        .request(method, params)
        .map_err(|e| pipe_failed(child, &e))?;
    loop {
        match reply.wait(POLL_INTERVAL) {
            Some(Ok(_)) => return Ok(()),
            Some(Err(e)) if broker.is_alive() => {
                return Err(Failure::Binary(format!("{method}: {e}")));
            }
            // The connection ended: every later wait would return at once.
            Some(Err(_)) => return Err(pipe_failed(child, "closed its debugging pipe")),
            None => {}
        }
        match child.try_wait() {
            Ok(Some(status)) => return Err(Failure::Binary(format!("exited early ({status})"))),
            Ok(None) => {}
            Err(e) => return Err(Failure::Fatal(format!("cannot poll process: {e}"))),
        }
        if Instant::now() >= deadline {
            return Err(Failure::Fatal(format!(
                "no answer on the debugging pipe after {}s",
                LAUNCH_TIMEOUT.as_secs()
            )));
        }
    }
}

/// The pipe failed at start: usually because the browser is exiting, which
/// says more, so give it up to [`EXIT_GRACE`] to show that; else `reason`.
fn pipe_failed(child: &mut Child, reason: &str) -> Failure {
    let deadline = Instant::now() + EXIT_GRACE;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Failure::Binary(format!("exited early ({status})")),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Ok(None) => return Failure::Binary(reason.into()),
            Err(e) => return Failure::Fatal(format!("cannot poll process: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::tests::{chromium_or_skip, tempdir, CHROMIUM};
    #[cfg(unix)]
    use crate::supervisor::pid_is_alive;

    /// A fresh profile path per call under `dir`: `profile-0`, `profile-1`, …
    fn profiles(dir: &Path) -> impl FnMut() -> PathBuf + '_ {
        let mut n = 0;
        move || {
            n += 1;
            dir.join(format!("profile-{}", n - 1))
        }
    }

    /// Real Chromium; skipped (passes with a note) when none is found. It
    /// answers on the pipe and opens no debugging port: no
    /// `DevToolsActivePort` file, which Chromium writes for a port only.
    #[test]
    fn start_and_stop_real_chromium() {
        let _chromium = lock(&CHROMIUM);
        let Some(bin) = chromium_or_skip("start_and_stop_real_chromium") else {
            return;
        };
        let dir = tempdir("launch-real");
        let c = Chromium::launch(&[bin], profiles(&dir), 800, 600).expect("start");
        let version = c
            .broker()
            .call("Browser.getVersion", json!({}), LAUNCH_TIMEOUT)
            .expect("version");
        assert!(version["product"].as_str().is_some(), "{version}");
        assert!(c.is_alive());
        assert!(
            !dir.join("profile-0/DevToolsActivePort").exists(),
            "no debugging port"
        );
        c.stop();
        assert!(!c.is_alive());
        assert!(!c.broker().is_alive());
        assert!(!dir.join("profile-0").exists(), "profile removed");
        c.stop(); // idempotent
    }

    /// Whether any process still has `profile` on its command line.
    #[cfg(unix)]
    fn profile_in_use(profile: &Path) -> bool {
        Command::new("pgrep")
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
        let Some(bin) = chromium_or_skip("concurrent_stops_leave_no_profile_and_no_process") else {
            return;
        };
        // The race window is narrow: repeat to make a regression reliably red.
        for round in 0..5 {
            let dir = tempdir(&format!("launch-concurrent-{round}"));
            let profile = dir.join("profile-0");
            let c = Chromium::launch(std::slice::from_ref(&bin), profiles(&dir), 800, 600)
                .expect("start");
            let pid = c.pid_for_test().expect("running");
            std::thread::scope(|s| {
                for _ in 0..2 {
                    s.spawn(|| {
                        c.stop();
                        assert!(!pid_is_alive(pid), "process not reaped when stop returns");
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

    /// A stand-in browser at `dir/name` running `body` (unix shell).
    #[cfg(unix)]
    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        crate::test_support::executable(&dir.join(name), &format!("#!/bin/sh\n{body}\n"))
    }

    /// Every binary exits at once: `launch` fails, cleans up after each, and
    /// says what each one printed.
    #[cfg(unix)]
    #[test]
    fn a_failed_launch_cleans_up_and_reports_each_binarys_stderr() {
        let dir = tempdir("launch-fail");
        let first = script(&dir, "first", "echo 'No usable sandbox!' >&2\nexit 1");
        let second = script(
            &dir,
            "second",
            "echo 'libnss3.so: cannot open' >&2\nexit 127",
        );
        let err = Chromium::launch(&[first.clone(), second.clone()], profiles(&dir), 800, 600)
            .err()
            .expect("start fails");
        assert!(
            err.contains(&format!("{}: exited early", first.display())),
            "{err}"
        );
        assert!(err.contains("No usable sandbox!"), "{err}");
        assert!(
            err.contains(&format!("{}: exited early", second.display())),
            "{err}"
        );
        assert!(err.contains("libnss3.so: cannot open"), "{err}");
        for n in 0..2 {
            let profile = dir.join(format!("profile-{n}"));
            assert!(!profile.exists(), "profile removed");
            assert!(!profile.with_extension("pid").exists(), "PID file removed");
            assert!(!profile_in_use(&profile), "no process remains");
        }
    }

    /// A browser that dies at start (Chrome for Testing on Ubuntu 23.10+,
    /// no sandbox) makes way for the next candidate; a missing one too.
    #[cfg(unix)]
    #[test]
    fn launch_falls_back_to_the_next_binary() {
        let dir = tempdir("launch-fallback");
        let dies = script(&dir, "dies", "exit 1");
        let missing = dir.join("missing");
        let works = crate::browser::tests::fake_chromium(&dir, "0");
        let c = Chromium::launch(&[dies, missing, works], profiles(&dir), 800, 600)
            .expect("the third binary starts");
        assert!(c.is_alive());
        assert!(
            !dir.join("profile-0").exists(),
            "failed attempt's profile removed"
        );
        assert!(
            dir.join("profile-2").exists(),
            "the running browser's profile"
        );
        c.stop();
    }

    /// A binary that runs but closes its debugging pipe is not a browser
    /// the panel can use: the next one is tried.
    #[cfg(unix)]
    #[test]
    fn a_binary_without_the_pipe_makes_way_for_the_next() {
        let dir = tempdir("launch-no-pipe");
        let closes = script(&dir, "closes", "exec 3<&- 4>&-\nexec sleep 300");
        let works = crate::browser::tests::fake_chromium(&dir, "0");
        let c = Chromium::launch(&[closes, works], profiles(&dir), 800, 600)
            .expect("the second binary starts");
        assert!(c.is_alive());
        assert!(!dir.join("profile-0").exists(), "first attempt cleaned up");
        c.stop();
    }

    /// At most [`MAX_ATTEMPTS`] binaries are tried.
    #[cfg(unix)]
    #[test]
    fn launch_gives_up_after_max_attempts() {
        let dir = tempdir("launch-bounded");
        let bins: Vec<PathBuf> = (0..=MAX_ATTEMPTS)
            .map(|n| script(&dir, &format!("dies-{n}"), "exit 1"))
            .collect();
        let err = Chromium::launch(&bins, profiles(&dir), 800, 600)
            .err()
            .expect("fails");
        assert!(
            !err.contains(&bins[MAX_ATTEMPTS].display().to_string()),
            "{err}"
        );
    }

    /// The environment `command` sets for `binary`, as `(name, value)`.
    fn env_of(binary: &Path, profile: &Path) -> Vec<(String, Option<PathBuf>)> {
        command(binary, profile, 800, 600)
            .get_envs()
            .map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(PathBuf::from)))
            .collect()
    }

    /// A launcher script gets a private `XDG_CONFIG_HOME` and no flag
    /// variables; a real binary keeps the user's environment untouched.
    #[test]
    fn only_launcher_scripts_get_the_private_config_home() {
        let dir = tempdir("launch-env-scope");
        let profile = dir.join("profile-0");
        let launcher = dir.join("launcher");
        std::fs::write(
            &launcher,
            "#!/bin/sh\nexec /opt/google/chrome/chrome \"$@\"\n",
        )
        .unwrap();
        let binary = dir.join("binary");
        std::fs::write(&binary, b"\x7fELF\x02\x01\x01").unwrap();

        let env = env_of(&launcher, &profile);
        assert!(
            env.contains(&("XDG_CONFIG_HOME".into(), Some(profile.join("xdg-config")))),
            "{env:?}"
        );
        assert!(env.contains(&("CHROME_USER_FLAGS".into(), None)), "{env:?}");
        assert!(env.contains(&("CHROMIUM_FLAGS".into(), None)), "{env:?}");

        assert_eq!(env_of(&binary, &profile), Vec::new());
    }

    /// Extensions off, and the back/forward cache off in the one
    /// `--disable-features` Chromium honours (only the last counts).
    #[test]
    fn the_flags_disable_extensions_and_the_back_forward_cache() {
        let dir = tempdir("launch-flags");
        let cmd = command(&dir.join("chrome"), &dir.join("profile-0"), 800, 600);
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(args.iter().any(|a| a == "--disable-extensions"), "{args:?}");
        let features: Vec<&String> = args
            .iter()
            .filter(|a| a.starts_with("--disable-features="))
            .collect();
        assert_eq!(features.len(), 1, "{args:?}");
        assert!(
            features[0]["--disable-features=".len()..]
                .split(',')
                .any(|f| f == "BackForwardCache"),
            "{args:?}"
        );
    }

    /// A launched launcher script really runs with the private
    /// `XDG_CONFIG_HOME` inside its profile.
    #[cfg(unix)]
    #[test]
    fn a_launched_launcher_gets_the_private_config_home() {
        let dir = tempdir("launch-env");
        let seen = dir.join("seen");
        let browser = crate::browser::tests::fake_chromium(&dir, "0");
        let bin = script(
            &dir,
            "records",
            &format!(
                "printf '%s\\n' \"$XDG_CONFIG_HOME\" > '{seen}'\n\
                 exec '{}' \"$@\"",
                browser.display(),
                seen = seen.display()
            ),
        );
        let c = Chromium::launch(&[bin], profiles(&dir), 800, 600).expect("start");
        let seen = std::fs::read_to_string(&seen).unwrap();
        assert_eq!(
            seen.trim_end(),
            dir.join("profile-0/xdg-config").display().to_string()
        );
        c.stop();
    }
}
