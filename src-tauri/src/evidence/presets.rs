//! User-owned Evidence prompt presets and source-project defaults.
//!
//! The caller resolves a canonical *source* project before using it as a key;
//! a linked worktree and its source checkout therefore share an assignment.
//! Conversation policies are owned snapshots, never references into this store.

#[path = "presets_schema.rs"]
mod schema;
#[path = "presets_storage.rs"]
mod storage;

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

use ring::rand::{SecureRandom, SystemRandom};

use crate::{json_store, private_fs};
#[cfg(test)]
use schema::MAX_CONFIG_BYTES;
use schema::{
    standard, validate_preset, validate_project, PresetFile, MAX_PRESETS, MAX_PROJECTS,
    MAX_REVISION, STANDARD_ID,
};
pub use schema::{DefaultScope, Library, Preset, PresetInput, ResolvedPolicy};
use storage::{encode, read_file, unreadable};

struct StoreFile {
    path: PathBuf,
    lock: PathBuf,
}

struct Cache {
    data: PresetFile,
    warning: Option<String>,
}

/// Global library and canonical source-project assignments, shared across OMP profiles.
pub struct ConfigStore {
    file: Option<StoreFile>,
    cache: Mutex<Cache>,
}

impl ConfigStore {
    pub fn load(path: Option<PathBuf>) -> Self {
        let (data, warning) = path.as_deref().map_or_else(
            || (
                PresetFile::default(),
                Some("Evidence presets are kept in memory only because the app config folder is unavailable.".to_owned()),
            ),
            |path| match read_file(path) {
                Ok(data) => (data, None),
                Err(error) => (PresetFile::default(), Some(unreadable(path, &error))),
            },
        );
        Self {
            file: path.map(|path| StoreFile {
                lock: path.with_extension("lock"),
                path,
            }),
            cache: Mutex::new(Cache { data, warning }),
        }
    }

    fn cached(&self) -> MutexGuard<'_, Cache> {
        self.cache.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `project` is the canonical source-project identity resolved by the caller.
    pub fn library(&self, project: Option<&str>) -> Library {
        let cache = self.cached();
        let file = &cache.data;
        let mut presets = Vec::with_capacity(file.presets.len() + 1);
        presets.push(standard());
        // The returned library is independent of both the cache and active policies.
        presets.extend(file.presets.iter().cloned());
        Library {
            revision: file.revision,
            presets,
            // The cache retains these assignments after the response is sent.
            global_default: file.global_default.clone(),
            project_default: project.and_then(|key| file.projects.get(key).cloned()),
            project: project.map(str::to_owned),
            resolved: file.resolve(project),
            // The warning remains available to other callers of the library.
            warning: cache.warning.clone(),
        }
    }

    /// Returns an owned policy; later preset edits cannot change the snapshot.
    pub fn resolve(&self, project: Option<&str>) -> ResolvedPolicy {
        self.cached().data.resolve(project)
    }

    pub fn save(&self, input: PresetInput, expected_revision: u64) -> Result<Preset, String> {
        self.update(expected_revision, move |file| {
            let PresetInput {
                id,
                name,
                planning_prompt,
                collection_prompt,
                assessment_prompt,
                triggers,
                tracking,
                handoff,
            } = input;
            let existing = match id.as_deref() {
                Some(STANDARD_ID) => return Err("the Standard preset cannot be edited".to_owned()),
                Some(id) => Some(
                    file.presets
                        .iter()
                        .position(|preset| preset.id == id)
                        .ok_or_else(|| "preset not found".to_owned())?,
                ),
                None => None,
            };
            if existing.is_none() && file.presets.len() >= MAX_PRESETS {
                return Err("preset library is full".to_owned());
            }
            let mut preset = Preset {
                id: match id {
                    Some(id) => id,
                    None => new_id()?,
                },
                name,
                revision: existing.map_or(1, |index| file.presets[index].revision),
                planning_prompt,
                collection_prompt,
                assessment_prompt,
                triggers,
                tracking,
                handoff,
            };
            validate_preset(&preset)?;
            if let Some(index) = existing {
                if file.presets[index] == preset {
                    return Ok((preset, false));
                }
                preset.revision = next_revision(preset.revision)?;
                // The cache and the caller each own their version of this preset.
                file.presets[index] = preset.clone();
            } else {
                if file.contains(&preset.id) {
                    return Err("generated preset id already exists; try again".to_owned());
                }
                // The cache and the caller each own their version of this preset.
                file.presets.push(preset.clone());
            }
            Ok((preset, true))
        })
    }

    pub fn delete(&self, id: &str, expected_revision: u64) -> Result<(), String> {
        self.update(expected_revision, |file| {
            if id == STANDARD_ID {
                return Err("the Standard preset cannot be deleted".to_owned());
            }
            let index = file
                .presets
                .iter()
                .position(|preset| preset.id == id)
                .ok_or_else(|| "preset not found".to_owned())?;
            if file.global_default.as_deref() == Some(id)
                || file.projects.values().any(|assigned| assigned == id)
            {
                return Err(
                    "preset is assigned as a default; reset its assignments before deleting it"
                        .to_owned(),
                );
            }
            file.presets.remove(index);
            Ok(((), true))
        })
    }

    pub fn assign(
        &self,
        scope: DefaultScope,
        preset_id: Option<&str>,
        project: Option<&str>,
        expected_revision: u64,
    ) -> Result<(), String> {
        self.update(expected_revision, |file| {
            if let Some(id) = preset_id {
                if !file.contains(id) {
                    return Err("preset not found".to_owned());
                }
            }
            let changed = match scope {
                DefaultScope::Global => {
                    if file.global_default.as_deref() == preset_id {
                        false
                    } else {
                        file.global_default = preset_id.map(str::to_owned);
                        true
                    }
                }
                DefaultScope::Project => {
                    let project =
                        project.ok_or_else(|| "a source project is required".to_owned())?;
                    validate_project(project)?;
                    match preset_id {
                        Some(id)
                            if file
                                .projects
                                .get(project)
                                .is_some_and(|current| current.as_str() == id) =>
                        {
                            false
                        }
                        Some(id) => {
                            if !file.projects.contains_key(project)
                                && file.projects.len() >= MAX_PROJECTS
                            {
                                return Err("project defaults are full".to_owned());
                            }
                            file.projects.insert(project.to_owned(), id.to_owned());
                            true
                        }
                        None => file.projects.remove(project).is_some(),
                    }
                }
            };
            Ok(((), changed))
        })
    }

    fn update<R>(
        &self,
        expected_revision: u64,
        modify: impl FnOnce(&mut PresetFile) -> Result<(R, bool), String>,
    ) -> Result<R, String> {
        let Some(StoreFile { path, lock }) = &self.file else {
            let mut cache = self.cached();
            check_revision(cache.data.revision, expected_revision)?;
            // A failed mutation or size check must leave the memory-only store unchanged.
            let mut next = cache.data.clone();
            let (result, changed) = modify(&mut next)?;
            if changed {
                next.revision = next_revision(next.revision)?;
                encode(&next)?;
                cache.data = next;
            }
            drop(cache);
            return Ok(result);
        };
        if let Some(parent) = path.parent().filter(|dir| !dir.as_os_str().is_empty()) {
            private_fs::private_dirs(true)
                .create(parent)
                .map_err(|error| format!("could not create preset config directory: {error}"))?;
        }
        json_store::with_lock_str(lock, || {
            let mut data = match read_file(path) {
                Ok(data) => data,
                Err(error) => {
                    let warning = unreadable(path, &error);
                    // Both the caller and subsequent library reads need this diagnostic.
                    self.cached().warning = Some(warning.clone());
                    return Err(warning);
                }
            };
            if let Err(error) = check_revision(data.revision, expected_revision) {
                let mut cache = self.cached();
                cache.data = data;
                cache.warning = None;
                drop(cache);
                return Err(error);
            }
            let (result, changed) = modify(&mut data)?;
            if changed {
                data.revision = next_revision(data.revision)?;
                let bytes = encode(&data)?;
                let temp = path.with_extension(format!("{}.tmp", random_hex()?));
                private_fs::write_private_via(path, &temp, &bytes)
                    .map_err(|error| format!("could not write preset library: {error}"))?;
            }
            // Commit the cache under the same cross-process lock as the write.
            let mut cache = self.cached();
            cache.data = data;
            cache.warning = None;
            drop(cache);
            Ok(result)
        })
    }
}

fn check_revision(actual: u64, expected: u64) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err(format!("preset library changed (expected revision {expected}, current revision {actual}); refresh and try again"))
    }
}

fn next_revision(revision: u64) -> Result<u64, String> {
    revision
        .checked_add(1)
        .filter(|next| *next <= MAX_REVISION)
        .ok_or_else(|| "preset revision limit reached".to_owned())
}

fn random_hex() -> Result<String, String> {
    let mut random = [0_u8; 16];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| "could not generate a secure preset identifier".to_owned())?;
    Ok(json_store::hex_lower(&random))
}

fn new_id() -> Result<String, String> {
    random_hex().map(|suffix| format!("preset-{suffix}"))
}

#[cfg(test)]
#[path = "presets_tests.rs"]
mod tests;
