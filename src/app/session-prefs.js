// Settings → Session / Agent behaviours that live.js applies (#37):
// the prefs it takes from the tweaks, and the "ask before closing a busy
// tab" confirmation — when closing a tab or quitting asks first, and what
// the dialog says. Pure; live.js owns the side effects (the boot restore,
// the auto-title gate, the omp switches, the Rust close guard).
//
// Exposes `window.OMP_SESSION_PREFS`; IIFE per the project rule for plain
// <script> tags. Reads window.OMP_TURN_STATUS (app/turn-status.js, loaded
// later) at call time only. Regression: test-session-prefs.mjs.
(function () {
  /** The tweak keys live.js acts on (TWEAK_DEFAULTS, app/constants.js). */
  const KEYS = Object.freeze(["restoreTabs", "confirmBusyClose", "autoName", "autoRetry"]);

  /** The prefs from a tweaks object: each key's boolean, else its default
   *  (a missing or malformed stored value never flips a behaviour). */
  function fromTweaks(values, defaults) {
    const prefs = {};
    for (const key of KEYS) {
      const v = values?.[key];
      prefs[key] = typeof v === "boolean" ? v : defaults?.[key] === true;
    }
    return prefs;
  }

  /** The keys whose value differs between two prefs objects. */
  function changedKeys(prev, next) {
    return KEYS.filter(key => prev?.[key] !== next?.[key]);
  }

  // What each busy run state (`OMP_TURN_STATUS.runStateOf`) is called in
  // the dialog.
  const BUSY_LABELS = Object.freeze({
    "running":      "working",
    "retrying":     "retrying a failed request",
    "waiting-user": "waiting for your answer",
    "background":   "running background jobs",
  });

  /** The open tabs whose agent is still at work, as `{id, name, state}`
   *  (`state`: what it is doing, for the dialog). `sessions` is the
   *  snapshot's tab list, each with its `runState`. */
  function busyTabs(sessions) {
    if (!Array.isArray(sessions)) return [];
    const { isBusyRunState } = window.OMP_TURN_STATUS;
    return sessions
      .filter(s => s && isBusyRunState(s.runState))
      .map(s => ({ id: s.id, name: s.name || "untitled tab", state: BUSY_LABELS[s.runState] ?? "working" }));
  }

  /** Whether the Rust close guard should hold the window's close: the
   *  setting is on and some tab is busy. */
  function closeGuardArmed(prefs, sessions) {
    // Runs on every notify: no per-tab objects just to test for one.
    if (!prefs?.confirmBusyClose || !Array.isArray(sessions)) return false;
    const { isBusyRunState } = window.OMP_TURN_STATUS;
    return sessions.some(s => s && isBusyRunState(s.runState));
  }

  /** The confirmation closing tab `id` needs, or null to close at once
   *  (setting off, tab idle or unknown). */
  function tabCloseConfirm(prefs, sessions, id) {
    if (!prefs?.confirmBusyClose) return null;
    const tab = busyTabs(sessions).find(t => t.id === id);
    if (!tab) return null;
    return {
      kind: "tab",
      id,
      title: "Close a busy tab?",
      body: "This tab's agent is still at work. Closing the tab stops it.",
      tabs: [tab],
      confirmLabel: "close tab",
    };
  }

  /** The confirmation quitting needs, or null to quit at once. */
  function quitConfirm(prefs, sessions) {
    if (!prefs?.confirmBusyClose) return null;
    const tabs = busyTabs(sessions);
    if (tabs.length === 0) return null;
    const one = tabs.length === 1;
    return {
      kind: "quit",
      title: one ? "Quit with a busy tab?" : `Quit with ${tabs.length} busy tabs?`,
      body: one
        ? "A tab's agent is still at work. Quitting stops it."
        : "These tabs' agents are still at work. Quitting stops them.",
      tabs,
      confirmLabel: "quit",
    };
  }

  window.OMP_SESSION_PREFS = Object.freeze({
    KEYS, fromTweaks, changedKeys, busyTabs, closeGuardArmed, tabCloseConfirm, quitConfirm,
  });
})();
