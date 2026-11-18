//! The files this app instance keeps: its private directory `<root>/<pid>`
//! (overlays, `profiles/`, a pid file per launched browser), the overlay omp
//! reads its `cdpUrl` from, and pruning what crashed earlier runs left
//! behind.

use std::io;
use std::path::{Path, PathBuf};

use super::reap;
pub use crate::private_fs::{create_private_file, remove_dir_retrying};
use crate::private_fs::{pid_dirs, private_dirs};
use omp_desktop_core::proc_util::pid_is_alive;

/// The settings overlay omp takes as `--config=<path>`: its browser tool
/// attaches to the session's placeholder port. `relay: false` because omp
/// ranks an enabled browser relay above `cdpUrl`; without it a user with
/// the relay on would drive their own Chrome, not the panel's browser.
/// (A tool call's explicit `app.relay`/`app.tern`/`app.cdp_url` and the
/// `PI_BROWSER_RELAY` env var still outrank any setting.)
pub fn overlay(port: u16) -> String {
    format!("browser:\n  cdpUrl: \"http://127.0.0.1:{port}\"\n  relay: false\n")
}

/// Write the [`overlay`] for `port` to `path` (see [`create_private_file`]).
pub fn write_overlay(path: &Path, port: u16) -> io::Result<()> {
    create_private_file(path, overlay(port).as_bytes())
}

/// Create this process's private directory `<root>/<pid>`. `root` and the
/// instance directory must be real directories, not symlinks. A directory
/// with our own pid that already exists is a crashed earlier run's (pid
/// reuse, pid namespaces): its browsers are reaped and it is recreated
/// empty. Other instances' directories are [`prune_dead`]'s.
pub fn prepare_instance_dir(root: &Path) -> io::Result<PathBuf> {
    match std::fs::symlink_metadata(root) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Err(io::Error::other("not a real directory")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => private_dirs(true).create(root)?,
        Err(e) => return Err(e),
    }
    let instance = root.join(std::process::id().to_string());
    match std::fs::symlink_metadata(&instance) {
        Ok(meta) if meta.is_dir() => {
            if !reap::before_pruning(&instance) {
                return Err(io::Error::other(
                    "a browser of an earlier run with this pid is still running",
                ));
            }
            remove_dir_retrying(&instance)?;
        }
        Ok(_) => return Err(io::Error::other("instance path is not a real directory")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    private_dirs(false).create(&instance)?;
    Ok(instance)
}

/// Delete the instance directories under `root` whose process no longer
/// exists, after reaping the browsers they recorded (best effort). Those of
/// live processes (other app instances sharing `root`) and our own are never
/// touched; neither are names that are not pids. Can block for seconds per
/// stuck browser: call off the main thread.
pub fn prune_dead(root: &Path) {
    let own = std::process::id();
    for (pid, path) in pid_dirs(root) {
        if pid != own && !pid_is_alive(pid) && reap::before_pruning(&path) {
            let _ = remove_dir_retrying(&path);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::browser::tests::tempdir;

    #[test]
    fn private_files_are_exclusive_and_never_follow_a_symlink() {
        let dir = tempdir("private-file");
        let path = dir.join("profile.pid");
        create_private_file(&path, b"1234\n").unwrap();
        assert!(create_private_file(&path, b"5678\n").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "1234\n");
        std::fs::remove_file(&path).unwrap();
        let victim = dir.join("victim");
        std::fs::write(&victim, "untouched").unwrap();
        std::os::unix::fs::symlink(&victim, &path).unwrap();
        assert!(create_private_file(&path, b"5678\n").is_err());
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "untouched");
    }
}
