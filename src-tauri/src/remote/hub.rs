//! Registry of authenticated phone sockets: what the desktop publishes goes
//! out to them, what they ask for goes to the webview and its answer comes
//! back by request id. No method blocks on a socket: every connection owns a
//! bounded channel that its own thread drains, and a connection whose
//! channel is full is dropped.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

mod actions;
mod connections;
mod state;
use state::State;

use super::devices::{DeviceStore, PushSubscription};
use super::emit::RemoteEmit;

pub const MAX_PER_DEVICE: usize = 4;
pub const MAX_TOTAL: usize = 8;
pub const MAX_PUSH_PER_DEVICE: usize = 4;
pub const MAX_PENDING_PER_CONN: usize = 16;
pub const ACTION_TIMEOUT: Duration = Duration::from_secs(15);
/// Application close codes.
pub const CLOSE_UNAUTHORIZED: u16 = 4401;
pub const CLOSE_TOO_MANY: u16 = 4429;
pub const CLOSE_NOT_READY: u16 = 4503;

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct TabMeta {
    pub id: String,
    pub title: String,
    pub project: String,
}

#[derive(Deserialize)]
pub struct PublishPayload {
    pub tabs: Vec<TabMeta>,
    pub view: Option<Value>,
    pub theme: Option<Value>,
}

/// What a connection thread is asked to write.
pub enum Out {
    Text(String),
    Close(u16),
}

pub struct Hub {
    devices: Arc<DeviceStore>,
    emit: Arc<dyn RemoteEmit>,
    state: Mutex<State>,
}

pub(super) fn push_key_message(key: Option<&str>) -> String {
    json!({ "t": "push-key", "key": key }).to_string()
}

impl Hub {
    pub fn new(devices: Arc<DeviceStore>, emit: Arc<dyn RemoteEmit>) -> Self {
        Self {
            devices,
            emit,
            state: Mutex::new(State::default()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Run `change` under the lock, then tell the webview what it changed
    /// (connected devices, watch list) with the lock released.
    fn with_state<R>(&self, change: impl FnOnce(&mut State) -> R) -> R {
        let (result, changes) = {
            let mut state = self.lock();
            let result = change(&mut state);
            (result, state.take_changes())
        };
        if let Some(ids) = changes.connected {
            self.emit.connections(&ids);
        }
        if let Some(ids) = changes.watch {
            self.emit.watch(&ids);
        }
        result
    }

    pub fn is_ready(&self) -> bool {
        self.lock().ready
    }

    /// The webview announces itself. Losing it closes every phone socket
    /// (4503): nobody is left to answer their actions.
    pub fn set_ready(&self, ready: bool) {
        self.with_state(|state| {
            if std::mem::replace(&mut state.ready, ready) && !ready {
                state.close_all(CLOSE_NOT_READY);
            }
        });
    }

    pub fn publish(&self, payload: PublishPayload) {
        self.with_state(|state| {
            state.tabs = payload.tabs;
            state.sync_tabs();
            if payload.view != state.view {
                state.view = payload.view;
                let text = json!({ "t": "view", "view": state.view }).to_string();
                state.broadcast(&text);
            }
            if payload.theme != state.theme {
                state.theme = payload.theme;
                let text = json!({ "t": "theme", "theme": state.theme }).to_string();
                state.broadcast(&text);
            }
        });
    }

    /// The title of a published tab.
    pub fn tab_title(&self, id: &str) -> Option<String> {
        let state = self.lock();
        state
            .tabs
            .iter()
            .find(|tab| tab.id == id)
            .map(|tab| tab.title.clone()) // owned for the push message
    }

    /// Set (or withdraw) the push key; phones already connected get the update.
    pub fn set_push_key(&self, key: Option<String>) {
        self.with_state(|state| {
            if state.push_key != key {
                state.broadcast(&push_key_message(key.as_deref()));
                state.push_key = key;
            }
        });
    }

    /// Re-merge the tracker's busy/question state into the tab list.
    pub fn refresh(&self) {
        self.with_state(State::sync_tabs);
    }

    /// Set the Ompy chip's state. The persona relay never reaches the agent
    /// tracker, so its tab is merged from these fields instead. The push key
    /// and push transitions stay untouched.
    pub fn set_persona_activity(&self, busy: bool, has_ask: bool) {
        self.with_state(|state| {
            if (busy, has_ask) != (state.persona_busy, state.persona_has_ask) {
                state.persona_busy = busy;
                state.persona_has_ask = has_ask;
                state.sync_tabs();
            }
        });
    }

    fn finish_push_change(&self, result: Result<(), String>) -> Result<(), String> {
        if result.is_ok() {
            self.emit.connections(&self.connected_devices());
        }
        result
    }

    /// Replace one subscription (same endpoint) or add it, up to the cap.
    pub fn subscribe(&self, device_id: &str, sub: PushSubscription) -> Result<(), String> {
        self.finish_push_change(
            self.devices
                .add_push(device_id, sub, MAX_PUSH_PER_DEVICE)
                .map_err(|err| {
                    if err == "remote device not found" {
                        "unknown device".to_owned()
                    } else {
                        err
                    }
                }),
        )
    }

    pub fn unsubscribe(&self, device_id: &str) -> Result<(), String> {
        self.finish_push_change(self.devices.set_push(device_id, Vec::new()))
    }
}

#[cfg(test)]
impl Hub {
    /// Run `then` while this thread holds the state lock (for tests of what
    /// must not wait for it).
    pub(super) fn while_locked<R>(&self, then: impl FnOnce() -> R) -> R {
        let _held = self.lock();
        then()
    }
}
