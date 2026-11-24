//! The shells Settings → Terminal offers: a fixed list per platform, trimmed
//! to the ones installed here (an executable file where the list looks).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[cfg(not(windows))]
use super::shell;
use omp_desktop_core::child_path;

/// One shell the menu offers: a short name and the program it starts.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ShellChoice {
    pub name: &'static str,
    pub path: String,
}

/// Where a shell is looked for: `fixed` locations (a folder from an
/// environment variable, then a path under it) first, then the folders of
/// `PATH` for the file `on_path`.
struct Candidate {
    name: &'static str,
    fixed: &'static [(&'static str, &'static str)],
    on_path: Option<&'static str>,
}

#[cfg(windows)]
const CANDIDATES: &[Candidate] = &[
    Candidate {
        name: "cmd",
        fixed: &[("SystemRoot", r"System32\cmd.exe")],
        on_path: None,
    },
    Candidate {
        name: "powershell",
        fixed: &[(
            "SystemRoot",
            r"System32\WindowsPowerShell\v1.0\powershell.exe",
        )],
        on_path: None,
    },
    Candidate {
        name: "pwsh",
        fixed: &[("ProgramFiles", r"PowerShell\7\pwsh.exe")],
        on_path: Some("pwsh.exe"),
    },
    // Git for Windows' `bin\bash.exe`, which sets up the environment for its
    // `usr\bin\bash.exe`. Never `bash.exe` from `PATH`: `System32\bash.exe`
    // is the WSL launcher.
    Candidate {
        name: "bash",
        fixed: &[
            ("ProgramFiles", r"Git\bin\bash.exe"),
            ("LOCALAPPDATA", r"Programs\Git\bin\bash.exe"),
        ],
        on_path: None,
    },
    Candidate {
        name: "nu",
        fixed: &[],
        on_path: Some("nu.exe"),
    },
];

/// A unix candidate: one of the shells `shell::LOGIN_SHELLS` starts as login
/// shells (the whole unix list), found on `PATH` like the shell itself would
/// find it.
#[cfg(not(windows))]
const fn on_path(name: &'static str) -> Candidate {
    Candidate {
        name,
        fixed: &[],
        on_path: Some(name),
    }
}

/// The installed shells, in the list's order. Looks on the extended `PATH`
/// the terminal itself gets (`child_path`; the inherited one when that can't
/// be built, as `shell::apply_env` keeps it). Blocking filesystem checks:
/// call off the IPC thread.
pub fn available() -> Vec<ShellChoice> {
    let dirs = child_path::child_path_dirs();
    #[cfg(windows)]
    let candidates = CANDIDATES;
    #[cfg(not(windows))]
    let candidates = &shell::LOGIN_SHELLS.map(on_path);
    available_with(
        candidates,
        |var| std::env::var_os(var),
        &dirs,
        omp_desktop_core::proc_util::is_executable_file,
    )
}

/// [`available`] over a given list, environment, absolute `PATH` folders
/// and "is this a runnable shell" check. A path that is not UTF-8 is
/// skipped (the setting is a string).
fn available_with(
    candidates: &[Candidate],
    env: impl Fn(&str) -> Option<OsString>,
    dirs: &[PathBuf],
    usable: impl Fn(&Path) -> bool,
) -> Vec<ShellChoice> {
    candidates
        .iter()
        .filter_map(|candidate| {
            let fixed = candidate
                .fixed
                .iter()
                .filter_map(|&(var, rel)| env(var).map(|root| Path::new(&root).join(rel)));
            let on_path = candidate
                .on_path
                .into_iter()
                .flat_map(|file| dirs.iter().map(move |dir| dir.join(file)));
            let path = fixed
                .chain(on_path)
                .filter_map(|path| path.into_os_string().into_string().ok())
                .find(|path| usable(Path::new(path)))?;
            Some(ShellChoice {
                name: candidate.name,
                path,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An absolute folder on this platform.
    fn root(name: &str) -> PathBuf {
        let base = if cfg!(windows) { r"C:\" } else { "/" };
        Path::new(base).join(name)
    }

    const LIST: &[Candidate] = &[
        Candidate {
            name: "one",
            fixed: &[("ONE_HOME", "bin/one")],
            on_path: Some("one"),
        },
        Candidate {
            name: "two",
            fixed: &[],
            on_path: Some("two"),
        },
        Candidate {
            name: "three",
            fixed: &[("MISSING", "three")],
            on_path: None,
        },
    ];

    fn env(var: &str) -> Option<OsString> {
        (var == "ONE_HOME").then(|| root("opt").into_os_string())
    }

    #[test]
    fn only_installed_shells_are_offered_in_list_order() {
        let dirs = [root("usr"), root("bin")];
        let installed = [root("bin").join("two"), root("opt").join("bin/one")];
        let found = available_with(LIST, env, &dirs, |p| installed.iter().any(|i| i == p));
        assert_eq!(
            found,
            [
                ShellChoice {
                    name: "one",
                    path: root("opt").join("bin/one").display().to_string(),
                },
                ShellChoice {
                    name: "two",
                    path: root("bin").join("two").display().to_string(),
                },
            ]
        );
    }

    #[test]
    fn a_fixed_location_wins_over_path_and_path_goes_in_order() {
        let dirs = [root("first"), root("second")];
        let found = available_with(LIST, env, &dirs, |_| true);
        // Everything "exists": `one` at its fixed place, `two` in the first
        // PATH folder, `three` nowhere (its variable is unset, no PATH name).
        assert_eq!(found.len(), 2);
        assert_eq!(
            found[0].path,
            root("opt").join("bin/one").display().to_string()
        );
        assert_eq!(
            found[1].path,
            root("first").join("two").display().to_string()
        );
    }

    /// `System32\bash.exe` is the WSL launcher, not Git Bash.
    #[cfg(windows)]
    #[test]
    fn bash_never_comes_from_path_on_windows() {
        let dirs = [PathBuf::from(r"C:\Windows\System32")];
        let found = available_with(CANDIDATES, |_| None, &dirs, |_| true);
        assert!(found.iter().all(|c| c.name != "bash"), "{found:?}");
    }

    /// A non-UTF-8 folder holding the shell is passed over for a later one.
    #[cfg(unix)]
    #[test]
    fn a_non_utf8_location_is_skipped_not_the_shell() {
        use std::os::unix::ffi::OsStrExt;
        let odd = PathBuf::from(std::ffi::OsStr::from_bytes(b"/opt/\xff"));
        let dirs = [odd, root("bin")];
        let found = available_with(&LIST[1..2], |_| None, &dirs, |_| true);
        assert_eq!(found[0].path, root("bin").join("two").display().to_string());
    }

    /// This machine's list: what every supported OS ships.
    #[test]
    fn the_system_shells_are_found() {
        let names: Vec<&str> = available().iter().map(|c| c.name).collect();
        let wanted: &[&str] = if cfg!(windows) {
            &["cmd", "powershell"]
        } else {
            &["sh"]
        };
        for name in wanted {
            assert!(names.contains(name), "{names:?}");
        }
    }
}
