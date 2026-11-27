#!/usr/bin/env node
// Regression script for src/design/thinking-menu.jsx — the composer's
// thinking pill and its level menu. A tab shows no level until omp reports
// one (a new tab, #92): the pill then says "thinking level" and the open
// menu ticks nothing. Rendered under a React stand-in that keeps state per
// call position and runs effects during the render.
// Run: node tests/test-thinking-menu.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const Babel = createRequire(import.meta.url)(join(root, "src/babel.min.js"));
const code = Babel.transform(readFileSync(join(root, "src/design/thinking-menu.jsx"), "utf8"), { presets: ["react"] }).code;

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

/** The menu for a tab whose model offers `levels`: `render(level)` renders it. */
function menu(levels = ["off", "low", "high"]) {
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
  const window = {
    Icon: "Icon",
    THINKING_LEVELS: { low: { hint: "light" }, high: { hint: "deep" } },
    modelKey: m => m.id,
    useMenuPick: () => ({ busy: false, error: null, pick: fn => fn(), close: () => {} }),
    usePopoverDismiss: () => {},
    menuKeyNav: () => {},
  };
  runInNewContext(code, { window, React, OMP_TR: s => s });
  const props = level => ({
    model: { id: "m1", name: "Model One" },
    level,
    cycleHint: "",
    onLoad: async () => levels,
    onSet: async () => {},
  });
  return { render: level => { i = 0; return window.ThinkingMenu(props(level)); } };
}

function findAll(tree, match, out = []) {
  if (Array.isArray(tree)) { for (const n of tree) findAll(n, match, out); return out; }
  if (!tree || typeof tree !== "object") return out;
  if (match(tree)) out.push(tree);
  findAll(tree.children, match, out);
  return out;
}
/** Every text the tree renders, joined. */
const textOf = tree => (Array.isArray(tree) ? tree.map(textOf).join("")
  : tree && typeof tree === "object" ? textOf(tree.children)
    : typeof tree === "string" ? tree : "");
const pill = tree => findAll(tree, n => n.props?.className === "composer-pill")[0];
const items = tree => findAll(tree, n => n.props?.role === "menuitemradio");
const ticked = tree => items(tree).filter(n => n.props["aria-checked"]);

/** Opens the menu and waits for omp's levels. */
async function opened(m, level) {
  pill(m.render(level)).props.onClick();
  m.render(level); // the open menu's effect asks omp for the levels
  await flush();
  return m.render(level);
}

await check("the pill shows the level omp reported", () => {
  assert.equal(textOf(pill(menu().render("high"))), "thinking · high");
});

await check("a tab with no level yet shows a plain pill, not a level word or a previous tab's level", () => {
  for (const level of [null, undefined]) {
    const text = textOf(pill(menu().render(level)));
    assert.equal(text, "thinking level");
    assert.ok(!/null|undefined|·/.test(text), text);
  }
});

await check("the open menu ticks the current level, and nothing when there is no level yet", async () => {
  const withLevel = await opened(menu(), "high");
  assert.deepEqual(items(withLevel).map(n => textOf(n).replace(/deep|light/, "")), ["off", "low", "high"]);
  assert.deepEqual(ticked(withLevel).map(n => textOf(n).replace(/deep/, "")), ["high"]);
  assert.equal(findAll(withLevel, n => n.type === "Icon" && n.props.name === "check").length, 1);

  const none = await opened(menu(), null);
  assert.equal(items(none).length, 3, "the levels are still offered");
  assert.deepEqual(ticked(none), []);
  assert.equal(findAll(none, n => n.type === "Icon" && n.props.name === "check").length, 0);
});

console.log(`test-thinking-menu: ${passed} checks passed`);
