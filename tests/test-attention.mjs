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

check("a new ask is any session whose open-question count rose", () => {
  assert.equal(A.newAsk(null, { a: { asks: 1 } }), false, "the first snapshot is not a new ask");
  assert.equal(A.newAsk({}, { a: { asks: 1 } }), true);
  assert.equal(A.newAsk({ a: { asks: 1 } }, { a: { asks: 1 } }), false);
  assert.equal(A.newAsk({ a: { asks: 1 } }, { a: { asks: 2 } }), true, "a second form field");
  assert.equal(A.newAsk({ a: { asks: 2 } }, { a: { asks: 1 } }), false, "answered, cancelled or timed out");
  assert.equal(A.newAsk({ a: { asks: 1 } }, {}), false, "the session exited");
  assert.equal(
    A.newAsk({ a: { asks: 0 }, b: { asks: 0 } }, { a: { asks: 0 }, b: { asks: 1 } }),
    true,
    "any session counts, not just the first",
  );
  assert.equal(A.newAsk({ a: { asks: 1 } }, { a: { asks: 0 }, b: { asks: 1 } }), true);
  assert.equal(A.newAsk({}, { a: { asks: 0 } }), false, "a session without asks is not a question");
  assert.equal(A.newAsk({ a: {} }, { a: { asks: 1 } }), true, "a malformed previous entry reads as none");
});

check("bounce only while the window is not focused", () => {
  assert.equal(A.shouldBounce({ previous: {}, next: { a: { asks: 1 } }, focused: true }), false);
  assert.equal(A.shouldBounce({ previous: {}, next: { a: { asks: 1 } }, focused: false }), true);
  assert.equal(A.shouldBounce({ previous: null, next: { a: { asks: 1 } }, focused: false }), false);
});

check("counter-probe: comparing counts only upward is what makes it once per ask", () => {
  // The property under test: an unchanged count never bounces. The two
  // plausible wrong rules — "any open ask" and "any changed count" — fail
  // on a repeated snapshot and on an answer respectively.
  const open = { a: { asks: 1 } };
  const anyOpen = next => Object.keys(next).some(id => (next[id]?.asks ?? 0) > 0);
  const anyChange = (previous, next) =>
    Object.keys(next).some(id => (next[id]?.asks ?? 0) !== (previous?.[id]?.asks ?? 0));
  assert.equal(A.newAsk(open, open), false);
  assert.equal(anyOpen(open), true, "the wrong rule re-bounces the same open ask");
  assert.equal(A.newAsk({ a: { asks: 2 } }, { a: { asks: 1 } }), false);
  assert.equal(anyChange({ a: { asks: 2 } }, { a: { asks: 1 } }), true, "the wrong rule bounces on an answer");
});

console.log(`test-attention: ${passed} checks passed`);
