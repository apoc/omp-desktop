// app/constants.js — defaults, sentinels, and prompt-framing strings used
// by the App root. Loaded as a plain script before app-live.jsx so the
// EDITMODE block stays at a stable, scrapable location for the host.
//
// Wrapped in an IIFE so the top-level `const` declarations don't leak
// into the document's top-level lexical scope. Babel-transformed
// scripts (like app-live.jsx) destructure these from `window`, which
// produces matching top-level `const` bindings — without the IIFE
// wrapper here, those would collide with the same-name bindings in
// this file and throw 'Identifier already declared'.

(function () {
  const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
    "theme": "aurora",
    "density": "compact",
    "layout": "rail",
    "accent": "#8AF0C8",
    "monoChat": false,
    "scanlines": true,
    "showRadar": true,
    "fontSize":  100,
    "autosave":  true
  }/*EDITMODE-END*/;

  const NULL_MODEL    = { id: "", name: "–", provider: "", note: "", latency: 0, current: false };
  const EMPTY_PROJECT = { id: "", name: "OMP Desktop", path: "", color: "var(--accent)", branch: "" };
  const NULL_PEER     = { project: "—", title: "no peer session", activity: "edit · idle", tps: 0, todo: { done: 0, total: 1 } };

  const INTENT_FRAMING = (intent) =>
    `Please draft a plan for the following task. Write it in Markdown with clear sections: overview, approach, key steps, and risks. Do not start implementing yet — draft only for my review.\n\n---\n\n${intent.trim()}`;

  const APPROVAL_PROMPT = "Plan approved. Please proceed to execute it. Use your todo_write tool to track tasks as you go.";

  Object.assign(window, {
    TWEAK_DEFAULTS,
    NULL_MODEL,
    EMPTY_PROJECT,
    NULL_PEER,
    INTENT_FRAMING,
    APPROVAL_PROMPT,
  });
})();
