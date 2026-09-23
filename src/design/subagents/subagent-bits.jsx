/* subagents/subagent-bits.jsx — primitives shared by the rail card, the
   manager pane and the inspector. Agent objects are the shape produced by
   window.OMP_SUBAGENTS (src/app/subagents.js). */

const { Icon: _SA_Icon, TOOL_META: _SA_TOOL_META, OMP_SUBAGENTS: _SA } = window;

/** Re-render on an interval while `active` — drives live elapsed clocks
 *  without a timer per agent row when nothing is running. */
function useSaNow(active, ms = 250) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

/** omp tool name → TOOL_META entry (adapter.js owns the name mapping). */
function saToolMeta(rawName) {
  const key = window.normalizeToolName ? window.normalizeToolName(rawName ?? "") : rawName;
  return _SA_TOOL_META[key] ?? { color: "var(--fg-3)", icon: "circle", label: rawName || "tool" };
}

/** resolvedModel ("provider/id" or bare id) → display name, same lookup
 *  order live.js uses for the main model. */
function saModelName(resolved) {
  if (!resolved) return "—";
  const id = resolved.slice(resolved.lastIndexOf("/") + 1);
  return window.MODEL_NAMES?.[id] ?? window.formatModelId(id);
}

const saHueStyle = agent => ({ "--sa-hue": _SA.agentHue(agent.id) });
const saLeafName = id => id.slice(id.lastIndexOf(".") + 1);

function SaDot({ status }) {
  return <span className={`sa-dot ${status}`} title={status} />;
}

function SaToolChip({ tool, running }) {
  const meta = saToolMeta(tool);
  return (
    <span className={`sa-tool${running ? " running" : ""}`} style={{ "--sa-tool": meta.color }}>
      <_SA_Icon name={meta.icon} size={9} color={meta.color} dotColor={meta.color} />
      {tool || meta.label}
    </span>
  );
}

function SaElapsed({ agent, now }) {
  return <span className="sa-elapsed">{_SA.fmtDuration(_SA.elapsedMs(agent, now))}</span>;
}

const SA_STATUS_LABEL = { pending: "queued", running: "running", completed: "done", failed: "failed", aborted: "aborted" };
const SA_STATUS_CHIP  = { running: "accent", failed: "danger", aborted: "warn" };

function SaStatusChip({ agent }) {
  const label = agent.unknownOutcome ? "ended" : SA_STATUS_LABEL[agent.status] ?? agent.status;
  const tone = agent.unknownOutcome ? "muted" : SA_STATUS_CHIP[agent.status] ?? "muted";
  return (
    <span className={`chip ${tone}`} title={agent.unknownOutcome ? "finished while this tab was in the background" : undefined}>
      <SaDot status={agent.status} /> {label}
    </span>
  );
}

function SaContextTube({ progress }) {
  const used = progress?.contextTokens;
  const total = progress?.contextWindow;
  if (!used || !total) return null;
  const pct = Math.min(100, (used / total) * 100);
  return (
    <span className="status-bar-tube sa-tube" title={`context ${window.formatTokens(used)} / ${window.formatTokens(total)}`}>
      <span className="status-bar-fill" style={{ width: `${pct}%` }} />
    </span>
  );
}

function SaGlyph({ agent }) {
  return (
    <span className="sa-glyph" style={saHueStyle(agent)}>
      <_SA_Icon name="agent" size={12} color="currentColor" dotColor="currentColor" />
    </span>
  );
}

Object.assign(window, {
  useSaNow, saToolMeta, saModelName, saHueStyle, saLeafName,
  SaDot, SaToolChip, SaElapsed, SaStatusChip, SaContextTube, SaGlyph,
});
