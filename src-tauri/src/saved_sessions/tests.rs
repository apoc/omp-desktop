use super::*;
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

fn make_test_dir(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("omp_test_{name}_{nanos}"));
    fs::create_dir_all(&dir).expect("created test dir");
    dir
}

fn write_jsonl(path: &Path, lines: &[&str]) {
    let mut file = File::create(path).expect("file created");
    for line in lines {
        writeln!(file, "{line}").unwrap();
    }
}

#[test]
fn parses_session_file_with_fallback_title() {
    let dir = make_test_dir("fallback");
    let file_path = dir.join("test_session.jsonl");
    write_jsonl(
        &file_path,
        &[
            r#"{"type":"title","v":1,"title":""}"#,
            r#"{"type":"session","version":3,"id":"sess-123","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/test/project"}"#,
            r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"What is quantum computing?"}]}}"#,
            r#"{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Quantum computing is..."}]}}"#,
        ],
    );

    let session = parse_session_file(&file_path).expect("parsed session");
    assert_eq!(session.id, "sess-123");
    assert_eq!(session.title, "What is quantum computing?");
    assert_eq!(session.cwd, "/test/project");
    assert_eq!(session.message_count, 2);
    assert_eq!(session.preview.as_deref(), Some("Quantum computing is..."));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn parse_session_file_prefers_filename_uuid_over_stale_body_id() {
    let dir = make_test_dir("filename_uuid");
    let file_path = dir.join("2026-09-12T18-16-44-966Z_01a096d6-0aa6-75d7-804c-088913a441e6.jsonl");
    write_jsonl(
        &file_path,
        &[
            r#"{"type":"title","v":1,"title":""}"#,
            r#"{"type":"session","version":3,"id":"stale-body-id","timestamp":"2026-09-12T18:16:44.966Z","cwd":"/test/project"}"#,
            r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}"#,
        ],
    );

    let session = parse_session_file(&file_path).expect("parsed session");
    assert_eq!(session.id, "01a096d6-0aa6-75d7-804c-088913a441e6");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn parses_session_file_with_explicit_title() {
    let dir = make_test_dir("explicit");
    let file_path = dir.join("test_explicit.jsonl");
    write_jsonl(
        &file_path,
        &[
            r#"{"type":"title","v":1,"title":"Custom Topic Title","updatedAt":"2026-09-04T01:00:00.000Z"}"#,
            r#"{"type":"session","version":3,"id":"sess-456","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/test/another"}"#,
        ],
    );

    let session = parse_session_file(&file_path).expect("parsed session");
    assert_eq!(session.id, "sess-456");
    assert_eq!(session.title, "Custom Topic Title");
    assert_eq!(
        session.updated_at.as_deref(),
        Some("2026-09-04T01:00:00.000Z")
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn parse_session_file_last_activity_tracks_latest_message_not_creation() {
    // No `title` event at all — before the fix, `updated_at` stayed `None`
    // for a session like this and callers fell back to the creation
    // `timestamp`, even though the conversation kept going for two more
    // days (issue #23).
    let dir = make_test_dir("last_activity_no_title");
    let file_path = dir.join("test_last_activity.jsonl");
    write_jsonl(
        &file_path,
        &[
            r#"{"type":"session","version":3,"id":"sess-789","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/test/three"}"#,
            r#"{"type":"message","id":"m1","parentId":null,"timestamp":"2026-09-04T00:00:05.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#,
            r#"{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-09-06T12:30:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"still here two days later"}]}}"#,
        ],
    );

    let session = parse_session_file(&file_path).expect("parsed session");
    assert_eq!(session.timestamp, "2026-09-04T00:00:00.000Z");
    assert_eq!(
        session.updated_at.as_deref(),
        Some("2026-09-06T12:30:00.000Z")
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn parse_session_file_last_activity_beats_a_stale_title_rename() {
    // The title was set once, early on, and never touched again — but the
    // conversation continued well past that point. Last activity must
    // reflect the later message, not the title event's `updatedAt`.
    let dir = make_test_dir("last_activity_stale_title");
    let file_path = dir.join("test_stale_title.jsonl");
    write_jsonl(
        &file_path,
        &[
            r#"{"type":"title","v":1,"title":"Early topic","updatedAt":"2026-09-04T00:00:10.000Z"}"#,
            r#"{"type":"session","version":3,"id":"sess-321","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/test/four"}"#,
            r#"{"type":"message","id":"m1","parentId":null,"timestamp":"2026-09-08T09:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"back after a few days"}]}}"#,
        ],
    );

    let session = parse_session_file(&file_path).expect("parsed session");
    assert_eq!(
        session.updated_at.as_deref(),
        Some("2026-09-08T09:00:00.000Z")
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn parse_session_file_last_activity_later_retitle_on_first_line_wins() {
    // The `title` event is always the physically first line of a session
    // file, yet it can carry the timestamp of the *latest* retitle. A
    // naive "last line wins" reducer would let the later `message` line
    // overwrite it; `update_last_activity` must instead keep the maximum
    // across every line regardless of order (#23).
    let dir = make_test_dir("last_activity_later_retitle_first_line");
    let file_path = dir.join("test_retitle_first_line.jsonl");
    write_jsonl(
        &file_path,
        &[
            r#"{"type":"title","v":1,"title":"Renamed later","updatedAt":"2026-09-10T08:00:00.000Z"}"#,
            r#"{"type":"session","version":3,"id":"sess-999","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/test/six"}"#,
            r#"{"type":"message","id":"m1","parentId":null,"timestamp":"2026-09-08T09:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"earlier than the rename"}]}}"#,
        ],
    );

    let session = parse_session_file(&file_path).expect("parsed session");
    assert_eq!(
        session.updated_at.as_deref(),
        Some("2026-09-10T08:00:00.000Z")
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn parse_session_file_ignores_lifecycle_events_for_last_activity() {
    // omp appends a `custom` `session_exit` line (and other lifecycle
    // events like `model_change`) stamped with wall-clock time whenever
    // the RPC child for a resumed session terminates — even if the user
    // sent no new message. Resuming a dormant session and closing the tab
    // must not bump it to the top of the history list (review regression
    // for #23).
    let dir = make_test_dir("ignores_lifecycle");
    let file_path = dir.join("test_lifecycle.jsonl");
    write_jsonl(
        &file_path,
        &[
            r#"{"type":"session","version":3,"id":"sess-654","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/test/five"}"#,
            r#"{"type":"message","id":"m1","parentId":null,"timestamp":"2026-09-04T00:05:00.000Z","message":{"role":"user","content":[{"type":"text","text":"the real last message"}]}}"#,
            r#"{"type":"model_change","id":"mc1","parentId":"m1","timestamp":"2026-09-20T00:00:00.000Z","model":"foo","role":"main"}"#,
            r#"{"type":"custom","customType":"session_exit","id":"c1","parentId":"mc1","timestamp":"2026-09-20T00:00:01.000Z"}"#,
        ],
    );

    let session = parse_session_file(&file_path).expect("parsed session");
    assert_eq!(
        session.updated_at.as_deref(),
        Some("2026-09-04T00:05:00.000Z")
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn parse_session_file_returns_none_without_id_or_timestamp() {
    let dir = make_test_dir("no_id");
    let file_path = dir.join("headerless.jsonl");
    write_jsonl(
        &file_path,
        &[
            r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#,
        ],
    );

    assert!(parse_session_file(&file_path).is_none());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn parse_session_file_tolerates_malformed_json_lines() {
    let dir = make_test_dir("malformed");
    let file_path = dir.join("mixed.jsonl");
    write_jsonl(
        &file_path,
        &[
            "not json at all {{{",
            "",
            r#"{"type":"session","version":3,"id":"sess-789","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/test/x"}"#,
            r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"still works"}]}}"#,
        ],
    );

    let session = parse_session_file(&file_path).expect("parsed despite malformed lines");
    assert_eq!(session.id, "sess-789");
    assert_eq!(session.message_count, 1);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn excludes_tool_result_messages_from_count_and_preview() {
    let dir = make_test_dir("toolresult");
    let file_path = dir.join("with_tool.jsonl");
    write_jsonl(
        &file_path,
        &[
            r#"{"type":"session","version":3,"id":"sess-tool","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/test/tool"}"#,
            r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"read this file"}]}}"#,
            r#"{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Sure, reading now."}]}}"#,
            r#"{"type":"message","message":{"role":"toolResult","content":[{"type":"text","text":"raw file bytes / bash output"}]}}"#,
        ],
    );

    let session = parse_session_file(&file_path).expect("parsed session");
    // Only the user + assistant turns count — the toolResult entry is excluded.
    assert_eq!(session.message_count, 2);
    assert_eq!(session.preview.as_deref(), Some("Sure, reading now."));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn extract_text_from_content_handles_array_and_string_blocks() {
    let array_content = serde_json::json!([{"type": "text", "text": "  hello  "}]);
    assert_eq!(
        extract_text_from_content(&array_content).as_deref(),
        Some("hello")
    );

    let string_content = serde_json::json!("  plain string  ");
    assert_eq!(
        extract_text_from_content(&string_content).as_deref(),
        Some("plain string")
    );

    let empty_content = serde_json::json!([{"type": "text", "text": "   "}]);
    assert_eq!(extract_text_from_content(&empty_content), None);

    let no_text_block = serde_json::json!([{"type": "tool_use"}]);
    assert_eq!(extract_text_from_content(&no_text_block), None);
}

#[test]
fn scan_dir_missing_root_returns_empty() {
    let root = std::env::temp_dir().join("omp_test_does_not_exist_ever");
    assert!(scan_dir(&root, None)
        .expect("ok for missing root")
        .is_empty());
}

#[test]
fn scan_dir_filters_by_cwd_and_sorts_newest_first() {
    let root = make_test_dir("scan_root");

    let sess_a = root.join("sess-a");
    fs::create_dir_all(&sess_a).unwrap();
    write_jsonl(
        &sess_a.join("a.jsonl"),
        &[
            r#"{"type":"session","version":3,"id":"a","timestamp":"2026-09-01T00:00:00.000Z","cwd":"/proj/one"}"#,
        ],
    );

    let sess_b = root.join("sess-b");
    fs::create_dir_all(&sess_b).unwrap();
    write_jsonl(
        &sess_b.join("b.jsonl"),
        &[
            r#"{"type":"session","version":3,"id":"b","timestamp":"2026-09-03T00:00:00.000Z","cwd":"/proj/two"}"#,
        ],
    );

    let sess_c = root.join("sess-c");
    fs::create_dir_all(&sess_c).unwrap();
    write_jsonl(
        &sess_c.join("c.jsonl"),
        &[
            r#"{"type":"session","version":3,"id":"c","timestamp":"2026-09-02T00:00:00.000Z","cwd":"/proj/one"}"#,
        ],
    );

    let all = scan_dir(&root, None).expect("scan ok");
    assert_eq!(all.len(), 3);
    // Newest first.
    assert_eq!(all[0].id, "b");
    assert_eq!(all[1].id, "c");
    assert_eq!(all[2].id, "a");

    let filtered = scan_dir(&root, Some("/proj/one")).expect("scan ok");
    assert_eq!(filtered.len(), 2);
    assert!(filtered.iter().all(|s| s.cwd == "/proj/one"));

    // Filter is case- and slash-insensitive.
    let filtered_win = scan_dir(&root, Some(r"\PROJ\ONE\")).expect("scan ok");
    assert_eq!(filtered_win.len(), 2);

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn scan_dir_sorts_by_last_activity_not_creation_date() {
    // Direct regression for issue #23: session "old" was created first but
    // has a much later last message than session "new", which was created
    // after it but never touched again. "old" must sort above "new".
    let root = make_test_dir("scan_activity_root");

    let sess_old = root.join("sess-old");
    fs::create_dir_all(&sess_old).unwrap();
    write_jsonl(
        &sess_old.join("old.jsonl"),
        &[
            r#"{"type":"session","version":3,"id":"old","timestamp":"2026-09-01T00:00:00.000Z","cwd":"/proj/one"}"#,
            r#"{"type":"message","id":"m1","parentId":null,"timestamp":"2026-09-10T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"resumed much later"}]}}"#,
        ],
    );

    let sess_new = root.join("sess-new");
    fs::create_dir_all(&sess_new).unwrap();
    write_jsonl(
        &sess_new.join("new.jsonl"),
        &[
            r#"{"type":"session","version":3,"id":"new","timestamp":"2026-09-05T00:00:00.000Z","cwd":"/proj/two"}"#,
        ],
    );

    let all = scan_dir(&root, None).expect("scan ok");
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].id, "old");
    assert_eq!(all[1].id, "new");

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn validate_resume_rejects_flag_like_value() {
    let root = make_test_dir("validate_flag");
    let err = validate_resume_against_root(&root, "--auto-approve")
        .expect_err("flag-shaped resume must be rejected");
    assert!(err.contains("invalid resume value"));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn validate_resume_accepts_bare_session_id() {
    let root = make_test_dir("validate_id");
    validate_resume_against_root(&root, "a1b2c3d4-e5f6").expect("hex/hyphen id is valid");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn validate_resume_accepts_jsonl_path_under_root() {
    let root = make_test_dir("validate_path_ok");
    let sess_dir = root.join("sess-1");
    fs::create_dir_all(&sess_dir).unwrap();
    let file_path = sess_dir.join("session.jsonl");
    File::create(&file_path).unwrap();

    validate_resume_against_root(&root, file_path.to_str().unwrap())
        .expect("path under sessions root is valid");

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn validate_resume_rejects_path_outside_root() {
    let root = make_test_dir("validate_path_root");
    let outside_dir = make_test_dir("validate_path_outside");
    let outside_file = outside_dir.join("secret.jsonl");
    File::create(&outside_file).unwrap();

    let err = validate_resume_against_root(&root, outside_file.to_str().unwrap())
        .expect_err("path outside sessions root must be rejected");
    assert!(err.contains("outside the sessions directory"));

    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&outside_dir);
}

#[test]
fn canonical_id_from_stem_extracts_uuid_from_real_shaped_filename() {
    let path = Path::new(
        "/home/user/.omp/agent/sessions/-devel-project/\
         2026-09-12T18-16-44-966Z_01a096d6-0aa6-75d7-804c-088913a441e6.jsonl",
    );
    assert_eq!(
        canonical_id_from_stem(path),
        Some("01a096d6-0aa6-75d7-804c-088913a441e6")
    );
}

#[test]
fn canonical_id_from_stem_returns_none_without_underscore() {
    let path = Path::new("sess-123.jsonl");
    assert_eq!(canonical_id_from_stem(path), None);
}

#[test]
fn canonical_id_from_stem_returns_none_for_invalid_uuid_characters() {
    // Trailing component contains a space, which is not a valid uuid character.
    let path = Path::new("2026-09-12T18-16-44-966Z_not a valid uuid.jsonl");
    assert_eq!(canonical_id_from_stem(path), None);

    // Trailing component contains a disallowed separator character.
    let path_with_slash_like_char =
        Path::new("2026-09-12T18-16-44-966Z_01a096d6@0aa6-75d7-804c-088913a441e6.jsonl");
    assert_eq!(canonical_id_from_stem(path_with_slash_like_char), None);
}

#[test]
fn pi_coding_agent_dir_applies_to_the_builtin_profile_only() {
    let home = Path::new("/home/u");
    let env = OsStr::new("/custom/agent");

    // Built-in profile: the env var is omp's documented session-storage
    // override and the child honours it, so the history panel must too.
    assert_eq!(
        sessions_root_for(home, None, Some(env)),
        Path::new("/custom/agent/sessions")
    );
    // Named profile: `--profile` beats the env var in omp itself, so reading
    // `PI_CODING_AGENT_DIR` here would point the panel at a tree the child
    // never writes - and potentially at another profile's history.
    assert_eq!(
        sessions_root_for(home, Some("work"), Some(env)),
        Path::new("/home/u/.omp/profiles/work/agent/sessions")
    );
    // No override: both fall back to the per-profile layout.
    assert_eq!(
        sessions_root_for(home, None, None),
        Path::new("/home/u/.omp/agent/sessions")
    );
    // An exported-but-empty value is not an override.
    assert_eq!(
        sessions_root_for(home, None, Some(OsStr::new(""))),
        Path::new("/home/u/.omp/agent/sessions")
    );
}

#[test]
fn an_empty_profile_id_reads_the_builtin_tree_like_omp_args_writes_it() {
    // `omp_args` filters `Some("")` to no flag, so the child writes the
    // built-in tree; the read side must agree rather than resolving to
    // `~/.omp/profiles/agent`. Unreachable via `resolve`, asserted so the
    // two sides can't drift.
    let home = Path::new("/home/u");
    assert_eq!(
        sessions_root_for(home, Some(""), None),
        Path::new("/home/u/.omp/agent/sessions")
    );
    // And an empty id must not suppress the env override either.
    assert_eq!(
        sessions_root_for(home, Some(""), Some(OsStr::new("/custom/agent"))),
        Path::new("/custom/agent/sessions")
    );
}
