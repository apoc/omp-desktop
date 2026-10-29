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
//!
//! The reader hands over its parsed frame (the journal keeps the line itself),
//! so blocks are moved out of it, never copied: a `toolcall_end` carries a
//! whole file write, an `image_end` base64 image data.

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

/// The frames that change the in-flight message.
#[derive(Clone, Copy)]
enum Kind {
    Start,
    Update,
    End,
    AgentEnd,
}

impl Kind {
    fn of(frame: &Value) -> Option<Self> {
        match frame.get("type").and_then(Value::as_str)? {
            "message_start" => Some(Self::Start),
            "message_update" => Some(Self::Update),
            "message_end" => Some(Self::End),
            "agent_end" => Some(Self::AgentEnd),
            _ => None,
        }
    }
}

impl InFlight {
    /// Apply one parsed stdout frame (journal `seq`). Only an assistant
    /// message's `message_start` / `message_update` / `message_end` and
    /// `agent_end` change anything.
    pub fn apply(&mut self, seq: u64, mut frame: Value) {
        let Some(kind) = Kind::of(&frame) else {
            return;
        };
        let is_current = |current: &Snapshot, frame: &Value| {
            frame.get("messageId").and_then(Value::as_str) == Some(current.message_id.as_str())
        };
        match kind {
            Kind::Start => {
                let Some(message) = frame.get_mut("message").map(Value::take) else {
                    return;
                };
                if message.get("role").and_then(Value::as_str) != Some("assistant") {
                    return;
                }
                if let Some(Value::String(message_id)) = frame.get_mut("messageId").map(Value::take)
                {
                    self.current = Some(Snapshot {
                        message_id,
                        seq,
                        message,
                    });
                }
            }
            Kind::Update => {
                let Some(current) = self.current.as_mut().filter(|c| is_current(c, &frame)) else {
                    return;
                };
                if let Some(event) = frame.get_mut("assistantMessageEvent").map(Value::take) {
                    apply_event(&mut current.message, event);
                }
                current.seq = seq;
            }
            Kind::End => {
                if self.current.as_ref().is_some_and(|c| is_current(c, &frame)) {
                    self.current = None;
                }
            }
            // A run never leaves a message open; drop what a lost end stranded.
            Kind::AgentEnd => self.current = None,
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
fn apply_event(message: &mut Value, mut event: Value) {
    /// What an event does to the message; read before its fields move out.
    #[derive(Clone, Copy)]
    enum Step {
        Restart,
        Open,
        Append(&'static str),
        Finish(&'static str),
        /// The whole block, under this field (`toolcall_end`, `image_end`).
        Whole(&'static str),
    }
    let take = |event: &mut Value, field: &str| event.get_mut(field).map(Value::take);
    let step = match event.get("type").and_then(Value::as_str) {
        Some("start") => Step::Restart,
        Some("text_start" | "thinking_start" | "toolcall_start") => Step::Open,
        Some("text_delta") => Step::Append("text"),
        Some("thinking_delta") => Step::Append("thinking"),
        Some("text_end") => Step::Finish("text"),
        Some("thinking_end") => Step::Finish("thinking"),
        Some("toolcall_end") => Step::Whole("toolCall"),
        Some("image_end") => Step::Whole("content"),
        _ => return,
    };
    if matches!(step, Step::Restart) {
        // A restarted message: the frame carries it whole.
        if let Some(restart) = take(&mut event, "message") {
            *message = restart;
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
    match step {
        Step::Restart => {}
        Step::Open => {
            if let Some(block) = take(&mut event, "block") {
                set_block(content, index, block);
            }
        }
        Step::Append(field) => append(content, index, field, event.get("delta")),
        Step::Finish(field) => finish(content, index, field, &mut event),
        Step::Whole(field) => {
            if let Some(block) = take(&mut event, field) {
                set_block(content, index, block);
            }
        }
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
/// block carries (a signature), both moved out of the event.
fn finish(content: &mut [Value], index: usize, field: &str, event: &mut Value) {
    let Some(block) = content.get_mut(index).and_then(Value::as_object_mut) else {
        return;
    };
    if let Some(Value::Object(meta)) = event.get_mut("block").map(Value::take) {
        block.extend(meta.into_iter().filter(|(key, _)| key != field));
    }
    if let Some(text @ Value::String(_)) = event.get_mut("content").map(Value::take) {
        block.insert(field.to_owned(), text);
    }
}

/// The stdout reader's per-line hook, after the line's journal push: takes
/// the parsed frame, the last thing the reader needs it for. Other frames
/// never take the lock; a poisoned lock leaves the state as it is.
pub(super) fn record(state: &std::sync::Mutex<InFlight>, seq: u64, frame: Option<Value>) {
    let Some(frame) = frame.filter(|f| Kind::of(f).is_some()) else {
        return;
    };
    if let Ok(mut state) = state.lock() {
        state.apply(seq, frame);
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

    fn end(id: &str) -> Value {
        json!({ "type": "message_end", "messageId": id })
    }

    /// `frames` applied with journal seqs 1, 2, ….
    fn streamed(frames: impl IntoIterator<Item = Value>) -> InFlight {
        let mut state = InFlight::default();
        for (seq, frame) in (1..).zip(frames) {
            state.apply(seq, frame);
        }
        state
    }

    #[test]
    fn rebuilds_text_thinking_and_tool_calls_from_deltas() {
        let mut s = streamed([
            start("msg-1", "assistant"),
            update(
                "msg-1",
                json!({ "type": "thinking_start", "contentIndex": 0, "block": { "type": "thinking", "thinking": "" } }),
            ),
            update(
                "msg-1",
                json!({ "type": "thinking_delta", "contentIndex": 0, "delta": "hm" }),
            ),
            update(
                "msg-1",
                json!({ "type": "thinking_end", "contentIndex": 0, "content": "hmm", "block": { "type": "thinking", "thinkingSignature": "sig" } }),
            ),
            update(
                "msg-1",
                json!({ "type": "text_start", "contentIndex": 1, "block": { "type": "text", "text": "" } }),
            ),
            update(
                "msg-1",
                json!({ "type": "text_delta", "contentIndex": 1, "delta": "Hel" }),
            ),
            update(
                "msg-1",
                json!({ "type": "text_delta", "contentIndex": 1, "delta": "lo" }),
            ),
            update(
                "msg-1",
                json!({ "type": "toolcall_start", "contentIndex": 2, "block": { "type": "toolCall", "id": "t", "name": "read", "arguments": {} } }),
            ),
            update(
                "msg-1",
                json!({ "type": "toolcall_delta", "contentIndex": 2, "delta": "{\"pa" }),
            ),
        ]);
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
        s.apply(10, update("msg-1", json!({ "type": "toolcall_end", "contentIndex": 2, "toolCall": { "type": "toolCall", "id": "t", "name": "read", "arguments": { "path": "a" } } })));
        s.apply(11, update("msg-1", json!({ "type": "image_end", "contentIndex": 3, "content": { "type": "image", "data": "AA==" } })));
        let content = &s.snapshot().unwrap().message["content"];
        assert_eq!(content[2]["arguments"]["path"], "a");
        assert_eq!(content[3]["data"], "AA==");
    }

    #[test]
    fn the_end_event_text_wins_over_what_the_deltas_built() {
        let s = streamed([
            start("msg-1", "assistant"),
            update(
                "msg-1",
                json!({ "type": "text_start", "contentIndex": 0, "block": { "type": "text", "text": "" } }),
            ),
            update(
                "msg-1",
                json!({ "type": "text_delta", "contentIndex": 0, "delta": "Hel" }),
            ),
            update(
                "msg-1",
                json!({ "type": "text_end", "contentIndex": 0, "content": "Hello", "block": { "type": "text" } }),
            ),
        ]);
        assert_eq!(
            s.snapshot().unwrap().message["content"],
            json!([{ "type": "text", "text": "Hello" }])
        );
    }

    #[test]
    fn a_restart_replaces_the_message_whole() {
        let s = streamed([
            start("msg-1", "assistant"),
            update(
                "msg-1",
                json!({ "type": "text_start", "contentIndex": 0, "block": { "type": "text", "text": "" } }),
            ),
            update(
                "msg-1",
                json!({ "type": "text_delta", "contentIndex": 0, "delta": "stale" }),
            ),
            update(
                "msg-1",
                json!({ "type": "start", "message": { "role": "assistant", "content": [{ "type": "text", "text": "fresh" }] } }),
            ),
        ]);
        assert_eq!(
            s.snapshot().unwrap().message["content"],
            json!([{ "type": "text", "text": "fresh" }])
        );
    }

    #[test]
    fn only_the_open_assistant_message_is_kept_until_its_end() {
        let mut s = streamed([start("msg-1", "user")]);
        assert_eq!(s.snapshot(), None, "a user message is not streamed");
        s.apply(2, start("msg-2", "assistant"));
        // A record nested inside the reply (its own id) neither ends nor feeds it.
        s.apply(3, update("msg-3", json!({ "type": "text_start", "contentIndex": 0, "block": { "type": "text", "text": "x" } })));
        s.apply(4, end("msg-3"));
        let snap = s.snapshot().unwrap();
        assert_eq!((snap.message_id.as_str(), snap.seq), ("msg-2", 2));
        assert_eq!(snap.message["content"], json!([]));
        s.apply(5, end("msg-2"));
        assert_eq!(s.snapshot(), None);
        s.apply(6, start("msg-4", "assistant"));
        s.apply(7, json!({ "type": "agent_end" }));
        assert_eq!(
            s.snapshot(),
            None,
            "agent_end drops a message whose end was lost"
        );
    }

    #[test]
    fn malformed_events_leave_the_message_as_it_was() {
        let mut s = streamed([start("msg-1", "assistant")]);
        for event in [
            json!({ "type": "text_delta", "contentIndex": 0, "delta": "no block yet" }),
            json!({ "type": "text_delta", "delta": "no index" }),
            json!({ "contentIndex": 0 }),
            json!({ "type": "text_end", "contentIndex": 5, "content": "out of range" }),
        ] {
            s.apply(2, update("msg-1", event));
        }
        assert_eq!(s.snapshot().unwrap().message["content"], json!([]));
    }

    #[test]
    fn record_ignores_other_frames() {
        let state = std::sync::Mutex::new(InFlight::default());
        record(&state, 1, Some(json!({ "type": "turn_start" })));
        record(&state, 2, None);
        assert_eq!(state.lock().unwrap().snapshot(), None);
        record(&state, 3, Some(start("msg-1", "assistant")));
        assert_eq!(state.lock().unwrap().snapshot().unwrap().seq, 3);
    }
}
