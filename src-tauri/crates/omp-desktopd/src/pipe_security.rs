//! Windows named-pipe naming and access control.
//!
//! The pipe carries the persona protocol for the app and the extension, so it
//! must be usable by the current user only: the name carries that user's SID
//! and the DACL grants full access to the user and `LocalSystem`, with nothing
//! inherited (no Everyone, no anonymous entry).

/// The DACL for the persona pipe: full access for `LocalSystem` (`SY`) and
/// `sid`, protected from inherited access control entries.
#[must_use]
pub fn pipe_sddl(sid: &str) -> String {
    format!("D:P(A;;GA;;;SY)(A;;GA;;;{sid})")
}

/// The per-user pipe name for `sid`.
#[must_use]
pub fn pipe_name_for(sid: &str) -> String {
    format!("omp-desktopd-{sid}")
}

#[cfg(windows)]
pub use imp::{current_user_sid, listener_security_descriptor, pipe_name};

#[cfg(windows)]
mod imp {
    use super::{pipe_name_for, pipe_sddl};
    use interprocess::os::windows::security_descriptor::SecurityDescriptor;
    use std::ffi::c_void;
    use std::io;
    use std::ptr;
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

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

    fn token_user_sid(token: HANDLE) -> io::Result<String> {
        let mut size = 0u32;
        // SAFETY: the probe only asks for the required buffer size.
        unsafe { GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut size) };
        if size == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut buffer = vec![0u8; size as usize];
        // SAFETY: the buffer is `size` bytes and the call writes at most that.
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
        // SAFETY: on success the buffer starts with a `TOKEN_USER` whose `Sid`
        // points into the same buffer.
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

    #[test]
    fn pipe_name_uses_the_sid() {
        let sid = "S-1-5-21-1111-2222-3333-1001";
        assert_eq!(
            pipe_name_for(sid),
            "omp-desktopd-S-1-5-21-1111-2222-3333-1001"
        );
    }

    #[test]
    fn pipe_dacl_grants_only_the_user_and_system() {
        let sid = "S-1-5-21-1111-2222-3333-1001";
        let sddl = pipe_sddl(sid);
        assert_eq!(sddl, format!("D:P(A;;GA;;;SY)(A;;GA;;;{sid})"));
        // No Everyone (`WD`) and no anonymous (`AN`) access.
        assert!(!sddl.contains("WD") && !sddl.contains("AN"));
    }
}
