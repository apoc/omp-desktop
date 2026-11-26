/* ═════════════════════════════════════════════════════════════════════
   app/html-form.js — omp's ask-tool HTML form. Pure model + rules;
   design/chat/form-dialog.jsx renders it on the desktop and
   remote/transcript.js on the phone. The HTML is parsed with DOMParser and
   never inserted into the document: the model is drawn from text, alt text
   and file/option values only.

   Mirrors omp's tools/html-form/{parse,data}.ts. The reply is
   `{data: {<control name>: value}}` (rpc-mode.ts
   parseFormDialogResponse): one string for a radio/single select, an array
   for a checkbox group or multi-select, a number for number/range, and a
   free-text value for a group's automatic Other. Unknown names, wrong
   shapes and disabled options make omp fail the ask tool, so this module
   builds only that shape and validates untrusted phone input with it.
   ═════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const SKIPPED = new Set(["button", "head", "iframe", "link", "meta", "noscript", "script", "style", "template", "title"]);
  const BLOCK = new Set([
    "address", "article", "aside", "blockquote", "dd", "details", "div", "dl", "dt", "figure",
    "figcaption", "footer", "header", "li", "main", "nav", "p", "section",
  ]);
  const HEADING = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "summary"]);
  const IGNORED_INPUTS = new Set(["button", "file", "image", "reset", "submit"]);
  const MAX_HTML_BYTES = 256 * 1024;
  const MAX_NODES = 10000;
  const MAX_DEPTH = 64;
  const MAX_FIELDS = 500;
  const MAX_BLOCKS = 2000;
  const MAX_OPTIONS = 1000;
  const MAX_TABLE_CELLS = 2000;
  const MAX_DISPLAY_BYTES = 64 * 1024;
  const PASSWORD_REFUSAL = "This form asks for a password; enter it in a terminal instead — omp would echo it in its output.";
  let UTF8;

  function nonBlank(value) {
    return typeof value === "string" && value.trim() ? value : null;
  }

  function localName(node) {
    return String(node?.localName ?? node?.nodeName ?? "").toLowerCase();
  }

  function attr(node, name) {
    if (typeof node?.getAttribute === "function") return node.getAttribute(name);
    const value = node?.attributes?.[name];
    return value === undefined || value === null ? null : String(value);
  }

  function children(node) {
    return Array.from(node?.childNodes ?? []);
  }

  function descendants(node, predicate, out = []) {
    for (const child of children(node)) {
      if (child.nodeType !== 1) continue;
      if (predicate(child)) out.push(child);
      descendants(child, predicate, out);
    }
    return out;
  }

  function textOf(node) {
    if (!node) return "";
    if (node.nodeType === 3) return node.data ?? "";
    return children(node).map(textOf).join("");
  }

  function numberAttr(node, name) {
    const raw = attr(node, name);
    if (raw === null || raw.trim() === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  }

  function normalize(text) {
    return String(text ?? "").replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
  }

  function labelText(node) {
    const walk = element => {
      if (element.nodeType === 3) return element.data ?? "";
      if (element.nodeType !== 1) return "";
      const tag = localName(element);
      if (SKIPPED.has(tag) || tag === "input" || tag === "select" || tag === "textarea" || tag === "svg") return "";
      if (tag === "br") return "\n";
      if (tag === "img") return attr(element, "alt") ?? "";
      const body = children(element).map(walk).join("");
      return BLOCK.has(tag) || HEADING.has(tag) ? ` ${body} ` : body;
    };
    return normalize(walk(node));
  }

  function hasControl(node) {
    return descendants(node, element => ["input", "select", "textarea"].includes(localName(element))).length > 0;
  }

  // querySelectorAll("tr") plus closest("table") in omp's parser: a nested
  // table's rows belong to that table, never to the outer decision matrix.
  function tableRows(table) {
    const rows = [];
    const walk = node => {
      for (const child of children(node)) {
        if (child.nodeType !== 1) continue;
        const tag = localName(child);
        if (tag === "table") continue;
        if (tag === "tr") rows.push(child);
        else walk(child);
      }
    };
    walk(table);
    return rows;
  }

  function wrappingLabel(cell, control) {
    return descendants(cell, element => localName(element) === "label" && descendants(element, candidate => candidate === control).length > 0).at(-1) ?? null;
  }

  function allElements(root) {
    const out = [];
    const pending = [{ node: root, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
      const { node, depth } = pending.pop();
      if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error("This form has too much markup to show.");
      if (node.nodeType === 1 && depth > 0) out.push(node);
      for (const child of children(node)) pending.push({ node: child, depth: depth + 1 });
    }
    return out.reverse();
  }

  class Builder {
    constructor(root) {
      this.root = root;
      this.sections = [{ title: "", blocks: [], fieldset: false }];
      this.section = this.sections[0];
      this.fields = [];
      this.hidden = [];
      this.groups = new Map();
      this.labelsFor = new Map();
      this.inline = "";
      this.fieldsetDepth = 0;
      this.blockCount = 0;
      this.optionCount = 0;
      this.tableCellCount = 0;
      this.displayBytes = 0;
    }

    budget(text) {
      this.displayBytes += (UTF8 ??= new TextEncoder()).encode(String(text ?? "")).length;
      if (this.displayBytes > MAX_DISPLAY_BYTES) throw new Error("This form has too much display text to show.");
    }

    budgetField(field) {
      this.budget(field.label);
      if (field.kind === "choice") for (const option of field.options) this.budget(option.label);
      else {
        this.budget(field.value);
        this.budget(field.placeholder);
        this.budget(field.pattern);
      }
    }

    build() {
      const elements = allElements(this.root);
      const ids = new Set(elements.map(element => attr(element, "id")).filter(Boolean));
      for (const element of elements) {
        if (localName(element) !== "label") continue;
        const target = attr(element, "for");
        if (target && ids.has(target) && !this.labelsFor.has(target)) this.labelsFor.set(target, element);
      }
      this.walkChildren(this.root);
      this.flush(false);
      for (const field of this.fields) {
        if (field.kind !== "choice" || field.select || field.options.length < 2) continue;
        field.other = !field.options.some(option => /^\s*other\b/i.test(option.label));
      }
      return {
        sections: this.sections.filter(section => section.title !== "" || section.blocks.length > 0),
        fields: this.fields,
        hidden: this.hidden,
      };
    }

    walkChildren(node) {
      for (const child of children(node)) this.walk(child);
    }

    appendInline(text) {
      if (text) this.inline += text;
    }

    flush(heading) {
      const text = normalize(this.inline);
      this.inline = "";
      if (!text) return;
      if (++this.blockCount > MAX_BLOCKS) throw new Error("This form has too much content to show.");
      this.budget(text);
      this.section.blocks.push({ kind: "text", text, heading: Boolean(heading) });
    }

    block(block) {
      if (++this.blockCount > MAX_BLOCKS) throw new Error("This form has too much content to show.");
      if (block.kind === "text" || block.kind === "pre" || block.kind === "image") this.budget(block.text ?? block.alt);
      else if (block.kind === "list") for (const item of block.items) this.budget(item);
      else if (block.kind === "table") for (const row of block.rows) for (const cell of row) this.budget(cell);
      else if (block.kind === "field") this.budgetField(block.field);
      this.section.blocks.push(block);
    }

    walk(node) {
      if (!node || node.nodeType === 8) return;
      if (node.nodeType === 3) {
        this.appendInline(node.data ?? "");
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = localName(node);
      if (SKIPPED.has(tag)) return;
      if (tag === "br") return this.appendInline("\n");
      if (tag === "hr") return this.flush(false);
      if (tag === "input" || tag === "select" || tag === "textarea") return this.control(node, null);
      if (tag === "label") return this.label(node);
      if (tag === "fieldset") return this.fieldset(node);
      if (tag === "legend") {
        this.flush(false);
        this.walkChildren(node);
        this.flush(true);
        return;
      }
      if (tag === "ul" || tag === "ol") return this.list(node, tag === "ol");
      if (tag === "pre") {
        this.flush(false);
        return this.block({ kind: "pre", text: textOf(node).replace(/^\n/, "").trimEnd() });
      }
      if (tag === "table") return this.table(node);
      if (tag === "img") {
        const alt = normalize(attr(node, "alt") ?? "");
        if (alt) {
          this.flush(false);
          this.block({ kind: "image", alt });
        }
        return;
      }
      if (tag === "svg") {
        const label = normalize(attr(node, "aria-label") ?? "");
        const title = descendants(node, child => localName(child) === "title")
          .map(textOf).join(" ").replace(/\s+/g, " ").trim();
        const alt = label || title;
        if (alt) {
          this.flush(false);
          this.block({ kind: "image", alt });
        }
        return;
      }
      if (HEADING.has(tag)) {
        this.flush(false);
        this.walkChildren(node);
        this.flush(true);
        return;
      }
      if (BLOCK.has(tag)) {
        this.flush(false);
        this.walkChildren(node);
        this.flush(false);
        return;
      }
      this.walkChildren(node);
    }

    label(node) {
      const target = attr(node, "for");
      if (target && this.labelsFor.get(target) === node) return;
      const controls = descendants(node, element => ["input", "select", "textarea"].includes(localName(element)));
      if (controls.length === 0) return this.walkChildren(node);
      this.flush(false);
      const label = labelText(node);
      for (const control of controls) this.control(control, label);
    }

    fieldset(node) {
      this.flush(false);
      const legend = children(node).find(child => child.nodeType === 1 && localName(child) === "legend");
      if (this.fieldsetDepth > 0) {
        if (legend) this.walk(legend);
      } else {
        this.startSection(legend ? labelText(legend) : "", true);
      }
      this.fieldsetDepth++;
      for (const child of children(node)) if (child !== legend) this.walk(child);
      this.flush(false);
      this.fieldsetDepth--;
      if (this.fieldsetDepth === 0) this.startSection("", false);
    }

    startSection(title, fieldset) {
      this.budget(title);
      if (this.section.blocks.length === 0 && this.section.title === "") {
        this.section.title = title;
        this.section.fieldset = fieldset;
        return;
      }
      this.section = { title, blocks: [], fieldset };
      this.sections.push(this.section);
    }

    list(node, ordered) {
      this.flush(false);
      if (hasControl(node)) {
        this.walkChildren(node);
        this.flush(false);
        return;
      }
      const items = children(node)
        .filter(child => child.nodeType === 1 && localName(child) === "li")
        .map(labelText)
        .filter(Boolean);
      if (items.length) this.block({ kind: "list", items, ordered });
    }

    table(node) {
      this.flush(false);
      const rows = tableRows(node);
      const cellsOf = row => children(row).filter(cell => ["td", "th"].includes(localName(cell)));
      this.tableCellCount += rows.reduce((count, row) => count + cellsOf(row).length, 0);
      if (this.tableCellCount > MAX_TABLE_CELLS) throw new Error("This form has too many table cells to show.");
      if (!hasControl(node)) {
        const cells = rows.map(row => cellsOf(row).map(labelText));
        let headerRows = 0;
        while (headerRows < rows.length && cellsOf(rows[headerRows]).every(cell => localName(cell) === "th")) headerRows++;
        if (cells.some(row => row.length)) this.block({ kind: "table", rows: cells, headerRows });
        return;
      }
      // A decision matrix: row text stays context and an unlabelled control
      // borrows its column header, exactly as omp's parse.ts does.
      let header = [];
      for (const row of rows) {
        const cells = cellsOf(row);
        if (cells.every(cell => localName(cell) === "th") && !hasControl(row)) {
          header = cells.map(labelText);
          continue;
        }
        const text = cells.filter(cell => !hasControl(cell)).map(labelText).filter(Boolean).join(" · ");
        if (text) this.block({ kind: "text", text, heading: false });
        cells.forEach((cell, column) => {
          for (const control of descendants(cell, child => ["input", "select", "textarea"].includes(localName(child)))) {
            const label = wrappingLabel(cell, control);
            const own = labelText(label ?? cell);
            this.control(control, own || header[column] || null);
          }
        });
      }
    }

    detachedLabel(control) {
      const label = this.labelsFor.get(attr(control, "id"));
      if (label) return labelText(label);
      return normalize(attr(control, "aria-label") ?? attr(control, "title") ?? "");
    }

    control(control, wrapping) {
      this.flush(false);
      const own = typeof wrapping === "string" && wrapping ? wrapping : this.detachedLabel(control);
      const name = attr(control, "name") ?? "";
      const required = control.hasAttribute?.("required") ?? attr(control, "required") !== null;
      const tag = localName(control);
      if (tag === "select") {
        const multi = control.hasAttribute?.("multiple") ?? attr(control, "multiple") !== null;
        const options = descendants(control, child => localName(child) === "option").map(option => {
          const label = textOf(option).replace(/\s+/g, " ").trim();
          return {
            value: attr(option, "value") ?? label,
            label,
            checked: option.hasAttribute?.("selected") ?? attr(option, "selected") !== null,
            disabled: option.hasAttribute?.("disabled") ?? attr(option, "disabled") !== null,
          };
        });
        this.optionCount += options.length;
        if (this.optionCount > MAX_OPTIONS) throw new Error("This form has too many options to show.");
        if (!multi && !options.some(option => option.checked)) {
          const first = options.find(option => !option.disabled);
          if (first) first.checked = true;
        }
        return this.addField({ kind: "choice", name, multi, select: true, other: false, label: own, options, required });
      }
      if (tag === "textarea") {
        return this.addField({
          kind: "text", name, type: "textarea", multiline: true,
          label: own || name.replace(/[_-]+/g, " "),
          value: textOf(control).replace(/^\r?\n/, ""),
          placeholder: attr(control, "placeholder") ?? "",
          required,
          minLength: numberAttr(control, "minlength"),
          maxLength: numberAttr(control, "maxlength"),
          rows: numberAttr(control, "rows") ?? 4,
        });
      }
      const type = (attr(control, "type") ?? "text").toLowerCase();
      if (IGNORED_INPUTS.has(type)) return;
      const value = attr(control, "value");
      if (type === "hidden") {
        if (name) this.hidden.push([name, value ?? ""]);
        return;
      }
      if (type === "radio" || type === "checkbox") {
        const option = {
          value: value ?? "on",
          label: own || value || name,
          checked: control.hasAttribute?.("checked") ?? attr(control, "checked") !== null,
          disabled: control.hasAttribute?.("disabled") ?? attr(control, "disabled") !== null,
        };
        this.optionCount++;
        if (this.optionCount > MAX_OPTIONS) throw new Error("This form has too many options to show.");
        const key = `${type}\0${name}`;
        const group = this.groups.get(key);
        if (group) {
          // omp resolves a submitted value to the first enabled option. A
          // later enabled duplicate could never be submitted distinctly.
          if (group.options.some(existing => !existing.disabled && existing.value === option.value)) option.disabled = true;
          group.options.push(option);
          this.budget(option.label);
          group.required ||= required;
          return;
        }
        const field = { kind: "choice", name, multi: type === "checkbox", select: false, other: false, label: "", options: [option], required };
        this.groups.set(key, field);
        return this.addField(field);
      }
      return this.addField({
        kind: "text", name, type, multiline: false,
        label: own || name.replace(/[_-]+/g, " "),
        value: value ?? "",
        placeholder: attr(control, "placeholder") ?? "",
        required,
        min: numberAttr(control, "min"),
        max: numberAttr(control, "max"),
        step: numberAttr(control, "step"),
        pattern: attr(control, "pattern") ?? undefined,
        minLength: numberAttr(control, "minlength"),
        maxLength: numberAttr(control, "maxlength"),
        rows: 1,
      });
    }

    addField(field) {
      if (this.fields.length >= MAX_FIELDS) throw new Error("This form has too many fields to show.");
      this.fields.push(field);
      this.block({ kind: "field", field });
    }
  }

  /** Parse agent-written form HTML. `documentImpl` is a test seam for Node,
   *  where DOMParser does not exist; the app always uses DOMParser. Returns
   *  `{form}` or `{error}` — an error means the request is cancelled so omp
   *  never waits on a card that cannot be answered. */
  function parse(html, documentImpl) {
    if (typeof html !== "string" || !html.trim()) return { error: "The form is empty." };
    if (new TextEncoder().encode(html).length > MAX_HTML_BYTES) return { error: "The form HTML is too large to show." };
    let document;
    try {
      if (documentImpl) document = documentImpl;
      else if (typeof DOMParser !== "undefined") document = new DOMParser().parseFromString(html, "text/html");
      else return { error: "This page cannot read forms." };
      const root = document.body ?? document.documentElement ?? document;
      const elements = allElements(root);
      const formNode = elements.find(node => localName(node) === "form");
      if (descendants(formNode ?? root, node => localName(node) === "input" && (attr(node, "type") ?? "text").toLowerCase() === "password").length > 0)
        return { error: PASSWORD_REFUSAL };
      const builder = new Builder(formNode ?? root);
      const form = builder.build();
      if (!form.fields.some(field => field.name) && form.hidden.length === 0)
        return { error: "The form has no named controls." };
      return { form };
    } catch {
      return { error: "The form could not be read." };
    }
  }

  function isArrayChoice(field) {
    return field.multi && field.options.length > 1;
  }

  function choiceValue(field, checked, other) {
    const typed = field.other ? other?.trim() : undefined;
    const values = field.options.flatMap((option, index) => checked.has(index) && !option.disabled ? [option.value] : []);
    if (isArrayChoice(field)) return typed ? [...values, typed] : values;
    return typed || values[0];
  }

  function textValue(field, text) {
    if ((field.type === "number" || field.type === "range") && text.trim() !== "") {
      const number = Number(text);
      if (Number.isFinite(number)) return number;
    }
    return text;
  }

  function emptyDraft(form) {
    return form.fields.map(field => field.kind === "text"
      ? field.value
      : {
        picks: field.options.flatMap((option, index) => option.checked && !option.disabled ? [index] : []),
        other: "",
      });
  }

  function pick(draft, form, index, optionIndex) {
    const field = form.fields[index];
    if (field.kind !== "choice" || field.options[optionIndex]?.disabled) return draft;
    const entry = draft[index];
    const picks = field.multi
      ? entry.picks.includes(optionIndex)
        ? entry.picks.filter(pickIndex => pickIndex !== optionIndex)
        : [...entry.picks, optionIndex].sort((a, b) => a - b)
      : [optionIndex];
    return draft.map((value, i) => i === index ? { ...entry, picks, other: field.multi ? entry.other : "" } : value);
  }

  function setOther(draft, form, index, text) {
    const field = form.fields[index];
    if (field.kind !== "choice" || !field.other) return draft;
    return draft.map((value, i) => i === index
      ? { ...value, other: text, picks: field.multi ? value.picks : text.trim() ? [] : value.picks }
      : value);
  }

  function setText(draft, form, index, text) {
    if (form.fields[index]?.kind !== "text") return draft;
    return draft.map((value, i) => i === index ? text : value);
  }

  function buildData(form, draft, { hidden = true } = {}) {
    const data = Object.create(null);
    if (hidden) for (const [name, value] of form.hidden) data[name] = value;
    for (const [index, field] of form.fields.entries()) {
      if (!field.name) continue;
      const entry = draft[index];
      const value = field.kind === "text"
        ? textValue(field, typeof entry === "string" ? entry : field.value)
        : choiceValue(field, new Set(entry?.picks ?? []), entry?.other);
      if (value !== undefined) data[field.name] = value;
    }
    return data;
  }

  function defaultData(form) {
    return buildData(form, emptyDraft(form));
  }

  // Phone answers omit hidden inputs to stay inside the action size limit;
  // the desktop adds the authoritative parsed defaults before handing off.
  function withHiddenDefaults(form, data) {
    const merged = Object.assign(Object.create(null), data);
    const visible = new Set(form.fields.map(field => field.name));
    for (const [name, value] of form.hidden) if (!visible.has(name)) merged[name] = value;
    return merged;
  }

  function setInputValue(input, field, value) {
    // Range inputs clamp when value is assigned; constraints must already be
    // present so the displayed and submitted numbers are identical.
    if (field.min !== undefined) input.min = field.min;
    if (field.max !== undefined) input.max = field.max;
    if (field.step !== undefined) input.step = field.step;
    input.value = value;
    return input.value;
  }

  function fieldError(field, value) {
    if (field.kind === "choice") {
      const empty = value === undefined || (Array.isArray(value) && value.length === 0);
      if (!field.required || !empty) return undefined;
      return isArrayChoice(field) ? "Select at least one" : "Required";
    }
    const text = value === undefined ? "" : String(value);
    if (text.trim() === "") return field.required ? "Required" : undefined;
    if (field.type === "number" || field.type === "range") {
      const number = Number(text);
      if (!Number.isFinite(number)) return "Enter a number";
      if (field.min !== undefined && number < field.min) return `Must be at least ${field.min}`;
      if (field.max !== undefined && number > field.max) return `Must be at most ${field.max}`;
    }
    if (field.minLength !== undefined && text.length < field.minLength) return `Needs at least ${field.minLength} characters`;
    if (field.maxLength !== undefined && text.length > field.maxLength) return `At most ${field.maxLength} characters`;
    if (field.type === "email" && !/^[^\s@]+@[^\s@]+$/.test(text)) return "Enter an email address";
    if (field.type === "url") {
      try {
        new URL(text);
      } catch {
        return "Enter a full URL";
      }
    }
    return undefined;
  }

  function draftErrors(form, draft) {
    const data = buildData(form, draft);
    const errors = {};
    form.fields.forEach((field, index) => {
      if (!field.name) return;
      const error = fieldError(field, data[field.name]);
      if (error) errors[index] = error;
    });
    return errors;
  }

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function parseChoice(field, value) {
    if (value === undefined) return choiceValue(field, new Set());
    const array = isArrayChoice(field);
    const shape = array ? "an array of strings" : "one string, not an array";
    if (array !== Array.isArray(value)) throw new Error(shape);
    const entries = array ? value : [value];
    const checked = new Set();
    let other;
    for (const entry of entries) {
      if (typeof entry !== "string") throw new Error(shape);
      const enabled = field.options.findIndex(option => !option.disabled && option.value === entry);
      const index = enabled >= 0 ? enabled : field.options.findIndex(option => option.value === entry);
      if (index >= 0 && field.options[index].disabled) throw new Error("disabled option");
      if (index >= 0 && !checked.has(index)) checked.add(index);
      else if (index < 0 && field.other && other === undefined) other = entry;
      else throw new Error("unexpected value");
    }
    return choiceValue(field, checked, other);
  }

  function parseText(field, value) {
    if (value === undefined) return textValue(field, "");
    const numeric = field.type === "number" || field.type === "range";
    if (typeof value === "string" || (numeric && typeof value === "number" && Number.isFinite(value)))
      return textValue(field, String(value));
    throw new Error("text shape");
  }

  function parseChoiceOrHidden(field, value, hiddenValue) {
    if (hiddenValue === undefined) return parseChoice(field, value);
    const echo = Array.isArray(value) ? value.indexOf(hiddenValue) : value === hiddenValue ? 0 : -1;
    if (echo < 0) return parseChoice(field, value);
    const withoutEcho = Array.isArray(value) ? value.toSpliced(echo, 1) : undefined;
    if (Array.isArray(value) && !field.options.some(option => option.value === hiddenValue))
      return parseChoice(field, withoutEcho);
    try {
      return parseChoice(field, value);
    } catch {
      return parseChoice(field, withoutEcho);
    }
  }

  /** Why omp would reject `data`, or null. This is parseFormDialogResponse
   *  without the side effects: unknown names, shapes, disabled options and
   *  duplicate entries are refused; `required` and patterns are UI hints
   *  only, exactly as omp treats them here. */
  function dataError(form, data) {
    if (!isRecord(data)) return "data must be an object";
    const named = form.fields.filter(field => field.name);
    const names = new Set([...named.map(field => field.name), ...form.hidden.map(([name]) => name)]);
    for (const name of Object.keys(data)) if (!names.has(name)) return `unknown field ${name}`;
    const hidden = new Map(form.hidden);
    const groups = new Map();
    for (const field of named) {
      if (!groups.has(field.name)) groups.set(field.name, []);
      groups.get(field.name).push(field);
    }
    for (const [name, group] of groups) {
      const entry = Object.hasOwn(data, name) ? data[name] : undefined;
      const hiddenValue = hidden.get(name);
      let mismatch;
      const values = group.map(field => {
        try {
          const value = field.kind === "choice"
            ? parseChoiceOrHidden(field, entry, hiddenValue)
            : parseText(field, entry);
          return { value, carried: true };
        } catch (error) {
          if (group.length === 1) throw error;
          mismatch ??= error;
          return {
            value: field.kind === "choice" ? parseChoice(field, undefined) : parseText(field, undefined),
            carried: false,
          };
        }
      });
      if (!values.some(value => value.carried)) throw mismatch ?? new Error("field shape");
    }
    return null;
  }

  function validateData(form, data) {
    try {
      return dataError(form, data) === null;
    } catch {
      return false;
    }
  }

  function summary(form, data) {
    const hiddenNames = new Set(form.hidden.map(([name]) => name));
    const parts = [];
    for (const field of form.fields) {
      if (!field.name || hiddenNames.has(field.name) || !Object.hasOwn(data ?? {}, field.name)) continue;
      const value = data[field.name];
      const values = Array.isArray(value) ? value : [value];
      const shown = values.flatMap(entry => {
        if (entry === undefined || entry === null || String(entry).trim() === "") return [];
        if (field.kind !== "choice") return [String(entry)];
        return [field.options.find(option => option.value === String(entry))?.label ?? String(entry)];
      });
      if (shown.length) parts.push(shown.join(", "));
    }
    return parts.length > 1
      ? { answer: null, count: parts.length }
      : { answer: parts[0] ?? null, count: null };
  }

  function summaryPrompt(form) {
    for (const section of form.sections) {
      if (section.title) return section.title;
      const text = section.blocks.find(block => block.kind === "text" || block.kind === "pre");
      if (text) return (text.text ?? "").trim().split(/\r?\n/, 1)[0];
      const field = section.blocks.find(block => block.kind === "field")?.field;
      if (field) return field.label || field.name;
    }
    return "";
  }

  function timeoutLabel(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const seconds = Math.max(1, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  }

  window.OMP_HTML_FORM = {
    parse, emptyDraft, pick, setOther, setText, buildData, defaultData, withHiddenDefaults, setInputValue,
    fieldError, draftErrors, dataError, validateData, summary, summaryPrompt, timeoutLabel, isArrayChoice, choiceValue, textValue,
  };
})();
