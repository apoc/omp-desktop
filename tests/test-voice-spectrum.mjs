#!/usr/bin/env node
// Regression script for src/app/voice-spectrum.js. Run: node tests/test-voice-spectrum.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
// eslint-disable-next-line no-new-func
for (const file of ["src/app/live-voice.js", "src/app/voice-spectrum.js"]) new Function("window", readFileSync(join(root, file), "utf8"))(win);
const S = win.OMP_VOICE_SPECTRUM;
let passed = 0;
function check(label, fn) {
  try { fn(); } catch (err) { console.error(`FAILED: ${label}`); throw err; }
  passed++;
}
const BANDS = 64;
const frame = value => new Array(BANDS).fill(value);
const run = (state, target, ms, stepMs = 16) => { let moving = false; for (let t = 0; t < ms; t += stepMs) moving = S.step(state, target, stepMs); return moving; };

check("runs while voice to text records or a live call is connected and unmuted", () => {
  assert.equal(S.shouldRun({ active: true, phase: "recording" }, null), true);
  for (const phase of ["starting", "stopping", "transcribing"]) assert.equal(S.shouldRun({ active: true, phase }, null), false, phase);
  assert.equal(S.shouldRun(null, { active: true, phase: "listening", muted: false }), true);
  assert.equal(S.shouldRun(null, { active: true, phase: "speaking", muted: false }), true);
  assert.equal(S.shouldRun(null, { active: true, phase: "listening", muted: true }), false, "a muted call shows no microphone");
  for (const phase of ["connecting", "stopping", "error"]) assert.equal(S.shouldRun(null, { active: true, phase, muted: false }), false, phase);
  assert.equal(S.shouldRun(null, { active: false, paused: true }), false);
  assert.equal(S.shouldRun(null, null), false);
});

check("bars rise fast and fall slower", () => {
  const s = S.createState(BANDS);
  run(s, frame(255), 100);
  assert.ok(s.values[0] > 0.95, `risen ${s.values[0]}`);
  run(s, frame(0), 100);
  assert.ok(s.values[0] > 0.4 && s.values[0] < 0.6, `half fallen after 100 ms: ${s.values[0]}`);
});

check("a peak cap holds above a falling bar, then drops to it", () => {
  const s = S.createState(BANDS);
  run(s, frame(255), 100);
  run(s, frame(0), 200);
  assert.ok(s.peaks[0] > 0.95, `held: ${s.peaks[0]}`);
  assert.ok(s.peaks[0] > s.values[0]);
  run(s, frame(0), 1500);
  assert.ok(s.peaks[0] < 0.01, `dropped: ${s.peaks[0]}`);
});

check("silence comes to rest, so the canvas stops redrawing", () => {
  const s = S.createState(BANDS);
  run(s, frame(200), 100);
  assert.equal(S.step(s, null, 16), true);
  assert.equal(run(s, null, 3000), false);
  assert.ok(s.values.every(v => v < 0.01) && s.peaks.every(p => p < 0.01));
});

check("a long frame gap (hidden window) is clamped, not a jump", () => {
  const s = S.createState(BANDS);
  S.step(s, frame(255), 10_000);
  assert.ok(s.values[0] < 1 && s.values[0] > 0.9, `${s.values[0]}`);
});

console.log(`test-voice-spectrum: ${passed} checks passed`);
