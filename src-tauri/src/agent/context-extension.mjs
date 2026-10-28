// Loaded by native omp, including its task children. Custom entries are local
// extension state: never model messages, commands, or extra provider requests.
export default function desktopContext(api) {
  const LIMIT = 512 * 1024;
  let previousFile, previousPrompt, previousKey;
  const record = (ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    const prompt = ctx.getSystemPrompt();
    if (!Array.isArray(prompt)) return;
    if (
      file === previousFile &&
      previousPrompt?.length === prompt.length &&
      prompt.every((block, i) => block === previousPrompt[i])
    )
      return;
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
    const data = { version: 1, agent: ctx.agent, blocks, truncated };
    const key = JSON.stringify(data);
    if (file !== previousFile || key !== previousKey) {
      api.appendEntry("omp-desktop:agent-context", data);
      previousKey = key;
    }
    previousFile = file;
    previousPrompt = prompt.slice();
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
        previousPrompt = undefined;
        previousKey = undefined;
      }
      record(ctx);
    });
}
