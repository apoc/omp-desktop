// Read-only projection of native tool, job-delivery and subagent frames.
// A state belongs to one tab and one native conversation/process epoch.
(function () {
  const RECENT_CAP = 30;
  const TEXT_CAP = 12000;
  const LIVE = new Set(["running", "pending"]);
  const TERMINAL = new Set([
    "completed",
    "failed",
    "cancelled",
    "aborted",
    "unknown",
  ]);
  const TYPES = new Set(["bash", "eval", "task"]);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const text = (value) =>
    typeof value === "string" ? value.slice(0, TEXT_CAP) : "";
  const timestamp = (value, fallback) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const duration = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : null;
  const statusOf = (value) =>
    value === "started"
      ? "running"
      : LIVE.has(value) || TERMINAL.has(value)
        ? value
        : null;
  const isLive = (item) => LIVE.has(item.status);
  const blockText = (content) =>
    typeof content === "string"
      ? text(content)
      : Array.isArray(content)
        ? text(
            content
              .filter((p) => p?.type === "text" && typeof p.text === "string")
              .map((p) => p.text)
              .join("\n"),
          )
        : "";

  function empty() {
    return { items: {}, order: [], pending: false, waiting: null };
  }
  function get(state, key) {
    return own(state.items, key) ? state.items[key] : undefined;
  }
  function put(state, item) {
    const order = own(state.items, item.key)
      ? state.order
      : [...state.order, item.key];
    const items = { ...state.items, [item.key]: item };
    // Bound terminal records, not live operations. The newest terminal records
    // are retained even when a replay delivers them more than once.
    const finished = order
      .filter((key) => !isLive(items[key]))
      .sort((a, b) => (items[a].endedAt ?? 0) - (items[b].endedAt ?? 0));
    if (finished.length > RECENT_CAP) {
      const drop = new Set(finished.slice(0, finished.length - RECENT_CAP));
      for (const key of drop) delete items[key];
      return { ...state, items, order: order.filter((key) => !drop.has(key)) };
    }
    return { ...state, items, order };
  }
  function remove(state, key) {
    if (!get(state, key)) return state;
    const items = { ...state.items };
    delete items[key];
    return { ...state, items, order: state.order.filter((k) => k !== key) };
  }
  function find(state, predicate) {
    for (let i = state.order.length - 1; i >= 0; i--) {
      const item = state.items[state.order[i]];
      if (predicate(item)) return item;
    }
    return null;
  }
  function byJob(state, id) {
    return id ? find(state, (item) => item.jobId === id) : null;
  }
  function byAgent(state, id, callId) {
    return id
      ? find(
          state,
          (item) =>
            item.agentId === id &&
            (!callId || !item.toolCallId || item.toolCallId === callId),
        )
      : null;
  }
  function foregroundKey(id) {
    return `tool:${id}`;
  }
  function labelFor(tool, args, intent) {
    return (
      text(
        intent ||
          (tool === "bash"
            ? args?.command
            : tool === "eval"
              ? args?.title || args?.code
              : ""),
      )
        .split("\n", 1)[0]
        .slice(0, 240) ||
      (tool === "wait" ? "Waiting for background work or replies" : tool)
    );
  }
  function create(key, type, now) {
    return {
      key,
      type,
      status: "running",
      startedAt: now,
      endedAt: null,
      durationMs: null,
      label: type,
      toolCallId: null,
      jobId: null,
      agentId: null,
      background: true,
      output: "",
      detail: "",
    };
  }
  function update(state, base, fields, now) {
    const next = { ...base, ...fields };
    // A replayed running update cannot revive a settled job. An unknown
    // outcome can be replaced by an authoritative terminal observation.
    if (!isLive(base) && isLive(next)) next.status = base.status;
    if (
      TERMINAL.has(base.status) &&
      base.status !== "unknown" &&
      next.status === "unknown"
    )
      next.status = base.status;
    if (!isLive(next))
      next.endedAt =
        base.status === "unknown" && next.status !== "unknown"
          ? now
          : (base.endedAt ?? now);
    else next.endedAt = null;
    return put(state, next);
  }
  function jobUpdate(state, job, now, options = {}) {
    const id =
      typeof job.jobId === "string"
        ? job.jobId
        : typeof job.id === "string"
          ? job.id
          : null;
    if (!id) return state;
    const type = TYPES.has(job.type) ? job.type : null;
    const agentId =
      typeof job.agentId === "string"
        ? job.agentId
        : typeof job.agentUrlId === "string"
          ? job.agentUrlId
          : null;
    const agent =
      type === "task" ? byAgent(state, agentId || id, job.toolCallId) : null;
    const recorded = byJob(state, id);
    let base =
      !options.historical && agent && isLive(agent) ? agent : recorded || agent;
    // A tool call's foreground entry becomes its background job, preserving
    // its original start and label. Never coalesce two task spawns in a batch.
    const fg = job.toolCallId
      ? get(state, foregroundKey(job.toolCallId))
      : null;
    if (!base && fg && type !== "task") {
      base = fg;
    }
    const key =
      base?.key ??
      (type === "task" && agentId
        ? `agent:${job.toolCallId || ""}:${agentId}`
        : `job:${id}`);
    base ||= create(key, type || "job", now);
    const reported = statusOf(job.status || job.state);
    const nextStatus =
      reported || (options.historical ? "unknown" : base.status);
    const ms = duration(job.durationMs);
    const start =
      ms == null ? base.startedAt : Math.min(base.startedAt, now - ms);
    const output = text(
      job.output ||
        job.resultText ||
        job.errorText ||
        (!base.output && options.output),
    );
    const fields = {
      type: type || base.type,
      jobId: id,
      agentId: agentId || base.agentId,
      toolCallId: job.toolCallId || base.toolCallId,
      label: text(job.label) || base.label,
      status: nextStatus,
      startedAt: start,
      durationMs: ms ?? base.durationMs,
      background: true,
      output: output || base.output,
    };
    // A historical running marker is only proof that the job existed. It is
    // not a current snapshot; keep a live observation, otherwise mark unknown.
    if (options.historical && isLive({ status: nextStatus }))
      fields.status =
        isLive(base) && get(state, base.key) ? base.status : "unknown";
    state = update(state, base, fields, now);
    if (fg && fg.key !== base.key && type !== "task")
      state = remove(state, fg.key);
    return state;
  }
  function agentUpdate(state, payload, now, isProgress = false, newRun = null) {
    const progress = isProgress ? payload.progress : null;
    const id = isProgress ? progress?.id : payload.id;
    if (typeof id !== "string" || !id) return state;
    const callId = payload.parentToolCallId || null;
    const status = statusOf(isProgress ? progress?.status : payload.status);
    if (!status) return state;
    let base = byAgent(state, id, callId) || byJob(state, id);
    // Owner identity prevents a reused agent id from changing another call.
    if (base?.toolCallId && callId && base.toolCallId !== callId) base = null;
    if (newRun && base && !isLive(base)) base = null;
    const key =
      base?.key ?? `agent:${callId || ""}:${id}${newRun ? `:${newRun}` : ""}`;
    base ||= { ...create(key, "task", now), background: null };
    const ms = duration(progress?.durationMs);
    const reportedStart = ms == null ? now : now - ms;
    const output = Array.isArray(progress?.recentOutput)
      ? progress.recentOutput
          .map((v) => (typeof v === "string" ? v : v?.text || ""))
          .filter(Boolean)
          .join("\n")
      : "";
    const fields = {
      type: "task",
      agentId: id,
      toolCallId: callId || base.toolCallId,
      status,
      startedAt: Math.min(base.startedAt, reportedStart),
      durationMs: ms ?? base.durationMs,
      background:
        typeof payload.detached === "boolean"
          ? payload.detached
          : base.background,
      label:
        text(
          payload.description ||
            progress?.description ||
            payload.assignment ||
            progress?.assignment ||
            payload.task ||
            progress?.task,
        ) || base.label,
      detail:
        text(
          progress?.lastIntent ||
            progress?.currentToolArgs ||
            progress?.currentTool ||
            "",
        ) || base.detail,
      output: text(output) || base.output,
      agentType: text(payload.agent || progress?.agent) || base.agentType,
      sessionFile: payload.sessionFile || base.sessionFile,
    };
    return update(state, base, fields, now);
  }
  function applyResult(state, toolCallId, toolName, result, now, historical) {
    const details = result?.details;
    if (!details || typeof details !== "object") return state;
    const async = details.async;
    if (async && TYPES.has(async.type) && typeof async.jobId === "string") {
      // task's async marker describes the whole batch, not the primary agent's
      // outcome. Lifecycle/progress and per-job deliveries provide the latter.
      if (async.type !== "task") {
        state = jobUpdate(state, { ...async, toolCallId }, now, {
          historical,
          output: blockText(result.content),
        });
      } else {
        const progress = Array.isArray(details.progress)
          ? details.progress
          : [];
        const primary = progress.find((p) => p?.id === async.jobId);
        if (primary) {
          const previous = byAgent(state, primary.id, toolCallId);
          state = agentUpdate(
            state,
            {
              parentToolCallId: toolCallId,
              progress: primary,
              agent: primary.agent,
            },
            now,
            true,
          );
          const item = byAgent(state, primary.id, toolCallId);
          if (item) {
            const unknown = historical && !previous && isLive(item);
            state = put(state, {
              ...item,
              jobId: async.jobId,
              background: true,
              status: unknown ? "unknown" : item.status,
              endedAt: unknown ? now : item.endedAt,
            });
          }
        } else if (!progress.length) {
          // This marker can stand for a batch; do not turn aggregate terminal
          // status into an individual agent outcome.
          state = jobUpdate(
            state,
            { jobId: async.jobId, type: "task", state: "running", toolCallId },
            now,
            { historical },
          );
        }
      }
    }
    if (details.op === "wait" && Array.isArray(details.jobs) && !historical) {
      const ids = [];
      for (const job of details.jobs) {
        if (typeof job?.id !== "string") continue;
        ids.push(job.id);
        state = jobUpdate(state, job, now);
      }
      if (state.waiting?.toolCallId === toolCallId)
        state = { ...state, waiting: { toolCallId, jobIds: ids } };
    }
    return state;
  }
  function delivery(state, message, now, historical = true) {
    if (message?.role !== "custom" || message.customType !== "async-result")
      return state;
    const details = message.details || {};
    const jobs =
      Array.isArray(details.jobs) && details.jobs.length
        ? details.jobs
        : [details];
    const when = timestamp(message.timestamp, now);
    for (const job of jobs) {
      if (typeof job?.jobId !== "string") continue;
      // Older versions omit status. The result is terminal, but its outcome
      // cannot be inferred from the model-facing notice text.
      state = jobUpdate(
        state,
        {
          ...job,
          status:
            statusOf(job.status) && !LIVE.has(job.status)
              ? job.status
              : "unknown",
        },
        when,
        {
          historical,
          output: jobs.length === 1 ? blockText(message.content) : "",
        },
      );
    }
    return state;
  }
  function applyFrame(state, frame, now = Date.now(), sequence) {
    if (!frame || typeof frame !== "object") return state;
    const sequenced = Number.isSafeInteger(sequence) && sequence > 0;
    if (sequenced && sequence <= (state.lastSeq || 0)) return state;
    if (sequenced) state = { ...state, lastSeq: sequence };
    const id = frame.toolCallId;
    switch (frame.type) {
      case "subagent_lifecycle":
        return agentUpdate(
          state,
          frame.payload || {},
          now,
          false,
          sequenced && frame.payload?.status === "started"
            ? `seq:${sequence}`
            : null,
        );
      case "subagent_progress":
        return agentUpdate(state, frame.payload || {}, now, true);
      case "tool_execution_start": {
        if (
          typeof id !== "string" ||
          !["bash", "eval", "task", "wait"].includes(frame.toolName)
        )
          return state;
        const key = foregroundKey(id);
        if (get(state, key) || find(state, (item) => item.toolCallId === id))
          return state;
        const base = {
          ...create(key, frame.toolName, now),
          toolCallId: id,
          background: false,
          label: labelFor(frame.toolName, frame.args, frame.intent),
        };
        const next = put(state, base);
        return frame.toolName === "wait"
          ? { ...next, waiting: { toolCallId: id, jobIds: [] } }
          : next;
      }
      case "tool_execution_update":
        return applyResult(
          state,
          id,
          frame.toolName,
          frame.partialResult,
          now,
          false,
        );
      case "tool_execution_end": {
        let next = applyResult(
          state,
          id,
          frame.toolName,
          frame.result,
          now,
          false,
        );
        const fg = get(next, foregroundKey(id));
        // A foreground-only completion is not a background history entry.
        if (fg && !fg.background) next = remove(next, fg.key);
        if (next.waiting?.toolCallId === id) next = { ...next, waiting: null };
        return next;
      }
      case "message_end":
        if (frame.message?.role === "toolResult")
          return applyResult(
            state,
            frame.message.toolCallId,
            frame.message.toolName,
            frame.message,
            now,
            false,
          );
        return delivery(state, frame.message, now, false);
      case "session_settled":
        return { ...state, pending: false };
      default:
        return state;
    }
  }
  function mergeMessages(state, messages, now = Date.now()) {
    // First associate labels with result metadata; no historical call start is
    // live. Existing journal observations remain authoritative over the past.
    const calls = new Map();
    for (const message of messages || []) {
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        for (const call of message.content)
          if (call?.type === "toolCall" && typeof call.id === "string")
            calls.set(call.id, call);
      }
      if (
        message?.role === "toolResult" &&
        typeof message.toolCallId === "string"
      ) {
        const call = calls.get(message.toolCallId);
        state = applyResult(
          state,
          message.toolCallId,
          message.toolName,
          message,
          timestamp(message.timestamp, now),
          true,
        );
        const item = find(
          state,
          (v) => v.toolCallId === message.toolCallId && v.background,
        );
        if (item && call && (!item.label || item.label === item.type)) {
          state = put(state, {
            ...item,
            label: labelFor(message.toolName, call.arguments, call.intent),
          });
        }
      } else state = delivery(state, message, now);
    }
    return state;
  }
  function mergeSnapshot(state, snapshot, now = Date.now()) {
    if (
      !snapshot?.supported ||
      !Array.isArray(snapshot.running) ||
      !Array.isArray(snapshot.recent)
    )
      return {
        ...state,
        snapshotNote:
          snapshot?.reason ||
          "Native job snapshots unavailable; showing observed activity.",
      };
    const owner = `${snapshot.epoch || ""}\u0000${snapshot.sessionId || ""}`;
    if (state.snapshotOwner && state.snapshotOwner !== owner) state = empty();
    state = {
      ...state,
      snapshotOwner: owner,
      snapshotNote: snapshot.complete
        ? null
        : "Native job list truncated; some running jobs may not be shown.",
    };
    const seen = new Set();
    for (const job of [...snapshot.recent, ...snapshot.running]) {
      if (typeof job?.id !== "string") continue;
      seen.add(job.id);
      const start = timestamp(job.startTime, now);
      const end = timestamp(job.endTime, null);
      const previous = byJob(state, job.id);
      const running = LIVE.has(job.status);
      if (running && previous?.status === "unknown")
        state = put(state, { ...previous, status: job.status, endedAt: null });
      else if (
        running &&
        previous &&
        !isLive(previous) &&
        start > (previous.endedAt ?? previous.startedAt)
      )
        state = put(state, {
          ...create(`job:${job.id}:${start}`, job.type, start),
          jobId: job.id,
        });
      state = jobUpdate(state, job, now);
      const current = byJob(state, job.id);
      if (current)
        state = put(state, {
          ...current,
          startedAt: start,
          endedAt: isLive(current) ? null : (end ?? current.endedAt),
          durationMs:
            end == null ? current.durationMs : Math.max(0, end - start),
          detail: text(job.command) || current.detail,
        });
    }
    if (snapshot.complete) {
      for (const key of state.order) {
        const job = get(state, key);
        if (job?.jobId && job.background && isLive(job) && !seen.has(job.jobId))
          state = update(state, job, { status: "unknown" }, now);
      }
    }
    return state;
  }
  function mergeSubagents(state, snapshots, now = Date.now()) {
    const seen = new Set();
    for (const s of snapshots || []) {
      if (typeof s?.id !== "string") continue;
      const callId = s.parentToolCallId || null;
      seen.add(`${callId || ""}\u0000${s.id}`);
      const observedAt = timestamp(s.lastUpdate, now);
      const previous = byAgent(state, s.id, callId);
      // Unlike an old tool result, get_subagents is a live snapshot. It can
      // establish that an earlier unknown-outcome record is running now.
      if (previous?.status === "unknown")
        state = put(state, { ...previous, status: "running", endedAt: null });
      const newRun =
        previous &&
        previous.status !== "unknown" &&
        !isLive(previous) &&
        LIVE.has(s.status)
          ? `snapshot:${observedAt}`
          : null;
      state = agentUpdate(
        state,
        {
          ...s,
          progress: {
            ...(s.progress || {}),
            id: s.id,
            status: s.status,
            agent: s.agent,
          },
          parentToolCallId: callId,
        },
        observedAt,
        true,
        newRun,
      );
    }
    for (const key of state.order) {
      const item = get(state, key);
      if (
        item?.agentId &&
        isLive(item) &&
        !seen.has(`${item.toolCallId || ""}\u0000${item.agentId}`)
      ) {
        state = update(state, item, { status: "unknown" }, now);
      }
    }
    return state;
  }
  function setPending(state, pending) {
    return { ...state, pending: pending === true };
  }
  function markDead(state, now = Date.now()) {
    let next = { ...state, pending: false, waiting: null };
    for (const key of state.order) {
      const item = get(next, key);
      if (!item || !isLive(item)) continue;
      next =
        item.background || item.agentId
          ? update(next, item, { status: "unknown" }, now)
          : remove(next, key);
    }
    return next;
  }
  function view(state) {
    const all = state.order.map((key) => state.items[key]).filter(Boolean);
    const active = all.filter(
      (item) =>
        isLive(item) &&
        !(
          item.type === "task" &&
          !item.agentId &&
          !item.background &&
          all.some(
            (a) => a.agentId && isLive(a) && a.toolCallId === item.toolCallId,
          )
        ),
    );
    const recent = all
      .filter((item) => !isLive(item))
      .reverse()
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    const waitingIds = new Set(state.waiting?.jobIds || []);
    return {
      active: active.map((item) => ({
        ...item,
        waitedFor: !!item.jobId && waitingIds.has(item.jobId),
      })),
      recent,
      backgroundActive: active.filter(
        (item) => item.background === true || !!item.agentId,
      ),
      waiting: state.waiting,
      snapshotNote: state.snapshotNote,
      pendingUnknown:
        state.pending && !active.some((item) => item.background === true),
    };
  }
  window.OMP_BACKGROUND_TASKS = Object.freeze({
    empty,
    applyFrame,
    mergeMessages,
    mergeSnapshot,
    mergeSubagents,
    setPending,
    markDead,
    view,
  });
})();
