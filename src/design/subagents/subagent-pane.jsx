/* subagents/subagent-pane.jsx — the manager pane. Occupies the `.split`
   column (stage.css `.window.is-split`). List view: totals, a swimlane
   timeline (adaptive 20s–2m window), status filters and agents grouped by
   the task call that spawned them (nested agents indented under their
   parent). Selecting an agent drills into SubagentInspector in the same
   column. */

const { Icon: _SAP_Icon, OMP_SUBAGENTS: _SAP, SaDot: _SAP_Dot, SaToolChip: _SAP_ToolChip,
  SaElapsed: _SAP_Elapsed, SaContextTube: _SAP_Tube, saHueStyle: _SAP_hue, saLeafName: _SAP_leaf,
  saToolMeta: _SAP_toolMeta, useSaNow: _SAP_useNow, SubagentInspector: _SAP_Inspector } = window;

// Lane window grows with the session's first spawn (so early runs are not
// squeezed into the right edge of a fixed minute), clamped to [20s, 2m].
const SA_LANE_MIN_MS = 20_000;
const SA_LANE_MAX_MS = 120_000;
const SA_LANE_MAX = 8;
const SA_FILTERS = [["all", "all"], ["live", "live"], ["done", "done"], ["failed", "failed"]];

function SaSwimlanes({ agents, now, onSelect }) {
  if (agents.length === 0) return null;
  const earliest = Math.min(...agents.map(a => a.startedAt));
  const span = Math.max(SA_LANE_MIN_MS, Math.min(SA_LANE_MAX_MS, (now - earliest) * 1.08));
  const from = now - span;
  const pos = t => `${Math.max(0, Math.min(100, ((t - from) / span) * 100))}%`;
  // Stable spawn order: lanes must not reshuffle on every progress tick.
  const lanes = agents
    .filter(a => (a.endedAt ?? now) >= from)
    .sort((x, y) => x.startedAt - y.startedAt)
    .slice(-SA_LANE_MAX);
  if (lanes.length === 0) return null;
  return (
    <div className="card sa-lanes">
      {lanes.map(a => {
        const end = a.endedAt ?? now;
        const p = a.progress;
        const running = a.status === "running" && p?.currentTool && p.currentToolStartMs;
        return (
          <div key={a.id} className="sa-lane" style={_SAP_hue(a)} onClick={() => onSelect(a.id)} title={a.id}>
            <span className="sa-lane-label">{_SAP_leaf(a.id)}</span>
            <div className="sa-lane-track">
              <span className="sa-lane-span" style={{ left: pos(a.startedAt), right: `calc(100% - ${pos(end)})` }} />
              {(p?.recentTools ?? []).filter(r => r.endMs >= from).map((r, i) => {
                const c = _SAP_toolMeta(r.tool).color;
                return <span key={i} className="sa-lane-tick" style={{ left: pos(r.endMs), background: c, color: c }} title={`${r.tool} ${r.args}`} />;
              })}
              {running && (
                <span className="sa-lane-run" style={{
                  left: pos(p.currentToolStartMs), right: `calc(100% - ${pos(now)})`,
                  background: _SAP_toolMeta(p.currentTool).color,
                }} />
              )}
            </div>
          </div>
        );
      })}
      <div className="sa-lane-axis">
        <span>-{Math.round(span / 1000)}s</span><span>-{Math.round(span / 2000)}s</span><span>now</span>
      </div>
    </div>
  );
}

function saFailureLine(a) {
  const err = [...a.stream].reverse().find(l => l.kind === "error");
  if (err) return `${err.tool} failed`;
  return a.progress?.recentOutput?.[0] ?? ""; // omp sends recentOutput newest-first
}

function SaAgentRow({ agent: a, depth, now, onSelect }) {
  const p = a.progress;
  const failure = a.status === "failed" ? saFailureLine(a) : "";
  return (
    <button className={`sa-row ${a.status}`} data-depth={depth}
      style={{ ..._SAP_hue(a), marginLeft: depth * 14, width: `calc(100% - ${depth * 14}px)` }}
      onClick={() => onSelect(a.id)}>
      <div className="sa-row-top">
        <_SAP_Dot status={a.status} />
        <span className="sa-name">{_SAP_leaf(a.id)}</span>
        {a.agent && <span className="chip muted mono sa-kind">{a.agent}</span>}
        <div style={{ flex: 1 }} />
        <_SAP_Elapsed agent={a} now={now} />
      </div>
      {(a.description || a.task) && <div className="sa-row-desc">{a.description ?? a.task}</div>}
      {a.status === "running" && p?.currentTool && (
        <div className="sa-row-now">
          <_SAP_ToolChip tool={p.currentTool} running />
          {p.lastIntent
            ? <span className="sa-intent shimmer-text">{p.lastIntent}</span>
            : <span className="sa-args">{p.currentToolArgs}</span>}
        </div>
      )}
      {failure && <div className="sa-row-err" title={failure}>{failure}</div>}
      <div className="sa-row-foot">
        <span>{p?.toolCount ?? 0} tools</span>
        <span>{window.formatTokens(p?.tokens ?? 0)} tok</span>
        <span>{_SAP.fmtCost(p?.cost ?? 0)}</span>
        <_SAP_Tube progress={p} />
      </div>
    </button>
  );
}

function SubagentPane({
  state, filter, onFilter, selected, onSelect, level,
  transcript, onLoadTranscript, onClose, onJumpToCall, onCopy,
}) {
  const all = _SAP.listAgents(state);
  const t = _SAP.totals(all);
  // Live agents need a fast clock; finished ones still show relative
  // ("3m ago") times and the swimlane window, so keep a slow idle tick.
  const now = _SAP_useNow(true, t.live > 0 ? 250 : 10_000);
  const shown = _SAP.listAgents(state, filter);
  const groups = _SAP.groupByCall(state, shown);
  const counts = { all: t.total, live: t.live, done: t.done, failed: t.failed };

  return (
    <aside className="split sa-pane">
      <div className="split-head">
        <_SAP_Icon name="agent" size={12} color="var(--cyan)" />
        <span className="mono" style={{ color: "var(--cyan)" }}>subagents</span>
        <span className="mono" style={{ color: "var(--fg-4)", whiteSpace: "nowrap" }}>· {t.live}/{t.total} live</span>
        <div style={{ flex: 1 }} />
        <span className={`chip muted mono sa-level ${level}`} title="RPC subagent subscription level">{level}</span>
        <button className="btn icon ghost" onClick={onClose} title="close manager"><_SAP_Icon name="close" size={10} /></button>
      </div>

      {selected ? (
        <_SAP_Inspector key={selected.id}
          agent={selected} callId={_SAP.rootCallIdOf(state, selected)} now={now} level={level} transcript={transcript}
          onBack={() => onSelect(null)} onLoadTranscript={onLoadTranscript}
          onJumpToCall={onJumpToCall} onCopy={onCopy} />
      ) : (
        <div className="sa-pane-body">
          {t.total === 0 ? (
            <div className="sa-empty" style={{ padding: "24px 8px", textAlign: "center" }}>
              No subagents in this session yet.<br />They appear here the moment a <span className="mono">task</span> call spawns them.
            </div>
          ) : (
            <>
              <div className="sa-stats">
                <div className="sa-stat"><span className="sa-stat-k">tokens</span><span className="sa-stat-v">{window.formatTokens(t.tokens)}</span></div>
                <div className="sa-stat"><span className="sa-stat-k">cost</span><span className="sa-stat-v">{_SAP.fmtCost(t.cost)}</span></div>
                <div className="sa-stat"><span className="sa-stat-k">tools</span><span className="sa-stat-v">{t.tools}</span></div>
                <div className="sa-stat"><span className="sa-stat-k">requests</span><span className="sa-stat-v">{t.requests}</span></div>
              </div>
              <SaSwimlanes agents={all} now={now} onSelect={onSelect} />
              <div className="sa-filters">
                {SA_FILTERS.map(([key, label]) => (
                  <button key={key} type="button" aria-pressed={filter === key}
                    className={`chip mono sa-filter ${filter === key ? "on" : "muted"}`} onClick={() => onFilter(key)}>
                    {label} {counts[key]}
                  </button>
                ))}
              </div>
              {groups.length === 0 && <div className="sa-empty">Nothing matches this filter.</div>}
              {groups.map(g => (
                <section key={g.callId ?? "none"} className="sa-group">
                  <button className="sa-group-head" onClick={() => g.callId && onJumpToCall(g.callId)} disabled={!g.callId}>
                    <_SAP_Icon name="agent" size={10} color="var(--fg-4)" />
                    <span className="mono">task</span>
                    <span className="mono sa-muted">{g.callId ? g.callId.slice(-6) : "detached"}</span>
                    <span>· {g.rows.length} agent{g.rows.length === 1 ? "" : "s"}</span>
                    {g.callId && <span className="sa-jump mono">jump to call ↗</span>}
                  </button>
                  {g.rows.map(r => <SaAgentRow key={r.agent.id} agent={r.agent} depth={r.depth} now={now} onSelect={onSelect} />)}
                </section>
              ))}
            </>
          )}
        </div>
      )}
    </aside>
  );
}

Object.assign(window, { SubagentPane });
