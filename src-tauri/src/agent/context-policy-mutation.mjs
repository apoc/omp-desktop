import {
  plain,
  same,
  valueAt,
  activeModel,
  modelOf,
  identity,
} from "./context-policy-native.mjs";

export function createPolicyMutation(
  state,
  { methodOrder, budgetBounds, snapshot },
) {
  const { api, entryType, profileId, rawOverride } = state;
  const editable = new Set([
    "enabled",
    "threshold",
    "budget",
    "method",
    "asyncEnabled",
    "midTurnEnabled",
  ]);
  function restoreOwned() {
    const { settings, native, owned } = state;
    if (!settings || !native) {
      owned.clear();
      return;
    }
    for (const [id, state] of owned) {
      const handle = native.handles[id];
      if (!same(rawOverride(handle), state.applied)) continue;
      if (state.previous === undefined) handle.clearOverride(settings);
      else handle.override(settings, state.previous);
    }
    owned.clear();
  }
  function setOwned(id, value) {
    const { settings, native, owned } = state;
    const handle = native.handles[id];
    const current = rawOverride(handle);
    const old = owned.get(id);
    if (value === undefined) {
      if (old && same(current, old.applied)) {
        if (old.previous === undefined) handle.clearOverride(settings);
        else handle.override(settings, old.previous);
      }
      owned.delete(id);
      return;
    }
    const previous = old && same(current, old.applied) ? old.previous : current;
    handle.override(settings, value);
    owned.set(id, { previous, applied: value });
  }
  function planOverrides(values) {
    const { native } = state;
    const h = native.handles,
      plan = {};
    for (const id of ["enabled", "asyncEnabled", "midTurnEnabled"])
      if (Object.hasOwn(values, id)) plan[id] = values[id];
    if (Object.hasOwn(values, "method"))
      plan.methodOrder = methodOrder(values.method);
    if (Object.hasOwn(values, "threshold")) {
      plan.thresholdTokens = values.threshold === "tokens" ? values.budget : -1;
      plan.thresholdPercent =
        values.threshold === "percent" ? values.budget : -1;
      plan.modelThresholdsEnabled = false;
    }
    for (const [id, value] of Object.entries(plan)) h[id].assertWritable(value);
    return plan;
  }
  function installConversation(values) {
    const { owned } = state;
    const plan = planOverrides(values);
    const keys = new Set([...owned.keys(), ...Object.keys(plan)]);
    for (const id of keys) setOwned(id, plan[id]);
    state.conversation = { ...values };
  }
  function restoreBranch(ctx) {
    restoreOwned();
    state.conversation = {};
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "custom" || entry.customType !== entryType) continue;
      const data = entry.data;
      if (
        !plain(data) ||
        data.version !== 1 ||
        data.profileId !== profileId ||
        data.sessionId !== ctx.sessionManager.getSessionId() ||
        !plain(data.values)
      )
        continue;
      validateValues(data.values, true);
      installConversation(data.values);
      break;
    }
  }
  function validateValues(values, stored = false) {
    const { native } = state;
    if (!plain(values) || Object.keys(values).some((key) => !editable.has(key)))
      throw new Error("Invalid policy values");
    for (const id of ["enabled", "asyncEnabled", "midTurnEnabled"])
      if (Object.hasOwn(values, id) && typeof values[id] !== "boolean")
        throw new Error(`Invalid ${id}`);
    if (
      Object.hasOwn(values, "method") &&
      (typeof values.method !== "string" ||
        (values.method !== "native" &&
          !native.options.some((option) => option.value === values.method)))
    )
      throw new Error("Invalid compaction method");
    if (
      Object.hasOwn(values, "threshold") &&
      !["inherit", "tokens", "percent"].includes(values.threshold)
    )
      throw new Error("Invalid threshold type");
    if (
      Object.hasOwn(values, "budget") &&
      (typeof values.budget !== "number" ||
        !Number.isFinite(values.budget) ||
        values.budget <= 0)
    )
      throw new Error("Invalid compaction budget");
    if (
      stored &&
      ((Object.hasOwn(values, "threshold") &&
        (values.threshold === "inherit" || !Object.hasOwn(values, "budget"))) ||
        (!Object.hasOwn(values, "threshold") &&
          Object.hasOwn(values, "budget")) ||
        (values.threshold === "percent" &&
          (values.budget < 1 || values.budget > 99)) ||
        (values.threshold === "tokens" &&
          !Number.isSafeInteger(values.budget)) ||
        values.method === "native")
    )
      throw new Error("Invalid saved conversation policy");
  }
  function normalizeChanges(request, current) {
    const values = request.values ?? {};
    validateValues(values);
    const changes = { ...values };
    if (
      Object.hasOwn(changes, "threshold") ||
      Object.hasOwn(changes, "budget")
    ) {
      const kind = changes.threshold ?? current.threshold;
      if (kind === "inherit") {
        if (Object.hasOwn(changes, "budget"))
          throw new Error("An inherited threshold cannot have a budget");
        changes.threshold = "inherit";
      } else {
        const budget = changes.budget ?? current.budget;
        if (
          typeof budget !== "number" ||
          !Number.isFinite(budget) ||
          budget <= 0 ||
          (kind === "tokens" && !Number.isSafeInteger(budget)) ||
          (kind === "percent" && (budget < 1 || budget > 99))
        )
          throw new Error("Enter a valid threshold budget");
        changes.threshold = kind;
        changes.budget = budget;
      }
    }
    return changes;
  }
  function validateHeadroom(ctx, changes) {
    const { native, settings } = state;
    if (!Object.hasOwn(changes, "threshold") || changes.threshold === "inherit")
      return;
    const window = activeModel(ctx).contextWindow,
      proposed = settings.overlay();
    native.handles.modelThresholdsEnabled.override(proposed, false);
    native.handles.thresholdTokens.override(
      proposed,
      changes.threshold === "tokens" ? changes.budget : -1,
    );
    native.handles.thresholdPercent.override(
      proposed,
      changes.threshold === "percent" ? changes.budget : -1,
    );
    const policy = native.resolve(proposed, activeModel(ctx));
    const trigger = native.engine.resolveThresholdTokens(window, policy);
    const bounds = budgetBounds(window, policy),
      range = bounds[changes.threshold];
    if (
      changes.budget < range.min ||
      changes.budget > range.max ||
      trigger < bounds.tokens.min ||
      trigger > bounds.tokens.max ||
      (changes.threshold === "tokens" && trigger !== changes.budget)
    )
      throw new Error(
        `Threshold must be between ${bounds.tokens.min} and ${bounds.tokens.max} tokens to leave room for native compaction.`,
      );
  }
  function profilePlan(changes, reset) {
    const { native } = state;
    if (reset)
      return Object.fromEntries(
        [
          "enabled",
          "thresholdTokens",
          "thresholdPercent",
          "methodOrder",
          "asyncEnabled",
          "midTurnEnabled",
        ].map((id) => [id, undefined]),
      );
    const plan = {};
    for (const id of ["enabled", "asyncEnabled", "midTurnEnabled"])
      if (Object.hasOwn(changes, id)) plan[id] = changes[id];
    if (Object.hasOwn(changes, "method"))
      plan.methodOrder = methodOrder(changes.method);
    if (Object.hasOwn(changes, "threshold")) {
      plan.thresholdTokens =
        changes.threshold === "tokens" ? changes.budget : undefined;
      plan.thresholdPercent =
        changes.threshold === "percent" ? changes.budget : undefined;
    }
    for (const [id, value] of Object.entries(plan))
      if (value !== undefined) native.handles[id].assertWritable(value);
    return plan;
  }
  async function writeProfile(plan) {
    const before = state.settings.getGlobalSettings();
    try {
      for (const [id, value] of Object.entries(plan))
        value === undefined
          ? state.native.handles[id].unset(state.settings)
          : state.native.handles[id].set(state.settings, value);
      await state.settings.flush();
      await state.settings.reloadFromDisk();
    } catch (error) {
      for (const id of Object.keys(plan)) {
        const handle = state.native.handles[id],
          previous = valueAt(before, handle.segments);
        try {
          previous === undefined || previous === null
            ? handle.unset(state.settings)
            : handle.set(state.settings, previous);
        } catch {
          /* report the original persistence failure */
        }
      }
      throw new Error(`Could not persist profile policy: ${error.message}`);
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
    const next = reset ? {} : { ...state.conversation, ...changes };
    if (next.threshold === "inherit") {
      delete next.threshold;
      delete next.budget;
    }
    if (next.method === "native") delete next.method;
    validateValues(next, true);
    await manager.ensureOnDisk();
    const isCurrent = () =>
      same(session, identity(ctx)) &&
      same(session, state.activeSession) &&
      same(model, modelOf(ctx));
    if (!isCurrent() || snapshot(ctx).revision !== revision)
      throw new Error(
        "The conversation, model or policy changed; reload before applying",
      );
    const previous = { ...state.conversation };
    const entry = (values) =>
      api.appendEntry(entryType, {
        version: 1,
        profileId,
        sessionId: session.id,
        values,
      });
    let appended = false;
    try {
      installConversation(next);
      entry(next);
      appended = true;
      await manager.flush();
      if (!isCurrent())
        throw new Error("The conversation or model changed during the update");
    } catch (error) {
      let repairError;
      if (same(session, identity(ctx)) && same(session, state.activeSession)) {
        try {
          installConversation(previous);
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
      } else if (appended) {
        repairError = new Error(
          "The session changed before its policy entry could be restored",
        );
      }
      throw new Error(
        `Could not persist conversation policy: ${error.message}${repairError ? `; restoration failed: ${repairError.message}` : ""}`,
      );
    }
  }

  return {
    restoreOwned,
    restoreBranch,
    normalizeChanges,
    validateHeadroom,
    profilePlan,
    writeProfile,
    writeConversation,
  };
}
