//! Fail-closed normalization of GitHub GraphQL feedback.
use super::discovery::SelectedPr;
use super::{ChecksState, FailedCheck, LocalBranch, PrAutomationSnapshot, PrState, ReviewThread};
use serde_json::Value;

pub(super) fn field<'a>(v: &'a Value, key: &str) -> Result<&'a Value, String> {
    v.get(key)
        .ok_or_else(|| format!("GitHub response is missing {key}"))
}
pub(super) fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    field(v, key)?
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("GitHub response has invalid {key}"))
}
pub(super) fn boolean(v: &Value, key: &str) -> Result<bool, String> {
    field(v, key)?
        .as_bool()
        .ok_or_else(|| format!("GitHub response has invalid {key}"))
}
fn unsigned(v: &Value, key: &str) -> Result<u64, String> {
    field(v, key)?
        .as_u64()
        .ok_or_else(|| format!("GitHub response has invalid {key}"))
}
pub(super) fn connection<'a>(v: &'a Value, name: &str) -> Result<&'a Vec<Value>, String> {
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
pub(super) fn same_repo(v: &Value, local: &LocalBranch) -> Result<bool, String> {
    let repo = field(v, "headRepository")?;
    if repo.is_null() {
        return Ok(false);
    }
    let name = string(repo, "nameWithOwner")?;
    let (owner, name) = name
        .split_once('/')
        .filter(|(owner, name)| !owner.is_empty() && !name.is_empty() && !name.contains('/'))
        .ok_or_else(|| "GitHub response has invalid head repository identity".to_string())?;
    Ok(owner.eq_ignore_ascii_case(&local.owner) && name.eq_ignore_ascii_case(&local.repo))
}
pub(super) fn upstream_branch(local: &LocalBranch) -> &str {
    local.remote_ref.strip_prefix("refs/heads/").unwrap_or("")
}

pub(super) fn pr_state(v: &Value) -> Result<PrState, String> {
    match string(v, "state")? {
        "OPEN" => Ok(PrState::Open),
        "MERGED" => Ok(PrState::Merged),
        "CLOSED" => Ok(PrState::Closed),
        _ => Err("GitHub returned an unknown PR state".into()),
    }
}

pub(super) fn parse_feedback(
    result: &Value,
    local: &LocalBranch,
    selected: &SelectedPr,
) -> Result<PrAutomationSnapshot, String> {
    let data = field(result, "data")?;
    let pr = field(data, "node")?;
    let state = pr_state(pr)?;
    if string(pr, "id")? != selected.id
        || string(pr, "headRefOid")? != local.head
        || string(pr, "headRefName")? != upstream_branch(local)
        || !same_repo(pr, local)?
        || !string(field(pr, "repository")?, "nameWithOwner")?
            .eq_ignore_ascii_case(&selected.repository)
    {
        return Err("PR identity, head or branch changed while loading feedback".into());
    }
    if selected.state != PrState::Open && state == PrState::Open {
        return Err("PR reopened while loading feedback; retry to validate its open branch".into());
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
    if string(object, "oid")? != local.head {
        return Err("GitHub returned feedback for a different commit".into());
    }
    let mut failed_checks = Vec::new();
    let rollup = field(object, "statusCheckRollup")?;
    let rollup_state = if rollup.is_null() {
        ChecksState::None
    } else {
        let state = match string(rollup, "state")? {
            "ERROR" | "FAILURE" => ChecksState::Failure,
            "PENDING" => ChecksState::Pending,
            "SUCCESS" => ChecksState::Success,
            "EXPECTED" => ChecksState::Unknown,
            _ => return Err("GitHub returned an unknown check rollup state".into()),
        };
        for check in connection(field(rollup, "contexts")?, "check contexts")? {
            if let Some(check) = failed_check(check, &url)? {
                failed_checks.push(check);
            }
        }
        state
    };
    let checks_state = if failed_checks.is_empty() {
        rollup_state
    } else {
        ChecksState::Failure
    };
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
        state,
        checks_state,
        // The snapshot owns both identifiers; local stays borrowed for revalidation.
        head: local.head.clone(),
        branch: local.branch.clone(),
        failed_checks,
        threads,
    })
}

pub(super) fn failed_check(v: &Value, pr_url: &str) -> Result<Option<FailedCheck>, String> {
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
            if status != "COMPLETED" {
                return Ok(None);
            }
            let conclusion = conclusion
                .as_str()
                .ok_or_else(|| "Completed GitHub check has no conclusion".to_string())?;
            if !matches!(
                conclusion,
                "FAILURE" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE"
            ) {
                return Ok(None);
            }
            let id = string(v, "id")?;
            // Both timestamps are nullable in GitHub's schema, including for
            // runs that fail before a runner starts.
            let started = optional_timestamp(v, "startedAt")?;
            let completed = optional_timestamp(v, "completedAt")?;
            Ok(Some(FailedCheck {
                id: format!("{id}:{started}:{completed}"),
                name: string(v, "name")?.into(),
                url: optional_url(v, "detailsUrl", pr_url)?,
            }))
        }
        "StatusContext" => {
            let state = string(v, "state")?;
            if !matches!(
                state,
                "ERROR" | "FAILURE" | "SUCCESS" | "PENDING" | "EXPECTED"
            ) {
                return Err("GitHub returned an unknown status context state".into());
            }
            if !matches!(state, "ERROR" | "FAILURE") {
                return Ok(None);
            }
            Ok(Some(FailedCheck {
                id: format!("{}:{}", string(v, "id")?, string(v, "createdAt")?),
                name: string(v, "context")?.into(),
                url: optional_url(v, "targetUrl", pr_url)?,
            }))
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
