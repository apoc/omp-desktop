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
                items.push(item);
                i += 1;
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
    Some((key, line[colon + 1..].trim()))
}

/// `  - ctrl+a` → `ctrl+a`. `None` ends the block sequence.
fn block_item(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    if trimmed.len() == line.len() && !trimmed.starts_with('-') {
        // Unindented non-item: the next entry, not part of this sequence.
        return None;
    }
    let rest = trimmed.strip_prefix("- ")?.trim();
    Some(if rest.starts_with('"') || rest.starts_with('\'') {
        unquote(rest)
    } else {
        plain_scalar(rest)
    })
}

/// Items of a flow sequence, given everything after the opening `[`.
/// Commas inside quotes do not split.
fn flow_items(rest: &str) -> Vec<String> {
    let body = rest.rfind(']').map_or(rest, |end| &rest[..end]);
    let mut items = Vec::new();
    let mut start = 0;
    let mut quote = None;
    for (idx, ch) in body.char_indices() {
        match (quote, ch) {
            (None, '"' | '\'') => quote = Some(ch),
            (Some(q), c) if c == q => quote = None,
            (None, ',') => {
                items.push(&body[start..idx]);
                start = idx + 1;
            }
            _ => {}
        }
    }
    items.push(&body[start..]);
    items
        .into_iter()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            if s.starts_with('"') || s.starts_with('\'') {
                unquote(s)
            } else {
                plain_scalar(s)
            }
        })
        .collect()
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

/// Port of omp's `canonicalKeyId` (`packages/tui/src/keybindings.ts`).
///
/// Modifiers are recognised case-insensitively in any order and re-emitted in
/// omp's canonical `ctrl, shift, alt, super` order; the base key is
/// lowercased, `esc`/`return` are aliased to `escape`/`enter`, and a bare
/// uppercase ASCII letter implies `shift` (`"P"` == `"shift+p"`).
///
/// Returns an empty string when there is no base key (`"ctrl+"`, `""`), which
/// callers treat as an invalid chord.
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
                // The matched prefix is ASCII, so this split is on a char
                // boundary even when the base key is not.
                rest = rest[prefix.len()..].trim_start();
                continue 'strip;
            }
        }
        break;
    }
    let base = rest.trim();
    // A bare uppercase ASCII letter with NO other modifiers implies shift:
    // `"P"` → `"shift+p"`, but `"Ctrl+P"` → `"ctrl+p"` (modifier already
    // present; the uppercase is just how the user typed it).
    if base.len() == 1 && base.as_bytes()[0].is_ascii_uppercase() && !flags.iter().any(|&f| f) {
        flags[1] = true;
    }
    let base = match base.to_ascii_lowercase().as_str() {
        "esc" => "escape".to_string(),
        "return" => "enter".to_string(),
        other => other.to_string(),
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
    out.push_str(&base);
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
