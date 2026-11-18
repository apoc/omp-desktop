//! The persona service's local socket protocol: JSON lines, one object per
//! line, at most [`MAX_LINE_BYTES`].
//!
//! Clients send `Envelope<ClientMsg>`; a request carrying `req` gets exactly
//! one [`ServerMsg::Reply`] with that `req`.
//!
//! Frames the service relays between the app and omp travel as `rpc`
//! messages: the payload is kept as-is (`Box<RawValue>` on the way out,
//! [`serde_json::Value`] on the way in) so the protocol never has to know
//! omp's own frame shapes.

use std::io::{self, BufRead, Write};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;

/// Protocol version exchanged in [`ClientMsg::Hello`] / [`ServerMsg::Hello`].
pub const PROTOCOL: u32 = 1;

/// Longest accepted line, excluding the trailing newline.
pub const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

/// Which side of the desktop the client is: the app UI or an omp extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientKind {
    App,
    Extension,
}

/// One client line: an optional `req` plus the message body, flattened into
/// the same JSON object.
#[derive(Debug, Serialize, Deserialize)]
pub struct Envelope<T> {
    /// Present when the client wants exactly one [`ServerMsg::Reply`] back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub req: Option<u64>,
    /// The message itself.
    #[serde(flatten)]
    pub body: T,
}

/// The persona service's schedule and budget settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonaSettings {
    /// Minimum minutes between two persona turns.
    pub interval_min: u32,
    /// Local quiet-hours start, `"HH:MM"`.
    pub quiet_start: String,
    /// Local quiet-hours end, `"HH:MM"`.
    pub quiet_end: String,
    /// Whether the quiet hours also apply on Saturday and Sunday.
    pub quiet_weekends: bool,
    /// Tokens the persona may spend per local day.
    pub daily_token_limit: u64,
}

impl Default for PersonaSettings {
    fn default() -> Self {
        Self {
            interval_min: 30,
            quiet_start: "20:00".into(),
            quiet_end: "07:00".into(),
            quiet_weekends: true,
            daily_token_limit: 2_000_000,
        }
    }
}

/// Why the service raises a desktop notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotifyKind {
    Result,
    Decision,
}

/// A line sent by an app or extension to the service.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    /// First line on a connection; announces the protocol version.
    Hello { protocol: u32, client: ClientKind },
    /// Ask for the current [`StatusInfo`].
    Status,
    /// Start relaying `rpc` frames queued after `after_seq`.
    Attach {
        #[serde(rename = "afterSeq")]
        after_seq: u64,
    },
    /// Stop relaying frames.
    Detach,
    /// A frame the service should hand to (or from) omp unchanged.
    Rpc { frame: Value },
    /// Stop scheduling persona turns until [`ClientMsg::Resume`].
    Pause,
    /// Resume scheduling persona turns.
    Resume,
    /// Run a persona turn now, ignoring the interval.
    WakeNow,
    /// Replace the service's schedule and budget settings.
    SetSettings { settings: PersonaSettings },
    /// Answer one open inbox item.
    InboxResolve { id: String, answer: Option<String> },
    /// Ask for a persona turn at an absolute or relative time.
    ScheduleWake {
        #[serde(rename = "atMs")]
        at_ms: Option<i64>,
        #[serde(rename = "inMs")]
        in_ms: Option<i64>,
        note: String,
    },
    /// Ask for the scheduled wakes.
    ListSchedule,
    /// Drop one scheduled wake.
    CancelWake { id: String },
    /// Raise a desktop notification.
    Notify {
        kind: NotifyKind,
        title: String,
        body: Option<String>,
        options: Option<Vec<String>>,
        #[serde(default)]
        urgent: bool,
    },
}

/// What an inbox item is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Approval,
    Decision,
    Result,
    Notice,
}

/// Where an inbox item currently stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemState {
    Open,
    Answered,
    Dismissed,
    Expired,
}

/// One item in the persona's inbox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: String,
    pub kind: ItemKind,
    /// Unix milliseconds.
    pub created_at: i64,
    pub title: String,
    pub body: Option<String>,
    /// Answers the human may pick from; empty for plain notices.
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub urgent: bool,
    pub state: ItemState,
    pub answer: Option<String>,
    /// The `rpc_request_id` of the omp request this item answers, if any.
    pub rpc_request_id: Option<String>,
}

/// Snapshot of the service's state, as reported to a [`ClientMsg::Status`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusInfo {
    /// One of `running`, `paused`, `budget_exhausted`, `error`, `starting`.
    pub state: String,
    /// Last error, if `state` is `error`.
    pub error: Option<String>,
    /// Next scheduled persona turn, in Unix milliseconds.
    pub next_wake_ms: Option<i64>,
    pub tokens_today: u64,
    pub daily_token_limit: u64,
    pub open_items: usize,
    pub settings: PersonaSettings,
}

/// A line sent by the service to its clients.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    /// Answer to [`ClientMsg::Hello`].
    Hello { protocol: u32 },
    /// The one answer a `req` gets.
    Reply {
        req: u64,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Answer to [`ClientMsg::Status`].
    Status { status: StatusInfo },
    /// A relayed omp frame, numbered in the connection's replay order.
    Rpc { seq: u64, frame: Box<RawValue> },
    /// The inbox contents.
    Inbox { items: Vec<InboxItem> },
}

/// Outcome of [`read_line_capped`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineRead {
    /// A complete line was read into the buffer, without its newline.
    Line,
    /// The stream ended without further bytes.
    Eof,
    /// The line exceeded [`MAX_LINE_BYTES`]; it was consumed and discarded.
    TooLong,
}

/// Reads one `\n`-terminated line into `buf` (without the newline).
///
/// A line longer than [`MAX_LINE_BYTES`] is consumed up to its newline and
/// reported as [`LineRead::TooLong`], so the next call starts at the next
/// line. A final line without a newline counts as a line.
///
/// # Errors
///
/// Returns the underlying I/O error if reading from `r` fails.
pub fn read_line_capped<R: BufRead>(r: &mut R, buf: &mut Vec<u8>) -> io::Result<LineRead> {
    buf.clear();
    let mut too_long = false;
    loop {
        let chunk = r.fill_buf()?;
        if chunk.is_empty() {
            return Ok(if too_long {
                LineRead::TooLong
            } else if buf.is_empty() {
                LineRead::Eof
            } else {
                LineRead::Line
            });
        }
        let newline = chunk.iter().position(|b| *b == b'\n');
        let take = newline.unwrap_or(chunk.len());
        if !too_long {
            if buf.len() + take > MAX_LINE_BYTES {
                too_long = true;
                buf.clear();
            } else {
                buf.extend_from_slice(&chunk[..take]);
            }
        }
        r.consume(if newline.is_some() { take + 1 } else { take });
        if newline.is_some() {
            return Ok(if too_long {
                LineRead::TooLong
            } else {
                LineRead::Line
            });
        }
    }
}

/// Writes `msg` as one JSON line and flushes.
///
/// # Errors
///
/// Returns the I/O error from writing or flushing, or an [`io::Error`] of
/// kind [`io::ErrorKind::Other`] when `msg` cannot be serialised.
pub fn write_msg<W: Write, T: Serialize>(w: &mut W, msg: &T) -> io::Result<()> {
    let mut line = serde_json::to_vec(msg).map_err(io::Error::other)?;
    line.push(b'\n');
    w.write_all(&line)?;
    w.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn hello_round_trips_with_req() {
        let line = r#"{"req":7,"type":"hello","protocol":1,"client":"extension"}"#;
        let env: Envelope<ClientMsg> = serde_json::from_str(line).unwrap();
        assert_eq!(env.req, Some(7));
        assert!(matches!(
            env.body,
            ClientMsg::Hello {
                protocol: 1,
                client: ClientKind::Extension
            }
        ));
    }

    #[test]
    fn rpc_frame_is_kept_as_json() {
        let line = r#"{"type":"rpc","frame":{"type":"prompt","message":"hi"}}"#;
        let env: Envelope<ClientMsg> = serde_json::from_str(line).unwrap();
        match env.body {
            ClientMsg::Rpc { frame } => {
                assert_eq!(frame, serde_json::json!({"type":"prompt","message":"hi"}));
            }
            _ => panic!("not rpc"),
        }
    }

    #[test]
    fn unknown_type_is_an_error() {
        assert!(serde_json::from_str::<Envelope<ClientMsg>>(r#"{"type":"rm_rf"}"#).is_err());
    }

    #[test]
    fn oversized_line_is_refused_and_next_line_still_reads() {
        let mut data = vec![b'x'; MAX_LINE_BYTES + 10];
        data.extend_from_slice(b"\n{\"type\":\"status\"}\n");
        let mut r = Cursor::new(data);
        let mut buf = Vec::new();
        assert!(matches!(
            read_line_capped(&mut r, &mut buf).unwrap(),
            LineRead::TooLong
        ));
        assert!(matches!(
            read_line_capped(&mut r, &mut buf).unwrap(),
            LineRead::Line
        ));
        assert_eq!(buf, br#"{"type":"status"}"#);
        assert!(matches!(
            read_line_capped(&mut r, &mut buf).unwrap(),
            LineRead::Eof
        ));
    }

    #[test]
    fn settings_default_matches_spec() {
        let s = PersonaSettings::default();
        assert_eq!(
            (
                s.interval_min,
                s.quiet_start.as_str(),
                s.quiet_end.as_str(),
                s.quiet_weekends,
                s.daily_token_limit
            ),
            (30, "20:00", "07:00", true, 2_000_000)
        );
    }
}
