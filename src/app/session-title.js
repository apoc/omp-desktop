// Session-name tab rename: pure helpers behind live.js's automatic omp
// session titling. RPC-mode omp never auto-titles (main.ts pins
// PI_NO_TITLE=1 for --mode rpc and only the TUI/CLI call
// maybeStartTitleGeneration), so the app asks for the title itself: once
// the first exchange settles, live.js sends the bare `/rename` builtin
// (which generates a title from the conversation and ignores PI_NO_TITLE),
// then renames the tab from the `session_info_update` frame and the
// confirming `get_state`. The title is then refreshed from the newer
// conversation every REFINE_EVERY_TURNS terminal agent turns, at most REFINE_MAX
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
   *  same as the tab-name write in `_applyRpcState`. A user-typed `/rename`
   *  disarms this one-shot upstream, so it does not race a manual rename
   *  that has not yet set `sessionName`. */
  function shouldAutoRename(rpcState, armed, lastTurnOk) {
    if (!armed || !lastTurnOk || !rpcState) return false;
    if (rpcState.sessionName) return false;
    if (rpcState.isStreaming) return false;
    return typeof rpcState.messageCount === "number" && rpcState.messageCount >= 2;
  }

  // Refinement cadence: every REFINE_EVERY_TURNS terminal agent turns after
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
   *  the point. A user-typed `/rename` disarms the one-shot and zeroes the
   *  budget upstream, so a manual title is never overwritten. */
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
   *  transcript. Not every run produces a note: abort and a superseded
   *  generation (`!isCurrent()` or `title === undefined`) return silently.
   *  live.js releases the in-flight flag on the abort response in that
   *  case. A reworded note is still only one visible line — the rename
   *  itself rides on `session_info_update` and `get_state`, matched
   *  structurally, not by text. */
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

  /** After omp's `abort` response, whether the one-shot should be armed
   *  again. Abort cancels title generation and the bare `/rename` then
   *  returns with no note. Re-arm only when nothing has titled the session
   *  yet: omp's `sessionName` is empty and the tab label is still the
   *  folder fallback. A title that already landed (`sessionName`, or
   *  `session_info_update` writing a different tab name before this
   *  response) must not be retried; the refinement budget stays spent.
   *  A generated title that equals the folder name looks untitled until
   *  the next `get_state` reports `sessionName`, and `shouldAutoRename`
   *  then no-ops. */
  function shouldRearmAfterAbort(rpcState, tabName, untitledLabel) {
    if (rpcState && rpcState.sessionName) return false;
    return tabName === untitledLabel;
  }

  /** Whether `text` is a user-typed `/rename` (optional title arguments).
   *  The command name ends where omp's `parseSlashCommand` ends it: at the
   *  first whitespace or `:`, so `/rename:My Title` is a manual rename
   *  too. The name must be exactly `rename`: omp's builtin dispatch is
   *  case-sensitive, and a skill or template named `/rename-files` must
   *  not retire the automatic title. */
  function isManualRename(text) {
    if (typeof text !== "string") return false;
    const tok = /^\/([^\s:]*)/.exec(text.trim())?.[1];
    return tok === "rename";
  }

  /** Whether the tab's auto-rename state belongs to an omp session other
   *  than the one `get_state` now reports. omp can switch sessions inside
   *  the process without an RPC `new_session` (`/resume`, `/branch` typed
   *  as prompts). A pending `/rename` then returns without a note (its
   *  `isCurrent()` checks the session id), and leftover refinement budget
   *  would retitle a conversation whose name may be a manual one — the
   *  same reason a resumed tab starts without budget. Unknown on either
   *  side (nothing sent yet, older omp without `sessionId`) is not stale. */
  function isRenameStateStale(rpcState, boundSessionId) {
    const current = rpcState && rpcState.sessionId;
    return !!(boundSessionId && current && current !== boundSessionId);
  }

  /** Whether an `agent_end` counts toward the refine cadence. Non-terminal
   *  ends (`isTerminal: false`) are scheduling pauses — continuations,
   *  queued follow-ups — not completed turns. A missing `isTerminal`
   *  counts: older omp omitted the field and only emitted terminal ends. */
  function countsAsRefineTurn(ev) {
    return !!(ev && ev.type === "agent_end" && ev.isTerminal !== false);
  }

  /** A title the user typed for the manual rename action (#32), as the
   *  `/rename` command that sets it and the confirmation note omp prints
   *  for it; null when nothing is left after cleaning. Cleaning mirrors
   *  omp's `SessionManager.#cleanTitle` (control characters to spaces,
   *  space runs collapsed, trimmed) so the args omp parses back out of the
   *  command are exactly `title`, and the note — `Session renamed to
   *  ${args}.` in the rename builtin — matches byte for byte. live.js
   *  swallows exactly that note; refusals and errors stay visible. */
  function manualRename(raw) {
    if (typeof raw !== "string") return null;
    const title = raw
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/ +/g, " ")
      .trim();
    if (!title) return null;
    return { title, command: `/rename ${title}`, note: `Session renamed to ${title}.` };
  }

  /** `notes` (the tab's pending manual-rename confirmations) without the
   *  first entry equal to `text`, or null when `text` is not pending.
   *  One entry per in-flight rename: two renames to the same title expect
   *  two notes, and each swallow or settle removes exactly one. */
  function dropPendingNote(notes, text) {
    const idx = Array.isArray(notes) ? notes.indexOf(text) : -1;
    if (idx === -1) return null;
    return [...notes.slice(0, idx), ...notes.slice(idx + 1)];
  }

  window.OMP_SESSION_TITLE = {
    shouldAutoRename, shouldRefineTitle, isAutoRenameNote, sessionTitleFromEvent,
    isManualRename, isRenameStateStale, shouldRearmAfterAbort, countsAsRefineTurn,
    manualRename, dropPendingNote,
    REFINE_EVERY_TURNS, REFINE_MAX,
  };
})();
