//! Git repository introspection — branch discovery and HEAD-file location.
//!
//! Uses [`gix`] (pure-Rust gitoxide) with no C-library dependency.
//! All functions are infallible from the caller's perspective: errors
//! (not a git repo, detached HEAD, I/O failures) collapse to `None`.

use std::path::{Path, PathBuf};

/// What [`probe`] finds for a folder; every field `None` outside a git
/// repository.
#[derive(Debug, Default)]
pub struct Probe {
    /// The short current branch name (`None` when HEAD is detached).
    pub branch: Option<String>,
    /// The absolute path to `.git/HEAD`, the watch target.
    pub head: Option<PathBuf>,
    /// The repository's work tree (`None` for a bare one): tabs on folders
    /// of one repository share it, which is what a branch switch changes.
    pub root: Option<String>,
}

/// Open the nearest git repository containing `path` and read its branch,
/// HEAD file and work tree in one discovery. Holds the spawn gate: gix may
/// run `git` to find its installation config.
pub fn probe(path: &Path) -> Probe {
    let Ok((_gate, repo)) = crate::spawn_gate::discover(path) else {
        return Probe::default();
    };
    Probe {
        branch: repo
            .head_name()
            .ok()
            .flatten()
            .map(|n| n.shorten().to_string()),
        head: Some(repo.git_dir().join("HEAD")),
        root: repo.workdir().map(|dir| dir.to_string_lossy().into_owned()),
    }
}
