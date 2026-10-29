#!/usr/bin/env node
// Consumer-visible native task projection: no RPC, timers or renderer required.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
// eslint-disable-next-line no-new-func
new Function(
  "window",
  readFileSync(join(root, "src/app/background-tasks.js"), "utf8"),
)(win);
const B = win.OMP_BACKGROUND_TASKS;
let passed = 0;
function check(label, fn) {
  try {
    fn();
  } catch (error) {
    console.error(`FAILED: ${label}`);
    throw error;
  }
  passed++;
}
const start = (id, name, args = {}) => ({
  type: "tool_execution_start",
  toolCallId: id,
  toolName: name,
  args,
});
const update = (id, name, details, content = "") => ({
  type: "tool_execution_update",
  toolCallId: id,
  toolName: name,
  partialResult: { details, content: [{ type: "text", text: content }] },
});
const end = (id, name, details = {}, content = "") => ({
  type: "tool_execution_end",
  toolCallId: id,
  toolName: name,
  result: { details, content: [{ type: "text", text: content }] },
});
const life = (id, status, extra = {}) => ({
  type: "subagent_lifecycle",
  payload: {
    id,
    status,
    agent: "scout",
    index: 0,
    parentToolCallId: "task-1",
    ...extra,
  },
});
const progress = (id, status, extra = {}) => ({
  type: "subagent_progress",
  payload: {
    index: 0,
    agent: "scout",
    parentToolCallId: "task-1",
    detached: true,
    progress: { id, status, agent: "scout", durationMs: 2000, ...extra },
  },
});
const delivery = (...jobs) => ({
  type: "message_end",
  message: {
    role: "custom",
    customType: "async-result",
    timestamp: 5000,
    details: { jobs },
    content: "native delivery text",
  },
});
const marker = (id, type, state = "running") => ({
  async: { jobId: id, type, state },
});
const fold = (events, initial = B.empty(), now = 1000) =>
  events.reduce((s, f) => B.applyFrame(s, f, now), initial);
const item = (state, id) =>
  [...B.view(state).active, ...B.view(state).recent].find(
    (x) => x.jobId === id || x.agentId === id,
  );

check("empty state and isolated tabs", () => {
  const a = fold([start("c1", "bash", { command: "sleep 5" })]);
  const b = B.empty();
  assert.equal(B.view(a).active.length, 1);
  assert.equal(B.view(b).active.length, 0);
  assert.equal(B.view(a).backgroundActive.length, 0);
});
check("ask and unrelated tools are never counted as background work", () => {
  const s = fold([start("a", "ask"), start("b", "read")]);
  assert.deepEqual(B.view(s).active, []);
  assert.deepEqual(B.view(s).backgroundActive, []);
});
check(
  "foreground tool is visible before result but never retained as a background job",
  () => {
    let s = fold([start("c1", "bash", { command: "sleep 1" })]);
    assert.equal(B.view(s).active[0].background, false);
    s = fold([end("c1", "bash")], s, 2000);
    assert.equal(B.view(s).active.length, 0);
    assert.equal(B.view(s).recent.length, 0);
  },
);
check(
  "async bash promotes its foreground record and retains terminal output once",
  () => {
    let s = fold([
      start("c1", "bash", { command: "make test" }),
      end("c1", "bash", marker("bg_1", "bash"), "started"),
    ]);
    assert.equal(B.view(s).active.length, 1);
    assert.equal(item(s, "bg_1").toolCallId, "c1");
    assert.equal(item(s, "bg_1").label, "make test");
    assert.equal(B.view(s).backgroundActive.length, 1);
    s = fold(
      [
        update("c1", "bash", marker("bg_1", "bash", "failed"), "exit 2"),
        delivery({
          jobId: "bg_1",
          type: "bash",
          status: "failed",
          durationMs: 500,
        }),
      ],
      s,
      2000,
    );
    assert.equal(B.view(s).active.length, 0);
    assert.equal(B.view(s).recent.length, 1);
    assert.equal(item(s, "bg_1").status, "failed");
    assert.equal(item(s, "bg_1").durationMs, 500);
  },
);
check(
  "eval can background, stream output, complete and resist old replay",
  () => {
    let s = fold([
      start("e", "eval", { title: "analysis" }),
      end("e", "eval", marker("job-e", "eval")),
      update("e", "eval", marker("job-e", "eval"), "working"),
    ]);
    assert.equal(item(s, "job-e").output, "working");
    s = fold(
      [
        update("e", "eval", marker("job-e", "eval", "completed"), "done"),
        end("e", "eval", marker("job-e", "eval")),
      ],
      s,
      3000,
    );
    assert.equal(item(s, "job-e").status, "completed");
    assert.equal(B.view(s).recent.length, 1);
  },
);
check(
  "native cancellation is retained rather than inferred from process death",
  () => {
    let s = fold([
      start("e", "eval"),
      end("e", "eval", marker("j", "eval")),
      update("e", "eval", marker("j", "eval", "cancelled")),
    ]);
    assert.equal(item(s, "j").status, "cancelled");
    s = B.markDead(s, 5000);
    assert.equal(item(s, "j").status, "cancelled");
  },
);
check(
  "terminal observation cannot be downgraded by an older status-less delivery",
  () => {
    let s = fold([
      start("b", "bash"),
      end("b", "bash", marker("j", "bash")),
      update("b", "bash", marker("j", "bash", "completed")),
    ]);
    s = fold([delivery({ jobId: "j", type: "bash" })], s);
    assert.equal(item(s, "j").status, "completed");
  },
);
check(
  "subagents are active at lifecycle start and coalesce with task job delivery",
  () => {
    let s = fold(
      [
        start("task-1", "task"),
        life("Alpha", "started", { detached: true }),
        progress("Alpha", "running", {
          lastIntent: "Inspect files",
          recentOutput: ["searching"],
        }),
      ],
      undefined,
      10000,
    );
    assert.equal(B.view(s).active.length, 1); // The task-call placeholder is hidden.
    assert.equal(item(s, "Alpha").startedAt, 8000);
    assert.equal(item(s, "Alpha").detail, "Inspect files");
    assert.equal(item(s, "Alpha").output, "searching");
    s = fold(
      [
        life("Alpha", "completed", { detached: true }),
        delivery({
          jobId: "Alpha",
          agentId: "Alpha",
          type: "task",
          status: "completed",
          label: "Inspect files",
        }),
      ],
      s,
      12000,
    );
    assert.equal(B.view(s).recent.length, 1);
    assert.equal(item(s, "Alpha").status, "completed");
  },
);
check(
  "batch async aggregate failure is not copied onto the primary agent",
  () => {
    const task = {
      ...marker("A", "task", "failed"),
      progress: [
        { id: "A", status: "completed", agent: "scout" },
        { id: "B", status: "failed", agent: "scout" },
      ],
    };
    let s = fold([
      life("A", "started", { detached: true }),
      life("B", "started", { detached: true }),
      life("A", "completed", { detached: true }),
      life("B", "failed", { detached: true }),
      end("task-1", "task", task),
    ]);
    assert.equal(item(s, "A").status, "completed");
    assert.equal(item(s, "B").status, "failed");
    assert.equal(B.view(s).recent.length, 2);
  },
);
check(
  "unknown detached flag never claims foreground or background classification",
  () => {
    const s = fold([life("A", "started")]);
    assert.equal(item(s, "A").background, null);
    assert.equal(B.view(s).backgroundActive.length, 1);
  },
);
check("task identity uses agentId when native job id differs", () => {
  let s = fold([life("A", "started", { detached: true })]);
  s = fold(
    [
      delivery({
        jobId: "A-2",
        agentId: "A",
        type: "task",
        status: "completed",
      }),
    ],
    s,
  );
  assert.equal(B.view(s).recent.length, 1);
  assert.equal(item(s, "A").jobId, "A-2");
});
check(
  "different parent tool calls cannot overwrite each other's subagent",
  () => {
    const s = fold([
      life("A", "started", { parentToolCallId: "one" }),
      life("A", "started", { parentToolCallId: "two" }),
      life("A", "failed", { parentToolCallId: "one" }),
    ]);
    assert.equal(B.view(s).active.length, 1);
    assert.equal(B.view(s).recent.length, 1);
    assert.equal(B.view(s).active[0].toolCallId, "two");
    assert.equal(B.view(s).recent[0].toolCallId, "one");
  },
);
check(
  "journal sequence distinguishes replay from a new turn reusing an agent id",
  () => {
    let s = B.applyFrame(
      B.empty(),
      life("A", "started", { detached: true }),
      1000,
      1,
    );
    s = B.applyFrame(s, life("A", "completed", { detached: true }), 2000, 2);
    s = B.applyFrame(s, life("A", "started", { detached: true }), 3000, 1);
    assert.equal(B.view(s).active.length, 0);
    s = B.applyFrame(s, life("A", "started", { detached: true }), 4000, 3);
    assert.equal(B.view(s).active.length, 1);
    assert.equal(B.view(s).recent.length, 1);
    assert.equal(B.view(s).recent[0].status, "completed");
    s = B.applyFrame(
      s,
      delivery({ jobId: "A", agentId: "A", type: "task", status: "failed" }),
      5000,
      4,
    );
    assert.equal(B.view(s).active.length, 0);
    assert.deepEqual(
      B.view(s).recent.map((x) => x.status),
      ["failed", "completed"],
    );
  },
);
check(
  "a current subagent snapshot can establish a new run after a terminal one",
  () => {
    let s = fold([life("A", "started"), life("A", "completed")]);
    s = B.mergeSubagents(
      s,
      [
        {
          id: "A",
          agent: "scout",
          status: "running",
          parentToolCallId: "task-1",
          lastUpdate: 6000,
          progress: { durationMs: 1000 },
        },
      ],
      6000,
    );
    assert.equal(B.view(s).active.length, 1);
    assert.equal(B.view(s).recent.length, 1);
    assert.equal(B.view(s).recent[0].status, "completed");
  },
);
check(
  "wait progress exposes exactly native watched jobs and clears after wait",
  () => {
    let s = fold(
      [
        start("w", "wait"),
        update("w", "wait", {
          op: "wait",
          jobs: [
            {
              id: "bg_3",
              type: "bash",
              status: "running",
              label: "sleep",
              durationMs: 700,
            },
          ],
        }),
      ],
      undefined,
      2000,
    );
    assert.deepEqual(B.view(s).waiting.jobIds, ["bg_3"]);
    assert.equal(item(s, "bg_3").waitedFor, true);
    assert.equal(item(s, "bg_3").startedAt, 1300);
    s = fold([end("w", "wait")], s);
    assert.equal(B.view(s).waiting, null);
    assert.equal(item(s, "bg_3").waitedFor, false);
  },
);
check(
  "unknown pending aggregate has no invented jobs and settlement does not claim job outcomes",
  () => {
    let s = B.setPending(B.empty(), true);
    assert.equal(B.view(s).pendingUnknown, true);
    assert.equal(B.view(s).active.length, 0);
    s = fold(
      [
        start("b", "bash"),
        end("b", "bash", marker("j", "bash")),
        { type: "session_settled" },
      ],
      s,
    );
    assert.equal(B.view(s).pendingUnknown, false);
    assert.equal(item(s, "j").status, "running");
  },
);
check(
  "process death gives unknown outcomes and preserves completed history",
  () => {
    let s = fold([
      start("b", "bash"),
      end("b", "bash", marker("j", "bash")),
      life("A", "started"),
      start("e", "eval"),
      life("B", "failed"),
    ]);
    s = B.markDead(s, 6000);
    assert.equal(B.view(s).active.length, 0);
    assert.equal(item(s, "j").status, "unknown");
    assert.equal(item(s, "A").status, "unknown");
    assert.equal(item(s, "B").status, "failed");
    assert.equal(B.view(s).recent.length, 3);
  },
);
check(
  "running subagent snapshot can recover unknown and missing agents become unknown",
  () => {
    let s = fold([life("A", "started"), life("B", "started")]);
    s = B.mergeSubagents(
      s,
      [
        {
          id: "A",
          agent: "scout",
          status: "running",
          parentToolCallId: "task-1",
          lastUpdate: 5000,
          progress: { durationMs: 2000 },
        },
      ],
      6000,
    );
    assert.equal(item(s, "A").status, "running");
    assert.equal(item(s, "B").status, "unknown");
    s = B.mergeSubagents(
      s,
      [
        {
          id: "B",
          agent: "scout",
          status: "running",
          parentToolCallId: "task-1",
          lastUpdate: 7000,
          progress: { durationMs: 1000 },
        },
      ],
      7000,
    );
    assert.equal(item(s, "B").status, "running");
    assert.equal(item(s, "A").status, "unknown");
  },
);
check("persisted running result is never treated as currently live", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "b",
          name: "bash",
          arguments: { command: "sleep 4" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "b",
      toolName: "bash",
      timestamp: 1000,
      details: marker("bg_1", "bash"),
      content: [],
    },
  ];
  const s = B.mergeMessages(B.empty(), messages, 9000);
  assert.equal(B.view(s).active.length, 0);
  assert.equal(item(s, "bg_1").status, "unknown");
  assert.equal(item(s, "bg_1").label, "sleep 4");
});
check(
  "persisted delivery reconstructs terminal history without parsing its text",
  () => {
    const messages = [
      {
        role: "toolResult",
        toolCallId: "b",
        toolName: "bash",
        timestamp: 1000,
        details: marker("bg_1", "bash"),
      },
      {
        role: "custom",
        customType: "async-result",
        timestamp: 3000,
        details: {
          jobs: [
            {
              jobId: "bg_1",
              type: "bash",
              status: "cancelled",
              durationMs: 2000,
            },
            { jobId: "bg_2", type: "eval", label: "other" },
          ],
        },
        content: "both completed",
      },
    ];
    const s = B.mergeMessages(B.empty(), messages, 9000);
    assert.equal(B.view(s).active.length, 0);
    assert.equal(item(s, "bg_1").status, "cancelled");
    assert.equal(item(s, "bg_2").status, "unknown");
    assert.equal(B.view(s).recent.length, 2);
  },
);
check(
  "history replay does not demote a current live event or duplicate it",
  () => {
    let s = fold([start("b", "bash"), end("b", "bash", marker("j", "bash"))]);
    const message = {
      role: "toolResult",
      toolCallId: "b",
      toolName: "bash",
      details: marker("j", "bash"),
    };
    s = B.mergeMessages(s, [message, message], 5000);
    assert.equal(item(s, "j").status, "running");
    assert.equal(B.view(s).active.length, 1);
  },
);
check("terminal history is bounded while active entries survive", () => {
  let s = fold([
    start("live", "bash"),
    end("live", "bash", marker("still-live", "bash")),
  ]);
  for (let i = 0; i < 50; i++)
    s = fold(
      [delivery({ jobId: `done-${i}`, type: "bash", status: "completed" })],
      s,
    );
  assert.equal(B.view(s).recent.length, 30);
  assert.equal(item(s, "still-live").status, "running");
  assert.equal(item(s, "done-0"), undefined);
  assert.equal(item(s, "done-49").status, "completed");
});
check("recent order follows completion, not start order", () => {
  let s = fold([life("A", "started"), life("B", "started")], undefined, 1000);
  s = fold([life("B", "completed")], s, 2000);
  s = fold([life("A", "completed")], s, 3000);
  assert.deepEqual(
    B.view(s).recent.map((x) => x.agentId),
    ["A", "B"],
  );
});
check("states are immutable and hostile identifiers are ordinary keys", () => {
  const before = B.empty();
  const after = fold([life("__proto__", "started")], before);
  assert.deepEqual(before, B.empty());
  assert.equal(item(after, "__proto__").status, "running");
});
check(
  "native snapshot recovers running jobs across a replay gap and preserves tool links",
  () => {
    let state = B.mergeMessages(B.empty(), [
      {
        role: "toolResult",
        toolCallId: "call",
        toolName: "bash",
        details: marker("native-job", "bash"),
      },
    ]);
    assert.equal(item(state, "native-job").status, "unknown");
    const snapshot = {
      supported: true,
      complete: true,
      epoch: "process-a",
      sessionId: "session-a",
      running: [
        { id: "native-job", type: "bash", status: "running", startTime: 1000 },
      ],
      recent: [],
    };
    state = B.mergeSnapshot(state, snapshot, 3000);
    assert.equal(item(state, "native-job").status, "running");
    assert.equal(item(state, "native-job").toolCallId, "call");
    state = B.mergeSnapshot(
      state,
      {
        ...snapshot,
        running: [],
        recent: [
          { ...snapshot.running[0], status: "completed", endTime: 4000 },
        ],
      },
      5000,
    );
    assert.equal(B.view(state).active.length, 0);
    assert.equal(item(state, "native-job").status, "completed");
    assert.equal(item(state, "native-job").durationMs, 3000);
    state = B.mergeSnapshot(state, snapshot, 6000);
    assert.equal(item(state, "native-job").status, "completed");
    assert.equal(item(state, "native-job").endedAt, 4000);
    assert.equal(item(state, "native-job").durationMs, 3000);
  },
);
check("partial or unavailable snapshots cannot retire known live jobs", () => {
  const original = fold([
    start("c", "bash"),
    end("c", "bash", marker("j", "bash")),
  ]);
  const snapshot = {
    supported: true,
    complete: false,
    epoch: "e",
    sessionId: "s",
    running: [],
    recent: [],
  };
  assert.equal(
    item(B.mergeSnapshot(original, snapshot), "j").status,
    "running",
  );
  assert.equal(
    item(B.mergeSnapshot(original, { supported: false }), "j").status,
    "running",
  );
  assert.equal(
    item(B.mergeSnapshot(original, { ...snapshot, complete: true }), "j")
      .status,
    "unknown",
  );
});
check(
  "a replacement process does not inherit the previous process's task history",
  () => {
    const snapshot = {
      supported: true,
      complete: true,
      epoch: "one",
      sessionId: "s",
      running: [{ id: "j", type: "eval", status: "running", startTime: 1 }],
      recent: [],
    };
    const original = B.mergeSnapshot(B.empty(), snapshot);
    const replaced = B.mergeSnapshot(original, {
      ...snapshot,
      epoch: "two",
      running: [],
    });
    assert.equal(item(replaced, "j"), undefined);
    assert.equal(item(original, "j").status, "running");
  },
);
console.log(`background-tasks: ${passed} checks passed`);
