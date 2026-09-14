//! Project path enumeration for the composer's `@`-mention autocomplete.
//!
//! The webview cannot enumerate the filesystem itself (strict CSP, asset
//! protocol disabled, no shell plugin), so the walk *and* the ranking live
//! here: shipping a whole repo's path list to JS per keystroke would be far
//! more IPC traffic than returning the top `limit` hits.
//!
//! Every query is a bounded breadth-first walk — `MAX_ENTRIES` dirents,
//! `MAX_DEPTH` levels, `SKIP_DIRS` pruned — so a mention query on a huge
//! monorepo costs a predictable amount of work instead of a full crawl.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Directory names never descended into. Build output and dependency trees
/// dwarf the hand-written tree and are never what an `@` mention means.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    ".turbo",
    ".gradle",
    ".idea",
];

/// Ceiling on directory entries inspected per query.
const MAX_ENTRIES: usize = 20_000;
/// Ceiling on directory depth below the search root.
const MAX_DEPTH: usize = 12;
/// Largest result count a caller may ask for.
const MAX_LIMIT: usize = 200;
/// Result count when the caller doesn't specify one.
const DEFAULT_LIMIT: usize = 30;
/// Longest query accepted — beyond this it cannot be a useful path fragment.
const MAX_QUERY_LEN: usize = 256;

/// One autocomplete candidate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    /// Path relative to the search root, always `/`-separated.
    pub path: String,
    /// Final path segment — what the menu emphasises.
    pub name: String,
    /// `true` for directories, so the UI can keep drilling down.
    pub is_dir: bool,
}

/// Resolve `cwd`, clamp the caller's arguments, and run the search.
///
/// `cwd` empty falls back to the process working directory, matching how a
/// pathless session is spawned (`agent::spawn::resolve_cwd`).
///
/// # Errors
///
/// Returns `Err` when the query is over `MAX_QUERY_LEN`, the working
/// directory can't be resolved, or the root isn't an existing directory.
pub fn list(cwd: &str, query: &str, limit: Option<usize>) -> Result<Vec<FileHit>, String> {
    if query.len() > MAX_QUERY_LEN {
        return Err(format!("query too long (max {MAX_QUERY_LEN} bytes)"));
    }
    let root = if cwd.is_empty() {
        std::env::current_dir().map_err(|e| format!("cannot resolve working directory: {e}"))?
    } else {
        PathBuf::from(cwd)
    };
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    Ok(search_paths(&root, query, limit))
}

/// Bounded breadth-first walk of `root`, keeping the `limit` best fuzzy
/// matches for `query`.
///
/// Symlinks are never followed: `DirEntry::file_type` doesn't traverse them,
/// so a symlinked directory is reported as a non-directory and never queued
/// — that's also what keeps the walk acyclic.
fn search_paths(root: &Path, query: &str, limit: usize) -> Vec<FileHit> {
    search_paths_capped(root, query, limit, MAX_ENTRIES)
}

/// `max_entries` is a parameter only so the entry cap is reachable from a
/// test without materializing 20,000 real dirents — every production
/// caller goes through `search_paths`, which always passes `MAX_ENTRIES`.
fn search_paths_capped(root: &Path, query: &str, limit: usize, max_entries: usize) -> Vec<FileHit> {
    let needle: Vec<char> = query.chars().collect();
    // Dot-entries stay hidden unless the query explicitly names one.
    let show_hidden = query.starts_with('.') || query.contains("/.");
    let mut scored: Vec<(i32, FileHit)> = Vec::new();
    let mut queue: VecDeque<(PathBuf, String, usize)> = VecDeque::new();
    queue.push_back((root.to_path_buf(), String::new(), 0));
    let mut seen = 0_usize;

    'walk: while let Some((dir, prefix, depth)) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if seen >= max_entries {
                break 'walk;
            }
            seen += 1;
            let raw_name = entry.file_name();
            // Non-UTF-8 names can't round-trip through the IPC payload.
            let Some(name) = raw_name.to_str() else {
                continue;
            };
            if name.starts_with('.') && !show_hidden {
                continue;
            }
            let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
            if is_dir && SKIP_DIRS.contains(&name) {
                continue;
            }
            let rel = if prefix.is_empty() {
                name.to_owned()
            } else {
                format!("{prefix}/{name}")
            };
            let name_start = rel.len() - name.len();
            let score = fuzzy_score(&rel, &needle, name_start);
            if is_dir && depth < MAX_DEPTH {
                queue.push_back((entry.path(), rel.clone(), depth + 1));
            }
            if let Some(score) = score {
                scored.push((
                    score,
                    FileHit {
                        path: rel,
                        name: name.to_owned(),
                        is_dir,
                    },
                ));
            }
        }
    }

    // Best score first; shorter paths break ties; then lexical, so the
    // ordering is fully deterministic for a given tree.
    scored.sort_unstable_by(|(a_score, a), (b_score, b)| {
        b_score
            .cmp(a_score)
            .then_with(|| a.path.len().cmp(&b.path.len()))
            .then_with(|| a.path.cmp(&b.path))
    });
    scored.truncate(limit);
    scored.into_iter().map(|(_, hit)| hit).collect()
}

/// Case-insensitive subsequence score, or `None` when `needle` isn't a
/// subsequence of `candidate`.
///
/// Greedy left-to-right match with bonuses for consecutive runs, segment
/// starts, and hits inside the basename (`name_start` is the byte offset of
/// the last path segment). Longer paths are penalised so that, for equal
/// match quality, the shallower file wins.
fn fuzzy_score(candidate: &str, needle: &[char], name_start: usize) -> Option<i32> {
    let mut matched = 0_usize;
    let mut score = 0_i32;
    let mut prev_end = usize::MAX;

    for (i, c) in candidate.char_indices() {
        let Some(&want) = needle.get(matched) else {
            break;
        };
        if !eq_fold(c, want) {
            continue;
        }
        score += 10;
        if i == prev_end {
            score += 12;
        }
        if i == 0 || candidate[..i].chars().next_back().is_some_and(is_boundary) {
            score += 8;
        }
        if i >= name_start {
            score += 6;
        }
        prev_end = i + c.len_utf8();
        matched += 1;
    }

    if matched < needle.len() {
        return None;
    }
    let length_penalty = i32::try_from(candidate.len()).unwrap_or(i32::MAX) / 4;
    Some(score - length_penalty)
}

/// ASCII-fast, Unicode-correct case-insensitive char comparison.
fn eq_fold(a: char, b: char) -> bool {
    a.eq_ignore_ascii_case(&b) || a.to_lowercase().eq(b.to_lowercase())
}

/// Characters after which the next char starts a new "word" worth a bonus.
const fn is_boundary(c: char) -> bool {
    matches!(c, '/' | '\\' | '_' | '-' | '.' | ' ')
}

#[cfg(test)]
mod tests {
    use super::{fuzzy_score, list, search_paths, search_paths_capped, DEFAULT_LIMIT, MAX_LIMIT};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    fn needle(q: &str) -> Vec<char> {
        q.chars().collect()
    }

    fn unique_temp_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        std::env::temp_dir().join(format!(
            "omp-files-test-{tag}-{}-{n}-{nanos}",
            std::process::id()
        ))
    }

    /// Tree used by the walk tests:
    ///   `src/live.js`, `src/design/composer.jsx`, `src/design/panels.jsx`,
    ///   `node_modules/react/index.js`, `.hidden/secret.txt`, `README.md`
    fn fixture_tree(tag: &str) -> PathBuf {
        let root = unique_temp_dir(tag);
        for dir in ["src/design", "node_modules/react", ".hidden"] {
            std::fs::create_dir_all(root.join(dir)).expect("create fixture dir");
        }
        for file in [
            "src/live.js",
            "src/design/composer.jsx",
            "src/design/panels.jsx",
            "node_modules/react/index.js",
            ".hidden/secret.txt",
            "README.md",
        ] {
            std::fs::write(root.join(file), b"x").expect("write fixture file");
        }
        root
    }

    fn paths(root: &Path, query: &str, limit: usize) -> Vec<String> {
        search_paths(root, query, limit)
            .into_iter()
            .map(|h| h.path)
            .collect()
    }

    #[test]
    fn scores_subsequence_match_and_rejects_non_match() {
        assert!(fuzzy_score("src/live.js", &needle("slive"), 4).is_some());
        assert!(fuzzy_score("src/live.js", &needle("zzz"), 4).is_none());
        // Out-of-order characters are not a subsequence.
        assert!(fuzzy_score("src/live.js", &needle("evil"), 4).is_none());
    }

    #[test]
    fn scoring_is_case_insensitive() {
        assert!(fuzzy_score("src/Composer.jsx", &needle("composer"), 4).is_some());
        assert!(fuzzy_score("src/composer.jsx", &needle("COMPOSER"), 4).is_some());
    }

    #[test]
    fn basename_match_outranks_deep_path_match() {
        let basename = fuzzy_score("src/panels.jsx", &needle("panels"), 4).expect("matches");
        let scattered =
            fuzzy_score("p/a/n/e/l/s/other.txt", &needle("panels"), 14).expect("matches");
        assert!(
            basename > scattered,
            "basename hit {basename} should outrank scattered hit {scattered}"
        );
    }

    #[test]
    fn consecutive_run_outranks_gappy_match() {
        let dense = fuzzy_score("abc.txt", &needle("abc"), 0).expect("matches");
        let gappy = fuzzy_score("axbxc.txt", &needle("abc"), 0).expect("matches");
        assert!(dense > gappy, "dense {dense} should outrank gappy {gappy}");
    }

    #[test]
    fn empty_query_lists_shortest_paths_first() {
        // No needle means every candidate matches with score 0 minus its
        // length penalty, so the shortest paths sort first — deterministic
        // even though `src` (a dir) and `README.md` (a file) sit at the
        // same depth.
        let root = fixture_tree("empty-query");
        let hits = paths(&root, "", 3);
        assert_eq!(hits.first().map(String::as_str), Some("src"));
        assert_eq!(hits.len(), 3);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn walk_prunes_skip_dirs_and_hidden_entries() {
        let root = fixture_tree("prune");
        let all = paths(&root, "", 100);
        assert!(
            !all.iter().any(|p| p.contains("node_modules")),
            "node_modules must be pruned, got {all:?}"
        );
        assert!(
            !all.iter().any(|p| p.contains(".hidden")),
            "dot-dirs must be hidden, got {all:?}"
        );
        assert!(all.contains(&"src/design/composer.jsx".to_owned()));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn dot_query_opts_into_hidden_entries() {
        let root = fixture_tree("hidden-optin");
        let hits = paths(&root, ".hidden/sec", 10);
        assert!(
            hits.contains(&".hidden/secret.txt".to_owned()),
            "explicit dot query must reveal hidden entries, got {hits:?}"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn query_ranks_intended_file_first() {
        let root = fixture_tree("rank");
        let hits = paths(&root, "composer", 10);
        assert_eq!(
            hits.first().map(String::as_str),
            Some("src/design/composer.jsx"),
            "got {hits:?}"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn directories_are_flagged_for_drill_down() {
        let root = fixture_tree("dirs");
        let hits = search_paths(&root, "design", 10);
        let design = hits
            .iter()
            .find(|h| h.path == "src/design")
            .expect("src/design present");
        assert!(design.is_dir);
        assert_eq!(design.name, "design");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn limit_bounds_the_result_count() {
        let root = fixture_tree("limit");
        assert_eq!(paths(&root, "", 2).len(), 2);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn list_clamps_limit_and_defaults_when_absent() {
        let root = fixture_tree("clamp");
        let cwd = root.to_str().expect("utf-8 temp path");
        // 0 clamps up to 1, oversized clamps down to MAX_LIMIT, None defaults.
        assert_eq!(list(cwd, "", Some(0)).expect("ok").len(), 1);
        let big = list(cwd, "", Some(MAX_LIMIT * 10)).expect("ok");
        assert!(big.len() <= MAX_LIMIT);
        let defaulted = list(cwd, "", None).expect("ok");
        assert!(defaulted.len() <= DEFAULT_LIMIT);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn list_rejects_non_directory_root_and_overlong_query() {
        let root = fixture_tree("reject");
        let file = root.join("README.md");
        assert!(list(file.to_str().expect("utf-8"), "", None).is_err());
        assert!(list(
            root.to_str().expect("utf-8"),
            &"a".repeat(super::MAX_QUERY_LEN + 1),
            None
        )
        .is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn list_falls_back_to_process_cwd_for_empty_path() {
        // The pathless "default" session sends "" — must still return hits
        // rather than erroring, walking the process's actual working
        // directory (the crate root under `cargo test`). Asserting only
        // `is_ok()` would pass even if the fallback silently produced an
        // empty result, so check a file tracked in every checkout — not
        // build-generated output like `gen/`, which may or may not exist
        // depending on build state — actually shows up.
        let hits = list("", "", Some(50)).expect("ok");
        assert!(
            hits.iter().any(|h| h.path == "Cargo.toml"),
            "expected Cargo.toml among the crate root's hits, got {hits:?}"
        );
    }

    #[test]
    fn walk_does_not_descend_past_max_depth() {
        // `root` is dequeued at depth 0, so `d0/…/d11` is pushed with
        // depth 12 and is the deepest directory whose contents are ever
        // read (`depth < MAX_DEPTH` guards the push) — a marker inside it
        // must surface, and one inside `d0/…/d12`, one level past that,
        // must not. Pinning both markers on either side of the real edge
        // (rather than leaving several levels of slack) means a relaxed
        // guard or an off-by-one in the comparison actually flips this.
        let root = unique_temp_dir("depth-cap");
        let mut at_cap = root.clone();
        for i in 0..12 {
            at_cap = at_cap.join(format!("d{i}"));
        }
        let past_cap = at_cap.join("d12");
        std::fs::create_dir_all(&past_cap).expect("create deep chain");
        std::fs::write(past_cap.join("too-deep.txt"), b"x").expect("write deep marker");
        std::fs::write(at_cap.join("within-cap.txt"), b"x").expect("write shallow marker");

        let hits = paths(&root, "", 10_000);
        assert!(
            !hits.iter().any(|p| p.ends_with("too-deep.txt")),
            "a marker past MAX_DEPTH must never be reached, got {hits:?}"
        );
        assert!(
            hits.iter().any(|p| p.ends_with("within-cap.txt")),
            "a marker within MAX_DEPTH must still be reached, got {hits:?}"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn walk_stops_at_the_entry_cap() {
        // Materializing 20,000 real dirents to exercise MAX_ENTRIES directly
        // would be expensive (especially on Windows CI); search_paths_capped
        // exists so the same `seen >= max_entries` guard can be proven
        // against a tiny cap instead. Ten files, cap of three: the walk
        // must stop after inspecting exactly three, well short of a full
        // listing.
        let root = unique_temp_dir("entry-cap");
        std::fs::create_dir_all(&root).expect("create root");
        for i in 0..10 {
            std::fs::write(root.join(format!("f{i}.txt")), b"x").expect("write fixture file");
        }

        let hits = search_paths_capped(&root, "", 10_000, 3);
        assert_eq!(
            hits.len(),
            3,
            "entry cap of 3 must truncate a 10-file directory to 3, got {hits:?}"
        );
        std::fs::remove_dir_all(&root).ok();
    }
}
