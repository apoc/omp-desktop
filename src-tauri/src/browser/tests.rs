//! The manager's lifecycle, and the test support every browser suite shares
//! (real-Chromium skipping, managers, panels, a fake CDP client).

use super::view::{BrowserEmit, Frame, InputEvent, Pick, Status, TabInfo, View, ViewState};
use super::*;
use crate::test_support::eventually;
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, TcpStream};
use std::time::Duration;

/// Real-browser tests share one lock across modules. Hold it from before
/// fixture creation through teardown; `lock` recovers after a test panics.
pub(super) static CHROMIUM: Mutex<()> = Mutex::new(());

/// A fresh, empty scratch directory for `name`, in the browser suites' scope.
pub(super) fn tempdir(name: &str) -> PathBuf {
    crate::test_support::tempdir("browser", name)
}

/// The user's home, as the app would resolve it; `None` when unset.
pub(super) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Ample time for a proxy connection's peer check (`lsof` may take
/// seconds).
pub(super) const PEER_CHECK: Duration = Duration::from_secs(10);

/// Sends `request` to the proxy at `127.0.0.1:port`, then collects the
/// reply until the proxy closes the connection (it does after every
/// response), for at most [`PEER_CHECK`] per read: a slow peer check can
/// hold the first byte back.
pub(super) fn http_roundtrip(port: u16, request: &[u8]) -> io::Result<Vec<u8>> {
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port))?;
    stream.set_read_timeout(Some(PEER_CHECK))?;
    stream.write_all(request)?;
    let mut got = Vec::new();
    // What arrived before an error is kept in `got`.
    let _ = stream.read_to_end(&mut got);
    Ok(got)
}

/// The status line and body of a response.
pub(super) fn split_response(response: &[u8]) -> (String, String) {
    let text = String::from_utf8_lossy(response);
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = head.split("\r\n").next().unwrap_or_default();
    (status.to_owned(), body.to_owned())
}

/// `method path` with a loopback Host, through the proxy at `port`: the
/// status line and body of the response.
pub(super) fn http_request(port: u16, method: &str, path: &str) -> io::Result<(String, String)> {
    let head = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    http_roundtrip(port, head.as_bytes()).map(|response| split_response(&response))
}

/// The body of `GET path` through the proxy at `port`, whatever its status.
pub(super) fn http_get(port: u16, path: &str) -> io::Result<String> {
    http_request(port, "GET", path).map(|(_, body)| body)
}

/// The Chromium a real-browser test runs, as the app would find it. `None`
/// (the test passes with a note) when there is none, unless the
/// environment sets `OMP_REQUIRE_CHROMIUM=1` (CI): then a missing browser
/// fails the test instead of letting it pass without running.
pub(super) fn chromium_or_skip(test: &str) -> Option<PathBuf> {
    let found = SettingsStore::load(None, home_dir())
        .launch_candidates()
        .and_then(|binaries| binaries.into_iter().next().ok_or_else(|| "none".to_owned()));
    let required = std::env::var_os("OMP_REQUIRE_CHROMIUM").is_some_and(|v| v == "1");
    let binary = require_chromium(test, found, required)?;
    warm_up(&binary);
    Some(binary)
}

/// Run `binary` to completion once per test process, before any test
/// launches it: a machine's first Chromium start (cold disk cache, a virus
/// scan of its files; seen on Windows CI runners) can take longer than the
/// app's 10 s startup timeout, and a test would report that as a launch
/// failure. Later starts are quick.
fn warm_up(binary: &Path) {
    static WARM: std::sync::Once = std::sync::Once::new();
    WARM.call_once(|| {
        let profile = tempdir("warm-up");
        let mut flag = std::ffi::OsString::from("--user-data-dir=");
        flag.push(&profile);
        let started = std::process::Command::new(binary)
            .args([
                "--headless=new",
                "--no-first-run",
                "--dump-dom",
                "about:blank",
            ])
            .arg(flag)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        if let Ok(mut child) = started {
            // Bounded: a browser that never exits must not hang the suite.
            let exited = eventually(Duration::from_secs(60), || child.try_wait().ok().flatten());
            if exited.is_none() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        let _ = std::fs::remove_dir_all(&profile);
    });
}

/// [`chromium_or_skip`] over what discovery `found` and whether a browser
/// is `required`.
fn require_chromium(test: &str, found: Result<PathBuf, String>, required: bool) -> Option<PathBuf> {
    match found {
        Ok(binary) => Some(binary),
        Err(why) if required => panic!("{test}: OMP_REQUIRE_CHROMIUM=1 but no Chromium: {why}"),
        Err(why) => {
            eprintln!("skip {test}: no chromium ({why})");
            None
        }
    }
}

/// A manager on a fresh root with automatic browser discovery. Needs no
/// Chromium until something launches one.
pub(super) fn manager(name: &str) -> BrowserManager {
    BrowserManager::new(
        &tempdir(name),
        Arc::new(SettingsStore::load(None, home_dir())),
    )
    .expect("manager")
}

/// [`manager`] when a real Chromium exists, else `None` (see
/// [`chromium_or_skip`], which prints the skip). Only a missing browser
/// skips: a manager that fails to build fails the test.
pub(super) fn manager_with_chromium(name: &str) -> Option<BrowserManager> {
    chromium_or_skip(name)?;
    Some(manager(name))
}

/// A manager on `root` whose browser setting is `binary`.
#[cfg(unix)]
fn manager_using(root: &Path, binary: &Path) -> BrowserManager {
    let settings = SettingsStore::load(None, home_dir());
    settings
        .set_path(&binary.display().to_string())
        .expect("an executable test browser");
    BrowserManager::new(root, Arc::new(settings)).expect("manager")
}

/// A real-Chromium manager with session `s1`'s panel open at 400×300 CSS px
/// and `dpr`, reporting to `emit`; `None` without Chromium.
pub(super) fn panel(
    name: &str,
    dpr: f64,
    emit: Arc<dyn BrowserEmit>,
) -> Option<(BrowserManager, Arc<View>)> {
    let m = manager_with_chromium(name)?;
    m.allocate("s1").unwrap();
    m.open_panel("s1", 400, 300, dpr, emit).unwrap();
    let view = m.panel("s1").unwrap();
    Some((m, view))
}

/// A left-button gesture step: `mouseMoved` has no button, the other two do.
pub(super) fn mouse(kind: &str, x: f64, y: f64) -> InputEvent {
    let moved = kind == "mouseMoved";
    InputEvent::Mouse {
        r#type: kind.into(),
        x,
        y,
        button: if moved { "none" } else { "left" }.into(),
        buttons: u32::from(kind == "mousePressed"),
        click_count: u32::from(!moved),
        modifiers: 0,
    }
}

/// Page sessions the fake suites address without attaching them (a view
/// core given `set_active("a", "sa")` directly). [`fake_cdp`]'s client owns
/// them from the start, as if it had attached them.
const FAKE_SESSIONS: [&str; 2] = ["sa", "sb"];

/// The fixture's own command that hands out [`FAKE_SESSIONS`]; `reply`
/// never sees it.
const GRANT: &str = "Fixture.grantSessions";

/// A browser-level client of a fake Chromium (see
/// [`fake_browser`](super::broker::fake::fake_browser)) that owns
/// [`FAKE_SESSIONS`]. Each command the client sends goes to `reply`, without
/// the client's own root session: `None` ends the browser connection,
/// `Some(messages)` sends them (none = no answer). Build replies with
/// [`cdp_result`] / [`cdp_error`].
pub(super) fn fake_cdp(
    mut reply: impl FnMut(&Value) -> Option<Vec<Value>> + Send + 'static,
) -> super::broker::BrokerClient {
    let client = super::broker::fake::fake_browser(move |request| {
        if request["method"] != GRANT {
            return reply(request);
        }
        // Announced on the client's root session, which makes them its own.
        let mut answers: Vec<Value> = FAKE_SESSIONS
            .iter()
            .map(|session| {
                json!({
                    "method": "Target.attachedToTarget",
                    "params": { "sessionId": session, "targetInfo": {} },
                })
            })
            .collect();
        answers.push(cdp_result(request, json!({})));
        Some(answers)
    })
    .connect_browser()
    .unwrap();
    client
        .send(&json!({ "id": 0, "method": GRANT, "params": {} }).to_string())
        .unwrap();
    // The grants come before the reply; none of it is for the test.
    loop {
        match client.recv(Duration::from_secs(5)) {
            super::broker::Recv::Message(text) => {
                let message: Value = serde_json::from_str(&text).unwrap();
                if message["id"] == 0 {
                    break;
                }
            }
            other => panic!("fake cdp grant: {other:?}"),
        }
    }
    client
}

/// The success reply to `request`.
pub(super) fn cdp_result(request: &Value, result: Value) -> Value {
    let mut reply = serde_json::Map::new();
    reply.insert("id".into(), request["id"].clone()); // the reply carries its own copy
    reply.insert("result".into(), result);
    Value::Object(reply)
}

/// The error reply to `request`.
pub(super) fn cdp_error(request: &Value, message: &str) -> Value {
    json!({ "id": request["id"], "error": { "code": -32000, "message": message } })
}

#[test]
fn a_missing_chromium_skips_unless_required() {
    assert_eq!(
        require_chromium("t", Ok(PathBuf::from("/opt/google/chrome/chrome")), true).as_deref(),
        Some(Path::new("/opt/google/chrome/chrome"))
    );
    assert_eq!(require_chromium("t", Err("none".into()), false), None);
    let required = std::panic::catch_unwind(|| require_chromium("t", Err("none".into()), true));
    assert!(
        required.is_err(),
        "OMP_REQUIRE_CHROMIUM=1 turns the skip into a failure"
    );
}

#[test]
fn allocate_is_idempotent_and_writes_overlay() {
    let m = manager("mgr");
    let p1 = m.allocate("s1").unwrap();
    let p2 = m.allocate("s1").unwrap();
    assert_eq!(p1, p2);
    assert_eq!(
        m.allocate_if_available("s1").unwrap().as_deref(),
        Some(p1.as_path())
    );
    let port = m.port("s1").unwrap();
    assert_eq!(
        std::fs::read_to_string(&p1).unwrap(),
        format!("browser:\n  cdpUrl: \"http://127.0.0.1:{port}\"\n  relay: false\n")
    );
    m.release("s1");
    assert!(!p1.exists());
    assert!(m.port("s1").is_none());
}

#[test]
fn session_ids_that_are_not_file_name_safe_are_refused() {
    let m = manager("ids");
    for id in ["", "../x", "a/b", "a.yml", "a b", &"x".repeat(65)] {
        assert!(m.allocate(id).is_err(), "{id:?}");
    }
    assert!(m.allocate("session-1700000000000_a").is_ok());
}

/// The settings store, not the webview, says what runs, and it is read at
/// every launch: a change applies to the next one.
#[cfg(unix)]
#[test]
fn the_browser_setting_is_read_at_launch_time() {
    let dir = tempdir("mgr-setting");
    let (a, b) = (dir.join("a"), dir.join("b"));
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    let (bin_a, bin_b) = (fake_chromium(&a, "0"), fake_chromium(&b, "0"));
    let settings = Arc::new(SettingsStore::load(None, home_dir()));
    settings.set_path(&bin_a.display().to_string()).unwrap();
    let m = BrowserManager::new(&dir.join("root"), Arc::clone(&settings)).unwrap();
    m.allocate("s1").unwrap();
    m.chromium("s1").unwrap();
    assert_eq!((launch_count(&a), launch_count(&b)), (1, 0));
    settings.set_path(&bin_b.display().to_string()).unwrap();
    m.kill_chromium_for_test("s1");
    m.chromium("s1").unwrap();
    assert_eq!((launch_count(&a), launch_count(&b)), (1, 1));
}

/// A configured browser that is gone at launch is the launch's error (the
/// panel shows it); no other browser stands in.
#[cfg(unix)]
#[test]
fn a_configured_browser_that_vanished_is_an_error_not_a_fallback() {
    let dir = tempdir("mgr-vanished");
    let bin = fake_chromium(&dir, "0");
    let m = manager_using(&dir.join("root"), &bin);
    m.allocate("s1").unwrap();
    std::fs::remove_file(&bin).unwrap();
    let Err(err) = m.chromium("s1") else {
        panic!("a vanished browser launched");
    };
    assert!(err.contains("Settings → Browser"), "{err}");
    assert_eq!(launch_count(&dir), 0);
    assert!(
        m.profile_dir_for_test("s1").is_none(),
        "nothing was launched"
    );
}

#[cfg(unix)]
#[test]
fn pruning_deletes_only_the_directories_of_dead_processes() {
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

    let m = BrowserManager::new(&root, Arc::new(SettingsStore::load(None, home_dir()))).unwrap();
    assert!(
        root.join(dead.to_string()).exists(),
        "startup itself prunes nothing"
    );
    m.prune_stale_instances();
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
    let child = command.spawn().unwrap();
    // `spawn` returns once the exec is under way, before the kernel
    // publishes the new argv: until then the reaper reads the test binary's
    // command line and rightly leaves the pid alone. A crashed run's
    // browser has long been running; wait for that.
    assert!(
        eventually(Duration::from_secs(5), || shows_argv(child.id())
            .then_some(()))
        .is_some(),
        "the child's argv is never published"
    );
    child
}

/// Whether `pid`'s command line, as the reaper reads it, is the
/// [`orphan_browser`] shell's.
#[cfg(target_os = "linux")]
fn shows_argv(pid: u32) -> bool {
    std::fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|argv| {
        argv.windows(b"fake-chromium".len())
            .any(|w| w == b"fake-chromium")
    })
}

#[cfg(target_os = "macos")]
fn shows_argv(pid: u32) -> bool {
    std::process::Command::new("/bin/ps")
        .args(["-o", "command=", "-p"])
        .arg(pid.to_string())
        .output()
        .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).contains("fake-chromium"))
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
const fn shows_argv(_pid: u32) -> bool {
    true
}

/// Waits for `child` on a thread of its own (real orphans are reaped by
/// init); the receiver gets its exit status.
#[cfg(unix)]
fn reap_concurrently(
    mut child: std::process::Child,
) -> std::sync::mpsc::Receiver<std::process::ExitStatus> {
    let (sent, received) = std::sync::mpsc::channel();
    std::thread::spawn(move || sent.send(child.wait().unwrap()).unwrap());
    received
}

#[cfg(unix)]
#[test]
fn pruning_reaps_an_orphaned_browser_before_deleting_its_dead_instance() {
    use crate::supervisor::ProcessSupervisor;
    let root = tempdir("reap-orphan");
    let profile = stale_profile(&root);
    let instance = profile.parent().unwrap().parent().unwrap();
    let child = orphan_browser(Some(&profile), true);
    // Ensure cleanup even when the regression assertion panics.
    let _supervisor = ProcessSupervisor::attach(&child);
    std::fs::write(profile.with_extension("pid"), child.id().to_string()).unwrap();
    let status = reap_concurrently(child);
    BrowserManager::new(&root, Arc::new(SettingsStore::load(None, home_dir())))
        .unwrap()
        .prune_stale_instances();
    let status = status
        .recv_timeout(Duration::from_secs(2))
        .expect("orphaned browser must be killed");
    assert!(!status.success(), "browser killed, not exited normally");
    assert!(
        !instance.exists(),
        "dead instance removed after browser exits"
    );
}

/// A directory with our own pid is a crashed earlier run's (pid reuse):
/// its browser is reaped and the directory starts empty.
#[cfg(unix)]
#[test]
fn a_leftover_directory_with_our_own_pid_is_reaped_and_recreated() {
    use crate::supervisor::ProcessSupervisor;
    let root = tempdir("reap-own-pid");
    let instance = root.join(std::process::id().to_string());
    let profile = instance.join("profiles/session-1-0");
    std::fs::create_dir_all(&profile).unwrap();
    std::fs::write(instance.join("session-1.yml"), "stale").unwrap();
    let child = orphan_browser(Some(&profile), true);
    let _supervisor = ProcessSupervisor::attach(&child);
    std::fs::write(profile.with_extension("pid"), child.id().to_string()).unwrap();
    let status = reap_concurrently(child);
    let m = BrowserManager::new(&root, Arc::new(SettingsStore::load(None, home_dir()))).unwrap();
    assert!(!status
        .recv_timeout(Duration::from_secs(2))
        .expect("the earlier run's browser is killed")
        .success());
    assert!(instance.is_dir(), "recreated");
    assert_eq!(std::fs::read_dir(&instance).unwrap().count(), 0, "empty");
    // The stale overlay name is free again.
    assert!(m.allocate("session-1").is_ok());
}

#[cfg(unix)]
#[test]
fn pruning_does_not_kill_a_pid_without_the_exact_profile_argument() {
    use crate::supervisor::ProcessSupervisor;
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
        BrowserManager::new(&root, Arc::new(SettingsStore::load(None, home_dir())))
            .unwrap()
            .prune_stale_instances();
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
fn pruning_does_not_kill_a_matching_pid_that_is_not_its_group_leader() {
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
    BrowserManager::new(&root, Arc::new(SettingsStore::load(None, home_dir())))
        .unwrap()
        .prune_stale_instances();
    let alive = child.try_wait().unwrap().is_none();
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(alive, "non-leader stays alive");
}

#[cfg(unix)]
#[test]
fn a_symlinked_root_is_refused() {
    let dir = tempdir("mgr-link-root");
    let target = dir.join("target");
    std::fs::create_dir(&target).unwrap();
    let link = dir.join("link");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    assert!(BrowserManager::new(&link, Arc::new(SettingsStore::load(None, home_dir()))).is_err());
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
    let root = dir.join("root");
    let m = BrowserManager::new(&root, Arc::new(SettingsStore::load(None, home_dir()))).unwrap();
    let victim = dir.join("victim");
    std::fs::write(&victim, "precious").unwrap();
    let instance = root.join(std::process::id().to_string());
    std::os::unix::fs::symlink(&victim, instance.join("s1.yml")).unwrap();
    assert!(m.allocate("s1").is_err());
    assert_eq!(std::fs::read_to_string(&victim).unwrap(), "precious");
    assert!(m.port("s1").is_none(), "no entry for the failed allocation");
}

#[cfg(unix)]
#[test]
fn instance_dir_profiles_and_overlay_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempdir("mgr-modes");
    let bin = fake_chromium(&dir, "0");
    let root = dir.join("root");
    let m = manager_using(&root, &bin);
    let overlay = m.allocate("s1").unwrap();
    m.chromium("s1").unwrap();
    let profile = m.profile_dir_for_test("s1").unwrap();
    let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&root.join(std::process::id().to_string())), 0o700);
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
    assert_eq!(m.allocate("s1"), Err("no cache dir".into()));
    assert_eq!(
        m.allocate_if_available("s1"),
        Ok(None),
        "the app run has no managed browsers: omp starts without the overlay"
    );
    m.release("s1");
    m.prune_stale_instances();
    m.shutdown_all();
}

#[test]
fn shutdown_all_removes_only_its_own_instance_directory() {
    let dir = tempdir("mgr-shutdown-dir");
    let m = BrowserManager::new(&dir, Arc::new(SettingsStore::load(None, home_dir()))).unwrap();
    let instance = dir.join(std::process::id().to_string());
    let other = dir.join("other-instance");
    std::fs::create_dir(&other).unwrap();
    std::fs::create_dir(instance.join("profiles")).unwrap();
    let overlay = m.allocate("s1").unwrap();
    m.allocate("s2").unwrap();
    m.shutdown_all();
    m.shutdown_all(); // idempotent, including directory cleanup
    assert!(!overlay.exists());
    assert!(!instance.exists(), "own instance removed");
    assert!(other.is_dir(), "other instance remains");
}

/// A fake browser (unix) at `dir/fake-chromium`: appends a line to
/// `dir/launches` per start, records its pid in `dir/pid`, waits `delay`
/// seconds, answers the launch's version and initial-page commands, then
/// waits with the pipe open.
#[cfg(unix)]
pub(super) fn fake_chromium(dir: &Path, delay: &str) -> PathBuf {
    let bin = dir.join("fake-chromium");
    let log = dir.join("launches");
    let pid = dir.join("pid");
    let executable = std::env::current_exe().unwrap();
    let executable = executable.to_string_lossy().replace('\'', "'\\''");
    let script = format!(
        "#!/bin/sh\n\
         for a in \"$@\"; do case \"$a\" in --user-data-dir=*) d=\"${{a#--user-data-dir=}}\";; esac; done\n\
         echo $$ > '{pid}'\n\
         echo x >> '{log}'\n\
         mkdir -p \"$d\"\n\
         sleep {delay}\n\
         export OMP_TEST_DEFERRED_BROWSER=suppressed\n\
         exec '{executable}' --exact browser::tests::launch_exposes_one_initial_page_before_consumers --nocapture\n",
        log = log.display(),
        pid = pid.display()
    );
    crate::test_support::executable(&bin, &script)
}

/// CDP pipe peer in a child test process. Its automatic startup page is
/// deliberately delayed until after the first target-list snapshot, so a
/// consumer that creates a replacement from that snapshot races it.
#[cfg(unix)]
fn deferred_startup_browser(automatic: bool) {
    use std::io::{BufRead, BufReader};
    use std::os::fd::FromRawFd;

    // SAFETY: the launcher's CDP pipe hands this child exclusive ownership
    // of descriptors 3 and 4; no other code in this child uses them.
    let input = unsafe { std::fs::File::from_raw_fd(3) };
    let mut output = unsafe { std::fs::File::from_raw_fd(4) };
    let mut input = BufReader::new(input);
    let mut pending_startup = automatic;
    let mut pages = Vec::<Value>::new();
    let mut message = Vec::new();
    loop {
        message.clear();
        if input.read_until(0, &mut message).unwrap() == 0 {
            break;
        }
        assert_eq!(message.pop(), Some(0));
        let request: Value = serde_json::from_slice(&message).unwrap();
        let method = request["method"].as_str().unwrap();
        let result = match method {
            "Browser.getVersion" => json!({ "product": "fake" }),
            "Target.getTargets" => json!({ "targetInfos": pages }),
            "Target.createTarget" => {
                let id = format!("created-{}", pages.len());
                pages.push(json!({
                    "targetId": id,
                    "type": "page",
                    "url": request["params"]["url"],
                    "title": ""
                }));
                json!({ "targetId": id })
            }
            _ => panic!("unexpected CDP command: {request}"),
        };
        serde_json::to_writer(
            &mut output,
            &json!({ "id": request["id"], "result": result }),
        )
        .unwrap();
        output.write_all(&[0]).unwrap();
        output.flush().unwrap();
        if method == "Target.getTargets" && pending_startup {
            pages.push(json!({
                "targetId": "automatic-startup",
                "type": "page",
                "url": "about:blank",
                "title": ""
            }));
            pending_startup = false;
        }
    }
}

/// The process is ready for both an agent's discovery and a panel's
/// fallback: a late automatic startup target must not add another page.
#[cfg(unix)]
#[test]
fn launch_exposes_one_initial_page_before_consumers() {
    if let Some(mode) = std::env::var_os("OMP_TEST_DEFERRED_BROWSER") {
        deferred_startup_browser(mode == "automatic");
        return;
    }

    let dir = tempdir("launch-initial-page");
    let executable = std::env::current_exe().unwrap();
    let executable = executable.to_string_lossy().replace('\'', "'\\''");
    let bin = crate::test_support::executable(
        &dir.join("deferred-browser"),
        &format!(
            "#!/bin/sh\n\
             OMP_TEST_DEFERRED_BROWSER=automatic\n\
             for a in \"$@\"; do case \"$a\" in\n\
               --user-data-dir=*) d=\"${{a#--user-data-dir=}}\";;\n\
               --no-startup-window) OMP_TEST_DEFERRED_BROWSER=suppressed;;\n\
             esac; done\n\
             export OMP_TEST_DEFERRED_BROWSER\n\
             mkdir -p \"$d\"\n\
             exec '{executable}' --exact browser::tests::launch_exposes_one_initial_page_before_consumers --nocapture"
        ),
    );
    let m = manager_using(&dir.join("root"), &bin);
    m.allocate("s1").unwrap();
    let broker = m.chromium("s1").expect("start");
    let profile = m.profile_dir_for_test("s1").unwrap();
    let pid: u32 = std::fs::read_to_string(profile.with_extension("pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let initial = broker
        .call("Target.getTargets", json!({}), Duration::from_secs(10))
        .unwrap();
    let initial_pages = initial["targetInfos"].as_array().unwrap();
    if initial_pages.is_empty() {
        broker
            .call(
                "Target.createTarget",
                json!({ "url": "about:blank" }),
                Duration::from_secs(10),
            )
            .unwrap();
    }
    let settled = broker
        .call("Target.getTargets", json!({}), Duration::from_secs(10))
        .unwrap();
    m.release("s1");
    assert!(
        !crate::supervisor::pid_is_alive(pid),
        "browser process reaped"
    );
    assert!(!profile.exists(), "browser profile removed");
    assert!(!profile.with_extension("pid").exists(), "PID file removed");
    let settled_pages = settled["targetInfos"].as_array().unwrap();
    assert_eq!(settled_pages.len(), 1, "late startup: {settled}");
    assert_eq!(initial_pages.len(), 1, "ready for discovery: {initial}");
    assert_eq!(initial_pages[0]["type"], "page");
    assert_eq!(initial_pages[0]["url"], "about:blank");
    assert_eq!(settled_pages[0]["targetId"], initial_pages[0]["targetId"]);
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
    let m = manager_using(&dir.join("root"), &bin);
    m.allocate("s1").unwrap();
    let brokers: Vec<_> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..5)
            .map(|_| s.spawn(|| m.chromium("s1").unwrap()))
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert!(
        brokers.iter().all(|b| Arc::ptr_eq(b, &brokers[0])),
        "one connection for every caller"
    );
    assert_eq!(launch_count(&dir), 1);
}

#[cfg(unix)]
#[test]
fn a_slow_launch_blocks_no_other_session() {
    let dir = tempdir("mgr-slow");
    let bin = fake_chromium(&dir, "1");
    let m = manager_using(&dir.join("root"), &bin);
    m.allocate("slow").unwrap();
    std::thread::scope(|s| {
        let launching = s.spawn(|| m.chromium("slow").unwrap());
        eventually(Duration::from_secs(5), || {
            (launch_count(&dir) > 0).then_some(())
        })
        .expect("launch in flight");
        let started = std::time::Instant::now();
        m.allocate("other").unwrap();
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

/// A browser killed from outside is noticed (its broker ends) and the next
/// `chromium` starts a fresh one in a fresh profile.
#[cfg(unix)]
#[test]
fn relaunch_after_crash_uses_a_fresh_profile_and_connection() {
    let dir = tempdir("mgr-relaunch-fake");
    let bin = fake_chromium(&dir, "0");
    let m = manager_using(&dir.join("root"), &bin);
    m.allocate("s1").unwrap();
    let placeholder = m.port("s1").unwrap();
    let first = m.chromium("s1").unwrap();
    let first_profile = m.profile_dir_for_test("s1").unwrap();
    let pid = std::fs::read_to_string(dir.join("pid")).unwrap();
    let killed = std::process::Command::new("kill")
        .args(["-9", pid.trim()])
        .status()
        .unwrap();
    assert!(killed.success(), "kill -9 {pid}");
    assert!(
        eventually(Duration::from_secs(5), || (!first.is_alive()).then_some(())).is_some(),
        "the crash closes the broker"
    );
    let second = m.chromium("s1").unwrap();
    assert!(!Arc::ptr_eq(&first, &second));
    assert_eq!(launch_count(&dir), 2);
    assert_ne!(first_profile, m.profile_dir_for_test("s1").unwrap());
    assert!(!first_profile.exists(), "dead browser's profile removed");
    assert_eq!(m.port("s1"), Some(placeholder));
}

#[cfg(unix)]
#[test]
fn release_removes_profile_and_overlay_and_refuses_later_launches() {
    let dir = tempdir("mgr-release-fake");
    let bin = fake_chromium(&dir, "0");
    let m = manager_using(&dir.join("root"), &bin);
    let overlay = m.allocate("s1").unwrap();
    m.chromium("s1").unwrap();
    let profile = m.profile_dir_for_test("s1").unwrap();
    assert!(profile.exists());
    let pid_file = profile.with_extension("pid");
    assert!(pid_file.exists());
    m.release("s1");
    m.release("s1"); // idempotent
    assert!(!profile.exists());
    assert!(!pid_file.exists(), "release removes browser PID file");
    assert!(!overlay.exists());
    assert!(m.chromium("s1").is_err());
    assert_eq!(launch_count(&dir), 1);
}

/// Closing many tabs releases exactly their browsers; unknown ids are fine.
#[cfg(unix)]
#[test]
fn release_many_ends_exactly_the_given_sessions() {
    let dir = tempdir("mgr-release-many");
    let bin = fake_chromium(&dir, "0");
    let m = manager_using(&dir.join("root"), &bin);
    let overlays: Vec<_> = ["s1", "s2", "s3"]
        .iter()
        .map(|id| m.allocate(id).unwrap())
        .collect();
    m.chromium("s1").unwrap();
    m.chromium("s2").unwrap();
    let profiles: Vec<_> = ["s1", "s2"]
        .iter()
        .map(|id| m.profile_dir_for_test(id).unwrap())
        .collect();
    m.release_many(&["s1", "s2", "unknown"]);
    assert!(profiles.iter().all(|p| !p.exists()), "{profiles:?}");
    assert!(!overlays[0].exists() && !overlays[1].exists());
    assert!(m.port("s1").is_none() && m.port("s2").is_none());
    assert!(overlays[2].exists(), "s3 is not among them");
    assert!(m.port("s3").is_some());
}

/// A launch is in flight and `release("s1")` waits for it on another
/// thread; once that release is no longer in the map, `second_closer` runs.
/// When it returns, the browser must be dead and its profile gone.
#[cfg(unix)]
fn second_closer_waits_for_the_release_in_flight(name: &str, second_closer: fn(&BrowserManager)) {
    let dir = tempdir(name);
    let bin = fake_chromium(&dir, "1");
    let m = manager_using(&dir.join("root"), &bin);
    m.allocate("s1").unwrap();
    std::thread::scope(|s| {
        let launching = s.spawn(|| m.chromium("s1"));
        eventually(Duration::from_secs(5), || {
            (launch_count(&dir) > 0).then_some(())
        })
        .expect("launch in flight");
        let profile = m.profile_dir_for_test("s1").unwrap();
        let releasing = s.spawn(|| m.release("s1"));
        eventually(Duration::from_secs(5), || {
            m.port("s1").is_none().then_some(())
        })
        .expect("release took the entry out");
        second_closer(&m);
        assert!(!profile.exists(), "profile removed when the closer returns");
        let pid: u32 = std::fs::read_to_string(dir.join("pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(!crate::supervisor::pid_is_alive(pid), "browser dead");
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

/// A respawn racing its tab's close gets an error (the start fails and the
/// frontend rolls the tab back), never a start without the tab's browser.
#[cfg(unix)]
#[test]
fn allocating_a_session_that_is_still_closing_is_an_error() {
    let dir = tempdir("mgr-allocate-closing");
    let bin = fake_chromium(&dir, "1");
    let m = manager_using(&dir.join("root"), &bin);
    m.allocate("s1").unwrap();
    std::thread::scope(|s| {
        let launching = s.spawn(|| m.chromium("s1"));
        eventually(Duration::from_secs(5), || {
            (launch_count(&dir) > 0).then_some(())
        })
        .expect("launch in flight");
        let releasing = s.spawn(|| m.release("s1"));
        eventually(Duration::from_secs(5), || {
            m.port("s1").is_none().then_some(())
        })
        .expect("release took the entry out");
        let err = m.allocate_if_available("s1").unwrap_err();
        assert!(err.contains("still closing"), "{err}");
        releasing.join().unwrap();
        let _ = launching.join().unwrap();
    });
}

#[cfg(unix)]
#[test]
fn a_second_release_waits_for_the_first_to_finish() {
    second_closer_waits_for_the_release_in_flight("mgr-release-twice", |m| m.release("s1"));
}

#[test]
fn relaunch_after_crash_keeps_placeholder_port() {
    let _chromium = lock(&CHROMIUM);
    let Some(m) = manager_with_chromium("relaunch") else {
        return;
    };
    m.allocate("s1").unwrap();
    let placeholder = m.port("s1").unwrap();
    assert!(http_get(placeholder, "/json/version")
        .unwrap()
        .contains("webSocketDebuggerUrl"));
    let first = m.chromium("s1").unwrap();
    m.kill_chromium_for_test("s1");
    let body = http_get(placeholder, "/json/version").unwrap();
    assert!(body.contains(&format!("127.0.0.1:{placeholder}")), "{body}");
    let second = m.chromium("s1").unwrap();
    assert!(
        !Arc::ptr_eq(&first, &second),
        "a fresh chromium was launched"
    );
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
        return;
    };
    m.allocate("s1").unwrap();
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
    let n = ws.read(&mut buf).unwrap();
    assert!(
        buf[..n].starts_with(b"HTTP/1.1 101"),
        "handshake answered: {}",
        String::from_utf8_lossy(&buf[..n])
    );
    let profile = m.profile_dir_for_test("s1").unwrap();
    m.release("s1");
    ws.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    assert!(
        matches!(ws.read(&mut buf), Ok(0) | Err(_)),
        "agent socket closed"
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

/// The statuses an open's sink delivered to its panel.
#[derive(Default, Debug)]
struct Statuses(Mutex<Vec<Status>>);

impl Statuses {
    fn heard(&self, status: Status) -> bool {
        lock(&self.0).contains(&status)
    }

    fn last(&self) -> Option<Status> {
        lock(&self.0).last().copied()
    }
}

impl BrowserEmit for Statuses {
    fn frame(&self, _: &str, _: &Frame) {}
    fn tabs(&self, _: &str, _: &[TabInfo]) {}
    fn state(&self, _: &str, s: &ViewState) {
        lock(&self.0).push(s.status);
    }
    fn pick(&self, _: &str, _: &Pick) {}
}

/// A restart reopens on the panel's own handler while an earlier open is
/// still in flight: the newest open wins, and the superseded one neither
/// replaces it nor says `idle` (or anything) to the panel afterwards.
#[test]
fn a_newer_open_supersedes_one_in_flight() {
    let _chromium = lock(&CHROMIUM);
    let Some(m) = manager_with_chromium("mgr-open-superseded") else {
        return;
    };
    m.allocate("s1").unwrap();
    let older = Arc::new(Statuses::default());
    let newer = Arc::new(Statuses::default());
    let (reached, wait_reached) = std::sync::mpsc::channel();
    let (release, wait_release) = std::sync::mpsc::channel::<()>();
    let first = std::thread::scope(|scope| {
        let opening = scope.spawn(|| {
            let emit = Arc::clone(&older) as Arc<dyn BrowserEmit>;
            m.open_panel_with("s1", 400, 300, 1.0, emit, move |_| {
                reached.send(()).unwrap();
                let _ = wait_release.recv_timeout(Duration::from_secs(30));
            })
        });
        wait_reached
            .recv_timeout(Duration::from_secs(30))
            .expect("the first open got as far as installing");
        let emit = Arc::clone(&newer) as Arc<dyn BrowserEmit>;
        m.open_panel("s1", 300, 200, 1.0, emit).unwrap();
        release.send(()).unwrap();
        opening.join().unwrap()
    });
    assert_eq!(first, Err("panel reopened".to_owned()));
    assert!(
        !older.heard(Status::Idle),
        "the superseded open's close stays silent: {older:?}"
    );
    let running = eventually(Duration::from_secs(3), || {
        (newer.last() == Some(Status::Running)).then_some(())
    });
    assert!(running.is_some(), "the live panel: {newer:?}");
    m.panel("s1")
        .unwrap()
        .navigate("data:text/html,live")
        .expect("the newer open's view is installed and connected");
    m.release("s1");
}
