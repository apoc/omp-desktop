#!/usr/bin/env node
// Behavioral regression tests for the shared PR presentation model.
// Run: node tests/test-pr-status.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
// eslint-disable-next-line no-new-func
new Function(
  "window",
  readFileSync(join(root, "src/app/pr-status.js"), "utf8"),
)(win);
const P = win.OMP_PR_STATUS;

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

const snapshot = (extra = {}) => ({
  state: "OPEN",
  isDraft: false,
  checksState: "none",
  number: 42,
  url: "https://github.com/Owner/Repo/pull/42",
  repository: "Owner/Repo",
  failedChecks: [],
  threads: [],
  ...extra,
});
const status = (extra = {}, fields = {}) => ({
  snapshot: snapshot(extra),
  loading: false,
  discoveryError: null,
  ...fields,
});
const thread = (id) => ({ id, updatedAt: "2026-10-27T00:00:00Z" });
const failedCheck = (id) => ({ id, name: id });

check("no known PR, including an in-flight lookup, has no indicator", () => {
  assert.equal(P.present(null), null);
  assert.equal(
    P.present({ snapshot: null, loading: false, discoveryError: null }),
    null,
  );
  assert.equal(
    P.present({ snapshot: null, loading: true, discoveryError: null }),
    null,
  );
  assert.equal(P.aggregate([]), null);
  assert.equal(P.aggregate([null, { snapshot: null, loading: true }]), null);
});

check("an open PR reports its lifecycle and neutral no-check state", () => {
  assert.deepEqual(P.present(status()), {
    glyph: "open",
    tone: "open",
    label: "Open",
    description: "Open pull request #42; No checks",
    checksState: "none",
    failedCount: 0,
    threadCount: 0,
    stale: false,
    prCount: 1,
  });
});

check("draft and ready PRs retain different shapes when CI fails", () => {
  for (const [isDraft, glyph, label] of [
    [false, "open", "Open"],
    [true, "draft", "Draft"],
  ]) {
    const model = P.present(
      status({
        isDraft,
        checksState: "failure",
        failedChecks: [failedCheck("c1")],
      }),
    );
    assert.equal(model.glyph, glyph);
    assert.equal(model.tone, "failure");
    assert.equal(model.label, label);
    assert.equal(model.failedCount, 1);
    assert.match(model.description, /1 failed check/);
    assert.doesNotMatch(model.description, /Checks passed/);
  }
});

check("pending, absent, unknown and successful checks remain distinct", () => {
  const cases = [
    ["pending", /Checks pending/],
    ["none", /No checks/],
    ["unknown", /Check results unknown/],
    ["success", /Checks passed/],
  ];
  for (const [checksState, description] of cases) {
    const model = P.present(status({ checksState }));
    assert.equal(model.checksState, checksState);
    assert.match(model.description, description);
    if (checksState !== "success")
      assert.doesNotMatch(model.description, /Checks passed/);
    assert.equal(model.tone, "open");
  }
});

check(
  "a failure state remains visible even when no failed-check details are available",
  () => {
    const model = P.present(status({ checksState: "failure" }));
    assert.equal(model.tone, "failure");
    assert.equal(model.failedCount, 0);
    assert.match(model.description, /Checks failed/);
  },
);

check("only unique unresolved, current review threads are actionable", () => {
  const threads = [
    thread("one"),
    thread("one"),
    thread("two"),
    { ...thread("resolved"), isResolved: true },
    { ...thread("outdated"), isOutdated: true },
    { ...thread("also-resolved"), resolved: true },
    { ...thread("also-outdated"), outdated: true },
    { id: "" },
    null,
  ];
  const model = P.present(status({ threads }));
  assert.equal(model.threadCount, 2);
  assert.match(model.description, /2 unresolved review threads/);
  assert.doesNotMatch(P.present(status()).description, /review thread/);
  assert.match(
    P.present(status({ threads: [thread("one")] })).description,
    /1 unresolved review thread(?:;|$)/,
  );
});

check(
  "terminal lifecycle takes precedence over historical failures and hides review attention",
  () => {
    for (const [state, glyph, label] of [
      ["MERGED", "merged", "Merged"],
      ["CLOSED", "closed", "Closed"],
    ]) {
      const model = P.present(
        status({
          state,
          isDraft: true,
          checksState: "failure",
          failedChecks: [failedCheck("c1")],
          threads: [thread("t1")],
        }),
      );
      assert.equal(model.glyph, glyph);
      assert.equal(model.tone, glyph);
      assert.equal(model.label, label);
      assert.equal(model.checksState, "failure");
      assert.equal(model.failedCount, 1);
      assert.equal(model.threadCount, 0);
      assert.match(model.description, /Historical CI: 1 failed check/);
      assert.doesNotMatch(model.description, /unresolved review thread/);
    }
  },
);

check(
  "a failed refresh explicitly labels the retained snapshot as stale",
  () => {
    const model = P.present(
      status({ checksState: "success" }, { discoveryError: "GitHub offline" }),
    );
    assert.equal(model.glyph, "open");
    assert.equal(model.stale, true);
    assert.match(model.description, /Open pull request #42/);
    assert.match(model.description, /stale/i);
    assert.match(model.description, /GitHub offline/);
  },
);

check("an error without a snapshot has its own error indicator", () => {
  const model = P.present({
    snapshot: null,
    loading: false,
    discoveryError: "Branch unavailable",
  });
  assert.equal(model.glyph, "error");
  assert.equal(model.tone, "error");
  assert.equal(model.prCount, 0);
  assert.equal(model.stale, true);
  assert.equal(model.checksState, "unknown");
  assert.match(model.description, /unavailable/i);
  assert.match(model.description, /Branch unavailable/);
});

check("a refresh in progress does not make a known snapshot stale", () => {
  const model = P.present(
    status({ checksState: "pending" }, { loading: true }),
  );
  assert.equal(model.stale, false);
  assert.equal(model.checksState, "pending");
});

check(
  "duplicate repository and PR identities share check and thread counts",
  () => {
    const first = status({
      repository: "Owner/Repo",
      checksState: "failure",
      failedChecks: [failedCheck("a"), failedCheck("a"), failedCheck("b")],
      threads: [thread("x"), thread("y")],
    });
    const second = status({
      repository: "owner/repo",
      checksState: "failure",
      failedChecks: [failedCheck("a"), failedCheck("b")],
      threads: [thread("x"), thread("y"), thread("y")],
    });
    const model = P.aggregate([first, second]);
    assert.equal(model.prCount, 1);
    assert.equal(model.glyph, "open");
    assert.equal(model.tone, "failure");
    assert.equal(model.failedCount, 2);
    assert.equal(model.threadCount, 2);
    assert.deepEqual(P.aggregate([second, first]), model);
  },
);

check(
  "concurrent draft and ready reports preserve failed CI and draft shape",
  () => {
    const ready = status({
      checksState: "failure",
      failedChecks: [failedCheck("failed")],
      threads: [thread("review")],
    });
    const draft = status({ isDraft: true, checksState: "pending" });
    const model = P.aggregate([ready, draft]);
    assert.equal(model.prCount, 1);
    assert.equal(model.glyph, "draft");
    assert.equal(model.tone, "failure");
    assert.equal(model.checksState, "failure");
    assert.equal(model.failedCount, 1);
    assert.equal(model.threadCount, 1);
    assert.deepEqual(P.aggregate([draft, ready]), model);
  },
);

check(
  "fresh duplicates supersede stale feedback without hiding the stale error",
  () => {
    const stale = status(
      {
        checksState: "failure",
        failedChecks: [failedCheck("old")],
        threads: [thread("old")],
      },
      { discoveryError: "Refresh failed" },
    );
    const fresh = status({
      checksState: "success",
      threads: [thread("current")],
    });
    const model = P.aggregate([stale, fresh]);
    assert.equal(model.prCount, 1);
    assert.equal(model.tone, "open");
    assert.equal(model.checksState, "success");
    assert.equal(model.failedCount, 0);
    assert.equal(model.threadCount, 1);
    assert.equal(model.stale, true);
    assert.match(model.description, /Refresh failed/);
  },
);

check("different repositories or PR numbers produce a mixed group", () => {
  const ready = status({ number: 42, repository: "owner/repo" });
  const draft = status({ number: 43, repository: "owner/repo", isDraft: true });
  const otherRepo = status({
    number: 42,
    repository: "owner/other",
    state: "MERGED",
  });
  const model = P.aggregate([draft, ready, otherRepo]);
  assert.equal(model.prCount, 3);
  assert.equal(model.glyph, "mixed");
  assert.equal(model.tone, "mixed");
  assert.equal(model.label, "Multiple pull requests");
  assert.equal(model.checksState, "none");
  assert.match(model.description, /Draft pull request #43/);
  assert.match(model.description, /Merged pull request #42/);
  assert.match(model.description, /owner\/other/);
  assert.deepEqual(P.aggregate([otherRepo, ready, draft]), model);
});

check("a settled no-PR member makes a single PR group mixed", () => {
  const merged = status({
    state: "MERGED",
    checksState: "failure",
    failedChecks: [failedCheck("old")],
  });
  const noPr = { snapshot: null, loading: false, discoveryError: null };
  const model = P.aggregate([merged, noPr]);
  assert.equal(model.prCount, 1);
  assert.equal(model.glyph, "mixed");
  assert.equal(model.tone, "mixed");
  assert.equal(model.label, "Mixed pull request status");
  assert.equal(model.checksState, null);
  assert.equal(model.failedCount, 0);
  assert.match(model.description, /Merged pull request #42/);
  assert.match(model.description, /1 conversation without a pull request/);
  assert.deepEqual(P.aggregate([noPr, merged]), model);

  const draft = status({
    isDraft: true,
    checksState: "failure",
    failedChecks: [failedCheck("failed")],
  });
  const draftGroup = P.aggregate([draft, noPr, noPr]);
  assert.equal(draftGroup.glyph, "mixed");
  assert.equal(draftGroup.tone, "failure");
  assert.equal(draftGroup.prCount, 1);
  assert.equal(draftGroup.failedCount, 1);
  assert.match(
    draftGroup.description,
    /2 conversations without a pull request/,
  );
});

check(
  "unsettled, absent, loading and errored members do not imply no PR",
  () => {
    const merged = status({ state: "MERGED" });
    const unresolved = [
      null,
      undefined,
      {},
      { loading: false },
      { snapshot: null },
      { snapshot: null, loading: true, discoveryError: null },
    ];
    assert.deepEqual(P.aggregate([merged, ...unresolved]), P.present(merged));
    const errored = P.aggregate([
      merged,
      { snapshot: null, loading: false, discoveryError: "Offline" },
    ]);
    assert.equal(errored.glyph, "merged");
    assert.equal(errored.stale, true);
    assert.doesNotMatch(errored.description, /without a pull request/);
  },
);

check(
  "mixed attention prioritizes failed open CI, then unresolved threads",
  () => {
    const failed = status({
      number: 1,
      checksState: "failure",
      failedChecks: [failedCheck("f")],
      threads: [thread("a")],
    });
    const comments = status({
      number: 2,
      checksState: "pending",
      threads: [thread("b"), thread("c")],
    });
    const merged = status({
      number: 3,
      state: "MERGED",
      checksState: "failure",
      failedChecks: [failedCheck("historical")],
      threads: [thread("old")],
    });
    const model = P.aggregate([merged, comments, failed]);
    assert.equal(model.glyph, "mixed");
    assert.equal(model.tone, "failure");
    assert.equal(model.checksState, "failure");
    assert.equal(model.failedCount, 1);
    assert.equal(model.threadCount, 3);
    assert.match(model.description, /Checks pending/);
    assert.match(model.description, /Historical CI: 1 failed check/);
    const commentsOnly = P.aggregate([comments, merged]);
    assert.equal(commentsOnly.glyph, "mixed");
    assert.equal(commentsOnly.tone, "mixed");
    assert.equal(commentsOnly.checksState, "pending");
    assert.equal(commentsOnly.failedCount, 0);
    assert.equal(commentsOnly.threadCount, 2);
  },
);

check("thread identities are not multiplied across distinct PR reports", () => {
  const model = P.aggregate([
    status({ number: 1, threads: [thread("shared"), thread("one")] }),
    status({ number: 2, threads: [thread("shared"), thread("two")] }),
  ]);
  assert.equal(model.prCount, 2);
  assert.equal(model.threadCount, 3);
});

check("terminal-only mixed groups never suggest actionable failed CI", () => {
  const model = P.aggregate([
    status({
      number: 1,
      state: "MERGED",
      checksState: "failure",
      failedChecks: [failedCheck("old")],
      threads: [thread("old")],
    }),
    status({
      number: 2,
      state: "CLOSED",
      checksState: "success",
      threads: [thread("older")],
    }),
  ]);
  assert.equal(model.glyph, "mixed");
  assert.equal(model.tone, "mixed");
  assert.equal(model.checksState, null);
  assert.equal(model.failedCount, 0);
  assert.equal(model.threadCount, 0);
  assert.match(model.description, /Historical CI/);
});

check("mixed groups include errors from tabs without a snapshot", () => {
  const model = P.aggregate([
    status({ number: 1 }),
    status({ number: 2 }),
    { snapshot: null, discoveryError: "Network unavailable" },
  ]);
  assert.equal(model.prCount, 2);
  assert.equal(model.glyph, "mixed");
  assert.equal(model.stale, true);
  assert.match(model.description, /stale/i);
  assert.match(model.description, /Network unavailable/);
});

check("presentation does not mutate status snapshots", () => {
  const input = [
    status({
      checksState: "failure",
      failedChecks: [failedCheck("c")],
      threads: [thread("t")],
    }),
  ];
  const before = structuredClone(input);
  P.present(input[0]);
  P.aggregate(input);
  assert.deepEqual(input, before);
});

console.log(`pr-status: ${passed} checks passed`);
