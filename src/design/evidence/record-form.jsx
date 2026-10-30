/* User-authored records and explicit gaps, with optional observed receipt or imported artifact. */
(function () {
  const {
    EvidenceField: Field,
    EvidenceKindSelect: Kind,
    EvidenceError: Error,
    useEvidenceAction: useAction,
  } = window;
  function RecordForm({ evidence, onDone }) {
    const outcomes = (evidence.view?.outcomes || []).filter((o) => !o.retired);
    const [outcomeId, setOutcomeId] = React.useState(outcomes[0]?.id || "");
    const [requirementId, setRequirementId] = React.useState("");
    const [title, setTitle] = React.useState("");
    const [kind, setKind] = React.useState("other");
    const [result, setResult] = React.useState("observed");
    const [summary, setSummary] = React.useState("");
    const [limitations, setLimitations] = React.useState("");
    const [reason, setReason] = React.useState("");
    const [receiptId, setReceiptId] = React.useState("");
    const [artifact, setArtifact] = React.useState(null);
    const [path, setPath] = React.useState("");
    const [url, setUrl] = React.useState("");
    const action = useAction();
    const selected = outcomes.find((o) => o.id === outcomeId);
    const save = (e) => {
      e.preventDefault();
      const record = { title, kind, result, summary, limitations, reason };
      if (receiptId) record.receiptId = receiptId;
      if (artifact) record.artifact = artifact;
      if (path.trim()) record.fileRef = { path: path.trim() };
      if (url.trim()) record.url = url.trim();
      action.run(
        () =>
          evidence.mutate({
            op: "record",
            outcomeId,
            requirementId: requirementId || null,
            record,
          }),
        onDone,
      );
    };
    return (
      <form className="ev-form" onSubmit={save}>
        <fieldset className="ev-fields" disabled={action.busy}>
          <h3>Add record or gap</h3>
          {!outcomes.length && (
            <p className="ev-note">Add an outcome before recording evidence.</p>
          )}
          <Field label="Outcome">
            <select
              required
              value={outcomeId}
              onChange={(e) => {
                setOutcomeId(e.target.value);
                setRequirementId("");
              }}
            >
              <option value="">Select outcome</option>
              {outcomes.map((o) => (
                <option value={o.id} key={o.id}>
                  {o.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Criterion (optional)">
            <select
              value={requirementId}
              onChange={(e) => setRequirementId(e.target.value)}
            >
              <option value="">Outcome-level evidence</option>
              {(selected?.requirements || [])
                .filter((r) => !r.retired)
                .map((r) => (
                  <option value={r.id} key={r.id}>
                    {r.text}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Title">
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <div className="ev-form-grid">
            <Field label="Type">
              <Kind value={kind} onChange={setKind} any={false} />
            </Field>
            <Field label="Result">
              <select
                value={result}
                onChange={(e) => setResult(e.target.value)}
              >
                {["observed", "passed", "failed", "blocked", "cancelled"].map(
                  (v) => (
                    <option key={v}>{v}</option>
                  ),
                )}
              </select>
            </Field>
          </div>
          <Field label="Summary">
            <textarea
              required
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows="3"
            />
          </Field>
          <Field label="Limitations">
            <textarea
              value={limitations}
              onChange={(e) => setLimitations(e.target.value)}
              rows="2"
            />
          </Field>
          <Field label="Reason (especially for a gap)">
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows="2"
            />
          </Field>
          <Field label="Attach a captured receipt (optional)">
            <select
              value={receiptId}
              onChange={(e) => setReceiptId(e.target.value)}
            >
              <option value="">None</option>
              {(evidence.view?.receipts || []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.toolName} · {r.command || r.preview || r.id}
                </option>
              ))}
            </select>
          </Field>
          <div className="ev-actions">
            <button
              type="button"
              className="btn ghost"
              disabled={action.busy}
              onClick={() =>
                action.run(
                  () => evidence.pickArtifact(),
                  (value) => {
                    if (value) setArtifact(value);
                  },
                )
              }
            >
              Choose artifact…
            </button>
            {artifact && (
              <>
                <span className="ev-meta">{artifact.name}</span>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setArtifact(null)}
                >
                  Remove
                </button>
              </>
            )}
          </div>
          <Field label="File reference (optional)">
            <input value={path} onChange={(e) => setPath(e.target.value)} />
          </Field>
          <Field label="URL reference (optional)">
            <input value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Error error={action.error} />
          <div className="ev-actions">
            <button className="btn" disabled={action.busy || !outcomeId}>
              Save record
            </button>
            <button type="button" className="btn ghost" onClick={onDone}>
              Cancel
            </button>
          </div>
        </fieldset>
      </form>
    );
  }
  window.EvidenceRecordForm = RecordForm;
})();
