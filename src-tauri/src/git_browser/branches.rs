//! `git_browser_branches`: the branches the status bar's branch picker
//! offers to switch to — every local branch but the checked-out one, and
//! every remote-tracking branch without a local branch of its name — newest
//! tip first. The switch itself is [`crate::workspace::switch_branch`].

use super::{fail, open};
use std::collections::HashSet;
use std::path::Path;

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    /// Short name: `main`, or with its remote, `origin/main`.
    pub name: String,
    /// A remote-tracking branch (`refs/remotes/…`).
    pub remote: bool,
    /// Its tip's committer time, unix seconds; `0` when unreadable.
    pub at: i64,
}

/// The local branch `git switch --track` makes for a remote-tracking one:
/// its name after the remote (`origin/feat/x` → `feat/x`). The remote is the
/// first component, as the default fetch refspec lays them out.
fn local_name(remote: &str) -> &str {
    remote.split_once('/').map_or(remote, |(_, name)| name)
}

/// `git_browser_branches(path)`. A remote-tracking branch whose local
/// counterpart exists is left out: switching to it would fail (`git switch
/// --track` refuses an existing name), and the local one is listed, unless
/// it is the checked-out branch.
pub fn branches(path: &Path) -> Result<Vec<Branch>, String> {
    let (_gate, repo, _) = open(path)?;
    let head = repo.head_name().map_err(fail("failed to read HEAD"))?;
    let current = head.as_ref().map(|name| name.as_ref().shorten());
    let refs = repo.references().map_err(fail("failed to read refs"))?;
    let mut list = tips(
        refs.local_branches().map_err(fail("failed to read refs"))?,
        false,
    );
    let remotes = tips(
        refs.remote_branches()
            .map_err(fail("failed to read refs"))?,
        true,
    );
    let locals: HashSet<&str> = list.iter().map(|b| b.name.as_str()).collect();
    let remotes: Vec<Branch> = remotes
        .into_iter()
        .filter(|b| !locals.contains(local_name(&b.name)))
        .collect();
    list.retain(|b| current.is_none_or(|name| name != b.name.as_str()));
    list.extend(remotes);
    list.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.name.cmp(&b.name)));
    Ok(list)
}

/// The branches among `refs` whose tip is a commit, each tip read once
/// (`peel_to_commit`). A broken ref or one that peels to no commit is
/// skipped, as `git branch` ignores it, and so is a symbolic one
/// (`refs/remotes/origin/HEAD`): its target is listed itself.
fn tips<'r, E>(
    refs: impl Iterator<Item = Result<gix::Reference<'r>, E>>,
    remote: bool,
) -> Vec<Branch> {
    refs.flatten()
        .filter_map(|mut reference| {
            if reference.target().try_name().is_some() {
                return None;
            }
            let at = reference
                .peel_to_commit()
                .ok()?
                .time()
                .map_or(0, |time| time.seconds);
            Some(Branch {
                name: reference.name().shorten().to_string(),
                remote,
                at,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{branches, local_name, Branch};
    use crate::git_browser::fixture;

    fn branch(name: &str, remote: bool, at: i64) -> Branch {
        Branch {
            name: name.to_string(),
            remote,
            at,
        }
    }

    #[test]
    fn lists_other_branches_newest_first_without_the_current_one() {
        let Some(repo) = fixture::init("branches-list") else {
            return;
        };
        let c1 = repo.commit("first", 1_700_000_000);
        repo.git(&["branch", "old"]);
        repo.git(&["checkout", "-q", "-b", "feat/new"]);
        let c2 = repo.commit("second", 1_700_000_100);
        repo.git(&["checkout", "-q", "main"]);
        // Tracked by a local branch of the same name: offered as `feat/new`.
        repo.git(&["update-ref", "refs/remotes/origin/feat/new", &c2]);
        // The checked-out branch's own remote copy: `main` exists locally.
        repo.git(&["update-ref", "refs/remotes/origin/main", &c1]);
        repo.git(&["update-ref", "refs/remotes/origin/only-remote", &c2]);
        repo.git(&[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
        ]);
        repo.git(&["tag", "v1", &c1]);

        assert_eq!(
            branches(repo.path()).expect("branches"),
            [
                branch("feat/new", false, 1_700_000_100),
                branch("origin/only-remote", true, 1_700_000_100),
                branch("old", false, 1_700_000_000),
            ]
        );
    }

    #[test]
    fn a_detached_head_hides_no_branch() {
        let Some(repo) = fixture::init("branches-detached") else {
            return;
        };
        let c1 = repo.commit("first", 1_700_000_000);
        repo.git(&["checkout", "-q", "--detach", &c1]);
        assert_eq!(
            branches(repo.path()).expect("branches"),
            [branch("main", false, 1_700_000_000)]
        );
    }

    #[test]
    fn a_remote_branch_becomes_the_local_name_after_its_remote() {
        assert_eq!(local_name("origin/main"), "main");
        assert_eq!(local_name("origin/feat/x"), "feat/x");
        assert_eq!(local_name("plain"), "plain");
    }
}
