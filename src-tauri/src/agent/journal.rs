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

use std::collections::VecDeque;
use std::sync::Arc;

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
}

impl EventJournal {
    pub(super) fn new(capacity: usize, max_bytes: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            max_bytes: max_bytes.max(1),
            bytes: 0,
            next_seq: 1,
            entries: VecDeque::with_capacity(capacity),
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
}
