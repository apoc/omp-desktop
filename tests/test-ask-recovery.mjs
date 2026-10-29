#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) =>
  readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const questions = [
  {
    id: "direction",
    question: "Which approach?",
    options: [{ label: "Small change" }, { label: "Rewrite" }],
    recommended: 0,
  },
];
const pending = [
  {
    role: "user",
    timestamp: 1,
    content: [{ type: "text", text: "Plan the change." }],
  },
  {
    role: "assistant",
    timestamp: 2,
    stopReason: "toolUse",
    content: [
      {
        type: "toolCall",
        id: "ask-call",
        name: "ask",
        arguments: { questions },
      },
    ],
  },
];

function harness(storage = new Map()) {
  const listeners = new Map(),
    commands = [];
  const w = {
    OMP_SUBAGENTS: {
      emptySubagents: () => ({}),
      mergeSnapshots: (current) => current,
      subscriptionLevelFor: () => "progress",
    },
    OMP_EXT_WIDGETS: { EMPTY: {} },
    OMP_SESSION_PREFS: {
      fromTweaks: () => ({ autoRetry: true }),
      closeGuardArmed: () => false,
    },
    OMP_TWEAKS_STORE: { read: () => ({}) },
    OMP_APPROVAL_MODE: { isMode: () => true },
    DEFAULT_PROFILE_ID: "default",
    INTENT_FRAMING: () => "",
    timeNow: () => "00:00",
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
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
    "app/background-tasks.js",
    "app/agent-context.js",
    "app/agent-context-sync.js",
    "adapter.js",
  ])
    new Function("window", source(path))(w);
  new Function("window", source("app/ask-recovery.js"))(w);
  new Function("window", "setTimeout", "clearTimeout", source("live.js"))(
    w,
    (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return t;
    },
    clearTimeout,
  );
  let seq = 0,
    history = pending,
    rawEntries = null,
    streaming = false,
    rejectPrompt = false,
    holdState = false,
    holdAnswer = false,
    rejectAnswer = false;
  const heldStates = [],
    heldAnswers = [],
    heldGrants = [],
    grantCalls = [],
    replays = new Map();
  const emit = (id, frame) =>
    listeners.get(`agent://line/${id}`)?.({
      payload: { seq: ++seq, text: JSON.stringify(frame) },
    });
  const reply = (cmd, data, success = true) =>
    emit(cmd.sessionId, {
      type: "response",
      command: cmd.type,
      id: cmd.id,
      success,
      data,
      ...(!success ? { error: "Prompt refused" } : {}),
    });
  w.__TAURI__ = {
    core: {
      async invoke(name, args) {
        if (name === "start_session")
          return {
            approvalMode: "write",
            path: args.args.cwd,
            workspace: null,
          };
        if (name === "replay_events")
          return replays.get(args.sessionId) ?? { dropped: false, events: [] };
        if (name === "start_git_watch") return "feature";
        if (name === "approval_approve_and_grant") {
          grantCalls.push(args);
          return new Promise((resolve, reject) =>
            heldGrants.push({ resolve, reject }),
          );
        }
        if (name === "send_command") {
          const cmd = { ...JSON.parse(args.json), sessionId: args.sessionId };
          commands.push(cmd);
          if (cmd.type === "extension_ui_response") {
            if (rejectAnswer) throw new Error("Broken answer pipe");
            if (holdAnswer)
              return new Promise((resolve, reject) =>
                heldAnswers.push({ resolve, reject }),
              );
          }
          queueMicrotask(() => {
            if (cmd.type === "get_state") {
              if (holdState) heldStates.push(cmd);
              else
                reply(cmd, {
                  isStreaming: streaming,
                  sessionFile: "/saved/conversation.jsonl",
                  sessionId: "saved",
                  model: null,
                });
            } else if (cmd.type === "get_messages")
              reply(cmd, {
                messages: history.filter(
                  (m) => !m.content?.some((b) => b.type === "toolCall"),
                ),
              });
            else if (cmd.type === "get_entries") {
              const entries =
                rawEntries ??
                history.map((message, i) => ({
                  type: "message",
                  id: `e${i}`,
                  parentId: i ? `e${i - 1}` : null,
                  message,
                }));
              reply(cmd, { entries, leafId: entries.at(-1)?.id ?? null });
            } else if (
              cmd.type === "negotiate_protocol" ||
              cmd.type === "set_ask_dialog"
            )
              reply(cmd, {});
            else if (cmd.type === "prompt") {
              if (rejectPrompt) return reply(cmd, null, false);
              const message = {
                role: "user",
                timestamp: 3,
                content: [{ type: "text", text: cmd.message }],
              };
              history = [...history, message];
              emit(cmd.sessionId, { type: "message_start", message });
              reply(cmd, {});
            }
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
    w,
    commands,
    storage,
    grantCalls,
    emit,
    exit(id, reason = "") {
      listeners.get(`agent://exit/${id}`)?.({ payload: reason });
    },
    setReplay(id, value) {
      replays.set(id, value);
    },
    setAnswerFailure(value) {
      rejectAnswer = value;
    },
    setAnswerHold(value) {
      holdAnswer = value;
    },
    releaseAnswer(error = null) {
      const held = heldAnswers.shift();
      if (error) held.reject(new Error(error));
      else held.resolve();
    },
    releaseGrant(error = null, value = null) {
      const held = heldGrants.shift();
      if (error) held.reject(new Error(error));
      else held.resolve(value);
    },
    async reopen() {
      await w.OMP_BRIDGE.resumeSession({
        path: "/saved/conversation.jsonl",
        cwd: "/project",
        title: "Saved",
      });
      await flush();
    },
    setHistory(value) {
      history = value;
    },
    setEntries(value) {
      rawEntries = value;
    },
    setStreaming(value) {
      streaming = value;
    },
    refusePrompt() {
      rejectPrompt = true;
    },
    asks() {
      return w.OMP_BRIDGE.getState().messages.filter((m) => m.kind === "ask");
    },
    delayState() {
      holdState = true;
    },
    async releaseState() {
      for (const cmd of heldStates)
        reply(cmd, {
          isStreaming: streaming,
          sessionFile: "/saved/conversation.jsonl",
          sessionId: "saved",
          model: null,
        });
      await flush();
    },
  };
}

test("reopening rebuilds tool cards from the saved branch even when model history omitted them", async () => {
  const h = harness();
  const saved = [
    {
      role: "user",
      timestamp: 1,
      content: [{ type: "text", text: "Run the check" }],
    },
    {
      role: "assistant",
      timestamp: 2,
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "check",
          name: "bash",
          arguments: { command: "npm test" },
          intent: "Checking the fix",
        },
      ],
    },
    {
      role: "toolResult",
      timestamp: 3,
      toolCallId: "check",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "passed" }],
      details: { exitCode: 0, wallTimeMs: 80 },
    },
  ];
  h.setHistory([]);
  h.setEntries(
    saved.map((message, i) => ({
      type: "message",
      id: `saved-${i}`,
      parentId: i ? `saved-${i - 1}` : null,
      message,
    })),
  );
  await h.reopen();
  const messages = h.w.OMP_BRIDGE.getState().messages;
  assert.deepEqual(
    messages.map((m) => m.kind),
    ["user", "tool"],
  );
  assert.equal(messages[1].tool, "bash");
  assert.equal(messages[1].title, "Checking the fix");
  assert.equal(messages[1].target, "npm test");
  assert.equal(messages[1].outputText, "passed");
  assert.equal(messages[1].duration, 80);
});

test("large saved tool histories are bounded immediately while retaining their newest entries", async () => {
  const h = harness();
  const messages = [
    {
      role: "user",
      timestamp: 1,
      content: [{ type: "text", text: "Inspect the files" }],
    },
    {
      role: "assistant",
      timestamp: 2,
      stopReason: "toolUse",
      content: Array.from({ length: 200 }, (_, i) => ({
        type: "toolCall",
        id: `call-${i}`,
        name: "read",
        arguments: { path: `src/file-${i}.js` },
      })),
    },
    ...Array.from({ length: 200 }, (_, i) => ({
      role: "toolResult",
      timestamp: 3 + i,
      toolCallId: `call-${i}`,
      toolName: "read",
      content: [{ type: "text", text: "contents" }],
    })),
  ];
  h.setHistory([]);
  h.setEntries(
    messages.map((message, i) => ({
      type: "message",
      id: `m${i}`,
      parentId: i ? `m${i - 1}` : null,
      message,
    })),
  );
  await h.reopen();
  const restored = h.w.OMP_BRIDGE.getState().messages;
  assert.ok(restored.length <= 169 && restored.length >= 157);
  assert.equal(restored[0].target, "src/file-38.js");
  assert.equal(restored.at(-1).target, "src/file-199.js");
});

test("reopening a saved conversation restores its unanswered question", async () => {
  const h = harness();
  await h.reopen();
  const [ask] = h.asks();
  assert.ok(
    ask,
    "the unanswered persisted ask must remain visible after reopening",
  );
  assert.equal(ask.method, "ask");
  assert.equal(ask.questions[0].question, "Which approach?");
  assert.equal(ask.answered, false);
});

test("answering after reopen continues the owning conversation once, without a stale callback", async () => {
  const h = harness();
  await h.reopen();
  const ask = h.asks()[0];
  const answers = [
    { id: ask.questions[0].id, selectedOptions: ["Small change"] },
  ];
  await Promise.all([
    h.w.OMP_BRIDGE.answerAskDialog(ask.id, answers),
    h.w.OMP_BRIDGE.answerAskDialog(ask.id, answers),
  ]);
  const prompts = h.commands.filter((c) => c.type === "prompt");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].sessionId, ask.sessionId);
  assert.ok(prompts[0].message.includes("Small change"));
  assert.equal(
    h.commands.some((c) => c.type === "extension_ui_response"),
    false,
  );
  assert.equal(h.asks()[0].answered, true);
});

test("parallel pending asks restore together so one reply cannot strand another", async () => {
  const h = harness();
  const more = structuredClone(pending);
  more[1].content.push({
    type: "toolCall",
    id: "second-ask",
    name: "ask",
    arguments: { questions },
  });
  h.setHistory(more);
  await h.reopen();
  assert.equal(h.asks().length, 1);
  const ask = h.asks()[0];
  assert.equal(ask.questions.length, 2);
  assert.notEqual(ask.questions[0].id, ask.questions[1].id);
  const answers = ask.questions.map((q, i) => ({
    id: q.id,
    selectedOptions: [i ? "Rewrite" : "Small change"],
  }));
  assert.equal(await h.w.OMP_BRIDGE.answerAskDialog(ask.id, answers), true);
  const fresh = harness(h.storage);
  fresh.setHistory([
    ...more,
    {
      role: "user",
      timestamp: 3,
      content: [
        {
          type: "text",
          text: h.commands.find((c) => c.type === "prompt").message,
        },
      ],
    },
  ]);
  await fresh.reopen();
  assert.deepEqual(fresh.asks(), []);
});

test("cancelling a recovered question survives another reopen without waking the agent", async () => {
  const h = harness();
  await h.reopen();
  assert.equal(await h.w.OMP_BRIDGE.cancelAsk(h.asks()[0].id), true);
  assert.equal(h.asks()[0].cancelled, true);
  const fresh = harness(h.storage);
  await fresh.reopen();
  assert.deepEqual(fresh.asks(), []);
  assert.equal(
    h.commands.some(
      (c) => c.type === "prompt" || c.type === "extension_ui_response",
    ),
    false,
  );
});

test("a refused answer leaves the question answerable with its failure", async () => {
  const h = harness();
  await h.reopen();
  h.refusePrompt();
  const ask = h.asks()[0];
  assert.equal(
    await h.w.OMP_BRIDGE.answerAskDialog(ask.id, [
      { id: ask.questions[0].id, selectedOptions: ["Rewrite"] },
    ]),
    false,
  );
  assert.equal(h.asks()[0].answered, false);
  assert.ok(h.asks()[0].recoveryError.includes("Prompt refused"));
});

test("failed cancellation storage leaves the question open rather than forgetting it", async () => {
  const h = harness();
  await h.reopen();
  h.w.localStorage.setItem = () => {
    throw new Error("Disk unavailable");
  };
  assert.equal(await h.w.OMP_BRIDGE.cancelAsk(h.asks()[0].id), false);
  assert.equal(h.asks()[0].cancelled, false);
  assert.ok(h.asks()[0].recoveryError.includes("Disk unavailable"));
});

test("completed, cancelled, superseded and malformed asks never reopen", async () => {
  for (const tail of [
    {
      role: "toolResult",
      toolCallId: "ask-call",
      isError: false,
      content: [{ type: "text", text: "User selected: Small change" }],
    },
    {
      role: "toolResult",
      toolCallId: "ask-call",
      isError: true,
      content: [{ type: "text", text: "User cancelled" }],
    },
    { role: "assistant", stopReason: "aborted", content: [] },
    { role: "user", content: [{ type: "text", text: "Never mind" }] },
    {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "All done" }],
    },
  ]) {
    const h = harness();
    h.setHistory([...pending, tail]);
    await h.reopen();
    assert.deepEqual(h.asks(), []);
  }
  const h = harness();
  const invalid = structuredClone(pending);
  invalid[1].content[0].arguments.questions[0].options = null;
  h.setHistory(invalid);
  await h.reopen();
  assert.deepEqual(h.asks(), []);
});

test("the native process-exit diagnostic restores unanswered asks but not unrelated tools", async () => {
  const h = harness();
  const mixed = structuredClone(pending);
  mixed[1].content.push({
    type: "toolCall",
    id: "write-call",
    name: "write",
    arguments: { path: "important.txt", content: "keep" },
  });
  h.setHistory([
    ...mixed,
    {
      role: "toolResult",
      toolCallId: "ask-call",
      isError: true,
      content: [
        {
          type: "text",
          text: "Previous OMP process exited before this tool returned; its outcome is unknown.",
        },
      ],
    },
    {
      role: "assistant",
      stopReason: "aborted",
      errorMessage: "Previous OMP process exited before completing the turn.",
      content: [],
    },
  ]);
  await h.reopen();
  assert.equal(h.asks()[0].questions[0].question, questions[0].question);
  assert.equal(
    h.commands.some(
      (c) => c.type === "prompt" || c.type === "extension_ui_response",
    ),
    false,
  );
});

test("a still-running process keeps its live question callback", async () => {
  const h = harness();
  h.setStreaming(true);
  await h.reopen();
  assert.deepEqual(h.asks(), []);
  const sessionId = h.commands[0].sessionId;
  h.emit(sessionId, {
    type: "extension_ui_request",
    method: "ask",
    id: "live-ask",
    questions,
  });
  h.emit(sessionId, {
    type: "tool_execution_start",
    toolCallId: "ask-call",
    toolName: "ask",
    args: { questions },
  });
  assert.equal(h.asks()[0].id, "live-ask");
  await h.w.OMP_BRIDGE.answerAskDialog("live-ask", [
    { id: "direction", selectedOptions: ["Rewrite"] },
  ]);
  assert.equal(
    h.commands.filter((c) => c.type === "extension_ui_response").length,
    1,
  );
  assert.equal(
    h.commands.some((c) => c.type === "prompt"),
    false,
  );
});

const liveQuestion = (id) => ({
  type: "extension_ui_request",
  method: "ask",
  id,
  questions,
});
const liveAnswers = [{ id: "direction", selectedOptions: ["Rewrite"] }];

async function liveHarness() {
  const h = harness();
  h.setHistory([]);
  h.setStreaming(true);
  await h.reopen();
  return { h, id: h.w.OMP_BRIDGE.activeSessionId };
}

function flushQuestion(h, id, questionId) {
  h.emit(id, liveQuestion(questionId));
  h.emit(id, {
    type: "tool_execution_start",
    toolCallId: `tool-${questionId}`,
    toolName: "ask",
    args: { questions },
  });
}

test("parallel prompts cancelled before flush remain visible without cancelling their peers", async () => {
  const { h, id } = await liveHarness();
  h.emit(id, liveQuestion("first"));
  h.emit(id, liveQuestion("second"));
  h.emit(id, {
    type: "extension_ui_request",
    method: "cancel",
    targetId: "first",
  });
  assert.deepEqual(
    h.asks().map((m) => [m.id, m.cancelled, m.closeReason]),
    [
      ["first", true, "omp"],
      ["second", false, undefined],
    ],
  );
  assert.equal(
    await h.w.OMP_BRIDGE.answerAskDialog("first", liveAnswers),
    false,
  );
  assert.equal(
    await h.w.OMP_BRIDGE.answerAskDialog("second", liveAnswers),
    true,
  );
  assert.deepEqual(
    h.commands
      .filter((c) => c.type === "extension_ui_response")
      .map((c) => c.id),
    ["second"],
  );
});

test("a buffered question belongs to its original tab across a switch", async () => {
  const { h, id } = await liveHarness();
  h.emit(id, liveQuestion("buffered"));
  await h.w.OMP_BRIDGE.resumeSession({
    path: "/saved/other.jsonl",
    cwd: "/other",
    title: "Other",
  });
  assert.equal(
    h.asks().some((m) => m.id === "buffered"),
    false,
  );
  await h.w.OMP_BRIDGE.activateSession(id);
  assert.equal(h.asks().find((m) => m.id === "buffered").cancelled, false);
  assert.equal(
    await h.w.OMP_BRIDGE.answerAskDialog("buffered", liveAnswers),
    true,
  );
});

test("an idle turn boundary and transcript trimming preserve a live question", async () => {
  const { h, id } = await liveHarness();
  flushQuestion(h, id, "keep");
  for (let i = 0; i < 200; i++) h.w.OMP_BRIDGE.addAssistantMessage(`row ${i}`);
  h.emit(id, { type: "turn_end", message: {} });
  assert.equal(h.asks().find((m) => m.id === "keep")?.cancelled, false);
  assert.equal(await h.w.OMP_BRIDGE.answerAskDialog("keep", liveAnswers), true);
});

test("a recently cancelled question remains visible even when open callbacks exceed scrollback", async () => {
  const { h, id } = await liveHarness();
  for (let i = 0; i < 175; i++) {
    h.emit(id, {
      type: "extension_ui_request",
      method: "input",
      id: `input-${i}`,
      title: "Input",
    });
  }
  h.emit(id, { type: "turn_end", message: {} });
  h.emit(id, {
    type: "extension_ui_request",
    method: "cancel",
    targetId: "input-0",
  });
  assert.equal(h.asks().length, 175);
  assert.equal(h.asks().find((m) => m.id === "input-0").closeReason, "omp");
  assert.equal(h.asks().filter((m) => !m.cancelled).length, 174);
});

test("failed live writes leave the question open and prevent concurrent duplicate sends", async () => {
  const { h, id } = await liveHarness();
  flushQuestion(h, id, "retry");
  h.setAnswerHold(true);
  const first = h.w.OMP_BRIDGE.answerAskDialog("retry", liveAnswers);
  assert.ok(h.asks()[0].sending);
  assert.equal(h.asks()[0].answered, false);
  assert.equal(
    await h.w.OMP_BRIDGE.answerAskDialog("retry", liveAnswers),
    false,
  );
  h.releaseAnswer("Broken answer pipe");
  assert.equal(await first, false);
  assert.equal(h.asks()[0].answered, false);
  assert.equal(h.asks()[0].cancelled, false);
  assert.match(h.asks()[0].sendError, /Broken answer pipe/);
  h.setAnswerHold(false);
  assert.equal(
    await h.w.OMP_BRIDGE.answerAskDialog("retry", liveAnswers),
    true,
  );
  assert.equal(h.asks()[0].answered, true);
  assert.equal(
    h.commands.filter((c) => c.type === "extension_ui_response").length,
    2,
  );
});

test("a rejected user-cancel write does not mark the question cancelled", async () => {
  const { h, id } = await liveHarness();
  flushQuestion(h, id, "cancel-retry");
  h.setAnswerFailure(true);
  assert.equal(await h.w.OMP_BRIDGE.cancelAsk("cancel-retry"), false);
  assert.equal(h.asks()[0].cancelled, false);
  assert.match(h.asks()[0].sendError, /Broken answer pipe/);
  h.setAnswerFailure(false);
  assert.equal(await h.w.OMP_BRIDGE.cancelAsk("cancel-retry"), true);
  assert.equal(h.asks()[0].cancelled, true);
});

test("a native cancellation or process exit wins over a late failed write", async () => {
  for (const close of ["cancel", "exit"]) {
    const { h, id } = await liveHarness();
    flushQuestion(h, id, "closing");
    h.setAnswerHold(true);
    const send = h.w.OMP_BRIDGE.answerAskDialog("closing", liveAnswers);
    if (close === "cancel")
      h.emit(id, {
        type: "extension_ui_request",
        method: "cancel",
        targetId: "closing",
      });
    else h.exit(id, "process ended");
    h.releaseAnswer("write failed");
    assert.equal(await send, false);
    const ask = h.asks().find((m) => m.id === "closing");
    assert.equal(ask.cancelled, true);
    assert.equal(
      ask.closeReason,
      close === "cancel" ? "omp" : "process-exited",
    );
    assert.equal(
      await h.w.OMP_BRIDGE.answerAskDialog("closing", liveAnswers),
      false,
    );
    assert.equal(
      h.commands.filter((c) => c.type === "extension_ui_response").length,
      1,
    );
    if (close === "exit") {
      h.emit(id, liveQuestion("late-frame"));
      h.emit(id, {
        type: "tool_execution_start",
        toolCallId: "late-tool",
        toolName: "ask",
        args: { questions },
      });
      assert.equal(
        h.asks().some((m) => m.id === "late-frame"),
        false,
      );
    }
  }
});

test("native cancel wins an in-flight approval grant; no dead callback is reopened", async () => {
  const { h, id } = await liveHarness();
  h.emit(id, {
    type: "extension_ui_request",
    method: "select",
    id: "approval",
    title: "Allow tool: bash",
    options: ["Approve", "Deny"],
  });
  h.emit(id, {
    type: "tool_execution_start",
    toolCallId: "bash-call",
    toolName: "bash",
    args: {},
  });
  const prompt = h.asks()[0];
  const grant = h.w.OMP_BRIDGE.approveAndRemember(prompt, "session");
  assert.ok(h.asks()[0].sending);
  assert.equal(h.asks()[0].answered, false);
  await h.w.OMP_BRIDGE.approveAndRemember(prompt, "session");
  assert.equal(h.grantCalls.length, 1);
  h.emit(id, {
    type: "extension_ui_request",
    method: "cancel",
    targetId: "approval",
  });
  h.releaseGrant("prompt was cancelled");
  await grant;
  assert.equal(h.asks()[0].cancelled, true);
  assert.equal(h.asks()[0].closeReason, "omp");
  assert.equal(await h.w.OMP_BRIDGE.answerAsk("approval", "Approve"), false);
  assert.equal(
    h.commands.filter((c) => c.type === "extension_ui_response").length,
    0,
  );
});

test("an approval grant failure remains on its original tab", async () => {
  const { h, id } = await liveHarness();
  h.emit(id, {
    type: "extension_ui_request",
    method: "select",
    id: "approval",
    title: "Allow tool: bash",
    options: ["Approve", "Deny"],
  });
  h.emit(id, {
    type: "tool_execution_start",
    toolCallId: "bash-call",
    toolName: "bash",
    args: {},
  });
  const grant = h.w.OMP_BRIDGE.approveAndRemember(h.asks()[0], "session");
  await h.w.OMP_BRIDGE.resumeSession({
    path: "/saved/other.jsonl",
    cwd: "/other",
    title: "Other",
  });
  h.releaseGrant("write failed");
  await grant;
  await h.w.OMP_BRIDGE.activateSession(id);
  const ask = h.asks().find((m) => m.id === "approval");
  assert.equal(ask.answered, false);
  assert.match(ask.sendError, /write failed/);
});

test("a rejected write after switching tabs updates only its owning question", async () => {
  const { h, id } = await liveHarness();
  flushQuestion(h, id, "background");
  h.setAnswerHold(true);
  const send = h.w.OMP_BRIDGE.answerAskDialog("background", liveAnswers);
  const other = await h.w.OMP_BRIDGE.resumeSession({
    path: "/saved/other.jsonl",
    cwd: "/other",
    title: "Other",
  });
  h.releaseAnswer("background pipe failed");
  assert.equal(await send, false);
  assert.equal(
    h.asks().some((m) => m.id === "background"),
    false,
  );
  await h.w.OMP_BRIDGE.activateSession(id);
  const ask = h.asks().find((m) => m.id === "background");
  assert.equal(ask.answered, false);
  assert.match(ask.sendError, /background pipe failed/);
  assert.notEqual(other, id);
});

test("replay restores an evicted live callback and closes only absent callbacks", async () => {
  const { h, id } = await liveHarness();
  flushQuestion(h, id, "gone");
  await h.w.OMP_BRIDGE.resumeSession({
    path: "/saved/other.jsonl",
    cwd: "/other",
    title: "Other",
  });
  h.setReplay(id, {
    dropped: true,
    events: [],
    headSeq: 200,
    pendingRequests: [
      { seq: 100, text: JSON.stringify(liveQuestion("evicted")) },
    ],
    pendingRequestsComplete: true,
  });
  await h.w.OMP_BRIDGE.activateSession(id);
  assert.equal(
    h.asks().find((m) => m.id === "gone").closeReason,
    "no-longer-pending",
  );
  assert.equal(h.asks().find((m) => m.id === "evicted").answered, false);
  assert.equal(
    await h.w.OMP_BRIDGE.answerAskDialog("evicted", liveAnswers),
    true,
  );
});

test("an answered request still in replay is not revived as an open callback", async () => {
  const { h, id } = await liveHarness();
  await h.w.OMP_BRIDGE.resumeSession({
    path: "/saved/other.jsonl",
    cwd: "/other",
    title: "Other",
  });
  h.setReplay(id, {
    dropped: false,
    events: [
      { seq: 10000, text: JSON.stringify(liveQuestion("answered-elsewhere")) },
    ],
    pendingRequests: [],
    pendingRequestsComplete: true,
  });
  await h.w.OMP_BRIDGE.activateSession(id);
  const ask = h.asks().find((m) => m.id === "answered-elsewhere");
  assert.equal(ask.cancelled, true);
  assert.equal(ask.closeReason, "no-longer-pending");
  assert.equal(
    await h.w.OMP_BRIDGE.answerAskDialog(ask.id, liveAnswers),
    false,
  );
});

test("stale replay frames and snapshots cannot resurrect a locally answered trimmed callback", async () => {
  for (const complete of [true, false]) {
    const { h, id } = await liveHarness();
    flushQuestion(h, id, "settled");
    assert.equal(
      await h.w.OMP_BRIDGE.answerAskDialog("settled", liveAnswers),
      true,
    );
    for (let i = 0; i < 200; i++)
      h.w.OMP_BRIDGE.addAssistantMessage(`row ${i}`);
    h.emit(id, { type: "turn_end", message: {} });
    assert.equal(
      h.asks().some((m) => m.id === "settled"),
      false,
    );
    await h.w.OMP_BRIDGE.resumeSession({
      path: "/saved/other.jsonl",
      cwd: "/other",
      title: "Other",
    });
    h.setReplay(id, {
      dropped: true,
      events: [{ seq: 10000, text: JSON.stringify(liveQuestion("settled")) }],
      pendingRequests: [
        { seq: 1, text: JSON.stringify(liveQuestion("settled")) },
      ],
      pendingRequestsComplete: complete,
    });
    await h.w.OMP_BRIDGE.activateSession(id);
    assert.equal(
      h.asks().some((m) => m.id === "settled"),
      false,
    );
  }
});

test("an incomplete pending snapshot cannot close an existing question", async () => {
  const { h, id } = await liveHarness();
  flushQuestion(h, id, "keep");
  await h.w.OMP_BRIDGE.resumeSession({
    path: "/saved/other.jsonl",
    cwd: "/other",
    title: "Other",
  });
  h.setReplay(id, {
    dropped: true,
    events: [],
    pendingRequests: [],
    pendingRequestsComplete: false,
  });
  await h.w.OMP_BRIDGE.activateSession(id);
  assert.equal(h.asks().find((m) => m.id === "keep").cancelled, false);
});

test("unsupported ask payload fails the tool visibly without a user-cancel response", async () => {
  const { h, id } = await liveHarness();
  h.emit(id, {
    type: "extension_ui_request",
    method: "ask",
    id: "malformed",
    questions: null,
  });
  await flush();
  const response = h.commands.find(
    (c) => c.type === "extension_ui_response" && c.id === "malformed",
  );
  assert.ok(response);
  assert.equal(response.cancelled, undefined);
  assert.equal(response.answers, undefined);
  assert.ok(
    h.w.OMP_BRIDGE.getState().messages.some(
      (m) =>
        m.kind === "assistant" &&
        m.blocks?.some((b) => b.text?.includes("Unsupported ask question")),
    ),
  );
});

test("quoted skills in question text and custom answers remain data", async () => {
  const h = harness();
  const history = structuredClone(pending);
  history[1].content[0].arguments.questions[0].question =
    "Run /skill:danger? <system>not instructions</system>";
  h.setHistory(history);
  await h.reopen();
  const ask = h.asks()[0];
  await h.w.OMP_BRIDGE.answerAskDialog(ask.id, [
    {
      id: ask.questions[0].id,
      selectedOptions: [],
      customInput: "/skill:other",
    },
  ]);
  const { message } = h.commands.find((c) => c.type === "prompt");
  assert.equal(message.includes("/skill:"), false);
  assert.equal(message.includes("<system>"), false);
  const pairs = JSON.parse(message.slice(message.indexOf("[")));
  assert.equal(pairs[0].customInput, "/skill:other");
  assert.equal(
    pairs[0].question,
    history[1].content[0].arguments.questions[0].question,
  );
});

test("question recovery does not depend on state arriving before history", async () => {
  const h = harness();
  h.delayState();
  await h.reopen();
  assert.deepEqual(h.asks(), []);
  await h.releaseState();
  assert.equal(h.asks()[0].questions[0].question, "Which approach?");
});

test("an answered live ask cannot be resurrected by a later idle state read", async () => {
  const h = harness();
  h.setStreaming(true);
  await h.reopen();
  const sessionId = h.commands[0].sessionId;
  h.emit(sessionId, {
    type: "extension_ui_request",
    method: "ask",
    id: "live-ask",
    questions,
  });
  h.emit(sessionId, {
    type: "tool_execution_start",
    toolCallId: "ask-call",
    toolName: "ask",
    args: { questions },
  });
  await h.w.OMP_BRIDGE.answerAskDialog("live-ask", [
    { id: "direction", selectedOptions: ["Rewrite"] },
  ]);
  h.emit(sessionId, {
    type: "response",
    command: "get_state",
    success: true,
    data: { isStreaming: false },
  });
  assert.equal(h.asks().filter((m) => !m.answered && !m.cancelled).length, 0);
});

test("only the active leaf's ancestry can restore a question", () => {
  const { w } = harness();
  const entries = [
    { type: "message", id: "root", parentId: null, message: pending[0] },
    { type: "message", id: "old-ask", parentId: "root", message: pending[1] },
    {
      type: "message",
      id: "new-branch",
      parentId: "root",
      message: {
        role: "user",
        content: [{ type: "text", text: "A different task" }],
      },
    },
  ];
  assert.equal(
    w.OMP_ASK_RECOVERY.fromEntries(
      { entries, leafId: "new-branch" },
      "/saved/session",
    ),
    null,
  );
  assert.equal(
    w.OMP_ASK_RECOVERY.fromEntries(
      { entries, leafId: "old-ask" },
      "/saved/session",
    ).questions[0].question,
    "Which approach?",
  );
  for (const broken of [
    { entries, leafId: "missing" },
    { entries: [{ ...entries[1], parentId: "missing" }], leafId: "old-ask" },
    { entries: [{ ...entries[1], parentId: "old-ask" }], leafId: "old-ask" },
    { entries: [entries[0], entries[1], entries[1]], leafId: "old-ask" },
  ])
    assert.equal(
      w.OMP_ASK_RECOVERY.fromEntries(broken, "/saved/session"),
      null,
    );
});

test("dismissal is conversation-scoped and approvals are never recovered", () => {
  const { w } = harness();
  const entries = pending.map((message, i) => ({
    type: "message",
    id: `e${i}`,
    parentId: i ? `e${i - 1}` : null,
    message,
  }));
  w.OMP_ASK_RECOVERY.dismiss("/saved/one", ["ask-call"]);
  assert.equal(
    w.OMP_ASK_RECOVERY.fromEntries({ entries, leafId: "e1" }, "/saved/one"),
    null,
  );
  assert.ok(
    w.OMP_ASK_RECOVERY.fromEntries({ entries, leafId: "e1" }, "/saved/two"),
  );
  const approval = structuredClone(entries);
  approval[1].message.content[0] = {
    type: "toolCall",
    id: "shell",
    name: "bash",
    arguments: { command: "rm important.txt" },
  };
  assert.equal(
    w.OMP_ASK_RECOVERY.fromEntries(
      { entries: approval, leafId: "e1" },
      "/saved/two",
    ),
    null,
  );
});

test("a later user-authored native custom message supersedes the old question", () => {
  const { w } = harness();
  const entries = pending.map((message, i) => ({
    type: "message",
    id: `e${i}`,
    parentId: i ? `e${i - 1}` : null,
    message,
  }));
  entries.push({
    type: "custom_message",
    id: "skill",
    parentId: "e1",
    customType: "skill-prompt",
    attribution: "user",
    content: "New instructions",
  });
  assert.equal(
    w.OMP_ASK_RECOVERY.fromEntries(
      { entries, leafId: "skill" },
      "/saved/session",
    ),
    null,
  );
});

test("native context observations do not flood restored chat; real skill reads remain visible", async () => {
  const h = harness();
  const reasoning = {
    role: "assistant",
    timestamp: 2,
    content: [
      { type: "thinking", thinking: "Check the constraints before choosing." },
      { type: "text", text: "Here is the decision." },
      {
        type: "toolCall",
        id: "skill-read",
        name: "read",
        arguments: { path: "skill://review" },
      },
    ],
  };
  const messages = [
    pending[0],
    reasoning,
    {
      role: "toolResult",
      toolCallId: "skill-read",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "Review instructions" }],
    },
  ];
  const entries = messages.map((message, i) => ({
    type: "message",
    id: `m${i}`,
    parentId: i ? `m${i - 1}` : null,
    message,
  }));
  let parentId = "m2";
  for (let i = 0; i < 200; i++) {
    entries.push({
      type: "custom",
      customType: "omp-desktop:agent-context",
      id: `context-${i}`,
      parentId,
      data: { version: 1, blocks: ["OMP system prompt"] },
    });
    parentId = `context-${i}`;
  }
  entries.push({
    type: "message",
    id: "ask",
    parentId,
    message: { ...pending[1], timestamp: 3 },
  });
  h.setHistory(messages);
  h.setEntries(entries);
  await h.reopen();
  const state = h.w.OMP_BRIDGE.getState();
  assert.deepEqual(
    state.messages.map((m) => m.kind),
    ["user", "assistant", "tool", "ask"],
  );
  assert.equal(state.messages[0].text, "Plan the change.");
  assert.equal(
    state.messages[1].thought,
    "Check the constraints before choosing.",
  );
  assert.equal(state.messages[2].target, "skill://review");
  assert.equal(state.messages[3].questions[0].question, "Which approach?");
  assert.deepEqual(
    state.agentContext.byId.main.skills.map((s) => s.name),
    ["review"],
  );
});
