//! `WidgetHost`: the Tauri managed state that owns widget scheduling.
//!
//! One scheduler thread owns the pure [`Scheduler`] and everything that
//! mutates it. Every input (IPC commands, session hooks, worker results)
//! arrives as a [`Msg`] on one `mpsc` inbox; between messages the thread
//! sleeps in `recv_timeout` until the scheduler's next interval deadline.
//! Actions are executed on that thread: `Start` spawns one worker thread per
//! run, `Kill` kills a registered process tree, `Changed`/`Removed` update the
//! shared snapshot and emit `widgets://run` / `widgets://removed`.
//!
//! Locks are short: the run registry is held only to insert, remove or kill;
//! the snapshot only to copy in or out. No lock is held across a run.
//!
//! Approval is enforced here, not in the webview: the scheduler only starts
//! plugins whose current fingerprint is approved, and every worker recomputes
//! the fingerprint right before spawning and runs the verified copies of the
//! plugin's scripts that hash to it (`snapshot.rs`), never the checked
//! script paths. A mismatch (script edited after approval) spawns nothing,
//! reports an error outcome, marks the plugin unapproved and re-emits
//! `widgets://config`. See `trust.rs` for the threat model.
//!
//! The config is read once at startup and on `widgets_reload` only.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::ser::SerializeStruct as _;
use serde::Serialize;

use crate::recent_projects::now_ms;
use crate::supervisor::ProcessSupervisor;
use crate::widgets::config::{self, PluginEntry, Trigger};
use crate::widgets::context::{self, PluginContext};
use crate::widgets::run;
use crate::widgets::schedule::{
    Action, Event, Outcome, Phase, RunKey, RunState, Scheduler, SessionCtx, View,
};
use crate::widgets::snapshot::{Prepared, ScriptStore};
use crate::widgets::trust::{self, Approval, ApprovalStore};

pub const CONFIG_EVENT: &str = "widgets://config";
pub const RUN_EVENT: &str = "widgets://run";
pub const REMOVED_EVENT: &str = "widgets://removed";
pub const ACTIVE_EVENT: &str = "widgets://active";

/// Session ids are UUIDs; anything longer is not one.
const MAX_SESSION_ID_LEN: usize = 128;
/// `widgets_set_view` keeps at most this many hidden plugin ids.
const MAX_HIDDEN_IDS: usize = 64;

pub const CHANGED_ERROR: &str = "plugin changed since it was approved — approve it again";
const STOPPED_ERROR: &str = "widgets are shutting down";
const CANCELLED_ERROR: &str = "run cancelled";
const GONE_ERROR: &str = "plugin or session is no longer available";
const NO_CONFIG_DIR: &str = "the app config directory could not be resolved — widgets are disabled";
const NOT_RUNNING: &str = "the widget scheduler is not running";

// ── seams ───────────────────────────────────────────────────────────────────

/// Where host events go: the Tauri app in production, a capture in tests.
pub trait HostEmitter: Send + Sync + 'static {
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S);
}

impl HostEmitter for tauri::AppHandle {
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
        if let Err(e) = tauri::Emitter::emit(self, event, payload) {
            eprintln!("[omp-desktop] {event}: {e}");
        }
    }
}

/// How sessions are resolved and plugins executed.
pub trait PluginRunner: Send + Sync + 'static {
    fn session_ctx(&self, project: Option<&Path>) -> SessionCtx;
    /// Run `entry` as `argv`, the snapshot of its command the worker checked.
    fn run(
        &self,
        entry: &PluginEntry,
        argv: &[OsString],
        ctx: &PluginContext,
        on_spawn: impl FnOnce(&Arc<ProcessSupervisor>),
    ) -> Outcome;
}

/// The real runner: git context via `context.rs`, processes via `run.rs`.
pub struct ProcessRunner;

impl PluginRunner for ProcessRunner {
    fn session_ctx(&self, project: Option<&Path>) -> SessionCtx {
        context::session_ctx(project)
    }

    fn run(
        &self,
        entry: &PluginEntry,
        argv: &[OsString],
        ctx: &PluginContext,
        on_spawn: impl FnOnce(&Arc<ProcessSupervisor>),
    ) -> Outcome {
        run::run_plugin(entry, argv, ctx, on_spawn)
    }
}

// ── IPC shapes ──────────────────────────────────────────────────────────────

/// Everything `widgets_state` returns; `widgets://config` carries only the
/// flattened [`ConfigView`].
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetsSnapshot {
    #[serde(flatten)]
    pub config: ConfigView,
    pub active: ActiveView,
    pub runs: Vec<RunView>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    pub config_path: Option<String>,
    /// File-level problem: nothing runs.
    pub fatal: Option<String>,
    /// Per-entry problems; the other entries still load.
    pub errors: Vec<String>,
    pub plugins: Vec<PluginView>,
}

/// One configured plugin as the rail sees it. The entry is shared with the
/// workers that run it, so serialising reads through the `Arc`.
#[derive(Debug, Clone)]
pub struct PluginView {
    pub entry: Arc<PluginEntry>,
    pub approval: Approval,
    pub fingerprint: String,
}

impl Serialize for PluginView {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let e = &*self.entry;
        let mut s = serializer.serialize_struct("PluginView", 8)?;
        s.serialize_field("id", &e.id)?;
        s.serialize_field("title", &e.title)?;
        s.serialize_field("scope", &e.scope)?;
        s.serialize_field("enabled", &e.enabled)?;
        s.serialize_field("approval", &self.approval)?;
        s.serialize_field("command", &e.command)?;
        s.serialize_field("insert", &e.insert)?;
        s.serialize_field("fingerprint", &self.fingerprint)?;
        s.end()
    }
}

/// The active session and the plugins applicable to it (enabled, approved,
/// matching; visibility and hidden toggles ignored) — what the Settings page
/// offers toggles for. Emitted as `widgets://active` whenever it changes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveView {
    pub session_id: Option<String>,
    pub applicable: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunView {
    /// Session id, or `__global__`.
    pub key: String,
    pub plugin_id: String,
    pub seq: u64,
    pub phase: Phase,
    pub last: Option<LastView>,
    pub last_ok_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastView {
    /// Epoch ms.
    pub at: u64,
    pub stdout: Option<String>,
    pub error: Option<String>,
    pub duration_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemovedEvent<'a> {
    key: &'a str,
    plugin_id: &'a str,
}

/// `widgets_set_view` argument, validated by [`sanitize_view`].
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewArgs {
    pub session_id: Option<String>,
    pub rail_visible: bool,
    pub window_visible: bool,
    #[serde(default)]
    pub hidden: Vec<String>,
}

/// Hidden ids keep only well-formed plugin ids, at most [`MAX_HIDDEN_IDS`]; a
/// session id that cannot be one (empty, over [`MAX_SESSION_ID_LEN`]) becomes
/// `None`. A well-formed but unknown session is passed on: the scheduler runs
/// nothing for it and activates it only once `SessionOpened` arrives, which
/// closes the race between a tab's first view and its `start_session` hook.
fn sanitize_view(args: ViewArgs) -> View {
    View {
        session: args
            .session_id
            .filter(|s| (1..=MAX_SESSION_ID_LEN).contains(&s.len())),
        rail_visible: args.rail_visible,
        window_visible: args.window_visible,
        hidden: args
            .hidden
            .into_iter()
            .filter(|id| config::id_ok(id))
            .take(MAX_HIDDEN_IDS)
            .collect(),
    }
}

// ── shared state ────────────────────────────────────────────────────────────

/// A run between `Start` and its worker's return. `supervisor` is set once
/// the process exists; a slot removed before that (kill) makes the worker
/// skip the spawn, or kill the tree the moment it registers.
struct Slot {
    seq: u64,
    supervisor: Option<Arc<ProcessSupervisor>>,
    /// Actual conversation context, including a globally scoped plugin run.
    session: String,
}

struct Worker {
    session: String,
    handle: JoinHandle<()>,
}

#[derive(Default)]
struct Snapshot {
    config: ConfigView,
    active: ActiveView,
    runs: HashMap<RunKey, RunView>,
}

struct Shared<E, R> {
    emitter: E,
    runner: R,
    /// The verified copies of plugin scripts that runs execute.
    scripts: ScriptStore,
    registry: Mutex<HashMap<RunKey, Slot>>,
    snapshot: Mutex<Snapshot>,
    /// Set by `kill_all`: nothing is spawned afterwards.
    stopped: AtomicBool,
}

/// Poison only means another thread panicked mid-update of a plain map; the
/// map itself is still valid, and refusing to kill processes would be worse.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl<E, R> Shared<E, R> {
    fn is_live(&self, key: &RunKey, seq: u64) -> bool {
        lock(&self.registry).get(key).is_some_and(|s| s.seq == seq)
    }

    fn register(&self, key: &RunKey, seq: u64, supervisor: &Arc<ProcessSupervisor>) {
        let mut registry = lock(&self.registry);
        match registry.get_mut(key) {
            Some(slot) if slot.seq == seq && !self.stopped.load(Ordering::Acquire) => {
                slot.supervisor = Some(Arc::clone(supervisor));
            }
            // Killed between the liveness check and the spawn.
            _ => supervisor.kill_tree(),
        }
    }

    fn release(&self, key: &RunKey, seq: u64) {
        let mut registry = lock(&self.registry);
        if registry.get(key).is_some_and(|s| s.seq == seq) {
            registry.remove(key);
        }
    }

    fn kill(&self, key: &RunKey) {
        let slot = lock(&self.registry).remove(key);
        if let Some(supervisor) = slot.and_then(|s| s.supervisor) {
            supervisor.kill_tree();
        }
    }

    fn kill_session(&self, session: &str) {
        lock(&self.registry).retain(|_, slot| {
            if slot.session != session {
                return true;
            }
            if let Some(supervisor) = &slot.supervisor {
                supervisor.kill_tree();
            }
            false
        });
    }

    fn kill_all(&self) {
        // Before draining, so a worker registering after the drain sees it.
        self.stopped.store(true, Ordering::Release);
        for (_, slot) in lock(&self.registry).drain() {
            if let Some(supervisor) = slot.supervisor {
                supervisor.kill_tree();
            }
        }
    }

    fn snapshot(&self) -> WidgetsSnapshot {
        let snap = lock(&self.snapshot);
        // Copied out so the lock is released before IPC serialises it.
        WidgetsSnapshot {
            config: snap.config.clone(),
            active: snap.active.clone(),
            runs: snap.runs.values().cloned().collect(),
        }
    }
}

// ── host ────────────────────────────────────────────────────────────────────

enum Msg {
    Event(Event),
    SessionStarted {
        session: String,
        project: Option<PathBuf>,
    },
    SessionClosed {
        session: String,
        reply: SyncSender<()>,
    },
    BranchChanged(String),
    View(ViewArgs),
    Reload(SyncSender<WidgetsSnapshot>),
    Approve {
        plugin_id: String,
        fingerprint: String,
        reply: SyncSender<Result<WidgetsSnapshot, String>>,
    },
    /// A worker found the plugin's fingerprint no longer approved.
    FingerprintChanged {
        plugin_id: String,
        fingerprint: String,
    },
    Shutdown,
}

/// Rail widget scheduling, process ownership and approval gating. Managed by
/// Tauri as `Arc<WidgetHost>`; see the module docs.
pub struct WidgetHost<E: HostEmitter = tauri::AppHandle, R: PluginRunner = ProcessRunner> {
    shared: Arc<Shared<E, R>>,
    /// `None` when the scheduler thread could not be started.
    tx: Option<Sender<Msg>>,
    thread: Option<JoinHandle<()>>,
}

impl WidgetHost {
    /// The production host: events go to `app`, plugins run as processes.
    pub fn for_app(
        app: tauri::AppHandle,
        config_path: Option<PathBuf>,
        approvals_path: Option<PathBuf>,
        runs_dir: Option<PathBuf>,
    ) -> Self {
        Self::new(app, ProcessRunner, config_path, approvals_path, runs_dir)
    }
}

impl<E: HostEmitter, R: PluginRunner> WidgetHost<E, R> {
    /// Start the scheduler thread, which loads the config first. `None`
    /// paths (no app config dir) leave widgets disabled with a `fatal`; no
    /// `runs_dir` (no app cache dir) fails every run that needs a script
    /// copy, since a plugin's scripts run only from verified copies
    /// (`snapshot.rs`).
    pub fn new(
        emitter: E,
        runner: R,
        config_path: Option<PathBuf>,
        approvals_path: Option<PathBuf>,
        runs_dir: Option<PathBuf>,
    ) -> Self {
        let shared = Arc::new(Shared {
            emitter,
            runner,
            scripts: ScriptStore::new(runs_dir),
            registry: Mutex::new(HashMap::new()),
            snapshot: Mutex::new(Snapshot::default()),
            stopped: AtomicBool::new(false),
        });
        let (tx, rx) = mpsc::channel();
        let core = Core {
            shared: Arc::clone(&shared),
            // The thread hands its own sender to every worker; the host keeps
            // this one for the public methods.
            tx: tx.clone(),
            sched: Scheduler::new(),
            config_path,
            approvals: ApprovalStore::load(approvals_path),
            projects: HashMap::new(),
            config: ConfigView::default(),
            active: ActiveView::default(),
            workers: Vec::new(),
        };
        let spawned = thread::Builder::new()
            .name("widgets-scheduler".to_owned())
            .spawn(move || core.run(&rx));
        match spawned {
            Ok(handle) => Self {
                shared,
                tx: Some(tx),
                thread: Some(handle),
            },
            Err(e) => {
                lock(&shared.snapshot).config.fatal =
                    Some(format!("could not start the widget scheduler: {e}"));
                Self {
                    shared,
                    tx: None,
                    thread: None,
                }
            }
        }
    }

    fn send(&self, msg: Msg) {
        if let Some(tx) = &self.tx {
            // Fails only once the thread is gone; nothing left to tell.
            let _ = tx.send(msg);
        }
    }

    /// Current config, approvals, active view and runs.
    pub fn state(&self) -> WidgetsSnapshot {
        self.shared.snapshot()
    }

    /// Re-read `widgets.json` and the approvals file; blocks until applied.
    pub fn reload(&self) -> WidgetsSnapshot {
        let (reply, rx) = mpsc::sync_channel(1);
        self.send(Msg::Reload(reply));
        rx.recv().unwrap_or_else(|_| self.state())
    }

    /// Approve `plugin_id` under `fingerprint`, which must equal the
    /// plugin's current fingerprint (the approval card may be stale).
    ///
    /// # Errors
    /// Malformed arguments, unknown id, stale fingerprint, a failed write, or
    /// no scheduler thread.
    pub fn approve(&self, plugin_id: &str, fingerprint: &str) -> Result<WidgetsSnapshot, String> {
        if !config::id_ok(plugin_id) {
            return Err(format!("invalid widget plugin id \"{plugin_id}\""));
        }
        if !trust::is_fingerprint(fingerprint) {
            return Err("invalid widget fingerprint".to_owned());
        }
        let (reply, rx) = mpsc::sync_channel(1);
        self.send(Msg::Approve {
            plugin_id: plugin_id.to_owned(),
            fingerprint: fingerprint.to_owned(),
            reply,
        });
        rx.recv().map_err(|_| NOT_RUNNING.to_owned())?
    }

    /// What the rail shows; see [`sanitize_view`].
    pub fn set_view(&self, view: ViewArgs) {
        self.send(Msg::View(view));
    }

    /// Manual refresh of one card. Malformed ids are dropped.
    pub fn refresh(&self, plugin_id: &str) {
        if config::id_ok(plugin_id) {
            self.send(Msg::Event(Event::Manual {
                plugin_id: plugin_id.to_owned(),
            }));
        }
    }

    /// A tab's omp session started (or restarted) in `project`. Its git
    /// context is computed on the scheduler thread.
    pub fn session_started(&self, session: &str, project: Option<&Path>) {
        self.send(Msg::SessionStarted {
            session: session.to_owned(),
            project: project.map(Path::to_path_buf),
        });
    }

    /// Stop scheduling for the tab, kill every run using its folder (including
    /// global plugins), and wait for its workers to finish before returning.
    pub fn session_closed(&self, session: &str) {
        let (reply, completed) = mpsc::sync_channel(1);
        self.send(Msg::SessionClosed {
            session: session.to_owned(),
            reply,
        });
        let _ = completed.recv();
    }

    /// An `agent_end` frame arrived for `session`.
    pub fn turn_ended(&self, session: &str) {
        self.send(Msg::Event(Event::TurnEnd {
            session: session.to_owned(),
        }));
    }

    /// `session`'s `.git/HEAD` changed; the context is recomputed.
    pub fn branch_changed(&self, session: &str) {
        self.send(Msg::BranchChanged(session.to_owned()));
    }

    /// Kill every running plugin's process tree now, on the calling thread,
    /// and refuse every later spawn. For app exit and the updater relaunch,
    /// where `Drop` never runs.
    pub fn kill_all(&self) {
        self.shared.kill_all();
    }
}

impl<E: HostEmitter, R: PluginRunner> Drop for WidgetHost<E, R> {
    fn drop(&mut self) {
        self.kill_all();
        if let Some(tx) = self.tx.take() {
            let _ = tx.send(Msg::Shutdown);
        }
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

// ── scheduler thread ────────────────────────────────────────────────────────

/// Owned by the scheduler thread.
struct Core<E: HostEmitter, R: PluginRunner> {
    shared: Arc<Shared<E, R>>,
    tx: Sender<Msg>,
    sched: Scheduler,
    config_path: Option<PathBuf>,
    approvals: ApprovalStore,
    /// Project of every started session, for branch refreshes.
    projects: HashMap<String, Option<PathBuf>>,
    config: ConfigView,
    /// Last emitted `widgets://active`.
    active: ActiveView,
    /// Retained even after a run is cancelled, until its worker has stopped.
    workers: Vec<Worker>,
}

/// A run handed to a worker thread.
struct Job {
    key: RunKey,
    seq: u64,
    entry: Arc<PluginEntry>,
    approved: String,
    ctx: PluginContext,
}

fn error_outcome(error: impl Into<String>) -> Outcome {
    Outcome {
        result: Err(error.into()),
        duration_ms: 0,
    }
}

fn run_view(key: &RunKey, state: &RunState) -> RunView {
    // The snapshot owns copies independent of the scheduler's state.
    RunView {
        key: key.scope_key.clone(),
        plugin_id: key.plugin_id.clone(),
        seq: state.seq,
        phase: state.phase,
        last: state.last.as_ref().map(|f| LastView {
            at: f.at,
            stdout: f.outcome.result.as_ref().ok().cloned(),
            error: f.outcome.result.as_ref().err().cloned(),
            duration_ms: f.outcome.duration_ms,
        }),
        last_ok_at: state.last_ok_at,
    }
}

impl<E: HostEmitter, R: PluginRunner> Core<E, R> {
    fn run(mut self, rx: &Receiver<Msg>) {
        // Before any run: what a killed earlier app left behind, and the
        // script copies of fingerprints no longer approved.
        let approvals = &self.approvals;
        self.shared.scripts.prune(|fp| approvals.holds(fp));
        self.load_config();
        self.sync_active();
        loop {
            let msg = match self.sched.next_deadline() {
                None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
                Some(due) => {
                    let now = now_ms();
                    if due <= now {
                        self.feed(Event::Tick);
                        self.sync_active();
                        continue;
                    }
                    rx.recv_timeout(Duration::from_millis(due - now))
                }
            };
            match msg {
                Ok(Msg::Shutdown) | Err(RecvTimeoutError::Disconnected) => return,
                Ok(msg) => self.handle(msg),
                Err(RecvTimeoutError::Timeout) => self.feed(Event::Tick),
            }
            self.sync_active();
        }
    }

    fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Event(event) => self.feed(event),
            Msg::SessionStarted { session, project } => {
                let ctx = self.shared.runner.session_ctx(project.as_deref());
                // The project map and the scheduler each own the id.
                self.projects.insert(session.clone(), project);
                self.feed(Event::SessionOpened { session, ctx });
            }
            Msg::SessionClosed { session, reply } => {
                self.projects.remove(&session);
                self.shared.kill_session(&session);
                let mut index = 0;
                while index < self.workers.len() {
                    if self.workers[index].session == session {
                        let worker = self.workers.swap_remove(index);
                        let _ = worker.handle.join();
                    } else {
                        index += 1;
                    }
                }
                self.feed(Event::SessionClosed { session });
                let _ = reply.send(());
            }
            Msg::BranchChanged(session) => {
                let Some(project) = self.projects.get(&session) else {
                    return;
                };
                let ctx = self.shared.runner.session_ctx(project.as_deref());
                // `Branch` carries the name for deduplication; the refreshed
                // context keeps its own copy for the runs.
                let branch = ctx.branch.clone();
                self.feed(Event::SessionOpened {
                    // Both events own the id.
                    session: session.clone(),
                    ctx,
                });
                self.feed(Event::Branch { session, branch });
            }
            Msg::View(args) => {
                let view = sanitize_view(args);
                self.feed(Event::View(view));
            }
            Msg::Reload(reply) => {
                self.approvals.reload();
                self.load_config();
                self.sync_active();
                let _ = reply.send(self.shared.snapshot());
            }
            Msg::Approve {
                plugin_id,
                fingerprint,
                reply,
            } => {
                let result = self.approve(&plugin_id, &fingerprint);
                self.sync_active();
                let _ = reply.send(result.map(|()| self.shared.snapshot()));
            }
            Msg::FingerprintChanged {
                plugin_id,
                fingerprint,
            } => self.set_fingerprint(&plugin_id, fingerprint),
            Msg::Shutdown => {}
        }
    }

    fn feed(&mut self, event: Event) {
        for action in self.sched.handle(event, now_ms()) {
            match action {
                Action::Start {
                    key,
                    seq,
                    session,
                    trigger,
                } => self.start(key, seq, &session, trigger),
                Action::Kill { key } => self.shared.kill(&key),
                Action::Changed { key } => self.publish_run(key),
                Action::Removed { key } => self.publish_removed(&key),
            }
        }
    }

    fn publish_run(&self, key: RunKey) {
        let Some(state) = self.sched.run(&key) else {
            return;
        };
        let view = run_view(&key, state);
        self.shared.emitter.emit(RUN_EVENT, &view);
        lock(&self.shared.snapshot).runs.insert(key, view);
    }

    fn publish_removed(&self, key: &RunKey) {
        lock(&self.shared.snapshot).runs.remove(key);
        self.shared.emitter.emit(
            REMOVED_EVENT,
            RemovedEvent {
                key: &key.scope_key,
                plugin_id: &key.plugin_id,
            },
        );
    }

    /// Report a run that never reached a worker; arrives as a normal
    /// `Finished` after the current batch of actions.
    fn finish_now(&self, key: RunKey, seq: u64, error: &str) {
        let _ = self.tx.send(Msg::Event(Event::Finished {
            key,
            seq,
            outcome: error_outcome(error),
        }));
    }

    fn start(&mut self, key: RunKey, seq: u64, session: &str, trigger: Trigger) {
        self.workers.retain(|worker| !worker.handle.is_finished());
        if self.shared.stopped.load(Ordering::Acquire) {
            return self.finish_now(key, seq, STOPPED_ERROR);
        }
        let entry = self
            .config
            .plugins
            .iter()
            .find(|p| p.entry.id == key.plugin_id)
            .map(|p| Arc::clone(&p.entry));
        let approved = self.approvals.approved(&key.plugin_id);
        let (Some(entry), Some(approved), Some(ctx)) =
            (entry, approved, self.sched.session_ctx(session))
        else {
            return self.finish_now(key, seq, GONE_ERROR);
        };
        let job = Job {
            ctx: context::plugin_context(ctx, session, trigger),
            approved: approved.to_owned(),
            entry,
            // The registry and the worker each own the key.
            key: key.clone(),
            seq,
        };
        lock(&self.shared.registry).insert(
            key,
            Slot {
                seq,
                supervisor: None,
                session: session.to_owned(),
            },
        );

        // The job travels over a one-shot channel so a refused thread leaves
        // it here to be reported, instead of dropping it with the closure.
        let (job_tx, job_rx) = mpsc::sync_channel::<Job>(1);
        let shared = Arc::clone(&self.shared);
        // Each worker reports its result through its own sender.
        let tx = self.tx.clone();
        let spawned = thread::Builder::new()
            .name("widget-run".to_owned())
            .spawn(move || {
                if let Ok(job) = job_rx.recv() {
                    work(&shared, &tx, job);
                }
            });
        match spawned {
            Ok(handle) => {
                self.workers.push(Worker {
                    session: session.to_owned(),
                    handle,
                });
                if let Err(mpsc::SendError(job)) = job_tx.send(job) {
                    self.shared.release(&job.key, seq);
                    self.finish_now(job.key, seq, CANCELLED_ERROR);
                }
            }
            Err(e) => {
                self.shared.release(&job.key, seq);
                self.finish_now(
                    job.key,
                    seq,
                    &format!("could not start a worker thread: {e}"),
                );
            }
        }
    }

    fn load_config(&mut self) {
        let loaded = self
            .config_path
            .as_deref()
            .map_or_else(|| Err(NO_CONFIG_DIR.to_owned()), config::load);
        let (plugins, errors, fatal) = match loaded {
            Ok(c) => (c.plugins, c.errors, None),
            Err(e) => (Vec::new(), Vec::new(), Some(e)),
        };
        self.config.config_path = self
            .config_path
            .as_deref()
            .map(|p| p.to_string_lossy().into_owned());
        self.config.fatal = fatal;
        self.config.errors = errors;
        let approvals = &self.approvals;
        self.config.plugins = plugins
            .into_iter()
            .map(|entry| {
                let fingerprint = trust::fingerprint(&entry);
                PluginView {
                    approval: approvals.status(&entry.id, &fingerprint),
                    fingerprint,
                    entry: Arc::new(entry),
                }
            })
            .collect();
        self.push_config();
    }

    /// Emit and store the config view, then hand the scheduler the plugins
    /// and the approved set.
    fn push_config(&mut self) {
        self.shared.emitter.emit(CONFIG_EVENT, &self.config);
        lock(&self.shared.snapshot).config.clone_from(&self.config);
        let plugins = self
            .config
            .plugins
            .iter()
            .map(|p| Arc::clone(&p.entry))
            .collect();
        let approved: HashSet<String> = self
            .config
            .plugins
            .iter()
            .filter(|p| p.approval == Approval::Approved)
            // The scheduler's set owns its ids.
            .map(|p| p.entry.id.clone())
            .collect();
        self.feed(Event::Config { plugins, approved });
    }

    fn approve(&mut self, plugin_id: &str, presented: &str) -> Result<(), String> {
        let approvals = &mut self.approvals;
        let Some(view) = self
            .config
            .plugins
            .iter_mut()
            .find(|p| p.entry.id == plugin_id)
        else {
            return Err(format!("unknown widget plugin \"{plugin_id}\""));
        };
        let current = trust::fingerprint(&view.entry);
        let result = approvals.approve(plugin_id, presented, &current);
        let approval = approvals.status(plugin_id, &current);
        // A stale card still refreshes the view, so the next card is current.
        let changed = view.fingerprint != current || view.approval != approval;
        view.fingerprint = current;
        view.approval = approval;
        if changed {
            self.push_config();
        }
        result
    }

    fn set_fingerprint(&mut self, plugin_id: &str, fingerprint: String) {
        let Some(view) = self
            .config
            .plugins
            .iter_mut()
            .find(|p| p.entry.id == plugin_id)
        else {
            return;
        };
        let approval = self.approvals.status(plugin_id, &fingerprint);
        if view.fingerprint == fingerprint && view.approval == approval {
            return;
        }
        view.fingerprint = fingerprint;
        view.approval = approval;
        self.push_config();
    }

    /// Emit `widgets://active` if the active session or its applicable
    /// plugins changed since the last emit.
    fn sync_active(&mut self) {
        let (session, applicable) = self.sched.active_applicable();
        if self.active.session_id.as_deref() == session
            && self
                .active
                .applicable
                .iter()
                .map(String::as_str)
                .eq(applicable.iter().copied())
        {
            return;
        }
        self.active = ActiveView {
            session_id: session.map(str::to_owned),
            applicable: applicable.into_iter().map(str::to_owned).collect(),
        };
        self.shared.emitter.emit(ACTIVE_EVENT, &self.active);
        // `widgets_state` reads its own copy.
        lock(&self.shared.snapshot).active.clone_from(&self.active);
    }
}

/// One run on its worker thread: fingerprint check against the verified
/// script copies, spawn of those copies, report.
fn work<E: HostEmitter, R: PluginRunner>(shared: &Shared<E, R>, tx: &Sender<Msg>, job: Job) {
    let Job {
        key,
        seq,
        entry,
        approved,
        ctx,
    } = job;
    let mut changed = None;
    let outcome = match shared.scripts.prepare(&entry, &approved) {
        Err(e) => error_outcome(e),
        Ok(Prepared::Changed(fingerprint)) => {
            changed = Some(fingerprint);
            error_outcome(CHANGED_ERROR)
        }
        // `run` lives to the end of the arm: it may own a scratch directory.
        Ok(Prepared::Ready(run)) if shared.is_live(&key, seq) => {
            shared.runner.run(&entry, &run.argv, &ctx, |supervisor| {
                shared.register(&key, seq, supervisor);
            })
        }
        Ok(Prepared::Ready(_)) => error_outcome(CANCELLED_ERROR),
    };
    shared.release(&key, seq);
    let _ = tx.send(Msg::Event(Event::Finished { key, seq, outcome }));
    if let Some(fingerprint) = changed {
        let _ = tx.send(Msg::FingerprintChanged {
            // The message owns the id; the entry stays shared.
            plugin_id: entry.id.clone(),
            fingerprint,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::sync::Condvar;
    use std::time::Instant;

    const WAIT: Duration = Duration::from_secs(20);

    #[derive(Default)]
    struct Capture {
        events: Mutex<Vec<(String, Value)>>,
        signal: Condvar,
    }

    impl HostEmitter for Arc<Capture> {
        fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
            let value = serde_json::to_value(payload).unwrap();
            self.events.lock().unwrap().push((event.to_owned(), value));
            self.signal.notify_all();
        }
    }

    impl Capture {
        /// First event named `name` satisfying `pred`, waiting up to [`WAIT`].
        fn wait_for(&self, name: &str, pred: impl Fn(&Value) -> bool) -> Value {
            let deadline = Instant::now() + WAIT;
            let mut events = self.events.lock().unwrap();
            loop {
                if let Some((_, v)) = events.iter().find(|(n, v)| n == name && pred(v)) {
                    // Copied out: the capture keeps every event for later checks.
                    return v.clone();
                }
                let left = deadline.saturating_duration_since(Instant::now());
                assert!(!left.is_zero(), "no matching {name} event in {events:#?}");
                events = self.signal.wait_timeout(events, left).unwrap().0;
            }
        }

        /// Every event named `name`, copied out of the lock.
        #[cfg(unix)]
        fn named(&self, name: &str) -> Vec<Value> {
            let events = self.events.lock().unwrap();
            events
                .iter()
                .filter(|(n, _)| n == name)
                .map(|(_, v)| v.clone())
                .collect()
        }
    }

    type TestHost = WidgetHost<Arc<Capture>, ProcessRunner>;

    /// Temp dir holding `widgets.json`, the approvals file and the plugin
    /// scripts; removed on drop (declare it before the host so the host,
    /// and with it every plugin, is gone first).
    struct Fixture(PathBuf);

    impl Fixture {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("omp-widget-host-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }

        /// Shell-quoted absolute path for embedding in a script.
        #[cfg(unix)]
        fn quoted(&self, name: &str) -> String {
            format!("'{}'", self.path(name).display())
        }

        fn write_script(&self, id: &str, body: &str) {
            std::fs::write(self.path(&format!("{id}.sh")), body).unwrap();
        }

        /// Write one script per `(id, body, extra fields)` and a
        /// `widgets.json` running each through `sh`.
        fn config(&self, plugins: Vec<(&str, &str, Value)>) {
            let entries: Vec<Value> = plugins
                .into_iter()
                .map(|(id, body, extra)| {
                    self.write_script(id, body);
                    let script = self.path(&format!("{id}.sh"));
                    let mut entry = json!({
                        "id": id,
                        "title": id,
                        "command": ["sh", script.to_str().unwrap()],
                    });
                    if let (Some(e), Value::Object(x)) = (entry.as_object_mut(), extra) {
                        e.extend(x);
                    }
                    entry
                })
                .collect();
            let file = json!({ "version": 1, "plugins": entries });
            std::fs::write(self.path("widgets.json"), file.to_string()).unwrap();
        }

        fn host(&self) -> (TestHost, Arc<Capture>) {
            let capture = Arc::new(Capture::default());
            let host = WidgetHost::new(
                Arc::clone(&capture),
                ProcessRunner,
                Some(self.path("widgets.json")),
                Some(self.path("widget-approvals.json")),
                Some(self.path("widget-runs")),
            );
            (host, capture)
        }

        /// Start session `s1` in this directory and show it in a visible rail.
        #[cfg(unix)]
        fn open(&self, host: &TestHost) {
            host.session_started("s1", Some(&self.0));
            host.set_view(view(Some("s1")));
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    fn view(session: Option<&str>) -> ViewArgs {
        ViewArgs {
            session_id: session.map(str::to_owned),
            rail_visible: true,
            window_visible: true,
            hidden: Vec::new(),
        }
    }

    #[cfg(unix)]
    fn approve_all(host: &TestHost) {
        // `reload` waits for the scheduler thread, so the config is loaded.
        for plugin in host.reload().config.plugins {
            host.approve(&plugin.entry.id, &plugin.fingerprint).unwrap();
        }
    }

    fn plugin<'a>(snap: &'a WidgetsSnapshot, id: &str) -> &'a PluginView {
        snap.config
            .plugins
            .iter()
            .find(|p| p.entry.id == id)
            .unwrap()
    }

    /// The first `widgets://run` of `id` that finished with stdout.
    #[cfg(unix)]
    fn ran_ok(capture: &Capture, id: &str) -> Value {
        capture.wait_for(RUN_EVENT, |v| {
            v["pluginId"] == id && v["last"]["stdout"].is_string()
        })
    }

    #[cfg(unix)]
    fn eventually(what: &str, mut cond: impl FnMut() -> bool) {
        let deadline = Instant::now() + WAIT;
        while !cond() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[cfg(unix)]
    fn read_pid(path: &Path) -> i32 {
        let mut pid = None;
        eventually("pid file", || {
            pid = std::fs::read_to_string(path)
                .ok()
                .and_then(|s| s.trim().parse().ok());
            pid.is_some()
        });
        pid.unwrap()
    }

    /// Signal 0 checks existence; a zombie still answers it, so on Linux a
    /// `Z` state counts as dead too.
    #[cfg(unix)]
    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 performs no action, it only checks the pid.
        if unsafe { libc::kill(pid, 0) } != 0 {
            return false;
        }
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            return true;
        };
        !stat
            .rsplit(')')
            .next()
            .is_some_and(|rest| rest.trim_start().starts_with('Z'))
    }

    /// A plugin that backgrounds `sleep 30`, records its pid and waits.
    #[cfg(unix)]
    fn sleeper(fx: &Fixture, id: &str) -> String {
        format!(
            "sleep 30 &\necho $! > {}\nwait\necho '{{}}'\n",
            fx.quoted(&format!("{id}.pid"))
        )
    }

    #[test]
    fn view_drops_malformed_session_and_hidden_ids() {
        let v = sanitize_view(ViewArgs {
            session_id: Some("s1".to_owned()),
            rail_visible: true,
            window_visible: false,
            hidden: vec![
                "ok-1".to_owned(),
                "Upper".to_owned(),
                String::new(),
                "../x".to_owned(),
                "a".repeat(33),
                "a".repeat(32),
            ],
        });
        assert_eq!(v.session.as_deref(), Some("s1"));
        assert!(v.rail_visible && !v.window_visible);
        let expected: HashSet<String> = ["ok-1".to_owned(), "a".repeat(32)].into();
        assert_eq!(v.hidden, expected);

        for bad in [String::new(), "x".repeat(MAX_SESSION_ID_LEN + 1)] {
            let v = sanitize_view(ViewArgs {
                session_id: Some(bad),
                ..ViewArgs::default()
            });
            assert_eq!(v.session, None);
        }
    }

    #[test]
    fn view_keeps_at_most_64_hidden_ids() {
        let v = sanitize_view(ViewArgs {
            hidden: (0..100).map(|i| format!("p{i}")).collect(),
            ..ViewArgs::default()
        });
        assert_eq!(v.hidden.len(), MAX_HIDDEN_IDS);
    }

    #[test]
    fn missing_config_dir_is_fatal_and_approves_nothing() {
        let capture = Arc::new(Capture::default());
        let host: TestHost = WidgetHost::new(Arc::clone(&capture), ProcessRunner, None, None, None);
        let snap = host.reload();
        assert_eq!(snap.config.fatal.as_deref(), Some(NO_CONFIG_DIR));
        assert!(snap.config.plugins.is_empty() && snap.config.config_path.is_none());
        let config = capture.wait_for(CONFIG_EVENT, |_| true);
        assert_eq!(config["fatal"], NO_CONFIG_DIR);
        assert!(config.get("runs").is_none(), "config events carry no runs");
        assert!(host.approve("probe", &"0".repeat(64)).is_err());
    }

    #[test]
    fn approve_rejects_unknown_ids_and_malformed_fingerprints() {
        let fx = Fixture::new("approve-args");
        fx.config(vec![("probe", "echo '{}'\n", json!({}))]);
        let (host, _capture) = fx.host();
        let snap = host.reload();
        let fp = &plugin(&snap, "probe").fingerprint;
        assert!(host.approve("other", fp).unwrap_err().contains("unknown"));
        assert!(host.approve("probe", "not-hex").is_err());
        assert!(host.approve("Bad Id", fp).is_err());
        assert_eq!(plugin(&host.state(), "probe").approval, Approval::Pending);
    }

    #[cfg(unix)]
    #[test]
    fn unapproved_plugin_never_spawns_and_runs_once_approved() {
        let fx = Fixture::new("gating");
        let body = format!("touch {}\necho '{{\"ok\":true}}'\n", fx.quoted("ran"));
        fx.config(vec![("probe", body.as_str(), json!({}))]);
        let (host, capture) = fx.host();
        fx.open(&host);

        // `reload` is processed after the view, so any start would be visible.
        let snap = host.reload();
        assert_eq!(plugin(&snap, "probe").approval, Approval::Pending);
        assert!(snap.runs.is_empty());
        assert_eq!(capture.named(RUN_EVENT), Vec::<Value>::new());
        assert!(
            !fx.path("ran").exists(),
            "an unapproved plugin must not run"
        );

        let snap = host
            .approve("probe", &plugin(&snap, "probe").fingerprint)
            .unwrap();
        assert_eq!(plugin(&snap, "probe").approval, Approval::Approved);
        let run = ran_ok(&capture, "probe");
        assert_eq!(run["key"], "s1");
        assert_eq!(run["last"]["stdout"], "{\"ok\":true}\n");
        assert!(run["last"]["error"].is_null());
        assert!(fx.path("ran").exists());
        let saved: Value =
            serde_json::from_slice(&std::fs::read(fx.path("widget-approvals.json")).unwrap())
                .unwrap();
        assert_eq!(
            saved["approved"]["probe"],
            plugin(&snap, "probe").fingerprint
        );
    }

    #[cfg(unix)]
    #[test]
    fn script_edited_after_approval_is_refused_until_reapproved() {
        let fx = Fixture::new("edited");
        fx.config(vec![("probe", "echo '{\"v\":1}'\n", json!({}))]);
        let (host, capture) = fx.host();
        fx.open(&host);
        approve_all(&host);
        ran_ok(&capture, "probe");
        let first = host.state();
        let old = &plugin(&first, "probe").fingerprint;

        fx.write_script(
            "probe",
            &format!("touch {}\necho '{{\"v\":2}}'\n", fx.quoted("evil")),
        );
        host.refresh("probe");
        capture.wait_for(RUN_EVENT, |v| v["last"]["error"] == CHANGED_ERROR);
        let config = capture.wait_for(CONFIG_EVENT, |v| v["plugins"][0]["approval"] == "changed");
        assert_ne!(config["plugins"][0]["fingerprint"], old.as_str());
        assert!(!fx.path("evil").exists(), "a changed script must not run");

        assert!(host.approve("probe", old).is_err(), "stale card");
        let changed = host.state();
        host.approve("probe", &plugin(&changed, "probe").fingerprint)
            .unwrap();
        capture.wait_for(RUN_EVENT, |v| v["last"]["stdout"] == "{\"v\":2}\n");
        assert!(fx.path("evil").exists());
    }

    #[cfg(unix)]
    #[test]
    fn session_close_kills_the_plugin_process_tree() {
        let fx = Fixture::new("close");
        fx.config(vec![(
            "probe",
            sleeper(&fx, "probe").as_str(),
            json!({ "timeoutMs": 60_000 }),
        )]);
        let (host, capture) = fx.host();
        fx.open(&host);
        approve_all(&host);
        let pid = read_pid(&fx.path("probe.pid"));
        assert!(alive(pid));

        host.session_closed("s1");
        eventually("the backgrounded sleep to die", || !alive(pid));
        capture.wait_for(REMOVED_EVENT, |v| {
            v["key"] == "s1" && v["pluginId"] == "probe"
        });
        assert!(host.state().runs.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn closing_a_session_waits_for_global_widgets_using_its_checkout() {
        let fx = Fixture::new("close-global-workspace");
        fx.config(vec![(
            "probe",
            sleeper(&fx, "probe").as_str(),
            json!({ "scope": "global", "timeoutMs": 60_000 }),
        )]);
        let (host, _) = fx.host();
        fx.open(&host);
        approve_all(&host);
        let pid = read_pid(&fx.path("probe.pid"));
        assert!(alive(pid));
        host.session_closed("s1");
        assert!(
            !alive(pid),
            "workspace ownership cannot be released while its global widget is still writing"
        );
    }

    #[cfg(unix)]
    #[test]
    fn kill_all_kills_every_run_and_refuses_new_ones() {
        let fx = Fixture::new("kill-all");
        let (a, b) = (sleeper(&fx, "a"), sleeper(&fx, "b"));
        fx.config(vec![
            ("a", a.as_str(), json!({ "timeoutMs": 60_000 })),
            ("b", b.as_str(), json!({ "timeoutMs": 60_000 })),
        ]);
        let (host, capture) = fx.host();
        approve_all(&host);
        fx.open(&host);
        let pids = [read_pid(&fx.path("a.pid")), read_pid(&fx.path("b.pid"))];

        host.kill_all();
        eventually("both trees to die", || pids.iter().all(|&p| !alive(p)));
        capture.wait_for(RUN_EVENT, |v| v["pluginId"] == "a" && v["phase"] == "idle");

        std::fs::remove_file(fx.path("a.pid")).unwrap();
        host.refresh("a");
        capture.wait_for(RUN_EVENT, |v| v["last"]["error"] == STOPPED_ERROR);
        assert!(!fx.path("a.pid").exists(), "nothing spawns after kill_all");
    }

    #[cfg(unix)]
    #[test]
    fn dropping_the_host_kills_running_plugins() {
        let fx = Fixture::new("drop");
        fx.config(vec![(
            "probe",
            sleeper(&fx, "probe").as_str(),
            json!({ "timeoutMs": 60_000 }),
        )]);
        let (host, _capture) = fx.host();
        approve_all(&host);
        fx.open(&host);
        let pid = read_pid(&fx.path("probe.pid"));
        drop(host);
        eventually("the sleep to die", || !alive(pid));
    }

    #[cfg(unix)]
    #[test]
    fn turn_end_runs_plugins_of_the_active_session_only_when_it_ends() {
        let fx = Fixture::new("turn-end");
        let body = format!(
            "echo \"$OMP_WIDGET_TRIGGER\" >> {}\necho '{{}}'\n",
            fx.quoted("log")
        );
        fx.config(vec![(
            "probe",
            body.as_str(),
            json!({ "triggers": ["turn_end"] }),
        )]);
        let (host, capture) = fx.host();
        approve_all(&host);
        fx.open(&host);
        host.reload();
        assert!(!fx.path("log").exists(), "no activate trigger configured");

        host.turn_ended("s1");
        ran_ok(&capture, "probe");
        assert_eq!(
            std::fs::read_to_string(fx.path("log")).unwrap(),
            "turn_end\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_runs_are_capped_with_real_processes() {
        let fx = Fixture::new("cap");
        let log = fx.quoted("log");
        let body = format!("echo s >> {log}\nsleep 2\necho e >> {log}\necho '{{}}'\n");
        let ids = ["p1", "p2", "p3", "p4", "p5", "p6"];
        fx.config(
            ids.iter()
                .map(|id| (*id, body.as_str(), json!({})))
                .collect(),
        );
        let (host, capture) = fx.host();
        approve_all(&host);
        fx.open(&host);
        for id in ids {
            ran_ok(&capture, id);
        }

        let log = std::fs::read_to_string(fx.path("log")).unwrap();
        let (mut running, mut peak, mut starts) = (0usize, 0usize, 0usize);
        for line in log.lines() {
            if line == "s" {
                running += 1;
                starts += 1;
                peak = peak.max(running);
            } else {
                running -= 1;
            }
        }
        assert_eq!(starts, ids.len());
        assert_eq!(
            peak,
            crate::widgets::schedule::MAX_CONCURRENT_RUNS,
            "log: {log}"
        );
        assert!(capture
            .named(RUN_EVENT)
            .iter()
            .any(|v| v["phase"] == "waiting"));
    }

    #[cfg(unix)]
    #[test]
    fn active_view_follows_session_and_approval() {
        let fx = Fixture::new("active");
        fx.config(vec![("probe", "echo '{}'\n", json!({}))]);
        let (host, capture) = fx.host();
        fx.open(&host);
        capture.wait_for(ACTIVE_EVENT, |v| {
            v["sessionId"] == "s1" && v["applicable"] == json!([])
        });

        approve_all(&host);
        capture.wait_for(ACTIVE_EVENT, |v| v["applicable"] == json!(["probe"]));
        assert_eq!(
            host.state().active,
            ActiveView {
                session_id: Some("s1".to_owned()),
                applicable: vec!["probe".to_owned()],
            }
        );

        host.session_closed("s1");
        capture.wait_for(ACTIVE_EVENT, |v| v["sessionId"].is_null());
        let active = capture.named(ACTIVE_EVENT);
        assert!(
            active.windows(2).all(|w| w[0] != w[1]),
            "unchanged values are not re-emitted: {active:#?}"
        );
    }

    /// A tab's first view can reach the host before its `start_session`
    /// hook: nothing runs for the unknown session, and it activates once the
    /// session starts.
    #[cfg(unix)]
    #[test]
    fn view_naming_an_unstarted_session_activates_when_it_starts() {
        let fx = Fixture::new("pending-view");
        fx.config(vec![("probe", "echo '{}'\n", json!({}))]);
        let (host, capture) = fx.host();
        approve_all(&host);
        host.set_view(view(Some("s1")));
        let snap = host.reload();
        assert!(snap.runs.is_empty(), "unknown session runs nothing");
        assert_eq!(snap.active.session_id, None);

        host.session_started("s1", Some(&fx.0));
        assert_eq!(ran_ok(&capture, "probe")["key"], "s1");
    }
}
