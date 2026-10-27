use gix::bstr::ByteSlice as _;
use std::path::{Path, PathBuf};

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub ref_name: String,
    pub commit: String,
    pub remote: bool,
}

/// Metadata only: no worktree status, file tree or history traversal.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub path: String,
    pub project_path: String,
    pub repo_root: Option<String>,
    pub current_branch: Option<String>,
    pub head: Option<String>,
    pub branches: Vec<Branch>,
    pub defaults: Option<crate::project_workspaces::WorkspaceDefaults>,
}

pub(super) fn folder(path: &str) -> Result<String, String> {
    if path.is_empty() || !Path::new(path).is_absolute() {
        return Err("workspace path must be an absolute folder".to_string());
    }
    crate::external_open::canonical_folder(Path::new(path))
}

/// A missing repository is normal, but a broken/inaccessible one is not.
fn discover(path: &Path) -> Result<Option<(crate::spawn_gate::Shared, gix::Repository)>, String> {
    let gate = crate::spawn_gate::shared();
    #[allow(clippy::disallowed_methods)] // gix's own subprocesses hold the gate
    match gix::discover(path) {
        Ok(repo) => Ok(Some((gate, repo))),
        Err(gix::discover::Error::Discover(
            gix::discover::upwards::Error::NoGitRepository { .. }
            | gix::discover::upwards::Error::NoGitRepositoryWithinFs { .. }
            | gix::discover::upwards::Error::NoGitRepositoryWithinCeiling { .. },
        )) => Ok(None),
        Err(e) => Err(format!("cannot inspect repository: {e}")),
    }
}

pub(super) fn repo_root(path: &Path) -> Result<Option<String>, String> {
    let Some((_gate, repo)) = discover(path)? else {
        return Ok(None);
    };
    let root = repo
        .workdir()
        .ok_or_else(|| "repository has no working tree".to_string())?;
    crate::external_open::canonical_folder(root).map(Some)
}

fn branches(repo: &gix::Repository) -> Result<Vec<Branch>, String> {
    use gix::refs::Category;
    let platform = repo
        .references()
        .map_err(|e| format!("cannot read refs: {e}"))?;
    let refs = platform
        .all()
        .map_err(|e| format!("cannot read refs: {e}"))?;
    let mut branches = Vec::new();
    for reference in refs {
        let mut reference = reference.map_err(|e| format!("cannot read ref: {e}"))?;
        if reference.target().try_name().is_some() {
            continue;
        }
        let remote = match reference.name().category() {
            Some(Category::LocalBranch) => false,
            Some(Category::RemoteBranch) => true,
            _ => continue,
        };
        let full = reference
            .name()
            .as_bstr()
            .to_str()
            .map_err(|_| "branch name is not UTF-8".to_string())?
            .to_string();
        let name = reference
            .name()
            .shorten()
            .to_str()
            .map_err(|_| "branch name is not UTF-8".to_string())?
            .to_string();
        let id = reference
            .peel_to_id()
            .map_err(|e| format!("cannot resolve {full}: {e}"))?
            .detach();
        repo.find_commit(id)
            .map_err(|e| format!("branch {full} is not a commit: {e}"))?;
        branches.push(Branch {
            name,
            ref_name: full,
            commit: id.to_string(),
            remote,
        });
    }
    branches.sort_by(|a, b| (a.remote, &a.name).cmp(&(b.remote, &b.name)));
    Ok(branches)
}

/// Resolve a linked worktree to its primary checkout only when the candidate
/// really opens the same common repository. A missing original remains usable
/// as the selected folder; this never rewrites persisted tab metadata.
fn project_path(repo: &gix::Repository, root: &str, path: &str) -> Result<String, String> {
    let common = std::fs::canonicalize(repo.common_dir())
        .map_err(|e| format!("cannot resolve common git directory: {e}"))?;
    let git_dir = std::fs::canonicalize(repo.git_dir())
        .map_err(|e| format!("cannot resolve git directory: {e}"))?;
    if common == git_dir || common.file_name() != Some(std::ffi::OsStr::new(".git")) {
        return Ok(path.to_string());
    }
    let Some(primary) = common.parent() else {
        return Ok(path.to_string());
    };
    let relative = Path::new(path)
        .strip_prefix(root)
        .map_err(|_| "selected folder is outside its repository".to_string())?;
    let candidate = primary.join(relative);
    let Ok(candidate) = crate::external_open::canonical_folder(&candidate) else {
        return Ok(path.to_string());
    };
    let Ok(primary) = crate::external_open::canonical_folder(primary) else {
        return Ok(path.to_string());
    };
    if !Path::new(&candidate).starts_with(&primary) {
        return Ok(path.to_string());
    }
    let Some((_gate, source)) = discover(Path::new(&candidate))? else {
        return Ok(path.to_string());
    };
    let Some(source_root) = source.workdir() else {
        return Ok(path.to_string());
    };
    let source_root = crate::external_open::canonical_folder(source_root)?;
    let source_common = std::fs::canonicalize(source.common_dir())
        .map_err(|e| format!("cannot resolve source git directory: {e}"))?;
    if source_root == primary && source_common == common {
        Ok(candidate)
    } else {
        Ok(path.to_string())
    }
}

pub(super) fn read(path: String) -> Result<WorkspaceInfo, String> {
    let Some((_gate, repo)) = discover(Path::new(&path))? else {
        // The metadata reply owns both its execution path and source identity.
        return Ok(WorkspaceInfo {
            project_path: path.clone(),
            path,
            repo_root: None,
            current_branch: None,
            head: None,
            branches: Vec::new(),
            defaults: None,
        });
    };
    let root = repo
        .workdir()
        .ok_or_else(|| "repository has no working tree".to_string())?;
    let repo_root = crate::external_open::canonical_folder(root)?;
    let project_path = project_path(&repo, &repo_root, &path)?;
    let head = repo.head().map_err(|e| format!("cannot read HEAD: {e}"))?;
    let current_branch = head.referent_name().map(|name| name.shorten().to_string());
    let head = if head.is_unborn() {
        None
    } else {
        Some(
            repo.head_id()
                .map_err(|e| format!("cannot resolve HEAD: {e}"))?
                .to_string(),
        )
    };
    Ok(WorkspaceInfo {
        path,
        project_path,
        repo_root: Some(repo_root),
        current_branch,
        head,
        branches: branches(&repo)?,
        defaults: None,
    })
}

/// Reads both status layers without rename detection. The direct worktree
/// visitor stops the scan at the first change and joins gix's workers before
/// returning; dropping gix's status iterator instead detaches them and could
/// release the spawn gate while a trusted filter is still running.
fn dirty_repo(repo: &gix::Repository) -> Result<bool, String> {
    use gix::status::plumbing::index_as_worktree_with_renames::{Entry, VisitEntry};
    use std::sync::atomic::{AtomicBool, Ordering};

    struct FirstChange<'a>(&'a AtomicBool);
    impl<'index> VisitEntry<'index> for FirstChange<'_> {
        type ContentChange = ();
        type SubmoduleStatus = gix::submodule::Status;

        fn visit_entry(&mut self, entry: Entry<'index, (), gix::submodule::Status>) {
            if entry.summary().is_some() {
                self.0.store(true, Ordering::Relaxed);
            }
        }
    }

    let index = repo
        .index_or_empty()
        .map_err(|e| format!("cannot read index: {e}"))?;
    let tree = repo
        .head_tree_id_or_empty()
        .map_err(|e| format!("cannot read HEAD tree: {e}"))?;
    let mut pathspec = repo
        .pathspec(
            false,
            None::<&str>,
            false,
            &index,
            gix::worktree::stack::state::attributes::Source::IdMapping,
        )
        .map_err(|e| format!("cannot configure status paths: {e}"))?;
    let mut staged = false;
    repo.tree_index_status(
        &tree,
        &index,
        Some(&mut pathspec),
        gix::status::tree_index::TrackRenames::Disabled,
        |_, _, _| {
            staged = true;
            Ok::<_, std::convert::Infallible>(std::ops::ControlFlow::Break(()))
        },
    )
    .map_err(|e| format!("cannot compare index: {e}"))?;
    if staged {
        return Ok(true);
    }
    let dirwalk = repo
        .dirwalk_options()
        .map_err(|e| format!("cannot configure status: {e}"))?
        .emit_untracked(gix::dir::walk::EmissionMode::CollapseDirectory)
        .empty_patterns_match_prefix(false);
    let options = gix::status::index_worktree::Options {
        dirwalk_options: Some(dirwalk),
        ..Default::default()
    };
    // The submodule checker owns a repository handle for its worker threads.
    let submodules = gix::status::index_worktree::BuiltinSubmoduleStatus::new(
        repo.clone().into_sync(),
        gix::status::Submodule::Given {
            ignore: gix::submodule::config::Ignore::Dirty,
            check_dirty: false,
        },
    )
    .map_err(|e| format!("cannot inspect submodules: {e}"))?;
    let interrupted = AtomicBool::new(false);
    let result = repo.index_worktree_status(
        &index,
        None::<gix::bstr::BString>,
        &mut FirstChange(&interrupted),
        gix::status::plumbing::index_as_worktree::traits::FastEq,
        submodules,
        &mut gix::progress::Discard,
        &interrupted,
        options,
    );
    if interrupted.load(Ordering::Relaxed) {
        Ok(true)
    } else {
        result.map_err(|e| format!("status failed: {e}"))?;
        Ok(false)
    }
}

/// Open every initialized submodule separately with repository-provided
/// filters stripped; never descend through gix's unsanitized submodule reads.
fn dirty_submodules(repo: &gix::Repository, root: &Path, depth: usize) -> Result<bool, String> {
    if depth > 32 {
        return Err("submodules are nested too deeply to inspect safely".to_string());
    }
    let index = repo
        .index_or_empty()
        .map_err(|e| format!("cannot read index: {e}"))?;
    let mut submodules = index
        .entries()
        .iter()
        .filter(|entry| entry.mode.is_submodule())
        .peekable();
    if submodules.peek().is_none() {
        return Ok(false);
    }
    let canonical_root =
        std::fs::canonicalize(root).map_err(|e| format!("cannot resolve repository: {e}"))?;
    for entry in submodules {
        let rel = entry
            .path(&index)
            .to_str()
            .map_err(|_| "submodule path is not UTF-8".to_string())?;
        let sub = root.join(rel);
        if !sub.join(".git").exists() {
            continue;
        }
        let canonical =
            std::fs::canonicalize(&sub).map_err(|e| format!("cannot resolve submodule: {e}"))?;
        if !canonical.starts_with(&canonical_root) {
            return Err("submodule escapes repository".to_string());
        }
        let (_gate, nested, nested_root) = crate::git_browser::open(&canonical)?;
        if std::fs::canonicalize(&nested_root)
            .map_err(|e| format!("cannot resolve submodule root: {e}"))?
            != canonical
        {
            return Err("submodule resolved to a different repository".to_string());
        }
        // Check the gitlink ourselves as well: gix's submodule enumerator
        // can skip invalid module paths and its HEAD lookup can hide errors.
        let nested_head = nested
            .head_id()
            .map_err(|e| format!("cannot resolve submodule HEAD: {e}"))?;
        if nested_head.detach() != entry.id {
            return Ok(true);
        }
        if dirty_repo(&nested)? || dirty_submodules(&nested, &nested_root, depth + 1)? {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) fn dirty(path: &str) -> Result<bool, String> {
    let Some(root) = repo_root(Path::new(path))? else {
        return Ok(false);
    };
    let (_gate, repo, root) = crate::git_browser::open(Path::new(&root))?;
    Ok(dirty_repo(&repo)? || dirty_submodules(&repo, &root, 0)?)
}

pub(super) fn identity(path: &str) -> Result<PathBuf, String> {
    Ok(repo_root(Path::new(path))?.map_or_else(|| PathBuf::from(path), PathBuf::from))
}
