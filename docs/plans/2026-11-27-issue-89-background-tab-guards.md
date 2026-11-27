# Issue #89: guards must see background tabs' live state

Decision record for `fix/bg-tab-guards`. Base: PR #88 head `586bc39` (`fix/background-ask-indicator`), on master `88206e0`. The operator chose to build on #88. Its tracker → webview plumbing (`agent://attention`, `attention_snapshot`, `trackerLive`, `TURN.displayRunState`) is the live signal this fix reads.

## Problem (verified)

A background tab's `runState` is the snapshot frozen when the tab was left (`live.js` `_sessionsView`). Every guard reads it:

- approval-mode restarts (`restartPlan` / `_applyApprovalModes` / `_respawnSession`);
- the tab-close and quit confirmations;
- the Rust window close guard (`set_close_guard` armed from `closeGuardArmed`);
- the updater's busy count;
- the PR automation and branch-picker sibling checks.

A turn that starts after the freeze is invisible to all of them, so a mode change, a tab close or a quit kills it without asking. A prompt sent while its tab is respawning is lost: the bubble is added, and the command is a silent no-op or reaches the dying process. #88 deliberately left guards alone. Its history holds guard prior art that was reverted to limit scope: commits `0831e07`, `72a938e`, `45077e5`, and the revert `3935a60`. Read it; don't blindly restore it.

## Decisions

- **D89-1 Guard state = raise-only union.**
  - A background tab's `runState` in `_sessionsView` becomes `TURN.guardRunState(cached, display)`: the stronger of the frozen `runStateOf` and #88's `displayRunState`, by `RUN_STATE_RANK`, with `failed` staying `failed`.
  - It never lowers below the frozen state. A frozen busy tab that went idle stays busy for guards, as on master: annoying but safe.
  - The active tab is unchanged, and `displayRunState` (the dots) is unchanged.
  - Every existing `runState` consumer gets it without per-consumer code.
  - #88's test that guards ignore the tracker is replaced by tests of the new rule.
- **D89-2 Fresh tracker data at decision time.** `closeSessionGuarded` and `_requestQuit` first refresh the tracker (`attention_snapshot` → `_applyAttention(snapshot, false)`, no dock bounce), then compute the confirmation. A failed or `null` refresh falls back to the current view.
- **D89-3 The Rust close guard also reads the tracker.**
  - `CloseGuard` holds two flags: `armed` (the webview's view, as now) and `enabled` (Settings "ask before closing a busy tab").
  - `set_close_guard { armed, enabled }`.
  - `holds_close` holds the main window when `armed`, or when `enabled` and the tracker snapshot has any session that is busy, has an open ask, or has background work.
  - This closes the gap between a tracker change and the webview re-arming. The webview keeps re-arming on every `notify()`, attention included.
- **D89-4 Native conditional stop.**
  - `AgentBridge::stop_session_if_idle(session_id)`, plus the Tauri command `stop_session_if_idle { sessionId }` added to `generate_handler!`.
  - Under the sessions map lock it reads the tracker entry for the id. If it is busy, has open asks or has background work, it refuses with no side effects and returns `{ stopped: false, busy: true }`.
  - Otherwise it does exactly what `stop_session` does and returns `{ stopped: true, busy: false }`.
  - No tracker entry counts as idle. An unknown session behaves like `stop_session`'s unknown case.
  - The window between the check and the kill (a frame recorded by the reader right after) is accepted. Document it next to the function.
- **D89-5 Only approval restarts are conditional.**
  - `_respawnSession` gains an `ifIdle` option, used only by `_applyApprovalModes`.
  - With it, the conditional stop is the restart's first side effect: before dictation stop, listener teardown, snapshot deletion and the registry update. A refusal performs no teardown and returns `{ deferred: true }`, and the tab's change stays pending.
  - Profile switches and every other respawn keep the unconditional stop.
- **D89-6 The JS plan never kills on its own judgement for background tabs.**
  - For a non-failed background tab whose running mode differs from its target, `_applyApprovalModes` always attempts the conditional stop: Rust's tracker decides.
  - A refused tab is retried when an applied attention payload shows that tab idle (`busy` false, `asks` 0, `background` false), and on activation / `get_state` as today.
  - `_modeRestartMissed` and the re-entry guards keep working.
  - The active tab keeps `restartPlan`'s live-state decision, but its kill also goes through the conditional stop, so the gap between the plan and the kill is closed.
- **D89-7 No prompt is lost to a restart.**
  - While the tab the user is on is respawning, the user-entry sends (`_sendPrompt`, `_sendQueued` and so steer/followUp, the message-queue drain, and anything else the composer submit reaches) refuse. No user bubble and no command go out.
  - The composer keeps the typed text: not cleared, or restored if the submit path clears it first.
  - A short note tells the user the tab is restarting and to send again (`OMP_TR`, with a zh dictionary entry).
  - The respawn's own `_initFetch` sends are not blocked: gate the entry points, not `_send`.
- **D89-8 Docs.**
  - `docs/architecture/turn-status.md`: #88's "guards ignore the tracker" text becomes D89-1/D89-2.
  - `approval-mode.md`: D89-5/D89-6.
  - `settings.md`: the close guard, D89-3.
  - The AGENTS.md cross-feature note on `stop_session`: mention `stop_session_if_idle`, approval restarts only.
  - CHANGELOG `[Unreleased]` → `### Fixed`.

## Tests (required)

- Pure: `guardRunState` (raise, never lower, `failed` wins); `session-prefs` busy/confirm/guard helpers over guard states.
- `live.js` harness (`tests/test-attention-bridge.mjs` and the stub pattern of `tests/test-pr-automation-bridge.mjs`):
  - a background tab frozen idle while the tracker reports busy → the close confirmation is asked, the quit confirmation is asked, and `set_close_guard` is armed;
  - an approval-mode change on it → `stop_session_if_idle` is called, a refusal leaves the tab untouched and pending, and an attention payload showing it idle retries and restarts it;
  - a prompt submitted during a respawn → no `prompt` command, no bubble, and the draft is kept.
- Rust:
  - `stop_session_if_idle` refuses while the tracker is busy, has asks or has background work, and stops when idle (no child process needed if the seam allows; follow the existing `agent/mod.rs` test style);
  - `holds_close` truth table with `enabled`, `armed` and tracker state.
