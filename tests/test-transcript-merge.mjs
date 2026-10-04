#!/usr/bin/env node
// Regression script for src/app/transcript-merge.js — laying omp's persisted
// transcript (get_messages through adapter.js `adaptAgentMessages`) over a
// tab's live one after a tab switch. Entries are matched by omp's message
// timestamp (`ts`), so a live entry without a persisted copy — the bubble of
// a message that went straight to a tool call, an attempt omp retried and
// dropped, a note — no longer takes the next entry's copy. Before, it did:
// a reply jumped above the tool call it followed and everything after it
// shifted. Message shapes are from omp 18.6.0 sessions.
// Run: node tests/test-transcript-merge.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({ console });
ctx.window = ctx;
for (const file of ["app/turn-status.js", "app/transcript-merge.js", "adapter.js"]) {
  vm.runInContext(readFileSync(join(root, "src", file), "utf8"), ctx, { filename: file });
}
const { mergeTranscript } = ctx.OMP_TRANSCRIPT;
const adapt = (messages) => ctx.adaptAgentMessages(messages);

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

// ── omp messages (get_messages) ───────────────────────────────────────────
const userMsg = (text, ts) => ({ role: "user", content: [{ type: "text", text }], timestamp: ts });
const replyMsg = (text, ts) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }], timestamp: ts });
const toolCallMsg = (ts, extra = []) => ({
  role: "assistant", stopReason: "toolUse", timestamp: ts,
  content: [...extra, { type: "toolCall", id: `toolu_${ts}`, name: "bash", arguments: { command: "sleep 8 && echo finished", async: true } }],
});
const toolResultMsg = (ts) => ({ role: "toolResult", toolCallId: "toolu_1", content: [{ type: "text", text: "Backgrounded as job bg_1" }], timestamp: ts });
const asyncResultMsg = (ts) => ({
  role: "custom", customType: "async-result", display: true, timestamp: ts,
  content: "<system-notice>\nBackground job bg_1 has completed.\nfinished\n</system-notice>",
  details: { jobs: [{ jobId: "bg_1", type: "bash", label: "sleep 8 && echo finished", durationMs: 8068 }] },
});
const OVERLOADED = "529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}";
const failedMsg = (text, ts) => ({
  role: "assistant", stopReason: "error", content: [], timestamp: ts,
  errorMessage: text, errorStatus: 529, provider: "anthropic", model: "claude-opus-5-5",
});

// ── the live transcript, as live.js builds it ────────────────────────────
// Entries built from an omp message carry its timestamp as `ts`.
const liveUser = (text, ts) => ({ kind: "user", time: "live", ts, text, images: [] });
const liveBubble = (text, ts, extra = {}) => ({ kind: "assistant", time: "live", ts, thought: null, lead: null, streaming: false, blocks: [{ type: "text", text }], ...extra });
const liveTool = () => ({ kind: "tool", tool: "bash", status: "ok", _toolCallId: "toolu_1" });
const liveAsk = () => ({ kind: "ask", method: "select", answered: true, cancelled: false });
const liveJob = () => ({ kind: "job", jobId: "bg_1", type: "bash", label: "sleep 8 && echo finished", durationMs: 8068 });
const liveNote = (text) => ({ kind: "assistant", time: "live", blocks: [{ type: "text", text }], thought: null, lead: null, streaming: false, completed: true });

// Array.from: the merge runs in the vm realm, and deepStrictEqual rejects an
// array whose prototype is that realm's Array.prototype.
const shape = (list) => Array.from(list, m => `${m.kind}${m.kind === "assistant" || m.kind === "user" ? `:${m.text ?? m.blocks?.map(b => b.text).join("") ?? ""}` : ""}`);

const PROMPT = "Use the bash tool with async: true to run exactly `sleep 8 && echo finished`.";

check("a reply after a tool call keeps its place, and so does everything after it", () => {
  // The captured background-job turn: tool call, approval, "started", the
  // job's wake-up, "done". The adapter skips the tool-call message.
  const persisted = adapt([
    userMsg(PROMPT, 1), toolCallMsg(2), toolResultMsg(3), replyMsg("started", 4),
    asyncResultMsg(5), replyMsg("done", 6),
  ]);
  const live = [liveUser(PROMPT, 1), liveBubble("", 2), liveTool(), liveAsk(), liveBubble("started", 4), liveJob(), liveBubble("done", 6)];
  const merged = mergeTranscript(live, persisted);
  assert.deepEqual(shape(merged), [`user:${PROMPT}`, "assistant:", "tool", "ask", "assistant:started", "job", "assistant:done"]);
  // Matched entries are the persisted copies; the rest are the live ones.
  assert.equal(merged[0], persisted[0]);
  assert.equal(merged[4], persisted[1]);
  assert.equal(merged[6], persisted[2]);
  for (const i of [1, 2, 3, 5]) assert.equal(merged[i], live[i]);
});

check("a message omp dropped from its context keeps its live bubble in place", () => {
  // A retried attempt that streamed thinking before it failed: omp removes
  // it from the session, the retry's thinking + tool call and reply stay.
  const persisted = adapt([
    userMsg("go", 1), toolCallMsg(3, [{ type: "thinking", thinking: "run it in the background" }]),
    toolResultMsg(4), replyMsg("done", 5),
  ]);
  const retried = liveBubble("", 2, { thought: "Let me look", pendingFailure: { raw: OVERLOADED } });
  const live = [liveUser("go", 1), retried, liveBubble("", 3, { thought: "run it in the background" }), liveTool(), liveBubble("done", 5)];
  const merged = mergeTranscript(live, persisted);
  assert.deepEqual(shape(merged), ["user:go", "assistant:", "assistant:", "tool", "assistant:done"]);
  assert.equal(merged[1], retried);
  assert.equal(merged[2], persisted[1]);
  assert.equal(merged[4], persisted[2]);
  // A shown failure omp then dropped (an output-less turn after a context
  // rebuild, a refusal) stays too, and later turns keep their copies.
  const dropped = liveBubble("", 6, { failure: { raw: OVERLOADED, retryable: true } });
  const later = mergeTranscript([liveUser("a", 1), dropped, liveUser("b", 7), liveBubble("ok", 8)],
    adapt([userMsg("a", 1), userMsg("b", 7), replyMsg("ok", 8)]));
  assert.deepEqual(shape(later), ["user:a", "assistant:", "user:b", "assistant:ok"]);
  assert.equal(later[1], dropped);
});

check("a failure's persisted copy keeps omp's live retryable verdict", () => {
  const persisted = adapt([userMsg("again", 1), failedMsg(OVERLOADED, 2)]);
  assert.equal(persisted[1].failure.retryable, null, "omp does not persist the verdict");
  const shown = liveBubble("", 2, { failure: { ...persisted[1].failure, retryable: true } });
  const merged = mergeTranscript([liveUser("again", 1), shown], persisted);
  assert.equal(merged[1].failure.retryable, true);
  assert.equal(merged[1].failure.headline, "overloaded_error: Overloaded");
  assert.equal(persisted[1].failure.retryable, null, "the persisted copy is not mutated");
});

check("a reply's retries chip survives the merge; omp never persists it", () => {
  // Recovered after one failed attempt: the attempt is gone from get_messages,
  // its hidden bubble stays, the reply's copy keeps the chip.
  const hidden = liveBubble("", 2, { retried: true, superseded: true });
  const ok = liveBubble("ok", 5, { retries: { failed: 1, outcome: "recovered" } });
  const merged = mergeTranscript([liveUser("go", 1), hidden, ok], adapt([userMsg("go", 1), replyMsg("ok", 5)]));
  assert.deepEqual(shape(merged), ["user:go", "assistant:", "assistant:ok"]);
  assert.equal(merged[1].superseded, true);
  assert.deepEqual({ ...merged[2].retries }, { failed: 1, outcome: "recovered" });
  // Gave up: the persisted failure keeps the chip next to its own failure.
  const failedLive = liveBubble("", 2, { retries: { failed: 3, outcome: "failed" }, failure: { raw: OVERLOADED, retryable: true } });
  const gaveUp = mergeTranscript([liveUser("again", 1), failedLive], adapt([userMsg("again", 1), failedMsg(OVERLOADED, 2)]));
  assert.deepEqual({ ...gaveUp[1].retries }, { failed: 3, outcome: "failed" });
  assert.equal(gaveUp[1].failure.retryable, true);
  // Stopped in flight: the aborted copy has no failure; the row's stays on it.
  const stoppedLive = liveBubble("partial", 2, { retries: { failed: 2, outcome: "stopped" }, failure: { raw: OVERLOADED, headline: "overloaded" } });
  const aborted = { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "partial" }], timestamp: 2 };
  const stoppedCopy = adapt([userMsg("again", 1), aborted]);
  assert.equal(stoppedCopy.length, 2, "the adapter keeps an aborted message with text");
  const stopped = mergeTranscript([liveUser("again", 1), stoppedLive], stoppedCopy).at(-1);
  assert.notEqual(stopped.time, "live", "the persisted copy replaced the live bubble");
  assert.deepEqual({ ...stopped.retries }, { failed: 2, outcome: "stopped" });
  assert.equal(stopped.failure?.raw, OVERLOADED);
});

check("an attempt omp retried but kept in its context stays hidden through the merge", () => {
  // A tool-call turn that failed: omp keeps it (and a synthetic tool result) and retries.
  const kept = { ...failedMsg(OVERLOADED, 2), content: [{ type: "toolCall", id: "toolu_2", name: "bash", arguments: { command: "ls" } }] };
  const persisted = adapt([userMsg("go", 1), kept, { ...toolResultMsg(3), toolCallId: "toolu_2" }]);
  const copy = persisted.find(m => m.kind === "assistant" && m.ts === 2);
  assert.ok(copy?.failure, "the adapter shows it as the run's final failure");
  const live = liveBubble("", 2, { retried: true, superseded: true, pendingFailure: copy.failure });
  const merged = mergeTranscript([liveUser("go", 1), live, { kind: "retry", phase: "waiting" }], persisted);
  const attempt = merged.find(m => m.kind === "assistant" && m.ts === 2);
  assert.equal(attempt.superseded, true);
  assert.equal(attempt.retried, true);
  assert.equal(attempt.failure, undefined);
  assert.equal(attempt.pendingFailure.raw, copy.failure.raw);
});

check("turns the live transcript missed go in at their place in omp's order", () => {
  // Frames for the second exchange were lost while the tab was in the background.
  const persisted = adapt([userMsg("one", 1), replyMsg("a", 2), userMsg("two", 5), replyMsg("b", 6), userMsg("three", 9), replyMsg("c", 10), replyMsg("d", 12)]);
  const live = [liveUser("one", 1), liveBubble("a", 2), liveTool(), liveUser("three", 9), liveBubble("c", 10)];
  const merged = mergeTranscript(live, persisted);
  assert.deepEqual(shape(merged), ["user:one", "assistant:a", "tool", "user:two", "assistant:b", "user:three", "assistant:c", "assistant:d"]);
});

check("a follow-up stamped before the replies it waited behind keeps omp's order", () => {
  // omp stamps a follow-up when it is sent (t=10) and adds it when it is
  // delivered, after replies stamped 20 and 40.
  const persisted = adapt([userMsg("go", 1), replyMsg("first", 2), replyMsg("second", 20), replyMsg("third", 40), userMsg("and then?", 10), replyMsg("fourth", 41)]);
  // Frames for "second" and "third" were lost; the follow-up's echo and "fourth" replayed.
  const gap = mergeTranscript([liveUser("go", 1), liveBubble("first", 2), liveUser("and then?", 10), liveBubble("fourth", 41)], persisted);
  assert.deepEqual(shape(gap), ["user:go", "assistant:first", "assistant:second", "assistant:third", "user:and then?", "assistant:fourth"]);
  // Trimmed down to the follow-up: the replies before it stay trimmed.
  const trimmed = mergeTranscript([liveUser("and then?", 10), liveBubble("fourth", 41)], persisted, { trimmed: true });
  assert.deepEqual(shape(trimmed), ["user:and then?", "assistant:fourth"]);
});

check("missed turns go in before a later bubble of a message omp dropped", () => {
  // Frames for "second" and "third" were lost; a failed attempt omp then
  // retried (and dropped from its context) and the retry's reply replayed.
  const persisted = adapt([userMsg("go", 1), replyMsg("first", 2), replyMsg("second", 10), replyMsg("third", 20), replyMsg("retried", 40)]);
  const attempt = liveBubble("", 30, { pendingFailure: { raw: OVERLOADED } });
  const merged = mergeTranscript([liveUser("go", 1), liveBubble("first", 2), attempt, liveBubble("retried", 40)], persisted);
  assert.deepEqual(shape(merged), ["user:go", "assistant:first", "assistant:second", "assistant:third", "assistant:", "assistant:retried"]);
  assert.equal(merged[4], attempt);
});

check("history trimmed off the live transcript is not brought back", () => {
  const persisted = adapt([userMsg("old", 1), replyMsg("older reply", 2), userMsg("new", 50), replyMsg("reply", 51)]);
  const merged = mergeTranscript([liveTool(), liveUser("new", 50), liveBubble("reply", 51)], persisted, { trimmed: true });
  assert.deepEqual(shape(merged), ["tool", "user:new", "assistant:reply"]);
});

check("a resumed tab's history goes before a prompt sent before it arrived", () => {
  // The prompt's echo came first: it matches the last persisted message.
  const persisted = adapt([userMsg("earlier", 1), replyMsg("earlier reply", 2), userMsg("new prompt", 9)]);
  const echoed = mergeTranscript([liveUser("new prompt", 9)], persisted);
  assert.deepEqual(shape(echoed), ["user:earlier", "assistant:earlier reply", "user:new prompt"]);
  // get_messages came first: the bubble has no `ts` yet and stays last.
  const pending = { kind: "user", time: "live", text: "new prompt", images: [] };
  const early = mergeTranscript([pending], adapt([userMsg("earlier", 1), replyMsg("earlier reply", 2)]));
  assert.deepEqual(shape(early), ["user:earlier", "assistant:earlier reply", "user:new prompt"]);
  assert.equal(early[2], pending);
});

check("a tab with no live history takes the whole transcript, after its notes", () => {
  const note = liveNote("**Could not open project:** gone");
  const persisted = adapt([userMsg("hi", 1), replyMsg("hello", 2)]);
  assert.deepEqual(shape(mergeTranscript([note], persisted)), ["assistant:**Could not open project:** gone", "user:hi", "assistant:hello"]);
  assert.deepEqual(shape(mergeTranscript([], persisted)), ["user:hi", "assistant:hello"]);
});

check("entries without an omp message stay in place", () => {
  // A command omp ran locally sends no echo: its bubble has no `ts`.
  const command = { kind: "user", time: "live", text: "/jobs", images: [] };
  const note = liveNote("Auto-approved **bash** via your approval rule.");
  const persisted = adapt([userMsg("go", 3), replyMsg("answer", 4)]);
  const merged = mergeTranscript([command, note, liveUser("go", 3), liveBubble("answer", 4)], persisted);
  assert.deepEqual(shape(merged), ["user:/jobs", "assistant:Auto-approved **bash** via your approval rule.", "user:go", "assistant:answer"]);
  assert.equal(merged[0], command);
  assert.equal(merged[1], note);
});

check("a streaming entry is left out, unless its message already ended in omp", () => {
  const persisted = adapt([userMsg("go", 3)]);
  const streaming = liveBubble("partial", 4, { streaming: true });
  assert.deepEqual(shape(mergeTranscript([liveUser("go", 3), streaming], persisted)), ["user:go"]);
  // omp adds a message at its message_end, so a copy means the end frame was lost.
  const ended = adapt([userMsg("go", 3), replyMsg("full answer", 4)]);
  const merged = mergeTranscript([liveUser("go", 3), streaming], ended);
  assert.deepEqual(shape(merged), ["user:go", "assistant:full answer"]);
  assert.equal(merged[1], ended[1]);
});

console.log(`test-transcript-merge: ${passed} checks passed`);
