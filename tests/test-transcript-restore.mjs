#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const ctx = vm.createContext({ console });
ctx.window = ctx;
for (const file of [
  "app/turn-status.js",
  "app/transcript-merge.js",
  "adapter.js",
]) {
  vm.runInContext(
    readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"),
    ctx,
  );
}
const adapt = (messages) => ctx.adaptAgentMessages(messages);
const { mergeTranscript } = ctx.OMP_TRANSCRIPT;
const plain = (value) => JSON.parse(JSON.stringify(value));
const user = (timestamp, text) => ({
  role: "user",
  timestamp,
  content: [{ type: "text", text }],
});
const call = (id, name, args) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
  intent: `Run ${name}`,
});
const assistant = (timestamp, calls) => ({
  role: "assistant",
  timestamp,
  stopReason: "toolUse",
  content: [
    { type: "thinking", thinking: "Inspect, verify, then edit." },
    ...calls,
  ],
  usage: { input: 120, output: 30 },
});
const result = (toolCallId, toolName, text, details = {}, isError = false) => ({
  role: "toolResult",
  timestamp: 3,
  toolCallId,
  toolName,
  isError,
  content: [{ type: "text", text }],
  details,
});
const history = [
  user(1, "Fix the bug."),
  assistant(2, [
    call("read-1", "read", { path: "src/main.js" }),
    call("bash-1", "bash", { command: "npm test" }),
    call("edit-1", "edit", { path: "src/main.js" }),
    call("eval-1", "eval", { input: "===== js =====\n2 + 2" }),
  ]),
  // Completion order is not invocation order.
  result("eval-1", "eval", "4", {
    cells: [{ code: "2 + 2", language: "js", output: "4", status: "ok" }],
  }),
  result("edit-1", "edit", "updated", {
    path: "src/main.js",
    diff: "@@ -1 +1 @@\n-old\n+fixed",
  }),
  result(
    "bash-1",
    "bash",
    "FAIL regression\n\nCommand exited with code 1",
    { exitCode: 1, wallTimeMs: 125 },
    true,
  ),
  result("read-1", "read", "file contents", { lines: 20 }),
  {
    role: "assistant",
    timestamp: 4,
    content: [{ type: "text", text: "Fixed." }],
    stopReason: "stop",
  },
];

test("reopened history retains tool order, arguments, results, errors and token usage", () => {
  const before = JSON.stringify(history);
  const restored = adapt(history);
  assert.deepEqual(
    Array.from(restored, (m) => (m.kind === "tool" ? m.tool : m.kind)),
    ["user", "assistant", "read", "bash", "edit", "eval", "assistant"],
  );
  const [read, bash, edit, evaluate] = restored.filter(
    (m) => m.kind === "tool",
  );
  assert.equal(read.title, "Run read");
  assert.equal(read.target, "src/main.js");
  assert.equal(read.summary, "20 lines");
  assert.equal(bash.isError, true);
  assert.equal(bash.duration, 125);
  assert.equal(bash.outputText, "FAIL regression");
  assert.deepEqual(plain(edit.targets), ["src/main.js"]);
  assert.equal(edit.adds, 1);
  assert.equal(edit.rems, 1);
  assert.equal(evaluate.cells[0].output, "4");
  assert.equal(restored[1].thought, "Inspect, verify, then edit.");
  assert.equal(restored[1].tokens, 150);
  assert.equal(JSON.stringify(history), before);
});

test("a saved result without its call remains visible; unexecuted calls do not pretend to run", () => {
  const restored = adapt([
    assistant(1, [call("planned", "bash", { command: "never executed" })]),
    result("orphan", "bash", "kept output"),
  ]);
  const tools = restored.filter((m) => m.kind === "tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0]._toolCallId, "orphan");
  assert.equal(tools[0].outputText, "kept output");
  assert.equal(
    tools[0].duration,
    null,
    "missing timing is not reported as zero milliseconds",
  );
  assert.equal(tools[0].status, "ok");
});

test("repeated history refreshes preserve live tool identity and richer live output without duplication", () => {
  const persisted = adapt(history);
  const liveCard = {
    ...persisted.find((m) => m.tool === "bash"),
    _historySource: undefined,
    _id: 42,
    duration: 129,
    outputText: "complete live output",
  };
  const live = [persisted[0], persisted[1], liveCard, persisted.at(-1)];
  const once = mergeTranscript(live, persisted);
  const twice = mergeTranscript(once, persisted);
  assert.deepEqual(
    Array.from(twice, (m) => (m.kind === "tool" ? m.tool : m.kind)),
    ["user", "assistant", "read", "bash", "edit", "eval", "assistant"],
  );
  assert.equal(
    twice.find((m) => m.tool === "bash"),
    liveCard,
  );
  assert.equal(liveCard.outputText, "complete live output");
  assert.equal(liveCard._id, 42);
});

test("raw branch arguments survive model-context results arriving before or after them", () => {
  const raw = adapt(history);
  const filtered = adapt(history.filter((m) => m.role !== "assistant"));
  const restored = mergeTranscript(filtered, raw);
  const refreshed = mergeTranscript(restored, filtered);
  const bash = refreshed.find((m) => m.tool === "bash");
  assert.equal(bash.title, "Run bash");
  assert.equal(bash.target, "npm test");
  assert.deepEqual(
    Array.from(
      refreshed.filter((m) => m.kind === "tool"),
      (m) => m.tool,
    ),
    ["read", "bash", "edit", "eval"],
  );
});

test("a persisted result completes a live card whose end frame was lost", () => {
  const persisted = adapt(history);
  const running = {
    kind: "tool",
    tool: "bash",
    status: "running",
    _toolCallId: "bash-1",
    _id: 9,
  };
  const merged = mergeTranscript(
    [persisted[0], persisted[1], running, persisted.at(-1)],
    persisted,
  );
  const finished = merged.find((m) => m.tool === "bash");
  assert.equal(finished.status, "ok");
  assert.equal(finished.isError, true);
  assert.equal(finished.outputText, "FAIL regression");
  assert.equal(finished._id, 9);
});

test("trimming within a tool batch does not resurrect its earlier tools", () => {
  const persisted = adapt(history);
  const tail = persisted.slice(4);
  const merged = mergeTranscript(tail, persisted, { trimmed: true });
  assert.deepEqual(
    Array.from(merged, (m) => (m.kind === "tool" ? m.tool : m.kind)),
    ["edit", "eval", "assistant"],
  );
});

test("raw calls retain a trim boundary held only by provisional result cards", () => {
  const raw = adapt(history);
  const filtered = adapt(history.filter((m) => m.role === "toolResult"));
  const merged = mergeTranscript(filtered, raw, { trimmed: true });
  assert.deepEqual(
    Array.from(merged, (m) => (m.kind === "tool" ? m.tool : m.kind)),
    ["read", "bash", "edit", "eval", "assistant"],
  );
});

test("raw entries restore only the active branch, including history before compaction", () => {
  const entries = history.map((message, i) => ({
    type: "message",
    id: `m${i}`,
    parentId: i ? `m${i - 1}` : null,
    message,
  }));
  entries.push({
    type: "message",
    id: "abandoned",
    parentId: "m0",
    message: user(10, "Wrong branch"),
  });
  entries.push({
    type: "compaction",
    id: "compact",
    parentId: "m6",
    summary: "Earlier work",
  });
  const messages = ctx.OMP_TRANSCRIPT.messagesFromEntries({
    entries,
    leafId: "compact",
  });
  assert.deepEqual(plain(messages), history);
  assert.deepEqual(
    plain(
      ctx.OMP_TRANSCRIPT.messagesFromEntries({ entries: [], leafId: null }),
    ),
    [],
  );
  assert.equal(
    ctx.OMP_TRANSCRIPT.messagesFromEntries({ entries, leafId: "missing" }),
    null,
  );
  assert.equal(
    ctx.OMP_TRANSCRIPT.messagesFromEntries({
      entries: [...entries, entries[0]],
      leafId: "compact",
    }),
    null,
  );
  const cyclic = [
    { type: "message", id: "a", parentId: "b" },
    { type: "message", id: "b", parentId: "a" },
  ];
  assert.equal(
    ctx.OMP_TRANSCRIPT.messagesFromEntries({ entries: cyclic, leafId: "a" }),
    null,
  );
});
