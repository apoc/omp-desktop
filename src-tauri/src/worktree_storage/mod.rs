//! Durable worktree catalog and verified recovery points.
//!
//! Lifecycle/active-owner exclusion is held by the caller. Filesystem scans
//! detect concurrent changes, but cannot fence uncooperative external writers.
mod catalog;
mod files;
mod git;
mod identity;
mod measurement;
mod snapshot;
#[cfg(test)]
mod tests;
mod undo;
#[cfg(test)]
mod undo_tests;
#[cfg(windows)]
mod windows_security;

use catalog::{same_session, Catalog, Record, MAX_RECORDS};
pub use catalog::{Policy, StorageView, WorkspaceView};
use ring::rand::{SecureRandom as _, SystemRandom};
use std::collections::HashMap;
use std::io::Read as _;
use std::path::{Path, PathBuf};

const MAX_CATALOG: u64 = 32 * 1024 * 1024;

struct SizeMeasurement {
    root: PathBuf,
    result: Result<u64, String>,
}

/// Run only outside the workspace lifecycle and Store locks.
pub fn measure_bytes(root: &Path) -> Result<u64, String> {
    if !catalog::absolute(root) {
        return Err("workspace path must be absolute".into());
    }
    measurement::bytes(root)
}

pub struct Store {
    data: Option<PathBuf>,
    storage: Option<PathBuf>,
    catalog: Catalog,
    fingerprint: Option<String>,
    measurements: HashMap<String, SizeMeasurement>,
    measurement_generation: HashMap<String, u64>,
    error: Option<String>,
}

fn random_id() -> Result<String, String> {
    let mut random = [0; 16];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| "cannot generate a recovery identifier".to_string())?;
    Ok(crate::json_store::hex_lower(&random))
}

fn private_directory(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_dir() && !measurement::is_link(&meta) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                if meta.permissions().mode() & 0o077 != 0 {
                    return Err("private recovery storage is accessible to other users".into());
                }
            }
            Ok(())
        }
        Ok(_) => Err("private storage path is not a directory".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            crate::private_fs::private_dirs(false)
                .create(path)
                .map_err(|e| format!("cannot create private storage directory: {e}"))
        }
        Err(e) => Err(format!("cannot inspect private storage directory: {e}")),
    }?;
    #[cfg(target_os = "macos")]
    files::check_private_storage(path)?;
    Ok(())
}

fn write_private(path: &Path, temp: &Path, bytes: &[u8]) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(temp)
            .map_err(|e| format!("cannot create private recovery file: {e}"))?;
        let result = (|| {
            files::check_private_storage(temp)?;
            file.write_all(bytes)
                .map_err(|e| format!("cannot write private recovery file: {e}"))?;
            file.sync_all()
                .map_err(|e| format!("cannot sync private recovery file: {e}"))?;
            std::fs::rename(temp, path)
                .map_err(|e| format!("cannot commit private recovery file: {e}"))
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temp);
        }
        result
    }
    #[cfg(not(target_os = "macos"))]
    {
        crate::private_fs::write_private_via(path, temp, bytes)
            .map_err(|e| format!("cannot write private recovery file: {e}"))
    }
}

#[cfg(windows)]
fn verify_storage_privacy(root: &Path) -> Result<(), String> {
    let mut pending = vec![root.to_path_buf()];
    let mut count = 0usize;
    while let Some(path) = pending.pop() {
        count += 1;
        if count > 1_000_000 {
            return Err("private recovery storage has too many entries".into());
        }
        windows_security::verify_private(&path)?;
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("cannot inspect private recovery storage: {e}"))?;
        if metadata.file_type().is_symlink() || (!metadata.is_dir() && !metadata.is_file()) {
            return Err("private recovery storage contains an unsupported entry".into());
        }
        if metadata.is_dir() {
            for entry in std::fs::read_dir(&path)
                .map_err(|e| format!("cannot inspect private recovery storage: {e}"))?
            {
                pending.push(
                    entry
                        .map_err(|e| format!("cannot inspect private recovery storage: {e}"))?
                        .path(),
                );
            }
        }
    }
    Ok(())
}

fn sync_dir(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    std::fs::File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|e| format!("cannot sync storage directory: {e}"))?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn read_catalog(path: &Path) -> Result<(Catalog, Option<String>), String> {
    let meta = match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Catalog::default(), None))
        }
        Err(e) => return Err(format!("cannot inspect workspace catalog: {e}")),
        Ok(meta) => meta,
    };
    if !meta.file_type().is_file() || measurement::is_link(&meta) || meta.len() > MAX_CATALOG {
        return Err("workspace catalog is unsafe or too large; writes are disabled".into());
    }
    #[cfg(target_os = "macos")]
    files::check_private_storage(path)?;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|e| format!("cannot open workspace catalog: {e}"))?
        .take(MAX_CATALOG + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("cannot read workspace catalog: {e}"))?;
    if bytes.len() as u64 > MAX_CATALOG {
        return Err("workspace catalog exceeds size limit".into());
    }
    let value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("workspace catalog is corrupt; writes are disabled: {e}"))?;
    Ok((value, Some(crate::json_store::hex_sha256(&bytes))))
}

impl Store {
    /// No in-memory or temporary fallback: unavailable/corrupt state is sticky.
    pub fn load(data: Option<PathBuf>) -> Self {
        let load = || -> Result<(PathBuf, PathBuf, Catalog, Option<String>), String> {
            let data = data
                .as_deref()
                .filter(|p| catalog::absolute(p))
                .ok_or_else(|| "durable app data folder is unavailable".to_string())?;
            crate::private_fs::private_dirs(true)
                .create(data)
                .map_err(|e| format!("cannot create app data folder: {e}"))?;
            let data = PathBuf::from(crate::external_open::canonical_folder(data)?);
            let storage = data.join("worktree-storage");
            private_directory(&storage)?;
            #[cfg(windows)]
            {
                windows_security::ensure_private_directory(&storage)?;
                verify_storage_privacy(&storage)?;
            }
            let (catalog, fingerprint) = read_catalog(&storage.join("catalog.json"))?;
            // An evicted-only installation may have lost the now-empty
            // managed container; recreate that private container, not any
            // checkout within it.
            let worktrees = data.join("conversation-worktrees");
            catalog.validate(&worktrees)?;
            if !catalog.records.is_empty() {
                match std::fs::symlink_metadata(&worktrees) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        crate::private_fs::private_dirs(false)
                            .create(&worktrees)
                            .map_err(|e| format!("cannot recreate managed worktree root: {e}"))?;
                    }
                    Err(error) => {
                        return Err(format!("cannot inspect managed worktree root: {error}"))
                    }
                    Ok(_) => {}
                }
                if identity::worktrees(&data)? != worktrees {
                    return Err("managed worktree root changed".into());
                }
            }
            Ok((data, storage, catalog, fingerprint))
        };
        match load() {
            Ok((data, storage, catalog, fingerprint)) => Self {
                data: Some(data),
                storage: Some(storage),
                catalog,
                fingerprint,
                error: None,
                measurements: HashMap::new(),
                measurement_generation: HashMap::new(),
            },
            Err(error) => Self {
                data: None,
                storage: None,
                catalog: Catalog::default(),
                fingerprint: None,
                error: Some(error),
                measurements: HashMap::new(),
                measurement_generation: HashMap::new(),
            },
        }
    }

    fn paths(&self) -> Result<(&Path, &Path), String> {
        if let Some(error) = &self.error {
            return Err(error.clone());
        }
        match (&self.data, &self.storage) {
            (Some(data), Some(storage)) => {
                let metadata = std::fs::symlink_metadata(storage)
                    .map_err(|e| format!("cannot inspect private storage: {e}"))?;
                if !metadata.file_type().is_dir()
                    || measurement::is_link(&metadata)
                    || Path::new(&crate::external_open::canonical_folder(storage)?)
                        != data.join("worktree-storage")
                {
                    return Err("private storage directory changed or escaped app data".into());
                }
                #[cfg(target_os = "macos")]
                files::check_private_storage(storage)?;
                Ok((data, storage))
            }
            _ => Err("durable workspace storage is unavailable".into()),
        }
    }

    fn persist(&mut self, next: Catalog) -> Result<(), String> {
        let (data, storage) = self.paths()?;
        let worktrees = data.join("conversation-worktrees");
        if next.records.is_empty() {
            next.validate(&worktrees)?;
        } else {
            next.validate(&identity::worktrees(data)?)?;
        }
        let bytes = serde_json::to_vec(&next)
            .map_err(|e| format!("cannot serialize workspace catalog: {e}"))?;
        if bytes.len() as u64 > MAX_CATALOG {
            return Err("workspace catalog exceeds size limit".into());
        }
        let catalog_path = storage.join("catalog.json");
        let temp = storage.join(format!("catalog-{}.tmp", random_id()?));
        let lock = storage.join("catalog.lock");
        let expected = &self.fingerprint;
        crate::json_store::with_lock_str(&lock, || {
            let (_, actual) = read_catalog(&catalog_path)?;
            if &actual != expected {
                return Err("workspace catalog changed externally; reload before writing".into());
            }
            write_private(&catalog_path, &temp, &bytes)?;
            sync_dir(storage)
        })?;
        self.fingerprint = Some(crate::json_store::hex_sha256(&bytes));
        self.catalog = next;
        Ok(())
    }

    // A transaction copy is required so a failed atomic write cannot publish
    // a mutation in memory which the durable catalog never committed.
    fn transaction<T>(
        &mut self,
        modify: impl FnOnce(&mut Catalog) -> Result<T, String>,
    ) -> Result<T, String> {
        self.paths()?;
        let mut next = self.catalog.clone();
        let result = modify(&mut next)?;
        self.persist(next)?;
        Ok(result)
    }

    fn record(&self, id: &str) -> Result<&Record, String> {
        self.paths()?;
        self.catalog
            .records
            .iter()
            .find(|r| r.id == id)
            .ok_or_else(|| "workspace not found".into())
    }

    fn record_view(&self, record: &Record) -> WorkspaceView {
        let mut view = record.view();
        if !record.evicted {
            if let Some(measurement) = self
                .measurements
                .get(&record.id)
                .filter(|entry| entry.root == Path::new(&record.root))
            {
                match &measurement.result {
                    Ok(bytes) => {
                        view.bytes = *bytes;
                        view.size_known = true;
                    }
                    Err(error) => view.measurement_error = Some(error.clone()),
                }
            }
        }
        view
    }

    fn relative_view(&self, record: &Record, relative: &str) -> Result<WorkspaceView, String> {
        let relative = Path::new(relative);
        if !catalog::valid_relative(relative) {
            return Err("invalid workspace session cwd alias".into());
        }
        let mut view = self.record_view(record);
        if relative.as_os_str().is_empty() {
            view.path.clone_from(&record.root);
            view.project_path.clone_from(&record.source_root);
        } else {
            view.path = identity::text(&Path::new(&record.root).join(relative))?;
            view.project_path = identity::text(&Path::new(&record.source_root).join(relative))?;
        }
        Ok(view)
    }

    fn cwd_view(&self, record: &Record, cwd: &Path) -> Result<WorkspaceView, String> {
        let relative = catalog::relative_cwd(Path::new(&record.root), cwd)?;
        if cwd.exists() {
            let (_gate, repo) = crate::git_browser::discover_optional(cwd)?
                .ok_or_else(|| "workspace session cwd has no repository".to_string())?;
            let root = repo
                .workdir()
                .ok_or_else(|| "workspace session cwd has no checkout".to_string())?;
            if crate::external_open::canonical_folder(root)? != record.root {
                return Err("workspace session cwd belongs to a nested repository".into());
            }
        }
        self.relative_view(record, &relative)
    }

    fn alias_view(&self, record: &Record, alias: &catalog::Alias) -> Result<WorkspaceView, String> {
        alias.relative_cwd.as_ref().map_or_else(
            || Ok(self.record_view(record)),
            |relative| self.relative_view(record, relative),
        )
    }

    /// Fast catalog lookup; it never recursively examines a checkout.
    pub fn workspace(&self, id: &str) -> Result<WorkspaceView, String> {
        Ok(self.record_view(self.record(id)?))
    }

    fn invalidate_measurement(&mut self, id: &str) {
        self.measurements.remove(id);
        let generation = self
            .measurement_generation
            .entry(id.to_string())
            .or_default();
        *generation = generation.saturating_add(1);
    }

    fn diagnostic(&mut self, id: &str, error: &str) {
        if !self.catalog.records.iter().any(|record| record.id == id) {
            return;
        }
        let bounded = crate::text::prefix_within(error, 2000).to_string();
        if let Err(write_error) = self.transaction(|catalog| {
            if let Some(record) = catalog.records.iter_mut().find(|r| r.id == id) {
                record.error = Some(bounded);
            }
            Ok(())
        }) {
            self.error = Some(format!(
                "Workspace failure: {error}; could not persist its diagnostic: {write_error}"
            ));
        }
    }

    pub fn register(
        &mut self,
        profile: &str,
        cwd: &Path,
        project_path: &Path,
        session_file: Option<&Path>,
        now_ms: u64,
    ) -> Result<Option<WorkspaceView>, String> {
        crate::profiles::validate_id(profile)?;
        let mut alias = session_file
            .filter(|file| catalog::uuid_prefix(file).is_none())
            .map(|file| catalog::session(profile, file))
            .transpose()?;
        let prefix_owner = match session_file.filter(|file| catalog::uuid_prefix(file).is_some()) {
            Some(file) => self.find_session(profile, file)?,
            None => None,
        };
        // A registered source branch may since have deleted the selected
        // project subdirectory. Its stored repository identity, not current
        // source-tree contents, is authoritative for an existing workspace.
        if let Some(existing) = self.find_path(cwd)? {
            if existing.state != "present" {
                return Err(
                    "this checkout has an unfinished removal; its recovery point remains available"
                        .into(),
                );
            }
            if !catalog::absolute(project_path) {
                return Err("source project path must be absolute".into());
            }
            let project = match std::fs::symlink_metadata(project_path) {
                Ok(_) => PathBuf::from(crate::external_open::canonical_folder(project_path)?),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => project_path.to_path_buf(),
                Err(e) => return Err(format!("cannot inspect source project folder: {e}")),
            };
            if Path::new(&existing.project_path) != project {
                return Err("source project identity changed".into());
            }
            if prefix_owner
                .as_ref()
                .is_some_and(|owner| owner.id != existing.id)
            {
                return Err("session is already bound to another workspace".into());
            }
            if let Some(alias) = alias {
                self.bind_alias(&existing.id, alias, cwd)?;
            }
            self.invalidate_measurement(&existing.id);
            return self.cwd_view(self.record(&existing.id)?, cwd).map(Some);
        }
        let (data, _) = self.paths()?;
        let Some(identity) = identity::inspect(data, cwd, project_path)? else {
            return Ok(None);
        };
        let root = identity::text(&identity.root)?;
        let path = identity::text(&identity.cwd)?;
        if let Some(owner) = prefix_owner {
            if self.record(&owner.id)?.root != root {
                return Err("session is already bound to another workspace".into());
            }
        }
        if let Some(existing) = self.catalog.records.iter().find(|r| r.root == root) {
            if existing.evicted {
                return Err(
                    "this checkout has an unfinished removal; its recovery point remains available"
                        .into(),
                );
            }
            // End the catalog borrow before binding and invalidating through `self`.
            let id = existing.id.clone();
            if let Some(alias) = alias {
                self.bind_alias(&id, alias, cwd)?;
            }
            self.invalidate_measurement(&id);
            return self.cwd_view(self.record(&id)?, cwd).map(Some);
        }
        if self.catalog.records.len() >= MAX_RECORDS {
            return Err("workspace catalog record limit reached".into());
        }
        let id = random_id()?;
        if let Some(alias) = &mut alias {
            alias.relative_cwd = Some(catalog::relative_cwd(&identity.root, &identity.cwd)?);
        }
        let record = Record {
            id,
            root,
            path,
            path_aliases: Vec::new(),
            project_path: identity::text(&identity.project)?,
            source_root: identity::text(&identity.source)?,
            common_dir: identity::text(&identity.common)?,
            profile: profile.to_string(),
            branch: identity.branch,
            commit: Some(identity.head),
            evicted: false,
            pinned: false,
            closed_at_ms: None,
            last_used_at_ms: now_ms,
            bytes: 0,
            aliases: alias.into_iter().collect(),
            snapshots: Vec::new(),
            error: None,
        };
        let view = record.view();
        self.transaction(|catalog| {
            catalog.records.push(record);
            Ok(())
        })?;
        Ok(Some(view))
    }

    pub fn find_path(&self, cwd: &Path) -> Result<Option<WorkspaceView>, String> {
        let (data, _) = self.paths()?;
        if !catalog::absolute(cwd) {
            return Err("workspace path must be absolute".into());
        }
        let cwd = if cwd.exists() {
            PathBuf::from(crate::external_open::canonical_folder(cwd)?)
        } else {
            cwd.to_path_buf()
        };
        let worktrees = data.join("conversation-worktrees");
        let Ok(relative) = cwd.strip_prefix(&worktrees) else {
            return Ok(None);
        };
        let Some(first) = relative.components().next() else {
            return Ok(None);
        };
        let candidate_root = worktrees.join(first.as_os_str());
        let candidate = self
            .catalog
            .records
            .iter()
            .find(|record| Path::new(&record.root) == candidate_root)
            .or_else(|| {
                self.catalog.records.iter().find(|record| {
                    record
                        .path_aliases
                        .iter()
                        .any(|path| Path::new(path).starts_with(&candidate_root))
                })
            });
        let Some(record) = candidate else {
            return Ok(None);
        };
        match std::fs::symlink_metadata(&candidate_root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(Some(self.record_view(record)))
            }
            Err(error) => Err(format!("cannot inspect workspace path: {error}")),
            Ok(_) if !record.evicted && Path::new(&record.root) == candidate_root => {
                identity::recheck(data, record)?;
                self.cwd_view(record, &cwd).map(Some)
            }
            // An old alias is not authority over a later, unrelated checkout.
            Ok(_) => Ok(None),
        }
    }

    pub fn find_session(
        &self,
        profile: &str,
        file: &Path,
    ) -> Result<Option<WorkspaceView>, String> {
        self.paths()?;
        crate::profiles::validate_id(profile)?;
        if let Some(prefix) = catalog::uuid_prefix(file) {
            let mut found = None;
            for record in &self.catalog.records {
                for alias in &record.aliases {
                    if alias.profile == profile
                        && catalog::filename_uuid(&alias.file)
                            .is_some_and(|id| id.starts_with(&prefix))
                    {
                        if found.is_some() {
                            return Err("native session prefix is ambiguous".into());
                        }
                        found = Some(self.alias_view(record, alias)?);
                    }
                }
            }
            return Ok(found);
        }
        let alias = catalog::session(profile, file)?;
        for record in &self.catalog.records {
            if let Some(bound) = record
                .aliases
                .iter()
                .find(|bound| same_session(bound, &alias))
            {
                return self.alias_view(record, bound).map(Some);
            }
        }
        Ok(None)
    }

    fn bind_alias(
        &mut self,
        id: &str,
        mut alias: catalog::Alias,
        cwd: &Path,
    ) -> Result<(), String> {
        let record = self.record(id)?;
        self.cwd_view(record, cwd)?;
        alias.relative_cwd = Some(catalog::relative_cwd(Path::new(&record.root), cwd)?);
        if self
            .catalog
            .records
            .iter()
            .any(|r| r.id != id && r.aliases.iter().any(|a| same_session(a, &alias)))
        {
            return Err("session is already bound to another workspace".into());
        }
        if record.aliases.iter().any(|a| {
            a.profile == alias.profile
                && a.file == alias.file
                && a.relative_cwd == alias.relative_cwd
        }) {
            return Ok(());
        }
        self.transaction(|catalog| {
            let record = catalog
                .records
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            // Moved JSONL paths with the same UUID are aliases of the same
            // native conversation, not separate workspace ownership.
            if let Some(existing) = record.aliases.iter_mut().find(|a| same_session(a, &alias)) {
                *existing = alias;
            } else {
                record.aliases.push(alias);
            }
            Ok(())
        })
    }

    pub fn bind_session(
        &mut self,
        id: &str,
        profile: &str,
        file: &Path,
        cwd: &Path,
    ) -> Result<(), String> {
        if let Some(prefix) = catalog::uuid_prefix(file) {
            self.cwd_view(self.record(id)?, cwd)?;
            let found = self.find_session(profile, file)?;
            if found.as_ref().is_some_and(|record| record.id != id) {
                return Err("session is already bound to another workspace".into());
            }
            if found.is_some() {
                // The transaction needs an owned alias while the catalog keeps
                // its previous copy until the atomic update is committed.
                let alias = self
                    .record(id)?
                    .aliases
                    .iter()
                    .find(|alias| {
                        alias.profile == profile
                            && catalog::filename_uuid(&alias.file)
                                .is_some_and(|uuid| uuid.starts_with(&prefix))
                    })
                    .cloned()
                    .ok_or_else(|| "native session alias disappeared".to_string())?;
                return self.bind_alias(id, alias, cwd);
            }
            // An unresolved prefix is not a durable identity; bind when the
            // native session reports its actual JSONL filename.
            return Ok(());
        }
        self.bind_alias(id, catalog::session(profile, file)?, cwd)
    }

    pub fn touch(&mut self, id: &str, now_ms: u64) -> Result<(), String> {
        self.transaction(|catalog| {
            let record = catalog
                .records
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            record.last_used_at_ms = record.last_used_at_ms.max(now_ms);
            Ok(())
        })?;
        self.invalidate_measurement(id);
        Ok(())
    }

    pub fn keep(&mut self, id: &str, now_ms: u64) -> Result<WorkspaceView, String> {
        let view = self.transaction(|catalog| {
            let record = catalog
                .records
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            if record.evicted {
                return Err("cannot keep a removed checkout".into());
            }
            record.closed_at_ms = Some(now_ms);
            record.last_used_at_ms = record.last_used_at_ms.max(now_ms);
            record.error = None;
            Ok(record.view())
        })?;
        self.invalidate_measurement(id);
        Ok(view)
    }

    pub fn set_pin(&mut self, id: &str, pinned: bool) -> Result<(), String> {
        self.transaction(|catalog| {
            let record = catalog
                .records
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            record.pinned = pinned;
            Ok(())
        })
    }

    pub fn set_policy(&mut self, policy: Policy) -> Result<(), String> {
        policy.validate()?;
        self.transaction(|catalog| {
            catalog.policy = policy;
            Ok(())
        })
    }

    pub fn due(&self, now_ms: u64) -> Result<Vec<String>, String> {
        self.paths()?;
        Ok(self
            .catalog
            .records
            .iter()
            .filter(|r| r.due(now_ms))
            .map(|r| r.id.clone())
            .collect())
    }

    pub fn is_due(&self, id: &str, now_ms: u64) -> Result<bool, String> {
        self.paths()?;
        Ok(self
            .catalog
            .records
            .iter()
            .any(|record| record.id == id && record.due(now_ms)))
    }

    /// Issue targets under the Store lock; the caller measures without locks.
    /// A later refresh supersedes earlier in-flight measurements.
    pub fn measurement_targets(&mut self) -> Result<Vec<(String, PathBuf, u64)>, String> {
        self.paths()?;
        let mut targets = Vec::new();
        for record in self.catalog.records.iter().filter(|record| !record.evicted) {
            let generation = self
                .measurement_generation
                .entry(record.id.clone())
                .or_default();
            *generation = generation.saturating_add(1);
            if *generation != u64::MAX {
                targets.push((record.id.clone(), PathBuf::from(&record.root), *generation));
            }
        }
        Ok(targets)
    }

    /// Publish only measurements for the same checkout incarnation. A stale
    /// scan never repopulates a cache after a close, eviction or restore.
    pub fn apply_measurements(
        &mut self,
        results: Vec<(String, PathBuf, u64, Result<u64, String>)>,
    ) -> Result<(), String> {
        self.paths()?;
        let records: HashMap<_, _> = self
            .catalog
            .records
            .iter()
            .map(|record| (record.id.as_str(), record))
            .collect();
        for (id, root, generation, result) in results {
            let current = self.measurement_generation.get(&id).copied().unwrap_or(0);
            let matches = generation != u64::MAX
                && generation == current
                && records
                    .get(id.as_str())
                    .is_some_and(|record| !record.evicted && Path::new(&record.root) == root);
            if matches {
                let result =
                    result.map_err(|error| crate::text::prefix_within(&error, 2000).to_string());
                self.measurements
                    .insert(id, SizeMeasurement { root, result });
            }
        }
        Ok(())
    }

    /// Catalog and already cached sizes only; no checkout scans or lease touch.
    pub fn view(&self) -> Result<StorageView, String> {
        self.paths()?;
        let workspaces: Vec<_> = self
            .catalog
            .records
            .iter()
            .map(|record| self.record_view(record))
            .collect();
        let retained = workspaces.iter().filter(|w| w.state == "present");
        let size_complete = retained.clone().all(|w| w.size_known);
        let size_error = retained.clone().any(|w| w.measurement_error.is_some());
        let used_bytes = retained
            .clone()
            .filter(|w| w.size_known)
            .fold(0u64, |sum, w| sum.saturating_add(w.bytes));
        let snapshot_bytes = workspaces
            .iter()
            .fold(0u64, |sum, w| sum.saturating_add(w.snapshot_bytes));
        let retained_count = retained.count();
        let over_budget = u64::try_from(retained_count).unwrap_or(u64::MAX)
            > self.catalog.policy.max_worktrees
            || used_bytes > self.catalog.policy.max_bytes;
        let error = size_error.then(|| "Some checkout sizes could not be measured".to_string());
        Ok(StorageView {
            policy: self.catalog.policy.clone(),
            workspaces,
            used_bytes,
            size_complete,
            snapshot_bytes,
            retained_count,
            over_budget,
            error,
        })
    }

    pub fn remove(&mut self, id: &str, now_ms: u64) -> Result<WorkspaceView, String> {
        let result = self.remove_inner(id, now_ms);
        if let Err(error) = &result {
            self.diagnostic(id, error);
        }
        result
    }

    fn remove_inner(&mut self, id: &str, now_ms: u64) -> Result<WorkspaceView, String> {
        let record = self.record(id)?;
        if record.evicted {
            return Err("workspace is already removed or has an unfinished removal".into());
        }
        if record.pinned {
            return Err("pinned workspace cannot be removed".into());
        }
        let (data, storage) = self.paths()?;
        let identity = identity::recheck(data, record)?;
        let (reference, snapshot) = snapshot::create(storage, &identity, now_ms)?;
        // Keep the name to distinguish an unpublished directory from a
        // catalog write that succeeded but whose final fsync failed.
        let snapshot_name = reference.name.clone();
        // A verified, fsynced checkpoint becomes durable while the original is
        // still intact. Old recovery points are never pruned or replaced.
        let publication = self.transaction(|catalog| {
            let record = catalog
                .records
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            if record.pinned || record.evicted {
                return Err("workspace is no longer eligible for removal".into());
            }
            record.bytes = snapshot.worktree.bytes;
            record.branch.clone_from(&snapshot.branch);
            record.commit = Some(snapshot.head);
            record.snapshots.push(reference);
            record.error = None;
            Ok(())
        });
        if let Err(error) = publication {
            let cleanup = (|| {
                let (_, storage) = self.paths()?;
                let (on_disk, _) = read_catalog(&storage.join("catalog.json"))?;
                if on_disk
                    .records
                    .iter()
                    .any(|record| record.snapshots.iter().any(|s| s.name == snapshot_name))
                {
                    return Ok(());
                }
                snapshot::discard_unpublished(storage, &snapshot_name)
            })();
            return match cleanup {
                Ok(()) => Err(error),
                Err(cleanup) => Err(format!(
                    "{error}; could not safely clean unpublished recovery point: {cleanup}"
                )),
            };
        }
        let (data, storage) = self.paths()?;
        let record = self.record(id)?;
        let reference = record
            .snapshots
            .last()
            .ok_or_else(|| "recovery checkpoint was not committed".to_string())?;
        let (_, durable_snapshot) = snapshot::read(storage, reference)?;
        let identity = identity::recheck(data, record)?;
        snapshot::unchanged(&identity, &durable_snapshot)?;
        // Journal the irreversible operation before it starts. A crash or
        // partial git removal cannot cause a retry to snapshot a partial tree.
        self.transaction(|catalog| {
            let record = catalog
                .records
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            if record.pinned || record.evicted {
                return Err("workspace is no longer eligible for removal".into());
            }
            record.evicted = true;
            record.closed_at_ms = Some(now_ms);
            record.error = Some(
                "Removal interrupted or in progress; the verified recovery point is retained"
                    .into(),
            );
            Ok(())
        })?;
        self.invalidate_measurement(id);
        git::remove(&identity.source, &identity.root)?;
        self.transaction(|catalog| {
            let record = catalog
                .records
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            record.error = None;
            Ok(record.view())
        })
    }

    /// Reconstruct files without implying user activity or cancelling a Keep lease.
    pub fn restore(&mut self, id: &str) -> Result<WorkspaceView, String> {
        let result = self.restore_inner(id);
        if let Err(error) = &result {
            self.diagnostic(id, error);
        }
        result
    }

    fn restore_inner(&mut self, id: &str) -> Result<WorkspaceView, String> {
        let record = self.record(id)?;
        if !record.evicted {
            return Err("workspace is already present".into());
        }
        let reference = record
            .snapshots
            .last()
            .ok_or_else(|| "workspace has no recovery point".to_string())?;
        let (data, storage) = self.paths()?;
        let (snapshot_path, snapshot) = snapshot::read(storage, reference)?;
        let source = PathBuf::from(&record.source_root);
        let (_gate, source_repo) = crate::git_browser::discover_optional(&source)?
            .ok_or_else(|| "source repository is unavailable".to_string())?;
        let actual_source = source_repo
            .workdir()
            .ok_or_else(|| "source has no checkout".to_string())?;
        let source_text = crate::external_open::canonical_folder(actual_source)?;
        let common = crate::external_open::canonical_folder(source_repo.common_dir())?;
        if source_text != record.source_root || common != record.common_dir {
            return Err("source repository identity changed; recovery point retained".into());
        }
        let worktrees = identity::worktrees(data)?;
        let old_root = PathBuf::from(&record.root);
        let relative = Path::new(&record.path)
            .strip_prefix(&old_root)
            .map_err(|_| "invalid saved workspace path".to_string())?
            .to_path_buf();
        let dest = match std::fs::symlink_metadata(&old_root) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => old_root,
            Err(e) => return Err(format!("cannot inspect restore destination: {e}")),
            Ok(_) => worktrees.join(format!("conversation-{}", random_id()?)),
        };
        let new_path = dest.join(&relative);
        let dest_text = identity::text(&dest)?;
        let new_path_text = identity::text(&new_path)?;
        // Journal every attempted destination before the git mutation: failed
        // partial worktrees remain visible and are never overwritten by retry.
        self.transaction(|catalog| {
            let record = catalog
                .records
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            if !record.path_aliases.contains(&new_path_text) {
                record.path_aliases.push(new_path_text.clone());
            }
            record.error = Some(format!(
                "Restore in progress; any partial files are retained at {dest_text}"
            ));
            Ok(())
        })?;
        let branch = (|| {
            git::import(&source, &snapshot_path)?;
            let branch = git::add(
                &source,
                &dest,
                &snapshot.head,
                snapshot.branch.as_deref(),
                id,
            )?;
            let (_gate, repo, root) = crate::git_browser::open(&dest)?;
            let common = crate::external_open::canonical_folder(repo.common_dir())?;
            if root != dest || common != self.record(id)?.common_dir {
                return Err("restored worktree has an unexpected identity".to_string());
            }
            let gitdir = PathBuf::from(crate::external_open::canonical_folder(repo.git_dir())?);
            files::restore(&dest, &snapshot_path, &snapshot.worktree)?;
            files::restore_metadata(&gitdir, &snapshot_path, &snapshot.metadata)?;
            snapshot::verify_restored(&dest, &gitdir, &snapshot)?;
            if !new_path.is_dir() {
                return Err("restored project subdirectory is unavailable".to_string());
            }
            Ok(branch)
        })()
        .map_err(|error| format!("{error}; any partial restore was retained at {dest_text}"))?;
        let view = self.transaction(|catalog| {
            let record = catalog
                .records
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or_else(|| "workspace not found".to_string())?;
            if !record.path_aliases.contains(&record.path) {
                record.path_aliases.push(record.path.clone());
            }
            record.root = dest_text;
            record.path = new_path_text;
            record.branch = Some(branch);
            record.commit = Some(snapshot.head);
            record.evicted = false;
            record.error = None;
            Ok(record.view())
        })?;
        self.invalidate_measurement(id);
        Ok(view)
    }
}
