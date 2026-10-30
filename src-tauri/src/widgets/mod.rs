//! Rail widget plugins: user-configured executables whose JSON stdout the
//! frontend renders as a rail card. Scheduling and triggers live here, in
//! Rust; the frontend only reports what the rail shows and renders results.
//!
//! - `config.rs` reads `widgets.json`; `schedule.rs` is the pure scheduler
//!   state machine; `trust.rs` fingerprints plugins and stores approvals;
//!   `snapshot.rs` copies a run's scripts while checking that fingerprint.
//! - `host.rs` owns the scheduler thread, the running processes and the
//!   `widgets://` events (managed as `Arc<WidgetHost>`).
//! - `run.rs` (with the crate's `child_run.rs`) executes one plugin; `context.rs` computes a
//!   session's git context; `redact.rs` masks credentials in error text.
//!
//! Output validation lives in the frontend (`src/app/widgets.js`). User docs:
//! `docs/widgets.md`.

use std::sync::Arc;

use tauri::{AppHandle, Manager as _};

pub mod config;
pub mod context;
pub mod host;
pub mod redact;
pub mod run;
pub mod schedule;
pub mod snapshot;
pub mod trust;

pub use host::{ViewArgs, WidgetHost, WidgetsSnapshot};

/// An `agent_end` frame arrived for `session` (called from the agent reader).
pub fn notify_turn_end(app: &AppHandle, session: &str) {
    if let Some(host) = app.try_state::<Arc<WidgetHost>>() {
        host.turn_ended(session);
    }
}

/// `session`'s `.git/HEAD` changed (called from the git watcher).
pub fn notify_branch(app: &AppHandle, session: &str) {
    if let Some(host) = app.try_state::<Arc<WidgetHost>>() {
        host.branch_changed(session);
    }
}

/// Kill every running plugin process now: app exit and the updater
/// relaunch, where managed state is never dropped.
pub fn kill_all(app: &AppHandle) {
    if let Some(host) = app.try_state::<Arc<WidgetHost>>() {
        host.kill_all();
    }
}
