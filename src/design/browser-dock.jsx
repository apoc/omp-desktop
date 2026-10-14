/* browser-dock.jsx — the browser panel's slot in the stage: the panel plus a
   drag handle on its left edge (docs/architecture/browser.md,
   "Panel"). Width = OMP_BROWSER.clampWidth(tweak, stage width); the drag
   follows the pointer and is persisted once, on release. In full view the
   dock takes the whole stage (layout/browser.css hides the other columns).
   `stageRef` is the `.stage` element the dock sits in. */

const { BrowserPanel: _BD_Panel } = window;
const { clampWidth: _BD_clamp } = window.OMP_BROWSER;

function BrowserDock({ ui, stageRef, onClose }) {
  const [stageW, setStageW] = React.useState(0);
  const [drag, setDrag] = React.useState(null); // px while the handle is held

  React.useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const measure = () => setStageW(stage.getBoundingClientRect().width);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [stageRef]);

  const width = _BD_clamp(drag ?? ui.width, stageW);
  const onDown = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(width);
  };
  const onMove = (e) => {
    if (drag == null) return;
    setDrag(_BD_clamp(stageRef.current.getBoundingClientRect().right - e.clientX, stageW));
  };
  const onUp = () => {
    if (drag == null) return;
    ui.setWidth(drag);
    setDrag(null);
  };

  return (
    <div className="browser-dock" style={ui.fullView ? undefined : { width }}>
      {!ui.fullView && (
        <div
          className={`browser-resize${drag != null ? " dragging" : ""}`}
          role="separator"
          aria-orientation="vertical"
          title="drag to resize, double-click for the default width"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onDoubleClick={() => ui.setWidth(0)}
        />
      )}
      <_BD_Panel ui={ui} onClose={onClose} />
    </div>
  );
}

Object.assign(window, { BrowserDock });
