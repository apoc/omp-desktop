use super::catalog::{absolute, valid_workspace_root, Record};
use gix::bstr::ByteSlice as _;
use std::io::Read as _;
use std::path::{Path, PathBuf};

pub(super) struct Identity {
    pub root: PathBuf,
    pub cwd: PathBuf,
    pub source: PathBuf,
    pub project: PathBuf,
    pub common: PathBuf,
    pub gitdir: PathBuf,
    pub branch: Option<String>,
    pub head: String,
}

fn canonical(path: &Path) -> Result<PathBuf, String> {
    let value = crate::external_open::canonical_folder(path)?;
    Ok(PathBuf::from(value))
}

pub(super) fn worktrees(data: &Path) -> Result<PathBuf, String> {
    let path = data.join("conversation-worktrees");
    let meta = std::fs::symlink_metadata(&path)
        .map_err(|e| format!("cannot access managed worktree root: {e}"))?;
    if !meta.file_type().is_dir() || super::measurement::is_link(&meta) {
        return Err("managed worktree root is not an owned directory".into());
    }
    let resolved = canonical(&path)?;
    if resolved.parent() != Some(data) {
        return Err("managed worktree root escapes app data".into());
    }
    Ok(resolved)
}

/// The linked Git directory and its backlink must both identify the same
/// direct app-managed worktree, and the source must share its common Git dir.
pub(super) fn inspect(data: &Path, cwd: &Path, project: &Path) -> Result<Option<Identity>, String> {
    inspect_inner(data, cwd, project, None)
}

fn inspect_inner(
    data: &Path,
    cwd: &Path,
    project: &Path,
    known_source: Option<&Path>,
) -> Result<Option<Identity>, String> {
    if !absolute(cwd) || !absolute(project) {
        return Err("workspace and project paths must be absolute".into());
    }
    let cwd = canonical(cwd)?;
    let Some((_gate, repo)) = crate::git_browser::discover_optional(&cwd)? else {
        return Ok(None);
    };
    let Some(repo_root) = repo.workdir() else {
        return Ok(None);
    };
    let root = canonical(repo_root)?;
    let worktrees = match worktrees(data) {
        Ok(root) => root,
        Err(_) if !root.starts_with(data.join("conversation-worktrees")) => return Ok(None),
        Err(e) => return Err(e),
    };
    if !valid_workspace_root(&root, &worktrees) {
        return Ok(None);
    }
    let dotgit = root.join(".git");
    let metadata = std::fs::symlink_metadata(&dotgit)
        .map_err(|e| format!("cannot inspect worktree link: {e}"))?;
    if !metadata.file_type().is_file() || super::measurement::is_link(&metadata) {
        return Err("managed checkout must be a linked worktree".into());
    }
    let common = canonical(repo.common_dir())?;
    let gitdir = canonical(repo.git_dir())?;
    let parent = gitdir
        .parent()
        .ok_or_else(|| "invalid linked git directory".to_string())?;
    if parent != common.join("worktrees") || gitdir == common {
        return Err("linked git directory is outside its source repository".into());
    }
    check_backlink(&gitdir, &dotgit)?;
    let project = match std::fs::symlink_metadata(project) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && known_source.is_some() => {
            project.to_path_buf()
        }
        Err(e) => return Err(format!("cannot inspect source project folder: {e}")),
        Ok(_) => canonical(project)?,
    };
    let source_location = known_source.unwrap_or(&project);
    let Some((_source_gate, source_repo)) = crate::git_browser::discover_optional(source_location)?
    else {
        return Err("source project is not a Git repository".into());
    };
    let source = canonical(
        source_repo
            .workdir()
            .ok_or_else(|| "source has no checkout".to_string())?,
    )?;
    if root.starts_with(&source)
        || source.starts_with(&worktrees)
        || canonical(source_repo.common_dir())? != common
    {
        return Err("managed worktree source identity does not match".into());
    }
    let relative = cwd
        .strip_prefix(&root)
        .map_err(|_| "workspace path escapes its checkout".to_string())?;
    let source_project = source.join(relative);
    let source_project = match std::fs::symlink_metadata(&source_project) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && known_source.is_some() => {
            source_project
        }
        Err(e) => return Err(format!("cannot inspect mapped source folder: {e}")),
        Ok(_) => canonical(&source_project)?,
    };
    if source_project != project {
        return Err("workspace and source subdirectories do not match".into());
    }
    let head = repo
        .head_id()
        .map_err(|e| format!("cannot resolve worktree HEAD: {e}"))?
        .to_string();
    repo.find_commit(
        repo.head_id()
            .map_err(|e| format!("cannot read worktree HEAD: {e}"))?
            .detach(),
    )
    .map_err(|e| format!("worktree HEAD is not a commit: {e}"))?;
    let head_ref = repo
        .head()
        .map_err(|e| format!("cannot read worktree HEAD: {e}"))?;
    let branch = head_ref
        .referent_name()
        .map(|name| name.shorten().to_str().map(str::to_string))
        .transpose()
        .map_err(|_| "branch name is not UTF-8".to_string())?;
    Ok(Some(Identity {
        root,
        cwd,
        source,
        project,
        common,
        gitdir,
        branch,
        head,
    }))
}

fn check_backlink(gitdir: &Path, dotgit: &Path) -> Result<(), String> {
    let backlink_path = gitdir.join("gitdir");
    let backlink_meta = std::fs::symlink_metadata(&backlink_path)
        .map_err(|e| format!("cannot inspect worktree backlink: {e}"))?;
    if !backlink_meta.is_file()
        || super::measurement::is_link(&backlink_meta)
        || backlink_meta.len() > 8192
    {
        return Err("invalid or unsafe worktree backlink".into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NOFOLLOW);
    let backlink_file = options
        .open(backlink_path)
        .map_err(|e| format!("cannot read worktree backlink: {e}"))?;
    let mut backlink = String::new();
    backlink_file
        .take(8193)
        .read_to_string(&mut backlink)
        .map_err(|e| format!("cannot read worktree backlink: {e}"))?;
    if backlink.len() > 8192 {
        return Err("invalid worktree backlink".into());
    }
    let backlink = PathBuf::from(backlink.trim());
    let backlink = if backlink.is_absolute() {
        backlink
    } else {
        gitdir.join(backlink)
    };
    if std::fs::canonicalize(backlink)
        .map_err(|e| format!("cannot resolve worktree backlink: {e}"))?
        != std::fs::canonicalize(dotgit)
            .map_err(|e| format!("cannot resolve worktree link: {e}"))?
    {
        return Err("worktree backlink does not match the managed checkout".into());
    }
    Ok(())
}

pub(super) fn recheck(data: &Path, record: &Record) -> Result<Identity, String> {
    let identity = inspect_inner(
        data,
        Path::new(&record.path),
        Path::new(&record.project_path),
        Some(Path::new(&record.source_root)),
    )?
    .ok_or_else(|| "checkout is no longer an app-managed linked worktree".to_string())?;
    if identity.root != Path::new(&record.root)
        || identity.source != Path::new(&record.source_root)
        || identity.common != Path::new(&record.common_dir)
        || identity.project != Path::new(&record.project_path)
    {
        return Err("workspace or source repository identity changed".into());
    }
    Ok(identity)
}

pub(super) fn text(path: &Path) -> Result<String, String> {
    path.to_str()
        .filter(|s| s.len() <= 8192)
        .map(str::to_string)
        .ok_or_else(|| "workspace path is not representable".into())
}
