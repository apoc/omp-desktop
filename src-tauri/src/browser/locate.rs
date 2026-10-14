//! Finding a Chromium to launch: the user's preference, a Chrome for Testing
//! build omp's puppeteer installed, then the browsers installed on the system.

use std::path::{Path, PathBuf};

/// Candidate browser binaries, best first: `pref` (when set), Chrome for
/// Testing builds under `<home>/.omp/puppeteer/chrome` newest version first,
/// then the platform's installed browsers. Existence is not checked here.
pub fn candidates(pref: Option<&Path>, home: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = pref.map(Path::to_path_buf).into_iter().collect();
    out.extend(chrome_for_testing(&home.join(".omp/puppeteer/chrome")));
    out.extend(installed());
    out
}

/// The first candidate that is an executable file.
pub fn find_chromium(pref: Option<&Path>, home: &Path) -> Option<PathBuf> {
    candidates(pref, home)
        .into_iter()
        .find(|p| is_executable(p))
}

/// The browser binary inside one `<platform>-<version>` Chrome for Testing
/// directory, when the platform's layout is present.
pub fn cft_binary(platform_dir: &Path) -> Option<PathBuf> {
    const LAYOUTS: &[&str] = &[
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-linux64/chrome",
        "chrome-win64/chrome.exe",
    ];
    LAYOUTS
        .iter()
        .map(|rel| platform_dir.join(rel))
        .find(|bin| bin.is_file())
}

/// The numeric version of a `<platform>-<version>` directory name:
/// `"mac_arm-150.0.7871.24"` → `[150, 0, 7871, 24]`.
pub fn version_of(dir_name: &str) -> Option<Vec<u32>> {
    let (_, version) = dir_name.split_once('-')?;
    version.split('.').map(|part| part.parse().ok()).collect()
}

/// Directory-name prefixes (before the `-<version>`) puppeteer uses for the
/// platform this build targets. A cached build for another platform is no use
/// here and must not outrank a native browser.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const PLATFORM_PREFIXES: &[&str] = &["mac_arm"];
#[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
const PLATFORM_PREFIXES: &[&str] = &["mac", "mac_x64"];
#[cfg(all(unix, not(target_os = "macos")))]
const PLATFORM_PREFIXES: &[&str] = &["linux"];
#[cfg(windows)]
const PLATFORM_PREFIXES: &[&str] = &["win64", "win32"];

/// Whether `dir_name` (`<platform>-<version>`) is for this build's platform.
fn is_native_platform_dir(dir_name: &str) -> bool {
    dir_name
        .split_once('-')
        .is_some_and(|(platform, _)| PLATFORM_PREFIXES.contains(&platform))
}

/// The Chrome for Testing binaries under `root` built for this platform,
/// newest version first.
fn chrome_for_testing(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut found: Vec<(Vec<u32>, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str().filter(|n| is_native_platform_dir(n))?;
            let version = version_of(name)?;
            Some((version, cft_binary(&entry.path())?))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, bin)| bin).collect()
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(windows)]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(target_os = "macos")]
fn installed() -> Vec<PathBuf> {
    [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]
    .map(PathBuf::from)
    .into()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn installed() -> Vec<PathBuf> {
    [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
    ]
    .into_iter()
    .filter_map(crate::child_path::search_path)
    .collect()
}

#[cfg(windows)]
fn installed() -> Vec<PathBuf> {
    [
        ("ProgramFiles", r"Google\Chrome\Application\chrome.exe"),
        ("ProgramFiles(x86)", r"Google\Chrome\Application\chrome.exe"),
        ("LOCALAPPDATA", r"Google\Chrome\Application\chrome.exe"),
        (
            "ProgramFiles(x86)",
            r"Microsoft\Edge\Application\msedge.exe",
        ),
    ]
    .into_iter()
    .filter_map(|(var, rel)| Some(PathBuf::from(std::env::var_os(var)?).join(rel)))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omp-browser-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Creates the Chrome-for-Testing binary of the current platform's layout
    /// under `dir` and returns its path.
    fn fake_cft(dir: &Path) -> PathBuf {
        let rel = if cfg!(target_os = "macos") {
            "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
        } else if cfg!(windows) {
            "chrome-win64/chrome.exe"
        } else {
            "chrome-linux64/chrome"
        };
        let bin = dir.join(rel);
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        bin
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

    #[cfg(unix)]
    #[test]
    fn newest_chrome_for_testing_wins_and_pref_comes_first() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempdir("locate");
        let root = home.join(".omp/puppeteer/chrome");
        let native = PLATFORM_PREFIXES[0];
        for v in [
            format!("{native}-131.0.1.1"),
            format!("{native}-150.0.7871.24"),
        ] {
            let bin = fake_cft(&root.join(v));
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let pref = home.join("my-chrome");
        std::fs::write(&pref, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&pref, std::fs::Permissions::from_mode(0o755)).unwrap();
        let c = candidates(Some(&pref), &home);
        assert_eq!(c[0], pref);
        assert!(c[1].to_string_lossy().contains("150.0.7871.24"), "{c:?}");
        assert_eq!(find_chromium(None, &home).unwrap(), c[1]);
        // A non-executable pref is skipped by find_chromium.
        std::fs::set_permissions(&pref, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_ne!(find_chromium(Some(&pref), &home).unwrap(), pref);
    }

    /// A newer cached build for another platform must not outrank an older
    /// native one.
    #[cfg(unix)]
    #[test]
    fn foreign_platform_chrome_for_testing_is_ignored() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempdir("locate-foreign");
        let root = home.join(".omp/puppeteer/chrome");
        let foreign = if cfg!(target_os = "linux") {
            "mac_arm"
        } else {
            "linux"
        };
        let native = PLATFORM_PREFIXES[0];
        // The foreign dir carries the native layout so only its name can
        // exclude it.
        let foreign_bin = fake_cft(&root.join(format!("{foreign}-999.0.0.0")));
        let native_bin = fake_cft(&root.join(format!("{native}-100.0.0.0")));
        for bin in [&foreign_bin, &native_bin] {
            std::fs::set_permissions(bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(chrome_for_testing(&root), vec![native_bin.clone()]);
        assert_eq!(find_chromium(None, &home).unwrap(), native_bin);
    }
}
