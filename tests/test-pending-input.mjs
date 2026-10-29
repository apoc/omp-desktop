import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const window = {};
vm.runInNewContext(
  readFileSync(new URL("../src/app/pending-input.js", import.meta.url), "utf8"),
  { window },
);
const input = window.OMP_PENDING_INPUT;
const ask = (id, fields = {}) => ({
  kind: "ask",
  id,
  method: "ask",
  questions: [{ question: "Which project?" }],
  ...fields,
});

test("open requests remain discoverable while sending or after a rejected answer", () => {
  const messages = [
    ask("first", { sending: true }),
    { kind: "assistant", streaming: true },
    ask("second", { sendError: "write failed" }),
    ask("answered", { answered: true }),
    ask("cancelled", { cancelled: true }),
  ];
  assert.deepEqual(
    Array.from(input.pending(messages), (message) => message.id),
    ["first", "second"],
  );
});

test("replayed request ids do not duplicate reminders, and native closure removes them", () => {
  assert.equal(input.pending([ask("a"), ask("a"), ask("b")]).length, 2);
  assert.equal(
    input.pending([ask("a", { cancelled: true, closedByOmp: true })]).length,
    0,
  );
});

test("parallel questions, approvals and background work coexist without hiding input", () => {
  const requests = input.pending([
    ask("a", { questions: [{ question: "One?" }, { question: "Two?" }] }),
    ask("approval", { method: "select", title: "Allow tool: bash" }),
  ]);
  const state = input.summary(requests, true);
  assert.equal(state.requests, 2);
  assert.equal(state.questions, 3);
  assert.equal(state.questionsOnly, false);
  assert.equal(state.concurrentWork, true);
  assert.equal(input.summary(requests, false).concurrentWork, false);
  assert.equal(input.summary([], true).concurrentWork, false);
});

test("restored questions remain actionable without resurrecting settled callbacks", () => {
  const requests = input.pending([
    ask("restored", { recovery: { file: "/isolated/session.jsonl" } }),
    ask("dead", { cancelled: true, closeReason: "process-exited" }),
  ]);
  assert.equal(requests[0].id, "restored");
  assert.equal(requests.length, 1);
});
