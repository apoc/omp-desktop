/* app/use-omp-setting.jsx — one boolean of omp's own config for Settings →
   Agent (#92), read and written through the bridge, never kept in the
   desktop:

   - `useOmpFlag(bridge, profileId, active, ops)` is the generic hook:
     `ops` is `{ read(bridge, profile), write(bridge, profile, enabled) }`,
     each a `{ok, value | error}` promise. app/use-goal-mode.jsx builds the
     goal row's `useGoalContinuation` on it (read at call time).
   - `useOmpSetting(bridge, setting, profileId, active)` is the hook of
     the two switches `setting` names: `autoCompaction` or `autoRetry`
     (src-tauri omp_config.rs `BoolSetting`; the bridge's `ompSetting` /
     `setOmpSetting`, commands `omp_setting_get` / `_set`).

   Both return `{ value, busy, error, set }` (see `_UOS_useFlag`). The
   rows that render them are design/settings/rows-agent.jsx, which reads
   `window.useOmpSetting` and `window.useGoalContinuation` at render time. */

/** The two bridge calls behind one omp switch, for `setting` (`autoCompaction`
 *  or `autoRetry`). Module-level objects, so the hook can key its fetch on
 *  them. */
const _UOS_opsFor = setting => ({
  read: (bridge, profile) => bridge.ompSetting(profile, setting),
  write: (bridge, profile, enabled) => bridge.setOmpSetting(profile, setting, enabled),
});
const _UOS_OPS = { autoCompaction: _UOS_opsFor("autoCompaction"), autoRetry: _UOS_opsFor("autoRetry") };

/** One boolean of omp's own config for `profileId`, read and written by
 *  `ops`, fetched while `active` and refetched whenever that turns on again
 *  or the profile changes — the user may edit omp's config by hand
 *  meanwhile. Per profile, not per tab: a switch between tabs of one
 *  profile does not run `omp config` again. A reply for a profile left
 *  meanwhile is never shown; omp's reason for a failed read or write is. */
function _UOS_useFlag(bridge, profileId, active, ops) {
  // `forProfile` tags the whole record.
  const [st, setSt] = React.useState({ forProfile: null, value: null, error: null, busy: false });
  const reqRef = React.useRef(0);
  React.useEffect(() => {
    if (!active || !bridge || !profileId) return;
    const my = ++reqRef.current;
    ops.read(bridge, profileId).then(res => {
      if (reqRef.current !== my) return;
      setSt({
        forProfile: profileId,
        value: res?.ok ? res.value === true : null,
        error: res?.ok ? null : res?.error ?? "could not read omp's setting",
        busy: false,
      });
    });
  }, [bridge, profileId, active, ops]);
  // Only reachable while the value is known for `profileId` (the switch is
  // disabled otherwise), so `forProfile` already names the target.
  const set = async enabled => {
    const my = ++reqRef.current;
    setSt(s => ({ ...s, busy: true, error: null }));
    const res = await ops.write(bridge, profileId, enabled);
    if (reqRef.current !== my) return;
    setSt(s => (res?.ok
      ? { ...s, value: res.value === true, busy: false }
      : { ...s, busy: false, error: res?.error ?? "could not change the setting" }));
  };
  const mine = st.forProfile === profileId;
  return { value: mine ? st.value : null, busy: mine && st.busy, error: mine ? st.error : null, set };
}

/** omp's `compaction.enabled` (with a non-empty method order) or
 *  `retry.enabled` for Settings → Agent. */
const _UOS_useOmpSetting = (bridge, setting, profileId, active) => _UOS_useFlag(bridge, profileId, active, _UOS_OPS[setting]);

Object.assign(window, { useOmpFlag: _UOS_useFlag, useOmpSetting: _UOS_useOmpSetting });
