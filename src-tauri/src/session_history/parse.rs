//! The first pass: one session `.jsonl` → its entries in file order, each
//! reduced to the facts paging needs (tree links, leaf marker, timestamp,
//! whether it is shown and counted) plus where its line is. Items are built
//! later from the returned page's lines only ([`super::items`]).
//!
//! As in `conversation_tree/parse.rs`, a line is deserialised into a typed
//! shell whose values stay borrowed [`RawValue`]s: a `toolResult` body (real
//! sessions reach tens of MiB of them) is never parsed or copied, and message
//! `content` is split into blocks only for user/assistant messages.

use std::borrow::Cow;
use std::fs::File;
use std::io::{self, BufReader};
use std::path::Path;

use serde::{Deserialize, Deserializer};
use serde_json::value::RawValue;
use serde_json::Number;

use super::blob::{self, Data};

/// One session entry (any line with an `id`, the `session` header aside).
pub struct Entry {
    pub id: String,
    pub parent_id: Option<String>,
    pub active_leaf: Leaf,
    /// `message.timestamp` of a `message` entry, in ms: the paging anchor.
    pub ts: Option<f64>,
    /// The entry yields an item.
    pub shown: bool,
    /// The item is a display item: it counts toward the page `limit`.
    pub counted: bool,
    /// A user/assistant message with shown content (an assistant's
    /// non-blank text or thinking): the frontend always renders it, so a
    /// page may start at it. An error-only assistant is counted, not visible.
    pub visible: bool,
    /// Set for a `compaction` entry.
    pub compaction: Option<Compaction>,
    /// Byte offset and length of the entry's line.
    pub offset: u64,
    pub len: usize,
}

/// An entry's `activeLeafId`.
#[derive(Default)]
pub enum Leaf {
    /// Absent: the leaf is the entry itself.
    #[default]
    Own,
    /// JSON `null`: no leaf.
    Cleared,
    /// Another entry's id (or its own).
    Id(String),
}

impl<'de> Deserialize<'de> for Leaf {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(Option::<String>::deserialize(d)?.map_or(Self::Cleared, Self::Id))
    }
}

/// The placement facts of a `compaction` entry.
pub struct Compaction {
    pub first_kept: Option<String>,
    /// `method: "snapcompact"`.
    pub snap: bool,
    /// The raw `tokensBefore`.
    pub tokens_before: Option<Box<str>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Line<'a> {
    #[serde(rename = "type", borrow)]
    pub kind: &'a str,
    pub id: Option<String>,
    pub parent_id: Option<String>,
    /// Absent → `Leaf::Own` (`default`).
    #[serde(default)]
    pub active_leaf_id: Leaf,
    /// The entry's ISO timestamp; lenient, like every value read here.
    #[serde(borrow)]
    pub timestamp: Option<&'a RawValue>,
    #[serde(borrow)]
    pub message: Option<Payload<'a>>,
    #[serde(borrow)]
    pub custom_type: Option<&'a RawValue>,
    #[serde(borrow)]
    pub summary: Option<&'a RawValue>,
    #[serde(borrow)]
    pub short_summary: Option<&'a RawValue>,
    #[serde(borrow)]
    pub tokens_before: Option<&'a RawValue>,
    pub first_kept_entry_id: Option<String>,
    #[serde(borrow)]
    pub method: Option<Cow<'a, str>>,
}

/// A `message` entry's `message`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Payload<'a> {
    #[serde(borrow)]
    pub role: Option<&'a str>,
    #[serde(borrow)]
    pub timestamp: Option<&'a RawValue>,
    #[serde(borrow)]
    pub content: Option<&'a RawValue>,
    #[serde(borrow)]
    pub stop_reason: Option<&'a RawValue>,
    #[serde(borrow)]
    pub error_message: Option<&'a RawValue>,
    #[serde(borrow)]
    pub error_status: Option<&'a RawValue>,
    #[serde(borrow)]
    pub provider: Option<&'a RawValue>,
    #[serde(borrow)]
    pub model: Option<&'a RawValue>,
    #[serde(borrow)]
    pub usage: Option<&'a RawValue>,
    #[serde(borrow)]
    pub retry_recovery: Option<&'a RawValue>,
}

impl Payload<'_> {
    pub fn timestamp(&self) -> Option<Number> {
        self.timestamp
            .and_then(|raw| serde_json::from_str(raw.get()).ok())
    }

    /// `stopReason` is `"error"`.
    pub fn failed(&self) -> bool {
        self.stop_reason
            .and_then(|r| serde_json::from_str::<Cow<str>>(r.get()).ok())
            .is_some_and(|r| r == "error")
    }
}

#[derive(Deserialize)]
pub struct Block<'a> {
    #[serde(rename = "type", borrow)]
    pub kind: Option<Cow<'a, str>>,
    #[serde(borrow)]
    pub text: Option<&'a RawValue>,
    #[serde(borrow)]
    pub thinking: Option<&'a RawValue>,
    /// An image's base64 data or blob reference.
    #[serde(borrow)]
    pub data: Option<Cow<'a, str>>,
}

/// `raw` is a JSON string with a non-whitespace char. Scanned without
/// unescaping: the escapes `\n`, `\t`, `\r` and `\f` are whitespace, any
/// other escape (`\u0020` included) counts as a visible char.
pub fn non_blank(raw: Option<&RawValue>) -> bool {
    let Some(inner) = raw.and_then(|r| r.get().strip_prefix('"')?.strip_suffix('"')) else {
        return false;
    };
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' if matches!(chars.next(), Some('n' | 't' | 'r' | 'f')) => {}
            c if c.is_whitespace() => {}
            _ => return true,
        }
    }
    false
}

/// The blocks of an array `content` whose type is in `keep`, each with its
/// shell; empty for any other `content`.
pub fn kept_blocks<'a, 'k>(
    content: &'a RawValue,
    keep: &'k [&str],
) -> impl Iterator<Item = (&'a RawValue, Block<'a>)> + use<'a, 'k> {
    serde_json::from_str::<Vec<&RawValue>>(content.get())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|raw| Some((raw, serde_json::from_str::<Block>(raw.get()).ok()?)))
        .filter(move |(_, shell)| shell.kind.as_deref().is_some_and(|k| keep.contains(&k)))
}

/// The block is shown: an image whose data is not a refused reference, or
/// non-blank text or thinking.
pub fn visible_block(shell: &Block) -> bool {
    match shell.kind.as_deref() {
        Some("image") => shell
            .data
            .as_deref()
            .is_some_and(|d| blob::classify(d) != Data::Malformed),
        _ => non_blank(shell.text) || non_blank(shell.thinking),
    }
}

/// A message `content` holds a shown block of a type in `keep` (a string
/// content is one text block).
fn visible(content: Option<&RawValue>, keep: &[&str]) -> bool {
    let Some(content) = content else { return false };
    if content.get().starts_with('"') {
        return non_blank(Some(content));
    }
    kept_blocks(content, keep).any(|(_, shell)| visible_block(&shell))
}

/// The facts of one parsed line at `offset`; `None` for the header and
/// id-less lines.
fn entry(line: Line, offset: u64, len: usize) -> Option<Entry> {
    if line.kind == "session" {
        return None;
    }
    let mut entry = Entry {
        id: line.id?,
        parent_id: line.parent_id,
        active_leaf: line.active_leaf_id,
        ts: None,
        shown: false,
        counted: false,
        visible: false,
        compaction: None,
        offset,
        len,
    };
    match line.kind {
        "message" => {
            let Some(msg) = &line.message else {
                return Some(entry);
            };
            entry.ts = msg.timestamp().as_ref().and_then(Number::as_f64);
            match msg.role {
                Some("user") => {
                    entry.shown = visible(msg.content, &["text", "image"]);
                    entry.counted = entry.shown;
                    entry.visible = entry.shown;
                }
                Some("assistant") => {
                    entry.shown = true;
                    entry.visible = visible(msg.content, &["text", "thinking"]);
                    entry.counted = msg.failed() || entry.visible;
                }
                _ => {}
            }
        }
        "custom_message" => entry.shown = true,
        "compaction" => {
            entry.shown = true;
            entry.counted = true;
            entry.compaction = Some(Compaction {
                first_kept: line.first_kept_entry_id,
                snap: line.method.as_deref() == Some("snapcompact"),
                tokens_before: line.tokens_before.map(|raw| Box::from(raw.get())),
            });
        }
        _ => {}
    }
    Some(entry)
}

/// Read the entries of one session file, skipping malformed lines.
///
/// # Errors
/// Returns the I/O error when the file cannot be opened.
pub fn parse_file(path: &Path) -> io::Result<Vec<Entry>> {
    let mut entries = Vec::new();
    crate::conversation_tree::for_each_line(
        BufReader::new(File::open(path)?),
        |text, offset, len| {
            if let Some(entry) = serde_json::from_str::<Line>(text)
                .ok()
                .and_then(|line| entry(line, offset, len))
            {
                entries.push(entry);
            }
        },
    );
    Ok(entries)
}
