// Compacted history (#85, docs/architecture/compacted-history.md): what a
// compaction summarized, loaded back from the session file (Rust
// `session_history`) and shown read-only above a tab's transcript. Pure:
// whether there is any to load after a get_messages, the anchor a load
// pages back from, the room the transcript cap leaves, the wire items as
// transcript entries, and the prepend. live.js owns the request and state.
//
// Exposes `window.OMP_OLDER_HISTORY`; IIFE per the project rule for plain
// <script> tags. Reads window.adaptAgentMessages (adapter.js, loaded later)
// at call time only. Regression: test-older-history.mjs.
(function () {
  /** The error a load reports when the tab has no session file yet; the
   *  row says it in the interface language. Any other error is Rust's text. */
  const NO_SESSION_FILE = "no-session-file";
  /** The English source string for that error (a key of app/i18n-zh.js). */
  const NO_SESSION_FILE_TEXT = "omp has not saved this conversation yet";

  // A transcript entry that stands for an omp message: the merge key
  // (app/transcript-merge.js `messageKey`).
  const _isMessage = m => (m?.kind === "user" || m?.kind === "assistant") && Number.isFinite(m.ts);

  /** The oldest user/assistant entry with a `ts`, or null. */
  function oldestMessage(messages) {
    if (!Array.isArray(messages)) return null;
    for (const m of messages) if (_isMessage(m)) return m;
    return null;
  }

  /** `before` of a load: the oldest shown message's `ts`, or null. */
  function anchorTs(messages) {
    return oldestMessage(messages)?.ts ?? null;
  }

  /** Entries the transcript cap (`max`) still takes. */
  function room(messages, max) {
    return Math.max(0, max - (Array.isArray(messages) ? messages.length : 0));
  }

  /** Whether the row is offered (D8): history to load and room under the
   *  cap. `olderHistory` is the snapshot's, `messages` the transcript, `max`
   *  the cap. */
  function showRow(olderHistory, messages, max) {
    return !!olderHistory?.available && room(messages, max) > 0;
  }

  /** The row's reason for a failed load (D8): `{ translate, text }`. With
   *  `translate`, `text` is an English source string for the interface
   *  language; otherwise it is Rust's own text, shown as is. */
  function reasonOf(error) {
    if (error === NO_SESSION_FILE) return { translate: true, text: NO_SESSION_FILE_TEXT };
    return { translate: false, text: error };
  }

  /** Whether the tab has compacted history to load after a get_messages
   *  (D6): `raw` is get_messages' `messages`, `merged` the transcript after
   *  the merge, `trimmed` the tab's `state.trimmed`. Null means "keep the
   *  current value", when this get_messages cannot tell: the oldest shown
   *  message is loaded history (the last load's `more` still says whether
   *  older history exists), or it has no copy in the context (it predates a
   *  compaction: the tab's earlier verdict stands — false for a tab whose
   *  first get_messages had no leading summary, true for a compacted one
   *  whose context a later compaction cut again). */
  function isAvailable(raw, merged, { trimmed = false } = {}) {
    if (trimmed) return false;
    if (!Array.isArray(raw) || raw[0]?.role !== "compactionSummary") return false;
    const oldest = oldestMessage(merged);
    // Nothing with a `ts` on screen: the whole path is older (`before` null).
    if (!oldest) return true;
    if (oldest.fromHistory) return null;
    // A live entry the context no longer holds: from before a compaction.
    return raw.some(m => m?.role === oldest.kind && m.timestamp === oldest.ts) ? true : null;
  }

  // A `compactionSummary` item as the transcript's compaction divider (the
  // `CompactRow` of a live `/compact`). No `ts`: a desktop-made entry.
  function _divider(item) {
    return {
      kind: "compact", status: "done",
      shortSummary: typeof item.shortSummary === "string" && item.shortSummary ? item.shortSummary : null,
      summary: typeof item.summary === "string" && item.summary ? item.summary : null,
      tokensBefore: Number.isFinite(item.tokensBefore) ? item.tokensBefore : null,
      fromHistory: true,
    };
  }

  /** `session_history` items (D5, oldest first) as transcript entries (D7),
   *  each marked `fromHistory`. The messages between dividers go through
   *  `adaptAgentMessages`, but whether a failed reply ended its run is
   *  judged over the whole loaded sequence: a divider is not a run
   *  boundary (omp compacts mid-run and continues). Adapting a segment
   *  together with everything after it and keeping only its own share does
   *  that — an entry's output depends only on the messages after it, so the
   *  tail of `adapt(segment + rest)` is exactly `adapt(rest)`.
   *
   *  `next` is the kind of the oldest message the transcript shows. When it
   *  is an assistant message, it continues the loaded tail's run, so a
   *  failed reply at the end of the page did not end its run: an empty
   *  assistant message stands in for it while adapting (it shows nothing). */
  function adaptHistory(items, { next = null } = {}) {
    const list = Array.isArray(items) ? items.filter(it => it && typeof it === "object") : [];
    const messages = [];
    const cuts = []; // { at: messages before the divider, item }
    for (const it of list) {
      if (it.role === "compactionSummary") cuts.push({ at: messages.length, item: it });
      else messages.push(it);
    }
    if (next === "assistant") messages.push({ role: "assistant", content: [] });
    const starts = [0, ...cuts.map(c => c.at)];
    const pieces = new Array(starts.length);
    let after = 0; // length of the adapted suffix past the current segment
    for (let k = starts.length - 1; k >= 0; k--) {
      const suffix = window.adaptAgentMessages(messages.slice(starts[k]));
      pieces[k] = suffix.slice(0, suffix.length - after);
      after = suffix.length;
    }
    const out = [];
    for (const m of pieces[0]) out.push({ ...m, fromHistory: true });
    cuts.forEach((cut, k) => {
      out.push(_divider(cut.item));
      for (const m of pieces[k + 1]) out.push({ ...m, fromHistory: true });
    });
    return out;
  }

  /** `entries` put above `messages`, as many of the newest as the cap
   *  (`max`) still takes: `{ messages, added, cut }` (`cut`: older entries
   *  left out). When the cap cuts, or Rust reports `more` before this page,
   *  the entries without a `ts` (dividers) now oldest are left out too,
   *  counted in `cut`: the next load anchors on the first message after
   *  them and would return them again (a page ending Rust's path at its
   *  beginning starts with a divider legitimately). `messages` is returned
   *  as is when nothing fits. */
  function prepend(messages, entries, max, { more = false } = {}) {
    const list = Array.isArray(entries) ? entries : [];
    let start = list.length - Math.min(list.length, room(messages, max));
    if (start > 0 || more === true) while (start < list.length && !Number.isFinite(list[start]?.ts)) start++;
    if (start === list.length) return { messages, added: 0, cut: list.length };
    return { messages: [...list.slice(start), ...messages], added: list.length - start, cut: start };
  }

  window.OMP_OLDER_HISTORY = Object.freeze({
    NO_SESSION_FILE, NO_SESSION_FILE_TEXT, oldestMessage, anchorTs, room, showRow, reasonOf, isAvailable, adaptHistory, prepend,
  });
})();
