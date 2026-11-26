//! Incoming WebSocket message parsing, action validation, and hub dispatch.

use serde_json::Value;

use super::Authed;
use crate::remote::emit::Action;
use crate::remote::hub::Hub;
use crate::remote::push_subs::parse_subscription;

/// Limit for an action's `text`.
const MAX_TEXT: usize = 32 * 1024;
const MAX_ID_LEN: usize = 128;
const MAX_ASK_ID_LEN: usize = 256;
const KINDS: [&str; 4] = ["prompt", "steer", "abort", "answer"];

fn text_field(message: &Value, key: &str) -> Option<String> {
    message.get(key).and_then(Value::as_str).map(str::to_owned)
}

pub(super) fn handle(hub: &Hub, session: &Authed, text: &str) {
    let Ok(message) = serde_json::from_str::<Value>(text) else {
        return;
    };
    match message.get("t").and_then(Value::as_str) {
        Some("select") => {
            if let Some(action) = build_action(session, &message, "select") {
                hub.action(session.conn, &action);
            }
        }
        Some("action") => {
            let kind = text_field(&message, "kind").filter(|kind| KINDS.contains(&kind.as_str()));
            let req_id = text_field(&message, "reqId").unwrap_or_default();
            let action = kind.and_then(|kind| build_action(session, &message, &kind));
            match action {
                Some(action) => hub.action(session.conn, &action),
                None => reject(hub, session, &req_id, "bad request"),
            }
        }
        Some("push-subscribe") => {
            let result = parse_subscription(message.get("sub"))
                .and_then(|sub| hub.subscribe(&session.device.id, sub));
            hub.push_ack(session.conn, &result);
        }
        Some("push-unsubscribe") => {
            hub.push_ack(session.conn, &hub.unsubscribe(&session.device.id));
        }
        _ => {}
    }
}

/// Answer a refused request through the hub's own ack path.
fn reject(hub: &Hub, session: &Authed, req_id: &str, error: &str) {
    if req_id.is_empty() {
        return;
    }
    hub.reject(session.conn, req_id, error);
}

fn build_action(session: &Authed, message: &Value, kind: &str) -> Option<Action> {
    let req_id =
        text_field(message, "reqId").filter(|id| !id.is_empty() && id.len() <= MAX_ID_LEN)?;
    let tab_id =
        text_field(message, "tabId").filter(|id| !id.is_empty() && id.len() <= MAX_ID_LEN)?;
    let text = text_field(message, "text").filter(|text| text.len() <= MAX_TEXT);
    if message.get("text").is_some_and(|raw| !raw.is_null()) && text.is_none() {
        return None;
    }
    let ask_id = text_field(message, "askId").filter(|id| id.len() <= MAX_ASK_ID_LEN);
    if message.get("askId").is_some_and(|raw| !raw.is_null()) && ask_id.is_none() {
        return None;
    }
    if kind == "answer"
        && !message
            .as_object()
            .is_some_and(|object| object.contains_key("value"))
    {
        return None;
    }
    let value = message.get("value").cloned(); // owned for the webview event
    if value
        .as_ref()
        .is_some_and(|value| value.to_string().len() > MAX_TEXT)
    {
        return None;
    }
    Some(Action {
        req_id,
        device_id: session.device.id.clone(), // the action outlives the session borrow
        tab_id,
        kind: kind.to_owned(),
        text,
        ask_id,
        value,
        dispatched_at: None,
    })
}
