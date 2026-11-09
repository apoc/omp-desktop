/* ═════════════════════════════════════════════════════════════════════
   settings/page.jsx — the Settings page (#37), shown in the stage while
   the Settings app tab is active.

   Rows come from app/settings-schema.js (window.OMP_SETTINGS). Tweak rows
   render here; custom rows render through window.OMP_SETTINGS_ROWS[type]
   (settings/rows-*.jsx) as <Comp row ctx query modified onReset />.

   Keys while the page is active: Ctrl+F focuses the search, ←/→ switch
   sections outside text fields, Escape clears the search. Escape is
   default-prevented (capture phase) so the window keymap never sees it
   (no agent interrupt), but not stopped, so an open row menu or the
   shortcut recorder still gets it: such an element carries
   `data-st-esc` while open and handles Escape itself; Ctrl+F and the
   arrows are left to it too.
   ═════════════════════════════════════════════════════════════════════ */

const {
  Icon: _SP_Icon, SettingsRow: _SP_Row, SettingsToggle: _SP_Toggle, SettingsSeg: _SP_Seg,
  SettingsSlider: _SP_Slider, ThemeCards: _SP_ThemeCards, ScreenCards: _SP_ScreenCards, AccentSwatches: _SP_Swatches, SettingsStrip: _SP_Strip,
} = window;

const _SP_IS_MAC = window.OMP_KEYMAP?.detectMac?.() ?? false;
const _SP_FIELD = "input, textarea, select, [contenteditable='true'], [role='slider']";
// Visible strings go through the dictionary (app/i18n.js); the English
// source is the key, so a missing entry falls back to it.
const _SP_TR = (s, vars) => (typeof s === "string" ? window.OMP_I18N.t(s, vars) : s);

function _SP_TweakRow({ row, ctx, query }) {
  const S = window.OMP_SETTINGS;
  const { t, setTweak } = ctx;
  const set = v => setTweak(row.key, S.clamp(row, v));
  const frame = {
    label: row.label, desc: row.desc, query,
    modified: S.isModified(row, t), onReset: () => setTweak(S.resetRow(row, t)),
  };
  const v = S.value(row, t);
  switch (row.type) {
    case "toggle":
      return <_SP_Row {...frame}><_SP_Toggle value={v} onChange={set} label={row.label} /></_SP_Row>;
    case "seg":
      return <_SP_Row {...frame}><_SP_Seg value={v} options={row.options} onChange={set} label={row.label} /></_SP_Row>;
    case "slider":
      return (
        <_SP_Row {...frame}>
          <_SP_Slider value={v} min={row.min} max={row.max} step={row.step} unit={row.unit} onChange={set} label={row.label} />
        </_SP_Row>
      );
    case "themes":
      return (
        <_SP_Row {...frame} stack>
          <_SP_ThemeCards value={t.theme} themes={S.THEMES}
            onChange={th => { if (th !== t.theme) setTweak({ theme: th, accent: S.themeAccent(th) }); }} />
        </_SP_Row>
      );
    case "screens":
      return (
        <_SP_Row {...frame} stack>
          <_SP_ScreenCards value={v} screens={row.options} paused={ctx.active === false} onChange={set} />
        </_SP_Row>
      );
    case "swatches":
      return (
        <_SP_Row {...frame}>
          <_SP_Swatches value={t.accent} themeAccent={S.themeAccent(t.theme)} colors={S.ACCENTS}
            onChange={c => setTweak("accent", c)} />
        </_SP_Row>
      );
    default:
      return null;
  }
}

function _SP_AnyRow({ row, ctx, query }) {
  if (row.kind === "tweak") return <_SP_TweakRow row={row} ctx={ctx} query={query} />;
  const S = window.OMP_SETTINGS;
  const modified = S.isModified(row, ctx.t, ctx.keyOpts);
  const onReset = () => ctx.setTweak(S.resetRow(row, ctx.t, ctx.keyOpts));
  const Comp = window.OMP_SETTINGS_ROWS?.[row.type];
  // A renderer missing (script not loaded) still shows what the row is.
  if (!Comp) return <_SP_Row label={row.label} desc={row.desc} query={query} />;
  return <Comp row={row} ctx={ctx} query={query} modified={modified} onReset={onReset} />;
}

function _SP_Group({ name, src, rows, ctx, query }) {
  return (
    <>
      <div className="st-grp-name">
        {_SP_TR(name)}
        {src && <span className="st-src" title={_SP_TR("Saved by the app in this file, not in the window's local storage")}>{src}</span>}
      </div>
      <div className="st-grp">
        {rows.map(r => <_SP_AnyRow key={r.id} row={r} ctx={ctx} query={query} />)}
      </div>
    </>
  );
}

/** `ctx.active === false` (page kept mounted behind a project tab, keeping
 *  its search and scroll): keys are left alone. */
function SettingsPage({ ctx }) {
  window.OMP_I18N.useLocale();
  const S = window.OMP_SETTINGS;
  const { t } = ctx;
  const active = ctx.active !== false;
  const [query, setQuery] = React.useState("");
  const rootRef = React.useRef(null);
  const bodyRef = React.useRef(null);
  const searchRef = React.useRef(null);

  const sections = S.SECTIONS;
  const idx = Math.max(0, sections.findIndex(s => s.id === ctx.section));
  const section = sections[idx];
  const q = query.trim();
  const hits = React.useMemo(() => S.search(q, t), [S, q, t]);
  const counts = React.useMemo(
    () => (q ? hits.bySection : Object.fromEntries(sections.map(s => [s.id, S.modifiedCount(s.id, t, ctx.keyOpts)]))),
    [S, q, hits, sections, t, ctx.keyOpts]);
  // While searching, the footer resets the matched rows only.
  const resetEdits = React.useMemo(() => (q
    ? S.resetRows(hits.groups.flatMap(g => g.rows), t, ctx.keyOpts)
    : S.resetEdits(section.id, t, ctx.keyOpts)), [S, q, hits, section.id, t, ctx.keyOpts]);
  const canReset = Object.keys(resetEdits).length > 0;

  const closeHint = window.OMP_KEYMAP ? window.OMP_KEYMAP.hintFor("desktop.tab.close") : "Ctrl+W";
  // ctx is rebuilt every app render: the key listener reads setSection
  // through a ref so it never re-subscribes for that.
  const setSectionRef = React.useRef(ctx.setSection);
  setSectionRef.current = ctx.setSection;
  const select = React.useCallback(id => { setQuery(""); setSectionRef.current(id); }, []);

  // Opening on a section (Ctrl+/, /shortcuts) shows that section, not a
  // search left from before.
  React.useEffect(() => { setQuery(""); }, [ctx.section]);

  // A new section starts at its top; returning to the tab keeps the scroll.
  React.useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = 0; }, [section.id, q === ""]);
  // Activating the tab moves focus into the page (search field), so keys
  // never land in the composer hidden underneath.
  React.useEffect(() => { if (active) searchRef.current?.focus({ preventScroll: true }); }, [active]);

  React.useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      const root = rootRef.current;
      const target = e.target;
      // Only keys aimed at the page (or at nothing): a dialog opened on top
      // handles its own.
      if (!root || !(root.contains(target) || target === document.body || target === document.documentElement)) return;
      const mod = e.ctrlKey || e.metaKey;
      const claimed = root.querySelector("[data-st-esc]");
      if (e.key === "Escape") {
        e.preventDefault();
        if (!claimed && query) setQuery("");
        return;
      }
      if (claimed) return;
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (mod || e.altKey || e.shiftKey) return;
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !target.closest?.(_SP_FIELD)) {
        e.preventDefault();
        const n = sections.length;
        select(sections[(idx + (e.key === "ArrowRight" ? 1 : n - 1)) % n].id);
        requestAnimationFrame(() => root.querySelector('.st-tab[aria-selected="true"]')?.focus());
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, query, idx, sections, select]);

  let body;
  if (q) {
    body = (
      <>
        <div className="st-head">
          <div className="st-kicker">{window.OMP_I18N.plural(hits.total, "search · {n} setting", "search · {n} settings", { n: hits.total })}</div>
          <div className="st-h1">“{q}”</div>
        </div>
        {hits.groups.length === 0 && <div className="st-empty">{_SP_TR("No setting matches “{q}”.", { q })}</div>}
        {hits.groups.map(g => (
          <_SP_Group key={`${g.sectionId}/${g.groupName}`} name={`${_SP_TR(g.sectionTitle)} › ${_SP_TR(g.groupName)}`}
            src={g.src} rows={g.rows} ctx={ctx} query={q} />
        ))}
      </>
    );
  } else {
    body = (
      <>
        <div className="st-head">
          <div className="st-kicker">{String(idx + 1).padStart(2, "0")} · {_SP_TR(section.title)}</div>
          <div className="st-h1">{_SP_TR(section.title)}</div>
          <p className="st-blurb">{_SP_TR(section.blurb)}</p>
        </div>
        {section.groups.map(g => {
          const rows = g.rows.filter(r => S.visible(r, t));
          return rows.length ? <_SP_Group key={g.name} name={g.name} src={g.src} rows={rows} ctx={ctx} query="" /> : null;
        })}
      </>
    );
  }

  return (
    <div className="settings" role="region" aria-label={_SP_TR("Settings")} ref={rootRef}>
      <div className="st-top">
        <div className="st-inner">
          <label className="st-search">
            <_SP_Icon name="search" size={14} />
            <input ref={searchRef} type="text" placeholder={_SP_TR("Search settings")} value={query} autoComplete="off"
              spellCheck={false} aria-label={_SP_TR("Search settings")} onChange={e => setQuery(e.target.value)} />
            <span className="st-kbd">{_SP_IS_MAC ? "⌘F" : "Ctrl+F"}</span>
          </label>
          <_SP_Strip sections={sections} active={section.id} counts={counts} searching={!!q} onSelect={select} />
        </div>
      </div>
      <div className="st-body" ref={bodyRef}>
        <div className="st-inner">{body}</div>
      </div>
      <div className="st-foot">
        <div className="st-inner">
          <span>{_SP_TR("changes apply at once")}</span>
          <span className="st-sp" />
          <button type="button" disabled={!canReset} onClick={() => ctx.setTweak(resetEdits)}>
            {_SP_TR("reset {what} to defaults", { what: q ? _SP_TR("matches") : _SP_TR(section.title).toLowerCase() })}
          </button>
          <span><span className="st-kbd">←</span> <span className="st-kbd">→</span> {_SP_TR("sections")}</span>
          {closeHint && <span><span className="st-kbd">{closeHint}</span> {_SP_TR("close tab")}</span>}
        </div>
      </div>
    </div>
  );
}

// Memo: behind a project tab the page keeps one ctx, so streaming frames
// skip it.
window.SettingsPage = React.memo(SettingsPage);
