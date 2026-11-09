/* ═════════════════════════════════════════════════════════════════════
   design/settings/rows-programs.jsx — custom Settings rows of Terminal and
   Browser (window.OMP_SETTINGS_ROWS):
     shell           the shell new terminals run (Rust's `terminal.json`,
                     read with `terminalSettings` each time the row mounts):
                     `default`, the shells installed here (Rust's list) and
                     "other…" (Rust's file dialog); saved with
                     `setTerminalShell`. Running terminals keep theirs.
     terminalHeight  the shared panel height (read-only; set by dragging a
                     panel's top edge)
     chromium        the browser new panels launch (Rust's `browser.json`,
                     `browserSettings`): `automatic` (hint: what detection
                     finds now), the installed browsers, the stored custom
                     path and "other…"; saved with `browserSetPath`. Rust
                     reads it at each launch.
   The setting hook and the button + menu are design/path-setting.jsx's.
   ═════════════════════════════════════════════════════════════════════ */

const _SRP_SHELL = {
  key: "terminal.shell",
  read: (bridge) => bridge.terminalSettings(),
  save: (bridge, value) => bridge.setTerminalShell(value),
  pick: (bridge) => bridge.pickTerminalShell(),
};

const _SRP_CHROMIUM = {
  key: "browser.path",
  read: (bridge) => bridge.browserSettings(),
  save: (bridge, value) => bridge.browserSetPath(value),
  pick: (bridge) => bridge.browserPickPath(),
};

function _SRP_Shell({ row, ctx, query }) {
  const { SettingsRow: Row, PathPicker, usePathSetting } = window;
  const { settings, error, save, pick } = usePathSetting(ctx.bridge, _SRP_SHELL);
  const { label, rows } = window.OMP_TERMINAL.shellMenu(settings);
  const fallback = settings?.defaultShell ? ` ${OMP_TR("Here:")} \`${settings.defaultShell}\`.` : "";
  return (
    <Row label={row.label} query={query} desc={`${window.OMP_I18N.t(row.desc)}${fallback}`}
      resettable={!!settings?.shell} onReset={() => save("")}>
      <PathPicker name="shell" label={label} rows={rows} disabled={!settings} error={error}
        title={settings ? (settings.shell || `default: ${settings.defaultShell}`) : undefined}
        save={save} pick={pick} />
    </Row>
  );
}

// `modified` / `onReset` come from the page (the schema row's `terminalHeight` key).
function _SRP_TerminalHeight({ row, ctx, query, modified, onReset }) {
  const Row = window.SettingsRow;
  return (
    <Row label={row.label} desc={row.desc} query={query}
      modified={modified} onReset={onReset}>
      <span className="st-ro">{ctx.terminalHeight} px</span>
    </Row>
  );
}

/** Tooltip: the stored path, else what `automatic` resolves to now. */
function _SRP_chromiumTitle(settings) {
  if (!settings) return undefined;
  if (settings.path) return settings.path;
  return settings.automatic
    ? OMP_TR("automatic: {name}", { name: settings.automatic })
    : OMP_TR("automatic: no Chromium-based browser found");
}

function _SRP_Chromium({ row, ctx, query }) {
  const { SettingsRow: Row, PathPicker, usePathSetting } = window;
  const { settings, error, save, pick } = usePathSetting(ctx.bridge, _SRP_CHROMIUM);
  const { label, rows } = window.OMP_BROWSER.pathMenu(settings);
  return (
    <Row label={row.label} desc={row.desc} query={query}
      resettable={!!settings?.path} onReset={() => save("")}>
      <PathPicker name="chromium" label={label} title={_SRP_chromiumTitle(settings)} rows={rows}
        disabled={!settings} error={error ?? settings?.error ?? null} save={save} pick={pick} />
    </Row>
  );
}

Object.assign(window.OMP_SETTINGS_ROWS = window.OMP_SETTINGS_ROWS || {}, {
  shell: _SRP_Shell,
  terminalHeight: _SRP_TerminalHeight,
  chromium: _SRP_Chromium,
});
