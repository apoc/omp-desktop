import os from "node:os";
import path from "node:path";

// Loaded by native omp, including its task children. Custom entries are local
// extension state: never model messages, commands, or extra provider requests.
export default function desktopContext(api) {
  const LIMIT = 512 * 1024;
  let previousFile, previousKey;
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
    const prompt = ctx.getSystemPrompt();
    if (!Array.isArray(prompt)) return;
    const skills = (api.getCommands?.() || [])
      .filter(
        (command) =>
          command.source === "skill" &&
          typeof command.name === "string" &&
          command.name.startsWith("skill:") &&
          typeof command.path === "string" &&
          path.isAbsolute(command.path),
      )
      .map((command) => {
        const origin = originOf(command, ctx.cwd || process.cwd());
        return {
          name: command.name.slice("skill:".length),
          path: command.path,
          scope: origin.kind === "project" ? "repo" : "global",
          origin,
          ...(typeof command.description === "string" && command.description
            ? { description: command.description }
            : {}),
        };
      });
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
    const data = {
      version: 1,
      epoch: process.env.OMP_DESKTOP_CONTEXT_EPOCH,
      agent: ctx.agent,
      blocks,
      truncated,
      skills,
    };
    const key = JSON.stringify(data);
    if (file !== previousFile || key !== previousKey) {
      api.appendEntry("omp-desktop:agent-context", data);
      previousKey = key;
    }
    previousFile = file;
  };
  for (const event of [
    "session_start",
    "session_switch",
    "session_tree",
    "agent_start",
    "before_provider_request",
  ])
    api.on(event, (_event, ctx) => {
      if (["session_start", "session_switch", "session_tree"].includes(event)) {
        previousKey = undefined;
      }
      record(ctx);
    });
}
