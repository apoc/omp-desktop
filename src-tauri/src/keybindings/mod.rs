//! Read omp's keybindings for a profile (read-only) and merge them with the
//! desktop-private overlay to produce the `Payload` the Shortcuts screen and
//! the keymap resolver both consume.
//!
//! # Layer precedence
//!
//! ```text
//! overlay (desktop writes) ▸ omp config (user's file, read-only) ▸ registry default
//! ```
//!
//! The frontend flattens this as `{ ...payload.omp, ...payload.overlay }` and
//! falls through to the registry's own `defaultKeys` when an action is absent
//! from both.
//!
//! # Profile merging (mirrors omp's `mergeKeybindingsConfig`)
//!
//! For a **named** profile, omp reads the built-in profile's file first, then
//! overrides action-by-action with the named profile's file. The desktop
//! mirrors that merge so the Shortcuts screen reflects what the tab's omp
//! process actually used.
//!
//! # No YAML dependency
//!
//! `Cargo.toml` carries no YAML crate. `keybindings.yml` / `.yaml` files are
//! parsed by the small flat-map reader in [`yaml`] (omp's format is a
//! documented flat `action: chord | [chords]` map). JSON overlay files are
//! handled by `serde_json`, which is already a dependency. Chord
//! canonicalisation (shared with the JSON overlay validator) lives in
//! [`chord`], not `yaml` — it isn't YAML parsing.

mod chord;
pub mod overlay;
mod yaml;

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// An action-id → chord-list map, the shape every layer (omp's config, the
/// desktop overlay, the merged `Payload` fields) reads and writes. Named so
/// `read_layer`'s `Result<(Option<PathBuf>, Bindings), String>` doesn't trip
/// clippy's `type_complexity` lint on the bare nested generic.
pub type Bindings = BTreeMap<String, Vec<String>>;

// ── registry ──────────────────────────────────────────────────────────────────

/// Every action id the desktop's keymap registry (`src/app/keymap.js`) exposes.
///
/// **This list must be kept in sync with `KEYMAP_ACTIONS` in `keymap.js`.**
/// `overlay::OverlayStore::set` rejects any id not in this slice; ids that
/// appear in omp's config but not here are read through to the frontend
/// unchanged — the frontend resolver simply ignores them.
pub const ACTION_IDS: &[&str] = &[
    "app.interrupt",
    "app.thinking.cycle",
    "app.model.cycleForward",
    "app.model.cycleBackward",
    "app.model.select",
    "app.plan.toggle",
    "app.message.followUp",
    "app.session.new",
    "app.session.resume",
    "desktop.commands.open",
    "desktop.history.open",
    "desktop.shortcuts.open",
    "desktop.tab.new",
    "desktop.tab.close",
    "desktop.tab.next",
    "desktop.tab.prev",
    "desktop.panel.todo",
    "desktop.panel.changes",
    "desktop.panel.rules",
    "desktop.panel.stats",
    "desktop.composer.promptHistory",
    "desktop.session.compact",
    "desktop.session.export",
    "desktop.update.check",
];

// ── public types ──────────────────────────────────────────────────────────────

/// The omp side of the keybinding read: the merged file contents plus the
/// paths actually read (for the Shortcuts screen footer and the layer-proof
/// test).
#[derive(Debug)]
pub struct OmpLayer {
    /// Action → chords from omp's profile-merged config. An empty `Vec` means
    /// omp has explicitly disabled that action.
    pub bindings: Bindings,
    /// The file that was read (named-profile's file, or built-in profile's
    /// file when no named profile was given). `None` when the file does not
    /// exist yet.
    pub path: Option<PathBuf>,
    /// The built-in profile's file merged underneath, when `profile` is named.
    /// `None` when the profile is the built-in one or when its file does not
    /// exist.
    pub inherited_path: Option<PathBuf>,
}

/// The full payload returned to the frontend (and produced by all three Tauri
/// commands).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Payload {
    /// From omp's read-only config (profile-merged). Empty vec = omp disabled it.
    pub omp: Bindings,
    /// Desktop overlay — the only layer this app writes. Empty (with
    /// `overlay_error` set) when the overlay file exists but could not be
    /// read — the omp layer above is still valid and dispatch keeps working
    /// on it plus the registry defaults.
    pub overlay: Bindings,
    /// Set when the overlay file is present but malformed/unreadable. The
    /// omp and default layers are unaffected; only overlay rebinds are
    /// unavailable until the file is fixed or deleted.
    pub overlay_error: Option<String>,
    /// omp file actually read; `None` when the user has no keybindings file.
    pub omp_path: Option<String>,
    /// Built-in profile's file merged underneath, when `profile` is named.
    pub inherited_path: Option<String>,
    /// `<app config dir>/keybindings.json` — always present as a path (the
    /// file itself may not exist yet).
    pub overlay_path: String,
}

// ── path helpers ──────────────────────────────────────────────────────────────

/// Probe `keybindings.yml`, then `keybindings.yaml`, then `keybindings.json`
/// — omp's own precedence order. Returns `None` when none of the three exist.
fn config_path(agent_dir: &Path) -> Option<PathBuf> {
    for name in ["keybindings.yml", "keybindings.yaml", "keybindings.json"] {
        let p = agent_dir.join(name);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

// ── reading ───────────────────────────────────────────────────────────────────

/// Legacy pre-namespace action names still found in an old `keybindings.yml`
/// written by omp before the namespaced-id migration, restricted to the
/// subset of `KEYBINDING_NAME_MIGRATIONS` (`app-keybindings.ts:253-319`)
/// that overlaps [`ACTION_IDS`] — the desktop has no namespace for the dozens
/// of TUI-editor-only legacy names and does not migrate those.
const LEGACY_ACTION_NAMES: &[(&str, &str)] = &[
    ("interrupt", "app.interrupt"),
    ("cycleThinkingLevel", "app.thinking.cycle"),
    ("cycleModelForward", "app.model.cycleForward"),
    ("cycleModelBackward", "app.model.cycleBackward"),
    ("selectModel", "app.model.select"),
    ("togglePlanMode", "app.plan.toggle"),
    ("followUp", "app.message.followUp"),
    ("newSession", "app.session.new"),
    ("resume", "app.session.resume"),
];

/// Rewrite any [`LEGACY_ACTION_NAMES`] key to its namespaced id, mirroring
/// omp's own `migrateKeybindingNames` (`app-keybindings.ts:350-370`) so a
/// pre-migration file still resolves against the desktop's namespaced
/// registry instead of being silently ignored.
///
/// omp's migration picks a winner by file order when both the legacy and
/// namespaced spelling of the same action are present ("last wins"); that
/// order is already lost once a `BTreeMap` has collected the raw entries, so
/// a namespaced entry always wins over a legacy alias here instead — the
/// deterministic, conservative choice for a case omp itself treats as
/// unusual (a file straddling both naming schemes for one action).
fn migrate_legacy_names(raw_map: Bindings) -> Bindings {
    let mut migrated = Bindings::new();
    let mut legacy_pending = Bindings::new();
    for (key, chords) in raw_map {
        match LEGACY_ACTION_NAMES.iter().find(|(old, _)| key == *old) {
            Some((_, new_key)) => {
                legacy_pending.insert((*new_key).to_string(), chords);
            }
            None => {
                migrated.insert(key, chords);
            }
        }
    }
    for (key, chords) in legacy_pending {
        migrated.entry(key).or_insert(chords);
    }
    migrated
}

/// Read one keybinding file (any of `.yml`, `.yaml`, `.json`). Chords are
/// canonicalised via [`chord::canonical_chord`]; action ids are kept verbatim.
///
/// `NotFound` ⇒ empty map. A genuine IO error (permissions, …) ⇒ `Err`.
/// Malformed or non-object JSON degrades to an empty map with a logged
/// warning, mirroring omp's `loadRawConfig` (`app-keybindings.ts:409-425`),
/// which JSONC-parses and falls back to `{}` on any failure rather than
/// treating the whole tab as broken — a legacy `keybindings.json` with a
/// `//` comment is valid JSONC but not valid JSON.
fn read_file(path: &Path) -> Result<Bindings, String> {
    let raw = match std::fs::read_to_string(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(e) => return Err(e.to_string()),
        Ok(s) => s,
    };
    // A BOM-prefixed file (common from Windows editors) would otherwise merge
    // into the first key, failing its `[A-Za-z0-9._-]` check and silently
    // dropping that binding.
    let content = raw.strip_prefix('\u{feff}').unwrap_or(&raw);

    let raw_map = if path.extension().and_then(OsStr::to_str) == Some("json") {
        // JSON keybindings: `{ action: string | string[] }`.
        if let Ok(serde_json::Value::Object(obj)) =
            serde_json::from_str::<serde_json::Value>(content)
        {
            let mut map = BTreeMap::new();
            for (k, v) in obj {
                // Non-conforming values are skipped (matching omp's
                // `toKeybindingsConfig`, which requires every array element
                // to be a string — a mixed array like `[1]` or
                // `["ctrl+x", null]` is dropped, not partially accepted).
                let chords: Vec<String> = match v {
                    serde_json::Value::String(s) => vec![s],
                    serde_json::Value::Array(arr) => match arr
                        .into_iter()
                        .map(|v| match v {
                            serde_json::Value::String(s) => Ok(s),
                            _ => Err(()),
                        })
                        .collect::<Result<Vec<_>, _>>()
                    {
                        Ok(strings) => strings,
                        Err(()) => continue,
                    },
                    _ => continue,
                };
                map.insert(k, chords);
            }
            map
        } else {
            // Malformed or non-object JSON degrades to an empty map, matching
            // omp's own tolerance for a bad config file (see the doc comment
            // above).
            eprintln!(
                "[omp-desktop] keybindings: ignoring malformed config at {}",
                path.display()
            );
            BTreeMap::new()
        }
    } else {
        yaml::parse(content)
    };
    let raw_map = migrate_legacy_names(raw_map);

    // Canonicalise all chords in a single pass, regardless of source format.
    Ok(raw_map
        .into_iter()
        .map(|(id, chords)| {
            (
                id,
                chords
                    .into_iter()
                    .map(|c| chord::canonical_chord(&c))
                    .filter(|c| !c.is_empty())
                    .collect(),
            )
        })
        .collect())
}

/// Read omp's keybindings for a profile, applying the same merge omp itself
/// uses: built-in profile's file first, then named profile's file on top
/// action-by-action.
pub fn read_omp(
    home: &Path,
    profile: Option<&str>,
    env_dir: Option<&OsStr>,
) -> Result<OmpLayer, String> {
    // Normalise exactly as `saved_sessions::sessions_root_for` does: `Some("")`
    // is treated as the built-in profile, not as a named one.
    let profile = profile.filter(|id| !id.is_empty());

    // For the built-in profile there is only one file.
    if profile.is_none() {
        let (path, bindings) = read_layer(&crate::profiles::agent_dir_for(home, None, env_dir))?;
        return Ok(OmpLayer {
            bindings,
            path,
            inherited_path: None,
        });
    }

    // Named profile: read the built-in file first, then override with the
    // named profile's file — exactly `mergeKeybindingsConfig` in omp.
    //
    // The built-in base is always `~/.omp/agent`, regardless of
    // `PI_CODING_AGENT_DIR`. omp's own `resolveInheritedAgentDir`
    // (`app-keybindings.ts:467-473`) calls `getBaseConfigRoot()` with no env
    // override; honouring the var for the base would show bindings from a
    // different directory than the tab's omp process actually merged from.
    let (base_path, base) = read_layer(&crate::profiles::agent_dir(home, None))?;
    let (named_path, named) = read_layer(&crate::profiles::agent_dir_for(home, profile, env_dir))?;

    // named overrides base action-by-action.
    let mut bindings = base;
    bindings.extend(named);

    Ok(OmpLayer {
        bindings,
        path: named_path,
        inherited_path: base_path,
    })
}

/// Probe `dir` for a keybindings file and read it in one step — the
/// `config_path` + `read_file` pair [`read_omp`] chains three times (built-in
/// profile, inherited base, named profile). `None` path ⇒ empty map, same as
/// each of those three call sites used to spell out individually.
fn read_layer(dir: &Path) -> Result<(Option<PathBuf>, Bindings), String> {
    let path = config_path(dir);
    let bindings = path
        .as_deref()
        .map(read_file)
        .transpose()?
        .unwrap_or_default();
    Ok((path, bindings))
}

// ── payload builder ───────────────────────────────────────────────────────────

/// Assemble the `Payload` struct shared by [`payload`] and
/// [`payload_with_overlay`] — the only place the field list is written out.
fn assemble_payload(
    omp_layer: OmpLayer,
    overlay: Bindings,
    overlay_error: Option<String>,
    overlay_path: &Path,
) -> Payload {
    Payload {
        omp: omp_layer.bindings,
        overlay,
        overlay_error,
        omp_path: omp_layer.path.map(|p| p.to_string_lossy().into_owned()),
        inherited_path: omp_layer
            .inherited_path
            .map(|p| p.to_string_lossy().into_owned()),
        overlay_path: overlay_path.to_string_lossy().into_owned(),
    }
}

/// Build the full `Payload` for the frontend — one read of the omp layer and
/// one of the overlay.
///
/// A malformed/unreadable overlay does **not** fail the whole payload: the
/// omp layer is still valid and the frontend can keep dispatching on it plus
/// the registry defaults, which is what the Shortcuts screen's error banner
/// promises. The overlay's read error is surfaced via `overlay_error`
/// instead of propagating out of this function.
pub fn payload(
    home: &Path,
    profile: Option<&str>,
    env_dir: Option<&OsStr>,
    store: &overlay::OverlayStore,
) -> Result<Payload, String> {
    let omp_layer = read_omp(home, profile, env_dir)?;
    let (overlay, overlay_error) = match store.read() {
        Ok(bindings) => (bindings, None),
        Err(e) => (BTreeMap::new(), Some(e)),
    };
    Ok(assemble_payload(
        omp_layer,
        overlay,
        overlay_error,
        store.path(),
    ))
}

/// Like [`payload`] but accepts a pre-computed overlay map — avoids a second
/// filesystem read when the caller already holds the freshly-written overlay
/// (e.g. `keybindings_set`/`keybindings_reset` get the updated map back from
/// `OverlayStore::set`/`remove` and can pass it directly). The overlay read
/// already succeeded to produce `overlay_bindings`, so `overlay_error` is
/// always `None` here.
pub fn payload_with_overlay(
    home: &Path,
    profile: Option<&str>,
    env_dir: Option<&OsStr>,
    overlay_bindings: Bindings,
    overlay_path: &Path,
) -> Result<Payload, String> {
    let omp_layer = read_omp(home, profile, env_dir)?;
    Ok(assemble_payload(
        omp_layer,
        overlay_bindings,
        None,
        overlay_path,
    ))
}
