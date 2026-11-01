#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = (path) =>
  readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

function harness(t, { title, autoName = true, isStreaming = false } = {}) {
  const window = { OMP_TWEAKS_STORE: { read: () => ({ autoName }) } };
  const timers = new Set();
  const scope = {
    window,
    atob,
    Uint8Array,
    TextDecoder,
    TextEncoder,
    console: { log() {}, warn() {}, error() {} },
    setTimeout(fn, delay) {
      const timer = setTimeout(fn, delay);
      timer.unref();
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      clearTimeout(timer);
      timers.delete(timer);
    },
  };
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
  });
  for (const file of [
    "app/constants.js",
    "app/slash-commands.js",
    "app/subagents.js",
    "app/background-tasks.js",
    "app/agent-context.js",
    "app/agent-context-sync.js",
    "app/session-title.js",
    "app/session-prefs.js",
    "app/message-queue.js",
    "app/ask-dialog.js",
    "app/approval.js",
    "app/approval-mode.js",
    "app/turn-status.js",
    "app/goal.js",
    "app/extension-widgets.js",
    "app/live-voice.js",
    "app/live-context.js",
    "app/transcript-merge.js",
    "app/prompt-history.js",
    "app/project-nav.js",
    "adapter.js",
    "live.js",
  ])
    runInNewContext(source(file), scope, { filename: file });
  const bridge = window.OMP_BRIDGE;
  const listeners = new Map(),
    commands = [],
    states = new Map();
  let snapshot,
    seq = 0,
    rejectRename = false;
  bridge.onUpdate((value) => {
    snapshot = value;
  });
  const emit = (frame, id = bridge.activeSessionId) =>
    listeners.get(`agent://line/${id}`)?.({
      payload: { seq: ++seq, text: JSON.stringify(frame) },
    });
  const reply = (id, command, data) =>
    emit(
      {
        type: "response",
        command: command.type,
        id: command.id,
        success: true,
        data,
      },
      id,
    );
  window.__TAURI__ = {
    event: {
      async listen(name, callback) {
        listeners.set(name, callback);
        return () => listeners.delete(name);
      },
    },
    core: {
      async invoke(name, args) {
        if (name === "start_session") {
          const id = args.args.sessionId;
          states.set(id, {
            sessionId: id,
            sessionFile: args.args.resume || `/saved/${id}.jsonl`,
            sessionName: title,
            messageCount: 2,
            isStreaming,
            isSettled: !isStreaming,
          });
          return {
            approvalMode: "write",
            path: args.args.cwd,
            workspace: null,
          };
        }
        if (name === "replay_events") return { dropped: false, events: [] };
        if (name === "start_git_watch") return "feature";
        if (name === "send_command") {
          const command = JSON.parse(args.json),
            id = args.sessionId;
          commands.push({ ...command, sessionId: id });
          if (
            command.type === "prompt" &&
            command.message === "/rename" &&
            rejectRename
          )
            throw new Error("Broken rename pipe");
          queueMicrotask(() => {
            if (command.type === "get_state")
              reply(id, command, states.get(id));
            else if (command.type === "get_messages")
              reply(id, command, { messages: [] });
            else if (command.type === "get_entries")
              reply(id, command, { entries: [], leafId: null });
            else if (command.id) reply(id, command, {});
          });
        }
        return null;
      },
    },
  };
  return {
    bridge,
    emit,
    get snapshot() {
      return snapshot;
    },
    renames() {
      return commands.filter(
        (c) => c.type === "prompt" && c.message === "/rename",
      );
    },
    rejectRename(value) {
      rejectRename = value;
    },
    setStreaming(value) {
      Object.assign(states.get(bridge.activeSessionId), {
        isStreaming: value,
        isSettled: !value,
      });
    },
    async reopen() {
      await bridge.resumeSession({
        path: "/saved/conversation.jsonl",
        profile_id: "default",
        cwd: "/project",
        title: title || "project",
      });
      await flush();
    },
    async poll() {
      emit({ type: "config_update" });
      await flush();
    },
    async turn(stopReason = "stop", isTerminal = true) {
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          timestamp: ++seq,
          content: [{ type: "text", text: "Updated the implementation." }],
          stopReason,
        },
      });
      emit({ type: "agent_end", messages: [], isTerminal });
      await flush();
    },
    async outcome(text) {
      emit({ type: "command_output", text });
      await flush();
    },
    async named(name) {
      states.get(bridge.activeSessionId).sessionName = name;
      emit({ type: "session_info_update", title: name });
      await this.outcome(`Session renamed to ${name}.`);
    },
  };
}

test("the first title lands when the turn-end snapshot stays busy until session settlement", async (t) => {
  const h = harness(t, { isStreaming: true });
  await h.reopen();
  await h.turn();
  assert.equal(
    h.renames().length,
    0,
    "a busy turn-end snapshot must not start naming",
  );
  h.setStreaming(false);
  h.emit({ type: "session_settled" });
  await flush();
  assert.equal(
    h.renames().length,
    1,
    "settlement must recheck the first completed exchange",
  );
  await h.named("Explain binary search");
  assert.equal(h.snapshot.sessions[0].name, "Explain binary search");
});

test("reopening an unnamed completed conversation generates its title", async (t) => {
  const h = harness(t);
  await h.reopen();
  assert.equal(h.renames().length, 1);
  await h.named("Fix worktree navigation");
  assert.equal(h.snapshot.sessions[0].name, "Fix worktree navigation");
  assert.equal(
    h.bridge
      .getState()
      .messages.some((m) => JSON.stringify(m).includes("Session renamed to")),
    false,
  );
});

test("an unsuccessful first title retries on later completed turns, not state polls", async (t) => {
  const h = harness(t);
  await h.reopen();
  for (let attempt = 1; attempt <= 4; attempt++) {
    assert.equal(h.renames().length, attempt);
    await h.outcome(
      "Could not generate a session title. Use /rename <title> to set one.",
    );
    for (let i = 0; i < 3; i++) await h.poll();
    assert.equal(
      h.renames().length,
      attempt,
      "polling must not retry a refused title",
    );
    await h.turn();
  }
  await h.named("Repair project navigation");
  assert.equal(h.snapshot.sessions[0].name, "Repair project navigation");
});

test("failed exchanges and scheduling pauses do not unlock another title attempt", async (t) => {
  const h = harness(t);
  await h.reopen();
  await h.outcome("Rename failed: provider temporarily unavailable");
  await h.turn("error");
  await h.turn("stop", false);
  await h.poll();
  assert.equal(h.renames().length, 1);
  await h.turn();
  assert.equal(h.renames().length, 2);
});

test("a saved manual title, even the project name, is never regenerated", async (t) => {
  const h = harness(t, { title: "project" });
  await h.reopen();
  for (let i = 0; i < 16; i++) await h.turn();
  assert.equal(h.renames().length, 0);
  assert.equal(h.snapshot.sessions[0].name, "project");
});

test("auto-naming off leaves an unnamed resume alone until enabled", async (t) => {
  const h = harness(t, { autoName: false });
  await h.reopen();
  await h.turn();
  assert.equal(h.renames().length, 0);
  h.bridge.setSessionPrefs({ autoName: true });
  await h.poll();
  assert.equal(h.renames().length, 1);
});

test("a slow title stays single-flight and its eventual outcome stays out of chat", async (t) => {
  const h = harness(t);
  await h.reopen();
  for (let i = 0; i < 12; i++) await h.turn();
  assert.equal(h.renames().length, 1);
  await h.named("Fix delayed naming");
  await h.poll();
  assert.equal(h.renames().length, 1);
  assert.equal(h.snapshot.sessions[0].name, "Fix delayed naming");
  assert.equal(
    h.bridge
      .getState()
      .messages.some((m) => JSON.stringify(m).includes("Session renamed to")),
    false,
  );
});

test("a failed IPC hand-off does not wedge later initial title attempts", async (t) => {
  const h = harness(t);
  h.rejectRename(true);
  await h.reopen();
  await h.poll();
  assert.equal(h.renames().length, 1);
  h.rejectRename(false);
  await h.turn();
  assert.equal(h.renames().length, 2);
  await h.named("Recover title delivery");
  assert.equal(h.snapshot.sessions[0].name, "Recover title delivery");
});

test("a manual rename during an automatic attempt permanently wins", async (t) => {
  const h = harness(t);
  await h.reopen();
  await h.bridge.renameSession(h.bridge.activeSessionId, "My chosen title");
  await h.named("My chosen title");
  for (let i = 0; i < 16; i++) await h.turn();
  assert.equal(h.renames().length, 1);
  assert.equal(h.snapshot.sessions[0].name, "My chosen title");
});

test("successful automatic titles retain their bounded five-turn refinement cadence", async (t) => {
  const h = harness(t);
  await h.reopen();
  await h.named("Initial title");
  for (const name of ["Refined title", "Final title"]) {
    const before = h.renames().length;
    for (let i = 0; i < 4; i++) await h.turn();
    assert.equal(h.renames().length, before);
    await h.turn();
    assert.equal(h.renames().length, before + 1);
    await h.named(name);
  }
  for (let i = 0; i < 10; i++) await h.turn();
  assert.equal(h.renames().length, 3);
  assert.equal(h.snapshot.sessions[0].name, "Final title");
});
