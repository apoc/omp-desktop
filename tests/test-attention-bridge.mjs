#!/usr/bin/env node
// Bridge regression: a background tab's run dot follows Rust's tracker
// (`agent://attention`, src-tauri/src/remote/tracker.rs) and a new question
// bounces the dock once. Loads the real live.js/turn-status.js/attention.js
// into a stubbed Tauri.
// Run: node tests/test-attention-bridge.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const load = (win, file) => new Function("window", readFileSync(`${root}src/${file}`, "utf8"))(win);

let focused = false;
globalThis.document = { hasFocus: () => focused, visibilityState: "visible" };

function harness() {
  const listeners = new Map(), journal = new Map(), bounces = [];
  const w = {
    OMP_SLASH: { LOCAL_COMMANDS: [], adaptAvailableCommands: cs => cs, mergeSlashCommands: (a) => a, isCommandInvocation: () => false, queuedFrame: () => null },
    OMP_SUBAGENTS: { emptySubagents: () => ({}), subscriptionLevelFor: () => "progress", mergeSnapshots: () => ({}) },
    OMP_QUEUE: { EMPTY_QUEUE: {} }, OMP_GOAL: { UNKNOWN: {} }, OMP_EXT_WIDGETS: { EMPTY: {} },
    OMP_PROMPT_HISTORY: { DEFAULT_LIMIT: 100 },
    OMP_SESSION_PREFS: { fromTweaks: () => ({ autoCompaction: true, autoRetry: true }), closeGuardArmed: () => false },
    OMP_TWEAKS_STORE: { read: () => ({}) },
    DEFAULT_PROFILE_ID: "default", INTENT_FRAMING: () => "", timeNow: () => "00:00",
  };
  for (const file of ["app/live-voice.js", "app/turn-status.js", "app/attention.js", "app/ask-dialog.js", "app/project-nav.js",
    "app/transcript-merge.js", "app/stream-delta.js", "app/approval.js", "app/live-context.js", "app/approval-mode.js", "app/session-title.js"]) load(w, file);
  const timeout = (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; };
  new Function("window", "setTimeout", "clearTimeout", readFileSync(`${root}src/live.js`, "utf8"))(w, timeout, clearTimeout);
  w.__TAURI__ = {
    core: {
      invoke(command, args) {
        if (command === "list_profiles") return Promise.resolve({ profiles: [{ id: "default", name: "default" }] });
        if (command === "start_session") return Promise.resolve("write");
        if (command === "attention_snapshot") return Promise.resolve(null); // the initial read; events follow
        if (command === "replay_events") return Promise.resolve({ dropped: false, events: (journal.get(args.sessionId) ?? []).filter(e => e.seq > args.afterSeq) });
        return Promise.resolve(null);
      },
    },
    event: {
      async listen(name, cb) {
        listeners.set(name, cb);
        return () => { if (listeners.get(name) === cb) listeners.delete(name); };
      },
    },
    window: {
      UserAttentionType: { Informational: 2 },
      getCurrentWindow: () => ({ requestUserAttention: type => { bounces.push(type); return Promise.resolve(); } }),
    },
  };
  let snapshot;
  w.OMP_BRIDGE.onUpdate(s => { snapshot = s; });
  // Backend reader: every line is journaled; only the active tab's listener
  // gets it live. The tracker is fed every frame by Rust and reaches the
  // webview through one `agent://attention` event.
  function emit(id, frame) {
    const entries = journal.get(id) ?? [];
    const entry = { seq: entries.length + 1, text: JSON.stringify(frame) };
    entries.push(entry);
    journal.set(id, entries);
    listeners.get(`agent://line/${id}`)?.({ payload: entry });
  }
  function attention(next) {
    listeners.get("agent://attention")?.({ payload: next });
  }
  function fire(name, payload) {
    listeners.get(name)?.({ payload });
  }
  const runState = id => snapshot?.sessions.find(s => s.id === id)?.runState;
  return { bridge: w.OMP_BRIDGE, emit, attention, fire, runState, bounces };
}

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

await check("a question in a background tab shows waiting-user, then clears on the tracker", async () => {
  focused = false;
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  await h.bridge.activateSession(a);
  h.emit(a, { type: "agent_start" });
  h.emit(a, { type: "turn_start" });
  await h.bridge.activateSession(b); // the user looks at another tab; A freezes mid-turn
  assert.equal(h.runState(a), "running");

  // Rust's tracker saw A's ask (a background tab has no line listener).
  h.attention({ [a]: { busy: true, asks: 1, background: false }, [b]: { busy: false, asks: 0, background: false } });
  assert.equal(h.runState(a), "waiting-user", "the background tab's dot shows the new ask");
  assert.equal(h.runState(b), "idle", "the active tab is untouched");

  // The ask was cancelled/timed out and the turn ended: no stale orange.
  h.attention({ [a]: { busy: false, asks: 0, background: false }, [b]: { busy: false, asks: 0, background: false } });
  assert.equal(h.runState(a), "idle", "a stale waiting-user clears when the ask is gone");
});

await check("the tracker's busy and background flags drive the background dot", async () => {
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  await h.bridge.activateSession(a);
  h.emit(a, { type: "agent_start" });
  h.emit(a, { type: "turn_start" });
  await h.bridge.activateSession(b);
  h.attention({ [a]: { busy: true, asks: 0, background: false } });
  assert.equal(h.runState(a), "running");
  h.attention({ [a]: { busy: false, asks: 0, background: true } });
  assert.equal(h.runState(a), "background");
});

await check("a failed process keeps its verdict over the tracker", async () => {
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  await h.bridge.activateSession(a);
  h.emit(a, { type: "agent_start" });
  h.fire(`agent://exit/${a}`, "omp exited: boom");
  await h.bridge.activateSession(b);
  h.attention({ [a]: { busy: true, asks: 1, background: false } });
  assert.equal(h.runState(a), "failed", "a dead process outranks an ask left open");
});

await check("counter-probe: without the overlay the frozen snapshot stays wrong", async () => {
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  await h.bridge.activateSession(a);
  h.emit(a, { type: "agent_start" });
  h.emit(a, { type: "turn_start" });
  await h.bridge.activateSession(b);
  const frozen = h.runState(a);
  assert.equal(frozen, "running", "the snapshot froze mid-turn");
  h.attention({ [a]: { busy: false, asks: 0, background: false } });
  assert.equal(h.runState(a), "idle");
  assert.notEqual(h.runState(a), frozen, "the overlay is what clears the stale dot");
});

await check("a new ask bounces the dock once, and not while focused", async () => {
  focused = false;
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  await h.bridge.activateSession(a);
  const idle = { [a]: { busy: true, asks: 0, background: false } };
  h.attention(idle); // first snapshot: nothing new to announce
  assert.deepEqual(h.bounces, []);
  const asking = { [a]: { busy: true, asks: 1, background: false } };
  h.attention(asking);
  assert.deepEqual(h.bounces, [2], "one Informational bounce");
  h.attention({ [a]: { busy: true, asks: 1, background: false } }); // same ask, new snapshot
  assert.deepEqual(h.bounces, [2], "not again for an unchanged ask");
  h.attention({ [a]: { busy: true, asks: 2, background: false } }); // a second form field
  assert.deepEqual(h.bounces, [2, 2], "a new question bounces again");
  focused = true;
  h.attention({ [a]: { busy: true, asks: 3, background: false } });
  assert.deepEqual(h.bounces, [2, 2], "a focused window already shows the dot");
  focused = false;
});

console.log(`test-attention-bridge: ${passed} checks passed`);
