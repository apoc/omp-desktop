//! `git_browser_status`: every tracked and untracked file of the work tree
//! folded into a directory tree, each changed file marked with its change
//! against `HEAD` (staged and unstaged in one), plus the repo header.

use super::{fail, open, StatusKind, TreeNode, MAX_FILES};
use gix::bstr::ByteSlice as _;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

/// The repository header shown above the tree.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// The work dir's basename.
    pub name: String,
    /// Short branch name; `None` when `HEAD` is detached.
    pub branch: Option<String>,
    /// Full id of `HEAD`; `None` when it is unborn.
    pub head: Option<String>,
    /// Commits on `HEAD` but not on its upstream; `None` without an upstream.
    pub ahead: Option<u32>,
    /// Commits on the upstream but not on `HEAD`; `None` without an upstream.
    pub behind: Option<u32>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    pub repo: RepoInfo,
    pub tree: TreeNode,
    /// Changed files in `tree`.
    pub changed: u32,
    /// More than [`MAX_FILES`] files: unchanged ones beyond it were dropped.
    pub truncated: bool,
}

/// Bounded count of changed paths, without constructing the file tree.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalChanges {
    pub changed: usize,
    pub truncated: bool,
}

pub fn change_summary(path: &Path) -> Result<Option<LocalChanges>, String> {
    let Some((_gate, mut repo)) = super::discover_optional(path)? else {
        return Ok(None);
    };
    if repo.workdir().is_none() {
        return Ok(None);
    }
    super::sanitize_filters(&mut repo)?;
    Ok(Some(summarize_count(changes(&repo)?.kinds.len())))
}

fn summarize_count(count: usize) -> LocalChanges {
    LocalChanges {
        changed: count.min(MAX_FILES),
        truncated: count > MAX_FILES,
    }
}

/// What one status item says about one path, layer-independent.
#[derive(Debug, PartialEq, Eq)]
struct Event {
    path: String,
    kind: StatusKind,
    /// The rename source, for a `Renamed` event.
    from: Option<String>,
}

/// Precedence when both layers report a path, first match wins: untracked,
/// added (even if modified in the work tree since), deleted, renamed,
/// anything else (modified, type change, conflict) modified.
const fn rank(kind: StatusKind) -> u8 {
    match kind {
        StatusKind::Untracked => 4,
        StatusKind::Added => 3,
        StatusKind::Deleted => 2,
        StatusKind::Renamed => 1,
        StatusKind::Modified => 0,
    }
}

/// The working tree's changes against `HEAD`, one kind per path.
#[derive(Debug, Default)]
pub(super) struct Changes {
    pub kinds: BTreeMap<String, StatusKind>,
    /// Rename destination → source, for a diff against the source's blob.
    pub sources: HashMap<String, String>,
}

/// Fold status events into one kind per path ([`rank`]). Pure, so the
/// precedence is testable without a repository.
fn merge(events: impl IntoIterator<Item = Event>) -> Changes {
    let mut changes = Changes::default();
    for Event { path, kind, from } in events {
        if let Some(from) = from {
            // The map and the kinds both key by the destination: one copy of
            // the path per rename, not per event.
            changes.sources.insert(path.clone(), from);
        }
        let slot = changes.kinds.entry(path).or_insert(kind);
        if rank(kind) > rank(*slot) {
            *slot = kind;
        }
    }
    changes
}

/// Translate one gix status item; `None` for items that carry no change
/// (an index entry merely needing a stat refresh, an ignored file).
fn event(item: &gix::status::Item) -> Option<Event> {
    use gix::diff::index::ChangeRef;
    use gix::status::index_worktree::{iter::Summary, Item as Worktree};
    use gix::status::Item;

    let at = |path: &gix::bstr::BStr, kind| Event {
        path: path.to_str_lossy().into_owned(),
        kind,
        from: None,
    };
    let renamed = |from: &gix::bstr::BStr, to: &gix::bstr::BStr| Event {
        from: Some(from.to_str_lossy().into_owned()),
        ..at(to, StatusKind::Renamed)
    };
    Some(match item {
        // A copy leaves its source in place: the destination is new.
        Item::TreeIndex(
            ChangeRef::Addition { location, .. }
            | ChangeRef::Rewrite {
                location,
                copy: true,
                ..
            },
        ) => at(location, StatusKind::Added),
        Item::TreeIndex(ChangeRef::Deletion { location, .. }) => at(location, StatusKind::Deleted),
        Item::TreeIndex(ChangeRef::Modification { location, .. }) => {
            at(location, StatusKind::Modified)
        }
        Item::TreeIndex(ChangeRef::Rewrite {
            source_location,
            location,
            ..
        }) => renamed(source_location, location),
        Item::IndexWorktree(Worktree::Rewrite {
            source,
            dirwalk_entry,
            copy: false,
            ..
        }) => renamed(source.rela_path(), dirwalk_entry.rela_path.as_ref()),
        Item::IndexWorktree(item) => at(
            item.rela_path(),
            match item.summary()? {
                Summary::Added | Summary::Copied => StatusKind::Untracked,
                Summary::IntentToAdd => StatusKind::Added,
                Summary::Removed => StatusKind::Deleted,
                Summary::Modified | Summary::TypeChange | Summary::Conflict | Summary::Renamed => {
                    StatusKind::Modified
                }
            },
        ),
    })
}

/// Run gix's status (`HEAD` → index and index → work tree, untracked files
/// listed individually, ignored ones never) and merge it per path. Rename
/// tracking follows the repo's config for `HEAD` → index (git's default:
/// on) and stays off for index → work tree, as in `git status`.
///
/// A submodule counts as changed only when it has a different commit
/// checked out (`ignore = dirty`): its own work tree is never read, because
/// gix opens it with the submodule's config, whose filter drivers
/// [`super::open`] cannot strip.
pub(super) fn changes(repo: &gix::Repository) -> Result<Changes, String> {
    let items = repo
        .status(gix::progress::Discard)
        .map_err(fail("failed to start status"))?
        .untracked_files(gix::status::UntrackedFiles::Files)
        .index_worktree_submodules(gix::status::Submodule::Given {
            ignore: gix::submodule::config::Ignore::Dirty,
            check_dirty: false,
        })
        .into_iter(None)
        .map_err(fail("failed to run status"))?;
    let mut failure = None;
    let changes = merge(
        items
            .map_while(|item| item.map_err(|e| failure = Some(e)).ok())
            .filter_map(|item| event(&item)),
    );
    failure.map_or(Ok(changes), |e| Err(format!("status failed: {e}")))
}

/// The files the tree lists: every changed one first, so `cap` only ever
/// drops unchanged ones, then the `tracked` paths (index order, a path in
/// several conflict stages once). Returns whether anything was dropped.
fn listed<'a>(
    changed: BTreeMap<String, StatusKind>,
    tracked: impl Iterator<Item = std::borrow::Cow<'a, str>>,
    cap: usize,
) -> (BTreeMap<String, Option<StatusKind>>, bool) {
    let mut files: BTreeMap<String, Option<StatusKind>> = BTreeMap::new();
    for (path, kind) in changed {
        if files.len() == cap {
            return (files, true);
        }
        files.insert(path, Some(kind));
    }
    for path in tracked {
        if files.contains_key(path.as_ref()) {
            continue;
        }
        if files.len() == cap {
            return (files, true);
        }
        files.insert(path.into_owned(), None);
    }
    (files, false)
}

/// `git_browser_status(path)`.
pub fn status(path: &Path) -> Result<StatusView, String> {
    let (_gate, repo, work_dir) = open(path)?;
    let changes = changes(&repo)?;
    let index = repo
        .index_or_empty()
        .map_err(fail("failed to read index"))?;

    let (files, truncated) = listed(
        changes.kinds,
        index
            .entries()
            .iter()
            .map(|e| e.path(&index).to_str_lossy()),
        MAX_FILES,
    );
    let tree = fold(files);
    let head = repo.head_id().ok().map(gix::Id::detach);
    let head_name = repo.head_name().map_err(fail("failed to read HEAD"))?;
    let (ahead, behind) = match (head, &head_name) {
        (Some(head), Some(name)) => super::log::ahead_behind(&repo, head, name.as_ref())?
            .map_or((None, None), |(a, b)| (Some(a), Some(b))),
        _ => (None, None),
    };
    let repo_info = RepoInfo {
        name: work_dir
            .file_name()
            .map_or_else(String::new, |n| n.to_string_lossy().into_owned()),
        branch: head_name.map(|name| name.shorten().to_string()),
        head: head.map(|id| id.to_string()),
        ahead,
        behind,
    };
    Ok(StatusView {
        repo: repo_info,
        changed: tree.changed,
        tree,
        truncated,
    })
}

/// A directory being assembled by [`fold`].
#[derive(Default)]
struct Dir {
    dirs: BTreeMap<String, Self>,
    files: BTreeMap<String, Option<StatusKind>>,
}

impl Dir {
    fn insert(&mut self, path: &str, status: Option<StatusKind>) {
        match path.split_once('/') {
            // Look up first: `entry` would allocate the key for every
            // segment of every file, not once per directory.
            Some((head, rest)) => match self.dirs.get_mut(head) {
                Some(dir) => dir.insert(rest, status),
                None => self
                    .dirs
                    .entry(head.to_string())
                    .or_default()
                    .insert(rest, status),
            },
            None => {
                self.files.insert(path.to_string(), status);
            }
        }
    }

    fn into_node(self, name: String, path: String) -> TreeNode {
        let mut children = Vec::with_capacity(self.dirs.len() + self.files.len());
        let mut changed = 0u32;
        for (name, dir) in self.dirs {
            let child_path = join(&path, &name);
            let node = dir.into_node(name, child_path);
            changed += node.changed;
            children.push(node);
        }
        for (name, status) in self.files {
            changed += u32::from(status.is_some());
            children.push(TreeNode {
                path: join(&path, &name),
                name,
                dir: false,
                status,
                changed: 0,
                children: Vec::new(),
            });
        }
        TreeNode {
            name,
            path,
            dir: true,
            status: None,
            changed,
            children,
        }
    }
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

/// Fold `/`-separated project-relative file paths into a tree rooted at
/// `""`: directories first, then files, each in byte order; every
/// directory's `changed` counts the files with a status below it.
pub(super) fn fold(files: impl IntoIterator<Item = (String, Option<StatusKind>)>) -> TreeNode {
    let mut root = Dir::default();
    for (path, status) in files {
        root.insert(&path, status);
    }
    root.into_node(String::new(), String::new())
}

#[cfg(test)]
mod tests {
    use super::{
        change_summary, fold, listed, merge, status, summarize_count, Event, LocalChanges,
        StatusKind, TreeNode, MAX_FILES,
    };
    use crate::git_browser::fixture;
    use std::borrow::Cow;
    use std::collections::BTreeMap;

    fn ev(path: &str, kind: StatusKind) -> Event {
        Event {
            path: path.to_string(),
            kind,
            from: None,
        }
    }

    fn renamed(from: &str, to: &str) -> Event {
        Event {
            from: Some(from.to_string()),
            ..ev(to, StatusKind::Renamed)
        }
    }

    #[test]
    fn merge_applies_the_precedence_per_path() {
        use StatusKind::{Added, Deleted, Modified, Renamed, Untracked};
        let changes = merge([
            // Added in the index, then modified in the work tree: Added.
            ev("a", Added),
            ev("a", Modified),
            // Modified in the index, deleted in the work tree: Deleted.
            ev("d", Modified),
            ev("d", Deleted),
            // Renamed in the index, then edited: Renamed.
            ev("r", Modified),
            renamed("old", "r"),
            // Removed from the index but still on disk: Untracked wins.
            ev("u", Deleted),
            ev("u", Untracked),
            ev("m", Modified),
        ]);
        let kinds: Vec<(&str, StatusKind)> = changes
            .kinds
            .iter()
            .map(|(p, k)| (p.as_str(), *k))
            .collect();
        assert_eq!(
            kinds,
            [
                ("a", Added),
                ("d", Deleted),
                ("m", Modified),
                ("r", Renamed),
                ("u", Untracked),
            ]
        );
    }

    #[test]
    fn merge_records_rename_sources_by_destination() {
        let changes = merge([renamed("old.txt", "new.txt")]);
        assert_eq!(
            changes.sources.get("new.txt").map(String::as_str),
            Some("old.txt")
        );
        assert!(!changes.kinds.contains_key("old.txt"));
    }

    #[test]
    fn listed_keeps_changed_files_and_drops_unchanged_ones_past_the_cap() {
        let changed = || {
            BTreeMap::from([
                ("z.txt".to_string(), StatusKind::Modified),
                ("y.txt".to_string(), StatusKind::Added),
            ])
        };
        let tracked = || {
            ["a.txt", "b.txt", "b.txt", "z.txt"]
                .into_iter()
                .map(Cow::Borrowed)
        };
        let (files, truncated) = listed(changed(), tracked(), 3);
        assert!(truncated);
        assert_eq!(files.len(), 3);
        assert_eq!(files.get("z.txt"), Some(&Some(StatusKind::Modified)));
        assert_eq!(files.get("y.txt"), Some(&Some(StatusKind::Added)));
        assert_eq!(files.get("a.txt"), Some(&None));

        // Duplicates (conflict stages) and changed paths count once.
        let (files, truncated) = listed(changed(), tracked(), 4);
        assert!(!truncated);
        assert_eq!(
            files.keys().map(String::as_str).collect::<Vec<_>>(),
            ["a.txt", "b.txt", "y.txt", "z.txt"]
        );
    }

    fn names(node: &TreeNode) -> Vec<&str> {
        node.children.iter().map(|c| c.name.as_str()).collect()
    }

    #[test]
    fn fold_puts_dirs_first_then_files_and_counts_changes() {
        let tree = fold([
            ("z.txt".to_string(), None),
            ("src/b.rs".to_string(), Some(StatusKind::Modified)),
            ("src/a/x.rs".to_string(), Some(StatusKind::Added)),
            ("src/a/y.rs".to_string(), None),
            ("a.txt".to_string(), Some(StatusKind::Untracked)),
            ("docs/readme.md".to_string(), None),
        ]);
        assert_eq!(tree.path, "");
        assert!(tree.dir);
        assert_eq!(names(&tree), ["docs", "src", "a.txt", "z.txt"]);
        assert_eq!(tree.changed, 3);

        let docs = &tree.children[0];
        assert_eq!((docs.path.as_str(), docs.changed), ("docs", 0));
        let src = &tree.children[1];
        assert_eq!(names(src), ["a", "b.rs"]);
        assert_eq!(src.changed, 2);
        let a = &src.children[0];
        assert_eq!((a.path.as_str(), a.dir, a.changed), ("src/a", true, 1));
        let x = &a.children[0];
        assert_eq!(x.path, "src/a/x.rs");
        assert_eq!(
            (x.dir, x.status, x.changed),
            (false, Some(StatusKind::Added), 0)
        );
        assert_eq!(x.children.len(), 0);
        let top_file = &tree.children[2];
        assert_eq!(top_file.path, "a.txt");
    }

    fn find<'a>(node: &'a TreeNode, path: &str) -> Option<&'a TreeNode> {
        if node.path == path {
            return Some(node);
        }
        node.children.iter().find_map(|c| find(c, path))
    }

    fn status_of(tree: &TreeNode, path: &str) -> Option<StatusKind> {
        find(tree, path).and_then(|n| n.status)
    }

    #[test]
    fn status_lists_every_file_with_its_merged_kind() {
        let Some(repo) = fixture::init("status-kinds") else {
            return;
        };
        repo.write("keep.txt", "keep\n");
        repo.write("edit.txt", "edit\n");
        repo.write("gone.txt", "gone\n");
        repo.write("move.txt", "move me\nsecond line\nthird line\n");
        repo.write("dir/nested.txt", "nested\n");
        repo.write(".gitignore", "ignored.log\n");
        repo.git(&["add", "."]);
        repo.commit("init", 1_700_000_000);

        repo.write("edit.txt", "edited\n");
        std::fs::remove_file(repo.path().join("gone.txt")).expect("delete tracked file");
        repo.git(&["mv", "move.txt", "moved.txt"]);
        repo.write("new.txt", "staged\n");
        repo.git(&["add", "new.txt"]);
        repo.write("new.txt", "staged then edited\n");
        repo.write("fresh/untracked.txt", "u\n");
        repo.write("ignored.log", "noise\n");

        let view = status(repo.path()).expect("status");
        let tree = &view.tree;
        assert_eq!(status_of(tree, "keep.txt"), None);
        assert!(
            find(tree, "keep.txt").is_some(),
            "unchanged files are listed"
        );
        assert_eq!(status_of(tree, "edit.txt"), Some(StatusKind::Modified));
        assert_eq!(status_of(tree, "gone.txt"), Some(StatusKind::Deleted));
        assert_eq!(status_of(tree, "moved.txt"), Some(StatusKind::Renamed));
        assert!(find(tree, "move.txt").is_none(), "rename source is gone");
        assert_eq!(status_of(tree, "new.txt"), Some(StatusKind::Added));
        assert_eq!(
            status_of(tree, "fresh/untracked.txt"),
            Some(StatusKind::Untracked)
        );
        assert!(
            find(tree, "ignored.log").is_none(),
            "ignored files never appear"
        );
        assert_eq!(find(tree, "dir/nested.txt").map(|n| n.status), Some(None));
        assert_eq!(view.changed, 5);
        assert_eq!(tree.changed, 5);
        assert!(!view.truncated);
        assert_eq!(
            change_summary(repo.path()).unwrap(),
            Some(LocalChanges {
                changed: 5,
                truncated: false
            })
        );

        assert_eq!(view.repo.branch.as_deref(), Some("main"));
        assert_eq!(
            view.repo.head.as_deref(),
            Some(repo.git(&["rev-parse", "HEAD"]).trim())
        );
        assert_eq!((view.repo.ahead, view.repo.behind), (None, None));
        assert!(view
            .repo
            .name
            .starts_with("omp-git-browser-test-status-kinds"));
    }

    #[test]
    fn status_works_on_an_unborn_head_and_from_a_subdirectory() {
        let Some(repo) = fixture::init("status-unborn") else {
            return;
        };
        repo.write("sub/a.txt", "a\n");
        repo.git(&["add", "."]);
        repo.write("sub/b.txt", "b\n");

        let view = status(&repo.path().join("sub")).expect("status");
        assert_eq!(view.repo.head, None);
        assert_eq!(view.repo.branch.as_deref(), Some("main"));
        assert_eq!(status_of(&view.tree, "sub/a.txt"), Some(StatusKind::Added));
        assert_eq!(
            status_of(&view.tree, "sub/b.txt"),
            Some(StatusKind::Untracked)
        );
        assert_eq!(
            change_summary(&repo.path().join("sub")).unwrap(),
            Some(LocalChanges {
                changed: 2,
                truncated: false
            })
        );
    }

    #[test]
    fn status_reports_a_detached_head_without_a_branch() {
        let Some(repo) = fixture::init("status-detached") else {
            return;
        };
        let first = repo.commit("one", 1_700_000_000);
        repo.commit("two", 1_700_000_100);
        repo.git(&["checkout", "-q", "--detach", &first]);
        let view = status(repo.path()).expect("status");
        assert_eq!(view.repo.branch, None);
        assert_eq!(view.repo.head.as_deref(), Some(first.as_str()));
    }

    #[test]
    fn status_runs_no_clean_filter_of_a_submodule_and_still_sees_its_commit_move() {
        let (Some(outer), Some(inner)) = (
            fixture::init("status-sub-filter"),
            fixture::init("status-sub-filter-inner"),
        ) else {
            return;
        };
        inner.write("a.txt", "one\n");
        inner.git(&["add", "."]);
        inner.commit("inner", 1_700_000_000);
        let url = inner.path().to_string_lossy().replace('\\', "/");
        outer.git(&[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            &url,
            "sub",
        ]);
        outer.commit("add sub", 1_700_000_100);
        let marker = outer.arm_clean_filter(".git/modules/sub");
        // Same size as the checkout (whose line endings follow the user's
        // global config): the submodule's status would have to hash it.
        let checkout = outer.path().join("sub").join("a.txt");
        let on_disk = std::fs::read_to_string(&checkout).expect("read checkout");
        outer.write("sub/a.txt", &on_disk.replace("one", "uno"));

        let view = status(outer.path()).expect("status");
        assert!(!marker.exists(), "the submodule's clean filter ran");
        assert_eq!(
            status_of(&view.tree, "sub"),
            None,
            "dirty content is ignored"
        );

        // A new commit checked out in the submodule is still a change.
        outer.git(&[
            "-C",
            "sub",
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "moved",
        ]);
        let view = status(outer.path()).expect("status");
        assert_eq!(status_of(&view.tree, "sub"), Some(StatusKind::Modified));
    }

    #[test]
    fn summary_counts_clean_and_dirty_without_running_repository_filters() {
        let Some(repo) = fixture::init("summary-filter") else {
            return;
        };
        repo.write("file.txt", "one\n");
        repo.git(&["add", "."]);
        repo.commit("initial", 1_700_000_000);
        assert_eq!(
            change_summary(repo.path()).unwrap(),
            Some(LocalChanges {
                changed: 0,
                truncated: false
            })
        );
        let marker = repo.arm_clean_filter(".git");
        repo.write("file.txt", "two\n");
        assert_eq!(
            change_summary(repo.path()).unwrap(),
            Some(LocalChanges {
                changed: 1,
                truncated: false
            })
        );
        assert!(!marker.exists(), "repository clean filter ran");
    }

    #[test]
    fn summary_cap_is_about_changed_paths_only() {
        assert_eq!(
            summarize_count(MAX_FILES),
            LocalChanges {
                changed: MAX_FILES,
                truncated: false
            }
        );
        assert_eq!(
            summarize_count(MAX_FILES + 1),
            LocalChanges {
                changed: MAX_FILES,
                truncated: true
            }
        );
    }

    #[test]
    fn status_outside_a_repository_is_an_error() {
        let dir =
            std::env::temp_dir().join(format!("omp-git-browser-not-a-repo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create dir");
        // The temp dir itself could sit inside a repo on odd setups; only
        // assert when discovery genuinely fails.
        if gix::discover(&dir).is_err() {
            let err = status(&dir).expect_err("not a repo");
            assert!(err.starts_with("not a git repository"), "{err}");
            assert_eq!(change_summary(&dir).unwrap(), None);
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
