//! Read-only GitHub.com PR feedback for a tab's configured upstream branch.
//! Every GitHub connection is capped and rejected if incomplete. No URLs
//! returned by GitHub are fetched; `gh` always talks to github.com itself.
mod feedback;
mod gh;
mod git;
#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::child_path::child_path_dirs;
use crate::terminal::TerminalManager;

#[cfg(test)]
use feedback::{parse_check, SelectedPr};
use feedback::{parse_feedback, select_pr};
#[cfg(test)]
use git::github_repo;
use git::{local_branch, LocalBranch};

/// The upstream repository as GitHub resolves it (renames and transfers
/// followed), its fork parent, and the PRs associated with the upstream
/// branch's head commit. Open PRs from the head owner's branch are listed
/// per repository over REST ([`gh::Gh::open_pulls`]) instead: GraphQL's
/// `pullRequests(headRefName:)` lists every fork's PRs with that branch name.
const FIND_QUERY: &str = r"query($owner:String!, $repo:String!, $ref:String!) {
  repository(owner:$owner, name:$repo) {
    nameWithOwner isFork
    parent { nameWithOwner }
    ref(qualifiedName:$ref) { target { ... on Commit { oid
      associatedPullRequests(first:100) {
        pageInfo { hasNextPage }
        nodes { url id state headRefOid headRefName headRepository { nameWithOwner } }
      }
    } } }
  }
}";

const FEEDBACK_QUERY: &str = r"query($id:ID!) {
  node(id:$id) { ... on PullRequest {
    number url title repository { nameWithOwner } additions deletions isDraft
    state headRefOid headRefName headRepository { nameWithOwner }
    reviewThreads(first:100) { pageInfo { hasNextPage } nodes {
      id isResolved isOutdated
      comments(last:100) { pageInfo { hasPreviousPage } nodes { updatedAt viewerDidAuthor } }
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
    /// When someone other than the viewer last commented, so the agent's
    /// own replies do not make the thread new again.
    updated_at: String,
}

/// A failed lookup, as the webview receives it. `ghMissing` marks the one
/// failure for which the Changes card is hidden instead of showing an error:
/// there is no GitHub CLI to ask. `retryable` marks transient lag (GitHub
/// not yet showing a push, the branch moving mid-read), which the webview
/// retries with a backoff instead of pausing Auto-fix.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupError {
    message: String,
    gh_missing: bool,
    retryable: bool,
}

impl LookupError {
    /// A failure that clears up once GitHub or the checkout settles.
    fn transient(message: &str) -> Self {
        Self {
            message: message.to_owned(),
            gh_missing: false,
            retryable: true,
        }
    }
}

impl From<String> for LookupError {
    fn from(message: String) -> Self {
        Self {
            message,
            gh_missing: false,
            retryable: false,
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
    snapshot_in(&child_path_dirs(), folder)
}

/// [`snapshot`] with `gh` looked up in `dirs`.
fn snapshot_in(
    dirs: &[PathBuf],
    folder: &Path,
) -> Result<Option<PrAutomationSnapshot>, LookupError> {
    // First, so a missing gh reads as such in any folder, GitHub or not.
    let gh = gh::Gh::locate_in(dirs).map_err(|message| LookupError {
        message,
        gh_missing: true,
        retryable: false,
    })?;
    let local = local_branch(folder)?;
    let result = gh.query(
        FIND_QUERY,
        &[
            ("owner", &local.owner),
            ("repo", &local.repo),
            ("ref", &local.remote_ref),
        ],
    )?;
    let Some(pr) = select_pr(&result, &local, |repository, head| {
        gh.open_pulls(repository, head)
    })?
    else {
        return Ok(None);
    };
    let result = gh.query(FEEDBACK_QUERY, &[("id", &pr.id)])?;
    let snapshot = parse_feedback(&result, &local, &pr)?;
    if local_branch(folder)? != local {
        return Err(LookupError::transient(
            "Git branch, HEAD, or upstream changed while loading PR feedback",
        ));
    }
    Ok(Some(snapshot))
}
