#!/usr/bin/env node
// Regression script for src/app/message-queue.js — the queue strip's view
// of omp's steer / follow-up queue: snapshot ingestion, rows with
// unacknowledged sends merged in, ✎'s draft text, and the refusal note.
// Run: node tests/test-message-queue.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root  = join(dirname(fileURLToPath(import.meta.url)), "..");
const win   = {};
// marked-setup.js provides `OMP_MARKDOWN.fenceCode` (failureNote's fence)
// without marked/hljs; the rest of it returns early here.
for (const f of ["src/app/marked-setup.js", "src/app/message-queue.js"]) {
  // eslint-disable-next-line no-new-func
  new Function("window", readFileSync(join(root, f), "utf8"))(win);
}
const Q = win.OMP_QUEUE;

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

const queue = (steering = [], followUp = []) => Q.fromSnapshot({ steering, followUp });
const view = (q, sending = []) => Q.rows(q, sending).map(r => `${r.kind}:${r.text}${r.sending ? " (sending)" : ""}`);

// ── fromSnapshot ─────────────────────────────────────────────────────────

check("an unchanged snapshot keeps the previous queue object (no re-render per get_state)", () => {
  const prev = queue(["a"], ["b"]);
  assert.equal(Q.fromSnapshot({ type: "queue_update", steering: ["a"], followUp: ["b"] }, prev), prev);
});

check("a changed snapshot replaces the queue; an emptied one is the shared empty queue", () => {
  const prev = queue(["a"], ["b"]);
  assert.deepEqual(Q.fromSnapshot({ steering: [], followUp: ["b", "c"] }, prev), { steering: [], followUp: ["b", "c"] });
  assert.equal(Q.fromSnapshot({ steering: [], followUp: [] }, prev), Q.EMPTY_QUEUE);
});

check("missing or malformed fields read as empty queues", () => {
  assert.equal(Q.fromSnapshot(undefined), Q.EMPTY_QUEUE);
  assert.deepEqual(Q.fromSnapshot({ steering: "a", followUp: ["b", 3, null] }), { steering: [], followUp: ["b"] });
});

// ── rows ─────────────────────────────────────────────────────────────────

check("steering rows come before follow-ups, each in omp's order", () => {
  assert.deepEqual(view(queue(["s1", "s2"], ["f1"])), ["steering:s1", "steering:s2", "followUp:f1"]);
});

check("duplicate texts are distinct rows with distinct keys", () => {
  const r = Q.rows(queue([], ["go", "go"]), []);
  assert.equal(r.length, 2);
  assert.notEqual(r[0].key, r[1].key);
});

check("the same text in both queues gets distinct keys", () => {
  const r = Q.rows(queue(["go"], ["go"]), []);
  assert.notEqual(r[0].key, r[1].key);
});

check("an image-only message cannot be edited back into the draft", () => {
  const r = Q.rows(queue([Q.IMAGE_CHIP], ["text"]), []);
  assert.deepEqual(r.map(x => x.editable), [false, true]);
});

check("a send shows as sending in its own queue until omp lists it", () => {
  const before = queue([], ["f1"]);
  const s = Q.sendingEntry(1, "followUp", "new", 0, before, []);
  assert.deepEqual(view(before, [s]), ["followUp:f1", "followUp:new (sending)"]);
  assert.deepEqual(view(queue([], ["f1", "new"]), [s]), ["followUp:f1", "followUp:new"]);
});

check("a send whose text is already queued stays sending until omp lists it a second time", () => {
  const before = queue(["again"]);
  const s = Q.sendingEntry(1, "steering", "again", 0, before, []);
  assert.deepEqual(view(before, [s]), ["steering:again", "steering:again (sending)"]);
  assert.deepEqual(view(queue(["again", "again"]), [s]), ["steering:again", "steering:again"]);
});

check("two identical sends in flight each wait for their own row", () => {
  const s1 = Q.sendingEntry(1, "steering", "a", 0, Q.EMPTY_QUEUE, []);
  const s2 = Q.sendingEntry(2, "steering", "a", 0, Q.EMPTY_QUEUE, [s1]);
  assert.deepEqual(view(queue(["a"]), [s1, s2]), ["steering:a", "steering:a (sending)"]);
  assert.deepEqual(view(queue(["a", "a"]), [s1, s2]), ["steering:a", "steering:a"]);
});

check("a send listed in the other queue is still sending in its own", () => {
  const s = Q.sendingEntry(1, "steering", "x", 0, Q.EMPTY_QUEUE, []);
  assert.deepEqual(view(queue([], ["x"]), [s]), ["steering:x (sending)", "followUp:x"]);
});

check("an image-only send waits for omp's [Image] row", () => {
  const s = Q.sendingEntry(1, "steering", "", 2, Q.EMPTY_QUEUE, []);
  assert.deepEqual(view(Q.EMPTY_QUEUE, [s]), ["steering:[Image] (sending)"]);
  assert.deepEqual(view(queue([Q.IMAGE_CHIP]), [s]), ["steering:[Image]"]);
});

check("sending rows are not editable", () => {
  const s = Q.sendingEntry(1, "followUp", "x", 0, Q.EMPTY_QUEUE, []);
  assert.equal(Q.rows(Q.EMPTY_QUEUE, [s])[0].editable, false);
});

// ── restoredDraft ────────────────────────────────────────────────────────

check("✎ puts the queued text before what is already typed", () => {
  assert.equal(Q.restoredDraft("queued", "typed"), "queued\n\ntyped");
});

check("✎ into an empty or blank draft is just the queued text", () => {
  assert.equal(Q.restoredDraft("queued", ""), "queued");
  assert.equal(Q.restoredDraft("queued", "  \n"), "queued");
});

// ── failureNote ──────────────────────────────────────────────────────────

check("a refused follow-up's note keeps the text in a fence it cannot close", () => {
  const note = Q.failureNote("followUp", "bad input", "see ```js\nx\n``` here");
  assert.ok(note.startsWith("**Follow-up not sent:** bad input\n\n````\n"));
  assert.ok(note.endsWith("\n````"));
  assert.ok(note.includes("see ```js\nx\n``` here"));
});

check("a refused image-only steer's note has no empty code block", () => {
  assert.equal(Q.failureNote("steering", "too large", ""), "**Steer not sent:** too large");
});

console.log(`message-queue: ${passed} checks passed`);
