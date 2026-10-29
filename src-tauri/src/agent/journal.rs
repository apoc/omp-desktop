//! Bounded per-session event journal.
//!
//! Every stdout line emitted to the frontend is also appended here, stamped
//! with a monotonic per-session `seq`. This is *not* durable event sourcing —
//! it is a fixed-size in-memory ring, purely to survive the window between a
//! tab losing its live listener (backgrounded) and regaining it (reactivated):
//! `AgentBridge::replay_events` lets the frontend ask "what did I miss after
//! `seq`?" instead of relying solely on a text-only `get_messages` refetch,
//! which cannot reconstruct tool cards / ask bubbles / streaming state.
//!
//! The journal is deliberately non-persistent: `product-architecture`-style
//! designs that duplicate the agent's own `.jsonl` history as ground truth
//! create a reconciliation problem this ring is not trying to solve. A gap
//! beyond the ring window is reported via `dropped` and the caller is
//! expected to fall back to its existing full-state refetch for that case.
//!
//! Callback frames have their own bounded, per-process membership alongside
//! the ring: the history fallback cannot reconstruct live extension UI
//! promises. Both membership and cursor are sampled under the journal lock.
//! An overflow or unrecognized frame makes completeness conservatively
//! false for the rest of the process; a new process starts with an empty set.

use std::collections::VecDeque;
use std::sync::Arc;

use serde_json::Value;

/// Independent bounds for live callback payloads, not the event ring.
const MAX_PENDING_REQUESTS: usize = 64;
const MAX_PENDING_ID_BYTES: usize = 256;
pub(super) const MAX_PENDING_BYTES: usize = 8 * 1024 * 1024;

/// One journaled line, in emission order.
///
/// `text` is an [`Arc<str>`] rather than a `String` so journaling a line
/// costs a refcount bump instead of copying the line's bytes: the stdout
/// reader emits the very same buffer to the frontend, and `since` hands
/// out clones of it again on replay. Lines run up to `MAX_LINE_BYTES`
/// (16 MiB), so the copies this avoids are not small.
#[derive(Debug, Clone, serde::Serialize)]
pub struct JournalEvent {
    pub seq: u64,
    pub text: Arc<str>,
}

/// Result of a `since(after_seq)` query. Serialized straight to the
/// frontend as the `replay_events` response — the field names here are
/// the wire contract.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Replay {
    /// Events with `seq > after_seq`, oldest first.
    pub events: Vec<JournalEvent>,
    /// `seq` of the most recently journaled event, or `0` if none yet.
    pub head_seq: u64,
    /// `true` when `after_seq` is older than the oldest event still held —
    /// some events between `after_seq` and the ring's current window were
    /// evicted and cannot be recovered from this journal.
    pub dropped: bool,
    /// Outstanding callback frames when `head_seq` was sampled, independent
    /// of the cursor. Answers can settle between two snapshots at one head.
    pub pending_requests: Vec<JournalEvent>,
    /// False if a callback could not be retained or an answer is in flight.
    /// An incomplete snapshot must not be used to close missing requests.
    pub pending_requests_complete: bool,
    /// Latest task snapshot omitted from the ring, when newer than the cursor.
    /// Apply before `events`: every surviving event is newer than this one.
    pub background_tasks: Option<JournalEvent>,
}

struct PendingRequest {
    id: String,
    event: JournalEvent,
    answering: bool,
}

/// Ring of the most recent [`JournalEvent`]s for one session, bounded by
/// **both** an entry count and a total byte budget.
///
/// The byte bound matters as much as the count: entries hold whole RPC
/// lines, which run up to `MAX_LINE_BYTES` (16 MiB) each, so a
/// count-only bound would let one session streaming large tool results
/// pin `capacity × 16 MiB` indefinitely — per open tab.
pub(super) struct EventJournal {
    capacity: usize,
    max_bytes: usize,
    bytes: usize,
    next_seq: u64,
    entries: VecDeque<JournalEvent>,
    pending: VecDeque<PendingRequest>,
    pending_bytes: usize,
    /// Sticky for this process: omitted IDs cannot be tracked to settlement.
    pending_incomplete: bool,
    background_tasks: Option<JournalEvent>,
}

impl EventJournal {
    pub(super) fn new(capacity: usize, max_bytes: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            max_bytes: max_bytes.max(1),
            bytes: 0,
            next_seq: 1,
            entries: VecDeque::with_capacity(capacity),
            pending: VecDeque::new(),
            pending_bytes: 0,
            pending_incomplete: false,
            background_tasks: None,
        }
    }

    /// Append `text` as the next event, evicting oldest-first until both
    /// the entry-count and byte bounds hold again. Returns the assigned
    /// `seq`. The newest entry is always retained even if it alone exceeds
    /// the byte budget — dropping the line we were just asked to journal
    /// would report a `seq` the caller could never replay.
    pub(super) fn push(&mut self, text: Arc<str>) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.bytes += text.len();
        self.entries.push_back(JournalEvent { seq, text });
        while self.entries.len() > self.capacity
            || (self.bytes > self.max_bytes && self.entries.len() > 1)
        {
            if let Some(evicted) = self.entries.pop_front() {
                self.bytes -= evicted.text.len();
            }
        }
        seq
    }

    /// Append and observe the forwarded, already-redacted frame under the
    /// same lock, so the snapshot and its journal cursor describe one point.
    /// Auto-approved frames pass `None` because the forwarded line is a
    /// synthetic notice, not the original request.
    pub(super) fn push_frame(
        &mut self,
        text: Arc<str>,
        frame: Option<&Value>,
        decoded: bool,
    ) -> u64 {
        let seq = self.push(text);
        let Some(frame) =
            frame.filter(|f| f.get("type").and_then(Value::as_str) == Some("extension_ui_request"))
        else {
            return seq;
        };
        if frame.get("method").and_then(Value::as_str) == Some("notify")
            && frame
                .get("message")
                .and_then(Value::as_str)
                .is_some_and(|message| message.starts_with("OMP_DESKTOP_BACKGROUND_TASKS:"))
        {
            self.background_tasks = self
                .frame_text(frame, decoded)
                .filter(|text| text.len() <= 1024 * 1024)
                .map(|text| JournalEvent { seq, text });
        }
        match frame.get("method").and_then(Value::as_str) {
            Some("cancel") => {
                if let Some(id) = frame.get("targetId").and_then(Value::as_str) {
                    self.remove_pending(id);
                } else {
                    self.pending_incomplete = true;
                }
            }
            Some("ask" | "select" | "confirm" | "input" | "editor") => {
                let Some(id) = frame
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                else {
                    self.pending_incomplete = true;
                    return seq;
                };
                self.remove_pending(id);
                let Some(text) = self.frame_text(frame, decoded) else {
                    self.pending_incomplete = true;
                    return seq;
                };
                if id.len() > MAX_PENDING_ID_BYTES
                    || self.pending.len() >= MAX_PENDING_REQUESTS
                    || text.len() > MAX_PENDING_BYTES.saturating_sub(self.pending_bytes)
                {
                    self.pending_incomplete = true;
                    return seq;
                }
                self.pending_bytes += text.len();
                self.pending.push_back(PendingRequest {
                    id: id.to_owned(),
                    event: JournalEvent { seq, text },
                    answering: false,
                });
            }
            Some(
                "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text" | "open_url",
            ) => {}
            // A future method may be a callback; do not claim a complete set.
            _ => self.pending_incomplete = true,
        }
        seq
    }

    fn frame_text(&self, frame: &Value, decoded: bool) -> Option<Arc<str>> {
        if decoded {
            // Chunked callbacks need one logical buffer; ordinary frames keep
            // sharing the physical buffer with the journal and emitted line.
            serde_json::to_string(frame).ok().map(Arc::from)
        } else {
            self.entries.back().map(|event| Arc::clone(&event.text))
        }
    }

    /// A discarded oversized stdout frame could itself have been a callback.
    pub(super) const fn mark_pending_incomplete(&mut self) {
        self.pending_incomplete = true;
    }

    /// Start an answer without holding the journal across a blocking pipe
    /// write. An in-flight entry is omitted and makes snapshots incomplete:
    /// neither a premature close nor a stale callback can be inferred.
    pub(super) fn begin_answer(&mut self, id: &str) -> Result<Option<u64>, &'static str> {
        if let Some(pending) = self.pending.iter_mut().find(|p| p.id == id) {
            pending.answering = true;
            return Ok(Some(pending.event.seq));
        }
        if self.pending_incomplete {
            Ok(None)
        } else {
            Err("no open extension UI request for this process")
        }
    }

    /// Finish only the incarnation claimed above: cancel or a newer request
    /// with the same id may have arrived while the pipe write was in progress.
    pub(super) fn finish_answer(&mut self, id: &str, seq: Option<u64>, written: bool) {
        let Some(seq) = seq else { return };
        let Some(at) = self
            .pending
            .iter()
            .position(|p| p.id == id && p.event.seq == seq)
        else {
            return;
        };
        if written {
            if let Some(pending) = self.pending.remove(at) {
                self.pending_bytes -= pending.event.text.len();
            }
        } else if let Some(pending) = self.pending.get_mut(at) {
            pending.answering = false;
        }
    }

    fn remove_pending(&mut self, id: &str) {
        if let Some(at) = self.pending.iter().position(|p| p.id == id) {
            if let Some(pending) = self.pending.remove(at) {
                self.pending_bytes -= pending.event.text.len();
            }
        }
    }

    /// Events strictly after `after_seq`, plus drop/head bookkeeping. See
    /// [`Replay`] for field semantics.
    pub(super) fn since(&self, after_seq: u64) -> Replay {
        let head_seq = self.next_seq.saturating_sub(1);
        let oldest_in_ring = self.entries.front().map(|e| e.seq);
        let dropped = oldest_in_ring.map_or(
            // Ring currently empty: a drop only happened if events were
            // ever pushed beyond what the caller has already seen.
            after_seq < head_seq,
            // A gap exists iff the caller's cursor sits more than one seq
            // behind the oldest surviving entry (i.e. something in between
            // was evicted). Contiguous when `after_seq + 1 == oldest`.
            |oldest| oldest > after_seq.saturating_add(1),
        );
        // `seq` is monotonic across the ring, so the events wanted are a
        // contiguous suffix — binary-search its start instead of scanning
        // every entry with a filter.
        let start = self.entries.partition_point(|e| e.seq <= after_seq);
        let events = self.entries.iter().skip(start).cloned().collect();
        Replay {
            events,
            head_seq,
            dropped,
            // Replay owns its handles while the journal continues to mutate.
            pending_requests: self
                .pending
                .iter()
                .filter(|p| !p.answering)
                .map(|p| JournalEvent {
                    seq: p.event.seq,
                    text: Arc::clone(&p.event.text),
                })
                .collect(),
            pending_requests_complete: !self.pending_incomplete
                && self.pending.iter().all(|p| !p.answering),
            background_tasks: self
                .background_tasks
                .as_ref()
                .filter(|event| {
                    event.seq > after_seq && oldest_in_ring.is_some_and(|oldest| event.seq < oldest)
                })
                .map(|event| JournalEvent {
                    seq: event.seq,
                    text: Arc::clone(&event.text),
                }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_assigns_monotonic_seq_starting_at_one() {
        let mut j = EventJournal::new(4, 1 << 20);
        assert_eq!(j.push(Arc::from("a")), 1);
        assert_eq!(j.push(Arc::from("b")), 2);
        assert_eq!(j.push(Arc::from("c")), 3);
    }

    #[test]
    fn since_zero_on_fresh_journal_returns_empty_not_dropped() {
        let j = EventJournal::new(4, 1 << 20);
        let r = j.since(0);
        assert!(r.events.is_empty());
        assert_eq!(r.head_seq, 0);
        assert!(!r.dropped);
    }

    #[test]
    fn since_returns_only_events_strictly_after_cursor() {
        let mut j = EventJournal::new(4, 1 << 20);
        j.push(Arc::from("a"));
        j.push(Arc::from("b"));
        j.push(Arc::from("c"));
        let r = j.since(1);
        assert_eq!(r.events.iter().map(|e| e.seq).collect::<Vec<_>>(), [2, 3]);
        assert_eq!(r.head_seq, 3);
        assert!(!r.dropped);
    }

    #[test]
    fn since_head_cursor_returns_nothing_new() {
        let mut j = EventJournal::new(4, 1 << 20);
        j.push(Arc::from("a"));
        j.push(Arc::from("b"));
        let r = j.since(2);
        assert!(r.events.is_empty());
        assert!(!r.dropped);
    }

    #[test]
    fn eviction_beyond_capacity_drops_oldest() {
        let mut j = EventJournal::new(2, 1 << 20);
        j.push(Arc::from("a")); // seq 1, evicted
        j.push(Arc::from("b")); // seq 2
        j.push(Arc::from("c")); // seq 3
        let r = j.since(0);
        assert_eq!(r.events.iter().map(|e| e.seq).collect::<Vec<_>>(), [2, 3]);
    }

    #[test]
    fn since_cursor_predating_ring_window_reports_dropped() {
        let mut j = EventJournal::new(2, 1 << 20);
        j.push(Arc::from("a")); // seq 1, evicted below
        j.push(Arc::from("b")); // seq 2
        j.push(Arc::from("c")); // seq 3 — ring now holds [2,3]
        let r = j.since(0); // caller last saw nothing; seq 1 was evicted before they could
        assert!(r.dropped);
        // Still returns whatever survives so the caller can splice in what it can.
        assert_eq!(r.events.iter().map(|e| e.seq).collect::<Vec<_>>(), [2, 3]);
    }

    #[test]
    fn since_cursor_exactly_at_ring_boundary_is_not_dropped() {
        let mut j = EventJournal::new(2, 1 << 20);
        j.push(Arc::from("a")); // seq 1, evicted
        j.push(Arc::from("b")); // seq 2
        j.push(Arc::from("c")); // seq 3 — ring holds [2,3], oldest = 2
        let r = j.since(1); // contiguous: oldest(2) == after_seq(1) + 1
        assert!(!r.dropped);
        assert_eq!(r.events.iter().map(|e| e.seq).collect::<Vec<_>>(), [2, 3]);
    }

    #[test]
    fn byte_budget_evicts_even_when_entry_count_is_under_capacity() {
        // Capacity 100 entries, but only 10 bytes of budget: the count
        // bound never fires, so eviction here is driven purely by size.
        let mut j = EventJournal::new(100, 10);
        j.push(Arc::from("aaaa")); // seq 1, 4 bytes
        j.push(Arc::from("bbbb")); // seq 2, 8 bytes total
        j.push(Arc::from("cccc")); // seq 3, 12 > 10 → evicts seq 1
        let r = j.since(0);
        assert_eq!(r.events.iter().map(|e| e.seq).collect::<Vec<_>>(), [2, 3]);
        assert!(r.dropped, "byte-driven eviction must still report a gap");
    }

    #[test]
    fn oversized_single_entry_is_retained_so_its_seq_stays_replayable() {
        let mut j = EventJournal::new(100, 4);
        let seq = j.push(Arc::from("this line alone blows the budget"));
        let r = j.since(0);
        assert_eq!(r.events.len(), 1, "the just-pushed entry must survive");
        assert_eq!(r.events[0].seq, seq);
    }

    #[test]
    fn byte_accounting_does_not_drift_across_many_pushes() {
        let mut j = EventJournal::new(3, 1 << 20);
        for i in 0..50 {
            j.push(Arc::from(format!("line-{i}").as_str()));
        }
        let held: usize = j.entries.iter().map(|e| e.text.len()).sum();
        assert_eq!(j.bytes, held, "tracked byte total drifted from reality");
        assert_eq!(j.entries.len(), 3);
    }

    #[test]
    fn unknown_session_head_seq_is_zero_until_first_push() {
        let j = EventJournal::new(256, 1 << 20);
        assert_eq!(j.since(999).head_seq, 0);
    }

    fn push_json(journal: &mut EventJournal, frame: &Value) -> u64 {
        journal.push_frame(Arc::from(frame.to_string()), Some(frame), false)
    }

    fn question(id: &str, method: &str) -> Value {
        serde_json::json!({
            "type": "extension_ui_request", "id": id, "method": method,
            "title": "Choose", "options": ["yes", "no"]
        })
    }

    fn pending_ids(replay: &Replay) -> Vec<String> {
        replay
            .pending_requests
            .iter()
            .map(|event| {
                let frame: Value = serde_json::from_str(&event.text).unwrap();
                frame["id"].as_str().unwrap().to_owned()
            })
            .collect()
    }

    #[test]
    fn live_callbacks_survive_both_ring_bounds_even_at_head() {
        for (capacity, bytes) in [(1, 1 << 20), (100, 4)] {
            let mut j = EventJournal::new(capacity, bytes);
            let seq = push_json(&mut j, &question("one", "ask"));
            let first = j.since(0);
            assert!(Arc::ptr_eq(
                &first.events[0].text,
                &first.pending_requests[0].text
            ));
            j.push(Arc::from("other streamed data"));
            j.push(Arc::from("later streamed data"));
            let replay = j.since(0);
            assert!(replay.dropped);
            assert_eq!(pending_ids(&replay), ["one"]);
            assert_eq!(replay.pending_requests[0].seq, seq);
            let at_head = j.since(replay.head_seq);
            assert!(at_head.events.is_empty());
            assert_eq!(pending_ids(&at_head), ["one"]);
            assert!(at_head.pending_requests_complete);
        }
    }

    #[test]
    fn cancellation_and_agent_end_affect_only_their_actual_targets() {
        let mut j = EventJournal::new(1, 1 << 20);
        for method in ["ask", "select", "confirm", "input", "editor"] {
            push_json(&mut j, &question(method, method));
        }
        push_json(&mut j, &serde_json::json!({"type": "agent_end"}));
        assert_eq!(pending_ids(&j.since(0)).len(), 5);
        push_json(
            &mut j,
            &serde_json::json!({
                "type": "extension_ui_request", "id": "cancel-id",
                "method": "cancel", "targetId": "select"
            }),
        );
        j.push(Arc::from("cancel line evicted"));
        let replay = j.since(0);
        assert!(replay.dropped);
        assert!(replay.pending_requests_complete);
        assert_eq!(pending_ids(&replay), ["ask", "confirm", "input", "editor"]);
    }

    #[test]
    fn bounds_and_unknown_frames_never_claim_complete() {
        let mut count = EventJournal::new(1, 1);
        for id in 0..=MAX_PENDING_REQUESTS {
            push_json(&mut count, &question(&id.to_string(), "ask"));
        }
        let replay = count.since(0);
        assert!(!replay.pending_requests_complete);
        assert_eq!(replay.pending_requests.len(), MAX_PENDING_REQUESTS);
        // An omitted request is still answerable; incompleteness is sticky.
        assert_eq!(count.begin_answer("64").unwrap(), None);
        push_json(
            &mut count,
            &serde_json::json!({
                "type": "extension_ui_request", "method": "cancel", "targetId": "64"
            }),
        );
        assert!(!count.since(0).pending_requests_complete);

        for frame in [
            question(&"x".repeat(MAX_PENDING_ID_BYTES + 1), "ask"),
            serde_json::json!({"type":"extension_ui_request", "id":"large", "method":"input", "title":"x".repeat(MAX_PENDING_BYTES)}),
            serde_json::json!({"type":"extension_ui_request", "method":"ask"}),
            serde_json::json!({"type":"extension_ui_request", "method":"cancel"}),
            serde_json::json!({"type":"extension_ui_request", "method":"future_callback", "id":"new"}),
        ] {
            let mut j = EventJournal::new(1, 1);
            push_json(&mut j, &frame);
            assert!(!j.since(0).pending_requests_complete);
        }
        let mut dropped_line = EventJournal::new(1, 1);
        dropped_line.mark_pending_incomplete();
        assert!(!dropped_line.since(0).pending_requests_complete);
        let fresh = EventJournal::new(1, 1).since(0);
        assert!(fresh.pending_requests_complete);
        assert!(fresh.pending_requests.is_empty());
    }

    #[test]
    fn unknown_callback_can_still_receive_the_frontends_fallback_cancel() {
        use std::sync::Mutex;

        let mut j = EventJournal::new(1, 1 << 20);
        push_json(&mut j, &question("future-id", "future_callback"));
        let journal = Mutex::new(j);
        let stdin = Mutex::new(Vec::<u8>::new());
        let answer = r#"{"type":"extension_ui_response","id":"future-id","cancelled":true}"#;
        super::super::write_command(&stdin, answer, None, Some(("future-id", &journal))).unwrap();
        assert_eq!(
            stdin.lock().unwrap().as_slice(),
            format!("{answer}\n").as_bytes()
        );
        assert!(!journal.lock().unwrap().since(0).pending_requests_complete);
    }

    #[test]
    fn only_forwarded_callbacks_enter_the_snapshot() {
        let mut j = EventJournal::new(4, 1 << 20);
        for method in [
            "notify",
            "setStatus",
            "setWidget",
            "setTitle",
            "set_editor_text",
            "open_url",
        ] {
            push_json(&mut j, &question("fire-and-forget", method));
        }
        // A rule-covered select is replaced by a notice before journaling.
        j.push_frame(
            Arc::from(r#"{"type":"desktop_auto_approval"}"#),
            None,
            false,
        );
        let replay = j.since(0);
        assert!(replay.pending_requests_complete);
        assert!(replay.pending_requests.is_empty());
    }

    #[test]
    fn completion_and_cancellation_during_a_write_are_race_safe() {
        use std::io::{self, Write};
        use std::sync::Mutex;

        struct DuringWrite<'a> {
            journal: &'a Mutex<EventJournal>,
            cancel: bool,
            fail: bool,
            observed: bool,
        }
        impl Write for DuringWrite<'_> {
            fn write(&mut self, data: &[u8]) -> io::Result<usize> {
                if !self.observed {
                    let mut j = self.journal.lock().unwrap();
                    let replay = j.since(0);
                    assert!(!replay.pending_requests_complete);
                    assert_eq!(pending_ids(&replay), ["other"]);
                    if self.cancel {
                        push_json(
                            &mut j,
                            &serde_json::json!({
                                "type":"extension_ui_request", "method":"cancel", "targetId":"one"
                            }),
                        );
                    }
                    drop(j);
                    self.observed = true;
                }
                if self.fail {
                    Err(io::ErrorKind::BrokenPipe.into())
                } else {
                    Ok(data.len())
                }
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        for (cancel, fail, remaining) in [
            (false, false, vec!["other"]),
            (false, true, vec!["one", "other"]),
            (true, true, vec!["other"]),
        ] {
            let mut j = EventJournal::new(1, 1 << 20);
            push_json(&mut j, &question("one", "ask"));
            push_json(&mut j, &question("other", "confirm"));
            let journal = Mutex::new(j);
            let writer = Mutex::new(DuringWrite {
                journal: &journal,
                cancel,
                fail,
                observed: false,
            });
            let result = super::super::write_command(
                &writer,
                r#"{"type":"extension_ui_response","id":"one"}"#,
                None,
                Some(("one", &journal)),
            );
            assert_eq!(result.is_err(), fail);
            let replay = journal.lock().unwrap().since(0);
            assert!(replay.pending_requests_complete);
            assert_eq!(pending_ids(&replay), remaining);
        }
    }

    #[test]
    fn failed_flush_retains_the_request_and_stale_ids_are_rejected() {
        use std::io::{self, Write};
        use std::sync::Mutex;

        struct BadFlush;
        impl Write for BadFlush {
            fn write(&mut self, data: &[u8]) -> io::Result<usize> {
                Ok(data.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Err(io::ErrorKind::BrokenPipe.into())
            }
        }
        let mut j = EventJournal::new(1, 1 << 20);
        push_json(&mut j, &question("one", "ask"));
        let journal = Mutex::new(j);
        assert!(super::super::write_command(
            &Mutex::new(BadFlush),
            "answer",
            None,
            Some(("one", &journal))
        )
        .is_err());
        assert_eq!(pending_ids(&journal.lock().unwrap().since(0)), ["one"]);
        let stdin = Mutex::new(Vec::<u8>::new());
        assert!(super::super::write_command(
            &stdin,
            "stale",
            None,
            Some(("old-process-id", &journal))
        )
        .is_err());
        assert!(stdin.lock().unwrap().is_empty());
    }

    #[test]
    fn a_new_same_id_during_an_answer_is_not_settled_by_the_old_write() {
        let mut j = EventJournal::new(2, 1 << 20);
        push_json(&mut j, &question("id", "ask"));
        let claim = j.begin_answer("id").unwrap();
        push_json(&mut j, &question("id", "confirm"));
        j.finish_answer("id", claim, true);
        let replay = j.since(0);
        assert_eq!(pending_ids(&replay), ["id"]);
        let frame: Value = serde_json::from_str(&replay.pending_requests[0].text).unwrap();
        assert_eq!(frame["method"], "confirm");
    }
    #[test]
    fn task_snapshot_survives_eviction_but_never_rewinds_the_cursor() {
        let mut journal = EventJournal::new(1, 1 << 20);
        push_json(
            &mut journal,
            &serde_json::json!({"type":"extension_ui_request", "method":"notify",
            "message":"OMP_DESKTOP_BACKGROUND_TASKS:{\"supported\":true}"}),
        );
        assert!(journal.since(0).background_tasks.is_none());
        journal.push(Arc::from("later"));
        let replay = journal.since(0);
        assert!(replay.dropped);
        assert_eq!(replay.background_tasks.unwrap().seq, 1);
        assert_eq!(replay.events[0].seq, 2);
        assert!(journal.since(1).background_tasks.is_none());
    }

    #[test]
    fn latest_task_snapshot_replaces_old_task_state_after_ring_overflow() {
        let mut journal = EventJournal::new(1, 1 << 20);
        for status in ["running", "completed"] {
            push_json(
                &mut journal,
                &serde_json::json!({"type":"extension_ui_request", "method":"notify",
                "message":format!("OMP_DESKTOP_BACKGROUND_TASKS:{status}")}),
            );
        }
        journal.push(Arc::from("later"));
        assert!(journal
            .since(0)
            .background_tasks
            .unwrap()
            .text
            .contains("completed"));
        assert!(EventJournal::new(1, 1 << 20)
            .since(0)
            .background_tasks
            .is_none());
    }
}
