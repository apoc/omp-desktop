//! Whether the desktop session is locked, for "push only while locked".

/// Whether [`screen_locked`] can answer on this platform.
pub const DETECTION: bool = cfg!(target_os = "macos");

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

#[cfg(not(target_os = "macos"))]
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

#[cfg(all(test, target_os = "macos"))]
#[path = "lock_tests.rs"]
mod tests;
