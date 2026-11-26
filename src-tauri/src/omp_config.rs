//! omp's own settings, read and written through its CLI — `omp config get
//! <key> --json` / `omp config set <key> <value>` — for one profile, rather
//! than by editing `config.yml` ourselves: omp stays the owner of the file's
//! location, format and layering, and a running `omp --mode rpc-ui` tab of
//! that profile picks a change up live (its settings watcher).
//!
//! This is the one place that knows how those two subcommands are run:
//! where `--profile=<id>` goes, how the `--json` value is parsed, how an
//! unexpected output is quoted in an error, and the lock that serialises
//! every run. `goal_config.rs` (an array setting) and the boolean commands
//! below (`get_bool` / `set_bool`) sit on top of it.
//!
//! `profile` is `None` for the built-in profile (no flag) or `Some(id)` for
//! a named one, passed as a global `--profile=<id>` *before* the
//! subcommand (the same placement as `stats::fetch`). `omp --profile <id>`
//! silently creates `~/.omp/profiles/<id>/` for an unknown id, so callers
//! MUST only pass ids that went through `ProfileStore::resolve_owned`.
//!
//! Every function here spawns `omp`: callers MUST run them off the main
//! thread (see `lib.rs`'s `off_ipc`).

use serde::Deserialize;
use serde_json::Value;
use std::sync::{Mutex, MutexGuard, PoisonError};

/// Names the subcommand in `omp_cli::run`'s failure messages.
const OMP_CONFIG: &str = "omp config";

/// How much of an unexpected `config get` output is quoted in an error.
const OUTPUT_SNIPPET_MAX_CHARS: usize = 120;

/// Serialises every `omp config` run: a caller's read-modify-write, so two
/// concurrent toggles cannot interleave and drop each other's change, and a
/// plain read, so one issued while a write is still running waits for it
/// instead of returning the value it replaces. Guards no data, so a
/// poisoned lock is still usable.
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

/// Proof that [`CONFIG_LOCK`] is held. [`read`] and [`write`] take one, so a
/// run cannot happen outside the lock, and a caller that does several runs
/// (read, write, read back) holds it across all of them —
/// `std::sync::Mutex` is not reentrant, so the runs must not lock again.
pub struct ConfigGuard {
    _held: MutexGuard<'static, ()>,
}

/// Take the config lock; blocks while another `omp config` run holds it.
pub fn lock() -> ConfigGuard {
    ConfigGuard {
        _held: CONFIG_LOCK.lock().unwrap_or_else(PoisonError::into_inner),
    }
}

/// The effective value of `key` for `profile`, turned into a `T` by
/// `convert` (`None` = the value has the wrong shape). A value `convert`
/// refuses is an error quoting a bounded prefix of what omp printed.
pub fn read<T>(
    _lock: &ConfigGuard,
    profile: Option<&str>,
    key: &str,
    convert: impl FnOnce(Value) -> Option<T>,
) -> Result<T, String> {
    parse_value(
        &crate::omp_cli::run(&get_args(profile, key), OMP_CONFIG)?,
        key,
        convert,
    )
}

/// Write `value` (omp parses it by the setting's type, e.g. `true` or a
/// JSON array) to `key` in the profile's config. The value is ONE argv
/// element, so no shell or quoting layer is involved.
pub fn write(
    _lock: &ConfigGuard,
    profile: Option<&str>,
    key: &str,
    value: &str,
) -> Result<(), String> {
    crate::omp_cli::run(&set_args(profile, key, value), OMP_CONFIG).map(drop)
}

/// Argv for `omp [--profile=<id>] config get <key> --json`. `--profile`
/// goes before the subcommand, like `stats::stats_args`.
fn get_args(profile: Option<&str>, key: &str) -> Vec<String> {
    let mut args = Vec::with_capacity(5);
    args.extend(crate::agent::spawn::profile_flag(profile));
    args.extend(["config", "get", key, "--json"].map(String::from));
    args
}

/// Argv for `omp [--profile=<id>] config set <key> <value>`.
fn set_args(profile: Option<&str>, key: &str, value: &str) -> Vec<String> {
    let mut args = Vec::with_capacity(5);
    args.extend(crate::agent::spawn::profile_flag(profile));
    args.extend(["config", "set", key, value].map(String::from));
    args
}

/// Parse `omp config get <key> --json`'s stdout —
/// `{"key":…,"value":…,"type":…,"description":…}` — and hand `value` to
/// `convert`. A missing `value`, non-JSON output or a value `convert`
/// refuses is an error quoting (a bounded prefix of) what omp printed.
fn parse_value<T>(
    stdout: &[u8],
    key: &str,
    convert: impl FnOnce(Value) -> Option<T>,
) -> Result<T, String> {
    let text = String::from_utf8_lossy(stdout);
    let text = text.trim();
    let unexpected = || {
        let snippet: String = text.chars().take(OUTPUT_SNIPPET_MAX_CHARS).collect();
        let ellipsis = if snippet.len() < text.len() {
            "…"
        } else {
            ""
        };
        format!("unexpected {key} from omp: {snippet}{ellipsis}")
    };
    let mut parsed: Value = serde_json::from_str(text).map_err(|_| unexpected())?;
    parsed
        .get_mut("value")
        .map(Value::take)
        .and_then(convert)
        .ok_or_else(unexpected)
}

/// The other key omp's auto-compaction depends on (`session-maintenance.ts`):
/// auto-compaction runs only while `compaction.enabled` is on AND this
/// order of methods is non-empty (a legacy `compaction.strategy: "off"`
/// migrates to `[]`).
const COMPACTION_ORDER_KEY: &str = "compaction.methodOrder";

/// A boolean omp setting the desktop shows in Settings. The webview names
/// one of these, never a raw key.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub enum BoolSetting {
    /// omp summarises older turns when the context fills: `compaction.enabled`
    /// together with a non-empty [`COMPACTION_ORDER_KEY`] (see [`Compaction`]).
    #[serde(rename = "autoCompaction")]
    AutoCompaction,
    /// `retry.enabled`: omp retries a request the provider refused or dropped.
    #[serde(rename = "autoRetry")]
    AutoRetry,
}

impl BoolSetting {
    /// The omp config key of the setting's on/off switch.
    const fn key(self) -> &'static str {
        match self {
            Self::AutoCompaction => "compaction.enabled",
            Self::AutoRetry => "retry.enabled",
        }
    }
}

/// `Some(b)` for a JSON boolean.
fn as_bool(value: Value) -> Option<bool> {
    match value {
        Value::Bool(b) => Some(b),
        _ => None,
    }
}

/// `Some(is_empty)` for a JSON array: the method order's entries do not
/// matter here, only whether omp has any method to run.
fn array_is_empty(value: Value) -> Option<bool> {
    match value {
        Value::Array(items) => Some(items.is_empty()),
        _ => None,
    }
}

/// The two config keys behind the auto-compaction switch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Compaction {
    /// `compaction.enabled`.
    enabled: bool,
    /// `compaction.methodOrder` is `[]`.
    order_empty: bool,
}

impl Compaction {
    /// Whether omp compacts automatically.
    const fn effective(self) -> bool {
        self.enabled && !self.order_empty
    }
}

/// The writes that make [`Compaction::effective`] equal a wanted value.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct CompactionPlan {
    /// Write `compaction.enabled` to this value.
    set_enabled: Option<bool>,
    /// Run `omp config reset compaction.methodOrder` (omp's own setter does
    /// the same when it turns compaction on over an empty order).
    reset_order: bool,
}

impl CompactionPlan {
    const fn is_empty(self) -> bool {
        self.set_enabled.is_none() && !self.reset_order
    }
}

/// What to write so `current` becomes `want`. Turning on sets `enabled`
/// when it is off and resets an empty order; turning off sets only
/// `enabled: false` (the order is left alone). Nothing when `current`
/// already is `want`.
const fn compaction_plan(current: Compaction, want: bool) -> CompactionPlan {
    if current.effective() == want {
        return CompactionPlan {
            set_enabled: None,
            reset_order: false,
        };
    }
    if want {
        CompactionPlan {
            set_enabled: if current.enabled { None } else { Some(true) },
            reset_order: current.order_empty,
        }
    } else {
        CompactionPlan {
            set_enabled: Some(false),
            reset_order: false,
        }
    }
}

/// Argv for `omp [--profile=<id>] config reset <key>`.
fn reset_args(profile: Option<&str>, key: &str) -> Vec<String> {
    let mut args = Vec::with_capacity(4);
    args.extend(crate::agent::spawn::profile_flag(profile));
    args.extend(["config", "reset", key].map(String::from));
    args
}

/// Put `key` back to omp's default in the profile's config.
fn reset(_lock: &ConfigGuard, profile: Option<&str>, key: &str) -> Result<(), String> {
    crate::omp_cli::run(&reset_args(profile, key), OMP_CONFIG).map(drop)
}

/// Read both auto-compaction keys of `profile`.
fn read_compaction(guard: &ConfigGuard, profile: Option<&str>) -> Result<Compaction, String> {
    Ok(Compaction {
        enabled: read(guard, profile, BoolSetting::AutoCompaction.key(), as_bool)?,
        order_empty: read(guard, profile, COMPACTION_ORDER_KEY, array_is_empty)?,
    })
}

/// The text `omp config set` takes for a boolean.
const fn bool_text(value: bool) -> &'static str {
    if value {
        "true"
    } else {
        "false"
    }
}

/// The effective value of `setting` for `profile`. Auto-compaction is on
/// only with `compaction.enabled` set and a non-empty method order.
pub fn get_bool(profile: Option<&str>, setting: BoolSetting) -> Result<bool, String> {
    let guard = lock();
    match setting {
        BoolSetting::AutoCompaction => read_compaction(&guard, profile).map(Compaction::effective),
        BoolSetting::AutoRetry => read(&guard, profile, setting.key(), as_bool),
    }
}

/// Set `setting` to `enabled` in the profile's config and return the value
/// omp reports after the write. Nothing is written when the effective value
/// already is `enabled`. Auto-compaction may take two writes, see
/// [`compaction_plan`]; all runs happen under one lock.
// The guard is the config lock: it must outlive every run below, which only
// borrow it as proof (the lint does not see a borrow as a use).
#[allow(clippy::significant_drop_tightening)]
pub fn set_bool(
    profile: Option<&str>,
    setting: BoolSetting,
    enabled: bool,
) -> Result<bool, String> {
    let guard = lock();
    match setting {
        BoolSetting::AutoCompaction => {
            let plan = compaction_plan(read_compaction(&guard, profile)?, enabled);
            if plan.is_empty() {
                return Ok(enabled);
            }
            if let Some(on) = plan.set_enabled {
                write(&guard, profile, setting.key(), bool_text(on))?;
            }
            if plan.reset_order {
                reset(&guard, profile, COMPACTION_ORDER_KEY)?;
            }
            read_compaction(&guard, profile).map(Compaction::effective)
        }
        BoolSetting::AutoRetry => {
            let key = setting.key();
            if read(&guard, profile, key, as_bool)? == enabled {
                return Ok(enabled);
            }
            write(&guard, profile, key, bool_text(enabled))?;
            read(&guard, profile, key, as_bool)
        }
    }
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
            get_args(None, "compaction.enabled"),
            v(&["config", "get", "compaction.enabled", "--json"])
        );
        assert_eq!(get_args(Some(""), "k"), get_args(None, "k"));
    }

    #[test]
    fn get_args_put_profile_flag_before_subcommand() {
        assert_eq!(
            get_args(Some("work"), "retry.enabled"),
            v(&["--profile=work", "config", "get", "retry.enabled", "--json"])
        );
    }

    #[test]
    fn set_args_pass_the_value_as_one_element() {
        assert_eq!(
            set_args(None, "retry.enabled", "false"),
            v(&["config", "set", "retry.enabled", "false"])
        );
        assert_eq!(
            set_args(Some("work"), "k", r#"["a b","c"]"#),
            v(&["--profile=work", "config", "set", "k", r#"["a b","c"]"#])
        );
    }

    #[test]
    fn parse_value_hands_value_to_convert() {
        let out =
            br#"{"key":"compaction.enabled","value":false,"type":"boolean","description":"d"}"#;
        assert_eq!(parse_value(out, "compaction.enabled", as_bool), Ok(false));
        assert_eq!(
            parse_value(b"  {\"value\":true}\r\n", "k", as_bool),
            Ok(true)
        );
    }

    #[test]
    fn parse_value_rejects_a_missing_value_and_non_json() {
        for out in [
            r#"{"key":"retry.enabled"}"#,
            "not json",
            "",
            "[true]",
            "true",
        ] {
            let err = parse_value(out.as_bytes(), "retry.enabled", as_bool).unwrap_err();
            assert!(
                err.starts_with("unexpected retry.enabled from omp: "),
                "{err}"
            );
            assert!(err.ends_with(out), "{err}");
        }
    }

    #[test]
    fn parse_value_rejects_a_value_convert_refuses() {
        for out in [
            r#"{"value":"true"}"#,
            r#"{"value":null}"#,
            r#"{"value":1}"#,
            r#"{"value":[true]}"#,
        ] {
            let err = parse_value(out.as_bytes(), "retry.enabled", as_bool).unwrap_err();
            assert!(err.contains(out), "{err}");
        }
    }

    #[test]
    fn parse_value_error_quote_is_bounded() {
        let long = "x".repeat(10_000);
        let err = parse_value(long.as_bytes(), "k", as_bool).unwrap_err();
        assert!(err.chars().count() < 250, "{} chars", err.chars().count());
        assert!(err.ends_with('…'));
    }

    #[test]
    fn bool_setting_maps_to_omp_keys() {
        assert_eq!(BoolSetting::AutoCompaction.key(), "compaction.enabled");
        assert_eq!(BoolSetting::AutoRetry.key(), "retry.enabled");
    }

    #[test]
    fn bool_setting_names_are_the_webview_spelling_and_closed() {
        let parse = |s: &str| serde_json::from_str::<BoolSetting>(s);
        assert_eq!(
            parse(r#""autoCompaction""#).unwrap(),
            BoolSetting::AutoCompaction
        );
        assert_eq!(parse(r#""autoRetry""#).unwrap(), BoolSetting::AutoRetry);
        for raw in [
            r#""compaction.enabled""#,
            r#""AutoRetry""#,
            r#""goal.continuationModes""#,
            r#""""#,
        ] {
            assert!(parse(raw).is_err(), "{raw}");
        }
    }

    #[test]
    fn reset_args_name_the_key_after_the_subcommand() {
        assert_eq!(
            reset_args(None, "compaction.methodOrder"),
            v(&["config", "reset", "compaction.methodOrder"])
        );
        assert_eq!(
            reset_args(Some("work"), "k"),
            v(&["--profile=work", "config", "reset", "k"])
        );
    }

    #[test]
    fn array_is_empty_reads_only_arrays() {
        assert_eq!(array_is_empty(serde_json::json!([])), Some(true));
        assert_eq!(array_is_empty(serde_json::json!(["remote"])), Some(false));
        for value in [
            serde_json::json!("off"),
            serde_json::json!(null),
            serde_json::json!(false),
            serde_json::json!({}),
        ] {
            assert_eq!(array_is_empty(value), None);
        }
    }

    const fn state(enabled: bool, order_empty: bool) -> Compaction {
        Compaction {
            enabled,
            order_empty,
        }
    }

    #[test]
    fn compaction_is_effective_only_enabled_with_a_method() {
        assert!(state(true, false).effective());
        // The verified legacy `compaction.strategy: "off"` config: omp's
        // `config get compaction.enabled` says true, the order is [].
        assert!(!state(true, true).effective());
        assert!(!state(false, false).effective());
        assert!(!state(false, true).effective());
    }

    #[test]
    fn turning_compaction_on_fixes_whatever_keeps_it_off() {
        let plan = |enabled, order_empty| compaction_plan(state(enabled, order_empty), true);
        // Disabled flag only.
        assert_eq!(
            plan(false, false),
            CompactionPlan {
                set_enabled: Some(true),
                reset_order: false
            }
        );
        // Empty order only (the legacy `strategy: "off"` case).
        assert_eq!(
            plan(true, true),
            CompactionPlan {
                set_enabled: None,
                reset_order: true
            }
        );
        // Both.
        assert_eq!(
            plan(false, true),
            CompactionPlan {
                set_enabled: Some(true),
                reset_order: true
            }
        );
    }

    #[test]
    fn turning_compaction_off_writes_only_the_flag() {
        assert_eq!(
            compaction_plan(state(true, false), false),
            CompactionPlan {
                set_enabled: Some(false),
                reset_order: false
            }
        );
    }

    #[test]
    fn a_compaction_value_already_in_effect_writes_nothing() {
        // On and wanted on; off by flag, by order or by both and wanted off.
        assert!(compaction_plan(state(true, false), true).is_empty());
        for (enabled, order_empty) in [(false, false), (true, true), (false, true)] {
            assert!(compaction_plan(state(enabled, order_empty), false).is_empty());
        }
        assert!(!compaction_plan(state(true, false), false).is_empty());
    }
}
