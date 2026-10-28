/* Catalog entries are available skills, not evidence that an agent used them. */
const { Icon: _AC_Icon, useModalLayer: _AC_useModalLayer } = window;

function _AC_Entries({ label, entries, agent, kind, onPreview }) {
  return (
    <details className="agent-context-group">
      <summary className="agent-context-group-head">
        <span>{label}</span>
        <span className="agent-context-group-count mono">{entries.length}</span>
      </summary>
      {entries.length === 0 ? (
        <p className="agent-context-empty">None</p>
      ) : (
        <ul className="agent-context-list">
          {entries.map((entry, i) => (
            <li key={entry.id ?? entry.path ?? i}>
              <button
                type="button"
                className="agent-context-entry"
                onClick={() => onPreview({ agentId: agent.id, entry, kind })}
                title={entry.name}
              >
                {entry.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function _AC_AgentBody({ agent, onSelectAgent, onPreview }) {
  return (
    <div className="agent-context-agent-body">
      {agent.id !== "main" && onSelectAgent && (
        <button
          type="button"
          className="agent-context-inspect"
          onClick={() => onSelectAgent(agent.id)}
        >
          open inspector
        </button>
      )}
      {agent.note && (
        <p className="agent-context-note" title={agent.note}>
          {agent.note}
        </p>
      )}
      <_AC_Entries
        label="Repo skills"
        entries={agent.repoSkills || []}
        agent={agent}
        kind="skill"
        onPreview={onPreview}
      />
      <_AC_Entries
        label="Global skills"
        entries={agent.globalSkills || []}
        agent={agent}
        kind="skill"
        onPreview={onPreview}
      />
      <_AC_Entries
        label="Loaded instructions"
        entries={agent.instructions || []}
        agent={agent}
        kind="instruction"
        onPreview={onPreview}
      />
      <_AC_Entries
        label="Used this session"
        entries={agent.skills || []}
        agent={agent}
        kind="skill"
        onPreview={onPreview}
      />
    </div>
  );
}

function _AC_Preview({ target, readSkill, onClose }) {
  const scrimRef = React.useRef(null);
  const downOnScrim = React.useRef(false);
  const [result, setResult] = React.useState(null);
  _AC_useModalLayer(scrimRef);

  React.useEffect(() => {
    let live = true;
    if (target.kind === "skill") {
      Promise.resolve()
        .then(() => {
          if (typeof readSkill !== "function")
            throw new Error("Skill preview is unavailable.");
          return readSkill(target.agentId, target.entry.name);
        })
        .then((res) => {
          if (live)
            setResult({
              target,
              res: res ?? { ok: false, error: "No preview was returned." },
            });
        })
        .catch((error) => {
          if (live)
            setResult({
              target,
              res: { ok: false, error: error?.message || String(error) },
            });
        });
    }
    return () => {
      live = false;
    };
  }, [target, readSkill]);

  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const res =
    target.kind === "instruction"
      ? typeof target.entry.text === "string"
        ? { ok: true, value: target.entry }
        : { ok: false, error: "Instruction content is unavailable." }
      : result?.target === target
        ? result.res
        : null;
  const value = res?.ok ? res.value : null;
  const error =
    res &&
    (!res.ok
      ? res.error || "Preview is unavailable."
      : typeof value?.text !== "string"
        ? "Preview content is unavailable."
        : null);
  const errorText =
    error &&
    (typeof error === "string" ? error : error.message || String(error));
  const path = value?.path || target.entry.path;

  return ReactDOM.createPortal(
    <div
      ref={scrimRef}
      className="fp-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${target.entry.name}`}
      tabIndex={-1}
      onMouseDown={(event) => {
        downOnScrim.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (downOnScrim.current && event.target === event.currentTarget)
          onClose();
        downOnScrim.current = false;
      }}
    >
      <div className="fp-panel agent-context-preview">
        <div className="fp-head">
          <_AC_Icon name="file" size={13} color="var(--cyan)" />
          <span
            className="agent-context-preview-title"
            title={path || target.entry.name}
          >
            {target.entry.name}
          </span>
          {value?.truncated && (
            <span className="chip warn mono">truncated</span>
          )}
          <div className="fp-spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
        {path && <div className="agent-context-preview-path mono">{path}</div>}
        <div className="fp-body" tabIndex={0} aria-live="polite">
          {!res ? (
            <div className="fp-state">Loading…</div>
          ) : errorText ? (
            <div className="fp-state">
              <div>
                <div className="fp-state-title">Can't preview this content</div>
                <div className="fp-state-sub">{errorText}</div>
              </div>
            </div>
          ) : (
            <pre className="agent-context-preview-text">{value.text}</pre>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function AgentContextCard({ context, onSelectAgent, readSkill }) {
  const agents = context?.agents || [];
  const [preview, setPreview] = React.useState(null);
  const closePreview = React.useCallback(() => setPreview(null), []);
  return (
    <>
      <details className="rail-card glass agent-context" open>
        <summary className="rail-card-head agent-context-head">
          <_AC_Icon name="context" size={11} color="var(--lilac)" />
          <span className="mono">agent context</span>
          <span className="agent-context-count mono">
            {agents.length} {agents.length === 1 ? "agent" : "agents"}
          </span>
        </summary>
        <div className="agent-context-body">
          {agents.length === 0 ? (
            <p className="agent-context-note">Context metadata unavailable.</p>
          ) : (
            agents.map((agent) =>
              agent.id === "main" ? (
                <div key={agent.id} className="agent-context-main">
                  {agents.length > 1 && (
                    <div className="agent-context-main-label">
                      main · {agent.label}
                    </div>
                  )}
                  <_AC_AgentBody
                    agent={agent}
                    onSelectAgent={onSelectAgent}
                    onPreview={setPreview}
                  />
                </div>
              ) : (
                <details className="agent-context-agent" key={agent.id}>
                  <summary className="agent-context-agent-head">
                    <span className="agent-context-agent-label">
                      subagent · {agent.label}
                    </span>
                    {agent.status && (
                      <span className="agent-context-status mono">
                        {" "}
                        · {agent.status}
                      </span>
                    )}
                  </summary>
                  <_AC_AgentBody
                    agent={agent}
                    onSelectAgent={onSelectAgent}
                    onPreview={setPreview}
                  />
                </details>
              ),
            )
          )}
        </div>
      </details>
      {preview && (
        <_AC_Preview
          target={preview}
          readSkill={readSkill}
          onClose={closePreview}
        />
      )}
    </>
  );
}

Object.assign(window, { AgentContextCard });
