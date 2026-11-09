#!/usr/bin/env node
// Regression script for src/app/file-preview.js (issue #39: which file and
// lines a read card or an agent link points at, project confinement as the
// UI sees it, highlighted text cut into lines).
// No test framework, no bundler — zero dependencies beyond node:assert/strict.
// Run: node tests/test-file-preview.mjs  (or: npm run test:file-preview)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// file-preview.js destructures OMP_MARKDOWN (marked-setup.js, which sets it
// before its marked/hljs guard) and OMP_PROJECT_NAV at load, as in index.html.
const win  = { DEFAULT_PROFILE_ID: "default" };
for (const f of ["app/marked-setup.js", "app/project-nav.js", "app/file-preview.js"]) {
  // eslint-disable-next-line no-new-func
  new Function("window", readFileSync(join(root, "src", f), "utf8"))(win);
}
const P = win.OMP_FILE_PREVIEW;
const { isSchemeLikeFilePath } = win.OMP_MARKDOWN;

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

check("readTarget: omp's line selectors become a range", () => {
  assert.deepEqual(P.readTarget("src/a.js"), { path: "src/a.js", range: null });
  assert.deepEqual(P.readTarget("src/a.js:50"), { path: "src/a.js", range: { from: 50, to: 50 } });
  assert.deepEqual(P.readTarget("src/a.js:50-80"), { path: "src/a.js", range: { from: 50, to: 80 } });
  assert.deepEqual(P.readTarget("src/a.js:50+30"), { path: "src/a.js", range: { from: 50, to: 79 } });
  assert.deepEqual(P.readTarget("src/a.js:5-16,960-973"), { path: "src/a.js", range: { from: 5, to: 16 } });
});

check("readTarget: mode selectors, tails and image questions are dropped", () => {
  assert.deepEqual(P.readTarget("src/a.js:raw"), { path: "src/a.js", range: null });
  assert.deepEqual(P.readTarget("src/a.js:2-4:raw"), { path: "src/a.js", range: { from: 2, to: 4 } });
  assert.deepEqual(P.readTarget("src/a.js:raw:2-4"), { path: "src/a.js", range: { from: 2, to: 4 } });
  assert.deepEqual(P.readTarget("notes.txt:-60"), { path: "notes.txt", range: null });
  assert.deepEqual(P.readTarget("shot.png?what is red?"), { path: "shot.png", range: null });
  assert.deepEqual(P.readTarget("diagram.svg:img"), { path: "diagram.svg", range: null });
});

check("readTarget: Windows drive paths keep their colon", () => {
  assert.deepEqual(P.readTarget("C:\\proj\\a.rs:10-12"), { path: "C:\\proj\\a.rs", range: { from: 10, to: 12 } });
  assert.deepEqual(P.readTarget("C:/proj/a.rs"), { path: "C:/proj/a.rs", range: null });
});

check("readTarget: URLs and empty targets are not previewable", () => {
  assert.equal(P.readTarget("artifact://12"), null);
  assert.equal(P.readTarget("https://example.com/a.js"), null);
  assert.equal(P.readTarget(""), null);
  assert.equal(P.readTarget(undefined), null);
});

check("linkTarget: relative links with line anchors or suffixes", () => {
  assert.deepEqual(P.linkTarget("src/app/lightbox.js"), { path: "src/app/lightbox.js", range: null });
  assert.deepEqual(P.linkTarget("src/a.js#L12"), { path: "src/a.js", range: { from: 12, to: 12 } });
  assert.deepEqual(P.linkTarget("src/a.js#L12-L20"), { path: "src/a.js", range: { from: 12, to: 20 } });
  assert.deepEqual(P.linkTarget("src/a.js:12"), { path: "src/a.js", range: { from: 12, to: 12 } });
  assert.deepEqual(P.linkTarget("src/a.js:12-20"), { path: "src/a.js", range: { from: 12, to: 20 } });
  assert.deepEqual(P.linkTarget("src/a.js:12:5"), { path: "src/a.js", range: { from: 12, to: 12 } });
  // marked percent-encodes the href; the path is decoded back.
  assert.deepEqual(P.linkTarget("docs/my%20notes.md#intro"), { path: "docs/my notes.md", range: null });
  assert.deepEqual(P.linkTarget("./README.md"), { path: "./README.md", range: null });
});

check("linkTarget: URLs, anchors and protocol-relative links are left alone", () => {
  for (const href of ["https://x.dev/a.js", "http://localhost:5173/", "mailto:a@b.c", "javascript:alert(1)",
                      "#section", "//cdn.example/x.js", "", "%E0%A4%A"]) {
    assert.equal(P.linkTarget(href), null, href);
  }
  assert.deepEqual(P.linkTarget("C:/proj/a.rs#L3"), { path: "C:/proj/a.rs", range: { from: 3, to: 3 } });
});

check("linkTarget: scheme-like file paths, as marked keeps them (#39)", () => {
  assert.deepEqual(P.linkTarget("README.md:5"), { path: "README.md", range: { from: 5, to: 5 } });
  assert.deepEqual(P.linkTarget("main.rs:12-20"), { path: "main.rs", range: { from: 12, to: 20 } });
  // encodeURI turns a backslash into %5C; the drive still counts.
  assert.deepEqual(P.linkTarget("C:%5Cproj%5Ca.rs"), { path: "C:\\proj\\a.rs", range: null });
  assert.equal(isSchemeLikeFilePath("C:/x.rs"), true);
  assert.equal(isSchemeLikeFilePath("main.rs:12:5"), true);
  for (const href of ["vscode:open", "c:x.rs", "main.rs:x", "javascript:1", "ms-settings:display"]) {
    assert.equal(isSchemeLikeFilePath(href), false, href);
    assert.equal(P.linkTarget(href), null, href);
  }
});

check("inProject: relative paths stay in, escapes and home paths do not", () => {
  assert.equal(P.inProject("src/a.js", "/p"), true);
  assert.equal(P.inProject("./src/a.js", null), true);
  assert.equal(P.inProject("../other/a.js", "/p"), false);
  assert.equal(P.inProject("~/.omp/agent/config.yml", "/p"), false);
  assert.equal(P.inProject("", "/p"), false);
});

check("inProject: absolute paths must be below the root", () => {
  assert.equal(P.inProject("/home/u/proj/src/a.js", "/home/u/proj"), true);
  assert.equal(P.inProject("/home/u/proj", "/home/u/proj"), false, "the folder itself is no file");
  assert.equal(P.inProject("/home/u/project2/a.js", "/home/u/proj"), false, "a sibling sharing the prefix");
  assert.equal(P.inProject("/etc/passwd", "/home/u/proj"), false);
  assert.equal(P.inProject("/home/u/proj/a.js", null), false);
  // Windows: either slash, any case, trailing separator on the root.
  assert.equal(P.inProject("d:/Devel/App/src/a.rs", "D:\\Devel\\app\\"), true);
  assert.equal(P.inProject("D:\\Devel\\other\\a.rs", "D:\\Devel\\app"), false);
});

check("inProject: a root of / holds every absolute path", () => {
  assert.equal(P.inProject("/etc/hosts", "/"), true);
});

check("linkClick: a primary click on an in-project file link, Ctrl/⌘ for git, Alt for the files panel", () => {
  const click = (href, extra = {}) => ({
    button: 0, defaultPrevented: false,
    target: { closest: (sel) => (sel === ".md-content a[href]" && href != null ? { getAttribute: () => href } : null) },
    ...extra,
  });
  assert.deepEqual(P.linkClick(click("src/a.js#L3"), "/p"), { target: { path: "src/a.js", range: { from: 3, to: 3 } }, git: false, files: false });
  assert.equal(P.linkClick(click("src/a.js", { ctrlKey: true }), "/p").git, true);
  assert.equal(P.linkClick(click("src/a.js", { metaKey: true }), "/p").git, true);
  assert.equal(P.linkClick(click("src/a.js", { altKey: true }), "/p").files, true);
  assert.equal(P.linkClick(click("src/a.js", { altKey: true, ctrlKey: true }), "/p").files, false, "Ctrl wins: the git browser");
  assert.equal(P.linkClick(click("src/a.js"), null), null, "a tab without a folder");
  assert.equal(P.linkClick(click("../x.js"), "/p"), null, "outside the project");
  assert.equal(P.linkClick(click("https://x.dev/"), "/p"), null, "a web link goes on");
  assert.equal(P.linkClick(click(null), "/p"), null, "not on a link");
  assert.equal(P.linkClick(click("src/a.js", { button: 1 }), "/p"), null, "a middle click");
  assert.equal(P.linkClick(click("src/a.js", { defaultPrevented: true }), "/p"), null);
});

check("language: extension aliases, mapped extensions and known names", () => {
  const known = new Set(["javascript", "typescript", "rust", "rs", "json", "xml", "dockerfile", "makefile"]);
  const has = (n) => known.has(n);
  assert.equal(P.language("src/a.rs", has), "rs");
  assert.equal(P.language("tests/x.mjs", has), "javascript");
  assert.equal(P.language("a.cts", has), "typescript");
  assert.equal(P.language("icon.svg", has), "xml");
  assert.equal(P.language("build/Dockerfile", has), "dockerfile");
  assert.equal(P.language("C:\\x\\Makefile", has), "makefile");
  assert.equal(P.language("notes.unknownext", has), null);
  assert.equal(P.language("LICENSE", has), null);
});

check("splitHighlighted: spans crossing lines are closed and reopened", () => {
  const html = 'a<span class="c">/* one\ntwo */</span>b\n<span class="k">let</span> x';
  assert.deepEqual(P.splitHighlighted(html), [
    'a<span class="c">/* one</span>',
    '<span class="c">two */</span>b',
    '<span class="k">let</span> x',
  ]);
  // Nested spans across a line, and a trailing newline gives an empty last line.
  assert.deepEqual(P.splitHighlighted('<span class="s"><span class="e">x\ny</span>z</span>\n'), [
    '<span class="s"><span class="e">x</span></span>',
    '<span class="s"><span class="e">y</span>z</span>',
    "",
  ]);
  assert.deepEqual(P.splitHighlighted("plain"), ["plain"]);
});

check("clipLines: line and per-line caps, the final newline ends a line", () => {
  assert.deepEqual(P.clipLines("a\nb\n"), { text: "a\nb", truncated: false, total: 2 });
  assert.deepEqual(P.clipLines("a\nb"), { text: "a\nb", truncated: false, total: 2 });
  const exact = "x".repeat(P.MAX_LINE_CHARS);
  assert.deepEqual(P.clipLines(exact), { text: exact, truncated: false, total: 1 });
  const long = P.clipLines("y".repeat(P.MAX_LINE_CHARS + 1));
  assert.equal(long.text.length, P.MAX_LINE_CHARS);
  assert.equal(long.truncated, true);
  const many = P.clipLines("l\n".repeat(P.MAX_LINES + 5));
  assert.equal(many.text.split("\n").length, P.MAX_LINES);
  assert.equal(many.total, P.MAX_LINES + 5);
  assert.equal(many.truncated, true);
  assert.equal(P.clipLines("l\n".repeat(P.MAX_LINES)).truncated, false);
});

check("inRange", () => {
  assert.equal(P.inRange(5, { from: 3, to: 6 }), true);
  assert.equal(P.inRange(7, { from: 3, to: 6 }), false);
  assert.equal(P.inRange(3, { from: 3, to: 3 }), true);
  assert.equal(P.inRange(4, { from: 3, to: 3 }), false);
  assert.equal(P.inRange(1, null), false);
});

console.log(`file-preview: ${passed} checks passed`);
