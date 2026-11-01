use super::Store;
use crate::git_browser::fixture::{self, Repo};
use crate::test_support::TempDir;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Fixture {
    repo: Repo,
    data: TempDir,
    root: PathBuf,
    branch: &'static str,
}

fn git_output(root: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap()
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = git_output(root, args);
    assert!(
        output.status.success(),
        "git {args:?} failed in {root:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

impl Fixture {
    fn new() -> Option<Self> {
        let repo = fixture::init("worktree-resolve-undo")?;
        repo.git(&["config", "rerere.enabled", "false"]);
        repo.write("sub/file.txt", "base version\n");
        repo.git(&["add", "."]);
        repo.commit("base", 1_700_000_000);

        let data = TempDir::new("worktree-storage", "resolve-undo");
        let worktrees = data.path().join("conversation-worktrees");
        std::fs::create_dir(&worktrees).unwrap();
        let worktrees = PathBuf::from(crate::external_open::canonical_folder(&worktrees).unwrap());
        let root = worktrees.join("conversation-0123456789abcdef0123456789abcdef");
        let branch = "omp/conversation-0123456789abcdef0123456789abcdef";
        // Pass the destination as a path, not through a shell or Git path syntax.
        let output = Command::new("git")
            .current_dir(repo.path())
            .args(["worktree", "add", "-b", branch])
            .arg(&root)
            .arg("HEAD")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git worktree add failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        Some(Self {
            repo,
            data,
            root,
            branch,
        })
    }

    fn store(&self) -> Store {
        Store::load(Some(self.data.path().to_path_buf()))
    }
}

fn prune_incoming_objects(fixture: &Fixture, incoming_commit: &str, incoming_blob: &str) {
    fixture.repo.git(&["branch", "-D", "incoming"]);
    fixture.repo.git(&["branch", "-D", fixture.branch]);
    fixture.repo.git(&[
        "reflog",
        "expire",
        "--expire=all",
        "--expire-unreachable=all",
        "--all",
    ]);
    fixture.repo.git(&["gc", "--prune=now"]);
    for id in [incoming_commit, incoming_blob] {
        let output = git_output(fixture.repo.path(), &["cat-file", "-e", id]);
        assert!(
            !output.status.success(),
            "incoming object {id} must be absent from the source object database before restore"
        );
    }
}

#[test]
fn resolved_merge_can_be_recreated_after_source_refs_and_objects_are_pruned() {
    let Some(fixture) = Fixture::new() else {
        return;
    };
    let file = "sub/file.txt";
    let base_blob = git(fixture.repo.path(), &["rev-parse", "HEAD:sub/file.txt"]);
    let base_blob = base_blob.trim();

    // The incoming commit is not an ancestor of the saved worktree HEAD.
    fixture.repo.git(&["checkout", "-q", "-b", "incoming"]);
    fixture.repo.write(file, "incoming version\n");
    fixture.repo.git(&["add", file]);
    let incoming_commit = fixture.repo.commit("incoming change", 1_700_000_001);
    let incoming_blob = fixture.repo.git(&["rev-parse", "HEAD:sub/file.txt"]);
    let incoming_blob = incoming_blob.trim();
    fixture.repo.git(&["checkout", "-q", "main"]);

    std::fs::write(fixture.root.join(file), b"worktree version\n").unwrap();
    git(&fixture.root, &["add", file]);
    git(&fixture.root, &["commit", "-q", "-m", "worktree change"]);
    let ours_blob = git(&fixture.root, &["rev-parse", "HEAD:sub/file.txt"]);
    let ours_blob = ours_blob.trim();

    let merge = git_output(&fixture.root, &["merge", "--no-commit", "incoming"]);
    assert_eq!(
        merge.status.code(),
        Some(1),
        "merge must conflict, stdout: {}, stderr: {}",
        String::from_utf8_lossy(&merge.stdout),
        String::from_utf8_lossy(&merge.stderr)
    );
    let conflicted = git(&fixture.root, &["ls-files", "--unmerged", "--", file]);
    assert!(
        !conflicted.is_empty(),
        "the merge must leave unmerged index entries"
    );
    std::fs::write(fixture.root.join(file), b"resolved version\n").unwrap();
    git(&fixture.root, &["add", file]);
    // End the merge without committing, leaving only the resolved index and REUC.
    git(&fixture.root, &["merge", "--quit"]);
    assert_eq!(
        git(&fixture.root, &["ls-files", "--unmerged", "--", file]),
        ""
    );
    assert_eq!(
        git(&fixture.root, &["show", ":sub/file.txt"]),
        "resolved version\n"
    );
    let staged = git(&fixture.root, &["ls-files", "--stage", "--", file]);
    assert!(
        !staged.contains(incoming_blob),
        "incoming blob must not be a normal index entry"
    );
    let undo = git(&fixture.root, &["ls-files", "--resolve-undo", "--", file]);
    assert_eq!(
        undo,
        format!(
            "100644 {base_blob} 1\t{file}\n100644 {ours_blob} 2\t{file}\n100644 {incoming_blob} 3\t{file}\n"
        )
    );

    let mut store = fixture.store();
    let view = store
        .register(
            "default",
            &fixture.root.join("sub"),
            &fixture.repo.path().join("sub"),
            None,
            100,
        )
        .unwrap()
        .unwrap();
    let evicted = store.remove(&view.id, 200).unwrap();
    assert_eq!(evicted.state, "evicted");
    assert!(!fixture.root.exists());
    drop(store);

    prune_incoming_objects(&fixture, &incoming_commit, incoming_blob);

    let mut reopened = fixture.store();
    let restored = reopened.restore(&view.id).unwrap();
    assert_eq!(restored.state, "present");
    // The saved cwd is a subdirectory; restore may choose a different root.
    let root = Path::new(&restored.path).parent().unwrap();
    assert_eq!(
        std::fs::read(root.join(file)).unwrap(),
        b"resolved version\n"
    );
    assert_eq!(git(root, &["show", ":sub/file.txt"]), "resolved version\n");
    assert_eq!(git(root, &["ls-files", "--resolve-undo", "--", file]), undo);

    // Git itself must be able to consume the saved extension and all its blobs.
    git(root, &["checkout", "-m", "--", file]);
    assert_eq!(git(root, &["ls-files", "--unmerged", "--", file]), undo);
    assert_eq!(git(root, &["show", ":1:sub/file.txt"]), "base version\n");
    assert_eq!(
        git(root, &["show", ":2:sub/file.txt"]),
        "worktree version\n"
    );
    assert_eq!(
        git(root, &["show", ":3:sub/file.txt"]),
        "incoming version\n"
    );
}
