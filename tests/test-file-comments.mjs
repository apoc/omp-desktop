#!/usr/bin/env node
// Regression script for src/app/file-comments.js — the files panel's marks:
// the text they add to the outgoing message, the composer chip label, the
// stale check, the per-tab store (OMP_BROWSER's chip store), and the views
// of the git browser's tree the panel shows.
// Run: node tests/test-file-comments.mjs  (or: npm run test:file-comments)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
const load = (path) => new Function("window", readFileSync(join(root, path), "utf8"))(win); // eslint-disable-line no-new-func
load("src/app/constants.js");
load("src/app/session-ui.js");
load("src/app/project-nav.js");
load("src/app/layout-widths.js");
load("src/app/image-attach.js");
load("src/app/marked-setup.js");
load("src/app/browser.js");
load("src/app/file-comments.js");
const F = win.OMP_FILE_COMMENTS;

let passed = 0;
function check(label, fn) {
  try { fn(); } catch (err) { console.error(`FAILED: ${label}`); throw err; }
  passed++;
}

const mark = (over) => ({
  id: "fc1", n: 1, path: "src/live.js", from: 12, to: 14, kind: "explain", text: null, selection: null,
  lines: ["a", "b", "c"], ...over,
});

// ── Message text ──────────────────────────────────────────────────────────

check("merge: typed text, header, then each mark by number; no code is quoted", () => {
  const out = F.mergeIntoMessage("  look at these  ", [
    mark({ id: "b", n: 2, kind: "comment", text: "rename this", from: 3, to: 3 }),
    mark({ id: "a", n: 1 }),
  ]);
  assert.equal(out, [
    "look at these",
    "",
    F.HEADER,
    "",
    "#1 src/live.js:12-14",
    "Explain this code.",
    "",
    "#2 src/live.js:3",
    "Comment: rename this",
  ].join("\n"));
});

check("merge: marks alone start with the header; no marks leaves the text as is", () => {
  assert.ok(F.mergeIntoMessage("", [mark()]).startsWith(`${F.HEADER}\n\n#1 `));
  assert.equal(F.mergeIntoMessage("  hi ", []), "  hi ");
});

check("merge: a selection is quoted as inline code, one line, its @ escaped", () => {
  const out = F.markText(mark({ from: 5, to: 6, selection: "  @Override\n  void run()  " }));
  assert.equal(out, "#1 src/live.js:5-6, the text `\\@Override void run()`\nExplain this code.");
});

check("merge: a comment's commands are neutralised, its @file mentions kept", () => {
  const out = F.markText(mark({ kind: "comment", text: "/skill:review this like @src/a.js" }));
  assert.match(out, /\nComment: \\\/skill\\:review this like @src\/a\.js$/);
  // A multi-line comment cannot start a command on a later line either.
  assert.match(F.markText(mark({ kind: "comment", text: "first\n/compact" })), /\n\\\/compact$/);
});

check("inlineCode: a fence longer than any backtick run inside", () => {
  assert.equal(F.inlineCode("a`b"), "``a`b``");
  assert.equal(F.inlineCode("x ``` y"), "````x ``` y````");
  assert.equal(F.inlineCode("`edge"), "`` `edge ``");
});

check("selectionText: whitespace collapsed, cut at SELECTION_MAX with an ellipsis", () => {
  const long = "x".repeat(F.SELECTION_MAX + 10);
  const cut = F.selectionText(long);
  assert.equal(cut.length, F.SELECTION_MAX);
  assert.ok(cut.endsWith("…"));
  assert.equal(F.selectionText(" a \n\t b "), "a b");
});

// ── Chip label ────────────────────────────────────────────────────────────

check("chipLabel: file name and range, then the kind or the comment", () => {
  assert.equal(F.chipLabel(mark(), "explain"), "#1 live.js:12-14 — explain");
  assert.equal(F.chipLabel(mark({ kind: "comment", text: "why?", from: 9, to: 9 }), "x"), '#1 live.js:9 — "why?"');
  const sel = F.chipLabel(mark({ selection: "isCommandInvocation(state.commands, text)", kind: "comment", text: "t".repeat(60) }), "x");
  assert.match(sel, /^#1 live\.js:12-14 "isCommandInvocation\(state\.c…" — "t{39}…"$/);
});

// ── Stale check ───────────────────────────────────────────────────────────

check("isStale: false while the marked lines are unchanged", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const m = mark({ from: 3, to: 4, lines: ["line 3", "line 4"] });
  assert.equal(F.isStale(m, lines), false);
  assert.equal(F.isStale(m, ["inserted", ...lines]), true, "a line added above moves the marked text");
  assert.equal(F.isStale(m, lines.map((l) => (l === "line 4" ? "line 4!" : l))), true);
  assert.equal(F.isStale(m, lines.slice(0, 3)), true, "the file got shorter than the mark");
});

// ── Store ─────────────────────────────────────────────────────────────────

check("store: numbered per tab, updated in place, taken, handed back after newer ones", () => {
  let s = F.addMark(win.OMP_BROWSER.EMPTY, "T", mark({ id: "a", n: undefined }));
  s = F.addMark(s, "T", mark({ id: "b", n: undefined }));
  s = F.addMark(s, "U", mark({ id: "c", n: undefined }));
  assert.deepEqual(F.marksOf(s, "T").map((m) => [m.id, m.n]), [["a", 1], ["b", 2]]);
  assert.deepEqual(F.marksOf(s, "U").map((m) => m.n), [1]);

  const edited = F.updateMark(s, "T", "b", { text: "new" });
  assert.equal(F.marksOf(edited, "T")[1].text, "new");
  assert.equal(F.updateMark(s, "T", "missing", { text: "x" }), s, "an unknown id changes nothing");

  const taken = F.marksOf(s, "T");
  s = F.removeMarks(s, "T", taken.map((m) => m.id));
  assert.deepEqual(F.marksOf(s, "T"), []);
  s = F.addMark(s, "T", mark({ id: "d", n: undefined }));
  s = F.restoreMarks(s, "T", taken);
  assert.deepEqual(F.marksOf(s, "T").map((m) => [m.id, m.n]), [["d", 1], ["a", 2], ["b", 3]]);
});

check("counts: per kind, distinct files and marks per path", () => {
  const c = F.counts([mark(), mark({ id: "b", kind: "comment" }), mark({ id: "c", path: "a.rs", kind: "comment" })]);
  assert.equal(c.explain, 1);
  assert.equal(c.comment, 2);
  assert.equal(c.files, 2);
  assert.equal(c.byPath.get("src/live.js"), 2);
});

// ── Paths and trees ───────────────────────────────────────────────────────

check("relativeTo: relative paths as given, absolute ones inside the folder made relative", () => {
  assert.equal(F.relativeTo("/home/u/p", "./src/a.js"), "src/a.js");
  assert.equal(F.relativeTo("/home/u/p", "/home/u/p/src/a.js"), "src/a.js");
  assert.equal(F.relativeTo("/home/u/p", "/home/u/other/a.js"), null);
  assert.equal(F.relativeTo("D:\\Devel\\Proj", "d:/devel/proj/Src/A.js"), "Src/A.js", "Windows paths compare without case");
  assert.equal(F.relativeTo("/home/u/p", ""), null);
});

const file = (path) => ({ name: path.split("/").pop(), path, dir: false, status: null, changed: 0, children: [] });
const dir = (path, children) => ({ name: path.split("/").pop(), path, dir: true, status: null, changed: 1, children });
const repo = dir("", [
  dir("docs", [file("docs/readme.md")]),
  dir("pkg", [dir("pkg/App", [file("pkg/App/main.rs"), dir("pkg/App/src", [file("pkg/App/src/lib.rs")])])]),
  file("README.md"),
]);

check("folderTree: the work tree itself (\"\") is the whole tree", () => {
  assert.equal(F.folderTree(repo, ""), repo);
});

check("folderTree: a folder below the work tree is cut out, paths relative to it", () => {
  const t = F.folderTree(repo, "pkg/App");
  assert.equal(t.path, "");
  assert.deepEqual(t.children.map((c) => c.path), ["main.rs", "src"]);
  assert.equal(t.children[1].children[0].path, "src/lib.rs");
  assert.equal(repo.children[1].children[0].path, "pkg/App", "the git browser's tree is not mutated");
});

check("folderTree: case-different names, folders without files, unplaced folders", () => {
  const both = dir("", [dir("A", [file("A/x")]), dir("a", [file("a/y")])]);
  assert.deepEqual(F.folderTree(both, "a", true).children.map((c) => c.path), ["y"], "an exact name wins");
  assert.deepEqual(F.folderTree(repo, "PKG/app", true).children.map((c) => c.path), ["main.rs", "src"], "else any case, where case is folded");
  assert.deepEqual(F.folderTree(repo, "PKG/app").children, [], "a case-sensitive file system: no such folder");
  assert.deepEqual(F.folderTree(repo, "pkg/empty").children, [], "no tracked or untracked file there");
  assert.equal(F.folderTree(repo, null), null, "Rust could not place the folder");
  assert.equal(F.folderTree(null, ""), null);
});

check("onlyFiles: the given files and the directories holding them", () => {
  const t = F.onlyFiles(repo, new Set(["pkg/App/src/lib.rs", "README.md"]));
  assert.deepEqual(t.children.map((c) => c.path), ["pkg", "README.md"]);
  assert.deepEqual(t.children[0].children[0].children.map((c) => c.path), ["pkg/App/src"]);
  assert.deepEqual(F.onlyFiles(repo, new Set(["nope"])).children, []);
});

check("searchRoot: the search's file hits flat under their whole path; folders left out", () => {
  const t = F.searchRoot([
    { path: "src/a.js", name: "a.js", isDir: false },
    { path: "src", name: "src", isDir: true },
  ]);
  assert.deepEqual(t.children.map((c) => [c.name, c.path, c.dir]), [["src/a.js", "src/a.js", false]]);
  assert.deepEqual(F.searchRoot(null).children, []);
});

console.log(`test-file-comments: ${passed} checks passed`);
