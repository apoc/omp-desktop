import path from "node:path";
import {
  createPolicyNative,
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
    conversation = {},
    lastPublished,
    suppress = 0,
    closed = false;
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
    get activeSession() {
      return activeSession;
    },
  };
  const policyNative = createPolicyNative(state);
  const { loadNative, snapshot, unsupported } = policyNative;
  const {
    restoreOwned,
    restoreBranch,
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
      unsubscribe = settings.onEffectiveChange(
        Object.values(native.handles),
        scheduleBroadcast,
      );
    }
  }
  function rawOverride(handle) {
    return valueAt(settings.overlayLayers().overrides, handle.segments);
  }
  function publish(ctx) {
    if (
      closed ||
      suppress ||
      !settings ||
      !native ||
      !activeSession ||
      !same(identity(ctx), activeSession)
    )
      return;
    let policy;
    try {
      policy = snapshot(ctx);
    } catch (error) {
      policy = unsupported(ctx, `Native policy unavailable: ${error.message}`);
    }
    const key = JSON.stringify(policy);
    if (key !== lastPublished) {
      lastPublished = key;
      notify(ctx, null, { policy });
    }
  }
  function scheduleBroadcast() {
    if (suppress || !activeContext) return;
    queueMicrotask(() => {
      if (activeContext) publish(activeContext);
    });
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
      restoreBranch(ctx);
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
      return snapshot(ctx);
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
    const current = snapshot(ctx);
    if (
      !current.supported ||
      current.revision !== request.revision ||
      model.provider !== request.model.provider ||
      model.id !== request.model.id
    )
      throw new Error("The policy or model changed; reload before applying");
    if (request.reset && Object.keys(request.values ?? {}).length)
      throw new Error("Reset cannot include policy values");
    const baseline = Object.fromEntries(
      (request.scope === "profile"
        ? current.profileControls
        : current.controls
      ).map((item) => [item.id, item.value]),
    );
    const changes = normalizeChanges(request, baseline);
    if (!request.reset && !Object.keys(changes).length)
      throw new Error("No policy changes provided");
    validateHeadroom(ctx, changes);
    const plan =
      request.scope === "profile"
        ? profilePlan(changes, !!request.reset)
        : null;
    suppress++;
    try {
      if (plan) await writeProfile(plan);
      else
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
      return snapshot(ctx);
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
          restoreBranch(ctx);
          lastPublished = undefined;
        } finally {
          suppress--;
        }
        publish(ctx);
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
    api.on(event, (_event, ctx) => {
      if (
        ctx.agent?.kind === "main" &&
        activeSession &&
        same(identity(ctx), activeSession)
      ) {
        activeContext = ctx;
        publish(ctx);
      }
    });
  api.on("session_shutdown", () => {
    closed = true;
    unsubscribe?.();
    restoreOwned();
  });
}
