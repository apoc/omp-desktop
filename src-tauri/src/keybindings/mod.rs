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
//! handled by `serde_json`, which is already a dependency.

pub mod overlay;
pub mod yaml;

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

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
    "desktop.session.compact",
    "desktop.session.export",
];

// ── public types ──────────────────────────────────────────────────────────────

/// The omp side of the keybinding read: the merged file contents plus the
/// paths actually read (for the Shortcuts screen footer and the layer-proof
/// test).
#[derive(Debug)]
pub struct OmpLayer {
    /// Action → chords from omp's profile-merged config. An empty `Vec` means
    /// omp has explicitly disabled that action.
    pub bindings: BTreeMap<String, Vec<String>>,
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
    pub omp: BTreeMap<String, Vec<String>>,
    /// Desktop overlay — the only layer this app writes.
    pub overlay: BTreeMap<String, Vec<String>>,
    /// omp file actually read; `None` when the user has no keybindings file.
    pub omp_path: Option<String>,
    /// Built-in profile's file merged underneath, when `profile` is named.
    pub inherited_path: Option<String>,
    /// `<app config dir>/keybindings.json` — always present as a path (the
    /// file itself may not exist yet).
    pub overlay_path: String,
}

// ── path helpers ──────────────────────────────────────────────────────────────

/// Resolve the omp agent directory from already-gathered inputs.
///
/// Mirrors `saved_sessions::sessions_root_for` exactly — same
/// `PI_CODING_AGENT_DIR`-only-for-built-in gate and `filter(|id| !id.is_empty())`
/// guard. Both must agree; diverging them silently points at the wrong tree.
pub fn agent_dir_for(home: &Path, profile: Option<&str>, env_dir: Option<&OsStr>) -> PathBuf {
    // Same defence-in-depth as `saved_sessions::sessions_root_for`: `Some("")`
    // must not sneak past the `is_none()` gate.
    let profile = profile.filter(|id| !id.is_empty());
    if profile.is_none() {
        if let Some(dir) = env_dir.filter(|d| !d.is_empty()) {
            return PathBuf::from(dir);
        }
    }
    crate::profiles::agent_dir(home, profile)
}

/// Probe `keybindings.yml`, then `keybindings.yaml`, then `keybindings.json`
/// — omp's own precedence order. Returns `None` when none of the three exist.
pub fn config_path(agent_dir: &Path) -> Option<PathBuf> {
    for name in ["keybindings.yml", "keybindings.yaml", "keybindings.json"] {
        let p = agent_dir.join(name);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

// ── reading ───────────────────────────────────────────────────────────────────

/// Read one keybinding file (any of `.yml`, `.yaml`, `.json`). Chords are
/// canonicalised via [`yaml::canonical_chord`]; action ids are kept verbatim.
///
/// `NotFound` ⇒ empty map. Any other IO error ⇒ `Err`.
pub fn read_file(path: &Path) -> Result<BTreeMap<String, Vec<String>>, String> {
    let raw = match std::fs::read_to_string(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(e) => return Err(e.to_string()),
        Ok(s) => s,
    };

    let raw_map = if path.extension().and_then(OsStr::to_str) == Some("json") {
        // The JSON overlay format uses an object of `{ action: string | string[] }`.
        // For omp's own JSON config (rarely used but supported) we accept the
        // same shape and canonicalise below.
        let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let obj = v
            .as_object()
            .ok_or_else(|| "keybindings JSON must be an object".to_string())?;
        let mut map = BTreeMap::new();
        for (k, v) in obj {
            let chords: Vec<String> = match v {
                serde_json::Value::String(s) => vec![s.clone()],
                serde_json::Value::Array(arr) => arr
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect(),
                _ => continue,
            };
            map.insert(k.clone(), chords);
        }
        map
    } else {
        yaml::parse(&raw)
    };

    // Canonicalise all chords in a single pass, regardless of source format.
    Ok(raw_map
        .into_iter()
        .map(|(id, chords)| {
            (
                id,
                chords
                    .into_iter()
                    .map(|c| yaml::canonical_chord(&c))
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
        let dir = agent_dir_for(home, None, env_dir);
        let path = config_path(&dir);
        let bindings = path
            .as_deref()
            .map(read_file)
            .transpose()?
            .unwrap_or_default();
        return Ok(OmpLayer {
            bindings,
            path,
            inherited_path: None,
        });
    }

    // Named profile: read the built-in file first, then override with the
    // named profile's file — exactly `mergeKeybindingsConfig` in omp.
    let base_dir = agent_dir_for(home, None, env_dir);
    let base_path = config_path(&base_dir);
    let base: BTreeMap<String, Vec<String>> = base_path
        .as_deref()
        .map(read_file)
        .transpose()?
        .unwrap_or_default();

    let named_dir = agent_dir_for(home, profile, env_dir);
    let named_path = config_path(&named_dir);
    let named: BTreeMap<String, Vec<String>> = named_path
        .as_deref()
        .map(read_file)
        .transpose()?
        .unwrap_or_default();

    // named overrides base action-by-action.
    let mut bindings = base;
    for (k, v) in named {
        bindings.insert(k, v);
    }

    Ok(OmpLayer {
        bindings,
        path: named_path,
        inherited_path: base_path,
    })
}

// ── payload builder ───────────────────────────────────────────────────────────

/// Build the full `Payload` for the frontend — one read of the omp layer and
/// one of the overlay.
pub fn payload(
    home: &Path,
    profile: Option<&str>,
    env_dir: Option<&OsStr>,
    store: &overlay::OverlayStore,
) -> Result<Payload, String> {
    let omp_layer = read_omp(home, profile, env_dir)?;
    let overlay_bindings = store.read()?;
    Ok(Payload {
        omp: omp_layer.bindings,
        overlay: overlay_bindings,
        omp_path: omp_layer.path.and_then(|p| p.to_str().map(str::to_owned)),
        inherited_path: omp_layer
            .inherited_path
            .and_then(|p| p.to_str().map(str::to_owned)),
        overlay_path: store.path().to_str().map(str::to_owned).unwrap_or_default(),
    })
}
