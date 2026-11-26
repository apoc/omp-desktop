#!/usr/bin/env node
// Regression script for src/app/use-bridge-snapshot.jsx — what the hook
// routes from a bridge snapshot into the App's setters. The thinking level
// follows the snapshot even when it is null: a new tab has none until its
// first get_state, and keeping the previous tab's would show it as this
// tab's (#92). The hook runs under a React stand-in whose effects run during
// the render; the test only talks to the setters it calls.
// Run: node tests/test-bridge-snapshot.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const Babel = createRequire(import.meta.url)(join(root, "src/babel.min.js"));
const code = Babel.transform(readFileSync(join(root, "src/app/use-bridge-snapshot.jsx"), "utf8"), { presets: ["react"] }).code;

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

/** The hook subscribed once; `push(snapshot)` delivers a snapshot and returns
 *  every call the setters got, as `[name, value]`. */
function subscribed() {
  const React = { useEffect: fn => { fn(); } };
  const window = { NULL_MODEL: { id: "" }, DEFAULT_PROFILE_ID: "default" };
  const useBridgeSnapshot = runInNewContext(`${code}\nuseBridgeSnapshot`, { window, React });
  const calls = [];
  // Every setter the hook calls is a recorder.
  const setters = new Proxy({}, { get: (_t, name) => v => { calls.push([name, v]); } });
  let deliver;
  useBridgeSnapshot({ onUpdate: fn => { deliver = fn; return () => {}; } }, setters);
  const push = snapshot => {
    calls.length = 0;
    deliver(snapshot);
    return [...calls];
  };
  return {
    push,
    levels: snapshot => push(snapshot).filter(([name]) => name === "setThinkingLevel").map(([, v]) => v),
  };
}

check("a snapshot's thinking level is applied", () => {
  const { levels } = subscribed();
  assert.deepEqual(levels({ thinkingLevel: "max" }), ["max"]);
  assert.deepEqual(levels({ thinkingLevel: "low" }), ["low"]);
});

check("a new tab's null level replaces the previous tab's level instead of keeping it", () => {
  const { levels } = subscribed();
  assert.deepEqual(levels({ thinkingLevel: "max" }), ["max"]);
  assert.deepEqual(levels({ thinkingLevel: null }), [null]); // the next tab, before its first get_state
  assert.deepEqual(levels({}), [null], "a snapshot without the field carries no level either");
});

check("the other fields are still routed, with their defaults", () => {
  const { push } = subscribed();
  const calls = push({ messages: ["m"], thinkingLevel: null });
  const got = Object.fromEntries(calls);
  assert.deepEqual(got.setMessages, ["m"]);
  assert.deepEqual(got.setModelState, { id: "" }, "no model falls back to the null model");
  assert.equal(got.setStartupProfileId, "default");
  assert.equal("setActiveSessionId" in got, false, "no active session id, no call");
  assert.deepEqual(push({ activeSessionId: "s1" }).filter(([n]) => n === "setActiveSessionId"), [["setActiveSessionId", "s1"]]);
});

console.log(`test-bridge-snapshot: ${passed} checks passed`);
