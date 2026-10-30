//! `<app_config_dir>/widgets.json`: the only source of plugin commands.
//! A file-level problem (unreadable, not JSON, unknown version) is an
//! `Err`; a bad entry is skipped and reported in `WidgetConfig::errors`.
//! Unknown keys and trigger names are reported there too (typo detection)
//! without invalidating the entry.

use std::collections::BTreeMap;
use std::path::Path;

use crate::external_open;

use serde::de::IgnoredAny;

pub const TIMEOUT_DEFAULT_MS: u64 = 10_000;
pub const TIMEOUT_MIN_MS: u64 = 1_000;
pub const TIMEOUT_MAX_MS: u64 = 60_000;
pub const INTERVAL_MIN_MS: u64 = 15_000;
pub const INTERVAL_MAX_MS: u64 = 3_600_000;
/// Entries past this many in `widgets.json` are not validated; one error reports them.
pub const MAX_PLUGINS: usize = 32;
const SUPPORTED_VERSION: u64 = 1;
/// The triggers a config may list; also the default when `triggers` is absent.
/// `manual` is always allowed and `interval` follows `intervalMs`.
const CONFIG_TRIGGERS: [Trigger; 3] = [Trigger::Activate, Trigger::TurnEnd, Trigger::Branch];

/// Why a plugin run was started; passed to the plugin as `OMP_WIDGET_TRIGGER`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Trigger {
    Activate,
    TurnEnd,
    Branch,
    Manual,
    Interval,
}

impl Trigger {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Activate => "activate",
            Self::TurnEnd => "turn_end",
            Self::Branch => "branch",
            Self::Manual => "manual",
            Self::Interval => "interval",
        }
    }
}

/// `tab`: one result per tab, run with that tab's context. `global`: one
/// result shared by all tabs, run with the active tab's context.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Tab,
    Global,
}

/// Where a click on a plugin's insert button puts the text. Read from
/// `widgets.json` only, never from plugin output.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "target", rename_all = "kebab-case")]
pub enum InsertTarget {
    /// Append to the active tab's draft (the default).
    Draft,
    /// Open a new tab on `project` (absolute, `~/` expanded, canonicalised
    /// existing directory at load) and put the text into its draft.
    NewTab { project: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginEntry {
    pub id: String,
    pub title: String,
    /// `~/` expanded; argv0 is absolute or a bare program name.
    pub command: Vec<String>,
    /// Directory prefix, `~/` expanded; `None` matches every project.
    pub match_path: Option<String>,
    /// Substring of the remote URL; `None` matches every remote.
    pub match_remote: Option<String>,
    /// Config-settable triggers only (`activate`, `turn_end`, `branch`), no
    /// duplicates. See [`PluginEntry::wants`] for `manual` and `interval`.
    pub triggers: Vec<Trigger>,
    pub timeout_ms: u64,
    pub interval_ms: Option<u64>,
    pub enabled: bool,
    pub scope: Scope,
    pub insert: InsertTarget,
}

impl PluginEntry {
    /// Whether the plugin applies to a tab with this project path and remote:
    /// `match.path` is a directory prefix (`/a/b` matches `/a/b` and `/a/b/c`,
    /// never `/a/bc`; `\` and `/` are equivalent; `/` matches every absolute
    /// project), `match.remote` a substring of the remote URL. Both must hold
    /// when given.
    pub fn matches(&self, project: &str, remote: &str) -> bool {
        self.match_path
            .as_deref()
            .is_none_or(|p| p.is_empty() || path_matches(p, project))
            && self
                .match_remote
                .as_deref()
                .is_none_or(|r| remote.contains(r))
    }

    /// Whether `trigger` may start this plugin: `manual` always, `interval`
    /// exactly when `intervalMs` is set, the rest per `triggers`.
    pub fn wants(&self, trigger: Trigger) -> bool {
        match trigger {
            Trigger::Manual => true,
            Trigger::Interval => self.interval_ms.is_some(),
            t => self.triggers.contains(&t),
        }
    }
}

const fn is_sep(b: u8) -> bool {
    b == b'/' || b == b'\\'
}

/// Directory-prefix match on separator boundaries, without allocating.
fn path_matches(prefix: &str, project: &str) -> bool {
    let a = prefix.trim_end_matches(['/', '\\']).as_bytes();
    let b = project.trim_end_matches(['/', '\\']).as_bytes();
    if a.is_empty() {
        // `prefix` was only separators: the root matches any absolute path.
        return !prefix.is_empty() && project.as_bytes().first().is_some_and(|&c| is_sep(c));
    }
    b.len() >= a.len()
        && a.iter()
            .zip(b)
            .all(|(&x, &y)| x == y || (is_sep(x) && is_sep(y)))
        && b.get(a.len()).is_none_or(|&c| is_sep(c))
}

#[derive(Debug, Default)]
pub struct WidgetConfig {
    pub plugins: Vec<PluginEntry>,
    pub errors: Vec<String>,
}

/// Raw on-disk shape; validated into [`PluginEntry`] by [`validate`].
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEntry {
    id: Option<String>,
    title: Option<String>,
    command: Option<Vec<String>>,
    #[serde(rename = "match")]
    matcher: Option<RawMatch>,
    triggers: Option<Vec<String>>,
    timeout_ms: Option<u64>,
    interval_ms: Option<u64>,
    enabled: Option<bool>,
    scope: Option<String>,
    /// Kept raw: a malformed `insert` must fall back to the draft with an
    /// error card, not reject the entry (see [`parse_insert`]).
    insert: Option<serde_json::Value>,
    /// Every key not named above; each is reported as a likely typo. serde's
    /// `flatten` needs a map; only the key names matter.
    #[serde(flatten)]
    #[allow(clippy::zero_sized_map_values)]
    extra: BTreeMap<String, IgnoredAny>,
}

#[derive(serde::Deserialize)]
struct RawMatch {
    path: Option<String>,
    remote: Option<String>,
    #[serde(flatten)]
    #[allow(clippy::zero_sized_map_values)]
    extra: BTreeMap<String, IgnoredAny>,
}

#[derive(serde::Deserialize)]
struct RawInsert {
    target: Option<String>,
    project: Option<String>,
    #[serde(flatten)]
    #[allow(clippy::zero_sized_map_values)]
    extra: BTreeMap<String, IgnoredAny>,
}

/// Plugin entries stay raw JSON so one malformed entry cannot fail the file.
#[derive(serde::Deserialize)]
struct RawFile {
    version: Option<u64>,
    plugins: Option<Vec<serde_json::Value>>,
    #[serde(flatten)]
    #[allow(clippy::zero_sized_map_values)]
    extra: BTreeMap<String, IgnoredAny>,
}

pub fn load(path: &Path) -> Result<WidgetConfig, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(WidgetConfig::default()),
        Err(e) => return Err(format!("widgets.json: {e}")),
    };
    let file: RawFile = serde_json::from_slice(&bytes).map_err(|e| format!("widgets.json: {e}"))?;
    match file.version {
        Some(SUPPORTED_VERSION) => {}
        Some(v) => {
            return Err(format!(
                "widgets.json: version {v} is not supported (this desktop supports {SUPPORTED_VERSION})"
            ))
        }
        None => return Err("widgets.json: missing \"version\"".to_string()),
    }
    let mut out = WidgetConfig::default();
    for key in file.extra.keys() {
        out.errors
            .push(format!("widgets.json: unknown key \"{key}\""));
    }
    let entries = file.plugins.unwrap_or_default();
    if entries.len() > MAX_PLUGINS {
        out.errors.push(format!(
            "widgets.json: {} plugin entries ignored (at most {MAX_PLUGINS} are read)",
            entries.len() - MAX_PLUGINS
        ));
    }
    for (i, value) in entries.into_iter().take(MAX_PLUGINS).enumerate() {
        let result = serde_json::from_value::<RawEntry>(value)
            .map_err(|e| format!("plugin #{i}: {e}"))
            .and_then(|raw| validate(raw, i, &out.plugins, &mut out.errors));
        match result {
            Ok(entry) => out.plugins.push(entry),
            Err(e) => out.errors.push(e),
        }
    }
    Ok(out)
}

/// `[a-z0-9-]{1,32}`: the plugin id grammar, also checked on ids arriving over IPC.
pub fn id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The user's home directory from `HOME` (`USERPROFILE` on Windows); `None`
/// when unset, empty or not UTF-8.
pub fn home_dir() -> Option<String> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .and_then(|h| h.into_string().ok())
        .filter(|h| !h.is_empty())
}

/// Replaces a leading `~/` in every argv element with `home`. Only the exact
/// `~/` prefix counts: `~user` and a bare `~` stay untouched. Fails when an
/// element needs expanding but there is no home directory.
fn expand_home(command: &mut [String], home: Option<&str>) -> Result<(), ()> {
    for arg in command {
        if let Some(rest) = arg.strip_prefix("~/") {
            let home = home.ok_or(())?;
            *arg = Path::new(home).join(rest).to_string_lossy().into_owned();
        }
    }
    Ok(())
}

/// Parses `triggers`; unknown names and `interval` become `warnings`, the
/// entry stays valid with the rest.
fn parse_triggers(list: Option<Vec<String>>, id: &str, warnings: &mut Vec<String>) -> Vec<Trigger> {
    let Some(list) = list else {
        return Vec::from(CONFIG_TRIGGERS);
    };
    let mut out = Vec::with_capacity(list.len().min(CONFIG_TRIGGERS.len()));
    for name in list {
        let Some(trigger) = CONFIG_TRIGGERS.into_iter().find(|t| t.as_str() == name) else {
            match name.as_str() {
                // Always allowed; listing it is harmless.
                "manual" => {}
                "interval" => warnings.push(format!(
                    "plugin \"{id}\": \"interval\" is not a valid trigger; set \"intervalMs\" instead"
                )),
                _ => warnings.push(format!(
                    "plugin \"{id}\": unknown trigger \"{name}\" (expected activate, turn_end, branch or manual)"
                )),
            }
            continue;
        };
        if !out.contains(&trigger) {
            out.push(trigger);
        }
    }
    out
}

/// Parses `insert`. Any problem is a warning and the target stays `Draft`:
/// the plugin itself still runs, only the click target is refused.
fn parse_insert(
    raw: Option<serde_json::Value>,
    label: &str,
    home: Option<&str>,
    warnings: &mut Vec<String>,
) -> InsertTarget {
    let Some(value) = raw.filter(|v| !v.is_null()) else {
        return InsertTarget::Draft;
    };
    let insert = match serde_json::from_value::<RawInsert>(value) {
        Ok(i) => i,
        Err(e) => {
            warnings.push(format!(
                "{label}: insert must be an object with string \"target\" and \"project\" ({e}); inserting into the draft"
            ));
            return InsertTarget::Draft;
        }
    };
    for key in insert.extra.keys() {
        warnings.push(format!("{label}: unknown key \"insert.{key}\""));
    }
    match insert.target.as_deref() {
        None | Some("draft") => {
            if insert.project.is_some() {
                warnings.push(format!(
                    "{label}: insert.project is only used with insert.target \"new-tab\""
                ));
            }
            InsertTarget::Draft
        }
        Some("new-tab") => {
            let Some(mut project) = insert.project.filter(|p| !p.is_empty()) else {
                warnings.push(format!(
                    "{label}: insert.target \"new-tab\" needs insert.project; inserting into the draft"
                ));
                return InsertTarget::Draft;
            };
            if expand_home(std::slice::from_mut(&mut project), home).is_err() {
                warnings.push(format!(
                    "{label}: cannot expand ~ in insert.project: no home directory; inserting into the draft"
                ));
                return InsertTarget::Draft;
            }
            if !Path::new(&project).is_absolute() {
                warnings.push(format!(
                    "{label}: insert.project \"{project}\" must be an absolute path or start with ~/; inserting into the draft"
                ));
                return InsertTarget::Draft;
            }
            let Ok(project) = external_open::canonical_folder(Path::new(&project)) else {
                warnings.push(format!(
                    "{label}: insert.project \"{project}\" is not an existing directory; inserting into the draft"
                ));
                return InsertTarget::Draft;
            };
            InsertTarget::NewTab { project }
        }
        Some(other) => {
            warnings.push(format!(
                "{label}: unknown insert.target \"{other}\" (expected draft or new-tab); inserting into the draft"
            ));
            InsertTarget::Draft
        }
    }
}

/// Validates one entry. Problems that keep the entry usable (unknown keys,
/// unknown triggers) go to `warnings`; the rest reject the entry.
fn validate(
    raw: RawEntry,
    index: usize,
    seen: &[PluginEntry],
    warnings: &mut Vec<String>,
) -> Result<PluginEntry, String> {
    let id = raw.id.unwrap_or_default();
    let valid_id = id_ok(&id);
    let label = if valid_id {
        format!("plugin \"{id}\"")
    } else {
        format!("plugin #{index}")
    };
    for key in raw.extra.keys() {
        warnings.push(format!("{label}: unknown key \"{key}\""));
    }
    if let Some(m) = &raw.matcher {
        for key in m.extra.keys() {
            warnings.push(format!("{label}: unknown key \"match.{key}\""));
        }
    }
    if !valid_id {
        return Err(format!(
            "plugin #{index}: id \"{id}\" must match [a-z0-9-]{{1,32}}"
        ));
    }
    // ≤ MAX_PLUGINS entries: a linear scan per entry is cheaper than a set.
    if seen.iter().any(|p| p.id == id) {
        return Err(format!("{label}: duplicate id"));
    }
    let mut command = raw.command.unwrap_or_default();
    if command.first().is_none_or(String::is_empty) {
        return Err(format!("{label}: command must be a non-empty argv array"));
    }
    let home = home_dir();
    expand_home(&mut command, home.as_deref())
        .map_err(|()| format!("{label}: cannot expand ~: no home directory"))?;
    // The working directory is the untrusted project: a relative program path
    // (`./x`, `bin/x`) would resolve inside it.
    let argv0 = command.first().map_or("", String::as_str);
    if argv0.contains(['/', '\\']) && !Path::new(argv0).is_absolute() {
        return Err(format!(
            "{label}: command path must be absolute or a bare program name"
        ));
    }
    let scope = match raw.scope.as_deref() {
        None | Some("tab") => Scope::Tab,
        Some("global") => Scope::Global,
        Some(_) => return Err(format!("{label}: scope must be \"tab\" or \"global\"")),
    };
    let timeout_ms = raw
        .timeout_ms
        .unwrap_or(TIMEOUT_DEFAULT_MS)
        .clamp(TIMEOUT_MIN_MS, TIMEOUT_MAX_MS);
    let interval_ms = raw
        .interval_ms
        .filter(|&v| v > 0)
        .map(|v| v.clamp(INTERVAL_MIN_MS, INTERVAL_MAX_MS));
    let (match_path, match_remote) = raw.matcher.map_or((None, None), |m| (m.path, m.remote));
    // An empty matcher matches everything, exactly like an absent one.
    let mut match_path = match_path.filter(|p| !p.is_empty());
    let match_remote = match_remote.filter(|r| !r.is_empty());
    // Same `~/` rule as for the command: a config can describe its folders
    // portably (`~/GIT/work`).
    if let Some(p) = match_path.as_mut() {
        expand_home(std::slice::from_mut(p), home.as_deref())
            .map_err(|()| format!("{label}: cannot expand ~ in match.path: no home directory"))?;
    }
    let triggers = parse_triggers(raw.triggers, &id, warnings);
    let insert = parse_insert(raw.insert, &label, home.as_deref(), warnings);
    // `title` falls back to the id and the entry keeps both, so one copy is unavoidable.
    let title = match raw.title {
        Some(t) if !t.is_empty() => t,
        _ => id.clone(),
    };
    Ok(PluginEntry {
        id,
        title,
        command,
        match_path,
        match_remote,
        triggers,
        timeout_ms,
        interval_ms,
        enabled: raw.enabled.unwrap_or(true),
        scope,
        insert,
    })
}

/// A test plugin `probe` running `command`: enabled, tab-scoped, on
/// `activate`, with a 10 s timeout.
#[cfg(test)]
pub fn test_entry(command: &[&str]) -> PluginEntry {
    PluginEntry {
        id: "probe".to_owned(),
        title: "Probe".to_owned(),
        command: command.iter().map(|s| (*s).to_owned()).collect(),
        match_path: None,
        match_remote: None,
        triggers: vec![Trigger::Activate],
        timeout_ms: 10_000,
        interval_ms: None,
        enabled: true,
        scope: Scope::Tab,
        insert: InsertTarget::Draft,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A `widgets.json` in its own temp dir, removed on drop.
    struct TmpConfig {
        dir: PathBuf,
        path: PathBuf,
    }

    impl Drop for TmpConfig {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn tmp(name: &str, body: &[u8]) -> TmpConfig {
        let dir = std::env::temp_dir().join(format!("omp-widgets-{}-{}", std::process::id(), name));
        std::fs::create_dir_all(&dir).expect("tmp dir");
        let path = dir.join("widgets.json");
        std::fs::write(&path, body).expect("write");
        TmpConfig { dir, path }
    }

    fn load_body(name: &str, body: &[u8]) -> Result<WidgetConfig, String> {
        load(&tmp(name, body).path)
    }

    fn ids(c: &WidgetConfig) -> Vec<&str> {
        c.plugins.iter().map(|p| p.id.as_str()).collect()
    }

    fn plugin(match_path: Option<&str>, match_remote: Option<&str>) -> PluginEntry {
        PluginEntry {
            id: "p".into(),
            title: "P".into(),
            command: vec!["x".into()],
            match_path: match_path.map(String::from),
            match_remote: match_remote.map(String::from),
            triggers: vec![Trigger::Activate],
            timeout_ms: TIMEOUT_MIN_MS,
            interval_ms: None,
            enabled: true,
            scope: Scope::Tab,
            insert: InsertTarget::Draft,
        }
    }

    #[test]
    fn missing_file_is_empty_config() {
        let p = std::env::temp_dir().join("omp-widgets-does-not-exist/widgets.json");
        let c = load(&p).expect("missing file is ok");
        assert_eq!(c.plugins, Vec::<PluginEntry>::new());
        assert_eq!(c.errors, Vec::<String>::new());
    }

    #[test]
    fn config_rejects_a_bom() {
        let err = load_body("bom", b"\xEF\xBB\xBF{\"version\":1,\"plugins\":[]}")
            .expect_err("BOM must fail");
        assert!(err.contains("widgets.json"), "{err}");
    }

    #[test]
    fn config_rejects_a_trailing_comma() {
        let err = load_body("comma", br#"{"version":1,"plugins":[],}"#)
            .expect_err("trailing comma must fail");
        assert!(err.contains("widgets.json"), "{err}");
    }

    #[test]
    fn config_rejects_unknown_version() {
        let err = load_body("v2", br#"{"version":2,"plugins":[]}"#).expect_err("version 2");
        assert!(err.contains("version 2"), "{err}");
    }

    #[test]
    fn config_rejects_missing_version() {
        let err = load_body("nov", br#"{"plugins":[]}"#).expect_err("no version");
        assert_eq!(err, "widgets.json: missing \"version\"");
    }

    #[test]
    fn entry_defaults_and_clamps() {
        let c = load_body(
            "defaults",
            br#"{"version":1,"plugins":[
            {"id":"git","title":"Git","command":["bash","x.sh"]},
            {"id":"slow","title":"Slow","command":["sleep"],"timeoutMs":999999,"triggers":["branch"],"enabled":false},
            {"id":"int","title":"Interval","command":["date"],"intervalMs":1000},
            {"id":"big","title":"Big","command":["date"],"intervalMs":1000000000},
            {"id":"fast","command":["date"],"timeoutMs":5},
            {"id":"zero","command":["date"],"intervalMs":0}
        ]}"#,
        )
        .expect("ok");
        assert_eq!(c.errors, Vec::<String>::new());
        assert_eq!(c.plugins.len(), 6);
        let git = &c.plugins[0];
        assert_eq!(git.timeout_ms, TIMEOUT_DEFAULT_MS);
        assert_eq!(git.triggers, Vec::from(CONFIG_TRIGGERS));
        assert!(git.enabled);
        assert_eq!(git.interval_ms, None);
        assert_eq!(git.scope, Scope::Tab);
        let slow = &c.plugins[1];
        assert_eq!(slow.timeout_ms, TIMEOUT_MAX_MS);
        assert_eq!(slow.triggers, vec![Trigger::Branch]);
        assert!(!slow.enabled);
        assert_eq!(c.plugins[2].interval_ms, Some(INTERVAL_MIN_MS));
        assert_eq!(c.plugins[3].interval_ms, Some(INTERVAL_MAX_MS));
        assert_eq!(
            c.plugins[4].timeout_ms, TIMEOUT_MIN_MS,
            "raised to the minimum"
        );
        assert_eq!(c.plugins[4].title, "fast", "title falls back to the id");
        assert_eq!(c.plugins[5].interval_ms, None, "0 means no interval");
    }

    #[test]
    fn interval_and_unknown_triggers_are_reported_and_dropped() {
        let c = load_body(
            "triggers",
            br#"{"version":1,"plugins":[
            {"id":"a","command":["true"],"triggers":["interval","turnEnd","branch","manual","branch"]},
            {"id":"b","command":["true"],"triggers":[]}
        ]}"#,
        )
        .expect("ok");
        assert_eq!(ids(&c), vec!["a", "b"], "the entries stay valid");
        assert_eq!(c.plugins[0].triggers, vec![Trigger::Branch], "deduplicated");
        assert_eq!(c.plugins[1].triggers, Vec::<Trigger>::new());
        assert_eq!(
            c.errors,
            vec![
                "plugin \"a\": \"interval\" is not a valid trigger; set \"intervalMs\" instead"
                    .to_string(),
                "plugin \"a\": unknown trigger \"turnEnd\" (expected activate, turn_end, branch or manual)"
                    .to_string(),
            ]
        );
    }

    #[test]
    fn unknown_keys_are_reported_without_dropping_the_entry() {
        let c = load_body(
            "keys",
            br#"{"version":1,"plugin":[],"plugins":[
            {"id":"a","command":["true"],"timeout":5000,"interval_ms":20000,"match":{"path":"/x","remotes":"y"}},
            {"id":"Bad","cmd":["true"]}
        ]}"#,
        )
        .expect("ok");
        assert_eq!(ids(&c), vec!["a"]);
        let a = &c.plugins[0];
        assert_eq!(a.timeout_ms, TIMEOUT_DEFAULT_MS, "the typo is not read");
        assert_eq!(a.interval_ms, None);
        assert_eq!(a.match_path.as_deref(), Some("/x"));
        assert_eq!(
            c.errors,
            vec![
                "widgets.json: unknown key \"plugin\"".to_string(),
                "plugin \"a\": unknown key \"interval_ms\"".to_string(),
                "plugin \"a\": unknown key \"timeout\"".to_string(),
                "plugin \"a\": unknown key \"match.remotes\"".to_string(),
                "plugin #1: unknown key \"cmd\"".to_string(),
                "plugin #1: id \"Bad\" must match [a-z0-9-]{1,32}".to_string(),
            ]
        );
    }

    #[test]
    fn bad_entries_are_reported_not_fatal() {
        let c = load_body(
            "bad",
            br#"{"version":1,"plugins":[
            {"id":"Bad Id","title":"x","command":["a"]},
            {"id":"dup","title":"x","command":["a"]},
            {"id":"dup","title":"y","command":["b"]},
            {"id":"nocmd","title":"x","command":[]},
            {"id":"ok","title":"Ok","command":["true"]}
        ]}"#,
        )
        .expect("ok");
        assert_eq!(ids(&c), vec!["dup", "ok"]);
        assert_eq!(c.plugins[0].title, "x", "first duplicate wins");
        assert_eq!(c.errors.len(), 3, "{:?}", c.errors);
        assert!(c.errors.iter().any(|e| e.contains("Bad Id")));
        assert!(c.errors.iter().any(|e| e.contains("duplicate")));
        assert!(c.errors.iter().any(|e| e.contains("nocmd")));
    }

    #[test]
    fn relative_command_paths_are_rejected() {
        let abs = if cfg!(windows) {
            "C:\\x\\run"
        } else {
            "/abs/x"
        };
        let body = format!(
            r#"{{"version":1,"plugins":[
            {{"id":"dot","command":["./x"]}},
            {{"id":"sub","command":["bin/x"]}},
            {{"id":"back","command":["bin\\x"]}},
            {{"id":"abs","command":[{abs:?}]}},
            {{"id":"bare","command":["bash"]}}
        ]}}"#
        );
        let c = load_body("argv0", body.as_bytes()).expect("ok");
        assert_eq!(ids(&c), vec!["abs", "bare"]);
        assert_eq!(c.errors.len(), 3, "{:?}", c.errors);
        assert!(
            c.errors
                .iter()
                .all(|e| e.contains("command path must be absolute or a bare program name")),
            "{:?}",
            c.errors
        );
    }

    #[test]
    fn leading_tilde_is_expanded_in_every_argv_element() {
        let mut cmd = ["~/bin/run", "~/conf.json", "~x", "~", "a~/b"].map(String::from);
        expand_home(&mut cmd, Some("/home/u")).expect("home set");
        assert_eq!(
            cmd,
            [
                Path::new("/home/u").join("bin/run"),
                Path::new("/home/u").join("conf.json"),
                "~x".into(),
                "~".into(),
                "a~/b".into(),
            ]
            .map(|p| p.to_string_lossy().into_owned())
        );
    }

    #[test]
    fn tilde_without_home_is_an_error_but_plain_commands_pass() {
        let mut cmd = ["~/x".to_string()];
        assert!(expand_home(&mut cmd, None).is_err());
        let mut plain = ["bash".to_string(), "~x".to_string()];
        assert!(expand_home(&mut plain, None).is_ok());
    }

    #[test]
    fn tilde_command_passes_the_absolute_check() {
        let Some(home) = home_dir() else { return };
        let c = load_body(
            "tilde",
            br#"{"version":1,"plugins":[
            {"id":"t","command":["~/.omp-desktop/widgets/x","~/arg"]},
            {"id":"u","command":["~x"]}
        ]}"#,
        )
        .expect("ok");
        let expected = |rest: &str| Path::new(&home).join(rest).to_string_lossy().into_owned();
        assert_eq!(c.plugins.len(), 2, "{:?}", c.errors);
        assert_eq!(
            c.plugins[0].command,
            [expected(".omp-desktop/widgets/x"), expected("arg")]
        );
        // `~x` is left alone: a bare program name.
        assert_eq!(c.plugins[1].command, ["~x"]);
    }

    #[test]
    fn tilde_in_match_path_is_expanded() {
        let Some(home) = home_dir() else { return };
        let c = load_body(
            "tilde-match",
            br#"{"version":1,"plugins":[
            {"id":"t","command":["true"],"match":{"path":"~/GIT/work","remote":"~/kept"}}
        ]}"#,
        )
        .expect("ok");
        assert_eq!(
            c.plugins[0].match_path.as_deref(),
            Some(Path::new(&home).join("GIT/work").to_string_lossy().as_ref())
        );
        // `remote` is a substring, never a path.
        assert_eq!(c.plugins[0].match_remote.as_deref(), Some("~/kept"));
    }

    #[test]
    fn empty_matchers_are_absent() {
        let c = load_body(
            "empty-match",
            br#"{"version":1,"plugins":[{"id":"t","command":["true"],"match":{"path":"","remote":""}}]}"#,
        )
        .expect("ok");
        assert_eq!(c.plugins[0].match_path, None);
        assert_eq!(c.plugins[0].match_remote, None);
    }

    #[test]
    fn plugin_count_is_capped() {
        let entries: Vec<String> = (0..=MAX_PLUGINS)
            .map(|i| format!(r#"{{"id":"p{i}","command":["true"]}}"#))
            .collect();
        let body = format!(r#"{{"version":1,"plugins":[{}]}}"#, entries.join(","));
        let c = load_body("cap", body.as_bytes()).expect("ok");
        assert_eq!(c.plugins.len(), MAX_PLUGINS);
        assert_eq!(
            c.errors,
            vec!["widgets.json: 1 plugin entries ignored (at most 32 are read)".to_string()]
        );
    }

    #[test]
    fn bad_entry_types_are_isolated() {
        let c = load_body(
            "types",
            br#"{"version":1,"plugins":[
            {"id":"bad","command":"true"},
            {"id":"ok","command":["true"]},
            {"id":"x","title":5,"command":["a"]}
        ]}"#,
        )
        .expect("entry type errors are not fatal");
        assert_eq!(ids(&c), vec!["ok"]);
        assert_eq!(c.errors.len(), 2, "{:?}", c.errors);
        assert!(c.errors.iter().any(|e| e.contains("#0")), "{:?}", c.errors);
        assert!(c.errors.iter().any(|e| e.contains("#2")), "{:?}", c.errors);
    }

    #[test]
    fn scope_defaults_to_tab_and_rejects_unknown_values() {
        let c = load_body(
            "scope",
            br#"{"version":1,"plugins":[
            {"id":"a","command":["true"]},
            {"id":"b","command":["true"],"scope":"global"},
            {"id":"c","command":["true"],"scope":"tab"},
            {"id":"d","command":["true"],"scope":"window"}
        ]}"#,
        )
        .expect("ok");
        let scopes: Vec<_> = c.plugins.iter().map(|p| (p.id.as_str(), p.scope)).collect();
        assert_eq!(
            scopes,
            vec![("a", Scope::Tab), ("b", Scope::Global), ("c", Scope::Tab)]
        );
        assert_eq!(
            c.errors,
            vec!["plugin \"d\": scope must be \"tab\" or \"global\"".to_string()]
        );
    }

    #[test]
    fn config_trigger_names_parse() {
        let names = ["activate", "turn_end", "branch"].map(String::from);
        let mut warnings = Vec::new();
        assert_eq!(
            parse_triggers(Some(Vec::from(names)), "p", &mut warnings),
            CONFIG_TRIGGERS
        );
        assert!(warnings.is_empty(), "{warnings:?}");
    }

    /// `new-tab` project directories: one real, one missing, in the temp dir.
    fn insert_dirs(name: &str) -> (PathBuf, PathBuf) {
        let real = std::env::temp_dir().join(format!("omp-insert-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&real).expect("project dir");
        let missing = real.join("missing");
        (real, missing)
    }

    fn insert_body(insert: &str) -> String {
        format!(r#"{{"version":1,"plugins":[{{"id":"a","command":["true"],"insert":{insert}}}]}}"#)
    }

    #[test]
    fn insert_defaults_to_draft() {
        let c = load_body(
            "insert-none",
            br#"{"version":1,"plugins":[{"id":"a","command":["true"]}]}"#,
        )
        .expect("ok");
        assert_eq!(c.plugins[0].insert, InsertTarget::Draft);
        assert_eq!(c.errors, Vec::<String>::new());
        let d = load_body(
            "insert-draft",
            insert_body(r#"{"target":"draft"}"#).as_bytes(),
        )
        .expect("ok");
        assert_eq!(d.plugins[0].insert, InsertTarget::Draft);
        assert_eq!(d.errors, Vec::<String>::new());
    }

    #[test]
    fn insert_new_tab_takes_an_existing_directory() {
        let (real, _) = insert_dirs("ok");
        let expected = external_open::canonical_folder(&real).expect("canonical");
        let raw = real.to_string_lossy().into_owned();
        let body = insert_body(&format!(r#"{{"target":"new-tab","project":{raw:?}}}"#));
        let c = load_body("insert-ok", body.as_bytes()).expect("ok");
        let _ = std::fs::remove_dir_all(&real);
        assert_eq!(c.errors, Vec::<String>::new());
        assert_eq!(
            c.plugins[0].insert,
            InsertTarget::NewTab { project: expected }
        );
    }

    #[test]
    fn insert_new_tab_expands_tilde() {
        let Some(home) = home_dir() else { return };
        let Ok(expected) = external_open::canonical_folder(Path::new(&home)) else {
            return;
        };
        let c = load_body(
            "insert-tilde",
            insert_body(r#"{"target":"new-tab","project":"~/"}"#).as_bytes(),
        )
        .expect("ok");
        assert_eq!(c.errors, Vec::<String>::new());
        assert_eq!(
            c.plugins[0].insert,
            InsertTarget::NewTab { project: expected }
        );
    }

    #[test]
    fn insert_problems_fall_back_to_draft_and_keep_the_plugin() {
        let (real, missing) = insert_dirs("bad");
        let missing = missing.to_string_lossy().into_owned();
        let file = real.join("f");
        std::fs::write(&file, "x").expect("file");
        let file = file.to_string_lossy().into_owned();
        let cases = [
            (
                r#"{"target":"new-tab"}"#.to_string(),
                "needs insert.project",
            ),
            (
                r#"{"target":"new-tab","project":""}"#.to_string(),
                "needs insert.project",
            ),
            (
                r#"{"target":"new-tab","project":"rel/dir"}"#.to_string(),
                "absolute path",
            ),
            (
                format!(r#"{{"target":"new-tab","project":{missing:?}}}"#),
                "not an existing directory",
            ),
            (
                format!(r#"{{"target":"new-tab","project":{file:?}}}"#),
                "not an existing directory",
            ),
            (
                r#"{"target":"tab"}"#.to_string(),
                "unknown insert.target \"tab\"",
            ),
            (r#""new-tab""#.to_string(), "insert must be an object"),
            (r#"{"target":5}"#.to_string(), "insert must be an object"),
        ];
        for (i, (insert, needle)) in cases.iter().enumerate() {
            let c =
                load_body(&format!("insert-bad{i}"), insert_body(insert).as_bytes()).expect("ok");
            assert_eq!(ids(&c), vec!["a"], "{insert}: the plugin still loads");
            assert_eq!(c.plugins[0].insert, InsertTarget::Draft, "{insert}");
            assert_eq!(c.errors.len(), 1, "{insert}: {:?}", c.errors);
            assert!(c.errors[0].starts_with("plugin \"a\": "), "{:?}", c.errors);
            assert!(c.errors[0].contains(needle), "{insert}: {:?}", c.errors);
        }
        let _ = std::fs::remove_dir_all(&real);
    }

    #[test]
    fn insert_new_tab_canonicalises_parent_segments_and_symlinks() {
        let (real, _) = insert_dirs("canon");
        let target = real.join("target");
        std::fs::create_dir_all(&target).expect("target dir");
        let expected = external_open::canonical_folder(&target).expect("canonical");
        let via_parent = target
            .join("..")
            .join("target")
            .to_string_lossy()
            .into_owned();
        let body = insert_body(&format!(
            r#"{{"target":"new-tab","project":{via_parent:?}}}"#
        ));
        let c = load_body("insert-canon", body.as_bytes()).expect("ok");
        assert_eq!(c.errors, Vec::<String>::new());
        #[cfg(unix)]
        {
            let link = real.join("link");
            std::os::unix::fs::symlink(&target, &link).expect("symlink");
            let via_link = link.to_string_lossy().into_owned();
            let body = insert_body(&format!(r#"{{"target":"new-tab","project":{via_link:?}}}"#));
            let d = load_body("insert-canon-link", body.as_bytes()).expect("ok");
            assert_eq!(d.errors, Vec::<String>::new());
            assert_eq!(d.plugins[0].insert, c.plugins[0].insert);
        }
        assert_eq!(
            c.plugins[0].insert,
            InsertTarget::NewTab { project: expected }
        );
        let _ = std::fs::remove_dir_all(&real);
    }

    #[test]
    fn insert_unknown_keys_are_reported() {
        let c = load_body(
            "insert-keys",
            insert_body(r#"{"target":"draft","send":true}"#).as_bytes(),
        )
        .expect("ok");
        assert_eq!(c.plugins[0].insert, InsertTarget::Draft);
        assert_eq!(
            c.errors,
            vec!["plugin \"a\": unknown key \"insert.send\"".to_string()]
        );
    }

    #[test]
    fn insert_unknown_key_keeps_a_valid_new_tab() {
        let (real, _) = insert_dirs("keys-new-tab");
        let expected = external_open::canonical_folder(&real).expect("canonical");
        let raw = real.to_string_lossy().into_owned();
        let body = insert_body(&format!(
            r#"{{"target":"new-tab","project":{raw:?},"send":true}}"#
        ));
        let c = load_body("insert-keys-new-tab", body.as_bytes()).expect("ok");
        let _ = std::fs::remove_dir_all(&real);
        // An unknown inner key warns like any other unknown key; only a bad
        // value (not a typo beside one) falls back to Draft.
        assert_eq!(ids(&c), vec!["a"]);
        assert_eq!(
            c.errors,
            vec!["plugin \"a\": unknown key \"insert.send\"".to_string()]
        );
        assert_eq!(
            c.plugins[0].insert,
            InsertTarget::NewTab { project: expected }
        );
    }

    #[test]
    fn insert_null_fields_count_as_absent() {
        for insert in [
            r#"{"target":null}"#,
            r#"{"target":null,"project":null}"#,
            r#"{"target":"draft","project":null}"#,
        ] {
            let c = load_body("insert-null", insert_body(insert).as_bytes()).expect("ok");
            assert_eq!(ids(&c), vec!["a"], "{insert}");
            assert_eq!(c.plugins[0].insert, InsertTarget::Draft, "{insert}");
            assert_eq!(c.errors, Vec::<String>::new(), "{insert}: {:?}", c.errors);
        }
    }

    #[test]
    fn insert_project_without_new_tab_warns_and_stays_draft() {
        for insert in [
            r#"{"target":"draft","project":"/p"}"#,
            r#"{"project":"/p"}"#,
        ] {
            let c = load_body("insert-unused-project", insert_body(insert).as_bytes()).expect("ok");
            assert_eq!(c.plugins[0].insert, InsertTarget::Draft, "{insert}");
            assert_eq!(c.errors.len(), 1, "{insert}: {:?}", c.errors);
            assert!(
                c.errors[0].contains("insert.project is only used with insert.target \"new-tab\""),
                "{insert}: {:?}",
                c.errors
            );
        }
    }

    #[test]
    fn insert_tilde_project_without_home_falls_back_to_draft() {
        let mut warnings = Vec::new();
        let insert = parse_insert(
            Some(serde_json::json!({"target": "new-tab", "project": "~/work"})),
            "plugin \"a\"",
            None,
            &mut warnings,
        );
        assert_eq!(insert, InsertTarget::Draft);
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(
            warnings[0].contains("cannot expand ~ in insert.project: no home directory"),
            "{warnings:?}"
        );
    }

    #[test]
    fn insert_serialises_with_a_kebab_target() {
        assert_eq!(
            serde_json::to_value(InsertTarget::Draft).expect("serialize"),
            serde_json::json!({"target": "draft"})
        );
        assert_eq!(
            serde_json::to_value(InsertTarget::NewTab {
                project: "/p".into()
            })
            .expect("serialize"),
            serde_json::json!({"target": "new-tab", "project": "/p"})
        );
    }

    #[test]
    fn scope_serialises_snake_case() {
        assert_eq!(
            serde_json::to_value(Scope::Global).expect("serialize"),
            serde_json::Value::from("global")
        );
    }

    #[test]
    fn no_matcher_applies_everywhere() {
        let p = plugin(None, None);
        assert!(p.matches("/a", ""));
        assert!(p.matches("", ""), "tab without a project");
    }

    #[test]
    fn path_prefix_and_remote_substring_must_both_match_when_given() {
        let a = plugin(Some("/Users/me/GIT"), None);
        let b = plugin(None, Some("gitlab.example"));
        let c = plugin(Some("/Users/me/GIT"), Some("gitlab.example"));
        let applicable = |project: &str, remote: &str| {
            [("a", &a), ("b", &b), ("c", &c)]
                .into_iter()
                .filter(|(_, p)| p.matches(project, remote))
                .map(|(id, _)| id)
                .collect::<Vec<_>>()
        };
        let remote = "git@gitlab.example:g/x.git";
        assert_eq!(applicable("/Users/me/GIT/x", remote), vec!["a", "b", "c"]);
        assert_eq!(applicable("/tmp/x", remote), vec!["b"]);
        assert_eq!(applicable("/Users/me/GIT/x", ""), vec!["a"]);
    }

    #[test]
    fn path_match_is_prefix_on_separators_not_characters() {
        let p = plugin(Some("/Users/me/GIT"), None);
        assert!(!p.matches("/Users/me/GITHUB/x", ""));
        assert!(p.matches("/Users/me/GIT", ""), "the folder itself");
        assert!(p.matches("/Users/me/GIT/", ""), "trailing separator");
        assert!(!p.matches("/Users/me", ""), "a parent is not inside");
        assert!(!p.matches("", ""), "tab without a project");
        assert!(plugin(Some("/Users/me/GIT/"), None).matches("/Users/me/GIT/x", ""));
    }

    #[test]
    fn path_match_normalises_backslashes() {
        let p = plugin(Some("C:\\Users\\me\\GIT"), None);
        assert!(p.matches("C:\\Users\\me\\GIT\\x", ""));
        assert!(p.matches("C:/Users/me/GIT/x", ""));
        assert!(!p.matches("C:\\Users\\me\\GITHUB", ""));
        assert!(plugin(Some("/a/b"), None).matches("\\a\\b\\c", ""));
    }

    #[test]
    fn root_match_path_matches_any_absolute_project_only() {
        let p = plugin(Some("/"), None);
        assert!(p.matches("/a/b", ""));
        assert!(p.matches("/", ""));
        assert!(p.matches("\\a", ""));
        assert!(!p.matches("relative/x", ""));
        assert!(!p.matches("", ""));
        assert!(plugin(Some("//"), None).matches("/a", ""));
    }

    #[test]
    fn remote_match_is_a_plain_substring() {
        let p = plugin(None, Some("example.com/team"));
        assert!(p.matches("", "https://example.com/team/x.git"));
        assert!(!p.matches("", "https://example.com/other/x.git"));
        assert!(!p.matches("", ""), "no remote");
    }

    #[test]
    fn wants_honours_the_list_and_always_allows_manual() {
        let mut p = plugin(None, None);
        p.triggers = vec![Trigger::Branch];
        assert!(p.wants(Trigger::Branch));
        assert!(!p.wants(Trigger::TurnEnd));
        assert!(!p.wants(Trigger::Activate));
        assert!(p.wants(Trigger::Manual));
        p.triggers.clear();
        assert!(p.wants(Trigger::Manual));
    }

    #[test]
    fn wants_interval_exactly_when_interval_ms_is_set() {
        let mut p = plugin(None, None);
        assert!(!p.wants(Trigger::Interval));
        p.interval_ms = Some(60_000);
        p.triggers.clear();
        assert!(
            p.wants(Trigger::Interval),
            "interval ignores the triggers list"
        );
    }
}
