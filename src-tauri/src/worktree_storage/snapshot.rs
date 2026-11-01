use super::{catalog::SnapshotRef, files, git, identity, random_id, undo};
use gix::bstr::ByteSlice as _;
use serde::{Deserialize, Serialize};
use std::io::Read as _;
use std::path::{Path, PathBuf};

const MAX_MANIFEST: u64 = 64 * 1024 * 1024;
const MAX_INDEX_ENTRIES: usize = 200_000;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Snapshot {
    version: u32,
    pub head: String,
    pub branch: Option<String>,
    index_ids: Vec<String>,
    extra_ids: Vec<String>,
    pack_hash: String,
    pack_bytes: u64,
    pub worktree: files::Manifest,
    pub metadata: files::Manifest,
}

fn index_ids(repo: &gix::Repository) -> Result<Vec<String>, String> {
    let index_path = repo.index_path();
    let meta = std::fs::symlink_metadata(&index_path)
        .map_err(|e| format!("cannot inspect worktree index: {e}"))?;
    if !meta.file_type().is_file()
        || super::measurement::is_link(&meta)
        || meta.len() > MAX_MANIFEST
    {
        return Err("worktree index is missing, unsafe or too large".into());
    }
    let index = repo
        .index_or_empty()
        .map_err(|e| format!("cannot read worktree index: {e}"))?;
    if index.entries().len() > MAX_INDEX_ENTRIES || index.link().is_some() {
        return Err("split or oversized Git index is not supported".into());
    }
    let mut ids = Vec::with_capacity(index.entries().len());
    for entry in index.entries() {
        if entry.stage_raw() != 0 || entry.mode.is_submodule() || entry.mode.is_sparse() {
            return Err(
                "unresolved, sparse or submodule index state cannot be removed safely".into(),
            );
        }
        let path = entry
            .path(&index)
            .to_str()
            .map_err(|_| "non-UTF-8 Git index path".to_string())?;
        if path.is_empty()
            || path.len() > 4096
            || path.split('/').any(|p| {
                p.is_empty()
                    || p == "."
                    || p == ".."
                    || p.eq_ignore_ascii_case(".git")
                    || (cfg!(windows) && (p.contains('\\') || p.contains(':')))
            })
        {
            return Err("unsafe Git index path".into());
        }
        let id = entry.id.to_string();
        if id.bytes().all(|b| b == b'0') {
            return Err("intent-to-add index entries are not supported".into());
        }
        repo.find_header(entry.id)
            .map_err(|e| format!("cannot inspect staged Git object: {e}"))?;
        ids.push(id);
    }
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

/// Private worktree refs and reflogs can be the last owners of objects that
/// are not reachable from HEAD. Preserve those objects too, or refuse a
/// damaged/unsupported reference rather than saving a misleading log.
fn metadata_ids(
    repo: &gix::Repository,
    snapshot: &Path,
    manifest: &files::Manifest,
    hash_len: usize,
) -> Result<Vec<String>, String> {
    const MAX_REF_FILE: u64 = 8 * 1024 * 1024;
    let mut ids = Vec::new();
    for entry in &manifest.entries {
        let is_ref = entry.path == "ORIG_HEAD" || entry.path.starts_with("refs/");
        let is_log = entry.path.starts_with("logs/");
        if !is_ref && !is_log {
            continue;
        }
        let files::Kind::File { digest, size } = &entry.kind else {
            if matches!(&entry.kind, files::Kind::Directory) {
                continue;
            }
            return Err("unsupported Git reference or reflog entry".into());
        };
        if *size > MAX_REF_FILE {
            return Err("Git reference or reflog exceeds recovery limit".into());
        }
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NOFOLLOW);
        let mut bytes = Vec::new();
        options
            .open(snapshot.join("blobs").join(digest))
            .map_err(|e| format!("cannot read captured Git metadata: {e}"))?
            .take(MAX_REF_FILE + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("cannot read captured Git metadata: {e}"))?;
        if bytes.len() as u64 != *size || crate::json_store::hex_sha256(&bytes) != *digest {
            return Err("captured Git metadata changed".into());
        }
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| "unsupported Git reference encoding".to_string())?;
        let mut add = |value: &str| -> Result<(), String> {
            if !super::catalog::valid_hex(value, hash_len) {
                return Err("invalid Git reference object id".into());
            }
            if value.bytes().all(|b| b == b'0') {
                return Ok(());
            }
            let oid = gix::ObjectId::from_hex(value.as_bytes())
                .map_err(|_| "invalid Git reference object id".to_string())?;
            repo.find_header(oid)
                .map_err(|_| "Git reference or reflog object is unavailable".to_string())?;
            ids.push(value.to_string());
            if ids.len() > MAX_INDEX_ENTRIES {
                return Err("Git reference history exceeds recovery limit".into());
            }
            Ok(())
        };
        if is_ref {
            let value = text.trim();
            if value.starts_with("ref: ") {
                return Err("symbolic worktree-private references are unsupported".into());
            }
            add(value)?;
        } else {
            for line in text.lines() {
                let mut fields = line.split_whitespace();
                add(fields
                    .next()
                    .ok_or_else(|| "invalid worktree reflog".to_string())?)?;
                add(fields
                    .next()
                    .ok_or_else(|| "invalid worktree reflog".to_string())?)?;
            }
        }
    }
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

fn preflight_metadata(gitdir: &Path) -> Result<(), String> {
    let entries = std::fs::read_dir(gitdir)
        .map_err(|e| format!("cannot inspect worktree Git metadata: {e}"))?;
    let mut count = 0usize;
    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot inspect worktree Git metadata: {e}"))?;
        count += 1;
        if count > MAX_INDEX_ENTRIES {
            return Err("worktree Git metadata exceeds entry limit".into());
        }
        let name = entry.file_name();
        let name = name
            .to_str()
            .ok_or_else(|| "non-UTF-8 Git metadata name".to_string())?;
        if files::forbidden_metadata(name) {
            return Err("an unsupported Git operation is in progress".into());
        }
        if name.eq_ignore_ascii_case("refs") {
            let metadata = std::fs::symlink_metadata(entry.path())
                .map_err(|e| format!("cannot inspect worktree refs: {e}"))?;
            if !metadata.is_dir() || super::measurement::is_link(&metadata) {
                return Err("unsupported worktree refs directory".into());
            }
            for child in std::fs::read_dir(entry.path())
                .map_err(|e| format!("cannot inspect worktree refs: {e}"))?
            {
                let child = child.map_err(|e| format!("cannot inspect worktree refs: {e}"))?;
                count += 1;
                if count > MAX_INDEX_ENTRIES {
                    return Err("worktree Git metadata exceeds entry limit".into());
                }
                let name = child.file_name();
                let name = name
                    .to_str()
                    .ok_or_else(|| "non-UTF-8 Git reference name".to_string())?;
                if files::forbidden_metadata(&format!("refs/{name}")) {
                    return Err("an unsupported Git operation is in progress".into());
                }
            }
        }
    }
    Ok(())
}

fn captured_index(path: &Path, metadata: &files::Manifest) -> Result<Vec<u8>, String> {
    let entry = metadata
        .entries
        .iter()
        .find(|entry| entry.path == "index")
        .ok_or_else(|| "captured Git index is missing".to_string())?;
    let files::Kind::File { digest, size } = &entry.kind else {
        return Err("captured Git index is not a file".into());
    };
    if *size > MAX_MANIFEST {
        return Err("captured Git index exceeds size limit".into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NOFOLLOW);
    let mut bytes = Vec::new();
    options
        .open(path.join("blobs").join(digest))
        .map_err(|e| format!("cannot open captured Git index: {e}"))?
        .take(MAX_MANIFEST + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("cannot read captured Git index: {e}"))?;
    if bytes.len() as u64 != *size || crate::json_store::hex_sha256(&bytes) != *digest {
        return Err("captured Git index failed its integrity check".into());
    }
    Ok(bytes)
}

fn verify_index_checksum(bytes: &[u8], hash_len: usize) -> Result<(), String> {
    let algorithm = match hash_len {
        20 => &ring::digest::SHA1_FOR_LEGACY_USE_ONLY,
        32 => &ring::digest::SHA256,
        _ => return Err("unsupported Git index hash".into()),
    };
    let split = bytes
        .len()
        .checked_sub(hash_len)
        .ok_or_else(|| "truncated Git index".to_string())?;
    if ring::digest::digest(algorithm, &bytes[..split]).as_ref() != &bytes[split..] {
        return Err("Git index checksum does not match".into());
    }
    Ok(())
}

/// Caller must have proved this freshly created directory was never published.
pub(super) fn discard_unpublished(storage: &Path, name: &str) -> Result<(), String> {
    if !super::catalog::valid_hex(name, 32) {
        return Err("invalid unpublished recovery identifier".into());
    }
    let snapshots = storage.join("snapshots");
    let parent = std::fs::symlink_metadata(&snapshots)
        .map_err(|e| format!("cannot inspect recovery storage: {e}"))?;
    if !parent.is_dir() || super::measurement::is_link(&parent) {
        return Err("unsafe recovery storage".into());
    }
    let path = snapshots.join(name);
    let metadata = match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("cannot inspect unpublished recovery point: {e}")),
        Ok(metadata) => metadata,
    };
    if !metadata.is_dir() || super::measurement::is_link(&metadata) {
        return Err("unpublished recovery point was replaced; retained".into());
    }
    std::fs::remove_dir_all(&path).map_err(|e| {
        format!(
            "cannot remove unpublished recovery point at {}: {e}",
            path.display()
        )
    })?;
    super::sync_dir(&snapshots)
}

pub(super) fn create(
    storage: &Path,
    identity: &identity::Identity,
    now: u64,
) -> Result<(SnapshotRef, Snapshot), String> {
    preflight_metadata(&identity.gitdir)?;
    let (_gate, repo, root) = crate::git_browser::open(&identity.root)?;
    if root != identity.root {
        return Err("worktree identity changed before capture".into());
    }
    let ids = index_ids(&repo)?;
    let snapshots = storage.join("snapshots");
    super::private_directory(&snapshots)?;
    let name = random_id()?;
    let path = snapshots.join(&name);
    crate::private_fs::private_dirs(false)
        .create(&path)
        .map_err(|e| format!("cannot create private recovery point: {e}"))?;
    let result = (|| {
        super::private_directory(&path)?;
        super::sync_dir(&snapshots)?;
        let worktree = files::capture(&identity.root, &repo, &path)?;
        let metadata = files::capture_metadata(&identity.gitdir, &path)?;
        files::verify(&path, &worktree)?;
        files::verify(&path, &metadata)?;
        let mut extra_ids = metadata_ids(&repo, &path, &metadata, identity.head.len())?;
        let index = captured_index(&path, &metadata)?;
        verify_index_checksum(&index, repo.object_hash().len_in_bytes())?;
        extra_ids.extend(undo::object_ids(&index, &repo)?);
        extra_ids.sort_unstable();
        extra_ids.dedup();
        let (pack_hash, pack_bytes) =
            git::export(&identity.root, &path, &identity.head, &ids, &extra_ids)?;
        let snapshot = Snapshot {
            version: 1,
            head: identity.head.clone(),
            branch: identity.branch.clone(),
            index_ids: ids,
            extra_ids,
            pack_hash,
            pack_bytes,
            worktree,
            metadata,
        };
        git::verify(
            &path,
            &snapshot.pack_hash,
            &snapshot.head,
            &snapshot.index_ids,
            &snapshot.extra_ids,
        )?;
        let bytes = serde_json::to_vec(&snapshot)
            .map_err(|e| format!("cannot serialize recovery point: {e}"))?;
        if bytes.len() as u64 > MAX_MANIFEST {
            return Err("recovery manifest exceeds size limit".into());
        }
        let manifest = path.join("manifest.json");
        let temp = path.join(format!("manifest-{}.tmp", random_id()?));
        super::write_private(&manifest, &temp, &bytes)?;
        super::sync_dir(&path)?;
        let reference = SnapshotRef {
            // The name remains available to clean up on a failed capture.
            name: name.clone(),
            manifest_hash: crate::json_store::hex_sha256(&bytes),
            bytes: snapshot
                .worktree
                .bytes
                .saturating_add(snapshot.metadata.bytes)
                .saturating_add(pack_bytes),
            at_ms: now,
        };
        Ok((reference, snapshot))
    })();
    match result {
        Ok(snapshot) => Ok(snapshot),
        Err(error) => match discard_unpublished(storage, &name) {
            Ok(()) => Err(error),
            Err(cleanup) => Err(format!("{error}; {cleanup}")),
        },
    }
}

pub(super) fn read(storage: &Path, reference: &SnapshotRef) -> Result<(PathBuf, Snapshot), String> {
    let snapshots = storage.join("snapshots");
    let metadata = std::fs::symlink_metadata(&snapshots)
        .map_err(|e| format!("cannot inspect recovery storage: {e}"))?;
    if !metadata.file_type().is_dir()
        || super::measurement::is_link(&metadata)
        || !super::catalog::valid_hex(&reference.name, 32)
    {
        return Err("unsafe recovery storage".into());
    }
    let path = snapshots.join(&reference.name);
    let meta = std::fs::symlink_metadata(&path)
        .map_err(|e| format!("cannot access recovery point: {e}"))?;
    if !meta.file_type().is_dir() || super::measurement::is_link(&meta) {
        return Err("unsafe recovery point directory".into());
    }
    #[cfg(target_os = "macos")]
    {
        files::check_private_storage(&snapshots)?;
        files::check_private_storage(&path)?;
    }
    let manifest_path = path.join("manifest.json");
    let meta = std::fs::symlink_metadata(&manifest_path)
        .map_err(|e| format!("cannot access recovery manifest: {e}"))?;
    if !meta.file_type().is_file()
        || super::measurement::is_link(&meta)
        || meta.len() > MAX_MANIFEST
    {
        return Err("unsafe or oversized recovery manifest".into());
    }
    #[cfg(target_os = "macos")]
    files::check_private_storage(&manifest_path)?;
    let mut bytes = Vec::new();
    std::fs::File::open(&manifest_path)
        .map_err(|e| format!("cannot open recovery manifest: {e}"))?
        .take(MAX_MANIFEST + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("cannot read recovery manifest: {e}"))?;
    if bytes.len() as u64 > MAX_MANIFEST
        || crate::json_store::hex_sha256(&bytes) != reference.manifest_hash
    {
        return Err("recovery manifest failed its integrity check".into());
    }
    let snapshot: Snapshot =
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid recovery manifest: {e}"))?;
    if snapshot.version != 1
        || snapshot.index_ids.len() > MAX_INDEX_ENTRIES
        || snapshot.extra_ids.len() > MAX_INDEX_ENTRIES
        || !valid_oid(&snapshot.head)
        || snapshot.index_ids.iter().any(|id| !valid_oid(id))
        || snapshot.extra_ids.iter().any(|id| !valid_oid(id))
        || !super::catalog::valid_hex(&snapshot.pack_hash, 64)
    {
        return Err("invalid recovery manifest contents".into());
    }
    files::verify(&path, &snapshot.worktree)?;
    files::verify(&path, &snapshot.metadata)?;
    let pack = std::fs::symlink_metadata(path.join("objects.pack"))
        .map_err(|e| format!("cannot inspect recovery pack: {e}"))?;
    if !pack.file_type().is_file()
        || super::measurement::is_link(&pack)
        || pack.len() != snapshot.pack_bytes
    {
        return Err("recovery pack has the wrong type or size".into());
    }
    git::verify(
        &path,
        &snapshot.pack_hash,
        &snapshot.head,
        &snapshot.index_ids,
        &snapshot.extra_ids,
    )?;
    Ok((path, snapshot))
}

fn valid_oid(id: &str) -> bool {
    (id.len() == 40 || id.len() == 64)
        && id
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

pub(super) fn unchanged(identity: &identity::Identity, snapshot: &Snapshot) -> Result<(), String> {
    let (_gate, repo, root) = crate::git_browser::open(&identity.root)?;
    let head = repo
        .head_id()
        .map_err(|e| format!("cannot recheck HEAD: {e}"))?
        .to_string();
    let branch = repo
        .head()
        .map_err(|e| format!("cannot recheck branch: {e}"))?
        .referent_name()
        .map(|n| n.shorten().to_string());
    if root != identity.root
        || head != snapshot.head
        || branch != snapshot.branch
        || index_ids(&repo)? != snapshot.index_ids
        || files::scan(&identity.root, &repo)? != snapshot.worktree
        || files::scan_metadata(&identity.gitdir)? != snapshot.metadata
    {
        return Err(
            "worktree, index, Git metadata or HEAD changed during capture; original retained"
                .into(),
        );
    }
    Ok(())
}

pub(super) fn verify_restored(
    root: &Path,
    gitdir: &Path,
    snapshot: &Snapshot,
) -> Result<(), String> {
    let (_gate, repo, actual) = crate::git_browser::open(root)?;
    if actual != root
        || repo
            .head_id()
            .map_err(|e| format!("cannot inspect restored HEAD: {e}"))?
            != snapshot.head
        || index_ids(&repo)? != snapshot.index_ids
        || files::scan(root, &repo)? != snapshot.worktree
        || files::scan_metadata(gitdir)? != snapshot.metadata
    {
        return Err("restored files, index or HEAD failed verification".into());
    }
    Ok(())
}
