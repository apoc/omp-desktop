#!/usr/bin/env node
// Regression for src/app/notify-sound.js — the notification-sound prefs
// validation, the cue rule over tracker snapshots (docs/architecture/
// notification-sounds.md D1–D4) and `play`, which asks Rust for the sound
// (D5), against a stub `__TAURI__.core.invoke`. live.js's use of it:
// test-attention-bridge.mjs; the Settings row: test-rows-sounds.mjs.
// Run: node tests/test-notify-sound.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (win, file) => new Function("window", readFileSync(join(root, "src", file), "utf8"))(win);

/** A window with the real attention module and notify-sound loaded. */
function boot(extra = {}) {
  const win = { ...extra };
  load(win, "app/attention.js");
  load(win, "app/notify-sound.js");
  return win;
}

const N = boot().OMP_NOTIFY_SOUND;
const D = { notifySound: "off", soundAttention: "bell", soundFinished: "chime", soundVolume: 60 };

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

check("catalogue: the six sounds in order, with labels, frozen", () => {
  assert.deepEqual(N.SOUNDS.map(s => s.id), ["chime", "bell", "pop", "knock", "rise", "blip"]);
  assert.deepEqual([...N.MODES], ["off", "background", "always"]);
  for (const s of N.SOUNDS) {
    assert.ok(s.label, s.id);
    assert.ok(Object.isFrozen(s));
  }
  assert.ok(Object.isFrozen(N.SOUNDS) && Object.isFrozen(N));
});

check("prefsFrom: a valid set passes through; missing values are the defaults", () => {
  assert.deepEqual(N.prefsFrom({ notifySound: "always", soundAttention: "pop", soundFinished: "none", soundVolume: 25 }, D),
    { mode: "always", attention: "pop", finished: "none", volume: 25 });
  assert.deepEqual(N.prefsFrom({}, D), { mode: "off", attention: "bell", finished: "chime", volume: 60 });
  assert.deepEqual(N.prefsFrom(undefined, D), { mode: "off", attention: "bell", finished: "chime", volume: 60 });
});

check("prefsFrom: each bad field falls back to its own default", () => {
  const p = N.prefsFrom({ notifySound: "sometimes", soundAttention: "gong", soundFinished: 7, soundVolume: "loud" }, D);
  assert.deepEqual(p, { mode: "off", attention: "bell", finished: "chime", volume: 60 });
  assert.equal(N.prefsFrom({ notifySound: "always", soundAttention: "gong" }, D).mode, "always");
  assert.equal(N.prefsFrom({ soundFinished: "knock", soundVolume: NaN }, D).finished, "knock");
  assert.equal(N.prefsFrom({ soundVolume: null }, D).volume, 60);
  assert.equal(N.prefsFrom({ soundVolume: "40" }, D).volume, 40, "a numeric string reads as the Settings slider reads it");
  assert.equal(N.prefsFrom({ soundVolume: "" }, D).volume, 60);
});

check("VOLUME is the Settings slider's range", () => {
  assert.deepEqual({ ...N.VOLUME }, { min: 0, max: 100, step: 5 });
  assert.ok(Object.isFrozen(N.VOLUME));
});

check("prefsFrom: volume clamps to 0..100 and rounds to steps of 5", () => {
  assert.equal(N.prefsFrom({ soundVolume: 250 }, D).volume, 100);
  assert.equal(N.prefsFrom({ soundVolume: -5 }, D).volume, 0);
  assert.equal(N.prefsFrom({ soundVolume: 62 }, D).volume, 60);
  assert.equal(N.prefsFrom({ soundVolume: 63 }, D).volume, 65);
  assert.equal(N.prefsFrom({ soundVolume: 0 }, D).volume, 0);
});

const prefs = (over = {}) => ({ mode: "always", attention: "bell", finished: "chime", volume: 60, ...over });
const idle = { busy: false, asks: 0, asksOpened: 0, background: false };
const busy = { ...idle, busy: true };
const asked = { ...idle, asks: 1, asksOpened: 1 };
const cue = (over) => N.cue({ previous: { a: idle }, next: { a: idle }, focused: false, prefs: prefs(), ...over });

check("cue: mode off is silent for every event", () => {
  const p = prefs({ mode: "off" });
  assert.equal(cue({ prefs: p, next: { a: asked } }), null);
  assert.equal(cue({ prefs: p, previous: { a: busy } }), null);
});

check("cue: the first snapshot is silent", () => {
  assert.equal(cue({ previous: null, next: { a: asked } }), null);
  assert.equal(cue({ previous: undefined, next: { a: idle } }), null);
});

check("cue: background mode is silent while focused and plays unfocused", () => {
  const p = prefs({ mode: "background" });
  assert.equal(cue({ prefs: p, focused: true, next: { a: asked } }), null);
  assert.equal(cue({ prefs: p, focused: true, previous: { a: busy } }), null);
  assert.equal(cue({ prefs: p, focused: false, next: { a: asked } }), "attention");
  assert.equal(cue({ prefs: p, focused: false, previous: { a: busy } }), "finished");
});

check("cue: always mode plays while focused", () => {
  assert.equal(cue({ focused: true, next: { a: asked } }), "attention");
  assert.equal(cue({ focused: true, previous: { a: busy } }), "finished");
});

check("cue: a new ask is attention, in any session", () => {
  assert.equal(cue({ previous: { a: idle, b: idle }, next: { a: idle, b: asked } }), "attention");
  assert.equal(cue({ previous: { a: asked }, next: { a: asked } }), null);   // the same ask, not new
});

check("cue: busy → idle is finished", () => {
  assert.equal(cue({ previous: { a: busy }, next: { a: idle } }), "finished");
  assert.equal(cue({ previous: { a: busy, b: idle }, next: { a: busy, b: idle } }), null);
});

check("cue: a vanished entry is not a finish", () => {
  assert.equal(cue({ previous: { a: busy }, next: {} }), null);
  assert.equal(cue({ previous: { a: busy }, next: { b: idle } }), null);
});

check("cue: idle → idle and a new entry are not a finish", () => {
  assert.equal(cue({ previous: { a: idle }, next: { a: idle } }), null);
  assert.equal(cue({ previous: {}, next: { a: idle } }), null);
  assert.equal(cue({ previous: { a: idle }, next: { a: busy } }), null);
});

check("cue: attention outranks finished in one snapshot", () => {
  assert.equal(cue({ previous: { a: busy, b: idle }, next: { a: idle, b: asked } }), "attention");
});

check("cue: attention set to none lets a finish in the same snapshot play", () => {
  const p = prefs({ attention: "none" });
  assert.equal(cue({ prefs: p, previous: { a: busy, b: idle }, next: { a: idle, b: asked } }), "finished");
  assert.equal(cue({ prefs: p, next: { a: asked } }), null);
});

check("cue: finished set to none is silent; attention still plays", () => {
  const p = prefs({ finished: "none" });
  assert.equal(cue({ prefs: p, previous: { a: busy } }), null);
  assert.equal(cue({ prefs: p, next: { a: asked } }), "attention");
});

// ── the player ──────────────────────────────────────────────────────────
const play = (win, id, volume) => win.OMP_NOTIFY_SOUND.play(id, volume);
const tauri = (invoke) => ({ __TAURI__: { core: { invoke } } });

check("play: one notify_sound_play invoke with the id and the integer volume", () => {
  const calls = [];
  const win = boot(tauri((command, args) => { calls.push([command, args]); return Promise.resolve(); }));
  play(win, "bell", 60);
  play(win, "pop", 100);
  assert.deepEqual(calls, [["notify_sound_play", { sound: "bell", volume: 60 }], ["notify_sound_play", { sound: "pop", volume: 100 }]]);
});

check("play: every catalogue id is sent", () => {
  const sent = [];
  const win = boot(tauri((_, args) => { sent.push(args.sound); return Promise.resolve(); }));
  for (const s of win.OMP_NOTIFY_SOUND.SOUNDS) play(win, s.id, 40);
  assert.deepEqual(sent, ["chime", "bell", "pop", "knock", "rise", "blip"]);
});

check("play: none, an unknown id, volume 0 or a bad volume send nothing", () => {
  let calls = 0;
  const win = boot(tauri(() => { calls++; return Promise.resolve(); }));
  for (const [id, v] of [["none", 60], ["gong", 60], ["chime", 0], ["chime", -5], ["chime", NaN], ["chime", undefined]]) play(win, id, v);
  assert.equal(calls, 0);
});

check("play: the volume is capped at 100 and rounded", () => {
  const sent = [];
  const win = boot(tauri((_, args) => { sent.push(args.volume); return Promise.resolve(); }));
  play(win, "chime", 250);
  play(win, "chime", 33.4);
  assert.deepEqual(sent, [100, 33]);
});

// A rejecting invoke must be handled by play: an unhandled rejection would
// crash node here, and the webview would log it.
let unhandled = null;
process.once("unhandledRejection", (err) => { unhandled = err; });
check("play: a throwing invoke and no Tauri runtime never escape", () => {
  play(boot(tauri(() => Promise.reject(new Error("no audio device")))), "chime", 60);
  play(boot(tauri(() => { throw new Error("boom"); })), "chime", 60);
  play(boot(tauri(() => undefined)), "chime", 60);
  play(boot({}), "chime", 60);
  play(boot({ __TAURI__: {} }), "chime", 60);
});
await new Promise(resolve => setTimeout(resolve, 10));
check("play: a rejecting invoke is handled", () => assert.equal(unhandled, null));

console.log(`test-notify-sound: ${passed} checks passed`);
