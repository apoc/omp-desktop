#!/usr/bin/env node
// Regression script for src/app/older-history.js and its live.js wiring —
// compacted history (#85, docs/architecture/compacted-history.md D6–D9):
// whether a tab has summarized history to load after a get_messages, the
// anchor and room of a load, the `session_history` items as transcript
// entries (dividers, failures judged over the whole loaded sequence), the
// prepend that keeps the newest entries, and the bridge's load: it goes in
// only on the same tab and anchor, shifts in-flight tool cards, pages on
// after a tab switch and auto-loads once with the setting on.
// Run: node tests/test-older-history.mjs  (or: npm run test:older-history)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = file => readFileSync(join(root, "src", file), "utf8");
const win = {};
for (const file of ["app/turn-status.js", "app/transcript-merge.js", "adapter.js", "app/older-history.js"]) {
  // eslint-disable-next-line no-new-func
  new Function("window", source(file))(win);
}
const H = win.OMP_OLDER_HISTORY;
const { mergeTranscript } = win.OMP_TRANSCRIPT;
const adapt = messages => win.adaptAgentMessages(messages);
const plain = v => JSON.parse(JSON.stringify(v));

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

// ── omp messages (D5 items and get_messages share the shape) ─────────────
const userMsg = (text, ts) => ({ role: "user", content: [{ type: "text", text }], timestamp: ts });
const replyMsg = (text, ts) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }], timestamp: ts });
const errorMsg = ts => ({ role: "assistant", stopReason: "error", errorMessage: "context overflow", content: [], timestamp: ts });
const summaryMsg = (ts, over = {}) => ({ role: "compactionSummary", summary: "the summary", shortSummary: "short", tokensBefore: 12000, timestamp: ts, ...over });
// A context after one compaction: the summary, then what it kept.
const CONTEXT = [summaryMsg(50), userMsg("kept", 100), replyMsg("kept reply", 110)];

// ── isAvailable / anchorTs / room ────────────────────────────────────────
await check("isAvailable: a context opening with a compaction summary, its copies oldest on screen", () => {
  assert.equal(H.isAvailable(CONTEXT, adapt(CONTEXT)), true);
});
await check("isAvailable: no compaction in the context", () => {
  const ctxNoSummary = CONTEXT.slice(1);
  assert.equal(H.isAvailable(ctxNoSummary, adapt(ctxNoSummary)), false);
  assert.equal(H.isAvailable([], []), false);
});
await check("isAvailable: a live pre-compaction entry above the copies → null (the tab's earlier verdict stands)", () => {
  const live = [{ kind: "user", ts: 5, text: "before the compaction" }, ...adapt(CONTEXT)];
  assert.equal(H.isAvailable(CONTEXT, live), null);
});
await check("isAvailable: a second compaction's context cuts the earlier copies → null, not false", () => {
  // The tab showed CONTEXT's copies (ts 100/110); omp compacted again and
  // the context is now [summary2, new…]: the oldest shown entry has no copy.
  const ctx2 = [summaryMsg(300), userMsg("new", 400), replyMsg("new reply", 410)];
  const shown = [...adapt(CONTEXT.slice(1)), ...adapt(ctx2.slice(1))];
  assert.equal(H.isAvailable(ctx2, shown), null);
});
await check("isAvailable: trimmed head → false", () => {
  assert.equal(H.isAvailable(CONTEXT, adapt(CONTEXT), { trimmed: true }), false);
});
await check("showRow: available and room under the cap", () => {
  const few = new Array(10), full = new Array(169);
  assert.equal(H.showRow({ available: true }, few, 169), true);
  assert.equal(H.showRow({ available: true }, full, 169), false, "no room: hidden");
  assert.equal(H.showRow({ available: false }, few, 169), false, "nothing to load: hidden");
  assert.equal(H.showRow(undefined, few, 169), false);
});
await check("reasonOf: the no-session-file code is a translatable source string, other errors are shown as is", () => {
  assert.deepEqual(plain(H.reasonOf(H.NO_SESSION_FILE)), { translate: true, text: "omp has not saved this conversation yet" });
  assert.notEqual(H.reasonOf(H.NO_SESSION_FILE).text, H.NO_SESSION_FILE, "the raw code is never the text");
  assert.deepEqual(plain(H.reasonOf("read failed: EACCES")), { translate: false, text: "read failed: EACCES" });
  // the source string has a Chinese entry (the row translates it at render)
  const zh = { navigator: { language: "zh-CN" }, localStorage: { getItem: () => null } };
  for (const file of ["app/i18n.js", "app/i18n-zh.js"]) new Function("window", source(file))(zh);
  zh.OMP_I18N.set("zh");
  assert.notEqual(zh.OMP_I18N.t(H.NO_SESSION_FILE_TEXT), H.NO_SESSION_FILE_TEXT);
});
await check("isAvailable: oldest entry is loaded history → null (keep the last load's verdict)", () => {
  const loaded = [{ kind: "user", ts: 10, text: "old", fromHistory: true }, ...adapt(CONTEXT)];
  assert.equal(H.isAvailable(CONTEXT, loaded), null);
});
await check("isAvailable: nothing with a ts on screen → true (the whole path is older)", () => {
  assert.equal(H.isAvailable([summaryMsg(50)], [{ kind: "tool", status: "done" }]), true);
});
await check("anchorTs: the oldest user/assistant entry with a finite ts", () => {
  const messages = [
    { kind: "compact", status: "done" },
    { kind: "tool", ts: 1 },
    { kind: "user", text: "in flight" },
    { kind: "assistant", ts: 40 },
    { kind: "user", ts: 30 },
  ];
  assert.equal(H.anchorTs(messages), 40);
  assert.equal(H.anchorTs([{ kind: "tool" }]), null);
  assert.equal(H.anchorTs(null), null);
});
await check("room: the cap minus the transcript, never negative", () => {
  assert.equal(H.room(new Array(160), 169), 9);
  assert.equal(H.room(new Array(170), 169), 0);
  assert.equal(H.room(null, 169), 169);
});

// ── adaptHistory ─────────────────────────────────────────────────────────
await check("adaptHistory: path order with a divider per compaction, every entry marked", () => {
  const out = H.adaptHistory([userMsg("u1", 10), replyMsg("a1", 20), summaryMsg(25), userMsg("u2", 30), replyMsg("a2", 40)]);
  assert.deepEqual(out.map(m => m.kind), ["user", "assistant", "compact", "user", "assistant"]);
  assert.deepEqual(out.map(m => m.ts ?? null), [10, 20, null, 30, 40]);
  assert.ok(out.every(m => m.fromHistory === true));
  assert.deepEqual(plain(out[2]), {
    kind: "compact", status: "done", shortSummary: "short", summary: "the summary", tokensBefore: 12000, fromHistory: true,
  });
});
await check("adaptHistory: a leading divider and missing summary fields", () => {
  const out = H.adaptHistory([summaryMsg(5, { summary: "", shortSummary: undefined, tokensBefore: "x" }), userMsg("u", 10)]);
  assert.deepEqual(out.map(m => m.kind), ["compact", "user"]);
  assert.equal(out[0].summary, null);
  assert.equal(out[0].shortSummary, null);
  assert.equal(out[0].tokensBefore, null);
  assert.deepEqual(H.adaptHistory(null), []);
});
await check("adaptHistory: a failure continued after a divider did not end its run", () => {
  // omp compacted on overflow and the reply went on: no failure row.
  const out = H.adaptHistory([userMsg("u", 10), errorMsg(20), summaryMsg(25), replyMsg("continued", 30)]);
  assert.deepEqual(out.map(m => m.kind), ["user", "compact", "assistant"]);
  assert.ok(!out.some(m => m.failure));
});
await check("adaptHistory: a failure followed by a new prompt across a divider ended its run", () => {
  const out = H.adaptHistory([userMsg("u", 10), errorMsg(20), summaryMsg(25), userMsg("again", 30), replyMsg("ok", 40)]);
  assert.deepEqual(out.map(m => m.kind), ["user", "assistant", "compact", "user", "assistant"]);
  assert.equal(out[1].failure?.raw, "context overflow");
  assert.equal(out[1].ts, 20);
});
await check("adaptHistory: next = assistant — a failure at the page's end is continued by the shown transcript", () => {
  // u, error, [compaction] and the oldest shown message is an assistant reply.
  const items = [userMsg("u", 10), errorMsg(20), summaryMsg(25)];
  const out = H.adaptHistory(items, { next: "assistant" });
  assert.deepEqual(out.map(m => m.kind), ["user", "compact"]);
  assert.ok(!out.some(m => m.failure));
  // the same path, uncut, shows no failure either
  assert.ok(!adapt([...items.filter(m => m.role !== "compactionSummary"), replyMsg("continued", 30)]).some(m => m.failure));
});
await check("adaptHistory: next = user — the failure at the page's end ended its run", () => {
  const items = [userMsg("u", 10), errorMsg(20), summaryMsg(25)];
  for (const next of ["user", null, undefined]) {
    const out = H.adaptHistory(items, { next });
    assert.deepEqual(out.map(m => m.kind), ["user", "assistant", "compact"]);
    assert.equal(out[1].failure?.raw, "context overflow");
  }
  assert.deepEqual(H.adaptHistory(items).map(m => m.kind), ["user", "assistant", "compact"]);
});
await check("adaptHistory: next = assistant adds no entry of its own", () => {
  assert.deepEqual(H.adaptHistory([], { next: "assistant" }), []);
  assert.deepEqual(H.adaptHistory([userMsg("u", 10)], { next: "assistant" }).map(m => m.kind), ["user"]);
});

// ── prepend ──────────────────────────────────────────────────────────────
await check("prepend: keeps the newest entries the cap takes", () => {
  const messages = Array.from({ length: 166 }, (_, i) => ({ kind: "tool", n: i }));
  const entries = [1, 2, 3, 4, 5].map(n => ({ kind: "user", ts: n }));
  const r = H.prepend(messages, entries, 169);
  assert.equal(r.added, 3);
  assert.equal(r.cut, 2);
  assert.deepEqual(r.messages.slice(0, 3).map(m => m.ts), [3, 4, 5]);
  assert.equal(r.messages[3], messages[0]);
  assert.equal(r.messages.length, 169);
});
await check("prepend: no room → the same array, all cut", () => {
  const messages = new Array(169).fill({ kind: "tool" });
  const r = H.prepend(messages, [{ kind: "user", ts: 1 }], 169);
  assert.equal(r.messages, messages);
  assert.equal(r.added, 0);
  assert.equal(r.cut, 1);
});

await check("prepend: a cut landing on a divider leaves the divider out and counts it", () => {
  const messages = Array.from({ length: 166 }, (_, i) => ({ kind: "tool", n: i }));
  const entries = [{ kind: "user", ts: 1 }, { kind: "compact" }, { kind: "user", ts: 3 }, { kind: "assistant", ts: 4 }];
  // room 3: the newest three would be [divider, 3, 4]
  const r = H.prepend(messages, entries, 169);
  assert.deepEqual(r.messages.slice(0, 2).map(m => m.ts), [3, 4]);
  assert.equal(r.messages.length, 168);
  assert.equal(r.added, 2);
  assert.equal(r.cut, 2);
  // uncut: a leading divider stays (the page starts at the path's beginning)
  const whole = H.prepend([], [{ kind: "compact" }, { kind: "user", ts: 3 }], 169);
  assert.deepEqual(whole.messages.map(m => m.kind), ["compact", "user"]);
  assert.equal(whole.cut, 0);
});
await check("prepend: room filled only by a divider → nothing added, all cut", () => {
  const messages = new Array(168).fill({ kind: "tool" });
  const r = H.prepend(messages, [{ kind: "user", ts: 1 }, { kind: "compact" }], 169);
  assert.equal(r.messages, messages);
  assert.equal(r.added, 0);
  assert.equal(r.cut, 2);
});

await check("prepend: an uncut page Rust has more before drops its leading divider; page 2 does not duplicate it", () => {
  // path: u10, err20, [compaction 25], a30 (continues the error), u40, [compaction 45]; shown: u100.
  // The adapter drops the continued error, so page 1 adapts to [divider25, a30, u40, divider45].
  const shown = [{ kind: "user", ts: 100 }];
  const page1 = H.adaptHistory([errorMsg(20), summaryMsg(25), replyMsg("c", 30), userMsg("q", 40), summaryMsg(45)], { next: "user" });
  assert.deepEqual(page1.map(m => m.kind), ["compact", "assistant", "user", "compact"]);
  const r1 = H.prepend(shown, page1, 169, { more: true });
  assert.deepEqual(r1.messages.map(m => m.kind), ["assistant", "user", "compact", "user"]);
  assert.equal(r1.added, 3);
  assert.equal(r1.cut, 1);
  // page 2 anchors on the assistant (ts 30) and Rust returns the divider again
  const page2 = H.adaptHistory([userMsg("u", 10), errorMsg(20), summaryMsg(25)], { next: H.oldestMessage(r1.messages).kind });
  const r2 = H.prepend(r1.messages, page2, 169, { more: false });
  assert.equal(r2.messages.filter(m => m.kind === "compact").length, 2, "each divider once");
  assert.deepEqual(r2.messages.map(m => m.kind), ["user", "compact", "assistant", "user", "compact", "user"]);
  // the page that starts the path (more false) keeps its leading divider
  assert.deepEqual(H.prepend(shown, page1, 169, { more: false }).messages.map(m => m.kind), ["compact", "assistant", "user", "compact", "user"]);
});

// ── mergeTranscript round-trip ───────────────────────────────────────────
await check("loaded entries stay in place through a later get_messages", () => {
  const live = adapt(CONTEXT).map((m, i) => ({ ...m, _id: i + 1 }));
  const loaded = H.adaptHistory([userMsg("old q", 10), replyMsg("old a", 20), summaryMsg(25)]);
  const shown = H.prepend(live, loaded, 169).messages;
  const merged = mergeTranscript(shown, adapt(CONTEXT));
  assert.deepEqual(merged.map(m => m.kind), ["user", "assistant", "compact", "user", "assistant"]);
  assert.equal(merged[0], shown[0]);
  assert.equal(merged[1], shown[1]);
  assert.equal(merged[2], shown[2]);
  assert.deepEqual(merged.slice(3).map(m => m.ts), [100, 110]);
  assert.deepEqual(merged.slice(3).map(m => m._id), [1, 2]);
});

// ── live.js wiring ───────────────────────────────────────────────────────
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function harness() {
  const listeners = new Map(), journal = new Map(), history = [];
  const w = {
    console: { log() {}, warn() {}, error: console.error },
    OMP_SLASH: { LOCAL_COMMANDS: [] },
    OMP_SUBAGENTS: { emptySubagents: () => ({}), subscriptionLevelFor: () => "progress", mergeSnapshots: () => ({}) },
    OMP_EXT_WIDGETS: { EMPTY: {} },
    OMP_TWEAKS_STORE: { read: () => ({}) },
    OMP_APPROVAL_MODE: { isMode: () => true },
    OMP_PROJECT_NAV: { basename: path => path.split("/").at(-1), findConversationTab: () => null, tabLayout: () => [] },
    TWEAK_DEFAULTS: { restoreTabs: false, confirmBusyClose: false, autoName: false, showCompactedHistory: false },
    DEFAULT_PROFILE_ID: "default",
    INTENT_FRAMING: () => "",
    timeNow: () => "00:00",
  };
  for (const file of ["app/message-queue.js", "app/goal.js", "app/prompt-history.js", "app/session-title.js", "app/turn-status.js",
    "app/session-prefs.js", "app/live-voice.js", "app/transcript-merge.js", "adapter.js", "app/older-history.js"]) {
    new Function("window", source(file))(w);
  }
  const timeout = (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; };
  new Function("window", "setTimeout", "clearTimeout", "console", source("live.js"))(w, timeout, clearTimeout, w.console);
  function emit(id, frame) {
    const entries = journal.get(id) ?? [];
    const envelope = { seq: entries.length + 1, text: JSON.stringify(frame) };
    entries.push(envelope);
    journal.set(id, entries);
    listeners.get(`agent://line/${id}`)?.({ payload: envelope });
  }
  w.__TAURI__ = {
    core: {
      async invoke(command, args) {
        if (command === "start_session") return "write";
        if (command === "list_profiles") return { profiles: [{ id: "default", name: "default" }] };
        if (command === "replay_events") {
          return { dropped: false, events: (journal.get(args.sessionId) ?? []).filter(e => e.seq > args.afterSeq) };
        }
        if (command === "session_history") {
          // Held until the test answers it.
          return new Promise((resolve, reject) => history.push({ args, resolve, reject }));
        }
        if (command === "send_command") {
          const cmd = JSON.parse(args.json);
          if (cmd.type === "negotiate_protocol" || cmd.type === "set_ask_dialog") {
            queueMicrotask(() => emit(args.sessionId, { type: "response", command: cmd.type, id: cmd.id, success: true, data: null }));
          }
        }
        return null;
      },
    },
    event: { async listen(name, cb) { listeners.set(name, cb); return () => listeners.delete(name); } },
  };
  const bridge = w.OMP_BRIDGE;
  let snap = null;
  bridge.onUpdate(v => { snap = v; });
  return {
    bridge, history, emit,
    snapshot: () => snap,
    messages: (id, messages) => emit(id, { type: "response", command: "get_messages", success: true, data: { messages } }),
  };
}

const ITEMS = [userMsg("old q", 10), replyMsg("old a", 20), summaryMsg(25)];

await check("bridge: load invokes session_history with the tab's file, profile, anchor and room", async () => {
  const h = harness();
  const id = await h.bridge.resumeSession({ path: "/s/a.jsonl", cwd: "/p", title: "A" });
  await flush();
  h.messages(id, CONTEXT);
  assert.deepEqual(plain(h.snapshot().olderHistory), { available: true, loading: false, error: null });
  assert.equal(h.history.length, 0, "setting off: no load by itself");
  void h.bridge.loadOlderHistory();
  assert.equal(h.snapshot().olderHistory.loading, true);
  assert.equal(h.history.length, 1);
  assert.deepEqual(plain(h.history[0].args), { sessionFile: "/s/a.jsonl", profile: "default", before: 100, limit: 167 });
  h.history[0].resolve({ items: ITEMS, more: false });
  await flush();
  const msgs = h.bridge.getState().messages;
  assert.deepEqual(msgs.map(m => m.kind), ["user", "assistant", "compact", "user", "assistant"]);
  assert.ok(msgs.every(m => m._id != null));
  assert.deepEqual(plain(h.snapshot().olderHistory), { available: false, loading: false, error: null });
});

await check("bridge: a load returned after a tab switch is dropped, loading cleared", async () => {
  const h = harness();
  const a = await h.bridge.resumeSession({ path: "/s/a.jsonl", cwd: "/a", title: "A" });
  await flush();
  h.messages(a, CONTEXT);
  void h.bridge.loadOlderHistory();
  await h.bridge.openSession("/b");
  await flush();
  h.history[0].resolve({ items: ITEMS, more: true });
  await flush();
  assert.equal(h.bridge.getState().messages.length, 0, "tab B got nothing");
  await h.bridge.activateSession(a);
  await flush();
  assert.deepEqual(h.bridge.getState().messages.map(m => m.ts), [100, 110]);
  assert.equal(h.snapshot().olderHistory.loading, false);
  assert.equal(h.snapshot().olderHistory.available, true);
});

await check("bridge: back on the tab before the load returns: not loading, the result dropped", async () => {
  const h = harness();
  const a = await h.bridge.resumeSession({ path: "/s/a.jsonl", cwd: "/a", title: "A" });
  await flush();
  h.messages(a, CONTEXT);
  void h.bridge.loadOlderHistory();
  await h.bridge.openSession("/b");
  await flush();
  await h.bridge.activateSession(a);
  await flush();
  assert.equal(h.snapshot().olderHistory.loading, false, "the row offers the button again");
  void h.bridge.loadOlderHistory();
  h.history[0].resolve({ items: ITEMS, more: true });
  await flush();
  assert.deepEqual(h.bridge.getState().messages.map(m => m.ts), [100, 110], "the first load is dropped");
  assert.equal(h.snapshot().olderHistory.loading, true, "…and leaves the newer load's state alone");
  h.history[1].resolve({ items: ITEMS, more: false });
  await flush();
  assert.deepEqual(h.bridge.getState().messages.map(m => m.ts ?? null), [10, 20, null, 100, 110]);
  assert.equal(h.snapshot().olderHistory.loading, false);
});

await check("bridge: a load whose anchor moved meanwhile is dropped", async () => {
  const h = harness();
  const id = await h.bridge.resumeSession({ path: "/s/a.jsonl", cwd: "/p", title: "A" });
  await flush();
  h.messages(id, CONTEXT);
  void h.bridge.loadOlderHistory();
  const state = h.bridge.getState();
  state.messages = [{ kind: "user", ts: 90, text: "older" }, ...state.messages];
  h.history[0].resolve({ items: ITEMS, more: true });
  await flush();
  assert.deepEqual(state.messages.map(m => m.ts), [90, 100, 110]);
  assert.equal(h.snapshot().olderHistory.loading, false);
});

await check("bridge: an error shows, and with no session file nothing is invoked", async () => {
  const h = harness();
  const id = await h.bridge.resumeSession({ path: "/s/a.jsonl", cwd: "/p", title: "A" });
  await flush();
  h.messages(id, CONTEXT);
  void h.bridge.loadOlderHistory();
  h.history[0].reject("session file is outside the sessions folder");
  await flush();
  assert.deepEqual(plain(h.snapshot().olderHistory),
    { available: true, loading: false, error: "session file is outside the sessions folder" });
  const fresh = harness();
  const b = await fresh.bridge.openSession("/b");
  await flush();
  fresh.messages(b, CONTEXT);
  void fresh.bridge.loadOlderHistory();
  await flush();
  assert.equal(fresh.history.length, 0);
  assert.equal(fresh.snapshot().olderHistory.error, H.NO_SESSION_FILE);
});

await check("bridge: in-flight tool cards move down with the prepend", async () => {
  const h = harness();
  const id = await h.bridge.resumeSession({ path: "/s/a.jsonl", cwd: "/p", title: "A" });
  await flush();
  h.messages(id, CONTEXT);
  h.emit(id, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
  void h.bridge.loadOlderHistory();
  h.history[0].resolve({ items: ITEMS, more: false });
  await flush();
  h.emit(id, { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "out" }] }, isError: false });
  const msgs = h.bridge.getState().messages;
  assert.deepEqual(msgs.map(m => m.kind), ["user", "assistant", "compact", "user", "assistant", "tool"]);
  assert.notEqual(msgs[5].status, "running");
  assert.deepEqual(plain(msgs[2]), {
    kind: "compact", status: "done", shortSummary: "short", summary: "the summary", tokensBefore: 12000, fromHistory: true, _id: msgs[2]._id,
  }, "the entry now at the card's old index (the divider) is untouched");
});

await check("bridge: paging survives a later get_messages; the setting auto-loads once", async () => {
  const h = harness();
  h.bridge.setSessionPrefs({ showCompactedHistory: true });
  const id = await h.bridge.resumeSession({ path: "/s/a.jsonl", cwd: "/p", title: "A" });
  await flush();
  h.messages(id, CONTEXT);
  assert.equal(h.history.length, 1, "auto-load");
  h.history[0].resolve({ items: ITEMS, more: true });
  await flush();
  assert.equal(h.snapshot().olderHistory.available, true);
  // A tab switch's get_messages: the oldest shown message is loaded history.
  h.messages(id, CONTEXT);
  assert.equal(h.snapshot().olderHistory.available, true, "more history stays loadable");
  assert.equal(h.history.length, 1, "no second auto-load");
  void h.bridge.loadOlderHistory();
  assert.equal(h.history[1].args.before, 10);
});

await check("bridge: a trim clears available (the cap cut the head on purpose)", async () => {
  const h = harness();
  const id = await h.bridge.resumeSession({ path: "/s/a.jsonl", cwd: "/p", title: "A" });
  await flush();
  const many = Array.from({ length: 170 }, (_, i) => userMsg(`q${i}`, 100 + i));
  h.messages(id, [summaryMsg(50), ...many]);
  assert.equal(h.bridge.getState().trimmed, true);
  assert.equal(h.snapshot().olderHistory.available, false);
});

await check("bridge: a second compaction keeps the row offered (the oldest shown entry has no copy in the new context)", async () => {
  const h = harness();
  const id = await h.bridge.resumeSession({ path: "/s/a.jsonl", cwd: "/p", title: "A" });
  await flush();
  h.messages(id, CONTEXT);
  assert.equal(h.snapshot().olderHistory.available, true);
  // omp compacts again; the next get_messages carries the new context only.
  h.messages(id, [summaryMsg(300), userMsg("new", 400), replyMsg("new reply", 410)]);
  assert.deepEqual(h.bridge.getState().messages.map(m => m.ts), [100, 110, 400, 410]);
  assert.equal(h.snapshot().olderHistory.available, true, "nothing older was loaded: still on offer");
});

await check("bridge: a tab open before its first compaction is not offered history by it", async () => {
  const h = harness();
  const id = await h.bridge.resumeSession({ path: "/s/a.jsonl", cwd: "/p", title: "A" });
  await flush();
  h.messages(id, [userMsg("early", 10), replyMsg("early reply", 20)]);
  assert.equal(h.snapshot().olderHistory.available, false);
  h.messages(id, [summaryMsg(50), userMsg("kept", 100), replyMsg("kept reply", 110)]);
  assert.equal(h.snapshot().olderHistory.available, false, "the early entries are on screen already");
});

await check("bridge: a failure at the page's end is not shown when the oldest shown message is an assistant reply", async () => {
  const h = harness();
  const id = await h.bridge.resumeSession({ path: "/s/a.jsonl", cwd: "/p", title: "A" });
  await flush();
  h.messages(id, [summaryMsg(50), replyMsg("continued", 100)]);
  void h.bridge.loadOlderHistory();
  h.history[0].resolve({ items: [userMsg("u", 10), errorMsg(20), summaryMsg(25)], more: false });
  await flush();
  const msgs = h.bridge.getState().messages;
  assert.deepEqual(msgs.map(m => m.kind), ["user", "compact", "assistant"]);
  assert.ok(!msgs.some(m => m.failure));
});

await check("bridge: the same failure is shown when the oldest shown message is a prompt", async () => {
  const h = harness();
  const id = await h.bridge.resumeSession({ path: "/s/a.jsonl", cwd: "/p", title: "A" });
  await flush();
  h.messages(id, [summaryMsg(50), userMsg("again", 100), replyMsg("ok", 110)]);
  void h.bridge.loadOlderHistory();
  h.history[0].resolve({ items: [userMsg("u", 10), errorMsg(20), summaryMsg(25)], more: false });
  await flush();
  const msgs = h.bridge.getState().messages;
  assert.deepEqual(msgs.map(m => m.kind), ["user", "assistant", "compact", "user", "assistant"]);
  assert.equal(msgs[1].failure?.raw, "context overflow");
});

await check("bridge: a page the cap leaves only a divider room for adds nothing and ends the offer", async () => {
  const h = harness();
  const id = await h.bridge.resumeSession({ path: "/s/a.jsonl", cwd: "/p", title: "A" });
  await flush();
  const many = Array.from({ length: 168 }, (_, i) => userMsg(`q${i}`, 100 + i));
  h.messages(id, [summaryMsg(50), ...many]);
  assert.equal(h.snapshot().olderHistory.available, true);
  void h.bridge.loadOlderHistory();
  assert.equal(h.history[0].args.limit, 1);
  h.history[0].resolve({ items: [userMsg("old", 10), summaryMsg(25)], more: true });
  await flush();
  const msgs = h.bridge.getState().messages;
  assert.equal(msgs.length, 168, "the divider alone was not prepended");
  assert.ok(!msgs.some(m => m.kind === "compact"));
  assert.deepEqual(plain(h.snapshot().olderHistory), { available: false, loading: false, error: null });
});

await check("bridge: a page with more before it never starts on a divider", async () => {
  const h = harness();
  const id = await h.bridge.resumeSession({ path: "/s/a.jsonl", cwd: "/p", title: "A" });
  await flush();
  h.messages(id, CONTEXT);
  void h.bridge.loadOlderHistory();
  h.history[0].resolve({ items: [errorMsg(20), summaryMsg(25), replyMsg("c", 30)], more: true });
  await flush();
  assert.deepEqual(h.bridge.getState().messages.map(m => m.kind), ["assistant", "user", "assistant"]);
  assert.equal(h.snapshot().olderHistory.available, true);
});

console.log(`test-older-history: ${passed} checks passed`);
