import { randomUUID } from "node:crypto";

const KINDS = new Set([
  "any",
  "image",
  "video",
  "test",
  "runtime",
  "code",
  "ci",
  "build",
  "other",
]);
const RESULTS = new Set([
  "observed",
  "passed",
  "failed",
  "blocked",
  "cancelled",
]);
const id = () => randomUUID();
const now = () => new Date().toISOString();
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const bytes = (value) => Buffer.byteLength(value, "utf8");
function text(value, name, limit, required = false) {
  if (value === undefined || value === null) value = "";
  if (
    typeof value !== "string" ||
    bytes(value) > limit ||
    (required && !value.trim())
  )
    throw new Error(
      `${name} must be ${required ? "nonempty and " : ""}at most ${limit} UTF-8 bytes`,
    );
  return value.trim();
}
function identifier(value, name) {
  return text(value, name, 200, true);
}
function boolean(value, name) {
  if (typeof value !== "boolean") throw new Error(`Invalid ${name}`);
  return value;
}
function kind(value) {
  if (!KINDS.has(value)) throw new Error("Invalid evidence kind");
  return value;
}
function outcomeOf(view, outcomeId) {
  const outcome = view.outcomes.find((item) => item.id === outcomeId);
  if (!outcome || outcome.retired)
    throw new Error("Outcome is missing or retired");
  return outcome;
}
function requirementOf(outcome, requirementId) {
  const requirement = outcome.requirements.find(
    (item) => item.id === requirementId,
  );
  if (!requirement || requirement.retired)
    throw new Error("Requirement is missing or retired");
  return requirement;
}
function audit(view, actor, action, detail) {
  view.history.push({ id: id(), at: now(), actor, action, detail });
  if (view.history.length > 100) {
    view.history.shift();
    warn(
      view,
      "Older audit entries are outside this snapshot; earlier branch metadata remains in the session.",
    );
  }
}
export function warn(view, warning) {
  if (view.warnings.includes(warning)) return;
  const important =
    warning.startsWith("Older audit entries") ||
    warning.startsWith("Older execution receipts") ||
    warning.startsWith("Receipt window is full");
  if (view.warnings.length >= 24 && !important) {
    const notice =
      "Additional warnings were omitted from this bounded snapshot.";
    if (!view.warnings.includes(notice)) view.warnings.push(notice);
    return;
  }
  view.warnings.push(warning);
}
export function validatePolicy(policy) {
  if (
    !object(policy) ||
    !object(policy.preset) ||
    !["builtin", "global", "project", "conversation"].includes(policy.source)
  )
    throw new Error("Invalid evidence policy");
  const p = policy.preset;
  const triggers = p.triggers;
  if (!object(triggers)) throw new Error("Invalid evidence triggers");
  const selected = {
    id: identifier(p.id, "Preset id"),
    name: text(p.name, "Preset name", 120, true),
    revision: p.revision,
    planningPrompt: text(p.planningPrompt, "Planning prompt", 4096),
    collectionPrompt: text(p.collectionPrompt, "Collection prompt", 4096),
    assessmentPrompt: text(p.assessmentPrompt, "Assessment prompt", 4096),
    triggers: {
      beforeWork: boolean(triggers.beforeWork, "beforeWork"),
      afterChanges: boolean(triggers.afterChanges, "afterChanges"),
      beforeHandoff: boolean(triggers.beforeHandoff, "beforeHandoff"),
    },
    tracking: boolean(p.tracking, "preset tracking"),
    handoff: p.handoff,
  };
  if (
    !Number.isSafeInteger(selected.revision) ||
    selected.revision < 1 ||
    !["advisory", "remind"].includes(selected.handoff)
  )
    throw new Error("Invalid preset revision or handoff");
  return {
    preset: selected,
    source: policy.source,
    project:
      policy.project == null ? null : text(policy.project, "Project", 4096),
  };
}
function artifact(value, owner) {
  if (
    !object(value) ||
    value.owner !== owner ||
    typeof value.id !== "string" ||
    !value.id ||
    bytes(value.id) > 200 ||
    typeof value.name !== "string" ||
    bytes(value.name) > 512 ||
    typeof value.mime !== "string" ||
    bytes(value.mime) > 100 ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    value.bytes > 64 * 1024 * 1024 ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(value.sha256)
  )
    throw new Error("Invalid or foreign evidence artifact");
  return {
    id: value.id,
    name: value.name,
    mime: value.mime,
    bytes: value.bytes,
    sha256: value.sha256,
    owner: value.owner,
  };
}
function addRecord(view, req, actor, context) {
  if (view.records.length >= 160)
    throw new Error(
      "Evidence record limit reached; existing records were preserved",
    );
  const outcome = outcomeOf(view, req.outcomeId);
  const requirement = req.requirementId
    ? requirementOf(outcome, req.requirementId)
    : null;
  const input = req.record;
  if (!object(input)) throw new Error("Invalid evidence record");
  if (!RESULTS.has(input.result)) throw new Error("Invalid evidence result");
  if (
    requirement &&
    requirement.kind !== "any" &&
    input.kind !== requirement.kind &&
    ["observed", "passed"].includes(input.result)
  )
    throw new Error("Evidence kind does not match the requirement");
  const receipt = input.receiptId
    ? view.receipts.find((item) => item.id === input.receiptId)
    : null;
  if (input.receiptId && !receipt)
    throw new Error("Evidence receipt is unavailable");
  if (
    input.result === "passed" &&
    receipt &&
    (receipt.isError || (receipt.exitCode !== null && receipt.exitCode !== 0))
  )
    throw new Error(
      "A failed execution receipt cannot support a passed result",
    );
  let fileRef;
  if (input.fileRef !== undefined) {
    if (!object(input.fileRef)) throw new Error("Invalid file reference");
    fileRef = { path: text(input.fileRef.path, "File path", 2048, true) };
    if (input.fileRef.from !== undefined)
      fileRef.from = text(String(input.fileRef.from), "File from", 200);
    if (input.fileRef.to !== undefined)
      fileRef.to = text(String(input.fileRef.to), "File to", 200);
  }
  let url;
  if (input.url) {
    url = text(input.url, "URL", 2048);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Invalid evidence URL");
    }
    if (!["http:", "https:"].includes(parsed.protocol))
      throw new Error("Evidence URL must use HTTP or HTTPS");
  }
  const source = { type: context.source || actor };
  if (receipt)
    Object.assign(source, {
      receiptId: receipt.id,
      toolCallId: receipt.toolCallId,
      toolName: receipt.toolName,
    });
  const record = {
    id: id(),
    outcomeId: outcome.id,
    requirementId: requirement?.id || null,
    requirementRevision: requirement?.revision || null,
    title: text(input.title, "Record title", 300, true),
    kind: kind(input.kind),
    result: input.result,
    summary: text(input.summary, "Summary", 2048, true),
    limitations: text(input.limitations, "Limitations", 2048),
    reason: text(input.reason, "Reason", 1024),
    at: now(),
    source,
    fingerprint: receipt ? receipt.fingerprint : context.fingerprint || null,
    artifact: input.artifact ? artifact(input.artifact, view.sessionId) : null,
    review: { decision: "unreviewed" },
    ...(receipt
      ? { beforeFingerprint: receipt.beforeFingerprint || null }
      : {}),
    ...(fileRef ? { fileRef } : {}),
    ...(url ? { url } : {}),
    ...(context.ci ? { ci: context.ci } : {}),
  };
  view.records.push(record);
  audit(view, actor, "record", `${record.title}: ${record.result}`);
  return record;
}
export function reduce(view, req, actor, context = {}) {
  if (!object(req) || typeof req.op !== "string")
    throw new Error("Invalid evidence operation");
  if (
    actor === "agent" &&
    !["outcome", "requirement", "record", "capture_ci"].includes(req.op)
  )
    throw new Error("The agent cannot perform this evidence operation");
  switch (req.op) {
    case "outcome": {
      const input = req.outcome;
      if (!object(input)) throw new Error("Invalid outcome");
      const title = text(input.title, "Outcome title", 300, true);
      const description = text(input.description, "Outcome description", 2048);
      if (
        input.todoRefs !== undefined &&
        (!Array.isArray(input.todoRefs) || input.todoRefs.length > 20)
      )
        throw new Error("Invalid todo references");
      const todoRefs = (input.todoRefs || []).map((item) =>
        text(item, "Todo reference", 500, true),
      );
      if (input.id) {
        const existing = outcomeOf(view, identifier(input.id, "Outcome id"));
        if (actor === "agent" && (existing.owner || existing.author) === "user")
          throw new Error("Only the user may edit a user-owned outcome");
        Object.assign(existing, {
          title,
          description,
          todoRefs,
          ...(actor === "user" ? { owner: "user" } : {}),
        });
      } else {
        if (view.outcomes.length >= 40)
          throw new Error("Outcome limit reached");
        view.outcomes.push({
          id: id(),
          title,
          description,
          author: actor,
          owner: actor,
          todoRefs,
          retired: false,
          requirements: [],
        });
      }
      audit(view, actor, "outcome", title);
      break;
    }
    case "requirement": {
      const outcome = outcomeOf(view, req.outcomeId),
        input = req.requirement;
      if (!object(input)) throw new Error("Invalid requirement");
      const fields = {
        text: text(input.text, "Requirement", 1200, true),
        kind: kind(input.kind),
        required: boolean(input.required, "required"),
      };
      if (input.id) {
        const existing = requirementOf(
          outcome,
          identifier(input.id, "Requirement id"),
        );
        if (actor === "agent" && (existing.owner || existing.author) === "user")
          throw new Error("Only the user may edit a user-owned requirement");
        if (
          existing.text !== fields.text ||
          existing.kind !== fields.kind ||
          existing.required !== fields.required
        ) {
          Object.assign(existing, fields);
          existing.revision++;
        }
        if (actor === "user") existing.owner = "user";
      } else {
        if (outcome.requirements.length >= 30)
          throw new Error("Requirement limit reached");
        outcome.requirements.push({
          id: id(),
          ...fields,
          author: actor,
          owner: actor,
          revision: 1,
          retired: false,
        });
      }
      audit(view, actor, "requirement", fields.text);
      break;
    }
    case "retire": {
      const outcome = outcomeOf(view, req.outcomeId);
      if (req.requirementId)
        requirementOf(outcome, req.requirementId).retired = true;
      else outcome.retired = true;
      audit(view, actor, "retire", req.requirementId || outcome.title);
      break;
    }
    case "record":
    case "capture_ci":
      addRecord(view, req, actor, context);
      break;
    case "review": {
      const record = view.records.find((item) => item.id === req.recordId);
      if (
        !record ||
        !["unreviewed", "accepted", "rejected"].includes(req.decision)
      )
        throw new Error("Invalid evidence review");
      const reason = text(
        req.reason,
        "Review reason",
        1024,
        req.decision === "rejected",
      );
      record.review = {
        decision: req.decision,
        ...(reason ? { reason } : {}),
        at: now(),
      };
      audit(
        view,
        actor,
        "review",
        `${record.title}: ${req.decision}${reason ? ` — ${reason}` : ""}`,
      );
      break;
    }
    case "waive":
    case "unwaive": {
      const requirement = requirementOf(
        outcomeOf(view, req.outcomeId),
        req.requirementId,
      );
      if (req.op === "waive")
        requirement.waiver = {
          reason: text(req.reason, "Waiver reason", 1024, true),
          at: now(),
          actor: "user",
        };
      else delete requirement.waiver;
      audit(
        view,
        actor,
        req.op,
        requirement.text +
          (req.op === "waive" ? ` — ${requirement.waiver.reason}` : ""),
      );
      break;
    }
    case "policy": {
      if (!["inherit", "conversation"].includes(req.selection))
        throw new Error("Invalid policy selection");
      const policy = validatePolicy(context.policy || req.policy);
      if (req.selection === "conversation") policy.source = "conversation";
      view.policy = policy;
      view.tracking = policy.preset.tracking;
      audit(
        view,
        actor,
        "policy",
        `${policy.preset.name} revision ${policy.preset.revision} (${policy.source})`,
      );
      break;
    }
    case "tracking":
      view.tracking = boolean(req.enabled, "tracking");
      audit(view, actor, "tracking", view.tracking ? "on" : "off");
      break;
    case "request": {
      const outcome = outcomeOf(view, req.outcomeId);
      if (req.requirementId) requirementOf(outcome, req.requirementId);
      const value = text(req.text, "Evidence request", 2048, true);
      if (req.requestId && req.newRequestId)
        throw new Error("Specify a new or existing request id, not both");
      if (req.requestId) {
        const existing = view.requests.find(
          (item) => item.id === req.requestId,
        );
        if (!existing) throw new Error("Evidence request not found");
        Object.assign(existing, {
          outcomeId: outcome.id,
          requirementId: req.requirementId || null,
          text: value,
          updatedAt: now(),
        });
      } else {
        if (view.requests.length >= 80)
          throw new Error("Evidence request limit reached");
        const requestId = req.newRequestId
          ? identifier(req.newRequestId, "New request id")
          : id();
        if (view.requests.some((item) => item.id === requestId))
          throw new Error(
            "Evidence request id already exists; edit the existing request",
          );
        view.requests.push({
          id: requestId,
          outcomeId: outcome.id,
          requirementId: req.requirementId || null,
          text: value,
          at: now(),
          actor: "user",
        });
      }
      audit(view, actor, "request", value);
      break;
    }
    default:
      throw new Error("Unknown evidence operation");
  }
}
export function addReceipt(view, receipt) {
  if (view.receipts.some((item) => item.toolCallId === receipt.toolCallId))
    return false;
  if (view.receipts.length >= 100) {
    const referenced = new Set(
      view.records.map((record) => record.source?.receiptId),
    );
    const index = view.receipts.findIndex((item) => !referenced.has(item.id));
    if (index < 0) {
      warn(
        view,
        "Receipt window is full of referenced receipts; newer execution receipts were not captured.",
      );
      return false;
    }
    view.receipts.splice(index, 1);
    warn(
      view,
      "Older execution receipts are outside this snapshot; earlier branch metadata remains in the session.",
    );
  }
  view.receipts.push(receipt);
  return true;
}
