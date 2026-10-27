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
        "isFork":false, "nameWithOwner":"alice/project", "parent":null,
        "pullRequests":{"pageInfo":{"hasNextPage":false},"nodes":[]},
        "ref":{"target":{"oid":"abc"}},
        "object":{"oid":"abc","associatedPullRequests":{"pageInfo":{"hasNextPage":truncated},"nodes":prs}}
    }}})
}
fn pr(id: &str, owner: &str) -> Value {
    json!({"id":id,"state":"OPEN","headRefOid":"abc","headRefName":"topic","headRepository":{"nameWithOwner":owner},"repository":{"nameWithOwner":"alice/project"}})
}
fn selected(state: PrState) -> discovery::SelectedPr {
    discovery::SelectedPr {
        id: "detail".into(),
        state,
        repository: "upstream/project".into(),
    }
}
fn feedback(contexts: Vec<Value>, threads: Vec<Value>) -> Value {
    json!({"data":{
        "node":{"id":"detail","number":12,"url":"https://github.com/upstream/project/pull/12","title":"Improve project","repository":{"nameWithOwner":"upstream/project"},"additions":42,"deletions":3,"isDraft":true,"state":"OPEN","headRefOid":"abc","headRefName":"topic","headRepository":{"nameWithOwner":"alice/project"},"reviewThreads":{"pageInfo":{"hasNextPage":false},"nodes":threads},
            "commits":{"nodes":[{"commit":{"oid":"abc","statusCheckRollup":{"state":"SUCCESS","contexts":{"pageInfo":{"hasNextPage":false},"nodes":contexts}}}}]}}
    }})
}
fn check(id: &str, status: &str, conclusion: Value, started: &str) -> Value {
    json!({"__typename":"CheckRun","id":id,"name":"test","status":status,"conclusion":conclusion,"detailsUrl":null,"startedAt":started,"completedAt":"2026-01-02T00:00:00Z"})
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
    let found = select_pr(&result, &local()).unwrap().unwrap();
    assert_eq!(found.id, "match");
    assert_eq!(found.state, PrState::Open);
    assert!(
        select_pr(&find(vec![pr("foreign", "bob/project")], false), &local())
            .unwrap()
            .is_none()
    );
    assert!(select_pr(
        &find(
            vec![pr("a", "alice/project"), pr("b", "alice/project")],
            false
        ),
        &local()
    )
    .is_err());
    assert!(select_pr(&find(vec![], true), &local())
        .unwrap_err()
        .contains("limit"));
    assert!(select_pr(&json!({"data":{"repository":null}}), &local()).is_err());
}

#[test]
fn direct_fork_parent_results_cover_default_branch_and_deduplicate() {
    let mut candidate = pr("match", "alice/project");
    candidate["repository"]["nameWithOwner"] = json!("upstream/project");
    // Both independent GraphQL connections must own the same PR fixture.
    let mut result = find(vec![candidate.clone()], false);
    result["data"]["repository"]["isFork"] = json!(true);
    result["data"]["repository"]["parent"] = json!({
        "nameWithOwner":"upstream/project",
        "pullRequests":{"pageInfo":{"hasNextPage":false},"nodes":[candidate]}
    });
    let found = select_pr(&result, &local()).unwrap().unwrap();
    assert_eq!(found.id, "match");
    assert_eq!(found.repository, "upstream/project");
    result["data"]["repository"]["object"]["associatedPullRequests"]["nodes"] = json!([]);
    assert_eq!(select_pr(&result, &local()).unwrap().unwrap().id, "match");
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
        "nameWithOwner":"upstream/project",
        "pullRequests":{"pageInfo":{"hasNextPage":false},"nodes":[]}
    });
    assert!(select_pr(&result, &local())
        .unwrap_err()
        .contains("other forks"));
}

#[test]
fn deleted_ref_still_selects_unique_terminal_fork_pr() {
    for (state, expected) in [("CLOSED", PrState::Closed), ("MERGED", PrState::Merged)] {
        let mut completed = pr("finished", "alice/project");
        completed["state"] = json!(state);
        completed["repository"]["nameWithOwner"] = json!("upstream/project");
        let mut result = find(vec![completed], false);
        result["data"]["repository"]["ref"] = Value::Null;
        result["data"]["repository"]["isFork"] = json!(true);
        result["data"]["repository"]["parent"] = json!({
            "nameWithOwner":"upstream/project",
            "pullRequests":{"pageInfo":{"hasNextPage":false},"nodes":[]}
        });
        let found = select_pr(&result, &local()).unwrap().unwrap();
        assert_eq!((found.id.as_str(), found.state), ("finished", expected));
        let mut detail = feedback(vec![], vec![thread("review", false, false)]);
        detail["data"]["node"]["id"] = json!("finished");
        detail["data"]["node"]["state"] = json!(state);
        let snapshot = parse_feedback(&detail, &local(), &found).unwrap();
        let wire = serde_json::to_value(snapshot).unwrap();
        assert_eq!(wire["state"], state);
        assert_eq!(wire["head"], "abc");
        result["data"]["repository"]["object"]["associatedPullRequests"]["nodes"][0]
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
fn missing_refs_require_exact_unique_terminal_identity() {
    let mut result = find(vec![], false);
    result["data"]["repository"]["ref"] = Value::Null;
    assert!(select_pr(&result, &local()).is_err());

    let mut open = pr("open", "alice/project");
    result["data"]["repository"]["pullRequests"]["nodes"] = json!([open]);
    assert!(select_pr(&result, &local()).is_err());

    open["state"] = json!("MERGED");
    open["headRefOid"] = json!("old");
    result["data"]["repository"]["pullRequests"]["nodes"] = json!([open]);
    assert!(select_pr(&result, &local()).is_err());

    open["headRefOid"] = json!("abc");
    open["headRepository"]["nameWithOwner"] = json!("another/project");
    result["data"]["repository"]["pullRequests"]["nodes"] = json!([open]);
    assert!(select_pr(&result, &local()).is_err());

    open["headRepository"]["nameWithOwner"] = json!("alice/project");
    open["headRefName"] = json!("other");
    result["data"]["repository"]["pullRequests"]["nodes"] = json!([open]);
    assert!(select_pr(&result, &local()).is_err());

    open["headRefName"] = json!("topic");
    result["data"]["repository"]["pullRequests"]["nodes"] = json!([open]);
    let found = select_pr(&result, &local()).unwrap().unwrap();
    assert_eq!((found.id.as_str(), found.state), ("open", PrState::Merged));
}

#[test]
fn reused_branches_do_not_resurrect_a_historical_pr() {
    let mut previous = pr("previous", "alice/project");
    previous["state"] = json!("MERGED");
    let current = pr("current", "alice/project");
    // The following branch-reuse scenarios mutate current and retain previous.
    let result = find(vec![previous.clone(), current.clone()], false);
    assert_eq!(select_pr(&result, &local()).unwrap().unwrap().id, "current");

    let mut updated = current;
    updated["headRefOid"] = json!("new");
    // The next scenario still needs the original completed PR.
    let result = find(vec![previous.clone(), updated], false);
    assert!(select_pr(&result, &local()).is_err());

    let mut result = find(vec![previous], false);
    result["data"]["repository"]["ref"]["target"]["oid"] = json!("new");
    assert!(select_pr(&result, &local()).is_err());
}

#[test]
fn terminal_ambiguity_and_truncated_discovery_are_errors() {
    let mut merged = pr("merged", "alice/project");
    merged["state"] = json!("MERGED");
    let mut closed = pr("closed", "alice/project");
    closed["state"] = json!("CLOSED");
    // Reuse the merged candidate below with a different incomplete connection.
    let mut result = find(vec![merged.clone(), closed], false);
    result["data"]["repository"]["ref"] = Value::Null;
    assert!(select_pr(&result, &local()).is_err());

    let mut result = find(vec![merged], false);
    result["data"]["repository"]["pullRequests"]["pageInfo"]["hasNextPage"] = json!(true);
    assert!(select_pr(&result, &local()).unwrap_err().contains("limit"));

    let mut result = find(vec![], false);
    result["data"]["repository"]["object"]["associatedPullRequests"]["nodes"] =
        json!(vec![pr("p", "alice/project"); 101]);
    assert!(select_pr(&result, &local()).is_err());
}

#[test]
fn associated_pr_targeting_another_fork_is_not_supported() {
    let mut sibling_pr = pr("sibling", "alice/project");
    sibling_pr["repository"]["nameWithOwner"] = json!("sibling/project");
    let mut result = find(vec![sibling_pr], false);
    result["data"]["repository"]["isFork"] = json!(true);
    result["data"]["repository"]["parent"] = json!({
        "nameWithOwner":"upstream/project",
        "pullRequests":{"pageInfo":{"hasNextPage":false},"nodes":[]}
    });
    assert!(select_pr(&result, &local()).is_err());
}

#[test]
fn complete_nonfork_lookup_without_matching_pr_is_normal() {
    let result = find(vec![], false);
    assert!(select_pr(&result, &local()).unwrap().is_none());
}

#[test]
fn changed_or_malformed_discovery_cannot_select_an_arbitrary_pr() {
    let mut candidate = pr("p", "alice/project");
    // The second connection must report a different state for this same PR id.
    let mut result = find(vec![candidate.clone()], false);
    candidate["state"] = json!("MERGED");
    result["data"]["repository"]["pullRequests"]["nodes"] = json!([candidate]);
    assert!(select_pr(&result, &local()).is_err());

    let mut result = find(vec![pr("p", "alice/project")], false);
    result["data"]["repository"]["object"]["oid"] = json!("other");
    assert!(select_pr(&result, &local()).is_err());
    let mut result = find(vec![pr("p", "alice/project")], false);
    result["data"]["repository"]["object"] = Value::Null;
    assert!(select_pr(&result, &local()).is_err());

    let mut unrelated = pr("p", "other/project");
    unrelated["state"] = json!("UNKNOWN");
    let result = find(vec![unrelated], false);
    assert!(select_pr(&result, &local()).is_err());

    let mut result = find(vec![], false);
    result["data"]["repository"]["pullRequests"]["pageInfo"]["hasNextPage"] = Value::Null;
    assert!(select_pr(&result, &local()).is_err());
}

#[test]
fn local_identity_is_revalidated_after_success_none_and_read_errors() {
    for outcome in 0..3 {
        let read = || match outcome {
            0 => Ok(Some("snapshot")),
            1 => Ok(None),
            _ => Err("GitHub read failed".into()),
        };
        let original = local();
        assert_eq!(
            with_local_revalidation(&original, read, || Ok(local())),
            read()
        );
        for component in ["branch", "head", "remote_ref", "owner", "repo"] {
            let mut changed = local();
            match component {
                "branch" => changed.branch = "new".into(),
                "head" => changed.head = "new".into(),
                "remote_ref" => changed.remote_ref = "refs/heads/new".into(),
                "owner" => changed.owner = "new".into(),
                "repo" => changed.repo = "new".into(),
                _ => unreachable!(),
            }
            let err = with_local_revalidation(&original, read, || Ok(changed)).unwrap_err();
            assert!(err.contains("changed"), "{component}: {err}");
        }
        let err = with_local_revalidation(&original, read, || {
            Err("cannot reread local checkout".into())
        })
        .unwrap_err();
        assert!(err.contains("cannot reread"));
    }
}

#[test]
fn revalidation_observes_real_checkout_branch_head_and_upstream_changes() {
    let Some(repo) = crate::git_browser::fixture::init("pr-lifecycle-race") else {
        return;
    };
    repo.commit("initial", 1_700_000_000);
    repo.git(&[
        "remote",
        "add",
        "origin",
        "https://github.com/alice/project.git",
    ]);
    repo.git(&["config", "branch.main.remote", "origin"]);
    repo.git(&["config", "branch.main.merge", "refs/heads/topic"]);

    let original = local_branch(repo.path()).unwrap();
    let error = with_local_revalidation(
        &original,
        || {
            repo.git(&["switch", "-q", "-c", "next"]);
            repo.git(&["config", "branch.next.remote", "origin"]);
            repo.git(&["config", "branch.next.merge", "refs/heads/topic"]);
            Ok(())
        },
        || local_branch(repo.path()),
    )
    .unwrap_err();
    assert!(error.contains("changed"));

    let original = local_branch(repo.path()).unwrap();
    let error = with_local_revalidation(
        &original,
        || {
            repo.commit("advance", 1_700_000_001);
            Ok(())
        },
        || local_branch(repo.path()),
    )
    .unwrap_err();
    assert!(error.contains("changed"));

    let original = local_branch(repo.path()).unwrap();
    let error = with_local_revalidation(
        &original,
        || {
            repo.git(&["config", "branch.next.merge", "refs/heads/reused"]);
            Ok(())
        },
        || local_branch(repo.path()),
    )
    .unwrap_err();
    assert!(error.contains("changed"));
}

#[test]
fn terminal_transition_is_visible_but_reopen_requires_fresh_open_discovery() {
    for (state, expected) in [("MERGED", PrState::Merged), ("CLOSED", PrState::Closed)] {
        let mut detail = feedback(vec![], vec![thread("review", false, false)]);
        detail["data"]["node"]["state"] = json!(state);
        let snapshot = parse_feedback(&detail, &local(), &selected(PrState::Open)).unwrap();
        assert_eq!(snapshot.state, expected);
        assert_eq!(snapshot.threads.len(), 1);
        assert_eq!(serde_json::to_value(snapshot).unwrap()["state"], state);
        assert!(parse_feedback(&detail, &local(), &selected(expected)).is_ok());

        detail["data"]["node"]["state"] = json!("OPEN");
        assert!(parse_feedback(&detail, &local(), &selected(expected)).is_err());
        assert_eq!(
            parse_feedback(&detail, &local(), &selected(PrState::Open))
                .unwrap()
                .state,
            PrState::Open
        );
    }
}

#[test]
fn reopened_pr_is_actionable_only_after_live_ref_is_rediscovered() {
    let mut candidate = pr("detail", "alice/project");
    candidate["state"] = json!("CLOSED");
    // Retain the candidate so the detail lookup can simulate reopening it.
    let mut discovery = find(vec![candidate.clone()], false);
    discovery["data"]["repository"]["ref"] = Value::Null;
    let closed = select_pr(&discovery, &local()).unwrap().unwrap();

    let mut detail = feedback(vec![], vec![]);
    detail["data"]["node"]["repository"]["nameWithOwner"] = json!("alice/project");
    assert!(parse_feedback(&detail, &local(), &closed).is_err());

    candidate["state"] = json!("OPEN");
    discovery["data"]["repository"]["object"]["associatedPullRequests"]["nodes"] =
        json!([candidate]);
    assert!(select_pr(&discovery, &local()).is_err());
    discovery["data"]["repository"]["ref"] = json!({"target":{"oid":"abc"}});
    let reopened = select_pr(&discovery, &local()).unwrap().unwrap();
    assert_eq!(reopened.state, PrState::Open);
    assert_eq!(
        parse_feedback(&detail, &local(), &reopened).unwrap().state,
        PrState::Open
    );
}

#[test]
fn detail_identity_must_still_match_the_selected_pr() {
    for (key, value) in [
        ("id", json!("different")),
        ("headRefOid", json!("different")),
        ("headRefName", json!("different")),
        ("headRepository", json!({"nameWithOwner":"other/project"})),
        ("headRepository", Value::Null),
        ("repository", json!({"nameWithOwner":"other/project"})),
        ("state", json!("REOPENED")),
        ("state", Value::Null),
    ] {
        let mut detail = feedback(vec![], vec![]);
        detail["data"]["node"][key] = value;
        assert!(
            parse_feedback(&detail, &local(), &selected(PrState::Open)).is_err(),
            "changed or malformed {key}"
        );
    }
}

#[test]
fn check_rollup_distinguishes_none_pending_success_failure_and_unknown() {
    let mut no_rollup = feedback(vec![], vec![]);
    no_rollup["data"]["node"]["commits"]["nodes"][0]["commit"]["statusCheckRollup"] = Value::Null;
    let snapshot = parse_feedback(&no_rollup, &local(), &selected(PrState::Open)).unwrap();
    assert_eq!(snapshot.checks_state, ChecksState::None);
    assert!(snapshot.failed_checks.is_empty());
    assert_eq!(
        serde_json::to_value(snapshot).unwrap()["checksState"],
        "none"
    );

    for (rollup, expected, wire) in [
        ("PENDING", ChecksState::Pending, "pending"),
        ("SUCCESS", ChecksState::Success, "success"),
        ("FAILURE", ChecksState::Failure, "failure"),
        ("ERROR", ChecksState::Failure, "failure"),
        ("EXPECTED", ChecksState::Unknown, "unknown"),
    ] {
        let mut detail = feedback(vec![], vec![]);
        detail["data"]["node"]["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["state"] =
            json!(rollup);
        let snapshot = parse_feedback(&detail, &local(), &selected(PrState::Open)).unwrap();
        assert_eq!(snapshot.checks_state, expected, "{rollup}");
        assert!(snapshot.failed_checks.is_empty());
        assert_eq!(serde_json::to_value(snapshot).unwrap()["checksState"], wire);
    }

    let pending = check("pending", "IN_PROGRESS", Value::Null, "t");
    let mut detail = feedback(vec![pending], vec![]);
    detail["data"]["node"]["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["state"] =
        json!("PENDING");
    let snapshot = parse_feedback(&detail, &local(), &selected(PrState::Open)).unwrap();
    assert_eq!(snapshot.checks_state, ChecksState::Pending);
    assert!(snapshot.failed_checks.is_empty());
}

#[test]
fn pending_rollup_with_a_failed_check_keeps_failure_visible() {
    let mut detail = feedback(
        vec![
            check("failed", "COMPLETED", json!("FAILURE"), "t1"),
            check("pending", "QUEUED", Value::Null, "t2"),
        ],
        vec![],
    );
    detail["data"]["node"]["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["state"] =
        json!("PENDING");
    let snapshot = parse_feedback(&detail, &local(), &selected(PrState::Open)).unwrap();
    assert!(snapshot.is_draft);
    assert_eq!(snapshot.checks_state, ChecksState::Failure);
    assert_eq!(snapshot.failed_checks.len(), 1);
}

#[test]
fn malformed_check_enums_are_not_described_as_success() {
    for invalid in [
        json!("UNKNOWN"),
        json!(""),
        json!(null),
        json!(false),
        json!(42),
    ] {
        let mut detail = feedback(vec![], vec![]);
        detail["data"]["node"]["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["state"] =
            invalid;
        assert!(parse_feedback(&detail, &local(), &selected(PrState::Open)).is_err());
    }
    let mut detail = feedback(vec![], vec![]);
    detail["data"]["node"]["commits"]["nodes"][0]["commit"]["statusCheckRollup"]
        .as_object_mut()
        .unwrap()
        .remove("state");
    assert!(parse_feedback(&detail, &local(), &selected(PrState::Open)).is_err());

    for run in [
        check("run", "UNKNOWN", Value::Null, "t"),
        check("run", "COMPLETED", json!("UNSUPPORTED"), "t"),
        json!({"__typename":"StatusContext","id":"legacy","context":"ci","state":"UNKNOWN","targetUrl":null,"createdAt":"t"}),
    ] {
        let detail = feedback(vec![run], vec![]);
        assert!(parse_feedback(&detail, &local(), &selected(PrState::Open)).is_err());
    }
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
    let mut result = feedback(
        checks,
        vec![
            thread("open", false, false),
            thread("resolved", true, false),
            thread("outdated", false, true),
        ],
    );
    result["data"]["node"]["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["state"] =
        json!("FAILURE");
    let snapshot = parse_feedback(&result, &local(), &selected(PrState::Open)).unwrap();
    assert_eq!(snapshot.number, 12);
    assert_eq!(snapshot.title, "Improve project");
    assert_eq!(snapshot.repository, "upstream/project");
    assert_eq!(snapshot.additions, 42);
    assert_eq!(snapshot.deletions, 3);
    assert!(snapshot.is_draft);
    assert_eq!(snapshot.state, PrState::Open);
    assert_eq!(snapshot.checks_state, ChecksState::Failure);
    assert_eq!(snapshot.branch, "local");
    assert_eq!(snapshot.failed_checks.len(), 5);
    assert_eq!(
        snapshot.failed_checks[0].id,
        "failed:t1:2026-01-02T00:00:00Z"
    );
    assert_eq!(snapshot.failed_checks[0].url, snapshot.url);
    assert_eq!(snapshot.failed_checks[4].id, "legacy:t3");
    assert_eq!(snapshot.threads.len(), 1);
    assert_eq!(snapshot.threads[0].id, "open");
    assert_eq!(snapshot.threads[0].updated_at, "2026-01-02T00:00:00Z");
    let wire = serde_json::to_value(snapshot).unwrap();
    assert!(wire.get("failedChecks").is_some());
    assert_eq!(wire["isDraft"], true);
    assert_eq!(wire["state"], "OPEN");
    assert_eq!(wire["checksState"], "failure");
    assert_eq!(wire["repository"], "upstream/project");
    assert!(wire["threads"][0].get("updatedAt").is_some());
}

#[test]
fn requires_valid_display_metadata() {
    for key in ["title", "repository", "additions", "deletions", "isDraft"] {
        let mut result = feedback(vec![], vec![]);
        result["data"]["node"].as_object_mut().unwrap().remove(key);
        assert!(
            parse_feedback(&result, &local(), &selected(PrState::Open)).is_err(),
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
            parse_feedback(&result, &local(), &selected(PrState::Open)).is_err(),
            "invalid {key}"
        );
    }
    let mut result = feedback(vec![], vec![]);
    result["data"]["node"]["additions"] = json!(0);
    result["data"]["node"]["deletions"] = json!(0);
    result["data"]["node"]["isDraft"] = json!(false);
    let snapshot = parse_feedback(&result, &local(), &selected(PrState::Open)).unwrap();
    assert_eq!(
        (snapshot.additions, snapshot.deletions, snapshot.is_draft),
        (0, 0, false)
    );
}

#[test]
fn new_attempts_produce_new_ids() {
    let first = failed_check(
        &check("run", "COMPLETED", json!("FAILURE"), "first"),
        "fallback",
    )
    .unwrap()
    .unwrap();
    let second = failed_check(
        &check("run", "COMPLETED", json!("FAILURE"), "second"),
        "fallback",
    )
    .unwrap()
    .unwrap();
    assert_ne!(first.id, second.id);
}

#[test]
fn startup_failure_with_nullable_timestamps_is_actionable() {
    let mut run = check("startup", "COMPLETED", json!("STARTUP_FAILURE"), "unused");
    run["startedAt"] = Value::Null;
    run["completedAt"] = Value::Null;
    let result = failed_check(&run, "fallback").unwrap().unwrap();
    assert_eq!(result.id, "startup::");
    run["startedAt"] = json!(42);
    assert!(failed_check(&run, "fallback").is_err());
}

#[test]
fn rejects_truncated_malformed_or_changed_data() {
    let mut result = feedback(vec![], vec![]);
    result["data"]["node"]["reviewThreads"]["pageInfo"]["hasNextPage"] = json!(true);
    assert!(parse_feedback(&result, &local(), &selected(PrState::Open))
        .unwrap_err()
        .contains("limit"));
    let mut result = feedback(vec![], vec![]);
    result["data"]["node"]["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]
        ["pageInfo"]["hasNextPage"] = json!(true);
    assert!(parse_feedback(&result, &local(), &selected(PrState::Open))
        .unwrap_err()
        .contains("limit"));
    let mut result = feedback(vec![], vec![thread("t", false, false)]);
    result["data"]["node"]["reviewThreads"]["nodes"][0]["comments"]["nodes"] = json!([]);
    assert!(parse_feedback(&result, &local(), &selected(PrState::Open)).is_err());
    let mut result = feedback(vec![], vec![]);
    result["data"]["node"]["headRefOid"] = json!("new");
    assert!(parse_feedback(&result, &local(), &selected(PrState::Open))
        .unwrap_err()
        .contains("changed"));
    let result = feedback(vec![json!({"__typename":"Unknown"})], vec![]);
    assert!(parse_feedback(&result, &local(), &selected(PrState::Open)).is_err());
    let result = feedback(vec![check("id", "COMPLETED", Value::Null, "t")], vec![]);
    assert!(parse_feedback(&result, &local(), &selected(PrState::Open)).is_err());
    let mut result = feedback(vec![], vec![]);
    result["data"]["node"]["commits"]["nodes"][0]["commit"]["oid"] = json!("other");
    assert!(parse_feedback(&result, &local(), &selected(PrState::Open)).is_err());
}

#[test]
fn feedback_requires_exactly_the_latest_matching_commit() {
    let mut detail = feedback(
        vec![check("current", "COMPLETED", json!("SUCCESS"), "t")],
        vec![],
    );
    let snapshot = parse_feedback(&detail, &local(), &selected(PrState::Open)).unwrap();
    assert_eq!(snapshot.checks_state, ChecksState::Success);
    assert!(snapshot.failed_checks.is_empty());

    let commits = &mut detail["data"]["node"]["commits"]["nodes"];
    let current = commits.as_array_mut().unwrap().remove(0);
    assert!(parse_feedback(&detail, &local(), &selected(PrState::Open)).is_err());

    detail["data"]["node"]["commits"]["nodes"] =
        json!([{"commit":{"oid":"old","statusCheckRollup":null}}, current]);
    assert!(parse_feedback(&detail, &local(), &selected(PrState::Open)).is_err());
}

/// Run explicitly with `OMP_PR_AUTOMATION_SMOKE_PROJECT` set to a local
/// checkout. Optionally require a lifecycle with
/// `OMP_PR_AUTOMATION_SMOKE_EXPECT_STATE=OPEN|MERGED|CLOSED` and a deleted
/// remote ref with `OMP_PR_AUTOMATION_SMOKE_EXPECT_DELETED_REF=1`.
/// This only reads Git metadata and queries GitHub via `gh`.
#[test]
#[ignore = "requires an authenticated gh and a GitHub.com checkout"]
fn live_read_only_snapshot() {
    let folder = std::env::var_os("OMP_PR_AUTOMATION_SMOKE_PROJECT")
        .expect("set OMP_PR_AUTOMATION_SMOKE_PROJECT to a checkout");
    let path = Path::new(&folder);
    let local = local_branch(path).expect("local branch");
    eprintln!("local: {local:?}");
    let result = snapshot(path).expect("GitHub snapshot");
    if let Ok(expected) = std::env::var("OMP_PR_AUTOMATION_SMOKE_EXPECT_STATE") {
        assert!(matches!(expected.as_str(), "OPEN" | "MERGED" | "CLOSED"));
        let actual = serde_json::to_value(result.as_ref().expect("expected a PR")).unwrap();
        assert_eq!(actual["state"], expected);
    }
    if std::env::var("OMP_PR_AUTOMATION_SMOKE_EXPECT_DELETED_REF")
        .ok()
        .as_deref()
        == Some("1")
    {
        let branch = local.remote_ref.strip_prefix("refs/heads/").unwrap();
        let response = gh::Gh::locate()
            .expect("locate gh")
            .query(
                FIND_QUERY,
                &[
                    ("owner", &local.owner),
                    ("repo", &local.repo),
                    ("ref", &local.remote_ref),
                    ("branch", branch),
                    ("head", &local.head),
                ],
            )
            .expect("read upstream ref");
        assert!(
            response
                .pointer("/data/repository/ref")
                .expect("upstream ref field")
                .is_null(),
            "expected the remote branch ref to be deleted"
        );
    }
    eprintln!("snapshot: {result:?}");
}
