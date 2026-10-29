#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

const modelFixture = `
import { Settings, SettingsManager } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
let inheritedViews = 0, clones = 0, failNextView = false;
const loadReadOnly = Settings.loadReadOnly;
const cloneForCwd = Settings.prototype.cloneForCwd;
Settings.loadReadOnly = function(...args) {
  inheritedViews++;
  if (failNextView) {
    failNextView = false;
    lookup("shellPath").override(SettingsManager.create(), "/bin/bash");
    throw new Error("Injected inherited policy read failure");
  }
  return loadReadOnly.apply(this, args);
};
Settings.prototype.cloneForCwd = function(...args) {
  clones++;
  return cloneForCwd.apply(this, args);
};
export default function(pi) {
  pi.registerProvider("desktop-test", {
    baseUrl: "http://127.0.0.1:9", apiKey: "dummy", api: "openai-completions",
    models: [400000, 1000000].map((contextWindow, i) => ({
      id: i ? "million" : "large", name: i ? "Million" : "Large",
      reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow, maxTokens: 4096,
    })),
  });
  pi.registerCommand("policy-fixture-counts", {
    handler: (_args, ctx) => ctx.ui.notify("POLICY_CACHE_COUNTS:" + JSON.stringify({ inheritedViews, clones }), "info"),
  });
  pi.registerCommand("policy-fixture-unrelated", {
    handler: (_args, ctx) => lookup("shellPath").override(SettingsManager.create(ctx.cwd), "/bin/sh"),
  });
  pi.registerCommand("policy-fixture-fail-next", {
    handler: (_args, ctx) => {
      failNextView = true;
      lookup("compaction.modelThresholds").setEntry(
        SettingsManager.create(ctx.cwd), "desktop-test/large", "71%",
      );
    },
  });
  pi.registerCommand("policy-fixture-stop-watch", {
    handler: (_args, ctx) => SettingsManager.create(ctx.cwd).stopWatching(),
  });
  pi.registerCommand("policy-fixture-signal", {
    handler: (_args, ctx) => lookup("compaction.reserveTokens").override(SettingsManager.create(ctx.cwd), 17000),
  });
  pi.registerCommand("legacy-policy-fixture", {
    handler: async (_args, ctx) => {
      await ctx.sessionManager.ensureOnDisk();
      pi.appendEntry("omp-desktop:context-policy", {
        version: 1, profileId: process.env.OMP_DESKTOP_PROFILE_ID,
        sessionId: ctx.sessionManager.getSessionId(),
        values: { threshold: "tokens", budget: 120000, asyncEnabled: false },
      });
      await ctx.sessionManager.flush();
    },
  });
}
`;

async function openNative(home, profileId, resume, options = {}) {
  const fixture = join(home, "models.mjs");
  await writeFile(fixture, modelFixture);
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
    "PI_CONFIG_FILES",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
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
      "--extension",
      fixture,
      "--mode",
      "rpc",
      `--cwd=${join(home, "project")}`,
      ...(options.config ? ["--config", options.config] : []),
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
    await request({
      type: "set_model",
      provider: "desktop-test",
      modelId: "large",
    });
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
    const cacheCounts = async () => {
      const start = frames.length;
      await request({ type: "prompt", message: "/policy-fixture-counts" });
      const frame = frames
        .slice(start)
        .find(
          (item) =>
            item.type === "extension_ui_request" &&
            item.method === "notify" &&
            item.message?.startsWith("POLICY_CACHE_COUNTS:"),
        );
      assert.ok(frame, "cache counts must be delivered by the fixture");
      return JSON.parse(frame.message.slice("POLICY_CACHE_COUNTS:".length));
    };
    return { policy, request, stop, frames, cacheCounts, events };
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

const select = (process, id) =>
  process.request({ type: "set_model", provider: "desktop-test", modelId: id });
const configure = async (home, profile, config) => {
  const dir = join(home, ".omp", "profiles", profile, "agent");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.yml"), JSON.stringify(config));
};

test(
  "per-model profile and conversation targets survive switches, fork and resume without leaking",
  {
    skip: installed.status !== 0,
    timeout: 120000,
  },
  async () => {
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
      assert.equal(policy.supported, true, policy.reason);
      assert.deepEqual(
        policy.controls.map((field) => field.id),
        ["enabled", "method", "asyncEnabled", "midTurnEnabled"],
      );
      assert.deepEqual(
        policy.profileControls.map((field) => field.id),
        ["enabled", "method", "asyncEnabled", "midTurnEnabled"],
      );
      policy = await first.policy(
        "apply",
        edit(policy, "profile", { targetPercent: 55 }),
      );
      assert.equal(policy.target.tokens, 220000);
      assert.equal(policy.target.profilePercent, 55);
      assert.equal(policy.target.source, "profile");
      await select(first, "million");
      policy = await first.policy();
      assert.equal(policy.supported, true, policy.reason);
      policy = await first.policy(
        "apply",
        edit(policy, "profile", { targetPercent: 70 }),
      );
      assert.equal(policy.target.tokens, 700000);
      assert.equal(policy.target.profilePercent, 70);
      const sibling = await open("work");
      assert.equal((await sibling.policy()).target.tokens, 220000);
      const other = await open("personal");
      assert.equal((await other.policy()).target.profileOverride, false);

      await select(first, "large");
      policy = await first.policy();
      policy = await first.policy(
        "apply",
        edit(policy, "conversation", { targetPercent: 30 }),
      );
      assert.equal(policy.target.tokens, 120000);
      assert.equal(policy.target.source, "conversation");
      assert.equal(policy.target.inherited.tokens, 220000);
      await select(first, "million");
      policy = await first.policy();
      assert.equal(policy.target.tokens, 700000);
      policy = await first.policy(
        "apply",
        edit(policy, "conversation", { targetPercent: 40 }),
      );
      assert.equal(policy.target.tokens, 400000);
      assert.equal((await sibling.policy()).target.tokens, 220000);

      const saved = await first.request({ type: "get_state" });
      await first.stop();
      const foreign = await open("personal", saved.sessionFile);
      assert.equal(
        (await foreign.policy()).target.conversationOverride,
        false,
        "session metadata is profile-isolated",
      );
      await foreign.stop();
      const resumed = await open("work", saved.sessionFile);
      policy = await resumed.policy();
      assert.equal(policy.target.tokens, 120000);
      await select(resumed, "million");
      policy = await resumed.policy();
      assert.equal(policy.target.tokens, 400000);
      policy = await resumed.policy(
        "apply",
        edit(policy, "conversation", { targetPercent: null }),
      );
      assert.equal(policy.target.tokens, 700000);
      assert.equal(policy.target.conversationOverride, false);
      await select(resumed, "large");
      policy = await resumed.policy();
      assert.equal(policy.target.tokens, 120000);
      const forked = await resumed.request({ type: "fork" });
      assert.equal(forked.cancelled, false);
      policy = await resumed.policy();
      assert.equal(
        policy.target.tokens,
        120000,
        "a fork inherits the branch's policy entry",
      );
      assert.equal(policy.target.conversationOverride, true);

      let siblingPolicy = await sibling.policy();
      siblingPolicy = await sibling.policy(
        "apply",
        edit(siblingPolicy, "profile", { targetPercent: 60 }),
      );
      assert.equal(siblingPolicy.target.tokens, 240000);
      await assert.rejects(
        resumed.policy("apply", edit(policy, "profile", { enabled: false })),
        /changed|reload/,
      );
      policy = await resumed.policy();
      assert.equal(policy.target.tokens, 120000);
      assert.equal(policy.target.inherited.tokens, 240000);
      policy = await resumed.policy(
        "apply",
        edit(policy, "profile", { targetPercent: 65 }),
      );
      assert.equal(
        policy.target.tokens,
        120000,
        "a profile save is shadowed by the conversation override",
      );
      assert.equal(policy.target.inherited.tokens, 260000);
      policy = await resumed.policy(
        "apply",
        edit(policy, "conversation", { targetPercent: null }),
      );
      assert.equal(policy.target.tokens, 260000);
      assert.equal(policy.target.conversationOverride, false);
      await select(resumed, "million");
      assert.equal((await resumed.policy()).target.tokens, 700000);
      assert.equal((await other.policy()).target.profileOverride, false);
      assert.equal(
        processes
          .flatMap((p) => p.frames)
          .some((frame) => frame.type === "agent_start"),
        false,
      );
      assert.equal(
        (await resumed.request({ type: "get_messages" })).messages.length,
        0,
      );
    } finally {
      await Promise.all(processes.map((process) => process.stop()));
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "native token rules and project precedence survive profile edits and selected-model reset",
  {
    skip: installed.status !== 0,
    timeout: 90000,
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-native-precedence-test-"));
    await mkdir(join(home, "project", ".omp"), { recursive: true });
    await configure(home, "work", {
      compaction: {
        thresholdPercent: 80,
        modelThresholds: {
          "desktop-test/large": "f180000",
          "desktop-test/million": 300000,
        },
      },
    });
    let process;
    try {
      process = await openNative(home, "work");
      let policy = await process.policy();
      assert.equal(policy.target.tokens, 180000);
      assert.equal(policy.target.mode, "tokens");
      assert.equal(
        policy.target.profilePercent,
        null,
        "a fixed token rule is not a percentage",
      );
      await writeFile(
        join(home, "project", ".omp", "config.yml"),
        JSON.stringify({
          compaction: { modelThresholds: { "desktop-test/large": "42%" } },
        }),
      );
      policy = await process.policy();
      assert.equal(policy.target.tokens, 168000);
      assert.equal(policy.target.mode, "percent");
      assert.equal(policy.target.source, "project");
      assert.equal(policy.target.profileOverride, true);
      policy = await process.policy(
        "apply",
        edit(policy, "profile", { targetPercent: 55 }),
      );
      assert.equal(
        policy.target.tokens,
        168000,
        "project rules shadow a saved profile target",
      );
      assert.equal(policy.target.profilePercent, 55);
      assert.equal(policy.target.source, "project");
      await select(process, "million");
      policy = await process.policy();
      assert.equal(
        policy.target.tokens,
        240000,
        "a numeric model entry is a base, not a fixed trigger",
      );
      assert.equal(policy.target.mode, "native");
      assert.equal(policy.target.profilePercent, null);
      await select(process, "large");
      policy = await process.policy();
      policy = await process.policy(
        "apply",
        edit(policy, "profile", { targetPercent: null }),
      );
      assert.equal(policy.target.tokens, 168000);
      assert.equal(policy.target.profileOverride, false);
      await select(process, "million");
      assert.equal(
        (await process.policy()).target.tokens,
        240000,
        "reset does not erase another model's token rule",
      );
      const raw = await readFile(
        join(home, ".omp", "profiles", "work", "agent", "config.yml"),
        "utf8",
      );
      assert.match(raw, /300000/);
      await assert.rejects(
        process.policy(
          "apply",
          edit(await process.policy(), "profile", {
            threshold: "tokens",
            budget: 100000,
          }),
        ),
        /Invalid policy values/,
      );
    } finally {
      await process?.stop();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "inherited views are reused across unchanged reads and refresh for real policy layer changes",
  {
    skip: installed.status !== 0,
    timeout: 90000,
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-native-view-cache-test-"));
    const project = join(home, "project"),
      overlay = join(home, "overlay.yml");
    await mkdir(join(project, ".omp"), { recursive: true });
    await configure(home, "work", {
      compaction: {
        modelThresholds: { "desktop-test/large": "50%" },
      },
    });
    await writeFile(
      overlay,
      JSON.stringify({
        compaction: { modelThresholds: { "desktop-test/large": "55%" } },
        shellPath: "/bin/sh",
      }),
    );
    let process;
    try {
      process = await openNative(home, "work", undefined, { config: overlay });
      let policy = await process.policy();
      assert.equal(policy.supported, true, policy.reason);
      assert.equal(policy.target.tokens, 220000);
      const initial = await process.cacheCounts();
      policy = await process.policy(
        "apply",
        edit(policy, "conversation", { targetPercent: 30 }),
      );
      assert.equal(policy.target.tokens, 120000);
      assert.equal(policy.target.inherited.tokens, 220000);
      let counts = await process.cacheCounts();
      assert.ok(counts.inheritedViews > initial.inheritedViews);
      assert.equal(
        counts.clones,
        initial.clones,
        "desktop policy reads never clone native settings",
      );
      for (let i = 0; i < 3; i++) {
        policy = await process.policy();
        assert.equal(policy.target.inherited.tokens, 220000);
      }
      assert.deepEqual(
        await process.cacheCounts(),
        counts,
        "unchanged reads reuse the inherited view",
      );
      await process.request({
        type: "prompt",
        message: "/policy-fixture-unrelated",
      });
      policy = await process.policy();
      assert.equal(policy.target.inherited.tokens, 220000);
      assert.deepEqual(
        await process.cacheCounts(),
        counts,
        "unrelated runtime settings do not rebuild the view",
      );
      await writeFile(
        overlay,
        JSON.stringify({
          compaction: { modelThresholds: { "desktop-test/large": "55%" } },
          shellPath: "/bin/zsh",
        }),
      );
      policy = await process.policy();
      assert.equal(policy.target.inherited.tokens, 220000);
      assert.deepEqual(
        await process.cacheCounts(),
        counts,
        "unrelated overlay edits do not rebuild the view",
      );
      await writeFile(
        overlay,
        JSON.stringify({
          compaction: { modelThresholds: { "desktop-test/large": "65%" } },
          shellPath: "/bin/zsh",
        }),
      );
      policy = await process.policy();
      assert.equal(policy.supported, true, policy.reason);
      assert.equal(policy.target.tokens, 120000);
      assert.equal(policy.target.inherited.tokens, 260000);
      assert.equal(policy.target.inherited.source, "overlay");
      let next = await process.cacheCounts();
      assert.ok(
        next.inheritedViews > counts.inheritedViews,
        "a shadowed overlay edit refreshes the inherited view",
      );
      counts = next;
      await writeFile(
        join(project, ".omp", "config.yml"),
        JSON.stringify({
          compaction: { modelThresholds: { "desktop-test/large": "65%" } },
        }),
      );
      policy = await process.policy();
      assert.equal(
        policy.target.inherited.source,
        "overlay",
        "equal values still report the winning layer",
      );
      next = await process.cacheCounts();
      assert.ok(next.inheritedViews > counts.inheritedViews);
      counts = next;
      await writeFile(
        join(project, ".omp", "config.yml"),
        JSON.stringify({
          compaction: { modelThresholds: { "desktop-test/large": "40%" } },
        }),
      );
      policy = await process.policy();
      assert.equal(
        policy.target.inherited.tokens,
        260000,
        "overlay still shadows project",
      );
      next = await process.cacheCounts();
      assert.ok(next.inheritedViews > counts.inheritedViews);
      counts = next;
      await writeFile(overlay, JSON.stringify({ shellPath: "/bin/zsh" }));
      policy = await process.policy();
      assert.equal(policy.target.tokens, 120000);
      assert.equal(policy.target.inherited.tokens, 160000);
      assert.equal(policy.target.inherited.source, "project");
      next = await process.cacheCounts();
      assert.ok(next.inheritedViews > counts.inheritedViews);
      counts = next;
      policy = await process.policy(
        "apply",
        edit(policy, "profile", { targetPercent: 70 }),
      );
      assert.equal(policy.target.profilePercent, 70);
      assert.equal(policy.target.inherited.tokens, 160000);
      next = await process.cacheCounts();
      assert.ok(
        next.inheritedViews > counts.inheritedViews,
        "explicit profile edits refresh the view",
      );
      await process.request({
        type: "prompt",
        message: "/policy-fixture-fail-next",
      });
      const failed = await process.policy();
      assert.equal(failed.supported, false);
      assert.match(failed.reason, /Injected inherited policy read failure/);
      const failedCounts = await process.cacheCounts();
      assert.equal(
        failedCounts.inheritedViews,
        next.inheritedViews + 1,
        "a non-guard error is surfaced instead of being retried when settings also change",
      );
      policy = await process.policy();
      assert.equal(policy.supported, true, policy.reason);
      policy = await process.policy(
        "apply",
        edit(policy, "conversation", { targetPercent: null }),
      );
      assert.equal(policy.target.tokens, 160000);
      assert.equal(policy.target.source, "project");
    } finally {
      await process?.stop();
      await rm(home, { recursive: true, force: true });
    }
  },
);
test(
  "publishing an inherited view does not quarantine an invalid project file",
  {
    skip: installed.status !== 0,
    timeout: 90000,
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-native-readonly-test-"));
    const projectDir = join(home, "project", ".omp"),
      config = join(projectDir, "config.yml");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      config,
      JSON.stringify({
        compaction: {
          modelThresholds: { "desktop-test/large": "55%" },
        },
      }),
    );
    let process, handler, timer;
    try {
      process = await openNative(home, "work");
      let policy = await process.policy();
      policy = await process.policy(
        "apply",
        edit(policy, "conversation", { targetPercent: 30 }),
      );
      assert.equal(policy.target.tokens, 120000);
      await process.request({
        type: "prompt",
        message: "/policy-fixture-stop-watch",
      });
      const invalid = "compaction: [unterminated\n";
      await writeFile(config, invalid);
      const notice = new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Native invalid-config notice timed out")),
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
          if (
            response.id === null &&
            response.policy?.supported === false &&
            /invalid/i.test(response.policy.reason)
          )
            resolve(response.policy);
        };
        process.events.on("frame", handler);
      });
      await process.request({
        type: "prompt",
        message: "/policy-fixture-signal",
      });
      await notice;
      assert.equal(
        await readFile(config, "utf8"),
        invalid,
        "a read must not move or rewrite user config",
      );
    } finally {
      clearTimeout(timer);
      if (handler) process?.events.off("frame", handler);
      await process?.stop();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "legacy broad targets persist until explicitly edited for a model",
  {
    skip: installed.status !== 0,
    timeout: 90000,
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-native-legacy-test-"));
    await mkdir(join(home, "project"));
    await configure(home, "work", {
      compaction: {
        modelThresholds: {
          "desktop-test/large": "60%",
          "desktop-test/million": "70%",
        },
      },
    });
    let process;
    try {
      process = await openNative(home, "work");
      await process.request({
        type: "prompt",
        message: "/legacy-policy-fixture",
      });
      const session = await process.request({ type: "get_state" });
      await process.stop();
      process = await openNative(home, "work", session.sessionFile);
      let policy = await process.policy();
      assert.equal(policy.target.tokens, 120000);
      assert.equal(policy.target.source, "conversation");
      assert.equal(policy.target.inherited.tokens, 240000);
      const entriesBefore = (
        await process.request({ type: "get_entries" })
      ).entries.filter(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "omp-desktop:context-policy",
      );
      assert.equal(
        entriesBefore.at(-1).data.version,
        1,
        "readback does not migrate legacy metadata",
      );
      policy = await process.policy(
        "apply",
        edit(policy, "conversation", { targetPercent: 35 }),
      );
      assert.equal(policy.target.tokens, 140000);
      const entriesAfter = (
        await process.request({ type: "get_entries" })
      ).entries.filter(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "omp-desktop:context-policy",
      );
      assert.equal(entriesAfter.at(-1).data.version, 2);
      await select(process, "million");
      policy = await process.policy();
      assert.equal(
        policy.target.tokens,
        120000,
        "untouched models keep the old broad token policy",
      );
      await select(process, "large");
      policy = await process.policy();
      policy = await process.policy(
        "apply",
        edit(policy, "conversation", { targetPercent: null }),
      );
      assert.equal(policy.target.tokens, 240000);
      assert.equal(policy.target.conversationOverride, false);
      assert.equal(
        policy.controls.find((item) => item.id === "asyncEnabled").value,
        false,
      );
      await select(process, "million");
      assert.equal((await process.policy()).target.tokens, 120000);
      const editedSession = await process.request({ type: "get_state" });
      await process.stop();
      process = await openNative(home, "work", editedSession.sessionFile);
      assert.equal((await process.policy()).target.tokens, 240000);
      await select(process, "million");
      policy = await process.policy();
      assert.equal(policy.supported, true, policy.reason);
      assert.equal(
        policy.target.tokens,
        120000,
        "legacy semantics survive reopening",
      );
    } finally {
      await process?.stop();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "disabling auto-compaction retains the target and disables idle without enabling it on re-enable",
  {
    skip: installed.status !== 0,
    timeout: 90000,
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-native-idle-test-"));
    await mkdir(join(home, "project"));
    await configure(home, "work", {
      compaction: {
        idleEnabled: true,
        modelThresholds: { "desktop-test/large": "60%" },
      },
    });
    let process;
    try {
      process = await openNative(home, "work");
      let policy = await process.policy();
      assert.equal(policy.idleEnabled, true);
      const before = policy.target.tokens;
      await assert.rejects(
        process.policy(
          "apply",
          edit(policy, "conversation", { targetPercent: 1 }),
        ),
        /Target|tokens/,
      );
      assert.equal((await process.policy()).revision, policy.revision);
      policy = await process.policy(
        "apply",
        edit(policy, "conversation", { enabled: false }),
      );
      assert.equal(policy.enabled, false);
      assert.equal(policy.idleEnabled, false);
      assert.equal(policy.target.tokens, before);
      policy = await process.policy(
        "apply",
        edit(policy, "conversation", { enabled: true }),
      );
      assert.equal(policy.enabled, true);
      assert.equal(policy.idleEnabled, false);
      policy = await process.policy(
        "apply",
        edit(policy, "conversation", {}, { reset: true }),
      );
      assert.equal(policy.idleEnabled, true);
      policy = await process.policy(
        "apply",
        edit(policy, "profile", { enabled: false }),
      );
      assert.equal(policy.enabled, false);
      assert.equal(policy.idleEnabled, false);
      assert.equal(policy.target.tokens, before);
      policy = await process.policy(
        "apply",
        edit(policy, "profile", { enabled: true }),
      );
      assert.equal(policy.enabled, true);
      assert.equal(policy.idleEnabled, false);
      assert.equal(policy.target.tokens, before);
    } finally {
      await process?.stop();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "a conversation saves a percentage target for its selected model without invoking the agent",
  { skip: installed.status !== 0, timeout: 60000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-native-model-target-"));
    await mkdir(join(home, "project"));
    let process;
    try {
      process = await openNative(home, "work");
      const policy = await process.policy();
      assert.equal(policy.supported, true);
      const saved = await process.policy(
        "apply",
        edit(policy, "conversation", { targetPercent: 30 }),
      );
      assert.equal(saved.target.percent, 30);
      assert.equal(
        saved.target.tokens,
        Math.floor(saved.model.contextWindow * 0.3),
      );
      assert.equal(saved.target.conversationOverride, true);
      assert.equal(
        process.frames.some((frame) => frame.type === "agent_start"),
        false,
      );
    } finally {
      await process?.stop();
      await rm(home, { recursive: true, force: true });
    }
  },
);
