//! Atomic write + snapshot/rollback primitives for any JSON (or other small)
//! state this app persists to disk — approval-rule files today, session
//! metadata in the future. Three independent pieces:
//!
//! - [`write_atomic`] / [`sweep_orphan_temp_files`] — write-to-temp-then-rename
//!   so a crash mid-write never corrupts the destination file, plus cleanup
//!   for temp files left behind by a previous crash.
//! - [`SnapshotRing`] — a small content-addressed history of a file's past
//!   contents, so a bad write (or a bad read of a good write) can be rolled
//!   back to the last known-good version.
//! - [`with_lock`] — a best-effort, cross-process advisory lock with
//!   staleness recovery, for guarding the read-modify-write cycle around a
//!   shared file.

use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

// ── atomic write ────────────────────────────────────────────────────────────

/// Monotonic counter appended to temp file names so two writes from the same
/// process land on different temp files even within the same millisecond.
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Build the temp file path [`write_atomic`] uses for `path`: same directory,
/// named `<file_name>.<pid>-<counter>.tmp`. Pulled out as a pure function so
/// the naming scheme is unit-testable without touching the filesystem.
fn temp_path_for(path: &Path) -> PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("state");
    path.with_file_name(format!("{file_name}.{}-{counter}.tmp", std::process::id()))
}

/// Write `bytes` to `path` without ever leaving a partially-written file at
/// the destination. Writes to a uniquely-named temp file in `path`'s
/// directory, `fsync`s it, then renames it over `path`.
///
/// `rename` is atomic on POSIX when source and destination share a
/// filesystem: the destination always has either the old contents or the
/// new ones, never a partial write. On Windows, `std::fs::rename` maps to
/// `MoveFileExW`/`SetFileInformationByHandle` with replace semantics, so the
/// destination is still fully replaced — but the platform does not document
/// that replace step as atomic the way POSIX `rename(2)` is, so a crash
/// exactly during the replace is not covered by the same guarantee there.
///
/// Runs [`sweep_orphan_temp_files`] for `path`'s directory and file name
/// first, best-effort, so temp files abandoned by a process that crashed
/// mid-write on a previous run don't pile up forever.
///
/// # Errors
/// Returns an error if the temp file can't be created/written/synced, or if
/// the final rename fails (e.g. `path`'s directory doesn't exist, or a
/// permissions problem). The temp file is removed best-effort on any
/// failure path; the original error is always returned, never masked by a
/// cleanup failure.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if let Some(base) = path.file_name().and_then(|n| n.to_str()) {
        let _ = sweep_orphan_temp_files(dir, base);
    }

    let temp_path = temp_path_for(path);
    let write_result = File::create(&temp_path).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });

    match write_result {
        Ok(()) => {
            let rename_result = fs::rename(&temp_path, path);
            if rename_result.is_err() {
                let _ = fs::remove_file(&temp_path);
            }
            rename_result
        }
        Err(err) => {
            let _ = fs::remove_file(&temp_path);
            Err(err)
        }
    }
}

/// Remove leftover `<base_name>.*.tmp` files in `dir` — the residue of a
/// process that crashed between creating a [`write_atomic`] temp file and
/// renaming it over the destination. `write_atomic` calls this itself,
/// scoped to its own directory/base name, before every write; it's also
/// exposed publicly for callers who want to sweep a directory once at
/// startup regardless of whether a write happens this run.
///
/// # Errors
/// Returns an error if `dir` can't be read. Individual file removals inside
/// the sweep are best-effort: a file that disappears or can't be removed
/// (e.g. a permissions race) is silently skipped rather than aborting the
/// whole sweep.
pub fn sweep_orphan_temp_files(dir: &Path, base_name: &str) -> io::Result<usize> {
    let prefix = format!("{base_name}.");
    let mut removed = 0usize;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let has_tmp_extension = Path::new(name)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("tmp"));
        if name.starts_with(&prefix) && has_tmp_extension && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

// ── content hashing ─────────────────────────────────────────────────────────

/// Hex-encoded SHA-256 of `bytes`, used as the content-addressed snapshot id.
/// SHA-256 (rather than a cheaper non-cryptographic hash) is deliberate:
/// snapshot ids are meant to be tamper-evident, so [`SnapshotRing::restore`]
/// and [`SnapshotRing::restore_latest`] can detect on-disk corruption by
/// simply re-hashing and comparing to the filename.
fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

// ── snapshot ring ────────────────────────────────────────────────────────────

/// Metadata sidecar written alongside each snapshot as `<id>.meta.json`.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct SnapshotMeta {
    reason: String,
    created_at: u64,
}

/// One snapshot's on-disk identity: content-hash id and last-modified time.
/// Used to order candidates newest-first (`restore_latest`) and to pick
/// prune victims oldest-first (`prune`).
struct SnapshotEntry {
    id: String,
    modified: SystemTime,
}

/// A small content-addressed history of a file's past contents, kept as
/// `<dir>/<hex_sha256>.json` plus a `<hex_sha256>.meta.json` sidecar
/// recording why and when the snapshot was taken. After each new snapshot,
/// entries beyond `retain` (oldest first, by file modified time) are pruned
/// so the ring never grows without bound.
pub struct SnapshotRing {
    dir: PathBuf,
    retain: usize,
}

impl SnapshotRing {
    /// Create a ring rooted at `dir`, retaining the `retain` most recent
    /// snapshots. `dir` is created lazily on the first [`snapshot`] call,
    /// not here — constructing a `SnapshotRing` never touches the
    /// filesystem.
    ///
    /// [`snapshot`]: SnapshotRing::snapshot
    #[must_use]
    pub const fn new(dir: PathBuf, retain: usize) -> Self {
        Self { dir, retain }
    }

    fn snapshot_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    fn meta_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.meta.json"))
    }

    /// Write `bytes` as a new snapshot tagged with `reason`, returning its
    /// content-hash id. If a snapshot with identical content already
    /// exists, this overwrites its file (an atomic no-op content-wise) and
    /// refreshes its meta sidecar and mtime, so an unchanged file re-saved
    /// repeatedly doesn't create duplicate ring entries. Prunes snapshots
    /// beyond `retain` afterward, oldest (by mtime) first.
    ///
    /// # Errors
    /// Returns an error if `dir` can't be created, or if writing the
    /// snapshot or its meta sidecar fails.
    pub fn snapshot(&self, bytes: &[u8], reason: &str) -> io::Result<String> {
        fs::create_dir_all(&self.dir)?;
        let id = hex_sha256(bytes);
        write_atomic(&self.snapshot_path(&id), bytes)?;

        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let meta = SnapshotMeta {
            reason: reason.to_string(),
            created_at,
        };
        let meta_bytes = serde_json::to_vec_pretty(&meta)
            .map_err(|err| io::Error::new(ErrorKind::InvalidData, err))?;
        write_atomic(&self.meta_path(&id), &meta_bytes)?;

        self.prune()?;
        Ok(id)
    }

    /// List snapshot ids present in `dir` with their mtimes, newest first.
    /// Missing directory (no snapshots taken yet) is treated as empty
    /// rather than an error.
    fn list_entries(&self) -> io::Result<Vec<SnapshotEntry>> {
        let read_dir = match fs::read_dir(&self.dir) {
            Ok(rd) => rd,
            Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(err),
        };

        let mut entries = Vec::new();
        for entry in read_dir {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            // Sidecars are `<id>.meta.json`; stripping `.json` from those
            // would wrongly yield `<id>.meta` as an id, so skip them.
            let Some(id) = name.strip_suffix(".json").filter(|id| {
                !Path::new(id)
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("meta"))
            }) else {
                continue;
            };
            let modified = entry.metadata()?.modified()?;
            entries.push(SnapshotEntry {
                id: id.to_string(),
                modified,
            });
        }
        entries.sort_by_key(|e| std::cmp::Reverse(e.modified));
        Ok(entries)
    }

    /// Remove snapshots (and their meta sidecars) beyond `retain`, oldest
    /// first. Best-effort: a removal failure for one stale entry doesn't
    /// abort pruning the rest.
    fn prune(&self) -> io::Result<()> {
        for stale in self.list_entries()?.iter().skip(self.retain) {
            let _ = fs::remove_file(self.snapshot_path(&stale.id));
            let _ = fs::remove_file(self.meta_path(&stale.id));
        }
        Ok(())
    }

    /// Read the most recent valid snapshot's bytes. A snapshot whose
    /// content no longer hashes to its filename (on-disk corruption — a
    /// crash mid-write outside this module, disk bitrot, manual editing) is
    /// quarantined by renaming it to `<id>.corrupt`, and the next-most-recent
    /// snapshot is tried instead. Returns `Ok(None)` only once every
    /// candidate has been exhausted without finding a valid one.
    ///
    /// # Errors
    /// Returns an error if the snapshot directory can't be listed, or a
    /// candidate file exists but can't be read for a reason other than it
    /// having disappeared underneath us.
    pub fn restore_latest(&self) -> io::Result<Option<Vec<u8>>> {
        for entry in self.list_entries()? {
            let path = self.snapshot_path(&entry.id);
            let bytes = match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(err) if err.kind() == ErrorKind::NotFound => continue,
                Err(err) => return Err(err),
            };
            if hex_sha256(&bytes) == entry.id {
                return Ok(Some(bytes));
            }
            let _ = fs::rename(&path, self.dir.join(format!("{}.corrupt", entry.id)));
        }
        Ok(None)
    }

    /// Restore a specific snapshot by its content-hash id. Unlike
    /// [`restore_latest`], this never quarantines on a hash mismatch — it's
    /// a targeted read of a specific id, so corruption is reported as an
    /// error rather than silently worked around.
    ///
    /// Public rollback-by-id API for a future "pick a version to restore"
    /// UI. `restore_latest` is this crate's only current consumer of the
    /// ring's read path (automatic recovery in `approval::RuleBook`);
    /// nothing yet needs a targeted restore, but the method is exercised
    /// by this module's own tests (`restore_by_id_reports_corruption_...`)
    /// and kept rather than deleted since rewriting it later would just
    /// reproduce this same, already-verified logic.
    ///
    /// # Errors
    /// Returns an `io::Error` if the snapshot file doesn't exist or can't
    /// be read, or one of kind [`ErrorKind::InvalidData`] if its content
    /// doesn't hash to `id`.
    #[allow(dead_code)]
    pub fn restore(&self, id: &str) -> io::Result<Vec<u8>> {
        let bytes = fs::read(self.snapshot_path(id))?;
        if hex_sha256(&bytes) == id {
            Ok(bytes)
        } else {
            Err(io::Error::new(
                ErrorKind::InvalidData,
                format!("snapshot {id} content does not match its hash"),
            ))
        }
    }
}

// ── advisory lock ────────────────────────────────────────────────────────────

/// Number of takeover attempts against an apparently-stale lock before
/// giving up and reporting it as held.
const LOCK_TAKEOVER_ATTEMPTS: u32 = 10;
/// Delay between takeover attempts. This reduces, but cannot eliminate, the
/// race against another process independently deciding the same lock is
/// stale — see [`with_lock`]'s doc comment.
const LOCK_TAKEOVER_DELAY: Duration = Duration::from_millis(25);

/// Render this process's lock-ownership marker: `{pid}:{unix_timestamp}`.
fn lock_contents() -> String {
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    format!("{}:{created_at}", std::process::id())
}

/// Parse `pid:timestamp` lock file contents. Returns `None` if the contents
/// aren't in the expected shape (e.g. truncated by an interrupted write, or
/// from an incompatible future format) — treated as stale by the caller,
/// since there's nothing sensible to compare against.
fn parse_lock_contents(contents: &str) -> Option<(u32, u64)> {
    let (pid, ts) = contents.trim().split_once(':')?;
    Some((pid.parse().ok()?, ts.parse().ok()?))
}

/// Whether the process identified by `pid` is still alive. On Unix this
/// sends signal 0 via `kill(2)`, which performs no action beyond an
/// existence/permission check; `ESRCH` means the process is gone, `EPERM`
/// means it exists but is owned by someone else (still alive), and any
/// other outcome is treated conservatively as "alive" so a lock is never
/// stolen based on an inconclusive check. Non-Unix targets have no portable
/// liveness probe in `std`, so this always reports "alive" there and
/// staleness detection falls back entirely to the timestamp/`stale_after`
/// comparison in [`lock_is_stale`].
#[cfg(unix)]
fn pid_is_alive(pid: u32) -> bool {
    // SAFETY: signal 0 sends no actual signal; it only validates that the
    // pid exists and is signalable by us. No memory is touched beyond what
    // `libc::kill`'s FFI signature requires.
    if unsafe { libc::kill(pid.cast_signed(), 0) } == 0 {
        return true;
    }
    io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(not(unix))]
const fn pid_is_alive(_pid: u32) -> bool {
    true
}

/// Whether a lock file with the given contents should be considered
/// abandoned: either its owning pid is no longer alive, or `stale_after`
/// has elapsed since it recorded its timestamp.
fn lock_is_stale(contents: &str, stale_after: Duration) -> bool {
    let Some((pid, created_at)) = parse_lock_contents(contents) else {
        return true;
    };
    if !pid_is_alive(pid) {
        return true;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    Duration::from_secs(now.saturating_sub(created_at)) >= stale_after
}

/// RAII guard that removes the lock file on drop, so a panic inside `f`
/// still releases the lock instead of wedging it for every future caller.
struct LockGuard<'a> {
    path: &'a Path,
}

impl Drop for LockGuard<'_> {
    fn drop(&mut self) {
        let _ = fs::remove_file(self.path);
    }
}

/// Run `f` while holding an advisory, cross-process exclusive lock at
/// `lock_path`.
///
/// This is *advisory*, not a correctness guarantee: it only excludes other
/// callers that also go through `with_lock` on the same path, and the
/// stale-lock takeover below has a small (bounded by
/// [`LOCK_TAKEOVER_ATTEMPTS`] × [`LOCK_TAKEOVER_DELAY`]) race window against
/// another process independently deciding the same lock is stale at the
/// same moment. It's meant to reduce accidental concurrent
/// read-modify-write races on a shared JSON file, not to provide
/// `flock`-grade mutual exclusion.
///
/// The lock file is created with `create_new` (which atomically fails if
/// the file already exists) holding `{pid}:{unix_timestamp}`. If creation
/// fails because the file exists, its contents are inspected: if the owning
/// pid is no longer alive (Unix only — see [`pid_is_alive`]) or
/// `stale_after` has elapsed since its timestamp, the lock is considered
/// abandoned and is forcibly taken over (best-effort remove, then retry —
/// up to [`LOCK_TAKEOVER_ATTEMPTS`] times). The lock file is always removed
/// after `f` returns (or panics), regardless of outcome.
///
/// # Errors
/// Returns an error if the lock is currently held by a live, non-stale
/// owner (or was still contested after every takeover attempt), or if `f`
/// itself returns an error.
pub fn with_lock<T>(
    lock_path: &Path,
    stale_after: Duration,
    f: impl FnOnce() -> io::Result<T>,
) -> io::Result<T> {
    // Callers may pass a path under a config directory that doesn't exist
    // yet (e.g. a fresh install's app_config_dir()) — the lock kit must not
    // require a pre-existing directory any more than write_atomic does.
    if let Some(dir) = lock_path.parent().filter(|d| !d.as_os_str().is_empty()) {
        fs::create_dir_all(dir)?;
    }
    let mut attempts = 0u32;
    loop {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(lock_path)
        {
            Ok(mut file) => {
                file.write_all(lock_contents().as_bytes())?;
                file.sync_all()?;
                break;
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => {
                let contents = fs::read_to_string(lock_path).unwrap_or_default();
                if attempts >= LOCK_TAKEOVER_ATTEMPTS || !lock_is_stale(&contents, stale_after) {
                    return Err(err);
                }
                let _ = fs::remove_file(lock_path);
                attempts += 1;
                std::thread::sleep(LOCK_TAKEOVER_DELAY);
            }
            Err(err) => return Err(err),
        }
    }

    let _guard = LockGuard { path: lock_path };
    f()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64 as TestCounter, Ordering as TestOrdering};

    static TEST_DIR_COUNTER: TestCounter = TestCounter::new(0);

    /// Fresh, uniquely-named scratch directory under the system temp dir,
    /// so parallel test runs never collide. No external `tempfile` crate
    /// needed — a process-id + monotonic-counter suffix is unique enough.
    fn unique_test_dir(label: &str) -> PathBuf {
        let n = TEST_DIR_COUNTER.fetch_add(1, TestOrdering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "omp_json_store_test_{label}_{}_{n}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create unique test dir");
        dir
    }

    /// Spawn a trivial child process, wait for it to exit, and return its
    /// now-dead pid — a pid guaranteed not to belong to any live process
    /// (barring extremely unlikely pid reuse in the instant between wait
    /// and use, which every test in this module tolerates the same way any
    /// real caller would).
    fn spawn_and_reap_dead_pid() -> u32 {
        let mut cmd = if cfg!(windows) {
            let mut c = std::process::Command::new("cmd");
            c.args(["/C", "exit"]);
            c
        } else {
            std::process::Command::new("true")
        };
        let mut child = cmd.spawn().expect("spawn short-lived helper process");
        let pid = child.id();
        child.wait().expect("wait for short-lived helper process");
        pid
    }

    #[test]
    fn write_atomic_round_trips_content() {
        let dir = unique_test_dir("roundtrip");
        let target = dir.join("state.json");

        write_atomic(&target, b"{\"a\":1}").expect("write_atomic");

        assert_eq!(fs::read(&target).expect("read back"), b"{\"a\":1}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_atomic_leaves_no_tmp_file_and_sweeps_preexisting_ones() {
        let dir = unique_test_dir("sweep_on_write");
        let target = dir.join("state.json");

        // Simulate a temp file abandoned by a crash on a previous run.
        let orphan = dir.join("state.json.9999-1.tmp");
        fs::write(&orphan, b"partial").expect("write orphan temp file");

        write_atomic(&target, b"{\"a\":1}").expect("write_atomic");

        assert_eq!(fs::read(&target).expect("read back"), b"{\"a\":1}");
        assert!(
            !orphan.exists(),
            "pre-existing orphan .tmp must be swept by write_atomic"
        );

        let leftover_tmp = fs::read_dir(&dir)
            .expect("read dir")
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().ends_with(".tmp"));
        assert!(
            !leftover_tmp,
            "write_atomic must not leave its own temp file behind on success"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sweep_orphan_temp_files_matches_pattern_and_ignores_unrelated_files() {
        let dir = unique_test_dir("sweep_pattern");
        fs::write(dir.join("state.json.111-0.tmp"), b"x").expect("write");
        fs::write(dir.join("state.json.222-1.tmp"), b"y").expect("write");
        fs::write(dir.join("other.json.111-0.tmp"), b"z").expect("write");
        fs::write(dir.join("state.json"), b"keep").expect("write");

        let removed = sweep_orphan_temp_files(&dir, "state.json").expect("sweep");

        assert_eq!(removed, 2);
        assert!(
            dir.join("other.json.111-0.tmp").exists(),
            "unrelated base name must survive"
        );
        assert!(
            dir.join("state.json").exists(),
            "the real file must survive"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn snapshot_ring_prunes_beyond_retain() {
        let dir = unique_test_dir("ring_retain");
        let ring = SnapshotRing::new(dir.clone(), 2);

        ring.snapshot(b"one", "v1").expect("snapshot 1");
        std::thread::sleep(Duration::from_millis(10));
        ring.snapshot(b"two", "v2").expect("snapshot 2");
        std::thread::sleep(Duration::from_millis(10));
        let id3 = ring.snapshot(b"three", "v3").expect("snapshot 3");

        let remaining = ring.list_entries().expect("list entries");
        assert_eq!(
            remaining.len(),
            2,
            "only `retain` snapshots should survive pruning"
        );
        assert!(
            remaining.iter().any(|e| e.id == id3),
            "the newest snapshot must never be pruned"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn restore_latest_returns_most_recent_valid_snapshot() {
        let dir = unique_test_dir("ring_latest");
        let ring = SnapshotRing::new(dir.clone(), 5);
        ring.snapshot(b"old", "v1").expect("snapshot old");
        std::thread::sleep(Duration::from_millis(10));
        ring.snapshot(b"new", "v2").expect("snapshot new");

        let restored = ring.restore_latest().expect("restore_latest");
        assert_eq!(restored, Some(b"new".to_vec()));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn restore_latest_quarantines_corrupt_snapshot_and_falls_back() {
        let dir = unique_test_dir("ring_corrupt");
        let ring = SnapshotRing::new(dir.clone(), 5);
        ring.snapshot(b"good", "v1").expect("snapshot good");
        std::thread::sleep(Duration::from_millis(10));
        let bad_id = ring.snapshot(b"bad", "v2").expect("snapshot bad");

        // Simulate on-disk corruption: tamper with the newer snapshot's
        // bytes directly, so its content no longer hashes to its filename.
        fs::write(ring.snapshot_path(&bad_id), b"tampered").expect("corrupt snapshot");

        let restored = ring.restore_latest().expect("restore_latest");
        assert_eq!(
            restored,
            Some(b"good".to_vec()),
            "must fall back to the next-most-recent valid snapshot"
        );
        assert!(
            dir.join(format!("{bad_id}.corrupt")).exists(),
            "corrupt snapshot must be quarantined"
        );
        assert!(
            !ring.snapshot_path(&bad_id).exists(),
            "quarantined snapshot must be renamed away from its id path"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn restore_by_id_reports_corruption_without_quarantining() {
        let dir = unique_test_dir("ring_restore_id");
        let ring = SnapshotRing::new(dir.clone(), 5);
        let id = ring.snapshot(b"payload", "v1").expect("snapshot");
        fs::write(ring.snapshot_path(&id), b"tampered").expect("corrupt snapshot");

        let err = ring.restore(&id).expect_err("corrupted content must error");
        assert_eq!(err.kind(), ErrorKind::InvalidData);
        assert!(
            ring.snapshot_path(&id).exists(),
            "explicit restore-by-id must not quarantine on mismatch"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn restore_latest_is_none_when_ring_is_empty() {
        let dir = unique_test_dir("ring_empty");
        let ring = SnapshotRing::new(dir.clone(), 5);

        assert_eq!(
            ring.restore_latest().expect("restore_latest on empty ring"),
            None
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn with_lock_takes_over_when_owner_pid_is_dead() {
        let dir = unique_test_dir("lock_dead_pid");
        let lock_path = dir.join("state.lock");
        let dead_pid = spawn_and_reap_dead_pid();

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_secs();
        fs::write(&lock_path, format!("{dead_pid}:{now}")).expect("write stale lock");

        // stale_after is huge so only the dead-pid check can explain a
        // successful takeover here, not timestamp-based staleness.
        let result = with_lock(&lock_path, Duration::from_secs(3600), || Ok(42));

        assert_eq!(
            result.expect("with_lock should take over a dead-pid lock"),
            42
        );
        assert!(
            !lock_path.exists(),
            "lock file must be released after f() returns"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn with_lock_refuses_to_steal_own_recent_lock_before_stale_after_elapses() {
        let dir = unique_test_dir("lock_self_recent");
        let lock_path = dir.join("state.lock");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_secs();
        let original_contents = format!("{}:{now}", std::process::id());
        fs::write(&lock_path, &original_contents).expect("write own fresh lock");

        let result = with_lock(&lock_path, Duration::from_secs(3600), || Ok(1));

        assert!(
            result.is_err(),
            "a lock held by our own live, non-stale pid must not be taken over"
        );
        assert_eq!(
            fs::read_to_string(&lock_path).expect("lock file must be untouched"),
            original_contents,
            "a refused takeover must leave the existing lock file exactly as it was"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn with_lock_takes_over_own_lock_once_stale_after_elapses() {
        let dir = unique_test_dir("lock_self_stale");
        let lock_path = dir.join("state.lock");
        // Old enough that a 1-second stale_after has definitely elapsed,
        // even though the pid (ours) is still very much alive — proving
        // the timestamp check alone is sufficient to trigger takeover.
        let old_ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_secs()
            .saturating_sub(10);
        fs::write(&lock_path, format!("{}:{old_ts}", std::process::id()))
            .expect("write stale-timestamp lock");

        let result = with_lock(&lock_path, Duration::from_secs(1), || Ok(7));

        assert_eq!(
            result.expect("with_lock should take over a timestamp-stale lock"),
            7
        );
        assert!(
            !lock_path.exists(),
            "lock file must be released after f() returns"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn with_lock_releases_lock_after_f_errors() {
        let dir = unique_test_dir("lock_error_cleanup");
        let lock_path = dir.join("state.lock");

        let result: io::Result<()> = with_lock(&lock_path, Duration::from_secs(60), || {
            Err(io::Error::other("boom"))
        });

        assert!(result.is_err());
        assert!(
            !lock_path.exists(),
            "lock file must be released even when f() returns an error"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn with_lock_creates_missing_parent_directory() {
        // Regression: RuleBook (and any future json_store consumer) is
        // constructed with a config-dir path that may not exist yet on a
        // fresh install — the lock kit must not require the caller to have
        // created it first (the directory it lives in is otherwise only
        // created by the *locked* write itself, which never runs if the
        // lock file's own open fails first).
        let dir = unique_test_dir("lock_missing_parent");
        let missing_subdir = dir.join("not-created-yet");
        let lock_path = missing_subdir.join("state.lock");

        assert!(!missing_subdir.exists(), "precondition: parent absent");

        let result = with_lock(&lock_path, Duration::from_secs(60), || Ok(99));

        assert_eq!(
            result.expect("with_lock should create its own parent directory"),
            99
        );
        assert!(
            !lock_path.exists(),
            "lock file must be released after f() returns"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_lock_contents_rejects_malformed_input() {
        assert_eq!(parse_lock_contents("123:456"), Some((123, 456)));
        assert_eq!(parse_lock_contents("not-a-lock"), None);
        assert_eq!(parse_lock_contents("abc:456"), None);
        assert_eq!(parse_lock_contents("123:abc"), None);
    }

    #[test]
    fn temp_path_for_stays_in_same_directory_and_is_unique_per_call() {
        let path = Path::new("/some/dir/state.json");
        let a = temp_path_for(path);
        let b = temp_path_for(path);

        assert_eq!(a.parent(), Some(Path::new("/some/dir")));
        assert_ne!(a, b, "successive calls must never collide");
        assert!(a.to_string_lossy().ends_with(".tmp"));
    }
}
