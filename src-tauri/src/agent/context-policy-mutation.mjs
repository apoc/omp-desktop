import {
  PolicyReadRace,
  plain,
  same,
  valueAt,
  activeModel,
  modelOf,
  modelKey,
  identity,
} from "./context-policy-native.mjs";

export function createPolicyMutation(
  state,
  { methodOrder, budgetBounds, inheritedSettings, snapshot },
) {
  const { api, entryType, profileId, rawOverride } = state;
  const editable = new Set([
    "enabled",
    "targetPercent",
    "method",
    "asyncEnabled",
    "midTurnEnabled",
  ]);
  const fields = ["enabled", "asyncEnabled", "midTurnEnabled"];
  const empty = () => ({ version: 2, values: {}, targets: {} });

  function restoreOwned() {
    const { settings, native, owned } = state;
    if (!settings || !native) {
      owned.clear();
      return;
    }
    for (const [id, entry] of owned) {
      const handle = native.handles[id];
      if (!same(rawOverride(handle), entry.applied)) continue;
      if (entry.previous === undefined) handle.clearOverride(settings);
      else handle.override(settings, entry.previous);
    }
    owned.clear();
  }
  function setOwned(id, value) {
    const { settings, native, owned } = state;
    const handle = native.handles[id],
      current = rawOverride(handle),
      old = owned.get(id);
    if (value === undefined) {
      if (old && same(current, old.applied)) {
        if (old.previous === undefined) handle.clearOverride(settings);
        else handle.override(settings, old.previous);
      }
      owned.delete(id);
      return;
    }
    if (old && same(current, old.applied) && same(value, old.applied)) return;
    const previous = old && same(current, old.applied) ? old.previous : current;
    handle.override(settings, value);
    owned.set(id, { previous, applied: value });
  }
  function validateValues(values, stored = false, legacy = false) {
    const allowed = legacy
      ? new Set([...fields, "method", "threshold", "budget"])
      : stored
        ? new Set([...fields, "method", "idleEnabled"])
        : editable;
    if (!plain(values) || Object.keys(values).some((key) => !allowed.has(key)))
      throw new Error("Invalid policy values");
    for (const id of [...fields, ...(stored ? ["idleEnabled"] : [])])
      if (Object.hasOwn(values, id) && typeof values[id] !== "boolean")
        throw new Error(`Invalid ${id}`);
    if (
      Object.hasOwn(values, "method") &&
      (typeof values.method !== "string" ||
        (values.method !== "native" &&
          !state.native.options.some(
            (option) => option.value === values.method,
          )))
    )
      throw new Error("Invalid compaction method");
    if (stored && values.method === "native")
      throw new Error("Invalid saved conversation policy");
    if (
      !stored &&
      Object.hasOwn(values, "targetPercent") &&
      values.targetPercent !== null &&
      (typeof values.targetPercent !== "number" ||
        !Number.isFinite(values.targetPercent) ||
        values.targetPercent < 1 ||
        values.targetPercent > 99)
    )
      throw new Error("Invalid target percentage");
    if (
      legacy &&
      ((Object.hasOwn(values, "threshold") &&
        (!["tokens", "percent"].includes(values.threshold) ||
          !Object.hasOwn(values, "budget"))) ||
        (!Object.hasOwn(values, "threshold") &&
          Object.hasOwn(values, "budget")) ||
        (Object.hasOwn(values, "budget") &&
          (typeof values.budget !== "number" ||
            !Number.isFinite(values.budget) ||
            values.budget <= 0 ||
            (values.threshold === "tokens" &&
              !Number.isSafeInteger(values.budget)) ||
            (values.threshold === "percent" &&
              (values.budget < 1 || values.budget > 99)))))
    )
      throw new Error("Invalid saved conversation policy");
  }
  function decode(data) {
    if (
      !plain(data) ||
      data.profileId !== profileId ||
      typeof data.sessionId !== "string"
    )
      return null;
    if (data.version === 1) {
      validateValues(data.values, true, true);
      const values = { ...data.values },
        legacy = Object.hasOwn(values, "threshold")
          ? { threshold: values.threshold, budget: values.budget }
          : undefined;
      delete values.threshold;
      delete values.budget;
      return { version: 1, values, targets: {}, ...(legacy ? { legacy } : {}) };
    }
    if (data.version !== 2 || !plain(data.targets)) return null;
    validateValues(data.values, true);
    if (data.legacy !== undefined) {
      if (!plain(data.legacy))
        throw new Error("Invalid saved conversation policy");
      validateValues(data.legacy, true, true);
      if (!Object.hasOwn(data.legacy, "threshold"))
        throw new Error("Invalid saved conversation policy");
    }
    const entries = Object.entries(data.targets);
    if (entries.length > 128) throw new Error("Too many saved model targets");
    for (const [key, target] of entries) {
      if (
        key.length > 512 ||
        !/^[^/]+\/.+$/.test(key) ||
        !plain(target) ||
        Object.keys(target).some(
          (name) => !["percent", "window"].includes(name),
        ) ||
        (target.percent !== null &&
          (typeof target.percent !== "number" ||
            !Number.isFinite(target.percent) ||
            target.percent < 1 ||
            target.percent > 99)) ||
        !Number.isSafeInteger(target.window) ||
        target.window <= 0 ||
        (target.percent === null && !data.legacy)
      )
        throw new Error("Invalid saved model target");
    }
    return {
      version: 2,
      values: { ...data.values },
      targets: { ...data.targets },
      ...(data.legacy ? { legacy: { ...data.legacy } } : {}),
    };
  }
  function encode(conversation, sessionId) {
    if (conversation.version === 1)
      return {
        version: 1,
        profileId,
        sessionId,
        values: { ...conversation.values, ...conversation.legacy },
      };
    return {
      version: 2,
      profileId,
      sessionId,
      values: conversation.values,
      targets: conversation.targets,
      ...(conversation.legacy ? { legacy: conversation.legacy } : {}),
    };
  }
  async function planOverrides(ctx, conversation) {
    const { native, owned } = state,
      h = native.handles,
      plan = {};
    for (const id of [...fields, "idleEnabled"])
      if (Object.hasOwn(conversation.values, id))
        plan[id] = conversation.values[id];
    if (Object.hasOwn(conversation.values, "method"))
      plan.methodOrder = methodOrder(conversation.values.method);
    const targets = Object.entries(conversation.targets),
      legacy = conversation.legacy;
    if (legacy) {
      plan.thresholdTokens = legacy.threshold === "tokens" ? legacy.budget : -1;
      plan.thresholdPercent =
        legacy.threshold === "percent" ? legacy.budget : -1;
      // Version 1 intentionally suppressed all model rules. Preserve that behavior
      // for untouched models, even after a particular model is explicitly edited.
      plan.modelThresholdsEnabled = false;
    }
    if (targets.length) {
      const current = rawOverride(h.modelThresholds),
        old = owned.get("modelThresholds");
      const previous =
        old && same(current, old.applied) ? old.previous : current;
      const map = plain(previous) ? { ...previous } : {};
      let baseline;
      if (legacy) {
        baseline = await inheritedSettings(ctx);
        plan.modelThresholdsEnabled = h.modelThresholdsEnabled.get(baseline);
        for (const key of Object.keys(h.modelThresholds.get(baseline)))
          map[key] = null;
      }
      for (const [key, target] of targets) {
        if (target.percent !== null) map[key] = `${target.percent}%`;
        else {
          const slash = key.indexOf("/"),
            model = {
              provider: key.slice(0, slash),
              id: key.slice(slash + 1),
              contextWindow: target.window,
            };
          const policy = native.resolve(baseline, model);
          map[key] =
            `f${native.engine.resolveThresholdTokens(target.window, policy)}`;
        }
      }
      plan.modelThresholds = map;
    }
    for (const [id, value] of Object.entries(plan)) h[id].assertWritable(value);
    return plan;
  }
  async function installConversation(ctx, conversation) {
    const session = identity(ctx),
      model = modelOf(ctx),
      generation = state.generation,
      settings = state.settings,
      settingsRevision = settings.revision;
    const plan = await planOverrides(ctx, conversation);
    if (
      !same(session, identity(ctx)) ||
      !same(session, state.activeSession) ||
      !same(model, modelOf(ctx)) ||
      generation !== state.generation ||
      settings !== state.settings ||
      settingsRevision !== settings.revision
    )
      throw new PolicyReadRace(
        "The conversation, model or policy changed; reload before applying",
      );
    const keys = new Set([...state.owned.keys(), ...Object.keys(plan)]);
    for (const id of keys) setOwned(id, plan[id]);
    state.conversation = conversation;
    return {
      generation: state.generation,
      settingsRevision: settings.revision,
      settings,
    };
  }
  async function restoreBranch(ctx) {
    restoreOwned();
    state.conversation = empty();
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "custom" || entry.customType !== entryType) continue;
      // Branched sessions carry their ancestor's entries under a new session ID.
      const conversation = decode(entry.data);
      if (!conversation) continue;
      await installConversation(ctx, conversation);
      break;
    }
  }
  async function refreshConversation(ctx) {
    await installConversation(ctx, state.conversation);
  }
  function normalizeChanges(request) {
    const values = request.values ?? {};
    validateValues(values);
    return { ...values };
  }
  function validateHeadroom(ctx, changes) {
    const percent = changes.targetPercent;
    if (percent === undefined || percent === null) return;
    const { native, settings } = state,
      model = activeModel(ctx),
      window = model.contextWindow;
    const policy = native.resolve(settings, model);
    const bounds = budgetBounds(window, policy);
    const trigger = native.engine.resolveThresholdTokens(window, {
      ...policy,
      baseWindowTokens: undefined,
      thresholdTokens: -1,
      thresholdPercent: percent,
    });
    if (
      percent < bounds.percent.min ||
      percent > bounds.percent.max ||
      trigger < bounds.tokens.min ||
      trigger > bounds.tokens.max
    )
      throw new Error(
        `Target must be between ${bounds.tokens.min} and ${bounds.tokens.max} tokens to leave room for native compaction.`,
      );
  }
  function profilePlan(changes, reset, model) {
    const { native } = state,
      plan = {};
    if (reset) {
      for (const id of [
        "enabled",
        "idleEnabled",
        "thresholdTokens",
        "thresholdPercent",
        "methodOrder",
        "asyncEnabled",
        "midTurnEnabled",
      ])
        plan[id] = undefined;
      plan.modelTarget = { key: modelKey(model), value: undefined };
    } else {
      for (const id of fields)
        if (Object.hasOwn(changes, id)) plan[id] = changes[id];
      if (changes.enabled === false) plan.idleEnabled = false;
      if (Object.hasOwn(changes, "method"))
        plan.methodOrder = methodOrder(changes.method);
      if (Object.hasOwn(changes, "targetPercent"))
        plan.modelTarget = {
          key: modelKey(model),
          value:
            changes.targetPercent === null
              ? undefined
              : `${changes.targetPercent}%`,
        };
    }
    for (const [id, value] of Object.entries(plan)) {
      if (id === "modelTarget") {
        if (value.value !== undefined)
          native.handles.modelThresholds.assertWritable({
            [value.key]: value.value,
          });
      } else if (value !== undefined) native.handles[id].assertWritable(value);
    }
    return plan;
  }
  async function writeProfile(plan, isCurrent, refresh) {
    const { settings, native } = state,
      before = settings.getGlobalSettings();
    const apply = (id, value) => {
      if (id === "modelTarget")
        native.handles.modelThresholds.setEntry(
          settings,
          value.key,
          value.value,
        );
      else if (value === undefined) native.handles[id].unset(settings);
      else native.handles[id].set(settings, value);
    };
    const policyLayers = () => {
      const global = settings.getGlobalSettings(),
        project = settings.getProjectSettings();
      return Object.values(native.handles).map((handle) => [
        valueAt(global, handle.segments),
        valueAt(project, handle.segments),
        handle.get(settings),
        settings.getProvenance(handle),
      ]);
    };
    try {
      for (const [id, value] of Object.entries(plan)) apply(id, value);
      const expectedGeneration = state.generation,
        expectedLayers = policyLayers();
      const check = () => {
        if (
          !isCurrent() ||
          settings !== state.settings ||
          state.generation !== expectedGeneration ||
          !same(expectedLayers, policyLayers())
        )
          throw new Error(
            "The conversation, model or policy changed during the update",
          );
      };
      await settings.flush();
      check();
      await settings.reloadFromDisk();
      check();
      await refresh();
      if (!isCurrent() || settings !== state.settings)
        throw new Error("The conversation or model changed during the update");
    } catch (error) {
      let repairError;
      try {
        for (const [id, value] of Object.entries(plan)) {
          if (id === "modelTarget") {
            const previous = valueAt(
              before,
              native.handles.modelThresholds.segments,
            )?.[value.key];
            apply(id, { key: value.key, value: previous ?? undefined });
          } else {
            const previous = valueAt(before, native.handles[id].segments);
            apply(id, previous ?? undefined);
          }
        }
        await settings.flush();
        await settings.reloadFromDisk();
        if (isCurrent() && settings === state.settings) await refresh();
      } catch (failure) {
        repairError = failure;
      }
      throw new Error(
        `Could not persist profile policy: ${error.message}${repairError ? `; restoration failed: ${repairError.message}` : ""}`,
      );
    }
  }
  async function writeConversation(
    ctx,
    changes,
    reset,
    session,
    model,
    revision,
  ) {
    const manager = ctx.sessionManager;
    if (
      !session.file ||
      typeof manager.ensureOnDisk !== "function" ||
      typeof manager.flush !== "function"
    )
      throw new Error(
        "Native conversation policy persistence is unavailable in this session",
      );
    const previous = state.conversation;
    const next = reset
      ? empty()
      : {
          version: 2,
          values: { ...previous.values },
          targets: { ...previous.targets },
          ...(previous.legacy ? { legacy: { ...previous.legacy } } : {}),
        };
    if (!reset) {
      for (const id of fields)
        if (Object.hasOwn(changes, id)) next.values[id] = changes[id];
      if (changes.enabled === false) next.values.idleEnabled = false;
      if (Object.hasOwn(changes, "method")) {
        if (changes.method === "native") delete next.values.method;
        else next.values.method = changes.method;
      }
      if (Object.hasOwn(changes, "targetPercent")) {
        const key = modelKey(model);
        if (key.length > 512) throw new Error("Model identifier is too long");
        if (changes.targetPercent === null && !next.legacy)
          delete next.targets[key];
        else
          next.targets[key] = {
            percent: changes.targetPercent,
            window: model.contextWindow,
          };
      }
    }
    if (Object.keys(next.targets).length > 128)
      throw new Error("Too many conversation model targets");
    validateValues(next.values, true);
    await manager.ensureOnDisk();
    const isCurrent = () =>
      same(session, identity(ctx)) &&
      same(session, state.activeSession) &&
      same(model, modelOf(ctx));
    const snapshotGeneration = state.generation,
      snapshotSettings = state.settings,
      snapshotSettingsRevision = snapshotSettings.revision;
    if (
      !isCurrent() ||
      (await snapshot(ctx)).revision !== revision ||
      !isCurrent() ||
      snapshotGeneration !== state.generation ||
      snapshotSettings !== state.settings ||
      snapshotSettingsRevision !== snapshotSettings.revision
    )
      throw new Error(
        "The conversation, model or policy changed; reload before applying",
      );
    const entry = (values) =>
      api.appendEntry(entryType, encode(values, session.id));
    let appended = false;
    try {
      const installed = await installConversation(ctx, next);
      const check = () => {
        if (
          !isCurrent() ||
          state.conversation !== next ||
          installed.settings !== state.settings ||
          installed.generation !== state.generation ||
          installed.settingsRevision !== installed.settings.revision
        )
          throw new Error(
            "The conversation, model or policy changed during the update",
          );
      };
      check();
      entry(next);
      appended = true;
      await manager.flush();
      check();
    } catch (error) {
      let repairError;
      if (same(session, identity(ctx)) && same(session, state.activeSession)) {
        try {
          await installConversation(ctx, previous);
          if (appended) {
            entry(previous);
            try {
              await manager.flush();
            } catch (flushError) {
              if (
                typeof manager.recoverPersistenceFromCurrentState !== "function"
              )
                throw flushError;
              await manager.recoverPersistenceFromCurrentState();
            }
          }
        } catch (failure) {
          repairError = failure;
        }
      } else if (appended)
        repairError = new Error(
          "The session changed before its policy entry could be restored",
        );
      throw new Error(
        `Could not persist conversation policy: ${error.message}${repairError ? `; restoration failed: ${repairError.message}` : ""}`,
      );
    }
  }
  return {
    restoreOwned,
    restoreBranch,
    refreshConversation,
    normalizeChanges,
    validateHeadroom,
    profilePlan,
    writeProfile,
    writeConversation,
  };
}
