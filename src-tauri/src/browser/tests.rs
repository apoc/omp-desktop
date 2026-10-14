use super::locate::find_chromium;
use super::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

/// Real-browser tests share one lock across modules. Hold it from before
/// fixture creation through teardown; `lock` recovers after a test panics.
pub(super) static CHROMIUM: Mutex<()> = Mutex::new(());

pub(super) fn tempdir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("omp-browser-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

pub(super) fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap()
}

/// Minimal HTTP/1.1 GET against `127.0.0.1:port`; returns the body, read by
/// its `Content-Length` (Chromium ignores `Connection: close`).
fn http_get(port: u16, path: &str) -> Option<String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .ok()?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    )
    .ok()?;
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
fn allocate_is_idempotent_and_writes_overlay() {
    let m = BrowserManager::new(tempdir("mgr"), home_dir()).unwrap();
    let p1 = m.allocate("s1", None).unwrap();
    let p2 = m.allocate("s1", None).unwrap();
    assert_eq!(p1, p2);
    let port = m.port("s1").unwrap();
    assert_eq!(
        std::fs::read_to_string(&p1).unwrap(),
        format!("browser:\n  cdpUrl: \"http://127.0.0.1:{port}\"\n")
    );
    m.release("s1");
    assert!(!p1.exists());
    assert!(m.port("s1").is_none());
}

#[test]
fn session_ids_that_are_not_file_name_safe_are_refused() {
    let m = BrowserManager::new(tempdir("ids"), home_dir()).unwrap();
    for id in ["", "../x", "a/b", "a.yml", "a b", &"x".repeat(65)] {
        assert!(m.allocate(id, None).is_err(), "{id:?}");
    }
    assert!(m.allocate("session-1700000000000_a", None).is_ok());
}

#[cfg(unix)]
#[test]
fn startup_deletes_only_the_directories_of_dead_processes() {
    let root = tempdir("leftovers");
    let mut finished = std::process::Command::new("true").spawn().unwrap();
    let dead = finished.id();
    finished.wait().unwrap();
    // The parent process stands in for a second, live app instance.
    let live = std::os::unix::process::parent_id();
    for pid in [dead, live] {
        let instance = root.join(pid.to_string());
        std::fs::create_dir_all(instance.join("profiles/session-1-0")).unwrap();
        std::fs::write(instance.join("session-1.yml"), "browser:\n").unwrap();
    }
    std::fs::write(root.join("keep.txt"), "x").unwrap();
    std::fs::create_dir(root.join("keep-dir")).unwrap();

    let _m = BrowserManager::new(root.clone(), home_dir()).unwrap();
    assert!(
        !root.join(dead.to_string()).exists(),
        "dead pid's dir removed"
    );
    let live = root.join(live.to_string());
    assert!(
        live.join("profiles/session-1-0").exists(),
        "live pid's profile stays"
    );
    assert!(
        live.join("session-1.yml").exists(),
        "live pid's overlay stays"
    );
    assert!(root.join("keep.txt").exists(), "foreign files stay");
    assert!(root.join("keep-dir").exists(), "non-pid dirs stay");
    assert!(root.join(std::process::id().to_string()).is_dir());
}

/// A dead desktop instance with one profile, independent of browser PID.
#[cfg(unix)]
fn stale_profile(root: &Path) -> PathBuf {
    let mut finished = std::process::Command::new("true").spawn().unwrap();
    let instance = root.join(finished.id().to_string());
    finished.wait().unwrap();
    let profile = instance.join("profiles/session-1-0");
    std::fs::create_dir_all(&profile).unwrap();
    profile
}

/// Keep the profile flag in the shell's argv, unlike `exec sleep`.
#[cfg(unix)]
fn orphan_browser(profile: Option<&Path>, own_group: bool) -> std::process::Child {
    use std::os::unix::process::CommandExt;
    let mut command = std::process::Command::new("sh");
    command
        .args(["-c", "while :; do sleep 60; done", "fake-chromium"])
        .stdin(std::process::Stdio::null());
    if let Some(profile) = profile {
        let mut flag = std::ffi::OsString::from("--user-data-dir=");
        flag.push(profile);
        command.arg(flag);
    }
    if own_group {
        command.process_group(0);
    }
    command.spawn().unwrap()
}

#[cfg(unix)]
#[test]
fn startup_reaps_orphaned_browser_before_deleting_dead_instance() {
    use crate::agent::supervisor::ProcessSupervisor;
    let root = tempdir("reap-orphan");
    let profile = stale_profile(&root);
    let instance = profile.parent().unwrap().parent().unwrap();
    let mut child = orphan_browser(Some(&profile), true);
    // Ensure cleanup even when the regression assertion panics.
    let _supervisor = ProcessSupervisor::attach(&child);
    std::fs::write(profile.with_extension("pid"), child.id().to_string()).unwrap();
    let (sent, received) = std::sync::mpsc::channel();
    // Real orphans are reaped by init; reap our test child concurrently.
    let reaper = std::thread::spawn(move || sent.send(child.wait().unwrap()).unwrap());
    let _manager = BrowserManager::new(root, home_dir()).unwrap();
    let status = received
        .recv_timeout(Duration::from_secs(2))
        .expect("orphaned browser must be killed");
    assert!(!status.success(), "browser killed, not exited normally");
    assert!(
        !instance.exists(),
        "dead instance removed after browser exits"
    );
    reaper.join().unwrap();
}

#[cfg(unix)]
#[test]
fn startup_does_not_kill_a_pid_without_the_exact_profile_argument() {
    use crate::agent::supervisor::ProcessSupervisor;
    for suffix in [None, Some("-other")] {
        let root = tempdir(if suffix.is_some() {
            "reap-wrong-profile"
        } else {
            "reap-no-profile"
        });
        let profile = stale_profile(&root);
        let other = profile.with_file_name("session-1-0-other");
        let mut child = orphan_browser(suffix.map(|_| other.as_path()), true);
        let supervisor = ProcessSupervisor::attach(&child);
        std::fs::write(profile.with_extension("pid"), child.id().to_string()).unwrap();
        let _manager = BrowserManager::new(root, home_dir()).unwrap();
        assert!(
            child.try_wait().unwrap().is_none(),
            "unrelated process stays alive"
        );
        supervisor.kill_tree();
        child.wait().unwrap();
    }
}

#[cfg(unix)]
#[test]
fn startup_does_not_kill_a_matching_pid_that_is_not_its_group_leader() {
    let root = tempdir("reap-not-leader");
    let profile = stale_profile(&root);
    // Shell builtins only: killing this child cannot leave descendants.
    let mut flag = std::ffi::OsString::from("--user-data-dir=");
    flag.push(&profile);
    let mut child = std::process::Command::new("sh")
        .args(["-c", "while :; do :; done", "fake-chromium"])
        .arg(flag)
        .spawn()
        .unwrap();
    std::fs::write(profile.with_extension("pid"), child.id().to_string()).unwrap();
    let _manager = BrowserManager::new(root, home_dir()).unwrap();
    let alive = child.try_wait().unwrap().is_none();
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(alive, "non-leader stays alive");
}

#[cfg(unix)]
#[test]
fn a_second_manager_on_the_same_root_leaves_the_first_ones_files() {
    let dir = tempdir("mgr-two");
    let bin = fake_chromium(&dir, "0");
    let first = BrowserManager::new(dir.clone(), home_dir()).unwrap();
    let overlay = first.allocate("s1", Some(&bin)).unwrap();
    first.chromium_port("s1").unwrap();
    let profile = first.profile_dir_for_test("s1").unwrap();
    let _second = BrowserManager::new(dir, home_dir()).unwrap();
    assert!(overlay.exists(), "first manager's overlay survives");
    assert!(profile.exists(), "first manager's profile survives");
    assert_eq!(first.allocate("s1", None).unwrap(), overlay);
}

#[cfg(unix)]
#[test]
fn a_symlinked_root_is_refused() {
    let dir = tempdir("mgr-link-root");
    let target = dir.join("target");
    std::fs::create_dir(&target).unwrap();
    let link = dir.join("link");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    assert!(BrowserManager::new(link, home_dir()).is_err());
    assert_eq!(
        std::fs::read_dir(&target).unwrap().count(),
        0,
        "target untouched"
    );
}

#[cfg(unix)]
#[test]
fn an_overlay_path_that_is_a_symlink_is_not_written_through() {
    let dir = tempdir("mgr-link-overlay");
    let m = BrowserManager::new(dir.clone(), home_dir()).unwrap();
    let victim = dir.join("victim");
    std::fs::write(&victim, "precious").unwrap();
    let instance = dir.join(std::process::id().to_string());
    std::os::unix::fs::symlink(&victim, instance.join("s1.yml")).unwrap();
    assert!(m.allocate("s1", None).is_err());
    assert_eq!(std::fs::read_to_string(&victim).unwrap(), "precious");
    assert!(m.port("s1").is_none(), "no entry for the failed allocation");
}

#[cfg(unix)]
#[test]
fn instance_dir_profiles_and_overlay_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempdir("mgr-modes");
    let bin = fake_chromium(&dir, "0");
    let m = BrowserManager::new(dir.clone(), home_dir()).unwrap();
    let overlay = m.allocate("s1", Some(&bin)).unwrap();
    m.chromium_port("s1").unwrap();
    let profile = m.profile_dir_for_test("s1").unwrap();
    let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&dir.join(std::process::id().to_string())), 0o700);
    assert_eq!(mode(profile.parent().unwrap()), 0o700);
    assert_eq!(mode(&overlay), 0o600);
    let pid_file = profile.with_extension("pid");
    assert_eq!(mode(&pid_file), 0o600);
    assert_eq!(
        std::fs::read_to_string(&pid_file).unwrap().trim(),
        std::fs::read_to_string(dir.join("pid")).unwrap().trim()
    );
}

#[test]
fn an_unavailable_manager_refuses_to_allocate() {
    let m = BrowserManager::unavailable("no cache dir".into());
    assert_eq!(m.allocate("s1", None), Err("no cache dir".into()));
    m.release("s1");
    m.shutdown_all();
}

#[test]
fn shutdown_all_removes_only_its_own_instance_directory() {
    let dir = tempdir("mgr-shutdown-dir");
    // The manager needs an owned root; this test later inspects that root.
    let m = BrowserManager::new(dir.clone(), home_dir()).unwrap();
    let instance = dir.join(std::process::id().to_string());
    let other = dir.join("other-instance");
    std::fs::create_dir(&other).unwrap();
    std::fs::create_dir(instance.join("profiles")).unwrap();
    let overlay = m.allocate("s1", None).unwrap();
    m.shutdown_all();
    m.shutdown_all(); // idempotent, including directory cleanup
    assert!(!overlay.exists());
    assert!(!instance.exists(), "own instance removed");
    assert!(other.is_dir(), "other instance remains");
}

/// A fake browser (unix): appends a line to `launches` per start, publishes
/// port `40000 + <launch count>` after `delay` seconds, then idles.
#[cfg(unix)]
fn fake_chromium(dir: &Path, delay: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let bin = dir.join("fake-chromium");
    let log = dir.join("launches");
    let pid = dir.join("pid");
    let script = format!(
        "#!/bin/sh\n\
         for a in \"$@\"; do case \"$a\" in --user-data-dir=*) d=\"${{a#--user-data-dir=}}\";; esac; done\n\
         echo $$ > '{pid}'\n\
         echo x >> '{log}'\n\
         mkdir -p \"$d\"\n\
         sleep {delay}\n\
         n=$(wc -l < '{log}')\n\
         printf '%s\\n/devtools/browser/x\\n' $((40000 + n)) > \"$d/DevToolsActivePort\"\n\
         exec sleep 300\n",
        log = log.display(),
        pid = pid.display()
    );
    std::fs::write(&bin, script).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    bin
}

#[cfg(unix)]
fn launch_count(dir: &Path) -> usize {
    std::fs::read_to_string(dir.join("launches")).map_or(0, |s| s.lines().count())
}

#[cfg(unix)]
#[test]
fn concurrent_ensures_launch_one_chromium() {
    let dir = tempdir("mgr-once");
    let bin = fake_chromium(&dir, "0.3");
    let m = BrowserManager::new(dir.clone(), home_dir()).unwrap();
    m.allocate("s1", Some(&bin)).unwrap();
    let ports: Vec<_> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..5)
            .map(|_| s.spawn(|| m.chromium_port("s1").unwrap()))
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert!(ports.iter().all(|&p| p == ports[0]), "{ports:?}");
    assert_eq!(launch_count(&dir), 1);
}

#[cfg(unix)]
#[test]
fn a_slow_launch_blocks_no_other_session() {
    let dir = tempdir("mgr-slow");
    let bin = fake_chromium(&dir, "1");
    let m = BrowserManager::new(dir.clone(), home_dir()).unwrap();
    m.allocate("slow", Some(&bin)).unwrap();
    std::thread::scope(|s| {
        let launching = s.spawn(|| m.chromium_port("slow").unwrap());
        // Wait until the launch is in flight.
        let deadline = Instant::now() + Duration::from_secs(5);
        while launch_count(&dir) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let started = Instant::now();
        m.allocate("other", Some(&bin)).unwrap();
        assert!(m.port("other").is_some());
        m.release("other");
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "other session waited {:?} on a launch",
            started.elapsed()
        );
        launching.join().unwrap();
    });
}

#[cfg(unix)]
#[test]
fn relaunch_after_crash_uses_a_fresh_profile_and_port() {
    let dir = tempdir("mgr-relaunch-fake");
    let bin = fake_chromium(&dir, "0");
    let m = BrowserManager::new(dir, home_dir()).unwrap();
    m.allocate("s1", Some(&bin)).unwrap();
    let placeholder = m.port("s1").unwrap();
    let first = m.chromium_port("s1").unwrap();
    let first_profile = m.profile_dir_for_test("s1").unwrap();
    m.kill_chromium_for_test("s1");
    let second = m.chromium_port("s1").unwrap();
    assert_ne!(first, second);
    assert_ne!(first_profile, m.profile_dir_for_test("s1").unwrap());
    assert!(!first_profile.exists(), "dead browser's profile removed");
    assert_eq!(m.port("s1"), Some(placeholder));
}

#[cfg(unix)]
#[test]
fn release_removes_profile_and_overlay_and_refuses_later_launches() {
    let dir = tempdir("mgr-release-fake");
    let bin = fake_chromium(&dir, "0");
    let m = BrowserManager::new(dir.clone(), home_dir()).unwrap();
    let overlay = m.allocate("s1", Some(&bin)).unwrap();
    m.chromium_port("s1").unwrap();
    let profile = m.profile_dir_for_test("s1").unwrap();
    assert!(profile.exists());
    let pid_file = profile.with_extension("pid");
    assert!(pid_file.exists());
    m.release("s1");
    m.release("s1"); // idempotent
    assert!(!profile.exists());
    assert!(!pid_file.exists(), "release removes browser PID file");
    assert!(!overlay.exists());
    assert!(m.chromium_port("s1").is_err());
    assert_eq!(launch_count(&dir), 1);
}

/// A launch is in flight and `release("s1")` waits for it on another
/// thread; once that release is no longer in the map, `second_closer` runs.
/// When it returns, the browser must be dead and its profile gone.
#[cfg(unix)]
fn second_closer_waits_for_the_release_in_flight(name: &str, second_closer: fn(&BrowserManager)) {
    let dir = tempdir(name);
    let bin = fake_chromium(&dir, "1");
    let m = BrowserManager::new(dir.clone(), home_dir()).unwrap();
    m.allocate("s1", Some(&bin)).unwrap();
    std::thread::scope(|s| {
        let launching = s.spawn(|| m.chromium_port("s1"));
        let deadline = Instant::now() + Duration::from_secs(5);
        while launch_count(&dir) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(launch_count(&dir), 1, "launch in flight");
        let profile = m.profile_dir_for_test("s1").unwrap();
        let releasing = s.spawn(|| m.release("s1"));
        while m.port("s1").is_some() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(m.port("s1").is_none(), "release took the entry out");
        second_closer(&m);
        assert!(!profile.exists(), "profile removed when the closer returns");
        let pid: u32 = std::fs::read_to_string(dir.join("pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(!crate::agent::supervisor::pid_is_alive(pid), "browser dead");
        releasing.join().unwrap();
        launching.join().unwrap().unwrap();
    });
}

#[cfg(unix)]
#[test]
fn shutdown_all_waits_for_a_release_blocked_on_a_slow_launch() {
    second_closer_waits_for_the_release_in_flight(
        "mgr-shutdown-race",
        BrowserManager::shutdown_all,
    );
}

#[cfg(unix)]
#[test]
fn a_second_release_waits_for_the_first_to_finish() {
    second_closer_waits_for_the_release_in_flight("mgr-release-twice", |m| m.release("s1"));
}

/// `None` (test passes with a note) when no Chromium is installed.
pub(super) fn manager_with_chromium(name: &str) -> Option<BrowserManager> {
    find_chromium(None, &home_dir())?;
    BrowserManager::new(tempdir(name), home_dir()).ok()
}

#[test]
fn relaunch_after_crash_keeps_placeholder_port() {
    let _chromium = lock(&CHROMIUM);
    let Some(m) = manager_with_chromium("relaunch") else {
        eprintln!("skip: no chromium");
        return;
    };
    m.allocate("s1", None).unwrap();
    let placeholder = m.port("s1").unwrap();
    assert!(http_get(placeholder, "/json/version")
        .unwrap()
        .contains("webSocketDebuggerUrl"));
    let first = m.chromium_port("s1").unwrap();
    m.kill_chromium_for_test("s1");
    let body = http_get(placeholder, "/json/version").unwrap();
    assert!(body.contains(&format!("127.0.0.1:{placeholder}")), "{body}");
    let second = m.chromium_port("s1").unwrap();
    assert_ne!(first, second, "a fresh chromium was launched");
    assert_eq!(
        m.port("s1"),
        Some(placeholder),
        "placeholder port unchanged"
    );
    m.release("s1");
}

#[test]
fn release_closes_connections_kills_chromium_removes_profile() {
    let _chromium = lock(&CHROMIUM);
    let Some(m) = manager_with_chromium("release") else {
        eprintln!("skip: no chromium");
        return;
    };
    m.allocate("s1", None).unwrap();
    let placeholder = m.port("s1").unwrap();
    let body = http_get(placeholder, "/json/version").unwrap();
    let ws_path = body
        .split("/devtools/")
        .nth(1)
        .and_then(|r| r.split('"').next())
        .unwrap();
    let mut ws = TcpStream::connect(("127.0.0.1", placeholder)).unwrap();
    write!(ws, "GET /devtools/{ws_path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n").unwrap();
    let mut buf = [0u8; 512];
    assert!(ws.read(&mut buf).unwrap() > 0, "handshake answered");
    let profile = m.profile_dir_for_test("s1").unwrap();
    m.release("s1");
    ws.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    assert!(
        matches!(ws.read(&mut buf), Ok(0) | Err(_)),
        "spliced socket closed"
    );
    assert!(!profile.exists(), "profile removed");
    // `ps` exists on unix only; elsewhere the removed profile is the evidence.
    if cfg!(unix) {
        let ps = std::process::Command::new("ps")
            .args(["-axo", "command="])
            .output()
            .unwrap();
        assert!(
            !String::from_utf8_lossy(&ps.stdout).contains(&*profile.to_string_lossy()),
            "no chromium left for that profile"
        );
    }
}
