/* browser-toolbar.jsx — the browser panel's tab strip and control bar
   (browser-panel.jsx renders it). `ui` is app/use-browser.jsx's result. */

const { Icon: _BT_Icon, OMP_BROWSER: _BT } = window;

function BrowserTabs({ ui }) {
  return (
    <div className="browser-tabs">
      <div className="browser-tabs-scroll">
        {ui.tabs.map((t) => (
          <div key={t.targetId} className={`browser-tab${t.active ? " active" : ""}`} title={t.url}>
            <button className="browser-tab-title" onClick={() => ui.activateTab(t.targetId)}>
              {t.title || t.url || "new tab"}
            </button>
            <button className="browser-tab-close" aria-label="close tab" onClick={() => ui.closeTab(t.targetId)}>
              <_BT_Icon name="close" size={9} />
            </button>
          </div>
        ))}
      </div>
      <button className="btn icon ghost" title="new tab" aria-label="new tab" onClick={() => ui.newTab()}>
        <_BT_Icon name="plus" size={11} />
      </button>
    </div>
  );
}

function BrowserToolbar({ ui, onClose }) {
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
    if (e.key !== "Escape") return;
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
        <button className={`btn icon ghost${ui.annotate ? " active" : ""}`} title="annotate" aria-label="annotate" aria-pressed={ui.annotate} disabled={state.status !== "running"} onClick={() => ui.setAnnotate(!ui.annotate)}>
          <_BT_Icon name="edit" size={11} />
        </button>
        <button className={`btn icon ghost${ui.fullView ? " active" : ""}`} title="full view" aria-label="full view" aria-pressed={ui.fullView} onClick={() => ui.setFullView(!ui.fullView)}>
          <_BT_Icon name="focus" size={11} />
        </button>
        <button className="btn icon ghost" title="close browser" aria-label="close browser" onClick={onClose}>
          <_BT_Icon name="close" size={11} />
        </button>
      </div>
    </>
  );
}

Object.assign(window, { BrowserToolbar });
