// Per-tab prompt history (issue #16): pure list/navigation helpers.
//
// Exposes `window.OMP_PROMPT_HISTORY`; wrapped as an IIFE per the project
// rule for plain <script> tags (see CLAUDE.md "IIFE rule").
//
// Lists are newest-first arrays of prompt strings. Nothing here persists:
// `live.js` keeps one list per tab in memory, filled as the user sends and
// pre-filled from the transcript when a session is restored. Must load
// before composer.jsx (which reads `window.OMP_PROMPT_HISTORY` late-bound,
// inside render/effects/handlers, not a top-level destructure) and before
// live.js (which reads `.DEFAULT_LIMIT` during its own top-level IIFE
// init, so load order matters there in the stricter sense).
(function () {
  const DEFAULT_LIMIT = 100;
  const MIN_LIMIT = 10;
  const MAX_LIMIT = 1000;

  /** Coerce a user-configured limit into [MIN_LIMIT, MAX_LIMIT]; anything
   *  non-numeric falls back to DEFAULT_LIMIT. */
  function clampLimit(n) {
    const v = Math.floor(Number(n));
    if (!Number.isFinite(v)) return DEFAULT_LIMIT;
    return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, v));
  }

  // Strip a known framing prefix (plan mode's INTENT_FRAMING wrapper) back
  // to the as-typed text. Matched against the prefix's own trimEnd()'d
  // form too: an image-only plan send has no intent text to keep the
  // wrapper's trailing "\n\n" around (see app-live.jsx's `.trimEnd()` on
  // the framed message), so the untrimmed prefix alone would never match
  // it and the whole wrapper paragraph would slip through unstripped.
  function _stripFraming(text, framingPrefix) {
    if (!framingPrefix) return text;
    const prefix = framingPrefix.trimEnd();
    return text.startsWith(prefix) ? text.slice(prefix.length) : text;
  }

  /** Push `text` as the newest entry. Shares the same `framingPrefix`/
   *  `skip` normalization as `promptsFromMessages` (a live send and a
   *  backfilled transcript entry must end up identical, or recall shows
   *  the plan-mode wrapper / canned approval prompt instead of what was
   *  actually typed, and a later backfill re-adds the stripped form as a
   *  second, different-looking entry). An identical older entry is
   *  removed first, so a re-sent prompt moves to the top instead of
   *  taking a second slot. Blank (or skip-listed) text leaves the list
   *  unchanged (same reference). */
  function record(list, text, limit, { framingPrefix = "", skip = [] } = {}) {
    const t = typeof text === "string" ? _stripFraming(text, framingPrefix).trim() : "";
    if (!t || skip.includes(t)) return list;
    if (list[0] === t) return list;
    return [t, ...list.filter(p => p !== t)].slice(0, clampLimit(limit));
  }

  /** Merge transcript prompts (`prompts`, chronological: oldest first) in
   *  *behind* the existing entries, which were typed live and are therefore
   *  newer. Entries already present are skipped, so re-running this for the
   *  same transcript (every tab switch re-fetches it) is a no-op. */
  function mergeOlder(list, prompts, limit) {
    const max = clampLimit(limit);
    const seen = new Set(list);
    const out = list.slice(0, max);
    for (let i = prompts.length - 1; i >= 0 && out.length < max; i--) {
      const t = typeof prompts[i] === "string" ? prompts[i].trim() : "";
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out.length === list.length && out.every((p, i) => p === list[i]) ? list : out;
  }

  /** The prompts the user typed, in transcript order, from adapted chat
   *  messages. `framingPrefix` (plan mode's intent framing) is stripped so
   *  the recalled text is what was typed, not the wrapper; texts in `skip`
   *  (e.g. the canned plan-approval prompt) are dropped. */
  function promptsFromMessages(messages, { framingPrefix = "", skip = [] } = {}) {
    const out = [];
    for (const m of messages || []) {
      if (m?.kind !== "user" || typeof m.text !== "string") continue;
      let t = _stripFraming(m.text, framingPrefix);
      t = t.trim();
      if (t && !skip.includes(t)) out.push(t);
    }
    return out;
  }

  const IDLE = Object.freeze({ index: -1, draft: "" });

  /**
   * One Up (`dir = -1`, older) or Down (`dir = +1`, newer) step through
   * `list`. `nav.index === -1` means "editing the draft": the first Up
   * stashes `currentText` as the draft, and stepping Down past the newest
   * entry restores it. Returns `{ nav, text }`, or `null` when there is
   * nowhere to go (caller lets the key through untouched).
   */
  function step(nav, list, dir, currentText) {
    const cur = nav || IDLE;
    if (dir < 0) {
      const next = cur.index + 1;
      if (next >= list.length) return null;
      const draft = cur.index === -1 ? currentText : cur.draft;
      return { nav: { index: next, draft }, text: list[next] };
    }
    if (cur.index < 0) return null;
    // Defensive bounds clamp: a caller may hold a stale index if the list
    // shrank out from under an in-progress recall (e.g. the tweaks-panel
    // limit was lowered mid-navigation) without resetting nav first —
    // without this, `list[next]` reads past the end and returns
    // `undefined` instead of a string. Composer.jsx also guards this at
    // the call site (invalidates nav the moment `text` no longer matches
    // the recalled entry), so this is a second line of defense, not the
    // only one.
    const next = Math.min(cur.index, list.length) - 1;
    if (next === -1) return { nav: IDLE, text: cur.draft };
    return { nav: { index: next, draft: cur.draft }, text: list[next] };
  }

  /** Caret collapsed and on the first line: Up belongs to history. */
  function caretOnFirstLine(value, start, end) {
    return start === end && (start === 0 || value.lastIndexOf("\n", start - 1) === -1);
  }

  /** Caret collapsed and on the last line: Down belongs to history. */
  function caretOnLastLine(value, start, end) {
    return start === end && value.indexOf("\n", end) === -1;
  }

  /** Trim every list in `histories` (Map<any, string[]>) down to `limit`,
   *  in place. Returns `true` iff anything actually changed — the caller
   *  (live.js's OMP_BRIDGE.setPromptHistoryLimit) uses that to skip a
   *  redundant `notify()`. The trimming decision itself has no Tauri
   *  dependency at all (it's plain Map iteration), so it's pulled out
   *  here rather than left inline in live.js, where it would be
   *  untestable purely because `promptHistories` is a private closure
   *  variable, not because the logic itself needs a live session. */
  function trimAll(histories, limit) {
    const max = clampLimit(limit);
    let changed = false;
    for (const [key, list] of histories) {
      if (list.length > max) {
        histories.set(key, list.slice(0, max));
        changed = true;
      }
    }
    return changed;
  }

  window.OMP_PROMPT_HISTORY = {
    DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT, IDLE,
    clampLimit, record, mergeOlder, promptsFromMessages, step,
    caretOnFirstLine, caretOnLastLine, trimAll,
  };
})();
