//! Private, durable evidence bytes and short-lived webview capabilities.

mod formats;
mod http;
mod inbox;
#[cfg(test)]
mod tests;

pub(super) use self::inbox::InboxHandle;

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_TOTAL: u64 = 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 8192;
const MAX_GRANTS: usize = 4096;
const MAX_METADATA: u64 = 4096;
const TEXT_PREVIEW: usize = 128 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub bytes: u64,
    pub sha256: String,
    pub owner: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetSource {
    pub token: String,
    pub mime: String,
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
}

struct Grant {
    epoch: String,
    artifact: Artifact,
}

pub(super) struct MediaStore {
    root: Option<PathBuf>,
    imports: Mutex<()>,
    grants: Mutex<HashMap<String, Grant>>,
}

impl MediaStore {
    pub(super) fn new(root: Option<PathBuf>) -> Self {
        Self {
            root,
            imports: Mutex::new(()),
            grants: Mutex::new(HashMap::new()),
        }
    }

    pub(super) fn import(
        &self,
        path: &Path,
        owner: &str,
        name: Option<&str>,
    ) -> Result<Artifact, String> {
        if path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
        {
            return Err("evidence path must not contain traversal".into());
        }
        let fallback = path
            .file_name()
            .and_then(|part| part.to_str())
            .ok_or("evidence file has no UTF-8 name")?;
        let bytes = read_regular(path, formats::VIDEO_LIMIT as u64)?;
        self.import_bytes(fallback, owner, name, bytes)
    }

    pub(super) fn import_inbox(
        &self,
        inbox: &InboxHandle,
        filename: &str,
        owner: &str,
        name: Option<&str>,
    ) -> Result<Artifact, String> {
        let bytes = inbox.read(filename)?;
        self.import_bytes(filename, owner, name, bytes)
    }

    fn import_bytes(
        &self,
        fallback: &str,
        owner: &str,
        name: Option<&str>,
        bytes: Vec<u8>,
    ) -> Result<Artifact, String> {
        if owner.is_empty() || owner.len() > 256 || owner.chars().any(char::is_control) {
            return Err("invalid evidence owner".into());
        }
        let name = name.unwrap_or(fallback);
        if name.is_empty()
            || name.len() > 255
            || name == "."
            || name == ".."
            || name
                .chars()
                .any(|ch| ch.is_control() || ch == '/' || ch == '\\')
        {
            return Err("invalid evidence name".into());
        }
        // The on-disk name also participates: an HTML file cannot evade the
        // prohibition through a harmless-looking display name.
        let mime = formats::classify(&bytes, fallback)?;
        formats::classify(&bytes, name)?;
        let id = random_hex::<16>()?;
        let artifact = Artifact {
            id,
            name: name.to_owned(),
            mime: mime.to_owned(),
            bytes: bytes.len() as u64,
            sha256: crate::json_store::hex_sha256(&bytes),
            owner: owner.to_owned(),
        };
        let metadata = serde_json::to_vec(&artifact)
            .map_err(|e| format!("cannot serialize evidence metadata: {e}"))?;
        let _guard = self
            .imports
            .lock()
            .map_err(|_| "evidence storage lock failed")?;
        let root = self.directory(true)?;
        check_capacity(root, bytes.len() as u64 + metadata.len() as u64)?;
        let asset_path = root.join(&artifact.id);
        let metadata_path = root.join(format!("{}.json", artifact.id));
        crate::private_fs::create_private_file(&asset_path, &bytes)
            .map_err(|e| format!("cannot store evidence: {e}"))?;
        if let Err(error) = crate::private_fs::create_private_file(&metadata_path, &metadata) {
            let _ = fs::remove_file(&asset_path);
            return Err(format!("cannot store evidence metadata: {error}"));
        }
        if let Err(error) = make_readonly(&asset_path).and_then(|()| make_readonly(&metadata_path))
        {
            remove_created(&asset_path);
            remove_created(&metadata_path);
            return Err(format!("cannot protect stored evidence: {error}"));
        }
        Ok(artifact)
    }

    pub(super) fn source(&self, artifact: &Artifact, epoch: &str) -> Result<AssetSource, String> {
        if epoch.is_empty() || epoch.len() > 256 {
            return Err("invalid evidence epoch".into());
        }
        // Authorization checks integrity without allocating the complete video.
        self.verified_range(artifact, None)?;
        let mut grants = self
            .grants
            .lock()
            .map_err(|_| "evidence authorization lock failed")?;
        let token = if let Some((token, _)) = grants
            .iter()
            .find(|(_, grant)| grant.epoch == epoch && &grant.artifact == artifact)
        {
            token.to_owned()
        } else {
            if grants.len() >= MAX_GRANTS {
                return Err("too many active evidence sources".into());
            }
            let token = random_hex::<32>()?;
            if grants.contains_key(&token) {
                return Err("could not generate a unique evidence source".into());
            }
            // Registry and webview own the token independently; this descriptor
            // outlives the caller's snapshot and authenticates later reads.
            grants.insert(
                token.clone(),
                Grant {
                    epoch: epoch.to_owned(),
                    artifact: artifact.clone(),
                },
            );
            token
        };
        drop(grants);
        Ok(AssetSource {
            token,
            mime: artifact.mime.clone(),
            name: artifact.name.clone(),
            bytes: artifact.bytes,
            sha256: artifact.sha256.clone(),
        })
    }

    pub(super) fn text(&self, artifact: &Artifact) -> Result<serde_json::Value, String> {
        if artifact.mime != "text/plain" {
            return Err("evidence is not text".into());
        }
        let bytes = self.verified(artifact)?;
        let text = std::str::from_utf8(&bytes).map_err(|_| "stored evidence is not UTF-8")?;
        let prefix = crate::text::prefix_within(text, TEXT_PREVIEW);
        Ok(serde_json::json!({"text": prefix, "truncated": prefix.len() < text.len()}))
    }

    pub(super) fn response(
        &self,
        request: &tauri::http::Request<Vec<u8>>,
    ) -> tauri::http::Response<Vec<u8>> {
        http::respond(self, request)
    }

    pub(super) fn revoke(&self, epoch: &str) {
        if let Ok(mut grants) = self.grants.lock() {
            grants.retain(|_, grant| grant.epoch != epoch);
        }
    }

    fn directory(&self, create: bool) -> Result<&Path, String> {
        let root = self
            .root
            .as_deref()
            .ok_or("evidence storage is unavailable")?;
        if create {
            crate::private_fs::private_dirs(true)
                .create(root)
                .map_err(|e| format!("cannot create evidence storage: {e}"))?;
        }
        let meta = fs::symlink_metadata(root)
            .map_err(|e| format!("evidence storage is unavailable: {e}"))?;
        if !meta.is_dir() || meta.file_type().is_symlink() || is_reparse(&meta) {
            return Err("evidence storage is not a private directory".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if meta.permissions().mode() & 0o077 != 0 {
                return Err("evidence storage directory is not private".into());
            }
        }
        Ok(root)
    }

    fn verified(&self, artifact: &Artifact) -> Result<Vec<u8>, String> {
        let root = self.verified_metadata(artifact)?;
        let bytes = read_regular(&root.join(&artifact.id), formats::VIDEO_LIMIT as u64)
            .map_err(|e| format!("evidence file is missing or unreadable: {e}"))?;
        if bytes.len() as u64 != artifact.bytes
            || crate::json_store::hex_sha256(&bytes) != artifact.sha256
        {
            return Err("evidence file has been modified".into());
        }
        if formats::classify(&bytes, &artifact.name)? != artifact.mime {
            return Err("evidence content does not match its stored type".into());
        }
        Ok(bytes)
    }

    fn verified_metadata(&self, artifact: &Artifact) -> Result<&Path, String> {
        if !is_hex(&artifact.id, 32) {
            return Err("invalid evidence id".into());
        }
        let root = self.directory(false)?;
        let metadata = read_regular(&root.join(format!("{}.json", artifact.id)), MAX_METADATA)
            .map_err(|e| format!("evidence metadata is missing or unreadable: {e}"))?;
        let stored: Artifact =
            serde_json::from_slice(&metadata).map_err(|_| "evidence metadata is damaged")?;
        if &stored != artifact {
            return Err("evidence metadata does not match the stored artifact".into());
        }
        Ok(root)
    }

    /// Verify the whole asset while retaining only the requested byte range.
    /// The bytes returned are captured in the hashing pass, so a change between
    /// a hash pass and a separate seek/read cannot escape integrity checking.
    fn verified_range(
        &self,
        artifact: &Artifact,
        capture: Option<(u64, u64)>,
    ) -> Result<Vec<u8>, String> {
        let root = self.verified_metadata(artifact)?;
        if artifact.bytes > formats::VIDEO_LIMIT as u64 {
            return Err("evidence file exceeds the size limit".into());
        }
        let capacity = match capture {
            Some((start, end)) if start <= end && end <= artifact.bytes => {
                usize::try_from(end - start).map_err(|_| "evidence range is too large")?
            }
            Some(_) => return Err("invalid evidence byte range".into()),
            None => 0,
        };
        let mut file = open_regular(&root.join(&artifact.id), formats::VIDEO_LIMIT as u64)
            .map_err(|e| format!("evidence file is missing or unreadable: {e}"))?;
        let mut output = Vec::with_capacity(capacity);
        let mut hasher = Sha256::new();
        let mut chunk = [0u8; 16 * 1024];
        let mut total = 0u64;
        loop {
            let count = match file.read(&mut chunk) {
                Ok(count) => count,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(format!("cannot read evidence file: {error}")),
            };
            if count == 0 {
                break;
            }
            let next = total + count as u64;
            if next > formats::VIDEO_LIMIT as u64 {
                return Err("evidence file exceeds the size limit".into());
            }
            hasher.update(&chunk[..count]);
            if let Some((start, end)) = capture {
                let first = start.max(total);
                let last = end.min(next);
                if first < last {
                    let start_index = usize::try_from(first - total)
                        .map_err(|_| "evidence range is too large")?;
                    let end_index =
                        usize::try_from(last - total).map_err(|_| "evidence range is too large")?;
                    output.extend_from_slice(&chunk[start_index..end_index]);
                }
            }
            total = next;
        }
        if total != artifact.bytes
            || crate::json_store::hex_lower(&hasher.finalize()) != artifact.sha256
        {
            return Err("evidence file has been modified".into());
        }
        Ok(output)
    }
}

fn is_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn random_hex<const N: usize>() -> Result<String, String> {
    let mut random = [0; N];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| "cannot generate secure evidence identifier")?;
    Ok(crate::json_store::hex_lower(&random))
}

fn make_readonly(path: &Path) -> std::io::Result<()> {
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions)
}

fn remove_created(path: &Path) {
    #[cfg(windows)]
    if let Ok(meta) = fs::metadata(path) {
        let mut permissions = meta.permissions();
        permissions.set_readonly(false);
        let _ = fs::set_permissions(path, permissions);
    }
    let _ = fs::remove_file(path);
}

fn check_capacity(root: &Path, additional: u64) -> Result<(), String> {
    let mut total = additional;
    let mut count = 2usize;
    for entry in fs::read_dir(root).map_err(|e| format!("cannot inspect evidence storage: {e}"))? {
        let entry = entry.map_err(|e| format!("cannot inspect evidence storage: {e}"))?;
        let meta = fs::symlink_metadata(entry.path())
            .map_err(|e| format!("cannot inspect evidence storage: {e}"))?;
        if !meta.is_file() || meta.file_type().is_symlink() || is_reparse(&meta) {
            return Err("unexpected entry in evidence storage".into());
        }
        total = total
            .checked_add(meta.len())
            .ok_or("evidence storage limit exceeded")?;
        count += 1;
        if total > MAX_TOTAL || count > MAX_ENTRIES {
            return Err("evidence storage limit exceeded".into());
        }
    }
    if total > MAX_TOTAL {
        return Err("evidence storage limit exceeded".into());
    }
    Ok(())
}

fn read_regular(path: &Path, cap: u64) -> Result<Vec<u8>, String> {
    read_opened(open_regular(path, cap)?, cap)
}

fn open_regular(path: &Path, cap: u64) -> Result<File, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("cannot inspect file: {e}"))?;
    if !meta.is_file() || meta.file_type().is_symlink() || is_reparse(&meta) {
        return Err("evidence must be a regular, non-symlink file".into());
    }
    if meta.len() > cap {
        return Err("evidence file exceeds the size limit".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Open the reparse point itself, not its target, if it was swapped.
        options.custom_flags(0x0020_0000);
    }
    let file: File = options
        .open(path)
        .map_err(|e| format!("cannot open file: {e}"))?;
    let opened = file
        .metadata()
        .map_err(|e| format!("cannot inspect opened file: {e}"))?;
    if !opened.is_file() || opened.file_type().is_symlink() || is_reparse(&opened) {
        return Err("evidence must be a regular, non-symlink file".into());
    }
    if opened.len() > cap {
        return Err("evidence file exceeds the size limit".into());
    }
    Ok(file)
}

fn read_opened(file: File, cap: u64) -> Result<Vec<u8>, String> {
    let opened = file
        .metadata()
        .map_err(|e| format!("cannot inspect opened file: {e}"))?;
    if !opened.is_file() || opened.file_type().is_symlink() || is_reparse(&opened) {
        return Err("evidence must be a regular, non-symlink file".into());
    }
    if opened.len() > cap {
        return Err("evidence file exceeds the size limit".into());
    }
    let mut bytes = Vec::with_capacity(usize::try_from(opened.len().min(cap)).unwrap_or(0));
    file.take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("cannot read file: {e}"))?;
    if bytes.len() as u64 > cap {
        return Err("evidence file exceeds the size limit".into());
    }
    Ok(bytes)
}

#[cfg(windows)]
fn is_reparse(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
const fn is_reparse(_: &fs::Metadata) -> bool {
    false
}
