//! Windows access control for the stable persona-service copy.
//!
//! `%LOCALAPPDATA%` is already per-user, but its ACL alone is not evidence
//! that the directory and the executable inside it are the ones this app
//! wrote: a reparse point (symlink or junction) planted under the app's own
//! name would redirect the replacement into a folder someone else controls,
//! and an inherited ACE could let another account replace the image that runs
//! at login. Both directories — the app-named folder and `bin` — and the
//! executable are therefore checked before they are used and given a
//! protected DACL that grants the current user alone, with nothing inherited.
//!
//! The pure parts (the SDDL, the trust decision) are tested on every
//! platform; the Win32 calls live in [`win`].

use std::path::Path;

/// The protected DACL for the persona directories and the executable: full
/// access for `sid` only, inherited by children (`OICI`), protected from
/// inherited access control entries (`P`).
///
/// Same shape as the persona pipe's
/// ([`crate::persona_pipe_security::pipe_sddl`]), but container/object
/// inherit so a directory's files keep the ACE.
#[must_use]
pub fn private_sddl(sid: &str) -> String {
    format!("D:P(A;OICI;FA;;;{sid})")
}

/// What kind of entry an install path must be.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Directory,
    File,
}

impl EntryKind {
    const fn noun(self) -> &'static str {
        match self {
            Self::Directory => "directory",
            Self::File => "file",
        }
    }
}

/// Why an existing entry is not this user's private install path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryIssue {
    /// A symlink or junction: the path leads somewhere else.
    Reparse,
    /// A file where a directory belongs, or the reverse.
    WrongKind(EntryKind),
    /// Owned by another account, so its DACL is not ours to set.
    ForeignOwner,
}

impl EntryIssue {
    /// One user-facing sentence naming the path.
    #[must_use]
    pub fn message(self, path: &Path) -> String {
        let path = path.display();
        match self {
            Self::Reparse => format!("refusing a symlinked or junction persona path: {path}"),
            Self::WrongKind(expected) => {
                format!("persona path is not a {}: {path}", expected.noun())
            }
            Self::ForeignOwner => format!("persona path is not owned by the current user: {path}"),
        }
    }
}

/// The trust decision for one existing entry.
///
/// A reparse point is rejected before its kind is considered: on Windows a
/// directory junction reports `is_dir` like a real folder, and following it
/// would hand the check to whatever it points at.
///
/// # Errors
///
/// Returns the first [`EntryIssue`] that makes the entry untrusted.
pub fn check_entry(
    expected: EntryKind,
    actual: EntryKind,
    reparse: bool,
    owner: &str,
    current_user: &str,
) -> Result<(), EntryIssue> {
    if reparse {
        return Err(EntryIssue::Reparse);
    }
    if actual != expected {
        return Err(EntryIssue::WrongKind(expected));
    }
    if !crate::persona_pipe_security::same_sid(owner, current_user) {
        return Err(EntryIssue::ForeignOwner);
    }
    Ok(())
}

#[cfg(windows)]
pub use win::{
    create_private_file, ensure_private_dir, ensure_private_file, has_private_dacl,
    is_reparse_point, owner_is_current_user,
};

#[cfg(windows)]
mod win;

#[cfg(test)]
mod tests {
    use super::{check_entry, private_sddl, EntryIssue, EntryKind};
    use std::path::Path;

    const SID: &str = "S-1-5-21-1111-2222-3333-1001";

    #[test]
    fn directory_dacl_grants_only_the_user_and_is_protected() {
        let sddl = private_sddl(SID);
        assert_eq!(sddl, format!("D:P(A;OICI;FA;;;{SID})"));
        assert!(sddl.starts_with("D:P("));
        assert!(sddl.contains(";OICI;FA;;;"));
        // Nothing for Everyone (`WD`), LocalSystem (`SY`) or anonymous (`AN`).
        assert!(!sddl.contains("SY") && !sddl.contains("WD") && !sddl.contains("AN"));
    }

    #[test]
    fn a_plain_owned_entry_is_trusted() {
        assert_eq!(
            check_entry(EntryKind::Directory, EntryKind::Directory, false, SID, SID),
            Ok(())
        );
        assert_eq!(
            check_entry(
                EntryKind::File,
                EntryKind::File,
                false,
                &SID.to_uppercase(),
                SID
            ),
            Ok(()),
            "a differently cased SID names the same account"
        );
    }

    #[test]
    fn reparse_points_are_rejected_before_their_kind() {
        // A directory junction reports itself as a directory; only the
        // reparse attribute tells it apart.
        assert_eq!(
            check_entry(EntryKind::Directory, EntryKind::Directory, true, SID, SID),
            Err(EntryIssue::Reparse)
        );
        let message = EntryIssue::Reparse.message(Path::new(r"C:\Users\u\AppData\Local\d\bin"));
        assert!(message.contains("symlink"), "{message}");
        assert!(message.contains(r"AppData\Local\d\bin"), "{message}");
    }

    #[test]
    fn the_wrong_kind_and_another_owner_are_rejected() {
        assert_eq!(
            check_entry(EntryKind::Directory, EntryKind::File, false, SID, SID),
            Err(EntryIssue::WrongKind(EntryKind::Directory))
        );
        assert_eq!(
            check_entry(EntryKind::File, EntryKind::Directory, false, SID, SID),
            Err(EntryIssue::WrongKind(EntryKind::File))
        );
        assert_eq!(
            check_entry(
                EntryKind::File,
                EntryKind::File,
                false,
                "S-1-5-21-1-2-3-1002",
                SID
            ),
            Err(EntryIssue::ForeignOwner)
        );
        let message =
            EntryIssue::ForeignOwner.message(Path::new(r"C:\Users\u\AppData\Local\d\bin\d.exe"));
        assert!(
            message.contains("not owned by the current user"),
            "{message}"
        );
    }

    #[test]
    fn issue_messages_name_the_expected_kind() {
        assert!(EntryIssue::WrongKind(EntryKind::Directory)
            .message(Path::new("x"))
            .contains("not a directory"));
        assert!(EntryIssue::WrongKind(EntryKind::File)
            .message(Path::new("x"))
            .contains("not a file"));
    }
}
