#!/usr/bin/env node
// Phone protocol, markdown safety, browser wiring, and notification routing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const load = path => readFileSync(root + path, "utf8");
let passed = 0;
async function check(label, fn) {
  try { await fn(); } catch (err) { console.error(`FAILED: ${label}`); throw err; }
  passed++;
}
const C = createRequire(import.meta.url)(root + "src/remote/client.js");
const initial = () => ({ device: null, tabs: [], view: null, pending: {}, error: null });
await check("reduce applies hello and tabs without mutating previous state", () => {
  const before = initial();
  const hello = C.reduce(before, { t: "hello", deviceId: "d", name: "Phone" });
  assert.deepEqual(hello.device, { id: "d", name: "Phone" });
  const tabs = [{ id: "t", title: "Work", project: "/project", busy: true, hasAsk: true }];
  assert.deepEqual(C.reduce(hello, { t: "tabs", tabs }).tabs, tabs);
  assert.deepEqual(before, initial());
});
await check("reduce replaces view wholesale, including empty messages and asks", () => {
  const inner = { tabId: "t", busy: false, messages: [], asks: [] };
  const next = C.reduce({ ...initial(), view: { obsolete: true, asks: [{ id: "old" }] } }, { t: "view", view: inner });
  assert.deepEqual(next.view, inner);
  assert.equal(C.reduce(next, { t: "view", view: null }).view, null);
});
await check("reduce clears only acknowledged pending request and preserves failed ack text", () => {
  const before = { ...initial(), pending: { a: "prompt", b: "answer" } };
  const failed = C.reduce(before, { t: "ack", reqId: "a", ok: false, error: "question no longer open" });
  assert.deepEqual(failed.pending, { b: "answer" });
  assert.equal(failed.error, "question no longer open");
  assert.deepEqual(before.pending, { a: "prompt", b: "answer" });
  assert.deepEqual(C.reduce(failed, { t: "ack", reqId: "b", ok: true }).pending, {});
});
await check("reduce stores push-key and ignores unknown messages", () => {
  const state = C.reduce(initial(), { t: "push-key", key: "abc" });
  assert.equal(state.pushKey, "abc");
  assert.equal(C.reduce(state, { t: "unknown" }), state);
});
await check("reduce stores the theme sent from the desktop", () => {
  const theme = { id: "phosphor", tone: "dark", accent: "#C4FF3F" };
  const state = C.reduce(initial(), { t: "theme", theme });
  assert.deepEqual(state.theme, theme);
});
await check("actionFor builds answer, prompt and abort frames with unique request ids", () => {
  const answer = C.actionFor("answer", { tabId: "t", askId: "q", value: true });
  assert.equal(typeof answer.reqId, "string");
  const { reqId, ...frame } = answer;
  assert.deepEqual(frame, { t: "action", tabId: "t", kind: "answer", askId: "q", value: true });
  const prompt = C.actionFor("prompt", { tabId: "t", text: "Hi" });
  assert.equal(prompt.text, "Hi");
  assert.notEqual(prompt.reqId, reqId);
  const abort = C.actionFor("abort", { tabId: "t" });
  assert.deepEqual(Object.keys(abort).sort(), ["kind", "reqId", "t", "tabId"]);
});
await check("askControls supports select, confirm, input and editor", () => {
  assert.deepEqual(C.askControls({ kind: "select", options: ["One", { label: "Two", value: "two" }] }),
    [{ label: "One", value: "One" }, { label: "Two", value: "two" }]);
  assert.deepEqual(C.askControls({ kind: "confirm" }), [{ label: "Confirm", value: true }, { label: "Deny", value: false }]);
  assert.deepEqual(C.askControls({ kind: "input" }), { input: true, multiline: false });
  assert.deepEqual(C.askControls({ kind: "editor" }), { input: true, multiline: true });
});
await check("backoff starts at one second and caps at thirty seconds", () => {
  assert.equal(C.backoff(0), 1000);
  assert.equal(C.backoff(1), 2000);
  assert.equal(C.backoff(10), 30000);
});
await check("pairCodeFromScan accepts only this origin with a #pair= fragment", () => {
  const origin = "https://phone.test:7470";
  assert.equal(C.pairCodeFromScan(`${origin}/#pair=abc`, origin).code, "abc");
  assert.equal(C.pairCodeFromScan(`${origin}/path#pair=xyz-123`, origin).code, "xyz-123");
  assert.equal(C.pairCodeFromScan("https://other.test/#pair=abc", origin).other, true);
  assert.equal(C.pairCodeFromScan("not a url", origin), null);
  assert.equal(C.pairCodeFromScan(`${origin}/#other=abc`, origin), null);
  assert.equal(C.pairCodeFromScan(`${origin}/`, origin), null);
});

// Reuse tests/test-markdown.mjs's real-library DOM-stub harness. A textarea
// decodes references without parsing user HTML into live DOM elements.
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', colon: ":", Tab: "\t", NewLine: "\n" };
const document = {
  createElement: () => {
    let value = "";
    return {
      set innerHTML(ref) {
        const m = /^&(?:#(\d+)|#[xX]([\da-fA-F]+)|([A-Za-z][A-Za-z\d]*));$/.exec(ref);
        value = !m ? ref : m[1] ? String.fromCodePoint(+m[1])
          : m[2] ? String.fromCodePoint(parseInt(m[2], 16)) : NAMED[m[3]] ?? ref;
      },
      get value() { return value; },
    };
  },
};
const markdown = vm.createContext({ document, console, URL });
markdown.window = markdown;
for (const f of ["marked.min.js", "highlight.min.js", "app/marked-setup.js"])
  vm.runInContext(load("src/" + f), markdown, { filename: f });
// VM top-level `var hljs` cannot be deleted from its contextified global.
// Expose the configured libraries through an ordinary window object so
// deleting window.hljs actually exercises the client's missing-library guard.
markdown.window = { marked: markdown.marked, hljs: markdown.hljs, OMP_MARKDOWN: markdown.OMP_MARKDOWN };
vm.runInContext(load("src/remote/client.js"), markdown);
const phone = markdown.window.OMP_REMOTE_CLIENT;
await check("phone page escapes raw HTML and neutralises javascript links", () => {
  const html = phone.renderMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1))');
  assert.ok(html.includes("&lt;img"), html);
  assert.doesNotMatch(html, /href="javascript:/i);
  for (const text of ["x <code> <img/src=x onerror=alert(1)>", "[x](&#106;avascript:alert(1))"])
    assert.doesNotMatch(phone.renderMarkdown(text), /<img|href="javascript:/i);
  delete markdown.window.hljs;
  assert.throws(() => phone.renderMarkdown("hello"), /highlight|hljs/i);
});
await check("phone HTML forbids inline scripts, handlers and styles and keeps PWA meta tags", () => {
  const html = load("src/remote/index.html");
  assert.doesNotMatch(html, /<script\b(?![^>]*\ssrc=)[^>]*>|<[a-z][^>]*\son[a-z]+\s*=|<style\b|\sstyle\s*=/i);
  assert.match(html, /<link rel="manifest" href="\/manifest.json">/);
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /<meta charset="utf-8">/);
});

// Browser APIs are unavailable in Node. Keep real phone modules;
// fake only DOM, network, storage and service-worker boundaries.
let focused = null;
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.listeners = {}; this.value = ""; this.disabled = false;
    this.hidden = false; this._text = "";
    this.style = { removeProperty() {}, setProperty() {} };
    const classes = new Set();
    this.classList = {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      toggle: (c, force) => { if (force) classes.add(c); else classes.delete(c); },
      contains: c => classes.has(c),
    };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
  set innerHTML(value) { this.markup = value; }
  get firstElementChild() { return this.children[0]; }
  pause() {}
  async play() {}
  srcObject = null;
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text = ""; this.children = nodes; }
  setAttribute(name, value) { assert.notEqual(name, "style"); this[name] = value; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  async emit(name) { return this.listeners[name]?.({ preventDefault() {}, target: this }); }
  focus() { focused = this; }
}
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function browser({ pair = false, token = "saved-token", standalone = true, pairStatus = 200 } = {}) {
  const app = new Element("main");
  const windowHandlers = {}, docHandlers = {};
  const frames = [], sockets = [], timers = [], requests = [], registrations = [];
  const storage = new Map(token ? [["omp-remote-token", token]] : []);
  const location = { protocol: "https:", host: "phone.test:7470", pathname: "/", search: "?tab=t", hash: pair ? "#pair=code" : "" };
  const registration = { pushManager: {
    async getSubscription() { return null; },
    async subscribe(options) { assert.equal(options.userVisibleOnly, true); assert.ok(options.applicationServerKey.length); return { toJSON: () => ({ endpoint: "https://push.test", keys: { auth: "a", p256dh: "p" } }) }; },
  } };
  const navigator = { userAgent: "Test Phone", standalone, serviceWorker: {
    async register(path) { registrations.push(path); return registration; },
    ready: Promise.resolve(registration),
  } };
  class WebSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 1; sockets.push(this); }
    send(raw) { frames.push(JSON.parse(raw)); }
    close() { this.readyState = 3; }
  }
  const resizers = [];
  class ResizeObserver { constructor(fn) { resizers.push(fn); } observe() {} }
  const ctx = vm.createContext({ console, URL, URLSearchParams, Uint8Array, atob, navigator, location, WebSocket, ResizeObserver,
    PushManager: class {}, Notification: { requestPermission: async () => "granted" },
    matchMedia: () => ({ matches: standalone }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    document: {
      hidden: false, addEventListener(name, fn) { (docHandlers[name] ??= []).push(fn); },
      get activeElement() { return focused; },
      createElement: tag => new Element(tag),
      getElementById: id => id === "app" ? app : null,
      documentElement: Object.assign(new Element("html"), { scrollTop: 0, scrollHeight: 1000, clientHeight: 500 }),
    },
    addEventListener(name, fn) { (windowHandlers[name] ??= []).push(fn); },
    history: { replaceState(_state, _title, url) { const next = new URL(url, "https://phone.test:7470/"); location.search = next.search; location.hash = next.hash; requests.push(["history", url]); } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    fetch: async (url, options) => { requests.push([url, JSON.parse(options.body)]); return { ok: pairStatus === 200, status: pairStatus, json: async () => ({ token: "paired-token", deviceId: "d" }) }; },
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearTimeout() {},
    setInterval: () => 1, clearInterval() {},
  });
  ctx.window = ctx;
  vm.runInContext(load("src/app/accent.js"), ctx);
  vm.runInContext(load("src/app/scroll-pin.js"), ctx);
  vm.runInContext(load("src/remote/client.js"), ctx);
  // Markdown safety itself uses the actual vendored libraries above.
  ctx.OMP_REMOTE_CLIENT.renderMarkdown = text => "SAFE:" + text;
  for (const f of ["scanner.js", "sessions.js", "transcript.js", "remote.js"])
    vm.runInContext(load("src/remote/" + f), ctx, { filename: f });
  const nodes = () => descendants(app);
  const button = text => nodes().find(n => n.tagName === "button" && n.textContent === text);
  const message = async data => { sockets.at(-1).onmessage({ data: JSON.stringify(data) }); await flush(); };
  const connect = async () => { await flush(); sockets.at(-1).onopen(); await message({ t: "hello", deviceId: "d", name: "Phone" }); };
  const scrollBox = nodes().find(n => n.className === "scroll");
  Object.assign(scrollBox, { scrollTop: 0, scrollHeight: 1000, clientHeight: 500 });
  const key = (name, extra = {}) => { for (const fn of docHandlers.keydown || []) fn({ key: name, preventDefault() {}, ...extra }); };
  const control = label => nodes().find(n => n.tagName === "button" && n["aria-label"] === label);
  const resize = () => { for (const fn of resizers) fn(); };
  return { app, nodes, button, control, resize, message, connect, sockets, frames, storage, timers, requests, registrations, ctx, windowHandlers, scrollBox, docHandlers, key };
}
const view = (busy = false) => ({ t: "view", view: { tabId: "t", busy, messages: [
  { id: "u", role: "user", text: "<img user>" },
  { id: "a", role: "assistant", text: "**reply**" },
  { id: "x", role: "tool", tool: { name: "read", summary: "<tool>", output: "<output>" } },
  { id: "h", role: "thinking", text: "secret thinking" },
], asks: [{ id: "q", kind: "confirm", title: "<Question>", message: "Allow?" }] } });
await check("a failed #pair= code falls back to the stored token and keeps it", async () => {
  const b = browser({ pair: true, token: "saved-token", pairStatus: 410 });
  await b.connect();
  assert.ok(b.requests.some(r => r[0] === "/pair"), "the code was tried");
  assert.equal(b.storage.get("omp-remote-token"), "saved-token");
  assert.equal(b.ctx.location.hash, "", "the spent code leaves the URL");
  assert.deepEqual(b.frames[0], { t: "auth", token: "saved-token" });
});
await check("a failed #pair= code without a stored token stays unpaired", async () => {
  const b = browser({ pair: true, token: null, pairStatus: 410 });
  await b.connect().catch(() => {});
  assert.equal(b.sockets.length, 0, "no socket without a token");
  assert.equal(b.storage.get("omp-remote-token"), undefined);
});
await check("pairing exchanges fragment, stores token, removes fragment, then authenticates first", async () => {
  const b = browser({ pair: true, token: null });
  await b.connect();
  assert.deepEqual(b.requests.find(r => r[0] === "/pair"), ["/pair", { code: "code", name: "Test Phone" }]);
  assert.equal(b.storage.get("omp-remote-token"), "paired-token");
  assert.equal(b.ctx.location.hash, "");
  assert.deepEqual(b.frames[0], { t: "auth", token: "paired-token" });
  assert.deepEqual({ ...b.frames[1], reqId: undefined }, { t: "select", tabId: "t", reqId: undefined });
  assert.ok(b.frames[1].reqId);
  assert.equal(b.sockets[0].url, "wss://phone.test:7470/ws");
});
await check("transcript and asks use text nodes; only assistant markdown receives rendered HTML", async () => {
  const b = browser(); await b.connect(); await b.message(view());
  assert.ok(b.app.textContent.includes("<img user>"));
  assert.ok(b.app.textContent.includes("<Question>"));
  assert.ok(!b.app.textContent.includes("secret thinking"));
  assert.ok(b.nodes().some(n => n.tagName === "details"));
  assert.deepEqual(b.nodes().filter(n => n.markup !== undefined).map(n => n.markup), ["SAFE:**reply**"]);
  await b.button("Deny").emit("click");
  assert.equal(b.frames.at(-1).kind, "answer");
  assert.equal(b.frames.at(-1).value, false);
  assert.equal(b.frames.at(-1).askId, "q");
});
await check("streaming views preserve live question input nodes and answer their current text", async () => {
  const b = browser(); await b.connect();
  const inner = { ...view(true).view, asks: [{ id: "input", kind: "input", title: "Name", message: "Enter name" }] };
  const message = { t: "view", view: inner };
  await b.message(message);
  const input = b.nodes().find(n => n.tagName === "input");
  input.value = "<typed>"; await input.emit("input");
  await b.message({ t: "view", view: { ...inner, messages: [] } });
  assert.equal(b.nodes().find(n => n.tagName === "input"), input);
  await b.button("Answer").emit("click");
  assert.equal(b.frames.at(-1).value, "<typed>");
  await b.message({ t: "view", view: { ...inner, asks: [] } });
  assert.ok(!b.nodes().some(n => n.tagName === "input"));
});
await check("composer sends prompt, steers with a draft while busy, stops with an empty one", async () => {
  const b = browser(); await b.connect(); await b.message(view());
  const draft = b.nodes().find(n => n.tagName === "textarea");
  assert.equal(draft.placeholder, "Message…"); assert.equal(draft["enterkeyhint"], "enter");
  assert.ok(b.control("Send").disabled, "empty idle draft disables send");
  draft.value = "hello"; await draft.emit("input"); await b.control("Send").emit("click");
  assert.equal(b.frames.at(-1).kind, "prompt"); assert.equal(b.frames.at(-1).text, "hello");
  assert.equal(draft.value, "", "a sent draft is cleared");
  await b.message(view(true));
  assert.equal(draft.placeholder, "Steer…");
  assert.equal(b.control("Stop").textContent, "■", "busy and empty draft shows stop");
  assert.ok(b.control("Stop").className.includes("stop"));
  draft.value = "redirect"; await draft.emit("input");
  assert.equal(b.control("Steer").textContent, "↑"); assert.ok(b.control("Steer").className.includes("steer"));
  await b.control("Steer").emit("click");
  assert.equal(b.frames.at(-1).kind, "steer"); assert.equal(b.frames.at(-1).text, "redirect");
  draft.value = "   "; await draft.emit("input");
  await b.control("Stop").emit("click"); assert.equal(b.frames.at(-1).kind, "abort");
});
await check("a pinned reader follows a shrinking transcript box; an unpinned one stays", async () => {
  const b = browser(); await b.connect();
  const root = b.scrollBox;
  await b.message(view());
  root.clientHeight = 300; b.resize();
  assert.equal(root.scrollTop, 700, "pinned: jumps to the new bottom");
  root.scrollTop = 100; root.listeners.scroll();
  root.clientHeight = 200; b.resize();
  assert.equal(root.scrollTop, 100, "unpinned: not moved");
});
await check("disconnect retries with backoff; revoked token stops reconnect and disables actions", async () => {
  const b = browser(); await b.connect(); await b.message(view(true));
  b.sockets[0].onclose({ code: 1006 });
  assert.equal(b.timers.at(-1).delay, 1000);
  assert.ok(b.control("Stop").disabled);
  b.timers.at(-1).fn(); await b.connect();
  b.sockets.at(-1).onclose({ code: 4401 });
  assert.equal(b.storage.has("omp-remote-token"), false);
  assert.match(b.app.textContent, /no longer paired/);
  assert.equal(b.timers.length, 1);
});
await check("tab removal clears view and prevents stale actions", async () => {
  const b = browser(); await b.connect();
  await b.message({ t: "tabs", tabs: [{ id: "t", title: "Tab", project: "Project", busy: true, hasAsk: true }] });
  await b.message(view()); await b.message({ t: "tabs", tabs: [] });
  assert.ok(b.control("Send").disabled);
  assert.ok(!b.app.textContent.includes("<img user>"));
});
await check("push opt-in registers worker and sends subscription only on user gesture", async () => {
  const b = browser(); await b.connect(); await b.message({ t: "push-key", key: "AQID" });
  assert.equal(b.registrations.length, 0);
  await b.button("Enable notifications").emit("click");
  assert.deepEqual(b.registrations, ["/sw.js"]);
  assert.deepEqual(b.frames.at(-1), { t: "push-subscribe", sub: { endpoint: "https://push.test", keys: { auth: "a", p256dh: "p" } } });
  assert.equal(b.button("Enable notifications").disabled, true, "pending until ack");
  await b.message({ t: "ack", reqId: null, kind: "push", ok: false, error: "bad subscription" });
  assert.equal(b.button("Enable notifications").disabled, false, "failed ack re-enables button for retry");
  await b.button("Enable notifications").emit("click");
  await b.message({ t: "ack", reqId: null, kind: "push", ok: true, error: null });
  assert.ok(b.button("Notifications enabled").disabled, "enabled after positive ack");
  b.sockets.at(-1).onclose({ code: 4401 });
  assert.ok(b.button("Enable notifications"), "4401 revocation resets notification button label");
  const tab = browser({ standalone: false }); await tab.connect(); await tab.message({ t: "push-key", key: "AQID" });
  assert.ok(tab.button("Enable notifications").hidden);
});
await check("service worker displays minimal payload and focuses selected tab or opens encoded URL", async () => {
  const handlers = {}, shown = [], opened = [], navigated = [];
  let windows = [], claimed = 0;
  const self = { addEventListener: (name, fn) => { handlers[name] = fn; },
    registration: { showNotification: async (...args) => shown.push(args) },
    clients: { matchAll: async () => windows, openWindow: async url => opened.push(url), claim: async () => { claimed++; } } };
  const ctx = vm.createContext({ self, URL, encodeURIComponent });
  vm.runInContext(load("src/remote/sw.js"), ctx);
  let work;
  handlers.push({ data: { json: () => ({ title: "OMP · Tab", body: "Question waiting", tag: "t", tab: "t /?" }) }, waitUntil(p) { work = p; } });
  await work;
  assert.equal(shown[0][0], "OMP · Tab");
  assert.equal(shown[0][1].data.tab, "t /?");
  const event = { notification: { data: { tab: "t /?" }, close() {} }, waitUntil(p) { work = p; } };
  handlers.notificationclick(event); await work;
  assert.deepEqual(opened, ["/?tab=t%20%2F%3F"]);
  windows = [{ navigate: async url => navigated.push(url), focus: async () => {} }];
  handlers.notificationclick(event); await work;
  assert.deepEqual(navigated, ["/?tab=t%20%2F%3F"]);
  let activated; handlers.activate({ waitUntil(p) { activated = p; } }); await activated;
  assert.equal(claimed, 1, "the worker claims open pages on activation");
  opened.length = 0;
  windows = [{ navigate: async () => { throw new Error("uncontrolled client"); }, focus: async () => {} }];
  handlers.notificationclick(event); await work;
  assert.deepEqual(opened, ["/?tab=t%20%2F%3F"], "a rejected navigate falls back to a new window");
});
await check("?tab= selects once; a later reconnect follows the current selection", async () => {
  const b = browser(); await b.connect();
  assert.deepEqual(b.requests.find(r => r[0] === "history"), ["history", "/"]);
  assert.deepEqual(b.frames.filter(f => f.t === "select").map(f => f.tabId), ["t"]);
  await b.message({ t: "view", view: { ...view().view, tabId: "other" } });
  b.sockets[0].onclose({ code: 1006 }); b.timers.at(-1).fn(); await b.connect();
  assert.deepEqual(b.frames.filter(f => f.t === "select").map(f => f.tabId), ["t", "other"]);
  const none = browser(); await none.connect();
  none.sockets[0].onclose({ code: 1006 }); none.timers.at(-1).fn(); await none.connect();
  assert.deepEqual(none.frames.filter(f => f.t === "select").map(f => f.tabId), ["t"], "a stale ?tab= is not replayed");
});
await check("tool details stay open across view updates", async () => {
  const b = browser(); await b.connect(); await b.message(view());
  const open = () => b.nodes().find(n => n.tagName === "details");
  open().open = true; await open().emit("toggle");
  await b.message(view());
  assert.equal(open().open, true);
  open().open = false; await open().emit("toggle");
  await b.message(view());
  assert.equal(open().open, false);
});
await check("opening a tab jumps to the end; new content keeps it pinned", async () => {
  const b = browser(); await b.connect();
  const root = b.scrollBox;
  await b.message(view());
  assert.equal(root.scrollTop, 500, "first render of a tab jumps to the bottom");
  root.scrollHeight = 1400;
  await b.message({ t: "view", view: { ...view().view, messages: [...view().view.messages, { id: "b", role: "assistant", text: "more" }] } });
  assert.equal(root.scrollTop, 900, "a pinned view follows new content");
  assert.equal(b.button("↓ Newest").hidden, true);
});
await check("scrolling up keeps the position and shows ↓ Newest, which jumps back", async () => {
  const b = browser(); await b.connect();
  const root = b.scrollBox;
  await b.message(view());
  root.scrollTop = 100; root.listeners.scroll();
  assert.equal(b.button("↓ Newest").hidden, false);
  root.scrollHeight = 1400;
  await b.message({ t: "view", view: { ...view().view, messages: [...view().view.messages, { id: "b", role: "assistant", text: "more" }] } });
  assert.equal(root.scrollTop, 100, "an unpinned reader is not moved");
  assert.equal(b.button("↓ Newest").hidden, false);
  await b.button("↓ Newest").emit("click");
  assert.equal(root.scrollTop, 900);
  assert.equal(b.button("↓ Newest").hidden, true);
});
await check("switching to another tab jumps to its end even when scrolled up", async () => {
  const b = browser(); await b.connect();
  const root = b.scrollBox;
  await b.message(view());
  root.scrollTop = 100; root.listeners.scroll();
  await b.message({ t: "view", view: { ...view().view, tabId: "other" } });
  assert.equal(root.scrollTop, 500);
  assert.equal(b.button("↓ Newest").hidden, true);
});
await check("dialog asks send one answer per question with options or custom text", async () => {
  const b = browser(); await b.connect();
  const questions = [
    { id: "a", question: "Pick one", options: [{ label: "X" }, { label: "Y" }], multi: false },
    { id: "b", question: "Pick any", options: [{ label: "P" }, { label: "Q" }], multi: true },
  ];
  await b.message({ t: "view", view: { ...view().view, asks: [{ id: "d", kind: "dialog", title: "T", message: "", questions }] } });
  await b.button("Answer").emit("click");
  assert.ok(b.frames.every(f => f.kind !== "answer"), "an unanswered pick-one question is not sent");
  await b.button("X").emit("click"); await b.button("P").emit("click"); await b.button("Q").emit("click");
  assert.equal(b.button("X")["aria-checked"], "true");
  assert.equal(b.button("Y")["aria-checked"], "false");
  const text = b.nodes().filter(n => n.tagName === "input")[0];
  text.value = " custom "; await text.emit("input");
  await b.button("Answer").emit("click");
  assert.deepEqual(b.frames.at(-1).value, [
    { id: "a", selectedOptions: [], customInput: "custom" },
    { id: "b", selectedOptions: ["P", "Q"] },
  ]);
});
await check("pick-any answers keep option order whatever order the buttons were pressed", async () => {
  const b = browser(); await b.connect();
  const questions = [{ id: "b", question: "Pick any", options: [{ label: "P" }, { label: "Q" }, { label: "R" }], multi: true }];
  await b.message({ t: "view", view: { ...view().view, asks: [{ id: "d", kind: "dialog", title: "T", message: "", questions }] } });
  await b.button("R").emit("click"); await b.button("P").emit("click"); await b.button("Q").emit("click");
  await b.button("Answer").emit("click");
  assert.deepEqual(b.frames.at(-1).value, [{ id: "b", selectedOptions: ["P", "Q", "R"] }]);
});
// Rust's build_action drops a frame without a non-empty reqId, so every
// select and action the phone builds must carry a unique one.
await check("every select and action frame carries a unique non-empty reqId", async () => {
  const b = browser(); await b.connect();
  await b.message({ t: "tabs", tabs: [{ id: "t", title: "One", project: "" }, { id: "u", title: "Two", project: "" }] });
  await b.message(view());
  await b.button("Two").emit("click");
  await b.message({ t: "view", view: { ...view().view, tabId: "u" } });
  const draft = b.nodes().find(n => n.tagName === "textarea");
  draft.value = "hello"; await draft.emit("input"); await b.control("Send").emit("click");
  await b.message({ t: "view", view: { ...view().view, tabId: "u", busy: true } });
  await b.control("Stop").emit("click");
  await b.button("Confirm").emit("click");
  const sent = b.frames.filter(f => f.t === "select" || f.t === "action");
  assert.ok(sent.filter(f => f.t === "select").length >= 2, "connect and tab click both select");
  assert.ok(sent.some(f => f.kind === "prompt") && sent.some(f => f.kind === "answer"));
  for (const frame of sent) assert.ok(typeof frame.reqId === "string" && frame.reqId !== "", JSON.stringify(frame));
  assert.equal(new Set(sent.map(f => f.reqId)).size, sent.length, "request ids are unique");
});
await check("clicking the active tab keeps its view; another tab clears it until the new view arrives", async () => {
  const b = browser(); await b.connect();
  await b.message({ t: "tabs", tabs: [{ id: "t", title: "One", project: "" }, { id: "u", title: "Two", project: "" }] });
  await b.message(view());
  await b.button("One").emit("click");
  assert.ok(b.app.textContent.includes("<img user>"), "the view stays");
  assert.equal(b.control("Send").disabled, true, "idle with an empty draft cannot send");
  const draft = b.nodes().find(n => n.tagName === "textarea");
  draft.value = "hi"; await draft.emit("input");
  assert.equal(b.control("Send").disabled, false, "a draft enables send");
  draft.value = ""; await draft.emit("input");
  await b.button("Two").emit("click");
  assert.ok(!b.app.textContent.includes("<img user>"));
  assert.ok(b.control("Send").disabled);
  const selectReq = b.frames.filter(f => f.t === "select").at(-1).reqId;
  await b.message({ t: "ack", reqId: selectReq, ok: false, error: "tab not available" });
  assert.ok(b.app.textContent.includes("<img user>"), "failed select ack restores the previous tab view");
  draft.value = "recover me"; await draft.emit("input"); await b.control("Send").emit("click");
  const promptReq = b.frames.filter(f => f.t === "action").at(-1).reqId;
  assert.equal(draft.value, "");
  await b.message({ t: "ack", reqId: promptReq, ok: false, error: "desktop could not deliver" });
  assert.equal(draft.value, "recover me", "rejected prompt restores the cleared draft");
});
await check("trackShown marks only unseen ids and forgets ids that left the view", () => {
  const first = C.trackShown(new Set(), [{ id: "a" }, { id: "b" }]);
  assert.deepEqual([...first.fresh], ["id:a", "id:b"]);
  const second = C.trackShown(first.shown, [{ id: "b" }, { id: "c" }]);
  assert.deepEqual([...second.fresh], ["id:c"]);
  assert.deepEqual([...second.shown], ["id:b", "id:c"]);
});
await check("repinFor follows the desktop rule: tab change and own prompts jump, echoed steers and streaming do not", () => {
  const P = (() => { const w = {}; new Function("window", load("src/app/scroll-pin.js"))(w); return w.OMP_SCROLL_PIN; })();
  const v = (tabId, messages) => ({ tabId, messages });
  const u = (id, extra = {}) => ({ id, role: "user", ...extra });
  const prev = { tabId: "t", lastId: "u1" };
  assert.equal(C.repinFor(P, prev, v("other", [u("u1")])), true);
  assert.equal(C.repinFor(P, prev, v("t", [u("u1"), { id: "a", role: "assistant" }])), false);
  assert.equal(C.repinFor(P, prev, v("t", [u("u1"), u("u2")])), true);
  assert.equal(C.repinFor(P, prev, v("t", [u("u1"), u("u2", { echo: true })])), false);
  assert.equal(C.repinFor(P, prev, v("t", [])), true);
  assert.equal(C.repinFor(P, prev, null), false);
});
await check("a streaming update replays the fade-in only on new rows", async () => {
  const b = browser();
  await b.connect();
  await b.message(view());
  const rows = () => b.nodes().filter(n => /^row (user|assistant|tool)/.test(String(n.className)));
  assert.ok(rows().length >= 3 && rows().every(r => r.className.includes("fade-up")));
  const next = view();
  next.view.messages.push({ id: "a2", role: "assistant", text: "more" });
  await b.message(next);
  const faded = rows().filter(r => r.className.includes("fade-up"));
  assert.equal(faded.length, 1, "only the new row fades in");
});
await check("ask card uses the desktop rail and body structure", async () => {
  const b = browser();
  await b.connect();
  await b.message(view());
  const ask = b.nodes().find(n => String(n.className).startsWith("row ask"));
  assert.deepEqual(ask.children.map(c => c.className), ["ass-rail", "ass-body"]);
});
await check("scan: cancel stops the camera and shows the pair button again", async () => {
  const b = browser({ token: null });
  let stopped = 0;
  b.ctx.navigator.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }] }) };
  await flush();
  await b.button("Pair with your desktop").emit("click");
  await flush();
  assert.equal(b.button("Pair with your desktop").hidden, true);
  assert.equal(b.button("Cancel").hidden, false);
  await b.button("Cancel").emit("click");
  assert.equal(stopped, 1);
  assert.equal(b.button("Pair with your desktop").hidden, false);
  assert.equal(b.button("Cancel").hidden, true);
});
await check("scan: denial in the installed app points to iOS settings, not Safari", async () => {
  const b = browser({ token: null });
  b.ctx.navigator.mediaDevices = { getUserMedia: async () => { throw new Error("denied"); } };
  await flush();
  await b.button("Pair with your desktop").emit("click");
  await flush();
  const hint = b.nodes().find(n => n.className === "scan-hint").textContent;
  assert.match(hint, /iOS Settings/);
  assert.doesNotMatch(hint, /Safari/);
  assert.equal(b.button("Pair with your desktop").hidden, false);
});
await check("projectName keeps only the last path segment", () => {
  assert.equal(C.projectName("/Users/me/work/omp-desktop"), "omp-desktop");
  assert.equal(C.projectName("/Users/me/work/omp-desktop///"), "omp-desktop");
  assert.equal(C.projectName("C:\\Users\\me\\proj\\"), "proj");
  assert.equal(C.projectName("C:\\Users/me\\mixed"), "mixed");
  assert.equal(C.projectName("plain"), "plain");
  assert.equal(C.projectName("/"), "");
  assert.equal(C.projectName(""), "");
  assert.equal(C.projectName(undefined), "");
});
await check("otherQuestionCount ignores the active tab and tabs without a question", () => {
  const tabs = [{ id: "a", hasAsk: true }, { id: "b", hasAsk: true }, { id: "c", hasAsk: false }, { id: "d" }];
  assert.equal(C.otherQuestionCount(tabs, "a"), 1);
  assert.equal(C.otherQuestionCount(tabs, "c"), 2);
  assert.equal(C.otherQuestionCount(tabs, null), 2);
  assert.equal(C.otherQuestionCount([], "a"), 0);
  assert.equal(C.otherQuestionCount(undefined, "a"), 0);
});
const sheetTabs = [
  { id: "t", title: "Work", project: "/Users/me/omp-desktop/", busy: true, hasAsk: false },
  { id: "u", title: "Other", project: "side", busy: false, hasAsk: true },
];
const find = (b, cls) => b.nodes().find(n => String(n.className).split(" ")[0] === cls);
await check("header shows the active tab with the folder name only, the dot and the other-question count", async () => {
  const b = browser(); await b.connect();
  await b.message({ t: "tabs", tabs: sheetTabs }); await b.message(view());
  const top = find(b, "top");
  assert.equal(top.tagName, "button");
  assert.equal(top["aria-haspopup"], "dialog");
  assert.equal(top["aria-expanded"], "false");
  assert.equal(find(b, "top-title").textContent, "Work");
  assert.equal(find(b, "top-project").textContent, "omp-desktop");
  assert.ok(!top.textContent.includes("/Users"), "the full path never shows");
  assert.match(find(b, "tab-run-dot").className, /running/);
  assert.equal(find(b, "top-count").hidden, false);
  assert.equal(find(b, "top-count").textContent, "1");
  assert.equal(find(b, "conn-dot").className, "conn-dot ok");
  await b.message({ t: "tabs", tabs: sheetTabs.map(t => ({ ...t, hasAsk: false })) });
  assert.equal(find(b, "top-count").hidden, true);
  b.sockets[0].onclose({ code: 1006 });
  assert.equal(find(b, "conn-dot").className, "conn-dot off");
});
await check("tapping the header opens the sheet; Esc, backdrop, handle swipe and selecting close it and return focus", async () => {
  const b = browser(); await b.connect();
  await b.message({ t: "tabs", tabs: sheetTabs }); await b.message(view());
  const top = find(b, "top"), sheet = find(b, "sheet"), backdrop = find(b, "sheet-backdrop"), handle = find(b, "sheet-handle");
  assert.equal(sheet.hidden, true); assert.equal(backdrop.hidden, true);
  assert.equal(sheet.role, "dialog"); assert.equal(sheet["aria-modal"], "true");
  const open = async () => { await top.emit("click"); assert.equal(sheet.hidden, false); assert.equal(backdrop.hidden, false); assert.equal(top["aria-expanded"], "true"); assert.equal(focused, sheet); };
  const closed = () => { assert.equal(sheet.hidden, true); assert.equal(backdrop.hidden, true); assert.equal(top["aria-expanded"], "false"); assert.equal(focused, top); };
  await open(); b.key("Escape"); closed();
  await open(); await backdrop.emit("click"); closed();
  await open(); await handle.emit("click"); closed();
  await open();
  handle.listeners.pointerdown({ clientY: 10 }); handle.listeners.pointermove({ clientY: 30 }); handle.listeners.pointerup({ clientY: 30 });
  assert.equal(sheet.hidden, false, "a short drag springs back");
  handle.listeners.pointerdown({ clientY: 10 }); handle.listeners.pointermove({ clientY: 120 }); handle.listeners.pointerup({ clientY: 120 });
  closed();
  await open();
  const row = b.nodes().find(n => String(n.className).startsWith("sheet-tab") && n.textContent.includes("Other"));
  await row.emit("click");
  closed();
  const select = b.frames.filter(f => f.t === "select").at(-1);
  assert.equal(select.tabId, "u"); assert.ok(select.reqId);
});
await check("sheet lists every tab with folder and dot, highlights the active one and holds the footer controls", async () => {
  const b = browser(); await b.connect(); await b.message({ t: "push-key", key: "AQID" });
  await b.message({ t: "tabs", tabs: sheetTabs }); await b.message(view());
  const sheet = find(b, "sheet");
  const rows = b.nodes().filter(n => String(n.className).startsWith("sheet-tab ") || n.className === "sheet-tab");
  assert.equal(rows.length, 2);
  assert.ok(rows[0].className.includes("active")); assert.ok(!rows[1].className.includes("active"));
  assert.equal(rows[0]["aria-current"], "true");
  assert.ok(rows[1].textContent.includes("side") && rows[1].textContent.includes("?"));
  assert.ok(sheet.textContent.includes("OMP Remote") && sheet.textContent.includes("Connected"));
  assert.ok(descendants(sheet).includes(b.button("Enable notifications")), "notifications live in the sheet");
  assert.ok(!b.app.children.some(c => c.tagName === "nav"), "the old tab tiles are gone");
});
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const fakeStream = counter => ({ getTracks: () => [{ stop: () => counter.stopped++ }] });
const scanHint = b => b.nodes().find(n => n.className === "scan-hint").textContent;
await check("scan race: a camera that arrives after Cancel is stopped and no denial is shown", async () => {
  const b = browser({ token: null }); const counter = { stopped: 0 }; const gum = deferred();
  b.ctx.navigator.mediaDevices = { getUserMedia: () => gum.promise };
  await flush();
  b.button("Pair with your desktop").emit("click");
  await b.button("Cancel").emit("click");
  gum.resolve(fakeStream(counter)); await flush();
  assert.equal(counter.stopped, 1, "the late stream's tracks are stopped");
  assert.equal(b.button("Pair with your desktop").hidden, false);
  assert.equal(b.button("Cancel").hidden, true);
  assert.equal(scanHint(b), "", "no hint after cancel");
});
await check("scan race: a late camera error after Cancel shows no denial; Cancel during play stops once", async () => {
  const b = browser({ token: null }); const gum = deferred();
  b.ctx.navigator.mediaDevices = { getUserMedia: () => gum.promise };
  await flush();
  b.button("Pair with your desktop").emit("click");
  await b.button("Cancel").emit("click");
  gum.reject(new Error("denied")); await flush();
  assert.equal(scanHint(b), "");
  const counter = { stopped: 0 }, play = deferred();
  const c = browser({ token: null });
  c.ctx.navigator.mediaDevices = { getUserMedia: async () => fakeStream(counter) };
  c.nodes().find(n => n.tagName === "video").play = () => play.promise;
  await flush();
  c.button("Pair with your desktop").emit("click"); await flush();
  await c.button("Cancel").emit("click");
  assert.equal(counter.stopped, 1);
  play.reject(new Error("AbortError")); await flush();
  assert.equal(counter.stopped, 1);
  assert.equal(scanHint(c), "");
  assert.equal(c.button("Pair with your desktop").hidden, false);
});
await check("scan race: a second Pair tap replaces the first scan without leaking a stream", async () => {
  const b = browser({ token: null }); const first = { stopped: 0 }, second = { stopped: 0 };
  const pending = [deferred(), deferred()]; let call = 0;
  b.ctx.navigator.mediaDevices = { getUserMedia: () => pending[call++].promise };
  await flush();
  b.button("Pair with your desktop").emit("click");
  b.button("Pair with your desktop").emit("click");
  pending[0].resolve(fakeStream(first)); pending[1].resolve(fakeStream(second)); await flush();
  assert.equal(first.stopped, 1, "the replaced scan's stream is stopped");
  assert.equal(second.stopped, 0, "the live scan keeps its camera");
  await b.button("Cancel").emit("click");
  assert.equal(second.stopped, 1);
});
await check("trackShown keys rows by id, else role and text, and tracks open asks", () => {
  assert.equal(C.messageKey({ id: "a", role: "user", text: "x" }), C.messageKey({ id: "a", role: "user", text: "y" }));
  assert.notEqual(C.messageKey({ role: "user", text: "x" }), C.messageKey({ role: "assistant", text: "x" }));
  assert.notEqual(C.messageKey({ role: "user", text: "x" }), C.messageKey({ role: "user", text: "y" }));
  const first = C.trackShown(new Set(), [{ role: "user", text: "hi" }], [{ id: "q" }]);
  assert.equal(first.fresh.size, 2);
  const second = C.trackShown(first.shown, [{ role: "user", text: "hi" }], [{ id: "q" }, { id: "r" }]);
  assert.deepEqual([...second.fresh], ["ask:r"], "existing rows and asks do not fade again");
  assert.equal(C.trackShown(second.shown, [], []).shown.size, 0, "keys that left are forgotten");
});
await check("an id-less row keeps its fade state when its position changes; existing ask cards do not re-fade", async () => {
  const b = browser(); await b.connect();
  const rows = cls => b.nodes().filter(n => String(n.className).startsWith(cls));
  await b.message({ t: "view", view: { tabId: "t", busy: false, messages: [{ role: "user", text: "hello" }], asks: [{ id: "q", kind: "confirm", title: "One", message: "" }] } });
  assert.ok(rows("row user")[0].className.includes("fade-up"));
  await b.message({ t: "view", view: { tabId: "t", busy: false, messages: [{ role: "assistant", text: "before" }, { role: "user", text: "hello" }],
    asks: [{ id: "q", kind: "confirm", title: "One", message: "" }, { id: "r", kind: "confirm", title: "Two", message: "" }] } });
  const user = rows("row user")[0], asks = rows("row ask");
  assert.ok(!user.className.includes("fade-up"), "the same text keeps its identity");
  assert.equal(asks.length, 2);
  assert.ok(!asks[0].className.includes("fade-up"), "the old ask does not replay the fade");
  assert.ok(asks[1].className.includes("fade-up"), "the new ask fades in");
});
await check("production-shaped synthetic ids: a row whose index shifts keeps its fade key", () => {
  const synthetic = (index, role, text) => ({ id: `${role}:${index}`, idSynthetic: true, role, text });
  const first = C.trackShown(new Set(), [synthetic(0, "user", "hello"), synthetic(1, "assistant", "hi")]);
  const second = C.trackShown(first.shown, [synthetic(1, "user", "hello"), synthetic(2, "assistant", "hi"), synthetic(3, "assistant", "new")]);
  assert.deepEqual([...second.fresh], [C.messageKey({ role: "assistant", text: "new" })], "only the new row is fresh");
  assert.equal(C.messageKey({ id: "user:0", idSynthetic: true, role: "user", text: "a" }), C.messageKey({ id: "user:9", idSynthetic: true, role: "user", text: "a" }));
  assert.equal(C.messageKey({ id: "real", role: "user", text: "a" }), "id:real", "a real id still wins");
});
console.log(`remote-client: ${passed} checks passed`);
