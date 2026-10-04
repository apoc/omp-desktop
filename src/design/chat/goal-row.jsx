/* chat/goal-row.jsx — omp's goal mode in the transcript (app/goal.js):
   a one-line row for each change of the tab's goal (set, paused, resumed,
   budget reached, complete, dropped), and a slim marker above a turn omp
   started by itself to continue the goal (its prompt is hidden). Live-only,
   like job rows: get_messages' merge keeps them in place. */

const { Icon: _GR_Icon, TOOL_META: _GR_TOOL_META } = window;
const { rowView: _GR_rowView } = window.OMP_GOAL;

const _GR_COLORS = { active: _GR_TOOL_META.goal.color, paused: "var(--fg-3)", limit: "var(--amber)", done: "var(--lime)" };

const GoalRow = React.memo(function GoalRow({ msg, idx, highlighted }) {
  const view = _GR_rowView(msg);
  const color = _GR_COLORS[view.tone] ?? _GR_COLORS.paused;
  if (msg.event === "continue") {
    return (
      <div className={`goal-cont fade-up${highlighted ? " mm-hot" : ""}`} data-msg-idx={idx}>
        <span className="goal-cont-tag">goal</span>
        {view.title}
      </div>
    );
  }
  return (
    <div className={`row tool fade-up${highlighted ? " mm-hot" : ""}`} data-msg-idx={idx}>
      <div className="ass-rail">
        <div className="tool-glyph" style={{ borderColor: color, color }}>
          <_GR_Icon name={_GR_TOOL_META.goal.icon} size={11} color={color} />
        </div>
        <div className="ass-thread" />
      </div>
      <div className={`tool-card ok goal-row-card ${view.tone}`}>
        <div className="tool-card-head">
          <span className="tool-tag" style={{
            color,
            background: `color-mix(in oklab, ${color} 14%, transparent)`,
            borderColor: `color-mix(in oklab, ${color} 30%, var(--line))`,
          }}>{_GR_TOOL_META.goal.label}</span>
          <span className="tool-title goal-row-title" title={view.detail ?? undefined}>
            {view.title}
            {view.detail && <span className="goal-row-detail"> · {view.detail}</span>}
          </span>
          <div className="tool-card-spacer" />
          {view.chips.map(c => <span key={c} className="chip muted mono goal-row-chip">{c}</span>)}
        </div>
      </div>
    </div>
  );
});

Object.assign(window, { GoalRow });
