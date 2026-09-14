use std::process::{Child, ChildStdin};
use std::sync::{Arc, Mutex};

use super::journal::EventJournal;
use super::supervisor::ProcessSupervisor;

/// Per-session state held inside `AgentBridge.sessions`.
pub(super) struct BridgeInner {
    /// Generation token bumped every time a session is started for this id.
    /// Reader threads carry their own generation and only mutate the map
    /// when it still matches — a stale thread for a previous incarnation
    /// must never clobber the entry of a freshly started session that
    /// happens to share an id.
    pub(super) gen: u64,
    /// Stdin wrapped in its own mutex so writes never serialize through
    /// the bridge map lock. A blocked write on a slow consumer can no
    /// longer deadlock concurrent `start_session` / `stop_session` calls.
    pub(super) stdin: Option<Arc<Mutex<ChildStdin>>>,
    /// Live child handle. Cleared once reaped on a background thread.
    pub(super) child: Option<Child>,
    /// Kills the whole process tree (subagents, tool-call children) when
    /// dropped or explicitly told to — plain `child.kill()` above only
    /// signals the direct `omp` process. `None` once handed off to the
    /// reaper thread alongside `child`.
    pub(super) supervisor: Option<ProcessSupervisor>,
    /// Bounded ring of this session's emitted lines, stamped with a
    /// monotonic `seq`. Survives regardless of whether a frontend listener
    /// is currently attached — see [`crate::agent::journal`].
    pub(super) journal: Arc<Mutex<EventJournal>>,
}
