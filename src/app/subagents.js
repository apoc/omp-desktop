// Subagent manager state: a pure reducer over omp's RPC subagent frames
// (`subagent_lifecycle` / `subagent_progress` / `subagent_event`) plus the
// `get_subagents` snapshot, and the selectors/formatters the manager UI
// (src/design/subagents/) renders from. No side effects, no DOM, no bridge.
//
// Why the desktop keeps its own copy instead of mirroring `get_subagents`:
// omp's RpcSubagentRegistry *deletes* an agent the moment it reaches a
// terminal status, so the server can only answer "who is running now".
// The manager must also show what finished, how, and at what cost, so a
// terminal agent stays here (with `endedAt`) until the session changes.
//
// Frames only reach the active tab (live.js listens per session), so a
// background tab misses them; `mergeSnapshots` reconciles on re-activation
// and marks agents that vanished meanwhile as ended with an unknown outcome.
//
// Wire shapes: oh-my-pi packages/coding-agent/src/modes/rpc/rpc-types.ts
// (RpcSubagentSnapshot, RpcSubagent*Frame) and packages/wire/src/index.ts
// (AgentProgress, SubagentLifecyclePayload, SubagentProgressPayload).
(function () {
  const STREAM_CAP = 200;
  const TERMINAL = new Set(["completed", "failed", "aborted"]);
  const LIVE = new Set(["pending", "running"]);
  const HUES = ["var(--cyan)", "var(--lilac)", "var(--magenta)", "var(--amber)", "var(--lime)", "var(--accent)"];

  function emptySubagents() {
    return { byId: {}, order: [] };
  }

  const isTerminal = status => TERMINAL.has(status);
  const isLive = status => LIVE.has(status);

  // Nested subagents carry dotted ids (`Parent.Child`, same as agent:// URIs).
  function parentIdOf(id) {
    const i = id.lastIndexOf(".");
    return i < 0 ? null : id.slice(0, i);
  }
  // Ids are model-chosen names: `constructor` or `toString` must not resolve
  // to Object.prototype members through a plain `byId[id]` lookup.
  const hasOwn = Object.prototype.hasOwnProperty;
  function getAgent(state, id) {
    return hasOwn.call(state.byId, id) ? state.byId[id] : undefined;
  }

  // Mirrors the server's hasSameOwner: an id reissued under a different task
  // call (or session file) is a different agent; its frames must not land on
  // the record we already hold.
  function sameOwner(payload, agent) {
    if (payload.parentToolCallId !== undefined && agent.parentToolCallId !== undefined) {
      return payload.parentToolCallId === agent.parentToolCallId;
    }
    if (payload.sessionFile !== undefined && agent.sessionFile !== undefined) {
      return payload.sessionFile === agent.sessionFile;
    }
    return true;
  }

  function put(state, agent) {
    const known = hasOwn.call(state.byId, agent.id);
    return {
      byId: { ...state.byId, [agent.id]: agent },
      order: known ? state.order : [...state.order, agent.id],
    };
  }

  function freshAgent(id, now) {
    return {
      id, index: 0, agent: "", agentSource: undefined, description: undefined,
      status: "pending", task: undefined, assignment: undefined,
      sessionFile: undefined, parentToolCallId: undefined,
      startedAt: now, endedAt: null, lastUpdate: now, unknownOutcome: false,
      progress: null, stream: [],
    };
  }

  function applyLifecycle(state, p, now) {
    const existing = getAgent(state, p.id);
    if (existing && !sameOwner(p, existing)) return state;
    if (!existing && p.status !== "started") return state;
    // A `started` for an id we hold as finished is a new run of that id.
    const base = !existing || (p.status === "started" && isTerminal(existing.status))
      ? freshAgent(p.id, now)
      : existing;
    const status = p.status === "started" ? "running" : p.status;
    return put(state, {
      ...base,
      index: p.index,
      agent: p.agent,
      agentSource: p.agentSource ?? base.agentSource,
      description: p.description ?? base.description,
      status,
      sessionFile: p.sessionFile ?? base.sessionFile,
      parentToolCallId: p.parentToolCallId ?? base.parentToolCallId,
      endedAt: isTerminal(status) ? (base.endedAt ?? now) : null,
      lastUpdate: now,
    });
  }

  function applyProgress(state, p, now) {
    const progress = p.progress;
    if (!progress?.id) return state;
    const existing = getAgent(state, progress.id);
    if (existing && !sameOwner(p, existing)) return state;
    // Late progress after the terminal lifecycle frame must not revive it.
    if (existing && isTerminal(existing.status) && !isTerminal(progress.status)) return state;
    // Receive time is not start time: frames replayed from the backend
    // journal after a tab switch arrive late, so omp's own `durationMs` wins
    // whenever it points to an earlier start. No record at all means we
    // subscribed after its lifecycle frame.
    const reportedStart = now - (progress.durationMs ?? 0);
    const base = existing ?? freshAgent(progress.id, reportedStart);
    return put(state, {
      ...base,
      startedAt: Math.min(base.startedAt, reportedStart),
      index: p.index,
      agent: p.agent,
      agentSource: p.agentSource ?? base.agentSource,
      description: progress.description ?? base.description,
      status: progress.status,
      task: p.task ?? base.task,
      assignment: p.assignment ?? base.assignment,
      sessionFile: p.sessionFile ?? base.sessionFile,
      parentToolCallId: p.parentToolCallId ?? base.parentToolCallId,
      endedAt: isTerminal(progress.status) ? (base.endedAt ?? now) : null,
      lastUpdate: now,
      progress,
    });
  }

  /** Tool args (object or string) → one readable line: a lone value bare,
   *  several as `key value · key value`. */
  function formatArgs(args) {
    if (args == null) return "";
    let text;
    if (typeof args === "string") text = args;
    else {
      const entries = Object.entries(args).filter(([, v]) => v != null && typeof v !== "object");
      text = entries.length === 1 ? String(entries[0][1])
        : entries.length > 0 ? entries.map(([k, v]) => `${k} ${v}`).join(" · ")
        : JSON.stringify(args);
    }
    return text.length > 120 ? `${text.slice(0, 117)}…` : text;
  }

  // One AgentSessionEvent → one stream line, or null for events the live
  // stream does not show (deltas, turn bookkeeping).
  function summarizeEvent(ev, now) {
    switch (ev?.type) {
      case "tool_execution_start":
        return { t: now, kind: "tool", tool: ev.toolName ?? "", text: formatArgs(ev.args) };
      case "tool_execution_end":
        return ev.isError ? { t: now, kind: "error", tool: ev.toolName ?? "", text: "tool failed" } : null;
      case "message_end": {
        const blocks = ev.message?.role === "assistant" ? ev.message.content ?? [] : [];
        const text = blocks.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
        return text ? { t: now, kind: "text", text } : null;
      }
      default:
        return null;
    }
  }

  function applyEvent(state, p, now) {
    const existing = getAgent(state, p.id);
    if (!existing) return state;
    const line = summarizeEvent(p.event, now);
    if (!line) return state;
    const stream = existing.stream.length >= STREAM_CAP
      ? [...existing.stream.slice(existing.stream.length - STREAM_CAP + 1), line]
      : [...existing.stream, line];
    return put(state, { ...existing, stream, lastUpdate: now });
  }

  /** Fold one RPC frame into the state. Unknown frames return `state` as-is. */
  function applySubagentFrame(state, frame, now = Date.now()) {
    switch (frame?.type) {
      case "subagent_lifecycle": return applyLifecycle(state, frame.payload ?? {}, now);
      case "subagent_progress":  return applyProgress(state, frame.payload ?? {}, now);
      case "subagent_event":     return applyEvent(state, frame.payload ?? {}, now);
      default:                   return state;
    }
  }

  /** Reconcile with a `get_subagents` response (`data.subagents`): the
   *  server lists exactly the agents still running. Anything we hold as
   *  live but absent there finished while this tab was not listening. */
  function mergeSnapshots(state, snapshots, now = Date.now()) {
    let next = state;
    const seen = new Set();
    for (const s of snapshots ?? []) {
      seen.add(s.id);
      const existing = getAgent(next, s.id);
      if (existing && !sameOwner(s, existing)) continue;
      // omp stamps `lastUpdate` when it emitted the progress it reports, so
      // `lastUpdate - durationMs` is the start even after a long quiet spell.
      const reportedStart = (s.lastUpdate || now) - (s.progress?.durationMs ?? 0);
      // A kept-alive agent (workpool / follow-up turn) reuses its id: listed
      // live while we hold it finished means a new run whose `started`
      // frame fell outside the replay journal — not a revival of the old one.
      // A still-live record can hide a re-run too, when both the end of
      // turn N and the start of N+1 were lost: omp's snapshot start is exact
      // and every local start estimate is at or after the true start, so a
      // snapshot start clearly *later* than ours can only be a newer run.
      const rerun = existing && (isTerminal(existing.status)
        ? !isTerminal(s.status)
        : Boolean(s.lastUpdate) && reportedStart > existing.startedAt + 1000);
      const base = !existing || rerun ? freshAgent(s.id, reportedStart) : existing;
      next = put(next, {
        ...base,
        startedAt: Math.min(base.startedAt, reportedStart),
        index: s.index, agent: s.agent, agentSource: s.agentSource,
        description: s.description ?? base.description, status: s.status,
        task: s.task ?? base.task, assignment: s.assignment ?? base.assignment,
        sessionFile: s.sessionFile ?? base.sessionFile,
        parentToolCallId: s.parentToolCallId ?? base.parentToolCallId,
        endedAt: isTerminal(s.status) ? (base.endedAt ?? now) : null,
        progress: s.progress ?? base.progress, lastUpdate: now,
      });
    }
    for (const id of next.order) {
      const a = next.byId[id];
      if (!seen.has(id) && isLive(a.status)) {
        next = put(next, { ...a, status: "completed", unknownOutcome: true, endedAt: now, lastUpdate: now });
      }
    }
    return next;
  }

  /** Fold a `get_subagent_messages` result into the cached transcript. The
   *  server tails the agent's session file from `fromByte`; `reset` means
   *  the file shrank (rewritten) and the tail restarted at byte 0. */
  function mergeTranscript(prev, data) {
    const messages = data.reset || !prev ? data.messages ?? [] : [...prev.messages, ...(data.messages ?? [])];
    return { status: "ready", messages, nextByte: data.nextByte ?? 0, error: null };
  }

  // ── Selectors ──────────────────────────────────────────────────────────

  const FILTERS = {
    all:    () => true,
    live:   a => isLive(a.status),
    done:   a => a.status === "completed",
    failed: a => a.status === "failed" || a.status === "aborted",
  };

  function listAgents(state, filter = "all") {
    const keep = FILTERS[filter] ?? FILTERS.all;
    return state.order.map(id => state.byId[id]).filter(keep);
  }

  /** The main-session task call an agent traces back to: nested agents
   *  (`Parent.Child`) report the call inside their parent's own session,
   *  which never appears in the main chat, so walk up to the root agent. */
  function rootCallIdOf(state, agent) {
    let cur = agent;
    for (let pid = parentIdOf(cur.id); pid && getAgent(state, pid); pid = parentIdOf(cur.id)) cur = getAgent(state, pid);
    return cur.parentToolCallId ?? null;
  }

  /** Group by the task call that spawned the root of each agent's nesting
   *  chain; within a group, children follow their parent (DFS, siblings by
   *  spawn index). An agent whose parent was filtered out is a group root.
   *  `rows[].depth` is the depth in the *displayed* tree, not in the id. */
  function groupByCall(state, agents) {
    const groups = new Map();
    for (const a of agents) {
      const key = rootCallIdOf(state, a) ?? "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    const bySpawn = (x, y) => x.index - y.index || x.id.localeCompare(y.id);
    return [...groups].map(([callId, list]) => {
      const ids = new Set(list.map(a => a.id));
      const children = new Map();
      const roots = [];
      for (const a of list) {
        const pid = parentIdOf(a.id);
        if (pid && ids.has(pid)) {
          if (!children.has(pid)) children.set(pid, []);
          children.get(pid).push(a);
        } else {
          roots.push(a);
        }
      }
      const rows = [];
      const visit = (agent, depth) => {
        rows.push({ agent, depth });
        for (const c of (children.get(agent.id) ?? []).sort(bySpawn)) visit(c, depth + 1);
      };
      roots.sort(bySpawn).forEach(a => visit(a, 0));
      return { callId: callId || null, rows };
    });
  }

  function totals(agents) {
    const t = { total: 0, live: 0, done: 0, failed: 0, tokens: 0, cost: 0, tools: 0, requests: 0 };
    for (const a of agents) {
      t.total++;
      if (isLive(a.status)) t.live++;
      else if (a.status === "completed") t.done++;
      else t.failed++;
      t.tokens += a.progress?.tokens ?? 0;
      t.cost += a.progress?.cost ?? 0;
      t.tools += a.progress?.toolCount ?? 0;
      t.requests += a.progress?.requests ?? 0;
    }
    return t;
  }

  /** Stable identity colour per agent id (same agent, same hue everywhere). */
  function agentHue(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return HUES[Math.abs(h) % HUES.length];
  }

  function elapsedMs(agent, now = Date.now()) {
    if (isLive(agent.status)) return Math.max(0, now - agent.startedAt);
    return agent.progress?.durationMs ?? Math.max(0, (agent.endedAt ?? now) - agent.startedAt);
  }

  /** The subscription the manager needs: full event stream only while an
   *  agent is being inspected (it is the expensive level), progress else. */
  function subscriptionLevelFor({ inspecting }) {
    return inspecting ? "events" : "progress";
  }

  // ── Formatters ─────────────────────────────────────────────────────────

  function fmtDuration(ms) {
    if (ms == null) return "—";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    // Tier on the rounded value: 59_999ms must not print "60.0s".
    if (ms < 59_950) return `${(ms / 1000).toFixed(1)}s`;
    const secs = Math.round(ms / 1000);
    return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
  }
  function fmtCost(usd) {
    if (!usd) return "$0.00";
    return usd < 0.1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
  }
  function fmtAgo(ms) {
    if (ms < 1500) return "now";
    // Tier on the rounded value: 59_600ms must not print "60s".
    if (ms < 59_500) return `${Math.round(ms / 1000)}s`;
    return `${Math.round(ms / 60_000)}m`;
  }

  window.OMP_SUBAGENTS = {
    emptySubagents, applySubagentFrame, mergeSnapshots, mergeTranscript, summarizeEvent, formatArgs,
    listAgents, groupByCall, rootCallIdOf, totals, agentHue, elapsedMs, subscriptionLevelFor,
    getAgent, parentIdOf, isLive, isTerminal,
    fmtDuration, fmtCost, fmtAgo,
  };
})();
