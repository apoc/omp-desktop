//! Terminal manager tests: they spawn a real `sh` on a pseudo-terminal and
//! observe it through a collecting [`Emit`].

use super::kill::process_exists as process_alive;
use super::pty::HANGUP_GRACE;
use super::pump::{TerminalEmit, MAX_EVENT, MIN_INTERVAL};
use super::test_support::{open_with, stdout_of};
use super::{Emit, Slot, TerminalManager, TerminalState, TerminalStatus};
use crate::test_support::{wait_until, TempDir};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};

/// The name of [`PLAIN_SHELL`]'s directory in the temp dir, before the pid.
const PLAIN_SHELL_DIR: &str = "omp-terminal-test-";
/// A plain interactive `sh`. `/bin/sh -l` would read the developer's
/// `~/.profile` (which may `exec fish`), so the tests run `sh` through a
/// wrapper whose name (not a POSIX shell's) gets no `-l -i` arguments. A
/// static is never dropped, so its directory outlives the run; the next run
/// removes it ([`sweep_stale_shell_dirs`]).
static PLAIN_SHELL: LazyLock<String> = LazyLock::new(|| {
    sweep_stale_shell_dirs();
    let dir = std::env::temp_dir().join(format!("{PLAIN_SHELL_DIR}{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("plainsh");
    std::fs::write(&path, "#!/bin/sh\nexec /bin/sh -i\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path.to_string_lossy().into_owned()
});
const SLOW: Duration = Duration::from_secs(20);
/// Held by the tests that start dozens of shells and process-table scans
/// (the lifecycle races) or observe a grace period, so they never overlap.
static LOAD_SENSITIVE: Mutex<()> = Mutex::new(());

/// Remove the [`PLAIN_SHELL`] directories of test runs that have ended.
fn sweep_stale_shell_dirs() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let pid = name
            .to_str()
            .and_then(|name| name.strip_prefix(PLAIN_SHELL_DIR))
            .and_then(|pid| pid.parse::<i32>().ok());
        if pid.is_some_and(|pid| !process_alive(pid)) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// One data event.
struct Event {
    instance: u64,
    seq: u64,
    bytes: Vec<u8>,
}

/// Every event the manager emitted, in order, for every shell.
#[derive(Default)]
struct Collector {
    data: Mutex<Vec<Event>>,
    /// `(instance, code)` per exit event.
    exits: Mutex<Vec<(u64, Option<i32>)>>,
    /// The output emitted by the time the exit event arrived.
    text_at_exit: Mutex<Option<String>>,
    /// How many data events [`Collector::ack_new`] acknowledged so far.
    acked: Mutex<usize>,
}

/// One shell's emitter, recording into the shared [`Collector`].
struct Collecting {
    out: Arc<Collector>,
    instance: u64,
}

impl Emit for Arc<Collector> {
    type Terminal = Collecting;

    fn terminal(self, _id: &str, instance: u64) -> Collecting {
        Collecting {
            out: self,
            instance,
        }
    }
}

impl TerminalEmit for Collecting {
    fn data(&mut self, seq: u64, bytes: &[u8]) {
        self.out.data.lock().unwrap().push(Event {
            instance: self.instance,
            seq,
            bytes: bytes.to_vec(),
        });
    }

    fn exit(&mut self, code: Option<i32>) {
        *self.out.text_at_exit.lock().unwrap() = Some(self.out.text());
        self.out.exits.lock().unwrap().push((self.instance, code));
    }
}

impl Collector {
    fn text(&self) -> String {
        let bytes: Vec<u8> = self
            .data
            .lock()
            .unwrap()
            .iter()
            .flat_map(|e| e.bytes.iter().copied())
            .collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    fn total_bytes(&self) -> usize {
        self.data
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.bytes.len())
            .sum()
    }

    fn events(&self) -> usize {
        self.data.lock().unwrap().len()
    }

    fn largest_event(&self) -> usize {
        self.data
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.bytes.len())
            .max()
            .unwrap_or(0)
    }

    /// `(instance, seq)` of every data event, in order.
    fn seqs(&self) -> Vec<(u64, u64)> {
        self.data
            .lock()
            .unwrap()
            .iter()
            .map(|e| (e.instance, e.seq))
            .collect()
    }

    fn exited(&self) -> bool {
        !self.exits.lock().unwrap().is_empty()
    }

    fn exit_codes(&self) -> Vec<Option<i32>> {
        self.exits.lock().unwrap().iter().map(|e| e.1).collect()
    }

    /// Acknowledge every event received since the last call, as the
    /// webview does once it rendered them (flow control).
    fn ack_new(&self, manager: &TerminalManager, id: &str) {
        let fresh: Vec<(u64, usize)> = {
            let data = self.data.lock().unwrap();
            let mut acked = self.acked.lock().unwrap();
            let fresh = data[*acked..]
                .iter()
                .map(|e| (e.instance, e.bytes.len()))
                .collect();
            *acked = data.len();
            fresh
        };
        for (instance, len) in fresh {
            manager.ack(id, instance, u64::try_from(len).unwrap());
        }
    }

    /// The decimal number right after the first `marker` in the output that
    /// is followed by a digit (the shell's echo of the typed command has a
    /// `$` there instead).
    fn number_after(&self, marker: &str) -> Option<i32> {
        let text = self.text();
        text.match_indices(marker).find_map(|(at, _)| {
            let digits: String = text[at + marker.len()..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            digits.parse().ok()
        })
    }
}

/// [`wait_until`] while acknowledging the output as it arrives, for tests
/// that produce more than the pump emits unacknowledged.
fn wait_acking(
    manager: &TerminalManager,
    id: &str,
    out: &Collector,
    mut condition: impl FnMut() -> bool,
) -> bool {
    wait_until(SLOW, || {
        out.ack_new(manager, id);
        condition()
    })
}

/// A manager whose shell setting (kept in memory) is `shell`.
fn manager_with(shell: &str) -> TerminalManager {
    let manager = TerminalManager::new(None);
    manager.set_shell(shell).expect("shell setting");
    manager
}

/// `id` registered with the temp dir as its folder, its shell opened.
fn open(id: &str) -> (TerminalManager, Arc<Collector>) {
    open_with(manager_with(&PLAIN_SHELL), id)
}

#[test]
fn shell_output_and_exit_code_are_emitted() {
    let (manager, out) = open("echo");
    // The quotes keep the echoed input from containing the output.
    manager.write("echo", "echo hel\"\"lo; exit 3\n").unwrap();

    assert!(wait_until(SLOW, || out.exited()), "no exit event");
    assert!(out.text().contains("hello"), "output: {:?}", out.text());
    assert_eq!(out.exit_codes(), [Some(3)]);
}

#[test]
fn shell_gets_the_registered_folder_and_terminal_env() {
    let (manager, out) = open("env");
    manager
        .write(
            "env",
            "echo T=$TERM C=$COLORTERM O=$OMP_DESKTOP S=$OMP_DESKTOP_SESSION SH=$SHELL; pwd -P\n",
        )
        .unwrap();

    let cwd = std::fs::canonicalize(std::env::temp_dir()).unwrap();
    // `SHELL` is the program started, not the app's own `$SHELL`.
    let wanted = format!(
        "T=xterm-256color C=truecolor O=1 S=env SH={}\r\n{}",
        *PLAIN_SHELL,
        cwd.display()
    );
    assert!(
        wait_until(SLOW, || out.text().contains(&wanted)),
        "output: {:?}",
        out.text()
    );
}

/// A tab without a usable folder (none, gone, relative) gets the home folder.
#[test]
fn a_missing_folder_falls_back_to_home() {
    let home = crate::widgets::config::home_dir().expect("HOME is set");
    let home = std::fs::canonicalize(home).unwrap();
    let manager = manager_with(&PLAIN_SHELL);
    let out = Arc::new(Collector::default());
    let folders: [Option<&Path>; 3] = [
        None,
        Some(Path::new("/definitely/not/a/dir")),
        Some(Path::new("relative/dir")),
    ];
    for (n, folder) in folders.into_iter().enumerate() {
        let id = format!("home{n}");
        manager.register_tab(&id, folder);
        manager.open(Arc::clone(&out), &id, 80, 24).unwrap();
        manager
            .write(&id, format!("echo H{n}=$(pwd -P)\n"))
            .unwrap();
        let wanted = format!("H{n}={}\r\n", home.display());
        assert!(
            wait_until(SLOW, || out.text().contains(&wanted)),
            "folder {folder:?}: {:?}",
            out.text()
        );
    }
}

/// Output is cut into events of at most [`MAX_EVENT`], at most one per
/// [`MIN_INTERVAL`] (the first at once): the count is bounded by the time
/// the burst took, however slow the machine.
#[test]
fn burst_output_is_coalesced_into_capped_events() {
    let started = Instant::now();
    let (manager, out) = open("burst");
    manager
        .write("burst", "yes | head -c 2000000; exit\n")
        .unwrap();

    assert!(
        wait_acking(&manager, "burst", &out, || out.exited()),
        "no exit event"
    );
    let took = started.elapsed();
    assert!(
        out.total_bytes() >= 2_000_000,
        "bytes: {}",
        out.total_bytes()
    );
    let most = took.as_millis() / MIN_INTERVAL.as_millis() + 1;
    assert!(
        out.events() as u128 <= most,
        "{} events in {took:?}",
        out.events()
    );
    assert!(
        out.largest_event() <= MAX_EVENT,
        "largest event: {}",
        out.largest_event()
    );
}

#[test]
fn close_tab_kills_background_jobs() {
    let (manager, out) = open("jobs");
    manager.write("jobs", "sleep 1000 & echo JOB=$!\n").unwrap();
    assert!(
        wait_until(SLOW, || out.number_after("JOB=").is_some()),
        "output: {:?}",
        out.text()
    );
    let job = out.number_after("JOB=").unwrap();
    assert!(process_alive(job), "background job did not start");

    manager.close_tab("jobs");

    assert!(
        wait_until(Duration::from_secs(3), || !process_alive(job)),
        "background job {job} survived close_tab"
    );
    assert!(manager.tab_ids().is_empty(), "tab kept");
    // Closing is silent: the tab is gone, nobody listens for the exit.
    std::thread::sleep(Duration::from_millis(300));
    assert!(!out.exited());
}

/// Closing hangs the shell up before the kill: a `HUP` trap of the tab's
/// leader runs (a real shell saves its history there).
#[test]
fn close_tab_hangs_up_the_shell_before_killing_it() {
    // The trap must run within the real 200 ms grace, not under fixture stress.
    let _quiet = LOAD_SENSITIVE
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let dir = TempDir::new("terminal", "hup");
    let marker = dir.path().join("hung");
    let (manager, out) = open("hup");
    // The trap is set by a non-interactive `sh` that replaces the prompt
    // (same pid, so still the session leader) and then waits in the `wait`
    // builtin, which a trapped signal interrupts at once (POSIX); one that
    // arrives before it runs at the boundary after `echo`. A shell at its
    // prompt is no portable witness: dash retries its interrupted read and
    // runs a trap only once input arrives, and bash at a readline prompt
    // exits without running it. Nor is a foreground `sleep`: a hang-up that
    // lands while it is being forked leaves the trap pending until it ends.
    manager
        .write(
            "hup",
            format!(
                "exec sh -c 'trap \"echo hung > {}; exit\" HUP; sleep 30 & echo TR\"\"APPED; wait'\n",
                marker.display()
            ),
        )
        .unwrap();
    assert!(wait_until(SLOW, || out.text().contains("TRAPPED")));

    manager.close_tab("hup");

    assert!(
        wait_until(Duration::from_secs(3), || std::fs::read_to_string(&marker)
            .is_ok_and(|text| text == "hung\n")),
        "the HUP trap did not run"
    );
}

/// `shutdown_all` hangs every shell up first and waits one shared grace,
/// then kills: shells that ignore the hang-up cost one grace, not one each.
#[test]
fn shutdown_all_waits_one_hangup_grace_for_every_shell() {
    const SHELLS: u32 = 5;
    let _quiet = LOAD_SENSITIVE
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let manager = manager_with(&PLAIN_SHELL);
    let out = Arc::new(Collector::default());
    for n in 0..SHELLS {
        let id = format!("grace{n}");
        manager.register_tab(&id, None);
        manager.open(Arc::clone(&out), &id, 80, 24).unwrap();
        manager
            .write(&id, format!("trap '' HUP; echo IGNORING{n}=$$\n"))
            .unwrap();
    }
    let marker = |n: u32| format!("IGNORING{n}=");
    assert!(
        wait_until(SLOW, || (0..SHELLS)
            .all(|n| out.number_after(&marker(n)).is_some())),
        "output: {:?}",
        out.text()
    );
    let shells: Vec<i32> = (0..SHELLS)
        .map(|n| out.number_after(&marker(n)).unwrap())
        .collect();

    let started = Instant::now();
    manager.shutdown_all();
    let took = started.elapsed();

    assert!(took >= HANGUP_GRACE, "no grace for the hang-up: {took:?}");
    assert!(
        took < HANGUP_GRACE * (SHELLS - 1),
        "one grace per shell: {took:?}"
    );
    for shell in shells {
        assert!(
            wait_until(Duration::from_secs(3), || !process_alive(shell)),
            "shell {shell} survived shutdown_all"
        );
    }
}

#[test]
fn ctrl_c_reaches_the_foreground_process() {
    let (manager, out) = open("ctrlc");
    // The marker is printed (not just echoed: the quotes split it in the
    // typed line) once the foreground process runs, then it becomes `sleep`.
    manager
        .write("ctrlc", "sh -c 'echo RUN\"\"NING; exec sleep 30'\n")
        .unwrap();
    assert!(wait_until(SLOW, || out.text().contains("RUNNING")));
    std::thread::sleep(Duration::from_millis(100));

    manager.write("ctrlc", "\x03").unwrap();
    manager.write("ctrlc", "echo DONE$?\n").unwrap();

    // 130 = killed by SIGINT.
    assert!(
        wait_until(Duration::from_secs(2), || out.text().contains("DONE130")),
        "output: {:?}",
        out.text()
    );
}

/// While the shell runs, `open` returns its status; after it exited, a new
/// shell with a higher instance replaces it, numbering its events from 1.
#[test]
fn open_is_idempotent_while_alive_and_respawns_after_exit() {
    let (manager, out) = open("again");
    let first = manager.status("again").expect("status");
    manager.write("again", "echo A=$$\n").unwrap();
    assert!(wait_until(SLOW, || out.number_after("A=").is_some()));
    let first_pid = out.number_after("A=").unwrap();

    let second = manager.open(Arc::clone(&out), "again", 80, 24).unwrap();
    assert_eq!(second.instance, first.instance, "second open respawned");
    manager.write("again", "echo B=$$\n").unwrap();
    assert!(wait_until(SLOW, || out.number_after("B=").is_some()));
    assert_eq!(
        out.number_after("B="),
        Some(first_pid),
        "second open respawned"
    );

    manager.write("again", "exit\n").unwrap();
    assert!(wait_until(SLOW, || out.exited()));

    let third = manager.open(Arc::clone(&out), "again", 80, 24).unwrap();
    assert!(third.instance > first.instance, "{third:?} after {first:?}");
    assert_eq!(third.state, TerminalState::Running);
    manager.write("again", "echo C=$$\n").unwrap();
    assert!(wait_until(SLOW, || out.number_after("C=").is_some()));
    assert_ne!(out.number_after("C="), Some(first_pid), "no new shell");

    let seqs = out.seqs();
    for instance in [first.instance, third.instance] {
        let mine: Vec<u64> = seqs
            .iter()
            .filter(|(i, _)| *i == instance)
            .map(|(_, seq)| *seq)
            .collect();
        let expected: Vec<u64> = (1..=u64::try_from(mine.len()).unwrap()).collect();
        assert_eq!(mine, expected, "instance {instance}");
    }
}

/// `register_tab` for a tab that has a shell (a profile switch re-runs
/// `start_session` under the same id) keeps that shell.
#[test]
fn re_registering_a_tab_keeps_its_shell() {
    let (manager, out) = open("keep");
    let before = manager.status("keep").unwrap();
    manager.write("keep", "echo A=$$\n").unwrap();
    assert!(wait_until(SLOW, || out.number_after("A=").is_some()));

    manager.register_tab("keep", Some(Path::new("/")));
    let after = manager.open(Arc::clone(&out), "keep", 80, 24).unwrap();

    assert_eq!(after.instance, before.instance);
    manager.write("keep", "echo B=$$\n").unwrap();
    assert!(wait_until(SLOW, || out.number_after("B=").is_some()));
    assert_eq!(out.number_after("B="), out.number_after("A="));
}

/// The status follows the slot: none, starting (a pending spawn, which a
/// second `open` reports instead of spawning), running, exited with code.
#[test]
fn status_goes_from_starting_to_running_to_exited() {
    let manager = manager_with(&PLAIN_SHELL);
    let out = Arc::new(Collector::default());
    manager.register_tab("states", Some(std::env::temp_dir().as_path()));
    assert_eq!(manager.status("states"), None);

    let pending = TerminalStatus {
        instance: 999,
        shell: "/bin/pending".to_owned(),
        state: TerminalState::Starting,
        exit_code: None,
        windows_pty: None,
    };
    manager.tabs().get_mut("states").unwrap().slot = Slot::Spawning {
        instance: 999,
        shell: PathBuf::from("/bin/pending"),
    };
    assert_eq!(manager.status("states").as_ref(), Some(&pending));
    assert_eq!(
        manager.open(Arc::clone(&out), "states", 80, 24),
        Ok(pending),
        "an open during a pending spawn must not spawn again"
    );
    assert!(manager.write("states", "x").is_err(), "no shell yet");

    manager.tabs().get_mut("states").unwrap().slot = Slot::Idle;
    let running = manager.open(Arc::clone(&out), "states", 80, 24).unwrap();
    assert_eq!(running.state, TerminalState::Running);
    assert_eq!(running.shell, *PLAIN_SHELL);
    assert_eq!(running.exit_code, None);
    assert_eq!(manager.status("states").as_ref(), Some(&running));
    let wire = serde_json::to_value(&running).unwrap();
    assert_eq!(wire["state"], "running");
    assert!(
        wire["windowsPty"].is_null(),
        "no pseudo console off Windows"
    );

    manager.write("states", "exit 4\n").unwrap();
    assert!(wait_until(SLOW, || out.exited()), "no exit event");
    let exited = manager.status("states").unwrap();
    assert_eq!(exited.instance, running.instance);
    assert_eq!(exited.state, TerminalState::Exited);
    assert_eq!(exited.exit_code, Some(4));
}

/// `replay` returns what the shell emitted after a seq; a stale instance
/// gets everything the current shell holds.
#[test]
fn replay_returns_the_held_output() {
    let (manager, out) = open("replay");
    let status = manager.status("replay").unwrap();
    manager.write("replay", "echo RE\"\"PLAYED\n").unwrap();
    assert!(wait_until(SLOW, || out.text().contains("REPLAYED")));
    // Settle: no further output while comparing.
    std::thread::sleep(Duration::from_millis(200));

    let decode = |b64: &str| {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap();
        String::from_utf8_lossy(&bytes).into_owned()
    };
    let all = manager.replay("replay", status.instance, 0).unwrap();
    assert_eq!(all.instance, status.instance);
    assert!(!all.dropped);
    assert_eq!(decode(&all.b64), out.text());
    assert_eq!(
        Some(all.head_seq),
        out.seqs().last().map(|(_, seq)| *seq),
        "head is the last emitted seq"
    );

    let none_newer = manager
        .replay("replay", status.instance, all.head_seq)
        .unwrap();
    assert_eq!(none_newer.b64, "", "nothing after the head");

    let stale = manager
        .replay("replay", status.instance + 100, all.head_seq)
        .unwrap();
    assert_eq!(stale.instance, status.instance);
    assert_eq!(decode(&stale.b64), out.text(), "a stale instance gets all");

    assert_eq!(manager.replay("nope", 1, 0), None);
}

#[test]
fn resize_changes_the_pty_size() {
    let (manager, out) = open("size");
    manager.resize("size", 100, 40).unwrap();
    manager.write("size", "stty size\n").unwrap();

    assert!(
        wait_until(SLOW, || out.text().contains("40 100\r\n")),
        "output: {:?}",
        out.text()
    );
}

/// `shutdown_all` ends every tab and kills every shell; the manager stays
/// usable for tabs registered afterwards.
#[test]
fn shutdown_all_kills_every_shell_and_leaves_the_manager_usable() {
    let (manager, out) = open("down1");
    manager.register_tab("down2", None);
    manager.open(Arc::clone(&out), "down2", 80, 24).unwrap();
    manager.write("down1", "echo SA=$$\n").unwrap();
    manager.write("down2", "echo SB=$$\n").unwrap();
    assert!(wait_until(SLOW, || out.number_after("SA=").is_some()
        && out.number_after("SB=").is_some()));
    let shells = [
        out.number_after("SA=").unwrap(),
        out.number_after("SB=").unwrap(),
    ];

    manager.shutdown_all();

    for shell in shells {
        assert!(
            wait_until(Duration::from_secs(3), || !process_alive(shell)),
            "shell {shell} survived shutdown_all"
        );
    }
    assert!(manager.tab_ids().is_empty(), "tabs kept");
    assert!(manager.write("down1", "x").is_err(), "entry not removed");

    manager.register_tab("down1", None);
    manager.open(Arc::clone(&out), "down1", 80, 24).unwrap();
    manager.write("down1", "echo AG\"\"AIN\n").unwrap();
    assert!(wait_until(SLOW, || out.text().contains("AGAIN")));
}

/// `close_tabs` (the `close_all_tabs` command) ends exactly the tabs it is
/// given: a tab registered after the caller took its snapshot keeps its
/// registration and its shell.
#[test]
fn close_tabs_ends_only_the_listed_tabs() {
    let (manager, out) = open("listed1");
    for id in ["listed2", "later"] {
        manager.register_tab(id, None);
        manager.open(Arc::clone(&out), id, 80, 24).unwrap();
    }
    manager.write("listed1", "echo LA=$$\n").unwrap();
    manager.write("listed2", "echo LB=$$\n").unwrap();
    manager.write("later", "echo LC=$$\n").unwrap();
    assert!(wait_until(SLOW, || ["LA=", "LB=", "LC="]
        .iter()
        .all(|m| out.number_after(m).is_some())));
    let closed = [
        out.number_after("LA=").unwrap(),
        out.number_after("LB=").unwrap(),
    ];
    let kept = out.number_after("LC=").unwrap();

    manager.close_tabs(&["listed1", "listed2", "never-registered"]);

    for shell in closed {
        assert!(
            wait_until(Duration::from_secs(3), || !process_alive(shell)),
            "shell {shell} survived close_tabs"
        );
    }
    assert_eq!(manager.tab_ids(), ["later"]);
    assert!(process_alive(kept), "an unlisted tab's shell was killed");
    manager.write("later", "echo ST\"\"ILL\n").unwrap();
    assert!(wait_until(SLOW, || out.text().contains("STILL")));
    manager.close_tab("later");
}

#[test]
fn bad_requests_are_rejected() {
    let manager = manager_with(&PLAIN_SHELL);
    let out = Arc::new(Collector::default());
    manager.register_tab("bad", None);

    assert_eq!(
        manager.open(Arc::clone(&out), "unknown", 80, 24),
        Err("no tab unknown".to_owned())
    );
    assert!(manager.open(Arc::clone(&out), "bad", 0, 24).is_err());
    assert!(manager.open(Arc::clone(&out), "bad", 80, 0).is_err());
    assert_eq!(manager.status("unknown"), None);
    assert!(manager.write("unknown", "x").is_err());
    assert!(manager.write("bad", "x").is_err(), "no shell yet");
    assert!(manager.resize("unknown", 80, 24).is_err());
    manager.ack("unknown", 1, 10); // ignored
    manager.close_tab("unknown"); // closing an unknown tab is a no-op
    assert_eq!(manager.tab_ids(), ["bad"]);
}

#[test]
fn settings_are_validated_persisted_and_reloaded() {
    let guard = TempDir::new("terminal", "settings");
    // Not created yet, like a first start's config folder.
    let dir = guard.path().join("config");
    let path = dir.join("terminal.json");
    // A manager reading the file afresh (a restart).
    let reopen = || TerminalManager::new(Some(dir.join("terminal.json")));

    let manager = reopen();
    let settings = manager.settings();
    assert_eq!(settings.shell, "");
    assert!(
        Path::new(&settings.default_shell).is_absolute(),
        "{settings:?}"
    );

    for bad in [
        "sh",
        "./sh",
        "/definitely/not/a/shell",
        "/etc/hosts",
        "/bin",
    ] {
        assert!(manager.set_shell(bad).is_err(), "{bad} must be refused");
    }
    assert!(!path.exists(), "a refused setting was written");

    let set = manager.set_shell(&format!("  {}  ", *PLAIN_SHELL)).unwrap();
    assert_eq!(set.shell, *PLAIN_SHELL, "stored trimmed");
    assert_eq!(manager.settings().shell, *PLAIN_SHELL);
    let reloaded = reopen();
    assert_eq!(reloaded.settings().shell, *PLAIN_SHELL);

    // The setting is what the next shell runs.
    reloaded.register_tab("set", None);
    let status = reloaded
        .open(Arc::new(Collector::default()), "set", 80, 24)
        .unwrap();
    assert_eq!(status.shell, *PLAIN_SHELL);
    reloaded.close_tab("set");

    assert_eq!(reloaded.set_shell("").unwrap().shell, "");
    assert_eq!(reopen().settings().shell, "");

    // A corrupt file reads as the default and is never overwritten.
    std::fs::write(&path, "{ not json").unwrap();
    let corrupt = reopen();
    assert_eq!(corrupt.settings().shell, "");
    assert!(corrupt.set_shell(&PLAIN_SHELL).is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
}

#[test]
fn a_background_job_dies_with_its_exited_shell_without_any_close() {
    let (manager, out) = open("orphan");
    manager
        .write("orphan", "sleep 1000 & echo JOB=$!\n")
        .unwrap();
    assert!(wait_until(SLOW, || out.number_after("JOB=").is_some()));
    let pty = manager.live("orphan").unwrap();
    manager.write("orphan", "exit\n").unwrap();
    assert!(
        wait_until(SLOW, || out.exited()),
        "no exit event; output: {:?}",
        out.text()
    );
    let job = out.number_after("JOB=").expect("no job pid");

    // Nobody closes or replaces the terminal: the exit alone ends the job.
    assert!(
        wait_until(Duration::from_secs(3), || !process_alive(job)),
        "job {job} outlived its shell"
    );
    // Counted just after the signal went out.
    assert!(
        wait_until(SLOW, || pty.killer().signals() >= 1),
        "the job was not signalled"
    );
    assert_eq!(pty.killer().sid(), 0, "session id kept after the exit");
}

/// The reaped shell's pid can be reused by the system: nothing may signal
/// that session id any more once the shell is gone — not a later
/// `close_tab`, not the respawn replacing the slot.
#[test]
fn an_exited_shell_is_never_signalled_again_by_close_or_respawn() {
    let (manager, out) = open("reuse");
    let pty = manager.live("reuse").unwrap();
    assert!(pty.killer().sid() > 1, "no session id while the shell runs");
    manager.write("reuse", "exit\n").unwrap();
    assert!(wait_until(SLOW, || out.exited()), "no exit event");
    assert!(
        wait_until(SLOW, || pty.killer().sid() == 0),
        "session id kept after the exit"
    );
    let signals = pty.killer().signals();

    // Respawn replaces (and kills) the exited shell; then close_tab kills
    // the new one. Neither touches the old session id.
    manager.open(Arc::clone(&out), "reuse", 80, 24).unwrap();
    manager.close_tab("reuse");

    assert_eq!(
        pty.killer().signals(),
        signals,
        "signals sent after the shell was gone"
    );
}

/// `ps` state of `pid` (`Z...` for a zombie), empty when it is gone.
fn process_state(pid: i32) -> String {
    stdout_of("ps", ["-o", "stat=", "-p", &pid.to_string()])
        .trim()
        .to_owned()
}

/// Releases the paused cleanup of a terminal when dropped, so a failing
/// assertion never leaves its waiter thread paused.
struct ResumeCleanup(Arc<super::pty::Pty>);

impl Drop for ResumeCleanup {
    fn drop(&mut self) {
        self.0.killer().hold_cleanup(false);
    }
}

/// The exit code comes from `waitid` (the shell is not reaped to read it):
/// a normal exit gives its code, a death by signal none.
#[test]
fn the_exit_code_is_read_without_reaping_the_shell() {
    let (manager, out) = open("code7");
    manager.write("code7", "exit 7\n").unwrap();
    assert!(wait_until(SLOW, || out.exited()), "no exit event");
    assert_eq!(out.exit_codes(), [Some(7)]);

    let (manager, out) = open("signalled");
    manager.write("signalled", "kill -9 $$\n").unwrap();
    assert!(wait_until(SLOW, || out.exited()), "no exit event");
    assert_eq!(out.exit_codes(), [None], "a signal has no exit code");
    let status = manager.status("signalled").unwrap();
    assert_eq!(
        (status.state, status.exit_code),
        (TerminalState::Exited, None)
    );
    drop(manager);

    assert_eq!(super::kill::exit_code(libc::CLD_EXITED, 7), Some(7));
    assert_eq!(super::kill::exit_code(libc::CLD_KILLED, 9), None);
    assert_eq!(super::kill::exit_code(libc::CLD_DUMPED, 11), None);
}

/// While the session is not cleaned up the exited shell stays an unreaped
/// zombie, so its pid — the session id — cannot be reissued to someone else
/// and a kill by it cannot hit a stranger. Reaped only after the cleanup.
#[test]
fn the_exited_shell_stays_a_zombie_until_its_session_is_cleaned_up() {
    let (manager, out) = open("zombie");
    let pty = manager.live("zombie").unwrap();
    let pid = pty.killer().sid();
    assert!(pid > 1);
    pty.killer().hold_cleanup(true);
    let _resume = ResumeCleanup(Arc::clone(&pty));

    manager.write("zombie", "exit 7\n").unwrap();
    assert!(wait_until(SLOW, || out.exited()), "no exit event");
    assert_eq!(out.exit_codes(), [Some(7)]);
    // Well past the grace period: the cleanup is the only thing pending.
    std::thread::sleep(super::pump::READER_GRACE * 2);

    assert!(process_alive(pid), "the leader's pid was released early");
    assert!(
        process_state(pid).starts_with('Z'),
        "leader {pid} is not a zombie: {:?}",
        process_state(pid)
    );
    assert_eq!(pty.killer().sid(), pid, "session id dropped before cleanup");

    pty.killer().hold_cleanup(false);
    assert!(
        wait_until(SLOW, || process_state(pid).is_empty()),
        "the zombie {pid} was never reaped"
    );
    assert!(!process_alive(pid));
    assert_eq!(pty.killer().sid(), 0, "session id kept after the cleanup");
}

/// A `close_tab` during the grace period kills by the still-reserved
/// session id, but leaves the reaping to the waiter: the zombie survives the
/// close and is reaped exactly once, after the cleanup.
#[test]
fn a_close_during_the_grace_period_leaves_the_reaping_to_the_waiter() {
    let (manager, out) = open("zombie-close");
    let pty = manager.live("zombie-close").unwrap();
    let pid = pty.killer().sid();
    pty.killer().hold_cleanup(true);
    let _resume = ResumeCleanup(Arc::clone(&pty));

    manager.write("zombie-close", "exit\n").unwrap();
    assert!(wait_until(SLOW, || out.exited()), "no exit event");
    manager.close_tab("zombie-close");

    assert_eq!(pty.killer().sid(), 0, "close did not clear the session id");
    assert!(
        process_state(pid).starts_with('Z'),
        "leader {pid} reaped by the close: {:?}",
        process_state(pid)
    );

    pty.killer().hold_cleanup(false);
    assert!(
        wait_until(SLOW, || process_state(pid).is_empty()),
        "the zombie {pid} was never reaped"
    );
}

/// A shell that reads no input (raw tty, no echo, asleep): writes pile up
/// in the queue until it is full, and then fail instead of blocking.
#[test]
fn write_backlog_is_rejected_instead_of_blocking() {
    let (manager, _out) = open("backlog");
    manager
        .write("backlog", "stty raw -echo; sleep 5\n")
        .unwrap();
    std::thread::sleep(Duration::from_millis(300));

    let started = Instant::now();
    let error = (0..5000).find_map(|_| manager.write("backlog", vec![b'x'; 64 * 1024]).err());

    assert_eq!(error.as_deref(), Some("terminal input backlog"));
    assert!(started.elapsed() < Duration::from_secs(5), "writes blocked");
}

#[test]
fn all_output_is_out_before_the_exit_event() {
    let (manager, out) = open("drain");
    // More than the pump emits in one go, so the tail is still queued
    // when the shell exits.
    manager
        .write(
            "drain",
            "echo A\"\"1; head -c 1500000 /dev/zero | tr '\\0' z; echo END\"\"9; exit 0\n",
        )
        .unwrap();

    assert!(
        wait_acking(&manager, "drain", &out, || out.exited()),
        "no exit event"
    );
    let seen = out.text_at_exit.lock().unwrap().take().unwrap();
    assert!(seen.contains("A1"), "before exit: {seen:.200?}");
    assert!(
        seen.contains("END9"),
        "tail lost: {:?}",
        &seen[seen.len() - 100..]
    );
    assert_eq!(out.exit_codes(), [Some(0)]);
}

/// When its session leader exits, the pty hangs up (observed on macOS): a
/// background job holding the slave open can neither keep the reader from
/// EOF nor write to the terminal any more. The exit event follows at once
/// and the job's late output is dropped, not forwarded after the exit.
#[cfg(target_os = "macos")]
#[test]
fn a_job_does_not_delay_the_exit_and_its_late_output_is_dropped() {
    let (manager, out) = open("holdout");
    manager
        .write(
            "holdout",
            "exec 3>&1; (sleep 0.1; echo B\"\"2 >&3) & exit 0\n",
        )
        .unwrap();

    assert!(
        wait_until(Duration::from_secs(2), || out.exited()),
        "exit event waited for the job"
    );
    std::thread::sleep(Duration::from_millis(600));
    assert!(!out.text().contains("B2"), "output after the exit event");
    assert_eq!(out.exit_codes(), [Some(0)]);
}

/// On Linux a background job may keep the slave open after the shell exited:
/// output it produces within the reader's grace period (250 ms) is still
/// delivered, and before the exit event, which then follows promptly.
#[cfg(target_os = "linux")]
#[test]
fn a_jobs_output_within_the_grace_period_is_delivered_before_the_exit() {
    let (manager, out) = open("holdout");
    manager
        .write(
            "holdout",
            "exec 3>&1; (sleep 0.1; echo B\"\"2 >&3) & exit 0\n",
        )
        .unwrap();

    assert!(
        wait_until(Duration::from_secs(2), || out.exited()),
        "exit event waited for the job"
    );
    let seen = out.text_at_exit.lock().unwrap().take().unwrap();
    assert!(seen.contains("B2"), "job output after the exit: {seen:?}");
    assert_eq!(out.exit_codes(), [Some(0)]);
}

/// A shell that records its pid in `pidfile` (appending) before it becomes
/// an interactive `sh`: lets a test see every shell a manager ever started.
/// Both live in the returned directory.
fn recording_shell(tag: &str) -> (TempDir, String, PathBuf) {
    let dir = TempDir::new("terminal", tag);
    let pidfile = dir.path().join("pids");
    let path = dir.path().join("recordsh");
    let script = format!(
        "#!/bin/sh\necho $$ >> '{}'\nexec /bin/sh -i\n",
        pidfile.display()
    );
    std::fs::write(&path, script).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let shell = path.to_string_lossy().into_owned();
    (dir, shell, pidfile)
}

fn recorded_pids(pidfile: &Path) -> Vec<i32> {
    std::fs::read_to_string(pidfile)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.trim().parse().ok())
        .collect()
}

/// Run `first` and `second` at the same moment on two threads.
fn concurrently(first: impl FnOnce() + Send, second: impl FnOnce() + Send) {
    let start = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            start.wait();
            first();
        });
        scope.spawn(|| {
            start.wait();
            second();
        });
    });
}

/// `close_tab` racing `open`: whichever wins, no shell survives and no tab
/// is left. An open that lost the race (its tab closed while it spawned, or
/// before it looked) is an error.
#[test]
fn close_tab_racing_open_leaves_no_shell_and_no_tab() {
    let _quiet = LOAD_SENSITIVE
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let (_dir, shell, pidfile) = recording_shell("open-close");
    let manager = manager_with(&shell);
    let out = Arc::new(Collector::default());
    for round in 0..20 {
        manager.register_tab("race", Some(std::env::temp_dir().as_path()));
        let result = Mutex::new(None);
        concurrently(
            || {
                *result.lock().unwrap() = Some(manager.open(Arc::clone(&out), "race", 80, 24));
            },
            || manager.close_tab("race"),
        );
        match result.into_inner().unwrap().unwrap() {
            // Opened before the close: the close killed it.
            Ok(status) => assert_eq!(status.state, TerminalState::Running),
            Err(e) => assert!(
                e == "tab closed" || e == "no tab race",
                "round {round}: {e}"
            ),
        }

        assert!(manager.tab_ids().is_empty(), "round {round}: tab left");
        let pids = recorded_pids(&pidfile);
        assert!(
            wait_until(Duration::from_secs(2), || pids
                .iter()
                .all(|&p| !process_alive(p))),
            "round {round}: a shell survived: {pids:?}"
        );
    }
}

#[test]
fn overlapping_opens_start_one_shell() {
    let _quiet = LOAD_SENSITIVE
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let (_dir, shell, pidfile) = recording_shell("open-open");
    let manager = manager_with(&shell);
    let out = Arc::new(Collector::default());
    for round in 0..10 {
        manager.register_tab("twice", Some(std::env::temp_dir().as_path()));
        let statuses = Mutex::new(Vec::new());
        let open = || {
            let status = manager
                .open(Arc::clone(&out), "twice", 80, 24)
                .expect("open");
            statuses.lock().unwrap().push(status.instance);
        };
        concurrently(open, open);
        let instances = statuses.into_inner().unwrap();
        assert_eq!(instances[0], instances[1], "round {round}: two instances");

        let expected = round + 1;
        assert!(
            wait_until(SLOW, || recorded_pids(&pidfile).len() >= expected),
            "round {round}: shell never started"
        );
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(
            recorded_pids(&pidfile).len(),
            expected,
            "round {round}: a second shell was started"
        );
        manager.close_tab("twice");
    }
}
