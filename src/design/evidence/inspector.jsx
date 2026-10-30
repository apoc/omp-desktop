/* Modal inspector; panels stay mounted while navigating so drafts survive. */
(function () {
  const {
    EvidenceOutcomes: Outcomes,
    EvidenceRecords: Records,
    EvidenceRequests: Requests,
    EvidencePresets: Presets,
    EvidenceHistory: History,
    EvidenceError: Error,
    useEvidenceAction: useAction,
  } = window;
  const panels = [
    ["outcomes", "Outcomes"],
    ["records", "Records"],
    ["requests", "Requests"],
    ["presets", "Presets"],
    ["history", "History & report"],
  ];
  function Inspector({ evidence, onClose, initialPanel = "outcomes" }) {
    const [panel, setPanel] = React.useState(initialPanel);
    const refresh = useAction();
    const modalRef = React.useRef(null);
    const closeRef = React.useRef(onClose);
    closeRef.current = onClose;
    window.useModalLayer(modalRef);
    React.useEffect(() => {
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeRef.current();
          return;
        }
        if (e.key !== "Tab") return;
        const root = modalRef.current;
        if (!root) return;
        const nodes = [
          ...root.querySelectorAll(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
          ),
        ].filter((el) => el.getClientRects().length);
        if (!nodes.length) {
          e.preventDefault();
          root.focus();
          return;
        }
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === root ||
            document.activeElement === first ||
            !root.contains(document.activeElement))
        ) {
          e.preventDefault();
          last.focus();
        } else if (
          !e.shiftKey &&
          (document.activeElement === last ||
            !root.contains(document.activeElement))
        ) {
          e.preventDefault();
          first.focus();
        }
      };
      window.addEventListener("keydown", onKey, true);
      return () => window.removeEventListener("keydown", onKey, true);
    }, []);
    return ReactDOM.createPortal(
      <div
        className="ev-scrim"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          className="ev-dialog"
          ref={modalRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby="evidence-title"
        >
          <header className="ev-dialog-head">
            <div>
              <span className="ev-eyebrow">Conversation evidence</span>
              <h1 id="evidence-title">Evidence inspector</h1>
            </div>
            <div className="ev-actions">
              <button
                className="btn ghost"
                disabled={refresh.busy}
                onClick={() => refresh.run(() => evidence.refresh())}
              >
                Refresh
              </button>
              <button
                className="btn ghost"
                onClick={onClose}
                aria-label="Close evidence inspector"
              >
                Close <span aria-hidden="true">×</span>
              </button>
            </div>
          </header>
          <nav className="ev-nav" aria-label="Evidence sections">
            {panels.map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-current={panel === key ? "page" : undefined}
                onClick={() => setPanel(key)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="ev-dialog-body">
            {evidence.loading && !evidence.view && (
              <p className="ev-note" role="status">
                Loading evidence…
              </p>
            )}
            {evidence.error && <Error error={evidence.error} />}
            <Error error={refresh.error} />
            {!evidence.view && !evidence.loading && (
              <p className="ev-empty">
                Evidence is unavailable for this conversation.
              </p>
            )}
            {evidence.view?.supported === false && (
              <p className="ev-empty">
                Evidence is not supported in this conversation.
              </p>
            )}
            {(evidence.view?.warnings || []).map((warning, index) => (
              <p className="ev-note" key={index}>
                {warning}
              </p>
            ))}
            <div hidden={panel !== "outcomes"}>
              <Outcomes evidence={evidence} />
            </div>
            <div hidden={panel !== "records"}>
              <Records evidence={evidence} />
            </div>
            <div hidden={panel !== "requests"}>
              <Requests evidence={evidence} />
            </div>
            <div hidden={panel !== "presets"}>
              <Presets evidence={evidence} />
            </div>
            <div hidden={panel !== "history"}>
              <History evidence={evidence} />
            </div>
          </div>
        </div>
      </div>,
      document.body,
    );
  }
  window.EvidenceInspector = Inspector;
})();
