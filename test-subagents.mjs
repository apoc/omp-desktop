#!/usr/bin/env node
// Regression script for src/app/subagents.js — the subagent manager's
// reducer over omp's RPC subagent frames, snapshot reconciliation, and the
// grouping/formatting the manager pane renders from.
// Run: node test-subagents.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const src   = readFileSync(join(__dir, "src/app/subagents.js"), "utf8");
const win   = {};
// eslint-disable-next-line no-new-func
new Function("window", src)(win);
const S = win.OMP_SUBAGENTS;

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

// ── Frame builders (omp wire shapes) ──────────────────────────────────────
const CALL = "call_A";
const life = (id, status, extra = {}) => ({
  type: "subagent_lifecycle",
  payload: { id, agent: "task", agentSource: "bundled", status, index: 0, parentToolCallId: CALL, ...extra },
});
const prog = (id, status, progress = {}, extra = {}) => ({
  type: "subagent_progress",
  payload: {
    index: 0, agent: "task", agentSource: "bundled", task: "t", parentToolCallId: CALL, ...extra,
    progress: { index: 0, id, agent: "task", status, task: "t", recentTools: [], recentOutput: [],
      toolCount: 0, requests: 0, tokens: 0, cost: 0, durationMs: 0, ...progress },
  },
});
const evt = (id, event) => ({ type: "subagent_event", payload: { id, event } });
const fold = (frames, state = S.emptySubagents(), now = 1000) =>
  frames.reduce((acc, f) => S.applySubagentFrame(acc, f, now), state);

// ── Lifecycle / progress ──────────────────────────────────────────────────

check("started → running; terminal agent is retained with endedAt", () => {
  let s = fold([life("A", "started")], undefined, 1000);
  assert.equal(s.byId.A.status, "running");
  assert.equal(s.byId.A.startedAt, 1000);
  s = fold([life("A", "failed")], s, 4000);
  assert.equal(s.byId.A.status, "failed");
  assert.equal(s.byId.A.endedAt, 4000);
  assert.deepEqual(s.order, ["A"]);
});

check("terminal lifecycle for an unknown id is ignored", () => {
  const s = fold([life("A", "completed")]);
  assert.deepEqual(s.order, []);
});

check("frames from a different owner (task call) never land on the record", () => {
  let s = fold([life("A", "started"), prog("A", "running", { tokens: 10 })]);
  s = fold([prog("A", "running", { tokens: 999 }, { parentToolCallId: "call_B" })], s);
  s = fold([life("A", "failed", { parentToolCallId: "call_B" })], s);
  assert.equal(s.byId.A.progress.tokens, 10);
  assert.equal(s.byId.A.status, "running");
});

check("late non-terminal progress after the terminal frame does not revive", () => {
  let s = fold([life("A", "started"), life("A", "completed")]);
  s = fold([prog("A", "running", { tokens: 5 })], s);
  assert.equal(s.byId.A.status, "completed");
});

check("a new `started` for a finished id is a fresh run", () => {
  let s = fold([life("A", "started"), prog("A", "running", { tokens: 50 }), life("A", "completed")], undefined, 1000);
  s = fold([life("A", "started")], s, 9000);
  assert.equal(s.byId.A.status, "running");
  assert.equal(s.byId.A.progress, null);
  assert.equal(s.byId.A.endedAt, null);
  assert.equal(s.byId.A.startedAt, 9000);
});

check("a replayed (late) lifecycle start is corrected by omp's durationMs", () => {
  let s = fold([life("A", "started")], undefined, 50_000);      // replayed 20s late
  s = fold([prog("A", "running", { durationMs: 20_500 })], s, 50_500);
  assert.equal(s.byId.A.startedAt, 30_000);
  s = fold([prog("A", "running", { durationMs: 21_000 })], s, 51_500); // never moves later
  assert.equal(s.byId.A.startedAt, 30_000);
});

check("progress before any lifecycle (late subscribe) backdates the start", () => {
  const s = fold([prog("A", "running", { durationMs: 3000 })], undefined, 10_000);
  assert.equal(s.byId.A.startedAt, 7000);
  assert.equal(s.byId.A.status, "running");
});

// ── Event stream ──────────────────────────────────────────────────────────

check("events are summarized; bookkeeping events are dropped; stream is capped", () => {
  let s = fold([life("A", "started")]);
  s = fold([
    evt("A", { type: "tool_execution_start", toolName: "read", args: { path: "src/x.js" } }),
    evt("A", { type: "message_update" }),
    evt("A", { type: "tool_execution_end", toolName: "read", isError: false }),
    evt("A", { type: "tool_execution_end", toolName: "bash", isError: true }),
    evt("A", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: " done " }] } }),
  ], s);
  assert.deepEqual(s.byId.A.stream.map(l => [l.kind, l.text]), [["tool", "src/x.js"], ["error", "tool failed"], ["text", "done"]]);
  for (let i = 0; i < 250; i++) s = fold([evt("A", { type: "tool_execution_start", toolName: "read", args: String(i) })], s);
  assert.equal(s.byId.A.stream.length, 200);
  assert.equal(s.byId.A.stream.at(-1).text, "249");
});

check("events for unknown agents are ignored", () => {
  const s = fold([evt("Z", { type: "tool_execution_start", toolName: "read" })]);
  assert.deepEqual(s.order, []);
});

check("frames that change nothing return the same state object (live.js skips notify)", () => {
  const s = fold([life("A", "started")]);
  for (const f of [
    evt("A", { type: "message_update" }),
    evt("A", { type: "tool_execution_end", toolName: "read", isError: false }),
    evt("Z", { type: "tool_execution_start", toolName: "read" }),
    life("Z", "completed"),
    { type: "something_else" },
  ]) assert.equal(S.applySubagentFrame(s, f, 2000), s, JSON.stringify(f));
});

check("ids that name Object.prototype members are ordinary agents", () => {
  const s = fold([life("constructor", "started"), prog("toString", "running", { durationMs: 0 })]);
  assert.deepEqual(S.listAgents(s).map(a => a.id), ["constructor", "toString"]);
  assert.deepEqual(S.groupByCall(s, S.listAgents(s)).map(g => g.rows.map(r => r.agent.id)), [["constructor", "toString"]]);
  assert.equal(S.getAgent(s, "hasOwnProperty"), undefined);
});

// ── Snapshot reconciliation ───────────────────────────────────────────────

check("mergeSnapshots: live-but-absent agents end with an unknown outcome", () => {
  let s = fold([life("A", "started"), life("B", "started"), life("C", "started"), life("C", "failed")]);
  s = S.mergeSnapshots(s, [{ id: "B", index: 1, agent: "task", status: "running", parentToolCallId: CALL, lastUpdate: 4000, progress: { tokens: 42, durationMs: 3000 } }], 5000);
  assert.equal(s.byId.A.status, "completed");
  assert.equal(s.byId.A.unknownOutcome, true);
  assert.equal(s.byId.B.status, "running");
  assert.equal(s.byId.B.progress.tokens, 42);
  assert.equal(s.byId.C.status, "failed", "already-terminal agents are left alone");
  assert.equal(s.byId.C.unknownOutcome, false);
});

check("mergeSnapshots: a finished agent listed live again is a fresh run, not a revival", () => {
  let s = fold([life("W", "started"), prog("W", "running", { tokens: 900 })], undefined, 1000);
  s = S.mergeSnapshots(s, [], 60_000);                                   // turn 1 ended unseen
  s = S.mergeSnapshots(s, [{ id: "W", index: 0, agent: "task", status: "running", parentToolCallId: CALL,
    lastUpdate: 119_000, progress: { tokens: 50, durationMs: 4000 } }], 120_000); // turn 2
  assert.equal(s.byId.W.status, "running");
  assert.equal(s.byId.W.unknownOutcome, false);
  assert.equal(s.byId.W.endedAt, null);
  assert.equal(s.byId.W.startedAt, 115_000);
  assert.equal(s.byId.W.progress.tokens, 50);
  s = fold([life("W", "failed")], s, 125_000);                          // its real outcome shows
  assert.equal(s.byId.W.status, "failed");
  assert.equal(s.byId.W.unknownOutcome, false);
});

check("mergeSnapshots: first sight backdates from omp's lastUpdate, not receive time", () => {
  const s = S.mergeSnapshots(S.emptySubagents(), [{ id: "Q", index: 0, agent: "task", status: "running",
    parentToolCallId: CALL, lastUpdate: 60_000, progress: { durationMs: 60_000 } }], 300_000);
  assert.equal(s.byId.Q.startedAt, 0);
});

check("mergeSnapshots: a snapshot from a different owner does not touch the record", () => {
  let s = fold([life("A", "started"), prog("A", "running", { tokens: 10 })]);
  s = S.mergeSnapshots(s, [{ id: "A", index: 0, agent: "task", status: "running", parentToolCallId: "call_B",
    lastUpdate: 900, progress: { tokens: 999, durationMs: 0 } }], 1000);
  assert.equal(s.byId.A.progress.tokens, 10);
});

check("mergeSnapshots: a live record whose turn ended and restarted unseen becomes a fresh run", () => {
  let s = fold([life("W", "started"), evt("W", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "turn 1" }] } })], undefined, 1000);
  s = S.mergeSnapshots(s, [{ id: "W", index: 0, agent: "task", status: "running", parentToolCallId: CALL,
    lastUpdate: 119_000, progress: { durationMs: 4000 } }], 120_000);
  assert.equal(s.byId.W.startedAt, 115_000);
  assert.deepEqual(s.byId.W.stream, [], "turn 1's stream does not leak into turn 2");
});

check("mergeSnapshots: the same live run stays one record (quiet agent, late receive)", () => {
  let s = fold([life("Q", "started"), evt("Q", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } })], undefined, 5000);
  s = S.mergeSnapshots(s, [{ id: "Q", index: 0, agent: "task", status: "running", parentToolCallId: CALL,
    lastUpdate: 60_000, progress: { durationMs: 58_000 } }], 300_000);
  assert.equal(s.byId.Q.startedAt, 2000, "pulled back to omp's start, not restarted");
  assert.equal(s.byId.Q.stream.length, 1);
});

check("mergeTranscript appends tails and restarts on reset", () => {
  const m = text => ({ role: "user", content: text });
  let t = S.mergeTranscript(undefined, { messages: [m("a")], nextByte: 10, reset: false });
  t = S.mergeTranscript(t, { messages: [m("b")], nextByte: 20, reset: false });
  assert.deepEqual(t.messages.map(x => x.content), ["a", "b"]);
  assert.equal(t.nextByte, 20);
  t = S.mergeTranscript(t, { messages: [m("c")], nextByte: 5, reset: true });
  assert.deepEqual(t.messages.map(x => x.content), ["c"]);
  assert.equal(t.status, "ready");
});

// ── Selectors ─────────────────────────────────────────────────────────────

const layout = groups => groups.map(g => [g.callId, g.rows.map(r => `${r.agent.id}@${r.depth}`)]);

check("groupByCall: nested agents group under their root's call, after their parent", () => {
  const s = fold([
    life("B", "started", { index: 1 }),
    life("A", "started", { index: 0 }),
    life("A.Scout", "started", { index: 0, parentToolCallId: "call_inner" }),
    life("R", "started", { index: 0, parentToolCallId: "call_R" }),
  ]);
  assert.deepEqual(layout(S.groupByCall(s, S.listAgents(s))),
    [[CALL, ["A@0", "A.Scout@1", "B@0"]], ["call_R", ["R@0"]]]);
  assert.equal(S.rootCallIdOf(s, s.byId["A.Scout"]), CALL, "nested agents resolve to the main-chat call");
});

check("groupByCall: a child whose parent is filtered out becomes a depth-0 root", () => {
  let s = fold([life("A", "started"), life("A.Scout", "started", { parentToolCallId: "call_inner" })]);
  s = fold([life("A", "completed")], s);
  assert.deepEqual(layout(S.groupByCall(s, S.listAgents(s, "live"))), [[CALL, ["A.Scout@0"]]]);
});

check("filters and totals partition by status", () => {
  const s = fold([
    life("A", "started"), prog("A", "running", { tokens: 100, cost: 0.5, toolCount: 3 }),
    life("B", "started"), life("B", "completed"),
    life("C", "started"), life("C", "aborted"),
  ]);
  assert.deepEqual(S.listAgents(s, "live").map(a => a.id), ["A"]);
  assert.deepEqual(S.listAgents(s, "done").map(a => a.id), ["B"]);
  assert.deepEqual(S.listAgents(s, "failed").map(a => a.id), ["C"]);
  const t = S.totals(S.listAgents(s));
  assert.deepEqual([t.total, t.live, t.done, t.failed, t.tokens, t.cost, t.tools], [3, 1, 1, 1, 100, 0.5, 3]);
});

// ── Formatting ────────────────────────────────────────────────────────────

check("formatArgs: bare single value, key/value pairs, truncation", () => {
  assert.equal(S.formatArgs({ path: "src/a.js" }), "src/a.js");
  assert.equal(S.formatArgs({ pattern: "x", path: "src" }), "pattern x · path src");
  assert.equal(S.formatArgs("a".repeat(200)).length, 118);
  assert.equal(S.formatArgs(null), "");
});

check("fmtAgo tier boundaries", () => {
  assert.equal(S.fmtAgo(1499), "now");
  assert.equal(S.fmtAgo(59_499), "59s");
  assert.equal(S.fmtAgo(59_600), "1m");
});

check("fmtDuration tier boundaries", () => {
  assert.equal(S.fmtDuration(999), "999ms");
  assert.equal(S.fmtDuration(1000), "1.0s");
  assert.equal(S.fmtDuration(59_949), "59.9s");
  assert.equal(S.fmtDuration(59_999), "1m 00s");
  assert.equal(S.fmtDuration(65_000), "1m 05s");
});

console.log(`subagents: ${passed} checks passed`);
