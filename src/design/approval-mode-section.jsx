/* ═════════════════════════════════════════════════════════════════════
   approval-mode-section.jsx — the tool approval mode editor (#57), one
   component shown in both the approvals panel (approval-rules-panel.jsx)
   and Settings → Approvals (settings/rows-approvals.jsx): omp's
   `--approval-mode` default for every project, one row per project (the
   active tab's folder first, then every other override, each with
   inherit/always ask/write/yolo and a remove button), the mode the active
   tab resolves to with its description, and what the last change did to
   the open tabs. Backed by OMP_BRIDGE.setApprovalModeProject /
   setApprovalModeDefault (Rust `approval_mode.rs` stores the choice;
   live.js restarts the tabs it changes with `--resume`, idle ones at once
   and busy ones when their turn ends). Pure helpers: app/approval-mode.js
   (read late-bound).
   ═════════════════════════════════════════════════════════════════════ */

const { Icon: _AMS_Icon } = window;

// One segmented radio group. `options`: [{ value, label }]; the literal
// "default" value renders as the muted `inherit` segment.
function ApprovalModeSeg({ label, options, value, disabled, onPick }) {
  return (
    <div className="mode-seg" role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          data-mode={o.value === "default" ? "inherit" : o.value}
          disabled={disabled}
          onClick={() => { if (o.value !== value) onPick(o.value); }}
        >
          {OMP_TR(o.label)}
        </button>
      ))}
    </div>
  );
}

// What the last change did: `result` is a set's `{ ok, error?, restarted,
// deferred }`, null before any change in this editor.
function ApprovalModeApplyLine({ result, busy, hasProject, sessions }) {
  if (busy) return <div className="mode-apply"><span className="spin">⟳</span> {OMP_TR("restarting…")}</div>;
  if (!result) {
    return (
      <div className="mode-apply">
        {hasProject
          ? OMP_TR("A change restarts omp in that project's open tabs; the conversation continues. A tab whose agent is working switches when its turn ends.")
          : OMP_TR("Applies to new tabs and to open tabs of projects without their own setting.")}
      </div>
    );
  }
  if (!result.ok) return <div className="mode-apply error">{result.error || OMP_TR("the change could not be saved")}</div>;
  const n = result.restarted.length;
  const names = result.deferred
    .map(id => sessions.find(s => s.id === id)?.name)
    .filter(Boolean);
  return (
    <div className="mode-apply">
      {n > 0 && <><span className="spin">⟳</span>{window.OMP_I18N.plural(n, "{n} tab", "{n} tabs", { n })} {OMP_TR("restarted with the new mode.")}</>}
      {n === 0 && names.length === 0 && OMP_TR("Saved. No open tab needed a restart.")}
      {names.length > 0 && (
        <>
          {n > 0 && " "}
          <b>{names.join(", ")}</b>
          {names.length === 1 ? OMP_TR(" is working and switches when its turn ends.") : OMP_TR(" are working and switch when their turns end.")}
        </>
      )}
    </div>
  );
}

/** `view` is the bridge snapshot's `approvalModes`, `activeProject` the
 *  rendered tab's entry (null with no tab), `query` the Settings search
 *  (highlights project paths; absent in the panel). */
function ApprovalModeSection({ view, activeProject, sessions, query }) {
  const bridge = window.OMP_BRIDGE;
  const AM = window.OMP_APPROVAL_MODE;
  const Mark = window.SettingsMark;
  const [busy, setBusy]     = React.useState(false);
  const [result, setResult] = React.useState(null);

  const path = activeProject?.path || null;
  const projects = AM.projectRows(view, path);
  const fallback = AM.effectiveFor(view, null); // the global default
  const effective = AM.effectiveFor(view, path);
  const shown = AM.MODES.find(m => m.value === effective);
  const modeOptions = AM.MODES.map(m => ({ value: m.value, label: m.label }));
  const projectOptions = [{ value: "default", label: "inherit" }, ...modeOptions];
  const disabled = busy || !view;

  const apply = async call => {
    if (!bridge || busy) return;
    setBusy(true);
    try {
      setResult(await call());
    } finally {
      setBusy(false);
    }
  };
  const setProject = (p, v) => apply(() => bridge.setApprovalModeProject(p, v === "default" ? null : v));
  const pathText = p => (Mark && query ? <Mark text={p} query={query} /> : p);

  return (
    <div className="mode-sect">
      <div className="mode-row">
        <div className="mode-lbl"><span>{OMP_TR("default for every project")}</span></div>
        <ApprovalModeSeg
          label={OMP_TR("default for every project")}
          options={modeOptions}
          value={fallback}
          disabled={disabled}
          onPick={v => apply(() => bridge.setApprovalModeDefault(v))}
        />
        <span className="mode-rm" aria-hidden="true" />
      </div>
      {projects.map(p => (
        <div className="mode-row" key={p.path}>
          <div className="mode-lbl">
            <span>{p.active ? "this project" : "project"}</span>
            <span className="mode-path mono" title={p.path}>{pathText(p.path)}</span>
          </div>
          <ApprovalModeSeg
            label={p.path}
            options={projectOptions}
            value={p.value}
            disabled={disabled}
            onPick={v => setProject(p.path, v)}
          />
          {p.value === "default"
            ? <span className="mode-rm" aria-hidden="true" />
            : (
              <button className="btn icon ghost mode-rm" disabled={disabled}
                title={OMP_TR("remove the override (inherit the default)")} aria-label={OMP_TR("remove the override of {path}", { path: p.path })}
                onClick={() => setProject(p.path, "default")}>
                <_AMS_Icon name="close" size={10} />
              </button>
            )}
        </div>
      ))}
      {shown && (
        <div className={`mode-note${shown.warn ? " warn" : ""}`}>
          {path ? OMP_TR("this project:") : OMP_TR("new tabs:")}<b>{OMP_TR(shown.label)}</b> — {OMP_TR(shown.blurb)}
        </div>
      )}
      <ApprovalModeApplyLine result={result} busy={busy} hasProject={projects.length > 0} sessions={sessions ?? []} />
    </div>
  );
}

window.ApprovalModeSection = ApprovalModeSection;
