/* Usage and the read-only, scoped context inventory share one ambient card. */
const _CC_number = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString()
    : "—";

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
  const expanded = !!view.expanded;
  const [inspector, setInspector] = React.useState(false);
  const bodyId = React.useId();
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
  const openInspector = (tab) => {
    if (tab) updateInspector((previous) => ({ ...previous, tab }));
    setInspector(true);
  };
  const main = (context?.agents || []).find((agent) => agent.id === "main");
  const details = window.OMP_CONTEXT_DETAILS(main, ctx);
  const ready = ctx?.status === "ready";
  const used = ready ? ctx?.used : null;
  const total = ctx?.total;
  const pct =
    ready && typeof ctx?.pct === "number" && Number.isFinite(ctx.pct)
      ? ctx.pct
      : null;
  const circumference = 2 * Math.PI * 22;
  const tone =
    pct > 80 ? "var(--rose)" : pct > 60 ? "var(--amber)" : "var(--accent)";
  const breakdown = ready ? details?.breakdown || [] : [];
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
          <button
            type="button"
            className="context-card-toggle"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() =>
              updateView((previous) => ({
                ...previous,
                expanded: !previous?.expanded,
              }))
            }
          >
            {expanded ? "Less ▴" : "More ▾"}
          </button>
        </div>
        <div className="token-gauge">
          <svg
            width="56"
            height="56"
            viewBox="0 0 56 56"
            role="img"
            aria-label={
              pct == null
                ? "Context usage unavailable"
                : `Context usage ${pct.toFixed(1)} percent`
            }
          >
            <circle
              cx="28"
              cy="28"
              r="22"
              stroke="var(--line)"
              strokeWidth="3"
              fill="none"
            />
            {pct != null && (
              <circle
                cx="28"
                cy="28"
                r="22"
                stroke={tone}
                strokeWidth="3"
                strokeLinecap="round"
                fill="none"
                strokeDasharray={`${(Math.max(0, Math.min(pct, 100)) / 100) * circumference} ${circumference}`}
                transform="rotate(-90 28 28)"
              />
            )}
            <text
              x="28"
              y="31"
              textAnchor="middle"
              fontSize="11"
              fontFamily="var(--font-mono)"
              fill="var(--fg)"
            >
              {pct == null ? "—" : `${pct.toFixed(1)}%`}
            </text>
          </svg>
          <div className="context-card-metrics">
            <div className="mono">
              {_CC_number(used)} / {_CC_number(total)}
            </div>
            <div>
              tokens ·{" "}
              {ready
                ? "capacity"
                : ctx?.status === "refreshing"
                  ? "refreshing"
                  : "unavailable"}
            </div>
            <div>
              cost {ctx?.cost ?? "—"} · {throughput}
            </div>
          </div>
        </div>
        <div className="rail-spark">
          {sparklineValues?.length > 0 && (
            <window.Sparkline
              values={sparklineValues}
              width={210}
              height={28}
            />
          )}
          <div className="rail-spark-foot mono">
            <span>throughput</span>
            <span>{throughput}</span>
          </div>
        </div>
        {!expanded && policyEditor && <window.ContextPolicySummary {...policyEditor} />}
        <div id={bodyId} className="context-card-expanded" hidden={!expanded}>
          {policyEditor && <window.ContextPolicyEditor {...policyEditor} />}
          <div className="context-card-subhead">
            <span>Context breakdown</span>
            <span className="mono">tokens</span>
          </div>
          {breakdown.length ? (
            <div className="context-breakdown">
              {breakdown.map((part) => (
                <div className="context-breakdown-row" key={part.id}>
                  <div>
                    <span>{part.label}</span>
                    <span
                      className="mono"
                      aria-label={
                        part.tokens == null
                          ? "Unavailable"
                          : `${part.estimated ? "Approximately " : ""}${_CC_number(part.tokens)} tokens`
                      }
                      title={
                        part.estimated && part.tokens != null
                          ? "Local text estimate (UTF-8 bytes ÷ 4). Skills counts the prompt catalog, not loaded skill files; Messages is the remainder of the native total. Estimates may differ from provider accounting."
                          : undefined
                      }
                    >
                      {part.estimated && typeof part.tokens === "number"
                        ? "≈"
                        : ""}
                      {_CC_number(part.tokens)}
                    </span>
                  </div>
                  {typeof part.tokens === "number" &&
                    Number.isFinite(part.tokens) &&
                    typeof total === "number" &&
                    total > 0 && (
                      <div
                        className="context-breakdown-track"
                        aria-hidden="true"
                      >
                        <span
                          style={{
                            width: `${Math.min(100, Math.max(0, (part.tokens / total) * 100))}%`,
                          }}
                        />
                      </div>
                    )}
                </div>
              ))}
            </div>
          ) : (
            <p className="context-card-note">
              {ctx?.status === "refreshing"
                ? "Refreshing context…"
                : "Breakdown unavailable."}
            </p>
          )}
          {breakdown.some((part) => part.estimated) && (
            <p className="context-card-note">
              ≈ Local estimates · Messages is the remainder.
            </p>
          )}
          <div className="context-card-subhead">
            <span>Explore</span>
            <span>read-only</span>
          </div>
          <div className="context-card-links">
            {[
              ["skills", "Skills"],
              ["tools", "MCP tools"],
              ["calls", "Calls"],
              ["instructions", "Instructions"],
              ["memory", "Memory"],
            ].map(([tab, label]) => (
              <button
                type="button"
                key={tab}
                onClick={() => openInspector(tab)}
              >
                {label}
                <span aria-hidden="true">↗</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="context-card-inspect"
            onClick={() => openInspector()}
          >
            Inspect context <span aria-hidden="true">→</span>
          </button>
        </div>
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
