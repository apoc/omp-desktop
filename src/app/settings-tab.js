// Settings tab (#37): open / active / section state of the app tab pinned
// after the project tabs, as pure helpers.
//
// Exposes `window.OMP_SETTINGS_TAB`; wrapped as an IIFE per the project rule
// for plain <script> tags (see AGENTS.md "IIFE rule").
//
// The settings tab is no session: the omp tab that was active stays
// `activeSessionId` while settings shows, so closing or leaving settings
// returns to it. The state is never persisted (a restart starts closed).
(function () {
  const DEFAULT_SECTION = "appearance";

  /** Closed, on the first section. */
  const initial = () => ({ open: false, active: false, section: DEFAULT_SECTION });

  /** Opens and activates the tab, on `section` if given, else where it was. */
  const open = (state, section) => ({ open: true, active: true, section: section || state.section || DEFAULT_SECTION });

  /** Closes the tab; the next open starts on the first section again. */
  const close = () => initial();

  /** A project tab was picked: settings stays open but steps back. */
  const selectProject = (state) => (state.active ? { ...state, active: false } : state);

  /** Moves to another section while open. */
  const setSection = (state, section) => (state.section === section ? state : { ...state, section });

  /** Next / previous tab (`dir` 1 or -1) for desktop.tab.next/prev, the
   *  settings tab being the last position while open. Returns which tab
   *  ends up shown: `settingsActive`, and the session to keep or switch to
   *  (unchanged while settings is the target). */
  function cycle(state, sessionIds, activeSessionId, dir) {
    const ids = sessionIds ?? [];
    const slots = state.open ? ids.length + 1 : ids.length;
    if (slots === 0) return { settingsActive: false, sessionId: activeSessionId ?? null };
    const found = ids.indexOf(activeSessionId);
    const cur = state.open && state.active
      ? ids.length
      : found >= 0 ? found : dir < 0 ? ids.length : -1;
    const next = (((cur + (dir < 0 ? -1 : 1)) % slots) + slots) % slots;
    if (next === ids.length) return { settingsActive: true, sessionId: activeSessionId ?? null };
    return { settingsActive: false, sessionId: ids[next] };
  }

  window.OMP_SETTINGS_TAB = Object.freeze({ initial, open, close, selectProject, setSection, cycle });
})();
