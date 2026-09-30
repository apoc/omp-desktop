// Session-name tab rename: pure helpers behind live.js's after-first-turn
// auto-rename. omp's RPC mode never auto-titles (main.ts pins PI_NO_TITLE=1
// for --mode rpc and only the TUI/CLI call maybeStartTitleGeneration), so
// the app asks for the title itself: once the first exchange settles,
// live.js sends the bare `/rename` builtin (which generates a title from the
// conversation and ignores PI_NO_TITLE), then renames the tab from the
// `session_info_update` frame and the confirming `get_state`.
//
// Exposes `window.OMP_SESSION_TITLE`; IIFE per the project rule for plain
// <script> tags. Regression: test-session-title.mjs.
(function () {
  /** Whether this `get_state` snapshot should fire the automatic `/rename`
   *  for a fresh tab: the tab is still armed (fresh — not a resume — and the
   *  send happens at most once per arming), the session is idle (never
   *  mid-turn), the first exchange is fully persisted (`messageCount >= 2`
   *  = user + assistant), and omp has not titled the session yet. An empty
   *  `sessionName` counts as untitled, same as the tab-name write in
   *  `_applyRpcState`. */
  function shouldAutoRename(rpcState, armed) {
    if (!armed || !rpcState) return false;
    if (rpcState.sessionName) return false;
    if (rpcState.isStreaming) return false;
    return typeof rpcState.messageCount === "number" && rpcState.messageCount >= 2;
  }

  // omp's own bare-`/rename` confirmation and refusal lines (see
  // slash-commands/builtin-lifecycle.ts rename handle): success, no title
  // generated, user-set name takes precedence, generation threw.
  const RENAME_NOTE_PREFIXES = [
    "Session renamed to ",
    "Could not generate a session title",
    "Session name not changed",
    "Rename failed",
  ];

  /** Whether a `command_output` text is one of the automatic rename's
   *  outcome notes — plumbing, not conversation, so live.js swallows it
   *  (once) while its own rename is in flight. A user-typed `/rename` never
   *  sets the in-flight flag, so its confirmation still reaches the
   *  transcript. If omp ever rewords these, the failure mode is one visible
   *  note, not a lost rename — the rename rides on `session_info_update`
   *  and `get_state`, which are matched structurally, not by text. */
  function isAutoRenameNote(text) {
    if (typeof text !== "string") return false;
    const t = text.trim();
    return RENAME_NOTE_PREFIXES.some(p => t.startsWith(p));
  }

  /** `session_info_update`'s title as a usable tab name, or null when the
   *  frame carries nothing to rename to (missing/empty/non-string). */
  function sessionTitleFromEvent(ev) {
    const raw = ev && typeof ev.title === "string" ? ev.title.trim() : "";
    return raw || null;
  }

  window.OMP_SESSION_TITLE = { shouldAutoRename, isAutoRenameNote, sessionTitleFromEvent };
})();
