#!/usr/bin/env node
// Regression for src/app/attention.js — the dock bounce shared by rail
// widget attention (app/use-widgets.jsx) and the tracker overlay's new-ask
// rule (live.js `agent://attention`), and the "once per new ask" decision.
// Run: node tests/test-attention.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
// eslint-disable-next-line no-new-func
new Function("window", readFileSync(join(root, "src/app/attention.js"), "utf8"))(win);
const A = win.OMP_ATTENTION;

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

check("one Informational bounce through the Tauri window API", () => {
  const types = [];
  A.requestAttention({
    __TAURI__: {
      window: {
        UserAttentionType: { Informational: 2 },
        getCurrentWindow: () => ({ requestUserAttention: type => { types.push(type); return Promise.resolve(); } }),
      },
    },
  });
  assert.deepEqual(types, [2]);
});

check("no Tauri window API and a rejecting request are silent", () => {
  A.requestAttention({});
  A.requestAttention(undefined);
  A.requestAttention({
    __TAURI__: {
      window: {
        getCurrentWindow: () => ({ requestUserAttention: () => Promise.reject(new Error("no capability")) }),
      },
    },
  });
  // A synchronous throw from the capability lookup must not escape either.
  A.requestAttention({ __TAURI__: { window: { getCurrentWindow: () => { throw new Error("boom"); } } } });
});

check("a new ask is any session whose open-question sequence rose", () => {
  assert.equal(A.newAsk(null, { a: { asksOpened: 1 } }), false, "the first snapshot is not a new ask");
  assert.equal(A.newAsk({}, { a: { asksOpened: 1 } }), true);
  assert.equal(A.newAsk({ a: { asksOpened: 1 } }, { a: { asksOpened: 1 } }), false);
  assert.equal(A.newAsk({ a: { asksOpened: 1 } }, { a: { asksOpened: 2 } }), true, "a second form field");
  assert.equal(A.newAsk({ a: { asksOpened: 2 } }, { a: { asksOpened: 2 } }), false, "answered, cancelled or timed out");
  assert.equal(A.newAsk({ a: { asksOpened: 1 } }, {}), false, "the session exited");
  assert.equal(
    A.newAsk({ a: { asksOpened: 0 }, b: { asksOpened: 0 } }, { a: { asksOpened: 0 }, b: { asksOpened: 1 } }),
    true,
    "any session counts, not just the first",
  );
  assert.equal(A.newAsk({ a: { asksOpened: 1 } }, { a: { asksOpened: 0 }, b: { asksOpened: 1 } }), true);
  assert.equal(A.newAsk({}, { a: { asksOpened: 0 } }), false, "a session without asks is not a question");
  assert.equal(A.newAsk({ a: {} }, { a: { asksOpened: 1 } }), true, "a malformed previous entry reads as none");
});

check("answer one question and open another in the same batch still bounces", () => {
  // The open count is 1 before and after: only the sequence stamp moves.
  assert.equal(
    A.newAsk(
      { a: { asks: 1, asksOpened: 7 } },
      { a: { asks: 1, asksOpened: 8 } },
    ),
    true,
    "P2: the outstanding count hid the new ask",
  );
});

check("two questions in one snapshot bounce once, never zero", () => {
  assert.equal(A.shouldBounce({
    previous: { a: { asks: 0, asksOpened: 3 } },
    next: { a: { asks: 2, asksOpened: 5 } },
    focused: false,
  }), true);
});

check("bounce only while the window is not focused", () => {
  assert.equal(A.shouldBounce({ previous: {}, next: { a: { asksOpened: 1 } }, focused: true }), false);
  assert.equal(A.shouldBounce({ previous: {}, next: { a: { asksOpened: 1 } }, focused: false }), true);
  assert.equal(A.shouldBounce({ previous: null, next: { a: { asksOpened: 1 } }, focused: false }), false);
});

check("counter-probe: counting outstanding questions misses an answer plus an open", () => {
  // The pre-fix rule compared `asks` only.
  const byCount = (previous, next) => Object.keys(next).some(id =>
    (next[id]?.asks ?? 0) > (previous?.[id]?.asks ?? 0));
  const previous = { a: { asks: 1, asksOpened: 7 } };
  const next = { a: { asks: 1, asksOpened: 8 } };
  assert.equal(byCount(previous, next), false, "the old rule saw no new question");
  assert.equal(A.newAsk(previous, next), true, "the sequence stamp does");
  // An unchanged stamp never bounces, so a repeated snapshot is quiet.
  assert.equal(A.newAsk(next, next), false);
  assert.equal(byCount(next, next), false);
  // A changed count downward (an answer) is not a new ask either way.
  assert.equal(A.newAsk({ a: { asks: 2, asksOpened: 9 } }, { a: { asks: 1, asksOpened: 9 } }), false);
});

console.log(`test-attention: ${passed} checks passed`);
