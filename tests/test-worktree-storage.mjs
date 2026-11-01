#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const win = {};
new Function("window", readFileSync(new URL("../src/app/worktree-storage.js", import.meta.url), "utf8"))(win);
const storage = win.OMP_WORKTREE_STORAGE;

const workspace = (changes = {}) => ({
  state: "present", active: false, pinned: false, closedAtMs: 1000,
  lastUsedAtMs: 1000, excludedCaches: ["node_modules/", "target/"], ...changes,
});

test("budget accepts positive safe integers and sends the fixed lease", () => {
  assert.deepEqual(storage.validateBudget("15", "21474836480"), {
    policy: { maxWorktrees: 15, maxBytes: 21474836480, retentionDays: 30 }, error: null,
  });
  assert.equal(storage.validateBudget("1", String(Number.MAX_SAFE_INTEGER)).policy.maxBytes, Number.MAX_SAFE_INTEGER);
  for (const bad of ["", "0", "-1", "1.5", "1e3", "Infinity", String(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.equal(storage.validateBudget(bad, "1").policy, null, `count: ${bad}`);
    assert.equal(storage.validateBudget("1", bad).policy, null, `bytes: ${bad}`);
  }
});

test("byte formatting does not confuse unavailable and empty data", () => {
  assert.equal(storage.formatBytes(0), "0 B");
  assert.equal(storage.formatBytes(1023), "1023 B");
  assert.equal(storage.formatBytes(1024), "1 KiB");
  assert.equal(storage.formatBytes(1536), "1.5 KiB");
  assert.equal(storage.formatBytes(-1), "Unknown");
  assert.equal(storage.formatBytes(undefined), "Unknown");
});

test("lease display respects exact threshold, later use and protection", () => {
  const due = 1000 + 30 * storage.DAY_MS;
  assert.match(storage.expiryDescription(workspace(), due - 1), /after/i);
  assert.match(storage.expiryDescription(workspace(), due), /elapsed/i);
  assert.match(storage.expiryDescription(workspace({ lastUsedAtMs: 2000 }), due), /after/i);
  assert.match(storage.expiryDescription(workspace({ closedAtMs: due + 1000 }), due), /after/i);
  assert.match(storage.expiryDescription(workspace({ pinned: true }), due), /protected/i);
  assert.match(storage.expiryDescription(workspace({ active: true }), due), /protected/i);
  assert.match(storage.expiryDescription(workspace({ closedAtMs: null }), due), /no removal lease/i);
  assert.match(storage.expiryDescription(workspace({ state: "evicted" }), due), /restore point/i);
  assert.match(storage.expiryDescription(workspace({ lastUsedAtMs: NaN }), due), /unavailable/i);
});

test("close choices describe recovery and refuse removal while pinned or busy", () => {
  const prompt = storage.closePrompt(workspace());
  assert.equal(prompt.canRemove, true);
  assert.match(prompt.keep, /30 days/i);
  assert.match(prompt.preserve, /staged/i);
  assert.match(prompt.preserve, /ignored/i);
  assert.match(prompt.preserve, /verification fails/i);
  assert.match(prompt.caches, /node_modules\//);
  assert.match(prompt.caches, /Git-ignored/i);
  assert.match(prompt.caches, /no tracked files/i);
  assert.equal(storage.closePrompt(workspace({ pinned: true })).canRemove, false);
  assert.equal(storage.closePrompt(workspace({ busy: true })).canRemove, false);
  for (const action of ["cancel", "keep"]) {
    assert.equal(storage.canCloseWith(workspace({ pinned: true }), action), true);
    assert.equal(storage.canCloseWith(workspace({ busy: true }), action), false);
  }
  assert.equal(storage.canCloseWith(workspace(), "snapshotRemove"), true);
  assert.equal(storage.canCloseWith(workspace({ pinned: true }), "snapshotRemove"), false);
  assert.equal(storage.canCloseWith(workspace({ busy: true }), "snapshotRemove"), false);
  assert.equal(storage.canCloseWith(workspace(), "remove"), false);
});
