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

/// One journaled line, in emission order.
#[derive(Debug, Clone)]
pub(super) struct JournalEvent {
    pub(super) seq: u64,
    pub(super) text: String,
}

/// Result of a `since(after_seq)` query.
pub(super) struct Replay {
    /// Events with `seq > after_seq`, oldest first.
    pub(super) events: Vec<JournalEvent>,
    /// `seq` of the most recently journaled event, or `0` if none yet.
    pub(super) head_seq: u64,
    /// `true` when `after_seq` is older than the oldest event still held —
    /// some events between `after_seq` and the ring's current window were
    /// evicted and cannot be recovered from this journal.
    pub(super) dropped: bool,
}

/// Fixed-capacity ring of the most recent [`JournalEvent`]s for one session.
pub(super) struct EventJournal {
    capacity: usize,
    next_seq: u64,
    entries: VecDeque<JournalEvent>,
}

impl EventJournal {
    pub(super) fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            next_seq: 1,
            entries: VecDeque::with_capacity(capacity),
        }
    }

    /// Append `text` as the next event, evicting the oldest entry once the
    /// ring is full. Returns the assigned `seq`.
    pub(super) fn push(&mut self, text: String) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.entries.push_back(JournalEvent { seq, text });
        if self.entries.len() > self.capacity {
            self.entries.pop_front();
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
        let events = self
            .entries
            .iter()
            .filter(|e| e.seq > after_seq)
            .cloned()
            .collect();
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
        let mut j = EventJournal::new(4);
        assert_eq!(j.push("a".into()), 1);
        assert_eq!(j.push("b".into()), 2);
        assert_eq!(j.push("c".into()), 3);
    }

    #[test]
    fn since_zero_on_fresh_journal_returns_empty_not_dropped() {
        let j = EventJournal::new(4);
        let r = j.since(0);
        assert!(r.events.is_empty());
        assert_eq!(r.head_seq, 0);
        assert!(!r.dropped);
    }

    #[test]
    fn since_returns_only_events_strictly_after_cursor() {
        let mut j = EventJournal::new(4);
        j.push("a".into());
        j.push("b".into());
        j.push("c".into());
        let r = j.since(1);
        assert_eq!(r.events.iter().map(|e| e.seq).collect::<Vec<_>>(), [2, 3]);
        assert_eq!(r.head_seq, 3);
        assert!(!r.dropped);
    }

    #[test]
    fn since_head_cursor_returns_nothing_new() {
        let mut j = EventJournal::new(4);
        j.push("a".into());
        j.push("b".into());
        let r = j.since(2);
        assert!(r.events.is_empty());
        assert!(!r.dropped);
    }

    #[test]
    fn eviction_beyond_capacity_drops_oldest() {
        let mut j = EventJournal::new(2);
        j.push("a".into()); // seq 1, evicted
        j.push("b".into()); // seq 2
        j.push("c".into()); // seq 3
        let r = j.since(0);
        assert_eq!(r.events.iter().map(|e| e.seq).collect::<Vec<_>>(), [2, 3]);
    }

    #[test]
    fn since_cursor_predating_ring_window_reports_dropped() {
        let mut j = EventJournal::new(2);
        j.push("a".into()); // seq 1, evicted below
        j.push("b".into()); // seq 2
        j.push("c".into()); // seq 3 — ring now holds [2,3]
        let r = j.since(0); // caller last saw nothing; seq 1 was evicted before they could
        assert!(r.dropped);
        // Still returns whatever survives so the caller can splice in what it can.
        assert_eq!(r.events.iter().map(|e| e.seq).collect::<Vec<_>>(), [2, 3]);
    }

    #[test]
    fn since_cursor_exactly_at_ring_boundary_is_not_dropped() {
        let mut j = EventJournal::new(2);
        j.push("a".into()); // seq 1, evicted
        j.push("b".into()); // seq 2
        j.push("c".into()); // seq 3 — ring holds [2,3], oldest = 2
        let r = j.since(1); // contiguous: oldest(2) == after_seq(1) + 1
        assert!(!r.dropped);
        assert_eq!(r.events.iter().map(|e| e.seq).collect::<Vec<_>>(), [2, 3]);
    }

    #[test]
    fn unknown_session_head_seq_is_zero_until_first_push() {
        let j = EventJournal::new(256);
        assert_eq!(j.since(999).head_seq, 0);
    }
}
