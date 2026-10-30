use super::*;
use serde_json::{json, Value};

fn local() -> LocalBranch {
    LocalBranch {
        branch: "local".into(),
        head: "abc".into(),
        owner: "alice".into(),
        repo: "project".into(),
        remote_ref: "refs/heads/topic".into(),
    }
}

fn find(prs: Vec<Value>, truncated: bool) -> Value {
    json!({"data":{"repository":{
        "isFork":false, "parent":null,
        "pullRequests":{"pageInfo":{"hasNextPage":false},"nodes":[]},
        "ref":{"target":{"oid":"abc","associatedPullRequests":{"pageInfo":{"hasNextPage":truncated},"nodes":prs}}}
    }}})
}
fn pr(id: &str, owner: &str) -> Value {
    json!({"id":id,"state":"OPEN","headRefOid":"abc","headRefName":"topic","headRepository":{"nameWithOwner":owner}})
}
fn feedback(contexts: Vec<Value>, threads: Vec<Value>) -> Value {
    json!({"data":{
        "node":{"number":12,"url":"https://github.com/upstream/project/pull/12","title":"Improve project","repository":{"nameWithOwner":"upstream/project"},"additions":42,"deletions":3,"isDraft":true,"state":"OPEN","headRefOid":"abc","headRefName":"topic","headRepository":{"nameWithOwner":"alice/project"},"reviewThreads":{"pageInfo":{"hasNextPage":false},"nodes":threads},
            "commits":{"nodes":[{"commit":{"oid":"abc","statusCheckRollup":{"contexts":{"pageInfo":{"hasNextPage":false},"nodes":contexts}}}}]}}
    }})
}
fn check(id: &str, status: &str, conclusion: Value, started: &str) -> Value {
    json!({"__typename":"CheckRun","id":id,"name":id,"status":status,"conclusion":conclusion,"detailsUrl":null,"startedAt":started,"completedAt":"2026-01-02T00:00:00Z"})
}
fn thread(id: &str, resolved: bool, outdated: bool) -> Value {
    json!({"id":id,"isResolved":resolved,"isOutdated":outdated,"comments":{"nodes":[{"updatedAt":"2026-01-02T00:00:00Z","url":"https://github.com/u/r/pull/1#discussion_r1"}]}})
}

#[test]
fn parses_only_github_com_ssh_or_https_repository_urls() {
    let https = gix::url::parse("https://github.com/alice/project.git").unwrap();
    let ssh = gix::url::parse("git@github.com:alice/project.git").unwrap();
    assert_eq!(
        github_repo(&https).unwrap(),
        ("alice".into(), "project".into())
    );
    assert_eq!(
        github_repo(&ssh).unwrap(),
        ("alice".into(), "project".into())
    );
    for input in [
        "https://github.example/alice/project",
        "https://github.com.evil.test/alice/project",
        "https://github.com:8443/alice/project",
        "https://github.com/alice/project/extra",
        "https://github.com/alice/project?x=1",
        "ext::x",
    ] {
        let url = gix::url::parse(input).unwrap();
        assert!(github_repo(&url).is_err(), "{input}");
    }
}

#[test]
fn selects_only_the_upstream_repository_and_branch_and_rejects_ambiguity() {
    let mut wrong_branch = pr("wrong", "alice/project");
    wrong_branch["headRefName"] = json!("other");
    let mut old = pr("old", "alice/project");
    old["state"] = json!("MERGED");
    let result = find(
        vec![
            pr("foreign", "bob/project"),
            wrong_branch,
            old,
            pr("match", "ALICE/project"),
        ],
        false,
    );
    assert_eq!(
        select_pr(&result, &local()).unwrap(),
        Some(("match".into(), "abc".into()))
    );
    assert_eq!(
        select_pr(&find(vec![pr("foreign", "bob/project")], false), &local()).unwrap(),
        None
    );
    assert!(select_pr(
        &find(
            vec![pr("a", "alice/project"), pr("b", "alice/project")],
            false
        ),
        &local()
    )
    .unwrap_err()
    .contains("Multiple"));
    assert!(select_pr(&find(vec![], true), &local())
        .unwrap_err()
        .contains("limit"));
    assert!(select_pr(&json!({"data":{"repository":null}}), &local()).is_err());
}

#[test]
fn direct_fork_parent_results_cover_default_branch_and_deduplicate() {
    let mut result = find(vec![pr("match", "alice/project")], false);
    result["data"]["repository"]["isFork"] = json!(true);
    result["data"]["repository"]["parent"] = json!({
        "pullRequests":{"pageInfo":{"hasNextPage":false},"nodes":[pr("match", "alice/project")]}
    });
    assert_eq!(
        select_pr(&result, &local()).unwrap(),
        Some(("match".into(), "abc".into()))
    );
    result["data"]["repository"]["ref"]["target"]["associatedPullRequests"]["nodes"] = json!([]);
    assert_eq!(
        select_pr(&result, &local()).unwrap(),
        Some(("match".into(), "abc".into()))
    );
    result["data"]["repository"]["parent"]["pullRequests"]["pageInfo"]["hasNextPage"] = json!(true);
    assert!(select_pr(&result, &local()).unwrap_err().contains("limit"));
    result["data"]["repository"]["parent"] = Value::Null;
    assert!(select_pr(&result, &local()).unwrap_err().contains("parent"));
}

#[test]
fn unmatched_fork_cannot_silently_hide_sibling_pr() {
    let mut result = find(vec![], false);
    result["data"]["repository"]["isFork"] = json!(true);
    result["data"]["repository"]["parent"] = json!({
        "pullRequests":{"pageInfo":{"hasNextPage":false},"nodes":[]}
    });
    assert!(select_pr(&result, &local())
        .unwrap_err()
        .contains("other forks"));
}

#[test]
fn completed_fork_pr_is_not_a_discovery_error() {
    for state in ["CLOSED", "MERGED"] {
        let mut completed = pr("finished", "alice/project");
        completed["state"] = json!(state);
        let mut result = find(vec![completed], false);
        result["data"]["repository"]["isFork"] = json!(true);
        result["data"]["repository"]["parent"] = json!({
            "pullRequests":{"pageInfo":{"hasNextPage":false},"nodes":[]}
        });
        assert_eq!(select_pr(&result, &local()).unwrap(), None);
        result["data"]["repository"]["ref"]["target"]["associatedPullRequests"]["nodes"][0]
            ["headRefOid"] = json!("older");
        assert!(select_pr(&result, &local()).is_err());
    }
}

#[test]
fn head_mismatch_is_not_mistaken_for_no_pr() {
    let mut result = find(vec![], false);
    result["data"]["repository"]["ref"]["target"]["oid"] = json!("new");
    assert!(select_pr(&result, &local())
        .unwrap_err()
        .contains("Local HEAD"));
    let mut pr = pr("p", "alice/project");
    pr["headRefOid"] = json!("new");
    assert!(select_pr(&find(vec![pr], false), &local())
        .unwrap_err()
        .contains("differs"));
}

#[test]
fn includes_only_actionable_completed_checks_and_open_current_threads() {
    let mut checks = vec![
        check("failed", "COMPLETED", json!("FAILURE"), "t1"),
        check("inflight", "IN_PROGRESS", Value::Null, "t2"),
    ];
    for conclusion in [
        "TIMED_OUT",
        "ACTION_REQUIRED",
        "STARTUP_FAILURE",
        "CANCELLED",
        "SUCCESS",
        "NEUTRAL",
        "SKIPPED",
    ] {
        checks.push(check(conclusion, "COMPLETED", json!(conclusion), "t1"));
    }
    checks.push(json!({"__typename":"StatusContext","id":"legacy","context":"legacy-ci","state":"ERROR","targetUrl":"https://example.test/ci","createdAt":"t3"}));
    checks.push(json!({"__typename":"StatusContext","id":"ok","context":"ok","state":"SUCCESS","targetUrl":null,"createdAt":"t4"}));
    let result = feedback(
        checks,
        vec![
            thread("open", false, false),
            thread("resolved", true, false),
            thread("outdated", false, true),
        ],
    );
    let snapshot = parse_feedback(&result, &local(), "abc").unwrap();
    assert_eq!(snapshot.number, 12);
    assert_eq!(snapshot.title, "Improve project");
    assert_eq!(snapshot.repository, "upstream/project");
    assert_eq!(snapshot.additions, 42);
    assert_eq!(snapshot.deletions, 3);
    assert!(snapshot.is_draft);
    assert_eq!(snapshot.branch, "local");
    assert_eq!(snapshot.failed_checks.len(), 5);
    assert_eq!(
        snapshot.failed_checks[0].id,
        "failed:t1:2026-01-02T00:00:00Z"
    );
    assert_eq!(snapshot.failed_checks[4].id, "legacy:t3");
    // The card gets every check, in GitHub's order, failed or not.
    let states: Vec<_> = snapshot
        .checks
        .iter()
        .map(|c| (c.name.as_str(), c.state))
        .collect();
    assert_eq!(
        states,
        [
            ("failed", CheckState::Failure),
            ("inflight", CheckState::Running),
            ("TIMED_OUT", CheckState::Failure),
            ("ACTION_REQUIRED", CheckState::Failure),
            ("STARTUP_FAILURE", CheckState::Failure),
            ("CANCELLED", CheckState::Neutral),
            ("SUCCESS", CheckState::Success),
            ("NEUTRAL", CheckState::Neutral),
            ("SKIPPED", CheckState::Neutral),
            ("legacy-ci", CheckState::Failure),
            ("ok", CheckState::Success),
        ]
    );
    // No details page: the PR stands in.
    assert_eq!(snapshot.checks[0].url, snapshot.url);
    assert_eq!(snapshot.checks[9].url, "https://example.test/ci");
    assert_eq!(snapshot.threads.len(), 1);
    assert_eq!(snapshot.threads[0].id, "open");
    assert_eq!(snapshot.threads[0].updated_at, "2026-01-02T00:00:00Z");
    let wire = serde_json::to_value(snapshot).unwrap();
    assert!(wire.get("failedChecks").is_some());
    assert_eq!(wire["checks"][1]["state"], "running");
    assert_eq!(wire["isDraft"], true);
    assert_eq!(wire["repository"], "upstream/project");
    assert!(wire["threads"][0].get("updatedAt").is_some());
}

#[test]
fn requires_valid_display_metadata() {
    for key in ["title", "repository", "additions", "deletions", "isDraft"] {
        let mut result = feedback(vec![], vec![]);
        result["data"]["node"].as_object_mut().unwrap().remove(key);
        assert!(
            parse_feedback(&result, &local(), "abc").is_err(),
            "missing {key}"
        );
    }
    for (key, invalid) in [
        ("title", json!("")),
        ("title", Value::Null),
        ("repository", Value::Null),
        ("repository", json!({})),
        ("repository", json!({"nameWithOwner":""})),
        ("additions", json!(-1)),
        ("additions", json!(1.5)),
        ("deletions", json!(-1)),
        ("deletions", json!("3")),
        ("isDraft", json!("false")),
        ("isDraft", Value::Null),
    ] {
        let mut result = feedback(vec![], vec![]);
        result["data"]["node"][key] = invalid;
        assert!(
            parse_feedback(&result, &local(), "abc").is_err(),
            "invalid {key}"
        );
    }
    let mut result = feedback(vec![], vec![]);
    result["data"]["node"]["additions"] = json!(0);
    result["data"]["node"]["deletions"] = json!(0);
    result["data"]["node"]["isDraft"] = json!(false);
    let snapshot = parse_feedback(&result, &local(), "abc").unwrap();
    assert_eq!(
        (snapshot.additions, snapshot.deletions, snapshot.is_draft),
        (0, 0, false)
    );
}

#[test]
fn checks_not_started_are_queued_and_a_pending_status_is_running() {
    for status in ["QUEUED", "REQUESTED", "WAITING", "PENDING"] {
        let parsed = parse_check(&check("run", status, Value::Null, "t"), "fallback").unwrap();
        assert_eq!(parsed.ci.state, CheckState::Queued, "{status}");
        assert!(parsed.failed.is_none());
    }
    for (state, want) in [
        ("PENDING", CheckState::Running),
        ("EXPECTED", CheckState::Queued),
    ] {
        let status = json!({"__typename":"StatusContext","id":"s","context":"ext","state":state,"targetUrl":null,"createdAt":"t"});
        assert_eq!(parse_check(&status, "fallback").unwrap().ci.state, want);
    }
    let unknown = json!({"__typename":"StatusContext","id":"s","context":"ext","state":"LATER","targetUrl":null,"createdAt":"t"});
    assert!(parse_check(&unknown, "fallback").is_err());
}

#[test]
fn new_attempts_produce_new_ids() {
    let failed = |started| {
        parse_check(
            &check("run", "COMPLETED", json!("FAILURE"), started),
            "fallback",
        )
        .unwrap()
        .failed
        .unwrap()
    };
    assert_ne!(failed("first").id, failed("second").id);
}

#[test]
fn startup_failure_with_nullable_timestamps_is_actionable() {
    let mut run = check("startup", "COMPLETED", json!("STARTUP_FAILURE"), "unused");
    run["startedAt"] = Value::Null;
    run["completedAt"] = Value::Null;
    let result = parse_check(&run, "fallback").unwrap().failed.unwrap();
    assert_eq!(result.id, "startup::");
    run["startedAt"] = json!(42);
    assert!(parse_check(&run, "fallback").is_err());
}

#[test]
fn rejects_truncated_malformed_or_changed_data() {
    let mut result = feedback(vec![], vec![]);
    result["data"]["node"]["reviewThreads"]["pageInfo"]["hasNextPage"] = json!(true);
    assert!(parse_feedback(&result, &local(), "abc")
        .unwrap_err()
        .contains("limit"));
    let mut result = feedback(vec![], vec![]);
    result["data"]["node"]["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]
        ["pageInfo"]["hasNextPage"] = json!(true);
    assert!(parse_feedback(&result, &local(), "abc")
        .unwrap_err()
        .contains("limit"));
    let mut result = feedback(vec![], vec![thread("t", false, false)]);
    result["data"]["node"]["reviewThreads"]["nodes"][0]["comments"]["nodes"] = json!([]);
    assert!(parse_feedback(&result, &local(), "abc").is_err());
    let mut result = feedback(vec![], vec![]);
    result["data"]["node"]["headRefOid"] = json!("new");
    assert!(parse_feedback(&result, &local(), "abc")
        .unwrap_err()
        .contains("changed"));
    let result = feedback(vec![json!({"__typename":"Unknown"})], vec![]);
    assert!(parse_feedback(&result, &local(), "abc").is_err());
    let result = feedback(vec![check("id", "COMPLETED", Value::Null, "t")], vec![]);
    assert!(parse_feedback(&result, &local(), "abc").is_err());
    let result = feedback(vec![], vec![]);
    assert!(parse_feedback(&result, &local(), "other").is_err());
}

/// The webview tells a missing gh (a disabled card) from every other failure
/// (an error) by `ghMissing` alone.
#[test]
fn lookup_errors_mark_only_a_missing_gh() {
    let missing = LookupError {
        message: "gh was not found".into(),
        gh_missing: true,
    };
    assert_eq!(
        serde_json::to_value(missing).unwrap(),
        json!({"message": "gh was not found", "ghMissing": true})
    );
    assert_eq!(
        serde_json::to_value(LookupError::from("denied".to_string())).unwrap(),
        json!({"message": "denied", "ghMissing": false})
    );
}

/// Run explicitly with `OMP_PR_AUTOMATION_SMOKE_PROJECT` set to a local
/// checkout. This only reads Git metadata and queries GitHub via `gh`.
#[test]
#[ignore = "requires an authenticated gh and a GitHub.com checkout"]
fn live_read_only_snapshot() {
    let folder = std::env::var_os("OMP_PR_AUTOMATION_SMOKE_PROJECT")
        .expect("set OMP_PR_AUTOMATION_SMOKE_PROJECT to a checkout");
    let path = Path::new(&folder);
    eprintln!("local: {:?}", local_branch(path).expect("local branch"));
    eprintln!("snapshot: {:?}", snapshot(path).expect("GitHub snapshot"));
}
