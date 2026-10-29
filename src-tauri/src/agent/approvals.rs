//! Tool-approval prompts one omp process forwarded to the human and that
//! are still waiting for an answer, so "Approve and remember" is bound to
//! the prompt it came from (`approval_approve_and_grant` →
//! [`AgentBridge::approve_and_grant`]).
//!
//! The frontend names a prompt by session id and request id only; the tool
//! and the project come from here — what this process actually asked, under
//! the folder it was started in. A prompt shown in the wrong tab, one from a
//! process since restarted under the same id, or one already settled matches
//! nothing and the call is refused — no answer written, no rule saved —
//! instead of landing on another session's or project's scope. Lives on the
//! session's map entry, so it ends with the process.

use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use super::inner::BridgeInner;
use super::{write_command, AgentBridge};
use crate::approval::{self, RuleBook, RuleScope};

/// Open prompts kept per process. A turn with parallel gated tool calls
/// raises one prompt per call before any is answered; this is far beyond
/// that, and bounds a process whose prompts are never answered.
const MAX_PENDING: usize = 64;

/// Longest request id recorded. omp's ids are short; a longer one is not
/// kept, so its prompt can still be answered with Approve or Deny, but
/// "Approve and remember" is refused with nothing written (the webview
/// then reopens the prompt).
const MAX_ID_BYTES: usize = 256;

pub(super) struct PendingApprovals {
    /// The process's project folder (`None` = started without one, which
    /// only a session-scope grant accepts).
    project_root: Option<PathBuf>,
    /// `(request id, tool, in-flight claim)`, oldest first.
    prompts: VecDeque<(String, String, Option<u64>)>,
    next_claim: u64,
}

impl PendingApprovals {
    pub(super) const fn new(project_root: Option<PathBuf>) -> Self {
        Self {
            project_root,
            prompts: VecDeque::new(),
            next_claim: 0,
        }
    }

    /// Track a forwarded approval prompt, or forget one omp cancelled
    /// (`method: "cancel"`, `targetId`). Other frames leave it as it is.
    fn observe(&mut self, frame: &Value) {
        if let Some(tool) = approval::approval_tool_name(frame) {
            let Some(id) = approval::approval_request_id(frame) else {
                return;
            };
            if id.len() > MAX_ID_BYTES {
                return;
            }
            self.track(id.to_owned(), tool.to_owned());
        } else if frame.get("method").and_then(Value::as_str) == Some("cancel") {
            if let Some(id) = frame.get("targetId").and_then(Value::as_str) {
                self.remove(id);
            }
        }
    }

    /// The tool of open prompt `id`.
    pub(super) fn tool(&self, id: &str) -> Option<&str> {
        self.prompts
            .iter()
            .find(|(pending, _, claim)| pending == id && claim.is_none())
            .map(|(_, tool, _)| tool.as_str())
    }

    /// Record open prompt `id` for `tool`, replacing an older one with the
    /// same id and dropping the oldest once the cap is reached.
    fn track(&mut self, id: String, tool: String) {
        self.remove(&id);
        if self.prompts.len() == MAX_PENDING {
            self.prompts.pop_front();
        }
        self.prompts.push_back((id, tool, None));
    }

    fn remove(&mut self, id: &str) {
        if let Some(at) = self
            .prompts
            .iter()
            .position(|(pending, _, _)| pending == id)
        {
            self.prompts.remove(at);
        }
    }

    fn claim(&mut self, id: &str) -> Option<u64> {
        let (_, _, claim) = self
            .prompts
            .iter_mut()
            .find(|(pending, _, claim)| pending == id && claim.is_none())?;
        self.next_claim = self.next_claim.wrapping_add(1);
        *claim = Some(self.next_claim);
        Some(self.next_claim)
    }

    /// Finish only the claimed incarnation; a cancel or replacement must
    /// never be undone by a failed write or turned into a standing grant.
    fn finish_claim(&mut self, id: &str, claim: u64, written: bool) -> bool {
        let Some(at) = self
            .prompts
            .iter()
            .position(|(pending, _, token)| pending == id && *token == Some(claim))
        else {
            return false;
        };
        if written {
            self.prompts.remove(at);
        } else if let Some((_, _, token)) = self.prompts.get_mut(at) {
            *token = None;
        }
        true
    }
}

/// The stdout reader's per-line hook for a frame it forwards to the
/// frontend (a rule-covered prompt it answered itself is never recorded).
/// Locks only for an `extension_ui_request`; a poisoned lock records nothing.
pub(super) fn observe(pending: &Mutex<PendingApprovals>, frame_type: Option<&str>, frame: &Value) {
    if frame_type != Some("extension_ui_request") {
        return;
    }
    if let Ok(mut pending) = pending.lock() {
        pending.observe(frame);
    }
}

/// The request id an `extension_ui_response` command answers, `None` for
/// any other command. `AgentBridge::send` settles that prompt once the
/// answer reached omp: approved or denied, it is no longer one to grant.
pub(super) fn answered_id(command: &Value) -> Option<&str> {
    if command.get("type").and_then(Value::as_str) != Some("extension_ui_response") {
        return None;
    }
    command.get("id").and_then(Value::as_str)
}

/// Forget prompt `id` (answered); a poisoned lock leaves it.
pub(super) fn settle(pending: &Mutex<PendingApprovals>, id: &str) {
    if let Ok(mut pending) = pending.lock() {
        pending.remove(id);
    }
}

impl AgentBridge {
    /// Answer the open approval prompt `request_id` of `session_id`'s live
    /// process with "Approve" and grant standing approval for that prompt's
    /// tool — under that process's folder for `RuleScope::Project`, never
    /// anything the caller names. One operation, so the webview cannot
    /// leave a rule behind for a prompt it never answered, or answer a
    /// process it did not ask.
    ///
    /// 1. Claim: under the `sessions` lock, the entry's stdin and its open
    ///    prompt are taken together, so the answer can only go to the
    ///    process incarnation that asked. No running process, no such open
    ///    prompt, or a project grant for a process with no folder: refused,
    ///    nothing written, nothing saved, the prompt kept.
    /// 2. Answer: one `extension_ui_response` on that stdin. A failed write
    ///    puts the prompt back and saves nothing — omp never got the answer.
    /// 3. Grant, only after the answer was written. Answer-then-grant
    ///    rather than grant-then-roll-back: a rollback could revoke a rule
    ///    the user already had, and a rule saved first would auto-answer
    ///    the process's other prompts while this one is still open. A
    ///    session grant is made under the `sessions` lock and only if the
    ///    entry is still the incarnation the prompt was claimed from, so it
    ///    cannot outlive a reap that already cleared the session's grants
    ///    (`reap_and_clear_grants` clears after the removal). A project
    ///    grant writes its file without the locks, so this blocks: call it
    ///    off the IPC thread.
    ///
    /// `Err`: nothing was written to omp — the prompt is still waiting, and
    /// the caller may offer it again. `Ok(None)`: answered and granted.
    /// `Ok(Some(reason))`: answered (the user approved it in the same
    /// click), but the rule was not saved for `reason`.
    pub fn approve_and_grant(
        &self,
        rule_book: &RuleBook,
        session_id: &str,
        request_id: &str,
        scope: RuleScope,
    ) -> Result<Option<String>, String> {
        self.approve_and_grant_via(rule_book, session_id, request_id, scope, |inner| {
            inner.stdin.as_ref().map(Arc::clone)
        })
    }

    /// [`Self::approve_and_grant`] with the entry's writer picked by
    /// `stdin_of`, so a test can stand in a buffer for `ChildStdin`.
    fn approve_and_grant_via<W: Write>(
        &self,
        rule_book: &RuleBook,
        session_id: &str,
        request_id: &str,
        scope: RuleScope,
        stdin_of: impl FnOnce(&BridgeInner) -> Option<Arc<Mutex<W>>>,
    ) -> Result<Option<String>, String> {
        let (stdin, open, journal, alive, tool, root, claim) = self
            .with_entry(session_id, |inner| {
                let stdin = stdin_of(inner).ok_or_else(|| "agent not running".to_string())?;
                let mut pending = inner
                    .approvals
                    .lock()
                    .map_err(|_| "approvals lock poisoned".to_string())?;
                let tool = pending
                    .tool(request_id)
                    .ok_or_else(|| {
                        format!("session '{session_id}' has no open approval prompt '{request_id}'")
                    })?
                    .to_owned();
                let root = match scope {
                    RuleScope::Session => None,
                    RuleScope::Project => Some(pending.project_root.clone().ok_or_else(|| {
                        "project-scoped grant requires a project root".to_string()
                    })?),
                };
                let claim = pending.claim(request_id).ok_or_else(|| {
                    format!("session '{session_id}' has no open approval prompt '{request_id}'")
                })?;
                drop(pending);
                Ok::<_, String>((
                    stdin,
                    Arc::clone(&inner.approvals),
                    Arc::clone(&inner.journal),
                    Arc::clone(&inner.alive),
                    tool,
                    root,
                    claim,
                ))
            })?
            .ok_or_else(|| format!("session '{session_id}' not found"))??;

        let answer = approve_answer(request_id);
        let written = write_command(&stdin, &answer, None, Some((request_id, &journal)));
        let still_claimed = open
            .lock()
            .is_ok_and(|mut pending| pending.finish_claim(request_id, claim, written.is_ok()));
        written?;
        crate::remote::tracker::tracker().on_answered(session_id, request_id, &alive);
        if !still_claimed {
            return Ok(Some(
                "approval prompt ended before the grant was saved".to_string(),
            ));
        }
        let ended = || format!("session '{session_id}' ended before the grant was saved");
        let granted = root.map_or_else(
            || {
                self.with_entry(session_id, |inner| {
                    if Arc::ptr_eq(&inner.approvals, &open) {
                        rule_book.grant(session_id, None, &tool, RuleScope::Session)
                    } else {
                        Err(ended())
                    }
                })
                .and_then(|granted| granted.unwrap_or_else(|| Err(ended())))
            },
            |root| rule_book.grant(session_id, Some(&root), &tool, RuleScope::Project),
        );
        Ok(granted.err())
    }
}

/// The answer that approves omp's prompt `request_id`.
pub(super) fn approve_answer(request_id: &str) -> String {
    serde_json::json!({
        "type": "extension_ui_response", "id": request_id, "value": "Approve",
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::tests::{approval_prompt as prompt, idle_inner, journal_with_frames, Broken};
    use crate::test_support::TempDir;
    use serde_json::json;
    use std::path::Path;
    use std::sync::atomic::AtomicBool;

    fn pending() -> PendingApprovals {
        PendingApprovals::new(Some(PathBuf::from("/proj")))
    }

    #[test]
    fn a_forwarded_approval_prompt_is_kept_with_its_tool() {
        let mut p = pending();
        p.observe(&json!({
            "type": "extension_ui_request", "id": "r2", "method": "select",
            "title": "Pick one", "options": ["a", "b"],
        }));
        p.observe(&prompt("r1", "bash"));
        assert_eq!(p.tool("r1"), Some("bash"));
        assert_eq!(p.tool("r2"), None, "not an approval prompt");
        assert_eq!(p.tool("other"), None);
    }

    #[test]
    fn omp_cancel_forgets_the_prompt() {
        let mut p = pending();
        p.observe(&prompt("r1", "bash"));
        p.observe(&prompt("r2", "edit"));
        p.observe(&json!({"type": "extension_ui_request", "id": "c", "method": "cancel", "targetId": "r1"}));
        assert_eq!(p.tool("r1"), None);
        assert_eq!(p.tool("r2"), Some("edit"));
    }

    #[test]
    fn a_reused_id_keeps_only_the_latest_prompts_tool() {
        let mut p = pending();
        p.observe(&prompt("r1", "bash"));
        p.observe(&prompt("r1", "edit"));
        assert_eq!(p.tool("r1"), Some("edit"));
        p.remove("r1");
        assert_eq!(p.tool("r1"), None);
    }

    #[test]
    fn the_oldest_prompt_goes_once_the_cap_is_reached() {
        let mut p = pending();
        for i in 0..=MAX_PENDING {
            p.observe(&prompt(&format!("r{i}"), "bash"));
        }
        assert_eq!(p.tool("r0"), None);
        assert!(p.tool("r1").is_some());
        assert!(p.tool(&format!("r{MAX_PENDING}")).is_some());
    }

    #[test]
    fn an_oversized_id_is_not_recorded() {
        let mut p = pending();
        let id = "x".repeat(MAX_ID_BYTES + 1);
        p.observe(&prompt(&id, "bash"));
        assert_eq!(p.tool(&id), None);
    }

    #[test]
    fn only_an_extension_ui_response_answers_a_prompt() {
        assert_eq!(
            answered_id(&json!({"type": "extension_ui_response", "id": "r1", "value": "Deny"})),
            Some("r1")
        );
        assert_eq!(answered_id(&json!({"type": "prompt", "id": "r1"})), None);
        assert_eq!(answered_id(&json!({"type": "extension_ui_response"})), None);
    }

    /// `sess-a` runs in `proj-a` with prompts `req-1`/`req-2` (bash) open;
    /// `sess-b` is another tab with none.
    fn bridge_with_prompts(proj_a: &Path) -> AgentBridge {
        let bridge = AgentBridge::new();
        let open = Mutex::new(PendingApprovals::new(Some(proj_a.to_path_buf())));
        observe(
            &open,
            Some("extension_ui_request"),
            &prompt("req-1", "bash"),
        );
        observe(
            &open,
            Some("extension_ui_request"),
            &prompt("req-2", "bash"),
        );
        let mut sessions = bridge.sessions.lock().unwrap();
        sessions.insert(
            "sess-a".into(),
            BridgeInner {
                approvals: Arc::new(open),
                journal: journal_with_frames(&[prompt("req-1", "bash"), prompt("req-2", "bash")]),
                ..idle_inner(Arc::new(AtomicBool::new(true)))
            },
        );
        sessions.insert("sess-b".into(), idle_inner(Arc::new(AtomicBool::new(true))));
        drop(sessions);
        bridge
    }

    /// The stand-in for the process's stdin.
    type Pipe = Arc<Mutex<Vec<u8>>>;

    fn approve(
        bridge: &AgentBridge,
        book: &RuleBook,
        session_id: &str,
        request_id: &str,
        scope: RuleScope,
        pipe: &Pipe,
    ) -> Result<Option<String>, String> {
        bridge.approve_and_grant_via(book, session_id, request_id, scope, |_| {
            Some(Arc::clone(pipe))
        })
    }

    /// The bytes an "Approve" for `id` puts on omp's stdin.
    fn approve_line(id: &str) -> String {
        format!("{}\n", approve_answer(id))
    }

    fn written(pipe: &Pipe) -> String {
        String::from_utf8(pipe.lock().unwrap().clone()).unwrap()
    }

    fn open_tool(bridge: &AgentBridge, session_id: &str, id: &str) -> Option<String> {
        bridge
            .with_entry(session_id, |inner| {
                inner.approvals.lock().unwrap().tool(id).map(str::to_owned)
            })
            .unwrap()
            .flatten()
    }

    #[test]
    fn approving_answers_the_asking_process_then_grants_its_scope_once() {
        let dir = TempDir::new("approvals", "approve-scope");
        let (proj_a, proj_b) = (dir.path().join("proj-a"), dir.path().join("proj-b"));
        std::fs::create_dir_all(&proj_a).unwrap();
        std::fs::create_dir_all(&proj_b).unwrap();
        let book = RuleBook::new(dir.path().join("rules"));
        let bridge = bridge_with_prompts(&proj_a);
        let pipe = Pipe::default();

        // The other tab names the same request id: no prompt of its own.
        let err =
            approve(&bridge, &book, "sess-b", "req-1", RuleScope::Project, &pipe).unwrap_err();
        assert!(err.contains("no open approval prompt"), "{err}");
        assert_eq!(written(&pipe), "", "nothing answered");
        assert!(!book.is_granted("sess-b", Some(&proj_b), "bash"));

        assert_eq!(
            approve(&bridge, &book, "sess-a", "req-1", RuleScope::Project, &pipe),
            Ok(None)
        );
        assert_eq!(written(&pipe), approve_line("req-1"));
        assert!(book.is_granted("any-session", Some(&proj_a), "bash"));
        assert!(!book.is_granted("sess-b", Some(&proj_b), "bash"));
        assert_eq!(open_tool(&bridge, "sess-a", "req-1"), None, "settled");
        let replay = bridge.replay_events("sess-a", 2).unwrap();
        assert!(replay.pending_requests_complete);
        assert_eq!(replay.pending_requests.len(), 1);
        assert_eq!(replay.pending_requests[0].seq, 2);

        // Used up: a second click answers and grants nothing.
        let err =
            approve(&bridge, &book, "sess-a", "req-1", RuleScope::Session, &pipe).unwrap_err();
        assert!(err.contains("no open approval prompt"), "{err}");
        assert_eq!(written(&pipe), approve_line("req-1"));
        assert!(!book.is_granted("sess-a", None, "bash"));

        assert_eq!(
            approve(&bridge, &book, "sess-a", "req-2", RuleScope::Session, &pipe),
            Ok(None)
        );
        assert_eq!(
            written(&pipe),
            approve_line("req-1") + &approve_line("req-2")
        );
        assert!(book.is_granted("sess-a", None, "bash"));
        assert!(!book.is_granted("sess-b", None, "bash"));
    }

    #[test]
    fn a_settled_or_unknown_prompt_is_neither_answered_nor_granted() {
        let dir = TempDir::new("approvals", "approve-stale");
        let book = RuleBook::new(dir.path().join("rules"));
        let bridge = bridge_with_prompts(dir.path());
        let pipe = Pipe::default();
        let approvals = bridge
            .with_entry("sess-a", |inner| Arc::clone(&inner.approvals))
            .unwrap()
            .unwrap();
        settle(&approvals, "req-1");
        for id in ["req-1", "never-asked"] {
            let err = approve(&bridge, &book, "sess-a", id, RuleScope::Session, &pipe).unwrap_err();
            assert!(err.contains("no open approval prompt"), "{err}");
        }
        let err = approve(&bridge, &book, "gone", "req-2", RuleScope::Session, &pipe).unwrap_err();
        assert!(err.contains("not found"), "{err}");

        // No process behind the entry: refused before the prompt is used.
        let err = bridge
            .approve_and_grant(&book, "sess-a", "req-2", RuleScope::Session)
            .unwrap_err();
        assert!(err.contains("agent not running"), "{err}");
        assert_eq!(
            open_tool(&bridge, "sess-a", "req-2").as_deref(),
            Some("bash")
        );

        assert_eq!(written(&pipe), "");
        assert!(!book.is_granted("sess-a", None, "bash"));
        assert!(!book.is_granted("sess-a", Some(dir.path()), "bash"));
    }

    #[test]
    fn an_answer_omp_never_received_saves_no_grant_and_keeps_the_prompt() {
        let dir = TempDir::new("approvals", "approve-broken");
        let book = RuleBook::new(dir.path().join("rules"));
        let bridge = bridge_with_prompts(dir.path());
        for scope in [RuleScope::Session, RuleScope::Project] {
            let result = bridge.approve_and_grant_via(&book, "sess-a", "req-1", scope, |_| {
                Some(Arc::new(Mutex::new(Broken)))
            });
            assert!(result.is_err());
            assert_eq!(
                open_tool(&bridge, "sess-a", "req-1").as_deref(),
                Some("bash")
            );
        }
        assert!(!book.is_granted("sess-a", None, "bash"));
        assert!(!book.is_granted("sess-a", Some(dir.path()), "bash"));
    }

    #[test]
    fn a_cancel_during_the_approval_write_never_reopens_or_grants_it() {
        struct Cancelling<'a> {
            bridge: &'a AgentBridge,
            fail: bool,
            cancelled: bool,
        }
        impl Write for Cancelling<'_> {
            fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
                if !self.cancelled {
                    let frame = json!({
                        "type": "extension_ui_request", "method": "cancel", "targetId": "req-1"
                    });
                    self.bridge
                        .with_entry("sess-a", |inner| {
                            observe(&inner.approvals, Some("extension_ui_request"), &frame);
                            inner.journal.lock().unwrap().push_frame(
                                Arc::from(frame.to_string()),
                                Some(&frame),
                                false,
                            );
                        })
                        .unwrap();
                    self.cancelled = true;
                }
                if self.fail {
                    Err(std::io::ErrorKind::BrokenPipe.into())
                } else {
                    Ok(data.len())
                }
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        for fail in [true, false] {
            let dir = TempDir::new("approvals", "cancel-during-write");
            let book = RuleBook::new(dir.path().join("rules"));
            let bridge = bridge_with_prompts(dir.path());
            let result =
                bridge.approve_and_grant_via(&book, "sess-a", "req-1", RuleScope::Session, |_| {
                    Some(Arc::new(Mutex::new(Cancelling {
                        bridge: &bridge,
                        fail,
                        cancelled: false,
                    })))
                });
            if fail {
                assert!(result.is_err());
            } else {
                assert!(result.unwrap().is_some(), "answered but not granted");
            }
            assert_eq!(open_tool(&bridge, "sess-a", "req-1"), None);
            assert!(!book.is_granted("sess-a", None, "bash"));
            let replay = bridge.replay_events("sess-a", 0).unwrap();
            assert_eq!(replay.pending_requests.len(), 1);
            assert_eq!(replay.pending_requests[0].seq, 2);
        }
    }

    #[test]
    fn a_respawned_process_rejects_the_old_prompt() {
        let dir = TempDir::new("approvals", "approve-respawn");
        let book = RuleBook::new(dir.path().join("rules"));
        let bridge = bridge_with_prompts(dir.path());
        let pipe = Pipe::default();
        bridge
            .sessions
            .lock()
            .unwrap()
            .insert("sess-a".into(), idle_inner(Arc::new(AtomicBool::new(true))));
        let err =
            approve(&bridge, &book, "sess-a", "req-2", RuleScope::Session, &pipe).unwrap_err();
        assert!(err.contains("no open approval prompt"), "{err}");
        assert_eq!(written(&pipe), "");
        assert!(!book.is_granted("sess-a", None, "bash"));
    }

    /// The process is replaced while the answer is being written: the old
    /// process got its answer, the new one gets no session grant.
    #[test]
    fn a_respawn_during_the_answer_saves_no_session_grant() {
        struct Respawning<'a>(&'a AgentBridge);
        impl Write for Respawning<'_> {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0
                    .sessions
                    .lock()
                    .unwrap()
                    .insert("sess-a".into(), idle_inner(Arc::new(AtomicBool::new(true))));
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let dir = TempDir::new("approvals", "approve-respawn-mid");
        let book = RuleBook::new(dir.path().join("rules"));
        let bridge = bridge_with_prompts(dir.path());
        let unsaved = bridge
            .approve_and_grant_via(&book, "sess-a", "req-1", RuleScope::Session, |_| {
                Some(Arc::new(Mutex::new(Respawning(&bridge))))
            })
            .unwrap()
            .expect("answered, rule not saved");
        assert!(unsaved.contains("ended before the grant"), "{unsaved}");
        assert!(!book.is_granted("sess-a", None, "bash"));
    }

    /// The answer reached omp but the project rules file could not be
    /// written: reported as answered-without-rule, and the prompt stays
    /// answered (not put back for a second answer).
    #[test]
    fn a_failed_project_rules_write_after_the_answer_reports_the_unsaved_rule() {
        let dir = TempDir::new("approvals", "approve-rules-unwritable");
        // The rules folder is a regular file, so the grant cannot be saved.
        let rules = dir.path().join("rules");
        std::fs::write(&rules, b"not a folder").unwrap();
        let book = RuleBook::new(rules);
        let bridge = bridge_with_prompts(dir.path());
        let pipe = Pipe::default();
        let unsaved = approve(&bridge, &book, "sess-a", "req-1", RuleScope::Project, &pipe)
            .unwrap()
            .expect("answered, rule not saved");
        assert_ne!(unsaved, "");
        assert_eq!(written(&pipe), approve_line("req-1"));
        assert_eq!(
            open_tool(&bridge, "sess-a", "req-1"),
            None,
            "stays answered"
        );
        assert!(!book.is_granted("sess-a", Some(dir.path()), "bash"));
    }

    #[test]
    fn a_project_grant_without_a_folder_is_refused_and_keeps_the_prompt() {
        let dir = TempDir::new("approvals", "approve-no-root");
        let book = RuleBook::new(dir.path().join("rules"));
        let bridge = AgentBridge::new();
        let open = Mutex::new(PendingApprovals::new(None));
        observe(
            &open,
            Some("extension_ui_request"),
            &prompt("req-1", "bash"),
        );
        bridge.sessions.lock().unwrap().insert(
            "sess-a".into(),
            BridgeInner {
                approvals: Arc::new(open),
                journal: journal_with_frames(&[prompt("req-1", "bash")]),
                ..idle_inner(Arc::new(AtomicBool::new(true)))
            },
        );
        let pipe = Pipe::default();
        let err =
            approve(&bridge, &book, "sess-a", "req-1", RuleScope::Project, &pipe).unwrap_err();
        assert!(err.contains("requires a project root"), "{err}");
        assert_eq!(written(&pipe), "");
        assert_eq!(
            approve(&bridge, &book, "sess-a", "req-1", RuleScope::Session, &pipe),
            Ok(None)
        );
        assert_eq!(written(&pipe), approve_line("req-1"));
        assert!(book.is_granted("sess-a", None, "bash"));
    }

    #[test]
    fn approval_grant_settles_tracker_only_after_a_successful_answer() {
        let dir = TempDir::new("tracker", "approval-grant");
        let book = RuleBook::new(dir.path().join("rules"));
        let bridge = AgentBridge::new();
        let sid = "tracker-approval-grant";
        let frame = prompt("q", "bash");
        let open = Mutex::new(PendingApprovals::new(None));
        observe(&open, Some("extension_ui_request"), &frame);
        bridge.sessions.lock().unwrap().insert(
            sid.into(),
            BridgeInner {
                approvals: Arc::new(open),
                journal: journal_with_frames(std::slice::from_ref(&frame)),
                ..idle_inner(Arc::new(AtomicBool::new(true)))
            },
        );
        let tracker = crate::remote::tracker::tracker();
        tracker.on_frame(
            sid,
            Some("extension_ui_request"),
            Some(&frame),
            std::time::Instant::now(),
            &AtomicBool::new(true),
        );
        assert!(bridge
            .approve_and_grant_via(&book, sid, "q", RuleScope::Session, |_| Some(Arc::new(
                Mutex::new(Broken)
            )),)
            .is_err());
        assert_eq!(tracker.snapshot()[sid], (false, 1));
        assert_eq!(
            approve(
                &bridge,
                &book,
                sid,
                "q",
                RuleScope::Session,
                &Pipe::default()
            ),
            Ok(None)
        );
        assert_eq!(tracker.snapshot()[sid], (false, 0));
        tracker.on_exit(sid);
    }
}
