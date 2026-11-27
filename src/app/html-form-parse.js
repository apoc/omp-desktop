/* ═════════════════════════════════════════════════════════════════════
   app/html-form-parse.js — omp's ask-tool HTML form, built into the
   render model app/html-form.js answers (`window.OMP_HTML_FORM_PARSE`).

   A port of omp v19.2.1's form builder (tools/html-form/parse.ts) over
   the tree app/html-form-markup.js builds with omp's own markup parser, so
   the desktop sees exactly omp's fields, labels and option values.

   The desktop adds limits omp does not have (size, nodes, depth, fields,
   options, cells, display text); past one the form is refused with a
   specific `{text}` reason and the request cancelled.
   ═════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const {
    FormLimit, parseMarkup, attr, hasAttr, childElements, select, selectFirst, closest, contains, textContent,
  } = window.OMP_HTML_FORM_MARKUP;
  const MAX_HTML_BYTES = 256 * 1024;
  const MAX_FIELDS = 500;
  const MAX_BLOCKS = 2000;
  const MAX_OPTIONS = 1000;
  const MAX_TABLE_CELLS = 2000;
  const MAX_DISPLAY_BYTES = 64 * 1024;
  const PASSWORD_REFUSAL = "This form asks for a password; enter it in a terminal instead — omp would echo it in its output.";
  let UTF8;

  const isControl = element => element.localName === "input" || element.localName === "select" || element.localName === "textarea";
  const named = tag => element => element.localName === tag;

  // ── omp's form builder (tools/html-form/parse.ts, v19.2.1) ──────────────
  const SKIPPED = {
    button: true, head: true, iframe: true, link: true, meta: true, noscript: true, script: true,
    style: true, template: true, title: true,
  };
  const BLOCK = {
    address: true, article: true, aside: true, blockquote: true, dd: true, details: true, div: true,
    dl: true, dt: true, figure: true, figcaption: true, footer: true, header: true, li: true,
    main: true, nav: true, p: true, section: true,
  };
  const HEADING = { h1: true, h2: true, h3: true, h4: true, h5: true, h6: true, summary: true };
  const STYLE_OF = { b: "strong", code: "code", em: "em", i: "em", kbd: "code", samp: "code", strong: "strong", tt: "code" };
  const IGNORED_INPUTS = { button: true, file: true, image: true, reset: true, submit: true };

  // Spans keep omp's styled runs only so whitespace collapses exactly as
  // there (an option label decides whether a group gets its Other answer);
  // the model stores their plain text.
  function appendSpan(spans, text, style) {
    if (!text) return;
    const last = spans[spans.length - 1];
    if (last && last.style === style) last.text += text;
    else spans.push({ text, style });
  }

  function normalizeSpans(spans) {
    const out = [];
    for (const span of spans) appendSpan(out, span.text.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n"), span.style);
    const first = out[0];
    if (first) first.text = first.text.trimStart();
    const last = out[out.length - 1];
    if (last) last.text = last.text.trimEnd();
    return out.filter(span => span.text !== "");
  }

  function spansText(spans) {
    return spans.map(span => span.text).join("");
  }

  function numberAttr(element, name) {
    const raw = attr(element, name);
    if (raw === null || raw.trim() === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  }

  function svgTitle(svg) {
    const label = attr(svg, "aria-label");
    if (label) return label.trim();
    const title = childElements(svg).find(named("title"));
    return (title ? textContent(title) : "").replace(/\s+/g, " ").trim();
  }

  class Builder {
    constructor(root) {
      this.root = root;
      this.section = { title: "", blocks: [], fieldset: false };
      this.sections = [this.section];
      this.fields = [];
      this.hidden = [];
      this.groups = new Map();
      this.labelFor = new Map();
      this.inline = [];
      this.fieldsetDepth = 0;
      this.blockCount = 0;
      this.optionCount = 0;
      this.tableCellCount = 0;
      this.displayBytes = 0;
    }

    budget(text) {
      this.displayBytes += (UTF8 ??= new TextEncoder()).encode(String(text ?? "")).length;
      if (this.displayBytes > MAX_DISPLAY_BYTES) throw new FormLimit("This form has too much display text to show.");
    }

    countOptions(count) {
      this.optionCount += count;
      if (this.optionCount > MAX_OPTIONS) throw new FormLimit("This form has too many options to show.");
    }

    budgetField(field) {
      this.budget(field.label);
      if (field.kind === "choice" && !field.label) this.budget(field.name.replace(/[_-]+/g, " "));
      if (field.kind === "choice") for (const option of field.options) this.budget(option.label);
      else {
        this.budget(field.value);
        this.budget(field.placeholder);
        this.budget(field.pattern);
      }
    }

    push(block) {
      if (++this.blockCount > MAX_BLOCKS) throw new FormLimit("This form has too much content to show.");
      if (block.kind === "text" || block.kind === "pre") this.budget(block.text);
      else if (block.kind === "image") this.budget(block.alt);
      else if (block.kind === "list") for (const item of block.items) this.budget(item);
      else if (block.kind === "table") for (const row of block.rows) for (const cell of row) this.budget(cell);
      else if (block.kind === "field") this.budgetField(block.field);
      this.section.blocks.push(block);
      return block;
    }

    build() {
      const ids = new Set();
      for (const control of select(this.root, isControl)) {
        const id = attr(control, "id");
        if (id) ids.add(id);
      }
      for (const label of select(this.root, named("label"))) {
        const target = attr(label, "for");
        if (target && ids.has(target) && !this.labelFor.has(target)) this.labelFor.set(target, label);
      }
      this.children(this.root, undefined);
      this.flush(false);
      for (const field of this.fields) {
        if (field.kind !== "choice" || field.select || field.options.length < 2) continue;
        field.other = !field.options.some(option => /^\s*other\b/i.test(option.label));
      }
      return {
        sections: this.sections.filter(section => section.blocks.length > 0 || section.title !== ""),
        fields: this.fields,
        hidden: this.hidden,
      };
    }

    children(node, style) {
      for (const child of node.childNodes) this.walk(child, style);
    }

    walk(node, style) {
      if (node.nodeType === 8) return;
      if (node.nodeType === 3) {
        appendSpan(this.inline, node.data, style);
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.localName;
      if (SKIPPED[tag]) return;
      switch (tag) {
        case "br":
          appendSpan(this.inline, "\n", undefined);
          return;
        case "hr":
          this.flush(false);
          return;
        case "input":
        case "select":
        case "textarea":
          this.control(node, undefined);
          return;
        case "label":
          this.label(node, style);
          return;
        case "fieldset":
          this.fieldset(node);
          return;
        case "legend":
          this.flush(false);
          this.children(node, style);
          this.flush(true);
          return;
        case "ul":
        case "ol":
          this.list(node, tag === "ol");
          return;
        case "pre":
          this.flush(false);
          this.push({ kind: "pre", text: textContent(node).replace(/^\n/, "").trimEnd() });
          return;
        case "table":
          this.table(node);
          return;
        case "img": {
          // Pictures show their alt text only; the source is never loaded.
          if (!attr(node, "src")?.trim()) return;
          this.flush(false);
          const alt = spansText(normalizeSpans([{ text: attr(node, "alt") ?? "" }]));
          if (alt) this.push({ kind: "image", alt });
          return;
        }
        case "svg": {
          this.flush(false);
          const alt = svgTitle(node);
          if (alt) this.push({ kind: "image", alt });
          return;
        }
      }
      if (HEADING[tag]) {
        this.flush(false);
        this.children(node, style);
        this.flush(true);
        return;
      }
      if (BLOCK[tag]) {
        this.flush(false);
        this.children(node, style);
        this.flush(false);
        return;
      }
      this.children(node, STYLE_OF[tag] ?? style);
    }

    flush(heading) {
      const spans = normalizeSpans(this.inline);
      this.inline = [];
      if (spans.length > 0) this.push({ kind: "text", text: spansText(spans), heading });
    }

    /** omp's `#spansOf`: inline text of `element`, controls left out. */
    spansOf(element) {
      const spans = [];
      const visit = (node, style) => {
        if (node.nodeType === 8) return;
        if (node.nodeType === 3) {
          appendSpan(spans, node.data, style);
          return;
        }
        if (node.nodeType !== 1) return;
        const tag = node.localName;
        if (SKIPPED[tag] || tag === "input" || tag === "select" || tag === "textarea" || tag === "svg") return;
        if (tag === "br") {
          appendSpan(spans, "\n", undefined);
          return;
        }
        if (tag === "img") {
          appendSpan(spans, attr(node, "alt") ?? "", style);
          return;
        }
        if (BLOCK[tag] || HEADING[tag]) appendSpan(spans, " ", undefined);
        for (const child of node.childNodes) visit(child, STYLE_OF[tag] ?? style);
      };
      for (const child of element.childNodes) visit(child, undefined);
      return normalizeSpans(spans);
    }

    label(label, style) {
      const target = attr(label, "for");
      if (target && this.labelFor.get(target) === label) return;
      const controls = select(label, isControl);
      if (controls.length === 0) {
        this.children(label, style);
        return;
      }
      this.flush(false);
      const spans = this.spansOf(label);
      for (const control of controls) this.control(control, spans);
    }

    fieldset(fieldset) {
      this.flush(false);
      const legend = childElements(fieldset).find(named("legend"));
      if (this.fieldsetDepth > 0) {
        if (legend) this.walk(legend, undefined);
      } else {
        this.startSection(legend ? spansText(this.spansOf(legend)) : "", true);
      }
      this.fieldsetDepth++;
      for (const child of fieldset.childNodes) if (child !== legend) this.walk(child, undefined);
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

    list(list, ordered) {
      this.flush(false);
      if (selectFirst(list, isControl)) {
        this.children(list, undefined);
        this.flush(false);
        return;
      }
      const items = childElements(list)
        .filter(named("li"))
        .map(item => spansText(this.spansOf(item)))
        .filter(Boolean);
      if (items.length > 0) this.push({ kind: "list", items, ordered });
    }

    table(table) {
      this.flush(false);
      const rows = select(table, named("tr")).filter(row => closest(row, "table") === table);
      const cellsOf = row => childElements(row).filter(cell => cell.localName === "td" || cell.localName === "th");
      this.tableCellCount += rows.reduce((count, row) => count + cellsOf(row).length, 0);
      if (this.tableCellCount > MAX_TABLE_CELLS) throw new FormLimit("This form has too many table cells to show.");
      if (!selectFirst(table, isControl)) {
        const cells = rows.map(row => cellsOf(row).map(cell => spansText(this.spansOf(cell))));
        let headerRows = 0;
        while (headerRows < rows.length
          && (closest(rows[headerRows], "thead") !== null || cellsOf(rows[headerRows]).every(cell => cell.localName === "th"))) headerRows++;
        if (cells.some(row => row.length > 0)) this.push({ kind: "table", rows: cells, headerRows });
        return;
      }
      // A decision matrix: each row's text becomes a line and each unlabelled
      // control borrows its column header.
      let header = [];
      for (const row of rows) {
        const cells = cellsOf(row);
        if (cells.every(cell => cell.localName === "th") && !selectFirst(row, isControl)) {
          header = cells.map(cell => this.spansOf(cell));
          continue;
        }
        const text = [];
        for (const cell of cells) {
          if (selectFirst(cell, isControl)) continue;
          const spans = this.spansOf(cell);
          if (spans.length === 0) continue;
          if (text.length > 0) appendSpan(text, " · ", undefined);
          for (const span of spans) appendSpan(text, span.text, span.style);
        }
        if (text.length > 0) this.push({ kind: "text", text: spansText(text), heading: false });
        cells.forEach((cell, column) => {
          for (const control of select(cell, isControl)) {
            const own = closest(control, "label");
            const spans = own && contains(cell, own) ? this.spansOf(own) : this.spansOf(cell);
            this.control(control, spans.length > 0 ? spans : (header[column] ?? []));
          }
        });
      }
    }

    detachedLabel(control) {
      const id = attr(control, "id");
      const label = id ? this.labelFor.get(id) : undefined;
      if (label) return this.spansOf(label);
      const text = attr(control, "aria-label") ?? attr(control, "title");
      return text ? normalizeSpans([{ text }]) : [];
    }

    control(control, wrapping) {
      this.flush(false);
      const label = spansText(wrapping && wrapping.length > 0 ? wrapping : this.detachedLabel(control));
      const name = attr(control, "name") ?? "";
      const nameLabel = name.replace(/[_-]+/g, " ");
      const required = hasAttr(control, "required");
      const tag = control.localName;
      if (tag === "select") {
        const multi = hasAttr(control, "multiple");
        const options = select(control, named("option")).map(option => {
          const text = textContent(option).replace(/\s+/g, " ").trim();
          return { value: attr(option, "value") ?? text, label: text, checked: hasAttr(option, "selected"), disabled: hasAttr(option, "disabled") };
        });
        this.countOptions(options.length);
        if (!multi && !options.some(option => option.checked)) {
          const first = options.find(option => !option.disabled);
          if (first) first.checked = true;
        }
        this.addField({ kind: "choice", name, multi, select: true, other: false, label, options, required });
        return;
      }
      if (tag === "textarea") {
        this.addField({
          kind: "text", name, type: "textarea", multiline: true,
          label: label || nameLabel,
          value: textContent(control).replace(/^\r?\n/, ""),
          placeholder: attr(control, "placeholder") ?? "",
          required,
          minLength: numberAttr(control, "minlength"),
          maxLength: numberAttr(control, "maxlength"),
          rows: numberAttr(control, "rows") ?? 4,
        });
        return;
      }
      const type = (attr(control, "type") ?? "text").toLowerCase();
      if (IGNORED_INPUTS[type]) return;
      const value = attr(control, "value");
      if (type === "hidden") {
        if (name) this.hidden.push([name, value ?? ""]);
        return;
      }
      if (type === "radio" || type === "checkbox") {
        const option = {
          value: value ?? "on",
          label: label || (value ?? name),
          checked: hasAttr(control, "checked"),
          disabled: hasAttr(control, "disabled"),
        };
        this.countOptions(1);
        const key = `${type}\0${name}`;
        const group = this.groups.get(key);
        if (group) {
          // omp resolves a submitted value to the first enabled option: a
          // later enabled duplicate could never be submitted distinctly.
          if (group.options.some(existing => !existing.disabled && existing.value === option.value)) option.disabled = true;
          group.options.push(option);
          this.budget(option.label);
          group.required ||= required;
          return;
        }
        const field = { kind: "choice", name, multi: type === "checkbox", select: false, other: false, label: "", options: [option], required };
        this.groups.set(key, field);
        this.addField(field);
        return;
      }
      this.addField({
        kind: "text", name, type, multiline: false,
        label: label || nameLabel,
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
      if (this.fields.length >= MAX_FIELDS) throw new FormLimit("This form has too many fields to show.");
      this.fields.push(field);
      this.push({ kind: "field", field });
    }
  }

  // A type/autocomplete value counts as a password field when it contains
  // "password" anywhere: no token splitting, so NBSP or BOM padding cannot
  // slip past.
  const passwordControl = element => element.localName === "input"
    && ["type", "autocomplete"].some(name => (attr(element, name) ?? "").toLowerCase().includes("password"));

  /** Parse agent-written form HTML into `{form}` or `{error: {text, vars}}`.
   *  An error means the request is cancelled so omp never waits on a card
   *  that cannot be answered. Content outside the first `<form>` is ignored
   *  when one exists, as in omp. */
  function parse(html) {
    if (typeof html !== "string" || !html.trim()) return { error: { text: "The form is empty." } };
    if ((UTF8 ??= new TextEncoder()).encode(html).length > MAX_HTML_BYTES) return { error: { text: "The form HTML is too large to show." } };
    try {
      const document = parseMarkup(html);
      const root = selectFirst(document, named("form")) ?? document;
      // `reader.rs` replaces a form whose HTML mentions a credential with
      // this marker before journaling or emitting it, so neither the original
      // HTML nor a prefilled value ever reaches this parser.
      if (attr(root, "data-omp-desktop-redacted") === "password" || selectFirst(root, passwordControl))
        return { error: { text: PASSWORD_REFUSAL } };
      const form = new Builder(root).build();
      if (!form.fields.some(field => field.name) && form.hidden.length === 0)
        return { error: { text: "The form has no named controls." } };
      return { form };
    } catch (error) {
      if (error instanceof FormLimit) return { error: { text: error.text } };
      return { error: { text: "The form could not be read." } };
    }
  }

  window.OMP_HTML_FORM_PARSE = { parse, PASSWORD_REFUSAL };
})();
