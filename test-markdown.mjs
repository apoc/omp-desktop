#!/usr/bin/env node
// Regression script for src/app/marked-setup.js — the marked renderers that
// keep agent output from running script in the app's privileged origin
// (window.__TAURI__): raw HTML, marked's raw-block text after an inline
// <pre>/<code>/<kbd>/<script>, and javascript:-style link hrefs.
// Loads the vendored marked + hljs and the setup file exactly as index.html
// does, then checks that no rendered element or attribute comes from input.
// Run: node test-markdown.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dir = dirname(fileURLToPath(import.meta.url));
const load = (p) => readFileSync(join(__dir, "src", p), "utf8");

// decodeRefs feeds single `&…;` references through a <textarea>; this shim
// decodes the same way for numeric and the few named references used below,
// and leaves unknown names literal (as the browser's prefix-decode rejection
// does).
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', colon: ":", Tab: "\t", NewLine: "\n" };
const document = {
  createElement: () => {
    let value = "";
    return {
      set innerHTML(ref) {
        const m = /^&(?:#(\d+)|#[xX]([\da-fA-F]+)|([A-Za-z][A-Za-z\d]*));$/.exec(ref);
        value = !m ? ref
          : m[1] ? String.fromCodePoint(+m[1])
          : m[2] ? String.fromCodePoint(parseInt(m[2], 16))
          : NAMED[m[3]] ?? ref;
      },
      get value() { return value; },
    };
  },
};
const ctx = vm.createContext({ document, console, URL });
ctx.window = ctx;
for (const f of ["marked.min.js", "highlight.min.js", "app/marked-setup.js"]) {
  vm.runInContext(load(f), ctx, { filename: f });
}
const { marked } = ctx;
// The two ways the app renders markdown: MarkdownContent (ui/markdown.jsx)
// and one top-level token at a time (segmentPlan, ui/plan-annotations.jsx).
const renderers = {
  parse: (md) => marked.parse(md),
  plan: (md) => marked.lexer(md)
    .filter((t) => t.type !== "space" && t.type !== "def")
    .map((t) => marked.parser([t]))
    .join(""),
};

// Everything the renderers themselves emit. Any other tag, or an attribute
// outside this list, can only have come from the input.
const TAGS = new Set(["p", "br", "strong", "em", "code", "pre", "span", "a", "ul", "ol", "li",
  "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr",
  "th", "td", "del", "input", "img"]);
const ATTRS = new Set(["class", "href", "title", "align", "start", "type", "checked", "disabled", "src", "alt"]);
function liveMarkup(html) {
  const bad = [];
  for (const [tag, name, attrs] of html.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)) {
    if (!TAGS.has(name.toLowerCase())) { bad.push(tag); continue; }
    for (const [, attr] of attrs.matchAll(/\s([^\s="'>/]+)/g)) {
      if (!ATTRS.has(attr.toLowerCase())) bad.push(tag);
    }
    const href = /\s(?:href|src)="([^"]*)"/.exec(attrs)?.[1];
    if (href && /^\s*(?:javascript|vbscript|data:text)/i.test(href)) bad.push(tag);
  }
  return bad;
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

const PAYLOADS = {
  "block <img onerror>": `<img src=x onerror="alert(1)">`,
  "block <svg onload>": `<svg onload="alert(1)"></svg>`,
  "block <script>": `<script>alert(1)</script>`,
  "block <details ontoggle>": `<details open ontoggle="alert(1)"><summary>s</summary>x</details>`,
  "block <iframe srcdoc>": `<iframe srcdoc="<script>alert(1)</script>"></iframe>`,
  "block <style>": `<style>body{display:none}</style>`,
  "comment then tag": `<!-- c --><img src=x onerror="alert(1)">`,
  "inline handler": `a <b onmouseover="alert(1)">b</b> c`,
  "inline <img> in list": `- item <img src=z onerror="alert(1)">`,
  "inline <img> in quote": `> <img src=q onerror="alert(1)">`,
  "inline <img> in table": `| a |\n|---|\n| <img src=t onerror="alert(1)"> |`,
  "inline <img> in heading": `# h <img src=h onerror="alert(1)">`,
  "inline <img> in link text": `[<img src=l onerror="alert(1)">](https://ok.test)`,
  "raw-block after <code>": `x <code> <img/src=x onerror=alert(1)>`,
  "raw-block after <pre>": `x <pre> <img src=x onerror=alert(1)//`,
  "raw-block after <kbd>": `press <kbd> <img/src=x onerror=alert(1)>`,
  "raw-block after <script>": `a <script> <img/src=x onerror=alert(1)>`,
  "raw-block across paragraphs": `Step 1: wrap in <code>\n\nStep 2: <img/src=x onerror=alert(1)>`,
  "raw-block overlay div": `x <code> <div/style=position:fixed;inset:0>`,
  "javascript: link": `[a](javascript:alert(1))`,
  "entity-hidden javascript: link": `[a](&#106;avascript:alert(1))`,
  "hex-entity javascript: link": `[a](&#x6A;avascript:alert(1))`,
  "named-entity colon link": `[a](javascript&colon;alert(1))`,
  "reference javascript: link": `[x][r]\n\n[r]: &#106;avascript:alert(1)`,
  "javascript: autolink": `<javascript:alert(1)>`,
  "data: link": `[a](data:text/html,<script>alert(1)</script>)`,
};

for (const [label, md] of Object.entries(PAYLOADS)) {
  for (const [mode, render] of Object.entries(renderers)) {
    check(`${label} (${mode}) renders no live markup`, () => {
      const html = render(md);
      assert.deepEqual(liveMarkup(html), [], html);
    });
  }
}

// ── What the user sees instead ───────────────────────────────────────────

check("block raw HTML is shown as its source text, in its own paragraph", () => {
  assert.equal(marked.parse('<div class="x">\nhi\n</div>\n\npara'),
    '<p>&lt;div class=&quot;x&quot;&gt;\nhi\n&lt;/div&gt;</p>\n<p>para</p>\n');
});

check("character references after a raw-block tag still read as characters", () => {
  assert.equal(marked.parse("wrap in <code>x then &amp; &#60; & <b>"),
    "<p>wrap in &lt;code&gt;x then &amp; &#60; &amp; &lt;b&gt;</p>\n");
});

check("inline raw HTML is shown as its source text", () => {
  assert.equal(marked.parse("a <kbd>Ctrl</kbd> b"), "<p>a &lt;kbd&gt;Ctrl&lt;/kbd&gt; b</p>\n");
});

check("raw-block text is shown as its source text", () => {
  assert.equal(marked.parse("x <code> <img/src=x onerror=alert(1)>"),
    "<p>x &lt;code&gt; &lt;img/src=x onerror=alert(1)&gt;</p>\n");
});

check("raw HTML in a plan segment is shown as text", () => {
  assert.equal(renderers.plan("<details>y</details>"), "<p>&lt;details&gt;y&lt;/details&gt;</p>\n");
});

// ── Ordinary markdown is unaffected ──────────────────────────────────────

check("inline markdown, links and autolinks still render", () => {
  assert.equal(marked.parse("**b** _i_ `c` [l](https://x.y) <https://a.b> & 1 < 2"),
    '<p><strong>b</strong> <em>i</em> <code>c</code> <a href="https://x.y">l</a> ' +
    '<a href="https://a.b">https://a.b</a> &amp; 1 &lt; 2</p>\n');
});

check("HTML inside a code span stays escaped code", () => {
  assert.equal(marked.parse("use `<img onerror=x>` here"), "<p>use <code>&lt;img onerror=x&gt;</code> here</p>\n");
});

check("fenced code is highlighted and escaped", () => {
  const html = marked.parse('```js\nconst a = "<b>";\n```');
  assert.match(html, /^<pre class="code-block"><code class="hljs language-js"><span class="hljs-keyword">const<\/span>/);
  assert.ok(html.includes("&lt;b&gt;"), html);
});

check("query-string links keep legacy-looking & sequences literal", () => {
  assert.equal(marked.parse("[pay](https://x.test/c?amount=10&currency=USD)"),
    '<p><a href="https://x.test/c?amount=10&amp;currency=USD">pay</a></p>\n');
});

check("mailto links survive the scheme check", () => {
  assert.equal(marked.parse("[m](mailto:a@b.c)"), '<p><a href="mailto:a@b.c">m</a></p>\n');
});

console.log(`markdown: ${passed} checks passed`);
