//! A JSON file in the app config folder that a store keeps — or, when the
//! app has no config folder, the bytes that file would hold, kept in memory
//! for the app run instead of in a shared location another account could
//! plant a file in. Both go through the same parse and serialise steps, so
//! a store built on [`ConfigFile`] has no memory-only branch of its own.
//!
//! File-backed, every call is the matching [`json_store`] primitive.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::de::DeserializeOwned;
use serde::Serialize;

use omp_desktop_core::json_store;

pub enum ConfigFile {
    /// The file and `path.with_extension("lock")`, computed once at
    /// construction rather than allocated on every write.
    File { path: PathBuf, lock: PathBuf },
    /// No app config folder: the bytes the file would hold (empty until the
    /// first write, which reads as a missing file).
    Memory(Mutex<Vec<u8>>),
}

impl ConfigFile {
    /// The file at `path` (it need not exist yet), or memory for `None`.
    pub fn new(path: Option<PathBuf>) -> Self {
        path.map_or_else(
            || Self::Memory(Mutex::default()),
            |path| Self::File {
                lock: path.with_extension("lock"),
                path,
            },
        )
    }

    /// The file's path; `None` in memory.
    pub fn path(&self) -> Option<&Path> {
        match self {
            Self::File { path, .. } => Some(path),
            Self::Memory(_) => None,
        }
    }

    /// [`json_store::read_strict`]: missing ⇒ default, unreadable ⇒ `Err`.
    pub fn read_strict<T: DeserializeOwned + Default>(&self) -> Result<T, String> {
        match self {
            Self::File { path, .. } => json_store::read_strict(path),
            Self::Memory(bytes) => parse(&locked(bytes)),
        }
    }

    /// [`json_store::read_or_default`]: missing or unreadable ⇒ default.
    pub fn read_or_default<T: DeserializeOwned + Default>(&self) -> T {
        match self {
            Self::File { path, .. } => json_store::read_or_default(path),
            // Only ever holds what `serialise` wrote.
            Self::Memory(bytes) => parse(&locked(bytes)).unwrap_or_default(),
        }
    }

    /// [`json_store::update_strict`]: a locked read-modify-write that refuses
    /// an unreadable file and writes only when `modify` reports a change;
    /// returns `commit`'s answer. In memory `commit` runs after the bytes'
    /// lock is released.
    pub fn update_strict<T, R>(
        &self,
        modify: impl FnOnce(&mut T) -> bool,
        commit: impl FnOnce(T) -> R,
    ) -> Result<R, String>
    where
        T: Serialize + DeserializeOwned + Default,
    {
        match self {
            Self::File { path, lock } => json_store::update_strict(path, lock, modify, commit),
            Self::Memory(bytes) => update_memory(bytes, modify, commit),
        }
    }

    /// A locked read-modify-write that reads a missing or unreadable file
    /// as default and always writes; returns `commit`'s answer, computed
    /// inside the file lock (in memory after the bytes' lock is released).
    pub fn update<T, R>(
        &self,
        modify: impl FnOnce(&mut T),
        commit: impl FnOnce(T) -> R,
    ) -> Result<R, String>
    where
        T: Serialize + DeserializeOwned + Default,
    {
        match self {
            // `with_lock_str` creates the parent directory before locking.
            Self::File { path, lock } => json_store::with_lock_str(lock, || {
                let mut data = json_store::read_or_default(path);
                modify(&mut data);
                write_file(path, &serialise(&data)?)?;
                Ok(commit(data))
            }),
            Self::Memory(bytes) => update_memory(
                bytes,
                |data| {
                    modify(data);
                    true
                },
                commit,
            ),
        }
    }

    /// Replace the content with `value`, under the file lock.
    pub fn write<T: Serialize>(&self, value: &T) -> Result<(), String> {
        let bytes = serialise(value)?;
        match self {
            Self::File { path, lock } => {
                json_store::with_lock_str(lock, || write_file(path, &bytes))
            }
            Self::Memory(saved) => {
                *locked(saved) = bytes;
                Ok(())
            }
        }
    }
}

/// The in-memory read-modify-write behind both updates: the bytes always
/// parse (only `serialise` wrote them), so strict and lenient agree.
fn update_memory<T, R>(
    bytes: &Mutex<Vec<u8>>,
    modify: impl FnOnce(&mut T) -> bool,
    commit: impl FnOnce(T) -> R,
) -> Result<R, String>
where
    T: Serialize + DeserializeOwned + Default,
{
    let mut saved = locked(bytes);
    let mut data: T = parse(&saved)?;
    if modify(&mut data) {
        *saved = serialise(&data)?;
    }
    drop(saved);
    Ok(commit(data))
}

/// Memory content: empty (nothing written yet) is a missing file.
fn parse<T: DeserializeOwned + Default>(bytes: &[u8]) -> Result<T, String> {
    if bytes.is_empty() {
        return Ok(T::default());
    }
    serde_json::from_slice(bytes).map_err(|e| e.to_string())
}

fn serialise<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(value).map_err(|e| e.to_string())
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    json_store::write_atomic(path, bytes).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Every write replaces the whole value, so poison is ignored.
fn locked(bytes: &Mutex<Vec<u8>>) -> MutexGuard<'_, Vec<u8>> {
    bytes.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::collections::BTreeMap;

    type Map = BTreeMap<String, u32>;

    fn stores(dir: &TempDir) -> [ConfigFile; 2] {
        [
            ConfigFile::new(Some(dir.path().join("store.json"))),
            ConfigFile::new(None),
        ]
    }

    #[test]
    fn nothing_written_yet_reads_as_default() {
        let dir = TempDir::new("config-file", "empty");
        for store in stores(&dir) {
            assert_eq!(store.read_strict::<Map>(), Ok(Map::new()));
            assert_eq!(store.read_or_default::<Map>(), Map::new());
        }
    }

    #[test]
    fn updates_and_writes_read_back_the_same_from_a_file_and_memory() {
        let dir = TempDir::new("config-file", "round-trip");
        for store in stores(&dir) {
            let len = store
                .update(
                    |m: &mut Map| {
                        m.insert("a".into(), 1);
                    },
                    |m| m.len(),
                )
                .unwrap();
            assert_eq!(len, 1);
            let got = store
                .update_strict(|m: &mut Map| m.insert("b".into(), 2).is_none(), |m| m)
                .unwrap();
            assert_eq!(got, Map::from([("a".into(), 1), ("b".into(), 2)]));
            assert_eq!(store.read_strict::<Map>().unwrap(), got);

            store.write(&Map::from([("c".into(), 3)])).unwrap();
            assert_eq!(store.read_or_default::<Map>(), Map::from([("c".into(), 3)]));
        }
    }

    #[test]
    fn an_unchanged_strict_update_writes_nothing() {
        let dir = TempDir::new("config-file", "no-change");
        let [file, memory] = stores(&dir);
        file.update_strict(|_: &mut Map| false, drop).unwrap();
        assert!(!file.path().unwrap().exists(), "no file for a no-op");
        memory.update_strict(|_: &mut Map| false, drop).unwrap();
        let ConfigFile::Memory(bytes) = &memory else {
            unreachable!()
        };
        assert!(locked(bytes).is_empty());
    }

    #[test]
    fn a_strict_update_refuses_an_unreadable_file() {
        let dir = TempDir::new("config-file", "unreadable");
        let [store, _] = stores(&dir);
        std::fs::write(store.path().unwrap(), b"not json").unwrap();
        assert!(store.read_strict::<Map>().is_err());
        assert_eq!(store.read_or_default::<Map>(), Map::new());
        assert!(store
            .update_strict(|m: &mut Map| m.insert("a".into(), 1).is_none(), drop)
            .is_err());
        assert_eq!(std::fs::read(store.path().unwrap()).unwrap(), b"not json");
    }
}
