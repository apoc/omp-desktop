use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

pub(super) const RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1000;
pub(super) const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub(super) const MAX_RECORDS: usize = 10_000;
pub(super) const CACHES: &[&str] = &["node_modules/", "target/", ".next/", ".turbo/"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub max_worktrees: u64,
    pub max_bytes: u64,
    pub retention_days: u64,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            max_worktrees: 15,
            max_bytes: 20 * 1024 * 1024 * 1024,
            retention_days: 30,
        }
    }
}

impl Policy {
    pub(super) fn validate(&self) -> Result<(), String> {
        if self.max_worktrees == 0
            || self.max_worktrees > MAX_SAFE_INTEGER
            || self.max_bytes == 0
            || self.max_bytes > MAX_SAFE_INTEGER
            || self.retention_days != 30
        {
            return Err(
                "worktree budget must use positive safe integers and 30-day retention".into(),
            );
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceView {
    pub id: String,
    pub path: String,
    pub project_path: String,
    pub profile: String,
    pub branch: Option<String>,
    pub commit: Option<String>,
    pub state: String,
    pub pinned: bool,
    pub active: bool,
    pub closed_at_ms: Option<u64>,
    pub last_used_at_ms: u64,
    pub bytes: u64,
    pub size_known: bool,
    pub measurement_error: Option<String>,
    pub snapshot_bytes: u64,
    pub snapshot_at_ms: Option<u64>,
    pub session_file: Option<String>,
    pub error: Option<String>,
    pub excluded_caches: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageView {
    pub policy: Policy,
    pub workspaces: Vec<WorkspaceView>,
    pub used_bytes: u64,
    pub size_complete: bool,
    pub snapshot_bytes: u64,
    pub retained_count: usize,
    pub over_budget: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Alias {
    pub profile: String,
    pub file: String,
    #[serde(default)]
    pub relative_cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SnapshotRef {
    pub name: String,
    pub manifest_hash: String,
    pub bytes: u64,
    pub at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Record {
    pub id: String,
    pub root: String,
    pub path: String,
    pub path_aliases: Vec<String>,
    pub project_path: String,
    pub source_root: String,
    pub common_dir: String,
    pub profile: String,
    pub branch: Option<String>,
    pub commit: Option<String>,
    pub evicted: bool,
    pub pinned: bool,
    pub closed_at_ms: Option<u64>,
    pub last_used_at_ms: u64,
    pub bytes: u64,
    pub aliases: Vec<Alias>,
    pub snapshots: Vec<SnapshotRef>,
    pub error: Option<String>,
}

impl Record {
    pub(super) fn view(&self) -> WorkspaceView {
        WorkspaceView {
            id: self.id.clone(),
            path: self.path.clone(),
            project_path: self.project_path.clone(),
            profile: self.profile.clone(),
            branch: self.branch.clone(),
            commit: self.commit.clone(),
            state: if self.evicted { "evicted" } else { "present" }.into(),
            pinned: self.pinned,
            active: false,
            closed_at_ms: self.closed_at_ms,
            last_used_at_ms: self.last_used_at_ms,
            bytes: self.bytes,
            size_known: false,
            measurement_error: None,
            snapshot_bytes: self
                .snapshots
                .iter()
                .fold(0u64, |sum, s| sum.saturating_add(s.bytes)),
            snapshot_at_ms: self.snapshots.last().map(|s| s.at_ms),
            session_file: self.aliases.last().map(|a| a.file.clone()),
            error: self.error.clone(),
            excluded_caches: CACHES.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    pub(super) fn due(&self, now: u64) -> bool {
        if self.evicted || self.pinned {
            return false;
        }
        self.closed_at_ms.is_some_and(|closed| {
            let start = closed.max(self.last_used_at_ms);
            now >= start && now - start >= RETENTION_MS
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Catalog {
    pub version: u32,
    pub policy: Policy,
    pub records: Vec<Record>,
}

impl Default for Catalog {
    fn default() -> Self {
        Self {
            version: 1,
            policy: Policy::default(),
            records: Vec::new(),
        }
    }
}

pub(super) fn valid_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

pub(super) fn absolute(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
}

pub(super) fn valid_workspace_root(root: &Path, worktrees: &Path) -> bool {
    if !absolute(root) || root.parent() != Some(worktrees) {
        return false;
    }
    let Some(name) = root.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    name.strip_prefix("conversation-")
        .is_some_and(|s| valid_hex(s, 32))
}

pub(super) fn session(profile: &str, file: &Path) -> Result<Alias, String> {
    crate::profiles::validate_id(profile)?;
    if !absolute(file) || file.extension().and_then(|x| x.to_str()) != Some("jsonl") {
        return Err("session must be an absolute JSONL path".into());
    }
    let file = file
        .to_str()
        .filter(|s| s.len() <= 8192)
        .ok_or_else(|| "invalid session path".to_string())?;
    Ok(Alias {
        profile: profile.to_string(),
        file: file.to_string(),
        relative_cwd: None,
    })
}

pub(super) fn valid_relative(path: &Path) -> bool {
    !path.is_absolute()
        && path.as_os_str().len() <= 4096
        && path.components().all(|component| match component {
            Component::Normal(name) => name
                .to_str()
                .is_some_and(|s| !s.eq_ignore_ascii_case(".git")),
            _ => false,
        })
}

pub(super) fn relative_cwd(root: &Path, cwd: &Path) -> Result<String, String> {
    if !absolute(cwd) {
        return Err("workspace session cwd must be absolute".into());
    }
    let resolved = match std::fs::symlink_metadata(cwd) {
        Ok(_) => PathBuf::from(crate::external_open::canonical_folder(cwd)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => cwd.to_path_buf(),
        Err(e) => return Err(format!("cannot inspect workspace session cwd: {e}")),
    };
    let relative = resolved
        .strip_prefix(root)
        .map_err(|_| "session cwd is outside its workspace".to_string())?;
    if !valid_relative(relative) {
        return Err("invalid workspace session cwd".into());
    }
    relative
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| "session cwd is not UTF-8".into())
}

pub(super) fn filename_uuid(path: &str) -> Option<String> {
    Path::new(path)
        .file_stem()
        .and_then(|n| n.to_str())
        .and_then(|stem| {
            let (_, id) = stem.rsplit_once('_')?;
            ((32..=36).contains(&id.len())
                && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
            .then_some(id.to_ascii_lowercase())
        })
}

pub(super) fn uuid_prefix(path: &Path) -> Option<String> {
    let text = path.to_str()?;
    if !text.is_empty()
        && text.len() <= 36
        && !text.starts_with('-')
        && text.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
    {
        Some(text.to_ascii_lowercase())
    } else {
        None
    }
}

pub(super) fn same_session(a: &Alias, b: &Alias) -> bool {
    if a.profile != b.profile {
        return false;
    }
    if a.file == b.file {
        return true;
    }
    matches!((filename_uuid(&a.file), filename_uuid(&b.file)), (Some(x), Some(y)) if x == y)
}

impl Catalog {
    pub(super) fn validate(&self, worktrees: &Path) -> Result<(), String> {
        self.policy.validate()?;
        if self.version != 1 || self.records.len() > MAX_RECORDS {
            return Err("unsupported or oversized workspace catalog".into());
        }
        let mut ids = HashSet::new();
        let mut roots = HashSet::new();
        let mut snapshots = HashSet::new();
        let mut sessions: Vec<&Alias> = Vec::new();
        for r in &self.records {
            let root = Path::new(&r.root);
            if !valid_hex(&r.id, 32)
                || !ids.insert(&r.id)
                || !roots.insert(&r.root)
                || !valid_workspace_root(root, worktrees)
                || !absolute(Path::new(&r.path))
                || !Path::new(&r.path).starts_with(root)
                || !absolute(Path::new(&r.project_path))
                || !absolute(Path::new(&r.source_root))
                || !absolute(Path::new(&r.common_dir))
                || Path::new(&r.source_root).starts_with(worktrees)
                || root.starts_with(Path::new(&r.source_root))
                || !Path::new(&r.project_path).starts_with(Path::new(&r.source_root))
                || r.path_aliases.len() > 10_000
                || r.aliases.len() > 10_000
                || r.snapshots.len() > 10_000
                || r.evicted && r.snapshots.is_empty()
            {
                return Err("invalid workspace catalog record".into());
            }
            crate::profiles::validate_id(&r.profile)?;
            for path in &r.path_aliases {
                let alias = Path::new(path);
                let valid_root = alias
                    .strip_prefix(worktrees)
                    .ok()
                    .and_then(|relative| relative.components().next())
                    .is_some_and(|first| {
                        valid_workspace_root(&worktrees.join(first.as_os_str()), worktrees)
                    });
                if !absolute(alias) || !valid_root {
                    return Err("invalid workspace path alias".into());
                }
            }
            for a in &r.aliases {
                session(&a.profile, Path::new(&a.file))?;
                if a.relative_cwd
                    .as_ref()
                    .is_some_and(|cwd| !valid_relative(Path::new(cwd)))
                {
                    return Err("invalid workspace session cwd alias".into());
                }
                if sessions.iter().any(|other| same_session(other, a)) {
                    return Err("duplicate workspace session identity".into());
                }
                sessions.push(a);
            }
            for s in &r.snapshots {
                if !valid_hex(&s.name, 32)
                    || !snapshots.insert(&s.name)
                    || !valid_hex(&s.manifest_hash, 64)
                {
                    return Err("invalid snapshot reference".into());
                }
            }
            if r.error.as_ref().is_some_and(|e| e.len() > 4096) {
                return Err("invalid workspace diagnostic".into());
            }
        }
        Ok(())
    }
}
