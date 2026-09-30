#!/usr/bin/env node
// Regression script for src/app/session-title.js — the pure gate, note
// matcher, and title extractor behind the after-first-turn auto `/rename`
// that renames a fresh tab from its omp session name.
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

console.log(`ok — test-session-title.mjs (${passed} checks)`);
