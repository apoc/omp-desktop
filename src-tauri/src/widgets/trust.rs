//! One-time approval of widget plugins: a plugin never runs until the user
//! approved its exact [`fingerprint`] (argv plus the contents of every script
//! the argv names), and any change to either needs approval again.
//!
//! Threat model: approving happens through the webview
//! (`widgets_approve(pluginId, fingerprint)`), like tool-approval answers. A
//! compromised webview could approve, but it can already send prompts and
//! answer tool approvals, so this adds no new power. What approval defends
//! against is a config or script change made outside the desktop UI — the
//! agent editing `widgets.json` or a plugin script under write-mode approval.
//! `widget-approvals.json` is an ordinary user file (like `approval-rules/`):
//! anything with arbitrary user-file write can edit it, just as it can edit
//! `~/.bashrc`.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use sha2::{Digest, Sha256};

use crate::widgets::config::PluginEntry;
use omp_desktop_core::json_store;

/// Domain separator, bumped if the hashed layout ever changes (which
/// invalidates every approval — intended).
const DOMAIN: &[u8] = b"omp-widget-v1\0";
/// Scripts larger than this contribute `len + mtime` instead of their bytes,
/// so a huge interpreter binary named in argv never costs a full read per run.
pub(super) const MAX_HASHED_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// Read chunk for streaming a script into the hash, and for comparing it
/// with its stored copy (`snapshot.rs`): one chunk, one read of the copy.
pub(super) const CHUNK_BYTES: usize = 16 * 1024;
const APPROVALS_VERSION: u32 = 1;
/// Length of [`fingerprint`]'s lowercase hex digest.
const FINGERPRINT_HEX_LEN: usize = 64;

/// Hex SHA-256 over the argv and every regular file an absolute argv element
/// names. See the module docs for what it protects. A run hashes through
/// `snapshot.rs` instead, which computes the same value from the bytes it
/// copies for the run.
pub fn fingerprint(entry: &PluginEntry) -> String {
    let mut hasher = hash_argv(entry);
    for (index, arg) in entry.command.iter().enumerate() {
        if let Some((path, _)) = hash_file_header(&mut hasher, index, arg) {
            // An unreadable file hashed a marker instead; nothing to report.
            let _ = hash_contents(path, &mut hasher, |_| Ok(()));
        }
    }
    finish(hasher)
}

/// Whether `s` has the shape of a [`fingerprint`]: 64 lowercase hex digits.
/// What comes from the webview or the approvals file is checked with this
/// before it is compared, or used as a directory name (`snapshot.rs`).
pub fn is_fingerprint(s: &str) -> bool {
    s.len() == FINGERPRINT_HEX_LEN
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A hasher fed the domain separator and the argv.
pub(super) fn hash_argv(entry: &PluginEntry) -> Sha256 {
    let mut hasher = Sha256::new();
    hasher.update(DOMAIN);
    hasher.update(len_bytes(entry.command.len()));
    for arg in &entry.command {
        hasher.update(arg.as_bytes());
        hasher.update([0]);
    }
    hasher
}

/// Hash what argv element `index` contributes besides its text, if it is an
/// absolute path to a regular file. `Some` means its contents go in next,
/// through [`hash_contents`]; a file over [`MAX_HASHED_FILE_BYTES`] is
/// complete after its size and mtime.
pub(super) fn hash_file_header<'a>(
    hasher: &mut Sha256,
    index: usize,
    arg: &'a str,
) -> Option<(&'a Path, fs::Metadata)> {
    let path = Path::new(arg);
    if !path.is_absolute() {
        return None;
    }
    // `metadata` follows symlinks: the target's contents are what runs.
    let meta = fs::metadata(path).ok().filter(fs::Metadata::is_file)?;
    hasher.update(len_bytes(index));
    hasher.update(meta.len().to_le_bytes());
    if meta.len() > MAX_HASHED_FILE_BYTES {
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_nanos());
        hasher.update(b"large\0");
        hasher.update(mtime.to_le_bytes());
        return None;
    }
    hasher.update(b"file\0");
    Some((path, meta))
}

pub(super) fn finish(hasher: Sha256) -> String {
    json_store::hex_lower(&hasher.finalize())
}

fn len_bytes(n: usize) -> [u8; 8] {
    u64::try_from(n).unwrap_or(u64::MAX).to_le_bytes()
}

/// Stream `path` into `hasher` one chunk at a time, handing each chunk to
/// `sink` as it is hashed, then the byte count actually read (the file may
/// change between `metadata` and the read). An unreadable file hashes a
/// marker instead, so it never matches its content, and is an error; so is a
/// failing `sink`, which leaves the hash unfinished.
pub(super) fn hash_contents(
    path: &Path,
    hasher: &mut Sha256,
    mut sink: impl FnMut(&[u8]) -> io::Result<()>,
) -> io::Result<()> {
    let mut file = File::open(path).inspect_err(|_| hasher.update(b"unreadable\0"))?;
    let mut buf = [0u8; CHUNK_BYTES];
    let mut total: u64 = 0;
    loop {
        match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                hasher.update(&buf[..n]);
                sink(&buf[..n])?;
                total = total.saturating_add(u64::try_from(n).unwrap_or(u64::MAX));
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) => {
                hasher.update(b"unreadable\0");
                return Err(e);
            }
        }
    }
    hasher.update(total.to_le_bytes());
    Ok(())
}

/// Approval state of one plugin's current fingerprint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Approval {
    Approved,
    /// Never approved.
    Pending,
    /// Approved under another fingerprint: argv or a script changed.
    Changed,
}

#[derive(serde::Deserialize, Default)]
struct ApprovalFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    approved: BTreeMap<String, String>,
}

#[derive(serde::Serialize)]
struct ApprovalFileRef<'a> {
    version: u32,
    approved: &'a BTreeMap<String, String>,
}

/// `<app config>/widget-approvals.json`:
/// `{ "version": 1, "approved": { "<id>": "<fingerprint>" } }`.
///
/// Entries of plugins no longer in `widgets.json` are kept, so removing and
/// re-adding an unchanged plugin needs no new approval.
#[derive(Debug, Default)]
pub struct ApprovalStore {
    /// `None` when the app config dir is unknown: nothing can be approved.
    path: Option<PathBuf>,
    approved: BTreeMap<String, String>,
}

impl ApprovalStore {
    /// Read the store at `path` (missing or unreadable file = empty).
    pub fn load(path: Option<PathBuf>) -> Self {
        let mut store = Self {
            path,
            approved: BTreeMap::new(),
        };
        store.reload();
        store
    }

    /// Re-read the file, replacing the in-memory approvals. A file that cannot
    /// be used approves nothing.
    pub fn reload(&mut self) {
        let Some(path) = &self.path else {
            self.approved.clear();
            return;
        };
        self.approved = read_file(path).unwrap_or_else(|e| {
            eprintln!("[omp-desktop] {e}, no widget is approved");
            BTreeMap::new()
        });
    }

    /// The fingerprint `id` was approved under, if any.
    pub fn approved(&self, id: &str) -> Option<&str> {
        self.approved.get(id).map(String::as_str)
    }

    /// Whether some plugin is approved under `fingerprint`.
    pub fn holds(&self, fingerprint: &str) -> bool {
        self.approved.values().any(|fp| fp == fingerprint)
    }

    pub fn status(&self, id: &str, fingerprint: &str) -> Approval {
        match self.approved(id) {
            Some(fp) if fp == fingerprint => Approval::Approved,
            Some(_) => Approval::Changed,
            None => Approval::Pending,
        }
    }

    /// Approve `id` under `current` (the freshly computed fingerprint) and
    /// persist atomically. `presented` is what the user saw on the approval
    /// card; a mismatch means the plugin changed after the card was drawn, so
    /// the approval is refused rather than granted for something unseen.
    ///
    /// Only `id` is written, into the file as it is on disk now: the in-memory
    /// map can be older than the file (the user deleted an entry to revoke it
    /// and has not reloaded yet), and writing it back would undo that. Memory
    /// keeps such a revoked entry until the next [`Self::reload`], as documented.
    ///
    /// # Errors
    /// Stale `presented`, no config directory, an existing file that cannot
    /// be used (unreadable, malformed, unknown version — refused rather than
    /// overwritten, which would drop every other approval), or a failed write.
    /// The in-memory state is then left unchanged.
    pub fn approve(&mut self, id: &str, presented: &str, current: &str) -> Result<(), String> {
        if presented != current {
            return Err(format!(
                "widget \"{id}\" changed since it was shown — review it again"
            ));
        }
        let Some(path) = &self.path else {
            return Err("no app config directory: widget approvals cannot be saved".to_owned());
        };
        let mut on_disk =
            read_file(path).map_err(|e| format!("{e}: fix or delete it to approve widgets"))?;
        on_disk.insert(id.to_owned(), current.to_owned());
        write(path, &on_disk)?;
        self.approved.insert(id.to_owned(), current.to_owned());
        Ok(())
    }
}

/// The approvals in the file at `path`. A missing file, or one without a
/// version and approvals (`{}`), is empty; an unreadable or malformed file,
/// or one with another version, is an error naming the file.
fn read_file(path: &Path) -> Result<BTreeMap<String, String>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let file: ApprovalFile =
        serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    if file.version == APPROVALS_VERSION || (file.version == 0 && file.approved.is_empty()) {
        Ok(file.approved)
    } else {
        Err(format!(
            "{}: unsupported version {}",
            path.display(),
            file.version
        ))
    }
}

fn write(path: &Path, approved: &BTreeMap<String, String>) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let bytes = serde_json::to_vec_pretty(&ApprovalFileRef {
        version: APPROVALS_VERSION,
        approved,
    })
    .map_err(|e| e.to_string())?;
    json_store::write_atomic(path, &bytes).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::widgets::config::test_entry;

    /// A scratch directory removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("omp-widget-trust-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn fingerprint_is_stable_and_follows_argv() {
        let a = test_entry(&["sh", "-c", "echo {}"]);
        assert_eq!(fingerprint(&a), fingerprint(&a));
        assert_eq!(fingerprint(&a).len(), 64);
        assert_ne!(
            fingerprint(&a),
            fingerprint(&test_entry(&["sh", "-c", "echo []"]))
        );
        // NUL termination keeps the argument boundaries in the hash.
        assert_ne!(
            fingerprint(&test_entry(&["ab", "c"])),
            fingerprint(&test_entry(&["a", "bc"]))
        );
    }

    #[test]
    fn fingerprint_changes_with_script_content_only() {
        let dir = Scratch::new("content");
        let script = dir.0.join("plugin.sh");
        fs::write(&script, "echo '{\"v\":1}'\n").unwrap();
        let e = test_entry(&["sh", script.to_str().unwrap()]);
        let before = fingerprint(&e);
        assert_eq!(
            before,
            fingerprint(&e),
            "unchanged script, unchanged fingerprint"
        );

        // Same length, different bytes: content is hashed, not just metadata.
        fs::write(&script, "echo '{\"v\":2}'\n").unwrap();
        let after = fingerprint(&e);
        assert_ne!(before, after);

        fs::write(&script, "echo '{\"v\":1}'\n").unwrap();
        assert_eq!(
            before,
            fingerprint(&e),
            "restored content restores the fingerprint"
        );
    }

    #[test]
    fn fingerprint_ignores_directories_and_missing_paths() {
        let dir = Scratch::new("dirs");
        let missing = dir.0.join("missing.sh");
        let e = test_entry(&["sh", missing.to_str().unwrap()]);
        let before = fingerprint(&e);
        fs::create_dir(&missing).unwrap();
        assert_eq!(before, fingerprint(&e), "a directory contributes nothing");
        fs::remove_dir(&missing).unwrap();
        fs::write(&missing, "x").unwrap();
        assert_ne!(
            before,
            fingerprint(&e),
            "a file appearing at the path counts"
        );
    }

    #[test]
    fn store_round_trips_and_reports_status() {
        let dir = Scratch::new("store");
        let path = || dir.0.join("nested").join("widget-approvals.json");
        let mut store = ApprovalStore::load(Some(path()));
        assert_eq!(store.status("probe", "aa"), Approval::Pending);
        store.approve("probe", "aa", "aa").unwrap();

        let reread = ApprovalStore::load(Some(path()));
        assert_eq!(reread.status("probe", "aa"), Approval::Approved);
        assert_eq!(reread.status("probe", "bb"), Approval::Changed);
        assert_eq!(reread.status("other", "aa"), Approval::Pending);

        let raw: serde_json::Value = serde_json::from_slice(&fs::read(path()).unwrap()).unwrap();
        assert_eq!(
            raw,
            serde_json::json!({ "version": 1, "approved": { "probe": "aa" } })
        );
    }

    #[test]
    fn approving_a_stale_fingerprint_is_rejected() {
        let dir = Scratch::new("stale");
        let script = dir.0.join("plugin.sh");
        fs::write(&script, "echo {}\n").unwrap();
        let e = test_entry(&["sh", script.to_str().unwrap()]);
        let shown = fingerprint(&e);
        fs::write(&script, "rm -rf ~\n").unwrap();

        let path = || dir.0.join("widget-approvals.json");
        let mut store = ApprovalStore::load(Some(path()));
        let err = store
            .approve("probe", &shown, &fingerprint(&e))
            .unwrap_err();
        assert!(err.contains("changed"), "{err}");
        assert_eq!(store.approved("probe"), None);
        assert!(!path().exists(), "a refused approval writes nothing");
    }

    #[test]
    fn unknown_version_approves_nothing() {
        let dir = Scratch::new("version");
        let path = dir.0.join("widget-approvals.json");
        fs::write(&path, r#"{"version":2,"approved":{"probe":"aa"}}"#).unwrap();
        let store = ApprovalStore::load(Some(path));
        assert_eq!(store.status("probe", "aa"), Approval::Pending);
    }

    #[test]
    fn approving_keeps_a_revocation_made_on_disk() {
        let dir = Scratch::new("revoke");
        let path = || dir.0.join("widget-approvals.json");
        let mut store = ApprovalStore::load(Some(path()));
        store.approve("a", "aa", "aa").unwrap();
        store.approve("b", "bb", "bb").unwrap();
        // The user revokes `b` by editing the file, then approves `c` before
        // reloading: `b` must stay revoked on disk.
        fs::write(path(), r#"{"version":1,"approved":{"a":"aa"}}"#).unwrap();
        store.approve("c", "cc", "cc").unwrap();
        let raw: serde_json::Value = serde_json::from_slice(&fs::read(path()).unwrap()).unwrap();
        assert_eq!(
            raw,
            serde_json::json!({ "version": 1, "approved": { "a": "aa", "c": "cc" } })
        );
        store.reload();
        assert_eq!(store.status("b", "bb"), Approval::Pending);
        assert_eq!(store.status("c", "cc"), Approval::Approved);
    }

    #[test]
    fn approving_never_overwrites_an_unusable_file() {
        let dir = Scratch::new("unusable");
        let path = || dir.0.join("widget-approvals.json");
        for bad in [
            // A revoke that left a trailing comma.
            r#"{"version":1,"approved":{"a":"aa",}}"#,
            r#"{"version":2,"approved":{"a":"aa"}}"#,
        ] {
            fs::write(path(), bad).unwrap();
            let mut store = ApprovalStore::load(Some(path()));
            let err = store.approve("c", "cc", "cc").unwrap_err();
            assert!(err.contains("fix or delete"), "{err}");
            assert_eq!(fs::read_to_string(path()).unwrap(), bad, "file untouched");
            assert_eq!(store.status("c", "cc"), Approval::Pending);
        }
    }

    #[test]
    fn approving_without_a_config_dir_fails() {
        let mut store = ApprovalStore::load(None);
        assert!(store.approve("probe", "aa", "aa").is_err());
        assert_eq!(store.status("probe", "aa"), Approval::Pending);
    }
}
