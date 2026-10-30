/* Shared presets are edited independently of the active conversation snapshot. */
(function () {
  const {
    EvidenceField: Field,
    EvidenceError: Error,
    useEvidenceAction: useAction,
  } = window;
  function copyPreset(preset, name) {
    return {
      name: name ?? preset?.name ?? "",
      planningPrompt: preset?.planningPrompt || "",
      collectionPrompt: preset?.collectionPrompt || "",
      assessmentPrompt: preset?.assessmentPrompt || "",
      triggers: {
        beforeWork: !!preset?.triggers?.beforeWork,
        afterChanges: !!preset?.triggers?.afterChanges,
        beforeHandoff: !!preset?.triggers?.beforeHandoff,
      },
      tracking: preset?.tracking ?? true,
      handoff: preset?.handoff || "advisory",
    };
  }
  function Presets({ evidence }) {
    const library = evidence.library;
    const [selected, setSelected] = React.useState("standard");
    const [drafts, setDrafts] = React.useState({});
    const [notice, setNotice] = React.useState("");
    const counter = React.useRef(0);
    const action = useAction();
    const presets = library?.presets || [];
    const stored = presets.find((p) => p.id === selected);
    const draft = drafts[selected] || (stored ? copyPreset(stored) : null);
    const isNew = selected.startsWith("new:");
    const active = evidence.view?.policy;
    const activeLibrary = presets.find((p) => p.id === active?.preset?.id);
    const update =
      activeLibrary && activeLibrary.revision > active.preset.revision;
    React.useEffect(() => {
      evidence.loadLibrary().catch(() => {});
    }, [evidence.projectPath]);
    const change = (key, value) => {
      setNotice("");
      setDrafts((old) => ({
        ...old,
        [selected]: { ...(old[selected] || copyPreset(stored)), [key]: value },
      }));
    };
    const trigger = (key, value) =>
      change("triggers", { ...draft.triggers, [key]: value });
    const create = (source) => {
      const key = `new:${++counter.current}`;
      setDrafts((old) => ({
        ...old,
        [key]: copyPreset(
          source,
          source ? `${source.name} copy` : "New preset",
        ),
      }));
      setSelected(key);
      setNotice("");
    };
    const save = (asNew) => {
      if (!draft) return;
      const input = { ...draft, ...(!isNew && !asNew ? { id: selected } : {}) };
      action.run(
        () => evidence.savePreset(input),
        (value) => {
          if (value?.id) {
            setDrafts((old) => {
              const next = { ...old };
              delete next[selected];
              delete next[value.id];
              return next;
            });
            setSelected(value.id);
          }
          setNotice(
            "Preset saved. Active conversations keep their current snapshot until applied.",
          );
        },
      );
    };
    return (
      <section className="ev-stack">
        <div className="ev-section-head">
          <div>
            <h2>Prompt presets</h2>
            <p>
              Library defaults affect new conversations. Changes never silently
              replace the active policy.
            </p>
          </div>
          <button
            className="btn ghost"
            disabled={action.busy}
            onClick={() => action.run(() => evidence.loadLibrary())}
          >
            Refresh library
          </button>
        </div>
        {evidence.libraryError && <Error error={evidence.libraryError} />}
        {library?.warning && <p className="ev-note">{library.warning}</p>}
        <div className="ev-policy">
          <strong>Active: {active?.preset?.name || "Unavailable"}</strong>
          <span className="ev-meta">
            {active
              ? `${active.source} · revision ${active.preset?.revision}`
              : "No active policy snapshot"}
          </span>
          {evidence.view?.policyPinned === false && (
            <p className="ev-error" role="alert">
              This policy snapshot is not saved durably yet.{" "}
              {evidence.view.policyPersistenceError ||
                "Refresh to retry before relying on it after a restart."}
            </p>
          )}
          {update && (
            <>
              <p className="ev-note">
                Update available: library revision {activeLibrary.revision}.
                Your active policy remains unchanged.
              </p>
              <button
                className="btn"
                disabled={action.busy}
                onClick={() =>
                  action.run(
                    () => evidence.applyPreset(activeLibrary, "conversation"),
                    () =>
                      setNotice("Updated preset applied to this conversation."),
                  )
                }
              >
                Apply update to conversation
              </button>
            </>
          )}
        </div>
        {!library ? (
          <p className="ev-empty">
            Preset library unavailable. Refresh to try again.
          </p>
        ) : (
          <>
            <p className="ev-meta ev-break">
              Source project:{" "}
              {library.project || evidence.projectPath || "none"} · global
              default: {library.globalDefault || "Standard"} · project default:{" "}
              {library.projectDefault || "inherit"}
            </p>
            <Field label="Preset">
              <select
                value={selected}
                disabled={action.busy}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setNotice("");
                }}
              >
                {presets.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name} · rev {p.revision}
                  </option>
                ))}
                {Object.keys(drafts)
                  .filter((k) => k.startsWith("new:"))
                  .map((k) => (
                    <option key={k} value={k}>
                      {drafts[k].name || "New preset"} (unsaved)
                    </option>
                  ))}
              </select>
            </Field>
            <div className="ev-actions">
              <button
                className="btn ghost"
                disabled={action.busy}
                onClick={() => create(null)}
              >
                New
              </button>
              <button
                className="btn ghost"
                disabled={action.busy || !draft}
                onClick={() => create(draft)}
              >
                Duplicate
              </button>
              <button
                className="btn ghost"
                disabled={action.busy || !stored || stored.id === "standard"}
                onClick={() =>
                  action.run(
                    () => evidence.deletePreset(stored.id),
                    () => {
                      setSelected("standard");
                      setNotice("Preset deleted.");
                    },
                  )
                }
              >
                Delete
              </button>
            </div>
            {draft && (
              <fieldset
                className="ev-form"
                disabled={action.busy || selected === "standard"}
              >
                {selected === "standard" && (
                  <p className="ev-note">
                    Standard is built in. Duplicate it to make changes.
                  </p>
                )}
                <Field label="Name">
                  <input
                    value={draft.name}
                    onChange={(e) => change("name", e.target.value)}
                    maxLength="120"
                  />
                </Field>
                <Field label="Planning prompt">
                  <textarea
                    value={draft.planningPrompt}
                    onChange={(e) => change("planningPrompt", e.target.value)}
                    rows="4"
                  />
                </Field>
                <Field label="Collection prompt">
                  <textarea
                    value={draft.collectionPrompt}
                    onChange={(e) => change("collectionPrompt", e.target.value)}
                    rows="4"
                  />
                </Field>
                <Field label="Assessment prompt">
                  <textarea
                    value={draft.assessmentPrompt}
                    onChange={(e) => change("assessmentPrompt", e.target.value)}
                    rows="4"
                  />
                </Field>
                <div className="ev-options">
                  <span>Triggers</span>
                  {[
                    ["beforeWork", "Before work"],
                    ["afterChanges", "After changes"],
                    ["beforeHandoff", "Before handoff"],
                  ].map(([key, label]) => (
                    <label className="ev-check" key={key}>
                      <input
                        type="checkbox"
                        checked={draft.triggers[key]}
                        onChange={(e) => trigger(key, e.target.checked)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <label className="ev-check">
                  <input
                    type="checkbox"
                    checked={draft.tracking}
                    onChange={(e) => change("tracking", e.target.checked)}
                  />{" "}
                  Enable collection by default
                </label>
                <Field label="Handoff">
                  <select
                    value={draft.handoff}
                    onChange={(e) => change("handoff", e.target.value)}
                  >
                    <option value="advisory">Advisory only</option>
                    <option value="remind">One bounded follow-up</option>
                  </select>
                </Field>
                <div className="ev-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => save(false)}
                  >
                    Save preset
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => save(true)}
                  >
                    Save as new preset
                  </button>
                </div>
              </fieldset>
            )}
            <p className="ev-note">
              The actions below use the saved preset, not unsaved edits.
            </p>
            <div className="ev-actions">
              <button
                className="btn"
                disabled={action.busy || !stored}
                onClick={() =>
                  action.run(
                    () => evidence.applyPreset(stored, "conversation"),
                    () => setNotice("Preset applied to this conversation."),
                  )
                }
              >
                Use for this conversation
              </button>
              <button
                className="btn ghost"
                disabled={action.busy || !stored || !library.project}
                onClick={() =>
                  action.run(
                    () => evidence.assignPreset("project", stored.id),
                    () => setNotice("Project default updated."),
                  )
                }
              >
                Set project default
              </button>
              <button
                className="btn ghost"
                disabled={action.busy || !stored}
                onClick={() =>
                  action.run(
                    () => evidence.assignPreset("global", stored.id),
                    () => setNotice("Global default updated."),
                  )
                }
              >
                Set global default
              </button>
              <button
                className="btn ghost"
                disabled={action.busy}
                onClick={() =>
                  action.run(
                    () => evidence.useInheritedPreset(),
                    () =>
                      setNotice(
                        "Inherited policy applied to this conversation.",
                      ),
                  )
                }
              >
                Use inherited default
              </button>
              <button
                className="btn ghost"
                disabled={action.busy || !library.project}
                onClick={() =>
                  action.run(
                    () => evidence.assignPreset("project", null),
                    () => setNotice("Project now inherits its default."),
                  )
                }
              >
                Clear project default
              </button>
              <button
                className="btn ghost"
                disabled={action.busy}
                onClick={() =>
                  action.run(
                    () => evidence.assignPreset("global", null),
                    () => setNotice("Global default reset to Standard."),
                  )
                }
              >
                Clear global default
              </button>
            </div>
          </>
        )}
        <Error error={action.error} />
        {notice && (
          <p className="ev-note" role="status">
            {notice}
          </p>
        )}
      </section>
    );
  }
  window.EvidencePresets = Presets;
})();
