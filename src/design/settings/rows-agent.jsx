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
     autoCompaction  omp's auto-compaction (`compaction.enabled` and a
     autoRetry       non-empty `compaction.methodOrder`) and `retry.enabled`
                     in the same profile's config, through
                     app/use-omp-setting.jsx's useOmpSetting
                     (omp_setting_get/set); omp's config watcher applies a
                     change to the profile's running tabs
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
    hint: p.id === DEFAULT_PROFILE_ID ? OMP_TR("built-in") : "",
    path: "",
    value: p.id,
    checked: p.id === current,
  }));
  const save = async (id) => {
    setError(null);
    const res = await ctx.onSetStartupProfile(id);
    if (!res?.ok) setError(res?.error ?? OMP_TR("the profile could not be saved"));
  };
  return (
    <Row label={row.label} desc={row.desc} query={query}
      resettable={current !== DEFAULT_PROFILE_ID} onReset={() => save(DEFAULT_PROFILE_ID)}>
      <PathPicker name="startup profile" label={_SRA_profileName(ctx, current)} title={current}
        rows={rows} disabled={rows.length === 0} error={error} save={save} />
    </Row>
  );
}

/** A switch that owns one of omp's own booleans for the goal row's profile
 *  (no desktop copy, no RPC frame). `useValue(bridge, profileId)` is the
 *  hook the value comes from (`{value, busy, error, set}`); every such row
 *  shares the scope sentence, loading and error states of the goal row. */
function _SRA_OmpSwitch({ row, ctx, query, useValue }) {
  const { SettingsRow: Row, SettingsToggle: Toggle } = window;
  const profileId = ctx.goal?.profileId ?? null;
  const cont = useValue(ctx.bridge, profileId);
  const name = profileId ? _SRA_profileName(ctx, profileId) : null;
  const scope = name ? OMP_TR(" Applies to profile “{name}” (omp's config); its running tabs pick it up without a restart.", { name }) : "";
  let control;
  if (cont.value !== null) {
    control = <Toggle value={cont.value} label={row.label} onChange={v => { if (!cont.busy) cont.set(v); }} />;
  } else {
    control = <span className="st-ro">{cont.error ? OMP_TR("unavailable") : OMP_TR("reading…")}</span>;
  }
  return (
    <>
      <Row label={row.label} query={query} desc={`${window.OMP_I18N.t(row.desc)}${scope}`}>
        {control}
      </Row>
      {cont.error && <div className="st-row-error">{cont.error}</div>}
    </>
  );
}

function _SRA_GoalContinue(props) {
  return <_SRA_OmpSwitch {...props} useValue={(bridge, profileId) => window.useGoalContinuation(bridge, profileId, true)} />;
}

function _SRA_AutoCompaction(props) {
  return <_SRA_OmpSwitch {...props} useValue={(bridge, profileId) => window.useOmpSetting(bridge, "autoCompaction", profileId, true)} />;
}

function _SRA_AutoRetry(props) {
  return <_SRA_OmpSwitch {...props} useValue={(bridge, profileId) => window.useOmpSetting(bridge, "autoRetry", profileId, true)} />;
}

Object.assign(window.OMP_SETTINGS_ROWS = window.OMP_SETTINGS_ROWS || {}, {
  startupProfile: _SRA_StartupProfile,
  goalContinue: _SRA_GoalContinue,
  autoCompaction: _SRA_AutoCompaction,
  autoRetry: _SRA_AutoRetry,
});
