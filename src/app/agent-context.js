// Observed native context, scoped to a conversation and each agent's branch.
(function () {
  const TYPE = "omp-desktop:agent-context";
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const text = (value) => (typeof value === "string" ? value : "");
  const leafName = (path) => path.split(/[\\/]/).at(-1) || path;
  const emptyAgent = (id, fields = {}) => ({
    id,
    label: id === "main" ? "Main agent" : id,
    status: "loading",
    records: new Map(),
    leafId: null,
    cursor: null,
    nextByte: 0,
    harness: [],
    instructions: [],
    skills: [],
    events: [],
    ...fields,
  });
  const empty = () => ({
    byId: { main: emptyAgent("main") },
    order: ["main"],
    forgotten: new Set(),
    skillNames: [],
  });

  function put(state, agent) {
    return {
      ...state,
      byId: { ...state.byId, [agent.id]: agent },
      order: own(state.byId, agent.id)
        ? state.order
        : [...state.order, agent.id],
    };
  }
  function get(state, id) {
    return own(state.byId, id) ? state.byId[id] : undefined;
  }

  // Keep ancestry, but never retain ordinary messages or tool output bodies.
  function compact(entry) {
    const base = {
      id: entry.id,
      parentId: entry.parentId,
      runtime: entry.runtime,
      timestamp: entry.timestamp,
      activeLeafId: entry.activeLeafId,
    };
    if (entry.type === "custom" && entry.customType === TYPE)
      return { ...base, data: entry.data };
    if (entry.type === "session_init")
      return {
        ...base,
        init: { agent: entry.agent, systemPrompt: entry.systemPrompt },
      };
    if (entry.type === "custom_message" && entry.customType === "skill-prompt")
      return {
        ...base,
        skill: { name: entry.details?.name, path: entry.details?.path },
      };
    const m = entry.type === "message" ? entry.message : null;
    if (!m) return base;
    if (m.role === "custom" && m.customType === "skill-prompt")
      return {
        ...base,
        skill: { name: m.details?.name, path: m.details?.path },
      };
    if (m.role === "assistant")
      return {
        ...base,
        calls: Array.isArray(m.content)
          ? m.content
              .filter(
                (b) =>
                  b.type === "toolCall" &&
                  ["read", "functions.read"].includes(b.name),
              )
              .map((b) => ({
                id: b.id,
                name: b.name,
                args: { path: b.arguments?.path },
              }))
          : [],
        visibleTs:
          Array.isArray(m.content) &&
          m.content.some(
            (b) =>
              (b.type === "text" && b.text) ||
              (b.type === "thinking" && b.thinking),
          )
            ? m.timestamp
            : null,
      };
    if (m.role === "user") return { ...base, visibleTs: m.timestamp };
    if (m.role === "toolResult")
      return {
        ...base,
        result: {
          id: m.toolCallId,
          tool: m.toolName,
          isError: m.isError,
          details: { meta: { source: m.details?.meta?.source } },
        },
      };
    return base;
  }

  function activeBranch(records, leafId) {
    const seen = new Set(),
      branch = [];
    for (let id = leafId; id != null;) {
      if (seen.has(id) || !records.has(id)) return null;
      seen.add(id);
      const entry = records.get(id);
      branch.push(entry);
      id = entry.parentId;
    }
    return branch.reverse();
  }

  function skillUri(path, names = []) {
    if (typeof path !== "string") return null;
    const uri = path.trim().replace(/:(?:\d|raw\b|img\b).*$/, "");
    const match = /^skill:\/\/([^?#]+)(?:[?#].*)?$/.exec(uri);
    if (!match) return null;
    const resource = match[1].replace(/\/SKILL\.md$/, "");
    const name =
      names.find(
        (name) => resource === name || resource.startsWith(`${name}/`),
      ) || resource;
    return { name, path: `skill://${name}` };
  }

  function instructions(blocks) {
    const rows = [];
    for (const [i, block] of blocks.entries()) {
      if (typeof block !== "string" || !block.trim()) continue;
      const project = block.trimStart().startsWith("<project-context>");
      rows.push({
        id: `block:${i}`,
        name: project ? "Project instructions" : `System instructions ${i + 1}`,
        detail: `Native effective prompt · ${block.length.toLocaleString()} characters`,
        text: block,
      });
      // These labels come only from the native prompt's file sections, never
      // filesystem rediscovery or assistant prose. The full block remains inspectable.
      if (project) {
        const rules = block.match(
          /<repo-rules>\n([\s\S]*?)\n<\/repo-rules>/,
        )?.[1];
        for (const match of (rules || "").matchAll(
          /^<file path="([^"\n]+)">\n/gm,
        )) {
          rows.push({
            id: `file:${match[1]}`,
            name: leafName(match[1]),
            path: match[1],
            detail: "Included in the native project-prompt file sections",
            blockId: `block:${i}`,
          });
        }
      }
    }
    return rows;
  }

  function derive(agent, branch) {
    const calls = new Map(),
      skills = new Map(),
      events = [];
    let harness = [],
      currentInstructions = [],
      promptKey = null,
      runtimeKey = null,
      afterTs = null,
      truncated = false;
    const marker = (e, kind, key, title, body, path, toolCallId) => {
      const row = {
        kind: "context",
        contextKind: kind,
        agentId: agent.id,
        agentLabel: agent.label,
        title,
        text: body,
        sourcePath: path,
        _id: `context:${agent.id}:${e.id}:${kind}:${key}`,
        anchorTs: afterTs,
        anchorToolId: agent.parentToolCallId || toolCallId || null,
      };
      events.push(row);
      return row._id;
    };
    for (const e of branch) {
      if (typeof e.runtime?.version === "string") {
        const key = JSON.stringify(e.runtime);
        if (key !== runtimeKey) {
          runtimeKey = key;
          const detail = [e.runtime.label, e.runtime.branch, e.runtime.commit]
            .filter((v) => typeof v === "string")
            .join(" · ");
          const name = `omp ${e.runtime.version}`;
          harness = [
            {
              id: "runtime",
              name,
              detail,
              messageId: marker(e, "harness", "runtime", name, detail),
            },
          ];
        }
      }
      const data =
        e.data?.version === 1 && Array.isArray(e.data.blocks) ? e.data : null;
      const blocks =
        data?.blocks ||
        (e.init
          ? Array.isArray(e.init.systemPrompt)
            ? e.init.systemPrompt
            : [e.init.systemPrompt]
          : null);
      if (blocks) {
        truncated = Boolean(data?.truncated);
        const key = JSON.stringify(blocks);
        if (key !== promptKey) {
          promptKey = key;
          currentInstructions = instructions(blocks);
          const ids = new Map();
          for (const item of currentInstructions)
            if (item.text != null)
              ids.set(
                item.id,
                marker(e, "instruction", item.id, item.name, item.text),
              );
          currentInstructions = currentInstructions.map((item) => ({
            ...item,
            messageId: ids.get(item.blockId || item.id),
            source: data ? "native context observer" : "native session_init",
          }));
        }
        if (data)
          currentInstructions = currentInstructions.map((item) => ({
            ...item,
            source: "native context observer",
          }));
        const definition = text(data?.agent?.name) || text(e.init?.agent);
        if (definition && !harness.some((h) => h.id === "definition")) {
          harness = [
            ...harness,
            {
              id: "definition",
              name: definition,
              source: agent.agentSource || "native agent definition",
            },
          ];
        }
      }
      for (const call of e.calls || []) calls.set(call.id, call);
      const addSkill = (skill, source, toolId) => {
        if (!skill?.name) return;
        const id = skill.name;
        const messageId = marker(
          e,
          "skill",
          id,
          skill.name,
          source,
          skill.path,
          toolId,
        );
        const prior = skills.get(id);
        skills.set(id, {
          id,
          ...skill,
          source,
          messageId,
          loads: (prior?.loads || 0) + 1,
        });
      };
      if (
        e.skill &&
        typeof e.skill.name === "string" &&
        typeof e.skill.path === "string"
      )
        addSkill(
          { name: e.skill.name, path: e.skill.path },
          "native skill invocation",
        );
      if (e.result) {
        const result = e.result,
          call = calls.get(result.id);
        if (!result.isError) {
          const source = result.details?.meta?.source;
          const resolved =
            source?.type === "internal"
              ? skillUri(source.value, agent.skillNames)
              : null;
          if (resolved)
            addSkill(resolved, "successful native skill read", result.id);
          else if (["read", "functions.read"].includes(call?.name)) {
            const path = text(call.args?.path);
            // A mixed batch may partly fail; only native per-result metadata
            // can prove which members succeeded. Never credit the whole batch.
            const skill = path.includes(";")
              ? null
              : skillUri(path, agent.skillNames);
            if (skill) addSkill(skill, "successful skill read", result.id);
          }
        }
      }
      if (e.visibleTs != null) afterTs = e.visibleTs;
    }
    return {
      ...agent,
      status: "ready",
      note: truncated
        ? "Native prompt snapshot truncated at 512 Ki characters."
        : currentInstructions.length
          ? undefined
          : "Native prompt snapshot not recorded for this agent yet.",
      harness,
      instructions: currentInstructions,
      skills: [...skills.values()],
      events: events.slice(-169),
    };
  }

  function entries(state, id, data, fields = {}) {
    const previous = get(state, id) || emptyAgent(id);
    const agent = { ...previous, ...fields, skillNames: state.skillNames };
    const records = data.reset ? new Map() : new Map(agent.records);
    let last = data.reset ? null : agent.leafId;
    for (const raw of data.entries || []) {
      if (typeof raw?.id !== "string" || raw.type === "session") continue;
      records.set(raw.id, compact(raw));
      last = raw.activeLeafId !== undefined ? raw.activeLeafId : raw.id;
    }
    const leafId = own(data, "leafId") ? data.leafId : last;
    const branch = activeBranch(records, leafId);
    if (!branch)
      return put(state, {
        ...agent,
        status: "error",
        note: "Native context ancestry is incomplete; context was not guessed.",
      });
    // Retain only ancestry metadata and context observations on this branch.
    const kept = new Map(branch.map((e) => [e.id, e]));
    const cursor = data.entries?.at(-1)?.id || agent.cursor;
    return put(
      state,
      derive(
        {
          ...agent,
          records: kept,
          leafId,
          cursor,
          nextByte: data.nextByte ?? agent.nextByte,
        },
        branch,
      ),
    );
  }

  function register(state, item) {
    if (!item?.id || item.id === "main") return state;
    const old = get(state, item.id);
    const changedOwner =
      old &&
      item.sessionFile &&
      old.sessionFile &&
      item.sessionFile !== old.sessionFile;
    const base = !old || changedOwner ? emptyAgent(item.id) : old;
    return put(state, {
      ...base,
      label: item.label || item.id,
      sessionFile: item.sessionFile || base.sessionFile,
      parentToolCallId: item.parentToolCallId || base.parentToolCallId,
      agentSource: item.agentSource || base.agentSource,
      runStatus: item.status || base.runStatus,
    });
  }

  function catalog(state, commands) {
    const names = [
      ...new Set(
        (commands || [])
          .filter((c) => c.source === "skill" && typeof c.name === "string")
          .map((c) => c.name.replace(/^skill:/, "")),
      ),
    ].sort((a, b) => b.length - a.length);
    if (JSON.stringify(names) === JSON.stringify(state.skillNames))
      return state;
    let next = { ...state, skillNames: names };
    for (const id of state.order) {
      const agent = get(state, id),
        branch = activeBranch(agent.records, agent.leafId);
      if (branch)
        next = put(next, derive({ ...agent, skillNames: names }, branch));
    }
    return next;
  }

  function failed(state, id, error) {
    const agent = get(state, id);
    return agent
      ? put(state, {
          ...agent,
          status: "error",
          note: `Context could not be refreshed: ${String(error?.message || error)}`,
        })
      : state;
  }

  function forget(state, removed) {
    const ids = removed.filter((m) => m.kind === "context").map((m) => m._id);
    if (!ids.length) return state;
    const recent = new Set(
      state.order
        .flatMap((id) => get(state, id)?.events || [])
        .map((e) => e._id),
    );
    return {
      ...state,
      forgotten: new Set(
        [...state.forgotten, ...ids].filter((id) => recent.has(id)),
      ),
    };
  }

  function markers(state, messages, trimmed = false) {
    const base = messages.filter((m) => m.kind !== "context"),
      slots = new Map();
    const all = state.order
      .flatMap((id) => get(state, id)?.events || [])
      .slice(-169);
    for (const row of all) {
      if (state.forgotten.has(row._id)) continue;
      let at = row.anchorToolId
        ? base.findIndex(
            (m) => m.kind === "tool" && m._toolCallId === row.anchorToolId,
          )
        : -1;
      if (at < 0 && row.anchorTs != null)
        at = base.findIndex((m) => m.ts === row.anchorTs);
      if (at < 0 && trimmed) continue;
      const position = at < 0 && row.anchorTs != null ? base.length : at + 1;
      const group = slots.get(position) || [];
      group.push(row);
      slots.set(position, group);
    }
    const next = [];
    for (let i = 0; i <= base.length; i++) {
      if (slots.has(i)) next.push(...slots.get(i));
      if (i < base.length) next.push(base[i]);
    }
    return next.length === messages.length &&
      next.every((m, i) => m === messages[i])
      ? messages
      : next;
  }

  function view(state, messages) {
    const visible = messages
      ? new Set(messages.filter((m) => m.kind === "context").map((m) => m._id))
      : null;
    const rows = (items) =>
      visible
        ? items.map((item) =>
            item.messageId && !visible.has(item.messageId)
              ? { ...item, messageId: undefined }
              : item,
          )
        : items;
    return {
      agents: state.order.map((id) => {
        const agent = get(state, id);
        return {
          id,
          label: agent.label,
          status: agent.runStatus || agent.status,
          note: agent.note,
          harness: rows(agent.harness),
          instructions: rows(agent.instructions),
          skills: rows(agent.skills),
        };
      }),
    };
  }

  window.OMP_AGENT_CONTEXT = {
    TYPE,
    empty,
    get,
    entries,
    register,
    catalog,
    failed,
    forget,
    markers,
    view,
    skillUri,
  };
})();
