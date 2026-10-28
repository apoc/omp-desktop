#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import observer from "../src-tauri/src/agent/context-extension.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

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

test("explicit invocation and repeated reads keep one used-skill identity", () => {
  let state = scan([
    ...readBranch(),
    entry("invoke", "result", {
      type: "custom_message",
      customType: "skill-prompt",
      attribution: "user",
      details: { name: "review", path: "/skills/review/SKILL.md" },
    }),
  ]);
  const used = C.get(state, "main").skills;
  assert.equal(used.length, 1);
  assert.equal(used[0].path, "/skills/review/SKILL.md");
  state = C.entries(state, "main", { entries: [], leafId: "invoke" });
  assert.deepEqual(
    C.get(state, "main").skills,
    used,
    "replayed observations never duplicate usage",
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
  assert.deepEqual(agent.instructions, [
    {
      id: "file:/project/AGENTS.md",
      name: "AGENTS.md",
      path: "/project/AGENTS.md",
      text: "Project rules",
    },
  ]);
});

test("available repo/global skills and automatic injections never become session usage", () => {
  const prompt = snapshot();
  prompt.data.skills = [
    {
      name: "repo-check",
      path: "/project/.agents/skills/check/SKILL.md",
      scope: "repo",
    },
    {
      name: "review",
      path: "/home/me/.agents/skills/review/SKILL.md",
      scope: "global",
    },
  ];
  const state = scan([
    prompt,
    entry("auto", "prompt", {
      type: "custom_message",
      customType: "skill-prompt",
      attribution: "agent",
      details: {
        name: "review",
        path: "/home/me/.agents/skills/review/SKILL.md",
      },
    }),
    entry("nested-auto", "auto", {
      type: "message",
      message: {
        role: "custom",
        customType: "skill-prompt",
        attribution: "agent",
        details: {
          name: "repo-check",
          path: "/project/.agents/skills/check/SKILL.md",
        },
      },
    }),
  ]);
  const main = C.view(state).agents[0];
  assert.deepEqual(
    main.skillGroups.find((g) => g.id === "project").entries.map((s) => s.name),
    ["repo-check"],
  );
  assert.deepEqual(
    main.skillGroups.find((g) => g.id === "other").entries.map((s) => s.name),
    ["review"],
  );
  assert.deepEqual(main.skills, []);
  assert.deepEqual(
    main.instructions,
    [],
    "boilerplate system prompt is not a loaded instruction file",
  );
});

test("a successful read credits an automatically injected skill exactly once", () => {
  const prompt = snapshot();
  prompt.data.skills = [
    { name: "review", path: "/global/review/SKILL.md", scope: "global" },
  ];
  const history = [
    prompt,
    entry("auto", "prompt", {
      type: "message",
      message: {
        role: "custom",
        customType: "skill-prompt",
        attribution: "agent",
        details: { name: "review", path: "/global/review/SKILL.md" },
      },
    }),
  ];
  let parent = "auto";
  for (let i = 0; i < 200; i++) {
    history.push(
      call(
        `read-${i}`,
        parent,
        `tool-${i}`,
        i % 2 ? "skill://review" : "/global/review/SKILL.md",
      ),
      result(`done-${i}`, `read-${i}`, `tool-${i}`),
    );
    parent = `done-${i}`;
  }
  const state = scan(history);
  const main = C.view(state).agents[0];
  assert.deepEqual(
    main.skills.map((s) => [s.name, s.path]),
    [["review", "/global/review/SKILL.md"]],
  );
  assert.deepEqual(
    main.skillGroups.find((g) => g.id === "other").entries.map((s) => s.name),
    ["review"],
  );
});

test("catalog updates and identical instruction files stay unique on the active branch", () => {
  const project =
    '<project-context>\n<repo-rules>\n<file path="/project/AGENTS.md">\nLoaded rules\n</file>\n</repo-rules>\n</project-context>';
  const first = snapshot("first", null, ["OMP system", project, project]);
  first.data.skills = [{ name: "old", path: "/old/SKILL.md", scope: "global" }];
  const latest = snapshot("latest", "first", ["Changed system", project]);
  latest.data.skills = [
    { name: "new", path: "/project/new/SKILL.md", scope: "repo" },
  ];
  const main = C.view(scan([first, latest])).agents[0];
  assert.deepEqual(
    main.skillGroups.map((g) => g.id),
    ["project"],
  );
  assert.deepEqual(
    main.skillGroups.find((g) => g.id === "project").entries.map((s) => s.name),
    ["new"],
  );
  assert.deepEqual(
    main.instructions.map((s) => [s.path, s.text]),
    [["/project/AGENTS.md", "Loaded rules"]],
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

test("native catalog retains scoped skill paths and refreshes independently of prompt text", () => {
  const project = join(homedir(), "projects", "context-fixture");
  const repoPath = join(project, ".agents", "skills", "review", "SKILL.md");
  const globalPath = join(homedir(), ".agents", "skills", "check", "SKILL.md");
  const handlers = new Map(),
    written = [];
  let commands = [
    {
      source: "skill",
      name: "skill:team/review",
      path: repoPath,
      description: "Project review",
    },
    {
      source: "skill",
      name: "skill:global-check",
      path: globalPath,
      description: "Global checks",
    },
    { source: "extension", name: "not-a-skill", path: repoPath },
    { source: "skill", name: "skill:missing-path" },
  ];
  observer({
    on: (name, fn) => handlers.set(name, fn),
    appendEntry: (_type, data) => written.push(data),
    getCommands: () => commands,
  });
  const ctx = {
    cwd: join(project, "src"),
    sessionManager: { getSessionFile: () => "catalog-fixture" },
    getSystemPrompt: () => ["Unchanged prompt"],
    agent: { kind: "main" },
  };
  handlers.get("session_start")({}, ctx);
  handlers.get("before_provider_request")({}, ctx);
  assert.equal(written.length, 1);
  const byName = new Map(written[0].skills.map((s) => [s.name, s]));
  assert.deepEqual([...byName.keys()].sort(), ["global-check", "team/review"]);
  assert.equal(byName.get("team/review").path, repoPath);
  assert.equal(byName.get("team/review").scope, "repo");
  assert.equal(byName.get("team/review").description, "Project review");
  assert.equal(byName.get("global-check").scope, "global");
  commands = [
    {
      source: "skill",
      name: "skill:new",
      path: repoPath,
      description: "Replacement catalog",
    },
  ];
  handlers.get("before_provider_request")({}, ctx);
  assert.equal(written.length, 2);
  assert.deepEqual(written[1].blocks, ["Unchanged prompt"]);
  assert.deepEqual(
    written[1].skills.map((s) => s.name),
    ["new"],
  );
});

test("native skill origins separate project, shared, OMP/profile and other providers", () => {
  const project = join(homedir(), "projects", "origin-fixture");
  const fixtures = [
    [
      "project",
      join(project, ".omp", "skills", "build", "SKILL.md"),
      "project",
      ".omp",
    ],
    [
      "ancestor",
      join(project, ".agents", "skills", "review", "SKILL.md"),
      "project",
      ".agents",
    ],
    [
      "shared",
      join(homedir(), ".agents", "skills", "review", "SKILL.md"),
      "shared",
      ".agents",
    ],
    [
      "profile",
      join(
        homedir(),
        ".omp",
        "profiles",
        "work",
        "agent",
        "skills",
        "check",
        "SKILL.md",
      ),
      "omp",
      "OMP / profile",
    ],
    [
      "claude",
      join(homedir(), ".claude", "skills", "check", "SKILL.md"),
      "other",
      "Claude",
    ],
    [
      "custom",
      join(homedir(), "custom-skills", "check", "SKILL.md"),
      "other",
      "Other",
    ],
  ];
  const handlers = new Map(),
    written = [];
  observer({
    on: (name, fn) => handlers.set(name, fn),
    appendEntry: (_type, data) => written.push(data),
    getCommands: () =>
      fixtures.map(([name, path]) => ({
        source: "skill",
        name: `skill:${name}`,
        path,
      })),
  });
  handlers.get("session_start")(
    {},
    {
      cwd: join(project, "src"),
      sessionManager: { getSessionFile: () => "origins" },
      getSystemPrompt: () => ["Native prompt"],
      agent: { kind: "main" },
    },
  );
  assert.deepEqual(
    written[0].skills.map((s) => [s.name, s.origin?.kind, s.origin?.label]),
    fixtures.map(([name, _path, kind, label]) => [name, kind, label]),
  );
});

test("source groups and used entries retain native provenance without crediting availability", () => {
  const prompt = snapshot();
  prompt.data.skills = [
    {
      name: "repo",
      path: "/project/.omp/skills/check/SKILL.md",
      scope: "repo",
      origin: {
        kind: "project",
        label: ".omp",
        root: "/project/.omp",
        basis: "project-root",
      },
    },
    {
      name: "shared",
      path: "/home/me/.agents/skills/check/SKILL.md",
      scope: "global",
      origin: {
        kind: "shared",
        label: ".agents",
        root: "/home/me/.agents/skills",
        basis: "user-root",
      },
    },
    {
      name: "omp",
      path: "/home/me/.omp/profiles/work/agent/skills/check/SKILL.md",
      scope: "global",
      origin: {
        kind: "omp",
        label: "OMP / profile",
        root: "/home/me/.omp",
        basis: "user-root",
      },
    },
    {
      name: "claude",
      path: "/home/me/.claude/skills/check/SKILL.md",
      scope: "global",
      origin: {
        kind: "other",
        label: "Claude",
        root: "/home/me/.claude",
        basis: "user-root",
      },
    },
  ];
  const unused = C.view(scan([prompt])).agents[0];
  assert.deepEqual(unused.skills, []);
  assert.deepEqual(
    unused.skillGroups.map((g) => [g.id, g.entries.map((s) => s.name)]),
    [
      ["project", ["repo"]],
      ["shared", ["shared"]],
      ["omp", ["omp"]],
      ["other", ["claude"]],
    ],
  );
  const used = C.view(
    scan([
      prompt,
      call("read", "prompt", "one", "skill://omp"),
      result("done", "read", "one"),
    ]),
  ).agents[0].skills[0];
  assert.equal(used.origin.kind, "omp");
  assert.equal(used.origin.badge, "OMP/profile");
  assert.equal(used.origin.root, "/home/me/.omp");
  assert.match(used.origin.explanation, /path/i);
});

test("configured OMP roots and project metadata outrank path resemblance", () => {
  const before = process.env.PI_CODING_AGENT_DIR;
  const customRoot = join(homedir(), "custom-omp-profile");
  process.env.PI_CODING_AGENT_DIR = customRoot;
  try {
    const handlers = new Map(),
      written = [];
    const fixtures = [
      {
        source: "skill",
        name: "skill:custom-profile",
        path: join(customRoot, "skills", "check", "SKILL.md"),
      },
      {
        source: "skill",
        name: "skill:project",
        location: "project",
        path: join(customRoot, "skills", "project", "SKILL.md"),
      },
      {
        source: "skill",
        name: "skill:not-shared",
        path: join(homedir(), ".agents-copy", "skills", "check", "SKILL.md"),
      },
      {
        source: "skill",
        name: "skill:user-not-project",
        location: "user",
        path: join(homedir(), "project", "custom", "SKILL.md"),
      },
    ];
    observer({
      on: (name, fn) => handlers.set(name, fn),
      appendEntry: (_type, data) => written.push(data),
      getCommands: () => fixtures,
    });
    handlers.get("session_start")(
      {},
      {
        cwd: join(homedir(), "project"),
        sessionManager: { getSessionFile: () => "origins" },
        getSystemPrompt: () => ["Native prompt"],
        agent: { kind: "main" },
      },
    );
    assert.deepEqual(
      written[0].skills.map((s) => s.origin.kind),
      ["omp", "project", "other", "other"],
    );
    assert.equal(written[0].skills[0].origin.root, customRoot);
    assert.equal(written[0].skills[0].origin.basis, "agent-dir");
  } finally {
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before;
  }
});

test("older catalogs and unknown sources stay visible without inventing OMP provenance", () => {
  const prompt = snapshot();
  prompt.data.skills = [
    {
      name: "unknown",
      path: "/somewhere/.omp/skills/check/SKILL.md",
      scope: "global",
    },
  ];
  const main = C.view(
    scan([
      prompt,
      call("read", "prompt", "one", "skill://unknown"),
      result("done", "read", "one"),
    ]),
  ).agents[0];
  assert.deepEqual(
    main.skillGroups.map((g) => g.id),
    ["other"],
  );
  assert.equal(main.skills[0].origin.badge, "Other");
  assert.match(main.skills[0].origin.explanation, /not.*record|did not record/);
});

test("a recorded invocation is not relabeled as a different current skill with the same name", () => {
  const prompt = snapshot();
  prompt.data.skills = [
    {
      name: "review",
      path: "/new/shared/review/SKILL.md",
      scope: "global",
      origin: { kind: "shared", label: ".agents", basis: "user-root" },
    },
  ];
  const used = C.view(
    scan([
      prompt,
      entry("invoke", "prompt", {
        type: "custom_message",
        customType: "skill-prompt",
        attribution: "user",
        details: { name: "review", path: "/prior/profile/review/SKILL.md" },
      }),
    ]),
  ).agents[0].skills[0];
  assert.equal(used.path, "/prior/profile/review/SKILL.md");
  assert.equal(used.origin.kind, "other");
});
