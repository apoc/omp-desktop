//! Whether the desktop session is locked, for "push only while locked":
//! the `CGSession` dictionary on macOS, the WTS session flags on Windows,
//! systemd-logind's `LockedHint` on Linux.

/// Whether [`screen_locked`] can answer on this platform.
pub const DETECTION: bool = cfg!(any(target_os = "macos", windows, target_os = "linux"));

/// `Some(true)` while the screen is locked, `Some(false)` while it is not,
/// `None` when the platform cannot tell.
#[cfg(target_os = "macos")]
pub fn screen_locked() -> Option<bool> {
    use objc2_core_foundation::{CFString, CFType};
    use objc2_core_graphics::CGSessionCopyCurrentDictionary;

    let session = CGSessionCopyCurrentDictionary()?;
    // SAFETY: the session dictionary maps CFString keys to CF values.
    let session = unsafe { session.cast_unchecked::<CFString, CFType>() };
    Some(is_locked(session))
}

/// `Some(true)` while the screen is locked, `Some(false)` while it is not,
/// `None` when the platform cannot tell.
///
/// Asks for this process's own session (`WTS_CURRENT_SESSION`), so another
/// user's lock does not count.
#[cfg(windows)]
pub fn screen_locked() -> Option<bool> {
    use windows_sys::Win32::System::RemoteDesktop::{
        WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfoEx, WTSINFOEXW,
        WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION,
    };

    let mut buffer = std::ptr::null_mut();
    let mut bytes = 0u32;
    // SAFETY: both out-pointers point at live locals; on success `buffer`
    // is a wtsapi32 allocation of `bytes` bytes, freed below.
    let ok = unsafe {
        WTSQuerySessionInformationW(
            WTS_CURRENT_SERVER_HANDLE,
            WTS_CURRENT_SESSION,
            WTSSessionInfoEx,
            &raw mut buffer,
            &raw mut bytes,
        )
    };
    if ok == 0 || buffer.is_null() {
        return None;
    }
    let flags = if usize::try_from(bytes).is_ok_and(|n| n >= size_of::<WTSINFOEXW>()) {
        // SAFETY: the buffer holds a whole `WTSINFOEXW` (checked above);
        // `read_unaligned` makes no assumption about its alignment.
        let info = unsafe { buffer.cast::<WTSINFOEXW>().read_unaligned() };
        if info.Level == 1 {
            // SAFETY: level 1 means the union holds `WTSInfoExLevel1`.
            Some(unsafe { info.Data.WTSInfoExLevel1.SessionFlags })
        } else {
            None
        }
    } else {
        None
    };
    // SAFETY: `buffer` came from `WTSQuerySessionInformationW` and is freed
    // once; `info` above is a copy, nothing points into it any more.
    unsafe { WTSFreeMemory(buffer.cast()) };
    flags.and_then(locked_from_flags)
}

/// `SessionFlags` of `WTSINFOEX_LEVEL1_W`: lock, unlock, or unknown
/// (`WTS_SESSIONSTATE_UNKNOWN`, -1 as the field's `i32`). Windows 7 swapped
/// lock and unlock; Tauri's `WebView2` floor is Windows 10, where they are right.
#[cfg(windows)]
fn locked_from_flags(flags: i32) -> Option<bool> {
    use windows_sys::Win32::System::RemoteDesktop::{
        WTS_SESSIONSTATE_LOCK, WTS_SESSIONSTATE_UNLOCK,
    };

    match u32::try_from(flags) {
        Ok(WTS_SESSIONSTATE_LOCK) => Some(true),
        Ok(WTS_SESSIONSTATE_UNLOCK) => Some(false),
        _ => None,
    }
}

/// `Some(true)` while the screen is locked, `Some(false)` while it is not,
/// `None` when the platform cannot tell (no logind on the system bus, no
/// session).
///
/// Reads `LockedHint` of logind's `session/auto`: this process's session, or
/// the user's display session when it runs outside one. The screen locker
/// sets the hint (GNOME, KDE Plasma and others); one that never does leaves
/// it `false`, which reads as unlocked.
#[cfg(target_os = "linux")]
pub fn screen_locked() -> Option<bool> {
    use std::time::Duration;
    use zbus::blocking::{connection, proxy};
    use zbus::proxy::CacheProperties;

    let bus = connection::Builder::system()
        .ok()?
        .method_timeout(Duration::from_secs(2))
        .build()
        .ok()?;
    let session: zbus::blocking::Proxy<'_> = proxy::Builder::new(&bus)
        .destination("org.freedesktop.login1")
        .ok()?
        .path("/org/freedesktop/login1/session/auto")
        .ok()?
        .interface("org.freedesktop.login1.Session")
        .ok()?
        .cache_properties(CacheProperties::No)
        .build()
        .ok()?;
    session.get_property("LockedHint").ok()
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
pub fn screen_locked() -> Option<bool> {
    None
}

/// The key exists only while the session is locked (`1`); unlocked sessions
/// omit it. A value of an unexpected type counts as locked.
#[cfg(target_os = "macos")]
fn is_locked(
    session: &objc2_core_foundation::CFDictionary<
        objc2_core_foundation::CFString,
        objc2_core_foundation::CFType,
    >,
) -> bool {
    use objc2_core_foundation::{CFBoolean, CFNumber, CFString};

    let Some(value) = session.get(&CFString::from_str("CGSSessionScreenIsLocked")) else {
        return false;
    };
    value.downcast_ref::<CFBoolean>().map_or_else(
        || {
            value
                .downcast_ref::<CFNumber>()
                .is_none_or(|number| number.as_i64().is_none_or(|n| n != 0))
        },
        CFBoolean::as_bool,
    )
}

#[cfg(all(test, any(target_os = "macos", windows)))]
#[path = "lock_tests.rs"]
mod tests;
