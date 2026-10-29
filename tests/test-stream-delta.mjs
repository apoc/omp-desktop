#!/usr/bin/env node
// Regression script for src/app/stream-delta.js — the streaming assistant
// message rebuilt from omp's `messageUpdates: "delta"` frames: blocks opened
// and grown in place, final text and signature on the end events, a restart,
// the backend copy a dropped replay seeds from, and which events a render
// skips. src-tauri/src/agent/inflight.rs applies the same projection.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
// eslint-disable-next-line no-new-func
new Function("window", readFileSync(join(root, "src/app/stream-delta.js"), "utf8"))(win);
const D = win.OMP_STREAM_DELTA;

let passed = 0;
function check(label, fn) {
  try { fn(); } catch (err) { console.error(`FAILED: ${label}`); throw err; }
  passed++;
}
/** Apply `events` to `blocks`; the per-event "shown content changed" flags. */
const run = (blocks, events) => events.map(ev => D.applyEvent(blocks, ev));

check("thinking, text and a tool call rebuild exactly from their deltas", () => {
  const blocks = [];
  const shown = run(blocks, [
    { type: "thinking_start", contentIndex: 0, block: { type: "thinking", thinking: "" } },
    { type: "thinking_delta", contentIndex: 0, delta: "Let me " },
    { type: "thinking_delta", contentIndex: 0, delta: "look" },
    { type: "thinking_end", contentIndex: 0, content: "Let me look.", block: { type: "thinking", thinkingSignature: "sig" } },
    { type: "text_start", contentIndex: 1, block: { type: "text", text: "" } },
    { type: "text_delta", contentIndex: 1, delta: "Hel" },
    { type: "text_delta", contentIndex: 1, delta: "lo" },
    { type: "text_end", contentIndex: 1, content: "Hello", block: { type: "text" } },
    { type: "toolcall_start", contentIndex: 2, block: { type: "toolCall", id: "t1", name: "read", arguments: {} } },
    { type: "toolcall_delta", contentIndex: 2, delta: "{\"path\":" },
    { type: "toolcall_end", contentIndex: 2, toolCall: { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.js" } } },
    { type: "done", reason: "toolUse", message: {} },
  ]);
  assert.deepEqual(blocks, [
    { type: "thinking", thinking: "Let me look.", thinkingSignature: "sig" },
    { type: "text", text: "Hello" },
    { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.js" } },
  ]);
  // Tool-call streaming and the terminal event never change what the bubble shows.
  assert.deepEqual(shown, [true, true, true, true, true, true, true, true, false, false, false, false]);
});

check("the end event's text wins over what the deltas built (a lost delta)", () => {
  const blocks = [];
  run(blocks, [
    { type: "text_start", contentIndex: 0, block: { type: "text", text: "" } },
    { type: "text_delta", contentIndex: 0, delta: "Hel" },
    { type: "text_end", contentIndex: 0, content: "Hello" },
  ]);
  assert.deepEqual(blocks, [{ type: "text", text: "Hello" }]);
});

check("a delta whose start was lost opens the block instead of dropping text", () => {
  const blocks = [];
  run(blocks, [{ type: "text_delta", contentIndex: 0, delta: "late" }]);
  assert.deepEqual(blocks, [{ type: "text", text: "late" }]);
});

check("a restart replaces the message whole", () => {
  const blocks = [{ type: "text", text: "stale" }];
  const [shown] = run(blocks, [{ type: "start", message: { role: "assistant", content: [{ type: "text", text: "fresh" }] } }]);
  assert.equal(shown, true);
  assert.deepEqual(blocks, [{ type: "text", text: "fresh" }]);
});

check("malformed events change nothing", () => {
  const blocks = [{ type: "text", text: "x" }];
  const shown = run(blocks, [
    null,
    {},
    { type: "text_delta", delta: "no index" },
    { type: "text_delta", contentIndex: 0, delta: 5 },
    { type: "text_start", contentIndex: "0", block: { type: "text", text: "" } },
  ]);
  assert.deepEqual(blocks, [{ type: "text", text: "x" }]);
  assert.deepEqual(shown, [false, false, false, false, false]);
});

check("seed copies the backend's message, so streaming on never changes it", () => {
  const message = { role: "assistant", content: [{ type: "text", text: "so far" }] };
  const blocks = D.seed(message);
  run(blocks, [{ type: "text_delta", contentIndex: 0, delta: " and more" }]);
  assert.equal(blocks[0].text, "so far and more");
  assert.equal(message.content[0].text, "so far");
  assert.deepEqual(D.seed(undefined), []);
  assert.deepEqual(D.seed({ content: "not blocks" }), []);
});

check("view: the last non-blank thinking and the non-empty text blocks", () => {
  assert.deepEqual(D.view([]), { thought: null, blocks: [{ type: "text", text: "" }] });
  assert.deepEqual(
    D.view([
      { type: "thinking", thinking: "first" },
      { type: "text", text: "a" },
      undefined,
      { type: "thinking", thinking: "  " },
      { type: "toolCall", id: "t", name: "x", arguments: {} },
      { type: "text", text: "" },
      { type: "text", text: "b" },
    ]),
    { thought: "first", blocks: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
  );
});

console.log(`test-stream-delta: ${passed} checks passed`);
