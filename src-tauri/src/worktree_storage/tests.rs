use super::{identity, snapshot, Policy, Store};
use crate::git_browser::fixture::{self, Repo};
use crate::test_support::TempDir;
use std::path::{Path, PathBuf};
use std::process::Command;

struct Fixture {
    repo: Repo,
    data: TempDir,
    root: PathBuf,
    source_subdir: PathBuf,
    branch: String,
}

fn run(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

impl Fixture {
    fn new(name: &str) -> Option<Self> {
        let repo = fixture::init(name)?;
        repo.write("sub/file.txt", "base\n");
        repo.write(
            ".gitignore",
            ".env\nnode_modules/\ntarget/\n.claude/worktrees/\n",
        );
        repo.git(&["add", "."]);
        repo.commit("initial", 1_700_000_000);
        let data = TempDir::new("worktree-storage", name);
        let worktrees = data.path().join("conversation-worktrees");
        std::fs::create_dir(&worktrees).unwrap();
        let worktrees = PathBuf::from(crate::external_open::canonical_folder(&worktrees).unwrap());
        let root = worktrees.join("conversation-0123456789abcdef0123456789abcdef");
        let branch = "omp/conversation-0123456789abcdef0123456789abcdef".to_string();
        run(
            repo.path(),
            &[
                "worktree",
                "add",
                "-b",
                &branch,
                root.to_str().unwrap(),
                "HEAD",
            ],
        );
        let source_subdir = repo.path().join("sub");
        Some(Self {
            repo,
            data,
            root,
            source_subdir,
            branch,
        })
    }

    fn store(&self) -> Store {
        Store::load(Some(self.data.path().to_path_buf()))
    }

    fn register(&self, store: &mut Store) -> super::WorkspaceView {
        let session = self
            .data
            .path()
            .join("2026-01-01_01234567-89ab-cdef-0123-456789abcdef.jsonl");
        store
            .register(
                "default",
                &self.root.join("sub"),
                &self.source_subdir,
                Some(&session),
                100,
            )
            .unwrap()
            .unwrap()
    }
}

fn prepare_full_recovery(fixture: &Fixture) -> String {
    std::fs::write(fixture.root.join("reflog-only"), b"previous commit").unwrap();
    run(&fixture.root, &["add", "reflog-only"]);
    run(&fixture.root, &["commit", "-q", "-m", "reflog-only commit"]);
    let reflog_only = run(&fixture.root, &["rev-parse", "HEAD"])
        .trim()
        .to_string();
    run(&fixture.root, &["reset", "--hard", "HEAD~1"]);
    std::fs::write(fixture.root.join("workspace-only"), b"workspace commit").unwrap();
    run(&fixture.root, &["add", "workspace-only"]);
    run(
        &fixture.root,
        &["commit", "-q", "-m", "worktree-only commit"],
    );
    std::fs::write(fixture.root.join("sub/file.txt"), b"staged\n").unwrap();
    run(&fixture.root, &["add", "sub/file.txt"]);
    std::fs::write(fixture.root.join("sub/file.txt"), b"unstaged\n").unwrap();
    std::fs::write(fixture.root.join(".env"), b"LOCAL_SECRET=value\n").unwrap();
    std::fs::write(fixture.root.join("untracked.db"), [0, 1, 2, 255]).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(
            fixture.root.join("untracked.db"),
            std::fs::Permissions::from_mode(0o751),
        )
        .unwrap();
    }
    std::fs::create_dir(fixture.root.join("target")).unwrap();
    std::fs::write(
        fixture.root.join("target/important"),
        b"tracked in ignored directory",
    )
    .unwrap();
    run(&fixture.root, &["add", "-f", "target/important"]);
    std::fs::create_dir_all(fixture.root.join(".claude/worktrees")).unwrap();
    std::fs::write(
        fixture.root.join(".claude/worktrees/local.txt"),
        b"keep ignored local work",
    )
    .unwrap();
    std::fs::create_dir(fixture.root.join("node_modules")).unwrap();
    std::fs::write(fixture.root.join("node_modules/cache.bin"), b"rebuildable").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("sub/file.txt", fixture.root.join("link")).unwrap();
    reflog_only
}

fn assert_recovered_worktree(fixture: &Fixture) {
    assert_eq!(run(&fixture.root, &["show", ":sub/file.txt"]), "staged\n");
    assert_eq!(
        std::fs::read(fixture.root.join("sub/file.txt")).unwrap(),
        b"unstaged\n"
    );
    assert_eq!(
        std::fs::read(fixture.root.join(".env")).unwrap(),
        b"LOCAL_SECRET=value\n"
    );
    assert_eq!(
        std::fs::read(fixture.root.join("untracked.db")).unwrap(),
        [0, 1, 2, 255]
    );
    assert_eq!(
        std::fs::read(fixture.root.join("target/important")).unwrap(),
        b"tracked in ignored directory"
    );
    assert_eq!(
        std::fs::read(fixture.root.join(".claude/worktrees/local.txt")).unwrap(),
        b"keep ignored local work"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(
            std::fs::metadata(fixture.root.join("untracked.db"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o751
        );
    }
    assert!(!fixture.root.join("node_modules").exists());
}

#[test]
fn full_recovery_keeps_index_and_working_tree_independent_of_moving_branch() {
    let Some(fixture) = Fixture::new("staged-and-unstaged") else {
        return;
    };
    let reflog_only = prepare_full_recovery(&fixture);
    let mut store = fixture.store();
    let initial = fixture.register(&mut store);
    let saved_head = run(&fixture.root, &["rev-parse", "HEAD"])
        .trim()
        .to_string();
    let evicted = store.remove(&initial.id, 500).unwrap();
    assert_eq!(evicted.state, "evicted");
    assert!(!fixture.root.exists());

    fixture.repo.write("other.txt", "new source commit\n");
    fixture.repo.git(&["rm", "-r", "sub"]);
    fixture.repo.git(&["add", "other.txt"]);
    fixture.repo.commit("advance source", 1_700_000_100);
    fixture.repo.git(&["branch", "-f", &fixture.branch, "main"]);
    fixture
        .repo
        .git(&["reflog", "expire", "--expire=now", "--all"]);
    fixture.repo.git(&["gc", "--prune=now"]);
    let filter_marker = fixture.repo.arm_clean_filter(".git");
    #[cfg(unix)]
    let hook_marker = {
        use std::os::unix::fs::PermissionsExt as _;
        let hook = fixture.repo.path().join(".git/hooks/post-checkout");
        let marker = fixture.repo.path().join(".git/hook-ran");
        std::fs::write(
            &hook,
            format!("#!/bin/sh\nprintf ran > '{}'\n", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        marker
    };
    let restored = store.restore(&initial.id).unwrap();
    assert_eq!(restored.state, "present");
    assert!(restored
        .branch
        .as_deref()
        .unwrap()
        .starts_with("omp/restore-"));
    assert_eq!(
        run(&fixture.root, &["rev-parse", "HEAD"]).trim(),
        saved_head
    );
    run(&fixture.root, &["cat-file", "-e", &reflog_only]);
    assert_recovered_worktree(&fixture);
    assert!(!filter_marker.exists());
    #[cfg(unix)]
    assert!(!hook_marker.exists());
    #[cfg(unix)]
    assert_eq!(
        std::fs::read_link(fixture.root.join("link")).unwrap(),
        Path::new("sub/file.txt")
    );
    assert_eq!(Path::new(&restored.path), fixture.root.join("sub"));
    assert_eq!(
        store
            .find_path(Path::new(&restored.path))
            .unwrap()
            .unwrap()
            .id,
        initial.id
    );
    let rebound = store
        .register(
            "default",
            Path::new(&restored.path),
            Path::new(&restored.project_path),
            None,
            1_000,
        )
        .unwrap()
        .unwrap();
    assert_eq!(rebound.id, initial.id);
}

#[test]
fn unchanged_available_branch_is_reused() {
    let Some(fixture) = Fixture::new("reuse-branch") else {
        return;
    };
    let mut store = fixture.store();
    let view = fixture.register(&mut store);
    store.remove(&view.id, 200).unwrap();
    let restored = store.restore(&view.id).unwrap();
    assert_eq!(restored.branch.as_deref(), Some(fixture.branch.as_str()));
    assert_eq!(restored.path, view.path);
}

#[cfg(unix)]
#[test]
fn owner_group_and_mode_survive_recovery() {
    use std::os::fd::AsRawFd as _;
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
    let Some(fixture) = Fixture::new("owner-group") else {
        return;
    };
    let file = fixture.root.join("owned");
    std::fs::write(&file, b"private work").unwrap();
    let handle = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&file)
        .unwrap();
    let initial_gid = handle.metadata().unwrap().gid();
    // SAFETY: a zero count queries the supplementary group count only.
    let count = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
    if count > 0 {
        let mut groups = vec![0 as libc::gid_t; usize::try_from(count).unwrap()];
        // SAFETY: `groups` has exactly `count` writable gid_t entries.
        let actual = unsafe { libc::getgroups(count, groups.as_mut_ptr()) };
        if actual > 0 {
            if let Some(group) = groups.into_iter().find(|gid| *gid != initial_gid) {
                // SAFETY: the handle is valid; -1 retains owner. Changing to
                // a permitted supplementary group is optional in this test.
                let _ = unsafe { libc::fchown(handle.as_raw_fd(), libc::uid_t::MAX, group) };
            }
        }
    }
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o751)).unwrap();
    let before = std::fs::metadata(&file).unwrap();
    let mut store = fixture.store();
    let view = fixture.register(&mut store);
    store.remove(&view.id, 100).unwrap();
    store.restore(&view.id).unwrap();
    let after = std::fs::metadata(&file).unwrap();
    assert_eq!((after.uid(), after.gid()), (before.uid(), before.gid()));
    assert_eq!(after.mode() & 0o7777, before.mode() & 0o7777);
    assert_eq!(std::fs::read(file).unwrap(), b"private work");
}

#[test]
fn deleted_branch_and_destination_collision_restore_to_new_safe_location() {
    let Some(fixture) = Fixture::new("deleted-branch") else {
        return;
    };
    std::fs::write(fixture.root.join("untracked"), b"unsaved").unwrap();
    let mut store = fixture.store();
    let view = fixture.register(&mut store);
    store.remove(&view.id, 200).unwrap();
    fixture.repo.git(&["branch", "-D", &fixture.branch]);
    std::fs::create_dir(&fixture.root).unwrap();
    std::fs::write(fixture.root.join("do-not-touch"), b"existing").unwrap();
    let restored = store.restore(&view.id).unwrap();
    assert_ne!(Path::new(&restored.path), fixture.root.join("sub"));
    assert_eq!(
        std::fs::read(fixture.root.join("do-not-touch")).unwrap(),
        b"existing"
    );
    let new_root = Path::new(&restored.path).parent().unwrap();
    assert_eq!(
        std::fs::read(new_root.join("untracked")).unwrap(),
        b"unsaved"
    );
    assert!(store
        .find_path(&fixture.root.join("sub"))
        .unwrap()
        .is_none());
    let session = fixture
        .data
        .path()
        .join("2026-01-01_01234567-89ab-cdef-0123-456789abcdef.jsonl");
    assert_eq!(
        store.find_session("default", &session).unwrap().unwrap().id,
        view.id
    );
    assert_eq!(
        store.find_path(&new_root.join("sub")).unwrap().unwrap().id,
        view.id
    );
}

#[test]
fn session_cwds_survive_collision_restore_and_profile_aliases() {
    let Some(fixture) = Fixture::new("session-cwds") else {
        return;
    };
    let source_b = fixture.repo.path().join("sub-b");
    let worktree_b = fixture.root.join("sub-b");
    std::fs::create_dir(&source_b).unwrap();
    std::fs::create_dir(&worktree_b).unwrap();
    std::fs::write(worktree_b.join("local"), b"second conversation").unwrap();
    let session_a = fixture
        .data
        .path()
        .join("2026-01-01_01234567-89ab-cdef-0123-456789abcdef.jsonl");
    let session_b = fixture
        .data
        .path()
        .join("2026-01-02_11234567-89ab-cdef-0123-456789abcdef.jsonl");
    let mut store = fixture.store();
    let first = fixture.register(&mut store);
    let second = store
        .register("alternate", &worktree_b, &source_b, Some(&session_b), 101)
        .unwrap()
        .unwrap();
    assert_eq!(second.id, first.id);
    assert_eq!(Path::new(&second.path), worktree_b);
    store
        .bind_session(&first.id, "alternate", &session_b, &worktree_b)
        .unwrap();
    let prefix = Path::new("01234567-89ab");
    store
        .bind_session(&first.id, "default", prefix, &worktree_b)
        .unwrap();
    assert_eq!(
        Path::new(
            &store
                .find_session("default", &session_a)
                .unwrap()
                .unwrap()
                .path
        ),
        worktree_b
    );
    store
        .bind_session(&first.id, "default", prefix, &fixture.root.join("sub"))
        .unwrap();
    assert_eq!(
        Path::new(&store.find_path(&worktree_b).unwrap().unwrap().path),
        worktree_b
    );
    drop(store);
    let mut store = fixture.store();
    assert_eq!(
        Path::new(
            &store
                .find_session("default", &session_a)
                .unwrap()
                .unwrap()
                .path
        ),
        fixture.root.join("sub")
    );
    assert_eq!(
        Path::new(
            &store
                .find_session("alternate", &session_b)
                .unwrap()
                .unwrap()
                .path
        ),
        worktree_b
    );
    store.remove(&first.id, 200).unwrap();
    std::fs::create_dir(&fixture.root).unwrap();
    std::fs::write(fixture.root.join("collision"), b"do not touch").unwrap();
    let restored = store.restore(&first.id).unwrap();
    let restored_root = Path::new(&restored.path).parent().unwrap();
    let default_view = store.find_session("default", &session_a).unwrap().unwrap();
    let alternate_view = store
        .find_session("alternate", &session_b)
        .unwrap()
        .unwrap();
    assert_eq!(Path::new(&default_view.path), restored_root.join("sub"));
    assert_eq!(Path::new(&alternate_view.path), restored_root.join("sub-b"));
    assert_eq!(
        std::fs::read(Path::new(&alternate_view.path).join("local")).unwrap(),
        b"second conversation"
    );
    assert_eq!(
        std::fs::read(fixture.root.join("collision")).unwrap(),
        b"do not touch"
    );
}

#[test]
fn corrupt_recovery_point_never_authorizes_original_removal() {
    let Some(fixture) = Fixture::new("corrupt-checkpoint") else {
        return;
    };
    std::fs::write(fixture.root.join("important"), b"valuable").unwrap();
    let store = fixture.store();
    let data = store.data.as_deref().unwrap();
    let storage = store.storage.as_deref().unwrap();
    let identity = identity::inspect(data, &fixture.root.join("sub"), &fixture.source_subdir)
        .unwrap()
        .unwrap();
    let (reference, _) = snapshot::create(storage, &identity, 100).unwrap();
    let pack = storage
        .join("snapshots")
        .join(&reference.name)
        .join("objects.pack");
    std::fs::write(pack, b"corrupt").unwrap();
    assert!(snapshot::read(storage, &reference).is_err());
    assert_eq!(
        std::fs::read(fixture.root.join("important")).unwrap(),
        b"valuable"
    );
}

#[test]
fn interrupted_removal_does_not_replace_verified_checkpoint() {
    let Some(fixture) = Fixture::new("interrupted-removal") else {
        return;
    };
    std::fs::write(fixture.root.join("important"), b"original").unwrap();
    let mut store = fixture.store();
    let view = fixture.register(&mut store);
    let identity = identity::inspect(
        store.data.as_deref().unwrap(),
        &fixture.root.join("sub"),
        &fixture.source_subdir,
    )
    .unwrap()
    .unwrap();
    let (reference, _) =
        snapshot::create(store.storage.as_deref().unwrap(), &identity, 100).unwrap();
    let saved_hash = reference.manifest_hash.clone();
    store
        .transaction(|catalog| {
            let record = catalog
                .records
                .iter_mut()
                .find(|r| r.id == view.id)
                .unwrap();
            record.snapshots.push(reference);
            record.evicted = true;
            Ok(())
        })
        .unwrap();
    // Simulate a partially completed native removal before a process restart.
    std::fs::write(fixture.root.join("important"), b"partially removed").unwrap();
    drop(store);
    let mut reopened = fixture.store();
    assert!(reopened.remove(&view.id, 200).is_err());
    assert_eq!(
        reopened
            .record(&view.id)
            .unwrap()
            .snapshots
            .last()
            .unwrap()
            .manifest_hash,
        saved_hash
    );
    let restored = reopened.restore(&view.id).unwrap();
    let restored_root = Path::new(&restored.path).parent().unwrap();
    assert_eq!(
        std::fs::read(restored_root.join("important")).unwrap(),
        b"original"
    );
    assert_eq!(
        std::fs::read(fixture.root.join("important")).unwrap(),
        b"partially removed"
    );
}

#[test]
fn keep_boundary_pin_and_cross_profile_session_are_durable() {
    let Some(fixture) = Fixture::new("lease-and-pin") else {
        return;
    };
    let mut store = fixture.store();
    let view = fixture.register(&mut store);
    assert_eq!(store.due(u64::MAX).unwrap(), [] as [String; 0]);
    assert!(!store.is_due(&view.id, u64::MAX).unwrap());
    assert!(store
        .set_policy(Policy {
            max_worktrees: 1,
            max_bytes: 1,
            retention_days: 29
        })
        .is_err());
    let other = fixture
        .data
        .path()
        .join("2026-01-02_11234567-89ab-cdef-0123-456789abcdef.jsonl");
    store
        .bind_session(&view.id, "alternate", &other, &fixture.root.join("sub"))
        .unwrap();
    store.keep(&view.id, 1_000).unwrap();
    let end = 1_000 + super::catalog::RETENTION_MS;
    assert_eq!(store.due(end - 1).unwrap(), [] as [String; 0]);
    assert!(!store.is_due(&view.id, end - 1).unwrap());
    assert_eq!(store.due(end).unwrap(), [view.id.as_str()]);
    assert!(store.is_due(&view.id, end).unwrap());
    assert!(!store.is_due("missing", end).unwrap());
    store.set_pin(&view.id, true).unwrap();
    assert_eq!(store.due(end).unwrap(), [] as [String; 0]);
    assert!(!store.is_due(&view.id, end).unwrap());
    assert!(store.remove(&view.id, end).is_err());
    store
        .set_policy(Policy {
            max_worktrees: 2,
            max_bytes: 1,
            retention_days: 30,
        })
        .unwrap();
    let before = store.view().unwrap();
    assert!(!before.size_complete);
    assert!(!before.workspaces[0].size_known);
    let results = store
        .measurement_targets()
        .unwrap()
        .into_iter()
        .map(|(id, root, generation)| {
            let size = super::measure_bytes(&root);
            (id, root, generation, size)
        })
        .collect();
    store.apply_measurements(results).unwrap();
    let measured = store.view().unwrap();
    assert!(measured.size_complete);
    assert!(measured.over_budget);
    assert!(measured.workspaces[0].error.is_some()); // pinned removal diagnostic survives measurement
    drop(store);
    let mut reopened = fixture.store();
    assert!(
        reopened
            .find_session("alternate", &other)
            .unwrap()
            .unwrap()
            .pinned
    );
    assert_eq!(
        reopened
            .find_session("alternate", Path::new("11234567-89ab"))
            .unwrap()
            .unwrap()
            .id,
        view.id
    );
    assert_eq!(reopened.view().unwrap().policy.max_bytes, 1);
    assert!(!reopened.view().unwrap().size_complete);
    reopened.set_pin(&view.id, false).unwrap();
    reopened.touch(&view.id, end + 5_000).unwrap();
    assert_eq!(reopened.due(end).unwrap(), [] as [String; 0]);
    assert_eq!(
        reopened
            .due(end + 5_000 + super::catalog::RETENTION_MS - 1)
            .unwrap(),
        [] as [String; 0]
    );
    assert_eq!(
        reopened
            .due(end + 5_000 + super::catalog::RETENTION_MS)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn inventory_rejects_stale_results_and_keeps_failures_separate() {
    let Some(fixture) = Fixture::new("inventory-generation") else {
        return;
    };
    let mut store = fixture.store();
    let view = fixture.register(&mut store);
    let stale = store.measurement_targets().unwrap().pop().unwrap();
    store.touch(&view.id, 500).unwrap();
    store
        .apply_measurements(vec![(stale.0, stale.1, stale.2, Ok(999))])
        .unwrap();
    assert!(!store.workspace(&view.id).unwrap().size_known);
    let failed = store.measurement_targets().unwrap().pop().unwrap();
    store
        .apply_measurements(vec![(
            failed.0,
            failed.1,
            failed.2,
            Err("scan failed".into()),
        )])
        .unwrap();
    let failed_view = store.workspace(&view.id).unwrap();
    assert_eq!(
        failed_view.measurement_error.as_deref(),
        Some("scan failed")
    );
    assert!(failed_view.error.is_none());
    assert!(!store.view().unwrap().size_complete);
    let current = store.measurement_targets().unwrap().pop().unwrap();
    let size = super::measure_bytes(&current.1);
    store
        .apply_measurements(vec![(current.0, current.1, current.2, size)])
        .unwrap();
    assert!(store.workspace(&view.id).unwrap().size_known);
    assert!(store
        .workspace(&view.id)
        .unwrap()
        .measurement_error
        .is_none());
    let older = store.measurement_targets().unwrap().pop().unwrap();
    let newer = store.measurement_targets().unwrap().pop().unwrap();
    store
        .apply_measurements(vec![(newer.0, newer.1, newer.2, Ok(200))])
        .unwrap();
    store
        .apply_measurements(vec![(older.0, older.1, older.2, Ok(100))])
        .unwrap();
    assert_eq!(store.workspace(&view.id).unwrap().bytes, 200);
    let before_removal = store.measurement_targets().unwrap().pop().unwrap();
    store.remove(&view.id, 600).unwrap();
    let restored = store.restore(&view.id).unwrap();
    assert_eq!(Path::new(&restored.path), fixture.root.join("sub"));
    store
        .apply_measurements(vec![(
            before_removal.0,
            before_removal.1,
            before_removal.2,
            Ok(123),
        )])
        .unwrap();
    assert!(!store.workspace(&view.id).unwrap().size_known);
}

#[test]
fn catalog_corruption_disables_writes_and_nested_repository_blocks_removal() {
    let Some(fixture) = Fixture::new("corruption-and-nested") else {
        return;
    };
    let mut store = fixture.store();
    let view = fixture.register(&mut store);
    let identity = identity::inspect(
        store.data.as_deref().unwrap(),
        &fixture.root.join("sub"),
        &fixture.source_subdir,
    )
    .unwrap()
    .unwrap();
    let merge_head = identity.gitdir.join("MERGE_HEAD");
    std::fs::write(&merge_head, format!("{}\n", identity.head)).unwrap();
    for now in 190..193 {
        assert!(store.remove(&view.id, now).is_err());
        assert!(fixture.root.join("sub/file.txt").exists());
    }
    let snapshots = fixture.data.path().join("worktree-storage/snapshots");
    if snapshots.exists() {
        assert_eq!(std::fs::read_dir(&snapshots).unwrap().count(), 0);
    }
    std::fs::remove_file(merge_head).unwrap();
    let nested = fixture.root.join(".claude/worktrees/nested");
    std::fs::create_dir_all(&nested).unwrap();
    run(&nested, &["init", "-q"]);
    std::fs::write(nested.join("valuable"), b"nested work").unwrap();
    assert!(store.find_path(&nested).is_err());
    for now in 200..203 {
        assert!(store.remove(&view.id, now).is_err());
        assert_eq!(
            std::fs::read(nested.join("valuable")).unwrap(),
            b"nested work"
        );
    }
    if snapshots.exists() {
        assert_eq!(std::fs::read_dir(snapshots).unwrap().count(), 0);
    }
    assert!(store.view().unwrap().workspaces[0].error.is_some());
    let catalog = fixture.data.path().join("worktree-storage/catalog.json");
    std::fs::write(&catalog, b"not json").unwrap();
    assert!(store.keep(&view.id, 300).is_err());
    assert_eq!(std::fs::read(&catalog).unwrap(), b"not json");
    assert!(fixture.store().view().is_err());
}

#[test]
fn ordinary_folders_and_unowned_repositories_are_not_adopted() {
    let Some(fixture) = Fixture::new("unmanaged") else {
        return;
    };
    let mut store = fixture.store();
    assert!(store
        .register(
            "default",
            fixture.repo.path(),
            fixture.repo.path(),
            None,
            100
        )
        .unwrap()
        .is_none());
    assert!(store.view().unwrap().workspaces.is_empty());
    let unknown = fixture
        .data
        .path()
        .join("conversation-worktrees/conversation-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    std::fs::create_dir(&unknown).unwrap();
    run(&unknown, &["init", "-q"]);
    assert!(store
        .register("default", &unknown, fixture.repo.path(), None, 100)
        .is_err());
    assert!(unknown.exists());
    assert!(fixture.repo.path().exists());
}

#[cfg(windows)]
#[test]
fn alternate_data_stream_blocks_removal() {
    let Some(fixture) = Fixture::new("alternate-stream") else {
        return;
    };
    let file = fixture.root.join("notes.txt");
    std::fs::write(&file, b"visible").unwrap();
    let stream = fixture.root.join("notes.txt:local-secret");
    if std::fs::write(&stream, b"stream data").is_err() {
        return;
    }
    let mut store = fixture.store();
    let view = fixture.register(&mut store);
    assert!(store.remove(&view.id, 200).is_err());
    assert_eq!(std::fs::read(&file).unwrap(), b"visible");
    assert_eq!(std::fs::read(&stream).unwrap(), b"stream data");
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn test_xattr_handle(path: &Path) -> std::fs::File {
    #[cfg(target_os = "macos")]
    if std::fs::symlink_metadata(path)
        .unwrap()
        .file_type()
        .is_symlink()
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        return std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_SYMLINK)
            .open(path)
            .unwrap();
    }
    std::fs::File::open(path).unwrap()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn set_test_xattr(path: &Path, name: &str, value: &[u8]) {
    use std::os::fd::AsRawFd as _;
    let file = test_xattr_handle(path);
    let name = std::ffi::CString::new(name).unwrap();
    #[cfg(target_os = "macos")]
    // SAFETY: the live fd, NUL-terminated name and value slice are valid.
    let result = unsafe {
        libc::fsetxattr(
            file.as_raw_fd(),
            name.as_ptr(),
            value.as_ptr().cast(),
            value.len(),
            0,
            0,
        )
    };
    #[cfg(target_os = "linux")]
    // SAFETY: the live fd, NUL-terminated name and value slice are valid.
    let result = unsafe {
        libc::fsetxattr(
            file.as_raw_fd(),
            name.as_ptr(),
            value.as_ptr().cast(),
            value.len(),
            0,
        )
    };
    assert_eq!(
        result,
        0,
        "setting extended attribute on {}: {}",
        path.display(),
        std::io::Error::last_os_error()
    );
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn get_test_xattr(path: &Path, name: &str) -> Vec<u8> {
    use std::os::fd::AsRawFd as _;
    let file = test_xattr_handle(path);
    let name = std::ffi::CString::new(name).unwrap();
    let mut buffer = vec![0u8; 1024];
    #[cfg(target_os = "macos")]
    // SAFETY: the live fd, NUL-terminated name and output buffer are valid.
    let count = unsafe {
        libc::fgetxattr(
            file.as_raw_fd(),
            name.as_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            0,
            0,
        )
    };
    #[cfg(target_os = "linux")]
    // SAFETY: the live fd, NUL-terminated name and output buffer are valid.
    let count = unsafe {
        libc::fgetxattr(
            file.as_raw_fd(),
            name.as_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
        )
    };
    assert!(
        count >= 0,
        "reading extended attribute on {}: {}",
        path.display(),
        std::io::Error::last_os_error()
    );
    buffer.truncate(usize::try_from(count).unwrap());
    buffer
}

#[cfg(target_os = "macos")]
fn provenance(path: &Path) -> Option<Vec<u8>> {
    use std::os::fd::AsRawFd as _;
    let file = test_xattr_handle(path);
    let name = std::ffi::CString::new("com.apple.provenance").unwrap();
    let mut buffer = vec![0u8; 1024];
    // SAFETY: the live fd, NUL-terminated name and output buffer are valid.
    let count = unsafe {
        libc::fgetxattr(
            file.as_raw_fd(),
            name.as_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            0,
            0,
        )
    };
    if count < 0 {
        let error = std::io::Error::last_os_error();
        assert_eq!(
            error.raw_os_error(),
            Some(libc::ENOATTR),
            "cannot read default provenance: {error}"
        );
        return None;
    }
    buffer.truncate(usize::try_from(count).unwrap());
    Some(buffer)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn extended_attributes_on_root_directory_and_ignored_file_survive_recovery() {
    let Some(fixture) = Fixture::new("xattr-roundtrip") else {
        return;
    };
    #[cfg(target_os = "macos")]
    let name = "com.omp.recovery-smoke";
    #[cfg(target_os = "linux")]
    let name = "user.com.omp.recovery-smoke";
    std::fs::write(fixture.root.join(".env"), b"secret=1\n").unwrap();
    set_test_xattr(&fixture.root, name, b"root metadata");
    set_test_xattr(&fixture.root.join("sub"), name, b"directory metadata");
    set_test_xattr(&fixture.root.join(".env"), name, &[0, 255, 42, 0, 128]);
    let gitdir = PathBuf::from(run(&fixture.root, &["rev-parse", "--absolute-git-dir"]).trim());
    set_test_xattr(&gitdir.join("index"), name, b"staged metadata");
    #[cfg(target_os = "macos")]
    {
        std::os::unix::fs::symlink(".env", fixture.root.join("local-link")).unwrap();
        set_test_xattr(&fixture.root.join("local-link"), name, b"link metadata");
    }
    #[cfg(target_os = "macos")]
    let original_provenance =
        ["", "sub", ".env", "local-link"].map(|path| provenance(&fixture.root.join(path)));
    let mut store = fixture.store();
    let view = fixture.register(&mut store);
    store.remove(&view.id, 200).unwrap();
    let restored = store.restore(&view.id).unwrap();
    let root = Path::new(&restored.path).parent().unwrap();
    assert_eq!(get_test_xattr(root, name), b"root metadata");
    assert_eq!(
        get_test_xattr(&root.join("sub"), name),
        b"directory metadata"
    );
    assert_eq!(
        get_test_xattr(&root.join(".env"), name),
        [0, 255, 42, 0, 128]
    );
    let gitdir = PathBuf::from(run(root, &["rev-parse", "--absolute-git-dir"]).trim());
    assert_eq!(
        get_test_xattr(&gitdir.join("index"), name),
        b"staged metadata"
    );
    assert_eq!(std::fs::read(root.join(".env")).unwrap(), b"secret=1\n");
    #[cfg(target_os = "macos")]
    {
        assert_eq!(
            std::fs::read_link(root.join("local-link")).unwrap(),
            Path::new(".env")
        );
        assert_eq!(
            get_test_xattr(&root.join("local-link"), name),
            b"link metadata"
        );
        let restored_provenance =
            ["", "sub", ".env", "local-link"].map(|path| provenance(&root.join(path)));
        assert_eq!(restored_provenance, original_provenance);
    }
}

#[cfg(target_os = "macos")]
#[test]
fn unpreservable_acl_reports_path_and_keeps_original() {
    let Some(fixture) = Fixture::new("xattr-acl-refusal") else {
        return;
    };
    let file = fixture.root.join("valuable-acl.txt");
    std::fs::write(&file, b"valuable").unwrap();
    let user = Command::new("/usr/bin/id").arg("-un").output().unwrap();
    assert!(user.status.success());
    let user = std::str::from_utf8(&user.stdout).unwrap().trim();
    let status = Command::new("/bin/chmod")
        .args(["+a", &format!("user:{user} allow read")])
        .arg(&file)
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "cannot create fixture ACL: {}",
        String::from_utf8_lossy(&status.stderr)
    );
    let mut store = fixture.store();
    let view = fixture.register(&mut store);
    let error = store.remove(&view.id, 200).unwrap_err();
    assert!(
        error.contains("valuable-acl.txt"),
        "refusal lacks path: {error}"
    );
    assert!(
        error.to_ascii_lowercase().contains("acl"),
        "refusal lacks ACL diagnosis: {error}"
    );
    assert_eq!(std::fs::read(file).unwrap(), b"valuable");
    assert!(!store.workspace(&view.id).unwrap().state.eq("evicted"));
}

#[test]
fn passive_restore_preserves_lease_until_explicit_use() {
    let Some(fixture) = Fixture::new("passive-restore-lease") else {
        return;
    };
    let mut store = fixture.store();
    let view = fixture.register(&mut store);
    store.keep(&view.id, 200).unwrap();
    let removed = store.remove(&view.id, 300).unwrap();
    let restored = store.restore(&view.id).unwrap();
    assert_eq!(restored.closed_at_ms, removed.closed_at_ms);
    assert_eq!(restored.last_used_at_ms, removed.last_used_at_ms);
    let end = 300 + super::catalog::RETENTION_MS;
    assert!(!store.is_due(&view.id, end - 1).unwrap());
    assert!(store.is_due(&view.id, end).unwrap());
    store.touch(&view.id, end + 50).unwrap();
    assert!(!store.is_due(&view.id, end + 50).unwrap());
    assert!(store
        .is_due(&view.id, end + 50 + super::catalog::RETENTION_MS)
        .unwrap());
}
