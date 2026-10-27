#!/usr/bin/env node
// Regression script for src/app/session-ui.js — the per-tab composer draft
// and plan-mode state of issue #28: one tab's plan mode, plan comments,
// draft or prompt-history recall must never show up in another tab, and
// closed tabs leave nothing behind. Also the draft's collapsed long pastes
// (#31): what a send puts on the wire, and what a chip's "expand" inlines.
// Run: node tests/test-session-ui.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win  = {};
// session-ui.js is dependency-free; prompt-history.js supplies the real
// `step` its recall helper is handed in composer.jsx.
for (const file of ["src/app/session-ui.js", "src/app/prompt-history.js"]) {
  // eslint-disable-next-line no-new-func
  new Function("window", readFileSync(join(root, file), "utf8"))(win);
}
// constants.js: isSubmitKey, the composer's send chord.
const constants = {};
// eslint-disable-next-line no-new-func
new Function("window", readFileSync(join(root, "src/app/constants.js"), "utf8"))(constants);
const S = win.OMP_SESSION_UI;
const { step } = win.OMP_PROMPT_HISTORY;
const { PLAN_IDLE, DRAFT_IDLE } = S;

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

const plan  = (map, id) => S.entryOf(map, id, PLAN_IDLE);
const onPlan = (map, id, fn) => S.updateEntry(map, id, PLAN_IDLE, fn);

// ── Isolation between tabs (the reported bug) ────────────────────────────

check("plan mode switched on in one tab leaves every other tab out of plan mode", () => {
  const plans = onPlan({}, "A", S.togglePlan);
  assert.equal(plan(plans, "A").mode, true);
  assert.equal(plan(plans, "B").mode, false);
});

check("a plan framed in one tab still frames the first plan send of another", () => {
  let plans = onPlan({}, "A", S.enterPlan);
  plans = onPlan(plans, "A", S.markPlanSent);
  plans = onPlan(plans, "B", S.enterPlan);
  assert.equal(plan(plans, "A").started, true);
  assert.equal(plan(plans, "B").started, false);
});

check("plan comments stay on the tab whose transcript they annotate", () => {
  const plans = onPlan({}, "A", p => S.annotatePlan(p, 3, { raw: "step", comment: "no" }));
  assert.deepEqual(Object.keys(plan(plans, "A").annotations), ["3"]);
  assert.deepEqual(plan(plans, "B").annotations, {});
});

check("a draft written for one tab is not the draft of another", () => {
  const drafts = S.updateEntry({}, "A", DRAFT_IDLE, d => ({ ...d, text: "for A" }));
  assert.equal(S.entryOf(drafts, "A", DRAFT_IDLE).text, "for A");
  assert.equal(S.entryOf(drafts, "B", DRAFT_IDLE).text, "");
});

check("dictation appends to its origin without changing typed text or other drafts", () => {
  let drafts = S.updateEntry({}, "A", DRAFT_IDLE, d => ({ ...d, text: "  typed", historyNav: 1 }));
  drafts = S.updateEntry(drafts, "B", DRAFT_IDLE, d => ({ ...d, text: "other" }));
  const other = drafts.B;
  drafts = S.appendDictation(drafts, ["A", "B"], { sessionId: "A", text: "dictated\n" });
  assert.equal(drafts.A.text, "  typed dictated\n");
  assert.equal(drafts.A.historyNav, null);
  assert.equal(drafts.B, other);
  drafts = S.appendDictation(drafts, ["A", "B"], { sessionId: "A", text: "more" });
  assert.equal(drafts.A.text, "  typed dictated\nmore");
});

check("dictation cannot recreate a closed tab and preserves whitespace-only drafts", () => {
  const drafts = S.updateEntry({}, "B", DRAFT_IDLE, d => ({ ...d, text: " \n" }));
  assert.equal(S.appendDictation(drafts, ["B"], { sessionId: "A", text: "late" }), drafts);
  assert.equal(S.appendDictation(drafts, ["B"], { sessionId: "B", text: "" }), drafts);
  const next = S.appendDictation(drafts, ["B"], { sessionId: "B", text: "spoken" });
  assert.equal(next.B.text, " \nspoken");
});

check("an update never touches another tab's entry", () => {
  const before = onPlan({}, "B", S.enterPlan);
  const after  = onPlan(before, "A", S.togglePlan);
  assert.equal(after.B, before.B);
});

check("with no tab open (empty id) an update is a no-op", () => {
  const plans = {};
  assert.equal(onPlan(plans, "", S.togglePlan), plans);
  assert.equal(plan(plans, ""), PLAN_IDLE);
});

check("an entry named like an Object.prototype key is not inherited", () => {
  assert.equal(plan({}, "toString"), PLAN_IDLE);
});

check("an update returning the idle state drops the entry", () => {
  const plans = S.updateEntry(onPlan({}, "A", S.enterPlan), "A", PLAN_IDLE, S.approvePlan);
  assert.equal(Object.hasOwn(plans, "A"), false);
});

check("an update returning the same entry keeps the same map (no re-render)", () => {
  const plans = onPlan({}, "A", S.enterPlan);
  assert.equal(onPlan(plans, "A", p => p), plans);
});

// ── Closed tabs ──────────────────────────────────────────────────────────

check("closing a tab drops its entry and keeps the others", () => {
  let plans = onPlan({}, "A", S.enterPlan);
  plans = onPlan(plans, "B", S.enterPlan);
  const pruned = S.pruneEntries(plans, ["B"]);
  assert.deepEqual(Object.keys(pruned), ["B"]);
  assert.equal(pruned.B, plans.B);
});

check("pruning with every tab still open keeps the same map", () => {
  const plans = onPlan({}, "A", S.enterPlan);
  assert.equal(S.pruneEntries(plans, ["A", "B"]), plans);
});

check("the last tab closing leaves nothing behind", () => {
  assert.deepEqual(S.pruneEntries(onPlan({}, "A", S.enterPlan), []), {});
});

check("seedEntries: a new tab starts on the defaultSide; open tabs keep theirs", () => {
  const sides = { A: "tree" };
  const seeded = S.seedEntries(sides, ["A", "B"], "rail", "browser");
  assert.deepEqual(seeded, { A: "tree", B: "browser" });
  assert.equal(sides.B, undefined, "input untouched");
  assert.equal(S.entryOf(seeded, "B", "rail"), "browser");
});

check("seedEntries: the idle value (rail) or no fresh tab stores nothing", () => {
  const sides = { A: "tree" };
  assert.equal(S.seedEntries(sides, ["B"], "rail", "rail"), sides);
  assert.equal(S.seedEntries(sides, [], "rail", "tree"), sides);
  assert.equal(S.seedEntries(sides, ["A"], "rail", "browser"), sides);
  assert.equal(S.seedEntries(sides, ["B"], "rail", undefined), sides);
  assert.equal(S.seedEntries(sides, [""], "rail", "tree"), sides, "no tab id");
});

// ── Prompt-history recall in a tab's draft ───────────────────────────────

const typed = text => ({ ...DRAFT_IDLE, text });
const recall = (d, hist, dir) => S.recallInDraft(d, hist, dir, step);

check("Up on a typed draft never replaces it (#55)", () => {
  assert.equal(recall(typed("half-typed"), ["sent"], -1), null);
  assert.equal(recall(typed("line 1\nline 2"), ["sent"], -1), null);
});

check("Up on an empty composer starts a recall; each tab keeps its own position", () => {
  const histA = ["sent in A", "older in A"];
  const histB = ["sent in B"];
  const upA = recall(typed(""), histA, -1);
  const upB = recall(typed(""), histB, -1);
  assert.equal(upA.text, "sent in A");
  assert.equal(upB.text, "sent in B");
  assert.equal(recall(upA, histA, -1).text, "older in A");
  assert.equal(recall(upB, histB, -1), null);
});

check("walking down past the newest entry empties the composer and ends the recall", () => {
  const hist = ["newest", "older"];
  const up2  = recall(recall(typed(""), hist, -1), hist, -1);
  assert.equal(up2.text, "older");
  const down1 = recall(up2, hist, +1);
  assert.equal(down1.text, "newest");
  const down2 = recall(down1, hist, +1);
  assert.equal(down2.text, "");
  assert.equal(down2.historyNav, null);
  assert.equal(recall(down2, hist, +1), null);
  assert.equal(recall(down2, hist, -1).text, "newest", "a recall can start again");
});

check("an edited recall is a draft: Up moves the caret instead of recalling", () => {
  // Text changed under a kept recall position (every edit path resets it today).
  const hist   = ["one", "two"];
  const edited = { ...recall(typed(""), hist, -1), text: "one [paste #1 +9 lines]" };
  assert.equal(recall(edited, hist, -1), null);
  assert.equal(recall(edited, hist, +1), null);
});

check("a recall position past a shrunken history is dropped, not read past the end", () => {
  let d = typed("");
  for (let i = 0; i < 3; i++) d = recall(d, ["a", "b", "c"], -1);
  assert.equal(d.text, "c");
  assert.equal(recall(d, ["a"], -1), null);
  assert.equal(recall(d, ["a"], +1), null);
});

check("nothing to recall leaves the composer alone", () => {
  assert.equal(recall(typed(""), [], -1), null);
  assert.equal(recall(typed(""), ["h"], +1), null);
});

// ── Collapsed pastes (#31) ───────────────────────────────────────────────

const lines = n => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
// Merges an edit's patch the way composer.jsx does.
const collapse = (d, raw, start, end) => {
  const { patch, caret } = S.collapsePaste(d, raw, start, end);
  return { draft: { ...d, ...patch }, caret };
};

check("a long paste collapses at the selection and a send restores it byte for byte", () => {
  const raw = `${lines(20)}\n`;
  const { draft, caret } = collapse(typed("see SELECTED here"), raw, 4, 12);
  assert.equal(draft.text, "see [paste #1 +20 lines] here");
  assert.equal(caret, "see [paste #1 +20 lines]".length);
  assert.equal(S.expandPastes(draft.text, draft.pastes), `see ${raw} here`);
});

check("collapse thresholds: more than 5 lines or more than 500 characters", () => {
  assert.equal(S.shouldCollapsePaste(lines(5)), false);
  assert.equal(S.shouldCollapsePaste(`${lines(5)}\n`), false, "a final newline is not a sixth line");
  assert.equal(S.shouldCollapsePaste(lines(6)), true);
  assert.equal(S.shouldCollapsePaste("x".repeat(500)), false);
  assert.equal(S.shouldCollapsePaste("x".repeat(501)), true);
  assert.equal(collapse(DRAFT_IDLE, "x".repeat(600), 0, 0).draft.text, "[paste #1 +1 line]");
});

check("collapse threshold follows the pasteCollapseLines tweak, clamped to 2..50", () => {
  assert.equal(S.shouldCollapsePaste(lines(10), 10), false);
  assert.equal(S.shouldCollapsePaste(lines(11), 10), true);
  assert.equal(S.shouldCollapsePaste(lines(2), 1), false, "below 2 clamps to 2");
  assert.equal(S.shouldCollapsePaste(lines(3), 1), true);
  assert.equal(S.shouldCollapsePaste(lines(50), 999), false, "above 50 clamps to 50");
  assert.equal(S.shouldCollapsePaste(lines(51), 999), true);
  assert.equal(S.shouldCollapsePaste(lines(6), undefined), true, "missing pref = 5");
  assert.equal(S.shouldCollapsePaste(lines(6), null), true, "null pref = 5");
  assert.equal(S.shouldCollapsePaste(lines(5), "x"), false, "non-number pref = 5");
  assert.equal(S.shouldCollapsePaste("x".repeat(501), 50), true, "the 500-char cap stays");
  assert.equal(collapse(DRAFT_IDLE, lines(8), 0, 0).draft.text, "[paste #1 +8 lines]", "token shape unchanged");
});

// ── Send chord of multi-line fields (constants.js isSubmitKey) ────────────

check("isSubmitKey: \"enter\" sends on Enter without Shift, \"ctrl+enter\" on Ctrl/Cmd+Enter", () => {
  const key = (mods = {}) => ({ key: "Enter", keyCode: 13, nativeEvent: { isComposing: false }, ...mods });
  const { isSubmitKey } = constants;
  assert.equal(isSubmitKey(key()), true, "default is enter");
  assert.equal(isSubmitKey(key(), "enter"), true);
  assert.equal(isSubmitKey(key({ shiftKey: true }), "enter"), false, "Shift+Enter is a newline");
  assert.equal(isSubmitKey(key({ ctrlKey: true }), "enter"), true, "unchanged pre-#37 behaviour");
  assert.equal(isSubmitKey(key(), "ctrl+enter"), false, "plain Enter is a newline");
  assert.equal(isSubmitKey(key({ ctrlKey: true }), "ctrl+enter"), true);
  assert.equal(isSubmitKey(key({ metaKey: true }), "ctrl+enter"), true);
  assert.equal(isSubmitKey(key({ ctrlKey: true, shiftKey: true }), "ctrl+enter"), false);
  assert.equal(isSubmitKey(key({ ctrlKey: true, altKey: true }), "ctrl+enter"), false);
  assert.equal(isSubmitKey(key(), "bogus"), true, "unknown pref behaves as enter");
  assert.equal(isSubmitKey({ key: "a" }, "enter"), false);
  assert.equal(isSubmitKey(key({ nativeEvent: { isComposing: true } }), "enter"), false, "IME guard");
  assert.equal(isSubmitKey(key({ ctrlKey: true, keyCode: 229 }), "ctrl+enter"), false, "IME guard (229)");
});

check("Windows and old-Mac line endings become the textarea's LF", () => {
  assert.equal(S.normalizePaste("a\r\nb\rc\n"), "a\nb\nc\n");
  // Six CRLF lines are six lines, and collapse like it.
  assert.equal(S.shouldCollapsePaste(S.normalizePaste(lines(6).replaceAll("\n", "\r\n"))), true);
});

check("each new paste gets its own id, and the strip lists each still-referenced one once", () => {
  let d = collapse(typed("a  b"), lines(6), 1, 1).draft;
  d = collapse(d, lines(7), d.text.length, d.text.length).draft;
  d = { ...d, text: `${d.text} [paste #1 +6 lines] [paste #9 +3 lines]` };
  assert.deepEqual(S.pastesIn(d.text, d.pastes), [
    { id: "1", text: lines(6), lines: 6 },
    { id: "2", text: lines(7), lines: 7 },
  ]);
  const withoutFirst = d.text.replaceAll("[paste #1 +6 lines]", "");
  assert.deepEqual(S.pastesIn(withoutFirst, d.pastes).map(p => p.id), ["2"], "a deleted token drops its chip");
});

check("expanding one paste inlines every copy of it and leaves the others collapsed", () => {
  let d = collapse(typed("x  y"), lines(6), 1, 1).draft;           // x[paste #1]  y
  d = collapse(d, lines(8), d.text.length, d.text.length).draft;   // …y[paste #2]
  d = { ...d, text: `${d.text} [paste #2 +8 lines]`, historyNav: 0 };
  const r = S.inlinePaste(d, "2");
  const head = "x[paste #1 +6 lines]  y";
  assert.equal(r.patch.text, `${head}${lines(8)} ${lines(8)}`);
  assert.equal(r.caret, head.length + lines(8).length, "caret ends the first inlined copy");
  assert.deepEqual(Object.keys(r.patch.pastes), ["1"]);
  assert.equal(r.patch.historyNav, null, "an edit ends a prompt-history recall");
  assert.equal(S.expandPastes(r.patch.text, r.patch.pastes), `x${lines(6)}  y${lines(8)} ${lines(8)}`);
});

check("a paste edit keeps a concurrent image preparation, and ends a history recall", () => {
  const att = [{ id: 1 }];
  const busy = { ...typed("ab"), attachments: att, pendingImages: 2, historyNav: 0 };
  const collapsed = { ...busy, ...S.collapsePaste(busy, lines(6), 1, 1).patch };
  assert.equal(collapsed.pendingImages, 2);
  assert.equal(collapsed.attachments, att);
  assert.equal(collapsed.historyNav, null);
  const inlined = { ...collapsed, ...S.inlinePaste(collapsed, "1").patch };
  assert.equal(inlined.pendingImages, 2);
  assert.equal(inlined.attachments, att);
});

check("an empty line before the final newline still counts", () => {
  assert.equal(collapse(DRAFT_IDLE, `${"x".repeat(600)}\n\n`, 0, 0).draft.text, "[paste #1 +2 lines]");
});

check("expanding a paste the text no longer refers to does nothing", () => {
  const d = collapse(typed(""), lines(6), 0, 0).draft;
  assert.equal(S.inlinePaste({ ...d, text: "gone" }, "1"), null);
  assert.equal(S.inlinePaste(d, "7"), null);
});

check("pasted text is inserted literally, never re-scanned or read as a replacement pattern", () => {
  const tricky = "keep [paste #1 +6 lines] and $& and $1\n".repeat(6);
  const d = collapse(typed(""), tricky, 0, 0).draft;
  assert.equal(S.expandPastes(d.text, d.pastes), tricky);
  assert.equal(S.inlinePaste(d, "1").patch.text, tricky);
});

// ── Plan transitions (same semantics as before the per-tab split) ────────

check("leaving plan mode forgets the framing, so re-entering frames again", () => {
  const sent = S.markPlanSent(S.enterPlan(PLAN_IDLE));
  const off  = S.togglePlan(sent);
  assert.equal(off.mode, false);
  assert.equal(off.started, false);
  assert.equal(S.togglePlan(off).started, false);
});

check("plan comments survive toggling plan mode off and on", () => {
  const annotated = S.annotatePlan(S.enterPlan(PLAN_IDLE), 1, { raw: "x", comment: "y" });
  assert.deepEqual(S.togglePlan(S.togglePlan(annotated)).annotations, annotated.annotations);
});

check("/plan always starts a fresh plan, even mid-plan", () => {
  const next = S.enterPlan(S.markPlanSent(S.enterPlan(PLAN_IDLE)));
  assert.equal(next.mode, true);
  assert.equal(next.started, false);
});

check("approving ends plan mode and spends the comments", () => {
  const approved = S.approvePlan(S.annotatePlan(S.enterPlan(PLAN_IDLE), 2, { raw: "a", comment: "b" }));
  assert.equal(approved, PLAN_IDLE);
});

check("a plan send marks the plan framed and spends its comments", () => {
  const sent = S.markPlanSent(S.annotatePlan(S.enterPlan(PLAN_IDLE), 2, { raw: "a", comment: "b" }));
  assert.equal(sent.mode, true);
  assert.equal(sent.started, true);
  assert.deepEqual(sent.annotations, {});
});

check("a null comment removes the annotation without mutating the old plan", () => {
  const one  = S.annotatePlan(PLAN_IDLE, 4, { raw: "r", comment: "c" });
  const none = S.annotatePlan(one, 4, null);
  assert.deepEqual(none.annotations, {});
  assert.deepEqual(Object.keys(one.annotations), ["4"]);
  assert.deepEqual(PLAN_IDLE.annotations, {});
});

console.log(`test-session-ui: ${passed} passed`);
