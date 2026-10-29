/* ═════════════════════════════════════════════════════════════════════
   design/settings/rows-agent.jsx — custom Settings rows of Agent
   (window.OMP_SETTINGS_ROWS):
     startupProfile  the profile of the tab opened at launch and of new tabs
                     with none to inherit from (Rust's `profiles.json`,
                     ctx.onSetStartupProfile → OMP_BRIDGE.setStartupProfile);
                     the reason a pick was refused shows under the menu
     goalContinue    omp's goal auto-continue (`goal.continuationModes`
                     holds "rpc") in omp's config of ctx.goal.profileId,
                     read and written through app/use-goal-mode.jsx's
                     useGoalContinuation (goal_continuation_get/set)
   ═════════════════════════════════════════════════════════════════════ */

function _SRA_profileName(ctx, id) {
  return ctx.profiles.find(p => p.id === id)?.name ?? id;
}

function _SRA_StartupProfile({ row, ctx, query }) {
  const { SettingsRow: Row, PathPicker, DEFAULT_PROFILE_ID } = window;
  const [error, setError] = React.useState(null);
  const current = ctx.startupProfileId;
  const rows = ctx.profiles.map(p => ({
    name: p.name,
    hint: p.id === DEFAULT_PROFILE_ID ? "built-in" : "",
    path: "",
    value: p.id,
    checked: p.id === current,
  }));
  const save = async (id) => {
    setError(null);
    const res = await ctx.onSetStartupProfile(id);
    if (!res?.ok) setError(res?.error ?? "the profile could not be saved");
  };
  return (
    <Row label={row.label} desc={row.desc} query={query}
      resettable={current !== DEFAULT_PROFILE_ID} onReset={() => save(DEFAULT_PROFILE_ID)}>
      <PathPicker name="startup profile" label={_SRA_profileName(ctx, current)} title={current}
        rows={rows} disabled={rows.length === 0} error={error} save={save} />
    </Row>
  );
}

function _SRA_GoalContinue({ row, ctx, query }) {
  const { SettingsRow: Row, SettingsToggle: Toggle } = window;
  const profileId = ctx.goal?.profileId ?? null;
  const cont = window.useGoalContinuation(ctx.bridge, profileId, true);
  const name = profileId ? _SRA_profileName(ctx, profileId) : null;
  const scope = name ? ` Applies to profile “${name}” (omp's config); its running tabs pick it up without a restart.` : "";
  let control;
  if (cont.value !== null) {
    control = <Toggle value={cont.value} label={row.label} onChange={v => { if (!cont.busy) cont.set(v); }} />;
  } else {
    control = <span className="st-ro">{cont.error ? "unavailable" : "reading…"}</span>;
  }
  return (
    <>
      <Row label={row.label} query={query} desc={`${row.desc}${scope}`}>
        {control}
      </Row>
      {cont.error && <div className="st-row-error">{cont.error}</div>}
    </>
  );
}

function _SRA_ContextPolicy({ row, ctx, query }) {
  const { SettingsRow: Row, ContextPolicyEditor: Editor } = window;
  return (
    <>
      <Row label={row.label} desc={row.desc} query={query} />
      <div className="st-context-policy"><Editor key={`${ctx.activeProject.id}:${ctx.activeProject.profile}`} {...ctx.contextPolicy} /></div>
    </>
  );
}

Object.assign(window.OMP_SETTINGS_ROWS = window.OMP_SETTINGS_ROWS || {}, {
  startupProfile: _SRA_StartupProfile,
  goalContinue: _SRA_GoalContinue,
  contextPolicy: _SRA_ContextPolicy,
});
