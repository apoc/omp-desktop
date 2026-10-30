/* Saving a request is metadata only. Sending it is a separate explicit action. */
(function () {
  const {
    EvidenceField: Field,
    EvidenceError: Error,
    EvidenceWhen: When,
    useEvidenceAction: useAction,
  } = window;
  function Editor({ evidence, request, onDone }) {
    const outcomes = (evidence.view?.outcomes || []).filter((o) => !o.retired);
    const [outcomeId, setOutcomeId] = React.useState(
      request?.outcomeId || outcomes[0]?.id || "",
    );
    const [requirementId, setRequirementId] = React.useState(
      request?.requirementId || "",
    );
    const [text, setText] = React.useState(request?.text || "");
    const [saved, setSaved] = React.useState(false);
    const action = useAction();
    const outcome = outcomes.find((o) => o.id === outcomeId);
    const input = () => ({
      ...(request ? { requestId: request.id } : {}),
      outcomeId,
      requirementId: requirementId || null,
      text,
    });
    return (
      <form
        className="ev-form"
        onSubmit={(e) => {
          e.preventDefault();
          action.run(
            () => evidence.mutate({ op: "request", ...input() }),
            () => {
              setSaved(true);
              onDone();
            },
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
                setSaved(false);
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
              onChange={(e) => {
                setRequirementId(e.target.value);
                setSaved(false);
              }}
            >
              <option value="">Outcome-level request</option>
              {(outcome?.requirements || [])
                .filter((r) => !r.retired)
                .map((r) => (
                  <option value={r.id} key={r.id}>
                    {r.text}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Request">
            <textarea
              required
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setSaved(false);
              }}
              rows="4"
            />
          </Field>
          <p className="ev-note">
            Saving only records this request. Sending explicitly asks the agent
            for evidence.
          </p>
          <Error error={action.error} />
          {saved && (
            <p className="ev-note" role="status">
              Saved.
            </p>
          )}
          <div className="ev-actions">
            <button className="btn" disabled={action.busy || !outcomeId}>
              Save request
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={action.busy || !outcomeId || !text.trim()}
              onClick={() =>
                action.run(() => evidence.request(input()), onDone)
              }
            >
              Send request
            </button>
            <button type="button" className="btn ghost" onClick={onDone}>
              Cancel
            </button>
          </div>
        </fieldset>
      </form>
    );
  }
  function Request({ evidence, request }) {
    const [editing, setEditing] = React.useState(false);
    const action = useAction();
    const outcome = evidence.view?.outcomes?.find(
      (o) => o.id === request.outcomeId,
    );
    const requirement = outcome?.requirements?.find(
      (r) => r.id === request.requirementId,
    );
    return (
      <article className="ev-record">
        <p>{request.text}</p>
        <div className="ev-meta">
          {outcome?.title || "Unknown outcome"}
          {requirement ? ` · ${requirement.text}` : ""} ·{" "}
          <When at={request.updatedAt || request.at} />
        </div>
        {editing ? (
          <Editor
            evidence={evidence}
            request={request}
            onDone={() => setEditing(false)}
          />
        ) : (
          <div className="ev-actions">
            <button className="btn ghost" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              className="btn ghost"
              disabled={action.busy}
              onClick={() =>
                action.run(() =>
                  evidence.request({
                    requestId: request.id,
                    outcomeId: request.outcomeId,
                    requirementId: request.requirementId,
                    text: request.text,
                  }),
                )
              }
            >
              Send request
            </button>
          </div>
        )}
        <Error error={action.error} />
      </article>
    );
  }
  function Requests({ evidence }) {
    const [adding, setAdding] = React.useState(false);
    const requests = evidence.view?.requests || [];
    return (
      <section className="ev-stack">
        <div className="ev-section-head">
          <div>
            <h2>Requests</h2>
            <p>
              Choose what additional evidence to ask for. Saving never sends a
              prompt.
            </p>
          </div>
          <button className="btn" onClick={() => setAdding(true)}>
            New request
          </button>
        </div>
        {adding && (
          <Editor evidence={evidence} onDone={() => setAdding(false)} />
        )}
        {!requests.length && !adding && (
          <p className="ev-empty">No evidence requests.</p>
        )}
        {requests.map((request) => (
          <Request key={request.id} evidence={evidence} request={request} />
        ))}
      </section>
    );
  }
  window.EvidenceRequests = Requests;
})();
