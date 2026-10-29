// Read-only native job observer. No prompts, tool execution, or job control.
const PREFIX = "OMP_DESKTOP_BACKGROUND_TASKS:";
const LIMIT = 128;
const string = (value, limit = 256) =>
  typeof value === "string" ? value.slice(0, limit) : null;
const time = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
const project = (job) => ({
  id: string(job.id),
  type: string(job.type),
  status: string(job.status),
  label: string(job.label),
  command: string(job.command, 1024),
  startTime: time(job.startTime),
  endTime: time(job.endTime),
  agentId: string(job.agentId),
  ownerId: string(job.ownerId),
});

export default function desktopBackgroundTasks(api) {
  let previous;
  function publish(ctx) {
    let snapshot;
    let reason = "Native job snapshots unavailable; showing observed activity.";
    try {
      snapshot = ctx.getAsyncJobSnapshot?.();
    } catch {
      reason = "Native job snapshot failed; showing observed activity.";
    }
    const running = Array.isArray(snapshot?.running) ? snapshot.running : [];
    const supported =
      !!snapshot &&
      Array.isArray(snapshot.running) &&
      Array.isArray(snapshot.recent);
    const data = {
      epoch: process.env.OMP_DESKTOP_CONTEXT_EPOCH || "",
      sessionId: ctx.sessionManager.getSessionId(),
      file: ctx.sessionManager.getSessionFile() ?? null,
      supported,
      complete: supported && running.length <= LIMIT,
      running: running.slice(0, LIMIT).map(project),
      reason: supported ? null : reason,
      recent: (Array.isArray(snapshot?.recent) ? snapshot.recent : [])
        .slice(0, 30)
        .map(project),
    };
    const serialized = JSON.stringify(data);
    if (serialized !== previous) {
      previous = serialized;
      ctx.ui.notify(PREFIX + serialized, "info");
    }
  }
  for (const event of [
    "session_start",
    "session_switch",
    "session_branch",
    "session_tree",
    "agent_start",
    "agent_end",
    "turn_end",
    "tool_result",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "message_end",
  ])
    api.on(event, (_event, ctx) => publish(ctx));
}
