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
use feedback::parse_check;
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
    /// Every check of the head commit, in GitHub's order, for the card.
    checks: Vec<CiCheck>,
    /// The failed ones' Auto-fix identities.
    failed_checks: Vec<FailedCheck>,
    threads: Vec<ReviewThread>,
}

/// Where a check is, as the card draws it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum CheckState {
    /// Not started: queued, requested, waiting, pending; a commit status
    /// that is expected but not reported yet.
    Queued,
    Running,
    Success,
    /// Failed, timed out, needs action or never started.
    Failure,
    /// Neutral, skipped, cancelled or stale.
    Neutral,
}

#[derive(Debug, Serialize)]
struct CiCheck {
    name: String,
    state: CheckState,
    /// Its CI page, or the PR when GitHub has none.
    url: String,
}

/// A failed check's Auto-fix identity: node id plus attempt timestamps.
#[derive(Debug, Serialize)]
struct FailedCheck {
    id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewThread {
    id: String,
    updated_at: String,
    url: String,
}

/// A failed lookup, as the webview receives it. `ghMissing` marks the one
/// failure the Changes card shows as a disabled state instead of an error:
/// there is no GitHub CLI to ask.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupError {
    message: String,
    gh_missing: bool,
}

impl From<String> for LookupError {
    fn from(message: String) -> Self {
        Self {
            message,
            gh_missing: false,
        }
    }
}

/// Snapshot the project registered for this tab, never a frontend-supplied path.
#[tauri::command]
pub async fn pr_automation_snapshot(
    session_id: String,
    terminal: State<'_, Arc<TerminalManager>>,
) -> Result<Option<PrAutomationSnapshot>, LookupError> {
    let folder = terminal
        .folder(&session_id)
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "Tab has no project folder".to_string())?;
    crate::off_ipc(move || snapshot(&folder)).await?
}

fn snapshot(folder: &Path) -> Result<Option<PrAutomationSnapshot>, LookupError> {
    // First, so a missing gh reads as such in any folder, GitHub or not.
    let gh = gh::Gh::locate().map_err(|message| LookupError {
        message,
        gh_missing: true,
    })?;
    let local = local_branch(folder)?;
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
        return Err(
            "Git branch, HEAD, or upstream changed while loading PR feedback"
                .to_string()
                .into(),
        );
    }
    Ok(Some(snapshot))
}
