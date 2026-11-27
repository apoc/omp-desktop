#!/usr/bin/env node
// Regression script for src/design/settings/rows-agent.jsx — the three
// switches Settings → Agent owns on omp's own config (#92): the goal's
// auto-continue, auto-compaction and retry. Each row is rendered under a
// React stand-in with the real hooks behind it (app/use-omp-setting.jsx,
// app/use-goal-mode.jsx), and the test talks to what reaches the bridge
// and to the elements the row returns (Row, Toggle, the status span).
// Run: node tests/test-rows-agent.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createContext, runInContext } from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const Babel = createRequire(import.meta.url)(join(root, "src/babel.min.js"));
const source = path => readFileSync(join(root, path), "utf8");
const compile = path => Babel.transform(source(path), { presets: ["react"] }).code;
// Compiled once: every test runs them in a fresh context.
const hookFiles = ["src/app/use-omp-setting.jsx", "src/app/use-goal-mode.jsx"].map(compile);
const rowsFile = compile("src/design/settings/rows-agent.jsx");

let passed = 0;
async function check(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`FAILED: ${label}`);
    throw err;
  }
  passed++;
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/** The rows and their hooks in one window, under a React stand-in that keeps
 *  state per call position and runs effects during the render. `render(type,
 *  ctx)` renders the row of `type` and returns its element tree with every
 *  function component expanded (Row and Toggle are inert string types). */
function rows() {
  const slots = [];
  let i = 0;
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((v, k) => !Object.is(v, b[k]));
  const React = {
    Fragment: "fragment",
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(init) {
      const k = i++;
      if (!(k in slots)) slots[k] = { value: init };
      const s = slots[k];
      return [s.value, v => { s.value = typeof v === "function" ? v(s.value) : v; }];
    },
    useRef(init) { const k = i++; return (slots[k] ??= { current: init }); },
    useEffect(fn, deps) {
      const k = i++;
      if (!slots[k] || changed(slots[k].deps, deps)) { slots[k] = { deps }; fn(); }
    },
  };
  const t = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (_, k) => vars[k]) : s);
  const window = { SettingsRow: "Row", SettingsToggle: "Toggle", OMP_I18N: { t }, OMP_TR: t };
  // goal-mode's top-level destructures, as index.html's earlier scripts leave them.
  new Function("window", source("src/app/session-ui.js"))(window);
  new Function("window", source("src/app/goal.js"))(window);
  window.GoalStrip = () => null;
  window.OMP_TURN_STATUS = { isBusyRunState: () => false };
  const context = createContext({ window, React, OMP_TR: t });
  for (const code of [rowsFile, ...hookFiles]) runInContext(code, context);

  const expand = node => {
    if (Array.isArray(node)) return node.map(expand);
    if (!node || typeof node !== "object") return node;
    if (typeof node.type === "function") return expand(node.type({ ...node.props, children: node.children }));
    return { ...node, children: node.children.map(expand) };
  };
  const row = type => ({ label: `Label of ${type}`, desc: `Description of ${type}.` });
  return {
    row,
    render: (type, ctx) => { i = 0; return expand(window.OMP_SETTINGS_ROWS[type]({ row: row(type), ctx, query: "" })); },
  };
}

/** Elements of `tree` (depth first) for which `match` holds. */
function findAll(tree, match, out = []) {
  if (Array.isArray(tree)) { for (const n of tree) findAll(n, match, out); return out; }
  if (!tree || typeof tree !== "object") return out;
  if (match(tree)) out.push(tree);
  findAll(tree.children, match, out);
  return out;
}
const one = (tree, match) => {
  const hits = findAll(tree, match);
  assert.equal(hits.length, 1, `${hits.length} matches`);
  return hits[0];
};
/** What the row shows: its Row element, its status span, its Toggle, its error line. */
function view(tree) {
  const toggles = findAll(tree, n => n.type === "Toggle");
  const status = findAll(tree, n => n.type === "span" && n.props.className === "st-ro");
  const errors = findAll(tree, n => n.props?.className === "st-row-error");
  return {
    row: one(tree, n => n.type === "Row"),
    toggle: toggles[0] ?? null,
    status: status[0]?.children.join("") ?? null,
    error: errors[0]?.children.join("") ?? null,
  };
}

/** A bridge for all three rows: every call waits for `answer(n, reply)`, and
 *  is recorded as `{kind, setting, profile, enabled?}`; `setting` is the row's
 *  type (`goalContinue` for the goal's own bridge calls). */
function fakeBridge() {
  const calls = [];
  const pending = [];
  const call = (kind, setting, profile, enabled) => {
    const entry = kind === "get" ? { kind, setting, profile } : { kind, setting, profile, enabled };
    calls.push(entry);
    return new Promise(resolve => pending.push(resolve));
  };
  return {
    bridge: {
      goalContinuation: profile => call("get", "goalContinue", profile),
      setGoalContinuation: (profile, enabled) => call("set", "goalContinue", profile, enabled),
      ompSetting: (profile, setting) => call("get", setting, profile),
      setOmpSetting: (profile, setting, enabled) => call("set", setting, profile, enabled),
    },
    calls,
    /** Settles the oldest unanswered call. */
    answer: async reply => { pending.shift()(reply); await flush(); },
  };
}

const ctxFor = (bridge, over = {}) => ({
  bridge,
  goal: { profileId: "work" },
  profiles: [{ id: "work", name: "Work profile" }, { id: "default", name: "Default" }],
  ...over,
});

const TYPES = ["goalContinue", "autoCompaction", "autoRetry"];

for (const type of TYPES) {
  await check(`${type}: reads its own setting of the tab's profile and says "reading…" until omp answers`, async () => {
    const f = fakeBridge();
    const h = rows();
    const shown = view(h.render(type, ctxFor(f.bridge)));
    assert.deepEqual(f.calls, [{ kind: "get", setting: type, profile: "work" }]);
    assert.equal(shown.status, "reading…");
    assert.equal(shown.toggle, null);
    assert.equal(shown.error, null);
    assert.equal(shown.row.props.label, h.row(type).label);
  });

  await check(`${type}: the description names the profile by its name, after the row's own text`, async () => {
    const f = fakeBridge();
    const h = rows();
    const desc = view(h.render(type, ctxFor(f.bridge))).row.props.desc;
    assert.ok(desc.startsWith(h.row(type).desc), desc);
    assert.ok(desc.includes("Applies to profile “Work profile” (omp's config)"), desc);
    assert.ok(!desc.includes("“work”"), "the id is not shown while a name is known");
    // A profile the list does not know falls back to its id.
    const unknown = view(h.render(type, ctxFor(f.bridge, { profiles: [] }))).row.props.desc;
    assert.ok(unknown.includes("“work”"), unknown);
  });

  await check(`${type}: shows omp's value, either way`, async () => {
    for (const value of [true, false]) {
      const f = fakeBridge();
      const h = rows();
      h.render(type, ctxFor(f.bridge));
      await f.answer({ ok: true, value });
      const shown = view(h.render(type, ctxFor(f.bridge)));
      assert.equal(shown.toggle.props.value, value);
      assert.equal(shown.toggle.props.label, h.row(type).label);
      assert.equal(shown.status, null);
      assert.equal(shown.error, null);
    }
  });

  await check(`${type}: a failed read is "unavailable" with omp's reason and no toggle`, async () => {
    const f = fakeBridge();
    const h = rows();
    h.render(type, ctxFor(f.bridge));
    await f.answer({ ok: false, error: "omp is not installed" });
    const shown = view(h.render(type, ctxFor(f.bridge)));
    assert.equal(shown.status, "unavailable");
    assert.equal(shown.error, "omp is not installed");
    assert.equal(shown.toggle, null);
  });

  await check(`${type}: a toggle writes the setting for the profile and is ignored while the write is busy`, async () => {
    const f = fakeBridge();
    const h = rows();
    h.render(type, ctxFor(f.bridge));
    await f.answer({ ok: true, value: true });
    view(h.render(type, ctxFor(f.bridge))).toggle.props.onChange(false);
    assert.deepEqual(f.calls.slice(1), [{ kind: "set", setting: type, profile: "work", enabled: false }]);
    // A second click while the first write is in flight is dropped.
    view(h.render(type, ctxFor(f.bridge))).toggle.props.onChange(true);
    assert.equal(f.calls.length, 2, "no second write while busy");
    await f.answer({ ok: true, value: false });
    const settled = view(h.render(type, ctxFor(f.bridge)));
    assert.equal(settled.toggle.props.value, false);
    // Idle again: the next toggle writes.
    settled.toggle.props.onChange(true);
    assert.deepEqual(f.calls.slice(2), [{ kind: "set", setting: type, profile: "work", enabled: true }]);
  });

  await check(`${type}: a refused write keeps the toggle and shows omp's reason`, async () => {
    const f = fakeBridge();
    const h = rows();
    h.render(type, ctxFor(f.bridge));
    await f.answer({ ok: true, value: true });
    view(h.render(type, ctxFor(f.bridge))).toggle.props.onChange(false);
    await f.answer({ ok: false, error: "could not write config.yml" });
    const shown = view(h.render(type, ctxFor(f.bridge)));
    assert.equal(shown.toggle.props.value, true);
    assert.equal(shown.error, "could not write config.yml");
  });

  await check(`${type}: a tab without a profile reads nothing and names no profile`, async () => {
    const f = fakeBridge();
    const h = rows();
    const shown = view(h.render(type, ctxFor(f.bridge, { goal: null })));
    assert.deepEqual(f.calls, []);
    assert.equal(shown.status, "reading…");
    assert.equal(shown.row.props.desc, h.row(type).desc);
  });
}

console.log(`test-rows-agent: ${passed} checks passed`);
