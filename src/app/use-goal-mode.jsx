/* app/use-goal-mode.jsx — the composer's goal mode for app-live.jsx: one
   goal-mode entry per tab (`{mode, budget, error?}`, app/goal.js
   GOAL_DRAFT_IDLE), kept in React like plan mode (#28) since omp never sees
   it; what blocks it and what it blocks (app/goal.js `composerGate`); the
   send that starts a goal; omp's auto-continue setting for the tab's
   profile; and the goal strip the composer renders (design/goal-strip.jsx).

   `goal` is the active tab's `{known, goal}` from the bridge snapshot;
   `runState` its run state (app/turn-status.js). `onRestoreDraft(text,
   images)` puts an objective omp refused, with its images, back into the
   composer of the tab it was typed in. */

const { GoalStrip: _UG_GoalStrip } = window;
const { entryOf: _UG_entryOf, updateEntry: _UG_updateEntry, pruneEntries: _UG_pruneEntries } = window.OMP_SESSION_UI;
const {
  GOAL_DRAFT_IDLE: _UG_IDLE, toggleGoalDraft: _UG_toggle, enterGoalDraft: _UG_enter, withBudget: _UG_withBudget,
  composerGate: _UG_gate, isOpen: _UG_isOpen,
} = window.OMP_GOAL;
const { isBusyRunState: _UG_isBusy } = window.OMP_TURN_STATUS;

/** omp's auto-continue setting (`goal.continuationModes` holds "rpc") for
 *  `profileId`, fetched while `active` (goal mode on, or a goal shown) and
 *  refetched whenever that turns on again or the profile changes — the user
 *  may edit omp's config by hand meanwhile. Per profile, not per tab: a
 *  switch between tabs of one profile does not run `omp config` again. A
 *  reply for a profile left meanwhile is never shown; omp's reason for a
 *  failed read or write is. */
function _UG_useContinuation(bridge, profileId, active) {
  // `forProfile` tags the whole record.
  const [st, setSt] = React.useState({ forProfile: null, value: null, error: null, busy: false });
  const reqRef = React.useRef(0);
  React.useEffect(() => {
    if (!active || !bridge || !profileId) return;
    const my = ++reqRef.current;
    bridge.goalContinuation(profileId).then(res => {
      if (reqRef.current !== my) return;
      setSt({
        forProfile: profileId,
        value: res?.ok ? res.value === true : null,
        error: res?.ok ? null : res?.error ?? "could not read omp's setting",
        busy: false,
      });
    });
  }, [bridge, profileId, active]);
  // Only reachable while the value is known for `profileId` (the switch is
  // disabled otherwise), so `forProfile` already names the target.
  const set = async enabled => {
    const my = ++reqRef.current;
    setSt(s => ({ ...s, busy: true, error: null }));
    const res = await bridge.setGoalContinuation(profileId, enabled);
    if (reqRef.current !== my) return;
    setSt(s => (res?.ok
      ? { ...s, value: res.value === true, busy: false }
      : { ...s, busy: false, error: res?.error ?? "could not change the setting" }));
  };
  const mine = st.forProfile === profileId;
  return { value: mine ? st.value : null, busy: mine && st.busy, error: mine ? st.error : null, set };
}

function useGoalMode({ bridge, tabId, sessionIds, goal, planMode, profileId, runState, onRestoreDraft }) {
  const [drafts, setDrafts] = React.useState({});
  React.useEffect(() => { setDrafts(m => _UG_pruneEntries(m, sessionIds)); }, [sessionIds]);
  // Read when a start resolves: a tab closed meanwhile gets no entry back,
  // and only the tab still shown gets its objective back in the composer.
  const idsRef = React.useRef(sessionIds);
  idsRef.current = sessionIds;
  const tabRef = React.useRef(tabId);
  tabRef.current = tabId;
  const update = (id, fn) => setDrafts(m => (id && idsRef.current?.includes(id) ? _UG_updateEntry(m, id, _UG_IDLE, fn) : m));

  // A goal the tab already has makes its goal-mode draft moot (a start
  // whose reply came back late, or the agent's own `goal create`): drop it,
  // with any stale error, instead of bringing it back once that goal ends.
  const openGoalId = _UG_isOpen(goal) ? goal.goal.id : null;
  React.useEffect(() => {
    if (openGoalId) update(tabId, d => (d === _UG_IDLE ? d : _UG_IDLE));
  }, [tabId, openGoalId]);

  const draft = _UG_entryOf(drafts, tabId, _UG_IDLE);
  const { mode, goalBlocked, planBlocked, tint } = _UG_gate(draft, goal, planMode);
  const shown = mode || !!goal?.goal;
  const cont = _UG_useContinuation(bridge, profileId, shown);

  const toggle = () => { if (mode || !goalBlocked) update(tabId, _UG_toggle); };
  const enter = () => { if (!goalBlocked) update(tabId, _UG_enter); };

  /** The goal-mode send: `goal create` plus, when omp does not start on
   *  its own, the objective as the first prompt (OMP_BRIDGE.goalStart).
   *  Leaves goal mode on success; on a refusal keeps it, shows omp's
   *  reason in the strip and hands the objective back. */
  const start = async (text, images) => {
    const id = tabId;
    const budget = draft.budget;
    update(id, d => (d.error ? { ...d, error: null } : d));
    const res = await bridge?.goalStart(text, budget, images);
    if (res?.ok) {
      update(id, () => _UG_IDLE);
      return;
    }
    update(id, d => ({ ...d, mode: true, error: res?.error ?? "Could not start the goal." }));
    if (tabRef.current === id) onRestoreDraft?.(text, images);
  };

  const strip = tabId && shown ? (
    // Keyed apart from the composer's other per-tab children (PasteStrip
    // uses the bare tab id): a duplicate key makes React clone the strip.
    <_UG_GoalStrip key={`goal-${tabId}`} bridge={bridge} tabGoal={goal} draft={draft} drafting={mode} cont={cont}
      busy={_UG_isBusy(runState)}
      onExitDraft={() => update(tabId, () => _UG_IDLE)}
      onBudget={n => update(tabId, d => ({ ..._UG_withBudget(d, n), error: null }))} />
  ) : null;

  return { mode, tint, goalBlocked, planBlocked, toggle, enter, start, strip };
}

Object.assign(window, { useGoalMode });
