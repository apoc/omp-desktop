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
/// joined candidate's parent directory is then resolved and checked to
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

// ── git invocation ──────────────────────────────────────────────────────────

/// Build a `git` [`Command`] rooted at `work_dir` with every repo-agnostic
/// hardening flag already applied, so no call site can forget one:
///
/// - `--literal-pathspecs` — a path coming from the frontend is data, never
///   a pathspec expression; without this a file literally named `*.rs` or
///   `:(exclude)x` would be interpreted as a glob/magic pathspec.
/// - `--no-optional-locks` — never take a lock git considers optional (the
///   index refresh `git status` would otherwise perform). Mutating commands
///   still take the locks they genuinely require, so this is safe to apply
///   uniformly.
///
/// Every `git` invocation in this module goes through here. Subcommand-level
/// flags (`--no-ext-diff`, `--cached`, …) stay at their call sites.
fn git(work_dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(work_dir)
        .args(["--literal-pathspecs", "--no-optional-locks"]);
    cmd
}

/// Run a `git` subcommand and return its stdout, mapping both a spawn
/// failure and a non-zero exit into a `label`-prefixed error string.
fn git_output(work_dir: &Path, args: &[&str], label: &str) -> Result<Vec<u8>, String> {
    let output = git(work_dir)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git {label}: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "git {label} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(output.stdout)
}

/// Cap on how much of a child `git`'s stderr is retained for an error
/// message. Error output is a line or two in practice.
const STDERR_MAX_BYTES: usize = 64 * 1024;

/// How much of `git diff`'s stdout [`diff`] reads before giving up.
///
/// Larger than [`DIFF_MAX_BYTES`] because the cap that matters to the user is
/// applied by [`cap_diff_text`] *after* line/char clipping: reading a healthy
/// margin past the final budget means a diff whose early lines are clipped
/// still has later content available, while a runaway file is still bounded.
const DIFF_READ_MAX_BYTES: usize = 4 * 1024 * 1024;

/// Run a `git` subcommand, reading at most `cap` bytes of its stdout.
///
/// Unlike [`git_output`] (which is `Command::output()`, and so buffers the
/// child's *entire* stdout before any cap can apply), this stops reading at
/// `cap`. `git diff` on a single multi-hundred-megabyte generated file would
/// otherwise materialize that whole diff in memory — plus a same-size
/// `String` copy — only for [`cap_diff_text`] to throw all but 256 KiB away.
///
/// Returns `(stdout, hit_cap)`. When `hit_cap` is `true` the child is killed
/// and its exit status deliberately ignored: closing the pipe early makes
/// `git` die of `SIGPIPE`/`EPIPE`, which is the expected outcome here, not a
/// failure to report.
///
/// stderr is drained concurrently on its own thread (itself bounded). Reading
/// the two streams in sequence would deadlock if the child ever filled the
/// stderr pipe buffer while we were still draining stdout.
fn git_output_capped(
    work_dir: &Path,
    args: &[&str],
    label: &str,
    cap: usize,
) -> Result<(Vec<u8>, bool), String> {
    use std::io::Read as _;

    let mut child = git(work_dir)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run git {label}: {e}"))?;

    let stderr = child.stderr.take();
    let stderr_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(e) = stderr {
            // Bounded too — a pathological error stream must not be the new
            // unbounded allocation.
            let _ = e.take(STDERR_MAX_BYTES as u64).read_to_end(&mut buf);
        }
        buf
    });

    let mut stdout = Vec::new();
    let read_result = child.stdout.take().map_or(Ok(0), |out| {
        // One byte past the cap distinguishes "exactly cap bytes" from
        // "there was more".
        out.take(cap as u64 + 1).read_to_end(&mut stdout)
    });
    let hit_cap = stdout.len() > cap;
    if hit_cap {
        stdout.truncate(cap);
        let _ = child.kill();
    }

    let status = child.wait();
    let stderr_bytes = stderr_reader.join().unwrap_or_default();

    if hit_cap {
        // Early close killed the child; its status says nothing useful.
        return Ok((stdout, true));
    }
    read_result.map_err(|e| format!("failed to read git {label} output: {e}"))?;
    let status = status.map_err(|e| format!("failed to run git {label}: {e}"))?;
    if !status.success() {
        return Err(format!(
            "git {label} failed: {}",
            String::from_utf8_lossy(&stderr_bytes)
        ));
    }
    Ok((stdout, false))
}

/// Run a `git` subcommand purely for its exit status, discarding both
/// streams. For probes where a non-zero exit is an expected, non-error
/// answer (an unborn `HEAD`, a path absent from `HEAD`) rather than a
/// failure — printing their stderr would surface spurious-looking
/// "fatal:" lines for perfectly normal code paths.
fn git_succeeds(work_dir: &Path, args: &[&str], label: &str) -> Result<bool, String> {
    git(work_dir)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .map_err(|e| format!("failed to run git {label}: {e}"))
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

    let stdout = git_output(
        &work_dir,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        "status",
    )?;

    Ok(parse_porcelain_z(&stdout))
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
        if x == b'R' || x == b'C' || y == b'R' || y == b'C' {
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

/// How many leading lines are scanned for git's `Binary files ...` marker.
/// git writes it in the diff header; a handful of lines is ample headroom
/// over the `diff --git`/`index`/mode preamble.
const BINARY_MARKER_SCAN_LINES: usize = 8;

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
    let work_dir = discover_work_dir(repo_root)?;
    let (_abs, rel_norm) = validate_relative_path(&work_dir, rel_path)?;

    // `HEAD` may not resolve yet (a freshly initialized repo with zero
    // commits, i.e. "unborn HEAD") — `git diff HEAD` fails outright in
    // that case, so diff against git's well-known empty-tree object
    // instead, which makes every staged/worktree file show up as a
    // plain addition, exactly like a first-ever diff should.
    let head_resolved = git_succeeds(
        &work_dir,
        &["rev-parse", "--verify", "--quiet", "HEAD"],
        "rev-parse",
    )?;
    let diff_target = if head_resolved {
        "HEAD"
    } else {
        "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    };

    // `git diff` (without `--exit-code`) only returns non-zero on a real
    // error, never merely because differences exist.
    let (stdout, read_capped) = git_output_capped(
        &work_dir,
        &[
            "diff",
            diff_target,
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--",
            &rel_norm,
        ],
        "diff",
        DIFF_READ_MAX_BYTES,
    )?;

    if stdout.is_empty() {
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

    let text = String::from_utf8_lossy(&stdout);
    // git emits the binary marker in the diff header, so only the first few
    // lines can carry it — scanning the whole (capped, but still large) text
    // for it is wasted work.
    if text
        .lines()
        .take(BINARY_MARKER_SCAN_LINES)
        .any(|line| line.starts_with("Binary files "))
    {
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
        // Stopping the read early is itself a truncation, even in the
        // (impossible in practice) case where the retained prefix happened
        // to fit every cap_diff_text budget.
        truncated: truncated || read_capped,
    })
}

/// Whether `rel_norm` is currently tracked by git (present in the index).
fn is_tracked(work_dir: &Path, rel_norm: &str) -> Result<bool, String> {
    let stdout = git_output(work_dir, &["ls-files", "--", rel_norm], "ls-files")?;
    Ok(!stdout.is_empty())
}

/// Cap diff text at [`DIFF_MAX_BYTES`] / [`DIFF_MAX_LINES`] /
/// [`DIFF_MAX_LINE_CHARS`], truncating on line and `char` boundaries only
/// (never mid-UTF-8-character) so the result is always valid UTF-8.
/// Returns the capped text and whether any cap was actually hit.
fn cap_diff_text(text: &str) -> (String, bool) {
    let mut out = String::with_capacity(DIFF_MAX_BYTES.min(text.len()));
    let mut truncated = false;

    for (line_idx, line) in text.lines().enumerate() {
        if line_idx >= DIFF_MAX_LINES {
            truncated = true;
            break;
        }
        // Clip to DIFF_MAX_LINE_CHARS on a char boundary, then to whatever
        // of the global byte budget is left — both as byte offsets, so the
        // line is appended with one bulk copy rather than a push per char.
        let mut end = line.len();
        if let Some((offset, _)) = line.char_indices().nth(DIFF_MAX_LINE_CHARS) {
            end = offset;
            truncated = true;
        }
        let remaining = DIFF_MAX_BYTES.saturating_sub(out.len());
        if end > remaining {
            // Back off to the last char boundary that fits in the budget.
            end = line
                .char_indices()
                .map(|(i, _)| i)
                .take_while(|&i| i <= remaining)
                .last()
                .unwrap_or(0);
            out.push_str(&line[..end]);
            truncated = true;
            break;
        }
        out.push_str(&line[..end]);
        if out.len() + 1 > DIFF_MAX_BYTES {
            truncated = true;
            break;
        }
        out.push('\n');
    }

    (out, truncated)
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
    let work_dir = discover_work_dir(repo_root)?;
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
/// gix 0.83's in-memory index API can stage individual entries, but
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
    use super::{
        accept, cap_diff_text, classify, diff, git_output_capped, parse_porcelain_z, reject,
        status, validate_relative_path, DiffKind, StatusKind, DIFF_MAX_BYTES, DIFF_MAX_LINES,
        DIFF_MAX_LINE_CHARS,
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
        // Byte-exact content assertions must not depend on the machine's
        // global git config: Windows runners set `core.autocrlf=true`, which
        // turns a restored "base content\n" into "base content\r\n".
        run_git(&dir, &["config", "core.autocrlf", "false"]);
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

    /// Reference implementation: the original per-`char`-push form of
    /// [`cap_diff_text`], kept verbatim so the bulk-`push_str` rewrite can
    /// be proven byte-for-byte equivalent rather than merely "still passes
    /// the two hand-written cases".
    fn cap_diff_text_reference(text: &str) -> (String, bool) {
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

    #[test]
    fn cap_diff_text_matches_reference_implementation() {
        // Each case targets a distinct cap: none, line-char cap, line-count
        // cap, global byte cap, and the byte cap landing mid-multibyte-char.
        let big_line = "x".repeat(DIFF_MAX_LINE_CHARS + 37);
        let many_lines = (0..DIFF_MAX_LINES + 5)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        // Multibyte content sized so the byte budget runs out part-way
        // through a 3-byte character — the case a naive byte-slice would
        // panic on.
        let multibyte = "€".repeat(DIFF_MAX_BYTES);
        let mixed = format!("+ok\n-{big_line}\n {multibyte}\n+tail");

        let cases: [&str; 7] = [
            "",
            "short\ndiff\n",
            &big_line,
            &many_lines,
            &multibyte,
            &mixed,
            "no trailing newline",
        ];

        for (i, case) in cases.iter().enumerate() {
            let (got, got_trunc) = cap_diff_text(case);
            let (want, want_trunc) = cap_diff_text_reference(case);
            assert_eq!(got, want, "content mismatch for case {i}");
            assert_eq!(
                got_trunc, want_trunc,
                "truncated flag mismatch for case {i}"
            );
            assert!(got.len() <= DIFF_MAX_BYTES, "case {i} exceeded byte cap");
        }
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

    /// A diff far larger than `DIFF_READ_MAX_BYTES` must still return
    /// promptly, stay bounded, and be flagged truncated — the read now stops
    /// early instead of buffering the whole thing.
    #[test]
    fn diff_stops_reading_past_the_read_cap_and_reports_truncated() {
        let Some(repo) = init_repo("diff-read-cap") else {
            return;
        };
        // ~12 MiB of changed content: comfortably past DIFF_READ_MAX_BYTES
        // (4 MiB), so the early-stop path is the one exercised.
        let huge = "abcdefghijklmnopqrstuvwxyz0123456789\n".repeat(340_000);
        std::fs::write(repo.join("committed.txt"), huge).expect("write huge file");

        let result = diff(&repo, "committed.txt").expect("diff should succeed");
        assert_eq!(result.kind, DiffKind::Text);
        assert!(
            result.truncated,
            "an early-stopped read must report truncated"
        );
        let content = result.content.expect("text diff has content");
        assert!(
            content.len() <= DIFF_MAX_BYTES,
            "content {} exceeded the user-facing cap",
            content.len()
        );

        std::fs::remove_dir_all(&repo).ok();
    }

    /// The capped runner must still surface a real git failure (non-zero exit
    /// with a stderr message) rather than silently returning empty output.
    #[test]
    fn git_output_capped_reports_failure_from_stderr() {
        let Some(repo) = init_repo("capped-error") else {
            return;
        };
        let err = git_output_capped(
            &repo,
            &["rev-parse", "--verify", "definitely-not-a-ref"],
            "rev-parse",
            1024,
        )
        .expect_err("an unknown ref must be an error");
        assert!(
            err.starts_with("git rev-parse failed:"),
            "unexpected error text: {err}"
        );

        std::fs::remove_dir_all(&repo).ok();
    }

    /// The happy path must report `hit_cap == false` and return stdout intact.
    #[test]
    fn git_output_capped_returns_full_output_under_the_cap() {
        let Some(repo) = init_repo("capped-ok") else {
            return;
        };
        let (out, hit_cap) =
            git_output_capped(&repo, &["ls-files"], "ls-files", 1 << 20).expect("ls-files");
        assert!(!hit_cap);
        assert!(String::from_utf8_lossy(&out).contains("committed.txt"));

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

    // ── status/diff/accept/reject path-root consistency ─────────────────

    #[test]
    fn status_then_diff_succeed_when_project_path_is_repo_subdirectory() {
        if !git_available() {
            return;
        }
        let parent = unique_temp_dir("subdir-repo-parent");
        std::fs::create_dir_all(&parent).expect("create parent repo dir");
        run_git(&parent, &["init", "-q"]);
        run_git(&parent, &["config", "user.email", "test@example.com"]);
        run_git(&parent, &["config", "user.name", "Test"]);

        let child = parent.join("child");
        std::fs::create_dir_all(&child).expect("create child dir");
        std::fs::write(child.join("foo.txt"), "base\n").expect("write child file");
        run_git(&parent, &["add", "."]);
        run_git(&parent, &["commit", "-q", "-m", "init"]);

        std::fs::write(child.join("foo.txt"), "changed\n").expect("modify child file");

        // `status` discovers the real repo root (`parent`) and reports
        // paths relative to it, e.g. "child/foo.txt" — not relative to
        // the "project path" (`child`) passed in by the caller.
        let result = status(&child).expect("status should succeed");
        let reported = result
            .files
            .iter()
            .find(|f| f.path == "child/foo.txt")
            .expect("modified child file reported relative to repo root");
        assert_eq!(reported.kind, StatusKind::Modified);

        // `diff` must resolve that same reported path successfully even
        // though `child` (not `parent`) is the "project path" argument.
        let diff_result = diff(&child, &reported.path).expect("diff should succeed");
        assert_eq!(diff_result.kind, DiffKind::Text);
        let content = diff_result.content.expect("text diff has content");
        assert!(content.contains("changed"));

        std::fs::remove_dir_all(&parent).ok();
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
    fn accept_reject_diff_refuse_dot_git_paths() {
        let Some(repo) = init_repo("dot-git-guard") else {
            return;
        };
        for p in [".git/config", ".git/HEAD", ".git"] {
            assert!(accept(&repo, p).is_err(), "accept({p}) should be rejected");
            assert!(reject(&repo, p).is_err(), "reject({p}) should be rejected");
            assert!(diff(&repo, p).is_err(), "diff({p}) should be rejected");
        }
        // The real git index must be untouched by the rejected attempts
        // above — this is the actual data-loss scenario the guard
        // prevents (`reject(repo, ".git/index")` used to delete it).
        assert!(repo.join(".git").join("index").exists());

        std::fs::remove_dir_all(&repo).ok();
    }

    // ── Y-column rename parsing (bug #2) ─────────────────────────────────

    #[test]
    fn parse_porcelain_z_consumes_y_column_rename_pair() {
        // " R renamed.txt\0committed.txt\0" — a rename detected only in
        // the worktree-vs-index comparison (Y column), matching real
        // `git status --porcelain=v1 -z` output for `mv a b; git add -N
        // b` (verified against a real git binary). Before the fix, only
        // the X column was checked, so the paired source path
        // "committed.txt" was left unconsumed and re-parsed as its own
        // bogus status record.
        let raw = b" R renamed.txt\0committed.txt\0";
        let result = parse_porcelain_z(raw);
        assert!(!result.truncated);
        assert_eq!(result.files.len(), 1, "phantom entry: {:?}", result.files);
        assert_eq!(result.files[0].path, "renamed.txt");
        assert_eq!(result.files[0].kind, StatusKind::Renamed);
    }

    #[test]
    fn status_handles_y_column_rename_without_phantom_entries() {
        let Some(repo) = init_repo("status-y-column-rename") else {
            return;
        };
        std::fs::rename(repo.join("committed.txt"), repo.join("renamed.txt"))
            .expect("rename tracked file on disk");
        run_git(&repo, &["add", "-N", "renamed.txt"]);

        let result = status(&repo).expect("status should succeed");
        assert_eq!(
            result.files.len(),
            1,
            "unconsumed rename-source field produced a phantom entry: {:?}",
            result.files
        );
        assert_eq!(result.files[0].path, "renamed.txt");
        assert_eq!(result.files[0].kind, StatusKind::Renamed);

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

    // ── diff on unborn HEAD (bug #4) ─────────────────────────────────────

    #[test]
    fn diff_succeeds_on_unborn_head() {
        if !git_available() {
            return;
        }
        let repo = unique_temp_dir("diff-unborn-head");
        std::fs::create_dir_all(&repo).expect("create repo dir");
        run_git(&repo, &["init", "-q"]);
        run_git(&repo, &["config", "user.email", "test@example.com"]);
        run_git(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("new_file.txt"), "hello\n").expect("write file");
        run_git(&repo, &["add", "new_file.txt"]);

        let result = diff(&repo, "new_file.txt").expect("diff should succeed on unborn HEAD");
        assert_eq!(result.kind, DiffKind::Text);
        let content = result.content.expect("text diff has content");
        assert!(
            content.contains("+hello"),
            "diff should show the file as an addition: {content}"
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

    #[test]
    #[cfg(unix)]
    fn diff_does_not_execute_external_textconv_driver() {
        let Some(repo) = init_repo("diff-no-textconv") else {
            return;
        };
        let marker = repo.join("textconv_ran.marker");
        std::fs::write(repo.join(".gitattributes"), "committed.txt diff=marker\n")
            .expect("write .gitattributes");
        run_git(
            &repo,
            &[
                "config",
                "diff.marker.textconv",
                &format!("touch {}", marker.display()),
            ],
        );
        std::fs::write(repo.join("committed.txt"), "changed content\n").expect("modify file");

        diff(&repo, "committed.txt").expect("diff should succeed");

        assert!(
            !marker.exists(),
            "a repository-configured textconv driver must not execute"
        );

        std::fs::remove_dir_all(&repo).ok();
    }
}
