#!/usr/bin/env node
// Behavioral regression tests for the shared PR presentation model.
// Run: node tests/test-pr-status.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

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
    number: 42,
    repository: "Owner/Repo",
    lifecycleLabel: "Open",
    lifecycleDescription: "Open pull request #42 (Owner/Repo)",
    checksDescription: "No checks",
    reviewDescription: "0 unresolved review threads",
    refreshDescription: null,
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
    assert.match(model.lifecycleDescription, /Last known.*Open pull request #42/);
    assert.match(model.refreshDescription, /GitHub offline/);
    assert.match(model.description, /stale/i);
    assert.match(model.description, /GitHub offline/);
  },
);

check("an error without a known snapshot has no PR indicator", () => {
  const unavailable = {
    snapshot: null,
    loading: false,
    discoveryError: "Branch unavailable",
  };
  assert.equal(P.present(unavailable), null);
  assert.equal(P.aggregate([unavailable, { snapshot: null, discoveryError: "Offline" }]), null);
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
  assert.equal(model.number, null);
  assert.equal(model.lifecycleLabel, "Multiple pull requests");
  assert.match(model.lifecycleDescription, /Multiple pull requests \(3\)/);
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

// Render the real JSX with a small hook stand-in. The tree and event handlers,
// rather than source text, are the contract under test.
const Babel = createRequire(import.meta.url)(join(root, "src/babel.min.js"));
const uiCode = ["pr-status.jsx", "pr-automation-card.jsx", "tab-group-chip.jsx"].map((file) =>
  Babel.transform(readFileSync(join(root, "src/design", file), "utf8"), { presets: ["react"] }).code,
);
function uiHarness() {
  const slots = [];
  let cursor = 0;
  const React = {
    Fragment: "fragment",
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    isValidElement: (value) => !!value && typeof value === "object" && "type" in value,
    cloneElement: (value, props) => ({ ...value, props: { ...value.props, ...props } }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (next) => {
        slots[index] = typeof next === "function" ? next(slots[index]) : next;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useId: () => "status-tooltip",
    useEffect: () => {},
  };
  const window = {
    OMP_PR_STATUS: P,
    OMP_PROJECT_NAV: { projectPath: (tab) => tab.workspace?.projectPath || tab.path },
    Icon: () => null,
    usePopoverDismiss: () => {},
    innerWidth: 1000,
    innerHeight: 700,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const document = { body: {}, addEventListener: () => {}, removeEventListener: () => {} };
  const ReactDOM = { createPortal: (element) => element };
  for (const code of uiCode) {
    runInNewContext(code, { window, document, React, ReactDOM, setTimeout, clearTimeout });
  }
  const render = (component, props) => {
    cursor = 0;
    const tree = component(props);
    for (const element of nodes(tree)) {
      if (element.props.ref) {
        element.props.ref.current = {
          getBoundingClientRect: () => ({ left: 20, right: 40, top: 30, bottom: 50 }),
        };
      }
    }
    return tree;
  };
  return { window, render };
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object" || !tree.type) return [];
  return [tree, ...nodes(tree.children)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  return tree && typeof tree === "object" ? text(tree.children) : "";
}
function byClass(tree, name) {
  return nodes(tree).find((element) => element.props.className?.split(" ").includes(name));
}
const cardStatus = (fields = {}) => ({
  snapshot: null, localChanges: null, localError: null, loading: false,
  discoveryError: null, enabled: false, canEnable: false, status: "", ...fields,
});

check("identity and feedback modes render separate accessible semantic details", () => {
  const h = uiHarness();
  const model = P.present(status({
    checksState: "pending", failedChecks: [failedCheck("f")], threads: [thread("one")],
  }, { discoveryError: "Network down" }));
  const icon = h.render(h.window.PrStatus, { model, mode: "icon" });
  assert.match(text(icon), /#42/);
  assert.equal(nodes(icon).filter((node) => node.type === h.window.StatusDetail).length, 1);
  const badges = h.render(h.window.PrStatus, { model, mode: "badges" });
  assert.doesNotMatch(text(badges), /#42/);
  assert.match(text(badges), /Checks pending/);
  assert.match(text(badges), /×1/);
  assert.doesNotMatch(text(badges), /…/);
  const details = nodes(badges).filter((node) => node.type === h.window.StatusDetail);
  assert.equal(details.length, 3);
  assert.ok(details.some((node) => /failed check/.test(node.props.text)));
  assert.ok(details.some((node) => /Checks pending/.test(node.props.text)));
  assert.ok(details.some((node) => /1 unresolved review thread/.test(node.props.text)));
  assert.equal(details.filter((node) => /Network down/.test(node.props.text)).length, 1);
  for (const checksState of ["pending", "success", "none", "unknown"]) {
    const conflicting = P.present(status({ checksState, failedChecks: [failedCheck("f")] }));
    const rendered = h.render(h.window.PrStatus, { model: conflicting, mode: "badges" });
    const checks = nodes(rendered).filter((node) =>
      node.type === h.window.StatusDetail && node.props.className?.includes("pr-status-ci"));
    assert.equal(checks.length, 1);
    assert.match(checks[0].props.className, /failure/);
    assert.equal(checks[0].props.text, conflicting.checksDescription);
  }
  const pending = h.render(h.window.PrStatus, {
    model: P.present(status({ checksState: "pending" })), mode: "badges",
  });
  assert.match(text(pending), /◷/);
  assert.match(text(pending), /Checks pending/);
  const mixed = P.aggregate([status({ number: 1 }), status({ number: 2 })]);
  assert.match(text(h.render(h.window.PrStatus, { model: mixed })), /2 PRs/);
  assert.equal(h.render(h.window.PrStatus, { status: { snapshot: null, discoveryError: "Offline" } }), null);
});

check("review detail preserves its button action and terminal PRs hide attention", () => {
  const h = uiHarness();
  let opened = 0;
  const open = P.present(status({ checksState: "failure", threads: [thread("one")] }));
  const tree = h.render(h.window.PrStatus, { model: open, mode: "badges", onReview: () => opened++ });
  const review = byClass(tree, "pr-status-review");
  assert.equal(review.type, "button");
  assert.match(review.props["aria-label"], /1 unresolved review thread; open review discussion/);
  review.props.onClick();
  assert.equal(opened, 1);
  let action = h.render(h.window.StatusDetail, { text: "Open review discussion", children: review });
  assert.equal(action.props.tabIndex, undefined);
  action.props.onFocus();
  action = h.render(h.window.StatusDetail, { text: "Open review discussion", children: review });
  assert.equal(byClass(action, "pr-status-review").props["aria-describedby"], "status-tooltip");
  byClass(action, "pr-status-review").props.onClick();
  assert.equal(opened, 2);
  for (const state of ["MERGED", "CLOSED"]) {
    const terminal = P.present(status({ state, checksState: "failure", threads: [thread("old")] }));
    const rendered = h.render(h.window.PrStatus, { model: terminal, mode: "badges", onReview: () => opened++ });
    assert.equal(nodes(rendered).filter((node) => node.type === h.window.StatusDetail).length, 0);
  }
});

check("status details show a portal on focus and isolate navigation gestures", () => {
  const h = uiHarness();
  const props = { text: "Full branch name", className: "branch", children: "main" };
  let detail = h.render(h.window.StatusDetail, props);
  assert.equal(detail.props.tabIndex, 0);
  assert.equal(detail.props["data-no-reorder"], true);
  assert.equal(detail.props.title, "");
  let stopped = 0, prevented = 0;
  const event = { stopPropagation: () => stopped++, preventDefault: () => prevented++, key: "Enter" };
  detail.props.onPointerDown(event);
  detail.props.onMouseDown(event);
  detail.props.onAuxClick(event);
  detail.props.onClick(event);
  detail.props.onDoubleClick(event);
  detail.props.onKeyDown(event);
  assert.equal(stopped, 6);
  assert.equal(prevented, 1);
  detail.props.onFocus();
  detail = h.render(h.window.StatusDetail, props);
  const tooltip = nodes(detail).find((node) => node.props.role === "tooltip");
  assert.equal(text(tooltip), "Full branch name");
  assert.equal(detail.props["aria-describedby"], tooltip.props.id);
  detail.props.onBlur();
  detail = h.render(h.window.StatusDetail, props);
  assert.equal(nodes(detail).some((node) => node.props.role === "tooltip"), false);
  detail.props.onMouseEnter();
  detail = h.render(h.window.StatusDetail, props);
  assert.equal(text(nodes(detail).find((node) => node.props.role === "tooltip")), "Full branch name");
  detail.props.onKeyDown({ key: "Escape", stopPropagation: () => stopped++ });
  detail = h.render(h.window.StatusDetail, props);
  assert.equal(nodes(detail).some((node) => node.props.role === "tooltip"), false);
});

check("worktree identity names the actual checkout without a branch icon", () => {
  const h = uiHarness();
  const tab = {
    path: "/worktrees/task", branch: "feature/task",
    workspace: { worktree: true, projectPath: "/projects/app", baseRef: "main" },
  };
  const detail = h.render(h.window.WorktreeIndicator, { tab });
  assert.equal(detail.type, h.window.StatusDetail);
  assert.equal(text(detail), "Worktree");
  assert.match(detail.props.text, /Source project: \/projects\/app/);
  assert.match(detail.props.text, /Working folder: \/worktrees\/task/);
  assert.match(detail.props.text, /Branch: feature\/task/);
  assert.match(detail.props.text, /Selected base: main/);
  assert.equal(nodes(detail).some((node) => node.type === h.window.Icon), false);
  assert.equal(h.render(h.window.WorktreeIndicator, { tab: { path: "/projects/app" } }), null);
});

check("contextual card stays hidden without known changes or a PR", () => {
  for (const fields of [
    {},
    { loading: true },
    { discoveryError: "No upstream", localError: "Read failed" },
    { localChanges: { changed: 0 } },
  ]) {
    const h = uiHarness();
    assert.equal(h.render(h.window.PrAutomationCard, {
      automation: cardStatus(fields), available: false, bridge: {},
    }), null);
  }
});

check("local-only card opens Git changes without PR or automation warnings", () => {
  const h = uiHarness();
  let opened = 0;
  const tree = h.render(h.window.PrAutomationCard, {
    automation: cardStatus({
      localChanges: { changed: 2 }, discoveryError: "No upstream", error: "Auto-fix unavailable",
    }),
    bridge: {}, onOpenChanges: () => opened++,
  });
  assert.match(text(tree), /2 changed files/);
  assert.doesNotMatch(text(tree), /PR actions|Auto-fix|No upstream/);
  assert.equal(nodes(tree).some((node) => node.type === h.window.PrStatus), false);
  byClass(tree, "pr-changes-local-link").props.onClick();
  assert.equal(opened, 1);
  const truncated = h.render(h.window.PrAutomationCard, {
    automation: cardStatus({ localChanges: { changed: 100, truncated: true } }), bridge: {},
  });
  assert.match(text(truncated), /At least 100 changed files/);
});

check("known PRs remain visible with separate last-known refresh problems", () => {
  const h = uiHarness();
  const tree = h.render(h.window.PrAutomationCard, {
    automation: cardStatus({
      snapshot: snapshot({ title: "Change", additions: 2, deletions: 1 }),
      localChanges: { changed: 1 }, discoveryError: "GitHub offline", localError: "Git offline",
    }), bridge: {},
  });
  assert.match(text(tree), /Change/);
  assert.match(text(tree), /Last known · Open/);
  assert.match(text(tree), /Last known · 1 changed file/);
  assert.match(text(tree), /PR refresh failed: GitHub offline/);
  assert.match(text(tree), /Local changes refresh failed: Git offline/);
  assert.equal(nodes(tree).filter((node) => node.type === h.window.PrStatus).length, 2);
  const clean = h.render(h.window.PrAutomationCard, {
    automation: cardStatus({ snapshot: snapshot({ title: "Clean PR" }) }), bridge: {},
  });
  assert.match(text(clean), /Clean PR/);
  assert.doesNotMatch(text(clean), /changed files?/);
});

check("PR actions gate Auto-fix by current open PR enablement", () => {
  for (const [state, canEnable, available, expected] of [
    ["OPEN", true, true, false],
    ["OPEN", false, true, true],
    ["OPEN", true, false, true],
    ["MERGED", true, true, null],
    ["CLOSED", true, true, null],
  ]) {
    const h = uiHarness();
    let toggled = 0;
    const props = {
      automation: cardStatus({
        snapshot: snapshot({ state, title: "PR" }), canEnable, toggle: () => toggled++,
      }), available, bridge: {},
    };
    let tree = h.render(h.window.PrAutomationCard, props);
    byClass(tree, "pr-changes-more").props.onClick();
    tree = h.render(h.window.PrAutomationCard, props);
    const control = byClass(tree, "pr-changes-autofix");
    if (expected === null) {
      assert.equal(control, undefined);
      assert.doesNotMatch(text(tree), /Automation|Auto-fix/);
    } else {
      assert.equal(control.props.disabled, expected);
      if (!expected) {
        control.props.onClick();
        assert.equal(toggled, 1);
      }
    }
  }
});

console.log(`pr-status: ${passed} checks passed`);
