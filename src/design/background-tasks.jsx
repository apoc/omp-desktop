/* Read-only native work observer. Opening or hiding this card never affects a job. */
function BackgroundTasksCard({
  state,
  onOpenTool,
  onOpenSubagent,
  canOpenTool,
  canOpenSubagent,
  awaitingAsyncWork = false,
}) {
  const model = window.OMP_BACKGROUND_TASKS.view(
    state || window.OMP_BACKGROUND_TASKS.empty(),
  );
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!model.active.length) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [model.active.length]);
  const labels = {
    running: "running",
    pending: "queued",
    completed: "completed",
    failed: "failed",
    cancelled: "cancelled",
    aborted: "aborted",
    unknown: "outcome unknown",
  };
  const row = (item) => {
    const elapsed =
      item.status === "running" || item.status === "pending"
        ? Math.max(0, now - item.startedAt)
        : (item.durationMs ??
          (item.status === "unknown" || item.endedAt == null
            ? null
            : Math.max(0, item.endedAt - item.startedAt)));
    const kind = item.agentId
      ? item.agentType
        ? `${item.agentType} · subagent`
        : "subagent"
      : item.type === "wait"
        ? "wait"
        : item.background
          ? `${item.type} · background`
          : `${item.type} · foreground`;
    const name = item.agentId || item.label || item.type;
    return (
      <details className="bt-task" key={item.key}>
        <summary className="bt-summary">
          <span
            className={`bt-indicator bt-${item.status}`}
            aria-hidden="true"
          />
          <span className="bt-main">
            <span className="bt-name" title={name}>
              {name}
            </span>
            <span className="bt-meta mono">
              {kind} · {labels[item.status] || "unknown"}
              {item.waitedFor ? " · agent waiting" : ""}
            </span>
          </span>
          <span className="bt-time mono">
            {window.OMP_SUBAGENTS.fmtDuration(elapsed)}
          </span>
        </summary>
        <div className="bt-detail">
          {item.agentId && item.label && item.label !== item.type && (
            <div className="bt-description selectable">{item.label}</div>
          )}
          {item.detail && (
            <div className="bt-description selectable">{item.detail}</div>
          )}
          {item.output && (
            <pre className="bt-output selectable">{item.output}</pre>
          )}
          <div className="bt-actions">
            {item.agentId &&
              onOpenSubagent &&
              (!canOpenSubagent || canOpenSubagent(item.agentId, item)) && (
                <button
                  className="btn ghost outlined"
                  onClick={() => onOpenSubagent(item.agentId)}
                >
                  Open subagent
                </button>
              )}
            {item.toolCallId &&
              onOpenTool &&
              (!canOpenTool || canOpenTool(item.toolCallId)) && (
                <button
                  className="btn ghost outlined"
                  onClick={() => onOpenTool(item.toolCallId)}
                >
                  Open tool call
                </button>
              )}
          </div>
        </div>
      </details>
    );
  };
  return (
    <section className="rail-card glass bt-card" aria-label="Background tasks">
      <div className="rail-card-head">
        <window.Icon name="agent" size={11} color="var(--cyan)" />
        <span className="mono bt-title">background tasks</span>
        <span
          className={`chip mono ${model.active.length || model.pendingUnknown || awaitingAsyncWork ? "accent" : "muted"} bt-count`}
        >
          {model.active.length
            ? `${model.active.length} active`
            : model.pendingUnknown || awaitingAsyncWork
              ? "waiting"
              : "idle"}
        </span>
      </div>
      {model.waiting && (
        <div className="bt-wait mono">
          Main agent is waiting
          {model.waiting.jobIds.length
            ? " on listed jobs or another result"
            : " for a result or reply"}
          .
        </div>
      )}
      {!model.waiting && awaitingAsyncWork && (
        <div className="bt-wait mono">
          Main agent yielded and is waiting for background work or delivery.
        </div>
      )}
      {model.active.length > 0 && (
        <div className="bt-list">{model.active.map(row)}</div>
      )}
      {model.pendingUnknown && (
        <div className="bt-note">
          Additional background work or delivery is pending; details
          unavailable.
        </div>
      )}
      {model.snapshotNote && (
        <div className="bt-note">{model.snapshotNote}</div>
      )}
      {!model.active.length &&
        !model.recent.length &&
        !model.pendingUnknown && (
          <div className="bt-note">No observed tasks in this conversation.</div>
        )}
      {model.recent.length > 0 && (
        <details className="bt-history">
          <summary className="mono">
            Recent activity <span>{model.recent.length}</span>
          </summary>
          <div className="bt-list">{model.recent.map(row)}</div>
        </details>
      )}
    </section>
  );
}
window.BackgroundTasksCard = BackgroundTasksCard;
