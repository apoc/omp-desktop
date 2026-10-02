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

  window.OMP_SESSION_UI = {
    entryOf, updateEntry, pruneEntries,
    PLAN_IDLE, togglePlan, enterPlan, approvePlan, annotatePlan, markPlanSent,
    DRAFT_IDLE, recallInDraft,
  };
})();
