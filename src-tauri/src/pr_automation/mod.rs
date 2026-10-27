//! Read-only GitHub.com PR feedback for a tab's configured upstream branch.
//! Every GitHub connection is capped and rejected if incomplete. No URLs
//! returned by GitHub are fetched; `gh` always talks to github.com itself.
mod discovery;
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

use discovery::select_pr;
#[cfg(test)]
use feedback::failed_check;
use feedback::parse_feedback;
#[cfg(test)]
use git::github_repo;
use git::{local_branch, LocalBranch};

const FIND_QUERY: &str = r"query($owner:String!, $repo:String!, $ref:String!, $branch:String!, $head:String!) {
  repository(owner:$owner, name:$repo) {
    isFork nameWithOwner
    pullRequests(first:100, states:[OPEN, MERGED, CLOSED], headRefName:$branch) {
      pageInfo { hasNextPage } nodes { ...PrIdentity }
    }
    parent {
      nameWithOwner
      pullRequests(first:100, states:[OPEN, MERGED, CLOSED], headRefName:$branch) {
        pageInfo { hasNextPage } nodes { ...PrIdentity }
      }
    }
    ref(qualifiedName:$ref) { target { ... on Commit { oid } } }
    object(expression:$head) { ... on Commit { oid
      associatedPullRequests(first:100) {
        pageInfo { hasNextPage } nodes { ...PrIdentity }
      }
    } }
  }
}
fragment PrIdentity on PullRequest {
  id state headRefOid headRefName headRepository { nameWithOwner }
  repository { nameWithOwner }
}";

const FEEDBACK_QUERY: &str = r"query($id:ID!) {
  node(id:$id) { ... on PullRequest {
    id number url title repository { nameWithOwner } additions deletions isDraft
    state headRefOid headRefName headRepository { nameWithOwner }
    reviewThreads(first:100) { pageInfo { hasNextPage } nodes {
      id isResolved isOutdated comments(last:1) { nodes { updatedAt url } }
    } }
    commits(last:1) { nodes { commit {
      oid statusCheckRollup { state contexts(first:100) { pageInfo { hasNextPage } nodes {
        __typename
        ... on CheckRun { id name status conclusion detailsUrl startedAt completedAt }
        ... on StatusContext { id context state targetUrl createdAt }
      } } }
    } } }
  } }
}";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
enum PrState {
    Open,
    Merged,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ChecksState {
    None,
    Pending,
    Success,
    Failure,
    Unknown,
}

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
    state: PrState,
    checks_state: ChecksState,
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
    with_local_revalidation(
        &local,
        || {
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
                    ("head", &local.head),
                ],
            )?;
            let Some(selected) = select_pr(&result, &local)? else {
                return Ok(None);
            };
            let result = gh.query(FEEDBACK_QUERY, &[("id", &selected.id)])?;
            parse_feedback(&result, &local, &selected).map(Some)
        },
        || local_branch(folder),
    )
}

fn with_local_revalidation<T>(
    local: &LocalBranch,
    read: impl FnOnce() -> Result<T, String>,
    reread: impl FnOnce() -> Result<LocalBranch, String>,
) -> Result<T, String> {
    let result = read();
    if reread()? != *local {
        return Err("Git branch, HEAD, or upstream changed while loading PR feedback".into());
    }
    result
}
