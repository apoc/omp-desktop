/* Inspection and human review are separate from an agent's interpretation. */
(function () {
  const {
    EvidenceField: Field,
    EvidenceError: Error,
    EvidenceStatus: Status,
    EvidenceWhen: When,
    EvidenceArtifact: Artifact,
    EvidenceRecordForm: RecordForm,
    useEvidenceAction: useAction,
  } = window;
  function ReceiptFingerprint({ label, fingerprint }) {
    if (!fingerprint) return <p className="ev-meta">{label}: unavailable.</p>;
    return (
      <p className="ev-meta ev-break">
        {label}: {fingerprint.head || "unknown revision"} ·{" "}
        {fingerprint.complete
          ? fingerprint.dirtyDigest
            ? `working tree ${fingerprint.dirtyDigest}`
            : "clean working tree"
          : `incomplete: ${fingerprint.reason || "unknown reason"}`}
      </p>
    );
  }
  function Receipt({ evidence, receipt }) {
    return (
      <details className="ev-receipt">
        <summary>
          {receipt.toolName} ·{" "}
          {receipt.isError ? "tool error" : "tool returned"}{" "}
          <When at={receipt.at} />
        </summary>
        <p className="ev-note">
          Execution receipt only; a successful tool call does not verify the
          outcome.
        </p>
        {receipt.command && <pre className="selectable">{receipt.command}</pre>}
        {receipt.exitCode != null && (
          <p className="ev-meta">Exit code: {receipt.exitCode}</p>
        )}
        <ReceiptFingerprint
          label="Source before execution"
          fingerprint={receipt.beforeFingerprint}
        />
        <ReceiptFingerprint
          label="Source after execution"
          fingerprint={receipt.fingerprint}
        />
        {receipt.preview && <pre className="selectable">{receipt.preview}</pre>}
        {receipt.truncated && (
          <p className="ev-note">Receipt preview truncated.</p>
        )}
        {receipt.artifact && (
          <Artifact evidence={evidence} artifact={receipt.artifact} />
        )}
      </details>
    );
  }
  function CI({ ci }) {
    const snapshot = ci.snapshot;
    return (
      <details className="ev-receipt">
        <summary>CI details · {ci.state || "unknown"}</summary>
        {ci.sourceSha && (
          <p className="ev-break">
            <strong>Source commit:</strong> {ci.sourceSha}
          </p>
        )}
        {snapshot ? (
          <>
            <p>
              <strong>Repository:</strong>{" "}
              {snapshot.repository || "unavailable"} · <strong>Branch:</strong>{" "}
              {snapshot.branch || "unavailable"}
            </p>
            <p>
              <strong>Pull request:</strong> {snapshot.number ?? "unavailable"}{" "}
              · {snapshot.prState || "unknown"} · <strong>Checks:</strong>{" "}
              {snapshot.checksState || "unknown"}
            </p>
            {snapshot.url && (
              <p className="ev-break">
                <strong>PR URL:</strong> {snapshot.url}
              </p>
            )}
            {!!snapshot.failedChecks?.length && (
              <>
                <strong>Failed checks</strong>
                <ul>
                  {snapshot.failedChecks.map((check, i) => (
                    <li key={i}>
                      {check.name || "Unnamed check"}
                      {check.url ? ` — ${check.url}` : ""}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        ) : (
          <p className="ev-note">No CI snapshot is available.</p>
        )}
        {ci.reason && (
          <p>
            <strong>Reason:</strong> {ci.reason}
          </p>
        )}
        {ci.limitations && (
          <p>
            <strong>Limitations:</strong> {ci.limitations}
          </p>
        )}
      </details>
    );
  }
  function Record({ evidence, record }) {
    const [reviewing, setReviewing] = React.useState("");
    const [reason, setReason] = React.useState("");
    const action = useAction();
    const view = evidence.view;
    const outcome = (view.outcomes || []).find(
      (o) => o.id === record.outcomeId,
    );
    const requirement = outcome?.requirements?.find(
      (r) => r.id === record.requirementId,
    );
    const receipt = (view.receipts || []).find(
      (r) => r.id === record.source?.receiptId,
    );
    const status = window.OMP_EVIDENCE_MODEL.recordStatus(view, record);
    return (
      <article className="ev-record">
        <div className="ev-row">
          <h3>{record.title}</h3>
          <Status status={status} />
        </div>
        <div className="ev-meta">
          {outcome?.title || "Unknown outcome"}
          {requirement ? ` · ${requirement.text}` : ""} · {record.kind} ·{" "}
          {record.result} · {record.source?.type || "unknown source"} ·{" "}
          <When at={record.at} />
        </div>
        {record.source?.type === "agent" && (
          <p className="ev-note">
            Agent interpretation, not independent verification.
          </p>
        )}
        {status.reason && <p className="ev-note">{status.reason}</p>}
        <p>{record.summary}</p>
        {record.limitations && (
          <p>
            <strong>Limitations:</strong> {record.limitations}
          </p>
        )}
        {record.reason && (
          <p>
            <strong>Reason:</strong> {record.reason}
          </p>
        )}
        {record.fileRef?.path && (
          <p className="ev-break">
            <strong>File reference:</strong> {record.fileRef.path}
            {record.fileRef.from != null ? `:${record.fileRef.from}` : ""}
            {record.fileRef.to != null ? `–${record.fileRef.to}` : ""}
          </p>
        )}
        {record.url && (
          <p className="ev-break">
            <strong>URL reference:</strong> {record.url}
          </p>
        )}
        {record.fingerprint ? (
          <p className="ev-meta ev-break">
            Source: {record.fingerprint.head || "unknown revision"} ·{" "}
            {record.fingerprint.complete
              ? record.source?.type === "ci"
                ? "CI commit only"
                : record.fingerprint.dirtyDigest
                  ? `working tree ${record.fingerprint.dirtyDigest}`
                  : "clean working tree"
              : `incomplete: ${record.fingerprint.reason || "unknown reason"}`}
          </p>
        ) : (
          <p className="ev-meta">Source freshness not verified.</p>
        )}
        {record.artifact && (
          <Artifact evidence={evidence} artifact={record.artifact} />
        )}
        {record.ci && <CI ci={record.ci} />}
        {receipt ? (
          <Receipt evidence={evidence} receipt={receipt} />
        ) : (
          record.source?.receiptId && (
            <p className="ev-note">
              Linked receipt unavailable in the current window.
            </p>
          )
        )}
        <div className="ev-review">
          <strong>
            Human review: {record.review?.decision || "unreviewed"}
          </strong>
          {record.review?.reason && <span> · {record.review.reason}</span>}
        </div>
        <div className="ev-actions">
          <button
            className="btn ghost"
            disabled={action.busy}
            onClick={() => setReviewing("accepted")}
          >
            Accept
          </button>
          <button
            className="btn ghost"
            disabled={action.busy}
            onClick={() => setReviewing("rejected")}
          >
            Reject
          </button>
        </div>
        {reviewing && (
          <form
            className="ev-form"
            onSubmit={(e) => {
              e.preventDefault();
              action.run(
                () =>
                  evidence.mutate({
                    op: "review",
                    recordId: record.id,
                    decision: reviewing,
                    reason,
                  }),
                () => {
                  setReviewing("");
                  setReason("");
                },
              );
            }}
          >
            <fieldset className="ev-fields" disabled={action.busy}>
              <Field
                label={`Reason for ${reviewing === "accepted" ? "accepting" : "rejecting"}${reviewing === "accepted" ? " (optional)" : ""}`}
              >
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  required={reviewing === "rejected"}
                  rows="2"
                />
              </Field>
              <div className="ev-actions">
                <button className="btn" disabled={action.busy}>
                  Confirm{" "}
                  {reviewing === "accepted" ? "acceptance" : "rejection"}
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setReviewing("")}
                >
                  Cancel
                </button>
              </div>
            </fieldset>
          </form>
        )}
        <Error error={action.error} />
      </article>
    );
  }
  function CaptureCI({ evidence }) {
    const outcomes = (evidence.view?.outcomes || []).filter((o) => !o.retired);
    const [outcomeId, setOutcomeId] = React.useState("");
    const [requirementId, setRequirementId] = React.useState("");
    const action = useAction();
    const outcome = outcomes.find((o) => o.id === outcomeId);
    return (
      <details className="ev-receipt">
        <summary>Capture existing CI information</summary>
        <p className="ev-note">
          Reads available CI facts; it does not start a CI run.
        </p>
        <form
          className="ev-form"
          onSubmit={(e) => {
            e.preventDefault();
            action.run(() =>
              evidence.mutate({
                op: "capture_ci",
                outcomeId,
                requirementId: requirementId || null,
              }),
            );
          }}
        >
          <fieldset className="ev-fields" disabled={action.busy}>
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
                  <option key={o.id} value={o.id}>
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
                {(outcome?.requirements || [])
                  .filter((r) => !r.retired)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.text}
                    </option>
                  ))}
              </select>
            </Field>
            <Error error={action.error} />
            <button className="btn" disabled={action.busy || !outcomeId}>
              Capture CI
            </button>
          </fieldset>
        </form>
      </details>
    );
  }
  function Records({ evidence }) {
    const [adding, setAdding] = React.useState(false);
    const records = evidence.view?.records || [];
    const receipts = evidence.view?.receipts || [];
    return (
      <section className="ev-stack">
        <div className="ev-section-head">
          <div>
            <h2>Records & gaps</h2>
            <p>
              Observations and failures remain visible. Review is a separate
              human decision.
            </p>
          </div>
          <button className="btn" onClick={() => setAdding(true)}>
            Add record
          </button>
        </div>
        {adding && (
          <RecordForm evidence={evidence} onDone={() => setAdding(false)} />
        )}
        <CaptureCI evidence={evidence} />
        {!records.length && (
          <p className="ev-empty">
            No records yet. Record evidence or describe a blocked gap.
          </p>
        )}
        {records.map((record) => (
          <Record key={record.id} evidence={evidence} record={record} />
        ))}
        <h3>Captured receipts</h3>
        <p className="ev-note">
          Captured tool outputs are factual receipts, not proof that acceptance
          criteria passed.
        </p>
        {!receipts.length && <p className="ev-empty">No captured receipts.</p>}
        {receipts.map((receipt) => (
          <Receipt key={receipt.id} evidence={evidence} receipt={receipt} />
        ))}
      </section>
    );
  }
  window.EvidenceRecords = Records;
})();
