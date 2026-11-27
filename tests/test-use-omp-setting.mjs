#!/usr/bin/env node
// Regression script for src/app/use-omp-setting.jsx — Settings → Agent's
// omp-config hooks (#92): `useOmpSetting` for omp's compaction / retry
// switches over the generic `useOmpFlag`. What the hook shows and never shows
// (a reply for a profile left meanwhile, a read that a later write
// overtook), and how a write's answer is applied. The bridge is a fake that
// answers when told to.
// Run: node tests/test-use-omp-setting.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const Babel = createRequire(import.meta.url)(join(root, "src/babel.min.js"));

let passed = 0;
async function check(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`FAILED: ${label}`);
    throw err;
  }
  passed++;
}

/** The hook file compiled as index.html's Babel does, under a React stand-in
 *  that keeps state per call position and runs effects during the render.
 *  `source` defaults to the real file. */
function load(source = readFileSync(join(root, "src/app/use-omp-setting.jsx"), "utf8")) {
  const slots = [];
  let i = 0;
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((v, k) => !Object.is(v, b[k]));
  const React = {
    useState(init) {
      const k = i++;
      if (!(k in slots)) slots[k] = { value: init };
      const s = slots[k];
      return [s.value, v => { s.value = typeof v === "function" ? v(s.value) : v; }];
    },
    useRef(init) { const k = i++; return (slots[k] ??= { current: init }); },
    useEffect(fn, deps) {
      const k = i++;
      if (!slots[k] || changed(slots[k].deps, deps)) { slots[k] = { deps }; fn(); }
    },
  };
  const window = {};
  runInNewContext(Babel.transform(source, { presets: ["react"] }).code, { window, React });
  return { window, render: call => { i = 0; return call(); } };
}

/** A bridge whose omp-config calls wait for the test: `answer.get(profile)` /
 *  `answer.set()` settle the oldest unanswered call. Every call is recorded. */
function deferredBridge() {
  const calls = [];
  const gets = [];
  const sets = [];
  const bridge = {
    ompSetting: (profile, setting) => { calls.push(["get", profile, setting]); return new Promise(r => gets.push({ profile, r })); },
    setOmpSetting: (profile, setting, enabled) => { calls.push(["set", profile, setting, enabled]); return new Promise(r => sets.push(r)); },
  };
  const take = (list, profile) => {
    const at = list.findIndex(c => profile === undefined || c.profile === profile);
    assert.notEqual(at, -1, `no pending call for ${profile}`);
    return list.splice(at, 1)[0];
  };
  return {
    bridge,
    calls,
    answerGet: async (profile, reply) => { take(gets, profile).r(reply); await flush(); },
    answerSet: async reply => { sets.shift()(reply); await flush(); },
  };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/** The switch hook for `setting` on a fresh harness: `show(bridge, profileId,
 *  active = true)` renders it once. */
function switchHook(setting) {
  const { window, render } = load();
  return (bridge, profileId, active = true) => render(() => window.useOmpSetting(bridge, setting, profileId, active));
}

await check("a switch shows omp's value of the profile, not a default, once omp answered", async () => {
  const d = deferredBridge();
  const show = switchHook("autoCompaction");
  const before = show(d.bridge, "work");
  assert.equal(before.value, null, "reading…");
  assert.equal(before.error, null);
  await d.answerGet("work", { ok: true, value: false });
  const shown = show(d.bridge, "work");
  assert.equal(shown.value, false);
  assert.equal(shown.error, null);
  assert.deepEqual(d.calls, [["get", "work", "autoCompaction"]]);
});

await check("each switch asks for its own setting", async () => {
  for (const setting of ["autoCompaction", "autoRetry"]) {
    const d = deferredBridge();
    const show = switchHook(setting);
    show(d.bridge, "p");
    await d.answerGet("p", { ok: true, value: true });
    assert.equal(show(d.bridge, "p").value, true);
    assert.deepEqual(d.calls, [["get", "p", setting]]);
  }
});

await check("a failed read shows omp's reason and no value; its own wording when omp gave none", async () => {
  const d = deferredBridge();
  const show = switchHook("autoCompaction");
  show(d.bridge, "p");
  await d.answerGet("p", { ok: false, error: "omp is not installed" });
  const failed = show(d.bridge, "p");
  assert.equal(failed.value, null);
  assert.equal(failed.error, "omp is not installed");

  const d2 = deferredBridge();
  const show2 = switchHook("autoRetry");
  show2(d2.bridge, "p");
  await d2.answerGet("p", undefined);
  assert.equal(show2(d2.bridge, "p").error, "could not read omp's setting");
});

await check("a switch to another profile never shows the previous profile's value or error", async () => {
  const d = deferredBridge();
  const show = switchHook("autoCompaction");
  show(d.bridge, "a");
  await d.answerGet("a", { ok: true, value: true });
  assert.equal(show(d.bridge, "a").value, true);
  const other = show(d.bridge, "b");
  assert.equal(other.value, null, "profile b has not answered yet");
  assert.equal(other.error, null);
  await d.answerGet("b", { ok: false, error: "boom" });
  show(d.bridge, "b");
  const back = show(d.bridge, "a");
  assert.equal(back.value, null, "b's failure is not a's value");
  assert.equal(back.error, null);
});

await check("reads nothing while inactive, without a profile or without a bridge; reads once all are there", async () => {
  const d = deferredBridge();
  const show = switchHook("autoRetry");
  show(d.bridge, "p", false);
  show(d.bridge, null, true);
  show(null, "p", true);
  assert.deepEqual(d.calls, []);
  show(d.bridge, "p", true);
  assert.deepEqual(d.calls, [["get", "p", "autoRetry"]]);
  // Turning `active` off and on again fetches again: the user may have edited omp's config meanwhile.
  show(d.bridge, "p", false);
  show(d.bridge, "p", true);
  assert.equal(d.calls.length, 2);
});

// ---- replies that arrive out of order -----------------------------------

await check("a late reply for a profile left meanwhile does not replace the current profile's value", async () => {
  const d = deferredBridge();
  const show = switchHook("autoCompaction");
  show(d.bridge, "a"); // a's read is in flight
  show(d.bridge, "b"); // the user switches to a tab of profile b
  await d.answerGet("b", { ok: true, value: false });
  await d.answerGet("a", { ok: true, value: true }); // a's late reply
  const shown = show(d.bridge, "b");
  assert.equal(shown.value, false);
  assert.equal(shown.error, null);
});

await check("a late failure for a profile left meanwhile shows no error on the current profile", async () => {
  const d = deferredBridge();
  const show = switchHook("autoCompaction");
  show(d.bridge, "a");
  show(d.bridge, "b");
  await d.answerGet("b", { ok: true, value: true });
  await d.answerGet("a", { ok: false, error: "a failed late" });
  const shown = show(d.bridge, "b");
  assert.equal(shown.value, true);
  assert.equal(shown.error, null);
});

/** A switch on profile "p" that has read `true`, then refetched (`active` off and
 *  on): the second read is still in flight, so `answerGet` settles it. */
async function refetching() {
  const d = deferredBridge();
  const show = switchHook("autoCompaction");
  show(d.bridge, "p");
  await d.answerGet("p", { ok: true, value: true });
  show(d.bridge, "p", false);
  show(d.bridge, "p", true);
  return { d, show };
}

await check("a read issued before a write never overwrites the write's answer, in either arrival order", async () => {
  for (const readFirst of [true, false]) {
    const { d, show } = await refetching();
    const pending = show(d.bridge, "p").set(false);
    assert.equal(show(d.bridge, "p").busy, true);
    if (readFirst) {
      await d.answerGet("p", { ok: true, value: true }); // the stale read lands first
      await d.answerSet({ ok: true, value: false });
    } else {
      await d.answerSet({ ok: true, value: false });
      await d.answerGet("p", { ok: true, value: true }); // and last
    }
    await pending;
    const shown = show(d.bridge, "p");
    assert.equal(shown.value, false, readFirst ? "read then write" : "write then read");
    assert.equal(shown.busy, false);
    assert.equal(shown.error, null);
  }
});

await check("a read issued before a write does not clear the write's busy state while it is in flight", async () => {
  const { d, show } = await refetching();
  const pending = show(d.bridge, "p").set(false);
  await d.answerGet("p", { ok: true, value: true });
  assert.equal(show(d.bridge, "p").busy, true, "the write has not answered");
  await d.answerSet({ ok: true, value: false });
  await pending;
  assert.equal(show(d.bridge, "p").busy, false);
});

// ---- writing ---------------------------------------------------------------

await check("toggling writes omp's config for the profile and shows the value omp reports back", async () => {
  const d = deferredBridge();
  const show = switchHook("autoCompaction");
  show(d.bridge, "work");
  await d.answerGet("work", { ok: true, value: true });
  const pending = show(d.bridge, "work").set(false);
  assert.equal(show(d.bridge, "work").busy, true);
  await d.answerSet({ ok: true, value: false });
  await pending;
  const after = show(d.bridge, "work");
  assert.equal(after.value, false);
  assert.equal(after.busy, false);
  assert.deepEqual(d.calls.filter(c => c[0] === "set"), [["set", "work", "autoCompaction", false]]);
});

await check("a refused write keeps the shown value and shows omp's reason; a write omp's answer contradicts shows the effective value", async () => {
  const d = deferredBridge();
  const show = switchHook("autoRetry");
  show(d.bridge, "p");
  await d.answerGet("p", { ok: true, value: true });
  let pending = show(d.bridge, "p").set(false);
  await d.answerSet({ ok: false, error: "could not write config.yml" });
  await pending;
  const refused = show(d.bridge, "p");
  assert.equal(refused.value, true);
  assert.equal(refused.error, "could not write config.yml");
  assert.equal(refused.busy, false);

  pending = show(d.bridge, "p").set(false);
  assert.equal(show(d.bridge, "p").error, null, "a new write clears the old reason");
  await d.answerSet({ ok: true, value: true }); // omp reports the value still in effect
  await pending;
  const unchanged = show(d.bridge, "p");
  assert.equal(unchanged.value, true);
  assert.equal(unchanged.error, null);

  pending = show(d.bridge, "p").set(false);
  await d.answerSet(undefined);
  await pending;
  assert.equal(show(d.bridge, "p").error, "could not change the setting");
});

await check("a write's answer for a profile left meanwhile is dropped", async () => {
  const d = deferredBridge();
  const show = switchHook("autoRetry");
  show(d.bridge, "a");
  await d.answerGet("a", { ok: true, value: true });
  const pending = show(d.bridge, "a").set(false);
  const other = show(d.bridge, "b"); // the user moves on before the write answers
  assert.equal(other.value, null);
  assert.equal(other.busy, false, "a's write is not b's busy state");
  await d.answerGet("b", { ok: true, value: true });
  await d.answerSet({ ok: true, value: false }); // a's write lands after b's read
  await pending;
  const shown = show(d.bridge, "b");
  assert.equal(shown.value, true, "a's write answer is not b's value");
  assert.equal(shown.busy, false);
  assert.equal(shown.error, null);
});

// ---- the generic hook --------------------------------------------------------

await check("useOmpFlag runs the ops it is given with the bridge and profile, and shows their values", async () => {
  const { window, render } = load();
  const calls = [];
  const bridge = { id: "bridge" };
  const ops = {
    read: (b, profile) => { calls.push(["read", b, profile]); return Promise.resolve({ ok: true, value: false }); },
    write: (b, profile, enabled) => { calls.push(["write", b, profile, enabled]); return Promise.resolve({ ok: true, value: enabled }); },
  };
  const show = () => render(() => window.useOmpFlag(bridge, "p", true, ops));
  show();
  await flush();
  assert.equal(show().value, false);
  await show().set(true);
  assert.equal(show().value, true);
  assert.deepEqual(calls, [["read", bridge, "p"], ["write", bridge, "p", true]]);
});

console.log(`test-use-omp-setting: ${passed} checks passed`);
