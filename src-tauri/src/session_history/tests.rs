use super::*;
use crate::test_support::TempDir;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

/// An agent directory with `sessions/<cwd slug>/` and `blobs/`, removed on
/// drop.
struct Fixture {
    agent: TempDir,
    root: PathBuf,
    dir: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let agent = TempDir::new("session-history", name);
        let root = agent.path().join("sessions");
        let dir = root.join("--work-proj--");
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(agent.path().join("blobs")).unwrap();
        Self { agent, root, dir }
    }

    /// `s.jsonl` with the header lines, then `lines`.
    fn put(&self, lines: &[Value]) -> PathBuf {
        self.put_bytes(text(lines).as_bytes())
    }

    fn put_bytes(&self, bytes: &[u8]) -> PathBuf {
        let path = self.dir.join("s.jsonl");
        fs::write(&path, bytes).unwrap();
        path
    }

    /// Blob `hash` holding `bytes`.
    fn blob(&self, hash: &str, bytes: &[u8]) -> PathBuf {
        let path = self.agent.path().join("blobs").join(hash);
        fs::write(&path, bytes).unwrap();
        path
    }

    fn page(&self, file: &Path, before: Option<f64>, limit: u32) -> Value {
        serde_json::to_value(build(&self.root, file, before, limit).unwrap()).unwrap()
    }
}

/// The header lines, then `lines`, as file text.
fn text(lines: &[Value]) -> String {
    let mut text = String::new();
    for line in header().iter().chain(lines) {
        text.push_str(&line.to_string());
        text.push('\n');
    }
    text
}

fn header() -> [Value; 2] {
    [
        json!({"type":"title","v":1,"title":"","updatedAt":"2026-10-04T09:00:00.000Z"}),
        json!({"type":"session","version":3,"id":"s","timestamp":"2026-10-04T09:00:00.000Z","cwd":"/work/proj"}),
    ]
}

fn message(id: &str, parent: Option<&str>, message: Value) -> Value {
    json!({"type":"message","id":id,"parentId":parent,"timestamp":"2026-10-04T10:00:00.000Z","message":message})
}

fn user(id: &str, parent: Option<&str>, ts: i64) -> Value {
    message(
        id,
        parent,
        json!({"role":"user","content":[{"type":"text","text":format!("ask {id}")}],"timestamp":ts}),
    )
}

fn assistant(id: &str, parent: &str, ts: i64) -> Value {
    message(
        id,
        Some(parent),
        json!({"role":"assistant","content":[{"type":"text","text":format!("reply {id}")}],"timestamp":ts}),
    )
}

/// An assistant turn that only calls a tool: returned, never counted.
fn tool_call(id: &str, parent: &str, ts: i64) -> Value {
    message(
        id,
        Some(parent),
        json!({"role":"assistant","content":[{"type":"thinking","thinking":"  "},
            {"type":"toolCall","id":"c","name":"read","arguments":{"path":"x"}}],
            "stopReason":"toolUse","timestamp":ts}),
    )
}

fn tool_result(id: &str, parent: &str, ts: i64) -> Value {
    message(
        id,
        Some(parent),
        json!({"role":"toolResult","toolCallId":"c","content":[{"type":"text","text":"file"}],"timestamp":ts}),
    )
}

fn compaction(id: &str, parent: &str, first_kept: &str) -> Value {
    json!({"type":"compaction","id":id,"parentId":parent,"timestamp":"2026-10-04T10:00:05.123Z",
        "summary":format!("summary {id}"),"shortSummary":"short","firstKeptEntryId":first_kept,"tokensBefore":1000})
}

fn snapcompact(id: &str, parent: &str, first_kept: &str, tokens: u64) -> Value {
    json!({"type":"compaction","id":id,"parentId":parent,"timestamp":"2026-10-04T10:00:05.123Z","method":"snapcompact",
        "summary":format!("summary {id}"),"firstKeptEntryId":first_kept,"tokensBefore":tokens})
}

fn custom(id: &str, parent: &str) -> Value {
    json!({"type":"custom_message","id":id,"parentId":parent,"timestamp":"2026-10-04T10:00:05.123Z",
        "customType":"retry-notice","content":"x","display":false})
}

/// One short label per item: `u<ts>`, `a<ts>`, `custom`, `C:<summary>`.
fn labels(page: &Value) -> Vec<String> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| match item["role"].as_str().unwrap() {
            "user" => format!("u{}", item["timestamp"]),
            "assistant" => format!("a{}", item["timestamp"]),
            "custom" => "custom".to_string(),
            "compactionSummary" => format!("C:{}", item["summary"].as_str().unwrap()),
            other => panic!("unexpected role {other}"),
        })
        .collect()
}

/// Two branches off `a2`: `u3/a4` (written first) and `u5/a6`.
fn branched() -> Vec<Value> {
    vec![
        user("u1", None, 1),
        assistant("a2", "u1", 2),
        user("u3", Some("a2"), 3),
        assistant("a4", "u3", 4),
        user("u5", Some("a2"), 5),
        assistant("a6", "u5", 6),
    ]
}

#[test]
fn the_path_ends_at_the_last_entry_and_skips_other_branches() {
    let fx = Fixture::new("plain");
    let file = fx.put(&branched());
    let page = fx.page(&file, None, 50);
    assert_eq!(labels(&page), ["u1", "a2", "u5", "a6"]);
    assert_eq!(page["more"], false);
}

#[test]
fn an_active_leaf_id_on_the_last_entry_picks_the_leaf() {
    let fx = Fixture::new("active");
    let mut lines = branched();
    lines.push(json!({"type":"label","id":"l1","parentId":"a6","targetId":"u1","label":"x","activeLeafId":"a4"}));
    let file = fx.put(&lines);
    assert_eq!(labels(&fx.page(&file, None, 50)), ["u1", "a2", "u3", "a4"]);
}

#[test]
fn a_null_active_leaf_id_means_no_history() {
    let fx = Fixture::new("null");
    let mut lines = branched();
    lines.push(json!({"type":"label","id":"l1","parentId":"a6","activeLeafId":null}));
    let file = fx.put(&lines);
    assert_eq!(fx.page(&file, None, 50), json!({"items":[],"more":false}));
}

#[test]
fn a_dangling_active_leaf_id_falls_back_to_the_newest_own_leaf() {
    let fx = Fixture::new("dangling");
    let mut lines = branched();
    // Not their own leaf: both are passed over by the fallback.
    lines.push(json!({"type":"label","id":"l1","parentId":"a6","activeLeafId":"a4"}));
    lines.push(json!({"type":"label","id":"l2","parentId":"a4","activeLeafId":"gone"}));
    let file = fx.put(&lines);
    assert_eq!(labels(&fx.page(&file, None, 50)), ["u1", "a2", "u5", "a6"]);
}

#[test]
fn a_parent_cycle_ends_the_walk() {
    let fx = Fixture::new("cycle");
    let file = fx.put(&[user("u1", Some("a2"), 1), assistant("a2", "u1", 2)]);
    assert_eq!(labels(&fx.page(&file, None, 50)), ["u1", "a2"]);
}

#[test]
fn before_covers_only_entries_ahead_of_the_anchor() {
    let fx = Fixture::new("anchor");
    let file = fx.put(&branched());
    assert_eq!(labels(&fx.page(&file, Some(5.0), 50)), ["u1", "a2"]);
    assert_eq!(
        fx.page(&file, Some(1.0), 50),
        json!({"items":[],"more":false})
    );
    // On the other branch only: not on the path.
    assert_eq!(
        fx.page(&file, Some(3.0), 50),
        json!({"items":[],"more":false})
    );
    assert_eq!(
        fx.page(&file, Some(99.0), 50),
        json!({"items":[],"more":false})
    );
}

/// `u1 a2 custom u3 a4 (tool) a6(tool call only) u7`.
fn paged() -> Vec<Value> {
    vec![
        user("u1", None, 1),
        assistant("a2", "u1", 2),
        custom("c", "a2"),
        user("u3", Some("c"), 3),
        assistant("a4", "u3", 4),
        tool_result("t5", "a4", 5),
        tool_call("a6", "t5", 6),
        user("u7", Some("a6"), 7),
    ]
}

#[test]
fn the_window_counts_display_items_only() {
    let fx = Fixture::new("window");
    let file = fx.put(&paged());
    // `a6` rides along without counting toward the limit.
    let page = fx.page(&file, None, 2);
    assert_eq!(labels(&page), ["a4", "a6", "u7"]);
    assert_eq!(page["more"], true);
    // `custom` sits before the oldest returned display item: left out.
    let page = fx.page(&file, None, 3);
    assert_eq!(labels(&page), ["u3", "a4", "a6", "u7"]);
    assert_eq!(page["more"], true);
    // Exactly every display item: nothing older remains.
    let page = fx.page(&file, None, 5);
    assert_eq!(
        labels(&page),
        ["u1", "a2", "custom", "u3", "a4", "a6", "u7"]
    );
    assert_eq!(page["more"], false);
    let page = fx.page(&file, None, 0);
    assert_eq!(labels(&page), ["u7"], "limit 0 is clamped to 1");
    assert_eq!(page["more"], true);
    let page = fx.page(&file, Some(7.0), 1);
    assert_eq!(labels(&page), ["a4", "a6"]);
    assert_eq!(page["more"], true);
}

#[test]
fn the_limit_is_clamped_to_500() {
    let fx = Fixture::new("clamp");
    let mut lines = vec![user("u0", None, 0)];
    for i in 1..=600 {
        lines.push(user(&format!("u{i}"), Some(&format!("u{}", i - 1)), i));
    }
    let file = fx.put(&lines);
    let page = fx.page(&file, None, u32::MAX);
    assert_eq!(page["items"].as_array().unwrap().len(), 500);
    assert_eq!(page["items"][0]["timestamp"], 101);
    assert_eq!(page["more"], true);
}

#[test]
fn items_keep_only_the_blocks_the_transcript_renders() {
    let fx = Fixture::new("blocks");
    let usage = json!({"input":3,"output":7,"cacheRead":100,"cost":{"total":0.5}});
    let file = fx.put(&[
        message(
            "u1",
            None,
            json!({"role":"user","content":"plain \"text\"","timestamp":1}),
        ),
        message(
            "u2",
            Some("u1"),
            json!({"role":"user","timestamp":2,"content":[
            {"type":"image","data":"AAA","mimeType":"image/png"},
            {"type":"toolResult","text":"no"}]}),
        ),
        message(
            "u3",
            Some("u2"),
            json!({"role":"user","content":[{"type":"text","text":"  "}],"timestamp":3}),
        ),
        message(
            "u4",
            Some("u3"),
            json!({"role":"user","content":"","timestamp":4}),
        ),
        message(
            "a5",
            Some("u4"),
            json!({"role":"assistant","timestamp":5,"provider":"anthropic","model":"opus",
            "usage":usage,"stopReason":"stop","retryRecovery":{"attempts":2},"content":[
            {"type":"thinking","thinking":"hmm","thinkingSignature":"sig"},
            {"type":"toolCall","id":"c","name":"read","arguments":{}},
            {"type":"text","text":"done"}]}),
        ),
        tool_result("t6", "a5", 6),
        message(
            "a7",
            Some("t6"),
            json!({"role":"assistant","timestamp":7,"content":[],
            "stopReason":"error","errorMessage":"overloaded","errorStatus":529}),
        ),
    ]);
    let page = fx.page(&file, None, 50);
    assert_eq!(
        page["items"],
        json!([
            {"role":"user","timestamp":1,"content":[{"type":"text","text":"plain \"text\""}]},
            {"role":"user","timestamp":2,"content":[{"type":"image","data":"AAA","mimeType":"image/png"}]},
            {"role":"assistant","timestamp":5,"content":[
                {"type":"thinking","thinking":"hmm","thinkingSignature":"sig"},
                {"type":"text","text":"done"}],
                "stopReason":"stop","provider":"anthropic","model":"opus","usage":usage,
                "retryRecovery":{"attempts":2}},
            {"role":"assistant","timestamp":7,"content":[],
                "stopReason":"error","errorMessage":"overloaded","errorStatus":529},
        ])
    );
    // The error turn counts: with a5 it fills a page of two.
    let page = fx.page(&file, None, 2);
    assert_eq!(labels(&page), ["a5", "a7"]);
    assert_eq!(page["more"], true);
    // It never starts a page: a page of one reaches back to a5.
    let page = fx.page(&file, None, 1);
    assert_eq!(labels(&page), ["a5", "a7"]);
    assert_eq!(page["more"], true);
}

#[test]
fn a_compaction_sits_before_its_first_kept_entry() {
    let fx = Fixture::new("placement");
    let file = fx.put(&[
        user("u1", None, 1),
        assistant("a2", "u1", 2),
        user("u3", Some("a2"), 3),
        assistant("a4", "u3", 4),
        compaction("k", "a4", "u3"),
        user("u5", Some("k"), 5),
    ]);
    let page = fx.page(&file, None, 50);
    assert_eq!(labels(&page), ["u1", "a2", "C:summary k", "u3", "a4", "u5"]);
    assert_eq!(
        page["items"][2],
        json!({"role":"compactionSummary","timestamp":1_791_108_005_123_i64,
            "summary":"summary k","shortSummary":"short","tokensBefore":1000})
    );
    // The divider counts, but a page never starts at it: the frontend
    // anchors on the oldest user/assistant item, so the divider goes to the
    // next page.
    let page = fx.page(&file, Some(5.0), 3);
    assert_eq!(labels(&page), ["u3", "a4"]);
    assert_eq!(page["more"], true);
    // The tab's context starts at the first kept entry: its anchor. The
    // divider right before the anchor belongs to the page.
    let page = fx.page(&file, Some(3.0), 50);
    assert_eq!(labels(&page), ["u1", "a2", "C:summary k"]);
    assert_eq!(page["more"], false);
    // A window holding only the divider reaches back to an anchorable item.
    let page = fx.page(&file, Some(3.0), 1);
    assert_eq!(labels(&page), ["a2", "C:summary k"]);
    assert_eq!(page["more"], true);
}

/// Pages back from `before` the way the frontend does, oldest page first:
/// each next `before` is the oldest user/assistant timestamp it renders (an
/// assistant with empty content, a retried failure, renders nothing), until
/// `more` is false.
fn page_through(
    fx: &Fixture,
    file: &Path,
    mut before: Option<f64>,
    limit: u32,
) -> Vec<Vec<String>> {
    let mut pages = Vec::new();
    for _ in 0..20 {
        let page = fx.page(file, before, limit);
        before = page["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| {
                matches!(i["role"].as_str(), Some("user" | "assistant"))
                    && i["content"].as_array().is_some_and(|c| !c.is_empty())
            })
            .and_then(|i| i["timestamp"].as_f64())
            .or(before);
        pages.insert(0, labels(&page));
        if page["more"] == false {
            return pages;
        }
    }
    panic!("paging does not end: {pages:?}");
}

#[test]
fn paging_returns_each_divider_once() {
    let fx = Fixture::new("divider-once");
    let file = fx.put(&[
        user("u1", None, 1),
        assistant("a2", "u1", 2),
        user("u3", Some("a2"), 3),
        assistant("a4", "u3", 4),
        compaction("k1", "a4", "u3"),
        user("u5", Some("k1"), 5),
        assistant("a6", "u5", 6),
        custom("x", "a6"),
        user("u7", Some("x"), 7),
        assistant("a8", "u7", 8),
        compaction("k2", "a8", "u7"),
        user("u9", Some("k2"), 9),
    ]);
    let full = [
        "u1",
        "a2",
        "C:summary k1",
        "u3",
        "a4",
        "u5",
        "a6",
        "custom",
        "C:summary k2",
        "u7",
        "a8",
        "u9",
    ];
    assert_eq!(labels(&fx.page(&file, None, 50)), full);
    // The tab shows k2's kept tail (anchor u7), or starts from the end.
    for (before, shown) in [(Some(7.0), 9), (None, 12)] {
        for limit in 1..=8 {
            let pages = page_through(&fx, &file, before, limit);
            let joined: Vec<&str> = pages.iter().flatten().map(String::as_str).collect();
            assert_eq!(joined, full[..shown], "limit {limit}: {pages:?}");
            // Only the oldest page may start with a divider or custom item.
            assert!(
                pages[1..]
                    .iter()
                    .all(|p| p[0].starts_with('u') || p[0].starts_with('a')),
                "limit {limit}: {pages:?}"
            );
        }
    }
    assert_eq!(
        page_through(&fx, &file, Some(7.0), 6),
        [
            vec!["u1", "a2", "C:summary k1"],
            vec!["u3", "a4", "u5", "a6", "custom", "C:summary k2"]
        ]
    );
}

#[test]
fn paging_never_starts_at_an_error_only_assistant() {
    let fx = Fixture::new("error-start");
    let file = fx.put(&[
        user("u1", None, 1),
        assistant("a2", "u1", 2),
        user("u3", Some("a2"), 3),
        message(
            "e4",
            Some("u3"),
            json!({"role":"assistant","content":[],"stopReason":"error",
                "errorMessage":"overloaded","timestamp":4}),
        ),
        assistant("a5", "e4", 5),
        user("u6", Some("a5"), 6),
    ]);
    let full = ["u1", "a2", "u3", "a4", "a5", "u6"];
    for limit in 1..=6 {
        let pages = page_through(&fx, &file, None, limit);
        let joined: Vec<&str> = pages.iter().flatten().map(String::as_str).collect();
        assert_eq!(joined, full, "limit {limit}: {pages:?}");
    }
    // The window [e4 a5 u6] moves its start to a5; e4 counts, so more.
    let page = fx.page(&file, None, 3);
    assert_eq!(labels(&page), ["a5", "u6"]);
    assert_eq!(page["more"], true);
}

#[test]
fn a_page_from_the_path_start_keeps_its_leading_item() {
    let fx = Fixture::new("leading-custom");
    let file = fx.put(&[
        json!({"type":"custom_message","id":"x","parentId":null,"timestamp":"2026-10-04T10:00:05.123Z",
            "customType":"retry-notice","content":"x","display":false}),
        user("u1", Some("x"), 1),
        assistant("a2", "u1", 2),
    ]);
    let page = fx.page(&file, None, 3);
    assert_eq!(labels(&page), ["custom", "u1", "a2"]);
    assert_eq!(page["more"], false);
}

#[test]
fn a_compaction_without_an_earlier_first_kept_entry_stays_in_place() {
    for (name, first_kept) in [("missing", "gone"), ("empty", ""), ("later", "u5")] {
        let fx = Fixture::new(name);
        let file = fx.put(&[
            user("u1", None, 1),
            assistant("a2", "u1", 2),
            compaction("k", "a2", first_kept),
            user("u5", Some("k"), 5),
            custom("x", "u5"),
        ]);
        assert_eq!(
            labels(&fx.page(&file, None, 50)),
            ["u1", "a2", "C:summary k", "u5", "custom"],
            "{name}"
        );
    }
}

#[test]
fn a_rescued_snapcompact_is_skipped() {
    let fx = Fixture::new("snap");
    let lines = |tokens: u64| {
        vec![
            user("u1", None, 1),
            assistant("a2", "u1", 2),
            snapcompact("s1", "a2", "a2", 900),
            snapcompact("s2", "s1", "a2", tokens),
            user("u3", Some("s2"), 3),
        ]
    };
    let file = fx.put(&lines(900));
    assert_eq!(
        labels(&fx.page(&file, None, 50)),
        ["u1", "C:summary s2", "a2", "u3"]
    );
    let file = fx.put(&lines(901));
    assert_eq!(
        labels(&fx.page(&file, None, 50)),
        ["u1", "C:summary s1", "C:summary s2", "a2", "u3"]
    );
}

#[test]
fn malformed_lines_are_skipped() {
    let fx = Fixture::new("malformed");
    let mut bytes = Vec::new();
    for line in [user("u1", None, 1), assistant("a2", "u1", 2)] {
        bytes.extend_from_slice(line.to_string().as_bytes());
        bytes.push(b'\n');
    }
    bytes.extend_from_slice(b"not json\n{\"type\":\"message\",\"id\":\n\xff\xfe\n");
    bytes.extend_from_slice(user("u3", Some("a2"), 3).to_string().as_bytes());
    let file = fx.put_bytes(&bytes);
    assert_eq!(labels(&fx.page(&file, None, 50)), ["u1", "a2", "u3"]);
}

#[test]
fn a_file_outside_the_sessions_root_is_refused() {
    let fx = Fixture::new("confined");
    let outside = TempDir::new("session-history", "outside");
    let file = outside.path().join("s.jsonl");
    fs::write(&file, user("u1", None, 1).to_string()).unwrap();
    let err = build(&fx.root, &file, None, 50).unwrap_err();
    assert!(err.contains("outside the sessions directory"), "{err}");
}

#[test]
fn a_file_not_yet_written_is_empty() {
    let fx = Fixture::new("unwritten");
    let page = fx.page(&fx.dir.join("later.jsonl"), None, 50);
    assert_eq!(page, json!({"items":[],"more":false}));
}

#[test]
fn the_last_path_entry_with_the_anchor_timestamp_wins() {
    let fx = Fixture::new("duplicate-ts");
    let file = fx.put(&[
        user("u1", None, 1),
        assistant("a2", "u1", 2),
        user("u3", Some("a2"), 2),
        assistant("a4", "u3", 4),
    ]);
    assert_eq!(labels(&fx.page(&file, Some(2.0), 50)), ["u1", "a2"]);
}

#[test]
fn the_fallback_leaf_may_name_itself() {
    let fx = Fixture::new("own-leaf");
    let mut lines = branched();
    // `l1` names itself: it is its own leaf, newer than `a6`.
    lines.push(json!({"type":"label","id":"l1","parentId":"a4","activeLeafId":"l1"}));
    lines.push(json!({"type":"label","id":"l2","parentId":"a6","activeLeafId":"gone"}));
    let file = fx.put(&lines);
    assert_eq!(labels(&fx.page(&file, None, 50)), ["u1", "a2", "u3", "a4"]);
}

#[test]
fn a_custom_message_carries_its_entry_timestamp_in_ms() {
    let fx = Fixture::new("custom-ts");
    let mut bad = custom("c2", "c1");
    bad["timestamp"] = json!("2026-10-04T10:00:05Z");
    let file = fx.put(&[user("u1", None, 1), custom("c1", "u1"), bad]);
    let page = fx.page(&file, None, 50);
    assert_eq!(
        page["items"][1],
        json!({"role":"custom","customType":"retry-notice","timestamp":1_791_108_005_123_i64})
    );
    // Not omp's `toISOString` form: left out.
    assert_eq!(
        page["items"][2],
        json!({"role":"custom","customType":"retry-notice"})
    );
}

#[test]
fn blank_text_is_seen_through_escapes() {
    let fx = Fixture::new("blank");
    let reply = |id: &str, parent: &str, text: &str, ts: i64| {
        message(
            id,
            Some(parent),
            json!({"role":"assistant","content":[{"type":"text","text":text}],"timestamp":ts}),
        )
    };
    // Written as `\n\t\r\f`, a raw space and a raw no-break space.
    let file = fx.put(&[
        user("u1", None, 1),
        reply("a2", "u1", "\n\t\r\u{c} \u{a0}", 2),
    ]);
    let page = fx.page(&file, None, 1);
    assert_eq!(labels(&page), ["u1", "a2"], "a2 is not counted");
    assert_eq!(page["more"], false);
    // Any other escape is visible.
    let file = fx.put(&[user("u1", None, 1), reply("a2", "u1", "\n\u{7}", 2)]);
    let page = fx.page(&file, None, 1);
    assert_eq!(labels(&page), ["a2"]);
    assert_eq!(page["more"], true);
}

fn hash(n: u32) -> String {
    format!("{n:064x}")
}

/// A user turn with a text block and an image whose data is `data`.
fn with_image(id: &str, parent: Option<&str>, ts: i64, data: &str) -> Value {
    message(
        id,
        parent,
        json!({"role":"user","timestamp":ts,"content":[{"type":"text","text":"see"},
            {"type":"image","data":data,"mimeType":"image/png"}]}),
    )
}

/// A user turn with only an image whose data is `data`.
fn only_image(id: &str, parent: Option<&str>, ts: i64, data: &str) -> Value {
    message(
        id,
        parent,
        json!({"role":"user","timestamp":ts,"content":[{"type":"image","data":data,"mimeType":"image/png"}]}),
    )
}

#[test]
fn a_blob_reference_is_replaced_by_its_data() {
    let fx = Fixture::new("blob");
    fx.blob(&hash(1), b"\x89PNG");
    let file = fx.put(&[
        with_image("u1", None, 1, &format!("blob:sha256:{}", hash(1))),
        only_image("u2", Some("u1"), 2, "iVBORw0K"),
    ]);
    let page = fx.page(&file, None, 50);
    assert_eq!(
        page["items"],
        json!([
            {"role":"user","timestamp":1,"content":[{"type":"text","text":"see"},
                {"type":"image","data":"iVBORw==","mimeType":"image/png"}]},
            {"role":"user","timestamp":2,"content":[{"type":"image","data":"iVBORw0K","mimeType":"image/png"}]},
        ])
    );
}

#[test]
fn a_missing_blob_drops_its_block() {
    let fx = Fixture::new("blob-missing");
    let missing = format!("blob:sha256:{}", hash(2));
    let file = fx.put(&[
        with_image("u1", None, 1, &missing),
        only_image("u2", Some("u1"), 2, &missing),
    ]);
    let page = fx.page(&file, None, 50);
    assert_eq!(
        page["items"],
        json!([{"role":"user","timestamp":1,"content":[{"type":"text","text":"see"}]}])
    );
}

#[test]
fn a_malformed_or_escaping_reference_reads_nothing_outside_the_blobs() {
    let fx = Fixture::new("blob-escape");
    let secret = b"secret";
    // Where a `../` reference and a link would lead.
    let name = &hash(3)[3..];
    fs::write(fx.agent.path().join(name), secret).unwrap();
    let target = fx.agent.path().join("secret");
    fs::write(&target, secret).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, fx.agent.path().join("blobs").join(hash(4))).unwrap();
    // Uppercase hex: needs letters.
    fx.blob(&hash(0xabcd).to_uppercase(), secret);
    fx.blob(&hash(6)[1..], secret);
    let refs = [
        format!("blob:sha256:../{name}"),
        format!("blob:sha256:{}", hash(0xabcd).to_uppercase()),
        format!("blob:sha256:{}", &hash(6)[1..]),
        format!("blob:sha256:{}", hash(4)),
    ];
    let mut lines = Vec::new();
    for (i, data) in (0_i64..).zip(&refs) {
        let parent = (i > 0).then(|| format!("u{}", i - 1));
        lines.push(with_image(&format!("u{i}"), parent.as_deref(), i, data));
    }
    let file = fx.put(&lines);
    let page = fx.page(&file, None, 50);
    for (i, item) in page["items"].as_array().unwrap().iter().enumerate() {
        assert_eq!(
            item["content"],
            json!([{"type":"text","text":"see"}]),
            "{}",
            refs[i]
        );
    }
    assert_eq!(page["items"].as_array().unwrap().len(), refs.len());
    // A message holding only a refused reference is neither shown nor
    // counted.
    let file = fx.put(&[
        user("u1", None, 1),
        only_image("u2", Some("u1"), 2, &refs[1]),
    ]);
    let page = fx.page(&file, None, 1);
    assert_eq!(labels(&page), ["u1"]);
    assert_eq!(page["more"], false);
}

#[test]
fn blobs_past_the_caps_are_dropped() {
    const MIB: u64 = 1024 * 1024;
    let fx = Fixture::new("blob-caps");
    let sized = |n: u32, len: u64| {
        let file = fs::File::create(fx.blob(&hash(n), b"")).unwrap();
        file.set_len(len).unwrap();
    };
    // One blob over 10 MiB; then four of exactly 10 MiB, of which only three
    // fit the page's 32 MiB.
    sized(10, 10 * MIB + 1);
    for n in 11..=14 {
        sized(n, 10 * MIB);
    }
    let mut lines = Vec::new();
    for (i, n) in (0_i64..).zip(10..=14) {
        let parent = (i > 0).then(|| format!("u{}", i - 1));
        let data = format!("blob:sha256:{}", hash(n));
        lines.push(with_image(&format!("u{i}"), parent.as_deref(), i, &data));
    }
    let file = fx.put(&lines);
    let page = fx.page(&file, None, 50);
    let images: Vec<usize> = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["content"].as_array().unwrap().len() - 1)
        .collect();
    assert_eq!(images, [0, 1, 1, 1, 0]);
    let data = page["items"][1]["content"][1]["data"].as_str().unwrap();
    assert_eq!(
        u64::try_from(data.len()).unwrap(),
        (10 * MIB).div_ceil(3) * 4
    );
}

#[test]
fn appends_between_the_passes_are_harmless_a_rewrite_is_an_error() {
    let fx = Fixture::new("rewrite");
    let lines = [user("u1", None, 1), assistant("a2", "u1", 2)];
    let file = fx.put(&lines);
    let entries = parse::parse_file(&file).unwrap();
    let (window, _) = page::select(&entries, None, 50).unwrap();
    let read = || {
        let mut blobs = blob::Blobs::new(&fx.root);
        items::read(&file, window.iter().map(|&i| &entries[i]), &mut blobs)
    };
    let mut appended = text(&lines);
    appended.push_str(&user("u3", Some("a2"), 3).to_string());
    fx.put_bytes(appended.as_bytes());
    assert_eq!(read().unwrap().len(), 2);
    // Same line lengths, other ids: omp rewrote the file in place.
    fx.put(&[user("v1", None, 1), assistant("b2", "v1", 2)]);
    let err = read().unwrap_err();
    assert!(err.contains("changed while it was read"), "{err}");
}
