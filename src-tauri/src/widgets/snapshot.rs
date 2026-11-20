//! Verified copies of the files a plugin's fingerprint hashes, so a run
//! executes the bytes its approval check saw. Checking the files and then
//! starting the plugin by their paths leaves a window in which a script can
//! be swapped; instead a run gets an argv naming copies whose bytes were
//! compared with, or copied from, the bytes hashed to the approved
//! fingerprint in this same pass.
//!
//! Layout under `<app cache>/widget-runs/`, private to the user (`0700` dirs
//! on unix):
//! - `store/<fingerprint>/<argv index>/<file name>`: the copies of one
//!   approved fingerprint, reused by every run while it stays approved, so a
//!   tool that keys a cache by script path (uv's per-script environments)
//!   sees one stable path. Reuse is never on trust: each stored copy is
//!   compared with its original chunk by chunk while the original is hashed,
//!   and the entry must be a real directory holding exactly the copies as
//!   real files. If the originals still match the approval but the entry
//!   does not (a copy planted, tampered with or truncated by a crash before
//!   its bytes reached the disk; a module planted beside a copy; a link), the
//!   entry is removed and built again.
//! - `staging/<pid>/<n>/`: copies being built, each file streamed through the
//!   hash and into staging at once. Only if the result equals the approved
//!   fingerprint is the directory renamed into `store/`. If that rename fails
//!   (an entry that could not be removed, a concurrent run that stored first,
//!   a handle an antivirus still holds), this run executes the staging copy,
//!   which is removed when the run ends; an entry this pass did not build or
//!   verify is never used.
//!
//! A run without copies to make creates no directory at all.
//!
//! What is not copied, and so still runs from its own path:
//! - the program itself (`argv[0]`) when it is a native executable of this
//!   platform: on Windows a path ending in `.exe` whose content starts with
//!   `MZ` (Rust neither probes another name for it nor treats it as a batch
//!   file, so `CreateProcess` loads the very file hashed); elsewhere an ELF or
//!   Mach-O header. It finds its libraries next to itself, which are not
//!   fingerprinted anyway. Only the OS loader reads it, so a text script
//!   cannot pass for one: an argument that looks native is still copied;
//! - a file over the fingerprint's 8 MiB limit, pinned only by size + mtime;
//! - anything that is not a regular file when the run starts (a directory, a
//!   missing path), which the fingerprint does not hash.
//!
//! A copy keeps its file name, so an interpreter that dispatches on the
//! extension (`.mjs`, `.ps1`) still does, and on unix its owner-execute bit,
//! so a shebang script still starts. Its directory is not the original's: a
//! script must not load siblings relative to itself.
//!
//! [`ScriptStore::prune`] (at startup) deletes the staging directories of dead
//! processes and the store entries no plugin is approved under.

use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::private_fs::{pid_dirs, private_dirs, remove_dir_retrying};
use crate::widgets::config::PluginEntry;
use crate::widgets::trust;
use omp_desktop_core::proc_util::pid_is_alive;

const STAGING: &str = "staging";
const STORE: &str = "store";
const NO_STORE: &str =
    "the app cache directory could not be resolved — widget scripts cannot be copied for the run";
/// Attempts at a fresh staging directory name before giving up.
const STAGING_ATTEMPTS: u32 = 16;

/// What [`ScriptStore::prepare`] found.
#[derive(Debug)]
pub enum Prepared {
    Ready(Run),
    /// The plugin now has this fingerprint, not the approved one: nothing
    /// may run.
    Changed(String),
}

/// The argv a run executes: the configured one with each hashed script
/// replaced by its verified copy. Keep it until the run ends: copies that
/// could not be stored live in a scratch directory it deletes on drop.
#[derive(Debug)]
pub struct Run {
    pub argv: Vec<OsString>,
    _scratch: Option<Scratch>,
}

/// The verified copies of widget scripts: `<root>/store`, `<root>/staging`.
pub struct ScriptStore {
    /// `None` without an app cache directory: a run that needs a copy fails.
    root: Option<PathBuf>,
    next: AtomicU64,
}

/// One hashing pass over a plugin's command.
struct Pass {
    fingerprint: String,
    /// argv index → the copy's path relative to its directory.
    copies: Vec<(usize, PathBuf)>,
    /// Every stored copy compared equal (always true when copying).
    verified: bool,
}

impl ScriptStore {
    pub const fn new(root: Option<PathBuf>) -> Self {
        Self {
            root,
            next: AtomicU64::new(0),
        }
    }

    /// Delete the staging directories of processes that no longer exist and
    /// our own pid's (an earlier process that had it), and every store entry
    /// whose fingerprint `approved` rejects. Staging directories of live app
    /// instances and names that are not pids are left alone. Call before the
    /// first run.
    pub fn prune(&self, approved: impl Fn(&str) -> bool) {
        let Some(root) = &self.root else { return };
        let own = std::process::id();
        for (pid, path) in pid_dirs(&root.join(STAGING)) {
            if pid == own || !pid_is_alive(pid) {
                let _ = remove_dir_retrying(&path);
            }
        }
        for (name, path) in subdirs(&root.join(STORE)) {
            if !approved(&name) {
                let _ = remove_dir_retrying(&path);
            }
        }
    }

    /// Hash `entry` as [`trust::fingerprint`] does and, if that equals
    /// `approved`, the run: argv naming the copies in `store/<approved>`,
    /// verified against the originals in this pass or made from them now.
    ///
    /// # Errors
    /// A file that cannot be read or copied, or no app cache directory when
    /// a copy is needed: the run must not fall back to the original path.
    pub fn prepare(&self, entry: &PluginEntry, approved: &str) -> Result<Prepared, String> {
        // `approved` comes from the approvals file: a path component only
        // once it has a fingerprint's shape.
        let stored = self
            .root
            .as_deref()
            .filter(|_| trust::is_fingerprint(approved))
            .map(|root| root.join(STORE).join(approved));
        let mut staging = Staging {
            store: self,
            dir: None,
        };
        if let Some(stored) = stored.as_deref() {
            match fs::symlink_metadata(stored) {
                Ok(meta) if meta.is_dir() => {
                    let pass = Self::pass(entry, Some(stored), &mut staging)?;
                    if pass.fingerprint != approved {
                        // The original changed; the entry still holds the
                        // approved bytes for runs in flight.
                        return Ok(Prepared::Changed(pass.fingerprint));
                    }
                    if pass.verified && holds_only(stored, &pass.copies) {
                        return Ok(Prepared::Ready(Run::new(entry, &pass.copies, stored)));
                    }
                    // Rare race, accepted: a concurrent run that found the
                    // same bad entry may already have rebuilt it, and loses
                    // its new entry here (one failed run if its interpreter
                    // has not opened the copy yet).
                    discard(stored);
                }
                // A file, symlink or junction where the entry belongs.
                Ok(_) => discard(stored),
                Err(_) => {}
            }
        }
        let pass = Self::pass(entry, None, &mut staging)?;
        if pass.fingerprint != approved {
            // `staging` drops here and takes its copies with it.
            return Ok(Prepared::Changed(pass.fingerprint));
        }
        if pass.copies.is_empty() {
            return Ok(Prepared::Ready(Run::new(entry, &[], Path::new(""))));
        }
        let target = stored.ok_or(NO_STORE)?;
        Ok(Prepared::Ready(match staging.commit(&target) {
            Ok(()) => Run::new(entry, &pass.copies, &target),
            Err(scratch) => {
                let run = Run::new(entry, &pass.copies, &scratch.0);
                Run {
                    _scratch: Some(scratch),
                    ..run
                }
            }
        }))
    }

    /// Hash `entry`, comparing each copied file with its copy in `verify`
    /// or, without one, writing it into `staging`.
    fn pass(
        entry: &PluginEntry,
        verify: Option<&Path>,
        staging: &mut Staging,
    ) -> Result<Pass, String> {
        let mut hasher = trust::hash_argv(entry);
        let mut copies = Vec::new();
        let mut verified = true;
        for (index, arg) in entry.command.iter().enumerate() {
            let Some((path, meta)) = trust::hash_file_header(&mut hasher, index, arg) else {
                continue;
            };
            let name = path
                .file_name()
                .ok_or_else(|| format!("{arg} has no file name"))?;
            let relative = Path::new(&index.to_string()).join(name);
            let open = |staging: &mut Staging| {
                verify.map_or_else(
                    || staging.create(&relative, &meta).map(Sink::Write),
                    // A missing or unreadable copy is a mismatch, not an error.
                    |dir| Ok(File::open(dir.join(&relative)).map_or(Sink::Differs, Sink::Compare)),
                )
            };
            let mut file = HashedFile {
                state: State::Pending,
                may_be_native: may_run_natively(index, arg),
                limit: meta.len(),
            };
            let from_copy = trust::hash_contents(path, &mut hasher, |chunk| {
                file.feed(chunk, || open(staging))
            })
            .and_then(|()| file.finish(|| open(staging)))
            .map_err(|e| format!("could not read or copy {arg} for the run: {e}"))?;
            if let Some(matches) = from_copy {
                verified &= matches;
                copies.push((index, relative));
            }
        }
        Ok(Pass {
            fingerprint: trust::finish(hasher),
            copies,
            verified,
        })
    }

    /// A fresh `staging/<pid>/<n>`, created exclusively.
    fn staging_dir(&self) -> io::Result<PathBuf> {
        let root = self
            .root
            .as_deref()
            .ok_or_else(|| io::Error::other(NO_STORE))?;
        let instance = root.join(STAGING).join(std::process::id().to_string());
        private_dirs(true).create(&instance)?;
        let mut attempt = 1;
        loop {
            let dir = instance.join(self.next.fetch_add(1, Ordering::Relaxed).to_string());
            match private_dirs(false).create(&dir) {
                // A leftover of a crashed process with our pid, never reused.
                Err(e)
                    if e.kind() == io::ErrorKind::AlreadyExists && attempt < STAGING_ATTEMPTS =>
                {
                    attempt += 1;
                }
                created => return created.map(|()| dir),
            }
        }
    }
}

impl Run {
    fn new(entry: &PluginEntry, copies: &[(usize, PathBuf)], dir: &Path) -> Self {
        let mut argv: Vec<OsString> = entry.command.iter().map(OsString::from).collect();
        for (index, relative) in copies {
            argv[*index] = dir.join(relative).into_os_string();
        }
        Self {
            argv,
            _scratch: None,
        }
    }
}

/// Whether `dir` holds exactly `copies`, each a real file in a real
/// directory: nothing planted beside a copy (a sibling `json.py` or
/// `node_modules` an interpreter would load first) and no copy that is a
/// link to some other file.
fn holds_only(dir: &Path, copies: &[(usize, PathBuf)]) -> bool {
    let count = |dir: &Path| fs::read_dir(dir).map(Iterator::count).ok();
    count(dir) == Some(copies.len())
        && copies.iter().all(|(_, relative)| {
            let copy = dir.join(relative);
            copy.parent().is_some_and(|slot| {
                fs::symlink_metadata(slot).is_ok_and(|meta| meta.is_dir()) && count(slot) == Some(1)
            }) && fs::symlink_metadata(&copy).is_ok_and(|meta| meta.is_file())
        })
}

/// Remove a store entry, or whatever sits in its place, without following
/// a link.
fn discard(entry: &Path) {
    if fs::remove_dir_all(entry).is_err() {
        let _ = fs::remove_file(entry);
    }
}

/// The subdirectories of `dir` with a UTF-8 name.
fn subdirs(dir: &Path) -> impl Iterator<Item = (String, PathBuf)> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| Some((entry.file_name().into_string().ok()?, entry.path())))
}

/// A directory removed on drop.
#[derive(Debug)]
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// One pass's staging directory, created on its first copy.
struct Staging<'a> {
    store: &'a ScriptStore,
    dir: Option<Scratch>,
}

impl Staging<'_> {
    /// Create the empty copy `<staging>/<relative>` exclusively; unix mode
    /// `0500` if the original is owner-executable, else `0400` (the open
    /// handle can still write it).
    fn create(&mut self, relative: &Path, meta: &fs::Metadata) -> io::Result<File> {
        let dir = match &self.dir {
            Some(dir) => dir,
            None => self.dir.insert(Scratch(self.store.staging_dir()?)),
        };
        let path = dir.0.join(relative);
        if let Some(slot) = path.parent() {
            private_dirs(false).create(slot)?;
        }
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
            let executable = meta.permissions().mode() & 0o100 != 0;
            options.mode(if executable { 0o500 } else { 0o400 });
        }
        #[cfg(not(unix))]
        let _ = meta;
        options.open(path)
    }

    /// Rename the staged copies to `target`. A failure hands them back, to
    /// run from where they are this once: whatever sits at `target` then
    /// was neither built nor verified by this pass.
    fn commit(self, target: &Path) -> Result<(), Scratch> {
        let Some(scratch) = self.dir else {
            return Ok(());
        };
        let renamed = target
            .parent()
            .map_or(Ok(()), |store| private_dirs(true).create(store))
            .and_then(|()| fs::rename(&scratch.0, target));
        match renamed {
            // `scratch`'s drop finds nothing left at the old path.
            Ok(()) => Ok(()),
            Err(e) => {
                eprintln!("[omp-desktop] widget script copies not stored, running them once from staging: {e}");
                Err(scratch)
            }
        }
    }
}

/// One hashed file while its bytes stream through the hash: whether it runs
/// from a copy is decided by its first chunk.
struct HashedFile {
    state: State,
    /// The file is `argv[0]` and may be left to the OS loader.
    may_be_native: bool,
    /// The size `metadata` reported: a file that grows past it while being
    /// read (swapped for `/dev/zero`) is refused, not copied without end.
    limit: u64,
}

enum State {
    Pending,
    /// Runs from a copy.
    Copied {
        sink: Sink,
        read: u64,
    },
    /// A native executable: it runs from its own path.
    Native,
}

/// Where a copied file's bytes go besides the hash.
enum Sink {
    /// Into a new copy in staging.
    Write(File),
    /// Compared with the stored copy.
    Compare(File),
    /// The stored copy is missing or differs; the rest is only hashed.
    Differs,
}

impl HashedFile {
    fn feed(&mut self, chunk: &[u8], open: impl FnOnce() -> io::Result<Sink>) -> io::Result<()> {
        if matches!(self.state, State::Pending) {
            self.state = if self.may_be_native && is_native_image(chunk) {
                State::Native
            } else {
                State::Copied {
                    sink: open()?,
                    read: 0,
                }
            };
        }
        let State::Copied { sink, read } = &mut self.state else {
            return Ok(());
        };
        *read = read.saturating_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX));
        if *read > self.limit {
            return Err(io::Error::other("the file changed while it was read"));
        }
        match sink {
            Sink::Write(file) => file.write_all(chunk)?,
            Sink::Compare(copy) => {
                if !reads_as(copy, chunk) {
                    *sink = Sink::Differs;
                }
            }
            Sink::Differs => {}
        }
        Ok(())
    }

    /// `None` for a native executable, else whether its copy is good: written
    /// now, or compared equal to the end. An empty file never saw a chunk and
    /// is opened (copied empty, or compared) here.
    fn finish(mut self, open: impl FnOnce() -> io::Result<Sink>) -> io::Result<Option<bool>> {
        // Opens a file still pending; otherwise an empty chunk is a no-op.
        self.feed(&[], open)?;
        let State::Copied { sink, .. } = self.state else {
            return Ok(None);
        };
        match sink {
            Sink::Write(mut file) => file.flush().map(|()| Some(true)),
            // Equal so far; a longer copy differs too.
            Sink::Compare(mut copy) => Ok(Some(copy.read(&mut [0u8; 1]).is_ok_and(|n| n == 0))),
            Sink::Differs => Ok(Some(false)),
        }
    }
}

/// Whether the next bytes of `file` are `expected`.
fn reads_as(file: &mut File, mut expected: &[u8]) -> bool {
    let mut buf = [0u8; trust::CHUNK_BYTES];
    while !expected.is_empty() {
        let n = expected.len().min(trust::CHUNK_BYTES);
        if file.read_exact(&mut buf[..n]).is_err() || buf[..n] != expected[..n] {
            return false;
        }
        expected = &expected[n..];
    }
    true
}

/// Only the program is loaded by the OS. On Windows only an `.exe` path:
/// Rust probes `<path>.exe` for a name without that extension and starts a
/// `.bat`/`.cmd` (also spelled with a trailing dot or space) through
/// cmd.exe, so any other name could run something other than the file read.
fn may_run_natively(index: usize, arg: &str) -> bool {
    let named_exe = !cfg!(windows)
        || (arg.len() >= 4 && arg.as_bytes()[arg.len() - 4..].eq_ignore_ascii_case(b".exe"));
    index == 0 && named_exe
}

/// The header of an executable this platform's loader runs.
#[cfg(windows)]
fn is_native_image(head: &[u8]) -> bool {
    head.starts_with(b"MZ")
}

/// ELF, and thin or fat Mach-O in either byte order.
#[cfg(not(windows))]
fn is_native_image(head: &[u8]) -> bool {
    const MAGICS: [&[u8]; 7] = [
        b"\x7fELF",
        b"\xfe\xed\xfa\xce",
        b"\xfe\xed\xfa\xcf",
        b"\xce\xfa\xed\xfe",
        b"\xcf\xfa\xed\xfe",
        b"\xca\xfe\xba\xbe",
        b"\xbe\xba\xfe\xca",
    ];
    MAGICS.iter().any(|magic| head.starts_with(magic))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use crate::widgets::config::test_entry;
    use crate::widgets::context::PluginContext;
    use crate::widgets::run::run_plugin;

    fn ctx(project: &Path) -> PluginContext {
        PluginContext {
            project: project.to_string_lossy().into_owned(),
            branch: String::new(),
            remote: String::new(),
            session: "s1".into(),
            trigger: "manual".into(),
        }
    }

    fn s(path: &Path) -> &str {
        path.to_str().unwrap()
    }

    /// `prepare` under the entry's current fingerprint, expected to run.
    fn ready(store: &ScriptStore, e: &PluginEntry) -> Run {
        match store.prepare(e, &trust::fingerprint(e)).unwrap() {
            Prepared::Ready(run) => run,
            Prepared::Changed(fp) => panic!("changed to {fp}"),
        }
    }

    fn configured(e: &PluginEntry) -> Vec<OsString> {
        e.command.iter().map(OsString::from).collect()
    }

    /// Overwrite a copy, which is read-only on unix.
    fn tamper(copy: &OsString, bytes: &[u8]) {
        let mut perms = fs::metadata(copy).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)] // the test's own file
        perms.set_readonly(false);
        fs::set_permissions(copy, perms).unwrap();
        fs::write(copy, bytes).unwrap();
    }

    fn staged_runs(root: &Path) -> usize {
        subdirs(&root.join(STAGING))
            .flat_map(|(_, d)| subdirs(&d))
            .count()
    }

    /// A command that prints the file at `path`, without a shell script of
    /// its own.
    fn print_file(path: &str) -> Vec<&str> {
        if cfg!(windows) {
            vec!["cmd", "/C", "type", path]
        } else {
            vec!["cat", path]
        }
    }

    /// A native program name and the first bytes this platform's loader
    /// runs.
    const NATIVE: (&str, &[u8]) = if cfg!(windows) {
        ("tool.exe", b"MZ\x90\x00rest")
    } else {
        ("tool", b"\x7fELF\x02\x01\x01rest")
    };

    #[test]
    fn copies_hashed_files_once_under_the_approved_fingerprint() {
        let tmp = TempDir::new("widget-snap", "copies");
        let script = tmp.path().join("hello.mjs");
        fs::write(&script, "console.log('{}')\n").unwrap();
        let missing = tmp.path().join("missing.txt");
        let e = test_entry(&["node", "-e", s(&script), s(&missing), s(tmp.path())]);
        let root = tmp.path().join("runs");
        let store = ScriptStore::new(Some(root.clone()));

        let run = ready(&store, &e);
        let copy = PathBuf::from(&run.argv[2]);
        let fp = trust::fingerprint(&e);
        assert_eq!(copy, root.join(STORE).join(&fp).join("2").join("hello.mjs"));
        assert_eq!(fs::read(&copy).unwrap(), fs::read(&script).unwrap());
        // Neither a bare name, a flag, a missing path nor a directory is a
        // file the fingerprint hashed.
        assert_eq!(run.argv[..2], configured(&e)[..2]);
        assert_eq!(run.argv[3..], configured(&e)[3..]);
        assert_eq!(staged_runs(&root), 0);

        assert_eq!(
            ready(&store, &e).argv,
            run.argv,
            "a later run reuses the path"
        );
    }

    /// A stored copy is compared with the original on every run: a planted,
    /// tampered, truncated or missing copy is replaced by the original's
    /// bytes, never run.
    #[test]
    fn a_stored_copy_that_differs_from_the_original_is_rebuilt() {
        let tmp = TempDir::new("widget-snap", "verify");
        let script = tmp.path().join("out.json");
        fs::write(&script, "{\"v\":1}").unwrap();
        let e = test_entry(&print_file(s(&script)));
        let root = tmp.path().join("runs");
        let store = ScriptStore::new(Some(root.clone()));
        let index = e.command.len() - 1;
        let copy = root
            .join(STORE)
            .join(trust::fingerprint(&e))
            .join(index.to_string())
            .join("out.json");

        // Planted before the first run.
        fs::create_dir_all(copy.parent().unwrap()).unwrap();
        fs::write(&copy, "{\"evil\":1}").unwrap();
        let run = ready(&store, &e);
        assert_eq!(PathBuf::from(&run.argv[index]), copy);
        assert_eq!(fs::read(&copy).unwrap(), b"{\"v\":1}");

        for bad in [&b"{\"v\":2}"[..], b"{\"v\":1", b"{\"v\":1}extra", b""] {
            tamper(&run.argv[index], bad);
            ready(&store, &e);
            assert_eq!(fs::read(&copy).unwrap(), b"{\"v\":1}", "after {bad:?}");
        }
        fs::remove_file(&copy).unwrap();
        ready(&store, &e);
        assert_eq!(fs::read(&copy).unwrap(), b"{\"v\":1}", "after removal");
    }

    /// Nothing beside the copies survives into a run: an interpreter would
    /// load a sibling module before the real one.
    #[test]
    fn a_store_entry_with_anything_beside_its_copies_is_rebuilt() {
        let tmp = TempDir::new("widget-snap", "layout");
        let script = tmp.path().join("w.py");
        fs::write(&script, "import json\n").unwrap();
        let e = test_entry(&["python3", "-I", s(&script)]);
        let store = ScriptStore::new(Some(tmp.path().join("runs")));
        let copy = PathBuf::from(&ready(&store, &e).argv[2]);
        let slot = copy.parent().unwrap().to_path_buf();
        let entry_dir = slot.parent().unwrap().to_path_buf();

        for planted in [slot.join("json.py"), entry_dir.join("7").join("x")] {
            fs::create_dir_all(planted.parent().unwrap()).unwrap();
            fs::write(&planted, "evil").unwrap();
            assert_eq!(PathBuf::from(&ready(&store, &e).argv[2]), copy);
            assert!(!planted.exists(), "{planted:?}");
            assert_eq!(fs::read(&copy).unwrap(), b"import json\n");
        }
    }

    /// A copy that links to the original would follow a later swap of it; an
    /// entry that links elsewhere is not ours. Both are rebuilt as real files.
    #[cfg(unix)]
    #[test]
    fn a_linked_store_entry_or_copy_is_rebuilt() {
        use std::os::unix::fs::symlink;
        let tmp = TempDir::new("widget-snap", "links");
        let script = tmp.path().join("out.json");
        fs::write(&script, "{\"v\":1}").unwrap();
        let e = test_entry(&["cat", s(&script)]);
        let store = ScriptStore::new(Some(tmp.path().join("runs")));
        let copy = PathBuf::from(&ready(&store, &e).argv[1]);
        let entry_dir = copy.parent().unwrap().parent().unwrap().to_path_buf();

        fs::remove_file(&copy).unwrap();
        symlink(&script, &copy).unwrap();
        ready(&store, &e);
        assert!(fs::symlink_metadata(&copy).unwrap().is_file());

        let elsewhere = tmp.path().join("elsewhere");
        fs::rename(&entry_dir, &elsewhere).unwrap();
        symlink(&elsewhere, &entry_dir).unwrap();
        ready(&store, &e);
        assert!(fs::symlink_metadata(&entry_dir).unwrap().is_dir());
        assert!(
            elsewhere.join("1").exists(),
            "the link's target is left alone"
        );
    }

    #[test]
    fn an_edited_original_is_refused_and_leaves_the_store_alone() {
        let tmp = TempDir::new("widget-snap", "edited");
        let script = tmp.path().join("w.sh");
        fs::write(&script, "echo {}").unwrap();
        let e = test_entry(&["sh", s(&script)]);
        let approved = trust::fingerprint(&e);
        let store = ScriptStore::new(Some(tmp.path().join("runs")));
        let run = ready(&store, &e);

        fs::write(&script, "echo []").unwrap();
        let got = store.prepare(&e, &approved).unwrap();
        assert!(matches!(got, Prepared::Changed(fp) if fp == trust::fingerprint(&e)));
        assert_eq!(
            fs::read(&run.argv[1]).unwrap(),
            b"echo {}",
            "kept for runs in flight"
        );
    }

    #[test]
    fn a_changed_or_malformed_approval_stores_nothing() {
        let tmp = TempDir::new("widget-snap", "changed");
        let script = tmp.path().join("w.sh");
        fs::write(&script, "echo {}").unwrap();
        let e = test_entry(&["sh", s(&script)]);
        let root = tmp.path().join("runs");
        let store = ScriptStore::new(Some(root.clone()));

        for approved in ["0".repeat(64), "../escape".to_owned()] {
            let got = store.prepare(&e, &approved).unwrap();
            assert!(matches!(got, Prepared::Changed(fp) if fp == trust::fingerprint(&e)));
        }
        assert_eq!(subdirs(&root.join(STORE)).count(), 0);
        assert_eq!(staged_runs(&root), 0);
        assert!(!root.join("escape").exists() && !tmp.path().join("escape").exists());
    }

    /// The approval check and the run see the same bytes: a script replaced
    /// after the check (in place or by a rename over it) does not run.
    #[test]
    fn a_run_executes_the_checked_bytes_not_a_later_replacement() {
        let tmp = TempDir::new("widget-snap", "swap");
        let script = tmp.path().join("out.json");
        fs::write(&script, "{\"v\":1}").unwrap();
        let e = test_entry(&print_file(s(&script)));
        let store = ScriptStore::new(Some(tmp.path().join("runs")));

        let run = ready(&store, &e);
        fs::write(&script, "{\"v\":2}").unwrap();
        let out = run_plugin(&e, &run.argv, &ctx(tmp.path()), |_| {});
        assert_eq!(out.result.as_deref().map(str::trim), Ok("{\"v\":1}"));

        fs::write(&script, "{\"v\":1}").unwrap();
        let run = ready(&store, &e);
        let evil = tmp.path().join("evil.json");
        fs::write(&evil, "{\"v\":3}").unwrap();
        fs::rename(&evil, &script).unwrap();
        let out = run_plugin(&e, &run.argv, &ctx(tmp.path()), |_| {});
        assert_eq!(out.result.as_deref().map(str::trim), Ok("{\"v\":1}"));
    }

    /// Copies that cannot be stored run once from staging, removed with the
    /// run.
    #[test]
    fn copies_run_from_staging_when_they_cannot_be_stored() {
        let tmp = TempDir::new("widget-snap", "scratch");
        let script = tmp.path().join("out.json");
        fs::write(&script, "{\"v\":1}").unwrap();
        let e = test_entry(&print_file(s(&script)));
        let root = tmp.path().join("runs");
        // `store` itself is a file: no entry can be created under it.
        let blocker = root.join(STORE);
        fs::create_dir_all(&root).unwrap();
        fs::write(&blocker, "not a directory").unwrap();

        let run = ready(&ScriptStore::new(Some(root.clone())), &e);
        let copy = PathBuf::from(run.argv.last().unwrap());
        assert!(copy.starts_with(root.join(STAGING)), "{copy:?}");
        let out = run_plugin(&e, &run.argv, &ctx(tmp.path()), |_| {});
        assert_eq!(out.result.as_deref().map(str::trim), Ok("{\"v\":1}"));
        drop(run);
        assert!(!copy.exists());
        assert_eq!(fs::read(&blocker).unwrap(), b"not a directory");
    }

    /// Only the program may be left to the OS loader: a script argument that
    /// starts like an executable (`MZ=1` is valid shell) is still copied.
    #[test]
    fn only_a_native_program_runs_from_its_own_path() {
        let tmp = TempDir::new("widget-snap", "native");
        let program = tmp.path().join(NATIVE.0);
        fs::write(&program, NATIVE.1).unwrap();
        let script = tmp.path().join("w.sh");
        fs::write(&script, NATIVE.1).unwrap();
        let spoof = tmp.path().join("w2.sh");
        fs::write(&spoof, "MZ=1\necho {}\n").unwrap();
        let large = tmp.path().join("large.bin");
        File::create(&large)
            .unwrap()
            .set_len(trust::MAX_HASHED_FILE_BYTES + 1)
            .unwrap();
        let e = test_entry(&[s(&program), s(&script), s(&spoof), s(&large)]);
        let argv = ready(&ScriptStore::new(Some(tmp.path().join("runs"))), &e).argv;
        let want = configured(&e);
        assert_eq!(argv[0], want[0], "native program");
        assert_ne!(argv[1], want[1], "native-looking argument");
        assert_ne!(argv[2], want[2], "MZ-headed script");
        assert_eq!(argv[3], want[3], "over the hashing limit");
    }

    /// On Windows only an `.exe` path is left to the loader: a `.cmd` (also
    /// spelled `w.cmd.`) or an extension-less name, which Rust would resolve
    /// to another file, is copied whatever its first bytes.
    #[cfg(windows)]
    #[test]
    fn on_windows_only_an_exe_program_runs_from_its_own_path() {
        let tmp = TempDir::new("widget-snap", "exe");
        let store = ScriptStore::new(Some(tmp.path().join("runs")));
        for name in ["w.cmd", "tool", "tool.bin"] {
            fs::write(tmp.path().join(name), b"MZ & echo {}\r\n").unwrap();
        }
        let paths = ["w.cmd", "tool", "tool.bin"].map(|name| tmp.path().join(name));
        let dotted = format!("{}.", s(&paths[0]));
        for arg in [s(&paths[0]), dotted.as_str(), s(&paths[1]), s(&paths[2])] {
            let e = test_entry(&[arg]);
            assert_ne!(ready(&store, &e).argv[0], configured(&e)[0], "{arg}");
        }
        let exe = tmp.path().join("TOOL.EXE");
        fs::write(&exe, NATIVE.1).unwrap();
        let e = test_entry(&[s(&exe)]);
        assert_eq!(ready(&store, &e).argv[0], configured(&e)[0]);
    }

    #[test]
    fn an_empty_file_is_copied_empty() {
        let tmp = TempDir::new("widget-snap", "empty");
        let empty = tmp.path().join("empty.txt");
        fs::write(&empty, "").unwrap();
        let e = test_entry(&["cat", s(&empty)]);
        let store = ScriptStore::new(Some(tmp.path().join("runs")));
        let argv = ready(&store, &e).argv;
        assert_ne!(argv[1], empty.as_os_str());
        assert_eq!(fs::read(&argv[1]).unwrap(), b"");
        assert_eq!(ready(&store, &e).argv, argv, "an empty copy verifies too");
    }

    /// Without an app cache directory a plugin that needs no copy still
    /// runs; one that does fails instead of running the original.
    #[test]
    fn no_cache_directory_fails_only_runs_that_need_a_copy() {
        let tmp = TempDir::new("widget-snap", "nodir");
        let store = ScriptStore::new(None);
        let inline = test_entry(&["sh", "-c", "echo {}"]);
        assert_eq!(ready(&store, &inline).argv, configured(&inline));

        let script = tmp.path().join("x.sh");
        fs::write(&script, "echo {}").unwrap();
        let e = test_entry(&["sh", s(&script)]);
        assert!(store.prepare(&e, &trust::fingerprint(&e)).is_err());
    }

    /// A shebang script named as the program runs from its copy, which keeps
    /// the owner-execute bit; a non-executable file's copy stays so.
    #[cfg(unix)]
    #[test]
    fn a_shebang_script_runs_from_an_executable_copy() {
        use std::os::unix::fs::PermissionsExt as _;
        let tmp = TempDir::new("widget-snap", "shebang");
        let script = crate::test_support::executable(
            &tmp.path().join("w.sh"),
            "#!/bin/sh\nprintf '\"%s\"' \"$0\"\n",
        );
        let data = tmp.path().join("data.txt");
        fs::write(&data, "x").unwrap();
        let e = test_entry(&[s(&script), s(&data)]);
        let argv = ready(&ScriptStore::new(Some(tmp.path().join("runs"))), &e).argv;
        let mode = |p: &OsString| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&argv[0]), 0o500);
        assert_eq!(mode(&argv[1]), 0o400);

        let out = run_plugin(&e, &argv, &ctx(tmp.path()), |_| {});
        let ran: String = serde_json::from_str(out.result.as_deref().unwrap()).unwrap();
        assert_eq!(Path::new(&ran), Path::new(&argv[0]));
    }

    #[test]
    fn prune_keeps_live_staging_and_approved_store_entries_only() {
        let tmp = TempDir::new("widget-snap", "prune");
        let root = tmp.path().join("runs");
        let mut child = if cfg!(windows) {
            std::process::Command::new("cmd")
                .args(["/C", "exit"])
                .spawn()
        } else {
            std::process::Command::new("true").spawn()
        }
        .unwrap();
        let dead = child.id();
        child.wait().unwrap();
        // A live process other than ours stands in for another app instance.
        let mut live = if cfg!(windows) {
            std::process::Command::new("ping")
                .args(["-n", "30", "127.0.0.1"])
                .stdout(std::process::Stdio::null())
                .spawn()
        } else {
            std::process::Command::new("sleep").arg("30").spawn()
        }
        .unwrap();
        let staging = root.join(STAGING);
        let staged = [
            dead.to_string(),
            std::process::id().to_string(),
            "not-a-pid".to_owned(),
            live.id().to_string(),
        ];
        for dir in &staged {
            fs::create_dir_all(staging.join(dir).join("0")).unwrap();
        }
        let kept = "a".repeat(64);
        let stale = "b".repeat(64);
        for fp in [&kept, &stale] {
            fs::create_dir_all(root.join(STORE).join(fp).join("1")).unwrap();
        }

        ScriptStore::new(Some(root.clone())).prune(|fp| fp == kept);
        let _ = live.kill();
        let _ = live.wait();
        assert!(!staging.join(&staged[0]).exists(), "dead process");
        assert!(
            !staging.join(&staged[1]).exists(),
            "earlier process with our pid"
        );
        assert!(staging.join(&staged[2]).exists(), "not a pid");
        assert!(staging.join(&staged[3]).exists(), "live instance");
        assert!(root.join(STORE).join(&kept).exists(), "approved");
        assert!(
            !root.join(STORE).join(&stale).exists(),
            "no longer approved"
        );
    }
}
