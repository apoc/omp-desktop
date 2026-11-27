/* ═════════════════════════════════════════════════════════════════════
   app/html-form-markup.js — omp's own markup parser for the ask-tool HTML
   form (`window.OMP_HTML_FORM_MARKUP`), read by app/html-form-parse.js.

   Ported from oh-my-pi v19.2.1 `packages/utils/src/dom/parser.ts` (MIT,
   Mario Zechner): its tokenizer, ~110 named entities (semicolon required),
   optional-end-tag rules and no HTML5 tree construction, plus the parts of
   its DOM (`core.ts`, `selector.ts`) the form builder reads. omp parses
   the form HTML again to check the answer, so the desktop must build the
   very tree omp builds: a browser DOMParser decodes other entities and
   moves table content around. The tree is plain objects; nothing touches a
   DOM and the HTML never reaches the document.

   The desktop bounds what omp does not: nodes, nesting depth and scanning
   work, each refused with `FormLimit` (a `{text}` reason the user reads).
   ═════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const MAX_NODES = 10000;
  const MAX_DEPTH = 64;
  const MARKUP_LIMIT = "This form has too much markup to show.";
  // Characters scanned for start tags, all told: a few times the 256 KiB
  // the desktop accepts covers any real form.
  const MAX_SCAN = 4 * 1024 * 1024;

  /** A refusal the user should read; any other exception maps to the
   *  generic "could not be read". */
  class FormLimit extends Error {
    constructor(text) {
      super(text);
      this.text = text;
    }
  }

  // ── omp's markup parser (pi-utils dom/parser.ts, v19.2.1) ────────────────
  // Plain object tables on purpose, as in omp: a prototype key such as
  // `<constructor>` behaves exactly as it does there.
  const RAW_TEXT_CLOSE = { script: /<\/script\s*>/gi, style: /<\/style\s*>/gi };
  const RCDATA_CLOSE = { textarea: /<\/textarea\s*>/gi, title: /<\/title\s*>/gi };
  const DOCTYPE_PATTERN = /<!doctype\b/iy;
  const TAG_NAME_PATTERN = /[^\s/>]+/y;
  const ATTRIBUTE_NAME_PATTERN = /[^\s=/>]+/y;
  const UNQUOTED_VALUE_PATTERN = /[^\s>]+/y;
  const XML_LIKE_PATTERN = /^\s*(?:<\?xml[\s\S]*?\?>\s*)?<(?:feed|rss)\b/i;
  const SVG = "svg";
  const HTML = "html";
  const VOID_ELEMENTS = {
    area: true, base: true, br: true, col: true, embed: true, hr: true, img: true, input: true,
    link: true, meta: true, param: true, source: true, track: true, wbr: true,
  };
  const CLOSE_ON_OPEN = {
    li: ["li"], dt: ["dt", "dd"], dd: ["dt", "dd"], tr: ["tr"], th: ["th", "td"], td: ["th", "td"],
    option: ["option"], thead: ["thead", "tbody", "tfoot"], tbody: ["thead", "tbody", "tfoot"],
    tfoot: ["thead", "tbody", "tfoot"],
  };
  const P_CLOSERS = {
    address: true, article: true, aside: true, blockquote: true, div: true, dl: true, fieldset: true,
    footer: true, form: true, h1: true, h2: true, h3: true, h4: true, h5: true, h6: true, header: true,
    hr: true, menu: true, nav: true, ol: true, p: true, pre: true, section: true, table: true, ul: true,
  };
  const NAMED_ENTITIES = {
    AElig: "Æ", Aacute: "Á", Acirc: "Â", Agrave: "À", Aring: "Å", Atilde: "Ã", Auml: "Ä",
    Ccedil: "Ç", ETH: "Ð", Eacute: "É", Ecirc: "Ê", Egrave: "È", Euml: "Ë", Iacute: "Í", Icirc: "Î",
    Igrave: "Ì", Iuml: "Ï", Ntilde: "Ñ", Oacute: "Ó", Ocirc: "Ô", Ograve: "Ò", Oslash: "Ø",
    Otilde: "Õ", Ouml: "Ö", THORN: "Þ", Uacute: "Ú", Ucirc: "Û", Ugrave: "Ù", Uuml: "Ü",
    Yacute: "Ý", aacute: "á", acirc: "â", aelig: "æ", agrave: "à", aring: "å", atilde: "ã",
    auml: "ä", amp: "&", apos: "'", bull: "\u2022", brvbar: "¦", ccedil: "ç", cedil: "¸", cent: "¢",
    copy: "©", deg: "°", curren: "¤", divide: "÷", emsp: "\u2003", ensp: "\u2002", euro: "\u20ac",
    eacute: "é", ecirc: "ê", egrave: "è", eth: "ð", euml: "ë", frac12: "½", frac14: "¼",
    frac34: "¾", gt: ">", iacute: "í", icirc: "î", iexcl: "¡", igrave: "ì", iquest: "¿", iuml: "ï",
    hellip: "\u2026", laquo: "«", ldquo: "\u201c", lsquo: "\u2018", lt: "<", mdash: "\u2014",
    macr: "¯", micro: "µ", middot: "·", nbsp: "\u00a0", ndash: "\u2013", ntilde: "ñ", oacute: "ó",
    ocirc: "ô", ograve: "ò", ordf: "ª", ordm: "º", oslash: "ø", otilde: "õ", ouml: "ö", para: "¶",
    pound: "£", plusmn: "±", quot: "\u0022", raquo: "»", rdquo: "\u201d", reg: "®", rsquo: "\u2019",
    sect: "§", shy: "\u00ad", szlig: "ß", thorn: "þ", sup1: "¹", sup2: "²", sup3: "³",
    thinsp: "\u2009", times: "×", trade: "\u2122", uacute: "ú", ucirc: "û", ugrave: "ù", uml: "¨",
    uuml: "ü", yacute: "ý", yuml: "ÿ", yen: "¥",
  };
  const ENTITY_PATTERN = /&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi;

  /** omp's `decodeEntities`: its named entities (semicolon required) and
   *  every valid numeric reference; anything else stays literal. */
  function decodeEntities(value) {
    if (!value.includes("&")) return value;
    return value.replace(ENTITY_PATTERN, (whole, entity) => {
      if (entity[0] !== "#") return NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
      const hexadecimal = entity[1]?.toLowerCase() === "x";
      const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff
        || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return "\uFFFD";
      return String.fromCodePoint(codePoint);
    });
  }

  function findTagEnd(html, start) {
    let quote = "";
    for (let index = start; index < html.length; index++) {
      const character = html[index];
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        return index;
      }
    }
    return html.length - 1;
  }

  function parseStartTag(source) {
    let index = 0;
    while (/\s/.test(source[index] ?? "")) index++;
    TAG_NAME_PATTERN.lastIndex = index;
    const nameMatch = TAG_NAME_PATTERN.exec(source);
    if (!nameMatch) return null;
    const name = nameMatch[0].toLowerCase();
    index += nameMatch[0].length;
    const attributes = new Map();
    let selfClosing = false;
    while (index < source.length) {
      while (/\s/.test(source[index] ?? "")) index++;
      if (source[index] === "/") {
        selfClosing = true;
        break;
      }
      ATTRIBUTE_NAME_PATTERN.lastIndex = index;
      const attributeMatch = ATTRIBUTE_NAME_PATTERN.exec(source);
      if (!attributeMatch) break;
      const attributeName = attributeMatch[0].toLowerCase();
      index += attributeMatch[0].length;
      while (/\s/.test(source[index] ?? "")) index++;
      let value = "";
      if (source[index] === "=") {
        index++;
        while (/\s/.test(source[index] ?? "")) index++;
        const quote = source[index];
        if (quote === '"' || quote === "'") {
          index++;
          const end = source.indexOf(quote, index);
          if (end < 0) {
            value = source.slice(index);
            index = source.length;
          } else {
            value = source.slice(index, end);
            index = end + 1;
          }
        } else {
          UNQUOTED_VALUE_PATTERN.lastIndex = index;
          value = UNQUOTED_VALUE_PATTERN.exec(source)?.[0] ?? "";
          index += value.length;
        }
      }
      // Attribute lookup is case-insensitive in omp's DOM: the first wins.
      if (!attributes.has(attributeName)) attributes.set(attributeName, decodeEntities(value));
    }
    return { name, attributes, selfClosing };
  }

  function closeOptionalElements(stack, incoming) {
    const current = stack[stack.length - 1];
    if (!current) return;
    if (current.localName === "p" && P_CLOSERS[incoming]) {
      stack.pop();
      return;
    }
    const closeable = CLOSE_ON_OPEN[incoming];
    if (closeable?.includes(current.localName)) stack.pop();
  }

  function readUntilClose(html, index, closePattern) {
    closePattern.lastIndex = index;
    const match = closePattern.exec(html);
    if (!match) return [html.slice(index), html.length];
    return [html.slice(index, match.index), closePattern.lastIndex];
  }

  /** omp's `parseHTML(html).document` as plain objects: elements
   *  `{nodeType: 1, localName, namespace, attributes: Map, childNodes}`,
   *  text (3) and comments (8) with `data`. A `<template>`'s children live in
   *  its `content`, out of `childNodes`, as in omp's DOM. */
  function parseMarkup(html) {
    const root = { nodeType: 9, childNodes: [], parentNode: null };
    const stack = [];
    const xmlLike = XML_LIKE_PATTERN.test(html);
    let parent = root;
    let index = 0;
    let nodes = 0;
    // omp rescans to the next `>` after a `<` that opens no tag, which is
    // quadratic on `< /< /< /…`; the webview stops at a fixed amount of
    // scanning instead of hanging.
    let scanned = 0;
    const append = (to, node) => {
      if (++nodes > MAX_NODES) throw new FormLimit(MARKUP_LIMIT);
      const target = to.content ?? to;
      node.parentNode = target;
      target.childNodes.push(node);
      return node;
    };
    const text = (data, kind = 3) => ({ nodeType: kind, data, parentNode: null });
    while (index < html.length) {
      if (html.startsWith("<!--", index)) {
        const end = html.indexOf("-->", index + 4);
        append(parent, text(html.slice(index + 4, end < 0 ? html.length : end), 8));
        index = end < 0 ? html.length : end + 3;
        continue;
      }
      if (html[index] !== "<") {
        const next = html.indexOf("<", index);
        const end = next < 0 ? html.length : next;
        append(parent, text(decodeEntities(html.slice(index, end))));
        index = end;
        continue;
      }
      if (html[index + 1] === "!") {
        DOCTYPE_PATTERN.lastIndex = index;
        if (DOCTYPE_PATTERN.test(html)) {
          const end = html.indexOf(">", index + 2);
          index = end < 0 ? html.length : end + 1;
          continue;
        }
      }
      if (html.startsWith("<![CDATA[", index)) {
        const end = html.indexOf("]]>", index + 9);
        append(parent, text(html.slice(index + 9, end < 0 ? html.length : end)));
        index = end < 0 ? html.length : end + 3;
        continue;
      }
      if (html[index + 1] === "/") {
        const end = findTagEnd(html, index + 2);
        const closingName = html.slice(index + 2, end).trim().split(/\s/, 1)[0].toLowerCase();
        const matchIndex = stack.findLastIndex(element => element.localName === closingName);
        if (matchIndex >= 0) stack.length = matchIndex;
        parent = stack[stack.length - 1] ?? root;
        index = end + 1;
        continue;
      }
      if (html[index + 1] === "!" || html[index + 1] === "?") {
        const end = html.indexOf(">", index + 2);
        index = end < 0 ? html.length : end + 1;
        continue;
      }
      const end = findTagEnd(html, index + 1);
      scanned += end - index;
      if (scanned > MAX_SCAN) throw new FormLimit(MARKUP_LIMIT);
      const parsed = parseStartTag(html.slice(index + 1, end));
      if (!parsed) {
        append(parent, text("<"));
        index++;
        continue;
      }
      closeOptionalElements(stack, parsed.name);
      parent = stack[stack.length - 1] ?? root;
      const namespace = (parent !== root && parent.namespace === SVG) || parsed.name === "svg" ? SVG : HTML;
      const element = append(parent, {
        nodeType: 1,
        localName: parsed.name,
        namespace,
        attributes: parsed.attributes,
        childNodes: [],
        parentNode: null,
        content: namespace === HTML && parsed.name === "template" ? { nodeType: 11, childNodes: [], parentNode: null } : undefined,
      });
      index = end + 1;
      if (RAW_TEXT_CLOSE[parsed.name] && !parsed.selfClosing) {
        const closePattern = Object.hasOwn(RAW_TEXT_CLOSE, parsed.name)
          ? RAW_TEXT_CLOSE[parsed.name]
          : new RegExp(`</${parsed.name}\\s*>`, "ig");
        const [raw, next] = readUntilClose(html, index, closePattern);
        append(element, text(raw));
        index = next;
        continue;
      }
      if (!xmlLike && namespace === HTML && Object.hasOwn(RCDATA_CLOSE, parsed.name) && !parsed.selfClosing) {
        const [raw, next] = readUntilClose(html, index, RCDATA_CLOSE[parsed.name]);
        if (raw) append(element, text(decodeEntities(raw)));
        index = next;
        continue;
      }
      const isVoid = xmlLike ? parsed.selfClosing : VOID_ELEMENTS[parsed.name] || (namespace === SVG && parsed.selfClosing);
      if (!isVoid) {
        if (stack.length >= MAX_DEPTH) throw new FormLimit(MARKUP_LIMIT);
        stack.push(element);
        parent = element;
      }
    }
    return root;
  }

  // ── The tree, read the way omp's DOM answers parse.ts ───────────────────
  function attr(node, name) {
    return node?.nodeType === 1 ? node.attributes.get(name) ?? null : null;
  }

  function hasAttr(node, name) {
    return attr(node, name) !== null;
  }

  function childElements(node) {
    return node.childNodes.filter(child => child.nodeType === 1);
  }

  /** Descendant elements in document order (`querySelectorAll`). */
  function select(node, predicate, out = []) {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      if (predicate(child)) out.push(child);
      select(child, predicate, out);
    }
    return out;
  }

  function selectFirst(node, predicate) {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      if (predicate(child)) return child;
      const found = selectFirst(child, predicate);
      if (found) return found;
    }
    return null;
  }

  /** Nearest inclusive element ancestor named `tag` (`closest`). */
  function closest(element, tag) {
    for (let node = element; node?.nodeType === 1; node = node.parentNode) if (node.localName === tag) return node;
    return null;
  }

  function contains(ancestor, node) {
    for (let current = node; current; current = current.parentNode) if (current === ancestor) return true;
    return false;
  }

  /** `textContent`: text and comment data of every descendant. */
  function textContent(node) {
    if (node.nodeType === 3 || node.nodeType === 8) return node.data;
    return (node.content ?? node).childNodes.map(textContent).join("");
  }

  window.OMP_HTML_FORM_MARKUP = {
    FormLimit, parseMarkup, decodeEntities, attr, hasAttr, childElements, select, selectFirst, closest, contains, textContent,
  };
})();
