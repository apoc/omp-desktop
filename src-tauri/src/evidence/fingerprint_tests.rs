use super::{ci_result, fingerprint};
use crate::git_browser::fixture;
use serde_json::{json, Value};

fn capture(repo: &fixture::Repo) -> Value {
    fingerprint(Some(repo.path().to_str().unwrap()))
}

fn committed(tag: &str) -> Option<fixture::Repo> {
    let repo = fixture::init(tag)?;
    repo.write("tracked.txt", "original\n");
    repo.git(&["add", "tracked.txt"]);
    repo.commit("initial", 1_700_000_000);
    Some(repo)
}

#[test]
fn no_project_is_incomplete_and_never_looks_clean() {
    let value = fingerprint(None);
    assert_eq!(value["complete"], false);
    assert!(value["head"].is_null());
    assert!(value["dirtyDigest"].is_null());
    assert!(value["reason"].as_str().unwrap().contains("project"));
}

#[test]
fn non_git_and_unborn_repositories_are_incomplete() {
    let Some(repo) = fixture::init("evidence-unborn") else {
        return;
    };
    let unborn = capture(&repo);
    assert_eq!(unborn["complete"], false);
    assert!(unborn["head"].is_null());
    // Use a sibling rather than a child of the repository for discovery.
    let dir = repo.path().with_extension("non-git");
    std::fs::create_dir_all(&dir).unwrap();
    let value = fingerprint(dir.to_str());
    assert_eq!(value["complete"], false);
    assert!(value["reason"].as_str().unwrap().contains("Git repository"));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn worktree_content_names_deletions_and_staging_change_the_digest() {
    let Some(repo) = committed("evidence-content") else {
        return;
    };
    let clean = capture(&repo);
    assert_eq!(clean["complete"], true, "{clean}");
    assert!(clean["dirtyDigest"].is_null());
    assert!(clean["head"].as_str().is_some());

    repo.write("tracked.txt", "first change\n");
    let first = capture(&repo);
    assert_eq!(first["complete"], true, "{first}");
    assert!(first["dirtyDigest"].is_string());
    repo.write("tracked.txt", "second change\n");
    let second = capture(&repo);
    assert_ne!(first["dirtyDigest"], second["dirtyDigest"]);
    repo.git(&["add", "tracked.txt"]);
    assert_eq!(capture(&repo)["dirtyDigest"], second["dirtyDigest"]);

    std::fs::remove_file(repo.path().join("tracked.txt")).unwrap();
    let deleted = capture(&repo);
    assert_eq!(deleted["complete"], true, "{deleted}");
    assert_ne!(deleted["dirtyDigest"], second["dirtyDigest"]);
    repo.write("one.txt", "same bytes");
    let one = capture(&repo);
    std::fs::rename(repo.path().join("one.txt"), repo.path().join("two.txt")).unwrap();
    let two = capture(&repo);
    assert_eq!(two["complete"], true, "{two}");
    assert_ne!(one["dirtyDigest"], two["dirtyDigest"]);
}

#[test]
fn case_only_path_changes_affect_the_digest() {
    let Some(repo) = committed("evidence-case-rename") else {
        return;
    };
    std::fs::rename(
        repo.path().join("tracked.txt"),
        repo.path().join("TRACKED.txt"),
    )
    .unwrap();
    let result = capture(&repo);
    assert_eq!(result["complete"], true, "{result}");
    assert!(result["dirtyDigest"].is_string());
}

#[test]
fn ignored_files_are_excluded_but_binary_files_are_hashed() {
    let Some(repo) = fixture::init("evidence-binary") else {
        return;
    };
    repo.write(".gitignore", "ignored.dat\n");
    std::fs::write(repo.path().join("binary.dat"), [0, 1, 2]).unwrap();
    repo.git(&["add", ".gitignore", "binary.dat"]);
    repo.commit("binary", 1_700_000_001);
    repo.write("ignored.dat", "ignored");
    let clean = capture(&repo);
    assert_eq!(clean["complete"], true, "{clean}");
    assert!(clean["dirtyDigest"].is_null());
    assert_eq!(clean["environment"]["binaryFiles"], 1);
    std::fs::write(repo.path().join("binary.dat"), [0, 1, 3]).unwrap();
    let changed = capture(&repo);
    assert_eq!(changed["complete"], true, "{changed}");
    assert!(changed["dirtyDigest"].is_string());
}

#[test]
fn oversized_files_are_explicitly_incomplete() {
    let Some(repo) = committed("evidence-limit") else {
        return;
    };
    let file = std::fs::File::create(repo.path().join("large.bin")).unwrap();
    file.set_len(super::scan::MAX_FILE + 1).unwrap();
    let result = capture(&repo);
    assert_eq!(result["complete"], false, "{result}");
    assert!(result["dirtyDigest"].is_null());
    assert!(result["reason"].as_str().unwrap().contains("limit"));
}

#[cfg(unix)]
#[test]
fn symlinks_never_resolve_outside_the_worktree() {
    use std::os::unix::fs::symlink;
    let Some(repo) = committed("evidence-symlink") else {
        return;
    };
    symlink("/etc/passwd", repo.path().join("untrusted")).unwrap();
    let result = capture(&repo);
    assert_eq!(result["complete"], false, "{result}");
    assert!(result["reason"].as_str().unwrap().contains("symlink"));
}

#[cfg(unix)]
#[test]
fn parent_symlinks_are_not_followed_by_the_handle_reader() {
    use std::os::unix::fs::symlink;
    let Some(repo) = committed("evidence-symlink-parent") else {
        return;
    };
    symlink("/etc", repo.path().join("escape")).unwrap();
    let error = super::safe::read(repo.path(), "escape/passwd").unwrap_err();
    assert!(error.contains("symlink"));
}

#[cfg(unix)]
#[test]
fn symbolic_link_ignore_files_are_not_followed() {
    use std::os::unix::fs::symlink;
    let Some(repo) = committed("evidence-ignore-link") else {
        return;
    };
    symlink("/etc/passwd", repo.path().join(".gitignore")).unwrap();
    let result = capture(&repo);
    assert_eq!(result["complete"], false, "{result}");
    assert!(result["reason"].as_str().unwrap().contains("symlink"));
    std::fs::remove_file(repo.path().join(".gitignore")).unwrap();
    let nested = repo.path().join("nested");
    std::fs::create_dir(&nested).unwrap();
    symlink("/etc/passwd", nested.join(".gitignore")).unwrap();
    let result = capture(&repo);
    assert_eq!(result["complete"], false, "{result}");
    assert!(result["reason"].as_str().unwrap().contains("symlink"));
    std::fs::remove_dir_all(nested).unwrap();
    let exclude = repo.path().join(".git/info/exclude");
    std::fs::remove_file(&exclude).unwrap();
    symlink("/etc/passwd", exclude).unwrap();
    let result = capture(&repo);
    assert_eq!(result["complete"], false, "{result}");
    assert!(result["reason"].as_str().unwrap().contains("symlink"));
}

#[test]
fn external_exclude_file_is_reported_without_reading_it() {
    let Some(repo) = committed("evidence-external-exclude") else {
        return;
    };
    repo.git(&["config", "core.excludesFile", "/untrusted/exclude"]);
    let result = capture(&repo);
    assert_eq!(result["complete"], false, "{result}");
    assert!(result["reason"].as_str().unwrap().contains("exclude"));
}

#[test]
fn fingerprint_does_not_run_repository_filters() {
    let Some(repo) = committed("evidence-filter") else {
        return;
    };
    let marker = repo.arm_clean_filter(".git");
    repo.write("tracked.txt", "changed\n");
    let result = capture(&repo);
    assert_eq!(result["complete"], true, "{result}");
    assert!(result["dirtyDigest"].is_string());
    assert!(!marker.exists());
}

#[test]
fn nested_repositories_are_not_traversed() {
    let Some(repo) = committed("evidence-nested") else {
        return;
    };
    let nested = repo.path().join("nested");
    repo.git(&["init", "-q", "nested"]);
    std::fs::write(nested.join("secret"), b"not read").unwrap();
    let result = capture(&repo);
    assert_eq!(result["complete"], false, "{result}");
    assert!(result["reason"].as_str().unwrap().contains("repositor"));
}

#[test]
fn staged_submodule_is_explicitly_incomplete() {
    let Some(repo) = committed("evidence-submodule") else {
        return;
    };
    let head = repo.git(&["rev-parse", "HEAD"]);
    let entry = format!("160000,{},module", head.trim());
    repo.git(&["update-index", "--add", "--cacheinfo", &entry]);
    let result = capture(&repo);
    assert_eq!(result["complete"], false, "{result}");
    assert!(result["reason"].as_str().unwrap().contains("Submodule"));
}

#[test]
fn ci_mapping_preserves_actual_states_and_commit_identity() {
    for (input, expected) in [
        ("none", "absent"),
        ("pending", "pending"),
        ("success", "success"),
        ("failure", "failure"),
        ("unknown", "unknown"),
        ("future", "unknown"),
    ] {
        let result = ci_result(Ok(Some(json!({"head":"abcdef", "checksState":input,
            "number":7, "repository":"owner/repo", "failedChecks":[{"name":"unit", "url":"https://github.com/x"}]}))));
        assert_eq!(result["state"], expected);
        assert_eq!(result["sourceSha"], "abcdef");
        assert!(result["limitations"]
            .as_str()
            .unwrap()
            .contains("uncommitted"));
        assert_eq!(result["snapshot"]["failedChecks"][0]["name"], "unit");
    }
    let no_head = ci_result(Ok(Some(json!({"checksState":"success"}))));
    assert_eq!(no_head["state"], "unknown");
    let absent = ci_result(Ok(None));
    assert_eq!(absent["state"], "absent");
    assert!(absent["sourceSha"].is_null());
    let error = ci_result(Err("GitHub unavailable".into()));
    assert_eq!(error["state"], "unknown");
    assert_eq!(error["reason"], "GitHub unavailable");
}

#[test]
fn ci_metadata_and_errors_are_bounded_on_utf8_boundaries() {
    let error = ci_result(Err("é".repeat(2000)));
    assert!(error["reason"].as_str().unwrap().len() <= 1024);
    assert!(error["reason"].as_str().unwrap().ends_with("[truncated]"));
    let large = "é".repeat(2000);
    let checks: Vec<_> = (0..120)
        .map(|_| json!({"name":large, "url":large}))
        .collect();
    let result = ci_result(Ok(Some(
        json!({"head":"abc", "checksState":"failure", "failedChecks":checks}),
    )));
    assert_eq!(
        result["snapshot"]["failedChecks"].as_array().unwrap().len(),
        100
    );
    assert_eq!(result["snapshot"]["truncated"], true);
    assert!(
        result["snapshot"]["failedChecks"][0]["name"]
            .as_str()
            .unwrap()
            .len()
            <= 256
    );
}

#[test]
fn ci_serialized_payload_stays_bounded_even_when_strings_escape() {
    let id = "\0".repeat(256);
    let name = "\0".repeat(256);
    let url = "\0".repeat(512);
    let checks: Vec<_> = (0..100)
        .map(|_| json!({"id":id, "name":name, "url":url}))
        .collect();
    let result = ci_result(Ok(Some(
        json!({"head":"abc", "checksState":"failure", "failedChecks":checks}),
    )));
    assert!(serde_json::to_vec(&result).unwrap().len() < 128 * 1024);
    assert_eq!(result["snapshot"]["truncated"], true);
    assert!(result["limitations"]
        .as_str()
        .unwrap()
        .contains("truncated"));
}
