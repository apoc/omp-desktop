#!/usr/bin/env node
// Regression script for src/app/ask-dialog.js — omp's ask dialog: request
// parsing, pick / typed-text rules, when Submit may send, and the `answers`
// reply omp validates (rpc-mode.ts parseAskDialogResponse).
// Run: node tests/test-ask-dialog.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win  = {};
// eslint-disable-next-line no-new-func
new Function("window", readFileSync(join(root, "src/app/ask-dialog.js"), "utf8"))(win);
const A = win.OMP_ASK_DIALOG;

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

// The rules omp applies to the reply, ported from rpc-mode.ts
// `parseAskDialogResponse`: anything it would throw on fails the ask tool.
function ompAccepts(questions, answers) {
  if (!Array.isArray(answers) || answers.length !== questions.length) return "wrong answer count";
  for (const [i, q] of questions.entries()) {
    const a = answers[i];
    if (!a || a.id !== q.id) return `answer ${i} has the wrong id`;
    if (!Array.isArray(a.selectedOptions)) return `${q.id}: no selectedOptions array`;
    const labels = q.options.map(o => o.label);
    const seen = [];
    for (const label of a.selectedOptions) {
      if (typeof label !== "string" || !labels.includes(label)) return `${q.id}: unknown option ${label}`;
      if (seen.includes(label)) return `${q.id}: ${label} twice`;
      seen.push(label);
    }
    if (a.customInput !== undefined && typeof a.customInput !== "string") return `${q.id}: customInput not a string`;
    const custom = a.customInput?.trim() || undefined;
    if (!q.multi && (seen.length > 1 || (seen.length > 0 && custom !== undefined))) return `${q.id}: single-select with two answers`;
  }
  return null;
}

// A real ask call (omp-desktop session, 2026-10-03), trimmed to its shape:
// two pick-one questions and one pick-any.
const raw = [
  { id: "floor", header: "Floor", question: "Starting minimum omp version (`MIN_OMP_VERSION`)?",
    options: [{ label: "18.4.4, bump per increment", description: "Each bump is one line." }, { label: "18.4.9 now" }, { label: "18.5.1 now (latest)" }],
    recommended: 1 },
  { id: "unparseable", header: "Bad version", question: "`omp --version` output cannot be parsed. What should a tab start do?",
    options: [{ label: "Refuse" }, { label: "Allow + log" }], recommended: 0 },
  { id: "edit", header: "Extras", question: "Optional extras for increments 1–2?", multi: true,
    options: [{ label: "✎ Edit queued message" }, { label: "Confirm before stopping a subagent" }, { label: "Show steered message in subagent Output" }] },
];
const qs = A.parseQuestions(raw);

// ── parseQuestions ───────────────────────────────────────────────────────

check("a well-formed request keeps every question in order", () => {
  assert.deepEqual(qs.map(q => q.id), ["floor", "unparseable", "edit"]);
  assert.deepEqual(qs.map(q => q.multi), [false, false, true]);
  assert.equal(qs[0].options[0].description, "Each bump is one line.");
  assert.equal(qs[0].options[1].description, null);
});

check("a recommended index outside the options is dropped", () => {
  const [q] = A.parseQuestions([{ id: "a", question: "?", options: [{ label: "x" }], recommended: 1 }]);
  assert.equal(q.recommended, null);
  const [r] = A.parseQuestions([{ id: "a", question: "?", options: [{ label: "x" }], recommended: 0.5 }]);
  assert.equal(r.recommended, null);
});

check("a blank header or description reads as absent; a header is trimmed", () => {
  const [q] = A.parseQuestions([{ id: "a", question: "?", header: "  Chip ", options: [{ label: "x", description: "  ", preview: "" }] }]);
  assert.equal(q.header, "Chip");
  assert.equal(q.options[0].description, null);
  assert.equal(q.options[0].preview, null);
});

check("a request the dialog cannot answer is refused", () => {
  assert.equal(A.parseQuestions(undefined), null);
  assert.equal(A.parseQuestions([]), null);
  assert.equal(A.parseQuestions([{ id: "a", question: "?" }]), null);
  assert.equal(A.parseQuestions([{ id: 1, question: "?", options: [] }]), null);
  assert.equal(A.parseQuestions([{ id: "a", question: "?", options: [{ label: 2 }] }]), null);
});

// ── pick / type / missing ────────────────────────────────────────────────

check("a pick-one click replaces the earlier pick and the typed text", () => {
  let d = A.emptyDraft(qs);
  d = A.type(d, qs, 0, "18.6");
  d = A.pick(d, qs, 0, 2);
  d = A.pick(d, qs, 0, 1);
  assert.deepEqual(d[0], { picks: [1], text: "" });
});

check("typed text on a pick-one question replaces its pick; blank text does not", () => {
  let d = A.pick(A.emptyDraft(qs), qs, 1, 0);
  assert.deepEqual(A.type(d, qs, 1, "   ")[1].picks, [0]);
  d = A.type(d, qs, 1, "Ask me");
  assert.deepEqual(d[1], { picks: [], text: "Ask me" });
});

check("pick-any clicks toggle, keep option order, and keep the typed text", () => {
  let d = A.type(A.emptyDraft(qs), qs, 2, "Audit log");
  d = A.pick(d, qs, 2, 2);
  d = A.pick(d, qs, 2, 0);
  assert.deepEqual(d[2], { picks: [0, 2], text: "Audit log" });
  assert.deepEqual(A.pick(d, qs, 2, 2)[2].picks, [0]);
});

check("only unanswered pick-one questions hold Submit back", () => {
  let d = A.emptyDraft(qs);
  assert.equal(A.missing(qs, d), 2);
  d = A.pick(d, qs, 0, 1);
  d = A.type(d, qs, 1, "  ");
  assert.equal(A.missing(qs, d), 1);
  d = A.type(d, qs, 1, "Refuse, but log it");
  assert.equal(A.missing(qs, d), 0);
});

check("a pick-any question is never unanswered", () => {
  const d = A.emptyDraft(qs);
  assert.equal(A.unanswered(qs[0], d[0]), true);
  assert.equal(A.unanswered(qs[2], d[2]), false);
});

check("a question with no options needs typed text", () => {
  const free = A.parseQuestions([{ id: "why", question: "Why?", options: [] }]);
  assert.equal(A.missing(free, A.emptyDraft(free)), 1);
  assert.equal(A.missing(free, A.type(A.emptyDraft(free), free, 0, "because")), 0);
});

check("only a lone pick-one question with options answers on click", () => {
  const one = (q) => A.parseQuestions([{ id: "a", question: "?", options: [{ label: "x" }], ...q }]);
  assert.equal(A.answersOnClick(one({})), true);
  assert.equal(A.answersOnClick(one({ multi: true })), false);
  assert.equal(A.answersOnClick(A.parseQuestions([{ id: "a", question: "?", options: [] }])), false);
  assert.equal(A.answersOnClick(qs), false);
});

// ── answers ──────────────────────────────────────────────────────────────

check("answers carry exact labels and trimmed typed text in question order", () => {
  let d = A.emptyDraft(qs);
  d = A.pick(d, qs, 0, 1);
  d = A.type(d, qs, 1, "  Refuse, but log it  ");
  d = A.pick(d, qs, 2, 0);
  d = A.type(d, qs, 2, " Audit log ");
  assert.deepEqual(A.answers(qs, d), [
    { id: "floor", selectedOptions: ["18.4.9 now"] },
    { id: "unparseable", selectedOptions: [], customInput: "Refuse, but log it" },
    { id: "edit", selectedOptions: ["✎ Edit queued message"], customInput: "Audit log" },
  ]);
});

check("a pick-any question with nothing picked answers with an empty list", () => {
  const d = A.pick(A.pick(A.emptyDraft(qs), qs, 0, 0), qs, 1, 1);
  assert.deepEqual(A.answers(qs, d)[2], { id: "edit", selectedOptions: [] });
});

check("any sequence of clicks and typing yields answers omp accepts", () => {
  // Deterministic LCG so a failure reproduces.
  let seed = 7;
  // 32-bit LCG; its low bits cycle fast, so draw from the high ones.
  const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 16) % n; };
  const texts = ["", " ", "typed", "  padded  "];
  let sent = 0;
  for (let run = 0; run < 500; run++) {
    let d = A.emptyDraft(qs);
    for (let step = rnd(12); step >= 0; step--) {
      const qi = rnd(qs.length);
      d = rnd(3) === 0 ? A.type(d, qs, qi, texts[rnd(texts.length)]) : A.pick(d, qs, qi, rnd(qs[qi].options.length));
    }
    if (A.missing(qs, d) > 0) continue; // Submit is disabled
    const out = A.answers(qs, d);
    assert.equal(ompAccepts(qs, out), null, JSON.stringify({ d, out }));
    sent++;
  }
  assert.ok(sent >= 100, `only ${sent} sequences reached Submit`);
});

// ── timeoutLabel / timeoutNote / codeRuns ──────────────────────────────────────────────

check("omp's ask timeout reads in seconds, then minutes", () => {
  assert.equal(A.timeoutLabel(undefined), null);
  assert.equal(A.timeoutLabel(0), null);
  assert.equal(A.timeoutLabel(200), "1 s");
  assert.equal(A.timeoutLabel(45_000), "45 s");
  assert.equal(A.timeoutLabel(120_000), "2 min");
  assert.equal(A.timeoutLabel(90_000), "1 min 30 s");
});

check("the timeout note says whether omp picks the recommended options", () => {
  assert.equal(A.timeoutNote(qs, null), null);
  const recommended = qs.slice(0, 2);
  assert.equal(A.timeoutNote(recommended, 45_000), "omp picks the recommended options after 45 s");
  assert.equal(A.timeoutNote(recommended.slice(0, 1), 45_000), "omp picks the recommended option after 45 s");
  assert.equal(A.timeoutNote(qs, 45_000), "omp answers for you after 45 s");
});

check("backtick pairs become code runs; an unpaired backtick stays literal", () => {
  assert.deepEqual(A.codeRuns("Always pass `--mode rpc-ui` and `x`."), [
    { code: false, text: "Always pass " },
    { code: true, text: "--mode rpc-ui" },
    { code: false, text: " and " },
    { code: true, text: "x" },
    { code: false, text: "." },
  ]);
  assert.deepEqual(A.codeRuns("it`s fine"), [{ code: false, text: "it`s fine" }]);
  assert.deepEqual(A.codeRuns(""), []);
});

console.log(`ask-dialog: ${passed} checks passed`);
