#!/usr/bin/env node
// Bridge regression: a background tab's run dot follows Rust's tracker
// (`agent://attention`, src-tauri/src/remote/tracker.rs) and a new question
// bounces the dock once; its guard `runState` (quit and tab-close
// confirmation, the close guard, approval-mode restarts, the updater) is
// the raise-only union of its frozen state and that dot (#89). Approval
// restarts go through Rust's conditional stop (`stop_session_if_idle`),
// and a prompt sent while the tab's omp restarts is refused, draft kept.
// A turn end or new question plays a notification sound (#91: the
// `notify_sound_play` invoke, app/notify-sound.js), for any tab.
// Loads the real live.js/turn-status.js/attention.js into a stubbed Tauri
// whose fake tracker answers `attention_snapshot` and the conditional stop.
// Run: node tests/test-attention-bridge.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = fileURLToPath(new URL("..", import.meta.url));
const load = (win, file) => new Function("window", readFileSync(`${root}src/${file}`, "utf8"))(win);

let focused = false;
globalThis.document = { hasFocus: () => focused, visibilityState: "visible", readyState: "complete", addEventListener: () => {},
  documentElement: { classList: { add: () => {} } } };

/** Rust's tracker counts a session at work while busy, asking or holding
 *  background work (`SessionSnapshot::at_work`). */
const atWork = e => !!e && (e.busy || e.asks > 0 || e.background);

// `unguarded`: counter-probe that restores the pre-#89 guard (`runState`
// = the frozen state alone). `boot`: Tauri exists while live.js loads, so
// its startup wiring (the `window://close-requested` listener) runs.
function harness(initial = null, { unguarded = false, boot = false, tweaks = {} } = {}) {
  const listeners = new Map(), journal = new Map(), bounces = [], commands = [], sent = [], guardCalls = [], closes = [];
  const initialRef = { snapshot: initial };
  // The fake approval-mode store: `start_session` resolves the mode its
  // folder maps to, as Rust's `ApprovalModeStore::resolve` does, so a
  // restart's recorded `approvalMode` is the one a real spawn would carry.
  const modes = { default: "write", projects: {} };
  const modeView = () => ({ default: modes.default, projects: { ...modes.projects } });
  // Rust's tracker: what `attention()` publishes, or what `setRust` changed
  // before its event reached the webview.
  const rust = { revision: initial?.revision ?? 0, sessions: initial?.sessions ?? {} };
  let initialAnswered = false;
  // `holdStart()` / `holdStop()`: the next `start_session` /
  // `stop_session_if_idle` waits for its `release()`.
  let startHold = null, stopHold = null;
  const w = {
    OMP_SLASH: { LOCAL_COMMANDS: [], adaptAvailableCommands: cs => cs, mergeSlashCommands: (a) => a, isCommandInvocation: () => false,
      queuedFrame: (kind, message) => ({ type: kind === "steer" ? "steer" : "follow_up", message }) },
    OMP_SUBAGENTS: { emptySubagents: () => ({}), subscriptionLevelFor: () => "progress", mergeSnapshots: () => ({}) },
    OMP_EXT_WIDGETS: { EMPTY: {} },
    OMP_TWEAKS_STORE: { read: () => tweaks },
    // Only the sound defaults: PREFS reads its own keys as off without them.
    TWEAK_DEFAULTS: { notifySound: "off", soundAttention: "bell", soundFinished: "chime", soundVolume: 60 },
    // adapter.js's context breakdown; a get_state response needs one.
    buildCtx: () => ({}),
    DEFAULT_PROFILE_ID: "default", INTENT_FRAMING: () => "", timeNow: () => "00:00",
  };
  for (const file of ["app/live-voice.js", "app/turn-status.js", "app/attention.js", "app/notify-sound.js", "app/ask-dialog.js", "app/project-nav.js",
    "app/transcript-merge.js", "app/stream-delta.js", "app/approval.js", "app/live-context.js", "app/approval-mode.js", "app/session-title.js",
    "app/session-prefs.js", "app/message-queue.js", "app/goal.js", "app/prompt-history.js"]) load(w, file);
  const timeout = (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; };
  let liveSource = readFileSync(`${root}src/live.js`, "utf8");
  if (unguarded) {
    const before = liveSource;
    liveSource = liveSource.replace("runState: TURN.guardRunState(cached, display),", "runState: cached,");
    if (liveSource === before) throw new Error("counter-probe patch did not apply");
  }
  const pendingInitial = [];
  const tauri = {
    core: {
      invoke(command, args) {
        commands.push({ command, args });
        if (command === "set_close_guard") {
          guardCalls.push(args?.armed === true);
          return Promise.resolve(null);
        }
        if (command === "list_profiles") return Promise.resolve({ profiles: [{ id: "default", name: "default" }] });
        if (command === "start_session") {
          const mode = modes.projects[args?.args?.cwd] ?? modes.default;
          if (startHold) {
            const hold = startHold;
            startHold = null;
            return new Promise(resolve => { hold.release = () => resolve(mode); });
          }
          return Promise.resolve(mode);
        }
        if (command === "stop_session_if_idle") {
          const answer = () => {
            if (atWork(rust.sessions[args.sessionId])) return { stopped: false, busy: true };
            journal.delete(args.sessionId);
            return { stopped: true, busy: false };
          };
          if (stopHold) {
            const hold = stopHold;
            stopHold = null;
            return new Promise(resolve => { hold.release = () => resolve(answer()); });
          }
          return Promise.resolve(answer());
        }
        if (command === "stop_session") { journal.delete(args.sessionId); return Promise.resolve(null); }
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
          // The page's first read is resolved by `tick`, so a test can seed
          // the answer after the tab id exists — that is when the real
          // backend reply is in flight. A guard's later refresh answers with
          // the tracker as it is now.
          if (initialAnswered) return Promise.resolve({ revision: rust.revision, sessions: { ...rust.sessions } });
          initialAnswered = true;
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
      getCurrentWindow: () => ({
        requestUserAttention: type => { bounces.push(type); return Promise.resolve(); },
        close: () => { closes.push(true); return Promise.resolve(); },
      }),
    },
  };
  if (boot) w.__TAURI__ = tauri;
  new Function("window", "setTimeout", "clearTimeout", liveSource)(w, timeout, clearTimeout);
  w.__TAURI__ = tauri;
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
  function attention(sessions, at = ++revision) {
    revision = Math.max(revision, at);
    if (at >= rust.revision) { rust.revision = at; rust.sessions = sessions; }
    listeners.get("agent://attention")?.({ payload: { revision: at, sessions } });
  }
  /** The tracker changed in Rust; its event has not reached the webview. */
  function setRust(sessions) {
    revision = rust.revision = Math.max(revision, rust.revision) + 1;
    rust.sessions = sessions;
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
  const setInitial = next => {
    initialRef.snapshot = next;
    if (next) { rust.revision = Math.max(rust.revision, next.revision); rust.sessions = next.sessions; }
  };
  const tick = async () => {
    while (pendingInitial.length > 0) pendingInitial.shift()();
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  return {
    bridge: w.OMP_BRIDGE, emit, attention, setRust, fire, reply, sent, runState, displayRunState, armed, commands,
    bounces, setInitial, tick, getSnapshot: () => snapshot, closes,
    /** What the sound module asked Rust to play (`notify_sound_play`). */
    sounds: () => commands.filter(c => c.command === "notify_sound_play").map(c => c.args),
    guardArgs: () => commands.filter(c => c.command === "set_close_guard").at(-1)?.args ?? null,
    holdStart: () => { startHold = {}; return startHold; },
    holdStop: () => { stopHold = {}; return stopHold; },
    called: (command, id) => commands.some(c => c.command === command && c.args?.sessionId === id),
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

await check("a frozen ask retires when the tracker already closed it", async () => {
  focused = false;
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  await h.bridge.activateSession(a);
  h.emit(a, { type: "extension_ui_request", id: "q1", method: "input", title: "Your name" });
  assert.equal(h.displayRunState(a), "waiting-user");
  h.attention({ [a]: { busy: true, asks: 1, asksOpened: 1, background: false } }, 1);
  // omp's `cancel` reaches the tracker before the tab: the tracker closes the
  // ask, then the tab freezes without ever processing the cancel line, so the
  // stamp it records is the post-cancel revision and no later change comes.
  h.attention({ [a]: { busy: true, asks: 0, asksOpened: 1, background: false } }, 2);
  await h.bridge.activateSession(b);
  assert.equal(h.runState(a), "waiting-user", "the frozen snapshot still holds the ask");
  assert.equal(h.displayRunState(a), "running", "P2: the tracker's closed ask wins over the stale snapshot");
  // The pre-fix rule compared evidence revisions only, so an entry that had
  // not moved since the freeze let the orange dot stand forever.
  const preFix = (cached, live, fresh) => {
    const tracked = live.asks > 0 ? "waiting-user" : live.busy ? "running" : "idle";
    return fresh ? tracked : (["idle", "background", "running", "retrying", "waiting-user"].indexOf(tracked)
      > ["idle", "background", "running", "retrying", "waiting-user"].indexOf(cached) ? tracked : cached);
  };
  assert.equal(preFix("waiting-user", { busy: true, asks: 0 }, false), "waiting-user",
    "counter-probe: the stale orange dot the pre-fix rule kept");
  // An entry that never saw an ask proves nothing about the frozen one.
  h.attention({ [a]: { busy: true, asks: 0, asksOpened: 0, background: false } }, 3);
  assert.equal(h.displayRunState(a), "running", "a moved entry still owns the dot");
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
  // guard keeps the frozen run (it never read the tracker).
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

await check("a delayed idle reply lowers the dot; the frozen run keeps the guards and Rust refuses the restart", async () => {
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
  // Rust's tracker has A running by now; its event is still on the way.
  h.setRust({ [a]: { busy: true, asks: 0, asksOpened: 0, background: false },
    [b]: { busy: false, asks: 0, asksOpened: 0, background: false } });
  await h.bridge.activateSession(b); // A freezes mid-turn
  await h.tick();                    // the delayed idle reply lands first
  await h.tick();
  assert.equal(h.displayRunState(a), "idle", "the delayed reply lowers the dot");
  assert.equal(h.runState(a), "running", "the guard keeps the frozen run");

  await h.bridge.setSessionPrefs({ confirmBusyClose: true });
  assert.equal(h.armed(), true, "quit guard stays armed");

  const closing = h.bridge.closeSessionGuarded(a);
  await flush(2);
  assert.equal(h.getSnapshot()?.closeConfirm?.kind, "tab", "the busy prompt names the tab");
  h.bridge.resolveCloseConfirm(false);
  assert.equal(await closing, false, "the user kept the tab");

  const changed = await h.bridge.setApprovalModeProject("/alpha", "yolo");
  assert.deepEqual(changed.deferred, [a], "the approval-mode change defers the tab");
  assert.equal(changed.restarted.includes(a), false, "the working tab was not restarted");
  assert.equal(h.called("stop_session_if_idle", a), true, "Rust decided");
  assert.equal(h.called("stop_session", a), false);
});

await check("#89: a turn started after the tab was left makes the close, quit and window guards ask", async () => {
  focused = false;
  const h = harness(null, { boot: true });
  await flush(4);
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  await h.bridge.activateSession(a);
  await h.bridge.activateSession(b); // A froze at idle; a turn starts there via a phone or a queued prompt
  assert.equal(h.runState(a), "idle");
  h.attention({ [a]: { busy: true, asks: 0, asksOpened: 0, background: false },
    [b]: { busy: false, asks: 0, asksOpened: 0, background: false } });
  assert.equal(h.displayRunState(a), "running", "the dot follows the run the frozen snapshot never saw");
  assert.equal(h.runState(a), "running", "and so does the guard");

  await h.bridge.setSessionPrefs({ confirmBusyClose: true });
  assert.deepEqual(h.guardArgs(), { armed: true, enabled: true }, "Rust's close guard is armed");

  const closing = h.bridge.closeSessionGuarded(a);
  await flush(2);
  assert.equal(h.getSnapshot()?.closeConfirm?.kind, "tab", "closing the tab asks first");
  h.bridge.resolveCloseConfirm(false);
  assert.equal(await closing, false, "the user kept the tab");

  h.fire("window://close-requested", null); // Rust held an OS close
  await flush(2);
  const quit = h.getSnapshot()?.closeConfirm;
  assert.equal(quit?.kind, "quit", "quitting asks first");
  assert.deepEqual(quit.tabs.map(t => t.id), [a], "naming the busy background tab");
  h.bridge.resolveCloseConfirm(false);
  await flush(2);
  assert.deepEqual(h.closes, [], "the window stays open");
});

await check("counter-probe: the frozen guard alone lets the close and quit through", async () => {
  focused = false;
  const h = harness(null, { boot: true, unguarded: true });
  await flush(4);
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  await h.bridge.activateSession(a);
  await h.bridge.activateSession(b);
  h.attention({ [a]: { busy: true, asks: 0, asksOpened: 0, background: false },
    [b]: { busy: false, asks: 0, asksOpened: 0, background: false } });
  assert.equal(h.runState(a), "idle", "counter-probe: the pre-#89 guard reads the freeze");
  await h.bridge.setSessionPrefs({ confirmBusyClose: true });
  assert.equal(h.armed(), false, "counter-probe: the webview's guard stays disarmed");
  h.fire("window://close-requested", null);
  await flush(4);
  assert.deepEqual(h.closes, [true], "counter-probe: the quit kills the busy tab without asking");
});

await check("#89: the close and quit decisions re-read the tracker first", async () => {
  focused = false;
  const h = harness(null, { boot: true });
  await flush(4);
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  await h.bridge.activateSession(a);
  await h.bridge.activateSession(b);
  await h.tick(); // the page's first read: nothing yet
  await h.bridge.setSessionPrefs({ confirmBusyClose: true });
  assert.deepEqual(h.guardArgs(), { armed: false, enabled: true }, "Rust still holds on its own tracker");
  // A's turn started; Rust knows, the event has not arrived.
  h.setRust({ [a]: { busy: true, asks: 0, asksOpened: 0, background: false } });
  assert.equal(h.runState(a), "idle", "the webview has not heard yet");

  const closing = h.bridge.closeSessionGuarded(a);
  await flush(2);
  assert.equal(h.getSnapshot()?.closeConfirm?.kind, "tab", "the fresh read makes the close ask");
  h.bridge.resolveCloseConfirm(false);
  assert.equal(await closing, false);

  h.setRust({ [a]: { busy: false, asks: 1, asksOpened: 1, background: false } });
  h.fire("window://close-requested", null);
  await flush(2);
  assert.equal(h.getSnapshot()?.closeConfirm?.kind, "quit", "the fresh read makes the quit ask");
  assert.equal(h.getSnapshot().closeConfirm.tabs[0].state, "waiting for your answer");
  h.bridge.resolveCloseConfirm(false);
  await flush(2);
  assert.deepEqual(h.closes, []);

  await h.bridge.setSessionPrefs({ confirmBusyClose: false });
  assert.deepEqual(h.guardArgs(), { armed: false, enabled: false }, "the setting off clears both flags");
});

await check("#89: an approval change never kills a busy background tab and restarts it once idle", async () => {
  focused = false;
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  await h.bridge.activateSession(a);
  await h.bridge.activateSession(b); // A froze at idle
  h.attention({ [a]: { busy: true, asks: 0, asksOpened: 0, background: false },
    [b]: { busy: false, asks: 0, asksOpened: 0, background: false } });
  const starts = () => h.commands.filter(c => c.command === "start_session" && c.args.args?.sessionId === a).length;
  const before = starts();

  const changed = await h.bridge.setApprovalModeProject("/alpha", "yolo");
  assert.equal(h.called("stop_session_if_idle", a), true, "the background tab attempts the conditional stop");
  assert.deepEqual(changed.restarted, [], "Rust refused");
  assert.deepEqual(changed.deferred, [a], "the change is pending");
  assert.equal(h.called("stop_session", a), false, "no unconditional kill");
  assert.equal(h.called("stop_git_watch", a), false, "no teardown at all");
  assert.equal(starts(), before, "no respawn");
  const entry = () => h.getSnapshot().sessions.find(s => s.id === a);
  assert.equal(entry().approvalMode, "write", "it still runs the old mode");
  assert.equal(entry().runState, "running", "its state is untouched");

  // A later report that A is still busy changes nothing.
  h.attention({ [a]: { busy: true, asks: 1, asksOpened: 1, background: false },
    [b]: { busy: false, asks: 0, asksOpened: 0, background: false } });
  await flush();
  assert.equal(starts(), before, "busy again: still pending");

  // The tracker shows A idle: the pending change is retried and restarts it.
  h.attention({ [a]: { busy: false, asks: 0, asksOpened: 1, background: false },
    [b]: { busy: false, asks: 0, asksOpened: 0, background: false } });
  await flush();
  assert.equal(starts(), before + 1, "restarted once");
  assert.equal(entry().approvalMode, "yolo", "under the new mode");
  assert.equal(h.getSnapshot().activeSessionId, b, "the user's tab stays active");
  // Another idle report has nothing left to apply.
  h.attention({ [a]: { busy: false, asks: 0, asksOpened: 1, background: false } });
  await flush();
  assert.equal(starts(), before + 1, "no second restart");
});

await check("#89: an approval restart of a dictating tab waits for the dictation, then restarts", async () => {
  focused = false;
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  await h.bridge.activateSession(a);
  const starting = h.bridge.dictationStart();
  await flush(2);
  h.reply(h.sent.find(c => c.type === "dictation_start"));
  await starting;
  assert.equal(h.getSnapshot().dictation.active, true);
  const starts = () => h.commands.filter(c => c.command === "start_session" && c.args.args?.sessionId === a).length;
  const before = starts();

  const changed = await h.bridge.setApprovalModeDefault("yolo");
  assert.deepEqual(changed.deferred, [a], "deferred while dictating");
  assert.equal(h.called("stop_session_if_idle", a), false, "no stop call at all");
  assert.equal(h.called("stop_session", a), false);
  assert.equal(h.getSnapshot().dictation.active, true, "the dictation goes on");

  const stopping = h.bridge.dictationStop();
  await flush(2);
  h.reply(h.sent.find(c => c.type === "dictation_stop"), true, { text: "dictated" });
  await stopping;
  await flush();
  assert.equal(h.called("stop_session_if_idle", a), true, "the end of the dictation retries the change");
  assert.equal(starts(), before + 1, "restarted once");
  assert.equal(h.getSnapshot().sessions.find(s => s.id === a).approvalMode, "yolo");
  assert.deepEqual(h.getSnapshot().dictationCompleted.map(d => d.text), ["dictated"], "the dictated text was kept");
});

await check("#89: a send-on-stop dictation sends its text; the pending restart waits for that turn's end", async () => {
  focused = false;
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  await h.bridge.activateSession(a);
  const starting = h.bridge.dictationStart();
  await flush(2);
  h.reply(h.sent.find(c => c.type === "dictation_start"));
  await starting;
  const starts = () => h.commands.filter(c => c.command === "start_session" && c.args.args?.sessionId === a).length;
  const before = starts();
  const changed = await h.bridge.setApprovalModeDefault("yolo");
  assert.deepEqual(changed.deferred, [a], "deferred while dictating");

  const stopping = h.bridge.dictationStop({ send: true });
  await flush(2);
  h.reply(h.sent.find(c => c.type === "dictation_stop"), true, { text: "dictated" });
  await stopping;
  await flush();
  assert.deepEqual(h.getSnapshot().dictationCompleted.map(d => [d.text, d.send]), [["dictated", true]]);
  assert.equal(h.called("stop_session_if_idle", a), false, "no restart attempt before the dictated send");
  assert.equal(h.bridge.isRestarting(), false, "the tab is not restarting");

  // The composer sends the dictated text (composer.jsx's send-on-stop effect).
  assert.notEqual(await h.bridge.send("dictated"), false, "the send is not refused");
  assert.ok(h.sent.some(c => c.type === "prompt" && c.message === "dictated" && c.sessionId === a), "the prompt went out");
  assert.equal(h.getSnapshot().restartingTab, null, "no restart note");
  await flush();
  assert.equal(starts(), before, "still the old process");

  // That turn ends: its get_state picks the pending change up.
  h.emit(a, { type: "agent_start" });
  h.emit(a, { type: "agent_end", messages: [] });
  await flush();
  const getState = h.sent.filter(c => c.type === "get_state" && c.sessionId === a).at(-1);
  assert.ok(getState, "agent_end asked for get_state");
  h.reply(getState, true, { isStreaming: false });
  await flush();
  assert.equal(h.called("stop_session_if_idle", a), true, "the restart is attempted after the turn");
  assert.equal(starts(), before + 1, "restarted once");
  assert.equal(h.getSnapshot().sessions.find(s => s.id === a).approvalMode, "yolo");
});

await check("#89: a prompt typed during a restart is neither sent nor shown", async () => {
  focused = false;
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  await h.bridge.activateSession(a);
  await flush();
  const stop = h.holdStop();
  const hold = h.holdStart();
  const changing = h.bridge.setApprovalModeDefault("yolo");
  await flush(4);
  // Rust is deciding: the tab is still active, its omp may die any moment.
  assert.equal(typeof stop.release, "function", "the conditional stop is in flight");
  assert.equal(h.getSnapshot().activeSessionId, a, "still attached");
  const sentBefore = h.sent.length;
  const refusesAll = async when => {
    assert.equal(h.bridge.isRestarting(), true, when);
    assert.equal(h.bridge.restartingTab(), a, `the bridge names the restarting tab ${when}`);
    assert.equal(h.getSnapshot().restartingTab, a, `so does the snapshot ${when}`);
    assert.equal(await h.bridge.send("hello"), false, `send refuses ${when}`);
    assert.equal(await h.bridge.steer("hello"), false, `steer refuses ${when}`);
    assert.equal(await h.bridge.followUp("hello"), false, `follow-up refuses ${when}`);
    // Raced: an ungated goal create would wait on omp's reply.
    const goal = await Promise.race([h.bridge.goalStart("ship it"), flush(4).then(() => ({ ok: "pending" }))]);
    assert.equal(goal.ok, false, `a goal refuses ${when}`);
    assert.deepEqual(h.sent.slice(sentBefore), [], `no command went out ${when}`);
    assert.equal(h.getSnapshot().messages.some(m => m.kind === "user"), false, `no bubble ${when}`);
    assert.deepEqual(h.getSnapshot().queueSending ?? [], [], `no queued row ${when}`);
  };
  await refusesAll("while Rust decides");
  stop.release();
  await flush(4);
  assert.equal(typeof hold.release, "function", "the respawn is waiting on its spawn");
  await refusesAll("while detached");

  hold.release();
  const changed = await changing;
  await flush();
  assert.deepEqual(changed.restarted, [a]);
  assert.equal(h.bridge.isRestarting(), false);
  assert.equal(h.getSnapshot().restartingTab, null, "the restart's end reaches the snapshot without a submit");
  // The respawn's own `_initFetch` is not gated: its negotiate goes out,
  // and once answered so do its fetches.
  const negotiate = h.sent.filter(c => c.type === "negotiate_protocol" && c.sessionId === a).at(-1);
  assert.ok(negotiate, "the respawn's negotiate went out");
  h.reply(negotiate);
  await flush();
  assert.ok(h.sent.some(c => c.type === "get_state" && c.sessionId === a), "the respawn's own fetch is not blocked");
  await h.bridge.send("hello");
  assert.ok(h.sent.some(c => c.type === "prompt" && c.message === "hello"), "sending again works");
});

await check("#89: the composer keeps a draft its submit refused", async () => {
  const Babel = createRequire(import.meta.url)(join(root, "src/babel.min.js"));
  const { code } = Babel.transform(readFileSync(join(root, "src/design/composer.jsx"), "utf8"), { presets: ["react"] });
  const window = {
    OMP_BROWSER: { droppedScreenshots: () => 0 },
    OMP_FILE_COMMENTS: { chipLabel: () => "", location: () => "" },
    OMP_I18N: { plural: (n, one, other) => other },
    OMP_KEYMAP: { hintFor: () => "", hintKeyFor: () => "", detectMac: () => false },
    OMP_MENTIONS: { parseMentionQuery: () => null, applyMention: () => null },
    OMP_IMAGES: { MAX_ATTACHMENTS: 8 },
    useActiveRowIntoView: () => {},
  };
  for (const file of ["app/session-ui.js", "app/slash-commands.js", "app/message-queue.js"]) load(window, file);
  // One component's hooks by call order; effects never run.
  const slots = [];
  let cursor = 0;
  const React = {
    Fragment: "fragment",
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: init => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof init === "function" ? init() : init;
      return [slots[i], v => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }];
    },
    useRef: init => { const i = cursor++; if (!(i in slots)) slots[i] = { current: init }; return slots[i]; },
    useEffect: () => {}, useLayoutEffect: () => {},
    useMemo: fn => { cursor++; return fn(); },
    useCallback: fn => { cursor++; return fn; },
  };
  const ctx = { window, React, OMP_TR: s => s, requestAnimationFrame: () => {} };
  // Child components are element types only; never rendered here.
  for (const [, name] of code.matchAll(/React\.createElement\(([A-Z]\w*)/g)) if (!(name in ctx)) ctx[name] = name;
  runInNewContext(`${code}\nwindow.Composer = Composer;`, ctx);
  const find = (node, pred) => {
    if (Array.isArray(node)) { for (const n of node) { const hit = find(n, pred); if (hit) return hit; } return null; }
    if (!node || typeof node !== "object") return null;
    return pred(node) ? node : find(node.children, pred);
  };
  const sends = [];
  let answer = false;
  const render = () => {
    cursor = 0;
    return window.Composer({ sessionId: "a", sessionIds: ["a"], queue: { steering: [], followUp: [] }, queueSending: [], dictation: {},
      onSend: text => { sends.push(text); return answer; } });
  };
  const textarea = tree => find(tree, n => n.type === "textarea");
  const sendButton = tree => find(tree, n => n.type === "button" && /\bprimary\b/.test(n.props.className ?? ""));
  textarea(render()).props.onChange({ target: { value: "keep me", selectionStart: 7 } });
  sendButton(render()).props.onClick();
  assert.deepEqual(sends, ["keep me"], "the submit reached the handler");
  assert.equal(textarea(render()).props.value, "keep me", "a refused submit keeps the draft");
  answer = undefined;
  sendButton(render()).props.onClick();
  assert.equal(textarea(render()).props.value, "", "an accepted submit clears it");
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

const at = (busy, asksOpened = 0) => ({ busy, asks: asksOpened > 0 ? 1 : 0, asksOpened, background: false });

await check("#91: a finished turn plays the finished sound, the first snapshot nothing", async () => {
  focused = false;
  const h = harness(null, { tweaks: { notifySound: "always", soundFinished: "knock", soundVolume: 40 } });
  const a = await h.bridge.openSession("/alpha");
  await h.bridge.activateSession(a);
  h.attention({ [a]: at(true) });
  assert.deepEqual(h.sounds(), [], "the first snapshot is not new");
  h.attention({ [a]: at(true) });
  assert.deepEqual(h.sounds(), [], "still working");
  h.attention({ [a]: at(false) });
  assert.deepEqual(h.sounds(), [{ sound: "knock", volume: 40 }]);
  h.attention({ [a]: at(false) });
  assert.equal(h.sounds().length, 1, "idle → idle is not a finish");
});

await check("#91: a new question plays the attention sound; one sound per snapshot, attention first", async () => {
  focused = false;
  const h = harness(null, { tweaks: { notifySound: "always", soundAttention: "pop" } });
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  await h.bridge.activateSession(a);
  h.attention({ [a]: at(true), [b]: at(false) });
  h.attention({ [a]: at(false), [b]: at(false, 1) });   // a finishes while b asks
  assert.deepEqual(h.sounds(), [{ sound: "pop", volume: 60 }]);
});

await check("#91: a background tab's turn end and question play too", async () => {
  focused = false;
  const h = harness(null, { tweaks: { notifySound: "always" } });
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  await h.bridge.activateSession(b);
  h.attention({ [a]: at(true), [b]: at(false) });
  h.attention({ [a]: at(false), [b]: at(false) });
  assert.deepEqual(h.sounds(), [{ sound: "chime", volume: 60 }]);
});

await check("#91: the initial reply and a closed tab's entry play nothing", async () => {
  focused = false;
  const h = harness(null, { tweaks: { notifySound: "always" } });
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  // A live event lands while the `attention_snapshot` read is out; the read
  // comes back newer, with that turn already over and a question open.
  h.attention({ [a]: at(true), [b]: at(false) }, 1);
  h.setInitial({ revision: 2, sessions: { [a]: at(false), [b]: at(false, 3) } });
  await h.tick();
  assert.deepEqual(h.sounds(), [], "the initial reply's state is not new");
  await h.bridge.activateSession(b);
  h.attention({ [a]: at(true), [b]: at(false, 3) });
  assert.equal(await h.bridge.closeSession(a), true);
  h.attention({ [a]: at(false), [b]: at(false, 3) });   // the closed tab's late event
  h.attention({ [b]: at(false, 3) });
  assert.deepEqual(h.sounds(), [], "a closed or vanished entry is not a finish");
});

await check("#91: the mode decides — off is silent, background only while unfocused, always plays focused", async () => {
  const run = async (notifySound, hasFocus) => {
    focused = hasFocus;
    const h = harness(null, { tweaks: { notifySound } });
    const a = await h.bridge.openSession("/alpha");
    await h.bridge.activateSession(a);
    h.attention({ [a]: at(true) });
    h.attention({ [a]: at(false) });
    return h.sounds().length;
  };
  assert.equal(await run("off", false), 0);
  assert.equal(await run("background", true), 0);
  assert.equal(await run("background", false), 1);
  assert.equal(await run("always", true), 1);
  assert.equal(await run("nonsense", false), 0, "an invalid stored mode reads as the default (off)");
  focused = false;
});

await check("#91: setSessionPrefs takes effect at once and keeps keys it omits", async () => {
  focused = false;
  const h = harness();
  const a = await h.bridge.openSession("/alpha");
  await h.bridge.activateSession(a);
  const finish = () => { h.attention({ [a]: at(true) }); h.attention({ [a]: at(false) }); return h.sounds().length; };
  assert.equal(finish(), 0, "off by default");
  h.bridge.setSessionPrefs({ notifySound: "always", soundFinished: "blip", soundVolume: 25 });
  assert.equal(finish(), 1);
  assert.deepEqual(h.sounds().at(-1), { sound: "blip", volume: 25 });
  h.bridge.setSessionPrefs({ soundVolume: 80 });         // partial: mode and sound stay
  assert.equal(finish(), 2);
  assert.deepEqual(h.sounds().at(-1), { sound: "blip", volume: 80 });
  h.bridge.setSessionPrefs({ soundFinished: "none" });
  assert.equal(finish(), 2, "none keeps the cue silent");
  h.bridge.setSessionPrefs({ soundFinished: "rise", notifySound: "off" });
  assert.equal(finish(), 2, "mode off is silent");
});

await check("#91: a busy-close re-read that finds a finished turn plays it, once", async () => {
  focused = false;
  const h = harness(null, { boot: true, tweaks: { notifySound: "always", soundFinished: "rise" } });
  await flush(4);
  const a = await h.bridge.openSession("/alpha");
  const b = await h.bridge.openSession("/beta");
  await h.bridge.activateSession(a);
  await h.tick();
  h.attention({ [a]: at(true), [b]: at(false) });
  await h.bridge.setSessionPrefs({ confirmBusyClose: true });
  // A's turn ended; Rust knows, its event has not reached the webview. The
  // close's fresh read applies that revision, so the later event is stale.
  h.setRust({ [a]: at(false), [b]: at(false) });
  assert.equal(await h.bridge.closeSessionGuarded(b), true);
  assert.deepEqual(h.sounds(), [{ sound: "rise", volume: 60 }], "the re-read's finish is not swallowed");
  h.attention({ [a]: at(false), [b]: at(false) }, 2);   // the event that carried it (the re-read's revision): stale
  assert.equal(h.sounds().length, 1, "and not again");
  assert.deepEqual(h.bounces, [], "the re-read never bounces");
});

console.log(`test-attention-bridge: ${passed} checks passed`);
