import os from "node:os";
import path from "node:path";

// Loaded by native omp, including its task children. Custom entries are local
// extension state: never model messages, commands, or extra provider requests.
export default function desktopContext(api) {
  const LIMIT = 512 * 1024;
  const TOOL_LIMIT = 512 * 1024;
  const TOOL_COUNT_LIMIT = 2048;
  let previousFile, previousKey, generation = 0, pending, latest, liveContext;
  let memory = { status: "unavailable", backend: null, blocks: [], note: "Memory status is not available." };
  const number = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const modelOf = (model) =>
    typeof model?.id === "string" && typeof model?.provider === "string"
      ? { provider: model.provider, id: model.id, contextWindow: number(model.contextWindow) }
      : null;
  const modelKey = (model) => JSON.stringify(modelOf(model));
  const usageOf = (usage) =>
    usage && typeof usage === "object"
      ? { tokens: number(usage.tokens), contextWindow: number(usage.contextWindow), percent: number(usage.percent) }
      : null;
  const leafOf = (ctx) => ctx.sessionManager.getLeafId?.();
  const breakdown = [
    { id: "system", label: "System prompt", tokens: null, estimated: false },
    { id: "tools", label: "Tool definitions", tokens: null, estimated: false },
    { id: "skills", label: "Skills", tokens: null, estimated: false },
    { id: "messages", label: "Messages", tokens: null, estimated: false },
  ];
  const toolInventory = () => {
    if (typeof api.getAllTools !== "function" || typeof api.getActiveTools !== "function")
      return { tools: [], available: false, truncated: false };
    let active, all;
    try {
      const activeNames = api.getActiveTools();
      all = api.getAllTools();
      if (!Array.isArray(activeNames) || !Array.isArray(all))
        return { tools: [], available: false, truncated: false };
      active = new Set(activeNames);
    } catch {
      return { tools: [], available: false, truncated: false };
    }
    const tools = new Map();
    let remaining = TOOL_LIMIT, truncated = false;
    for (const item of all) {
      if (!item || typeof item.name !== "string" || !item.name) continue;
      if (tools.size >= TOOL_COUNT_LIMIT || item.name.length > 4096) {
        truncated = true;
        continue;
      }
      const description = typeof item.description === "string" ? item.description.slice(0, 8192) : "";
      if (typeof item.description === "string" && item.description.length > description.length) truncated = true;
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
      } catch {
        truncated = true;
      }
      const tool = {
        name: item.name,
        description,
        source: typeof item.sourceInfo?.source === "string" ? item.sourceInfo.source : "unknown",
        server: typeof item.mcpServerName === "string" ? item.mcpServerName
          : typeof item.sourceInfo?.mcpServerName === "string" ? item.sourceInfo.mcpServerName : null,
        tool: typeof item.mcpToolName === "string" ? item.mcpToolName
          : typeof item.sourceInfo?.mcpToolName === "string" ? item.sourceInfo.mcpToolName : null,
        active: active.has(item.name),
        parameters,
      };
      const size = JSON.stringify({ ...tool, parameters: {} }).length;
      if (size > remaining) {
        truncated = true;
        continue;
      }
      remaining -= size;
      tools.set(item.name, tool);
    }
    return { tools: [...tools.values()], available: true, truncated };
  };
  const publish = (ctx, data) => {
    const file = ctx.sessionManager.getSessionFile();
    const key = JSON.stringify(data);
    if (file !== previousFile || key !== previousKey) {
      const leaf = leafOf(ctx);
      api.appendEntry("omp-desktop:agent-context", data);
      if (pending && pending.expectedLeaf === leaf) pending.expectedLeaf = leafOf(ctx);
      previousKey = key;
    }
    previousFile = file;
  };
  const refreshMemory = (ctx) => {
    if (typeof ctx.memory?.status !== "function") return;
    const request = {
      generation,
      file: ctx.sessionManager.getSessionFile(),
      model: modelKey(ctx.model),
      expectedLeaf: leafOf(ctx),
    };
    pending = request;
    const isCurrent = () => {
      const current = pending === request && request.generation === generation &&
        ctx.sessionManager.getSessionFile() === request.file &&
        modelKey(liveContext?.model) === request.model &&
        leafOf(ctx) === request.expectedLeaf;
      if (!current && pending === request) pending = undefined;
      return current;
    };
    // Status can do I/O. Never await it from a provider or lifecycle handler.
    Promise.resolve().then(() => ctx.memory.status()).then(
      (status) => {
        if (!isCurrent()) return;
        const backend = typeof status?.backend === "string" ? status.backend : null;
        memory = {
          status: backend === "off" ? "off" : status?.active === true ? "ready" : "unavailable",
          backend,
          blocks: [],
          note: typeof status?.message === "string" ? status.message.slice(0, 4096) : null,
        };
        pending = undefined;
        if (latest) publish(ctx, { ...latest, details: { ...latest.details, memory } });
      },
      () => {
        if (!isCurrent()) return;
        pending = undefined;
        memory = { status: "unavailable", backend: null, blocks: [], note: "Memory status could not be read." };
        if (latest) publish(ctx, { ...latest, details: { ...latest.details, memory } });
      },
    );
  };
  const inside = (root, file) => {
    const relative = path.relative(root, file);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative))
    );
  };
  // getCommands exposes the selected skill's path, not its loader's provider.
  // Record exactly which known root matched; never infer that OMP shipped it.
  const originOf = (command, cwd) => {
    const file = path.resolve(command.path);
    const home = path.resolve(os.homedir());
    const project = path.resolve(cwd);
    if (command.location === "project")
      return { kind: "project", label: "Project", basis: "native-project" };
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    if (agentDir && path.isAbsolute(agentDir) && inside(agentDir, file))
      return {
        kind: "omp",
        label: "OMP / profile",
        root: agentDir,
        basis: "agent-dir",
      };
    const roots = [
      [".agent/skills", "shared", ".agent"],
      [".agents/skills", "shared", ".agents"],
      [process.env.PI_CONFIG_DIR || ".omp", "omp", "OMP / profile"],
      [".claude", "other", "Claude"],
      [".codex", "other", "Codex"],
      [".config/opencode", "other", "OpenCode"],
      [".opencode", "other", "OpenCode"],
    ];
    for (const [dir, kind, label] of roots) {
      const root = path.join(home, dir);
      if (
        inside(root, file) &&
        (command.location === "user" || !inside(root, project))
      )
        return { kind, label, root, basis: "user-root" };
    }
    if (command.location !== "user") {
      for (let dir = project; dir !== home; dir = path.dirname(dir)) {
        for (const source of [
          ".agent",
          ".agents",
          ".omp",
          ".claude",
          ".codex",
          ".github",
          ".opencode",
        ]) {
          const root = path.join(dir, source);
          if (inside(root, file))
            return {
              kind: "project",
              label: source,
              root,
              basis: "project-root",
            };
        }
        if (dir === path.dirname(dir)) break;
      }
      if (inside(project, file))
        return {
          kind: "project",
          label: "Project",
          root: project,
          basis: "project-path",
        };
    }
    return { kind: "other", label: "Other", basis: "unclassified" };
  };
  const record = (ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    const model = modelOf(ctx.model);
    if (latest && (file !== previousFile || JSON.stringify(model) !== JSON.stringify(latest.details.model))) {
      generation++;
      pending = undefined;
      memory = { status: "unavailable", backend: null, blocks: [], note: "Memory status is not available." };
    }
    const prompt = ctx.getSystemPrompt();
    if (!Array.isArray(prompt)) return;
    let skillBytes = 0, skillsTruncated = false;
    const skills = [];
    for (const command of api.getCommands?.() || []) {
      if (command.source !== "skill" || typeof command.name !== "string" ||
          !command.name.startsWith("skill:") || typeof command.path !== "string" ||
          !path.isAbsolute(command.path)) continue;
      const origin = originOf(command, ctx.cwd || process.cwd());
      const skill = {
        name: command.name.slice("skill:".length),
        path: command.path,
        scope: origin.kind === "project" ? "repo" : "global",
        origin,
        ...(typeof command.description === "string" && command.description
          ? { description: command.description.slice(0, 8192) }
          : {}),
      };
      const size = JSON.stringify(skill).length;
      if (skills.length >= 4096 || skillBytes + size > LIMIT) {
        skillsTruncated = true;
        continue;
      }
      if (command.description?.length > 8192) skillsTruncated = true;
      skillBytes += size;
      skills.push(skill);
    }
    let left = LIMIT,
      truncated = false;
    const blocks = [];
    for (const text of prompt) {
      if (typeof text !== "string") continue;
      if (left <= 0) {
        truncated = true;
        break;
      }
      let block = text.slice(0, left);
      if (block.length < text.length) {
        truncated = true;
        if (/[\uD800-\uDBFF]$/.test(block)) block = block.slice(0, -1);
      }
      blocks.push(block);
      left -= block.length;
    }
    const inventory = toolInventory();
    const data = {
      version: 1,
      epoch: process.env.OMP_DESKTOP_CONTEXT_EPOCH,
      agent: ctx.agent,
      blocks,
      truncated,
      skills,
      detailsTruncated: inventory.truncated || skillsTruncated,
      details: {
        model,
        usage: usageOf(ctx.getContextUsage?.()),
        breakdown,
        tools: inventory.tools,
        toolsAvailable: inventory.available,
        memory,
        retainedSkills: null,
        retainedCallIds: null,
      },
    };
    latest = data;
    publish(ctx, data);
  };
  for (const event of [
    "session_start",
    "session_switch",
    "session_branch",
    "session_tree",
    "session_compact",
    "agent_start",
    "turn_end",
    "agent_end",
    "before_provider_request",
  ])
    api.on(event, (_event, ctx) => {
      const reset = ["session_start", "session_switch", "session_branch", "session_tree", "session_compact"].includes(event);
      if (event !== "before_provider_request") liveContext = ctx;
      if (reset) {
        generation++;
        pending = undefined;
        previousKey = undefined;
        memory = { status: "unavailable", backend: null, blocks: [], note: "Memory status is not available." };
      }
      record(ctx);
      if (event !== "before_provider_request" && (reset || event === "turn_end" || event === "agent_end" || !pending)) {
        refreshMemory(ctx);
      }
    });
}
