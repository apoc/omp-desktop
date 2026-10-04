//! The `conversation_tree` command: the active conversation and every file it
//! was branched/forked from or into, merged into one entry graph for the
//! tree navigator (`src/app/conversation-tree.js`).
//!
//! # Kept and collapsed entries
//! Only the entries the navigator draws are *kept*: user and assistant
//! messages, compactions, and `cache-warm` usage records (they refresh the
//! cache). Everything else (tool results, custom entries, model changes, …)
//! is collapsed: its children point to its nearest kept ancestor. A branch or
//! fork file copies its prefix with the same entry ids, so entries merge by
//! id, the current file first.
//!
//! Submodules:
//! - [`family`] — which files of the directory belong to the family.
//! - [`parse`] — one file → kept entries and header facts.
//! - [`tests`] — behaviour tests against temp directories.

mod family;
mod parse;

use std::collections::HashSet;
use std::io;
use std::path::Path;

use serde::Serialize;
use serde_json::Number;
use tauri::AppHandle;

/// One conversation family: `files` (the current file first) and the merged
/// `entries` (every parent precedes its children).
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTree {
    pub files: Vec<TreeFile>,
    pub entries: Vec<TreeEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeFile {
    pub path: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    /// The file's last entry, mapped to its nearest kept ancestor.
    pub leaf_id: Option<String>,
    pub current: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    User,
    Assistant,
    Compaction,
    Warm,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub id: String,
    /// Nearest kept ancestor.
    pub parent_id: Option<String>,
    pub kind: Kind,
    /// `message.timestamp` in ms (messages only).
    pub ts: Option<Number>,
    /// The entry's own ISO timestamp.
    pub at: Option<String>,
    pub text: Option<String>,
    pub agent: bool,
    pub usage: Option<TreeUsage>,
    pub first_kept_id: Option<String>,
    pub first_kept_exact: bool,
    pub label: Option<String>,
    pub in_current: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// Cache lifetime in seconds, from `cttl`; `None` when the provider
    /// reports none.
    pub ttl: Option<u32>,
    pub cost_read: Option<f64>,
    pub cost_write: Option<f64>,
}

impl TreeEntry {
    /// A kept entry with every optional facet empty.
    const fn new(id: String, parent_id: Option<String>, kind: Kind, at: Option<String>) -> Self {
        Self {
            id,
            parent_id,
            kind,
            ts: None,
            at,
            text: None,
            agent: false,
            usage: None,
            first_kept_id: None,
            first_kept_exact: false,
            label: None,
            in_current: false,
        }
    }
}

/// Require `session_file` to be a `.jsonl` file under `root` and return its
/// directory and file name, or `None` for a file omp has not written yet.
///
/// omp creates the file lazily, once the first assistant message exists, yet
/// `get_state().sessionFile` reports the path from the start. Such a path is
/// accepted (as an empty tree) only while it still is a `.jsonl` name that
/// is not a dangling link, in an existing directory under `root`: the same
/// confinement as for an existing file. Paths stay in the caller's spelling
/// (the canonical form only serves the checks), so they match the
/// `sessionFile` omp reported.
fn validate<'a>(
    root: &Path,
    session_file: &'a Path,
) -> Result<Option<(&'a Path, &'a str)>, String> {
    let shown = session_file.display();
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("sessions directory unavailable: {e}"))?;
    let outside = || format!("session file {shown} is outside the sessions directory");
    let not_jsonl = || format!("{shown} is not a .jsonl session file");
    let is_jsonl = |p: &Path| p.extension().and_then(|e| e.to_str()) == Some("jsonl");
    let name = session_file
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("{shown} has no usable file name"))?;
    let dir = session_file
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("{shown} has no directory"))?;

    match session_file.canonicalize() {
        Ok(canonical) => {
            if !canonical.starts_with(&canonical_root) {
                return Err(outside());
            }
            if !canonical.is_file() || !is_jsonl(&canonical) {
                return Err(not_jsonl());
            }
            Ok(Some((dir, name)))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            if !is_jsonl(session_file) {
                return Err(not_jsonl());
            }
            if session_file.symlink_metadata().is_ok() {
                return Err(format!("session file {shown} is a dangling link"));
            }
            let parent = dir
                .canonicalize()
                .map_err(|e| format!("session file does not exist: {shown} ({e})"))?;
            if !parent.starts_with(&canonical_root) {
                return Err(outside());
            }
            if !parent.is_dir() {
                return Err(format!("session file does not exist: {shown}"));
            }
            Ok(None)
        }
        Err(e) => Err(format!("session file unavailable: {shown} ({e})")),
    }
}

/// Build the tree of `session_file`'s family; see [`load`].
fn build(root: &Path, session_file: &Path) -> Result<ConversationTree, String> {
    let Some((dir, current)) = validate(root, session_file)? else {
        // A conversation omp has not written yet has no tree.
        return Ok(ConversationTree::default());
    };
    let names = family::family_of(dir, current)
        .map_err(|e| format!("cannot list {}: {e}", dir.display()))?;

    let mut files = Vec::with_capacity(names.len());
    let mut entries: Vec<TreeEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (index, name) in names.iter().enumerate() {
        let is_current = index == 0;
        let path = dir.join(name);
        let parsed = match parse::parse_file(&path) {
            Ok(parsed) => parsed,
            Err(e) if is_current => return Err(format!("cannot read {}: {e}", path.display())),
            // A relative that cannot be read is left out of the family.
            Err(_) => continue,
        };
        let mut file = parsed.file;
        file.current = is_current;
        files.push(file);
        for mut entry in parsed.entries {
            // Checked before cloning: most of a relative is the prefix it
            // shares with the current file.
            if seen.contains(entry.id.as_str()) {
                continue;
            }
            // Cloned: the id both keys `seen` and stays on the entry.
            seen.insert(entry.id.clone());
            entry.in_current = is_current;
            entries.push(entry);
        }
    }
    Ok(ConversationTree { files, entries })
}

/// The conversation tree of `session_file` for `profile`.
///
/// # Errors
/// Returns an error when the home directory cannot be resolved, or when
/// `session_file` is not an existing `.jsonl` file under the profile's
/// sessions directory, or cannot be read.
pub fn load(
    app: &AppHandle,
    session_file: &str,
    profile: Option<&str>,
) -> Result<ConversationTree, String> {
    let root = crate::saved_sessions::sessions_root_dir(app, profile)
        .ok_or_else(|| "home directory unavailable".to_string())?;
    build(&root, Path::new(session_file))
}

#[cfg(test)]
mod tests;
