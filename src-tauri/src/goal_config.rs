//! The "auto-continue" switch of omp's goal mode.
//!
//! omp continues a goal on its own over RPC only when its setting
//! `goal.continuationModes` (an array of strings, default
//! `["interactive"]`) contains `"rpc"`. This module reads and writes that
//! one setting for one profile through omp's own CLI — `omp config get
//! goal.continuationModes --json` / `omp config set goal.continuationModes
//! '<json array>'` — rather than editing `config.yml` ourselves, so omp
//! stays the owner of the file's location, format and layering, and a
//! running `omp --mode rpc-ui` tab of that profile picks the change up live.
//!
//! `profile` is `None` for the built-in profile (no flag) or `Some(id)` for
//! a named one, passed as a global `--profile=<id>` *before* the
//! subcommand (the same placement as `stats::fetch`). `omp --profile <id>`
//! silently creates `~/.omp/profiles/<id>/` for an unknown id, so callers
//! MUST only pass ids that went through `ProfileStore::resolve_owned`.

use std::sync::{Mutex, PoisonError};

/// The omp setting this module toggles.
const SETTING_KEY: &str = "goal.continuationModes";

/// The entry of [`SETTING_KEY`] that enables continuation over RPC.
const RPC_MODE: &str = "rpc";

/// Names the subcommand in `omp_cli::run`'s failure messages.
const OMP_CONFIG: &str = "omp config";

/// How much of an unexpected `config get` output is quoted in an error.
const OUTPUT_SNIPPET_MAX_CHARS: usize = 120;

/// Serialises every read and write of the setting: [`set`]'s
/// read-modify-write, so two concurrent toggles cannot interleave and drop
/// each other's change, and [`get`], so a read issued while a toggle is
/// still writing waits for it instead of returning the value it replaces.
/// Taken inside the blocking closure only; guards no data, so a poisoned
/// lock is still usable.
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

/// Whether the effective `goal.continuationModes` of `profile` contains
/// `"rpc"`.
///
/// Spawns `omp`, so callers MUST run this off the main thread (see
/// `goal_continuation_get` in `lib.rs`).
pub fn get(profile: Option<&str>) -> Result<bool, String> {
    let _guard = CONFIG_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    read_modes(profile).map(|modes| has_rpc(&modes))
}

/// Add (`enabled`) or remove (`!enabled`) `"rpc"` in the profile's
/// `goal.continuationModes`, keeping every other entry and its order, and
/// return the effective value re-read after the write. Nothing is written
/// when the list would not change.
///
/// Blocking (up to three `omp` spawns), like [`get`].
pub fn set(profile: Option<&str>, enabled: bool) -> Result<bool, String> {
    let _guard = CONFIG_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    let current = read_modes(profile)?;
    let Some(next) = next_modes(current, enabled) else {
        // `next_modes` returns `None` only when the list already says `enabled`.
        return Ok(enabled);
    };
    crate::omp_cli::run(&set_args(profile, &next)?, OMP_CONFIG)?;
    // Not `get`: the lock is held, and `std::sync::Mutex` is not reentrant.
    read_modes(profile).map(|modes| has_rpc(&modes))
}

/// Read and parse the profile's current `goal.continuationModes`.
fn read_modes(profile: Option<&str>) -> Result<Vec<String>, String> {
    parse_modes(&crate::omp_cli::run(&get_args(profile), OMP_CONFIG)?)
}

/// Argv for `omp [--profile=<id>] config get goal.continuationModes --json`.
/// `--profile` goes before the subcommand, like `stats::stats_args`.
fn get_args(profile: Option<&str>) -> Vec<String> {
    let mut args = Vec::with_capacity(5);
    args.extend(crate::agent::spawn::profile_flag(profile));
    args.extend(["config", "get", SETTING_KEY, "--json"].map(String::from));
    args
}

/// Argv for `omp [--profile=<id>] config set goal.continuationModes
/// '<json array>'`: the array text is ONE argv element, so no shell or
/// quoting layer is involved.
fn set_args(profile: Option<&str>, modes: &[String]) -> Result<Vec<String>, String> {
    let value =
        serde_json::to_string(modes).map_err(|e| format!("could not encode {SETTING_KEY}: {e}"))?;
    let mut args = Vec::with_capacity(5);
    args.extend(crate::agent::spawn::profile_flag(profile));
    args.extend(["config", "set", SETTING_KEY].map(String::from));
    args.push(value);
    Ok(args)
}

/// Parse `omp config get <key> --json`'s stdout —
/// `{"key":…,"value":[…],"type":"array","description":…}` — into the
/// setting's entries. `value` must be an array of strings; anything else
/// is an error quoting (a bounded prefix of) what omp printed.
fn parse_modes(stdout: &[u8]) -> Result<Vec<String>, String> {
    let text = String::from_utf8_lossy(stdout);
    let text = text.trim();
    let unexpected = || {
        let snippet: String = text.chars().take(OUTPUT_SNIPPET_MAX_CHARS).collect();
        let ellipsis = if snippet.len() < text.len() {
            "…"
        } else {
            ""
        };
        format!("unexpected {SETTING_KEY} from omp: {snippet}{ellipsis}")
    };
    let mut parsed: serde_json::Value = serde_json::from_str(text).map_err(|_| unexpected())?;
    let serde_json::Value::Array(items) = parsed
        .get_mut("value")
        .map(serde_json::Value::take)
        .ok_or_else(unexpected)?
    else {
        return Err(unexpected());
    };
    items
        .into_iter()
        .map(|item| match item {
            serde_json::Value::String(s) => Ok(s),
            _ => Err(unexpected()),
        })
        .collect()
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

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn get_args_for_builtin_profile_has_no_flag() {
        assert_eq!(
            get_args(None),
            v(&["config", "get", "goal.continuationModes", "--json"])
        );
        assert_eq!(get_args(Some("")), get_args(None));
    }

    #[test]
    fn get_args_put_profile_flag_before_subcommand() {
        assert_eq!(
            get_args(Some("work")),
            v(&[
                "--profile=work",
                "config",
                "get",
                "goal.continuationModes",
                "--json"
            ])
        );
    }

    #[test]
    fn set_args_pass_json_array_as_one_element() {
        assert_eq!(
            set_args(None, &v(&["interactive", "rpc"])).unwrap(),
            v(&[
                "config",
                "set",
                "goal.continuationModes",
                r#"["interactive","rpc"]"#
            ])
        );
        assert_eq!(
            set_args(Some("work"), &[]).unwrap(),
            v(&[
                "--profile=work",
                "config",
                "set",
                "goal.continuationModes",
                "[]"
            ])
        );
    }

    #[test]
    fn set_args_escape_entries_inside_the_one_element() {
        let args = set_args(None, &v(&[r#"a "b""#])).unwrap();
        assert_eq!(args.len(), 4);
        assert_eq!(args[3], r#"["a \"b\""]"#);
    }

    #[test]
    fn parse_modes_reads_value_array() {
        let out = br#"{"key":"goal.continuationModes","value":["interactive","rpc"],"type":"array","description":"d"}"#;
        assert_eq!(parse_modes(out).unwrap(), v(&["interactive", "rpc"]));
        assert_eq!(
            parse_modes(b"  {\"value\":[]}\r\n").unwrap(),
            Vec::<String>::new()
        );
    }

    #[test]
    fn parse_modes_rejects_non_array_value() {
        for out in [
            r#"{"value":"rpc"}"#,
            r#"{"value":null}"#,
            r#"{"value":{"rpc":true}}"#,
            r#"{"key":"goal.continuationModes"}"#,
        ] {
            let err = parse_modes(out.as_bytes()).unwrap_err();
            assert!(err.contains(out), "{err}");
        }
    }

    #[test]
    fn parse_modes_rejects_non_string_entries() {
        let err = parse_modes(br#"{"value":["interactive",3]}"#).unwrap_err();
        assert!(
            err.starts_with("unexpected goal.continuationModes"),
            "{err}"
        );
    }

    #[test]
    fn parse_modes_rejects_non_json_and_empty() {
        assert!(parse_modes(b"not json").unwrap_err().contains("not json"));
        assert!(parse_modes(b"").is_err());
        assert!(parse_modes(b"[\"rpc\"]").is_err());
    }

    #[test]
    fn parse_modes_error_quote_is_bounded() {
        let long = "x".repeat(10_000);
        let err = parse_modes(long.as_bytes()).unwrap_err();
        assert!(err.chars().count() < 250, "{} chars", err.chars().count());
        assert!(err.ends_with('…'));
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
