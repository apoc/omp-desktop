// app/constants.js — defaults, sentinels, and prompt-framing strings used
// by the App root. Loaded as a plain script before app-live.jsx. The
// EDITMODE markers around TWEAK_DEFAULTS are kept intact on purpose (#37).
//
// Wrapped in an IIFE so the top-level `const` declarations don't leak
// into the document's top-level lexical scope. Babel-transformed
// scripts (like app-live.jsx) destructure these from `window`, which
// produces matching top-level `const` bindings — without the IIFE
// wrapper here, those would collide with the same-name bindings in
// this file and throw 'Identifier already declared'.

(function () {
  // `foldThinking` / `foldTools`: null until picked (OMP_COLLAPSE.foldModes).
  // `browserWidth`: px of the browser panel, 0 = half the stage (OMP_BROWSER.clampWidth).
  // `sidebarWidth` / `splitWidth` / `railWidth` / `treeWidth`: px of those
  // columns, 0 = the default (OMP_LAYOUT_WIDTHS.fit).
  // `browserLocalhostInPanel`: a plain click on a localhost chat link opens
  // the panel instead of the system browser. (The Chromium path is a Rust
  // setting, browser.json — never a tweak.)
  // Settings page (#37): `defaultSide` is the side column a new tab starts
  // with; `followOutput` pins the transcript to the newest message;
  // `terminalScrollback` is xterm's scrollback in lines; `submitKey` is
  // "enter" | "ctrl+enter" for multi-line fields; `pasteCollapseLines` is
  // the line count above which a paste becomes a chip; `restoreTabs`,
  // `confirmBusyClose`, `autoName` drive live.js; `autoCompaction` /
  // `autoRetry` are sent to every omp process. Rows, labels and bounds:
  // app/settings-schema.js.
  const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
    "theme": "aurora",
    "density": "compact",
    "layout": "rail",
    "accent": "#8AF0C8",
    "monoChat": false,
    "showContext": true,
    "showRadar": true,
    "showSubagents": true,
    "showAgentContext": true,
    "showChanges": true,
    "showMinimap": true,
    "fontSize":  100,
    "promptHistoryLimit": 100,
    "foldThinking": null,
    "foldTools": null,
    "collapseAfter": 5,
    "followOutput": true,
    "updateCheck": true,
    "skippedUpdate": null,
    "sidebar": true,
    "sidebarWidth": 0,
    "splitWidth": 0,
    "railWidth": 0,
    "treeWidth": 0,
    "defaultSide": "rail",
    "terminalAutoOpen": false,
    "terminalHeight": 240,
    "terminalScrollback": 5000,
    "browserWidth": 0,
    "browserLocalhostInPanel": true,
    "submitKey": "enter",
    "pasteCollapseLines": 5,
    "restoreTabs": true,
    "confirmBusyClose": false,
    "notifyFinished": false,
    "notifyQuestions": false,
    "autoName": true,
    "autoCompaction": true,
    "autoRetry": true
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

  // The send chord of a multi-line field (composer, ask-bubble editor,
  // subagent steer box) for the `submitKey` tweak; single-line inputs keep
  // isSubmitEnter. "enter": Enter without Shift sends (any other modifier
  // too, as before #37), Shift+Enter is the textarea's own newline.
  // "ctrl+enter": Ctrl/Cmd+Enter (no Shift/Alt) sends, plain Enter is the
  // textarea's own newline. Unknown values behave as "enter".
  const isSubmitKey = (e, pref = "enter") => {
    if (!isSubmitEnter(e) || e.shiftKey) return false;
    return pref === "ctrl+enter" ? Boolean(e.ctrlKey || e.metaKey) && !e.altKey : true;
  };

  // `s` cut to `max` UTF-16 units, the last one an ellipsis, never ending on
  // half a surrogate pair (extension widget text, browser annotation HTML).
  function truncateText(s, max) {
    if (s.length <= max) return s;
    const cut = /[\ud800-\udbff]/.test(s[max - 2]) ? max - 2 : max - 1;
    return s.slice(0, cut) + "…";
  }

  // omp's thinking levels, lowest first, with its own descriptions
  // (packages/tui/src/thinking.ts, THINKING_LEVEL_METADATA).
  const THINKING_LEVELS = {
    off:     { hint: "no reasoning" },
    minimal: { hint: "very brief reasoning (~1k tokens)" },
    low:     { hint: "light reasoning (~2k tokens)" },
    medium:  { hint: "moderate reasoning (~8k tokens)" },
    high:    { hint: "deep reasoning (~16k tokens)" },
    xhigh:   { hint: "extended reasoning (~32k tokens)" },
    max:     { hint: "maximum reasoning the model supports" },
  };

  Object.assign(window, {
    TWEAK_DEFAULTS,
    NULL_MODEL,
    EMPTY_PROJECT,
    DEFAULT_PROFILE_ID,
    INTENT_FRAMING,
    APPROVAL_PROMPT,
    isSubmitEnter,
    isSubmitKey,
    truncateText,
    THINKING_LEVELS,
  });
})();
