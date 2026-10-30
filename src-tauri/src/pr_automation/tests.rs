use super::feedback::{parse_check, SelectedPr};
use super::git::github_repo;
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

/// `FIND_QUERY`'s answer for alice/project (not a fork) whose upstream head
/// `abc` is associated with `prs`.
fn find(prs: Vec<Value>, truncated: bool) -> Value {
    json!({"data":{"repository":{
        "nameWithOwner":"alice/project", "isFork":false, "parent":null,
        "ref":{"target":{"oid":"abc","associatedPullRequests":{"pageInfo":{"hasNextPage":truncated},"nodes":prs}}}
    }}})
}
/// [`find`] for alice/project as a fork of upstream/project.
fn fork(prs: Vec<Value>) -> Value {
    let mut result = find(prs, false);
    result["data"]["repository"]["isFork"] = json!(true);
    result["data"]["repository"]["parent"] = json!({"nameWithOwner":"upstream/project"});
    result
}
/// An open PR #`n` on `topic` at `abc` from `owner`, as GraphQL lists it.
fn pr(n: u32, owner: &str) -> Value {
    json!({"url":format!("https://github.com/upstream/project/pull/{n}"),"id":format!("PR_{n}"),"state":"OPEN","headRefOid":"abc","headRefName":"topic","headRepository":{"nameWithOwner":owner}})
}
/// The same PR as the REST list returns it, with a differently shaped id.
fn rest_pr(n: u32, owner: &str) -> Value {
    json!({"html_url":format!("https://github.com/upstream/project/pull/{n}"),"node_id":format!("PR_rest_{n}"),"state":"open","head":{"ref":"topic","sha":"abc","repo":{"full_name":owner}}})
}
/// The REST stand-in: the open PRs listed for alice/project and for
/// upstream/project, each answered at most once, always for alice's branch.
fn pulls(
    repository: Vec<Value>,
    parent: Vec<Value>,
) -> impl FnMut(&str, &str) -> Result<Value, String> {
    let mut lists = [
        ("alice/project", Some(Value::Array(repository))),
        ("upstream/project", Some(Value::Array(parent))),
    ];
    move |name, head| {
        assert_eq!(head, "alice:topic");
        let (_, list) = lists
            .iter_mut()
            .find(|(listed, _)| *listed == name)
            .unwrap_or_else(|| panic!("unexpected repository {name}"));
        Ok(list.take().expect("each repository is listed once"))
    }
}
fn none() -> impl FnMut(&str, &str) -> Result<Value, String> {
    pulls(vec![], vec![])
}
/// What `select_pr` returns for PR id `id` from alice/project.
fn chosen(id: &str) -> SelectedPr {
    SelectedPr {
        id: id.into(),
        repository: "alice/project".into(),
    }
}
/// The PR `feedback` describes.
fn selected() -> SelectedPr {
    chosen("PR_12")
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
    commented(id, resolved, outdated, &[("2026-01-02T00:00:00Z", false)])
}
/// A thread with `comments` (`updatedAt`, `viewerDidAuthor`), oldest first.
fn commented(id: &str, resolved: bool, outdated: bool, comments: &[(&str, bool)]) -> Value {
    let nodes: Vec<_> = comments
        .iter()
        .map(|(updated, viewer)| json!({"updatedAt":updated,"viewerDidAuthor":viewer}))
        .collect();
    json!({"id":id,"isResolved":resolved,"isOutdated":outdated,"comments":{"pageInfo":{"hasPreviousPage":false},"nodes":nodes}})
}
fn message<T: std::fmt::Debug>(result: Result<T, LookupError>) -> String {
    result.unwrap_err().message
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
fn reads_the_upstream_branch_and_its_github_repository() {
    let Some(repo) = crate::git_browser::fixture::init("pr-automation-local") else {
        return;
    };
    let head = repo.commit("initial", 1_700_000_000);
    let err = local_branch(repo.path()).unwrap_err();
    assert!(err.contains("upstream"), "{err}");
    repo.git(&[
        "remote",
        "add",
        "origin",
        "git@github.com:alice/project.git",
    ]);
    repo.git(&["config", "branch.main.remote", "origin"]);
    repo.git(&["config", "branch.main.merge", "refs/heads/topic"]);
    assert_eq!(
        local_branch(repo.path()).unwrap(),
        LocalBranch {
            branch: "main".into(),
            head,
            owner: "alice".into(),
            repo: "project".into(),
            remote_ref: "refs/heads/topic".into(),
        }
    );
    repo.git(&[
        "remote",
        "set-url",
        "origin",
        "https://gitlab.com/alice/project.git",
    ]);
    let err = local_branch(repo.path()).unwrap_err();
    assert!(err.contains("GitHub.com"), "{err}");
    repo.git(&["checkout", "-q", "--detach"]);
    let err = local_branch(repo.path()).unwrap_err();
    assert!(err.contains("detached"), "{err}");
}

#[test]
fn selects_only_the_upstream_repository_and_branch_and_rejects_ambiguity() {
    let mut wrong_branch = pr(1, "alice/project");
    wrong_branch["headRefName"] = json!("other");
    let mut old = pr(2, "alice/project");
    old["state"] = json!("MERGED");
    let result = find(
        vec![
            pr(3, "bob/project"),
            wrong_branch,
            old,
            pr(4, "ALICE/project"),
        ],
        false,
    );
    assert_eq!(
        select_pr(&result, &local(), none()).unwrap(),
        Some(chosen("PR_4"))
    );
    assert_eq!(
        select_pr(&find(vec![pr(3, "bob/project")], false), &local(), none()).unwrap(),
        None
    );
    let two = find(vec![pr(1, "alice/project"), pr(2, "alice/project")], false);
    assert!(message(select_pr(&two, &local(), none())).contains("Multiple"));
    assert!(message(select_pr(&find(vec![], true), &local(), none())).contains("limit"));
    assert!(select_pr(&json!({"data":{"repository":null}}), &local(), none()).is_err());
    let mut unsafe_name = find(vec![], false);
    unsafe_name["data"]["repository"]["nameWithOwner"] = json!("../project");
    assert!(message(select_pr(&unsafe_name, &local(), none())).contains("repository name"));
}

/// GitHub follows renames: a remote still on the old URL resolves to the
/// new name, which PR head repositories carry.
#[test]
fn renamed_repository_is_matched_by_its_resolved_name() {
    let mut result = find(vec![pr(1, "alice/renamed")], false);
    result["data"]["repository"]["nameWithOwner"] = json!("alice/renamed");
    let mut listed = Vec::new();
    let selection = select_pr(&result, &local(), |name, head| {
        listed.push(format!("{name} {head}"));
        Ok(json!([]))
    })
    .unwrap()
    .unwrap();
    assert_eq!(listed, ["alice/renamed alice:topic"]);
    assert_eq!(selection.id, "PR_1");
    assert_eq!(selection.repository, "alice/renamed");
    let mut result = feedback(vec![], vec![]);
    result["data"]["node"]["headRepository"]["nameWithOwner"] = json!("Alice/Renamed");
    assert!(parse_feedback(&result, &local(), &selection).is_ok());
    // Still the old name: not the PR that was selected.
    let result = feedback(vec![], vec![]);
    assert!(message(parse_feedback(&result, &local(), &selection)).contains("changed"));
}

#[test]
fn rest_lists_skip_other_forks_and_deduplicate_by_url() {
    let mut deleted = rest_pr(5, "alice/project");
    deleted["head"]["repo"] = Value::Null;
    let listed = vec![
        rest_pr(1, "alice/project"),
        rest_pr(2, "bob/project"),
        deleted,
    ];
    // The associated PR and the listed one are the same PR, by URL.
    let result = find(vec![pr(1, "alice/project")], false);
    assert_eq!(
        select_pr(&result, &local(), pulls(listed, vec![])).unwrap(),
        Some(chosen("PR_1"))
    );
    // Not associated with the head commit (yet): the list alone finds it.
    let result = find(vec![], false);
    let listed = vec![rest_pr(2, "bob/project"), rest_pr(3, "alice/project")];
    assert_eq!(
        select_pr(&result, &local(), pulls(listed, vec![])).unwrap(),
        Some(chosen("PR_rest_3"))
    );
    let result = find(vec![pr(1, "alice/project")], false);
    let listed = vec![rest_pr(2, "alice/project")];
    assert!(message(select_pr(&result, &local(), pulls(listed, vec![]))).contains("Multiple"));
}

#[test]
fn rejects_full_or_malformed_rest_lists() {
    let result = find(vec![], false);
    let full = (0..100).map(|n| rest_pr(n, "bob/project")).collect();
    assert!(message(select_pr(&result, &local(), pulls(full, vec![]))).contains("limit"));
    assert!(select_pr(&result, &local(), |_, _| Ok(json!({"message":"x"}))).is_err());
    for broken in ["html_url", "node_id", "state", "head"] {
        let mut item = rest_pr(1, "alice/project");
        item.as_object_mut().unwrap().remove(broken);
        assert!(
            select_pr(&result, &local(), pulls(vec![item], vec![])).is_err(),
            "missing {broken}"
        );
    }
    let mut item = rest_pr(1, "alice/project");
    item["head"]["sha"] = json!(1);
    assert!(select_pr(&result, &local(), pulls(vec![item], vec![])).is_err());
    let mut item = rest_pr(1, "alice/project");
    item["state"] = json!("draft");
    assert!(select_pr(&result, &local(), pulls(vec![item], vec![])).is_err());
    assert!(select_pr(&result, &local(), |_, _| Err("gh failed".into())).is_err());
}

#[test]
fn direct_fork_parent_results_cover_default_branch_and_deduplicate() {
    let result = fork(vec![pr(1, "alice/project")]);
    assert_eq!(
        select_pr(
            &result,
            &local(),
            pulls(vec![], vec![rest_pr(1, "alice/project")])
        )
        .unwrap(),
        Some(chosen("PR_1"))
    );
    let result = fork(vec![]);
    assert_eq!(
        select_pr(
            &result,
            &local(),
            pulls(vec![], vec![rest_pr(1, "alice/project")])
        )
        .unwrap(),
        Some(chosen("PR_rest_1"))
    );
    let full = (0..100).map(|n| rest_pr(n, "alice/project")).collect();
    assert!(message(select_pr(&result, &local(), pulls(vec![], full))).contains("limit"));
    let mut result = fork(vec![]);
    result["data"]["repository"]["parent"] = Value::Null;
    assert!(message(select_pr(&result, &local(), none())).contains("parent"));
}

#[test]
fn unmatched_fork_cannot_silently_hide_sibling_pr() {
    let other = vec![rest_pr(1, "bob/project")];
    assert!(
        message(select_pr(&fork(vec![]), &local(), pulls(vec![], other))).contains("other forks")
    );
}

#[test]
fn completed_fork_pr_is_not_a_discovery_error() {
    for state in ["CLOSED", "MERGED"] {
        let mut completed = pr(1, "alice/project");
        completed["state"] = json!(state);
        let mut result = fork(vec![completed]);
        assert_eq!(select_pr(&result, &local(), none()).unwrap(), None);
        result["data"]["repository"]["ref"]["target"]["associatedPullRequests"]["nodes"][0]
            ["headRefOid"] = json!("older");
        assert!(select_pr(&result, &local(), none()).is_err());
    }
}

#[test]
fn head_mismatch_is_not_mistaken_for_no_pr() {
    let mut result = find(vec![], false);
    result["data"]["repository"]["ref"]["target"]["oid"] = json!("new");
    let err = select_pr(&result, &local(), none()).unwrap_err();
    assert!(
        err.message.contains("Local HEAD") && !err.retryable,
        "{err:?}"
    );
    let mut stale = pr(1, "alice/project");
    stale["headRefOid"] = json!("new");
    let err = select_pr(&find(vec![stale], false), &local(), none()).unwrap_err();
    assert!(err.message.contains("differs") && err.retryable, "{err:?}");
    let mut stale = rest_pr(1, "alice/project");
    stale["head"]["sha"] = json!("new");
    let err = select_pr(&find(vec![], false), &local(), pulls(vec![stale], vec![])).unwrap_err();
    assert!(err.message.contains("differs") && err.retryable, "{err:?}");
}

/// The webview retries lag (GitHub not yet showing a push) with a backoff
/// and pauses on everything else, by `retryable` alone.
#[test]
fn only_lag_errors_are_retryable() {
    let wire = |err: LookupError| serde_json::to_value(err).unwrap();
    let mut stale = pr(1, "alice/project");
    stale["headRefOid"] = json!("new");
    assert_eq!(
        wire(select_pr(&find(vec![stale], false), &local(), none()).unwrap_err()),
        json!({"message":"PR head differs from the upstream branch; retry after GitHub updates","ghMissing":false,"retryable":true})
    );
    let mut moved = feedback(vec![], vec![]);
    moved["data"]["node"]["headRefName"] = json!("other");
    assert_eq!(
        wire(parse_feedback(&moved, &local(), &selected()).unwrap_err()),
        json!({"message":"PR head or branch changed while loading feedback","ghMissing":false,"retryable":true})
    );
    let mut other_commit = feedback(vec![], vec![]);
    other_commit["data"]["node"]["commits"]["nodes"][0]["commit"]["oid"] = json!("zzz");
    assert_eq!(
        wire(parse_feedback(&other_commit, &local(), &selected()).unwrap_err()),
        json!({"message":"GitHub returned feedback for a different commit","ghMissing":false,"retryable":true})
    );
    let two = find(vec![pr(1, "alice/project"), pr(2, "alice/project")], false);
    assert_eq!(
        wire(select_pr(&two, &local(), none()).unwrap_err())["retryable"],
        false
    );
    let mut behind = find(vec![], false);
    behind["data"]["repository"]["ref"]["target"]["oid"] = json!("new");
    assert_eq!(
        wire(select_pr(&behind, &local(), none()).unwrap_err())["retryable"],
        false
    );
    let mut truncated = feedback(vec![], vec![]);
    truncated["data"]["node"]["reviewThreads"]["pageInfo"]["hasNextPage"] = json!(true);
    assert_eq!(
        wire(parse_feedback(&truncated, &local(), &selected()).unwrap_err())["retryable"],
        false
    );
}

/// Auto-fix replies as the viewer; its own reply must not make the thread
/// new again.
#[test]
fn thread_identity_ignores_the_viewers_own_comments() {
    let result = feedback(
        vec![],
        vec![
            commented(
                "replied",
                false,
                false,
                &[("t1", false), ("t2", false), ("t3", true)],
            ),
            commented("own", false, false, &[("t4", true), ("t5", true)]),
        ],
    );
    let snapshot = parse_feedback(&result, &local(), &selected()).unwrap();
    let ids: Vec<_> = snapshot
        .threads
        .iter()
        .map(|t| (t.id.as_str(), t.updated_at.as_str()))
        .collect();
    assert_eq!(ids, [("replied", "t2"), ("own", "t4")]);
    let mut result = feedback(vec![], vec![thread("long", false, false)]);
    result["data"]["node"]["reviewThreads"]["nodes"][0]["comments"]["pageInfo"]
        ["hasPreviousPage"] = json!(true);
    assert!(message(parse_feedback(&result, &local(), &selected())).contains("limit"));
    let mut result = feedback(vec![], vec![thread("bad", false, false)]);
    result["data"]["node"]["reviewThreads"]["nodes"][0]["comments"]["nodes"][0]
        ["viewerDidAuthor"] = Value::Null;
    assert!(parse_feedback(&result, &local(), &selected()).is_err());
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
    let snapshot = parse_feedback(&result, &local(), &selected()).unwrap();
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
    assert_eq!(
        wire["threads"][0],
        json!({"id":"open","updatedAt":"2026-01-02T00:00:00Z"})
    );
}

#[test]
fn requires_valid_display_metadata() {
    for key in ["title", "repository", "additions", "deletions", "isDraft"] {
        let mut result = feedback(vec![], vec![]);
        result["data"]["node"].as_object_mut().unwrap().remove(key);
        assert!(
            parse_feedback(&result, &local(), &selected()).is_err(),
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
            parse_feedback(&result, &local(), &selected()).is_err(),
            "invalid {key}"
        );
    }
    let mut result = feedback(vec![], vec![]);
    result["data"]["node"]["additions"] = json!(0);
    result["data"]["node"]["deletions"] = json!(0);
    result["data"]["node"]["isDraft"] = json!(false);
    let snapshot = parse_feedback(&result, &local(), &selected()).unwrap();
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
    assert!(parse_feedback(&result, &local(), &selected())
        .unwrap_err()
        .message
        .contains("limit"));
    let mut result = feedback(vec![], vec![]);
    result["data"]["node"]["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]
        ["pageInfo"]["hasNextPage"] = json!(true);
    assert!(parse_feedback(&result, &local(), &selected())
        .unwrap_err()
        .message
        .contains("limit"));
    let mut result = feedback(vec![], vec![thread("t", false, false)]);
    result["data"]["node"]["reviewThreads"]["nodes"][0]["comments"]["nodes"] = json!([]);
    assert!(parse_feedback(&result, &local(), &selected()).is_err());
    let mut result = feedback(vec![], vec![]);
    result["data"]["node"]["headRefOid"] = json!("new");
    assert!(parse_feedback(&result, &local(), &selected())
        .unwrap_err()
        .message
        .contains("changed"));
    let result = feedback(vec![json!({"__typename":"Unknown"})], vec![]);
    assert!(parse_feedback(&result, &local(), &selected()).is_err());
    let result = feedback(vec![check("id", "COMPLETED", Value::Null, "t")], vec![]);
    assert!(parse_feedback(&result, &local(), &selected()).is_err());
    let result = feedback(vec![], vec![]);
    let moved = LocalBranch {
        head: "other".into(),
        ..local()
    };
    assert!(parse_feedback(&result, &moved, &selected()).is_err());
}

/// The webview hides the card for a missing gh and shows every other
/// failure, by `ghMissing` alone.
#[test]
fn only_a_missing_gh_is_marked_gh_missing() {
    let dir = crate::test_support::TempDir::new("pr-automation", "gh-missing");
    let folder = dir.path().join("not-a-repo");
    std::fs::create_dir_all(&folder).unwrap();
    let err = snapshot_in(&[], &folder).unwrap_err();
    assert!(err.gh_missing && !err.retryable, "{err:?}");
    assert_eq!(serde_json::to_value(&err).unwrap()["ghMissing"], true);
    let bin = dir.path().join("bin");
    crate::test_support::executable(&bin.join(format!("gh{}", std::env::consts::EXE_SUFFIX)), "");
    // gh is found; the folder is no Git checkout, so no gh run happens.
    let err = snapshot_in(&[bin], &folder).unwrap_err();
    assert!(!err.gh_missing, "{err:?}");
    assert_eq!(serde_json::to_value(&err).unwrap()["ghMissing"], false);
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
