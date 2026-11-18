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

fn create_missing_ancestors(dir: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(dir) {
        Ok(_) => return Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("cannot inspect {}: {e}", dir.display())),
    }
    let parent = dir
        .parent()
        .ok_or_else(|| format!("cannot create {}: no parent directory", dir.display()))?;
    create_missing_ancestors(parent)?;
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(dir)
        .map_err(|e| format!("cannot create {}: {e}", dir.display()))
}

/// The install directories and where the plain ancestor creation ends.
///
/// Only the folders ABOVE the app's own name may be created by
/// [`create_missing_ancestors`]: they are the user's ordinary data directory
/// chain, whose mode nothing here changes. The app-named folder and `bin`
/// belong to the app and are created (or secured) through
/// [`ensure_private_dir`], so on Windows they carry the protected DACL from
/// their first moment instead of inheriting `%LOCALAPPDATA%`'s.
struct InstallDirs {
    /// Everything above the app-named folder: created when missing, nothing
    /// else touched.
    ancestors: PathBuf,
    /// Created or secured with the protected path, outermost first.
    protected: [PathBuf; 2],
}

fn install_dirs(stable_dir: &Path) -> Result<InstallDirs, String> {
    let app_dir = stable_dir
        .parent()
        .ok_or_else(|| "stable persona directory has no parent".to_owned())?;
    let ancestors = app_dir
        .parent()
        .ok_or_else(|| format!("cannot create {}: no parent directory", app_dir.display()))?;
    Ok(InstallDirs {
        ancestors: ancestors.to_path_buf(),
        protected: [app_dir.to_path_buf(), stable_dir.to_path_buf()],
    })
}

fn ensure_install_dirs(stable_dir: &Path) -> Result<(), String> {
    let dirs = install_dirs(stable_dir)?;
    create_missing_ancestors(&dirs.ancestors)?;
    for dir in &dirs.protected {
        ensure_private_dir(dir)?;
    }
    Ok(())
}

#[cfg(unix)]
fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};

    match std::fs::symlink_metadata(dir) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "refusing symlinked persona directory {}",
                    dir.display()
                ));
            }
            if !metadata.is_dir() {
                return Err(format!(
                    "persona directory is not a directory: {}",
                    dir.display()
                ));
            }
            // SAFETY: geteuid has no preconditions.
            if metadata.uid() != unsafe { libc::geteuid() } {
                return Err(format!(
                    "persona directory is not owned by the current user: {}",
                    dir.display()
                ));
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(dir)
                .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        }
        Err(e) => return Err(format!("cannot inspect {}: {e}", dir.display())),
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("cannot make {} private: {e}", dir.display()))?;
    let metadata = std::fs::symlink_metadata(dir)
        .map_err(|e| format!("cannot inspect {}: {e}", dir.display()))?;
    // SAFETY: geteuid has no preconditions.
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(format!(
            "persona directory must be a non-symlinked, current-user-owned mode 0700 directory: {}",
            dir.display()
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    // Created with, or converted to, a protected DACL for this user alone: an
    // inherited %LOCALAPPDATA% ACE is not evidence that the replacement lands
    // in a folder only this user can write.
    omp_desktop_core::persona_fs_security::ensure_private_dir(dir)
        .map_err(|e| format!("cannot secure {}: {e}", dir.display()))
}

fn needs_refresh(bundled: &Path, stable: &Path) -> Result<bool, String> {
    let metadata = std::fs::symlink_metadata(stable)
        .map_err(|e| format!("cannot inspect {}: {e}", stable.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // SAFETY: geteuid has no preconditions.
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o022 != 0
        {
            return Ok(true);
        }
    }
    #[cfg(windows)]
    {
        use omp_desktop_core::persona_fs_security as secure;
        // A reparse point is replaced, never followed: the file it points at
        // is not the copy this app wrote, even when its bytes match.
        if secure::is_reparse_point(stable)
            .map_err(|e| format!("cannot inspect {}: {e}", stable.display()))?
        {
            return Ok(true);
        }
        if !secure::owner_is_current_user(stable)
            .map_err(|e| format!("cannot inspect the owner of {}: {e}", stable.display()))?
        {
            return Err(format!(
                "installed persona executable is not owned by the current user: {}",
                stable.display()
            ));
        }
        // A DACL that other accounts can inherit from is repaired by the same
        // replacement that a byte mismatch causes.
        if !secure::has_private_dacl(stable).map_err(|e| {
            format!(
                "cannot inspect the access control of {}: {e}",
                stable.display()
            )
        })? {
            return Ok(true);
        }
    }
    Ok(digest(bundled)? != digest(stable)?)
}

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Copy through a new private temporary file beside `stable`, then atomically rename.
fn copy_atomic(bundled: &Path, stable: &Path) -> Result<(), String> {
    copy_atomic_with(bundled, stable, |_| {})
}

fn copy_atomic_with(
    bundled: &Path,
    stable: &Path,
    before_rename: impl FnOnce(&Path),
) -> Result<(), String> {
    let parent = stable
        .parent()
        .ok_or_else(|| "stable persona executable has no directory".to_owned())?;
    ensure_install_dirs(parent)?;
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
        // The temp file is the executable that becomes the stable copy, so it
        // carries the private DACL from its first byte on Windows; `create_new`
        // additionally prevents name pre-planting.
        #[cfg(windows)]
        let mut target = omp_desktop_core::persona_fs_security::create_private_file(&temp)
            .map_err(|e| format!("cannot create {}: {e}", temp.display()))?;
        #[cfg(not(windows))]
        let mut target = {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o700);
            }
            options
                .open(&temp)
                .map_err(|e| format!("cannot create {}: {e}", temp.display()))?
        };
        std::io::copy(&mut source, &mut target)
            .map_err(|e| format!("cannot copy {}: {e}", bundled.display()))?;
        target
            .sync_all()
            .map_err(|e| format!("cannot write {}: {e}", temp.display()))?;
        before_rename(&temp);
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

fn copy_verified(bundled: &Path, stable: &Path) -> Result<(), String> {
    copy_atomic(bundled, stable)?;
    if needs_refresh(bundled, stable)? {
        return Err(format!(
            "installed persona executable does not match the bundle: {}",
            stable.display()
        ));
    }
    Ok(())
}

pub(super) fn install() -> Result<(), String> {
    let stable = stable_path()?;
    copy_verified(&path()?, &stable)?;
    run_at(&stable, "install").map(drop)
}

pub(super) fn uninstall() -> Result<(), String> {
    // Run the trusted bundle, never a pre-planted stable executable. Leave
    // the copy for a later enable; remove only the login entry.
    run_at(&path()?, "uninstall").map(drop)
}

/// Refresh an installed copy after an app update, off the main thread.
pub(super) fn refresh() -> Result<(), String> {
    let stable = stable_path()?;
    refresh_with(&path()?, &stable, cfg!(windows), |program, command| {
        run_at(program, command).map(drop)
    })
}

/// `stop_first`: a running image cannot be replaced on Windows, so the task
/// is ended before the copy and started again afterwards. Unix replaces the
/// file under the running service and reloads it with `restart`.
fn refresh_with(
    bundled: &Path,
    stable: &Path,
    stop_first: bool,
    mut run: impl FnMut(&Path, &str) -> Result<(), String>,
) -> Result<(), String> {
    let parent = stable
        .parent()
        .ok_or_else(|| "stable persona executable has no directory".to_owned())?;
    ensure_install_dirs(parent)?;
    match std::fs::symlink_metadata(stable) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("cannot inspect {}: {e}", stable.display())),
    }
    if !needs_refresh(bundled, stable)? {
        return Ok(());
    }
    // Every command before the copy runs the trusted bundle, never a
    // pre-planted stable executable.
    let running = run(bundled, "status").is_ok();
    if stop_first {
        // Idempotent: a missing or already stopped task is fine.
        run(bundled, "stop")?;
    }
    copy_verified(bundled, stable)?;
    if running {
        run(stable, "restart")?;
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
    fn refresh_compares_contents() {
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
    fn refresh_replaces_a_mismatch_without_executing_it() {
        let temp = crate::test_support::TempDir::new("persona-sidecar", "untrusted");
        let bundled = temp.path().join("bundled");
        let stable = super::stable_dir_from(temp.path()).join(super::executable_name());
        std::fs::create_dir_all(stable.parent().unwrap()).unwrap();
        std::fs::write(&bundled, b"bundle").unwrap();
        std::fs::write(&stable, b"attack").unwrap();
        let mut calls = Vec::new();
        super::refresh_with(&bundled, &stable, false, |program, command| {
            calls.push((program.to_path_buf(), command.to_owned()));
            Ok(())
        })
        .unwrap();
        assert_eq!(std::fs::read(&stable).unwrap(), b"bundle");
        assert_eq!(
            calls,
            vec![
                (bundled, "status".to_owned()),
                (stable, "restart".to_owned()),
            ]
        );
    }

    #[test]
    fn refresh_does_not_start_a_disabled_service() {
        let temp = crate::test_support::TempDir::new("persona-sidecar", "disabled");
        let bundled = temp.path().join("bundled");
        let stable = super::stable_dir_from(temp.path()).join(super::executable_name());
        std::fs::create_dir_all(stable.parent().unwrap()).unwrap();
        std::fs::write(&bundled, b"bundle").unwrap();
        std::fs::write(&stable, b"old").unwrap();
        let mut calls = Vec::new();
        super::refresh_with(&bundled, &stable, false, |program, command| {
            calls.push((program.to_path_buf(), command.to_owned()));
            Err("not running".to_owned())
        })
        .unwrap();
        assert_eq!(calls, vec![(bundled, "status".to_owned())]);
        assert_eq!(std::fs::read(stable).unwrap(), b"bundle");
    }

    #[test]
    fn refresh_stops_the_task_before_replacing_on_windows() {
        let temp = crate::test_support::TempDir::new("persona-sidecar", "stop-first");
        let bundled = temp.path().join("bundled");
        let stable = super::stable_dir_from(temp.path()).join(super::executable_name());
        std::fs::create_dir_all(stable.parent().unwrap()).unwrap();
        std::fs::write(&bundled, b"bundle").unwrap();
        std::fs::write(&stable, b"old").unwrap();
        let mut calls = Vec::new();
        super::refresh_with(&bundled, &stable, true, |program, command| {
            // At `stop` time the running image is still the old copy: the
            // stop must not come after the replacement.
            if command == "stop" {
                assert_eq!(std::fs::read(&stable).unwrap(), b"old");
            }
            calls.push((program.to_path_buf(), command.to_owned()));
            Ok(())
        })
        .unwrap();
        assert_eq!(
            calls,
            vec![
                (bundled.clone(), "status".to_owned()),
                (bundled, "stop".to_owned()),
                (stable.clone(), "restart".to_owned()),
            ]
        );
        assert_eq!(std::fs::read(&stable).unwrap(), b"bundle");
    }

    #[test]
    fn refresh_reports_a_failed_replacement_after_stopping() {
        let temp = crate::test_support::TempDir::new("persona-sidecar", "stop-failed");
        let bundled = temp.path().join("bundled");
        let stable = super::stable_dir_from(temp.path()).join(super::executable_name());
        // A directory at the executable path makes the final rename fail.
        std::fs::create_dir_all(&stable).unwrap();
        std::fs::write(&bundled, b"bundle").unwrap();
        let mut calls = Vec::new();
        let error = super::refresh_with(&bundled, &stable, true, |program, command| {
            calls.push((program.to_path_buf(), command.to_owned()));
            Ok(())
        })
        .unwrap_err();
        assert!(error.contains("cannot replace"), "{error}");
        assert_eq!(
            calls,
            vec![
                (bundled.clone(), "status".to_owned()),
                (bundled, "stop".to_owned()),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn install_directories_and_temp_file_are_private_from_creation() {
        use std::os::unix::fs::PermissionsExt;

        let temp = crate::test_support::TempDir::new("persona-sidecar", "private");
        let bundled = temp.path().join("bundled");
        let stable = super::stable_dir_from(temp.path()).join(super::executable_name());
        std::fs::write(&bundled, b"bundle").unwrap();
        super::copy_atomic_with(&bundled, &stable, |temporary| {
            assert_eq!(
                std::fs::metadata(temporary).unwrap().permissions().mode() & 0o777,
                0o700
            );
        })
        .unwrap();
        let bin = stable.parent().unwrap();
        let app = bin.parent().unwrap();
        for path in [app, bin, &stable] {
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn existing_group_writable_install_directories_are_made_private() {
        use std::os::unix::fs::PermissionsExt;

        let temp = crate::test_support::TempDir::new("persona-sidecar", "chmod");
        let bundled = temp.path().join("bundled");
        let stable = super::stable_dir_from(temp.path()).join(super::executable_name());
        std::fs::create_dir_all(stable.parent().unwrap()).unwrap();
        std::fs::write(&bundled, b"bundle").unwrap();
        for dir in [
            stable.parent().unwrap(),
            stable.parent().unwrap().parent().unwrap(),
        ] {
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o775)).unwrap();
        }
        super::copy_atomic(&bundled, &stable).unwrap();
        for dir in [
            stable.parent().unwrap(),
            stable.parent().unwrap().parent().unwrap(),
        ] {
            assert_eq!(
                std::fs::metadata(dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_install_directories_are_rejected() {
        let temp = crate::test_support::TempDir::new("persona-sidecar", "symlink");
        let bundled = temp.path().join("bundled");
        let stable = super::stable_dir_from(temp.path()).join(super::executable_name());
        let elsewhere = temp.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        std::fs::create_dir(stable.parent().unwrap().parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&elsewhere, stable.parent().unwrap()).unwrap();
        std::fs::write(&bundled, b"bundle").unwrap();
        let error = super::copy_atomic(&bundled, &stable).unwrap_err();
        assert!(error.contains("symlink"), "{error}");
        assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn refresh_secures_identical_install_directories_before_returning() {
        use std::os::unix::fs::PermissionsExt;

        let temp = crate::test_support::TempDir::new("persona-sidecar", "refresh-dirs");
        let bundled = temp.path().join("bundled");
        let stable = super::stable_dir_from(temp.path()).join(super::executable_name());
        std::fs::create_dir_all(stable.parent().unwrap()).unwrap();
        std::fs::write(&bundled, b"bundle").unwrap();
        std::fs::write(&stable, b"bundle").unwrap();
        for dir in [
            stable.parent().unwrap(),
            stable.parent().unwrap().parent().unwrap(),
        ] {
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o775)).unwrap();
        }
        let mut calls = Vec::new();
        super::refresh_with(&bundled, &stable, false, |program, command| {
            calls.push((program.to_path_buf(), command.to_owned()));
            Ok(())
        })
        .unwrap();
        assert_eq!(calls, [] as [(std::path::PathBuf, String); 0]);
        for dir in [
            stable.parent().unwrap(),
            stable.parent().unwrap().parent().unwrap(),
        ] {
            assert_eq!(
                std::fs::metadata(dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn refresh_replaces_an_insecure_identical_executable_without_executing_it() {
        use std::os::unix::fs::PermissionsExt;

        let temp = crate::test_support::TempDir::new("persona-sidecar", "refresh-file");
        let bundled = temp.path().join("bundled");
        let stable = super::stable_dir_from(temp.path()).join(super::executable_name());
        std::fs::create_dir_all(stable.parent().unwrap()).unwrap();
        std::fs::write(&bundled, b"bundle").unwrap();
        std::fs::write(&stable, b"bundle").unwrap();
        std::fs::set_permissions(&stable, std::fs::Permissions::from_mode(0o777)).unwrap();
        let mut calls = Vec::new();
        super::refresh_with(&bundled, &stable, false, |program, command| {
            calls.push((program.to_path_buf(), command.to_owned()));
            Ok(())
        })
        .unwrap();
        assert_eq!(std::fs::read(&stable).unwrap(), b"bundle");
        assert_eq!(
            std::fs::metadata(&stable).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            calls,
            vec![
                (bundled, "status".to_owned()),
                (stable, "restart".to_owned()),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn install_creates_missing_data_root_ancestors_without_chmodding_existing_roots() {
        use std::os::unix::fs::PermissionsExt;

        let temp = crate::test_support::TempDir::new("persona-sidecar", "ancestors");
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let data_root = temp.path().join("missing").join("data");
        let bundled = temp.path().join("bundled");
        let stable = super::stable_dir_from(&data_root).join(super::executable_name());
        std::fs::write(&bundled, b"bundle").unwrap();
        super::copy_atomic(&bundled, &stable).unwrap();
        assert_eq!(std::fs::read(stable).unwrap(), b"bundle");
        for dir in [temp.path().join("missing"), data_root] {
            assert_eq!(
                std::fs::metadata(dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        assert_eq!(
            std::fs::metadata(temp.path()).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    #[test]
    fn only_directories_above_the_app_folder_use_the_plain_ancestor_helper() {
        use std::path::{Path, PathBuf};

        // The app's own name and `bin` are protected from creation; the
        // folders above the app folder may be created by the generic helper.
        let dirs = super::install_dirs(Path::new("/data/dev.ohMyPi.desktop/bin")).unwrap();
        assert_eq!(dirs.ancestors, Path::new("/data"));
        assert_eq!(
            dirs.protected,
            [
                PathBuf::from("/data/dev.ohMyPi.desktop"),
                PathBuf::from("/data/dev.ohMyPi.desktop/bin"),
            ]
        );
        // Nothing outside the app folder's name is ever handed to the
        // protected path, and vice versa.
        assert!(!dirs.protected.contains(&dirs.ancestors));

        // A path with no folder above the app folder leaves nothing to
        // create generically: that is an error, not a silent `mkdir`.
        assert!(super::install_dirs(Path::new("bin")).is_err());
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
                std::fs::metadata(stable).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }
}
