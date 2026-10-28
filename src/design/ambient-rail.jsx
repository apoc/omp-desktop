// Ambient layout owns only presentation. Existing tweak keys still govern
// PR monitoring, plugin scheduling/approval, and extension-widget visibility.
function AmbientRail({
  ctx,
  activity,
  messages,
  onClose,
  sparklineValues,
  hoveredMsgIdx,
  onMinimapHover,
  onMinimapClick,
  subagents,
  subagentPaneOpen,
  onOpenSubagent,
  onToggleSubagentPane,
  onOpenTree,
  items,
  tweaks,
  onChange,
  onSettings,
  cards,
  notices,
}) {
  const {
    Icon,
    TokenGauge,
    ActivityRadar,
    Sparkline,
    TOOL_META,
    SubagentRailCard,
    SessionMinimap,
    AmbientCardList,
  } = window;
  const [controlsOpen, setControlsOpen] = React.useState(false);
  const controlsId = React.useId();
  const controlsButton = React.useRef(null);
  const ordered = React.useMemo(
    () => window.OMP_AMBIENT_RAIL.ordered(items, tweaks.railOrder),
    [items, tweaks.railOrder],
  );
  const sparkVals = sparklineValues?.length
    ? sparklineValues
    : Array(30).fill(0);
  const closeControls = () => {
    setControlsOpen(false);
    controlsButton.current?.focus();
  };
  const builtIns = {
    showContext: (
      <div className="rail-card glass" data-ambient-card="showContext">
        <TokenGauge
          used={ctx.used}
          total={ctx.total}
          pct={ctx.pct}
          label={ctx.label}
          sub={`cost ${ctx.cost} · ${ctx.tokensPerSec} t/s`}
        />
        <div className="rail-spark">
          <Sparkline values={sparkVals} width={210} height={28} />
          <div className="rail-spark-foot mono">
            <span style={{ color: "var(--fg-4)" }}>throughput</span>
            <span style={{ color: "var(--accent)" }}>
              {ctx.tokensPerSec} t/s
            </span>
          </div>
        </div>
      </div>
    ),
    showRadar: (
      <div className="rail-card glass" data-ambient-card="showRadar">
        <div className="rail-card-head">
          <Icon name="radar" size={11} color="var(--accent)" />
          <span className="mono" style={{ color: "var(--fg-2)" }}>
            agent radar
          </span>
          <span className="chip muted mono" style={{ marginLeft: "auto" }}>
            last 60s
          </span>
        </div>
        <ActivityRadar activity={activity} tps={ctx.tokensPerSec} />
        <div className="legend">
          {Object.entries(TOOL_META)
            .filter(([k]) => ["read", "search", "edit", "bash"].includes(k))
            .map(([k, m]) => (
              <span key={k} className="legend-item">
                <span style={{ background: m.color }} /> {m.label}
              </span>
            ))}
        </div>
      </div>
    ),
    showSubagents: (
      <SubagentRailCard
        agents={subagents}
        paneOpen={subagentPaneOpen}
        onOpen={onOpenSubagent}
        onTogglePane={onToggleSubagentPane}
      />
    ),
    showMinimap: (
      <div
        className="rail-card glass rail-minimap"
        data-ambient-card="showMinimap"
      >
        <div className="rail-card-head">
          <Icon name="minimap" size={11} color="var(--fg-3)" />
          <span className="mono" style={{ color: "var(--fg-2)" }}>
            minimap
          </span>
        </div>
        <SessionMinimap
          messages={messages}
          hoveredIdx={hoveredMsgIdx}
          onHover={onMinimapHover}
          onClick={onMinimapClick}
        />
      </div>
    ),
  };
  return (
    <aside className="rail" aria-label="Ambient">
      <div className="rail-head">
        <span className="mono" style={{ color: "var(--fg-3)" }}>
          ambient
        </span>
        <span className="rail-head-actions">
          <button
            type="button"
            ref={controlsButton}
            className={`btn icon ghost${controlsOpen ? " on" : ""}`}
            aria-label="Ambient controls"
            title="Choose and reorder ambient cards"
            aria-expanded={controlsOpen}
            aria-controls={controlsId}
            onClick={() => setControlsOpen((open) => !open)}
          >
            <Icon name="cog" size={12} />
          </button>
          <button
            type="button"
            className="btn icon ghost"
            onClick={onOpenTree}
            aria-label="Conversation tree"
            title="conversation tree (prompt-cache status)"
          >
            <Icon name="branch" size={10} />
          </button>
          <button
            type="button"
            className="btn icon ghost"
            onClick={onClose}
            aria-label="Hide ambient rail"
            title="hide rail"
          >
            <Icon name="close" size={10} />
          </button>
        </span>
      </div>
      {controlsOpen && (
        <section
          id={controlsId}
          className="ambient-controls glass"
          aria-label="Ambient controls"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              closeControls();
            }
          }}
        >
          <div className="ambient-controls-head">
            <strong>Ambient cards</strong>
            <span>Show · drag to reorder</span>
          </div>
          <AmbientCardList items={items} tweaks={tweaks} onChange={onChange} />
          <div className="ambient-controls-foot">
            <button
              type="button"
              onClick={() => onChange("railOrder", null)}
              disabled={tweaks.railOrder == null}
            >
              Reset order
            </button>
            <button
              type="button"
              onClick={() => {
                closeControls();
                onSettings();
              }}
            >
              Rail settings <Icon name="arrow" size={11} />
            </button>
          </div>
          <p>
            Changes off stops monitoring and Auto-fix. Hidden plugins won't
            start new runs; showing them still requires approval.
          </p>
        </section>
      )}
      <div className="rail-body">
        {notices}
        {ordered.map((item) =>
          tweaks[item.id] === false ? null : (
            <React.Fragment key={item.id}>
              {builtIns[item.id] ?? cards[item.id]}
            </React.Fragment>
          ),
        )}
      </div>
    </aside>
  );
}

window.AmbientRail = AmbientRail;
