//! Helpers the suites that moved here from the app crate share. Test-only,
//! so each crate keeps its own small copy rather than exposing them in the
//! published API.

use std::path::{Path, PathBuf};

/// An executable stand-in at `path` holding `content` (unix: mode 0755),
/// its folder created first.
pub fn executable(path: &Path, content: &str) -> PathBuf {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).unwrap();
    }
    std::fs::write(path, content).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    path.to_path_buf()
}

/// A fresh, empty scratch directory `omp-<scope>-<name>-<pid>` in the temp
/// dir. `scope` keeps the suites apart: their tests share one process.
pub fn tempdir(scope: &str, name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("omp-{scope}-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A [`tempdir`] removed with its content when dropped (also when the test
/// fails).
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(scope: &str, name: &str) -> Self {
        Self(tempdir(scope, name))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
