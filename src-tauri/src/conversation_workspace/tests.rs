use super::{inspect, runner, Registry, WorkspaceManager, WorkspaceOptions};
use crate::git_browser::fixture::{self, Repo};
use crate::test_support::TempDir;
use std::path::{Path, PathBuf};
use std::sync::{Barrier, Mutex};

fn path(repo: &Repo) -> String {
    crate::external_open::canonical_folder(repo.path()).unwrap()
}

fn populated(tag: &str) -> Option<Repo> {
    let repo = fixture::init(tag)?;
    repo.write("sub/file.txt", "base\n");
    repo.git(&["add", "."]);
    repo.commit("base", 1_700_000_000);
    Some(repo)
}

fn options(info: &super::WorkspaceInfo, name: &str, worktree: bool, ack: bool) -> WorkspaceOptions {
    let branch = info
        .branches
        .iter()
        .find(|branch| branch.name == name)
        .unwrap();
    WorkspaceOptions {
        // Options are submitted after the inspection result has been dropped.
        base_ref: Some(branch.ref_name.clone()),
        base_commit: Some(branch.commit.clone()),
        worktree,
        acknowledge_shared: ack,
    }
}

/// Records the destination while exercising the native checkout.
struct GitWorktree {
    dest: Mutex<Option<PathBuf>>,
    fail_after_checkout: bool,
}

impl GitWorktree {
    fn new(fail_after_checkout: bool) -> Self {
        Self {
            dest: Mutex::new(None),
            fail_after_checkout,
        }
    }
}

impl runner::Runner for GitWorktree {
    fn switch(&self, root: &Path, branch: &str) -> Result<(), String> {
        runner::Native::default().switch(root, branch)
    }

    fn worktree(&self, root: &Path, branch: &str, dest: &Path, commit: &str) -> Result<(), String> {
        // The assertion after the call needs the destination owned separately.
        *self.dest.lock().unwrap() = Some(dest.to_path_buf());
        runner::Native::default().worktree(root, branch, dest, commit)?;
        if self.fail_after_checkout {
            Err("post-checkout hook failed".to_string())
        } else {
            Ok(())
        }
    }
}

#[test]
fn non_git_and_unborn_folders_have_explicit_empty_base() {
    let dir = TempDir::new("conversation-workspace", "non-git");
    let folder = crate::external_open::canonical_folder(dir.path()).unwrap();
    let info = super::inspect(&folder).unwrap();
    assert!(info.repo_root.is_none());
    assert!(info.head.is_none());
    assert!(info.branches.is_empty());
    assert!(super::inspect("relative/folder").is_err());
    let Some(repo) = fixture::init("conversation-unborn") else {
        return;
    };
    let info = super::inspect(&path(&repo)).unwrap();
    assert_eq!(info.current_branch.as_deref(), Some("main"));
    assert!(info.head.is_none());
    repo.write("untracked.txt", "local");
    let mut registry = Registry::default();
    let selection = || WorkspaceOptions {
        base_ref: None,
        base_commit: None,
        worktree: false,
        acknowledge_shared: false,
    };
    assert!(registry
        .prepare("one", &path(&repo), Some(selection()), None)
        .is_err());
    let mut approved = selection();
    approved.acknowledge_shared = true;
    assert!(registry
        .prepare("one", &path(&repo), Some(approved), None)
        .is_ok());
    let mut worktree = selection();
    worktree.worktree = true;
    assert!(registry
        .prepare("two", &path(&repo), Some(worktree), Some(dir.path()))
        .is_err());
}

#[test]
fn ownership_covers_subfolders_restore_respawns_and_only_releases_on_close() {
    let Some(repo) = populated("conversation-owners") else {
        return;
    };
    let root = path(&repo);
    let sub = crate::external_open::canonical_folder(&repo.path().join("sub")).unwrap();
    let mut registry = Registry::default();
    let original = registry.prepare("restored", &sub, None, None).unwrap();
    assert!(original.workspace.is_none());
    assert_eq!(registry.status(&root).unwrap().owners, 1);
    let info = super::inspect(&root).unwrap();
    assert!(registry
        .prepare(
            "new",
            &root,
            Some(options(&info, "main", false, false)),
            None
        )
        .is_err());
    let prepared = registry
        .prepare(
            "new",
            &root,
            Some(options(&info, "main", false, true)),
            None,
        )
        .unwrap();
    assert_eq!(prepared.path, root);
    assert_eq!(prepared.workspace.as_ref().unwrap().project_path, root);
    // Stopping the process does not remove a tab; a no-options respawn keeps
    // its original binding and an attempt to change the cwd is rejected.
    let respawn = registry.prepare("new", &root, None, None).unwrap();
    assert_eq!(respawn.workspace, prepared.workspace);
    assert!(registry.prepare("new", &sub, None, None).is_err());
    assert_eq!(registry.status(&root).unwrap().owners, 2);
    let mut ids = vec!["restored".to_string()];
    registry.include_registered_ids(&mut ids);
    assert_eq!(ids.len(), 2);
    assert!(ids.iter().any(|id| id == "new"));
    registry.release(&["restored", "new"]);
    assert_eq!(registry.status(&root).unwrap().owners, 0);
}

#[test]
fn repository_created_around_a_running_subfolder_remains_owned() {
    let Some(repo) = populated("conversation-new-repository-owner") else {
        return;
    };
    repo.git(&["branch", "other"]);
    let hidden = TempDir::new("conversation-workspace", "hidden-git");
    let git = repo.path().join(".git");
    let stored = hidden.path().join("git");
    std::fs::rename(&git, &stored).unwrap();
    let root = path(&repo);
    let sub = crate::external_open::canonical_folder(&repo.path().join("sub")).unwrap();
    let mut registry = Registry::default();
    registry.prepare("owner", &sub, None, None).unwrap();
    std::fs::rename(&stored, &git).unwrap();
    let info = super::inspect(&root).unwrap();
    let result = registry.prepare(
        "switch",
        &root,
        Some(options(&info, "other", false, false)),
        None,
    );
    assert!(
        result.is_err(),
        "a running child folder still owns its checkout"
    );
    assert_eq!(repo.git(&["branch", "--show-current"]).trim(), "main");
    assert_eq!(registry.status(&root).unwrap().owners, 1);
}

#[test]
fn default_cwd_tab_owns_the_inherited_working_directory() {
    let cwd = std::env::current_dir().unwrap();
    let cwd = crate::external_open::canonical_folder(&cwd).unwrap();
    let mut registry = Registry::default();
    let prepared = registry.prepare("default", "", None, None).unwrap();
    assert_eq!(prepared.path, "");
    assert_eq!(registry.status(&cwd).unwrap().owners, 1);
    registry.release(&["default"]);
    assert_eq!(registry.status(&cwd).unwrap().owners, 0);
}

#[test]
fn dirty_and_owned_checkouts_never_switch_and_stale_refs_are_rejected() {
    let Some(repo) = populated("conversation-switch") else {
        return;
    };
    repo.git(&["branch", "other"]);
    let root = path(&repo);
    let mut registry = Registry::default();
    let info = super::inspect(&root).unwrap();
    repo.write("sub/file.txt", "local edit\n");
    let denied = registry.prepare(
        "dirty",
        &root,
        Some(options(&info, "other", false, false)),
        None,
    );
    assert!(denied.is_err());
    assert_eq!(repo.git(&["branch", "--show-current"]).trim(), "main");
    assert_eq!(
        std::fs::read_to_string(repo.path().join("sub/file.txt")).unwrap(),
        "local edit\n"
    );
    repo.git(&["checkout", "--", "sub/file.txt"]);
    registry.prepare("owner", &root, None, None).unwrap();
    assert!(registry
        .prepare(
            "switch",
            &root,
            Some(options(&info, "other", false, false)),
            None
        )
        .is_err());
    registry.release(&["owner"]);
    repo.git(&["switch", "-q", "other"]);
    repo.write("sub/file.txt", "new branch\n");
    repo.git(&["add", "."]);
    repo.commit("move branch", 1_700_000_100);
    repo.git(&["switch", "-q", "main"]);
    assert!(registry
        .prepare(
            "stale",
            &root,
            Some(options(&info, "other", false, false)),
            None
        )
        .is_err());
    assert_eq!(repo.git(&["branch", "--show-current"]).trim(), "main");
    let fresh = super::inspect(&root).unwrap();
    registry
        .prepare(
            "switch",
            &root,
            Some(options(&fresh, "other", false, false)),
            None,
        )
        .unwrap();
    assert_eq!(repo.git(&["branch", "--show-current"]).trim(), "other");
}

#[test]
fn branch_checked_out_in_another_worktree_cannot_be_switched_here() {
    let Some(repo) = populated("conversation-other-worktree") else {
        return;
    };
    let data = TempDir::new("conversation-workspace", "other-worktree");
    repo.git(&["branch", "other"]);
    let other = data.path().join("checkout");
    repo.git(&["worktree", "add", "-q", other.to_str().unwrap(), "other"]);
    let root = path(&repo);
    let mut registry = Registry::default();
    let info = super::inspect(&root).unwrap();
    assert!(registry
        .prepare(
            "switch",
            &root,
            Some(options(&info, "other", false, false)),
            None
        )
        .is_err());
    assert_eq!(repo.git(&["branch", "--show-current"]).trim(), "main");
}

#[test]
fn concurrent_new_tabs_cannot_both_claim_an_unacknowledged_workspace() {
    let Some(repo) = populated("conversation-race") else {
        return;
    };
    let root = path(&repo);
    let manager = WorkspaceManager::default();
    let barrier = Barrier::new(2);
    let successes = std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for id in ["one", "two"] {
            let manager = &manager;
            let barrier = &barrier;
            let root = &root;
            handles.push(scope.spawn(move || {
                barrier.wait();
                let mut registry = manager.lock();
                let info = super::inspect(root).unwrap();
                registry
                    .prepare(id, root, Some(options(&info, "main", false, false)), None)
                    .is_ok()
            }));
        }
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(|success| *success)
            .count()
    });
    assert_eq!(successes, 1);
    assert_eq!(super::status(&manager, &root).unwrap().owners, 1);
}

#[test]
fn closing_a_tab_cancels_its_already_queued_start() {
    let manager = WorkspaceManager::default();
    let start = manager.ticket("pending").unwrap();
    let shell = manager.ticket("pending").unwrap();
    let unrelated = manager.ticket("other").unwrap();
    manager.cancel_pending(&["pending"]);
    manager.lock().release(&["pending"]);
    assert!(manager.check_ticket(&start).is_err());
    assert!(manager.check_ticket(&shell).is_err());
    assert!(manager.check_ticket(&unrelated).is_ok());
}

#[test]
fn reload_invalidates_queued_starts_and_shutdown_closes_admission() {
    let manager = WorkspaceManager::default();
    let before_reload = manager.ticket("before").unwrap();
    manager.invalidate_pending();
    assert!(manager.check_ticket(&before_reload).is_err());
    let after_reload = manager.ticket("after").unwrap();
    assert!(manager.check_ticket(&after_reload).is_ok());
    manager.shutdown();
    assert!(manager.check_ticket(&after_reload).is_err());
    assert!(manager.ticket("shutdown").is_err());
}

struct PausingWorktree<'a> {
    entered: &'a Barrier,
    resume: &'a Barrier,
    real: GitWorktree,
}

impl runner::Runner for PausingWorktree<'_> {
    fn switch(&self, root: &Path, branch: &str) -> Result<(), String> {
        self.real.switch(root, branch)
    }

    fn worktree(&self, root: &Path, branch: &str, dest: &Path, commit: &str) -> Result<(), String> {
        self.entered.wait();
        self.resume.wait();
        self.real.worktree(root, branch, dest, commit)
    }
}

#[test]
fn reload_waits_for_inflight_preparation_before_snapshot_and_release() {
    let Some(repo) = populated("conversation-reload") else {
        return;
    };
    let data = TempDir::new("conversation-workspace", "reload-data");
    let root = path(&repo);
    let manager = WorkspaceManager::default();
    let entered = Barrier::new(2);
    let resume = Barrier::new(2);
    let cleanup_started = Barrier::new(2);
    let runner = PausingWorktree {
        entered: &entered,
        resume: &resume,
        real: GitWorktree::new(false),
    };
    let info = super::inspect(&root).unwrap();
    let selection = options(&info, "main", true, false);
    std::thread::scope(|scope| {
        let start = scope.spawn(|| {
            let mut registry = manager.lock();
            registry
                .prepare_with(
                    "pending",
                    &root,
                    Some(selection),
                    Some(data.path()),
                    &runner,
                )
                .unwrap()
        });
        entered.wait();
        manager.invalidate_pending();
        let cleanup = scope.spawn(|| {
            cleanup_started.wait();
            let mut registry = manager.lock();
            let present = registry.tabs.contains_key("pending");
            registry.release(&["pending"]);
            present
        });
        cleanup_started.wait();
        assert!(manager.registry.try_lock().is_err());
        resume.wait();
        let prepared = start.join().unwrap();
        assert!(Path::new(&prepared.path).is_dir());
        assert!(cleanup.join().unwrap());
    });
    assert!(manager.lock().tabs.is_empty());
}

#[test]
fn isolated_checkout_uses_selected_commit_preserves_source_and_maps_subfolder() {
    let Some(repo) = populated("conversation-isolated") else {
        return;
    };
    let data = TempDir::new("conversation-workspace", "isolated-data");
    repo.write(
        ".gitignore",
        "/target/\n/node_modules/\n/.claude/worktrees/\n",
    );
    repo.git(&["add", ".gitignore"]);
    repo.commit("ignore local artifacts", 1_700_000_050);
    repo.git(&["switch", "-q", "-c", "other"]);
    repo.write("sub/file.txt", "other base\n");
    repo.git(&["add", "."]);
    let other_commit = repo.commit("other", 1_700_000_100);
    repo.git(&["switch", "-q", "main"]);
    repo.write("sub/file.txt", "staged\n");
    repo.git(&["add", "."]);
    repo.write("sub/file.txt", "unstaged\n");
    repo.write("untracked.txt", "untouched\n");
    repo.write("target/debug/build.bin", "build output\n");
    repo.write("node_modules/package/index.js", "installed package\n");
    repo.write(".claude/worktrees/nested/local.txt", "nested work\n");
    let before = repo.git(&["status", "--porcelain=v1"]);
    let sub = crate::external_open::canonical_folder(&repo.path().join("sub")).unwrap();
    let mut registry = Registry::default();
    let info = super::inspect(&sub).unwrap();
    let runner = GitWorktree::new(false);
    let prepared = registry
        .prepare_with(
            "isolated",
            &sub,
            Some(options(&info, "other", true, false)),
            Some(data.path()),
            &runner,
        )
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(Path::new(&prepared.path).join("file.txt")).unwrap(),
        "other base\n"
    );
    assert_eq!(prepared.workspace.unwrap().project_path, sub);
    let created = runner.dest.lock().unwrap().take().unwrap();
    let created_canonical = crate::external_open::canonical_folder(&created).unwrap();
    assert!(Path::new(&prepared.path).starts_with(created_canonical));
    for local in ["target", "node_modules", ".claude/worktrees"] {
        assert!(!created.join(local).exists(), "{local} was copied");
    }
    for (local, contents) in [
        ("target/debug/build.bin", "build output\n"),
        ("node_modules/package/index.js", "installed package\n"),
        (".claude/worktrees/nested/local.txt", "nested work\n"),
    ] {
        assert_eq!(
            std::fs::read_to_string(repo.path().join(local)).unwrap(),
            contents
        );
    }
    assert_eq!(
        inspect::read(prepared.path).unwrap().head.as_deref(),
        Some(other_commit.as_str())
    );
    assert_eq!(repo.git(&["status", "--porcelain=v1"]), before);
    assert_eq!(
        std::fs::read_to_string(repo.path().join("sub/file.txt")).unwrap(),
        "unstaged\n"
    );
    assert_eq!(
        std::fs::read_to_string(repo.path().join("untracked.txt")).unwrap(),
        "untouched\n"
    );
    registry.release(&["isolated"]);
    assert!(
        created.exists(),
        "closing a tab must retain its successful worktree"
    );
}

#[test]
fn native_failure_retains_created_artifacts_and_names_them() {
    let Some(repo) = populated("conversation-worktree-failure") else {
        return;
    };
    let data = TempDir::new("conversation-workspace", "failure-data");
    let root = path(&repo);
    let mut registry = Registry::default();
    let info = super::inspect(&root).unwrap();
    let runner = GitWorktree::new(true);
    let Err(error) = registry.prepare_with(
        "failure",
        &root,
        Some(options(&info, "main", true, false)),
        Some(data.path()),
        &runner,
    ) else {
        panic!("expected hook failure");
    };
    let destination = runner.dest.lock().unwrap().take().unwrap();
    assert!(destination.exists());
    assert!(error.contains("post-checkout hook failed"));
    assert!(error.contains(&destination.display().to_string()));
    assert!(error.contains("branch omp/conversation-"));
    assert_eq!(registry.status(&root).unwrap().owners, 0);
}

#[test]
fn refuses_invalid_ref_and_remote_in_place_and_supports_detached_head() {
    let Some(repo) = populated("conversation-refs") else {
        return;
    };
    let root = path(&repo);
    let head = repo.git(&["rev-parse", "HEAD"]).trim().to_string();
    repo.git(&["update-ref", "refs/remotes/origin/other", &head]);
    let mut registry = Registry::default();
    let info = super::inspect(&root).unwrap();
    assert!(registry
        .prepare(
            "remote",
            &root,
            Some(options(&info, "origin/other", false, false)),
            None
        )
        .is_err());
    let invalid = WorkspaceOptions {
        base_ref: Some("--help".into()),
        base_commit: Some(head),
        worktree: false,
        acknowledge_shared: true,
    };
    assert!(registry.prepare("bad", &root, Some(invalid), None).is_err());
    repo.git(&["switch", "-q", "--detach"]);
    let detached = super::inspect(&root).unwrap();
    assert!(detached.current_branch.is_none());
    let selection = WorkspaceOptions {
        base_ref: Some("HEAD".into()),
        base_commit: detached.head,
        worktree: false,
        acknowledge_shared: false,
    };
    assert!(registry
        .prepare("detached", &root, Some(selection), None)
        .is_ok());
}

#[test]
fn inspection_never_runs_repository_clean_filters() {
    let Some(repo) = populated("conversation-filter") else {
        return;
    };
    let marker = repo.arm_clean_filter(".git");
    repo.write("sub/file.txt", "edit\n");
    let status = Registry::default().status(&path(&repo)).unwrap();
    assert!(status.dirty);
    assert!(!marker.exists());
}

#[test]
fn ignored_file_is_not_overwritten_by_switch() {
    let Some(repo) = populated("conversation-ignored") else {
        return;
    };
    repo.write(".gitignore", "protected.txt\n");
    repo.git(&["add", ".gitignore"]);
    repo.commit("ignore", 1_700_000_100);
    repo.git(&["switch", "-q", "-c", "other"]);
    repo.write("protected.txt", "tracked on other\n");
    repo.git(&["add", "-f", "protected.txt"]);
    repo.commit("tracked file", 1_700_000_200);
    repo.git(&["switch", "-q", "main"]);
    repo.write("protected.txt", "local ignored file\n");
    let root = path(&repo);
    let mut registry = Registry::default();
    let info = super::inspect(&root).unwrap();
    assert!(!registry.status(&root).unwrap().dirty);
    assert!(registry
        .prepare(
            "switch",
            &root,
            Some(options(&info, "other", false, false)),
            None
        )
        .is_err());
    assert_eq!(repo.git(&["branch", "--show-current"]).trim(), "main");
    assert_eq!(
        std::fs::read_to_string(repo.path().join("protected.txt")).unwrap(),
        "local ignored file\n"
    );
}

#[test]
fn dirty_submodule_blocks_switch_without_running_its_filter() {
    let (Some(outer), Some(inner)) = (
        populated("conversation-outer"),
        populated("conversation-inner"),
    ) else {
        return;
    };
    let url = inner.path().to_str().unwrap();
    outer.git(&[
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        url,
        "nested",
    ]);
    outer.git(&["add", "."]);
    outer.commit("add submodule", 1_700_000_100);
    outer.git(&["branch", "other"]);
    let marker = outer.arm_clean_filter(".git/modules/nested");
    outer.write("nested/sub/file.txt", "edited submodule\n");
    let root = path(&outer);
    let mut registry = Registry::default();
    let info = super::inspect(&root).unwrap();
    assert!(registry.status(&root).unwrap().dirty);
    assert!(!marker.exists());
    assert!(registry
        .prepare(
            "switch",
            &root,
            Some(options(&info, "other", false, false)),
            None
        )
        .is_err());
    assert!(!marker.exists());
}

#[test]
fn unavailable_or_source_nested_data_folder_never_creates_worktrees() {
    let Some(repo) = populated("conversation-data") else {
        return;
    };
    let root = path(&repo);
    let mut registry = Registry::default();
    let info = super::inspect(&root).unwrap();
    let runner = GitWorktree::new(false);
    assert!(registry
        .prepare_with(
            "missing",
            &root,
            Some(options(&info, "main", true, false)),
            None,
            &runner
        )
        .is_err());
    let nested = repo.path().join("data");
    assert!(registry
        .prepare_with(
            "nested",
            &root,
            Some(options(&info, "main", true, false)),
            Some(&nested),
            &runner
        )
        .is_err());
    assert!(!nested.exists());
    assert!(runner.dest.lock().unwrap().is_none());
}

#[test]
fn missing_mapped_subfolder_is_an_error_and_retains_the_worktree() {
    let Some(repo) = populated("conversation-missing-subfolder") else {
        return;
    };
    let data = TempDir::new("conversation-workspace", "missing-subfolder-data");
    repo.git(&["switch", "-q", "-c", "without-sub"]);
    repo.git(&["rm", "-rq", "sub"]);
    repo.commit("remove folder", 1_700_000_100);
    repo.git(&["switch", "-q", "main"]);
    let sub = crate::external_open::canonical_folder(&repo.path().join("sub")).unwrap();
    let mut registry = Registry::default();
    let info = super::inspect(&sub).unwrap();
    let runner = GitWorktree::new(false);
    let Err(error) = registry.prepare_with(
        "missing-sub",
        &sub,
        Some(options(&info, "without-sub", true, false)),
        Some(data.path()),
        &runner,
    ) else {
        panic!("missing folder must not fall back to another cwd");
    };
    let destination = runner.dest.lock().unwrap().take().unwrap();
    assert!(destination.exists());
    assert!(error.contains(&destination.display().to_string()));
    assert_eq!(registry.status(&sub).unwrap().owners, 0);
}

#[test]
fn metadata_ignores_checkout_index_and_lifecycle_guard() {
    let Some(repo) = populated("preview-index") else {
        return;
    };
    let marker = repo.arm_clean_filter(".git");
    let root = path(&repo);
    std::fs::write(repo.path().join(".git/index"), [0u8; 64]).unwrap();
    let manager = WorkspaceManager::default();
    let _guard = manager.lock();
    let preview = super::inspect(&root).unwrap();
    assert_eq!(preview.path, root);
    assert_eq!(preview.current_branch.as_deref(), Some("main"));
    assert!(preview.head.is_some());
    assert!(!marker.exists());
    assert!(inspect::dirty(&root).is_err());
}

#[test]
fn status_detects_each_layer_even_when_git_hides_untracked_files() {
    let Some(repo) = populated("status-layers") else {
        return;
    };
    let root = path(&repo);
    assert!(!inspect::dirty(&root).unwrap());
    repo.write("sub/file.txt", "unstaged change\n");
    assert!(inspect::dirty(&root).unwrap());
    repo.git(&["add", "sub/file.txt"]);
    assert!(inspect::dirty(&root).unwrap());
    repo.git(&["reset", "--hard", "-q", "HEAD"]);
    repo.git(&["config", "status.showUntrackedFiles", "no"]);
    repo.write("new-dir/new.txt", "untracked\n");
    assert!(inspect::dirty(&root).unwrap());
    std::fs::remove_dir_all(repo.path().join("new-dir")).unwrap();
    assert!(!inspect::dirty(&root).unwrap());
}

struct RejectingWorktree;

impl runner::Runner for RejectingWorktree {
    fn switch(&self, _: &Path, _: &str) -> Result<(), String> {
        panic!("isolation must not switch the source")
    }

    fn worktree(&self, _: &Path, _: &str, _: &Path, _: &str) -> Result<(), String> {
        Err("worktree runner reached".into())
    }
}

#[test]
fn isolated_start_does_not_consult_source_index_but_in_place_does() {
    let Some(repo) = populated("isolation-no-scan") else {
        return;
    };
    let data = TempDir::new("conversation-workspace", "isolation-no-scan");
    let root = path(&repo);
    let info = super::inspect(&root).unwrap();
    std::fs::write(repo.path().join(".git/index"), [0u8; 64]).unwrap();
    let mut registry = Registry::default();
    let error = registry
        .prepare_with(
            "isolated",
            &root,
            Some(options(&info, "main", true, false)),
            Some(data.path()),
            &RejectingWorktree,
        )
        .err()
        .unwrap();
    assert!(error.contains("worktree runner reached"));
    assert!(registry
        .prepare_with(
            "in-place",
            &root,
            Some(options(&info, "main", false, true)),
            Some(data.path()),
            &RejectingWorktree,
        )
        .is_err());
}

#[test]
fn linked_worktree_subfolder_resolves_primary_project_without_changing_cwd() {
    let Some(repo) = populated("source-lineage") else {
        return;
    };
    let data = TempDir::new("conversation-workspace", "source-lineage");
    let checkout = data.path().join("checkout");
    repo.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "linked",
        checkout.to_str().unwrap(),
        "main",
    ]);
    let source = crate::external_open::canonical_folder(&repo.path().join("sub")).unwrap();
    let selected = crate::external_open::canonical_folder(&checkout.join("sub")).unwrap();
    let preview = super::inspect(&selected).unwrap();
    assert_eq!(preview.path, selected);
    assert_eq!(preview.project_path, source);
    let mut registry = Registry::default();
    let prepared = registry
        .prepare(
            "linked",
            &selected,
            Some(options(&preview, "linked", false, false)),
            None,
        )
        .unwrap();
    assert_eq!(prepared.path, selected);
    assert_eq!(prepared.workspace.unwrap().project_path, source);
    std::fs::remove_dir_all(repo.path().join("sub")).unwrap();
    assert_eq!(super::inspect(&selected).unwrap().project_path, selected);
}

#[test]
fn submodule_untracked_and_gitlink_changes_are_dirty() {
    let (Some(outer), Some(inner)) = (
        populated("status-submodule-outer"),
        populated("status-submodule-inner"),
    ) else {
        return;
    };
    outer.git(&[
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        inner.path().to_str().unwrap(),
        "nested",
    ]);
    outer.git(&["add", "."]);
    outer.commit("add submodule", 1_700_000_100);
    let root = path(&outer);
    assert!(!inspect::dirty(&root).unwrap());
    outer.git(&["-C", "nested", "config", "status.showUntrackedFiles", "no"]);
    outer.write("nested/new.txt", "untracked\n");
    assert!(inspect::dirty(&root).unwrap());
    std::fs::remove_file(outer.path().join("nested/new.txt")).unwrap();
    outer.git(&["-C", "nested", "config", "user.email", "test@example.com"]);
    outer.git(&["-C", "nested", "config", "user.name", "Test"]);
    outer.git(&[
        "-C",
        "nested",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "advance",
    ]);
    assert!(inspect::dirty(&root).unwrap());
}

#[test]
fn non_git_sharing_requires_acknowledgement() {
    let dir = TempDir::new("conversation-workspace", "non-git-owners");
    let root = crate::external_open::canonical_folder(dir.path()).unwrap();
    let mut registry = Registry::default();
    registry.prepare("owner", &root, None, None).unwrap();
    let selection = |acknowledge_shared| WorkspaceOptions {
        base_ref: None,
        base_commit: None,
        worktree: false,
        acknowledge_shared,
    };
    assert!(registry
        .prepare("no-ack", &root, Some(selection(false)), None)
        .is_err());
    assert!(registry
        .prepare("ack", &root, Some(selection(true)), None)
        .is_ok());
}
