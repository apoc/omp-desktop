#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const window = {};
runInNewContext(
  readFileSync(
    new URL("../src/app/evidence-client.js", import.meta.url),
    "utf8",
  ),
  { window, setTimeout, clearTimeout },
);
const C = window.OMP_EVIDENCE_CLIENT;
const epoch = "process-a";
const command = `omp-desktop-evidence-${epoch}`;
const view = (extra = {}) => ({
  version: 1,
  supported: true,
  profileId: "work",
  epoch,
  sessionId: "session-a",
  file: "/session-a.jsonl",
  branchToken: "branch-a",
  revision: 0,
  sequence: 1,
  outcomes: [],
  records: [],
  requests: [],
  ...extra,
});
function harness(transport = async () => ({ agentInvoked: false })) {
  let active = true;
  const client = C.create({
    profileId: "work",
    current: () => active,
    changed: () => {},
    request: async (frame) => {
      if (frame.type === "get_available_commands")
        return { commands: [{ name: command, source: "extension" }] };
      return transport(
        JSON.parse(frame.message.slice(frame.message.indexOf(" ") + 1)),
        deliver,
      );
    },
  });
  function deliver(data) {
    client.observe({
      type: "extension_ui_request",
      method: "notify",
      message:
        C.PREFIX + JSON.stringify({ version: 1, epoch, command, ...data }),
    });
  }
  client.restore(view());
  return {
    client,
    deliver,
    leave() {
      active = false;
      client.dispose();
    },
  };
}

test("journal recovery cannot regress a branch snapshot even when its metadata revision resets", () => {
  const h = harness();
  h.client.restore(
    view({
      sequence: 10,
      revision: 8,
      outcomes: [{ id: "old", title: "Old branch" }],
    }),
  );
  h.client.restore(
    view({ sequence: 9, revision: 9, outcomes: [{ id: "out-of-order" }] }),
  );
  assert.equal(h.client.snapshot().view.outcomes[0].id, "old");
  h.client.restore(
    view({
      sequence: 11,
      revision: 0,
      branchToken: "branch-b",
      outcomes: [{ id: "new", title: "Selected branch" }],
    }),
  );
  h.deliver({
    view: view({ sequence: 10, revision: 8, outcomes: [{ id: "old" }] }),
  });
  assert.equal(h.client.snapshot().view.outcomes[0].title, "Selected branch");
  assert.equal(h.client.snapshot().view.revision, 0);
  assert.equal(h.client.snapshot().view.branchToken, "branch-b");
  h.leave();
});

test("a foreign profile or replacement process cannot replace the displayed ledger", () => {
  const h = harness();
  h.client.restore(
    view({ profileId: "personal", sequence: 2, outcomes: [{ id: "foreign" }] }),
  );
  assert.equal(h.client.snapshot().view.profileId, "work");
  assert.match(h.client.snapshot().error, /another profile/);
  h.client.restore(
    view({
      epoch: "process-b",
      sequence: 3,
      outcomes: [{ id: "replacement" }],
    }),
  );
  assert.equal(h.client.snapshot().view.epoch, epoch);
  assert.match(h.client.snapshot().error, /replaced agent process/);
  h.leave();
});

test("confirmed native metadata survives a lost RPC acknowledgement", async () => {
  const h = harness(async (input, deliver) => {
    deliver({
      id: input.id,
      view: view({
        sequence: 2,
        revision: 1,
        outcomes: [{ id: "saved", title: "Persisted acceptance outcome" }],
      }),
    });
    throw new Error("RPC acknowledgement lost");
  });
  await assert.rejects(
    h.client.mutate({
      op: "outcome",
      outcome: { title: "Persisted acceptance outcome" },
    }),
    /acknowledgement lost/,
  );
  const snapshot = h.client.snapshot();
  assert.equal(snapshot.view.outcomes[0].id, "saved");
  assert.equal(snapshot.view.revision, 1);
  assert.equal(snapshot.saving, false);
  assert.match(snapshot.error, /acknowledgement lost/);
  h.leave();
});

test("a native refusal retains the ledger and releases the pending edit", async () => {
  const h = harness(async (input, deliver) => {
    deliver({
      id: input.id,
      error: "Evidence changed; refresh before editing",
    });
    return { agentInvoked: false };
  });
  const prior = h.client.snapshot().view;
  await assert.rejects(
    h.client.mutate({ op: "tracking", enabled: false }),
    /refresh before editing/,
  );
  assert.equal(h.client.snapshot().view, prior);
  assert.equal(h.client.snapshot().saving, false);
  assert.match(h.client.snapshot().error, /changed/);
  h.leave();
});

test("leaving a conversation invalidates its pending edit and ignores its late proof", async () => {
  let started, acknowledge;
  const received = new Promise((resolve) => {
    started = resolve;
  });
  const ack = new Promise((resolve) => {
    acknowledge = resolve;
  });
  const h = harness(async (input, deliver) => {
    started({ input, deliver });
    return ack;
  });
  const pending = h.client.mutate({ op: "tracking", enabled: false });
  const failed = assert.rejects(pending, /Conversation changed/);
  const { input, deliver } = await received;
  h.leave();
  deliver({
    id: input.id,
    view: view({ sequence: 2, revision: 1, outcomes: [{ id: "late" }] }),
  });
  acknowledge({ agentInvoked: false });
  await failed;
  assert.equal(h.client.snapshot().view.outcomes.length, 0);
  assert.equal(h.client.snapshot().view.revision, 0);
});
