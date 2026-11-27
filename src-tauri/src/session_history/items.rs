//! The second pass: the lines of the returned page's entries, read again by
//! their byte offset, → their [`Item`]s. Kept blocks and fields are copied
//! verbatim; only a user image's blob reference is replaced by its data.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde_json::value::{to_raw_value, RawValue};
use serde_json::{Map, Value};

use super::blob::{self, Blobs, Data};
use super::iso::iso_ms;
use super::parse::{self, Block, Entry, Line, Payload};
use super::Item;

fn own(raw: Option<&RawValue>) -> Option<Box<RawValue>> {
    raw.map(ToOwned::to_owned)
}

/// An image block whose data is blob `hash`, with the blob's data instead;
/// `None` when the blob cannot be read.
fn resolved_image(raw: &RawValue, hash: &str, blobs: &mut Blobs) -> Option<Box<RawValue>> {
    let data = blobs.read(hash)?;
    let mut block: Map<String, Value> = serde_json::from_str(raw.get()).ok()?;
    block.insert("data".to_string(), Value::String(data));
    to_raw_value(&block).ok()
}

/// The shown blocks of a message `content` whose type is in `keep` (a string
/// content is one text block), and whether one of them is visible.
fn blocks(
    content: Option<&RawValue>,
    keep: &[&str],
    blobs: &mut Blobs,
) -> (Vec<Box<RawValue>>, bool) {
    let Some(content) = content else {
        return (Vec::new(), false);
    };
    let raw = content.get();
    if raw.starts_with('"') {
        // `raw` is a JSON string literal, so the block is valid JSON.
        let block = RawValue::from_string(format!(r#"{{"type":"text","text":{raw}}}"#)).ok();
        return (block.into_iter().collect(), parse::non_blank(Some(content)));
    }
    let mut kept = Vec::new();
    let mut visible = false;
    for (raw, shell) in parse::kept_blocks(content, keep) {
        let block = match shell.kind.as_deref() {
            Some("image") => image(raw, &shell, blobs),
            _ => Some(raw.to_owned()),
        };
        if let Some(block) = block {
            visible = visible || parse::visible_block(&shell);
            kept.push(block);
        }
    }
    (kept, visible)
}

/// An image block as shown: inline data as is, a blob reference resolved;
/// `None` for a reference that cannot be.
fn image(raw: &RawValue, shell: &Block, blobs: &mut Blobs) -> Option<Box<RawValue>> {
    match blob::classify(shell.data.as_deref()?) {
        Data::Inline => Some(raw.to_owned()),
        Data::Blob(hash) => resolved_image(raw, hash, blobs),
        Data::Malformed => None,
    }
}

fn message(msg: &Payload, blobs: &mut Blobs) -> Option<Item> {
    match msg.role? {
        "user" => {
            let (content, visible) = blocks(msg.content, &["text", "image"], blobs);
            visible.then(|| Item::User {
                timestamp: msg.timestamp(),
                content,
            })
        }
        "assistant" => Some(Item::Assistant {
            timestamp: msg.timestamp(),
            content: blocks(msg.content, &["text", "thinking"], blobs).0,
            stop_reason: own(msg.stop_reason),
            error_message: own(msg.error_message),
            error_status: own(msg.error_status),
            provider: own(msg.provider),
            model: own(msg.model),
            usage: own(msg.usage),
            retry_recovery: own(msg.retry_recovery),
        }),
        _ => None,
    }
}

/// The item of one line; `None` when it shows nothing.
fn item(line: &Line, blobs: &mut Blobs) -> Option<Item> {
    match line.kind {
        "message" => message(line.message.as_ref()?, blobs),
        "custom_message" => Some(Item::Custom {
            custom_type: own(line.custom_type),
            timestamp: line.timestamp.and_then(iso_ms),
        }),
        "compaction" => Some(Item::CompactionSummary {
            timestamp: line.timestamp.and_then(iso_ms),
            summary: own(line.summary),
            short_summary: own(line.short_summary),
            tokens_before: own(line.tokens_before),
        }),
        _ => None,
    }
}

/// The items of `entries`, in that order, read from `path` again.
///
/// # Errors
/// Returns an error when the file cannot be read, or when a line no longer
/// holds its entry: omp rewrote the file since the first pass (appends keep
/// the offsets valid).
pub fn read<'e>(
    path: &Path,
    entries: impl IntoIterator<Item = &'e Entry>,
    blobs: &mut Blobs,
) -> Result<Vec<Item>, String> {
    let shown = path.display();
    let changed = || format!("{shown} changed while it was read; try again");
    let mut file = File::open(path).map_err(|e| format!("cannot read {shown}: {e}"))?;
    let mut buf = Vec::new();
    let mut items = Vec::new();
    for entry in entries {
        buf.resize(entry.len, 0);
        file.seek(SeekFrom::Start(entry.offset))
            .and_then(|_| file.read_exact(&mut buf))
            .map_err(|_| changed())?;
        let line = std::str::from_utf8(&buf)
            .ok()
            .and_then(|text| serde_json::from_str::<Line>(text.trim()).ok())
            .filter(|line| line.id.as_deref() == Some(entry.id.as_str()))
            .ok_or_else(changed)?;
        items.extend(item(&line, blobs));
    }
    Ok(items)
}
