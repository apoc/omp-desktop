/* ═════════════════════════════════════════════════════════════════════
   design/settings/rows-layout.jsx — custom Settings rows of Layout and
   Rail (window.OMP_SETTINGS_ROWS):
     widths   the saved column widths (sidebar/rail/tree/split/browser,
              `default` while a column has none) and "Reset all widths"
              (usePaneWidths' `reset`, the browser panel's width included)
     widgets  one switch per enabled widget plugin (`widget:<id>` tweaks via
              ctx.widgetTweakKey), one per extension widget toggle
              (ctx.extToggles), then widgets.json's path and "Reload widgets"
   The row frame and controls are settings/controls.jsx's.
   ═════════════════════════════════════════════════════════════════════ */

// What a column-width tweak of 0 shows; 0 = the column's default, for the
// browser half the stage (OMP_BROWSER.clampWidth).
const _SRL_WIDTH_DEFAULT = { browserWidth: "½ stage" };

// The schema row's `keys` are the width tweaks, in display order;
// `modified` / `onReset` come from the page.
function _SRL_Widths({ row, ctx, query, modified, onReset }) {
  const { SettingsRow: Row, SettingsButton: Button } = window;
  const { t } = ctx;
  return (
    <Row stack label={row.label} desc={row.desc} query={query} modified={modified} onReset={onReset}
      aside={<Button onClick={ctx.panes.reset} disabled={!modified}>Reset all widths</Button>}>
      <div className="st-widths">
        {row.keys.map(key => {
          const px = t[key] ?? 0;
          return (
            <div key={key} className="st-width">
              <small>{key.replace(/Width$/, "")}</small>
              <b>
                {px > 0 ? <>{Math.round(px)}<i> px</i></> : <span className="st-width-def">{_SRL_WIDTH_DEFAULT[key] ?? "default"}</span>}
                {px > 0 && <span className="st-moddot" title="Changed from default" />}
              </b>
            </div>
          );
        })}
      </div>
    </Row>
  );
}

/** One on-by-default switch row for tweak `key`. */
function _SRL_Switch({ tweak, label, desc, ctx, query }) {
  const { SettingsRow: Row, SettingsToggle: Toggle } = window;
  const on = ctx.t[tweak] ?? true;
  return (
    <Row label={label} desc={desc} query={query} modified={!on} onReset={() => ctx.setTweak(tweak, true)}>
      <Toggle value={on} label={label} onChange={v => ctx.setTweak(tweak, v)} />
    </Row>
  );
}

function _SRL_Widgets({ row, ctx, query }) {
  const { SettingsRow: Row, SettingsButton: Button, Icon } = window;
  const { widgets } = ctx;
  return (
    <>
      {widgets.togglePlugins.map(p => (
        <_SRL_Switch key={p.id} tweak={ctx.widgetTweakKey(p.id)} label={p.title} ctx={ctx} query={query}
          desc={`Plugin \`${(p.command ?? []).join(" ")}\` · ${p.scope === "global" ? "one card for all tabs" : "per tab"}.`} />
      ))}
      {ctx.extToggles.map(r => (
        <_SRL_Switch key={r.tweak} tweak={r.tweak} label={r.label} ctx={ctx} query={query}
          desc="A widget an omp extension shows in this rail." />
      ))}
      <Row stack label={row.label} desc={row.desc} query={query}
        aside={(
          <Button onClick={widgets.reload}>
            <Icon name="refresh" size={11} />Reload widgets
          </Button>
        )}>
        <div className="st-path">
          <Icon name="file" size={11} />
          <span className="st-path-text">{widgets.configPath ?? "unavailable"}</span>
        </div>
      </Row>
    </>
  );
}

function _SRL_RailOrder({ row, ctx, query, modified, onReset }) {
  const { SettingsRow: Row, AmbientCardList } = window;
  return (
    <Row stack label={row.label} desc={row.desc} query={query} modified={modified} onReset={onReset}>
      <AmbientCardList items={ctx.ambientItems} tweaks={ctx.t} onChange={ctx.setTweak} visibility={false} />
    </Row>
  );
}

Object.assign(window.OMP_SETTINGS_ROWS = window.OMP_SETTINGS_ROWS || {}, {
  widths: _SRL_Widths,
  widgets: _SRL_Widgets,
  railOrder: _SRL_RailOrder,
});
