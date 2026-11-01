//! Bounded raw worktree and per-worktree Git metadata snapshots.
//!
//! Paths in manifests are slash-separated and never interpreted as paths until
//! the complete manifest has been validated. File blobs are immutable, private,
//! content-addressed raw bytes; no Git filters are involved.
use serde::{Deserialize, Serialize};

const MAX_ENTRIES: usize = 200_000;
const MAX_PATH: usize = 4096;
const MAX_DEPTH: usize = 128;
const MAX_FILE: u64 = 8 * 1024 * 1024 * 1024;
const MAX_TOTAL: u64 = 64 * 1024 * 1024 * 1024;
const MAX_IGNORE: u64 = 8 * 1024 * 1024;
const MAX_IGNORE_TOTAL: u64 = 64 * 1024 * 1024;
const MAX_XATTR_VALUE: usize = 1024 * 1024;
const MAX_XATTR_TOTAL: usize = 64 * 1024 * 1024;
const MAX_XATTR_COUNT: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Manifest {
    pub entries: Vec<Entry>,
    pub bytes: u64,
    pub root_mode: u32,
    pub root_security: Option<String>,
    pub root_owner: Option<Owner>,
    pub root_xattrs: Vec<Xattr>,
    pub excluded_caches: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Entry {
    pub path: String,
    pub mode: u32,
    pub security: Option<String>,
    pub owner: Option<Owner>,
    pub xattrs: Vec<Xattr>,
    pub kind: Kind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum Kind {
    Directory,
    File { digest: String, size: u64 },
    Symlink { target: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Owner {
    pub uid: u32,
    pub gid: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Xattr {
    pub name: String,
    pub value: String,
}

fn valid_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > MAX_PATH || path.split('/').count() > MAX_DEPTH {
        return Err("Snapshot path exceeds its limits".into());
    }
    if path.split('/').any(|part| {
        part.is_empty()
            || part.len() > 255
            || part == "."
            || part == ".."
            || part.eq_ignore_ascii_case(".git")
            || part.contains(['\\', '\0', ':'])
    }) {
        return Err("Snapshot contains an unsafe path or nested repository".into());
    }
    #[cfg(windows)]
    if path.split('/').any(windows_unsafe_component) {
        return Err("Snapshot contains a Windows-unsafe path".into());
    }
    Ok(())
}

#[cfg(windows)]
fn windows_unsafe_component(component: &str) -> bool {
    if component.ends_with(['.', ' '])
        || component
            .chars()
            .any(|c| c < ' ' || matches!(c, '<' | '>' | '\"' | '|' | '?' | '*'))
    {
        return true;
    }
    let stem = component.split('.').next().unwrap_or("");
    if ["CON", "PRN", "AUX", "NUL"]
        .iter()
        .any(|name| stem.eq_ignore_ascii_case(name))
    {
        return true;
    }
    let bytes = stem.as_bytes();
    bytes.len() == 4
        && (bytes[..3].eq_ignore_ascii_case(b"COM") || bytes[..3].eq_ignore_ascii_case(b"LPT"))
        && (b'1'..=b'9').contains(&bytes[3])
}

fn looks_bare(names: &[String]) -> bool {
    ["HEAD", "objects", "refs"]
        .iter()
        .all(|required| names.iter().any(|name| name.eq_ignore_ascii_case(required)))
}

const CACHE_NAMES: [&str; 4] = ["node_modules", "target", ".next", ".turbo"];

fn cache_index(name: &str) -> Option<usize> {
    CACHE_NAMES.iter().position(|candidate| *candidate == name)
}

fn mark_indexed_caches(indexed: &mut [bool; 4], path: &str) {
    for component in path.split('/') {
        for (index, name) in CACHE_NAMES.iter().enumerate() {
            if component.eq_ignore_ascii_case(name) {
                indexed[index] = true;
            }
        }
    }
}

pub(super) fn forbidden_metadata(path: &str) -> bool {
    let first = path.split('/').next().unwrap_or("");
    let bisect_ref = path.eq_ignore_ascii_case("refs/bisect")
        || path
            .get(..12)
            .is_some_and(|p| p.eq_ignore_ascii_case("refs/bisect/"));
    bisect_ref
        || (!path.contains('/')
            && (first
                .get(..7)
                .is_some_and(|p| p.eq_ignore_ascii_case("BISECT_"))
                || [
                    "MERGE_HEAD",
                    "CHERRY_PICK_HEAD",
                    "REVERT_HEAD",
                    "rebase-apply",
                    "rebase-merge",
                    "sequencer",
                    "index.lock",
                    "packed-refs",
                ]
                .iter()
                .any(|name| first.eq_ignore_ascii_case(name))))
}

fn check_ignore_source(path: &std::path::Path) -> Result<(), String> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Cannot inspect Git ignore configuration: {error}")),
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("Git ignore configuration is a reparse point".into());
        }
    }
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_IGNORE {
        return Err("Git ignore configuration is unsupported or exceeds its size limit".into());
    }
    Ok(())
}

fn check_ignore_globals(repo: &gix::Repository) -> Result<(), String> {
    check_ignore_source(&repo.common_dir().join("info").join("exclude"))?;
    let configured = repo
        .config_snapshot()
        .trusted_path("core.excludesFile")
        .map_err(|e| format!("Cannot resolve Git ignore configuration: {e}"))?;
    let global = configured.or_else(|| {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .or_else(|| std::env::var_os("USERPROFILE"))
                    .map(|home| std::path::PathBuf::from(home).join(".config"))
            })
            .map(|base| base.join("git").join("ignore"))
    });
    if let Some(path) = global {
        check_ignore_source(&path)?;
    }
    Ok(())
}

fn count_indexed_ignore(
    repo: &gix::Repository,
    id: gix::ObjectId,
    path: &str,
    total: &mut u64,
) -> Result<(), String> {
    if path == ".gitignore" || path.ends_with("/.gitignore") {
        let size = repo
            .find_header(id)
            .map_err(|e| format!("Cannot inspect indexed ignore file: {e}"))?
            .size();
        if size > MAX_IGNORE {
            return Err("Indexed ignore file exceeds size limit".into());
        }
        *total = total
            .checked_add(size)
            .ok_or("Git ignore data exceeds size limit")?;
        if *total > MAX_IGNORE_TOTAL {
            return Err("Git ignore data exceeds size limit".into());
        }
    }
    Ok(())
}

fn security_xattr(name: &str) -> bool {
    name.starts_with("system.posix_acl_")
        || name.starts_with("security.")
        || name.starts_with("trusted.")
        || matches!(
            name,
            "com.apple.system.Security"
                | "com.apple.macl"
                | "com.apple.rootless"
                | "com.apple.quarantine"
        )
}

fn validate_xattrs(attrs: &[Xattr], total: &mut usize) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    if attrs.len() > MAX_XATTR_COUNT {
        return Err("Snapshot extended attribute count exceeds limit".into());
    }
    let mut previous: Option<&str> = None;
    for attr in attrs {
        if attr.name.is_empty()
            || attr.name.len() > 255
            || attr.name.contains('\0')
            || previous.is_some_and(|name| name >= attr.name.as_str())
            || security_xattr(&attr.name)
            || attr.value.len() > MAX_XATTR_VALUE * 4 / 3 + 4
        {
            return Err("Snapshot contains invalid or unsupported extended attributes".into());
        }
        let value = STANDARD
            .decode(&attr.value)
            .map_err(|_| "Invalid snapshot extended attribute encoding")?;
        if value.len() > MAX_XATTR_VALUE || STANDARD.encode(&value) != attr.value {
            return Err("Invalid or oversized snapshot extended attribute".into());
        }
        *total = total
            .checked_add(value.len() + attr.name.len())
            .ok_or("Snapshot extended attributes exceed limit")?;
        if *total > MAX_XATTR_TOTAL {
            return Err("Snapshot extended attributes exceed limit".into());
        }
        previous = Some(&attr.name);
    }
    Ok(())
}

fn validate_manifest_platform(manifest: &Manifest) -> Result<(), String> {
    if manifest.entries.len() > MAX_ENTRIES || manifest.excluded_caches.len() > MAX_ENTRIES {
        return Err("Snapshot entry limit exceeded".into());
    }
    if manifest.root_mode > 0o7777 {
        return Err("Snapshot root mode is invalid".into());
    }
    if cfg!(unix)
        && (manifest.root_security.is_some()
            || manifest
                .entries
                .iter()
                .any(|entry| entry.security.is_some()))
    {
        return Err("Snapshot security descriptors are unsupported on this platform".into());
    }
    if cfg!(unix)
        && (manifest.root_owner.is_none()
            || manifest.entries.iter().any(|entry| entry.owner.is_none()))
    {
        return Err("Snapshot ownership is missing".into());
    }
    if cfg!(windows)
        && (manifest.root_owner.is_some()
            || manifest.entries.iter().any(|entry| entry.owner.is_some()))
    {
        return Err("Snapshot ownership is unsupported on this platform".into());
    }
    Ok(())
}

fn valid_manifest(manifest: &Manifest) -> Result<(), String> {
    use std::collections::BTreeMap;
    validate_manifest_platform(manifest)?;
    let mut xattr_total = 0usize;
    validate_xattrs(&manifest.root_xattrs, &mut xattr_total)?;
    if cfg!(windows) && !manifest.root_xattrs.is_empty() {
        return Err("Snapshot extended attributes are unsupported on this platform".into());
    }
    let mut paths: BTreeMap<&str, &Kind> = BTreeMap::new();
    let mut total = 0u64;
    let mut previous: Option<&str> = None;
    for entry in &manifest.entries {
        validate_xattrs(&entry.xattrs, &mut xattr_total)?;
        if (cfg!(windows)
            || (cfg!(not(target_os = "macos")) && matches!(entry.kind, Kind::Symlink { .. })))
            && !entry.xattrs.is_empty()
        {
            return Err("Snapshot extended attributes are unsupported for this entry".into());
        }
        valid_path(&entry.path)?;
        if previous.is_some_and(|path| path >= entry.path.as_str()) || entry.mode > 0o7777 {
            return Err(
                "Snapshot entries are duplicated, unordered, or have an invalid mode".into(),
            );
        }
        if let Some((parent, _)) = entry.path.rsplit_once('/') {
            if !matches!(paths.get(parent), Some(Kind::Directory)) {
                return Err("Snapshot entry has no directory parent".into());
            }
        }
        let size = match &entry.kind {
            Kind::Directory => 0,
            Kind::File { digest, size } => {
                if *size > MAX_FILE
                    || digest.len() != 64
                    || !digest
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                {
                    return Err("Snapshot contains an invalid blob reference".into());
                }
                *size
            }
            Kind::Symlink { target } => {
                if target.is_empty()
                    || target.len() > MAX_PATH
                    || target.contains('\0')
                    || entry.mode != 0
                {
                    return Err("Snapshot contains an invalid symbolic link".into());
                }
                target.len() as u64
            }
        };
        total = total
            .checked_add(size)
            .ok_or("Snapshot byte limit exceeded")?;
        if total > MAX_TOTAL {
            return Err("Snapshot byte limit exceeded".into());
        }
        paths.insert(entry.path.as_str(), &entry.kind);
        previous = Some(&entry.path);
    }
    if total != manifest.bytes {
        return Err("Snapshot byte count does not match its entries".into());
    }
    let candidates = ["node_modules", "target", ".next", ".turbo"];
    if !manifest.excluded_caches.is_empty()
        && !manifest
            .excluded_caches
            .iter()
            .map(String::as_str)
            .eq(candidates)
    {
        return Err("Snapshot contains invalid cache exclusions".into());
    }
    Ok(())
}

#[cfg(unix)]
#[path = "files/unix.rs"]
mod platform;

#[cfg(unix)]
pub(super) use platform::{
    capture, capture_metadata, restore, restore_metadata, scan, scan_metadata, verify,
};

#[cfg(target_os = "macos")]
pub(super) use platform::check_private_storage;

// Windows uses guarded path operations and double scans. Security descriptors
// are captured separately; reparse points, alternate streams and hard links
// are rejected instead of silently discarded.
#[cfg(windows)]
#[path = "files/windows.rs"]
mod platform_windows;
#[cfg(windows)]
pub(super) use platform_windows::{
    capture, capture_metadata, restore, restore_metadata, scan, scan_metadata, verify,
};
