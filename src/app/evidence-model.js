// Pure evidence projection shared by the desktop and native extension.
(function () {
  const standard = {
    preset: {
      id: "standard",
      name: "Standard",
      revision: 1,
      planningPrompt:
        "Identify the outcomes and acceptance criteria this work needs to prove. Preserve user requirements.",
      collectionPrompt:
        "Collect inspectable evidence for each outcome; distinguish actual execution from your interpretation and record gaps and limitations.",
      assessmentPrompt:
        "Review the scope and freshness of evidence, retain failures, and describe what remains unverified. Only the user can accept or waive requirements.",
      triggers: { beforeWork: true, afterChanges: true, beforeHandoff: true },
      tracking: true,
      handoff: "advisory",
    },
    source: "builtin",
    project: null,
  };
  const status = (state, label, reason) => ({ state, label, reason });
  const complete = (fp) =>
    fp?.complete === true &&
    typeof fp.head === "string" &&
    fp.head.length > 0 &&
    (typeof fp.dirtyDigest === "string" || fp.dirtyDigest === null);
  function freshness(view, record) {
    const outcome = (view.outcomes || []).find(
      (item) => item.id === record.outcomeId,
    );
    const requirement = outcome?.requirements?.find(
      (item) => item.id === record.requirementId,
    );
    if (
      record.requirementId &&
      (!requirement || requirement.revision !== record.requirementRevision)
    )
      return "The requirement has changed since this evidence was recorded.";
    if (!complete(record.fingerprint) || !complete(view.currentFingerprint))
      return "Code freshness is unknown: a complete source fingerprint is unavailable.";
    if (
      record.fingerprint.head !== view.currentFingerprint.head ||
      record.fingerprint.dirtyDigest !== view.currentFingerprint.dirtyDigest
    )
      return "The source state differs from the state when this evidence was collected.";
    if (
      record.source?.receiptId &&
      (!complete(record.beforeFingerprint) ||
        record.beforeFingerprint.head !== record.fingerprint.head ||
        record.beforeFingerprint.dirtyDigest !== record.fingerprint.dirtyDigest)
    )
      return "The source state changed or was unknown during the execution.";
    return null;
  }
  function recordStatus(view, record) {
    if (record.review?.decision === "rejected")
      return status(
        "rejected",
        "Rejected",
        record.review.reason || "The user rejected this evidence.",
      );
    if (record.result === "failed")
      return status(
        "failed",
        "Failed",
        record.reason || record.summary || "A failure was recorded.",
      );
    if (record.result === "blocked" || record.result === "cancelled")
      return status(
        "blocked",
        record.result === "cancelled" ? "Cancelled" : "Blocked",
        record.reason ||
          record.summary ||
          "Evidence collection did not complete.",
      );
    if (
      ["image", "video"].includes(record.kind) &&
      (!record.artifact || !record.artifact.mime?.startsWith(`${record.kind}/`))
    )
      return status(
        "blocked",
        "Artifact missing",
        "The required media was not attached as an inspectable artifact.",
      );
    const reason = freshness(view, record);
    if (reason) return status("stale", "Freshness unknown or stale", reason);
    const interpretation =
      record.source?.type === "agent"
        ? " This is the agent's interpretation, not independent verification."
        : "";
    return status(
      "collected",
      "Collected",
      `Evidence was collected; review is separate.${interpretation}`,
    );
  }
  function requirementStatus(view, outcome, requirement) {
    if (requirement.waiver)
      return status(
        "waived",
        "Waived",
        requirement.waiver.reason || "The user waived this requirement.",
      );
    const records = (view.records || []).filter(
      (record) =>
        record.outcomeId === outcome.id &&
        record.requirementId === requirement.id,
    );
    if (!records.length)
      return status(
        "missing",
        "Missing",
        "No evidence has been recorded for this requirement.",
      );
    const states = records.map((record) => recordStatus(view, record));
    // Unresolved failures, gaps and stale proofs remain visible even after a
    // later pass. A user's rejection is explicit and preserves the record.
    for (const wanted of [
      "failed",
      "blocked",
      "stale",
      "collected",
      "rejected",
    ]) {
      const found = states.find((item) => item.state === wanted);
      if (found) return found;
    }
    return status(
      "missing",
      "Missing",
      "No usable evidence has been recorded.",
    );
  }
  function summarize(view) {
    const result = {
      collected: 0,
      missing: 0,
      failed: 0,
      blocked: 0,
      stale: 0,
      waived: 0,
      unreviewed: 0,
    };
    for (const outcome of view.outcomes || []) {
      if (outcome.retired) continue;
      for (const requirement of outcome.requirements || []) {
        if (requirement.retired || !requirement.required) continue;
        const state = requirementStatus(view, outcome, requirement).state;
        if (Object.hasOwn(result, state)) result[state]++;
        else result.missing++;
      }
    }
    result.unreviewed = (view.records || []).filter(
      (record) => !record.review || record.review.decision === "unreviewed",
    ).length;
    return result;
  }
  function initial(policy) {
    const source = policy?.preset ? policy : standard;
    const selected = {
      ...source,
      preset: { ...source.preset, triggers: { ...source.preset.triggers } },
    };
    const view = {
      version: 1,
      supported: true,
      epoch: "",
      profileId: "",
      sessionId: "",
      file: null,
      revision: 0,
      tracking: selected.preset.tracking !== false,
      policy: selected,
      policyPinned: false,
      currentFingerprint: null,
      outcomes: [],
      records: [],
      receipts: [],
      requests: [],
      history: [],
      warnings: [],
      summary: null,
    };
    view.summary = summarize(view);
    return view;
  }
  const safe = (value) =>
    String(value ?? "")
      .replace(/[\\`*_{}\[\]<>#|]/g, "\\$&")
      .replace(/[\r\n]+/g, " ");
  const fingerprintText = (fp) =>
    !fp
      ? "unknown"
      : `${fp.complete ? "complete" : "incomplete"}; HEAD ${safe(fp.head || "unknown")}; dirty digest ${safe(fp.dirtyDigest ?? "none or unknown")}${fp.reason ? `; ${safe(fp.reason)}` : ""}`;
  const compact = (value, limit) => {
    const text = String(value ?? "");
    return safe(text.length > limit ? `${text.slice(0, limit)}…` : text);
  };
  function report(view, scope = {}) {
    const counts = summarize(view);
    const outcomes = (view.outcomes || []).filter(
      (item) =>
        !scope.receiptId && (!scope.outcomeId || item.id === scope.outcomeId),
    );
    const records = (view.records || []).filter(
      (item) =>
        (!scope.outcomeId || item.outcomeId === scope.outcomeId) &&
        (!scope.requirementId || item.requirementId === scope.requirementId) &&
        (!scope.recordId || item.id === scope.recordId),
    );
    const requests = (view.requests || []).filter(
      (item) =>
        (!scope.outcomeId || item.outcomeId === scope.outcomeId) &&
        (!scope.requirementId || item.requirementId === scope.requirementId) &&
        (!scope.requestId || item.id === scope.requestId),
    );
    const linkedReceipts = new Set(
      records.map((item) => item.source?.receiptId).filter(Boolean),
    );
    const scoped = !!(
      scope.outcomeId ||
      scope.requirementId ||
      scope.recordId ||
      scope.requestId ||
      scope.receiptId
    );
    const receipts = (view.receipts || []).filter((item) =>
      scope.receiptId
        ? item.id === scope.receiptId
        : !scoped || linkedReceipts.has(item.id),
    );
    const lines = [
      "# Evidence report",
      "",
      `Collection: ${view.tracking ? "on" : "off"}`,
      `Preset: ${safe(view.policy?.preset?.name)} (revision ${safe(view.policy?.preset?.revision)}, ${safe(view.policy?.source)}); ${view.policyPinned ? "durably pinned" : "not durably pinned"}${view.policyPersistenceError ? `: ${safe(view.policyPersistenceError)}` : ""}.`,
      `Current source: ${fingerprintText(view.currentFingerprint)}.`,
      `Total required criteria: ${Object.entries(counts)
        .filter(([name]) => name !== "unreviewed")
        .map(([name, count]) => `${name} ${count}`)
        .join(", ")}; unreviewed records ${counts.unreviewed}.`,
      "",
    ];
    if (!scoped) {
      lines.push(
        "## Outcome index",
        "Use an outcome id to inspect its criteria and evidence.",
      );
      for (const outcome of outcomes)
        lines.push(`- ${safe(outcome.id)}: ${compact(outcome.title, 24)}`);
      if ((view.receipts || []).length) {
        lines.push(
          "",
          "## Receipt index",
          "Use a receipt id to inspect or link an execution receipt.",
        );
        for (const receipt of view.receipts)
          lines.push(
            `- ${safe(receipt.id)}: ${compact(receipt.toolName, 10)} ${compact(receipt.command || "", 10)}`,
          );
      }
    } else if (scope.outcomeId && !scope.recordId && !scope.requestId) {
      for (const outcome of outcomes) {
        lines.push(`## Criterion index for outcome ${safe(outcome.id)}`);
        for (const requirement of outcome.requirements || []) {
          if (!scope.requirementId || requirement.id === scope.requirementId)
            lines.push(
              `- ${safe(requirement.id)}: ${compact(requirement.text, 16)}`,
            );
        }
      }
      if (records.length) {
        lines.push(
          "",
          "## Record index",
          "Use a record id to inspect its full evidence.",
        );
        for (const record of records)
          lines.push(`- ${safe(record.id)}: ${safe(record.result)}`);
      }
    }
    if (scope.requestId) {
      for (const request of requests)
        lines.push(
          "",
          `## Evidence request ${safe(request.id)}`,
          `Outcome: ${safe(request.outcomeId)}; criterion: ${safe(request.requirementId || "none")}.`,
          safe(request.text),
        );
    }
    for (const outcome of outcomes) {
      lines.push(
        `## ${safe(outcome.title)}${outcome.retired ? " (retired)" : ""}`,
        `Outcome id: ${safe(outcome.id)}.`,
        "",
        safe(outcome.description),
      );
      lines.push(
        `Author: ${safe(outcome.author)}; owner: ${safe(outcome.owner || outcome.author)}${outcome.todoRefs?.length ? `; todo references: ${outcome.todoRefs.map(safe).join(", ")}` : ""}.`,
      );
      for (const requirement of outcome.requirements || []) {
        if (scope.requirementId && requirement.id !== scope.requirementId)
          continue;
        const current = requirementStatus(view, outcome, requirement);
        lines.push(
          `- Criterion ${safe(requirement.id)} (outcome ${safe(outcome.id)}): ${safe(requirement.text)} — ${safe(current.label)}${requirement.retired ? " (retired)" : ""}; ${safe(current.reason)} Type: ${safe(requirement.kind)}; ${requirement.required ? "required" : "optional"}; author ${safe(requirement.author)}; owner ${safe(requirement.owner || requirement.author)}; revision ${safe(requirement.revision)}.`,
        );
      }
      for (const record of records.filter(
        (item) => item.outcomeId === outcome.id,
      )) {
        const current = recordStatus(view, record);
        lines.push(
          `  - Record ${safe(record.id)} (outcome ${safe(record.outcomeId)}, criterion ${safe(record.requirementId || "none")}, criterion revision ${safe(record.requirementRevision ?? "none")}): ${safe(record.title)}: ${safe(record.result)}; ${safe(current.reason)} Source: ${safe(record.source?.type)}${record.source?.toolName ? ` (${safe(record.source.toolName)}, receipt ${safe(record.source.receiptId)})` : ""}. Review: ${safe(record.review?.decision || "unreviewed")}${record.review?.reason ? ` — ${safe(record.review.reason)}` : ""}.`,
          `    ${safe(record.summary)}${record.limitations ? ` Limitations: ${safe(record.limitations)}` : ""}${record.reason ? ` Reason: ${safe(record.reason)}` : ""}`,
        );
        lines.push(
          `    Recorded ${safe(record.at)}; source state: ${fingerprintText(record.fingerprint)}.`,
        );
        if (record.source?.receiptId)
          lines.push(
            `    Before execution: ${fingerprintText(record.beforeFingerprint)}.`,
          );
        if (record.artifact)
          lines.push(
            `    Artifact: ${safe(record.artifact.name)} (${safe(record.artifact.mime)}, ${safe(record.artifact.bytes)} bytes, SHA-256 ${safe(record.artifact.sha256)}, id ${safe(record.artifact.id)}).`,
          );
        if (record.fileRef)
          lines.push(
            `    File reference: ${safe(record.fileRef.path)}${record.fileRef.from ? ` from ${safe(record.fileRef.from)}` : ""}${record.fileRef.to ? ` to ${safe(record.fileRef.to)}` : ""}.`,
          );
        if (record.url) lines.push(`    URL: ${safe(record.url)}`);
        if (record.ci) {
          lines.push(
            `    CI: ${safe(record.ci.state)} at ${safe(record.ci.sourceSha || "unknown commit")}${record.ci.snapshot?.url ? `; ${safe(record.ci.snapshot.url)}` : ""}.`,
          );
          for (const check of record.ci.snapshot?.failedChecks || [])
            lines.push(
              `    Failed check: ${safe(check.name || check.id)}${check.url ? ` — ${safe(check.url)}` : ""}.`,
            );
        }
      }
      lines.push("");
    }
    if (receipts.length) {
      lines.push(
        "## Execution receipts",
        "",
        "Receipts document execution, not semantic verification.",
      );
      for (const receipt of receipts) {
        lines.push(
          `- ${safe(receipt.toolName)} (id ${safe(receipt.id)}, call ${safe(receipt.toolCallId)}): ${receipt.isError ? "error" : "completed"}; exit code ${receipt.exitCode ?? "unknown"}; command ${safe(receipt.command || "unknown")}; ${safe(receipt.at)}.`,
        );
        lines.push(
          `  Before: ${fingerprintText(receipt.beforeFingerprint)}. After: ${fingerprintText(receipt.fingerprint)}.`,
        );
        if (receipt.preview)
          lines.push(
            `  Output preview${receipt.truncated ? " (truncated)" : ""}: ${safe(receipt.preview)}`,
          );
      }
    }
    if (
      requests.length &&
      !scope.requestId &&
      !scope.receiptId &&
      !scope.recordId
    ) {
      lines.push("", "## Evidence requests");
      for (const request of requests)
        lines.push(
          `- Request ${safe(request.id)} (outcome ${safe(request.outcomeId)}, criterion ${safe(request.requirementId || "none")}): ${safe(request.text)}`,
        );
    }
    for (const warning of view.warnings || [])
      lines.push(`- Warning: ${safe(warning)}`);
    return lines.join("\n");
  }
  (typeof window === "undefined" ? globalThis : window).OMP_EVIDENCE_MODEL = {
    initial,
    summarize,
    requirementStatus,
    recordStatus,
    report,
  };
})();
