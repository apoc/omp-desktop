// OS attention for work that needs the user while the window is in the
// background: the dock-icon bounce shared by rail widget attention
// (app/use-widgets.jsx) and questions opened in any tab (live.js's
// `agent://attention` overlay). Pure decisions plus the one Tauri call, so
// both sites bounce the same way.
//
// Exposes `window.OMP_ATTENTION`; IIFE per the project rule for plain
// <script> tags. Regression: test-attention.mjs.
(function () {
  /** One dock bounce (macOS; the OS decides elsewhere): Informational,
   *  no-op without the Tauri window API or the capability. */
  function requestAttention(win) {
    try {
      const w = win?.__TAURI__?.window;
      w?.getCurrentWindow().requestUserAttention(w.UserAttentionType?.Informational ?? 2)?.catch?.(() => {});
    } catch { /* unsupported: no bounce */ }
  }

  // The tracker's per-session ask-open sequence (`asksOpened` in
  // `SessionSnapshot`): it rises with every new question, even when another
  // was answered in the same batch. An outstanding count cannot do that.
  const opened = entry => (Number.isFinite(entry?.asksOpened) ? entry.asksOpened : 0);

  /** Whether `next` has a question that opened after `previous` in any
   *  session: the dock bounce fires once per new ask, not once per snapshot.
   *  A first snapshot (no `previous`) does not bounce — its asks are not
   *  new. Two questions in one snapshot count once, which is enough: the
   *  window is already bouncing. */
  function newAsk(previous, next) {
    if (!previous || !next) return false;
    return Object.keys(next).some(id => opened(next[id]) > opened(previous[id]));
  }

  /** Whether a tracker snapshot should bounce the dock: a new ask while the
   *  window is not focused (a focused window already shows the tab dot). */
  function shouldBounce({ previous, next, focused }) {
    return !focused && newAsk(previous, next);
  }

  window.OMP_ATTENTION = Object.freeze({ requestAttention, newAsk, shouldBounce });
})();
