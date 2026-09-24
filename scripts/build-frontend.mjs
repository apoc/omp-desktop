#!/usr/bin/env node
// Builds dist/, the frontend that release builds embed (see
// src-tauri/tauri.dist.conf.json, which runs this as `beforeBuildCommand`):
//
//   node scripts/build-frontend.mjs
//
// src/ stays what `tauri dev` serves: development React, and every
// `<script type="text/babel">` compiled in the browser by Babel on each
// start (about a second). dist/ is src/ with that work done ahead of time:
//
// - each .jsx is compiled by the *same* vendored Babel, with the exact
//   options Babel's script-tag loader uses, so the output is the code the
//   browser would have run (minus the inline source map);
// - its tag becomes a plain `<script defer>`: deferred scripts run after
//   every parser-blocking script, in document order — the same order Babel
//   runs its scripts in, after all plain ones;
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
cpSync(src, out, {
  recursive: true,
  filter: (path) => !path.endsWith(".jsx") && !DROPPED.has(path.slice(src.length + 1)),
});

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
  const { code } = Babel.transform(source, babelOptions(`${path}.jsx`));
  const target = join(out, `${path}.js`);
  if (existsSync(target)) throw new Error(`${path}.js already exists in src/; cannot compile ${path}.jsx onto it`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${code}\n`);
  compiled++;
  bytesIn += source.length;
  bytesOut += code.length;
  return `<script defer src="${path}.js"></script>`;
});

if (/<script[^>]*(text\/babel|\.jsx")/.test(html)) throw new Error("index.html: a Babel script tag was not compiled");
for (const [, path] of html.matchAll(/<script[^>]* src="([^"]+)"/g)) {
  if (!existsSync(join(out, path))) throw new Error(`dist/index.html loads ${path}, which dist/ lacks`);
}
writeFileSync(join(out, "index.html"), html);

// The release CSP (tauri.dist.conf.json) must be the dev one minus
// 'unsafe-eval' — only Babel needed eval. Checked here so the two copies
// can't drift apart unnoticed.
const csp = (file) => JSON.parse(readFileSync(join(root, "src-tauri", file), "utf8")).app.security.csp;
const expected = csp("tauri.conf.json").replace(" 'unsafe-eval'", "");
if (csp("tauri.dist.conf.json") !== expected) {
  throw new Error(`tauri.dist.conf.json csp must be tauri.conf.json's minus 'unsafe-eval':\n  ${expected}`);
}

console.log(`dist/: compiled ${compiled} JSX files (${bytesIn >> 10} KB → ${bytesOut >> 10} KB), dropped Babel and development React`);
