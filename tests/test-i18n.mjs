#!/usr/bin/env node
// Regression script for src/app/i18n.js and the coverage of
// src/app/i18n-zh.js: Settings text, every literal the interface wraps and
// the desktop's own string tables.
// Run: node tests/test-i18n.mjs  (or: npm run test:i18n)
//
// Both files are browser IIFEs writing to `window`; load them by evaluating
// their source against a stub global, like tests/test-keymap.mjs does. The
// module reads navigator/document/localStorage off `window`, so a stub with
// none of them is a valid English test bed.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const Babel = require(join(root, "src/babel.min.js"));

/** A window stub for one test bed. */
const makeWindow = (over = {}) => ({
  navigator: { language: "en-US" },
  localStorage: { getItem: () => null },
  ...over,
});

/** Evaluate one src/ file against `win`. */
function load(file, win) {
  const src = readFileSync(join(root, "src", file), "utf8");
  new Function("window", src)(win);
  return win;
}

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

// ── core, English only ──────────────────────────────────────────────────
const w1 = load("app/i18n.js", makeWindow());
const I = w1.OMP_I18N;

check("no dictionary: source strings and locale en", () => {
  assert.equal(I.locale, "en");
  assert.equal(w1.OMP_TR, I.t);
  assert.equal(I.t("Close tab"), "Close tab");
  assert.equal(I.t(""), "");
  assert.equal(I.t(42), 42);           // non-strings pass through (optional props)
  assert.equal(I.set("zh"), "en");     // nothing registered for zh yet
});

check("add + set translate and interpolate", () => {
  I.add("zh", { "Close tab": "关闭标签页", "Hello {name}": "你好 {name}" });
  I.set("zh");
  assert.equal(I.locale, "zh");
  assert.equal(I.t("Close tab"), "关闭标签页");
  assert.equal(I.t("Unknown"), "Unknown");          // missing entry → source
  assert.equal(I.t("Hello {name}", { name: "A" }), "你好 A");
  assert.equal(I.t("Hello {name}"), "你好 {name}");  // no vars → placeholder stays
  assert.equal(I.set("zh-Hans-CN"), "zh");          // registering made zh resolvable
});

check("locale tags match by full tag, primary subtag, case and separator", () => {
  assert.equal(I.set("zh-CN"), "zh");
  assert.equal(I.set("ZH_tw"), "zh");
  assert.equal(I.set("zh"), "zh");
  assert.equal(I.set("fr"), "en");                  // untranslated → source
  assert.equal(I.locale, "en");
});

check("auto follows the OS language", () => {
  w1.navigator.language = "zh-CN";
  assert.equal(I.set("auto"), "zh");
  assert.equal(I.requested, "auto");
  w1.navigator.language = "fr-FR";
  assert.equal(I.set("auto"), "en");                // no fr dictionary
});

check("languagechange re-resolves auto but keeps an explicit choice", () => {
  const handlers = {};
  const w = load("app/i18n.js", makeWindow({
    addEventListener: (type, fn) => { handlers[type] = fn; },
  }));
  w.OMP_I18N.add("zh", { Hi: "嗨" });
  assert.equal(w.OMP_I18N.locale, "en");
  w.navigator.language = "zh-CN";
  handlers.languagechange();
  assert.equal(w.OMP_I18N.locale, "zh");            // auto follows the webview
  w.OMP_I18N.set("en");
  w.navigator.language = "zh-CN";
  handlers.languagechange();
  assert.equal(w.OMP_I18N.locale, "en");            // explicit choice stays
});

check("plural picks the English form without a dictionary entry", () => {
  I.set("en");
  assert.equal(I.plural(1, "one apple", "{n} apples"), "one apple");
  assert.equal(I.plural(2, "{n} apple", "{n} apples"), "2 apples");
  assert.equal(I.plural(0, "{n} apple", "{n} apples"), "0 apples");
});

check("plural uses the dictionary's PluralRules categories", () => {
  I.add("zh", { "{n} files": { one: "{n} 个文件", other: "{n} 个文件" } });
  I.set("zh");
  assert.equal(I.plural(1, "{n} file", "{n} files"), "1 个文件");
  assert.equal(I.plural(3, "{n} file", "{n} files"), "3 个文件");
});

check("set is idempotent and reports the resolved locale", () => {
  assert.equal(I.set("zh"), "zh");
  assert.equal(I.set("zh"), "zh");
  assert.equal(I.requested, "zh");
});

check("document lang follows the locale when a document exists", () => {
  const w = load("app/i18n.js", makeWindow({ document: { documentElement: { lang: "en" } } }));
  w.OMP_I18N.add("zh", { Hi: "嗨" });
  w.OMP_I18N.set("zh");
  assert.equal(w.document.documentElement.lang, "zh");
});

// ── stored locale, dictionary arriving afterwards ───────────────────────
check("dictionary loaded after init re-resolves the stored locale", () => {
  const w = makeWindow({ localStorage: { getItem: () => JSON.stringify({ locale: "zh" }) } });
  load("app/i18n.js", w);
  assert.equal(w.OMP_I18N.locale, "en");   // no zh dictionary yet
  load("app/i18n-zh.js", w);
  assert.equal(w.OMP_I18N.locale, "zh");   // app/i18n-zh.js follows it
  assert.equal(w.OMP_TR("Settings"), "设置");
});

// ── shipped dictionary covers the interface ─────────────────────────────
// The zh entries as app/i18n-zh.js registers them.
const ZH = {};
load("app/i18n-zh.js", { OMP_I18N: { add: (code, strings) => { if (code === "zh") Object.assign(ZH, strings); } } });
const hasZh = (s) => Object.prototype.hasOwnProperty.call(ZH, s);

// Settings schema and the desktop's string tables, loaded in index.html order.
const w2 = load("app/i18n.js", makeWindow());
load("app/i18n-zh.js", w2);
w2.OMP_I18N.set("zh");
for (const f of ["app/constants.js", "app/keymap.js", "app/slash-commands.js", "app/approval-mode.js", "app/settings-schema.js"]) load(f, w2);
const S = w2.OMP_SETTINGS;

/** Fails listing every string of `strings` without a zh entry. */
function assertTranslated(strings) {
  const missing = [...new Set(strings.filter(s => typeof s === "string" && s && !hasZh(s)))];
  assert.deepEqual(missing, [], `missing zh entries:\n${missing.map(s => `  ${JSON.stringify(s)}`).join("\n")}`);
}

check("every Settings section, group, label and description is translated", () => {
  const strings = [];
  const want = (s) => strings.push(s);
  for (const section of S.SECTIONS) {
    want(section.title);
    want(section.blurb);
    for (const group of section.groups) {
      want(group.name);
      for (const row of group.rows) {
        want(row.label);
        want(row.desc);
      }
    }
  }
  assertTranslated(strings);
});

check("the dictionary never maps a string to an empty value", () => {
  const src = readFileSync(join(root, "src/app/i18n-zh.js"), "utf8");
  assert.doesNotMatch(src, /:\s*""\s*,?/);
});

check("search finds settings by their translated text too", () => {
  const byZh = S.search("语言", {});
  assert.ok(byZh.total >= 1);
  assert.ok(byZh.groups.some(g => g.rows.some(r => r.id === "locale")));
  const byEn = S.search("language", {});
  assert.ok(byEn.total >= 1);
});

check("the language row is a locale tweak defaulting to auto", () => {
  const row = S.rows().find(r => r.id === "locale");
  assert.equal(row.kind, "tweak");
  assert.equal(row.key, "locale");
  assert.deepEqual(row.options.map(o => o.value), ["auto", "en", "zh"]);
  assert.equal(S.clamp(row, "zh"), "zh");
  assert.equal(S.clamp(row, "nope"), "auto");      // falls back to the default
});

check("the desktop's own string tables are translated", () => {
  assertTranslated(w2.OMP_KEYMAP.KEYMAP_ACTIONS.flatMap(a => [a.label, a.group]));
  assertTranslated(w2.OMP_SLASH.LOCAL_COMMANDS.flatMap(c => [c.hint, c.group]));
  assertTranslated(w2.OMP_APPROVAL_MODE.MODES.flatMap(m => [m.label, m.blurb]));
  assertTranslated(Object.values(w2.THINKING_LEVELS).map(l => l.hint));
});

/** Source strings a translation call receives: the literal, or both
 *  literal branches of a `cond ? "a" : "b"` argument. */
function literals(node) {
  if (!node) return [];
  if (node.type === "StringLiteral") return [node.value];
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return [node.quasis[0].value.cooked];
  if (node.type === "ConditionalExpression") return [...literals(node.consequent), ...literals(node.alternate)];
  return [];
}

/** `OMP_TR` / `window.OMP_TR` / `[window.]OMP_I18N.t` → the source argument
 *  index; `OMP_I18N.plural(n, one, other)` → `other`, the dictionary key. */
function keyArg(callee) {
  const name = callee.type === "Identifier" ? callee.name
    : callee.type === "MemberExpression" && !callee.computed ? callee.property.name : null;
  const owner = callee.type === "MemberExpression" ? callee.object : null;
  const ownerName = owner?.type === "Identifier" ? owner.name : owner?.type === "MemberExpression" ? owner.property.name : null;
  if (name === "OMP_TR") return 0;
  if (ownerName === "OMP_I18N" && name === "t") return 0;
  if (ownerName === "OMP_I18N" && name === "plural") return 2;
  return -1;
}

check("every literal the interface translates has an entry", () => {
  const missing = [];
  const files = [join(root, "src/app-live.jsx")];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.jsx?$/.test(name) && !name.startsWith("i18n")) files.push(p);
    }
  })(join(root, "src/design"));
  for (const name of readdirSync(join(root, "src/app"))) {
    if (/\.jsx?$/.test(name) && !name.startsWith("i18n")) files.push(join(root, "src/app", name));
  }
  for (const file of files) {
    const rel = file.slice(root.length + 1);
    // A file that does not parse would silently escape the check.
    const { ast } = Babel.transform(readFileSync(file, "utf8"), { parserOpts: { plugins: ["jsx"] }, ast: true, code: false });
    (function walk(node) {
      if (!node || typeof node !== "object") return;
      if (node.type === "CallExpression") {
        const i = keyArg(node.callee);
        if (i >= 0) for (const key of literals(node.arguments[i])) if (!hasZh(key)) missing.push(`${key} (${rel})`);
      }
      for (const k in node) {
        const v = node[k];
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") walk(v);
      }
    })(ast.program);
  }
  assert.deepEqual(missing, [], `add these to src/app/i18n-zh.js:\n${missing.join("\n")}`);
});

console.log(`test-i18n: ${passed} checks passed`);
