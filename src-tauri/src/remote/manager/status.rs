//! Status assembly and event forwarding for [`super::RemoteManager`].

use std::sync::{Arc, PoisonError, Weak};

use super::core::{Core, Running};
use crate::remote::emit::{Action, DeviceStatus, RemoteEmit, Status};

/// Forwards the hub's events and turns every connection change into a status.
pub(super) struct HubEmit {
    pub core: Weak<Core>,
    pub emit: Arc<dyn RemoteEmit>,
}

impl RemoteEmit for HubEmit {
    fn watch(&self, tab_ids: &[String]) {
        self.emit.watch(tab_ids);
    }

    fn connections(&self, _device_ids: &[String]) {
        if let Some(core) = self.core.upgrade() {
            core.emit_status();
        }
    }

    fn action(&self, action: &Action) {
        self.emit.action(action);
    }

    fn status(&self, status: &Status) {
        self.emit.status(status);
    }
}

impl Core {
    /// Emit the latest status. The snapshot is taken under `emit_lock`, so
    /// concurrent emits reach the webview in snapshot order.
    pub fn emit_status(&self) -> Status {
        let _order = self
            .emit_lock
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let status = self.status_with(&self.hub.connected_devices());
        self.emit.status(&status);
        status
    }

    pub fn emit_status_fn(core: &Weak<Self>) -> Arc<dyn Fn() + Send + Sync> {
        let core = Weak::clone(core);
        Arc::new(move || {
            if let Some(core) = core.upgrade() {
                core.emit_status();
            }
        })
    }

    pub fn status_with(&self, connected: &[String]) -> Status {
        let devices = self
            .devices
            .list()
            .into_iter()
            .map(|device| DeviceStatus {
                connected: connected.contains(&device.id),
                push_subscribed: !device.push.is_empty(),
                id: device.id,
                name: device.name,
                paired_at: device.paired_at,
                last_seen: device.last_seen,
            })
            .collect();
        let state = self.state();
        let run = state.run.as_ref();
        Status {
            enabled: state.settings.enabled,
            listening: run.is_some(),
            url: run.map(Running::base_url),
            ip: run.map(|run| run.ip.to_string()),
            error: state.error.clone(), // owned snapshot
            fingerprint: run.map(|run| run.fingerprint.clone()), // owned snapshot
            devices,
            push_error: self.pusher.last_error(),
            lock_detection: super::super::lock::DETECTION,
            settings: state.settings.clone(), // owned snapshot
        }
    }
}
