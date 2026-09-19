//! Chord canonicaliser shared by the YAML reader ([`super::yaml`]), the JSON
//! overlay validator ([`super::overlay`]), and (via its JS twin,
//! `src/app/keymap.js`'s `canonicalChord`) the frontend keymap resolver.
//!
//! Split out of `yaml.rs` because this is chord algebra, not YAML parsing —
//! `overlay.rs` importing it from `yaml` would wrongly imply the JSON overlay
//! depends on the YAML reader.

/// Chord canonicaliser shared by the YAML reader and the overlay validator.
///
/// Modifiers are recognised case-insensitively in any order and re-emitted in
/// omp's canonical `ctrl, shift, alt, super` order; the base key is
/// lowercased; `esc`→`escape`, `return`→`enter`.
///
/// **Matches omp's `canonicalKeyId` exactly for config-sourced chords.**
/// `canonicalKeyId` (`keybindings.ts:190-220`) does infer `shift` for a bare
/// uppercase ASCII base letter (`Ctrl+P` → `ctrl+shift+p`) — but only when
/// called on *live parsed terminal input* (`KeybindingsManager.matches`,
/// line 296). A config value never reaches it in that form:
/// `KeybindingsManager.#rebuild` runs every `keybindings.yml`/user-config
/// chord through `normalizeKeys` (`keybindings.ts:232-245`, `key.toLowerCase()`)
/// *before* `addKeyAliases`/`canonicalKeyId` ever sees it, so the uppercase
/// base a config file might spell is already gone by the time the
/// shift-inference check would run. `app.model.select: P` and
/// `app.model.select: p` are therefore identical to omp — this reader must
/// not infer shift from either.
///
/// Returns an empty string when there is no base key (`"ctrl+"`, `""`);
/// callers treat an empty return as an invalid chord.
pub fn canonical_chord(raw: &str) -> String {
    const MODIFIERS: [&str; 4] = ["ctrl+", "shift+", "alt+", "super+"];
    let mut rest = raw.trim();
    let mut flags = [false; 4];
    'strip: loop {
        for (idx, prefix) in MODIFIERS.iter().enumerate() {
            if rest
                .as_bytes()
                .get(..prefix.len())
                .is_some_and(|head| head.eq_ignore_ascii_case(prefix.as_bytes()))
            {
                flags[idx] = true;
                rest = rest[prefix.len()..].trim_start();
                continue 'strip;
            }
        }
        break;
    }
    // Lower-case base; resolve aliases in a single match on the lowercase str.
    // No shift-inference here — see the doc comment above.
    let lower = rest.trim().to_lowercase();
    let base: &str = match lower.as_str() {
        "esc" => "escape",
        "return" => "enter",
        other => other,
    };
    if base.is_empty() {
        return String::new();
    }
    let mut out = String::with_capacity(base.len() + 16);
    for (idx, prefix) in MODIFIERS.iter().enumerate() {
        if flags[idx] {
            out.push_str(prefix);
        }
    }
    out.push_str(base);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_chord_matches_omp_ordering_and_aliases() {
        assert_eq!(canonical_chord("Alt+Shift+P"), "shift+alt+p");
        assert_eq!(canonical_chord("Ctrl+P"), "ctrl+p");
        // No shift-inference from a bare uppercase base: omp lowercases
        // config values before canonicalising (see the doc comment above),
        // so `P` and `p` must canonicalise identically here too.
        assert_eq!(canonical_chord("P"), "p");
        assert_eq!(canonical_chord("p"), "p");
        assert_eq!(canonical_chord("Esc"), "escape");
        assert_eq!(canonical_chord("Return"), "enter");
        assert_eq!(canonical_chord("CTRL+ALT+]"), "ctrl+alt+]");
        assert_eq!(canonical_chord("super+K"), "super+k");
        assert_eq!(canonical_chord("  ctrl+  Tab "), "ctrl+tab");
    }

    #[test]
    fn canonical_chord_rejects_a_missing_base() {
        assert_eq!(canonical_chord("ctrl+"), "");
        assert_eq!(canonical_chord("   "), "");
    }
}
