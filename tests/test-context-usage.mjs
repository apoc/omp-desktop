#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const w = {};
new Function(
  "window",
  readFileSync(new URL("../src/adapter.js", import.meta.url), "utf8"),
)(w);

test("context capacity follows the active model without fabricating usage or a default window", () => {
  const unknown = w.buildCtx(null, null, 0);
  assert.equal(unknown.total, null);
  assert.equal(unknown.used, null);
  assert.equal(unknown.pct, null);
  const switching = w.buildCtx(
    {
      model: { provider: "local", id: "large", contextWindow: 1000000 },
      contextRefreshing: true,
    },
    2,
    10,
  );
  assert.equal(switching.total, 1000000);
  assert.equal(switching.used, null);
  assert.equal(switching.status, "refreshing");
  assert.equal(switching.modelKey, "local/large");
  const fresh = w.buildCtx(
    {
      model: { provider: "local", id: "large" },
      contextUsage: { tokens: 50000, contextWindow: 1000000, percent: 25 },
    },
    2,
    10,
  );
  assert.equal(
    fresh.pct,
    5,
    "recompute percent from the current usage and capacity, not an old percent",
  );
  assert.equal(fresh.status, "ready");
});

const source = (path) =>
  readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const small = { provider: "local", id: "small", contextWindow: 200000 };
const large = { provider: "local", id: "large", contextWindow: 1000000 };
const rpc = (model = small, tokens = 50000) => ({
  sessionId: "saved",
  sessionFile: "/saved/conversation.jsonl",
  isStreaming: false,
  model,
  contextUsage: {
    tokens,
    contextWindow: model.contextWindow,
    percent: (tokens / model.contextWindow) * 100,
  },
});

function harness() {
  const listeners = new Map(),
    commands = [];
  const window = {
    OMP_SUBAGENTS: {
      emptySubagents: () => ({}),
      subscriptionLevelFor: () => "progress",
    },
    OMP_EXT_WIDGETS: { EMPTY: {} },
    OMP_SESSION_PREFS: {
      fromTweaks: () => ({ autoCompaction: true, autoRetry: true }),
      closeGuardArmed: () => false,
    },
    OMP_TWEAKS_STORE: { read: () => ({}) },
    OMP_APPROVAL_MODE: { isMode: () => true },
    DEFAULT_PROFILE_ID: "default",
    INTENT_FRAMING: () => "",
    timeNow: () => "00:00",
    localStorage: { getItem: () => null, setItem() {} },
  };
  for (const path of [
    "app/slash-commands.js",
    "app/message-queue.js",
    "app/goal.js",
    "app/prompt-history.js",
    "app/session-title.js",
    "app/turn-status.js",
    "app/transcript-merge.js",
    "app/project-nav.js",
    "app/live-voice.js",
    "app/live-context.js",
    "app/ask-dialog.js",
    "app/ask-recovery.js",
    "app/agent-context.js",
    "app/agent-context-sync.js",
    "adapter.js",
  ])
    new Function("window", source(path))(window);
  new Function("window", "setTimeout", "clearTimeout", source("live.js"))(
    window,
    (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      return timer;
    },
    clearTimeout,
  );
  let seq = 0;
  const emit = (frame) =>
    listeners.get(
      [...listeners.keys()].find((name) => name.startsWith("agent://line/")),
    )?.({ payload: { seq: ++seq, text: JSON.stringify(frame) } });
  const reply = async (command, data, success = true) => {
    emit({
      type: "response",
      command: command.type,
      id: command.id,
      data,
      success,
      ...(!success ? { error: "Unavailable" } : {}),
    });
    await flush();
  };
  window.__TAURI__ = {
    core: {
      async invoke(name, args) {
        if (name === "start_session")
          return {
            approvalMode: "write",
            path: args.args.cwd,
            workspace: null,
          };
        if (name === "replay_events") return { dropped: false, events: [] };
        if (name === "start_git_watch") return "feature";
        if (name === "send_command") {
          const command = JSON.parse(args.json);
          commands.push(command);
          queueMicrotask(() => {
            if (["negotiate_protocol", "set_ask_dialog"].includes(command.type))
              void reply(command, {});
            else if (command.type === "get_entries")
              void reply(command, { entries: [], leafId: null });
            else if (command.type === "get_messages")
              void reply(command, { messages: [] });
          });
        }
        return null;
      },
    },
    event: {
      async listen(name, fn) {
        listeners.set(name, fn);
        return () => listeners.delete(name);
      },
    },
  };
  return {
    bridge: window.OMP_BRIDGE,
    commands,
    emit,
    reply,
    latest: (type) => commands.findLast((command) => command.type === type),
    async open() {
      await window.OMP_BRIDGE.resumeSession({
        path: "/saved/conversation.jsonl",
        cwd: "/project",
        title: "Saved",
      });
      await flush();
      await reply(
        commands.findLast((command) => command.type === "get_state"),
        rpc(),
      );
    },
  };
}

test("manual compaction replaces usage without needing another agent turn", async () => {
  const h = harness();
  await h.open();
  assert.equal(h.bridge.getState().ctx.used, 50000);
  h.bridge.compact();
  await flush();
  assert.equal(
    h.bridge.getState().ctx.used,
    null,
    "pending compaction must not advertise old usage",
  );
  await h.reply(h.latest("compact"), { summary: "Short summary" });
  await h.reply(h.latest("get_state"), rpc(small, 10000));
  assert.equal(h.bridge.getState().ctx.used, 10000);
  assert.equal(h.bridge.getState().ctx.pct, 5);
});

test("automatic compaction rejects a delayed pre-compaction state response", async () => {
  const h = harness();
  await h.open();
  h.emit({ type: "config_update" });
  await flush();
  const before = h.latest("get_state");
  h.emit({
    type: "auto_compaction_start",
    action: "context-full",
    reason: "threshold",
  });
  await flush();
  assert.equal(h.bridge.getState().ctx.status, "refreshing");
  h.emit({
    type: "auto_compaction_end",
    action: "context-full",
    aborted: false,
    willRetry: false,
  });
  await flush();
  await h.reply(h.latest("get_state"), rpc(small, 8000));
  await h.reply(before, rpc(small, 190000));
  assert.equal(h.bridge.getState().ctx.used, 8000);
});

test("model changes replace capacity immediately and ignore old-model responses", async () => {
  const h = harness();
  await h.open();
  h.emit({ type: "turn_end" });
  await flush();
  const before = h.latest("get_state");
  h.bridge.setModel(large);
  await flush();
  await h.reply(h.latest("set_model"), large);
  const pending = h.bridge.getState().ctx;
  assert.equal(pending.total, 1000000);
  assert.equal(pending.used, null);
  await h.reply(h.latest("get_state"), rpc(large, 50000));
  await h.reply(before, rpc(small, 50000));
  assert.equal(h.bridge.getState().ctx.total, 1000000);
  assert.equal(h.bridge.getState().ctx.pct, 5);
  h.emit({ type: "model_changed" });
  await flush();
  await h.reply(h.latest("get_state"), rpc(small, 50000));
  assert.equal(h.bridge.getState().ctx.total, 200000);
  assert.equal(h.bridge.getState().ctx.pct, 25);
});

test("correlated context refresh preserves later queue frames in the same replay batch", async () => {
  const h = harness();
  await h.open();
  h.emit({ type: "turn_end" });
  await flush();
  const command = h.latest("get_state");
  h.emit({
    type: "response",
    command: "get_state",
    id: command.id,
    success: true,
    data: { ...rpc(), queuedMessages: { steering: [], followUp: [] } },
  });
  h.emit({
    type: "queue_update",
    steering: ["Keep the next change small"],
    followUp: [],
  });
  await flush();
  assert.deepEqual(h.bridge.getState().queue.steering, [
    "Keep the next change small",
  ]);
});
