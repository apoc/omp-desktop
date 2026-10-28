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
  const scopeOf = (command, cwd) => {
    if (command.location === "project") return "repo";
    if (command.location === "user") return "global";
    const file = path.resolve(command.path);
    const home = path.resolve(os.homedir());
    const project = path.resolve(cwd);
    // Home-level sources are user skills even when the project is under home.
    for (const dir of [
      ".agent",
      ".agents",
      ".omp",
      ".claude",
      ".codex",
      ".config",
    ]) {
      if (
        inside(path.join(home, dir), file) &&
        !inside(path.join(home, dir), project)
      )
        return "global";
    }
    if (inside(project, file)) return "repo";
    // Walk-up discovery includes .agent/.agents and other provider roots in
    // project ancestors; do not mistake an unrelated sibling for a repo skill.
    for (
      let dir = path.dirname(project);
      dir !== path.dirname(dir);
      dir = path.dirname(dir)
    ) {
      if (dir === home) break;
      for (const source of [
        ".agent",
        ".agents",
        ".omp",
        ".claude",
        ".codex",
        ".github",
        ".opencode",
      ]) {
        if (inside(path.join(dir, source), file)) return "repo";
      }
    }
    return "global";
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
      .map((command) => ({
        name: command.name.slice("skill:".length),
        path: command.path,
        scope: scopeOf(command, ctx.cwd || process.cwd()),
        ...(typeof command.description === "string" && command.description
          ? { description: command.description }
          : {}),
      }));
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
