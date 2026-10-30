/* Collection is independent of whether the Ambient card is visible. */
(function () {
  const {
    EvidenceInspector: Inspector,
    EvidenceError: Error,
    useEvidenceAction: useAction,
  } = window;
  function Card({ evidence }) {
    const [panel, setPanel] = React.useState(null);
    const view = evidence?.view;
    const owner =
      evidence?.ownerKey ||
      `${evidence?.profileId || ""}:${view?.sessionId || ""}:${view?.epoch || ""}`;
    const priorOwner = React.useRef(owner);
    React.useEffect(() => {
      if (priorOwner.current !== owner) {
        priorOwner.current = owner;
        setPanel(null);
      }
    }, [owner]);
    const action = useAction();
    if (!evidence) return null;
    const summary = view ? window.OMP_EVIDENCE_MODEL.summarize(view) : null;
    const outcomes = (view?.outcomes || []).filter((o) => !o.retired);
    const counts =
      summary &&
      [
        ["collected", "collected"],
        ["missing", "missing"],
        ["failed", "failed"],
        ["blocked", "blocked"],
        ["stale", "stale"],
        ["waived", "waived"],
        ["unreviewed", "unreviewed"],
      ].filter(([key]) => summary[key] > 0);
    return (
      <>
        <div className="rail-card glass ev-card">
          <div className="rail-card-head ev-card-head">
            <span className="ev-card-mark" aria-hidden="true">
              ◇
            </span>
            <strong>Evidence</strong>
          </div>
          {view?.supported === false ? (
            <p className="ev-note">
              Evidence is not supported in this conversation.
            </p>
          ) : !view ? (
            <p className="ev-note">
              {evidence.loading ? "Loading evidence…" : "Evidence unavailable."}
            </p>
          ) : (
            <>
              <label className="ev-check ev-card-toggle">
                <input
                  type="checkbox"
                  checked={!!view.tracking}
                  disabled={action.busy}
                  onChange={(e) =>
                    action.run(() =>
                      evidence.mutate({
                        op: "tracking",
                        enabled: e.target.checked,
                      }),
                    )
                  }
                />{" "}
                Collection {view.tracking ? "on" : "off"}
              </label>
              {!outcomes.length ? (
                <p className="ev-card-empty">
                  Define what this change needs to prove.
                </p>
              ) : (
                <>
                  <div className="ev-card-counts">
                    {counts?.length ? (
                      counts.map(([key, label]) => (
                        <span key={key}>
                          <b>{summary[key]}</b> {label}
                        </span>
                      ))
                    ) : (
                      <span>No criteria recorded</span>
                    )}
                  </div>
                  <div className="ev-card-list">
                    {outcomes.slice(0, 3).map((outcome) => {
                      const requirements = (outcome.requirements || []).filter(
                        (r) => !r.retired,
                      );
                      const missing = requirements.filter((r) =>
                        [
                          "missing",
                          "failed",
                          "blocked",
                          "stale",
                          "rejected",
                        ].includes(
                          window.OMP_EVIDENCE_MODEL.requirementStatus(
                            view,
                            outcome,
                            r,
                          ).state,
                        ),
                      ).length;
                      return (
                        <button
                          key={outcome.id}
                          onClick={() => setPanel("outcomes")}
                          title={outcome.title}
                        >
                          <span>{outcome.title}</span>
                          <small>
                            {missing
                              ? `${missing} gap${missing === 1 ? "" : "s"}`
                              : requirements.length
                                ? `${requirements.length} criteria`
                                : "no criteria"}
                          </small>
                        </button>
                      );
                    })}
                  </div>
                  {outcomes.length > 3 && (
                    <span className="ev-meta">+{outcomes.length - 3} more</span>
                  )}
                </>
              )}
            </>
          )}
          <Error error={action.error || evidence.error} />
          <div className="ev-card-actions">
            <button
              className="btn ghost outlined"
              onClick={() => setPanel("outcomes")}
            >
              Review evidence
            </button>
            <button className="btn ghost" onClick={() => setPanel("requests")}>
              Request
            </button>
          </div>
        </div>
        {panel && (
          <Inspector
            key={owner}
            evidence={evidence}
            onClose={() => setPanel(null)}
            initialPanel={panel}
          />
        )}
      </>
    );
  }
  window.EvidenceCard = Card;
})();
