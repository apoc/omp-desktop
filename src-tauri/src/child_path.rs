//! The PATH a child that must find a user-installed binary (omp, `git`) is
//! spawned with: the inherited one, plus the directories the process that
//! launched us left out.
//!
//! - Unix: GUI launchers (Finder, Dock, `.desktop` files) hand a bundled app
//!   a minimal PATH, so the common install dirs are appended.
//! - Windows: after an in-app MSI update (#34) the new version is started by
//!   the installer's `LaunchApplication` custom action, which runs inside the
//!   Windows Installer service. That process gets only the *machine* PATH; the
//!   *user* PATH, where omp's installer adds `%LOCALAPPDATA%\omp`, is missing,
//!   and omp (or a per-user `git`) could not be found until the app was
//!   restarted from Explorer. The machine and user PATHs are re-read from the
//!   registry, as Explorer builds them, and appended.
//!
//! Inherited entries always come first, so a PATH set on purpose (a terminal,
//! `tauri dev`) still wins.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;

/// The PATH a child must be spawned with: the inherited PATH plus the
/// [`extra_dirs`] entries it lacks ([`merged_path`]). `None` when it can't be
/// built, so the caller keeps the inherited one. Recomputed on every call, so
/// a PATH changed while the app runs is picked up too.
pub fn child_path() -> Option<OsString> {
    let extra = extra_dirs();
    let current = std::env::var_os("PATH");
    merged_path(current.as_deref(), &extra)
}

/// Override the child command's PATH with [`child_path`]. `Command`
/// searches a PATH set on the command itself, so this is what makes the
/// added dirs effective for program lookup.
pub fn apply_child_path(cmd: &mut Command) {
    if let Some(path) = child_path() {
        cmd.env("PATH", path);
    }
}

/// The first file called `name` in the merged child PATH (inherited entries
/// first, then [`extra_dirs`]), the lookup `Command` would do for a child
/// spawned through [`apply_child_path`]. `None` when there is none. Only
/// Linux browser discovery calls it; macOS finds browsers by app path.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn search_path(name: &str) -> Option<PathBuf> {
    let merged = merged_path(std::env::var_os("PATH").as_deref(), &extra_dirs())?;
    find_in(&merged, name)
}

/// The first `dir/name` that is an executable file, over the entries of
/// `path`; a non-executable file of that name does not shadow a later one.
#[cfg(all(unix, any(test, not(target_os = "macos"))))]
fn find_in(path: &OsStr, name: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    std::env::split_paths(path)
        .map(|dir| dir.join(name))
        .find(|candidate| {
            candidate
                .metadata()
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
}

/// Install dirs a Finder-launched `.app` (PATH `/usr/bin:/bin:/usr/sbin:/sbin`)
/// or a `.desktop` launch lacks, while `tauri dev` inherits the terminal's.
#[cfg(not(windows))]
const EXTRA_PATH_DIRS: &[&str] = &[
    "/opt/homebrew/bin", // Apple-silicon Homebrew
    "/opt/homebrew/sbin",
    "/usr/local/bin", // Intel Homebrew / manual installs
    "/usr/local/sbin",
];

#[cfg(not(windows))]
fn extra_dirs() -> Vec<String> {
    launcher_dirs(std::env::var("HOME").ok().as_deref())
}

/// [`EXTRA_PATH_DIRS`] plus the per-user dirs under `home`. Pure over `home`
/// so it is testable without touching the process environment.
#[cfg(not(windows))]
fn launcher_dirs(home: Option<&str>) -> Vec<String> {
    let home = home.filter(|h| !h.is_empty());
    EXTRA_PATH_DIRS
        .iter()
        .copied()
        .map(String::from)
        .chain(
            home.into_iter()
                .flat_map(|h| [format!("{h}/.local/bin"), format!("{h}/.cargo/bin")]),
        )
        .collect()
}

#[cfg(windows)]
fn extra_dirs() -> Vec<String> {
    // Machine first, then user: the order Explorer builds a logon PATH in.
    [
        registry_path(
            windows_registry::LOCAL_MACHINE,
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        ),
        registry_path(windows_registry::CURRENT_USER, "Environment"),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// The `Path` value under `root\subkey`, expanded when stored as
/// `REG_EXPAND_SZ` (the user PATH usually is: `%LOCALAPPDATA%\omp`) against
/// this process' variables, which the installer-launched process does carry;
/// `None` when absent or unreadable.
#[cfg(windows)]
fn registry_path(root: &windows_registry::Key, subkey: &str) -> Option<String> {
    let value = root.open(subkey).ok()?.get_value("Path").ok()?;
    let expand = value.ty() == windows_registry::Type::ExpandString;
    let raw = String::try_from(value).ok()?;
    Some(if expand {
        expand_env_refs(&raw, |name| std::env::var(name).ok())
    } else {
        raw
    })
}

/// Replace every `%NAME%` in `raw` with `lookup(NAME)` (`std::env::var` is
/// case-insensitive on Windows). An undefined or empty name and an unmatched
/// `%` stay literal, as with `ExpandEnvironmentStrings`. Pure over `lookup`
/// so it is testable without touching the process environment.
#[cfg(windows)]
fn expand_env_refs(raw: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some((before, after)) = rest.split_once('%') {
        let Some((name, tail)) = after.split_once('%') else {
            break;
        };
        out.push_str(before);
        let value = if name.is_empty() { None } else { lookup(name) };
        if let Some(value) = value {
            out.push_str(&value);
        } else {
            out.push('%');
            out.push_str(name);
            out.push('%');
        }
        rest = tail;
    }
    out.push_str(rest);
    out
}

/// `current`'s entries, in order, followed by every entry of the `extra`
/// PATH lists that `current` (or an earlier list) doesn't already hold, as
/// compared by [`path_key`]. `None` when the result can't be joined into a
/// PATH (an entry containing the separator, or `"` on Windows), so the
/// caller keeps the inherited one.
fn merged_path(current: Option<&OsStr>, extra: &[impl AsRef<OsStr>]) -> Option<OsString> {
    let mut dirs: Vec<PathBuf> =
        current.map_or_else(Vec::new, |c| std::env::split_paths(c).collect());
    let mut seen: std::collections::HashSet<String> = dirs.iter().map(|d| path_key(d)).collect();
    for dir in extra.iter().flat_map(std::env::split_paths) {
        if !dir.as_os_str().is_empty() && seen.insert(path_key(&dir)) {
            dirs.push(dir);
        }
    }
    std::env::join_paths(dirs).ok()
}

/// Windows paths compare case-insensitively and regardless of separator
/// style or a trailing separator.
#[cfg(windows)]
fn path_key(dir: &Path) -> String {
    dir.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

#[cfg(not(windows))]
fn path_key(dir: &Path) -> String {
    dir.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::merged_path;

    fn entries(path: &std::ffi::OsStr) -> Vec<String> {
        std::env::split_paths(path)
            .map(|d| d.to_string_lossy().into_owned())
            .collect()
    }

    #[cfg(not(windows))]
    fn with_launcher_dirs(current: Option<&str>) -> Vec<String> {
        let extra = super::launcher_dirs(None);
        let merged = merged_path(current.map(std::ffi::OsStr::new), &extra);
        entries(&merged.unwrap())
    }

    #[cfg(not(windows))]
    #[test]
    fn merged_path_appends_homebrew_when_missing() {
        // The Finder/Dock minimal PATH lacks Homebrew — the reported bug.
        let dirs = with_launcher_dirs(Some("/usr/bin:/bin:/usr/sbin:/sbin"));
        let at = |dir: &str| dirs.iter().position(|d| d == dir);
        assert!(
            at("/usr/bin").is_some(),
            "inherited entries preserved: {dirs:?}"
        );
        assert!(
            at("/opt/homebrew/bin").is_some(),
            "homebrew appended: {dirs:?}"
        );
        // Inherited entries must come before the appended ones.
        assert!(
            at("/usr/bin") < at("/opt/homebrew/bin"),
            "inherited PATH must precede extra dirs: {dirs:?}"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn merged_path_dedupes_existing_extra_dir() {
        // A user who already has /opt/homebrew/bin must not get it twice.
        let dirs = with_launcher_dirs(Some("/opt/homebrew/bin:/usr/bin"));
        let count = dirs.iter().filter(|d| *d == "/opt/homebrew/bin").count();
        assert_eq!(count, 1, "no duplicate homebrew entry: {dirs:?}");
    }

    #[cfg(not(windows))]
    #[test]
    fn launcher_dirs_include_home_relative_dirs() {
        let dirs = super::launcher_dirs(Some("/home/dev"));
        assert!(dirs.iter().any(|d| d == "/home/dev/.local/bin"), "{dirs:?}");
        assert!(dirs.iter().any(|d| d == "/home/dev/.cargo/bin"), "{dirs:?}");
        assert_eq!(super::launcher_dirs(Some("")), super::launcher_dirs(None));
    }

    #[cfg(not(windows))]
    #[test]
    fn merged_path_handles_absent_inherited_path() {
        // No PATH in the environment at all — still yields the extra dirs.
        let dirs = with_launcher_dirs(None);
        assert!(dirs.iter().any(|d| d == "/opt/homebrew/bin"), "{dirs:?}");
    }

    #[cfg(windows)]
    #[test]
    fn merged_path_restores_user_entries_missing_after_msi_relaunch() {
        // #34: the installer-launched app inherits the machine PATH only.
        let machine = r"C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd";
        let user = r"C:\Users\me\AppData\Local\omp;C:\Users\me\.bun\bin";
        let merged = merged_path(Some(machine.as_ref()), &[machine, user]).unwrap();
        assert_eq!(
            entries(&merged),
            [
                r"C:\WINDOWS\system32",
                r"C:\WINDOWS",
                r"C:\Program Files\Git\cmd",
                r"C:\Users\me\AppData\Local\omp",
                r"C:\Users\me\.bun\bin",
            ]
        );
    }

    #[cfg(windows)]
    #[test]
    fn merged_path_keeps_inherited_order_and_skips_spelling_variants() {
        // A terminal-launched app already has everything: nothing is added,
        // nothing reordered, even when the registry spells entries
        // differently (case, separator style, trailing separator) or leaves
        // empty entries.
        let inherited = r"C:\tools\omp;C:\WINDOWS\system32";
        let registry = r"c:\windows\SYSTEM32\;;C:/Tools/OMP/";
        let merged = merged_path(Some(inherited.as_ref()), &[registry]).unwrap();
        assert_eq!(entries(&merged), [r"C:\tools\omp", r"C:\WINDOWS\system32"]);
    }

    #[cfg(windows)]
    #[test]
    fn merged_path_without_inherited_path_uses_registry() {
        let merged = merged_path(None, &[r"C:\WINDOWS", r"C:\Users\me\AppData\Local\omp"]).unwrap();
        assert_eq!(
            entries(&merged),
            [r"C:\WINDOWS", r"C:\Users\me\AppData\Local\omp"]
        );
    }

    #[cfg(windows)]
    #[test]
    fn expand_env_refs_substitutes_defined_names_only() {
        let lookup = |name: &str| {
            name.eq_ignore_ascii_case("LOCALAPPDATA")
                .then(|| r"C:\Users\me\AppData\Local".to_string())
        };
        let expand = |raw| super::expand_env_refs(raw, lookup);
        assert_eq!(
            expand(r"%LOCALAPPDATA%\omp"),
            r"C:\Users\me\AppData\Local\omp"
        );
        assert_eq!(
            expand(r"%localappdata%\a;%LOCALAPPDATA%\b"),
            r"C:\Users\me\AppData\Local\a;C:\Users\me\AppData\Local\b"
        );
        // Undefined and empty names, and an unmatched `%`, stay literal.
        assert_eq!(expand(r"%NOPE%\bin"), r"%NOPE%\bin");
        assert_eq!(expand(r"a%%b"), r"a%%b");
        assert_eq!(expand(r"C:\100%\bin"), r"C:\100%\bin");
        assert_eq!(
            expand(r"%NOPE%%LOCALAPPDATA%"),
            r"%NOPE%C:\Users\me\AppData\Local"
        );
    }

    #[cfg(unix)]
    fn write_file(path: &std::path::Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, "").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn find_in_returns_the_first_dir_holding_the_file() {
        let root = std::env::temp_dir().join(format!("omp-child-path-{}", std::process::id()));
        let (first, second) = (root.join("a"), root.join("b"));
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        write_file(&second.join("tool"), 0o755);
        let path = std::env::join_paths([&first, &second]).unwrap();
        assert_eq!(super::find_in(&path, "tool"), Some(second.join("tool")));
        write_file(&first.join("tool"), 0o755);
        assert_eq!(super::find_in(&path, "tool"), Some(first.join("tool")));
        assert_eq!(super::find_in(&path, "no-such-tool"), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn find_in_skips_a_non_executable_file_for_a_later_executable_one() {
        let root = std::env::temp_dir().join(format!("omp-child-path-exec-{}", std::process::id()));
        let (first, second) = (root.join("a"), root.join("b"));
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        write_file(&first.join("tool"), 0o644);
        write_file(&second.join("tool"), 0o755);
        let path = std::env::join_paths([&first, &second]).unwrap();
        assert_eq!(super::find_in(&path, "tool"), Some(second.join("tool")));
        // Only a non-executable file: nothing found.
        std::fs::remove_file(second.join("tool")).unwrap();
        assert_eq!(super::find_in(&path, "tool"), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn search_path_finds_a_system_binary() {
        assert!(super::search_path("sh").is_some());
        assert!(super::search_path("omp-no-such-binary").is_none());
    }
}
