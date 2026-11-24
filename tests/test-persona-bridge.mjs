#!/usr/bin/env node
// Regression script for live.js's Ompy transport (src/live.js, the persona
// relay): activation and attach cursor, relayed frames, the generation reset,
// close refusal, the open-tabs layout, `_sendToAll` and ask answers over
// `persona_send`. Run: node tests/test-persona-bridge.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = (path) => readFileSync(join(root, "src", path), "utf8");
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

let passed = 0;
async function check(label, fn) {
  try {
    await fn();
  } catch (error) {
    console.error(`FAILED: ${label}`);
    throw error;
  }
  passed++;
}

const STATUS = (generation) => ({
  generation,
  state: "running",
  error: null,
  nextWakeMs: null,
  tokensToday: 0,
  dailyTokenLimit: 1000,
  openItems: 0,
  settings: {
    intervalMin: 30,
    quietStart: "20:00",
    quietEnd: "07:00",
    quietWeekends: true,
    dailyTokenLimit: 1000,
  },
});

function bridgeHarness({ generation = 1 } = {}) {
  const listeners = new Map();
  const invocations = [];
  const sent = []; // persona_send frames
  const commands = []; // send_command frames
  const layouts = [];
  let status = STATUS(generation);
  let emitPersona = () => {};
  let autoReply = true;
  let replySeq = 100;

  const w = {
    OMP_LIVE_VOICE: null,
    OMP_SLASH: {
      LOCAL_COMMANDS: [],
      adaptAvailableCommands: () => [],
      mergeSlashCommands: (local) => local,
      isCommandInvocation: () => false,
      queuedFrame: (text) => ({ type: "prompt", message: text }),
    },
    OMP_SUBAGENTS: {
      emptySubagents: () => ({}),
      subscriptionLevelFor: () => "progress",
      mergeSnapshots: () => ({}),
    },
    OMP_SESSION_TITLE: {},
    OMP_SESSION_PREFS: {
      fromTweaks: (values) => ({
        autoCompaction: values.autoCompaction !== false,
        autoRetry: values.autoRetry !== false,
      }),
      changedKeys: (prev, next) => Object.keys(next).filter((key) => prev[key] !== next[key]),
      closeGuardArmed: () => false,
      tabCloseConfirm: () => false,
      quitConfirm: () => false,
    },
    OMP_QUEUE: { EMPTY_QUEUE: {} },
    OMP_ASK_DIALOG: { parseQuestions: () => null },
    OMP_APPROVAL: {},
    OMP_TURN_STATUS: {
      runStateOf: () => "idle",
      isBusyRunState: () => false,
      retryCleared: (messages) => messages,
    },
    OMP_GOAL: { UNKNOWN: {} },
    OMP_EXT_WIDGETS: { EMPTY: {} },
    OMP_STREAM_DELTA: {},
    OMP_TWEAKS_STORE: { read: () => ({}) },
    DEFAULT_PROFILE_ID: "default",
    TWEAK_DEFAULTS: {},
    INTENT_FRAMING: () => "",
    timeNow: () => "00:00",
    OMP_PROMPT_HISTORY: { DEFAULT_LIMIT: 100, clampLimit: (n) => n, trimAll: () => false },
  };
  for (const file of [
    "app/project-nav.js",
    "app/transcript-merge.js",
    "adapter.js",
    "app/persona.js",
    "app/approval-mode.js",
    "app/live-voice.js",
  ]) {
    new Function("window", source(file))(w);
  }
  const timeout = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return timer;
  };

  w.__TAURI__ = {
    core: {
      async invoke(command, args) {
        invocations.push({ command, args });
        if (command === "list_profiles") {
          return { profiles: [{ id: "default", name: "default" }], startupId: "default" };
        }
        if (command === "start_session") return "write";
        if (command === "start_git_watch") return { branch: "main", root: args.cwd };
        if (command === "replay_events") return { dropped: false, events: [] };
        if (command === "persona_status") return status;
        if (command === "persona_inbox") return [];
        if (command === "persona_error") return { connection: null, refresh: null };
        if (command === "persona_attach") return null;
        if (command === "persona_send") {
          const frame = JSON.parse(args.json);
          sent.push(frame);
          // Answer the two awaited opening commands, so the rest of the
          // fetch batch follows instead of waiting for a timeout.
          if (autoReply && frame.id && ["negotiate_protocol", "set_ask_dialog"].includes(frame.type)) {
            const id = frame.id;
            const type = frame.type;
            queueMicrotask(() =>
              emitPersona(replySeq++, {
                type: "response",
                command: type,
                id,
                success: true,
                data: {},
              }),
            );
          }
          return null;
        }
        if (command === "open_tabs_save") {
          layouts.push(args.layout);
          return null;
        }
        if (command === "send_command") {
          commands.push({ ...JSON.parse(args.json), sessionId: args.sessionId });
          return null;
        }
        return null;
      },
    },
    event: {
      async listen(name, callback) {
        listeners.set(name, callback);
        return () => {
          if (listeners.get(name) === callback) listeners.delete(name);
        };
      },
    },
    window: {
      getCurrentWindow: () => ({
        startDragging() {},
        minimize() {},
        maximize() {},
        unmaximize() {},
        isMaximized: async () => false,
      }),
    },
  };

  // live.js's boot block runs because __TAURI__ is present: the DOM stubs
  // exist only for the window chrome and the native class it sets.
  globalThis.document = {
    documentElement: { classList: { add() {} } },
    readyState: "complete",
    addEventListener() {},
    querySelector: () => null,
  };
  if (!globalThis.navigator) {
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: "", platform: "" },
      configurable: true,
    });
  }

  // eslint-disable-next-line no-new-func
  new Function("window", "setTimeout", "clearTimeout", source("live.js"))(
    w,
    timeout,
    clearTimeout,
  );

  let snapshot = null;
  const bridge = w.OMP_BRIDGE;
  bridge.onUpdate((value) => {
    snapshot = value;
  });

  const personaLine = (seq, frame) =>
    listeners.get("persona://line/ompy")?.({ payload: { seq, text: JSON.stringify(frame) } });
  emitPersona = personaLine;
  // A spawned project tab's stdout, same envelope shape minus the journal
  // cursor (handleLine dispatches unnumbered envelopes).
  const sessionLine = (id, frame) =>
    listeners.get(`agent://line/${id}`)?.({ payload: { text: JSON.stringify(frame) } });
  const personaStatus = (next) => {
    // A new generation: stop answering the opening commands, so the reset
    // cursor stays at 0 and a low sequence number proves it.
    autoReply = false;
    status = next;
    listeners.get("persona://status")?.({ payload: next });
  };
  return {
    bridge,
    invocations,
    sent,
    commands,
    layouts,
    personaLine,
    personaStatus,
    sessionLine,
    snapshot: () => snapshot,
    count: (command) => invocations.filter((call) => call.command === command).length,
    attachCalls: () =>
      invocations.filter((call) => call.command === "persona_attach").map((call) => call.args),
    closeCalls: () => invocations.filter((call) => call.command === "close_tab"),
  };
}

await check("activating Ompy attaches the relay with the cursor and sends the opening fetch through persona_send", async () => {
  const h = bridgeHarness();
  await flush();
  assert.equal(h.attachCalls().length, 0, "no attach before Ompy is shown");
  await h.bridge.activateSession("ompy");
  assert.deepEqual(h.attachCalls(), [{ afterSeq: 0 }]);
  await flush();
  const types = h.sent.map((frame) => frame.type);
  for (const type of ["negotiate_protocol", "set_ask_dialog", "get_state", "get_messages"]) {
    assert.ok(types.includes(type), `the opening fetch is missing ${type}: ${types}`);
  }
  // Nothing was sent to a spawned omp process: Ompy's frames go to the
  // service.
  assert.equal(h.commands.length, 0);
});

await check("relayed frames reach the transcript and an ask answer goes back through persona_send", async () => {
  const h = bridgeHarness();
  await flush();
  await h.bridge.activateSession("ompy");
  await flush();
  h.personaLine(500, {
    type: "extension_ui_request",
    id: "ask-1",
    method: "input",
    title: "Authorization code",
    placeholder: "paste the code",
  });
  const bubble = h.snapshot().messages.find((message) => message.id === "ask-1" && message.kind === "ask");
  assert.ok(bubble, "the relayed ask bubble did not appear in the transcript");
  assert.equal(bubble.kind, "ask");
  const before = h.sent.length;
  await h.bridge.answerAsk("ask-1", "123456");
  await flush();
  const answer = h.sent.slice(before).find((frame) => frame.type === "extension_ui_response");
  assert.deepEqual(answer, { type: "extension_ui_response", id: "ask-1", value: "123456" });
  assert.equal(h.commands.length, 0, "the answer did not go through persona_send");
});

await check("a secret answer reaches omp but only a masked placeholder stays in message state", async () => {
  const h = bridgeHarness();
  await flush();
  await h.bridge.activateSession("ompy");
  await flush();
  h.personaLine(500, {
    type: "extension_ui_request",
    id: "secret-1",
    method: "input",
    title: "Password",
    secret: true,
  });
  const bubble = h.snapshot().messages.find((message) => message.id === "secret-1");
  assert.equal(bubble.secret, true, "the input lost its password semantics");
  await h.bridge.answerAsk("secret-1", "plaintext-password");
  await flush();
  const answer = h.sent.find((frame) => frame.type === "extension_ui_response" && frame.id === "secret-1");
  assert.equal(answer.value, "plaintext-password", "omp must still receive the answer");
  const state = JSON.stringify(h.snapshot().messages);
  assert.equal(state.includes("plaintext-password"), false, "message state retained the secret");
  assert.equal(h.snapshot().messages.find((message) => message.id === "secret-1").answer, "••••••••");
});

await check("a new service generation resets the cursor, re-attaches from 0 and re-sends the opening fetch", async () => {
  const h = bridgeHarness();
  await flush();
  await h.bridge.activateSession("ompy");
  await flush();
  h.personaLine(500, {
    type: "extension_ui_request",
    id: "ask-7",
    method: "input",
    title: "Old generation",
    placeholder: "x",
  });
  assert.ok(h.snapshot().messages.some((message) => message.id === "ask-7" && message.kind === "ask"));
  const sentBefore = h.sent.length;

  h.personaStatus(STATUS(2));
  await flush();
  assert.deepEqual(
    h.attachCalls(),
    [{ afterSeq: 0 }, { afterSeq: 0 }],
    "the new generation did not re-attach from 0",
  );
  assert.equal(h.count("persona_attach"), 2);
  const resent = h.sent.slice(sentBefore).map((frame) => frame.type);
  assert.ok(resent.includes("negotiate_protocol"), `the new generation did not fetch: ${resent}`);
  assert.equal(
    h.snapshot().messages.some((message) => message.id === "ask-7" && message.kind === "ask"),
    false,
    "the previous generation's transcript survived",
  );
  // Sequence numbers start over: a seq-1 frame of the new generation is
  // accepted instead of dropped as a duplicate of the old cursor.
  h.personaLine(1, {
    type: "extension_ui_request",
    id: "ask-8",
    method: "input",
    title: "New generation",
    placeholder: "y",
  });
  assert.ok(h.snapshot().messages.some((message) => message.id === "ask-8" && message.kind === "ask"));
});

await check("Ompy is not a tab: close is refused, the layout omits it and _sendToAll skips it", async () => {
  const h = bridgeHarness();
  await flush();
  const project = await h.bridge.openSession("/project");
  await h.bridge.activateSession("ompy");
  await flush();
  assert.deepEqual(h.closeCalls(), []);
  assert.equal(await h.bridge.closeSession("ompy"), false, "closing Ompy was allowed");
  assert.deepEqual(h.closeCalls(), []);
  assert.ok(h.snapshot().sessions.some((entry) => entry.id === "ompy"), "Ompy is listed");

  // Any layout write carries project tabs only.
  await h.bridge.activateSession(project);
  await h.bridge.activateSession("ompy");
  await flush();
  const saved = JSON.stringify(h.layouts);
  assert.ok(saved.includes("/project"), `the project tab is missing from the layout: ${saved}`);
  assert.equal(saved.includes("ompy"), false, `Ompy reached open-tabs.json: ${saved}`);

  // Settings shared by every tab skip Ompy: it has no process of this app's.
  await h.bridge.setSessionPrefs({ autoCompaction: false });
  const compaction = h.commands.filter((command) => command.type === "set_auto_compaction");
  assert.deepEqual(compaction.map((command) => command.sessionId), [project]);
  assert.equal(
    h.commands.some((command) => command.sessionId === "ompy"),
    false,
    "_sendToAll sent a command to Ompy",
  );
});

await check("a replacement request reusing an id closes the earlier Ompy bubble so only the new one answers", async () => {
  const h = bridgeHarness();
  await flush();
  await h.bridge.activateSession("ompy");
  await flush();
  h.personaLine(500, { type: "extension_ui_request", id: "reuse-1", method: "input", title: "Authorization code", placeholder: "first" });
  assert.equal(h.snapshot().messages.filter((message) => message.id === "reuse-1").length, 1);
  h.personaLine(501, { type: "extension_ui_request", id: "reuse-1", method: "input", title: "Authorization code", placeholder: "second" });
  const bubbles = h.snapshot().messages.filter((message) => message.id === "reuse-1");
  assert.equal(bubbles.length, 2, "the replacement arrived as its own bubble");
  assert.equal(bubbles[0].cancelled, true, "the earlier bubble is closed");
  assert.equal(bubbles[0].superseded, true, "the earlier bubble says why it closed");
  assert.equal(bubbles[1].cancelled, false, "the replacement stays answerable");
  assert.equal(bubbles[1].placeholder, "second");
  const sentBefore = h.sent.length;
  await h.bridge.answerAsk("reuse-1", "123456");
  await flush();
  const answers = h.sent.slice(sentBefore).filter((frame) => frame.type === "extension_ui_response");
  assert.deepEqual(answers.map((frame) => frame.value), ["123456"], "exactly one answer went to omp");
  const settled = h.snapshot().messages.filter((message) => message.id === "reuse-1");
  assert.equal(settled[0].answer, null, "the superseded bubble kept no answer");
  assert.equal(settled[1].answer, "123456");
});

await check("a re-sent select under the same id replaces the buffered prompt instead of shadowing it", async () => {
  const h = bridgeHarness();
  await flush();
  await h.bridge.activateSession("ompy");
  await flush();
  h.personaLine(500, { type: "extension_ui_request", id: "sel-1", method: "select", title: "Allow tool: bash", options: ["Approve", "Deny"] });
  h.personaLine(501, { type: "extension_ui_request", id: "sel-1", method: "select", title: "Allow tool: read", options: ["Approve", "Deny"] });
  assert.equal(h.snapshot().messages.filter((message) => message.id === "sel-1").length, 0, "both are buffered");
  h.personaLine(502, { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: {} });
  const bubbles = h.snapshot().messages.filter((message) => message.id === "sel-1");
  assert.equal(bubbles.length, 1, "the replaced buffered prompt never surfaced");
  assert.equal(bubbles[0].title, "Allow tool: read");
  assert.equal(bubbles[0].cancelled, false);
});

await check("a project tab closes the earlier ask when a request id is reused", async () => {
  const h = bridgeHarness();
  await flush();
  const id = await h.bridge.openSession("/project");
  await h.bridge.activateSession(id);
  await flush();
  h.sessionLine(id, { type: "extension_ui_request", id: "tab-1", method: "confirm", title: "Overwrite file?", message: "first" });
  assert.equal(h.snapshot().messages.filter((message) => message.kind === "ask" && message.id === "tab-1").length, 1);
  h.sessionLine(id, { type: "extension_ui_request", id: "tab-1", method: "confirm", title: "Overwrite file?", message: "second" });
  const bubbles = h.snapshot().messages.filter((message) => message.kind === "ask" && message.id === "tab-1");
  assert.equal(bubbles.length, 2, "the replacement arrived as its own bubble");
  assert.deepEqual(bubbles.map((message) => !!message.cancelled), [true, false]);
  assert.equal(bubbles[0].superseded, true);
  const before = h.commands.length;
  await h.bridge.answerConfirm("tab-1", true);
  await flush();
  const replies = h.commands.slice(before).filter((command) => command.type === "extension_ui_response");
  assert.deepEqual(replies.map((command) => [command.id, command.confirmed]), [["tab-1", true]]);
  const settled = h.snapshot().messages.filter((message) => message.kind === "ask" && message.id === "tab-1");
  assert.deepEqual(settled.map((message) => !!message.answered), [false, true]);
});

console.log(`test-persona-bridge: ${passed} checks passed`);
