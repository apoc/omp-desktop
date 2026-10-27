//! Git browser backend: the project tree with status marks, the full-file
//! inline diff, the commit graph and a commit's touched files — every read
//! done in-process with [`gix`], never through a `git` subprocess.
//!
//! One command per submodule, each a blocking `fn(&Path, …) -> Result<_, String>`
//! that `lib.rs` runs under `spawn_blocking`:
//!
//! | command                   | module       |
//! |---------------------------|--------------|
//! | `git_browser_status`      | [`status`]   |
//! | `git_browser_file`        | [`file`]     |
//! | `git_browser_log`         | [`log`] (lanes from [`graph`]) |
//! | `git_browser_commit`      | [`commit`]   |
//! | `git_browser_commit_file` | [`commit`]   |
//!
//! Every path crossing the IPC boundary is project-relative to the
//! repository's work dir (not to the tab's folder, which may be a
//! subdirectory) and `/`-separated. Staging and discarding stay in
//! [`crate::workspace`] (`git add` / `git checkout`).

mod commit;
mod file;
mod graph;
mod log;
mod status;

pub use commit::{commit, commit_file, CommitView};
pub use file::{file, is_binary, FileView};
pub use log::{log, LogView};
pub use status::{status, StatusView};

use std::path::{Path, PathBuf};

/// [`crate::workspace::discover`] for the git browser, minus the filter
/// drivers (`filter.<name>.clean`/`smudge`/`process`) the repository
/// configures itself (`.git/config`, `config.worktree` and their includes).
///
/// gix runs a driver's command whenever it reads a work-tree file through
/// git's filter pipeline — status hashing a changed file, the file view —
/// and its trust check is only that the user owns the repository. A
/// downloaded or extracted repository is owned by the user, so its own
/// config could make a mere preview run a command. Drivers from the
/// user's and the system's config (`git lfs install`) stay: those
/// commands are the user's own choice, as they are for `git status`. The
/// built-in conversions (`eol`, `text`, `ident`, `working-tree-encoding`)
/// run no command and are kept too.
///
/// The drivers that stay are commands gix runs: the returned guard holds
/// the spawn gate ([`crate::spawn_gate`]) and must live as long as the
/// reads on the repository.
pub fn open(path: &Path) -> Result<(crate::spawn_gate::Shared, gix::Repository, PathBuf), String> {
    let (gate, mut repo, work_dir) = crate::workspace::discover(path)?;
    // Collected first: the read borrows the config the removal replaces.
    let local: Vec<_> = repo
        .config_snapshot()
        .sections_and_ids_by_name("filter")
        .into_iter()
        .flatten()
        .filter(|(section, _)| {
            section.meta().source.kind() == gix::config::source::Kind::Repository
        })
        .map(|(_, id)| id)
        .collect();
    if !local.is_empty() {
        let mut config = repo.config_snapshot_mut();
        for id in local {
            config.remove_section_by_id(id);
        }
        config
            .commit()
            .map_err(fail("failed to configure git filters"))?;
    }
    Ok((gate, repo, work_dir))
}

/// Files a tree carries before it is cut off and marked `truncated` —
/// shared by the project tree ([`status`]) and a commit's touched files
/// ([`commit`]).
const MAX_FILES: usize = 20_000;

/// A file's change against the comparison base (`HEAD` for the work tree,
/// the first parent for a commit), serialised as the bare variant name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum StatusKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
}

/// One node of a folded file tree. Directories list their sub-directories
/// first, then their files, each alphabetical (byte order, as git sorts).
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    /// Project-relative, `/`-separated; `""` for the root.
    pub path: String,
    pub dir: bool,
    pub status: Option<StatusKind>,
    /// Changed files below a directory; `0` for files.
    pub changed: u32,
    /// Empty for files.
    pub children: Vec<Self>,
}

/// `map_err` adaptor: prefix a library error with what was being done.
fn fail<E: std::fmt::Display>(what: &'static str) -> impl FnOnce(E) -> String {
    move |e| format!("{what}: {e}")
}

/// Normalise a path from the frontend to a project-relative one.
///
/// A relative path goes through [`crate::workspace::validate_relative_path`]
/// (traversal, `.git` and symlink-escape guards). An absolute one — an edit
/// card's target is whatever path omp's tool was given — is accepted when it
/// lies inside the work dir: its parent is canonicalised as far as it exists
/// ([`crate::workspace::weakly_canonicalize`], so a symlinked project folder
/// still matches) and the remainder validated the same way.
pub fn project_relative(work_dir: &Path, rel_path: &str) -> Result<String, String> {
    let given = Path::new(rel_path);
    if !given.is_absolute() {
        return crate::workspace::validate_relative_path(work_dir, rel_path).map(|(_, rel)| rel);
    }
    let outside = || format!("{rel_path} is outside the repository");
    let (Some(parent), Some(name)) = (given.parent(), given.file_name()) else {
        return Err(outside());
    };
    let root = std::fs::canonicalize(work_dir).map_err(fail("failed to resolve work dir"))?;
    let resolved = crate::workspace::weakly_canonicalize(parent)
        .map_err(fail("failed to resolve path"))?
        .join(name);
    let rest = resolved.strip_prefix(&root).map_err(|_| outside())?;
    let rest = rest
        .to_str()
        .ok_or_else(|| format!("{rel_path} is not valid UTF-8"))?;
    crate::workspace::validate_relative_path(work_dir, rest).map(|(_, rel)| rel)
}

/// Parse a full hex commit id from the frontend.
fn parse_id(sha: &str) -> Result<gix::ObjectId, String> {
    gix::ObjectId::from_hex(sha.as_bytes()).map_err(fail("invalid commit id"))
}

/// A commit message's first line and everything after it.
fn split_lines(message: &[u8]) -> (&[u8], &[u8]) {
    message
        .iter()
        .position(|&b| b == b'\n')
        .map_or((message, &[]), |i| (&message[..i], &message[i + 1..]))
}

/// A commit's subject: the first line of its message, lossily decoded.
fn subject(message: &[u8]) -> String {
    String::from_utf8_lossy(split_lines(message).0)
        .trim_end()
        .to_string()
}

/// A commit's body: its message after the first line, without the blank
/// separator line(s) and trailing whitespace, lossily decoded.
fn body(message: &[u8]) -> String {
    String::from_utf8_lossy(split_lines(message).1)
        .trim_start_matches(['\r', '\n'])
        .trim_end()
        .to_string()
}

#[cfg(test)]
pub mod fixture {
    //! Throwaway repositories for the submodule tests, built with the `git`
    //! binary (setup only — the code under test never runs it).

    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    /// `true` once `git` is on `PATH`, cached for the process.
    pub fn git_available() -> bool {
        static AVAILABLE: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| {
            std::process::Command::new("git")
                .arg("--version")
                .output()
                .is_ok()
        });
        *AVAILABLE
    }

    /// A temp dir removed on drop.
    pub struct Repo(pub PathBuf);

    impl Drop for Repo {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    impl Repo {
        pub fn path(&self) -> &Path {
            &self.0
        }

        /// Run `git args` in the repo, panicking on failure.
        pub fn git(&self, args: &[&str]) -> String {
            run(&self.0, args, None)
        }

        /// Commit everything staged with author and committer date `epoch`,
        /// so date-ordered walks are deterministic; returns the new id.
        pub fn commit(&self, message: &str, epoch: i64) -> String {
            run(
                &self.0,
                &["commit", "-q", "--allow-empty", "-m", message],
                Some(epoch),
            );
            self.git(&["rev-parse", "HEAD"]).trim().to_string()
        }

        pub fn write(&self, rel: &str, content: &str) {
            let path = self.0.join(rel);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("create parent dirs");
            }
            std::fs::write(path, content).expect("write fixture file");
        }

        /// Configure, in the repository config of the git dir `git_dir`
        /// (relative to the repo, `.git` or `.git/modules/<name>`), a
        /// `clean` filter for every path that appends to the returned marker
        /// file whenever it runs and passes the content through unchanged.
        ///
        /// The filter is `required`: gix silently skips a failing optional
        /// filter, so where it could not run the command (no `sh`), a read
        /// that still applied it would leave no marker and look safe. A
        /// required one fails that read instead.
        pub fn arm_clean_filter(&self, git_dir: &str) -> PathBuf {
            let git_dir = self.0.join(git_dir);
            let marker = git_dir.join("filter-ran");
            // Forward slashes: the command runs through `sh` on every platform.
            let quoted = marker.to_string_lossy().replace('\\', "/");
            let config = git_dir.join("config");
            let config = config.to_str().expect("utf-8 temp path");
            let set = |key: &str, value: &str| {
                self.git(&["config", "--file", config, key, value]);
            };
            set(
                "filter.probe.clean",
                &format!("echo ran >> '{quoted}'; cat"),
            );
            set("filter.probe.required", "true");
            let info = git_dir.join("info");
            std::fs::create_dir_all(&info).expect("create info dir");
            std::fs::write(info.join("attributes"), "* filter=probe\n").expect("write attributes");
            marker
        }
    }

    fn run(dir: &Path, args: &[&str], epoch: Option<i64>) -> String {
        let mut cmd = std::process::Command::new("git");
        cmd.current_dir(dir).args(args);
        if let Some(epoch) = epoch {
            let date = format!("@{epoch} +0000");
            cmd.env("GIT_AUTHOR_DATE", &date)
                .env("GIT_COMMITTER_DATE", date);
        }
        let out = cmd.output().expect("spawn git");
        assert!(
            out.status.success(),
            "git {args:?} failed in {dir:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// A fresh repo on branch `main` with a fixed identity, or `None`
    /// (soft skip) without `git`.
    pub fn init(tag: &str) -> Option<Repo> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        if !git_available() {
            eprintln!("git binary not available; skipping {tag}");
            return None;
        }
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "omp-git-browser-test-{tag}-{}-{n}",
            std::process::id()
        ));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).expect("create temp repo dir");
        let repo = Repo(dir);
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "test@example.com"]);
        repo.git(&["config", "user.name", "Test"]);
        repo.git(&["config", "core.autocrlf", "false"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        Some(repo)
    }
}

#[cfg(test)]
mod tests {
    use super::{body, fixture, project_relative, subject};

    #[test]
    fn subject_and_body_split_at_the_first_line() {
        let msg = b"fix: the thing\n\nWhy it broke.\n\nMore.\n";
        assert_eq!(subject(msg), "fix: the thing");
        assert_eq!(body(msg), "Why it broke.\n\nMore.");
        assert_eq!(subject(b"one line"), "one line");
        assert_eq!(body(b"one line"), "");
        assert_eq!(body(b"crlf\r\n\r\nbody\r\n"), "body");
    }

    #[test]
    fn project_relative_passes_relative_paths_through_validation() {
        let Some(repo) = fixture::init("rel-relative") else {
            return;
        };
        repo.write("src/a.txt", "a\n");
        assert_eq!(
            project_relative(repo.path(), "src/a.txt").as_deref(),
            Ok("src/a.txt")
        );
        assert!(project_relative(repo.path(), "../x").is_err());
        assert!(project_relative(repo.path(), ".git/config").is_err());
    }

    #[test]
    fn project_relative_relativises_absolute_paths_inside_the_work_dir() {
        let Some(repo) = fixture::init("rel-absolute") else {
            return;
        };
        repo.write("src/a.txt", "a\n");
        let abs = repo.path().join("src").join("a.txt");
        assert_eq!(
            project_relative(repo.path(), abs.to_str().expect("utf-8 temp path")).as_deref(),
            Ok("src/a.txt")
        );
        // A deleted file (missing parent dir too) still relativises.
        let gone = repo.path().join("gone").join("b.txt");
        assert_eq!(
            project_relative(repo.path(), gone.to_str().expect("utf-8 temp path")).as_deref(),
            Ok("gone/b.txt")
        );
    }

    #[test]
    fn project_relative_rejects_absolute_paths_outside_the_work_dir() {
        let Some(repo) = fixture::init("rel-outside") else {
            return;
        };
        let outside = std::env::temp_dir().join("omp-git-browser-elsewhere.txt");
        let err = project_relative(repo.path(), outside.to_str().expect("utf-8 temp path"))
            .expect_err("outside path must be rejected");
        assert!(err.contains("outside the repository"), "{err}");
        let git_dir = repo.path().join(".git").join("config");
        assert!(project_relative(repo.path(), git_dir.to_str().expect("utf-8")).is_err());
    }
}
