/* Outcome and acceptance-criterion editing. */
(function () {
  const {
    EvidenceField: Field,
    EvidenceKindSelect: Kind,
    EvidenceError: Error,
    EvidenceStatus: Status,
    useEvidenceAction: useAction,
  } = window;

  function OutcomeEditor({ evidence, outcome, onDone }) {
    const [title, setTitle] = React.useState(outcome?.title || "");
    const [description, setDescription] = React.useState(
      outcome?.description || "",
    );
    const [refs, setRefs] = React.useState(
      (outcome?.todoRefs || []).join("\n"),
    );
    const action = useAction();
    const save = (e) => {
      e.preventDefault();
      action.run(
        () =>
          evidence.mutate({
            op: "outcome",
            outcome: {
              ...(outcome ? { id: outcome.id } : {}),
              title,
              description,
              todoRefs: refs
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            },
          }),
        onDone,
      );
    };
    return (
      <form className="ev-form" onSubmit={save}>
        <fieldset className="ev-fields" disabled={action.busy}>
          <Field label="Outcome">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={500}
            />
          </Field>
          <Field label="Description (optional)">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows="2"
            />
          </Field>
          <Field label="Todo links (optional, one text reference per line)">
            <textarea
              value={refs}
              onChange={(e) => setRefs(e.target.value)}
              rows="2"
            />
          </Field>
          <Error error={action.error} />
          <div className="ev-actions">
            <button className="btn" disabled={action.busy}>
              Save outcome
            </button>
            <button type="button" className="btn ghost" onClick={onDone}>
              Cancel
            </button>
          </div>
        </fieldset>
      </form>
    );
  }
  function RequirementEditor({ evidence, outcome, requirement, onDone }) {
    const [text, setText] = React.useState(requirement?.text || "");
    const [kind, setKind] = React.useState(requirement?.kind || "any");
    const [required, setRequired] = React.useState(
      requirement?.required ?? true,
    );
    const action = useAction();
    const save = (e) => {
      e.preventDefault();
      action.run(
        () =>
          evidence.mutate({
            op: "requirement",
            outcomeId: outcome.id,
            requirement: {
              ...(requirement ? { id: requirement.id } : {}),
              text,
              kind,
              required,
            },
          }),
        onDone,
      );
    };
    return (
      <form className="ev-form" onSubmit={save}>
        <fieldset className="ev-fields" disabled={action.busy}>
          <Field label="Acceptance criterion">
            <textarea
              required
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows="2"
            />
          </Field>
          <Field label="Evidence type">
            <Kind value={kind} onChange={setKind} />
          </Field>
          <label className="ev-check">
            <input
              type="checkbox"
              checked={required}
              onChange={(e) => setRequired(e.target.checked)}
            />{" "}
            Required / pinned
          </label>
          <Error error={action.error} />
          <div className="ev-actions">
            <button className="btn" disabled={action.busy}>
              Save criterion
            </button>
            <button type="button" className="btn ghost" onClick={onDone}>
              Cancel
            </button>
          </div>
        </fieldset>
      </form>
    );
  }
  function Criterion({ evidence, outcome, requirement }) {
    const [editing, setEditing] = React.useState(false);
    const [waiving, setWaiving] = React.useState(false);
    const [reason, setReason] = React.useState("");
    const action = useAction();
    const status = window.OMP_EVIDENCE_MODEL.requirementStatus(
      evidence.view,
      outcome,
      requirement,
    );
    return (
      <div className="ev-criterion">
        <div className="ev-row">
          <strong>{requirement.text}</strong>
          <Status status={status} />
        </div>
        <div className="ev-meta">
          {requirement.kind} · {requirement.required ? "required" : "optional"}{" "}
          · created by {requirement.author} · controlled by{" "}
          {requirement.owner || requirement.author} · revision{" "}
          {requirement.revision}
          {requirement.retired ? " · retired" : ""}
        </div>
        {status.reason && <p className="ev-note">{status.reason}</p>}
        {requirement.waiver && (
          <p className="ev-note">Waived by user: {requirement.waiver.reason}</p>
        )}
        {editing ? (
          <RequirementEditor
            evidence={evidence}
            outcome={outcome}
            requirement={requirement}
            onDone={() => setEditing(false)}
          />
        ) : (
          !requirement.retired && (
            <div className="ev-actions">
              <button className="btn ghost" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button
                className="btn ghost"
                disabled={action.busy}
                onClick={() =>
                  action.run(() =>
                    evidence.mutate({
                      op: "retire",
                      outcomeId: outcome.id,
                      requirementId: requirement.id,
                    }),
                  )
                }
              >
                Retire
              </button>
              {requirement.waiver ? (
                <button
                  className="btn ghost"
                  disabled={action.busy}
                  onClick={() =>
                    action.run(() =>
                      evidence.mutate({
                        op: "unwaive",
                        outcomeId: outcome.id,
                        requirementId: requirement.id,
                      }),
                    )
                  }
                >
                  Remove waiver
                </button>
              ) : (
                <button
                  className="btn ghost"
                  disabled={action.busy}
                  onClick={() => setWaiving(!waiving)}
                >
                  Waive
                </button>
              )}
            </div>
          )
        )}
        {waiving && !requirement.waiver && (
          <form
            className="ev-form"
            onSubmit={(e) => {
              e.preventDefault();
              action.run(
                () =>
                  evidence.mutate({
                    op: "waive",
                    outcomeId: outcome.id,
                    requirementId: requirement.id,
                    reason,
                  }),
                () => {
                  setReason("");
                  setWaiving(false);
                },
              );
            }}
          >
            <Field label="Reason for waiver">
              <textarea
                required
                disabled={action.busy}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows="2"
              />
            </Field>
            <button className="btn" disabled={action.busy}>
              Confirm waiver
            </button>
          </form>
        )}
        <Error error={action.error} />
      </div>
    );
  }
  function Outcome({ evidence, outcome }) {
    const [editing, setEditing] = React.useState(false);
    const [adding, setAdding] = React.useState(false);
    const action = useAction();
    return (
      <article className="ev-outcome">
        {editing ? (
          <OutcomeEditor
            evidence={evidence}
            outcome={outcome}
            onDone={() => setEditing(false)}
          />
        ) : (
          <>
            <div className="ev-row">
              <h3>{outcome.title}</h3>
              <span className="ev-meta">
                created by {outcome.author} · controlled by{" "}
                {outcome.owner || outcome.author}
                {outcome.retired ? " · retired" : ""}
              </span>
            </div>
            {outcome.description && <p>{outcome.description}</p>}
            {!!outcome.todoRefs?.length && (
              <p className="ev-meta">
                Todo references: {outcome.todoRefs.join(" · ")}
              </p>
            )}
            {!outcome.retired && (
              <div className="ev-actions">
                <button className="btn ghost" onClick={() => setEditing(true)}>
                  Edit outcome
                </button>
                <button
                  className="btn ghost"
                  disabled={action.busy}
                  onClick={() =>
                    action.run(() =>
                      evidence.mutate({ op: "retire", outcomeId: outcome.id }),
                    )
                  }
                >
                  Retire outcome
                </button>
                <button className="btn ghost" onClick={() => setAdding(true)}>
                  Add criterion
                </button>
              </div>
            )}
          </>
        )}
        <Error error={action.error} />
        {(outcome.requirements || []).map((requirement) => (
          <Criterion
            key={requirement.id}
            evidence={evidence}
            outcome={outcome}
            requirement={requirement}
          />
        ))}
        {adding && (
          <RequirementEditor
            evidence={evidence}
            outcome={outcome}
            onDone={() => setAdding(false)}
          />
        )}
      </article>
    );
  }
  function Outcomes({ evidence }) {
    const [adding, setAdding] = React.useState(false);
    const outcomes = evidence.view?.outcomes || [];
    return (
      <section className="ev-stack">
        <div className="ev-section-head">
          <div>
            <h2>Outcomes & criteria</h2>
            <p>
              Define what this change needs to prove. Pinned criteria remain
              user-owned.
            </p>
          </div>
          <button className="btn" onClick={() => setAdding(true)}>
            Add outcome
          </button>
        </div>
        {adding && (
          <OutcomeEditor evidence={evidence} onDone={() => setAdding(false)} />
        )}
        {!outcomes.length && !adding && (
          <p className="ev-empty">
            No outcomes yet. Add one, then define the evidence it needs.
          </p>
        )}
        {outcomes.map((outcome) => (
          <Outcome key={outcome.id} evidence={evidence} outcome={outcome} />
        ))}
      </section>
    );
  }
  window.EvidenceOutcomes = Outcomes;
})();
