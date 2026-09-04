use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Information about a persisted session on disk.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
            "message" => {
                message_count += 1;
                let msg = val.get("message");
                let role = msg
                    .and_then(|m| m.get("role"))
                    .and_then(|r| r.as_str())
                    .unwrap_or("");
                let text_opt = msg
                    .and_then(|m| m.get("content"))
                    .and_then(extract_text_from_content);

                if let Some(text) = text_opt {
                    if role == "user" && fallback_title.is_empty() {
                        // Truncate first user message as fallback title
                        fallback_title = if text.chars().count() > 60 {
                            format!("{}…", text.chars().take(60).collect::<String>())
                        } else {
                            text.clone()
                        };
                    }
                    // Keep latest text as preview snippet
                    last_preview = Some(if text.chars().count() > 120 {
                        format!("{}…", text.chars().take(120).collect::<String>())
                    } else {
                        text
                    });
                }
            }
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
        id: session_id,
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

/// Scan `~/.omp/agent/sessions/` for saved `.jsonl` session files.
/// If `cwd_filter` is provided, only sessions whose `cwd` matches are returned.
pub fn scan_saved_sessions(
    app: &AppHandle,
    cwd_filter: Option<&str>,
) -> Result<Vec<SavedSession>, String> {
    let Some(root) = sessions_root_dir(app) else {
        return Ok(Vec::new());
    };

    if !root.exists() {
        return Ok(Vec::new());
    }

    let Ok(entries) = fs::read_dir(&root) else {
        return Ok(Vec::new());
    };

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
            if path.is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|s| s.eq_ignore_ascii_case("jsonl"))
            {
                if let Some(session) = parse_session_file(&path) {
                    if let Some(filter) = cwd_filter {
                        if !filter.is_empty() {
                            let norm_filter = filter.replace('\\', "/").trim_end_matches('/').to_lowercase();
                            let norm_cwd = session.cwd.replace('\\', "/").trim_end_matches('/').to_lowercase();
                            if norm_cwd != norm_filter {
                                continue;
                            }
                        }
                    }
                    sessions.push(session);
                }
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_test_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("omp_test_{name}_{nanos}"));
        fs::create_dir_all(&dir).expect("created test dir");
        dir
    }

    #[test]
    fn parses_session_file_with_fallback_title() {
        let dir = make_test_dir("fallback");
        let file_path = dir.join("test_session.jsonl");
        let mut file = File::create(&file_path).expect("file created");

        writeln!(file, r#"{{"type":"title","v":1,"title":""}}"#).unwrap();
        writeln!(file, r#"{{"type":"session","version":3,"id":"sess-123","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/test/project"}}"#).unwrap();
        writeln!(file, r#"{{"type":"message","message":{{"role":"user","content":[{{"type":"text","text":"What is quantum computing?"}}]}}}}"#).unwrap();
        writeln!(file, r#"{{"type":"message","message":{{"role":"assistant","content":[{{"type":"text","text":"Quantum computing is..."}}]}}}}"#).unwrap();

        let session = parse_session_file(&file_path).expect("parsed session");
        assert_eq!(session.id, "sess-123");
        assert_eq!(session.title, "What is quantum computing?");
        assert_eq!(session.cwd, "/test/project");
        assert_eq!(session.message_count, 2);
        assert_eq!(session.preview.as_deref(), Some("Quantum computing is..."));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_session_file_with_explicit_title() {
        let dir = make_test_dir("explicit");
        let file_path = dir.join("test_explicit.jsonl");
        let mut file = File::create(&file_path).expect("file created");

        writeln!(file, r#"{{"type":"title","v":1,"title":"Custom Topic Title","updatedAt":"2026-09-04T01:00:00.000Z"}}"#).unwrap();
        writeln!(file, r#"{{"type":"session","version":3,"id":"sess-456","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/test/another"}}"#).unwrap();

        let session = parse_session_file(&file_path).expect("parsed session");
        assert_eq!(session.id, "sess-456");
        assert_eq!(session.title, "Custom Topic Title");
        assert_eq!(session.updated_at.as_deref(), Some("2026-09-04T01:00:00.000Z"));

        let _ = fs::remove_dir_all(&dir);
    }
}
