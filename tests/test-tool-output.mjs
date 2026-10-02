#!/usr/bin/env node
// Regression script for the bash branch of finalizeToolCard (src/adapter.js):
// the finished card's display lines and the text its copy button puts on
// the clipboard (issue #33). The card shows omp's result text as streamed,
// notices included; the copy text drops the model-facing notices omp
// appends (exit code, wall time, artifact footer).
// Run: node tests/test-tool-output.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({ console });
ctx.window = ctx;
vm.runInContext(readFileSync(join(root, "src", "adapter.js"), "utf8"), ctx, { filename: "adapter.js" });
const { finalizeToolCard } = ctx;

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL ${label}\n${err.message}`); process.exitCode = 1; }
}

const card = { kind: "tool", tool: "bash", status: "running", output: [{ line: "streamed", color: "fg-3" }] };
const finish = (text, details = {}, extraContent = []) =>
  finalizeToolCard(card, { result: { content: [{ type: "text", text }, ...extraContent], details } });
const shown = (c) => c.output.map((l) => l.line).join("\n");

// Result texts below are shaped like real omp 18 frames, e.g.
// "fast-one\n\n\nWall time: 0.04 seconds" with wallTimeMs 39.22144800000024.
check("the wall-time notice stays on the card but not in the copy text", () => {
  const c = finish("alpha\n\tbeta <x>\n\n\nWall time: 0.04 seconds", { wallTimeMs: 39.22144800000024 });
  assert.equal(c.outputText, "alpha\n\tbeta <x>");
  assert.equal(shown(c), "alpha\n\tbeta <x>\n\n\nWall time: 0.04 seconds");
});

check("a failed command keeps its exit code on the card, not in the copy text", () => {
  const c = finish("boom\n\n\nWall time: 1.50 seconds\n\nCommand exited with code 2", { wallTimeMs: 1500, exitCode: 2 });
  assert.equal(c.outputText, "boom");
  assert.match(shown(c), /Command exited with code 2$/);
});

check("the raw-output artifact footer is dropped from the copy text", () => {
  const c = finish("big\n\nWall time: 3.00 seconds\n[raw output: artifact://17]", { wallTimeMs: 3000 });
  assert.equal(c.outputText, "big");
});

check("an auto-backgrounded command's job note is dropped from the copy text", () => {
  const c = finish("building…\nstep 1\n\nBackgrounded as job bg-7; its output is injected into the conversation as a follow-up the moment it finishes.",
    { async: { state: "running", jobId: "bg-7", type: "bash" } });
  assert.equal(c.outputText, "building…\nstep 1");
});

check("output that merely looks like a notice is kept", () => {
  const c = finish("Wall time: 9.99 seconds\nCommand exited with code 5\n\nWall time: 0.01 seconds", { wallTimeMs: 10 });
  assert.equal(c.outputText, "Wall time: 9.99 seconds\nCommand exited with code 5");
});

check("a silent command offers nothing to copy", () => {
  const c = finish("(no output)\n\nWall time: 0.00 seconds", { wallTimeMs: 0.4 });
  assert.equal(c.outputText, undefined);
});

check("an empty result keeps the streamed lines", () => {
  const c = finish("");
  assert.equal(c.outputText, undefined);
  assert.equal(shown(c), "streamed");
});

check("the card shows the last 20 lines; the copy text keeps them all", () => {
  const lines = Array.from({ length: 35 }, (_, i) => `line ${i + 1}`);
  const c = finish(lines.join("\n") + "\n\n\nWall time: 0.04 seconds", { wallTimeMs: 40 });
  assert.equal(c.outputText, lines.join("\n"));
  assert.equal(shown(c), [...lines.slice(-17), "", "", "Wall time: 0.04 seconds"].join("\n"));
});

check("non-text result blocks are ignored", () => {
  const c = finish("png written", {}, [{ type: "image", data: "AAAA", mimeType: "image/png" }]);
  assert.equal(c.outputText, "png written");
});

console.log(`tool-output: ${passed} checks passed`);
