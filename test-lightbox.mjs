#!/usr/bin/env node
// Regression script for src/app/lightbox.js — geometry behind the
// attached-image viewer (issue #25: thumbnails too small to read, no way
// to enlarge them).
// Run: node test-lightbox.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const src   = readFileSync(join(__dir, "src/app/lightbox.js"), "utf8");
const win   = {};
// eslint-disable-next-line no-new-func
new Function("window", src)(win);
const L = win.OMP_LIGHTBOX;

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

// ── fitRect ──────────────────────────────────────────────────────────────

check("a large screenshot shrinks to fit the viewport, aspect kept, centred", () => {
  const r = L.fitRect(2000, 1000, 1280, 800);
  assert.ok(r.width <= 1280 && r.height <= 800);
  assert.ok(Math.abs(r.width / r.height - 2) < 0.01);
  assert.equal(r.left, (1280 - r.width) / 2);
  assert.equal(r.top, (800 - r.height) / 2);
  // Clearly bigger than the ~220px thumbnail — the point of the viewer.
  assert.ok(r.width > 1000);
});

check("a tall image is bound by the viewport height, not its width", () => {
  const r = L.fitRect(600, 3000, 1280, 800);
  assert.ok(r.height < 800 && r.height > 600);
  assert.ok(r.width < r.height);
});

check("a small image is enlarged, but at most 2x (upscale blur)", () => {
  const r = L.fitRect(200, 100, 1920, 1080);
  assert.equal(r.width, 400);
  assert.equal(r.height, 200);
});

check("a tiny window never yields a negative or empty rect", () => {
  const r = L.fitRect(800, 600, 100, 80);
  assert.ok(r.width >= 1 && r.height >= 1);
});

check("unknown natural size (not decoded yet) yields no rect", () => {
  assert.equal(L.fitRect(0, 0, 1280, 800), null);
  assert.equal(L.fitRect(undefined, 100, 1280, 800), null);
});

// ── flipTransform ────────────────────────────────────────────────────────

check("flipTransform maps the enlarged rect exactly onto the thumbnail", () => {
  const thumb = { left: 900, top: 500, width: 220, height: 110 };
  const big   = { left: 140, top: 150, width: 1000, height: 500 };
  const m = L.flipTransform(thumb, big).match(
    /^translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+), ([\d.]+)\)$/,
  );
  assert.ok(m, "unexpected transform syntax");
  const [x, y, sx, sy] = m.slice(1).map(Number);
  // transform-origin 0 0: a point p of the element lands at p*s + t.
  const map = (px, py) => [big.left + px * sx + x, big.top + py * sy + y];
  assert.deepEqual(map(0, 0), [thumb.left, thumb.top]);
  assert.deepEqual(map(big.width, big.height), [thumb.left + thumb.width, thumb.top + thumb.height]);
});

// ── stepIndex ────────────────────────────────────────────────────────────

check("prev/next wrap around at both ends", () => {
  assert.equal(L.stepIndex(2, 1, 3), 0);
  assert.equal(L.stepIndex(0, -1, 3), 2);
  assert.equal(L.stepIndex(1, 1, 3), 2);
});

console.log(`lightbox: ${passed} checks passed`);
