//! Git working-tree mutation — validated, single-file stage (`accept`) and
//! discard (`reject`), and the branch switch (`switch_branch`), on one
//! repository. Every read (status, diffs, history, branches) lives in
//! [`crate::git_browser`], on gix.
//!
//! [`validate_relative_path`] and repository discovery ([`discover`]) use
//! the filesystem and [`gix`] (the same `gix::discover` pattern as
//! [`crate::git`]); the git browser's reads resolve paths through them too.
//!
//! [`accept`], [`reject`] and [`switch_branch`] shell out to the `git`
//! binary, invoked with a fully static argv (never a shell string) via
//! [`crate::spawn_gate`]: gix's index-writing/checkout support is far less
//! mature than its read APIs, and `git add` / `git checkout` / `git reset` /
//! `git switch` already implement safe, atomic index and worktree mutation.

use crate::child_path::{child_path_dirs, locate_program, TrustedProgram};
use std::path::{Path, PathBuf};
use std::process::Command;

// ── path validation ─────────────────────────────────────────────────────────

/// The textual half of [`validate_relative_path`], touching no disk: check
/// that `rel` is a plain, traversal-free relative path and return it with
/// `/` separators.
///
/// Rejects:
/// - an empty string,
/// - an absolute path (`/etc/passwd`),
/// - a UNC path (`\\server\share\...` or `//server/share/...`),
/// - a Windows drive-letter path (`C:\...`),
/// - any path containing a `..` or empty component,
/// - any path with a `.git` component (case-insensitive).
///
/// On its own this suits a path looked up inside a stored tree, which must
/// not be resolved against today's file system.
pub fn validate_path_text(rel: &str) -> Result<String, String> {
    if rel.is_empty() {
        return Err("path must not be empty".to_string());
    }
    if rel.starts_with('/') || rel.starts_with('\\') {
        return Err("path must not be absolute".to_string());
    }
    // Windows drive-letter form, e.g. "C:\foo" or "C:/foo".
    let bytes = rel.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err("path must not be a drive-letter path".to_string());
    }

    let normalized = if cfg!(windows) {
        rel.replace('\\', "/")
    } else {
        rel.to_string()
    };
    if normalized
        .split('/')
        .any(|seg| seg == ".." || seg.is_empty())
    {
        return Err("path must not contain '..' or empty components".to_string());
    }
    if normalized
        .split('/')
        .any(|seg| seg.eq_ignore_ascii_case(".git"))
    {
        return Err("path must not reference the .git directory".to_string());
    }
    Ok(normalized)
}

/// Validate that `rel` is a plain, traversal-free path relative to
/// `repo_root`, and return its canonicalized absolute form.
///
/// First the textual checks of [`validate_path_text`], whose `/`-separated
/// result is joined onto `repo_root`. The joined candidate's parent
/// directory is then resolved and checked to
/// still live inside `repo_root`, guarding against symlink escapes:
/// components of the parent path that exist on disk are fully
/// canonicalized (resolving any symlinks), and only the non-existent
/// tail (which by definition cannot be a symlink) is joined on
/// lexically. The final path component itself is deliberately *never*
/// canonicalized/resolved — if it is a symlink, callers must operate on
/// the link itself (matching what `git status` reports), not silently
/// follow it to some other tracked file elsewhere in the repository.
/// This lets validation succeed for paths that don't exist yet — e.g. a
/// working-tree file already deleted, pending a `reject`-triggered
/// restore from `HEAD` — while still defeating symlink escapes for
/// every directory segment.
pub fn validate_relative_path(repo_root: &Path, rel: &str) -> Result<(PathBuf, String), String> {
    let normalized = validate_path_text(rel)?;
    let canonical_root = std::fs::canonicalize(repo_root)
        .map_err(|e| format!("failed to canonicalize repository root: {e}"))?;
    let candidate = canonical_root.join(&normalized);
    // Split off the final component so a symlink named there is never
    // followed — only the (guaranteed-directory) parent is canonicalized.
    let file_name = candidate
        .file_name()
        .ok_or_else(|| "path must not be empty".to_string())?
        .to_owned();
    let parent = candidate
        .parent()
        .ok_or_else(|| "path must not be empty".to_string())?;
    let parent_resolved =
        weakly_canonicalize(parent).map_err(|e| format!("failed to resolve path: {e}"))?;

    if !parent_resolved.starts_with(&canonical_root) {
        return Err("path escapes repository root".to_string());
    }
    let abs = parent_resolved.join(file_name);
    // Derive the git pathspec from the *resolved* absolute path rather than
    // from `normalized`: when a parent component is a symlink pointing
    // elsewhere inside the repository, the resolved path is the one git
    // actually tracks. `canonical_root` is already in hand here, so this
    // costs no extra syscall (it previously did, via a second
    // `canonicalize` in the old `to_repo_relative` helper).
    let rel_stripped = abs
        .strip_prefix(&canonical_root)
        .map_err(|_| "path escapes repository root".to_string())?;
    let rel_lossy = rel_stripped.to_string_lossy();
    let rel_norm = if cfg!(windows) {
        rel_lossy.replace('\\', "/")
    } else {
        rel_lossy.into_owned()
    };
    Ok((abs, rel_norm))
}

/// Canonicalize the longest existing ancestor of `path`, then lexically
/// re-append whatever suffix doesn't exist yet. A non-existent path
/// segment cannot itself be a symlink, so this preserves the symlink-
/// escape guarantee of [`std::fs::canonicalize`] for every segment that
/// is actually resolvable, while still returning a usable path for
/// not-yet-existing targets.
pub fn weakly_canonicalize(path: &Path) -> std::io::Result<PathBuf> {
    let mut existing = path;
    let mut missing_tail: Vec<&std::ffi::OsStr> = Vec::new();
    while !existing.exists() {
        let Some(name) = existing.file_name() else {
            break;
        };
        missing_tail.push(name);
        match existing.parent() {
            Some(parent) => existing = parent,
            None => break,
        }
    }
    let mut resolved = existing.canonicalize()?;
    for part in missing_tail.into_iter().rev() {
        resolved.push(part);
    }
    Ok(resolved)
}

// ── git invocation ──────────────────────────────────────────────────────────

/// Build a `git` [`Command`] rooted at `work_dir` with every repo-agnostic
/// hardening flag already applied, so no call site can forget one:
///
/// - `--literal-pathspecs` — a path coming from the frontend is data, never
///   a pathspec expression; without this a file literally named `*.rs` or
///   `:(exclude)x` would be interpreted as a glob/magic pathspec.
/// - `--no-optional-locks` — never take a lock git considers optional (the
///   index refresh a read like `git diff` would otherwise perform). Mutating
///   commands still take the locks they genuinely require, so this is safe
///   to apply uniformly.
/// - the binary by absolute path — the first `git` in the absolute folders
///   of the child PATH ([`child_path_dirs`]; a per-user `git` from winget
///   `--scope user` or scoop is on the user PATH, which an MSI-update
///   relaunch doesn't carry, #34). Never a bare `git`: started in the
///   project, that would be looked up through an empty or relative PATH
///   entry *there*, so a project could ship its own `git`. The PATH is
///   those same folders (the
///   [`crate::child_path::trusted_child_path`]), for the helpers git itself
///   starts (credential helpers, ssh, an editor).
///
/// Every `git` invocation in this module goes through here. Subcommand-level
/// flags (`--cached`, `-M`, …) stay at their call sites. `Err` when no `git`
/// is found.
fn git(work_dir: &Path) -> Result<Command, String> {
    git_in(&child_path_dirs(), work_dir)
}

/// [`git`] with the PATH folders it searches given.
fn git_in(dirs: &[PathBuf], work_dir: &Path) -> Result<Command, String> {
    let TrustedProgram { binary, path } = locate_program(dirs, "git")?;
    let mut cmd = Command::new(binary);
    cmd.env("PATH", path)
        .current_dir(work_dir)
        .args(["--literal-pathspecs", "--no-optional-locks"]);
    Ok(cmd)
}

/// Run a `git` subcommand and return its stdout, mapping both a spawn
/// failure and a non-zero exit into a `label`-prefixed error string.
fn git_output(work_dir: &Path, args: &[&str], label: &str) -> Result<Vec<u8>, String> {
    let output = crate::spawn_gate::output(git(work_dir)?.args(args))
        .map_err(|e| format!("failed to run git {label}: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "git {label} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim_end()
        ));
    }
    Ok(output.stdout)
}

/// Run a `git` subcommand purely for its exit status, discarding both
/// streams. For probes where a non-zero exit is an expected, non-error
/// answer (an unborn `HEAD`, a path absent from `HEAD`) rather than a
/// failure — printing their stderr would surface spurious-looking
/// "fatal:" lines for perfectly normal code paths.
fn git_succeeds(work_dir: &Path, args: &[&str], label: &str) -> Result<bool, String> {
    crate::spawn_gate::status(
        git(work_dir)?
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null()),
    )
    .map(|status| status.success())
    .map_err(|e| format!("failed to run git {label}: {e}"))
}

/// Discover the repository containing `path` with gix (same discovery
/// pattern as [`crate::git::probe`]) and return it with its working-tree
/// root — the root every project-relative path is resolved against —
/// failing clearly for bare repositories or paths that aren't inside a git
/// repository at all. Shared with [`crate::git_browser`]. Discovered through
/// [`crate::spawn_gate::discover`]: the guard comes back with the repository.
pub fn discover(
    path: &Path,
) -> Result<(crate::spawn_gate::Shared, gix::Repository, PathBuf), String> {
    let (gate, repo) = crate::spawn_gate::discover(path)?;
    let work_dir = repo
        .workdir()
        .map(Path::to_path_buf)
        .ok_or_else(|| "repository has no working tree".to_string())?;
    Ok((gate, repo, work_dir))
}

// ── accept / reject ─────────────────────────────────────────────────────────

/// Resolve `rel_path` against `repo_root` for a single-file mutating
/// operation: discover the working tree, validate the path (rejecting
/// traversal and symlink escape — see [`validate_relative_path`]), and
/// refuse a directory. Returns `(work_dir, abs, rel_norm)`.
///
/// Folded into one helper so [`accept`] and [`reject`] cannot drift in
/// which of these checks they perform, or in what order.
fn resolve_file_target(
    repo_root: &Path,
    rel_path: &str,
) -> Result<(PathBuf, PathBuf, String), String> {
    let (_, _, work_dir) = discover(repo_root)?;
    let (abs, rel_norm) = validate_relative_path(&work_dir, rel_path)?;
    if std::fs::symlink_metadata(&abs).is_ok_and(|m| m.is_dir()) {
        return Err(format!("{rel_norm} is a directory, not a file"));
    }
    Ok((work_dir, abs, rel_norm))
}

/// Stage a single file's working-tree changes (equivalent to
/// `git add -- <path>`).
///
/// Refuses to run for any path outside `repo_root` or any path-traversal
/// attempt: `rel_path` is validated with [`validate_relative_path`]
/// before any git command is invoked.
///
/// ### Why shell out to `git` here
///
/// gix's in-memory index API can stage individual entries, but
/// hashing the current worktree content into a blob, computing correct
/// stat metadata, inserting at the right sorted position, and writing the
/// index back atomically is exactly what `git add` already does safely.
/// Shelling out for this single mutating call avoids re-implementing
/// index-writing by hand.
pub fn accept(repo_root: &Path, rel_path: &str) -> Result<(), String> {
    let (work_dir, _abs, rel_norm) = resolve_file_target(repo_root, rel_path)?;
    git_output(&work_dir, &["add", "--", &rel_norm], "add")?;
    Ok(())
}

/// Switch the work tree to `name`, a branch [`crate::git_browser::branches`]
/// lists (`remote` says which kind): a local branch (`git switch`), or a
/// remote-tracking one, which gets a local branch of its name tracking it
/// (`git switch --track refs/remotes/origin/x` makes `x`). Git refuses,
/// changing nothing, when local changes would be overwritten; its message is
/// the error.
///
/// Only a listed name gets through: the webview sends a branch name, never
/// git arguments. Listed names come from refs, which git never names with a
/// leading `-`; one is refused anyway, as it would read as an option. A
/// remote one goes to git as its full ref: the short `origin/x` would also
/// match a local branch or tag of that name, which git prefers, and it
/// checks that commit out before failing to create the branch.
pub fn switch_branch(repo_root: &Path, name: &str, remote: bool) -> Result<(), String> {
    let (_, _, work_dir) = discover(repo_root)?;
    let listed = crate::git_browser::branches(&work_dir)?
        .iter()
        .any(|branch| branch.remote == remote && branch.name == name);
    if !listed || name.starts_with('-') {
        return Err(format!("{name} is not a branch to switch to"));
    }
    let full_ref;
    let args = if remote {
        full_ref = format!("refs/remotes/{name}");
        ["switch", "--track", full_ref.as_str()]
    } else {
        ["switch", "--no-guess", name]
    };
    git_output(&work_dir, &args, "switch")?;
    Ok(())
}

/// Discard a single file's working-tree changes.
///
/// For a file present in `HEAD`, this is equivalent to
/// `git checkout HEAD -- <path>`: any staged and/or unstaged
/// modifications are discarded and the file reverts to its `HEAD`
/// content (including recreating a file that was deleted from the
/// working tree).
///
/// # Destructive footgun: files with no `HEAD` version are deleted
///
/// A file with no `HEAD` version — either never tracked at all, or
/// newly staged with `git add` but never committed — has nothing to
/// revert to. For such files, "reject" discards the addition entirely:
/// the file is unstaged (if staged; a harmless no-op otherwise) and then
/// **permanently deleted from the working tree**. Callers presenting
/// this in a UI MUST warn the user before invoking `reject` on an
/// untracked/never-committed file — there is no git history to recover
/// the content from afterwards.
///
/// Refuses to run for any path outside `repo_root` or any path-traversal
/// attempt: `rel_path` is validated with [`validate_relative_path`]
/// before any git or filesystem mutation happens.
///
/// ### Why shell out to `git` here
///
/// Same rationale as [`accept`]: discarding changes means rewriting
/// worktree file content from a tree object and/or updating the index,
/// which git's own checkout/reset machinery already implements
/// correctly and atomically.
pub fn reject(repo_root: &Path, rel_path: &str) -> Result<(), String> {
    let (work_dir, abs, rel_norm) = resolve_file_target(repo_root, rel_path)?;

    // `-e` only needs the exit status; a missing path is an expected,
    // non-error outcome here (see the doc comment above) — `git_succeeds`
    // discards both streams so no spurious-looking "fatal: path does not
    // exist" line is printed for a perfectly normal code path.
    let head_has_file = git_succeeds(
        &work_dir,
        &["cat-file", "-e", &format!("HEAD:{rel_norm}")],
        "cat-file",
    )?;

    if head_has_file {
        git_output(
            &work_dir,
            &["checkout", "HEAD", "--", &rel_norm],
            "checkout",
        )?;
        return Ok(());
    }

    // The path has no `HEAD` blob at this exact location, but it might
    // still be a rename/copy *destination* — the original content then
    // lives at a different `HEAD` path, not at this one. Falling
    // through to the delete-the-worktree-file branch below would
    // permanently destroy that content (it exists in no git object at
    // this path) and leave the rename source staged as a plain
    // deletion — a strictly worse state than before. Detect this first
    // (checking the staged case, then the working-tree-detected case,
    // e.g. after `git add -N`) and restore non-destructively instead.
    let rename_source = match find_rename_source(&work_dir, &rel_norm, true)? {
        Some(src) => Some(src),
        None => find_rename_source(&work_dir, &rel_norm, false)?,
    };
    if let Some(old_path) = rename_source {
        git_output(&work_dir, &["reset", "--", &rel_norm], "reset")?;
        git_output(
            &work_dir,
            &["checkout", "HEAD", "--", &old_path],
            "checkout",
        )?;

        // The physical file was moved to the new name; now that the
        // original has been restored at its own path, remove it there.
        if abs.exists() {
            match std::fs::remove_file(&abs) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("failed to remove {rel_norm}: {e}")),
            }
        }
        return Ok(());
    }

    // No `HEAD` version exists: unstage (no-op if never staged) then
    // delete the working-tree file — see the destructive-footgun note
    // above.
    git_output(&work_dir, &["reset", "--", &rel_norm], "reset")?;

    match std::fs::remove_file(&abs) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("failed to remove {rel_norm}: {e}")),
    }
}

/// Whether `rel_norm` is the *destination* of a rename/copy detected by
/// `git diff --name-status -M -z` (staged when `staged` is `true`,
/// otherwise worktree vs index). The diff is intentionally run
/// unfiltered (no trailing pathspec) and scanned for a matching
/// destination: pathspec-limiting the diff to just `rel_norm` would
/// exclude the rename's source path from the compared set, which
/// silently defeats git's own rename detection (verified against a
/// real repository — `git diff --name-status -M -z -- <dest>` reports
/// a plain add, not a rename, once the source is filtered out).
fn find_rename_source(
    work_dir: &Path,
    rel_norm: &str,
    staged: bool,
) -> Result<Option<String>, String> {
    let mut args = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--name-status", "-M", "-z"]);

    let stdout = git_output(work_dir, &args, "diff --name-status")?;

    let mut fields = stdout.split(|&b| b == 0).filter(|f| !f.is_empty());
    while let Some(status_field) = fields.next() {
        let is_rename_or_copy = status_field
            .first()
            .is_some_and(|&b| b == b'R' || b == b'C');
        if is_rename_or_copy {
            let old_path = fields
                .next()
                .map(|f| String::from_utf8_lossy(f).into_owned());
            let new_path = fields
                .next()
                .map(|f| String::from_utf8_lossy(f).into_owned());
            if new_path.as_deref() == Some(rel_norm) {
                return Ok(old_path);
            }
        } else {
            let _ = fields.next(); // single-path record; consume and skip
        }
    }
    Ok(None)
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::{accept, git, git_in, reject, switch_branch, validate_relative_path};
    use crate::test_support::{executable, TempDir};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    /// `true` once, cached for the process — avoids spawning `git
    /// --version` from every single test.
    fn git_available() -> bool {
        static AVAILABLE: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| {
            std::process::Command::new("git")
                .arg("--version")
                .output()
                .is_ok()
        });
        *AVAILABLE
    }

    fn unique_temp_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        std::env::temp_dir().join(format!(
            "omp-workspace-test-{tag}-{}-{n}-{nanos}",
            std::process::id()
        ))
    }

    /// Run `git args` in `dir`, panicking on failure; its stdout, trimmed.
    fn run_git(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .expect("spawn git");
        assert!(
            out.status.success(),
            "git {args:?} failed in {dir:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// Build a real throwaway git repo with one committed file, so `HEAD`
    /// exists and later worktree edits give `accept` (stage) and `reject`
    /// (restore from `HEAD`) real changes to act on.
    /// Returns `None` (soft-skip) if `git` isn't on `PATH`.
    fn init_repo(tag: &str) -> Option<PathBuf> {
        if !git_available() {
            eprintln!("git binary not available; skipping {tag}");
            return None;
        }
        let dir = unique_temp_dir(tag);
        std::fs::create_dir_all(&dir).expect("create temp repo dir");
        run_git(&dir, &["init", "-q"]);
        run_git(&dir, &["config", "user.email", "test@example.com"]);
        run_git(&dir, &["config", "user.name", "Test"]);
        // Byte-exact content assertions must not depend on the machine's
        // global git config: Windows runners set `core.autocrlf=true`, which
        // turns a restored "base content\n" into "base content\r\n".
        run_git(&dir, &["config", "core.autocrlf", "false"]);
        std::fs::write(dir.join("committed.txt"), "base content\n").expect("write base file");
        run_git(&dir, &["add", "."]);
        run_git(&dir, &["commit", "-q", "-m", "init"]);
        Some(dir)
    }

    // ── git resolution ───────────────────────────────────────────────────

    /// The attack: a project shipping its own `git`, reached through an
    /// empty or relative PATH entry (`execvp` resolves those in the child's
    /// working directory, the project). Only the absolute folder's `git`
    /// is ever picked, by absolute path, with only that folder as PATH.
    #[test]
    fn git_never_runs_a_project_supplied_git() {
        let dir = TempDir::new("workspace", "git-lookup");
        let project = dir.path().join("project");
        let trusted = dir.path().join("bin");
        let git_file = format!("git{}", std::env::consts::EXE_SUFFIX);
        executable(&project.join(&git_file), "");
        let real = executable(&trusted.join(&git_file), "");

        // `child_path_dirs` has already dropped the empty and relative PATH
        // entries (`child_path`'s tests), so only the trusted folder is left.
        let err = git_in(&[], &project).unwrap_err();
        assert!(err.contains("git was not found"), "{err}");

        let cmd = git_in(std::slice::from_ref(&trusted), &project).unwrap();
        assert_eq!(Path::new(cmd.get_program()), real);
        let child_path = cmd.get_envs().find(|(key, _)| *key == "PATH");
        assert_eq!(child_path.and_then(|(_, v)| v), Some(trusted.as_os_str()));
        assert_eq!(
            cmd.get_args().collect::<Vec<_>>(),
            ["--literal-pathspecs", "--no-optional-locks"]
        );
    }

    /// The real environment: `git` resolves to an absolute binary that runs.
    #[test]
    fn git_runs_the_installed_git_by_absolute_path() {
        if !git_available() {
            eprintln!("git binary not available; skipping");
            return;
        }
        let dir = TempDir::new("workspace", "git-installed");
        let mut cmd = git(dir.path()).unwrap();
        assert!(Path::new(cmd.get_program()).is_absolute());
        let out = cmd.arg("--version").output().unwrap();
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).starts_with("git version"));
    }

    // ── validate_relative_path ───────────────────────────────────────────

    #[test]
    fn validate_relative_path_rejects_traversal() {
        let root = std::env::temp_dir();
        assert!(validate_relative_path(&root, "../etc/passwd").is_err());
        assert!(validate_relative_path(&root, "foo/../../bar").is_err());
    }

    #[test]
    fn validate_relative_path_rejects_absolute_and_drive_paths() {
        let root = std::env::temp_dir();
        assert!(validate_relative_path(&root, "/etc/passwd").is_err());
        assert!(validate_relative_path(&root, "\\\\server\\share\\f").is_err());
        assert!(validate_relative_path(&root, "C:\\Windows\\system32").is_err());
    }

    #[test]
    fn validate_relative_path_rejects_empty() {
        let root = std::env::temp_dir();
        assert!(validate_relative_path(&root, "").is_err());
    }

    #[test]
    fn validate_relative_path_accepts_normal_path_in_real_repo() {
        let Some(repo) = init_repo("validate-ok") else {
            return;
        };
        let (resolved, _) = validate_relative_path(&repo, "committed.txt")
            .expect("normal relative path should validate");
        let canonical_root = std::fs::canonicalize(&repo).expect("canonicalize root");
        assert!(resolved.starts_with(&canonical_root));
        assert!(resolved.ends_with("committed.txt"));
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    #[cfg(unix)]
    fn validate_relative_path_rejects_symlink_directory_escape() {
        let Some(repo) = init_repo("validate-symlink-escape") else {
            return;
        };
        let outside = unique_temp_dir("validate-symlink-escape-outside");
        std::fs::create_dir_all(&outside).expect("create outside dir");
        std::os::unix::fs::symlink(&outside, repo.join("escape")).expect("create symlink");

        // "escape" is a symlink to a directory outside the repo; a path
        // walking *through* it must still be rejected, since the
        // directory component is canonicalized (only the final path
        // component is exempt from symlink resolution).
        assert!(validate_relative_path(&repo, "escape/x").is_err());

        std::fs::remove_dir_all(&outside).ok();
        std::fs::remove_dir_all(&repo).ok();
    }

    // ── accept / reject ──────────────────────────────────────────────────

    #[test]
    fn accept_stages_a_modified_file() {
        let Some(repo) = init_repo("accept-basic") else {
            return;
        };
        std::fs::write(repo.join("committed.txt"), "staged change\n").expect("modify tracked file");

        accept(&repo, "committed.txt").expect("accept should succeed");

        let output = std::process::Command::new("git")
            .current_dir(&repo)
            .args(["diff", "--cached", "--name-only"])
            .output()
            .expect("git diff --cached");
        let staged = String::from_utf8_lossy(&output.stdout);
        assert!(staged.contains("committed.txt"));

        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn reject_restores_head_content_for_tracked_file() {
        let Some(repo) = init_repo("reject-tracked") else {
            return;
        };
        std::fs::write(repo.join("committed.txt"), "will be discarded\n")
            .expect("modify tracked file");

        reject(&repo, "committed.txt").expect("reject should succeed");

        let content = std::fs::read_to_string(repo.join("committed.txt")).expect("read file back");
        assert_eq!(content, "base content\n");

        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn reject_deletes_untracked_file() {
        let Some(repo) = init_repo("reject-untracked") else {
            return;
        };
        let path = repo.join("scratch.txt");
        std::fs::write(&path, "temporary\n").expect("write untracked file");

        reject(&repo, "scratch.txt").expect("reject should succeed");

        assert!(!path.exists());

        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    #[cfg(unix)]
    fn reject_on_untracked_symlink_does_not_touch_symlink_target() {
        let Some(repo) = init_repo("reject-symlink-target") else {
            return;
        };
        std::fs::write(repo.join("b.txt"), "b base\n").expect("write b.txt");
        run_git(&repo, &["add", "b.txt"]);
        run_git(&repo, &["commit", "-q", "-m", "add b"]);
        std::fs::write(repo.join("b.txt"), "b uncommitted change\n")
            .expect("modify tracked file b.txt");

        std::os::unix::fs::symlink("b.txt", repo.join("link_a")).expect("create symlink");

        reject(&repo, "link_a").expect("reject should succeed");

        // The symlink itself is untracked, so `reject` removes it — but
        // must not follow it. The old, buggy `validate_relative_path`
        // resolved through the symlink to "b.txt" and would instead run
        // `git checkout HEAD -- b.txt`, silently discarding b.txt's
        // uncommitted change while leaving the symlink untouched.
        assert!(std::fs::symlink_metadata(repo.join("link_a")).is_err());
        let b_content = std::fs::read_to_string(repo.join("b.txt")).expect("read b.txt back");
        assert_eq!(b_content, "b uncommitted change\n");

        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    #[cfg(unix)]
    fn reject_with_glob_metacharacter_path_does_not_affect_other_files() {
        let Some(repo) = init_repo("reject-literal-pathspec") else {
            return;
        };
        std::fs::write(repo.join("a?.txt"), "a base\n").expect("write a?.txt");
        std::fs::write(repo.join("ab.txt"), "ab base\n").expect("write ab.txt");
        run_git(&repo, &["add", "a?.txt", "ab.txt"]);
        run_git(&repo, &["commit", "-q", "-m", "add a? and ab"]);

        std::fs::write(repo.join("a?.txt"), "a changed\n").expect("modify a?.txt");
        std::fs::write(repo.join("ab.txt"), "ab changed\n").expect("modify ab.txt");

        reject(&repo, "a?.txt").expect("reject should succeed");

        // Without `--literal-pathspecs`, "a?.txt" is a wildmatch glob
        // that also matches "ab.txt", so `git checkout HEAD -- a?.txt`
        // would collaterally revert ab.txt's uncommitted change too.
        let glob_target_content =
            std::fs::read_to_string(repo.join("a?.txt")).expect("read a?.txt back");
        assert_eq!(glob_target_content, "a base\n");
        let sibling_content =
            std::fs::read_to_string(repo.join("ab.txt")).expect("read ab.txt back");
        assert_eq!(sibling_content, "ab changed\n");

        std::fs::remove_dir_all(&repo).ok();
    }

    // ── accept/reject path guards ───────────────────────────────────────

    #[test]
    fn accept_and_reject_refuse_path_traversal() {
        let Some(repo) = init_repo("accept-reject-traversal") else {
            return;
        };
        assert!(accept(&repo, "../outside.txt").is_err());
        assert!(reject(&repo, "../outside.txt").is_err());
        std::fs::remove_dir_all(&repo).ok();
    }

    // ── .git path guard (bug #1) ─────────────────────────────────────────

    #[test]
    fn validate_relative_path_rejects_dot_git_component() {
        let root = std::env::temp_dir();
        assert!(validate_relative_path(&root, ".git/config").is_err());
        assert!(validate_relative_path(&root, ".git/HEAD").is_err());
        assert!(validate_relative_path(&root, ".git").is_err());
        assert!(validate_relative_path(&root, "sub/.git/index").is_err());
        // NTFS/APFS resolve ".GIT" to the same directory as ".git".
        assert!(validate_relative_path(&root, ".GIT/config").is_err());
    }

    #[test]
    fn accept_reject_refuse_dot_git_paths() {
        let Some(repo) = init_repo("dot-git-guard") else {
            return;
        };
        for p in [".git/config", ".git/HEAD", ".git"] {
            assert!(accept(&repo, p).is_err(), "accept({p}) should be rejected");
            assert!(reject(&repo, p).is_err(), "reject({p}) should be rejected");
        }
        // The real git index must be untouched by the rejected attempts
        // above — this is the actual data-loss scenario the guard
        // prevents (`reject(repo, ".git/index")` used to delete it).
        assert!(repo.join(".git").join("index").exists());

        std::fs::remove_dir_all(&repo).ok();
    }

    // ── non-destructive reject on rename destinations (bug #3) ──────────

    #[test]
    fn reject_restores_rename_source_instead_of_deleting_content() {
        let Some(repo) = init_repo("reject-rename-destination") else {
            return;
        };
        // committed.txt -> renamed.txt via a staged `git mv`, then
        // further edited, so "renamed.txt" has no HEAD blob and would
        // otherwise fall into the destructive "no HEAD version" delete
        // branch.
        run_git(&repo, &["mv", "committed.txt", "renamed.txt"]);
        let mut edited = std::fs::read_to_string(repo.join("renamed.txt")).expect("read renamed");
        edited.push_str("extra edit\n");
        std::fs::write(repo.join("renamed.txt"), &edited).expect("append edit");

        reject(&repo, "renamed.txt").expect("reject should succeed");

        assert!(
            !repo.join("renamed.txt").exists(),
            "renamed.txt should no longer exist"
        );
        let restored = std::fs::read_to_string(repo.join("committed.txt"))
            .expect("committed.txt should be restored at its original path");
        assert_eq!(restored, "base content\n");

        let status_output = std::process::Command::new("git")
            .current_dir(&repo)
            .args(["status", "--porcelain=v1"])
            .output()
            .expect("git status");
        assert!(
            status_output.stdout.is_empty(),
            "git status should be clean, got: {}",
            String::from_utf8_lossy(&status_output.stdout)
        );

        std::fs::remove_dir_all(&repo).ok();
    }

    // ── lower-priority hardening (bugs #5-#8) ────────────────────────────

    #[test]
    #[cfg(unix)]
    fn validate_relative_path_treats_backslash_as_literal_on_unix() {
        let Some(repo) = init_repo("validate-backslash-literal") else {
            return;
        };
        // On Unix, `\` is a legal filename byte, not a separator. Before
        // the fix, `rel.replace('\\', "/")` ran unconditionally and
        // split this into a "a" directory plus "b.txt" file, silently
        // resolving to the wrong path.
        let (resolved, _) = validate_relative_path(&repo, "a\\b.txt")
            .expect("should validate as one literal path component");
        assert_eq!(
            resolved.file_name().and_then(|n| n.to_str()),
            Some("a\\b.txt")
        );

        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn accept_and_reject_refuse_directory_targets() {
        let Some(repo) = init_repo("accept-reject-directory-guard") else {
            return;
        };
        std::fs::create_dir_all(repo.join("subdir")).expect("create subdir");
        std::fs::write(repo.join("subdir/file.txt"), "content\n").expect("write file in subdir");
        run_git(&repo, &["add", "."]);
        run_git(&repo, &["commit", "-q", "-m", "add subdir"]);
        std::fs::write(repo.join("subdir/file.txt"), "changed\n").expect("modify file in subdir");

        assert!(
            accept(&repo, "subdir").is_err(),
            "accept on a directory should be rejected"
        );
        assert!(
            reject(&repo, "subdir").is_err(),
            "reject on a directory should be rejected"
        );

        // The file inside the directory must be untouched by the
        // rejected whole-directory operation — before the fix,
        // `git checkout HEAD -- subdir` would have reverted the entire
        // subtree from a single call.
        let content = std::fs::read_to_string(repo.join("subdir/file.txt")).expect("read back");
        assert_eq!(content, "changed\n");

        std::fs::remove_dir_all(&repo).ok();
    }

    // ── switch_branch ────────────────────────────────────────────────────

    fn current_branch(dir: &Path) -> String {
        run_git(dir, &["rev-parse", "--abbrev-ref", "HEAD"])
    }

    #[test]
    fn switch_branch_checks_out_a_listed_local_branch() {
        let Some(repo) = init_repo("switch-local") else {
            return;
        };
        let start = current_branch(&repo);
        run_git(&repo, &["branch", "other"]);

        switch_branch(&repo, "other", false).expect("switch to other");
        assert_eq!(current_branch(&repo), "other");
        switch_branch(&repo, &start, false).expect("switch back");
        assert_eq!(current_branch(&repo), start);
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn switch_branch_tracks_a_remote_branch_under_its_local_name() {
        let Some(repo) = init_repo("switch-remote") else {
            return;
        };
        let head = run_git(&repo, &["rev-parse", "HEAD"]);
        run_git(&repo, &["remote", "add", "origin", "../nowhere"]);
        run_git(&repo, &["update-ref", "refs/remotes/origin/feat/x", &head]);
        // A local branch named like the remote one: the short `origin/feat/x`
        // would be ambiguous to git.
        run_git(&repo, &["branch", "origin/feat/x"]);

        switch_branch(&repo, "origin/feat/x", true).expect("switch to origin/feat/x");
        assert_eq!(current_branch(&repo), "feat/x");
        assert_eq!(
            run_git(
                &repo,
                &["rev-parse", "--symbolic-full-name", "feat/x@{upstream}"]
            ),
            "refs/remotes/origin/feat/x"
        );
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn switch_branch_refuses_names_it_does_not_list() {
        let Some(repo) = init_repo("switch-refuse") else {
            return;
        };
        let start = current_branch(&repo);
        run_git(&repo, &["branch", "other"]);
        for (name, remote) in [
            ("missing", false),
            (start.as_str(), false), // checked out already
            ("other", true),         // a local branch, asked for as remote
            ("--orphan=x", false),   // an option, never a listed ref
        ] {
            let err = switch_branch(&repo, name, remote).unwrap_err();
            assert!(err.contains("not a branch to switch to"), "{name}: {err}");
        }
        assert_eq!(current_branch(&repo), start);
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn switch_branch_reports_git_refusing_to_overwrite_local_changes() {
        let Some(repo) = init_repo("switch-dirty") else {
            return;
        };
        let start = current_branch(&repo);
        run_git(&repo, &["checkout", "-q", "-b", "other"]);
        std::fs::write(repo.join("committed.txt"), "other content\n").expect("write");
        run_git(&repo, &["commit", "-q", "-am", "other"]);
        run_git(&repo, &["checkout", "-q", &start]);
        std::fs::write(repo.join("committed.txt"), "local edit\n").expect("write");

        let err = switch_branch(&repo, "other", false).unwrap_err();
        assert!(err.contains("git switch failed"), "{err}");
        assert_eq!(current_branch(&repo), start);
        let content = std::fs::read_to_string(repo.join("committed.txt")).expect("read back");
        assert_eq!(content, "local edit\n");
        std::fs::remove_dir_all(&repo).ok();
    }
}
