//! Reads omp's persisted session history (`~/.omp/agent/sessions/**/*.jsonl`)
//! for the conversation-history panel, and validates `resume` values coming
//! back over the Tauri IPC boundary before they reach `agent::spawn::spawn_omp`.
//!
//! # Session identity
//! omp persists each session as a `<filesystem-safe-ISO8601>_<uuid>.jsonl`
//! file (see [`canonical_id_from_stem`]). That file path — and the uuid
//! extracted from it — is the **only** durable join key for a session.
//! `get_state().sessionId`, returned over the omp RPC boundary, is per-load
//! and ephemeral: it MUST NOT be persisted as a foreign key or compared
//! across two separate `get_state` calls to decide whether they refer to
//! "the same session". Wiring session-switch/resume logic against it will
//! silently misbehave across reloads.
//!
//! Submodules:
//! - [`tests`] — unit tests for the pure parse/scan/validate helpers below.

use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Information about a persisted session on disk.
///
/// The durable identity of a session is `path` (and the uuid embedded in
/// its filename, see [`canonical_id_from_stem`]) — not `id`, which is
/// merely a copy of the `session` event's `id` field from the JSONL body
/// and, for sessions resumed over RPC, must never be conflated with a
/// live `get_state().sessionId` from a different `get_state` call.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SavedSession {
    pub id: String,
    pub title: String,
    pub timestamp: String,
    pub updated_at: Option<String>,
    pub cwd: String,
    pub project_name: String,
    pub path: String,
    pub message_count: usize,
    pub preview: Option<String>,
}

/// Locate the directory where omp persists sessions (`~/.omp/agent/sessions`).
fn sessions_root_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("PI_CODING_AGENT_DIR") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir).join("sessions"));
        }
    }
    app.path()
        .home_dir()
        .ok()
        .map(|home| home.join(".omp").join("agent").join("sessions"))
}

/// Extract text content from a message content block array.
fn extract_text_from_content(content: &serde_json::Value) -> Option<String> {
    if let Some(arr) = content.as_array() {
        for block in arr {
            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(text) = block.get("text").and_then(|s| s.as_str()) {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        return Some(trimmed.to_string());
                    }
                }
            }
        }
    } else if let Some(text) = content.as_str() {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// Update running per-message state from a `"message"` event's payload.
/// Only `user`/`assistant` turns count towards `message_count` or update
/// the preview/fallback-title — `toolResult` entries hold raw tool output
/// (file contents, bash output) and would otherwise inflate the turn count
/// and leak into the preview line.
///
/// Split out of `parse_session_file` purely to keep that function under
/// the project's line-count lint threshold; it has no independent purpose.
fn apply_message_event(
    val: &serde_json::Value,
    message_count: &mut usize,
    fallback_title: &mut String,
    last_preview: &mut Option<String>,
) {
    let msg = val.get("message");
    let role = msg
        .and_then(|m| m.get("role"))
        .and_then(|r| r.as_str())
        .unwrap_or("");
    if role != "user" && role != "assistant" {
        return;
    }
    *message_count += 1;

    let Some(text) = msg
        .and_then(|m| m.get("content"))
        .and_then(extract_text_from_content)
    else {
        return;
    };

    if role == "user" && fallback_title.is_empty() {
        // Truncate first user message as fallback title
        *fallback_title = if text.chars().count() > 60 {
            format!("{}…", text.chars().take(60).collect::<String>())
        } else {
            text.clone()
        };
    }
    // Keep latest text as preview snippet
    *last_preview = Some(if text.chars().count() > 120 {
        format!("{}…", text.chars().take(120).collect::<String>())
    } else {
        text
    });
}

/// Parse a single `.jsonl` session file and extract metadata.
fn parse_session_file(path: &Path) -> Option<SavedSession> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut session_id = String::new();
    let mut explicit_title = String::new();
    let mut fallback_title = String::new();
    let mut timestamp = String::new();
    let mut updated_at: Option<String> = None;
    let mut cwd = String::new();
    let mut message_count = 0usize;
    let mut last_preview: Option<String> = None;

    for line_res in reader.lines() {
        let Ok(line) = line_res else { continue };
        if line.is_empty() {
            continue;
        }

        let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };

        let event_type = val.get("type").and_then(|t| t.as_str()).unwrap_or("");

        match event_type {
            "title" => {
                if let Some(t) = val.get("title").and_then(|s| s.as_str()) {
                    let trimmed = t.trim();
                    if !trimmed.is_empty() {
                        explicit_title = trimmed.to_string();
                    }
                }
                if let Some(u) = val.get("updatedAt").and_then(|s| s.as_str()) {
                    updated_at = Some(u.to_string());
                }
            }
            "session" => {
                if let Some(id) = val.get("id").and_then(|s| s.as_str()) {
                    session_id = id.to_string();
                }
                if let Some(ts) = val.get("timestamp").and_then(|s| s.as_str()) {
                    timestamp = ts.to_string();
                }
                if let Some(dir) = val.get("cwd").and_then(|s| s.as_str()) {
                    cwd = dir.to_string();
                }
            }
            "message" => apply_message_event(
                &val,
                &mut message_count,
                &mut fallback_title,
                &mut last_preview,
            ),
            _ => {}
        }
    }

    if session_id.is_empty() && timestamp.is_empty() {
        return None;
    }

    let title = if !explicit_title.is_empty() {
        explicit_title
    } else if !fallback_title.is_empty() {
        fallback_title
    } else {
        "Untitled conversation".to_string()
    };

    let project_name = if cwd.is_empty() {
        "Default".to_string()
    } else {
        Path::new(&cwd)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&cwd)
            .to_string()
    };

    Some(SavedSession {
        // Prefer the filename-derived uuid — the durable identity (see the
        // module doc comment) — over the JSONL body's `session.id` field.
        // They agree in the common case; falling back to the body's id
        // only covers a file that doesn't match the expected
        // `<timestamp>_<uuid>.jsonl` shape (e.g. an imported session).
        id: canonical_id_from_stem(path).map_or(session_id, str::to_string),
        title,
        timestamp,
        updated_at,
        cwd,
        project_name,
        path: path.to_string_lossy().into_owned(),
        message_count,
        preview: last_preview,
    })
}

/// Normalize a `cwd` value for cross-platform comparison: forward slashes,
/// no trailing slash, case-insensitive.
fn normalize_cwd(cwd: &str) -> String {
    cwd.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// Extract the durable uuid component from a saved-session filename stem.
///
/// omp names session files `<filesystem-safe-ISO8601>_<uuid>.jsonl`, e.g.
/// `2026-09-12T18-16-44-966Z_01a096d6-0aa6-75d7-804c-088913a441e6.jsonl`.
/// The uuid is the substring after the **last** underscore in the file
/// stem (the timestamp prefix does not itself contain an underscore, but
/// splitting on the last one keeps this robust if it ever did). Returns
/// `None` — never panics or returns a best-effort guess — when the stem
/// has no underscore or the trailing component doesn't look like a uuid
/// (32-36 characters of hex digits and hyphens only).
///
/// This is the only durable, cross-load identity for a session; see the
/// module doc comment. Never substitute a `get_state().sessionId` value
/// here or vice versa.
pub fn canonical_id_from_stem(path: &Path) -> Option<&str> {
    let stem = path.file_stem()?.to_str()?;
    let idx = stem.rfind('_')?;
    let uuid = &stem[idx + 1..];
    let looks_like_uuid =
        (32..=36).contains(&uuid.len()) && uuid.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    looks_like_uuid.then_some(uuid)
}

/// Walk `root` for `.jsonl` session files, optionally filtered by `cwd_filter`.
/// Sessions are sorted newest-first by `updated_at` (falling back to `timestamp`).
///
/// Split out from `scan_saved_sessions` (which resolves `root` from the
/// `AppHandle`) so the walk/filter/sort logic can be unit-tested against a
/// tempdir without a Tauri app instance.
fn scan_dir(root: &Path, cwd_filter: Option<&str>) -> Result<Vec<SavedSession>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }

    let entries =
        fs::read_dir(root).map_err(|e| format!("failed to read {}: {e}", root.display()))?;

    let norm_filter = cwd_filter.filter(|f| !f.is_empty()).map(normalize_cwd);

    let mut sessions = Vec::new();

    for entry_res in entries {
        let Ok(entry) = entry_res else { continue };
        let folder_path = entry.path();
        if !folder_path.is_dir() {
            continue;
        }

        let Ok(files) = fs::read_dir(&folder_path) else {
            continue;
        };

        for file_res in files {
            let Ok(file_entry) = file_res else { continue };
            let path = file_entry.path();
            if !path.is_file()
                || !path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|s| s.eq_ignore_ascii_case("jsonl"))
            {
                continue;
            }

            let Some(session) = parse_session_file(&path) else {
                continue;
            };
            if let Some(norm_filter) = &norm_filter {
                if &normalize_cwd(&session.cwd) != norm_filter {
                    continue;
                }
            }
            sessions.push(session);
        }
    }

    // Sort descending by timestamp / updated_at (newest first)
    sessions.sort_by(|a, b| {
        let key_b = b.updated_at.as_ref().unwrap_or(&b.timestamp);
        let key_a = a.updated_at.as_ref().unwrap_or(&a.timestamp);
        key_b.cmp(key_a)
    });

    Ok(sessions)
}

/// Scan `~/.omp/agent/sessions/` for saved `.jsonl` session files.
/// If `cwd_filter` is provided, only sessions whose `cwd` matches are returned.
pub fn scan_saved_sessions(
    app: &AppHandle,
    cwd_filter: Option<&str>,
) -> Result<Vec<SavedSession>, String> {
    let root =
        sessions_root_dir(app).ok_or_else(|| "could not resolve home directory".to_string())?;
    scan_dir(&root, cwd_filter)
}

/// Validate a `resume` value supplied over the Tauri IPC boundary against
/// `root` (the resolved sessions directory). Rejects anything that could be
/// re-tokenised as a flag by omp's argument parser, and requires the value
/// to be either a bare session id (hex digits and hyphens only) or an
/// existing `.jsonl` file whose canonical path lives under `root`.
///
/// Without this check, a malicious or buggy frontend value flows straight
/// into omp's argv (see `agent::spawn::spawn_omp`): a flag-shaped string
/// (e.g. `--auto-approve`) would be re-parsed by omp as a separate option,
/// or an arbitrary filesystem path could be opened as a "session".
fn validate_resume_against_root(root: &Path, resume: &str) -> Result<(), String> {
    if resume.starts_with('-') {
        return Err(format!("invalid resume value: {resume:?}"));
    }
    if resume.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Ok(());
    }
    let path = Path::new(resume);
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("resume path does not exist: {resume:?} ({e})"))?;
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("sessions directory unavailable: {e}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err(format!(
            "resume path {resume:?} is outside the sessions directory"
        ));
    }
    if canonical.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return Err(format!(
            "resume path {resume:?} is not a .jsonl session file"
        ));
    }
    Ok(())
}

/// Validate a `resume` value against this app's sessions directory. An
/// empty value is always accepted (means "no resume").
pub fn validate_resume(app: &AppHandle, resume: &str) -> Result<(), String> {
    if resume.is_empty() {
        return Ok(());
    }
    let root =
        sessions_root_dir(app).ok_or_else(|| "could not resolve home directory".to_string())?;
    validate_resume_against_root(&root, resume)
}

/// Encode a paging cursor for streaming a `.jsonl` session file in pages.
///
/// The cursor embeds the file size observed at issue time so
/// [`decode_cursor`] can detect a file that was appended to (or truncated)
/// between page requests — trusting a raw byte `offset` against a session
/// file that has since grown would silently return wrong or duplicate
/// history to a "load more" caller.
///
/// No caller exists yet — `list_saved_sessions` returns whole-session
/// metadata, not paged message content; this is the size-bound cursor
/// primitive a future "load more history" command would build on. Kept
/// (fully tested below) rather than deleted since the identity discipline
/// it encodes — never trust a raw offset against a file that may have
/// grown — is exactly the bug class this module's own doc comment warns
/// against reintroducing.
#[allow(dead_code)]
pub fn encode_cursor(file_size: u64, offset: u64) -> String {
    format!("{file_size}:{offset}")
}

/// Decode a paging cursor produced by [`encode_cursor`]. See its doc
/// comment for why this doesn't have a caller yet either.
///
/// Rejects the cursor with `Err("stale cursor")` if `current_file_size`
/// no longer matches the size recorded in the cursor — the file changed
/// since the cursor was issued, so the caller must not trust `offset`.
/// Also rejects a malformed cursor string (missing separator, non-numeric
/// parts) rather than panicking or returning a garbage offset.
#[allow(dead_code)]
pub fn decode_cursor(cursor: &str, current_file_size: u64) -> Result<u64, String> {
    let (size_str, offset_str) = cursor
        .split_once(':')
        .ok_or_else(|| format!("malformed cursor: {cursor:?}"))?;
    let size: u64 = size_str
        .parse()
        .map_err(|_| format!("malformed cursor: {cursor:?}"))?;
    let offset: u64 = offset_str
        .parse()
        .map_err(|_| format!("malformed cursor: {cursor:?}"))?;
    if size != current_file_size {
        return Err("stale cursor".to_string());
    }
    Ok(offset)
}

#[cfg(test)]
mod tests;
