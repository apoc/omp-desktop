#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const window = {};
new Function(
  "window",
  readFileSync(
    new URL("../src/app/context-policy.js", import.meta.url),
    "utf8",
  ),
)(window);
const C = window.OMP_CONTEXT_POLICY;
const command = "omp-desktop-context-policy-epoch-1";
const policy = (extra = {}) => ({
  supported: true,
  profileId: "work",
  revision: "1",
  model: { provider: "local", id: "model", contextWindow: 200000 },
  enabled: true,
  thresholdTokens: 150000,
  source: "global",
  controls: [],
  profileControls: [],
  ...extra,
});
function harness({ available = true } = {}) {
  let current = true,
    state,
    deliver,
    answer = policy();
  const requests = [];
  const client = C.create({
    profileId: "work",
    current: () => current,
    changed: (next) => {
      state = next;
    },
    request: async (frame) => {
      requests.push(frame);
      if (frame.type === "get_available_commands")
        return {
          commands: available ? [{ name: command, source: "extension" }] : [],
        };
      if (frame.type === "prompt") {
        const body = JSON.parse(
          frame.message.slice(frame.message.indexOf(" ") + 1),
        );
        if (deliver) await deliver(body);
        else
          client.observe({
            type: "extension_ui_request",
            method: "notify",
            message:
              C.PREFIX +
              JSON.stringify({ command, id: body.id, policy: answer }),
          });
        return { agentInvoked: false };
      }
      throw new Error("Unexpected native operation");
    },
  });
  return {
    client,
    requests,
    get state() {
      return state;
    },
    setAnswer: (next) => {
      answer = next;
    },
    setDeliver: (fn) => {
      deliver = fn;
    },
    leave() {
      current = false;
      client.dispose();
    },
  };
}

test("a profile edit reports native read-back rather than the requested threshold", async () => {
  const h = harness();
  await h.client.load();
  h.setAnswer(
    policy({ revision: "2", thresholdTokens: 120000, source: "project" }),
  );
  const result = await h.client.apply({
    scope: "profile",
    values: { threshold: "tokens", budget: 160000 },
    revision: "1",
    model: { provider: "local", id: "model" },
  });
  assert.equal(result.thresholdTokens, 120000);
  assert.equal(h.state.policy.source, "project");
  assert.equal(h.state.saving, false);
  const sent = JSON.parse(
    h.requests.at(-1).message.split(" ").slice(1).join(" "),
  );
  assert.equal(sent.profileId, "work");
  assert.equal(sent.scope, "profile");
});

test("unsupported native sessions never receive a settings prompt", async () => {
  const h = harness({ available: false });
  assert.equal((await h.client.load()).supported, false);
  await assert.rejects(
    h.client.apply({ scope: "profile", values: { enabled: false } }),
    /support/i,
  );
  assert.deepEqual(
    h.requests.map((r) => r.type),
    ["get_available_commands"],
  );
});

test("a native refusal keeps the prior effective policy and surfaces its reason", async () => {
  const h = harness();
  await h.client.load();
  h.setDeliver((body) =>
    h.client.observe({
      type: "extension_ui_request",
      method: "notify",
      message:
        C.PREFIX +
        JSON.stringify({
          command,
          id: body.id,
          error: "Settings changed; refresh before applying.",
        }),
    }),
  );
  await assert.rejects(
    h.client.apply({ scope: "conversation", values: { budget: 1 } }),
    /Settings changed/,
  );
  assert.equal(h.state.policy.thresholdTokens, 150000);
  assert.match(h.state.error, /Settings changed/);
});

test("a result belonging to another profile cannot become the current policy", async () => {
  const h = harness();
  h.setAnswer(policy({ profileId: "personal" }));
  await assert.rejects(h.client.load(), /profile/i);
  assert.equal(h.state.policy, null);
});

test("leaving a conversation invalidates an outstanding mutation without changing the new owner", async () => {
  const h = harness();
  await h.client.load();
  let release;
  h.setDeliver(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = h.client.apply({
    scope: "profile",
    values: { enabled: false },
  });
  await Promise.resolve();
  h.leave();
  release();
  await assert.rejects(pending, /changed|closed/i);
  assert.equal(h.state.policy.enabled, true);
});

test("a model change during initial discovery cannot leave the old policy displayed", async () => {
  const h = harness();
  let release,
    calls = 0;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  h.setDeliver(async (body) => {
    const first = calls++ === 0;
    if (first) await held;
    h.client.observe({
      type: "extension_ui_request",
      method: "notify",
      message:
        C.PREFIX +
        JSON.stringify({
          command,
          id: body.id,
          policy: first
            ? policy()
            : policy({
                revision: "2",
                model: {
                  provider: "local",
                  id: "replacement",
                  contextWindow: 1000000,
                },
              }),
        }),
    });
  });
  const initial = h.client.load();
  await Promise.resolve();
  h.client.observe({ type: "config_update" });
  release();
  await initial;
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(h.state.policy.model.id, "replacement");
  assert.equal(h.state.loading, false);
});
