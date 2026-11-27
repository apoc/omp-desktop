#!/usr/bin/env node
// Regression script for src/app/goal.js — the desktop's view of omp's goal
// mode: which `goal_updated` frames become transcript rows, what a
// `get_state` snapshot may and may not change (a completed goal omp has
// already forgotten, a malformed payload), the strip's view of each status,
// and the budget input. Frame shapes are the ones omp 18.6.0 emitted in RPC
// probes (rpc-goal.ts / goals/runtime.ts).
// Also the composer hook app/use-goal-mode.jsx: where a refused goal start
// hands its draft back, and the bridge calls behind its auto-continue switch
// (#92; the generic hook is covered by test-use-omp-setting.mjs).
// Run: node tests/test-goal.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
// eslint-disable-next-line no-new-func
new Function("window", readFileSync(join(root, "src/app/goal.js"), "utf8"))(win);
const G = win.OMP_GOAL;

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

const goal = (over = {}) => ({
  id: "g1", objective: "Write hello.txt with a greeting", status: "active",
  tokenBudget: 50000, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1, ...over,
});
const modeState = (g, over = {}) => ({ enabled: g.status === "active" || g.status === "budget-limited", mode: "active", goal: g, ...over });
const frame = (g, over) => ({ type: "goal_updated", goal: g, state: g ? modeState(g, over) : undefined });

/** Feeds frames in order from `start`, collecting rows. */
function run(start, ...frames) {
  let state = start;
  const rows = [];
  for (const f of frames) {
    const opts = f.stopping ? { stopping: true } : undefined;
    const r = G.fromFrame(state, f.frame ?? f, opts);
    state = r.state;
    if (r.row) rows.push(r.row);
  }
  return { state, rows };
}

const known = (g, over) => G.fromSnapshot(G.NONE, modeState(g, over));

// ── Rows only for news ────────────────────────────────────────────────────

check("a goal created on a tab whose state is known is announced with its objective and budget", () => {
  const { state, rows } = run(G.fromSnapshot(G.UNKNOWN, null), frame(goal()));
  assert.equal(state.goal.status, "active");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, "set");
  assert.equal(rows[0].objective, "Write hello.txt with a greeting");
  assert.equal(rows[0].tokenBudget, 50000);
});

check("frames a fresh or restored process replays before the tab knew its state add no row", () => {
  // A restored tab: omp pauses the goal it finds at startup and reports it.
  const { state, rows } = run(G.UNKNOWN, frame(goal({ status: "paused" })));
  assert.equal(rows.length, 0);
  assert.equal(state.known, true);
  assert.equal(state.goal.status, "paused");
});

check("accounting updates (same status) change the numbers but add no row", () => {
  const { state, rows } = run(known(goal()), frame(goal({ tokensUsed: 3060, timeUsedSeconds: 33 })));
  assert.equal(rows.length, 0);
  assert.equal(state.goal.tokensUsed, 3060);
  assert.equal(state.goal.timeUsedSeconds, 33);
});

check("an identical frame keeps the same state object", () => {
  const start = known(goal({ tokensUsed: 10 }));
  assert.equal(G.fromFrame(start, frame(goal({ tokensUsed: 10 }))).state, start);
});

// ── Pause / resume ────────────────────────────────────────────────────────

check("a pause while the user's abort is in flight is marked as stopped by the user, and the mark survives accounting frames", () => {
  // omp 18.6.0 on abort: goal_updated(paused) arrives before the abort response.
  const { state, rows } = run(known(goal()),
    { frame: frame(goal({ status: "paused" })), stopping: true },
    frame(goal({ status: "paused", timeUsedSeconds: 51 })));
  assert.deepEqual(rows.map(r => [r.event, r.cause]), [["paused", "stop"]]);
  assert.equal(state.goal.pausedBy, "stop");
  assert.notEqual(G.stripView(state).sub, null);
});

check("a pause without an abort (the strip's pause) carries no cause", () => {
  const { state, rows } = run(known(goal()), frame(goal({ status: "paused" })));
  assert.deepEqual(rows.map(r => [r.event, r.cause]), [["paused", null]]);
  assert.equal(G.stripView(state).sub, null);
});

check("resuming a paused goal is announced and clears the stop mark", () => {
  const { state, rows } = run(known(goal()),
    { frame: frame(goal({ status: "paused" })), stopping: true },
    frame(goal({ status: "active" })));
  assert.deepEqual(rows.map(r => r.event), ["paused", "resumed"]);
  assert.equal(state.goal.pausedBy, null);
});

check("a snapshot of the same paused goal keeps the stop mark", () => {
  const paused = run(known(goal()), { frame: frame(goal({ status: "paused" })), stopping: true }).state;
  const after = G.fromSnapshot(paused, modeState(goal({ status: "paused" })));
  assert.equal(after.goal.pausedBy, "stop");
});

// ── Budget, completion, drop ──────────────────────────────────────────────

check("running out of budget is announced once; resuming above budget from a pause is a resume, not a new goal", () => {
  const { rows } = run(known(goal({ tokenBudget: 2000 })),
    frame(goal({ tokenBudget: 2000, status: "budget-limited", tokensUsed: 3060 })),
    frame(goal({ tokenBudget: 2000, status: "budget-limited", tokensUsed: 6390 })),
    frame(goal({ tokenBudget: 2000, status: "paused", tokensUsed: 6390 })),
    frame(goal({ tokenBudget: 2000, status: "active", tokensUsed: 6390 })));
  assert.deepEqual(rows.map(r => r.event), ["limit", "paused", "resumed"]);
  assert.equal(rows[0].tokensUsed, 3060);
});

check("completion is announced with the final usage, and the summary outlives omp forgetting the goal", () => {
  const { state, rows } = run(known(goal()),
    frame(goal({ tokensUsed: 10340, timeUsedSeconds: 51 })),
    frame(goal({ status: "complete", tokensUsed: 10340, timeUsedSeconds: 51 }), { enabled: false, mode: "exiting", reason: "completed" }));
  assert.deepEqual(rows.map(r => r.event), ["complete"]);
  assert.equal(rows[0].tokensUsed, 10340);
  assert.equal(rows[0].timeUsedSeconds, 51);
  // omp 18.6.0: get_state.goal is null after the completing turn, with no further frame.
  const after = G.fromSnapshot(state, null);
  assert.equal(after.goal.status, "complete");
  assert.equal(G.fromFrame(after, { type: "goal_updated", goal: null }).state.goal.status, "complete");
  assert.equal(G.isOpen(after), false);
  assert.equal(G.dismiss(after).goal, null);
});

check("a dismissed summary stays dismissed while omp still reports the completed goal", () => {
  // omp keeps the completed goal (mode "exiting") until the completing turn ends.
  const completed = modeState(goal({ status: "complete", tokensUsed: 10340 }), { enabled: false, mode: "exiting", reason: "completed" });
  const shown = G.fromSnapshot(G.NONE, completed);
  const dismissed = G.dismiss(shown);
  assert.equal(G.fromSnapshot(dismissed, completed).goal, null);
  assert.equal(G.fromFrame(dismissed, frame(goal({ status: "complete" }), { enabled: false, mode: "exiting" })).state.goal, null);
  assert.equal(G.fromSnapshot(dismissed, null).goal, null);
  // A new goal still shows.
  assert.equal(G.fromSnapshot(dismissed, modeState(goal({ id: "g2" }))).goal.id, "g2");
});

check("a new goal after a completed one is announced as set", () => {
  const done = known(goal({ status: "complete" }), { enabled: false, mode: "exiting" });
  const { rows } = run(done, frame(goal({ id: "g2", objective: "Next" })));
  assert.deepEqual(rows.map(r => [r.event, r.objective]), [["set", "Next"]]);
});

check("dropping is announced and clears the goal; omp's later null snapshot keeps it cleared", () => {
  const { state, rows } = run(known(goal({ tokensUsed: 6390 })), frame(goal({ status: "dropped", tokensUsed: 6390 }), { enabled: false }));
  assert.deepEqual(rows.map(r => r.event), ["dropped"]);
  assert.equal(state.goal, null);
  assert.equal(G.fromSnapshot(state, null).goal, null);
  assert.equal(G.stripView(state), null);
});

check("a null snapshot clears an open goal (frames lost across a switch)", () => {
  assert.equal(G.fromSnapshot(known(goal()), null).goal, null);
});

check("a goal the agent completes before the tab ever saw it active is still announced as complete", () => {
  const { rows } = run(G.NONE, frame(goal({ status: "complete" }), { enabled: false, mode: "exiting" }));
  assert.deepEqual(rows.map(r => r.event), ["complete"]);
});

check("snapshots never produce rows and restore a paused goal silently", () => {
  const s = G.fromSnapshot(G.UNKNOWN, modeState(goal({ status: "paused" })));
  assert.equal(s.known, true);
  assert.equal(s.goal.status, "paused");
  assert.equal(s.goal.pausedBy, null);
});

check("malformed payloads change nothing", () => {
  const start = known(goal());
  assert.equal(G.fromFrame(start, frame({ ...goal(), id: "" })).state, start);
  assert.equal(G.fromFrame(start, frame({ ...goal(), status: "weird" })).state, start);
  assert.equal(G.fromSnapshot(start, { enabled: true, goal: { objective: 1 } }), start);
  assert.equal(G.fromSnapshot(start, "nope"), start);
});

check("plan mode is blocked by an active, paused or budget-limited goal only", () => {
  assert.equal(G.isOpen(known(goal())), true);
  assert.equal(G.isOpen(known(goal({ status: "paused" }))), true);
  assert.equal(G.isOpen(known(goal({ status: "budget-limited" }))), true);
  assert.equal(G.isOpen(G.NONE), false);
});

// ── Strip ─────────────────────────────────────────────────────────────────

check("an idle active goal tells why omp is waiting, depending on auto-continue", () => {
  const s = known(goal({ tokensUsed: 6290, timeUsedSeconds: 33 }));
  assert.equal(G.stripView(s, { busy: false, continuation: false }).waiting, "off");
  assert.equal(G.stripView(s, { busy: false, continuation: true }).waiting, "stopped");
  assert.equal(G.stripView(s, { busy: false, continuation: null }).waiting, "unknown");
  assert.equal(G.stripView(s, { busy: true, continuation: false }).waiting, null);
  assert.equal(G.stripView(known(goal({ status: "paused" })), { continuation: false }).waiting, null);
});

check("the meter reports used, left and percentage against the budget, and the overrun past it", () => {
  const v = G.stripView(known(goal({ tokensUsed: 10340, timeUsedSeconds: 51 })));
  assert.deepEqual(v.meter, { used: "10,340", budget: "50,000", pct: 21, left: "39,660", over: null, time: "51 s" });
  const over = G.stripView(known(goal({ tokenBudget: 2000, tokensUsed: 6390, status: "budget-limited" })));
  assert.equal(over.meter.pct, 100);
  assert.equal(over.meter.left, null);
  assert.equal(over.meter.over, "4,390");
  const free = G.stripView(known(goal({ tokenBudget: undefined, tokensUsed: 12 })));
  assert.equal(free.meter.budget, null);
  assert.equal(free.meter.pct, null);
});

check("each status offers its own actions", () => {
  assert.deepEqual(G.stripView(known(goal())).actions, ["pause", "drop"]);
  assert.deepEqual(G.stripView(known(goal({ status: "budget-limited" }))).actions, ["pause", "drop"]);
  assert.deepEqual(G.stripView(known(goal({ status: "paused" }))).actions, ["resume", "drop"]);
  assert.deepEqual(G.stripView(known(goal({ status: "complete" }), { enabled: false })).actions, ["dismiss"]);
});

check("durations read in the largest sensible units", () => {
  assert.equal(G.fmtSeconds(51), "51 s");
  assert.equal(G.fmtSeconds(125), "2 min 5 s");
  assert.equal(G.fmtSeconds(120), "2 min");
  assert.equal(G.fmtSeconds(3780), "1 h 3 min");
  assert.equal(G.fmtSeconds(-4), "0 s");
});

// ── Start ─────────────────────────────────────────────────────────────────

check("after create, the objective is sent only when omp did not start a goal turn itself", () => {
  // Continuation on (measured): get_state right after create is streaming / unsettled.
  assert.equal(G.ompStartedTurn({ isStreaming: true, isSettled: false }), true);
  assert.equal(G.ompStartedTurn({ isStreaming: false, isSettled: false }), true);
  // A background job leaves the session unsettled without starting a turn:
  // the objective must still be sent.
  assert.equal(G.ompStartedTurn({ isStreaming: false, isSettled: false, hasPendingAsyncWork: true }), false);
  assert.equal(G.ompStartedTurn({ isStreaming: true, isSettled: false, hasPendingAsyncWork: true }), true);
  // Follow-ups an Esc left queued keep omp unsettled while idle, and omp
  // skips a continuation while any wait: the objective must still be sent.
  assert.equal(G.ompStartedTurn({ isStreaming: false, isSettled: false, queuedMessageCount: 1 }), false);
  assert.equal(G.ompStartedTurn({ isStreaming: false, isSettled: false, queuedMessageCount: 0 }), true);
  // Continuation off: idle and settled.
  assert.equal(G.ompStartedTurn({ isStreaming: false, isSettled: true }), false);
  assert.equal(G.ompStartedTurn(null), false);
});

check("only omp's hidden goal-continuation prompt marks a turn omp started for the goal", () => {
  assert.deepEqual(G.continuationRow({ role: "custom", customType: "goal-continuation", display: false }), { kind: "goal", event: "continue" });
  assert.equal(G.continuationRow({ role: "custom", customType: "goal-mode-context", display: false }), null);
  assert.equal(G.continuationRow({ role: "user", content: "goal-continuation" }), null);
  assert.equal(G.continuationRow(null), null);
});

check("rows show the final usage against the budget, the stop cause and the elapsed time", () => {
  const done = G.rowView({ kind: "goal", event: "complete", objective: "O", tokensUsed: 10340, tokenBudget: 50000, timeUsedSeconds: 51 });
  assert.equal(done.tone, "done");
  assert.deepEqual(done.chips, ["10,340 of 50,000 tokens", "51 s"]);
  const free = G.rowView({ kind: "goal", event: "complete", objective: "O", tokensUsed: 12, tokenBudget: null, timeUsedSeconds: 0 });
  assert.deepEqual(free.chips, ["12 tokens"]);
  const pausedRow = cause => G.rowView({ kind: "goal", event: "paused", tokensUsed: 1, tokenBudget: null, timeUsedSeconds: 0, cause });
  assert.notEqual(pausedRow("stop").detail, null);
  assert.equal(pausedRow(null).detail, null);
});

check("typed budgets accept k / M suffixes and separators, and reject anything not a positive integer", () => {
  assert.deepEqual(G.parseBudget(""), { ok: true, value: null });
  assert.deepEqual(G.parseBudget("300k"), { ok: true, value: 300000 });
  assert.deepEqual(G.parseBudget("1.5M"), { ok: true, value: 1500000 });
  // Decimal suffixed budgets that binary floating point does not hit exactly.
  assert.deepEqual(G.parseBudget("4.1M"), { ok: true, value: 4100000 });
  assert.deepEqual(G.parseBudget("16.1k"), { ok: true, value: 16100 });
  assert.deepEqual(G.parseBudget("2.01k"), { ok: true, value: 2010 });
  assert.equal(G.parseBudget("1.0005k").ok, false);
  assert.deepEqual(G.parseBudget("250,000"), { ok: true, value: 250000 });
  assert.deepEqual(G.parseBudget("1,000.5k"), { ok: true, value: 1000500 });
  // A decimal comma is not a thousands separator: refused, never read as 15M.
  assert.equal(G.parseBudget("1,5M").ok, false);
  assert.equal(G.parseBudget("2,5k").ok, false);
  assert.equal(G.parseBudget("25,00").ok, false);
  assert.equal(G.parseBudget("0").ok, false);
  assert.equal(G.parseBudget("1.5").ok, false);
  assert.equal(G.parseBudget("-5k").ok, false);
  assert.equal(G.parseBudget("lots").ok, false);
  assert.equal(G.budgetLabel(250000), "250k");
  assert.equal(G.budgetLabel(1500000), "1.5M");
  assert.equal(G.budgetLabel(12345), "12,345");
});

check("leaving goal mode in the composer forgets the chosen budget", () => {
  const on = G.withBudget(G.toggleGoalDraft(G.GOAL_DRAFT_IDLE), 250000);
  assert.equal(on.mode, true);
  assert.equal(G.toggleGoalDraft(on), G.GOAL_DRAFT_IDLE);
  assert.equal(G.enterGoalDraft(on), on);
});

check("plan mode and goal mode exclude each other", () => {
  const on = G.enterGoalDraft(G.GOAL_DRAFT_IDLE);
  // Goal mode on a tab without a goal: plan mode is off, the goal pill free.
  let gate = G.composerGate(on, G.NONE, false);
  assert.deepEqual([gate.mode, !!gate.goalBlocked, !!gate.planBlocked, gate.tint], [true, false, true, true]);
  // Plan mode on: no goal mode can start.
  gate = G.composerGate(G.GOAL_DRAFT_IDLE, G.NONE, true);
  assert.deepEqual([gate.mode, !!gate.goalBlocked, !!gate.planBlocked, gate.tint], [false, true, false, false]);
  // An open goal blocks both pills and overrides a leftover goal-mode draft.
  for (const status of ["active", "paused", "budget-limited"]) {
    gate = G.composerGate(on, known(goal({ status })), false);
    assert.deepEqual([gate.mode, !!gate.goalBlocked, !!gate.planBlocked], [false, true, true], status);
    assert.equal(gate.tint, status !== "paused", status);
  }
  // A completed goal blocks nothing.
  gate = G.composerGate(G.GOAL_DRAFT_IDLE, known(goal({ status: "complete" }), { enabled: false }), false);
  assert.deepEqual([gate.mode, gate.goalBlocked, gate.planBlocked, gate.tint], [false, "", "", false]);
});

// ---- use-goal-mode.jsx: a refused start hands the draft back ---------------

// The hook files compiled as index.html's Babel does (JSX only matters here),
// run under a React stand-in that keeps state per call position and runs
// effects during the render; the tests only talk to what the hooks return.
const Babel = createRequire(import.meta.url)(join(root, "src/babel.min.js"));
// eslint-disable-next-line no-new-func
new Function("window", readFileSync(join(root, "src/app/session-ui.js"), "utf8"))(win);
/** `file`'s code and a stand-in `React`; `render(call)` runs `call` as one render. */
function hookHarness(file, extraWindow, expr) {
  const slots = [];
  let i = 0;
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((v, k) => !Object.is(v, b[k]));
  const React = {
    createElement: () => null,
    useState(initial) {
      const k = i++;
      if (!(k in slots)) slots[k] = { value: initial };
      const s = slots[k];
      return [s.value, (v) => { s.value = typeof v === "function" ? v(s.value) : v; }];
    },
    useRef(initial) { const k = i++; return (slots[k] ??= { current: initial }); },
    useEffect(fn, deps) {
      const k = i++;
      if (!slots[k] || changed(slots[k].deps, deps)) { slots[k] = { deps }; fn(); }
    },
  };
  const { code } = Babel.transform(readFileSync(join(root, file), "utf8"), { presets: ["react"] });
  const window = { ...win, ...extraWindow };
  const exported = runInNewContext(`${code}\n${expr}`, { window, React });
  return { exported, window, render: (call) => { i = 0; return call(); } };
}
function goalHook() {
  // app/use-omp-setting.jsx's hook is covered by test-use-omp-setting.mjs: here it is an idle stand-in.
  const useOmpFlag = () => ({ value: null, busy: false, error: null, set: async () => {} });
  const { exported, render } = hookHarness("src/app/use-goal-mode.jsx",
    { GoalStrip: () => null, OMP_TURN_STATUS: { isBusyRunState: () => false }, useOmpFlag }, "useGoalMode");
  return (props) => render(() => exported(props));
}

/** Starts a goal on tab "a" that omp refuses once `after(render, props)` ran. */
async function refusedStart(after) {
  const render = goalHook();
  let refuse;
  const bridge = { goalStart: () => new Promise((resolve) => { refuse = () => resolve({ ok: false, error: "no" }); }) };
  const restored = [];
  const props = (tabId, sessionIds = ["a", "b"]) => ({
    bridge, tabId, sessionIds, goal: G.NONE, planMode: false, profileId: "p", runState: "idle",
    onRestoreDraft: (draft, where) => restored.push([draft, { ...where }]),
  });
  const draft = { text: "ship it", images: [], chips: [{ id: 1 }] };
  const started = render(props("a")).start(draft);
  after(render, props);
  refuse();
  await started;
  return { restored, draft };
}

async function checkAsync(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`FAILED: ${label}`);
    throw err;
  }
  passed++;
}

await checkAsync("a refused goal start hands its draft back to the tab still shown", async () => {
  const { restored, draft } = await refusedStart(() => {});
  assert.equal(restored.length, 1);
  assert.equal(restored[0][0], draft);
  assert.deepEqual(restored[0][1], { tabId: "a", shown: true });
});

// The chips were taken from tab a's browser: they go back to it although
// the composer shows tab b now (only the text stays out of b's composer).
await checkAsync("a refused goal start after a tab switch still hands the draft to its own tab, marked not shown", async () => {
  const { restored, draft } = await refusedStart((render, props) => render(props("b")));
  assert.equal(restored.length, 1);
  assert.equal(restored[0][0], draft);
  assert.deepEqual(restored[0][1], { tabId: "a", shown: false });
});

await checkAsync("a refused goal start of a tab closed meanwhile hands nothing back", async () => {
  const { restored } = await refusedStart((render, props) => render(props("b", ["b"])));
  assert.deepEqual(restored, []);
});

// ---- use-goal-mode.jsx: the goal row's switch is the generic omp-config hook (#92) ----

await checkAsync("useGoalContinuation runs the goal bridge calls through useOmpFlag, looked up when it is called", async () => {
  const { window, render } = hookHarness("src/app/use-goal-mode.jsx",
    { GoalStrip: () => null, OMP_TURN_STATUS: { isBusyRunState: () => false } }, "0");
  // app/use-omp-setting.jsx loads before this file in index.html but is read only
  // at call time: installing the stand-in after the file ran must be enough.
  const seen = [];
  window.useOmpFlag = (bridge, profileId, active, ops) => { seen.push({ bridge, profileId, active }); return { ops }; };
  const calls = [];
  const bridge = {
    goalContinuation: (profile) => { calls.push(["get", profile]); return "read reply"; },
    setGoalContinuation: (profile, enabled) => { calls.push(["set", profile, enabled]); return "write reply"; },
  };
  const { ops } = render(() => window.useGoalContinuation(bridge, "work", true));
  assert.deepEqual(seen, [{ bridge, profileId: "work", active: true }]);
  assert.equal(ops.read(bridge, "work"), "read reply");
  assert.equal(ops.write(bridge, "work", true), "write reply");
  assert.deepEqual(calls, [["get", "work"], ["set", "work", true]]);
  // The hook keys its fetch on `ops`: it must be the same object on every render.
  assert.equal(render(() => window.useGoalContinuation(bridge, "work", true)).ops, ops);
});

console.log(`test-goal: ${passed} checks passed`);
