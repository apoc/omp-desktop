//! What a terminal runs: the shell (the user's setting or the default), its
//! arguments and its environment.

use std::path::{Path, PathBuf};

use portable_pty::CommandBuilder;

use crate::program_setting::typed_path;
use omp_desktop_core::child_path;
use omp_desktop_core::proc_util::is_executable_file;

/// Shells that take `-l -i` (login, interactive), by file name (Windows:
/// file stem of an `.exe`, any case).
pub(super) const LOGIN_SHELLS: [&str; 7] = ["sh", "bash", "zsh", "fish", "dash", "ksh", "nu"];
/// What the shell gets as `LANG` on macOS when the app has no locale (see
/// [`fallback_lang`]).
#[cfg(any(target_os = "macos", test))]
const FALLBACK_LANG: &str = "en_US.UTF-8";

/// The shell to run and its arguments: the user's `preference` (which must be
/// an absolute path to an executable file; empty means unset), else
/// [`default_shell`]. Only the preference is an error — it was typed on
/// purpose.
pub fn resolve_shell(preference: &str) -> Result<(PathBuf, Vec<String>), String> {
    resolve_shell_with(preference, default_shell)
}

/// [`resolve_shell`] with the default passed in, so it needs no process env
/// or user database. `default` is only called for an unset preference.
pub fn resolve_shell_with(
    preference: &str,
    default: impl FnOnce() -> PathBuf,
) -> Result<(PathBuf, Vec<String>), String> {
    let preference = typed_path(preference);
    let shell = if preference.is_empty() {
        default()
    } else {
        validate_shell(preference)?
    };
    let login = shell
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| takes_login_args(name, cfg!(windows)));
    let args = if login {
        vec!["-l".to_owned(), "-i".to_owned()]
    } else {
        Vec::new()
    };
    Ok((shell, args))
}

/// Whether the shell file `name` is one of [`LOGIN_SHELLS`]: the exact name
/// on unix; on Windows (`windows`) the stem of an `.exe`, ignoring case
/// (`bash.exe` of Git for Windows, `NU.EXE`).
fn takes_login_args(name: &str, windows: bool) -> bool {
    if !windows {
        return LOGIN_SHELLS.contains(&name);
    }
    let name = Path::new(name);
    let is_exe = name
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"));
    is_exe
        && name
            .file_stem()
            .and_then(|stem| stem.to_str())
            .is_some_and(|stem| LOGIN_SHELLS.iter().any(|s| stem.eq_ignore_ascii_case(s)))
}

/// A shell setting the user typed, already trimmed: an absolute path to an
/// executable file. An empty setting means "default" and is the caller's to
/// handle; here it is refused like any other non-path.
pub fn validate_shell(path: &str) -> Result<PathBuf, String> {
    if is_executable_file(Path::new(path)) {
        Ok(PathBuf::from(path))
    } else {
        Err(format!(
            "terminal shell {path:?} is not an absolute path to an executable file"
        ))
    }
}

/// The shell an unset setting runs, chosen in-process by `portable-pty`:
/// on unix `$SHELL` when it is executable, else the account's login shell
/// from the user database (`getpwuid`), else `/bin/sh`; on Windows
/// `%ComSpec%`, else `cmd.exe`.
///
/// The user database matters because `$SHELL` is not guaranteed in the
/// app's environment (a launch from a script, some GUI launch paths): falling
/// straight to `/bin/sh` there starts a different shell than the user's, and
/// a `~/.profile` that launches the real shell stacks two shells, so `exit`
/// lands in the outer one.
pub fn default_shell() -> PathBuf {
    PathBuf::from(CommandBuilder::new_default_prog().get_shell())
}

/// The shell's environment on top of the app's own: terminal type, the
/// desktop markers, the extended `PATH` (see `child_path`), on unix `SHELL`
/// = the program actually started (`portable-pty` would pass the app's
/// `$SHELL`, so tmux or vim's `:sh` inside a fish set under Settings would
/// start zsh), and on macOS a fallback locale.
pub fn apply_env(cmd: &mut CommandBuilder, program: &Path, session_id: &str) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("OMP_DESKTOP", "1");
    cmd.env("OMP_DESKTOP_SESSION", session_id);
    #[cfg(unix)]
    cmd.env("SHELL", program);
    #[cfg(not(unix))]
    let _ = program; // Windows shells do not read `SHELL`
    if let Some(path) = child_path::child_path() {
        cmd.env("PATH", path);
    }
    #[cfg(target_os = "macos")]
    if let Some(lang) = fallback_lang(|key| cmd.get_env(key).is_some_and(|v| !v.is_empty())) {
        cmd.env("LANG", lang);
    }
}

/// The `LANG` to give the shell when `is_set` says the app's environment
/// has none of `LANG`, `LC_ALL`, `LC_CTYPE`: [`FALLBACK_LANG`]. A macOS app
/// started from Finder or the Dock gets no locale (Terminal.app and iTerm2
/// set one themselves), and a shell without one runs in the C locale, where
/// non-ASCII input and output (`ls` of an accented file name, zsh's line
/// editor) breaks. A fixed UTF-8 locale is used rather than one derived from
/// the system's region (`defaults read -g AppleLocale`, a subprocess whose
/// value need not name an installed locale); a set variable is never
/// overridden.
#[cfg(any(target_os = "macos", test))]
fn fallback_lang(is_set: impl Fn(&str) -> bool) -> Option<&'static str> {
    let has_locale = ["LANG", "LC_ALL", "LC_CTYPE"].into_iter().any(is_set);
    (!has_locale).then_some(FALLBACK_LANG)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_locale_gets_the_utf8_fallback() {
        assert_eq!(fallback_lang(|_| false), Some("en_US.UTF-8"));
        for set in ["LANG", "LC_ALL", "LC_CTYPE"] {
            assert_eq!(fallback_lang(|key| key == set), None, "{set} is set");
        }
        assert_eq!(fallback_lang(|key| key == "LC_TIME"), Some("en_US.UTF-8"));
    }

    /// Unix matches the exact file name; Windows the stem of an `.exe`, in
    /// any case. `nu` takes `-l -i` too; PowerShell and cmd do not.
    #[test]
    fn login_args_follow_the_file_name_per_platform() {
        for name in LOGIN_SHELLS {
            assert!(takes_login_args(name, false), "{name}");
            assert!(takes_login_args(&format!("{name}.exe"), true), "{name}");
        }
        for (name, windows, expected) in [
            ("BASH.EXE", true, true),
            ("Nu.Exe", true, true),
            ("bash", true, false),
            ("bash.cmd", true, false),
            ("pwsh.exe", true, false),
            ("cmd.exe", true, false),
            ("bash.exe", false, false),
            ("Bash", false, false),
            ("pwsh", false, false),
        ] {
            assert_eq!(
                takes_login_args(name, windows),
                expected,
                "{name} {windows}"
            );
        }
    }

    #[test]
    fn a_preference_wins_and_an_empty_one_runs_the_default() {
        let default = || PathBuf::from("/the/default");
        for empty in ["", "  "] {
            assert_eq!(
                resolve_shell_with(empty, default).unwrap().0,
                default(),
                "{empty:?}"
            );
        }
        let exe = std::env::current_exe().unwrap();
        let typed = format!(" {} ", exe.display());
        let called = std::cell::Cell::new(false);
        let (shell, args) = resolve_shell_with(&typed, || {
            called.set(true);
            default()
        })
        .unwrap();
        assert_eq!(shell, exe, "trimmed preference");
        assert!(args.is_empty(), "not a login shell: {args:?}");
        assert!(
            !called.get(),
            "the default is not resolved for a preference"
        );
        // Not absolute, missing, not executable, not a file.
        for bad in [
            "sh",
            "./sh",
            "/definitely/not/a/shell",
            "/etc/hosts",
            "/bin",
        ] {
            assert!(resolve_shell_with(bad, default).is_err(), "{bad}");
        }
    }

    /// A quoted, padded preference resolves like the bare path
    /// (`typed_path`).
    #[test]
    fn a_quoted_preference_resolves() {
        let exe = std::env::current_exe().unwrap();
        let quoted = format!(" \"{}\" ", exe.display());
        assert_eq!(resolve_shell_with(&quoted, PathBuf::new).unwrap().0, exe);
    }

    #[test]
    fn the_default_shell_is_resolved_in_process() {
        let shell = default_shell();
        #[cfg(unix)]
        assert!(is_executable_file(&shell), "{}", shell.display());
        #[cfg(windows)]
        assert!(
            shell
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("cmd.exe")),
            "{}",
            shell.display()
        );
    }
}
