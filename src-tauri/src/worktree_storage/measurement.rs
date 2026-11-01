//! Best-effort logical size of the currently present checkout, including
//! rebuildable caches. Never follow symlinks or mutate the lease.
use std::path::{Path, PathBuf};

const MAX_ENTRIES: usize = 1_000_000;

pub(super) fn is_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;
        metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

pub(super) fn bytes(root: &Path) -> Result<u64, String> {
    let root_meta = std::fs::symlink_metadata(root)
        .map_err(|e| format!("cannot inspect checkout size: {e}"))?;
    if !root_meta.is_dir() || is_link(&root_meta) {
        return Err("checkout is not a directory".into());
    }
    let mut pending = vec![PathBuf::from(root)];
    let mut count = 0usize;
    let mut total = 0u64;
    while let Some(dir) = pending.pop() {
        let meta = std::fs::symlink_metadata(&dir)
            .map_err(|e| format!("cannot inspect checkout size: {e}"))?;
        if !meta.is_dir() || is_link(&meta) {
            return Err("checkout changed while measuring size".into());
        }
        for entry in std::fs::read_dir(&dir).map_err(|e| format!("cannot measure checkout: {e}"))? {
            let entry = entry.map_err(|e| format!("cannot measure checkout: {e}"))?;
            count += 1;
            if count > MAX_ENTRIES {
                return Err("checkout size exceeds entry limit".into());
            }
            let metadata = std::fs::symlink_metadata(entry.path())
                .map_err(|e| format!("cannot measure checkout: {e}"))?;
            if metadata.is_dir() && !is_link(&metadata) {
                pending.push(entry.path());
            } else {
                total = total.saturating_add(metadata.len());
            }
        }
    }
    Ok(total)
}
