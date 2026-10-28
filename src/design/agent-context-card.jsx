/* Observed context only: the skill catalog is not evidence of use. */
const { Icon: _AC_Icon } = window;

function _AC_Entries({ label, kind, entries, onJump }) {
  return (
    <div className={`agent-context-group ${kind}`}>
      <div className="agent-context-group-head mono">
        <span>{label}</span>
        <span>{entries.length}</span>
      </div>
      {entries.length === 0 ? (
        <div className="agent-context-empty">
          {kind === "skill" ? "No skill loads observed" : "None observed"}
        </div>
      ) : (
        <ul className="agent-context-list">
          {entries.map((entry, i) => (
            <li className="agent-context-entry" key={entry.id ?? i}>
              <div className="agent-context-entry-main">
                <span className="agent-context-entry-name">{entry.name}</span>
                {entry.messageId != null && onJump && (
                  <button
                    type="button"
                    className="agent-context-jump"
                    onClick={() => onJump(entry.messageId)}
                    aria-label={`Jump to ${label.toLowerCase()} event: ${entry.name}`}
                  >
                    view event
                  </button>
                )}
              </div>
              {entry.path && (
                <div className="agent-context-source mono">{entry.path}</div>
              )}
              {entry.source && entry.source !== entry.path && (
                <div className="agent-context-source mono">{entry.source}</div>
              )}
              {entry.detail && (
                <div className="agent-context-detail">
                  {entry.detail.length > 180
                    ? `${entry.detail.slice(0, 180)}…`
                    : entry.detail}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AgentContextCard({ context, onSelectAgent, onJump }) {
  const agents = context?.agents || [];
  return (
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
          agents.map((agent) => (
            <details
              className="agent-context-agent"
              key={agent.id}
              open={agent.id === "main" ? true : undefined}
            >
              <summary className="agent-context-agent-head">
                <span className="agent-context-agent-label">
                  {agent.id === "main" ? "main" : "subagent"} · {agent.label}
                </span>
                {agent.status && (
                  <span className="agent-context-status mono">
                    {" · "}
                    {agent.status}
                  </span>
                )}
              </summary>
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
                  <p className="agent-context-note">{agent.note}</p>
                )}
                <_AC_Entries
                  label="Harness"
                  kind="harness"
                  entries={agent.harness || []}
                  onJump={onJump}
                />
                <_AC_Entries
                  label="Instructions"
                  kind="instruction"
                  entries={agent.instructions || []}
                  onJump={onJump}
                />
                <_AC_Entries
                  label="Used skills"
                  kind="skill"
                  entries={agent.skills || []}
                  onJump={onJump}
                />
              </div>
            </details>
          ))
        )}
      </div>
    </details>
  );
}

Object.assign(window, { AgentContextCard });
