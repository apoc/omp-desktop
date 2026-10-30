use super::*;
use crate::test_support::TempDir;

fn input(preset: Preset, keep_id: bool) -> PresetInput {
    PresetInput {
        id: keep_id.then_some(preset.id),
        name: preset.name,
        planning_prompt: preset.planning_prompt,
        collection_prompt: preset.collection_prompt,
        assessment_prompt: preset.assessment_prompt,
        triggers: preset.triggers,
        tracking: preset.tracking,
        handoff: preset.handoff,
    }
}

fn create(store: &ConfigStore, name: &str, revision: u64) -> Preset {
    let mut preset = input(standard(), false);
    preset.name = name.to_owned();
    store.save(preset, revision).expect("create preset")
}

#[test]
fn standard_has_useful_honest_guidance_and_the_expected_wire_shape() {
    let store = ConfigStore::load(None);
    let view = store.library(None);
    assert_eq!(view.revision, 0);
    assert_eq!(view.presets.len(), 1);
    assert_eq!(view.resolved.source, "builtin");
    assert_eq!(view.resolved.preset, view.presets[0]);
    assert!(view
        .warning
        .as_deref()
        .expect("memory warning")
        .contains("memory"));
    let preset = &view.presets[0];
    assert_eq!((preset.id.as_str(), preset.revision), ("standard", 1));
    assert!(preset.planning_prompt.contains("outcomes"));
    assert!(preset.collection_prompt.contains("failures"));
    assert!(preset.assessment_prompt.contains("Do not accept"));
    assert!(preset.tracking);
    let json = serde_json::to_value(&view).expect("serialize library");
    assert_eq!(json["globalDefault"], serde_json::Value::Null);
    assert_eq!(json["projectDefault"], serde_json::Value::Null);
    assert_eq!(json["resolved"]["source"], "builtin");
    assert_eq!(json["presets"][0]["triggers"]["beforeWork"], true);
    assert_eq!(json["presets"][0]["triggers"]["afterChanges"], true);
    assert_eq!(json["presets"][0]["triggers"]["beforeHandoff"], true);
    assert_eq!(json["presets"][0]["handoff"], "advisory");
    assert_eq!(
        serde_json::to_value(DefaultScope::Project).unwrap(),
        "project"
    );
}

#[test]
fn project_override_and_resets_follow_global_then_builtin() {
    let dir = TempDir::new("evidence-presets", "precedence");
    let a = dir.path().join("project-a");
    let b = dir.path().join("project-b");
    let a = a.to_str().expect("UTF-8 project path");
    let b = b.to_str().expect("UTF-8 project path");
    let store = ConfigStore::load(None);
    let global = create(&store, "Global", 0);
    let project = create(&store, "Project", 1);
    store
        .assign(DefaultScope::Global, Some(&global.id), None, 2)
        .unwrap();
    store
        .assign(DefaultScope::Project, Some(&project.id), Some(a), 3)
        .unwrap();
    let a_view = store.library(Some(a));
    assert_eq!(a_view.project.as_deref(), Some(a));
    assert_eq!(a_view.project_default.as_deref(), Some(project.id.as_str()));
    assert_eq!(a_view.global_default.as_deref(), Some(global.id.as_str()));
    assert_eq!(a_view.resolved.source, "project");
    assert_eq!(a_view.resolved.preset.name, "Project");
    assert_eq!(store.resolve(Some(b)).source, "global");
    assert_eq!(store.resolve(None).preset.name, "Global");
    store
        .assign(DefaultScope::Project, None, Some(a), 4)
        .unwrap();
    assert_eq!(store.resolve(Some(a)).source, "global");
    store.assign(DefaultScope::Global, None, None, 5).unwrap();
    assert_eq!(store.resolve(Some(a)).source, "builtin");
    assert_eq!(store.resolve(Some(a)).preset.id, "standard");
}

#[test]
fn snapshots_stay_pinned_and_content_revisions_change_only_on_edits() {
    let dir = TempDir::new("evidence-presets", "revisions");
    let project = dir.path().to_str().unwrap();
    let store = ConfigStore::load(None);
    let custom = create(&store, "Original", 0);
    store
        .assign(DefaultScope::Project, Some(&custom.id), Some(project), 1)
        .unwrap();
    let pinned = store.resolve(Some(project));
    let unchanged = store.save(input(custom, true), 2).unwrap();
    assert_eq!(unchanged.revision, 1);
    assert_eq!(store.library(Some(project)).revision, 2);
    let mut update = input(unchanged, true);
    update.name = "Updated".to_owned();
    let updated = store.save(update, 2).unwrap();
    assert_eq!(updated.revision, 2);
    assert_eq!(store.library(Some(project)).revision, 3);
    assert_eq!(pinned.preset.name, "Original");
    assert_eq!(pinned.preset.revision, 1);
    assert_eq!(store.resolve(Some(project)).preset.name, "Updated");
    assert_eq!(store.resolve(Some(project)).preset.revision, 2);
}

#[test]
fn input_revision_is_not_trusted_and_stale_mutations_do_not_change_state() {
    let store = ConfigStore::load(None);
    let preset = create(&store, "Before", 0);
    let mut wire = serde_json::to_value(&preset).unwrap();
    wire["revision"] = serde_json::json!(MAX_REVISION);
    wire["name"] = serde_json::json!("After");
    let update: PresetInput = serde_json::from_value(wire).unwrap();
    let updated = store.save(update, 1).unwrap();
    assert_eq!(updated.revision, 2);
    let conflict = store
        .assign(DefaultScope::Global, Some(&updated.id), None, 1)
        .unwrap_err();
    assert!(conflict.contains("current revision 2"), "{conflict}");
    assert!(store.delete(&updated.id, 0).is_err());
    let view = store.library(None);
    assert_eq!(view.revision, 2);
    assert_eq!(view.presets[1].name, "After");
    assert_eq!(view.global_default, None);
}

#[test]
fn deleting_requires_all_assignments_to_be_reset_and_standard_is_immutable() {
    let dir = TempDir::new("evidence-presets", "delete");
    let project = dir.path().to_str().unwrap();
    let store = ConfigStore::load(None);
    let custom = create(&store, "Custom", 0);
    store
        .assign(DefaultScope::Global, Some(&custom.id), None, 1)
        .unwrap();
    store
        .assign(DefaultScope::Project, Some(&custom.id), Some(project), 2)
        .unwrap();
    let snapshot = store.resolve(Some(project));
    assert!(store
        .delete(&custom.id, 3)
        .unwrap_err()
        .contains("assigned"));
    store.assign(DefaultScope::Global, None, None, 3).unwrap();
    assert!(store
        .delete(&custom.id, 4)
        .unwrap_err()
        .contains("assigned"));
    store
        .assign(DefaultScope::Project, None, Some(project), 4)
        .unwrap();
    store.delete(&custom.id, 5).unwrap();
    assert_eq!(store.library(None).presets.len(), 1);
    assert_eq!(snapshot.preset.id, custom.id);
    assert_eq!(snapshot.preset.name, "Custom");
    assert!(store.delete("standard", 6).is_err());
    assert!(store.save(input(standard(), true), 6).is_err());
    assert!(store
        .assign(DefaultScope::Global, Some(&custom.id), None, 6)
        .is_err());
    assert_eq!(store.library(None).revision, 6);
    store
        .assign(DefaultScope::Global, Some("standard"), None, 6)
        .unwrap();
    assert_eq!(store.resolve(None).source, "global");
    assert_eq!(store.resolve(None).preset.id, "standard");
}

#[test]
fn rejects_invalid_inputs_and_preserves_the_previous_library() {
    let store = ConfigStore::load(None);
    let mut invalid = input(standard(), false);
    invalid.name = " ".to_owned();
    assert!(store.save(invalid, 0).is_err());
    let mut invalid = input(standard(), false);
    invalid.name = "é".repeat(61);
    assert!(store.save(invalid, 0).is_err());
    let mut invalid = input(standard(), false);
    invalid.planning_prompt = "é".repeat(2049);
    assert!(store.save(invalid, 0).is_err());
    let mut invalid = input(standard(), false);
    invalid.collection_prompt = "bad\0prompt".to_owned();
    assert!(store.save(invalid, 0).is_err());
    let mut invalid = input(standard(), false);
    invalid.handoff = "always".to_owned();
    assert!(store.save(invalid, 0).is_err());
    assert!(store
        .assign(DefaultScope::Project, Some("standard"), None, 0)
        .is_err());
    assert!(store
        .assign(DefaultScope::Project, Some("standard"), Some("relative"), 0)
        .is_err());
    assert!(store
        .assign(DefaultScope::Global, Some("missing"), None, 0)
        .is_err());
    assert_eq!(store.library(None).revision, 0);
    assert_eq!(store.library(None).presets.len(), 1);
}

#[test]
fn caps_entries_and_revisions_without_partial_mutations() {
    let store = ConfigStore::load(None);
    for index in 0..MAX_PRESETS {
        create(&store, &format!("Preset {index}"), index as u64);
    }
    let revision = MAX_PRESETS as u64;
    assert!(store
        .save(input(standard(), false), revision)
        .unwrap_err()
        .contains("full"));
    assert_eq!(store.library(None).revision, revision);

    let mut file = PresetFile {
        revision: MAX_REVISION,
        ..PresetFile::default()
    };
    let preset = standard();
    let mut custom = input(preset, false);
    custom.name = "bounded".to_owned();
    {
        let mut cache = store.cached();
        std::mem::swap(&mut cache.data, &mut file);
    }
    assert!(store.save(custom, MAX_REVISION).is_err());
    assert_eq!(store.library(None).revision, MAX_REVISION);
    assert_eq!(store.library(None).presets.len(), 1);
}

#[test]
fn project_and_serialized_size_limits_leave_memory_store_unchanged() {
    let dir = TempDir::new("evidence-presets", "size-limits");
    let root = dir.path().to_str().unwrap();
    let padding = "x".repeat(3980_usize.saturating_sub(root.len()));
    let mut file = PresetFile::default();
    for index in 0..MAX_PROJECTS {
        file.projects
            .insert(format!("{root}/{padding}-{index}"), "standard".to_owned());
    }
    for index in 0..5 {
        let mut preset = standard();
        preset.id = format!("preset-{index}");
        preset.planning_prompt = "x".repeat(4096);
        preset.collection_prompt = "x".repeat(4096);
        preset.assessment_prompt = "x".repeat(4096);
        file.presets.push(preset);
    }
    assert!(file.validate().is_ok());
    assert!(encode(&file).unwrap_err().contains("size limit"));
    let store = ConfigStore::load(None);
    store.cached().data = file;
    assert!(store
        .assign(DefaultScope::Global, Some("standard"), None, 0)
        .unwrap_err()
        .contains("size limit"));
    assert_eq!(store.library(None).revision, 0);
    assert_eq!(store.library(None).global_default, None);
    let extra_project = dir.path().join("new-project");
    assert!(store
        .assign(
            DefaultScope::Project,
            Some("standard"),
            extra_project.to_str(),
            0
        )
        .unwrap_err()
        .contains("full"));
    assert_eq!(store.library(None).revision, 0);
}

#[test]
fn resetting_absent_assignments_does_not_create_a_config_file() {
    let dir = TempDir::new("evidence-presets", "reset");
    let path = dir.path().join("presets.json");
    let store = ConfigStore::load(Some(dir.path().join("presets.json")));
    store.assign(DefaultScope::Global, None, None, 0).unwrap();
    store
        .assign(DefaultScope::Project, None, dir.path().to_str(), 0)
        .unwrap();
    assert_eq!(store.library(None).revision, 0);
    assert!(!path.exists());
}

#[test]
fn persistence_reopens_and_stale_other_instance_refreshes_after_conflict() {
    let dir = TempDir::new("evidence-presets", "persistence");
    let project = dir.path().to_str().unwrap();
    let path = dir.path().join("private").join("presets.json");
    let first = ConfigStore::load(Some(dir.path().join("private").join("presets.json")));
    let second = ConfigStore::load(Some(dir.path().join("private").join("presets.json")));
    let preset = create(&first, "Saved", 0);
    let error = second
        .assign(DefaultScope::Global, Some(&preset.id), None, 0)
        .unwrap_err();
    assert!(error.contains("current revision 1"), "{error}");
    assert_eq!(second.library(None).revision, 1);
    second
        .assign(DefaultScope::Global, Some(&preset.id), None, 1)
        .unwrap();
    second
        .assign(DefaultScope::Project, Some("standard"), Some(project), 2)
        .unwrap();
    let reopened = ConfigStore::load(Some(path));
    assert_eq!(reopened.library(Some(project)).revision, 3);
    assert_eq!(reopened.resolve(Some(project)).source, "project");
    assert_eq!(reopened.resolve(Some(project)).preset.id, "standard");
    assert_eq!(reopened.resolve(None).preset.name, "Saved");
    assert_eq!(reopened.library(None).warning, None);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.path().join("private").join("presets.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

#[test]
fn memory_only_stores_are_independent_and_warn_about_nonpersistence() {
    let first = ConfigStore::load(None);
    let preset = create(&first, "Transient", 0);
    first
        .assign(DefaultScope::Global, Some(&preset.id), None, 1)
        .unwrap();
    assert_eq!(first.resolve(None).preset.name, "Transient");
    let second = ConfigStore::load(None);
    assert_eq!(second.resolve(None).preset.id, "standard");
    assert_eq!(second.library(None).revision, 0);
    assert!(second
        .library(None)
        .warning
        .unwrap()
        .contains("memory only"));
}

#[test]
fn corrupt_oversized_and_invalid_schema_are_not_replaced() {
    let dir = TempDir::new("evidence-presets", "invalid");
    let path = dir.path().join("presets.json");
    let cases = [
        b"not json".to_vec(),
        serde_json::to_vec(&serde_json::json!({"version": 2, "revision": 0, "presets": [], "globalDefault": null, "projects": {}})).unwrap(),
        serde_json::to_vec(&serde_json::json!({"version": 1, "revision": 0, "presets": [], "globalDefault": "missing", "projects": {}})).unwrap(),
        serde_json::to_vec(&serde_json::json!({"version": 1, "revision": 0, "presets": [], "globalDefault": null, "projects": {}, "unknown": true})).unwrap(),
        vec![b'x'; MAX_CONFIG_BYTES + 1],
    ];
    for bytes in cases {
        std::fs::write(&path, &bytes).unwrap();
        let store = ConfigStore::load(Some(dir.path().join("presets.json")));
        let view = store.library(None);
        assert_eq!(view.resolved.source, "builtin");
        assert!(view.warning.unwrap().contains("unreadable"));
        assert!(store
            .assign(DefaultScope::Global, Some("standard"), None, 0)
            .unwrap_err()
            .contains("unreadable"));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn corruption_after_start_is_reported_without_replacing_the_file() {
    let dir = TempDir::new("evidence-presets", "changed");
    let path = dir.path().join("presets.json");
    let store = ConfigStore::load(Some(dir.path().join("presets.json")));
    create(&store, "Stored", 0);
    std::fs::write(&path, b"broken").unwrap();
    assert!(store
        .assign(DefaultScope::Global, Some("standard"), None, 1)
        .is_err());
    assert!(store.library(None).warning.unwrap().contains("unreadable"));
    assert_eq!(std::fs::read(path).unwrap(), b"broken");
}

#[cfg(unix)]
#[test]
fn symlink_config_is_refused_without_touching_its_target() {
    let dir = TempDir::new("evidence-presets", "symlink");
    let target = dir.path().join("target.json");
    let link = dir.path().join("presets.json");
    std::fs::write(&target, b"target bytes").unwrap();
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let store = ConfigStore::load(Some(link));
    assert!(store
        .assign(DefaultScope::Global, Some("standard"), None, 0)
        .is_err());
    assert_eq!(std::fs::read(target).unwrap(), b"target bytes");
}

#[test]
fn linked_worktrees_share_the_source_project_assignment() {
    let Some(repo) = crate::git_browser::fixture::init("evidence-preset-worktree") else {
        return;
    };
    repo.commit("initial", 1_700_000_000);
    let linked = repo.path().join("linked-checkout");
    repo.git(&["worktree", "add", "--detach", linked.to_str().unwrap()]);
    let source = crate::conversation_workspace::inspect(repo.path().to_str().unwrap()).unwrap();
    let worktree = crate::conversation_workspace::inspect(linked.to_str().unwrap()).unwrap();
    assert_eq!(source.project_path, worktree.project_path);
    assert_ne!(source.path, worktree.path);
    let store = ConfigStore::load(None);
    let custom = create(&store, "Source default", 0);
    store
        .assign(
            DefaultScope::Project,
            Some(&custom.id),
            Some(&worktree.project_path),
            1,
        )
        .unwrap();
    assert_eq!(
        store.resolve(Some(&source.project_path)).preset.name,
        "Source default"
    );
}
