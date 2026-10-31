#!/usr/bin/env node
// Public bridge regressions against deterministic IPC and current-branch reads.
// Run: node tests/test-pr-automation-bridge.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = (path) =>
  readFileSync(
    fileURLToPath(new URL(`../src/${path}`, import.meta.url)),
    "utf8",
  );
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const A = "https://github.com/acme/app/pull/12",
  B = "https://github.com/acme/app/pull/99";
const snapshot = (over = {}) => ({
  url: A,
  branch: "feature",
  head: "abc123",
  ...over,
});
const permit = () => true;

function harness() {
  const listeners = new Map(),
    journal = new Map(),
    commands = [],
    reads = [],
    prompts = [];
  const w = {
    OMP_SLASH: { LOCAL_COMMANDS: [] },
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
    OMP_PROJECT_NAV: {
      basename: (path) => path.split("/").at(-1),
      findConversationTab: () => null,
    },
    DEFAULT_PROFILE_ID: "default",
    INTENT_FRAMING: () => "",
    timeNow: () => "00:00",
  };
  for (const path of [
    "app/message-queue.js",
    "app/goal.js",
    "app/prompt-history.js",
    "app/session-title.js",
    "app/turn-status.js",
    "app/live-voice.js",
    "app/transcript-merge.js",
    "adapter.js",
    "app/pr-automation.js",
  ]) {
    new Function("window", source(path))(w);
  }
  const timeout = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return timer;
  };
  new Function("window", "setTimeout", "clearTimeout", source("live.js"))(
    w,
    timeout,
    clearTimeout,
  );
  let snapshotResult = null,
    snapshot,
    promptGate = null;
  function emit(id, frame) {
    const entries = journal.get(id) ?? [];
    const envelope = { seq: entries.length + 1, text: JSON.stringify(frame) };
    entries.push(envelope);
    journal.set(id, entries);
    listeners.get(`agent://line/${id}`)?.({ payload: envelope });
  }
  function reply(cmd, data, success = true) {
    emit(cmd.sessionId, {
      type: "response",
      command: cmd.type,
      id: cmd.id,
      success,
      data,
    });
  }
  w.__TAURI__ = {
    core: {
      async invoke(command, args) {
        if (command === "start_session") return "write";
        if (command === "start_git_watch") return { branch: "feature", root: "/repo" };
        if (command === "stop_session") {
          journal.delete(args.sessionId);
          return null;
        }
        if (command === "create_profile") return { id: "other", name: "Other" };
        if (command === "list_profiles")
          return {
            profiles: [
              { id: "default", name: "default" },
              { id: "other", name: "Other" },
            ],
          };
        if (command === "replay_events")
          return {
            dropped: false,
            events: (journal.get(args.sessionId) ?? []).filter(
              (e) => e.seq > args.afterSeq,
            ),
          };
        if (command === "pr_automation_snapshot") {
          reads.push(args.sessionId);
          return snapshotResult;
        }
        if (command === "send_command") {
          const cmd = { ...JSON.parse(args.json), sessionId: args.sessionId };
          commands.push(cmd);
          if (cmd.type === "prompt") {
            prompts.push({ sessionId: args.sessionId, text: cmd.message });
            if (promptGate) await promptGate;
          }
          if (
            cmd.type === "negotiate_protocol" ||
            cmd.type === "set_ask_dialog"
          )
            queueMicrotask(() => reply(cmd, null));
        }
        return null;
      },
    },
    event: {
      async listen(name, callback) {
        listeners.set(name, callback);
        return () => listeners.delete(name);
      },
    },
  };
  const bridge = w.OMP_BRIDGE;
  bridge.onUpdate((value) => {
    snapshot = value;
  });
  const setBranch = (id, value) =>
    listeners.get(`git://branch/${id}`)?.({ payload: value });
  const clean = () =>
    Object.assign(bridge.getState(), {
      rpcState: { isSettled: true },
      isStreaming: false,
      asyncPending: false,
      exitReason: null,
      messages: [],
      queue: w.OMP_QUEUE.EMPTY_QUEUE,
      queueSending: [],
      goal: w.OMP_GOAL.NONE,
    });
  return {
    STALE: w.OMP_PR_AUTOMATION.STALE,
    bridge,
    emit,
    reply,
    setBranch,
    clean,
    commands,
    reads,
    prompts,
    snapshot: () => snapshot,
    setResult: (value) => {
      snapshotResult = value;
    },
    /** Holds every `prompt` write until the returned release is called. */
    holdPrompts: () => {
      let release;
      promptGate = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}
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

await check(
  "fresh and resumed conversations discover the current branch PR without creation history",
  async () => {
    for (const resume of [false, true]) {
      const h = harness();
      const id = resume
        ? await h.bridge.resumeSession({
            path: "/saved/session.jsonl",
            cwd: "/project",
            title: "Saved",
          })
        : await h.bridge.openSession("/project");
      await flush();
      const current = snapshot();
      h.setResult(current);
      assert.equal(await h.bridge.prAutomationSnapshot(id), current);
      assert.deepEqual(h.prompts, []);
    }
  },
);

await check(
  "publication revalidates the PR, branch and HEAD against a fresh native snapshot",
  async () => {
    const h = harness(),
      id = await h.bridge.openSession("/project");
    await flush();
    h.clean();
    const expected = snapshot();
    for (const changed of [
      null,
      snapshot({ url: B }),
      snapshot({ branch: "other" }),
      snapshot({ head: "next" }),
    ]) {
      h.setResult(changed);
      assert.equal(
        await h.bridge.prAutomationSend(id, "stale fixes", expected, permit),
        false,
      );
    }
    assert.deepEqual(h.prompts, []);
    h.setResult(snapshot());
    assert.equal(
      await h.bridge.prAutomationSend(
        id,
        "Address PR feedback",
        expected,
        permit,
      ),
      true,
    );
    assert.deepEqual(h.prompts, [
      { sessionId: id, text: "Address PR feedback" },
    ]);
    assert.equal(
      h.bridge.getState().messages.at(-1).text,
      "Address PR feedback",
    );
  },
);

await check(
  "a prompt omp accepted counts as sent even after switching tabs",
  async () => {
    const h = harness();
    const a = await h.bridge.openSession("/a");
    await flush();
    h.clean();
    h.setResult(snapshot());
    const release = h.holdPrompts();
    const sending = h.bridge.prAutomationSend(a, "Fix CI", snapshot(), permit);
    await flush();
    assert.deepEqual(h.prompts, [{ sessionId: a, text: "Fix CI" }]);
    await h.bridge.openSession("/b");
    await flush();
    release();
    assert.equal(await sending, true);
  },
);

await check(
  "idle, queue, ask and goal guards prevent automatic fix publication",
  async () => {
    const h = harness(),
      id = await h.bridge.openSession("/project");
    await flush();
    h.setResult(snapshot());
    h.clean();
    assert.equal(
      await h.bridge.prAutomationSend(
        "different-tab",
        "wrong target",
        snapshot(),
        permit,
      ),
      false,
    );
    assert.equal(
      await h.bridge.prAutomationSend(id, "missing target", undefined, permit),
      false,
    );
    for (const patch of [
      { rpcState: null },
      { rpcState: { isSettled: false } },
      { rpcState: { isSettled: true, queuedMessageCount: 1 } },
      { isStreaming: true },
      { asyncPending: true },
      { exitReason: "process died" },
      { queueSending: [{ text: "pending" }] },
      { queue: { steering: ["pending"], followUp: [] } },
      { messages: [{ kind: "ask", answered: false }] },
      { goal: { known: true, goal: { status: "paused" } } },
    ]) {
      h.clean();
      Object.assign(h.bridge.getState(), patch);
      assert.equal(
        await h.bridge.prAutomationSend(id, "must wait", snapshot(), permit),
        false,
        JSON.stringify(patch),
      );
    }
    assert.deepEqual(h.prompts, []);
  },
);

await check(
  "a branch change during native revalidation cancels publication",
  async () => {
    const h = harness(),
      id = await h.bridge.openSession("/project");
    await flush();
    h.clean();
    let release;
    h.setResult(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const sending = h.bridge.prAutomationSend(
      id,
      "old branch",
      snapshot(),
      permit,
    );
    h.setBranch(id, "other");
    release(snapshot());
    assert.equal(await sending, false);
    assert.deepEqual(h.prompts, []);
  },
);

await check(
  "becoming busy during native revalidation cancels publication",
  async () => {
    const h = harness(),
      id = await h.bridge.openSession("/project");
    await flush();
    h.clean();
    let release;
    h.setResult(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const sending = h.bridge.prAutomationSend(
      id,
      "must wait",
      snapshot(),
      permit,
    );
    Object.assign(h.bridge.getState(), { isStreaming: true });
    release(snapshot());
    assert.equal(await sending, false);
    assert.deepEqual(h.prompts, []);
  },
);

await check(
  "revoking Auto-fix during native revalidation prevents the handoff",
  async () => {
    const h = harness(),
      id = await h.bridge.openSession("/project");
    await flush();
    h.clean();
    let release,
      allowed = true;
    h.setResult(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const sending = h.bridge.prAutomationSend(
      id,
      "cancelled fixes",
      snapshot(),
      () => allowed,
    );
    allowed = false;
    release(snapshot());
    assert.equal(await sending, false);
    assert.deepEqual(h.prompts, []);
  },
);

await check(
  "a busy background tab in the same project blocks automatic fixes",
  async () => {
    const h = harness(),
      a = await h.bridge.openSession("/project");
    await flush();
    const b = await h.bridge.openSession("/project");
    await flush();
    h.emit(b, { type: "turn_start" });
    await h.bridge.activateSession(a);
    await flush();
    h.clean();
    h.setResult(snapshot());
    assert.equal(
      await h.bridge.prAutomationSend(a, "must wait", snapshot(), permit),
      false,
    );
    assert.deepEqual(h.prompts, []);
  },
);

await check(
  "tab switches discard in-flight discovery and reject publication to another tab",
  async () => {
    const h = harness(),
      a = await h.bridge.openSession("/a");
    await flush();
    let release;
    h.setResult(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const stale = h.bridge.prAutomationSnapshot(a);
    const b = await h.bridge.openSession("/b");
    await flush();
    await h.bridge.activateSession(a);
    await flush();
    release(snapshot());
    assert.equal(await stale, h.STALE);
    assert.equal(
      await h.bridge.prAutomationSend(b, "other tab", snapshot(), permit),
      false,
    );
  },
);

await check(
  "a tab being left cannot start discovery or automatic fixes",
  async () => {
    const h = harness();
    const a = await h.bridge.openSession("/a");
    const b = await h.bridge.openSession("/b");
    await h.bridge.activateSession(a);
    await flush();
    h.clean();
    h.setResult(snapshot());
    const switching = h.bridge.activateSession(b);
    assert.equal(await h.bridge.prAutomationSnapshot(a), h.STALE);
    assert.equal(
      await h.bridge.prAutomationSend(a, "must wait", snapshot(), permit),
      false,
    );
    await switching;
    assert.deepEqual(h.prompts, []);
  },
);

await check("a branch change invalidates in-flight discovery", async () => {
  const h = harness(),
    id = await h.bridge.openSession("/project");
  await flush();
  let release;
  h.setResult(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const stale = h.bridge.prAutomationSnapshot(id);
  h.setBranch(id, "other");
  release(snapshot());
  assert.equal(await stale, h.STALE);
});

await check(
  "new and forked conversations discard stale lookups but can discover the same branch PR",
  async () => {
    for (const command of ["new_session", "fork"]) {
      const h = harness(),
        id = await h.bridge.openSession("/project");
      await flush();
      let release;
      h.setResult(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      const stale = h.bridge.prAutomationSnapshot(id);
      if (command === "new_session") h.bridge.newSession();
      h.emit(id, { type: "response", command, success: true, data: {} });
      await flush();
      release(snapshot());
      assert.equal(await stale, h.STALE);
      const current = snapshot();
      h.setResult(current);
      assert.equal(await h.bridge.prAutomationSnapshot(id), current);
      assert.deepEqual(h.prompts, []);
    }
  },
);

await check(
  "profile switches invalidate pending requests without hiding the branch PR",
  async () => {
    const h = harness();
    await h.bridge.createProfile("Other");
    const id = await h.bridge.openSession("/project");
    await flush();
    let release;
    h.setResult(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const stale = h.bridge.prAutomationSnapshot(id);
    const switched = await h.bridge.switchSessionProfile(id, "other");
    await flush();
    assert.equal(switched.ok, true);
    release(snapshot());
    assert.equal(await stale, h.STALE);
    const current = snapshot();
    h.setResult(current);
    assert.equal(await h.bridge.prAutomationSnapshot(id), current);
  },
);
console.log(`pr-automation-bridge: ${passed} checks passed`);
