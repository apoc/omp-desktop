/* ═════════════════════════════════════════════════════════════════════
   settings/controls.jsx — building blocks of the Settings page (#37):
   the row frame, its controls, theme cards, accent swatches and the
   section strip. Custom rows (settings/rows-*.jsx) build on the same
   frame and controls, so every row looks and behaves alike.

   Text from the schema is highlighted by splitting it into text nodes and
   <mark> elements; `backtick` segments of a description render as <code>.
   No HTML strings are ever injected.
   ═════════════════════════════════════════════════════════════════════ */

const { Icon: _ST_Icon } = window;

const _ST_escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` with every case-insensitive occurrence of `query` in <mark>. */
function SettingsMark({ text, query }) {
  const q = (query ?? "").trim();
  if (!q || !text) return text ?? null;
  // A capturing split puts the matches at the odd indices.
  const parts = String(text).split(new RegExp(`(${_ST_escapeRe(q)})`, "i"));
  return parts.map((p, i) => (i % 2 ? <mark className="st-mark" key={i}>{p}</mark> : p));
}

/** A schema description: `backtick` segments as <code>, all highlighted. */
function SettingsDesc({ text, query }) {
  return String(text ?? "").split("`").map((p, i) => (i % 2
    ? <code key={i}><SettingsMark text={p} query={query} /></code>
    : <React.Fragment key={i}><SettingsMark text={p} query={query} /></React.Fragment>));
}

/** One setting: label (+ changed dot and reset), description, control.
 *  `stack` puts `children` full-width under the label line, `aside` then
 *  sits at the end of that line. String label/desc are highlighted.
 *  `resettable`: off its default but not counted in the badges (a
 *  Rust-backed row): the reset shows without the changed dot. */
function SettingsRow({ label, desc, modified, resettable, onReset, stack, aside, className = "", crumb, query, children }) {
  // Flash the row once it is reset, as feedback for a click on a control
  // that vanishes with the change.
  const [flash, setFlash] = React.useState(false);
  const reset = () => { setFlash(true); onReset(); };
  const head = (
    <div className="st-rt">
      <div className="st-rl">
        {typeof label === "string" ? <SettingsMark text={label} query={query} /> : label}
        {modified && <span className="st-moddot" title="Changed from default" />}
        {(modified || resettable) && onReset && (
          <button type="button" className="st-reset" onClick={reset} title="Reset to default">↺ reset</button>
        )}
      </div>
      {desc != null && desc !== "" && (
        <div className="st-rd">
          {crumb && <span className="st-crumb">{crumb} · </span>}
          {typeof desc === "string" ? <SettingsDesc text={desc} query={query} /> : desc}
        </div>
      )}
    </div>
  );
  const cls = `st-row${stack ? " stack" : ""}${flash ? " flash" : ""}${className ? ` ${className}` : ""}`;
  return (
    <div className={cls} onAnimationEnd={() => setFlash(false)}>
      {stack ? <div className="st-rhead">{head}{aside}</div> : head}
      {children}
    </div>
  );
}

function SettingsToggle({ value, onChange, label }) {
  return (
    <button type="button" className="st-tgl" role="switch" aria-checked={!!value} aria-label={label}
      onClick={() => onChange(!value)} />
  );
}

/** Segmented choice; `options` [{ value, label }]. */
function SettingsSeg({ value, options, onChange, label }) {
  return (
    <div className="st-seg" role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button type="button" key={String(o.value)} role="radio" aria-checked={o.value === value}
          onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Range input. Shows the value while dragging, commits on release (pointer,
 *  key or blur) so a drag is one change, not one per pixel. */
function SettingsSlider({ value, min, max, step = 1, unit = "", onChange, label }) {
  const [draft, setDraft] = React.useState(null);
  const shown = draft ?? value;
  const commit = () => {
    if (draft === null) return;
    if (draft !== value) onChange(draft);
    setDraft(null);
  };
  return (
    <div className="st-slider">
      <input type="range" min={min} max={max} step={step} value={shown} aria-label={label}
        onChange={e => setDraft(Number(e.target.value))}
        onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
      <span className="st-val">{shown}{unit}</span>
    </div>
  );
}

function SettingsButton({ children, onClick, accent, disabled, title }) {
  return (
    <button type="button" className={`st-btn${accent ? " ac" : ""}`} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

/** Theme picker: each card carries `theme-<id>`, which scopes that theme's
 *  tokens (styles.css) to the card, so it previews itself. */
function ThemeCards({ value, themes, onChange }) {
  return (
    <div className="st-themes" role="radiogroup" aria-label="Theme">
      {themes.map(th => (
        <button type="button" key={th.id} className={`st-th theme-${th.id}`} role="radio"
          aria-checked={value === th.id} onClick={() => onChange(th.id)}>
          <div className="st-pv">
            <div className="st-pv-s"><i className="a" /><i /><i /><i /></div>
            <div className="st-pv-c"><i className="me" /><i style={{ width: "80%" }} /><i className="cd" /><i style={{ width: "60%" }} /></div>
          </div>
          <div className="st-nm"><span className="st-radio" />{th.id}<small>{th.tone}</small></div>
        </button>
      ))}
    </div>
  );
}

/** Start screen picker: one tile per screen, each a live preview of it
 *  (design/backdrops/backdrop.jsx, logo off) in the current theme, paused
 *  while the page is hidden behind a project tab. */
function ScreenCards({ value, screens, paused, onChange }) {
  const { Backdrop } = window;
  return (
    <div className="st-themes" role="radiogroup" aria-label="Start screen">
      {screens.map(s => (
        <button type="button" key={s.value} className="st-th" role="radio"
          aria-checked={value === s.value} onClick={() => onChange(s.value)}>
          <div className="st-pv st-pv-live"><Backdrop screen={s.value} logo={false} paused={paused} /></div>
          <div className="st-nm"><span className="st-radio" />{s.label}<small>{s.blurb}</small></div>
        </button>
      ))}
    </div>
  );
}

/** Accent: the theme's own (pill) or one of the swatches. */
function AccentSwatches({ value, themeAccent, colors, onChange }) {
  const { sameColor } = window.OMP_ACCENT;
  const own = sameColor(value, themeAccent);
  return (
    <div className="st-sw" role="radiogroup" aria-label="Accent">
      <button type="button" className="st-sw-theme" role="radio" aria-checked={own}
        onClick={() => onChange(themeAccent)}>theme</button>
      {colors.map(c => (
        <button type="button" key={c} role="radio" aria-checked={!own && sameColor(value, c)}
          aria-label={c} title={c} style={{ background: c }} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}

/** Icon strip of the sections. `counts[id]`: changed rows, or matches while
 *  `searching` (sections without a match dim). */
function SettingsStrip({ sections, active, counts, searching, onSelect }) {
  return (
    <div className="st-tabs" role="tablist" aria-label="Settings sections">
      {sections.map(s => {
        const n = counts[s.id] ?? 0;
        const selected = !searching && active === s.id;
        return (
          <React.Fragment key={s.id}>
            {s.sep && <span className="st-sep" />}
            <button type="button" role="tab" aria-selected={selected} tabIndex={selected || (searching && s === sections[0]) ? 0 : -1}
              className={`st-tab${searching && !n ? " dim" : ""}`} title={s.title} onClick={() => onSelect(s.id)}>
              <_ST_Icon name={s.icon} size={16} />
              <span className="st-tab-lbl">{s.title}</span>
              {n > 0 && (
                <span className={`st-badge${searching ? "" : " mod"}`}
                  title={searching ? `${n} matching` : `${n} changed from default`}>{n}</span>
              )}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}

Object.assign(window, {
  SettingsMark, SettingsDesc, SettingsRow, SettingsToggle, SettingsSeg, SettingsSlider, SettingsButton,
  ThemeCards, ScreenCards, AccentSwatches, SettingsStrip,
});
