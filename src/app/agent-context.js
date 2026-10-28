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
    details: null,
    rpc: null,
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

  const normalizeSkillPath = (value) => text(value).trim()
    .replace(/:(?:\d|raw\b).*$/, "").replace(/\\/g, "/");
  const isSkillPath = (value, knownPaths) => {
    if (typeof value !== "string" || value.length > 16384 || value.includes(";")) return false;
    const path = normalizeSkillPath(value);
    return path.startsWith("skill://") || knownPaths.has(path);
  };
  // Keep ancestry, but never retain ordinary messages, arguments or output.
  function compact(entry, knownPaths) {
    const base = { id: entry.id, parentId: entry.parentId };
    if (entry.type === "custom" && entry.customType === TYPE)
      return { ...base, data: entry.data };
    if (entry.type === "session_init")
      return { ...base, init: { systemPrompt: entry.systemPrompt } };
    if (entry.type === "compaction") return { ...base, compaction: true };
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
              .filter((b) => b?.type === "toolCall" && typeof b.id === "string" && typeof b.name === "string")
              .map((b) => ({
                id: b.id,
                name: b.name,
                ...(["read", "functions.read"].includes(b.name) && isSkillPath(b.arguments?.path, knownPaths)
                  ? { path: b.arguments.path }
                  : {}),
              }))
          : [],
      };
    if (m.role === "toolResult")
      return {
        ...base,
        result: {
          id: m.toolCallId,
          isError: Boolean(m.isError || m.details?.isError),
          source: m.details?.meta?.source?.type === "internal" && isSkillPath(m.details.meta.source.value, knownPaths)
            ? { type: "internal", value: m.details.meta.source.value }
            : null,
          server: typeof m.details?.serverName === "string" ? m.details.serverName : null,
          tool: typeof m.details?.mcpToolName === "string" ? m.details.mcpToolName : null,
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

  const ORIGINS = [
    { id: "project", label: "Project skills", badge: "Project" },
    { id: "shared", label: "Shared skills", badge: "Shared" },
    { id: "omp", label: "OMP / current profile", badge: "OMP/profile" },
    { id: "other", label: "Other sources", badge: "Other" },
  ];
  const ORIGIN_REASONS = {
    "native-project":
      "OMP's native catalog explicitly marks this skill as project-scoped.",
    "project-root":
      "The native catalog path is inside a configuration directory of this project or one of its parents.",
    "project-path":
      "The native catalog path is inside the current project folder.",
    "user-root":
      "The native catalog path matches the recorded user-level source root below. This identifies its location, not who authored or bundled it.",
    "agent-dir":
      "The native catalog path is inside OMP's configured agent directory for this process. This does not mean the skill was bundled with OMP.",
    unclassified:
      "The native catalog supplied this path, but it does not match a recognized project, shared, or OMP source root.",
  };

  function skillOrigin(value, scope) {
    const group =
      ORIGINS.find((g) => g.id === value?.kind) ||
      ORIGINS[scope === "repo" ? 0 : 3];
    const label = text(value?.label) || group.badge;
    const basis = text(value?.basis);
    return {
      kind: group.id,
      label,
      badge: group.id === "other" ? label : group.badge,
      root: text(value?.root),
      explanation: own(ORIGIN_REASONS, basis)
        ? ORIGIN_REASONS[basis]
        : "This observation did not record source details; its origin has not been guessed.",
    };
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
        origin: skillOrigin(item.origin, item.scope),
      });
    }
    return [...skills.values()];
  }

  const finite = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
  const model = (m) => typeof m?.id === "string" && typeof m?.provider === "string"
    ? { provider: m.provider, id: m.id, contextWindow: finite(m.contextWindow),
      ...(m.toolSchemasInContext === false ? { toolSchemasInContext: false } : {}) }
    : null;
  const sameModel = (a, b) => a?.provider === b?.provider && a?.id === b?.id;
  const usage = (u) => u && typeof u === "object"
    ? { tokens: finite(u.tokens), contextWindow: finite(u.contextWindow), percent: finite(u.percent) }
    : null;
  const unavailableBreakdown = () => [
    { id: "system", label: "System prompt", tokens: null, estimated: false },
    { id: "tools", label: "Tool definitions", tokens: null, estimated: false },
    { id: "skills", label: "Skills", tokens: null, estimated: false },
    { id: "messages", label: "Messages", tokens: null, estimated: false },
  ];

  // These are local text estimates, not provider attribution. Keep the native
  // aggregate intact; its remainder includes messages, images and wire overhead.
  function utf8Bytes(value) {
    let bytes = 0;
    for (let i = 0; i < value.length; i++) {
      const code = value.codePointAt(i);
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      if (code > 0xffff) i++;
    }
    return bytes;
  }

  function estimateBreakdown(details, promptTruncated, toolsTruncated) {
    const counts = { system: null, skills: null, tools: null, messages: null };
    if (details.promptAvailable && !promptTruncated) {
      let all = 0,
        skills = 0;
      for (const section of details.systemPrompt) {
        all += utf8Bytes(section.text);
        for (const match of section.text.matchAll(/<skills>[\s\S]*?<\/skills>/g))
          skills += utf8Bytes(match[0]);
      }
      counts.system = Math.ceil((all - skills) / 4);
      counts.skills = Math.ceil(skills / 4);
    }
    if (details.model?.toolSchemasInContext === false) counts.tools = 0;
    else if (details.toolsAvailable && !toolsTruncated) {
      let bytes = 0;
      for (const tool of details.tools) {
        if (!tool.active) continue;
        bytes +=
          utf8Bytes(tool.name) +
          utf8Bytes(tool.description) +
          utf8Bytes(JSON.stringify(tool.parameters));
      }
      counts.tools = Math.ceil(bytes / 4);
    }
    const rows = details.breakdown.map((part) =>
      part.tokens !== null && !part.estimated
        ? part
        : {
            ...part,
            tokens: counts[part.id] ?? null,
            estimated: counts[part.id] != null,
          },
    );
    const nonMessage = rows.filter((part) => part.id !== "messages");
    const messages = rows.find((part) => part.id === "messages");
    if (
      messages &&
      (messages.tokens === null || messages.estimated) &&
      details.usage?.tokens != null &&
      nonMessage.every((part) => part.tokens !== null)
    ) {
      messages.tokens = Math.max(
        0,
        details.usage.tokens -
          nonMessage.reduce((sum, part) => sum + part.tokens, 0),
      );
      messages.estimated = true;
    }
    return rows;
  }
  const unknownMemory = () => ({
    status: "unavailable", backend: null, blocks: [], note: "Memory status is not available.",
  });
  const memoryBlocks = (blocks) => {
    const found = [];
    for (const section of blocks || []) {
      if (typeof section !== "string") continue;
      for (const match of section.matchAll(/<(memories|mental_models|memory-context|hindsight_memories|relevant_memories)>([\s\S]*?)<\/\1>/g)) {
        found.push({
          id: `memory:${found.length}`,
          name: match[1] === "mental_models" ? "Mental models" : "Memory context",
          text: match[2].trim(),
        });
      }
    }
    return found;
  };
  const promptSections = (blocks) => (blocks || [])
    .filter((block) => typeof block === "string")
    .map((block, index) => ({ id: `prompt:${index}`, name: `System prompt ${index + 1}`, text: block }));
  const boundedBlocks = (blocks) => {
    let remaining = 512 * 1024, truncated = false;
    const result = [];
    for (const block of blocks) {
      if (typeof block !== "string") continue;
      if (!remaining) { truncated = true; break; }
      let part = block.slice(0, remaining);
      if (part.length < block.length) {
        truncated = true;
        if (/[\uD800-\uDBFF]$/.test(part)) part = part.slice(0, -1);
      }
      result.push(part);
      remaining -= part.length;
    }
    return { blocks: result, truncated };
  };
  function toolsFrom(items, activeDefault = false) {
    const result = new Map();
    let remaining = 512 * 1024, truncated = false;
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item.name !== "string" || !item.name) continue;
      if (result.size >= 2048 || item.name.length > 4096) { truncated = true; continue; }
      const description = text(item.description).slice(0, 8192);
      if (text(item.description).length > description.length) truncated = true;
      let parameters = {};
      try {
        const encoded = JSON.stringify(item.parameters);
        if (typeof encoded === "string" && encoded.length <= remaining) {
          const parsed = JSON.parse(encoded);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            parameters = parsed;
            remaining -= encoded.length;
          }
        } else if (encoded) truncated = true;
      } catch { truncated = true; }
      const tool = {
        name: item.name, description,
        source: text(item.sourceInfo?.source) || text(item.source) || "unknown",
        server: text(item.mcpServerName) || text(item.sourceInfo?.mcpServerName) || text(item.server) || null,
        tool: text(item.mcpToolName) || text(item.sourceInfo?.mcpToolName) || text(item.tool) || null,
        active: typeof item.active === "boolean" ? item.active : activeDefault,
        parameters,
      };
      const size = JSON.stringify({ ...tool, parameters: {} }).length;
      if (size > remaining) { truncated = true; continue; }
      remaining -= size;
      result.set(tool.name, tool);
    }
    return { tools: [...result.values()], truncated };
  }
  function snapshotDetails(value, blocks) {
    if (!value || typeof value !== "object") return null;
    const memory = value.memory || unknownMemory();
    return {
      model: model(value.model),
      usage: usage(value.usage),
      breakdown: Array.isArray(value.breakdown) ? value.breakdown.map((part) => ({
        id: text(part?.id), label: text(part?.label), tokens: finite(part?.tokens),
        estimated: part?.estimated === true,
      })) : unavailableBreakdown(),
      tools: toolsFrom(value.tools).tools,
      toolsAvailable: Array.isArray(value.tools) && value.toolsAvailable !== false,
      memory: {
        status: ["ready", "off", "unavailable"].includes(memory.status) ? memory.status : "unavailable",
        backend: typeof memory.backend === "string" ? memory.backend : null,
        blocks: memoryBlocks(blocks),
        note: typeof memory.note === "string" ? memory.note : null,
      },
      systemPrompt: promptSections(blocks),
      promptAvailable: Array.isArray(blocks),
      retainedSkills: Array.isArray(value.retainedSkills)
        ? [...new Set(value.retainedSkills.filter((name) => typeof name === "string"))] : null,
      retainedCallIds: Array.isArray(value.retainedCallIds)
        ? [...new Set(value.retainedCallIds.filter((id) => typeof id === "string"))] : null,
      calls: [],
    };
  }
  function mergeRpc(details, rpc) {
    if (!rpc) return details;
    const base = details || snapshotDetails({}, null);
    const changed = own(rpc, "model") && !sameModel(base.model, rpc.model);
    const next = {
      ...base,
      ...(own(rpc, "model") ? { model: rpc.model } : {}),
      ...(own(rpc, "usage") ? { usage: rpc.usage } : {}),
      ...(changed ? {
        usage: own(rpc, "usage") ? rpc.usage : null,
        breakdown: unavailableBreakdown(),
        tools: [], toolsAvailable: false, systemPrompt: [], promptAvailable: false,
        retainedSkills: null, retainedCallIds: null, memory: unknownMemory(),
      } : {}),
    };
    if (rpc.blocks) {
      next.systemPrompt = promptSections(rpc.blocks);
      next.promptAvailable = true;
      next.memory = { ...next.memory, blocks: memoryBlocks(rpc.blocks) };
    }
    if (rpc.tools) {
      const active = new Map(rpc.tools.map((tool) => [tool.name, tool]));
      const observedByName = new Map(base.tools.map((tool) => [tool.name, tool]));
      const merged = changed ? new Map() : new Map(base.tools.map((tool) => [tool.name, {
        ...tool, active: active.has(tool.name),
      }]));
      for (const tool of rpc.tools) {
        const observed = observedByName.get(tool.name);
        merged.set(tool.name, observed
          ? { ...observed, description: tool.description, parameters: tool.parameters, active: true }
          : tool);
      }
      next.tools = [...merged.values()];
      next.toolsAvailable = true;
    }
    return next;
  }

  function derive(agent, branch) {
    const calls = new Map(),
      skills = new Map(),
      history = new Map();
    let currentInstructions = [],
      currentDetails = null,
      definitions = new Map(),
      availableSkills = [],
      truncated = false,
      detailsTruncated = false;
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
      if (skill?.name)
        skills.set(skill.name, {
          id: skill.name,
          ...skill,
          origin: skill.origin || skillOrigin(),
        });
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
        if (data) {
          currentDetails = snapshotDetails(data.details, blocks);
          detailsTruncated = Boolean(data.detailsTruncated);
          definitions = new Map((currentDetails?.tools || []).map((tool) => [tool.name, tool]));
        }
      }
      if (e.compaction && currentDetails) {
        currentDetails = { ...currentDetails, usage: null, retainedSkills: null, retainedCallIds: null };
      }
      for (const call of e.calls || []) {
        calls.set(call.id, call);
        const definition = definitions.get(call.name);
        if (!history.has(call.id)) history.set(call.id, {
          id: call.id, name: call.name,
          server: definition?.server || null, tool: definition?.tool || null,
          mcp: definition?.source === "mcp" || Boolean(definition?.server || definition?.tool),
          status: "unreturned",
        });
      }
      if (e.result) {
        const item = history.get(e.result.id);
        if (item) {
          item.status = e.result.isError ? "error" : "completed";
          if (e.result.server && e.result.tool) {
            item.server = e.result.server;
            item.tool = e.result.tool;
            item.mcp = true;
          }
        }
      }
      if (
        typeof e.skill?.name === "string" &&
        typeof e.skill.path === "string"
      ) {
        const selected = byName.get(e.skill.name);
        addSkill(
          selected?.path.replace(/\\/g, "/") ===
            e.skill.path.replace(/\\/g, "/")
            ? selected
            : e.skill,
        );
      }
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
    const rpc = agent.id === "main" ? agent.rpc : null;
    const details = mergeRpc(currentDetails, rpc);
    if (rpc?.blocks) currentInstructions = instructions(rpc.blocks, false);
    else if (rpc && own(rpc, "model") && currentDetails && !sameModel(currentDetails.model, rpc.model)) currentInstructions = [];
    if (details) {
      details.breakdown = estimateBreakdown(details,
        rpc?.blocks ? rpc.blocksTruncated : truncated,
        rpc?.tools ? rpc.toolsTruncated : detailsTruncated);
      const retained = details.retainedCallIds === null ? null : new Set(details.retainedCallIds);
      const historyItems = [...history.values()].filter((item) => item.mcp);
      if (historyItems.length > 2048) detailsTruncated = true;
      details.calls = historyItems.slice(-2048).map(({ mcp, ...item }) => ({
        ...item, retained: retained === null ? null : retained.has(item.id),
      }));
      delete details.retainedCallIds;
    }
    const notes = [];
    if (truncated || rpc?.blocksTruncated) notes.push("Instruction snapshot truncated at 512 Ki characters.");
    if (detailsTruncated || rpc?.toolsTruncated) notes.push("Context inventory was truncated.");
    if (details && !details.toolsAvailable) notes.push("Tool inventory is unavailable.");
    if (rpc && own(rpc, "model") && currentDetails && !sameModel(currentDetails.model, rpc.model) && (!rpc.blocks || !rpc.tools)) {
      notes.push("Some current model context is unavailable.");
    }
    return {
      ...agent,
      status: "ready",
      note: notes.length ? notes.join(" ") : undefined,
      instructions: currentInstructions,
      availableSkills,
      skills: [...skills.values()],
      details,
    };
  }

  function entries(state, id, data, fields = {}) {
    const previous = get(state, id) || emptyAgent(id);
    const agent = { ...previous, ...fields, skillNames: state.skillNames };
    const records = data.reset ? new Map() : new Map(agent.records);
    const knownPaths = new Set((data.reset ? [] : agent.availableSkills).map((skill) => normalizeSkillPath(skill.path)));
    // Include catalogs delivered later in the same page, while never keeping
    // an unrelated read argument just in case it might be a skill.
    for (const raw of data.entries || []) {
      if (raw?.type !== "custom" || raw.customType !== TYPE || raw.data?.version !== 1) continue;
      for (const skill of Array.isArray(raw.data.skills) ? raw.data.skills : []) {
        if (typeof skill?.path === "string") knownPaths.add(normalizeSkillPath(skill.path));
      }
    }
    let last = data.reset ? null : agent.leafId;
    for (const raw of data.entries || []) {
      if (typeof raw?.id !== "string" || raw.type === "session") continue;
      records.set(raw.id, compact(raw, knownPaths));
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

  // get_state is the only public idle-model refresh. It carries active tool
  // descriptors, not provenance; keep provenance only from matching native
  // observer definitions, never from a tool-name prefix.
  function rpc(state, value) {
    if (!value || typeof value !== "object") return state;
    const agent = get(state, "main");
    const incomingModel = own(value, "model") ? model(value.model) : undefined;
    const previousModel = agent.rpc && own(agent.rpc, "model") ? agent.rpc.model : agent.details?.model;
    const changed = own(value, "model") && !sameModel(previousModel, incomingModel);
    const next = changed ? {} : { ...(agent.rpc || {}) };
    if (own(value, "model")) next.model = incomingModel;
    if (own(value, "contextUsage")) next.usage = usage(value.contextUsage);
    if (Array.isArray(value.systemPrompt) || typeof value.systemPrompt === "string") {
      const bounded = boundedBlocks(Array.isArray(value.systemPrompt) ? value.systemPrompt : [value.systemPrompt]);
      next.blocks = bounded.blocks;
      next.blocksTruncated = bounded.truncated;
    }
    if (Array.isArray(value.dumpTools)) {
      const bounded = toolsFrom(value.dumpTools, true);
      next.tools = bounded.tools;
      next.toolsTruncated = bounded.truncated;
    }
    const branch = activeBranch(agent.records, agent.leafId);
    if (!branch) return put(state, { ...agent, rpc: next });
    return put(state, derive({ ...agent, rpc: next, skillNames: state.skillNames }, branch));
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
          details: agent.details,
          skillGroups: ORIGINS.map((group) => ({
            id: group.id,
            label: group.label,
            entries: agent.availableSkills.filter(
              (skill) => skill.origin.kind === group.id,
            ),
          })).filter((group) => group.entries.length > 0),
        };
      }),
    };
  }

  window.OMP_AGENT_CONTEXT = {
    TYPE,
    empty,
    get,
    entries,
    rpc,
    register,
    catalog,
    failed,
    view,
    skillUri,
  };
})();
