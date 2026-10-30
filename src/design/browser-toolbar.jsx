/* browser-toolbar.jsx — the browser panel's tab strip and control bar
   (browser-panel.jsx renders it). `ui` is app/use-browser.jsx's result.
   Page tabs wear the project tab bar's look (`.tab`, `.tab-name`,
   `.tab-close`; layout/chrome.css), sized down for the panel in
   layout/browser.css, which also styles the `+` (`.tab-add`). The name is
   a button so the keyboard reaches it. */

const { Icon: _BT_Icon, OMP_BROWSER: _BT } = window;

function BrowserTabs({ ui }) {
  return (
    <div className="browser-tabs">
      <div className="browser-tabs-scroll">
        {ui.tabs.map((t) => {
          const name = t.title || t.url || "new tab";
          return (
            <div key={t.targetId} className={`tab${t.active ? " active" : ""}`} title={t.url || name}
              onClick={() => ui.activateTab(t.targetId)}>
              <button type="button" className="tab-name" aria-current={t.active ? "page" : undefined}>{name}</button>
              <button type="button" className="tab-close" aria-label={`close ${name}`}
                onClick={(e) => { e.stopPropagation(); ui.closeTab(t.targetId); }}>
                <_BT_Icon name="close" size={9} />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="tab-add" title="new tab" aria-label="new tab" onClick={() => ui.newTab()}>
        <_BT_Icon name="plus" size={11} />
      </button>
    </div>
  );
}

function BrowserToolbar({ ui }) {
  const { state } = ui;
  const [draft, setDraft] = React.useState(null); // null = show the page's address
  const [shake, setShake] = React.useState(false);
  const submit = (e) => {
    e.preventDefault();
    const url = _BT.normalizeUrl(draft ?? state.url);
    if (!url) { setShake(true); return; }
    setDraft(null);
    ui.navigate(url);
    e.currentTarget.elements.address.blur();
  };
  const onKeyDown = (e) => {
    // Escape that ends an IME composition belongs to the IME.
    if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
    // Stopped here: the window keymap would abort a running turn on Escape.
    e.preventDefault();
    e.stopPropagation();
    setDraft(null);
    e.currentTarget.blur();
  };
  return (
    <>
      <BrowserTabs ui={ui} />
      <div className="browser-bar">
        <button className="btn icon ghost" title="back" aria-label="back" disabled={!state.canBack} onClick={() => ui.history(-1)}>
          <_BT_Icon name="back" size={11} />
        </button>
        <button className="btn icon ghost" title="forward" aria-label="forward" disabled={!state.canForward} onClick={() => ui.history(1)}>
          <_BT_Icon name="arrow" size={11} />
        </button>
        <button className="btn icon ghost" title="reload" aria-label="reload" disabled={!state.url} onClick={() => ui.navigate(state.url)}>
          <_BT_Icon name="refresh" size={11} />
        </button>
        <form className={`browser-address${shake ? " shake" : ""}`} onSubmit={submit} onAnimationEnd={() => setShake(false)}>
          <input
            name="address"
            className="mono"
            value={draft ?? state.url}
            placeholder="address or localhost:3000"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={() => setDraft(null)}
            onKeyDown={onKeyDown}
          />
        </form>
      </div>
    </>
  );
}

Object.assign(window, { BrowserToolbar });
