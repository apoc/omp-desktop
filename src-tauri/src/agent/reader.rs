use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, ErrorKind};
use std::path::PathBuf;
use std::process::{ChildStderr, ChildStdin, ChildStdout};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

use crate::approval::{self, RuleBook};
use crate::redaction::{is_credential_key, REDACTED_PLACEHOLDER};

use super::approvals::{self, PendingApprovals};
use super::ext_ui::{self, ExtUiState};
use super::inflight::{self, InFlight};
use super::inner::BridgeInner;
use super::journal::EventJournal;

/// Hard cap on a single RPC line. Defends the reader thread from runaway
/// agent output that could otherwise allocate unbounded memory.
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

/// One line forwarded to the frontend, stamped with its journal `seq`. Kept
/// in sync with `replay_events`'s `ReplayEvent` — both sides of the wire
/// (live `agent://line/{id}` events and a replay response) use the same
/// `{seq, text}` shape so the frontend can dispatch either through one path.
#[derive(serde::Serialize, Clone)]
struct LineEvent<'a> {
    seq: u64,
    text: &'a str,
}

/// Recursively replace the value of any object key matching [`REDACTED_KEYS`]
/// with [`REDACTED_PLACEHOLDER`]. A key matches when its normalized form
/// *ends with* one of [`REDACTED_KEYS`] — not just when it equals one —
/// so compound spellings like `x-api-key`/`OPENAI_API_KEY` (normalizing to
/// `xapikey`/`openaiapikey`, both ending in `apikey`) are caught, without a
/// bare substring/`contains` match that would also catch unrelated fields
/// such as `input_tokens`/`output_tokens` if a `token` entry were ever
/// added. Redacted subtrees are not descended into — once a key is
/// sensitive, nothing under it is worth preserving.
///
/// Returns `true` when at least one value was actually redacted, so the
/// caller can skip re-serializing an untouched frame — the overwhelmingly
/// common case.
///
/// [`REDACTED_KEYS`]: crate::redaction::REDACTED_KEYS
fn sanitize_frame(value: &mut serde_json::Value) -> bool {
    let mut redacted = false;
    match value {
        serde_json::Value::Object(map) => {
            for (key, val) in map.iter_mut() {
                if is_credential_key(key) {
                    *val = serde_json::Value::String(REDACTED_PLACEHOLDER.to_string());
                    redacted = true;
                } else {
                    redacted |= sanitize_frame(val);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                redacted |= sanitize_frame(item);
            }
        }
        _ => {}
    }
    redacted
}

struct HtmlAttribute<'a> {
    name: &'a str,
    value: &'a str,
    start: usize,
    end: usize,
}

/// One step of the attribute scan. `Malformed` means the tag cannot be
/// tokenized unambiguously any more (an unterminated quoted value), which the
/// caller treats as sensitive.
enum HtmlScan<'a> {
    Attribute(HtmlAttribute<'a>),
    End,
    Malformed,
}

/// Skip whitespace and `/` characters that cannot close the tag; whether a
/// `/` was consumed. Used both before an attribute name and after one.
fn skip_separators(bytes: &[u8], cursor: &mut usize) -> bool {
    let mut solidus = false;
    while *cursor < bytes.len() {
        if bytes[*cursor].is_ascii_whitespace() {
            *cursor += 1;
        } else if bytes[*cursor] == b'/' && bytes.get(*cursor + 1) != Some(&b'>') {
            solidus = true;
            *cursor += 1;
        } else {
            break;
        }
    }
    solidus
}

/// Read one attribute from an `<input>` tag, preserving byte spans so the
/// caller can remove it without parsing or reconstructing the HTML.
///
/// The grammar follows HTML's tokenizer closely enough that the attributes a
/// browser assigns to an `<input>` are exactly the ones seen here:
///
/// * Whitespace separates attributes.
/// * A `/` that is not immediately followed by `>` is skipped like
///   whitespace (spec: "self-closing start tag state" →
///   "before attribute name state"). A browser keeps reading attributes after
///   `<input type=password / value=x>`, so skipping it like whitespace keeps
///   that `value` visible to the password stripper.
/// * `>` (and EOF), or `/` directly before `>`, end the tag.
/// * An attribute without `=` has an empty value and ends at its name — the
///   separator after it stays, so the rewritten tag is still an `<input>`.
fn next_html_attribute<'a>(tag: &'a str, cursor: &mut usize) -> HtmlScan<'a> {
    let bytes = tag.as_bytes();
    let start = *cursor;
    skip_separators(bytes, cursor);
    if *cursor >= bytes.len() || bytes[*cursor] == b'>' {
        return HtmlScan::End;
    }
    if bytes[*cursor] == b'/' {
        // `/` directly before `>`: the tag is self-closing and ends here.
        return HtmlScan::End;
    }
    let name_start = *cursor;
    while *cursor < bytes.len()
        && !bytes[*cursor].is_ascii_whitespace()
        && !matches!(bytes[*cursor], b'=' | b'>' | b'/')
    {
        *cursor += 1;
    }
    let name_end = *cursor;
    // After the name, `/` ends the attribute just like whitespace does. Once a
    // solidus has been consumed, a following `=` starts a new attribute name
    // in HTML, never this attribute's value.
    let solidus = skip_separators(bytes, cursor);
    if *cursor >= bytes.len() || bytes[*cursor] != b'=' || solidus {
        return HtmlScan::Attribute(HtmlAttribute {
            name: &tag[name_start..name_end],
            value: "",
            start,
            end: name_end,
        });
    }
    *cursor += 1;
    while *cursor < bytes.len() && bytes[*cursor].is_ascii_whitespace() {
        *cursor += 1;
    }
    let (value_start, value_end) =
        if *cursor < bytes.len() && matches!(bytes[*cursor], b'\'' | b'"') {
            let quote = bytes[*cursor];
            let value_start = *cursor + 1;
            *cursor = value_start;
            while *cursor < bytes.len() && bytes[*cursor] != quote {
                *cursor += 1;
            }
            let value_end = *cursor;
            if *cursor < bytes.len() {
                *cursor += 1;
            } else {
                // EOF inside a quoted value: the browser never emits this tag
                // and swallows the rest of the markup inside the value, so the
                // caller cannot safely rewrite it.
                return HtmlScan::Malformed;
            }
            (value_start, value_end)
        } else {
            let value_start = *cursor;
            while *cursor < bytes.len()
                && !bytes[*cursor].is_ascii_whitespace()
                && bytes[*cursor] != b'>'
            {
                *cursor += 1;
            }
            (value_start, *cursor)
        };
    HtmlScan::Attribute(HtmlAttribute {
        name: &tag[name_start..name_end],
        value: &tag[value_start..value_end],
        start,
        end: *cursor,
    })
}

/// Decode the character references a browser applies inside an attribute
/// value before the form parser compares it. `None` means any `&` left
/// unresolved — callers treat that as sensitive rather than guessing, so a
/// malformed reference cannot hide a password marker. The scan is single-pass
/// and allocates only for the small `type`/`autocomplete` values that use it.
fn decode_html_attribute(value: &str) -> Option<String> {
    fn named(name: &str) -> Option<&'static str> {
        Some(match name {
            "amp" | "AMP" => "&",
            "lt" | "LT" => "<",
            "gt" | "GT" => ">",
            "quot" | "QUOT" => "\"",
            "apos" => "'",
            "nbsp" => "\u{a0}",
            "Tab" => "\t",
            "NewLine" => "\n",
            "fjlig" => "fj",
            _ => return None,
        })
    }

    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp + 1..];
        if let Some(after_hash) = rest.strip_prefix('#') {
            let (radix, digits) = after_hash
                .strip_prefix('x')
                .or_else(|| after_hash.strip_prefix('X'))
                .map_or((10, after_hash), |hex| (16, hex));
            let end = digits
                .find(|c: char| !c.is_digit(radix))
                .unwrap_or(digits.len());
            if end == 0 {
                return None;
            }
            let code = u32::from_str_radix(&digits[..end], radix).ok();
            out.push(code.and_then(char::from_u32).unwrap_or('\u{fffd}'));
            rest = &digits[end..];
        } else {
            let end = rest
                .find(|c: char| !c.is_ascii_alphanumeric())
                .unwrap_or(rest.len());
            if end == 0 {
                return None;
            }
            out.push_str(named(&rest[..end])?);
            rest = &rest[end..];
        }
        rest = rest.strip_prefix(';').unwrap_or(rest);
    }
    out.push_str(rest);
    Some(out)
}

/// Whether an attribute value names a credential input after the browser's
/// own character-reference decoding. An undecodable value is sensitive.
///
/// This is the one rule both stack halves share (`passwordMarker` in
/// `src/app/html-form.js`): once decoded, a `type`/`autocomplete` value is a
/// password marker when it contains `password` anywhere, compared
/// ASCII-case-insensitively. No token splitting and no trimming, so padding
/// with NBSP, a BOM or any other separator cannot slip a credential input
/// past the guard. The byte-window scan needs no allocation — the needle is
/// ASCII, so it can never straddle a UTF-8 continuation byte.
fn sensitive_attribute(name: &str, value: &str) -> bool {
    let is_type = name.eq_ignore_ascii_case("type");
    if !is_type && !name.eq_ignore_ascii_case("autocomplete") {
        return false;
    }
    decode_html_attribute(value).is_none_or(|decoded| contains_password_marker(&decoded))
}

/// Case-insensitive ASCII substring test for the literal `password`.
fn contains_password_marker(value: &str) -> bool {
    const MARKER: &[u8] = b"password";
    value
        .as_bytes()
        .windows(MARKER.len())
        .any(|window| window.eq_ignore_ascii_case(MARKER))
}

/// Remove prefilled credentials from password-like `<input>` elements in an
/// ask-form HTML string. Returns `None` when no value needs removal, keeping
/// the ordinary frame path allocation-free. Each tag is scanned twice at
/// most and the output is allocated only after the first sensitive value.
fn strip_password_values(html: &str) -> Option<String> {
    let bytes = html.as_bytes();
    let mut cursor = 0;
    let mut copied = 0;
    let mut output: Option<String> = None;
    while let Some(relative) = html[cursor..].find('<') {
        let tag_start = cursor + relative;
        let name_start = tag_start + 1;
        let name_end = name_start + "input".len();
        if html.get(name_start..name_end).is_none_or(|name| {
            !name.eq_ignore_ascii_case("input")
                || bytes
                    .get(name_end)
                    .is_some_and(|byte| !byte.is_ascii_whitespace() && !matches!(byte, b'>' | b'/'))
        }) {
            cursor = name_start;
            continue;
        }

        let mut probe = 0;
        let mut sensitive = false;
        loop {
            match next_html_attribute(&html[name_end..], &mut probe) {
                HtmlScan::Attribute(attribute) => {
                    if sensitive_attribute(attribute.name, attribute.value) {
                        sensitive = true;
                    }
                }
                HtmlScan::End => break,
                // An input tag this scanner cannot tokenize unambiguously is
                // treated as sensitive: drop the whole tag rather than guess
                // where the browser ends it.
                HtmlScan::Malformed => {
                    sensitive = true;
                    break;
                }
            }
        }
        let tag_end = name_end + probe;
        if sensitive {
            let mut attributes = 0;
            loop {
                match next_html_attribute(&html[name_end..], &mut attributes) {
                    HtmlScan::Attribute(attribute) => {
                        if !attribute.name.eq_ignore_ascii_case("value") {
                            continue;
                        }
                        let out = output.get_or_insert_with(|| String::with_capacity(html.len()));
                        out.push_str(&html[copied..name_end + attribute.start]);
                        copied = name_end + attribute.end;
                    }
                    HtmlScan::End => break,
                    // Fail closed: the browser swallows the rest of the markup
                    // inside the unterminated value, so everything from this
                    // tag's `<` on goes, value attributes included.
                    HtmlScan::Malformed => {
                        let out = output.get_or_insert_with(|| String::with_capacity(html.len()));
                        out.push_str(&html[copied..tag_start]);
                        return output;
                    }
                }
            }
        }
        cursor = if tag_end < bytes.len() {
            tag_end + 1
        } else {
            bytes.len()
        };
    }
    output.map(|mut out| {
        out.push_str(&html[copied..]);
        out
    })
}

/// Sanitize one raw RPC line. Parses `raw` as JSON and redacts sensitive
/// keys, returning the sanitized text alongside the parsed (and now
/// redacted) frame — the caller reuses the parse to check for an
/// approval-prompt match rather than parsing the line a second time. A
/// line that fails to parse as JSON is forwarded unchanged (never silently
/// dropped — that failure mode belongs to the truncation path, not this
/// one) with `None` in place of the parsed frame, since a non-JSON line
/// cannot carry a *named* credential field — or an approval prompt — for
/// us to find in the first place.
fn sanitize_line(raw: &[u8]) -> (String, Option<serde_json::Value>) {
    serde_json::from_slice::<serde_json::Value>(raw).map_or_else(
        |_| (String::from_utf8_lossy(raw).into_owned(), None),
        |mut value| {
            let mut redacted = sanitize_frame(&mut value);
            let is_form = value.get("type").and_then(serde_json::Value::as_str)
                == Some("extension_ui_request")
                && value.get("method").and_then(serde_json::Value::as_str) == Some("form");
            let stripped_html = if is_form {
                value
                    .get("html")
                    .and_then(serde_json::Value::as_str)
                    .and_then(strip_password_values)
            } else {
                None
            };
            if let Some(html) = stripped_html {
                value["html"] = serde_json::Value::String(html);
                redacted = true;
            }
            // Re-serializing costs a second full pass (escaping, number
            // formatting, map ordering) over the whole frame. Only pay it
            // when something was actually redacted; otherwise `raw` already
            // *is* the correct text.
            let text = if redacted {
                serde_json::to_string(&value)
                    .unwrap_or_else(|_| String::from_utf8_lossy(raw).into_owned())
            } else {
                String::from_utf8_lossy(raw).into_owned()
            };
            (text, Some(value))
        },
    )
}

/// Strip trailing `\r`/`\n` bytes (any combination/order) off the end of
/// `buf` in place. Extracted as a pure function so the exact framing
/// behavior the stdout reader loop depends on is fixture-testable without
/// spawning a process — see `line_framing_fixture_matches_expected_...`
/// below, driven by `tests/fixtures/line-framing-cases.json`.
fn strip_trailing_crlf(buf: &mut Vec<u8>) {
    while matches!(buf.last(), Some(b'\n' | b'\r')) {
        buf.pop();
    }
}

/// If `frame` is a tool-approval prompt matching a currently-granted rule,
/// answer it directly on `stdin` (never forwarded to the frontend) and
/// return a synthetic `desktop_auto_approval` frame in its place so the
/// human still sees *what* was approved: the tool and the prompt's detail
/// lines (`details`, `null` when the title has none). Returns `None` for
/// every frame that isn't an approval prompt, or is one the rule book
/// doesn't cover — those fall through to the human exactly as before.
///
/// Generic over the stdin writer (`W: Write`) rather than hard-coded to
/// `ChildStdin` so unit tests can pass a `Mutex<Vec<u8>>` and assert on the
/// bytes written, instead of spawning a real child process (`cat` isn't
/// available on Windows) purely to obtain a writable handle. The real call
/// site passes `&Arc<Mutex<ChildStdin>>`, which still derefs to
/// `&Mutex<ChildStdin>` — `W = ChildStdin` there, unchanged behavior.
fn try_auto_approve<W: std::io::Write>(
    frame: &serde_json::Value,
    rule_book: &RuleBook,
    sid: &str,
    project_root: Option<&std::path::Path>,
    stdin: &Mutex<W>,
) -> Option<String> {
    let tool = approval::approval_tool_name(frame)?;
    if !rule_book.is_granted(sid, project_root, tool) {
        return None;
    }
    let id = approval::approval_request_id(frame)?;
    let response = approvals::approve_answer(id);
    if let Ok(mut w) = stdin.lock() {
        let _ = writeln!(*w, "{response}");
        let _ = w.flush();
    }
    Some(
        serde_json::json!({
            "type": "desktop_auto_approval",
            "tool": tool,
            "details": approval::approval_details(frame),
        })
        .to_string(),
    )
}

/// The reader's approval step for one parsed frame: a rule-covered prompt is
/// answered by [`try_auto_approve`] and its notice returned; any other frame
/// goes to the frontend as is and is shown to `approvals` first — a prompt
/// the human will see is one a grant may name, and omp's `cancel` settles
/// one. A prompt answered here is never recorded, so it cannot be granted.
fn auto_approve_or_track<W: std::io::Write>(
    frame: &serde_json::Value,
    frame_type: Option<&str>,
    rule_book: &RuleBook,
    sid: &str,
    project_root: Option<&std::path::Path>,
    stdin: &Mutex<W>,
    approvals: &Mutex<PendingApprovals>,
) -> Option<String> {
    let notice = try_auto_approve(frame, rule_book, sid, project_root, stdin);
    if notice.is_none() {
        approvals::observe(approvals, frame_type, frame);
    }
    notice
}

/// Grouped arguments for [`spawn_stdout_reader`] — bundled into one struct
/// rather than twelve positional parameters.
pub(super) struct StdoutReaderConfig {
    pub(super) sessions: Arc<Mutex<HashMap<String, BridgeInner>>>,
    pub(super) sid: String,
    pub(super) gen: u64,
    pub(super) journal: Arc<Mutex<EventJournal>>,
    /// This session's extension status lines and widgets, kept up to date
    /// for a tab that comes back with a `dropped` replay.
    pub(super) ext_ui: Arc<Mutex<ExtUiState>>,
    /// This session's in-flight assistant message, kept whole for a tab
    /// that comes back with a `dropped` replay.
    pub(super) inflight: Arc<Mutex<InFlight>>,
    /// This process's open approval prompts, for a grant to bind to.
    pub(super) approvals: Arc<Mutex<PendingApprovals>>,
    pub(super) stdin: Arc<Mutex<ChildStdin>>,
    pub(super) rule_book: Arc<RuleBook>,
    pub(super) project_root: Option<PathBuf>,
    pub(super) app: AppHandle,
    pub(super) stdout: ChildStdout,
    /// This incarnation's liveness flag — see [`BridgeInner::alive`].
    /// Checked via [`should_emit`] immediately before every emit so a
    /// superseded/reaped incarnation's reader goes mute without ever
    /// taking `sessions`.
    pub(super) alive: Arc<AtomicBool>,
    /// Shared with this session's stderr reader. Read only when the child
    /// exits without ever having produced a stdout frame, to turn a
    /// silent-looking clean exit into the reason omp actually printed.
    pub(super) stderr_tail: Arc<Mutex<StderrTail>>,
    /// The bridge's `last_errors` map. A startup death is recorded here as
    /// well as emitted, because the `agent://exit` event only reaches the
    /// tab that happens to be listening: a background tab's failure is
    /// otherwise invisible until `session_status` is asked, which is
    /// exactly what a later tab switch does.
    pub(super) last_errors: Arc<Mutex<HashMap<String, String>>>,
}

/// Whether an event from this incarnation should still reach the
/// frontend. `false` once [`BridgeInner::alive`] has been cleared —
/// superseded by a fresher `start_session`, reaped by `stop_session`, or
/// retired by this incarnation's own reader thread as it gives up its map
/// entry on ordinary child exit (see the end of [`spawn_stdout_reader`]).
/// A plain atomic load, never the `sessions` mutex: this gates the
/// per-stdout-line hot path, which must not contend with a global lock.
fn should_emit(alive: &AtomicBool) -> bool {
    alive.load(Ordering::Acquire)
}

/// Mirror frames from live processes only; auto-approved requests never open
/// a human dialog. No webview listener is needed for a background tab.
fn record_tracker_frame(
    sid: &str,
    frame_type: Option<&str>,
    frame: Option<&serde_json::Value>,
    auto_approved: bool,
    alive: &AtomicBool,
) {
    if !auto_approved {
        crate::remote::tracker::tracker().on_frame(
            sid,
            frame_type,
            frame,
            std::time::Instant::now(),
            alive,
        );
    }
}

fn retire_reader_session(
    sessions: &Mutex<HashMap<String, BridgeInner>>,
    sid: &str,
    gen: u64,
    alive: &AtomicBool,
) -> bool {
    let mut announce = false;
    if let Ok(mut s) = sessions.lock() {
        match s.get(sid).map(|inner| inner.gen) {
            Some(g) if g == gen => {
                // Still ours — we're the last stop for this id. Clear
                // `alive` and the tracker state before giving up the
                // entry so a concurrent replacement cannot have its own
                // tracker state wiped after the lock is released.
                s.remove(sid);
                alive.store(false, Ordering::Release);
                announce = true;
            }
            // A fresher incarnation already owns the id — stay mute,
            // its own reader speaks for it now.
            Some(_) => {}
            // Entry already gone: a racing `stop_session` or a
            // superseding `start_session` removed it and cleared
            // `alive` and the tracker inside that same critical section
            // before releasing the `sessions` lock (see `agent/mod.rs`).
            None => announce = should_emit(alive),
        }
        if announce {
            crate::remote::tracker::tracker().on_exit(sid);
        }
    }
    announce
}

pub(super) fn spawn_stdout_reader(config: StdoutReaderConfig) {
    let StdoutReaderConfig {
        sessions,
        sid,
        gen,
        journal,
        ext_ui,
        inflight,
        approvals,
        stdin,
        rule_book,
        project_root,
        app,
        stdout,
        alive,
        stderr_tail,
        last_errors,
    } = config;
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let line_event = format!("agent://line/{sid}");
        let exit_event = format!("agent://exit/{sid}");
        let mut buf: Vec<u8> = Vec::with_capacity(8192);
        let mut exit_reason = String::new();
        // omp announces itself with a `ready` frame, so "not one frame all
        // run" means it died during startup. That is the only case where
        // stderr is a better explanation than the empty clean-exit payload.
        let mut saw_frame = false;

        loop {
            buf.clear();
            match read_until_capped(&mut reader, b'\n', &mut buf, MAX_LINE_BYTES) {
                Ok((0, _)) => break, // EOF — pipe closed, child exited
                Ok((_, true)) => {
                    // Line was longer than MAX_LINE_BYTES. We drained the
                    // pipe through the next '\n' but `buf` holds only a
                    // truncated prefix — emitting it would feed the
                    // frontend invalid JSON, which JSON.parse drops
                    // silently and surfaces as "the agent skipped a turn".
                    // Drop the line, log clearly, and keep reading.
                    eprintln!(
                        "[omp/{sid}] dropped a stdout line that exceeded {MAX_LINE_BYTES} bytes; \
                         frontend will not see this RPC message"
                    );
                }
                Ok((_, false)) => {
                    strip_trailing_crlf(&mut buf);
                    if buf.is_empty() {
                        continue;
                    }
                    let (sanitized, parsed) = sanitize_line(&buf);
                    // A successfully parsed frame — not a stray blank line
                    // and not a terminal escape sequence flushed with no
                    // trailing newline — is what proves omp got far enough
                    // to talk in-protocol, matching the "ready frame"
                    // definition above. Gating on the raw byte count
                    // instead would let either of those silently disable
                    // the stderr fallback this flag exists to gate.
                    saw_frame |= parsed.is_some();
                    let frame_type = parsed
                        .as_ref()
                        .and_then(|frame| frame.get("type"))
                        .and_then(serde_json::Value::as_str);
                    // A rule-covered approval prompt is answered directly on
                    // stdin and replaced with a synthetic notice — the human
                    // never sees the original ask, but does see that it was
                    // auto-approved.
                    let notice = parsed.as_ref().and_then(|frame| {
                        auto_approve_or_track(
                            frame,
                            frame_type,
                            &rule_book,
                            &sid,
                            project_root.as_deref(),
                            &stdin,
                            &approvals,
                        )
                    });
                    let auto_approved = notice.is_some();
                    // One allocation for the line, shared with the journal
                    // by refcount rather than copied into it.
                    let shared: Arc<str> = Arc::from(notice.unwrap_or(sanitized));
                    // Record in the tracker before exposing the frame in the
                    // journal: a background tab activated in between cannot
                    // replay and answer a question before the tracker knows it.
                    record_tracker_frame(&sid, frame_type, parsed.as_ref(), auto_approved, &alive);
                    let seq = journal.lock().map_or(0, |mut j| j.push(shared.clone()));
                    // After the push, stamped with its seq: a snapshot taken
                    // in between names an older seq, so the frontend still
                    // applies this frame from the replay.
                    ext_ui::record(&ext_ui, seq, frame_type, parsed.as_ref());
                    if should_emit(&alive) {
                        let _ = app.emit(&line_event, LineEvent { seq, text: &shared });
                        // Rail widgets with a `turn_end` trigger rerun after
                        // the turn's last frame. Reuses the parse above.
                        if frame_type == Some("agent_end") {
                            crate::widgets::notify_turn_end(&app, &sid);
                        }
                    }
                    // Last use of the parse: the in-flight copy takes its
                    // blocks. After the journal push like `ext_ui`, so a
                    // snapshot never names a seq the journal lacks.
                    inflight::record(&inflight, seq, parsed);
                }
                Err(e) => {
                    exit_reason = format!("stdout read error: {e}");
                    break;
                }
            }
        }

        // A child that died during startup (no frame, non-error EOF) would
        // otherwise report the empty payload the contract defines as a clean
        // exit, leaving a blank tab with no explanation anywhere in the UI.
        // omp's own reason is on stderr: `--mode rpc-ui` refuses to start
        // when the profile has no usable model, which is exactly what a
        // freshly created (credential-less) profile looks like.
        if exit_reason.is_empty() && !saw_frame {
            if let Some(reason) = stderr_tail.lock().ok().and_then(|t| t.to_reason()) {
                exit_reason = reason;
            }
        }
        // Process exited. Decide whether to announce inside the same
        // critical section that gives up our map entry — deciding it
        // separately (as before) left a window where a self-removed entry
        // stayed `alive` forever: nothing else ever clears the flag for an
        // incarnation that retires on its own, since `reap_and_clear_grants`
        // only runs when *something else* supersedes or reaps this entry.
        let announce = retire_reader_session(&sessions, &sid, gen, &alive);
        // Empty payload = clean exit; non-empty = error reason. See the
        // AgentBridge doc-comment for the full event contract.
        if announce {
            if !exit_reason.is_empty() {
                // Recorded before the emit so a `session_status` query that
                // races the event still finds it. Only for the incarnation
                // that still owned the id: a superseded reader must not
                // stamp its reason onto its replacement. `exit_reason`
                // is cloned (not moved) because the emit below still needs
                // the original — `sid` has no such later use, so it moves.
                if let Ok(mut e) = last_errors.lock() {
                    e.insert(sid, exit_reason.clone());
                }
            }
            let _ = app.emit(&exit_event, exit_reason);
        }
    });
}

/// Bounded ring of the child's most recent stderr lines.
///
/// omp writes startup diagnostics to stderr and, in `--mode rpc-ui`, exits
/// non-zero *before* emitting a single stdout frame when the profile it was
/// pointed at has no usable model (a freshly created profile with no
/// credentials is the common case). Without this the stdout reader hits EOF
/// with nothing to report, emits the empty payload the event contract
/// defines as a *clean* exit, and the tab sits blank with the real reason
/// visible only on the desktop's own stderr — see
/// [`StdoutReaderConfig::stderr_tail`].
pub(super) struct StderrTail {
    lines: VecDeque<String>,
    bytes: usize,
}

/// Keep the tail small: it exists to explain a startup failure, not to
/// mirror the child's log. A refusal banner is a handful of lines.
const STDERR_TAIL_LINES: usize = 24;
const STDERR_TAIL_BYTES: usize = 4096;

impl StderrTail {
    pub(super) fn new() -> Self {
        Self {
            lines: VecDeque::with_capacity(STDERR_TAIL_LINES),
            bytes: 0,
        }
    }

    fn push(&mut self, mut line: String) {
        // A line larger than the whole tail budget would otherwise evict
        // every other retained line *and* itself in the loop below,
        // leaving `to_reason` with nothing at all to report — the exact
        // blank-tab failure this type exists to prevent. Keep a prefix
        // instead. Cut on a char boundary: omp's banners are not pure ASCII.
        if line.len() > STDERR_TAIL_BYTES {
            let cut = crate::text::prefix_within(&line, STDERR_TAIL_BYTES).len();
            line.truncate(cut);
        }
        self.bytes += line.len();
        self.lines.push_back(line);
        while self.lines.len() > STDERR_TAIL_LINES || self.bytes > STDERR_TAIL_BYTES {
            // `pop_front` on a non-empty deque; the loop condition can only
            // hold while at least one line is present.
            if let Some(dropped) = self.lines.pop_front() {
                self.bytes -= dropped.len();
            } else {
                break;
            }
        }
    }

    /// The retained lines as one blank-line-collapsed message, or `None`
    /// when the child said nothing. omp's banners are double-spaced for a
    /// terminal; collapsing keeps the UI note compact.
    fn to_reason(&self) -> Option<String> {
        crate::text::join_nonblank(self.lines.iter().map(String::as_str), " ")
    }
}

pub(super) fn spawn_stderr_reader(sid: String, stderr: ChildStderr, tail: Arc<Mutex<StderrTail>>) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            eprintln!("[omp/{sid}] {line}");
            if let Ok(mut t) = tail.lock() {
                t.push(line);
            }
        }
    });
}

/// `BufRead::read_until` with a hard byte cap. Once the cap is reached
/// further bytes are consumed off the pipe but discarded — readers never
/// allocate unbounded memory on runaway output.
///
/// Returns `(consumed, truncated)`:
/// - `consumed` = total bytes read off the pipe (including the delimiter).
///   Zero means EOF.
/// - `truncated` = `true` if the line was longer than `max` and the data
///   in `out` is a *prefix* of the actual line. Callers should refuse to
///   forward truncated payloads as if they were complete.
fn read_until_capped<R: BufRead>(
    r: &mut R,
    delim: u8,
    out: &mut Vec<u8>,
    max: usize,
) -> std::io::Result<(usize, bool)> {
    let mut total = 0;
    let mut truncated = false;
    loop {
        let avail = match r.fill_buf() {
            Ok(b) => b,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if avail.is_empty() {
            return Ok((total, truncated));
        }
        let room = max.saturating_sub(out.len());
        let used = if let Some(i) = avail.iter().position(|&b| b == delim) {
            // Found the delimiter — frame the line and return.
            let take = (i + 1).min(room);
            if take < i + 1 {
                truncated = true;
            }
            out.extend_from_slice(&avail[..take]);
            let used = i + 1;
            r.consume(used);
            total += used;
            return Ok((total, truncated));
        } else {
            // No delimiter in the available chunk — keep reading.
            let take = avail.len().min(room);
            if take < avail.len() {
                truncated = true;
            }
            if take > 0 {
                out.extend_from_slice(&avail[..take]);
            }
            avail.len()
        };
        r.consume(used);
        total += used;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::tests::approval_prompt;
    use serde_json::json;

    #[test]
    fn sanitize_redacts_nested_credential_keys() {
        let raw = json!({
            "type": "response",
            "data": {
                "model": {
                    "name": "gpt-5",
                    "headers": { "Authorization": "Bearer sk-secret", "Content-Type": "application/json" }
                }
            }
        })
        .to_string();
        let (out, parsed) = sanitize_line(raw.as_bytes());
        assert!(!out.contains("sk-secret"));
        assert!(out.contains(REDACTED_PLACEHOLDER));
        let parsed = parsed.expect("valid JSON parses");
        assert_eq!(
            parsed["data"]["model"]["headers"],
            json!(REDACTED_PLACEHOLDER)
        );
        // Non-sensitive sibling fields survive untouched.
        assert_eq!(parsed["data"]["model"]["name"], "gpt-5");
    }

    #[test]
    fn sanitize_matches_key_regardless_of_separator_style() {
        for key in ["api_key", "api-key", "apiKey", "API_KEY"] {
            let raw = json!({ key: "should-not-survive" }).to_string();
            let (out, _) = sanitize_line(raw.as_bytes());
            assert!(
                !out.contains("should-not-survive"),
                "key {key} leaked a secret"
            );
        }
    }

    #[test]
    fn sanitize_redacts_compound_provider_credential_key_names() {
        // Suffix-matching the normalized key against REDACTED_KEYS
        // catches these compound spellings where the old exact-equality
        // check let all of them through unredacted.
        for key in [
            "x-api-key",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "client_secret",
        ] {
            let raw = json!({ key: "should-not-survive" }).to_string();
            let (out, _) = sanitize_line(raw.as_bytes());
            assert!(
                !out.contains("should-not-survive"),
                "key {key} leaked a secret"
            );
        }
    }

    /// `sanitize_frame`'s return value gates the re-serialize fast path, so
    /// a frame with nothing to redact must report `false` — and one with a
    /// secret nested deep inside must still report `true`.
    #[test]
    fn sanitize_frame_reports_whether_it_redacted_anything() {
        let mut clean = json!({ "type": "turn_start", "usage": { "input_tokens": 3 } });
        assert!(!sanitize_frame(&mut clean));

        let mut nested = json!({ "a": [ { "b": { "api_key": "sekrit" } } ] });
        assert!(sanitize_frame(&mut nested));
        assert_eq!(nested["a"][0]["b"]["api_key"], REDACTED_PLACEHOLDER);
    }

    /// A frame with nothing to redact must come back byte-identical to the
    /// input, not re-serialized — that is what makes skipping the second
    /// serializer pass safe.
    #[test]
    fn sanitize_line_preserves_untouched_frame_verbatim() {
        // Key order and spacing here are deliberately *not* what serde_json
        // would re-emit, proving the fast path returns the original bytes.
        let raw = br#"{"z":1,  "a":  [1,2,3],"nested":{"k":"v"}}"#;
        let (out, parsed) = sanitize_line(raw);
        assert_eq!(out.as_bytes(), raw);
        assert!(parsed.is_some());
    }

    #[test]
    fn sanitize_leaves_usage_token_counts_unredacted() {
        // A broad `contains`/suffix rule on "token" would also catch these
        // legitimate usage-stats fields — this guards against ever
        // "simplifying" the suffix match back to that.
        let raw = json!({ "usage": { "input_tokens": 42, "output_tokens": 7 } }).to_string();
        let (out, parsed) = sanitize_line(raw.as_bytes());
        assert!(!out.contains(REDACTED_PLACEHOLDER));
        let parsed = parsed.expect("valid JSON parses");
        assert_eq!(parsed["usage"]["input_tokens"], 42);
        assert_eq!(parsed["usage"]["output_tokens"], 7);
    }

    #[test]
    fn sanitize_redacts_inside_arrays() {
        let raw = json!({ "items": [{ "password": "hunter2" }] }).to_string();
        let (out, _) = sanitize_line(raw.as_bytes());
        assert!(!out.contains("hunter2"));
    }

    #[test]
    fn sanitize_leaves_non_sensitive_frame_untouched() {
        let raw = json!({ "type": "turn_start", "toolName": "bash" }).to_string();
        let (out, parsed) = sanitize_line(raw.as_bytes());
        let reparsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(reparsed["type"], "turn_start");
        assert_eq!(reparsed["toolName"], "bash");
        assert_eq!(parsed.unwrap()["toolName"], "bash");
    }

    #[test]
    fn sanitize_form_strips_prefilled_passwords_before_journaling() {
        let html = r#"<form><input name="a" TYPE = "PASSWORD" value = "double-canary"><input type='password' value='single-canary'><input type=password value=unquoted-canary><input type=text autocomplete="off current-password" value="auto-canary"><input type=text autocomplete=new-password value=auto-unquoted><input name=ok value=keep-me></form>"#;
        let raw = json!({
            "type": "extension_ui_request",
            "id": "form-secret",
            "method": "form",
            "html": html,
        })
        .to_string();
        let (out, parsed) = sanitize_line(raw.as_bytes());
        let parsed = parsed.expect("valid JSON parses");
        let mut journal = EventJournal::new(4, 1 << 20);
        journal.push(Arc::from(out));
        let replay = journal.since(0);
        let journaled = replay.events[0].text.as_ref();
        for canary in [
            "double-canary",
            "single-canary",
            "unquoted-canary",
            "auto-canary",
            "auto-unquoted",
        ] {
            assert!(!journaled.contains(canary), "journal leaked {canary}");
            assert!(!parsed["html"].as_str().unwrap().contains(canary));
        }
        assert!(journaled.contains(r"name=ok value=keep-me"));
        assert!(!parsed["html"]
            .as_str()
            .unwrap()
            .contains("current-password\" value"));
    }

    /// The scanner tokenizes `<input>` attributes the way HTML does, so a
    /// `value` the browser still reads after a stray `/` is stripped too.
    #[test]
    fn sanitize_form_follows_html_attribute_tokenization_around_solidus() {
        for (html, expected) in [
            // `/` before an attribute is skipped like whitespace: the browser
            // reads `value` as an attribute and so does the stripper.
            (
                "<form><input type=password / value=slash-canary></form>",
                Some("<form><input type=password></form>"),
            ),
            (
                "<form><input type=password/ value=solidus-canary></form>",
                Some("<form><input type=password/></form>"),
            ),
            // A solidus inside an unquoted value is data, so the value is
            // stripped up to the `>` and nothing is left dangling.
            (
                "<form><input type=password value=kept-canary/></form>",
                Some("<form><input type=password></form>"),
            ),
            // An unquoted value runs through `/value=…`, exactly as in HTML, so
            // there is no second attribute to strip and the tag stays as is.
            // The frontend's marker check still refuses this form.
            ("<form><input/type=password/value=x></form>", None),
        ] {
            let stripped = strip_password_values(html);
            assert_eq!(stripped.as_deref(), expected, "{html}");
            if let Some(out) = stripped {
                assert!(!out.contains("canary"), "{html} leaked: {out}");
            }
        }
    }

    /// A bare `value` attribute is removed up to its name, never together with
    /// the separator that follows it: the rewritten tag must stay an `<input>`.
    #[test]
    fn sanitize_form_removes_a_bare_value_without_merging_the_next_attribute() {
        for (html, expected) in [
            (
                "<form><input value type=password></form>",
                "<form><input type=password></form>",
            ),
            (
                "<form><input value name=pw type=password></form>",
                "<form><input name=pw type=password></form>",
            ),
            (
                "<form><input type=password value></form>",
                "<form><input type=password></form>",
            ),
        ] {
            assert_eq!(
                strip_password_values(html).as_deref(),
                Some(expected),
                "{html}"
            );
        }
    }

    /// An `<input>` that cannot be tokenized unambiguously is sensitive: the
    /// whole tag goes, because the browser swallows the rest of the markup
    /// inside its unterminated value.
    #[test]
    fn sanitize_form_fails_closed_on_an_unterminated_quoted_value() {
        let html = "<form><input type=\"password value=unterminated-canary";
        let out = strip_password_values(html).expect("a malformed input tag is rewritten");
        assert_eq!(out, "<form>");
        assert!(!out.contains("unterminated-canary"));
        assert!(!out.contains("password"));
    }

    #[test]
    fn sanitize_form_decodes_sensitive_attribute_entities_and_fails_closed() {
        for (label, attribute) in [
            ("decimal", r#"type="&#112;assword""#),
            ("hex", r#"type="&#x70;assword""#),
            ("missing semicolon", r#"type="&#112assword""#),
            ("mixed case", r#"type="&#x50;ASSWORD""#),
            ("named whitespace", r#"autocomplete="off&Tab;new-password""#),
            ("undecodable", r#"type="pass&bogus;word""#),
        ] {
            let html = format!(r#"<form><input {attribute} value="{label}-canary"></form>"#);
            let raw =
                json!({"type":"extension_ui_request", "method":"form", "html":html}).to_string();
            let (out, parsed) = sanitize_line(raw.as_bytes());
            assert!(
                !out.contains(&format!("{label}-canary")),
                "{label} leaked into output"
            );
            let parsed = parsed.expect("valid JSON parses");
            assert!(
                !parsed["html"]
                    .as_str()
                    .unwrap()
                    .contains(&format!("{label}-canary")),
                "{label} leaked into parsed frame"
            );
        }
    }

    #[test]
    fn sanitize_form_treats_padded_password_markers_as_credentials() {
        // NBSP (U+00A0) between autocomplete tokens and a BOM (U+FEFF) around
        // the type value: neither is ASCII whitespace, so a trimming or
        // token-splitting rule would miss them. Both stack halves use the same
        // decoded-substring rule, so neither can slip past.
        for (label, attribute, canary) in [
            (
                "nbsp autocomplete",
                "autocomplete=\"foo\u{a0}current-password\"",
                "nbsp-canary",
            ),
            (
                "bom type",
                "type=\"\u{feff}password\u{feff}\"",
                "bom-canary",
            ),
        ] {
            let html = format!("<form><input {attribute} value=\"{canary}\"></form>");
            let raw =
                json!({"type":"extension_ui_request", "method":"form", "html":html}).to_string();
            let (out, parsed) = sanitize_line(raw.as_bytes());
            assert!(!out.contains(canary), "{label} leaked into output");
            let parsed = parsed.expect("valid JSON parses");
            assert!(
                !parsed["html"].as_str().unwrap().contains(canary),
                "{label} leaked into parsed frame"
            );
            let mut journal = EventJournal::new(4, 1 << 20);
            journal.push(Arc::from(out));
            let replay = journal.since(0);
            assert!(
                !replay.events[0].text.contains(canary),
                "{label} leaked into journal"
            );
        }
    }

    #[test]
    fn sanitize_form_leaves_non_password_values_and_other_methods_untouched() {
        let html =
            r"<form><input type=text value=keep-me><input autocomplete=off value=also-keep></form>";
        let raw = json!({"type":"extension_ui_request", "method":"form", "html":html}).to_string();
        let (out, parsed) = sanitize_line(raw.as_bytes());
        assert_eq!(parsed.unwrap()["html"], html);
        assert!(out.contains("keep-me"));

        let raw = json!({"type":"extension_ui_request", "method":"select", "html":"<input type=password value=select-canary>"}).to_string();
        let (out, _) = sanitize_line(raw.as_bytes());
        assert!(out.contains("select-canary"));
    }

    #[test]
    fn sanitize_falls_back_to_raw_text_on_invalid_json() {
        let raw = b"not json at all";
        let (out, parsed) = sanitize_line(raw);
        assert_eq!(out, "not json at all");
        assert!(parsed.is_none());
    }

    /// Drives the CR/LF-strip → sanitize pipeline (exactly as the stdout
    /// reader loop does) through `tests/fixtures/line-framing-cases.json`
    /// — one shared source of line-framing edge cases instead of re-arguing
    /// each one inline. Every case asserts at least one of: exact stripped
    /// text, JSON-parseability, substring presence/absence (redaction), or
    /// emptiness after stripping.
    #[test]
    fn line_framing_fixture_matches_expected_pipeline_behavior() {
        let fixture = include_str!("../../tests/fixtures/line-framing-cases.json");
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(fixture).expect("fixture must be valid JSON");
        assert!(!cases.is_empty(), "fixture must not be empty");

        for case in &cases {
            let name = case["name"].as_str().expect("case needs a 'name'");
            let raw = case["raw"]
                .as_str()
                .unwrap_or_else(|| panic!("case '{name}' missing 'raw'"));
            let mut buf = raw.as_bytes().to_vec();
            strip_trailing_crlf(&mut buf);

            if case
                .get("expect_empty_after_strip")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
            {
                assert!(
                    buf.is_empty(),
                    "case '{name}': expected empty after CR/LF strip"
                );
                continue;
            }

            let (text, parsed) = sanitize_line(&buf);
            if let Some(expected) = case.get("expect_text").and_then(serde_json::Value::as_str) {
                assert_eq!(text, expected, "case '{name}'");
            }
            if let Some(expect_json) = case.get("expect_json").and_then(serde_json::Value::as_bool)
            {
                assert_eq!(parsed.is_some(), expect_json, "case '{name}'");
            }
            if let Some(needle) = case
                .get("expect_contains")
                .and_then(serde_json::Value::as_str)
            {
                assert!(
                    text.contains(needle),
                    "case '{name}': expected text to contain {needle:?}"
                );
            }
            if let Some(needle) = case
                .get("expect_not_contains")
                .and_then(serde_json::Value::as_str)
            {
                assert!(
                    !text.contains(needle),
                    "case '{name}': text must not contain {needle:?}"
                );
            }
        }
    }

    #[test]
    fn try_auto_approve_answers_stdin_and_returns_synthetic_notice() {
        let dir = std::env::temp_dir().join(format!(
            "omp-desktop-reader-approval-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let rule_book = RuleBook::new(dir);
        rule_book
            .grant("sess-1", None, "bash", approval::RuleScope::Session)
            .unwrap();

        // A plain `Mutex<Vec<u8>>` stands in for the real `ChildStdin` now
        // that `try_auto_approve` is generic over `W: Write` — no child
        // process needed (a spawned `cat` doesn't exist on Windows), and
        // the bytes actually written are directly inspectable below.
        let stdin: Mutex<Vec<u8>> = Mutex::new(Vec::new());

        // The real emitted shape: `Allow tool: <name>` plus the tool's own
        // `formatApprovalDetails()` lines (see approval.rs' module doc). A
        // single-line title here would keep passing even if the first-line
        // parse regressed, so this fixture is the end-to-end guard for it.
        let frame = json!({
            "type": "extension_ui_request", "id": "req-9", "method": "select",
            "title": "Allow tool: bash\nCommand: ls -la\nCwd: /tmp",
            "options": ["Approve", "Deny"]
        });
        let notice = try_auto_approve(&frame, &rule_book, "sess-1", None, &stdin);
        assert!(notice.is_some());
        let notice: serde_json::Value = serde_json::from_str(&notice.unwrap()).unwrap();
        assert_eq!(notice["type"], "desktop_auto_approval");
        assert_eq!(notice["tool"], "bash");
        // What the rule approved reaches the human, not just the tool name.
        assert_eq!(notice["details"], "Command: ls -la\nCwd: /tmp");

        // The wire shape written to stdin must stay compatible with what
        // `src/live.js`'s `answerAsk` sends: a single `extension_ui_response`
        // line carrying the original request `id` and the chosen `value`.
        let line = std::str::from_utf8(&stdin.lock().unwrap())
            .unwrap()
            .to_owned();
        assert_eq!(line.matches('\n').count(), 1, "exactly one line written");
        let sent: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(
            sent,
            json!({ "type": "extension_ui_response", "id": "req-9", "value": "Approve" })
        );
    }

    #[test]
    fn try_auto_approve_falls_through_without_a_matching_rule() {
        let dir = std::env::temp_dir().join(format!(
            "omp-desktop-reader-approval-test-nogrant-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let rule_book = RuleBook::new(dir);
        let stdin: Mutex<Vec<u8>> = Mutex::new(Vec::new());

        let frame = json!({
            "type": "extension_ui_request", "id": "req-9", "method": "select",
            "title": "Allow tool: bash", "options": ["Approve", "Deny"]
        });
        assert!(try_auto_approve(&frame, &rule_book, "sess-1", None, &stdin).is_none());
        assert!(
            stdin.lock().unwrap().is_empty(),
            "no rule granted — nothing should be written to stdin"
        );
    }

    #[test]
    fn only_a_prompt_the_human_will_answer_is_recorded_for_a_grant() {
        let dir = crate::test_support::TempDir::new("reader", "approval-track");
        let rule_book = RuleBook::new(dir.path().to_path_buf());
        rule_book
            .grant("sess-1", None, "edit", approval::RuleScope::Session)
            .unwrap();
        let stdin: Mutex<Vec<u8>> = Mutex::new(Vec::new());
        let open = Mutex::new(PendingApprovals::new(None));
        let step = |frame: &serde_json::Value| {
            auto_approve_or_track(
                frame,
                Some("extension_ui_request"),
                &rule_book,
                "sess-1",
                None,
                &stdin,
                &open,
            )
        };

        assert!(
            step(&approval_prompt("req-1", "edit")).is_some(),
            "rule-covered"
        );
        assert!(
            step(&approval_prompt("req-2", "bash")).is_none(),
            "forwarded"
        );
        let open = open.lock().unwrap();
        assert_eq!(
            open.tool("req-1"),
            None,
            "answered by the rule, not grantable"
        );
        assert_eq!(open.tool("req-2"), Some("bash"));
    }

    #[test]
    fn read_until_capped_frames_a_normal_line() {
        let data = b"hello\nworld\n".to_vec();
        let mut r = std::io::Cursor::new(data);
        let mut out = Vec::new();
        let (n, truncated) = read_until_capped(&mut r, b'\n', &mut out, 1024).unwrap();
        assert_eq!(n, 6);
        assert!(!truncated);
        assert_eq!(out, b"hello\n");
    }

    #[test]
    fn read_until_capped_reports_truncation_past_the_cap() {
        let data = b"0123456789\n".to_vec();
        let mut r = std::io::Cursor::new(data);
        let mut out = Vec::new();
        let (n, truncated) = read_until_capped(&mut r, b'\n', &mut out, 4).unwrap();
        assert!(truncated);
        assert_eq!(out.len(), 4);
        assert_eq!(n, 11); // still consumed the whole line off the pipe
    }

    #[test]
    fn read_until_capped_eof_returns_zero() {
        let data: Vec<u8> = Vec::new();
        let mut r = std::io::Cursor::new(data);
        let mut out = Vec::new();
        let (n, truncated) = read_until_capped(&mut r, b'\n', &mut out, 1024).unwrap();
        assert_eq!(n, 0);
        assert!(!truncated);
    }

    #[test]
    fn stderr_tail_is_empty_when_the_child_said_nothing() {
        // Drives the branch that decides between "clean exit" and a reason:
        // no stderr must stay `None` so the empty-payload contract holds.
        assert_eq!(StderrTail::new().to_reason(), None);
    }

    #[test]
    fn stderr_tail_collapses_blank_lines_into_one_reason() {
        // omp double-spaces its refusal banner for a terminal; the UI note
        // is one line, and a reason of "a\n\n\nb" would render as a gap.
        let mut tail = StderrTail::new();
        for line in ["No models available.", "", "  Set an API key: ", ""] {
            tail.push(line.to_string());
        }
        assert_eq!(
            tail.to_reason(),
            Some("No models available. Set an API key:".to_string())
        );
    }

    #[test]
    fn stderr_tail_keeps_the_newest_lines_within_its_line_bound() {
        // A chatty child must not let the tail grow without bound, and the
        // *newest* lines are the ones that explain an exit.
        let mut tail = StderrTail::new();
        for n in 0..(STDERR_TAIL_LINES + 10) {
            tail.push(format!("line{n}"));
        }
        let reason = tail.to_reason().expect("lines were pushed");
        assert!(
            reason.starts_with("line10 "),
            "oldest lines must be evicted first, got: {reason}"
        );
        assert!(reason.ends_with(&format!("line{}", STDERR_TAIL_LINES + 9)));
        // No assertion on the private `tail.lines.len()` field here: the
        // `starts_with("line10 ")`/`ends_with("line33")` pair above already
        // uniquely pins "exactly the newest STDERR_TAIL_LINES entries
        // survived" (any other eviction count would shift both boundary
        // values) — a `lines.len()` check would only restate that fact
        // via a field no consumer of `StderrTail` ever reads.
    }

    #[test]
    fn stderr_tail_evicts_to_stay_within_its_byte_bound() {
        // One pathological line must not pin kilobytes per session: the byte
        // bound evicts even when the line count is well under its own cap.
        let mut tail = StderrTail::new();
        tail.push("x".repeat(STDERR_TAIL_BYTES - 1));
        tail.push("the real reason".to_string());
        assert_eq!(
            tail.to_reason(),
            Some("the real reason".to_string()),
            "the oversized line must have been dropped"
        );
        assert!(tail.bytes <= STDERR_TAIL_BYTES);
    }

    #[test]
    fn stderr_tail_truncates_an_oversized_line_instead_of_wiping_the_tail() {
        // Before the fix, a single line longer than STDERR_TAIL_BYTES made
        // the eviction condition true until the deque was *empty* —
        // evicting the line itself along with everything else, so
        // `to_reason()` returned `None`: the exact blank-tab failure this
        // type exists to prevent.
        let mut tail = StderrTail::new();
        tail.push("z".repeat(STDERR_TAIL_BYTES + 500));
        let reason = tail
            .to_reason()
            .expect("an oversized line must still produce a reason");
        // The retained bytes are the line's own content, not a placeholder:
        // a truncated reason still has to explain the exit.
        assert!(reason.starts_with("zzz"));
        assert!(reason.len() <= STDERR_TAIL_BYTES);
        assert!(tail.bytes <= STDERR_TAIL_BYTES);
    }

    #[test]
    fn stderr_tail_truncation_cuts_on_a_char_boundary() {
        // omp's banners are not pure ASCII; truncating mid-character would
        // panic (`String::truncate`'s documented panic condition). Build a
        // line whose STDERR_TAIL_BYTES-th byte lands inside a multi-byte
        // character and confirm `push` neither panics nor keeps a partial
        // character.
        let mut line = "a".repeat(STDERR_TAIL_BYTES - 1);
        line.push('€'); // 3-byte UTF-8 char straddling the cut point
        line.push_str("-dropped-tail");
        let mut tail = StderrTail::new();
        tail.push(line);
        let reason = tail
            .to_reason()
            .expect("truncated line still yields a reason");
        // Exact value: proves the cut landed one byte before the 3-byte
        // `€`, dropping the whole character (not a partial encoding of
        // it) along with everything after.
        assert_eq!(reason, "a".repeat(STDERR_TAIL_BYTES - 1));
    }

    #[test]
    fn stderr_tail_oversized_line_evicts_older_lines_but_not_itself() {
        // The truncated line's length fills the whole byte budget, so
        // older retained lines are evicted to make room for it — the same
        // "newest wins" priority `stderr_tail_evicts_to_stay_within_its_byte_bound`
        // already pins. What must not happen (the bug) is the truncated
        // line evicting itself too, leaving nothing.
        let mut tail = StderrTail::new();
        tail.push("first, superseded by the newer report".to_string());
        tail.push("z".repeat(STDERR_TAIL_BYTES + 10));
        let reason = tail.to_reason().expect("the oversized line must survive");
        assert!(!reason.contains("superseded"));
        assert!(reason.starts_with('z'));
    }

    #[test]
    fn tracker_hook_records_background_frames_but_not_auto_approvals_or_retired_readers() {
        let sid = "tracker-reader-background";
        let tracker = crate::remote::tracker::tracker();
        let alive = AtomicBool::new(true);
        record_tracker_frame(sid, Some("agent_start"), None, false, &alive);
        record_tracker_frame(
            sid,
            Some("extension_ui_request"),
            Some(&approval_prompt("q1", "bash")),
            false,
            &alive,
        );
        record_tracker_frame(
            sid,
            Some("extension_ui_request"),
            Some(&approval_prompt("automatic", "edit")),
            true,
            &alive,
        );
        assert_eq!(tracker.snapshot()[sid], (true, 1));
        alive.store(false, Ordering::Release);
        record_tracker_frame(sid, Some("agent_end"), None, false, &alive);
        assert_eq!(
            tracker.snapshot()[sid],
            (true, 1),
            "retired reader must not finish a replacement turn"
        );
        tracker.on_exit(sid);
    }
}
