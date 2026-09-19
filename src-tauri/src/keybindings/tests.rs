//! Integration tests for the keybindings layer stack.
//!
//! Every test builds a scratch `home` directory with synthetic omp config files
//! and/or an overlay, then asserts the `Payload` fields exactly — matching the
//! plan's §Verification.2 "layer-precedence proof" requirement.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::{env, fs};

use super::{agent_dir_for, config_path, overlay, payload, read_file, read_omp, ACTION_IDS};

// ── scratch-home helpers ──────────────────────────────────────────────────────

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A temporary home directory that is removed when dropped.
struct TmpHome {
    path: PathBuf,
}

impl TmpHome {
    fn new() -> Self {
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = env::temp_dir().join(format!("omp-kb-test-{}-{}", std::process::id(), id));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create home");
        Self { path }
    }

    fn agent_dir(&self) -> PathBuf {
        self.path.join(".omp").join("agent")
    }

    fn named_agent_dir(&self, id: &str) -> PathBuf {
        self.path
            .join(".omp")
            .join("profiles")
            .join(id)
            .join("agent")
    }

    fn write_omp_yml(&self, content: &str) {
        let dir = self.agent_dir();
        fs::create_dir_all(&dir).expect("agent dir");
        fs::write(dir.join("keybindings.yml"), content).expect("write yml");
    }

    fn write_named_yml(&self, profile: &str, content: &str) {
        let dir = self.named_agent_dir(profile);
        fs::create_dir_all(&dir).expect("named agent dir");
        fs::write(dir.join("keybindings.yml"), content).expect("write named yml");
    }

    fn overlay_store(&self) -> overlay::OverlayStore {
        let dir = self.path.join(".config").join("omp-desktop");
        fs::create_dir_all(&dir).expect("config dir");
        overlay::OverlayStore::new(dir.join("keybindings.json"))
    }
}

impl Drop for TmpHome {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

// ── agent_dir_for ─────────────────────────────────────────────────────────────

#[test]
fn pi_coding_agent_dir_applies_only_to_built_in_profile() {
    let home = TmpHome::new();
    let env_dir = OsStr::new("/custom/agent");

    // Built-in profile: env var wins.
    let result = agent_dir_for(&home.path, None, Some(env_dir));
    assert_eq!(result, Path::new("/custom/agent"));

    // Named profile: env var is ignored.
    let result = agent_dir_for(&home.path, Some("work"), Some(env_dir));
    assert_eq!(
        result,
        home.path
            .join(".omp")
            .join("profiles")
            .join("work")
            .join("agent")
    );
}

#[test]
fn empty_profile_id_is_treated_as_built_in() {
    let home = TmpHome::new();
    // The `filter(|id| !id.is_empty())` guard.
    let result = agent_dir_for(&home.path, Some(""), None);
    assert_eq!(result, home.path.join(".omp").join("agent"));
}

// ── config_path probe order ──────────────────────────────────────────────────

#[test]
fn probe_order_picks_yml_first() {
    let home = TmpHome::new();
    let dir = home.agent_dir();
    fs::create_dir_all(&dir).unwrap();
    for name in ["keybindings.yml", "keybindings.yaml", "keybindings.json"] {
        fs::write(dir.join(name), "").unwrap();
    }
    assert!(config_path(&dir).unwrap().ends_with("keybindings.yml"));
}

#[test]
fn probe_order_picks_yaml_when_yml_absent() {
    let home = TmpHome::new();
    let dir = home.agent_dir();
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("keybindings.yaml"), "").unwrap();
    fs::write(dir.join("keybindings.json"), "").unwrap();
    assert!(config_path(&dir).unwrap().ends_with("keybindings.yaml"));
}

#[test]
fn probe_order_picks_json_when_both_yml_variants_absent() {
    let home = TmpHome::new();
    let dir = home.agent_dir();
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("keybindings.json"), "{}").unwrap();
    assert!(config_path(&dir).unwrap().ends_with("keybindings.json"));
}

#[test]
fn probe_order_returns_none_when_no_file_exists() {
    let home = TmpHome::new();
    let dir = home.agent_dir();
    fs::create_dir_all(&dir).unwrap();
    assert!(config_path(&dir).is_none());
}

// ── read_file ─────────────────────────────────────────────────────────────────

#[test]
fn missing_file_yields_empty_map() {
    let home = TmpHome::new();
    let path = home.agent_dir().join("keybindings.yml");
    let result = read_file(&path).unwrap();
    assert_eq!(result.len(), 0);
}

#[test]
fn unreadable_file_yields_err() {
    // Write a directory where the file would be: reading it yields an error.
    let home = TmpHome::new();
    let dir = home.agent_dir();
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("keybindings.yml");
    fs::create_dir_all(&path).unwrap(); // ← directory, not file
    assert!(read_file(&path).is_err());
}

#[test]
fn malformed_json_config_degrades_to_empty_map() {
    // A `.json` keybindings file with a JSONC-style comment is invalid JSON
    // but is exactly the shape omp's `loadRawConfig` tolerates (logs a
    // warning, falls back to `{}`). This must not fail the whole command.
    let home = TmpHome::new();
    let dir = home.agent_dir();
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("keybindings.json");
    fs::write(&path, b"{\n  // comment\n  \"app.exit\": \"ctrl+c\"\n}\n").unwrap();
    let result = read_file(&path).unwrap();
    assert_eq!(result.len(), 0, "malformed JSON degrades to an empty map");
}

#[test]
fn non_object_json_config_degrades_to_empty_map() {
    let home = TmpHome::new();
    let dir = home.agent_dir();
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("keybindings.json");
    fs::write(&path, b"[1, 2, 3]").unwrap();
    assert_eq!(read_file(&path).unwrap().len(), 0);
}

#[test]
fn bom_prefixed_yaml_is_parsed() {
    let home = TmpHome::new();
    let dir = home.agent_dir();
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("keybindings.yml");
    let mut bytes = vec![0xEF, 0xBB, 0xBF]; // UTF-8 BOM
    bytes.extend_from_slice(b"app.exit: ctrl+c\n");
    fs::write(&path, bytes).unwrap();
    let result = read_file(&path).unwrap();
    assert_eq!(result["app.exit"], ["ctrl+c"]);
}

// ── read_omp + profile merge ──────────────────────────────────────────────────

#[test]
fn named_profile_overrides_base_while_non_overridden_survive() {
    let home = TmpHome::new();
    home.write_omp_yml("app.plan.toggle: Alt+Shift+O\napp.model.select: []\n");
    home.write_named_yml("work", "app.plan.toggle: Ctrl+Shift+O\n");

    let layer = read_omp(&home.path, Some("work"), None).unwrap();
    // Named profile overrides this action.
    assert_eq!(layer.bindings["app.plan.toggle"], ["ctrl+shift+o"]);
    // Un-overridden base entry survives.
    assert!(layer.bindings.contains_key("app.model.select"));
    assert_eq!(layer.bindings["app.model.select"], [] as [String; 0]);
    // Paths populated correctly.
    assert!(layer
        .path
        .as_deref()
        .is_some_and(|p| p.ends_with("keybindings.yml")));
    assert!(layer.inherited_path.is_some());
}

#[test]
fn built_in_profile_reads_only_one_file_no_inherited() {
    let home = TmpHome::new();
    home.write_omp_yml("app.plan.toggle: Alt+Shift+P\n");

    let layer = read_omp(&home.path, None, None).unwrap();
    assert_eq!(layer.bindings["app.plan.toggle"], ["shift+alt+p"]);
    assert!(layer.inherited_path.is_none());
}

#[test]
fn missing_omp_config_yields_empty_layer() {
    let home = TmpHome::new();
    let layer = read_omp(&home.path, None, None).unwrap();
    assert_eq!(layer.bindings.len(), 0);
    assert!(layer.path.is_none());
    assert!(layer.inherited_path.is_none());
}

// ── layer-precedence proof (plan §Verification.2) ─────────────────────────────

#[test]
fn overlay_does_not_write_omp_file_and_payload_layers_correctly() {
    let home = TmpHome::new();
    let yml_content = "# comment\napp.plan.toggle: Alt+Shift+O\napp.model.select: []\n";
    home.write_omp_yml(yml_content);

    let store = home.overlay_store();
    store
        .set("app.plan.toggle", &["ctrl+shift+o".to_string()])
        .unwrap();

    let p = payload(&home.path, None, None, &store).unwrap();

    // omp layer reads the YAML as-is.
    assert_eq!(p.omp["app.plan.toggle"], ["shift+alt+o"]);
    assert_eq!(p.omp["app.model.select"], [] as [String; 0]);
    // Overlay layer has the new binding.
    assert_eq!(p.overlay["app.plan.toggle"], ["ctrl+shift+o"]);
    // omp_path points at the yml.
    assert!(p
        .omp_path
        .as_deref()
        .is_some_and(|path| path.ends_with("keybindings.yml")));

    // Re-read omp's file bytes: the overlay write must not have touched it.
    let yml_path = home.agent_dir().join("keybindings.yml");
    let after = fs::read_to_string(&yml_path).unwrap();
    assert_eq!(
        yml_content, after,
        "the omp config file must never be modified by the desktop"
    );
}

#[test]
fn corrupt_overlay_does_not_drop_omp_layer() {
    // A malformed overlay file must not take the omp layer down with it —
    // dispatch keeps working on omp + defaults, and the Shortcuts screen's
    // error banner (which promises exactly that) stays true.
    let home = TmpHome::new();
    home.write_omp_yml("app.plan.toggle: Alt+Shift+O\n");
    let store = home.overlay_store();
    fs::write(store.path(), b"not json").unwrap();

    let p = payload(&home.path, None, None, &store).unwrap();
    assert_eq!(p.omp["app.plan.toggle"], ["shift+alt+o"]);
    assert_eq!(p.overlay.len(), 0);
    assert!(p.overlay_error.is_some());
}

// ── ACTION_IDS ────────────────────────────────────────────────────────────────

#[test]
fn action_ids_are_unique() {
    let mut seen = std::collections::BTreeSet::new();
    for id in ACTION_IDS {
        assert!(seen.insert(*id), "duplicate ACTION_ID: {id}");
    }
}

#[test]
fn action_ids_match_keymap_js_registry() {
    // Real sync check, not a count pin: every `ACTION_IDS` entry must appear
    // as a `KEYMAP_ACTIONS` row (`id: "<id>"`) in the same repo's
    // `src/app/keymap.js`, and the number of `id: "` occurrences there must
    // equal `ACTION_IDS.len()` — so neither side can drift without the other
    // noticing (a stale count constant would stay green if both sides added
    // one differently-spelled id).
    //
    // Scoped to the `KEYMAP_ACTIONS = [ … ];` array body, not the whole
    // file: counting `id: "` anywhere in keymap.js would also catch a
    // future unrelated `id: "…"` literal (a doc-comment example, a second
    // table) and turn a harmless addition into a spurious count mismatch.
    let keymap_js = include_str!("../../../src/app/keymap.js");
    let start = keymap_js
        .find("const KEYMAP_ACTIONS = [")
        .expect("keymap.js must define `const KEYMAP_ACTIONS = [`");
    let body = &keymap_js[start..];
    let end = body
        .find("\n  ];")
        .expect("KEYMAP_ACTIONS array must close with `\\n  ];`");
    let registry = &body[..end];

    for id in ACTION_IDS {
        let needle = format!("id: \"{id}\"");
        assert!(
            registry.contains(&needle),
            "ACTION_IDS has {id:?} but keymap.js KEYMAP_ACTIONS does not"
        );
    }
    let row_count = registry.matches("id: \"").count();
    assert_eq!(
        row_count,
        ACTION_IDS.len(),
        "keymap.js KEYMAP_ACTIONS has {row_count} rows but ACTION_IDS has {} — one side has an id the other lacks",
        ACTION_IDS.len()
    );
}
