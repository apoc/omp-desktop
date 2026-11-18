//! The Win32 half of [`super`]: creates, validates and secures the stable
//! persona directories and the executable.

use super::{check_entry, private_sddl, EntryIssue, EntryKind};
use crate::persona_pipe_security::{current_user_sid, same_sid};
use std::ffi::c_void;
use std::io;
use std::os::windows::fs::MetadataExt;
use std::os::windows::io::FromRawHandle;
use std::path::Path;
use std::ptr;
use windows_sys::Win32::Foundation::{LocalFree, WIN32_ERROR};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
    ConvertStringSidToSidW, GetNamedSecurityInfoW, SetNamedSecurityInfoW, SDDL_REVISION_1,
    SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    EqualSid, GetAce, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
    GetSecurityDescriptorOwner, ACL, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES,
    SE_DACL_PROTECTED,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateDirectoryW, CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_GENERIC_WRITE,
};

/// `ACCESS_ALLOWED_ACE_TYPE` (WinNT.h): an allow ACE.
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

/// Offset of an allow ACE's SID inside `ACCESS_ALLOWED_ACE` (header, mask,
/// then the first `u32` of the SID).
const ACE_SID_OFFSET: usize = 8;

/// Whether `path` is a reparse point, without following it.
///
/// # Errors
///
/// Returns the inspection error, which includes a missing path.
pub fn is_reparse_point(path: &Path) -> io::Result<bool> {
    let metadata = std::fs::symlink_metadata(path)?;
    Ok(reparse(&metadata))
}

/// Whether the owner of `path` is the current user.
///
/// # Errors
///
/// Returns the failing Win32 call, or the SID error.
pub fn owner_is_current_user(path: &Path) -> io::Result<bool> {
    let owner = named_owner_sid(path)?;
    Ok(same_sid(&owner, &current_user_sid()?))
}

/// Whether `path` carries exactly the protected DACL [`private_sddl`]
/// describes: protected from inheritance and one allow entry for the current
/// user.
///
/// # Errors
///
/// Returns the failing Win32 call, or the SID error.
pub fn has_private_dacl(path: &Path) -> io::Result<bool> {
    let sid = string_sid(&current_user_sid()?)?;
    let result = dacl_is_private(path, sid);
    // SAFETY: `sid` came from `ConvertStringSidToSidW` and is owned here; it
    // is freed exactly once, after the read finished.
    unsafe {
        LocalFree(sid);
    }
    result
}

/// Creates `dir` with the protected DACL, or secures an existing one.
///
/// A reparse point, the wrong kind, or another account's directory is an
/// error rather than something to replace: the path is then not evidence of
/// what it points at.
///
/// # Errors
///
/// Returns the failed inspection, creation or `SetNamedSecurityInfoW` call.
pub fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(dir) {
        Ok(_) => ensure_entry(dir, EntryKind::Directory),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            create_dir_with_dacl(dir)?;
            ensure_entry(dir, EntryKind::Directory)
        }
        Err(error) => Err(error),
    }
}

/// Secures an existing executable: a reparse point, a non-file, another
/// account's file, or a DACL that cannot be applied is an error.
///
/// # Errors
///
/// See [`ensure_private_dir`].
pub fn ensure_private_file(path: &Path) -> io::Result<()> {
    ensure_entry(path, EntryKind::File)
}

/// A new file that belongs only to this user from its first byte.
///
/// # Errors
///
/// Returns the SDDL or `CreateFileW` error; an existing path is refused
/// (`CREATE_NEW`).
pub fn create_private_file(path: &Path) -> io::Result<std::fs::File> {
    let attributes = security_attributes(&private_sddl(&current_user_sid()?))?;
    let wide = wide(path)?;
    // SAFETY: `wide` is NUL-terminated, `attributes` owns a live security
    // descriptor, and the returned handle is owned here (or invalid).
    let raw = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_GENERIC_WRITE,
            0,
            &attributes.0,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            ptr::null_mut(),
        )
    };
    if raw == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `CreateFileW` returned a valid handle that nothing else owns;
    // `File` closes it exactly once.
    Ok(unsafe { std::fs::File::from_raw_handle(raw) })
}

fn ensure_entry(path: &Path, expected: EntryKind) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    let actual = if metadata.is_dir() {
        EntryKind::Directory
    } else {
        EntryKind::File
    };
    let owner = named_owner_sid(path)?;
    let current = current_user_sid()?;
    if let Err(issue) = check_entry(expected, actual, reparse(&metadata), &owner, &current) {
        return Err(issue_error(path, issue));
    }
    apply_private_dacl(path, &current)
}

fn reparse(metadata: &std::fs::Metadata) -> bool {
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

fn issue_error(path: &Path, issue: EntryIssue) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, issue.message(path))
}

/// A security descriptor owned by its `SECURITY_ATTRIBUTES`, freed on drop.
struct OwnedAttributes(SECURITY_ATTRIBUTES);

impl Drop for OwnedAttributes {
    fn drop(&mut self) {
        // SAFETY: `ConvertStringSecurityDescriptorToSecurityDescriptorW`
        // allocated the descriptor with LocalAlloc and this is its only
        // owner.
        if !self.0.lpSecurityDescriptor.is_null() {
            unsafe {
                LocalFree(self.0.lpSecurityDescriptor);
            }
        }
    }
}

fn security_attributes(sddl: &str) -> io::Result<OwnedAttributes> {
    let wide = wide_str(sddl)?;
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    // SAFETY: `wide` is NUL-terminated; on success `descriptor` receives an
    // allocation owned by the returned attributes.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let length = u32::try_from(std::mem::size_of::<SECURITY_ATTRIBUTES>()).unwrap_or(u32::MAX);
    Ok(OwnedAttributes(SECURITY_ATTRIBUTES {
        nLength: length,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    }))
}

fn create_dir_with_dacl(dir: &Path) -> io::Result<()> {
    let attributes = security_attributes(&private_sddl(&current_user_sid()?))?;
    let wide = wide(dir)?;
    // SAFETY: `wide` is NUL-terminated and `attributes` outlives the call.
    if unsafe { CreateDirectoryW(wide.as_ptr(), &attributes.0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn apply_private_dacl(path: &Path, sid: &str) -> io::Result<()> {
    let attributes = security_attributes(&private_sddl(sid))?;
    let mut dacl: *mut ACL = ptr::null_mut();
    let mut present = 0;
    let mut defaulted = 0;
    // SAFETY: the descriptor is live until `attributes` drops, and its DACL
    // lives inside that allocation.
    if unsafe {
        GetSecurityDescriptorDacl(
            attributes.0.lpSecurityDescriptor,
            &mut present,
            &mut dacl,
            &mut defaulted,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if present == 0 || dacl.is_null() {
        return Err(io::Error::other("the private SDDL carried no DACL"));
    }
    let wide = wide(path)?;
    // SAFETY: `wide` is NUL-terminated, `dacl` points into the live
    // descriptor, and owner, group and SACL are left alone (`null`).
    let status = unsafe {
        SetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            dacl,
            ptr::null_mut(),
        )
    };
    win32_result(status)
}

fn named_owner_sid(path: &Path) -> io::Result<String> {
    let wide = wide(path)?;
    with_named(&wide, OWNER_SECURITY_INFORMATION, |descriptor| {
        let mut sid: PSID = ptr::null_mut();
        let mut defaulted = 0;
        // SAFETY: the descriptor is live for this call; `sid` then points
        // into it.
        if unsafe { GetSecurityDescriptorOwner(descriptor, &mut sid, &mut defaulted) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if sid.is_null() {
            return Err(io::Error::other("the persona path has no owner SID"));
        }
        // SAFETY: `sid` points into the descriptor, which outlives this call.
        sid_to_string(sid)
    })
}

fn dacl_is_private(path: &Path, sid: PSID) -> io::Result<bool> {
    let wide = wide(path)?;
    with_named(&wide, DACL_SECURITY_INFORMATION, |descriptor| {
        let mut control = 0u16;
        let mut revision = 0u32;
        // SAFETY: the descriptor is live for this call.
        if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut dacl: *mut ACL = ptr::null_mut();
        let mut present = 0;
        let mut defaulted = 0;
        // SAFETY: as above; `dacl` points into the descriptor.
        if unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        if control & SE_DACL_PROTECTED == 0 || present == 0 || dacl.is_null() {
            return Ok(false);
        }
        // SAFETY: `dacl` points into the live descriptor.
        if unsafe { (*dacl).AceCount } != 1 {
            return Ok(false);
        }
        let mut ace: *mut c_void = ptr::null_mut();
        // SAFETY: index 0 exists (the count is 1); `ace` points into the
        // descriptor.
        if unsafe { GetAce(dacl, 0, &mut ace) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if ace.is_null() {
            return Ok(false);
        }
        // SAFETY: an ACE begins with its header, whose first byte is its
        // type; the ACE lives inside the descriptor.
        if unsafe { *ace.cast::<u8>() } != ACCESS_ALLOWED_ACE_TYPE {
            return Ok(false);
        }
        // SAFETY: an allow ACE's SID begins `ACE_SID_OFFSET` bytes in, and
        // `GetAce` validated the ACE's size against the ACL.
        let ace_sid = unsafe { ace.cast::<u8>().add(ACE_SID_OFFSET).cast::<c_void>() };
        // SAFETY: both SIDs are valid and live for this call.
        Ok(unsafe { EqualSid(ace_sid, sid) } != 0)
    })
}

/// Runs `read` on the security descriptor `info` asks for, and frees it
/// afterwards even when the read fails.
fn with_named<T>(
    wide: &widestring::U16CString,
    info: u32,
    read: impl FnOnce(PSECURITY_DESCRIPTOR) -> io::Result<T>,
) -> io::Result<T> {
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    // SAFETY: `wide` is NUL-terminated; the descriptor is allocated here and
    // owns every pointer the read reaches through.
    let status = unsafe {
        GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            info,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(win32_error(status));
    }
    let result = read(descriptor);
    // SAFETY: the descriptor is owned by this call and freed exactly once,
    // after `read` finished with it.
    unsafe {
        LocalFree(descriptor);
    }
    result
}

fn string_sid(text: &str) -> io::Result<PSID> {
    let wide = wide_str(text)?;
    let mut sid: PSID = ptr::null_mut();
    // SAFETY: `wide` is NUL-terminated; on success `sid` receives an
    // allocation the caller frees.
    if unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut sid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(sid)
}

/// The string form of a SID that points into a live descriptor.
fn sid_to_string(sid: PSID) -> io::Result<String> {
    let mut text: *mut u16 = ptr::null_mut();
    // SAFETY: the caller guarantees `sid` is valid; `text` receives an
    // allocation owned by this call.
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the string is NUL-terminated and owned by this call; it is
    // copied out before the allocation is freed.
    Ok(unsafe {
        let value = widestring::U16CStr::from_ptr_str(text).to_string_lossy();
        LocalFree(text.cast());
        value
    })
}

fn wide(path: &Path) -> io::Result<widestring::U16CString> {
    use std::os::windows::ffi::OsStrExt;
    let units: Vec<u16> = path.as_os_str().encode_wide().collect();
    widestring::U16CString::from_vec(units).map_err(|_| io::Error::other("path cannot be encoded"))
}

fn wide_str(text: &str) -> io::Result<widestring::U16CString> {
    widestring::U16CString::from_str(text)
        .map_err(|_| io::Error::other("security descriptor text cannot be encoded"))
}

fn win32_error(status: WIN32_ERROR) -> io::Error {
    io::Error::from_raw_os_error(status.cast_signed())
}

fn win32_result(status: WIN32_ERROR) -> io::Result<()> {
    if status == 0 {
        Ok(())
    } else {
        Err(win32_error(status))
    }
}

#[cfg(test)]
mod tests {
    use super::{ensure_private_dir, has_private_dacl, is_reparse_point, owner_is_current_user};
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omp-desktop-fs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_new_directory_is_private_and_owned() {
        let dir = temp_dir("new");
        ensure_private_dir(&dir).unwrap();
        assert!(!is_reparse_point(&dir).unwrap());
        assert!(owner_is_current_user(&dir).unwrap());
        assert!(has_private_dacl(&dir).unwrap());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_inherited_directory_gets_the_protected_dacl() {
        let dir = temp_dir("inherited");
        std::fs::create_dir(&dir).unwrap();
        // %TEMP%'s inherited ACEs are not the private DACL.
        assert!(!has_private_dacl(&dir).unwrap());
        ensure_private_dir(&dir).unwrap();
        assert!(has_private_dacl(&dir).unwrap());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
