#!/usr/bin/env node
// Regression script for src/app/matrix-rain.js — the empty workspace's
// digital-rain backdrop and ASCII logo geometry.
// Run: node test-matrix-rain.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const src   = readFileSync(join(__dir, "src/app/matrix-rain.js"), "utf8");
const win   = {};
// eslint-disable-next-line no-new-func
new Function("window", src)(win);
const M = win.OMP_MATRIX;

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

// JetBrains Mono-like cell proportions (per 1px of font size).
const CELL = { cellW: 0.6, cellH: 1.2 };

check("every logo row has the same width, so letters don't shear", () => {
  for (const row of M.LOGO) assert.equal([...row].length, M.LOGO_COLS);
  assert.equal(M.LOGO.length, M.LOGO_ROWS);
});

check("the fitted logo stays inside the area and is centred", () => {
  for (const [w, h] of [[420, 300], [780, 640], [1200, 900], [3000, 1600], [600, 120]]) {
    const fit = M.fitLogo(w, h, CELL);
    assert.ok(fit, `${w}x${h} should fit`);
    assert.ok(fit.x >= 0 && fit.x + fit.width <= w, `${w}x${h}: horizontal overflow`);
    assert.ok(fit.y >= 0 && fit.y + fit.height <= h, `${w}x${h}: vertical overflow`);
    assert.ok(Math.abs(fit.x - (w - fit.x - fit.width)) < 1e-9, `${w}x${h}: not centred horizontally`);
    assert.ok(Math.abs(fit.y - (h - fit.y - fit.height)) < 1e-9, `${w}x${h}: not centred vertically`);
    assert.equal(fit.width, M.LOGO_COLS * CELL.cellW * fit.font);
  }
});

check("the logo stops growing at maxFont on a large area", () => {
  assert.equal(M.fitLogo(5000, 3000, { ...CELL, maxFont: 18 }).font, 18);
});

check("a short area limits the logo by height", () => {
  const wide = M.fitLogo(3000, 2000, CELL);
  const short = M.fitLogo(3000, 150, CELL);
  assert.ok(short.font < wide.font);
  assert.ok(short.height <= 150 * 0.4 + 1e-9);
});

check("no logo when the area is too small or unmeasured", () => {
  assert.equal(M.fitLogo(120, 400, CELL), null);
  assert.equal(M.fitLogo(0, 0, CELL), null);
  assert.equal(M.fitLogo(800, 600, { cellW: 0, cellH: 1.2 }), null);
});

check("drops start at or above the top edge, one per column", () => {
  let i = 0;
  const seq = [0, 0.5, 0.99];
  const drops = M.initDrops(3, 40, () => seq[i++]);
  assert.deepEqual(drops.map(d => d <= 0), [true, true, true]);
  assert.deepEqual(drops, [0, -20, -39]);
  assert.equal(M.initDrops(0, 40, Math.random).length, 0);
});

check("a drop inside the area advances one row", () => {
  assert.deepEqual(M.stepDrops([-3, 0, 10], 20, () => 1), [-2, 1, 11]);
});

check("a drop past the bottom restarts only when the roll beats the odds", () => {
  assert.deepEqual(M.stepDrops([21], 20, () => 0.99), [0]);
  assert.deepEqual(M.stepDrops([21], 20, () => 0.5), [22]);
  // Exactly at the bottom row it is still visible: never reset there.
  assert.deepEqual(M.stepDrops([20], 20, () => 0.99), [21]);
});

check("random glyphs come from the glyph set", () => {
  assert.equal(M.randomGlyph(() => 0), M.GLYPHS[0]);
  assert.equal(M.randomGlyph(() => 0.999999), M.GLYPHS[M.GLYPHS.length - 1]);
});

console.log(`matrix-rain: ${passed} checks passed`);
