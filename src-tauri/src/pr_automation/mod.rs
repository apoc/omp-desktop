//! Read-only GitHub.com PR feedback for a tab's configured upstream branch.
//! Every GitHub connection is capped and rejected if incomplete. No URLs
//! returned by GitHub are fetched; `gh` always talks to github.com itself.
mod feedback;
mod gh;
mod git;
#[cfg(test)]
mod tests;

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::terminal::TerminalManager;

#[cfg(test)]
use feedback::failed_check;
use feedback::{parse_feedback, select_pr};
#[cfg(test)]
use git::github_repo;
use git::{local_branch, LocalBranch};

const FIND_QUERY: &str = r"query($owner:String!, $repo:String!, $ref:String!, $branch:String!) {
  repository(owner:$owner, name:$repo) {
    isFork
    pullRequests(first:100, states:OPEN, headRefName:$branch) {
      pageInfo { hasNextPage } nodes { ...PrIdentity }
    }
    parent {
      pullRequests(first:100, states:OPEN, headRefName:$branch) {
        pageInfo { hasNextPage } nodes { ...PrIdentity }
      }
    }
    ref(qualifiedName:$ref) { target { ... on Commit { oid
      associatedPullRequests(first:100) {
        pageInfo { hasNextPage } nodes { ...PrIdentity }
      }
    } } }
  }
}
fragment PrIdentity on PullRequest {
  id state headRefOid headRefName headRepository { nameWithOwner }
}";

const FEEDBACK_QUERY: &str = r"query($id:ID!) {
  node(id:$id) { ... on PullRequest {
    number url title repository { nameWithOwner } additions deletions isDraft
    state headRefOid headRefName headRepository { nameWithOwner }
    reviewThreads(first:100) { pageInfo { hasNextPage } nodes {
      id isResolved isOutdated comments(last:1) { nodes { updatedAt url } }
    } }
    commits(last:1) { nodes { commit {
      oid statusCheckRollup { contexts(first:100) { pageInfo { hasNextPage } nodes {
        __typename
        ... on CheckRun { id name status conclusion detailsUrl startedAt completedAt }
        ... on StatusContext { id context state targetUrl createdAt }
      } } }
    } } }
  } }
}";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrAutomationSnapshot {
    number: u64,
    url: String,
    title: String,
    repository: String,
    additions: u64,
    deletions: u64,
    is_draft: bool,
    head: String,
    branch: String,
    failed_checks: Vec<FailedCheck>,
    threads: Vec<ReviewThread>,
}

#[derive(Debug, Serialize)]
struct FailedCheck {
    id: String,
    name: String,
    url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewThread {
    id: String,
    updated_at: String,
    url: String,
}

/// Snapshot the project registered for this tab, never a frontend-supplied path.
#[tauri::command]
pub async fn pr_automation_snapshot(
    session_id: String,
    terminal: State<'_, Arc<TerminalManager>>,
) -> Result<Option<PrAutomationSnapshot>, String> {
    let folder = terminal
        .folder(&session_id)
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "Tab has no project folder".to_string())?;
    crate::off_ipc(move || snapshot(&folder)).await?
}

fn snapshot(folder: &Path) -> Result<Option<PrAutomationSnapshot>, String> {
    let local = local_branch(folder)?;
    let gh = gh::Gh::locate()?;
    let remote_branch = local
        .remote_ref
        .strip_prefix("refs/heads/")
        .ok_or_else(|| "Invalid upstream branch".to_string())?;
    let result = gh.query(
        FIND_QUERY,
        &[
            ("owner", &local.owner),
            ("repo", &local.repo),
            ("ref", &local.remote_ref),
            ("branch", remote_branch),
        ],
    )?;
    let Some((id, head)) = select_pr(&result, &local)? else {
        return Ok(None);
    };
    let result = gh.query(FEEDBACK_QUERY, &[("id", &id)])?;
    let snapshot = parse_feedback(&result, &local, &head)?;
    if local_branch(folder)? != local {
        return Err("Git branch, HEAD, or upstream changed while loading PR feedback".into());
    }
    Ok(Some(snapshot))
}
