import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const valueAt = (object, segments) =>
  segments.reduce((value, key) => value?.[key], object);
export const activeModel = (ctx) =>
  typeof ctx.models?.current === "function" ? ctx.models.current() : ctx.model;
export const modelOf = (ctx) => {
  const model = activeModel(ctx);
  return {
    provider: model?.provider ?? "",
    id: model?.id ?? "",
    contextWindow: model?.contextWindow ?? null,
  };
};
export const modelKey = (model) => `${model.provider}/${model.id}`;
export const identity = (ctx) => ({
  id: ctx.sessionManager.getSessionId(),
  file: ctx.sessionManager.getSessionFile() ?? null,
});
export class PolicyReadRace extends Error {}

export function createPolicyNative(state) {
  const { profileId, rawOverride } = state;
  let nativePromise, inheritedCache, overlayFilesCache;
  const overlayLayers = new WeakMap();
  const ids = [
    "enabled",
    "idleEnabled",
    "thresholdTokens",
    "thresholdPercent",
    "methodOrder",
    "asyncEnabled",
    "midTurnEnabled",
    "modelThresholds",
    "modelThresholdsEnabled",
    "reserveTokens",
    "keepRecentTokens",
  ];
  const unsupported = (ctx, reason) => ({
    supported: false,
    reason,
    profileId,
    model: modelOf(ctx),
    enabled: false,
    source: "unavailable",
    revision: "",
    controls: [],
    profileControls: [],
  });
  async function loadNative() {
    if (!nativePromise)
      nativePromise = Promise.all([
        import("@oh-my-pi/pi-coding-agent"),
        import("@oh-my-pi/pi-coding-agent/config/registry"),
        import("@oh-my-pi/pi-coding-agent/session/model-compaction-threshold"),
        import("@oh-my-pi/pi-coding-agent/config/compaction-threshold"),
        import("@oh-my-pi/pi-agent-core/compaction"),
        import("bun"),
      ]).then(([root, registry, model, matching, engine, bun]) => {
        const handles = Object.fromEntries(
          ids.map((id) => [id, registry.lookup(`compaction.${id}`)]),
        );
        for (const [id, handle] of Object.entries(handles)) {
          if (
            !handle ||
            ![
              "get",
              "set",
              "unset",
              "override",
              "clearOverride",
              "assertWritable",
            ].every((key) => typeof handle[key] === "function")
          )
            throw new Error(`Native compaction setting ${id} is unavailable`);
        }
        if (
          typeof handles.modelThresholds.setEntry !== "function" ||
          typeof root.SettingsManager?.create !== "function" ||
          typeof root.getAgentDir !== "function" ||
          typeof root.Settings?.loadReadOnly !== "function" ||
          typeof model.resolveModelCompactionSettings !== "function" ||
          typeof matching.matchModelCompactionThreshold !== "function" ||
          typeof engine.resolveThresholdTokens !== "function" ||
          typeof bun.YAML?.parse !== "function" ||
          typeof engine.promptBudgetTokens !== "function"
        )
          throw new Error("Native compaction resolver is unavailable");
        const options = handles.methodOrder.ui?.options;
        if (
          !Array.isArray(options) ||
          !options.length ||
          !Array.isArray(handles.methodOrder.default) ||
          options.some(
            (item) =>
              typeof item.value !== "string" || typeof item.label !== "string",
          )
        )
          throw new Error("Native compaction method metadata is unavailable");
        return {
          root,
          handles,
          resolve: model.resolveModelCompactionSettings,
          match: matching.matchModelCompactionThreshold,
          yaml: bun.YAML,
          engine,
          options,
        };
      });
    return nativePromise;
  }
  function methodOrder(value) {
    const { native } = state;
    if (value === "native") return undefined;
    const allowed = native.options.map((option) => option.value);
    if (!allowed.includes(value))
      throw new Error("Unknown native compaction method");
    return [
      value,
      ...native.handles.methodOrder.default.filter((item) => item !== value),
    ];
  }
  function methodValue(order) {
    const { native } = state;
    if (same(order, native.handles.methodOrder.default)) return "native";
    return Array.isArray(order) && typeof order[0] === "string"
      ? order[0]
      : "none";
  }
  function savedValues() {
    const { native, settings } = state;
    const raw = settings.getGlobalSettings(),
      h = native.handles;
    const get = (id) => {
      const value = valueAt(raw, h[id].segments);
      if (value === undefined || value === null) return h[id].default;
      if (!h[id].accepts(value))
        throw new Error(
          `Saved profile setting ${h[id].id} has an invalid value`,
        );
      return value;
    };
    const order = get("methodOrder");
    return {
      enabled: get("enabled"),
      method: methodValue(order),
      methodOrder: order,
      asyncEnabled: get("asyncEnabled"),
      midTurnEnabled: get("midTurnEnabled"),
    };
  }
  function budgetBounds(window, policy) {
    const { native } = state;
    const ceiling = native.engine.promptBudgetTokens(window, policy);
    const retained = Number.isFinite(policy.keepRecentTokens)
      ? Math.max(0, policy.keepRecentTokens)
      : 0;
    const min = Math.min(ceiling, Math.max(1, Math.ceil(retained) + 1));
    let minPercent = Math.max(1, (min * 100) / window);
    let maxPercent = Math.min(99, (ceiling * 100) / window);
    const percentTrigger = (percent) =>
      native.engine.resolveThresholdTokens(window, {
        ...policy,
        baseWindowTokens: undefined,
        thresholdTokens: -1,
        thresholdPercent: percent,
      });
    if (percentTrigger(minPercent) < min)
      minPercent += Number.EPSILON * Math.max(1, minPercent);
    if (percentTrigger(maxPercent) > ceiling)
      maxPercent -= Number.EPSILON * Math.max(1, maxPercent);
    return {
      tokens: { min, max: ceiling },
      percent: { min: minPercent, max: maxPercent },
    };
  }
  function controls(values) {
    const { native } = state,
      h = native.handles;
    const field = (id, handle, type, value, defaultValue, extra = {}) => ({
      id,
      label: handle.ui?.label ?? id,
      description: handle.ui?.description ?? "",
      type,
      value,
      defaultValue,
      ...extra,
    });
    return [
      field("enabled", h.enabled, "boolean", values.enabled, h.enabled.default),
      field("method", h.methodOrder, "select", values.method, "native", {
        description:
          `Choose a preferred method; omp tries the native fallback order afterward. ${h.methodOrder.ui?.description ?? ""}`.trim(),
        options: [
          {
            value: "native",
            label: "Native default",
            description: "Use the native method order.",
          },
          ...native.options,
        ],
      }),
      field(
        "asyncEnabled",
        h.asyncEnabled,
        "boolean",
        values.asyncEnabled,
        h.asyncEnabled.default,
      ),
      field(
        "midTurnEnabled",
        h.midTurnEnabled,
        "boolean",
        values.midTurnEnabled,
        h.midTurnEnabled.default,
      ),
    ];
  }
  function provenance(settings, handle) {
    const env = handle.envValue?.();
    if (
      env !== undefined &&
      (!handle.envFallback || !settings.isConfigured(handle))
    )
      return "environment";
    const source = settings.getProvenance(handle);
    return source === "global"
      ? "profile"
      : source === "runtime"
        ? "native runtime"
        : source;
  }
  // An inherited view must not temporarily clear live overrides. Build it with
  // OMP's non-persisting settings loader instead: cloneForCwd can quarantine a
  // malformed project file and registers another long-lived native WeakRef.
  // Cache by policy inputs, not by the Settings revision (which also changes
  // for no-op reloads and unrelated settings).
  async function inheritedSettings(ctx) {
    const { settings, native, owned } = state;
    if (owned.size === 0) {
      overlayLayers.delete(settings);
      return settings;
    }
    const h = native.handles,
      global = settings.getGlobalSettings(),
      project = settings.getProjectSettings(),
      overrides = settings.overlayLayers().overrides,
      files = settings.getConfigFiles(),
      revision = settings.revision;
    const entries = ids.map((id) => {
      const handle = h[id],
        current = valueAt(overrides, handle.segments),
        own = owned.get(id);
      const previous =
        own && same(current, own.applied) ? own.previous : current;
      return [
        id,
        valueAt(global, handle.segments),
        valueAt(project, handle.segments),
        previous,
        current,
        handle.get(settings),
        provenance(settings, handle),
        handle.envValue?.(),
      ];
    });
    let overlayStamp = "",
      layers = [];
    if (files.length) {
      if (
        !overlayFilesCache ||
        overlayFilesCache.settings !== settings ||
        overlayFilesCache.revision !== revision ||
        !same(overlayFilesCache.files, files)
      ) {
        const pending = Promise.all(
          files.map((file) => readFile(file, "utf8")),
        ).then((contents) => {
          const policyLayers = contents.map((content) => {
            const parsed = native.yaml.parse(content);
            if (parsed == null) return {};
            if (!plain(parsed))
              throw new Error("Config overlay must be a YAML mapping");
            return Object.fromEntries(
              Object.entries(parsed).filter(
                ([key]) =>
                  key === "compaction" || key.startsWith("compaction."),
              ),
            );
          });
          return {
            layers: policyLayers,
            stamp: createHash("sha256")
              .update(JSON.stringify(policyLayers))
              .digest("hex"),
          };
        });
        overlayFilesCache = { settings, revision, files, pending };
      }
      ({ stamp: overlayStamp, layers } = await overlayFilesCache.pending);
      if (settings !== state.settings || settings.revision !== revision)
        throw new PolicyReadRace(
          "The policy changed while reading its config overlays",
        );
    }
    overlayLayers.set(settings, layers);
    const keyEntries = entries.map(
      ([
        id,
        globalValue,
        projectValue,
        previous,
        current,
        effective,
        source,
        env,
      ]) => [
        id,
        globalValue,
        projectValue,
        previous === undefined ? [false] : [true, previous],
        current === undefined ? [false] : [true, current],
        effective,
        source,
        env,
      ],
    );
    const key = JSON.stringify([
      ctx.cwd,
      settings.getAgentDir(),
      files,
      overlayStamp,
      keyEntries,
    ]);
    if (inheritedCache?.settings === settings && inheritedCache.key === key)
      return await inheritedCache.pending;
    const pending = (async () => {
      // Settings automatically prepends PI_CONFIG_FILES to configFiles.
      const envFiles = (process.env.PI_CONFIG_FILES ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((file) =>
          path.resolve(
            ctx.cwd,
            file === "~"
              ? os.homedir()
              : file.startsWith("~/")
                ? path.join(os.homedir(), file.slice(2))
                : file,
          ),
        );
      if (envFiles.some((file, index) => files[index] !== file))
        throw new Error(
          "The native config overlay environment changed; reload the session",
        );
      const copy = await native.root.Settings.loadReadOnly({
        cwd: ctx.cwd,
        agentDir: settings.getAgentDir(),
        configFiles: files.slice(envFiles.length),
      });
      const diskProject = copy.getProjectSettings(),
        diskGlobal = copy.getGlobalSettings();
      const tombstones = {};
      for (const [id, globalValue, projectValue, previous] of entries) {
        const handle = h[id];
        if (!same(projectValue, valueAt(diskProject, handle.segments)))
          throw new PolicyReadRace(
            "The native project policy changed while it was being read",
          );
        if (!same(globalValue, valueAt(diskGlobal, handle.segments))) {
          if (globalValue === undefined || globalValue === null)
            handle.unset(copy);
          else handle.set(copy, globalValue);
        }
        if (previous === null) tombstones[handle.id] = null;
      }
      const view = Object.keys(tombstones).length
        ? copy.overlay(tombstones)
        : copy;
      for (const [id, , , previous] of entries)
        if (previous !== undefined && previous !== null)
          h[id].override(view, previous);
      overlayLayers.set(view, layers);
      return view;
    })();
    const item = { settings, key, pending };
    inheritedCache = item;
    try {
      return await pending;
    } catch (error) {
      if (inheritedCache === item) inheritedCache = undefined;
      throw error;
    }
  }
  function describe(settings, model) {
    const { native } = state,
      h = native.handles;
    const policy = native.resolve(settings, model);
    const thresholds = h.modelThresholdsEnabled.get(settings)
      ? h.modelThresholds.get(settings)
      : undefined;
    const match = native.match(thresholds, model);
    const tokens = native.engine.resolveThresholdTokens(
      model.contextWindow,
      policy,
    );
    let mode =
      policy.thresholdTokens > 0
        ? "tokens"
        : policy.thresholdPercent > 0
          ? "percent"
          : "native";
    let source;
    if (match) {
      if (match.threshold.thresholdTokens > 0 && !match.threshold.fixed)
        mode = "native";
      const current = thresholds?.[match.key];
      const runtime = valueAt(
        settings.overlayLayers().overrides,
        h.modelThresholds.segments,
      );
      const project = valueAt(
        settings.getProjectSettings(),
        h.modelThresholds.segments,
      );
      const global = valueAt(
        settings.getGlobalSettings(),
        h.modelThresholds.segments,
      );
      const overall = provenance(settings, h.modelThresholds);
      let overlayValue;
      for (const layer of overlayLayers.get(settings) ?? []) {
        const compaction = layer.compaction;
        if (compaction === null || compaction?.modelThresholds === null)
          overlayValue = undefined;
        const record = compaction?.modelThresholds;
        if (plain(record) && Object.hasOwn(record, match.key))
          overlayValue = record[match.key];
      }
      if (
        plain(runtime) &&
        Object.hasOwn(runtime, match.key) &&
        same(runtime[match.key], current)
      )
        source = "native runtime";
      else if (overall === "environment") source = overall;
      else if (
        overlayValue !== undefined &&
        overlayValue !== null &&
        same(overlayValue, current)
      )
        source = "overlay";
      else if (
        overall === "overlay" &&
        (!plain(project) || !same(project[match.key], current))
      )
        source = "overlay";
      else if (
        plain(project) &&
        Object.hasOwn(project, match.key) &&
        same(project[match.key], current)
      )
        source = "project";
      else if (
        plain(global) &&
        Object.hasOwn(global, match.key) &&
        same(global[match.key], current)
      )
        source = "profile";
      else source = overall;
    } else {
      const id =
        policy.thresholdTokens > 0
          ? "thresholdTokens"
          : policy.thresholdPercent > 0
            ? "thresholdPercent"
            : "reserveTokens";
      source = provenance(settings, h[id]);
    }
    return {
      percent: (tokens / model.contextWindow) * 100,
      tokens,
      mode,
      source,
    };
  }
  async function snapshot(ctx) {
    const { native, settings, owned, conversation } = state;
    const h = native.handles,
      model = modelOf(ctx),
      session = identity(ctx),
      generation = state.generation,
      settingsRevision = settings.revision;
    if (
      !model.provider ||
      !model.id ||
      !Number.isFinite(model.contextWindow) ||
      model.contextWindow <= 0
    )
      return unsupported(
        ctx,
        "The active model and context window are not available.",
      );
    const inherited = await inheritedSettings(ctx);
    if (
      generation !== state.generation ||
      settingsRevision !== settings.revision ||
      settings !== state.settings ||
      conversation !== state.conversation ||
      !same(session, identity(ctx)) ||
      !same(session, state.activeSession) ||
      !same(model, modelOf(ctx))
    )
      throw new PolicyReadRace(
        "The conversation, model or policy changed; reload the policy",
      );
    const resolved = native.resolve(settings, activeModel(ctx));
    const base = describe(inherited, model);
    const actual = describe(settings, model);
    const key = modelKey(model);
    const selected = conversation.targets?.[key];
    const legacy = conversation.legacy;
    const thresholdsEnabled = h.modelThresholdsEnabled.get(settings);
    const ownedMap = owned.get("modelThresholds");
    const ownMapActive =
      ownedMap && same(rawOverride(h.modelThresholds), ownedMap.applied);
    const ownThresholdActive =
      legacy &&
      ["thresholdTokens", "thresholdPercent"].every((id) => {
        const item = owned.get(id);
        return (
          item &&
          same(rawOverride(h[id]), item.applied) &&
          same(h[id].get(settings), item.applied) &&
          provenance(settings, h[id]) !== "environment"
        );
      });
    const match = thresholdsEnabled
      ? native.match(h.modelThresholds.get(settings), model)
      : undefined;
    const targetApplied =
      selected?.percent != null &&
      ownMapActive &&
      match?.key === key &&
      h.modelThresholds.get(settings)[key] === `${selected.percent}%`;
    const resetApplied =
      selected?.percent === null && ownMapActive && match?.key === key;
    if (targetApplied || (ownThresholdActive && !match))
      actual.source = "conversation";
    else if (resetApplied) {
      actual.source = base.source;
      actual.mode = base.mode;
    }
    const global = valueAt(
      settings.getGlobalSettings(),
      h.modelThresholds.segments,
    );
    const profileEntry = plain(global) ? global[key] : undefined;
    const profileMatch =
      typeof profileEntry === "string" &&
      /^(\d+(?:\.\d+)?)%$/.exec(profileEntry.trim());
    const target = {
      ...actual,
      conversationOverride:
        selected?.percent != null || (!!legacy && selected === undefined),
      profileOverride: profileEntry !== undefined && profileEntry !== null,
      profilePercent: profileMatch ? Number(profileMatch[1]) : null,
      conversationPercent: selected?.percent ?? null,
      inherited: base,
    };
    const effective = {
      enabled: resolved.enabled,
      method: methodValue(resolved.methodOrder),
      asyncEnabled: resolved.asyncEnabled,
      midTurnEnabled: resolved.midTurnEnabled,
    };
    const saved = savedValues(),
      bounds = budgetBounds(model.contextWindow, resolved);
    const policy = {
      supported: true,
      profileId,
      sessionId: session.id,
      sessionFile: session.file,
      model,
      enabled: resolved.enabled && resolved.strategy !== "off",
      idleEnabled: resolved.idleEnabled,
      thresholdTokens: actual.tokens,
      source: actual.source,
      target,
      controls: controls(effective),
      profileControls: controls(saved),
      budgetBounds: bounds,
      methodOrder: resolved.methodOrder,
      profileMethodOrder: saved.methodOrder,
      methods: native.options.map((option) => option.value),
      lastMaintenance: null,
    };
    const raw = settings.getGlobalSettings();
    const layers = ids.map((id) => [
      id,
      valueAt(raw, h[id].segments),
      h[id].get(settings),
      provenance(settings, h[id]),
    ]);
    policy.revision = createHash("sha256")
      .update(JSON.stringify([policy, layers, conversation]))
      .digest("hex");
    return policy;
  }
  return {
    loadNative,
    methodOrder,
    budgetBounds,
    inheritedSettings,
    snapshot,
    unsupported,
  };
}
