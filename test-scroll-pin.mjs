#!/usr/bin/env node
// Regression script for src/app/scroll-pin.js — the chat "stick to bottom"
// state machine behind issue #20 (chat force-scrolled on every streamed
// update, no way to read history mid-run).
// Run: node test-scroll-pin.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const src   = readFileSync(join(__dir, "src/app/scroll-pin.js"), "utf8");
const win   = {};
// eslint-disable-next-line no-new-func
new Function("window", src)(win);
const P = win.OMP_SCROLL_PIN;

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

// ── nextPinned ───────────────────────────────────────────────────────────

check("scrolling up away from bottom unpins immediately (the reported bug)", () => {
  // At bottom: scrollHeight 1000, clientHeight 400 -> scrollTop 600.
  // User scrolls up a little to read history.
  const pinned = P.nextPinned(true, 600, { scrollTop: 550, scrollHeight: 1000, clientHeight: 400 });
  assert.equal(pinned, false);
});

check("scrollTop clamp after content shrinks above (trim) keeps pinned state", () => {
  // Still effectively at bottom (dist=0) even though scrollTop decreased
  // because scrollHeight shrank — not a user scroll-up.
  const pinned = P.nextPinned(true, 700, { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
  assert.equal(pinned, true);
});

check("scrolling back down near bottom re-pins", () => {
  const pinned = P.nextPinned(false, 500, { scrollTop: 590, scrollHeight: 1000, clientHeight: 400 });
  assert.equal(pinned, true);
});

check("scrolling down but still far from bottom stays unpinned", () => {
  const pinned = P.nextPinned(false, 100, { scrollTop: 200, scrollHeight: 2000, clientHeight: 400 });
  assert.equal(pinned, false);
});

check("once unpinned, streaming growth (scrollTop unchanged) never re-pins", () => {
  // Simulates the effect re-running on every streamed token with an
  // unmoved scrollTop but a growing scrollHeight below the fold.
  let pinned = false;
  for (let h = 1000; h <= 1400; h += 100) {
    pinned = P.nextPinned(pinned, 300, { scrollTop: 300, scrollHeight: h, clientHeight: 400 });
  }
  assert.equal(pinned, false);
});

check("staying pinned at the very bottom through growth remains pinned", () => {
  let top = 600;
  let pinned = true;
  for (let h = 1000; h <= 1400; h += 100) {
    const newTop = h - 400; // caller sets scrollTop = scrollHeight after auto-scroll
    pinned = P.nextPinned(pinned, top, { scrollTop: newTop, scrollHeight: h, clientHeight: 400 });
    top = newTop;
  }
  assert.equal(pinned, true);
});

// ── shouldRepin ────────────────────────────────────────────────────────────

check("shouldRepin: new user message re-pins", () => {
  const messages = [{ kind: "assistant", _id: 1 }, { kind: "user", _id: 2 }];
  assert.equal(P.shouldRepin(1, messages), true);
});

check("shouldRepin: unrelated update (same tail id) does not re-pin", () => {
  const messages = [{ kind: "assistant", _id: 1 }, { kind: "user", _id: 2 }];
  assert.equal(P.shouldRepin(2, messages), false);
});

check("shouldRepin: streaming assistant tail does not re-pin", () => {
  const messages = [{ kind: "user", _id: 1 }, { kind: "assistant", _id: 2, streaming: true }];
  assert.equal(P.shouldRepin(1, messages), false);
});

check("shouldRepin: transcript reset to empty re-pins (/new, profile switch)", () => {
  assert.equal(P.shouldRepin(1, []), true);
});

console.log(`scroll-pin: ${passed} checks passed`);
