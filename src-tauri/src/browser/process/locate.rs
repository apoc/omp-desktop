//! Automatic Chromium discovery: the candidate binaries per platform, best
//! first, and which of them are usable here.
//!
//! On Linux the real browser binaries come first. The PATH names
//! (`google-chrome`, `chromium`, …) are distro launchers that inject the
//! user's own flag files (`chrome-flags.conf`, `/etc/chromium.d`, …:
//! extensions, proxies) into what must be a throwaway browser, so they are
//! a last resort. Chrome for Testing (omp's puppeteer download) comes after
//! the installed browsers there: Ubuntu 23.10+ refuses it a sandbox, and
//! the desktop keeps the sandbox on. Elsewhere it is unbranded and wrapper
//! free, so it goes first.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use omp_desktop_core::proc_util::is_executable_file;

/// The platform a candidate list is built for. A parameter rather than
/// `cfg`, so every platform's order is testable on any host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Linux,
    MacArm,
    MacX64,
    Windows,
}

impl Platform {
    /// The platform this build runs on.
    pub fn current() -> Self {
        match (std::env::consts::OS, std::env::consts::ARCH) {
            ("macos", "aarch64") => Self::MacArm,
            ("macos", _) => Self::MacX64,
            ("windows", _) => Self::Windows,
            _ => Self::Linux,
        }
    }

    /// Directory-name prefixes (before the `-<version>`) puppeteer uses for
    /// this platform. A cached build for another platform is no use here and
    /// must not outrank a native browser.
    const fn cft_prefixes(self) -> &'static [&'static str] {
        match self {
            Self::Linux => &["linux"],
            Self::MacArm => &["mac_arm"],
            Self::MacX64 => &["mac", "mac_x64"],
            Self::Windows => &["win64", "win32"],
        }
    }

    /// The browser binary inside one `<platform>-<version>` Chrome for
    /// Testing directory.
    const fn cft_layout(self) -> &'static str {
        match self {
            Self::Linux => "chrome-linux64/chrome",
            Self::MacArm => {
                "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
            }
            Self::MacX64 => {
                "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
            }
            Self::Windows => "chrome-win64/chrome.exe",
        }
    }
}

/// Where discovery looks. [`Places::current`] in production; tests point
/// every field into a temp dir.
pub struct Places {
    /// Prefix of the fixed install paths (`/` in production on unix).
    pub root: PathBuf,
    /// The user's home; `None` when it cannot be resolved, and then nothing
    /// is looked for under it (never a shared fallback like the temp dir:
    /// another account could plant the browser this one runs).
    pub home: Option<PathBuf>,
    /// `$XDG_CACHE_HOME`: omp keeps its puppeteer cache in
    /// `$XDG_CACHE_HOME/omp/puppeteer` once that `omp` dir exists (Linux,
    /// macOS), else in `~/.omp/puppeteer`.
    pub xdg_cache: Option<PathBuf>,
    /// The child PATH's absolute directories, in lookup order (the Linux
    /// launchers).
    pub path: Vec<PathBuf>,
    /// Windows install roots, best first: `%ProgramFiles%`,
    /// `%ProgramFiles(x86)%`, `%LOCALAPPDATA%` (per-user installs).
    pub install_roots: Vec<PathBuf>,
}

impl Places {
    /// The running system, with `home` the user's home folder if known.
    pub fn current(home: Option<&Path>) -> Self {
        let var = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty());
        Self {
            root: PathBuf::from("/"),
            home: home.map(Path::to_path_buf),
            xdg_cache: var("XDG_CACHE_HOME").map(PathBuf::from),
            path: omp_desktop_core::child_path::child_path_dirs(),
            install_roots: ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
                .into_iter()
                .filter_map(var)
                .map(PathBuf::from)
                .collect(),
        }
    }
}

/// Linux browser binaries that are not wrapper scripts, by package layout.
const LINUX_BINARIES: &[&str] = &[
    "opt/google/chrome/chrome",
    "usr/lib/chromium/chromium",                   // Arch, Debian
    "usr/lib/chromium-browser/chromium-browser",   // older Ubuntu, Mint
    "usr/lib64/chromium-browser/chromium-browser", // Fedora
    "usr/lib64/chromium/chromium",                 // openSUSE
    "opt/google/chrome-beta/chrome",
    "opt/google/chrome-unstable/chrome",
    "opt/microsoft/msedge/msedge",
    "opt/brave.com/brave/brave",
];

/// Linux launcher names on PATH; last resort (see the module doc).
const LINUX_LAUNCHERS: &[&str] = &[
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "brave-browser",
];

/// macOS app bundles, under `/Applications` and `~/Applications`.
const MAC_APPS: &[&str] = &[
    "Google Chrome.app/Contents/MacOS/Google Chrome",
    "Chromium.app/Contents/MacOS/Chromium",
    "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "Brave Browser.app/Contents/MacOS/Brave Browser",
    "Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
];

/// Windows installs, under each of [`Places::install_roots`].
const WINDOWS_INSTALLS: &[&str] = &[
    r"Google\Chrome\Application\chrome.exe",
    r"Microsoft\Edge\Application\msedge.exe",
    r"BraveSoftware\Brave-Browser\Application\brave.exe",
    r"Chromium\Application\chrome.exe",
    r"Google\Chrome Beta\Application\chrome.exe",
];

/// Every candidate path for `platform`, best first. Existence is not
/// checked here, except that Chrome for Testing builds are listed from the
/// cache directories, newest version first.
pub fn candidates(platform: Platform, places: &Places) -> Vec<PathBuf> {
    let cft_roots = {
        let xdg = places
            .xdg_cache
            .as_ref()
            .filter(|_| platform != Platform::Windows)
            .map(|cache| cache.join("omp"))
            .filter(|omp| omp.is_dir());
        let mut roots: Vec<PathBuf> = xdg
            .into_iter()
            .map(|omp| omp.join("puppeteer/chrome"))
            .collect();
        roots.extend(
            places
                .home
                .iter()
                .map(|home| home.join(".omp/puppeteer/chrome")),
        );
        roots
    };
    let cft = || {
        cft_roots
            .iter()
            .flat_map(|root| chrome_for_testing(platform, root))
            .collect::<Vec<_>>()
    };
    match platform {
        Platform::Linux => {
            let mut out: Vec<PathBuf> = LINUX_BINARIES
                .iter()
                .map(|rel| places.root.join(rel))
                .collect();
            out.extend(cft());
            out.extend(
                LINUX_LAUNCHERS
                    .iter()
                    .flat_map(|name| places.path.iter().map(move |dir| dir.join(name))),
            );
            out
        }
        Platform::MacArm | Platform::MacX64 => {
            let mut out = cft();
            let user_apps = places.home.iter().map(|home| home.join("Applications"));
            for apps in std::iter::once(places.root.join("Applications")).chain(user_apps) {
                out.extend(MAC_APPS.iter().map(|rel| apps.join(rel)));
            }
            out
        }
        Platform::Windows => {
            let mut out = cft();
            out.extend(
                WINDOWS_INSTALLS
                    .iter()
                    .flat_map(|rel| places.install_roots.iter().map(move |root| root.join(rel))),
            );
            out
        }
    }
}

/// What discovery found: the usable binaries, best first, and the ones it
/// passed over because they cannot work here (with why).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Found {
    pub binaries: Vec<PathBuf>,
    pub skipped: Vec<(PathBuf, &'static str)>,
}

/// Why a snap browser is passed over.
pub const SNAP_REASON: &str =
    "a snap package; snap confinement keeps it out of the hidden cache folder its profile lives in";

/// The executable candidates for `platform`, each file once, minus snap
/// packages (Linux).
pub fn discover(platform: Platform, places: &Places) -> Found {
    let mut found = Found::default();
    let mut seen: Vec<PathBuf> = Vec::new();
    for candidate in candidates(platform, places) {
        if !is_executable_file(&candidate) {
            continue;
        }
        // One file reached through several names (a launcher symlinked to
        // the binary) is tried once.
        let real = std::fs::canonicalize(&candidate).unwrap_or_else(|_| candidate.clone());
        if seen.contains(&real) {
            continue;
        }
        if platform == Platform::Linux && is_snap(&candidate, &real, &places.root) {
            found.skipped.push((candidate, SNAP_REASON));
        } else {
            found.binaries.push(candidate);
        }
        seen.push(real);
    }
    found
}

/// Whether `path` (resolving to `real`) starts a snap package: it resolves
/// into `/snap/` or to `snap` itself (`/snap/bin/chromium` →
/// `/usr/bin/snap`), or it is a small script that execs one (Ubuntu's
/// `/usr/bin/chromium-browser`).
fn is_snap(path: &Path, real: &Path, root: &Path) -> bool {
    /// A launcher script is a few KiB; a real binary starts with no `#!`.
    const SCRIPT_CAP: u64 = 16 * 1024;
    if real.starts_with(root.join("snap")) || real.file_name().is_some_and(|name| name == "snap") {
        return true;
    }
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut head = Vec::new();
    let loaded = std::io::Read::read_to_end(&mut std::io::Read::take(file, SCRIPT_CAP), &mut head);
    loaded.is_ok()
        && head.starts_with(b"#!")
        && head.windows(b"/snap/".len()).any(|w| w == b"/snap/")
}

/// The numeric version of a `<platform>-<version>` directory name:
/// `"mac_arm-150.0.7871.24"` → `[150, 0, 7871, 24]`.
fn version_of(dir_name: &str) -> Option<Vec<u32>> {
    let (_, version) = dir_name.split_once('-')?;
    version.split('.').map(|part| part.parse().ok()).collect()
}

/// The Chrome for Testing binaries under `root` built for `platform`,
/// newest version first.
fn chrome_for_testing(platform: Platform, root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut found: Vec<(Vec<u32>, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let name: OsString = entry.file_name();
            let name = name.to_str()?;
            let (prefix, _) = name.split_once('-')?;
            if !platform.cft_prefixes().contains(&prefix) {
                return None;
            }
            let bin = entry.path().join(platform.cft_layout());
            if !bin.is_file() {
                return None;
            }
            Some((version_of(name)?, bin))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, bin)| bin).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::tests::tempdir;
    use crate::test_support::executable;

    fn places(dir: &Path) -> Places {
        Places {
            root: dir.join("root"),
            home: Some(dir.join("home")),
            xdg_cache: Some(dir.join("cache")),
            path: vec![dir.join("bin")],
            install_roots: vec![dir.join("pf"), dir.join("pf86"), dir.join("local")],
        }
    }

    #[test]
    fn version_parses_platform_dirs() {
        assert_eq!(
            version_of("mac_arm-150.0.7871.24"),
            Some(vec![150, 0, 7871, 24])
        );
        assert_eq!(
            version_of("linux-131.0.6778.85"),
            Some(vec![131, 0, 6778, 85])
        );
        assert_eq!(version_of("nonsense"), None);
    }

    /// F1: the real binaries come before Chrome for Testing, which comes
    /// before every PATH launcher.
    #[test]
    fn linux_prefers_real_binaries_then_chrome_for_testing_then_launchers() {
        let dir = tempdir("locate-linux-order");
        let p = places(&dir);
        let cft = p
            .home
            .as_ref()
            .unwrap()
            .join(".omp/puppeteer/chrome/linux-150.0.1.2")
            .join(Platform::Linux.cft_layout());
        executable(&cft, "cft");
        let c = candidates(Platform::Linux, &p);
        let at = |path: &Path| {
            c.iter()
                .position(|x| x == path)
                .unwrap_or_else(|| panic!("{path:?} in {c:?}"))
        };
        let chrome = at(&p.root.join("opt/google/chrome/chrome"));
        let chromium = at(&p.root.join("usr/lib/chromium/chromium"));
        let cft = at(&cft);
        let launcher = at(&dir.join("bin/google-chrome"));
        let chromium_launcher = at(&dir.join("bin/chromium"));
        assert!(chrome < cft && chromium < cft, "{c:?}");
        assert!(cft < launcher && cft < chromium_launcher, "{c:?}");
        assert!(
            LINUX_BINARIES
                .iter()
                .all(|rel| at(&p.root.join(rel)) < launcher),
            "{c:?}"
        );
    }

    /// macOS and Windows: Chrome for Testing first, then the installs,
    /// system-wide before per-user.
    #[test]
    fn mac_and_windows_try_chrome_for_testing_first() {
        let dir = tempdir("locate-mac-win");
        let p = places(&dir);
        for platform in [Platform::MacArm, Platform::Windows] {
            let cft = p
                .home
                .as_ref()
                .unwrap()
                .join(".omp/puppeteer/chrome")
                .join(format!("{}-150.0.0.1", platform.cft_prefixes()[0]))
                .join(platform.cft_layout());
            executable(&cft, "cft");
            let c = candidates(platform, &p);
            assert_eq!(c[0], cft, "{platform:?}");
        }
        let mac = candidates(Platform::MacArm, &p);
        let system = mac
            .iter()
            .position(|x| x == &p.root.join("Applications").join(MAC_APPS[0]));
        let user = mac
            .iter()
            .position(|x| x == &dir.join("home/Applications").join(MAC_APPS[0]));
        assert!(
            system.is_some() && user.is_some() && system < user,
            "{mac:?}"
        );
        let win = candidates(Platform::Windows, &p);
        assert!(
            win.contains(&dir.join("local").join(WINDOWS_INSTALLS[1])),
            "per-user Edge: {win:?}"
        );
        assert!(
            win.contains(&dir.join("pf").join(WINDOWS_INSTALLS[2])),
            "Brave: {win:?}"
        );
    }

    /// omp's XDG puppeteer cache counts only once `$XDG_CACHE_HOME/omp`
    /// exists, and then before `~/.omp`; newest version first in each.
    #[test]
    fn chrome_for_testing_comes_from_the_xdg_cache_and_home_newest_first() {
        let dir = tempdir("locate-cft");
        let p = places(&dir);
        let build = |root: &Path, version: &str| {
            root.join(format!("linux-{version}"))
                .join(Platform::Linux.cft_layout())
        };
        let home_root = dir.join("home/.omp/puppeteer/chrome");
        let old = executable(&build(&home_root, "131.0.1.1"), "");
        let new = executable(&build(&home_root, "150.0.7871.24"), "");
        let cft_of = |p: &Places| -> Vec<PathBuf> {
            candidates(Platform::Linux, p)
                .into_iter()
                .filter(|c| c.ends_with(Platform::Linux.cft_layout()))
                .collect()
        };
        assert_eq!(cft_of(&p), [new.as_path(), old.as_path()]);
        let xdg = executable(
            &build(&dir.join("cache/omp/puppeteer/chrome"), "120.0.0.0"),
            "",
        );
        assert_eq!(cft_of(&p), [xdg, new, old]);
    }

    /// An unresolvable home loses only the home candidates: nothing is
    /// looked for under a stand-in such as the shared temp dir.
    #[test]
    fn no_home_means_no_home_candidates() {
        let dir = tempdir("locate-no-home");
        let p = Places {
            home: None,
            ..places(&dir)
        };
        let temp = std::env::temp_dir();
        for platform in [Platform::Linux, Platform::MacArm, Platform::Windows] {
            let c = candidates(platform, &p);
            assert!(!c.is_empty(), "{platform:?}");
            assert!(
                c.iter()
                    .all(|path| path.starts_with(&dir) || !path.starts_with(&temp)),
                "{platform:?}: {c:?}"
            );
            assert!(
                c.iter().all(|path| !path.starts_with(dir.join("home"))),
                "{platform:?}: {c:?}"
            );
        }
        let mac = candidates(Platform::MacArm, &p);
        assert_eq!(mac.len(), MAC_APPS.len(), "only /Applications: {mac:?}");
    }

    /// A newer cached build for another platform must not outrank an older
    /// native one.
    #[test]
    fn foreign_platform_chrome_for_testing_is_ignored() {
        let dir = tempdir("locate-foreign");
        let root = dir.join("chrome");
        // The foreign dir carries the native layout so only its name can
        // exclude it.
        executable(
            &root
                .join("mac_arm-999.0.0.0")
                .join(Platform::Linux.cft_layout()),
            "",
        );
        let native = executable(
            &root
                .join("linux-100.0.0.0")
                .join(Platform::Linux.cft_layout()),
            "",
        );
        assert_eq!(chrome_for_testing(Platform::Linux, &root), vec![native]);
    }

    #[cfg(unix)]
    #[test]
    fn discovery_keeps_executables_once_and_skips_snaps() {
        let dir = tempdir("locate-discover");
        let p = places(&dir);
        let chromium = executable(&p.root.join("usr/lib/chromium/chromium"), "\x7fELF");
        // Not executable: never a candidate.
        std::fs::create_dir_all(p.root.join("opt/google/chrome")).unwrap();
        std::fs::write(p.root.join("opt/google/chrome/chrome"), "x").unwrap();
        // A launcher symlinked to the binary is the same file.
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::os::unix::fs::symlink(&chromium, dir.join("bin/chromium")).unwrap();
        // Ubuntu's transitional script and a snap shim.
        executable(
            &dir.join("bin/chromium-browser"),
            "#!/bin/sh\nexec /snap/bin/chromium \"$@\"\n",
        );
        let snap = executable(&p.root.join("usr/bin/snap"), "\x7fELF");
        std::os::unix::fs::symlink(&snap, dir.join("bin/brave-browser")).unwrap();
        let found = discover(Platform::Linux, &p);
        assert_eq!(found.binaries, vec![chromium]);
        assert_eq!(
            found.skipped,
            vec![
                (dir.join("bin/chromium-browser"), SNAP_REASON),
                (dir.join("bin/brave-browser"), SNAP_REASON),
            ]
        );
    }
}
