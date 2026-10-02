// Per-tab UI state the desktop owns itself (issue #28): the composer's
// draft and plan mode. omp knows nothing about either, so the bridge
// snapshot cannot carry them; the React layer keeps one entry per tab in
// a plain object keyed by session id, and switching tabs swaps entries.
//
// Exposes `window.OMP_SESSION_UI`; wrapped as an IIFE per the project rule
// for plain <script> tags (see CLAUDE.md "IIFE rule"). Pure, so the
// isolation and transition rules are testable (test-session-ui.mjs).
(function () {
  // ── Generic per-tab map ──────────────────────────────────────────────
  // `idle` is the shared default of a tab with no entry. An update that
  // returns `idle` itself drops the entry instead of storing a copy.

  function entryOf(map, id, idle) {
    return id && Object.hasOwn(map, id) ? map[id] : idle;
  }

  /** `fn(entry) → entry` applied to tab `id` only. A falsy id (no tab
   *  open) and an unchanged entry both return `map` itself, so a React
   *  state setter bails out instead of re-rendering. */
  function updateEntry(map, id, idle, fn) {
    if (!id) return map;
    const prev = entryOf(map, id, idle);
    const next = fn(prev);
    if (next === prev) return map;
    if (next === idle) {
      const { [id]: _dropped, ...rest } = map;
      return rest;
    }
    return { ...map, [id]: next };
  }

  /** Drops the entries of closed tabs. Same reference when every entry
   *  still belongs to an open tab. */
  function pruneEntries(map, liveIds) {
    const live = new Set(liveIds);
    let out = null;
    for (const id of Object.keys(map)) {
      if (live.has(id)) continue;
      if (!out) out = { ...map };
      delete out[id];
    }
    return out ?? map;
  }

  // ── Plan mode ────────────────────────────────────────────────────────
  // `mode`: the composer frames sends as plan feedback. `started`: the
  // first plan send already carried INTENT_FRAMING. `annotations`: block
  // comments on this tab's plan, keyed by its transcript's message index.

  const PLAN_IDLE = Object.freeze({ mode: false, started: false, annotations: Object.freeze({}) });

  /** Leaving plan mode forgets that the plan was framed, so re-entering
   *  frames the next send again. Annotations survive the toggle. */
  function togglePlan(plan) {
    return plan.mode
      ? { ...plan, mode: false, started: false }
      : { ...plan, mode: true };
  }

  /** `/plan`: always a fresh plan. */
  function enterPlan(plan) {
    return { ...plan, mode: true, started: false };
  }

  /** Approving ends the plan and spends its comments. */
  function approvePlan() {
    return PLAN_IDLE;
  }

  /** `value === null` removes the comment on block `idx`. */
  function annotatePlan(plan, idx, value) {
    const annotations = { ...plan.annotations };
    if (value === null) delete annotations[idx];
    else annotations[idx] = value;
    return { ...plan, annotations };
  }

  /** A plan-mode send: framed from now on, and its comments are spent. */
  function markPlanSent(plan) {
    return { ...plan, started: true, annotations: PLAN_IDLE.annotations };
  }

  // ── Composer draft ───────────────────────────────────────────────────
  // `pastes` maps a `[paste #N …]` token id to its collapsed text;
  // `pendingImages` counts image preparations still in flight for the tab;
  // `historyNav` is the tab's prompt-history recall position and stashed
  // unsent draft (app/prompt-history.js `step`), null when not recalling.

  const DRAFT_IDLE = Object.freeze({
    text: "",
    attachments: Object.freeze([]),
    pastes: Object.freeze({}),
    pasteCounter: 0,
    pendingImages: 0,
    historyNav: null,
  });

  /** One Arrow Up (`dir` -1) / Down (+1) prompt-history recall in `draft`,
   *  through `step` (app/prompt-history.js, injected so this file stays
   *  dependency-free). The recall position only means something while the
   *  text is still the entry it recalled: the history list shrinking under
   *  it, or an edit that bypassed the composer's setText (paste-token
   *  collapse), restarts the recall from the current text. Returns the next
   *  draft, or null when there is nothing to recall in that direction. */
  function recallInDraft(draft, history, dir, step) {
    const nav = draft.historyNav;
    const live = nav && !(nav.index >= 0 && history[nav.index] !== draft.text) ? nav : null;
    const result = step(live, history, dir, draft.text);
    return result && { ...draft, text: result.text, historyNav: result.nav };
  }

  // ── Collapsed pastes (#31) ───────────────────────────────────────────
  // A long paste goes into the textarea as a `[paste #N +K lines]` token;
  // its text waits in `draft.pastes[N]` until the send expands it.
  // `pasteCounter` keeps ids unique within one draft.

  const PASTE_TOKEN_RE = /\[paste #(\d+) \+\d+ lines?\]/g;
  const PASTE_MAX_LINES = 5;
  const PASTE_MAX_CHARS = 500;

  /** Clipboard text in the form a textarea value holds: the browser turns
   *  every CRLF/CR into LF on its own insert, so a collapsed paste must
   *  too, or inlining it later would change the draft under React. */
  function normalizePaste(raw) {
    return raw.replace(/\r\n?/g, "\n");
  }

  /** Lines as the user sees them: a final newline ends the last line, it
   *  doesn't open another one. */
  function pasteLineCount(raw) {
    // Counted, not split: the chip strip recounts every collapsed paste on
    // each keystroke, and a pasted log can run to thousands of lines.
    let lines = 1;
    for (let i = raw.indexOf("\n"); i !== -1 && i < raw.length - 1; i = raw.indexOf("\n", i + 1)) lines++;
    return lines;
  }

  function shouldCollapsePaste(raw) {
    return raw.length > PASTE_MAX_CHARS || pasteLineCount(raw) > PASTE_MAX_LINES;
  }

  // The two draft edits below return `{ patch, caret }`: `patch` holds
  // only the fields the edit owns, so a caller merges it onto the latest
  // draft (`{ ...d, ...patch }`) without overwriting an image preparation
  // queued in the same tick. Both are edits, so both end a history recall.

  /** Puts `raw` into the draft as a new token over the selection
   *  `start`..`end`, with the caret after the token. */
  function collapsePaste(draft, raw, start, end) {
    const id = draft.pasteCounter + 1;
    const lines = pasteLineCount(raw);
    const token = `[paste #${id} +${lines} line${lines === 1 ? "" : "s"}]`;
    return {
      patch: {
        text: draft.text.slice(0, start) + token + draft.text.slice(end),
        pastes: { ...draft.pastes, [id]: raw },
        pasteCounter: id,
        historyNav: null,
      },
      caret: start + token.length,
    };
  }

  /** The collapsed pastes `text` still refers to, in order of first
   *  appearance, once each: `{ id, text, lines }`. A token whose paste is
   *  unknown (typed by hand, or left from a sent message) is plain text. */
  function pastesIn(text, pastes) {
    const seen = new Set();
    const out = [];
    for (const [, id] of text.matchAll(PASTE_TOKEN_RE)) {
      const raw = pastes[id];
      if (raw === undefined || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, text: raw, lines: pasteLineCount(raw) });
    }
    return out;
  }

  /** `text` with every known token replaced by its paste — what a send
   *  puts on the wire. One pass: a paste that itself contains token-shaped
   *  text is not expanded again. */
  function expandPastes(text, pastes) {
    return text.replace(PASTE_TOKEN_RE, (token, id) => pastes[id] ?? token);
  }

  /** Turns paste `id` back into editable text in the draft, at every token
   *  that refers to it, with the caret at the end of the first inlined
   *  copy; null when the draft holds no such token. */
  function inlinePaste(draft, id) {
    const raw = draft.pastes[id];
    if (raw === undefined) return null;
    let caret = -1;
    // `offset` indexes the original text, and nothing before the first
    // token of `id` changes, so it holds in the result too.
    const text = draft.text.replace(PASTE_TOKEN_RE, (token, tokenId, offset) => {
      if (tokenId !== id) return token;
      if (caret < 0) caret = offset + raw.length;
      return raw;
    });
    if (caret < 0) return null;
    const { [id]: _inlined, ...pastes } = draft.pastes;
    return { patch: { text, pastes, historyNav: null }, caret };
  }

  window.OMP_SESSION_UI = {
    entryOf, updateEntry, pruneEntries,
    PLAN_IDLE, togglePlan, enterPlan, approvePlan, annotatePlan, markPlanSent,
    DRAFT_IDLE, recallInDraft,
    normalizePaste, shouldCollapsePaste, collapsePaste, pastesIn, expandPastes, inlinePaste,
  };
})();
