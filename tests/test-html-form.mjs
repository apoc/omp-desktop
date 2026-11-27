#!/usr/bin/env node
// Regression script for src/app/html-form-parse.js (omp's own markup parser
// and form builder, ported) and src/app/html-form.js — omp's ask tool HTML
// form: parsing into a render model, the draft and reply `data` shape,
// defaults, validation, translatable errors, and the rendering-safe image
// rule. The parser runs here exactly as in the app: it uses no DOM.
// Run: node tests/test-html-form.mjs

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
// Same realm as the test's arrays/objects (new Function, not a vm context):
// deep equality must not trip over cross-realm prototypes.
for (const file of ["src/app/html-form-markup.js", "src/app/html-form-parse.js", "src/app/html-form.js"]) {
  const path = join(root, file);
  assert.ok(existsSync(path), `${file} must exist`);
  new Function("window", readFileSync(path, "utf8"))(win);
}
const H = win.OMP_HTML_FORM;
const M = win.OMP_HTML_FORM_MARKUP;

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`ok ${passed} - ${label}`);
}

const parse = html => H.parse(html);
const fields = html => parse(html).form.fields;
const field = (html, name, index = 0) => fields(html).filter(f => f.name === name)[index];
const plain = value => JSON.parse(JSON.stringify(value));
const PASSWORD = { text: "This form asks for a password; enter it in a terminal instead — omp would echo it in its output." };
const MARKUP = { text: "This form has too much markup to show." };
const DISPLAY = { text: "This form has too much display text to show." };

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
    assert.equal(typeof parse(html).error?.text, "string", html);
  assert.deepEqual(H.parse(null).error, { text: "The form is empty." });
  assert.deepEqual(parse("<form><p>none</p></form>").error, { text: "The form has no named controls." });
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

check("fieldError enforces required, numeric bounds, lengths, email and URL as {text, vars}", () => {
  const { form } = parse(`<form>
    <input name="req" required>
    <input name="num" type="number" min="2" max="4">
    <input name="len" minlength="3" maxlength="5">
    <input name="mail" type="email">
    <input name="url" type="url">
    <label><input type="checkbox" name="pick" value="a" required>Pick</label>
  </form>`);
  const by = name => form.fields.find(f => f.name === name);
  assert.deepEqual(H.fieldError(by("req"), undefined), { text: "Required" });
  assert.deepEqual(H.fieldError(by("num"), 5), { text: "Must be at most {max}", vars: { max: 4 } });
  assert.deepEqual(H.fieldError(by("num"), 1), { text: "Must be at least {min}", vars: { min: 2 } });
  assert.deepEqual(H.fieldError(by("num"), "x"), { text: "Enter a number" });
  assert.deepEqual(H.fieldError(by("len"), "ab"), { text: "Needs at least {n} characters", vars: { n: 3 } });
  assert.deepEqual(H.fieldError(by("len"), "abcdef"), { text: "At most {n} characters", vars: { n: 5 } });
  assert.deepEqual(H.fieldError(by("mail"), "x"), { text: "Enter an email address" });
  assert.deepEqual(H.fieldError(by("url"), "x"), { text: "Enter a full URL" });
  assert.deepEqual(H.fieldError(by("pick"), []), { text: "Required" });
  assert.equal(H.fieldError(by("len"), "abcd"), undefined);
});

check("errorText fills placeholders in English and leaves unknown ones", () => {
  assert.equal(H.errorText({ text: "Must be at least {min}", vars: { min: 2 } }), "Must be at least 2");
  assert.equal(H.errorText({ text: "Needs {n} of {m}", vars: { n: 1 } }), "Needs 1 of {m}");
  assert.equal(H.errorText({ text: "Required" }), "Required");
  assert.equal(H.errorText("Unsupported form"), "Unsupported form");
  assert.equal(H.errorText(undefined), "");
});

check("refusalData is the one-key reply that refuses a form without cancelling the turn", () => {
  const PASSWORD_SENTENCE = "OMP Desktop does not show ask forms that mention a password. Do not ask for a password in the chat or in a form; if one is needed, tell the user to enter it in a terminal. Ask anything else in plain text.";
  const oneKey = (data, sentence) => {
    assert.deepEqual(Object.keys(data), [sentence]);
    assert.equal(data[sentence], null);
  };
  // The password refusal is recognised from the parser's error, whether the
  // marker or a password control caused it.
  oneKey(H.refusalData(parse('<form data-omp-desktop-redacted="password"></form>').error), PASSWORD_SENTENCE);
  oneKey(H.refusalData(parse("<form><input type=password name=pw></form>").error), PASSWORD_SENTENCE);
  oneKey(H.refusalData(PASSWORD), PASSWORD_SENTENCE);
  // Any other refusal quotes its reason, English, placeholders filled.
  oneKey(H.refusalData(parse("").error),
    "OMP Desktop could not show this ask form: The form is empty. Do not send this form again; ask the user in plain text instead.");
  oneKey(H.refusalData({ text: "This form has {n} fields; at most {max} are shown.", vars: { n: 501, max: 500 } }),
    "OMP Desktop could not show this ask form: This form has 501 fields; at most 500 are shown. Do not send this form again; ask the user in plain text instead.");
  oneKey(H.refusalData(parse(`<form>${"<input name=a>".repeat(501)}</form>`).error),
    "OMP Desktop could not show this ask form: This form has too many fields to show. Do not send this form again; ask the user in plain text instead.");
  // A missing or empty error reads as the parser's fallback text.
  const fallback = "OMP Desktop could not show this ask form: The form could not be read. Do not send this form again; ask the user in plain text instead.";
  oneKey(H.refusalData(undefined), fallback);
  oneKey(H.refusalData(null), fallback);
  oneKey(H.refusalData({ text: "" }), fallback);
});

check("a pattern is a hint only: the form is shown and the pattern never runs", () => {
  // A model-written regex never runs in the webview (ReDoS), on any omp
  // version; a catastrophic pattern must not be compiled or matched.
  const html = `<form><input name="slug" pattern="(a+)+$" value="${"a".repeat(40)}!"></form>`;
  const parsed = parse(html);
  assert.equal(parsed.error, undefined);
  const f = parsed.form.fields[0];
  assert.equal(f.pattern, "(a+)+$");
  assert.equal(H.fieldError(f, f.value), undefined);
  assert.deepEqual(H.draftErrors(parsed.form, H.emptyDraft(parsed.form)), {});
  assert.equal(H.answerError(parsed.form, { slug: "NOT-A-MATCH" }), null);
  assert.equal("versionAtLeast" in H, false);
});

check("answerError applies omp 19.1's submit-time rules to each field's parsed value", () => {
  const { form } = parse(`<form>
    <input name="req" required>
    <input name="num" type="number" min="2" max="4">
    <input name="len" minlength="3">
    <input name="mail" type="email">
    <input name="url" type="url">
    <label><input type="radio" name="r" value="a" required>A</label><label><input type="radio" name="r" value="b">B</label>
  </form>`);
  const rule = name => ({ text: "Fix the field “{field}” before sending.", vars: { field: name } });
  assert.equal(H.answerError(form, { req: "ok", num: 2, len: "abc", mail: "a@b", url: "https://x.test", r: "a" }), null);
  assert.deepEqual(H.answerError(form, { num: 2, len: "abc", mail: "a@b", url: "https://x.test", r: "a" }), rule("req"));
  assert.deepEqual(H.answerError(form, { req: "ok", num: 5 }), rule("num"));
  assert.deepEqual(H.answerError(form, { req: "ok", len: "ab" }), rule("len"));
  assert.deepEqual(H.answerError(form, { req: "ok", mail: "nope" }), rule("mail"));
  assert.deepEqual(H.answerError(form, { req: "ok", url: "nope" }), rule("url"));
  assert.deepEqual(H.answerError(form, { req: "ok" }), rule("r"));
  // Shape errors name the field and translate as one source string each.
  assert.deepEqual(H.answerError(form, { unknown: 1 }), { text: "The form has no field named “{field}”.", vars: { field: "unknown" } });
  assert.deepEqual(H.answerError(form, { r: ["a"] }), { text: "“{field}” takes one answer, not a list.", vars: { field: "r" } });
  assert.deepEqual(H.answerError(form, { req: 5 }), { text: "“{field}” needs text.", vars: { field: "req" } });
  assert.deepEqual(H.answerError(form, null), { text: "The answer is not a set of form fields." });
  // Shape-only validation is separate from the constraint layer.
  assert.equal(H.validateData(form, { num: 2 }), true);
  assert.deepEqual(H.dataError(form, { r: "zzz" }), null, "a radio group with Other takes free text");
});

check("a required radio sharing its name with a checkbox group is refused on every omp version", () => {
  const { form } = parse(`<form>
    <label><input type="radio" name="pick" value="one" required>One</label>
    <label><input type="checkbox" name="pick" value="two">Two</label>
    <label><input type="checkbox" name="pick" value="three">Three</label>
  </form>`);
  // omp 19.1 checks the required radio against its own (empty) parsed value
  // and fails the ask tool; the client applies that rule everywhere.
  assert.deepEqual(H.answerError(form, { pick: ["two"] }), { text: "Fix the field “{field}” before sending.", vars: { field: "pick" } });
  assert.equal(H.answerError.length, 2, "answerError takes no omp version");
});

check("a required field sharing its name with another is checked against its own answer", () => {
  const { form } = parse(`<form>
    <label><input type="radio" name="pick" value="one" required>One</label>
    <label><input type="checkbox" name="pick" value="two">Two</label>
  </form>`);
  const draft = H.emptyDraft(form);
  assert.deepEqual(H.draftErrors(form, draft), { 0: { text: "Required" } }, "an unanswered required radio must block Submit");
  assert.deepEqual(H.draftErrors(form, H.pick(draft, form, 1, 0))[0], { text: "Required" }, "the checkbox answer must not satisfy the radio");
  assert.deepEqual(H.draftErrors(form, H.pick(draft, form, 0, 0)), {});
});

check("an Other entry that repeats a picked option is a field error", () => {
  const { form } = parse(`<form><label><input type="checkbox" name="i" value="ci">CI</label><label><input type="checkbox" name="i" value="cd">CD</label></form>`);
  let draft = H.emptyDraft(form);
  draft = H.pick(draft, form, 0, 0);
  draft = H.setOther(draft, form, 0, "ci");
  assert.deepEqual(H.draftErrors(form, draft)[0], { text: "That answer is already picked" });
  // A different typed value is still a valid Other answer.
  assert.deepEqual(H.draftErrors(form, H.setOther(draft, form, 0, "terraform")), {});
  const data = H.buildData(form, H.setOther(draft, form, 0, "terraform"));
  assert.equal(H.answerError(form, data), null);
  assert.deepEqual(H.answerError(form, H.buildData(form, draft)), { text: "“{field}” carries an unexpected answer.", vars: { field: "i" } });
});

// Review cases (PR #93): drafts Submit allowed while answerError (the
// bridge's answerForm gate) refused them.
check("an Other text equal to a disabled option's value blocks Submit", () => {
  for (const html of [
    `<form><p>Plan?</p><label><input type="radio" name="g" value="a">A</label><label><input type="radio" name="g" value="b" disabled>B</label></form>`,
    `<form><label><input type="checkbox" name="g" value="a">A</label><label><input type="checkbox" name="g" value="b" disabled>B</label></form>`,
  ]) {
    const { form } = parse(html);
    const draft = H.setOther(H.emptyDraft(form), form, 0, "b");
    assert.deepEqual(H.draftErrors(form, draft), { 0: { text: "That answer is a disabled option" } }, html);
    assert.deepEqual(H.answerError(form, H.buildData(form, draft)), { text: "“{field}” carries a disabled option.", vars: { field: "g" } });
    // Other text that matches no option stays a valid answer.
    const free = H.setOther(H.emptyDraft(form), form, 0, "c");
    assert.deepEqual(H.draftErrors(form, free), {}, html);
    assert.equal(H.answerError(form, H.buildData(form, free)), null);
  }
});

check("a field whose answer a same-name field replaces blocks Submit", () => {
  const { form } = parse(`<form><label>Note <input name="n" required></label><label><input type="checkbox" name="n" value="a">A</label><label><input type="checkbox" name="n" value="b">B</label></form>`);
  const draft = H.setText(H.emptyDraft(form), form, 0, "hello");
  // buildData writes the checkbox group last: omp reads {n: []}, so the text
  // field's "hello" never arrives and omp 19.1 fails its `required`.
  assert.deepEqual(plain(H.buildData(form, draft)), { n: [] });
  assert.notEqual(H.answerError(form, H.buildData(form, draft)), null);
  assert.deepEqual(H.draftErrors(form, draft), { 0: { text: "Another field named “{name}” replaces this answer", vars: { name: "n" } } });
  // Same-name fields that agree raise nothing.
  const agree = parse(`<form><label><input type="radio" name="s" value="a">A</label><label><input type="radio" name="s" value="b">B</label><label>Echo <input name="s"></label></form>`).form;
  let both = H.pick(H.emptyDraft(agree), agree, 0, 0);
  both = H.setText(both, agree, 1, "a");
  assert.deepEqual(H.draftErrors(agree, both), {});
  assert.equal(H.answerError(agree, H.buildData(agree, both)), null);
});

check("draftErrors never leaves Submit enabled for an answer answerError refuses", () => {
  // A form only a cancel can answer: two required radio groups of the same
  // name but different types can never both carry the entry.
  const { form } = parse(`<form><label><input type="radio" name="x" value="a" required>A</label><label><input type="checkbox" name="x" value="b" required>B</label></form>`);
  for (const draft of [H.emptyDraft(form), H.pick(H.emptyDraft(form), form, 0, 0), H.pick(H.emptyDraft(form), form, 1, 0)]) {
    if (H.answerError(form, H.buildData(form, draft)) !== null)
      assert.notDeepEqual(H.draftErrors(form, draft), {}, JSON.stringify(draft));
  }
});

check("an explicitly empty option value keeps its empty label", () => {
  // omp's parse.ts labels an option `value ?? name`; `value=""` is the empty
  // label, not the group name. That empty label must not suppress Other
  // (omp offers Other when no option reads "Other…").
  const { form } = parse(`<form><label><input type="radio" name="other" value="">Custom</label><label><input type="radio" name="other" value="x">X</label></form>`);
  assert.equal(form.fields[0].options[0].label, "Custom", "a wrapping label still names the option");
  const unlabeled = parse(`<form><input type="radio" name="other" value=""><input type="radio" name="other" value="x"></form>`);
  assert.equal(unlabeled.form.fields[0].options[0].label, "");
  assert.equal(unlabeled.form.fields[0].label, "");
  assert.equal(unlabeled.form.fields[0].other, true);
});


check("password forms are refused with a terminal-only note", () => {
  const parsed = parse(`<form><input name="user" value="Ada"><input type="password" name="pw" value="prefilled-secret"></form>`);
  assert.equal(parsed.form, undefined);
  assert.deepEqual(parsed.error, PASSWORD);
  assert.doesNotMatch(JSON.stringify(parsed), /prefilled-secret/);
});

check("a form redacted by the backend is refused with the password note", () => {
  const refusal = PASSWORD;
  for (const marker of [
    '<form data-omp-desktop-redacted="password"></form>',
    "<form data-omp-desktop-redacted='password'><input name=ok value=visible></form>",
  ]) {
    const parsed = parse(marker);
    assert.equal(parsed.form, undefined, marker);
    assert.deepEqual(parsed.error, refusal, marker);
  }
  // Only the exact marker value is refused; other data attributes parse.
  assert.equal(parse(`<form data-omp-desktop-redacted="no"><input name=ok value=fine></form>`).error, undefined);
});

check("autocomplete password markers are refused on every input type", () => {
  for (const autocomplete of ["current-password", "new-password", "off current-password", "section-login NEW-PASSWORD"]) {
    const parsed = parse(`<form><input type=text name=pw autocomplete="${autocomplete}" value=prefilled-secret></form>`);
    assert.equal(parsed.form, undefined, autocomplete);
    assert.deepEqual(parsed.error, PASSWORD);
    assert.doesNotMatch(JSON.stringify(parsed), /prefilled-secret/);
  }
  assert.equal(parse(`<form><input name=user autocomplete=username value=Ada></form>`).error, undefined);
});

check("password markers match as decoded substrings, without token splitting", () => {
  const refusal = PASSWORD;
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
    assert.deepEqual(parsed.error, refusal);
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

check("oversized HTML, excessive nodes, deep nesting and over 1000 options are refused with their reason", () => {
  assert.deepEqual(H.parse("x".repeat(256 * 1024 + 1)).error, { text: "The form HTML is too large to show." });
  assert.deepEqual(parse(`<form><input name="x">${"<div>".repeat(70)}${"</div>".repeat(70)}</form>`).error, MARKUP);
  assert.equal(parse(`<form><input name="x">${"<div>".repeat(60)}${"</div>".repeat(60)}</form>`).error, undefined);
  assert.deepEqual(parse(`<form><input name="x">${"<span></span>".repeat(10001)}</form>`).error, MARKUP);
  const options = Array.from({ length: 1001 }, (_, i) => `<option value="${i}">${i}</option>`).join("");
  assert.deepEqual(parse(`<form><select name="x">${options}</select></form>`).error, { text: "This form has too many options to show." });
  const radios = Array.from({ length: 1001 }, (_, i) => `<input type="radio" name="r" value="${i}">`).join("");
  assert.deepEqual(parse(`<form>${radios}</form>`).error, { text: "This form has too many options to show." });
  assert.deepEqual(parse(`<form>${"<input name=x>".repeat(501)}</form>`).error, { text: "This form has too many fields to show." });
  assert.deepEqual(parse(`<form><input name=x>${"<p>a</p>".repeat(2001)}</form>`).error, { text: "This form has too much content to show." });
  assert.deepEqual(parse(`<form><input name=x><table>${"<tr><td>a</td></tr>".repeat(2001)}</table></form>`).error, { text: "This form has too many table cells to show." });
});

check("an exception outside the builder's limits maps to the generic refusal", () => {
  // omp itself throws on this markup (CLOSE_ON_OPEN has no own `constructor`).
  assert.deepEqual(parse(`<form><div><constructor>x</constructor></div><input name="a"></form>`).error, { text: "The form could not be read." });
});

check("node and depth limits cover the whole document, not only the first form", () => {
  assert.deepEqual(parse(`<form><input name="x"></form>${"<span></span>".repeat(10001)}`).error, MARKUP);
  assert.deepEqual(parse(`<form><input name="x"></form>${"<div>".repeat(70)}${"</div>".repeat(70)}`).error, MARKUP);
  assert.deepEqual(parse(`<head>${"<meta>".repeat(10001)}</head><form><input name="x"></form>`).error, MARKUP);
});

check("expanded display text is capped at 64 KiB, including the 2 KiB table fixture", () => {
  // One header borrowed by 42 rows expands a compact source to 55 KB of labels.
  const header = "h".repeat(1310);
  const controls = 42;
  const html = `<form><table><tr><th>${header}</th></tr>${'<tr><td><input name=r></td></tr>'.repeat(controls)}</table></form>`;
  assert.ok(html.length < 3 * 1024, `fixture source was ${html.length}`);
  assert.equal(header.length * controls, 55020);
  assert.deepEqual(parse(html.replace("</form>", `${"<p>context</p>".repeat(1600)}</form>`)).error, DISPLAY);
  const hugeOptions = Array.from({ length: 700 }, (_, i) => `<option value="${i}">${"x".repeat(100)}</option>`).join("");
  assert.deepEqual(parse(`<form><select name="x">${hugeOptions}</select></form>`).error, DISPLAY);
});

check("fallback field-name labels count toward the display budget", () => {
  const name = "fallback_".repeat(30);
  const html = `<form>${`<input name="${name}">`.repeat(300)}</form>`;
  assert.ok(html.length < 256 * 1024);
  assert.deepEqual(parse(html).error, DISPLAY);
});

check("unlabeled choice-group name fallbacks count toward the display budget", () => {
  const name = "choice_".repeat(40);
  const groups = Array.from({ length: 300 }, (_, i) => `<input type="radio" name="${name}${i}" value="a"><input type="radio" name="${name}${i}" value="b">`).join("");
  const html = `<form>${groups}</form>`;
  assert.ok(html.length < 256 * 1024);
  assert.deepEqual(parse(html).error, DISPLAY);
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
// data.ts v19.1.0 `fieldError`, including the `pattern` check that release
// applies to the submitted answer (`v`-flag regex, invalid pattern = no check).
function ompCompilePattern(pattern) {
  try { return new RegExp(`^(?:${pattern})$`, "v"); } catch { return undefined; }
}
function ompFieldError(field, value) {
  if (field.kind === "choice") {
    const empty = value === undefined || (Array.isArray(value) && value.length === 0);
    if (!field.required || !empty) return undefined;
    return arrayChoice(field) ? "Select at least one" : "Required";
  }
  const text = value === undefined ? "" : String(value);
  if (text.trim() === "") return field.required ? "Required" : undefined;
  if (field.type === "number" || field.type === "range") {
    const n = Number(text);
    if (!Number.isFinite(n)) return "Enter a number";
    if (field.min !== undefined && n < field.min) return `Must be at least ${field.min}`;
    if (field.max !== undefined && n > field.max) return `Must be at most ${field.max}`;
  }
  if (field.minLength !== undefined && text.length < field.minLength) return `Needs at least ${field.minLength} characters`;
  if (field.maxLength !== undefined && text.length > field.maxLength) return `At most ${field.maxLength} characters`;
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+$/.test(text)) return "Enter an email address";
  if (field.type === "url" && !URL.canParse(text)) return "Enter a full URL";
  if (field.pattern && ompCompilePattern(field.pattern)?.test(text) === false) return `Must match ${field.pattern}`;
  return undefined;
}
function ompParseResponse(form, data, { checkFields = false } = {}) {
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
    for (const { f, value, carried } of values) {
      if (checkFields) {
        const problem = ompFieldError(f, value);
        if (problem) throw new Error(`Form field ${JSON.stringify(name)}: ${problem}`);
      }
      if (carried && value !== undefined) out[name] = value;
    }
  }
  return out;
}
function rejects(form, data) {
  try { ompParseResponse(form, data); return false; } catch { return true; }
}
function rejects19(form, data) {
  try { ompParseResponse(form, data, { checkFields: true }); return false; } catch { return true; }
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
  ]) {
    assert.equal(H.validateData(form, bad), false, JSON.stringify(bad));
    assert.equal(rejects(form, bad), true, JSON.stringify(bad));
  }
  assert.equal(H.validateData(form, { count: 4 }), true);
  assert.equal(H.validateData(form, { count: "4" }), true);
});

check("the client's submit rules match the v19.1.0 oracle on every negative case", () => {
  const html = `<form>
    <input name="req" required>
    <input name="num" type="number" min="2" max="4">
    <input name="len" minlength="3" maxlength="5">
    <input name="mail" type="email">
    <input name="url" type="url">
    <label><input type="radio" name="pick" value="a" required>A</label>
    <label><input type="radio" name="pick" value="b">B</label>
    <label><input type="checkbox" name="many" value="x" required>X</label>
    <label><input type="checkbox" name="many" value="y">Y</label>
  </form>`;
  const { form } = parse(html);
  const valid = { req: "ok", num: 4, len: "abcd", mail: "a@b.test", url: "https://x.test", pick: "a", many: ["x"] };
  assert.equal(H.answerError(form, valid), null);
  assert.equal(rejects19(form, valid), false);
  for (const bad of [
    {},
    { ...valid, req: undefined },
    { ...valid, num: 5 },
    { ...valid, num: 1 },
    { ...valid, num: "nope" },
    { ...valid, len: "ab" },
    { ...valid, len: "abcdef" },
    { ...valid, mail: "nope" },
    { ...valid, url: "nope" },
    { ...valid, pick: ["a"] },
    { ...valid, many: [] },
    { ...valid, many: "x" },
    { ...valid, extra: 1 },
  ]) {
    assert.notEqual(H.answerError(form, bad), null, JSON.stringify(bad));
    assert.equal(rejects19(form, bad), true, JSON.stringify(bad));
  }
  assert.equal(H.answerError(form, { ...valid, pick: "b" }), null);
});

// Random forms and random answers: the draft fills every required field, and
// the reply must pass the client's own checks plus the v19.1.0 oracle and the
// shape-only 19.2 oracle. Some forms share a name between a text field and a
// checkbox group, and some Other texts repeat a disabled option's value: a
// draft draftErrors lets through must still be accepted. A deterministic LCG
// keeps failures reproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
function randomForm(rnd) {
  const parts = ["<form>", `<input type="hidden" name="h" value="fixed">`];
  const names = ["one", "many", "sel", "multi", "txt", "num", "area", "shared"];
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
    else if (kind === "shared") parts.push(`<label>Note <input name="${rnd() < 0.5 ? "many" : "one"}"${rnd() < 0.3 ? " required" : ""}></label>`);
    else parts.push(`<label>Area <textarea name="${name}" rows="${1 + Math.floor(rnd() * 5)}"></textarea></label>`);
  }
  parts.push("</form>");
  return parts.join("");
}

check("random answers from the draft replay against omp's validator", () => {
  const rnd = lcg(0x5eed);
  let answerable = 0;
  for (let round = 0; round < 160; round++) {
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
        const disabled = f.options.find(o => o.disabled)?.value;
        if (f.other && rnd() < 0.4) draft = H.setOther(draft, form, index, rnd() < 0.2 ? "  " : disabled && rnd() < 0.4 ? disabled : ` own-${round} `);
      } else if (f.type === "number" || f.type === "range") {
        if (rnd() < 0.6) draft = H.setText(draft, form, index, String(1 + Math.floor(rnd() * 9)));
      } else if (rnd() < 0.6) draft = H.setText(draft, form, index, ` text ${round} `);
    }
    // A valid answer fills every field the client marks: omp 19.1 rejects a
    // missing required answer, so a draft the client would submit must not
    // leave one empty.
    for (let guard = 0; guard <= form.fields.length; guard++) {
      const errors = H.draftErrors(form, draft);
      const keys = Object.keys(errors);
      if (!keys.length) break;
      for (const key of keys) {
        const index = Number(key);
        const f = form.fields[index];
        if (f.kind === "choice") {
          const option = f.options.findIndex(o => !o.disabled);
          if (f.other) draft = H.setOther(draft, form, index, "");
          if (option >= 0 && !draft[index].picks.includes(option)) draft = H.pick(draft, form, index, option);
        } else if (f.type === "number" || f.type === "range") {
          draft = H.setText(draft, form, index, String(f.min ?? 1));
        } else {
          draft = H.setText(draft, form, index, "filled");
        }
      }
    }
    // Whatever draftErrors still flags only a cancel can answer; anything it
    // lets through must be accepted.
    if (Object.keys(H.draftErrors(form, draft)).length) continue;
    answerable++;
    const data = plain(H.buildData(form, draft));
    assert.equal(H.validateData(form, data), true, JSON.stringify(H.dataError(form, data) ?? data));
    assert.equal(H.answerError(form, data), null, JSON.stringify(H.answerError(form, data) ?? data));
    assert.doesNotThrow(() => ompParseResponse(form, data), html);
    assert.doesNotThrow(() => ompParseResponse(form, data, { checkFields: true }), html);
  }
  assert.ok(answerable >= 80, `only ${answerable} of 160 random forms were answerable`);
});

// ── Parity with omp's own parser (v19.2.1 fixture corpus) ──────────────────
// tests/fixtures/html-form-omp-corpus.json holds omp's parseHtmlForm output
// (field names, labels, option values, flags, hidden pairs) for HTML where a
// browser DOMParser disagrees with omp: unknown or semicolon-less entities,
// foster-parented table content, forms inside tables and templates, comment
// text in options, styled label whitespace and more. Generated once from omp's
// sources with a throwaway bun script; its header names the omp tag.
const corpus = JSON.parse(readFileSync(join(root, "tests/fixtures/html-form-omp-corpus.json"), "utf8"));
const corpusModel = form => form.fields.map(f => f.kind === "choice"
  ? {
    kind: "choice", name: f.name, label: f.label, multi: f.multi, select: f.select, other: f.other, required: f.required,
    options: f.options.map(o => ({ value: o.value, label: o.label, checked: o.checked, disabled: o.disabled })),
  }
  : { kind: "text", name: f.name, label: f.label, type: f.type, value: f.value, required: f.required, ...(f.pattern !== undefined ? { pattern: f.pattern } : {}) });

check("the desktop parses the omp corpus exactly as omp v19.2.1 does", () => {
  assert.equal(corpus.omp, "v19.2.1");
  assert.ok(corpus.cases.length >= 40);
  for (const entry of corpus.cases) {
    const parsed = parse(entry.html);
    if (entry.ompError) {
      assert.ok(parsed.error, `${entry.label}: omp throws, the desktop must refuse`);
      continue;
    }
    if (!entry.fields.some(f => f.name) && entry.hidden.length === 0) {
      assert.deepEqual(parsed.error, { text: "The form has no named controls." }, entry.label);
      continue;
    }
    assert.equal(parsed.error, undefined, `${entry.label}: ${JSON.stringify(parsed.error)}`);
    assert.deepEqual(plain({ fields: corpusModel(parsed.form), hidden: parsed.form.hidden }),
      { fields: entry.fields, hidden: entry.hidden }, entry.label);
  }
});

check("every desktop answer to a corpus form is accepted by omp's reading of omp's own model", () => {
  for (const entry of corpus.cases) {
    const parsed = parse(entry.html);
    if (parsed.error) continue;
    const ompForm = { fields: entry.fields, hidden: entry.hidden };
    const { form } = parsed;
    const drafts = [H.emptyDraft(form)];
    form.fields.forEach((f, index) => {
      if (f.kind === "choice") f.options.forEach((o, oi) => { if (!o.disabled) drafts.push(H.pick(H.emptyDraft(form), form, index, oi)); });
    });
    for (const draft of drafts) {
      if (Object.keys(H.draftErrors(form, draft)).length) continue;
      const data = plain(H.buildData(form, draft));
      assert.doesNotThrow(() => ompParseResponse(ompForm, data), `${entry.label}: ${JSON.stringify(data)}`);
    }
  }
});

check("entity decoding is omp's: its table, a required semicolon, numeric references", () => {
  assert.equal(M.decodeEntities("&lt; &ge; &rarr; &check; Caf&eacute Caf&eacute;"), "< &ge; &rarr; &check; Caf&eacute Café");
  assert.equal(M.decodeEntities("&AMP; &Eacute; &#x263A; &#9731; &#0; &#xD800;"), "& É ☺ ☃ \uFFFD \uFFFD");
  assert.equal(M.decodeEntities("R&D & co"), "R&D & co");
  const { form } = parse(`<form><select name="s"><option>&lt; 10</option><option>&ge; 10</option></select><input type="checkbox" name="c" value="y&check;" checked></form>`);
  assert.deepEqual(form.fields[0].options.map(o => o.value), ["< 10", "&ge; 10"]);
  assert.deepEqual(plain(H.buildData(form, H.pick(H.emptyDraft(form), form, 0, 1))), { s: "&ge; 10", c: "y&check;" });
});

check("table content outside a cell is never a field, as in omp", () => {
  // A browser moves these radios out of the table and would answer {a: "1"};
  // omp sees them inside the table but in no cell, so it has no field `a`.
  const html = `<form><table><tr><td>Pick</td></tr><input type="radio" name="a" value="1"><input type="radio" name="a" value="2"></table></form>`;
  assert.deepEqual(parse(html).error, { text: "The form has no named controls." });
  const inTable = parse(`<table><form><tr><td><label>Name <input name="who" value="Ada"></label></td></tr></form></table>`);
  assert.deepEqual(plain(H.defaultData(inTable.form)), { who: "Ada" });
});

check("parseMarkup builds plain objects; a template's children stay out of the tree", () => {
  const document = M.parseMarkup(`<template><input name="t"></template><p>x</p>`);
  assert.equal(document.childNodes.length, 2);
  const [template] = document.childNodes;
  assert.deepEqual(template.childNodes, []);
  assert.equal(template.content.childNodes[0].localName, "input");
});

check("a `<` that opens no tag cannot make the parser rescan the input without bound", () => {
  // omp rescans to the next `>` after each such `<`: quadratic on this input.
  const html = `<form><input name="x">${"< /".repeat(80000)}></form>`;
  assert.ok(html.length < 256 * 1024);
  const started = Date.now();
  assert.deepEqual(parse(html).error, MARKUP);
  // Bounded: a few ms; unbounded (node cap only): over a second.
  assert.ok(Date.now() - started < 400, `took ${Date.now() - started} ms`);
  // Ordinary stray `<` text still parses as omp does.
  assert.deepEqual(plain(H.defaultData(parse(`<form><p>a < b, 3 <> 4</p><input name="x" value="1"></form>`).form)), { x: "1" });
});

// ── One input type rule for the desktop and the phone ──────────────────────
// A fake <input> that sanitizes like a browser for the types the rule meets.
function fakeInput() {
  let type = "text", raw = "";
  const input = {
    min: "", max: "", step: "",
    get type() { return type; },
    set type(next) { type = ["text", "number", "range", "color", "date", "email"].includes(next) ? next : "text"; },
    set value(next) { raw = String(next); },
    get value() {
      if (type === "range") {
        const lo = Number(input.min || 0), hi = Number(input.max || 100);
        const n = Number(raw);
        return String(raw.trim() === "" || !Number.isFinite(n) ? lo + (hi - lo) / 2 : Math.min(hi, Math.max(lo, n)));
      }
      if (type === "color") return /^#[0-9a-f]{6}$/.test(raw) ? raw : "#000000";
      if (type === "number") return /^-?\d+(\.\d+)?$/.test(raw) ? raw : "";
      if (type === "date") return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
      return raw;
    },
  };
  return input;
}

check("inputType keeps a native type only when the browser shows the default unchanged", () => {
  const { form } = parse(`<form>
    <input type="range" name="r1" value=""><input type="range" name="r2" value="5" min="0" max="10">
    <input type="range" name="r3" value="50" min="0" max="10"><input type="color" name="c1">
    <input type="color" name="c2" value="#00ff00"><input type="number" name="n1" value="abc">
    <input type="number" name="n2" value="4"><input type="date" name="d" value="tomorrow">
    <input type="email" name="e" value="a@b.test"><input type="weird" name="w"><input name="t" value="x"></form>`);
  const type = name => H.inputType(form.fields.find(f => f.name === name), fakeInput);
  assert.equal(type("r1"), "text", "an empty range would show its midpoint but send \"\"");
  assert.equal(type("r2"), "range");
  assert.equal(type("r3"), "text", "a clamped range would show 10 but send 50");
  assert.equal(type("c1"), "text", "an empty colour would show #000000 but send \"\"");
  assert.equal(type("c2"), "color");
  assert.equal(type("n1"), "text");
  assert.equal(type("n2"), "number");
  assert.equal(type("d"), "text");
  assert.equal(type("e"), "email");
  assert.equal(type("w"), "text");
  assert.equal(type("t"), "text");
  // Without a way to try the value, every field is plain text.
  assert.equal(H.inputType(form.fields.find(f => f.name === "r2")), "text");
  // What both renderers show for the untouched range is what omp sends.
  assert.deepEqual(plain(H.defaultData(form)).r1, "");
});

check("every user-facing form error source string has a zh translation", () => {
  const zh = {};
  new Function("window", readFileSync(join(root, "src/app/i18n-zh.js"), "utf8"))({ OMP_I18N: { add: (_, entries) => Object.assign(zh, entries) } });
  const strings = new Set(["Unsupported form", "The form could not be read.", "The refusal could not be delivered to omp.", "closed by omp", "cancelled", "not shown", "Required"]);
  // Every sentence-like literal in the two modules is a user-facing message:
  // capitalised (or opening with “) and made of words. The one exception is
  // refusalData's password sentence: it is written for the model and never
  // reaches OMP_TR.
  for (const file of ["src/app/html-form-markup.js", "src/app/html-form-parse.js", "src/app/html-form.js"]) {
    for (const match of readFileSync(join(root, file), "utf8").matchAll(/"((?:[A-Z]|“)[^"\\]* [^"\\]*)"/g)) {
      if (!match[1].startsWith("OMP Desktop does not show ask forms")) strings.add(match[1]);
    }
  }
  assert.ok(strings.size >= 36, `only ${strings.size} strings found: ${[...strings].join(" | ")}`);
  for (const text of strings) assert.ok(Object.hasOwn(zh, text), `no zh entry for ${JSON.stringify(text)}`);
});

check("a long whitespace run inside styled text parses in linear time", () => {
  // `/\s+$/` on a run that does not end the span is quadratic in V8 (~2 s at
  // this size, ~23 s at the 256 KiB cap); trimEnd is linear.
  const html = `<form><p><b>a</b>${"\n".repeat(80000)}x</p><input name=q></form>`;
  const start = performance.now();
  parse(html);
  const ms = performance.now() - start;
  assert.ok(ms < 250, `parse took ${ms.toFixed(0)} ms`);
  // Edge whitespace is still trimmed.
  assert.equal(parse("<form><p>  <b>a</b>  x \n </p><input name=q></form>").form.sections[0].blocks[0].text, "a x");
});

console.log(`html-form: ${passed} checks passed`);
