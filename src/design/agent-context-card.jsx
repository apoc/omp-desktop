/* The rail is an interactive gauge; the read-only inventory stays in its inspector. */
function ContextCard({
  ctx,
  context,
  readSkill,
  onSelectAgent,
  onOpenSubagents,
  onJumpToCall,
  messages,
  sparklineValues,
  viewState,
  onViewStateChange,
  policyEditor,
}) {
  const [localView, setLocalView] = React.useState({});
  const view = viewState || localView;
  const updateView = onViewStateChange || setLocalView;
  const [inspector, setInspector] = React.useState(false);
  const closeInspector = React.useCallback(() => setInspector(false), []);
  const updateInspector = React.useCallback(
    (next) =>
      updateView((previous) => {
        const view = previous || {};
        const inspector = view.inspector || {};
        return {
          ...view,
          inspector: typeof next === "function" ? next(inspector) : next,
        };
      }),
    [updateView],
  );
  const throughput =
    ctx?.tokensPerSec == null ? "—" : `${ctx.tokensPerSec} t/s`;
  return (
    <>
      <section
        className="rail-card glass context-card"
        data-ambient-card="showContext"
        aria-label="Context"
      >
        <div className="rail-card-head context-card-head">
          <window.Icon name="context" size={11} color="var(--lilac)" />
          <span className="mono">context</span>
        </div>
        <window.ContextPolicyGauge ctx={ctx} {...policyEditor} />
        <div className="rail-spark">
          {sparklineValues?.length > 0 && (
            <window.Sparkline
              values={sparklineValues}
              width={210}
              height={28}
            />
          )}
          <div className="rail-spark-foot mono">
            <span>cost {ctx?.cost ?? "—"}</span>
            <span aria-label={`Throughput ${throughput}`}>{throughput}</span>
          </div>
        </div>
        <button
          type="button"
          className="context-card-inspect"
          onClick={() => setInspector(true)}
        >
          Inspect context <span aria-hidden="true">→</span>
        </button>
      </section>
      {inspector && (
        <window.ContextInspector
          ctx={ctx}
          context={context}
          readSkill={readSkill}
          onSelectAgent={onSelectAgent}
          onOpenSubagents={onOpenSubagents}
          onJumpToCall={onJumpToCall}
          messages={messages}
          viewState={view.inspector || {}}
          onViewStateChange={updateInspector}
          onClose={closeInspector}
        />
      )}
    </>
  );
}
window.ContextCard = ContextCard;
