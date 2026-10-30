//! Fail-closed normalization of GitHub GraphQL feedback.
use super::{CheckState, CiCheck, FailedCheck, LocalBranch, PrAutomationSnapshot, ReviewThread};
use serde_json::Value;

fn field<'a>(v: &'a Value, key: &str) -> Result<&'a Value, String> {
    v.get(key)
        .ok_or_else(|| format!("GitHub response is missing {key}"))
}
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    field(v, key)?
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("GitHub response has invalid {key}"))
}
fn boolean(v: &Value, key: &str) -> Result<bool, String> {
    field(v, key)?
        .as_bool()
        .ok_or_else(|| format!("GitHub response has invalid {key}"))
}
fn unsigned(v: &Value, key: &str) -> Result<u64, String> {
    field(v, key)?
        .as_u64()
        .ok_or_else(|| format!("GitHub response has invalid {key}"))
}
fn connection<'a>(v: &'a Value, name: &str) -> Result<&'a Vec<Value>, String> {
    if boolean(field(v, "pageInfo")?, "hasNextPage")? {
        return Err(format!(
            "GitHub {name} exceeds the 100-item limit; auto-fix paused"
        ));
    }
    let nodes = field(v, "nodes")?
        .as_array()
        .ok_or_else(|| format!("GitHub response has invalid {name}"))?;
    if nodes.len() > 100 {
        return Err(format!("GitHub returned too many {name}"));
    }
    Ok(nodes)
}
fn optional_url(v: &Value, key: &str, fallback: &str) -> Result<String, String> {
    match field(v, key)? {
        Value::Null => Ok(fallback.to_owned()),
        // The serialized snapshot owns this URL; the response remains borrowed.
        Value::String(s) if !s.is_empty() => Ok(s.clone()),
        _ => Err(format!("GitHub response has invalid {key}")),
    }
}
fn same_repo(v: &Value, local: &LocalBranch) -> Result<bool, String> {
    let repo = field(v, "headRepository")?;
    if repo.is_null() {
        return Ok(false);
    }
    Ok(string(repo, "nameWithOwner")?
        .split_once('/')
        .is_some_and(|(owner, name)| {
            owner.eq_ignore_ascii_case(&local.owner) && name.eq_ignore_ascii_case(&local.repo)
        }))
}
fn upstream_branch(local: &LocalBranch) -> &str {
    local.remote_ref.strip_prefix("refs/heads/").unwrap_or("")
}

pub(super) fn select_pr(
    result: &Value,
    local: &LocalBranch,
) -> Result<Option<(String, String)>, String> {
    let data = field(result, "data")?;
    let repo = field(data, "repository")?;
    if repo.is_null() {
        return Err("GitHub repository was not found or is inaccessible".into());
    }
    let reference = field(repo, "ref")?;
    if reference.is_null() {
        return Err("Upstream branch was not found on GitHub".into());
    }
    let target = field(reference, "target")?;
    let head = string(target, "oid")?;
    if head != local.head {
        return Err(
            "Local HEAD differs from the upstream branch on GitHub; synchronize before auto-fix"
                .into(),
        );
    }
    let mut connections = [
        connection(
            field(target, "associatedPullRequests")?,
            "associated pull requests",
        )?
        .as_slice(),
        connection(field(repo, "pullRequests")?, "repository pull requests")?.as_slice(),
        &[],
    ];
    let parent = field(repo, "parent")?;
    if boolean(repo, "isFork")? && parent.is_null() {
        return Err("GitHub fork parent is unavailable; cannot safely select a PR".into());
    }
    if !parent.is_null() {
        connections[2] =
            connection(field(parent, "pullRequests")?, "parent pull requests")?.as_slice();
    }
    let mut selected: Option<&str> = None;
    let mut completed = false;
    for pr in connections.into_iter().flatten() {
        let state = string(pr, "state")?;
        let branch = string(pr, "headRefName")?;
        let pr_head = string(pr, "headRefOid")?;
        if matches!(state, "CLOSED" | "MERGED")
            && branch == upstream_branch(local)
            && pr_head == head
            && same_repo(pr, local)?
        {
            completed = true;
        }
        if state == "OPEN" && branch == upstream_branch(local) && same_repo(pr, local)? {
            if pr_head != head {
                return Err(
                    "PR head differs from the upstream branch; retry after GitHub updates".into(),
                );
            }
            let id = string(pr, "id")?;
            if selected.is_some_and(|previous| previous != id) {
                return Err("Multiple open PRs match this upstream branch; auto-fix paused".into());
            }
            selected = Some(id);
        }
    }
    if selected.is_none() && !completed && boolean(repo, "isFork")? {
        return Err("No PR found in the head repository or its parent; PRs targeting other forks cannot be ruled out".into());
    }
    Ok(selected.map(|id| (id.to_owned(), head.to_owned())))
}

pub(super) fn parse_feedback(
    result: &Value,
    local: &LocalBranch,
    head: &str,
) -> Result<PrAutomationSnapshot, String> {
    let data = field(result, "data")?;
    let pr = field(data, "node")?;
    if string(pr, "state")? != "OPEN"
        || string(pr, "headRefOid")? != head
        || string(pr, "headRefName")? != upstream_branch(local)
        || !same_repo(pr, local)?
    {
        return Err("PR head or branch changed while loading feedback".into());
    }
    let number = field(pr, "number")?
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or_else(|| "GitHub response has invalid PR number".to_string())?;
    let url = string(pr, "url")?.to_owned();
    let title = string(pr, "title")?.to_owned();
    let repository = string(field(pr, "repository")?, "nameWithOwner")?.to_owned();
    let additions = unsigned(pr, "additions")?;
    let deletions = unsigned(pr, "deletions")?;
    let is_draft = boolean(pr, "isDraft")?;
    let commits = field(field(pr, "commits")?, "nodes")?
        .as_array()
        .ok_or_else(|| "GitHub response has invalid PR commits".to_string())?;
    if commits.len() != 1 {
        return Err("GitHub did not return the latest PR commit".into());
    }
    let object = field(&commits[0], "commit")?;
    if string(object, "oid")? != head {
        return Err("GitHub returned feedback for a different commit".into());
    }
    let mut checks = Vec::new();
    let mut failed_checks = Vec::new();
    let rollup = field(object, "statusCheckRollup")?;
    if !rollup.is_null() {
        let contexts = connection(field(rollup, "contexts")?, "check contexts")?;
        checks.reserve_exact(contexts.len());
        for check in contexts {
            let parsed = parse_check(check, &url)?;
            checks.push(parsed.ci);
            failed_checks.extend(parsed.failed);
        }
    }
    let mut threads = Vec::new();
    for thread in connection(field(pr, "reviewThreads")?, "review threads")? {
        let resolved = boolean(thread, "isResolved")?;
        let outdated = boolean(thread, "isOutdated")?;
        if resolved || outdated {
            continue;
        }
        let id = string(thread, "id")?.to_owned();
        let comments = field(field(thread, "comments")?, "nodes")?
            .as_array()
            .ok_or_else(|| "GitHub response has invalid thread comments".to_string())?;
        if comments.len() != 1 {
            return Err("GitHub returned a review thread without its latest comment".into());
        }
        threads.push(ReviewThread {
            id,
            updated_at: string(&comments[0], "updatedAt")?.into(),
            url: string(&comments[0], "url")?.into(),
        });
    }
    Ok(PrAutomationSnapshot {
        number,
        url,
        title,
        repository,
        additions,
        deletions,
        is_draft,
        head: head.into(),
        // The snapshot owns its branch; local remains for the post-query race check.
        branch: local.branch.clone(),
        checks,
        failed_checks,
        threads,
    })
}

/// One check context of the head commit: what the card shows for it, and the
/// Auto-fix feedback item when it failed.
pub(super) struct ParsedCheck {
    pub(super) ci: CiCheck,
    pub(super) failed: Option<FailedCheck>,
}

pub(super) fn parse_check(v: &Value, pr_url: &str) -> Result<ParsedCheck, String> {
    match string(v, "__typename")? {
        "CheckRun" => {
            let status = string(v, "status")?;
            if !matches!(
                status,
                "COMPLETED" | "QUEUED" | "IN_PROGRESS" | "REQUESTED" | "WAITING" | "PENDING"
            ) {
                return Err("GitHub returned an unknown check status".into());
            }
            let conclusion = field(v, "conclusion")?;
            if !conclusion.is_null()
                && !conclusion.as_str().is_some_and(|s| {
                    matches!(
                        s,
                        "SUCCESS"
                            | "FAILURE"
                            | "NEUTRAL"
                            | "CANCELLED"
                            | "SKIPPED"
                            | "TIMED_OUT"
                            | "ACTION_REQUIRED"
                            | "STARTUP_FAILURE"
                            | "STALE"
                    )
                })
            {
                return Err("GitHub returned an unknown check conclusion".into());
            }
            let name = string(v, "name")?;
            let url = optional_url(v, "detailsUrl", pr_url)?;
            let state = match status {
                "IN_PROGRESS" => CheckState::Running,
                "COMPLETED" => match conclusion
                    .as_str()
                    .ok_or_else(|| "Completed GitHub check has no conclusion".to_string())?
                {
                    "SUCCESS" => CheckState::Success,
                    "FAILURE" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE" => {
                        CheckState::Failure
                    }
                    _ => CheckState::Neutral,
                },
                _ => CheckState::Queued,
            };
            let failed = if state == CheckState::Failure {
                let id = string(v, "id")?;
                // Both timestamps are nullable in GitHub's schema, including for
                // runs that fail before a runner starts.
                let started = optional_timestamp(v, "startedAt")?;
                let completed = optional_timestamp(v, "completedAt")?;
                Some(FailedCheck {
                    id: format!("{id}:{started}:{completed}"),
                })
            } else {
                None
            };
            Ok(ParsedCheck {
                ci: CiCheck {
                    name: name.into(),
                    state,
                    url,
                },
                failed,
            })
        }
        "StatusContext" => {
            let state = match string(v, "state")? {
                "SUCCESS" => CheckState::Success,
                "ERROR" | "FAILURE" => CheckState::Failure,
                // A commit status reports only that it is under way.
                "PENDING" => CheckState::Running,
                "EXPECTED" => CheckState::Queued,
                _ => return Err("GitHub returned an unknown status context state".into()),
            };
            let name = string(v, "context")?;
            let url = optional_url(v, "targetUrl", pr_url)?;
            let failed = if state == CheckState::Failure {
                Some(FailedCheck {
                    id: format!("{}:{}", string(v, "id")?, string(v, "createdAt")?),
                })
            } else {
                None
            };
            Ok(ParsedCheck {
                ci: CiCheck {
                    name: name.into(),
                    state,
                    url,
                },
                failed,
            })
        }
        _ => Err("GitHub returned an unknown check context type".into()),
    }
}

fn optional_timestamp<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    match field(v, key)? {
        Value::Null => Ok(""),
        Value::String(s) if !s.is_empty() => Ok(s),
        _ => Err(format!("GitHub response has invalid {key}")),
    }
}
