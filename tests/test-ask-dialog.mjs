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

// ── collapsedSummary: the desktop's one-line settled bubble ─────────────

check("collapsedSummary: an open prompt stays expanded", () => {
  assert.equal(A.collapsedSummary({ title: "Continue?", answered: false, cancelled: false }), null);
});

check("collapsedSummary: a select uses its picked label and the title's first line", () => {
  assert.deepEqual(A.collapsedSummary({
    method: "select", title: "Allow tool: bash\nCommand: npm test", options: ["Approve", "Deny"],
    answered: true, cancelled: false, answer: "Approve",
  }), { answer: "Approve", answerCount: null, status: null, prompt: "Allow tool: bash", negative: false });
});

check("collapsedSummary: a denied confirm is neutral, not a success", () => {
  assert.deepEqual(A.collapsedSummary({
    method: "confirm", title: "Deploy?", answered: true, cancelled: false, answer: "Deny",
  }), { answer: "Deny", answerCount: null, status: null, prompt: "Deploy?", negative: true });
});

check("collapsedSummary: an input answer uses the typed text", () => {
  assert.deepEqual(A.collapsedSummary({
    method: "input", title: "Name?", answered: true, cancelled: false, answer: "omp",
  }), { answer: "omp", answerCount: null, status: null, prompt: "Name?", negative: false });
});

check("collapsedSummary: an editor answer uses the typed text", () => {
  assert.deepEqual(A.collapsedSummary({
    method: "editor", title: "Notes?", answered: true, cancelled: false, answer: "First line\nSecond line",
  }), { answer: "First line\nSecond line", answerCount: null, status: null, prompt: "Notes?", negative: false });
});

check("collapsedSummary: a blank editor answer reads as nothing picked", () => {
  assert.deepEqual(A.collapsedSummary({
    method: "editor", title: "Notes?", answered: true, cancelled: false, answer: " \n\t ",
  }), { answer: null, answerCount: null, status: "nothing picked", prompt: "Notes?", negative: true });
});

check("collapsedSummary: a denied approval is negative", () => {
  assert.deepEqual(A.collapsedSummary({
    method: "select", title: "Allow tool: bash", options: ["Approve", "Deny"],
    answered: true, cancelled: false, answer: "Deny",
  }), { answer: "Deny", answerCount: null, status: null, prompt: "Allow tool: bash", negative: true });
});

check("collapsedSummary: a checkbox select uses its picked label", () => {
  assert.deepEqual(A.collapsedSummary({
    method: "select", title: "Choose features", selectionMarker: "checkbox",
    answered: true, cancelled: false, answer: "Done selecting",
  }), { answer: "Done selecting", answerCount: null, status: null, prompt: "Choose features", negative: false });
});

check("collapsedSummary: a one-question dialog with nothing picked shows its status", () => {
  assert.deepEqual(A.collapsedSummary({
    method: "ask", title: "Extras?", answered: true, cancelled: false,
    answers: [{ id: "extras", selectedOptions: [] }],
  }), { answer: null, answerCount: null, status: "nothing picked", prompt: "Extras?", negative: true });
});

check("collapsedSummary: missing dialog answers show the nothing-picked status", () => {
  assert.deepEqual(A.collapsedSummary({
    method: "ask", title: "Extras?", answered: true, cancelled: false, answers: null,
  }), { answer: null, answerCount: null, status: "nothing picked", prompt: "Extras?", negative: true });
});

check("collapsedSummary: blank option labels fall back to the nothing-picked status", () => {
  assert.deepEqual(A.collapsedSummary({
    method: "ask", title: "Extras?", answered: true, cancelled: false,
    answers: [{ id: "extras", selectedOptions: ["", "   "] }],
  }), { answer: null, answerCount: null, status: "nothing picked", prompt: "Extras?", negative: true });
  assert.equal(A.collapsedSummary({
    method: "ask", title: "Extras?", answered: true, cancelled: false,
    answers: [{ id: "extras", selectedOptions: ["", " Lint "], customInput: " more " }],
  }).answer, "Lint, more");
});

check("collapsedSummary: a one-question dialog shows its answer", () => {
  const summary = A.collapsedSummary({
    method: "ask", title: "", questions: [{ question: "Which version?\nChoose carefully" }],
    answered: true, cancelled: false,
    answers: [{ id: "version", selectedOptions: ["18.4.9 now"] }],
  });
  assert.deepEqual(summary, { answer: "18.4.9 now", answerCount: null, status: null, prompt: "Which version?", negative: false });
});

check("collapsedSummary: a multi-question dialog reports its answer count", () => {
  const summary = A.collapsedSummary({
    method: "ask", title: "", questions: [{ question: "One?" }, { question: "Two?" }],
    answered: true, cancelled: false,
    answers: [
      { id: "one", selectedOptions: ["Yes"] },
      { id: "two", selectedOptions: [], customInput: "Later" },
    ],
  });
  assert.deepEqual(summary, { answer: null, answerCount: 2, status: null, prompt: "One?", negative: false });
});

check("collapsedSummary: a multi-question dialog ignores empty pick-any answers", () => {
  assert.deepEqual(A.collapsedSummary({
    method: "ask", title: "", questions: [{ question: "One?" }, { question: "Two?" }],
    answered: true, cancelled: false,
    answers: [
      { id: "one", selectedOptions: [] },
      { id: "two", selectedOptions: ["", "   "] },
    ],
  }), { answer: null, answerCount: null, status: "nothing picked", prompt: "One?", negative: true });
  assert.deepEqual(A.collapsedSummary({
    method: "ask", title: "", questions: [{ question: "One?" }, { question: "Two?" }],
    answered: true, cancelled: false,
    answers: [
      { id: "one", selectedOptions: ["Lint"] },
      { id: "two", selectedOptions: [] },
    ],
  }), { answer: "Lint", answerCount: null, status: null, prompt: "One?", negative: false });
  assert.deepEqual(A.collapsedSummary({
    method: "ask", title: "", questions: [{ question: "One?" }, { question: "Two?" }, { question: "Three?" }],
    answered: true, cancelled: false,
    answers: [
      { id: "one", selectedOptions: ["Yes"] },
      { id: "two", selectedOptions: [] },
      { id: "three", selectedOptions: [], customInput: "Later" },
    ],
  }), { answer: null, answerCount: 2, status: null, prompt: "One?", negative: false });
});

check("collapsedSummary: leading blank lines are skipped and confirm falls back to message", () => {
  assert.equal(A.collapsedSummary({
    method: "select", title: "\n  Allow tool: bash\nCommand: ls", answered: true, answer: "Approve",
  }).prompt, "Allow tool: bash");
  assert.deepEqual(A.collapsedSummary({
    method: "confirm", title: "", message: "\nDelete temp files?\nCannot be undone",
    answered: true, cancelled: false, answer: "Confirm",
  }), { answer: "Confirm", answerCount: null, status: null, prompt: "Delete temp files?", negative: false });
});

check("collapsedSummary: free-text 'deny' is not styled as a negative choice", () => {
  assert.equal(A.collapsedSummary({
    method: "input", title: "Word?", answered: true, cancelled: false, answer: "deny",
  }).negative, false);
  assert.equal(A.collapsedSummary({
    method: "editor", title: "Notes?", answered: true, cancelled: false, answer: "Deny",
  }).negative, false);
});

check("collapsedSummary: cancellation and omp-side timeout keep their status wording", () => {
  assert.deepEqual(A.collapsedSummary({ title: "Continue?", answered: false, cancelled: true }),
    { answer: null, answerCount: null, status: "cancelled", prompt: "Continue?", negative: true });
  assert.deepEqual(A.collapsedSummary({ title: "Continue?", answered: false, cancelled: true, closedByOmp: true }),
    { answer: null, answerCount: null, status: "closed by omp", prompt: "Continue?", negative: true });
});

// ── selectRows: the rows of a `select` request ──────────────────────────
const row = (label, mark, role, checked, picked = false) => ({ label, mark, role, checked, picked });
const radios = (...labels) => labels.map(l => row(l, "radio", "radio", false));

check("selectRows: a select with no marker is a radiogroup, nothing checked while unanswered", () => {
  assert.deepEqual(A.selectRows({ options: ["Approve", "Deny"], answered: false, answer: null }),
    { group: "radiogroup", rows: radios("Approve", "Deny") });
  assert.deepEqual(A.selectRows({ options: [] }), { group: "radiogroup", rows: [] });
});

check("selectRows: the answered row of a radio select is picked and checked", () => {
  const { group, rows } = A.selectRows({ options: ["Approve", "Deny"], answered: true, answer: "Deny" });
  assert.equal(group, "radiogroup");
  assert.deepEqual(rows, [row("Approve", "radio", "radio", false), row("Deny", "radio", "radio", true, true)]);
});

check("selectRows: a reopened bubble (live.js _reopenAsk drops answered and answer) picks nothing", () => {
  const answered = { options: ["Approve", "Deny"], answered: true, answer: "Approve" };
  const { answered: _a, answer: _v, ...reopened } = answered;
  assert.deepEqual(A.selectRows(reopened).rows, radios("Approve", "Deny"));
  assert.deepEqual(A.selectRows({ ...answered, answered: false }).rows, radios("Approve", "Deny"));
});

check("selectRows: a radio marker covers the first markableCount rows, later ones are action rows", () => {
  const { group, rows } = A.selectRows({
    options: ["a", "b", "c"], selectionMarker: "radio", checkedIndices: [0, 1], markableCount: 2,
    answered: true, answer: "b",
  });
  assert.equal(group, "radiogroup");
  assert.deepEqual(rows, [row("a", "radio", "radio", false), row("b", "radio", "radio", true, true), row("c", null, null, false)]);
  assert.deepEqual(A.selectRows({ options: ["a", "b"], selectionMarker: "radio" }).rows, radios("a", "b"));
});

check("selectRows: with no marker markableCount and checkedIndices are ignored", () => {
  const { group, rows } = A.selectRows({ options: ["a", "b", "c"], checkedIndices: [0, 1], markableCount: 1 });
  assert.equal(group, "radiogroup");
  assert.deepEqual(rows, radios("a", "b", "c"));
});

check("selectRows: a checkbox select checks exactly the rows in checkedIndices", () => {
  const { group, rows } = A.selectRows({
    options: ["x", "y", "z"], selectionMarker: "checkbox", checkedIndices: [0, 2],
  });
  assert.equal(group, "group");
  assert.deepEqual(rows, [
    row("x", "box", "checkbox", true), row("y", "box", "checkbox", false), row("z", "box", "checkbox", true),
  ]);
});

check("selectRows: rows past markableCount are action rows with no mark, role or checked state", () => {
  const { group, rows } = A.selectRows({
    options: ["x", "y", "✔ Done selecting"], selectionMarker: "checkbox", checkedIndices: [1, 2], markableCount: 2,
  });
  assert.equal(group, "group");
  assert.deepEqual(rows, [
    row("x", "box", "checkbox", false), row("y", "box", "checkbox", true), row("✔ Done selecting", null, null, false),
  ]);
});

check("selectRows: the answered row of a checkbox select is picked, its checked state still omp's", () => {
  const { rows } = A.selectRows({
    options: ["x", "✔ Done selecting"], selectionMarker: "checkbox", checkedIndices: [], markableCount: 1,
    answered: true, answer: "✔ Done selecting",
  });
  assert.deepEqual(rows, [row("x", "box", "checkbox", false), row("✔ Done selecting", null, null, false, true)]);
});

check("selectRows: a box row the bubble was answered with stays unchecked unless omp checked it", () => {
  const { rows } = A.selectRows({
    options: ["x", "✔ Done selecting"], selectionMarker: "checkbox", checkedIndices: [], markableCount: 1,
    answered: true, answer: "x",
  });
  assert.deepEqual(rows, [row("x", "box", "checkbox", false, true), row("✔ Done selecting", null, null, false)]);
});

check("selectRows: an unknown marker reads as absent", () => {
  for (const selectionMarker of ["toggle", "", null, 3, undefined, "Checkbox"]) {
    const r = A.selectRows({ options: ["a", "b"], selectionMarker, checkedIndices: [0], markableCount: 1 });
    assert.equal(r.group, "radiogroup");
    assert.deepEqual(r.rows, radios("a", "b"));
  }
});

check("selectRows: a markableCount that is not a non-negative integer means every row; a big one is clamped", () => {
  const opts = ["a", "b", "c"];
  const marks = (markableCount) => A.selectRows({ options: opts, selectionMarker: "checkbox", markableCount })
    .rows.map(r => r.mark);
  const all = ["box", "box", "box"];
  for (const bad of [-1, 1.5, NaN, Infinity, "2", null, undefined, {}]) assert.deepEqual(marks(bad), all, String(bad));
  assert.deepEqual(marks(99), all);
  assert.deepEqual(marks(2), ["box", "box", null]);
  assert.deepEqual(marks(0), [null, null, null]);
});

check("selectRows: checkedIndices that is not an array, or has stray entries, checks only valid markable rows", () => {
  const base = { options: ["a", "b", "c"], selectionMarker: "checkbox", markableCount: 2 };
  const checked = (checkedIndices) => A.selectRows({ ...base, checkedIndices }).rows.map(r => r.checked);
  for (const bad of ["0", { 0: true }, 0, null, undefined]) assert.deepEqual(checked(bad), [false, false, false], String(bad));
  assert.deepEqual(checked([2, 5, -1, 0.5, "1", null, 1]), [false, true, false]);
  assert.deepEqual(checked([0, 0]), [true, false, false]);
});

check("selectRows: an object option reads its label", () => {
  const { rows } = A.selectRows({ options: [{ label: "L" }, { value: 1 }, "s"], answered: true, answer: "L" });
  assert.deepEqual(rows.map(r => [r.label, r.picked]), [["L", true], ["", false], ["s", false]]);
});

console.log(`ask-dialog: ${passed} checks passed`);
