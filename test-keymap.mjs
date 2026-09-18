#!/usr/bin/env node
// Regression script for src/app/keymap.js chord algebra.
// No test framework, no bundler — zero dependencies beyond node:assert/strict.
// Run: node test-keymap.mjs  (or: npm run test:keymap)
//
// The file is a browser IIFE that writes to `window.OMP_KEYMAP`.  Load it by
// evaluating its source against a stub global; `detectMac()` tolerates a
// missing `navigator`, so no JSDOM is needed.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const src   = readFileSync(join(__dir, "src/app/keymap.js"), "utf8");
const win   = {};
// eslint-disable-next-line no-new-func
new Function("window", src)(win);
const K = win.OMP_KEYMAP;

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
}

// ── canonicalChord ────────────────────────────────────────────────────────────

check("canonicalChord: modifier reorder Alt+Shift+P", () =>
  assert.equal(K.canonicalChord("Alt+Shift+P"), "shift+alt+p"));

check("canonicalChord: Ctrl+P stays ctrl+p (no implied shift)", () =>
  assert.equal(K.canonicalChord("Ctrl+P"), "ctrl+p"));

check("canonicalChord: bare uppercase P implies shift", () =>
  assert.equal(K.canonicalChord("P"), "shift+p"));

check("canonicalChord: lowercase p unchanged", () =>
  assert.equal(K.canonicalChord("p"), "p"));

check("canonicalChord: Esc → escape", () =>
  assert.equal(K.canonicalChord("Esc"), "escape"));

check("canonicalChord: Return → enter", () =>
  assert.equal(K.canonicalChord("Return"), "enter"));

check("canonicalChord: CTRL+ALT+] case-insensitive, symbol base survives", () =>
  assert.equal(K.canonicalChord("CTRL+ALT+]"), "ctrl+alt+]"));

check("canonicalChord: super+K with modifier → no implied shift", () =>
  assert.equal(K.canonicalChord("super+K"), "super+k"));

check("canonicalChord: missing base returns empty string", () =>
  assert.equal(K.canonicalChord("ctrl+"), ""));

check("canonicalChord: whitespace-only returns empty string", () =>
  assert.equal(K.canonicalChord("   "), ""));

// ── chordFromEvent ────────────────────────────────────────────────────────────

check("chordFromEvent: ctrl+shift+p from event", () =>
  assert.equal(K.chordFromEvent({ key: "P", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }), "ctrl+shift+p"));

check("chordFromEvent: bare modifier returns null", () =>
  assert.equal(K.chordFromEvent({ key: "Control", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }), null));

check("chordFromEvent: alt+up from ArrowUp", () =>
  assert.equal(K.chordFromEvent({ key: "ArrowUp", ctrlKey: false, shiftKey: false, altKey: true, metaKey: false }), "alt+up"));

check("chordFromEvent: shifted symbol drops shift", () =>
  assert.equal(K.chordFromEvent({ key: "?", ctrlKey: false, shiftKey: true, altKey: false, metaKey: false }), "?"));

check("chordFromEvent: metaKey maps to super", () =>
  assert.equal(K.chordFromEvent({ key: "k", ctrlKey: false, shiftKey: false, altKey: false, metaKey: true }), "super+k"));

check("chordFromEvent: macOS Alt+M yields composed char — recover from e.code", () =>
  assert.equal(K.chordFromEvent({ key: "µ", code: "KeyM", ctrlKey: false, shiftKey: false, altKey: true, metaKey: false }), "alt+m"));

// ── resolve ───────────────────────────────────────────────────────────────────

check("resolve: empty config gives every action its defaultKeys", () => {
  const r = K.resolve(K.KEYMAP_ACTIONS, {});
  for (const a of K.KEYMAP_ACTIONS) {
    assert.deepEqual(r.byAction.get(a.id), a.defaultKeys, `action ${a.id}`);
  }
});

check("resolve: [] disables an action (beats default)", () => {
  const r = K.resolve(K.KEYMAP_ACTIONS, { "app.plan.toggle": [] });
  assert.deepEqual(r.byAction.get("app.plan.toggle"), []);
  assert.equal(r.byChord.get("shift+alt+p"), undefined);
});

check("resolve: bare string value is accepted and canonicalised", () => {
  const r = K.resolve(K.KEYMAP_ACTIONS, { "app.plan.toggle": "Ctrl+Shift+O" });
  assert.deepEqual(r.byAction.get("app.plan.toggle"), ["ctrl+shift+o"]);
});

check("resolve: configured chord beats default — two-pass semantics", () => {
  // desktop.tab.new default is ctrl+t. Explicitly bind it to ctrl+k.
  // ctrl+k is desktop.commands.open's *default* — the configured binding wins.
  const r = K.resolve(K.KEYMAP_ACTIONS, { "desktop.tab.new": "ctrl+k" });
  const winner = r.byChord.get("ctrl+k");
  assert.equal(winner, "desktop.tab.new",  // configured beats default, regardless of registry order
    `expected desktop.tab.new to win but got ${winner}`);
  assert.ok(r.conflicts.some(c => c.chord === "ctrl+k"), "conflict recorded");
  const conflict = r.conflicts.find(c => c.chord === "ctrl+k");
  assert.ok(conflict.actions.includes("desktop.tab.new"), "winner in conflict");
  assert.ok(conflict.actions.includes("desktop.commands.open"), "loser in conflict");
});

check("resolve: duplicate chords for one action are de-duplicated", () => {
  const r = K.resolve(K.KEYMAP_ACTIONS, { "app.plan.toggle": ["ctrl+x", "ctrl+x"] });
  assert.deepEqual(r.byAction.get("app.plan.toggle"), ["ctrl+x"]);
});

// ── Layer precedence (the load-bearing behaviour) ─────────────────────────────

check("resolve: overlay wins over omp layer per action", () => {
  const omp     = { "app.plan.toggle": ["shift+alt+o"] };
  const overlay = { "app.plan.toggle": ["ctrl+shift+o"] };
  const r = K.resolve(K.KEYMAP_ACTIONS, { ...omp, ...overlay });
  assert.deepEqual(r.byAction.get("app.plan.toggle"), ["ctrl+shift+o"]);
});

// ── allowedInInput ────────────────────────────────────────────────────────────

check("allowedInInput: ctrl+ combos allowed in input", () =>
  assert.equal(K.allowedInInput("ctrl+p"), true));

check("allowedInInput: escape allowed in input", () =>
  assert.equal(K.allowedInInput("escape"), true));

check("allowedInInput: shift+tab allowed in input", () =>
  assert.equal(K.allowedInInput("shift+tab"), true));

check("allowedInInput: F5 allowed in input", () =>
  assert.equal(K.allowedInInput("f5"), true));

check("allowedInInput: bare p not allowed in input", () =>
  assert.equal(K.allowedInInput("p"), false));

check("allowedInInput: shift+p not allowed in input", () =>
  assert.equal(K.allowedInInput("shift+p"), false));

// ── isTypingTarget ────────────────────────────────────────────────────────────

check("isTypingTarget: TEXTAREA is a typing target", () =>
  assert.equal(K.isTypingTarget({ tagName: "TEXTAREA" }), true));

check("isTypingTarget: contentEditable is a typing target", () =>
  assert.equal(K.isTypingTarget({ isContentEditable: true }), true));

check("isTypingTarget: DIV is not a typing target", () =>
  assert.equal(K.isTypingTarget({ tagName: "DIV" }), false));

// ── formatChord ───────────────────────────────────────────────────────────────

check("formatChord: shift+alt+p on non-Mac", () =>
  assert.equal(K.formatChord("shift+alt+p", false), "Shift+Alt+P"));

check("formatChord: shift+alt+p on Mac uses Option", () =>
  assert.equal(K.formatChord("shift+alt+p", true), "Shift+Option+P"));

check("formatChord: escape → Esc", () =>
  assert.equal(K.formatChord("escape", false), "Esc"));

check("formatChord: super on Mac → Cmd", () =>
  assert.equal(K.formatChord("super+k", true), "Cmd+K"));

// ── Registry integrity ────────────────────────────────────────────────────────

check("registry: all action ids are unique", () => {
  const ids = K.KEYMAP_ACTIONS.map(a => a.id);
  const set = new Set(ids);
  assert.equal(set.size, ids.length, "duplicate action id found");
});

check("registry: all defaultKeys are already canonical", () => {
  for (const a of K.KEYMAP_ACTIONS) {
    for (const k of a.defaultKeys) {
      assert.equal(K.canonicalChord(k), k, `${a.id} defaultKey ${k} is not canonical`);
    }
  }
});

check("registry: no duplicate chord across actions in the default set", () => {
  const seen = new Map();
  for (const a of K.KEYMAP_ACTIONS) {
    for (const k of a.defaultKeys) {
      if (seen.has(k)) {
        assert.fail(`chord ${k} claimed by both ${seen.get(k)} and ${a.id}`);
      }
      seen.set(k, a.id);
    }
  }
});

// ── Done ──────────────────────────────────────────────────────────────────────

console.log(`keymap: ${passed} checks passed`);
