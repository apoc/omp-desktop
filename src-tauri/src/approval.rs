//! Desktop-side tool-approval rules.
//!
//! omp's own default approval tier (`always-ask`) is overridden per-session
//! to `write` (see `agent::spawn::omp_args`) so exec-tier tools stop
//! auto-approving silently — a desktop product should never inherit that
//! quietly. That means every such tool call now surfaces an
//! `extension_ui_request` the human has to click through. A [`RuleBook`]
//! lets the human grant a standing "yes" for one tool name, scoped either
//! to the current session (in-memory, dies with the process) or to the
//! project (persisted to disk, survives restarts) — so they don't have to
//! re-approve `bash` on every single call.
//!
//! A rule can only ever answer **Approve**; it never auto-denies. Anything
//! not covered by a rule keeps falling through to the human — this module
//! narrows what auto-answers, it never widens what gets asked.
//!
//! [`approval_tool_name`] recognises the *exact* prompt shape omp emits for
//! a tool-approval request (`method:"select"`, `options:["Approve","Deny"]`,
//! title `Allow tool: <name>`) and refuses to match anything else — a rule
//! can never accidentally answer an unrelated `select` prompt (e.g. the ask
//! tool, a login provider picker).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use crate::json_store;

/// The exact two options omp's tool-approval prompt offers, in order.
const APPROVAL_OPTIONS: [&str; 2] = ["Approve", "Deny"];
const TITLE_PREFIX: &str = "Allow tool: ";
const RULES_FILE_VERSION: u32 = 1;

/// Where a granted rule lives: in-memory only (dies with the process) or
/// persisted to disk under this project's rules file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleScope {
    Session,
    Project,
}

/// One granted rule. Always means "Approve" — see the module doc comment
/// for why a rule never auto-denies.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub tool: String,
    pub scope: RuleScope,
    /// ISO-8601 grant time — audit/display only, never compared.
    pub granted_at: String,
}

/// On-disk shape of a project's rules file.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct ProjectRulesFile {
    version: u32,
    rules: Vec<PersistedRule>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PersistedRule {
    tool: String,
    granted_at: String,
}

/// Extract the tool name from an `extension_ui_request` frame **iff** it is
/// shaped exactly like omp's tool-approval prompt. Returns `None` for any
/// other shape — including a generic `select` prompt with different
/// options, or a title that merely starts similarly — so a rule can only
/// ever answer this one specific prompt.
pub fn approval_tool_name(frame: &serde_json::Value) -> Option<&str> {
    if frame.get("type").and_then(serde_json::Value::as_str) != Some("extension_ui_request") {
        return None;
    }
    if frame.get("method").and_then(serde_json::Value::as_str) != Some("select") {
        return None;
    }
    let options = frame.get("options")?.as_array()?;
    if options.len() != APPROVAL_OPTIONS.len() {
        return None;
    }
    for (opt, expected) in options.iter().zip(APPROVAL_OPTIONS.iter()) {
        if opt.as_str() != Some(*expected) {
            return None;
        }
    }
    let title = frame.get("title").and_then(serde_json::Value::as_str)?;
    let name = title.strip_prefix(TITLE_PREFIX)?;
    is_valid_tool_name(name).then_some(name)
}

/// The request `id` an `approval_tool_name`-matched frame carries, needed
/// to construct the `extension_ui_response` that answers it.
pub fn approval_request_id(frame: &serde_json::Value) -> Option<&str> {
    frame.get("id").and_then(serde_json::Value::as_str)
}

/// Mirrors the tool-name grammar omp's own approval-prompt formatter uses:
/// starts with an alphanumeric, then up to 63 more alphanumerics or
/// `_`, `.`, `:`, `-`.
fn is_valid_tool_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    name.len() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
}

/// Stable per-project key: first 32 hex chars of `sha256(canonicalized project root)`.
/// Falls back to hashing the raw (uncanonicalized) path if canonicalization
/// fails (e.g. the directory doesn't exist yet) rather than erroring —
/// grants are keyed consistently either way as long as the path string
/// itself doesn't change.
fn project_key(project_root: &Path) -> String {
    let canon = project_root
        .canonicalize()
        .unwrap_or_else(|_| project_root.to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(canon.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    digest.iter().take(16).fold(String::new(), |mut acc, b| {
        use std::fmt::Write as _;
        let _ = write!(acc, "{b:02x}");
        acc
    })
}

fn now_iso8601() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    // Minimal dependency-free RFC3339-ish timestamp (UTC, second precision) —
    // good enough for an audit/display field that is never parsed back.
    humantime_utc(secs)
}

/// Render `secs` (Unix epoch, UTC) as `YYYY-MM-DDTHH:MM:SSZ` without pulling
/// in a datetime crate — this project has none, and the field is
/// display-only (see [`Rule::granted_at`]).
fn humantime_utc(secs: u64) -> String {
    const DAYS_IN_MONTH_NONLEAP: [u64; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let days_total = secs / 86400;
    let day_secs = secs % 86400;
    let (hour, minute, second) = (day_secs / 3600, (day_secs % 3600) / 60, day_secs % 60);

    let mut year = 1970i64;
    let mut days_left = days_total.cast_signed();
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let year_days = if leap { 366 } else { 365 };
        if days_left < year_days {
            break;
        }
        days_left -= year_days;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let mut month = 1u32;
    for (i, &dim) in DAYS_IN_MONTH_NONLEAP.iter().enumerate() {
        let dim = if i == 1 && leap { dim + 1 } else { dim };
        if days_left < dim.cast_signed() {
            month = u32::try_from(i + 1).unwrap_or(1);
            break;
        }
        days_left -= dim.cast_signed();
    }
    let day = days_left + 1;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Session- and project-scoped tool-approval grants.
///
/// Project rules are lazily loaded from disk on first access per project
/// and cached in memory thereafter; a read error (missing/corrupt file) is
/// treated as an empty rule set rather than failing the caller — fail
/// closed toward "no grants", never toward blocking the whole app.
pub struct RuleBook {
    config_root: PathBuf,
    project_rules: Mutex<HashMap<String, Vec<Rule>>>,
    session_rules: Mutex<HashMap<String, HashSet<String>>>,
}

impl RuleBook {
    /// `config_root`: directory under which each project's rules file is
    /// stored, e.g. `<app_config_dir>/approval-rules`. Created lazily on
    /// first write; safe to pass a path that doesn't exist yet.
    pub fn new(config_root: PathBuf) -> Self {
        Self {
            config_root,
            project_rules: Mutex::new(HashMap::new()),
            session_rules: Mutex::new(HashMap::new()),
        }
    }

    fn project_file_path(&self, project_root: &Path) -> PathBuf {
        self.config_root
            .join(format!("{}.json", project_key(project_root)))
    }

    /// Where past versions of a project's rules file are kept — see
    /// [`json_store::SnapshotRing`]. Consulted by `load_project_rules` when
    /// the primary file is missing/corrupt, and written to by
    /// `persist_project_rules` before every overwrite.
    fn snapshot_ring(&self, project_root: &Path) -> json_store::SnapshotRing {
        json_store::SnapshotRing::new(
            self.config_root
                .join(format!("{}.snapshots", project_key(project_root))),
            8,
        )
    }

    /// Advisory lock path guarding the read-modify-write cycle in
    /// `grant`/`revoke` for one project — without it, two tabs granting
    /// different tools for the same project concurrently could race and
    /// one grant could clobber the other on disk (the in-memory cache
    /// update is per-process anyway; the lock protects the file).
    fn lock_path(&self, project_root: &Path) -> PathBuf {
        self.config_root
            .join(format!("{}.lock", project_key(project_root)))
    }

    /// Run `f` (a project rules read-modify-write) while holding the
    /// advisory lock at [`Self::lock_path`]. Converts `f`'s `String` error
    /// through `io::Error` and back so it can use [`json_store::with_lock`]
    /// without that module knowing about this one's error type.
    fn with_project_lock<T>(
        &self,
        project_root: &Path,
        f: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        json_store::with_lock(
            &self.lock_path(project_root),
            std::time::Duration::from_secs(5),
            || f().map_err(std::io::Error::other),
        )
        .map_err(|e| e.to_string())
    }

    /// Load (or return the cached copy of) a project's persisted rules. A
    /// primary file that's missing or fails to parse falls back to the
    /// most recent valid snapshot (see [`Self::snapshot_ring`]) before
    /// giving up and treating the project as having no rules at all.
    fn load_project_rules(&self, project_root: &Path) -> Vec<Rule> {
        let Ok(mut cache) = self.project_rules.lock() else {
            return Vec::new();
        };
        let key = project_key(project_root);
        if let Some(rules) = cache.get(&key) {
            return rules.clone();
        }
        let path = self.project_file_path(project_root);
        let raw = std::fs::read(&path).ok().or_else(|| {
            self.snapshot_ring(project_root)
                .restore_latest()
                .ok()
                .flatten()
        });
        let rules: Vec<Rule> = raw
            .and_then(|bytes| serde_json::from_slice::<ProjectRulesFile>(&bytes).ok())
            .map(|file| {
                file.rules
                    .into_iter()
                    .map(|r| Rule {
                        tool: r.tool,
                        scope: RuleScope::Project,
                        granted_at: r.granted_at,
                    })
                    .collect()
            })
            .unwrap_or_default();
        cache.insert(key, rules.clone());
        rules
    }

    /// Snapshot the file's current on-disk contents (if any) before
    /// overwriting it — recovery path for `load_project_rules` above — then
    /// write the new contents atomically.
    fn persist_project_rules(&self, project_root: &Path, rules: &[Rule]) -> Result<(), String> {
        let file = ProjectRulesFile {
            version: RULES_FILE_VERSION,
            rules: rules
                .iter()
                .map(|r| PersistedRule {
                    tool: r.tool.clone(),
                    granted_at: r.granted_at.clone(),
                })
                .collect(),
        };
        let bytes = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
        let path = self.project_file_path(project_root);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        if let Ok(existing) = std::fs::read(&path) {
            // Best-effort — a failed snapshot must never block the actual
            // write, it only narrows future recovery options.
            let _ = self
                .snapshot_ring(project_root)
                .snapshot(&existing, "pre-write");
        }
        json_store::write_atomic(&path, &bytes).map_err(|e| e.to_string())
    }

    /// Grant standing approval for `tool`. `project_root` is required for
    /// `RuleScope::Project` (an error is returned without it); ignored for
    /// `RuleScope::Session`. Re-granting an already-granted tool is a no-op
    /// success, not an error.
    pub fn grant(
        &self,
        session_id: &str,
        project_root: Option<&Path>,
        tool: &str,
        scope: RuleScope,
    ) -> Result<(), String> {
        if !is_valid_tool_name(tool) {
            return Err(format!("'{tool}' is not a valid tool name"));
        }
        match scope {
            RuleScope::Session => {
                if let Ok(mut sessions) = self.session_rules.lock() {
                    sessions
                        .entry(session_id.to_string())
                        .or_default()
                        .insert(tool.to_string());
                }
                Ok(())
            }
            RuleScope::Project => {
                let root = project_root
                    .ok_or_else(|| "project-scoped grant requires a project root".to_string())?;
                self.with_project_lock(root, || {
                    let mut rules = self.load_project_rules(root);
                    if !rules.iter().any(|r| r.tool == tool) {
                        rules.push(Rule {
                            tool: tool.to_string(),
                            scope: RuleScope::Project,
                            granted_at: now_iso8601(),
                        });
                    }
                    self.persist_project_rules(root, &rules)?;
                    if let Ok(mut cache) = self.project_rules.lock() {
                        cache.insert(project_key(root), rules);
                    }
                    Ok(())
                })
            }
        }
    }

    /// Revoke a previously granted rule. No-op (not an error) if it wasn't granted.
    pub fn revoke(
        &self,
        session_id: &str,
        project_root: Option<&Path>,
        tool: &str,
        scope: RuleScope,
    ) -> Result<(), String> {
        match scope {
            RuleScope::Session => {
                if let Ok(mut sessions) = self.session_rules.lock() {
                    if let Some(set) = sessions.get_mut(session_id) {
                        set.remove(tool);
                    }
                }
                Ok(())
            }
            RuleScope::Project => {
                let root = project_root
                    .ok_or_else(|| "project-scoped revoke requires a project root".to_string())?;
                self.with_project_lock(root, || {
                    let mut rules = self.load_project_rules(root);
                    rules.retain(|r| r.tool != tool);
                    self.persist_project_rules(root, &rules)?;
                    if let Ok(mut cache) = self.project_rules.lock() {
                        cache.insert(project_key(root), rules);
                    }
                    Ok(())
                })
            }
        }
    }

    /// All rules currently in effect for this session/project pair —
    /// session-scoped first, then project-scoped.
    pub fn list(&self, session_id: &str, project_root: Option<&Path>) -> Vec<Rule> {
        let mut out = Vec::new();
        if let Ok(sessions) = self.session_rules.lock() {
            if let Some(set) = sessions.get(session_id) {
                let mut tools: Vec<&String> = set.iter().collect();
                tools.sort();
                out.extend(tools.into_iter().map(|tool| Rule {
                    tool: tool.clone(),
                    scope: RuleScope::Session,
                    granted_at: String::new(),
                }));
            }
        }
        if let Some(root) = project_root {
            out.extend(self.load_project_rules(root));
        }
        out
    }

    /// Drop every session-scoped grant for `session_id`. Call when a
    /// session stops — session grants must not silently apply to whatever
    /// process later reuses the same id.
    pub fn clear_session(&self, session_id: &str) {
        if let Ok(mut sessions) = self.session_rules.lock() {
            sessions.remove(session_id);
        }
    }

    /// `true` if a currently-loaded rule (session or project scope) grants
    /// `tool` for this session/project pair. Pure lookup — never mutates,
    /// never touches disk beyond the same lazy-load `list`/`grant` already do.
    pub fn is_granted(&self, session_id: &str, project_root: Option<&Path>, tool: &str) -> bool {
        if let Ok(sessions) = self.session_rules.lock() {
            if sessions
                .get(session_id)
                .is_some_and(|set| set.contains(tool))
            {
                return true;
            }
        }
        if let Some(root) = project_root {
            if self.load_project_rules(root).iter().any(|r| r.tool == tool) {
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn scratch_dir() -> PathBuf {
        let n = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "omp-desktop-approval-test-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    #[test]
    fn approval_tool_name_matches_exact_prompt_shape() {
        let frame = json!({
            "type": "extension_ui_request",
            "id": "req-1",
            "method": "select",
            "title": "Allow tool: bash",
            "options": ["Approve", "Deny"]
        });
        assert_eq!(approval_tool_name(&frame), Some("bash"));
        assert_eq!(approval_request_id(&frame), Some("req-1"));
    }

    #[test]
    fn approval_tool_name_rejects_wrong_method() {
        let frame = json!({
            "type": "extension_ui_request", "method": "confirm",
            "title": "Allow tool: bash", "options": ["Approve", "Deny"]
        });
        assert_eq!(approval_tool_name(&frame), None);
    }

    #[test]
    fn approval_tool_name_rejects_wrong_options() {
        let frame = json!({
            "type": "extension_ui_request", "method": "select",
            "title": "Allow tool: bash", "options": ["Yes", "No"]
        });
        assert_eq!(approval_tool_name(&frame), None);
    }

    #[test]
    fn approval_tool_name_rejects_unrelated_select_prompt() {
        // A generic ask-tool select must never be answered by a rule.
        let frame = json!({
            "type": "extension_ui_request", "method": "select",
            "title": "Pick a color", "options": ["Approve", "Deny"]
        });
        assert_eq!(approval_tool_name(&frame), None);
    }

    #[test]
    fn approval_tool_name_rejects_invalid_tool_name_in_title() {
        let frame = json!({
            "type": "extension_ui_request", "method": "select",
            "title": "Allow tool: ../../etc/passwd", "options": ["Approve", "Deny"]
        });
        assert_eq!(approval_tool_name(&frame), None);
    }

    #[test]
    fn session_grant_is_visible_only_to_that_session() {
        let book = RuleBook::new(scratch_dir());
        book.grant("sess-a", None, "bash", RuleScope::Session)
            .unwrap();
        assert!(book.is_granted("sess-a", None, "bash"));
        assert!(!book.is_granted("sess-b", None, "bash"));
    }

    #[test]
    fn clear_session_drops_only_that_sessions_grants() {
        let book = RuleBook::new(scratch_dir());
        book.grant("sess-a", None, "bash", RuleScope::Session)
            .unwrap();
        book.grant("sess-b", None, "bash", RuleScope::Session)
            .unwrap();
        book.clear_session("sess-a");
        assert!(!book.is_granted("sess-a", None, "bash"));
        assert!(book.is_granted("sess-b", None, "bash"));
    }

    #[test]
    fn project_grant_persists_across_a_new_rulebook_instance() {
        let dir = scratch_dir();
        let project = scratch_dir(); // stand-in project root
        {
            let book = RuleBook::new(dir.clone());
            book.grant("sess-a", Some(&project), "bash", RuleScope::Project)
                .unwrap();
        }
        let book2 = RuleBook::new(dir);
        assert!(book2.is_granted("other-session", Some(&project), "bash"));
    }

    #[test]
    fn project_revoke_removes_a_persisted_grant() {
        let dir = scratch_dir();
        let project = scratch_dir();
        let book = RuleBook::new(dir);
        book.grant("sess-a", Some(&project), "bash", RuleScope::Project)
            .unwrap();
        assert!(book.is_granted("sess-a", Some(&project), "bash"));
        book.revoke("sess-a", Some(&project), "bash", RuleScope::Project)
            .unwrap();
        assert!(!book.is_granted("sess-a", Some(&project), "bash"));
    }

    #[test]
    fn project_grant_without_root_errors() {
        let book = RuleBook::new(scratch_dir());
        let err = book
            .grant("sess-a", None, "bash", RuleScope::Project)
            .unwrap_err();
        assert!(err.contains("project root"));
    }

    #[test]
    fn grant_rejects_invalid_tool_name() {
        let book = RuleBook::new(scratch_dir());
        let err = book
            .grant("sess-a", None, "../etc", RuleScope::Session)
            .unwrap_err();
        assert!(err.contains("not a valid tool name"));
    }

    #[test]
    fn regrant_is_idempotent_not_duplicated() {
        let dir = scratch_dir();
        let project = scratch_dir();
        let book = RuleBook::new(dir);
        book.grant("sess-a", Some(&project), "bash", RuleScope::Project)
            .unwrap();
        book.grant("sess-a", Some(&project), "bash", RuleScope::Project)
            .unwrap();
        let rules = book.list("sess-a", Some(&project));
        assert_eq!(rules.iter().filter(|r| r.tool == "bash").count(), 1);
    }

    #[test]
    fn corrupt_project_rules_file_treated_as_empty_not_fatal() {
        let dir = scratch_dir();
        let project = scratch_dir();
        let book = RuleBook::new(dir);
        std::fs::write(book.project_file_path(&project), b"not json").unwrap();
        assert!(!book.is_granted("sess-a", Some(&project), "bash"));
    }

    #[test]
    fn different_projects_get_independent_rule_files() {
        let dir = scratch_dir();
        let project_a = scratch_dir();
        let project_b = scratch_dir();
        let book = RuleBook::new(dir);
        book.grant("sess-a", Some(&project_a), "bash", RuleScope::Project)
            .unwrap();
        assert!(book.is_granted("sess-a", Some(&project_a), "bash"));
        assert!(!book.is_granted("sess-a", Some(&project_b), "bash"));
    }

    #[test]
    fn humantime_utc_renders_known_epoch_values() {
        assert_eq!(humantime_utc(0), "1970-01-01T00:00:00Z");
        // 2024-01-01T00:00:00Z
        assert_eq!(humantime_utc(1_704_067_200), "2024-01-01T00:00:00Z");
    }
}
