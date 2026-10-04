//! Which session files belong to one conversation family.
//!
//! omp's `branch` and `fork` write a new file next to the old one whose
//! `session` header names the origin in `parentSession`. A family is the
//! connected component of those links among the `*.jsonl` files of **one**
//! directory: subagent sessions live in a sub-folder named after their parent
//! file and never join, and an unrelated conversation has no link to follow.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;

use serde::Deserialize;

use crate::saved_sessions::canonical_id_from_stem;

/// Most files a family may list; the ones closest to the current file win.
pub const MAX_FAMILY_FILES: usize = 32;

/// Header lines read per file: `title`, `session`, and a little slack.
const HEADER_LINES: usize = 4;
/// Byte budget for those lines, so a malformed file cannot be read whole.
const HEADER_BYTES: u64 = 64 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Head {
    #[serde(rename = "type")]
    kind: String,
    id: Option<String>,
    parent_session: Option<String>,
}

/// What a file's `session` header says about its place in a family.
#[derive(Default)]
struct Header {
    id: Option<String>,
    /// Raw `parentSession`: a path, or a bare session id.
    parent: Option<String>,
}

/// File name (last component, either separator) of a `parentSession` path.
fn base_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// The `session` header of `path`; empty for an unreadable header.
fn header_of(path: &Path) -> Header {
    let Ok(file) = File::open(path) else {
        return Header::default();
    };
    let reader = BufReader::new(file.take(HEADER_BYTES));
    for line in reader.lines().take(HEADER_LINES).map_while(Result::ok) {
        let Ok(head) = serde_json::from_str::<Head>(&line) else {
            continue;
        };
        if head.kind == "session" {
            return Header {
                id: head.id,
                parent: head.parent_session,
            };
        }
    }
    Header::default()
}

/// The listed file a `parentSession` value names. A value with a path
/// separator or a `.jsonl` suffix is a path and links by file name; omp's
/// TUI `/fork`, `--fork` and move-off write the parent's bare session id
/// instead, found through `by_id`.
fn resolve<'a>(
    raw: &str,
    files: &'a HashMap<String, Header>,
    by_id: &HashMap<&str, &'a str>,
) -> Option<&'a str> {
    let has_suffix = Path::new(raw)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"));
    if raw.contains(['/', '\\']) || has_suffix {
        files.get_key_value(base_name(raw)).map(|(k, _)| k.as_str())
    } else {
        by_id.get(raw).copied()
    }
}

/// File names of the family of `current` (a `.jsonl` name inside `dir`):
/// `current` first, the rest oldest first by name, at most
/// [`MAX_FAMILY_FILES`].
///
/// # Errors
/// Returns the I/O error when `dir` cannot be listed.
pub fn family_of(dir: &Path, current: &str) -> io::Result<Vec<String>> {
    let mut files: HashMap<String, Header> = HashMap::new();
    for item in fs::read_dir(dir)? {
        let Ok(item) = item else { continue };
        // `file_type` does not follow symlinks: only regular files join.
        if !item.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let path = item.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            files.insert(name.to_string(), header_of(&path));
        }
    }

    // The file-name id is the durable one (a header `id` can be stale, see
    // `saved_sessions`), so it is inserted last and wins a clash.
    let mut by_id: HashMap<&str, &str> = HashMap::new();
    for (name, header) in &files {
        if let Some(id) = header.id.as_deref() {
            by_id.insert(id, name);
        }
    }
    for name in files.keys() {
        if let Some(id) = canonical_id_from_stem(Path::new(name)) {
            by_id.insert(id, name);
        }
    }

    let mut links: HashMap<&str, Vec<&str>> = HashMap::new();
    for (name, header) in &files {
        let parent = header
            .parent
            .as_deref()
            .and_then(|raw| resolve(raw, &files, &by_id));
        if let Some(parent) = parent {
            links.entry(name).or_default().push(parent);
            links.entry(parent).or_default().push(name);
        }
    }
    for neighbours in links.values_mut() {
        neighbours.sort_unstable();
    }

    let mut seen = HashSet::from([current]);
    let mut queue = VecDeque::from([current]);
    while let Some(name) = queue.pop_front() {
        for &next in links.get(name).into_iter().flatten() {
            if seen.len() < MAX_FAMILY_FILES && seen.insert(next) {
                queue.push_back(next);
            }
        }
    }
    seen.remove(current);
    let mut rest: Vec<String> = seen.into_iter().map(str::to_string).collect();
    rest.sort_unstable();
    rest.insert(0, current.to_string());
    Ok(rest)
}
