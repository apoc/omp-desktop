//! Git working-tree introspection for the "Changes" panel — bounded,
//! validated status/diff/accept/reject operations on a single repository.
//!
//! ### gix vs `git` — where each is used
//!
//! [`validate_relative_path`] and repository discovery/validation use the
//! filesystem and [`gix`] (the same `gix::discover` pattern as [`crate::git`]),
//! matching the established pattern in this codebase.
//!
//! [`status`] and [`diff`] shell out to the `git` binary for the actual
//! data. Both are read-only operations, invoked with a fully static argv
//! (never a shell string, never an interpolated shell command) via
//! [`std::process::Command`]. See the doc comment on each function for the
//! specific justification — in short, gix's status/diff building blocks
//! (`gix::status::Iter`'s mix of `index_worktree::Item` and
//! `gix_diff::index::Change`, and `gix_diff::blob`'s line-diff primitives)
//! would require re-implementing git's own status-merge and unified-diff
//! formatting logic by hand, whereas `git status --porcelain=v1` and
//! `git diff` already do this correctly and stably.
//!
//! [`accept`] and [`reject`] also shell out, for the same reason: gix
//! 0.83's index-writing/checkout support is far less mature than its read
//! APIs, and `git add` / `git checkout` / `git reset` already implement
//! safe, atomic index and worktree mutation.

use std::path::{Path, PathBuf};
use std::process::Command;

// ── path validation ─────────────────────────────────────────────────────────

/// Validate that `rel` is a plain, traversal-free path relative to
/// `repo_root`, and return its canonicalized absolute form.
///
/// Rejects:
/// - an empty string,
/// - an absolute path (`/etc/passwd`),
/// - a UNC path (`\\server\share\...` or `//server/share/...`),
/// - a Windows drive-letter path (`C:\...`),
/// - any path containing a `..` component.
///
/// Separators are normalized to `/` before joining onto `repo_root`. The
/// joined candidate is then resolved and checked to still live inside
/// `repo_root`, guarding against symlink escapes: components of the path
/// that exist on disk are fully canonicalized (resolving any symlinks),
/// and only the non-existent tail (which by definition cannot be a
/// symlink) is joined on lexically. This lets validation succeed for
/// paths that don't exist yet — e.g. a working-tree file already deleted,
/// pending a `reject`-triggered restore from `HEAD` — while still
/// defeating symlink escapes for every path segment that does exist.
pub fn validate_relative_path(repo_root: &Path, rel: &str) -> Result<PathBuf, String> {
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

    let normalized = rel.replace('\\', "/");
    if normalized
        .split('/')
        .any(|seg| seg == ".." || seg.is_empty())
    {
        return Err("path must not contain '..' or empty components".to_string());
    }

    let canonical_root = std::fs::canonicalize(repo_root)
        .map_err(|e| format!("failed to canonicalize repository root: {e}"))?;
    let candidate = canonical_root.join(&normalized);
    let resolved =
        weakly_canonicalize(&candidate).map_err(|e| format!("failed to resolve path: {e}"))?;

    if !resolved.starts_with(&canonical_root) {
        return Err("path escapes repository root".to_string());
    }
    Ok(resolved)
}

/// Canonicalize the longest existing ancestor of `path`, then lexically
/// re-append whatever suffix doesn't exist yet. A non-existent path
/// segment cannot itself be a symlink, so this preserves the symlink-
/// escape guarantee of [`std::fs::canonicalize`] for every segment that
/// is actually resolvable, while still returning a usable path for
/// not-yet-existing targets.
fn weakly_canonicalize(path: &Path) -> std::io::Result<PathBuf> {
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

/// Resolve `abs` (already validated by [`validate_relative_path`]) to a
/// `/`-separated path relative to `work_dir`, suitable for passing to
/// `git` as a pathspec.
fn to_repo_relative(work_dir: &Path, abs: &Path) -> Result<String, String> {
    let canonical_root = std::fs::canonicalize(work_dir)
        .map_err(|e| format!("failed to canonicalize repository root: {e}"))?;
    let rel = abs
        .strip_prefix(&canonical_root)
        .map_err(|_| "path escapes repository root".to_string())?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

/// Open `repo_root` with gix (same discovery pattern as [`crate::git::probe`])
/// and return its working-tree root, failing clearly for bare repositories
/// or paths that aren't inside a git repository at all.
fn discover_work_dir(repo_root: &Path) -> Result<PathBuf, String> {
    let repo = gix::discover(repo_root).map_err(|e| format!("not a git repository: {e}"))?;
    repo.workdir()
        .map(Path::to_path_buf)
        .ok_or_else(|| "repository has no working tree".to_string())
}

// ── status ───────────────────────────────────────────────────────────────────

/// Maximum number of files reported by [`status`]; beyond this the result
/// is marked `truncated` rather than growing unbounded for huge repos.
const STATUS_CAP: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum StatusKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FileStatus {
    pub path: String,
    pub kind: StatusKind,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StatusResult {
    pub files: Vec<FileStatus>,
    pub truncated: bool,
}

/// Report working-tree status (`HEAD` vs index vs worktree, combined),
/// capped at [`STATUS_CAP`] entries.
///
/// ### Why shell out to `git` here
///
/// gix's [`gix::status::Platform`] iterator yields two independent kinds
/// of low-level items — `index_worktree::Item` (worktree vs index,
/// itself with tracked-change, rewrite, and untracked/directory-contents
/// sub-variants) and `gix_diff::index::Change` (index vs `HEAD` tree) —
/// which must be merged and reduced to git's familiar single `XY` status
/// classification (including rename-pair merging) ourselves.
/// `git status --porcelain=v1 -z` already performs exactly that
/// merge-and-classify step in a stable, machine-parseable format, so we
/// shell out rather than re-implement git's own status-merge logic on
/// top of gix's raw building blocks.
pub fn status(repo_root: &Path) -> Result<StatusResult, String> {
    let work_dir = discover_work_dir(repo_root)?;

    let output = Command::new("git")
        .current_dir(&work_dir)
        .args(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .output()
        .map_err(|e| format!("failed to run git status: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "git status failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(parse_porcelain_z(&output.stdout))
}

/// Parse `git status --porcelain=v1 -z` output into a capped, classified
/// file list. The whole output is walked (git has already paid the cost
/// of enumerating every change to produce it), so `truncated` reflects
/// the exact presence of entries beyond the cap, not an approximation.
fn parse_porcelain_z(bytes: &[u8]) -> StatusResult {
    let mut files = Vec::new();
    let mut truncated = false;
    let mut fields = bytes.split(|&b| b == 0).filter(|f| !f.is_empty());

    while let Some(entry) = fields.next() {
        if entry.len() < 3 {
            continue; // malformed/short record; skip defensively
        }
        let x = entry[0];
        let y = entry[1];
        let path = String::from_utf8_lossy(&entry[3..]).into_owned();
        if x == b'R' || x == b'C' {
            // Rename/copy entries carry a paired original path in the
            // next NUL-delimited field; consume and discard it (only the
            // current path is part of our `FileStatus` surface).
            let _orig_path = fields.next();
        }

        if files.len() < STATUS_CAP {
            files.push(FileStatus {
                path,
                kind: classify(x, y),
            });
        } else {
            truncated = true;
        }
    }

    StatusResult { files, truncated }
}

/// Map a porcelain `XY` status pair to our simplified [`StatusKind`].
const fn classify(x: u8, y: u8) -> StatusKind {
    if x == b'?' || y == b'?' {
        StatusKind::Untracked
    } else if x == b'R' || y == b'R' || x == b'C' || y == b'C' {
        StatusKind::Renamed
    } else if x == b'A' || y == b'A' {
        StatusKind::Added
    } else if x == b'D' || y == b'D' {
        StatusKind::Deleted
    } else {
        StatusKind::Modified
    }
}

// ── diff ─────────────────────────────────────────────────────────────────────

/// Hard caps applied to diff text so a single huge file can never blow up
/// IPC payload size or renderer memory.
const DIFF_MAX_BYTES: usize = 256 * 1024;
const DIFF_MAX_LINES: usize = 2000;
const DIFF_MAX_LINE_CHARS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum DiffKind {
    Text,
    Binary,
    Untracked,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DiffResult {
    pub kind: DiffKind,
    pub path: String,
    pub content: Option<String>,
    pub truncated: bool,
}

/// Diff a single file against `HEAD` (combined index + worktree changes,
/// matching `git diff HEAD -- <path>`), hard-capped in size.
///
/// ### Why shell out to `git` here
///
/// Producing unified-diff text and detecting binary content are both
/// substantial, already-correct pieces of logic in `git diff` (xdiff-based
/// unified-hunk formatting, plus git's own binary-content heuristic).
/// Re-implementing this on gix's blob-diff primitives (`gix_diff::blob`,
/// backed by `imara-diff`) would mean hand-rolling unified-diff hunk
/// formatting and a binary-sniffing heuristic ourselves for no behavioral
/// benefit, so we shell out for this specific operation.
pub fn diff(repo_root: &Path, rel_path: &str) -> Result<DiffResult, String> {
    let abs = validate_relative_path(repo_root, rel_path)?;
    let work_dir = discover_work_dir(repo_root)?;
    let rel_norm = to_repo_relative(&work_dir, &abs)?;

    let output = Command::new("git")
        .current_dir(&work_dir)
        .args(["diff", "HEAD", "--no-color", "--", &rel_norm])
        .output()
        .map_err(|e| format!("failed to run git diff: {e}"))?;
    // `git diff` (without `--exit-code`) only returns non-zero on a real
    // error, never merely because differences exist.
    if !output.status.success() {
        return Err(format!(
            "git diff failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    if output.stdout.is_empty() {
        // `git diff HEAD` silently ignores untracked paths, so empty
        // output is ambiguous between "untracked" and "unmodified
        // tracked file" — disambiguate with a cheap `ls-files` check.
        return if is_tracked(&work_dir, &rel_norm)? {
            Ok(DiffResult {
                kind: DiffKind::Text,
                path: rel_norm,
                content: Some(String::new()),
                truncated: false,
            })
        } else {
            Ok(DiffResult {
                kind: DiffKind::Untracked,
                path: rel_norm,
                content: None,
                truncated: false,
            })
        };
    }

    let text = String::from_utf8_lossy(&output.stdout);
    if text.lines().any(|line| line.starts_with("Binary files ")) {
        return Ok(DiffResult {
            kind: DiffKind::Binary,
            path: rel_norm,
            content: None,
            truncated: false,
        });
    }

    let (content, truncated) = cap_diff_text(&text);
    Ok(DiffResult {
        kind: DiffKind::Text,
        path: rel_norm,
        content: Some(content),
        truncated,
    })
}

/// Whether `rel_norm` is currently tracked by git (present in the index).
fn is_tracked(work_dir: &Path, rel_norm: &str) -> Result<bool, String> {
    let output = Command::new("git")
        .current_dir(work_dir)
        .args(["ls-files", "--", rel_norm])
        .output()
        .map_err(|e| format!("failed to run git ls-files: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "git ls-files failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(!output.stdout.is_empty())
}

/// Cap diff text at [`DIFF_MAX_BYTES`] / [`DIFF_MAX_LINES`] /
/// [`DIFF_MAX_LINE_CHARS`], truncating on line and `char` boundaries only
/// (never mid-UTF-8-character) so the result is always valid UTF-8.
/// Returns the capped text and whether any cap was actually hit.
fn cap_diff_text(text: &str) -> (String, bool) {
    let mut out = String::new();
    let mut truncated = false;

    'lines: for (line_idx, line) in text.lines().enumerate() {
        if line_idx >= DIFF_MAX_LINES {
            truncated = true;
            break;
        }
        for (char_idx, ch) in line.chars().enumerate() {
            if char_idx >= DIFF_MAX_LINE_CHARS {
                truncated = true;
                break;
            }
            if out.len() + ch.len_utf8() > DIFF_MAX_BYTES {
                truncated = true;
                break 'lines;
            }
            out.push(ch);
        }
        if out.len() + 1 > DIFF_MAX_BYTES {
            truncated = true;
            break;
        }
        out.push('\n');
    }

    (out, truncated)
}

// ── accept / reject ─────────────────────────────────────────────────────────

/// Stage a single file's working-tree changes (equivalent to
/// `git add -- <path>`).
///
/// Refuses to run for any path outside `repo_root` or any path-traversal
/// attempt: `rel_path` is validated with [`validate_relative_path`]
/// before any git command is invoked.
///
/// ### Why shell out to `git` here
///
/// gix 0.83's in-memory index API can stage individual entries, but
/// hashing the current worktree content into a blob, computing correct
/// stat metadata, inserting at the right sorted position, and writing the
/// index back atomically is exactly what `git add` already does safely.
/// Shelling out for this single mutating call avoids re-implementing
/// index-writing by hand.
pub fn accept(repo_root: &Path, rel_path: &str) -> Result<(), String> {
    let abs = validate_relative_path(repo_root, rel_path)?;
    let work_dir = discover_work_dir(repo_root)?;
    let rel_norm = to_repo_relative(&work_dir, &abs)?;

    let output = Command::new("git")
        .current_dir(&work_dir)
        .args(["add", "--", &rel_norm])
        .output()
        .map_err(|e| format!("failed to run git add: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "git add failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
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
    let abs = validate_relative_path(repo_root, rel_path)?;
    let work_dir = discover_work_dir(repo_root)?;
    let rel_norm = to_repo_relative(&work_dir, &abs)?;

    // `-e` only needs the exit status; a missing path is an expected,
    // non-error outcome here (see the doc comment above), so stdout and
    // stderr are discarded to avoid printing a spurious-looking "fatal:
    // path does not exist" line for a perfectly normal code path.
    let head_has_file = Command::new("git")
        .current_dir(&work_dir)
        .args(["cat-file", "-e", &format!("HEAD:{rel_norm}")])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| format!("failed to run git cat-file: {e}"))?
        .success();

    if head_has_file {
        let output = Command::new("git")
            .current_dir(&work_dir)
            .args(["checkout", "HEAD", "--", &rel_norm])
            .output()
            .map_err(|e| format!("failed to run git checkout: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "git checkout failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        return Ok(());
    }

    // No `HEAD` version exists: unstage (no-op if never staged) then
    // delete the working-tree file — see the destructive-footgun note
    // above.
    let reset = Command::new("git")
        .current_dir(&work_dir)
        .args(["reset", "--", &rel_norm])
        .output()
        .map_err(|e| format!("failed to run git reset: {e}"))?;
    if !reset.status.success() {
        return Err(format!(
            "git reset failed: {}",
            String::from_utf8_lossy(&reset.stderr)
        ));
    }

    match std::fs::remove_file(&abs) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("failed to remove {rel_norm}: {e}")),
    }
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::{
        accept, cap_diff_text, classify, diff, parse_porcelain_z, reject, status,
        validate_relative_path, DiffKind, StatusKind,
    };
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

    fn run_git(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .current_dir(dir)
            .args(args)
            .status()
            .expect("spawn git");
        assert!(status.success(), "git {args:?} failed in {dir:?}");
    }

    /// Build a real throwaway git repo with one committed file, so `HEAD`
    /// exists and later worktree edits produce genuine status/diff output.
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
        std::fs::write(dir.join("committed.txt"), "base content\n").expect("write base file");
        run_git(&dir, &["add", "."]);
        run_git(&dir, &["commit", "-q", "-m", "init"]);
        Some(dir)
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
        let resolved = validate_relative_path(&repo, "committed.txt")
            .expect("normal relative path should validate");
        let canonical_root = std::fs::canonicalize(&repo).expect("canonicalize root");
        assert!(resolved.starts_with(&canonical_root));
        assert!(resolved.ends_with("committed.txt"));
        std::fs::remove_dir_all(&repo).ok();
    }

    // ── status ────────────────────────────────────────────────────────────

    #[test]
    fn classify_maps_porcelain_codes() {
        assert_eq!(classify(b'?', b'?'), StatusKind::Untracked);
        assert_eq!(classify(b' ', b'M'), StatusKind::Modified);
        assert_eq!(classify(b'A', b' '), StatusKind::Added);
        assert_eq!(classify(b' ', b'D'), StatusKind::Deleted);
        assert_eq!(classify(b'R', b'M'), StatusKind::Renamed);
    }

    #[test]
    fn parse_porcelain_z_consumes_rename_pair_and_caps_output() {
        // "RM bar.txt\0foo.txt\0??  baz.txt\0" — a rename plus an
        // untracked file, matching real `git status --porcelain=v1 -z`
        // byte layout (verified against a real git binary).
        let raw = b"RM bar.txt\0foo.txt\0?? baz.txt\0";
        let result = parse_porcelain_z(raw);
        assert!(!result.truncated);
        assert_eq!(result.files.len(), 2);
        assert_eq!(result.files[0].path, "bar.txt");
        assert_eq!(result.files[0].kind, StatusKind::Renamed);
        assert_eq!(result.files[1].path, "baz.txt");
        assert_eq!(result.files[1].kind, StatusKind::Untracked);
    }

    #[test]
    fn status_reports_untracked_and_modified_files() {
        let Some(repo) = init_repo("status-basic") else {
            return;
        };
        std::fs::write(repo.join("committed.txt"), "changed content\n")
            .expect("modify tracked file");
        std::fs::write(repo.join("new_file.txt"), "new\n").expect("write untracked file");

        let result = status(&repo).expect("status should succeed");
        assert!(!result.truncated);
        let untracked = result
            .files
            .iter()
            .find(|f| f.path == "new_file.txt")
            .expect("untracked file reported");
        assert_eq!(untracked.kind, StatusKind::Untracked);
        let modified = result
            .files
            .iter()
            .find(|f| f.path == "committed.txt")
            .expect("modified file reported");
        assert_eq!(modified.kind, StatusKind::Modified);

        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn status_caps_at_200_and_reports_truncated() {
        let Some(repo) = init_repo("status-cap") else {
            return;
        };
        for i in 0..201 {
            std::fs::write(repo.join(format!("untracked_{i}.txt")), "x").expect("write file");
        }

        let result = status(&repo).expect("status should succeed");
        assert_eq!(result.files.len(), 200);
        assert!(result.truncated);

        std::fs::remove_dir_all(&repo).ok();
    }

    // ── diff ──────────────────────────────────────────────────────────────

    #[test]
    fn cap_diff_text_truncates_long_lines_and_many_lines() {
        let long_line = "a".repeat(600);
        let text = std::iter::repeat_n(long_line.as_str(), 3)
            .collect::<Vec<_>>()
            .join("\n");
        let (capped, truncated) = cap_diff_text(&text);
        assert!(truncated);
        for line in capped.lines() {
            assert!(line.chars().count() <= 500);
        }
        assert!(capped.is_char_boundary(capped.len()));
    }

    #[test]
    fn cap_diff_text_leaves_small_input_untouched() {
        let (capped, truncated) = cap_diff_text("short\ndiff\n");
        assert!(!truncated);
        assert_eq!(capped, "short\ndiff\n");
    }

    #[test]
    fn diff_reports_untracked_for_new_file() {
        let Some(repo) = init_repo("diff-untracked") else {
            return;
        };
        std::fs::write(repo.join("new_file.txt"), "hello\n").expect("write untracked file");

        let result = diff(&repo, "new_file.txt").expect("diff should succeed");
        assert_eq!(result.kind, DiffKind::Untracked);
        assert!(result.content.is_none());

        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn diff_reports_text_with_content_for_modified_file() {
        let Some(repo) = init_repo("diff-modified") else {
            return;
        };
        std::fs::write(repo.join("committed.txt"), "changed content\n")
            .expect("modify tracked file");

        let result = diff(&repo, "committed.txt").expect("diff should succeed");
        assert_eq!(result.kind, DiffKind::Text);
        let content = result.content.expect("text diff has content");
        assert!(content.contains("changed content"));
        assert!(!result.truncated);

        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn diff_truncates_output_exceeding_caps() {
        let Some(repo) = init_repo("diff-truncate") else {
            return;
        };
        // Rewrite the tracked file with far more than 2000 lines so the
        // generated unified diff exceeds `DIFF_MAX_LINES`.
        let big = (0..3000)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(repo.join("committed.txt"), big).expect("write large file");

        let result = diff(&repo, "committed.txt").expect("diff should succeed");
        assert_eq!(result.kind, DiffKind::Text);
        assert!(result.truncated);
        let content = result.content.expect("text diff has content");
        assert!(content.lines().count() <= 2000);

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
    fn accept_and_reject_refuse_path_traversal() {
        let Some(repo) = init_repo("accept-reject-traversal") else {
            return;
        };
        assert!(accept(&repo, "../outside.txt").is_err());
        assert!(reject(&repo, "../outside.txt").is_err());
        std::fs::remove_dir_all(&repo).ok();
    }
}
