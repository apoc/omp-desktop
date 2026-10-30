/* ═════════════════════════════════════════════════════════════════════
   design/settings/rows-session.jsx — Settings → Session's native keep-awake
   default and `version` rows (window.OMP_SETTINGS_ROWS). The version row
   shows the running app and last update check (ctx.updater), "Check now"
   (a manual check: opens the update modal, as the tab-bar label does), and
   the release skipped from that modal (`skippedUpdate`) with "Clear", so
   the tab-bar pill offers it again.
   ═════════════════════════════════════════════════════════════════════ */

/** What the last check found, as a short phrase ("" before any). */
function _SRS_phase(state) {
  switch (state.phase) {
    case "checking": return "checking…";
    case "uptodate": return "up to date";
    case "available": return state.update ? `\`${state.update.version}\` available` : "";
    case "downloading": return "downloading the update…";
    case "restarting": return "restarting…";
    case "error": return "the last check failed";
    default: return "";
  }
}

// The schema desc is search text only: the shown desc is the runtime state.
function _SRS_Version({ row, ctx, query }) {
  const { SettingsRow: Row, SettingsButton: Button, Icon } = window;
  const { updater } = ctx;
  const skipped = ctx.t.skippedUpdate ?? null;
  const phase = _SRS_phase(updater.state);
  const desc = [
    `OMP Desktop \`${updater.version ?? "…"}\``,
    phase,
    skipped ? `skipped \`${skipped}\`` : "",
  ].filter(Boolean).join(" · ");
  return (
    <Row label={row.label} desc={desc} query={query}>
      <div className="st-btns">
        {skipped && (
          <Button onClick={updater.clearSkipped} title={`offer ${skipped} again`}>Clear skipped</Button>
        )}
        <Button onClick={updater.check} disabled={window.OMP_UPDATER.isBusy(updater.state)}>
          <Icon name="refresh" size={11} />Check now
        </Button>
      </div>
    </Row>
  );
}

function _SRS_KeepAwake({ row, ctx, query }) {
  const { SettingsRow: Row, SettingsToggle: Toggle } = window;
  const awake = ctx.keepAwake;
  const snapshot = awake.snapshot;
  return (
    <Row stack label={row.label} desc={row.desc} query={query}
      resettable={!!snapshot?.defaultEnabled && !awake.defaultPending}
      onReset={() => awake.setDefault(false)}>
      <div className="keep-awake-settings">
        <Toggle label={row.label} value={snapshot?.defaultEnabled}
          disabled={!snapshot || awake.defaultPending} onChange={awake.setDefault} />
        <span>{snapshot ? (snapshot.defaultEnabled ? "On" : "Off") : awake.defaultError ? "Unavailable" : "Loading…"}</span>
      </div>
      {awake.defaultError && <div className="keep-awake-error" role="alert">{awake.defaultError}</div>}
    </Row>
  );
}

Object.assign(window.OMP_SETTINGS_ROWS = window.OMP_SETTINGS_ROWS || {}, {
  version: _SRS_Version, keepAwake: _SRS_KeepAwake,
});
