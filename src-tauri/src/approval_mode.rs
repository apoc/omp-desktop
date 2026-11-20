//! omp's tool approval mode, as the desktop chooses it per spawn:
//! `<app config dir>/approval-mode.json`.
//!
//! ```json
//! { "version": 1, "default": "write", "projects": { "/abs/canonical/path": "yolo" } }
//! ```
//!
//! `default` applies to every project without an entry in `projects`, keyed
//! by the canonical project folder (the tab's `entry.path`). `start_session`
//! resolves the mode for the tab's folder and always passes it as
//! `--approval-mode=<mode>` (`agent::spawn::omp_args`): omp's own default is
//! `yolo`, which a desktop must never inherit silently. omp has no RPC to
//! change the mode of a running process; the frontend restarts a tab (with
//! `--resume`) to apply a change.
//!
//! Same failure policy as `program_setting.rs` (the terminal's and browser's
//! program settings): an unreadable or malformed
//! file reads as the defaults, but a change refuses to overwrite it
//! (`json_store::update_strict`). Without a config folder the choice lives
//! in memory only.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};

use omp_desktop_core::json_store;

/// omp's `--approval-mode` values (omp `docs/approval-mode.md`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalMode {
    /// Only `read`-tier tools run without a prompt.
    AlwaysAsk,
    /// `read`- and `write`-tier tools run without a prompt; the desktop's
    /// default since before this setting existed.
    #[default]
    Write,
    /// Every tool runs without a prompt, omp's critical-command stop included.
    Yolo,
}

impl ApprovalMode {
    /// The omp argv token selecting this mode (a single `--flag=value`).
    pub const fn flag(self) -> &'static str {
        match self {
            Self::AlwaysAsk => "--approval-mode=always-ask",
            Self::Write => "--approval-mode=write",
            Self::Yolo => "--approval-mode=yolo",
        }
    }

    /// The wire/file spelling (`"always-ask" | "write" | "yolo"`).
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AlwaysAsk => "always-ask",
            Self::Write => "write",
            Self::Yolo => "yolo",
        }
    }
}

/// Exact kebab-case spellings only: the IPC boundary's parser.
impl FromStr for ApprovalMode {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "always-ask" => Ok(Self::AlwaysAsk),
            "write" => Ok(Self::Write),
            "yolo" => Ok(Self::Yolo),
            _ => Err(format!(
                "unknown approval mode {s:?} (expected always-ask, write or yolo)"
            )),
        }
    }
}

/// The on-disk shape. Unknown keys are dropped on the next write; add a
/// field here before writing a new one.
#[derive(Serialize, Deserialize)]
#[serde(default)]
struct ApprovalModeFile {
    version: u32,
    default: ApprovalMode,
    projects: BTreeMap<String, ApprovalMode>,
}

impl Default for ApprovalModeFile {
    fn default() -> Self {
        Self {
            version: 1,
            default: ApprovalMode::default(),
            projects: BTreeMap::new(),
        }
    }
}

/// What the `approval_mode_*` commands return.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalModeView {
    pub default: ApprovalMode,
    /// Canonical project folder → its override.
    pub projects: BTreeMap<String, ApprovalMode>,
}

impl ApprovalModeView {
    fn of(file: &ApprovalModeFile) -> Self {
        Self {
            default: file.default,
            // The view leaves the lock for the IPC reply; the store keeps its own.
            projects: file.projects.clone(),
        }
    }
}

/// `approval-mode.json` plus its in-memory copy.
pub struct ApprovalModeStore {
    /// `None` when the app has no config folder: the choice then lives in
    /// memory only.
    file: Option<StoreFile>,
    cache: Mutex<ApprovalModeFile>,
}

struct StoreFile {
    path: PathBuf,
    /// `path.with_extension("lock")`, computed once.
    lock: PathBuf,
}

/// The `projects` key for `root`: its canonical form, or the raw path when
/// canonicalisation fails (a folder that is gone), like
/// `approval::project_key`.
fn project_key(root: &Path) -> String {
    root.canonicalize()
        .unwrap_or_else(|_| root.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

impl ApprovalModeStore {
    /// Read `path` once (a missing or unreadable file reads as the defaults).
    pub fn load(path: Option<PathBuf>) -> Self {
        let file = path
            .as_deref()
            .map_or_else(ApprovalModeFile::default, |path| {
                json_store::read_strict(path).unwrap_or_else(|e| {
                    eprintln!(
                        "[omp-desktop] {} unreadable, using the default approval mode: {e}",
                        path.display()
                    );
                    ApprovalModeFile::default()
                })
            });
        Self {
            file: path.map(|path| StoreFile {
                lock: path.with_extension("lock"),
                path,
            }),
            cache: Mutex::new(file),
        }
    }

    /// The cache. Every write replaces whole fields of a consistent value,
    /// so poison is ignored.
    fn cached(&self) -> MutexGuard<'_, ApprovalModeFile> {
        self.cache.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The stored default and overrides.
    pub fn view(&self) -> ApprovalModeView {
        ApprovalModeView::of(&self.cached())
    }

    /// The mode a tab in `project_root` spawns with: its override, else the
    /// default. Canonicalises `project_root` (a syscall).
    pub fn resolve(&self, project_root: Option<&Path>) -> ApprovalMode {
        let key = project_root
            .filter(|root| !root.as_os_str().is_empty())
            .map(project_key);
        let file = self.cached();
        key.and_then(|key| file.projects.get(&key).copied())
            .unwrap_or(file.default)
    }

    /// Store the default for every project without an override. Blocking
    /// file I/O.
    pub fn set_default(&self, mode: ApprovalMode) -> Result<ApprovalModeView, String> {
        self.update(|file| {
            let changed = file.default != mode;
            file.default = mode;
            changed
        })
    }

    /// Store `root`'s override, or remove it (`None`: the project follows
    /// the default). `root` must be absolute. Blocking file I/O.
    pub fn set_project(
        &self,
        root: &Path,
        mode: Option<ApprovalMode>,
    ) -> Result<ApprovalModeView, String> {
        if !root.is_absolute() {
            return Err(format!(
                "project folder must be an absolute path: {:?}",
                root.display().to_string()
            ));
        }
        let key = project_key(root);
        self.update(move |file| match mode {
            Some(mode) => file.projects.insert(key, mode) != Some(mode),
            None => file.projects.remove(&key).is_some(),
        })
    }

    /// Apply `modify` to the file (or the cache alone without one) and
    /// return the result. Refuses to replace a file it cannot read.
    fn update(
        &self,
        modify: impl FnOnce(&mut ApprovalModeFile) -> bool,
    ) -> Result<ApprovalModeView, String> {
        let Some(StoreFile { path, lock }) = &self.file else {
            let mut cache = self.cached();
            modify(&mut cache);
            return Ok(ApprovalModeView::of(&cache));
        };
        json_store::update_strict(
            path,
            lock,
            modify,
            // Under the file lock, so the cache follows the file's order.
            |file| {
                let view = ApprovalModeView::of(&file);
                *self.cached() = file;
                view
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn scratch_dir() -> PathBuf {
        let n = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "omp-desktop-approval-mode-test-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    const ALL: [ApprovalMode; 3] = [
        ApprovalMode::AlwaysAsk,
        ApprovalMode::Write,
        ApprovalMode::Yolo,
    ];

    #[test]
    fn flag_as_str_and_parse_round_trip() {
        for mode in ALL {
            assert_eq!(mode.flag(), format!("--approval-mode={}", mode.as_str()));
            assert_eq!(mode.as_str().parse::<ApprovalMode>(), Ok(mode));
            assert_eq!(
                serde_json::to_value(mode).expect("serialize"),
                serde_json::json!(mode.as_str())
            );
        }
        assert_eq!(ApprovalMode::default(), ApprovalMode::Write);
    }

    #[test]
    fn parse_rejects_anything_but_the_exact_spellings() {
        for bad in ["Write", "auto", "", "always_ask", "AlwaysAsk", " yolo"] {
            let err = bad.parse::<ApprovalMode>().expect_err(bad);
            assert!(err.contains("unknown approval mode"), "{err}");
        }
    }

    #[test]
    fn resolve_without_overrides_is_the_default() {
        let store = ApprovalModeStore::load(None);
        assert_eq!(store.resolve(None), ApprovalMode::Write);
        assert_eq!(store.resolve(Some(Path::new(""))), ApprovalMode::Write);
        assert_eq!(
            store.resolve(Some(Path::new("/no/such/project"))),
            ApprovalMode::Write
        );
    }

    #[test]
    fn project_override_beats_the_default_for_that_project_only() {
        let a = scratch_dir();
        let b = scratch_dir();
        let store = ApprovalModeStore::load(None);
        store.set_default(ApprovalMode::AlwaysAsk).expect("default");
        let view = store
            .set_project(&a, Some(ApprovalMode::Yolo))
            .expect("project");
        assert_eq!(view.default, ApprovalMode::AlwaysAsk);
        let key = a
            .canonicalize()
            .expect("canon")
            .to_string_lossy()
            .into_owned();
        assert_eq!(view.projects.get(&key), Some(&ApprovalMode::Yolo));
        assert_eq!(store.resolve(Some(&a)), ApprovalMode::Yolo);
        assert_eq!(store.resolve(Some(&b)), ApprovalMode::AlwaysAsk);
        assert_eq!(store.resolve(None), ApprovalMode::AlwaysAsk);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_matches_a_symlinked_path_by_its_canonical_folder() {
        let dir = scratch_dir();
        let real = dir.join("real");
        std::fs::create_dir(&real).expect("real dir");
        let link = dir.join("link");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        let store = ApprovalModeStore::load(None);
        store
            .set_project(&link, Some(ApprovalMode::Yolo))
            .expect("set via link");
        assert_eq!(store.resolve(Some(&real)), ApprovalMode::Yolo);
        assert_eq!(store.resolve(Some(&link)), ApprovalMode::Yolo);
        let key = real
            .canonicalize()
            .expect("canon")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            store.view().projects.keys().collect::<Vec<_>>(),
            vec![&key],
            "keyed by the canonical folder, not the link"
        );
    }

    #[test]
    fn set_project_rejects_a_relative_or_empty_root() {
        let store = ApprovalModeStore::load(None);
        assert!(store
            .set_project(Path::new(""), Some(ApprovalMode::Yolo))
            .is_err());
        assert!(store
            .set_project(Path::new("relative/dir"), Some(ApprovalMode::Yolo))
            .is_err());
        assert!(store.view().projects.is_empty());
    }

    #[test]
    fn set_and_remove_persist_across_a_reload() {
        let dir = scratch_dir();
        let project = scratch_dir();
        let path = dir.join("approval-mode.json");
        let store = ApprovalModeStore::load(Some(dir.join("approval-mode.json")));
        store.set_default(ApprovalMode::Yolo).expect("default");
        store
            .set_project(&project, Some(ApprovalMode::AlwaysAsk))
            .expect("project");

        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).expect("read")).expect("json");
        let key = project
            .canonicalize()
            .expect("canon")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            raw,
            serde_json::json!({
                "version": 1,
                "default": "yolo",
                "projects": { key.as_str(): "always-ask" }
            })
        );

        let reloaded = ApprovalModeStore::load(Some(dir.join("approval-mode.json")));
        assert_eq!(reloaded.view(), store.view());
        assert_eq!(reloaded.resolve(Some(&project)), ApprovalMode::AlwaysAsk);

        let view = reloaded.set_project(&project, None).expect("remove");
        assert!(view.projects.is_empty());
        let again = ApprovalModeStore::load(Some(path));
        assert_eq!(again.resolve(Some(&project)), ApprovalMode::Yolo);
        assert!(again.view().projects.is_empty());
    }

    #[test]
    fn an_unchanged_set_does_not_create_the_file() {
        let dir = scratch_dir();
        let path = dir.join("approval-mode.json");
        let store = ApprovalModeStore::load(Some(dir.join("approval-mode.json")));
        store.set_default(ApprovalMode::Write).expect("no-op");
        store.set_project(&dir, None).expect("no-op remove");
        assert!(!path.exists());
    }

    #[test]
    fn a_malformed_file_reads_as_defaults_and_refuses_writes() {
        let dir = scratch_dir();
        let path = dir.join("approval-mode.json");
        std::fs::write(&path, b"{ \"default\": \"auto\" }").expect("write");
        let store = ApprovalModeStore::load(Some(dir.join("approval-mode.json")));
        assert_eq!(store.resolve(None), ApprovalMode::Write);
        let err = store
            .set_default(ApprovalMode::Yolo)
            .expect_err("must refuse");
        assert!(err.contains("unreadable"), "{err}");
        assert_eq!(
            std::fs::read(&path).expect("read"),
            b"{ \"default\": \"auto\" }",
            "the user's file is left alone"
        );
        assert_eq!(store.resolve(None), ApprovalMode::Write);
    }

    #[test]
    fn a_missing_field_reads_as_its_default() {
        let dir = scratch_dir();
        let path = dir.join("approval-mode.json");
        std::fs::write(&path, b"{ \"default\": \"yolo\" }").expect("write");
        let store = ApprovalModeStore::load(Some(path));
        assert_eq!(store.resolve(None), ApprovalMode::Yolo);
        assert!(store.view().projects.is_empty());
    }

    #[test]
    fn view_serializes_to_the_ipc_shape() {
        // An absolute path on every platform: `/no/such/project` is relative
        // on Windows (no drive), which `set_project` refuses.
        let project = std::env::temp_dir().join("no-such-project");
        let key = project.to_str().expect("utf-8 temp path").to_string();
        let store = ApprovalModeStore::load(None);
        store
            .set_project(&project, Some(ApprovalMode::Yolo))
            .expect("set");
        assert_eq!(
            serde_json::to_value(store.view()).expect("serialize"),
            serde_json::json!({ "default": "write", "projects": { key: "yolo" } })
        );
    }
}
