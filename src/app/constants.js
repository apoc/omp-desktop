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
    "autosave":  true,
    "promptHistoryLimit": 100
  }/*EDITMODE-END*/;

  const NULL_MODEL    = { id: "", name: "–", provider: "", note: "", latency: 0, current: false };
  // Reserved id of the built-in omp profile (spawned without --profile, i.e.
  // omp's own ~/.omp/agent). Mirrors profiles::DEFAULT_PROFILE_ID in Rust.
  const DEFAULT_PROFILE_ID = "default";

  const EMPTY_PROJECT = { id: "", name: "OMP Desktop", path: "", color: "var(--accent)", branch: "", profile: DEFAULT_PROFILE_ID };

  const INTENT_FRAMING = (intent) =>
    `Please draft a plan for the following task. Write it in Markdown with clear sections: overview, approach, key steps, and risks. Do not start implementing yet — draft only for my review.\n\n---\n\n${intent.trim()}`;

  const APPROVAL_PROMPT = "Plan approved. Please proceed to execute it. Use your todo_write tool to track tasks as you go.";

  // `true` when a keydown is an Enter that should submit — i.e. not the
  // Enter that confirms an in-progress IME composition (typing Chinese/
  // Japanese/Korean via a candidate picker), which must never also submit
  // the half-typed text.
  //
  // Two browser quirks, both easy to get wrong and previously hand-copied
  // into every Enter handler (composer + two in ask-bubble, already drifting
  // on the optional chaining):
  //   - React's SyntheticEvent does not copy `isComposing` onto itself, only
  //     onto `nativeEvent` — proven with an eval-kernel cell (2/2 cases:
  //     mid-composition Enter blocked, plain Enter still sends).
  //   - `keyCode === 229` is the historical fallback for browsers that don't
  //     set `isComposing` (notably some IME/Enter interactions on Windows).
  const isSubmitEnter = (e) =>
    e.key === "Enter" && !e.nativeEvent?.isComposing && e.keyCode !== 229;

  Object.assign(window, {
    TWEAK_DEFAULTS,
    NULL_MODEL,
    EMPTY_PROJECT,
    DEFAULT_PROFILE_ID,
    INTENT_FRAMING,
    APPROVAL_PROMPT,
    isSubmitEnter,
  });
})();
