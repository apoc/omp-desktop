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
fn limit_error(name: &str) -> String {
    format!("GitHub {name} exceeds the 100-item limit; auto-fix paused")
}
/// A connection's nodes, rejected when `more` (`hasNextPage`, or
/// `hasPreviousPage` for a `last:` page) says some were cut off.
fn connection<'a>(v: &'a Value, name: &str, more: &str) -> Result<&'a Vec<Value>, String> {
    if boolean(field(v, "pageInfo")?, more)? {
        return Err(limit_error(name));
    }
    let nodes = field(v, "nodes")?
        .as_array()
        .ok_or_else(|| format!("GitHub response has invalid {name}"))?;
    if nodes.len() > 100 {
        return Err(format!("GitHub returned too many {name}"));
    }
    Ok(nodes)
}
/// A nullable string: `None` for null, never empty.
fn optional_str<'a>(v: &'a Value, key: &str) -> Result<Option<&'a str>, String> {
    match field(v, key)? {
        Value::Null => Ok(None),
        Value::String(s) if !s.is_empty() => Ok(Some(s)),
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
/// against (its head is the local HEAD, which `select_pr` requires).
#[derive(Debug, PartialEq, Eq)]
pub(super) struct SelectedPr {
    /// GraphQL `id` or REST `node_id`; `node(id:)` takes either.
    pub(super) id: String,
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

/// Where each API keeps a PR's fields.
struct Api {
    open: &'static str,
    closed: &'static [&'static str],
    url: &'static str,
    id: &'static str,
    /// The object holding the branch fields; `None`: the PR itself.
    head: Option<&'static str>,
    branch: &'static str,
    sha: &'static str,
    repo: &'static str,
    repo_name: &'static str,
}

const GRAPHQL: Api = Api {
    open: "OPEN",
    closed: &["CLOSED", "MERGED"],
    url: "url",
    id: "id",
    head: None,
    branch: "headRefName",
    sha: "headRefOid",
    repo: "headRepository",
    repo_name: "nameWithOwner",
};

const REST: Api = Api {
    open: "open",
    closed: &["closed"],
    url: "html_url",
    id: "node_id",
    head: Some("head"),
    branch: "ref",
    sha: "sha",
    repo: "repo",
    repo_name: "full_name",
};

fn candidate<'a>(v: &'a Value, api: &Api) -> Result<Candidate<'a>, String> {
    let state = string(v, "state")?;
    let open = if state == api.open {
        true
    } else if api.closed.contains(&state) {
        false
    } else {
        return Err("GitHub returned an unknown PR state".into());
    };
    let head = match api.head {
        Some(key) => field(v, key)?,
        None => v,
    };
    let repo = field(head, api.repo)?;
    Ok(Candidate {
        url: string(v, api.url)?,
        id: string(v, api.id)?,
        open,
        branch: string(head, api.branch)?,
        head: string(head, api.sha)?,
        repository: if repo.is_null() {
            None
        } else {
            Some(string(repo, api.repo_name)?)
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
        return Err(limit_error(name));
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
        "hasNextPage",
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
    let candidates = associated.iter().map(|v| candidate(v, &GRAPHQL)).chain(
        rest_list(&in_repo, "repository pull requests")?
            .iter()
            .chain(in_parent.into_iter().flatten())
            .map(|v| candidate(v, &REST)),
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
        repository: name.to_owned(),
    }))
}

pub(super) fn parse_feedback(
    result: &Value,
    local: &LocalBranch,
    selected: &SelectedPr,
) -> Result<PrAutomationSnapshot, LookupError> {
    let head = local.head.as_str();
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
        let contexts = connection(field(rollup, "contexts")?, "check contexts", "hasNextPage")?;
        checks.reserve_exact(contexts.len());
        for check in contexts {
            let parsed = parse_check(check, &url)?;
            checks.push(parsed.ci);
            failed_checks.extend(parsed.failed);
        }
    }
    let mut threads = Vec::new();
    for thread in connection(field(pr, "reviewThreads")?, "review threads", "hasNextPage")? {
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
    let nodes = connection(comments, "review thread comments", "hasPreviousPage")?;
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
    let (name, url, state, failed) = match string(v, "__typename")? {
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
            let name = string(v, "name")?;
            let url = optional_str(v, "detailsUrl")?;
            // Both timestamps are nullable in GitHub's schema, including for
            // runs that fail before a runner starts.
            let id = failure_id(state, || {
                Ok(format!(
                    "{}:{}:{}",
                    string(v, "id")?,
                    optional_str(v, "startedAt")?.unwrap_or_default(),
                    optional_str(v, "completedAt")?.unwrap_or_default(),
                ))
            })?;
            (name, url, state, id)
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
            let url = optional_str(v, "targetUrl")?;
            let id = failure_id(state, || {
                Ok(format!("{}:{}", string(v, "id")?, string(v, "createdAt")?))
            })?;
            (name, url, state, id)
        }
        _ => return Err("GitHub returned an unknown check context type".into()),
    };
    Ok(ParsedCheck {
        ci: CiCheck {
            name: name.into(),
            state,
            // Its CI page, or the PR when GitHub has none.
            url: url.unwrap_or(pr_url).to_owned(),
        },
        failed: failed.map(|id| FailedCheck { id }),
    })
}

/// A failed check's Auto-fix identity, `None` for any other state.
fn failure_id(
    state: CheckState,
    id: impl FnOnce() -> Result<String, String>,
) -> Result<Option<String>, String> {
    if state == CheckState::Failure {
        id().map(Some)
    } else {
        Ok(None)
    }
}
