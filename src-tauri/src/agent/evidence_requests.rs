//! Observe native Evidence snapshots and keep private host dialogs out of chat.
use std::collections::VecDeque;
use std::process::ChildStdin;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::evidence::EvidenceHost;

pub(super) struct EvidenceReader {
    host: Arc<EvidenceHost>,
    epoch: String,
    private_inputs: PrivateRequests,
}

impl EvidenceReader {
    pub(super) fn new(host: Arc<EvidenceHost>, epoch: String) -> Self {
        Self {
            host,
            epoch,
            private_inputs: PrivateRequests::default(),
        }
    }

    pub(super) fn observe(
        &mut self,
        tab: &str,
        frame: Option<&Value>,
        stdin: &Arc<Mutex<ChildStdin>>,
        alive: &Arc<AtomicBool>,
    ) -> bool {
        let Some(frame) = frame else {
            return false;
        };
        if self.private_inputs.cancelled(frame) {
            return true;
        }
        if self.host.intercept_native(tab, frame, stdin, alive) {
            self.private_inputs.remember(frame);
            return true;
        }
        self.host.observe_snapshot(tab, &self.epoch, frame);
        false
    }

    pub(super) fn forget(&self, tab: &str) {
        self.host.forget_run(tab, Some(&self.epoch));
    }
}

const MAX_PRIVATE_INPUTS: usize = 256;

#[derive(Default)]
struct PrivateRequests {
    ids: VecDeque<String>,
}

impl PrivateRequests {
    fn remember(&mut self, frame: &Value) {
        let Some(id) = frame
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 256)
        else {
            return;
        };
        if self.ids.len() == MAX_PRIVATE_INPUTS {
            let _ = self.ids.pop_front();
        }
        // The frame is dropped before a later timeout cancellation arrives.
        self.ids.push_back(id.to_owned());
    }

    fn cancelled(&mut self, frame: &Value) -> bool {
        if frame.get("type").and_then(Value::as_str) != Some("extension_ui_request")
            || frame.get("method").and_then(Value::as_str) != Some("cancel")
        {
            return false;
        }
        let Some(target) = frame.get("targetId").and_then(Value::as_str) else {
            return false;
        };
        let Some(index) = self.ids.iter().position(|id| id == target) else {
            return false;
        };
        self.ids.remove(index).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn private_timeout_cancel_is_consumed_but_real_questions_are_not() {
        let mut requests = PrivateRequests::default();
        requests.remember(&json!({"id":"private-1"}));
        assert!(!requests.cancelled(
            &json!({"type":"extension_ui_request","method":"cancel","targetId":"question-1"})
        ));
        assert!(!requests.cancelled(
            &json!({"type":"extension_ui_request","method":"confirm","targetId":"private-1"})
        ));
        let cancelled =
            json!({"type":"extension_ui_request","method":"cancel","targetId":"private-1"});
        assert!(requests.cancelled(&cancelled));
        assert!(!requests.cancelled(&cancelled));
    }

    #[test]
    fn retained_timeout_identities_are_bounded_and_new_inputs_remain_matchable() {
        let mut requests = PrivateRequests::default();
        for id in 0..=MAX_PRIVATE_INPUTS {
            requests.remember(&json!({"id": id.to_string()}));
        }
        assert!(!requests
            .cancelled(&json!({"type":"extension_ui_request","method":"cancel","targetId":"0"})));
        assert!(requests.cancelled(&json!({"type":"extension_ui_request","method":"cancel","targetId":MAX_PRIVATE_INPUTS.to_string()})));
        requests.remember(&json!({"id":"x".repeat(257)}));
        assert!(!requests.cancelled(
            &json!({"type":"extension_ui_request","method":"cancel","targetId":"x".repeat(257)})
        ));
    }
}
