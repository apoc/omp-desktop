#!/usr/bin/env node
// Regression script for src/app/updater.js — the in-app update state
// machine (issue #19): which transitions are legal, what a failed
// background check may and may not hide, when the tab-bar pill shows, and
// which tabs a restart would interrupt.
// Run: node test-updater.mjs  (or: npm run test:updater)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const src   = readFileSync(join(__dir, "src/app/updater.js"), "utf8");
const win   = {};
// eslint-disable-next-line no-new-func
new Function("window", src)(win);
const U = win.OMP_UPDATER;

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

const INFO = {
  version: "0.4.0", notes: "fixes", date: "2026-09-24T00:00:00Z",
  canInstall: true, releaseUrl: "https://github.com/apoc/omp-desktop/releases/tag/v0.4.0",
};
const run = (...actions) => actions.reduce(U.reduce, U.initialState());
const available = (info = INFO) => run({ type: "check-start" }, { type: "check-done", info });

// ── check lifecycle ───────────────────────────────────────────────────────

check("a found update lands in available with the normalized info", () => {
  const s = available();
  assert.equal(s.phase, "available");
  assert.equal(s.update.version, "0.4.0");
  assert.equal(s.update.canInstall, true);
});

check("a null result means up to date", () => {
  const s = run({ type: "check-start" }, { type: "check-done", info: null });
  assert.equal(s.phase, "uptodate");
  assert.equal(s.update, null);
});

check("a payload without a version is not an update", () => {
  const s = run({ type: "check-start" }, { type: "check-done", info: { canInstall: true } });
  assert.equal(s.phase, "uptodate");
  assert.equal(s.update, null);
});

check("canInstall must be literally true — anything else is notify-only", () => {
  const s = available({ ...INFO, canInstall: "yes" });
  assert.equal(s.update.canInstall, false);
  assert.equal(U.canStartInstall(s), false);
});

check("a failed check with nothing known is an error", () => {
  const s = run({ type: "check-start" }, { type: "check-failed", error: "offline" });
  assert.equal(s.phase, "error");
  assert.equal(s.error, "offline");
});

check("a failed re-check keeps the update an earlier check found", () => {
  const s = [{ type: "check-start" }, { type: "check-failed", error: "offline" }].reduce(U.reduce, available());
  assert.equal(s.phase, "available");
  assert.equal(s.update.version, "0.4.0");
  assert.equal(s.error, "offline");
});

check("a successful up-to-date re-check drops the update found earlier", () => {
  // Rust clears its parked update on `Ok(None)`; keeping it here would offer
  // an install that can only fail with "no update pending".
  const s = [{ type: "check-start" }, { type: "check-done", info: null }].reduce(U.reduce, available());
  assert.equal(s.phase, "uptodate");
  assert.equal(s.update, null);
  assert.equal(U.pillVersion(s, null), null);
});

check("a check result arriving outside a check is ignored", () => {
  const s = U.reduce(U.initialState(), { type: "check-done", info: INFO });
  assert.equal(s.phase, "idle");
  assert.equal(s.update, null);
});

check("no check starts while downloading (would drop the in-flight update)", () => {
  const downloading = U.reduce(available(), { type: "install-start" });
  assert.equal(U.reduce(downloading, { type: "check-start" }), downloading);
});

check("restarting is terminal: nothing moves it back to an installable state", () => {
  const r = [{ type: "install-start" }, { type: "install-done" }].reduce(U.reduce, available());
  for (const a of [
    { type: "check-start" }, { type: "check-failed", error: "x" }, { type: "install-start" },
    { type: "install-failed", error: "x" }, { type: "progress", downloaded: 1, total: 2 },
  ]) {
    assert.equal(U.reduce(r, a), r, `${a.type} must not leave restarting`);
  }
});

check("busy/installing selectors cover exactly the phases they gate", () => {
  const phases = ["idle", "checking", "available", "uptodate", "error", "downloading", "restarting"];
  const at = (phase) => ({ ...U.initialState(), phase });
  assert.deepEqual(phases.filter((p) => U.isInstalling(at(p))), ["downloading", "restarting"]);
  assert.deepEqual(phases.filter((p) => U.isBusy(at(p))), ["checking", "downloading", "restarting"]);
});

// ── install lifecycle ─────────────────────────────────────────────────────

check("install runs available → downloading → restarting", () => {
  let s = U.reduce(available(), { type: "install-start" });
  assert.equal(s.phase, "downloading");
  assert.deepEqual(s.progress, { downloaded: 0, total: null });
  s = U.reduce(s, { type: "progress", downloaded: 512, total: 1024 });
  assert.deepEqual(s.progress, { downloaded: 512, total: 1024 });
  s = U.reduce(s, { type: "install-done" });
  assert.equal(s.phase, "restarting");
});

check("a notify-only update cannot start an install", () => {
  const s = available({ ...INFO, canInstall: false });
  assert.equal(U.reduce(s, { type: "install-start" }), s);
});

check("a failed install returns to available with the reason, keeping the update", () => {
  const s = [{ type: "install-start" }, { type: "install-failed", error: "signature mismatch" }]
    .reduce(U.reduce, available());
  assert.equal(s.phase, "available");
  assert.equal(s.error, "signature mismatch");
  assert.equal(s.progress, null);
  assert.equal(U.canStartInstall(s), true, "the user can retry");
});

check("progress outside a download, or with a bogus count, is ignored", () => {
  const s = available();
  assert.equal(U.reduce(s, { type: "progress", downloaded: 1, total: 2 }), s);
  const d = U.reduce(s, { type: "install-start" });
  assert.equal(U.reduce(d, { type: "progress", downloaded: "lots" }), d);
});

check("unknown total (no Content-Length) stays indeterminate", () => {
  const d = U.reduce(available(), { type: "install-start" });
  const s = U.reduce(d, { type: "progress", downloaded: 10, total: null });
  assert.equal(s.progress.total, null);
  assert.equal(U.progressPct(s.progress), null);
});

// ── selectors ─────────────────────────────────────────────────────────────

check("pill announces an update unless that exact version was skipped", () => {
  const s = available();
  assert.equal(U.pillVersion(U.initialState(), null), null);
  assert.equal(U.pillVersion(s, null), "0.4.0");
  assert.equal(U.pillVersion(s, "0.4.0"), null);
  assert.equal(U.pillVersion(s, "0.3.9"), "0.4.0", "skipping an older version doesn't hide a newer one");
});

check("progressPct clamps and floors", () => {
  assert.equal(U.progressPct({ downloaded: 999, total: 1000 }), 99, "never reports 100 before the last byte");
  assert.equal(U.progressPct({ downloaded: 1000, total: 1000 }), 100);
  assert.equal(U.progressPct({ downloaded: 2000, total: 1000 }), 100);
  assert.equal(U.progressPct(null), null);
});

check("busyTabCount counts tabs a restart would interrupt", () => {
  assert.equal(U.busyTabCount([
    { runState: "running" }, { runState: "waiting-user" }, { runState: "idle" }, { runState: "failed" }, {},
  ]), 2);
  assert.equal(U.busyTabCount(undefined), 0);
});

check("formatBytes picks a readable unit", () => {
  assert.equal(U.formatBytes(512), "512 B");
  assert.equal(U.formatBytes(2048), "2 KB");
  assert.equal(U.formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(U.formatBytes(NaN), "—");
});

console.log(`test-updater: ${passed} checks passed`);
