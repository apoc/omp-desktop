/* ═════════════════════════════════════════════════════════════════════
   design/settings/rows-session.jsx — Settings → Session's custom `version`
   row (window.OMP_SETTINGS_ROWS): the running app version and what the
   last update check found (ctx.updater, app/use-updater.jsx), "Check now"
   (a manual check: opens the update modal, as the status-bar version label does), and
   the release skipped from that modal (`skippedUpdate`) with "Clear", so
   the status-bar pill offers it again.
   ═════════════════════════════════════════════════════════════════════ */

/** What the last check found, as a short phrase ("" before any). */
function _SRS_phase(state) {
  switch (state.phase) {
    case "checking": return OMP_TR("checking…");
    case "uptodate": return OMP_TR("up to date");
    case "available": return state.update ? OMP_TR("`{version}` available", { version: state.update.version }) : "";
    case "downloading": return OMP_TR("downloading the update…");
    case "restarting": return OMP_TR("restarting…");
    case "error": return OMP_TR("the last check failed");
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
    skipped ? `${OMP_TR("skipped")} \`${skipped}\`` : "",
  ].filter(Boolean).join(" · ");
  return (
    <Row label={row.label} desc={desc} query={query}>
      <div className="st-btns">
        {skipped && (
          <Button onClick={updater.clearSkipped} title={OMP_TR("offer {version} again", { version: skipped })}>{OMP_TR("Clear skipped")}</Button>
        )}
        <Button onClick={updater.check} disabled={window.OMP_UPDATER.isBusy(updater.state)}>
          <Icon name="refresh" size={11} />{OMP_TR("Check now")}
        </Button>
      </div>
    </Row>
  );
}

Object.assign(window.OMP_SETTINGS_ROWS = window.OMP_SETTINGS_ROWS || {}, { version: _SRS_Version });
