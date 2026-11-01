use super::{
    cache_index, check_ignore_globals, count_indexed_ignore, forbidden_metadata, looks_bare,
    mark_indexed_caches, valid_manifest, valid_path, Entry, Kind, Manifest, Owner, Xattr,
    MAX_DEPTH, MAX_ENTRIES, MAX_FILE, MAX_IGNORE, MAX_IGNORE_TOTAL, MAX_PATH, MAX_TOTAL,
    MAX_XATTR_COUNT, MAX_XATTR_TOTAL, MAX_XATTR_VALUE,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use gix::bstr::ByteSlice as _;
use ring::rand::{SecureRandom as _, SystemRandom};
use sha2::{Digest as _, Sha256};
use std::collections::BTreeSet;
use std::ffi::{CStr, CString};
use std::fs::{self, File, OpenOptions};
use std::io::{Read as _, Write as _};
use std::os::fd::{AsRawFd as _, FromRawFd as _, IntoRawFd as _};
use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};

fn cstring(bytes: &[u8]) -> Result<CString, String> {
    CString::new(bytes).map_err(|_| "Invalid filesystem path".into())
}

fn open_root(path: &Path) -> Result<File, String> {
    if !path.is_absolute() {
        return Err("Snapshot root must be absolute".into());
    }
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| format!("Cannot open snapshot root: {e}"))
}

fn open_at(dir: &File, name: &str, flags: i32, mode: u32) -> Result<File, String> {
    let name = cstring(name.as_bytes())?;
    // SAFETY: dir is open, name is NUL terminated, and successful descriptors are owned by File.
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            mode,
        )
    };
    if fd < 0 {
        return Err(format!(
            "Cannot open snapshot entry: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: openat returned a new, owned descriptor.
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn stat_at(dir: &File, name: &str) -> Result<libc::stat, String> {
    let name = cstring(name.as_bytes())?;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: stat points to writable memory and name is NUL terminated; no link is followed.
    if unsafe {
        libc::fstatat(
            dir.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(format!(
            "Cannot inspect snapshot entry: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: a successful fstatat initialized the structure.
    Ok(unsafe { stat.assume_init() })
}

#[cfg(target_os = "macos")]
unsafe fn errno_ptr() -> *mut libc::c_int {
    unsafe { libc::__error() }
}
#[cfg(not(target_os = "macos"))]
unsafe fn errno_ptr() -> *mut libc::c_int {
    unsafe { libc::__errno_location() }
}

fn names(dir: &File) -> Result<Vec<String>, String> {
    let duplicate = open_at(dir, ".", libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
    // SAFETY: fdopendir takes ownership of the fresh descriptor on success.
    let raw = duplicate.into_raw_fd();
    let stream = unsafe { libc::fdopendir(raw) };
    if stream.is_null() {
        // SAFETY: fdopendir failed and did not take ownership.
        unsafe { libc::close(raw) };
        return Err(format!(
            "Cannot read snapshot directory: {}",
            std::io::Error::last_os_error()
        ));
    }
    let result = (|| {
        let mut out = Vec::new();
        loop {
            // SAFETY: errno is thread-local and stream remains open until closedir.
            unsafe {
                *errno_ptr() = 0;
            }
            // SAFETY: stream is a live DIR pointer.
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                // SAFETY: errno is thread-local.
                if unsafe { *errno_ptr() } != 0 {
                    return Err(format!(
                        "Cannot read snapshot directory: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                break;
            }
            // SAFETY: readdir returned a valid entry whose name is NUL terminated.
            let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if bytes == b"." || bytes == b".." {
                continue;
            }
            let name = std::str::from_utf8(bytes)
                .map_err(|_| "Non-UTF-8 filesystem path cannot be saved")?;
            out.push(name.to_owned());
            if out.len() > MAX_ENTRIES {
                return Err("Snapshot entry limit exceeded".into());
            }
        }
        out.sort_unstable();
        Ok(out)
    })();
    // SAFETY: stream is owned here and is closed exactly once.
    unsafe { libc::closedir(stream) };
    result
}

fn read_link(dir: &File, name: &str) -> Result<String, String> {
    let name = cstring(name.as_bytes())?;
    let mut bytes = vec![0u8; MAX_PATH + 1];
    // SAFETY: output buffer is valid and readlinkat never follows the final symlink.
    let count = unsafe {
        libc::readlinkat(
            dir.as_raw_fd(),
            name.as_ptr(),
            bytes.as_mut_ptr().cast(),
            bytes.len(),
        )
    };
    if count < 0 {
        return Err(format!(
            "Cannot read symbolic link: {}",
            std::io::Error::last_os_error()
        ));
    }
    let count = count.cast_unsigned();
    if count == 0 || count > MAX_PATH {
        return Err("Symbolic link target exceeds snapshot limits".into());
    }
    bytes.truncate(count);
    String::from_utf8(bytes).map_err(|_| "Non-UTF-8 symbolic link target cannot be saved".into())
}

fn same_file(stat: &libc::stat, meta: &fs::Metadata) -> bool {
    #[cfg(target_os = "macos")]
    let device = i64::from(stat.st_dev).cast_unsigned();
    #[cfg(not(target_os = "macos"))]
    let device = stat.st_dev;
    device == meta.dev() && stat.st_ino == meta.ino()
}

fn unchanged(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.mode() == b.mode()
        && a.len() == b.len()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}

fn set_owner(file: &File, owner: Owner) -> Result<(), String> {
    let current = file
        .metadata()
        .map_err(|e| format!("Cannot inspect restored ownership: {e}"))?;
    if current.uid() != owner.uid || current.gid() != owner.gid {
        // SAFETY: the live fd is owned by this process; fchown does not resolve a path.
        if unsafe { libc::fchown(file.as_raw_fd(), owner.uid, owner.gid) } != 0 {
            return Err(format!(
                "Cannot restore file ownership: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    let actual = file
        .metadata()
        .map_err(|e| format!("Cannot verify restored ownership: {e}"))?;
    if actual.uid() != owner.uid || actual.gid() != owner.gid {
        return Err("Restored file ownership did not match".into());
    }
    Ok(())
}

fn set_link_owner(parent: &File, name: &str, owner: Owner) -> Result<(), String> {
    let current = stat_at(parent, name)?;
    if current.st_mode & libc::S_IFMT != libc::S_IFLNK {
        return Err("Restored symbolic link changed".into());
    }
    if current.st_uid != owner.uid || current.st_gid != owner.gid {
        let name = cstring(name.as_bytes())?;
        // SAFETY: parent is an open directory and fchownat does not follow the link.
        if unsafe {
            libc::fchownat(
                parent.as_raw_fd(),
                name.as_ptr(),
                owner.uid,
                owner.gid,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err(format!(
                "Cannot restore symbolic link ownership: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    let after = stat_at(parent, name)?;
    if after.st_uid != owner.uid
        || after.st_gid != owner.gid
        || after.st_dev != current.st_dev
        || after.st_ino != current.st_ino
    {
        return Err("Restored symbolic link ownership did not match".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn acl_get_fd_np(fd: libc::c_int, kind: libc::c_int) -> *mut libc::c_void;
    fn acl_free(acl: *mut libc::c_void) -> libc::c_int;
}

#[cfg(target_os = "macos")]
fn check_acl(file: &File) -> Result<(), String> {
    // SAFETY: fd is live and 0x100 is the platform ACL_TYPE_EXTENDED.
    let acl = unsafe { acl_get_fd_np(file.as_raw_fd(), 0x100) };
    if acl.is_null() {
        let error = std::io::Error::last_os_error();
        if !matches!(error.raw_os_error(), Some(libc::ENOENT | libc::EOPNOTSUPP)) {
            return Err(format!("Cannot inspect filesystem ACL: {error}"));
        }
    } else {
        // SAFETY: acl_get_fd_np returned an owned ACL which must be freed once.
        unsafe { acl_free(acl) };
        return Err("Filesystem ACLs cannot be preserved safely".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn check_private_handle(file: &File) -> Result<(), String> {
    let meta = file
        .metadata()
        .map_err(|e| format!("Cannot inspect private storage: {e}"))?;
    // SAFETY: geteuid has no preconditions.
    let uid = unsafe { libc::geteuid() };
    if (!meta.is_file() && !meta.is_dir()) || meta.uid() != uid || meta.mode() & 0o077 != 0 {
        return Err("Recovery storage ownership or permissions are not private".into());
    }
    check_acl(file)
}

#[cfg(target_os = "macos")]
pub(in super::super) fn check_private_storage(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Recovery storage path must be absolute".into());
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| format!("Cannot open private recovery storage: {e}"))?;
    check_private_handle(&file)
}

fn check_attributes(file: &File) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: the live fd is queried into writable stat storage.
        if unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
            return Err(format!(
                "Cannot inspect filesystem flags: {}",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: successful fstat initialized stat.
        if unsafe { stat.assume_init() }.st_flags != 0 {
            return Err("Filesystem flags cannot be preserved safely".into());
        }
    }
    #[cfg(target_os = "macos")]
    check_acl(file)?;
    Ok(())
}

fn list_xattrs(file: &File) -> Result<Vec<Xattr>, String> {
    #[cfg(target_os = "macos")]
    // SAFETY: fd is live; zero length permits a null output pointer.
    let length = unsafe { libc::flistxattr(file.as_raw_fd(), std::ptr::null_mut(), 0, 0) };
    #[cfg(not(target_os = "macos"))]
    // SAFETY: fd is live; zero length permits a null output pointer.
    let length = unsafe { libc::flistxattr(file.as_raw_fd(), std::ptr::null_mut(), 0) };
    if length < 0 {
        let error = std::io::Error::last_os_error();
        return if error.raw_os_error() == Some(libc::EOPNOTSUPP) {
            Ok(Vec::new())
        } else {
            Err(format!("Cannot list extended attributes: {error}"))
        };
    }
    let length = length.cast_unsigned();
    if length > MAX_XATTR_COUNT * 256 {
        return Err("Extended attribute names exceed snapshot limit".into());
    }
    if length == 0 {
        return Ok(Vec::new());
    }
    let mut names = vec![0u8; length];
    #[cfg(target_os = "macos")]
    // SAFETY: buffer has the stated length and fd is live.
    let count =
        unsafe { libc::flistxattr(file.as_raw_fd(), names.as_mut_ptr().cast(), names.len(), 0) };
    #[cfg(not(target_os = "macos"))]
    // SAFETY: buffer has the stated length and fd is live.
    let count =
        unsafe { libc::flistxattr(file.as_raw_fd(), names.as_mut_ptr().cast(), names.len()) };
    if count < 0 || count.cast_unsigned() != length || names.last() != Some(&0) {
        return Err("Extended attributes changed while being captured".into());
    }
    read_xattr_values(file, &names)
}

fn read_xattr_values(file: &File, names: &[u8]) -> Result<Vec<Xattr>, String> {
    let mut attrs = Vec::new();
    let mut total = 0usize;
    for bytes in names[..names.len() - 1].split(|b| *b == 0) {
        if bytes.is_empty() || bytes.len() > 255 || attrs.len() >= MAX_XATTR_COUNT {
            return Err("Extended attribute name exceeds snapshot limit".into());
        }
        let name = std::str::from_utf8(bytes)
            .map_err(|_| "Non-UTF-8 extended attribute name cannot be saved")?;
        if super::security_xattr(name) {
            return Err(format!(
                "Security or ACL extended attribute {name} cannot be preserved safely"
            ));
        }
        let c_name = cstring(bytes)?;
        #[cfg(target_os = "macos")]
        // SAFETY: name is terminated and a zero-length read permits a null buffer.
        let size = unsafe {
            libc::fgetxattr(
                file.as_raw_fd(),
                c_name.as_ptr(),
                std::ptr::null_mut(),
                0,
                0,
                0,
            )
        };
        #[cfg(not(target_os = "macos"))]
        // SAFETY: name is terminated and a zero-length read permits a null buffer.
        let size =
            unsafe { libc::fgetxattr(file.as_raw_fd(), c_name.as_ptr(), std::ptr::null_mut(), 0) };
        if size < 0 {
            return Err(format!(
                "Cannot inspect extended attribute: {}",
                std::io::Error::last_os_error()
            ));
        }
        let size = size.cast_unsigned();
        if size > MAX_XATTR_VALUE {
            return Err("Extended attribute value exceeds snapshot limit".into());
        }
        total = total
            .checked_add(size + bytes.len())
            .ok_or("Extended attributes exceed snapshot limit")?;
        if total > MAX_XATTR_TOTAL {
            return Err("Extended attributes exceed snapshot limit".into());
        }
        let mut value = vec![0u8; size];
        #[cfg(target_os = "macos")]
        // SAFETY: output buffer is valid for size bytes and name is terminated.
        let actual = unsafe {
            libc::fgetxattr(
                file.as_raw_fd(),
                c_name.as_ptr(),
                value.as_mut_ptr().cast(),
                size,
                0,
                0,
            )
        };
        #[cfg(not(target_os = "macos"))]
        // SAFETY: output buffer is valid for size bytes and name is terminated.
        let actual = unsafe {
            libc::fgetxattr(
                file.as_raw_fd(),
                c_name.as_ptr(),
                value.as_mut_ptr().cast(),
                size,
            )
        };
        if actual < 0 || actual.cast_unsigned() != size {
            return Err("Extended attribute changed while being captured".into());
        }
        attrs.push(Xattr {
            name: name.to_owned(),
            value: STANDARD.encode(value),
        });
    }
    attrs.sort_unstable_by(|a, b| a.name.cmp(&b.name));
    if attrs.windows(2).any(|p| p[0].name == p[1].name) {
        return Err("Duplicate extended attribute name".into());
    }
    Ok(attrs)
}

fn restore_xattrs(file: &File, expected: &[Xattr]) -> Result<(), String> {
    let current = list_xattrs(file)?;
    for attr in &current {
        if expected
            .binary_search_by(|wanted| wanted.name.cmp(&attr.name))
            .is_err()
        {
            let name = cstring(attr.name.as_bytes())?;
            #[cfg(target_os = "macos")]
            // SAFETY: fd is live and name is terminated.
            let result = unsafe { libc::fremovexattr(file.as_raw_fd(), name.as_ptr(), 0) };
            #[cfg(not(target_os = "macos"))]
            // SAFETY: fd is live and name is terminated.
            let result = unsafe { libc::fremovexattr(file.as_raw_fd(), name.as_ptr()) };
            if result != 0 {
                return Err(format!(
                    "Cannot remove unexpected extended attribute {}: {}",
                    attr.name,
                    std::io::Error::last_os_error()
                ));
            }
        }
    }
    for attr in expected {
        if current.iter().any(|existing| existing == attr) {
            continue;
        }
        let name = cstring(attr.name.as_bytes())?;
        let value = STANDARD
            .decode(&attr.value)
            .map_err(|_| "Invalid snapshot extended attribute encoding")?;
        #[cfg(target_os = "macos")]
        // SAFETY: fd is live and name and value point to valid buffers.
        let result = unsafe {
            libc::fsetxattr(
                file.as_raw_fd(),
                name.as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
                0,
            )
        };
        #[cfg(not(target_os = "macos"))]
        // SAFETY: fd is live and name and value point to valid buffers.
        let result = unsafe {
            libc::fsetxattr(
                file.as_raw_fd(),
                name.as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
            )
        };
        if result != 0 {
            return Err(format!(
                "Cannot restore extended attribute {}: {}",
                attr.name,
                std::io::Error::last_os_error()
            ));
        }
    }
    if list_xattrs(file)? != expected {
        return Err("Restored extended attributes did not match".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_link(dir: &File, name: &str) -> Result<File, String> {
    let name = cstring(name.as_bytes())?;
    // SAFETY: O_SYMLINK opens the link itself, never its target.
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_SYMLINK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(format!(
            "Cannot inspect symbolic link: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: openat returned a new descriptor owned by File.
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn check_link_attributes(dir: &File, name: &str, stat: &libc::stat) -> Result<Vec<Xattr>, String> {
    #[cfg(target_os = "macos")]
    {
        let link = open_link(dir, name)?;
        let meta = link
            .metadata()
            .map_err(|e| format!("Cannot inspect symbolic link: {e}"))?;
        if !meta.file_type().is_symlink() || !same_file(stat, &meta) {
            return Err("Symbolic link changed during snapshot".into());
        }
        check_attributes(&link)?;
        list_xattrs(&link)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = stat;
        let path = cstring(format!("/proc/self/fd/{}/{name}", dir.as_raw_fd()).as_bytes())?;
        // SAFETY: procfs resolves the live directory fd, and llistxattr does not follow the final link.
        let count = unsafe { libc::llistxattr(path.as_ptr(), std::ptr::null_mut(), 0) };
        if count > 0 {
            return Err("Symbolic link attributes cannot be preserved safely".into());
        }
        if count < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::EOPNOTSUPP) {
                return Err(format!("Cannot inspect symbolic link attributes: {error}"));
            }
        }
        Ok(Vec::new())
    }
}

fn random_name() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "Cannot create secure snapshot temporary file")?;
    Ok(format!(".tmp-{}", crate::json_store::hex_lower(&bytes)))
}

fn blob_dir(snapshot: &Path, create: bool) -> Result<PathBuf, String> {
    let root = open_root(snapshot)?;
    #[cfg(target_os = "macos")]
    check_private_handle(&root)?;
    let path = snapshot.join("blobs");
    if create {
        match crate::private_fs::private_dirs(false).create(&path) {
            Ok(()) => root
                .sync_all()
                .map_err(|e| format!("Cannot sync snapshot directory: {e}"))?,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(format!("Cannot create snapshot blobs: {e}")),
        }
    }
    let dir = open_root(&path)?;
    #[cfg(target_os = "macos")]
    check_private_handle(&dir)?;
    let metadata = dir
        .metadata()
        .map_err(|e| format!("Cannot inspect snapshot blobs: {e}"))?;
    if metadata.mode() & 0o077 != 0 {
        return Err("Snapshot blob directory is not private".into());
    }
    Ok(path)
}

fn hash_reader(input: &mut File, mut output: Option<&mut File>) -> Result<(String, u64), String> {
    let mut hash = Sha256::new();
    let mut size = 0u64;
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
        size = size
            .checked_add(count as u64)
            .ok_or("Snapshot file exceeds size limit")?;
        if size > MAX_FILE {
            return Err("Snapshot file exceeds size limit".into());
        }
        hash.update(&buffer[..count]);
        if let Some(writer) = output.as_mut() {
            writer
                .write_all(&buffer[..count])
                .map_err(|e| format!("Cannot write snapshot blob: {e}"))?;
        }
    }
    Ok((crate::json_store::hex_lower(&hash.finalize()), size))
}

fn store_file(
    dir: &File,
    name: &str,
    stat: &libc::stat,
    blobs: Option<&Path>,
) -> Result<(String, u64, u32, Owner, Vec<Xattr>), String> {
    let mut input = open_at(dir, name, libc::O_RDONLY | libc::O_NONBLOCK, 0)?;
    let before = input
        .metadata()
        .map_err(|e| format!("Cannot inspect snapshot file: {e}"))?;
    if !before.is_file() || !same_file(stat, &before) || before.len() > MAX_FILE {
        return Err("Snapshot file changed or is unsupported".into());
    }
    if before.nlink() > 1 {
        return Err("Hard-linked files cannot be preserved safely".into());
    }
    check_attributes(&input)?;
    let xattrs = list_xattrs(&input)?;
    let temp = if let Some(blobs) = blobs {
        let path = blobs.join(random_name()?);
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| format!("Cannot create snapshot blob: {e}"))?;
        Some((path, file))
    } else {
        None
    };
    let mut temp = temp;
    let result = (|| {
        #[cfg(target_os = "macos")]
        if let Some((_, file)) = &temp {
            check_private_handle(file)?;
        }
        let (digest, size) = hash_reader(&mut input, temp.as_mut().map(|(_, file)| file))?;
        if list_xattrs(&input)? != xattrs {
            return Err("Extended attributes changed while creating snapshot".into());
        }
        let after = input
            .metadata()
            .map_err(|e| format!("Cannot recheck snapshot file: {e}"))?;
        let current = stat_at(dir, name)?;
        if !unchanged(&before, &after) || !same_file(&current, &after) || size != after.len() {
            return Err("File changed while creating snapshot".into());
        }
        if let Some((path, file)) = &temp {
            file.sync_all()
                .map_err(|e| format!("Cannot sync snapshot blob: {e}"))?;
            let blobs = path.parent().ok_or("Invalid snapshot blob path")?;
            let target = blobs.join(&digest);
            match fs::hard_link(path, &target) {
                Ok(()) => (),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    check_blob(blobs, &digest, size)?;
                }
                Err(e) => return Err(format!("Cannot publish snapshot blob: {e}")),
            }
            open_root(blobs)?
                .sync_all()
                .map_err(|e| format!("Cannot sync snapshot blobs: {e}"))?;
        }
        Ok((
            digest,
            size,
            before.mode() & 0o7777,
            Owner {
                uid: before.uid(),
                gid: before.gid(),
            },
            xattrs,
        ))
    })();
    if let Some((path, _)) = temp {
        let _ = fs::remove_file(path);
    }
    result
}

fn check_blob(blobs: &Path, digest: &str, expected: u64) -> Result<(), String> {
    let dir = open_root(blobs)?;
    let mut file = open_at(&dir, digest, libc::O_RDONLY | libc::O_NONBLOCK, 0)?;
    let before = file
        .metadata()
        .map_err(|e| format!("Cannot inspect snapshot blob: {e}"))?;
    if !before.is_file() || before.len() != expected || before.mode() & 0o077 != 0 {
        return Err("Snapshot blob is invalid or not private".into());
    }
    let (actual, size) = hash_reader(&mut file, None)?;
    let after = file
        .metadata()
        .map_err(|e| format!("Cannot recheck snapshot blob: {e}"))?;
    if size != expected || actual != digest || !unchanged(&before, &after) {
        return Err("Snapshot blob failed integrity verification".into());
    }
    Ok(())
}

struct Walker<'a> {
    manifest: Manifest,
    blobs: Option<&'a Path>,
    ignored: Option<gix::AttributeStack<'a>>,
    indexed: [bool; 4],
    metadata: bool,
    visited: usize,
    ignore_bytes: u64,
    xattr_bytes: usize,
}

impl Walker<'_> {
    fn add(&mut self, entry: Entry, size: u64) -> Result<(), String> {
        super::validate_xattrs(&entry.xattrs, &mut self.xattr_bytes).map_err(|error| {
            format!(
                "Cannot preserve extended attributes for {}: {error}",
                entry.path
            )
        })?;
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

    fn probe_cache(&mut self, dir: &File, prefix: &str, depth: usize) -> Result<(), String> {
        if depth > MAX_DEPTH {
            return Err("Snapshot directory depth exceeded".into());
        }
        let before = dir
            .metadata()
            .map_err(|e| format!("Cannot inspect cache directory: {e}"))?;
        let children = names(dir)?;
        if looks_bare(&children) {
            return Err("Nested Git repository cannot be saved safely".into());
        }
        for name in children {
            self.visited += 1;
            if self.visited > MAX_ENTRIES {
                return Err("Snapshot entry limit exceeded".into());
            }
            let path = format!("{prefix}/{name}");
            valid_path(&path)?;
            let stat = stat_at(dir, &name)?;
            match stat.st_mode & libc::S_IFMT {
                libc::S_IFDIR => {
                    let child = open_at(dir, &name, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
                    let meta = child
                        .metadata()
                        .map_err(|e| format!("Cannot inspect cache directory: {e}"))?;
                    if !same_file(&stat, &meta) {
                        return Err("Cache directory changed during snapshot".into());
                    }
                    self.probe_cache(&child, &path, depth + 1)?;
                    if !same_file(&stat_at(dir, &name)?, &meta) {
                        return Err("Cache directory changed during snapshot".into());
                    }
                }
                libc::S_IFREG | libc::S_IFLNK => (),
                _ => return Err("Special filesystem entries cannot be saved safely".into()),
            }
        }
        let after = dir
            .metadata()
            .map_err(|e| format!("Cannot recheck cache directory: {e}"))?;
        if !unchanged(&before, &after) {
            return Err("Cache directory changed during snapshot".into());
        }
        Ok(())
    }

    fn walk(
        &mut self,
        dir: &File,
        prefix: &str,
        depth: usize,
        safe_ignore: bool,
    ) -> Result<(), String> {
        if depth > MAX_DEPTH {
            return Err("Snapshot directory depth exceeded".into());
        }
        let before = dir
            .metadata()
            .map_err(|e| format!("Cannot inspect snapshot directory: {e}"))?;
        check_attributes(dir).map_err(|error| {
            format!(
                "Cannot inspect {}: {error}",
                if prefix.is_empty() { "." } else { prefix }
            )
        })?;
        let directory_xattrs = list_xattrs(dir).map_err(|error| {
            format!(
                "Cannot inspect extended attributes for {}: {error}",
                if prefix.is_empty() { "." } else { prefix }
            )
        })?;
        let names = names(dir)?;
        if !self.metadata && !prefix.is_empty() && looks_bare(&names) {
            return Err("Nested Git repository cannot be saved safely".into());
        }
        let mut safe_ignore = safe_ignore;
        if names.iter().any(|n| n == ".gitignore") {
            let stat = stat_at(dir, ".gitignore")?;
            if stat.st_mode & libc::S_IFMT == libc::S_IFREG {
                let size = u64::try_from(stat.st_size)
                    .map_err(|_| "Git ignore file has an invalid size")?;
                if size > MAX_IGNORE {
                    return Err("Git ignore file exceeds size limit".into());
                }
                self.ignore_bytes = self
                    .ignore_bytes
                    .checked_add(size)
                    .ok_or("Git ignore data exceeds size limit")?;
                if self.ignore_bytes > MAX_IGNORE_TOTAL {
                    return Err("Git ignore data exceeds size limit".into());
                }
            } else {
                safe_ignore = false;
            }
        }
        self.walk_entries(dir, prefix, depth, safe_ignore, names)?;
        let after = dir
            .metadata()
            .map_err(|e| format!("Cannot recheck snapshot directory: {e}"))?;
        if list_xattrs(dir)? != directory_xattrs {
            return Err("Directory extended attributes changed while creating snapshot".into());
        }
        if !unchanged(&before, &after) {
            return Err("Directory changed while creating snapshot".into());
        }
        Ok(())
    }

    fn walk_entries(
        &mut self,
        dir: &File,
        prefix: &str,
        depth: usize,
        safe_ignore: bool,
        names: Vec<String>,
    ) -> Result<(), String> {
        for name in names {
            self.visited += 1;
            if self.visited > MAX_ENTRIES {
                return Err("Snapshot entry limit exceeded".into());
            }
            if prefix.is_empty()
                && self.metadata
                && matches!(name.as_str(), "HEAD" | "gitdir" | "commondir")
            {
                continue;
            }
            if prefix.is_empty() && !self.metadata && name == ".git" {
                continue;
            }
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            valid_path(&path)?;
            if self.metadata && forbidden_metadata(&path) {
                return Err(
                    "An interrupted or unsupported Git operation prevents snapshotting".into(),
                );
            }
            let stat = stat_at(dir, &name)?;
            match stat.st_mode & libc::S_IFMT {
                libc::S_IFDIR => {
                    self.walk_directory(dir, &name, &path, &stat, depth, safe_ignore)?;
                }
                libc::S_IFREG => {
                    let (digest, size, mode, owner, xattrs) =
                        store_file(dir, &name, &stat, self.blobs)
                            .map_err(|error| format!("Cannot save {path}: {error}"))?;
                    self.add(
                        Entry {
                            path,
                            mode,
                            security: None,
                            owner: Some(owner),
                            xattrs,
                            kind: Kind::File { digest, size },
                        },
                        size,
                    )?;
                }
                libc::S_IFLNK => {
                    if stat.st_nlink > 1 {
                        return Err("Hard-linked symbolic links cannot be preserved safely".into());
                    }
                    let xattrs = check_link_attributes(dir, &name, &stat)
                        .map_err(|error| format!("Cannot save {path}: {error}"))?;
                    let target = read_link(dir, &name)?;
                    let after = stat_at(dir, &name)?;
                    if stat.st_dev != after.st_dev
                        || stat.st_ino != after.st_ino
                        || stat.st_mtime != after.st_mtime
                        || stat.st_ctime != after.st_ctime
                    {
                        return Err("Symbolic link changed while creating snapshot".into());
                    }
                    let size = target.len() as u64;
                    self.add(
                        Entry {
                            path,
                            mode: 0,
                            security: None,
                            owner: Some(Owner {
                                uid: stat.st_uid,
                                gid: stat.st_gid,
                            }),
                            xattrs,
                            kind: Kind::Symlink { target },
                        },
                        size,
                    )?;
                }
                _ => return Err("Special filesystem entries cannot be saved safely".into()),
            }
        }
        Ok(())
    }

    fn walk_directory(
        &mut self,
        dir: &File,
        name: &str,
        path: &str,
        stat: &libc::stat,
        depth: usize,
        safe_ignore: bool,
    ) -> Result<(), String> {
        if let Some(index) = cache_index(name).filter(|_| !self.metadata && safe_ignore) {
            let indexed = self.indexed[index];
            let excluded = if indexed {
                false
            } else if let Some(ignored) = &mut self.ignored {
                ignored
                    .at_path(path, Some(gix::index::entry::Mode::DIR))
                    .map_err(|e| format!("Cannot evaluate Git ignore rules: {e}"))?
                    .is_excluded()
            } else {
                false
            };
            if excluded {
                let child = open_at(dir, name, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
                let meta = child
                    .metadata()
                    .map_err(|e| format!("Cannot inspect cache directory: {e}"))?;
                if !same_file(stat, &meta) {
                    return Err("Cache directory changed during snapshot".into());
                }
                self.probe_cache(&child, path, depth + 1)?;
                if !same_file(&stat_at(dir, name)?, &meta) {
                    return Err("Cache directory changed during snapshot".into());
                }
                return Ok(());
            }
        }
        let child = open_at(dir, name, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
        let meta = child
            .metadata()
            .map_err(|e| format!("Cannot inspect snapshot directory: {e}"))?;
        if !same_file(stat, &meta) {
            return Err("Directory changed while creating snapshot".into());
        }
        self.add(
            Entry {
                path: path.to_owned(),
                mode: meta.mode() & 0o7777,
                security: None,
                owner: Some(Owner {
                    uid: meta.uid(),
                    gid: meta.gid(),
                }),
                xattrs: list_xattrs(&child).map_err(|error| {
                    format!("Cannot inspect extended attributes for {path}: {error}")
                })?,
                kind: Kind::Directory,
            },
            0,
        )?;
        self.walk(&child, path, depth + 1, safe_ignore)?;
        if !same_file(&stat_at(dir, name)?, &meta) {
            return Err("Directory changed while creating snapshot".into());
        }
        Ok(())
    }
}

fn gather(
    root: &Path,
    repo: Option<&gix::Repository>,
    snapshot: Option<&Path>,
) -> Result<Manifest, String> {
    let root_dir = open_root(root)?;
    let blobs = snapshot.map(|path| blob_dir(path, true)).transpose()?;
    let mut indexed = [false; 4];
    let ignored = if let Some(repo) = repo {
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
        Some(
            repo.excludes(
                &index,
                None,
                gix::worktree::stack::state::ignore::Source::WorktreeThenIdMappingIfNotSkipped,
            )
            .map_err(|e| format!("Cannot read Git ignore rules: {e}"))?,
        )
    } else {
        None
    };
    let excluded_caches = if repo.is_some() {
        ["node_modules", "target", ".next", ".turbo"]
            .into_iter()
            .map(str::to_owned)
            .collect()
    } else {
        Vec::new()
    };
    let root_meta = root_dir
        .metadata()
        .map_err(|e| format!("Cannot inspect snapshot root: {e}"))?;
    let root_mode = root_meta.mode() & 0o7777;
    let root_owner = Some(Owner {
        uid: root_meta.uid(),
        gid: root_meta.gid(),
    });
    let root_xattrs = list_xattrs(&root_dir)
        .map_err(|error| format!("Cannot inspect extended attributes for root: {error}"))?;
    let mut xattr_bytes = 0;
    super::validate_xattrs(&root_xattrs, &mut xattr_bytes)?;
    let mut walker = Walker {
        manifest: Manifest {
            entries: Vec::new(),
            bytes: 0,
            root_mode,
            root_security: None,
            root_owner,
            root_xattrs,
            excluded_caches,
        },
        blobs: blobs.as_deref(),
        ignored,
        indexed,
        metadata: repo.is_none(),
        visited: 0,
        ignore_bytes: 0,
        xattr_bytes,
    };
    walker.walk(&root_dir, "", 0, true)?;
    walker
        .manifest
        .entries
        .sort_unstable_by(|a, b| a.path.cmp(&b.path));
    valid_manifest(&walker.manifest)?;
    Ok(walker.manifest)
}

pub(in super::super) fn capture(
    root: &Path,
    repo: &gix::Repository,
    snapshot: &Path,
) -> Result<Manifest, String> {
    gather(root, Some(repo), Some(snapshot))
}
pub(in super::super) fn scan(root: &Path, repo: &gix::Repository) -> Result<Manifest, String> {
    gather(root, Some(repo), None)
}
pub(in super::super) fn capture_metadata(root: &Path, snapshot: &Path) -> Result<Manifest, String> {
    gather(root, None, Some(snapshot))
}
pub(in super::super) fn scan_metadata(root: &Path) -> Result<Manifest, String> {
    gather(root, None, None)
}

fn preflight_ownership(snapshot: &Path, manifest: &Manifest) -> Result<(), String> {
    let mut combinations = std::collections::BTreeMap::new();
    combinations.insert(
        (
            manifest.root_owner.ok_or("Snapshot ownership is missing")?,
            1u8,
            manifest.root_mode,
            manifest.root_xattrs.as_slice(),
        ),
        ".",
    );
    for entry in &manifest.entries {
        let kind = match entry.kind {
            Kind::File { .. } => 0,
            Kind::Directory => 1,
            Kind::Symlink { .. } => 2,
        };
        combinations
            .entry((
                entry.owner.ok_or("Snapshot ownership is missing")?,
                kind,
                entry.mode,
                entry.xattrs.as_slice(),
            ))
            .or_insert(&entry.path);
    }
    if combinations.len() > 4096 {
        return Err("Too many distinct ownership and mode combinations".into());
    }
    let snapshot_dir = open_root(snapshot)?;
    let name = random_name()?;
    mkdir(&snapshot_dir, &name)?;
    let scratch = open_at(&snapshot_dir, &name, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
    let result = (|| {
        #[cfg(target_os = "macos")]
        check_private_handle(&scratch)?;
        for (index, ((owner, kind, mode, attrs), path)) in combinations.into_iter().enumerate() {
            probe_ownership(&scratch, index, (owner, kind, mode, attrs), path)?;
        }
        Ok(())
    })();
    let cname = cstring(name.as_bytes())?;
    // SAFETY: this removes only the exclusively created empty scratch directory.
    if unsafe { libc::unlinkat(snapshot_dir.as_raw_fd(), cname.as_ptr(), libc::AT_REMOVEDIR) } != 0
    {
        return Err(format!(
            "Cannot remove ownership probe directory: {}",
            std::io::Error::last_os_error()
        ));
    }
    result
}

fn probe_ownership(
    scratch: &File,
    index: usize,
    (owner, kind, mode, attrs): (Owner, u8, u32, &[Xattr]),
    path: &str,
) -> Result<(), String> {
    let name = format!("{index:x}");
    let cname = cstring(name.as_bytes())?;
    let outcome = match kind {
        0 => {
            let file = open_at(
                scratch,
                &name,
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
                0o600,
            )?;
            set_owner(&file, owner)
                .and_then(|()| restore_xattrs(&file, attrs))
                .and_then(|()| set_mode(&file, mode))
                .and_then(|()| {
                    if list_xattrs(&file)? == attrs {
                        Ok(())
                    } else {
                        Err("Extended attributes changed after setting mode".into())
                    }
                })
        }
        1 => {
            mkdir(scratch, &name)?;
            let file = open_at(scratch, &name, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
            set_owner(&file, owner)
                .and_then(|()| restore_xattrs(&file, attrs))
                .and_then(|()| set_mode(&file, mode))
                .and_then(|()| {
                    if list_xattrs(&file)? == attrs {
                        Ok(())
                    } else {
                        Err("Extended attributes changed after setting mode".into())
                    }
                })
        }
        _ => {
            let target = cstring(b"missing")?;
            // SAFETY: both names are terminated and the new link is not followed.
            if unsafe { libc::symlinkat(target.as_ptr(), scratch.as_raw_fd(), cname.as_ptr()) } != 0
            {
                return Err(format!(
                    "Cannot create ownership probe: {}",
                    std::io::Error::last_os_error()
                ));
            }
            set_link_owner(scratch, &name, owner).and_then(|()| {
                #[cfg(target_os = "macos")]
                {
                    restore_xattrs(&open_link(scratch, &name)?, attrs)
                }
                #[cfg(not(target_os = "macos"))]
                {
                    if attrs.is_empty() {
                        Ok(())
                    } else {
                        Err("Symbolic link extended attributes are unsupported".into())
                    }
                }
            })
        }
    };
    // SAFETY: this unlinks only the exclusively created empty probe entry.
    if unsafe {
        libc::unlinkat(
            scratch.as_raw_fd(),
            cname.as_ptr(),
            if kind == 1 { libc::AT_REMOVEDIR } else { 0 },
        )
    } != 0
    {
        return Err(format!(
            "Cannot remove ownership probe: {}",
            std::io::Error::last_os_error()
        ));
    }
    outcome.map_err(|error| {
        format!("Cannot reproduce ownership, mode or extended attributes for {path}: {error}")
    })
}

fn set_mode(file: &File, mode: u32) -> Result<(), String> {
    file.set_permissions(fs::Permissions::from_mode(mode))
        .map_err(|e| format!("Cannot set restored mode: {e}"))?;
    let actual = file
        .metadata()
        .map_err(|e| format!("Cannot inspect restored mode: {e}"))?;
    if actual.mode() & 0o7777 != mode {
        return Err("Restored mode did not match".into());
    }
    Ok(())
}

pub(in super::super) fn verify(snapshot: &Path, manifest: &Manifest) -> Result<(), String> {
    valid_manifest(manifest)?;
    let blobs = blob_dir(snapshot, false)?;
    let mut seen = BTreeSet::new();
    for entry in &manifest.entries {
        if let Kind::File { digest, size } = &entry.kind {
            if seen.insert((digest.as_str(), *size)) {
                check_blob(&blobs, digest, *size)?;
            }
        }
    }
    preflight_ownership(snapshot, manifest)
}

fn mkdir(dir: &File, name: &str) -> Result<(), String> {
    let name = cstring(name.as_bytes())?;
    // SAFETY: name is NUL terminated and dir is a live directory handle.
    if unsafe { libc::mkdirat(dir.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
        return Err(format!(
            "Cannot create snapshot directory without collision: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

fn parent_dir(root: &File, path: &str) -> Result<(File, String), String> {
    let mut parts = path.split('/').peekable();
    let mut dir = open_at(root, ".", libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            return Ok((dir, part.to_owned()));
        }
        dir = open_at(&dir, part, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
    }
    Err("Invalid snapshot path".into())
}

fn remove_generated(dir: &File, name: &str, index: bool) -> Result<(), String> {
    let mut file = open_at(dir, name, libc::O_RDONLY | libc::O_NONBLOCK, 0)?;
    let meta = file
        .metadata()
        .map_err(|e| format!("Cannot inspect generated Git metadata: {e}"))?;
    if !meta.is_file() {
        return Err("Generated Git metadata is not a regular file".into());
    }
    if index {
        let mut header = [0u8; 12];
        file.read_exact(&mut header)
            .map_err(|_| "Generated Git index is invalid")?;
        if &header[..4] != b"DIRC" || header[8..12] != [0, 0, 0, 0] {
            return Err("Generated Git index is not empty".into());
        }
    }
    let stat = stat_at(dir, name)?;
    if !same_file(&stat, &meta) {
        return Err("Generated Git metadata changed during restore".into());
    }
    let name = cstring(name.as_bytes())?;
    // SAFETY: name is NUL terminated and unlinkat never follows its final component.
    if unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) } != 0 {
        return Err(format!(
            "Cannot replace generated Git metadata: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

fn restore_inner(
    root: &Path,
    snapshot: &Path,
    manifest: &Manifest,
    metadata: bool,
) -> Result<(), String> {
    verify(snapshot, manifest)?;
    let root_dir = open_root(root)?;
    let existing = names(&root_dir)?;
    if !metadata && existing.iter().any(|name| name != ".git") {
        return Err("Restore destination is not empty".into());
    }
    if metadata && !manifest.excluded_caches.is_empty() {
        return Err("Git metadata cannot have cache exclusions".into());
    }
    if metadata {
        prepare_metadata_restore(&root_dir, manifest, &existing)?;
    }
    let blobs = open_root(&blob_dir(snapshot, false)?)?;
    for entry in &manifest.entries {
        let (parent, name) = parent_dir(&root_dir, &entry.path)?;
        match &entry.kind {
            Kind::Directory => {
                if metadata
                    && matches!(entry.path.as_str(), "logs" | "refs")
                    && existing.iter().any(|item| item == &entry.path)
                {
                    let _ = open_at(&parent, &name, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
                } else {
                    mkdir(&parent, &name)?;
                }
            }
            Kind::File { digest, size } => {
                if metadata
                    && (entry.path == "index" || entry.path == "logs/HEAD")
                    && stat_at(&parent, &name).is_ok()
                {
                    remove_generated(&parent, &name, entry.path == "index")?;
                }
                let mut source = open_at(&blobs, digest, libc::O_RDONLY | libc::O_NONBLOCK, 0)?;
                let mut output = open_at(
                    &parent,
                    &name,
                    libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
                    0o600,
                )?;
                let (actual, copied) = hash_reader(&mut source, Some(&mut output))?;
                if actual != *digest || copied != *size {
                    return Err("Snapshot blob changed during restore".into());
                }
                set_owner(&output, entry.owner.ok_or("Snapshot ownership is missing")?)?;
                restore_xattrs(&output, &entry.xattrs).map_err(|error| {
                    format!(
                        "Cannot restore extended attributes for {}: {error}",
                        entry.path
                    )
                })?;
                set_mode(&output, entry.mode)?;
                if list_xattrs(&output)? != entry.xattrs {
                    return Err(format!(
                        "Extended attributes changed after setting mode for {}",
                        entry.path
                    ));
                }
                output
                    .sync_all()
                    .map_err(|e| format!("Cannot sync restored file: {e}"))?;
            }
            Kind::Symlink { target } => {
                let link_name = cstring(name.as_bytes())?;
                let target = cstring(target.as_bytes())?;
                // SAFETY: both strings are NUL terminated; symlinkat creates a new entry without following the target.
                if unsafe {
                    libc::symlinkat(target.as_ptr(), parent.as_raw_fd(), link_name.as_ptr())
                } != 0
                {
                    return Err(format!(
                        "Cannot restore symbolic link without collision: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                set_link_owner(
                    &parent,
                    &name,
                    entry.owner.ok_or("Snapshot ownership is missing")?,
                )?;
                #[cfg(target_os = "macos")]
                restore_xattrs(&open_link(&parent, &name)?, &entry.xattrs).map_err(|error| {
                    format!(
                        "Cannot restore extended attributes for {}: {error}",
                        entry.path
                    )
                })?;
            }
        }
    }
    finalize_directories(&root_dir, manifest)
}

fn prepare_metadata_restore(
    root_dir: &File,
    manifest: &Manifest,
    existing: &[String],
) -> Result<(), String> {
    for entry in &manifest.entries {
        if matches!(entry.path.as_str(), "HEAD" | "gitdir" | "commondir")
            || forbidden_metadata(&entry.path)
        {
            return Err("Snapshot contains structural or interrupted Git metadata".into());
        }
    }
    if existing.iter().any(|name| name == "index")
        && !manifest.entries.iter().any(|entry| entry.path == "index")
    {
        remove_generated(root_dir, "index", true)?;
    }
    if existing.iter().any(|name| name == "logs") {
        let logs = open_at(root_dir, "logs", libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
        if names(&logs)?.iter().any(|name| name == "HEAD")
            && !manifest
                .entries
                .iter()
                .any(|entry| entry.path == "logs/HEAD")
        {
            remove_generated(&logs, "HEAD", false)?;
        }
        if !manifest.entries.iter().any(|entry| entry.path == "logs") {
            if !names(&logs)?.is_empty() {
                return Err("Unexpected generated Git logs would be lost".into());
            }
            let name = cstring(b"logs")?;
            // SAFETY: this removes only the verified empty generated logs directory.
            if unsafe { libc::unlinkat(root_dir.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) }
                != 0
            {
                return Err(format!(
                    "Cannot remove empty generated Git logs: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
    }
    Ok(())
}

fn finalize_directories(root_dir: &File, manifest: &Manifest) -> Result<(), String> {
    for entry in manifest.entries.iter().rev() {
        if matches!(entry.kind, Kind::Directory) {
            let (parent, name) = parent_dir(root_dir, &entry.path)?;
            let dir = open_at(&parent, &name, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
            set_owner(&dir, entry.owner.ok_or("Snapshot ownership is missing")?)?;
            restore_xattrs(&dir, &entry.xattrs).map_err(|error| {
                format!(
                    "Cannot restore extended attributes for {}: {error}",
                    entry.path
                )
            })?;
            set_mode(&dir, entry.mode)?;
            if list_xattrs(&dir)? != entry.xattrs {
                return Err(format!(
                    "Extended attributes changed after setting mode for {}",
                    entry.path
                ));
            }
            dir.sync_all()
                .map_err(|e| format!("Cannot sync restored directory: {e}"))?;
        }
    }
    set_owner(
        root_dir,
        manifest.root_owner.ok_or("Snapshot ownership is missing")?,
    )?;
    restore_xattrs(root_dir, &manifest.root_xattrs)
        .map_err(|error| format!("Cannot restore extended attributes for root: {error}"))?;
    set_mode(root_dir, manifest.root_mode)?;
    if list_xattrs(root_dir)? != manifest.root_xattrs {
        return Err("Root extended attributes changed after setting mode".into());
    }
    root_dir
        .sync_all()
        .map_err(|e| format!("Cannot sync restore root: {e}"))?;
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
