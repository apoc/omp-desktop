use std::process::{Child, ChildStdin};
use std::sync::{Arc, Mutex};

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
}
