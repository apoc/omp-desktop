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
/// # Null is absent, `[]` is disabled
///
/// An entry whose value is an **empty sequence** — `[]` inline, or `[]` on
/// the indented line below the key, which is the shape Bun's YAML writer
/// emits — yields an empty `Vec`: omp's "explicitly disabled" state.
///
/// An entry whose value is **YAML null** — a bare `key:`, `key: # comment`,
/// `key: null` or `key: ~` — is left out of the map entirely. omp's
/// `toKeybindingsConfig` (`app-keybindings.ts:333-343`) skips a null value,
/// so the action keeps its default there; recording it as `[]` here would
/// disable the action in the desktop while the TUI still honoured it.
///
/// Duplicate keys: the last occurrence wins.
pub fn parse(content: &str) -> BTreeMap<String, Vec<String>> {
    let mut out = BTreeMap::new();
    let mut it = content.lines().peekable();
    while let Some(line) = it.next() {
        let Some((key, value)) = entry(line) else {
            continue;
        };
        let values = if value.is_empty() {
            let mut items = Vec::new();
            loop {
                match it.peek().map(|l| block_item(l)) {
                    Some(BlockLine::Item(s)) => {
                        items.push(s);
                        it.next();
                    }
                    Some(BlockLine::Skip) => {
                        it.next();
                    }
                    Some(BlockLine::End) | None => break,
                }
            }
            if items.is_empty() {
                // No `- ` items. Either an indented flow sequence — `key:`
                // followed by `  []`, an explicit disable — or YAML null,
                // which means *absent* (see the null-vs-`[]` note above).
                match it.peek().and_then(|l| indented_flow(l)) {
                    Some(flow) => {
                        it.next();
                        flow
                    }
                    None => continue,
                }
            } else {
                items
            }
        } else if let Some(rest) = value.strip_prefix('[') {
            flow_items(rest)
        } else if is_quoted(value) {
            // Quoted, so a literal `"null"` stays a (nonsensical but honest)
            // chord rather than being read as YAML null.
            vec![unquote(value)]
        } else {
            let s = plain_scalar(value);
            if s.is_empty() || s == "~" || s.eq_ignore_ascii_case("null") {
                continue;
            }
            vec![s]
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
    // entry has YAML null as its value (e.g. `app.session.new: # unbound`).
    // Reported as empty here and skipped by `parse`, so the action falls
    // through to omp's config-less default rather than being disabled.
    let value = if value.starts_with('#') { "" } else { value };
    Some((key, value))
}

/// The three outcomes of examining one line while scanning a block sequence.
/// An explicit enum instead of `Option<String>` + an empty-string sentinel:
/// "this line isn't part of the sequence at all" (`End`) and "it's part of
/// the sequence but contributes no item" (`Skip`, blank/comment) are
/// different things a caller must not conflate.
enum BlockLine {
    /// A `- item` line.
    Item(String),
    /// Blank or comment-only line inside the block — skip, don't terminate.
    Skip,
    /// Anything else: the sequence is over (a `- `-item at any indentation
    /// wasn't found, and it isn't blank/comment either).
    End,
}

/// Classify one line while scanning a block sequence begun by a `key:` with
/// an empty inline value.
fn block_item(line: &str) -> BlockLine {
    let trimmed = line.trim_start();
    // A `- ` item belongs to the sequence at *any* indentation, column 0
    // included — that is the sequence-at-parent-indentation style `js-yaml`
    // emits by default and hand-written files commonly use. There is no
    // ambiguity with a top-level entry: `entry` requires a `:` and a key of
    // `[A-Za-z0-9._-]`, which `- alt+m` cannot satisfy.
    if let Some(rest) = trimmed.strip_prefix("- ") {
        return BlockLine::Item(scalar(rest.trim()));
    }
    // Blank or comment-only line — at *any* indentation, column 0 included,
    // same reasoning as `- ` above. Checked before the "next top-level
    // entry" test below: a column-0 `# comment` between two `- ` items must
    // not be mistaken for the next entry and terminate the sequence early.
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return BlockLine::Skip;
    }
    // Anything else — an unindented non-comment line (the next top-level
    // entry) or an indented one (a nested map this parser doesn't
    // understand) — ends the sequence.
    BlockLine::End
}

/// An indented flow sequence on the line after a key with no inline value:
/// `app.model.select:\n  []`. This is what Bun's YAML writer emits for a
/// disabled action, so it must read as an empty `Vec` (disabled) and not as
/// the null that a bare `key:` means.
fn indented_flow(line: &str) -> Option<Vec<String>> {
    if !line.starts_with(|c: char| c.is_whitespace()) {
        return None;
    }
    let rest = line.trim_start().strip_prefix('[')?;
    Some(flow_items(rest))
}

/// One scalar item of a sequence: quoted (escapes honoured) or plain
/// (truncated at a ` #` comment). The single place the two spellings are
/// chosen between, shared by [`block_item`] and [`flow_items`].
fn scalar(raw: &str) -> String {
    if is_quoted(raw) {
        unquote(raw)
    } else {
        plain_scalar(raw)
    }
}

/// True when `s` opens a quoted scalar (`"…` or `'…`). Shared by [`parse`]
/// (which needs to skip its null-check for a quoted value) and [`scalar`].
fn is_quoted(s: &str) -> bool {
    s.starts_with('"') || s.starts_with('\'')
}

/// Items of a flow sequence, given everything after the opening `[`.
///
/// Commas inside quotes do not split. Backslash-escapes inside double-quoted
/// items are tracked so that `"ctrl+\"` does not look like a closing quote,
/// matching the same logic in `unquote`.
///
/// A quote only *opens* at the start of an item, as in YAML: `[ctrl+', alt+k]`
/// is two items whose first one ends in an apostrophe, not one item with a
/// swallowed comma.
fn flow_items(rest: &str) -> Vec<String> {
    let body = rest.rfind(']').map_or(rest, |end| &rest[..end]);
    let mut out = Vec::new();
    let mut start = 0;
    let mut idx = 0;
    while idx < body.len() {
        let ch = body[idx..]
            .chars()
            .next()
            .expect("idx < body.len() guarantees a char at idx");
        if (ch == '"' || ch == '\'') && body[start..idx].trim().is_empty() {
            // A quote only *opens* at the start of an item — jump straight
            // to its close via the scanner `unquote` also uses, rather than
            // re-walking the escape state machine a second time here.
            idx = quoted_end(body, idx + ch.len_utf8(), ch);
            if idx < body.len() {
                idx += ch.len_utf8(); // step past the closing quote
            }
            continue;
        }
        if ch == ',' {
            let raw = body[start..idx].trim();
            if !raw.is_empty() {
                out.push(scalar(raw));
            }
            start = idx + ch.len_utf8();
        }
        idx += ch.len_utf8();
    }
    let raw = body[start..].trim();
    if !raw.is_empty() {
        out.push(scalar(raw));
    }
    out
}

/// A quoted scalar with its quotes removed. Escapes are honoured inside
/// double quotes only, matching YAML.
///
/// When the value has trailing content after the closing quote (e.g.
/// `"ctrl+q" # comment`) only the content inside the quotes is returned.
fn unquote(value: &str) -> String {
    let mut chars = value.char_indices();
    let Some((_, quote)) = chars.next() else {
        return String::new();
    };
    let open = quote.len_utf8();
    let close = quoted_end(value, open, quote);
    let body = &value[open..close];
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

/// Index in `s` of the `quote` char that closes a quoted region opened just
/// before byte offset `start`, scanning from `start`. Escapes (`\"`) are
/// honoured only when `quote == '"'` — single-quoted YAML has no escape
/// mechanism. Returns `s.len()` when unterminated, so `&s[start..end]` is
/// "the rest of the string", matching this parser's forgiving-degradation
/// policy for a malformed line. Shared by [`unquote`] (find the one closing
/// quote of a whole quoted scalar) and [`flow_items`] (skip a quoted item
/// while scanning for top-level commas).
fn quoted_end(s: &str, start: usize, quote: char) -> usize {
    let mut escaped = false;
    for (idx, ch) in s.char_indices().filter(|&(i, _)| i >= start) {
        if escaped {
            escaped = false;
            continue;
        }
        if quote == '"' && ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == quote {
            return idx;
        }
    }
    s.len()
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
/// among the modifiers — so `Ctrl+P` → `ctrl+shift+p` in the TUI. This
/// reader applies that inference only when **no** modifier is present at
/// all, giving `Ctrl+P` → `ctrl+p`.
///
/// This is not an oversight: both this function and its JS twin
/// (`src/app/keymap.js`'s `canonicalChord`) hold the same narrower rule on
/// purpose, because it is what the desktop's own default registry
/// (`ACTION_IDS`, `KEYMAP_ACTIONS`) is defined against — every default
/// chord is spelled all-lowercase with an explicit modifier where one is
/// meant (`ctrl+p`, not `Ctrl+P`), so the desktop dispatcher never needs
/// omp's shift-on-modifier inference to disambiguate its own defaults.
///
/// The accepted consequence: a `keybindings.yml` entry spelled
/// `app.model.cycleForward: Ctrl+P` maps to `ctrl+shift+p` in the TUI but
/// `ctrl+p` in the desktop — a real, deliberate divergence for that one
/// spelling, not a bug. Users who write chords without a modifier
/// (`P: ...`), or in the desktop's own all-lowercase style, get identical
/// behaviour in both.
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
    let lower = base_raw.to_lowercase();
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
        // `nested:` is YAML null (empty value, no `- ` items, no indented
        // `[]`) — absent, not disabled; its indented body never becomes a
        // binding either.
        assert!(!map.contains_key("nested"));
        assert!(!map.contains_key("child"));
        assert!(!map.contains_key("deep"));
    }

    #[test]
    fn null_value_is_absent_not_disabled() {
        let map = parse(
            "app.a:\n\
             app.b: # unbound\n\
             app.c: null\n\
             app.d: ~\n\
             app.e: NULL\n",
        );
        for id in ["app.a", "app.b", "app.c", "app.d", "app.e"] {
            assert!(!map.contains_key(id), "{id} should be absent, not disabled");
        }
    }

    #[test]
    fn quoted_null_string_is_a_literal_chord() {
        let map = parse("app.a: \"null\"\n");
        assert_eq!(keys(&map, "app.a"), ["null"]);
    }

    #[test]
    fn indented_empty_flow_sequence_is_disabled() {
        let map = parse("app.a:\n  []\napp.b: ctrl+c\n");
        assert!(map.contains_key("app.a"));
        assert_eq!(keys(&map, "app.a"), [] as [&str; 0]);
        assert_eq!(keys(&map, "app.b"), ["ctrl+c"]);
    }

    #[test]
    fn block_sequence_at_column_zero_is_accepted() {
        let map = parse("app.model.select:\n- alt+m\n- alt+n\napp.other: ctrl+z\n");
        assert_eq!(keys(&map, "app.model.select"), ["alt+m", "alt+n"]);
        assert_eq!(keys(&map, "app.other"), ["ctrl+z"]);
    }

    #[test]
    fn comment_and_blank_lines_inside_a_block_sequence_do_not_truncate_it() {
        // Regression: `block_item` used to check "is this the next
        // unindented entry?" before "is this blank/comment?", so a column-0
        // `#` between `- ` items looked like the next top-level entry and
        // silently ended the sequence one item early.
        let map = parse(
            "app.model.select:\n\
             - alt+m\n\
             # column-0 comment between items\n\
             \n\
             - alt+n\n\
             app.other: ctrl+z\n",
        );
        assert_eq!(keys(&map, "app.model.select"), ["alt+m", "alt+n"]);
        assert_eq!(keys(&map, "app.other"), ["ctrl+z"]);
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
    fn quote_only_opens_at_the_start_of_a_flow_item() {
        // An apostrophe mid-item (a base key of `'`) must not be mistaken for
        // an opening quote that swallows the rest of the sequence.
        let map = parse("app.x: [ctrl+', alt+k]\n");
        assert_eq!(keys(&map, "app.x"), ["ctrl+'", "alt+k"]);
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
