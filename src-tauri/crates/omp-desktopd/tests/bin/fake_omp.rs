//! A fake `omp` for the session-host integration test: answers a handful of
//! scripted frames and logs everything it receives (when `FAKE_OMP_LOG` is
//! set) so the test can assert what the service sent.

use omp_desktop_core::persona_protocol::MAX_LINE_BYTES;
use std::io::{BufRead, Write};

fn main() {
    let log = std::env::var("FAKE_OMP_LOG").ok();
    let mut out = std::io::stdout();
    let mut say = |s: &str| {
        writeln!(out, "{s}").unwrap();
        out.flush().unwrap();
    };
    say(r#"{"type":"ready","protocolVersion":1}"#);
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        if let Some(p) = &log {
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(p)
                .unwrap();
            writeln!(f, "{line}").unwrap();
        }
        let v: serde_json::Value = serde_json::from_str(&line).unwrap_or_default();
        match v["type"].as_str() {
            Some("prompt") => {
                say(r#"{"type":"agent_start"}"#);
                say(
                    r#"{"type":"message_end","message":{"role":"assistant","usage":{"input":100,"output":50,"cacheRead":999,"cacheWrite":10}}}"#,
                );
                say(
                    r#"{"type":"extension_ui_request","id":"ap1","method":"select","title":"Allow tool: bash\nCommand: ls","options":["Approve","Deny"]}"#,
                );
            }
            Some("longline") => {
                // A line past the service's cap whose cut falls inside a
                // two-byte character, followed by a frame that must survive.
                let prefix = r#"{"type":"noise","pad":""#;
                let offset = MAX_LINE_BYTES - prefix.len();
                let ascii = if offset % 2 == 0 { 1 } else { 2 };
                let mut pad = "x".repeat(ascii);
                pad.push_str(&"é".repeat((offset - ascii) / 2 + 1));
                say(&format!("{prefix}{pad}\"}}"));
                say(r#"{"type":"agent_start"}"#);
            }
            Some("extension_ui_response") if v["id"] == "ap1" => {
                say(r#"{"type":"agent_end","yielded":true}"#);
            }
            Some("crash") => std::process::exit(3),
            _ => {}
        }
    }
}
