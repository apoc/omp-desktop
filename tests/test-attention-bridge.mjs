#!/usr/bin/env node
// Bridge regression: a background tab's run dot follows Rust's tracker
// (`agent://attention`, src-tauri/src/remote/tracker.rs) and a new question
// bounces the dock once. Protective consumers read the separate guard state,
// which a tracker report may raise but never lower. Loads the real
// live.js/turn-status.js/attention.js into a stubbed Tauri.
// Run: node tests/test-attention-bridge.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const load = (win, file) => new Function("window", readFileSync(`${root}src/${file}`, "utf8"))(win);

let focused = false;
globalThis.document = { hasFocus: () => focused, visibilityState: "visible" };

function harness(initial = null, { wireGuardsToDisplay = false, dropTrackerSettle = false, dropBusyRecheck = false } = {}) {
  const listeners = new Map(), journal = new Map(), bounces = [], commands = [], sent = [], guardCalls = [];
  const initialRef = { snapshot: initial };
  // The fake approval-mode store: `start_session` resolves the mode its
  // folder maps to, as Rust's `ApprovalModeStore::resolve` does, so a
  // restart's recorded `approvalMode` is the one a real spawn would carry.
  const modes = { default: "write", projects: {} };
  const modeView = () => ({ default: modes.default, projects: { ...modes.projects } });
  const w = {
    OMP_SLASH: { LOCAL_COMMANDS: [], adaptAvailableCommands: cs => cs, mergeSlashCommands: (a) => a, isCommandInvocation: () => false, queuedFrame: () => null },
    OMP_SUBAGENTS: { emptySubagents: () => ({}), subscriptionLevelFor: () => "progress", mergeSnapshots: () => ({}) },
    OMP_EXT_WIDGETS: { EMPTY: {} },
    OMP_TWEAKS_STORE: { read: () => ({}) },
    // adapter.js's context breakdown; a get_state response needs one.
    buildCtx: () => ({}),
    DEFAULT_PROFILE_ID: "default", INTENT_FRAMING: () => "", timeNow: () => "00:00",
  };
  for (const file of ["app/live-voice.js", "app/turn-status.js", "app/attention.js", "app/ask-dialog.js", "app/project-nav.js",
    "app/transcript-merge.js", "app/stream-delta.js", "app/approval.js", "app/live-context.js", "app/approval-mode.js", "app/session-title.js",
    "app/session-prefs.js", "app/message-queue.js", "app/goal.js", "app/prompt-history.js"]) load(w, file);
  const timeout = (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; };
  let liveSource = readFileSync(`${root}src/live.js`, "utf8");
  if (wireGuardsToDisplay) {
    // Counter-probe: make every guard read the dot's state. The guard
    // regression below must then observe the unprotected behaviour.
    const before = liveSource;
    liveSource = liveSource.replace(
      "runState: TURN.guardRunState(cached, live, trackerLoaded),",
      "runState: s.id === activeSessionId ? cached : TURN.displayRunState(cached, live, trackerLoaded, _trackerEvidenceNewer(s.id, snapshot?.trackerEvidence ?? null)),",
    );
    if (liveSource === before) throw new Error("counter-probe patch did not apply");
  }
  if (dropTrackerSettle) {
    // Counter-probe: drop the tracker's idle hook. A change deferred while
    // the tracker still held its busy report must then never apply.
    const before = liveSource;
    liveSource = liveSource.replace(
      "    // ever get. A still-busy guard defers inside the shared evaluation.\n    _applySettledApprovalModes();\n",
      "",
    );
    if (liveSource === before) throw new Error("counter-probe patch did not apply");
  }
  if (dropBusyRecheck) {
    // Counter-probe: remove the pre-kill guard recheck. A restart that went
    // busy inside its dictation-stop await must then kill the working tab.
    const before = liveSource;
    liveSource = liveSource.replace(
      /      \/\/ Busy-guard recheck[\s\S]*?return \{ ok: false, busy: true, error: "tab became busy" \};\n      \}\n/,
      "",
    );
    if (liveSource === before) throw new Error("counter-probe patch did not apply");
  }
  new Function("window", "setTimeout", "clearTimeout", liveSource)(w, timeout, clearTimeout);
  w.__TAURI__ = {
    core: {
      invoke(command, args) {
        commands.push({ command, args });
        if (command === "set_close_guard") {
          guardCalls.push(args?.armed === true);
          return Promise.resolve(null);
        }
        if (command === "list_profiles") return Promise.resolve({ profiles: [{ id: "default", name: "default" }] });
        if (command === "start_session") {
          const cwd = args?.args?.cwd;
          return Promise.resolve(modes.projects[cwd] ?? modes.default);
        }
        if (command === "approval_mode_get") return Promise.resolve(modeView());
        if (command === "approval_mode_set_default") {
          modes.default = args.mode;
          return Promise.resolve(modeView());
        }
        if (command === "approval_mode_set_project") {
          if (args.mode) modes.projects[args.projectRoot] = args.mode;
          else delete modes.projects[args.projectRoot];
          return Promise.resolve(modeView());
        }
        if (command === "attention_snapshot") {
          // Resolved by `tick`, so a test can seed the answer after the tab id
          // exists — that is when the real backend reply is in flight.
          return new Promise(resolve => pendingInitial.push(() => resolve(initialRef.snapshot)));
        }
        if (command === "replay_events") return Promise.resolve({ dropped: false, events: (journal.get(args.sessionId) ?? []).filter(e => e.seq > args.afterSeq) });
        if (command === "send_command") {
          sent.push({ ...JSON.parse(args.json), sessionId: args.sessionId });
          return Promise.resolve(null);
        }
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
  let revision = initial?.revision ?? 0;
  const pendingInitial = [];
  function attention(sessions, at = ++revision) {
    revision = Math.max(revision, at);
    listeners.get("agent://attention")?.({ payload: { revision: at, sessions } });
  }
  function fire(name, payload) {
    listeners.get(name)?.({ payload });
  }
  // Answer a command captured in `sent` (its RPC id correlates it), as the
  // fake bridge does for a pending `dictation_stop`.
  function reply(cmd, success = true, data = null) {
    emit(cmd.sessionId, { type: "response", command: cmd.type, id: cmd.id, success, data });
  }
  const runState = id => snapshot?.sessions.find(s => s.id === id)?.runState;
  const displayRunState = id => snapshot?.sessions.find(s => s.id === id)?.displayRunState;
  const armed = () => guardCalls.at(-1) ?? null;
  const setInitial = next => { initialRef.snapshot = next; };
  const tick = async () => {
    while (pendingInitial.length > 0) pendingInitial.shift()();
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  return {
    bridge: w.OMP_BRIDGE, emit, attention, fire, reply, sent, runState, displayRunState, armed, commands,
    bounces, setInitial, tick, getSnapshot: () => snapshot,
  };
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

/** Let promise chains and fire-and-forget restarts run to completion. */
const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise(resolve => setTimeout(resolve, 0));
};

await check("a question in a background tab shows waiting-user, then clears on the tracker", async () => {
  focused = false;
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  await h.bridge.activateSession(a);
  h.emit(a, { type: "agent_start" });
  h.emit(a, { type: "turn_start" });
  await h.bridge.activateSession(b); // the user looks at another tab; A freezes mid-turn
  assert.equal(h.displayRunState(a), "running");

  // Rust's tracker saw A's ask (a background tab has no line listener).
  h.attention({ [a]: { busy: true, asks: 1, background: false }, [b]: { busy: false, asks: 0, background: false } });
  assert.equal(h.displayRunState(a), "waiting-user", "the background tab's dot shows the new ask");
  assert.equal(h.displayRunState(b), "idle", "the active tab is untouched");

  // The ask was cancelled/timed out and the turn ended: no stale orange.
  h.attention({ [a]: { busy: false, asks: 0, background: false }, [b]: { busy: false, asks: 0, background: false } });
  assert.equal(h.displayRunState(a), "idle", "a stale waiting-user clears when the ask is gone");
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
  assert.equal(h.displayRunState(a), "running");
  h.attention({ [a]: { busy: false, asks: 0, background: true } });
  assert.equal(h.displayRunState(a), "background");
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
  assert.equal(h.displayRunState(a), "failed", "a dead process outranks an ask left open");
});

await check("counter-probe: without the overlay the frozen snapshot stays wrong", async () => {
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  await h.bridge.activateSession(a);
  h.emit(a, { type: "agent_start" });
  h.emit(a, { type: "turn_start" });
  await h.bridge.activateSession(b);
  const frozen = h.displayRunState(a);
  assert.equal(frozen, "running", "the snapshot froze mid-turn");
  h.attention({ [a]: { busy: false, asks: 0, background: false } });
  assert.equal(h.displayRunState(a), "idle");
  assert.notEqual(h.displayRunState(a), frozen, "the overlay is what clears the stale dot");
});

await check("a new ask bounces the dock once, and not while focused", async () => {
  focused = false;
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  await h.bridge.activateSession(a);
  const idle = { [a]: { busy: true, asks: 0, asksOpened: 0, background: false } };
  h.attention(idle); // first snapshot: nothing new to announce
  assert.deepEqual(h.bounces, []);
  const asking = { [a]: { busy: true, asks: 1, asksOpened: 1, background: false } };
  h.attention(asking);
  assert.deepEqual(h.bounces, [2], "one Informational bounce");
  h.attention({ [a]: { busy: true, asks: 1, asksOpened: 1, background: false } }); // same ask, new snapshot
  assert.deepEqual(h.bounces, [2], "not again for an unchanged ask");
  h.attention({ [a]: { busy: true, asks: 2, asksOpened: 2, background: false } }); // a second form field
  assert.deepEqual(h.bounces, [2, 2], "a new question bounces again");
  focused = true;
  h.attention({ [a]: { busy: true, asks: 3, asksOpened: 3, background: false } });
  assert.deepEqual(h.bounces, [2, 2], "a focused window already shows the dot");
  focused = false;
});

await check("answering one question while another opens in the batch bounces", async () => {
  focused = false;
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  await h.bridge.activateSession(a);
  h.attention({ [a]: { busy: true, asks: 1, asksOpened: 1, background: false } });
  assert.deepEqual(h.bounces, [], "the first snapshot is not new");
  // `asks` stays 1: one answered, one opened in the same coalesced change.
  h.attention({ [a]: { busy: true, asks: 1, asksOpened: 2, background: false } });
  assert.deepEqual(h.bounces, [2], "P2: the new question still bounces");
});

await check("the initial read is ordered and never bounces", async () => {
  focused = false;
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  h.setInitial({ revision: 9, sessions: { [a]: { busy: true, asks: 1, asksOpened: 4, background: false } } });
  await h.bridge.activateSession(a);
  await h.tick();
  assert.deepEqual(h.bounces, [], "a reload's open ask is not a new ask");
  await h.bridge.activateSession(b);
  assert.equal(h.displayRunState(a), "waiting-user", "the initial snapshot seeded the background dot");
  // A late event carrying an older revision is ignored, dot and bounce alike.
  h.attention({ [a]: { busy: false, asks: 0, asksOpened: 0, background: false } }, 8);
  assert.equal(h.displayRunState(a), "waiting-user", "an older snapshot cannot roll the dot back");
  assert.deepEqual(h.bounces, []);
  h.attention({ [a]: { busy: false, asks: 0, asksOpened: 0, background: false } }, 10);
  assert.equal(h.displayRunState(a), "idle", "a newer revision does apply");
  assert.deepEqual(h.bounces, [], "an answered ask does not bounce");
});

await check("a newer initial reply applies without bouncing the dock", async () => {
  focused = false;
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  // A live event lands while the `attention_snapshot` read is still out.
  h.attention({ [a]: { busy: true, asks: 0, asksOpened: 0, background: false } }, 1);
  // The read comes back newer than that event, with an ask already open.
  h.setInitial({ revision: 2, sessions: { [a]: { busy: true, asks: 1, asksOpened: 5, background: false } } });
  await h.tick();
  assert.deepEqual(h.bounces, [], "a page load's open ask is not a new ask");
  await h.bridge.activateSession(b);
  assert.equal(h.displayRunState(a), "waiting-user", "the newer reply did apply");
});

await check("a delayed event for a closed tab neither sets a dot nor bounces", async () => {
  focused = false;
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  await h.bridge.activateSession(a);
  h.attention({ [a]: { busy: false, asks: 0, asksOpened: 0, background: false },
    [b]: { busy: false, asks: 0, asksOpened: 0, background: false } });
  assert.deepEqual(await h.bridge.closeSession(a), true);
  // The tracker's exit cleanup and a queued fan-out event race the close.
  h.attention({ [a]: { busy: true, asks: 1, asksOpened: 1, background: false },
    [b]: { busy: false, asks: 0, asksOpened: 0, background: false } });
  assert.deepEqual(h.bounces, [], "P2: a closed tab must not bounce");
  assert.equal(h.displayRunState(a), undefined, "the tab is gone");
});

await check("an exited background process retires its stale ask", async () => {
  focused = false;
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  await h.bridge.activateSession(a);
  h.emit(a, { type: "extension_ui_request", id: "q1", method: "input", title: "Your name" });
  assert.equal(h.displayRunState(a), "waiting-user");
  await h.bridge.activateSession(b);
  assert.equal(h.displayRunState(a), "waiting-user", "the frozen snapshot keeps the ask");
  // The tracker still has the process, so the ask stands.
  h.attention({ [a]: { busy: true, asks: 1, asksOpened: 1, background: false } });
  assert.equal(h.displayRunState(a), "waiting-user");
  // The process exited: Rust removed its entry. The frozen ask must go.
  h.attention({});
  assert.equal(h.displayRunState(a), "idle", "P2: no entry means the process is gone");
});

await check("a frozen run survives an empty tracker snapshot until evidence arrives", async () => {
  focused = false;
  const h = harness({ revision: 1, sessions: {} });
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  await h.bridge.activateSession(a);
  await h.tick(); // the initial read lands: loaded, but no entry for A yet
  h.emit(a, { type: "agent_start" });
  h.emit(a, { type: "turn_start" });
  await h.bridge.activateSession(b); // A freezes mid-turn; its busy fan-out is in flight
  assert.equal(h.displayRunState(a), "running", "absence alone does not prove the process exited");

  await h.bridge.setSessionPrefs({ confirmBusyClose: true });
  const closing = h.bridge.closeSessionGuarded(a);
  let settled = false;
  void closing.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(settled, false, "P1: a busy tab asks before closing");
  assert.equal(h.getSnapshot()?.closeConfirm?.kind, "tab", "the busy prompt names the tab");
  h.bridge.resolveCloseConfirm(false);
  assert.equal(await closing, false, "the user kept the tab");
  assert.equal(h.displayRunState(a), "running", "the tab still exists, still busy");

  // The tracker's report for the same frame lands: the dot agrees, and the
  // tab stays busy for the guard.
  h.attention({ [a]: { busy: true, asks: 0, asksOpened: 0, background: false } });
  assert.equal(h.displayRunState(a), "running");
});

await check("a newer removal retires the dot but not the guard", async () => {
  focused = false;
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  await h.bridge.activateSession(a);
  h.emit(a, { type: "agent_start" });
  h.emit(a, { type: "turn_start" });
  h.attention({ [a]: { busy: true, asks: 0, asksOpened: 0, background: false } }, 1);
  await h.bridge.activateSession(b);
  assert.equal(h.displayRunState(a), "running", "frozen mid-turn");
  h.attention({}, 2); // the process exited: Rust removed its entry
  assert.equal(h.displayRunState(a), "idle", "a removal after the freeze retires the dot");
  assert.equal(h.runState(a), "running", "the guard keeps the frozen run");
  await h.bridge.setSessionPrefs({ confirmBusyClose: true });
  assert.equal(h.armed(), true, "the quit guard stays armed");
  const closing = h.bridge.closeSessionGuarded(a);
  let settled = false;
  void closing.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(settled, false, "the frozen tab still asks before closing");
  assert.equal(h.getSnapshot()?.closeConfirm?.kind, "tab", "the prompt names the tab");
  h.bridge.resolveCloseConfirm(false);
  assert.equal(await closing, false, "the user kept the tab");
});

await check("guards stay armed when a delayed idle reply lowers the dot", async () => {
  focused = false;
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  await h.bridge.activateSession(a);
  // The initial `attention_snapshot` read was captured while A was idle and
  // is still in flight: nothing has been applied at the freeze.
  h.setInitial({ revision: 1, sessions: {
    [a]: { busy: false, asks: 0, asksOpened: 0, background: false },
    [b]: { busy: false, asks: 0, asksOpened: 0, background: false },
  } });
  h.emit(a, { type: "agent_start" });
  h.emit(a, { type: "turn_start" });
  await h.bridge.activateSession(b); // A freezes mid-turn
  await h.tick();                    // the delayed idle reply lands first
  await h.tick();
  assert.equal(h.displayRunState(a), "idle", "the delayed reply lowers the dot");
  assert.equal(h.runState(a), "running", "the guard keeps the frozen run");

  await h.bridge.setSessionPrefs({ confirmBusyClose: true });
  assert.equal(h.armed(), true, "quit guard stays armed");

  const closing = h.bridge.closeSessionGuarded(a);
  let settled = false;
  void closing.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(settled, false, "the busy prompt appears");
  assert.equal(h.getSnapshot()?.closeConfirm?.kind, "tab", "the prompt names the tab");
  h.bridge.resolveCloseConfirm(false);
  assert.equal(await closing, false, "the user kept the tab");

  const changed = await h.bridge.setApprovalModeProject("/alpha", "yolo");
  assert.deepEqual(changed.deferred, [a], "the approval-mode change defers the tab");
  assert.equal(changed.restarted.includes(a), false, "the working tab was not restarted");
  assert.equal(h.commands.some(c => c.command === "stop_session" && c.args.sessionId === a), false);
});

await check("a deferred approval change applies when the tracker settles the guard", async () => {
  focused = false;
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  await h.bridge.activateSession(a);
  const stops = () => h.commands.filter(c => c.command === "stop_session" && c.args.sessionId === a).length;
  const modeOf = id => h.getSnapshot()?.sessions.find(s => s.id === id)?.approvalMode;

  h.emit(a, { type: "turn_start" });
  h.attention({ [a]: { busy: true, asks: 0, asksOpened: 0, background: false } }, 1);
  const changed = await h.bridge.setApprovalModeProject("/alpha", "always-ask");
  assert.equal(changed.ok, true);
  assert.deepEqual(changed.deferred, [a], "the busy tab defers the change");
  assert.deepEqual(changed.restarted, [], "and is not restarted mid-turn");
  assert.equal(stops(), 0, "no restart while the turn runs");

  // The run ends: the tab's own state is idle now, but the tracker still
  // holds its busy report, so the combined guard stays busy.
  h.emit(a, { type: "turn_end" });
  h.emit(a, { type: "response", command: "get_state", success: true, data: { isStreaming: false } });
  assert.equal(h.runState(a), "running", "the tracker still holds the guard busy");
  assert.equal(stops(), 0, "the settled get_state defers again");
  assert.equal(modeOf(a), "write", "still the old process");

  // The tracker's report settles the guard: the pending change applies now.
  h.attention({ [a]: { busy: false, asks: 0, asksOpened: 0, background: false } }, 2);
  await flush();
  assert.equal(h.runState(a), "idle");
  assert.equal(stops(), 1, "exactly one restart");
  assert.equal(modeOf(a), "always-ask", "the new process runs always-ask");

  // The restart is done before the next prompt goes out.
  assert.equal(await h.bridge.send("next prompt"), true);
  const restartIdx = h.commands.findLastIndex(c => c.command === "start_session" && c.args.args.sessionId === a);
  const promptIdx = h.commands.findLastIndex(c =>
    c.command === "send_command" && JSON.parse(c.args.json).type === "prompt");
  assert.ok(restartIdx !== -1 && promptIdx > restartIdx, "the restart precedes the prompt");
  assert.equal(h.commands[promptIdx].args.sessionId, a, "the prompt went to the restarted tab");

  // A later, unchanged idle report is not another restart.
  h.attention({ [a]: { busy: false, asks: 0, asksOpened: 0, background: false } }, 3);
  await flush();
  assert.equal(stops(), 1, "one restart per pending change");
});

await check("counter-probe: without the tracker hook the deferred change never applies", async () => {
  focused = false;
  const h = harness(null, { dropTrackerSettle: true });
  const a = await h.bridge.openSession("/alpha");
  await h.bridge.activateSession(a);
  const stops = () => h.commands.filter(c => c.command === "stop_session" && c.args.sessionId === a).length;

  h.emit(a, { type: "turn_start" });
  h.attention({ [a]: { busy: true, asks: 0, asksOpened: 0, background: false } }, 1);
  const changed = await h.bridge.setApprovalModeProject("/alpha", "always-ask");
  assert.deepEqual(changed.deferred, [a], "the busy tab defers the change");

  h.emit(a, { type: "turn_end" });
  h.emit(a, { type: "response", command: "get_state", success: true, data: { isStreaming: false } });
  h.attention({ [a]: { busy: false, asks: 0, asksOpened: 0, background: false } }, 2);
  await flush();
  assert.equal(h.runState(a), "idle", "the guard settled through the tracker");
  assert.equal(stops(), 0, "P1: the change never applies");
  assert.equal(h.getSnapshot()?.sessions.find(s => s.id === a)?.approvalMode, "write",
    "P1: the next prompt still reaches a process in write mode");
});

await check("a restart that goes busy in its dictation stop is deferred, then applies once", async () => {
  focused = false;
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  await h.bridge.activateSession(a);
  const stops = () => h.commands.filter(c => c.command === "stop_session" && c.args.sessionId === a).length;
  const modeOf = id => h.getSnapshot()?.sessions.find(s => s.id === id)?.approvalMode;
  const idle = rev => h.attention({ [a]: { busy: false, asks: 0, asksOpened: 0, background: false } }, rev);
  const running = rev => h.attention({ [a]: { busy: true, asks: 0, asksOpened: 0, background: false } }, rev);

  // Dictation is recording in the active tab; the tracker reports it idle.
  const starting = h.bridge.dictationStart();
  await flush(2);
  const startCmd = h.sent.find(c => c.type === "dictation_start");
  assert.ok(startCmd, "the dictation start was sent");
  h.reply(startCmd);
  assert.deepEqual(await starting, { ok: true });
  idle(1);

  // The mode change starts the restart, which must first stop the dictation:
  // `dictation_stop` is sent and its answer is still pending.
  const changing = h.bridge.setApprovalModeProject("/alpha", "always-ask");
  await flush();
  const stopCmd = h.sent.find(c => c.type === "dictation_stop");
  assert.ok(stopCmd, "the restart waits for the dictation stop");
  assert.equal(stops(), 0, "nothing is killed while the dictation stop is pending");

  // The tracker reports a new run inside that round-trip: the guard the
  // restart read as idle is busy again.
  running(2);
  assert.equal(h.runState(a), "running", "the tracker raised the guard");
  h.reply(stopCmd, true, { text: "draft" });
  await flush();
  const result = await changing;
  assert.deepEqual(result, { ok: true, restarted: [], deferred: [a] },
    "the attempt aborts, the change stays pending");
  assert.equal(stops(), 0, "no stop_session for a tab that went busy again");
  assert.equal(modeOf(a), "write", "the working process survives");

  // Its next idle point applies the change, exactly once.
  idle(3);
  await flush();
  assert.equal(stops(), 1, "exactly one restart at the next idle point");
  assert.equal(modeOf(a), "always-ask", "the new process runs the new mode");
  idle(4);
  await flush();
  assert.equal(stops(), 1, "one restart per pending change");
});

await check("counter-probe: without the pre-kill recheck the busy tab is killed", async () => {
  focused = false;
  const h = harness(null, { dropBusyRecheck: true });
  const a = await h.bridge.openSession("/alpha");
  await h.bridge.activateSession(a);
  const stops = () => h.commands.filter(c => c.command === "stop_session" && c.args.sessionId === a).length;
  const modeOf = id => h.getSnapshot()?.sessions.find(s => s.id === id)?.approvalMode;

  const starting = h.bridge.dictationStart();
  await flush(2);
  h.reply(h.sent.find(c => c.type === "dictation_start"));
  await starting;
  h.attention({ [a]: { busy: false, asks: 0, asksOpened: 0, background: false } }, 1);

  const changing = h.bridge.setApprovalModeProject("/alpha", "always-ask");
  await flush();
  const stopCmd = h.sent.find(c => c.type === "dictation_stop");
  assert.ok(stopCmd, "the restart waits for the dictation stop");
  h.attention({ [a]: { busy: true, asks: 0, asksOpened: 0, background: false } }, 2);

  h.reply(stopCmd, true, { text: "draft" });
  await flush();
  const result = await changing;
  assert.equal(result.restarted.includes(a), true, "P1: the busy tab is restarted mid-work");
  assert.equal(stops(), 1, "P1: the working process was stopped");
  assert.equal(modeOf(a), "always-ask", "P1: the new mode replaced the working process");
});

await check("counter-probe: wiring guards to the dot reopens the P1 hole", async () => {
  focused = false;
  // Both guard reads are wired to the dot: the plan's (`wireGuardsToDisplay`)
  // and the pre-kill recheck, which would otherwise catch the frozen run on
  // its own (`_tabBusy` still reads the real guard).
  const h = harness(null, { wireGuardsToDisplay: true, dropBusyRecheck: true });
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  await h.bridge.activateSession(a);
  h.setInitial({ revision: 1, sessions: {
    [a]: { busy: false, asks: 0, asksOpened: 0, background: false },
    [b]: { busy: false, asks: 0, asksOpened: 0, background: false },
  } });
  h.emit(a, { type: "agent_start" });
  h.emit(a, { type: "turn_start" });
  await h.bridge.activateSession(b);
  await h.tick();
  await h.tick();
  assert.equal(h.runState(a), "idle", "guards wired to the dot see idle");
  await h.bridge.setSessionPrefs({ confirmBusyClose: true });
  assert.equal(h.armed(), false, "the quit guard is disarmed");
  const changed = await h.bridge.setApprovalModeProject("/alpha", "yolo");
  assert.equal(changed.deferred.includes(a), false, "the tab is not deferred");
  assert.equal(h.commands.some(c => c.command === "stop_session" && c.args.sessionId === a), true, "the working tab is restarted");
  assert.equal(await h.bridge.closeSessionGuarded(a), true, "the tab closes without the busy prompt");
});

await check("a frozen retry row does not outlive the run it belongs to", async () => {
  focused = false;
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  await h.bridge.activateSession(a);
  h.emit(a, { type: "agent_start" });
  h.emit(a, { type: "auto_retry_start", errorMessage: "boom", attempt: 1, maxAttempts: 3, delayMs: 1000 });
  h.attention({ [a]: { busy: true, asks: 0, asksOpened: 0, background: false } }, 1);
  await h.bridge.activateSession(b);
  assert.equal(h.displayRunState(a), "retrying", "the frozen retry row shows while the tracker has not moved");

  // An identical entry at a newer revision is not a change: the row stands.
  h.attention({ [a]: { busy: true, asks: 0, asksOpened: 0, background: false } }, 2);
  assert.equal(h.displayRunState(a), "retrying", "an unchanged busy entry keeps the retry row");

  // The retries gave up and the agent yielded with background work pending.
  h.attention({ [a]: { busy: false, asks: 0, asksOpened: 0, background: true } }, 3);
  assert.equal(h.displayRunState(a), "background", "the yield ends the retries");
  // An ordinary new wake starts a run: not the old retry row again.
  h.attention({ [a]: { busy: true, asks: 0, asksOpened: 0, background: false } }, 4);
  assert.equal(h.displayRunState(a), "running", "P2: a new wake is running, not the old retry");
});

console.log(`test-attention-bridge: ${passed} checks passed`);
