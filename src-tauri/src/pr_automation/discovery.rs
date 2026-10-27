//! Select a PR only when its head and supported target are proven by GitHub.
use std::collections::HashMap;

use serde_json::Value;

use super::feedback::{boolean, connection, field, pr_state, same_repo, string, upstream_branch};
use super::{LocalBranch, PrState};

#[derive(Debug, PartialEq, Eq)]
pub(super) struct SelectedPr {
    pub(super) id: String,
    pub(super) state: PrState,
    pub(super) repository: String,
}

fn repository_name(value: &Value) -> Result<&str, String> {
    let name = string(value, "nameWithOwner")?;
    if !name
        .split_once('/')
        .is_some_and(|(owner, repo)| !owner.is_empty() && !repo.is_empty() && !repo.contains('/'))
    {
        return Err("GitHub response has invalid repository identity".into());
    }
    Ok(name)
}

pub(super) fn select_pr(result: &Value, local: &LocalBranch) -> Result<Option<SelectedPr>, String> {
    let repo = field(field(result, "data")?, "repository")?;
    if repo.is_null() {
        return Err("GitHub repository was not found or is inaccessible".into());
    }
    let repo_name = repository_name(repo)?;
    if !repo_name.split_once('/').is_some_and(|(owner, name)| {
        owner.eq_ignore_ascii_case(&local.owner) && name.eq_ignore_ascii_case(&local.repo)
    }) {
        return Err("GitHub returned a different upstream repository".into());
    }

    let parent = field(repo, "parent")?;
    let is_fork = boolean(repo, "isFork")?;
    if is_fork && parent.is_null() {
        return Err("GitHub fork parent is unavailable; cannot safely select a PR".into());
    }
    let parent_name = if parent.is_null() {
        None
    } else {
        Some(repository_name(parent)?)
    };
    let repository_prs = connection(field(repo, "pullRequests")?, "repository pull requests")?;
    let parent_prs = if parent.is_null() {
        &[][..]
    } else {
        connection(field(parent, "pullRequests")?, "parent pull requests")?.as_slice()
    };

    let reference = field(repo, "ref")?;
    let remote_head = if reference.is_null() {
        None
    } else {
        Some(string(field(reference, "target")?, "oid")?)
    };
    if remote_head.is_some_and(|head| head != local.head) {
        return Err(
            "Local HEAD differs from the upstream branch on GitHub; synchronize before auto-fix"
                .into(),
        );
    }
    let object = field(repo, "object")?;
    if object.is_null() {
        return Err(if remote_head.is_none() {
            "Upstream branch was not found on GitHub and the local commit is unavailable"
        } else {
            "Local commit was not found in the GitHub repository"
        }
        .into());
    }
    if string(object, "oid")? != local.head {
        return Err("GitHub returned associations for a different commit".into());
    }
    let associated = connection(
        field(object, "associatedPullRequests")?,
        "associated pull requests",
    )?;
    select_candidates(
        associated.iter().chain(repository_prs).chain(parent_prs),
        local,
        repo_name,
        parent_name,
        remote_head.is_some(),
        is_fork,
    )
}

fn select_candidates<'a>(
    candidates: impl Iterator<Item = &'a Value>,
    local: &LocalBranch,
    repo_name: &str,
    parent_name: Option<&str>,
    has_remote: bool,
    is_fork: bool,
) -> Result<Option<SelectedPr>, String> {
    let mut seen: HashMap<&str, (PrState, &str)> = HashMap::new();
    let mut open: Option<(&str, PrState, &str)> = None;
    let mut terminal: Option<(&str, PrState, &str)> = None;
    let mut ambiguous_terminal = false;
    let mut unsupported_terminal = false;
    for pr in candidates {
        let state = pr_state(pr)?;
        let branch = string(pr, "headRefName")?;
        let head = string(pr, "headRefOid")?;
        if branch != upstream_branch(local) || !same_repo(pr, local)? {
            continue;
        }
        if state == PrState::Open && head != local.head {
            return Err(
                "PR head differs from the upstream branch; retry after GitHub updates".into(),
            );
        }
        if head != local.head {
            continue;
        }
        let base = repository_name(field(pr, "repository")?)?;
        if !base.eq_ignore_ascii_case(repo_name)
            && !parent_name.is_some_and(|name| base.eq_ignore_ascii_case(name))
        {
            if state == PrState::Open {
                return Err("PR targets an unsupported repository outside the head repository and its parent".into());
            }
            unsupported_terminal = true;
            continue;
        }
        let id = string(pr, "id")?;
        if let Some((previous_state, previous_base)) = seen.insert(id, (state, base)) {
            if previous_state != state || !previous_base.eq_ignore_ascii_case(base) {
                return Err("PR changed while discovering its lifecycle or target; retry".into());
            }
        }
        let candidate = (id, state, base);
        if state == PrState::Open {
            if open.is_some_and(|previous| previous.0 != id) {
                return Err("Multiple open PRs match this upstream branch; auto-fix paused".into());
            }
            open = Some(candidate);
        } else if terminal.is_some_and(|previous| previous.0 != id) {
            ambiguous_terminal = true;
        } else {
            terminal = Some(candidate);
        }
    }

    if let Some((id, state, repository)) = open {
        if !has_remote {
            return Err("Upstream branch was not found on GitHub".into());
        }
        return Ok(Some(SelectedPr {
            id: id.into(),
            state,
            repository: repository.into(),
        }));
    }
    if unsupported_terminal {
        return Err("Matching PR targets an unsupported repository outside the head repository and its parent".into());
    }
    if ambiguous_terminal {
        return Err(
            "Multiple completed PRs match this upstream branch and head; auto-fix paused".into(),
        );
    }
    if let Some((id, state, repository)) = terminal {
        return Ok(Some(SelectedPr {
            id: id.into(),
            state,
            repository: repository.into(),
        }));
    }
    if !has_remote {
        return Err("Upstream branch was not found on GitHub".into());
    }
    if is_fork {
        return Err("No PR found in the head repository or its parent; PRs targeting other forks cannot be ruled out".into());
    }
    Ok(None)
}
