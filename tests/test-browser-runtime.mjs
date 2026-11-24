#!/usr/bin/env node
// Runtime regression for the browser panel's DOM side (app/browser-screen.js)
// and its hook (app/use-browser.jsx) against minimal stubs: frame decode,
// paint and acks, the pixel-ratio watch, input routing through the focus
// sink, and the open/close effect's queued resize / URL across tab switches.
// The hook runs under a small effect-running React stand-in, so nothing
// here depends on the order of its hook calls.
// Run: node tests/test-browser-runtime.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
// Objects the modules build live in the vm's realm (other prototypes), which
// strict deep equality refuses; compare their plain-data copy instead.
const own = (v) => JSON.parse(JSON.stringify(v));

/** An EventTarget stand-in: `fire(type, ev)` runs the listeners, returns `ev`. */
function node(extra = {}) {
  const on = new Map();
  return {
    ...extra,
    addEventListener(type, fn) { if (!on.has(type)) on.set(type, new Set()); on.get(type).add(fn); },
    removeEventListener(type, fn) { on.get(type)?.delete(fn); },
    listeners: (type) => on.get(type)?.size ?? 0,
    fire(type, ev = {}) {
      ev.defaultPrevented ??= false;
      ev.preventDefault = () => { ev.defaultPrevented = true; };
      for (const fn of [...(on.get(type) ?? [])]) fn(ev);
      return ev;
    },
  };
}

/** The real browser.js and what it calls on `window`, as index.html loads them. */
function loadHelpers(window) {
  runInNewContext(source("src/app/constants.js"), { window });
  runInNewContext(source("src/app/session-ui.js"), { window });
  runInNewContext(source("src/app/image-attach.js"), { window, atob, Uint8Array });
  runInNewContext(source("src/app/layout-widths.js"), { window });
  runInNewContext(source("src/app/browser.js"), { window, URL });
}

/** A frame message of the panel channel: the header, then a 1-byte "JPEG". */
function wire(cssW, cssH, seq) {
  const buffer = new ArrayBuffer(17);
  const head = new DataView(buffer);
  head.setBigUint64(0, BigInt(seq), true);
  head.setUint32(8, cssW, true);
  head.setUint32(12, cssH, true);
  return buffer;
}

function screenHarness({ bypass = () => false, escape = () => null } = {}) {
  const frames = new Map(); // rAF id → callback
  const timers = [];
  const queries = [];
  let next = 0;
  let observe;
  const window = {
    ...node(), devicePixelRatio: 2,
    OMP_KEYMAP: { guestShouldBypass: (e) => bypass(e) },
    matchMedia: (q) => { const m = node({ media: q }); queries.push(m); return m; },
  };
  loadHelpers(window);
  const bitmaps = [];
  const decode = { fail: false };
  runInNewContext(source("src/app/browser-screen.js"), {
    window, Blob,
    createImageBitmap: async () => {
      if (decode.fail) throw new Error("bad jpeg");
      const bmp = { closed: false, close() { this.closed = true; } };
      bitmaps.push(bmp);
      return bmp;
    },
    requestAnimationFrame: (fn) => { frames.set(++next, fn); return next; },
    cancelAnimationFrame: (id) => frames.delete(id),
    ResizeObserver: class { constructor(fn) { observe = fn; } observe() {} disconnect() {} },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
  });
  const painted = [];
  const sent = [];
  const acks = [];
  const resized = [];
  const pages = [];
  const escapes = [];
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: (...args) => painted.push(args) }) };
  const panel = node();
  const size = { width: 400, height: 300 };
  const view = node({
    getBoundingClientRect: () => ({ left: 0, top: 0, ...size }),
    closest: (sel) => (sel === ".browser-panel" ? panel : null),
  });
  const sink = node({ value: "", focused: 0, focus() { this.focused++; } });
  const screen = window.OMP_BROWSER_SCREEN.createScreen({
    view, canvas, sink,
    send: (ev) => sent.push(ev),
    ack: (seq) => acks.push(seq),
    onResize: (...args) => resized.push(args),
    onPage: (page) => pages.push(page),
    escape,
    onEscape: (action) => escapes.push(action),
  });
  const paintAll = () => { for (const [id, paint] of [...frames]) { frames.delete(id); paint(); } };
  const runTimers = () => { for (const fn of timers.splice(0)) fn(); };
  return {
    window, screen, canvas, view, sink, panel, size, bitmaps, decode, painted, sent, acks, resized, pages, escapes,
    queries, frames, paintAll, runTimers, observe: () => observe(),
  };
}

test("screen paints the newest frame, publishes painted geometry and acks every frame once", async () => {
  const h = screenHarness();
  h.observe();
  assert.equal(h.frames.size, 1, "resize schedules paint");
  h.paintAll();
  assert.equal(h.canvas.width, 800);
  assert.equal(h.canvas.height, 600);
  h.screen.frame(wire(400, 300, 1));
  await flush();
  assert.equal(h.pages.length, 0, "unpainted geometry stays unpublished");
  assert.deepEqual(h.acks, [], "no ack before the paint");
  h.paintAll();
  assert.deepEqual(h.painted, [[h.bitmaps[0], 0, 0, 800, 600]]);
  assert.deepEqual(own(h.pages), [{ cssW: 400, cssH: 300 }]);
  assert.deepEqual(h.acks, [1], "acked after the paint");
  // Two frames before a decode finishes: the superseded one is acked as
  // dropped, the newest after its paint.
  h.screen.frame(wire(400, 300, 2));
  h.screen.frame(wire(400, 300, 3));
  await flush();
  h.paintAll();
  assert.deepEqual(h.acks, [1, 2, 3]);
  // An undecodable frame is dropped and acked, so the stream goes on.
  h.decode.fail = true;
  h.screen.frame(wire(400, 300, 4));
  await flush();
  assert.deepEqual(h.acks, [1, 2, 3, 4]);
  h.screen.destroy();
  assert.ok(h.bitmaps.every((b) => b.closed), "every bitmap released");
  assert.equal(h.frames.size, 0);
});

test("screen re-sends its size when the display's pixel ratio changes", () => {
  const h = screenHarness();
  assert.equal(h.queries.at(-1).media, "(resolution: 2dppx)");
  h.window.devicePixelRatio = 1.5;
  h.queries.at(-1).fire("change");
  assert.equal(h.queries.at(-1).media, "(resolution: 1.5dppx)", "re-armed for the new ratio");
  assert.equal(h.queries.at(-2).listeners("change"), 0, "the old query is let go");
  h.runTimers();
  assert.deepEqual(h.resized, [[400, 300, 1.5]]);
  h.screen.destroy();
  assert.equal(h.queries.at(-1).listeners("change"), 0);
});

test("screen input: typed keys, text through the sink, paste, side buttons", async () => {
  const h = screenHarness({ bypass: (e) => e.key === "B" && e.ctrlKey && e.shiftKey });
  h.screen.frame(wire(800, 600, 1));
  await flush();
  // A printable key goes out with its text and never lands in the sink.
  const a = h.sink.fire("keydown", { target: h.sink, key: "a", code: "KeyA" });
  assert.equal(a.defaultPrevented, true);
  assert.equal(h.sent.at(-1).text, "a");
  // A dead key / IME composition stays in the sink; its result goes as text once.
  const dead = h.sink.fire("keydown", { target: h.sink, key: "Dead", code: "BracketLeft" });
  assert.equal(dead.defaultPrevented, false);
  const count = h.sent.length;
  h.sink.value = "é";
  h.sink.fire("compositionend", { target: h.sink, data: "é" });
  h.sink.fire("input", { target: h.sink, isComposing: false });
  assert.deepEqual(own(h.sent.slice(count)), [{ kind: "text", text: "é" }]);
  assert.equal(h.sink.value, "");
  // Paste: the keydown is left to the native paste, the text goes out.
  const v = h.sink.fire("keydown", { target: h.sink, key: "v", code: "KeyV", ctrlKey: true });
  assert.equal(v.defaultPrevented, false);
  const paste = h.sink.fire("paste", { target: h.sink, clipboardData: { getData: () => "hello" } });
  assert.equal(paste.defaultPrevented, true);
  assert.deepEqual(own(h.sent.at(-1)), { kind: "text", text: "hello" });
  // An app chord (guestShouldBypass) bubbles on to the keymap untouched.
  const before = h.sent.length;
  const toggle = h.sink.fire("keydown", { target: h.sink, key: "B", code: "KeyB", ctrlKey: true, shiftKey: true });
  assert.equal(toggle.defaultPrevented, false);
  assert.equal(h.sent.length, before);
  // Side buttons: history back, not a left click; the press focuses the sink.
  const canvas = h.canvas;
  h.view.fire("mousedown", { target: canvas, button: 3, buttons: 8, clientX: 200, clientY: 150, detail: 1 });
  h.window.fire("mouseup", { target: canvas, button: 3, buttons: 0, clientX: 200, clientY: 150, detail: 1 });
  assert.deepEqual(h.sent.slice(-2).map((e) => [e.type, e.button, e.x, e.y]), [
    ["mousePressed", "back", 400, 300], ["mouseReleased", "back", 400, 300],
  ]);
  assert.equal(h.sink.focused, 1);
  h.screen.destroy();
});

test("screen input: Shift+Insert is a native paste, like Ctrl+V", async () => {
  const h = screenHarness();
  h.screen.frame(wire(800, 600, 1));
  await flush();
  const before = h.sent.length;
  const ins = h.sink.fire("keydown", { target: h.sink, key: "Insert", code: "Insert", shiftKey: true });
  assert.equal(ins.defaultPrevented, false, "left to the sink's native paste");
  assert.equal(h.sent.length, before, "not sent to the page as a key");
  // Plain Insert is still the page's key.
  const plain = h.sink.fire("keydown", { target: h.sink, key: "Insert", code: "Insert" });
  assert.equal(plain.defaultPrevented, true);
  assert.equal(h.sent.at(-1).key, "Insert");
  h.screen.destroy();
});

test("screen input: releasing a second button does not swallow the first one's release", async () => {
  const h = screenHarness();
  h.screen.frame(wire(800, 600, 1));
  await flush();
  const canvas = h.canvas;
  const at = { clientX: 100, clientY: 100, detail: 1 };
  h.view.fire("mousedown", { target: canvas, button: 0, buttons: 1, ...at });
  h.view.fire("mousedown", { target: canvas, button: 2, buttons: 3, ...at });
  h.window.fire("mouseup", { target: canvas, button: 2, buttons: 1, ...at });
  h.window.fire("mouseup", { target: canvas, button: 0, buttons: 0, ...at });
  // A release with no press on the canvas (or a second one) sends nothing.
  h.window.fire("mouseup", { target: canvas, button: 0, buttons: 0, ...at });
  assert.deepEqual(h.sent.map((e) => [e.type, e.button]), [
    ["mousePressed", "left"], ["mousePressed", "right"], ["mouseReleased", "right"], ["mouseReleased", "left"],
  ]);
  h.screen.destroy();
});

test("screen input: moves and wheel ticks coalesce per frame; a press sends what waits first", async () => {
  const h = screenHarness();
  h.screen.frame(wire(800, 600, 1));
  await flush();
  h.paintAll();
  const canvas = h.canvas;
  const start = h.sent.length;
  h.window.fire("mousemove", { target: canvas, buttons: 0, clientX: 10, clientY: 10 });
  h.window.fire("mousemove", { target: canvas, buttons: 0, clientX: 100, clientY: 50 });
  h.view.fire("wheel", { target: canvas, deltaMode: 0, deltaX: 0, deltaY: 30, clientX: 100, clientY: 50 });
  const tick = h.view.fire("wheel", { target: canvas, deltaMode: 1, deltaX: 0, deltaY: 2, clientX: 100, clientY: 50 });
  assert.equal(tick.defaultPrevented, true, "the app never scrolls under the page");
  assert.equal(h.sent.length, start, "nothing goes out before the frame");
  h.paintAll();
  assert.deepEqual(h.sent.slice(start).map((e) => [e.kind, e.type ?? null, e.x, e.y, e.deltaY ?? null]), [
    ["mouse", "mouseMoved", 200, 100, null], ["wheel", null, 200, 100, 62],
  ], "the latest move, and the wheel deltas added up (2 lines = 32 px)");
  // A press sends the move still waiting first, and it is not sent again.
  const mid = h.sent.length;
  h.window.fire("mousemove", { target: canvas, buttons: 0, clientX: 40, clientY: 30 });
  h.view.fire("mousedown", { target: canvas, button: 0, buttons: 1, clientX: 40, clientY: 30, detail: 1 });
  assert.deepEqual(h.sent.slice(mid).map((e) => e.type), ["mouseMoved", "mousePressed"]);
  h.paintAll();
  assert.equal(h.sent.length, mid + 2);
  h.screen.destroy();
});

test("screen Esc while annotating is the panel's: not the page's, not the keymap's interrupt", () => {
  let action = "cancelPick";
  const h = screenHarness({ escape: () => action });
  const esc = { target: h.sink, key: "Escape", code: "Escape" };
  h.sink.fire("keydown", esc);
  assert.equal(h.sent.length, 0, "the page never sees it");
  const bubbled = h.panel.fire("keydown", esc);
  assert.equal(bubbled.defaultPrevented, true, "prevented, so use-keymap ignores it");
  assert.deepEqual(h.escapes, ["cancelPick"]);
  action = null;
  const plain = h.sink.fire("keydown", { target: h.sink, key: "Escape", code: "Escape" });
  assert.equal(plain.defaultPrevented, true);
  assert.equal(h.sent.at(-1).key, "Escape", "outside annotate mode Esc is the page's");
  h.panel.fire("keydown", plain);
  assert.deepEqual(h.escapes, ["cancelPick"]);
  h.screen.destroy();
  assert.equal(h.panel.listeners("keydown"), 0);
});

test("screen Esc that dismisses an IME candidate window keeps the pick", () => {
  const h = screenHarness({ escape: () => "cancelPick" });
  const esc = h.panel.fire("keydown", { target: h.sink, key: "Escape", code: "Escape", isComposing: true });
  assert.equal(esc.defaultPrevented, false, "the IME's key");
  assert.deepEqual(h.escapes, [], "pick not cancelled");
  h.screen.destroy();
});

// ---- use-browser.jsx --------------------------------------------------------

/** Enough of React for one hook: state, refs, memo/callback by deps, and
 *  effects that run after a render when their deps changed (cleanup first),
 *  like React's commit. Slots are per call position, as in React itself;
 *  the test only talks to what the hook returns. */
function fakeReact() {
  const slots = [];
  let i = 0;
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((v, k) => !Object.is(v, b[k]));
  let pending = [];
  const React = {
    useState(initial) {
      const k = i++;
      if (!(k in slots)) slots[k] = { value: typeof initial === "function" ? initial() : initial };
      const s = slots[k];
      return [s.value, (v) => { s.value = typeof v === "function" ? v(s.value) : v; }];
    },
    useRef(initial) {
      const k = i++;
      return (slots[k] ??= { current: initial });
    },
    useMemo(fn, deps) {
      const k = i++;
      if (!slots[k] || changed(slots[k].deps, deps)) slots[k] = { deps, value: fn() };
      return slots[k].value;
    },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const k = i++;
      const prev = slots[k];
      if (!prev || changed(prev.deps, deps)) pending.push(() => { prev?.cleanup?.(); slots[k] = { deps, cleanup: fn() }; });
    },
  };
  const render = (hook) => {
    i = 0;
    pending = [];
    const out = hook();
    for (const run of pending) run();
    return out;
  };
  const unmount = () => { for (const s of slots) s?.cleanup?.(); };
  return { React, render, unmount };
}

test("hook: a stale open completion cannot release the newer tab's queued resize and URL", async () => {
  const screens = [];
  const opens = [];
  const resized = [];
  const navigated = [];
  const closed = [];
  const channels = new Map(); // sid → the open's channel handler
  const picks = new Map();
  const states = new Map();
  let capture;
  const { React, render, unmount } = fakeReact();
  const window = {
    OMP_BROWSER_SCREEN: {
      createScreen(options) {
        screens.push(options);
        return { frame() {}, destroy() {}, size: () => ({ width: 400, height: 300, dpr: 1 }) };
      },
    },
  };
  loadHelpers(window);
  window.OMP_IMAGES.normalizeImage = async (img) => img; // DOM canvas work, covered by the app
  const useBrowser = runInNewContext(source("src/app/use-browser.jsx") + "\nuseBrowser", { window, React });
  const bridge = {
    browserOpenPanel(sid, _w, _h, _dpr, onMessage) {
      channels.set(sid, onMessage);
      picks.set(sid, (value) => onMessage({ type: "pick", value }));
      states.set(sid, (value) => onMessage({ type: "state", value }));
      return new Promise((resolve) => opens.push({ sid, resolve }));
    },
    browserResize: (...args) => resized.push(args),
    browserNavigate: (...args) => navigated.push(args),
    browserClosePanel: (sid) => closed.push(sid),
    browserAnnotate() {},
    browserFrameAck() {},
    browserCapture: () => new Promise((resolve) => { capture = resolve; }),
  };
  const elements = (ui) => {
    ui.canvasRef.current = {};
    ui.viewRef.current = {};
    ui.sinkRef.current = {};
  };
  // app-live.jsx's per-tab side column, reduced to the browser's part.
  const openBy = {};
  const show = (sid) => render(() => useBrowser({
    bridge, activeSessionId: sid, sessionIds: ["old", "new"], tweaks: {},
    open: Boolean(openBy[sid]), setOpen: (on) => { openBy[sid] = on; },
  }));

  let ui = show("old");
  elements(ui);
  openBy.old = true; // app-live opens the side column
  ui = show("old");
  assert.equal(ui.open, true);
  await flush();
  ui = show("new"); // the old tab's effect is cleaned up
  assert.deepEqual(closed, ["old"]);
  openBy.new = true;
  ui = show("new");
  await flush();
  assert.deepEqual(opens.map((o) => o.sid), ["old", "new"]);
  opens[0].resolve(); // the old tab's open settles late
  await flush();
  screens[1].onResize(500, 350, 2);
  ui.openUrl("http://localhost:3000/new");
  assert.deepEqual(resized, [], "new resize remains queued while new open is pending");
  assert.deepEqual(navigated, [], "new URL remains queued while new open is pending");
  opens[1].resolve();
  await flush();
  assert.deepEqual(resized, [["new", 500, 350, 2]]);
  assert.deepEqual(navigated, [["new", "http://localhost:3000/new"]]);

  // Rust's state is the annotate truth; a pick captured across a restart is dropped.
  states.get("new")({ status: "running", annotate: true });
  ui = show("new");
  assert.equal(ui.annotate, true);
  const picking = picks.get("new")({ rect: { x: 0, y: 0, w: 10, h: 10 }, docRect: { x: 0, y: 0, w: 10, h: 10 } });
  ui.restart();
  ui = show("new");
  assert.equal(ui.annotate, false, "restart leaves annotate mode");
  capture({ ok: true, value: { data: "AA==", mimeType: "image/png" } });
  await picking;
  ui = show("new");
  assert.equal(ui.pending, null, "pre-restart capture cannot create a stale popover");

  // Esc while the popover is open closes it (and is the panel's); Rust
  // turning annotate off (the agent acted) is mirrored.
  states.get("new")({ status: "running", annotate: true });
  ui = show("new");
  const second = picks.get("new")({ rect: { x: 0, y: 0, w: 10, h: 10 }, docRect: { x: 0, y: 0, w: 10, h: 10 } });
  capture({ ok: false, error: "page moved" });
  await second;
  ui = show("new");
  assert.equal(ui.pending.image, null, "a failed capture still opens the popover, text only");
  assert.equal(screens[1].escape(), "cancelPick");
  screens[1].onEscape("cancelPick");
  ui = show("new");
  assert.equal(ui.pending, null);
  assert.equal(screens[1].escape(), "leaveAnnotate");
  states.get("new")({ status: "running", annotate: false });
  ui = show("new");
  assert.equal(ui.annotate, false);
  assert.equal(screens[1].escape(), null);

  // Leaving annotate mode ends an open pick: turned off by hand, or by Rust
  // (the agent acted on the page). Turning it back on brings no old popover.
  const openPick = async () => {
    states.get("new")({ status: "running", annotate: true });
    ui = show("new");
    const p = picks.get("new")({ rect: { x: 0, y: 0, w: 10, h: 10 }, docRect: { x: 0, y: 0, w: 10, h: 10 } });
    capture({ ok: true, value: { data: "AA==", mimeType: "image/png" } });
    await p;
    ui = show("new");
    assert.ok(ui.pending, "the pick opened the popover");
  };
  await openPick();
  ui.setAnnotate(false);
  ui = show("new");
  assert.equal(ui.pending, null, "annotate off by hand closes the popover");
  states.get("new")({ status: "running", annotate: false }); // Rust confirms
  states.get("new")({ status: "running", annotate: true });
  ui = show("new");
  assert.equal(ui.pending, null, "turning annotate on again brings no old popover");
  await openPick();
  states.get("new")({ status: "running", annotate: false });
  ui = show("new");
  assert.equal(ui.pending, null, "annotate off by Rust closes the popover");
  unmount();
  assert.deepEqual(closed, ["old", "new"]);
});

test("hook: a retained terminal opener ignores clicks from an inactive tab", async () => {
  const { React, render, unmount } = fakeReact();
  const window = { OMP_BROWSER_SCREEN: { createScreen: () => ({ frame() {}, destroy() {}, size: () => ({ width: 1, height: 1, dpr: 1 }) }) } };
  loadHelpers(window);
  const useBrowser = runInNewContext(source("src/app/use-browser.jsx") + "\nuseBrowser", { window, React });
  const navigated = [];
  const external = [];
  const bridge = {
    browserOpenPanel: () => Promise.resolve(),
    browserNavigate: (...args) => navigated.push(args),
    browserClosePanel() {},
    openExternalUrl: (url) => { external.push(url); return Promise.resolve({ ok: true }); },
  };
  const openBy = {};
  const show = (sid) => render(() => useBrowser({
    bridge, activeSessionId: sid, sessionIds: ["a", "b"], tweaks: {},
    open: Boolean(openBy[sid]), setOpen: (on) => { openBy[sid] = on; },
  }));

  let ui = show("a");
  const retained = ui.openLink;
  ui = show("b");
  retained("a", "http://localhost:3000/from-a", false);
  retained("a", "https://example.test/from-a", true);
  await flush();
  assert.deepEqual(navigated, []);
  assert.deepEqual(external, []);
  assert.equal(openBy.b, undefined, "the active tab's panel is not opened");

  openBy.a = true;
  ui = show("a");
  ui.canvasRef.current = {};
  ui.viewRef.current = {};
  ui.sinkRef.current = {};
  await flush();
  assert.deepEqual(navigated, []);
  unmount();
});

test("hook: disposed and replaced terminal link callbacks stay inert", async () => {
  const { React, render, unmount } = fakeReact();
  const callbacks = [];
  const opened = [];
  const window = {
    OMP_TERMINAL: {
      EMPTY: {}, openPanel: (s) => s, togglePanel: (s) => s, applyStatus: (s) => s,
      applyExit: (s) => s, spawnFailed: (s) => s, needsSpawn: () => false,
      shellLive: () => false, canRestart: () => false,
      entryOf: () => ({ open: false, created: true, status: null, error: null }),
    },
    OMP_SESSION_UI: { pruneEntries: (s) => s },
    OMP_TERMINAL_XTERM: {
      SKIPPED_LINE: "", exitLine: () => "", failLine: () => "", theme: () => ({}),
      applyWindowsPty() {}, scrollbackLines: () => 5000, copySelection: () => false,
      createXterm(options) {
        callbacks.push(options.onLink);
        return { term: {
          open() {}, refresh() {}, dispose() {}, reset() {}, write() {}, focus() {},
          options: {}, cols: 80, rows: 24,
        }, fit: { fit() {} } };
      },
    },
    OMP_TERMINAL_STREAM: {
      EMPTY: { syncing: 0 }, beginSync: (s) => ({ ...s, syncing: 1 }),
      onEvent: (s) => ({ stream: s, actions: [] }), replayCursor: () => ({ instance: 0, afterSeq: 0 }),
      onReplay: (s) => ({ stream: s, actions: [] }), endSync: (s) => ({ stream: { ...s, syncing: 0 }, actions: [] }),
      onAttach: (s) => ({ stream: s, actions: [] }), onOpened: (s) => ({ stream: s, actions: [] }),
    },
    OMP_BROWSER: { terminalLinkClick: (url) => ({ url, external: false }) },
    OMP_KEYMAP: { detectMac: () => true },
  };
  const bridge = {
    onTerminalData: () => ({ stop() {}, ready: Promise.resolve() }),
    onTerminalExit: () => ({ stop() {}, ready: Promise.resolve() }),
    terminalStatus: () => Promise.resolve(null),
    terminalReplay: () => Promise.resolve(null),
  };
  const useTerminal = runInNewContext(source("src/app/use-terminal.jsx") + "\nuseTerminal", {
    window, React, ResizeObserver: class { observe() {} disconnect() {} },
    setTimeout, clearTimeout, console,
  });
  let ids = ["a", "b"];
  const show = () => render(() => useTerminal({
    bridge, activeSessionId: "b", sessionIds: ids, tweaks: {}, setTweak() {},
    appearance: {}, openLink: (...args) => opened.push(args),
  }));

  let ui = show();
  ui.mountFor("a")({});
  const event = { preventDefault() {} };
  callbacks[0](event, "http://localhost:3000/a");
  assert.deepEqual(opened, [["a", "http://localhost:3000/a", false]]);

  ids = ["b"];
  ui = show();
  callbacks[0](event, "http://localhost:3000/disposed");
  assert.equal(opened.length, 1, "disposed callback ignored");

  ids = ["a", "b"];
  ui = show();
  ui.mountFor("a")({});
  callbacks[0](event, "http://localhost:3000/replaced");
  assert.equal(opened.length, 1, "replaced record's old callback ignored");
  callbacks[1](event, "http://localhost:3000/new-a");
  assert.deepEqual(opened.at(-1), ["a", "http://localhost:3000/new-a", false]);
  await flush();
  unmount();
});

test("hook: a localhost chat link opens in the panel; a modifier click goes to the system browser", () => {
  const { React, render } = fakeReact();
  const window = { OMP_BROWSER_SCREEN: { createScreen: () => ({ frame() {}, destroy() {}, size: () => ({ width: 1, height: 1, dpr: 1 }) }) } };
  loadHelpers(window);
  const useBrowser = runInNewContext(source("src/app/use-browser.jsx") + "\nuseBrowser", { window, React });
  const external = [];
  const bridge = { openExternalUrl: (url) => { external.push(url); return Promise.resolve({ ok: true }); } };
  const openBy = {};
  const show = (tweaks) => render(() => useBrowser({
    bridge, activeSessionId: "s", sessionIds: ["s"], tweaks,
    open: Boolean(openBy.s), setOpen: (on) => { openBy.s = on; },
  }));
  const click = (href, over = {}) => {
    const a = { getAttribute: () => href };
    return { button: 0, defaultPrevented: false, target: { closest: () => a }, preventDefault() { this.defaultPrevented = true; }, ...over };
  };
  const ui = show({});
  const e = click("http://localhost:3000/a");
  ui.onChatClick(e);
  assert.equal(e.defaultPrevented, true);
  assert.equal(openBy.s, true, "the panel opens to load it");
  const other = click("https://example.com/");
  ui.onChatClick(other);
  assert.equal(other.defaultPrevented, false, "not this machine: left to the webview");
  const mod = click("http://localhost:3000/b", { ctrlKey: true });
  ui.onChatClick(mod);
  assert.deepEqual(external, ["http://localhost:3000/b"]);
  assert.equal(show({ browserLocalhostInPanel: false }).onChatClick, null, "tweak off: no routing");
});
