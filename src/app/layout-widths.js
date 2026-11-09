// app/layout-widths.js — widths of the resizable columns beside the chat
// (#41): the project sidebar, the subagent split pane, the ambient rail,
// the conversation tree and the files panel. No DOM:
//   CHAT_MIN                     the chat column's minimum (also the browser
//                                panel's, OMP_BROWSER.clampWidth)
//   PANES                        per pane: min / max / default px
//   NARROW_WINDOW                window width at or below which the
//                                narrower defaults apply (fit's `narrow`)
//   fit(wants, open, total, opts)  the width of every open pane
//   dragWidth(name, px, widths, total, reserve)  one pane's width while dragged
//   settle(name, px, widths, saved, open, total, narrow)  the tweaks one
//                                resize saves (the layout as shown)
//   nudge(key, shift, edge, now)  a resize handle's keyboard step
// A saved width is a tweak (`sidebarWidth`, `splitWidth`, `railWidth`,
// `treeWidth`, `filesWidth`); 0 means the pane's default.
(function () {
  const CHAT_MIN = 420;
  // Below this window width the defaults are the narrower ones the stage
  // had before the panes could be resized.
  const NARROW_WINDOW = 1100;
  const STEP = 16;
  const BIG_STEP = 64;

  // `tree`'s default is also at most half the stage (the old
  // `min(540px, 50%)`), see `preferredAll`.
  const PANES = {
    sidebar: { min: 160, max: 420, wide: 220, narrow: 188 },
    split: { min: 240, max: 560, wide: 320, narrow: 280 },
    rail: { min: 240, max: 520, wide: 280, narrow: 240 },
    tree: { min: 320, max: 900, wide: 540, narrow: 540 },
    files: { min: 420, max: 1600, wide: 760, narrow: 560 },
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const isSaved = (px) => Number.isFinite(px) && px > 0;

  // The width a pane asks for before the window is taken into account: its
  // saved width within its bounds, else its default.
  function preferred(name, px, narrow) {
    const p = PANES[name];
    if (isSaved(px)) return clamp(Math.round(px), p.min, p.max);
    return narrow ? p.narrow : p.wide;
  }

  /**
   * Width in px of each pane in `open` (names from PANES), given the saved
   * widths `wants` ({ name: px }, 0 = default) and `total`, the whole px
   * the panes and the chat share (sidebar + stage; the caller rounds the
   * measure down). `reserve` is a column that sizes itself (the browser
   * panel's minimum). When the panes would leave
   * the chat less than CHAT_MIN they give up room in proportion to how far
   * each is above its minimum; no pane goes below its minimum, so a window
   * too narrow even for those leaves the chat what remains. `total <= 0`
   * (not measured yet) skips that step.
   */
  function fit(wants, open, total, { narrow = false, reserve = 0 } = {}) {
    const out = preferredAll(wants, open, total, narrow);
    if (!(total > 0)) return out;
    let used = reserve;
    let slack = 0;
    for (const name of open) {
      used += out[name];
      slack += out[name] - PANES[name].min;
    }
    // Every cut rounds up, so the chat never ends up a pixel short.
    const over = Math.min(slack, used + CHAT_MIN - total);
    if (over <= 0) return out;
    for (const name of open) {
      const { min } = PANES[name];
      out[name] -= Math.ceil(((out[name] - min) * over) / slack);
    }
    return out;
  }

  // Every open pane's `preferred` width; a default tree capped by the stage.
  function preferredAll(wants, open, total, narrow) {
    const out = {};
    for (const name of open) out[name] = preferred(name, wants[name], narrow);
    // The tree's default is at most half the stage, which the sidebar narrows.
    const stage = total - (out.sidebar ?? 0);
    if (out.tree != null && !isSaved(wants.tree) && stage > 0) {
      out.tree = clamp(Math.min(out.tree, Math.floor(stage / 2)), PANES.tree.min, PANES.tree.max);
    }
    return out;
  }

  /**
   * What to save when `name` is set to `px` with the panes shown at
   * `widths`: `{ name: px }`, plus every other open pane whose shown width
   * is not what it would ask for once `name` is saved — one the window
   * squeezed, or a default tree that halves a stage the change resizes —
   * at its shown width. The layout on screen is then the one saved, so
   * nothing moves when it is fitted again; a pane that would be shown as
   * it is keeps its saved value (0 stays the default).
   */
  function settle(name, px, widths, saved, open, total, narrow = false) {
    const patch = { [name]: px };
    const asked = preferredAll({ ...saved, [name]: px }, open, total, narrow);
    for (const other of open) if (other !== name && widths[other] !== asked[other]) patch[other] = widths[other];
    return patch;
  }

  /**
   * The width `name` takes when dragged (or nudged) to `px`: within its
   * bounds, and no wider than what leaves the chat CHAT_MIN beside the
   * other panes' current `widths` (and `reserve`). Its minimum wins over
   * the chat's.
   */
  function dragWidth(name, px, widths, total, reserve = 0) {
    const { min, max } = PANES[name];
    let others = reserve;
    for (const other of Object.keys(widths)) if (other !== name) others += widths[other];
    return Math.max(min, Math.min(Math.round(px), max, total - others - CHAT_MIN));
  }

  /**
   * A keydown on a resize handle whose pane is `now.value` px wide, within
   * `now.min` .. `now.max`: the width to set (unclamped after an arrow),
   * "reset" (back to the default), or null for a key the handle leaves
   * alone. `edge` is the side of the pane the handle sits on: the arrow
   * pointing away from the pane grows it.
   */
  function nudge(key, shift, edge, { value, min, max }) {
    const step = shift ? BIG_STEP : STEP;
    const grow = edge === "left" ? "ArrowLeft" : "ArrowRight";
    const shrink = edge === "left" ? "ArrowRight" : "ArrowLeft";
    if (key === grow) return value + step;
    if (key === shrink) return value - step;
    if (key === "Home") return min;
    if (key === "End") return max;
    if (key === "Enter") return "reset";
    return null;
  }

  window.OMP_LAYOUT_WIDTHS = { CHAT_MIN, NARROW_WINDOW, PANES, fit, dragWidth, settle, nudge };
})();
