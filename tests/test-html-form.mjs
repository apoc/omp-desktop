#!/usr/bin/env node
// Regression script for src/app/html-form.js — omp's ask tool HTML form:
// parsing into a render model, the draft and reply `data` shape, defaults,
// validation, and the rendering-safe image rule.
// Run: node tests/test-html-form.mjs

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = join(root, "src/app/html-form.js");
assert.ok(existsSync(path), "src/app/html-form.js must exist");
const win = {};
// Same realm as the test's arrays/objects (new Function, not a vm context):
// deep equality must not trip over cross-realm prototypes.
new Function("window", "DOMParser", readFileSync(path, "utf8"))(win, undefined);
const H = win.OMP_HTML_FORM;

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`ok ${passed} - ${label}`);
}

// ── A tiny DOM for Node ─────────────────────────────────────────────────────
// The app parses with the browser's DOMParser. Node has none and jsdom is not
// a dependency, so this shim covers the HTML the parser reads: elements,
// attributes, text, comments, void tags and raw-text elements.
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "template"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
const decode = text => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, ref) => {
  if (ref[0] === "#") return String.fromCodePoint(ref[1].toLowerCase() === "x" ? parseInt(ref.slice(2), 16) : Number(ref.slice(1)));
  return ENTITIES[ref.toLowerCase()] ?? all;
});
function element(name, attributes = {}) {
  return {
    nodeType: 1, localName: name, attributes, childNodes: [],
    getAttribute(key) { return Object.hasOwn(this.attributes, key) ? this.attributes[key] : null; },
    hasAttribute(key) { return Object.hasOwn(this.attributes, key); },
    get textContent() {
      return this.childNodes.map(node => node.nodeType === 3 ? node.data : node.textContent).join("");
    },
  };
}
function parseDocument(html) {
  const head = element("head");
  const body = element("body");
  const documentElement = element("html");
  const root = element("#document");
  documentElement.childNodes.push(head, body);
  root.childNodes.push(documentElement);
  root.documentElement = documentElement;
  root.body = body;
  const stack = [body];
  const pushText = data => stack.at(-1).childNodes.push({ nodeType: 3, data: decode(data) });
  const start = /<([a-z][a-z0-9:-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/iy;
  const attrs = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { pushText(html.slice(i)); break; }
    if (lt > i) pushText(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === "/") {
      const end = html.indexOf(">", lt);
      const name = html.slice(lt + 2, end).trim().toLowerCase();
      if (name === "head") stack.splice(0, stack.length, body);
      else for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].localName === name) { stack.length = k; break; }
      }
      i = end + 1;
      continue;
    }
    start.lastIndex = lt;
    const match = start.exec(html);
    if (!match) { pushText("<"); i = lt + 1; continue; }
    if (match[1].toLowerCase() === "head") {
      stack.splice(0, stack.length, head);
      i = start.lastIndex;
      continue;
    }
    const node = element(match[1].toLowerCase());
    let attr;
    attrs.lastIndex = 0;
    while ((attr = attrs.exec(match[2]))) {
      const value = attr[2] ?? attr[3] ?? attr[4] ?? "";
      if (!(attr[1] in node.attributes)) node.attributes[attr[1]] = decode(value);
    }
    stack.at(-1).childNodes.push(node);
    i = start.lastIndex;
    if (!VOID.has(node.localName) && !/\/>$/.test(match[0])) stack.push(node);
    if (RAW.has(node.localName)) {
      const close = html.toLowerCase().indexOf(`</${node.localName}>`, i);
      if (close >= 0) {
        node.childNodes.push({ nodeType: 3, data: html.slice(i, close) });
        i = close + node.localName.length + 3;
        stack.pop();
      }
    }
  }
  return root;
}
const parse = html => H.parse(html, parseDocument(html));
const fields = html => parse(html).form.fields;
const field = (html, name, index = 0) => fields(html).filter(f => f.name === name)[index];

// ── Parse: omp's own examples and control semantics ─────────────────────────
const legacy = `<form>
  <fieldset><legend>Which database?</legend>
    <label><input type="radio" name="database" value="PostgreSQL" checked> PostgreSQL — the default</label>
    <label><input type="radio" name="database" value="MySQL"> MySQL</label>
  </fieldset>
  <fieldset><legend>What should I install?</legend>
    <label><input type="checkbox" name="extras" value="ci" checked> CI</label>
    <label><input type="checkbox" name="extras" value="docker"> Docker</label>
  </fieldset>
  <fieldset><legend>Anything else?</legend><textarea name="notes"></textarea></fieldset>
</form>`;

check("omp's legacy-questions HTML parses its fieldsets, groups and defaults", () => {
  const parsed = parse(legacy);
  assert.equal(parsed.error, undefined, parsed.error);
  const { form } = parsed;
  assert.deepEqual(form.fields.map(f => f.name), ["database", "extras", "notes"]);
  assert.deepEqual(form.fields.map(f => f.kind), ["choice", "choice", "text"]);
  assert.deepEqual(form.fields.map(f => f.label), ["", "", "notes"]);
  assert.equal(form.sections.length, 3);
  assert.deepEqual(form.sections.map(s => s.title), ["Which database?", "What should I install?", "Anything else?"]);
  assert.deepEqual(form.fields[0].options.map(o => o.label), ["PostgreSQL — the default", "MySQL"]);
  assert.deepEqual(form.fields[0].options.map(o => o.checked), [true, false]);
  assert.equal(form.fields[0].multi, false);
  assert.equal(form.fields[0].other, true);
  assert.equal(form.fields[1].multi, true);
  assert.equal(form.fields[1].other, true);
  assert.equal(form.fields[2].type, "textarea");
  assert.equal(form.fields[2].multiline, true);
  assert.equal(form.fields[2].rows, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(H.defaultData(form))), { database: "PostgreSQL", extras: ["ci"], notes: "" });
});

const mixed = `<form>
  <input type="hidden" name="token" value="abc">
  <fieldset><legend>Setup</legend>
    <p>Pick a <code>database</code> and a port.</p>
    <label><input type="radio" name="db" value="pg" checked> Postgres</label>
    <label><input type="radio" name="db" value="my"> MySQL</label>
    <input type="radio" name="db" value="off" disabled>
    <label for="port">Port</label>
    <select id="port" name="port">
      <option value="5432" selected>5432</option>
      <option value="3306">3306</option>
      <option value="1" disabled>disabled</option>
    </select>
  </fieldset>
  <label>Features
    <input type="checkbox" name="feature" value="ci" checked>
    <input type="checkbox" name="feature" value="docker">
    <input type="checkbox" name="feature" value="rust" disabled>
  </label>
  <label>Enabled <input type="checkbox" name="enabled" value="yes" checked></label>
  <label>Name <input name="name" value="Ann" placeholder="Your name" required minlength="2"></label>
  <label>Count <input type="number" name="count" value="3" min="1" max="10"></label>
  <label>Notes <textarea name="notes" rows="5">Hello</textarea></label>
  <img src="https://example.test/secret.png?token=1" alt="Architecture diagram">
</form>`;

check("controls keep names, labels, defaults, limits and disabled options", () => {
  const { form } = parse(mixed);
  assert.deepEqual(form.hidden, [["token", "abc"]]);
  const by = Object.fromEntries(form.fields.map(f => [f.name, f]));
  assert.deepEqual(by.db.options.map(o => [o.value, o.checked, o.disabled]), [["pg", true, false], ["my", false, false], ["off", false, true]]);
  assert.equal(by.db.other, true);
  assert.equal(by.port.select, true);
  assert.deepEqual(by.port.options.map(o => o.checked), [true, false, false]);
  assert.equal(by.feature.multi, true);
  assert.equal(by.enabled.multi, true);
  assert.deepEqual(by.feature.options.map(o => o.checked), [true, false, false]);
  assert.equal(by.name.label, "Name");
  assert.equal(by.name.placeholder, "Your name");
  assert.equal(by.name.required, true);
  assert.equal(by.name.minLength, 2);
  assert.equal(by.count.type, "number");
  assert.equal(by.count.min, 1);
  assert.equal(by.count.max, 10);
  assert.equal(by.notes.value, "Hello");
  assert.equal(by.notes.rows, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(H.defaultData(form))), {
    token: "abc", db: "pg", port: "5432", feature: ["ci"], enabled: "yes", name: "Ann", count: 3, notes: "Hello",
  });
});

check("an Other option already in the group suppresses omp's automatic Other", () => {
  const html = `<form><label><input type="radio" name="x" value="a" checked>A</label><label><input type="radio" name="x" value="other">Other…</label></form>`;
  const f = field(html, "x");
  assert.equal(f.other, false);
});

check("a lone select takes its first enabled option; a select never gets Other", () => {
  const html = `<form><select name="s"><option disabled value="x">X</option><option value="y">Y</option></select></form>`;
  const f = field(html, "s");
  assert.deepEqual(f.options.map(o => o.checked), [false, true]);
  assert.equal(f.other, false);
});

check("image pictures reach the model as alt text only, with no source URL", () => {
  const { form } = parse(`<form><img src="https://example.test/private.png?token=secret" alt="A diagram"><input name="x"></form>`);
  assert.deepEqual(form.sections[0].blocks[0], { kind: "image", alt: "A diagram" });
  assert.doesNotMatch(JSON.stringify(form), /private|token|example\.test/);
});

check("labels for controls, aria labels and name fallbacks are kept", () => {
  const { form } = parse(`<form><label for="a">Alpha</label><input id="a" name="a"><input name="zeta_x" aria-label="Zeta"><input name="last_name"></form>`);
  assert.deepEqual(form.fields.map(f => f.label), ["Alpha", "Zeta", "last name"]);
});

check("content outside the first form is ignored, including an outside control", () => {
  const { form } = parse(`<label><input name="outside"></label><form><input name="inside"></form><p>tail</p>`);
  assert.deepEqual(form.fields.map(f => f.name), ["inside"]);
});

check("empty, unnamed and malformed forms are refused instead of yielding an unanswerable card", () => {
  for (const html of ["", "   ", "<form></form>", "<form><label><input></label></form>", "<form><p>no controls</p></form>", "<form><script>alert(1)</script></form>"])
    assert.equal(typeof parse(html).error, "string", html);
  assert.equal(typeof H.parse(null).error, "string");
});

check("script, style and inline handler content never becomes text or fields", () => {
  const { form } = parse(`<form><script>alert("<input name='evil'>")</script><style><input name="css"></style><p onclick="steal()">Safe</p><input name="ok"></form>`);
  assert.deepEqual(form.fields.map(f => f.name), ["ok"]);
  assert.equal(form.sections[0].blocks[0].text, "Safe");
  assert.doesNotMatch(JSON.stringify(form), /alert|evil|steal/);
});

// ── Draft and reply data ───────────────────────────────────────────────────
check("draft picks and text produce omp's reply data including Other and arrays", () => {
  const { form } = parse(mixed);
  let draft = H.emptyDraft(form);
  draft = H.pick(draft, form, 0, 1);                       // db MySQL
  draft = H.setOther(draft, form, 0, "  MariaDB  ");      // radio Other replaces db
  draft = H.pick(draft, form, 2, 1);                       // add docker
  draft = H.setOther(draft, form, 2, " terraform ");      // checkbox Other appends
  draft = H.setText(draft, form, 4, " Ada ");
  draft = H.setText(draft, form, 5, "8.5");
  draft = H.setText(draft, form, 6, "bye");
  const data = JSON.parse(JSON.stringify(H.buildData(form, draft)));
  assert.deepEqual(data, {
    token: "abc", db: "MariaDB", port: "5432", feature: ["ci", "docker", "terraform"], enabled: "yes",
    name: " Ada ", count: 8.5, notes: "bye",
  });
  assert.equal(H.validateData(form, data), true, H.dataError(form, data));
});

check("blank Other text and unchecked boxes contribute nothing; numbers stay text when unparseable", () => {
  const { form } = parse(`<form><input name="n" type="number"><label><input type="checkbox" name="ok" value="on">Yes</label><label><input type="radio" name="r" value="a">A</label></form>`);
  let draft = H.emptyDraft(form);
  draft = H.setOther(draft, form, 2, "   ");
  draft = H.setText(draft, form, 0, "not a number");
  assert.deepEqual(JSON.parse(JSON.stringify(H.buildData(form, draft))), { n: "not a number" });
});

check("fieldError enforces required, numeric bounds, lengths, email and URL; pattern stays a hint", () => {
  const { form } = parse(`<form>
    <input name="req" required>
    <input name="num" type="number" min="2" max="4">
    <input name="len" minlength="3" maxlength="5">
    <input name="mail" type="email">
    <input name="url" type="url">
    <input name="pat" pattern="[a-z]+">
    <label><input type="checkbox" name="pick" value="a" required>Pick</label>
  </form>`);
  const by = name => form.fields.find(f => f.name === name);
  assert.equal(H.fieldError(by("req"), undefined), "Required");
  assert.equal(H.fieldError(by("num"), 5), "Must be at most 4");
  assert.equal(H.fieldError(by("num"), "x"), "Enter a number");
  assert.equal(H.fieldError(by("len"), "ab"), "Needs at least 3 characters");
  assert.equal(H.fieldError(by("mail"), "x"), "Enter an email address");
  assert.equal(H.fieldError(by("url"), "x"), "Enter a full URL");
  assert.equal(H.fieldError(by("pat"), "AB"), undefined);
  assert.equal(by("pat").pattern, "[a-z]+");
  assert.equal(H.fieldError(by("pick"), []), "Required");
});

check("password forms are refused with a terminal-only note", () => {
  const parsed = parse(`<form><input name="user" value="Ada"><input type="password" name="pw" value="prefilled-secret"></form>`);
  assert.equal(parsed.form, undefined);
  assert.equal(parsed.error, "This form asks for a password; enter it in a terminal instead — omp would echo it in its output.");
  assert.doesNotMatch(JSON.stringify(parsed), /prefilled-secret/);
});

check("autocomplete password markers are refused on every input type", () => {
  for (const autocomplete of ["current-password", "new-password", "off current-password", "section-login NEW-PASSWORD"]) {
    const parsed = parse(`<form><input type=text name=pw autocomplete="${autocomplete}" value=prefilled-secret></form>`);
    assert.equal(parsed.form, undefined, autocomplete);
    assert.equal(parsed.error, "This form asks for a password; enter it in a terminal instead — omp would echo it in its output.");
    assert.doesNotMatch(JSON.stringify(parsed), /prefilled-secret/);
  }
  assert.equal(parse(`<form><input name=user autocomplete=username value=Ada></form>`).error, undefined);
});

check("password markers match as decoded substrings, without token splitting", () => {
  const refusal = "This form asks for a password; enter it in a terminal instead — omp would echo it in its output.";
  for (const attribute of [
    "type=text autocomplete=\"foo\u00a0current-password\"",
    "autocomplete=\"section-login\u00a0new-password\"",
    "autocomplete=\"one-time-password-hint\"",
    "type=\"\uFEFFpassword\uFEFF\"",
    "type=Password",
    "autocomplete=new-password",
  ]) {
    const parsed = parse(`<form><input ${attribute} name=pw value=prefilled-secret></form>`);
    assert.equal(parsed.form, undefined, attribute);
    assert.equal(parsed.error, refusal);
    assert.doesNotMatch(JSON.stringify(parsed), /prefilled-secret/);
  }
  assert.equal(parse(`<form><input name=user type=text autocomplete=username value=Ada></form>`).error, undefined);
  assert.equal(parse(`<form><input name=note value=ordinary-text></form>`).error, undefined);
});

check("single-choice picks clear Other and missing checkbox values match omp's on default", () => {
  const { form } = parse(`<form><label><input type="radio" name="r" value="a">A</label><label><input type="radio" name="r" value="b">B</label><label><input type="checkbox" name="c" checked>C</label></form>`);
  let draft = H.setOther(H.emptyDraft(form), form, 0, "custom");
  draft = H.pick(draft, form, 0, 1);
  assert.deepEqual(draft[0], { picks: [1], other: "" });
  assert.equal(form.fields[1].options[0].value, "on");
});

check("duplicate enabled choice values are disabled after their first occurrence", () => {
  const { form } = parse(`<form><label><input type="checkbox" name="c" value="same">A</label><label><input type="checkbox" name="c" value="same">B</label><label><input type="checkbox" name="c" value="same" disabled>C</label></form>`);
  assert.deepEqual(form.fields[0].options.map(o => o.disabled), [false, true, true]);
});

check("oversized HTML, excessive nodes, deep nesting and over 1000 options are unsupported", () => {
  assert.match(H.parse("x".repeat(256 * 1024 + 1)).error, /too large/i);
  assert.match(parse(`<form><input name="x">${"<div>".repeat(70)}${"</div>".repeat(70)}</form>`).error, /could not be read/i);
  assert.match(parse(`<form><input name="x">${"<span></span>".repeat(10001)}</form>`).error, /could not be read/i);
  const options = Array.from({ length: 1001 }, (_, i) => `<option value="${i}">${i}</option>`).join("");
  assert.match(parse(`<form><select name="x">${options}</select></form>`).error, /could not be read/i);
});

check("node and depth limits cover the whole document, not only the first form", () => {
  assert.match(parse(`<form><input name="x"></form>${"<span></span>".repeat(10001)}`).error, /could not be read/i);
  assert.match(parse(`<form><input name="x"></form>${"<div>".repeat(70)}${"</div>".repeat(70)}`).error, /could not be read/i);
  assert.match(parse(`<head>${"<meta>".repeat(10001)}</head><form><input name="x"></form>`).error, /could not be read/i);
});

check("expanded display text is capped at 64 KiB, including the 2 KiB table fixture", () => {
  // One header borrowed by 42 rows expands a compact source to 55 KB of labels.
  const header = "h".repeat(1310);
  const controls = 42;
  const html = `<form><table><tr><th>${header}</th></tr>${'<tr><td><input name=r></td></tr>'.repeat(controls)}</table></form>`;
  assert.ok(html.length < 3 * 1024, `fixture source was ${html.length}`);
  assert.equal(header.length * controls, 55020);
  assert.match(parse(html.replace("</form>", `${"<p>context</p>".repeat(1600)}</form>`)).error, /could not be read/i);
  const hugeOptions = Array.from({ length: 700 }, (_, i) => `<option value="${i}">${"x".repeat(100)}</option>`).join("");
  assert.match(parse(`<form><select name="x">${hugeOptions}</select></form>`).error, /could not be read/i);
});

check("fallback field-name labels count toward the display budget", () => {
  const name = "fallback_".repeat(30);
  const html = `<form>${`<input name="${name}">`.repeat(300)}</form>`;
  assert.ok(html.length < 256 * 1024);
  assert.match(parse(html).error, /could not be read/i);
});

check("unlabeled choice-group name fallbacks count toward the display budget", () => {
  const name = "choice_".repeat(40);
  const groups = Array.from({ length: 300 }, (_, i) => `<input type="radio" name="${name}${i}" value="a"><input type="radio" name="${name}${i}" value="b">`).join("");
  const html = `<form>${groups}</form>`;
  assert.ok(html.length < 256 * 1024);
  assert.match(parse(html).error, /could not be read/i);
});

check("multiline options and table control labels follow omp's parse.ts oracle", () => {
  // Ported from parse.ts: option text uses /\s+/g, unlike ordinary spans.
  const ompOption = text => text.replace(/\s+/g, " ").trim();
  const { form } = parse(`<form><select name="s"><option> one\n  two </option></select><table><tr><th>Choice</th><th>Other</th></tr><tr><td><input type="radio" name="r" value="a"></td><td><input type="radio" name="r" value="b"></td></tr></table></form>`);
  assert.equal(form.fields[0].options[0].label, ompOption(" one\n  two "));
  // parse.ts gives an unlabelled control its column header. A column headed
  // Other therefore suppresses the group's automatic Other.
  const ompHeader = ["Choice", "Other"];
  assert.deepEqual(form.fields[1].options.map(o => o.label), ompHeader);
  assert.equal(form.fields[1].other, false);
});

check("a table control's own wrapping label wins over the whole cell", () => {
  const { form } = parse(`<form><table><tr><th>Header</th></tr><tr><td>Cell context <label>Own label <input name="answer"></label></td></tr></table></form>`);
  assert.equal(form.fields[0].label, "Own label");
});

check("collapsed summary prompt uses the same fallback label as the field budget", () => {
  const { form } = parse(`<form><select name="api_key"><option value="a">A</option></select></form>`);
  assert.equal(form.fields[0].label, "");
  assert.equal(H.summaryPrompt(form), "api key");
});

check("phone data omits hidden defaults while desktop data retains them authoritatively", () => {
  const { form } = parse(`<form><input type="hidden" name="large" value="secret"><input name="shown" value="yes"></form>`);
  assert.deepEqual(JSON.parse(JSON.stringify(H.buildData(form, H.emptyDraft(form), { hidden: false }))), { shown: "yes" });
  assert.deepEqual(JSON.parse(JSON.stringify(H.withHiddenDefaults(form, { shown: "yes" }))), { large: "secret", shown: "yes" });
  assert.deepEqual(JSON.parse(JSON.stringify(H.withHiddenDefaults(form, { large: "forged", shown: "yes" }))), { large: "secret", shown: "yes" });
});

check("range constraints are assigned before its value and native normalization is returned", () => {
  const input = {
    log: [], normalized: "4",
    set min(value) { this.log.push(["min", value]); },
    set max(value) { this.log.push(["max", value]); },
    set step(value) { this.log.push(["step", value]); },
    set value(value) { this.log.push(["value", value]); },
    get value() { return this.normalized; },
  };
  assert.equal(H.setInputValue(input, { type: "range", min: 1, max: 9, step: 0.5 }, "99"), "4");
  assert.deepEqual(input.log, [["min", 1], ["max", 9], ["step", 0.5], ["value", "99"]]);
});

check("summary shows visible answers only, never hidden values", () => {
  const { form } = parse(mixed);
  const s = H.summary(form, { token: "secret", db: "pg", feature: ["ci"], name: "Ada" });
  assert.equal(s.count, 3);
  assert.equal(s.answer, null);
  assert.doesNotMatch(JSON.stringify(s), /secret/);
  const one = H.summary(parse(`<form><input name="name"></form>`).form, { name: "Ada" });
  assert.deepEqual(one, { answer: "Ada", count: null });
});

// ── omp's validation, ported from rpc-mode.ts parseFormDialogResponse ───────
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const arrayChoice = f => f.multi && f.options.length > 1;
function ompChoiceValue(field, checked, other) {
  const typed = field.other ? other?.trim() : undefined;
  const values = field.options.flatMap((option, index) => checked.has(index) && !option.disabled ? [option.value] : []);
  if (arrayChoice(field)) return typed ? [...values, typed] : values;
  return typed || values[0];
}
function ompTextValue(field, text) {
  if ((field.type === "number" || field.type === "range") && text.trim() !== "") {
    const n = Number(text);
    if (Number.isFinite(n)) return n;
  }
  return text;
}
function ompParseChoice(field, value) {
  if (value === undefined) return ompChoiceValue(field, new Set());
  const array = arrayChoice(field);
  if (array !== Array.isArray(value)) throw new Error("choice shape");
  const entries = array ? value : [value];
  const checked = new Set();
  let other;
  for (const entry of entries) {
    if (typeof entry !== "string") throw new Error("choice entry");
    const enabled = field.options.findIndex(o => !o.disabled && o.value === entry);
    const index = enabled >= 0 ? enabled : field.options.findIndex(o => o.value === entry);
    if (index >= 0 && field.options[index].disabled) throw new Error("disabled option");
    if (index >= 0 && !checked.has(index)) checked.add(index);
    else if (index < 0 && field.other && other === undefined) other = entry;
    else throw new Error("unexpected option");
  }
  return ompChoiceValue(field, checked, other);
}
function ompParseText(field, value) {
  if (value === undefined) return ompTextValue(field, "");
  const numeric = field.type === "number" || field.type === "range";
  if (typeof value === "string" || (numeric && typeof value === "number" && Number.isFinite(value))) return ompTextValue(field, String(value));
  throw new Error("text shape");
}
function ompParseResponse(form, data) {
  if (!isRecord(data)) throw new Error("data object");
  const named = form.fields.filter(f => f.name);
  const names = new Set([...named.map(f => f.name), ...form.hidden.map(([name]) => name)]);
  for (const name of Object.keys(data)) if (!names.has(name)) throw new Error(`unknown ${name}`);
  const out = Object.assign(Object.create(null), Object.fromEntries(form.hidden));
  const hidden = new Map(form.hidden);
  const groups = Map.groupBy(named, f => f.name);
  for (const [name, group] of groups) {
    const entry = Object.hasOwn(data, name) ? data[name] : undefined;
    const hiddenValue = hidden.get(name);
    let mismatch;
    const values = group.map(f => {
      try {
        if (f.kind === "choice" && hiddenValue !== undefined) {
          const echo = Array.isArray(entry) ? entry.indexOf(hiddenValue) : entry === hiddenValue ? 0 : -1;
          if (echo >= 0) {
            const without = Array.isArray(entry) ? entry.toSpliced(echo, 1) : undefined;
            if (Array.isArray(entry) && !f.options.some(o => o.value === hiddenValue)) return { f, value: ompParseChoice(f, without), carried: true };
            try { return { f, value: ompParseChoice(f, entry), carried: true }; }
            catch { return { f, value: ompParseChoice(f, without), carried: true }; }
          }
        }
        return { f, value: f.kind === "choice" ? ompParseChoice(f, entry) : ompParseText(f, entry), carried: true };
      } catch (error) {
        if (group.length === 1) throw error;
        mismatch ??= error;
        return { f, value: f.kind === "choice" ? ompParseChoice(f, undefined) : ompParseText(f, undefined), carried: false };
      }
    });
    if (!values.some(v => v.carried)) throw mismatch;
    for (const { f, value, carried } of values) if (carried && value !== undefined) out[name] = value;
  }
  return out;
}
function rejects(form, data) {
  try { ompParseResponse(form, data); return false; } catch { return true; }
}

check("nested table rows are parsed only by their closest table, matching omp", () => {
  const { form } = parse(`<form><table><tr><th>Outer</th></tr><tr><td><label>Once <input type="checkbox" name="c" value="outer"></label><table><tr><td><label>Inner <input type="checkbox" name="c" value="inner"></label></td></tr></table></td></tr></table></form>`);
  assert.deepEqual(form.fields[0].options.map(option => option.value), ["outer", "inner"]);
  const data = H.buildData(form, H.pick(H.emptyDraft(form), form, 0, 1));
  assert.deepEqual(JSON.parse(JSON.stringify(data)), { c: ["inner"] });
  assert.doesNotThrow(() => ompParseResponse(form, data), "omp must accept the nested-table answer");
});

check("builder data is accepted by a port of omp's parseFormDialogResponse", () => {
  const { form } = parse(mixed);
  let draft = H.emptyDraft(form);
  draft = H.setOther(draft, form, 0, "SQLite");
  draft = H.pick(draft, form, 1, 2);
  const data = JSON.parse(JSON.stringify(H.buildData(form, draft)));
  assert.deepEqual(JSON.parse(JSON.stringify(ompParseResponse(form, data))), data);
});

check("omp's validator rejects every shape this builder refuses to validate", () => {
  const { form } = parse(mixed);
  const valid = { db: "pg", feature: ["ci"] };
  assert.equal(ompParseResponse(form, valid).db, "pg");
  assert.equal(ompParseResponse(form, valid).port, undefined);
  for (const bad of [
    null, [], "x",
    { nope: "x" },
    { db: "off" },
    { db: ["pg"] },
    { port: "9999" },
    { feature: "ci" },
    { feature: ["rust"] },
    { feature: ["ci", "ci"] },
    { name: 3 },
    { count: true },
  ]) assert.equal(H.validateData(form, bad), false, JSON.stringify(bad));
  assert.equal(H.validateData(form, { count: 4 }), true);
  assert.equal(H.validateData(form, { count: "4" }), true);
});

// Random forms and random answers: the builder must produce exactly the
// reply omp accepts. A deterministic LCG keeps failures reproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
function randomForm(rnd) {
  const parts = ["<form>", `<input type="hidden" name="h" value="fixed">`];
  const names = ["one", "many", "sel", "multi", "txt", "num", "area"];
  for (const name of names) {
    if (rnd() < 0.25) continue;
    const kind = name;
    if (kind === "one" || kind === "many") {
      parts.push(`<fieldset><legend>${kind}</legend>`);
      const type = kind === "one" ? "radio" : "checkbox";
      const count = 1 + Math.floor(rnd() * 4);
      for (let i = 0; i < count; i++)
        parts.push(`<label><input type="${type}" name="${name}" value="v${i}"${rnd() < 0.3 ? " checked" : ""}${rnd() < 0.15 ? " disabled" : ""}> Option ${i}</label>`);
      parts.push("</fieldset>");
    } else if (kind === "sel" || kind === "multi") {
      parts.push(`<label>Pick <select name="${name}"${kind === "multi" ? " multiple" : ""}>`);
      const count = 1 + Math.floor(rnd() * 4);
      for (let i = 0; i < count; i++)
        parts.push(`<option value="o${i}"${rnd() < 0.3 ? " selected" : ""}${rnd() < 0.15 ? " disabled" : ""}>o${i}</option>`);
      parts.push("</select></label>");
    } else if (kind === "txt") parts.push(`<label>Text <input name="${name}" value="${rnd() < 0.5 ? "pre" : ""}"${rnd() < 0.3 ? " required" : ""}></label>`);
    else if (kind === "num") parts.push(`<label>Number <input type="number" name="${name}"${rnd() < 0.5 ? ' value="4"' : ""} min="1" max="9"></label>`);
    else parts.push(`<label>Area <textarea name="${name}" rows="${1 + Math.floor(rnd() * 5)}"></textarea></label>`);
  }
  parts.push("</form>");
  return parts.join("");
}

check("random answers from the draft replay against omp's validator", () => {
  const rnd = lcg(0x5eed);
  for (let round = 0; round < 120; round++) {
    const html = randomForm(rnd);
    const parsed = parse(html);
    assert.equal(parsed.error, undefined, html);
    const { form } = parsed;
    let draft = H.emptyDraft(form);
    for (const [index, f] of form.fields.entries()) {
      if (f.kind === "choice") {
        for (let option = 0; option < f.options.length; option++) {
          if (!f.options[option].disabled && rnd() < 0.35) draft = H.pick(draft, form, index, option);
        }
        if (f.other && rnd() < 0.4) draft = H.setOther(draft, form, index, rnd() < 0.2 ? "  " : ` own-${round} `);
      } else if (f.type === "number" || f.type === "range") {
        if (rnd() < 0.6) draft = H.setText(draft, form, index, String(1 + Math.floor(rnd() * 9)));
      } else if (rnd() < 0.6) draft = H.setText(draft, form, index, ` text ${round} `);
    }
    const data = JSON.parse(JSON.stringify(H.buildData(form, draft)));
    assert.equal(H.validateData(form, data), true, H.dataError(form, data) ?? JSON.stringify(data));
    assert.deepEqual(JSON.parse(JSON.stringify(ompParseResponse(form, data))), data, html);
  }
});

console.log(`html-form: ${passed} checks passed`);
