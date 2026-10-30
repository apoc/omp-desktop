#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

await import("../src/app/evidence-model.js");
const M = globalThis.OMP_EVIDENCE_MODEL;
const { createEvidenceRuntime } = await import(
  "../src-tauri/src/agent/evidence-runtime.mjs"
);
const FP = (head = "abc", dirtyDigest = null, complete = true) => ({
  head,
  dirtyDigest,
  complete,
  reason: null,
  environment: {},
});
const HOST = "OMP_DESKTOP_EVIDENCE_REQUEST:";
const PREFIX = "OMP_DESKTOP_EVIDENCE:";

async function harness(options = {}) {
  const inbox = await mkdtemp(join(tmpdir(), "evidence-inbox-"));
  const bootstrap = {
    version: 1,
    policy: options.policy || M.initial().policy,
    inbox,
    environment: {},
  };
  let branch = [],
    sessionId = "session-a",
    file = "/session-a.jsonl",
    failFlush = options.failInitialFlush || 0,
    hostFn;
  const calls = [],
    notifications = [];
  const manager = {
    getSessionId: () => sessionId,
    getSessionFile: () => file,
    getBranch: () => branch,
    ensureOnDisk: async () => {},
    flush: async () => {
      if (failFlush) {
        failFlush--;
        throw new Error("injected disk failure");
      }
    },
  };
  const api = {
    appendEntry: (customType, data) =>
      branch.push({ type: "custom", customType, data: structuredClone(data) }),
  };
  const ctx = {
    cwd: inbox,
    agent: { kind: "main" },
    sessionManager: manager,
    ui: {
      notify: (message) => {
        if (message.startsWith(PREFIX))
          notifications.push(JSON.parse(message.slice(PREFIX.length)));
      },
      input: async (title) => {
        assert.ok(title.startsWith(HOST));
        const request = JSON.parse(title.slice(HOST.length));
        calls.push(request);
        if (hostFn) return hostFn(request);
        let value;
        if (request.op === "fingerprint") value = FP();
        else if (request.op === "defaults")
          value = { policy: bootstrap.policy, revision: 1 };
        else if (request.op === "ci")
          value = {
            state: "unknown",
            sourceSha: null,
            reason: "No CI",
            limitations: "No CI checks",
            snapshot: null,
          };
        else if (request.op === "import") {
          const bytes = await readFile(join(inbox, request.args.filename));
          value = {
            id: "asset",
            name: request.args.name,
            mime: "text/plain",
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            owner: sessionId,
          };
        } else throw new Error("Unexpected host request");
        return JSON.stringify({ ok: true, value });
      },
    },
  };
  const runtime = createEvidenceRuntime(api, {
    epoch: "test-epoch",
    profileId: "work",
    bootstrap: options.noHost ? null : bootstrap,
    timeout: options.timeout || 50,
  });
  await runtime.lifecycle(ctx);
  let sequence = 0;
  const latest = () => notifications.filter((item) => item.view).at(-1)?.view;
  async function call(op, fields = {}, withRevision = true) {
    const id = `request-${++sequence}`;
    const current = latest();
    await runtime.privateCommand(
      JSON.stringify({
        id,
        op,
        profileId: "work",
        ...(withRevision
          ? {
              revision: current.revision,
              sessionId: current.sessionId,
              file: current.file,
              branchToken: current.branchToken,
            }
          : {}),
        ...fields,
      }),
      ctx,
    );
    const response = notifications.findLast((item) => item.id === id);
    assert.ok(response, `missing response to ${op}`);
    return response;
  }
  async function change(op, fields = {}) {
    const response = await call(op, fields);
    assert.equal(response.error, undefined, response.error);
    return response.view;
  }
  async function criterion() {
    let v = await change("outcome", {
      outcome: { title: "Outcome", description: "Expected result" },
    });
    const outcomeId = v.outcomes[0].id;
    v = await change("requirement", {
      outcomeId,
      requirement: { text: "Run the test", kind: "test", required: true },
    });
    return { outcomeId, requirementId: v.outcomes[0].requirements[0].id };
  }
  async function reopen(policy) {
    const next = createEvidenceRuntime(api, {
      epoch: "restart-epoch",
      profileId: "work",
      bootstrap: { ...bootstrap, policy },
      timeout: options.timeout || 50,
    });
    await next.lifecycle(ctx, { type: "session_start" });
    return next;
  }
  return {
    runtime,
    ctx,
    calls,
    notifications,
    bootstrap,
    inbox,
    call,
    change,
    criterion,
    reopen,
    get view() {
      return latest();
    },
    get branch() {
      return branch;
    },
    set branch(value) {
      branch = value;
    },
    setHost(fn) {
      hostFn = fn;
    },
    failFlush(count = 1) {
      failFlush = count;
    },
    switch(id, nextFile, nextBranch) {
      sessionId = id;
      file = nextFile;
      branch = nextBranch;
    },
    cleanup: () => rm(inbox, { recursive: true, force: true }),
  };
}

test("user-owned criteria, reviews and waivers remain user decisions", async () => {
  const h = await harness();
  try {
    const ids = await h.criterion();
    await assert.rejects(
      h.runtime.agentOperation(h.ctx, {
        op: "requirement",
        ...ids,
        requirement: {
          id: ids.requirementId,
          text: "weakened",
          kind: "any",
          required: false,
        },
      }),
      /user-owned/,
    );
    await assert.rejects(
      h.runtime.agentOperation(h.ctx, { op: "waive", ...ids, reason: "skip" }),
      /cannot perform/,
    );
    await assert.rejects(
      h.runtime.agentOperation(h.ctx, { op: "tracking", enabled: false }),
      /cannot perform/,
    );
    let view = await h.change("record", {
      ...ids,
      record: {
        title: "Failure",
        kind: "test",
        result: "failed",
        summary: "assertion failed",
      },
    });
    const failure = view.records[0].id;
    view = await h.change("record", {
      ...ids,
      record: {
        title: "Later run",
        kind: "test",
        result: "passed",
        summary: "passed",
      },
    });
    assert.equal(view.summary.failed, 1);
    view = await h.change("review", {
      recordId: failure,
      decision: "rejected",
      reason: "wrong target",
    });
    assert.equal(view.records[0].review.decision, "rejected");
    view = await h.change("waive", { ...ids, reason: "not applicable" });
    assert.equal(view.summary.waived, 1);
    assert.equal(view.outcomes[0].requirements[0].waiver.actor, "user");
    assert.equal(
      (
        await h.call("tracking", { enabled: false, revision: 0 })
      ).error.includes("changed"),
      true,
    );
    assert.equal(h.view.tracking, true);
  } finally {
    await h.cleanup();
  }
});

test("agent claims remain attributed and cannot change human review", async () => {
  const h = await harness();
  try {
    const ids = await h.criterion();
    await h.runtime.agentOperation(h.ctx, {
      op: "record",
      ...ids,
      record: {
        title: "Agent report",
        kind: "test",
        result: "passed",
        summary: "Agent interpreted output",
      },
    });
    let view = h.view;
    const record = view.records[0];
    assert.equal(record.source.type, "agent");
    assert.equal(record.review.decision, "unreviewed");
    assert.match(M.recordStatus(view, record).reason, /agent.*interpretation/i);
    await assert.rejects(
      h.runtime.agentOperation(h.ctx, {
        op: "review",
        recordId: record.id,
        decision: "accepted",
      }),
      /cannot perform/i,
    );
    view = await h.change("review", {
      recordId: record.id,
      decision: "accepted",
      reason: "I inspected it",
    });
    await assert.rejects(
      h.runtime.agentOperation(h.ctx, {
        op: "review",
        recordId: record.id,
        decision: "rejected",
        reason: "override",
      }),
      /cannot perform/i,
    );
    assert.equal(h.view.records[0].review.decision, "accepted");
    assert.equal(view.records[0].source.type, "agent");
  } finally {
    await h.cleanup();
  }
});

test("user adoption of unchanged agent proposals preserves authorship and prevents later weakening", async () => {
  const h = await harness();
  try {
    const outcomeReport = await h.runtime.agentOperation(h.ctx, {
      op: "outcome",
      outcome: { title: "Agent proposal", description: "Scope", todoRefs: [] },
    });
    const outcome = h.view.outcomes[0];
    assert.match(outcomeReport, new RegExp(outcome.id));
    const requirementReport = await h.runtime.agentOperation(h.ctx, {
      op: "requirement",
      outcomeId: outcome.id,
      requirement: { text: "Verify behavior", kind: "test", required: true },
    });
    const requirement = h.view.outcomes[0].requirements[0];
    assert.match(requirementReport, new RegExp(requirement.id));
    let view = await h.change("outcome", {
      outcome: {
        id: outcome.id,
        title: outcome.title,
        description: outcome.description,
        todoRefs: outcome.todoRefs,
      },
    });
    view = await h.change("requirement", {
      outcomeId: outcome.id,
      requirement: {
        id: requirement.id,
        text: requirement.text,
        kind: requirement.kind,
        required: requirement.required,
      },
    });
    assert.equal(view.outcomes[0].author, "agent");
    assert.equal(view.outcomes[0].owner, "user");
    assert.equal(view.outcomes[0].requirements[0].author, "agent");
    assert.equal(view.outcomes[0].requirements[0].owner, "user");
    assert.equal(
      view.outcomes[0].requirements[0].revision,
      1,
      "unchanged criterion semantics retain their revision",
    );
    await assert.rejects(
      h.runtime.agentOperation(h.ctx, {
        op: "outcome",
        outcome: { id: outcome.id, title: "Changed" },
      }),
      /user-owned/,
    );
    await assert.rejects(
      h.runtime.agentOperation(h.ctx, {
        op: "requirement",
        outcomeId: outcome.id,
        requirement: {
          id: requirement.id,
          text: "Weakened",
          kind: "any",
          required: false,
        },
      }),
      /user-owned/,
    );
    const report = await h.runtime.agentOperation(h.ctx, {
      op: "view",
      outcomeId: outcome.id,
      requirementId: requirement.id,
    });
    assert.match(report, /author agent; owner user/);
    const resumed = await h.reopen(M.initial().policy);
    assert.equal(h.view.outcomes[0].requirements[0].owner, "user");
    await assert.rejects(
      resumed.agentOperation(h.ctx, {
        op: "requirement",
        outcomeId: outcome.id,
        requirement: {
          id: requirement.id,
          text: "Weakened after resume",
          kind: "any",
          required: false,
        },
      }),
      /user-owned/,
    );
  } finally {
    await h.cleanup();
  }
});

test("model views expose stable IDs and isolate large outcome, request, record and receipt scopes", async () => {
  const h = await harness();
  try {
    let lastOutcome, lastRequirement, lastRecord;
    for (let i = 0; i < 8; i++) {
      const created = await h.runtime.agentOperation(h.ctx, {
        op: "outcome",
        outcome: { title: `Outcome ${i}`, description: "d".repeat(1800) },
      });
      lastOutcome = h.view.outcomes.at(-1).id;
      assert.ok(created.includes(lastOutcome));
      const added = await h.runtime.agentOperation(h.ctx, {
        op: "requirement",
        outcomeId: lastOutcome,
        requirement: { text: `Criterion ${i}`, kind: "test", required: true },
      });
      lastRequirement = h.view.outcomes.at(-1).requirements[0].id;
      assert.ok(added.includes(lastRequirement));
      const saved = await h.runtime.agentOperation(h.ctx, {
        op: "record",
        outcomeId: lastOutcome,
        requirementId: lastRequirement,
        record: {
          title: `Record ${i}`,
          kind: "test",
          result: "observed",
          summary: "s".repeat(1500),
        },
      });
      lastRecord = h.view.records.at(-1).id;
      assert.ok(saved.includes(lastRecord));
    }
    const text = `Please inspect ${"precise evidence ".repeat(100)}`;
    await h.change("request", {
      outcomeId: lastOutcome,
      requirementId: lastRequirement,
      newRequestId: "request-long",
      text,
    });
    await h.runtime.toolResult(
      {
        toolName: "bash",
        toolCallId: "receipt-call",
        input: { command: "npm test" },
        content: [{ type: "text", text: "output" }],
        isError: false,
      },
      h.ctx,
    );
    const receiptId = h.view.receipts.at(-1).id;
    const index = await h.runtime.agentOperation(h.ctx, { op: "view" });
    assert.ok(
      index.includes(lastOutcome),
      "later outcomes remain addressable even when the report is truncated",
    );
    assert.ok(index.includes(receiptId), "receipt ids remain addressable");
    const outcome = await h.runtime.agentOperation(h.ctx, {
      op: "view",
      outcomeId: lastOutcome,
    });
    assert.ok(outcome.includes(lastRequirement));
    assert.ok(outcome.includes(lastRecord));
    assert.doesNotMatch(outcome, /Outcome 0/);
    const request = await h.runtime.agentOperation(h.ctx, {
      op: "view",
      requestId: "request-long",
      outcomeId: lastOutcome,
      requirementId: lastRequirement,
    });
    assert.ok(
      request.includes(
        h.view.requests.find((item) => item.id === "request-long").text,
      ),
    );
    assert.ok(request.includes("request-long"));
    const record = await h.runtime.agentOperation(h.ctx, {
      op: "view",
      recordId: lastRecord,
    });
    assert.ok(record.includes(lastRecord));
    assert.ok(record.includes("s".repeat(1500)));
    const receipt = await h.runtime.agentOperation(h.ctx, {
      op: "view",
      receiptId,
    });
    assert.ok(receipt.includes(receiptId));
    assert.ok(receipt.includes("npm test"));
    await assert.rejects(
      h.runtime.agentOperation(h.ctx, { op: "view", requestId: "missing" }),
      /not found/,
    );
  } finally {
    await h.cleanup();
  }
});

test("execution receipts are facts, not semantic passes, and before/after state is preserved", async () => {
  const h = await harness();
  try {
    const ids = await h.criterion();
    let fingerprint = FP();
    h.setHost(async (req) =>
      JSON.stringify({
        ok: true,
        value: req.op === "fingerprint" ? fingerprint : null,
      }),
    );
    await h.runtime.toolBefore(
      {
        toolName: "bash",
        toolCallId: "call-1",
        input: { command: "npm test" },
      },
      h.ctx,
    );
    fingerprint = FP("abc", "modified");
    const guidance = await h.runtime.toolResult(
      {
        toolName: "bash",
        toolCallId: "call-1",
        input: { command: "npm test" },
        content: [{ type: "text", text: "FAILED" }],
        details: { exitCode: 2 },
        isError: true,
      },
      h.ctx,
    );
    assert.match(guidance.additionalContext, /stale/);
    assert.equal(h.view.records.length, 0);
    const receipt = h.view.receipts[0];
    assert.equal(receipt.exitCode, 2);
    assert.equal(receipt.beforeFingerprint.dirtyDigest, null);
    assert.equal(receipt.fingerprint.dirtyDigest, "modified");
    const rejected = await h.call("record", {
      ...ids,
      record: {
        title: "Claim",
        kind: "test",
        result: "passed",
        summary: "passed",
        receiptId: receipt.id,
      },
    });
    assert.match(rejected.error, /failed execution receipt/);
    let view = await h.change("record", {
      ...ids,
      record: {
        title: "Failure",
        kind: "test",
        result: "failed",
        summary: "assertion failed",
        receiptId: receipt.id,
      },
    });
    assert.equal(view.records[0].source.toolCallId, "call-1");
    assert.equal(view.records[0].beforeFingerprint.dirtyDigest, null);
    view = await h.change("tracking", { enabled: false });
    const count = h.calls.length;
    await h.runtime.toolBefore({ toolCallId: "off", toolName: "bash" }, h.ctx);
    await h.runtime.toolResult(
      { toolCallId: "off", toolName: "bash", content: [], isError: false },
      h.ctx,
    );
    await h.call("get", {}, false);
    assert.equal(h.calls.length, count);
    assert.equal(h.view.receipts.length, 1);
    assert.match((await h.call("capture_ci", ids)).error, /collection is off/i);
    await h.change("outcome", {
      outcome: { title: "Manual edit remains possible" },
    });
  } finally {
    await h.cleanup();
  }
});

test("incomplete tool events are not reported as success and previews declare truncation", async () => {
  const h = await harness();
  try {
    await h.runtime.toolResult(
      { toolName: "bash", toolCallId: "unknown", content: [] },
      h.ctx,
    );
    assert.equal(h.view.receipts.length, 0);
    assert.ok(h.view.warnings.some((warning) => /error status/.test(warning)));
    await h.runtime.toolResult(
      {
        toolName: "bash",
        toolCallId: "large",
        input: { command: "x".repeat(3000) },
        content: [{ type: "text", text: "y".repeat(3000) }],
        isError: false,
      },
      h.ctx,
    );
    const receipt = h.view.receipts[0];
    assert.equal(receipt.exitCode, null);
    assert.equal(receipt.truncated, true);
    assert.match(receipt.command, /command truncated/);
    assert.equal(receipt.preview.length, 2000);
  } finally {
    await h.cleanup();
  }
});

test("host failure, unknown freshness and CI gaps are explicit; staged bytes use only the inbox", async () => {
  const h = await harness({ timeout: 15 });
  try {
    const ids = await h.criterion();
    h.setHost(async () => new Promise(() => {}));
    let view = (await h.call("get", {}, false)).view;
    assert.equal(view.currentFingerprint, null);
    assert.ok(view.warnings.some((warning) => /timed out/.test(warning)));
    h.setHost(async (req) =>
      JSON.stringify({ ok: false, error: `${req.op} unavailable` }),
    );
    view = await h.change("capture_ci", ids);
    assert.equal(view.records[0].result, "blocked");
    assert.match(view.records[0].reason, /unavailable/);
    h.setHost(null);
    await writeFile(join(h.inbox, "sample.txt"), "inspectable content");
    await h.runtime.agentOperation(h.ctx, {
      op: "record",
      ...ids,
      record: {
        title: "File",
        kind: "test",
        result: "observed",
        summary: "Captured file",
        path: "sample.txt",
      },
    });
    const imported = h.view.records.at(-1);
    assert.equal(imported.artifact.owner, "session-a");
    assert.equal(imported.artifact.bytes, 19);
    const input = h.calls.findLast((call) => call.op === "import");
    assert.equal(input.epoch, "test-epoch");
    assert.equal(input.file, "/session-a.jsonl");
    assert.equal(input.sessionId, "session-a");
    assert.equal(input.args.filename.includes("/"), false);
    assert.notEqual(input.args.filename, "sample.txt");
  } finally {
    await h.cleanup();
  }
});

test("CI source commit does not claim verification of a dirty worktree", async () => {
  const h = await harness();
  try {
    let view = await h.change("outcome", { outcome: { title: "CI" } });
    const outcomeId = view.outcomes[0].id;
    view = await h.change("requirement", {
      outcomeId,
      requirement: { text: "CI", kind: "ci", required: true },
    });
    const requirementId = view.outcomes[0].requirements[0].id;
    h.setHost(async (req) =>
      JSON.stringify({
        ok: true,
        value:
          req.op === "fingerprint"
            ? FP("abc", "local-dirty")
            : {
                state: "success",
                sourceSha: "abc",
                reason: null,
                limitations: "CI covers the commit only",
                snapshot: { truncated: true },
              },
      }),
    );
    view = await h.change("capture_ci", { outcomeId, requirementId });
    assert.equal(view.records[0].result, "passed");
    assert.equal(view.records[0].source.type, "ci");
    assert.equal(view.summary.stale, 1);
    assert.match(view.records[0].limitations, /commit only/);
    assert.match(view.records[0].limitations, /snapshot is truncated/i);
  } finally {
    await h.cleanup();
  }
});

test("persistence failures repair the branch and branch switches restore independent state and sequence", async () => {
  const h = await harness();
  try {
    let view = await h.change("outcome", { outcome: { title: "Durable" } });
    const originalRevision = view.revision;
    const sequence = view.sequence;
    const branchToken = view.branchToken;
    h.failFlush();
    const failed = await h.call("outcome", {
      outcome: { title: "Not committed" },
    });
    assert.match(failed.error, /persist.*injected disk failure/i);
    assert.equal(h.view.revision, originalRevision);
    assert.equal(h.branch.at(-1).data.view.outcomes.length, 1);
    const saved = structuredClone(h.branch);
    h.switch("other", "/other.jsonl", []);
    await h.runtime.lifecycle(h.ctx);
    assert.equal(h.view.outcomes.length, 0);
    assert.ok(h.view.sequence > sequence);
    assert.notEqual(h.view.branchToken, branchToken);
    h.switch("fork", "/fork.jsonl", saved);
    await h.runtime.lifecycle(h.ctx);
    assert.equal(h.view.outcomes[0].title, "Durable");
    assert.equal(h.view.sessionId, "fork");
    assert.ok(h.view.sequence > sequence);
  } finally {
    await h.cleanup();
  }
});

test("an in-flight host request cannot commit after switching branches", async () => {
  const h = await harness();
  try {
    const ids = await h.criterion();
    let entered, release;
    const enteredHost = new Promise((resolve) => {
      entered = resolve;
    });
    h.setHost(
      () =>
        new Promise((resolve) => {
          release = () => resolve(JSON.stringify({ ok: true, value: FP() }));
          entered();
        }),
    );
    const pending = h.call("record", {
      ...ids,
      record: { title: "Racy", kind: "test", result: "observed", summary: "x" },
    });
    await enteredHost;
    h.switch("session-b", "/session-b.jsonl", []);
    const switching = h.runtime.lifecycle(h.ctx);
    release();
    assert.match((await pending).error, /changed/i);
    await switching;
    assert.equal(h.view.sessionId, "session-b");
    assert.equal(h.view.records.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("queued edits cannot cross a same-session branch switch even at the same revision", async () => {
  const h = await harness();
  try {
    const previous = h.view;
    h.switch(previous.sessionId, previous.file, []);
    await h.runtime.lifecycle(h.ctx);
    assert.equal(h.view.revision, previous.revision);
    const response = await h.call("outcome", {
      revision: previous.revision,
      sessionId: previous.sessionId,
      file: previous.file,
      branchToken: previous.branchToken,
      outcome: { title: "wrong branch" },
    });
    assert.match(response.error, /branch changed/i);
    assert.equal(h.view.outcomes.length, 0);
    assert.equal(
      h.branch.length,
      1,
      "only the initial policy pin was persisted",
    );
    assert.equal(h.branch[0].data.view.outcomes.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("handoff continuation is opt-in, bounded and disabled for blocked-only work", async () => {
  const h = await harness();
  try {
    const ids = await h.criterion();
    const policy = structuredClone(h.bootstrap.policy);
    policy.preset.handoff = "remind";
    policy.preset.revision = 2;
    await h.change("policy", { policy, selection: "conversation" });
    const event = { turn_id: 1, stop_hook_active: false };
    assert.equal(h.runtime.stop(event, h.ctx).continue, true);
    assert.equal(h.runtime.stop(event, h.ctx), undefined);
    await h.change("record", {
      ...ids,
      record: {
        title: "Blocked",
        kind: "test",
        result: "blocked",
        summary: "service unavailable",
      },
    });
    assert.equal(
      h.runtime.stop({ turn_id: 2, stop_hook_active: false }, h.ctx),
      undefined,
    );
    await h.change("tracking", { enabled: false });
    assert.equal(h.runtime.guidance(h.ctx, { systemPrompt: [] }), undefined);
    assert.equal(
      h.runtime.stop({ turn_id: 3, stop_hook_active: false }, h.ctx),
      undefined,
    );
  } finally {
    await h.cleanup();
  }
});

test("stable request ids edit without duplicating requests", async () => {
  const h = await harness();
  try {
    const ids = await h.criterion();
    let view = await h.change("request", {
      ...ids,
      newRequestId: "request-fixed",
      text: "Show a run",
    });
    assert.equal(view.requests[0].id, "request-fixed");
    view = await h.change("request", {
      ...ids,
      requestId: "request-fixed",
      text: "Show the changed run",
    });
    assert.equal(view.requests.length, 1);
    assert.equal(view.requests[0].text, "Show the changed run");
    assert.match(
      (
        await h.call("request", {
          ...ids,
          newRequestId: "request-fixed",
          text: "duplicate",
        })
      ).error,
      /already exists/,
    );
  } finally {
    await h.cleanup();
  }
});

test("preset revisions are pinned and each trigger controls its own guidance", async () => {
  const h = await harness();
  try {
    const policy = structuredClone(h.bootstrap.policy);
    policy.preset.revision = 8;
    policy.preset.planningPrompt = "PLAN ONLY";
    policy.preset.collectionPrompt = "COLLECT ONLY";
    policy.preset.assessmentPrompt = "ASSESS ONLY";
    policy.preset.triggers = {
      beforeWork: false,
      afterChanges: true,
      beforeHandoff: true,
    };
    let view = await h.change("policy", { policy, selection: "conversation" });
    h.bootstrap.policy.preset.revision = 99;
    const guidance = h.runtime
      .guidance(h.ctx, { systemPrompt: ["base"] })
      .systemPrompt.join("\n");
    assert.doesNotMatch(guidance, /PLAN ONLY/);
    assert.match(guidance, /ASSESS ONLY/);
    assert.equal(view.policy.preset.revision, 8);
    await h.runtime.toolBefore(
      { toolName: "edit", toolCallId: "edit-1" },
      h.ctx,
    );
    const after = await h.runtime.toolResult(
      { toolName: "edit", toolCallId: "edit-1", content: [], isError: false },
      h.ctx,
    );
    assert.match(after.additionalContext, /COLLECT ONLY/);
    policy.preset.triggers.afterChanges = false;
    view = await h.change("policy", { policy, selection: "conversation" });
    await h.runtime.toolBefore(
      { toolName: "edit", toolCallId: "edit-2" },
      h.ctx,
    );
    assert.equal(
      await h.runtime.toolResult(
        { toolName: "edit", toolCallId: "edit-2", content: [], isError: false },
        h.ctx,
      ),
      undefined,
    );
    assert.equal(view.policy.preset.revision, 8);
  } finally {
    await h.cleanup();
  }
});

test("the initial preset is pinned for text-only conversations and survives changed bootstrap on resume", async () => {
  const policy = M.initial().policy;
  policy.preset.id = "custom";
  policy.preset.name = "Original";
  policy.preset.revision = 4;
  const h = await harness({ policy });
  try {
    assert.equal(h.view.policyPinned, true);
    assert.equal(h.view.outcomes.length, 0);
    assert.equal(h.branch.at(-1).data.view.policy.preset.revision, 4);
    assert.equal(h.branch.at(-1).data.view.policyPinned, true);
    const changed = structuredClone(policy);
    changed.preset.revision = 9;
    changed.preset.name = "Updated elsewhere";
    await h.reopen(changed);
    assert.equal(h.view.policyPinned, true);
    assert.equal(h.view.policy.preset.revision, 4);
    assert.equal(h.view.policy.preset.name, "Original");
  } finally {
    await h.cleanup();
  }
});

test("a fresh conversation in the same process resolves current host defaults", async () => {
  const h = await harness();
  try {
    const policy = structuredClone(h.bootstrap.policy);
    policy.source = "project";
    policy.project = "/project";
    policy.preset.id = "current";
    policy.preset.name = "Current project preset";
    policy.preset.revision = 7;
    h.bootstrap.policy = policy;
    h.switch("new-session", "/new-session.jsonl", []);
    await h.runtime.lifecycle(h.ctx, { type: "session_switch", reason: "new" });
    assert.ok(
      h.calls.some(
        (item) => item.op === "defaults" && item.sessionId === "new-session",
      ),
    );
    assert.equal(h.view.policy.source, "project");
    assert.equal(h.view.policy.preset.revision, 7);
    assert.equal(h.view.policyPinned, true);
    assert.equal(
      h.branch.at(-1).data.view.policy.preset.name,
      "Current project preset",
    );
  } finally {
    await h.cleanup();
  }
});

test("unavailable new-session defaults are disclosed instead of reusing stale bootstrap", async () => {
  const h = await harness();
  try {
    h.setHost(async () =>
      JSON.stringify({ ok: false, error: "defaults service unavailable" }),
    );
    h.switch("new-session", "/new-session.jsonl", []);
    await h.runtime.lifecycle(h.ctx, { type: "session_switch", reason: "new" });
    assert.equal(h.view.policy.source, "builtin");
    assert.equal(h.view.policy.preset.id, "standard");
    assert.ok(
      h.view.warnings.some((warning) => /defaults.*unavailable/i.test(warning)),
    );
    assert.equal(h.view.policyPinned, true);
  } finally {
    await h.cleanup();
  }
});

test("failed initial pin is explicit, does not block guidance, and a later successful mutation repairs it", async () => {
  const h = await harness({ failInitialFlush: 1 });
  try {
    assert.equal(h.view.policyPinned, false);
    assert.match(h.view.policyPersistenceError, /injected disk failure/);
    assert.ok(
      h.view.warnings.some((warning) => /not durably pinned/i.test(warning)),
    );
    assert.match(
      h.runtime.guidance(h.ctx, { systemPrompt: [] }).systemPrompt.join("\n"),
      /not durably pinned/,
    );
    assert.match(
      await h.runtime.agentOperation(h.ctx, { op: "view" }),
      /not durably pinned/,
    );
    const view = await h.change("outcome", {
      outcome: { title: "Work continues" },
    });
    assert.equal(view.policyPinned, true);
    assert.equal(view.policyPersistenceError, undefined);
    assert.equal(
      view.warnings.some((warning) => /not durably pinned/i.test(warning)),
      false,
    );
  } finally {
    await h.cleanup();
  }
});

test("compaction refresh preserves the branch token and accepts an existing user draft", async () => {
  const h = await harness();
  try {
    const draft = h.view,
      entries = h.branch.length;
    await h.runtime.lifecycle(h.ctx, { type: "session_compact" });
    assert.equal(h.view.branchToken, draft.branchToken);
    assert.equal(h.view.revision, draft.revision);
    assert.equal(h.branch.length, entries);
    const result = await h.call("outcome", {
      revision: draft.revision,
      sessionId: draft.sessionId,
      file: draft.file,
      branchToken: draft.branchToken,
      outcome: { title: "Draft survives" },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.view.outcomes[0].title, "Draft survives");
  } finally {
    await h.cleanup();
  }
});

test("corrupt saved ledger is not silently overwritten", async () => {
  const h = await harness();
  try {
    h.branch = [
      {
        type: "custom",
        customType: "omp-desktop:evidence",
        data: {
          version: 1,
          profileId: "work",
          view: { version: 1, outcomes: "invalid" },
        },
      },
    ];
    await h.runtime.lifecycle(h.ctx);
    assert.ok(h.view.warnings.some((warning) => /invalid/i.test(warning)));
    assert.match(
      (await h.call("outcome", { outcome: { title: "unsafe overwrite" } }))
        .error,
      /invalid.*blocked/i,
    );
    assert.equal(h.branch.length, 1);
  } finally {
    await h.cleanup();
  }
});

test("absent host is disclosed and never invents source or artifact capabilities", async () => {
  const h = await harness({ noHost: true });
  try {
    assert.ok(
      h.view.warnings.some((warning) => /host is unavailable/i.test(warning)),
    );
    const ids = await h.criterion();
    const view = await h.change("record", {
      ...ids,
      record: {
        title: "Unverified",
        kind: "test",
        result: "passed",
        summary: "Agent report",
      },
    });
    assert.equal(view.currentFingerprint, null);
    assert.equal(view.summary.stale, 1);
    await assert.rejects(
      h.runtime.agentOperation(h.ctx, {
        op: "record",
        ...ids,
        record: {
          title: "File",
          kind: "test",
          result: "observed",
          summary: "file",
          path: "sample.txt",
        },
      }),
      /artifact storage is unavailable/i,
    );
  } finally {
    await h.cleanup();
  }
});

test("foreign artifacts are rejected without changing the ledger", async () => {
  const h = await harness();
  try {
    const ids = await h.criterion();
    const artifact = {
      id: "foreign",
      name: "result.txt",
      mime: "text/plain",
      bytes: 1,
      sha256: "a".repeat(64),
      owner: "another-session",
    };
    const result = await h.call("record", {
      ...ids,
      record: {
        title: "Foreign",
        kind: "test",
        result: "observed",
        summary: "x",
        artifact,
      },
    });
    assert.match(result.error, /foreign evidence artifact/i);
    assert.equal(h.view.records.length, 0);
  } finally {
    await h.cleanup();
  }
});

test(
  "escaped snapshots stay below the physical frame limit and reject overflow without losing evidence",
  { timeout: 120000 },
  async () => {
    const h = await harness();
    try {
      const ids = await h.criterion();
      let failed = false;
      for (let i = 0; i < 160; i++) {
        const before = h.view.records.length;
        const result = await h.call("record", {
          ...ids,
          record: {
            title: `Proof ${i}`,
            kind: "test",
            result: "observed",
            summary: "\\".repeat(2048),
          },
        });
        if (result.error) {
          assert.match(result.error, /snapshot limit/i);
          assert.equal(h.view.records.length, before);
          assert.equal(h.branch.at(-1).data.view.records.length, before);
          failed = true;
          break;
        }
        const physical = JSON.stringify({
          type: "extension_ui_request",
          method: "notify",
          message: PREFIX + JSON.stringify(result),
        });
        assert.ok(Buffer.byteLength(physical) < 768 * 1024);
      }
      assert.equal(
        failed,
        true,
        "size cap must refuse rather than silently truncate proofs",
      );
    } finally {
      await h.cleanup();
    }
  },
);

const installed = spawnSync("omp", ["--version"], {
  encoding: "utf8",
  timeout: 10000,
});
const providerFixture = `
export default function(pi) {
  pi.registerProvider("desktop-evidence-test", {
    baseUrl: "http://127.0.0.1:9", apiKey: "dummy", api: "openai-completions",
    models: [{ id: "local", name: "Local", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
  });
}
`;

async function openNative(home, resume, policy = M.initial().policy) {
  const project = join(home, "project"),
    moduleDir = join(home, "extension");
  const events = new EventEmitter(),
    pending = new Map(),
    frames = [],
    hostRequests = [];
  const env = {
    ...process.env,
    HOME: home,
    ANTHROPIC_API_KEY: "evidence-test-not-a-key",
    OMP_DESKTOP_PROFILE_ID: "work",
    OMP_DESKTOP_CONTEXT_EPOCH: "evidence-native-test",
    OMP_DESKTOP_EVIDENCE_BOOTSTRAP: JSON.stringify({
      version: 1,
      policy,
      inbox: join(home, "inbox"),
      environment: {},
    }),
  };
  for (const key of [
    "PI_CONFIG_DIR",
    "PI_CODING_AGENT_DIR",
    "PI_PROFILE",
    "OMP_PROFILE",
    "PI_CONFIG_FILES",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
  ])
    delete env[key];
  const child = spawn(
    "omp",
    [
      "--profile=work",
      "--no-extensions",
      "--extension",
      join(moduleDir, "evidence-extension.mjs"),
      "--extension",
      join(home, "provider.mjs"),
      "--mode",
      "rpc",
      `--cwd=${project}`,
      ...(resume ? ["--resume", resume] : []),
    ],
    { cwd: project, env },
  );
  let buffer = "",
    stderr = "",
    counter = 0;
  const startup = Promise.race([
    once(events, "ready"),
    once(child, "exit").then(([code]) => {
      throw new Error(`omp exited ${code}: ${stderr}`);
    }),
  ]);
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      frames.push(frame);
      events.emit("frame", frame);
      if (frame.type === "ready") events.emit("ready");
      if (
        frame.type === "extension_ui_request" &&
        frame.method === "input" &&
        frame.title?.startsWith(HOST)
      ) {
        const request = JSON.parse(frame.title.slice(HOST.length));
        hostRequests.push(request);
        const value =
          request.op === "fingerprint"
            ? FP()
            : request.op === "defaults"
              ? { policy, revision: 1 }
              : {
                  state: "unknown",
                  sourceSha: null,
                  reason: "No CI",
                  limitations: "No CI",
                  snapshot: null,
                };
        child.stdin.write(
          JSON.stringify({
            type: "extension_ui_response",
            id: frame.id,
            value: JSON.stringify({ ok: true, value }),
          }) + "\n",
        );
      }
      if (frame.type === "response" && pending.has(frame.id)) {
        const item = pending.get(frame.id);
        pending.delete(frame.id);
        clearTimeout(item.timer);
        if (frame.success) item.resolve(frame.data);
        else item.reject(new Error(frame.error));
      }
    }
  });
  child.on("exit", () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(`omp stopped: ${stderr}`));
    }
    pending.clear();
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  };
  const request = (body) =>
    new Promise((resolve, reject) => {
      const id = `evidence-rpc-${++counter}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC timed out: ${body.type}: ${stderr}`));
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ ...body, id }) + "\n");
    });
  try {
    await startup;
    await request({
      type: "set_model",
      provider: "desktop-evidence-test",
      modelId: "local",
    });
    const catalog = await request({ type: "get_available_commands" });
    const command = catalog.commands.find(
      (entry) =>
        entry.name === "omp-desktop-evidence-evidence-native-test" &&
        entry.source === "extension",
    )?.name;
    assert.ok(command, "native Evidence private command must be registered");
    let lastView;
    const call = async (op, fields = {}) => {
      const id = `evidence-request-${++counter}`;
      let listener, timer;
      const response = new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Native Evidence snapshot timed out")),
          20000,
        );
        listener = (frame) => {
          if (
            frame.type !== "extension_ui_request" ||
            frame.method !== "notify" ||
            !frame.message?.startsWith(PREFIX)
          )
            return;
          const value = JSON.parse(frame.message.slice(PREFIX.length));
          if (value.id === id && value.command === command) resolve(value);
        };
        events.on("frame", listener);
      });
      try {
        const owner =
          lastView && op !== "get" && op !== "export"
            ? {
                sessionId: lastView.sessionId,
                file: lastView.file,
                branchToken: lastView.branchToken,
              }
            : {};
        const [, result] = await Promise.all([
          request({
            type: "prompt",
            message: `/${command} ${JSON.stringify({ id, op, profileId: "work", ...owner, ...fields })}`,
          }),
          response,
        ]);
        if (result.error) throw new Error(result.error);
        lastView = result.view;
        return lastView;
      } finally {
        clearTimeout(timer);
        events.off("frame", listener);
      }
    };
    return { request, call, stop, frames, hostRequests };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function prepareNative(home) {
  const modules = join(home, "extension");
  await Promise.all([
    mkdir(join(home, "project")),
    mkdir(join(home, "inbox")),
    mkdir(modules),
  ]);
  const source = fileURLToPath(
    new URL("../src-tauri/src/agent/", import.meta.url),
  );
  for (const name of [
    "evidence-extension.mjs",
    "evidence-runtime.mjs",
    "evidence-ledger.mjs",
    "evidence-host.mjs",
  ])
    await copyFile(join(source, name), join(modules, name));
  await copyFile(
    fileURLToPath(new URL("../src/app/evidence-model.js", import.meta.url)),
    join(modules, "evidence-model.js"),
  );
  await writeFile(join(home, "provider.mjs"), providerFixture);
}

test(
  "real omp private transport persists and resumes its branch ledger",
  { skip: installed.status !== 0, timeout: 120000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "evidence-native-"));
    await prepareNative(home);
    let first, resumed;
    try {
      first = await openNative(home);
      let view = await first.call("get");
      assert.equal(view.supported, true);
      assert.equal(view.currentFingerprint.head, "abc");
      view = await first.call("outcome", {
        revision: view.revision,
        outcome: { title: "Native result" },
      });
      const outcomeId = view.outcomes[0].id;
      view = await first.call("requirement", {
        revision: view.revision,
        outcomeId,
        requirement: {
          text: "Native acceptance criterion",
          kind: "test",
          required: true,
        },
      });
      const requirementId = view.outcomes[0].requirements[0].id;
      view = await first.call("record", {
        revision: view.revision,
        outcomeId,
        requirementId,
        record: {
          title: "Observed failure",
          kind: "test",
          result: "failed",
          summary: "Real failure",
        },
      });
      view = await first.call("waive", {
        revision: view.revision,
        outcomeId,
        requirementId,
        reason: "User decision",
      });
      const saved = await first.request({ type: "get_state" });
      assert.ok(saved.sessionFile);
      assert.ok(
        first.hostRequests.some(
          (request) =>
            request.op === "fingerprint" && request.sessionId && request.file,
        ),
      );
      await first.stop();
      resumed = await openNative(home, saved.sessionFile);
      view = await resumed.call("get");
      assert.equal(
        view.outcomes[0].requirements[0].waiver.reason,
        "User decision",
      );
      assert.equal(view.records[0].result, "failed");
      assert.equal(view.summary.waived, 1);
      assert.equal(
        view.history.some((entry) => entry.action === "waive"),
        true,
      );
      const disk = await readFile(saved.sessionFile, "utf8");
      assert.match(disk, /omp-desktop:evidence/);
      assert.match(disk, /Observed failure/);
    } finally {
      await first?.stop();
      await resumed?.stop();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "real omp persists the starting preset without Evidence mutations and restores it after restart",
  { skip: installed.status !== 0, timeout: 120000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "evidence-native-pin-"));
    await prepareNative(home);
    const firstPolicy = M.initial().policy;
    firstPolicy.preset.id = "custom";
    firstPolicy.preset.name = "Pinned before work";
    firstPolicy.preset.revision = 3;
    const updatedPolicy = structuredClone(firstPolicy);
    updatedPolicy.preset.name = "Changed default";
    updatedPolicy.preset.revision = 8;
    let first, resumed;
    try {
      first = await openNative(home, undefined, firstPolicy);
      const saved = await first.request({ type: "get_state" });
      assert.ok(saved.sessionFile);
      await first.stop();
      const disk = await readFile(saved.sessionFile, "utf8");
      assert.match(disk, /Pinned before work/);
      resumed = await openNative(home, saved.sessionFile, updatedPolicy);
      const view = await resumed.call("get");
      assert.equal(view.policy.preset.name, "Pinned before work");
      assert.equal(view.policy.preset.revision, 3);
      assert.equal(view.policyPinned, true);
    } finally {
      await first?.stop();
      await resumed?.stop();
      await rm(home, { recursive: true, force: true });
    }
  },
);
