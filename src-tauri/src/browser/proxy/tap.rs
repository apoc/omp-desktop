//! The panel's only source of "the agent worked in page X": a read-only
//! observer of the CDP messages on one proxy connection, fed in causal order
//! by its [`feed`](super::feed).
//!
//! One [`Tap`] per connection. From the messages it keeps a
//! `sessionId`-to-`targetId` map and reports the intent commands of a fixed
//! list. It runs on the connection's observer thread, never on a thread
//! that forwards messages.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};

use serde::Deserialize;

use super::feed::Direction;
use super::AgentTarget;
use crate::browser::wire::{parse, Envelope, SessionId, Str};

/// Requests awaiting their reply, and live sessions, kept at most.
const MAX_PENDING: usize = 1024;
const MAX_SESSIONS: usize = 4096;

/// A command whose reply names something the tap needs.
enum Request {
    /// `Target.createTarget`: the reply names the new page.
    Create,
    /// `Target.attachToTarget`: the reply names the session of this target.
    Attach(String),
}

/// The requests in flight. A reply, whether result or error, retires its
/// request; past `MAX_PENDING` outstanding ones the one with the lowest id
/// (the oldest: clients count up) is dropped. Completed requests cost
/// nothing, so a slow request outlives any number of fast ones.
#[derive(Default)]
struct Pending(BTreeMap<u64, Request>);

impl Pending {
    fn insert(&mut self, id: u64, request: Request) {
        self.0.insert(id, request);
        if self.0.len() > MAX_PENDING {
            self.0.pop_first();
        }
    }

    fn retire(&mut self, id: u64) -> Option<Request> {
        self.0.remove(&id)
    }
}

pub(super) struct Tap {
    on_target: AgentTarget,
    /// The page of a page-level connection (`/devtools/page/<targetId>`),
    /// the target of its commands that name no session.
    page: Option<String>,
    /// Session to its page; `None` for a session on something else (a frame
    /// or worker).
    sessions: HashMap<String, Option<String>>,
    pending: Pending,
}

impl Tap {
    /// For a connection to `page` (`None`: a browser-level one);
    /// `on_target` is told the page the agent worked in.
    pub(super) fn new(page: Option<&str>, on_target: AgentTarget) -> Self {
        Self {
            on_target,
            page: page.map(str::to_owned),
            sessions: HashMap::new(),
            pending: Pending::default(),
        }
    }

    /// One complete text message of the connection. `Err` when the tap can
    /// no longer follow it (and must be switched off). Only the envelope is
    /// parsed; `params` and `result` only for the few messages acted on.
    pub(super) fn on_message(
        &mut self,
        direction: Direction,
        message: &str,
    ) -> Result<(), &'static str> {
        let Ok(message) = serde_json::from_str::<Envelope>(message) else {
            return Ok(());
        };
        match direction {
            Direction::Client => {
                self.on_command(&message);
                Ok(())
            }
            Direction::Server => self.on_reply_or_event(&message),
        }
    }

    fn on_command(&mut self, command: &Envelope) {
        let Some(method) = command.method.as_ref().map(Str::as_str) else {
            return;
        };
        match (method, command.id) {
            ("Target.createTarget", Some(id)) => self.pending.insert(id, Request::Create),
            ("Target.attachToTarget", Some(id)) => {
                if let Some(target) = parse::<TargetId>(command.params).map(|p| p.target_id) {
                    self.pending
                        .insert(id, Request::Attach(target.into_owned()));
                }
            }
            _ => {}
        }
        let target = match method {
            "Target.activateTarget" => {
                let target = parse::<TargetId>(command.params).map(|p| p.target_id);
                if let Some(target) = target {
                    (self.on_target)(&target);
                }
                return;
            }
            "Page.navigate"
            | "Page.reload"
            | "Page.navigateToHistoryEntry"
            | "Page.bringToFront"
            | "Page.captureScreenshot" => self.target_of(command),
            _ if method.starts_with("Input.") => self.target_of(command),
            _ => None,
        };
        if let Some(target) = target {
            (self.on_target)(target);
        }
    }

    /// The page a command is for: its session's, or the page-level
    /// connection's own.
    fn target_of(&self, command: &Envelope) -> Option<&str> {
        command
            .session_id
            .as_ref()
            .map(Str::as_str)
            .map_or(self.page.as_deref(), |session| {
                self.sessions.get(session).and_then(Option::as_deref)
            })
    }

    fn on_reply_or_event(&mut self, message: &Envelope) -> Result<(), &'static str> {
        match message.method.as_ref().map(Str::as_str) {
            Some("Target.attachedToTarget") => {
                if let Some(attached) = parse::<Attached>(message.params) {
                    // A session on something else (a frame, a worker) maps to `None`.
                    let page = attached
                        .target_info
                        .filter(|info| info.kind.as_ref().map(Str::as_str) == Some("page"))
                        .and_then(|info| info.target_id)
                        .map(|id| id.0.into_owned());
                    self.sessions.insert(attached.session_id.into_owned(), page);
                }
            }
            Some("Target.detachedFromTarget") => {
                if let Some(detached) = parse::<SessionId>(message.params) {
                    self.sessions.remove(detached.session_id.as_ref());
                }
            }
            Some(_) => {}
            None => self.on_reply(message),
        }
        if self.sessions.len() > MAX_SESSIONS {
            return Err("too many sessions");
        }
        Ok(())
    }

    /// A reply: `Target.createTarget` names the new page (agent intent),
    /// `Target.attachToTarget` the session of its page (no intent: puppeteer
    /// stays attached to every page). Result or error, the reply retires
    /// its request.
    fn on_reply(&mut self, reply: &Envelope) {
        let Some(request) = reply.id.and_then(|id| self.pending.retire(id)) else {
            return;
        };
        // No result: an error reply, nothing was created or attached.
        match request {
            Request::Create => {
                if let Some(created) = parse::<TargetId>(reply.result) {
                    (self.on_target)(&created.target_id);
                }
            }
            Request::Attach(target) => {
                if let Some(attached) = parse::<SessionId>(reply.result) {
                    // The attach event may have named it first (and said what
                    // it is).
                    self.sessions
                        .entry(attached.session_id.into_owned())
                        .or_insert(Some(target));
                }
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetId<'a> {
    #[serde(borrow)]
    target_id: Cow<'a, str>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Attached<'a> {
    #[serde(borrow)]
    session_id: Cow<'a, str>,
    #[serde(borrow)]
    target_info: Option<TargetInfo<'a>>,
}

#[derive(Deserialize)]
struct TargetInfo<'a> {
    #[serde(borrow, rename = "targetId")]
    target_id: Option<Str<'a>>,
    #[serde(borrow, rename = "type")]
    kind: Option<Str<'a>>,
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;

    use serde_json::{json, Value};

    use super::super::feed::Direction;
    use super::super::tests::Reported;
    use super::{Str, Tap, TargetInfo};

    /// A browser-level connection: no page of its own.
    const BROWSER: Option<&str> = None;

    /// A tap on a connection to `page`.
    fn tap_on(page: Option<&str>) -> (Tap, Reported) {
        let reported = Reported::default();
        (Tap::new(page, reported.callback()), reported)
    }

    fn command(tap: &mut Tap, message: &Value) {
        let fed = tap.on_message(Direction::Client, &message.to_string());
        assert_eq!(fed, Ok(()));
    }

    fn server(tap: &mut Tap, message: &Value) -> Result<(), &'static str> {
        tap.on_message(Direction::Server, &message.to_string())
    }

    fn attached(tap: &mut Tap, session: &str, target: &str, kind: &str) {
        let event = json!({ "method": "Target.attachedToTarget", "params": {
            "sessionId": session, "targetInfo": { "targetId": target, "type": kind } } });
        assert_eq!(server(tap, &event), Ok(()));
    }

    fn reply(tap: &mut Tap, message: &Value) {
        assert_eq!(server(tap, message), Ok(()));
    }

    fn in_session(id: u64, method: &str, session: &str) -> Value {
        json!({ "id": id, "method": method, "params": {}, "sessionId": session })
    }

    #[test]
    fn target_info_strings_borrow_from_the_message() {
        let info: TargetInfo = serde_json::from_str(r#"{"targetId":"T1","type":"page"}"#).unwrap();
        assert!(matches!(info.target_id, Some(Str(Cow::Borrowed("T1")))));
        assert!(matches!(info.kind, Some(Str(Cow::Borrowed("page")))));
    }

    #[test]
    fn a_command_in_an_attached_session_names_its_page() {
        let (mut tap, seen) = tap_on(BROWSER);
        attached(&mut tap, "s1", "T1", "page");
        command(&mut tap, &in_session(1, "Page.navigate", "s1"));
        assert_eq!(seen.all(), ["T1"]);
    }

    #[test]
    fn an_attach_reply_names_a_session_but_is_no_intent() {
        let (mut tap, seen) = tap_on(BROWSER);
        command(
            &mut tap,
            &json!({ "id": 7, "method": "Target.attachToTarget",
                "params": { "targetId": "T2", "flatten": true } }),
        );
        reply(
            &mut tap,
            &json!({ "id": 7, "result": { "sessionId": "s2" } }),
        );
        assert!(seen.all().is_empty(), "attached is not worked in");
        command(&mut tap, &in_session(8, "Page.reload", "s2"));
        assert_eq!(seen.all(), ["T2"]);
        command(&mut tap, &in_session(9, "Page.reload", "unknown"));
        assert_eq!(seen.all(), ["T2"], "a session nobody told us about");
    }

    #[test]
    fn a_detached_session_is_forgotten() {
        let (mut tap, seen) = tap_on(BROWSER);
        attached(&mut tap, "s1", "T1", "page");
        reply(
            &mut tap,
            &json!({ "method": "Target.detachedFromTarget", "params": { "sessionId": "s1" } }),
        );
        command(&mut tap, &in_session(1, "Page.navigate", "s1"));
        assert_eq!(seen.all(), Vec::<String>::new());
    }

    #[test]
    fn only_page_sessions_count() {
        let (mut tap, seen) = tap_on(BROWSER);
        attached(&mut tap, "frame", "F1", "iframe");
        command(
            &mut tap,
            &in_session(1, "Input.dispatchMouseEvent", "frame"),
        );
        // The reply to an attach the event already described does not turn
        // it into a page.
        command(
            &mut tap,
            &json!({ "id": 2, "method": "Target.attachToTarget", "params": { "targetId": "F1" } }),
        );
        reply(
            &mut tap,
            &json!({ "id": 2, "result": { "sessionId": "frame" } }),
        );
        command(
            &mut tap,
            &in_session(3, "Input.dispatchMouseEvent", "frame"),
        );
        assert_eq!(seen.all(), Vec::<String>::new());
    }

    #[test]
    fn a_created_page_is_reported_from_the_reply() {
        let (mut tap, seen) = tap_on(BROWSER);
        let create = |id| json!({ "id": id, "method": "Target.createTarget", "params": {} });
        command(&mut tap, &create(3));
        assert!(seen.all().is_empty(), "the page has no id yet");
        reply(
            &mut tap,
            &json!({ "id": 4, "result": { "targetId": "other" } }),
        );
        reply(&mut tap, &json!({ "id": 3, "error": { "message": "no" } }));
        assert!(seen.all().is_empty(), "an unrelated or failed reply");
        command(&mut tap, &create(5));
        reply(
            &mut tap,
            &json!({ "id": 5, "result": { "targetId": "T5" } }),
        );
        reply(
            &mut tap,
            &json!({ "id": 5, "result": { "targetId": "T5" } }),
        );
        assert_eq!(seen.all(), ["T5"], "once; the failed id 3 is retired");
    }

    #[test]
    fn activating_a_target_names_it() {
        let (mut tap, seen) = tap_on(BROWSER);
        command(
            &mut tap,
            &json!({ "id": 1, "method": "Target.activateTarget", "params": { "targetId": "T9" } }),
        );
        assert_eq!(seen.all(), ["T9"]);
    }

    #[test]
    fn only_the_intent_commands_are_reported() {
        let (mut tap, seen) = tap_on(BROWSER);
        attached(&mut tap, "s", "T", "page");
        let intent = [
            "Page.navigate",
            "Page.reload",
            "Page.navigateToHistoryEntry",
            "Page.bringToFront",
            "Page.captureScreenshot",
            "Input.dispatchMouseEvent",
            "Input.dispatchKeyEvent",
            "Input.insertText",
        ];
        let other = [
            "Page.enable",
            "Page.getNavigationHistory",
            "Runtime.evaluate",
            "DOM.getDocument",
            "Target.setAutoAttach",
            "Target.getTargets",
            "Emulation.setDeviceMetricsOverride",
        ];
        for (id, method) in (1..).zip(other) {
            command(&mut tap, &in_session(id, method, "s"));
        }
        assert!(seen.all().is_empty(), "{:?}", seen.all());
        for (id, method) in (100..).zip(intent) {
            command(&mut tap, &in_session(id, method, "s"));
        }
        assert_eq!(seen.all().len(), intent.len());
    }

    #[test]
    fn a_page_level_connection_works_in_its_own_page() {
        let bring = json!({ "id": 1, "method": "Page.bringToFront", "params": {} });
        let (mut tap, seen) = tap_on(Some("B7"));
        command(&mut tap, &bring);
        assert_eq!(seen.all(), ["B7"]);
        let (mut browser, seen) = tap_on(BROWSER);
        command(&mut browser, &bring);
        assert!(
            seen.all().is_empty(),
            "a browser connection has no page of its own"
        );
    }

    #[test]
    fn messages_that_are_not_json_are_ignored() {
        let (mut tap, seen) = tap_on(BROWSER);
        assert_eq!(tap.on_message(Direction::Client, "{not json"), Ok(()));
        assert_eq!(tap.on_message(Direction::Server, "[1,"), Ok(()));
        attached(&mut tap, "s1", "T1", "page");
        command(&mut tap, &in_session(1, "Page.navigate", "s1"));
        assert_eq!(seen.all(), ["T1"]);
    }

    #[test]
    fn pending_requests_are_bounded_oldest_first() {
        let (mut tap, seen) = tap_on(BROWSER);
        for id in 1..=2000 {
            command(
                &mut tap,
                &json!({ "id": id, "method": "Target.createTarget", "params": {} }),
            );
        }
        reply(
            &mut tap,
            &json!({ "id": 1, "result": { "targetId": "old" } }),
        );
        reply(
            &mut tap,
            &json!({ "id": 2000, "result": { "targetId": "new" } }),
        );
        assert_eq!(seen.all(), ["new"]);
    }

    #[test]
    fn a_slow_request_outlives_any_number_of_completed_ones() {
        let (mut tap, seen) = tap_on(BROWSER);
        command(
            &mut tap,
            &json!({ "id": 1, "method": "Target.attachToTarget", "params": { "targetId": "T2" } }),
        );
        for id in 2..=5001 {
            command(
                &mut tap,
                &json!({ "id": id, "method": "Target.createTarget", "params": {} }),
            );
            reply(
                &mut tap,
                &json!({ "id": id, "result": { "targetId": "x" } }),
            );
        }
        assert_eq!(tap.pending.0.len(), 1, "only the slow one is still waiting");
        reply(
            &mut tap,
            &json!({ "id": 1, "result": { "sessionId": "s2" } }),
        );
        command(&mut tap, &in_session(5002, "Page.reload", "s2"));
        assert_eq!(
            seen.all().last().map(String::as_str),
            Some("T2"),
            "its reply was still correlated"
        );
        assert!(tap.pending.0.is_empty());
    }

    #[test]
    fn an_error_reply_retires_its_request() {
        let (mut tap, seen) = tap_on(BROWSER);
        command(
            &mut tap,
            &json!({ "id": 7, "method": "Target.attachToTarget", "params": { "targetId": "T2" } }),
        );
        assert_eq!(tap.pending.0.len(), 1);
        reply(
            &mut tap,
            &json!({ "id": 7, "error": { "code": -32000, "message": "No target" } }),
        );
        assert!(tap.pending.0.is_empty(), "an error is a terminal reply");
        reply(
            &mut tap,
            &json!({ "id": 7, "result": { "sessionId": "s2" } }),
        );
        command(&mut tap, &in_session(8, "Page.reload", "s2"));
        assert!(seen.all().is_empty(), "the retired id correlates nothing");
    }

    #[test]
    fn too_many_sessions_cannot_be_followed() {
        let (mut tap, _) = tap_on(BROWSER);
        for n in 0..super::MAX_SESSIONS {
            attached(&mut tap, &format!("s{n}"), "T", "page");
        }
        let one_more = json!({ "method": "Target.attachedToTarget", "params": {
            "sessionId": "last", "targetInfo": { "targetId": "T", "type": "page" } } });
        assert_eq!(server(&mut tap, &one_more), Err("too many sessions"));
    }
}
