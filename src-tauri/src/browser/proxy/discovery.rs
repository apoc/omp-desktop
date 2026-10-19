//! The `/json*` discovery endpoints, answered from the broker: Chromium
//! listens on no port, so the proxy speaks this part of its HTTP protocol
//! itself, with every WebSocket URL pointing back at the proxy.

use std::borrow::Cow;
use std::time::Duration;

use serde_json::{json, Map, Value};

use super::Refusal;
use crate::browser::broker::Broker;

/// How long one discovery command may take.
const CALL_TIMEOUT: Duration = Duration::from_secs(10);

const NOT_FOUND: Refusal = ("404 Not Found", "unknown discovery endpoint");
/// Chromium's error for a target id it does not know.
const NO_TARGET: &str = "No target with given id found";

/// A discovery request [`parse`] understood.
pub(super) enum Request<'a> {
    /// `/json/version`
    Version,
    /// `/json`, `/json/list`
    List,
    /// `PUT /json/new?<url>`, the URL percent-encoded or not.
    New(&'a str),
    /// `/json/activate/<targetId>`
    Activate(&'a str),
    /// `/json/close/<targetId>`
    Close(&'a str),
}

/// What a request is answered with.
pub(super) enum Answer {
    Json(Value),
    Text(&'static str),
    /// `404 Not Found` with this body: Chrome's answer for an unknown
    /// target id.
    NotFound(String),
}

/// The request behind a `/json*` `target`; `Err` is the response refusing
/// it. Only `/json/new` cares about the method (it creates a page, so like
/// Chrome only `PUT`).
pub(super) fn parse<'a>(method: &str, target: &'a str) -> Result<Request<'a>, Refusal> {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    match path.strip_suffix('/').unwrap_or(path) {
        "/json" | "/json/list" => Ok(Request::List),
        "/json/version" => Ok(Request::Version),
        "/json/new" if method == "PUT" => Ok(Request::New(query)),
        "/json/new" => Err((
            "405 Method Not Allowed",
            "/json/new creates a page: it supports only the PUT verb",
        )),
        path => match (
            path.strip_prefix("/json/activate/"),
            path.strip_prefix("/json/close/"),
        ) {
            (Some(id), _) if !id.is_empty() => Ok(Request::Activate(id)),
            (_, Some(id)) if !id.is_empty() => Ok(Request::Close(id)),
            _ => Err(NOT_FOUND),
        },
    }
}

/// Answer `request` from `broker`; `port` is the proxy's, for the WebSocket
/// URLs. `Err` is the broker's error message.
pub(super) fn answer(request: &Request<'_>, broker: &Broker, port: u16) -> Result<Answer, String> {
    match *request {
        Request::Version => {
            let mut version = broker.call("Browser.getVersion", json!({}), CALL_TIMEOUT)?;
            let mut out = Map::new();
            for (key, field) in [
                ("Browser", "product"),
                ("Protocol-Version", "protocolVersion"),
                ("User-Agent", "userAgent"),
                ("V8-Version", "jsVersion"),
                ("WebKit-Version", "revision"),
            ] {
                out.insert(key.into(), take(&mut version, field));
            }
            out.insert(
                "webSocketDebuggerUrl".into(),
                Value::String(format!(
                    "ws://127.0.0.1:{port}/devtools/browser/{}",
                    broker.id()
                )),
            );
            Ok(Answer::Json(Value::Object(out)))
        }
        Request::List => {
            let mut targets = broker.call("Target.getTargets", json!({}), CALL_TIMEOUT)?;
            let Value::Array(infos) = take(&mut targets, "targetInfos") else {
                return Err("Target.getTargets: no targetInfos".into());
            };
            let entries = infos
                .into_iter()
                .filter(|info| !matches!(info["type"].as_str(), Some("browser" | "tab")))
                .map(|info| entry(info, port))
                .collect();
            Ok(Answer::Json(Value::Array(entries)))
        }
        Request::New(query) => {
            let url = percent_decode(query);
            let url = if url.is_empty() { "about:blank" } else { &*url };
            let mut created =
                broker.call("Target.createTarget", json!({ "url": url }), CALL_TIMEOUT)?;
            let id = take(&mut created, "targetId");
            if !id.is_string() {
                return Err("Target.createTarget: no targetId".into());
            }
            // A page that has just been created has not loaded anything: its
            // title is its URL.
            let info = json!({ "targetId": id, "type": "page", "title": url, "url": url });
            Ok(Answer::Json(entry(info, port)))
        }
        Request::Activate(id) => broker
            .call(
                "Target.activateTarget",
                json!({ "targetId": id }),
                CALL_TIMEOUT,
            )
            .map_or_else(
                |e| unknown_target(id, e),
                |_| Ok(Answer::Text("Target activated")),
            ),
        Request::Close(id) => broker
            .call(
                "Target.closeTarget",
                json!({ "targetId": id }),
                CALL_TIMEOUT,
            )
            .map_or_else(
                |e| unknown_target(id, e),
                |_| Ok(Answer::Text("Target is closing")),
            ),
    }
}

/// A command on target `id` that failed with `error`: Chrome's own 404 when
/// the target does not exist (the broker passes on only the CDP message, so
/// that is what is matched), the error otherwise.
fn unknown_target(id: &str, error: String) -> Result<Answer, String> {
    if error == NO_TARGET {
        Ok(Answer::NotFound(format!("No such target id: {id}")))
    } else {
        Err(error)
    }
}

/// A `/json/list` entry from a CDP `TargetInfo`.
fn entry(mut info: Value, port: u16) -> Value {
    let id = take(&mut info, "targetId");
    let socket = format!(
        "ws://127.0.0.1:{port}/devtools/page/{}",
        id.as_str().unwrap_or_default()
    );
    let mut out = Map::new();
    out.insert("description".into(), Value::String(String::new()));
    out.insert("devtoolsFrontendUrl".into(), Value::String(String::new()));
    out.insert("id".into(), id);
    for field in ["title", "type", "url"] {
        out.insert(field.into(), take(&mut info, field));
    }
    out.insert("webSocketDebuggerUrl".into(), Value::String(socket));
    Value::Object(out)
}

/// `value[key]` moved out (`null` when absent or not an object).
fn take(value: &mut Value, key: &str) -> Value {
    value.get_mut(key).map(Value::take).unwrap_or_default()
}

/// `%XX` escapes decoded; anything else, a malformed escape too, kept.
fn percent_decode(text: &str) -> Cow<'_, str> {
    if !text.contains('%') {
        return Cow::Borrowed(text);
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while let Some(&byte) = bytes.get(i) {
        let escaped = if byte == b'%' {
            bytes.get(i + 1..i + 3).and_then(hex_byte)
        } else {
            None
        };
        if let Some(decoded) = escaped {
            out.push(decoded);
            i += 3;
        } else {
            out.push(byte);
            i += 1;
        }
    }
    Cow::Owned(
        String::from_utf8(out)
            .unwrap_or_else(|invalid| String::from_utf8_lossy(invalid.as_bytes()).into_owned()),
    )
}

/// Two hex digits as the byte they spell.
fn hex_byte(hex: &[u8]) -> Option<u8> {
    if !hex.iter().all(u8::is_ascii_hexdigit) {
        return None;
    }
    u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()
}

#[cfg(test)]
mod tests {
    use super::{parse, percent_decode, Request};

    #[test]
    fn discovery_paths_parse() {
        assert!(matches!(parse("GET", "/json"), Ok(Request::List)));
        assert!(matches!(parse("GET", "/json/list?t=1"), Ok(Request::List)));
        assert!(matches!(parse("GET", "/json/"), Ok(Request::List)));
        assert!(matches!(
            parse("GET", "/json/version"),
            Ok(Request::Version)
        ));
        assert!(matches!(
            parse("PUT", "/json/new?about:blank"),
            Ok(Request::New("about:blank"))
        ));
        assert!(matches!(
            parse("GET", "/json/new?about:blank"),
            Err(("405 Method Not Allowed", _))
        ));
        assert!(matches!(
            parse("GET", "/json/activate/T1"),
            Ok(Request::Activate("T1"))
        ));
        assert!(matches!(
            parse("GET", "/json/close/T1"),
            Ok(Request::Close("T1"))
        ));
        for unknown in [
            "/json/activate/",
            "/json/close",
            "/json/protocol",
            "/jsonx",
            "/json/version/x",
        ] {
            assert!(
                matches!(parse("GET", unknown), Err(("404 Not Found", _))),
                "{unknown}"
            );
        }
    }

    #[test]
    fn a_new_page_url_is_percent_decoded() {
        assert_eq!(percent_decode("about:blank"), "about:blank");
        assert_eq!(
            percent_decode("https://e.example/a%20b?q=%26"),
            "https://e.example/a b?q=&"
        );
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz%4"), "%zz%4");
    }
}
