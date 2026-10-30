#!/usr/bin/env node
// Regression script for src/app/approval-mode.js — omp's tool approval
// mode chosen in the desktop (#57): which mode a tab's folder resolves to,
// the toolbar's approvals button, which open tabs a change restarts now or once idle,
// and the mode editor's project rows.
// Run: node tests/test-approval-mode.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win  = {};
// The real busy predicate, loaded the same way: restartPlan reads it
// late-bound from window.OMP_TURN_STATUS.
for (const file of ["src/app/turn-status.js", "src/app/approval-mode.js"]) {
  // eslint-disable-next-line no-new-func
  new Function("window", readFileSync(join(root, file), "utf8"))(win);
}
const M = win.OMP_APPROVAL_MODE;

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

const P = "/home/u/devel/x";
const Q = "/home/u/devel/y";
const view = { default: "write", projects: { [P]: "yolo" } };

// ── isMode / labelOf ──────────────────────────────────────────────────────

check("isMode accepts exactly omp's kebab-case modes", () => {
  for (const m of ["always-ask", "write", "yolo"]) assert.equal(M.isMode(m), true, m);
  for (const m of ["Write", "auto", "always ask", "", null, undefined, "default"]) {
    assert.equal(M.isMode(m), false, String(m));
  }
});

check("labelOf names the modes and passes unknown strings through", () => {
  assert.equal(M.labelOf("always-ask"), "always ask");
  assert.equal(M.labelOf("write"), "write");
  assert.equal(M.labelOf("yolo"), "yolo");
  assert.equal(M.labelOf("auto"), "auto");
});

check("MODES lists the three modes in order, only yolo warns", () => {
  assert.deepEqual(M.MODES.map(m => m.value), ["always-ask", "write", "yolo"]);
  assert.deepEqual(M.MODES.filter(m => m.warn).map(m => m.value), ["yolo"]);
  assert.equal(M.DEFAULT_MODE, "write");
});

// ── effectiveFor ──────────────────────────────────────────────────────────

check("effectiveFor: no view yet reads as the desktop default", () => {
  assert.equal(M.effectiveFor(null, P), "write");
});

check("effectiveFor: a tab without a folder takes the global default", () => {
  const v = { default: "always-ask", projects: { [P]: "yolo" } };
  assert.equal(M.effectiveFor(v, null), "always-ask");
  assert.equal(M.effectiveFor(v, ""), "always-ask");
});

check("effectiveFor: a project override beats the default", () => {
  assert.equal(M.effectiveFor(view, P), "yolo");
});

check("effectiveFor: a project without an override takes the default", () => {
  assert.equal(M.effectiveFor(view, Q), "write");
  assert.equal(M.effectiveFor({ default: "always-ask", projects: {} }, Q), "always-ask");
});

// ── statusCell ────────────────────────────────────────────────────────────

check("statusCell: running == effective shows the plain label", () => {
  assert.deepEqual(M.statusCell(view, { path: Q, approvalMode: "write" }),
    { label: "write", running: "write", target: "write", warn: false, pending: false });
  assert.deepEqual(M.statusCell({ default: "always-ask", projects: {} }, { path: Q, approvalMode: "always-ask" }),
    { label: "always ask", running: "always ask", target: "always ask", warn: false, pending: false });
});

check("statusCell: a change waiting for the turn to end shows running ⇢ target", () => {
  assert.deepEqual(M.statusCell(view, { path: P, approvalMode: "write" }),
    { label: "write ⇢ yolo", running: "write", target: "yolo", warn: true, pending: true });
});

check("statusCell: warn follows the target, not the running mode", () => {
  // Running yolo, target write: the amber goes as soon as yolo is dropped.
  const cell = M.statusCell(view, { path: Q, approvalMode: "yolo" });
  assert.equal(cell.label, "yolo ⇢ write");
  assert.equal(cell.target, "write");
  assert.equal(cell.warn, false);
  assert.equal(cell.pending, true);
  assert.equal(M.statusCell(view, { path: P, approvalMode: "yolo" }).warn, true);
});

check("statusCell: no running mode yet (spawn in flight) shows the target, not pending", () => {
  assert.deepEqual(M.statusCell(view, { path: P, approvalMode: null }),
    { label: "yolo", running: "yolo", target: "yolo", warn: true, pending: false });
  assert.deepEqual(M.statusCell(null, null), { label: "write", running: "write", target: "write", warn: false, pending: false });
});

// ── restartPlan ───────────────────────────────────────────────────────────

check("restartPlan: idle mismatches now, busy ones later, matching and failed ones never", () => {
  const sessions = [
    { id: "idle",       path: P, approvalMode: "write", runState: "idle" },
    { id: "idle2",      path: P, approvalMode: "always-ask", runState: "idle" },
    { id: "running",    path: P, approvalMode: "write", runState: "running" },
    { id: "retrying",   path: P, approvalMode: "write", runState: "retrying" },
    { id: "asking",     path: P, approvalMode: "write", runState: "waiting-user" },
    { id: "background", path: P, approvalMode: "write", runState: "background" },
    { id: "failed",     path: P, approvalMode: "write", runState: "failed" },
    { id: "matches",    path: P, approvalMode: "yolo",  runState: "idle" },
    { id: "other",      path: Q, approvalMode: "write", runState: "idle" },
    { id: "spawning",   path: P, approvalMode: null,    runState: "idle" },
  ];
  assert.deepEqual(M.restartPlan(view, sessions), {
    now: ["idle", "idle2"],
    later: ["running", "retrying", "asking", "background"],
  });
});

check("restartPlan: a default change reaches every tab without its own override", () => {
  const v = { default: "always-ask", projects: { [P]: "write" } };
  const sessions = [
    { id: "a", path: P,  approvalMode: "write", runState: "idle" },
    { id: "b", path: Q,  approvalMode: "write", runState: "idle" },
    { id: "c", path: "", approvalMode: "write", runState: "running" },
  ];
  assert.deepEqual(M.restartPlan(v, sessions), { now: ["b"], later: ["c"] });
});

check("restartPlan: no sessions → empty plan", () => {
  assert.deepEqual(M.restartPlan(view, []), { now: [], later: [] });
  assert.deepEqual(M.restartPlan(view, undefined), { now: [], later: [] });
});

// ── projectRows ───────────────────────────────────────────────────────────

check("projectRows: the active folder with an override shows it", () => {
  assert.deepEqual(M.projectRows(view, P), [{ path: P, value: "yolo", active: true }]);
});

check("projectRows: an active folder without an override selects the literal 'default', overrides follow", () => {
  assert.deepEqual(M.projectRows(view, Q), [
    { path: Q, value: "default", active: true },
    { path: P, value: "yolo", active: false },
  ]);
  assert.deepEqual(M.projectRows(null, Q), [{ path: Q, value: "default", active: true }]);
});

check("projectRows: no folder lists only the overrides, by path, skipping unknown modes", () => {
  const many = { default: "write", projects: { "/b": "always-ask", "/a": "yolo", "/c": "Write" } };
  assert.deepEqual(M.projectRows(many, null), [
    { path: "/a", value: "yolo", active: false },
    { path: "/b", value: "always-ask", active: false },
  ]);
  assert.deepEqual(M.projectRows(view, ""), [{ path: P, value: "yolo", active: false }]);
  assert.deepEqual(M.projectRows(null, null), []);
});

console.log(`approval-mode: ${passed} checks passed`);
