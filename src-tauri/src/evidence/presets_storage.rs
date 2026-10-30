//! Bounded strict reads and private, atomic preset persistence helpers.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

use super::schema::{PresetFile, MAX_CONFIG_BYTES};

pub(super) fn unreadable(path: &Path, error: &str) -> String {
    format!("Evidence preset library {} is unreadable: {error}; writes are refused until it is repaired", path.display())
}

pub(super) fn read_file(path: &Path) -> Result<PresetFile, String> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(PresetFile::default()),
        Err(error) => return Err(error.to_string()),
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err("not a regular file".to_owned())
        }
        Ok(_) => {}
    }
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.take((MAX_CONFIG_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > MAX_CONFIG_BYTES {
        return Err("preset library exceeds its size limit".to_owned());
    }
    let data: PresetFile = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    data.validate()?;
    Ok(data)
}

pub(super) fn encode(data: &PresetFile) -> Result<Vec<u8>, String> {
    data.validate()?;
    let bytes = serde_json::to_vec_pretty(data).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_CONFIG_BYTES {
        return Err("preset library exceeds its size limit".to_owned());
    }
    Ok(bytes)
}
