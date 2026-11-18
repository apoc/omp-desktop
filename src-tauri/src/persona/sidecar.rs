use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

/// The persona service executable beside the app executable.
///
/// `tauri build` copies `bundle.externalBin` (`binaries/omp-desktopd-<triple>`,
/// staged by `scripts/build-sidecar.mjs`) into the bundle next to the app
/// binary under the plain name. `tauri dev` runs the app from
/// `src-tauri/target/debug/`, so the same lookup resolves
/// `target/debug/omp-desktopd` there; build it once with
/// `cargo build -p omp-desktopd` (or `cargo build --workspace`).
///
/// # Errors
///
/// Fails when the running executable or its directory cannot be read.
pub(super) fn path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("cannot locate app executable: {e}"))?;
    path_from_exe(&exe)
}

fn path_from_exe(exe: &Path) -> Result<PathBuf, String> {
    let dir = exe
        .parent()
        .ok_or_else(|| "app executable has no directory".to_owned())?;
    let name = if cfg!(windows) {
        "omp-desktopd.exe"
    } else {
        "omp-desktopd"
    };
    Ok(dir.join(name))
}

const fn executable_name() -> &'static str {
    if cfg!(windows) {
        "omp-desktopd.exe"
    } else {
        "omp-desktopd"
    }
}

fn stable_dir_from(base: &Path) -> PathBuf {
    base.join("dev.ohMyPi.desktop").join("bin")
}

/// A per-user location that survives `AppImage` unmounts and App Translocation.
fn stable_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    let base = dirs::data_dir();
    #[cfg(not(target_os = "macos"))]
    let base = dirs::data_local_dir();
    base.map(|dir| stable_dir_from(&dir))
        .ok_or_else(|| "no per-user data directory for the persona service".to_owned())
}

fn stable_path() -> Result<PathBuf, String> {
    Ok(stable_dir()?.join(executable_name()))
}

fn digest(path: &Path) -> Result<[u8; 32], String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hash.finalize().into())
}

fn needs_refresh(bundled: &Path, stable: &Path) -> Result<bool, String> {
    let bundled_len = std::fs::metadata(bundled)
        .map_err(|e| format!("cannot inspect {}: {e}", bundled.display()))?
        .len();
    let stable_len = std::fs::metadata(stable)
        .map_err(|e| format!("cannot inspect {}: {e}", stable.display()))?
        .len();
    if bundled_len != stable_len {
        return Ok(true);
    }
    Ok(digest(bundled)? != digest(stable)?)
}

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Copy through a new temporary file beside `stable`, then atomically rename.
fn copy_atomic(bundled: &Path, stable: &Path) -> Result<(), String> {
    let parent = stable
        .parent()
        .ok_or_else(|| "stable persona executable has no directory".to_owned())?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let mut temp_name = stable
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new("omp-desktopd"))
        .to_os_string();
    temp_name.push(format!(".{}.{sequence}.tmp", std::process::id()));
    let temp = parent.join(temp_name);
    let result = (|| {
        let mut source = std::fs::File::open(bundled)
            .map_err(|e| format!("cannot read {}: {e}", bundled.display()))?;
        let mut target = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| format!("cannot create {}: {e}", temp.display()))?;
        std::io::copy(&mut source, &mut target)
            .map_err(|e| format!("cannot copy {}: {e}", bundled.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            target
                .set_permissions(std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("cannot make {} executable: {e}", temp.display()))?;
        }
        target
            .sync_all()
            .map_err(|e| format!("cannot write {}: {e}", temp.display()))?;
        drop(target);
        std::fs::rename(&temp, stable).map_err(|e| {
            let locked = if cfg!(windows) {
                "; stop the running Ompy service and try again"
            } else {
                ""
            };
            format!("cannot replace {}{locked}: {e}", stable.display())
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

pub(super) fn install() -> Result<(), String> {
    let stable = stable_path()?;
    copy_atomic(&path()?, &stable)?;
    run_at(&stable, "install").map(drop)
}

pub(super) fn uninstall() -> Result<(), String> {
    // Leave the copy for a later enable; remove only the login entry.
    run_at(&stable_path()?, "uninstall").map(drop)
}

/// Refresh an installed copy after an app update, off the main thread.
/// Re-running install is idempotent and bootstraps the running service again.
pub(super) fn refresh() -> Result<(), String> {
    let stable = stable_path()?;
    if !stable
        .try_exists()
        .map_err(|e| format!("cannot inspect {}: {e}", stable.display()))?
    {
        return Ok(());
    }
    let bundled = path()?;
    if !needs_refresh(&bundled, &stable)? {
        return Ok(());
    }
    let running = run_at(&stable, "status").is_ok();
    copy_atomic(&bundled, &stable)?;
    if running {
        run_at(&stable, "install")?;
    }
    Ok(())
}

fn run_at(program: &Path, command: &str) -> Result<Output, String> {
    // The sidecar's install/uninstall is a short one-shot CLI command whose
    // result must be reported to the Settings switch. The spawn gate protects
    // Chromium's pipe ends only while a browser launches; no browser exists
    // at the moment the app enables or disables Ompy, and its output is
    // captured before any tab can start.
    #[allow(clippy::disallowed_methods)]
    let output = Command::new(program)
        .arg(command)
        .output()
        .map_err(|e| format!("cannot run {}: {e}", program.display()))?;
    if output.status.success() {
        return Ok(output);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = stderr.trim();
    Err(if detail.is_empty() {
        format!(
            "{} {command} exited with {}",
            program.display(),
            output.status
        )
    } else {
        format!("{} {command}: {detail}", program.display())
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn path_is_beside_the_app_executable() {
        let exe = if cfg!(windows) {
            std::path::Path::new(r"C:\OMP Desktop\omp-desktop.exe")
        } else {
            std::path::Path::new("/opt/OMP Desktop/omp-desktop")
        };
        let expected = if cfg!(windows) {
            std::path::Path::new(r"C:\OMP Desktop\omp-desktopd.exe")
        } else {
            std::path::Path::new("/opt/OMP Desktop/omp-desktopd")
        };
        assert_eq!(super::path_from_exe(exe).unwrap(), expected);
    }

    #[test]
    fn stable_dir_uses_the_platform_data_directory() {
        #[cfg(target_os = "linux")]
        assert_eq!(
            super::stable_dir_from(std::path::Path::new("/home/user/.local/share")),
            std::path::Path::new("/home/user/.local/share/dev.ohMyPi.desktop/bin")
        );
        #[cfg(target_os = "macos")]
        assert_eq!(
            super::stable_dir_from(std::path::Path::new(
                "/Users/user/Library/Application Support"
            )),
            std::path::Path::new("/Users/user/Library/Application Support/dev.ohMyPi.desktop/bin")
        );
        #[cfg(windows)]
        assert_eq!(
            super::stable_dir_from(std::path::Path::new(r"C:\Users\user\AppData\Local")),
            std::path::Path::new(r"C:\Users\user\AppData\Local\dev.ohMyPi.desktop\bin")
        );
    }

    #[test]
    fn refresh_compares_size_then_contents() {
        let temp = crate::test_support::TempDir::new("persona-sidecar", "refresh");
        let bundled = temp.path().join("bundled");
        let stable = temp.path().join("stable");
        std::fs::write(&bundled, b"new").unwrap();
        std::fs::write(&stable, b"old").unwrap();
        assert!(super::needs_refresh(&bundled, &stable).unwrap());
        std::fs::write(&stable, b"new").unwrap();
        assert!(!super::needs_refresh(&bundled, &stable).unwrap());
        std::fs::write(&stable, b"longer").unwrap();
        assert!(super::needs_refresh(&bundled, &stable).unwrap());
    }

    #[test]
    fn copy_atomic_replaces_the_stable_executable() {
        let temp = crate::test_support::TempDir::new("persona-sidecar", "copy");
        let bundled = temp.path().join("bundled");
        let stable = temp.path().join("nested").join(if cfg!(windows) {
            "omp-desktopd.exe"
        } else {
            "omp-desktopd"
        });
        std::fs::write(&bundled, b"first").unwrap();
        super::copy_atomic(&bundled, &stable).unwrap();
        assert_eq!(std::fs::read(&stable).unwrap(), b"first");
        std::fs::write(&bundled, b"other").unwrap();
        super::copy_atomic(&bundled, &stable).unwrap();
        assert_eq!(std::fs::read(&stable).unwrap(), b"other");
        assert_eq!(
            std::fs::read_dir(stable.parent().unwrap()).unwrap().count(),
            1,
            "no temporary copy is left behind"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(stable).unwrap().permissions().mode() & 0o111,
                0o111
            );
        }
    }
}
