// Session-name tab rename: pure helpers behind live.js's automatic omp
// session titling. RPC-mode omp never auto-titles (main.ts pins
// PI_NO_TITLE=1 for --mode rpc and only the TUI/CLI call
// maybeStartTitleGeneration), so the app asks for the title itself: once
// the first exchange settles, live.js sends the bare `/rename` builtin
// (which generates a title from the conversation and ignores PI_NO_TITLE),
// then renames the tab from the `session_info_update` frame and the
// confirming `get_state`. The title is then refreshed from the newer
// conversation every REFINE_EVERY_TURNS user turns, at most REFINE_MAX
// times — a bare `/rename` overwrites its own previous generated title
// (omp's "user" source only shields against "auto" writes), but a
// user-typed `/rename` stops all automatic renaming.
//
// Exposes `window.OMP_SESSION_TITLE`; IIFE per the project rule for plain
// <script> tags. Regression: test-session-title.mjs.
(function () {
  /** Whether this `get_state` snapshot should fire the automatic `/rename`
   *  for a fresh tab: the tab is still armed (fresh — not a resume — and the
   *  send happens at most once per arming), no assistant turn has ended in
   *  error/abort (`lastTurnOk` — omp counts error/aborted assistant
   *  messages in `messageCount`, so without this a failed first exchange,
   *  e.g. a fresh profile before `/login`, would silently spend the
   *  one-shot), the session is idle (never mid-turn), the first exchange is
   *  fully persisted (`messageCount >= 2` = user + assistant), and omp has
   *  not titled the session yet. An empty `sessionName` counts as untitled,
   *  same as the tab-name write in `_applyRpcState`. */
  function shouldAutoRename(rpcState, armed, lastTurnOk) {
    if (!armed || !lastTurnOk || !rpcState) return false;
    if (rpcState.sessionName) return false;
    if (rpcState.isStreaming) return false;
    return typeof rpcState.messageCount === "number" && rpcState.messageCount >= 2;
  }

  // Refinement cadence: every REFINE_EVERY_TURNS completed user turns after
  // a title was generated, at most REFINE_MAX refreshes per conversation.
  // 5 turns ≈ one tiny-model call per meaningful chunk of work, and omp
  // titles from the last 6 turns (REPLAN_TITLE_CONTEXT_TURN_LIMIT), so
  // each refresh actually sees the new material. The cap bounds both label
  // churn and cost: after it, the tab keeps its last generated name.
  const REFINE_EVERY_TURNS = 5;
  const REFINE_MAX = 2;

  /** Whether this idle `get_state` snapshot should fire an automatic
   *  title *refresh*: the budget allows it, enough turns have completed
   *  since the last title write, the last turn ended cleanly (same reason
   *  as `shouldAutoRename` — an error/abort turn would only pollute the
   *  title context), and no turn is mid-flight. Unlike the initial rename
   *  this deliberately fires on an already-titled session: refreshing is
   *  the point. A user-typed `/rename` zeroes the budget upstream, so a
   *  manual title is never overwritten. */
  function shouldRefineTitle(rpcState, turnsSinceRename, refinementsLeft, lastTurnOk) {
    if (!rpcState || !lastTurnOk) return false;
    if (!(refinementsLeft > 0)) return false;
    if (!(turnsSinceRename >= REFINE_EVERY_TURNS)) return false;
    if (rpcState.isStreaming) return false;
    return true;
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

  window.OMP_SESSION_TITLE = {
    shouldAutoRename, shouldRefineTitle, isAutoRenameNote, sessionTitleFromEvent,
    REFINE_EVERY_TURNS, REFINE_MAX,
  };
})();
