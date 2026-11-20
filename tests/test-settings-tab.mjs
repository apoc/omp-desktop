#!/usr/bin/env node
// Regression script for src/app/settings-tab.js — the Settings app tab (#37):
// open/activate on a section, close back to the first section, a project
// pick stepping back without closing, and next/prev with settings as the
// last position.
// Run: node tests/test-settings-tab.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
// eslint-disable-next-line no-new-func
new Function("window", readFileSync(join(root, "src/app/settings-tab.js"), "utf8"))(win);
const T = win.OMP_SETTINGS_TAB;

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

check("starts closed on appearance", () => {
  assert.deepEqual(T.initial(), { open: false, active: false, section: "appearance" });
});

check("open activates, keeps the section unless one is given", () => {
  const s = T.open(T.initial());
  assert.deepEqual(s, { open: true, active: true, section: "appearance" });
  const sc = T.open(s, "shortcuts");
  assert.equal(sc.section, "shortcuts");
  assert.equal(T.open(T.selectProject(sc)).section, "shortcuts");
});

check("a project pick steps back without closing", () => {
  const s = T.selectProject(T.open(T.initial(), "terminal"));
  assert.deepEqual(s, { open: true, active: false, section: "terminal" });
  const closed = T.initial();
  assert.equal(T.selectProject(closed), closed);
});

check("close resets to the first section", () => {
  assert.deepEqual(T.close(T.open(T.initial(), "agent")), T.initial());
});

check("setSection only changes the section", () => {
  const s = T.open(T.initial());
  assert.equal(T.setSection(s, "appearance"), s);
  assert.deepEqual(T.setSection(s, "chat"), { ...s, section: "chat" });
});

check("cycle without settings open walks the sessions", () => {
  const s = T.initial();
  assert.deepEqual(T.cycle(s, ["a", "b"], "a", 1), { settingsActive: false, sessionId: "b" });
  assert.deepEqual(T.cycle(s, ["a", "b"], "b", 1), { settingsActive: false, sessionId: "a" });
  assert.deepEqual(T.cycle(s, ["a", "b"], "a", -1), { settingsActive: false, sessionId: "b" });
  assert.deepEqual(T.cycle(s, [], null, 1), { settingsActive: false, sessionId: null });
});

check("settings is the last position while open", () => {
  const s = T.selectProject(T.open(T.initial()));
  assert.deepEqual(T.cycle(s, ["a", "b"], "b", 1), { settingsActive: true, sessionId: "b" });
  assert.deepEqual(T.cycle(s, ["a", "b"], "a", -1), { settingsActive: true, sessionId: "a" });
  assert.deepEqual(T.cycle(s, ["a", "b"], "a", 1), { settingsActive: false, sessionId: "b" });
});

check("from settings, next wraps to the first session and prev to the last", () => {
  const s = T.open(T.initial());
  assert.deepEqual(T.cycle(s, ["a", "b", "c"], "b", 1), { settingsActive: false, sessionId: "a" });
  assert.deepEqual(T.cycle(s, ["a", "b", "c"], "b", -1), { settingsActive: false, sessionId: "c" });
  assert.deepEqual(T.cycle(s, [], null, 1), { settingsActive: true, sessionId: null });
});

check("an inactive external session cycles to the edge real tabs", () => {
  const closed = T.initial();
  assert.deepEqual(T.cycle(closed, ["a", "b", "c"], "ompy", 1), { settingsActive: false, sessionId: "a" });
  assert.deepEqual(T.cycle(closed, ["a", "b", "c"], "ompy", -1), { settingsActive: false, sessionId: "c" });
  const backgroundSettings = T.selectProject(T.open(T.initial()));
  assert.deepEqual(T.cycle(backgroundSettings, ["a", "b", "c"], "ompy", 1), { settingsActive: false, sessionId: "a" });
  assert.deepEqual(T.cycle(backgroundSettings, ["a", "b", "c"], "ompy", -1), { settingsActive: false, sessionId: "c" });
});

console.log(`test-settings-tab: ${passed} checks passed`);
