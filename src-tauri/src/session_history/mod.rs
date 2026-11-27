//! The `session_history` command: the transcript history of a saved session
//! file, read-only, for a tab whose context starts at a compaction summary
//! (#85, `docs/architecture/compacted-history.md`).
//!
//! The history is the current branch: the `parentId` chain of omp's leaf,
//! resolved as omp resolves it on load. It is returned as omp
//! `AgentMessage`-shaped [`Item`]s, newest page first: each call returns the
//! newest `limit` display items before an anchor.
//!
//! Two passes keep a request cheap on files of tens of MiB: the first reads
//! only each entry's paging facts and line offset, the second reads again
//! just the lines of the returned page and builds their items.
//!
//! Submodules:
//! - [`parse`] — first pass: one file → its entries' paging facts.
//! - [`page`] — leaf, path, display sequence, anchor and window.
//! - [`items`] — second pass: the page's lines → their items.
//! - [`blob`] — user images persisted as blob references.
//! - [`iso`] — the entries' ISO timestamps → epoch ms.
//! - [`tests`] — behaviour tests against temp files.

mod blob;
mod iso;
mod items;
mod page;
mod parse;

use std::path::Path;

use serde::Serialize;
use serde_json::value::RawValue;
use serde_json::Number;
use tauri::AppHandle;

/// One page of history: `items` in path order, and whether an older display
/// item exists before them.
#[derive(Debug, Default, Serialize)]
pub struct HistoryPage {
    pub items: Vec<Item>,
    pub more: bool,
}

/// One transcript item, shaped like omp's `AgentMessage`. Values are copied
/// verbatim from the file; absent ones are omitted.
#[derive(Debug, Serialize)]
#[serde(
    tag = "role",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Item {
    User {
        #[serde(skip_serializing_if = "Option::is_none")]
        timestamp: Option<Number>,
        /// `text` and `image` blocks only.
        content: Vec<Box<RawValue>>,
    },
    Assistant {
        #[serde(skip_serializing_if = "Option::is_none")]
        timestamp: Option<Number>,
        /// `text` and `thinking` blocks only.
        content: Vec<Box<RawValue>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stop_reason: Option<Box<RawValue>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error_message: Option<Box<RawValue>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error_status: Option<Box<RawValue>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider: Option<Box<RawValue>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<Box<RawValue>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<Box<RawValue>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        retry_recovery: Option<Box<RawValue>>,
    },
    /// A `custom_message` entry: a boundary for the frontend's
    /// `finalFailures`, never shown.
    Custom {
        #[serde(skip_serializing_if = "Option::is_none")]
        custom_type: Option<Box<RawValue>>,
        /// The entry's ISO timestamp in epoch ms.
        #[serde(skip_serializing_if = "Option::is_none")]
        timestamp: Option<Number>,
    },
    /// A `compaction` entry: the divider above what it summarized.
    CompactionSummary {
        /// The entry's ISO timestamp in epoch ms.
        #[serde(skip_serializing_if = "Option::is_none")]
        timestamp: Option<Number>,
        #[serde(skip_serializing_if = "Option::is_none")]
        summary: Option<Box<RawValue>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        short_summary: Option<Box<RawValue>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tokens_before: Option<Box<RawValue>>,
    },
}

/// Build the page of `session_file`; see [`load`].
fn build(
    root: &Path,
    session_file: &Path,
    before: Option<f64>,
    limit: u32,
) -> Result<HistoryPage, String> {
    if crate::conversation_tree::validate(root, session_file)?.is_none() {
        // A conversation omp has not written yet has no history.
        return Ok(HistoryPage::default());
    }
    let entries = parse::parse_file(session_file)
        .map_err(|e| format!("cannot read {}: {e}", session_file.display()))?;
    let Some((window, more)) = page::select(&entries, before, limit) else {
        return Ok(HistoryPage::default());
    };
    let mut blobs = blob::Blobs::new(root);
    let items = items::read(
        session_file,
        window.iter().map(|&i| &entries[i]),
        &mut blobs,
    )?;
    Ok(HistoryPage { items, more })
}

/// The history of `session_file` for `profile`: the newest `limit`
/// (clamped to 1..=500) display items of the current branch before the
/// entry whose `message.timestamp` is `before` (the whole branch without
/// it; nothing when no branch entry has it).
///
/// # Errors
/// Returns an error when the home directory cannot be resolved, or when
/// `session_file` is not a `.jsonl` file under the profile's sessions
/// directory, cannot be read, or was rewritten while it was read.
pub fn load(
    app: &AppHandle,
    session_file: &str,
    profile: Option<&str>,
    before: Option<f64>,
    limit: u32,
) -> Result<HistoryPage, String> {
    let root = crate::saved_sessions::sessions_root_dir(app, profile)
        .ok_or_else(|| "home directory unavailable".to_string())?;
    build(&root, Path::new(session_file), before, limit)
}

#[cfg(test)]
mod tests;
