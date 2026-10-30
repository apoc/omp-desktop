/* Audit history and a plain-text Markdown report, never rendered as HTML. */
(function () {
  const { EvidenceWhen: When } = window;
  function History({ evidence }) {
    const [copyState, setCopyState] = React.useState("");
    const view = evidence.view;
    const report = view ? window.OMP_EVIDENCE_MODEL.report(view) : "";
    const history = view?.history || [];
    const exportReport = () => {
      const url = URL.createObjectURL(
        new Blob([report], { type: "text/markdown;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "evidence-report.md";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    return (
      <section className="ev-stack">
        <div className="ev-section-head">
          <div>
            <h2>History & report</h2>
            <p>
              Audit entries preserve who changed what. A report is a snapshot,
              not an assurance.
            </p>
          </div>
        </div>
        <div className="ev-actions">
          <button
            className="btn"
            disabled={!report}
            onClick={() =>
              window
                .copyText(report)
                .then((ok) =>
                  setCopyState(
                    ok ? "Copied report." : "Clipboard unavailable.",
                  ),
                )
            }
          >
            Copy report
          </button>
          <button
            className="btn ghost"
            disabled={!report}
            onClick={exportReport}
          >
            Export Markdown
          </button>
        </div>
        {copyState && (
          <p className="ev-note" role="status">
            {copyState}
          </p>
        )}
        {report && (
          <details className="ev-receipt">
            <summary>Preview report</summary>
            <pre className="selectable">{report}</pre>
          </details>
        )}
        <h3>Audit history</h3>
        {!history.length && (
          <p className="ev-empty">No audit entries in this view.</p>
        )}
        {[...history].reverse().map((entry, index) => (
          <div className="ev-audit" key={entry.id || index}>
            <div className="ev-row">
              <strong>{entry.action}</strong>
              <When at={entry.at} />
            </div>
            <div className="ev-meta">{entry.actor}</div>
            {entry.detail && (
              <p>
                {typeof entry.detail === "string"
                  ? entry.detail
                  : entry.detail.summary || entry.detail.text || ""}
              </p>
            )}
          </div>
        ))}
      </section>
    );
  }
  window.EvidenceHistory = History;
})();
