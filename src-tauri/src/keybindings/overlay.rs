//! Desktop-private keybinding overlay: the only file this application ever
//! writes for keyboard shortcuts.
//!
//! The overlay is plain JSON (not YAML). `serde_json` is already a dependency;
//! writing YAML would require a new crate or a hand-rolled emitter for no
//! user-visible gain, because omp never reads this file.
//!
//! On-disk shape (one named field so a future key can be added without a
//! format break):
//!
//! ```json
//! { "bindings": { "desktop.panel.changes": ["ctrl+g"], "app.plan.toggle": [] } }
//! ```
//!
//! **A malformed or unreadable file is an `Err`, never silently replaced.**
//! Replacing it would discard every rebind the user made. The error is
//! surfaced to the Shortcuts screen; dispatch still works because the frontend
//! falls back to omp + defaults.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::json_store;
use crate::keybindings::{yaml, ACTION_IDS};

// ── on-disk representation ────────────────────────────────────────────────────

// The one-level `{ bindings: … }` wrapper was chosen so a future top-level
// field (e.g. `version`, `migrated_at`) can be added without a format break.
// Note: unknown top-level fields are currently *dropped* on read because
// `OverlayFile` has no `#[serde(flatten)]` catch-all; when adding a new field,
// add it to this struct first before writing it to disk.
#[derive(Default, Serialize, Deserialize)]
struct OverlayFile {
    #[serde(default)]
    bindings: BTreeMap<String, Vec<String>>,
}

// ── OverlayStore ─────────────────────────────────────────────────────────────

/// Manages `<app config dir>/keybindings.json`, the desktop-private overlay
/// that stores user rebinds for actions in the desktop's own registry.
pub struct OverlayStore {
    path: PathBuf,
}

impl OverlayStore {
    /// Create a store pointing at `path`. The file need not exist yet.
    pub const fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// The absolute path of the overlay file (used by the Shortcuts footer).
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Read the current overlay. A missing file returns an empty map; a
    /// malformed or unreadable file returns `Err`.
    pub fn read(&self) -> Result<BTreeMap<String, Vec<String>>, String> {
        read_file(&self.path)
    }

    /// Set `action` → `keys` in the overlay and return the updated map.
    ///
    /// Rejects:
    /// - an unknown action (`action` not in `ACTION_IDS`)
    /// - a chord that canonicalises to an empty base (invalid)
    ///
    /// An empty `keys` slice stores `[]` — the explicit "disabled" state that
    /// beats both omp's config and the registry default.
    ///
    /// Refuses to write if the current file is malformed.
    pub fn set(
        &self,
        action: &str,
        keys: &[String],
    ) -> Result<BTreeMap<String, Vec<String>>, String> {
        if !ACTION_IDS.contains(&action) {
            return Err("unknown action".to_string());
        }
        let canonical: Vec<String> = keys
            .iter()
            .map(|k| {
                let c = yaml::canonical_chord(k);
                if c.is_empty() {
                    Err(format!("invalid chord: {k:?}"))
                } else {
                    Ok(c)
                }
            })
            .collect::<Result<_, _>>()?;

        self.mutate(|bindings| {
            bindings.insert(action.to_string(), canonical);
        })
    }

    /// Remove `action` from the overlay (a no-op when absent) and return the
    /// updated map.
    ///
    /// Refuses to write if the current file is malformed.
    pub fn remove(&self, action: &str) -> Result<BTreeMap<String, Vec<String>>, String> {
        self.mutate(|bindings| {
            bindings.remove(action);
        })
    }

    // ── internal ─────────────────────────────────────────────────────────────

    /// Read, modify with `f`, write atomically, return the new bindings.
    fn mutate(
        &self,
        f: impl FnOnce(&mut BTreeMap<String, Vec<String>>),
    ) -> Result<BTreeMap<String, Vec<String>>, String> {
        json_store::with_lock_str(&self.path.with_extension("lock"), || {
            let mut file_data = read_file_strict(&self.path)?;
            f(&mut file_data.bindings);
            let serialised = serde_json::to_vec_pretty(&file_data).map_err(|e| e.to_string())?;
            // `json_store::with_lock` already calls `fs::create_dir_all` on the
            // lock-file's parent before acquiring — same directory as
            // `keybindings.json` — so no explicit `create_dir_all` is needed here.
            json_store::write_atomic(&self.path, &serialised).map_err(|e| e.to_string())?;
            Ok(file_data.bindings)
        })
    }
}

// ── file helpers ──────────────────────────────────────────────────────────────

/// Read the overlay file. `NotFound` ⇒ empty map; any other error ⇒ `Err`.
fn read_file(path: &Path) -> Result<BTreeMap<String, Vec<String>>, String> {
    read_file_strict(path).map(|f| f.bindings)
}

/// Like `read_file` but returns the full `OverlayFile` (needed by `mutate`
/// so the outer struct survives a round-trip without dropping future keys).
fn read_file_strict(path: &Path) -> Result<OverlayFile, String> {
    match fs::read(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(OverlayFile::default()),
        Err(e) => Err(e.to_string()),
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn make_store() -> (OverlayStore, PathBuf) {
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        // Include the process id so parallel test processes (`cargo test`
        // running twice concurrently) don't collide and delete each other's
        // scratch directories — same pattern as profiles.rs and json_store.rs.
        let dir = std::env::temp_dir().join(format!("omp-overlay-{}-{}", std::process::id(), id));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create test dir");
        let path = dir.join("keybindings.json");
        (OverlayStore::new(path), dir)
    }

    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_file_reads_as_empty() {
        let (store, dir) = make_store();
        assert_eq!(store.read().unwrap().len(), 0);
        cleanup(&dir);
    }

    #[test]
    fn set_round_trips() {
        let (store, dir) = make_store();
        let result = store
            .set("desktop.panel.changes", &["ctrl+g".to_string()])
            .unwrap();
        assert_eq!(result["desktop.panel.changes"], ["ctrl+g"]);
        // Survives a fresh read.
        let read = store.read().unwrap();
        assert_eq!(read["desktop.panel.changes"], ["ctrl+g"]);
        cleanup(&dir);
    }

    #[test]
    fn set_canonicalises_chords() {
        let (store, dir) = make_store();
        store
            .set("desktop.panel.changes", &["Ctrl+G".to_string()])
            .unwrap();
        assert_eq!(store.read().unwrap()["desktop.panel.changes"], ["ctrl+g"]);
        cleanup(&dir);
    }

    #[test]
    fn set_empty_keys_stores_explicit_disabled() {
        let (store, dir) = make_store();
        store.set("desktop.panel.changes", &[]).unwrap();
        let read = store.read().unwrap();
        assert!(read.contains_key("desktop.panel.changes"));
        assert_eq!(read["desktop.panel.changes"], [] as [String; 0]);
        cleanup(&dir);
    }

    #[test]
    fn remove_of_absent_action_is_noop() {
        let (store, dir) = make_store();
        store
            .set("desktop.panel.changes", &["ctrl+g".to_string()])
            .unwrap();
        // Remove a key that was never set — must not error, must not disturb others.
        store.remove("desktop.panel.todo").unwrap();
        assert!(store.read().unwrap().contains_key("desktop.panel.changes"));
        cleanup(&dir);
    }

    #[test]
    fn two_sequential_sets_both_survive() {
        let (store, dir) = make_store();
        store
            .set("desktop.panel.changes", &["ctrl+g".to_string()])
            .unwrap();
        store
            .set("desktop.panel.todo", &["ctrl+u".to_string()])
            .unwrap();
        let read = store.read().unwrap();
        assert_eq!(read["desktop.panel.changes"], ["ctrl+g"]);
        assert_eq!(read["desktop.panel.todo"], ["ctrl+u"]);
        cleanup(&dir);
    }

    #[test]
    fn set_on_unknown_action_errors_and_leaves_file_untouched() {
        let (store, dir) = make_store();
        store
            .set("desktop.panel.changes", &["ctrl+g".to_string()])
            .unwrap();
        let err = store
            .set("not.a.real.action", &["ctrl+x".to_string()])
            .unwrap_err();
        assert!(err.contains("unknown action"), "got: {err}");
        // The previously-written file is intact.
        assert_eq!(store.read().unwrap()["desktop.panel.changes"], ["ctrl+g"]);
        cleanup(&dir);
    }

    #[test]
    fn invalid_chord_errors_without_writing() {
        let (store, dir) = make_store();
        let err = store
            .set("desktop.panel.changes", &["ctrl+".to_string()])
            .unwrap_err();
        assert!(err.contains("invalid chord"), "got: {err}");
        // Nothing was written.
        assert_eq!(store.read().unwrap().len(), 0);
        cleanup(&dir);
    }

    #[test]
    fn corrupt_file_makes_read_and_set_error_without_rewriting() {
        let (store, dir) = make_store();
        fs::write(&store.path, b"this is not json").unwrap();
        // read() must error.
        assert!(store.read().is_err());
        let before = fs::read(&store.path).unwrap();
        // set() must also error and leave the bytes unchanged.
        store
            .set("desktop.panel.changes", &["ctrl+g".to_string()])
            .unwrap_err();
        let after = fs::read(&store.path).unwrap();
        assert_eq!(before, after, "corrupt file must not be overwritten");
        // remove() must error too.
        store.remove("desktop.panel.changes").unwrap_err();
        assert_eq!(fs::read(&store.path).unwrap(), before);
        cleanup(&dir);
    }

    #[test]
    fn set_then_remove_leaves_key_absent() {
        let (store, dir) = make_store();
        store
            .set("desktop.panel.changes", &["ctrl+g".to_string()])
            .unwrap();
        store.remove("desktop.panel.changes").unwrap();
        assert!(!store.read().unwrap().contains_key("desktop.panel.changes"));
        cleanup(&dir);
    }
}
