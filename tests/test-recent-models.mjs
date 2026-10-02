#!/usr/bin/env node
// Regression script for pickRecentModels (src/adapter.js): the model
// picker's "recently used" group (issue #11), built from omp's MRU keys
// (`provider/modelId`, newest first) and the tab's available models.
// Run: node tests/test-recent-models.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({ console });
ctx.window = ctx;
vm.runInContext(readFileSync(join(root, "src", "adapter.js"), "utf8"), ctx, { filename: "adapter.js" });
const { pickRecentModels } = ctx;

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL ${label}\n${err.message}`); process.exitCode = 1; }
}

const model = (provider, id) => ({ provider, id, name: id });
const available = [
  model("anthropic", "claude-haiku-4-5"),
  model("anthropic", "claude-opus-4-6"),
  model("anthropic", "claude-sonnet-4-6"),
  model("openai", "gpt-5.2"),
  model("openrouter", "claude-sonnet-4-6"),
];
// Array.from: adapter.js runs in its own vm realm, and deepStrictEqual
// rejects an array whose prototype is that realm's Array.prototype.
const keys = (list) => Array.from(list, (m) => `${m.provider}/${m.id}`);

check("follows the MRU order, not the available list's order", () => {
  const picked = pickRecentModels(available, ["openai/gpt-5.2", "anthropic/claude-haiku-4-5"], 5);
  assert.deepEqual(keys(picked), ["openai/gpt-5.2", "anthropic/claude-haiku-4-5"]);
});

check("the provider is part of the key: the same id elsewhere is another model", () => {
  const picked = pickRecentModels(available, ["openrouter/claude-sonnet-4-6"], 5);
  assert.deepEqual(keys(picked), ["openrouter/claude-sonnet-4-6"]);
  assert.equal(picked[0], available[4]);
});

check("models no longer available are skipped and the next ones fill the limit", () => {
  const picked = pickRecentModels(
    available,
    ["anthropic/claude-sonnet-4-5", "openai/gpt-5.2", "litellm/gone", "anthropic/claude-opus-4-6", "anthropic/claude-haiku-4-5"],
    2,
  );
  assert.deepEqual(keys(picked), ["openai/gpt-5.2", "anthropic/claude-opus-4-6"]);
});

check("a filtered model list keeps only its own recent models", () => {
  const filtered = available.filter((m) => m.id.includes("claude"));
  const picked = pickRecentModels(filtered, ["openai/gpt-5.2", "anthropic/claude-opus-4-6"], 5);
  assert.deepEqual(keys(picked), ["anthropic/claude-opus-4-6"]);
});

check("no usage history yet means no recent group", () => {
  assert.equal(pickRecentModels(available, [], 5).length, 0);
});

console.log(`recent-models: ${passed} checks passed`);
