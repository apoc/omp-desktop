/* app/use-pane-widths.jsx — the resizable columns beside the chat (#41).
   usePaneWidths({ tweaks, setTweak, open, reserve, workspaceRef })
     → { style, handle(name), reset, browserRoom }
   `open` lists the shown panes (OMP_LAYOUT_WIDTHS.PANES names), `reserve`
   the px of a column that sizes itself (the browser panel's minimum),
   `workspaceRef` the `.workspace` row the sidebar and the stage share.
   `style` carries the widths as CSS variables (`--w-sidebar`, `--w-split`,
   `--w-rail`, `--w-tree`, `--w-files`; layout/stage.css, sidebar.css,
   tree.css, files.css, browser.css), `handle(name)` the ResizeHandle props of one pane, and
   `reset()` sets every pane (the browser panel's too) back to its default,
   `browserRoom` is the stage less the split pane (the browser dock's room).
   A drag shows its width locally and saves the tweak once, on release
   (ui/use-edge-drag.js); a key saves at once. Tweaks persist with the rest
   of them, so the widths come back on the next launch. */

const {
  fit: _PW_fit, dragWidth: _PW_drag, settle: _PW_settle, PANES: _PW_PANES, NARROW_WINDOW: _PW_NARROW,
} = window.OMP_LAYOUT_WIDTHS;

// Per pane: its tweak, the handle's label and the side of the pane the
// handle sits on.
const _PW_UI = {
  sidebar: { tweak: "sidebarWidth", label: "resize project sidebar", edge: "right" },
  split: { tweak: "splitWidth", label: "resize subagent pane", edge: "left" },
  rail: { tweak: "railWidth", label: "resize ambient rail", edge: "left" },
  tree: { tweak: "treeWidth", label: "resize conversation tree", edge: "left" },
  files: { tweak: "filesWidth", label: "resize files panel", edge: "left" },
};
const _PW_RESET = { browserWidth: 0 };
for (const { tweak } of Object.values(_PW_UI)) _PW_RESET[tweak] = 0;

function usePaneWidths({ tweaks, setTweak, open, reserve, workspaceRef }) {
  const [room, setRoom] = React.useState({ total: 0, narrow: false });

  React.useLayoutEffect(() => {
    const el = workspaceRef.current;
    if (!el) return undefined;
    const measure = () => {
      // Whole px, rounded down: never past the room there is.
      const total = Math.floor(el.getBoundingClientRect().width);
      const narrow = window.innerWidth <= _PW_NARROW;
      setRoom((r) => (r.total === total && r.narrow === narrow ? r : { total, narrow }));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [workspaceRef]);

  // One drag per pane, fixed order (hooks). While one runs the other panes
  // hold the widths they had at the press (`frozen`): refitted around the
  // growing pane they would shrink, and the pane would chase them.
  const frozen = React.useRef(null);
  const drags = {};
  let widths = {};
  const saved = {};
  for (const name of open) saved[name] = tweaks[_PW_UI[name].tweak];
  // One width saved = the layout shown saved (OMP_LAYOUT_WIDTHS.settle), so
  // nothing moves on release.
  const save = (name, px) => {
    const patch = _PW_settle(name, px, widths, saved, open, room.total, room.narrow);
    const tw = {};
    for (const pane of Object.keys(patch)) tw[_PW_UI[pane].tweak] = patch[pane];
    setTweak(tw);
  };
  for (const name of Object.keys(_PW_UI)) {
    const { edge } = _PW_UI[name];
    drags[name] = window.useEdgeDrag({
      begin: (e) => {
        frozen.current = widths;
        return { start: widths[name], x: e.clientX };
      },
      measure: (e, d) => _PW_drag(name, d.start + (edge === "left" ? d.x - e.clientX : e.clientX - d.x), frozen.current, room.total, reserve),
      commit: (px) => save(name, px),
    });
  }
  // After a change of the shown columns mid-drag (a shortcut, a tab switch)
  // the frozen widths no longer describe the layout: drop the drag. (A
  // dragged handle that unmounts drops its own, ui/use-edge-drag.js.)
  const openKey = open.join(" ");
  React.useEffect(() => {
    for (const name of Object.keys(_PW_UI)) drags[name].cancel();
  }, [openKey]);
  const dragging = open.find((name) => drags[name].size != null);
  const wants = dragging ? { ...frozen.current, [dragging]: drags[dragging].size } : saved;
  widths = _PW_fit(wants, open, room.total, { narrow: room.narrow, reserve });

  const style = {};
  for (const name of open) style[`--w-${name}`] = `${widths[name]}px`;

  const handle = (name) => ({
    edge: _PW_UI[name].edge,
    label: _PW_UI[name].label,
    drag: drags[name],
    value: widths[name],
    min: _PW_PANES[name].min,
    // What the chat can spare now, not the pane's absolute maximum.
    max: _PW_drag(name, Infinity, widths, room.total, reserve),
    onSize: (px) => {
      const to = _PW_drag(name, px, widths, room.total, reserve);
      if (to !== widths[name]) save(name, to);
    },
    onReset: () => setTweak(_PW_UI[name].tweak, 0),
  });

  const reset = () => setTweak(_PW_RESET);
  const browserRoom = room.total - (widths.sidebar ?? 0) - (widths.split ?? 0);

  return { style, handle, reset, browserRoom };
}

Object.assign(window, { usePaneWidths });
