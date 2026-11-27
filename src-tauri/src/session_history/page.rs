//! Which entries a page holds: omp's leaf, its path, the display sequence
//! (compaction dividers moved up), the anchor cut and the `limit` window.

use std::collections::{HashMap, HashSet};

use super::parse::{Entry, Leaf};

/// Most display items one call returns.
const MAX_LIMIT: u32 = 500;

/// omp's leaf (`resolveSessionLeafId`): the last entry's `activeLeafId`, or
/// its own id when absent; `null` means no leaf. An `activeLeafId` naming no
/// entry falls back to the newest entry that is its own leaf.
fn resolve_leaf(entries: &[Entry], by_id: &HashMap<&str, usize>) -> Option<usize> {
    let last = entries.last()?;
    let target = match &last.active_leaf {
        Leaf::Own => return by_id.get(last.id.as_str()).copied(),
        Leaf::Cleared => return None,
        Leaf::Id(target) => target,
    };
    by_id.get(target.as_str()).copied().or_else(|| {
        entries.iter().rposition(|e| match &e.active_leaf {
            Leaf::Own => true,
            Leaf::Cleared => false,
            Leaf::Id(leaf) => *leaf == e.id,
        })
    })
}

/// The `parentId` chain of `leaf`, root first; stops at an entry already
/// on it (a cycle).
fn path_to(entries: &[Entry], by_id: &HashMap<&str, usize>, leaf: usize) -> Vec<usize> {
    let mut path = Vec::new();
    let mut seen = HashSet::new();
    let mut at = Some(leaf);
    while let Some(index) = at.filter(|&i| seen.insert(i)) {
        path.push(index);
        at = entries[index]
            .parent_id
            .as_deref()
            .and_then(|parent| by_id.get(parent).copied());
    }
    path.reverse();
    path
}

/// A snapcompact compaction that the next path entry rescued: omp's
/// transcript shows only the rescuing one.
fn rescued(entry: &Entry, next: Option<&Entry>) -> bool {
    let (Some(this), Some(next)) = (&entry.compaction, next) else {
        return false;
    };
    next.compaction.as_ref().is_some_and(|rescue| {
        this.snap
            && rescue.snap
            && next.parent_id.as_deref() == Some(entry.id.as_str())
            && rescue.first_kept == this.first_kept
            && rescue.tokens_before == this.tokens_before
    })
}

/// The shown entries of `path` in display order, as `(slot, rank, entry)`:
/// a compaction moves up to rank 0 of its first kept entry's slot (just
/// before it); everything else sits at rank 1 of its own path position.
fn sequence(entries: &[Entry], path: &[usize]) -> Vec<(usize, u8, usize)> {
    let position: HashMap<&str, usize> = path
        .iter()
        .enumerate()
        .map(|(at, &i)| (entries[i].id.as_str(), at))
        .collect();
    let mut placed = Vec::new();
    for (at, &index) in path.iter().enumerate() {
        let entry = &entries[index];
        if !entry.shown {
            continue;
        }
        let Some(compaction) = &entry.compaction else {
            placed.push((at, 1, index));
            continue;
        };
        if rescued(entry, path.get(at + 1).map(|&i| &entries[i])) {
            continue;
        }
        let first_kept = compaction
            .first_kept
            .as_deref()
            .and_then(|id| position.get(id).copied())
            .filter(|&slot| slot < at);
        placed.push(first_kept.map_or((at, 1, index), |slot| (slot, 0, index)));
    }
    // Stable: compactions moved to one slot keep their path order.
    placed.sort_by_key(|&(slot, rank, _)| (slot, rank));
    placed
}

/// Indices of the page's entries in display order, and `more`; `None` for
/// an empty page (no leaf, or `before` on no path entry).
///
/// The anchor is the last path entry whose message timestamp is `before`;
/// the range is the display sequence ahead of it, a divider moved right
/// before it included. The page is the newest `limit` (clamped to 1..=500)
/// display items of the range, with the uncounted items among them, moved
/// to start at an anchorable item (see [`anchorable_start`]).
// `float_cmp`: the anchor is an integral ms value omp wrote; it must match
// exactly.
#[allow(clippy::float_cmp)]
pub fn select(entries: &[Entry], before: Option<f64>, limit: u32) -> Option<(Vec<usize>, bool)> {
    let by_id: HashMap<&str, usize> = entries
        .iter()
        .enumerate()
        .map(|(i, e)| (e.id.as_str(), i))
        .collect();
    let path = path_to(entries, &by_id, resolve_leaf(entries, &by_id)?);
    let sequence = sequence(entries, &path);
    let end = match before {
        None => sequence.len(),
        Some(anchor) => {
            let at = path.iter().rposition(|&i| entries[i].ts == Some(anchor))?;
            sequence.partition_point(|&(slot, rank, _)| (slot, rank) < (at, 1))
        }
    };
    let range = &sequence[..end];
    let limit = limit.clamp(1, MAX_LIMIT) as usize;
    let mut counted = 0;
    let start = range
        .iter()
        .rposition(|&(_, _, i)| {
            counted += usize::from(entries[i].counted);
            counted == limit
        })
        .unwrap_or(0);
    let start = anchorable_start(entries, range, start);
    let more = range[..start].iter().any(|&(_, _, i)| entries[i].counted);
    Some((range[start..].iter().map(|&(_, _, i)| i).collect(), more))
}

/// The page start: the frontend anchors its next request on the oldest
/// user/assistant item it renders, so a page starting at a divider, a custom
/// item or an error-only assistant (a retried one renders nothing) would
/// return it again. A window `start` past the path's beginning moves forward
/// to its first anchorable item (a counted, visible message with a
/// timestamp), or, when it holds none, back to the nearest one before it (or
/// to 0); the page may then exceed `limit`.
fn anchorable_start(entries: &[Entry], range: &[(usize, u8, usize)], start: usize) -> usize {
    if start == 0 {
        return 0;
    }
    let anchorable = |&(_, _, i): &(usize, u8, usize)| {
        let entry = &entries[i];
        entry.counted && entry.visible && entry.ts.is_some()
    };
    range[start..].iter().position(anchorable).map_or_else(
        || range[..start].iter().rposition(anchorable).unwrap_or(0),
        |at| start + at,
    )
}
