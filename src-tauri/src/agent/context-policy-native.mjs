import { createHash } from "node:crypto";

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
export const identity = (ctx) => ({
  id: ctx.sessionManager.getSessionId(),
  file: ctx.sessionManager.getSessionFile() ?? null,
});

export function createPolicyNative(state) {
  const { profileId, rawOverride } = state;
  let nativePromise;
  const ids = [
    "enabled",
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
    thresholdTokens: null,
    source: "unavailable",
    revision: "",
    conversationOverride: false,
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
      ]).then(([root, registry, model, matching, engine]) => {
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
          typeof root.SettingsManager?.create !== "function" ||
          typeof root.getAgentDir !== "function" ||
          typeof model.resolveModelCompactionSettings !== "function" ||
          typeof matching.matchModelCompactionThreshold !== "function" ||
          typeof engine.resolveThresholdTokens !== "function" ||
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
  function thresholdValue(tokens, percent) {
    return tokens > 0
      ? { threshold: "tokens", budget: tokens }
      : percent > 0
        ? { threshold: "percent", budget: percent }
        : { threshold: "inherit", budget: 0 };
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
      ...thresholdValue(get("thresholdTokens"), get("thresholdPercent")),
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
    // OMP caps retention to the recovery band on small windows. Keep the editor
    // usable there while preferring room above the configured retained tail.
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
    // Account for the native resolver's floor and floating-point rounding.
    if (percentTrigger(minPercent) < min)
      minPercent += Number.EPSILON * Math.max(1, minPercent);
    if (percentTrigger(maxPercent) > ceiling)
      maxPercent -= Number.EPSILON * Math.max(1, maxPercent);
    return {
      tokens: { min, max: ceiling },
      percent: { min: minPercent, max: maxPercent },
    };
  }
  function controls(values, bounds) {
    const { native } = state;
    const h = native.handles;
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
      field(
        "threshold",
        h.thresholdPercent,
        "select",
        values.threshold,
        "inherit",
        {
          options: [
            {
              value: "inherit",
              label: "Native default",
              description: "Use the native reserve-based threshold.",
            },
            {
              value: "tokens",
              label: "Tokens",
              description: h.thresholdTokens.ui?.description,
            },
            {
              value: "percent",
              label: "Percent",
              description: h.thresholdPercent.ui?.description,
            },
          ],
        },
      ),
      field(
        "budget",
        values.threshold === "percent" ? h.thresholdPercent : h.thresholdTokens,
        "number",
        values.budget,
        0,
        bounds[values.threshold === "percent" ? "percent" : "tokens"],
      ),
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
  function provenance(handle) {
    const { settings } = state;
    const env = handle.envValue?.();
    if (
      env !== undefined &&
      (!handle.envFallback || !settings.isConfigured(handle))
    )
      return "environment";
    const source = settings.getProvenance(handle);
    return source === "global" ? "profile" : source;
  }
  function snapshot(ctx) {
    const { native, settings, owned, conversation } = state;
    const h = native.handles,
      model = modelOf(ctx);
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
    const resolved = native.resolve(settings, activeModel(ctx));
    const thresholds = h.modelThresholdsEnabled.get(settings)
      ? h.modelThresholds.get(settings)
      : undefined;
    const match = native.match(thresholds, activeModel(ctx));
    const effective = {
      enabled: resolved.enabled,
      ...thresholdValue(resolved.thresholdTokens, resolved.thresholdPercent),
      method: methodValue(resolved.methodOrder),
      asyncEnabled: resolved.asyncEnabled,
      midTurnEnabled: resolved.midTurnEnabled,
    };
    const sourceParts = [];
    if (match) sourceParts.push(`model ${match.key}`);
    const relevant = [
      "enabled",
      "thresholdTokens",
      "thresholdPercent",
      "methodOrder",
      "asyncEnabled",
      "midTurnEnabled",
    ];
    const sources = relevant.map((id) => {
      const source = provenance(h[id]);
      return source === "runtime" &&
        owned.has(id) &&
        same(rawOverride(h[id]), owned.get(id).applied)
        ? "conversation"
        : source === "runtime"
          ? "native runtime"
          : source;
    });
    sourceParts.push(...sources);
    const saved = savedValues(),
      bounds = budgetBounds(model.contextWindow, resolved);
    const session = identity(ctx);
    const policy = {
      supported: true,
      profileId,
      sessionId: session.id,
      sessionFile: session.file,
      model,
      enabled: resolved.enabled && resolved.strategy !== "off",
      thresholdTokens:
        resolved.enabled && resolved.strategy !== "off"
          ? native.engine.resolveThresholdTokens(model.contextWindow, resolved)
          : null,
      source: [...new Set(sourceParts)].join(" / "),
      conversationOverride: Object.keys(conversation).length > 0,
      controls: controls(effective, bounds),
      profileControls: controls(saved, bounds),
      budgetBounds: bounds,
      methodOrder: resolved.methodOrder,
      profileMethodOrder: saved.methodOrder,
      methods: native.options.map((option) => option.value),
    };
    const raw = settings.getGlobalSettings();
    const layers = ids.map((id) => [
      id,
      valueAt(raw, h[id].segments),
      h[id].get(settings),
      provenance(h[id]),
    ]);
    policy.revision = createHash("sha256")
      .update(JSON.stringify([policy, layers, conversation]))
      .digest("hex");
    return policy;
  }

  return { loadNative, methodOrder, budgetBounds, snapshot, unsupported };
}
