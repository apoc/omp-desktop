/* browser-dock.jsx — the browser panel's slot in the stage: the panel plus a
   drag handle on its left edge (docs/architecture/browser.md,
   "Panel"). Width = OMP_BROWSER.clampWidth(tweak, room), where `room` is the
   stage's width less the subagent split pane's column (`.split`, beside the
   chat in split view; app/use-pane-widths.jsx `browserRoom`, whole px), so
   the chat keeps its minimum; the drag (ui/use-edge-drag.js) follows the
   pointer and is persisted once, on release; the handle
   (ui/resize-handle.jsx) also takes keys. In full view the dock takes the
   whole stage (layout/browser.css hides the other columns).
   `stageRef` is the `.stage` element the dock sits in. */

const { BrowserPanel: _BD_Panel, ResizeHandle: _BD_Handle } = window;
const { clampWidth: _BD_clamp, maxWidth: _BD_max, MIN_WIDTH: _BD_MIN } = window.OMP_BROWSER;

function BrowserDock({ ui, stageRef, room }) {
  const drag = window.useEdgeDrag({
    begin: () => ({ start: width }),
    measure: (e) => _BD_clamp(Math.round(stageRef.current.getBoundingClientRect().right - e.clientX), room),
    commit: ui.setWidth,
  });
  const width = _BD_clamp(drag.size ?? ui.width, room);

  return (
    <div className="browser-dock" style={ui.fullView ? undefined : { width }}>
      {!ui.fullView && (
        <_BD_Handle
          edge="left"
          label={OMP_TR("resize browser panel")}
          drag={drag}
          value={width}
          min={_BD_MIN}
          max={_BD_max(room)}
          onSize={(px) => {
            const to = _BD_clamp(px, room);
            if (to !== width) ui.setWidth(to);
          }}
          onReset={() => ui.setWidth(0)}
        />
      )}
      <_BD_Panel ui={ui} />
    </div>
  );
}

Object.assign(window, { BrowserDock });
