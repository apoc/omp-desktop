//! Windows file owner, primary group, and DACL recovery.
//!
//! SACLs (including auditing and integrity labels), security-session state,
//! and other SACL-backed policy are outside the file-data snapshot contract.
//! They are deliberately not queried, so ordinary capture does not require
//! SeSecurityPrivilege. Unsupported or unrestorable DACLs fail closed.

use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr;

use windows_sys::Wdk::Storage::FileSystem::NtQueryEaFile;
use windows_sys::Win32::Foundation::{
    CloseHandle, LocalFree, ERROR_ALREADY_EXISTS, ERROR_INSUFFICIENT_BUFFER, HANDLE,
    INVALID_HANDLE_VALUE, STATUS_BUFFER_OVERFLOW, STATUS_BUFFER_TOO_SMALL, STATUS_NO_EAS_ON_FILE,
    STATUS_SUCCESS,
};
use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
use windows_sys::Win32::Security::{
    CreateWellKnownSid, GetFileSecurityW, GetSecurityDescriptorLength, GetTokenInformation,
    IsValidSecurityDescriptor, SetFileSecurityW, TokenUser, WinBuiltinAdministratorsSid,
    WinLocalSystemSid, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION,
    GROUP_SECURITY_INFORMATION, OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION,
    SECURITY_ATTRIBUTES, SE_DACL_PRESENT, SE_DACL_PROTECTED, SE_SACL_PRESENT, SE_SELF_RELATIVE,
    TOKEN_QUERY, TOKEN_USER, WELL_KNOWN_SID_TYPE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateDirectoryW, CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    FILE_ALL_ACCESS, FILE_ATTRIBUTE_DEVICE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_EA, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, READ_CONTROL,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

const INFORMATION: u32 =
    OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
const HEADER_SIZE: usize = 20;
const MAX_DESCRIPTOR_SIZE: usize = 1024 * 1024;

fn invalid() -> String {
    "Invalid or unsupported Windows security descriptor".into()
}

fn u16_at(bytes: &[u8], offset: usize) -> Result<u16, String> {
    let pair = bytes.get(offset..offset + 2).ok_or_else(invalid)?;
    Ok(u16::from_le_bytes([pair[0], pair[1]]))
}

fn u32_at(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let value = bytes.get(offset..offset + 4).ok_or_else(invalid)?;
    Ok(u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

// A SID has an eight-byte header and at most 15 four-byte subauthorities.
fn sid_end(bytes: &[u8], offset: usize) -> Result<usize, String> {
    let header = bytes.get(offset..offset + 8).ok_or_else(invalid)?;
    if header[0] != 1 || header[1] > 15 {
        return Err(invalid());
    }
    let end = offset + 8 + usize::from(header[1]) * 4;
    bytes.get(offset..end).ok_or_else(invalid)?;
    Ok(end)
}

#[derive(Clone, Copy)]
struct Acl<'a> {
    revision: u8,
    count: u16,
    // The ACE sequence excludes unused bytes in the ACL allocation.
    entries: &'a [u8],
}

impl PartialEq for Acl<'_> {
    fn eq(&self, other: &Self) -> bool {
        self.revision == other.revision
            && self.count == other.count
            && self.entries == other.entries
    }
}

struct Descriptor<'a> {
    owner: &'a [u8],
    group: &'a [u8],
    dacl: Option<Acl<'a>>,
    protected: bool,
}

fn component_offset(bytes: &[u8], field: usize) -> Result<usize, String> {
    let offset = usize::try_from(u32_at(bytes, field)?).map_err(|_| invalid())?;
    if offset < HEADER_SIZE || offset % 4 != 0 || offset >= bytes.len() {
        return Err(invalid());
    }
    Ok(offset)
}

fn overlaps(a: (usize, usize), b: (usize, usize)) -> bool {
    a.0 < b.1 && b.0 < a.1
}

fn acl_at(bytes: &[u8], offset: usize) -> Result<(Acl<'_>, usize), String> {
    let header = bytes.get(offset..offset + 8).ok_or_else(invalid)?;
    let revision = header[0];
    if revision != 2 && revision != 4 {
        return Err(invalid());
    }
    let size = usize::from(u16_at(header, 2)?);
    let count = u16_at(header, 4)?;
    if size < 8 || size % 4 != 0 {
        return Err(invalid());
    }
    let end = offset + size;
    let acl = bytes.get(offset..end).ok_or_else(invalid)?;
    let mut pos = 8;
    for _ in 0..count {
        let ace_header = acl.get(pos..pos + 4).ok_or_else(invalid)?;
        let ace_size = usize::from(u16_at(ace_header, 2)?);
        if ace_size < 4 || ace_size % 4 != 0 {
            return Err(invalid());
        }
        let ace = acl.get(pos..pos + ace_size).ok_or_else(invalid)?;
        // DACL access-allowed/denied ACEs and their object/callback variants.
        // Unknown layouts cannot safely be passed to the OS for restoration.
        let (sid_offset, callback) = match ace[0] {
            0 | 1 => (8, false),
            9 | 10 => (8, true),
            5 | 6 | 11 | 12 => {
                if revision != 4 {
                    return Err(invalid());
                }
                let flags = u32_at(ace, 8)?;
                if flags & !3 != 0 {
                    return Err(invalid());
                }
                (
                    12 + 16 * (flags & 1 != 0) as usize + 16 * (flags & 2 != 0) as usize,
                    ace[0] == 11 || ace[0] == 12,
                )
            }
            _ => return Err(invalid()),
        };
        let sid_end = sid_end(ace, sid_offset)?;
        if !callback && sid_end != ace.len() {
            return Err(invalid());
        }
        pos += ace_size;
    }
    Ok((
        Acl {
            revision,
            count,
            entries: &acl[8..pos],
        },
        end,
    ))
}

// Parse entirely within Rust slices before any Windows API can follow offsets.
fn parse(bytes: &[u8]) -> Result<Descriptor<'_>, String> {
    if bytes.len() < HEADER_SIZE
        || bytes.len() > MAX_DESCRIPTOR_SIZE
        || bytes.len() % 4 != 0
        || bytes[0] != 1
    {
        return Err(invalid());
    }
    let control = u16_at(bytes, 2)?;
    // A null DACL is representable, but an absent DACL cannot be reliably set
    // by SetFileSecurityW. SACLs are intentionally outside this format.
    if control & SE_SELF_RELATIVE == 0
        || control & SE_DACL_PRESENT == 0
        || control & SE_SACL_PRESENT != 0
        || u32_at(bytes, 12)? != 0
    {
        return Err(invalid());
    }
    let owner_start = component_offset(bytes, 4)?;
    let group_start = component_offset(bytes, 8)?;
    let owner_end = sid_end(bytes, owner_start)?;
    let group_end = sid_end(bytes, group_start)?;
    let owner_range = (owner_start, owner_end);
    let group_range = (group_start, group_end);
    if overlaps(owner_range, group_range) && owner_range != group_range {
        return Err(invalid());
    }
    let dacl = if u32_at(bytes, 16)? == 0 {
        None
    } else {
        let start = component_offset(bytes, 16)?;
        let (acl, end) = acl_at(bytes, start)?;
        if overlaps((start, end), owner_range) || overlaps((start, end), group_range) {
            return Err(invalid());
        }
        Some(acl)
    };
    Ok(Descriptor {
        owner: &bytes[owner_start..owner_end],
        group: &bytes[group_start..group_end],
        dacl,
        protected: control & SE_DACL_PROTECTED != 0,
    })
}

/// Validates untrusted snapshot data without allowing native code to dereference it.
pub(super) fn verify(descriptor: &[u8]) -> Result<(), String> {
    parse(descriptor).map(|_| ())
}
// Native serialization can vary in component order, padding and unrelated
// control bits. Store only the requested semantic state in a stable,
// self-relative descriptor, so a restored scan can be compared to its source.
fn canonical(descriptor: &Descriptor<'_>) -> Result<Vec<u8>, String> {
    let acl_size = descriptor.dacl.map_or(0, |acl| 8 + acl.entries.len());
    let total = HEADER_SIZE + descriptor.owner.len() + descriptor.group.len() + acl_size;
    let mut bytes = vec![0u8; HEADER_SIZE];
    bytes.reserve(total - HEADER_SIZE);
    bytes[0] = 1;
    let control = SE_SELF_RELATIVE
        | SE_DACL_PRESENT
        | if descriptor.protected {
            SE_DACL_PROTECTED
        } else {
            0
        };
    bytes[2..4].copy_from_slice(&control.to_le_bytes());
    bytes[4..8].copy_from_slice(&(HEADER_SIZE as u32).to_le_bytes());
    bytes.extend_from_slice(descriptor.owner);
    let group_offset = u32::try_from(bytes.len()).map_err(|_| invalid())?;
    bytes[8..12].copy_from_slice(&group_offset.to_le_bytes());
    bytes.extend_from_slice(descriptor.group);
    if let Some(acl) = descriptor.dacl {
        let acl_offset = u32::try_from(bytes.len()).map_err(|_| invalid())?;
        bytes[16..20].copy_from_slice(&acl_offset.to_le_bytes());
        bytes.push(acl.revision);
        bytes.push(0);
        bytes.extend_from_slice(
            &u16::try_from(acl_size)
                .map_err(|_| invalid())?
                .to_le_bytes(),
        );
        bytes.extend_from_slice(&acl.count.to_le_bytes());
        bytes.extend_from_slice(&[0, 0]);
        bytes.extend_from_slice(acl.entries);
    }
    Ok(bytes)
}

fn wide_path(path: &Path) -> Result<Vec<u16>, String> {
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        return Err("Windows security path contains a NUL".into());
    }
    wide.push(0);
    Ok(wide)
}

fn aligned_copy(bytes: &[u8]) -> Vec<u32> {
    bytes
        .chunks_exact(4)
        .map(|chunk| u32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}

/// Captures a self-relative OWNER|GROUP|DACL descriptor, without SACL privileges.
pub(super) fn capture(path: &Path) -> Result<Vec<u8>, String> {
    let wide = wide_path(path)?;
    let mut needed = 0u32;
    // SAFETY: `wide` is NUL-terminated, `needed` is writable, and the API
    // explicitly permits a null output buffer with length zero for sizing.
    let result =
        unsafe { GetFileSecurityW(wide.as_ptr(), INFORMATION, ptr::null_mut(), 0, &mut needed) };
    if result != 0
        || std::io::Error::last_os_error().raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32)
    {
        return Err(format!(
            "Cannot size Windows file security descriptor: {}",
            std::io::Error::last_os_error()
        ));
    }
    let len = usize::try_from(needed).map_err(|_| invalid())?;
    if !(HEADER_SIZE..=MAX_DESCRIPTOR_SIZE).contains(&len) || len % 4 != 0 {
        return Err(invalid());
    }
    let mut aligned = vec![0u32; len / 4];
    let mut written = 0u32;
    // SAFETY: `wide` is NUL-terminated; `aligned` is four-byte aligned and
    // owns `needed` writable bytes; `written` is a valid output pointer.
    let result = unsafe {
        GetFileSecurityW(
            wide.as_ptr(),
            INFORMATION,
            aligned.as_mut_ptr().cast(),
            needed,
            &mut written,
        )
    };
    if result == 0 {
        return Err(format!(
            "Cannot capture Windows file security descriptor: {}",
            std::io::Error::last_os_error()
        ));
    }
    if written != needed {
        return Err("Windows security descriptor changed during capture".into());
    }
    let bytes: Vec<u8> = aligned.iter().flat_map(|word| word.to_ne_bytes()).collect();
    let parsed = parse(&bytes)?;
    // SAFETY: the aligned buffer contains the descriptor just validated with
    // bounded component offsets, SID lengths, ACL sizes and ACE layouts.
    if unsafe { IsValidSecurityDescriptor(aligned.as_mut_ptr().cast()) } == 0 {
        return Err(invalid());
    }
    canonical(&parsed)
}

/// Restores security or reports an error if Windows cannot reproduce it.
pub(super) fn restore(path: &Path, descriptor: &[u8]) -> Result<(), String> {
    let expected = parse(descriptor)?;
    let wide = wide_path(path)?;
    // Drop unrelated control bits and padding from untrusted input before
    // passing it to Windows; the requested security state remains unchanged.
    let mut aligned = aligned_copy(&canonical(&expected)?);
    // SAFETY: parsing above checked every followed offset, component length,
    // ACE and SID; the descriptor copy is four-byte aligned and remains live.
    if unsafe { IsValidSecurityDescriptor(aligned.as_mut_ptr().cast()) } == 0 {
        return Err(invalid());
    }
    // SetFileSecurityW takes the protected/unprotected state from the
    // descriptor's SE_DACL_PROTECTED control bit. Unlike SetNamedSecurityInfo,
    // its behavior must not depend on the PROTECTED_DACL_INFORMATION flags.
    // SAFETY: `wide` is NUL-terminated and `aligned` is a validated, aligned,
    // self-relative descriptor whose backing allocation remains live.
    let result =
        unsafe { SetFileSecurityW(wide.as_ptr(), INFORMATION, aligned.as_mut_ptr().cast()) };
    if result == 0 {
        return Err(format!(
            "Cannot restore Windows file security descriptor: {}",
            std::io::Error::last_os_error()
        ));
    }
    // Windows may accept a descriptor but change inherited ACEs or protection.
    // Do not report success unless the relevant security state really matches.
    let actual_bytes = capture(path)?;
    let actual = parse(&actual_bytes)?;
    if expected.owner != actual.owner
        || expected.group != actual.group
        || expected.dacl != actual.dacl
        || expected.protected != actual.protected
    {
        return Err("Windows could not reproduce the saved file owner, group, or DACL".into());
    }
    Ok(())
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: this wrapper owns one successfully opened, non-pseudo handle.
        unsafe { CloseHandle(self.0) };
    }
}

fn token_user() -> Result<Vec<u8>, String> {
    let mut raw = ptr::null_mut();
    // SAFETY: the current-process pseudo handle is valid, and `raw` is a
    // writable output location; OpenProcessToken returns an owned handle.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
        return Err(format!(
            "Cannot open Windows user token: {}",
            std::io::Error::last_os_error()
        ));
    }
    let token = OwnedHandle(raw);
    let mut needed = 0u32;
    // SAFETY: the token is live, and a null output buffer of length zero is
    // expressly supported for querying the required buffer size.
    let result =
        unsafe { GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut needed) };
    if result != 0
        || std::io::Error::last_os_error().raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32)
    {
        return Err(format!(
            "Cannot size Windows user token: {}",
            std::io::Error::last_os_error()
        ));
    }
    let len = usize::try_from(needed).map_err(|_| invalid())?;
    if !(std::mem::size_of::<TOKEN_USER>()..=4096).contains(&len) {
        return Err("Invalid Windows user token length".into());
    }
    let word = std::mem::size_of::<usize>();
    let mut storage = vec![0usize; len.div_ceil(word)];
    let mut written = 0u32;
    // SAFETY: `storage` is pointer-aligned and contains at least `needed`
    // writable bytes; the handle and output length remain valid.
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            storage.as_mut_ptr().cast(),
            needed,
            &mut written,
        )
    } == 0
    {
        return Err(format!(
            "Cannot read Windows user token: {}",
            std::io::Error::last_os_error()
        ));
    }
    if written != needed {
        return Err("Windows user token changed during query".into());
    }
    // SAFETY: successful TokenUser output starts with a fully initialized
    // TOKEN_USER and the allocation has its required pointer alignment.
    let user = unsafe { *storage.as_ptr().cast::<TOKEN_USER>() };
    let start = storage.as_ptr() as usize;
    let sid_start = (user.User.Sid as usize)
        .checked_sub(start)
        .ok_or_else(invalid)?;
    if sid_start >= len {
        return Err(invalid());
    }
    // SAFETY: the initialized allocation has at least `len` bytes; we only
    // read the SID after checking that its pointer and length lie within it.
    let bytes = unsafe { std::slice::from_raw_parts(storage.as_ptr().cast::<u8>(), len) };
    let end = sid_end(bytes, sid_start)?;
    Ok(bytes[sid_start..end].to_vec())
}

fn well_known_sid(kind: WELL_KNOWN_SID_TYPE) -> Result<Vec<u8>, String> {
    // SECURITY_MAX_SID_SIZE is 68 bytes; u32 storage also aligns the SID.
    let mut storage = [0u32; 17];
    let mut size = 68u32;
    // SAFETY: the buffer is aligned and has `size` writable bytes; the null
    // domain SID is correct for these non-domain well-known SIDs.
    if unsafe {
        CreateWellKnownSid(
            kind,
            ptr::null_mut(),
            storage.as_mut_ptr().cast(),
            &mut size,
        )
    } == 0
    {
        return Err(format!(
            "Cannot create Windows well-known SID: {}",
            std::io::Error::last_os_error()
        ));
    }
    let len = usize::try_from(size).map_err(|_| invalid())?;
    if len > 68 {
        return Err(invalid());
    }
    let mut bytes: Vec<u8> = storage.iter().flat_map(|word| word.to_ne_bytes()).collect();
    bytes.truncate(len);
    if sid_end(&bytes, 0)? != len {
        return Err(invalid());
    }
    Ok(bytes)
}

struct PrivatePrincipals {
    user: Vec<u8>,
    system: Vec<u8>,
    administrators: Vec<u8>,
}

impl PrivatePrincipals {
    fn current() -> Result<Self, String> {
        Ok(Self {
            user: token_user()?,
            system: well_known_sid(WinLocalSystemSid)?,
            administrators: well_known_sid(WinBuiltinAdministratorsSid)?,
        })
    }

    fn permits(&self, sid: &[u8]) -> bool {
        sid == self.user || sid == self.system || sid == self.administrators
    }

    fn descriptor(&self) -> Result<Vec<u8>, String> {
        let mut entries = Vec::new();
        let mut principals: Vec<&[u8]> = Vec::new();
        for sid in [&self.user[..], &self.system[..], &self.administrators[..]] {
            if principals.contains(&sid) {
                continue;
            }
            principals.push(sid);
            entries.push(0); // ACCESS_ALLOWED_ACE_TYPE
            entries.push((OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) as u8);
            entries.extend_from_slice(
                &u16::try_from(8 + sid.len())
                    .map_err(|_| invalid())?
                    .to_le_bytes(),
            );
            entries.extend_from_slice(&FILE_ALL_ACCESS.to_le_bytes());
            entries.extend_from_slice(sid);
        }
        let descriptor = Descriptor {
            owner: &self.user,
            group: &self.user,
            dacl: Some(Acl {
                revision: 2,
                count: u16::try_from(principals.len()).map_err(|_| invalid())?,
                entries: &entries,
            }),
            protected: true,
        };
        let mut bytes = canonical(&descriptor)?;
        // Let Windows select the token's primary group when creating a root.
        bytes[8..12].fill(0);
        Ok(bytes)
    }
}

fn open_private_object(path: &Path, lock_name: bool) -> Result<(OwnedHandle, bool), String> {
    let wide = wide_path(path)?;
    let share = FILE_SHARE_READ | FILE_SHARE_WRITE | if lock_name { 0 } else { FILE_SHARE_DELETE };
    // SAFETY: the path is terminated, security/template pointers are null,
    // and OPEN_REPARSE_POINT opens the link itself rather than following it.
    let raw = unsafe {
        CreateFileW(
            wide.as_ptr(),
            READ_CONTROL,
            share,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            ptr::null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(format!(
            "Cannot open Windows recovery storage entry: {}",
            std::io::Error::last_os_error()
        ));
    }
    let handle = OwnedHandle(raw);
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `handle` is live and `info` points to a writable structure.
    if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0 {
        return Err(format!(
            "Cannot inspect Windows recovery storage entry: {}",
            std::io::Error::last_os_error()
        ));
    }
    if info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DEVICE) != 0 {
        return Err("Windows recovery storage contains a reparse point or device".into());
    }
    Ok((
        handle,
        info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0,
    ))
}

/// Reject EAs that the snapshot format does not preserve, without following
/// the final path component. Querying the EA list, rather than only EaSize,
/// ensures an unsupported filesystem is reported as an error instead of
/// mistaking a zero-valued unsupported information field for an empty list.
pub(super) fn reject_extended_attributes(path: &Path) -> Result<(), String> {
    let wide = wide_path(path)?;
    // SAFETY: the path is terminated, optional parameters are null, and
    // OPEN_REPARSE_POINT opens the final reparse point instead of its target.
    let raw = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_EA,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            ptr::null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(format!(
            "Cannot open file for Windows extended attribute inspection: {}",
            std::io::Error::last_os_error()
        ));
    }
    let handle = OwnedHandle(raw);
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `handle` is live and `info` points to a writable structure.
    if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0 {
        return Err(format!(
            "Cannot inspect file for Windows extended attributes: {}",
            std::io::Error::last_os_error()
        ));
    }
    if info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DEVICE) != 0 {
        return Err(
            "Cannot inspect Windows extended attributes on a reparse point or device".into(),
        );
    }
    let mut io = IO_STATUS_BLOCK::default();
    // A small aligned buffer is sufficient: a complete first entry, or a
    // buffer-too-small/overflow status, proves that an EA exists.
    let mut buffer = [0u32; 4];
    // SAFETY: the synchronous file handle remains live, IO_STATUS_BLOCK and
    // aligned output buffer are writable, and both optional selectors are
    // null. RestartScan begins at the first EA and requests a single entry.
    let status = unsafe {
        NtQueryEaFile(
            handle.0,
            &mut io,
            buffer.as_mut_ptr().cast(),
            16,
            true,
            ptr::null(),
            0,
            ptr::null(),
            true,
        )
    };
    match status {
        STATUS_NO_EAS_ON_FILE => Ok(()),
        STATUS_SUCCESS | STATUS_BUFFER_OVERFLOW | STATUS_BUFFER_TOO_SMALL => {
            Err("Windows extended attributes cannot be preserved safely".into())
        }
        _ => Err(format!(
            "Cannot query Windows extended attributes (NTSTATUS 0x{:08x})",
            status as u32
        )),
    }
}

fn handle_descriptor(handle: &OwnedHandle) -> Result<Vec<u8>, String> {
    let mut descriptor = ptr::null_mut();
    // SAFETY: the file handle has READ_CONTROL, all omitted component outputs
    // are null, and `descriptor` is a writable output. On success Windows
    // supplies a self-relative LocalAlloc-owned security descriptor.
    let status = unsafe {
        GetSecurityInfo(
            handle.0,
            SE_FILE_OBJECT,
            INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(format!(
            "Cannot read Windows recovery storage security: {}",
            std::io::Error::from_raw_os_error(status as i32)
        ));
    }
    if descriptor.is_null() {
        return Err(invalid());
    }
    struct LocalDescriptor(*mut std::ffi::c_void);
    impl Drop for LocalDescriptor {
        fn drop(&mut self) {
            // SAFETY: GetSecurityInfo returned this allocation and it is freed once.
            unsafe { LocalFree(self.0) };
        }
    }
    let descriptor = LocalDescriptor(descriptor);
    // SAFETY: this is the live, OS-returned security descriptor.
    let len = unsafe { GetSecurityDescriptorLength(descriptor.0) } as usize;
    if !(HEADER_SIZE..=MAX_DESCRIPTOR_SIZE).contains(&len) {
        return Err(invalid());
    }
    // SAFETY: GetSecurityInfo returned a complete self-relative descriptor;
    // GetSecurityDescriptorLength reported its size, bounded above.
    let bytes = unsafe { std::slice::from_raw_parts(descriptor.0.cast::<u8>(), len) };
    Ok(bytes.to_vec())
}

fn private_descriptor_ok(
    bytes: &[u8],
    principals: &PrivatePrincipals,
    directory: bool,
    root: bool,
) -> Result<(), String> {
    let sd = parse(bytes)?;
    if (root && (sd.owner != principals.user || !sd.protected))
        || (!root && !principals.permits(sd.owner))
    {
        return Err("Windows recovery storage has an unsafe owner or inherited root DACL".into());
    }
    let acl = sd
        .dacl
        .ok_or_else(|| "Windows recovery storage has a null DACL".to_string())?;
    let mut found = [false; 3];
    let mut offset = 0;
    for _ in 0..acl.count {
        let size = usize::from(u16_at(acl.entries, offset + 2)?);
        let ace = &acl.entries[offset..offset + size];
        let flags = ace[1];
        // Only full-control, unconditional allow ACEs for the three intended
        // principals are allowed. Reject inherit-only/no-propagate entries.
        if ace[0] != 0
            || flags & !0x13 != 0
            || u32_at(ace, 4)? != FILE_ALL_ACCESS
            || (directory && flags & 3 != 3)
        {
            return Err("Windows recovery storage has an unsafe DACL".into());
        }
        let end = sid_end(ace, 8)?;
        let sid = &ace[8..end];
        if !principals.permits(sid) {
            return Err("Windows recovery storage grants access to another principal".into());
        }
        found[0] |= sid == principals.user;
        found[1] |= sid == principals.system;
        found[2] |= sid == principals.administrators;
        offset += size;
    }
    if !found.into_iter().all(|present| present) {
        return Err("Windows recovery storage lacks a required private access entry".into());
    }
    Ok(())
}

/// Check an existing storage descendant without following a reparse point.
pub(super) fn verify_private(path: &Path) -> Result<(), String> {
    let principals = PrivatePrincipals::current()?;
    let (handle, directory) = open_private_object(path, false)?;
    private_descriptor_ok(&handle_descriptor(&handle)?, &principals, directory, false)
}

/// Create or secure only the feature's storage root before writing private data.
pub(super) fn ensure_private_directory(path: &Path) -> Result<(), String> {
    let principals = PrivatePrincipals::current()?;
    let wide = wide_path(path)?;
    let mut descriptor = aligned_copy(&principals.descriptor()?);
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.as_mut_ptr().cast(),
        bInheritHandle: 0,
    };
    // SAFETY: `wide` is terminated, and the attributes reference an aligned
    // protected descriptor and ACL that remain live for the complete call.
    if unsafe { CreateDirectoryW(wide.as_ptr(), &attributes) } == 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_ALREADY_EXISTS as i32) {
            return Err(format!(
                "Cannot create private Windows recovery storage: {error}"
            ));
        }
    }
    // Keep an open handle without delete sharing so the final path component
    // cannot be renamed/replaced while its DACL is being restricted.
    let (handle, directory) = open_private_object(path, true)?;
    if !directory {
        return Err("Windows recovery storage root is not a directory".into());
    }
    let before = handle_descriptor(&handle)?;
    if before.len() < HEADER_SIZE || before[0] != 1 || u16_at(&before, 2)? & SE_SELF_RELATIVE == 0 {
        return Err(invalid());
    }
    let owner = component_offset(&before, 4)?;
    let owner_end = sid_end(&before, owner)?;
    if before[owner..owner_end] != principals.user {
        return Err("Windows recovery storage root is not owned by the current user".into());
    }
    if private_descriptor_ok(&before, &principals, true, true).is_err() {
        // SetFileSecurityW changes this directory only, without propagating a
        // new ACL into pre-existing descendants. The protected control bit is
        // in the supplied descriptor, not in the SecurityInformation mask.
        // SAFETY: the path is terminated; `descriptor` is aligned and holds
        // the complete trusted ACL until this call returns.
        if unsafe {
            SetFileSecurityW(
                wide.as_ptr(),
                DACL_SECURITY_INFORMATION,
                descriptor.as_mut_ptr().cast(),
            )
        } == 0
        {
            return Err(format!(
                "Cannot restrict Windows recovery storage: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    private_descriptor_ok(&handle_descriptor(&handle)?, &principals, true, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::path::PathBuf;

    #[test]
    fn extended_attribute_guard_checks_real_files_and_directories() {
        use windows_sys::Wdk::Storage::FileSystem::NtSetEaFile;
        use windows_sys::Win32::Storage::FileSystem::FILE_WRITE_EA;

        let dir = TempDir::new("windows-security", "extended-attributes");
        let file = dir.path().join("file");
        let folder = dir.path().join("folder");
        std::fs::write(&file, b"file").unwrap();
        std::fs::create_dir(&folder).unwrap();
        reject_extended_attributes(&file).unwrap();
        reject_extended_attributes(&folder).unwrap();
        assert!(reject_extended_attributes(&dir.path().join("missing")).is_err());
        let link = dir.path().join("link");
        if std::os::windows::fs::symlink_file(&file, &link).is_ok() {
            assert!(reject_extended_attributes(&link).is_err());
            std::fs::remove_file(link).unwrap();
        }

        for path in [&file, &folder] {
            let wide = wide_path(path).unwrap();
            // SAFETY: path is terminated, optional parameters are null, and
            // no-follow/backup-semantics handles files and directories.
            let raw = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    FILE_WRITE_EA,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                    ptr::null_mut(),
                )
            };
            assert_ne!(raw, INVALID_HANDLE_VALUE);
            let handle = OwnedHandle(raw);
            // FILE_FULL_EA_INFORMATION: next=0, flags=0, name length=4,
            // value length=1, NUL-terminated name, then one value byte.
            let mut ea = [0u32; 4];
            let bytes: [u8; 16] = [0, 0, 0, 0, 0, 4, 1, 0, b't', b'e', b's', b't', 0, 42, 0, 0];
            for (word, chunk) in ea.iter_mut().zip(bytes.chunks_exact(4)) {
                *word = u32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            }
            let mut io = IO_STATUS_BLOCK::default();
            // SAFETY: the synchronous handle is writable for EAs, `io` is
            // writable, and `ea` is an aligned, initialized 14-byte record.
            let status = unsafe { NtSetEaFile(handle.0, &mut io, ea.as_ptr().cast(), 14) };
            assert_eq!(
                status, STATUS_SUCCESS,
                "cannot set test EA: 0x{:08x}",
                status as u32
            );
            assert!(reject_extended_attributes(path).is_err());
        }
    }

    #[test]
    fn private_root_and_descendants_have_restricted_inheritable_acl() {
        let dir = TempDir::new("windows-security", "private-root");
        let root = dir.path().join("storage");
        ensure_private_directory(&root).unwrap();
        ensure_private_directory(&root).unwrap();
        verify_private(&root).unwrap();
        let child = root.join("child");
        std::fs::create_dir(&child).unwrap();
        let file = child.join("secret");
        std::fs::write(&file, b"private").unwrap();
        verify_private(&child).unwrap();
        verify_private(&file).unwrap();

        let not_dir = dir.path().join("ordinary-file");
        std::fs::write(&not_dir, b"file").unwrap();
        assert!(ensure_private_directory(&not_dir).is_err());
        // Creating directory symlinks requires Developer Mode or a privilege.
        // When available, verify that the reparse point itself is rejected.
        let link = dir.path().join("link");
        if std::os::windows::fs::symlink_dir(&root, &link).is_ok() {
            assert!(ensure_private_directory(&link).is_err());
            assert!(verify_private(&link).is_err());
            std::fs::remove_dir(&link).unwrap();
        }
    }

    #[test]
    fn unsafe_existing_root_is_restricted_without_rewriting_children() {
        use windows_sys::Win32::Security::WinWorldSid;

        let dir = TempDir::new("windows-security", "restrict-root");
        let root = dir.path().join("storage");
        ensure_private_directory(&root).unwrap();
        let child = root.join("child");
        std::fs::write(&child, b"kept").unwrap();
        let child_before = capture(&child).unwrap();
        let security = capture(&root).unwrap();
        let parsed = parse(&security).unwrap();
        let acl = parsed.dacl.unwrap();
        let mut entries = acl.entries.to_vec();
        let everyone = well_known_sid(WinWorldSid).unwrap();
        entries.push(0);
        entries.push((OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) as u8);
        entries.extend_from_slice(&u16::try_from(8 + everyone.len()).unwrap().to_le_bytes());
        entries.extend_from_slice(&FILE_ALL_ACCESS.to_le_bytes());
        entries.extend_from_slice(&everyone);
        let unsafe_acl = Acl {
            revision: acl.revision,
            count: acl.count + 1,
            entries: &entries,
        };
        let unsafe_sd = Descriptor {
            owner: parsed.owner,
            group: parsed.group,
            dacl: Some(unsafe_acl),
            protected: true,
        };
        let mut aligned = aligned_copy(&canonical(&unsafe_sd).unwrap());
        let wide = wide_path(&root).unwrap();
        // SAFETY: this disposable directory path and aligned descriptor are
        // valid and live; the call changes only the test directory's DACL.
        assert_ne!(
            unsafe {
                SetFileSecurityW(
                    wide.as_ptr(),
                    DACL_SECURITY_INFORMATION,
                    aligned.as_mut_ptr().cast(),
                )
            },
            0
        );
        assert!(verify_private(&root).is_err());
        ensure_private_directory(&root).unwrap();
        verify_private(&root).unwrap();
        assert_eq!(capture(&child).unwrap(), child_before);
        assert_eq!(std::fs::read(&child).unwrap(), b"kept");
    }

    #[test]
    fn capture_restore_file_and_directory_security() {
        let dir = TempDir::new("windows-security", "round-trip");
        let source = dir.path().join("source");
        let target = dir.path().join("target");
        std::fs::write(&source, b"source").unwrap();
        std::fs::write(&target, b"target").unwrap();
        let descriptor = capture(&source).unwrap();
        verify(&descriptor).unwrap();
        restore(&target, &descriptor).unwrap();
        let copied = capture(&target).unwrap();
        assert_eq!(copied, descriptor);
        // Serialized byte slices need not themselves be pointer-aligned.
        // restore copies into an aligned allocation before calling Win32.
        let mut unaligned = vec![0u8];
        unaligned.extend_from_slice(&descriptor);
        verify(&unaligned[1..]).unwrap();
        restore(&target, &unaligned[1..]).unwrap();
        let expected = parse(&descriptor).unwrap();
        let actual = parse(&copied).unwrap();
        assert_eq!(expected.owner, actual.owner);
        assert_eq!(expected.group, actual.group);
        assert!(expected.dacl == actual.dacl);
        assert_eq!(expected.protected, actual.protected);

        let source_dir = dir.path().join("source-dir");
        let target_dir = dir.path().join("target-dir");
        std::fs::create_dir(&source_dir).unwrap();
        std::fs::create_dir(&target_dir).unwrap();
        restore(&target_dir, &capture(&source_dir).unwrap()).unwrap();
    }

    #[test]
    fn dacl_protection_is_restored_both_ways() {
        let dir = TempDir::new("windows-security", "protection");
        let file = dir.path().join("file");
        std::fs::write(&file, b"file").unwrap();
        let original = capture(&file).unwrap();
        for protected in [true, false] {
            let mut descriptor = original.clone();
            let mut control = u16_at(&descriptor, 2).unwrap();
            if protected {
                control |= SE_DACL_PROTECTED;
            } else {
                control &= !SE_DACL_PROTECTED;
            }
            descriptor[2..4].copy_from_slice(&control.to_le_bytes());
            restore(&file, &descriptor).unwrap();
            let captured = capture(&file).unwrap();
            assert_eq!(parse(&captured).unwrap().protected, protected);
        }
    }

    #[test]
    fn canonical_form_ignores_non_contract_bits_and_acl_slack() {
        let dir = TempDir::new("windows-security", "canonical");
        let file = dir.path().join("file");
        std::fs::write(&file, b"file").unwrap();
        let descriptor = capture(&file).unwrap();
        let mut variant = descriptor.clone();
        let control = u16_at(&variant, 2).unwrap() | 0x0400;
        variant[2..4].copy_from_slice(&control.to_le_bytes());
        let acl_offset = usize::try_from(u32_at(&variant, 16).unwrap()).unwrap();
        if acl_offset != 0 {
            let size = u16_at(&variant, acl_offset + 2).unwrap();
            if let Some(size) = size.checked_add(4) {
                variant[acl_offset + 2..acl_offset + 4].copy_from_slice(&size.to_le_bytes());
                variant.extend_from_slice(&[0; 4]);
            }
        }
        assert_eq!(canonical(&parse(&variant).unwrap()).unwrap(), descriptor);
    }

    #[test]
    fn rejects_truncated_and_malformed_ace_data() {
        let dir = TempDir::new("windows-security", "bad-ace");
        let file = dir.path().join("file");
        std::fs::write(&file, b"file").unwrap();
        let before = capture(&file).unwrap();
        // A 20-byte relative header, two 12-byte SIDs and one 28-byte ACL
        // containing a single access-allowed ACE with a 12-byte SID.
        let mut descriptor = vec![0u8; 72];
        descriptor[0] = 1;
        descriptor[2..4].copy_from_slice(&(SE_SELF_RELATIVE | SE_DACL_PRESENT).to_le_bytes());
        descriptor[4..8].copy_from_slice(&20u32.to_le_bytes());
        descriptor[8..12].copy_from_slice(&32u32.to_le_bytes());
        descriptor[16..20].copy_from_slice(&44u32.to_le_bytes());
        let sid = [1, 1, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0];
        descriptor[20..32].copy_from_slice(&sid);
        descriptor[32..44].copy_from_slice(&sid);
        descriptor[44] = 2;
        descriptor[46..48].copy_from_slice(&28u16.to_le_bytes());
        descriptor[48..50].copy_from_slice(&1u16.to_le_bytes());
        descriptor[54..56].copy_from_slice(&20u16.to_le_bytes());
        descriptor[60..72].copy_from_slice(&sid);
        verify(&descriptor).unwrap();
        for len in 0..descriptor.len() {
            assert!(verify(&descriptor[..len]).is_err());
            assert!(restore(&file, &descriptor[..len]).is_err());
        }
        let mut bad = descriptor.clone();
        bad[54..56].copy_from_slice(&24u16.to_le_bytes());
        assert!(verify(&bad).is_err());
        bad = descriptor.clone();
        bad[61] = 15;
        assert!(verify(&bad).is_err());
        bad = descriptor.clone();
        bad[52] = 5; // Object ACE without the required flags, GUIDs and SID.
        assert!(verify(&bad).is_err());
        bad = descriptor;
        bad[48..50].copy_from_slice(&2u16.to_le_bytes());
        assert!(verify(&bad).is_err());
        assert_eq!(capture(&file).unwrap(), before);
    }

    #[test]
    fn rejects_corrupt_truncated_and_unaligned_descriptors_before_restore() {
        let dir = TempDir::new("windows-security", "invalid");
        let file = dir.path().join("file");
        std::fs::write(&file, b"file").unwrap();
        let descriptor = capture(&file).unwrap();
        for len in 0..HEADER_SIZE {
            assert!(verify(&descriptor[..len]).is_err());
            assert!(restore(&file, &descriptor[..len]).is_err());
        }
        let mut bad = descriptor.clone();
        bad[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(verify(&bad).is_err());
        assert!(restore(&file, &bad).is_err());
        bad = descriptor.clone();
        bad[8..12].copy_from_slice(&21u32.to_le_bytes());
        assert!(verify(&bad).is_err());
        bad = descriptor.clone();
        let control = u16_at(&bad, 2).unwrap() & !SE_SELF_RELATIVE;
        bad[2..4].copy_from_slice(&control.to_le_bytes());
        assert!(verify(&bad).is_err());
        bad = descriptor.clone();
        let owner = usize::try_from(u32_at(&bad, 4).unwrap()).unwrap();
        bad[owner + 1] = 255;
        assert!(verify(&bad).is_err());
        assert!(verify(&vec![0; MAX_DESCRIPTOR_SIZE + 4]).is_err());
        assert_eq!(capture(&file).unwrap(), descriptor);
    }

    #[test]
    fn rejects_embedded_nul_in_paths() {
        let path = PathBuf::from(OsString::from_wide(&[b'a' as u16, 0, b'b' as u16]));
        assert!(capture(&path).is_err());
        assert!(wide_path(&path).is_err());
    }
}
