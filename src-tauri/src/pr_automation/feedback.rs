//! Fail-closed normalization of GitHub GraphQL and REST responses.
use super::git::valid_component;
use super::{
    CheckState, CiCheck, FailedCheck, LocalBranch, LookupError, PrAutomationSnapshot, ReviewThread,
};
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
/// A GitHub-resolved `owner/name`, checked to be safe in an API path.
fn resolved_repo(v: &Value) -> Result<&str, String> {
    let name = string(v, "nameWithOwner")?;
    match name.split_once('/') {
        Some((owner, repo)) if valid_component(owner) && valid_component(repo) => Ok(name),
        _ => Err("GitHub returned an invalid repository name".into()),
    }
}
fn upstream_branch(local: &LocalBranch) -> &str {
    local.remote_ref.strip_prefix("refs/heads/").unwrap_or("")
}

/// The PR [`select_pr`] found, what `FEEDBACK_QUERY` loads and is checked
/// against.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct SelectedPr {
    /// GraphQL `id` or REST `node_id`; `node(id:)` takes either.
    pub(super) id: String,
    pub(super) head: String,
    /// The head repository's `owner/name` as GitHub resolved it, so a
    /// remote still using a renamed repository's old URL matches.
    pub(super) repository: String,
}

/// A PR from either API, normalized.
struct Candidate<'a> {
    /// GitHub's canonical web URL, the same from both APIs (ids are not).
    url: &'a str,
    id: &'a str,
    /// `false`: closed or merged.
    open: bool,
    branch: &'a str,
    head: &'a str,
    /// `None` once the head repository is deleted.
    repository: Option<&'a str>,
}

fn graphql_candidate(v: &Value) -> Result<Candidate<'_>, String> {
    let open = match string(v, "state")? {
        "OPEN" => true,
        "CLOSED" | "MERGED" => false,
        _ => return Err("GitHub returned an unknown PR state".into()),
    };
    let repo = field(v, "headRepository")?;
    Ok(Candidate {
        url: string(v, "url")?,
        id: string(v, "id")?,
        open,
        branch: string(v, "headRefName")?,
        head: string(v, "headRefOid")?,
        repository: if repo.is_null() {
            None
        } else {
            Some(string(repo, "nameWithOwner")?)
        },
    })
}

fn rest_candidate(v: &Value) -> Result<Candidate<'_>, String> {
    let open = match string(v, "state")? {
        "open" => true,
        "closed" => false,
        _ => return Err("GitHub returned an unknown PR state".into()),
    };
    let head = field(v, "head")?;
    let repo = field(head, "repo")?;
    Ok(Candidate {
        url: string(v, "html_url")?,
        id: string(v, "node_id")?,
        open,
        branch: string(head, "ref")?,
        head: string(head, "sha")?,
        repository: if repo.is_null() {
            None
        } else {
            Some(string(repo, "full_name")?)
        },
    })
}

/// A REST page of up to 100 items; a full page may have a next one, so it
/// is rejected like a truncated GraphQL connection.
fn rest_list<'a>(v: &'a Value, name: &str) -> Result<&'a Vec<Value>, String> {
    let items = v
        .as_array()
        .ok_or_else(|| format!("GitHub response has invalid {name}"))?;
    if items.len() >= 100 {
        return Err(format!(
            "GitHub {name} exceeds the 100-item limit; auto-fix paused"
        ));
    }
    Ok(items)
}

/// The open PR for the upstream branch, `None` when there is none.
/// `open_prs(repository, head)` lists the open PRs into `repository` from
/// `head` (`owner:branch`); it runs for the resolved repository and, for a
/// fork, its parent.
pub(super) fn select_pr(
    result: &Value,
    local: &LocalBranch,
    mut open_prs: impl FnMut(&str, &str) -> Result<Value, String>,
) -> Result<Option<SelectedPr>, LookupError> {
    let data = field(result, "data")?;
    let repo = field(data, "repository")?;
    if repo.is_null() {
        return Err("GitHub repository was not found or is inaccessible"
            .to_string()
            .into());
    }
    let name = resolved_repo(repo)?;
    let reference = field(repo, "ref")?;
    if reference.is_null() {
        return Err("Upstream branch was not found on GitHub".to_string().into());
    }
    let target = field(reference, "target")?;
    let head = string(target, "oid")?;
    if head != local.head {
        return Err(
            "Local HEAD differs from the upstream branch on GitHub; synchronize before auto-fix"
                .to_string()
                .into(),
        );
    }
    let associated = connection(
        field(target, "associatedPullRequests")?,
        "associated pull requests",
    )?;
    let is_fork = boolean(repo, "isFork")?;
    let parent = field(repo, "parent")?;
    if is_fork && parent.is_null() {
        return Err(
            "GitHub fork parent is unavailable; cannot safely select a PR"
                .to_string()
                .into(),
        );
    }
    let branch = upstream_branch(local);
    let owner = name.split_once('/').map_or(name, |(owner, _)| owner);
    let filter = format!("{owner}:{branch}");
    let in_repo = open_prs(name, &filter)?;
    let in_parent = if parent.is_null() {
        None
    } else {
        Some(open_prs(resolved_repo(parent)?, &filter)?)
    };
    let in_parent = in_parent
        .as_ref()
        .map(|v| rest_list(v, "parent pull requests"))
        .transpose()?;
    let candidates = associated.iter().map(graphql_candidate).chain(
        rest_list(&in_repo, "repository pull requests")?
            .iter()
            .chain(in_parent.into_iter().flatten())
            .map(rest_candidate),
    );
    let mut selected: Option<Candidate> = None;
    let mut completed = false;
    for pr in candidates {
        let pr = pr?;
        if pr.branch != branch || pr.repository.is_none_or(|r| !r.eq_ignore_ascii_case(name)) {
            continue;
        }
        if !pr.open {
            completed |= pr.head == head;
            continue;
        }
        if pr.head != head {
            return Err(LookupError::transient(
                "PR head differs from the upstream branch; retry after GitHub updates",
            ));
        }
        match &selected {
            // The same PR from another source: GraphQL and REST ids differ.
            Some(previous) if previous.url.eq_ignore_ascii_case(pr.url) => {}
            Some(_) => {
                return Err(
                    "Multiple open PRs match this upstream branch; auto-fix paused"
                        .to_string()
                        .into(),
                )
            }
            None => selected = Some(pr),
        }
    }
    if selected.is_none() && !completed && is_fork {
        return Err("No PR found in the head repository or its parent; PRs targeting other forks cannot be ruled out".to_string().into());
    }
    Ok(selected.map(|pr| SelectedPr {
        id: pr.id.to_owned(),
        head: head.to_owned(),
        repository: name.to_owned(),
    }))
}

pub(super) fn parse_feedback(
    result: &Value,
    local: &LocalBranch,
    selected: &SelectedPr,
) -> Result<PrAutomationSnapshot, LookupError> {
    let head = selected.head.as_str();
    let data = field(result, "data")?;
    let pr = field(data, "node")?;
    let head_repo = field(pr, "headRepository")?;
    if string(pr, "state")? != "OPEN"
        || string(pr, "headRefOid")? != head
        || string(pr, "headRefName")? != upstream_branch(local)
        || head_repo.is_null()
        || !string(head_repo, "nameWithOwner")?.eq_ignore_ascii_case(&selected.repository)
    {
        return Err(LookupError::transient(
            "PR head or branch changed while loading feedback",
        ));
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
        return Err("GitHub did not return the latest PR commit"
            .to_string()
            .into());
    }
    let object = field(&commits[0], "commit")?;
    if string(object, "oid")? != head {
        return Err(LookupError::transient(
            "GitHub returned feedback for a different commit",
        ));
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
        threads.push(ReviewThread {
            id: string(thread, "id")?.to_owned(),
            updated_at: thread_updated_at(field(thread, "comments")?)?.to_owned(),
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

/// A thread's Auto-fix identity: when its newest comment not written by
/// the viewer (the signed-in gh user, whom Auto-fix replies as) was last
/// updated, or its first comment's when the viewer wrote them all.
fn thread_updated_at(comments: &Value) -> Result<&str, String> {
    if boolean(field(comments, "pageInfo")?, "hasPreviousPage")? {
        return Err(
            "GitHub review thread comments exceed the 100-item limit; auto-fix paused".into(),
        );
    }
    let nodes = field(comments, "nodes")?
        .as_array()
        .ok_or_else(|| "GitHub response has invalid thread comments".to_string())?;
    if nodes.len() > 100 {
        return Err("GitHub returned too many thread comments".into());
    }
    let mut newest_other = None;
    for comment in nodes {
        let updated = string(comment, "updatedAt")?;
        if !boolean(comment, "viewerDidAuthor")? {
            newest_other = Some(updated);
        }
    }
    match (newest_other, nodes.first()) {
        (Some(updated), _) => Ok(updated),
        (None, Some(first)) => string(first, "updatedAt"),
        (None, None) => Err("GitHub returned a review thread without comments".into()),
    }
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
