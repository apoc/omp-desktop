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
//! The owner check accepts both SIDs a token stamps on the objects it
//! creates: its user (`TokenUser`) and its default owner (`TokenOwner`). An
//! elevated token's default owner is `BUILTIN\Administrators`, so an
//! administrator's own install is not mistaken for a stranger's — while an
//! owner that is neither SID still is.
//!
//! The pure parts (the SDDL, the trust decision) are tested on every
//! platform; the Win32 calls live in [`win`].

use crate::persona_pipe_security::same_sid;
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

/// The owner SIDs an entry this app created may carry.
///
/// Windows gives a new object the owner of the token that created it: the
/// token's user (`TokenUser`) for an ordinary process, its default owner
/// (`TokenOwner`, `BUILTIN\Administrators`) for an elevated one. Both are
/// this process's own doing. A token can only stamp its own two SIDs on what
/// it creates, and another account cannot set an object's owner to one of
/// them without privileges that already let it rewrite the object — so only
/// a third SID means the entry belongs to someone else.
#[derive(Clone, Copy, Debug)]
pub struct TokenOwners<'a> {
    /// `TokenUser`: the account this process runs as.
    pub user: &'a str,
    /// `TokenOwner`: the default owner this token gives new objects.
    pub default_owner: &'a str,
}

impl TokenOwners<'_> {
    /// Whether `owner` is one of the two SIDs this token creates objects
    /// with.
    #[must_use]
    pub fn accepts(self, owner: &str) -> bool {
        same_sid(owner, self.user) || same_sid(owner, self.default_owner)
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
    owners: TokenOwners<'_>,
) -> Result<(), EntryIssue> {
    if reparse {
        return Err(EntryIssue::Reparse);
    }
    if actual != expected {
        return Err(EntryIssue::WrongKind(expected));
    }
    if !owners.accepts(owner) {
        return Err(EntryIssue::ForeignOwner);
    }
    Ok(())
}

#[cfg(windows)]
pub use win::{
    create_private_file, ensure_private_dir, ensure_private_file, has_private_dacl,
    is_reparse_point, owner_is_ours,
};

#[cfg(windows)]
mod win;

#[cfg(test)]
mod tests {
    use super::{check_entry, private_sddl, EntryIssue, EntryKind, TokenOwners};
    use std::path::Path;

    const SID: &str = "S-1-5-21-1111-2222-3333-1001";

    /// What `BUILTIN\Administrators` is: the default owner an elevated token
    /// gives new objects.
    const ADMIN: &str = "S-1-5-32-544";

    /// Both SIDs are the user's own: an ordinary, non-elevated token.
    const fn user_only() -> TokenOwners<'static> {
        TokenOwners {
            user: SID,
            default_owner: SID,
        }
    }

    /// An elevated token: user SID plus the Administrators default owner.
    const fn elevated() -> TokenOwners<'static> {
        TokenOwners {
            user: SID,
            default_owner: ADMIN,
        }
    }

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
            check_entry(
                EntryKind::Directory,
                EntryKind::Directory,
                false,
                SID,
                user_only()
            ),
            Ok(())
        );
        assert_eq!(
            check_entry(
                EntryKind::File,
                EntryKind::File,
                false,
                &SID.to_uppercase(),
                user_only()
            ),
            Ok(()),
            "a differently cased SID names the same account"
        );
    }

    #[test]
    fn the_tokens_default_owner_is_trusted_like_the_user() {
        // The identity decision on its own, on every platform.
        assert!(elevated().accepts(SID), "the token's own user");
        assert!(
            elevated().accepts(ADMIN),
            "an elevated token's default owner"
        );
        assert!(
            elevated().accepts(&ADMIN.to_lowercase()),
            "SIDs compare case-insensitively"
        );
        assert!(elevated().accepts(&format!(" {ADMIN} ")));
        assert!(!elevated().accepts("S-1-5-21-1-2-3-1002"));
        assert!(
            !elevated().accepts("S-1-5-18"),
            "LocalSystem is neither this token's user nor its default owner"
        );
        // And through the entry check, which is what the Win32 half calls.
        for expected in [EntryKind::Directory, EntryKind::File] {
            assert_eq!(
                check_entry(expected, expected, false, ADMIN, elevated()),
                Ok(())
            );
            assert_eq!(
                check_entry(expected, expected, false, SID, elevated()),
                Ok(())
            );
            assert_eq!(
                check_entry(expected, expected, false, "S-1-5-18", elevated()),
                Err(EntryIssue::ForeignOwner)
            );
        }
    }

    #[test]
    fn reparse_points_are_rejected_before_their_kind() {
        // A directory junction reports itself as a directory; only the
        // reparse attribute tells it apart.
        assert_eq!(
            check_entry(
                EntryKind::Directory,
                EntryKind::Directory,
                true,
                SID,
                user_only()
            ),
            Err(EntryIssue::Reparse)
        );
        let message = EntryIssue::Reparse.message(Path::new(r"C:\Users\u\AppData\Local\d\bin"));
        assert!(message.contains("symlink"), "{message}");
        assert!(message.contains(r"AppData\Local\d\bin"), "{message}");
    }

    #[test]
    fn the_wrong_kind_and_another_owner_are_rejected() {
        assert_eq!(
            check_entry(
                EntryKind::Directory,
                EntryKind::File,
                false,
                SID,
                user_only()
            ),
            Err(EntryIssue::WrongKind(EntryKind::Directory))
        );
        assert_eq!(
            check_entry(
                EntryKind::File,
                EntryKind::Directory,
                false,
                SID,
                user_only()
            ),
            Err(EntryIssue::WrongKind(EntryKind::File))
        );
        assert_eq!(
            check_entry(
                EntryKind::File,
                EntryKind::File,
                false,
                "S-1-5-21-1-2-3-1002",
                elevated()
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
