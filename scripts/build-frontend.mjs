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
//
// Finally every script URL, stylesheet link and CSS @import is stamped with
// ?v=<version>: the updater swaps the .exe but never the WebView2 user-data
// folder, and tauri's embedded-asset responses carry no
// ETag/Last-Modified/Cache-Control, so the webview may reuse a previous
// version's cached copy of a same-named file. The version changes every
// release, so the stamped URL always misses.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// The embedded-asset handler strips the query string before resolving the
// embedded file (tauri's tauri.rs get_response splits the URI on '?' and
// '#'), so ?v=... varies the webview's cache key without affecting asset
// lookup. A URL already carrying a query or fragment fails the build:
// appending after a fragment would put ?v= where the webview never sends
// it, leaving the cache key unchanged. Dev builds are untouched: tauri dev
// serves src/, and only this script stamps.
const version = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
if (typeof version !== "string" || !/^[0-9A-Za-z.+-]+$/.test(version)) {
  throw new Error("tauri.conf.json: version must be a plain semver-ish string (it goes into every asset URL)");
}
const stamp = (where, url) => {
  if (url === "") throw new Error(`${where}: empty URL; "?v=" on an empty URL would fetch the document itself`);
  if (/[\s\u0000-\u001f]/.test(url)) throw new Error(`${where}: URL "${url}" carries whitespace or a control character; the URL parser strips/percent-encodes them, so they hide schemes (" https://…", "java\\tscript:") — write a clean app-relative path`);
  if (/[?#]/.test(url)) throw new Error(`${where}: URL "${url}" carries a query or fragment; the stamp expects a bare path`);
  if (/[&\\]/.test(url)) throw new Error(`${where}: URL "${url}" carries '&' or '\\\\'; attribute entities (javascript&colon;) and CSS escape sequences (\\.css) decode to something else in the browser, so the stamp could not vouch for what is actually fetched`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) throw new Error(`${where}: URL "${url}" is not app-relative (a scheme or protocol-relative '//host' is unreachable through the app origin — no CDN rule)`);
  return `${url}?v=${version}`;
};
// Stamping parses, it does not pattern-match URLs: htmlTagRe captures each
// <script>/<link> start tag with quoted attribute values consumed whole (a
// `>` inside title="a>b" cannot truncate the match before the real href —
// the HTML spec allows `>` in quoted values), and stampAttrs tokenises the
// attribute list the same way, so every src/href is found in any position
// with any quoting (single quotes, spaces around '=', unquoted values) and
// nothing else is touched: a src/href merely *mentioned* inside another
// attribute's quoted text is part of that attribute's value token, passed
// through verbatim. Each found URL goes through stamp() — a hand-written
// `src='a.js#x?v=…'` decoy hits its '#/'?' rejection, not a lenient
// endsWith — and is re-emitted double-quoted. A `>` or `"` inside a URL
// value is rejected outright: the first would truncate the request URL,
// the second would end the single-quoted attribute early in the output
// (the browser then fetches the truncated bare path, un-stamped). The one
// shape tokenising cannot see through is a tag with unbalanced quotes
// (src=" unterminated): the match stops at the tag's real '>' and a later
// attribute would ship unstamped — so matched-tag count must equal
// opening-tag count.
const openTags = (html.match(/<(?:script|link)\b/gi) ?? []).length;
const htmlTagRe = /<(script|link)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?>)/gi;
const attrTokRe = /([^\s"'=/<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gi;
// Returns the tag rewritten; every src/href — any position, any quoting —
// goes through stamp(), everything else passes through verbatim.
const stampAttrs = (name, attrs) => {
  attrTokRe.lastIndex = 0;
  let outAttrs = "";
  let cursor = 0;
  const seen = new Set();
  for (let m = attrTokRe.exec(attrs); m !== null; m = attrTokRe.exec(attrs)) {
    const attrName = m[1].toLowerCase();
    if (seen.has(attrName)) throw new Error(`dist/index.html: <${name}> repeats the ${attrName} attribute — the parser drops duplicates, so one would ship un-stamped`);
    seen.add(attrName);
    if (attrName !== "src" && attrName !== "href") continue;
    if (m[2] === undefined && m[3] === undefined && m[4] === undefined) throw new Error(`dist/index.html: <${name}> ${attrName} has no value — nothing to stamp`);
    const url = m[2] ?? m[3] ?? m[4];
    if (/[>"]/.test(url)) throw new Error(`dist/index.html: <${name}> ${attrName}="${url}" contains '${url.includes(">") ? ">" : "\""}'; the browser would end the request URL (or, from a single-quoted attribute, this attribute) there and fetch the truncated bare path`);
    outAttrs += attrs.slice(cursor, m.index) + `${attrName}="${stamp(`index.html <${name}>`, url)}"`;
    cursor = m.index + m[0].length;
  }
  return outAttrs + attrs.slice(cursor);
};
html = html.replace(htmlTagRe, (tag, name, attrs, closer) => `<${name}${stampAttrs(name, attrs)}${closer}`);
const matchedTags = (html.match(htmlTagRe) ?? []).length;
if (matchedTags !== openTags) throw new Error(`dist/index.html: ${openTags} <script>/<link> tags but the stamper matched ${matchedTags} — one has an unbalanced quote the parser cannot see through`);
// A relative CSS @import does not inherit the parent link's query, so the
// stylesheets reachable only through @import (layout.css -> _index.css ->
// the layout partials) are stamped in place in dist/. The scan is a token
// walk: comments, strings and @import statements are matched by one
// alternation, so a `/*`, `*/` or `@import` inside a string is consumed as
// string (it neither swallows later imports nor gets corrupted itself), and
// a string inside a comment is comment — CSS's own tokenizing. Case follows
// CSS (`@IMPORT` is the same at-rule). Loud on everything else: a comment
// marker inside a string, statements without ';', media/layer suffixes or
// other targets the parser can't read, unterminated comments/strings (any
// '/*' or stray quote left in the non-token gaps), and
// any URL stamp() rejects (query, fragment, `data:`/scheme) plus
// protocol-relative `//host` (unreachable through the app origin, and
// invisible to stamp()'s scheme check). Plain url() in other properties is
// untouched — only statements match.
const cssTokenRe = /\/\*[\s\S]*?\*\/|"(?:[^"\\\n\r]|\\.)*"|'(?:[^'\\\n\r]|\\.)*'|@import\b[^;]*(;?)/gi;
const cssTargetRe = /^url\(\s*(["']?)([^"')\s]+)\1\s*\)$|^["']([^"']+)["']$/i;
for (const rel of readdirSync(out, { recursive: true })) {
  if (!rel.endsWith(".css")) continue;
  const file = join(out, rel);
  const css = readFileSync(file, "utf8");
  // Files with neither '@import' nor a '\' cannot need stamping. The
  // backslash matters: '@\69 mport' aliases the at-rule but matches
  // neither this filter nor cssTokenRe, and the walk below throws on any
  // '\' it can't place, so escaped spellings fail the build instead of
  // slipping through the skip un-stamped.
  if (!/@import/i.test(css) && !css.includes("\\")) continue;
  cssTokenRe.lastIndex = 0;
  let stampedCss = "";
  let cursor = 0;
  // Text between tokens must be ordinary code: a '/*' left there is a
  // comment the token walk never closed, a stray quote an unbalanced
  // string, a '\' an escape sequence — '@\69 mport' aliases '@import' but
  // dodges the token regex, so it would ship un-stamped. Checking every
  // gap (not just the tail) catches a '/*' that precedes a later token.
  const keepGap = (to) => {
    const gap = css.slice(cursor, to);
    if (/\/[*]|["']|\\/.test(gap)) throw new Error(`dist/${rel}: unterminated comment, unbalanced quote, or escape sequence near "${gap.trim().slice(0, 60)}" — the scanner could not tokenise the rest`);
    stampedCss += gap;
  };
  for (let m = cssTokenRe.exec(css); m !== null; m = cssTokenRe.exec(css)) {
    const token = m[0];
    if (token.startsWith("/*") || token.startsWith('"') || token.startsWith("'")) {
      if (!token.startsWith("/*") && /\/[*]|[*]\//.test(token)) throw new Error(`dist/${rel}: comment marker inside the string ${token} — a later '*/' would make the scanner treat real code as a comment`);
      keepGap(m.index);
      stampedCss += token;
      cursor = m.index + token.length;
      continue;
    }
    const target = token.slice("@import".length).trim();
    if (!target.endsWith(";")) throw new Error(`dist/${rel}: @import ${target || "(nothing)"} has no terminating ';' — it would ship un-stamped`);
    const body = target.slice(0, -1).trim();
    const urlm = cssTargetRe.exec(body);
    if (!urlm) throw new Error(`dist/${rel}: @import target "${body}" is not a bare quoted or url() path the stamp can read (a media/layer/supports suffix would be dropped here)`);
    const url = (urlm[2] ?? urlm[3]).trim();
    keepGap(m.index);
    // Re-emit the ';' the token consumed: without it the next @import is
    // parsed into this rule's prelude and the whole run is dropped.
    stampedCss += `@import "${stamp(`dist/${rel}`, url)}";`;
    cursor = m.index + token.length;
  }
  keepGap(css.length);
  writeFileSync(file, stampedCss);
}
writeFileSync(join(out, "index.html"), html);

console.log(`dist/: compiled ${compiled} JSX files (${bytesIn >> 10} KB → ${bytesOut >> 10} KB), dropped Babel and development React`);
