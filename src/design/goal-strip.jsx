/* goal-strip.jsx — omp's goal mode above the composer (app/goal.js).
   Two faces, one tab at a time (the composer keys it by tab):
   - goal mode in the composer (the goal pill, `/goal`): the next send
     becomes the goal; pick a token budget;
   - the tab's goal: status, objective, tokens against the budget, time,
     pause / resume / drop (drop asks first), dismiss once complete, and
     why omp is waiting when an active goal sits idle.
   Both carry the auto-continue switch: omp's `goal.continuationModes`
   setting for the tab's profile (`cont`, app/use-goal-mode.jsx), read and
   written through omp's own config CLI (src-tauri goal_config.rs). */

const { Icon: _GS_Icon } = window;
const {
  stripView: _GS_stripView,
  BUDGET_PRESETS: _GS_PRESETS, budgetLabel: _GS_budgetLabel, parseBudget: _GS_parseBudget,
} = window.OMP_GOAL;

function _GS_Switch({ cont }) {
  const on = cont.value === true;
  const known = cont.value !== null;
  // Unknown: still loading ("…"), or omp could not be asked ("?"; the
  // reason shows in the strip's error line).
  const label = known ? (on ? "on" : "off") : cont.error ? "?" : "…";
  return (
    <button type="button" className="goal-switch" role="switch" aria-checked={on}
      disabled={cont.busy || !known}
      title="omp's goal.continuationModes setting for this profile. On: omp keeps working on an active goal between turns by itself."
      onClick={() => cont.set(!on)}>
      auto-continue <span className={`goal-toggle${on ? " on" : ""}`} /> {label}
    </button>
  );
}

function _GS_Budget({ budget, onBudget }) {
  // null: closed; a string: the custom input's text.
  const [custom, setCustom] = React.useState(null);
  const [bad, setBad] = React.useState(false);
  const preset = budget == null || _GS_PRESETS.includes(budget);
  const commit = () => {
    const r = _GS_parseBudget(custom);
    if (!r.ok) { setBad(true); return; }
    setBad(false);
    setCustom(null);
    onBudget(r.value);
  };
  return (
    <>
      <span className="goal-budget-label">token budget</span>
      <button type="button" className={`goal-opt${budget == null ? " on" : ""}`} aria-pressed={budget == null} onClick={() => onBudget(null)}>no limit</button>
      {_GS_PRESETS.map(n => (
        <button type="button" key={n} className={`goal-opt${budget === n ? " on" : ""}`} aria-pressed={budget === n} onClick={() => onBudget(n)}>{_GS_budgetLabel(n)}</button>
      ))}
      {custom === null ? (
        <button type="button" className={`goal-opt${preset ? "" : " on"}`} aria-pressed={!preset}
          onClick={() => { setCustom(preset ? "" : String(budget)); setBad(false); }}>
          {preset ? "custom…" : _GS_budgetLabel(budget)}
        </button>
      ) : (
        <input className={`goal-budget-input mono${bad ? " bad" : ""}`} autoFocus value={custom} placeholder="e.g. 300k"
          aria-label="custom token budget"
          onChange={e => { setCustom(e.target.value); setBad(false); }}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            // Stopped here: the window keymap would abort a running turn on Escape.
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setCustom(null); setBad(false); }
          }}
          // Leaving an empty field keeps the chosen budget; "no limit" has
          // its own button.
          onBlur={() => { if (custom.trim()) commit(); else { setCustom(null); setBad(false); } }} />
      )}
      {bad && <span className="goal-error-inline">a whole number of tokens, like 300k</span>}
    </>
  );
}

function _GS_Draft({ draft, cont, onExit, onBudget }) {
  return (
    <div className="goal-strip">
      <div className="goal-head">
        <_GS_Icon name="goal" size={12} color="var(--lilac)" />
        <span className="goal-name">goal mode</span>
        <span className="goal-sub">· your message becomes the goal; the agent works toward it until it calls it done</span>
        <div className="goal-spacer" />
        <button type="button" className="btn ghost" onClick={onExit}>exit</button>
      </div>
      <div className="goal-line goal-budget">
        <_GS_Budget budget={draft.budget} onBudget={onBudget} />
        <div className="goal-spacer" />
        <_GS_Switch cont={cont} />
      </div>
      {(draft.error || cont.error) && <div className="goal-error">{draft.error ?? cont.error}</div>}
    </div>
  );
}

const _GS_WAITING = {
  off: "omp continues a goal by itself only with auto-continue on.",
  // Idle with auto-continue on: the last goal turn made no new progress,
  // or the setting was only just turned on. Either way omp decides again
  // when the next turn ends.
  stopped: "omp picks the goal up again by itself once your next message is answered.",
  unknown: "",
};

function _GS_Status({ bridge, tabGoal, busy, cont }) {
  const view = _GS_stripView(tabGoal, { busy, continuation: cont.value });
  const [pending, setPending] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [confirmDrop, setConfirmDrop] = React.useState(false);
  // A new goal or status ends whatever the previous one had open.
  const key = `${tabGoal.goal.id}:${tabGoal.goal.status}`;
  React.useEffect(() => { setPending(null); setError(null); setConfirmDrop(false); }, [key]);

  const run = async op => {
    setPending(op);
    setError(null);
    const res = await bridge.goalOp(op);
    setPending(null);
    if (op === "drop") setConfirmDrop(false);
    if (!res?.ok) setError(res?.error ?? `could not ${op} the goal`);
  };
  const act = a => {
    if (a === "dismiss") bridge.goalDismiss();
    else if (a === "drop") setConfirmDrop(true);
    else run(a);
  };
  const { meter } = view;
  const switchInWaiting = view.waiting === "off";
  return (
    <div className="goal-strip">
      <div className="goal-head">
        <_GS_Icon name="goal" size={12} color="var(--lilac)" />
        <span className="goal-name">goal</span>
        <span className={`goal-chip ${view.tone}`}>{view.chip}</span>
        <span className="goal-obj selectable" title={view.objective}>{view.objective}</span>
        {view.sub && <span className="goal-sub">· {view.sub}</span>}
        <div className="goal-actions">
          {view.actions.map(a => (
            <button type="button" key={a} className={a === "resume" ? "btn outlined goal-resume" : "btn ghost"}
              disabled={pending !== null || (a === "drop" && confirmDrop)} onClick={() => act(a)}>
              {pending === a ? `${a}…` : a}
            </button>
          ))}
        </div>
      </div>
      <div className="goal-meter">
        {meter.pct != null && <div className={`goal-bar ${view.tone}`}><span style={{ width: `${meter.pct}%` }} /></div>}
        <span>
          {meter.used}{meter.budget ? ` / ${meter.budget} tokens` : " tokens · no budget"}
          {meter.left ? ` · ${meter.left} left` : ""}
          {meter.over ? ` · ${meter.over} over budget` : ""}
        </span>
        <span>· {meter.time}</span>
        {view.tone !== "done" && !switchInWaiting && <><div className="goal-spacer" /><_GS_Switch cont={cont} /></>}
      </div>
      {view.waiting && (
        <div className="goal-line">
          <span className="goal-note"><b>Waiting for your next message.</b> {_GS_WAITING[view.waiting]}</span>
          {switchInWaiting && <_GS_Switch cont={cont} />}
          {switchInWaiting && (
            <button type="button" className="btn outlined goal-resume" disabled={cont.busy || cont.value === null}
              onClick={() => cont.set(true)}>turn on</button>
          )}
        </div>
      )}
      {confirmDrop && (
        <div className="goal-line">
          <span className="goal-note">Drop this goal? Its token usage stays in the session log.</span>
          <button type="button" className="btn outlined goal-drop" disabled={pending !== null} onClick={() => run("drop")}>
            {pending === "drop" ? "dropping…" : "drop goal"}
          </button>
          <button type="button" className="btn ghost" disabled={pending !== null} onClick={() => setConfirmDrop(false)}>keep</button>
        </div>
      )}
      {(error || cont.error) && <div className="goal-error">{error ?? cont.error}</div>}
    </div>
  );
}

/** False while `busy`, and for `ms` after it last was or after a goal
 *  turned active (`activeId`: the id of an active goal, else null): omp
 *  leaves a gap of a few milliseconds between two goal turns it runs on its
 *  own, and starts the first turn of a goal it just created or resumed a
 *  round trip later — neither may flash the "waiting for you" line. */
function _GS_useSettled(busy, ms, activeId) {
  const [settled, setSettled] = React.useState(!busy);
  const activeRef = React.useRef(activeId);
  // Read in render too, so the frame that brings the new goal hides the line.
  const fresh = activeId != null && activeRef.current !== activeId;
  React.useEffect(() => {
    activeRef.current = activeId;
    if (busy || fresh) setSettled(false);
    if (busy) return undefined;
    const timer = setTimeout(() => setSettled(true), ms);
    return () => clearTimeout(timer);
  }, [busy, ms, activeId]);
  return settled && !busy && !fresh;
}

/** `tabGoal`: the tab's `{known, goal}`; `draft`: its goal-mode composer
 *  state (`{mode, budget, error?}`); `drafting`: goal mode is on
 *  (app/goal.js `composerGate`); `cont`: the auto-continue setting; `busy`:
 *  the tab is running, retrying or waiting on a background job. Mounted
 *  only while there is something to show. */
function GoalStrip({ bridge, tabGoal, draft, drafting, cont, busy, onExitDraft, onBudget }) {
  const g = tabGoal?.goal;
  const settled = _GS_useSettled(!!busy, 800, g?.status === "active" ? g.id : null);
  if (drafting) return <_GS_Draft draft={draft} cont={cont} onExit={onExitDraft} onBudget={onBudget} />;
  if (!tabGoal?.goal) return null;
  return <_GS_Status bridge={bridge} tabGoal={tabGoal} busy={!settled} cont={cont} />;
}

Object.assign(window, { GoalStrip });
