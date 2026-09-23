/* subagents/subagent-rail-card.jsx — ambient summary of this session's
   subagents for the right rail (AmbientRail, between radar and minimap).
   Live agents first, then the most recent finished ones; a click opens the
   manager pane on that agent. */

const { Icon: _SAR_Icon, OMP_SUBAGENTS: _SAR, SaDot: _SAR_Dot, SaToolChip: _SAR_ToolChip,
  SaElapsed: _SAR_Elapsed, saHueStyle: _SAR_hue, useSaNow: _SAR_useNow } = window;

const SA_RAIL_MAX_ROWS = 5;

function SubagentRailCard({ agents, paneOpen, onOpen, onTogglePane }) {
  const t = _SAR.totals(agents);
  const now = _SAR_useNow(t.live > 0, 500);
  // Live first (spawn order), then finished most-recent-first.
  const live = agents.filter(a => _SAR.isLive(a.status));
  const done = agents.filter(a => !_SAR.isLive(a.status)).sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0));
  const rows = [...live, ...done].slice(0, SA_RAIL_MAX_ROWS);
  const hidden = agents.length - rows.length;

  return (
    <div className="rail-card glass">
      <div className="rail-card-head">
        <_SAR_Icon name="agent" size={11} color="var(--cyan)" />
        <span className="mono" style={{ color: "var(--fg-2)" }}>subagents</span>
        {t.live > 0 ? (
          <span className="chip accent mono" style={{ marginLeft: "auto" }}><span className="dot live" /> {t.live} live</span>
        ) : (
          <span className="chip muted mono" style={{ marginLeft: "auto" }}>{t.total ? `${t.total} ran` : "idle"}</span>
        )}
      </div>

      {t.total === 0 ? (
        <div className="sa-empty">Agents spawned by <span className="mono">task</span> calls show up here, live.</div>
      ) : (
        <>
          <div className="sa-rail-stats mono">
            <span><b>{window.formatTokens(t.tokens)}</b> tok</span>
            <span><b>{_SAR.fmtCost(t.cost)}</b></span>
            <span><b>{t.tools}</b> tools</span>
            {t.failed > 0 && <span style={{ color: "var(--rose)" }}>{t.failed} failed</span>}
          </div>
          <div className="sa-rail-list">
            {rows.map(a => (
              <button key={a.id} className="sa-rail-row" style={_SAR_hue(a)} onClick={() => onOpen(a.id)}
                title={a.description ?? a.task ?? a.id}>
                <_SAR_Dot status={a.status} />
                <span className="sa-name">{a.id}</span>
                <_SAR_Elapsed agent={a} now={now} />
                <span className="sa-rail-now">
                  {a.status === "running" && a.progress?.currentTool ? (
                    <>
                      <_SAR_ToolChip tool={a.progress.currentTool} running />
                      <span>{a.progress.lastIntent ?? a.progress.currentToolArgs}</span>
                    </>
                  ) : (
                    <span>{a.description ?? a.task ?? a.agent}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
          {hidden > 0 && <div className="sa-rail-more mono">+{hidden} more</div>}
        </>
      )}

      <button className="btn ghost outlined sa-rail-open" onClick={onTogglePane}>
        <_SAR_Icon name="split" size={11} /> {paneOpen ? "hide manager" : "open manager"}
      </button>
    </div>
  );
}

Object.assign(window, { SubagentRailCard });
