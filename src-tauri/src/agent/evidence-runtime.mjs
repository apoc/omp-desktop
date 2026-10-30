import { randomUUID } from "node:crypto";
import { createHost, bootstrapFromEnv } from "./evidence-host.mjs";
import {
  addReceipt,
  reduce,
  validatePolicy,
  warn,
} from "./evidence-ledger.mjs";

const ENTRY = "omp-desktop:evidence";
const PREFIX = "OMP_DESKTOP_EVIDENCE:";
const MAX_VIEW = 700 * 1024;
const MAX_FRAME = 760 * 1024;
const model = globalThis.OMP_EVIDENCE_MODEL;
const copy = (value) => JSON.parse(JSON.stringify(value));
const size = (value) => Buffer.byteLength(JSON.stringify(value));
const identity = (ctx) => ({
  id: ctx.sessionManager.getSessionId(),
  file: ctx.sessionManager.getSessionFile() ?? null,
});
const isMain = (ctx) => ctx.agent?.kind === "main";
const message = (error) => {
  const value = Buffer.from(String(error?.message || error), "utf8");
  return value.length > 900
    ? `${value.subarray(0, 880).toString("utf8")} [truncated]`
    : value.toString("utf8");
};
const stamp = () => new Date().toISOString();
const validTool = (event) =>
  typeof event.toolCallId === "string" &&
  !!event.toolCallId &&
  Buffer.byteLength(event.toolCallId) <= 200 &&
  typeof event.toolName === "string" &&
  !!event.toolName &&
  Buffer.byteLength(event.toolName) <= 200;
function previewOf(content) {
  let preview = "",
    truncated = false,
    first = true;
  for (const item of Array.isArray(content) ? content : []) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    const separator = first ? "" : "\n";
    first = false;
    if (separator.length + item.text.length > 2000 - preview.length)
      truncated = true;
    if (preview.length < 2000)
      preview += separator.slice(0, 2000 - preview.length);
    if (preview.length < 2000)
      preview += item.text.slice(0, 2000 - preview.length);
  }
  return { preview, truncated };
}
const fingerprintValid = (fp) =>
  fp &&
  typeof fp === "object" &&
  typeof fp.complete === "boolean" &&
  (fp.head === null || typeof fp.head === "string") &&
  (fp.dirtyDigest === null || typeof fp.dirtyDigest === "string") &&
  (fp.reason === null || typeof fp.reason === "string") &&
  size(fp) <= 8192;

export function createEvidenceRuntime(
  api,
  { epoch, profileId, bootstrap = bootstrapFromEnv(), timeout } = {},
) {
  const command = `omp-desktop-evidence-${epoch}`;
  const host = createHost(epoch, bootstrap, timeout);
  let serial = Promise.resolve(),
    generation = 0,
    sequence = 0,
    active,
    view,
    closed = false,
    corrupt = false;
  const before = new Map(),
    started = new Map(),
    continuation = new Set();
  const selected = (() => {
    try {
      return bootstrap ? validatePolicy(bootstrap.policy) : null;
    } catch {
      return null;
    }
  })();
  const queue = (fn) => {
    const task = serial.then(fn, fn);
    serial = task.catch(() => {});
    return task;
  };
  const notifySize = (payload) =>
    size({
      type: "extension_ui_request",
      method: "notify",
      id: "\u0001".repeat(256),
      message: PREFIX + JSON.stringify(payload),
      notifyType: "info",
    });
  const fits = (value, reserve = 0) =>
    size(value) <= MAX_VIEW - 8192 &&
    notifySize({
      version: 1,
      command,
      epoch,
      id: "\u0001".repeat(200),
      view: { ...value, sequence: Number.MAX_SAFE_INTEGER },
    }) <=
      MAX_FRAME - reserve;
  function fresh(ctx) {
    const next = model.initial(selected);
    Object.assign(next, {
      epoch,
      profileId,
      sessionId: identity(ctx).id,
      file: identity(ctx).file,
      branchToken: `${epoch}-${generation}`,
    });
    if (!bootstrap)
      warn(
        next,
        "Evidence host is unavailable; code freshness, CI and artifact imports cannot be verified.",
      );
    else if (!selected)
      warn(
        next,
        "Evidence bootstrap policy is invalid; using the built-in Standard policy.",
      );
    else if (!bootstrap.inbox)
      warn(
        next,
        "Private artifact storage is unavailable; file and media imports are blocked.",
      );
    return next;
  }
  function syncIdentity(ctx, target = view) {
    const current = identity(ctx);
    if (target) {
      target.epoch = epoch;
      target.profileId = profileId;
      target.sessionId = current.id;
      target.file = current.file;
      target.branchToken = `${epoch}-${generation}`;
    }
  }
  function current(ctx, expectedGeneration, session) {
    const value = identity(ctx);
    return (
      !closed &&
      generation === expectedGeneration &&
      active?.id === session.id &&
      value.id === session.id &&
      active.file === value.file &&
      (session.file === value.file || session.file === null)
    );
  }
  function requireCurrent(ctx, expectedGeneration, session) {
    if (!current(ctx, expectedGeneration, session))
      throw new Error("The conversation or branch changed; refresh Evidence");
  }
  function snapshot(ctx) {
    syncIdentity(ctx);
    const result = copy(view);
    result.sequence = ++sequence;
    result.summary = model.summarize(result);
    if (!fits(result))
      throw new Error(
        "Evidence snapshot limit reached; existing evidence was preserved",
      );
    return result;
  }
  function publish(ctx, id = null, extra = {}) {
    const payload = {
      version: 1,
      command,
      epoch,
      ...(id ? { id } : {}),
      ...extra,
    };
    if (!payload.error && !payload.view) payload.view = snapshot(ctx);
    if (notifySize(payload) > MAX_FRAME)
      throw new Error(
        "Evidence response exceeds the transport limit; use the on-screen report",
      );
    ctx.ui.notify(PREFIX + JSON.stringify(payload), "info");
    return payload.view;
  }
  function restore(ctx) {
    const session = identity(ctx);
    active = session;
    view = fresh(ctx);
    corrupt = false;
    before.clear();
    started.clear();
    const branch = ctx.sessionManager.getBranch();
    let found = false;
    if (!Array.isArray(branch))
      throw new Error("Native evidence branch is unavailable");
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (
        entry.type !== "custom" ||
        entry.customType !== ENTRY ||
        entry.data?.profileId !== profileId
      )
        continue;
      found = true;
      const saved = entry.data?.view;
      if (
        entry.data.version !== 1 ||
        !saved ||
        saved.version !== 1 ||
        !Array.isArray(saved.outcomes) ||
        !Array.isArray(saved.records) ||
        !Array.isArray(saved.receipts) ||
        !Array.isArray(saved.requests) ||
        !Array.isArray(saved.history) ||
        !Array.isArray(saved.warnings) ||
        !Number.isSafeInteger(saved.revision) ||
        size(saved) > MAX_VIEW
      ) {
        corrupt = true;
        warn(
          view,
          "Saved Evidence metadata is invalid or too large; editing is blocked to avoid overwriting it.",
        );
        break;
      }
      try {
        validatePolicy(saved.policy);
      } catch {
        corrupt = true;
        warn(
          view,
          "Saved Evidence policy is invalid; editing is blocked to avoid overwriting it.",
        );
        break;
      }
      view = copy(saved);
      view.policyPinned = saved.policyPinned !== false;
      view.currentFingerprint = null;
      syncIdentity(ctx);
      if (!bootstrap)
        warn(
          view,
          "Evidence host is unavailable; code freshness, CI and artifact imports cannot be verified.",
        );
      else if (!bootstrap.inbox)
        warn(
          view,
          "Private artifact storage is unavailable; file and media imports are blocked.",
        );
      break;
    }
    return found;
  }
  async function fingerprint(ctx, expectedGeneration, session) {
    try {
      const fp = await host.request(ctx, "fingerprint");
      requireCurrent(ctx, expectedGeneration, session);
      if (!fingerprintValid(fp))
        throw new Error("Evidence fingerprint returned an invalid response");
      return fp;
    } catch (error) {
      requireCurrent(ctx, expectedGeneration, session);
      warn(view, `Source fingerprint unavailable: ${message(error)}`);
      return null;
    }
  }
  async function refreshFingerprint(ctx, expectedGeneration, session) {
    if (!view.tracking) return;
    view.currentFingerprint = await fingerprint(
      ctx,
      expectedGeneration,
      session,
    );
  }
  async function persist(ctx, next, expectedGeneration, session) {
    const manager = ctx.sessionManager;
    if (corrupt)
      throw new Error("Saved Evidence metadata is invalid; editing is blocked");
    if (
      !session.file ||
      typeof manager.ensureOnDisk !== "function" ||
      typeof manager.flush !== "function"
    )
      throw new Error(
        "Evidence persistence is unavailable in this conversation",
      );
    next.policyPinned = true;
    delete next.policyPersistenceError;
    next.warnings = next.warnings.filter(
      (warning) =>
        !warning.startsWith("Evidence preset is not durably pinned:"),
    );
    if (!fits(next, 64 * 1024))
      throw new Error(
        "Evidence snapshot limit reached; existing evidence was preserved",
      );
    await manager.ensureOnDisk();
    requireCurrent(ctx, expectedGeneration, session);
    const previous = view;
    const encode = (data) => ({
      version: 1,
      profileId,
      sessionId: session.id,
      view: data,
    });
    let appended = false;
    try {
      api.appendEntry(ENTRY, encode(next));
      appended = true;
      await manager.flush();
      requireCurrent(ctx, expectedGeneration, session);
      view = next;
    } catch (error) {
      let repair;
      if (appended && current(ctx, expectedGeneration, session)) {
        try {
          api.appendEntry(ENTRY, encode(previous));
          try {
            await manager.flush();
          } catch (failure) {
            if (
              typeof manager.recoverPersistenceFromCurrentState !== "function"
            )
              throw failure;
            await manager.recoverPersistenceFromCurrentState();
          }
        } catch (failure) {
          repair = message(failure);
          corrupt = true;
        }
      } else if (appended) {
        repair =
          "The conversation changed before the prior ledger could be restored";
      }
      throw new Error(
        `Could not persist Evidence: ${message(error)}${repair ? `; restoration failed: ${repair}` : ""}`,
      );
    }
  }
  async function captureCi(ctx, request, expectedGeneration, session) {
    let ci;
    try {
      ci = await host.request(ctx, "ci");
      requireCurrent(ctx, expectedGeneration, session);
      if (
        !ci ||
        !["success", "failure", "pending", "absent", "unknown"].includes(
          ci.state,
        ) ||
        size(ci) > 128 * 1024 ||
        (ci.sourceSha != null &&
          (typeof ci.sourceSha !== "string" ||
            Buffer.byteLength(ci.sourceSha) > 128)) ||
        (ci.reason != null &&
          (typeof ci.reason !== "string" ||
            Buffer.byteLength(ci.reason) > 1024)) ||
        (ci.limitations != null &&
          (typeof ci.limitations !== "string" ||
            Buffer.byteLength(ci.limitations) > 1800))
      )
        throw new Error("Invalid or oversized CI response");
    } catch (error) {
      requireCurrent(ctx, expectedGeneration, session);
      ci = {
        state: "unknown",
        sourceSha: null,
        reason: message(error),
        limitations: "CI service did not provide verifiable results.",
        snapshot: null,
      };
    }
    const result =
      ci.state === "success" && typeof ci.sourceSha === "string" && ci.sourceSha
        ? "passed"
        : ci.state === "failure"
          ? "failed"
          : "blocked";
    const ciFingerprint =
      typeof ci.sourceSha === "string" && ci.sourceSha
        ? {
            head: ci.sourceSha,
            dirtyDigest: null,
            complete: true,
            reason: null,
            environment: { scope: "CI source commit only" },
          }
        : null;
    const limitations =
      (ci.limitations || "CI checks cover only their reported source commit.") +
      (ci.snapshot?.truncated
        ? " The CI snapshot is truncated; some check metadata is unavailable."
        : "");
    return {
      request: {
        ...request,
        record: {
          title: "CI check rollup",
          kind: "ci",
          result,
          summary: `CI state: ${ci.state}${ci.sourceSha ? ` for ${ci.sourceSha}` : ""}`,
          limitations,
          reason: ci.reason || "",
        },
      },
      context: { source: "ci", fingerprint: ciFingerprint, ci },
    };
  }
  async function mutate(ctx, request, actor) {
    if (
      !view ||
      !active ||
      identity(ctx).id !== active.id ||
      identity(ctx).file !== active.file
    )
      restore(ctx);
    const expectedGeneration = generation,
      session = identity(ctx);
    if (actor === "user") {
      if (
        request.sessionId !== session.id ||
        request.file !== session.file ||
        request.branchToken !== `${epoch}-${expectedGeneration}`
      )
        throw new Error(
          "The Evidence conversation or branch changed; refresh before editing",
        );
      if (
        !Number.isSafeInteger(request.revision) ||
        request.revision !== view.revision
      )
        throw new Error("Evidence changed; refresh before editing");
    } else if (!view.tracking) throw new Error("Evidence collection is off");
    if (corrupt)
      throw new Error("Saved Evidence metadata is invalid; editing is blocked");
    if (request.op === "capture_ci" && !view.tracking)
      throw new Error("Evidence collection is off; CI was not captured");
    let operation = request,
      context = {};
    if (request.op === "record") {
      if (request.record?.path) {
        if (actor !== "agent")
          throw new Error("Use the native file picker to attach user evidence");
        const imported = await host.stage(ctx, request.record.path);
        requireCurrent(ctx, expectedGeneration, session);
        operation = {
          ...request,
          record: {
            ...request.record,
            artifact: imported,
            fileRef: request.record.fileRef || { path: request.record.path },
          },
        };
      }
      if (view.tracking)
        await refreshFingerprint(ctx, expectedGeneration, session);
      context.fingerprint = view.currentFingerprint;
    } else if (request.op === "capture_ci") {
      await refreshFingerprint(ctx, expectedGeneration, session);
      const ci = await captureCi(ctx, request, expectedGeneration, session);
      operation = ci.request;
      context = ci.context;
    } else if (request.op === "policy" && request.selection === "inherit") {
      const defaults = await host.request(ctx, "defaults");
      requireCurrent(ctx, expectedGeneration, session);
      context.policy = defaults?.policy;
      if (!context.policy)
        throw new Error("Inherited Evidence policy is unavailable");
    }
    requireCurrent(ctx, expectedGeneration, session);
    const next = copy(view);
    reduce(next, operation, actor, context);
    if (!next.tracking) next.currentFingerprint = null;
    next.revision++;
    next.summary = model.summarize(next);
    await persist(ctx, next, expectedGeneration, session);
    if (!view.tracking) {
      before.clear();
      started.clear();
    }
    return view;
  }
  async function process(ctx, request) {
    if (!isMain(ctx))
      throw new Error("Evidence is available only in the main conversation");
    if (
      !request ||
      typeof request !== "object" ||
      Array.isArray(request) ||
      typeof request.id !== "string" ||
      !request.id ||
      request.id.length > 200 ||
      request.profileId !== profileId ||
      typeof request.op !== "string"
    )
      throw new Error("Invalid Evidence request or profile");
    if (
      !view ||
      !active ||
      identity(ctx).id !== active.id ||
      identity(ctx).file !== active.file
    ) {
      restore(ctx);
      publish(ctx);
    }
    if (request.op === "get") {
      const expected = generation,
        session = identity(ctx);
      await refreshFingerprint(ctx, expected, session);
      return {};
    }
    if (request.op === "export") return { report: model.report(view) };
    await mutate(ctx, request, "user");
    return {};
  }
  async function privateCommand(args, ctx) {
    let request;
    try {
      request = JSON.parse(args);
    } catch {
      publish(ctx, null, { error: "Invalid Evidence request JSON" });
      return;
    }
    const id =
      typeof request?.id === "string" && request.id.length <= 200
        ? request.id
        : null;
    await queue(async () => {
      try {
        const result = await process(ctx, request);
        publish(ctx, id, result);
      } catch (error) {
        publish(ctx, id, { error: message(error) });
      }
    });
  }
  function reportScope(input) {
    const scope = {};
    for (const key of [
      "outcomeId",
      "requirementId",
      "recordId",
      "receiptId",
      "requestId",
    ]) {
      if (input[key] === undefined || input[key] === null) continue;
      if (
        typeof input[key] !== "string" ||
        !input[key] ||
        Buffer.byteLength(input[key]) > 200
      )
        throw new Error(`Invalid ${key}`);
      scope[key] = input[key];
    }
    if (
      ["recordId", "receiptId", "requestId"].filter((key) => scope[key])
        .length > 1
    )
      throw new Error("Choose one record, receipt or request to inspect");
    if (scope.receiptId) {
      if (scope.outcomeId || scope.requirementId)
        throw new Error(
          "A receipt view cannot specify an outcome or criterion",
        );
      if (!view.receipts.some((item) => item.id === scope.receiptId))
        throw new Error("Evidence receipt not found");
      return scope;
    }
    const selected = scope.recordId
      ? view.records.find((item) => item.id === scope.recordId)
      : scope.requestId
        ? view.requests.find((item) => item.id === scope.requestId)
        : null;
    if ((scope.recordId || scope.requestId) && !selected)
      throw new Error("Evidence record or request not found");
    if (selected) {
      if (
        (scope.outcomeId && scope.outcomeId !== selected.outcomeId) ||
        (scope.requirementId && scope.requirementId !== selected.requirementId)
      )
        throw new Error(
          "Evidence item belongs to a different outcome or criterion",
        );
      scope.outcomeId = selected.outcomeId;
      if (selected.requirementId) scope.requirementId = selected.requirementId;
    }
    if (scope.requirementId && !scope.outcomeId)
      throw new Error("Specify the outcome for this criterion");
    if (scope.outcomeId) {
      const outcome = view.outcomes.find((item) => item.id === scope.outcomeId);
      if (!outcome) throw new Error("Evidence outcome not found");
      if (
        scope.requirementId &&
        !outcome.requirements.some((item) => item.id === scope.requirementId)
      )
        throw new Error("Evidence criterion not found");
    }
    return scope;
  }
  async function agentOperation(ctx, request) {
    return queue(async () => {
      if (!isMain(ctx))
        throw new Error(
          "Evidence operations are available only in the main conversation",
        );
      if (
        !view ||
        !active ||
        identity(ctx).id !== active.id ||
        identity(ctx).file !== active.file
      ) {
        restore(ctx);
        publish(ctx);
      }
      if (
        !request ||
        typeof request !== "object" ||
        typeof request.op !== "string"
      )
        throw new Error("Invalid Evidence tool operation");
      let scope;
      if (request.op !== "view") {
        await mutate(ctx, request, "agent");
        publish(ctx);
        if (request.op === "outcome")
          scope = {
            outcomeId: request.outcome?.id || view.outcomes.at(-1)?.id,
          };
        else if (request.op === "requirement") {
          const outcome = view.outcomes.find(
            (item) => item.id === request.outcomeId,
          );
          scope = {
            outcomeId: request.outcomeId,
            requirementId:
              request.requirement?.id || outcome?.requirements.at(-1)?.id,
          };
        } else scope = { recordId: view.records.at(-1)?.id };
      } else scope = request;
      const report = model.report(view, reportScope(scope));
      return report.length > 14000
        ? report.slice(0, 14000) +
            "\n\n[Report truncated for model context; use view with an outcome, criterion, record, receipt or request id for details.]"
        : report;
    });
  }
  async function lifecycle(ctx, event = { type: "session_start" }) {
    if (!isMain(ctx)) return;
    if (
      event.type === "session_compact" &&
      active &&
      identity(ctx).id === active.id &&
      identity(ctx).file === active.file
    ) {
      const expected = generation,
        session = identity(ctx);
      await queue(async () => {
        if (current(ctx, expected, session)) publish(ctx);
      });
      return;
    }
    generation++;
    const expected = generation;
    await queue(async () => {
      if (closed || expected !== generation) return;
      let found;
      try {
        found = restore(ctx);
        publish(ctx);
      } catch (error) {
        if (closed || expected !== generation) return;
        view = fresh(ctx);
        active = identity(ctx);
        corrupt = true;
        warn(view, `Evidence restore failed: ${message(error)}`);
        publish(ctx);
        return;
      }
      if (corrupt) return;
      const session = identity(ctx);
      if (!found && event.type !== "session_start") {
        try {
          const defaults = await host.request(ctx, "defaults");
          requireCurrent(ctx, expected, session);
          view.policy = validatePolicy(defaults?.policy);
          view.tracking = view.policy.preset.tracking;
        } catch (error) {
          if (!current(ctx, expected, session)) return;
          view.policy = validatePolicy(model.initial().policy);
          view.tracking = view.policy.preset.tracking;
          warn(
            view,
            `Current inherited Evidence defaults are unavailable; using built-in Standard: ${message(error)}`,
          );
        }
      }
      if (!view.policyPinned) {
        try {
          await persist(ctx, copy(view), expected, session);
        } catch (error) {
          if (!current(ctx, expected, session)) return;
          view.policyPinned = false;
          view.policyPersistenceError = message(error);
          warn(
            view,
            `Evidence preset is not durably pinned: ${view.policyPersistenceError}`,
          );
        }
      }
      if (current(ctx, expected, session)) publish(ctx);
    });
  }
  async function toolBefore(event, ctx) {
    if (
      !isMain(ctx) ||
      event.toolName === "evidence" ||
      !view?.tracking ||
      !active ||
      identity(ctx).id !== active.id ||
      identity(ctx).file !== active.file
    )
      return;
    if (!validTool(event) || before.size >= 100) return;
    const expected = generation,
      session = identity(ctx);
    const fp = await fingerprint(ctx, expected, session).catch(() => null);
    if (view?.tracking && current(ctx, expected, session))
      before.set(event.toolCallId, fp);
  }
  function toolStarted(event) {
    if (
      view?.tracking &&
      validTool(event) &&
      event.toolName !== "evidence" &&
      started.size < 100
    )
      started.set(event.toolCallId, {
        toolName: event.toolName,
        input: event.args || {},
      });
  }
  async function toolResult(event, ctx) {
    if (!isMain(ctx) || !view?.tracking || event.toolName === "evidence")
      return;
    if (!validTool(event) || typeof event.isError !== "boolean") {
      if (
        active &&
        identity(ctx).id === active.id &&
        identity(ctx).file === active.file
      ) {
        warn(
          view,
          "A native tool result lacked a bounded identity or error status; its execution receipt was not captured.",
        );
        publish(ctx);
      }
      return;
    }
    return queue(async () => {
      if (
        !view?.tracking ||
        !active ||
        identity(ctx).id !== active.id ||
        identity(ctx).file !== active.file
      )
        return;
      if (view.receipts.some((item) => item.toolCallId === event.toolCallId))
        return;
      const expected = generation,
        session = identity(ctx);
      const fp = await fingerprint(ctx, expected, session);
      const input = event.input || started.get(event.toolCallId)?.input || {};
      const content = event.content || event.result?.content || [];
      const { preview, truncated } = previewOf(content);
      const details = event.details || event.result?.details || {};
      const first = before.get(event.toolCallId) || null;
      before.delete(event.toolCallId);
      started.delete(event.toolCallId);
      const command =
        typeof input.command === "string"
          ? input.command.length > 2000
            ? `${input.command.slice(0, 1980)} [command truncated]`
            : input.command
          : null;
      const receipt = {
        id: randomUUID(),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        at: stamp(),
        isError: event.isError,
        exitCode: Number.isSafeInteger(details.exitCode)
          ? details.exitCode
          : null,
        command,
        preview,
        truncated:
          truncated ||
          (typeof input.command === "string" && input.command.length > 2000) ||
          details.truncated === true,
        fingerprint: fp,
        beforeFingerprint: first,
        artifact: null,
      };
      const next = copy(view);
      next.currentFingerprint = fp;
      if (!addReceipt(next, receipt)) {
        view = next;
        publish(ctx);
        return;
      }
      next.revision++;
      next.summary = model.summarize(next);
      try {
        await persist(ctx, next, expected, session);
        publish(ctx);
      } catch (error) {
        if (!current(ctx, expected, session)) return;
        view.currentFingerprint = fp;
        warn(view, `Execution receipt was not persisted: ${message(error)}`);
        publish(ctx);
      }
      const changed =
        first?.complete &&
        fp?.complete &&
        (first.head !== fp.head || first.dirtyDigest !== fp.dirtyDigest);
      if (
        view.tracking &&
        view.policy.preset.triggers.afterChanges &&
        (changed || ["write", "edit"].includes(event.toolName))
      )
        return {
          additionalContext:
            view.policy.preset.collectionPrompt.slice(0, 4096) +
            "\nSource changes may make earlier evidence stale; preserve failures and report what is not verified.",
        };
    });
  }
  function guidance(ctx, event) {
    if (!isMain(ctx) || !view?.tracking || !Array.isArray(event.systemPrompt))
      return;
    continuation.clear();
    const preset = view.policy.preset;
    if (!preset.triggers.beforeWork && !preset.triggers.beforeHandoff) return;
    const outcomes = view.outcomes
      .filter((item) => !item.retired)
      .slice(0, 20)
      .map(
        (outcome) =>
          `${outcome.title}: ${outcome.requirements
            .filter((item) => !item.retired)
            .slice(0, 15)
            .map(
              (item) =>
                `${item.text} (${model.requirementStatus(view, outcome, item).label})`,
            )
            .join("; ")}`,
      )
      .join("\n");
    const instructions = [
      preset.triggers.beforeWork ? preset.planningPrompt : "",
      preset.triggers.beforeHandoff
        ? `Before handoff: ${preset.assessmentPrompt}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    const prompt =
      `${instructions}\n${view.policyPinned ? "" : "The active Evidence preset is not durably pinned; persistence failed or is unavailable.\n"}Evidence criteria (agent cannot accept, waive or modify user-owned criteria):\n${outcomes || "No criteria recorded yet."}`.slice(
        0,
        12000,
      );
    return { systemPrompt: [...event.systemPrompt, prompt] };
  }
  function stop(event, ctx) {
    if (
      !isMain(ctx) ||
      !view ||
      !active ||
      identity(ctx).id !== active.id ||
      identity(ctx).file !== active.file
    )
      return;
    publish(ctx);
    const preset = view.policy.preset;
    if (
      !view.tracking ||
      !preset.triggers.beforeHandoff ||
      preset.handoff !== "remind" ||
      event.stop_hook_active ||
      event.signal?.aborted ||
      continuation.has(event.turn_id)
    )
      return;
    const summary = model.summarize(view);
    if (
      !summary.missing &&
      !summary.failed &&
      !(summary.stale && view.currentFingerprint?.complete)
    )
      return;
    continuation.add(event.turn_id);
    return {
      continue: true,
      additionalContext:
        `${preset.assessmentPrompt}\nEvidence gaps: ${summary.missing} missing, ${summary.failed} failed, ${summary.blocked} blocked, ${summary.stale} stale/unknown. Make one bounded attempt where possible; preserve blocked gaps and do not accept or waive requirements.`.slice(
          0,
          5000,
        ),
    };
  }
  function shutdown() {
    closed = true;
    generation++;
    before.clear();
    started.clear();
  }
  return {
    command,
    privateCommand,
    agentOperation,
    lifecycle,
    toolBefore,
    toolStarted,
    toolResult,
    guidance,
    stop,
    shutdown,
  };
}
