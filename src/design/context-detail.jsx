/* Read-only detail pane. Skill content is fetched only through the scoped bridge. */
function ContextDetail({
  item,
  agentId,
  readSkill,
  messages,
  onJumpToCall,
  onClose,
  onBack,
}) {
  const [previewState, setPreviewState] = React.useState(null);
  const skillName = item?.kind === "skill" ? item.entry.name : null;
  const preview =
    previewState?.agentId === agentId && previewState?.skillName === skillName
      ? previewState.result
      : null;
  React.useEffect(() => {
    if (!skillName) return;
    let live = true;
    setPreviewState(null);
    Promise.resolve()
      .then(() => {
        if (typeof readSkill !== "function")
          throw new Error("Skill preview is unavailable.");
        return readSkill(agentId, skillName);
      })
      .then((result) => {
        if (live)
          setPreviewState({
            agentId,
            skillName,
            result: result || { ok: false, error: "No preview was returned." },
          });
      })
      .catch((error) => {
        if (live)
          setPreviewState({
            agentId,
            skillName,
            result: { ok: false, error: error?.message || String(error) },
          });
      });
    return () => {
      live = false;
    };
  }, [agentId, skillName, readSkill]);

  if (!item)
    return (
      <div className="ci-detail-empty">
        Select an item to inspect its observed content.
      </div>
    );
  const { entry, kind } = item;
  const origin = entry.origin;
  const hasCall =
    kind === "call" &&
    typeof onJumpToCall === "function" &&
    (messages || []).some(
      (message) => message.kind === "tool" && message._toolCallId === entry.id,
    );
  const previewError =
    preview &&
    (!preview.ok
      ? preview.error || "Preview is unavailable."
      : typeof preview.value?.text !== "string"
        ? "Preview content is unavailable."
        : null);
  return (
    <div className="ci-detail-content">
      <button type="button" className="ci-back" onClick={onBack}>
        ← Back to list
      </button>
      <div className="ci-detail-heading">
        <div>
          <span className="ci-eyebrow">{item.typeLabel}</span>
          <h2>{entry.name}</h2>
        </div>
        {item.badge && <span className="ci-badge">{item.badge}</span>}
      </div>
      {entry.description && (
        <p className="ci-description">{entry.description}</p>
      )}
      {kind === "skill" && (
        <>
          {origin && (
            <div className="ci-provenance">
              <strong>{origin.badge || origin.label}</strong>
              {origin.label && origin.label !== origin.badge && (
                <> · {origin.label}</>
              )}
              {origin.explanation && <p>{origin.explanation}</p>}
              {origin.root && (
                <div className="mono">Source root: {origin.root}</div>
              )}
            </div>
          )}
          {entry.path && (
            <div className="ci-meta mono">Source: {entry.path}</div>
          )}
          <div className="ci-meta">
            {item.used
              ? "Used this session"
              : "Available in catalog; use not observed"}{" "}
            ·{" "}
            {item.retained === null
              ? "Current retention unknown"
              : item.retained
                ? "Retained in current context"
                : "Not retained in current context"}
          </div>
          <div aria-live="polite">
            {!preview ? (
              <p className="ci-state">Loading skill…</p>
            ) : previewError ? (
              <p className="ci-state">
                Can't preview this skill:{" "}
                {typeof previewError === "string"
                  ? previewError
                  : previewError.message || String(previewError)}
              </p>
            ) : (
              <>
                {preview.value.truncated && (
                  <div className="ci-meta">Preview truncated</div>
                )}
                {preview.value.path && preview.value.path !== entry.path && (
                  <div className="ci-meta mono">
                    Preview file: {preview.value.path}
                  </div>
                )}
                <pre className="ci-text">{preview.value.text}</pre>
              </>
            )}
          </div>
        </>
      )}
      {(kind === "instruction" || kind === "prompt" || kind === "memory") && (
        <>
          {entry.path && (
            <div className="ci-meta mono">Source: {entry.path}</div>
          )}
          {typeof entry.text === "string" ? (
            <pre className="ci-text">{entry.text}</pre>
          ) : (
            <p className="ci-state">Content is unavailable.</p>
          )}
        </>
      )}
      {kind === "tool" && (
        <>
          <dl className="ci-facts">
            <dt>Source</dt>
            <dd>{entry.source || "Unknown"}</dd>
            <dt>Server</dt>
            <dd>{entry.server || "Not recorded"}</dd>
            <dt>Tool</dt>
            <dd>{entry.tool || "Not recorded"}</dd>
            <dt>Status</dt>
            <dd>{entry.active ? "Active" : "Inactive"}</dd>
          </dl>
          <h3>Parameters</h3>
          {entry.parameters && typeof entry.parameters === "object" ? (
            <pre className="ci-text">
              {JSON.stringify(entry.parameters, null, 2)}
            </pre>
          ) : (
            <p className="ci-state">Parameters unavailable.</p>
          )}
        </>
      )}
      {kind === "call" && (
        <>
          <dl className="ci-facts">
            <dt>Status</dt>
            <dd>{entry.status || "Unknown"}</dd>
            <dt>Server</dt>
            <dd>{entry.server || "Not recorded"}</dd>
            <dt>Tool</dt>
            <dd>{entry.tool || "Not recorded"}</dd>
            <dt>Current context</dt>
            <dd>
              {entry.retained == null
                ? "Retention unknown"
                : entry.retained
                  ? "Retained"
                  : "Not retained"}
            </dd>
          </dl>
          <p className="ci-description">
            Call metadata from this agent's active branch; this is not a
            transcript.
          </p>
          <button
            type="button"
            className="btn"
            disabled={!hasCall}
            title={
              !hasCall
                ? "This call is not in the current chat window."
                : undefined
            }
            onClick={() => {
              onClose();
              onJumpToCall(entry.id);
            }}
          >
            Jump to chat call
          </button>
        </>
      )}
    </div>
  );
}
window.ContextDetail = ContextDetail;
