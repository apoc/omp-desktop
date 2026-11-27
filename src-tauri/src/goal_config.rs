//! The "auto-continue" switch of omp's goal mode.
//!
//! omp continues a goal on its own over RPC only when its setting
//! `goal.continuationModes` (an array of strings, default
//! `["interactive"]`) contains `"rpc"`. This module reads and writes that
//! one setting for one profile through `omp_config` (omp's own `config
//! get|set` CLI, which also documents the `profile` argument: callers MUST
//! only pass ids that went through `ProfileStore::resolve_owned`). It keeps
//! only the array logic: which entry to add or remove.

use serde_json::Value;

/// The omp setting this module toggles.
const SETTING_KEY: &str = "goal.continuationModes";

/// The entry of [`SETTING_KEY`] that enables continuation over RPC.
const RPC_MODE: &str = "rpc";

/// Whether the effective `goal.continuationModes` of `profile` contains
/// `"rpc"`.
///
/// Spawns `omp`, so callers MUST run this off the main thread (see
/// `goal_continuation_get` in `lib.rs`).
pub fn get(profile: Option<&str>) -> Result<bool, String> {
    read_modes(&crate::omp_config::lock(), profile).map(|modes| has_rpc(&modes))
}

/// Add (`enabled`) or remove (`!enabled`) `"rpc"` in the profile's
/// `goal.continuationModes`, keeping every other entry and its order, and
/// return the effective value re-read after the write. Nothing is written
/// when the list would not change.
///
/// Blocking (up to three `omp` spawns, under one `omp_config` lock so two
/// concurrent toggles cannot drop each other's change), like [`get`].
// The guard is the config lock: it must outlive every run below, which only
// borrow it as proof (the lint does not see a borrow as a use).
#[allow(clippy::significant_drop_tightening)]
pub fn set(profile: Option<&str>, enabled: bool) -> Result<bool, String> {
    let guard = crate::omp_config::lock();
    let current = read_modes(&guard, profile)?;
    let Some(next) = next_modes(current, enabled) else {
        // `next_modes` returns `None` only when the list already says `enabled`.
        return Ok(enabled);
    };
    crate::omp_config::write(&guard, profile, SETTING_KEY, &encode_modes(&next)?)?;
    read_modes(&guard, profile).map(|modes| has_rpc(&modes))
}

/// Read the profile's current `goal.continuationModes`.
fn read_modes(
    guard: &crate::omp_config::ConfigGuard,
    profile: Option<&str>,
) -> Result<Vec<String>, String> {
    crate::omp_config::read(guard, profile, SETTING_KEY, modes_from)
}

/// The setting's entries from its `value`, which must be an array of
/// strings.
fn modes_from(value: Value) -> Option<Vec<String>> {
    let Value::Array(items) = value else {
        return None;
    };
    items
        .into_iter()
        .map(|item| match item {
            Value::String(s) => Some(s),
            _ => None,
        })
        .collect()
}

/// The text `omp config set` takes for the list: a JSON array.
fn encode_modes(modes: &[String]) -> Result<String, String> {
    serde_json::to_string(modes).map_err(|e| format!("could not encode {SETTING_KEY}: {e}"))
}

/// Whether `modes` enables continuation over RPC.
fn has_rpc(modes: &[String]) -> bool {
    modes.iter().any(|m| m == RPC_MODE)
}

/// The list to write so that `"rpc"` is present (`enabled`) or absent
/// (`!enabled`), or `None` when `current` already satisfies that. Removal
/// drops every `"rpc"`; addition appends one; other entries and their
/// order are kept.
fn next_modes(mut current: Vec<String>, enabled: bool) -> Option<Vec<String>> {
    if has_rpc(&current) == enabled {
        return None;
    }
    current.retain(|m| m != RPC_MODE);
    if enabled {
        current.push(RPC_MODE.to_string());
    }
    Some(current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn modes_from_reads_a_string_array() {
        assert_eq!(
            modes_from(json!(["interactive", "rpc"])),
            Some(v(&["interactive", "rpc"]))
        );
        assert_eq!(modes_from(json!([])), Some(Vec::new()));
    }

    #[test]
    fn modes_from_rejects_non_array_value() {
        for value in [json!("rpc"), json!(null), json!({"rpc": true}), json!(true)] {
            assert_eq!(modes_from(value), None);
        }
    }

    #[test]
    fn modes_from_rejects_non_string_entries() {
        assert_eq!(modes_from(json!(["interactive", 3])), None);
        assert_eq!(modes_from(json!([null])), None);
    }

    #[test]
    fn the_array_written_back_is_one_json_text() {
        // `set` hands this text to `omp config set` as ONE argv element.
        assert_eq!(
            encode_modes(&v(&["interactive", "rpc"])).unwrap(),
            r#"["interactive","rpc"]"#
        );
        assert_eq!(encode_modes(&v(&[r#"a "b""#])).unwrap(), r#"["a \"b\""]"#);
        assert_eq!(encode_modes(&[]).unwrap(), "[]");
    }

    #[test]
    fn next_modes_adds_rpc_once_keeping_order() {
        assert_eq!(
            next_modes(v(&["interactive"]), true),
            Some(v(&["interactive", "rpc"]))
        );
        assert_eq!(next_modes(Vec::new(), true), Some(v(&["rpc"])));
        assert_eq!(
            next_modes(v(&["b", "a"]), true),
            Some(v(&["b", "a", "rpc"]))
        );
    }

    #[test]
    fn next_modes_removes_every_rpc_keeping_others() {
        assert_eq!(
            next_modes(v(&["rpc", "interactive", "rpc", "x"]), false),
            Some(v(&["interactive", "x"]))
        );
        assert_eq!(next_modes(v(&["rpc"]), false), Some(Vec::new()));
    }

    #[test]
    fn next_modes_is_none_when_unchanged() {
        assert_eq!(next_modes(v(&["interactive", "rpc"]), true), None);
        assert_eq!(next_modes(v(&["interactive"]), false), None);
        assert_eq!(next_modes(Vec::new(), false), None);
    }

    #[test]
    fn has_rpc_matches_exact_entry_only() {
        assert!(has_rpc(&v(&["interactive", "rpc"])));
        assert!(!has_rpc(&v(&["interactive", "rpcx", "RPC"])));
        assert!(!has_rpc(&[]));
    }
}
