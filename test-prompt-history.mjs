#!/usr/bin/env node
// Regression script for src/app/prompt-history.js — per-tab prompt history
// (issue #16): Arrow Up/Down recall stepping, transcript backfill on
// session restore, and the caret guards that decide when Up/Down belong to
// history vs. normal multi-line editing.
// Run: node test-prompt-history.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const src   = readFileSync(join(__dir, "src/app/prompt-history.js"), "utf8");
const win   = {};
// eslint-disable-next-line no-new-func
new Function("window", src)(win);
const H = win.OMP_PROMPT_HISTORY;

// Real constants.js, loaded the same way — not a synthetic prefix — so the
// parity check below exercises the actual wrapper string live.js normalizes
// against, not a stand-in that can't reproduce the real bug's shape.
const constantsSrc = readFileSync(join(__dir, "src/app/constants.js"), "utf8");
const constantsWin = {};
new Function("window", constantsSrc)(constantsWin);
const { INTENT_FRAMING, APPROVAL_PROMPT } = constantsWin;

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

// ── clampLimit ────────────────────────────────────────────────────────────

check("clamps below MIN_LIMIT up to MIN_LIMIT", () => {
  assert.equal(H.clampLimit(0), H.MIN_LIMIT);
  assert.equal(H.clampLimit(-5), H.MIN_LIMIT);
});
check("clamps above MAX_LIMIT down to MAX_LIMIT", () => {
  assert.equal(H.clampLimit(1_000_000), H.MAX_LIMIT);
});
check("non-numeric input falls back to DEFAULT_LIMIT", () => {
  assert.equal(H.clampLimit(NaN), H.DEFAULT_LIMIT);
  assert.equal(H.clampLimit(undefined), H.DEFAULT_LIMIT);
  assert.equal(H.clampLimit("nope"), H.DEFAULT_LIMIT);
});
check("valid in-range limit passes through, floored", () => {
  assert.equal(H.clampLimit(42.9), 42);
});

// ── record ────────────────────────────────────────────────────────────────

check("blank/whitespace text leaves list unchanged (same reference)", () => {
  const list = ["a"];
  assert.equal(H.record(list, "", 100), list);
  assert.equal(H.record(list, "   ", 100), list);
});
check("new prompt goes to the front", () => {
  assert.deepEqual(H.record(["b", "a"], "c", 100), ["c", "b", "a"]);
});
check("re-sending an existing prompt moves it to front, no duplicate", () => {
  assert.deepEqual(H.record(["c", "b", "a"], "b", 100), ["b", "c", "a"]);
});
check("re-sending the current newest is a no-op (same reference)", () => {
  const list = ["a", "b"];
  assert.equal(H.record(list, "a", 100), list);
});
check("text is trimmed before comparing/storing", () => {
  assert.deepEqual(H.record(["a"], "  b  ", 100), ["b", "a"]);
});
check("respects the limit, dropping the oldest", () => {
  const ten = Array.from({ length: 10 }, (_, i) => `p${i}`); // newest→oldest, p0..p9, already at the cap
  const out = H.record(ten, "new", 10);
  assert.deepEqual(out, ["new", ...ten.slice(0, 9)]); // p9 (oldest) dropped
  assert.equal(out.length, 10);
});
check("record: strips a framing prefix and skips a listed canned prompt, matching promptsFromMessages", () => {
  const opts = { framingPrefix: "FRAME>>>", skip: ["APPROVE"] };
  assert.deepEqual(H.record([], "FRAME>>>the real intent", 100, opts), ["the real intent"]);
  const list = ["a"];
  assert.equal(H.record(list, "APPROVE", 100, opts), list); // skip-listed — list unchanged, same reference
});
check("record: matches a trimEnd()'d framing prefix (e.g. an image-only plan send)", () => {
  const opts = { framingPrefix: "FRAME>>>\n\n" };
  assert.deepEqual(H.record([], "FRAME>>>", 100, opts), []); // wrapper only, no intent text — dropped
});

// ── mergeOlder ────────────────────────────────────────────────────────────

check("appends transcript prompts (oldest-last input) behind live ones", () => {
  const out = H.mergeOlder(["live2", "live1"], ["old1", "old2", "old3"], 100);
  // prompts[] is chronological (oldest first) — merge walks it backward so
  // the most-recently-sent-of-the-old ones lands right after the live tail.
  assert.deepEqual(out, ["live2", "live1", "old3", "old2", "old1"]);
});
check("skips transcript prompts already present anywhere in the list", () => {
  const out = H.mergeOlder(["b", "a"], ["a", "x"], 100);
  assert.deepEqual(out, ["b", "a", "x"]);
});
check("stops at the limit without truncating existing live entries", () => {
  const old = Array.from({ length: 9 }, (_, i) => `old${i}`); // chronological, old0 earliest — one more than fits
  const out = H.mergeOlder(["b", "a"], old, 10);
  // Only 8 fit behind the 2 live entries; old0 (the earliest / least-recently-sent) is dropped.
  assert.deepEqual(out, ["b", "a", "old8", "old7", "old6", "old5", "old4", "old3", "old2", "old1"]);
  assert.equal(out.length, 10);
});
check("no-op merge returns the same reference", () => {
  const list = ["a"];
  assert.equal(H.mergeOlder(list, [], 100), list);
  assert.equal(H.mergeOlder(list, ["a"], 100), list);
});
check("collapses a prompt repeated within the transcript itself (newest occurrence wins)", () => {
  const out = H.mergeOlder([], ["a", "b", "a"], 100);
  assert.deepEqual(out, ["a", "b"]);
});

// ── promptsFromMessages ──────────────────────────────────────────────────

check("extracts only user-kind text messages, in order", () => {
  const msgs = [
    { kind: "user", text: "first" },
    { kind: "assistant", text: "reply" },
    { kind: "tool", text: "ignored" },
    { kind: "user", text: "second" },
  ];
  assert.deepEqual(H.promptsFromMessages(msgs), ["first", "second"]);
});
check("strips a known framing prefix back to the typed intent", () => {
  const prefix = "FRAME>>>";
  const msgs = [{ kind: "user", text: prefix + "the real intent" }];
  assert.deepEqual(H.promptsFromMessages(msgs, { framingPrefix: prefix }), ["the real intent"]);
});
check("drops messages matching a skip list (e.g. canned approval prompt)", () => {
  const msgs = [{ kind: "user", text: "keep me" }, { kind: "user", text: "APPROVE" }];
  assert.deepEqual(H.promptsFromMessages(msgs, { skip: ["APPROVE"] }), ["keep me"]);
});
check("null/undefined messages array yields []", () => {
  assert.deepEqual(H.promptsFromMessages(null), []);
  assert.deepEqual(H.promptsFromMessages(undefined), []);
});
check("strips a framing prefix even when the transcript entry only has its trimEnd()'d form (e.g. an image-only plan send)", () => {
  const prefix = "FRAME>>>\n\n"; // trailing whitespace, like INTENT_FRAMING's real prefix
  const msgs = [{ kind: "user", text: "FRAME>>>" }]; // wrapper with no intent text, already trimmed
  assert.deepEqual(H.promptsFromMessages(msgs, { framingPrefix: prefix }), []);
});

// ── step (Up/Down navigation) ───────────────────────────────────────────

check("Up from idle stashes the draft and returns the newest entry", () => {
  const r = H.step(H.IDLE, ["b", "a"], -1, "my draft");
  assert.deepEqual(r, { nav: { index: 0, draft: "my draft" }, text: "b" });
});
check("Up again steps to the next-older entry, keeping the stashed draft", () => {
  const r = H.step({ index: 0, draft: "my draft" }, ["b", "a"], -1, "b");
  assert.deepEqual(r, { nav: { index: 1, draft: "my draft" }, text: "a" });
});
check("Up past the oldest entry returns null (nowhere to go)", () => {
  assert.equal(H.step({ index: 1, draft: "d" }, ["b", "a"], -1, "a"), null);
});
check("Up on an empty list returns null", () => {
  assert.equal(H.step(H.IDLE, [], -1, "draft"), null);
});
check("Down while idle returns null (nothing to return to)", () => {
  assert.equal(H.step(H.IDLE, ["b", "a"], 1, "draft"), null);
});
check("Down from the newest entry restores the stashed draft and idles", () => {
  const r = H.step({ index: 0, draft: "my draft" }, ["b", "a"], 1, "b");
  assert.deepEqual(r, { nav: H.IDLE, text: "my draft" });
});
check("Down from a deeper entry steps to the next-newer one", () => {
  const r = H.step({ index: 1, draft: "d" }, ["b", "a"], 1, "a");
  assert.deepEqual(r, { nav: { index: 0, draft: "d" }, text: "b" });
});
check("Down clamps to the oldest surviving entry when the list has shrunk under a stale index (defensive)", () => {
  const r = H.step({ index: 5, draft: "d" }, ["c2", "c1", "c0"], 1, "c?");
  assert.deepEqual(r, { nav: { index: 2, draft: "d" }, text: "c0" });
});

// ── caret guards ─────────────────────────────────────────────────────────

check("caretOnFirstLine: true for a collapsed caret before any newline", () => {
  assert.equal(H.caretOnFirstLine("hello\nworld", 3, 3), true);
});
check("caretOnFirstLine: false once past a newline", () => {
  assert.equal(H.caretOnFirstLine("hello\nworld", 8, 8), false);
});
check("caretOnFirstLine: false for a non-collapsed selection", () => {
  assert.equal(H.caretOnFirstLine("hello", 0, 3), false);
});
check("caretOnLastLine: false for a non-collapsed selection ending on the last line", () => {
  assert.equal(H.caretOnLastLine("hello", 2, 4), false);
});
check("caretOnLastLine: true for a collapsed caret after the last newline", () => {
  assert.equal(H.caretOnLastLine("hello\nworld", 8, 8), true);
});
check("caretOnLastLine: false before the last newline", () => {
  assert.equal(H.caretOnLastLine("hello\nworld", 3, 3), false);
});
check("single-line text: caret is on both the first and last line", () => {
  assert.equal(H.caretOnFirstLine("hello", 2, 2), true);
  assert.equal(H.caretOnLastLine("hello", 2, 2), true);
});
check("caretOnFirstLine: true at position 0 even when the text starts with a newline", () => {
  assert.equal(H.caretOnFirstLine("\nabc", 0, 0), true);
});
check("caretOnFirstLine/caretOnLastLine: caret immediately before the newline is first-line only", () => {
  assert.equal(H.caretOnFirstLine("hello\nworld", 5, 5), true);
  assert.equal(H.caretOnLastLine("hello\nworld", 5, 5), false);
});
check("caretOnFirstLine/caretOnLastLine: caret immediately after the newline is last-line only", () => {
  assert.equal(H.caretOnFirstLine("hello\nworld", 6, 6), false);
  assert.equal(H.caretOnLastLine("hello\nworld", 6, 6), true);
});

// ── live.js / constants.js parity (the actual bug this branch had) ───────

check("record() and promptsFromMessages() agree on the real plan-mode wrapper", () => {
  const framed = INTENT_FRAMING("fix bug").trimEnd(); // exactly what app-live.jsx's handleSend sends
  const opts = { framingPrefix: INTENT_FRAMING(""), skip: [APPROVAL_PROMPT] };
  const recorded  = H.record([], framed, 100, opts);
  const backfilled = H.promptsFromMessages([{ kind: "user", text: framed }], opts);
  assert.deepEqual(recorded, ["fix bug"]);
  assert.deepEqual(backfilled, ["fix bug"]);
  assert.deepEqual(recorded, backfilled); // the exact parity the bug broke
});
check("record() and promptsFromMessages() agree on the canned approval prompt (both drop it)", () => {
  const opts = { framingPrefix: INTENT_FRAMING(""), skip: [APPROVAL_PROMPT] };
  const list = ["a"];
  assert.equal(H.record(list, APPROVAL_PROMPT, 100, opts), list); // unchanged, same reference
  assert.deepEqual(H.promptsFromMessages([{ kind: "user", text: APPROVAL_PROMPT }], opts), []);
});
check("an image-only plan send (wrapper with no intent text) is dropped by both paths", () => {
  const framed = INTENT_FRAMING("").trimEnd(); // no intent — app-live.jsx still sends this shape
  const opts = { framingPrefix: INTENT_FRAMING("") };
  assert.deepEqual(H.record([], framed, 100, opts), []);
  assert.deepEqual(H.promptsFromMessages([{ kind: "user", text: framed }], opts), []);
});

// ── trimAll (live.js's setPromptHistoryLimit, extracted so it's testable
// without a Tauri harness — see src/live.js) ──────────────────────────────

check("trimAll: shrinks an over-limit list to the newest N entries, returns true", () => {
  const p = Array.from({ length: 18 }, (_, i) => `p${17 - i}`); // p17 (newest) .. p0 (oldest)
  const histories = new Map([["tabA", p]]);
  const changed = H.trimAll(histories, 10);
  assert.equal(changed, true);
  assert.deepEqual(histories.get("tabA"), p.slice(0, 10)); // p17..p8 — the newest 10
});
check("trimAll: an untouched tab's list is left at the same reference", () => {
  const short = ["a", "b"];
  const long  = Array.from({ length: 12 }, (_, i) => `q${i}`);
  const histories = new Map([["short", short], ["long", long]]);
  H.trimAll(histories, 10);
  assert.equal(histories.get("short"), short); // never touched — same reference
  assert.notEqual(histories.get("long"), long); // trimmed — new array
});
check("trimAll: no-op (returns false) when every list is already within the limit", () => {
  const histories = new Map([["a", ["x", "y"]], ["b", ["z"]]]);
  assert.equal(H.trimAll(histories, 10), false);
});
check("trimAll: empty Map returns false", () => {
  assert.equal(H.trimAll(new Map(), 10), false);
});

console.log(`\n${passed} checks passed.`);
