#!/usr/bin/env node
// Builds dist/, the frontend that release builds embed (see
// src-tauri/tauri.dist.conf.json, which runs this as `beforeBuildCommand`):
//
//   node scripts/build-frontend.mjs
//
// src/ stays what `tauri dev` serves: development React, and every
// `<script type="text/babel">` compiled in the browser by Babel on each
// start (~1.5 s). dist/ is src/ with that work done ahead of time:
//
// - each .jsx is compiled by the *same* vendored Babel, with the exact
//   options Babel's script-tag loader uses, so the output is the code the
//   browser would have run (minus the inline source map);
// - its tag becomes a plain `<script defer>`: deferred scripts run after
//   every parser-blocking script, in document order — the same order Babel
//   runs its scripts in, after all plain ones. Timing differs, though:
//   Babel runs them after DOMContentLoaded (usually after load), deferred
//   scripts before both, with readyState "interactive" — so JSX must not
//   depend on either event;
// - Babel and the development React files are dropped, and the React tags
//   point at the minified production build.
//
// Every rewrite is checked; any tag the script cannot find, or any script
// the output references but does not contain, fails the build.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const out = join(root, "dist");
const Babel = createRequire(import.meta.url)(join(src, "babel.min.js"));

// Babel standalone's defaults for a `<script type="text/babel">` with no
// data-* attributes (see transformScriptTags in babel.min.js).
const babelOptions = (filename) => ({
  filename,
  presets: ["react", "env"],
  plugins: ["transform-class-properties", "transform-object-rest-spread", "transform-flow-strip-types"],
  targets: { browsers: undefined },
  sourceMaps: false,
});

const DROPPED = new Set(["babel.min.js", "react.development.js", "react-dom.development.js"]);

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
// The filter only skips `.jsx`: on Windows, Node < 22.4 hands it `\\?\`-
// prefixed paths, so matching dropped files by relative name there silently
// fails. Delete them explicitly instead — without `force`, so a renamed
// vendored file fails the build.
cpSync(src, out, { recursive: true, filter: (path) => !path.endsWith(".jsx") });
for (const name of DROPPED) rmSync(join(out, name));

let html = readFileSync(join(src, "index.html"), "utf8");
const replaceOnce = (from, to) => {
  const count = html.split(from).length - 1;
  if (count !== 1) throw new Error(`index.html: expected exactly one ${JSON.stringify(from)}, found ${count}`);
  html = html.replace(from, to);
};
replaceOnce('<script src="react.development.js"></script>', '<script src="react.production.js"></script>');
replaceOnce('<script src="react-dom.development.js"></script>', '<script src="react-dom.production.js"></script>');
replaceOnce('<script src="babel.min.js"></script>\n', "");

let compiled = 0;
let bytesIn = 0;
let bytesOut = 0;
html = html.replace(/<script type="text\/babel" src="([^"]+)\.jsx"><\/script>/g, (_, path) => {
  const source = readFileSync(join(src, `${path}.jsx`), "utf8");
  let code;
  try {
    ({ code } = Babel.transform(source, babelOptions(`${path}.jsx`)));
  } catch (err) {
    // Rethrown as a fresh Error: Node would otherwise print the throw site
    // first — one 3 MB line of babel.min.js — ahead of the message, which
    // already names the file and carries a code frame.
    throw new Error(err.message);
  }
  const target = join(out, `${path}.js`);
  if (existsSync(target)) throw new Error(`${path}.js already exists in src/; cannot compile ${path}.jsx onto it`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${code}\n`);
  compiled++;
  bytesIn += source.length;
  bytesOut += code.length;
  return `<script defer src="${path}.js"></script>`;
});

// Anything Babel's own loader would run (`text/babel`, `text/jsx`, any case)
// but the rewrite above did not match must fail the build, not ship dead.
if (/<script\b[^>]*(text\/(?:babel|jsx)|\.jsx["'\s>])/i.test(html)) {
  throw new Error("index.html: a Babel script tag was not compiled");
}
for (const [, path] of html.matchAll(/<script\b[^>]*\ssrc="([^"]+)"/gi)) {
  if (!existsSync(join(out, path))) throw new Error(`dist/index.html loads ${path}, which dist/ lacks`);
}
// Release builds run under a CSP whose script-src lacks 'unsafe-inline'
// (src-tauri/tauri.dist.conf.json): src/ needs it only because Babel injects
// each compiled file as an inline <script>. Without it an injected
// `<img onerror>` can't run even if markup ever slips past the markdown
// renderer — so an inline script or handler here would be dead in release,
// and the CSP may differ from src/'s in exactly that one token.
if (/<script\b(?![^>]*\ssrc=)[^>]*>/i.test(html)) {
  throw new Error("dist/index.html: inline <script> — move it into a file (the release CSP blocks it)");
}
if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(html)) {
  throw new Error("dist/index.html: inline on* event handler attribute (the release CSP blocks it)");
}
const cspOf = (file) => JSON.parse(readFileSync(join(root, "src-tauri", file), "utf8")).app?.security?.csp;
const devCsp = cspOf("tauri.conf.json");
if (typeof devCsp !== "string") {
  throw new Error("tauri.conf.json: app.security.csp must be a policy string (build-frontend.mjs derives the release CSP from it)");
}
const distCsp = cspOf("tauri.dist.conf.json");
const expectedCsp = devCsp
  .split(";")
  .map((d) => (/^\s*script-src\s/.test(d) ? d.replace(/\s'unsafe-inline'(?=\s|$)/, "") : d))
  .join(";");
if (expectedCsp === devCsp) throw new Error("tauri.conf.json: script-src no longer has 'unsafe-inline' to strip");
if (distCsp !== expectedCsp) {
  throw new Error(`tauri.dist.conf.json: app.security.csp must be tauri.conf.json's minus script-src 'unsafe-inline':\n  ${expectedCsp}`);
}
writeFileSync(join(out, "index.html"), html);

console.log(`dist/: compiled ${compiled} JSX files (${bytesIn >> 10} KB → ${bytesOut >> 10} KB), dropped Babel and development React`);
