// tweaks/style.js — the floating panel's scoped stylesheet.
// Imported once via tweaks/panel.jsx and inlined as <style>{...}</style>.
// Uses the app's CSS custom properties so theme changes propagate automatically.

// Wrapped in an IIFE so the top-level `const` doesn't leak into the
// document's script-scope lexical environment.
(function () {
const __TWEAKS_STYLE = `
  .twk-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:280px;
    max-height:calc(100vh - 32px);display:flex;flex-direction:column;
    transform:scale(var(--dc-inv-zoom,1));transform-origin:bottom right;
    background:color-mix(in oklab,var(--bg-elevated) 92%,transparent);
    color:var(--fg);
    -webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%);
    border:1px solid var(--line-bright);border-radius:var(--r-3,14px);
    box-shadow:var(--shadow-pop);
    font:var(--d-text-sm,11.5px)/1.4 var(--font-sans,ui-sans-serif,system-ui,sans-serif);
    overflow:hidden}

  .twk-hd{display:flex;align-items:center;justify-content:space-between;
    padding:10px 8px 10px 14px;cursor:move;user-select:none;
    border-bottom:1px solid var(--line)}
  .twk-hd b{font-size:12px;font-weight:600;letter-spacing:.01em;color:var(--fg)}

  .twk-x{appearance:none;border:0;background:transparent;color:var(--fg-3);
    width:22px;height:22px;border-radius:var(--r-1,6px);cursor:default;font-size:13px;line-height:1}
  .twk-x:hover{background:var(--bg-hover);color:var(--fg)}

  .twk-body{padding:2px 14px 14px;display:flex;flex-direction:column;gap:10px;
    overflow-y:auto;overflow-x:hidden;min-height:0;
    scrollbar-width:thin;scrollbar-color:var(--line-bright) transparent}
  .twk-body::-webkit-scrollbar{width:8px}
  .twk-body::-webkit-scrollbar-track{background:transparent;margin:2px}
  .twk-body::-webkit-scrollbar-thumb{background:var(--line-bright);border-radius:4px;
    border:2px solid transparent;background-clip:content-box}
  .twk-body::-webkit-scrollbar-thumb:hover{background:var(--fg-5);
    border:2px solid transparent;background-clip:content-box}

  .twk-row{display:flex;flex-direction:column;gap:5px}
  .twk-row-h{flex-direction:row;align-items:center;justify-content:space-between;gap:10px}
  .twk-lbl{display:flex;justify-content:space-between;align-items:baseline;
    color:var(--fg-3)}
  .twk-lbl>span:first-child{font-weight:500;color:var(--fg-2)}
  .twk-val{color:var(--fg-4);font-variant-numeric:tabular-nums}

  .twk-sect{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
    color:var(--fg-4);padding:10px 0 0}
  .twk-sect:first-child{padding-top:0}

  .twk-field{appearance:none;width:100%;height:26px;padding:0 8px;
    border:1px solid var(--line);border-radius:var(--r-1,7px);
    background:var(--bg-input);color:var(--fg);font:inherit;outline:none}
  .twk-field:focus{border-color:var(--accent);background:var(--bg-surface)}
  select.twk-field{padding-right:22px;
    background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path fill='rgba(255,255,255,.4)' d='M0 0h10L5 6z'/></svg>");
    background-repeat:no-repeat;background-position:right 8px center}

  .twk-slider{appearance:none;-webkit-appearance:none;width:100%;height:4px;margin:6px 0;
    border-radius:999px;background:var(--line-bright);outline:none}
  .twk-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;
    width:14px;height:14px;border-radius:50%;background:var(--accent);
    border:none;box-shadow:0 1px 3px rgba(0,0,0,.4);cursor:default}
  .twk-slider::-moz-range-thumb{width:14px;height:14px;border-radius:50%;
    background:var(--accent);border:none;box-shadow:0 1px 3px rgba(0,0,0,.4);cursor:default}

  .twk-seg{position:relative;display:flex;padding:2px;border-radius:8px;
    background:var(--bg-surface);border:1px solid var(--line);user-select:none}
  .twk-seg-thumb{position:absolute;top:2px;bottom:2px;border-radius:6px;
    background:var(--bg-elevated);border:1px solid var(--line-bright);
    box-shadow:0 1px 2px rgba(0,0,0,.3);
    transition:left .15s cubic-bezier(.3,.7,.4,1),width .15s}
  .twk-seg.dragging .twk-seg-thumb{transition:none}
  .twk-seg button{appearance:none;position:relative;z-index:1;flex:1;border:0;
    background:transparent;color:var(--fg-3);font:inherit;font-weight:500;min-height:22px;
    border-radius:6px;cursor:default;padding:4px 6px;line-height:1.2;
    overflow-wrap:anywhere;transition:color .12s}
  .twk-seg button[data-active="1"],.twk-seg button:focus-visible{color:var(--fg)}

  .twk-toggle{position:relative;width:32px;height:18px;border:0;border-radius:999px;
    background:var(--line-bright);transition:background .15s;cursor:default;padding:0;
    border:1px solid var(--line)}
  .twk-toggle[data-on="1"]{background:var(--accent);border-color:var(--accent)}
  .twk-toggle i{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;
    background:var(--fg);box-shadow:0 1px 2px rgba(0,0,0,.4);transition:transform .15s}
  .twk-toggle[data-on="1"] i{transform:translateX(14px)}

  .twk-num{display:flex;align-items:center;height:26px;padding:0 0 0 8px;
    border:1px solid var(--line);border-radius:var(--r-1,7px);background:var(--bg-input)}
  .twk-num-lbl{font-weight:500;color:var(--fg-3);cursor:ew-resize;
    user-select:none;padding-right:8px}
  .twk-num input{flex:1;min-width:0;height:100%;border:0;background:transparent;
    font:inherit;font-variant-numeric:tabular-nums;text-align:right;padding:0 8px 0 0;
    outline:none;color:var(--fg);-moz-appearance:textfield}
  .twk-num input::-webkit-inner-spin-button,.twk-num input::-webkit-outer-spin-button{
    -webkit-appearance:none;margin:0}
  .twk-num-unit{padding-right:8px;color:var(--fg-4)}

  .twk-btn{appearance:none;height:26px;padding:0 12px;border:0;border-radius:var(--r-1,7px);
    background:var(--accent);color:var(--bg-window);font:inherit;font-weight:600;cursor:default}
  .twk-btn:hover{background:var(--accent-deep)}
  .twk-btn.secondary{background:var(--bg-hover);color:var(--fg-2);border:1px solid var(--line)}
  .twk-btn.secondary:hover{background:var(--bg-active);color:var(--fg)}

  .twk-swatch{appearance:none;-webkit-appearance:none;width:56px;height:22px;
    border:1px solid var(--line);border-radius:var(--r-1,6px);padding:0;cursor:default;
    background:transparent;flex-shrink:0}
  .twk-swatch::-webkit-color-swatch-wrapper{padding:0}
  .twk-swatch::-webkit-color-swatch{border:0;border-radius:5px}
  .twk-swatch::-moz-color-swatch{border:0;border-radius:5px}

  .twk-chips{display:flex;gap:6px}
  .twk-chip{position:relative;appearance:none;flex:1;min-width:0;height:46px;
    padding:0;border:1px solid var(--line);border-radius:var(--r-1,6px);overflow:hidden;
    cursor:default;background:var(--bg-surface);
    transition:transform .12s cubic-bezier(.3,.7,.4,1),border-color .12s}
  .twk-chip:hover{transform:translateY(-1px);border-color:var(--line-bright)}
  .twk-chip[data-on="1"]{border-color:var(--accent);
    box-shadow:0 0 0 1px var(--accent)}
  .twk-chip>span{position:absolute;top:0;bottom:0;right:0;width:34%;
    display:flex;flex-direction:column;border-left:1px solid var(--line)}
  .twk-chip>span>i{flex:1;border-top:1px solid var(--line)}
  .twk-chip>span>i:first-child{border-top:none}
  .twk-chip svg{position:absolute;top:6px;left:6px;width:13px;height:13px}
`;

window.__TWEAKS_STYLE = __TWEAKS_STYLE;
})();
