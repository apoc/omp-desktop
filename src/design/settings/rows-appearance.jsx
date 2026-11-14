/* ═════════════════════════════════════════════════════════════════════
   design/settings/rows-appearance.jsx — custom Settings row of Appearance
   (window.OMP_SETTINGS_ROWS):
     projectAppearance  the rendered tab's project palette: a theme and/or
                        accent that wins over the global pair while that
                        project's tab is active (`app/project-appearance.js`)
   The row frame and controls are settings/controls.jsx's.
   ═════════════════════════════════════════════════════════════════════ */

/** The rendered tab's project, null with no tab (EMPTY_PROJECT has no path). */
function _SRP_Project({ row, ctx, query, modified }) {
  const { SettingsRow: Row, SettingsSeg: Seg, AccentSwatches, SettingsButton: Button } = window;
  const { t, setTweak, activeProject } = ctx;
  const { THEMES, ACCENTS, themeAccent } = window.OMP_SETTINGS;
  const { basename } = window.OMP_PROJECT_NAV;
  const path = activeProject?.path ?? "";
  const override = window.OMP_PROJECT_APPEARANCE.forProject(t.projectAppearance, path);
  if (!path) {
    return (
      <Row label={row.label} desc={row.desc} query={query}>
        <span className="st-projapp-name">{OMP_TR("Open a tab to give its project its own colours.")}</span>
      </Row>
    );
  }
  const appearance = window.OMP_PROJECT_APPEARANCE.resolve(t, path);
  const update = patch => setTweak("projectAppearance", window.OMP_PROJECT_APPEARANCE.set(t.projectAppearance, path, patch));
  const clear = () => setTweak("projectAppearance", window.OMP_PROJECT_APPEARANCE.clear(t.projectAppearance, path));
  const themeOptions = [{ value: "", label: OMP_TR("Global") }, ...THEMES.map(th => ({ value: th.id, label: th.id }))];
  return (
    <Row stack label={row.label} desc={row.desc} query={query} modified={modified}
      aside={override ? <Button onClick={clear}>{OMP_TR("Use global")}</Button> : null}>
      <div className="st-projapp">
        <span className="st-projapp-name" title={path}>{basename(path)}</span>
        <Seg label={row.label} value={override?.theme ?? ""} options={themeOptions}
          onChange={v => update({ theme: v || undefined })} />
        <AccentSwatches value={appearance.accent} themeAccent={themeAccent(appearance.theme)} colors={ACCENTS}
          onChange={c => update({ accent: c })} />
      </div>
    </Row>
  );
}

Object.assign(window.OMP_SETTINGS_ROWS = window.OMP_SETTINGS_ROWS || {}, {
  projectAppearance: _SRP_Project,
});
