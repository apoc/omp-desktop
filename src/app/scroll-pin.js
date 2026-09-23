/* ═════════════════════════════════════════════════════════════════════
   app/scroll-pin.js — "stick to bottom" state machine for the chat view.
   Pure functions only; chat/chat-view.jsx owns the DOM side. Pinned means
   the view follows new content; unpinned means the user is reading
   history and nothing may move the viewport under them.
   ═════════════════════════════════════════════════════════════════════ */
(function () {
  // Scrolling *down* to within this distance of the bottom re-pins. Kept
  // small so reading the last screen of a finished answer does not lock on.
  const REPIN_SLACK_PX = 24;
  // Sub-pixel scroll offsets on fractional-DPI displays: a view this close
  // to the bottom is at the bottom.
  const AT_BOTTOM_EPS_PX = 1;

  function distanceFromBottom(m) {
    return m.scrollHeight - m.scrollTop - m.clientHeight;
  }

  // Next pinned state after a scroll event. `prevTop` is scrollTop at the
  // previous scroll event; `m` is { scrollTop, scrollHeight, clientHeight }.
  //  - Moving up away from the bottom is the user scrolling back: unpin
  //    immediately, however small the step (a smooth wheel scroll starts
  //    with a few px, and any follow-scroll in between would cancel it).
  //  - Moving up while still at the bottom is the browser clamping
  //    scrollTop after content above shrank (transcript trim): keep state.
  //  - Moving down (or content growth) re-pins once near the bottom.
  function nextPinned(pinned, prevTop, m) {
    const dist = distanceFromBottom(m);
    if (m.scrollTop < prevTop) return dist <= AT_BOTTOM_EPS_PX ? pinned : false;
    return dist <= REPIN_SLACK_PX ? true : pinned;
  }

  // An explicit "take me to the latest" moment: a new user message becomes
  // the tail (sending, steering, queueing a follow-up), or the transcript
  // was reset to empty (`/new`, a profile switch respawning the tab) — a
  // leftover unpinned state must not strand "Jump to latest" over a blank
  // chat or a fresh session.
  function shouldRepin(prevLastId, messages) {
    if (!messages.length) return true;
    const last = messages[messages.length - 1];
    return last?.kind === "user" && last._id != null && last._id !== prevLastId;
  }

  window.OMP_SCROLL_PIN = { nextPinned, shouldRepin };

})();
