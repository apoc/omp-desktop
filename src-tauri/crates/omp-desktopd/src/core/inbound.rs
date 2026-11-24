//! Client messages: status, settings, inbox answers, schedules and frame
//! relays.

use super::Core;
use crate::budget::BudgetState;
use crate::scheduler::{Event, Now, ScheduleError};
use crate::server::{ConnId, Inbound};
use chrono::NaiveTime;
use omp_desktop_core::persona_protocol::{
    AskQuestionRef, ClientMsg, InboxItem, ItemKind, NotifyKind, PersonaSettings, ServerMsg,
};
use serde_json::value::RawValue;
use serde_json::{json, Value};
use std::sync::Arc;

impl Core {
    pub(super) fn on_inbound(&mut self, inbound: Inbound, now: &Now) {
        let Inbound {
            conn,
            req,
            msg,
            reservation: _reservation,
            ..
        } = inbound;
        // The guard travels with the message and drops at the end of this
        // handler, returning its bytes to the server-wide budget.
        match msg {
            ClientMsg::Status => {
                let data = serde_json::to_value(self.status_info()).unwrap_or(Value::Null);
                self.reply_ok(conn, req, Some(data));
            }
            ClientMsg::Attach { after_seq } => {
                self.attach(conn, after_seq);
                self.reply_ok(conn, req, None);
            }
            ClientMsg::Detach => {
                if let Some(client) = self.conns.get_mut(&conn) {
                    client.attached = false;
                }
                self.reply_ok(conn, req, None);
            }
            ClientMsg::Rpc { frame } => self.on_rpc(conn, req, &frame, now),
            ClientMsg::Pause => {
                self.paused = true;
                self.scheduler.handle(Event::Paused(true), now);
                self.broadcast_status();
                self.reply_ok(conn, req, None);
            }
            ClientMsg::Resume => {
                self.paused = false;
                self.scheduler.handle(Event::Paused(false), now);
                self.broadcast_status();
                self.reply_ok(conn, req, None);
            }
            ClientMsg::WakeNow => {
                if let Some(reason) = self.scheduler.handle(Event::WakeNow, now) {
                    self.wake(&reason, now);
                }
                self.broadcast_status();
                self.reply_ok(conn, req, None);
            }
            ClientMsg::SetSettings { settings } => self.on_settings(conn, req, settings, now),
            ClientMsg::InboxResolve { id, answer } => {
                self.on_resolve(conn, req, &id, answer.as_deref(), now);
            }
            ClientMsg::ScheduleWake { at_ms, in_ms, note } => {
                self.on_schedule(conn, req, at_ms, in_ms, note, now);
            }
            ClientMsg::ListSchedule => {
                let data = json!({
                    "scheduled": self.scheduler.scheduled(),
                    "nextIntervalMs": self.scheduler.next_interval_ms(),
                });
                self.reply_ok(conn, req, Some(data));
            }
            ClientMsg::CancelWake { id } => self.on_cancel(conn, req, &id),
            ClientMsg::Notify {
                kind,
                title,
                body,
                options,
                urgent,
            } => self.on_notify(conn, req, kind, title, body, options, urgent, now),
            ClientMsg::Hello { .. } => self.reply_err(conn, req, "hello was already handled"),
        }
    }

    fn reply_ok(&mut self, conn: ConnId, req: Option<u64>, data: Option<Value>) {
        let Some(req) = req else {
            return;
        };
        self.send_to(
            conn,
            &ServerMsg::Reply {
                req,
                ok: true,
                data,
                error: None,
            },
        );
    }

    fn reply_err(&mut self, conn: ConnId, req: Option<u64>, error: &str) {
        let Some(req) = req else {
            return;
        };
        self.send_to(
            conn,
            &ServerMsg::Reply {
                req,
                ok: false,
                data: None,
                error: Some(error.into()),
            },
        );
    }

    fn on_rpc(&mut self, conn: ConnId, req: Option<u64>, frame: &Value, now: &Now) {
        let inbox_answer = if frame.get("type").and_then(Value::as_str)
            == Some("extension_ui_response")
        {
            frame.get("id").and_then(Value::as_str).map(|id| {
                let cancelled = frame.get("cancelled").and_then(Value::as_bool) == Some(true);
                let answer = if cancelled {
                    None
                } else {
                    Some(ui_answer(frame))
                };
                (id.to_owned(), answer)
            })
        } else {
            None
        };
        if self.send_frame(&frame.to_string(), now) {
            if let Some((id, answer)) = inbox_answer {
                if self.inbox.resolve_by_rpc(&id, answer).is_some() {
                    self.scheduler.handle(Event::Blocked(self.blocked()), now);
                    self.inbox_changed(now);
                }
            }
            self.reply_ok(conn, req, None);
        } else {
            self.reply_err(conn, req, "Ompy is not running");
        }
    }

    fn on_settings(
        &mut self,
        conn: ConnId,
        req: Option<u64>,
        settings: PersonaSettings,
        now: &Now,
    ) {
        if let Err(error) = validate(&settings) {
            self.reply_err(conn, req, error);
            return;
        }
        self.settings = settings;
        self.writes.settings = true;
        self.writes.budget = true;
        self.persist_settings();
        self.scheduler
            .handle(Event::Settings(self.settings.clone()), now);
        self.budget.set_limit(self.settings.daily_token_limit);
        self.scheduler.handle(
            Event::BudgetExhausted(self.budget.state() == BudgetState::Exhausted),
            now,
        );
        self.persist_budget();
        self.broadcast_status();
        self.reply_ok(conn, req, None);
    }

    fn on_resolve(
        &mut self,
        conn: ConnId,
        req: Option<u64>,
        id: &str,
        answer: Option<&str>,
        now: &Now,
    ) {
        let Some(item) = self.inbox.open(id) else {
            self.reply_err(conn, req, "no open inbox item with that id");
            return;
        };
        if let Some(answer) = answer {
            if item.rpc_request_id.is_some() {
                let frame = match Self::respond(item, answer) {
                    Ok(frame) => frame,
                    Err(error) => {
                        self.reply_err(conn, req, error);
                        return;
                    }
                };
                if !self.send_frame(&frame.to_string(), now) {
                    self.reply_err(conn, req, "Ompy is not running; answer was not delivered");
                    return;
                }
            } else if item.kind == ItemKind::Decision {
                let message = format!("[ompy decision] {}: {answer}", item.title);
                if !self.send_prompt(&message, now) {
                    self.reply_err(conn, req, "Ompy is not running; answer was not delivered");
                    return;
                }
            }
        } else if let Some(rpc) = item.rpc_request_id.clone() {
            if !self.dismiss(&rpc, now) {
                self.reply_err(conn, req, "Ompy is not running; dismissal was not delivered");
                return;
            }
        }
        let Some(item) = self.inbox.resolve(id, answer.map(str::to_owned)) else {
            self.reply_err(conn, req, "no open inbox item with that id");
            return;
        };
        self.scheduler.handle(Event::Blocked(self.blocked()), now);
        self.inbox_changed(now);
        self.reply_ok(conn, req, Some(json!({ "id": item.id })));
    }

    /// Withdraw omp's request `rpc` because the user dismissed its inbox item.
    fn dismiss(&mut self, rpc: &str, now: &Now) -> bool {
        let frame = json!({
            "type": "extension_ui_response",
            "id": rpc,
            "cancelled": true,
        });
        self.send_frame(&frame.to_string(), now)
    }

    /// Build the response shape belonging to the original omp request.
    fn respond(item: &InboxItem, answer: &str) -> Result<Value, &'static str> {
        let rpc = item
            .rpc_request_id
            .as_deref()
            .ok_or("inbox item has no omp request id")?;
        match item.request_method.as_deref() {
            Some("confirm") => Ok(json!({
                "type": "extension_ui_response",
                "id": rpc,
                "confirmed": answer == "Confirm",
            })),
            Some("ask") => {
                let questions = item
                    .ask_questions
                    .as_deref()
                    .filter(|questions| !questions.is_empty())
                    .ok_or("ask request has no questions")?;
                let answers = if questions.len() == 1 && !questions[0].multi {
                    vec![ask_answer(&questions[0], answer)]
                } else if questions.len() > 1 {
                    let answers_per_question: Vec<String> = serde_json::from_str(answer)
                        .map_err(|_| "ask answer must be a JSON array of per-question strings")?;
                    if answers_per_question.len() != questions.len() {
                        return Err("ask answer must contain one string per question");
                    }
                    questions
                        .iter()
                        .zip(&answers_per_question)
                        .map(|(question, answer)| ask_answer(question, answer))
                        .collect()
                } else {
                    return Err("multi-select ask answers are not supported");
                };
                Ok(json!({
                    "type": "extension_ui_response",
                    "id": rpc,
                    "answers": answers,
                }))
            }
            Some("select" | "input" | "editor") | None => Ok(json!({
                "type": "extension_ui_response",
                "id": rpc,
                "value": answer,
            })),
            Some(_) => Err("unsupported omp request method"),
        }
    }

    fn on_schedule(
        &mut self,
        conn: ConnId,
        req: Option<u64>,
        at_ms: Option<i64>,
        in_ms: Option<i64>,
        note: String,
        now: &Now,
    ) {
        let at = match (at_ms, in_ms) {
            (Some(at), None) => at,
            (None, Some(in_ms)) if in_ms > 0 => now.utc_ms.saturating_add(in_ms),
            (None, Some(_)) => {
                self.reply_err(conn, req, "inMs must be positive");
                return;
            }
            (None, None) => {
                self.reply_err(conn, req, "one of atMs or inMs is required");
                return;
            }
            (Some(_), Some(_)) => {
                self.reply_err(conn, req, "atMs and inMs are mutually exclusive");
                return;
            }
        };
        match self.scheduler.add(at, note, now) {
            Ok(id) => {
                self.writes.schedule = true;
                self.persist_schedule();
                self.broadcast_status();
                self.reply_ok(conn, req, Some(json!({ "id": id })));
            }
            Err(error) => self.reply_err(conn, req, schedule_error(error)),
        }
    }

    fn on_cancel(&mut self, conn: ConnId, req: Option<u64>, id: &str) {
        if self.scheduler.cancel(id) {
            self.writes.schedule = true;
            self.persist_schedule();
            self.broadcast_status();
            self.reply_ok(conn, req, None);
        } else {
            self.reply_err(conn, req, "no scheduled wake with that id");
        }
    }

    #[allow(clippy::too_many_arguments)] // One parameter per `ClientMsg::Notify` field plus `now`.
    fn on_notify(
        &mut self,
        conn: ConnId,
        req: Option<u64>,
        kind: NotifyKind,
        title: String,
        body: Option<String>,
        options: Option<Vec<String>>,
        urgent: bool,
        now: &Now,
    ) {
        let kind = match kind {
            NotifyKind::Result => ItemKind::Result,
            NotifyKind::Decision => ItemKind::Decision,
        };
        let id = self.inbox.add(
            kind,
            title,
            body,
            options.unwrap_or_default(),
            urgent,
            None,
            now.utc_ms,
        );
        self.inbox_changed(now);
        self.reply_ok(conn, req, Some(json!({ "id": id })));
    }

    /// Replay the frames stored after `after_seq` and then keep the connection
    /// on the live stream.
    fn attach(&mut self, conn: ConnId, after_seq: u64) {
        if let Some(client) = self.conns.get_mut(&conn) {
            client.attached = true;
            client.last_seq = client.last_seq.max(after_seq);
        }
        let frames: Vec<(u64, Arc<str>)> = self
            .session
            .as_ref()
            .map_or_else(Vec::new, |session| session.replay_after(after_seq));
        for (seq, raw) in frames {
            if let Ok(frame) = RawValue::from_string(raw.to_string()) {
                self.send_to(conn, &ServerMsg::Rpc { seq, frame });
                if let Some(client) = self.conns.get_mut(&conn) {
                    client.last_seq = seq;
                }
            }
        }
    }
}

/// Map one answer to an exact option label, or preserve it as custom input.
fn ask_answer(question: &AskQuestionRef, answer: &str) -> Value {
    if question.options.iter().any(|option| option == answer) {
        json!({"id": question.id, "selectedOptions": [answer]})
    } else {
        json!({"id": question.id, "selectedOptions": [], "customInput": answer})
    }
}

/// The answer an `extension_ui_response` frame carries.
fn ui_answer(frame: &Value) -> String {
    if let Some(value) = frame.get("value").and_then(Value::as_str) {
        return value.to_owned();
    }
    match frame.get("confirmed").and_then(Value::as_bool) {
        Some(true) => "confirmed".to_owned(),
        Some(false) => "denied".to_owned(),
        None => "answered".to_owned(),
    }
}

/// The user-facing reason a schedule request was refused.
const fn schedule_error(error: ScheduleError) -> &'static str {
    match error {
        ScheduleError::TooMany => "at most 50 wakes may be queued",
        ScheduleError::InPast => "the wake time must be in the future",
        ScheduleError::TooFar => "the wake time must be within 30 days",
        ScheduleError::EmptyNote => "note must not be empty",
    }
}

/// Reject settings the app must not make.
fn validate(settings: &PersonaSettings) -> Result<(), &'static str> {
    if !(5..=1440).contains(&settings.interval_min) {
        return Err("intervalMin must be between 5 and 1440");
    }
    if NaiveTime::parse_from_str(&settings.quiet_start, "%H:%M").is_err() {
        return Err("quietStart must be HH:MM");
    }
    if NaiveTime::parse_from_str(&settings.quiet_end, "%H:%M").is_err() {
        return Err("quietEnd must be HH:MM");
    }
    if settings.daily_token_limit < crate::budget::MIN_LIMIT {
        return Err("dailyTokenLimit must be at least 100000");
    }
    Ok(())
}
