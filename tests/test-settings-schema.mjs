#!/usr/bin/env node
// Regression script for src/app/settings-schema.js — the Settings page's
// rows (#37): every tweak row names a real TWEAK_DEFAULTS key, bounds come
// from the owning modules, search over label/desc/keywords, the
// collapse-after row's visibility, theme-aware modified checks, badge
// counts and section resets.
// Run: node tests/test-settings-schema.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
// The schema loads before the modules it reads bounds from: they are read late.
for (const f of ["constants.js", "settings-schema.js", "accent.js", "chat-collapse.js", "prompt-history.js", "session-ui.js", "keymap.js", "backdrops.js"]) {
  // eslint-disable-next-line no-new-func
  new Function("window", readFileSync(join(root, "src/app", f), "utf8"))(win);
}
const S = win.OMP_SETTINGS;
const D = win.TWEAK_DEFAULTS;
const row = (id) => S.rows().find(r => r.id === id);
const vals = (edits = {}) => ({ ...D, ...edits });

let passed = 0;
function check(label, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`FAILED: ${label}`);
    throw err;
  }
  passed++;
}

check("sections in page order, separator before approvals", () => {
  assert.deepEqual(S.SECTIONS.map(s => s.id),
    ["appearance", "layout", "chat", "composer", "rail", "terminal", "browser", "agent", "session", "remote", "approvals", "shortcuts"]);
  assert.deepEqual(S.SECTIONS.filter(s => s.sep).map(s => s.id), ["approvals"]);
  for (const s of S.SECTIONS) assert.ok(s.icon && s.title && s.blurb && s.groups.length, s.id);
});

check("every tweak row names a TWEAK_DEFAULTS key whose default is valid", () => {
  const ids = new Set();
  for (const r of S.rows()) {
    assert.ok(!ids.has(r.id), `duplicate ${r.id}`);
    ids.add(r.id);
    assert.ok(r.label && r.desc, r.id);
    if (r.kind !== "tweak") continue;
    assert.ok(r.key in D, r.key);
    if (r.fold) continue;
    assert.equal(S.clamp(r, D[r.key]), D[r.key], `default of ${r.key} survives clamp`);
  }
});

check("custom rows name the renderers the page expects", () => {
  assert.deepEqual(S.rows().filter(r => r.kind === "custom").map(r => r.type).sort(),
    ["approvalMode", "approvalRules", "chromium", "goalContinue", "remoteCert", "remoteDevices", "remotePair", "remotePush", "remoteServer", "shell", "shortcuts", "startupProfile", "terminalHeight", "version", "widgets", "widths"]);
  for (const r of S.rows().filter(r => r.kind === "custom")) for (const k of r.keys ?? []) assert.ok(k in D, k);
});

check("bounds come from the owning modules", () => {
  assert.equal(row("collapseAfter").min, win.OMP_COLLAPSE.MIN_AFTER);
  assert.equal(row("collapseAfter").max, win.OMP_COLLAPSE.MAX_AFTER);
  assert.equal(row("promptHistoryLimit").min, win.OMP_PROMPT_HISTORY.MIN_LIMIT);
  assert.equal(row("promptHistoryLimit").max, win.OMP_PROMPT_HISTORY.MAX_LIMIT);
  assert.equal(row("pasteCollapseLines").min, win.OMP_SESSION_UI.PASTE_LINES_MIN);
  assert.equal(row("pasteCollapseLines").max, win.OMP_SESSION_UI.PASTE_LINES_MAX);
  assert.deepEqual(row("foldTools").options.map(o => o.value), [...win.OMP_COLLAPSE.MODES]);
  assert.deepEqual([row("fontSize").min, row("fontSize").max, row("fontSize").step], [75, 150, 5]);
});

check("a stale stored start screen falls back to the default", () => {
  const r = row("startScreen");
  assert.equal(S.clamp(r, "neural"), "neural");
  assert.equal(S.clamp(r, "starfield"), D.startScreen);
});

check("clamp keeps values in bounds and on the step", () => {
  const fs = row("fontSize");
  assert.equal(S.clamp(fs, 300), 150);
  assert.equal(S.clamp(fs, 10), 75);
  assert.equal(S.clamp(fs, 103), 105);
  assert.equal(S.clamp(fs, "x"), D.fontSize);
  assert.equal(S.clamp(fs, null), D.fontSize);
  assert.equal(S.clamp(row("promptHistoryLimit"), 57), 60);
  assert.equal(S.clamp(row("density"), "huge"), D.density);
  assert.equal(S.clamp(row("terminalScrollback"), 10000), 10000);
  assert.equal(S.clamp(row("terminalScrollback"), "10000"), D.terminalScrollback);
  assert.equal(S.clamp(row("sidebar"), "yes"), D.sidebar);
});

check("value resolves unset fold modes and clamps stored numbers", () => {
  assert.equal(S.value(row("foldThinking"), vals()), "auto");
  assert.equal(S.value(row("foldThinking"), vals({ foldThinking: null, autoCollapse: false })), "open");
  assert.equal(S.value(row("collapseAfter"), vals({ collapseAfter: 99 })), win.OMP_COLLAPSE.MAX_AFTER);
});

check("collapse-after shows only while a fold mode is auto", () => {
  const r = row("collapseAfter");
  assert.ok(S.visible(r, vals()));
  assert.ok(S.visible(r, vals({ foldThinking: "open" })));
  assert.ok(!S.visible(r, vals({ foldThinking: "open", foldTools: "folded" })));
  assert.ok(!S.visible(r, vals({ autoCollapse: false })), "legacy auto-collapse off resolves to open");
  assert.ok(S.visible(row("fontSize"), vals({ foldThinking: "open", foldTools: "open" })));
});

check("isModified compares with defaults, accent with the theme's own", () => {
  assert.ok(!S.rows().some(r => S.isModified(r, vals())), "fresh tweaks are unmodified");
  assert.ok(S.isModified(row("fontSize"), vals({ fontSize: 110 })));
  const daylight = vals({ theme: "daylight", accent: S.themeAccent("daylight") });
  assert.ok(S.isModified(row("theme"), daylight));
  assert.ok(!S.isModified(row("accent"), daylight));
  assert.ok(S.isModified(row("accent"), vals({ accent: "#FF7AC6" })));
  assert.ok(!S.isModified(row("accent"), vals({ accent: "#8af0c8" })), "case-insensitive");
  assert.ok(!S.isModified(row("foldTools"), vals({ foldTools: "auto" })), "explicit auto equals unset");
  assert.ok(S.isModified(row("foldTools"), vals({ foldTools: "open" })));
});

check("custom rows count their owned tweak keys", () => {
  assert.ok(S.isModified(row("custom:widths"), vals({ railWidth: 400 })));
  assert.ok(S.isModified(row("custom:terminalHeight"), vals({ terminalHeight: 300 })));
  assert.ok(!S.isModified(row("custom:widgets"), vals({ "widget:plugin:git": true })));
  assert.ok(S.isModified(row("custom:widgets"), vals({ "widget:ext-status": false })));
  assert.ok(!S.isModified(row("custom:shell"), vals({ railWidth: 400 })), "Rust-backed rows never count");
  const orphan = vals({ "widget:plugin:gone": false, "widget:plugin:git": false });
  const shown = { prefixKeys: ["widget:plugin:git", "widget:ext-status"] };
  assert.ok(S.isModified(row("custom:widgets"), orphan), "without prefixKeys every stored key counts");
  assert.ok(!S.isModified(row("custom:widgets"), vals({ "widget:plugin:gone": false }), shown), "an unrendered key never counts");
  assert.deepEqual(S.resetRow(row("custom:widgets"), orphan, shown), { "widget:plugin:git": true });
  assert.equal(S.modifiedCount("rail", vals({ "widget:plugin:gone": false }), shown), 0);
  assert.equal(S.modifiedCount("rail", vals({ "widget:plugin:gone": false })), 1);
});

check("modifiedCount per section and overall, hidden rows excluded", () => {
  const v = vals({ fontSize: 110, showMinimap: false, railWidth: 300 });
  assert.equal(S.modifiedCount("appearance", v), 1);
  assert.equal(S.modifiedCount("rail", v), 1);
  assert.equal(S.modifiedCount("layout", v), 1);
  assert.equal(S.modifiedCount("all", v), 3);
  assert.equal(S.modifiedCount(undefined, v), 3);
  const hidden = vals({ foldThinking: "open", foldTools: "open", collapseAfter: 9 });
  assert.equal(S.modifiedCount("chat", hidden), 2);
});

check("resetEdits resets only changed rows; theme brings its accent", () => {
  const v = vals({ theme: "phosphor", accent: "#FF7AC6", fontSize: 120, showRadar: false });
  assert.deepEqual(S.resetEdits("appearance", v), { theme: D.theme, accent: S.themeAccent(D.theme), fontSize: D.fontSize });
  assert.deepEqual(S.resetEdits("rail", vals({ "widget:plugin:git": false })), { "widget:plugin:git": true });
  assert.deepEqual(S.resetEdits("layout", vals({ railWidth: 400, sidebar: false })), { sidebar: true, railWidth: 0 });
  assert.deepEqual(S.resetEdits("session", vals()), {});
  const all = S.resetEdits("all", v);
  assert.equal(all.showRadar, true);
  assert.deepEqual(S.resetRow(row("accent"), vals({ theme: "daylight", accent: "#fff" })), { accent: S.themeAccent("daylight") });
});

check("Changes participates in Rail search, modified counts and reset", () => {
  const v = vals({ showChanges: false });
  assert.equal(S.value(row("showChanges"), v), false);
  assert.equal(S.modifiedCount("rail", v), 1);
  assert.deepEqual(S.resetEdits("rail", v), { showChanges: true });
  assert.ok(S.search("pull request", v).groups.some(g => g.sectionId === "rail" && g.rows.some(r => r.id === "showChanges")));
});

check("resetRows resets only the given rows (the search matches)", () => {
  const v = vals({ fontSize: 120, monoChat: !D.monoChat, showRadar: false });
  const matched = S.search("font", v).groups.flatMap(g => g.rows);
  assert.deepEqual(S.resetRows(matched, v), { fontSize: D.fontSize, monoChat: D.monoChat });
  assert.deepEqual(S.resetRows([], v), {});
});

check("search matches label, desc text and keywords, grouped in page order", () => {
  const r = S.search("font", vals());
  assert.deepEqual(r.groups.flatMap(g => g.rows.map(x => x.id)), ["fontSize", "monoChat"]);
  assert.equal(r.total, 2);
  assert.equal(r.bySection.appearance, 2);
  assert.equal(r.bySection.chat, 0);
  assert.deepEqual(r.groups.map(g => [g.sectionId, g.sectionTitle, g.groupName]), [["appearance", "Appearance", "Text"]]);
  assert.equal(S.search("POWERSHELL", vals()).groups[0].src, "terminal.json", "keywords, case-insensitive");
  assert.equal(S.search("/compact", vals()).total, 1, "desc text with backticks stripped");
  assert.deepEqual(S.search("   ", vals()), { total: 0, bySection: Object.fromEntries(S.SECTIONS.map(s => [s.id, 0])), groups: [] });
});

check("search skips hidden rows", () => {
  assert.equal(S.search("collapse after", vals()).total, 1);
  assert.equal(S.search("collapse after", vals({ foldThinking: "open", foldTools: "open" })).total, 0);
});

check("the key bindings row is found by any shortcut action's name or id", () => {
  const sidebar = win.OMP_KEYMAP.KEYMAP_ACTIONS.find(a => a.id === "desktop.sidebar.toggle");
  assert.ok(sidebar);
  for (const q of [sidebar.label, sidebar.id]) {
    assert.ok(S.search(q, vals()).groups.some(g => g.rows.some(r => r.id === "custom:shortcuts")), q);
  }
});

console.log(`test-settings-schema: ${passed} checks passed`);
