#!/usr/bin/env node
// Regression script for src/app/project-appearance.js — a project folder's
// theme/accent override, keyed by the same normalised path the sidebar groups
// tabs under, with the global tweak pair as the fallback.
// Run: node tests/test-project-appearance.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
const load = file => new Function("window", readFileSync(join(root, file), "utf8"))(win);
load("src/app/project-nav.js");
load("src/app/project-appearance.js");
const A = win.OMP_PROJECT_APPEARANCE;

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

check("key normalises separators, trailing slashes and Windows drive case", () => {
  assert.equal(A.key("/Users/me/proj/"), "/Users/me/proj");
  assert.equal(A.key("\\Users\\me\\proj"), "/Users/me/proj");
  assert.equal(A.key("C:\\Work\\Site\\"), "c:/work/site");
});

check("key accepts a Windows drive root", () => {
  assert.equal(A.key("C:\\"), "c:");
  assert.deepEqual(A.set({}, "C:\\", { accent: "#112233" }), { "c:": { accent: "#112233" } });
});

check("key folds UNC paths of either separator to one lowercase key", () => {
  assert.equal(A.key("//Server/Share/proj/"), "//server/share/proj");
  assert.equal(A.key("\\\\Server\\Share\\proj"), "//server/share/proj");
});

check("key refuses relative and empty paths", () => {
  assert.equal(A.key(""), "");
  assert.equal(A.key("proj"), "");
  assert.equal(A.key("./proj"), "");
});

check("forProject returns the entry, null otherwise", () => {
  const map = { "/a": { accent: "#112233" } };
  assert.deepEqual(A.forProject(map, "/a/"), { accent: "#112233" });
  assert.equal(A.forProject(map, "/b"), null);
  assert.equal(A.forProject(map, ""), null);
  assert.equal(A.forProject(null, "/a"), null);
});

check("set merges a half override and never mutates the input map", () => {
  const map = { "/a": { theme: "phosphor" } };
  const next = A.set(map, "/a/", { accent: "#AABBCC" });
  assert.deepEqual(next, { "/a": { theme: "phosphor", accent: "#aabbcc" } });
  assert.deepEqual(map, { "/a": { theme: "phosphor" } });
});

check("set drops an entry once its last field is cleared", () => {
  const next = A.set({ "/a": { accent: "#112233" } }, "/a", { accent: undefined });
  assert.deepEqual(next, {});
});

check("set ignores an invalid accent and keeps the old one", () => {
  const next = A.set({ "/a": { accent: "#112233" } }, "/a", { accent: "teal" });
  assert.deepEqual(next, { "/a": { accent: "#112233" } });
});

check("set returns the map unchanged for an unusable path", () => {
  const map = { "/a": { theme: "aurora" } };
  assert.equal(A.set(map, "relative", { accent: "#112233" }), map);
});

check("clear removes one project and leaves the rest", () => {
  const map = { "/a": { theme: "aurora" }, "/b": { accent: "#112233" } };
  assert.deepEqual(A.clear(map, "/a/"), { "/b": { accent: "#112233" } });
  assert.equal(A.clear(map, "/c"), map);
});

check("themePatch with a theme replaces a stored accent with the theme's own", () => {
  assert.deepEqual(A.themePatch(" phosphor ", "#33FF66", undefined), { theme: "phosphor", accent: "#33FF66" });
  const next = A.set({ "/a": { accent: "#112233" } }, "/a", A.themePatch("phosphor", "#33FF66", undefined));
  assert.deepEqual(next, { "/a": { theme: "phosphor", accent: "#33ff66" } });
});

check("themePatch with no theme clears both fields and drops the entry", () => {
  assert.deepEqual(A.themePatch("", undefined, "phosphor"), { theme: undefined, accent: undefined });
  const map = { "/a": { theme: "phosphor", accent: "#112233" }, "/b": { accent: "#445566" } };
  assert.deepEqual(A.set(map, "/a", A.themePatch("", undefined, "phosphor")), { "/b": { accent: "#445566" } });
  assert.deepEqual(A.set(map, "/a", A.themePatch(undefined, undefined, "phosphor")), { "/b": { accent: "#445566" } });
});

check("themePatch re-picking the stored theme is null, so a custom accent stays", () => {
  // The row applies nothing for null: the entry keeps its custom accent.
  assert.equal(A.themePatch("phosphor", "#33FF66", "phosphor"), null);
  assert.equal(A.themePatch(" phosphor ", "#33FF66", "phosphor "), null);
});

check("themePatch re-picking Global with only an accent stored is null", () => {
  assert.equal(A.themePatch("", undefined, undefined), null);
  assert.equal(A.themePatch("", undefined, ""), null);
});

check("themePatch picking a different theme returns the patch", () => {
  assert.deepEqual(A.themePatch("aurora", "#8AF0C8", "phosphor"), { theme: "aurora", accent: "#8AF0C8" });
  const next = A.set({ "/a": { theme: "phosphor", accent: "#112233" } }, "/a", A.themePatch("aurora", "#8AF0C8", "phosphor"));
  assert.deepEqual(next, { "/a": { theme: "aurora", accent: "#8af0c8" } });
});

check("resolve falls back to the global pair", () => {
  assert.deepEqual(A.resolve({ theme: "aurora", accent: "#8AF0C8", projectAppearance: {} }, "/a"),
    { theme: "aurora", accent: "#8AF0C8", themed: false, accented: false });
});

check("resolve takes each override half independently", () => {
  const tweaks = {
    theme: "aurora", accent: "#8AF0C8",
    projectAppearance: { "/a": { theme: "phosphor" }, "/b": { accent: "#112233" } },
  };
  assert.deepEqual(A.resolve(tweaks, "/a"),
    { theme: "phosphor", accent: "#8AF0C8", themed: true, accented: false });
  assert.deepEqual(A.resolve(tweaks, "/b"),
    { theme: "aurora", accent: "#112233", themed: false, accented: true });
});

check("resolve uses the global pair with no project path", () => {
  const tweaks = { theme: "aurora", accent: "#8AF0C8", projectAppearance: { "": { theme: "phosphor" } } };
  assert.equal(A.resolve(tweaks, "").theme, "aurora");
});

check("isHex accepts #rgb and #rrggbb only", () => {
  assert.equal(A.isHex("#abc"), true);
  assert.equal(A.isHex("#AABBCC"), true);
  assert.equal(A.isHex("aabbcc"), false);
  assert.equal(A.isHex("#abcd"), false);
});

console.log(`project-appearance: ${passed} checks passed`);
