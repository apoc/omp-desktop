#!/usr/bin/env node
// Consumer-visible launch lifecycle: no agent before confirmation, isolated
// folder adoption, safe cancellation, and retry after preparation failure.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const source = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const own = (value) => JSON.parse(JSON.stringify(value));
const options = {
  baseRef: "refs/heads/main",
  baseCommit: "a".repeat(40),
  worktree: true,
  acknowledgeShared: false,
};
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

function harness() {
  const window = { OMP_TWEAKS_STORE: { read: () => ({}) } };
  const timers = new Set();
  const scope = {
    window,
    console: { log() {}, warn() {}, error() {} },
    atob,
    Uint8Array,
    TextDecoder,
    TextEncoder,
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
    runInNewContext(source(`src/${file}`), scope, { filename: file });
  const listeners = new Map(),
    bindings = new Map();
  let snapshot,
    starts = 0,
    failure = null,
    hold = null;
  const bridge = window.OMP_BRIDGE;
  bridge.onUpdate((next) => {
    snapshot = own(next);
  });
  window.__TAURI__ = {
    event: {
      async listen(name, callback) {
        listeners.set(name, callback);
        return () => listeners.delete(name);
      },
    },
    core: {
      async invoke(command, args) {
        switch (command) {
          case "start_session": {
            starts++;
            if (hold) await hold;
            if (failure) throw new Error(failure);
            const id = args.args.sessionId;
            const path = args.args.workspace?.worktree
              ? `/isolated/${id}`
              : args.args.cwd;
            bindings.set(id, path);
            return {
              approvalMode: "write",
              path,
              workspace: args.args.workspace
                ? {
                    projectPath: args.args.cwd,
                    baseRef: options.baseRef,
                    baseCommit: options.baseCommit,
                    worktree: args.args.workspace.worktree,
                  }
                : null,
            };
          }
          case "start_git_watch":
            return args.path.startsWith("/isolated/")
              ? "feat/isolated"
              : "main";
          case "replay_events":
            return { dropped: false, events: [] };
          case "session_status":
            return null;
          case "conversation_workspace_inspect":
            return {
              path: args.path,
              projectPath: args.path.startsWith("/isolated/")
                ? "/source"
                : args.path,
              repoRoot: args.path,
              currentBranch: "main",
              head: "a".repeat(40),
              branches: [],
              defaults: null,
            };
          case "recent_projects_touch":
          case "recent_projects_list":
            return [];
          case "close_tab":
            bindings.delete(args.sessionId);
            return null;
          case "git_browser_status":
            return {
              repo: {
                branch: args.path.startsWith("/isolated/")
                  ? "feat/isolated"
                  : "main",
              },
            };
          case "list_project_files":
            return args.cwd.startsWith("/isolated/")
              ? ["isolated-only.txt"]
              : ["source-only.txt"];
          case "send_command": {
            const frame = JSON.parse(args.json);
            if (frame.id)
              queueMicrotask(() =>
                listeners.get(`agent://line/${args.sessionId}`)?.({
                  payload: {
                    text: JSON.stringify({
                      type: "response",
                      command: frame.type,
                      id: frame.id,
                      success: true,
                      data: {},
                    }),
                  },
                }),
              );
            return null;
          }
          default:
            return null;
        }
      },
    },
  };
  return {
    bridge,
    get snapshot() {
      return snapshot;
    },
    get starts() {
      return starts;
    },
    fail(message) {
      failure = message;
    },
    hold(promise) {
      hold = promise;
    },
    close() {
      for (const timer of timers) clearTimeout(timer);
    },
  };
}

test("cancelled and queued setup requests never launch an agent or create a tab", async () => {
  const h = harness();
  try {
    const first = h.bridge.openSession("/first", "default");
    const firstId = h.snapshot.conversationSetup.id;
    const second = h.bridge.openSession("/second", "work");
    assert.equal(h.starts, 0);
    assert.equal(h.snapshot.sessions.length, 0);
    assert.equal(h.snapshot.conversationSetup.path, "/first");
    assert.equal(h.bridge.cancelConversationSetup("stale-request"), false);
    assert.equal(h.bridge.cancelConversationSetup(firstId), true);
    assert.equal(await first, null);
    assert.equal(h.snapshot.conversationSetup.path, "/second");
    assert.equal(h.snapshot.conversationSetup.profile, "work");
    h.bridge.cancelConversationSetup(h.snapshot.conversationSetup.id);
    assert.equal(await second, null);
    assert.equal(h.starts, 0);
    assert.equal(h.snapshot.conversationSetup, null);
  } finally {
    h.close();
  }
});

test("an isolated conversation exposes its own branch and files instead of its source checkout", async () => {
  const h = harness();
  try {
    const opened = h.bridge.openSession("/source", "default");
    const result = await h.bridge.startConversationSetup(
      h.snapshot.conversationSetup.id,
      options,
    );
    assert.equal(result.ok, true);
    const id = await opened;
    assert.equal(h.snapshot.conversationSetup, null);
    assert.equal(h.snapshot.sessions[0].path, `/isolated/${id}`);
    assert.equal(h.snapshot.sessions[0].workspace.projectPath, "/source");
    assert.equal(h.snapshot.sessions[0].branch, "feat/isolated");
    assert.equal(
      (await h.bridge.gitBrowserStatus()).value.repo.branch,
      "feat/isolated",
    );
    assert.deepEqual(own(await h.bridge.listFiles("")), ["isolated-only.txt"]);
    const focused = await h.bridge.openProject(`/isolated/${id}`);
    assert.equal(focused, id);
    assert.equal(await h.bridge.openProject("/source"), id);
    assert.equal(
      h.snapshot.conversationSetup,
      null,
      "selecting the source project must reuse its worktree conversation",
    );
    assert.equal(
      h.starts,
      1,
      "focus-existing must not start another conversation",
    );
  } finally {
    h.close();
  }
});

test("failed preparation leaves setup editable with no ghost tab, then permits a corrected launch", async () => {
  const h = harness();
  try {
    const opened = h.bridge.openSession("/source", "default");
    const requestId = h.snapshot.conversationSetup.id;
    h.fail("Selected branch changed; refresh before starting");
    const refused = await h.bridge.startConversationSetup(requestId, options);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /branch changed/);
    assert.equal(h.snapshot.sessions.length, 0);
    assert.equal(h.snapshot.conversationSetup.id, requestId);
    h.fail(null);
    assert.equal(
      (await h.bridge.startConversationSetup(requestId, options)).ok,
      true,
    );
    assert.equal(h.snapshot.sessions[0].id, await opened);
  } finally {
    h.close();
  }
});

test("an in-flight launch cannot be duplicated or cancelled into an orphan process", async () => {
  const h = harness();
  let release;
  try {
    const opened = h.bridge.openSession("/source", "default");
    const requestId = h.snapshot.conversationSetup.id;
    h.hold(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const starting = h.bridge.startConversationSetup(requestId, options);
    await flush();
    assert.equal(h.bridge.cancelConversationSetup(requestId), false);
    assert.equal(
      (await h.bridge.startConversationSetup(requestId, options)).ok,
      false,
    );
    assert.equal(h.starts, 1);
    release();
    assert.equal((await starting).ok, true);
    assert.equal(h.snapshot.sessions[0].id, await opened);
  } finally {
    release?.();
    h.close();
  }
});

test("resuming a saved worktree conversation reuses its folder without another setup", async () => {
  const h = harness();
  try {
    const id = await h.bridge.resumeSession({
      path: "/saved/conversation.jsonl",
      cwd: "/isolated/existing",
      title: "Existing task",
    });
    assert.equal(h.snapshot.conversationSetup, null);
    assert.equal(h.snapshot.sessions[0].id, id);
    assert.equal(h.snapshot.sessions[0].path, "/isolated/existing");
    assert.equal(h.snapshot.sessions[0].name, "Existing task");
    assert.equal(h.snapshot.sessions[0].workspace.projectPath, "/source");
    assert.equal(h.snapshot.sessions[0].workspace.worktree, true);
    assert.equal(
      h.snapshot.sessions[0].workspace.baseRef,
      null,
      "history does not invent an unrecorded base",
    );
    assert.equal(await h.bridge.openProject("/source"), id);
    assert.equal(
      (await h.bridge.gitBrowserStatus()).value.repo.branch,
      "feat/isolated",
    );
    assert.equal(h.starts, 1);
  } finally {
    h.close();
  }
});

test("concurrent history resumes share one tab and agent", async () => {
  const h = harness();
  try {
    const session = {
      path: "/saved/conversation.jsonl",
      cwd: "/isolated/existing",
      title: "Existing task",
    };
    const [first, second] = await Promise.all([
      h.bridge.resumeSession(session),
      h.bridge.resumeSession(session),
    ]);
    assert.equal(second, first);
    assert.equal(h.snapshot.sessions.length, 1);
    assert.equal(h.starts, 1);
    assert.equal(h.snapshot.sessions[0].path, session.cwd);
  } finally {
    h.close();
  }
});

test("project-default editing never starts an agent", async () => {
  const h = harness();
  try {
    const configured = h.bridge.configureProjectWorkspace("/source", "default");
    const request = h.snapshot.conversationSetup;
    assert.equal(request.configure, true);
    assert.equal(
      (await h.bridge.startConversationSetup(request.id, options)).ok,
      false,
    );
    assert.equal(h.starts, 0);
    assert.equal(h.snapshot.sessions.length, 0);
    h.bridge.cancelConversationSetup(request.id);
    assert.equal(await configured, null);
    assert.equal(h.starts, 0);
  } finally {
    h.close();
  }
});
