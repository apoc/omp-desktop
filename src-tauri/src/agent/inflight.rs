//! The assistant message omp is streaming right now, rebuilt from the
//! `message_update` delta frames (`docs/architecture/turn-status.md`).
//!
//! Every omp process runs with `set_event_filter { messageUpdates: "delta" }`
//! (sent by `start_session`), so a `message_update` carries only its
//! increment: a frame the frontend never sees cannot be made up by a later
//! one. A background tab's frames wait in the event journal, whose ring a
//! long reply overflows; a reactivated tab whose replay came back `dropped`
//! would show the streaming reply without everything before the gap. The
//! stdout reader therefore applies every message frame here as well, and the
//! frontend seeds that bubble from [`InFlight::snapshot`] (`streaming_message`
//! command): `seq` names the last frame applied, so the frontend skips the
//! message's replayed frames at or below it and applies only newer ones.
//! Like [`super::ext_ui`], it lives on the session's map entry and ends with
//! the process.

use serde_json::Value;

/// The in-flight assistant message of one session, if any.
#[derive(Debug, Default)]
pub struct InFlight {
    current: Option<Snapshot>,
}

/// One in-flight message: what `streaming_message` returns.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// omp's per-process id of the message (`msg-<n>`).
    pub message_id: String,
    /// Journal `seq` of the last frame applied.
    pub seq: u64,
    /// The message as streamed so far (`content` rebuilt from the deltas).
    pub message: Value,
}

impl InFlight {
    /// Apply one parsed stdout frame (journal `seq`). Only an assistant
    /// message's `message_start` / `message_update` / `message_end` and
    /// `agent_end` change anything.
    pub fn apply(&mut self, seq: u64, frame_type: &str, frame: &Value) {
        let message_id = frame.get("messageId").and_then(Value::as_str);
        match frame_type {
            "message_start" => {
                let message = frame.get("message");
                if message.and_then(|m| m.get("role")).and_then(Value::as_str) != Some("assistant")
                {
                    return;
                }
                if let (Some(id), Some(message)) = (message_id, message) {
                    self.current = Some(Snapshot {
                        message_id: id.to_owned(),
                        seq,
                        // The start frame's message is small (no content
                        // streamed yet); the updates grow this copy in place.
                        message: message.clone(),
                    });
                }
            }
            "message_update" => {
                let Some(current) = self
                    .current
                    .as_mut()
                    .filter(|c| Some(c.message_id.as_str()) == message_id)
                else {
                    return;
                };
                if let Some(event) = frame.get("assistantMessageEvent") {
                    apply_event(&mut current.message, event);
                }
                current.seq = seq;
            }
            "message_end" => {
                if self
                    .current
                    .as_ref()
                    .is_some_and(|c| Some(c.message_id.as_str()) == message_id)
                {
                    self.current = None;
                }
            }
            // A run never leaves a message open; drop what a lost end stranded.
            "agent_end" => self.current = None,
            _ => {}
        }
    }

    pub fn snapshot(&self) -> Option<Snapshot> {
        self.current.clone()
    }
}

/// Apply one delta `assistantMessageEvent` to `message`: omp's
/// `messageUpdates: "delta"` projection (`rpc-session-events.ts` `toDelta`).
/// Tool-call argument deltas are not kept: the arguments arrive whole with
/// `toolcall_end`, and nothing shows them before that.
fn apply_event(message: &mut Value, event: &Value) {
    let Some(kind) = event.get("type").and_then(Value::as_str) else {
        return;
    };
    if kind == "start" {
        // A restarted message: the frame carries it whole.
        if let Some(restart) = event.get("message") {
            restart.clone_into(message);
        }
        return;
    }
    let Some(index) = event
        .get("contentIndex")
        .and_then(Value::as_u64)
        .and_then(|i| usize::try_from(i).ok())
    else {
        return;
    };
    let Some(content) = content_mut(message) else {
        return;
    };
    match kind {
        "text_start" | "thinking_start" | "toolcall_start" => {
            if let Some(block) = event.get("block") {
                set_block(content, index, block.clone());
            }
        }
        "text_delta" => append(content, index, "text", event.get("delta")),
        "thinking_delta" => append(content, index, "thinking", event.get("delta")),
        "text_end" => finish(content, index, "text", event),
        "thinking_end" => finish(content, index, "thinking", event),
        "toolcall_end" => {
            if let Some(call) = event.get("toolCall") {
                set_block(content, index, call.clone());
            }
        }
        "image_end" => {
            if let Some(image) = event.get("content") {
                set_block(content, index, image.clone());
            }
        }
        _ => {}
    }
}

fn content_mut(message: &mut Value) -> Option<&mut Vec<Value>> {
    let object = message.as_object_mut()?;
    let content = object
        .entry("content")
        .or_insert_with(|| Value::Array(Vec::new()));
    if !content.is_array() {
        *content = Value::Array(Vec::new());
    }
    content.as_array_mut()
}

/// Put `block` at `index`, padding with `null` up to it.
fn set_block(content: &mut Vec<Value>, index: usize, block: Value) {
    if index >= content.len() {
        content.resize(index + 1, Value::Null);
    }
    content[index] = block;
}

/// Append a delta to the block's `field` string.
fn append(content: &mut [Value], index: usize, field: &str, delta: Option<&Value>) {
    let (Some(block), Some(delta)) = (
        content.get_mut(index).and_then(Value::as_object_mut),
        delta.and_then(Value::as_str),
    ) else {
        return;
    };
    match block.get_mut(field) {
        Some(Value::String(text)) => text.push_str(delta),
        _ => {
            block.insert(field.to_owned(), Value::String(delta.to_owned()));
        }
    }
}

/// `text_end` / `thinking_end`: the final text (`content`) plus what only the
/// block carries (a signature).
fn finish(content: &mut [Value], index: usize, field: &str, event: &Value) {
    let Some(block) = content.get_mut(index).and_then(Value::as_object_mut) else {
        return;
    };
    if let Some(meta) = event.get("block").and_then(Value::as_object) {
        for (key, value) in meta {
            if key != field {
                block.insert(key.clone(), value.clone());
            }
        }
    }
    if let Some(text) = event.get("content").and_then(Value::as_str) {
        block.insert(field.to_owned(), Value::String(text.to_owned()));
    }
}

/// The stdout reader's per-line hook, after the line's journal push. A
/// poisoned lock leaves the state as it is.
pub(super) fn record(
    state: &std::sync::Mutex<InFlight>,
    seq: u64,
    frame_type: Option<&str>,
    frame: Option<&Value>,
) {
    let (
        Some(frame_type @ ("message_start" | "message_update" | "message_end" | "agent_end")),
        Some(frame),
    ) = (frame_type, frame)
    else {
        return;
    };
    if let Ok(mut state) = state.lock() {
        state.apply(seq, frame_type, frame);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn update(id: &str, event: Value) -> Value {
        json!({ "type": "message_update", "messageId": id, "message": { "role": "assistant" }, "assistantMessageEvent": event })
    }

    fn start(id: &str, role: &str) -> Value {
        json!({ "type": "message_start", "messageId": id, "message": { "role": role, "content": [], "timestamp": 7 } })
    }

    fn streamed(state: &mut InFlight, frames: &[(&str, Value)]) {
        for (seq, (kind, frame)) in (1..).zip(frames) {
            state.apply(seq, kind, frame);
        }
    }

    #[test]
    fn rebuilds_text_thinking_and_tool_calls_from_deltas() {
        let mut s = InFlight::default();
        streamed(
            &mut s,
            &[
                ("message_start", start("msg-1", "assistant")),
                (
                    "message_update",
                    update(
                        "msg-1",
                        json!({ "type": "thinking_start", "contentIndex": 0, "block": { "type": "thinking", "thinking": "" } }),
                    ),
                ),
                (
                    "message_update",
                    update(
                        "msg-1",
                        json!({ "type": "thinking_delta", "contentIndex": 0, "delta": "hm" }),
                    ),
                ),
                (
                    "message_update",
                    update(
                        "msg-1",
                        json!({ "type": "thinking_end", "contentIndex": 0, "content": "hmm", "block": { "type": "thinking", "thinkingSignature": "sig" } }),
                    ),
                ),
                (
                    "message_update",
                    update(
                        "msg-1",
                        json!({ "type": "text_start", "contentIndex": 1, "block": { "type": "text", "text": "" } }),
                    ),
                ),
                (
                    "message_update",
                    update(
                        "msg-1",
                        json!({ "type": "text_delta", "contentIndex": 1, "delta": "Hel" }),
                    ),
                ),
                (
                    "message_update",
                    update(
                        "msg-1",
                        json!({ "type": "text_delta", "contentIndex": 1, "delta": "lo" }),
                    ),
                ),
                (
                    "message_update",
                    update(
                        "msg-1",
                        json!({ "type": "toolcall_start", "contentIndex": 2, "block": { "type": "toolCall", "id": "t", "name": "read", "arguments": {} } }),
                    ),
                ),
                (
                    "message_update",
                    update(
                        "msg-1",
                        json!({ "type": "toolcall_delta", "contentIndex": 2, "delta": "{\"pa" }),
                    ),
                ),
            ],
        );
        let snap = s.snapshot().unwrap();
        assert_eq!(snap.message_id, "msg-1");
        assert_eq!(snap.seq, 9);
        assert_eq!(snap.message["timestamp"], 7);
        assert_eq!(
            snap.message["content"],
            json!([
                { "type": "thinking", "thinking": "hmm", "thinkingSignature": "sig" },
                { "type": "text", "text": "Hello" },
                { "type": "toolCall", "id": "t", "name": "read", "arguments": {} },
            ])
        );
        s.apply(10, "message_update", &update("msg-1", json!({ "type": "toolcall_end", "contentIndex": 2, "toolCall": { "type": "toolCall", "id": "t", "name": "read", "arguments": { "path": "a" } } })));
        assert_eq!(
            s.snapshot().unwrap().message["content"][2]["arguments"]["path"],
            "a"
        );
    }

    #[test]
    fn a_restart_replaces_the_message_whole() {
        let mut s = InFlight::default();
        streamed(
            &mut s,
            &[
                ("message_start", start("msg-1", "assistant")),
                (
                    "message_update",
                    update(
                        "msg-1",
                        json!({ "type": "text_start", "contentIndex": 0, "block": { "type": "text", "text": "" } }),
                    ),
                ),
                (
                    "message_update",
                    update(
                        "msg-1",
                        json!({ "type": "text_delta", "contentIndex": 0, "delta": "stale" }),
                    ),
                ),
                (
                    "message_update",
                    update(
                        "msg-1",
                        json!({ "type": "start", "message": { "role": "assistant", "content": [{ "type": "text", "text": "fresh" }] } }),
                    ),
                ),
            ],
        );
        assert_eq!(
            s.snapshot().unwrap().message["content"],
            json!([{ "type": "text", "text": "fresh" }])
        );
    }

    #[test]
    fn only_the_open_assistant_message_is_kept_until_its_end() {
        let mut s = InFlight::default();
        s.apply(1, "message_start", &start("msg-1", "user"));
        assert_eq!(s.snapshot(), None, "a user message is not streamed");
        s.apply(2, "message_start", &start("msg-2", "assistant"));
        // A record nested inside the reply (its own id) neither ends nor feeds it.
        s.apply(3, "message_update", &update("msg-3", json!({ "type": "text_start", "contentIndex": 0, "block": { "type": "text", "text": "x" } })));
        s.apply(
            4,
            "message_end",
            &json!({ "type": "message_end", "messageId": "msg-3" }),
        );
        let snap = s.snapshot().unwrap();
        assert_eq!((snap.message_id.as_str(), snap.seq), ("msg-2", 2));
        assert_eq!(snap.message["content"], json!([]));
        s.apply(
            5,
            "message_end",
            &json!({ "type": "message_end", "messageId": "msg-2" }),
        );
        assert_eq!(s.snapshot(), None);
        s.apply(6, "message_start", &start("msg-4", "assistant"));
        s.apply(7, "agent_end", &json!({ "type": "agent_end" }));
        assert_eq!(
            s.snapshot(),
            None,
            "agent_end drops a message whose end was lost"
        );
    }

    #[test]
    fn malformed_events_leave_the_message_as_it_was() {
        let mut s = InFlight::default();
        s.apply(1, "message_start", &start("msg-1", "assistant"));
        for event in [
            json!({ "type": "text_delta", "contentIndex": 0, "delta": "no block yet" }),
            json!({ "type": "text_delta", "delta": "no index" }),
            json!({ "contentIndex": 0 }),
            json!({ "type": "text_end", "contentIndex": 5, "content": "out of range" }),
        ] {
            s.apply(2, "message_update", &update("msg-1", event));
        }
        assert_eq!(s.snapshot().unwrap().message["content"], json!([]));
    }

    #[test]
    fn record_ignores_other_frames() {
        let state = std::sync::Mutex::new(InFlight::default());
        record(
            &state,
            1,
            Some("turn_start"),
            Some(&json!({ "type": "turn_start" })),
        );
        record(&state, 2, Some("message_start"), None);
        assert_eq!(state.lock().unwrap().snapshot(), None);
        record(
            &state,
            3,
            Some("message_start"),
            Some(&start("msg-1", "assistant")),
        );
        assert_eq!(state.lock().unwrap().snapshot().unwrap().seq, 3);
    }
}
