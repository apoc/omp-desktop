// Native context inventory, scoped to each agent's active conversation branch.
// This state never creates transcript entries or consumes chat scrollback.
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
    instructions: [],
    skills: [],
    availableSkills: [],
    ...fields,
  });
  const empty = () => ({
    byId: { main: emptyAgent("main") },
    order: ["main"],
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
    const base = { id: entry.id, parentId: entry.parentId };
    if (entry.type === "custom" && entry.customType === TYPE)
      return { ...base, data: entry.data };
    if (entry.type === "session_init")
      return { ...base, init: { systemPrompt: entry.systemPrompt } };
    if (entry.type === "custom_message" && entry.customType === "skill-prompt")
      return entry.attribution === "user"
        ? {
            ...base,
            skill: { name: entry.details?.name, path: entry.details?.path },
          }
        : base;
    const m = entry.type === "message" ? entry.message : null;
    if (!m) return base;
    // Native autoloads have agent attribution; only an explicit invocation or
    // a completed read is evidence of session use, not automatic injection.
    if (m.role === "custom" && m.customType === "skill-prompt")
      return m.attribution === "user"
        ? { ...base, skill: { name: m.details?.name, path: m.details?.path } }
        : base;
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
              .map((b) => ({ id: b.id, path: b.arguments?.path }))
          : [],
      };
    if (m.role === "toolResult")
      return {
        ...base,
        result: {
          id: m.toolCallId,
          isError: m.isError,
          source: m.details?.meta?.source,
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

  function instructions(blocks, child) {
    const files = new Map();
    for (const block of blocks) {
      if (typeof block !== "string") continue;
      const rules = block.match(
        /<repo-rules>\r?\n([\s\S]*?)\r?\n<\/repo-rules>/,
      )?.[1];
      for (const match of (rules || "").matchAll(
        /^<file path="([^"\n]+)">\r?\n([\s\S]*?)^<\/file>/gm,
      )) {
        files.set(match[1], {
          id: `file:${match[1]}`,
          name: leafName(match[1]),
          path: match[1],
          text: match[2].replace(/\r?\n$/, ""),
        });
      }
    }
    // A child's session_init can carry its agent instructions without file
    // sections. Do not list the main agent's boilerplate system prompt.
    if (!files.size && child) {
      const body = blocks.filter(
        (b) =>
          typeof b === "string" &&
          b.trim() &&
          !b.trimStart().startsWith("<project-context>"),
      );
      if (body.length)
        return [
          { id: "agent", name: "Agent instructions", text: body.join("\n\n") },
        ];
    }
    return [...files.values()];
  }

  function nativeSkills(value) {
    const skills = new Map();
    for (const item of Array.isArray(value) ? value : []) {
      if (
        !item ||
        typeof item.name !== "string" ||
        typeof item.path !== "string" ||
        !["repo", "global"].includes(item.scope)
      )
        continue;
      skills.set(item.name, {
        id: item.name,
        name: item.name,
        path: item.path,
        scope: item.scope,
        description: text(item.description),
      });
    }
    return [...skills.values()];
  }

  function derive(agent, branch) {
    const calls = new Map(),
      skills = new Map();
    let currentInstructions = [],
      availableSkills = [],
      truncated = false;
    // Use the latest authoritative catalog even for earlier filesystem reads.
    for (const e of branch) {
      if (e.data?.version !== 1) continue;
      if (Array.isArray(e.data.skills))
        availableSkills = nativeSkills(e.data.skills);
    }
    const names = [
      ...new Set([...agent.skillNames, ...availableSkills.map((s) => s.name)]),
    ].sort((a, b) => b.length - a.length);
    const byName = new Map(availableSkills.map((s) => [s.name, s]));
    const byPath = new Map(
      availableSkills.map((s) => [s.path.replace(/\\/g, "/"), s]),
    );
    const resolveSkill = (path) => {
      const skill = skillUri(path, names);
      if (skill) return byName.get(skill.name) || skill;
      const file = text(path)
        .replace(/:(?:\d|raw\b).*$/, "")
        .replace(/\\/g, "/");
      return byPath.get(file);
    };
    const addSkill = (skill) => {
      if (skill?.name) skills.set(skill.name, { id: skill.name, ...skill });
    };
    for (const e of branch) {
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
        currentInstructions = instructions(blocks, agent.id !== "main");
      }
      for (const call of e.calls || []) calls.set(call.id, call);
      if (typeof e.skill?.name === "string" && typeof e.skill.path === "string")
        addSkill(byName.get(e.skill.name) || e.skill);
      if (e.result && !e.result.isError) {
        const source = e.result.source;
        const resolved =
          source?.type === "internal" ? resolveSkill(source.value) : null;
        if (resolved) addSkill(resolved);
        else {
          const path = text(calls.get(e.result.id)?.path);
          // A mixed batch may partly fail. Never credit it wholesale without
          // native per-result provenance proving which resource succeeded.
          if (!path.includes(";")) addSkill(resolveSkill(path));
        }
      }
    }
    return {
      ...agent,
      status: "ready",
      note: truncated
        ? "Instruction snapshot truncated at 512 Ki characters."
        : undefined,
      instructions: currentInstructions,
      availableSkills,
      skills: [...skills.values()],
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
    return put(
      state,
      derive(
        {
          ...agent,
          records: new Map(branch.map((e) => [e.id, e])),
          leafId,
          cursor: data.entries?.at(-1)?.id || agent.cursor,
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

  function view(state) {
    return {
      agents: state.order.map((id) => {
        const agent = get(state, id);
        return {
          id,
          label: agent.label,
          status: agent.runStatus || agent.status,
          note: agent.note,
          instructions: agent.instructions,
          skills: agent.skills,
          repoSkills: agent.availableSkills.filter((s) => s.scope === "repo"),
          globalSkills: agent.availableSkills.filter(
            (s) => s.scope === "global",
          ),
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
    view,
    skillUri,
  };
})();
