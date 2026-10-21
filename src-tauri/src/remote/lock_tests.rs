use super::*;

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use objc2_core_foundation::{CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType};

    fn session_with(value: Option<&CFType>) -> bool {
        let key = CFString::from_str("CGSSessionScreenIsLocked");
        let other = CFString::from_str("kCGSSessionUserIDKey");
        let id = CFNumber::new_i32(501);
        let id: &CFType = &id;
        let dictionary: CFRetained<CFDictionary<CFString, CFType>> = value.map_or_else(
            || CFDictionary::from_slices(&[&*other], &[id]),
            |value| CFDictionary::from_slices(&[&*other, &*key], &[id, value]),
        );
        is_locked(&dictionary)
    }

    #[test]
    fn an_absent_key_means_unlocked() {
        assert!(!session_with(None));
    }

    #[test]
    fn a_truthy_key_means_locked() {
        let one = CFNumber::new_i32(1);
        assert!(session_with(Some(&one)));
        assert!(session_with(Some(CFBoolean::new(true))));
    }

    #[test]
    fn a_falsy_key_means_unlocked() {
        let zero = CFNumber::new_i32(0);
        assert!(!session_with(Some(&zero)));
        assert!(!session_with(Some(CFBoolean::new(false))));
    }
}

#[cfg(windows)]
mod windows {
    use super::*;

    #[test]
    fn session_flags_map_lock_unlock_and_unknown() {
        assert_eq!(locked_from_flags(0), Some(true));
        assert_eq!(locked_from_flags(1), Some(false));
        // WTS_SESSIONSTATE_UNKNOWN is 0xFFFFFFFF, read as -1 from the i32 field.
        assert_eq!(locked_from_flags(-1), None);
        assert_eq!(locked_from_flags(2), None);
    }
}
