#!/usr/bin/env node
// Regression script for src/app/session-prefs.js — the Settings → Session /
// Agent prefs live.js applies (#37): reading them from the tweaks, what
// changed, and when closing a tab or quitting asks first.
// Run: node tests/test-session-prefs.mjs  (or: npm run test:session-prefs)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win  = {};
// busyTabs reads window.OMP_TURN_STATUS.isBusyRunState.
for (const file of ["src/app/turn-status.js", "src/app/session-prefs.js"]) {
  // eslint-disable-next-line no-new-func
  new Function("window", readFileSync(join(root, file), "utf8"))(win);
}
const P = win.OMP_SESSION_PREFS;

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

const DEFAULTS = { restoreTabs: true, confirmBusyClose: false, autoName: true, theme: "aurora" };
const ON = { ...P.fromTweaks({}, DEFAULTS), confirmBusyClose: true };
const OFF = P.fromTweaks({}, DEFAULTS);
const tab = (id, runState, name = id) => ({ id, name, runState });

// ── fromTweaks / changedKeys ─────────────────────────────────────────────
check("fromTweaks: defaults fill missing keys, only the pref keys are kept", () => {
  assert.deepEqual(P.fromTweaks({}, DEFAULTS),
    { restoreTabs: true, confirmBusyClose: false, autoName: true });
});
check("fromTweaks: omp's own switches are not desktop prefs (#92)", () => {
  assert.deepEqual([...P.KEYS], ["restoreTabs", "confirmBusyClose", "autoName"]);
  const p = P.fromTweaks({ autoCompaction: false, autoRetry: false }, { ...DEFAULTS, autoCompaction: true, autoRetry: true });
  assert.equal("autoCompaction" in p, false);
  assert.equal("autoRetry" in p, false);
});
check("fromTweaks: stored booleans win", () => {
  const p = P.fromTweaks({ restoreTabs: false, confirmBusyClose: true }, DEFAULTS);
  assert.equal(p.restoreTabs, false);
  assert.equal(p.confirmBusyClose, true);
  assert.equal(p.autoName, true);
});
check("fromTweaks: a malformed stored value falls back to the default", () => {
  const p = P.fromTweaks({ restoreTabs: "no", autoName: 0, confirmBusyClose: null }, DEFAULTS);
  assert.equal(p.restoreTabs, true);
  assert.equal(p.autoName, true);
  assert.equal(p.confirmBusyClose, false);
});
check("fromTweaks: no tweaks and no defaults → every pref off", () => {
  assert.ok(Object.values(P.fromTweaks(null, null)).every(v => v === false));
});
check("changedKeys: only differing keys, in KEYS order", () => {
  assert.deepEqual(P.changedKeys(OFF, OFF), []);
  assert.deepEqual(P.changedKeys(OFF, { ...OFF, autoName: false, restoreTabs: false }), ["restoreTabs", "autoName"]);
});

// ── busy tabs ────────────────────────────────────────────────────────────
check("busyTabs: running, retrying, waiting and background count; idle and failed do not", () => {
  const sessions = [tab("a", "running"), tab("b", "idle"), tab("c", "retrying"),
    tab("d", "waiting-user"), tab("e", "background"), tab("f", "failed")];
  assert.deepEqual(P.busyTabs(sessions).map(t => t.id), ["a", "c", "d", "e"]);
});
check("busyTabs: carries a readable state and a name fallback", () => {
  const [t] = P.busyTabs([{ id: "x", name: "", runState: "waiting-user" }]);
  assert.equal(t.name, "untitled tab");
  assert.equal(t.state, "waiting for your answer");
});
check("busyTabs: a missing list is no tabs", () => {
  assert.deepEqual(P.busyTabs(undefined), []);
});

// ── close guard ──────────────────────────────────────────────────────────
check("closeGuardArmed: needs the setting on and a busy tab", () => {
  assert.equal(P.closeGuardArmed(ON, [tab("a", "running")]), true);
  assert.equal(P.closeGuardArmed(OFF, [tab("a", "running")]), false);
  assert.equal(P.closeGuardArmed(ON, [tab("a", "idle")]), false);
  assert.equal(P.closeGuardArmed(ON, []), false);
});

// ── tab close ────────────────────────────────────────────────────────────
check("tabCloseConfirm: a busy tab asks, naming only that tab", () => {
  const c = P.tabCloseConfirm(ON, [tab("a", "running", "alpha"), tab("b", "running")], "a");
  assert.equal(c.kind, "tab");
  assert.equal(c.id, "a");
  assert.deepEqual(c.tabs.map(t => t.name), ["alpha"]);
  assert.ok(c.confirmLabel);
});
check("tabCloseConfirm: idle tab, unknown tab or setting off close at once", () => {
  const sessions = [tab("a", "running"), tab("b", "idle")];
  assert.equal(P.tabCloseConfirm(ON, sessions, "b"), null);
  assert.equal(P.tabCloseConfirm(ON, sessions, "zzz"), null);
  assert.equal(P.tabCloseConfirm(OFF, sessions, "a"), null);
});

// ── quit ─────────────────────────────────────────────────────────────────
check("quitConfirm: lists every busy tab, singular and plural wording", () => {
  const one = P.quitConfirm(ON, [tab("a", "running"), tab("b", "idle")]);
  assert.equal(one.kind, "quit");
  assert.deepEqual(one.tabs.map(t => t.id), ["a"]);
  assert.match(one.title, /a busy tab/);
  const two = P.quitConfirm(ON, [tab("a", "running"), tab("b", "background")]);
  assert.match(two.title, /2 busy tabs/);
  assert.equal(two.tabs.length, 2);
});
check("quitConfirm: nothing busy or setting off quits at once", () => {
  assert.equal(P.quitConfirm(ON, [tab("a", "idle")]), null);
  assert.equal(P.quitConfirm(OFF, [tab("a", "running")]), null);
});

// ── guard states (#89) ───────────────────────────────────────────────────
check("busy helpers over guard states: a run started after the freeze counts, a retired one still does", () => {
  const { guardRunState } = win.OMP_TURN_STATUS;
  // Background tabs as `_sessionsView` builds them: frozen state, dot.
  const startedSince = { ...tab("a", guardRunState("idle", "running")), displayRunState: "running" };
  const askedSince = { ...tab("b", guardRunState("idle", "waiting-user")), displayRunState: "waiting-user" };
  const retired = { ...tab("c", guardRunState("running", "idle")), displayRunState: "idle" };
  const quiet = { ...tab("d", guardRunState("idle", "idle")), displayRunState: "idle" };
  const dead = { ...tab("e", guardRunState("failed", "running")), displayRunState: "failed" };
  const all = [startedSince, askedSince, retired, quiet, dead];
  assert.deepEqual(P.busyTabs(all).map(t => [t.id, t.state]),
    [["a", "working"], ["b", "waiting for your answer"], ["c", "working"]]);
  assert.equal(P.closeGuardArmed(ON, [startedSince, quiet]), true, "a run the freeze never saw arms the guard");
  assert.equal(P.closeGuardArmed(ON, [quiet, dead]), false);
  assert.equal(P.tabCloseConfirm(ON, all, "a")?.kind, "tab");
  assert.equal(P.tabCloseConfirm(ON, all, "d"), null);
  assert.deepEqual(P.quitConfirm(ON, all).tabs.map(t => t.id), ["a", "b", "c"]);
});

console.log(`test-session-prefs: ${passed} checks passed`);
