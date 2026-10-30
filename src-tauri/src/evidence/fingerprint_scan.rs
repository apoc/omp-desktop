//! Bounded, raw-byte comparison of HEAD and the worktree. No status/filter pipeline.
use gix::bstr::ByteSlice as _;
use gix::object::tree::EntryKind;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::atomic::AtomicBool;

const MAX_FILES: usize = 20_000;
const MAX_PATH: usize = 4096;
pub(super) const MAX_FILE: u64 = 8 * 1024 * 1024;
const MAX_TOTAL: u64 = 128 * 1024 * 1024;
const MAX_TREE: u64 = 8 * 1024 * 1024;
const MAX_TREES: usize = 20_000;

struct Scan {
    head: String,
    dirty: Option<String>,
    binary: usize,
    index: String,
}

pub(super) fn fingerprint(cwd: Option<&str>) -> Value {
    let environment = |binary: usize| {
        json!({
            "platform": std::env::consts::OS, "architecture": std::env::consts::ARCH,
            "algorithm": "sha256", "binaryFiles": binary,
            "comparison": if cfg!(windows) {
                "Raw worktree bytes against HEAD; executable modes are not inspected on Windows; no Git filters are applied"
            } else {
                "Raw worktree bytes and executable modes against HEAD; no Git filters are applied"
            },
            "limitations": "Ignored files, submodule contents, and external Git ignore configuration are not inspected. Sparse checkouts are compared as present on disk. Concurrent-change detection is best effort."
        })
    };
    let Some(cwd) = cwd.filter(|path| !path.is_empty()) else {
        return json!({"head": null, "dirtyDigest": null, "complete": false,
            "reason": "No project folder is available", "environment": environment(0)});
    };
    let first = match scan(Path::new(cwd)) {
        Ok(result) => result,
        Err((head, reason)) => {
            return json!({"head": head, "dirtyDigest": null,
            "complete": false, "reason": error_text(&reason), "environment": environment(0)})
        }
    };
    match scan(Path::new(cwd)) {
        Ok(second) if consistent(&first, &second) => {
            json!({"head": first.head, "dirtyDigest": first.dirty, "complete": true,
                "reason": null, "environment": environment(first.binary)})
        }
        Ok(_) => json!({"head": first.head, "dirtyDigest": null, "complete": false,
            "reason": "HEAD, index or working tree changed during fingerprint collection", "environment": environment(first.binary)}),
        Err((_, reason)) => json!({"head": first.head, "dirtyDigest": null, "complete": false,
            "reason": format!("Could not recheck working tree: {}", error_text(&reason)), "environment": environment(first.binary)}),
    }
}

fn error_text(reason: &str) -> String {
    if reason.len() <= 1024 {
        reason.to_owned()
    } else {
        format!("{} [truncated]", super::bounded(reason, 1000))
    }
}

fn consistent(first: &Scan, second: &Scan) -> bool {
    first.head == second.head
        && first.dirty == second.dirty
        && first.binary == second.binary
        && first.index == second.index
}

fn scan(path: &Path) -> Result<Scan, (Option<String>, String)> {
    let repo = match gix::discover_opts(
        path,
        gix::discover::upwards::Options::default(),
        gix::open::Options::isolated(),
    ) {
        Ok(repo) => repo,
        Err(gix::discover::Error::Discover(
            gix::discover::upwards::Error::NoGitRepository { .. }
            | gix::discover::upwards::Error::NoGitRepositoryWithinFs { .. }
            | gix::discover::upwards::Error::NoGitRepositoryWithinCeiling { .. },
        )) => return Err((None, "Not a Git repository".into())),
        Err(error) => return Err((None, format!("Cannot open Git repository: {error}"))),
    };
    let head = repo
        .head_id()
        .map_err(|error| (None, format!("Cannot read HEAD (possibly unborn): {error}")))?
        .detach();
    let head_string = head.to_string();
    match scan_repo(&repo, head) {
        Ok((dirty, binary, index)) => Ok(Scan {
            head: head_string,
            dirty,
            binary,
            index,
        }),
        Err(error) => Err((Some(head_string), error)),
    }
}

fn validate_path(path: &str) -> Result<(), String> {
    if path.len() > MAX_PATH
        || path.is_empty()
        || path.split('/').any(|part| {
            part.is_empty()
                || part == "."
                || part == ".."
                || part.eq_ignore_ascii_case(".git")
                || part.contains('\0')
                || (cfg!(windows) && (part.contains('\\') || part.contains(':')))
        })
    {
        return Err("Invalid or oversized Git path".into());
    }
    Ok(())
}

fn collect_tree(
    repo: &gix::Repository,
    id: gix::ObjectId,
    prefix: &str,
    files: &mut BTreeMap<String, (gix::ObjectId, EntryKind)>,
    trees: &mut usize,
    tree_bytes: &mut u64,
    depth: usize,
) -> Result<(), String> {
    if depth > 128 {
        return Err("HEAD tree nesting exceeds fingerprint limit".into());
    }
    *trees += 1;
    if *trees > MAX_TREES {
        return Err("HEAD tree count exceeds fingerprint limit".into());
    }
    let header = repo
        .find_header(id)
        .map_err(|e| format!("Cannot read HEAD tree: {e}"))?;
    if header.size() > MAX_TREE {
        return Err("HEAD tree exceeds fingerprint size limit".into());
    }
    *tree_bytes = tree_bytes.saturating_add(header.size());
    if *tree_bytes > MAX_TOTAL {
        return Err("HEAD trees exceed fingerprint byte limit".into());
    }
    let tree = repo
        .find_tree(id)
        .map_err(|e| format!("Cannot read HEAD tree: {e}"))?;
    for entry in tree.iter() {
        let entry = entry.map_err(|e| format!("Cannot decode HEAD tree: {e}"))?;
        let name = entry
            .filename()
            .to_str()
            .map_err(|_| "Non-UTF-8 Git paths cannot be fingerprinted".to_string())?;
        if name.contains('/') {
            return Err("Invalid HEAD tree path".into());
        }
        let path = if prefix.is_empty() {
            name.to_owned()
        } else {
            format!("{prefix}/{name}")
        };
        validate_path(&path)?;
        match entry.kind() {
            EntryKind::Tree => collect_tree(
                repo,
                entry.object_id(),
                &path,
                files,
                trees,
                tree_bytes,
                depth + 1,
            )?,
            EntryKind::Commit => {
                return Err("Submodule content is not traversed; fingerprint is incomplete".into())
            }
            EntryKind::Link => {
                return Err(
                    "Tracked symbolic links are not followed; fingerprint is incomplete".into(),
                )
            }
            kind => {
                if files.len() == MAX_FILES {
                    return Err("HEAD file count exceeds fingerprint limit".into());
                }
                if files.insert(path, (entry.object_id(), kind)).is_some() {
                    return Err("Duplicate path in HEAD tree".into());
                }
            }
        }
    }
    Ok(())
}

struct Walk<'a> {
    paths: BTreeSet<String>,
    error: Option<String>,
    directories: usize,
    seen: usize,
    root: &'a Path,
    ignore_bytes: u64,
}

impl gix::dir::walk::Delegate for Walk<'_> {
    fn emit(
        &mut self,
        entry: gix::dir::EntryRef<'_>,
        _: Option<gix::dir::entry::Status>,
    ) -> gix::dir::walk::Action {
        use gix::dir::entry::{Kind, Status};
        if self.error.is_some() {
            return std::ops::ControlFlow::Break(());
        }
        self.seen += 1;
        if self.seen > MAX_FILES {
            self.error = Some("Working-tree entry count exceeds fingerprint limit".into());
            return std::ops::ControlFlow::Break(());
        }
        if !matches!(entry.status, Status::Untracked | Status::Tracked)
            || entry.disk_kind == Some(Kind::Directory)
        {
            return std::ops::ControlFlow::Continue(());
        }
        if entry.disk_kind == Some(Kind::Repository) {
            self.error =
                Some("Nested repositories are not traversed; fingerprint is incomplete".into());
            return std::ops::ControlFlow::Break(());
        }
        let Ok(path) = entry.rela_path.to_str() else {
            self.error = Some("Non-UTF-8 working-tree paths cannot be fingerprinted".into());
            return std::ops::ControlFlow::Break(());
        };
        if let Err(error) = validate_path(path) {
            self.error = Some(error);
            return std::ops::ControlFlow::Break(());
        }
        if self.paths.len() == MAX_FILES && !self.paths.contains(path) {
            self.error = Some("Working-tree file count exceeds fingerprint limit".into());
            return std::ops::ControlFlow::Break(());
        }
        self.paths.insert(path.to_owned());
        std::ops::ControlFlow::Continue(())
    }

    fn can_recurse(
        &mut self,
        entry: gix::dir::EntryRef<'_>,
        mode: Option<gix::dir::walk::ForDeletionMode>,
        root: bool,
    ) -> bool {
        if too_deep(&entry.rela_path) {
            self.error = Some("Working-tree nesting exceeds fingerprint limit".into());
            return false;
        }
        self.directories += 1;
        if self.directories > MAX_TREES {
            self.error = Some("Working-tree directory count exceeds fingerprint limit".into());
            return false;
        }
        if !entry
            .status
            .can_recurse(entry.disk_kind, entry.pathspec_match, mode, root)
        {
            return false;
        }
        if !entry.rela_path.is_empty() {
            let Ok(path) = entry.rela_path.to_str() else {
                self.error = Some("Non-UTF-8 working-tree directory".into());
                return false;
            };
            if let Err(error) = validate_path(path).and_then(|()| {
                check_ignore(
                    self.root,
                    &format!("{path}/.gitignore"),
                    &mut self.ignore_bytes,
                )
            }) {
                self.error = Some(error);
                return false;
            }
        }
        true
    }
}

fn too_deep(path: &[u8]) -> bool {
    path.split(|&byte| byte == b'/').nth(128).is_some()
}

fn check_ignore(root: &Path, path: &str, total: &mut u64) -> Result<(), String> {
    if let Some((bytes, _)) = super::safe::read(root, path)? {
        *total = total.saturating_add(bytes.len() as u64);
        if *total > MAX_TOTAL {
            return Err("Ignore files exceed fingerprint byte limit".into());
        }
    }
    Ok(())
}
fn scan_repo(
    repo: &gix::Repository,
    head: gix::ObjectId,
) -> Result<(Option<String>, usize, String), String> {
    let root = repo
        .workdir()
        .ok_or_else(|| "Bare repositories have no working tree".to_string())?;
    // gix otherwise follows a repository-configured arbitrary excludesFile.
    if repo.config_snapshot().string("core.excludesFile").is_some() {
        return Err("Repository-configured external Git exclude files are not read".into());
    }
    let mut ignore_bytes = 0;
    check_ignore(root, ".gitignore", &mut ignore_bytes)?;
    check_ignore(repo.common_dir(), "info/exclude", &mut ignore_bytes)?;
    let header = repo
        .find_header(head)
        .map_err(|e| format!("Cannot read HEAD commit: {e}"))?;
    if header.size() > MAX_TREE {
        return Err("HEAD commit exceeds fingerprint size limit".into());
    }
    let commit = repo
        .find_commit(head)
        .map_err(|e| format!("Cannot read HEAD commit: {e}"))?;
    let tree_id = commit
        .tree_id()
        .map_err(|e| format!("Cannot read HEAD tree ID: {e}"))?
        .detach();
    let mut tracked = BTreeMap::new();
    collect_tree(repo, tree_id, "", &mut tracked, &mut 0, &mut 0, 0)?;
    let (paths, index_digest) = collect_worktree(repo, root, &tracked, ignore_bytes)?;
    let (dirty, binary) = compare_worktree(repo, root, &tracked, &paths)?;
    let current = repo
        .head_id()
        .map_err(|e| format!("Cannot recheck HEAD: {e}"))?
        .detach();
    if current != head {
        return Err("HEAD changed during fingerprint collection".into());
    }
    Ok((dirty, binary, index_digest))
}

fn collect_worktree(
    repo: &gix::Repository,
    root: &Path,
    tracked: &BTreeMap<String, (gix::ObjectId, EntryKind)>,
    ignore_bytes: u64,
) -> Result<(BTreeSet<String>, String), String> {
    if repo
        .index_path()
        .metadata()
        .is_ok_and(|m| m.len() > MAX_TOTAL)
    {
        return Err("Git index exceeds fingerprint size limit".into());
    }
    let index = repo
        .index_or_empty()
        .map_err(|e| format!("Cannot read Git index: {e}"))?;
    if index.entries().len() > MAX_FILES {
        return Err("Git index exceeds fingerprint file limit".into());
    }
    let mut walk = Walk {
        paths: BTreeSet::new(),
        error: None,
        directories: 0,
        seen: 0,
        root,
        ignore_bytes,
    };
    let mut index_digest = Sha256::new();
    for entry in index.entries() {
        if entry.stage_raw() != 0 {
            return Err("Git index has unresolved conflicts".into());
        }
        if entry.mode.is_submodule() {
            return Err("Submodule content is not traversed; fingerprint is incomplete".into());
        }
        let path = entry
            .path(&index)
            .to_str()
            .map_err(|_| "Non-UTF-8 index path".to_string())?;
        validate_path(path)?;
        // gix can fall back to the index blob when a worktree ignore file is
        // absent. Bound that object before the directory walk can inflate it.
        if path == ".gitignore" || path.ends_with("/.gitignore") {
            let header = repo
                .find_header(entry.id)
                .map_err(|e| format!("Cannot inspect indexed ignore file: {e}"))?;
            if header.size() > MAX_FILE {
                return Err("Indexed ignore file exceeds fingerprint size limit".into());
            }
            walk.ignore_bytes = walk.ignore_bytes.saturating_add(header.size());
            if walk.ignore_bytes > MAX_TOTAL {
                return Err("Ignore files exceed fingerprint byte limit".into());
            }
        }
        frame(&mut index_digest, path.as_bytes());
        frame(&mut index_digest, entry.id.as_slice());
        index_digest.update(entry.mode.bits().to_be_bytes());
        index_digest.update(entry.flags.bits().to_be_bytes());
        walk.paths.insert(path.to_owned());
    }
    let options = repo
        .dirwalk_options()
        .map_err(|e| format!("Cannot configure worktree walk: {e}"))?
        .emit_tracked(true)
        .emit_pruned(true)
        .emit_ignored(Some(gix::dir::walk::EmissionMode::Matching));
    repo.dirwalk(
        &index,
        std::iter::empty::<&str>(),
        &AtomicBool::new(false),
        options,
        &mut walk,
    )
    .map_err(|e| format!("Cannot walk working tree: {e}"))?;
    if let Some(error) = walk.error {
        return Err(error);
    }
    for path in tracked.keys() {
        walk.paths.insert(path.to_owned());
    }
    if walk.paths.len() > MAX_FILES {
        return Err("Working-tree file count exceeds fingerprint limit".into());
    }
    Ok((
        walk.paths,
        crate::json_store::hex_lower(&index_digest.finalize()),
    ))
}

fn compare_worktree(
    repo: &gix::Repository,
    root: &Path,
    tracked: &BTreeMap<String, (gix::ObjectId, EntryKind)>,
    paths: &BTreeSet<String>,
) -> Result<(Option<String>, usize), String> {
    let mut digest = Sha256::new();
    digest.update(b"omp-evidence-dirty-v1\0");
    let mut changed = false;
    let mut total = 0;
    let mut binary = 0;
    for path in paths {
        let actual = super::safe::read(root, path)?;
        let expected = tracked.get(path);
        match actual {
            None => {
                if expected.is_some() {
                    changed = true;
                    frame(&mut digest, path.as_bytes());
                    frame(&mut digest, b"deleted");
                }
            }
            Some((bytes, executable)) => {
                total += bytes.len() as u64;
                if total > MAX_TOTAL {
                    return Err("Working-tree bytes exceed fingerprint limit".into());
                }
                if bytes.contains(&0) {
                    binary += 1;
                }
                let oid =
                    gix::objs::compute_hash(repo.object_hash(), gix::object::Kind::Blob, &bytes)
                        .map_err(|e| format!("Cannot hash Git blob: {e}"))?;
                let is_changed = expected.is_none_or(|(id, kind)| {
                    *id != oid || (cfg!(unix) && (*kind == EntryKind::BlobExecutable) != executable)
                });
                if is_changed {
                    changed = true;
                    frame(&mut digest, path.as_bytes());
                    frame(
                        &mut digest,
                        if executable { b"executable" } else { b"file" },
                    );
                    frame(&mut digest, &bytes);
                }
            }
        }
    }
    Ok((
        changed.then(|| crate::json_store::hex_lower(&digest.finalize())),
        binary,
    ))
}

fn frame(digest: &mut Sha256, bytes: &[u8]) {
    digest.update((bytes.len() as u64).to_be_bytes());
    digest.update(bytes);
}

#[cfg(test)]
mod tests {
    use super::{consistent, too_deep, Scan};

    fn scan(head: &str, dirty: Option<&str>, binary: usize, index: &str) -> Scan {
        Scan {
            head: head.into(),
            dirty: dirty.map(str::to_owned),
            binary,
            index: index.into(),
        }
    }

    #[test]
    fn worktree_depth_limit_counts_separators() {
        assert!(!too_deep(b""));
        assert!(!too_deep("a/".repeat(127).as_bytes()));
        assert!(too_deep("a/".repeat(128).as_bytes()));
        assert!(too_deep("a/".repeat(129).as_bytes()));
    }

    #[test]
    fn concurrent_head_worktree_and_index_changes_are_not_accepted() {
        let before = scan("head-a", Some("dirty-a"), 1, "index-a");
        assert!(consistent(
            &before,
            &scan("head-a", Some("dirty-a"), 1, "index-a")
        ));
        assert!(!consistent(
            &before,
            &scan("head-b", Some("dirty-a"), 1, "index-a")
        ));
        assert!(!consistent(
            &before,
            &scan("head-a", Some("dirty-b"), 1, "index-a")
        ));
        assert!(!consistent(
            &before,
            &scan("head-a", Some("dirty-a"), 2, "index-a")
        ));
        assert!(!consistent(
            &before,
            &scan("head-a", Some("dirty-a"), 1, "index-b")
        ));
    }
}
