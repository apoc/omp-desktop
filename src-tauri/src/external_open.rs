//! Folder-open requests handed to this app by the OS file manager
//! ("Open with OMP Desktop" on a directory).
//!
//! Every platform delivers them through a different channel, and none of
//! them is the webview:
//!
//! - **macOS** — `LaunchServices` sends `file://` URLs as
//!   `tauri::RunEvent::Opened`. Declared by the `public.folder`
//!   `CFBundleDocumentTypes` entry in `packaging/Info.plist`.
//! - **Windows / Linux** — the file manager *launches the executable* with
//!   the folder as a positional argument (the `Directory\shell` verb from
//!   `packaging/windows-folder-verb.nsh` and `.wxs`,
//!   `MimeType=inode/directory` + `%F` from
//!   `packaging/omp-desktop.desktop`). When an instance is already
//!   running, `tauri-plugin-single-instance` forwards that argv to it
//!   instead of starting a second app (each instance owns its own omp
//!   children, so a second one would be a second launch session).
//!
//! All three converge on [`ingest_args`] / [`ingest_urls`]: resolve to a
//! canonical directory, queue it, then emit [`OPEN_PROJECT_EVENT`] once.
//!
//! The queue is what makes a cold start work: the request arrives before the
//! webview has a listener, so `live.js` drains it on init *and* on every
//! event. [`OpenProjectState::take_pending`] is the only way out of the
//! queue, so a drain is idempotent — which is why there are no request ids
//! and no acknowledgement round-trip. A drain that races the event it was
//! woken by simply comes back empty.

use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Url};

/// Payload-free wake-up for the frontend: the queue, not the event, carries
/// the requests (see the module docs).
pub const OPEN_PROJECT_EVENT: &str = "open://project";

/// Queue ceiling. Each entry becomes a tab with its own omp process, so a
/// stuck frontend (dead webview, failing drain) must not let a held-down
/// "Open with" accumulate work unboundedly.
const MAX_PENDING: usize = 32;

/// Canonical project folders waiting for the frontend to turn into tabs.
#[derive(Default)]
pub struct OpenProjectState {
    pending: Mutex<Vec<String>>,
}

impl OpenProjectState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queue `path`. Returns `false` when it was dropped — the queue is full
    /// or its mutex is poisoned — so the caller can skip a pointless wake-up.
    fn enqueue(&self, path: String) -> bool {
        let Ok(mut pending) = self.pending.lock() else {
            return false;
        };
        if pending.len() >= MAX_PENDING {
            eprintln!("[omp-desktop] folder-open queue full, dropped: {path}");
            return false;
        }
        pending.push(path);
        true
    }

    /// Hand every queued folder to the caller, emptying the queue.
    pub fn take_pending(&self) -> Vec<String> {
        self.pending
            .lock()
            .map(|mut pending| std::mem::take(&mut *pending))
            .unwrap_or_default()
    }
}

/// Positional arguments of a launch argv.
///
/// `argv[0]` is the executable, and an option is never a path — macOS passes
/// the legacy `-psn_0_…` process serial number to bundled apps, and a webview
/// runtime may append its own flags.
fn positional_args<I: IntoIterator<Item = String>>(argv: I) -> impl Iterator<Item = String> {
    argv.into_iter()
        .skip(1)
        .filter(|arg| !arg.is_empty() && !arg.starts_with('-'))
}

/// A `file://` URL from the OS resolved to a canonical project folder.
fn folder_from_url(url: &Url) -> Result<String, String> {
    if url.scheme() != "file" {
        return Err(format!("unsupported scheme in '{url}'"));
    }
    let path = url
        .to_file_path()
        .map_err(|()| format!("not a local path: '{url}'"))?;
    canonical_folder(&path)
}

/// One command-line argument resolved to a canonical project folder,
/// relative paths taken against `base`.
///
/// Both spellings are accepted because both occur in the wild: Explorer's
/// `Directory\shell` verb and a `.desktop` `%f`/`%F` pass a plain path, while
/// `%u`/`%U` (and `gio open`) pass a `file://` URL.
fn folder_from_arg(base: &Path, arg: &str) -> Result<String, String> {
    if arg.starts_with("file://") {
        let url = Url::parse(arg).map_err(|e| format!("invalid URL '{arg}': {e}"))?;
        return folder_from_url(&url);
    }
    // `join` returns an absolute argument unchanged, so this only bites on a
    // relative one — where `canonicalize` alone would silently resolve
    // against *this* process' cwd. For a forwarded argv that is the
    // already-running instance's directory, not the shell the user typed
    // `omp-desktop .` in.
    canonical_folder(&base.join(arg))
}

/// Resolve, queue and announce every folder in a launch/forwarded argv.
///
/// `base` is the working directory the argv was produced in: the launching
/// process' cwd for a single-instance forward, this process' own for a cold
/// start. An empty path means "this process' cwd" — the natural fallback
/// when it cannot be determined.
pub fn ingest_args<I: IntoIterator<Item = String>>(app: &AppHandle, base: &Path, argv: I) {
    ingest(
        app,
        positional_args(argv).map(|arg| folder_from_arg(base, &arg)),
    );
}

/// Resolve, queue and announce every folder in a macOS `Opened` event.
#[cfg(target_os = "macos")]
pub fn ingest_urls(app: &AppHandle, urls: &[Url]) {
    ingest(app, urls.iter().map(folder_from_url));
}

/// Queue the folders that resolved and wake the frontend once for the batch.
///
/// A request that fails to resolve is logged and dropped, never surfaced:
/// the OS is the caller, there is no UI context to report it in, and the
/// only realistic causes are a folder deleted between click and launch or a
/// non-folder argument from a hand-written shortcut.
fn ingest<I: Iterator<Item = Result<String, String>>>(app: &AppHandle, resolved: I) {
    let state = app.state::<OpenProjectState>();
    let mut queued = false;
    for outcome in resolved {
        match outcome {
            Ok(path) => queued |= state.enqueue(path),
            Err(reason) => eprintln!("[omp-desktop] ignored folder-open request: {reason}"),
        }
    }
    if queued {
        if let Err(e) = app.emit(OPEN_PROJECT_EVENT, ()) {
            eprintln!("[omp-desktop] failed to announce folder-open request: {e}");
        }
    }
}

/// An existing directory as a canonical path string for the IPC boundary.
///
/// Canonicalising here is what makes the rest of the app able to trust these
/// paths: they arrive from an untrusted-shaped source (argv,
/// `LaunchServices`) and are then used as an omp `--cwd`, a git-watch root
/// and a tab label.
/// Symlinks and `..` are resolved once, and anything that is not a directory
/// (a file dragged onto the app icon, a stale shortcut) is rejected rather
/// than silently spawning an agent somewhere unexpected.
fn canonical_folder(path: &Path) -> Result<String, String> {
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("cannot resolve '{}': {e}", path.display()))?;
    if !canonical.is_dir() {
        return Err(format!("not a directory: '{}'", canonical.display()));
    }
    let text = canonical
        .into_os_string()
        .into_string()
        .map_err(|raw| format!("non-UTF-8 path: '{}'", Path::new(&raw).display()))?;
    Ok(strip_verbatim(text))
}

/// Undo Windows' verbatim (`\\?\`) prefix, which `canonicalize` always adds.
///
/// It is valid for Win32 but leaks into everything downstream: omp's `--cwd`,
/// `gix`'s repository discovery and the tab label all handle `C:\proj` and
/// choke on (or display) `\\?\C:\proj`.
///
/// Not `#[cfg(windows)]`, and applied unconditionally: it is pure string
/// work, no canonical POSIX path can start with `\\?\` (they start with `/`),
/// and one code path means the CI Linux/macOS runs cover it too.
fn strip_verbatim(mut path: String) -> String {
    if let Some(share) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{share}");
    }
    // Only a drive-letter path: `\\?\Volume{…}` GUID paths have no shorter
    // spelling, so leave them exactly as the OS gave them. Drained in place
    // rather than `rest.to_owned()`: this arm fires for every canonicalised
    // Windows path, and the copy would be pure waste.
    if path.strip_prefix(r"\\?\").is_some_and(has_drive_prefix) {
        path.drain(..r"\\?\".len());
    }
    path
}

fn has_drive_prefix(path: &str) -> bool {
    let mut chars = path.chars();
    matches!((chars.next(), chars.next()), (Some(c), Some(':')) if c.is_ascii_alphabetic())
}

#[cfg(test)]
mod tests {
    use super::{
        folder_from_arg, folder_from_url, positional_args, strip_verbatim, OpenProjectState,
        MAX_PENDING,
    };
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use tauri::Url;

    fn unique_temp_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        std::env::temp_dir().join(format!(
            "omp-external-open-{tag}-{}-{n}-{nanos}",
            std::process::id()
        ))
    }

    /// Expected resolution of `path`: the OS canonical form, since
    /// `/tmp` is a symlink to `/private/tmp` on macOS and the temp dir may
    /// itself sit behind one on Linux.
    fn canonical(path: &Path) -> String {
        strip_verbatim(
            path.canonicalize()
                .expect("canonicalize fixture")
                .to_string_lossy()
                .into_owned(),
        )
    }

    /// An argument that is already absolute, so the base cannot matter.
    fn from_absolute(arg: &str) -> Result<String, String> {
        folder_from_arg(Path::new(""), arg)
    }

    #[test]
    fn positional_args_drops_the_executable_and_options() {
        let argv = [
            "/opt/omp-desktop/omp-desktop",
            "-psn_0_1234",
            "",
            "/home/dev/project",
            "--flag",
            "/home/dev/other",
        ]
        .map(String::from);
        assert_eq!(
            positional_args(argv).collect::<Vec<_>>(),
            vec!["/home/dev/project".to_owned(), "/home/dev/other".to_owned()]
        );
    }

    #[test]
    fn a_plain_directory_argument_resolves_to_its_canonical_path() {
        let dir = unique_temp_dir("plain");
        std::fs::create_dir_all(dir.join("nested")).expect("create fixture");
        let arg = dir.join("nested").join("..").to_string_lossy().into_owned();
        assert_eq!(from_absolute(&arg), Ok(canonical(&dir)));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The regression this parameter exists for: `omp-desktop .` typed in
    /// another shell is forwarded as a relative argv, and resolving it
    /// against *this* process' cwd opens the already-running instance's own
    /// directory instead of the one the user asked for.
    #[test]
    fn a_relative_argument_resolves_against_the_supplied_base() {
        let dir = unique_temp_dir("relative");
        std::fs::create_dir_all(dir.join("nested")).expect("create fixture");
        assert_eq!(
            folder_from_arg(&dir, "nested"),
            Ok(canonical(&dir.join("nested")))
        );
        assert_eq!(folder_from_arg(&dir, "."), Ok(canonical(&dir)));
        assert!(
            from_absolute("nested").is_err(),
            "without the base this resolves against the process cwd, where \
             the fixture does not exist — the bug this guards"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The spaces matter: a `file://` URL percent-encodes them, and a folder
    /// with a space in its name is the common case this used to break on.
    #[test]
    fn a_file_url_argument_is_percent_decoded() {
        let dir = unique_temp_dir("url with spaces");
        std::fs::create_dir_all(&dir).expect("create fixture");
        let url = Url::from_directory_path(dir.canonicalize().expect("canonicalize fixture"))
            .expect("build file URL");
        assert!(url.as_str().contains("%20"), "URL should be encoded: {url}");
        assert_eq!(from_absolute(url.as_str()), Ok(canonical(&dir)));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A file is not a project root — accepting one would spawn an agent in
    /// whatever directory happened to contain it.
    #[test]
    fn a_file_argument_is_rejected() {
        let dir = unique_temp_dir("file-arg");
        std::fs::create_dir_all(&dir).expect("create fixture");
        let file = dir.join("README.md");
        std::fs::write(&file, b"x").expect("write fixture");
        assert!(from_absolute(&file.to_string_lossy()).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_path_is_rejected() {
        let dir = unique_temp_dir("missing");
        assert!(from_absolute(&dir.to_string_lossy()).is_err());
    }

    #[test]
    fn a_non_file_url_is_rejected() {
        let url = Url::parse("https://example.com/repo").expect("parse URL");
        assert!(folder_from_url(&url).is_err());
    }

    #[test]
    fn verbatim_windows_prefixes_are_stripped_but_guid_volumes_are_not() {
        assert_eq!(strip_verbatim(r"\\?\C:\dev\omp".into()), r"C:\dev\omp");
        assert_eq!(
            strip_verbatim(r"\\?\UNC\srv\share\p".into()),
            r"\\srv\share\p"
        );
        assert_eq!(
            strip_verbatim(r"\\?\Volume{c3f2}\dev".into()),
            r"\\?\Volume{c3f2}\dev"
        );
        assert_eq!(strip_verbatim("/home/dev/omp".into()), "/home/dev/omp");
    }

    #[test]
    fn taking_the_queue_empties_it() {
        let state = OpenProjectState::new();
        assert!(state.enqueue("/a".to_owned()));
        assert!(state.enqueue("/b".to_owned()));
        assert_eq!(state.take_pending(), vec!["/a".to_owned(), "/b".to_owned()]);
        assert!(
            state.take_pending().is_empty(),
            "a second drain must be empty — this is what makes the frontend's \
             event-and-startup double drain idempotent"
        );
    }

    #[test]
    fn the_queue_is_capped() {
        let state = OpenProjectState::new();
        for i in 0..MAX_PENDING {
            assert!(state.enqueue(format!("/p{i}")), "entry {i} should fit");
        }
        assert!(
            !state.enqueue("/overflow".to_owned()),
            "a full queue must drop the request and report it"
        );
        assert_eq!(state.take_pending().len(), MAX_PENDING);
    }
}
