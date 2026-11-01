//! Serializes workspace preparation with tab registration and lifecycle.
mod admission;
mod inspect;
pub mod process;
mod runner;
#[cfg(test)]
mod tests;

pub use admission::{Admission, WorkspaceManager};
pub use inspect::WorkspaceInfo;
use ring::rand::{SecureRandom, SystemRandom};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const HEX: &[u8; 16] = b"0123456789abcdef";

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceOptions {
    pub base_ref: Option<String>,
    pub base_commit: Option<String>,
    pub worktree: bool,
    pub acknowledge_shared: bool,
}

/// The selected source and base, distinct from the tab's actual cwd.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceBinding {
    pub project_path: String,
    pub base_ref: Option<String>,
    pub base_commit: Option<String>,
    pub worktree: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResponse {
    pub approval_mode: String,
    pub path: String,
    pub workspace: Option<WorkspaceBinding>,
}
pub struct StartContext<'a> {
    pub data: Option<&'a Path>,
    pub manager: &'a WorkspaceManager,
    pub ticket: &'a Admission,
}

#[derive(Clone)]
pub struct Prepared {
    pub path: String,
    pub workspace: Option<WorkspaceBinding>,
    /// Resolved native profile, retained across close and session-file binding.
    pub profile: String,
    /// Catalog identity survives a missing or partially removed cwd.
    pub storage_id: Option<String>,
    default_cwd: Option<String>,
    terminal_cwd: Option<String>,
}

#[derive(Default)]
pub struct Registry {
    tabs: HashMap<String, Prepared>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatus {
    pub dirty: bool,
    pub owners: usize,
}

/// Metadata never acquires the lifecycle guard or scans the checkout.
pub fn inspect(path: &str) -> Result<WorkspaceInfo, String> {
    inspect::read(inspect::folder(path)?)
}

/// The scan runs outside the lifecycle guard. Ownership is advisory; startup
/// repeats both checks while holding the guard.
pub fn status(manager: &WorkspaceManager, path: &str) -> Result<WorkspaceStatus, String> {
    let path = inspect::folder(path)?;
    let identity = inspect::identity(&path)?;
    let dirty = inspect::dirty(&path)?;
    let owners = manager.lock().owners(&identity)?;
    Ok(WorkspaceStatus { dirty, owners })
}

impl Registry {
    pub fn get(&self, id: &str) -> Option<&Prepared> {
        self.tabs.get(id)
    }

    /// Move the rollback state while the caller retains the lifecycle guard.
    pub fn take_registration(&mut self, id: &str) -> Option<(String, Prepared)> {
        self.tabs.remove_entry(id)
    }

    /// A failed user close keeps the visible tab reserved, even when its
    /// children were already stopped before snapshot verification failed.
    pub fn retain_registration(&mut self, id: String, prepared: Prepared) {
        self.tabs.entry(id).or_insert(prepared);
    }

    pub fn set_profile(&mut self, id: &str, profile: &str) -> Result<(), String> {
        let prepared = self
            .tabs
            .get_mut(id)
            .ok_or_else(|| "conversation tab is no longer registered".to_string())?;
        prepared.profile.clear();
        prepared.profile.push_str(profile);
        Ok(())
    }

    pub fn set_storage_id(&mut self, id: &str, storage_id: Option<&str>) -> Result<(), String> {
        let prepared = self
            .tabs
            .get_mut(id)
            .ok_or_else(|| "conversation tab is no longer registered".to_string())?;
        if prepared.storage_id.as_deref() != storage_id {
            prepared.storage_id = storage_id.map(str::to_owned);
        }
        Ok(())
    }

    /// Unknown ownership is an error, never permission to remove a checkout.
    pub fn owners_for_path(&self, path: &str) -> Result<usize, String> {
        self.owners(&inspect::identity(path)?)
    }

    fn owners(&self, identity: &Path) -> Result<usize, String> {
        let mut owners = 0;
        for tab in self.tabs.values() {
            let cwd = if tab.path.is_empty() {
                tab.default_cwd.as_deref()
            } else {
                Some(tab.path.as_str())
            };
            // Re-discover the live folders: an agent may have initialized or
            // replaced a repository since its tab started. Unknown is not free.
            for folder in [cwd, tab.terminal_cwd.as_deref()].into_iter().flatten() {
                let folder = inspect::folder(folder)?;
                if inspect::identity(&folder)?.as_path() == identity {
                    owners += 1;
                    break;
                }
            }
        }
        Ok(owners)
    }

    #[cfg(test)]
    fn status(&self, path: &str) -> Result<WorkspaceStatus, String> {
        let path = inspect::folder(path)?;
        let identity = inspect::identity(&path)?;
        Ok(WorkspaceStatus {
            dirty: inspect::dirty(&path)?,
            owners: self.owners(&identity)?,
        })
    }

    pub fn release<S: AsRef<str>>(&mut self, ids: &[S]) {
        for id in ids {
            self.tabs.remove(id.as_ref());
        }
    }

    /// Include a registration even if an interrupted startup never reached
    /// terminal registration; cleanup must not strand its ownership.
    pub fn include_registered_ids(&self, ids: &mut Vec<String>) {
        for id in self.tabs.keys() {
            if !ids.contains(id) {
                // The cleanup snapshot outlives its borrow of the registry.
                ids.push(id.clone());
            }
        }
    }

    pub fn prepare_for_start(
        &mut self,
        id: &str,
        cwd: &str,
        options: Option<WorkspaceOptions>,
        context: StartContext<'_>,
    ) -> Result<Prepared, String> {
        let native = runner::Native::for_start(context.manager, context.ticket);
        self.prepare_with(id, cwd, options, context.data, &native)
    }

    #[cfg(test)]
    fn prepare(
        &mut self,
        id: &str,
        cwd: &str,
        options: Option<WorkspaceOptions>,
        data: Option<&Path>,
    ) -> Result<Prepared, String> {
        self.prepare_with(id, cwd, options, data, &runner::Native::default())
    }

    fn prepare_with(
        &mut self,
        id: &str,
        cwd: &str,
        options: Option<WorkspaceOptions>,
        data: Option<&Path>,
        runner: &impl runner::Runner,
    ) -> Result<Prepared, String> {
        if id.is_empty() {
            return Err("session id must not be empty".to_string());
        }
        let path = if cwd.is_empty() {
            String::new()
        } else {
            inspect::folder(cwd)?
        };
        if let Some(existing) = self.tabs.get(id) {
            if existing.path != path || options.is_some() {
                return Err("an existing tab cannot change its workspace".to_string());
            }
            // Return an owned response copy while the registry keeps its
            // original binding across profile/approval respawns.
            return Ok(existing.clone());
        }
        let prepared = if let Some(options) = options {
            if path.is_empty() {
                return Err("workspace requires a project folder".to_string());
            }
            self.prepare_selected(path, options, data, runner)?
        } else {
            // Pathless agents inherit the app cwd, while their terminal uses
            // home. Keep both actual folders so future ownership can be checked.
            let default_cwd = if path.is_empty() {
                let current = std::env::current_dir()
                    .map_err(|e| format!("cannot resolve default working directory: {e}"))?;
                Some(crate::external_open::canonical_folder(&current)?)
            } else {
                None
            };
            let terminal_cwd = if path.is_empty() {
                crate::widgets::config::home_dir()
                    .filter(|home| Path::new(home).is_absolute())
                    .and_then(|home| crate::external_open::canonical_folder(Path::new(&home)).ok())
            } else {
                None
            };
            Prepared {
                path,
                workspace: None,
                profile: crate::profiles::DEFAULT_PROFILE_ID.to_string(),
                storage_id: None,
                default_cwd,
                terminal_cwd,
            }
        };
        // Both the response and the registry own a binding: the latter must
        // outlive the start response until the tab and its children are closed.
        self.tabs.insert(id.to_string(), prepared.clone());
        Ok(prepared)
    }

    fn prepare_selected(
        &self,
        path: String,
        options: WorkspaceOptions,
        data: Option<&Path>,
        runner: &impl runner::Runner,
    ) -> Result<Prepared, String> {
        let mut info = inspect::read(path)?;
        let identity = PathBuf::from(info.repo_root.as_deref().unwrap_or(&info.path));
        let project_path = std::mem::take(&mut info.project_path);
        let actual = if info.repo_root.is_some() {
            let owners = if options.worktree {
                0
            } else {
                self.owners(&identity)?
            };
            selected_repo(info, &options, owners, data, runner)?
        } else {
            if options.worktree || options.base_ref.is_some() || options.base_commit.is_some() {
                return Err("a non-git folder has no branch or worktree".to_string());
            }
            if self.owners(&identity)? > 0 && !options.acknowledge_shared {
                return Err("acknowledge sharing the already owned workspace".to_string());
            }
            info.path
        };
        Ok(Prepared {
            path: actual,
            profile: crate::profiles::DEFAULT_PROFILE_ID.to_string(),
            storage_id: None,
            workspace: Some(WorkspaceBinding {
                project_path,
                base_ref: options.base_ref,
                base_commit: options.base_commit,
                worktree: options.worktree,
            }),
            default_cwd: None,
            terminal_cwd: None,
        })
    }
}

fn selected_repo(
    info: WorkspaceInfo,
    options: &WorkspaceOptions,
    owners: usize,
    data: Option<&Path>,
    runner: &impl runner::Runner,
) -> Result<String, String> {
    let root = Path::new(
        info.repo_root
            .as_deref()
            .ok_or_else(|| "repository has no working folder".to_string())?,
    );
    let (selected, commit) = match (options.base_ref.as_deref(), options.base_commit.as_deref()) {
        (None, None) if info.head.is_none() => (None, None),
        (Some("HEAD"), Some(commit))
            if info.current_branch.is_none() && info.head.as_deref() == Some(commit) =>
        {
            (None, Some(commit))
        }
        (Some(reference), Some(commit)) => {
            let branch = info
                .branches
                .iter()
                .find(|branch| branch.ref_name == reference && branch.commit == commit)
                .ok_or_else(|| {
                    "selected branch or commit changed; inspect the folder again".to_string()
                })?;
            (Some(branch), Some(commit))
        }
        _ => return Err("selected branch or commit changed; inspect the folder again".to_string()),
    };
    if options.worktree {
        let commit = commit.ok_or_else(|| "a worktree requires a committed base".to_string())?;
        return create_worktree(&info, root, data, commit, runner);
    }
    let same = selected.is_none_or(|branch| {
        !branch.remote && info.current_branch.as_deref() == Some(branch.name.as_str())
    });
    if selected.is_some_and(|branch| branch.remote) {
        return Err("remote branches require a worktree".to_string());
    }
    let dirty = inspect::dirty(&info.path)?;
    if same {
        if (dirty || owners > 0) && !options.acknowledge_shared {
            return Err("acknowledge sharing the dirty or already owned workspace".to_string());
        }
    } else {
        if dirty || owners > 0 {
            return Err("cannot switch a dirty or owned workspace; use a worktree".to_string());
        }
        let branch = selected.ok_or_else(|| "invalid branch selection".to_string())?;
        runner.switch(root, &branch.name).map_err(|e| {
            format!(
                "{e}. The source checkout may have changed at {}",
                root.display()
            )
        })?;
        let after = inspect::read(info.path).map_err(|e| {
            format!(
                "branch was switched in {} but the selected folder is unavailable: {e}",
                root.display()
            )
        })?;
        if after.current_branch.as_deref() != Some(branch.name.as_str())
            || after.head.as_deref() != commit
        {
            return Err(format!(
                "branch or commit changed while switching {}; inspect it again",
                root.display()
            ));
        }
        return Ok(after.path);
    }
    Ok(info.path)
}

fn create_worktree(
    info: &WorkspaceInfo,
    root: &Path,
    data: Option<&Path>,
    commit: &str,
    runner: &impl runner::Runner,
) -> Result<String, String> {
    let data = data
        .filter(|p| p.is_absolute())
        .ok_or_else(|| "no durable app data folder is available for worktrees".to_string())?;
    let worktrees = data.join("conversation-worktrees");
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|e| format!("cannot resolve source repository: {e}"))?;
    let resolved = crate::workspace::weakly_canonicalize(&worktrees)
        .map_err(|e| format!("cannot resolve worktree folder: {e}"))?;
    if resolved.starts_with(&canonical_root) {
        return Err("the app data worktree folder is inside the source repository".to_string());
    }
    crate::private_fs::private_dirs(true)
        .create(&worktrees)
        .map_err(|e| format!("cannot create worktree folder {}: {e}", worktrees.display()))?;
    let worktrees = std::fs::canonicalize(worktrees)
        .map_err(|e| format!("cannot resolve worktree folder: {e}"))?;
    if worktrees.starts_with(&canonical_root) {
        return Err("the app data worktree folder is inside the source repository".to_string());
    }
    // Drop Windows' verbatim prefix before passing the destination to Git.
    let worktrees = PathBuf::from(crate::external_open::canonical_folder(&worktrees)?);
    let mut random = [0u8; 16];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| "cannot generate a unique worktree name".to_string())?;
    let mut suffix = String::with_capacity(random.len() * 2);
    for byte in random {
        suffix.push(char::from(HEX[usize::from(byte >> 4)]));
        suffix.push(char::from(HEX[usize::from(byte & 15)]));
    }
    let name = format!("omp/conversation-{suffix}");
    let dest = worktrees.join(format!("conversation-{suffix}"));
    if dest.exists() || info.branches.iter().any(|b| b.name == name) {
        return Err("generated worktree name already exists; try again".to_string());
    }
    let artifacts = |error: String| {
        format!(
            "{error}. Worktree artifacts, if created, were retained at {} and branch {name}",
            dest.display()
        )
    };
    runner
        .worktree(root, &name, &dest, commit)
        .map_err(artifacts)?;
    let dest_text = inspect::folder(
        dest.to_str()
            .ok_or_else(|| artifacts("worktree path is not UTF-8".to_string()))?,
    )
    .map_err(artifacts)?;
    let actual_root = inspect::repo_root(Path::new(&dest_text)).map_err(artifacts)?;
    if actual_root.as_deref() != Some(dest_text.as_str()) {
        return Err(artifacts(
            "native command did not create an independent worktree".to_string(),
        ));
    }
    let actual = inspect::read(dest_text).map_err(artifacts)?;
    if actual.head.as_deref() != Some(commit)
        || actual.current_branch.as_deref() != Some(name.as_str())
    {
        return Err(artifacts(
            "native worktree has an unexpected branch or commit".to_string(),
        ));
    }
    let relative = Path::new(&info.path)
        .strip_prefix(root)
        .map_err(|_| artifacts("selected folder is outside its repository".to_string()))?;
    let folder = Path::new(&actual.path).join(relative);
    let mapped = inspect::folder(
        folder
            .to_str()
            .ok_or_else(|| artifacts("mapped folder is not UTF-8".to_string()))?,
    )
    .map_err(artifacts)?;
    if !Path::new(&mapped).starts_with(&actual.path) {
        return Err(artifacts(
            "mapped project folder escapes the worktree".to_string(),
        ));
    }
    Ok(mapped)
}
