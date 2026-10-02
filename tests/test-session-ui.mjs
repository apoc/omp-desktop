#!/usr/bin/env node
// Regression script for src/app/session-ui.js — the per-tab composer draft
// and plan-mode state of issue #28: one tab's plan mode, plan comments,
// draft or prompt-history recall must never show up in another tab, and
// closed tabs leave nothing behind.
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

// ── Prompt-history recall in a tab's draft ───────────────────────────────

const typed = text => ({ ...DRAFT_IDLE, text });

check("a recall interleaved across two tabs restores each tab's own unsent draft", () => {
  const histA = ["sent in A"];
  const histB = ["sent in B"];
  const upA   = S.recallInDraft(typed("foo"), histA, -1, step);
  const upB   = S.recallInDraft(typed("bar"), histB, -1, step);
  assert.equal(upA.text, "sent in A");
  assert.equal(upB.text, "sent in B");
  assert.equal(S.recallInDraft(upA, histA, +1, step).text, "foo");
  assert.equal(S.recallInDraft(upB, histB, +1, step).text, "bar");
});

check("walking down past the newest entry ends the recall", () => {
  const hist = ["newest", "older"];
  const up2  = S.recallInDraft(S.recallInDraft(typed("draft"), hist, -1, step), hist, -1, step);
  assert.equal(up2.text, "older");
  const down1 = S.recallInDraft(up2, hist, +1, step);
  assert.equal(down1.text, "newest");
  const down2 = S.recallInDraft(down1, hist, +1, step);
  assert.equal(down2.text, "draft");
  assert.equal(S.recallInDraft(down2, hist, +1, step), null);
});

check("a recall whose text was edited behind its back restarts from the current text", () => {
  // e.g. a paste-token collapse rewrote the recalled entry without setText.
  const hist   = ["one", "two"];
  const edited = { ...S.recallInDraft(typed("mine"), hist, -1, step), text: "one [paste #1 +9 lines]" };
  const up     = S.recallInDraft(edited, hist, -1, step);
  assert.equal(up.text, "one");
  assert.equal(S.recallInDraft(up, hist, +1, step).text, "one [paste #1 +9 lines]");
});

check("a recall position past a shrunken history restarts instead of reading past the end", () => {
  const long  = ["a", "b", "c"];
  let d = typed("mine");
  for (let i = 0; i < 3; i++) d = S.recallInDraft(d, long, -1, step);
  assert.equal(d.text, "c");
  const up = S.recallInDraft(d, ["a"], -1, step);
  assert.equal(up.text, "a");
  assert.equal(S.recallInDraft(up, ["a"], +1, step).text, "c");
});

check("nothing to recall leaves the draft alone", () => {
  assert.equal(S.recallInDraft(typed("x"), [], -1, step), null);
  assert.equal(S.recallInDraft(typed("x"), ["h"], +1, step), null);
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
