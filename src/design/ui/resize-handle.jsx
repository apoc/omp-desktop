/* ui/resize-handle.jsx — the drag line on a column's edge (#41): the
   project sidebar's right edge, the split pane's, rail's, conversation
   tree's and browser panel's left edge. A focusable vertical separator:
   the pointer drag is the caller's `drag` (ui/use-edge-drag.js), the keys
   are OMP_LAYOUT_WIDTHS.nudge (arrows step, Home/End jump to `min`/`max`,
   Enter resets), double-click resets. `edge` is the side of the pane it
   sits on; `value` is the width shown, labelled while dragging or focused.
   `onSize(px)` gets an unclamped width from a key, the caller bounds and
   saves it. Placement is the caller's class (layout/stage.css). */

const { nudge: _RH_nudge } = window.OMP_LAYOUT_WIDTHS;

function ResizeHandle({ edge, label, className = "", drag, value, min, max, onSize, onReset }) {
  const onKeyDown = (e) => {
    const to = _RH_nudge(e.key, e.shiftKey, edge, { value, min, max });
    if (to == null) return;
    e.preventDefault();
    if (to === "reset") onReset();
    else onSize(to);
  };
  return (
    <div
      className={`pane-resize edge-${edge} ${className}${drag.size != null ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={OMP_TR("drag to resize, double-click for the default width")}
      {...drag.handlers}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    >
      <span className="pane-resize-tip">{value} px</span>
    </div>
  );
}

Object.assign(window, { ResizeHandle });
