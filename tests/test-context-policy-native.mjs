#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const extension = fileURLToPath(
  new URL(
    "../src-tauri/src/agent/context-policy-extension.mjs",
    import.meta.url,
  ),
);
const PREFIX = "OMP_DESKTOP_CONTEXT_POLICY:";
const installed = spawnSync("omp", ["--version"], {
  encoding: "utf8",
  timeout: 10000,
});

async function openNative(home, profileId, resume) {
  const env = {
    ...process.env,
    HOME: home,
    ANTHROPIC_API_KEY: "context-policy-test-not-a-key",
    OMP_DESKTOP_PROFILE_ID: profileId,
    OMP_DESKTOP_CONTEXT_EPOCH: `test-${profileId}-${Date.now()}`,
  };
  for (const key of [
    "PI_CONFIG_DIR",
    "PI_CODING_AGENT_DIR",
    "PI_PROFILE",
    "OMP_PROFILE",
  ])
    delete env[key];
  const events = new EventEmitter(),
    frames = [],
    pending = new Map();
  const child = spawn(
    "omp",
    [
      `--profile=${profileId}`,
      "--no-extensions",
      "--extension",
      extension,
      "--mode",
      "rpc",
      `--cwd=${join(home, "project")}`,
      ...(resume ? ["--resume", resume] : []),
    ],
    { cwd: join(home, "project"), env },
  );
  let sequence = 0,
    buffer = "",
    stderr = "";
  const startup = Promise.race([
    once(events, "ready"),
    once(child, "exit").then(([code]) => {
      throw new Error(`omp exited ${code}: ${stderr}`);
    }),
  ]);
  child.stderr.on("data", (data) => {
    stderr = (stderr + data).slice(-4096);
  });
  child.stdout.on("data", (data) => {
    buffer += data;
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
      if (frame.type === "response" && pending.has(frame.id)) {
        const request = pending.get(frame.id);
        pending.delete(frame.id);
        clearTimeout(request.timer);
        if (frame.success) request.resolve(frame.data);
        else request.reject(new Error(frame.error));
      }
    }
  });
  child.on("exit", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`omp stopped: ${stderr}`));
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
      const id = `native-test-${++sequence}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`omp did not answer ${body.type}: ${stderr}`));
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ ...body, id }) + "\n");
    });
  try {
    await startup;
    const catalog = await request({ type: "get_available_commands" });
    const command = catalog.commands.find(
      (entry) =>
        entry.name.startsWith("omp-desktop-context-policy-") &&
        entry.source === "extension",
    )?.name;
    assert.ok(
      command,
      "the private command must be advertised before it is sent",
    );
    const policy = async (op = "get", fields = {}) => {
      const id = `policy-test-${++sequence}`;
      let handler, timer;
      const result = new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Native policy confirmation timed out")),
          20000,
        );
        handler = (frame) => {
          if (
            frame.type !== "extension_ui_request" ||
            frame.method !== "notify" ||
            !frame.message?.startsWith(PREFIX)
          )
            return;
          const response = JSON.parse(frame.message.slice(PREFIX.length));
          if (response.command === command && response.id === id)
            resolve(response);
        };
        events.on("frame", handler);
      });
      try {
        const [, response] = await Promise.all([
          request({
            type: "prompt",
            message: `/${command} ${JSON.stringify({ id, op, profileId, ...fields })}`,
          }),
          result,
        ]);
        if (response.error) throw new Error(response.error);
        return response.policy;
      } finally {
        clearTimeout(timer);
        events.off("frame", handler);
      }
    };
    return { policy, request, stop, frames };
  } catch (error) {
    await stop();
    throw error;
  }
}
const edit = (policy, scope, values, extra = {}) => ({
  scope,
  values,
  revision: policy.revision,
  model: { provider: policy.model.provider, id: policy.model.id },
  ...extra,
});

test(
  "native profile defaults, durable conversation overrides, and rejected edits stay isolated",
  {
    skip:
      installed.status !== 0
        ? "installed omp required; no provider credentials or model calls are needed"
        : false,
    timeout: 90000,
  },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "omp-native-policy-test-"));
    await mkdir(join(home, "project"));
    const processes = [];
    const open = async (profile, resume) => {
      const process = await openNative(home, profile, resume);
      processes.push(process);
      return process;
    };
    try {
      const first = await open("work");
      let policy = await first.policy();
      if (!policy.supported) {
        t.skip(policy.reason);
        return;
      }
      policy = await first.policy(
        "apply",
        edit(policy, "profile", { threshold: "tokens", budget: 150000 }),
      );
      assert.equal(policy.thresholdTokens, 150000);
      const sibling = await open("work");
      assert.equal(
        (await sibling.policy()).thresholdTokens,
        150000,
        "a new conversation inherits its profile's saved budget",
      );
      const other = await open("personal");
      const otherBefore = await other.policy();
      assert.notEqual(
        otherBefore.thresholdTokens,
        150000,
        "another profile does not inherit work's settings",
      );

      policy = await first.policy(
        "apply",
        edit(policy, "conversation", { threshold: "tokens", budget: 100000 }),
      );
      assert.equal(policy.thresholdTokens, 100000);
      assert.equal(policy.conversationOverride, true);
      assert.equal(
        policy.profileControls.find((field) => field.id === "budget").value,
        150000,
      );
      assert.equal(
        (await sibling.policy()).thresholdTokens,
        150000,
        "a conversation override does not leak to a sibling",
      );
      const session = await first.request({ type: "get_state" });
      assert.ok(session.sessionFile);
      await first.stop();
      const resumed = await open("work", session.sessionFile);
      policy = await resumed.policy();
      assert.equal(
        policy.thresholdTokens,
        100000,
        "the override survives reopening its session",
      );

      const before = policy.revision;
      await assert.rejects(
        resumed.policy(
          "apply",
          edit(
            policy,
            "profile",
            { enabled: false },
            { profileId: "personal" },
          ),
        ),
        /profile/,
      );
      await assert.rejects(
        resumed.policy(
          "apply",
          edit(policy, "profile", { threshold: "tokens", budget: 1 }),
        ),
        /Threshold|budget/,
      );
      assert.equal(
        (await resumed.policy()).revision,
        before,
        "rejected edits do not mutate effective or saved policy",
      );

      let siblingPolicy = await sibling.policy();
      siblingPolicy = await sibling.policy(
        "apply",
        edit(siblingPolicy, "profile", { threshold: "tokens", budget: 200000 }),
      );
      assert.equal(siblingPolicy.thresholdTokens, 200000);
      await assert.rejects(
        resumed.policy("apply", edit(policy, "profile", { enabled: false })),
        /changed|reload/,
      );
      policy = await resumed.policy();
      assert.equal(
        policy.thresholdTokens,
        100000,
        "a profile edit cannot replace an explicit conversation override",
      );
      assert.equal(
        policy.profileControls.find((field) => field.id === "budget").value,
        200000,
      );
      policy = await resumed.policy(
        "apply",
        edit(policy, "conversation", {}, { reset: true }),
      );
      assert.equal(policy.conversationOverride, false);
      assert.equal(
        policy.thresholdTokens,
        200000,
        "resetting an override restores the latest profile default",
      );
      assert.equal((await other.policy()).revision, otherBefore.revision);
      assert.equal(
        processes
          .flatMap((process) => process.frames)
          .filter((frame) => frame.type === "agent_start").length,
        0,
        "settings never invoke the model",
      );
      assert.equal(
        (await resumed.request({ type: "get_messages" })).messages.length,
        0,
        "settings never add conversation messages",
      );
    } finally {
      await Promise.all(processes.map((process) => process.stop()));
      await rm(home, { recursive: true, force: true });
    }
  },
);
