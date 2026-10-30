//! A run's inbox is pinned before its path is disclosed to the native agent.
//! File names are opened relative to that handle, never by concatenating paths.

use std::fs::{File, OpenOptions};
use std::path::Path;

use super::{formats, is_reparse, read_opened};

pub(in super::super) struct InboxHandle {
    directory: File,
}

impl InboxHandle {
    pub(in super::super) fn open(path: &Path) -> Result<Self, String> {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // BACKUP_SEMANTICS opens directories; OPEN_REPARSE_POINT refuses
            // to traverse a junction or symlink in the final component.
            options.custom_flags(0x0200_0000 | 0x0020_0000);
        }
        let directory = options
            .open(path)
            .map_err(|e| format!("cannot open evidence inbox: {e}"))?;
        let meta = directory
            .metadata()
            .map_err(|e| format!("cannot inspect evidence inbox: {e}"))?;
        if !meta.is_dir() || meta.file_type().is_symlink() || is_reparse(&meta) {
            return Err("evidence inbox is not a real directory".into());
        }
        Ok(Self { directory })
    }

    pub(super) fn read(&self, filename: &str) -> Result<Vec<u8>, String> {
        if filename.is_empty()
            || filename.len() > 255
            || filename == "."
            || filename == ".."
            || filename
                .chars()
                .any(|ch| ch.is_control() || matches!(ch, '/' | '\\' | ':'))
        {
            return Err("invalid evidence inbox filename".into());
        }
        let file = open_relative(&self.directory, filename)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let meta = file
                .metadata()
                .map_err(|e| format!("cannot inspect evidence inbox file: {e}"))?;
            if meta.nlink() != 1 {
                return Err("hard-linked evidence inbox files are not allowed".into());
            }
        }
        #[cfg(windows)]
        if link_count(&file)? != 1 {
            return Err("hard-linked evidence inbox files are not allowed".into());
        }
        read_opened(file, formats::VIDEO_LIMIT as u64)
    }
}

#[cfg(unix)]
fn open_relative(directory: &File, filename: &str) -> Result<File, String> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};

    let name = CString::new(filename).map_err(|_| "invalid evidence inbox filename")?;
    // SAFETY: the directory handle and NUL-terminated name remain live for
    // this call; successful descriptors are uniquely owned by the new File.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(format!(
            "cannot open evidence inbox file: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: openat returned a fresh, valid descriptor owned by this File.
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(windows)]
fn open_relative(directory: &File, filename: &str) -> Result<File, String> {
    use std::ffi::c_void;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use std::ptr;

    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *mut u16,
    }
    #[repr(C)]
    struct ObjectAttributes {
        length: u32,
        root_directory: *mut c_void,
        object_name: *mut UnicodeString,
        attributes: u32,
        security_descriptor: *mut c_void,
        security_quality_of_service: *mut c_void,
    }
    #[repr(C)]
    struct IoStatusBlock {
        status_or_pointer: usize,
        information: usize,
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn NtCreateFile(
            file_handle: *mut *mut c_void,
            desired_access: u32,
            object_attributes: *mut ObjectAttributes,
            io_status: *mut IoStatusBlock,
            allocation_size: *mut i64,
            file_attributes: u32,
            share_access: u32,
            create_disposition: u32,
            create_options: u32,
            ea_buffer: *mut c_void,
            ea_length: u32,
        ) -> i32;
        fn RtlNtStatusToDosError(status: i32) -> u32;
    }

    let mut name: Vec<u16> = filename.encode_utf16().collect();
    let byte_len = u16::try_from(name.len() * 2).map_err(|_| "invalid evidence inbox filename")?;
    let mut unicode = UnicodeString {
        length: byte_len,
        maximum_length: byte_len,
        buffer: name.as_mut_ptr(),
    };
    let mut attributes = ObjectAttributes {
        length: std::mem::size_of::<ObjectAttributes>() as u32,
        root_directory: directory.as_raw_handle(),
        object_name: &mut unicode,
        attributes: 0x40, // OBJ_CASE_INSENSITIVE
        security_descriptor: ptr::null_mut(),
        security_quality_of_service: ptr::null_mut(),
    };
    let mut handle = ptr::null_mut();
    let mut status_block = IoStatusBlock {
        status_or_pointer: 0,
        information: 0,
    };
    // SAFETY: attributes reference a live directory handle and bounded UTF-16
    // name for the duration of this synchronous call. The non-directory,
    // reparse-point-open flags ensure the resulting handle can be inspected
    // without traversing the final component; read_opened rejects reparse
    // points. FILE_OPEN never creates anything.
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            0x0010_0081,
            &mut attributes,
            &mut status_block,
            ptr::null_mut(),
            0,
            0x7,
            1,
            0x0020_0060,
            ptr::null_mut(),
            0,
        )
    };
    if status < 0 {
        // SAFETY: RtlNtStatusToDosError is a pure conversion of this status.
        let error = unsafe { RtlNtStatusToDosError(status) };
        return Err(format!(
            "cannot open evidence inbox file: {}",
            std::io::Error::from_raw_os_error(error as i32)
        ));
    }
    // SAFETY: successful NtCreateFile returns a new, owned file handle.
    Ok(unsafe { File::from_raw_handle(handle) })
}

#[cfg(windows)]
fn link_count(file: &File) -> Result<u32, String> {
    use std::ffi::c_void;
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle;

    #[repr(C)]
    struct FileInformation {
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
    extern "system" {
        fn GetFileInformationByHandle(
            handle: *mut c_void,
            information: *mut FileInformation,
        ) -> i32;
    }
    let mut information = MaybeUninit::<FileInformation>::uninit();
    // SAFETY: the live file handle and writable, correctly sized output buffer
    // meet the Windows API contract; the buffer is read only after success.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) } == 0 {
        return Err(format!(
            "cannot inspect evidence inbox file: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: a successful call initialized all fields in the output buffer.
    Ok(unsafe { information.assume_init() }.links)
}
