use std::collections::HashMap;
use std::io::{BufRead, BufReader, ErrorKind, Write as _};
use std::path::PathBuf;
use std::process::{ChildStderr, ChildStdin, ChildStdout};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

use crate::approval::{self, RuleBook};

use super::inner::BridgeInner;
use super::journal::EventJournal;

/// Hard cap on a single RPC line. Defends the reader thread from runaway
/// agent output that could otherwise allocate unbounded memory.
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

/// Object keys whose values are redacted before a frame ever reaches the
/// webview. Matched case-insensitively after stripping `_`/`-` separators,
/// so `Authorization`, `api_key`, `api-key`, and `apiKey` are all caught by
/// one entry. `headers` is redacted wholesale (not walked) because a model
/// provider's request headers routinely carry `Authorization` alongside
/// harmless entries, and there is no benefit to preserving the harmless
/// ones once the object as a whole must be treated as sensitive.
const REDACTED_KEYS: &[&str] = &[
    "headers",
    "authorization",
    "apikey",
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "password",
    "secret",
    "credential",
    "credentials",
];

const REDACTED_PLACEHOLDER: &str = "[REDACTED]";

/// One line forwarded to the frontend, stamped with its journal `seq`. Kept
/// in sync with `replay_events`'s `ReplayEvent` — both sides of the wire
/// (live `agent://line/{id}` events and a replay response) use the same
/// `{seq, text}` shape so the frontend can dispatch either through one path.
#[derive(serde::Serialize, Clone)]
struct LineEvent<'a> {
    seq: u64,
    text: &'a str,
}

fn normalize_key(key: &str) -> String {
    key.chars()
        .filter(|c| *c != '_' && *c != '-')
        .flat_map(char::to_lowercase)
        .collect()
}

/// Recursively replace the value of any object key matching [`REDACTED_KEYS`]
/// with [`REDACTED_PLACEHOLDER`]. Redacted subtrees are not descended into —
/// once a key is sensitive, nothing under it is worth preserving.
fn sanitize_frame(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, val) in map.iter_mut() {
                if REDACTED_KEYS.contains(&normalize_key(key).as_str()) {
                    *val = serde_json::Value::String(REDACTED_PLACEHOLDER.to_string());
                } else {
                    sanitize_frame(val);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                sanitize_frame(item);
            }
        }
        _ => {}
    }
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
            sanitize_frame(&mut value);
            let text = serde_json::to_string(&value)
                .unwrap_or_else(|_| String::from_utf8_lossy(raw).into_owned());
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
/// human still sees *that* it happened. Returns `None` for every frame
/// that isn't an approval prompt, or is one the rule book doesn't cover —
/// those fall through to the human exactly as before.
fn try_auto_approve(
    frame: &serde_json::Value,
    rule_book: &RuleBook,
    sid: &str,
    project_root: Option<&std::path::Path>,
    stdin: &Mutex<ChildStdin>,
) -> Option<String> {
    let tool = approval::approval_tool_name(frame)?;
    if !rule_book.is_granted(sid, project_root, tool) {
        return None;
    }
    let id = approval::approval_request_id(frame)?;
    let response = serde_json::json!({
        "type": "extension_ui_response",
        "id": id,
        "value": "Approve",
    })
    .to_string();
    if let Ok(mut w) = stdin.lock() {
        let _ = writeln!(*w, "{response}");
        let _ = w.flush();
    }
    Some(serde_json::json!({ "type": "desktop_auto_approval", "tool": tool }).to_string())
}

/// Grouped arguments for [`spawn_stdout_reader`] — bundled into one struct
/// rather than nine positional parameters.
pub(super) struct StdoutReaderConfig {
    pub(super) sessions: Arc<Mutex<HashMap<String, BridgeInner>>>,
    pub(super) sid: String,
    pub(super) gen: u64,
    pub(super) journal: Arc<Mutex<EventJournal>>,
    pub(super) stdin: Arc<Mutex<ChildStdin>>,
    pub(super) rule_book: Arc<RuleBook>,
    pub(super) project_root: Option<PathBuf>,
    pub(super) app: AppHandle,
    pub(super) stdout: ChildStdout,
}

pub(super) fn spawn_stdout_reader(config: StdoutReaderConfig) {
    let StdoutReaderConfig {
        sessions,
        sid,
        gen,
        journal,
        stdin,
        rule_book,
        project_root,
        app,
        stdout,
    } = config;
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let line_event = format!("agent://line/{sid}");
        let exit_event = format!("agent://exit/{sid}");
        let mut buf: Vec<u8> = Vec::with_capacity(8192);
        let mut exit_reason = String::new();

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
                    // A rule-covered approval prompt is answered directly on
                    // stdin and replaced with a synthetic notice — the human
                    // never sees the original ask, but does see that it was
                    // auto-approved.
                    let text = parsed
                        .as_ref()
                        .and_then(|frame| {
                            try_auto_approve(
                                frame,
                                &rule_book,
                                &sid,
                                project_root.as_deref(),
                                &stdin,
                            )
                        })
                        .unwrap_or(sanitized);
                    let seq = journal.lock().map_or(0, |mut j| j.push(text.clone()));
                    let _ = app.emit(&line_event, LineEvent { seq, text: &text });
                }
                Err(e) => {
                    exit_reason = format!("stdout read error: {e}");
                    break;
                }
            }
        }

        // Process exited. Only remove our own map entry — if start_session
        // already replaced this session with a fresh incarnation (higher
        // generation), leave it alone.
        if let Ok(mut s) = sessions.lock() {
            if let Some(inner) = s.get(&sid) {
                if inner.gen == gen {
                    s.remove(&sid);
                }
            }
        }
        // Empty payload = clean exit; non-empty = error reason. See the
        // AgentBridge doc-comment for the full event contract.
        let _ = app.emit(&exit_event, exit_reason);
    });
}

pub(super) fn spawn_stderr_reader(sid: String, stderr: ChildStderr) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            eprintln!("[omp/{sid}] {line}");
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

        // A real ChildStdin can't be constructed without a live child in a
        // unit test; use a piped process purely as a writable stdin handle.
        let mut child = std::process::Command::new("cat")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn cat");
        let stdin = Mutex::new(child.stdin.take().unwrap());

        let frame = json!({
            "type": "extension_ui_request", "id": "req-9", "method": "select",
            "title": "Allow tool: bash", "options": ["Approve", "Deny"]
        });
        let notice = try_auto_approve(&frame, &rule_book, "sess-1", None, &stdin);
        assert!(notice.is_some());
        let notice: serde_json::Value = serde_json::from_str(&notice.unwrap()).unwrap();
        assert_eq!(notice["type"], "desktop_auto_approval");
        assert_eq!(notice["tool"], "bash");

        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn try_auto_approve_falls_through_without_a_matching_rule() {
        let dir = std::env::temp_dir().join(format!(
            "omp-desktop-reader-approval-test-nogrant-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let rule_book = RuleBook::new(dir);
        let mut child = std::process::Command::new("cat")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn cat");
        let stdin = Mutex::new(child.stdin.take().unwrap());

        let frame = json!({
            "type": "extension_ui_request", "id": "req-9", "method": "select",
            "title": "Allow tool: bash", "options": ["Approve", "Deny"]
        });
        assert!(try_auto_approve(&frame, &rule_book, "sess-1", None, &stdin).is_none());

        let _ = child.kill();
        let _ = child.wait();
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
}
