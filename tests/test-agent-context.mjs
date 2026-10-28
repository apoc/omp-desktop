#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import observer from "../src-tauri/src/agent/context-extension.mjs";

const source = (name) =>
  readFileSync(new URL(`../src/app/${name}`, import.meta.url), "utf8");
const w = {};
new Function("window", source("agent-context.js"))(w);
const C = w.OMP_AGENT_CONTEXT;
const entry = (id, parentId, fields = {}) => ({ id, parentId, ...fields });
const snapshot = (
  id = "prompt",
  parentId = null,
  blocks = ["Native system instructions"],
) =>
  entry(id, parentId, {
    type: "custom",
    customType: C.TYPE,
    runtime: { version: "native-version" },
    data: {
      version: 1,
      agent: { kind: "main", name: "main" },
      blocks,
      truncated: false,
    },
  });
const call = (id, parentId, toolId, path) =>
  entry(id, parentId, {
    type: "message",
    message: {
      role: "assistant",
      timestamp: 2,
      content: [
        { type: "toolCall", id: toolId, name: "read", arguments: { path } },
      ],
    },
  });
const result = (id, parentId, toolId, isError = false, details) =>
  entry(id, parentId, {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "read",
      toolCallId: toolId,
      isError,
      details,
    },
  });
const readBranch = (over = {}) => [
  snapshot(),
  call("call", "prompt", "read-one", "skill://review"),
  result("result", "call", "read-one", false, over.details),
];
const scan = (entries) =>
  C.entries(C.empty(), "main", { entries, leafId: entries.at(-1)?.id ?? null });
const skills = (state) => C.get(state, "main").skills.map((s) => s.name);

test("only completed successful skill loads count, never listings, attempts or failures", () => {
  const attempted = [
    snapshot("prompt", null, ["Available skills: review, security"]),
    call("call", "prompt", "read-one", "skill://review"),
  ];
  assert.deepEqual(skills(scan(attempted)), []);
  assert.deepEqual(
    skills(scan([...attempted, result("failed", "call", "read-one", true)])),
    [],
  );
  assert.deepEqual(skills(scan(readBranch())), ["review"]);
});

test("explicit and auto-loaded native skill prompts share one used-skill identity", () => {
  let state = scan([
    ...readBranch(),
    entry("invoke", "result", {
      type: "custom_message",
      customType: "skill-prompt",
      attribution: "agent",
      details: { name: "review", path: "/skills/review/SKILL.md" },
    }),
  ]);
  const used = C.get(state, "main").skills;
  assert.equal(used.length, 1);
  assert.equal(used[0].loads, 2);
  assert.equal(used[0].path, "/skills/review/SKILL.md");
  state = C.entries(state, "main", { entries: [], leafId: "invoke" });
  assert.equal(
    C.get(state, "main").skills[0].loads,
    2,
    "replayed reads are not extra usage",
  );
});

test("native resolved skill metadata wins over a different requested name", () => {
  const state = scan(
    readBranch({
      details: {
        meta: { source: { type: "internal", value: "skill://replacement" } },
      },
    }),
  );
  assert.deepEqual(skills(state), ["replacement"]);
});

test("active ancestry excludes abandoned skill loads and handles branch rewinds", () => {
  const entries = [
    ...readBranch(),
    entry("other", "prompt", {
      type: "message",
      message: { role: "user", timestamp: 3 },
    }),
  ];
  let state = C.entries(C.empty(), "main", { entries, leafId: "other" });
  assert.deepEqual(skills(state), []);
  state = scan(readBranch());
  state = C.entries(state, "main", { entries: [], leafId: "prompt" });
  assert.deepEqual(skills(state), []);
});

test("broken or cyclic ancestry fails closed without inventing context", () => {
  const state = C.entries(C.empty(), "main", {
    entries: [snapshot("broken", "missing")],
    leafId: "broken",
  });
  assert.equal(C.get(state, "main").status, "error");
  assert.deepEqual(C.get(state, "main").instructions, []);
  const cyclic = C.entries(C.empty(), "main", {
    entries: [snapshot("cycle", "cycle")],
    leafId: "cycle",
  });
  assert.equal(C.get(cyclic, "main").status, "error");
});

test("each subagent keeps its own native prompt, used skills and owner", () => {
  let state = scan(readBranch());
  state = C.register(state, {
    id: "Worker",
    sessionFile: "/sessions/one",
    parentToolCallId: "task-call",
    agentSource: "project",
  });
  const child = [
    entry("init", null, {
      type: "session_init",
      agent: "scout",
      systemPrompt: ["Read only"],
      runtime: { version: "child-native" },
    }),
    call("read", "init", "child-read", "skill://security"),
    result("done", "read", "child-read"),
  ];
  state = C.entries(state, "Worker", {
    entries: child,
    nextByte: 123,
    reset: false,
  });
  assert.deepEqual(skills(state), ["review"]);
  assert.deepEqual(
    C.get(state, "Worker").skills.map((s) => s.name),
    ["security"],
  );
  assert.equal(C.get(state, "Worker").instructions[0].text, "Read only");
  assert.ok(
    C.get(state, "Worker").events.every((e) => e.anchorToolId === "task-call"),
  );
  state = C.register(state, { id: "Worker", sessionFile: "/sessions/two" });
  assert.deepEqual(C.get(state, "Worker").skills, []);
  assert.equal(C.get(state, "Worker").nextByte, 0);
});

test("prototype-shaped native agent ids do not alias the main agent", () => {
  let state = C.register(C.empty(), {
    id: "__proto__",
    sessionFile: "/sessions/proto",
  });
  state = C.entries(state, "__proto__", {
    entries: [snapshot()],
    leafId: "prompt",
  });
  assert.equal(C.get(state, "main").status, "loading");
  assert.equal(C.get(state, "__proto__").status, "ready");
});

test("latest native prompt replaces instructions while preserving prior skill usage", () => {
  const project =
    '<project-context>\n<repo-rules>\n<file path="/project/AGENTS.md">\nProject rules\n</file>\n</repo-rules>\n</project-context>';
  const state = scan([
    ...readBranch(),
    snapshot("updated", "result", ["Changed system", project]),
  ]);
  const agent = C.get(state, "main");
  assert.deepEqual(skills(state), ["review"]);
  assert.equal(agent.instructions[0].text, "Changed system");
  assert.ok(agent.instructions.some((i) => i.path === "/project/AGENTS.md"));
  assert.ok(
    !agent.instructions.some((i) => i.text === "Native system instructions"),
  );
});

test("context markers have stable ids, follow their tool, and never carry omp message timestamps", () => {
  const state = scan(readBranch());
  const user = { kind: "user", ts: 1, text: "Review" };
  const tool = { kind: "tool", _toolCallId: "read-one", status: "ok" };
  const reply = {
    kind: "assistant",
    ts: 3,
    blocks: [{ type: "text", text: "Done" }],
  };
  const rows = C.markers(state, [user, tool, reply]);
  const skill = rows.find((m) => m.contextKind === "skill");
  assert.equal(rows.indexOf(skill), rows.indexOf(tool) + 1);
  assert.ok(
    rows.filter((m) => m.kind === "context").every((m) => !("ts" in m)),
  );
  assert.equal(C.markers(state, rows), rows);
  const forgotten = C.forget(state, [skill]);
  assert.ok(
    !C.markers(
      forgotten,
      rows.filter((m) => m !== skill),
    ).some((m) => m._id === skill._id),
  );
});

test("byte-tail resets discard old child context", () => {
  let state = C.register(C.empty(), {
    id: "Child",
    sessionFile: "/sessions/child",
  });
  state = C.entries(state, "Child", { entries: readBranch(), nextByte: 100 });
  state = C.entries(state, "Child", {
    entries: [snapshot("reset", null, ["New native prompt"])],
    nextByte: 50,
    reset: true,
  });
  assert.deepEqual(C.get(state, "Child").skills, []);
  assert.equal(C.get(state, "Child").instructions[0].text, "New native prompt");
});

test("native observer snapshots are local extension state and dedupe unchanged prompts", () => {
  const handlers = new Map(),
    written = [];
  observer({
    on: (name, fn) => handlers.set(name, fn),
    appendEntry: (type, data) => written.push({ type, data }),
  });
  const prompt = ["Native original"];
  const ctx = {
    sessionManager: { getSessionFile: () => "/sessions/main" },
    getSystemPrompt: () => prompt,
    agent: { kind: "main", id: "Main", name: "main" },
  };
  handlers.get("session_start")({}, ctx);
  handlers.get("agent_start")({}, ctx);
  assert.equal(written.length, 1);
  prompt[0] = "Extension changed the effective prompt";
  handlers.get("before_provider_request")({}, ctx);
  assert.equal(written.length, 2);
  assert.equal(written[1].type, C.TYPE);
  assert.deepEqual(written[1].data.blocks, prompt);
});

test("native observer bounds snapshots and explicitly marks truncation", () => {
  const handlers = new Map(),
    written = [];
  observer({
    on: (name, fn) => handlers.set(name, fn),
    appendEntry: (_type, data) => written.push(data),
  });
  handlers.get("session_start")(
    {},
    {
      sessionManager: { getSessionFile: () => "large" },
      getSystemPrompt: () => ["a".repeat(512 * 1024 - 1) + "😀", "not reached"],
      agent: { kind: "main" },
    },
  );
  assert.equal(written[0].truncated, true);
  assert.ok(written[0].blocks.join("").length <= 512 * 1024);
  assert.ok(!/[\uD800-\uDBFF]$/.test(written[0].blocks.at(-1)));
  const state = scan([snapshot("large", null, written[0].blocks)]);
  assert.equal(C.get(state, "main").status, "ready");
});

test("a context response after leaving the tab cannot change that tab's replacement", async () => {
  let current = true,
    state = C.empty(),
    resolve;
  const w = { OMP_AGENT_CONTEXT: C };
  new Function("window", source("agent-context-sync.js"))(w);
  const sync = w.OMP_AGENT_CONTEXT_SYNC.create({
    request: () =>
      new Promise((r) => {
        resolve = r;
      }),
    get: () => state,
    set: (value) => {
      state = value;
    },
    current: () => current,
    changed() {},
    subagents: () => ({ order: [] }),
  });
  const pending = sync.loadMain();
  current = false;
  resolve({ entries: readBranch(), leafId: "result" });
  await pending;
  assert.deepEqual(skills(state), []);
  assert.equal(C.get(state, "main").status, "loading");
  sync.dispose();
});

test("catalog names resolve namespaced resources but never count as usage", () => {
  let state = C.catalog(C.empty(), [
    { source: "skill", name: "skill:team/review" },
  ]);
  assert.deepEqual(skills(state), []);
  const entries = [
    snapshot(),
    call("call", "prompt", "read", "skill://team/review/scripts/check.js"),
    result("result", "call", "read", false, {
      meta: {
        source: {
          type: "internal",
          value: "skill://team/review/scripts/check.js",
        },
      },
    }),
  ];
  state = C.entries(state, "main", { entries, leafId: "result" });
  assert.deepEqual(skills(state), ["team/review"]);
});

test("a partly successful mixed read never credits every requested skill", () => {
  const entries = [
    snapshot(),
    call("call", "prompt", "read", "skill://good;skill://missing"),
    result("result", "call", "read", false),
  ];
  assert.deepEqual(skills(scan(entries)), []);
});

test("a late byte tail cannot attach one subagent run's skills to another", async () => {
  let state = C.empty(),
    first,
    reads = 0;
  let agents = {
    order: ["Child"],
    byId: { Child: { id: "Child", sessionFile: "/old", status: "running" } },
  };
  const timers = new Map();
  let timerId = 0;
  const ww = { OMP_AGENT_CONTEXT: C };
  new Function(
    "window",
    "setTimeout",
    "clearTimeout",
    source("agent-context-sync.js"),
  )(
    ww,
    (fn) => {
      timers.set(++timerId, fn);
      return timerId;
    },
    (id) => timers.delete(id),
  );
  const drain = () => {
    for (const [id, fn] of [...timers]) {
      timers.delete(id);
      fn();
    }
  };
  const sync = ww.OMP_AGENT_CONTEXT_SYNC.create({
    current: () => true,
    get: () => state,
    set: (next) => {
      state = next;
    },
    changed() {},
    subagents: () => agents,
    request: () =>
      ++reads === 1
        ? new Promise((resolve) => {
            first = resolve;
          })
        : Promise.resolve({
            entries: [snapshot("new", null, ["New run"])],
            nextByte: 10,
          }),
  });
  sync.refreshAgents();
  drain();
  agents = {
    order: ["Child"],
    byId: { Child: { id: "Child", sessionFile: "/new", status: "completed" } },
  };
  sync.refreshAgents();
  drain();
  first({ entries: readBranch(), nextByte: 100 });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(C.get(state, "Child").sessionFile, "/new");
  assert.deepEqual(C.get(state, "Child").skills, []);
  assert.equal(C.get(state, "Child").instructions[0].text, "New run");
  assert.equal(
    C.view(state).agents.find((a) => a.id === "Child").status,
    "completed",
  );
  sync.dispose();
});

test("switching native branches records the effective prompt even when its text is unchanged", () => {
  const handlers = new Map(),
    written = [];
  observer({
    on: (name, fn) => handlers.set(name, fn),
    appendEntry: (_type, data) => written.push(data),
  });
  const ctx = {
    sessionManager: { getSessionFile: () => "/same/conversation" },
    getSystemPrompt: () => ["Effective prompt"],
    agent: { kind: "main" },
  };
  handlers.get("session_start")({}, ctx);
  handlers.get("before_provider_request")({}, ctx);
  assert.equal(written.length, 1);
  handlers.get("session_tree")({}, ctx);
  assert.equal(written.length, 2);
  assert.deepEqual(written[1].blocks, ["Effective prompt"]);
});
