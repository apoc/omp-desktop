/* browser-panel.jsx — the browser panel (docs/architecture/browser.md):
   toolbar, the streamed page on a canvas, status overlay, the
   annotate popover and numbered markers. `ui` is app/use-browser.jsx's result;
   the canvas is painted and fed input by app/browser-screen.js through
   `ui.viewRef` / `ui.canvasRef`. Page coordinates here are CSS px of the
   shown page (`ui.page`), placed as percentages of the view. */

const { BrowserToolbar: _BP_Toolbar } = window;

const _BP_STATUS = {
  starting: "starting browser…",
  stopped: "browser stopped — reload to restart",
  error: "browser unavailable",
};

// Place a page-px point as % of the view.
const _bpPct = (v, whole) => `${(v / whole) * 100}%`;

function BrowserPopover({ pick, page, failed, onSave, onCancel }) {
  const [text, setText] = React.useState("");
  const { rect } = pick;
  // Below the picked rect, above it when that is near the bottom edge.
  const below = (rect.y + rect.h) / page.cssH < 0.7;
  const style = { left: _bpPct(Math.min(rect.x, page.cssW * 0.6), page.cssW) };
  if (below) style.top = _bpPct(rect.y + rect.h, page.cssH);
  else style.bottom = _bpPct(page.cssH - rect.y, page.cssH);
  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSave(text);
    }
  };
  return (
    <div className="browser-popover glass" style={style}>
      <div className="browser-popover-what mono">
        {pick.kind === "area" ? "area" : pick.selector || pick.tag || "element"}
      </div>
      {failed && (
        <div className="browser-popover-note">
          Screenshot failed — annotation will be sent without image
        </div>
      )}
      <textarea
        autoFocus
        rows={3}
        value={text}
        placeholder="comment — Enter saves, Shift+Enter new line, Esc cancels"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

function BrowserPanel({ ui, onClose }) {
  const { state, page, pending, chips } = ui;
  const message = state.status === "error" && state.error ? state.error : _BP_STATUS[state.status];
  const retry = state.status === "stopped" || state.status === "error";
  const marked = page ? chips.filter((c) => c.pick.url === state.url) : [];
  return (
    <section className="browser-panel" aria-label="browser">
      <_BP_Toolbar ui={ui} onClose={onClose} />
      <div className="browser-body">
        {state.loading && <div className="browser-loading" />}
        <div className={`browser-view${ui.annotate ? " annotating" : ""}`} ref={ui.viewRef} tabIndex={0}>
          <canvas className="browser-canvas" ref={ui.canvasRef} />
          {marked.map((c) => (
            <span
              key={c.id}
              className="browser-marker"
              style={{ left: _bpPct(c.pick.rect.x, page.cssW), top: _bpPct(c.pick.rect.y, page.cssH) }}
            >
              {c.n}
            </span>
          ))}
          {pending && page && (
            <BrowserPopover key={pending.pick.rect.x + ":" + pending.pick.rect.y} pick={pending.pick} page={page} failed={pending.image == null} onSave={ui.savePending} onCancel={ui.cancelPending} />
          )}
          {message && (
            <div className={`browser-status ${state.status}`}>
              <span>{message}</span>
              {retry && <button className="btn" onClick={ui.restart}>reload</button>}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

Object.assign(window, { BrowserPanel });
