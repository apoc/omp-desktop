use super::super::windows_security;
use super::{
    cache_index, check_ignore_globals, count_indexed_ignore, forbidden_metadata, looks_bare,
    mark_indexed_caches, valid_manifest, valid_path, Entry, Kind, Manifest, MAX_DEPTH, MAX_ENTRIES,
    MAX_FILE, MAX_IGNORE, MAX_IGNORE_TOTAL, MAX_TOTAL,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use gix::bstr::ByteSlice as _;
use ring::rand::{SecureRandom as _, SystemRandom};
use sha2::{Digest as _, Sha256};
use std::collections::BTreeSet;
use std::ffi::c_void;
use std::fs::{self, File, OpenOptions};
use std::io::{Read as _, Write as _};
use std::os::windows::ffi::OsStrExt as _;
use std::os::windows::fs::{MetadataExt as _, OpenOptionsExt as _};
use std::os::windows::io::AsRawHandle as _;
use std::path::{Path, PathBuf};

const REPARSE: u32 = 0x400;
const OPEN_REPARSE: u32 = 0x0020_0000;
const MAX_SECURITY: usize = 64 * 1024;
const MAX_SECURITY_TOTAL: usize = 64 * 1024 * 1024;

#[repr(C)]
struct StreamData {
    size: i64,
    name: [u16; 296],
}
#[repr(C)]
struct FileInfo {
    attributes: u32,
    creation: [u32; 2],
    access: [u32; 2],
    write: [u32; 2],
    volume: u32,
    size_high: u32,
    size_low: u32,
    links: u32,
    index_high: u32,
    index_low: u32,
}
#[link(name = "kernel32")]
unsafe extern "system" {
    #[link_name = "FindFirstStreamW"]
    fn find_first_stream(
        path: *const u16,
        level: u32,
        data: *mut StreamData,
        flags: u32,
    ) -> *mut c_void;
    #[link_name = "FindNextStreamW"]
    fn find_next_stream(handle: *mut c_void, data: *mut StreamData) -> i32;
    #[link_name = "FindClose"]
    fn find_close(handle: *mut c_void) -> i32;
    #[link_name = "GetFileInformationByHandle"]
    fn get_file_information(handle: *mut c_void, info: *mut FileInfo) -> i32;
}

fn check_streams(path: &Path) -> Result<(), String> {
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut data = std::mem::MaybeUninit::<StreamData>::uninit();
    // SAFETY: path is terminated and data points to writable WIN32_FIND_STREAM_DATA storage.
    let handle = unsafe { find_first_stream(wide.as_ptr(), 0, data.as_mut_ptr(), 0) };
    if handle as isize == -1 {
        let error = std::io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(1 | 38 | 50) => Ok(()), // Filesystem does not support streams, or none exist.
            _ => Err(format!("Cannot inspect alternate data streams: {error}")),
        };
    }
    let result = (|| {
        loop {
            // SAFETY: FindFirstStreamW or FindNextStreamW initialized data on success.
            let stream = unsafe { data.assume_init_ref() };
            let end = stream
                .name
                .iter()
                .position(|&c| c == 0)
                .ok_or("Invalid stream name")?;
            if stream.name[..end] != [58, 58, 36, 68, 65, 84, 65] {
                return Err("Alternate data streams cannot be preserved safely".into());
            }
            // SAFETY: handle is live and data is writable.
            if unsafe { find_next_stream(handle, data.as_mut_ptr()) } == 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(38) {
                    break;
                }
                return Err(format!("Cannot inspect alternate data streams: {error}"));
            }
        }
        Ok(())
    })();
    // SAFETY: this is the owned search handle returned by FindFirstStreamW.
    unsafe { find_close(handle) };
    result
}

fn check_links(file: &File) -> Result<(), String> {
    let mut info = std::mem::MaybeUninit::<FileInfo>::uninit();
    // SAFETY: the File owns a live handle and info points to appropriately sized writable storage.
    if unsafe { get_file_information(file.as_raw_handle().cast(), info.as_mut_ptr()) } == 0 {
        return Err(format!(
            "Cannot inspect hard links: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: successful GetFileInformationByHandle initialized info.
    if unsafe { info.assume_init() }.links > 1 {
        return Err("Hard-linked files cannot be preserved safely".into());
    }
    Ok(())
}

fn metadata(path: &Path) -> Result<fs::Metadata, String> {
    let meta =
        fs::symlink_metadata(path).map_err(|e| format!("Cannot inspect snapshot entry: {e}"))?;
    if meta.file_attributes() & REPARSE != 0 {
        return Err("Windows reparse points cannot be saved safely".into());
    }
    Ok(meta)
}
fn root(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() || !metadata(path)?.is_dir() {
        return Err("Snapshot root is not an absolute directory".into());
    }
    fs::canonicalize(path).map_err(|e| format!("Cannot resolve snapshot root: {e}"))
}
fn check_parent(root: &Path, path: &Path) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid snapshot path")?;
    let relative = parent
        .strip_prefix(root)
        .map_err(|_| "Snapshot path escapes its root")?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        if !metadata(&current)?.is_dir() {
            return Err("Snapshot parent is not a directory".into());
        }
    }
    let resolved =
        fs::canonicalize(parent).map_err(|e| format!("Cannot resolve snapshot parent: {e}"))?;
    if !resolved.starts_with(root) {
        return Err("Snapshot path escapes its root".into());
    }
    Ok(())
}
fn open_read(path: &Path) -> Result<File, String> {
    let before = metadata(path)?;
    if !before.is_file() || before.len() > MAX_FILE {
        return Err("Snapshot file is unsupported or too large".into());
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(OPEN_REPARSE)
        .open(path)
        .map_err(|e| format!("Cannot open snapshot file: {e}"))?;
    let opened = file
        .metadata()
        .map_err(|e| format!("Cannot inspect snapshot file: {e}"))?;
    if !opened.is_file()
        || opened.file_attributes() & REPARSE != 0
        || opened.len() != before.len()
        || opened.last_write_time() != before.last_write_time()
        || opened.creation_time() != before.creation_time()
    {
        return Err("Snapshot file changed while opening".into());
    }
    Ok(file)
}
fn security(path: &Path) -> Result<String, String> {
    windows_security::reject_extended_attributes(path)?;
    let descriptor = windows_security::capture(path)?;
    if descriptor.len() > MAX_SECURITY {
        return Err("Security descriptor exceeds snapshot limit".into());
    }
    windows_security::verify(&descriptor)?;
    Ok(STANDARD.encode(descriptor))
}
fn decode_security(encoded: Option<&str>) -> Result<Vec<u8>, String> {
    let encoded = encoded.ok_or("Snapshot security descriptor is missing")?;
    if encoded.len() > MAX_SECURITY * 4 / 3 + 4 {
        return Err("Security descriptor exceeds snapshot limit".into());
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid snapshot security descriptor")?;
    if bytes.len() > MAX_SECURITY {
        return Err("Security descriptor exceeds snapshot limit".into());
    }
    windows_security::verify(&bytes)?;
    Ok(bytes)
}
fn hash(input: &mut File, mut output: Option<&mut File>) -> Result<(String, u64), String> {
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 16 * 1024];
    loop {
        let count = match input.read(&mut buffer) {
            Ok(count) => count,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(format!("Cannot read snapshot file: {e}")),
        };
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or("Snapshot file size limit exceeded")?;
        if total > MAX_FILE {
            return Err("Snapshot file size limit exceeded".into());
        }
        hasher.update(&buffer[..count]);
        if let Some(output) = output.as_mut() {
            output
                .write_all(&buffer[..count])
                .map_err(|e| format!("Cannot write snapshot file: {e}"))?;
        }
    }
    Ok((crate::json_store::hex_lower(&hasher.finalize()), total))
}
fn blobs(snapshot: &Path, create: bool) -> Result<PathBuf, String> {
    let snapshot = root(snapshot)?;
    let path = snapshot.join("blobs");
    if create {
        match crate::private_fs::private_dirs(false).create(&path) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(format!("Cannot create snapshot blobs: {e}")),
        }
    }
    if !metadata(&path)?.is_dir() {
        return Err("Snapshot blobs are not a directory".into());
    }
    root(&path)
}
fn check_blob(blobs: &Path, digest: &str, size: u64) -> Result<(), String> {
    let path = blobs.join(digest);
    check_parent(blobs, &path)?;
    let mut file = open_read(&path)?;
    let before = file
        .metadata()
        .map_err(|e| format!("Cannot inspect snapshot blob: {e}"))?;
    let (actual, count) = hash(&mut file, None)?;
    let after = file
        .metadata()
        .map_err(|e| format!("Cannot inspect snapshot blob: {e}"))?;
    if actual != digest
        || count != size
        || before.len() != after.len()
        || before.last_write_time() != after.last_write_time()
    {
        return Err("Snapshot blob failed integrity verification".into());
    }
    Ok(())
}
fn store_file(path: &Path, blobs: Option<&Path>) -> Result<(String, u64, u32), String> {
    check_streams(path)?;
    let mut input = open_read(path)?;
    check_links(&input)?;
    let before = input
        .metadata()
        .map_err(|e| format!("Cannot inspect snapshot file: {e}"))?;
    let mut temp = if let Some(blobs) = blobs {
        let mut random = [0u8; 16];
        SystemRandom::new()
            .fill(&mut random)
            .map_err(|_| "Cannot create secure snapshot temporary file")?;
        let path = blobs.join(format!(".tmp-{}", crate::json_store::hex_lower(&random)));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| format!("Cannot create snapshot blob: {e}"))?;
        Some((path, file))
    } else {
        None
    };
    let result = (|| {
        let (digest, size) = hash(&mut input, temp.as_mut().map(|(_, file)| file))?;
        let after = input
            .metadata()
            .map_err(|e| format!("Cannot inspect snapshot file: {e}"))?;
        if before.len() != after.len()
            || before.last_write_time() != after.last_write_time()
            || before.creation_time() != after.creation_time()
            || size != after.len()
        {
            return Err("File changed while creating snapshot".into());
        }
        if let Some((path, output)) = &temp {
            output
                .sync_all()
                .map_err(|e| format!("Cannot sync snapshot blob: {e}"))?;
            let dir = path.parent().ok_or("Invalid snapshot blob path")?;
            match fs::hard_link(path, dir.join(&digest)) {
                Ok(()) => (),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    check_blob(dir, &digest, size)?
                }
                Err(e) => return Err(format!("Cannot publish snapshot blob: {e}")),
            }
        }
        Ok((
            digest,
            size,
            if before.permissions().readonly() {
                0o444
            } else {
                0o666
            },
        ))
    })();
    if let Some((path, file)) = temp {
        drop(file);
        let _ = fs::remove_file(path);
    }
    result
}
struct Walker<'a> {
    root: &'a Path,
    blobs: Option<&'a Path>,
    ignored: Option<gix::AttributeStack<'a>>,
    indexed: [bool; 4],
    metadata: bool,
    visited: usize,
    security_bytes: usize,
    ignore_bytes: u64,
    manifest: Manifest,
}
impl Walker<'_> {
    fn walk(&mut self, relative: &str, depth: usize, cache: bool) -> Result<(), String> {
        if depth > MAX_DEPTH {
            return Err("Snapshot directory depth exceeded".into());
        }
        let dir = if relative.is_empty() {
            self.root.to_path_buf()
        } else {
            self.root.join(relative)
        };
        if !relative.is_empty() {
            check_parent(self.root, &dir)?;
        }
        if !metadata(&dir)?.is_dir() {
            return Err("Snapshot directory changed".into());
        }
        if !cache {
            check_streams(&dir)?;
        }
        let mut children = Vec::new();
        for entry in
            fs::read_dir(&dir).map_err(|e| format!("Cannot read snapshot directory: {e}"))?
        {
            children.push(
                entry
                    .map_err(|e| format!("Cannot read snapshot directory: {e}"))?
                    .file_name()
                    .into_string()
                    .map_err(|_| "Non-UTF-8 filesystem path cannot be saved")?,
            );
            if children.len() > MAX_ENTRIES {
                return Err("Snapshot entry limit exceeded".into());
            }
        }
        children.sort_unstable();
        if !self.metadata && !cache && children.iter().any(|name| name == ".gitignore") {
            let ignore = dir.join(".gitignore");
            let info = metadata(&ignore)?;
            if info.is_file() {
                if info.len() > MAX_IGNORE {
                    return Err("Git ignore file exceeds size limit".into());
                }
                self.ignore_bytes = self
                    .ignore_bytes
                    .checked_add(info.len())
                    .ok_or("Git ignore data exceeds size limit")?;
                if self.ignore_bytes > MAX_IGNORE_TOTAL {
                    return Err("Git ignore data exceeds size limit".into());
                }
            }
        }
        if !self.metadata && !relative.is_empty() && looks_bare(&children) {
            return Err("Nested Git repository cannot be saved safely".into());
        }
        for name in children {
            self.visited += 1;
            if self.visited > MAX_ENTRIES {
                return Err("Snapshot entry limit exceeded".into());
            }
            if relative.is_empty() && self.metadata {
                if matches!(name.as_str(), "HEAD" | "gitdir" | "commondir") {
                    continue;
                }
            }
            if relative.is_empty() && !self.metadata && name == ".git" {
                continue;
            }
            let rel = if relative.is_empty() {
                name.clone()
            } else {
                format!("{relative}/{name}")
            };
            valid_path(&rel)?;
            if self.metadata && forbidden_metadata(&rel) {
                return Err(
                    "An interrupted or unsupported Git operation prevents snapshotting".into(),
                );
            }
            let path = self.root.join(&rel);
            check_parent(self.root, &path)?;
            let meta = metadata(&path)?;
            if meta.is_dir() {
                let excluded =
                    if let Some(index) = cache_index(&name).filter(|_| !cache && !self.metadata) {
                        let indexed = self.indexed[index];
                        if indexed {
                            false
                        } else if let Some(ignored) = &mut self.ignored {
                            ignored
                                .at_path(&rel, Some(gix::index::entry::Mode::DIR))
                                .map_err(|e| format!("Cannot evaluate Git ignore rules: {e}"))?
                                .is_excluded()
                        } else {
                            false
                        }
                    } else {
                        false
                    };
                if !cache && !excluded {
                    let descriptor = self.security(&path)?;
                    self.add(
                        Entry {
                            path: rel.clone(),
                            mode: if meta.permissions().readonly() {
                                0o555
                            } else {
                                0o777
                            },
                            security: Some(descriptor),
                            owner: None,
                            xattrs: Vec::new(),
                            kind: Kind::Directory,
                        },
                        0,
                    )?;
                }
                self.walk(&rel, depth + 1, cache || excluded)?;
            } else if meta.is_file() {
                if !cache {
                    let descriptor = self.security(&path)?;
                    let (digest, size, mode) = store_file(&path, self.blobs)?;
                    self.add(
                        Entry {
                            path: rel,
                            mode,
                            security: Some(descriptor),
                            owner: None,
                            xattrs: Vec::new(),
                            kind: Kind::File { digest, size },
                        },
                        size,
                    )?;
                }
            } else {
                return Err("Special filesystem entries cannot be saved safely".into());
            }
        }
        Ok(())
    }
    fn security(&mut self, path: &Path) -> Result<String, String> {
        let descriptor = security(path)?;
        self.security_bytes = self
            .security_bytes
            .checked_add(descriptor.len())
            .ok_or("Security descriptor limit exceeded")?;
        if self.security_bytes > MAX_SECURITY_TOTAL {
            return Err("Security descriptor limit exceeded".into());
        }
        Ok(descriptor)
    }
    fn add(&mut self, entry: Entry, size: u64) -> Result<(), String> {
        if self.manifest.entries.len() >= MAX_ENTRIES {
            return Err("Snapshot entry limit exceeded".into());
        }
        self.manifest.bytes = self
            .manifest
            .bytes
            .checked_add(size)
            .ok_or("Snapshot byte limit exceeded")?;
        if self.manifest.bytes > MAX_TOTAL {
            return Err("Snapshot byte limit exceeded".into());
        }
        self.manifest.entries.push(entry);
        Ok(())
    }
}
fn gather(
    path: &Path,
    repo: Option<&gix::Repository>,
    snapshot: Option<&Path>,
) -> Result<Manifest, String> {
    let root = root(path)?;
    let blobs = snapshot.map(|snapshot| blobs(snapshot, true)).transpose()?;
    let mut indexed = [false; 4];
    let mut ignored = None;
    if let Some(repo) = repo {
        check_ignore_globals(repo)?;
        let mut ignore_bytes = 0;
        let index = repo
            .index_or_empty()
            .map_err(|e| format!("Cannot read Git index: {e}"))?;
        if index.entries().len() > MAX_ENTRIES {
            return Err("Git index exceeds snapshot entry limit".into());
        }
        for entry in index.entries() {
            if entry.mode.is_submodule() {
                return Err("Submodules cannot be snapshotted safely".into());
            }
            if entry.mode == gix::index::entry::Mode::DIR {
                return Err("Sparse Git indexes cannot be snapshotted safely".into());
            }
            let path = entry
                .path(&index)
                .to_str()
                .map_err(|_| "Non-UTF-8 Git index path cannot be saved")?;
            valid_path(path)?;
            count_indexed_ignore(repo, entry.id, path, &mut ignore_bytes)?;
            mark_indexed_caches(&mut indexed, path);
        }
        ignored = Some(
            repo.excludes(
                &index,
                None,
                gix::worktree::stack::state::ignore::Source::WorktreeThenIdMappingIfNotSkipped,
            )
            .map_err(|e| format!("Cannot read Git ignore rules: {e}"))?,
        );
    }
    let excluded_caches = if repo.is_some() {
        ["node_modules", "target", ".next", ".turbo"]
            .into_iter()
            .map(str::to_owned)
            .collect()
    } else {
        Vec::new()
    };
    let root_mode = if metadata(&root)?.permissions().readonly() {
        0o555
    } else {
        0o777
    };
    let root_security = security(&root)?;
    let mut walker = Walker {
        root: &root,
        blobs: blobs.as_deref(),
        ignored,
        indexed,
        metadata: repo.is_none(),
        visited: 0,
        security_bytes: root_security.len(),
        ignore_bytes: 0,
        manifest: Manifest {
            entries: Vec::new(),
            bytes: 0,
            root_mode,
            root_security: Some(root_security),
            root_owner: None,
            root_xattrs: Vec::new(),
            excluded_caches,
        },
    };
    walker.walk("", 0, false)?;
    walker
        .manifest
        .entries
        .sort_unstable_by(|a, b| a.path.cmp(&b.path));
    valid_manifest(&walker.manifest)?;
    Ok(walker.manifest)
}
fn stable(
    path: &Path,
    repo: Option<&gix::Repository>,
    snapshot: Option<&Path>,
) -> Result<Manifest, String> {
    let first = gather(path, repo, snapshot)?;
    if first != gather(path, repo, None)? {
        return Err("Filesystem changed during snapshot".into());
    }
    Ok(first)
}
pub(in super::super) fn capture(
    root: &Path,
    repo: &gix::Repository,
    snapshot: &Path,
) -> Result<Manifest, String> {
    stable(root, Some(repo), Some(snapshot))
}
pub(in super::super) fn scan(root: &Path, repo: &gix::Repository) -> Result<Manifest, String> {
    stable(root, Some(repo), None)
}
pub(in super::super) fn capture_metadata(root: &Path, snapshot: &Path) -> Result<Manifest, String> {
    stable(root, None, Some(snapshot))
}
pub(in super::super) fn scan_metadata(root: &Path) -> Result<Manifest, String> {
    stable(root, None, None)
}
fn preflight_security(snapshot: &Path, descriptors: &BTreeSet<(&str, bool)>) -> Result<(), String> {
    if descriptors.len() > 4096 {
        return Err("Too many distinct security descriptors to verify safely".into());
    }
    let snapshot = root(snapshot)?;
    let mut random = [0u8; 16];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| "Cannot create secure security probe")?;
    let scratch = snapshot.join(format!(
        ".security-probe-{}",
        crate::json_store::hex_lower(&random)
    ));
    fs::create_dir(&scratch).map_err(|e| format!("Cannot create security probe: {e}"))?;
    let result = (|| {
        for (index, (encoded, directory)) in descriptors.iter().enumerate() {
            let path = scratch.join(format!("{index:x}"));
            if *directory {
                fs::create_dir(&path)
                    .map_err(|e| format!("Cannot create security probe directory: {e}"))?;
            } else {
                let file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)
                    .map_err(|e| format!("Cannot create security probe file: {e}"))?;
                drop(file);
            }
            let outcome = decode_security(Some(*encoded))
                .and_then(|bytes| windows_security::restore(&path, &bytes));
            let cleanup = if *directory {
                fs::remove_dir(&path)
            } else {
                fs::remove_file(&path)
            };
            cleanup.map_err(|e| format!("Cannot remove empty security probe: {e}"))?;
            outcome?;
        }
        Ok(())
    })();
    let cleanup = fs::remove_dir(&scratch);
    cleanup.map_err(|e| format!("Cannot remove security probe directory: {e}"))?;
    result
}
pub(in super::super) fn verify(snapshot: &Path, manifest: &Manifest) -> Result<(), String> {
    valid_manifest(manifest)?;
    let mut descriptor_bytes = decode_security(manifest.root_security.as_deref())?.len();
    let blobs = blobs(snapshot, false)?;
    let mut seen = BTreeSet::new();
    let mut descriptors = BTreeSet::new();
    descriptors.insert((
        manifest
            .root_security
            .as_deref()
            .ok_or("Snapshot security descriptor is missing")?,
        true,
    ));
    for entry in &manifest.entries {
        descriptor_bytes = descriptor_bytes
            .checked_add(decode_security(entry.security.as_deref())?.len())
            .ok_or("Security descriptor limit exceeded")?;
        if descriptor_bytes > MAX_SECURITY_TOTAL {
            return Err("Security descriptor limit exceeded".into());
        }
        let descriptor = entry
            .security
            .as_deref()
            .ok_or("Snapshot security descriptor is missing")?;
        descriptors.insert((descriptor, matches!(entry.kind, Kind::Directory)));
        match &entry.kind {
            Kind::File { digest, size } if seen.insert((digest.as_str(), *size)) => {
                check_blob(&blobs, digest, *size)?
            }
            Kind::Symlink { .. } => {
                return Err("Windows symbolic links cannot be restored safely".into())
            }
            _ => (),
        }
    }
    preflight_security(snapshot, &descriptors)
}
fn exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Cannot inspect restore entry: {error}")),
    }
}
fn remove_generated(path: &Path, index: bool) -> Result<(), String> {
    let mut file = open_read(path)?;
    if index {
        let mut header = [0u8; 12];
        file.read_exact(&mut header)
            .map_err(|_| "Generated Git index is invalid")?;
        if &header[..4] != b"DIRC" || header[8..] != [0, 0, 0, 0] {
            return Err("Generated Git index is not empty".into());
        }
    }
    drop(file);
    fs::remove_file(path).map_err(|e| format!("Cannot replace generated Git metadata: {e}"))
}
fn restore_inner(
    root_path: &Path,
    snapshot: &Path,
    manifest: &Manifest,
    git: bool,
) -> Result<(), String> {
    verify(snapshot, manifest)?;
    let root = root(root_path)?;
    if !git {
        for entry in
            fs::read_dir(&root).map_err(|e| format!("Cannot inspect restore directory: {e}"))?
        {
            if entry
                .map_err(|e| format!("Cannot inspect restore directory: {e}"))?
                .file_name()
                != ".git"
            {
                return Err("Restore destination is not empty".into());
            }
        }
    } else if !manifest.excluded_caches.is_empty() {
        return Err("Git metadata cannot have cache exclusions".into());
    }
    if git {
        for entry in &manifest.entries {
            if matches!(entry.path.as_str(), "HEAD" | "gitdir" | "commondir")
                || forbidden_metadata(&entry.path)
            {
                return Err("Snapshot contains structural or interrupted Git metadata".into());
            }
        }
        let index = root.join("index");
        if exists(&index)? && !manifest.entries.iter().any(|entry| entry.path == "index") {
            remove_generated(&index, true)?;
        }
        let logs = root.join("logs");
        if exists(&logs)? {
            if !metadata(&logs)?.is_dir() {
                return Err("Git logs destination is not a directory".into());
            }
            let head = logs.join("HEAD");
            if exists(&head)?
                && !manifest
                    .entries
                    .iter()
                    .any(|entry| entry.path == "logs/HEAD")
            {
                remove_generated(&head, false)?;
            }
            if !manifest.entries.iter().any(|entry| entry.path == "logs") {
                fs::remove_dir(&logs)
                    .map_err(|e| format!("Cannot remove empty generated Git logs: {e}"))?;
            }
        }
    }
    let blobs = blobs(snapshot, false)?;
    for entry in &manifest.entries {
        let path = root.join(&entry.path);
        check_parent(&root, &path)?;
        match &entry.kind {
            Kind::Directory => {
                if git && matches!(entry.path.as_str(), "logs" | "refs") && exists(&path)? {
                    if !metadata(&path)?.is_dir() {
                        return Err("Git logs destination is not a directory".into());
                    }
                } else {
                    fs::create_dir(&path).map_err(|e| {
                        format!("Cannot create restore directory without collision: {e}")
                    })?;
                }
            }
            Kind::File { digest, size } => {
                if git && (entry.path == "index" || entry.path == "logs/HEAD") && exists(&path)? {
                    remove_generated(&path, entry.path == "index")?;
                }
                let mut source = open_read(&blobs.join(digest))?;
                let mut output = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .custom_flags(OPEN_REPARSE)
                    .open(&path)
                    .map_err(|e| format!("Cannot restore file without collision: {e}"))?;
                let (actual, count) = hash(&mut source, Some(&mut output))?;
                if actual != *digest || count != *size {
                    return Err("Snapshot blob changed during restore".into());
                }
                output
                    .sync_all()
                    .map_err(|e| format!("Cannot sync restored file: {e}"))?;
                let mut permissions = output
                    .metadata()
                    .map_err(|e| format!("Cannot inspect restored file: {e}"))?
                    .permissions();
                permissions.set_readonly(entry.mode & 0o200 == 0);
                output
                    .set_permissions(permissions)
                    .map_err(|e| format!("Cannot set restored file mode: {e}"))?;
                windows_security::restore(&path, &decode_security(entry.security.as_deref())?)?;
            }
            Kind::Symlink { .. } => {
                return Err("Windows symbolic links cannot be restored safely".into())
            }
        }
    }
    for entry in manifest.entries.iter().rev() {
        if matches!(entry.kind, Kind::Directory) {
            let path = root.join(&entry.path);
            check_parent(&root, &path)?;
            let mut permissions = metadata(&path)?.permissions();
            permissions.set_readonly(entry.mode & 0o200 == 0);
            fs::set_permissions(&path, permissions)
                .map_err(|e| format!("Cannot set restored directory mode: {e}"))?;
            windows_security::restore(&path, &decode_security(entry.security.as_deref())?)?;
        }
    }
    let mut permissions = metadata(&root)?.permissions();
    permissions.set_readonly(manifest.root_mode & 0o200 == 0);
    fs::set_permissions(&root, permissions)
        .map_err(|e| format!("Cannot set restored root mode: {e}"))?;
    windows_security::restore(&root, &decode_security(manifest.root_security.as_deref())?)?;
    Ok(())
}
pub(in super::super) fn restore(
    root: &Path,
    snapshot: &Path,
    manifest: &Manifest,
) -> Result<(), String> {
    restore_inner(root, snapshot, manifest, false)
}
pub(in super::super) fn restore_metadata(
    root: &Path,
    snapshot: &Path,
    manifest: &Manifest,
) -> Result<(), String> {
    restore_inner(root, snapshot, manifest, true)
}
