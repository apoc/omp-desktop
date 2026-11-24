#!/usr/bin/env node
// Focused React-component regressions for Ompy's chat, inbox and Settings.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const Babel = createRequire(import.meta.url)(fileURLToPath(new URL("../src/babel.min.js", import.meta.url)));
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const changed = (a, b) => !a || !b || a.length !== b.length || a.some((v, k) => !Object.is(v, b[k]));

function component(path, globals = {}) {
  const slots = [];
  let slot = 0;
  const React = {
    Fragment: "fragment",
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    memo: value => value,
    useState(initial) {
      const k = slot++;
      if (!(k in slots)) slots[k] = { value: initial };
      const state = slots[k];
      return [state.value, value => { state.value = typeof value === "function" ? value(state.value) : value; }];
    },
    useEffect(fn, deps) {
      const k = slot++;
      if (!slots[k] || changed(slots[k].deps, deps)) {
        slots[k]?.cleanup?.();
        slots[k] = { deps, cleanup: fn() };
      }
    },
    useCallback: fn => fn,
    useRef: value => ({ current: value }),
    useId: () => "details",
  };
  const i18n = { t: text => text, plural: (n, one, other) => n === 1 ? one : other, useLocale() {} };
  const window = {
    OMP_I18N: i18n,
    OMP_TR: i18n.t,
    Icon: () => null,
    ...globals,
  };
  new Function("window", source("src/app/persona.js"))(window);
  const timers = new Map();
  let timerId = 0;
  const scope = {
    window, React, OMP_TR: i18n.t, OMP_I18N: i18n,
    isSubmitEnter: () => false, isSubmitKey: () => false,
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: id => timers.delete(id),
    setInterval: () => 1,
    clearInterval() {},
    console,
  };
  const { code } = Babel.transform(source(path), { presets: ["react"] });
  runInNewContext(code, scope, { filename: path });
  return {
    window, timers,
    render(fn) { slot = 0; return fn(); },
  };
}

function find(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const child of Array.isArray(node) ? node : node.children ?? []) {
    const hit = find(child, predicate);
    if (hit) return hit;
  }
  return null;
}
function findAll(node, predicate, found = []) {
  if (!node || typeof node !== "object") return found;
  if (predicate(node)) found.push(node);
  for (const child of Array.isArray(node) ? node : node.children ?? []) findAll(child, predicate, found);
  return found;
}
function text(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node !== "object") return String(node);
  return (Array.isArray(node) ? node : node.children ?? []).map(text).join("");
}

test("secret desktop inputs are password fields and settled answers render only the mask", () => {
  const answers = [];
  const h = component("src/design/chat/ask-bubble.jsx", {
    AskDialog: () => null,
    OMP_ASK_DIALOG: { selectRows: () => ({ group: "group", rows: [] }), collapsedSummary: () => null },
    OMP_APPROVAL: { approvalInfo: () => null },
  });
  const msg = { kind: "ask", id: "secret", sessionId: "ompy", method: "input", secret: true,
    title: "Password", answered: false, cancelled: false, answer: null, options: [] };
  let tree = h.render(() => h.window.AskBubble({ msg, onAnswer: (...args) => answers.push(args) }));
  const input = find(tree, node => node.type === "input");
  assert.equal(input.props.type, "password");
  input.props.onChange({ target: { value: "desktop-plaintext" } });
  tree = h.render(() => h.window.AskBubble({ msg, onAnswer: (...args) => answers.push(args) }));
  find(tree, node => node.type === "button" && text(node) === "Submit").props.onClick();
  assert.deepEqual(answers, [["secret", "desktop-plaintext"]]);
  tree = h.render(() => h.window.AskBubble({ msg: { ...msg, answered: true, answer: "••••••••" } }));
  assert.equal(find(tree, node => node.type === "input").props.value, "••••••••");
  assert.equal(text(tree).includes("desktop-plaintext"), false);
});

test("Ompy tool prompts offer no remember grants while project tabs keep them", () => {
  const h = component("src/design/chat/ask-bubble.jsx", {
    AskDialog: () => null,
    OMP_ASK_DIALOG: { selectRows: msg => ({ group: "radiogroup", rows: msg.options.map(label => ({ label })) }) },
    OMP_APPROVAL: { approvalInfo: () => ({ tool: "bash", head: "Allow tool: bash" }) },
  });
  const base = { kind: "ask", id: "approval", method: "select", title: "Allow tool: bash",
    answered: false, cancelled: false, answer: null, options: ["Approve", "Deny"] };
  for (const [sessionId, expected] of [["ompy", false], ["project", true]]) {
    const tree = h.render(() => h.window.AskBubble({ msg: { ...base, sessionId }, hasProjectPath: true }));
    assert.equal(text(tree).includes("Allow for this session"), expected);
    assert.equal(text(tree).includes("Always allow in this project"), expected);
  }
});

test("inbox notices render with their body and a working Dismiss action", async () => {
  const resolved = [];
  const bridge = {
    personaSchedule: async () => ({ ok: true, value: { scheduled: [] } }),
    personaResolve: async (...args) => { resolved.push(args); return { ok: true }; },
  };
  const h = component("src/design/persona-inbox-card.jsx", { useNow: () => [0] });
  const items = [{ id: "notice", kind: "notice", state: "open", createdAt: 1,
    title: "Approval expired", body: "Restart Ompy to continue." }];
  let tree = h.render(() => h.window.PersonaInboxCard({ status: { state: "running" }, items, bridge }));
  await flush();
  tree = h.render(() => h.window.PersonaInboxCard({ status: { state: "running" }, items, bridge }));
  assert.ok(text(tree).includes("Notices"));
  assert.ok(text(tree).includes("Approval expired"));
  assert.ok(text(tree).includes("Restart Ompy to continue."));
  find(tree, node => node.type === "button" && text(node) === "Dismiss").props.onClick();
  await flush();
  assert.deepEqual(resolved, [["notice", null]]);
});

test("running status before Enable resolves prevents the stale start failure", async () => {
  let statusListener;
  let finishEnable;
  const bridge = {
    onPersona: async (_name, listener) => { statusListener = listener; return () => {}; },
    personaStatus: async () => null,
    personaEnable: () => new Promise(resolve => { finishEnable = resolve; }),
  };
  const h = component("src/design/settings/rows-persona.jsx", {
    SettingsRow: "settings-row",
    SettingsToggle: "settings-toggle",
  });
  const row = { label: "Run Ompy", desc: "" };
  const render = () => h.render(() => h.window.OMP_SETTINGS_ROWS.personaEnable({ row, ctx: { bridge }, query: "" }));
  let tree = render();
  await flush();
  tree = render();
  find(tree, node => node.type === "settings-toggle").props.onChange(true);
  statusListener({ state: "running", settings: {} });
  finishEnable({ ok: true });
  await flush();
  tree = render();
  for (const timer of [...h.timers.values()]) timer.fn();
  tree = render();
  assert.equal(text(tree).includes("Ompy did not start"), false);
});

test("a status matching the later command result clears the pending intent instead of resurrecting it", async () => {
  let statusListener;
  let finishEnable;
  const bridge = {
    onPersona: async (_name, listener) => { statusListener = listener; return () => {}; },
    personaStatus: async () => null,
    personaEnable: () => new Promise(resolve => { finishEnable = resolve; }),
  };
  const h = component("src/design/settings/rows-persona.jsx", {
    SettingsRow: "settings-row",
    SettingsToggle: "settings-toggle",
  });
  const row = { label: "Run Ompy", desc: "" };
  const render = () => h.render(() => h.window.OMP_SETTINGS_ROWS.personaEnable({ row, ctx: { bridge }, query: "" }));
  render();
  await flush();
  let tree = render();
  find(tree, node => node.type === "settings-toggle").props.onChange(true);
  // The service reports running before `personaEnable` resolves, so the
  // later intent matches a status that is already on screen.
  statusListener({ state: "running", settings: {} });
  tree = render();
  finishEnable({ ok: true });
  await flush();
  tree = render();
  // The service stops again: a stale intent would flip the toggle back on
  // and start the "did not start" timer.
  statusListener(null);
  tree = render();
  assert.equal(find(tree, node => node.type === "settings-toggle").props.value, false,
    "the toggle follows the stopped service");
  assert.equal(h.timers.size, 0, "no stale start-failure timer");
  for (const timer of [...h.timers.values()]) timer.fn();
  tree = render();
  assert.equal(text(tree).includes("Ompy did not start"), false);
});

test("a completion after the status confirmed and then contradicted the intent does not resurrect it", async () => {
  let statusListener;
  let finishEnable;
  const bridge = {
    onPersona: async (_name, listener) => { statusListener = listener; return () => {}; },
    personaStatus: async () => ({ state: "running", settings: {} }),
    personaEnable: () => new Promise(resolve => { finishEnable = resolve; }),
  };
  const h = component("src/design/settings/rows-persona.jsx", {
    SettingsRow: "settings-row",
    SettingsToggle: "settings-toggle",
  });
  const row = { label: "Run Ompy", desc: "" };
  const render = () => h.render(() => h.window.OMP_SETTINGS_ROWS.personaEnable({ row, ctx: { bridge }, query: "" }));
  render();
  await flush();
  let tree = render();
  assert.equal(find(tree, node => node.type === "settings-toggle").props.value, true);
  // The service stops, so the row shows a stopped service.
  statusListener(null);
  tree = render();
  assert.equal(find(tree, node => node.type === "settings-toggle").props.value, false);
  // Enable starts; while the command is in flight the service reports
  // running and then stops again.
  find(tree, node => node.type === "settings-toggle").props.onChange(true);
  statusListener({ state: "running", settings: {} });
  tree = render();
  statusListener(null);
  tree = render();
  // The late completion must not flip the toggle back on for a service the
  // status already confirmed and then contradicted.
  finishEnable({ ok: true });
  await flush();
  tree = render();
  assert.equal(find(tree, node => node.type === "settings-toggle").props.value, false,
    "the completion resurrected an intent the status had already settled");
  assert.equal(h.timers.size, 0, "no stale start-failure timer");
  for (const timer of [...h.timers.values()]) timer.fn();
  tree = render();
  assert.equal(text(tree).includes("Ompy did not start"), false);
});
