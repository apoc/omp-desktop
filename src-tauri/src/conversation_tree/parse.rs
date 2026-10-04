//! One session `.jsonl` → its kept entries (see the module doc for "kept")
//! plus the file header facts.
//!
//! Real sessions reach tens of MiB of `toolResult` content, so a line is
//! deserialised into a typed shell whose `message.content` stays a borrowed
//! [`RawValue`]; it is parsed only for user/assistant messages, and then only
//! as far as the first text block.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufRead, BufReader};
use std::path::Path;

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::Number;

use super::{Kind, TreeEntry, TreeFile, TreeUsage};

/// Longest prompt/reply text kept per entry, in chars.
const MAX_TEXT_CHARS: usize = 300;

/// What [`parse_file`] extracts from one file.
pub struct Parsed {
    pub file: TreeFile,
    /// Kept entries in file order (every parent precedes its children).
    pub entries: Vec<TreeEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Line<'a> {
    #[serde(rename = "type", borrow)]
    kind: &'a str,
    id: Option<String>,
    parent_id: Option<String>,
    timestamp: Option<String>,
    #[serde(borrow)]
    message: Option<Message<'a>>,
    #[serde(borrow)]
    purpose: Option<&'a str>,
    target_id: Option<String>,
    label: Option<String>,
    title: Option<String>,
    updated_at: Option<String>,
    first_kept_entry_id: Option<String>,
    cwd: Option<String>,
}

#[derive(Deserialize)]
struct Message<'a> {
    #[serde(borrow)]
    role: Option<&'a str>,
    /// Lenient: a malformed timestamp must not cost the whole entry.
    #[serde(borrow)]
    timestamp: Option<&'a RawValue>,
    #[serde(borrow)]
    content: Option<&'a RawValue>,
    #[serde(borrow)]
    attribution: Option<&'a str>,
    synthetic: Option<bool>,
    usage: Option<Usage>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Usage {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    cost: Cost,
    cttl: Cttl,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Cost {
    cache_read: Option<f64>,
    cache_write: Option<f64>,
}

#[derive(Deserialize, Default)]
struct Cttl {
    ephemeral5m: Option<f64>,
    ephemeral1h: Option<f64>,
}

#[derive(Deserialize)]
struct Block<'a> {
    #[serde(rename = "type", borrow)]
    kind: Option<Cow<'a, str>>,
    /// Unescaped only for the block that is used.
    #[serde(borrow)]
    text: Option<&'a RawValue>,
}

impl From<Usage> for TreeUsage {
    fn from(u: Usage) -> Self {
        let live = |v: Option<f64>| v.is_some_and(|n| n > 0.0);
        let ttl = if live(u.cttl.ephemeral1h) {
            Some(3600)
        } else if live(u.cttl.ephemeral5m) {
            Some(300)
        } else {
            None
        };
        Self {
            input: u.input,
            output: u.output,
            cache_read: u.cache_read,
            cache_write: u.cache_write,
            ttl,
            cost_read: u.cost.cache_read,
            cost_write: u.cost.cache_write,
        }
    }
}

/// Trim and cut to [`MAX_TEXT_CHARS`] on a char boundary; `None` when empty.
fn clip(text: &str) -> Option<String> {
    let text = text.trim();
    let end = text
        .char_indices()
        .nth(MAX_TEXT_CHARS)
        .map_or(text.len(), |(i, _)| i);
    let text = text[..end].trim_end();
    (!text.is_empty()).then(|| text.to_string())
}

/// First non-empty text of a message `content` (a string, or blocks).
fn first_text(content: &RawValue) -> Option<String> {
    let raw = content.get();
    if raw.starts_with('"') {
        let text: Cow<str> = serde_json::from_str(raw).ok()?;
        return clip(&text);
    }
    let blocks: Vec<Block> = serde_json::from_str(raw).ok()?;
    blocks
        .iter()
        .filter(|b| b.kind.as_deref() == Some("text"))
        .find_map(|b| clip(&serde_json::from_str::<Cow<str>>(b.text?.get()).ok()?))
}

/// Fill the message facets of a freshly built user/assistant `entry`.
fn fill_message(entry: &mut TreeEntry, msg: Message) {
    entry.ts = msg
        .timestamp
        .and_then(|raw| serde_json::from_str::<Number>(raw.get()).ok());
    entry.text = msg.content.and_then(first_text);
    if entry.kind == Kind::User {
        entry.agent = msg.attribution == Some("agent") || msg.synthetic == Some(true);
    } else {
        entry.usage = msg.usage.map(TreeUsage::from);
    }
}

/// Which kept [`Kind`] a line is, decided before anything is allocated.
fn kept_kind(line: &Line) -> Option<Kind> {
    match line.kind {
        "message" => match line.message.as_ref()?.role? {
            "user" => Some(Kind::User),
            "assistant" => Some(Kind::Assistant),
            _ => None,
        },
        "compaction" => Some(Kind::Compaction),
        "model_usage" if line.purpose == Some("cache-warm") => Some(Kind::Warm),
        _ => None,
    }
}

#[derive(Default)]
struct State {
    cwd: Option<String>,
    /// `(timestamp, title)` of the newest non-empty title seen.
    title: Option<(String, String)>,
    /// Every entry id → index into `entries` of its nearest kept
    /// ancestor-or-self (`None`: no kept ancestor).
    kept_of: HashMap<String, Option<usize>>,
    entries: Vec<TreeEntry>,
    /// `(raw target id, label)` in file order.
    labels: Vec<(String, String)>,
    /// Kept ancestor-or-self of the last line that had an id.
    leaf: Option<usize>,
}

impl State {
    fn consider_title(&mut self, at: Option<String>, title: Option<String>) {
        let Some(title) = title
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
        else {
            return;
        };
        let at = at.unwrap_or_default();
        // The header line is rewritten on every retitle and carries the newest
        // `updatedAt`; later `title_change` entries lose to it, ties go to the
        // later line.
        if self.title.as_ref().is_none_or(|(prev, _)| at >= *prev) {
            self.title = Some((at, title));
        }
    }

    /// Index of the kept ancestor-or-self of the entry `id`.
    fn kept_index(&self, id: &str) -> Option<usize> {
        self.kept_of.get(id).copied().flatten()
    }

    /// Push the kept entry for `line` (`kind` as decided by [`kept_kind`]).
    fn push_kept(&mut self, id: &str, kind: Kind, parent: Option<usize>, line: Line) -> usize {
        // Cloned: the entry owns its parent's id, the parent stays in `entries`.
        let parent_id = parent.map(|i| self.entries[i].id.clone());
        // Cloned: the id is also the key in `kept_of`.
        let mut entry = TreeEntry::new(id.to_string(), parent_id, kind, line.timestamp);
        match kind {
            Kind::User | Kind::Assistant => {
                if let Some(msg) = line.message {
                    fill_message(&mut entry, msg);
                }
            }
            Kind::Compaction => {
                if let Some(target) = line.first_kept_entry_id {
                    let kept = self.kept_index(&target);
                    // Cloned: the compaction carries its own copy of the id.
                    entry.first_kept_id = kept.map(|i| self.entries[i].id.clone());
                    entry.first_kept_exact = kept.is_some_and(|i| self.entries[i].id == target);
                }
            }
            Kind::Warm => {}
        }
        self.entries.push(entry);
        self.entries.len() - 1
    }

    fn apply(&mut self, mut line: Line) {
        match line.kind {
            "title" => return self.consider_title(line.updated_at, line.title),
            "session" => {
                self.cwd = line.cwd;
                return;
            }
            _ => {}
        }
        let Some(id) = line.id.take() else { return };
        let parent = line.parent_id.as_deref().and_then(|p| self.kept_index(p));
        let kept = if let Some(kind) = kept_kind(&line) {
            Some(self.push_kept(&id, kind, parent, line))
        } else {
            match line.kind {
                "title_change" => self.consider_title(line.timestamp, line.title),
                "label" => {
                    if let Some(target) = line.target_id {
                        self.labels.push((target, line.label.unwrap_or_default()));
                    }
                }
                _ => {}
            }
            parent
        };
        self.kept_of.insert(id, kept);
        self.leaf = kept;
    }

    fn finish(mut self, path: &Path) -> Parsed {
        // omp keys a label by its raw target: an empty one removes that
        // target's label only, never another entry collapsed into the same
        // kept ancestor. Later lines win, then the survivors are mapped.
        let mut by_target: HashMap<String, (usize, String)> = HashMap::new();
        for (order, (target, label)) in std::mem::take(&mut self.labels).into_iter().enumerate() {
            let label = label.trim();
            if label.is_empty() {
                by_target.remove(&target);
            } else {
                by_target.insert(target, (order, label.to_string()));
            }
        }
        // Per kept entry the label of the latest line wins.
        let mut latest: HashMap<usize, (usize, String)> = HashMap::new();
        for (target, (order, label)) in by_target {
            let Some(kept) = self.kept_index(&target) else {
                continue;
            };
            if latest.get(&kept).is_none_or(|(prev, _)| order > *prev) {
                latest.insert(kept, (order, label));
            }
        }
        for (kept, (_, label)) in latest {
            self.entries[kept].label = Some(label);
        }
        // Cloned: the leaf id is also the entry's own id.
        let leaf_id = self.leaf.map(|i| self.entries[i].id.clone());
        Parsed {
            file: TreeFile {
                path: path.to_string_lossy().into_owned(),
                cwd: self.cwd,
                title: self.title.map(|(_, t)| t),
                leaf_id,
                current: false,
            },
            entries: self.entries,
        }
    }
}

/// Parse one session file, skipping unreadable and malformed lines.
///
/// # Errors
/// Returns the I/O error when the file cannot be opened.
pub fn parse_file(path: &Path) -> io::Result<Parsed> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut state = State::default();
    let mut buf = String::new();
    loop {
        buf.clear();
        match reader.read_line(&mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            // Not UTF-8: the line is consumed, move on to the next.
            Err(e) if e.kind() == io::ErrorKind::InvalidData => continue,
            Err(_) => break,
        }
        if let Ok(line) = serde_json::from_str::<Line>(buf.trim()) {
            state.apply(line);
        }
    }
    Ok(state.finish(path))
}
