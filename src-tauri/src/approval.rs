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
//! title whose **first line** is `Allow tool: <name>`) and refuses to match
//! anything else — a rule can never accidentally answer an unrelated
//! `select` prompt (e.g. the ask tool, a login provider picker).
//!
//! The title is multi-line: omp joins `Allow tool: <name>` with an optional
//! `Origin:`/`Reason:` line and whatever the tool's own
//! `formatApprovalDetails()` returns (path, command, content preview —
//! elided at 2000 chars). Only the first line identifies the tool, so
//! everything after the first `\n` is ignored here; matching against the
//! whole title meant [`is_valid_tool_name`] rejected every real prompt and
//! no rule ever auto-answered.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

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
    // `lines()` drops the `\r` of a CRLF line ending, so a CRLF-framed
    // title can't smuggle one into the tool name; a lone trailing `\r`
    // (no `\n`) stays in the line and `is_valid_tool_name` rejects it.
    let name = title.lines().next()?.strip_prefix(TITLE_PREFIX)?;
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
    let mut hex = json_store::hex_sha256(canon.to_string_lossy().as_bytes());
    hex.truncate(32);
    hex
}

/// Every on-disk path derived from one project root, plus the key they all
/// share. Built once per public `RuleBook` method and threaded down, so the
/// `canonicalize()` syscall and SHA-256 behind [`project_key`] run once per
/// call instead of once per derived path — previously four to six times for
/// a single `grant`.
struct ProjectPaths {
    key: String,
    rules: PathBuf,
    snapshots: PathBuf,
    lock: PathBuf,
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

    /// Derive every per-project path from one [`project_key`] computation.
    ///
    /// - `rules` — the primary rules file.
    /// - `snapshots` — past versions of it (see [`json_store::SnapshotRing`]);
    ///   consulted by `load_project_rules` only when the primary file exists
    ///   but fails to parse (corrupt), never when it's merely missing, and
    ///   written by `persist_project_rules` before every overwrite.
    /// - `lock` — advisory lock guarding the read-modify-write cycle in
    ///   `grant`/`revoke`: without it, two tabs granting different tools for
    ///   the same project concurrently could race and one grant could clobber
    ///   the other on disk (the in-memory cache update is per-process anyway;
    ///   the lock protects the file).
    fn project_paths(&self, project_root: &Path) -> ProjectPaths {
        let key = project_key(project_root);
        ProjectPaths {
            rules: self.config_root.join(format!("{key}.json")),
            snapshots: self.config_root.join(format!("{key}.snapshots")),
            lock: self.config_root.join(format!("{key}.lock")),
            key,
        }
    }

    fn snapshot_ring(paths: &ProjectPaths) -> json_store::SnapshotRing {
        json_store::SnapshotRing::new(paths.snapshots.clone(), 8)
    }

    /// Load (or return the cached copy of) a project's persisted rules. A
    /// missing primary file means a genuinely empty (fresh) project — the
    /// snapshot ring is never consulted for it, since a missing file is
    /// never grounds to resurrect *any* prior state (see
    /// [`Self::persist_project_rules`] for why the ring is otherwise safe
    /// to consult: it holds the incoming content of each write, so its
    /// newest entry always mirrors the latest legitimate state rather than
    /// one a later write superseded). A primary file that exists but fails
    /// to parse (corrupt/truncated) is the one case the ring's "recover
    /// from a bad write" purpose serves, so that's the only failure mode
    /// that falls back to [`Self::snapshot_ring`]; if the ring has nothing
    /// valid either, the project is treated as having no rules at all
    /// (fail closed).
    fn load_project_rules(&self, paths: &ProjectPaths) -> Vec<Rule> {
        self.with_project_rules(paths, <[Rule]>::to_vec)
    }

    /// `true` if the project's loaded rules grant `tool`. Answers from a
    /// borrow of the cached `Vec` rather than cloning every [`Rule`] just to
    /// scan it and drop it — this runs on the stdout reader thread for every
    /// approval prompt.
    fn project_grants_tool(&self, paths: &ProjectPaths, tool: &str) -> bool {
        self.with_project_rules(paths, |rules| rules.iter().any(|r| r.tool == tool))
    }

    /// Run `f` over the project's rules, loading them from disk on a cache
    /// miss. The cache lock is **not** held across that load: reading,
    /// parsing and (for a corrupt file) re-hashing the snapshot ring would
    /// otherwise block every other project's lookups, and the reader thread
    /// with them.
    fn with_project_rules<T>(&self, paths: &ProjectPaths, f: impl FnOnce(&[Rule]) -> T) -> T {
        if let Ok(cache) = self.project_rules.lock() {
            if let Some(rules) = cache.get(&paths.key) {
                return f(rules);
            }
        }

        let raw = std::fs::read(&paths.rules).ok().and_then(|bytes| {
            if serde_json::from_slice::<ProjectRulesFile>(&bytes).is_ok() {
                Some(bytes)
            } else {
                // File exists but is corrupt: only now does the ring apply.
                Self::snapshot_ring(paths).restore_latest().ok().flatten()
            }
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

        let out = f(&rules);
        if let Ok(mut cache) = self.project_rules.lock() {
            // Another thread may have loaded the same project meanwhile;
            // both computed it from the same file, so last-writer-wins.
            cache.insert(paths.key.clone(), rules);
        }
        out
    }

    /// Snapshot the new contents before writing them, then write them
    /// atomically — recovery path for `load_project_rules` above (consulted
    /// there only when the primary file exists but fails to parse).
    ///
    /// Deliberately snapshots the *incoming* bytes, not the outgoing ones
    /// being replaced: the ring's purpose is to recover whatever should
    /// currently be on disk if the primary file is later found corrupt, and
    /// that's always the most recently written state, never a state a
    /// subsequent write superseded. Snapshotting the outgoing content
    /// instead would mean a grant-then-revoke sequence leaves the ring's
    /// newest entry holding the pre-revoke (more permissive) rule set, so a
    /// later corruption of the primary file could resurrect an
    /// already-revoked grant — snapshotting the incoming content keeps the
    /// ring's latest entry always in sync with the latest legitimate write.
    fn persist_project_rules(paths: &ProjectPaths, rules: &[Rule]) -> Result<(), String> {
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
        if let Some(dir) = paths.rules.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        // Best-effort — a failed snapshot must never block the actual
        // write, it only narrows future recovery options.
        let _ = Self::snapshot_ring(paths).snapshot(&bytes);
        json_store::write_atomic(&paths.rules, &bytes).map_err(|e| e.to_string())
    }

    /// Read-modify-write a project's rules under the advisory lock: load,
    /// apply `mutate`, persist, and refresh the in-memory cache. `grant` and
    /// `revoke` differ only in `mutate`, so the lock/persist/cache-refresh
    /// sequence — the part that is easy to get subtly wrong — lives here
    /// once rather than being duplicated per operation.
    fn mutate_project_rules(
        &self,
        project_root: &Path,
        mutate: impl FnOnce(&mut Vec<Rule>),
    ) -> Result<(), String> {
        let paths = self.project_paths(project_root);
        json_store::with_lock_str(&paths.lock, || {
            let mut rules = self.load_project_rules(&paths);
            mutate(&mut rules);
            Self::persist_project_rules(&paths, &rules)?;
            if let Ok(mut cache) = self.project_rules.lock() {
                cache.insert(paths.key.clone(), rules);
            }
            Ok(())
        })
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
                self.mutate_project_rules(root, |rules| {
                    if !rules.iter().any(|r| r.tool == tool) {
                        rules.push(Rule {
                            tool: tool.to_string(),
                            scope: RuleScope::Project,
                            granted_at: now_iso8601(),
                        });
                    }
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
                self.mutate_project_rules(root, |rules| rules.retain(|r| r.tool != tool))
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
            out.extend(self.load_project_rules(&self.project_paths(root)));
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
            if self.project_grants_tool(&self.project_paths(root), tool) {
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

    /// The shape omp actually emits: `Allow tool: <name>` followed by the
    /// tool's `formatApprovalDetails()` lines. Reconstructed field-for-field
    /// from a real `write` approval (path + content preview, content elided
    /// at 2000 chars upstream). Before the first-line fix this matched
    /// nothing, so no granted rule ever auto-approved anything.
    #[test]
    fn approval_tool_name_reads_first_line_of_multiline_title() {
        let frame = json!({
            "type": "extension_ui_request",
            "id": "req-2",
            "method": "select",
            "title": "Allow tool: write\nPath: xd://mcp__ida_pro_mcp_py_eval\nContent:\n{\"code\":\"import importlib\"}",
            "options": ["Approve", "Deny"]
        });
        assert_eq!(approval_tool_name(&frame), Some("write"));
        assert_eq!(approval_request_id(&frame), Some("req-2"));
    }

    #[test]
    fn approval_tool_name_tolerates_crlf_in_multiline_title() {
        let frame = json!({
            "type": "extension_ui_request", "method": "select",
            "title": "Allow tool: mcp__ida_pro_mcp_decompile\r\nOrigin: MCP server tool",
            "options": ["Approve", "Deny"]
        });
        assert_eq!(
            approval_tool_name(&frame),
            Some("mcp__ida_pro_mcp_decompile")
        );
    }

    /// A detail line is never a tool name: only the first line is parsed, so
    /// a bad first line rejects the whole frame even when a later line looks
    /// like a valid prompt header.
    #[test]
    fn approval_tool_name_ignores_prompt_header_in_detail_lines() {
        let frame = json!({
            "type": "extension_ui_request", "method": "select",
            "title": "Allow tool: ../../etc/passwd\nAllow tool: bash",
            "options": ["Approve", "Deny"]
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
        std::fs::write(book.project_paths(&project).rules, b"not json").unwrap();
        assert!(!book.is_granted("sess-a", Some(&project), "bash"));
    }

    #[test]
    fn missing_project_rules_file_is_not_resurrected_from_snapshot_ring() {
        // A missing primary file must be treated as a genuinely empty
        // project, never resurrected from the snapshot ring — even though
        // the ring holds an earlier state that included a grant.
        let dir = scratch_dir();
        let project = scratch_dir();
        let book = RuleBook::new(dir.clone());
        book.grant("sess-a", Some(&project), "bash", RuleScope::Project)
            .unwrap();
        // Second write snapshots the incoming content ([bash, read]) but
        // the ring's first entry (from the first write) already holds
        // [bash] alone — either way the ring has a non-empty entry now.
        book.grant("sess-a", Some(&project), "read", RuleScope::Project)
            .unwrap();
        std::fs::remove_file(book.project_paths(&project).rules).unwrap();
        // Fresh instance so the in-memory cache can't mask the on-disk state.
        let book2 = RuleBook::new(dir);
        assert!(!book2.is_granted("sess-a", Some(&project), "bash"));
        assert!(!book2.is_granted("sess-a", Some(&project), "read"));
        assert!(book2.list("sess-a", Some(&project)).is_empty());
    }

    #[test]
    fn revoke_then_corrupt_does_not_resurrect_stale_pre_revoke_grant() {
        // A tool granted and then revoked must stay revoked even if the
        // primary file is later corrupted and the corrupt-file fallback
        // consults the snapshot ring: the ring's newest entry is the
        // *incoming* content of each write (see `persist_project_rules`),
        // so after a revoke it holds the post-revoke (empty) state, not
        // the pre-revoke (granted) one.
        let dir = scratch_dir();
        let project = scratch_dir();
        let book = RuleBook::new(dir.clone());
        book.grant("sess-a", Some(&project), "bash", RuleScope::Project)
            .unwrap();
        book.revoke("sess-a", Some(&project), "bash", RuleScope::Project)
            .unwrap();
        std::fs::write(book.project_paths(&project).rules, b"not json").unwrap();
        let book2 = RuleBook::new(dir);
        assert!(!book2.is_granted("sess-a", Some(&project), "bash"));
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
