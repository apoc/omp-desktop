#!/usr/bin/env node
// Regression script for src/app/turn-status.js — a tab's run state, which
// `agent_end` ends a turn for good, the failure a failed request shows, the
// background jobs an `async-result` message reports, and the retry row of
// omp's automatic retries. Fixtures are frames captured from omp 18.6.0 (a
// keyless Anthropic profile's 401, an `async: true` bash job, a local
// provider answering 503).
// Run: node tests/test-turn-status.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win  = {};
// eslint-disable-next-line no-new-func
new Function("window", readFileSync(join(root, "src/app/turn-status.js"), "utf8"))(win);
const T = win.OMP_TURN_STATUS;

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

// ── Captured fixtures ─────────────────────────────────────────────────────
const AUTH_BODY = "401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"},\"request_id\":\"req_011CfguQE6mbDYZ2hzuGZhU4\"}";
const FAILED_401 = {
  role: "assistant", stopReason: "error", content: [],
  errorMessage: AUTH_BODY, errorStatus: 401, provider: "anthropic", model: "claude-opus-5-5",
};
const PROMPT_RESULT_401 = {
  type: "prompt_result", id: "p1", agentInvoked: true, status: "error", sessionSettled: true,
  error: { message: AUTH_BODY, provider: "anthropic", model: "claude-opus-5-5", retryable: false, httpStatus: 401 },
};
const ASYNC_RESULT = {
  role: "custom", customType: "async-result", display: true,
  content: "<system-notice>\nBackground job bg_1 has completed. Resume your work using the result below.\nfinished\nWall time: 8.07 seconds\n</system-notice>",
  details: {
    meta: { source: { type: "report", value: "background job delivery" } },
    jobs: [{ jobId: "bg_1", type: "bash", label: "sleep 8 && echo finished", durationMs: 8068 }],
  },
};

// ── runStateOf ────────────────────────────────────────────────────────────
const ask = (extra = {}) => ({ kind: "ask", answered: false, cancelled: false, ...extra });

check("run state priority is failed > waiting-user > retrying > running > background > idle", () => {
  const retry = { kind: "retry", ended: null };
  const all = { exitReason: "omp exited", messages: [ask(), retry], isStreaming: true, asyncPending: true };
  assert.equal(T.runStateOf(all), "failed");
  assert.equal(T.runStateOf({ ...all, exitReason: null }), "waiting-user");
  assert.equal(T.runStateOf({ ...all, exitReason: null, messages: [retry] }), "retrying");
  assert.equal(T.runStateOf({ ...all, exitReason: null, messages: [] }), "running");
  assert.equal(T.runStateOf({ ...all, exitReason: null, messages: [], isStreaming: false }), "background");
  assert.equal(T.runStateOf({ exitReason: null, messages: [], isStreaming: false, asyncPending: false }), "idle");
});

check("a retry row counts until omp reports how the retries ended", () => {
  const base = { exitReason: null, isStreaming: false, asyncPending: false };
  assert.equal(T.runStateOf({ ...base, messages: [{ kind: "retry", ended: null }] }), "retrying");
  assert.equal(T.runStateOf({ ...base, messages: [{ kind: "retry", ended: { cancelled: true } }] }), "idle");
  // An open ask outranks a retry row wherever it sits.
  assert.equal(T.runStateOf({ ...base, messages: [{ kind: "ask" }, { kind: "retry", ended: null }] }), "waiting-user");
  assert.equal(T.runStateOf({ ...base, messages: [{ kind: "retry", ended: null }, { kind: "ask" }] }), "waiting-user");
});

check("only an open ask waits on the user", () => {
  const base = { exitReason: null, isStreaming: false, asyncPending: true };
  assert.equal(T.runStateOf({ ...base, messages: [ask({ answered: true })] }), "background");
  assert.equal(T.runStateOf({ ...base, messages: [ask({ cancelled: true })] }), "background");
  assert.equal(T.runStateOf({ ...base, messages: [ask(), ask({ answered: true })] }), "waiting-user");
});

check("a yield is agent_end with yielded, or a terminal end from a frame without it", () => {
  // The captured background-job end: non-terminal, but the agent yielded.
  assert.equal(T.isYield({ type: "agent_end", isTerminal: false, yielded: true, awaitingAsyncWork: true }), true);
  assert.equal(T.isYield({ type: "agent_end", isTerminal: true, yielded: true }), true);
  // A retry / compaction / reminder continuation: the agent goes on itself.
  assert.equal(T.isYield({ type: "agent_end", isTerminal: false, yielded: false }), false);
  // Older frames: only a terminal end (or one with no flags at all) yields.
  assert.equal(T.isYield({ type: "agent_end" }), true);
  assert.equal(T.isYield({ type: "agent_end", isTerminal: false }), false);
  // `yielded` wins over `isTerminal` when present.
  assert.equal(T.isYield({ type: "agent_end", isTerminal: true, yielded: false }), false);
  assert.equal(T.isYield({ type: "turn_end", yielded: true }), false);
  assert.equal(T.isYield(null), false);
});

// ── failureOf / providerHeadline / stripDiagnostics ───────────────────────
check("a failed assistant message yields its failure; any other message none", () => {
  const f = T.failureOf(FAILED_401);
  assert.equal(f.raw, AUTH_BODY);
  assert.equal(f.headline, "authentication_error: invalid x-api-key");
  assert.equal(f.httpStatus, 401);
  assert.equal(f.provider, "anthropic");
  assert.equal(f.model, "claude-opus-5-5");
  assert.equal(f.retryable, null, "omp persists no transient verdict");
  assert.equal(T.failureOf({ ...FAILED_401, stopReason: "stop" }), null);
  assert.equal(T.failureOf({ ...FAILED_401, stopReason: "aborted" }), null);
  assert.equal(T.failureOf({ ...FAILED_401, role: "user" }), null);
  assert.equal(T.failureOf(undefined), null);
});

check("a failure without an error text or status still renders", () => {
  const f = T.failureOf({ role: "assistant", stopReason: "error", errorMessage: "  ", errorStatus: "500" });
  assert.ok(f.raw.length > 0);
  assert.equal(f.headline, f.raw);
  assert.equal(f.httpStatus, null, "a non-integer status is dropped");
  assert.equal(f.provider, null);
});

check("omp's request-dump lines are cut from a persisted error, like its RPC relay does", () => {
  const body = "400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"prompt is too long: 218730 tokens > 200000 maximum\"}}";
  const persisted = `${body}\nraw-http-request=C:\\Users\\me\\.omp\\logs\\http-400-requests\\1772065878061.json`;
  const f = T.failureOf({ role: "assistant", stopReason: "error", errorMessage: persisted, errorStatus: 400 });
  assert.equal(f.raw, body);
  assert.equal(f.headline, "invalid_request_error: prompt is too long: 218730 tokens > 200000 maximum");
  assert.equal(T.stripDiagnostics(`${body}\nraw-http-request-save-failed=EACCES`), body);
  // Only trailing dump lines go: a dump-looking line inside the text stays.
  const inner = "raw-http-request=x\nreal error";
  assert.equal(T.stripDiagnostics(inner), inner);
});

check("the headline is the provider's own message from its JSON body, else the first line", () => {
  // Real error texts from omp sessions.
  assert.equal(
    T.providerHeadline("429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"This request would exceed your account's rate limit. Please try again later.\"},\"request_id\":\"req_011CbwvyGcHUA5GCZyRBs9tb\"} retry-after-ms=15154000"),
    "rate_limit_error: This request would exceed your account's rate limit. Please try again later.",
  );
  assert.equal(
    T.providerHeadline("openrouter/~typesafe/jev-latest API error (401): {\"error\":{\"message\":\"User not found.\",\"code\":401}}"),
    "User not found.",
  );
  assert.equal(T.providerHeadline("Anthropic stream error (overloaded_error): Overloaded"), "Anthropic stream error (overloaded_error): Overloaded");
  // A Python-repr body is not JSON: first line.
  const repr = "400 litellm.BadRequestError: Lm_studioException - Error code: 400 - {'error': \"Invalid tool_choice type: 'object'.\"}\nReceived Model Group=rutmaster";
  assert.equal(T.providerHeadline(repr), repr.split("\n")[0]);
  // JSON without an error.message, or an empty one: first line.
  assert.equal(T.providerHeadline("500 {\"detail\":\"boom\"}"), "500 {\"detail\":\"boom\"}");
  assert.equal(T.providerHeadline("{\"error\":{\"message\":\"  \"}}"), "{\"error\":{\"message\":\"  \"}}");
  assert.equal(T.providerHeadline("\n\n  Provider stream stalled  \nmore"), "Provider stream stalled");
});

// ── finalFailures ─────────────────────────────────────────────────────────
const USER = { role: "user", content: [{ type: "text", text: "go" }] };
const OK = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };
const TOOL_RESULT = { role: "toolResult", content: [{ type: "text", text: "ok" }] };

check("a transcript shows a failure only where it ended its run", () => {
  // The captured 401: the run's last assistant message.
  assert.deepEqual([...T.finalFailures([USER, FAILED_401]).keys()], [1]);
  // A new prompt after it does not hide it.
  assert.deepEqual([...T.finalFailures([USER, FAILED_401, USER, OK]).keys()], [1]);
  // A job wake-up starts a new run too.
  assert.deepEqual([...T.finalFailures([USER, FAILED_401, ASYNC_RESULT, OK]).keys()], [1]);
  // omp continued from the failed attempt (a preserved tool turn, a stream
  // stall): another assistant message follows inside the same run.
  assert.deepEqual([...T.finalFailures([USER, FAILED_401, TOOL_RESULT, OK]).keys()], []);
  assert.deepEqual([...T.finalFailures([USER, { ...FAILED_401, content: [{ type: "text", text: "partial" }] }, OK, USER, FAILED_401]).keys()], [4]);
  // A retry omp marked recovered or superseded.
  const recovered = { ...FAILED_401, retryRecovery: { kind: "auto-retry", status: "superseded", attempt: 1 } };
  assert.deepEqual([...T.finalFailures([USER, recovered]).keys()], []);
  // An extension's session_stop hook kept the agent going in the same run.
  const stopContinuation = { role: "custom", customType: "session-stop-continuation", display: false, content: "go on" };
  assert.deepEqual([...T.finalFailures([USER, FAILED_401, stopContinuation, OK]).keys()], []);
  // Any other hidden follow-up queued behind a yield starts a new run.
  const followUp = { role: "custom", customType: "ttsr-follow-up", display: false, content: "x" };
  assert.deepEqual([...T.finalFailures([USER, FAILED_401, followUp, OK]).keys()], [1]);
  assert.equal(T.finalFailures([USER, FAILED_401]).get(1).headline, "authentication_error: invalid x-api-key");
  assert.equal(T.finalFailures(undefined).size, 0);
});

// ── withPromptError ───────────────────────────────────────────────────────
check("prompt_result adds omp's transient verdict to the failure agent_end showed", () => {
  const shown = T.failureOf(FAILED_401);
  const merged = T.withPromptError(shown, PROMPT_RESULT_401.error);
  assert.equal(merged.retryable, false);
  assert.equal(merged.raw, shown.raw);
  assert.equal(merged.headline, shown.headline);
  assert.equal(merged.httpStatus, 401);
  const transient = T.withPromptError(shown, { message: "529 overloaded", retryable: true });
  assert.equal(transient.retryable, true);
  assert.equal(transient.raw, "529 overloaded", "omp's cleaned text replaces the persisted one");
  assert.equal(transient.httpStatus, 401, "fields the error omits keep the shown value");
  assert.equal(transient.provider, "anthropic");
});

check("prompt_result alone (agent_end lost its messages) still builds a failure", () => {
  const f = T.withPromptError(null, PROMPT_RESULT_401.error);
  assert.equal(f.headline, "authentication_error: invalid x-api-key");
  assert.equal(f.httpStatus, 401);
  assert.equal(f.retryable, false);
  const bare = T.withPromptError(null, { retryable: true });
  assert.ok(bare.raw.length > 0);
  assert.equal(bare.retryable, true);
  const shown = T.failureOf(FAILED_401);
  assert.equal(T.withPromptError(shown, undefined), shown);
});

// ── finishedJobsOf ────────────────────────────────────────────────────────
check("an async-result message reports the jobs it delivers", () => {
  assert.deepEqual(T.finishedJobsOf(ASYNC_RESULT), [{ jobId: "bg_1", type: "bash", label: "sleep 8 && echo finished", durationMs: 8068 }]);
  const two = { ...ASYNC_RESULT, details: { jobs: [{ jobId: "bg_1" }, null, { label: "no id" }, { jobId: "task_2", type: "task", durationMs: -1 }] } };
  assert.deepEqual(T.finishedJobsOf(two), [
    { jobId: "bg_1", type: null, label: null, durationMs: null },
    { jobId: "task_2", type: "task", label: null, durationMs: null },
  ]);
});

check("other messages, hidden ones and empty deliveries report no job", () => {
  assert.equal(T.finishedJobsOf({ ...ASYNC_RESULT, display: false }), null);
  assert.equal(T.finishedJobsOf({ ...ASYNC_RESULT, customType: "skill-prompt" }), null);
  assert.equal(T.finishedJobsOf({ ...ASYNC_RESULT, role: "user" }), null);
  assert.equal(T.finishedJobsOf({ ...ASYNC_RESULT, details: { jobs: [] } }), null);
  assert.equal(T.finishedJobsOf({ ...ASYNC_RESULT, details: undefined }), null);
  assert.equal(T.finishedJobsOf(null), null);
});

// ── Automatic retries ─────────────────────────────────────────────────────
const ERR_503 = "503 The server is overloaded, please retry\nThe server is overloaded, please retry (type=server_error param=overloaded)";
const FAILED_503 = {
  role: "assistant", api: "openai-completions", provider: "flaky", model: "flaky-1", stopReason: "error",
  timestamp: 1791125744581, errorStatus: 503, errorId: 135168, errorMessage: ERR_503, content: [],
};
const RETRY_START_1 = { type: "auto_retry_start", attempt: 1, maxAttempts: 10, delayMs: 496.10567382963075, errorMessage: ERR_503, errorId: 135168 };
const RETRY_END_CANCELLED = { type: "auto_retry_end", success: false, attempt: 3, finalError: "Retry cancelled" };
const RETRY_END_OK = { type: "auto_retry_end", success: true, attempt: 1, retryErrors: [{ entryId: "2715fd30", note: "error; retried" }] };
const OK_REPLY = { role: "assistant", stopReason: "stop", timestamp: 1791126230906, content: [{ type: "text", text: "ok" }] };

// The bubbles live.js builds: a failed request leaves its placeholder block.
const userRow = { kind: "user", text: "Reply with only the word: ok" };
const failedRow = (ts) => ({ kind: "assistant", ts, streaming: false, blocks: [{ type: "text", text: "" }], pendingFailure: T.failureOf({ ...FAILED_503, timestamp: ts }) });
const okRow = { kind: "assistant", ts: OK_REPLY.timestamp, streaming: false, blocks: [{ type: "text", text: "ok" }] };
const rowOf = (msgs) => msgs[T.retryIndex(msgs)];
// The run after its first failure: the row waiting (`waitingRun`), or with the next attempt in flight.
const waitingRun = () => T.retryStarted([userRow, failedRow(1)], RETRY_START_1, 5000);
const inFlightRun = () => T.retryAttempting(waitingRun(), 5500);

check("a retried attempt that showed nothing is hidden; the row waits with omp's error", () => {
  const msgs = waitingRun();
  assert.equal(msgs.length, 3);
  assert.equal(msgs[1].superseded, true);
  assert.equal(msgs[1].retried, true);
  const row = rowOf(msgs);
  assert.equal(T.retryIndex(msgs), 2);
  assert.deepEqual([row.attempt, row.maxAttempts, row.phase, row.since, row.delayMs, row.firstFailedAt], [1, 10, "waiting", 5000, RETRY_START_1.delayMs, 5000]);
  assert.deepEqual([row.failure.httpStatus, row.failure.provider, row.failure.model, row.failure.headline],
    [503, "flaky", "flaky-1", "503 The server is overloaded, please retry"]);
});

check("a failed attempt that streamed text before failing stays visible", () => {
  const partial = { ...failedRow(1), blocks: [{ type: "text", text: "Half an ans" }] };
  const msgs = T.retryStarted([userRow, partial], RETRY_START_1, 5000);
  assert.equal(msgs[1].retried, true);
  assert.equal(msgs[1].superseded, undefined);
});

check("without a failed bubble (frames lost) the row takes omp's error text", () => {
  const row = rowOf(T.retryStarted([userRow], RETRY_START_1, 5000));
  assert.equal(row.failure.headline, "503 The server is overloaded, please retry");
  assert.equal(row.failure.provider, null);
});

check("each new attempt moves the one row to the end and keeps when the failures began", () => {
  let msgs = waitingRun();
  msgs[T.retryIndex(msgs)]._id = 7; // live.js keys rows on _id
  msgs = T.retryAttempting(msgs, 5500);
  msgs = [...msgs, failedRow(2)];
  msgs = T.retryStarted(msgs, { ...RETRY_START_1, attempt: 2, delayMs: 866 }, 37000);
  assert.equal(msgs.filter(m => m.kind === "retry").length, 1);
  assert.equal(T.retryIndex(msgs), msgs.length - 1);
  const row = rowOf(msgs);
  assert.deepEqual([row._id, row.attempt, row.failed, row.phase, row.since, row.firstFailedAt], [7, 2, 2, "waiting", 37000, 5000]);
  assert.deepEqual(msgs.filter(m => m.superseded).map(m => m.ts), [1, 2]);
});

check("the failure count follows the frames, not omp's resettable attempt counter", () => {
  // omp restarts `attempt` at 1 when a fallback model takes over.
  let msgs = [userRow];
  for (const [ts, attempt] of [[1, 1], [2, 2], [3, 3], [4, 1]]) {
    msgs = T.retryStarted([...T.retryAttempting(msgs, ts * 1000), failedRow(ts)], { ...RETRY_START_1, attempt }, ts * 1000 + 1);
  }
  assert.deepEqual([rowOf(msgs).attempt, rowOf(msgs).failed], [1, 4]);
  const fin = T.retryFinished([...T.retryAttempting(msgs, 9000), okRow], OK_REPLY, OK_REPLY.timestamp);
  assert.deepEqual(fin.at(-1).retries, { failed: 4, outcome: "recovered" });
});

check("a turn starting while the row waits marks the attempt in flight; other turns change nothing", () => {
  const waiting = waitingRun();
  const flying = T.retryAttempting(waiting, 5600);
  assert.deepEqual([rowOf(flying).phase, rowOf(flying).since], ["attempting", 5600]);
  assert.equal(T.retryAttempting(flying, 9000), flying);
  const plain = [userRow, okRow];
  assert.equal(T.retryAttempting(plain, 9000), plain);
  const ended = T.retryEnded(waiting, RETRY_END_CANCELLED);
  assert.equal(T.retryAttempting(ended, 9000), ended);
});

check("auto_retry_end records how the retries ended; without a row it changes nothing", () => {
  const waiting = waitingRun();
  assert.deepEqual(rowOf(T.retryEnded(waiting, RETRY_END_CANCELLED)).ended, { cancelled: true });
  assert.deepEqual(rowOf(T.retryEnded(waiting, RETRY_END_OK)).ended, { cancelled: false });
  const plain = [userRow, okRow];
  assert.equal(T.retryEnded(plain, RETRY_END_OK), plain);
});

check("the transcript hides a retried blank attempt and an ended row, nothing else", () => {
  const waiting = waitingRun();
  assert.deepEqual(waiting.map(T.isHidden), [false, true, false]);
  assert.deepEqual(T.retryEnded(waiting, RETRY_END_CANCELLED).map(T.isHidden), [false, true, true]);
  assert.equal(T.isHidden(okRow), false);
  assert.equal(T.isHidden({ kind: "job" }), false);
});

check("only an error or a stop is a failed stop", () => {
  assert.equal(T.failedStop(FAILED_503), true);
  assert.equal(T.failedStop({ role: "assistant", stopReason: "aborted" }), true);
  assert.equal(T.failedStop(OK_REPLY), false);
  assert.equal(T.failedStop({ role: "assistant", stopReason: "toolUse" }), false);
  assert.equal(T.failedStop(null), false);
});

check("the attempt that answers ends the retries, even with more turns to come in the run", () => {
  let msgs = inFlightRun();
  // message_end of the answering attempt: a tool call, the run goes on
  const toolUse = { kind: "assistant", ts: 30, streaming: false, blocks: [{ type: "text", text: "" }] };
  msgs = T.retryFinished([...msgs, toolUse], { role: "assistant", stopReason: "toolUse", timestamp: 30 }, 30);
  assert.equal(T.retryIndex(msgs), -1);
  assert.equal(msgs[1].superseded, true);
  assert.deepEqual(msgs[2].retries, { failed: 1, outcome: "recovered" });
  assert.equal(T.runStateOf({ exitReason: null, isStreaming: true, asyncPending: false, messages: msgs }), "running");
  // Later turns, the run's yield and the late success auto_retry_end find no row.
  msgs = [...msgs, { kind: "tool", tool: "edit" }, okRow];
  assert.equal(T.retryFinished(msgs, OK_REPLY, OK_REPLY.timestamp), msgs);
  assert.equal(T.retryEnded(msgs, RETRY_END_OK), msgs);
});

check("a cancel between attempts shows the attempt it ended on again", () => {
  let msgs = [userRow, failedRow(1)];
  msgs = T.retryStarted(msgs, RETRY_START_1, 5000);
  msgs = T.retryStarted([...T.retryAttempting(msgs, 5500), failedRow(2)], { ...RETRY_START_1, attempt: 2 }, 37000);
  msgs = T.retryStarted([...T.retryAttempting(msgs, 37500), failedRow(3)], { ...RETRY_START_1, attempt: 3 }, 69000);
  msgs = T.retryEnded(msgs, RETRY_END_CANCELLED);
  // agent_end carried the last failed attempt
  const fin = T.retryYielded(msgs, { ...FAILED_503, timestamp: 3 }, 3);
  assert.equal(T.retryIndex(fin), -1);
  const last = fin.find(m => m.ts === 3);
  assert.equal(last.superseded, undefined);
  assert.deepEqual(last.retries, { failed: 3, outcome: "stopped" });
  assert.deepEqual(fin.filter(m => m.superseded).map(m => m.ts), [1, 2]);
  // agent_end without it (omp had already dropped it): the last bubble of the
  // run, with its failure shown now — a run no prompt started gets no prompt_result.
  const bare = T.retryYielded(msgs, null, null).find(m => m.ts === 3);
  assert.equal(bare.superseded, undefined);
  assert.deepEqual(bare.retries, { failed: 3, outcome: "stopped" });
  assert.equal(bare.failure.httpStatus, 503);
  assert.equal(bare.pendingFailure, undefined);
});

check("an attempt stopped in flight takes the row's error; giving up counts the last failure too", () => {
  const waiting = waitingRun();
  const aborted = { kind: "assistant", ts: 9, streaming: false, blocks: [{ type: "text", text: "" }] };
  const stopped = T.retryYielded([...T.retryAttempting(waiting, 5500), aborted], { role: "assistant", stopReason: "aborted", timestamp: 9 }, 9);
  const fin = stopped.find(m => m.ts === 9);
  assert.deepEqual(fin.retries, { failed: 1, outcome: "stopped" });
  assert.equal(fin.failure.headline, "503 The server is overloaded, please retry");
  // agent_end without the aborted message: still stopped, not recovered
  const bareStop = T.retryYielded([...T.retryAttempting(waiting, 5500), aborted], null, null).find(m => m.ts === 9);
  assert.deepEqual(bareStop.retries, { failed: 1, outcome: "stopped" });
  assert.equal(bareStop.failure.headline, "503 The server is overloaded, please retry");

  const exhausted = T.retryEnded([...T.retryAttempting(waiting, 5500), failedRow(2)], { type: "auto_retry_end", success: false, attempt: 1, finalError: ERR_503 });
  const gaveUp = T.retryYielded(exhausted, { ...FAILED_503, timestamp: 2 }, 2);
  const gaveUpRow = gaveUp.find(m => m.ts === 2);
  assert.deepEqual(gaveUpRow.retries, { failed: 2, outcome: "failed" });
  assert.equal(gaveUpRow.failure.headline, "503 The server is overloaded, please retry");
  assert.equal(gaveUpRow.pendingFailure, undefined);
});

check("a run that recovered and failed again later ends on the later attempt, not the reply that answered", () => {
  let msgs = inFlightRun();
  const toolUse = { kind: "assistant", ts: 30, streaming: false, blocks: [{ type: "text", text: "" }] };
  msgs = T.retryFinished([...msgs, toolUse], { role: "assistant", stopReason: "toolUse", timestamp: 30 }, 30);
  msgs = [...msgs, { kind: "tool", tool: "bash" }, failedRow(40)];
  msgs = T.retryStarted(msgs, RETRY_START_1, 60000);
  assert.deepEqual([rowOf(msgs).failed, rowOf(msgs).firstFailedAt], [1, 60000]);
  msgs = T.retryEnded(msgs, { ...RETRY_END_CANCELLED, attempt: 1 });
  // agent_end.messages left out the cancelled attempt: its last assistant is the reply that answered.
  const fin = T.retryYielded(msgs, { role: "assistant", stopReason: "toolUse", timestamp: 30 }, 30);
  assert.deepEqual(fin.find(m => m.ts === 30).retries, { failed: 1, outcome: "recovered" });
  assert.equal(fin.find(m => m.ts === 30).failure, undefined);
  const later = fin.find(m => m.ts === 40);
  assert.equal(later.superseded, undefined);
  assert.deepEqual(later.retries, { failed: 1, outcome: "stopped" });
  assert.equal(later.failure.httpStatus, 503);
});

check("an answer whose bubble went missing ends the row without tagging the hidden attempt", () => {
  // Replay gap: the recovered reply's message_start fell out of the journal.
  const msgs = inFlightRun();
  const fin = T.retryFinished(msgs, OK_REPLY, OK_REPLY.timestamp);
  assert.equal(T.retryIndex(fin), -1);
  assert.equal(fin[1].superseded, true);
  assert.equal(fin[1].retries, undefined);
});

check("a prompt omp refused while the row waited does not cut the run off", () => {
  let msgs = waitingRun();
  msgs = [...msgs, { kind: "user", text: "refused, never echoed" }]; // no ts
  msgs = T.retryEnded(msgs, { ...RETRY_END_CANCELLED, attempt: 1 });
  const fin = T.retryYielded(msgs, null, null);
  assert.equal(fin[1].superseded, undefined);
  assert.deepEqual(fin[1].retries, { failed: 1, outcome: "stopped" });
  assert.equal(fin[1].failure.httpStatus, 503);
});

check("a failed attempt lost to a replay gap never puts its outcome on an earlier answered reply", () => {
  // "Let me look." + tool call answered; the next request streamed a long
  // partial answer, failed and was retried, but its bubble never arrived.
  const answered = { kind: "assistant", ts: 20, streaming: false, blocks: [{ type: "text", text: "Let me look." }] };
  let msgs = T.retryStarted([userRow, answered, { kind: "tool", tool: "bash" }], RETRY_START_1, 5000);
  msgs = T.retryEnded(msgs, { ...RETRY_END_CANCELLED, attempt: 1 });
  for (const [last, ts] of [[{ ...FAILED_503, timestamp: 40 }, 40], [{ role: "assistant", stopReason: "toolUse", timestamp: 20 }, 20], [null, null]]) {
    const fin = T.retryYielded(msgs, last, ts);
    assert.equal(T.retryIndex(fin), -1);
    assert.equal(fin[1].retries, undefined);
    assert.equal(fin[1].failure, undefined);
  }
});

check("a desktop note after the row is never taken for the final attempt", () => {
  // `/usage` ran while omp waited (builtins skip omp's busy check): a ts-less
  // user bubble and note follow the row, then Stop and a bare cancel yield.
  let msgs = waitingRun();
  msgs = [...msgs, { kind: "user", text: "/usage" }, { kind: "assistant", streaming: false, completed: true, blocks: [{ type: "text", text: "usage…" }] }];
  msgs = T.retryEnded(msgs, RETRY_END_CANCELLED);
  const fin = T.retryYielded(msgs, null, null);
  assert.equal(fin.at(-1).retries, undefined);
  assert.equal(fin.at(-1).failure, undefined);
  assert.equal(fin[1].superseded, undefined);
  assert.deepEqual(fin[1].retries, { failed: 1, outcome: "stopped" });
});

check("a stream omp retried after it stalled without content is hidden like a failed one", () => {
  const stalled = { kind: "assistant", ts: 1, streaming: false, blocks: [{ type: "text", text: "" }], aborted: true };
  const msgs = T.retryStarted([userRow, stalled], { ...RETRY_START_1, errorMessage: "Request was aborted" }, 5000);
  assert.deepEqual([msgs[1].retried, msgs[1].superseded], [true, true]);
  assert.equal(rowOf(msgs).failure.headline, "Request was aborted");
  // A bare cancel yield ends on it: stopped, with the row's error.
  const fin = T.retryYielded(T.retryEnded(msgs, RETRY_END_CANCELLED), null, null);
  assert.deepEqual(fin[1].retries, { failed: 1, outcome: "stopped" });
  assert.equal(fin[1].failure.headline, "Request was aborted");
});

check("only a reply with output answers, by omp's rule; an empty stop does not", () => {
  const msg = (stopReason, content) => ({ role: "assistant", stopReason, content });
  assert.equal(T.producedOutput(OK_REPLY), true);
  assert.equal(T.producedOutput(msg("toolUse", [{ type: "toolCall", id: "t", name: "bash", arguments: {} }])), true);
  assert.equal(T.producedOutput(msg("length", [{ type: "text", text: "cut off" }])), true);
  assert.equal(T.producedOutput(msg("stop", [{ type: "thinking", thinking: "…", thinkingSignature: "sig" }])), true);
  assert.equal(T.producedOutput(msg("stop", [])), false);
  assert.equal(T.producedOutput(msg("stop", [{ type: "text", text: "  " }])), false);
  assert.equal(T.producedOutput(msg("stop", [{ type: "thinking", thinking: "…" }])), false, "unsigned thinking");
  assert.equal(T.producedOutput(msg("toolUse", [{ type: "thinking", thinking: "…", thinkingSignature: "sig" }])), false, "a toolUse stop needs a call or text");
  assert.equal(T.producedOutput(FAILED_503), false);
  assert.equal(T.producedOutput(msg("aborted", [{ type: "text", text: "partial" }])), false);
  // A steer drained at the start of a retry attempt, and a tool result, answer nothing.
  assert.equal(T.producedOutput({ role: "user", content: [{ type: "text", text: "also check the logs" }] }), false);
  assert.equal(T.producedOutput({ role: "toolResult", content: [{ type: "text", text: "ok" }] }), false);
});

check("a yield without a retry row and a dead process leave no trace", () => {
  const plain = [userRow, okRow];
  assert.equal(T.retryYielded(plain, OK_REPLY, OK_REPLY.timestamp), plain);
  assert.equal(T.retryCleared(plain), plain);
  const waiting = waitingRun();
  assert.equal(T.retryIndex(T.retryCleared(waiting)), -1);
});

console.log(`test-turn-status: ${passed} checks passed`);
