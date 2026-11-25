//! The omp session lifecycle: spawning, session events, budget rolling,
//! ticks, wake-ups and restarts.

use super::{Core, CoreMsg};
use crate::budget::{BudgetEvent, Usage};
use crate::scheduler::{Event, Now, Scheduled, WakeReason};
use crate::session::{Launch, Session, SessionEvent};
use crate::wake;
use omp_desktop_core::json_store::write_atomic;
use omp_desktop_core::persona_protocol::{ItemKind, ItemState, ServerMsg};
use serde_json::value::RawValue;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

/// First restart delay after omp stops; doubles up to [`RESTART_MAX`].
pub(super) const RESTART_MIN: Duration = Duration::from_secs(1);
/// Longest restart delay.
const RESTART_MAX: Duration = Duration::from_secs(300);
/// Uptime after which a restart counts as a fresh start and resets the backoff.
const RESTART_RESET: Duration = Duration::from_secs(60);
/// Most bytes read from the instructions file in one wake.
const INSTRUCTIONS_MAX_BYTES: usize = 64 * 1024;
/// Appended in place of the rest of a longer instructions file.
const INSTRUCTIONS_TRUNCATED: &str = "\n\n[ompy] instructions truncated at 64 KiB";
/// Name of the bounded snapshot omp is spawned with, next to the state files.
const SNAPSHOT_NAME: &str = "instructions.snapshot.md";
/// Stands in for instructions that could not be read before the first spawn,
/// so omp always gets a bounded file instead of the user's path.
const SNAPSHOT_UNAVAILABLE: &str =
    "[ompy] Ompy's instructions could not be read, so none are active for this session";

const NOTICE_EXPIRED: &str = "Ompy stopped unexpectedly; open approvals expired";
const NOTICE_WARNED: &str = "80 % of today's token limit used";
const NOTICE_EXHAUSTED: &str = "Daily token limit reached; Ompy pauses until midnight";
const NOTICE_INSTRUCTIONS: &str =
    "Ompy restarted to apply edited instructions; open approvals expired";
const NOTICE_RPC_REUSED: &str =
    "omp reused the id of a request that was still waiting; the older request expired";

/// Read the persona's instructions, bounded to [`INSTRUCTIONS_MAX_BYTES`].
///
/// Only a regular file is read, so a FIFO or device node cannot block the core
/// thread, and a longer file is cut with a marker instead of being loaded
/// whole. The regular-file check runs on the opened handle, not on the path, so
/// swapping the file for a FIFO between check and open cannot slip through; on
/// unix the open itself is non-blocking. The error text is meant for the user's
/// inbox.
fn read_instructions(path: &Path) -> Result<String, String> {
    let unreadable =
        |error: &std::io::Error| format!("Could not read Ompy's instructions: {error}");
    let not_a_file = || {
        format!(
            "Ompy's instructions {} are not a regular file",
            path.display()
        )
    };
    let file = open_instructions(path).map_err(|error| unreadable(&error))?;
    let metadata = file.metadata().map_err(|error| unreadable(&error))?;
    if !metadata.is_file() {
        return Err(not_a_file());
    }
    let cap = u64::try_from(INSTRUCTIONS_MAX_BYTES).unwrap_or(u64::MAX);
    let mut bytes = Vec::with_capacity(
        usize::try_from(metadata.len())
            .unwrap_or(INSTRUCTIONS_MAX_BYTES)
            .min(INSTRUCTIONS_MAX_BYTES),
    );
    file.take(cap.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| unreadable(&error))?;
    let truncated = bytes.len() > INSTRUCTIONS_MAX_BYTES;
    bytes.truncate(INSTRUCTIONS_MAX_BYTES);
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if truncated {
        text.push_str(INSTRUCTIONS_TRUNCATED);
    }
    Ok(text)
}

/// Open the instructions for reading without blocking on a special file.
///
/// A path that was a regular file when inspected can be swapped for a FIFO
/// before the open; a blocking open on a FIFO with no writer would freeze the
/// core thread forever. The handle is validated as a regular file by the caller
/// before anything is read, and regular-file reads ignore the flag.
#[cfg(unix)]
fn open_instructions(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
}

/// On Windows the handle itself is checked before anything is read; there is
/// no blocking open on a FIFO with no writer to guard against.
#[cfg(not(unix))]
fn open_instructions(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::File::open(path)
}

/// Write the bounded instructions text as omp's appended system prompt.
///
/// The snapshot lives in the private persona directory and is replaced
/// atomically, so omp never reads a half-written or unbounded prompt.
fn write_snapshot(path: &Path, text: &str) -> Result<(), String> {
    write_atomic(path, text.as_bytes())
        .map_err(|error| format!("Could not save Ompy's instructions snapshot: {error}"))
}

/// The delay before the next spawn attempt. `uptime` is how long the session
/// that just ended actually ran; a spawn failure passes `None`, so a missing
/// omp only ever backs off further instead of collapsing to one second.
#[must_use]
fn restart_delay_for(backoff: Duration, uptime: Option<Duration>) -> Duration {
    if uptime.is_some_and(|uptime| uptime >= RESTART_RESET) {
        RESTART_MIN
    } else {
        backoff
    }
}

impl Core {
    /// The bounded snapshot file omp is spawned with, next to the state files.
    ///
    /// The persona directory is created owner-only, so the copy of the user's
    /// instructions is not readable by other users.
    fn snapshot_path(&self) -> PathBuf {
        self.paths.persona.join(SNAPSHOT_NAME)
    }

    /// Bring the snapshot omp reads up to date with the user's instructions.
    ///
    /// The bounded text is written to the private snapshot and recorded as
    /// [`Core::instructions_at_spawn`], so change detection and omp's system
    /// prompt always see the same bytes: a change past 64 KiB can never look
    /// like a change, and omp never reads the user's unbounded file itself.
    /// Returns whether omp has a snapshot to read.
    ///
    /// A read error keeps the last good snapshot in place and leaves a notice;
    /// only a first start without any readable file gets a placeholder, so omp
    /// is never handed the user's path or a missing file.
    fn refresh_snapshot(&mut self, now: &Now) -> bool {
        let path = self.snapshot_path();
        let text = match read_instructions(&self.launch.instructions) {
            Ok(text) => text,
            Err(error) => {
                self.report_instructions_error(&error, now);
                if path.is_file() {
                    return true;
                }
                let placeholder = SNAPSHOT_UNAVAILABLE.to_owned();
                if let Err(error) = write_snapshot(&path, &placeholder) {
                    self.report_instructions_error(&error, now);
                }
                return path.is_file();
            }
        };
        if path.is_file() && self.instructions_at_spawn.as_deref() == Some(text.as_str()) {
            self.instructions_error = None;
            return true;
        }
        if let Err(error) = write_snapshot(&path, &text) {
            self.report_instructions_error(&error, now);
            return path.is_file();
        }
        self.instructions_at_spawn = Some(text);
        self.instructions_error = None;
        true
    }

    /// Tell the user about an instructions problem once per distinct message.
    fn report_instructions_error(&mut self, error: &str, now: &Now) {
        if self.instructions_error.as_deref() == Some(error) {
            return;
        }
        self.instructions_error = Some(error.to_owned());
        self.notice(error, now);
    }

    /// Spawn omp for the next generation and forward its events to this loop.
    ///
    /// `detected` is the text already read and installed by instruction-change
    /// detection. It is used as this spawn's snapshot without rereading the
    /// source; ordinary starts pass `None` and refresh it here.
    pub(super) fn start_session(&mut self, now: &Now, detected: Option<String>) {
        let Some(tx) = self.tx.clone() else {
            return;
        };
        let snapshot_ready = match detected {
            Some(text) => {
                self.instructions_at_spawn = Some(text);
                self.snapshot_path().is_file()
            }
            None => self.refresh_snapshot(now),
        };
        if !snapshot_ready {
            // Without a snapshot omp would be started with a path that does
            // not exist; report it like a spawn failure instead.
            self.session_failed(
                "Ompy's instructions snapshot could not be written".into(),
                now,
            );
            return;
        }
        self.gen += 1;
        let gen = self.gen;
        let (events_tx, events_rx) = mpsc::channel();
        let _ = std::thread::Builder::new()
            .name("ompy-events".into())
            .spawn(move || {
                for ev in events_rx {
                    if tx.send(CoreMsg::Session { gen, ev }).is_err() {
                        break;
                    }
                }
            });
        // omp reads the bounded snapshot, never the user's file, so content
        // past the cap cannot reach its system prompt unbounded.
        let launch = Launch {
            instructions: self.snapshot_path(),
            ..self.launch.clone()
        };
        match Session::spawn(
            &launch,
            Arc::clone(&self.rules),
            Arc::clone(&self.next_seq),
            events_tx,
        ) {
            Ok(session) => {
                self.session = Some(session);
                self.last_spawn = std::time::Instant::now();
                self.spawn_error = None;
                self.started = true;
                self.scheduler.handle(Event::Blocked(self.blocked()), now);
                self.broadcast_status();
            }
            Err(error) => {
                self.session_failed(format!("Ompy's omp process did not start: {error}"), now);
            }
        }
    }

    /// Report a start that produced no session: status error, one notice per
    /// outage, then a backed-off retry.
    fn session_failed(&mut self, message: String, now: &Now) {
        eprintln!("[omp-desktopd] {message}");
        self.session = None;
        let first_failure = self.spawn_error.is_none();
        self.spawn_error = Some(message.clone());
        self.started = true;
        self.scheduler.handle(Event::Blocked(true), now);
        if first_failure {
            self.inbox.add(
                ItemKind::Notice,
                message,
                None,
                Vec::new(),
                true,
                None,
                now.utc_ms,
            );
            self.inbox_changed(now);
        }
        let delay = self.restart_delay(None);
        self.schedule_restart(delay);
    }

    /// Grow the restart backoff: 1 s doubling to 5 min, reset only when the
    /// session that just ended had stayed up for [`RESTART_RESET`].
    fn restart_delay(&mut self, uptime: Option<Duration>) -> Duration {
        let delay = restart_delay_for(self.backoff, uptime);
        self.backoff = (delay * 2).min(RESTART_MAX);
        delay
    }

    /// Wake the loop after `delay` so it spawns omp again.
    fn schedule_restart(&self, delay: Duration) {
        let Some(tx) = self.tx.clone() else {
            return;
        };
        let _ = std::thread::Builder::new()
            .name("ompy-restart".into())
            .spawn(move || {
                std::thread::sleep(delay);
                let _ = tx.send(CoreMsg::Restart);
            });
    }

    /// The scheduler's periodic timer: fire the wake-up that came due.
    pub(super) fn on_tick(&mut self, now: &Now) {
        let Some(reason) = self.scheduler.handle(Event::Tick, now) else {
            return;
        };
        let delivered = self.wake(&reason, now);
        // A scheduled wake leaves the queue when it fires. Only a delivered one
        // is gone for good, so the removal is persisted after omp accepted the
        // prompt instead of before.
        if delivered && matches!(reason, WakeReason::Scheduled { .. }) {
            self.persist_schedule(now.utc_ms);
        }
    }

    /// Send one wake-up prompt and publish the resulting busy state.
    ///
    /// Returns whether omp accepted the prompt. A scheduled wake that could not
    /// be delivered goes back into the queue, so the next turn still runs it
    /// instead of losing it to a stdin failure.
    pub(super) fn wake(&mut self, reason: &WakeReason, now: &Now) -> bool {
        let decisions: Vec<String> = self
            .inbox
            .items()
            .iter()
            .filter(|item| item.kind == ItemKind::Decision && item.state == ItemState::Open)
            .map(|item| item.title.clone())
            .collect();
        let tokens_left = self.budget.limit.saturating_sub(self.budget.used);
        self.reload_instructions(now);
        let message = wake::prompt(reason, now.local, tokens_left, &decisions);
        if self.send_prompt(&message, now) {
            self.broadcast_status();
            return true;
        }
        self.scheduler.handle(Event::Busy(false), now);
        if let WakeReason::Scheduled { id, at_ms, note } = reason {
            self.scheduler.restore(Scheduled {
                id: id.clone(),
                at_ms: *at_ms,
                note: note.clone(),
            });
        }
        self.broadcast_status();
        false
    }

    /// Restart the session when the instructions file changed since it was
    /// spawned, so an edit really becomes the system prompt of the next turn.
    ///
    /// Instructions are a system prompt and never part of the wake message: a
    /// wake also carries untrusted schedule notes and decision titles, and an
    /// edit delivered as user text could not revoke text from the old prompt.
    ///
    /// The new snapshot is written before the old session is replaced: only an
    /// installed copy may become the next prompt, and a failed write keeps the
    /// running session with its good snapshot and leaves a notice.
    fn reload_instructions(&mut self, now: &Now) {
        let current = match read_instructions(&self.launch.instructions) {
            Ok(current) => current,
            Err(error) => {
                // A wake must not be consumed silently with no instructions;
                // one notice per distinct error keeps the inbox readable.
                self.report_instructions_error(&error, now);
                return;
            }
        };
        if self.instructions_at_spawn.as_deref() == Some(current.as_str()) {
            self.instructions_error = None;
            return;
        }
        if let Err(error) = write_snapshot(&self.snapshot_path(), &current) {
            self.report_instructions_error(&error, now);
            return;
        }
        self.instructions_error = None;
        self.restart_session(now, current);
    }

    /// Replace the running session so an edited instructions file becomes the
    /// new system prompt. Requests bound to the old process expire with it, as
    /// they do when omp stops for any other reason. `detected` is exactly the
    /// snapshot installed above; a later source edit waits for the next wake.
    ///
    /// The scheduler's busy reservation is kept: the wake that triggered this
    /// restart already holds the scheduler, and the approval the new session
    /// asks for must arrive before a second due wake may start another turn.
    fn restart_session(&mut self, now: &Now, detected: String) {
        if let Some(mut session) = self.session.take() {
            session.kill();
        }
        if self.inbox.expire_all_bound() > 0 {
            self.inbox.add(
                ItemKind::Notice,
                NOTICE_INSTRUCTIONS.into(),
                None,
                Vec::new(),
                false,
                None,
                now.utc_ms,
            );
        }
        self.inbox_changed(now);
        self.start_session(now, Some(detected));
    }

    pub(super) fn on_session(&mut self, gen: u64, ev: SessionEvent, now: &Now) {
        if gen != self.gen {
            return;
        }
        // The event that retired the session can be followed by more events of
        // the same generation that were already queued. A request from a
        // process that no longer exists becomes an inbox item nothing can
        // answer and blocks every later wake; a turn event would leave the
        // scheduler busy forever after the process is gone.
        if self.session.is_none()
            && matches!(
                &ev,
                SessionEvent::UiRequest { .. }
                    | SessionEvent::UiCancel { .. }
                    | SessionEvent::TurnStarted
                    | SessionEvent::TurnEnded
            )
        {
            return;
        }
        match ev {
            SessionEvent::Frame { seq, raw } => self.relay_frame(seq, &raw),
            SessionEvent::Usage(usage) => self.on_usage(&usage, now),
            SessionEvent::TurnStarted => {
                self.scheduler.handle(Event::Busy(true), now);
                self.broadcast_status();
            }
            SessionEvent::TurnEnded => {
                self.scheduler.handle(Event::Busy(false), now);
                self.broadcast_status();
            }
            SessionEvent::UiRequest {
                id,
                kind,
                title,
                body,
                options,
                method,
                ask_questions,
                secret,
            } => {
                let (_, superseded) = self.inbox.add_ui_request(
                    kind,
                    title,
                    body,
                    options,
                    id,
                    method,
                    ask_questions,
                    secret,
                    now.utc_ms,
                );
                if superseded {
                    self.inbox.add(
                        ItemKind::Notice,
                        NOTICE_RPC_REUSED.into(),
                        None,
                        Vec::new(),
                        false,
                        None,
                        now.utc_ms,
                    );
                }
                self.scheduler.handle(Event::Blocked(true), now);
                self.inbox_changed(now);
            }
            SessionEvent::UiCancel { id } => {
                if self.inbox.expire_by_rpc(&id) {
                    self.inbox_changed(now);
                }
                self.scheduler.handle(Event::Blocked(self.blocked()), now);
            }
            SessionEvent::AutoApproved { .. } => {}
            SessionEvent::StdinFailed { reason } | SessionEvent::Exited { reason } => {
                self.on_exited(&reason, now);
            }
        }
    }

    /// Forward one live frame to every attached connection.
    ///
    /// Only the running session's frames are relayed: its stdout can deliver a
    /// few more lines after the exit event that retired it, and those must not
    /// reach clients as if the retired process were still live. Usage from
    /// those events is still accounted for separately.
    pub(super) fn relay_frame(&mut self, seq: u64, raw: &str) {
        if self.session.is_none() {
            return;
        }
        let Ok(frame) = RawValue::from_string(raw.to_owned()) else {
            return;
        };
        let msg = ServerMsg::Rpc { seq, frame };
        let full: Vec<crate::server::ConnId> = self
            .conns
            .iter_mut()
            .filter_map(|(id, conn)| {
                if !conn.attached || seq <= conn.last_seq {
                    return None;
                }
                conn.last_seq = seq;
                (!conn.out.send(&msg)).then_some(*id)
            })
            .collect();
        self.drop_conns(full);
    }

    fn on_usage(&mut self, usage: &Usage, now: &Now) {
        let event = self.budget.add(usage, now.local.date());
        self.persist_budget(now.utc_ms);
        match event {
            Some(BudgetEvent::Warned) => self.notice(NOTICE_WARNED, now),
            Some(BudgetEvent::Exhausted) => {
                self.scheduler.handle(Event::BudgetExhausted(true), now);
                self.notice(NOTICE_EXHAUSTED, now);
            }
            Some(BudgetEvent::Reset) => {
                self.scheduler.handle(Event::BudgetExhausted(false), now);
                self.broadcast_status();
            }
            None => self.broadcast_status(),
        }
    }

    /// omp's stdout ended: expire its open requests and restart with backoff.
    pub(super) fn on_exited(&mut self, reason: &str, now: &Now) {
        let Some(mut session) = self.session.take() else {
            return;
        };
        eprintln!("[omp-desktopd] omp stopped: {reason}");
        session.kill();
        if self.inbox.expire_all_bound() > 0 {
            self.inbox.add(
                ItemKind::Notice,
                NOTICE_EXPIRED.into(),
                None,
                Vec::new(),
                false,
                None,
                now.utc_ms,
            );
        }
        self.scheduler.handle(Event::Blocked(true), now);
        self.scheduler.handle(Event::Busy(false), now);
        self.inbox_changed(now);
        let delay = self.restart_delay(Some(self.last_spawn.elapsed()));
        self.schedule_restart(delay);
    }

    /// Roll the budget onto today's local day before handling a message.
    pub(super) fn roll_budget(&mut self, now: &Now) {
        let today = now.local.date();
        if today == self.budget.day {
            return;
        }
        if self.budget.roll(today) == Some(BudgetEvent::Reset) {
            self.scheduler.handle(Event::BudgetExhausted(false), now);
        }
        self.persist_budget(now.utc_ms);
        self.broadcast_status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Backoff sequence for repeated spawn failures: double, cap at five
    /// minutes, never reset without a session that actually ran.
    #[test]
    fn spawn_failures_back_off_without_collapsing() {
        let mut backoff = RESTART_MIN;
        let mut delays = Vec::new();
        for _ in 0..11 {
            let delay = restart_delay_for(backoff, None);
            delays.push(delay.as_secs());
            backoff = (delay * 2).min(RESTART_MAX);
        }
        assert_eq!(delays, vec![1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300]);
    }

    #[test]
    fn long_uptime_resets_backoff_only_for_a_real_session() {
        assert_eq!(
            restart_delay_for(RESTART_MAX, Some(RESTART_RESET)),
            RESTART_MIN
        );
        assert_eq!(
            restart_delay_for(
                RESTART_MAX,
                Some(RESTART_RESET.checked_sub(Duration::from_secs(1)).unwrap())
            ),
            RESTART_MAX
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_at_the_instructions_path_never_blocks_the_read() {
        use std::os::unix::ffi::OsStrExt;
        use std::sync::mpsc;

        let dir = omp_desktop_core::test_support::tempdir("omp-desktopd", "instructions-fifo");
        let path = dir.join("fifo");
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        // SAFETY: `c_path` is a valid NUL-terminated path in a directory we own.
        let made = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
        assert_eq!(made, 0, "could not create the FIFO at {}", path.display());
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(read_instructions(&path));
        });
        let result = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("reading a FIFO must never block the core thread");
        assert!(result.is_err(), "a FIFO is not a regular file");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn instructions_are_read_bounded_and_only_from_a_regular_file() {
        let dir = omp_desktop_core::test_support::tempdir("omp-desktopd", "instructions");
        let path = dir.join("instructions.md");
        std::fs::write(&path, vec![b'a'; INSTRUCTIONS_MAX_BYTES + 1024]).unwrap();
        let text = read_instructions(&path).unwrap();
        assert_eq!(
            text.len(),
            INSTRUCTIONS_MAX_BYTES + INSTRUCTIONS_TRUNCATED.len(),
            "a long file is cut at the cap with a marker"
        );
        assert!(text.ends_with(INSTRUCTIONS_TRUNCATED));

        std::fs::write(&path, b"short").unwrap();
        assert_eq!(read_instructions(&path).unwrap(), "short");

        // A directory (or any non-file) is refused instead of being read.
        let directory = dir.join("directory");
        std::fs::create_dir(&directory).unwrap();
        assert!(read_instructions(&directory).is_err());
        assert!(read_instructions(&dir.join("missing")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
