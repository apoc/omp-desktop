use std::path::{Path, PathBuf};
use std::process::Command;

/// The bundled `omp-desktopd`, beside the app executable.
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

pub(super) fn install() -> Result<(), String> {
    run("install")
}

pub(super) fn uninstall() -> Result<(), String> {
    run("uninstall")
}

fn run(command: &str) -> Result<(), String> {
    let program = path()?;
    // The sidecar's install/uninstall is a short one-shot CLI command whose
    // result must be reported to the Settings switch. The spawn gate protects
    // Chromium's pipe ends only while a browser launches; no browser exists
    // at the moment the app enables or disables Ompy, and its output is
    // captured before any tab can start.
    #[allow(clippy::disallowed_methods)]
    let output = Command::new(&program)
        .arg(command)
        .output()
        .map_err(|e| format!("cannot run {}: {e}", program.display()))?;
    if output.status.success() {
        return Ok(());
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
}
