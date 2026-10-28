//! The desktop's read-only native context observer, not project-supplied code.
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const SOURCE: &[u8] = include_bytes!("context-extension.mjs");
static ASSET: Mutex<Option<Asset>> = Mutex::new(None);

struct Asset {
    dir: PathBuf,
    file: PathBuf,
}

fn create_in(dir: PathBuf) -> Result<Asset, String> {
    // Exclusive creation refuses planted directories/symlinks. The extension
    // is never written in the project or loaded from a renderer-supplied path.
    crate::private_fs::private_dirs(false)
        .create(&dir)
        .map_err(|e| format!("could not create native context observer directory: {e}"))?;
    let file = dir.join("desktop-context.mjs");
    if let Err(error) = crate::private_fs::create_private_file(&file, SOURCE) {
        let _ = std::fs::remove_dir(&dir);
        return Err(format!("could not write native context observer: {error}"));
    }
    Ok(Asset { dir, file })
}

pub(super) fn apply(command: &mut Command) -> Result<(), String> {
    let mut asset = ASSET.lock().map_err(|e| e.to_string())?;
    if asset.is_none() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "omp-desktop-context-{}-{nonce}",
            std::process::id()
        ));
        *asset = Some(create_in(dir)?);
    }
    if let Some(asset) = asset.as_ref() {
        command.arg("--extension").arg(&asset.file);
    }
    drop(asset);
    Ok(())
}

pub(super) fn cleanup() {
    let asset = ASSET.lock().ok().and_then(|mut slot| slot.take());
    if let Some(asset) = asset {
        if let Err(error) = crate::private_fs::remove_dir_retrying(&asset.dir) {
            eprintln!("[omp-desktop] native context observer cleanup: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn creates_private_observer_and_refuses_existing_destination() {
        let root = TempDir::new("agent-context", "observer");
        let asset = create_in(root.path().join("private")).unwrap();
        assert_eq!(std::fs::read(&asset.file).unwrap(), SOURCE);
        assert!(create_in(asset.dir).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(asset.file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn refuses_a_non_directory_parent_without_overwriting_it() {
        let root = TempDir::new("agent-context", "failure");
        let parent = root.path().join("file");
        std::fs::write(&parent, "keep").unwrap();
        assert!(create_in(parent.join("child")).is_err());
        assert_eq!(std::fs::read_to_string(parent).unwrap(), "keep");
    }
}
