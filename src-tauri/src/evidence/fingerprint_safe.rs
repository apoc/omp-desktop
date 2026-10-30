//! Handle-relative reads prevent a changed directory or final symlink escaping
//! the worktree while source bytes are being fingerprinted.
use std::path::Path;

#[cfg(unix)]
pub(super) fn read(root: &Path, path: &str) -> Result<Option<(Vec<u8>, bool)>, String> {
    use std::ffi::CString;
    use std::fs::{File, OpenOptions};
    use std::io::Read;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    let mut parent = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root)
        .map_err(|error| format!("Cannot open worktree root safely: {error}"))?;
    let mut components = path.split('/').peekable();
    while let Some(component) = components.next() {
        let name = CString::new(component).map_err(|_| "Invalid Git path".to_string())?;
        let last = components.peek().is_none();
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | libc::O_CLOEXEC
            | if last { 0 } else { libc::O_DIRECTORY };
        // SAFETY: parent is an open directory, name is NUL-terminated, and
        // each returned descriptor is immediately owned by File. NOFOLLOW
        // applies independently to every component, including the final one.
        let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::NotFound {
                return Ok(None);
            }
            return Err(format!(
                "Cannot safely read worktree path (possible symlink or concurrent change): {error}"
            ));
        }
        // SAFETY: openat returned a new, valid descriptor owned by this scope.
        let mut file = unsafe { File::from_raw_fd(fd) };
        if !last {
            parent = file;
            continue;
        }
        let before = file
            .metadata()
            .map_err(|error| format!("Cannot stat worktree file: {error}"))?;
        if before.is_dir() {
            return Ok(None);
        }
        if !before.is_file() {
            return Err("Unsupported non-regular worktree entry".into());
        }
        if before.len() > super::scan::MAX_FILE {
            return Err("Worktree file exceeds fingerprint size limit".into());
        }
        let capacity = usize::try_from(before.len())
            .map_err(|_| "Worktree file exceeds fingerprint size limit".to_string())?;
        let mut bytes = Vec::with_capacity(capacity);
        (&mut file)
            .take(super::scan::MAX_FILE + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("Cannot read worktree file: {error}"))?;
        let after = file
            .metadata()
            .map_err(|error| format!("Cannot recheck worktree file: {error}"))?;
        if bytes.len() as u64 > super::scan::MAX_FILE {
            return Err("Worktree file exceeds fingerprint size limit".into());
        }
        if before.dev() != after.dev()
            || before.ino() != after.ino()
            || before.len() != after.len()
            || before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec()
            || before.ctime() != after.ctime()
            || before.ctime_nsec() != after.ctime_nsec()
            || before.mode() != after.mode()
            || bytes.len() as u64 != after.len()
        {
            return Err("Worktree file changed during fingerprint collection".into());
        }
        return Ok(Some((bytes, before.mode() & 0o111 != 0)));
    }
    Err("Empty Git path".into())
}

#[cfg(not(any(unix, windows)))]
pub(super) fn read(_root: &Path, _path: &str) -> Result<Option<(Vec<u8>, bool)>, String> {
    Err("Safe handle-relative worktree reads are unavailable on this platform".into())
}

#[cfg(windows)]
pub(super) fn read(root: &Path, path: &str) -> Result<Option<(Vec<u8>, bool)>, String> {
    use std::ffi::c_void;
    use std::fs::{File, OpenOptions};
    use std::io::Read;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use std::ptr;

    // NT's RootDirectory allows every path component to be opened relative to
    // an already-open directory, without traversing reparse points.
    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *mut u16,
    }
    #[repr(C)]
    struct ObjectAttributes {
        length: u32,
        root: *mut c_void,
        name: *mut UnicodeString,
        attributes: u32,
        security_descriptor: *mut c_void,
        security_quality: *mut c_void,
    }
    #[repr(C)]
    struct IoStatus {
        status: usize,
        information: usize,
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn NtCreateFile(
            handle: *mut *mut c_void,
            access: u32,
            attributes: *mut ObjectAttributes,
            status: *mut IoStatus,
            allocation_size: *const i64,
            file_attributes: u32,
            sharing: u32,
            disposition: u32,
            options: u32,
            ea: *const c_void,
            ea_len: u32,
        ) -> i32;
        fn RtlNtStatusToDosError(status: i32) -> u32;
    }
    const REPARSE: u32 = 0x400;
    const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const READ_DATA_AND_ATTRIBUTES: u32 = 0x81;
    const SYNCHRONOUS_NONALERT: u32 = 0x20;
    const DIRECTORY_FILE: u32 = 0x1;
    const FILE_OPEN: u32 = 1;
    const OBJ_CASE_INSENSITIVE: u32 = 0x40;
    const OBJ_DONT_REPARSE: u32 = 0x1000;

    let mut parent = OpenOptions::new()
        .read(true)
        .custom_flags(BACKUP_SEMANTICS | OPEN_REPARSE_POINT)
        .open(root)
        .map_err(|error| format!("Cannot open worktree root safely: {error}"))?;
    let metadata = parent
        .metadata()
        .map_err(|error| format!("Cannot stat worktree root: {error}"))?;
    if !metadata.is_dir() || metadata.file_attributes() & REPARSE != 0 {
        return Err("Worktree root is a reparse point or not a directory".into());
    }
    let mut components = path.split('/').peekable();
    while let Some(component) = components.next() {
        let last = components.peek().is_none();
        let mut name: Vec<u16> = component.encode_utf16().collect();
        let name_bytes = u16::try_from(name.len() * 2)
            .map_err(|_| "Worktree path component is too long".to_string())?;
        let mut unicode = UnicodeString {
            length: name_bytes,
            maximum_length: name_bytes,
            buffer: name.as_mut_ptr(),
        };
        let mut attributes = ObjectAttributes {
            length: std::mem::size_of::<ObjectAttributes>() as u32,
            root: parent.as_raw_handle(),
            name: &mut unicode,
            attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
            security_descriptor: ptr::null_mut(),
            security_quality: ptr::null_mut(),
        };
        let mut io = IoStatus {
            status: 0,
            information: 0,
        };
        let mut handle = ptr::null_mut();
        let options =
            OPEN_REPARSE_POINT | SYNCHRONOUS_NONALERT | if last { 0 } else { DIRECTORY_FILE };
        // SAFETY: all structures and the UTF-16 buffer remain live for the
        // synchronous call; the parent handle is valid, and successful output
        // is transferred exactly once to File.
        let status = unsafe {
            NtCreateFile(
                &mut handle,
                SYNCHRONIZE | READ_DATA_AND_ATTRIBUTES,
                &mut attributes,
                &mut io,
                ptr::null(),
                0,
                7,
                FILE_OPEN,
                options,
                ptr::null(),
                0,
            )
        };
        if status < 0 {
            // SAFETY: translating an NTSTATUS has no side effects.
            let code = unsafe { RtlNtStatusToDosError(status) };
            let error = std::io::Error::from_raw_os_error(code as i32);
            if error.kind() == std::io::ErrorKind::NotFound {
                return Ok(None);
            }
            return Err(format!("Cannot safely read worktree path (possible reparse point or concurrent change): {error}"));
        }
        // SAFETY: NtCreateFile returned a newly owned, valid handle.
        let mut file = unsafe { File::from_raw_handle(handle) };
        let before = file
            .metadata()
            .map_err(|error| format!("Cannot stat worktree path: {error}"))?;
        if before.file_attributes() & REPARSE != 0 {
            return Err("Worktree reparse points are not followed".into());
        }
        if !last {
            if !before.is_dir() {
                return Err("Worktree parent is not a directory".into());
            }
            parent = file;
            continue;
        }
        if before.is_dir() {
            return Ok(None);
        }
        if !before.is_file() {
            return Err("Unsupported non-regular worktree entry".into());
        }
        if before.file_size() > super::scan::MAX_FILE {
            return Err("Worktree file exceeds fingerprint size limit".into());
        }
        let capacity = usize::try_from(before.file_size())
            .map_err(|_| "Worktree file exceeds fingerprint size limit".to_string())?;
        let mut bytes = Vec::with_capacity(capacity);
        (&mut file)
            .take(super::scan::MAX_FILE + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("Cannot read worktree file: {error}"))?;
        let after = file
            .metadata()
            .map_err(|error| format!("Cannot recheck worktree file: {error}"))?;
        if bytes.len() as u64 > super::scan::MAX_FILE {
            return Err("Worktree file exceeds fingerprint size limit".into());
        }
        if before.file_size() != after.file_size()
            || before.last_write_time() != after.last_write_time()
            || before.creation_time() != after.creation_time()
            || before.file_attributes() != after.file_attributes()
            || bytes.len() as u64 != after.file_size()
        {
            return Err("Worktree file changed during fingerprint collection".into());
        }
        // Windows does not expose Git's executable bit via filesystem metadata.
        return Ok(Some((bytes, false)));
    }
    Err("Empty Git path".into())
}
