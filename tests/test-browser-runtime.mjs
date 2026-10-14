import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const target = () => ({ addEventListener() {}, removeEventListener() {} });

test("screen schedules resize paint, publishes painted geometry, and releases bitmap", async () => {
  const frames = new Map();
  const painted = [];
  const pages = [];
  let next = 0;
  let observe;
  let closed = 0;
  const bitmap = { close: () => { closed++; } };
  const window = { ...target(), OMP_BROWSER: {}, devicePixelRatio: 2 };
  runInNewContext(source("src/app/browser-screen.js"), {
    window, Blob, atob, Uint8Array,
    createImageBitmap: async () => bitmap,
    requestAnimationFrame: (fn) => { frames.set(++next, fn); return next; },
    cancelAnimationFrame: (id) => frames.delete(id),
    ResizeObserver: class {
      constructor(fn) { observe = fn; }
      observe() {}
      disconnect() {}
    },
    setTimeout: () => 1, clearTimeout() {},
  });
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: (...args) => painted.push(args) }) };
  const view = { ...target(), getBoundingClientRect: () => ({ width: 400, height: 300 }) };
  const screen = window.OMP_BROWSER_SCREEN.createScreen({
    view, canvas, send() {}, onResize() {}, onPage: (page) => pages.push(page), swallowKey: () => false,
  });
  observe();
  assert.equal(frames.size, 1, "resize schedules paint");
  for (const [id, paint] of frames) { frames.delete(id); paint(); }
  assert.equal(canvas.width, 800);
  assert.equal(canvas.height, 600);
  screen.frame({ b64: "AA==", cssW: 400, cssH: 300 });
  await flush();
  assert.equal(pages.length, 0, "unpainted geometry stays unpublished");
  assert.equal(frames.size, 1, "decoded bitmap schedules another paint");
  for (const [id, paint] of frames) { frames.delete(id); paint(); }
  assert.deepEqual(painted, [[bitmap, 0, 0, 800, 600]]);
  assert.equal(pages[0].cssW, 400);
  assert.equal(pages[0].cssH, 300);
  screen.destroy();
  assert.equal(closed, 1);
  assert.equal(frames.size, 0);
});

test("stale open completion cannot release newer effect's queued resize and URL", async () => {
  const states = [];
  const refs = [];
  const effects = [];
  const screens = [];
  const opens = [];
  const resized = [];
  const navigated = [];
  let stateIndex = 0;
  let refIndex = 0;
  let effectIndex = 0;
  const picks = new Map();
  let capture;
  const React = {
    useState(initial) {
      const i = stateIndex++;
      if (!(i in states)) states[i] = initial;
      return [states[i], (value) => { states[i] = typeof value === "function" ? value(states[i]) : value; }];
    },
    useRef(initial) {
      const i = refIndex++;
      return refs[i] ??= { current: initial };
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect(fn) { effects[effectIndex++] = fn; },
  };
  const window = {
    OMP_BROWSER_SCREEN: { createScreen(options) {
      screens.push(options);
      return { frame() {}, destroy() {}, size: () => ({ width: 400, height: 300, dpr: 1 }) };
    } },
  };
  runInNewContext(source("src/app/image-attach.js"), { window });
  runInNewContext(source("src/app/browser.js"), { window });
  const useBrowser = runInNewContext(source("src/app/use-browser.jsx") + "\nuseBrowser", { window, React });
  const bridge = {
    onBrowserEvent(sid, kind, handler) {
      if (kind === "pick") picks.set(sid, handler);
      const off = () => {};
      off.ready = Promise.resolve();
      return off;
    },
    browserOpenPanel: (sid) => new Promise((resolve) => opens.push({ sid, resolve })),
    browserResize: (...args) => resized.push(args),
    browserNavigate: (...args) => navigated.push(args),
    browserClosePanel() {},
    browserAnnotate() {},
    browserCapture: () => new Promise(resolve => { capture = resolve; }),
  };
  const render = (sid) => {
    stateIndex = refIndex = effectIndex = 0;
    return useBrowser({ bridge, activeSessionId: sid, sessionIds: ["old", "new"] });
  };
  let ui = render("old");
  ui.toggle();
  ui = render("old");
  refs[0].current = {};
  refs[1].current = { ...target(), closest: () => null };
  const stopOld = effects[1]();
  await flush();
  stopOld();
  ui = render("new");
  ui.toggle();
  ui = render("new");
  const stopNew = effects[1]();
  await flush();
  assert.deepEqual(opens.map((open) => open.sid), ["old", "new"]);
  opens[0].resolve();
  await flush();
  screens[1].onResize(500, 350, 2);
  ui.openUrl("http://localhost:3000/new");
  assert.deepEqual(resized, [], "new resize remains queued while new open is pending");
  assert.deepEqual(navigated, [], "new URL remains queued while new open is pending");
  opens[1].resolve();
  await flush();
  assert.deepEqual(resized, [["new", 500, 350, 2]]);
  assert.deepEqual(navigated, [["new", "http://localhost:3000/new"]]);
  ui.setAnnotate(true);
  ui = render("new");
  assert.equal(ui.annotate, true);
  const picking = picks.get("new")({ rect: { x: 0, y: 0, w: 10, h: 10 } });
  ui.restart();
  ui = render("new");
  assert.equal(ui.annotate, false, "restart leaves annotate mode");
  capture({ ok: true, value: { data: "AA==", mimeType: "image/png" } });
  await picking;
  ui = render("new");
  assert.equal(ui.pending, null, "pre-restart capture cannot create a stale popover");
  stopNew();
});
