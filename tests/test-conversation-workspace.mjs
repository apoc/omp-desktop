#!/usr/bin/env node
// Branch-selection boundaries and checkout safety; the actual dialog is
// exercised in a browser smoke run, not against a synthetic React renderer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const windowForHelpers = {};
new Function("window", source("src/app/conversation-workspace.js"))(
  windowForHelpers,
);
const W = windowForHelpers.OMP_CONVERSATION_WORKSPACE;

const main = {
  name: "main",
  refName: "refs/heads/main",
  commit: "a".repeat(40),
  remote: false,
};
const topic = {
  name: "topic",
  refName: "refs/heads/topic",
  commit: "b".repeat(40),
  remote: false,
};
const remote = {
  name: "origin/topic",
  refName: "refs/remotes/origin/topic",
  commit: "c".repeat(40),
  remote: true,
};
const repo = (extra = {}) => ({
  path: "/repo/sub",
  repoRoot: "/repo",
  currentBranch: "main",
  head: main.commit,
  branches: [main, topic, remote],
  dirty: false,
  owners: 0,
  ...extra,
});

function plan(info, ref = W.defaultRef(info), worktree = false, ack = false) {
  const status = info && { dirty: info.dirty, owners: info.owners };
  return W.selection(info, ref, worktree, ack, status);
}

test("current local branch defaults to exact ref and full commit", () => {
  const info = repo();
  assert.equal(W.defaultRef(info), main.refName);
  assert.deepEqual(plan(info).options, {
    baseRef: main.refName,
    baseCommit: main.commit,
    worktree: false,
    acknowledgeShared: false,
  });
  assert.equal(plan(info).error, null);
  assert.equal(plan(info, topic.refName).options.baseCommit, topic.commit);
});

test("remote branches need worktrees and never masquerade as local names", () => {
  const info = repo();
  assert.match(plan(info, remote.refName).error, /worktree/i);
  assert.deepEqual(plan(info, remote.refName, true).options, {
    baseRef: remote.refName,
    baseCommit: remote.commit,
    worktree: true,
    acknowledgeShared: false,
  });
  assert.equal(plan(info, remote.refName, true).error, null);
});

test("dirty or owned current files require acknowledgement; switching is blocked", () => {
  for (const extra of [
    { dirty: true },
    { owners: 1 },
    { dirty: true, owners: 2 },
  ]) {
    const info = repo(extra);
    assert.equal(plan(info).needsAcknowledgement, true);
    assert.match(plan(info).error, /acknowledge/i);
    assert.equal(plan(info, main.refName, false, true).error, null);
    assert.equal(
      plan(info, main.refName, false, true).options.acknowledgeShared,
      true,
    );
    assert.match(
      plan(info, topic.refName, false, true).error,
      /cannot switch/i,
    );
    assert.equal(plan(info, topic.refName, true).error, null);
    assert.equal(
      plan(info, topic.refName, true, true).options.acknowledgeShared,
      false,
    );
  }
});

test("detached HEAD is a distinct current base and remains safe to share", () => {
  const info = repo({ currentBranch: null, dirty: true, head: "d".repeat(40) });
  assert.equal(W.defaultRef(info), "HEAD");
  assert.equal(W.choices(info)[0].commit, info.head);
  assert.match(plan(info).error, /acknowledge/i);
  assert.deepEqual(plan(info, "HEAD", false, true).options, {
    baseRef: "HEAD",
    baseCommit: info.head,
    worktree: false,
    acknowledgeShared: true,
  });
  assert.match(plan(info, main.refName).error, /cannot switch/i);
});

test("non-git folders have null options; unborn repositories can only work in place", () => {
  const folder = {
    path: "/folder",
    repoRoot: null,
    currentBranch: null,
    head: null,
    branches: [],
    dirty: false,
    owners: 0,
  };
  assert.deepEqual(W.choices(folder), []);
  assert.deepEqual(plan(folder, null, true, true).options, {
    baseRef: null,
    baseCommit: null,
    worktree: false,
    acknowledgeShared: false,
  });
  const owned = { ...folder, owners: 2 };
  assert.equal(plan(owned).needsAcknowledgement, true);
  assert.match(plan(owned).error, /acknowledge/i);
  assert.equal(plan(owned, null, false, true).error, null);
  assert.equal(plan(owned, null, false, true).options.acknowledgeShared, true);
  const unborn = repo({
    head: null,
    currentBranch: "main",
    branches: [],
    dirty: true,
  });
  assert.match(plan(unborn).error, /acknowledge/i);
  assert.deepEqual(plan(unborn, null, false, true).options, {
    baseRef: null,
    baseCommit: null,
    worktree: false,
    acknowledgeShared: true,
  });
  assert.match(plan(unborn, null, true).error, /commit/i);
});

test("unknown or missing commits cannot silently select a different branch", () => {
  const info = repo();
  assert.match(plan(info, "refs/heads/gone").error, /commit/i);
  assert.equal(plan(info, "refs/heads/gone").options, null);
  assert.equal(
    plan(repo({ branches: [{ ...main, commit: null }] })).options,
    null,
  );
  assert.equal(plan(null).options, null);
});

test("status must be complete before using existing files, including non-git folders", () => {
  const info = repo();
  const folder = { path: "/folder", repoRoot: null, branches: [] };
  for (const status of [
    null,
    {},
    { dirty: false },
    { owners: 0 },
    { dirty: false, owners: -1 },
    { dirty: false, owners: "0" },
    { dirty: null, owners: 0 },
    { error: "status failed" },
  ]) {
    assert.equal(W.statusKnown(status), false);
    assert.match(
      W.selection(info, main.refName, false, false, status).error,
      /status.*unknown/i,
    );
    assert.equal(
      W.selection(info, main.refName, false, false, status).options,
      null,
    );
    assert.match(
      W.selection(folder, null, false, false, status).error,
      /status.*unknown/i,
    );
    assert.equal(
      W.selection(info, main.refName, true, false, status).error,
      null,
    );
  }
  assert.equal(W.statusKnown({ dirty: false, owners: 0 }), true);
  assert.equal(
    W.selection(info, main.refName, false, false, { dirty: false, owners: 0 })
      .error,
    null,
  );
  assert.equal(
    W.selection(folder, null, false, false, { dirty: false, owners: 0 }).error,
    null,
  );
});

test("safety decisions use the asynchronous status, not metadata", () => {
  const staleDirty = repo({ dirty: true, owners: 2 });
  assert.equal(
    W.selection(staleDirty, main.refName, false, false, {
      dirty: false,
      owners: 0,
    }).error,
    null,
  );
  const staleClean = repo({ dirty: false, owners: 0 });
  assert.match(
    W.selection(staleClean, main.refName, false, false, {
      dirty: true,
      owners: 0,
    }).error,
    /acknowledge/i,
  );
  assert.match(
    W.selection(staleClean, topic.refName, false, false, {
      dirty: false,
      owners: 1,
    }).error,
    /cannot switch/i,
  );
  assert.equal(
    W.selection(staleClean, topic.refName, true, false, {
      dirty: true,
      owners: 1,
    }).error,
    null,
  );
});

test("launch selection uses stored defaults without replacing missing refs", () => {
  const info = repo({ defaults: { baseRef: topic.refName, worktree: true } });
  assert.deepEqual(W.initialSelection(info), {
    refName: topic.refName,
    worktree: true,
  });
  assert.deepEqual(W.initialSelection(repo()), {
    refName: main.refName,
    worktree: false,
  });
  const gone = repo({
    defaults: { baseRef: "refs/heads/gone", worktree: true },
  });
  assert.deepEqual(W.initialSelection(gone), {
    refName: "refs/heads/gone",
    worktree: true,
  });
  assert.match(
    W.selection(gone, "refs/heads/gone", true, false, null).error,
    /unavailable/i,
  );
  assert.equal(
    W.selection(gone, "refs/heads/gone", true, false, null).options,
    null,
  );
  const noRepo = { path: "/folder", repoRoot: null, defaults: gone.defaults };
  assert.match(
    W.selection(noRepo, gone.defaults.baseRef, false, false, {
      dirty: false,
      owners: 0,
    }).error,
    /unavailable/i,
  );
});

test("project defaults save branch refs rather than commits and can be cleared", () => {
  const info = repo({ defaults: { baseRef: topic.refName, worktree: true } });
  assert.deepEqual(W.defaultSelection(info), {
    refName: topic.refName,
    worktree: true,
  });
  assert.deepEqual(W.defaultSelection(repo()), {
    refName: null,
    worktree: false,
  });
  assert.deepEqual(W.defaultsDecision(info, topic.refName, true), {
    error: null,
    options: { baseRef: topic.refName, worktree: true },
  });
  assert.deepEqual(W.defaultsDecision(info, remote.refName, false).options, {
    baseRef: remote.refName,
    worktree: false,
  });
  assert.deepEqual(W.defaultsDecision(info, null, true).options, {
    baseRef: null,
    worktree: false,
  });
  assert.deepEqual(
    W.defaultsDecision({ repoRoot: null }, null, false).options,
    { baseRef: null, worktree: false },
  );
  assert.match(
    W.defaultsDecision(info, "refs/heads/gone", true).error,
    /unavailable/i,
  );
  assert.equal(W.defaultsDecision(info, "refs/heads/gone", true).options, null);
  assert.equal(W.defaultsDecision(null, null, false).options, null);
});

test("detached HEAD is a one-conversation base, never a project default", () => {
  const info = repo({ currentBranch: null, head: "d".repeat(40) });
  assert.deepEqual(W.initialSelection(info), {
    refName: "HEAD",
    worktree: false,
  });
  assert.match(
    W.defaultsDecision(info, "HEAD", true).error,
    /single conversation/i,
  );
  assert.equal(W.defaultsDecision(info, "HEAD", true).options, null);
  assert.equal(W.selection(info, "HEAD", true, false, null).error, null);
});
