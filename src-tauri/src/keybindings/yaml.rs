//! A deliberately narrow reader for omp's `keybindings.yml`, plus the chord
//! canonicaliser both layers share.
//!
//! This is **not** a YAML library and must not grow into one. `Cargo.toml`
//! carries no YAML crate, the file this parses is documented as a flat
//! `action: chord | [chords]` map (`oh-my-pi/docs/keybindings.md`), and the
//! desktop never writes it — only parsing is needed. Anything the grammar
//! below does not recognise (nested maps, anchors, multi-line scalars,
//! documents) is ignored line by line: the Shortcuts screen then simply
//! reports no omp binding for that action, which is a visible, harmless
//! degradation rather than a parse failure that would hide every *other*
//! binding in the file.

use std::collections::BTreeMap;

/// Parse a flat `action: value` map. Values are returned **verbatim**
/// (trimmed and unquoted, but not canonicalised) — `super::read_file` runs
/// [`canonical_chord`] over them so the JSON and YAML paths canonicalise in
/// exactly one place.
///
/// An entry whose value is an empty sequence (`[]`, or a key with no value
/// and no `- ` items under it) yields an empty `Vec`, which is omp's
/// "explicitly disabled" state — distinct from an absent key.
///
/// Duplicate keys: the last occurrence wins.
pub fn parse(content: &str) -> BTreeMap<String, Vec<String>> {
    let lines: Vec<&str> = content.lines().collect();
    let mut out = BTreeMap::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        i += 1;
        let Some((key, value)) = entry(line) else {
            continue;
        };
        let values = if value.is_empty() {
            let mut items = Vec::new();
            while let Some(item) = lines.get(i).and_then(|l| block_item(l)) {
                i += 1;
                // block_item returns "" as a sentinel for blank/comment lines
                // that should be skipped but not terminate the sequence.
                if !item.is_empty() {
                    items.push(item);
                }
            }
            items
        } else if let Some(rest) = value.strip_prefix('[') {
            flow_items(rest)
        } else if value.starts_with('"') || value.starts_with('\'') {
            vec![unquote(value)]
        } else {
            let scalar = plain_scalar(value);
            if scalar.is_empty() {
                Vec::new()
            } else {
                vec![scalar]
            }
        };
        out.insert(key.to_string(), values);
    }
    out
}

/// Split an unindented, uncommented `key: value` line. `None` for anything
/// else — indentation is what separates a top-level entry from the body of a
/// construct this parser does not understand.
fn entry(line: &str) -> Option<(&str, &str)> {
    let first = line.chars().next()?;
    if first.is_whitespace() || first == '#' {
        return None;
    }
    let colon = line.find(':')?;
    let key = &line[..colon];
    if key.is_empty()
        || !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return None;
    }
    let value = line[colon + 1..].trim();
    // A value that starts with `#` after trimming is a YAML comment — the
    // entry has no value (e.g. `app.session.new: # unbound`). Treat as empty
    // so it behaves the same as `app.session.new:` (falls through to the
    // registry default), not as a bogus chord `# unbound`.
    let value = if value.starts_with('#') { "" } else { value };
    Some((key, value))
}

/// `  - ctrl+a` → `ctrl+a`. `None` terminates the block sequence.
///
/// Blank and comment-only indented lines are skipped rather than ending the
/// sequence, so `app.model.select:\n  # primary\n  - alt+m` correctly
/// yields `["alt+m"]` instead of `[]` (explicitly disabled).
fn block_item(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    // An unindented line that is not blank is the next top-level entry.
    if !line.starts_with(|c: char| c.is_whitespace()) && !line.is_empty() {
        return None;
    }
    // Blank line inside the block — skip, don't terminate.
    if trimmed.is_empty() {
        return Some(String::new()); // sentinel: caller discards empty strings
    }
    // Comment-only line inside the block — skip.
    if trimmed.starts_with('#') {
        return Some(String::new()); // sentinel
    }
    // Require the `- ` item prefix; anything else terminates (e.g. a nested map).
    let rest = trimmed.strip_prefix("- ")?.trim();
    Some(if rest.starts_with('"') || rest.starts_with('\'') {
        unquote(rest)
    } else {
        plain_scalar(rest)
    })
}

/// Items of a flow sequence, given everything after the opening `[`.
///
/// Commas inside quotes do not split. Backslash-escapes inside double-quoted
/// items are tracked so that `"ctrl+\"` does not look like a closing quote,
/// matching the same logic in `unquote`.
fn flow_items(rest: &str) -> Vec<String> {
    let body = rest.rfind(']').map_or(rest, |end| &rest[..end]);
    let mut out = Vec::new();
    let mut start = 0;
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for (idx, ch) in body.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match (quote, ch) {
            (Some('"'), '\\') => escaped = true,
            (None, '"' | '\'') => quote = Some(ch),
            (Some(q), c) if c == q => quote = None,
            (None, ',') => {
                let raw = body[start..idx].trim();
                if !raw.is_empty() {
                    out.push(if raw.starts_with('"') || raw.starts_with('\'') {
                        unquote(raw)
                    } else {
                        plain_scalar(raw)
                    });
                }
                start = idx + 1;
            }
            _ => {}
        }
    }
    let raw = body[start..].trim();
    if !raw.is_empty() {
        out.push(if raw.starts_with('"') || raw.starts_with('\'') {
            unquote(raw)
        } else {
            plain_scalar(raw)
        });
    }
    out
}

/// A quoted scalar with its quotes removed. Escapes are honoured inside
/// double quotes only, matching YAML.
///
/// When the value has trailing content after the closing quote (e.g.
/// `"ctrl+q" # comment`) only the content inside the quotes is returned.
fn unquote(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.is_empty() {
        return String::new();
    }
    let quote = bytes[0] as char;
    // Scan from position 1 for the matching closing quote.  For double
    // quotes, honour `\"` escapes so an escaped quote isn't mistaken for
    // the closer.
    let mut close = None;
    let mut i = 1usize;
    while i < bytes.len() {
        if quote == '"' && bytes[i] == b'\\' {
            i += 2; // skip the escaped character
            continue;
        }
        if bytes[i] as char == quote {
            close = Some(i);
            break;
        }
        i += 1;
    }
    let body = close.map_or_else(|| &value[1..], |end| &value[1..end]);
    if quote != '"' {
        return body.to_string();
    }
    let mut out = String::with_capacity(body.len());
    let mut escaped = false;
    for ch in body.chars() {
        if escaped {
            out.push(ch);
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else {
            out.push(ch);
        }
    }
    out
}

/// An unquoted scalar: everything before the first ` #` comment, trimmed.
/// A `#` with no leading space is part of the value (chords such as `ctrl+#`).
fn plain_scalar(value: &str) -> String {
    value
        .find(" #")
        .map_or(value, |at| &value[..at])
        .trim()
        .to_string()
}

/// Chord canonicaliser shared by the YAML reader and the overlay validator.
///
/// Modifiers are recognised case-insensitively in any order and re-emitted in
/// omp's canonical `ctrl, shift, alt, super` order; the base key is
/// lowercased; `esc`→`escape`, `return`→`enter`.
///
/// **Deliberate deviation from omp's `canonicalKeyId`:** omp infers `shift`
/// for any single uppercase ASCII base letter when `shift` is not already
/// among the modifiers — so `Ctrl+P` → `ctrl+shift+p` in the TUI. The
/// desktop applies this inference only when **no** modifier is present at
/// all, giving `Ctrl+P` → `ctrl+p`. The consequence: a `keybindings.yml`
/// entry spelled `app.model.cycleForward: Ctrl+P` maps to the `ctrl+shift+p`
/// chord in the TUI but to `ctrl+p` in the desktop dispatcher. Users who
/// write chords without a modifier (`P: ...`) get identical behaviour in both;
/// users who write `Ctrl+UppercaseLetter` do not. This is intentional: the
/// desktop's default registry uses all-lowercase chord spellings, and the
/// shift-on-modifier path would silently merge `ctrl+p` (cycleForward) and
/// `ctrl+shift+p` (cycleBackward), creating a permanent conflict.
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
    let base_raw = rest.trim();
    if base_raw.len() == 1
        && base_raw.as_bytes()[0].is_ascii_uppercase()
        && !flags.iter().any(|&f| f)
    {
        flags[1] = true;
    }
    // Lower-case base; resolve aliases in a single match on the lowercase str.
    let lower = base_raw.to_ascii_lowercase();
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

    fn keys(map: &BTreeMap<String, Vec<String>>, key: &str) -> Vec<String> {
        map.get(key).cloned().unwrap_or_default()
    }

    #[test]
    fn parses_scalar_flow_and_block_values() {
        let map = parse(
            "# leading comment\n\
             app.plan.toggle: Alt+Shift+P\n\
             app.message.followUp: [ctrl+q, \"ctrl+enter\"]\n\
             app.model.select:\n  - alt+m\n  - alt+n\n\
             app.interrupt: []\n",
        );
        assert_eq!(keys(&map, "app.plan.toggle"), ["Alt+Shift+P"]);
        assert_eq!(keys(&map, "app.message.followUp"), ["ctrl+q", "ctrl+enter"]);
        assert_eq!(keys(&map, "app.model.select"), ["alt+m", "alt+n"]);
        // `[]` is present-but-empty: omp's explicit "disabled".
        assert!(map.contains_key("app.interrupt"));
        assert_eq!(keys(&map, "app.interrupt"), [] as [&str; 0]);
    }

    #[test]
    fn comment_only_and_unsupported_lines_are_ignored() {
        let map =
            parse("---\n# just a comment\nnested:\n  child:\n    deep: x\napp.exit: ctrl+c\n");
        assert_eq!(keys(&map, "app.exit"), ["ctrl+c"]);
        // `nested:` is an entry with an empty value and no `- ` items, so it
        // reads as "disabled"; its indented body never becomes a binding.
        assert_eq!(keys(&map, "nested"), [] as [&str; 0]);
        assert!(!map.contains_key("child"));
        assert!(!map.contains_key("deep"));
    }

    #[test]
    fn hash_inside_a_chord_survives_but_a_trailing_comment_does_not() {
        let map =
            parse("a.b: ctrl+# \n c.d: x\napp.x: \"ctrl+q\" # why not\napp.y: ctrl+g # nope\n");
        assert_eq!(keys(&map, "a.b"), ["ctrl+#"]);
        assert_eq!(keys(&map, "app.x"), ["ctrl+q"]);
        assert_eq!(keys(&map, "app.y"), ["ctrl+g"]);
    }

    #[test]
    fn duplicate_keys_last_wins() {
        let map = parse("app.plan.toggle: ctrl+a\napp.plan.toggle: ctrl+b\n");
        assert_eq!(keys(&map, "app.plan.toggle"), ["ctrl+b"]);
    }

    #[test]
    fn flow_sequence_keeps_commas_inside_quotes() {
        let map = parse("app.x: [\"ctrl+,\", alt+k]\n");
        assert_eq!(keys(&map, "app.x"), ["ctrl+,", "alt+k"]);
    }

    #[test]
    fn canonical_chord_matches_omp_ordering_and_aliases() {
        assert_eq!(canonical_chord("Alt+Shift+P"), "shift+alt+p");
        assert_eq!(canonical_chord("Ctrl+P"), "ctrl+p");
        assert_eq!(canonical_chord("P"), "shift+p");
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
