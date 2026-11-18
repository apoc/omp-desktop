//! Windows named-pipe naming and access control.
//!
//! The pipe carries the persona protocol for the app and the extension, so it
//! must be usable by the current user only: the name carries that user's SID
//! and the DACL grants full access to that SID alone, protected from inherited
//! access control entries (no Everyone, no anonymous entry, no `LocalSystem`).
//!
//! A per-user name alone is not enough: any account may create
//! `\\.\pipe\omp-desktopd-<victim SID>` before the service does.
//! `connect_verified` therefore verifies the answering server's user before a
//! connection is handed back, so neither the app nor the `status` command
//! writes a byte to a stranger's pipe.

use interprocess::local_socket::Stream;
use std::io;

/// The Win32 path of the named pipe `name`, e.g.
/// `\\.\pipe\omp-desktopd-S-1-5-21-...-1001`.
#[must_use]
pub fn pipe_path(name: &str) -> String {
    format!(r"\\.\pipe\{name}")
}

/// Why [`connect_verified`] returned no connection.
#[derive(Debug)]
pub enum PipeConnectError {
    /// Nothing answered on the socket or pipe.
    Unavailable(io::Error),
    /// A server answered, but it runs as another account.
    NotOurs,
    /// A server answered, but its owner could not be read.
    Unverified(io::Error),
}

impl std::fmt::Display for PipeConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(error) => error.fmt(f),
            Self::NotOurs => f.write_str("another account owns the persona pipe"),
            Self::Unverified(error) => write!(f, "cannot verify the persona pipe owner: {error}"),
        }
    }
}

impl std::error::Error for PipeConnectError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Unavailable(error) | Self::Unverified(error) => Some(error),
            Self::NotOurs => None,
        }
    }
}

/// Connects to the persona service and, on Windows, proves that the answering
/// server runs as the current user before returning.
///
/// The check happens before any byte is written, so another account's
/// pre-created pipe never receives a request. The Windows client handle asks
/// for identification-level impersonation only
/// (`SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION`), so even the verified
/// server can do no more with the client's token than learn who it is.
///
/// # Errors
///
/// Returns [`PipeConnectError::Unavailable`] when nothing answers,
/// [`PipeConnectError::NotOurs`] for another account's server, and
/// [`PipeConnectError::Unverified`] when the owner cannot be determined.
pub fn connect_verified(paths: &crate::persona_paths::Paths) -> Result<Stream, PipeConnectError> {
    #[cfg(windows)]
    {
        imp::connect_verified(paths)
    }
    #[cfg(unix)]
    {
        use interprocess::local_socket::traits::Stream as _;

        let name =
            crate::persona_paths::socket_name(paths).map_err(PipeConnectError::Unavailable)?;
        Stream::connect(name).map_err(PipeConnectError::Unavailable)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = paths;
        Err(PipeConnectError::Unavailable(io::Error::other(
            "local sockets are not supported here",
        )))
    }
}

/// The DACL for the persona pipe: full access for `sid` only, protected from
/// inherited access control entries.
#[must_use]
pub fn pipe_sddl(sid: &str) -> String {
    format!("D:P(A;;GA;;;{sid})")
}

/// The per-user pipe name for `sid`.
#[must_use]
pub fn pipe_name_for(sid: &str) -> String {
    format!("omp-desktopd-{sid}")
}

/// Whether two string SIDs name the same account.
///
/// SIDs are canonical (`S-1-5-...`); the comparison is ASCII
/// case-insensitive and ignores surrounding whitespace, so a differently
/// cased rendering still matches.
#[must_use]
pub fn same_sid(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// Zeroed storage for a `TOKEN_USER` and its trailing SID.
///
/// `GetTokenInformation` writes a `TOKEN_USER`, whose members need 8-byte
/// alignment; a `Vec<u8>` only guarantees 1. The buffer is allocated as `u64`
/// words covering at least `bytes` bytes.
#[cfg_attr(not(windows), allow(dead_code))]
fn token_user_storage(bytes: u32) -> Vec<u64> {
    vec![0u64; (bytes as usize).div_ceil(8)]
}

#[cfg(windows)]
pub use imp::{current_user_sid, listener_security_descriptor, pipe_name, probe_is_ours};

#[cfg(windows)]
mod imp {
    use super::{
        pipe_name_for, pipe_path, pipe_sddl, same_sid, token_user_storage, PipeConnectError,
    };
    use interprocess::local_socket::Stream;
    use interprocess::os::windows::security_descriptor::SecurityDescriptor;
    use std::ffi::c_void;
    use std::io;
    use std::mem::size_of;
    use std::os::windows::io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle};
    use std::ptr;
    use windows_sys::Win32::Foundation::{
        CloseHandle, LocalFree, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_OVERLAPPED, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
    };
    use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// The current user's SID in its string form, e.g. `S-1-5-21-...-1001`.
    ///
    /// # Errors
    ///
    /// Returns the failing Win32 call when the process token or its user SID
    /// cannot be read. There is deliberately no fallback to a name-based pipe:
    /// a guessed name would widen access beyond this user.
    pub fn current_user_sid() -> io::Result<String> {
        let mut token: HANDLE = ptr::null_mut();
        // SAFETY: `token` receives an owned handle on success.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let result = token_user_sid(token);
        // SAFETY: the token handle is owned here and closed exactly once.
        unsafe {
            CloseHandle(token);
        }
        result
    }

    /// The current user's pipe name.
    ///
    /// # Errors
    ///
    /// See [`current_user_sid`].
    pub fn pipe_name() -> io::Result<String> {
        Ok(pipe_name_for(&current_user_sid()?))
    }

    /// The security descriptor for the pipe listener: [`pipe_sddl`] for the
    /// current user.
    ///
    /// # Errors
    ///
    /// Returns the SID error, or an error when the DACL cannot be parsed.
    pub fn listener_security_descriptor() -> io::Result<SecurityDescriptor> {
        let sddl = pipe_sddl(&current_user_sid()?);
        let wide = widestring::U16CString::from_str(&sddl)
            .map_err(|_| io::Error::other("pipe DACL cannot be encoded"))?;
        SecurityDescriptor::deserialize(wide.as_ucstr())
    }

    /// Connects to the persona pipe and verifies its server before returning.
    ///
    /// # Errors
    ///
    /// See [`PipeConnectError`].
    pub(super) fn connect_verified(
        paths: &crate::persona_paths::Paths,
    ) -> Result<Stream, PipeConnectError> {
        let name = crate::persona_paths::windows_pipe_name(paths)
            .map_err(PipeConnectError::Unavailable)?;
        let stream = connect_client_pipe(&name).map_err(PipeConnectError::Unavailable)?;
        match probe_is_ours(&stream) {
            Ok(true) => Ok(stream),
            Ok(false) => Err(PipeConnectError::NotOurs),
            Err(error) => Err(PipeConnectError::Unverified(error)),
        }
    }

    /// Opens the client end of the named pipe `name`.
    ///
    /// `CreateFileW` rather than interprocess's connector: only the raw call
    /// carries an SQOS, and `SECURITY_IDENTIFICATION` limits the server to
    /// learning who the client is instead of acting as it. The overlapped
    /// flag keeps the wrapped stream's read mode what interprocess expects.
    fn connect_client_pipe(name: &str) -> io::Result<Stream> {
        let path = widestring::U16CString::from_str(&pipe_path(name))
            .map_err(|_| io::Error::other("pipe name cannot be encoded"))?;
        // SAFETY: `path` is a NUL-terminated local buffer and the trailing
        // arguments are an unused security attribute and template handle.
        let raw: windows_sys::Win32::Foundation::HANDLE = unsafe {
            CreateFileW(
                path.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                ptr::null_mut(),
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `CreateFileW` returned a valid handle that no one else
        // owns; `OwnedHandle` closes it exactly once.
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        // The named-pipe stream is the only type interprocess lets a caller
        // build from an owned handle; the local-socket enum wraps it.
        let pipe = interprocess::os::windows::named_pipe::local_socket::Stream::try_from(handle)
            .map_err(|error| io::Error::other(error.to_string()))?;
        Ok(Stream::from(pipe))
    }

    /// Whether the server answering on `stream` runs as the current user.
    ///
    /// Asks the pipe for its server process id
    /// (`GetNamedPipeServerProcessId`), opens that process with
    /// `PROCESS_QUERY_LIMITED_INFORMATION` and compares its token user SID
    /// with ours. This is what stops another account's pre-created pipe from
    /// being mistaken for our own service.
    ///
    /// # Errors
    ///
    /// Returns the failing Win32 call, or a SID error, when the server process
    /// or its user cannot be read. A probe that cannot be verified is never
    /// trusted in either direction.
    pub fn probe_is_ours(stream: &Stream) -> io::Result<bool> {
        let Stream::NamedPipe(pipe) = stream;
        let mut pid = 0u32;
        // SAFETY: the handle is the client end of a connected named pipe in
        // this process; `pid` receives the server's process id.
        if unsafe { GetNamedPipeServerProcessId(pipe.as_handle().as_raw_handle(), &mut pid) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if pid == 0 {
            return Err(io::Error::other("the pipe server reported no process"));
        }
        // SAFETY: `pid` came from the pipe; the returned handle is owned here.
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut token: HANDLE = ptr::null_mut();
        // SAFETY: `process` is open and `token` receives an owned handle.
        let opened = unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) };
        // SAFETY: the process handle is owned here and closed exactly once.
        unsafe {
            CloseHandle(process);
        }
        if opened == 0 {
            return Err(io::Error::last_os_error());
        }
        let server_sid = token_user_sid(token);
        // SAFETY: the token handle is owned here and closed exactly once.
        unsafe {
            CloseHandle(token);
        }
        Ok(same_sid(&server_sid?, &current_user_sid()?))
    }

    fn token_user_sid(token: HANDLE) -> io::Result<String> {
        let mut size = 0u32;
        // SAFETY: the probe only asks for the required buffer size.
        unsafe { GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut size) };
        if size == 0 {
            return Err(io::Error::last_os_error());
        }
        if (size as usize) < size_of::<TOKEN_USER>() {
            return Err(io::Error::other("TOKEN_USER buffer is too small"));
        }
        let mut buffer = token_user_storage(size);
        // SAFETY: the buffer holds at least `size` bytes and is 8-byte
        // aligned, which `TOKEN_USER` requires; the call writes at most `size`
        // bytes and reports the used size.
        if unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr().cast::<c_void>(),
                size,
                &mut size,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if size as usize > buffer.len() * size_of::<u64>() {
            return Err(io::Error::other("TOKEN_USER outgrew its buffer"));
        }
        // SAFETY: on success the buffer starts with a `TOKEN_USER` whose `Sid`
        // points into the same buffer; it is word-aligned and at least
        // `size_of::<TOKEN_USER>()` bytes.
        let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
        let mut string_sid: *mut u16 = ptr::null_mut();
        // SAFETY: `string_sid` receives a LocalAlloc-owned string on success.
        if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut string_sid) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the string is NUL-terminated and owned by this call; it is
        // copied out before the allocation is freed.
        let sid = unsafe {
            let text = widestring::U16CStr::from_ptr_str(string_sid).to_string_lossy();
            LocalFree(string_sid.cast());
            text
        };
        Ok(sid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::{align_of, size_of};

    #[test]
    fn pipe_name_uses_the_sid() {
        let sid = "S-1-5-21-1111-2222-3333-1001";
        assert_eq!(
            pipe_name_for(sid),
            "omp-desktopd-S-1-5-21-1111-2222-3333-1001"
        );
    }

    #[test]
    fn pipe_dacl_grants_only_the_user() {
        let sid = "S-1-5-21-1111-2222-3333-1001";
        let sddl = pipe_sddl(sid);
        assert_eq!(sddl, format!("D:P(A;;GA;;;{sid})"));
        // No LocalSystem (`SY`), Everyone (`WD`) or anonymous (`AN`) access.
        assert!(!sddl.contains("SY") && !sddl.contains("WD") && !sddl.contains("AN"));
    }

    #[test]
    fn sid_comparison_ignores_case_and_space() {
        assert!(same_sid("S-1-5-21-1-2-3-1001", "s-1-5-21-1-2-3-1001"));
        assert!(same_sid(" S-1-5-21-1-2-3-1001 ", "S-1-5-21-1-2-3-1001"));
        assert!(!same_sid("S-1-5-21-1-2-3-1001", "S-1-5-21-1-2-3-1002"));
    }

    #[test]
    fn token_user_storage_is_word_aligned_and_covers_the_size() {
        for bytes in [0u32, 1, 7, 8, 9, 100] {
            let buffer = token_user_storage(bytes);
            assert!(
                buffer.len() * size_of::<u64>() >= bytes as usize,
                "storage must cover {bytes} bytes"
            );
            assert_eq!(
                (buffer.as_ptr() as usize) % align_of::<u64>(),
                0,
                "storage must meet TOKEN_USER alignment"
            );
        }
        assert_eq!(token_user_storage(9).len(), 2);
    }

    #[test]
    fn pipe_path_targets_the_local_named_pipe_namespace() {
        assert_eq!(
            pipe_path("omp-desktopd-S-1-5-21-1-2-3-1001"),
            r"\\.\pipe\omp-desktopd-S-1-5-21-1-2-3-1001"
        );
    }

    #[test]
    fn connect_errors_carry_the_kind_the_app_reports() {
        assert_eq!(
            PipeConnectError::Unavailable(io::Error::other("connection refused")).to_string(),
            "connection refused"
        );
        assert_eq!(
            PipeConnectError::NotOurs.to_string(),
            "another account owns the persona pipe"
        );
        assert_eq!(
            PipeConnectError::Unverified(io::Error::other("access denied")).to_string(),
            "cannot verify the persona pipe owner: access denied"
        );
    }
}
