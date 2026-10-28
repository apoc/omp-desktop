#!/usr/bin/env node
// Remote view mapping, queued actions and publisher lifecycle without React DOM.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const own = (value) => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function clock() {
  let now = 0, seq = 0;
  const timers = new Map();
  return {
    Date: { now: () => now },
    setTimeout(fn, ms) { timers.set(++seq, { at: now + ms, fn }); return seq; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const end = now + ms;
      await flush();
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
    get pending() { return timers.size; },
  };
}
function load(time = clock()) {
  const path = new URL("../src/app/remote-view.js", import.meta.url);
  assert.ok(existsSync(path), "remote view module must exist");
  const window = {};
  runInNewContext(readFileSync(path, "utf8"), { window, ...time });
  return { api: window.OMP_REMOTE_VIEW, window, time };
}
const ask = (id, method = "confirm", extra = {}) => ({ kind: "ask", id, method, title: "Continue?", answered: false, cancelled: false, ...extra });
const snapshot = (extra = {}) => ({ activeSessionId: "a", sessions: [{ id: "a", name: "Work", path: "/project" }], messages: [], isStreaming: false, queue: {}, ...extra });
// The remote status the action guard reads: device "d" is paired and connected.
const liveStatus = () => ({ listening: true, devices: [{ id: "d", connected: true }] });

test("buildView keeps the echo flag of a user message omp handed to the model later", () => {
  const { api } = load();
  const view = api.buildView(snapshot({ messages: [
    { kind: "user", id: "u1", text: "first" },
    { kind: "user", id: "u2", text: "steer", echo: true },
  ] }));
  assert.deepEqual(Array.from(view.messages, m => m.echo), [undefined, true]);
});

test("desktop context inspection never publishes native instructions to the phone", () => {
  const { api } = load();
  const view = api.buildView(snapshot({
    agentContext: { byId: { main: { instructions: [{ text: "Private native system prompt" }] } } },
    messages: [{ kind: "user", id: "u", text: "Public conversation" }],
  }));
  assert.deepEqual(own(view.messages), [{ id: "u", role: "user", text: "Public conversation" }]);
  assert.equal(JSON.stringify(view).includes("Private native system prompt"), false);
});

test("buildView marks an index-derived id as synthetic and leaves real ids unmarked", () => {
  const { api } = load();
  const view = api.buildView(snapshot({ messages: [
    { kind: "user", text: "no id" },
    { kind: "user", id: "u1", text: "real" },
    { kind: "tool", _toolCallId: "c1", tool: "bash", output: "x" },
  ] }));
  assert.deepEqual(Array.from(view.messages, m => m.idSynthetic), [true, undefined, undefined]);
});

test("buildView keeps a ts-derived id real so a streaming reply keeps its fade key", async () => {
  const { api } = load();
  const C = createRequire(import.meta.url)("../src/remote/client.js");
  const view = text => api.buildView(snapshot({ messages: [{ kind: "assistant", ts: 5, text }] }));
  const first = C.trackShown(new Set(), view("Hel").messages);
  const second = C.trackShown(first.shown, view("Hello wor").messages);
  assert.equal(first.fresh.size, 1);
  assert.equal(second.fresh.size, 0, "growing text of the same ts row is not fresh");
  assert.equal(view("x").messages[0].idSynthetic, undefined);
});

test("buildView maps live message shapes, drops thinking and retains only open asks", () => {
  const { api } = load();
  const view = api.buildView(snapshot({ isStreaming: true, messages: [
    { kind: "user", id: "u", text: "Hello" },
    { kind: "assistant", id: "a", thought: "private reasoning", blocks: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "Hi" }, { type: "text", text: "there" }] },
    { kind: "thinking", text: "secret" },
    { kind: "tool", _toolCallId: "t", tool: "bash", title: "Run tests", summary: "Passed", output: [{ line: "one", color: "accent" }, { line: "two" }] },
    { role: "assistant", id: "r", text: "Role entry" },
    { kind: "notice", id: "n", text: "Stopped" },
    ask("q", "ask", { questions: [{ id: "q1", question: "Pick", options: [] }] }),
    ask("answered", "select", { answered: true }), ask("cancelled", "input", { cancelled: true }),
    ask("closed", "editor", { closedByOmp: true }),
    ask("ed", "editor", { prefill: "initial draft" }),
  ] }));
  assert.deepEqual(own(view), {
    tabId: "a", busy: true,
    messages: [
      { id: "u", role: "user", text: "Hello" },
      { id: "a", role: "assistant", text: "Hi\nthere" },
      { id: "t", role: "tool", text: "Run tests", tool: { name: "bash", summary: "Passed", output: "one\ntwo" } },
      { id: "r", role: "assistant", text: "Role entry" },
      { id: "n", role: "notice", text: "Stopped" },
    ],
    asks: [
      { id: "q", kind: "dialog", title: "Continue?", message: "", questions: [{ id: "q1", question: "Pick", options: [] }] },
      { id: "ed", kind: "editor", title: "Continue?", message: "", value: "initial draft" },
    ],
  });
  assert.ok(!JSON.stringify(view).includes("secret"));
  assert.deepEqual(own(api.tabMeta([{ id: "x", name: "Title", path: "/work", profile: "private" }])), [{ id: "x", title: "Title", project: "work" }]);
});

test("buildView trims to last 100 messages and 2 000 tool characters without losing older open asks", () => {
  const { api } = load();
  const messages = [ask("old"), ...Array.from({ length: 110 }, (_, id) => ({ kind: "user", id: String(id), text: String(id) })),
    { kind: "tool", id: "tool", tool: "read", output: "x".repeat(2200) }];
  const view = api.buildView(snapshot({ messages }));
  assert.equal(view.messages.length, 100);
  assert.equal(view.messages[0].id, "11");
  assert.equal(view.messages.at(-1).tool.output, "x".repeat(2000));
  assert.equal(view.asks[0].id, "old");
  assert.equal(api.buildView(snapshot({ messages }), { maxMessages: 2, maxToolChars: 3 }).messages.at(-1).tool.output, "xxx");
});

test("answerCall dispatches select / confirm / input / editor / dialog / cancel", () => {
  const { api } = load();
  for (const [kind, value, method] of [
    ["select", "Approve", "answerAsk"], ["confirm", false, "answerConfirm"],
    ["input", "typed", "answerAsk"], ["editor", "line\nline", "answerAsk"],
    ["dialog", [{ id: "1", selectedOptions: ["yes"] }], "answerAskDialog"],
    ["ask", [{ id: "1", selectedOptions: [] }], "answerAskDialog"],
  ]) {
    assert.deepEqual(own(api.answerCall({ id: "q", kind }, value)), { method, args: ["q", value] });
    assert.deepEqual(own(api.answerCall({ id: "q", kind }, null)), { method: "cancelAsk", args: ["q"] });
  }
});

test("viewsEqual compares structure rather than identity and detects changed message text", () => {
  const { api } = load();
  const a = { tabId: "a", messages: [{ id: "x", role: "user", text: "before" }], asks: [], busy: false };
  assert.equal(api.viewsEqual(a, own(a)), true);
  assert.equal(api.viewsEqual(a, { busy: false, asks: [], messages: own(a.messages), tabId: "a" }), true);
  assert.equal(api.viewsEqual(a, { ...a, messages: [{ ...a.messages[0], text: "after" }] }), false);
});

test("answer for a background tab switches first and answers once", async () => {
  const { api, time } = load();
  let snap = snapshot();
  const calls = [], results = [];
  const bridge = {
    async activateSession(id) {
      calls.push("activateSession");
      snap = snapshot({ activeSessionId: id });
      time.setTimeout(() => { snap = { ...snap, messages: [ask("q")] }; }, 300);
    },
    answerConfirm(id, value) {
      calls.push("answerConfirm");
      assert.equal(id, "q"); assert.equal(value, true);
      snap = { ...snap, messages: [ask("q", "confirm", { answered: true })] };
    },
    remoteActionResult: (...args) => results.push(args),
  };
  const handle = api.makeActionHandler(bridge, () => snap, liveStatus);
  const action = { reqId: "first", deviceId: "d", tabId: "b", kind: "answer", askId: "q", value: true };
  const first = handle(action);
  await time.advance(299);
  assert.deepEqual(calls, ["activateSession"]);
  await time.advance(1); await first;
  assert.deepEqual(calls, ["activateSession", "answerConfirm"]);
  assert.deepEqual(results, [["first", true]]);
  const second = handle({ ...action, reqId: "second" });
  await time.advance(5000); await second;
  assert.deepEqual(calls, ["activateSession", "answerConfirm"]);
  assert.deepEqual(results.at(-1), ["second", false, "question no longer open"]);
});

test("prompt while streaming goes to steer; actions are serialised", async () => {
  const { api } = load();
  let release;
  const calls = [];
  const handle = api.makeActionHandler({
    steer(text) { calls.push(["steer", text]); return new Promise((resolve) => { release = resolve; }); },
    abort() { calls.push(["abort"]); },
    remoteActionResult(...args) { calls.push(["result", ...args]); },
  }, () => snapshot({ isStreaming: true }), liveStatus);
  const first = handle({ reqId: "1", deviceId: "d", tabId: "a", kind: "prompt", text: "change" });
  const second = handle({ reqId: "2", deviceId: "d", tabId: "a", kind: "abort" });
  await flush();
  assert.deepEqual(calls, [["steer", "change"]]);
  release(); await Promise.all([first, second]);
  assert.deepEqual(calls, [["steer", "change"], ["result", "1", true], ["abort"], ["result", "2", true]]);
});

test("failed or ignored activation never acts on another tab and queue survives errors", async () => {
  const { api } = load();
  const calls = [];
  let reject = true;
  const handle = api.makeActionHandler({
    activateSession() { if (reject) throw new Error("closed"); },
    send() { calls.push("wrong tab"); },
    remoteActionResult: (...args) => calls.push(args),
  }, () => snapshot(), liveStatus);
  await handle({ reqId: "1", deviceId: "d", tabId: "missing", kind: "prompt", text: "oops" });
  reject = false;
  await handle({ reqId: "2", deviceId: "d", tabId: "missing", kind: "select" });
  assert.deepEqual(calls, [["1", false, "tab not available"], ["2", false, "tab not available"]]);
});

function hookHarness({ delayed = false } = {}) {
  const { window, time } = load();
  const events = new Map(), effects = [], published = [], ready = [], tweakListeners = new Set();
  const tweaks = { theme: "aurora", accent: "#8AF0C8" };
  Object.assign(window, {
    TWEAK_DEFAULTS: tweaks,
    OMP_TWEAKS_STORE: { read: () => ({ ...tweaks }) },
    OMP_SETTINGS: { THEMES: [{ id: "aurora", tone: "dark" }, { id: "daylight", tone: "light" }] },
    addEventListener: (name, fn) => { if (name === "tweakchange") tweakListeners.add(fn); },
    removeEventListener: (name, fn) => { if (name === "tweakchange") tweakListeners.delete(fn); },
  });
  let update, stopped = 0;
  const bridge = {
    onUpdate(cb) { update = cb; cb(snapshot()); return () => { stopped++; }; },
    onRemoteEvent(kind, cb) {
      events.set(kind, cb);
      const unlisten = () => { events.delete(kind); stopped++; };
      if (!delayed) return Promise.resolve(unlisten);
      return new Promise((resolve) => time.setTimeout(() => resolve(unlisten), 100));
    },
    remoteReady: (value) => { ready.push(value); },
    remotePublish: (payload) => { published.push({ at: time.Date.now(), payload: own(payload) }); },
    remoteStatus: async () => null,
  };
  runInNewContext(source("src/app/use-remote.jsx"), { window, React: { useEffect: (fn) => effects.push(fn) }, ...time });
  window.useRemote({ bridge });
  const cleanup = effects[0]();
  return {
    bridge, events, time, published, ready, cleanup, update: (snap) => update(snap), get stopped() { return stopped; },
    tweakListeners,
    setTweaks: (edits) => { Object.assign(tweaks, edits); for (const fn of [...tweakListeners]) fn(); },
  };
}

test("publisher requires listening and connected device, throttles changes and ignores equal views", async () => {
  const h = hookHarness();
  await flush();
  assert.deepEqual(h.ready, [true]);
  assert.equal(h.published.length, 0);
  h.events.get("status")({ listening: true, devices: [{ connected: false }] });
  await h.time.advance(1000);
  // Listening without a phone: the tab list goes out, the view does not.
  assert.equal(h.published.length, 1);
  assert.equal(h.published[0].payload.view, null);
  assert.equal(h.published[0].payload.tabs[0].id, "a");
  h.events.get("status")({ listening: true, devices: [{ connected: true }] });
  await h.time.advance(0);
  assert.equal(h.published.length, 2);
  assert.equal(h.published[1].payload.view.tabId, "a");
  h.published.shift();
  for (let i = 0; i < 10; i++) h.update(snapshot({ messages: [{ kind: "user", id: "u", text: String(i) }] }));
  await h.time.advance(249);
  assert.equal(h.published.length, 1);
  await h.time.advance(1);
  assert.equal(h.published.length, 2);
  assert.equal(h.published[1].payload.view.messages[0].text, "9");
  h.update(snapshot({ messages: [{ kind: "user", id: "u", text: "9" }] }));
  await h.time.advance(500);
  assert.equal(h.published.length, 2);
  h.update(snapshot({ sessions: [{ id: "a", name: "Renamed", path: "/project" }], messages: [{ kind: "user", id: "u", text: "9" }] }));
  await h.time.advance(250);
  assert.equal(h.published.at(-1).payload.tabs[0].title, "Renamed");
  assert.equal(h.published.length, 3);
  h.events.get("status")({ listening: false, devices: [{ connected: true }] });
  h.update(snapshot({ messages: [{ kind: "user", text: "not sent" }] }));
  await h.time.advance(500);
  assert.equal(h.published.length, 3);
  h.events.get("status")({ listening: true, devices: [{ connected: false }] });
  await h.time.advance(500);
  assert.equal(h.published.length, 4, "the last phone leaving publishes view: null once");
  assert.equal(h.published.at(-1).payload.view, null);
  h.cleanup();
  assert.deepEqual(h.ready, [true, false]);
  assert.equal(h.stopped, 4);
  assert.equal(h.time.pending, 0);
});

test("publisher sends the active theme and republishes when the tweaks change it", async () => {
  const h = hookHarness();
  await flush();
  h.events.get("status")({ listening: true, devices: [{ connected: false }] });
  await h.time.advance(1000);
  assert.deepEqual(h.published[0].payload.theme, { id: "aurora", tone: "dark", accent: "#8AF0C8" });
  h.setTweaks({ theme: "daylight", accent: "#1F8A5B" });
  await h.time.advance(250);
  assert.equal(h.published.length, 2);
  assert.deepEqual(h.published[1].payload.theme, { id: "daylight", tone: "light", accent: "#1F8A5B" });
  h.cleanup();
  assert.equal(h.tweakListeners.size, 0, "unmount removes the tweakchange listener");
});

test("publisher unmount removes listeners even when asynchronous registration finishes late", async () => {
  const h = hookHarness({ delayed: true });
  h.cleanup();
  await h.time.advance(100);
  assert.deepEqual(h.ready, [false], "never ready when torn down before the listeners exist");
  assert.equal(h.events.size, 0);
  assert.equal(h.stopped, 4);
  assert.equal(h.published.length, 0);
});

// Keep unrelated live-state initialization inert, but execute the complete
// live.js module and its real invoke wrapper. Tauri is attached only after
// startup, avoiding process spawning or filesystem effects in this test.
function liveBridge() {
  const window = {
    OMP_SLASH: { LOCAL_COMMANDS: [] }, OMP_SUBAGENTS: { emptySubagents: () => ({}) },
    OMP_QUEUE: { EMPTY_QUEUE: {} }, OMP_GOAL: { UNKNOWN: {} }, OMP_EXT_WIDGETS: { EMPTY: {} },
    OMP_TRANSCRIPT: {}, OMP_PROMPT_HISTORY: { DEFAULT_LIMIT: 100 },
    OMP_SESSION_PREFS: { fromTweaks: () => ({}) }, OMP_TWEAKS_STORE: { read: () => ({}) },
    INTENT_FRAMING: () => "", timeNow: () => "00:00",
  };
  runInNewContext(source("src/app/live-voice.js"), { window });
  runInNewContext(source("src/app/agent-context.js"), { window });
  runInNewContext(source("src/app/agent-context-sync.js"), { window });
  const logs = [], calls = [], listeners = new Map();
  runInNewContext(source("src/live.js"), { window, console: { log() {}, error: (...args) => logs.push(args) } });
  let fail = false, stopped = 0;
  window.__TAURI__ = {
    core: { async invoke(command, args) {
      calls.push([command, args === undefined ? null : own(args)]);
      if (fail) throw new Error("command not found");
      return { command };
    } },
    event: { async listen(name, cb) {
      if (fail) throw new Error("event not available");
      listeners.set(name, cb);
      return () => { listeners.delete(name); stopped++; };
    } },
  };
  return { bridge: window.OMP_BRIDGE, logs, calls, listeners, fail: () => { fail = true; }, get stopped() { return stopped; } };
}

test("remote bridge invokes exact commands and camelCase arguments without logging missing commands", async () => {
  const h = liveBridge();
  const cases = [
    ["remoteStatus", [], "remote_status", null],
    ["remoteInterfaces", [], "remote_interfaces", null],
    ["remoteApply", [{ enabled: true }], "remote_apply_settings", { settings: { enabled: true } }],
    ["remotePairStart", [], "remote_pair_start", null],
    ["remotePairCancel", [], "remote_pair_cancel", null],
    ["remoteDeviceRename", ["d", "Phone"], "remote_device_rename", { id: "d", name: "Phone" }],
    ["remoteDeviceRevoke", ["d"], "remote_device_revoke", { id: "d" }],
    ["remoteRegenerateCert", [], "remote_regenerate_cert", null],
    ["remotePushTest", [], "remote_push_test", null],
    ["remoteDefaultContact", [], "remote_default_contact", null],
    ["remotePublish", [{ tabs: [], view: { tabId: "a" } }], "remote_publish", { payload: { tabs: [], view: { tabId: "a" } } }],
    ["remoteActionResult", ["req", false, "refused"], "remote_action_result", { reqId: "req", ok: false, error: "refused" }],
    ["remoteReady", [true], "remote_ready", { ready: true }],
  ];
  for (const [method, args, command, payload] of cases) {
    await h.bridge[method](...args);
    assert.deepEqual(h.calls.at(-1), [command, payload]);
  }
  h.fail();
  for (const [method, args] of cases) await h.bridge[method](...args);
  assert.equal(h.logs.length, 0);
  assert.deepEqual(own(await h.bridge.remotePublish({ tabs: [], view: null })), { ok: false, error: "command not found" });
  assert.equal(await h.bridge.remoteStatus(), null);
});

test("remote bridge listeners forward only payloads, unlisten, and stay quiet on missing events", async () => {
  const h = liveBridge(), received = [];
  for (const kind of ["watch", "action", "status"]) {
    const stop = await h.bridge.onRemoteEvent(kind, value => received.push(value));
    h.listeners.get(`remote://${kind}`)({ payload: { kind }, event: "not forwarded" });
    stop();
  }
  assert.deepEqual(received, [{ kind: "watch" }, { kind: "action" }, { kind: "status" }]);
  assert.equal(h.stopped, 3);
  assert.equal(h.listeners.size, 0);
  h.fail();
  (await h.bridge.onRemoteEvent("status", () => {}))();
  assert.equal(h.logs.length, 0);
});

test("publisher action listener dispatches using the latest snapshot", async () => {
  const h = hookHarness(), calls = [];
  h.bridge.send = text => { calls.push(["send", text]); };
  h.bridge.steer = text => { calls.push(["steer", text]); };
  h.bridge.remoteActionResult = (...args) => { calls.push(["result", ...args]); };
  await flush();
  h.events.get("status")({ listening: true, devices: [{ id: "d", connected: true }] });
  h.events.get("action")({ reqId: "1", deviceId: "d", tabId: "a", kind: "prompt", text: "idle" });
  await flush();
  h.update(snapshot({ isStreaming: true }));
  h.events.get("action")({ reqId: "2", deviceId: "d", tabId: "a", kind: "prompt", text: "busy" });
  await flush();
  assert.deepEqual(calls, [["send", "idle"], ["result", "1", true], ["steer", "busy"], ["result", "2", true]]);
  h.cleanup();
});

test("readiness is announced only after every listener is registered", async () => {
  const h = hookHarness({ delayed: true });
  await h.time.advance(99);
  assert.deepEqual(h.ready, []);
  await h.time.advance(1);
  assert.deepEqual(h.ready, [true]);
  h.cleanup();
});

test("a failed publish is not remembered, so the same payload is sent again", async () => {
  const h = hookHarness();
  let ok = false;
  h.bridge.remotePublish = payload => { h.published.push({ payload: own(payload) }); return ok ? { ok: true } : { ok: false, error: "refused" }; };
  await flush();
  h.events.get("status")({ listening: true, devices: [{ connected: true }] });
  await h.time.advance(250);
  assert.equal(h.published.length, 1);
  ok = true;
  h.update(snapshot({ messages: [{ kind: "user", id: "u", text: "again" }] }));
  await h.time.advance(250);
  h.update(snapshot({ messages: [{ kind: "user", id: "u", text: "again" }] }));
  await h.time.advance(500);
  assert.equal(h.published.length, 2, "retried once on the next change, then remembered");
  h.cleanup();
});

test("tool output is cut without leaving half a surrogate pair", () => {
  const { api } = load();
  const out = max => api.buildView(snapshot({ messages: [{ kind: "tool", id: "t", tool: "x", output: "ab😀cd" }] }), { maxToolChars: max }).messages[0].tool.output;
  assert.equal(out(3), "ab");
  assert.equal(out(4), "ab😀");
  assert.equal(out(2), "ab");
});

test("failed assistant bubbles become notices; hidden rows and empty notices are skipped; no tab means no view", () => {
  const { api, window } = load();
  window.OMP_TURN_STATUS = { isHidden: m => !!m.superseded };
  const view = api.buildView(snapshot({ messages: [
    { kind: "assistant", id: "f1", failure: { headline: "Rate limited", raw: "429" } },
    { kind: "assistant", id: "f2", failure: { raw: "boom" } },
    { kind: "assistant", id: "f3", text: "partial", failure: { headline: "x" } },
    { kind: "assistant", id: "f4", failure: {} },
    { kind: "notice", id: "e", text: "" },
    { kind: "user", id: "s", text: "hidden", superseded: true },
  ] }));
  assert.deepEqual(own(view.messages), [
    { id: "f1", role: "notice", text: "Rate limited" },
    { id: "f2", role: "notice", text: "boom" },
    { id: "f3", role: "assistant", text: "partial" },
  ]);
  assert.equal(api.buildView(snapshot({ activeSessionId: null })), null);
  assert.equal(api.buildView(null), null);
});

test("phone answers are validated per ask kind before reaching omp", async () => {
  const { api } = load();
  const open = (id, method, extra = {}) => ask(id, method, extra);
  const dialog = [{ id: "q1", question: "Pick", options: [{ label: "A" }] }];
  const cases = [
    [open("c", "confirm"), "yes", "invalid answer"],
    [open("c", "confirm"), true, null],
    [open("s", "select", { options: ["A", "B"] }), "C", "invalid answer"],
    [open("s", "select", { options: ["A", "B"] }), "B", null],
    [open("i", "input"), 5, "invalid answer"],
    [open("e", "editor"), "text", null],
    [open("d", "ask", { questions: dialog }), "A", "invalid answer"],
    [open("d", "ask", { questions: dialog }), [{ id: "q1", selectedOptions: "A" }], "invalid answer"],
    [open("d", "ask", { questions: dialog }), [{ id: "q1", selectedOptions: ["A"] }], null],
    // Strict dialog rules, same as app/ask-dialog.js.
    ...[
      [[], "invalid answer"],
      [[{ id: "q1", selectedOptions: ["A"] }, { id: "q2", selectedOptions: [] }], "invalid answer"],
      [[{ id: "other", selectedOptions: ["A"] }], "invalid answer"],
      [[{ id: "q1", selectedOptions: ["Z"] }], "invalid answer"],
      [[{ id: "q1", selectedOptions: [5] }], "invalid answer"],
      [[{ id: "q1", selectedOptions: ["A", "B"] }], "invalid answer"],
      [[{ id: "q1", selectedOptions: ["A"], customInput: {} }], "invalid answer"],
      [[{ id: "q1", selectedOptions: ["A"], customInput: "x" }], "invalid answer"],
      [[{ id: "q1", selectedOptions: [], customInput: "x" }], null],
      [[{ id: "q1", selectedOptions: ["A"], customInput: "" }], null],
    ].map(([value, expected]) => [open("d", "ask", { questions: [{ id: "q1", question: "Pick", options: [{ label: "A" }, { label: "B" }] }] }), value, expected]),
    [open("m", "ask", { questions: [{ id: "q1", question: "Any", multi: true, options: [{ label: "A" }, { label: "B" }] }] }), [{ id: "q1", selectedOptions: ["A", "B"] }], null],
    [open("m", "ask", { questions: [{ id: "q1", question: "Any", multi: true, options: [{ label: "A" }, { label: "B" }] }] }), [{ id: "q1", selectedOptions: ["A", "A"] }], "invalid answer"],
  ];
  for (const [item, value, expected] of cases) {
    const card = (await runAnswer(api, item, value)).card;
    assert.equal(card.error, expected, `${card.kind} ${JSON.stringify(value)}`);
  }
});

async function runAnswer(api, item, value) {
  const calls = [], results = [];
  const snap = snapshot({ messages: [item] });
  const handle = api.makeActionHandler({
    answerAsk: (...a) => calls.push(a), answerConfirm: (...a) => calls.push(a), answerAskDialog: (...a) => calls.push(a),
    remoteActionResult: (...a) => results.push(a),
  }, () => snap, liveStatus);
  await handle({ reqId: "r", deviceId: "d", tabId: "a", kind: "answer", askId: item.id, value });
  return { card: { kind: item.method, error: results[0][1] ? null : results[0][2] }, calls };
}

test("blank prompt and steer text is refused", async () => {
  const { api } = load();
  const calls = [], results = [];
  const handle = api.makeActionHandler({ send: t => calls.push(t), steer: t => calls.push(t), remoteActionResult: (...a) => results.push(a) }, () => snapshot(), liveStatus);
  await handle({ reqId: "1", deviceId: "d", tabId: "a", kind: "prompt", text: "  " });
  await handle({ reqId: "2", deviceId: "d", tabId: "a", kind: "steer" });
  await handle({ reqId: "3", deviceId: "d", tabId: "a", kind: "prompt", text: "go" });
  assert.deepEqual(calls, ["go"]);
  assert.deepEqual(results, [["1", false, "invalid text"], ["2", false, "invalid text"], ["3", true]]);
});

// ---- guarded action queue ---------------------------------------------------
function guarded(bridgeExtra = {}, snap = () => snapshot()) {
  const { api, time } = load();
  const calls = [], results = [];
  const status = { listening: true, devices: [{ id: "d", connected: true }] };
  const bridge = {
    send: t => { calls.push(["send", t]); }, steer: t => { calls.push(["steer", t]); }, abort: () => { calls.push(["abort"]); },
    answerConfirm: (...a) => { calls.push(["answerConfirm", ...a]); },
    remoteActionResult: (...a) => { results.push(a); }, ...bridgeExtra,
  };
  return { handle: api.makeActionHandler(bridge, snap, () => status), status, calls, results, time };
}
const prompt = (reqId, extra = {}) => ({ reqId, deviceId: "d", tabId: "a", kind: "prompt", text: "go", ...extra });

test("revoking the device during the ask wait drops the answer, even once the ask appears", async () => {
  let snap = snapshot();
  const h = guarded({}, () => snap);
  const pending = h.handle({ reqId: "r", deviceId: "d", tabId: "a", kind: "answer", askId: "q", value: true });
  await h.time.advance(1000);
  h.status.devices = [];
  h.time.setTimeout(() => { snap = snapshot({ messages: [ask("q")] }); }, 500);
  await h.time.advance(6000); await pending;
  assert.deepEqual(h.results, [["r", false, "device revoked"]]);
  assert.deepEqual(h.calls, []);
});

test("revoking during the tab switch means the later prompt is not sent", async () => {
  let snap = snapshot({ activeSessionId: "other" });
  const h = guarded({ activateSession: async id => { h.status.devices = []; snap = snapshot({ activeSessionId: id }); } }, () => snap);
  await h.handle(prompt("1"));
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.results, [["1", false, "device revoked"]]);
});

test("a device that is connected no longer, or a stopped server, drops queued actions", async () => {
  const h = guarded();
  h.status.devices = [{ id: "d", connected: false }];
  await h.handle(prompt("1"));
  h.status.devices = [{ id: "other", connected: true }];
  await h.handle(prompt("2"));
  h.status.devices = [{ id: "d", connected: true }]; h.status.listening = false;
  await h.handle(prompt("3"));
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.results.map(r => r.slice(0, 2)), [["1", false], ["2", false], ["3", false]]);
  assert.deepEqual(h.results.map(r => r[2]), ["device revoked", "device revoked", "remote access disabled"]);
});

test("an action older than the 15 s ack timeout is dropped as expired", async () => {
  let release;
  const h = guarded({ send: t => { h.calls.push(["send", t]); return new Promise(resolve => { release = resolve; }); } });
  const first = h.handle(prompt("1"));
  const second = h.handle(prompt("2", { text: "late" }));
  await h.time.advance(15001);
  release(true); await Promise.all([first, second]);
  assert.deepEqual(h.calls, [["send", "go"]]);
  assert.deepEqual(h.results, [["1", true], ["2", false, "expired"]]);
});

test("the queue holds 16 actions; more are refused as busy at once", async () => {
  let release, hold = true;
  const h = guarded({ send: t => { h.calls.push(["send", t]); return hold ? new Promise(resolve => { release = resolve; }) : true; } });
  const all = Array.from({ length: 20 }, (_, i) => h.handle(prompt(String(i))));
  await flush();
  assert.deepEqual(h.results, [16, 17, 18, 19].map(i => [String(i), false, "busy"]));
  for (let i = 0; i < 16; i++) { release(true); await flush(); }
  hold = false;
  await Promise.all(all);
  assert.equal(h.results.filter(r => r[1] === true).length, 16);
  await h.handle(prompt("again"));
  assert.deepEqual(h.results.at(-1), ["again", true], "slots free up once the queue drains");
});

test("a failed or rejected IPC hand-off is acked as not delivered", async () => {
  for (const outcome of [() => false, () => Promise.reject(new Error("ipc down"))]) {
    const h = guarded({ send: outcome, abort: outcome, answerConfirm: outcome }, () => snapshot({ messages: [ask("q")] }));
    await h.handle(prompt("1"));
    await h.handle({ reqId: "2", deviceId: "d", tabId: "a", kind: "abort" });
    await h.handle({ reqId: "3", deviceId: "d", tabId: "a", kind: "answer", askId: "q", value: true });
    assert.deepEqual(h.results, ["1", "2", "3"].map(id => [id, false, "desktop could not deliver"]));
  }
});

// ---- live.js reports the IPC hand-off ---------------------------------------
test("live bridge senders resolve to false when nothing can be handed off", async () => {
  const h = liveBridge();
  // No active tab: nothing can be handed off, and nothing is invoked.
  assert.equal(await h.bridge.abort(), false);
  assert.equal(await h.bridge.answerAsk("none", "x"), false);
  assert.equal(await h.bridge.answerAskDialog("none", []), false);
  assert.equal(await h.bridge.answerConfirm("none", true), false);
  assert.equal(await h.bridge.cancelAsk("none"), false);
  assert.equal(h.calls.filter(c => c[0] === "send_command").length, 0);
});

// ---- settings: delayed push toggles merge against the newest settings -------
// The settings rows compiled with a hook-slot React stand-in; `render` resets
// the slots, the rows' own top-level functions land on `scope`.
function remoteRows() {
  const Babel = createRequire(import.meta.url)(fileURLToPath(new URL("../src/babel.min.js", import.meta.url)));
  const slots = []; let i = 0;
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((v, k) => !Object.is(v, b[k]));
  const React = {
    Fragment: "fragment",
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const k = i++;
      if (!(k in slots)) slots[k] = { value: initial };
      const s = slots[k];
      return [s.value, v => { s.value = typeof v === "function" ? v(s.value) : v; }];
    },
    useEffect(fn, deps) { const k = i++; if (!slots[k] || changed(slots[k].deps, deps)) { slots[k] = { deps }; fn(); } },
    useCallback: fn => fn,
  };
  const window = { Icon: {} };
  const scope = { window, React };
  for (const file of ["rows-remote-shared.jsx", "rows-remote-server.jsx", "rows-remote-phones.jsx"]) {
    const { code } = Babel.transform(source(`src/design/settings/${file}`), { presets: ["react"] });
    runInNewContext(code, scope);
  }
  return { window, scope, reset: () => { i = 0; } };
}

test("two delayed push toggles both survive: nested push merges inside the queue", async () => {
  const { window, reset } = remoteRows();
  const applies = [];
  const settings = { enabled: true, cert: {}, push: { enabled: true, questions: false, finished: false, contact: "me@example.test" } };
  const bridge = {
    onRemoteEvent: () => () => {}, remoteStatus: async () => ({ settings, devices: [] }),
    remoteDefaultContact: async () => "", remoteApply: s => new Promise(resolve => applies.push({ s, resolve })),
  };
  const render = () => { reset(); return window.OMP_SETTINGS_ROWS.remotePush({ row: {}, ctx: { bridge }, query: "" }); };
  const find = (node, label) => {
    if (!node || typeof node !== "object") return null;
    if (node.props?.label === label) return node;
    for (const child of node.children.flat()) { const hit = find(child, label); if (hit) return hit; }
    return null;
  };
  render(); await flush(); await flush();
  const tree = render();
  find(tree, "Notify on questions").props.onChange(true);
  find(tree, "Notify on finished turns").props.onChange(true);
  // Editing the contact and enabling push before the first apply settles must
  // keep the newly committed contact instead of the initial render's contact.
  const contactField = find(tree, "Push contact");
  contactField.props.onCommit("fresh@omp-desktop.app");
  find(tree, "Enable push notifications").props.onChange(true);
  await flush();
  assert.equal(applies.length, 1, "subsequent applies wait in the queue");
  assert.equal(applies[0].s.push.questions, true);
  while (applies.length < 4) {
    const cur = applies.at(-1);
    cur.resolve({ ok: true, value: { settings: cur.s, devices: [] } });
    await flush();
  }
  assert.deepEqual(own(applies[3].s.push), { enabled: true, questions: true, finished: true, contact: "fresh@omp-desktop.app" });
});

test("the only-while-locked switch shows only where lock detection exists and patches push", async () => {
  const { window, reset } = remoteRows();
  const find = (node, label) => {
    if (!node || typeof node !== "object") return null;
    if (node.props?.label === label) return node;
    for (const child of node.children.flat()) { const hit = find(child, label); if (hit) return hit; }
    return null;
  };
  const LABEL = "Notify only while the desktop is locked";
  const rendered = async (lockDetection, applies = []) => {
    const settings = { enabled: true, cert: {}, push: { enabled: true, questions: true, finished: true, contact: "me@example.test", onlyWhenLocked: false } };
    const bridge = {
      onRemoteEvent: () => () => {}, remoteStatus: async () => ({ settings, devices: [], lockDetection }),
      remoteDefaultContact: async () => "",
      remoteApply: async s => { applies.push(s); return { ok: true, value: { settings: s, devices: [], lockDetection } }; },
    };
    const render = () => { reset(); return window.OMP_SETTINGS_ROWS.remotePush({ row: {}, ctx: { bridge }, query: "" }); };
    render(); await flush(); await flush();
    return render();
  };
  assert.equal(find(await rendered(false), LABEL), null, "hidden without lock detection");
  const applies = [];
  const tree = await rendered(true, applies);
  find(tree, LABEL).props.onChange(true);
  await flush(); await flush();
  assert.equal(applies.length, 1);
  assert.equal(applies[0].push.onlyWhenLocked, true);
  assert.equal(applies[0].push.contact, "me@example.test", "the rest of push is kept");
});

// ---- settings: Enter confirms an IME candidate, it does not commit the field --
test("Enter during IME composition does not blur a settings field", () => {
  const { scope, reset } = remoteRows();
  const field = () => { reset(); return scope._SRR_Field({ value: "", onCommit() {}, label: "Device name" }); };
  const press = (event) => {
    let blurred = 0;
    field().props.onKeyDown({ key: "Enter", keyCode: 13, nativeEvent: {}, ...event, currentTarget: { blur: () => { blurred++; } } });
    return blurred;
  };
  assert.equal(press({}), 1, "a plain Enter commits");
  assert.equal(press({ nativeEvent: { isComposing: true } }), 0, "composition Enter is ignored");
  assert.equal(press({ keyCode: 229 }), 0, "keyCode 229 is a composition Enter too");
  assert.equal(press({ key: "a" }), 0, "other keys do not blur");
});

// ---- settings: a rejected value does not stay in the field -------------------
test("parsePort accepts only integers in 1-65535", () => {
  const { scope } = remoteRows();
  for (const [text, want] of [["7470", 7470], [" 80 ", 80], ["65535", 65535], ["1", 1],
    ["", null], ["  ", null], ["abc", null], ["0", null], ["65536", null], ["70000", null], ["-1", null], ["1.5", null]]) {
    assert.equal(scope._SRR_parsePort(text), want, JSON.stringify(text));
  }
});

test("a field whose onCommit rejects shows the saved value again; an accepted one keeps the text", () => {
  const { scope, reset } = remoteRows();
  const field = (value, onCommit) => { reset(); return scope._SRR_Field({ value, onCommit, label: "Port" }); };
  const typeAndBlur = (value, onCommit, typed) => {
    field(value, onCommit).props.onChange({ target: { value: typed } });
    field(value, onCommit).props.onBlur(); // re-render with the typed text, then leave the field
    return field(value, onCommit).props.value;
  };
  assert.equal(typeAndBlur("7470", () => false, "abc"), "7470", "rejected text is dropped");
  assert.equal(typeAndBlur("7470", () => {}, "8080"), "8080", "accepted text stays until Rust reports the new value");
});

test("the Port row rejects non-numeric, zero and out-of-range text and applies a valid port", async () => {
  const { window, reset } = remoteRows();
  const applies = [];
  const settings = { enabled: true, interface: "en0", port: 7470, hostName: null, cert: {}, push: {} };
  const bridge = {
    onRemoteEvent: () => () => {}, remoteStatus: async () => ({ settings, devices: [] }),
    remoteInterfaces: async () => [], remoteApply: async s => { applies.push(s); return { ok: true, value: { settings: s, devices: [] } }; },
  };
  const render = () => { reset(); return window.OMP_SETTINGS_ROWS.remoteServer({ row: {}, ctx: { bridge }, query: "" }); };
  const find = (node, label) => {
    if (!node || typeof node !== "object") return null;
    if (node.props?.label === label && node.props.onCommit) return node;
    for (const child of node.children.flat()) { const hit = find(child, label); if (hit) return hit; }
    return null;
  };
  render(); await flush();
  const port = find(render(), "Port");
  for (const text of ["abc", "0", "70000", ""]) assert.equal(port.props.onCommit(text), false, text);
  assert.equal(applies.length, 0, "a rejected port is never applied");
  assert.notEqual(port.props.onCommit("8080"), false);
  await flush();
  assert.equal(applies[0].port, 8080);
});

// ---- settings: the server row has no plain-HTTP switch any more -------------
test("the server row offers no plain HTTP, even for settings that still carry allowHttp", async () => {
  const { window, reset } = remoteRows();
  const settings = { enabled: true, interface: "en0", port: 7470, hostName: null, allowHttp: true, cert: {}, push: {} };
  const bridge = {
    onRemoteEvent: () => () => {}, remoteStatus: async () => ({ settings, devices: [], listening: true, url: "https://10.0.0.2:7470" }),
    remoteInterfaces: async () => [], remoteApply: async () => ({ ok: true, value: {} }),
  };
  const render = () => { reset(); return window.OMP_SETTINGS_ROWS.remoteServer({ row: {}, ctx: { bridge }, query: "" }); };
  render(); await flush();
  const text = JSON.stringify(render());
  assert.match(text, /Enable remote access/, "control: the row rendered");
  assert.doesNotMatch(text, /plain http|allowHttp|unencrypted/i);
});
