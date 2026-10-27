// Pure PR presentation shared by the Changes card and project navigation.
(function () {
  const CHECK_PRIORITY = {
    none: 0,
    success: 1,
    unknown: 2,
    pending: 3,
    failure: 4,
  };
  const STATE_PRIORITY = { OPEN: 0, CLOSED: 1, MERGED: 2 };

  function countText(count, singular, plural) {
    return `${count} ${count === 1 ? singular : plural}`;
  }

  function checksText(checksState, failedCount) {
    const failed = failedCount
      ? countText(failedCount, "failed check", "failed checks")
      : "Checks failed";
    switch (checksState) {
      case "failure":
        return failed;
      case "pending":
        return failedCount ? `Checks pending; ${failed}` : "Checks pending";
      case "success":
        return failedCount ? `Checks passed; ${failed}` : "Checks passed";
      case "none":
        return failedCount ? `No check rollup; ${failed}` : "No checks";
      default:
        return failedCount
          ? `Check results unknown; ${failed}`
          : "Check results unknown";
    }
  }

  function maxChecks(left, right) {
    const a = Object.hasOwn(CHECK_PRIORITY, left) ? left : "unknown";
    const b = Object.hasOwn(CHECK_PRIORITY, right) ? right : "unknown";
    return CHECK_PRIORITY[a] >= CHECK_PRIORITY[b] ? a : b;
  }

  function identity(snapshot) {
    return `${snapshot.repository.trim().toLowerCase()}#${snapshot.number}`;
  }

  // Fresh reports supersede stale duplicates. When concurrent fresh reads differ,
  // prefer a terminal lifecycle and merge feedback only for the chosen state.
  function summarize(reports) {
    const fresh = reports.filter((status) => !status.discoveryError);
    const snapshots = (fresh.length ? fresh : reports).map(
      (status) => status.snapshot,
    );
    const state = snapshots.reduce(
      (best, snapshot) =>
        STATE_PRIORITY[snapshot.state] > STATE_PRIORITY[best]
          ? snapshot.state
          : best,
      "OPEN",
    );
    const selected = snapshots.filter((snapshot) => snapshot.state === state);
    const draft =
      state === "OPEN" && selected.some((snapshot) => snapshot.isDraft);
    const checks = new Set();
    const threads = new Set();
    let checksState = "none";
    for (const snapshot of selected) {
      checksState = maxChecks(checksState, snapshot.checksState);
      for (const check of snapshot.failedChecks || []) {
        if (check && typeof check.id === "string" && check.id)
          checks.add(check.id);
      }
      if (state === "OPEN") {
        for (const thread of snapshot.threads || []) {
          if (
            thread &&
            typeof thread.id === "string" &&
            thread.id &&
            !thread.isResolved &&
            !thread.isOutdated &&
            !thread.resolved &&
            !thread.outdated
          ) {
            threads.add(thread.id);
          }
        }
      }
    }
    const snapshot = selected[0];
    const repository = selected.map((item) => item.repository).sort()[0];
    return {
      state,
      draft,
      checksState,
      failedCount: checks.size,
      threadCount: threads.size,
      threads,
      number: snapshot.number,
      repository,
    };
  }

  function lifecycle(group) {
    if (group.state === "MERGED")
      return { glyph: "merged", tone: "merged", label: "Merged" };
    if (group.state === "CLOSED")
      return { glyph: "closed", tone: "closed", label: "Closed" };
    const glyph = group.draft ? "draft" : "open";
    const tone =
      group.checksState === "failure" || group.failedCount ? "failure" : glyph;
    return { glyph, tone, label: group.draft ? "Draft" : "Open" };
  }

  function groupDescription(group, includeRepository) {
    const { label } = lifecycle(group);
    const identityText = `${label} pull request #${group.number}${includeRepository ? ` (${group.repository})` : ""}`;
    const checks = checksText(group.checksState, group.failedCount);
    const parts = [
      identityText,
      group.state === "OPEN" ? checks : `Historical CI: ${checks}`,
    ];
    if (group.threadCount) {
      parts.push(
        countText(
          group.threadCount,
          "unresolved review thread",
          "unresolved review threads",
        ),
      );
    }
    return parts.join("; ");
  }

  function aggregate(statuses) {
    const groups = new Map();
    const errors = new Set();
    let noPrCount = 0;
    for (const status of statuses || []) {
      if (!status) continue;
      if (status.discoveryError) errors.add(String(status.discoveryError));
      if (!status.snapshot) {
        if (
          status.snapshot === null &&
          status.loading === false &&
          !status.discoveryError
        )
          noPrCount++;
        continue;
      }
      const key = identity(status.snapshot);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(status);
    }
    const stale = errors.size > 0;
    const freshness = stale
      ? `; Status may be stale: ${[...errors].sort().join("; ")}`
      : "";
    const summaries = [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, reports]) => summarize(reports));
    if (!summaries.length) {
      if (!stale) return null;
      return {
        glyph: "error",
        tone: "error",
        label: "Pull request unavailable",
        description: `Pull request status unavailable${freshness}`,
        checksState: "unknown",
        failedCount: 0,
        threadCount: 0,
        stale,
        prCount: 0,
      };
    }
    if (summaries.length === 1 && !noPrCount) {
      const group = summaries[0];
      return {
        ...lifecycle(group),
        description: groupDescription(group, false) + freshness,
        checksState: group.checksState,
        failedCount: group.failedCount,
        threadCount: group.threadCount,
        stale,
        prCount: 1,
      };
    }

    const open = summaries.filter((group) => group.state === "OPEN");
    const checksState = open.length
      ? open.reduce(
          (state, group) => maxChecks(state, group.checksState),
          "none",
        )
      : null;
    const failedCount = open.reduce(
      (count, group) => count + group.failedCount,
      0,
    );
    const threads = new Set(open.flatMap((group) => [...group.threads]));
    const threadCount = threads.size;
    const failed = open.some(
      (group) => group.checksState === "failure" || group.failedCount,
    );
    const details = summaries
      .map((group) => groupDescription(group, true))
      .join("; ");
    const label =
      summaries.length > 1
        ? "Multiple pull requests"
        : "Mixed pull request status";
    const heading =
      summaries.length > 1 ? `${label} (${summaries.length})` : label;
    const noPr = noPrCount
      ? `; ${countText(noPrCount, "conversation without a pull request", "conversations without a pull request")}`
      : "";
    return {
      glyph: "mixed",
      tone: failed ? "failure" : "mixed",
      label,
      description: `${heading}; ${details}${noPr}${freshness}`,
      checksState,
      failedCount,
      threadCount,
      stale,
      prCount: summaries.length,
    };
  }

  function present(status) {
    return aggregate(status ? [status] : []);
  }

  window.OMP_PR_STATUS = { present, aggregate };
})();
