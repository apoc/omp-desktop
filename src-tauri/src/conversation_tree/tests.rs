use super::*;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// A sessions root with one cwd-slug directory, removed on drop.
struct Fixture {
    root: PathBuf,
    dir: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("omp_tree_{name}_{nanos}"));
        let dir = root.join("--work-proj--");
        fs::create_dir_all(&dir).unwrap();
        Self { root, dir }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    fn put(&self, name: &str, lines: &[Value]) -> PathBuf {
        let text = lines.iter().fold(String::new(), |mut text, line| {
            text.push_str(&line.to_string());
            text.push('\n');
            text
        });
        self.put_raw(name, &text)
    }

    fn put_raw(&self, name: &str, text: &str) -> PathBuf {
        let path = self.path(name);
        fs::write(&path, text).unwrap();
        path
    }

    fn tree(&self, current: &Path) -> ConversationTree {
        build(&self.root, current).expect("tree built")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn header(parent: Option<&Path>) -> [Value; 2] {
    let mut session = json!({"type":"session","version":3,"id":"s","timestamp":"2026-10-04T09:00:00.000Z","cwd":"/work/proj"});
    if let Some(parent) = parent {
        session["parentSession"] = json!(parent.to_string_lossy());
    }
    [
        json!({"type":"title","v":1,"title":"","updatedAt":"2026-10-04T09:00:00.000Z"}),
        session,
    ]
}

fn with_header(parent: Option<&Path>, entries: Vec<Value>) -> Vec<Value> {
    header(parent).into_iter().chain(entries).collect()
}

fn user(id: &str, parent: Option<&str>, text: &str, ts: i64) -> Value {
    json!({"type":"message","id":id,"parentId":parent,"timestamp":"2026-10-04T10:00:00.000Z",
        "message":{"role":"user","content":[{"type":"text","text":text}],"timestamp":ts}})
}

fn assistant(id: &str, parent: Option<&str>, text: &str, ts: i64) -> Value {
    json!({"type":"message","id":id,"parentId":parent,"timestamp":"2026-10-04T10:00:05.000Z",
        "message":{"role":"assistant","provider":"anthropic","model":"opus",
            "content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":text}],
            "usage":{"input":3,"output":7,"cacheRead":100,"cacheWrite":50,"totalTokens":160,
                "cost":{"cacheRead":0.01,"cacheWrite":0.2,"total":0.5},
                "cttl":{"ephemeral1h":50}},
            "timestamp":ts}})
}

fn tool_result(id: &str, parent: Option<&str>) -> Value {
    json!({"type":"message","id":id,"parentId":parent,"timestamp":"2026-10-04T10:00:06.000Z",
        "message":{"role":"toolResult","content":[{"type":"text","text":"x".repeat(5000)}],"timestamp":1}})
}

fn other(kind: &str, id: &str, parent: Option<&str>) -> Value {
    json!({"type":kind,"id":id,"parentId":parent,"timestamp":"2026-10-04T10:00:07.000Z"})
}

fn entry<'a>(tree: &'a ConversationTree, id: &str) -> &'a TreeEntry {
    tree.entries
        .iter()
        .find(|e| e.id == id)
        .unwrap_or_else(|| panic!("entry {id} missing"))
}

fn names(tree: &ConversationTree) -> Vec<String> {
    tree.files
        .iter()
        .map(|f| f.path.rsplit(['/', '\\']).next().unwrap().to_string())
        .collect()
}

#[test]
fn family_is_the_parent_session_component_of_one_directory() {
    let fx = Fixture::new("family");
    let a = fx.put(
        "2026-10-04T09-00-00-000Z_a.jsonl",
        &with_header(None, vec![user("u1", None, "hi", 1)]),
    );
    let b = fx.put(
        "2026-10-04T10-00-00-000Z_b.jsonl",
        &with_header(Some(&a), vec![user("u1", None, "hi", 1)]),
    );
    // A fork written with a Windows-style parent path still links by name.
    let c_header = json!({"type":"session","version":3,"id":"c","timestamp":"2026-10-04T11:00:00.000Z",
        "cwd":"/work/proj","parentSession":format!("C:\\elsewhere\\{}", b.file_name().unwrap().to_str().unwrap())});
    let c = fx.put("2026-10-04T11-00-00-000Z_c.jsonl", &[c_header]);
    fx.put(
        "2026-10-04T12-00-00-000Z_unrelated.jsonl",
        &with_header(None, vec![user("z1", None, "other", 1)]),
    );
    let sub = fx.dir.join("2026-10-04T09-00-00-000Z_a");
    fs::create_dir_all(&sub).unwrap();
    fs::write(
        sub.join("0-Explore.jsonl"),
        format!("{}\n{}\n", header(Some(&a))[0], header(Some(&a))[1]),
    )
    .unwrap();

    let tree = fx.tree(&c);
    assert_eq!(
        names(&tree),
        [
            "2026-10-04T11-00-00-000Z_c.jsonl",
            "2026-10-04T09-00-00-000Z_a.jsonl",
            "2026-10-04T10-00-00-000Z_b.jsonl",
        ]
    );
    assert_eq!(
        tree.files.iter().map(|f| f.current).collect::<Vec<_>>(),
        [true, false, false]
    );
    // The same family from the root file's side.
    assert_eq!(fx.tree(&a).files.len(), 3);
}

#[test]
fn family_is_capped_nearest_files_first() {
    let fx = Fixture::new("cap");
    let mut prev: Option<PathBuf> = None;
    for i in 0..40 {
        let path = fx.path(&format!("f{i:02}.jsonl"));
        let lines = with_header(
            prev.as_deref(),
            vec![user(&format!("u{i:02}"), None, "x", 1)],
        );
        fx.put(&format!("f{i:02}.jsonl"), &lines);
        prev = Some(path);
    }
    let tree = fx.tree(&fx.path("f00.jsonl"));
    assert_eq!(tree.files.len(), 32);
    assert_eq!(names(&tree)[0], "f00.jsonl");
    assert_eq!(names(&tree)[31], "f31.jsonl");
}

#[test]
fn non_kept_entries_collapse_into_their_nearest_kept_ancestor() {
    let fx = Fixture::new("collapse");
    let file = fx.put(
        "s.jsonl",
        &with_header(
            None,
            vec![
                other("model_change", "m0", None),
                user("u1", Some("m0"), "first", 10),
                assistant("a1", Some("u1"), "calling", 20),
                tool_result("t1", Some("a1")),
                other("custom", "c1", Some("t1")),
                other("custom_message", "c2", Some("c1")),
                other("model_change", "m1", Some("c2")),
                user("u2", Some("m1"), "second", 30),
            ],
        ),
    );
    let tree = fx.tree(&file);
    let ids: Vec<_> = tree.entries.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, ["u1", "a1", "u2"]);
    assert_eq!(entry(&tree, "u1").parent_id, None);
    assert_eq!(entry(&tree, "a1").parent_id.as_deref(), Some("u1"));
    assert_eq!(entry(&tree, "u2").parent_id.as_deref(), Some("a1"));
    let u1 = entry(&tree, "u1");
    assert_eq!(u1.kind, Kind::User);
    assert_eq!(u1.ts.as_ref().and_then(Number::as_i64), Some(10));
    assert_eq!(u1.at.as_deref(), Some("2026-10-04T10:00:00.000Z"));
}

#[test]
fn warm_records_and_compactions_are_kept_other_model_usage_is_not() {
    let fx = Fixture::new("warm");
    let warm = json!({"type":"model_usage","id":"w1","parentId":"a1","timestamp":"2026-10-04T10:05:00.000Z","purpose":"cache-warm"});
    let memory = json!({"type":"model_usage","id":"w2","parentId":"w1","timestamp":"2026-10-04T10:06:00.000Z","purpose":"memory"});
    let file = fx.put(
        "s.jsonl",
        &with_header(
            None,
            vec![
                user("u1", None, "q", 1),
                assistant("a1", Some("u1"), "r", 2),
                warm,
                memory,
                other("compaction", "k1", Some("w2")),
            ],
        ),
    );
    let tree = fx.tree(&file);
    let kinds: Vec<_> = tree
        .entries
        .iter()
        .map(|e| (e.id.as_str(), e.kind))
        .collect();
    assert_eq!(
        kinds,
        [
            ("u1", Kind::User),
            ("a1", Kind::Assistant),
            ("w1", Kind::Warm),
            ("k1", Kind::Compaction)
        ]
    );
    assert_eq!(entry(&tree, "k1").parent_id.as_deref(), Some("w1"));
    assert_eq!(
        entry(&tree, "w1").at.as_deref(),
        Some("2026-10-04T10:05:00.000Z")
    );
}

#[test]
fn shared_prefix_merges_by_id_and_in_current_follows_the_current_file() {
    let fx = Fixture::new("merge");
    let a = fx.put(
        "a.jsonl",
        &with_header(
            None,
            vec![
                user("u1", None, "one", 1),
                assistant("a1", Some("u1"), "r1", 2),
                user("u2", Some("a1"), "two", 3),
                assistant("a2", Some("u2"), "r2", 4),
            ],
        ),
    );
    let b = fx.put(
        "b.jsonl",
        &with_header(
            Some(&a),
            vec![
                user("u1", None, "one", 1),
                assistant("a1", Some("u1"), "r1", 2),
                user("u3", Some("a1"), "three", 5),
            ],
        ),
    );
    let tree = fx.tree(&b);
    let mut ids: Vec<_> = tree.entries.iter().map(|e| e.id.as_str()).collect();
    ids.sort_unstable();
    assert_eq!(ids, ["a1", "a2", "u1", "u2", "u3"]);
    let current: Vec<_> = tree
        .entries
        .iter()
        .filter(|e| e.in_current)
        .map(|e| e.id.as_str())
        .collect();
    assert_eq!(current, ["u1", "a1", "u3"]);
    assert_eq!(entry(&tree, "u3").parent_id.as_deref(), Some("a1"));
    assert_eq!(entry(&tree, "u2").parent_id.as_deref(), Some("a1"));
    // Every parent precedes its children.
    for (i, e) in tree.entries.iter().enumerate() {
        if let Some(p) = &e.parent_id {
            assert!(
                tree.entries[..i].iter().any(|x| &x.id == p),
                "{p} after {}",
                e.id
            );
        }
    }
}

#[test]
fn leaf_is_the_last_entry_mapped_to_its_kept_ancestor() {
    let fx = Fixture::new("leaf");
    let a = fx.put(
        "a.jsonl",
        &with_header(
            None,
            vec![
                user("u1", None, "q", 1),
                assistant("a1", Some("u1"), "r", 2),
                tool_result("t1", Some("a1")),
                other("custom", "c1", Some("t1")),
            ],
        ),
    );
    let b = fx.put(
        "b.jsonl",
        &with_header(
            Some(&a),
            vec![user("u1", None, "q", 1), user("u9", Some("u1"), "w", 3)],
        ),
    );
    let tree = fx.tree(&a);
    let leaf = |name: &str| {
        tree.files
            .iter()
            .find(|f| f.path.ends_with(name))
            .unwrap()
            .leaf_id
            .as_deref()
    };
    assert_eq!(leaf("a.jsonl"), Some("a1"));
    assert_eq!(leaf("b.jsonl"), Some("u9"));
    assert!(b.exists());
}

#[test]
fn ttl_and_costs_come_from_cttl_and_cost() {
    let fx = Fixture::new("ttl");
    let plain = |id: &str, parent: &str, usage: Value| {
        json!({"type":"message","id":id,"parentId":parent,"timestamp":"t",
            "message":{"role":"assistant","content":[],"usage":usage,"timestamp":9}})
    };
    let file = fx.put(
        "s.jsonl",
        &with_header(
            None,
            vec![
                user("u1", None, "q", 1),
                assistant("one", Some("u1"), "h", 2),
                plain("five", "one", json!({"input":1,"output":2,"cacheRead":3,"cacheWrite":4,
                    "cost":{"cacheRead":0.5,"cacheWrite":0.25},"cttl":{"ephemeral5m":9,"ephemeral1h":0}})),
                plain("none", "five", json!({"input":1,"output":2,"cacheRead":0,"cacheWrite":0})),
            ],
        ),
    );
    let tree = fx.tree(&file);
    let one = entry(&tree, "one").usage.as_ref().unwrap();
    assert_eq!(
        (one.ttl, one.cost_read, one.cost_write),
        (Some(3600), Some(0.01), Some(0.2))
    );
    assert_eq!(
        (one.input, one.output, one.cache_read, one.cache_write),
        (3, 7, 100, 50)
    );
    let minutes = entry(&tree, "five").usage.as_ref().unwrap();
    assert_eq!(
        (minutes.ttl, minutes.cost_read, minutes.cost_write),
        (Some(300), Some(0.5), Some(0.25))
    );
    let none = entry(&tree, "none").usage.as_ref().unwrap();
    assert_eq!(
        (none.ttl, none.cost_read, none.cost_write),
        (None, None, None)
    );
    assert!(entry(&tree, "u1").usage.is_none());
}

#[test]
fn text_is_trimmed_first_non_empty_and_cut_on_a_char_boundary() {
    let fx = Fixture::new("text");
    let long = format!("a{}", "é".repeat(400));
    let blocks = json!({"type":"message","id":"a1","parentId":"u1","timestamp":"t",
        "message":{"role":"assistant","content":[
            {"type":"text","text":"  \n "},{"type":"toolCall","name":"x","arguments":{"text":"nope"}},
            {"type":"text","text":"\n  the answer  "}],"timestamp":2}});
    let string_content = json!({"type":"message","id":"u2","parentId":"a1","timestamp":"t",
        "message":{"role":"user","content":"  plain string  ","timestamp":3}});
    let agent = json!({"type":"message","id":"u3","parentId":"u2","timestamp":"t",
        "message":{"role":"user","attribution":"agent","content":[{"type":"text","text":"nudge"}],"timestamp":4}});
    let synthetic = json!({"type":"message","id":"u4","parentId":"u3","timestamp":"t",
        "message":{"role":"user","synthetic":true,"content":[{"type":"text","text":"gen"}],"timestamp":5}});
    let image_only = json!({"type":"message","id":"u5","parentId":"u4","timestamp":"t",
        "message":{"role":"user","content":[{"type":"image","data":"AAAA"}],"timestamp":6}});
    let file = fx.put(
        "s.jsonl",
        &with_header(
            None,
            vec![
                user("u1", None, &long, 1),
                blocks,
                string_content,
                agent,
                synthetic,
                image_only,
            ],
        ),
    );
    let tree = fx.tree(&file);
    let u1 = entry(&tree, "u1").text.as_deref().unwrap();
    assert_eq!(u1.chars().count(), 300);
    assert!(u1.starts_with("aéé"));
    assert_eq!(entry(&tree, "a1").text.as_deref(), Some("the answer"));
    assert_eq!(entry(&tree, "u2").text.as_deref(), Some("plain string"));
    assert!(!entry(&tree, "u2").agent);
    assert!(entry(&tree, "u3").agent);
    assert!(entry(&tree, "u4").agent);
    assert_eq!(entry(&tree, "u5").text, None);
}

#[test]
fn labels_follow_the_latest_entry_and_an_empty_label_deletes() {
    let fx = Fixture::new("labels");
    let label = |id: &str, parent: &str, target: &str, text: &str| json!({"type":"label","id":id,"parentId":parent,"timestamp":"t","targetId":target,"label":text});
    let file = fx.put(
        "s.jsonl",
        &with_header(
            None,
            vec![
                user("u1", None, "q", 1),
                assistant("a1", Some("u1"), "r", 2),
                user("u2", Some("a1"), "q2", 3),
                tool_result("t1", Some("u2")),
                label("l1", "t1", "u1", "draft"),
                label("l2", "l1", "u1", "final"),
                label("l3", "l2", "u2", "gone"),
                label("l4", "l3", "u2", ""),
                // Aimed at a collapsed entry: shown on its kept ancestor.
                label("l5", "l4", "t1", "on the tool"),
            ],
        ),
    );
    let tree = fx.tree(&file);
    assert_eq!(entry(&tree, "u1").label.as_deref(), Some("final"));
    assert_eq!(entry(&tree, "a1").label, None);
    assert_eq!(entry(&tree, "u2").label.as_deref(), Some("on the tool"));
}

#[test]
fn clearing_the_label_of_a_collapsed_entry_keeps_its_kept_ancestors_own_label() {
    let fx = Fixture::new("labels_collapsed");
    let label = |id: &str, parent: &str, target: &str, text: &str| json!({"type":"label","id":id,"parentId":parent,"timestamp":"t","targetId":target,"label":text});
    let file = fx.put(
        "s.jsonl",
        &with_header(
            None,
            vec![
                user("u1", None, "q", 1),
                assistant("a1", Some("u1"), "r", 2),
                tool_result("t1", Some("a1")),
                label("l1", "t1", "a1", "important"),
                label("l2", "l1", "t1", "check"),
                label("l3", "l2", "t1", ""),
            ],
        ),
    );
    let tree = fx.tree(&file);
    assert_eq!(entry(&tree, "a1").label.as_deref(), Some("important"));
}

#[test]
fn compaction_maps_its_first_kept_entry_to_a_kept_ancestor() {
    let fx = Fixture::new("compaction");
    let compaction = |id: &str, parent: &str, first: &str| json!({"type":"compaction","id":id,"parentId":parent,"timestamp":"t","firstKeptEntryId":first});
    let file = fx.put(
        "s.jsonl",
        &with_header(
            None,
            vec![
                user("u1", None, "q", 1),
                assistant("a1", Some("u1"), "r", 2),
                tool_result("t1", Some("a1")),
                user("u2", Some("t1"), "q2", 3),
                compaction("k1", "u2", "u2"),
                compaction("k2", "k1", "t1"),
                compaction("k3", "k2", "gone"),
            ],
        ),
    );
    let tree = fx.tree(&file);
    let k1 = entry(&tree, "k1");
    assert_eq!(
        (k1.first_kept_id.as_deref(), k1.first_kept_exact),
        (Some("u2"), true)
    );
    let k2 = entry(&tree, "k2");
    assert_eq!(
        (k2.first_kept_id.as_deref(), k2.first_kept_exact),
        (Some("a1"), false)
    );
    let k3 = entry(&tree, "k3");
    assert_eq!(
        (k3.first_kept_id.as_deref(), k3.first_kept_exact),
        (None, false)
    );
}

#[test]
fn file_facts_title_cwd_and_malformed_lines() {
    let fx = Fixture::new("facts");
    let a = fx.put(
        "a.jsonl",
        &with_header(None, vec![user("u1", None, "q", 1)]),
    );
    let renamed = json!({"type":"title_change","id":"tc","parentId":"u1","timestamp":"2026-10-04T09:30:00.000Z","title":"Early name"});
    let file = fx.put_raw(
        "b.jsonl",
        &format!(
            "{}\n{}\nnot json\n\n{{\"type\":\"message\"\n{}\n{}\n{}\n",
            json!({"type":"title","v":1,"title":"Newest name","updatedAt":"2026-10-04T11:00:00.000Z"}),
            header(Some(&a))[1],
            user("u1", None, "q", 1),
            renamed,
            user("u2", Some("tc"), "after junk", 2),
        ),
    );
    let tree = fx.tree(&file);
    let this = &tree.files[0];
    assert_eq!(this.title.as_deref(), Some("Newest name"));
    assert_eq!(this.cwd.as_deref(), Some("/work/proj"));
    assert_eq!(this.path, file.to_string_lossy());
    assert_eq!(entry(&tree, "u2").parent_id.as_deref(), Some("u1"));

    // With an empty title line the latest title_change wins.
    let c = fx.put(
        "c.jsonl",
        &with_header(
            None,
            vec![
                user("u1", None, "q", 1),
                renamed_with("tc1", "First"),
                renamed_with("tc2", "Second"),
            ],
        ),
    );
    assert_eq!(fx.tree(&c).files[0].title.as_deref(), Some("Second"));
    assert_eq!(
        fx.tree(&a)
            .files
            .iter()
            .find(|f| f.path.ends_with("a.jsonl"))
            .unwrap()
            .title,
        None
    );
}

fn renamed_with(id: &str, title: &str) -> Value {
    let at = if id == "tc1" {
        "2026-10-04T09:30:00.000Z"
    } else {
        "2026-10-04T09:45:00.000Z"
    };
    json!({"type":"title_change","id":id,"parentId":"u1","timestamp":at,"title":title})
}

#[test]
fn only_existing_jsonl_files_under_the_root_are_accepted() {
    let fx = Fixture::new("validate");
    let good = fx.put(
        "s.jsonl",
        &with_header(None, vec![user("u1", None, "q", 1)]),
    );
    assert!(build(&fx.root, &good).is_ok());

    // omp writes the file lazily, so the path of a fresh tab is not there yet:
    // an empty tree while the directory is confined, an error otherwise.
    let unwritten = build(&fx.root, &fx.path("nope.jsonl")).expect("empty tree");
    assert!(unwritten.files.is_empty() && unwritten.entries.is_empty());
    let no_dir = build(&fx.root, &fx.root.join("--gone--").join("nope.jsonl")).unwrap_err();
    assert!(no_dir.contains("does not exist"), "{no_dir}");
    let unwritten_txt = build(&fx.root, &fx.path("nope.txt")).unwrap_err();
    assert!(unwritten_txt.contains(".jsonl"), "{unwritten_txt}");

    let text = fx.put_raw("notes.txt", "{}\n");
    let wrong_kind = build(&fx.root, &text).unwrap_err();
    assert!(wrong_kind.contains(".jsonl"), "{wrong_kind}");

    let elsewhere = Fixture::new("validate_other");
    let outside = elsewhere.put("o.jsonl", &with_header(None, vec![]));
    let rejected = build(&fx.root, &outside).unwrap_err();
    assert!(rejected.contains("outside"), "{rejected}");

    // A `..` hop that leaves the root is judged by where it lands.
    let sneaky = fx
        .dir
        .join("..")
        .join("..")
        .join(elsewhere.root.file_name().unwrap())
        .join("--work-proj--")
        .join("o.jsonl");
    assert!(build(&fx.root, &sneaky).unwrap_err().contains("outside"));
    // An unwritten file is confined the same way, `..` hop or not.
    let unwritten_outside = elsewhere.path("fresh.jsonl");
    assert!(build(&fx.root, &unwritten_outside)
        .unwrap_err()
        .contains("outside"));
    let unwritten_sneaky = fx
        .dir
        .join("..")
        .join("..")
        .join(elsewhere.root.file_name().unwrap())
        .join("--work-proj--")
        .join("fresh.jsonl");
    assert!(build(&fx.root, &unwritten_sneaky)
        .unwrap_err()
        .contains("outside"));

    assert!(build(&fx.root, &fx.dir).is_err());
}

#[test]
fn a_parent_session_written_as_a_bare_id_links_the_family() {
    let fx = Fixture::new("idform");
    let session = |id: &str, parent: Option<&str>| {
        let mut head = json!({"type":"session","version":3,"id":id,"timestamp":"2026-10-04T09:00:00.000Z","cwd":"/work/proj"});
        if let Some(parent) = parent {
            head["parentSession"] = json!(parent);
        }
        head
    };
    let root_id = "01a10000-0000-7000-8000-000000000001";
    let fork_id = "01a10000-0000-7000-8000-000000000002";
    let root = fx.put(
        &format!("2026-10-04T09-00-00-000Z_{root_id}.jsonl"),
        &[session(root_id, None), user("u1", None, "q", 1)],
    );
    // TUI `/fork`: the header names the parent by id only.
    let fork = fx.put(
        &format!("2026-10-04T10-00-00-000Z_{fork_id}.jsonl"),
        &[session(fork_id, Some(root_id)), user("u1", None, "q", 1)],
    );
    // A parent found through its header id, not its file name.
    fx.put(
        "odd-name.jsonl",
        &[session("hdr-id", None), user("z1", None, "z", 1)],
    );
    let by_header = fx.put(
        "child.jsonl",
        &[
            session("child-id", Some("hdr-id")),
            user("z1", None, "z", 1),
        ],
    );
    // An id no listed file has links nothing.
    let dangling = fx.put(
        "lost.jsonl",
        &[
            session("lost-id", Some("no-such-id")),
            user("l1", None, "l", 1),
        ],
    );

    let from_fork = fx.tree(&fork);
    assert_eq!(
        names(&from_fork),
        [
            format!("2026-10-04T10-00-00-000Z_{fork_id}.jsonl"),
            format!("2026-10-04T09-00-00-000Z_{root_id}.jsonl"),
        ]
    );
    assert_eq!(fx.tree(&root).files.len(), 2);
    assert_eq!(
        names(&fx.tree(&by_header)),
        ["child.jsonl", "odd-name.jsonl"]
    );
    assert_eq!(names(&fx.tree(&dangling)), ["lost.jsonl"]);
}

/// The sorted keys of a JSON object.
fn keys(v: &Value) -> Vec<&str> {
    let mut k: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    k.sort_unstable();
    k
}

#[test]
fn serialises_the_contract_field_names() {
    let fx = Fixture::new("json");
    let file = fx.put(
        "s.jsonl",
        &with_header(
            None,
            vec![
                user("u1", None, "q", 1),
                assistant("a1", Some("u1"), "r", 2),
            ],
        ),
    );
    let value = serde_json::to_value(fx.tree(&file)).unwrap();
    assert_eq!(keys(&value), ["entries", "files"]);
    assert_eq!(
        keys(&value["files"][0]),
        ["current", "cwd", "leafId", "path", "title"]
    );
    assert_eq!(
        keys(&value["entries"][1]),
        [
            "agent",
            "at",
            "firstKeptExact",
            "firstKeptId",
            "id",
            "inCurrent",
            "kind",
            "label",
            "parentId",
            "text",
            "ts",
            "usage"
        ]
    );
    assert_eq!(
        keys(&value["entries"][1]["usage"]),
        [
            "cacheRead",
            "cacheWrite",
            "costRead",
            "costWrite",
            "input",
            "output",
            "ttl"
        ]
    );
    assert_eq!(value["entries"][0]["kind"], "user");
    assert_eq!(value["entries"][0]["ts"], 1);
    assert_eq!(value["entries"][1]["parentId"], "u1");
}
