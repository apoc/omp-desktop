#!/usr/bin/env node
// Regression script for src/app/turn-status.js — a tab's run state, which
// `agent_end` ends a turn for good, the failure a failed request shows, and
// the background jobs an `async-result` message reports. Fixtures are frames
// captured from omp 18.6.0 (a keyless Anthropic profile's 401, an
// `async: true` bash job).
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

check("run state priority is failed > waiting-user > running > background > idle", () => {
  const all = { exitReason: "omp exited", messages: [ask()], isStreaming: true, asyncPending: true };
  assert.equal(T.runStateOf(all), "failed");
  assert.equal(T.runStateOf({ ...all, exitReason: null }), "waiting-user");
  assert.equal(T.runStateOf({ ...all, exitReason: null, messages: [] }), "running");
  assert.equal(T.runStateOf({ ...all, exitReason: null, messages: [], isStreaming: false }), "background");
  assert.equal(T.runStateOf({ exitReason: null, messages: [], isStreaming: false, asyncPending: false }), "idle");
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

console.log(`test-turn-status: ${passed} checks passed`);
