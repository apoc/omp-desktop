#!/usr/bin/env node
// Regression script for src/app/session-title.js — the pure gates, note
// matcher, title extractor, manual-rename token, abort re-arm, and
// refine-turn counter behind the automatic omp session titling:
// the after-first-turn `/rename` and its later periodic refreshes.
// Run: node test-session-title.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const src   = readFileSync(join(__dir, "src/app/session-title.js"), "utf8");
const win   = {};
// eslint-disable-next-line no-new-func
new Function("window", src)(win);
const T = win.OMP_SESSION_TITLE;

let passed = 0;
function check(label, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`FAILED: ${label}`);
    throw err;
  }
  passed++;
}

const OK = true;

check("an armed idle tab with a finished exchange and no title renames", () => {
  assert.equal(T.shouldAutoRename({ isStreaming: false, messageCount: 2 }, true, OK), true);
});

check("an unarmed tab never renames, however complete its state", () => {
  assert.equal(T.shouldAutoRename({ isStreaming: false, messageCount: 9 }, false, OK), false);
});

check("a failed or aborted last turn never spends the one-shot", () => {
  // omp counts error/aborted assistant messages in messageCount, so without
  // this a failed first exchange (fresh profile before /login, provider
  // outage, Esc) would burn the auto-rename silently.
  assert.equal(T.shouldAutoRename({ isStreaming: false, messageCount: 2 }, true, false), false);
});

check("the trigger never fires mid-turn", () => {
  assert.equal(T.shouldAutoRename({ isStreaming: true, messageCount: 5 }, true, OK), false);
});

check("one message (user turn not yet answered) is not a completed exchange", () => {
  assert.equal(T.shouldAutoRename({ isStreaming: false, messageCount: 1 }, true, OK), false);
});

check("a session omp already titled is left alone", () => {
  assert.equal(
    T.shouldAutoRename({ isStreaming: false, messageCount: 4, sessionName: "Fix login bug" }, true, OK),
    false,
  );
});

check("an empty sessionName counts as untitled and fires", () => {
  assert.equal(
    T.shouldAutoRename({ isStreaming: false, messageCount: 2, sessionName: "" }, true, OK),
    true,
  );
});

check("a missing or non-numeric messageCount never fires", () => {
  assert.equal(T.shouldAutoRename({ isStreaming: false }, true, OK), false);
  assert.equal(T.shouldAutoRename({ isStreaming: false, messageCount: "2" }, true, OK), false);
});

check("a null snapshot never fires", () => {
  assert.equal(T.shouldAutoRename(null, true, OK), false);
});


// ── shouldRefineTitle ───────────────────────────────────────────────────

check("the refresher fires at the cadence with budget left", () => {
  assert.equal(T.shouldRefineTitle({ isStreaming: false, sessionName: "Old Title" }, T.REFINE_EVERY_TURNS, 2, OK), true);
});

check("the refresher fires on an already-titled session (refreshing is the point)", () => {
  // Deliberate asymmetry with shouldAutoRename, which skips titled sessions.
  assert.equal(T.shouldRefineTitle({ isStreaming: false, sessionName: "Whatever" }, 7, 1, OK), true);
});

check("turns below the cadence never refine", () => {
  assert.equal(T.shouldRefineTitle({ isStreaming: false, sessionName: "X" }, T.REFINE_EVERY_TURNS - 1, 2, OK), false);
});

check("a spent budget never refines, however old the title", () => {
  assert.equal(T.shouldRefineTitle({ isStreaming: false, sessionName: "X" }, 99, 0, OK), false);
});

check("a missing or non-positive budget never refines", () => {
  assert.equal(T.shouldRefineTitle({ isStreaming: false, sessionName: "X" }, 99, undefined, OK), false);
  assert.equal(T.shouldRefineTitle({ isStreaming: false, sessionName: "X" }, 99, -1, OK), false);
});

check("the refresher never fires mid-turn", () => {
  assert.equal(T.shouldRefineTitle({ isStreaming: true, sessionName: "X" }, 99, 2, OK), false);
});

check("a failed last turn never refines", () => {
  assert.equal(T.shouldRefineTitle({ isStreaming: false, sessionName: "X" }, 99, 2, false), false);
});

check("a null snapshot never refines", () => {
  assert.equal(T.shouldRefineTitle(null, 99, 2, OK), false);
});

// ── isAutoRenameNote ────────────────────────────────────────────────────
// omp's exact outcome strings, verbatim from slash-commands/
// builtin-lifecycle.ts (rename handle) — paraphrased fixtures would let an
// omp rewording slip past the prefix matcher unnoticed.
check("omp's four bare-/rename outcome notes all match", () => {
  for (const text of [
    "Session renamed to Fix login bug.",
    "Could not generate a session title. Use /rename <title> to set one.",
    "Session name not changed (a user-set name takes precedence).",
    "Rename failed: model unavailable",
  ]) {
    assert.equal(T.isAutoRenameNote(text), true, text);
  }
});

check("leading whitespace does not defeat the match", () => {
  assert.equal(T.isAutoRenameNote("  Session renamed to X"), true);
});

check("an unrelated command note passes through", () => {
  assert.equal(T.isAutoRenameNote("No running jobs."), false);
  assert.equal(T.isAutoRenameNote("Renamed sessions listed"), false);
});

check("a non-string payload is not a note", () => {
  assert.equal(T.isAutoRenameNote(undefined), false);
  assert.equal(T.isAutoRenameNote({ text: "Session renamed to X" }), false);
});

// ── sessionTitleFromEvent ─────────────────────────────────────────────────

check("a titled session_info_update yields the trimmed title", () => {
  assert.equal(T.sessionTitleFromEvent({ type: "session_info_update", title: "  Fix login bug  " }), "Fix login bug");
});

check("an empty or whitespace title yields null (nothing to rename to)", () => {
  assert.equal(T.sessionTitleFromEvent({ title: "" }), null);
  assert.equal(T.sessionTitleFromEvent({ title: "   " }), null);
});

check("a missing or non-string title yields null", () => {
  assert.equal(T.sessionTitleFromEvent({}), null);
  assert.equal(T.sessionTitleFromEvent({ title: 42 }), null);
  assert.equal(T.sessionTitleFromEvent(null), null);
});


// ── isManualRename ──────────────────────────────────────────────────────

check("a bare or argued /rename is a manual rename", () => {
  assert.equal(T.isManualRename("/rename"), true);
  assert.equal(T.isManualRename("/rename Fix login bug"), true);
  assert.equal(T.isManualRename("  /rename   My Title"), true);
});

check("omp's colon spelling /rename:Title is a manual rename", () => {
  // omp's parseSlashCommand ends the name at the first whitespace or `:`,
  // so this runs the rename builtin with args "My Title"; missing it let a
  // later refresh overwrite the title the user typed.
  assert.equal(T.isManualRename("/rename:My Title"), true);
  assert.equal(T.isManualRename("/rename:"), true);
  assert.equal(T.isManualRename("/rename-files:x"), false);
});

check("a prefix, a different case, or a non-command is not a manual rename", () => {
  // omp's builtin dispatch is case-sensitive, and a skill named
  // /rename-files must not retire the automatic title.
  assert.equal(T.isManualRename("/rename-files"), false);
  assert.equal(T.isManualRename("/renamer do it"), false);
  assert.equal(T.isManualRename("/RENAME"), false);
  assert.equal(T.isManualRename("/Rename title"), false);
  assert.equal(T.isManualRename("rename"), false);
  assert.equal(T.isManualRename("/rename/"), false);
});

check("a non-string is not a manual rename", () => {
  assert.equal(T.isManualRename(undefined), false);
  assert.equal(T.isManualRename(null), false);
});

// ── isRenameStateStale ─────────────────────────────────────────────────

check("an in-process session switch retires the auto-rename state", () => {
  // /resume or /branch typed as a prompt: the pending /rename returns
  // silently and leftover budget must not retitle the other conversation.
  assert.equal(T.isRenameStateStale({ sessionId: "b" }, "a"), true);
});

check("the same session, or an unknown side, is not stale", () => {
  assert.equal(T.isRenameStateStale({ sessionId: "a" }, "a"), false);
  // Nothing sent yet: the state is not bound to any session.
  assert.equal(T.isRenameStateStale({ sessionId: "b" }, null), false);
  // An omp that reports no sessionId can't prove a switch.
  assert.equal(T.isRenameStateStale({}, "a"), false);
  assert.equal(T.isRenameStateStale(null, "a"), false);
});

// ── shouldRearmAfterAbort ───────────────────────────────────────────────

check("an abort before any title re-arms the one-shot", () => {
  assert.equal(T.shouldRearmAfterAbort({ sessionName: "" }, "proj", "proj"), true);
  assert.equal(T.shouldRearmAfterAbort(null, "new session", "new session"), true);
});

check("an abort after a title landed does not re-arm", () => {
  assert.equal(
    T.shouldRearmAfterAbort({ sessionName: "Fix login bug" }, "Fix login bug", "proj"),
    false,
  );
  // session_info_update may have written the tab name before get_state
  // reports sessionName.
  assert.equal(T.shouldRearmAfterAbort({ sessionName: "" }, "Fix login bug", "proj"), false);
  assert.equal(T.shouldRearmAfterAbort({ sessionName: "  " }, "proj", "proj"), false);
});

// ── countsAsRefineTurn ──────────────────────────────────────────────────

check("a terminal or legacy agent_end counts toward the cadence", () => {
  assert.equal(T.countsAsRefineTurn({ type: "agent_end" }), true);
  assert.equal(T.countsAsRefineTurn({ type: "agent_end", isTerminal: true }), true);
});

check("a non-terminal agent_end is a scheduling pause, not a turn", () => {
  assert.equal(T.countsAsRefineTurn({ type: "agent_end", isTerminal: false }), false);
  assert.equal(T.countsAsRefineTurn({ type: "agent_start" }), false);
  assert.equal(T.countsAsRefineTurn(null), false);
});

console.log(`ok — test-session-title.mjs (${passed} checks)`);
