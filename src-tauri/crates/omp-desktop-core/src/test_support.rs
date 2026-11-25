//! Filesystem helpers the app's and this crate's test suites share:
//! [`executable`], [`tempdir`] and [`TempDir`].
//!
//! Compiled under `test`, or in the published API only for a dependent's
//! tests (`feature = "test-support"`, which the app's dev-dependency enables
//! and `src/test_support.rs` re-exports).

use std::path::{Path, PathBuf};

/// An executable stand-in at `path` holding `content` (unix: mode 0755),
/// its folder created first.
///
/// # Panics
/// The folder cannot be created or the file cannot be written (a broken test
/// setup, not a condition a caller handles).
#[must_use]
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
///
/// # Panics
/// The directory cannot be created.
#[must_use]
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
    #[must_use]
    pub fn new(scope: &str, name: &str) -> Self {
        Self(tempdir(scope, name))
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
