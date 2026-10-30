import path from "node:path";
import {
  createPolicyNative,
  PolicyReadRace,
  plain,
  same,
  valueAt,
  modelOf,
  identity,
} from "./context-policy-native.mjs";
import { createPolicyMutation } from "./context-policy-mutation.mjs";

// This command is a local RPC transport. It never sends a message to the model.
export default function desktopContextPolicy(api) {
  const epoch = process.env.OMP_DESKTOP_CONTEXT_EPOCH;
  const profileId = process.env.OMP_DESKTOP_PROFILE_ID;
  if (!epoch || !/^[a-zA-Z0-9-]+$/.test(epoch) || !profileId) return;
  const command = `omp-desktop-context-policy-${epoch}`;
  const prefix = "OMP_DESKTOP_CONTEXT_POLICY:";
  const entryType = "omp-desktop:context-policy";
  let native, settings, activeContext, activeSession, unsubscribe;
  let owned = new Map(),
    conversation = { version: 2, values: {}, targets: {} },
    lastPublished,
    suppress = 0,
    closed = false,
    generation = 0,
    publishSequence = 0;
  let serial = Promise.resolve();
  const notify = (ctx, id, result) =>
    ctx.ui.notify(prefix + JSON.stringify({ command, id, ...result }), "info");
  const state = {
    api,
    profileId,
    entryType,
    rawOverride,
    get native() {
      return native;
    },
    get settings() {
      return settings;
    },
    get owned() {
      return owned;
    },
    get conversation() {
      return conversation;
    },
    set conversation(value) {
      conversation = value;
    },
    get generation() {
      return generation;
    },
    get activeSession() {
      return activeSession;
    },
  };
  const policyNative = createPolicyNative(state);
  const { loadNative, snapshot, unsupported } = policyNative;
  const {
    restoreOwned,
    restoreBranch,
    refreshConversation,
    normalizeChanges,
    validateHeadroom,
    profilePlan,
    writeProfile,
    writeConversation,
  } = createPolicyMutation(state, policyNative);

  function bindSettings(ctx) {
    const next = native.root.SettingsManager.create(ctx.cwd);
    if (
      !next ||
      ![
        "getAgentDir",
        "getStorage",
        "getGlobalSettings",
        "getProvenance",
        "overlayLayers",
        "overlay",
        "getConfigFiles",
        "getProjectSettings",
        "onEffectiveChange",
        "reloadFromDisk",
        "flush",
      ].every((key) => typeof next[key] === "function") ||
      !next.getStorage() ||
      path.resolve(next.getAgentDir()) !==
        path.resolve(native.root.getAgentDir())
    )
      throw new Error("The selected profile's native settings are unavailable");
    if (settings !== next) {
      restoreOwned();
      unsubscribe?.();
      settings = next;
      generation++;
      unsubscribe = settings.onEffectiveChange(
        Object.values(native.handles),
        () => {
          generation++;
          scheduleBroadcast();
        },
      );
    }
  }
  function rawOverride(handle) {
    return valueAt(settings.overlayLayers().overrides, handle.segments);
  }
  async function publish(ctx) {
    if (
      closed ||
      suppress ||
      !settings ||
      !native ||
      !activeSession ||
      !same(identity(ctx), activeSession)
    )
      return;
    const sequence = ++publishSequence,
      session = identity(ctx),
      model = modelOf(ctx);
    const boundSettings = settings;
    let policy, publishedGeneration, settingsRevision;
    try {
      if (
        sequence !== publishSequence ||
        closed ||
        suppress ||
        boundSettings !== settings ||
        !same(session, activeSession) ||
        !same(session, identity(ctx)) ||
        !same(model, modelOf(ctx))
      )
        return;
      publishedGeneration = generation;
      settingsRevision = settings.revision;
      policy = await snapshot(ctx);
    } catch (error) {
      if (
        publishedGeneration === undefined ||
        generation !== publishedGeneration ||
        boundSettings.revision !== settingsRevision
      )
        return;
      policy = unsupported(ctx, `Native policy unavailable: ${error.message}`);
    }
    if (
      sequence !== publishSequence ||
      closed ||
      suppress ||
      boundSettings !== settings ||
      generation !== publishedGeneration ||
      boundSettings.revision !== settingsRevision ||
      !same(session, activeSession) ||
      !same(session, identity(ctx)) ||
      !same(model, modelOf(ctx))
    )
      return;
    const key = JSON.stringify(policy);
    if (key !== lastPublished) {
      lastPublished = key;
      notify(ctx, null, { policy });
    }
  }
  function scheduleBroadcast() {
    if (suppress || !activeContext) return;
    queueMicrotask(() => {
      if (activeContext) void publish(activeContext);
    });
  }
  async function checkedSnapshot(ctx) {
    const session = identity(ctx),
      model = modelOf(ctx),
      boundSettings = settings,
      settingsRevision = settings.revision,
      currentGeneration = generation;
    const policy = await snapshot(ctx);
    if (
      boundSettings !== settings ||
      settingsRevision !== boundSettings.revision ||
      currentGeneration !== generation ||
      !same(session, activeSession) ||
      !same(session, identity(ctx)) ||
      !same(model, modelOf(ctx))
    )
      throw new PolicyReadRace(
        "The conversation, model or policy changed; reload the policy",
      );
    return policy;
  }
  // OMP increments Settings.revision on every disk reload, even when the
  // compaction policy did not change. A watcher can finish such a reload while
  // the inherited-settings view is being prepared. Retry only the read in that
  // case; the request's model, session and policy revision remain guarded.
  async function readCurrent(ctx, session, model) {
    const boundSettings = settings;
    for (let attempt = 0; ; attempt++) {
      const before = boundSettings.revision,
        beforeGeneration = generation;
      try {
        await refreshConversation(ctx);
        const policy = await checkedSnapshot(ctx);
        if (
          settings !== boundSettings ||
          !same(session, activeSession) ||
          !same(session, identity(ctx)) ||
          !same(model, modelOf(ctx))
        )
          throw new Error(
            "The conversation or model changed; reload the policy",
          );
        return policy;
      } catch (error) {
        if (
          !(error instanceof PolicyReadRace) ||
          attempt >= 7 ||
          settings !== boundSettings ||
          !same(session, activeSession) ||
          !same(session, identity(ctx)) ||
          !same(model, modelOf(ctx)) ||
          (before === boundSettings.revision && beforeGeneration === generation)
        )
          throw error;
      }
    }
  }
  async function processRequest(ctx, request) {
    if (
      !plain(request) ||
      typeof request.id !== "string" ||
      !request.id ||
      request.id.length > 200 ||
      !["get", "apply"].includes(request.op)
    )
      throw new Error("Invalid policy request");
    const allowed =
      request.op === "get"
        ? ["id", "op", "profileId"]
        : [
            "id",
            "op",
            "profileId",
            "scope",
            "reset",
            "values",
            "revision",
            "model",
          ];
    if (Object.keys(request).some((key) => !allowed.includes(key)))
      throw new Error("Unknown policy request field");
    if (request.profileId !== profileId)
      throw new Error("Request does not match the selected profile");
    if (ctx.agent?.kind !== "main")
      throw new Error(
        "Policy editing is available only in the main conversation",
      );
    native = await loadNative();
    bindSettings(ctx);
    if (!activeSession || !same(identity(ctx), activeSession)) {
      activeContext = ctx;
      activeSession = identity(ctx);
      await restoreBranch(ctx);
      lastPublished = undefined;
    }
    if (request.op === "get") {
      const session = identity(ctx),
        model = modelOf(ctx);
      await settings.reloadFromDisk();
      if (
        !same(session, identity(ctx)) ||
        !same(session, activeSession) ||
        !same(model, modelOf(ctx))
      )
        throw new Error("The conversation or model changed; reload the policy");
      return await readCurrent(ctx, session, model);
    }
    if (
      !["profile", "conversation"].includes(request.scope) ||
      typeof request.revision !== "string" ||
      !plain(request.model) ||
      typeof request.model.provider !== "string" ||
      typeof request.model.id !== "string" ||
      Object.keys(request.model).some(
        (key) => !["provider", "id"].includes(key),
      ) ||
      (request.reset !== undefined && typeof request.reset !== "boolean") ||
      (request.values !== undefined && !plain(request.values))
    )
      throw new Error("Invalid policy update");
    const session = identity(ctx),
      model = modelOf(ctx);
    await settings.reloadFromDisk();
    if (
      !same(session, identity(ctx)) ||
      !same(session, activeSession) ||
      !same(model, modelOf(ctx))
    )
      throw new Error("The conversation or model changed; reload the policy");
    const current = await readCurrent(ctx, session, model);
    if (
      !current.supported ||
      current.revision !== request.revision ||
      model.provider !== request.model.provider ||
      model.id !== request.model.id
    )
      throw new Error("The policy or model changed; reload before applying");
    if (request.reset && Object.keys(request.values ?? {}).length)
      throw new Error("Reset cannot include policy values");
    const changes = normalizeChanges(request);
    if (!request.reset && !Object.keys(changes).length)
      throw new Error("No policy changes provided");
    validateHeadroom(ctx, changes);
    const plan =
      request.scope === "profile"
        ? profilePlan(changes, !!request.reset, model)
        : null;
    suppress++;
    try {
      if (plan) {
        await writeProfile(
          plan,
          () =>
            same(session, identity(ctx)) &&
            same(session, activeSession) &&
            same(model, modelOf(ctx)),
          () => refreshConversation(ctx),
        );
      } else
        await writeConversation(
          ctx,
          changes,
          !!request.reset,
          session,
          model,
          request.revision,
        );
      if (!same(session, identity(ctx)) || !same(model, modelOf(ctx)))
        throw new Error("The conversation or model changed during the update");
      return await readCurrent(ctx, session, model);
    } finally {
      suppress--;
      scheduleBroadcast();
    }
  }
  api.registerCommand(command, {
    description: "Private desktop context policy transport",
    handler: async (args, ctx) => {
      let request;
      try {
        request = JSON.parse(args);
      } catch {
        notify(ctx, null, { error: "Invalid policy request JSON" });
        return;
      }
      const id = typeof request?.id === "string" ? request.id : null;
      const run = async () => {
        try {
          notify(ctx, id, { policy: await processRequest(ctx, request) });
        } catch (error) {
          if (
            request?.op === "get" &&
            request?.profileId === profileId &&
            ctx.agent?.kind === "main"
          )
            notify(ctx, id, {
              policy: unsupported(
                ctx,
                `Native policy unavailable: ${error.message}`,
              ),
            });
          else notify(ctx, id, { error: error.message || String(error) });
        }
      };
      serial = serial.then(run, run);
      await serial;
    },
  });
  for (const event of [
    "session_start",
    "session_switch",
    "session_branch",
    "session_tree",
  ])
    api.on(event, async (_event, ctx) => {
      if (ctx.agent?.kind !== "main") return;
      try {
        native = await loadNative();
        suppress++;
        try {
          bindSettings(ctx);
          activeContext = ctx;
          activeSession = identity(ctx);
          await restoreBranch(ctx);
          lastPublished = undefined;
        } finally {
          suppress--;
        }
        void publish(ctx);
      } catch (error) {
        activeContext = ctx;
        activeSession = identity(ctx);
        notify(ctx, null, {
          policy: unsupported(
            ctx,
            `Native policy unavailable: ${error.message}`,
          ),
        });
      }
    });
  for (const event of ["agent_start", "turn_end", "agent_end"])
    api.on(event, async (_event, ctx) => {
      if (
        ctx.agent?.kind === "main" &&
        activeSession &&
        same(identity(ctx), activeSession)
      ) {
        activeContext = ctx;
        if (
          event === "agent_start" &&
          conversation.legacy &&
          Object.keys(conversation.targets).length
        )
          await refreshConversation(ctx);
        void publish(ctx);
      }
    });
  api.on("session_shutdown", () => {
    publishSequence++;
    closed = true;
    unsubscribe?.();
    restoreOwned();
  });
}
