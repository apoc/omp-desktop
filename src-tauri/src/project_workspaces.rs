//! Per-profile, per-source-project launch defaults.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};

use crate::{conversation_workspace::WorkspaceInfo, json_store, profiles};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceDefaults {
    pub base_ref: String,
    pub worktree: bool,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct WorkspaceFile {
    // Profile id -> canonical source project path -> defaults.
    profiles: BTreeMap<String, BTreeMap<String, WorkspaceDefaults>>,
}

pub struct WorkspaceDefaultsStore {
    file: Option<StoreFile>,
    cache: Mutex<WorkspaceFile>,
}

struct StoreFile {
    path: PathBuf,
    lock: PathBuf,
}

impl WorkspaceDefaultsStore {
    pub fn load(path: Option<PathBuf>) -> Self {
        let cache = path.as_deref().map_or_else(WorkspaceFile::default, |path| {
            json_store::read_strict(path).unwrap_or_else(|error| {
                eprintln!(
                    "[omp-desktop] {} unreadable, using workspace defaults: {error}",
                    path.display()
                );
                WorkspaceFile::default()
            })
        });
        Self {
            file: path.map(|path| StoreFile {
                lock: path.with_extension("lock"),
                path,
            }),
            cache: Mutex::new(cache),
        }
    }

    fn cached(&self) -> MutexGuard<'_, WorkspaceFile> {
        self.cache.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The caller resolves the profile and canonical source path before lookup.
    pub fn get(&self, project: &str, profile: Option<&str>) -> Option<WorkspaceDefaults> {
        // The reply owns its base ref while the cached configuration stays live.
        self.cached()
            .profiles
            .get(profile.unwrap_or(profiles::DEFAULT_PROFILE_ID))
            .and_then(|projects| projects.get(project))
            .cloned()
    }

    /// Save only a current local or remote branch ref, or remove the override.
    /// A preview is used for both ref validation and canonical source identity.
    pub fn set(
        &self,
        preview: &WorkspaceInfo,
        profile: Option<&str>,
        base_ref: Option<String>,
        worktree: bool,
    ) -> Result<Option<WorkspaceDefaults>, String> {
        let value = match base_ref {
            Some(base_ref) => {
                if !preview
                    .branches
                    .iter()
                    .any(|branch| branch.ref_name == base_ref)
                {
                    return Err(
                        "selected branch is unavailable; inspect the folder again".to_string()
                    );
                }
                Some(WorkspaceDefaults { base_ref, worktree })
            }
            None => None,
        };
        let profile = profile.unwrap_or(profiles::DEFAULT_PROFILE_ID);
        let project = preview.project_path.as_str();
        let modify = move |file: &mut WorkspaceFile| {
            if let Some(defaults) = value {
                if let Some(projects) = file.profiles.get_mut(profile) {
                    if let Some(current) = projects.get_mut(project) {
                        if *current == defaults {
                            return false;
                        }
                        *current = defaults;
                    } else {
                        projects.insert(project.to_string(), defaults);
                    }
                    return true;
                }
                let mut projects = BTreeMap::new();
                projects.insert(project.to_string(), defaults);
                file.profiles.insert(profile.to_string(), projects);
                true
            } else {
                let Some(projects) = file.profiles.get_mut(profile) else {
                    return false;
                };
                let changed = projects.remove(project).is_some();
                if projects.is_empty() {
                    file.profiles.remove(profile);
                }
                changed
            }
        };
        let Some(StoreFile { path, lock }) = &self.file else {
            let mut cached = self.cached();
            modify(&mut cached);
            // Return an owned snapshot independently of the in-memory store.
            return Ok(cached
                .profiles
                .get(profile)
                .and_then(|projects| projects.get(project))
                .cloned());
        };
        json_store::update_strict(path, lock, modify, |file| {
            // The response owns a base ref; the whole file then moves into cache.
            let result = file
                .profiles
                .get(profile)
                .and_then(|projects| projects.get(project))
                .cloned();
            *self.cached() = file;
            result
        })
    }

    #[cfg(test)]
    fn reopen(&self) -> Self {
        Self::load(self.file.as_ref().map(|file| {
            // A simulated new app instance owns its store path independently.
            file.path.clone()
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{conversation_workspace, git_browser::fixture};

    fn preview(repo: &fixture::Repo) -> WorkspaceInfo {
        conversation_workspace::inspect(repo.path().to_str().expect("UTF-8 path"))
            .expect("inspect repository")
    }

    fn defaults(name: &str, worktree: bool) -> WorkspaceDefaults {
        WorkspaceDefaults {
            base_ref: name.to_string(),
            worktree,
        }
    }

    #[test]
    fn settings_round_trip_and_separate_projects_and_profiles() {
        let Some(a) = fixture::init("workspace-default-a") else {
            return;
        };
        let Some(b) = fixture::init("workspace-default-b") else {
            return;
        };
        a.commit("initial", 1_700_000_000);
        b.commit("initial", 1_700_000_000);
        a.git(&["branch", "other"]);
        let a_info = preview(&a);
        let b_info = preview(&b);
        let path = a.path().join("project-workspaces.json");
        let store = WorkspaceDefaultsStore::load(Some(path));
        store
            .set(&a_info, None, Some("refs/heads/main".into()), true)
            .expect("default a");
        store
            .set(
                &a_info,
                Some("work"),
                Some("refs/heads/other".into()),
                false,
            )
            .expect("work a");
        store
            .set(&b_info, None, Some("refs/heads/main".into()), false)
            .expect("default b");
        let reloaded = store.reopen();
        assert_eq!(
            reloaded.get(&a_info.project_path, None),
            Some(defaults("refs/heads/main", true))
        );
        assert_eq!(
            reloaded.get(&a_info.project_path, Some("work")),
            Some(defaults("refs/heads/other", false))
        );
        assert_eq!(
            reloaded.get(&b_info.project_path, None),
            Some(defaults("refs/heads/main", false))
        );
        assert_eq!(reloaded.get(&b_info.project_path, Some("work")), None);
        reloaded.set(&a_info, None, None, false).expect("clear a");
        assert_eq!(reloaded.get(&a_info.project_path, None), None);
        assert_eq!(
            reloaded.get(&a_info.project_path, Some("work")),
            Some(defaults("refs/heads/other", false))
        );
    }

    #[test]
    fn memory_only_store_rejects_non_branch_refs_and_clears() {
        let Some(repo) = fixture::init("workspace-default-memory") else {
            return;
        };
        let head = repo.commit("initial", 1_700_000_000);
        let info = preview(&repo);
        let store = WorkspaceDefaultsStore::load(None);
        for invalid in ["HEAD", head.as_str(), "main", "refs/heads/missing"] {
            assert!(store.set(&info, None, Some(invalid.into()), true).is_err());
        }
        assert_eq!(store.get(&info.project_path, None), None);
        assert_eq!(
            store
                .set(&info, None, Some("refs/heads/main".into()), true)
                .expect("set"),
            Some(defaults("refs/heads/main", true))
        );
        assert_eq!(store.set(&info, None, None, true).expect("clear"), None);
        assert_eq!(
            WorkspaceDefaultsStore::load(None).get(&info.project_path, None),
            None
        );
    }

    #[test]
    fn linked_worktree_and_primary_checkout_share_source_defaults() {
        let Some(repo) = fixture::init("workspace-default-origin") else {
            return;
        };
        repo.write("sub/file", "tracked");
        repo.git(&["add", "sub/file"]);
        repo.commit("initial", 1_700_000_000);
        let linked = repo.path().join("linked-checkout");
        repo.git(&[
            "worktree",
            "add",
            "--detach",
            linked.to_str().expect("UTF-8 path"),
        ]);
        let source =
            conversation_workspace::inspect(repo.path().join("sub").to_str().expect("UTF-8 path"))
                .expect("inspect source");
        let linked_info =
            conversation_workspace::inspect(linked.join("sub").to_str().expect("UTF-8 path"))
                .expect("inspect linked worktree");
        assert_eq!(source.project_path, linked_info.project_path);
        assert_ne!(source.path, linked_info.path);
        let store = WorkspaceDefaultsStore::load(None);
        store
            .set(
                &linked_info,
                Some("work"),
                Some("refs/heads/main".into()),
                true,
            )
            .expect("set through linked checkout");
        assert_eq!(
            store.get(&source.project_path, Some("work")),
            Some(defaults("refs/heads/main", true))
        );
    }

    #[test]
    fn refs_are_revalidated_on_each_save_including_detached_and_remote() {
        let Some(repo) = fixture::init("workspace-default-refs") else {
            return;
        };
        let head = repo.commit("initial", 1_700_000_000);
        repo.git(&["update-ref", "refs/remotes/origin/main", &head]);
        repo.git(&["checkout", "--detach", &head]);
        let store = WorkspaceDefaultsStore::load(None);
        let detached = preview(&repo);
        assert_eq!(detached.current_branch, None);
        assert!(store
            .set(&detached, None, Some("HEAD".into()), true)
            .is_err());
        assert_eq!(
            store
                .set(
                    &detached,
                    None,
                    Some("refs/remotes/origin/main".into()),
                    true
                )
                .expect("remote branch"),
            Some(defaults("refs/remotes/origin/main", true))
        );
        repo.git(&["update-ref", "-d", "refs/remotes/origin/main"]);
        assert!(store
            .set(
                &preview(&repo),
                None,
                Some("refs/remotes/origin/main".into()),
                true
            )
            .is_err());
        assert_eq!(
            store.get(&detached.project_path, None),
            Some(defaults("refs/remotes/origin/main", true))
        );
    }

    #[test]
    fn independent_instances_do_not_overwrite_other_profile_changes() {
        let Some(repo) = fixture::init("workspace-default-concurrent") else {
            return;
        };
        repo.commit("initial", 1_700_000_000);
        let info = preview(&repo);
        let path = repo.path().join("project-workspaces.json");
        let first = WorkspaceDefaultsStore::load(Some(path));
        let second = first.reopen();
        first
            .set(&info, None, Some("refs/heads/main".into()), true)
            .expect("first");
        second
            .set(&info, Some("work"), Some("refs/heads/main".into()), false)
            .expect("second");
        let reloaded = first.reopen();
        assert_eq!(
            reloaded.get(&info.project_path, None),
            Some(defaults("refs/heads/main", true))
        );
        assert_eq!(
            reloaded.get(&info.project_path, Some("work")),
            Some(defaults("refs/heads/main", false))
        );
    }

    #[test]
    fn corrupt_settings_are_not_overwritten() {
        let Some(repo) = fixture::init("workspace-default-corrupt") else {
            return;
        };
        repo.commit("initial", 1_700_000_000);
        let info = preview(&repo);
        let path = repo.path().join("project-workspaces.json");
        std::fs::write(&path, b"not json").expect("write corrupt file");
        // The assertion below rereads these exact corrupt bytes after a refusal.
        let store = WorkspaceDefaultsStore::load(Some(path.clone()));
        assert_eq!(store.get(&info.project_path, None), None);
        assert!(store
            .set(&info, None, Some("refs/heads/main".into()), true)
            .is_err());
        assert_eq!(std::fs::read(path).expect("read corrupt file"), b"not json");
    }
}
