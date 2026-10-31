#!/usr/bin/env node
// Regression script for src/app/live-voice.js. Run: node tests/test-live-voice.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
// eslint-disable-next-line no-new-func
new Function("window", readFileSync(join(root, "src/app/live-voice.js"), "utf8"))(win);
const V = win.OMP_LIVE_VOICE;
let passed = 0;
function check(label, fn) {
  try { fn(); } catch (err) { console.error(`FAILED: ${label}`); throw err; }
  passed++;
}
const apply = (state, ...events) => events.reduce(V.apply, state);
const start = () => apply(V.EMPTY, { type: "start" });
const caption = (role, turn, text, final = false) => ({ type: "live_transcript", role, turn, text, final });

check("voice meter uses dBFS rather than linear amplitude for ordinary speech", () => {
  assert.equal(V.meterLevel(0.1).value, -20);
  assert.equal(V.meterLevel(0.01).value, -40);
  assert.equal(V.meterLevel(1).value, 0);
  assert.equal(V.meterLevel(0.1).text, "-20 dBFS");
});
check("voice meter handles silence, invalid input and full-scale boundaries", () => {
  for (const value of [0, -1, NaN, Infinity, undefined]) {
    assert.deepEqual(V.meterLevel(value), { value: -60, text: "−∞ dBFS" });
  }
  assert.deepEqual(V.meterLevel(0.00001), { value: -60, text: "<−60 dBFS" });
  assert.deepEqual(V.meterLevel(2), { value: 0, text: "0 dBFS" });
  const nearFullScale = V.meterLevel(10 ** (-3 / 20));
  assert.ok(Math.abs(nearFullScale.value + 3) < 1e-10);
  assert.equal(nearFullScale.text, "-3 dBFS");
});
check("start opens a connecting call and each phase is visible", () => {
  let s = start();
  assert.deepEqual(s, { active: true, paused: false, phase: "connecting", muted: false, input: 0, output: 0, transcripts: [], error: null, turnOffset: 0, discardTranscripts: false, resumable: false });
  for (const phase of ["listening", "working", "speaking", "muted"]) {
    s = apply(s, { type: "live_phase", phase });
    assert.equal(s.phase, phase);
    assert.equal(s.muted, phase === "muted");
  }
  s = apply(s, { type: "mute_success", muted: false }, { type: "live_phase", phase: "listening" });
  assert.equal(s.muted, false);
  assert.equal(apply(s, { type: "start" }), s, "a duplicate start does not reset a call");
});
check("levels are clamped, muted input is zero, and mute replies change state", () => {
  let s = apply(start(), { type: "live_levels", input: 4, output: -1 });
  assert.deepEqual([s.input, s.output], [1, 0]);
  s = apply(s, { type: "mute_success", muted: true }, { type: "live_levels", input: 0.9, output: 0.4 });
  assert.deepEqual([s.muted, s.input, s.output], [true, 0, 0.4]);
  s = apply(s, { type: "live_phase", phase: "working" }, { type: "live_levels", input: 0.8, output: 0.5 });
  assert.deepEqual([s.phase, s.muted, s.input, s.output], ["working", true, 0, 0.5]);
  s = apply(s, { type: "mute_success", muted: false }, { type: "live_levels", input: NaN, output: Infinity });
  assert.deepEqual([s.muted, s.input, s.output], [false, 0, 0]);
});
check("captions coalesce by role and turn without duplicating chat or losing finals", () => {
  let s = apply(start(), caption("user", 1, "hel"), caption("assistant", 1, "hello"), caption("user", 1, "hello", true));
  assert.deepEqual(s.transcripts, [{ role: "user", turn: 1, text: "hello", final: true }, { role: "assistant", turn: 1, text: "hello", final: false }]);
  assert.equal(apply(s, caption("user", 1, "hel")), s, "a late partial does not overwrite final");
  assert.equal(apply(s, caption("user", 1, "hello", true)), s, "duplicate frame is a no-op");
  s = apply(s, caption("assistant", 1, "hello there", true));
  assert.equal(s.transcripts[1].text, "hello there");
  assert.equal(s.transcripts[1].final, true);
});
check("caption count and text size are bounded without splitting a surrogate pair", () => {
  let s = start();
  for (let i = 0; i < V.LIMITS.transcripts + 3; i++) s = apply(s, caption("user", i, String(i), true));
  assert.equal(s.transcripts.length, V.LIMITS.transcripts);
  assert.equal(s.transcripts[0].turn, 3);
  const long = "x".repeat(V.LIMITS.text - 1) + "😀extra";
  s = apply(s, caption("assistant", 999, long));
  assert.equal(s.transcripts.at(-1).text, "x".repeat(V.LIMITS.text - 1));
  assert.equal(s.transcripts.length, V.LIMITS.transcripts);
});
check("unexpected end offers resume and preserves captions", () => {
  const s = apply(start(), caption("user", 1, "draft", true), { type: "live_end", error: "connection lost" });
  assert.deepEqual([s.active, s.paused, s.phase, s.error, s.input, s.output], [false, true, "paused", "connection lost", 0, 0]);
  for (const ev of [{ type: "live_phase", phase: "listening" }, { type: "live_levels", input: 1, output: 1 }, caption("user", 2, "stale"), { type: "live_end" }, { type: "mute_success", muted: true }]) assert.equal(apply(s, ev), s);
  const next = apply(s, { type: "start" });
  assert.deepEqual([next.phase, next.paused, next.error, next.transcripts[0].text], ["connecting", false, null, "draft"]);
  const clean = apply(next, { type: "live_end" });
  assert.deepEqual([clean.active, clean.paused, clean.phase, clean.error], [false, true, "paused", null]);
});
check("stop while connecting suppresses cancellation errors until stop reply", () => {
  let s = apply(start(), { type: "stop" }, { type: "live_phase", phase: "error" }, { type: "live_end", error: "Live transport is not connected" });
  assert.deepEqual([s.active, s.phase, s.error], [true, "stopping", null]);
  s = apply(s, { type: "stop_success" });
  assert.deepEqual([s.active, s.phase, s.error], [false, "idle", null]);
  assert.equal(apply(s, { type: "start_failure", error: "late start" }), s);
});
check("failed stop keeps the call active and allows another stop", () => {
  let s = apply(start(), { type: "stop" }, { type: "stop_failure", error: "stop failed" });
  assert.deepEqual([s.active, s.phase, s.error], [true, "error", "stop failed"]);
  s = apply(s, { type: "stop" }, { type: "stop_success" });
  assert.deepEqual([s.active, s.phase, s.error], [false, "idle", null]);
});
check("start, mute, and process failures remain observable", () => {
  let s = apply(start(), { type: "start_failure", error: "credentials missing" });
  assert.deepEqual([s.active, s.phase, s.error], [false, "error", "credentials missing"]);
  s = apply(start(), { type: "mute_failure", error: "mute failed" });
  assert.deepEqual([s.active, s.muted, s.error], [true, false, "mute failed"]);
  s = apply(s, caption("user", 1, "kept"), { type: "process_exit", error: "omp crashed" });
  assert.deepEqual([s.active, s.paused, s.phase, s.error, s.transcripts[0].text], [false, true, "paused", "omp crashed", "kept"]);
  const failed = apply(start(), { type: "live_end", error: "Provider refused connection" }, { type: "process_exit", error: "omp crashed" });
  assert.deepEqual([failed.phase, failed.paused, failed.error, failed.transcripts], ["error", false, "Provider refused connection", []]);
  assert.equal(apply(V.EMPTY, { type: "process_exit" }), V.EMPTY);
});
check("a call that never connected ends in error, a resumed one stays resumable", () => {
  // omp's order for a missing Codex login: phase error and end, then the failed reply.
  const fresh = apply(start(), { type: "live_phase", phase: "connecting" }, { type: "live_phase", phase: "error" },
    { type: "live_end", error: "No Codex OAuth credential is available for a live call." },
    { type: "start_failure", error: "No Codex OAuth credential is available for a live call." });
  assert.deepEqual([fresh.active, fresh.paused, fresh.phase, fresh.error], [false, false, "error", "No Codex OAuth credential is available for a live call."]);
  const paused = apply(start(), { type: "live_phase", phase: "listening" }, caption("user", 1, "kept", true), { type: "stop" }, { type: "stop_success", paused: true });
  const resumed = apply(paused, { type: "start" }, { type: "live_phase", phase: "error" }, { type: "live_end", error: "network down" });
  assert.deepEqual([resumed.paused, resumed.phase, resumed.error, resumed.transcripts[0].text], [true, "paused", "network down", "kept"]);
});
check("stop preserves captions and later calls use distinct turn keys", () => {
  const s = apply(start(), caption("user", 1, "saved while viewing"), { type: "stop" },
    caption("user", 1, "saved while viewing", true), { type: "stop_success" });
  assert.equal(s.transcripts[0].text, "saved while viewing");
  assert.equal(s.transcripts[0].final, true);
  const next = apply(s, { type: "start" }, caption("user", 1, "new words", true));
  assert.deepEqual(next.transcripts.map(t => t.text), ["saved while viewing", "new words"]);
  assert.notEqual(next.transcripts[0].turn, next.transcripts[1].turn);
});
check("late finals only complete existing captions and forgotten calls cannot add history", () => {
  let s = apply(start(), caption("user", 1, "partial"), { type: "stop" }, { type: "stop_success", paused: true });
  s = apply(s, caption("user", 1, "finished", true));
  assert.deepEqual(s.transcripts.map(t => [t.text, t.final]), [["finished", true]]);
  assert.equal(apply(s, caption("user", 2, "stale", true)), s);
  s = apply(start(), caption("user", 1, "old"), { type: "stop" }, { type: "forget" }, caption("user", 1, "old final", true), { type: "stop_success", paused: true });
  assert.deepEqual([s.paused, s.transcripts], [false, []]);
});
check("malformed and unrelated frames do nothing", () => {
  const s = start();
  for (const ev of [null, {}, { type: "message_start" }, { type: "live_phase", phase: "idle" }, caption("system", 0, "bad"), caption("user", -1, "bad"), caption("user", 0, 12), caption("user", 0, "bad", "yes")]) assert.equal(apply(s, ev), s);
});
const D = V.DICTATION;
check("dictation previews replace rather than accumulate, and stale captures are inert", () => {
  let s = D.apply(D.EMPTY, { type: "start", captureId: "one" });
  s = D.apply(s, { type: "dictation_state", captureId: "one", state: "recording" });
  s = D.apply(s, { type: "dictation_transcript", captureId: "one", text: "hello" });
  s = D.apply(s, { type: "dictation_transcript", captureId: "one", text: "hello world" });
  assert.equal(s.text, "hello world");
  assert.equal(D.apply(s, { type: "dictation_end", captureId: "old", text: "wrong" }), s);
  s = D.apply(s, { type: "stop" });
  assert.equal(D.apply(s, { type: "dictation_state", captureId: "one", state: "recording" }), s);
  s = D.apply(s, { type: "stop_failure", error: "microphone busy" });
  assert.deepEqual([s.active, s.phase, s.error], [true, "error", "microphone busy"]);
  s = D.apply(s, { type: "dictation_end", captureId: "one", text: "final", error: "STT failed" });
  assert.deepEqual([s.active, s.text, s.error], [false, "final", "STT failed"]);
  assert.equal(D.apply(s, { type: "dictation_end", captureId: "one", text: "duplicate" }), s);
});

// Render the actual JSX controls with the same lightweight React stand-in used
// by the settings UI regressions; exercise the buttons rather than the bridge.
check("voice controls start independently and retain stop and cancel actions", () => {
  const Babel = createRequire(import.meta.url)(join(root, "src/babel.min.js"));
  const { code } = Babel.transform(readFileSync(join(root, "src/design/live-voice.jsx"), "utf8"), { presets: ["react"] });
  const window = { Icon: () => null };
  const React = { Fragment: "fragment", createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) };
  runInNewContext(code, { window, React });
  const actions = [];
  const render = (live = {}, dictation = {}) => window.VoiceModeButton({ live, dictation,
    onLiveAction: action => actions.push(["live", action]),
    onDictationAction: action => actions.push(["dictation", action]),
  }).children;
  let [dictation, live] = render();
  assert.equal(dictation.props["aria-pressed"], false);
  assert.equal(live.props["aria-pressed"], false);
  assert.equal(dictation.props.disabled, false);
  assert.equal(live.props.disabled, false);
  dictation.props.onClick(); live.props.onClick();
  [dictation, live] = render({}, { active: true, phase: "starting" });
  assert.equal(dictation.props["aria-pressed"], true);
  assert.equal(dictation.props["aria-busy"], true);
  assert.equal(dictation.props.disabled, false);
  assert.equal(live.props.disabled, true);
  dictation.props.onClick();
  [dictation, live] = render({ active: true, phase: "connecting" });
  assert.equal(live.props["aria-pressed"], true);
  assert.equal(live.props["aria-busy"], true);
  assert.equal(live.props.disabled, false);
  assert.equal(dictation.props.disabled, true);
  live.props.onClick();
  [dictation, live] = render({}, { active: true, phase: "stopping" });
  assert.equal(dictation.props.disabled, true);
  assert.equal(dictation.props["aria-busy"], true);
  assert.equal(live.props.disabled, true);
  [dictation, live] = render({ active: true, phase: "stopping" });
  assert.equal(live.props.disabled, true);
  assert.equal(live.props["aria-busy"], true);
  assert.equal(dictation.props.disabled, true);
  [dictation] = render({}, { active: true, phase: "error" });
  assert.equal(dictation.props.disabled, false);
  dictation.props.onClick();
  [, live] = render({ active: true, phase: "error" });
  assert.equal(live.props.disabled, false);
  live.props.onClick();
  assert.deepEqual(actions, [["dictation", "start"], ["live", "start"], ["dictation", "stop"], ["live", "stop"], ["dictation", "stop"], ["live", "stop"]]);
});

// Exercise the public bridge against a deterministic fake IPC transport. The
// assertions concern snapshots and outcomes, not the bridge's internal maps.
function bridgeHarness() {
  const listeners = new Map(), journal = new Map(), commands = [], waiters = [];
  const w = {
    OMP_LIVE_VOICE: V,
    OMP_SLASH: { LOCAL_COMMANDS: [] },
    OMP_SUBAGENTS: { emptySubagents: () => ({}), subscriptionLevelFor: () => "progress", mergeSnapshots: () => ({}) },
    OMP_QUEUE: { EMPTY_QUEUE: {} }, OMP_GOAL: { UNKNOWN: {} }, OMP_EXT_WIDGETS: { EMPTY: {} },
    OMP_TRANSCRIPT: {}, OMP_PROMPT_HISTORY: { DEFAULT_LIMIT: 100 },
    OMP_SESSION_PREFS: { fromTweaks: () => ({ autoCompaction: true, autoRetry: true }), closeGuardArmed: () => false },
    OMP_TWEAKS_STORE: { read: () => ({}) },
    OMP_TURN_STATUS: { runStateOf: () => "idle", isBusyRunState: () => false, retryCleared: messages => messages },
    OMP_PROJECT_NAV: { basename: path => path.split("/").at(-1), findConversationTab: () => null },
    DEFAULT_PROFILE_ID: "default", INTENT_FRAMING: () => "", timeNow: () => "00:00",
  };
  // Use the real context builder; the fake transport only supplies omp data.
  new Function("window", readFileSync(join(root, "src/app/live-context.js"), "utf8"))(w);
  new Function("window", readFileSync(join(root, "src/app/approval-mode.js"), "utf8"))(w);
  // The fake is attached after bridge initialization, so no boot restore or
  // real process is started. Only timers for other bridge commands are unref'd.
  const timeout = (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; };
  // eslint-disable-next-line no-new-func
  new Function("window", "setTimeout", "clearTimeout", readFileSync(join(root, "src/live.js"), "utf8"))(w, timeout, clearTimeout);
  function emit(id, frame) {
    const entries = journal.get(id) ?? [];
    const envelope = { seq: entries.length + 1, text: JSON.stringify(frame) };
    entries.push(envelope);
    journal.set(id, entries);
    listeners.get(`agent://line/${id}`)?.({ payload: envelope });
  }
  function reply(cmd, success = true, data = null, error = undefined) {
    emit(cmd.sessionId, { type: "response", command: cmd.type, id: cmd.id, success, data, error });
  }
  function waitCommand(type, count = 1) {
    const matches = commands.filter(c => c.type === type);
    if (matches.length >= count) return Promise.resolve(matches[count - 1]);
    return new Promise(resolve => waiters.push({ type, count, resolve }));
  }
  let releaseStart = null, holdStart = false, holdHistory = false, approvalMode = "write";
  const histories = new Map();
  const invocations = [];
  w.__TAURI__ = {
    core: { invoke(command, args) {
      invocations.push({ command, args });
      if (command === "create_profile") return Promise.resolve({ id: "other", name: "Other" });
      if (command === "list_profiles") return Promise.resolve({ profiles: [{ id: "default", name: "default" }, { id: "other", name: "Other" }] });
      if (command === "stop_session") { journal.delete(args.sessionId); return Promise.resolve(null); }
      if (command === "approval_mode_set_default") {
        approvalMode = args.mode;
        return Promise.resolve({ default: approvalMode, projects: {} });
      }
      if (command === "start_session") return Promise.resolve(approvalMode);
      if (command === "replay_events") return Promise.resolve({ dropped: false, events: (journal.get(args.sessionId) ?? []).filter(e => e.seq > args.afterSeq) });
      if (command === "send_command") {
        const cmd = { ...JSON.parse(args.json), sessionId: args.sessionId };
        commands.push(cmd);
        for (const waiter of waiters.splice(0)) {
          const matches = commands.filter(c => c.type === waiter.type);
          if (matches.length >= waiter.count) waiter.resolve(matches[waiter.count - 1]);
          else waiters.push(waiter);
        }
        if (cmd.type === "negotiate_protocol" || cmd.type === "set_ask_dialog") queueMicrotask(() => reply(cmd));
        if (cmd.type === "get_messages" && cmd.id?.startsWith("live-history-") && !holdHistory) {
          queueMicrotask(() => reply(cmd, true, { messages: histories.get(cmd.sessionId) ?? [] }));
        }
        if ((cmd.type === "live_start" || cmd.type === "dictation_start") && holdStart) return new Promise(resolve => { releaseStart = resolve; });
      }
      return Promise.resolve(null);
    } },
    event: { async listen(name, callback) {
      listeners.set(name, callback);
      return () => { if (listeners.get(name) === callback) listeners.delete(name); };
    } },
  };
  let snapshot;
  w.OMP_BRIDGE.onUpdate(s => { snapshot = s; });
  return {
    bridge: w.OMP_BRIDGE, emit, reply, waitCommand, commands, invocations,
    snapshot: () => snapshot,
    holdStart: () => { holdStart = true; },
    releaseStart: () => { holdStart = false; releaseStart(); },
    holdHistory: () => { holdHistory = true; },
    setHistory: (id, messages) => { histories.set(id, messages); },
    exit: (id, reason) => listeners.get(`agent://exit/${id}`)?.({ payload: reason }),
  };
}
async function checkAsync(label, fn) {
  try { await fn(); } catch (err) { console.error(`FAILED: ${label}`); throw err; }
  passed++;
}
async function twoTabs(h) {
  const a = await h.bridge.openSession(null);
  const b = await h.bridge.openSession(null);
  await h.bridge.activateSession(a);
  return { a, b };
}

const rawMessage = (role, text) => ({ role, content: [{ type: "text", text }] });
const contextOf = command => JSON.parse(command.instructions.split("\nConversation history (JSON data):\n")[1]);

await checkAsync("tab pause and resume carry fresh raw chat and all spoken turns without cross-tab leaks", async () => {
  const h = bridgeHarness();
  const a = await h.bridge.openSession("/alpha"), b = await h.bridge.openSession("/beta");
  await h.bridge.activateSession(a);
  h.setHistory(a, [rawMessage("user", "Initial coding request"), rawMessage("assistant", "Initial coding answer")]);
  const starting = h.bridge.liveStart();
  const first = await h.waitCommand("live_start");
  assert.equal(contextOf(first).project, "/alpha");
  assert.deepEqual(contextOf(first).chat.messages.map(m => m.text), ["Initial coding request", "Initial coding answer"]);
  h.reply(first); await starting;
  h.emit(a, caption("user", 1, "Remember the blue layout", true));
  h.emit(a, caption("assistant", 1, "I'll keep it"));
  const switching = h.bridge.activateSession(b);
  const pause = await h.waitCommand("live_stop");
  h.emit(a, caption("assistant", 1, "I'll keep it blue", true));
  h.reply(pause); await switching;
  assert.equal(h.snapshot().activeSessionId, b);
  assert.equal(h.snapshot().liveVoice.transcripts.length, 0);
  h.setHistory(b, [rawMessage("user", "Private beta request")]);
  const betaStart = h.bridge.liveStart(), beta = await h.waitCommand("live_start", 2);
  assert.equal(contextOf(beta).project, "/beta");
  assert.deepEqual(contextOf(beta).voice.messages, []);
  assert.equal(beta.instructions.includes("blue layout"), false);
  h.reply(beta); await betaStart;
  const betaEnd = h.bridge.liveStop();
  h.reply(await h.waitCommand("live_stop", 2)); await betaEnd;
  await h.bridge.activateSession(a);
  assert.deepEqual([h.snapshot().liveVoice.active, h.snapshot().liveVoice.paused, h.snapshot().liveVoice.phase], [false, true, "paused"]);
  assert.deepEqual(h.snapshot().liveVoice.transcripts.map(t => [t.text, t.final]), [["Remember the blue layout", true], ["I'll keep it blue", true]]);
  h.setHistory(a, [rawMessage("user", "Initial coding request"), rawMessage("assistant", "Updated while away")]);
  const resumed = h.bridge.liveResume(), second = await h.waitCommand("live_start", 3);
  assert.deepEqual(contextOf(second).chat.messages.map(m => m.text), ["Initial coding request", "Updated while away"]);
  assert.deepEqual(contextOf(second).voice.messages.map(m => m.text), ["Remember the blue layout", "I'll keep it blue"]);
  assert.equal(second.instructions.includes("Private beta request"), false);
  h.emit(a, caption("user", 1, "stale prior call", true));
  h.emit(a, { type: "live_end", error: "late old terminal" });
  assert.deepEqual(h.snapshot().liveVoice.transcripts.map(t => t.text), ["Remember the blue layout", "I'll keep it blue"]);
  assert.equal(h.snapshot().liveVoice.active, true);
  h.emit(a, { type: "live_phase", phase: "connecting" });
  h.reply(second); await resumed;
  h.emit(a, caption("user", 1, "Another decision", true));
  h.emit(a, caption("assistant", 1, "Understood", true));
  const rows = h.snapshot().liveVoice.transcripts;
  assert.deepEqual(rows.map(t => t.text), ["Remember the blue layout", "I'll keep it blue", "Another decision", "Understood"]);
  assert.equal(new Set(rows.map(t => `${t.role}-${t.turn}`)).size, 4);
  const ending = h.bridge.liveStop();
  h.reply(await h.waitCommand("live_stop", 3)); await ending;
  assert.equal(h.snapshot().liveVoice.paused, false);
  const restarted = h.bridge.liveStart(), third = await h.waitCommand("live_start", 4);
  assert.deepEqual(contextOf(third).voice.messages.map(m => m.text), rows.map(t => t.text));
  h.reply(third); await restarted;
});

await checkAsync("cancel during history fetch never hands off a live start", async () => {
  const h = bridgeHarness();
  const { a, b } = await twoTabs(h);
  h.holdHistory();
  const starting = h.bridge.liveStart();
  const history = h.commands.find(c => c.type === "get_messages" && c.id?.startsWith("live-history-"));
  assert.ok(history);
  const switching = h.bridge.activateSession(b);
  await switching;
  assert.equal((await starting).ok, false);
  assert.equal(h.snapshot().activeSessionId, b);
  assert.equal(h.commands.some(c => c.type === "live_start" || c.type === "live_stop"), false);
  h.reply(history, true, { messages: [rawMessage("user", "late stale history")] });
  await h.bridge.activateSession(a);
  assert.equal(h.snapshot().liveVoice.paused, true);
  assert.equal(h.commands.some(c => c.type === "live_start"), false);
});

await checkAsync("failed or malformed history read never launches the microphone", async () => {
  const h = bridgeHarness();
  await h.bridge.openSession(null);
  h.holdHistory();
  const first = h.bridge.liveStart();
  const command = h.commands.find(c => c.type === "get_messages" && c.id?.startsWith("live-history-"));
  h.reply(command, false, null, "Cannot read conversation");
  assert.deepEqual(await first, { ok: false, error: "Cannot read conversation" });
  assert.equal(h.snapshot().liveVoice.error, "Cannot read conversation");
  const retry = h.bridge.liveStart();
  const next = h.commands.filter(c => c.type === "get_messages" && c.id?.startsWith("live-history-")).at(-1);
  h.reply(next, true, {});
  assert.match((await retry).error, /history/i);
  assert.equal(h.commands.some(c => c.type === "live_start"), false);
});

await checkAsync("failed resume keeps paused voice history for a later retry", async () => {
  const h = bridgeHarness();
  const a = await h.bridge.openSession(null);
  const start = h.bridge.liveStart(); h.reply(await h.waitCommand("live_start")); await start;
  h.emit(a, caption("user", 1, "retain this decision", true));
  const pause = h.bridge.livePause(); h.reply(await h.waitCommand("live_stop")); await pause;
  h.holdHistory();
  const failed = h.bridge.liveResume();
  const history = h.commands.filter(c => c.type === "get_messages" && c.id?.startsWith("live-history-")).at(-1);
  h.reply(history, false, null, "History unavailable");
  assert.equal((await failed).ok, false);
  assert.deepEqual([h.snapshot().liveVoice.paused, h.snapshot().liveVoice.error], [true, "History unavailable"]);
  assert.equal(h.commands.filter(c => c.type === "live_start").length, 1);
  const retry = h.bridge.liveResume();
  const next = h.commands.filter(c => c.type === "get_messages" && c.id?.startsWith("live-history-")).at(-1);
  h.reply(next, true, { messages: [rawMessage("user", "latest chat")] });
  const resumed = await h.waitCommand("live_start", 2);
  assert.deepEqual(contextOf(resumed).voice.messages.map(row => row.text), ["retain this decision"]);
  assert.equal(contextOf(resumed).chat.messages[0].text, "latest chat");
  h.reply(resumed); assert.equal((await retry).ok, true);
});

await checkAsync("changing conversation cancels an outstanding history fetch", async () => {
  const h = bridgeHarness();
  const a = await h.bridge.openSession(null);
  h.holdHistory();
  const oldStart = h.bridge.liveStart();
  const oldHistory = h.commands.find(c => c.type === "get_messages" && c.id?.startsWith("live-history-"));
  h.emit(a, { type: "response", command: "new_session", success: true, data: {} });
  h.reply(oldHistory, true, { messages: [rawMessage("user", "secret old conversation")] });
  assert.equal((await oldStart).ok, false);
  await Promise.resolve();
  assert.equal(h.commands.some(c => c.type === "live_start"), false);
  const fresh = h.bridge.liveStart();
  const history = h.commands.filter(c => c.type === "get_messages" && c.id?.startsWith("live-history-")).at(-1);
  assert.notEqual(history.id, oldHistory.id);
  h.reply(history, true, { messages: [rawMessage("user", "fresh conversation")] });
  const command = await h.waitCommand("live_start");
  assert.equal(command.instructions.includes("secret old conversation"), false);
  assert.equal(contextOf(command).chat.messages[0].text, "fresh conversation");
  h.reply(command); assert.equal((await fresh).ok, true);
});

await checkAsync("new conversation and branch erase voice even with a late stop frame", async () => {
  const h = bridgeHarness();
  const a = await h.bridge.openSession(null);
  const first = h.bridge.liveStart(); h.reply(await h.waitCommand("live_start")); await first;
  h.emit(a, caption("user", 1, "old private discussion", true));
  h.emit(a, { type: "response", command: "new_session", success: true, data: {} });
  const stop = await h.waitCommand("live_stop");
  h.emit(a, caption("user", 2, "late old conversation", true));
  h.reply(stop);
  await Promise.resolve();
  assert.deepEqual(h.snapshot().liveVoice.transcripts, []);
  h.setHistory(a, [rawMessage("user", "new coding conversation")]);
  const next = h.bridge.liveStart(), nextStart = await h.waitCommand("live_start", 2);
  assert.deepEqual(contextOf(nextStart).voice.messages, []);
  assert.equal(nextStart.instructions.includes("old private discussion"), false);
  h.reply(nextStart); await next;
  h.emit(a, caption("user", 1, "discussion before branch", true));
  const branch = h.bridge.branchAt("entry-1");
  h.reply(await h.waitCommand("branch"), true, { text: "prompt" });
  const branchStop = await h.waitCommand("live_stop", 2);
  h.emit(a, caption("user", 2, "late branch speech", true));
  h.reply(branchStop); await branch;
  assert.deepEqual(h.snapshot().liveVoice.transcripts, []);
  const after = h.bridge.liveStart(), afterStart = await h.waitCommand("live_start", 3);
  assert.deepEqual(contextOf(afterStart).voice.messages, []);
  h.reply(afterStart); await after;
});

await checkAsync("settings pause blocks on stop failure and resume respects dictation", async () => {
  const h = bridgeHarness();
  const a = await h.bridge.openSession(null);
  const start = h.bridge.liveStart(); h.reply(await h.waitCommand("live_start")); await start;
  h.emit(a, caption("user", 1, "saved", true));
  const failed = h.bridge.stopActiveVoice();
  h.reply(await h.waitCommand("live_stop"), false, null, "Cannot pause microphone");
  assert.equal((await failed).ok, false);
  assert.deepEqual([h.snapshot().liveVoice.active, h.snapshot().liveVoice.error], [true, "Cannot pause microphone"]);
  const retry = h.bridge.stopActiveVoice();
  h.reply(await h.waitCommand("live_stop", 2)); await retry;
  assert.equal(h.snapshot().liveVoice.paused, true);
  const dictating = h.bridge.dictationStart(), dictation = await h.waitCommand("dictation_start");
  h.reply(dictation); await dictating;
  assert.equal((await h.bridge.liveResume()).ok, false);
  const stopDictation = h.bridge.stopActiveVoice();
  h.reply(await h.waitCommand("dictation_stop"), true, { text: "draft" }); await stopDictation;
  assert.equal(h.snapshot().liveVoice.paused, true);
  const resume = h.bridge.liveResume(), resumeCommand = await h.waitCommand("live_start", 2);
  assert.equal(contextOf(resumeCommand).voice.messages[0].text, "saved");
  h.reply(resumeCommand); await resume;
});

await checkAsync("tab switch waits for connecting start handoff and stop; late replay stays idle", async () => {
  const h = bridgeHarness();
  const { a, b } = await twoTabs(h);
  let tryRestart = false, restarted;
  h.bridge.onUpdate(s => {
    if (tryRestart && s.activeSessionId === a && s.liveVoice.phase === "paused") {
      tryRestart = false;
      restarted = h.bridge.liveStart();
    }
  });
  h.holdStart();
  const starting = h.bridge.liveStart();
  assert.equal(h.bridge.liveStart(), starting, "duplicate starts share the in-flight call");
  const startCommand = await h.waitCommand("live_start");
  const switching = h.bridge.activateSession(b);
  assert.equal(h.snapshot().activeSessionId, a);
  assert.equal(h.snapshot().liveVoice.phase, "stopping");
  assert.equal(h.commands.some(c => c.type === "live_stop"), false);
  h.releaseStart();
  const stopCommand = await h.waitCommand("live_stop");
  h.emit(a, { type: "live_phase", phase: "error" });
  h.emit(a, { type: "live_end", error: "Live transport is not connected" });
  tryRestart = true;
  h.reply(stopCommand);
  await switching;
  assert.equal((await restarted).ok, false, "a subscriber cannot restart the microphone while leaving");
  assert.equal(h.commands.filter(c => c.type === "live_start").length, 1);
  assert.equal((await starting).ok, false);
  assert.equal(h.snapshot().activeSessionId, b);
  h.reply(startCommand); // a late success and phase are journaled in the background
  h.emit(a, { type: "live_phase", phase: "listening" });
  await h.bridge.activateSession(a);
  assert.deepEqual([h.snapshot().liveVoice.active, h.snapshot().liveVoice.paused, h.snapshot().liveVoice.phase, h.snapshot().liveVoice.error], [false, true, "paused", null]);
});

await checkAsync("failed stop remains visible and blocks backgrounding until a successful retry", async () => {
  const h = bridgeHarness();
  const { a, b } = await twoTabs(h);
  const starting = h.bridge.liveStart();
  h.reply(await h.waitCommand("live_start"));
  assert.equal((await starting).ok, true);
  const switching = h.bridge.activateSession(b);
  h.reply(await h.waitCommand("live_stop"), false, null, "Cannot close microphone");
  await switching;
  assert.equal(h.snapshot().activeSessionId, a);
  assert.deepEqual([h.snapshot().liveVoice.active, h.snapshot().liveVoice.phase, h.snapshot().liveVoice.error], [true, "error", "Cannot close microphone"]);
  const retry = h.bridge.activateSession(b);
  h.reply(await h.waitCommand("live_stop", 2));
  await retry;
  assert.equal(h.snapshot().activeSessionId, b);
});

await checkAsync("terminal failure cancels late mute and keeps the final error", async () => {
  const h = bridgeHarness();
  const a = await h.bridge.openSession(null);
  const starting = h.bridge.liveStart();
  h.reply(await h.waitCommand("live_start"));
  assert.equal((await starting).ok, true);
  h.emit(a, { type: "live_phase", phase: "speaking" });
  h.emit(a, { type: "live_levels", input: 0.2, output: 0.7 });
  h.emit(a, caption("user", 1, "hello"));
  h.emit(a, caption("user", 1, "hello world", true));
  assert.deepEqual([h.snapshot().liveVoice.phase, h.snapshot().liveVoice.input, h.snapshot().liveVoice.output], ["speaking", 0.2, 0.7]);
  assert.deepEqual(h.snapshot().liveVoice.transcripts, [{ role: "user", turn: 1, text: "hello world", final: true }]);
  assert.equal(h.snapshot().messages.length, 0, "ephemeral captions are not persisted as chat bubbles");
  const muting = h.bridge.liveMute(true);
  const command = await h.waitCommand("live_mute");
  h.emit(a, { type: "live_end", error: "Connection lost" });
  h.reply(command, true, { muted: true });
  assert.equal((await muting).ok, false);
  assert.deepEqual([h.snapshot().liveVoice.active, h.snapshot().liveVoice.phase, h.snapshot().liveVoice.muted, h.snapshot().liveVoice.error], [false, "paused", false, "Connection lost"]);
  const resuming = h.bridge.liveResume(), resumed = await h.waitCommand("live_start", 2);
  assert.deepEqual(contextOf(resumed).voice.messages.map(row => row.text), ["hello world"]);
  h.reply(resumed); assert.equal((await resuming).ok, true);
});

await checkAsync("process exit preserves captions and settles an in-flight start", async () => {
  const h = bridgeHarness();
  const a = await h.bridge.openSession(null);
  const starting = h.bridge.liveStart();
  await h.waitCommand("live_start");
  h.emit(a, { type: "live_phase", phase: "connecting" });
  h.emit(a, caption("user", 1, "ephemeral", true));
  h.exit(a, "omp crashed");
  assert.equal((await starting).ok, false);
  assert.deepEqual([h.snapshot().liveVoice.active, h.snapshot().liveVoice.error, h.snapshot().liveVoice.transcripts.map(t => t.text)], [false, "omp crashed", ["ephemeral"]]);
});

await checkAsync("dictation cancels while starting, flushes before switching, and delivers once", async () => {
  const h = bridgeHarness();
  const { a, b } = await twoTabs(h);
  h.holdStart();
  const starting = h.bridge.dictationStart();
  const start = await h.waitCommand("dictation_start");
  const switching = h.bridge.activateSession(b);
  assert.equal(h.snapshot().dictation.phase, "stopping");
  assert.equal(h.commands.some(c => c.type === "dictation_stop"), false);
  h.releaseStart();
  const stop = await h.waitCommand("dictation_stop");
  h.emit(a, { type: "dictation_transcript", captureId: start.captureId, text: "preview" });
  h.emit(a, { type: "dictation_end", captureId: start.captureId, text: "final words" });
  h.emit(a, { type: "dictation_end", captureId: start.captureId, text: "duplicate" });
  h.reply(stop, true, { text: "final words" });
  await switching;
  await starting;
  assert.equal(h.snapshot().activeSessionId, b);
  assert.deepEqual(h.snapshot().dictationCompleted, [{ sessionId: a, captureId: start.captureId, text: "final words" }]);
  assert.equal(h.commands.some(c => c.type === "prompt"), false);
  h.reply(start);
  await h.bridge.activateSession(a);
  assert.equal(h.snapshot().dictation.active, false);
  assert.equal(h.snapshot().dictationCompleted.length, 1);
  h.bridge.ackDictation([start.captureId]);
  assert.deepEqual(h.snapshot().dictationCompleted, []);
});

await checkAsync("failed dictation stop keeps the microphone visible until retry", async () => {
  const h = bridgeHarness();
  const { a, b } = await twoTabs(h);
  const starting = h.bridge.dictationStart();
  const start = await h.waitCommand("dictation_start");
  h.emit(a, { type: "dictation_state", captureId: start.captureId, state: "recording" });
  h.reply(start);
  assert.equal((await starting).ok, true);
  const switch1 = h.bridge.activateSession(b);
  h.reply(await h.waitCommand("dictation_stop"), false, null, "Cannot stop mic");
  await switch1;
  assert.equal(h.snapshot().activeSessionId, a);
  assert.deepEqual([h.snapshot().dictation.active, h.snapshot().dictation.error], [true, "Cannot stop mic"]);
  const switch2 = h.bridge.activateSession(b);
  h.reply(await h.waitCommand("dictation_stop", 2), true, { text: "saved" });
  await switch2;
  assert.equal(h.snapshot().activeSessionId, b);
  assert.deepEqual(h.snapshot().dictationCompleted, [{ sessionId: a, captureId: start.captureId, text: "saved" }]);
});

await checkAsync("unsolicited terminal wins a late failed reply and prevents stale frames", async () => {
  const h = bridgeHarness();
  const a = await h.bridge.openSession(null);
  const starting = h.bridge.dictationStart();
  const start = await h.waitCommand("dictation_start");
  h.emit(a, { type: "dictation_transcript", captureId: start.captureId, text: "partial" });
  h.emit(a, { type: "dictation_end", captureId: start.captureId, text: "partial", error: "STT failed" });
  h.reply(start, false, null, "STT failed");
  assert.equal((await starting).ok, false);
  assert.equal(h.snapshot().dictation.error, "STT failed");
  const next = h.bridge.dictationStart();
  const nextStart = await h.waitCommand("dictation_start", 2);
  assert.notEqual(start.captureId, nextStart.captureId);
  h.emit(a, { type: "dictation_transcript", captureId: start.captureId, text: "stale" });
  assert.equal(h.snapshot().dictation.text, "");
  h.reply(nextStart);
  assert.equal((await next).ok, true);
  assert.equal((await h.bridge.liveStart()).ok, false);
  const stop = h.bridge.dictationStop();
  h.reply(await h.waitCommand("dictation_stop"), true, { text: "new" });
  assert.equal((await stop).ok, true);
  h.emit(a, { type: "dictation_end", captureId: nextStart.captureId, text: "duplicate" });
  assert.deepEqual(h.snapshot().dictationCompleted.map(item => item.text), ["partial", "new"]);
});

await checkAsync("settings stop shares the in-flight stop until its reply", async () => {
  const h = bridgeHarness();
  const a = await h.bridge.openSession(null);
  const starting = h.bridge.dictationStart();
  const start = await h.waitCommand("dictation_start");
  h.reply(start);
  await starting;
  const stopping = h.bridge.dictationStop();
  const stop = await h.waitCommand("dictation_stop");
  h.emit(a, { type: "dictation_end", captureId: start.captureId, text: "done" });
  const settingsStop = h.bridge.stopActiveVoice();
  assert.equal(settingsStop, stopping);
  h.reply(stop, true, { text: "done" });
  assert.equal((await settingsStop).ok, true);
  assert.equal(h.snapshot().dictation.active, false);
  assert.equal(h.snapshot().dictationCompleted.length, 1);
});

await checkAsync("process exit preserves preview and close refuses a failed stop", async () => {
  const h = bridgeHarness();
  const a = await h.bridge.openSession(null);
  const starting = h.bridge.dictationStart();
  const start = await h.waitCommand("dictation_start");
  h.reply(start);
  await starting;
  h.emit(a, { type: "dictation_transcript", captureId: start.captureId, text: "recover me" });
  const close = h.bridge.closeSession(a);
  h.reply(await h.waitCommand("dictation_stop"), false, null, "still recording");
  assert.equal(await close, false);
  assert.equal(h.snapshot().activeSessionId, a);
  assert.equal(h.snapshot().dictation.active, true);
  h.exit(a, "omp crashed");
  assert.equal(h.snapshot().dictation.active, false);
  assert.equal(h.snapshot().dictation.error, "omp crashed");
  assert.deepEqual(h.snapshot().dictationCompleted, [{ sessionId: a, captureId: start.captureId, text: "recover me" }]);
  await h.bridge.closeSession(a);
  assert.deepEqual(h.snapshot().dictationCompleted, []);
});

await checkAsync("profile respawn flushes dictation and preserves the originating draft delivery", async () => {
  const h = bridgeHarness();
  await h.bridge.createProfile("Other");
  const a = await h.bridge.openSession(null);
  const start = h.bridge.dictationStart();
  const command = await h.waitCommand("dictation_start");
  h.reply(command);
  await start;
  const restart = h.bridge.switchSessionProfile(a, "other");
  const stop = await h.waitCommand("dictation_stop");
  assert.equal(h.invocations.some(call => call.command === "stop_session"), false);
  h.reply(stop, true, { text: "before restart" });
  assert.equal((await restart).ok, true);
  assert.equal(h.snapshot().activeSessionId, a);
  assert.equal(h.snapshot().dictation.active, false);
  assert.deepEqual(h.snapshot().dictationCompleted, [{ sessionId: a, captureId: command.captureId, text: "before restart" }]);
  assert.equal(h.invocations.some(call => call.command === "stop_session"), true);
});

await checkAsync("profile replacement clears the previous conversation's voice", async () => {
  const h = bridgeHarness();
  await h.bridge.createProfile("Other");
  const a = await h.bridge.openSession(null);
  const start = h.bridge.liveStart(); h.reply(await h.waitCommand("live_start")); await start;
  h.emit(a, caption("user", 1, "old profile voice", true));
  const pause = h.bridge.livePause(); h.reply(await h.waitCommand("live_stop")); await pause;
  assert.equal((await h.bridge.switchSessionProfile(a, "other")).ok, true);
  assert.deepEqual(h.snapshot().liveVoice.transcripts, []);
  h.setHistory(a, [rawMessage("user", "new profile coding task")]);
  const next = h.bridge.liveStart(), command = await h.waitCommand("live_start", 2);
  assert.deepEqual(contextOf(command).voice.messages, []);
  assert.equal(command.instructions.includes("old profile voice"), false);
  h.reply(command); await next;
});

await checkAsync("same-conversation process replacement preserves paused voice history", async () => {
  const h = bridgeHarness();
  const a = await h.bridge.resumeSession({ path: "/saved/session.jsonl" });
  const start = h.bridge.liveStart(); h.reply(await h.waitCommand("live_start")); await start;
  h.emit(a, caption("user", 1, "retain across restart", true));
  const result = await h.bridge.setApprovalModeDefault("yolo");
  assert.deepEqual(result.restarted, [a]);
  assert.deepEqual([h.snapshot().activeSessionId, h.snapshot().liveVoice.active, h.snapshot().liveVoice.paused], [a, false, true]);
  assert.deepEqual(h.snapshot().liveVoice.transcripts.map(t => t.text), ["retain across restart"]);
  h.setHistory(a, [rawMessage("user", "same saved conversation")]);
  const resume = h.bridge.liveResume(), command = await h.waitCommand("live_start", 2);
  assert.deepEqual(contextOf(command).voice.messages.map(row => row.text), ["retain across restart"]);
  h.reply(command); await resume;
});

console.log(`test-live-voice: ${passed} checks passed`);
